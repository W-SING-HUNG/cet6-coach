import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { newId } from "@/lib/id";
import { nowISO } from "@/lib/date";
import type { CourseAsset } from "@/content/course/types";
import {
  COURSE_EXPOSURE_EVENT_TYPES,
  COURSE_LINK_TARGET_SCOPES,
  COURSE_LINK_VERIFICATION_STATUSES,
  type CourseExposureEventType,
  type CourseLinkTargetScope,
  type CourseLinkVerificationStatus,
} from "@/domain/course";
import type { CourseExposureEvent } from "@/domain/models";
import {
  revealExposureIdentity,
  type CourseCanonicalLinkRecord,
  type CourseExposureInput,
  type CourseImportDecision,
  type CourseImportInput,
  type CoursePackageRecord,
  type CourseRepository,
} from "../ports";
import { allRows, firstRow, json, toInt, toNullableText, toText, type Row } from "./support";

/**
 * 课程层（Course Layer）的 SQLite 实现。
 *
 * 关键约束（贯穿本文件）：
 *
 * 1. **表格里没有正文。** 只存索引、来源、版本、校验和、计数。
 *    正文的规范来源是 private-content/courses 下的规范化包。
 * 2. **曝光只追加。** 本类不提供 update / delete 曝光的方法；数据库侧另有
 *    BEFORE UPDATE/DELETE 触发器兜底，绕过本类的直接 SQL 同样无法改写历史。
 * 3. **本文件不写任何 Expert 台账或旧闭环表。** 这里没有一条 SQL 触及
 *    `performance_event` / `assessment_event` / `evidence_projection` /
 *    `skill_profile` / `answer_attempt` / `review_item`。
 *    课程曝光与表现证据在**存储层**就不相通。
 */

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

function mapPackage(row: Row): CoursePackageRecord {
  return {
    id: toText(row.id),
    provider: toText(row.provider),
    edition: toNullableText(row.edition),
    title: toText(row.title),
    contentVersion: toInt(row.content_version, 1),
    provenance: {
      note: toText(row.provenance_note),
      reference: toNullableText(row.provenance_ref),
      rightsNote: toText(row.rights_note),
    },
    packagePath: toText(row.package_path),
    manifestChecksum: toText(row.manifest_checksum),
    contentFingerprint: toNullableText(row.content_fingerprint),
    materialCount: toInt(row.material_count),
    segmentCount: toInt(row.segment_count),
    assetCount: toInt(row.asset_count),
    assetBytes: toInt(row.asset_bytes),
    importedAt: toText(row.imported_at),
    updatedAt: toText(row.updated_at),
  };
}

/**
 * 资产只以 JSON 落在课程包行上（`asset_index`）。
 *
 * 为什么不像试卷那样单开一张 `course_asset` 表：课程资产**不需要被外键引用**。
 * 试卷资产要按 (paperId, assetId) 单独解析出磁盘路径去流式播放音频，
 * 而课程正文不在本阶段的服务路径上（无 UI）。为一个当前无人查询的集合
 * 建表 + 建索引，是"未来可能有"的空结构 —— 而 schema 的原则是克制。
 *
 * 若后续阶段需要按资产查询，那时再加表是纯增量迁移。
 */
function mapLink(row: Row): CourseCanonicalLinkRecord {
  return {
    id: toText(row.id),
    courseId: toText(row.course_id),
    segmentId: toText(row.segment_id),
    courseContentVersion: toInt(row.course_content_version, 1),
    paperId: toText(row.paper_id),
    paperContentVersion: toInt(row.paper_content_version, 1),
    sectionId: toText(row.section_id),
    groupId: toNullableText(row.group_id),
    questionId: toNullableText(row.question_id),
    targetScope: toText(row.target_scope) as CourseLinkTargetScope,
    verificationStatus: toText(row.verification_status) as CourseLinkVerificationStatus,
    verificationRef: toText(row.verification_ref),
    note: toNullableText(row.note),
    createdAt: toText(row.created_at),
  };
}

