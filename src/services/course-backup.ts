/**
 * A3 **备份原语**（Backup primitives）—— 唯一实现。
 *
 * ── 为什么单独成模块 ──
 *
 * 这些原语被两个上层消费：
 *
 * - `services/course-a3.ts`（导入前的受保护备份）；
 * - `services/course-recovery.ts`（恢复：还原前快照 + 快照校验）。
 *
 * 早先它们住在 `course-a3.ts` 里，于是恢复模块与它**互相 import**（真循环）。
 * 把原语下沉到独立模块是二者都能依赖同一份实现、又不产生环的唯一办法 ——
 * 另一条路（各写一份）会立刻产生两套"什么算一致快照"的判据。
 *
 * ── SQLite 官方依据（本轮先查后改）──
 *
 * [VACUUM INTO](https://www.sqlite.org/lang_vacuum.html)：
 * "the original database file is unchanged and a new database is created"，
 * 且 "the generated output database is a consistent snapshot of the original database"。
 * 它是[备份 API](https://www.sqlite.org/backup.html) 的官方替代方案。
 *
 * 同一条文档还指出：`VACUUM INTO` 若被**非计划关机或断电**打断，输出库可能
 * 不完整且损坏 —— 因此**任何**一份快照在使用前都必须被真的打开读回，
 * 而不是相信"文件存在且大小合理"。
 *
 * `node:sqlite` 在 Node v24.15.0 **没有** `backup()` 方法（本机实测），
 * 所以这里没有第二条路可走。
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { cpSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface BackupResult {
  ok: boolean;
  /** 备份路径（**只用于服务端内部与恢复演练**，绝不下发给界面）。 */
  backupPath: string | null;
  bytes: number;
  sha256: string | null;
  error: string | null;
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 用 **`VACUUM INTO`** 在**已打开的连接**上取一致性快照。
 *
 * 目标文件必须不存在或为空（官方："must not previously exist, or else it must
 * be an empty file"）。这里刻意在目标非空时报错，而不是先删掉它 ——
 * "为了备份而删掉一个已有文件"是不可接受的副作用。
 */
export function createDatabaseBackup(db: DatabaseSync, backupPath: string): BackupResult {
  if (
    existsSync(/* turbopackIgnore: true */ backupPath) &&
    statSync(/* turbopackIgnore: true */ backupPath).size > 0
  ) {
    return {
      ok: false,
      backupPath: null,
      bytes: 0,
      sha256: null,
      error: "备份目标已存在且非空 —— 拒绝覆盖已有文件（若它是一份旧备份，请先移走）。",
    };
  }
  try {
    const escaped = backupPath.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${escaped}'`);
    return {
      ok: true,
      backupPath,
      bytes: statSync(/* turbopackIgnore: true */ backupPath).size,
      sha256: sha256OfFile(backupPath),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      backupPath: null,
      bytes: 0,
      sha256: null,
      error: `备份失败：${(error as Error).message}（未产生可用快照，因此不得继续写入）`,
    };
  }
}

/**
 * 按**文件路径**取一致性快照（自己开一个独立只读连接，用完即关）。
 *
 * ── 为什么与 `createDatabaseBackup(db, path)` 分开 ──
 *
 * 时机不同，而这个差别是 A3-b 的核心：备份必须发生在**打开写连接之前**，
 * 因为 `openDatabase` 一打开就会迁移。若复用写连接，备份到的是新形态。
 */
export function createDatabaseBackupAt(dbFile: string, backupPath: string): BackupResult {
  if (!existsSync(/* turbopackIgnore: true */ dbFile)) {
    return { ok: false, backupPath: null, bytes: 0, sha256: null, error: "数据库文件不存在，无法备份。" };
  }
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return createDatabaseBackup(db, backupPath);
  } finally {
    try {
      db.close();
    } catch {
      /* 关闭失败不掩盖真实结果 */
    }
  }
}

export interface RestoreVerification {
  ok: boolean;
  readable: boolean;
  schemaVersion: number | null;
  coursePackageCount: number | null;
  courseLinkCount: number | null;
  error: string | null;
}

