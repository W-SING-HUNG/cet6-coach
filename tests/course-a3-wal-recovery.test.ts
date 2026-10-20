// @vitest-environment node
/**
 * A3 恢复 · **WAL 安全**回归（本文件守的是一个数据丢失级缺陷）。
 *
 * ── 原始缺陷 ──
 *
 * 恢复在替换主库之前**先删掉** `<db>-wal` / `<db>-shm`。SQLite 官方
 * [WAL 文档](https://www.sqlite.org/wal.html) 明确写：
 *
 * > The WAL file is part of the persistent state of the database… **If a database
 * > file is separated from its WAL file, then transactions that were previously
 * > committed to the database might be lost, or the database file might become
 * > corrupted.** The only safe way to remove a WAL file is to open the database
 * > file… then immediately close it.
 *
 * 同一页说明：正常情况下最后一个连接关闭时 WAL 会被删除；但**如果最后一个进程
 * 没有干净关闭**（崩溃/被杀/断电），WAL 会留在盘上，而它可能含有**已提交**事务。
 *
 * 本文件用隔离的合成库证明：
 *
 * 1. 残留 WAL 里的已提交事务**确实只在 WAL 里**（删掉就丢）；
 * 2. 新实现会**先让 SQLite 收拢 WAL**，因此这类事务被并入主库、不丢失；
 * 3. 有活动连接时**拒绝**替换（而不是删掉别人正在用的 WAL）；
 * 4. 带 `-wal` 的快照被**拒绝**（它不是自洽的库）；
 * 5. 替换失败 / 恢复中断时旧库仍可回退。
 */

import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_SQL, SCHEMA_VERSION } from "@/db/schema";
import {
  readSidecarState,
  replaceDatabaseFile,
  settleWalBeforeReplace,
} from "@/services/course-wal-recovery";
import { executeRestore, inspectBackup, writeContentManifest } from "@/services/course-recovery";
import { createContentBackup, createDatabaseBackupAt } from "@/services/course-backup";

