import type { Repositories, ExamPaperRecord, PaperImportDecision } from "@/repositories/ports";
import { contentFingerprint } from "@/content/pipeline/fingerprint";
import type { ExamPaperContent, PaperIssue, ValidatedPaper } from "@/content/paper/types";
import { NormalizedPackageImporter, ManifestReadError } from "@/content/paper/importer";
import { getContentRoot, getPapersDir } from "@/content/paper/paths";
import { PaperVersionConflictError } from "@/repositories/sqlite/papers";
import { PAPER_SESSION_LABELS, type PaperSession } from "@/domain/paper";

/**
 * 真题包导入编排。
 *
 * 两阶段，刻意分离：
 * 1. `planImport` —— 发现、校验、判定后果。**零写入。** 这就是 dry-run。
 * 2. `commitImport` —— 在**一个事务**内写入所有判定为 insert/update 的包。
 *
 * 为什么 dry-run 与真实导入必须共用同一段代码：
 * 如果它们各写一套，预演就可能与真实结果不一致 ——
 * 而"预演说没问题，真跑却写坏"正是用户无法信任导入的原因。
 *
 * 原子性：整批一个事务。任一条目写入失败则整批回滚。
 * 绝不出现"导了 3 个包，第 4 个坏在中间"的半成品状态。
 */

export interface ImportEntryReport {
  packagePath: string;
  paperId: string | null;
  title: string;
  decision: PaperImportDecision["kind"] | "rejected";
  detail: string;
  issues: PaperIssue[];
  warnings: string[];
}

export interface ImportReport {
  contentRoot: string;
  papersDir: string;
  discovered: number;
  entries: ImportEntryReport[];
  counts: {
    insert: number;
    update: number;
    /** 印出内容未变、仅元数据（provenance / 证据链 / 指纹回填）更新。 */
    metadataOnly: number;
    unchanged: number;
    rejected: number;
  };
}

export interface ImportOptions {
  /** 只导入指定的包目录名。为空则处理全部。 */
  only?: string[];
}

interface PlannedEntry {
  report: ImportEntryReport;
  paper: ValidatedPaper | null;
  decision: PaperImportDecision | null;
}

function paperTitle(paper: Pick<ExamPaperContent, "year" | "session" | "variant">): string {
  const session = PAPER_SESSION_LABELS[paper.session as PaperSession] ?? paper.session;
  const variant = paper.variant === "single" ? "" : ` · ${paper.variant}`;
  return `${paper.year} 年 ${session}${variant}`;
}

function toRecord(
  paper: ValidatedPaper,
  importer: NormalizedPackageImporter,
  handle: { relativePath: string },
): Omit<ExamPaperRecord, "importedAt" | "updatedAt" | "pool"> {
  const content = paper.content;
  return {
    id: content.id,
    examType: content.examType,
    year: content.year,
    session: content.session,
    variant: content.variant,
    examDate: content.examDate,
    sourceKind: content.sourceKind,
    verificationStatus: content.verificationStatus,
    provenance: content.provenance,
    contentVersion: content.contentVersion,
    partial: content.partial,
    packagePath: handle.relativePath,
    manifestChecksum: paper.checksum,
    // 印出内容的规范指纹。判"内容是否变了"用它，不用整包校验和 ——
    // 后者会把 provenance 文字变更也当成内容变化（见 schema v6 迁移说明）。
    contentFingerprint: contentFingerprint(content),
    sectionCount: content.sections.length,
    questionCount: content.sections.reduce(
      (sum, section) => sum + section.groups.reduce((groupSum, group) => groupSum + group.questions.length, 0),
      0,
    ),
  };
}

