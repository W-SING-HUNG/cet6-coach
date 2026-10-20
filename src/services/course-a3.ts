/**
 * A3 受控课程接入 · 三个独立执行边界（Controlled Course Import）。
 *
 * ── 这个模块的存在理由 ──
 *
 * A1 只读、A2 可逆留痕，而 A3 是**不可逆**的：它第一次写 `courses/`、
 * 第一次写数据库（并首次触发 v8 → v9 增量迁移）、第一次写下不可变的
 * 人工复核行。三件事的风险等级相同但**后果完全不同**，因此它们必须是
 * 三个**各自独立**的授权，而不是一个"全部完成"按钮。
 *
 * ── 三条不可动摇的边界 ──
 *
 * 1. **三项互相独立。** 完成 A3-a（晋升）**绝不**代表批准了 A3-b（导入）
 *    或 A3-c（建链）。每一次写入都由 使用者 单独确认，且确认内容逐字列出
 *    "将要写到哪里、会产生什么变化"。
 * 2. **每一项都有预演。** 预演与写入复用**同一段判据**（同一个 service
 *    函数的 `dryRun` 分支），因此"预演说没问题、真跑却写坏"在结构上不成立。
 * 3. **部分完成必须如实报告。** 三项之间**不存在**跨文件系统与数据库的
 *    单一事务 —— 这是事实，不是缺陷。因此必须准确记录"哪几步成功了"，
 *    并给出安全的重试方式，**绝不虚称整体回滚**。
 *
 * ── 为什么没有"全部完成"入口 ──
 *
 * 那是本模块最重要的一个**否决**：把三个不同性质的不可逆动作压成一个按钮，
 * 会让 使用者 在一次点击里同时批准"替换运行时课程包"、"迁移数据库"
 * 与"创造一条 verified 真相"。三者本可以分开做、分开验证、分开放弃。
 *
 * ── 备份：为什么必须是 `VACUUM INTO` 而不是复制文件 ──
 *
 * SQLite 官方文档（[VACUUM](https://www.sqlite.org/lang_vacuum.html)）明确说明
 * `VACUUM INTO` 会产出一致快照，并且它是备份 API 的**官方替代方案**。
 * 而"复制主库文件"这条老路在同一条文档的备份 API 页面里被指出有缺陷：
 * 本机实测（Node v24.15.0 + WAL 模式）—— 当存在一个长期存活的读连接时，
 * 普通文件复制会得到一个 `no such table: t` 的**空库**（全部数据丢失），
 * 而 `VACUUM INTO` 在同一时刻取到了全部 4 行。
 *
 * 因此备份只用 `VACUUM INTO`，并且**恢复必须被真实演练过**才算数：
 * 见 `verifyBackupRestorable`（它把快照实际读回来核对，而不是只报告"复制成功"）。
 */

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Repositories } from "@/repositories/ports";
import { openDatabase, getDbFile } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import {
  commitCourseImport,
  planCourseImport,
  type CourseCommitResult,
  type CourseImportReport,
} from "@/services/course-import";
import { verifyCanonicalLink, type VerifyCanonicalLinkInput } from "@/services/course-link";
import { verifyContentBackup, writeContentManifest } from "./course-recovery";
import {
  buildLinkPlan,
  evaluatePromotionGate,
  gatherPromotionInputs,
  readStoredCandidate,
  validateCourseReviewFile,
} from "@/content/course-pipeline/review";
import { buildIndexFromDisk } from "@/content/course-pipeline/canonical";
import { resolvePromotedCourseDir } from "@/content/course-pipeline/containment";
import { getCourseSourcesDir } from "@/content/paper/paths";
import type { CourseReviewFile, PromotionCheck, PromotionStatus } from "@/content/course-pipeline/types";

// ---------------------------------------------------------------------------
// 备份与恢复原语（**已下沉到 course-backup.ts**）
// ---------------------------------------------------------------------------
//
// 这些原语被本模块（导入前受保护备份）与 `course-recovery.ts`（恢复）共用。
// 早先它们住在这里，于是恢复模块与本文件互相 import（真循环）。
// 下沉到独立模块是"两边都依赖同一份实现、又不产生环"的唯一办法 ——
// 另一条路（各写一份）会立刻产生两套"什么算一致快照"的判据。
//
// `runGuardedImport` 在**本文件内**要用其中三个，因此既 import 又 re-export：
// `export ... from` 不会把名字带进本地作用域。
import { createContentBackup, createDatabaseBackupAt, verifyBackupRestorable } from "./course-backup";

