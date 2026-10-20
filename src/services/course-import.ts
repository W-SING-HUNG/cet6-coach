import type { CourseImportDecision, CoursePackageRecord, Repositories } from "@/repositories/ports";
import type { CourseIssue, ValidatedCourse } from "@/content/course/types";
import { NormalizedCourseImporter, CourseManifestReadError } from "@/content/course/importer";
import { courseContentFingerprint } from "@/content/course/fingerprint";
import { getContentRoot, getCoursesDir } from "@/content/paper/paths";
import { CourseVersionConflictError } from "@/repositories/sqlite/courses";

/**
 * 课程包导入编排。
 *
 * 两阶段，与真题导入**刻意同构**（同一套可信模式，不另创一套）：
 *
 * 1. `planCourseImport` —— 发现、校验、判定后果。**零写入。** 这就是 dry-run。
 * 2. `commitCourseImport` —— 在**一个事务**内写入所有判定为 insert/update 的包。
 *
 * 为什么 dry-run 与真实导入必须共用同一段代码：若各写一套，预演就可能与真实
 * 结果不一致 —— 而"预演说没问题，真跑却写坏"正是用户无法信任导入的原因。
 *
 * ── 一条与真题导入**不同**的规则（本阶段的核心语义之一）──
 *
 * **课程包不要求任何段拥有 canonical 匹配。** 课程材料按题型重新归组，
 * 其中大量内容（方法说明、模板、讲解）本来就不与任何单道真题一一对应。
 * 因此"未匹配"不是警告、不是拒绝理由，而是**合法状态** ——
 * 本模块里不存在任何"未匹配比例过高则拒绝"的分支。
 * 若导入要求全匹配，课程层在原理上就不可用。
 *
 * ── 原子性 ──
 *
 * 整批一个事务。任一条目写入失败则整批回滚，绝不出现"导了 3 个包、
 * 第 4 个坏在中间"的半成品状态。借用既有的可重入事务（SAVEPOINT 语义），
 * 因此各 repository 自身的事务不会冲突。
 */

export interface CourseImportEntryReport {
  packagePath: string;
  courseId: string | null;
  title: string;
  decision: CourseImportDecision["kind"] | "rejected";
  detail: string;
  issues: CourseIssue[];
  warnings: string[];
  /** 该包的段数量 —— 用于如实报告"其中多少段没有 canonical 匹配"这一合法状态。 */
  segmentCount: number;
  /**
   * 被校验通过的 **manifest 序列化契约版本**；包被拒绝时为 null。
   *
   * 必须报告它，否则"这份文件是按哪一版契约读进来的"在导入后无从查证 ——
   * 而它与 `contentVersion`（语义内容版本）是两个不同的量。
   */
  manifestSchemaVersion: number | null;
}

export interface CourseImportReport {
  contentRoot: string;
  coursesDir: string;
  discovered: number;
  entries: CourseImportEntryReport[];
  counts: {
    insert: number;
    update: number;
    metadataOnly: number;
    unchanged: number;
    rejected: number;
  };
  /**
   * 课程层索引在当前库里是否**已激活**（`course_package` 表存在）。
   *
   * 为 `false` 表示这是一个 v8 库：课程层表尚未创建，因此索引**必然为空**。
   * 预演必须如实报告这一点 —— 否则操作者会以为"预演说新增 3 份、库里却有 0 份"
   * 是系统算错了，而真相是"课程层还没被激活"。
   *
   * 它**不**代表任何 v9 状态被伪造：未激活 ⇔ 不存在任何合法的课程层行。
   */
  courseIndexActivated: boolean;
}

export interface CourseImportOptions {
  /** 只导入指定的包目录名。为空则处理全部。 */
  only?: string[];
}

interface PlannedCourseEntry {
  report: CourseImportEntryReport;
  course: ValidatedCourse | null;
  decision: CourseImportDecision | null;
}

function toRecord(course: ValidatedCourse): Omit<CoursePackageRecord, "importedAt" | "updatedAt"> {
  const content = course.content;
  const segments = content.segments;
  return {
    id: content.id,
    provider: content.provider,
    edition: content.edition,
    title: content.title,
    contentVersion: content.contentVersion,
    provenance: content.provenance,
    packagePath: course.packageRelativePath,
    manifestChecksum: course.checksum,
    // 判"内容是否变了"用它，不用整包校验和 ——
    // 后者会把 rightsNote 这类声明变更也当成内容变化（见 fingerprint.ts）。
    contentFingerprint: courseContentFingerprint(content),
    materialCount: content.materials.length,
    segmentCount: segments.length,
    assetCount: content.assets.length,
    assetBytes: content.assets.reduce((sum, asset) => sum + asset.bytes, 0),
  };
}

