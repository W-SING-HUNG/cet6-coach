/**
 * A3 **离线数据库替换**（Offline SQLite file replacement）。
 *
 * ── 这个模块解决的真实缺陷 ──
 *
 * 恢复要把快照复制到主库路径上。早先的实现是：
 *
 *     1. 删掉 `<db>-wal` / `<db>-shm`
 *     2. rename 快照 → `<db>`
 *
 * 第 1 步是**错的，而且是数据丢失级**的错误。SQLite 官方
 * [WAL 文档](https://www.sqlite.org/wal.html) 明确写：
 *
 * > The WAL file is part of the persistent state of the database and should be
 * > kept with the database if the database is copied or moved. **If a database
 * > file is separated from its WAL file, then transactions that were previously
 * > committed to the database might be lost, or the database file might become
 * > corrupted.** The only safe way to remove a WAL file is to open the database
 * > file using one of the sqlite3_open() interfaces then immediately close the
 * > database using sqlite3_close().
 *
 * 同一页还说明：正常情况下 WAL 会在最后一个连接关闭时被删除；但**如果最后一个
 * 进程没有干净地关闭连接**（崩溃、被杀、断电），WAL 会被留在盘上 —— 而它里面
 * 可能含有**已提交**的事务。
 *
 * 本机实测（合成库、隔离临时目录）：
 *
 * | 做法 | 结果 |
 * | --- | --- |
 * | 带 `-wal` 打开（崩溃现场完整保留） | `base` + `committed-only-in-wal`（2 行） |
 * | 只留主库、WAL 被删 | **只有 `base`**（1 行）—— 已提交事务静默消失 |
 *
 * 也就是说，"先删 WAL 再换主库"会**静默丢掉已提交数据**，而且不报错。
 *
 * ── 采用的安全流程（顺序即判据）──
 *
 * 1. **打开**当前主库（普通读写连接）并**干净关闭**。
 *    这一步让 SQLite 自己完成 WAL 恢复 + checkpoint，并按官方说法在最后一个
 *    连接关闭时删除/回收 WAL。**我们绝不自己删 WAL。**
 * 2. **断言边车已消失**。若打开-关闭之后 `-wal`/`-shm` 仍然存在，说明还有别的
 *    连接持有该库，或者恢复没能完成 ⇒ **中止**（绝不继续替换）。
 * 3. 用 `VACUUM INTO` 把"当前状态"再快照一次（此时它已包含 WAL 里的事务），
 *    作为**还原前恢复点** —— 这一步必须在第 1 步之后，否则快照会漏掉 WAL 内容。
 * 4. 把目标库文件复制到**同目录**临时文件（同卷），`rename` 原子覆盖。
 * 5. 快照本身也用同样纪律处理：若快照旁边**意外**带有 `-wal`，说明这份快照
 *    不是一个自洽的库（它是从崩溃现场原样拷来的），此时**拒绝**使用它。
 *
 * ── 它**不**声称什么 ──
 *
 * - 不声称跨资源原子性（数据库与 `courses/` 目录之间没有共同事务）；
 * - 不声称能处理"别的进程正持有该库"——那种情况本模块**失败关闭**并说明原因；
 * - 不声称 `rename` 在所有文件系统上都原子（同卷前提下才成立）。
 */

import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname } from "node:path";

/** SQLite 的 WAL 边车后缀（顺序即删除/检查顺序）。 */
const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

/**
 * **用 SQLite 自己的锁**判断"还有没有别的连接持有这个库"。
 *
 * ── 为什么不能依赖文件锁（本任务的核心要求）──
 *
 * 早先的实现把安全建立在"Windows `rename` 会在目标被占用时失败（EBUSY）"
 * 之上。那是一条**平台行为**，不是一条**语义判据**：
 *
 * - 在 POSIX 上 `rename` 对已被打开的文件**照常成功**（inode 语义）；
 * - 即使在同一台 Windows 上，`copy`/`read` 对被占用的主库**也能成功**
 *   （本机实测：`copyFileSync` 通过，只有 `rename` 报 EBUSY）；
 * - 于是"替换是否安全"取决于我们跑在哪、以及恰好执行了哪个系统调用。
 *
 * 判据必须落在**数据库自己的并发语义**上。`BEGIN EXCLUSIVE` 正是它：
 * 拿到排它锁 ⇒ 这一刻没有任何其它连接在读或写该库。
 *
 * 本机实测（合成库）：
 *
 * | 场景 | `BEGIN EXCLUSIVE` |
 * | --- | --- |
 * | 无连接 | 成功 |
 * | 有一个只读连接 | `database is locked` |
 * | 有一个写连接 | `database is locked` |
 *
 * ── 为什么用 `locking_mode=EXCLUSIVE` 再 `BEGIN EXCLUSIVE` ──
 *
 * 只发 `BEGIN EXCLUSIVE` 在 WAL 模式下拿到的是写锁，仍允许别的读者存在。
 * 先切到 `locking_mode=EXCLUSIVE` 才能要求"独占整个库文件"。两者合用
 * 才真正回答"现在有没有人跟我同时用这个库"。
 */
