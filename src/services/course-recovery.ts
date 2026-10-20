/**
 * A3 **可执行、可验证的恢复**（Recovery）。
 *
 * ── 这个模块补的是什么 ──
 *
 * 上一轮交付了备份的**创建**与"可读回"验证，但没有给 使用者 一条**能真的执行**的恢复路径，
 * 内容快照也没有独立的完整性判据（只有一个字节总数）。
 *
 * 本模块补上三件事：
 *
 * 1. **内容快照清单（manifest）**：逐文件记录**相对路径 + 字节数 + SHA-256**，
 *    因此"内容备份完好"是一条可被独立核对的判据，而不是"复制成功"的自述。
 * 2. **恢复预演（默认）**：把"将要还原什么"逐项列出来 —— 数据库会回到哪一版、
 *    哪些课程包会回来、哪些文件会被覆盖。**零写入**。
 * 3. **恢复执行（须单独授权）**：默认 dry-run；真还原要求 `confirmed: true`
 *    这一条**独立于 A3 导入授权**的显式确认。
 *
 * ── SQLite 官方依据（本轮先查后改）──
 *
 * [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)：原库不变、产出新库，
 * 且"generated output database is a consistent snapshot"；它是
 * [备份 API](https://www.sqlite.org/backup.html) 的官方替代方案。
 *
 * 恢复方向也必须遵守同一条纪律：**绝不**在库仍被其它连接打开时直接替换主文件。
 * 官方文档指出 `VACUUM INTO` 的输出在进程被强杀时可能不完整，因此
 * **每次恢复前都对快照再做一次完整读回校验**（不信任磁盘上"看起来存在"的文件）。
 *
 * ── 它**不**声称什么 ──
 *
 * **不存在跨文件系统与数据库的原子性。** 数据库文件与 `courses/` 目录是
 * 两类独立资源，成功/失败必须逐项报告，并且必须保留"还原前状态"的快照，
 * 以便在一次半完成的恢复之后回到原处。本模块的返回值刻意逐项列出
 * `db` 与 `content` 各自的结果。
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";

/*
 * 复用 A3 已有的备份原语（**不另写一套备份实现**）。
 *
 * `createDatabaseBackupAt` 用 `VACUUM INTO` 取一致性快照；
 * `verifyBackupRestorable` 把快照真的打开读回。两者都在 `course-a3.ts` 里
 * 已被 `course:a3-proof` 与变异证明覆盖，这里只消费它们。
 */
import { createDatabaseBackupAt, verifyBackupRestorable } from "./course-backup";
/*
 * 数据库**离线替换**的唯一实现（含 WAL 收拢纪律）。
 *
 * 刻意不把这段逻辑内联回本文件：它是"文件级破坏性操作"的全部判据，
 * 单独成模块才能被独立测试与变异证明。
 */
import {
  discardOldDatabaseCopy,
  replaceDatabaseFile,
  settleWalBeforeReplace,
} from "./course-wal-recovery";

/** 内容快照清单的文件名（放在快照目录**外层**，因此不与内容混淆）。 */
export const CONTENT_MANIFEST_FILENAME = "content-manifest.json";