/** 校验 + 判定。**纯读取**，可在任何时刻安全执行。 */
export function planCourseImport(
  repos: Repositories,
  options: CourseImportOptions = {},
): { report: CourseImportReport; pending: PlannedCourseEntry[] } {
  const coursesDir = getCoursesDir();
  const importer = new NormalizedCourseImporter(coursesDir);
  const only = options.only && options.only.length > 0 ? new Set(options.only) : null;

  const handles = importer.discover().filter((handle) => !only || only.has(handle.relativePath));
  const pending: PlannedCourseEntry[] = [];

  // 批内 id 去重。
  //
  // 为什么必须在计划阶段处理（与真题导入同一条理由）：两份不同的目录装同一个
  // 课程包（用户把同一个包复制成了 `rsvp-2026h2` 与 `rsvp-2026h2-backup`）时，
  // 两条都会判定为 insert，第二条会在写路径上撞主键、把**整批**回滚 ——
  // 用户看到的是一句 SQLite 约束错误，而不是"这两个目录是同一个包"。
  const seenIds = new Map<string, string>();

  for (const handle of handles) {
    let course: ValidatedCourse;
    try {
      course = importer.validate(handle);
    } catch (error) {
      const issues =
        error instanceof CourseManifestReadError
          ? error.issues
          : [{ path: "<course>", message: (error as Error).message }];
      pending.push({
        report: {
          packagePath: handle.relativePath,
          courseId: null,
          title: handle.relativePath,
          decision: "rejected",
          detail: "校验未通过，未写入任何数据",
          issues,
          warnings: [],
          segmentCount: 0,
          manifestSchemaVersion: null,
        },
        course: null,
        decision: null,
      });
      continue;
    }

    const record = toRecord(course);
    const earlier = seenIds.get(record.id);
    if (earlier) {
      pending.push({
        report: {
          packagePath: handle.relativePath,
          courseId: record.id,
          title: record.title,
          decision: "rejected",
          detail: "与同一批中的另一个包是同一个课程 id，未写入",
          issues: [
            {
              path: "id",
              message:
                `与 ${earlier} 的课程 id 重复（${record.id}）。` +
                `同一个课程包只应有一条索引 —— 若是被复制成了两份，删除多余的那份。`,
            },
          ],
          warnings: [],
          segmentCount: record.segmentCount,
          manifestSchemaVersion: course.content.schemaVersion,
        },
        course: null,
        decision: null,
      });
      continue;
    }
    seenIds.set(record.id, handle.relativePath);

    try {
      const decision = repos.courses.decideImport({ ...record, importedAt: "", updatedAt: "" });
      pending.push({
        report: {
          packagePath: handle.relativePath,
          courseId: record.id,
          title: record.title,
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
          warnings: course.warnings,
          segmentCount: record.segmentCount,
          manifestSchemaVersion: course.content.schemaVersion,
        },
        course,
        decision,
      });
    } catch (error) {
      const isConflict = error instanceof CourseVersionConflictError;
      pending.push({
        report: {
          packagePath: handle.relativePath,
          courseId: record.id,
          title: record.title,
          decision: "rejected",
          detail: isConflict ? "与库中版本冲突，未写入" : "无法判定导入后果，未写入",
          issues: [{ path: "contentVersion", message: (error as Error).message }],
          warnings: [],
          segmentCount: record.segmentCount,
          manifestSchemaVersion: course.content.schemaVersion,
        },
        course,
        decision: null,
      });
    }
  }

  return {
    report: buildCourseReport(coursesDir, handles.length, pending, repos.courses.isActivated()),
    pending,
  };
}

function buildCourseReport(
  coursesDir: string,
  discovered: number,
  pending: PlannedCourseEntry[],
  courseIndexActivated: boolean,
): CourseImportReport {
  const counts = { insert: 0, update: 0, metadataOnly: 0, unchanged: 0, rejected: 0 };
  for (const entry of pending) {
    const decision = entry.report.decision;
    if (decision === "insert") counts.insert += 1;
    else if (decision === "update") counts.update += 1;
    else if (decision === "metadata_only") counts.metadataOnly += 1;
    else if (decision === "unchanged") counts.unchanged += 1;
    else if (decision === "rejected") counts.rejected += 1;
  }
  return {
    contentRoot: getContentRoot(),
    coursesDir,
    discovered,
    entries: pending.map((entry) => entry.report),
    counts,
    courseIndexActivated,
  };
}

export interface CourseCommitResult {
  ok: boolean;
  report: CourseImportReport;
  /** 实际写入的课程包数量 */
  written: number;
  /** 写入失败时的原因（整批已回滚，库状态未变） */
  error: string | null;
}

/**
 * 提交导入。只写判定为 insert / update / metadata_only 的条目；
 * `unchanged` 不写（避免无意义的更新），`rejected` 从不进入写路径。
 */
export function commitCourseImport(
  repos: Repositories,
  plan: { report: CourseImportReport; pending: PlannedCourseEntry[] },
): CourseCommitResult {
  const writable = plan.pending.filter(
    (entry) => entry.course !== null && entry.decision !== null && entry.decision.kind !== "unchanged",
  );

  if (writable.length === 0) {
    return { ok: true, report: plan.report, written: 0, error: null };
  }

  try {
    repos.transaction(() => {
      for (const entry of writable) {
        if (!entry.course || !entry.decision) continue;
        const record = toRecord(entry.course);
        repos.courses.saveImport({ record, assets: entry.course.content.assets }, entry.decision);
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
export function runCourseImport(
  repos: Repositories,
  options: CourseImportOptions & { dryRun?: boolean } = {},
): CourseCommitResult & { dryRun: boolean } {
  const plan = planCourseImport(repos, options);
  if (options.dryRun) {
    return { ok: true, report: plan.report, written: 0, error: null, dryRun: true };
  }
  return { ...commitCourseImport(repos, plan), dryRun: false };
}
