import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA_VERSION } from "@/db/schema";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { openDatabase, resetDb } from "@/db/client";

/**
 * 迁移测试。
 *
 * 目的不是"迁移能跑"，而是**证明旧库升级到新 schema 后用户数据仍在**。
 * 做法：手工构造一个 Phase 1（v4）形态的库并塞入真实用户数据，
 * 然后让当前的建库流程作用其上，最后断言数据完好且新能力可用。
 *
 * 为什么不用备份的旧库文件：版本化二进制夹具会随 schema 演进腐坏，
 * 而手工构造的旧形态是**可审阅的代码** —— 它明确写清了"v4 长什么样"。
 */

const V4_DDL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS learner_profile (
  id TEXT PRIMARY KEY, display_name TEXT NOT NULL, weekday_minutes INTEGER NOT NULL,
  weekend_minutes INTEGER NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS exam_goal (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, exam_name TEXT NOT NULL, exam_date TEXT NOT NULL,
  target_score INTEGER NOT NULL, score_history TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS diagnostic_session (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, started_at TEXT NOT NULL, completed_at TEXT,
  item_ids TEXT NOT NULL DEFAULT '[]', partial INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS diagnostic_answer (
  id TEXT PRIMARY KEY, session_id TEXT NOT NULL, item_id TEXT NOT NULL, dimension TEXT NOT NULL,
  choice_id TEXT, answer_text TEXT, skipped INTEGER NOT NULL DEFAULT 0, submitted_at TEXT NOT NULL,
  UNIQUE(session_id, item_id));
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
CREATE TABLE IF NOT EXISTS study_task (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, kind TEXT NOT NULL, skill TEXT NOT NULL, priority TEXT NOT NULL,
  title TEXT NOT NULL, rationale TEXT NOT NULL, estimated_minutes INTEGER NOT NULL, content_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending', completed_at TEXT, sort_order INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS study_session (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, task_id TEXT, kind TEXT NOT NULL, skill TEXT NOT NULL,
  started_at TEXT NOT NULL, finished_at TEXT NOT NULL, duration_minutes INTEGER NOT NULL,
  correct_count INTEGER NOT NULL DEFAULT 0, total_count INTEGER NOT NULL DEFAULT 0,
  score REAL NOT NULL DEFAULT 0, feedback_summary TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS answer_attempt (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, task_id TEXT, content_item_id TEXT NOT NULL,
  answer_text TEXT, choice_id TEXT, correct INTEGER NOT NULL DEFAULT 0, score REAL NOT NULL DEFAULT 0,
  feedback TEXT NOT NULL DEFAULT '', error_tags TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS review_item (
  id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, content_item_id TEXT NOT NULL, content_ref TEXT NOT NULL,
  skill TEXT NOT NULL, prompt TEXT NOT NULL, due_on TEXT NOT NULL, stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0, reps INTEGER NOT NULL DEFAULT 0, lapses INTEGER NOT NULL DEFAULT 0,
  last_reviewed_on TEXT, created_at TEXT NOT NULL, UNIQUE(profile_id, content_item_id));
`;

/**
 * 用**生产的建库流程**升级一个已存在的库文件（不自建复刻）。
 *
 * ── 为什么改成调用生产代码 ──
 *
 * 早先这里手工复刻了 `client.ts` 的语句序列：先 `exec(SCHEMA_SQL)`，
 * 再逐条跑迁移。那个复刻漏掉了生产路径里的**幂等守卫**
 * （`client.ts` 的 `applyMigrations` 遇到已存在的列会跳过 ALTER）。
 *
 * 后果是真实的：`SCHEMA_SQL` 用 `CREATE TABLE IF NOT EXISTS` 建表时
 * 会带上**最新**列定义，因此对 v4 库而言 `exam_paper` 会被新建成含
 * `content_fingerprint` 的表，随后 v6 的 ALTER 重复加列 → 迁移报错。
 *
 * 生产路径有守卫所以没事，但**测试复刻过时**就会给出假红。
 * 复刻本身才是缺陷源：测试必须调用生产代码，
 * 否则它验证的是"复刻是否正确"，而不是"迁移是否正确"。
 *
 * 调用前请先 `close()` 掉写入用的原始句柄。
 */
function applyCurrentSchema(file: string): DatabaseSync {
  return openDatabase(file);
}

function newTempDir(): string {
  return mkdtempSync(join(tmpdir(), "cet6-migration-"));
}

/**
 * 清理临时目录。
 *
 * 必须容忍 EPERM：WAL 模式下刚关闭的 SQLite 仍可能短暂持有 -wal/-shm 句柄，
 * Windows 上会让目录删除失败。测试产物残留在系统临时目录里无害，
 * 因此这里不把清理失败当成测试失败 —— 否则会产生与被测逻辑无关的假红。
 */
function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 忽略：临时目录残留不影响断言 */
  }
}

function seedV4User(db: DatabaseSync): void {
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '4')").run();
  db.prepare(
    "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run("p1", "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "INSERT INTO exam_goal (id, profile_id, exam_name, exam_date, target_score, score_history, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
  ).run("g1", "p1", "CET-6 2026-12", "2026-12-12", 550, "[]", "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare(
    "INSERT INTO skill_profile (id, profile_id, skills, dimensions, weaknesses, recommendations, unassessed_notices, based_on_diagnostic, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
  ).run(
    "s1",
    "p1",
    JSON.stringify({ listening: {}, reading: {}, writing: {}, translation: {} }),
    "[]",
    "[]",
    "[]",
    "[]",
    "d1",
    "2026-01-02T00:00:00.000Z",
  );
  db.prepare(
    "INSERT INTO daily_plan (id, profile_id, plan_date, available_minutes, planned_for_minutes, generated_by, revision_count, notes, warnings, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("plan1", "p1", "2026-01-03", 60, 45, "deterministic_planner", 2, '["原计划"]', '["短日模式"]', "2026-01-03T00:00:00.000Z", "2026-01-03T00:00:00.000Z");
  db.prepare(
    "INSERT INTO study_task (id, plan_id, kind, skill, priority, title, rationale, estimated_minutes, content_ref, status, completed_at, sort_order) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("t1", "plan1", "reading_comprehension", "reading", "core", "阅读训练", "弱项", 12, null, "completed", "2026-01-03T01:00:00.000Z", 0);
  db.prepare(
    "INSERT INTO answer_attempt (id, profile_id, task_id, content_item_id, answer_text, choice_id, correct, score, feedback, error_tags, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
  ).run("a1", "p1", "t1", "reading-1", null, "B", 1, 1, "正确", "[]", "2026-01-03T01:00:00.000Z");
  db.prepare(
    "INSERT INTO review_item (id, profile_id, content_item_id, content_ref, skill, prompt, due_on, stability, difficulty, reps, lapses, last_reviewed_on, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run("r1", "p1", "reading-1:q3", '{"contentType":"reading_passage","contentId":"reading-1"}', "reading", "第 3 题", "2026-01-04", 0, 0, 0, 0, null, "2026-01-03T01:00:00.000Z");
}

describe("v4 → v5 迁移", () => {
  it("升级后 Phase 1 的用户数据一条不少", () => {
    const dir = newTempDir();
    const file = join(dir, "old.db");
    try {
      const db = new DatabaseSync(file);
      db.exec(V4_DDL);
      seedV4User(db);

      const before = {
        learner_profile: (db.prepare("SELECT COUNT(*) AS c FROM learner_profile").get() as { c: number }).c,
        exam_goal: (db.prepare("SELECT COUNT(*) AS c FROM exam_goal").get() as { c: number }).c,
        study_task: (db.prepare("SELECT COUNT(*) AS c FROM study_task").get() as { c: number }).c,
        answer_attempt: (db.prepare("SELECT COUNT(*) AS c FROM answer_attempt").get() as { c: number }).c,
        review_item: (db.prepare("SELECT COUNT(*) AS c FROM review_item").get() as { c: number }).c,
        daily_plan: (db.prepare("SELECT COUNT(*) AS c FROM daily_plan").get() as { c: number }).c,
        skill_profile: (db.prepare("SELECT COUNT(*) AS c FROM skill_profile").get() as { c: number }).c,
      };

      // 用生产路径升级：先关掉写入句柄，再让 openDatabase 打开同一个文件
      db.close();
      const upgraded = applyCurrentSchema(file);
      upgraded.close();

      // 重新打开，确认落盘后的状态
      const reopened = new DatabaseSync(file);
      for (const [table, count] of Object.entries(before)) {
        const after = (reopened.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
        expect(Number(after), `${table} 的数据在迁移中丢了`).toBe(Number(count));
      }

      // 自定义的关键值不被改写
      const goal = reopened.prepare("SELECT exam_date, target_score FROM exam_goal").get() as {
        exam_date: string;
        target_score: number;
      };
      expect(goal.exam_date).toBe("2026-12-12");
      expect(goal.target_score).toBe(550);

      // planner 的 warnings 列（v2 加的）依然完好
      const plan = reopened.prepare("SELECT warnings, revision_count FROM daily_plan").get() as {
        warnings: string;
        revision_count: number;
      };
      expect(plan.warnings).toContain("短日模式");
      expect(plan.revision_count).toBe(2);

      reopened.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("迁移后新的试卷表可用，且旧数据仍在", () => {
    const dir = newTempDir();
    const file = join(dir, "old.db");
    try {
      const db = new DatabaseSync(file);
      db.exec(V4_DDL);
      seedV4User(db);
      db.close();
      const migrated = applyCurrentSchema(file);

      const repos = createSqliteRepositories(migrated);

      // 旧数据通过 repository 边界仍然可读
      expect(repos.learner.getProfile()?.displayName).toBe("Learner");
      expect(repos.learner.getGoal("p1")?.examDate).toBe("2026-12-12");
      expect(repos.review.listAll("p1")).toHaveLength(1);
      expect(repos.records.listRecentAttempts("p1", 10)).toHaveLength(1);

      // 新表可用且为空
      expect(repos.papers.countPapers()).toBe(0);

      // 版本号已提升
      const version = (migrated.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      }).value;
      expect(Number(version)).toBe(SCHEMA_VERSION);

      migrated.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("迁移是幂等的：重复执行不报错也不重复加列", () => {
    const dir = newTempDir();
    const file = join(dir, "idem.db");
    try {
      const seed = new DatabaseSync(file);
      seed.exec(V4_DDL);
      seedV4User(seed);
      seed.close();

      const first = applyCurrentSchema(file);
      const firstColumns = first
        .prepare("PRAGMA table_info(skill_profile)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      first.close();

      // 第二次走完整生产路径：应不报错，且不重复加列
      expect(() => {
        const second = applyCurrentSchema(file);
        const columns = second
          .prepare("PRAGMA table_info(skill_profile)")
          .all()
          .map((row) => String((row as { name: unknown }).name));
        expect(columns.filter((name) => name === "unassessed_notices")).toHaveLength(1);
        expect(columns.filter((name) => name === "content_fingerprint")).toHaveLength(0);
        second.close();
      }).not.toThrow();

      expect(firstColumns.filter((name) => name === "unassessed_notices")).toHaveLength(1);
    } finally {
      cleanupDir(dir);
    }
  });

  it("全新库直接建到当前版本，不需要走迁移", () => {
    const dir = newTempDir();
    const file = join(dir, "fresh.db");
    try {
      const db = applyCurrentSchema(file);
      const version = (db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as {
        value: string;
      }).value;
      expect(Number(version)).toBe(SCHEMA_VERSION);
      // 全新库必须带上 v6 新增的列（否则查询会崩）
      const paperColumns = db
        .prepare("PRAGMA table_info(exam_paper)")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(paperColumns).toContain("content_fingerprint");
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => String((row as { name: unknown }).name));
      expect(tables).toContain("exam_paper");
      db.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("迁移链完整：每个 from 都能接到下一个 to", () => {
    const sorted = [...MIGRATIONS].sort((a, b) => a.from - b.from);
    let expected = 1;
    for (const migration of sorted) {
      expect(migration.from, `迁移链断裂：期望 from=${expected}，实际 from=${migration.from}`).toBe(expected);
      expect(migration.to).toBe(migration.from + 1);
      expect(migration.description.length).toBeGreaterThan(10);
      expected = migration.to;
    }
    expect(expected).toBe(SCHEMA_VERSION);
  });

  it("没有迁移会删除用户数据（禁止用 DROP/DELETE 当作迁移手段）", () => {
    for (const migration of MIGRATIONS) {
      for (const statement of migration.statements) {
        const upper = statement.toUpperCase();
        expect(upper, `${migration.description} 里出现 DROP`).not.toContain("DROP ");
        expect(upper, `${migration.description} 里出现 DELETE FROM`).not.toContain("DELETE FROM");
        expect(upper, `${migration.description} 里出现 TRUNCATE`).not.toContain("TRUNCATE");
      }
    }
  });

  it("resetDb 只清业务表，不动 schema 与试卷索引之外的表结构", () => {
    const dir = newTempDir();
    const file = join(dir, "reset.db");
    try {
      const db = applyCurrentSchema(file);
      const repos = createSqliteRepositories(db);
      repos.learner.saveProfile(null, {
        displayName: "Learner",
        preferences: { weekdayMinutes: 60, weekendMinutes: 120 },
        examName: "CET6",
        examDate: "2026-12-12",
        targetScore: 550,
      });
      expect(repos.learner.isOnboarded()).toBe(true);

      resetDb(db);
      expect(repos.learner.isOnboarded()).toBe(false);
      // schema_meta 不被清空
      const version = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get();
      expect(version).toBeTruthy();
      db.close();
    } finally {
      cleanupDir(dir);
    }
  });

  it("数据库文件在磁盘上真实产生（不是内存假象）", () => {
    const dir = newTempDir();
    const file = join(dir, "real.db");
    try {
      const db = applyCurrentSchema(file);
      db.prepare(
        "INSERT INTO exam_paper (id, exam_type, exam_year, session, variant, source_kind, verification_status, provenance_note, content_version, package_path, manifest_checksum, content_fingerprint, section_count, question_count, imported_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
      ).run("p", "CET6", 2024, "December", "set1", "test_fixture", "unverified", "note", 1, "dir", "c", null, 8, 57, "t", "t");
      db.close();

      expect(existsSync(file)).toBe(true);
      const reopened = new DatabaseSync(file);
      expect(Number((reopened.prepare("SELECT COUNT(*) AS c FROM exam_paper").get() as { c: number }).c)).toBe(1);
      reopened.close();
    } finally {
      cleanupDir(dir);
    }
  });
});