const roots: string[] = [];
function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `a3-wal-${tag}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows 句柄延迟：留给 OS 清理，测试不因清理失败而红 */
    }
  }
});

/** 建一个 WAL 模式的库，写 base 行。 */
function seedWalDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec("CREATE TABLE t(a TEXT);");
  db.exec("INSERT INTO t VALUES('base');");
  db.close();
}

/** 读出所有行（只读打开）。 */
function readRows(dbPath: string): string[] {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return (db.prepare("SELECT a FROM t ORDER BY a").all() as { a: string }[]).map((r) => r.a);
  } finally {
    db.close();
  }
}

/**
 * 造出"异常退出后残留 WAL"的真实形态。
 *
 * ── 为什么要这么绕 ──
 *
 * 正常情况下最后一个连接关闭会自动 checkpoint 并清掉 WAL。要复现"崩溃后
 * WAL 留在盘上、且里面有已提交事务"，必须让**主库文件尚未包含**那些页：
 *
 * 1. 打开写连接，**关闭自动 checkpoint**（`wal_autocheckpoint=0`）；
 * 2. 写一行已提交事务（它只进 `-wal`）；
 * 3. 在该连接**仍然打开**时，把三件套（db + wal + shm）复制到另一个目录 ——
 *    那就是崩溃现场被完整保留的样子；
 * 4. 复制完再关掉原连接（它清理的是**原**库的边车，不影响复制品）。
 *
 * 复制品里，`committed-in-wal` 这个已提交事务**只存在于 `-wal` 中**。
 */
function forgeCrashedCopy(liveDbPath: string, targetDbPath: string): void {
  copyFileSync(liveDbPath, targetDbPath);
  if (existsSync(`${liveDbPath}-wal`)) copyFileSync(`${liveDbPath}-wal`, `${targetDbPath}-wal`);
  if (existsSync(`${liveDbPath}-shm`)) copyFileSync(`${liveDbPath}-shm`, `${targetDbPath}-shm`);
}

/**
 * 直接把 `value` 写成"只在 WAL 里"的已提交事务，然后返回一个崩溃现场副本。
 *
 * 返回值里附带需要关闭的两个连接（调用方负责关）。
 */
function makeWalOnlyCommittedState(
  root: string,
  value: string,
): { crashed: string; walsize: number; cleanup: () => void } {
  const live = join(root, "live.db");
  seedWalDb(live);

  // 关掉自动 checkpoint，并确保不触发
  const writer = new DatabaseSync(live);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec("PRAGMA wal_autocheckpoint=0");
  writer.exec(`INSERT INTO t VALUES('${value}')`);
  const walsize = statSync(`${live}-wal`).size;

  // 现场复制（连接仍开）
  const crashed = join(root, "crashed.db");
  forgeCrashedCopy(live, crashed);

  return {
    crashed,
    walsize,
    cleanup: () => {
      try {
        writer.close();
      } catch {
        /* 忽略 */
      }
    },
  };
}

describe("A3 恢复 · 残留 WAL 不得被丢弃（原始缺陷）", () => {
  it("**对照**：删掉残留 WAL 会静默丢失已提交事务（证明缺陷真实存在）", () => {
    const root = makeRoot("loss-demo");
    const { crashed, walsize, cleanup } = makeWalOnlyCommittedState(root, "committed-in-wal");
    try {
      expect(walsize, "WAL 必须非空（否则这个对照没有意义）").toBeGreaterThan(0);
      expect(readSidecarState(crashed).wal.present, "崩溃现场应带 WAL").toBe(true);

      // A：带 WAL ⇒ 已提交事务可见
      const withWal = readRows(crashed);
      expect(withWal).toContain("base");
      expect(withWal, "带 WAL 时应看到已提交事务").toContain("committed-in-wal");

      // B：不带 WAL（= 删掉 WAL）⇒ 已提交事务消失
      const noWal = join(root, "nowal.db");
      copyFileSync(crashed, noWal);
      // 刻意不复制 -wal/-shm
      const rowsWithoutWal = readRows(noWal);
      expect(rowsWithoutWal).toEqual(["base"]);
      expect(
        rowsWithoutWal.includes("committed-in-wal"),
        "这正是原始缺陷：WAL 被删掉后已提交事务静默消失",
      ).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("**修复**：settleWalBeforeReplace 让 SQLite 自己收拢 WAL，事务并入主库且不丢", () => {
    const root = makeRoot("settle-keeps");
    const { crashed, cleanup } = makeWalOnlyCommittedState(root, "committed-in-wal");
    /*
     * 关键：先把造现场用的写连接关掉。
     *
     * 它持有的是**原库** `live.db`，但同目录下同一路径族的 `-shm` 映射会让
     * 复制品的边车状态不稳定（实测：连接开着时 `crashed.db-wal` 可能被压成
     * 0 字节，于是"这个 WAL 里有事务"这件事就不成立了）。
     *
     * 关掉之后 `crashed.db` 才是一份"无人持有、但带着残留 WAL"的干净崩溃
     * 现场 —— 那正是 `settleWalBeforeReplace` 要处理的对象。
     */
    cleanup();
    try {
      const before = readSidecarState(crashed);
      expect(before.wal.present, "崩现场应带 WAL").toBe(true);
      expect(before.wal.bytes, "WAL 必须非空（否则它不含任何事务）").toBeGreaterThan(0);

      const settled = settleWalBeforeReplace(crashed);
      expect(settled.ok, settled.error ?? "").toBe(true);
      expect(settled.before.wal.present, "报告里应说明原来有 WAL").toBe(true);
      expect(settled.before.wal.bytes, "原来是承载事务的 WAL").toBeGreaterThan(0);
      expect(settled.after.wal.bytes, "干净关闭后不应再有非空 WAL").toBe(0);
      expect(settled.after.shm.present, "干净关闭后 SHM 应消失").toBe(false);

      /*
       * 数据没有丢 —— WAL 里的事务已并入主库。
       *
       * 注意顺序：下面这次只读打开**会**在盘上重新造出 0 字节 `-wal`/`-shm`
       * （本机实测：只读打开 WAL 模式库必然创建这两个文件）。因此所有关于
       * 边车的断言都必须在它**之前**做完 —— 否则测的是"只读打开的副作用"，
       * 而不是"settle 有没有把 WAL 收干净"。
       */
      expect(readRows(crashed)).toEqual(["base", "committed-in-wal"]);
    } finally {
      cleanup();
    }
  });

  it("**活动连接存在时拒绝**（绝不删别人正在用的 WAL）", () => {
    const root = makeRoot("active-conn");
    const live = join(root, "live.db");
    seedWalDb(live);

    /*
     * 一个活动读连接：SQLite 在关闭时无法清理 WAL。
     * `settleWalBeforeReplace` 应当**失败关闭**，而不是硬删 WAL。
     */
    const reader = new DatabaseSync(live, { readOnly: true });
    reader.prepare("SELECT COUNT(*) AS c FROM t").get();

    const settled = settleWalBeforeReplace(live);
    // 有活动连接时 WAL 收不干净 ⇒ 必须拒绝
    expect(settled.ok, "有活动连接时必须拒绝，而不是删掉 WAL").toBe(false);
    expect(settled.error, "应说明原因").toMatch(/边车|WAL|持有|连接/);

    // 关键：WAL **没有被我们删掉**
    expect(readSidecarState(live).wal.present).toBe(true);

    reader.close();
  });

  it("带 `-wal` 的快照被拒绝（它不是自洽的库）", () => {
    const root = makeRoot("snapshot-wal");
    const { crashed, cleanup } = makeWalOnlyCommittedState(root, "committed-in-wal");
    try {
      expect(readSidecarState(crashed).wal.present).toBe(true);

      // 目标库自洽
      const target = join(root, "target.db");
      seedWalDb(target);
      expect(settleWalBeforeReplace(target).ok).toBe(true);

      // 用"带 WAL 的快照"去替换 ⇒ 必须被拒
      const result = replaceDatabaseFile(target, crashed);
      expect(result.ok).toBe(false);
      expect(result.error, "应说明快照不是自洽的库").toMatch(/WAL|自洽/);

      // 目标库没有被改动
      expect(readRows(target)).toEqual(["base"]);
    } finally {
      cleanup();
    }
  });

  it("目标仍有边车时拒绝替换（前置条件，不是事后观察）", () => {
    const root = makeRoot("target-sidecar");
    const target = join(root, "target.db");
    seedWalDb(target);
    // 手工放一个假的 -wal，模拟"未 settle"的状态
    writeFileSync(`${target}-wal`, "pretend-wal");

    const snapshot = join(root, "snap.db");
    seedWalDb(snapshot);
    expect(settleWalBeforeReplace(snapshot).ok).toBe(true);

    const result = replaceDatabaseFile(target, snapshot);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/边车|WAL|settle/i);
    // 目标内容未被改动（假 WAL 也没被删）
    expect(existsSync(`${target}-wal`)).toBe(true);
    expect(readRows(target)).toEqual(["base"]);
  });
});

describe("A3 恢复 · 替换的失败方向", () => {
  it("替换成功后旧库保留为 .pre-replace-*，可通过它回退", () => {
    const root = makeRoot("keep-old");
    const target = join(root, "target.db");
    seedWalDb(target);
    const snapshot = join(root, "snap.db");
    expect(createDatabaseBackupAt(target, snapshot).ok).toBe(true);
    /*
     * `VACUUM INTO` 的输出本身是自洽的（不含 WAL）。这里再 settle 一次只是
     * 为了让用例在"快照旁恰好有个 0 字节 -wal"的平台上同样稳定 —— 那是
     * 平台差异，不是语义差异。
     */
    expect(settleWalBeforeReplace(snapshot).ok).toBe(true);
    expect(readSidecarState(snapshot).wal.present, "快照不得带 WAL").toBe(false);

    // 让目标先变成可区分的状态：写入一行
    const w = new DatabaseSync(target);
    w.exec("INSERT INTO t VALUES('second');");
    w.close();
    expect(settleWalBeforeReplace(target).ok).toBe(true);
    expect(readRows(target)).toEqual(["base", "second"]);

    const result = replaceDatabaseFile(target, snapshot);
    expect(result.ok, result.error ?? "").toBe(true);
    expect(result.oldDbBackup, "应保留旧库副本").not.toBeNull();
    // 旧副本存在且**含有被替换掉的那一行**
    expect(existsSync(result.oldDbBackup!)).toBe(true);

    // 新库回到快照的状态（只有 base）
    expect(readRows(target)).toEqual(["base"]);

    // 旧副本仍可读（这是回退点）
    const oldDb = new DatabaseSync(result.oldDbBackup!, { readOnly: true });
    const oldRows = (oldDb.prepare("SELECT a FROM t ORDER BY a").all() as { a: string }[]).map((r) => r.a);
    oldDb.close();
    expect(oldRows).toEqual(["base", "second"]);
  });

  it("快照不存在时失败关闭，且不产生半成品文件", () => {
    const root = makeRoot("missing-snap");
    const target = join(root, "target.db");
    seedWalDb(target);
    expect(settleWalBeforeReplace(target).ok).toBe(true);

    const result = replaceDatabaseFile(target, join(root, "nope.db"));
    expect(result.ok).toBe(false);
    expect(readRows(target)).toEqual(["base"]);
    // 目录里不应出现 staged 残留
    expect(readdirSync(root).filter((n) => n.includes(".staged-"))).toEqual([]);
  });
});

/**
 * 建一个**生产形态**的库（有 `schema_meta`），再附加一张便于观察的 `t` 表。
 *
 * ── 为什么要生产形态 ──
 *
 * `executeRestore` 走的是真实恢复路径，其中的 `verifyBackupRestorable`
 * 需要读取 `schema_meta.schema_version`。用一张玩具表当夹具会让它报
 * "no such table" ⇒ 备份被判为不可用 ⇒ 测的根本不是 WAL 语义。
 *
 * 因此这里用真实 DDL 建库，再额外加一张 `t` 表用于逐行观察。
 */
function seedProductionWalDb(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL;");
  db.exec(SCHEMA_SQL);
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  db.exec("CREATE TABLE t(a TEXT);");
  db.exec("INSERT INTO t VALUES('base');");
  db.close();
}

/**
 * 把"一条只在 WAL 里的已提交事务"装进**已存在的** `targetDb`，然后留下 WAL。
 *
 * 做法：打开 targetDb（关自动 checkpoint）、写一行、在连接仍开时把主库 + WAL
 * 复制成临时三件套，再把三件套覆盖回 targetDb（此时先把原连接关掉，避免
 * 同一路径族被两个连接同时持有）。
 */
function makeWalOnlyCommittedStateInto(root: string, targetDb: string, value: string): void {
  const writer = new DatabaseSync(targetDb);
  writer.exec("PRAGMA journal_mode=WAL");
  writer.exec("PRAGMA wal_autocheckpoint=0");
  writer.exec(`INSERT INTO t VALUES('${value}')`);

  const stagedDb = join(root, "staged-crash.db");
  copyFileSync(targetDb, stagedDb);
  copyFileSync(`${targetDb}-wal`, `${stagedDb}-wal`);
  if (existsSync(`${targetDb}-shm`)) copyFileSync(`${targetDb}-shm`, `${stagedDb}-shm`);
  writer.close();

  // 先用"干净"的副本覆盖主库，再把承载事务的 WAL 放回去
  copyFileSync(stagedDb, targetDb);
  copyFileSync(`${stagedDb}-wal`, `${targetDb}-wal`);
  rmSync(`${stagedDb}-wal`, { force: true });
  rmSync(stagedDb, { force: true });
  // 关掉 writer 后它的 -shm 已失效；残留会由 settle 处理
  rmSync(`${targetDb}-shm`, { force: true });
}

describe("A3 恢复 · 与 executeRestore 的集成（WAL 场景）", () => {
  it("恢复前会先收拢 WAL：还原前快照**含** WAL 里的已提交事务", () => {
    const root = makeRoot("integration");
    const contentRoot = join(root, "content");
    const coursesDir = join(contentRoot, "courses");
    const dbFile = join(root, "cet6.db");
    mkdirSync(contentRoot, { recursive: true });

    // 当前库：生产形态 + 残留 WAL（其中一条已提交事务只在 WAL 里）
    seedProductionWalDb(dbFile);
    makeWalOnlyCommittedStateInto(root, dbFile, "committed-in-wal");
    const walBefore = readSidecarState(dbFile);
    expect(walBefore.wal.present, "当前库应带残留 WAL").toBe(true);
    expect(walBefore.wal.bytes, "残留 WAL 必须承载事务").toBeGreaterThan(0);

    /*
     * 备份（将被恢复的"旧版本"）：**先收拢再 VACUUM INTO**，
     * 因此备份里也包含 committed-in-wal（它是同一份真相的一部分）。
     */
    const backupDir = join(root, "backup");
    mkdirSync(backupDir, { recursive: true });
    expect(settleWalBeforeReplace(dbFile).ok).toBe(true);
    expect(createDatabaseBackupAt(dbFile, join(backupDir, "cet6-pre-a3.db")).ok).toBe(true);
    const contentBackup = createContentBackup(coursesDir, join(backupDir, "courses-pre-a3"));
    expect(contentBackup.ok).toBe(true);
    if (contentBackup.backupPath !== null) writeContentManifest(contentBackup.backupPath);

    expect(inspectBackup(backupDir).usable, inspectBackup(backupDir).problems.join("；")).toBe(true);

    // 当前库再改一点（让"还原"可被观察）
    const w2 = new DatabaseSync(dbFile);
    w2.exec("INSERT INTO t VALUES('after-backup');");
    w2.close();
    expect(settleWalBeforeReplace(dbFile).ok).toBe(true);
    expect(readRows(dbFile)).toEqual(["after-backup", "base", "committed-in-wal"]);

    const result = executeRestore({
      backupDir,
      dbFile,
      contentRoot,
      confirmed: true,
      preRestoreDir: join(root, "pre-restore"),
    });
    expect(result.ok, result.error ?? "").toBe(true);
    expect(result.database.restored, result.database.detail).toBe(true);
    // 恢复到备份时点：after-backup 消失，但 WAL 里那条**保住**
    expect(readRows(dbFile)).toEqual(["base", "committed-in-wal"]);
  });

  it("有活动连接时 executeRestore 失败关闭，且当前库未被改动", () => {
    const root = makeRoot("integration-active");
    const contentRoot = join(root, "content");
    const dbFile = join(root, "cet6.db");
    mkdirSync(contentRoot, { recursive: true });
    seedProductionWalDb(dbFile);

    // 先做一个可用备份
    const backupDir = join(root, "backup");
    mkdirSync(backupDir, { recursive: true });
    expect(settleWalBeforeReplace(dbFile).ok).toBe(true);
    expect(createDatabaseBackupAt(dbFile, join(backupDir, "cet6-pre-a3.db")).ok).toBe(true);
    expect(inspectBackup(backupDir).usable, inspectBackup(backupDir).problems.join("；")).toBe(true);

    // 打开一个活动写连接（另一进程/另一模块持有该库）
    const holder = new DatabaseSync(dbFile);
    holder.exec("PRAGMA wal_autocheckpoint=0;");
    holder.exec("INSERT INTO t VALUES('while-open');");
    const rowsWhileOpen = (holder.prepare("SELECT a FROM t ORDER BY a").all() as { a: string }[]).map((r) => r.a);
    expect(rowsWhileOpen).toContain("while-open");

    const result = executeRestore({
      backupDir,
      dbFile,
      contentRoot,
      confirmed: true,
      preRestoreDir: join(root, "pre-restore"),
    });
    expect(result.ok, "有活动连接时必须拒绝").toBe(false);
    expect(result.database.restored, "数据库不得被替换").toBe(false);
    expect(String(result.error ?? "")).toMatch(/WAL|收拢|占用|连接|锁定|locked/);

    // 关键：对方的已提交数据**没有被抹掉**
    holder.close();
    expect(readRows(dbFile)).toContain("while-open");
  });
});

describe("A3 恢复 · 边车状态读取", () => {
  it("readSidecarState 如实报告存在性与字节数", () => {
    const root = makeRoot("state");
    const dbPath = join(root, "x.db");
    seedWalDb(dbPath);
    // 关闭后通常无 WAL
    const closed = readSidecarState(dbPath);
    expect(closed.wal.present).toBe(false);
    expect(closed.shm.present).toBe(false);

    // 伪造边车
    writeFileSync(`${dbPath}-wal`, "abc");
    const present = readSidecarState(dbPath);
    expect(present.wal.present).toBe(true);
    expect(present.wal.bytes).toBe(3);
    expect(statSync(`${dbPath}-wal`).size).toBe(3);
  });
});