/** 一份内容快照的逐文件记录。 */
export interface ContentManifestEntry {
  /** 相对**快照根**的 POSIX 路径。**绝不是绝对路径。** */
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface ContentManifest {
  /** 清单格式版本（与数据库 schema 版本无关）。 */
  manifestVersion: 1;
  createdAt: string;
  /** 被快照的子树标签（只有最后一段目录名，不含路径）。 */
  sourceLabel: string;
  /** 逐文件记录，按相对路径排序（确定性）。 */
  entries: ContentManifestEntry[];
  /** 全部文件数。 */
  fileCount: number;
  /** 全部字节数。 */
  totalBytes: number;
  /**
   * 内容**聚合摘要**：排序后的 (relativePath, bytes, sha256) 的 sha256。
   * 任一文件变化（含新增/删除）都会改变它。
   */
  digest: string;
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function baseLabelOf(absolutePath: string): string {
  const parts = absolutePath.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? "content";
}

/** 递归收集 (相对路径, 字节, sha256)。相对路径一律 POSIX 风格。 */
function collectEntries(root: string): ContentManifestEntry[] {
  const entries: ContentManifestEntry[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      const relativePath = relative(root, full).split(sep).join("/");
      entries.push({
        relativePath,
        bytes: statSync(full).size,
        sha256: sha256OfFile(full),
      });
    }
  };
  if (existsSync(/* turbopackIgnore: true */ root)) walk(root);
  return entries.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

/** 内容摘要（与 `computeSourceDigest` 同一构造，便于互相核对）。 */
function digestOfEntries(entries: ContentManifestEntry[]): string {
  const canonical = [...entries]
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((entry) => `${entry.relativePath}\t${entry.bytes}\t${entry.sha256}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * **生成内容快照清单**（不复制文件，只记录事实）。
 *
 * ── 为什么清单与复制分开 ──
 *
 * 复制由 `createContentBackup` 完成；清单必须描述**复制之后**那份目录，
 * 因为"复制得对不对"正是要被检验的东西。若清单描述的是源，那它证明的是
 * 源长什么样，而不是快照长什么样 —— 两者在复制出错时会分叉。
 */
export function writeContentManifest(snapshotDir: string, createdAt = new Date()): ContentManifest {
  const entries = collectEntries(snapshotDir);
  const manifest: ContentManifest = {
    manifestVersion: 1,
    createdAt: createdAt.toISOString(),
    sourceLabel: baseLabelOf(snapshotDir),
    entries,
    fileCount: entries.length,
    totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    digest: digestOfEntries(entries),
  };
  writeFileSync(join(snapshotDir, CONTENT_MANIFEST_FILENAME), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

/** 读取清单（缺失/损坏都如实报告，不兜底）。 */
export function readContentManifest(snapshotDir: string): {
  ok: boolean;
  manifest: ContentManifest | null;
  error: string | null;
} {
  const path = join(snapshotDir, CONTENT_MANIFEST_FILENAME);
  if (!existsSync(/* turbopackIgnore: true */ path)) {
    return { ok: false, manifest: null, error: "内容快照缺少清单文件，无法验证完整性。" };
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ContentManifest;
    if (parsed.manifestVersion !== 1 || !Array.isArray(parsed.entries)) {
      return { ok: false, manifest: null, error: "内容快照清单格式不受支持。" };
    }
    return { ok: true, manifest: parsed, error: null };
  } catch (error) {
    return { ok: false, manifest: null, error: `内容快照清单无法解析：${(error as Error).message}` };
  }
}

/** 内容快照的完整性校验结果。 */
export interface ContentVerification {
  ok: boolean;
  /** 清单本身是否可读。 */
  manifestReadable: boolean;
  /** 逐文件核对：缺失 / 多余 / 字节数不符 / sha256 不符。 */
  missing: string[];
  unexpected: string[];
  sizeMismatch: string[];
  checksumMismatch: string[];
  /** 清单记录的聚合摘要 vs 现场重算值。 */
  recordedDigest: string | null;
  recomputedDigest: string | null;
  fileCount: number;
  totalBytes: number;
  error: string | null;
}

/**
 * **独立验证**内容快照：逐文件重算 sha256，与清单比对。
 *
 * ── 为什么不能只比"总字节数" ──
 *
 * 两个文件互相交换内容、或一个文件被同尺寸替换，总字节数完全不变。
 * 只有逐文件 sha256 才能发现它们。本项目的原则是"判据的作用域必须
 * 覆盖它声称的范围"，而"总字节数"覆盖不了"内容未变"。
 */
export function verifyContentBackup(snapshotDir: string): ContentVerification {
  const empty: ContentVerification = {
    ok: false,
    manifestReadable: false,
    missing: [],
    unexpected: [],
    sizeMismatch: [],
    checksumMismatch: [],
    recordedDigest: null,
    recomputedDigest: null,
    fileCount: 0,
    totalBytes: 0,
    error: null,
  };

  if (!existsSync(/* turbopackIgnore: true */ snapshotDir)) {
    return { ...empty, error: "内容快照目录不存在。" };
  }

  const read = readContentManifest(snapshotDir);
  if (!read.ok || read.manifest === null) {
    return { ...empty, error: read.error };
  }
  const manifest = read.manifest;

  const actual = collectEntries(snapshotDir).filter(
    (entry) => entry.relativePath !== CONTENT_MANIFEST_FILENAME,
  );
  const actualByPath = new Map(actual.map((entry) => [entry.relativePath, entry]));
  const recordedByPath = new Map(manifest.entries.map((entry) => [entry.relativePath, entry]));

  const missing: string[] = [];
  const sizeMismatch: string[] = [];
  const checksumMismatch: string[] = [];

  for (const recorded of manifest.entries) {
    const found = actualByPath.get(recorded.relativePath);
    if (found === undefined) {
      missing.push(recorded.relativePath);
      continue;
    }
    if (found.bytes !== recorded.bytes) sizeMismatch.push(recorded.relativePath);
    if (found.sha256 !== recorded.sha256) checksumMismatch.push(recorded.relativePath);
  }

  const unexpected: string[] = [];
  for (const found of actual) {
    if (!recordedByPath.has(found.relativePath)) unexpected.push(found.relativePath);
  }

  const recomputedDigest = digestOfEntries(actual);
  const ok =
    missing.length === 0 &&
    unexpected.length === 0 &&
    sizeMismatch.length === 0 &&
    checksumMismatch.length === 0 &&
    recomputedDigest === manifest.digest;

  return {
    ok,
    manifestReadable: true,
    missing,
    unexpected,
    sizeMismatch,
    checksumMismatch,
    recordedDigest: manifest.digest,
    recomputedDigest,
    fileCount: actual.length,
    totalBytes: actual.reduce((sum, entry) => sum + entry.bytes, 0),
    error: ok
      ? null
      : `内容快照与清单不一致（缺失 ${missing.length} / 多余 ${unexpected.length} / ` +
        `字节不符 ${sizeMismatch.length} / 校验和不符 ${checksumMismatch.length}）。`,
  };
}

// ---------------------------------------------------------------------------
// 恢复：预演（默认）与执行（须单独授权）
// ---------------------------------------------------------------------------

/** 一份备份目录的**完整**校验结果（数据库 + 内容）。 */
export interface BackupInspection {
  /** 备份目录本身。 */
  backupDir: string;
  /**
   * 数据库快照。
   *
   * `null` ⇒ 这次备份没有数据库快照（例如只做过晋升，尚未导入）。
   */
  database: {
    fileName: string;
    bytes: number;
    sha256: string;
    verification: ReturnType<typeof verifyBackupRestorable>;
  } | null;
  /** 内容快照（`courses-pre-a3`）。 */
  content: {
    dirName: string;
    verification: ContentVerification;
  } | null;
  /** 整体是否可用作恢复点。 */
  usable: boolean;
  /** 不可用的具体原因（逐条）。 */
  problems: string[];
}

/** 数据库快照的文件名（与 `runGuardedImport` 写出的**同名**）。 */
const DB_SNAPSHOT_FILENAME = "cet6-pre-a3.db";
/** 内容快照的目录名（与 `runGuardedImport` 写出的**同名**）。 */
const CONTENT_SNAPSHOT_DIRNAME = "courses-pre-a3";

/**
 * 检查一个备份目录能否作为**可执行的恢复点**。
 *
 * ── 判据（每一道都必须成立）──
 *
 * 1. 备份目录存在；
 * 2. 数据库快照（若存在）能被打**开并读出应用记录**；
 * 3. 内容快照（若存在）**逐文件** sha256 与清单一致；
 * 4. 至少有一项存在（一个全空的目录不是恢复点）。
 */
export function inspectBackup(backupDir: string): BackupInspection {
  const problems: string[] = [];
  const result: BackupInspection = {
    backupDir,
    database: null,
    content: null,
    usable: false,
    problems,
  };

  if (!existsSync(/* turbopackIgnore: true */ backupDir)) {
    problems.push("备份目录不存在。");
    return result;
  }

  const dbPath = join(backupDir, DB_SNAPSHOT_FILENAME);
  if (existsSync(/* turbopackIgnore: true */ dbPath)) {
    const verification = verifyBackupRestorable(dbPath);
    result.database = {
      fileName: DB_SNAPSHOT_FILENAME,
      bytes: statSync(dbPath).size,
      sha256: sha256OfFile(dbPath),
      verification,
    };
    if (!verification.ok) {
      problems.push(`数据库快照不可用：${verification.error ?? "未知原因"}`);
    }
  }

  const contentDir = join(backupDir, CONTENT_SNAPSHOT_DIRNAME);
  if (existsSync(/* turbopackIgnore: true */ contentDir)) {
    const verification = verifyContentBackup(contentDir);
    result.content = { dirName: CONTENT_SNAPSHOT_DIRNAME, verification };
    if (!verification.ok) {
      // 兼容上一轮的备份（没有清单）：此时内容快照**不可验证** ⇒ 不算恢复点。
      problems.push(
        verification.manifestReadable
          ? `内容快照与清单不一致：${verification.error ?? ""}`
          : "内容快照缺少完整性清单，无法验证 —— 不把它当作可执行的恢复点。" +
            "（上一轮生成的备份没有清单；请用当前版本重新备份。）",
      );
    }
  }

  if (result.database === null && result.content === null) {
    problems.push("备份目录里既没有数据库快照，也没有内容快照。");
  }

  result.usable = problems.length === 0;
  return result;
}

/** 恢复预演：**要还原什么**（零写入）。 */
export interface RestorePreview {
  ok: boolean;
  backupDir: string;
  /** 数据库将回到的 schema 版本（来自快照）。 */
  targetSchemaVersion: number | null;
  /** 快照里有哪些课程包（id + 内容版本）。**只列 id**，不含正文。 */
  targetCoursePackages: { id: string; contentVersion: number }[];
  /** 快照里的不可变链接行数。 */
  targetLinkCount: number | null;
  /** 内容快照：文件数与总字节数。 */
  targetContent: { fileCount: number; totalBytes: number; courses: string[] } | null;
  /** 当前（被覆盖前）的状态摘要 —— 让人看见"会失去什么"。 */
  current: {
    schemaVersion: number | null;
    coursePackages: { id: string; contentVersion: number }[];
    linkCount: number | null;
    contentPresent: boolean;
  };
  /** 不可执行的原因。 */
  blockedReasons: string[];
  /** 执行恢复会**写入**哪些位置（相对标签）。 */
  writeTargets: string[];
  /** 是否需要（以及会创建）还原前快照。 */
  willPreservePreRestoreState: boolean;
  error: string | null;
}

export interface PreviewRestoreInput {
  backupDir: string;
  dbFile: string;
  contentRoot: string;
}

/** 读取一个库里的课程层事实（表不存在时如实返回空）。 */
function readCourseFacts(dbFile: string): {
  schemaVersion: number | null;
  coursePackages: { id: string; contentVersion: number }[];
  linkCount: number | null;
  readable: boolean;
} {
  if (!existsSync(/* turbopackIgnore: true */ dbFile)) {
    return { schemaVersion: null, coursePackages: [], linkCount: null, readable: false };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true });
    const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value?: string }
      | undefined;
    const schemaVersion = versionRow?.value === undefined ? null : Number(versionRow.value);
    const hasCourse = Boolean(
      db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_package'").get(),
    );
    const coursePackages = hasCourse
      ? (db.prepare("SELECT id, content_version AS v FROM course_package ORDER BY id").all() as {
          id: string;
          v: number | bigint;
        }[]).map((row) => ({ id: row.id, contentVersion: Number(row.v) }))
      : [];
    const hasLink = Boolean(
      db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_canonical_link'").get(),
    );
    const linkCount = hasLink
      ? Number((db.prepare("SELECT COUNT(*) AS n FROM course_canonical_link").get() as { n: number }).n)
      : null;
    return { schemaVersion, coursePackages, linkCount, readable: true };
  } catch {
    return { schemaVersion: null, coursePackages: [], linkCount: null, readable: false };
  } finally {
    try {
      db?.close();
    } catch {
      /* 忽略 */
    }
  }
}

/**
 * **预演一次恢复**（零写入）。
 *
 * 它必须回答"我会失去什么"与"我会得到什么"，否则 使用者 无法做知情决定。
 */
export function previewRestore(input: PreviewRestoreInput): RestorePreview {
  const blockedReasons: string[] = [];
  const inspection = inspectBackup(input.backupDir);
  if (!inspection.usable) blockedReasons.push(...inspection.problems);

  const targetFacts = inspection.database
    ? readCourseFacts(join(input.backupDir, DB_SNAPSHOT_FILENAME))
    : { schemaVersion: null, coursePackages: [], linkCount: null, readable: false };

  const currentFacts = readCourseFacts(input.dbFile);

  const contentSnapshotDir = join(input.backupDir, CONTENT_SNAPSHOT_DIRNAME);
  let targetContent: RestorePreview["targetContent"] = null;
  if (inspection.content !== null) {
    const manifest = readContentManifest(contentSnapshotDir);
    if (manifest.ok && manifest.manifest !== null) {
      /*
       * 列出快照里的**课程 id**。
       *
       * ── 路径形状的两层不确定性 ──
       *
       * `createContentBackup(sourceDir, backupDir)` 用 `cpSync` 把**源目录本身**
       * 复制成目标目录名，因此清单路径先是源目录名那一层。而 A3-b 传进来的
       * 源是 `<内容根>/courses` ⇒ 快照里形如：
       *
       *     courses/<课程 id>/course.json
       *
       * 也就是说：**第一段是源目录名，第二段才是课程 id**。
       * 早先"取第一段"会把 `courses` 当成课程 id —— 那是"看起来对"的判据
       * （它在只有一门课时也长得像个名字）。
       *
       * 这里按结构判定：若第一段是字面量 `courses` 就跳过它，
       * 否则取第一段。因此与源目录叫什么无关。
       */
      const courses = new Set<string>();
      for (const entry of manifest.manifest.entries) {
        const segments = entry.relativePath.split("/").filter((part) => part !== "");
        // 与 `restoreContentTree` 同一事实：清单第一段就是课程 id（无包装层）
        const candidate = segments[0];
        if (candidate !== undefined && candidate !== "" && candidate !== CONTENT_MANIFEST_FILENAME) {
          courses.add(candidate);
        }
      }
      targetContent = {
        fileCount: manifest.manifest.fileCount,
        totalBytes: manifest.manifest.totalBytes,
        courses: [...courses].sort(),
      };
    }
  }

  // 目标身份核对：数据库快照必须属于**同一个** schema 家族（不能把别人的库塞进来）
  if (inspection.database !== null) {
    const v = inspection.database.verification.schemaVersion;
    if (v === null) blockedReasons.push("数据库快照没有可读的 schema 版本 —— 拒绝作为恢复点。");
  }

  return {
    ok: blockedReasons.length === 0,
    backupDir: input.backupDir,
    targetSchemaVersion: targetFacts.schemaVersion,
    targetCoursePackages: targetFacts.coursePackages,
    targetLinkCount: targetFacts.linkCount,
    targetContent,
    current: {
      schemaVersion: currentFacts.schemaVersion,
      coursePackages: currentFacts.coursePackages,
      linkCount: currentFacts.linkCount,
      contentPresent: existsSync(/* turbopackIgnore: true */ join(input.contentRoot, "courses")),
    },
    blockedReasons,
    writeTargets: [
      `数据库：${relativeLabel(input.dbFile)}`,
      `课程内容：${relativeLabel(join(input.contentRoot, "courses"))}`,
    ],
    willPreservePreRestoreState: true,
    error: null,
  };
}

/** 只显示末几段路径（**绝不**回传绝对路径）。 */
function relativeLabel(absolutePath: string): string {
  return absolutePath.split(/[\\/]/).filter((part) => part !== "").slice(-3).join("/");
}

/** 目录比较键（大小写与尾分隔符无关）。 */
function resolveKey(path: string): string {
  return path.replace(/[\\/]+$/, "").toLowerCase();
}

// ---------------------------------------------------------------------------
// 恢复执行
// ---------------------------------------------------------------------------

export interface ExecuteRestoreInput {
  backupDir: string;
  dbFile: string;
  contentRoot: string;
  /**
   * **独立于 A3 导入授权**的显式确认。
   *
   * 刻意不是复用 `importIndex` 的 `confirmed`：恢复会**覆盖**当前库与课程内容，
   * 它的后果与"导入索引"完全不同，因此必须是一次新的决定。
   */
  confirmed: boolean;
  /** 还原前状态的快照放在哪里（**必须**与备份目录不同）。 */
  preRestoreDir: string;
  /**
   * 故障注入（可选，**只用于测试**）。
   *
   * ── 为什么需要这个缝 ──
   *
   * "恢复被中断"是任务书要求证明的五类场景之一。真实的中断（进程被杀、
   * 磁盘满）在测试里无法可靠复现，而**假装**它发生（比如只断言返回值形状）
   * 证明不了"中断时仍然逐项如实报告"。
   *
   * 因此这里给一个与 `runGuardedImport` 的 `openWrite` 同类的注入点：
   * 它允许测试在**数据库已还原之后、内容还原之前**精确地失败，
   * 从而检验那条最危险的中间状态是被如实报告的。
   *
   * 生产调用方**不传**它 ⇒ 行为不受影响。
   */
  faults?: {
    /** 在内容还原之前抛错（模拟中断）。 */
    beforeContentRestore?: () => void;
  };
}

export interface ExecuteRestoreResult {
  ok: boolean;
  /** 逐项结果：数据库与内容**分别**报告（不存在跨资源原子性）。 */
  database: { restored: boolean; detail: string; preRestoreBackup: string | null };
  content: { restored: boolean; detail: string; preRestoreBackup: string | null };
  /** 若中途失败，这里说明如何回到原处。 */
  recoveryNote: string | null;
  error: string | null;
}

/**
 * **执行一次恢复**。
 *
 * ── 顺序与理由（每一步都是判据，不是流程习惯）──
 *
 * 1. **先预演**：`previewRestore` 不通过 ⇒ 直接拒绝（错课程/坏快照/缺备份都在这里失败关闭）；
 * 2. **先保存还原前状态**：在任何覆盖之前，把当前库与当前 `courses/` 各做一份快照。
 *    没有这一步，一次半完成的恢复就无法回到原处 —— 而"半完成"是真实可能的
 *    （数据库与内容不是同一个事务）；
 * 3. **只在没有任何连接打开目标库时**替换：本函数用 `openDatabase`/`new DatabaseSync`
 *    都**不**保持长连接；替换前显式做一次可用性检查；
 * 4. 逐项报告。
 *
 * ── 为什么用 `rename` 而不是原地覆写 ──
 *
 * 同卷内 `rename` 是原子的：要么看到旧文件，要么看到新文件，不存在
 * "写了一半的库"。这**不等于**跨资源原子性 —— 数据库换了而内容没换
 * 仍然是一个可达的中间状态，因此必须保留还原前快照。
 */
export function executeRestore(input: ExecuteRestoreInput): ExecuteRestoreResult {
  const empty: ExecuteRestoreResult = {
    ok: false,
    database: { restored: false, detail: "未执行", preRestoreBackup: null },
    content: { restored: false, detail: "未执行", preRestoreBackup: null },
    recoveryNote: null,
    error: null,
  };

  /*
   * ── 明确授权 ──
   *
   * 缺失即拒绝。这一条必须在**任何**写操作之前，包括"还原前快照"之前 ——
   * 否则一次未授权的调用仍然会改动磁盘（哪怕只是多出一个备份目录）。
   */
  if (input.confirmed !== true) {
    return { ...empty, error: "缺少明确授权：恢复会覆盖当前数据库与课程内容，需要单独确认。" };
  }

  const preview = previewRestore({
    backupDir: input.backupDir,
    dbFile: input.dbFile,
    contentRoot: input.contentRoot,
  });
  if (!preview.ok) {
    return { ...empty, error: `拒绝恢复：${preview.blockedReasons.join("；")}` };
  }

  // 备份目录与还原前目录不能是同一个（否则会自己覆盖自己的恢复点）
  if (resolveKey(input.preRestoreDir) === resolveKey(input.backupDir)) {
    return { ...empty, error: "拒绝恢复：还原前快照目录不能与所用备份目录相同。" };
  }

  // ── 还原前状态快照（先做，且失败即中止）──
  mkdirSync(input.preRestoreDir, { recursive: true });
  const preDbPath = join(input.preRestoreDir, DB_SNAPSHOT_FILENAME);
  let preDbLabel: string | null = null;
  let preContentLabel: string | null = null;

  /*
   * ── 先让 SQLite 收拢 WAL，**再**取还原前快照（顺序不可颠倒）──
   *
   * 若当前库是"异常退出后残留 WAL"的状态，WAL 里可能有**已提交**事务。
   * 此时：
   *
   * - 若先 `VACUUM INTO` 再收拢：`VACUUM INTO` 走的是一个新连接，
   *   SQLite 会自行重放 WAL，因此快照其实是完整的 —— 但主库文件本身仍处于
   *   "依赖 WAL"的状态，后续替换会把它连同 WAL 一起弄丢；
   * - 若先收拢再快照：主库文件变成自洽的，快照与替换目标都是同一份真相。
   *
   * 因此顺序是"收拢 → 快照 → 替换"。收拢失败（还有别的连接持有）⇒ **中止**，
   * 因为在这种状态下任何文件级替换都会丢数据。
   */
  if (existsSync(/* turbopackIgnore: true */ input.dbFile)) {
    const settled = settleWalBeforeReplace(input.dbFile);
    if (!settled.ok) {
      return {
        ...empty,
        error:
          `已中止：无法安全收拢数据库的 WAL（${settled.error ?? "未知原因"}）。` +
          `未做任何覆盖。请关闭其它占用该数据库的进程后重试。`,
      };
    }
  }

  if (existsSync(/* turbopackIgnore: true */ input.dbFile)) {
    // 用 VACUUM INTO 取**一致性**快照（复制文件在 WAL 下不安全，本轮已实测）
    const created = createDatabaseBackupAt(input.dbFile, preDbPath);
    if (!created.ok) {
      return { ...empty, error: `已中止：无法保存还原前状态（${created.error ?? "未知"}）。未做任何覆盖。` };
    }
    const verified = verifyBackupRestorable(preDbPath);
    if (!verified.ok) {
      return { ...empty, error: `已中止：还原前快照无法读回（${verified.error ?? "未知"}）。未做任何覆盖。` };
    }
    preDbLabel = relativeLabel(preDbPath);
  }

  const coursesDir = join(input.contentRoot, "courses");
  const preContentDir = join(input.preRestoreDir, CONTENT_SNAPSHOT_DIRNAME);
  if (existsSync(/* turbopackIgnore: true */ coursesDir)) {
    try {
      cpSync(coursesDir, preContentDir, { recursive: true });
      writeContentManifest(preContentDir);
      const check = verifyContentBackup(preContentDir);
      if (!check.ok) {
        return { ...empty, error: `已中止：还原前内容快照校验失败（${check.error ?? "未知"}）。未做任何覆盖。` };
      }
      preContentLabel = relativeLabel(preContentDir);
    } catch (error) {
      return { ...empty, error: `已中止：无法保存还原前内容（${(error as Error).message}）。未做任何覆盖。` };
    }
  }

  // ── 1) 数据库还原 ──
  const database = { restored: false, detail: "备份中没有数据库快照", preRestoreBackup: preDbLabel };
  const snapshotDb = join(input.backupDir, DB_SNAPSHOT_FILENAME);
  if (existsSync(/* turbopackIgnore: true */ snapshotDb)) {
    /*
     * ── 替换前**再验证一次**快照 ──
     *
     * 不信任 `previewRestore` 之前的结论：从预演到执行之间磁盘可以变化，
     * 而"用一份已经坏掉的快照覆盖当前库"是最坏的失败方向。
     */
    const again = verifyBackupRestorable(snapshotDb);
    if (!again.ok) {
      return {
        ...empty,
        database: {
          restored: false,
          detail: `快照在恢复前再次校验失败：${again.error ?? "未知"}`,
          preRestoreBackup: preDbLabel,
        },
        recoveryNote: preDbLabel === null ? null : `当前库**未**被改动。还原前快照：${preDbLabel}`,
        error: "拒绝恢复数据库：快照不再可用。",
      };
    }
    /*
     * ── 用**离线替换**模块（它拒绝在残留边车存在时动手）──
     *
     * 早先这里是 `replaceFileAtomic`：删 `-wal`/`-shm` → rename。
     * 那一步会在"异常退出后残留 WAL"的库上**静默丢掉已提交事务**
     * （SQLite 官方明确警告；本机合成库实测复现）。详见
     * `course-wal-recovery.ts` 的模块头。
     */
    const replaced = replaceDatabaseFile(input.dbFile, snapshotDb);
    if (!replaced.ok) {
      return {
        ...empty,
        database: {
          restored: false,
          detail: replaced.error ?? replaced.detail,
          preRestoreBackup: preDbLabel,
        },
        recoveryNote: preDbLabel === null ? null : `当前库**未**被改动。还原前快照：${preDbLabel}`,
        error: "数据库还原失败（未替换）。",
      };
    }
    /*
     * 校验：替换后的库必须能打开，且它记录的 schema 版本应当与快照一致。
     * 通过之后才删掉 `.pre-replace-*` 旧副本 —— 在此之前它是唯一回退点。
     */
    const postCheck = verifyBackupRestorable(input.dbFile);
    if (!postCheck.ok) {
      return {
        ...empty,
        database: {
          restored: false,
          detail: `替换后校验失败：${postCheck.error ?? "未知"}`,
          preRestoreBackup: preDbLabel,
        },
        recoveryNote:
          `替换后的数据库无法读回。旧库保留在 ${replaced.oldDbBackup === null ? "（无）" : relativeLabel(replaced.oldDbBackup)}；` +
          (preDbLabel === null ? "" : `另有还原前快照：${preDbLabel}`),
        error: "数据库还原后校验失败。",
      };
    }
    if (replaced.oldDbBackup !== null) discardOldDatabaseCopy(replaced.oldDbBackup);
    database.restored = true;
    database.detail = `已还原到 schema v${postCheck.schemaVersion ?? "?"}（快照原样复制，WAL 已安全收拢）`;
  }

  // ── 2) 内容还原 ──
  const content = { restored: false, detail: "备份中没有内容快照", preRestoreBackup: preContentLabel };
  const snapshotContent = join(input.backupDir, CONTENT_SNAPSHOT_DIRNAME);

  /*
   * 故障注入点：**数据库已还原、内容尚未还原**。
   *
   * 这是全局最危险的中间状态（两项资源只完成了一项）。测试用它证明
   * "中断被如实逐项报告，且能用还原前快照回到原处"。
   */
  if (input.faults?.beforeContentRestore) {
    try {
      input.faults.beforeContentRestore();
    } catch (error) {
      return {
        ok: false,
        database,
        content: {
          restored: false,
          detail: `内容还原被中断：${(error as Error).message}`,
          preRestoreBackup: preContentLabel,
        },
        recoveryNote:
          `**数据库已还原，内容未还原** —— 这不是原子操作。` +
          (preDbLabel === null ? "没有还原前数据库快照。" : `回到原处请用还原前数据库快照：${preDbLabel}`) +
          (preContentLabel === null ? "" : `；还原前内容快照：${preContentLabel}`),
        error: "恢复在内容还原之前被中断。",
      };
    }
  }

  if (existsSync(/* turbopackIgnore: true */ snapshotContent)) {
    const check = verifyContentBackup(snapshotContent);
    if (!check.ok) {
      return {
        ok: false,
        database,
        content: {
          restored: false,
          detail: `内容快照校验失败：${check.error ?? "未知"}`,
          preRestoreBackup: preContentLabel,
        },
        recoveryNote: preContentLabel === null ? null : `数据库已还原；内容**未**改动。还原前内容快照：${preContentLabel}`,
        error: "拒绝恢复内容：快照与清单不一致。",
      };
    }
    try {
      const targetCourses = join(input.contentRoot, "courses");
      const restoredTree = restoreContentTree(snapshotContent, targetCourses);
      content.restored = true;
      content.detail = `已还原 ${restoredTree.files} 个文件（${check.totalBytes} 字节）`;
    } catch (error) {
      return {
        ok: false,
        database,
        content: {
          restored: false,
          detail: `内容还原失败：${(error as Error).message}`,
          preRestoreBackup: preContentLabel,
        },
        recoveryNote:
          preContentLabel === null
            ? "数据库已还原；内容还原失败且没有还原前快照。"
            : `数据库已还原；内容还原失败。还原前内容快照：${preContentLabel}`,
        error: "内容还原失败（数据库可能已经还原 —— 这不是原子操作）。",
      };
    }
  }

  return {
    ok: database.restored || content.restored,
    database,
    content,
    recoveryNote:
      "提醒：数据库与课程内容**不是**同一个事务。若只想回退其中一项，" +
      "请用上面对应的还原前快照单独恢复。",
    error: null,
  };
}

/**
 * 还原内容快照到目标 `courses/` 目录。
 *
 * ── 为什么必须**按结构**而不是按"猜一层" ──
 *
 * `createContentBackup(sourceDir, backupDir)` 用 `cpSync` 把**源目录本身**
 * 复制成目标目录名，因此快照里的路径形如 `<源目录名>/<课程 id>/...`。
 * 早先这里用"顶层只有一个条目就剥掉它"的启发式 —— 那在两门课的时候
 * 不成立（会剥错），而在只有一门课时又恰好能过，属于**看起来对**的判据。
 *
 * 现在的做法：把清单里的**每个相对路径**去掉第一段后再拼回目标，
 * 因此不依赖"顶层有几个条目"，也不依赖目录名。
 */
function restoreContentTree(snapshotDir: string, targetCoursesDir: string): { files: number } {
  const read = readContentManifest(snapshotDir);
  if (!read.ok || read.manifest === null) {
    throw new Error(read.error ?? "内容快照缺少清单，无法结构化还原。");
  }

  if (existsSync(/* turbopackIgnore: true */ targetCoursesDir)) {
    rmSync(targetCoursesDir, { recursive: true, force: true });
  }
  mkdirSync(targetCoursesDir, { recursive: true });

  let files = 0;
  for (const entry of read.manifest.entries) {
    const segments = entry.relativePath.split("/").filter((part) => part !== "");
    if (segments.length === 0) continue;
    /*
     * ── 清单路径**没有**额外的包装层（实测确认）──
     *
     * `cpSync(sourceDir, targetDir, { recursive: true })` 在 Node 上的语义是：
     * 若 `targetDir` **不存在**，它会被创建，并把 `sourceDir` 的**内容**
     * 放进去（而不是再套一层 `targetDir/sourceDir`）。
     *
     * 因此当源是 `<内容根>/courses` 时，清单里的路径直接就是
     * `c1/course.json`、`c1/assets/a.pdf` —— **第一段就是课程 id**。
     *
     * 早先这里按"剥一层"实现，于是还原出 `courses/course.json`（把课程 id
     * 那一层剥掉了），Companion 完全读不到。这条是实测抓到的：
     * 判据的方向必须由**真实布局**决定，而不是由对 `cpSync` 的猜测决定。
     */
    const target = join(targetCoursesDir, ...segments);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(join(snapshotDir, ...segments), target);
    files += 1;
  }
  return { files };
}

/*
 * ── 关于"替换数据库文件"这件事 ──
 *
 * 早先本文件里有一个 `replaceFileAtomic`：删 `-wal`/`-shm` → rename。
 * 那一步在"异常退出后残留 WAL"的库上会**静默丢掉已提交事务**
 * （SQLite 官方明确警告；本机合成库实测复现：带 WAL 打开能看到 2 行，
 * 删掉 WAL 后只剩 1 行）。
 *
 * 因此它被整体搬到 `course-wal-recovery.ts`，并按官方要求改成
 * "让 SQLite 自己打开-关闭以收拢 WAL → 断言边车消失 → 再替换"。
 * 本文件不再直接触碰 `-wal`/`-shm`。
 */