/** 校验 + 判定。纯读取，可在任何时刻安全执行。 */
export function planImport(repos: Repositories, options: ImportOptions = {}): {
  report: ImportReport;
  pending: PlannedEntry[];
} {
  const papersDir = getPapersDir();
  const importer = new NormalizedPackageImporter(papersDir);
  const only = options.only && options.only.length > 0 ? new Set(options.only) : null;

  const handles = importer.discover().filter((handle) => !only || only.has(handle.relativePath));
  const pending: PlannedEntry[] = [];

  // 批内身份去重。
  //
  // 为什么必须在计划阶段处理：两份不同的目录装同一份试卷（例如用户把同一个包
  // 复制成了 `2024-12-set1` 和 `2024-12-set1-backup`）时，两条都会判定为 insert，
  // 于是第二条会在写路径上撞唯一约束，把**整批**回滚 ——
  // 用户会看到一句 SQLite 约束错误，而不是"这两个目录是同一份卷子"。
  // 在这里识别，就能给出可读的原因，并且不影响其它包的正常导入。
  const seenIdentities = new Map<string, string>();

  for (const handle of handles) {
    let paper: ValidatedPaper;
    try {
      paper = importer.validate(handle);
    } catch (error) {
      const issues =
        error instanceof ManifestReadError
          ? error.issues
          : [{ path: "<paper>", message: (error as Error).message }];
      pending.push({
        report: {
          packagePath: handle.relativePath,
          paperId: null,
          title: handle.relativePath,
          decision: "rejected",
          detail: "校验未通过，未写入任何数据",
          issues,
          warnings: [],
        },
        paper: null,
        decision: null,
      });
      continue;
    }

    const record = toRecord(paper, importer, handle);
    const title = paperTitle(paper.content);

    const identityKey = `${record.examType}|${record.year}|${record.session}|${record.variant}`;
    const earlier = seenIdentities.get(identityKey);
    if (earlier) {
      pending.push({
        report: {
          packagePath: handle.relativePath,
          paperId: record.id,
          title,
          decision: "rejected",
          detail: "与同一批中的另一个包是同一份试卷，未写入",
          issues: [
            {
              path: "variant",
              message:
                `与 ${earlier} 的身份重复（${identityKey}）。` +
                `同一年同一场次同一套卷只能有一条记录 —— 若是同一个包被复制成了两份，删除多余的那份。`,
            },
          ],
          warnings: [],
        },
        paper: null,
        decision: null,
      });
      continue;
    }
    seenIdentities.set(identityKey, handle.relativePath);

    try {
      const decision = repos.papers.decideImport({ ...record, importedAt: "", updatedAt: "", pool: "training" });
      pending.push({
        report: {
          packagePath: handle.relativePath,
          paperId: record.id,
          title,
          decision: decision.kind,
          detail:
            decision.kind === "insert"
              ? "新增"
              : decision.kind === "update"
                ? `版本升级 v${decision.fromVersion} → v${decision.toVersion}`
                : decision.kind === "metadata_only"
                  ? `仅元数据更新（v${decision.version}，内容指纹未变，不递增版本）`
                  : `已是最新（v${decision.version}）`,
          issues: [],
          warnings: paper.warnings,
        },
        paper,
        decision,
      });
    } catch (error) {
      const isConflict = error instanceof PaperVersionConflictError;
      pending.push({
        report: {
          packagePath: handle.relativePath,
          paperId: record.id,
          title,
          decision: "rejected",
          detail: isConflict ? "与库中版本冲突，未写入" : "无法判定导入后果，未写入",
          issues: [{ path: "contentVersion", message: (error as Error).message }],
          warnings: [],
        },
        paper,
        decision: null,
      });
    }
  }

  return { report: buildReport(papersDir, handles.length, pending), pending };
}

function buildReport(papersDir: string, discovered: number, pending: PlannedEntry[]): ImportReport {
  const counts = { insert: 0, update: 0, metadataOnly: 0, unchanged: 0, rejected: 0 };
  for (const entry of pending) {
    const decision = entry.report.decision;
    if (decision === "insert") counts.insert += 1;
    else if (decision === "update") counts.update += 1;
    else if (decision === "metadata_only") counts.metadataOnly += 1;
    else if (decision === "unchanged") counts.unchanged += 1;
    // 只有显式标记为 rejected 的才计入拒绝 ——
    // 早先用 `else` 兜底，于是 metadata_only 被误算成"拒绝"，
    // 报告会说"3 份被拒绝"而实际全部可写入（实测踩到）。
    else if (decision === "rejected") counts.rejected += 1;
  }
  return {
    contentRoot: getContentRoot(),
    papersDir,
    discovered,
    entries: pending.map((entry) => entry.report),
    counts,
  };
}

export interface CommitResult {
  ok: boolean;
  report: ImportReport;
  /** 实际写入的试卷数量 */
  written: number;
  /** 写入失败时的原因（整批已回滚，库状态未变） */
  error: string | null;
}

/**
 * 提交导入。
 *
 * 只写入判定为 insert / update 的条目；`unchanged` 不写（避免无意义的更新），
 * `rejected` 从不进入写路径。
 *
 * 全部写入包在一个事务里 —— 借用 Phase 1 的可重入事务（SAVEPOINT 语义），
 * 因此各 repository 自身的事务不会冲突。
 */
export function commitImport(repos: Repositories, plan: { report: ImportReport; pending: PlannedEntry[] }): CommitResult {
  const writable = plan.pending.filter(
    (entry) => entry.paper !== null && entry.decision !== null && entry.decision.kind !== "unchanged",
  );

  if (writable.length === 0) {
    return { ok: true, report: plan.report, written: 0, error: null };
  }

  try {
    repos.transaction(() => {
      for (const entry of writable) {
        if (!entry.paper || !entry.decision) continue;
        const record = toRecord(entry.paper, new NormalizedPackageImporter(getPapersDir()), {
          relativePath: entry.report.packagePath,
        });
        repos.papers.saveImport({ record, assets: entry.paper.content.assets }, entry.decision);
      }
    });
    return { ok: true, report: plan.report, written: writable.length, error: null };
  } catch (error) {
    return {
      ok: false,
      report: plan.report,
      written: 0,
      error: `${(error as Error).message}（整批已回滚，数据库未发生任何改变）`,
    };
  }
}

/** 一步到位：校验 + 提交。dryRun 时只返回计划。 */
export function runImport(
  repos: Repositories,
  options: ImportOptions & { dryRun?: boolean } = {},
): CommitResult & { dryRun: boolean } {
  const plan = planImport(repos, options);
  if (options.dryRun) {
    return { ok: true, report: plan.report, written: 0, error: null, dryRun: true };
  }
  return { ...commitImport(repos, plan), dryRun: false };
}

export { paperTitle };