/**
 * **真实演练**：把快照实际打开，读出 schema 版本与应用记录。
 *
 * ── 为什么"备份成功"不等于"备份可用" ──
 *
 * 一条只报告 `ok: true, bytes: N` 的记录无法区分"快照完整"与"半截文件"。
 * 本机实测见过更糟的形态：复制文件得到的库 `no such table`（空库），
 * 而它的大小看起来完全正常。因此必须真的打开并查询。
 */
export function verifyBackupRestorable(backupPath: string): RestoreVerification {
  if (!existsSync(/* turbopackIgnore: true */ backupPath)) {
    return {
      ok: false,
      readable: false,
      schemaVersion: null,
      coursePackageCount: null,
      courseLinkCount: null,
      error: "备份文件不存在。",
    };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(backupPath, { readOnly: true });
    const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value?: string }
      | undefined;
    const schemaVersion = versionRow?.value === undefined ? null : Number(versionRow.value);

    /*
     * ── `node:sqlite` 的行是 **null 原型对象** ──
     *
     * 因此 `Number(row)` 会抛 `Cannot convert object to primitive value` ——
     * 必须取字段再转换。本项目实测踩到过：它把"快照其实完好"报成
     * "备份无法被读取"，而后者会让导入被**错误地中止**。
     */
    const countOf = (sql: string): number => {
      const row = db!.prepare(sql).get() as { n: number | bigint } | undefined;
      return row === undefined ? 0 : Number(row.n);
    };

    const hasCourseTable = Boolean(
      db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'course_package'").get(),
    );
    const coursePackageCount = hasCourseTable ? countOf("SELECT COUNT(*) AS n FROM course_package") : null;
    const hasLinkTable = Boolean(
      db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'course_canonical_link'").get(),
    );
    const courseLinkCount = hasLinkTable ? countOf("SELECT COUNT(*) AS n FROM course_canonical_link") : null;

    return {
      ok: true,
      readable: true,
      schemaVersion: Number.isFinite(schemaVersion) ? schemaVersion : null,
      coursePackageCount,
      courseLinkCount,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      readable: false,
      schemaVersion: null,
      coursePackageCount: null,
      courseLinkCount: null,
      error: `备份无法被读取：${(error as Error).message}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 把受影响的课程子树复制成一份目录快照。
 *
 * ── 为什么备份必须覆盖它，而不只是数据库 ──
 *
 * SQLite 里只存**索引事实**。课程正文与资产在盘上的 `courses/<id>/`。
 * 若只备份数据库，恢复后索引会指向一份不在盘上（或内容已变）的包 ——
 * 而 `verifyCanonicalLink` 与 Companion 都按"盘的真相"判定，
 * 于是所有链接会立刻失效。那不是恢复，是制造一批不可解释的失效。
 *
 * 目录复制对**非 SQLite 的私有文件**是安全的（没有"运行中连接"问题）。
 */
export function createContentBackup(sourceDir: string, backupDir: string): BackupResult {
  if (!existsSync(/* turbopackIgnore: true */ sourceDir)) {
    // 课程目录尚未创建是**合法状态**（空库）：此时没有内容可备份。
    return { ok: true, backupPath: null, bytes: 0, sha256: null, error: null };
  }
  try {
    if (existsSync(/* turbopackIgnore: true */ backupDir)) {
      return {
        ok: false,
        backupPath: null,
        bytes: 0,
        sha256: null,
        error: "内容备份目标已存在 —— 拒绝覆盖已有目录。",
      };
    }
    cpSync(sourceDir, backupDir, { recursive: true });
    return { ok: true, backupPath: backupDir, bytes: directorySize(backupDir), sha256: null, error: null };
  } catch (error) {
    return {
      ok: false,
      backupPath: null,
      bytes: 0,
      sha256: null,
      error: `内容备份失败：${(error as Error).message}`,
    };
  }
}

function directorySize(root: string): number {
  let total = 0;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) total += directorySize(full);
    else if (entry.isFile()) total += statSync(full).size;
  }
  return total;
}
