import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { INVARIANT_STATEMENTS, MIGRATIONS, SCHEMA_PRAGMAS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

/**
 * 唯一的 SQLite 连接工厂。
 *
 * 只有 `src/repositories/sqlite/*` 允许 import 本模块。
 * UI 与 domain 层必须通过 repository 接口访问数据。
 */

/**
 * 默认数据库文件的路径。
 *
 * ── 为什么它是**函数**而不是模块级常量 ──
 *
 * 因为这行代码的求值时机决定了它会读到**哪一个** `CET6_DB_PATH`。
 *
 * 模块级常量在 **import 时**求值一次。于是任何"先 import、后设环境变量"
 * 的调用者都会拿到**默认库**（`<cwd>/data/cet6.db`）而不是它想指的那一个 ——
 * 而那个错误**不会报错**：一次 E2E 实例会把合成夹具写进开发库，
 * 同时它的读路径也指向开发库，于是所有断言照过、一切"看起来正常"。
 *
 * 本项目实测踩到过这个形态：A3 的 E2E 实例（本应写 `.e2e/cet6-a3.db`）
 * 因为静态 import 早于 `process.env.CET6_DB_PATH = ...` 的赋值，
 * 把合成课程包写进了 `<cwd>/data/cet6.db`。
 *
 * 改成函数之后，"用哪个库"在任何时刻都由**当时**的环境决定，
 * 调用方不再需要记住"必须先设 env 再 import"这条隐式规则。
 * 现有的 E2E 启动器用 `await import(...)` 绕开了它 —— 那是巧合，
 * 不是契约；这条改动让两种写法都正确。
 */
export function getDbFile(): string {
  return process.env.CET6_DB_PATH ?? join(process.cwd(), "data", "cet6.db");
}

export type DbHandle = DatabaseSync;

declare global {
  // dev 模式下 Next.js 会热重载模块，用 globalThis 缓存连接避免句柄泄漏。
  var __cet6Db: DatabaseSync | undefined;
}

/**
 * 库比当前代码更新时抛出的错误。
 *
 * 这是一个**必须让启动失败**的状态，不是可以降级处理的警告 —— 见 `openDatabase`。
 */
export class SchemaTooNewError extends Error {
  constructor(
    readonly dbVersion: number,
    readonly codeVersion: number,
  ) {
    super(
      `数据库 schema 版本 v${dbVersion} 高于当前应用支持的 v${codeVersion}。` +
        `这份库由更新的应用写入过，旧代码继续打开会误判表结构并可能覆盖 schema 元数据。` +
        `请使用写入过该库的新版本应用打开它。`,
    );
    this.name = "SchemaTooNewError";
  }
}

/** 读取已落库的 schema 版本；全新库返回 null。 */
function readSchemaVersion(db: DatabaseSync): number | null {
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value?: unknown }
      | undefined;
    if (!row?.value) return null;
    const parsed = Number(row.value);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    // schema_meta 尚未创建 —— 全新数据库
    return null;
  }
}

function columnExists(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => String(row.name) === column);
}

/**
 * 应用增量迁移。
 *
 * 必要性：`CREATE TABLE IF NOT EXISTS` 不会给已存在的表补列。
 * 没有这一步，任何在列新增之前创建的数据库文件都会在查询时崩掉。
 */
function applyMigrations(db: DatabaseSync): string[] {
  const applied: string[] = [];
  const current = readSchemaVersion(db);
  if (current === null || current >= SCHEMA_VERSION) return applied;

  for (const migration of MIGRATIONS) {
    if (migration.from < current) continue;
    for (const statement of migration.statements) {
      // 幂等保护：列已存在时跳过（例如手工改过库或重复执行）
      const addColumn = /ALTER TABLE (\w+) ADD COLUMN (\w+)/i.exec(statement);
      if (addColumn && columnExists(db, addColumn[1], addColumn[2])) continue;
      db.exec(statement);
    }
    applied.push(`v${migration.from}→v${migration.to}：${migration.description}`);
  }
  return applied;
}