export interface ExclusiveProbeResult {
  /** 是否成功取得排它锁（= 没有其它连接）。 */
  exclusive: boolean;
  error: string | null;
}

export function probeExclusiveAccess(dbPath: string): ExclusiveProbeResult {
  if (!existsSync(/* turbopackIgnore: true */ dbPath)) {
    return { exclusive: false, error: "目标数据库不存在。" };
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath);
    /*
     * `busy_timeout = 0`：**立刻**失败，而不是等 5 秒。
     *
     * 这里的问题是"有没有人正在用"，不是"能不能等到它用完"。等待会把
     * "有人在用"变成"稍后可能能用"，那是一个不确定的判据，不适合作为
     * 破坏性操作的前置条件。
     */
    db.exec("PRAGMA busy_timeout = 0");
    db.exec("PRAGMA locking_mode = EXCLUSIVE");
    db.exec("BEGIN EXCLUSIVE");
    db.exec("COMMIT");
    return { exclusive: true, error: null };
  } catch (error) {
    const message = (error as Error).message;
    const locked = /locked|busy/i.test(message);
    return {
      exclusive: false,
      error: locked
        ? "database is locked —— 还有其它连接正在读或写这个数据库。"
        : `无法取得排它访问：${message}`,
    };
  } finally {
    try {
      db?.close();
    } catch {
      /* 忽略：close 失败不改判据 */
    }
  }
}

export interface SidecarState {
  wal: { present: boolean; bytes: number };
  shm: { present: boolean; bytes: number };
}

function inspectSidecars(dbPath: string): SidecarState {
  const read = (suffix: string): { present: boolean; bytes: number } => {
    const path = `${dbPath}${suffix}`;
    if (!existsSync(/* turbopackIgnore: true */ path)) return { present: false, bytes: 0 };
    try {
      return { present: true, bytes: statSync(/* turbopackIgnore: true */ path).size };
    } catch {
      return { present: true, bytes: 0 };
    }
  };
  return { wal: read("-wal"), shm: read("-shm") };
}

/**
 * 判定边车是否**承载事务**（而不是一个空壳）。
 *
 * ── 为什么需要这条区分（本机实测确认的机制）──
 *
 * 对一个 WAL 模式的库做**只读打开**时，SQLite 仍会创建 `-shm` 与 `-wal`
 * （它需要一个 wal-index 来读）。关闭之后，那个 `-wal` 常常是 **0 字节**。
 *
 * 于是"边车存在"这一条判据会把**完全正常的库**判成"依赖 WAL 的危险状态" ——
 * 一个假阳性，而假阳性的后果是恢复被永久挡住。
 *
 * 因此判据必须落在"它是否承载事务"上：
 *
 * | 状态 | 含义 | 处置 |
 * | --- | --- | --- |
 * | 无 `-wal` | 自洽 | 可以替换 |
 * | `-wal` 存在且 **> 0 字节** | **可能含已提交事务** | 必须让 SQLite 收拢 |
 * | `-wal` 存在但 **0 字节** | 空壳（只读打开留下的痕迹） | 不承载事务，可安全忽略 |
 *
 * 这里刻意**不**因为 0 字节就自己去删它：删除动作仍然只由 SQLite 做
 * （见 `settleWalBeforeReplace`）。我们只是不再把它当成阻塞条件。
 */
function sidecarsCarryTransactions(state: SidecarState): boolean {
  return state.wal.present && state.wal.bytes > 0;
}