function mapExposure(row: Row): CourseExposureEvent {
  return {
    id: toText(row.id),
    profileId: toText(row.profile_id),
    courseId: toText(row.course_id),
    segmentId: toText(row.segment_id),
    courseContentVersion: toInt(row.course_content_version, 1),
    eventType: toText(row.event_type) as CourseExposureEventType,
    occurredAt: toText(row.occurred_at),
  };
}

// ---------------------------------------------------------------------------
// 链接身份的确定性推导
// ---------------------------------------------------------------------------

/**
 * 由**复核主张**推导链接 id。
 *
 * ── 为什么不是随机 UUID ──
 *
 * 同一份核验声明会被写入多次：CLI 重跑、包重新导入、人工把同一条复核再确认一遍。
 * 随机 id 会让每次重跑都追加一条一模一样的链接，于是"这段材料对应哪道题"
 * 会有 N 个答案（全都相同），而 N 会随时间无上限增长。用确定性 id +
 * `ON CONFLICT(id) DO NOTHING`，幂等性就落在**数据库层**，
 * 而不是靠调用方"记得先查一下"（那是 check-then-act 竞态）。
 *
 * ── 身份里**必须包含**审计元数据（本次 Review Fix 的关键修正）──
 *
 * 一行 = 一条**不可变的复核主张**。因此身份必须能区分"两条不同的主张"：
 *
 * | 字段 | 参与身份 | 理由 |
 * | --- | --- | --- |
 * | 映射身份（course/version/segment/paper/version/section/group/question/scope） | 是 | 主张的**对象** |
 * | `verificationStatus` | 是 | verified 与 candidate 是两条不同主张 |
 * | `verificationRef` | **是** | 出处是主张的一部分 |
 * | `note` | **是** | 审计注解是主张的一部分 |
 * | `createdAt` | **否** | 时间不是主张的内容；纳入会让每次重跑都产生新行 |
 *
 * 早先 `verificationRef` **不在**身份里，产生了一个真实的审计缺陷：
 * 用**修正后的出处**重新核验同一组映射时，推导出的 id 与旧行相同、
 * `ON CONFLICT DO NOTHING` 静默命中，于是**修正被吞掉**，库里仍是最初那条
 * 出处 —— 而操作者看到的是"PASS（无变化）"。现在它会追加一条新行，
 * 旧行原样保留。
 *
 * 用 NUL 作为分隔符：它是唯一不可能出现在任何 slug / paper id 里的字符，
 * 因此不可能构造出"两个不同身份拼出同一个串"的情形。
 */