/**
 * 应用结构不变量（在迁移之后、同一个事务内）。
 *
 * 它们与迁移的区别：迁移描述"从 vN 到 vN+1 需要执行的 DDL/DML"，
 * 而不变量描述"无论从哪个版本过来都必须成立的结构约束"。
 * 因此每次打开库都执行一遍（全部幂等）。
 *
 * 目前只有一条：归一化重复的进行中会话，再建唯一索引。
 * 详见 `schema.ts` 的 `INVARIANT_STATEMENTS`。
 */
function applyInvariants(db: DatabaseSync): void {
  for (const invariant of INVARIANT_STATEMENTS) {
    for (const statement of invariant.statements) {
      db.exec(statement);
    }
  }
}

/**
 * 打开（或创建）指定文件的库并应用 schema + 迁移。
 *
 * 导出它是为了让**迁移测试用与生产完全相同的路径**。
 * 早先测试手工复刻了这里的语句序列，结果复刻漏掉了幂等守卫，
 * 于是迁移演进后给出假红 —— 测试必须调用生产代码，
 * 否则它验证的是"复刻是否正确"而不是"迁移是否正确"。
 *
 * ── 版本语义（P0 修复）──
 *
 * 旧实现在这里**无条件**把 `schema_meta.schema_version` 写成当前版本号，
 * 于是出现了一个真实的破坏性路径：一份由新版本应用写入的库，
 * 被旧版本应用打开时会先被写成旧版本号。此后新版本应用再打开它，
 * 读到的"当前版本"偏低，就会**跳过迁移**并当作旧库使用 ——
 * 新表被当成不存在，而写入过的数据仍在库里。
 *
 * 现在按三态处理，且**只允许其中一个方向前进**：
 *
 * | 库版本 vs 代码版本 | 行为 |
 * | --- | --- |
 * | 库更新 | **抛 `SchemaTooNewError`**（失败关闭，绝不写入） |
 * | 库更旧 | 正常迁移，成功后原子地写入新版本 |
 * | 全新库 | 按最新 schema 建库 |
 *
 * 另外，schema 建表 + 迁移 + 版本写入现在**整体包在一个事务里**：
 * 中途失败不会留下"表加了一半、版本号却已前进"的半迁移状态。
 */
export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") {
    mkdirSync(dirname(file), { recursive: true });
  }
  const db = new DatabaseSync(file);

  // PRAGMA 必须在任何事务之外执行：journal_mode 无法在事务内切换。
  db.exec(SCHEMA_PRAGMAS);

  // ---- 版本守卫：先于任何 DDL/DML 判定 ----
  const current = readSchemaVersion(db);
  if (current !== null && current > SCHEMA_VERSION) {
    db.close();
    throw new SchemaTooNewError(current, SCHEMA_VERSION);
  }

  let applied: string[] = [];
  // 失败时**必须关掉句柄**再抛出。
  //
  // 为什么：迁移失败（例如某个新表与既有结构冲突）会抛错，而在此之前
  // 已经 `new DatabaseSync(file)` 打开了一个真实句柄。不关的话进程会一直持有
  // 这个库文件 —— 在 Windows 上后果是具体的：文件与它的 WAL 无法删除或移动，
  // 于是"迁移失败 → 修好 → 重试"这条恢复路径会在最后一步 EPERM 失败。
  // 由 `tests/course-import.test.ts` 的迁移失败注入用例固定。
  try {
    transaction(db, () => {
      db.exec(SCHEMA_SQL);
      applied = applyMigrations(db);
      applyInvariants(db);
      db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("schema_version", String(SCHEMA_VERSION));
    });
  } catch (error) {
    db.close();
    throw error;
  }

  if (applied.length > 0) {
    for (const item of applied) console.log(`[db] 已应用迁移 ${item}`);
  }
  return db;
}