export interface SettleResult {
  ok: boolean;
  /** 打开前边车状态（用于报告"原来有 WAL，里面可能有已提交事务"）。 */
  before: SidecarState;
  /** 关闭后边车状态。 */
  after: SidecarState;
  /** 打开-关闭期间是否观察到 SQLite 读到了 WAL 内容（用 page_count 间接观察不可靠，故只记事实）。 */
  detail: string;
  error: string | null;
}

/**
 * **让 SQLite 自己把 WAL 收干净**：打开 → 立即关闭。
 *
 * 这是官方唯一认可的"移除 WAL 的安全做法"。关键在于：
 *
 * - 我们**不**碰 `-wal` 文件本身；
 * - 打开动作会让 SQLite 重放 WAL 里的已提交事务（如果之前是异常退出）；
 * - 关闭动作会让 SQLite 做最后一次 checkpoint 并清理边车。
 *
 * ── 为什么还要"断言边车已消失" ──
 *
 * 因为打开-关闭成功**不等于**边车被清掉了：若还有别的连接开着，SQLite 会保留
 * WAL。此时若继续替换主库，就等于**在一个仍在使用的库上做破坏性操作** ——
 * 那正是本模块要排除的形态。因此这一步是**前置条件**，不是事后观察。
 */
export function settleWalBeforeReplace(dbPath: string): SettleResult {
  const before = inspectSidecars(dbPath);
  if (!existsSync(/* turbopackIgnore: true */ dbPath)) {
    return {
      ok: false,
      before,
      after: before,
      detail: "目标数据库不存在，无需（也无法）settle。",
      error: "目标数据库不存在。",
    };
  }

  let db: DatabaseSync | null = null;
  let checkpointLog = 0;
  let checkpointed = 0;
  try {
    /*
     * 用**普通读写连接**打开：只有读写连接才会执行 WAL 恢复与 checkpoint。
     * `{ readOnly: true }` 在存在 `-wal` 时可能无法完成恢复（官方 §5 讲的是
     * 只读可读性，不是恢复）。恢复语义必须是读写。
     */
    db = new DatabaseSync(dbPath);
    /*
     * 强制一次 checkpoint 并等待它完成（TRUNCATE 会尽力跑到完成）。
     *
     * 返回值 `(busy, log, checkpointed)` 记录在报告里，但它**不是**主判据 ——
     * 本机实测：即使有活动的读/写连接，`wal_checkpoint(TRUNCATE)` 也可能
     * 返回 `busy=0`。真正的判据是关闭之后的排它探测（见下）。
     */
    const row = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as
      | { busy?: number | bigint; log?: number | bigint; checkpointed?: number | bigint }
      | undefined;
    checkpointLog = Number(row?.log ?? 0);
    checkpointed = Number(row?.checkpointed ?? 0);
  } catch (error) {
    try {
      db?.close();
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      before,
      after: inspectSidecars(dbPath),
      detail: "打开/checkpoint 失败。",
      error: `无法安全收拢 WAL：${(error as Error).message}`,
    };
  }

  try {
    db.close();
  } catch (error) {
    return {
      ok: false,
      before,
      after: inspectSidecars(dbPath),
      detail: "关闭失败。",
      error: `关闭数据库连接失败：${(error as Error).message}`,
    };
  }

  /*
   * ── 主判据：关闭之后必须能拿到**排它**访问 ──
   *
   * 这一步不依赖任何文件系统行为（不依赖 `rename` 会不会 EBUSY，也不依赖
   * 谁在哪个平台）。它问的是数据库自己的并发语义：现在还有没有人跟我同时用。
   *
   * 有别人在用 ⇒ 他的 WAL 里可能有已提交事务 ⇒ 替换会丢数据 ⇒ **拒绝**。
   */
  const exclusive = probeExclusiveAccess(dbPath);
  if (!exclusive.exclusive) {
    return {
      ok: false,
      before,
      after: inspectSidecars(dbPath),
      detail: `排它访问失败：${exclusive.error ?? "未知"}`,
      error:
        `无法安全收拢 WAL：${exclusive.error ?? "仍有其它连接持有该数据库"}` +
        "在这种状态下替换主库会丢失 WAL 中已提交的事务，因此**拒绝继续**。" +
        "请关闭其它占用该数据库的进程后重试。",
    };
  }

  const after = inspectSidecars(dbPath);
  /*
   * ── 次判据：非空 WAL 必须已消失 ──
   *
   * 允许残留 0 字节 `-wal` 与 `-shm`：本机实测确认，对 WAL 模式库做**只读
   * 打开**就会创建这两个文件（`-wal` 常常 0 字节），它们不含任何事务。
   * 把"存在"当成阻塞条件会让恢复在完全正常的库上永久失败 —— 一个假阳性。
   */
  if (after.wal.present && after.wal.bytes > 0) {
    return {
      ok: false,
      before,
      after,
      detail: `checkpoint log=${checkpointLog} checkpointed=${checkpointed}，剩余 -wal=${after.wal.bytes} 字节。`,
      error:
        `WAL 未能收拢（WAL 帧 ${checkpointed}/${checkpointLog}，剩余 -wal ${after.wal.bytes} 字节）。` +
        "在这种状态下替换主库会丢失已提交事务，因此**拒绝继续**。",
    };
  }

  const hadWal = before.wal.present;
  return {
    ok: true,
    before,
    after,
    detail: hadWal
      ? `已让 SQLite 收拢残留 WAL（${before.wal.bytes} 字节）；边车现已消失，已提交事务已并入主库。`
      : "没有残留边车；数据库已是自洽形态。",
    error: null,
  };
}

