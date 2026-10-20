import type { DatabaseSync } from "node:sqlite";
import { nowISO } from "@/lib/date";
import type { PaperAsset } from "@/content/paper/types";
import type {
  PaperExamType,
  PaperPool,
  PaperSession,
  PaperSourceKind,
  PaperVerificationStatus,
} from "@/domain/paper";
import type {
  ExamPaperRecord,
  PaperImportDecision,
  PaperImportInput,
  PaperRepository,
} from "../ports";
import { allRows, firstRow, fromBool, toBool, toInt, toNullableText, toText, type Row } from "./support";

/**
 * 真题试卷索引的存储实现。
 *
 * 关键约束（贯穿本文件）：
 * 1. **表格里没有正文。** 只存索引、来源、版本、校验和、题目计数。
 *    正文的规范来源是 private-content 下的规范化包。
 * 2. **唯一约束是身份的一部分。** `(exam_type, year, session, variant)` 唯一，
 *    因此"换个 id 再导一遍同一份卷子"在数据库层面就不可能。
 * 3. **版本只能前进。** 同版本不同内容、或更低版本，都在 `decideImport` 处被拒绝，
 *    不进入写路径 —— 历史作答因此不会被静默重定向到另一道题。
 */

function mapPaper(row: Row): ExamPaperRecord {
  return {
    id: toText(row.id),
    examType: toText(row.exam_type) as PaperExamType,
    year: toInt(row.exam_year),
    session: toText(row.session) as PaperSession,
    variant: toText(row.variant),
    examDate: toNullableText(row.exam_date),
    sourceKind: toText(row.source_kind) as PaperSourceKind,
    verificationStatus: toText(row.verification_status) as PaperVerificationStatus,
    provenance: {
      note: toText(row.provenance_note),
      reference: toNullableText(row.provenance_ref),
      verificationNote: toNullableText(row.verification_note),
    },
    contentVersion: toInt(row.content_version, 1),
    partial: toBool(row.partial),
    packagePath: toText(row.package_path),
    manifestChecksum: toText(row.manifest_checksum),
    contentFingerprint: toNullableText(row.content_fingerprint),
    sectionCount: toInt(row.section_count),
    questionCount: toInt(row.question_count),
    importedAt: toText(row.imported_at),
    updatedAt: toText(row.updated_at),
    pool: mapPool(row.pool),
  };
}

function mapPool(value: unknown): PaperPool {
  const text = toText(value);
  return text === "mock_reserve" ? "mock_reserve" : "training";
}

function mapAsset(row: Row): PaperAsset {
  return {
    id: toText(row.id),
    kind: toText(row.kind) === "image" ? "image" : "audio",
    relativePath: toText(row.relative_path),
    mimeType: toText(row.mime_type),
    bytes: toInt(row.bytes),
    checksum: toText(row.checksum),
    label: toNullableText(row.label),
  };
}

/**
 * 试卷默认查询语句。
 *
 * 用 LEFT JOIN 而不是要求调用方先建 paper_study_state 行：
 * "没有状态行"与"训练池"是同一语义，因此不需要额外的初始化写入，
 * 也不会出现"两张表不一致"的状态。
 */
const PAPER_SELECT = `
  SELECT p.*, COALESCE(s.pool, 'training') AS pool
  FROM exam_paper p
  LEFT JOIN paper_study_state s ON s.paper_id = p.id
`;

/** 场次的展示顺序：12 月 > 9 月 > 6 月（与考试时间的自然顺序一致）。 */
const SESSION_ORDER_SQL = `CASE p.session WHEN 'December' THEN 3 WHEN 'September' THEN 2 ELSE 1 END`;

export class SqlitePaperRepository implements PaperRepository {
  constructor(private readonly db: DatabaseSync) {}

  listPapers(): ExamPaperRecord[] {
    return allRows(
      this.db,
      `${PAPER_SELECT} ORDER BY p.exam_year DESC, ${SESSION_ORDER_SQL} DESC, p.variant ASC, p.id ASC`,
      [],
    ).map(mapPaper);
  }

  getPaper(id: string): ExamPaperRecord | null {
    const row = firstRow(this.db, `${PAPER_SELECT} WHERE p.id = ?`, [id]);
    return row ? mapPaper(row) : null;
  }