export function getDb(): DatabaseSync {
  if (!globalThis.__cet6Db) {
    globalThis.__cet6Db = openDatabase(getDbFile());
  }
  return globalThis.__cet6Db;
}

/**
 * 只读打开一个**已存在**的库。
 *
 * ── 为什么需要它（实测确认的真实缺陷）──
 *
 * `openDatabase` 的职责是"打开**并确保** schema 就绪"：它执行 `SCHEMA_PRAGMAS`
 * （含 `PRAGMA journal_mode = WAL`）、跑 `SCHEMA_SQL`、应用迁移、写
 * `schema_meta.schema_version`。**这些全是写操作。**
 *
 * 于是产生了一条真实的破坏性路径：任何经过 `getRepositories()` → `getDb()` →
 * `openDatabase()` 的命令，**即使它自称"预演（dry-run，不写数据库）"或"只读"**，
 * 只要库还是旧版本就会把它迁移掉。这不是假设 —— 使用者的真实库就是这样
 * 从 v8 变成 v9 的，而当时运行的只是一条 dry-run。
 *
 * 因此"只读"不能靠"打开之后保证不写"来实现：**打开本身就是写**。
 * 结构性的做法是：只读路径**在原理上**不具备执行迁移的能力 ——
 * 用 SQLite 的只读连接，任何 DDL/DML/PRAGMA 写都会以
 * `attempt to write a readonly database` 失败（已在本机 Node v24.15.0 实测）。
 *
 * ── 三条硬语义（都由实测确定，不靠推断）──
 *
 * 1. **绝不创建**：文件不存在时只读打开会抛 `unable to open database file`，
 *    且**不会**留下新文件。因此"打开只读库"不可能意外造出一个空库。
 * 2. **绝不迁移**：不执行 `SCHEMA_PRAGMAS`、`SCHEMA_SQL`、迁移或版本写入。
 * 3. **绝不建目录**：不 `mkdirSync` —— 只读路径不该有任何文件系统副作用。
 *
 * 版本判定仍然执行，且**只读**：库比代码新时抛 `SchemaTooNewError`
 * （与写路径同一个失败关闭语义）。库比代码旧（如 v8）时不报错、
 * 不迁移，由调用方按"该版本缺少什么"如实处理。
 */
export function openDatabaseReadOnly(file: string): DatabaseSync {
  if (file === ":memory:") {
    // 内存库没有"已存在"的概念，只读打开它没有意义，且无法反映真实文件状态。
    throw new Error("openDatabaseReadOnly 不支持内存库：只读路径必须针对一个已存在的真实库。");
  }

  // 刻意**不** mkdirSync：只读打开不该创建任何目录或文件。
  const db = new DatabaseSync(file, { readOnly: true });

  // 只读连接上 `PRAGMA foreign_keys = ON` 是允许的（实测），
  // 但它不是必需的 —— 只读路径不写入，因此不做任何 PRAGMA 设置，
  // 把"零写入"做到字面意义上。

  // 版本守卫与写路径同一条判据：库更新 ⇒ 失败关闭。
  const current = readSchemaVersion(db);
  if (current !== null && current > SCHEMA_VERSION) {
    db.close();
    throw new SchemaTooNewError(current, SCHEMA_VERSION);
  }

  return db;
}

/**
 * 只读的 repository 集合见 `repositories/sqlite` 的 `createReadOnlyRepositories`
 * —— 它放在那一层是为了避免 `db/client` 反向依赖 repository 实现（会形成循环）。
 */

/** 测试与脚本使用：创建独立的内存库，不污染 dev 数据。 */
export function createTestDb(): DatabaseSync {
  return openDatabase(":memory:");
}