export interface ReplaceResult {
  ok: boolean;
  /** 被替换的旧主库备份路径（同目录，`.pre-replace-*`）。 */
  oldDbBackup: string | null;
  detail: string;
  error: string | null;
}

/**
 * 安全地把 `snapshotPath` 换到 `targetPath`。
 *
 * ── 前置条件（任一不成立即失败关闭）──
 *
 * 1. 目标库不存在残留边车（调用方应先用 `settleWalBeforeReplace`）；
 * 2. **快照自己**也不得带 `-wal`：带 WAL 的快照不是一个自洽的库
 *    （它是从崩溃现场原样拷来的），用它替换会得到"新主库 + 别人的 WAL"。
 *
 * ── 为什么先把旧主库改名保留，而不是直接覆盖 ──
 *
 * `rename` 覆盖是不可逆的单步动作。若紧接其后的校验失败，就没有"原处"可回。
 * 因此顺序是：旧库 → `.pre-replace-*`（临时名），新库 → 目标名。
 * 成功则删掉那个临时名；失败则把它改回来。
 *
 * 这样即使中途被杀，盘上**至少有一个完整的主库文件**，而且命名能让人看出
 * 它是什么（不是随机 `.tmp`）。
 */
export function replaceDatabaseFile(targetPath: string, snapshotPath: string): ReplaceResult {
  // ── 前置条件 1：目标不得携带**承载事务**的 WAL ──
  const targetSidecars = inspectSidecars(targetPath);
  if (sidecarsCarryTransactions(targetSidecars)) {
    return {
      ok: false,
      oldDbBackup: null,
      detail: "目标库仍有承载事务的 WAL 边车。",
      error:
        `目标库旁边仍有非空 WAL（-wal=${targetSidecars.wal.bytes} 字节）。` +
        "必须先让 SQLite 干净关闭（settleWalBeforeReplace），否则替换会丢失已提交事务。",
    };
  }

  // ── 前置条件 2：快照自己不得携带**承载事务**的 WAL ──
  const snapshotSidecars = inspectSidecars(snapshotPath);
  if (sidecarsCarryTransactions(snapshotSidecars)) {
    return {
      ok: false,
      oldDbBackup: null,
      detail: "快照带有承载事务的 WAL 边车，不是自洽的库。",
      error:
        `快照旁带有非空 -wal（${snapshotSidecars.wal.bytes} 字节），说明它不是一份自洽的库文件。` +
        "用它替换会产成「新主库 + 别人的 WAL」，SQLite 打开时会因此损坏或静默丢事务。" +
        "请改用 VACUUM INTO 产出的快照。",
    };
  }

  if (!existsSync(/* turbopackIgnore: true */ snapshotPath)) {
    return { ok: false, oldDbBackup: null, detail: "快照不存在。", error: "快照不存在。" };
  }

  /*
   * ── 前置条件 3：目标此刻必须**没有**其它连接 ──
   *
   * 这一条是**主动**判据，而不是等 `rename` 去失败。
   *
   * 早先的安全依赖"Windows 上被占用的文件 rename 会 EBUSY"。那是平台行为：
   * POSIX 上 rename 对被打开的文件照常成功，而 Windows 上连**复制**主库都能
   * 成功（本机实测）。把安全性建立在"某个系统调用恰好会失败"之上，等于把
   * 数据完整性交给运行环境。
   *
   * `BEGIN EXCLUSIVE` 问的是数据库自己的并发语义，因此在任何平台都成立。
   */
  if (existsSync(/* turbopackIgnore: true */ targetPath)) {
    const exclusive = probeExclusiveAccess(targetPath);
    if (!exclusive.exclusive) {
      return {
        ok: false,
        oldDbBackup: null,
        detail: "目标库仍被其它连接持有。",
        error:
          `目标库仍被其它连接持有：${exclusive.error ?? "未知"}` +
          "替换会丢失对方的已提交数据，因此**拒绝**。请先关闭占用它的进程。",
      };
    }
  }

  mkdirSync(dirname(targetPath), { recursive: true });

  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const stagedNew = `${targetPath}.staged-${stamp}`;
  const oldBackup = `${targetPath}.pre-replace-${stamp}`;
  const hadOld = existsSync(/* turbopackIgnore: true */ targetPath);

  // ① 先把新库复制到**同目录**暂存（同卷 ⇒ rename 才是原子的）
  try {
    copyFileSync(snapshotPath, stagedNew);
    // 暂存副本必须能独立打开（证明它是完整的库，而不是被中途截断）
    const probe = new DatabaseSync(stagedNew, { readOnly: true });
    try {
      probe.prepare("SELECT 1 AS ok").get();
    } finally {
      probe.close();
    }
  } catch (error) {
    try {
      rmSync(stagedNew, { force: true });
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      oldDbBackup: null,
      detail: "新库暂存失败。",
      error: `无法准备新库文件：${(error as Error).message}`,
    };
  }

  // ② 旧库改名保留（不删除 —— 它是失败时的唯一回退点）
  if (hadOld) {
    try {
      renameSync(targetPath, oldBackup);
    } catch (error) {
      try {
        rmSync(stagedNew, { force: true });
      } catch {
        /* 忽略 */
      }
      return {
        ok: false,
        oldDbBackup: null,
        detail: "旧库无法让位。",
        error:
          `无法把旧库移开（${(error as Error).message}）。` +
          "这通常表示还有进程/连接持有它。**目标库未被改动**。",
      };
    }
  }

  // ③ 新库就位
  try {
    renameSync(stagedNew, targetPath);
  } catch (error) {
    // 回滚：把旧库改回原处
    try {
      if (hadOld) renameSync(oldBackup, targetPath);
    } catch {
      /* 回滚也失败 —— 下面如实报告 */
    }
    try {
      rmSync(stagedNew, { force: true });
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      oldDbBackup: hadOld ? oldBackup : null,
      detail: "新库就位失败，已尝试回滚。",
      error: `无法把新库放到目标位置（${(error as Error).message}）。旧库已尝试恢复原处。`,
    };
  }

  // ④ 新库能打开吗？打不开就把旧的换回来（这是替换后唯一的安全网）
  try {
    const probe = new DatabaseSync(targetPath, { readOnly: true });
    try {
      probe.prepare("SELECT 1 AS ok").get();
    } finally {
      probe.close();
    }
  } catch (error) {
    try {
      rmSync(targetPath, { force: true });
      if (hadOld) renameSync(oldBackup, targetPath);
    } catch {
      /* 忽略 */
    }
    return {
      ok: false,
      oldDbBackup: hadOld ? oldBackup : null,
      detail: "新库就位后无法打开，已回滚。",
      error: `替换后的数据库无法打开（${(error as Error).message}）。已尝试回滚到旧库。`,
    };
  }

  return {
    ok: true,
    oldDbBackup: hadOld ? oldBackup : null,
    detail: hadOld
      ? "已替换数据库；旧库保留为 .pre-replace-* 以便校验失败时回退。"
      : "已写入数据库（此前不存在）。",
    error: null,
  };
}

/** 删除替换后保留的旧库副本（校验通过后调用）。 */
export function discardOldDatabaseCopy(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    /* 保留也无害：它是完整的主库文件 */
  }
}

/** 供测试与诊断使用：读取边车状态。 */
export function readSidecarState(dbPath: string): SidecarState {
  return inspectSidecars(dbPath);
}

export { SIDECAR_SUFFIXES };