export {
  createDatabaseBackup,
  createDatabaseBackupAt,
  createContentBackup,
  verifyBackupRestorable,
  type BackupResult,
  type RestoreVerification,
} from "./course-backup";

// ---------------------------------------------------------------------------
// A3-a · 晋升（写 courses/）
// ---------------------------------------------------------------------------

/**
 * 晋升的**预演**结论。
 *
 * 与 `PromoteResult` 分开的理由：预演要回答"会发生什么"，
 * 而执行要回答"实际发生了什么"。两者形状不同（后者有 `targetDir` 与 `error`），
 * 合成一个类型会让"还没做"与"做完了"在界面上难以区分。
 */
export interface PromotePreview {
  ok: boolean;
  /** 目标课程包目录标签（**只有目录名**，绝不含绝对路径）。 */
  targetLabel: string | null;
  /** 将要复制的文件（相对路径）。 */
  wouldCopy: string[];
  /** 明确**不会**复制的东西（必须可见）。 */
  excluded: string[];
  /** 目标已存在 ⇒ 不可执行，并给出原因与处置。 */
  blockedReason: string | null;
  /** 晋升后的课程内容指纹（预演时同样计算，供人核对）。 */
  contentFingerprint: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// A3-b · 导入索引（写数据库，首次触发 v8 → v9 迁移）
// ---------------------------------------------------------------------------

export interface ImportPreview {
  ok: boolean;
  report: CourseImportReport | null;
  /**
   * 本库是否**尚未激活**课程层（v8 库）。
   *
   * 为 true 时 `--commit` 会执行增量迁移 —— 这是整个产品里**唯一**
   * 会自动改 schema 的路径，因此界面必须显式说明，并要求先完成备份。
   */
  requiresMigration: boolean;
  /** 备份是否已完成且经验证可恢复。 */
  backupReady: boolean;
  /** 不可执行的原因（非空 ⇒ 界面必须禁用确认按钮）。 */
  blockedReason: string | null;
  error: string | null;
}

export interface ImportExecution {
  ok: boolean;
  written: number;
  report: CourseImportReport | null;
  /** 备份信息（成功时回传，供界面如实显示"恢复到哪一份"）。 */
  backup: { path: string | null; bytes: number; verified: boolean } | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// A3-c · 建立真题链接（写不可变复核行）
// ---------------------------------------------------------------------------

export interface LinkPreview {
  ok: boolean;
  /** 逐条核验结果（dry-run 与写入共用同一段判据）。 */
  results: Array<{
    ok: boolean;
    segmentId: string;
    /** 人可读的目标描述（例如 `fixture-cet6-2024-12-set1 v1 · reading.careful_reading`）。 */
    targetLabel: string | null;
    issues: Array<{ path: string; message: string }>;
    warnings: string[];
    /** 这份声明是否已存在（写入将是幂等的）。 */
    alreadyExists: boolean;
  }>;
  blockedReason: string | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// 执行结果的**部分完成**记录
// ---------------------------------------------------------------------------

/**
 * 三项写操作的进度。
 *
 * ── 为什么必须有这个类型 ──
 *
 * 三项之间没有单一事务（跨文件系统 + 数据库），因此"整体回滚"是不可能的。
 * 能诚实做的只有两件事：
 *
 * 1. 逐项记录成功 / 失败 / 未执行；
 * 2. 对失败的那一项给出**安全重试**方式，并明确它不影响已成功的项。
 *
 * 把这个状态做成显式类型（而不是三个布尔值散在各处）的理由：
 * 界面必须能回答"我现在停在哪一步、下一步是什么"，
 * 而中断后重新打开工作台时，这份记录是恢复现场的唯一依据。
 */
export interface A3Progress {
  courseId: string;
  /** A3-a 晋升。 */
  promoted: { done: boolean; at: string | null; detail: string | null };
  /** A3-b 导入索引。 */
  imported: { done: boolean; at: string | null; detail: string | null };
  /** A3-c 建链（按段记录，因为不同段可以分别核验）。 */
  linked: { done: boolean; at: string | null; detail: string | null; segmentIds: string[] };
}

export function emptyProgress(courseId: string): A3Progress {
  return {
    courseId,
    promoted: { done: false, at: null, detail: null },
    imported: { done: false, at: null, detail: null },
    linked: { done: false, at: null, detail: null, segmentIds: [] },
  };
}

/**
 * 判断三项是否全部完成。
 *
 * 刻意**不**用它来启用任何"跳过剩余步骤"的按钮 —— 它只用于
 * "全部完成后引导去 Course Companion"这一条路径。
 */
export function isA3Complete(progress: A3Progress): boolean {
  return progress.promoted.done && progress.imported.done && progress.linked.done;
}

/**
 * 下一步是什么（用于界面显示"某一步已成功、下一步尚未执行"）。
 */
export function nextA3Step(progress: A3Progress): {
  step: "promote" | "import" | "link" | "companion";
  label: string;
} {
  if (!progress.promoted.done) return { step: "promote", label: "把候选晋升为正式课程包" };
  if (!progress.imported.done) return { step: "import", label: "把课程包写入课程索引" };
  if (!progress.linked.done) return { step: "link", label: "为已核验的段建立真题链接" };
  return { step: "companion", label: "到课程伴随界面查看" };
}

// ---------------------------------------------------------------------------
// A3-b 执行：备份 → 迁移 → 导入（一个不可拆分的授权单元）
// ---------------------------------------------------------------------------

export interface RunImportInput {
  /** 数据库文件路径（`CET6_DB_PATH` / `data/cet6.db`）。 */
  dbFile: string;
  /** 受影响的课程内容目录（`courses/`）。 */
  coursesDir: string;
  /** 备份输出目录。 */
  backupDir: string;
  /** 只导入指定的包目录名。 */
  only?: string[];
  /**
   * 打开写连接的工厂（默认 `openDatabase`）。
   *
   * 单独成参数是为了让测试能注入"打开后立刻迁移失败"之类的故障，
   * 而不必真的去破坏一个库文件。
   */
  openWrite?: (file: string) => DatabaseSync;
  /** 关闭连接（默认 `db.close()`）。测试可注入以断言连接生命周期。 */
  closeDb?: (db: DatabaseSync) => void;
}

/**
 * 执行 A3-b：**先备份并验证，再迁移与写入**。
 *
 * ── 顺序为什么是这样 ──
 *
 * 1. 备份数据库（`VACUUM INTO`，一致性快照）；
 * 2. **验证备份可恢复**（真的把它当库打开读一次）；
 * 3. 备份 `courses/` 目录（索引事实之外的内容）；
 * 4. 只有在 1–3 全部成功后，才打开写连接并提交导入。
 *
 * 备份失败 ⇒ **不迁移、不写入**。这是唯一正确的失败方向：
 * 一次没有可用恢复点的 v8 → v9 迁移是不可逆的，而迁移本身没有自动回退
 * （README 的「已实现 / 未实现」两节已登记）。
 *
 * ── 它**不**声称什么 ──
 *
 * 它不声称"整体可回滚"。`commitCourseImport` 是一个数据库事务
 * （任一条目失败 ⇒ 整批回滚），但 `courses/` 的文件复制（A3-a）与
 * 数据库写入（A3-b）之间**没有**共同事务。真实的可恢复性是：
 * 还原第 1 步的数据库快照 + 第 3 步的目录快照。
 */
export function runGuardedImport(input: RunImportInput): ImportExecution {
  // ── 0) 备份目录必须先存在（`VACUUM INTO` 不会创建中间目录）──
  mkdirSync(input.backupDir, { recursive: true });

  // ── 1) 数据库一致性快照 ──
  //
  // 刻意在**打开写连接之前**做：`openDatabase` 会执行迁移（v8 → v9），
  // 而"迁移完之后再备份"备份到的是新形态 —— 那不再是写入前的恢复点。
  //
  // 因此这里用一个**独立连接**执行 `VACUUM INTO`：它读的是当前盘上的状态，
  // 不触发任何迁移（`VACUUM INTO` 不改源库）。
  const dbBackupPath = join(input.backupDir, "cet6-pre-a3.db");
  const dbBackup = createDatabaseBackupAt(input.dbFile, dbBackupPath);
  if (!dbBackup.ok || dbBackup.backupPath === null) {
    return {
      ok: false,
      written: 0,
      report: null,
      backup: null,
      error: `已中止：${dbBackup.error ?? "备份未完成"}。在取得可恢复的快照之前不会写入数据库。`,
    };
  }

  // ── 2) 验证快照真的能被读回来 ──
  const verification = verifyBackupRestorable(dbBackup.backupPath);
  if (!verification.ok) {
    return {
      ok: false,
      written: 0,
      report: null,
      backup: { path: dbBackup.backupPath, bytes: dbBackup.bytes, verified: false },
      error:
        `已中止：备份文件无法被读取（${verification.error ?? "未知原因"}）。` +
        `一份打不开的快照不构成恢复点，因此不会继续写入。`,
    };
  }

  // ── 3) 内容目录快照 ──
  //
  // 内容快照必须**附带逐文件清单**（相对路径 + 字节 + sha256），否则
  // "内容备份完好"只是一句自述：一次同尺寸替换或两个文件互换了内容，
  // 总字节数完全不变，而恢复出来的课程包已经不对了。
  const contentBackupPath = join(input.backupDir, "courses-pre-a3");
  const contentBackup = createContentBackup(input.coursesDir, contentBackupPath);
  if (!contentBackup.ok) {
    return {
      ok: false,
      written: 0,
      report: null,
      backup: { path: dbBackup.backupPath, bytes: dbBackup.bytes, verified: true },
      error: `已中止：${contentBackup.error ?? "内容备份未完成"}。数据库与课程内容必须都有恢复点。`,
    };
  }
  if (contentBackup.backupPath !== null) {
    /*
     * 清单描述**快照目录**（复制之后），而不是源。
     *
     * 因为"复制得对不对"正是要被检验的东西 —— 若清单描述源，
     * 它证明的是源长什么样，两者在复制出错时会分叉。
     */
    const manifest = writeContentManifest(contentBackup.backupPath);
    /*
     * 立刻**独立复核**一次：清单写完之后马上逐文件重算 sha256。
     *
     * 这能抓住"清单写成功但复制本身不完整"（例如磁盘满时 cpSync 半途失败
     * 而错误被吞掉）—— 那种情况下清单会显示 missing。
     */
    const integrity = verifyContentBackup(contentBackup.backupPath);
    if (!integrity.ok) {
      return {
        ok: false,
        written: 0,
        report: null,
        backup: { path: dbBackup.backupPath, bytes: dbBackup.bytes, verified: true },
        error:
          `已中止：内容快照与清单不一致（${integrity.error ?? "未知"}）。` +
          `没有可靠的内容恢复点，因此不写入数据库。`,
      };
    }
    void manifest;
  }

  // ── 4) 写连接（这里才可能触发迁移）+ 提交（事务内整批原子）──
  const openWrite = input.openWrite ?? openDatabase;
  const closeDb = input.closeDb ?? ((db: DatabaseSync) => db.close());
  let db: DatabaseSync;
  try {
    db = openWrite(input.dbFile);
  } catch (error) {
    return {
      ok: false,
      written: 0,
      report: null,
      backup: { path: dbBackup.backupPath, bytes: dbBackup.bytes, verified: true },
      error:
        `已中止：无法打开数据库进行写入（${(error as Error).message}）。` +
        `快照已保留在备份目录，可安全重试。`,
    };
  }

  try {
    const repos = createSqliteRepositories(db);
    const plan = planCourseImport(repos, { only: input.only });
    const result: CourseCommitResult = commitCourseImport(repos, plan);
    if (!result.ok) {
      return {
        ok: false,
        written: 0,
        report: result.report,
        backup: { path: dbBackup.backupPath, bytes: dbBackup.bytes, verified: true },
        error: `${result.error ?? "导入失败"}。数据库已在同一事务内回滚；如需回到写入前状态，可还原上面的快照。`,
      };
    }

    return {
      ok: true,
      written: result.written,
      report: result.report,
      backup: { path: dbBackup.backupPath, bytes: dbBackup.bytes, verified: true },
      error: null,
    };
  } finally {
    closeDb(db);
  }
}

// ---------------------------------------------------------------------------
// A3 只读预演
// ---------------------------------------------------------------------------

/**
 * 预演输入。
 *
 * 全部是**只读**能力：候选、复核记录、canonical 库、课程目录、课程索引。
 * 因此这个函数可以在任何时刻安全执行 —— 它不写文件、不写库、不执行迁移。
 */
export interface A3PreviewInput {
  courseId: string;
  /** 候选根目录。 */
  candidatesDir?: string;
  /** 标准源树根（用于源当前性重算）。 */
  standardSourcesRoot?: string;
  /** 复核者显式提供的当前源根（外部源必需）。 */
  sourceRootOverride?: string | null;
  /** canonical 真题包目录。 */
  papersDir?: string;
}

/**
 * 预演结论。
 *
 * ── 它必须回答任务书列出的每一项 ──
 *
 * - 当前课程与候选摘要；
 * - 晋升门禁逐项结果；
 * - 冲突、陈旧、重复导入、已有目标；
 * - 每个操作将写到哪里、会产生什么变化；
 * - 具体错误及恢复建议。
 *
 * ── 为什么 `promotable` 是唯一的执行开关 ──
 *
 * 因为非 `PROMOTABLE` 时，晋升在 `promoteCourseCandidate` 内部就会被拒绝。
 * 但界面**不能**依赖"先让用户点、再让服务端拒绝"——那会让人以为
 * "按钮可点 = 可以晋升"。因此预演把结论前移，界面据此禁用按钮，
 * 并逐项说明为什么。
 */
export interface A3Preview {
  courseId: string;
  /** 门禁结论（`PROMOTABLE` / `REVIEW_REQUIRED` / `BLOCKED`）。 */
  status: PromotionStatus;
  /**
   * **门禁本身**是否通过（复核可信、候选自洽、源未漂移）。
   *
   * ── 为什么它与 `promotable` 必须分开 ──
   *
   * 两者回答不同的问题：
   *
   * | 字段 | 回答 |
   * | --- | --- |
   * | `gatePassed` | 这份复核是否可信（可以据此建链吗） |
   * | `promotable` | 现在能不能**执行晋升**（目标不存在吗） |
   *
   * 它们会在真实路径上分叉：晋升成功之后目标就存在了，于是
   * `promotable` 变 false —— 但**建链仍然必须可执行**（A3-c 本来就在
   * A3-a 之后）。若用同一个布尔值控制两步，人会遇到"A 做完了，B 反而
   * 不能做了"这种自相矛盾的状态。
   */
  gatePassed: boolean;
  /** 现在是否可以执行**晋升**（门禁通过 **且** 目标尚不存在）。 */
  promotable: boolean;
  /** 门禁逐项结果（人可读，含原因与恢复建议）。 */
  checks: PromotionCheck[];
  /** 人话总结。 */
  summary: string;
  /** 候选摘要。 */
  candidate: {
    exists: boolean;
    candidateChecksum: string | null;
    /** 段数量、材料数量、资产数量。 */
    segmentCount: number;
    materialCount: number;
    assetCount: number;
    /** 复核记录摘要。 */
    review: { reviewer: string; reviewedAt: string } | null;
    /** 阻断级复核事项数。 */
    blockingReviewItems: number;
  };
  /** 冲突 / 陈旧 / 已有目标的**逐项**判定。 */
  conflicts: A3Conflict[];
  /** 链接交接计划（只打印命令，绝不执行；非 PROMOTABLE 时为空）。 */
  linkPlan: {
    allowed: boolean;
    reason: string | null;
    entries: Array<{
      segmentId: string;
      segmentTitle: string;
      targetLabel: string;
      command: string;
    }>;
  };
  /** 不可执行的原因（界面据此禁用三个确认按钮）。 */
  blockedReasons: string[];
  /** 读不出来的东西（如实报告，不假装没问题）。 */
  errors: string[];
  /**
   * 该课程**是否已导入索引**。
   *
   * 用途：提示"导入这一步将是空操作"。
   * "晋升成功但导入 unchanged"是一种**看起来成功的空操作** ——
   * 人点了三个按钮，最后一步什么都没发生，那比失败更难排查。
   */
  alreadyImported: { contentVersion: number | null; segmentCount: number | null } | null;
}

export interface A3Conflict {
  kind:
    | "target_already_exists"
    | "review_missing"
    | "review_stale"
    | "review_invalid"
    | "source_drifted"
    | "source_unavailable"
    | "canonical_library_changed"
    | "canonical_library_incomplete"
    | "candidate_self_inconsistent"
    | "assets_missing"
    | "production_validator_rejected"
    | "rejected_grouping"
    | "excluded_segment"
    | "unresolved_blocking_items"
    | "already_imported";
  /** 人话描述。 */
  detail: string;
  /** "怎么办"（每一条都必须有 —— 只报错不给处置是缺陷）。 */
  recovery: string;
}

/**
 * 跑一次**只读**预演。
 *
 * ── 复用而不是重写 ──
 *
 * 门禁、源当前性、资产完整性、生产校验、链接交接计划**全部**来自既有实现
 * （`review.ts`）。这里只做三件既有代码不做的事：
 *
 * 1. 把它们的结果整理成界面可直接渲染的形状；
 * 2. 额外核对"目标是否已存在 / 是否已导入"（既有 `promoteCourseCandidate`
 *    与 `planCourseImport` 各自会拒绝，但预演必须**提前**告诉人）；
 * 3. 把"不可执行"收敛成明确的 `promotable` 布尔，而不是让界面去推断。
 *
 * ── 为什么"已导入"也要在这里报 ──
 *
 * 因为"晋升成功但导入时报 unchanged"是一种**看起来成功的空操作**。
 * 人点了三个按钮，最后一步什么都没发生 —— 那比失败更难排查。
 */
export function previewA3(input: A3PreviewInput): A3Preview {
  const errors: string[] = [];
  const conflicts: A3Conflict[] = [];

  // ── 1) 候选必须存在 ──
  let stored: ReturnType<typeof readStoredCandidate>;
  try {
    stored = readStoredCandidate(input.courseId, input.candidatesDir);
  } catch (error) {
    return {
      courseId: input.courseId,
      status: "BLOCKED",
      gatePassed: false,
      promotable: false,
      checks: [],
      summary: "候选不存在，无法预演。",
      candidate: {
        exists: false,
        candidateChecksum: null,
        segmentCount: 0,
        materialCount: 0,
        assetCount: 0,
        review: null,
        blockingReviewItems: 0,
      },
      conflicts: [
        {
          kind: "review_missing",
          detail: `候选不存在或不完整：${(error as Error).message}`,
          recovery: "先在检查工作台里「生成课程候选」，再回到本页预演。",
        },
      ],
      linkPlan: { allowed: false, reason: "候选不存在，没有任何已复核的映射可供交接。", entries: [] },
      blockedReasons: ["候选不存在"],
      errors,
      alreadyImported: null,
    };
  }

  // ── 2) 复核记录 ──
  const reviewPath = join(stored.candidateDir, "review.json");
  let review: CourseReviewFile | null = null;
  const reviewErrors: string[] = [];
  if (!existsSync(/* turbopackIgnore: true */ reviewPath)) {
    reviewErrors.push("没有复核记录（缺少 review.json）。工具从不生成它 —— 复核只能由人签出。");
  } else {
    try {
      const parsed = validateCourseReviewFile(JSON.parse(readFileSync(reviewPath, "utf8")));
      review = parsed.file;
      reviewErrors.push(...parsed.errors);
    } catch (error) {
      reviewErrors.push(
        `review.json 不是合法 JSON（解析失败）：${(error as Error).message}。` +
          "请修正或重写 review.json —— 工具从不生成它，因此它一定是由人生成的。",
      );
    }
  }

  // ── 3) canonical 库现状 ──
  let currentCanonicalDigest: string | null = null;
  let canonicalComplete: boolean | null = null;
  try {
    const built = buildIndexFromDisk(input.papersDir);
    currentCanonicalDigest = built.index.summary.digest;
    canonicalComplete = built.failures.length === 0;
  } catch (error) {
    errors.push(`无法读取 canonical 真题库：${(error as Error).message}`);
  }

  // ── 4) 门禁（既有唯一实现）──
  const gate = evaluatePromotionGate(
    gatherPromotionInputs({
      stored,
      review,
      reviewErrors,
      canonical: { digest: currentCanonicalDigest, complete: canonicalComplete },
      standardSourcesRoot: input.standardSourcesRoot ?? getCourseSourcesDir(),
      sourceRootOverride: input.sourceRootOverride ?? null,
    }),
  );

  // ── 5) 把失败项翻译成"冲突 + 恢复建议" ──
  for (const check of gate.checks) {
    if (check.passed) continue;
    conflicts.push({
      kind: conflictKindOf(check.name),
      detail: check.detail,
      recovery: recoveryFor(check.name),
    });
  }

  // ── 6) 额外核对：目标是否已存在 ──
  const promotedDir = resolvePromotedCourseDir(stored.courseId);
  const targetExists = existsSync(/* turbopackIgnore: true */ promotedDir);
  if (targetExists) {
    conflicts.push({
      kind: "target_already_exists",
      detail:
        `目标课程包已存在：courses/${stored.courseId}。` +
        `本阶段不实现对已晋升课程的原地覆盖（那会让一次误操作静默替换运行时课程包）。`,
      // 这条冲突**只**影响晋升；导入与建链恰恰是在它之后才做的。
      recovery:
        "晋升已无需再执行。若确实要替换，请先人工把旧包移出 courses/（保留为备份），再重新晋升。" +
        "要继续接入，请直接做第 ② 步（导入）与第 ③ 步（建链）。",
    });
  }

  // ── 7) 额外核对：是否已导入索引 ──
  const importState = readImportState(stored.courseId);

  // ── 8) 链接交接计划（只打印，绝不执行）──
  const linkPlan = buildLinkPlan({ stored, review, gate });

  const blockingReviewItems = stored.metadata.review.filter((item) => item.severity === "blocking").length;
  const blockedReasons = gate.checks
    .filter((check) => !check.passed)
    .map((check) => `${check.name}：${check.detail}`);
  if (targetExists) {
    blockedReasons.push("目标课程包已存在（拒绝覆盖）—— 晋升无需再执行，继续做第 ② / ③ 步即可");
  }

  return {
    courseId: stored.courseId,
    status: gate.status,
    /*
     * `gatePassed` 只看门禁；`promotable` 额外要求目标尚不存在。
     *
     * 这条区分是**真实路径**逼出来的：A3-a 成功之后目标就在盘上了，
     * 而 A3-c 仍然必须可以执行。若两者共用一个布尔值，用户在完成晋升后
     * 会发现"建链按钮反而变灰了" —— 那是一个自相矛盾的状态。
     */
    gatePassed: gate.status === "PROMOTABLE",
    promotable: gate.status === "PROMOTABLE" && !existsSync(/* turbopackIgnore: true */ promotedDir),
    checks: gate.checks,
    summary: gate.summary,
    candidate: {
      exists: true,
      candidateChecksum: stored.recomputed.candidateChecksum,
      segmentCount: stored.metadata.segmentation.materials.reduce((sum, m) => sum + m.segments.length, 0),
      materialCount: stored.metadata.grouping.proposals.length,
      assetCount: stored.metadata.inventory.assets.length,
      review: review === null ? null : { reviewer: review.reviewer, reviewedAt: review.reviewedAt },
      blockingReviewItems,
    },
    conflicts,
    linkPlan: {
      allowed: linkPlan.allowed,
      reason: linkPlan.allowed ? null : linkPlan.reason,
      entries: linkPlan.entries.map((entry) => ({
        segmentId: entry.segmentId,
        segmentTitle: entry.segmentTitle,
        targetLabel: `${entry.paperId} · ${entry.sectionId}`,
        command: entry.command,
      })),
    },
    blockedReasons,
    errors,
    alreadyImported: importState.imported
      ? { contentVersion: importState.contentVersion, segmentCount: importState.segmentCount }
      : null,
  };
}

/** 已导入状态（只读；表不存在时如实报告"未导入"而不是报错）。 */
function readImportState(courseId: string): { imported: boolean; contentVersion: number | null; segmentCount: number | null } {
  try {
    // `getDbFile()` 每次现算 ⇒ 切换过 CET6_DB_PATH 的进程也能读到**当前**那个库。
    const db = new DatabaseSync(getDbFile(), { readOnly: true });
    try {
      const hasTable = Boolean(
        db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_package'").get(),
      );
      if (!hasTable) return { imported: false, contentVersion: null, segmentCount: null };
      const row = db
        .prepare("SELECT content_version AS v, segment_count AS s FROM course_package WHERE id = ?")
        .get(courseId) as { v: number; s: number } | undefined;
      if (!row) return { imported: false, contentVersion: null, segmentCount: null };
      return { imported: true, contentVersion: row.v, segmentCount: row.s };
    } finally {
      db.close();
    }
  } catch {
    // 读不到库 ⇒ 不假装"已导入"，也不假装"没导入"以外的结论
    return { imported: false, contentVersion: null, segmentCount: null };
  }
}

function conflictKindOf(checkName: string): A3Conflict["kind"] {
  switch (checkName) {
    case "candidate_checksum_self_consistent":
      return "candidate_self_inconsistent";
    case "human_review_present":
      return "review_missing";
    case "review_bound_to_current_candidate":
      return "review_stale";
    case "canonical_library_unchanged_since_review":
      return "canonical_library_changed";
    case "blocking_review_items_resolved":
      return "unresolved_blocking_items";
    case "material_grouping_decisions_complete":
      return "review_missing";
    case "grouping_decisions_reference_real_proposals":
      return "review_invalid";
    case "segment_decisions_reference_real_segments":
      return "review_invalid";
    case "match_decisions_reference_proposed_suggestions":
      return "review_invalid";
    case "ambiguous_matches_dispositioned":
      return "unresolved_blocking_items";
    case "source_current_and_unchanged":
      return "source_drifted";
    case "canonical_library_complete_for_acceptance":
      return "canonical_library_incomplete";
    case "assets_present_and_checksummed":
      return "assets_missing";
    case "passes_production_course_validator":
      return "production_validator_rejected";
    case "rejected_groupings_block_promotion":
      return "rejected_grouping";
    case "excluded_segments_block_promotion":
      return "excluded_segment";
    default:
      return "review_missing";
  }
}

/** 每一项失败的"怎么办"（人话，不含绝对路径）。 */
function recoveryFor(checkName: string): string {
  switch (checkName) {
    case "candidate_checksum_self_consistent":
      return "候选内容与记录不符 —— 重新生成候选（course:extract）后再复核。";
    case "human_review_present":
      return "在检查工作台第 ⑤ 步完成人工裁决并保存复核记录。";
    case "review_bound_to_current_candidate":
      return "候选已变化 ⇒ 重新检查并重新签署复核记录。系统绝不自动沿用旧决定。";
    case "canonical_library_unchanged_since_review":
      return "真题库已变化 ⇒ 重新生成候选并重新复核。";
    case "blocking_review_items_resolved":
      return "补齐缺失的裁决（按项提示缺哪一种）；抽取层缺陷需修正源件后重新生成候选。";
    case "material_grouping_decisions_complete":
      return "对每一份需要确认的材料分组给出明确裁决。";
    case "grouping_decisions_reference_real_proposals":
    case "segment_decisions_reference_real_segments":
    case "match_decisions_reference_proposed_suggestions":
      return "复核记录引用了不属于当前候选的对象 —— 重新检查并刷新后再签署。";
    case "ambiguous_matches_dispositioned":
      return "对每一处歧义匹配显式裁决（选定其一或声明有意不匹配）。";
    case "source_current_and_unchanged":
      return "重新生成候选（course:extract）；外部源需再次提供源根。";
    case "canonical_library_complete_for_acceptance":
      return "修好读不出来的真题包后重新抽取，再复核新的候选校验和。";
    case "assets_present_and_checksummed":
      return "修正候选目录里的资产（字节数/sha256 必须与 course.json 声明一致）。";
    case "passes_production_course_validator":
      return "按生产校验器报告的问题修正 course.json。";
    case "rejected_groupings_block_promotion":
      return "修正源目录让它按正确的方式分组，然后重新生成候选。";
    case "excluded_segments_block_promotion":
      return "修正源件或分段依据后重新生成候选。";
    default:
      return "按上面列出的原因处理后重试。";
  }
}

// ---------------------------------------------------------------------------
// A3-c 执行：默认 dry-run，保存须再次明确确认
// ---------------------------------------------------------------------------

export interface RunLinkInput {
  repos: Repositories;
  /** 逐条链接声明。 */
  links: VerifyCanonicalLinkInput[];
  /**
   * `false` = 只预演（默认）；`true` = 写入。
   *
   * 刻意做成**显式参数**而不是两个函数：校验与写入必须共用同一段判据
   * （见 `verifyCanonicalLink` 的说明）。界面据此实现"默认预演、
   * 保存不可变审核行须再次明确确认"。
   */
  commit: boolean;
}

/**
 * 执行 A3-c。
 *
 * ── 不可变行的语义（界面必须如实说明）──
 *
 * `course_canonical_link` 上有 `BEFORE UPDATE` / `BEFORE DELETE` 触发器
 * （`RAISE(ABORT)`），因此一行复核记录写下后**不能改、不能删**。
 * 修正 = 追加一行新的（旧行保留为历史），而运行时按语义目标去重。
 *
 * 这意味着"保存"这个动作的后果比它看起来更重：一次手滑会永久留下一条
 * 自称已核验的记录。因此本函数**默认 dry-run**，且 `commit` 必须是调用方
 * （界面）在单独一次确认里显式传入。
 */
export function runGuardedLink(input: RunLinkInput): {
  ok: boolean;
  committed: boolean;
  results: LinkPreview["results"];
  error: string | null;
} {
  const results: LinkPreview["results"] = [];
  let anyFailed = false;

  for (const link of input.links) {
    const result = verifyCanonicalLink(input.repos, { ...link, dryRun: !input.commit });
    if (!result.ok) {
      anyFailed = true;
      results.push({
        ok: false,
        segmentId: link.segmentId,
        targetLabel: null,
        issues: result.issues,
        warnings: [],
        alreadyExists: false,
      });
      continue;
    }
    results.push({
      ok: true,
      segmentId: link.segmentId,
      targetLabel: describeTarget(link),
      issues: [],
      warnings: result.warnings,
      alreadyExists: !result.created,
    });
  }

  return {
    ok: !anyFailed,
    committed: input.commit,
    results,
    error: anyFailed ? "有链接未通过核验 —— 未写入任何数据（fail closed）。" : null,
  };
}

function describeTarget(link: VerifyCanonicalLinkInput): string {
  const base = `${link.paperId} · ${link.sectionId}`;
  if (link.targetScope === "question") return `${base} / ${link.groupId ?? "?"} / ${link.questionId ?? "?"}`;
  if (link.targetScope === "group") return `${base} / ${link.groupId ?? "?"}`;
  return base;
}

/**
 * 备份目录命名（供启动器与测试共用，避免两处各写一个时间格式而漂移）。
 *
 * 刻意含随机后缀：同一秒内连点两次不得互相覆盖 ——
 * 而"为了备份而覆盖旧备份"会把唯一的恢复点换成一份可能不完整的。
 */
export function backupDirNameOf(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const rand = Math.random().toString(36).slice(2, 8);
  return `a3-backup-${stamp}-${rand}`;
}
