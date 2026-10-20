import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION } from "@/db/schema";
import { SchemaTooNewError, openDatabase } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";

/**
 * schema 安全门禁（P0）。
 *
 * 这里验证的不是"迁移能跑"，而是三条**破坏性路径被关掉**：
 *
 * 1. 旧代码打开新库 —— 必须失败关闭，绝不把它降级；
 * 2. 正常 旧→新 迁移仍然可用；
 * 3. 迁移是原子的 —— 失败不留半迁移状态；
 * 4. v6 数据在升级到 v7 后一条不少。
 */

function newTempDir(): string {
  return mkdtempSync(join(tmpdir(), "cet6-schema-safety-"));
}

function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 句柄可能短暂残留；临时目录残留不影响断言 */
  }
}

/** 写一个高于当前代码版本的 schema_version，模拟"更新的应用打开过的库"。 */
function makeNewerDb(file: string, version: number): void {
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(String(version));
  db.close();
}

describe("P0：旧代码打开新库必须失败关闭", () => {
  it("库版本高于代码版本时抛 SchemaTooNewError", () => {
    const dir = newTempDir();
    const file = join(dir, "newer.db");
    try {
      makeNewerDb(file, SCHEMA_VERSION + 1);
      expect(() => openDatabase(file)).toThrow(SchemaTooNewError);
    } finally {
      cleanupDir(dir);
    }
  });

  it("失败关闭时**不修改**库中的版本号（核心缺陷：旧代码会把版本改低）", () => {
    const dir = newTempDir();
    const file = join(dir, "newer-preserve.db");
    try {
      const better = SCHEMA_VERSION + 3;
      makeNewerDb(file, better);

      // 旧代码尝试打开 —— 必须失败
      expect(() => openDatabase(file)).toThrow(SchemaTooNewError);

      // 关键断言：版本号仍是新版本，没有被降级
      const verify = new DatabaseSync(file);
      const version = verify.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      verify.close();
      expect(Number(version.value), "旧代码把新库的 schema_version 改低了").toBe(better);
    } finally {
      cleanupDir(dir);
    }
  });

  it("错误信息包含两个版本号，便于定位", () => {
    const dir = newTempDir();
    const file = join(dir, "newer-msg.db");
    try {
      makeNewerDb(file, SCHEMA_VERSION + 5);
      try {
        openDatabase(file);
        throw new Error("本应抛出 SchemaTooNewError");
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaTooNewError);
        const typed = error as SchemaTooNewError;
        expect(typed.dbVersion).toBe(SCHEMA_VERSION + 5);
        expect(typed.codeVersion).toBe(SCHEMA_VERSION);
        expect(typed.message).toContain(`v${SCHEMA_VERSION + 5}`);
        expect(typed.message).toContain(`v${SCHEMA_VERSION}`);
      }
    } finally {
      cleanupDir(dir);
    }
  });

  it("数据库层的触发器同样阻止版本下降（即使绕过 openDatabase 直接写 SQL）", () => {
    const dir = newTempDir();
    const file = join(dir, "trigger.db");
    try {
      // 先由当前代码建库 —— 触发器随 schema 一起建立
      openDatabase(file).close();

      const db = new DatabaseSync(file);
      // 直接执行旧代码会做的那条 UPSERT：把版本写成低值
      const downgrade = db.prepare(
        "INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      );
      expect(() => downgrade.run(String(SCHEMA_VERSION - 1)), "触发器未拦住版本下降").toThrow();

      // 相等或更高的写入仍被允许（幂等重写不能被打断）
      expect(() => downgrade.run(String(SCHEMA_VERSION))).not.toThrow();
      expect(() => downgrade.run(String(SCHEMA_VERSION + 1))).not.toThrow();

      db.close();
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("P0：正常的 旧→新 迁移仍然可用", () => {
  it("v6 库升级到当前版本后，版本号前进且触发器就位", () => {
    const dir = newTempDir();
    const file = join(dir, "v6-upgrade.db");
    try {
      // 手工造一个 v6 形态的库：只建 schema_meta 并标为 6
      const seed = new DatabaseSync(file);
      seed.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      seed.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '6')").run();
      seed.close();

      const db = openDatabase(file);
      const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(Number(version.value)).toBe(SCHEMA_VERSION);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      for (const table of ["learning_run", "performance_event", "assessment_event", "evidence_projection"]) {
        expect(tables).toContain(table);
      }
      db.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("全新库直接建到当前版本，且不需要走迁移", () => {
    const dir = newTempDir();
    const file = join(dir, "fresh.db");
    try {
      const db = openDatabase(file);
      const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(Number(version.value)).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("P0：迁移是原子的", () => {
  /**
   * 真实失败注入点。
   *
   * v5→v6 迁移执行 `ALTER TABLE exam_paper ADD COLUMN content_fingerprint TEXT`。
   * 把 `exam_paper` 预先建成**视图**，该 ALTER 必然抛
   * "Cannot add a column to a view"（已实测确认）。
   * 这正是我们需要的注入：一条迁移链中段的真实失败。
   *
   * 由此可以验证两条不变式：
   *   · 版本号不前进；
   *   · 更早的建表语句（v7 的台账表）也不留下痕迹 —— 即整体回滚，
   *     而不是"前面的成功了、后面的失败了"。
   */
  function seedBrokenV5Db(file: string): void {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '5')").run();
    // 用一个视图冒充 exam_paper：它让 ALTER ADD COLUMN 无法执行
    db.exec("CREATE VIEW exam_paper AS SELECT 1 AS x");
    db.close();
  }

  it("迁移中段失败时整体回滚：版本不前进、台账表不留痕", () => {
    const dir = newTempDir();
    const file = join(dir, "atomic.db");
    try {
      seedBrokenV5Db(file);

      // 迁移必须在 v6 的 ALTER 处失败
      expect(() => openDatabase(file), "注入的失败未被触发，测试前提不成立").toThrow(/view/i);

      const verify = new DatabaseSync(file);

      // 不变式 1：版本号没有前进（仍是 5）
      const version = verify.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(Number(version.value), "迁移失败后版本号却前进了").toBe(5);

      // 不变式 2：v7 的表没有被留下 —— 证明是整体回滚，不是部分提交
      const tables = verify
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      for (const table of ["learning_run", "performance_event", "assessment_event", "evidence_projection"]) {
        expect(tables, `迁移失败却留下了表 ${table} —— 不是整体回滚`).not.toContain(table);
      }

      verify.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("失败后重新打开仍然失败（不产生'失败一次就永久损坏'的状态）", () => {
    const dir = newTempDir();
    const file = join(dir, "atomic-twice.db");
    try {
      seedBrokenV5Db(file);
      expect(() => openDatabase(file)).toThrow();
      // 第二次尝试同样在同一个真实缺陷处失败，而不是产生新的错误形态
      expect(() => openDatabase(file)).toThrow(/view/i);
    } finally {
      cleanupDir(dir);
    }
  });

  it("修好结构后同一库可以正常迁移（回滚没有留下副作用）", () => {
    const dir = newTempDir();
    const file = join(dir, "atomic-recover.db");
    try {
      seedBrokenV5Db(file);
      expect(() => openDatabase(file)).toThrow();

      // 换掉那个不兼容的视图，模拟用户修好了包/库结构
      const fix = new DatabaseSync(file);
      fix.exec("DROP VIEW exam_paper");
      fix.close();

      // 现在必须能走完整条迁移链
      const db = openDatabase(file);
      const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(Number(version.value)).toBe(SCHEMA_VERSION);
      const cols = db
        .prepare("PRAGMA table_info(exam_paper)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(cols).toContain("content_fingerprint");
      db.close();
    } finally {
      cleanupDir(dir);
    }
  });
});

/**
 * v6 形态的完整 DDL。
 *
 * 为什么要写成**完整的旧形态**而不是"建新库再改版本号"：
 * 后者的注释自己承认做不到 v6 形态（"代码只有 v7"），
 * 于是它实际上只验证了"重新打开同一个 v7 库" —— 与它标题声称的
 * "v6 → 当前 schema 数据保全"是两件不同的事。
 * 一个名不副实的迁移测试比没有测试更糟：它给出虚假的安全感。
 *
 * 这里照抄 v6 的真实形态（来源：`src/db/schema.ts` 在 v6 时的列集合，
 * 以及 `MIGRATIONS` 里 v1→v6 的全部加列），只保留迁移真正需要的最小集：
 * schema_meta + 需要保全数据的表（learner / exam_paper / paper_asset /
 * paper_study_state）+ 迁移会触碰的 exam_paper（v6 已有 content_fingerprint）。
 */
const V6_DDL = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS learner_profile (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, weekday_minutes INTEGER NOT NULL,
  weekend_minutes INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS exam_goal (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, exam_name TEXT NOT NULL, exam_date TEXT NOT NULL,
  target_score INTEGER NOT NULL, score_history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS skill_profile (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL UNIQUE, skills TEXT NOT NULL,
  dimensions TEXT NOT NULL DEFAULT '[]', weaknesses TEXT NOT NULL DEFAULT '[]',
  recommendations TEXT NOT NULL DEFAULT '[]', unassessed_notices TEXT NOT NULL DEFAULT '[]',
  based_on_diagnostic TEXT, updated_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS daily_plan (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, plan_date TEXT NOT NULL, available_minutes INTEGER NOT NULL,
  planned_for_minutes INTEGER NOT NULL, generated_by TEXT NOT NULL, revision_count INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT '[]', warnings TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(profile_id, plan_date));

-- v5 引入、v6 增加 content_fingerprint 的真实形态
CREATE TABLE IF NOT EXISTS exam_paper (
  id TEXT PRIMARY KEY, exam_type TEXT NOT NULL, exam_year INTEGER NOT NULL, session TEXT NOT NULL,
  variant TEXT NOT NULL, exam_date TEXT, source_kind TEXT NOT NULL, verification_status TEXT NOT NULL,
  provenance_note TEXT NOT NULL, provenance_ref TEXT, verification_note TEXT,
  content_version INTEGER NOT NULL, partial INTEGER NOT NULL DEFAULT 0, package_path TEXT NOT NULL,
  manifest_checksum TEXT NOT NULL, content_fingerprint TEXT,
  section_count INTEGER NOT NULL, question_count INTEGER NOT NULL,
  imported_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(exam_type, exam_year, session, variant));

CREATE TABLE IF NOT EXISTS paper_asset (
  paper_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, relative_path TEXT NOT NULL,
  mime_type TEXT NOT NULL, bytes INTEGER NOT NULL, checksum TEXT NOT NULL, label TEXT,
  PRIMARY KEY (paper_id, id));

CREATE TABLE IF NOT EXISTS paper_study_state (
  paper_id TEXT PRIMARY KEY, pool TEXT NOT NULL DEFAULT 'training', updated_at TEXT NOT NULL);
`;

/**
 * 一个"生产形态的 v6 库"：含已导入的真实试卷索引与学习者数据。
 * 这是迁移真正会遇到的数据形态（v7/v8 之前的用户就是这样）。
 */
function seedProductionShapedV6(db: DatabaseSync): void {
  db.exec(V6_DDL);
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '6')").run();

  // 学习者 + 目标（Phase 1 用户的真实数据）
  db.prepare(
    "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run("p1", "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "INSERT INTO exam_goal (id, profile_id, exam_name, exam_date, target_score, score_history, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("g1", "p1", "CET-6", "2026-12-12", 550, "[]", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "INSERT INTO skill_profile (id, profile_id, skills, dimensions, weaknesses, recommendations, unassessed_notices, based_on_diagnostic, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run("s1", "p1", '{"listening":{},"reading":{},"writing":{},"translation":{}}', "[]", "[]", "[]", "[]", "d1", "2026-01-02T00:00:00.000Z");

  // 已导入的真实试卷索引（这是最不该在迁移中丢失的数据）
  db.prepare(
    `INSERT INTO exam_paper (id, exam_type, exam_year, session, variant, source_kind, verification_status,
       provenance_note, content_version, package_path, manifest_checksum, content_fingerprint,
       section_count, question_count, imported_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    "cet6-2024-12-set1", "CET6", 2024, "December", "set1", "real_past_paper", "partially_verified",
    "来源说明", 4, "2024-12-set1", "checksum-abc", "fingerprint-abc",
    8, 57, "2026-01-04T00:00:00.000Z", "2026-01-04T00:00:00.000Z",
  );
  db.prepare(
    `INSERT INTO paper_asset (paper_id, id, kind, relative_path, mime_type, bytes, checksum, label)
     VALUES (?,?,?,?,?,?,?,?)`,
  ).run("cet6-2024-12-set1", "listening-full", "audio", "assets/listening-full.m4a", "audio/mp4", 123456, "asset-sum", "整卷录音");
  db.prepare("INSERT INTO paper_study_state (paper_id, pool, updated_at) VALUES (?,?,?)").run(
    "cet6-2024-12-set1", "training", "2026-01-04T00:00:00.000Z",
  );
}

describe("P0：v6 → 当前 schema 的生产形态迁移（真实 v6 夹具）", () => {
  it("真实 v6 库升级后：学习者与试卷数据一条不少，且新表就位", () => {
    const dir = newTempDir();
    const file = join(dir, "v6-production.db");
    try {
      const seed = new DatabaseSync(file);
      seedProductionShapedV6(seed);
      const before = {
        learner: Number((seed.prepare("SELECT COUNT(*) AS c FROM learner_profile").get() as { c: number }).c),
        goal: Number((seed.prepare("SELECT COUNT(*) AS c FROM exam_goal").get() as { c: number }).c),
        skill: Number((seed.prepare("SELECT COUNT(*) AS c FROM skill_profile").get() as { c: number }).c),
        paper: Number((seed.prepare("SELECT COUNT(*) AS c FROM exam_paper").get() as { c: number }).c),
        asset: Number((seed.prepare("SELECT COUNT(*) AS c FROM paper_asset").get() as { c: number }).c),
        pool: Number((seed.prepare("SELECT COUNT(*) AS c FROM paper_study_state").get() as { c: number }).c),
      };
      expect(before.paper, "夹具前提：应有 1 份试卷").toBe(1);
      seed.close();

      // 走**生产路径**迁移（不是测试复刻）
      const db = openDatabase(file);

      // 版本前进到当前
      const version = Number(
        (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as { value: string }).value,
      );
      expect(version).toBe(SCHEMA_VERSION);

      // 数据一条不少
      for (const [table, count] of [
        ["learner_profile", before.learner],
        ["exam_goal", before.goal],
        ["skill_profile", before.skill],
        ["exam_paper", before.paper],
        ["paper_asset", before.asset],
        ["paper_study_state", before.pool],
      ] as const) {
        const after = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
        expect(after, `${table} 的数据在迁移中丢了`).toBe(count);
      }

      // 关键字段逐项核对（不只是行数）
      const paper = db
        .prepare("SELECT content_version, source_kind, verification_status, content_fingerprint, question_count FROM exam_paper WHERE id = ?")
        .get("cet6-2024-12-set1") as Record<string, unknown>;
      expect(Number(paper.content_version)).toBe(4);
      expect(String(paper.source_kind)).toBe("real_past_paper");
      expect(String(paper.verification_status)).toBe("partially_verified");
      expect(String(paper.content_fingerprint)).toBe("fingerprint-abc");
      expect(Number(paper.question_count)).toBe(57);

      // 用户的训练池策略不被重置（核心不变式）
      const pool = db.prepare("SELECT pool FROM paper_study_state WHERE paper_id = ?").get("cet6-2024-12-set1") as {
        pool: string;
      };
      expect(pool.pool).toBe("training");

      // 新表就位且为空（迁移不伪造历史）
      for (const table of ["learning_run", "performance_event", "assessment_event", "evidence_projection"]) {
        const count = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
        expect(count, `${table} 应存在且为空`).toBe(0);
      }

      // 不变量也已建立（v8 的唯一索引）
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uniq_run_single_in_progress'")
        .all();
      expect(index).toHaveLength(1);

      db.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("真实 v6 库迁移后，Expert 训练可以正常开始（迁移产物可用，不只是结构存在）", () => {
    const dir = newTempDir();
    const file = join(dir, "v6-usable.db");
    try {
      const seed = new DatabaseSync(file);
      seedProductionShapedV6(seed);
      seed.close();

      const db = openDatabase(file);
      const repos = createSqliteRepositories(db);

      // 迁移后的库能被 repository 边界正常读写
      expect(repos.learner.getProfile()?.displayName).toBe("Learner");
      expect(repos.papers.countPapers()).toBe(1);

      // Expert 台账在新库上可写（这是迁移的真实目的：让新功能在旧库上可用）
      const run = repos.expert.startRun({
        id: "run-after-migration",
        profileId: "p1",
        paperId: "cet6-2024-12-set1",
        contentVersion: 4,
        sectionId: "reading.careful_reading",
        sectionType: "reading.careful_reading",
        groupIds: ["g1"],
        itemCount: 1,
        startedAt: "2026-01-05T00:00:00.000Z",
      });
      expect(run.status).toBe("in_progress");
      expect(repos.expert.findInProgressRun("p1", "cet6-2024-12-set1", 4, "reading.careful_reading")?.id).toBe(
        "run-after-migration",
      );

      db.close();
    } finally {
      cleanupDir(dir);
    }
  });
});

describe("P0：迁移链结构", () => {
  it("迁移链必须连续覆盖到当前版本", () => {
    const sorted = [...MIGRATIONS].sort((a, b) => a.from - b.from);
    let expected = 1;
    for (const migration of sorted) {
      expect(migration.from, `迁移链断裂：期望 from=${expected}`).toBe(expected);
      evenStep(migration.to, migration.from);
      expected = migration.to;
    }
    expect(expected).toBe(SCHEMA_VERSION);
  });
});

describe("P0：结构不变量在脏数据上仍然可用", () => {
  /**
   * 这一组针对一个**实测确认的严重风险**（本轮修复中发现自己引入的）：
   *
   * `uniq_run_single_in_progress` 是部分唯一索引。若库里已经存在
   * **同键多条 in_progress** 行（早先"已完成优先"的查询缺陷会真实积累出这种数据 ——
   * 用户反复点"再练一次"却看不到新会话），那么直接 `CREATE UNIQUE INDEX`
   * 会抛 `UNIQUE constraint failed`。
   *
   * 它发生在**建库阶段**，后果是**整个库打不开** —— 比它要修的问题严重得多。
   * 因此索引的创建被移到 `INVARIANT_STATEMENTS`：先把多余的行标为 abandoned，
   * 再建索引。
   */
  function seedV7WithDuplicateInProgress(file: string): void {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '7')").run();
    // v7 形态的 learning_run（无唯一索引）
    db.exec(`CREATE TABLE learning_run (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, paper_id TEXT NOT NULL,
      content_version INTEGER NOT NULL, section_id TEXT NOT NULL, section_type TEXT NOT NULL,
      group_ids TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'in_progress',
      item_count INTEGER NOT NULL DEFAULT 0, started_at TEXT NOT NULL, submitted_at TEXT,
      duration_seconds INTEGER, created_at TEXT NOT NULL)`);
    // 同键三条 in_progress —— 正是旧缺陷会留下的形态
    const insert = db.prepare(
      `INSERT INTO learning_run (id, profile_id, paper_id, content_version, section_id, section_type, started_at, created_at)
       VALUES (?, 'p1', 'paper1', 1, 'reading.careful_reading', 'reading.careful_reading', ?, ?)`,
    );
    insert.run("r1", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    insert.run("r2", "2026-01-02T00:00:00.000Z", "2026-01-02T00:00:00.000Z");
    insert.run("r3", "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
    db.close();
  }

  it("存在重复进行中会话的旧库**仍能打开**（不因建索引而崩）", () => {
    const dir = newTempDir();
    const file = join(dir, "dirty.db");
    try {
      seedV7WithDuplicateInProgress(file);

      // 关键：必须能打开，而不是抛 UNIQUE constraint failed
      let opened: DatabaseSync | null = null;
      expect(() => {
        opened = openDatabase(file);
      }, "脏数据导致整个库打不开").not.toThrow();

      const db = opened!;
      const version = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      };
      expect(Number(version.value)).toBe(SCHEMA_VERSION);
      db.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("归一化只改状态、不删数据，且恰好保留一条进行中会话", () => {
    const dir = newTempDir();
    const file = join(dir, "normalize.db");
    try {
      seedV7WithDuplicateInProgress(file);
      const db = openDatabase(file);

      // 三条都还在（没有任何数据被删除）
      const total = Number(
        (db.prepare("SELECT COUNT(*) AS c FROM learning_run").get() as { c: number }).c,
      );
      expect(total, "归一化不应删除任何行").toBe(3);

      // 恰好一条 in_progress，且是**最新创建**的那条
      const inProgress = db
        .prepare("SELECT id FROM learning_run WHERE status = 'in_progress'")
        .all()
        .map((row) => String((row as { id: unknown }).id));
      expect(inProgress).toHaveLength(1);
      expect(inProgress[0]).toBe("r3");

      // 其余被标为 abandoned
      const abandoned = db
        .prepare("SELECT id FROM learning_run WHERE status = 'abandoned' ORDER BY id")
        .all()
        .map((row) => String((row as { id: unknown }).id));
      expect(abandoned).toEqual(["r1", "r2"]);

      // 索引确实建立了
      const index = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='uniq_run_single_in_progress'")
        .all();
      expect(index).toHaveLength(1);

      db.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("不变量是幂等的：重复打开同一个库不改变结果", () => {
    const dir = newTempDir();
    const file = join(dir, "idem-invariant.db");
    try {
      seedV7WithDuplicateInProgress(file);
      openDatabase(file).close();
      const second = openDatabase(file);
      const counts = second
        .prepare("SELECT status, COUNT(*) AS c FROM learning_run GROUP BY status ORDER BY status")
        .all()
        .map((row) => `${String((row as { status: unknown }).status)}=${Number((row as { c: unknown }).c)}`);
      expect(counts).toEqual(["abandoned=2", "in_progress=1"]);
      second.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("索引生效：归一化后无法再插入第二条同键进行中会话", () => {
    const dir = newTempDir();
    const file = join(dir, "enforced.db");
    try {
      seedV7WithDuplicateInProgress(file);
      const db = openDatabase(file);
      expect(() =>
        db
          .prepare(
            `INSERT INTO learning_run (id, profile_id, paper_id, content_version, section_id, section_type, started_at, created_at)
             VALUES ('dup','p1','paper1',1,'reading.careful_reading','reading.careful_reading','t','t')`,
          )
          .run(),
      ).toThrow();
      db.close();
    } finally {
      cleanupDir(dir);
    }
  });
});

/** 每条迁移必须恰好前进一格，避免"跳版"导致中间版本无法从任何起点到达。 */
function evenStep(to: number, from: number): void {
  expect(to).toBe(from + 1);
}