  findByIdentity(identity: {
    examType: PaperExamType;
    year: number;
    session: PaperSession;
    variant: string;
  }): ExamPaperRecord | null {
    const row = firstRow(
      this.db,
      `${PAPER_SELECT} WHERE p.exam_type = ? AND p.exam_year = ? AND p.session = ? AND p.variant = ?`,
      [identity.examType, identity.year, identity.session, identity.variant],
    );
    return row ? mapPaper(row) : null;
  }

  listAssets(paperId: string): PaperAsset[] {
    return allRows(
      this.db,
      "SELECT * FROM paper_asset WHERE paper_id = ? ORDER BY kind ASC, relative_path ASC",
      [paperId],
    ).map(mapAsset);
  }

  getAsset(paperId: string, assetId: string): PaperAsset | null {
    const row = firstRow(this.db, "SELECT * FROM paper_asset WHERE paper_id = ? AND id = ?", [paperId, assetId]);
    return row ? mapAsset(row) : null;
  }

  /**
   * 判定导入后果。纯查询，无副作用 —— dry-run 与真实导入共用它，
   * 因此预演结果与实际结果不可能不一致。
   *
   * 拒绝的两种情况（抛错而不是返回状态，因为它们是**包的问题**，不是可选项）：
   * - 内容变了（checksum 不同）但 content_version 没升：这会让历史作答被静默
   *   指向不同的内容，是明确禁止的。
   * - content_version 比库里低：版本只能前进。
   */
  decideImport(record: ExamPaperRecord): PaperImportDecision {
    const existing = this.findByIdentity({
      examType: record.examType,
      year: record.year,
      session: record.session,
      variant: record.variant,
    });

    if (!existing) return { kind: "insert" };

    // ── 判据用**内容指纹**，不用整包校验和 ──
    //
    // 早先用 `manifestChecksum` 判"内容是否变了"。那会把任何字节变化
    // （provenance 文字、验证说明、逐题证据矩阵）都当成内容实质变化，
    // 于是"只改元数据"也被强制递增 contentVersion —— 而递增版本会错误地
    // 暗示内容是另一版（实测：给历史包补一个派生指纹就被拦下）。
    //
    // 两侧都有指纹时用指纹判内容；任一侧缺失时回退到整包校验和。
    // 回退是**保守**方向：缺数据时宁可要求升版本，也不放行可能的内容变更。
    // 历史行会在下一次真实更新时补上指纹。
    const bothKnown = existing.contentFingerprint !== null && record.contentFingerprint !== null;
    const contentChanged = bothKnown
      ? existing.contentFingerprint !== record.contentFingerprint
      : existing.manifestChecksum !== record.manifestChecksum;

    // 版本只能前进。**这条与内容无关** —— 库里记着 v3 而包声明 v2，
    // 是对"这份内容是哪一版"的自相矛盾陈述，必须拒绝而不是静默接受。
    if (record.contentVersion < existing.contentVersion) {
      throw new PaperVersionConflictError(
        `「${existing.year} 年 ${existing.session} ${existing.variant}」的 contentVersion 只能前进：` +
          `库中为 ${existing.contentVersion}，包中为 ${record.contentVersion}。`,
      );
    }

    // 内容真的变了 ⇒ 必须递增版本，否则历史作答会被静默指向不同的题目
    if (contentChanged) {
      if (record.contentVersion === existing.contentVersion) {
        throw new PaperVersionConflictError(
          `「${existing.year} 年 ${existing.session} ${existing.variant}」内容已变化但 contentVersion 仍为 ` +
            `${existing.contentVersion}。内容实质变化必须递增 contentVersion，否则历史作答会被静默指向不同的题目。`,
        );
      }
      return { kind: "update", fromVersion: existing.contentVersion, toVersion: record.contentVersion };
    }

    // 内容未变。
    // 作者声明了更高的版本 ⇒ 尊重声明并记录（版本号是作者对内容的断言）。
    if (record.contentVersion > existing.contentVersion) {
      return { kind: "update", fromVersion: existing.contentVersion, toVersion: record.contentVersion };
    }

    // 同版本、内容未变。
    //
    // 三种收尾：
    // - 库中缺指纹而包有 ⇒ **首次建立内容身份**（v6 之前导入的行）。
    //   必须写一次把指纹落库，否则这一行永远无法参与指纹比对。
    //   这不算内容变化，也不该被报成"已是最新"（那会让指纹永远补不上）。
    // - 文件完全一致 ⇒ unchanged。
    // - 只有元数据变了 ⇒ metadata_only，**不要求升版本**（内容没变）。
    const needsFingerprintBackfill = existing.contentFingerprint === null && record.contentFingerprint !== null;
    if (needsFingerprintBackfill || existing.manifestChecksum !== record.manifestChecksum) {
      return {
        kind: "metadata_only",
        version: existing.contentVersion,
        checksum: record.manifestChecksum,
      };
    }

    return {
      kind: "unchanged",
      version: existing.contentVersion,
      checksum: record.manifestChecksum,
    };
  }