export function courseLinkIdentity(input: {
  courseId: string;
  courseContentVersion: number;
  segmentId: string;
  paperId: string;
  paperContentVersion: number;
  sectionId: string;
  groupId: string | null;
  questionId: string | null;
  targetScope: CourseLinkTargetScope;
  verificationStatus: CourseLinkVerificationStatus;
  /** 审计出处。**参与身份** —— 见上面的表。 */
  verificationRef: string;
  /** 审计注解。**参与身份** —— 见上面的表。 */
  note: string | null;
}): string {
  const parts = [
    input.courseId,
    String(input.courseContentVersion),
    input.segmentId,
    input.paperId,
    String(input.paperContentVersion),
    input.sectionId,
    input.groupId ?? "",
    input.questionId ?? "",
    input.targetScope,
    input.verificationStatus,
    input.verificationRef,
    input.note ?? "",
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/**
 * **语义目标身份**：与审计元数据无关。
 *
 * 多条不可变复核行可以描述**同一个**当前 canonical 目标
 * （同一映射被独立复核两次，或出处被修正后重新核验 —— 那会产生两行）。
 * 运行时真相必须把它们视为**一个**目标，否则一次复核修正会让系统
 * 以为出现了两个不同的对应关系。
 *
 * 刻意**不含** `verificationRef` / `note` / `createdAt` / `verificationStatus`：
 * 前两者是审计元数据、第三者是时间；`verificationStatus` 由调用方按
 * "只看 verified"先行过滤。
 */
export function courseLinkSemanticTarget(input: {
  courseId: string;
  courseContentVersion: number;
  segmentId: string;
  paperId: string;
  paperContentVersion: number;
  sectionId: string;
  groupId: string | null;
  questionId: string | null;
  targetScope: CourseLinkTargetScope;
}): string {
  const parts = [
    input.courseId,
    String(input.courseContentVersion),
    input.segmentId,
    input.paperId,
    String(input.paperContentVersion),
    input.sectionId,
    input.groupId ?? "",
    input.questionId ?? "",
    input.targetScope,
  ];
  return createHash("sha256").update(parts.join("\u0000")).digest("hex");
}

/** 由声明生成链接 id 并做一次自检：推导出的 id 必须稳定（同输入同输出）。 */
export function linkIdOf(input: Parameters<typeof courseLinkIdentity>[0]): string {
  return courseLinkIdentity(input);
}

/** 由声明生成**语义目标** id（审计元数据不参与）。 */
export function semanticTargetOf(input: Parameters<typeof courseLinkSemanticTarget>[0]): string {
  return courseLinkSemanticTarget(input);
}

// ---------------------------------------------------------------------------
// 实现
// ---------------------------------------------------------------------------

export class SqliteCourseRepository implements CourseRepository {
  constructor(private readonly db: DatabaseSync) {}

  /**
   * 课程层是否**已激活**（即 `course_package` 表是否存在于这个库）。
   *
   * ── 为什么需要它 ──
   *
   * 课程层表是 v9 才有的。一个 v8 库（例如尚未 `course:import --commit` 的
   * 使用者 库）里**根本没有这些表**。此时若直接查询，SQLite 会抛
   * `no such table: course_package` —— 那是一个"崩溃"，不是一条"如实说明"。
   *
   * 只读命令（dry-run / list / segments）在 v8 上的正确行为是：
   * **如实报告课程层尚未激活**，而不是报错，更不是偷偷迁移。
   * 因此所有读方法都先问这个探针，未激活时返回空/空集。
   *
   * 这**不是**"假装 v9"：未激活 ⇔ 不存在任何合法的课程层行
   * （那些行只可能由 `course:import --commit` 在 v9 上写入）。
   * 因此"索引为空"在 v8 上是**事实**，不是猜测。
   *
   * 刻意**不做实例级缓存**：它是一次极廉价的 `sqlite_master` 查询，
   * 而缓存会让"同一实例先看到未激活、迁移后又读到空"这种状态难以推理。
   */
  isActivated(): boolean {
    const row = firstRow(
      this.db,
      "SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'course_package'",
      [],
    );
    return row !== null;
  }

  listPackages(): CoursePackageRecord[] {
    if (!this.isActivated()) return [];
    return allRows(
      this.db,
      "SELECT * FROM course_package ORDER BY provider ASC, title ASC, id ASC",
      [],
    ).map(mapPackage);
  }

  getPackage(id: string): CoursePackageRecord | null {
    if (!this.isActivated()) return null;
    const row = firstRow(this.db, "SELECT * FROM course_package WHERE id = ?", [id]);
    return row ? mapPackage(row) : null;
  }

  /**
   * 判定导入后果。**纯查询，无副作用** —— dry-run 与真实导入共用它，
   * 因此预演结果与实际结果不可能不一致。
   *
   * 判据与试卷导入逐条对应：
   * - 内容变了（指纹不同）但版本没升 ⇒ 拒绝（历史曝光会被静默指向另一版内容）；
   * - 版本比库里低 ⇒ 拒绝（版本只能前进）；
   * - 内容未变、只有元数据/文件变了 ⇒ `metadata_only`，**不涨版本**；
   * - 完全一致 ⇒ `unchanged`。
   */
  decideImport(record: CoursePackageRecord): CourseImportDecision {
    const existing = this.getPackage(record.id);
    if (!existing) return { kind: "insert" };

    // 两侧都有指纹时用指纹判内容；任一侧缺失时回退到整包校验和。
    // 回退是**保守**方向：缺数据时宁可要求升版本，也不放行可能的内容变更。
    const bothKnown = existing.contentFingerprint !== null && record.contentFingerprint !== null;
    const contentChanged = bothKnown
      ? existing.contentFingerprint !== record.contentFingerprint
      : existing.manifestChecksum !== record.manifestChecksum;

    if (record.contentVersion < existing.contentVersion) {
      throw new CourseVersionConflictError(
        `课程「${existing.title}」的 contentVersion 只能前进：` +
          `库中为 ${existing.contentVersion}，包中为 ${record.contentVersion}。`,
      );
    }

    if (contentChanged) {
      if (record.contentVersion === existing.contentVersion) {
        throw new CourseVersionConflictError(
          `课程「${existing.title}」内容已变化但 contentVersion 仍为 ${existing.contentVersion}。` +
            `内容实质变化必须递增 contentVersion，否则已核验的 canonical 链接会被静默套用到新内容上。`,
        );
      }
      return { kind: "update", fromVersion: existing.contentVersion, toVersion: record.contentVersion };
    }

    if (record.contentVersion > existing.contentVersion) {
      return { kind: "update", fromVersion: existing.contentVersion, toVersion: record.contentVersion };
    }

    const needsFingerprintBackfill = existing.contentFingerprint === null && record.contentFingerprint !== null;
    if (needsFingerprintBackfill || existing.manifestChecksum !== record.manifestChecksum) {
      return { kind: "metadata_only", version: existing.contentVersion, checksum: record.manifestChecksum };
    }

    return { kind: "unchanged", version: existing.contentVersion, checksum: record.manifestChecksum };
  }

  saveImport(input: CourseImportInput, decision: CourseImportDecision): CoursePackageRecord {
    const { record, assets } = input;
    const now = nowISO();

    if (decision.kind === "unchanged") {
      const current = this.getPackage(record.id);
      if (!current) throw new Error(`索引状态异常：判定为 unchanged 但找不到课程包 ${record.id}`);
      return current;
    }

    const assetIndex = json(
      assets.map((asset: CourseAsset) => ({
        id: asset.id,
        kind: asset.kind,
        relativePath: asset.relativePath,
        mimeType: asset.mimeType,
        bytes: asset.bytes,
        checksum: asset.checksum,
        label: asset.label,
      })),
    );

    if (decision.kind === "insert") {
      this.db
        .prepare(
          `INSERT INTO course_package (
             id, provider, edition, title, content_version, provenance_note, provenance_ref,
             rights_note, package_path, manifest_checksum, content_fingerprint,
             material_count, segment_count, asset_count, asset_bytes, asset_index,
             imported_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          record.id,
          record.provider,
          record.edition,
          record.title,
          record.contentVersion,
          record.provenance.note,
          record.provenance.reference,
          record.provenance.rightsNote,
          record.packagePath,
          record.manifestChecksum,
          record.contentFingerprint,
          record.materialCount,
          record.segmentCount,
          record.assetCount,
          record.assetBytes,
          assetIndex,
          now,
          now,
        );
    } else {
      this.db
        .prepare(
          `UPDATE course_package SET
             provider = ?, edition = ?, title = ?, content_version = ?,
             provenance_note = ?, provenance_ref = ?, rights_note = ?,
             package_path = ?, manifest_checksum = ?, content_fingerprint = ?,
             material_count = ?, segment_count = ?, asset_count = ?, asset_bytes = ?,
             asset_index = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          record.provider,
          record.edition,
          record.title,
          record.contentVersion,
          record.provenance.note,
          record.provenance.reference,
          record.provenance.rightsNote,
          record.packagePath,
          record.manifestChecksum,
          record.contentFingerprint,
          record.materialCount,
          record.segmentCount,
          record.assetCount,
          record.assetBytes,
          assetIndex,
          now,
          record.id,
        );
    }

    const saved = this.getPackage(record.id);
    if (!saved) throw new Error(`导入后无法读回课程包 ${record.id}`);
    return saved;
  }

  countPackages(): number {
    if (!this.isActivated()) return 0;
    const row = firstRow(this.db, "SELECT COUNT(*) AS c FROM course_package", []);
    return row ? toInt(row.c) : 0;
  }

  hasContentVersion(courseId: string, contentVersion: number): boolean {
    if (!this.isActivated()) return false;
    const row = firstRow(
      this.db,
      "SELECT 1 AS hit FROM course_package WHERE id = ? AND content_version = ?",
      [courseId, contentVersion],
    );
    return row !== null;
  }

  /**
   * 追加一条链接。**幂等**：id 由声明身份确定性推导，重复写入同一份声明
   * 返回既有行（`created: false`），不产生第二条。
   *
   * 用 `INSERT ... ON CONFLICT(id) DO NOTHING` 而不是"先 SELECT 再决定" ——
   * 后者是 check-then-act，两个并发写入都会看到"不存在"然后各自插入。
   */
  appendLink(link: CourseCanonicalLinkRecord): {
    link: CourseCanonicalLinkRecord;
    created: boolean;
  } {
    // 声明层自检：scope 与标识必须结构成立。这里挡的是**内部调用错误**，
    // 面向外部输入的完整校验在服务层（它能看到课程包与真题的正文）。
    assertScopeShape(link.targetScope, link.sectionId, link.groupId, link.questionId);

    const result = this.db
      .prepare(
        `INSERT INTO course_canonical_link (
           id, course_id, segment_id, course_content_version,
           paper_id, paper_content_version, section_id, group_id, question_id,
           target_scope, verification_status, verification_ref, note, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        link.id,
        link.courseId,
        link.segmentId,
        link.courseContentVersion,
        link.paperId,
        link.paperContentVersion,
        link.sectionId,
        link.groupId,
        link.questionId,
        link.targetScope,
        link.verificationStatus,
        link.verificationRef,
        link.note,
        link.createdAt,
      );

    const created = Number(result.changes) > 0;
    const saved = this.getLink(link.id);
    if (!saved) throw new Error(`链接写入后无法读回：${link.id}`);
    return { link: saved, created };
  }

  getLink(id: string): CourseCanonicalLinkRecord | null {
    if (!this.isActivated()) return null;
    const row = firstRow(this.db, "SELECT * FROM course_canonical_link WHERE id = ?", [id]);
    return row ? mapLink(row) : null;
  }

  listLinksForSegment(courseId: string, segmentId: string): CourseCanonicalLinkRecord[] {
    if (!this.isActivated()) return [];
    return allRows(
      this.db,
      `SELECT * FROM course_canonical_link
       WHERE course_id = ? AND segment_id = ?
       ORDER BY created_at DESC, id ASC`,
      [courseId, segmentId],
    ).map(mapLink);
  }

  listLinksForCourse(courseId: string): CourseCanonicalLinkRecord[] {
    if (!this.isActivated()) return [];
    return allRows(
      this.db,
      `SELECT * FROM course_canonical_link
       WHERE course_id = ?
       ORDER BY segment_id ASC, created_at DESC, id ASC`,
      [courseId],
    ).map(mapLink);
  }

  /** 追加一条课程曝光观测。**没有对应的 update / delete。** */
  appendExposure(input: CourseExposureInput): CourseExposureEvent {
    // 事件种类必须是登记过的值。刻意在这里显式抛错而不是靠 CHECK 约束：
    // 报错发生在写入之前、且措辞可读，而 SQLite 的 CHECK 失败只会给出一句
    // "constraint failed"，看不出是哪个字段、允许哪些值。
    if (!COURSE_EXPOSURE_EVENT_TYPES.includes(input.eventType)) {
      throw new Error(
        `未登记的课程曝光事件种类：${input.eventType}（允许 ${COURSE_EXPOSURE_EVENT_TYPES.join(" / ")}）`,
      );
    }

    const id = newId();
    this.db
      .prepare(
        `INSERT INTO course_exposure_event
           (id, profile_id, course_id, segment_id, course_content_version, event_type, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.profileId,
        input.courseId,
        input.segmentId,
        input.courseContentVersion,
        input.eventType,
        input.occurredAt,
      );

    const row = firstRow(this.db, "SELECT * FROM course_exposure_event WHERE id = ?", [id]);
    if (!row) throw new Error(`曝光写入后无法读回：${id}`);
    return mapExposure(row);
  }

  /**
   * **原子幂等地**追加一条揭示曝光（`reveal_requested`）。
   *
   * ── 实现要点 ──
   *
   * id 由 `revealExposureIdentity` 从 (profile, course, 内容版本, 段) 确定性
   * 推导，因此同一个揭示动作的重复请求会算出**同一个** id。
   * `INSERT ... ON CONFLICT(id) DO NOTHING` 让"是否已存在"与"插入"
   * 成为同一条 SQL 的原子行为 —— 没有 check-then-act 的竞态窗口。
   *
   * ── 它**不需要** schema 迁移 ──
   *
   * `course_exposure_event.id` 已经是 `TEXT PRIMARY KEY`，冲突判定由既有
   * 主键提供。没有新表、新列、新索引、新触发器。
   *
   * ── 四种既有事件的追加语义**未变** ──
   *
   * 它们继续走 `appendExposure`（随机 id，每次追加新行）。只有
   * `reveal_requested` 用本方法 —— 因为"同一个揭示动作"在语义上就是
   * 一件事，而"同一段被渲染三次"是三件事。
   */
  appendRevealExposureOnce(input: {
    profileId: string;
    courseId: string;
    courseContentVersion: number;
    segmentId: string;
    occurredAt: string;
  }): { event: CourseExposureEvent; created: boolean } {
    const id = revealExposureIdentity({
      profileId: input.profileId,
      courseId: input.courseId,
      courseContentVersion: input.courseContentVersion,
      segmentId: input.segmentId,
    });

    /*
     * 幂等与 `created` 语义都由**同一条 INSERT** 的原子结果给出。
     *
     * 上一版在这里先 `SELECT` 一次、再 `INSERT ... ON CONFLICT DO NOTHING`，
     * 然后用"插入前是否已存在"推 `created`。那个推断有竞态窗口：
     * 另一个连接可能在 SELECT 之后、INSERT 之前提交同一身份的行，
     * 于是本次 INSERT 实际被冲突跳过（`changes === 0`），`created` 却报
     * `true` —— 调用方会以为自己写了新观测。
     *
     * `run()` 返回的 `changes` 是 SQLite 对**这一条语句**的原子计数：
     * `ON CONFLICT DO NOTHING` 命中时它为 0，真正插入时为 1。
     * 因此它是唯一同时覆盖两种情形的判据，且不引入第二次查询。
     *
     * 注意判据必须是 `=== 1` 而不是真值：`changes` 可能是 bigint。
     */
    const written = this.db
      .prepare(
        `INSERT INTO course_exposure_event
           (id, profile_id, course_id, segment_id, course_content_version, event_type, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING`,
      )
      .run(
        id,
        input.profileId,
        input.courseId,
        input.segmentId,
        input.courseContentVersion,
        "reveal_requested",
        input.occurredAt,
      );
    const created = Number(written.changes) === 1;

    /*
     * 读回**库里那一行**（不是本次入参）。
     *
     * 幂等命中时它是另一个请求首次写入的那条，因此 `occurredAt`
     * 永远是首次揭示的时刻 —— 本次请求的 `input.occurredAt` 被
     * `DO NOTHING` 丢弃，历史时间戳不被覆盖（只追加语义的一部分）。
     */
    const row = firstRow(this.db, "SELECT * FROM course_exposure_event WHERE id = ?", [id]);
    if (!row) throw new Error(`揭示曝光写入后无法读回：${id}`);
    return { event: mapExposure(row), created };
  }

  listExposureForProfile(profileId: string, limit: number): CourseExposureEvent[] {
    if (!this.isActivated()) return [];
    return allRows(
      this.db,
      `SELECT * FROM course_exposure_event WHERE profile_id = ?
       ORDER BY occurred_at DESC, id ASC LIMIT ?`,
      [profileId, limit],
    ).map(mapExposure);
  }

  /**
   * 某 profile 的**全部**曝光，无 LIMIT。
   *
   * ── 为什么不能复用 `listExposureForProfile` 的 LIMIT ──
   *
   * 那个方法的语义是"最近看过什么"，是**展示**；截断它只是少显示几行。
   * 而模考新鲜度是**结论**：漏掉任意一条历史曝光，就会把"已接触"错报成
   * "尚未接触"，也就是把一份已经见过的卷子重新标成严格未见模考。
   * 因此这里刻意没有 LIMIT。
   *
   * 排序按 (course_id, segment_id, occurred_at, id) —— 全确定，因此
   * 上游分组与聚合的结果与查询返回顺序无关（可复现）。
   */
  listAllExposureForProfile(profileId: string): CourseExposureEvent[] {
    if (!this.isActivated()) return [];
    return allRows(
      this.db,
      `SELECT * FROM course_exposure_event WHERE profile_id = ?
       ORDER BY course_id ASC, segment_id ASC, occurred_at ASC, id ASC`,
      [profileId],
    ).map(mapExposure);
  }

  /** 某一段的全部曝光（**跨内容版本**，按时间倒序）。 */
  listExposureForSegment(profileId: string, courseId: string, segmentId: string): CourseExposureEvent[] {
    if (!this.isActivated()) return [];
    return allRows(
      this.db,
      `SELECT * FROM course_exposure_event
       WHERE profile_id = ? AND course_id = ? AND segment_id = ?
       ORDER BY occurred_at DESC, id ASC`,
      [profileId, courseId, segmentId],
    ).map(mapExposure);
  }

  countExposure(profileId: string): number {
    if (!this.isActivated()) return 0;
    const row = firstRow(
      this.db,
      "SELECT COUNT(*) AS c FROM course_exposure_event WHERE profile_id = ?",
      [profileId],
    );
    return row ? toInt(row.c) : 0;
  }
}

/**
 * scope 与标识的结构一致性（**唯一实现**）。
 *
 * 三种 scope 互斥且各自要求不同的标识：
 * - `section`：只声明 section；
 * - `group`：section + group，question 必须为空；
 * - `question`：三个都要。
 *
 * 为什么必须挡：`section` scope 却填了 `question_id` 的行，会让"这条链接
 * 到底指向哪里"有两个互相矛盾的答案 —— 下游按 scope 读会得到 section，
 * 按 question_id 读会得到某道题。
 */
export function assertScopeShape(
  scope: CourseLinkTargetScope,
  sectionId: string | null,
  groupId: string | null,
  questionId: string | null,
): void {
  if (!COURSE_LINK_TARGET_SCOPES.includes(scope)) {
    throw new Error(`未登记的链接目标粒度：${scope}（允许 ${COURSE_LINK_TARGET_SCOPES.join(" / ")}）`);
  }
  if (!sectionId) throw new Error("链接必须声明 section_id —— 任何粒度的规范目标都属于某个大题。");

  if (scope === "section") {
    if (groupId !== null || questionId !== null) {
      throw new Error("section 粒度的链接不得同时声明 group_id / question_id。");
    }
    return;
  }
  if (!groupId) throw new Error(`${scope} 粒度的链接必须声明 group_id。`);
  if (scope === "group") {
    if (questionId !== null) throw new Error("group 粒度的链接不得同时声明 question_id。");
    return;
  }
  if (!questionId) throw new Error("question 粒度的链接必须声明 question_id。");
}

/** 版本冲突。刻意具名：调用方必须区分"包本身有问题"与"包与库冲突"。 */
export class CourseVersionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseVersionConflictError";
  }
}

export { COURSE_LINK_VERIFICATION_STATUSES };