/**
 * 可重入事务。
 *
 * 背景（实测确认的缺陷）：
 * 旧实现用裸 `BEGIN`，SQLite 不支持事务嵌套 —— 在已开启的事务内再次调用会抛
 * "cannot start a transaction within a transaction"。因此 submitTask 这类
 * 多步写入无法简单地整体包一层事务，各 repository 方法各自开事务的行为必须被容纳。
 *
 * 解决方案：用 SQLite SAVEPOINT 实现可重入语义（已实测 `node:sqlite` 支持，
 * 且 `db.isTransaction` 可准确判断是否已在事务中）：
 * - 最外层：`BEGIN` … `COMMIT` / `ROLLBACK`（真正的原子边界）
 * - 内层嵌套：`SAVEPOINT` / `RELEASE` / `ROLLBACK TO`（仅保证内层失败不影响外层已写入的数据）
 *
 * 为什么不把内层事务去掉：那会让每个 repository 方法都要求由调用方保证事务上下文，
 * 破坏它们被独立调用的安全性（例如 saveAttempts 单独使用也必须是原子的）。
 * 可重入抽象让两种用法都正确，且不需要改各 repository 的既有写法。
 *
 * 失败语义：任一层抛错都会回滚到该层保存点；若最外层抛错，整个事务回滚。
 */

let savepointCounter = 0;

export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  // 已在事务中 → 用 SAVEPOINT 建立嵌套的原子子单元
  if (db.isTransaction) {
    savepointCounter += 1;
    const name = `sp_${savepointCounter}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const result = fn();
      db.exec(`RELEASE ${name}`);
      return result;
    } catch (error) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw error;
    }
  }

  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function resetDb(db: DatabaseSync): void {
  for (const table of [
    "review_item",
    "answer_attempt",
    "study_session",
    "study_task",
    "daily_plan",
    "skill_profile",
    "diagnostic_answer",
    "diagnostic_session",
    "exam_goal",
    "learner_profile",
  ]) {
    db.exec(`DELETE FROM ${table};`);
  }

  // Expert 事实台账**刻意不在**上面的清空列表里。
  //
  // 理由：`performance_event` / `assessment_event` 是只追加的不可变观测，
  // 清空它们会构成"绕过不可变性"的一条后门 —— 任何持有 db 句柄的代码
  // 都能借这个工具把历史抹掉（触发器只拦 UPDATE/DELETE，而这个工具做的正是 DELETE）。
  // 需要干净台账的测试应当新建库（`createTestDb()`），而不是把历史清零。
  //
  // 这里只清 `evidence_projection` —— 它是**可重建的派生投影**，
  // 不是事实来源，删空后可由不可变事件完整重算。
  db.exec("DELETE FROM evidence_projection;");

  // 课程层同样刻意不在这里：
  // - `course_exposure_event` 是只追加的曝光观测，清空它同样是绕过不可变性的后门；
  // - `course_package` / `course_canonical_link` 是内容索引与复核记录，
  //   它们也不是"学习者的业务数据"，需要干净状态的测试应当新建库。
}

/*
 * 兼容导出：`DB_FILE` 是一个**求值当时**的默认库路径常量。
 *
 * ── 为什么保留它，以及为什么新代码不应用它 ──
 *
 * 既有代码（`repositories/sqlite/index.ts` 的 `getReadOnlyRepositories`）
 * 以及若干测试引用它。它的语义是"**模块被 import 时**的默认库"，
 * 因此在"先设 env、后 import"的场景下仍然正确。
 *
 * 但"先 import、后设 env"的场景下它是**过期**的 —— 那正是本次实测踩到的
 * 隔离缺陷。任何会切换库的调用方都应当用 `getDbFile()`（每次现算）。
 *
 * 这里刻意**不删除**它：删除会迫使所有既有引用改成函数调用，
 * 而那些引用里有一部分（例如只读仓库的默认值）确实只想表达"默认库"。
 * 新代码一律用 `getDbFile()`。
 */
export const DB_FILE = getDbFile();