  saveImport(input: PaperImportInput, decision: PaperImportDecision): ExamPaperRecord {
    const { record, assets } = input;
    const now = nowISO();

    if (decision.kind === "unchanged") {
      const current = this.getPaper(record.id);
      if (!current) throw new Error(`索引状态异常：判定为 unchanged 但找不到试卷 ${record.id}`);
      return current;
    }

    if (decision.kind === "insert") {
      this.db
        .prepare(
          `INSERT INTO exam_paper (
             id, exam_type, exam_year, session, variant, exam_date, source_kind, verification_status,
             provenance_note, provenance_ref, verification_note, content_version, partial,
             package_path, manifest_checksum, content_fingerprint, section_count, question_count,
             imported_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.examType,
          record.year,
          record.session,
          record.variant,
          record.examDate,
          record.sourceKind,
          record.verificationStatus,
          record.provenance.note,
          record.provenance.reference,
          record.provenance.verificationNote,
          record.contentVersion,
          fromBool(record.partial),
          record.packagePath,
          record.manifestChecksum,
          record.contentFingerprint,
          record.sectionCount,
          record.questionCount,
          now,
          now,
        );
    } else {
      this.db
        .prepare(
          `UPDATE exam_paper SET
             exam_date = ?, source_kind = ?, verification_status = ?,
             provenance_note = ?, provenance_ref = ?, verification_note = ?,
             content_version = ?, partial = ?, package_path = ?, manifest_checksum = ?,
             content_fingerprint = ?,
             section_count = ?, question_count = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          record.examDate,
          record.sourceKind,
          record.verificationStatus,
          record.provenance.note,
          record.provenance.reference,
          record.provenance.verificationNote,
          record.contentVersion,
          fromBool(record.partial),
          record.packagePath,
          record.manifestChecksum,
          record.contentFingerprint,
          record.sectionCount,
          record.questionCount,
          now,
          record.id,
        );
    }

    // 资产整体替换：版本升级可能移除旧资产，逐条 upsert 会留下悬空行。
    this.db.prepare("DELETE FROM paper_asset WHERE paper_id = ?").run(record.id);
    const insertAsset = this.db.prepare(
      `INSERT INTO paper_asset (paper_id, id, kind, relative_path, mime_type, bytes, checksum, label)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const asset of assets) {
      insertAsset.run(
        record.id,
        asset.id,
        asset.kind,
        asset.relativePath,
        asset.mimeType,
        asset.bytes,
        asset.checksum,
        asset.label,
      );
    }

    const saved = this.getPaper(record.id);
    if (!saved) throw new Error(`导入后无法读回试卷 ${record.id}`);
    return saved;
  }

  setPool(paperId: string, pool: PaperPool): ExamPaperRecord | null {
    const existing = this.getPaper(paperId);
    if (!existing) return null;
    this.db
      .prepare(
        `INSERT INTO paper_study_state (paper_id, pool, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(paper_id) DO UPDATE SET pool = excluded.pool, updated_at = excluded.updated_at`,
      )
      .run(paperId, pool, nowISO());
    // 策略状态与内容版本无关，因此不触碰 exam_paper.updated_at
    return this.getPaper(paperId);
  }

  countPapers(): number {
    const row = firstRow(this.db, "SELECT COUNT(*) AS c FROM exam_paper", []);
    return row ? toInt(row.c) : 0;
  }
}

/**
 * 版本冲突。刻意做成具名错误：
 * 调用方必须**区分**"包本身有问题"和"包与库冲突"，
 * 前者应修包，后者应先决定版本策略，两者的处置完全不同。
 */
export class PaperVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaperVersionConflictError";
  }
}
