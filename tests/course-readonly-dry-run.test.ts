import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, openDatabaseReadOnly, SchemaTooNewError } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { SCHEMA_SQL, SCHEMA_VERSION } from "@/db/schema";
import { planCourseImport, commitCourseImport } from "@/services/course-import";
import { planImport, commitImport } from "@/services/paper-import";
import { verifyCanonicalLink, getCourseLinkOverview } from "@/services/course-link";
import type { Repositories } from "@/repositories/ports";
import { buildCourseFixture, writeCourseFixture } from "../scripts/course-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

/**
 * **只读路径不得迁移 schema** —— 本轮 MAJOR 缺陷的对抗性测试。
 *
 * ── 缺陷回顾（实测确认，且已真实发生过一次）──
 *
 * `pnpm course:import` 自称"预演（dry-run，不写数据库）"，但它无条件调用
 * `getRepositories()` → `getDb()` → `openDatabase()`，而 `openDatabase`
 * 会执行 PRAGMA、建表、应用迁移并写 `schema_meta.schema_version`。
 * **打开本身就是写。** 于是"预演"把 使用者的真实库从 v8 迁移到了 v9。
 *
 * 同类缺陷还在 `course:link` 的默认 dry-run、`--list`、`--segments` 上。
 *
 * ── 本文件钉死的不变量 ──
 *
 * 一条自称 dry-run / 只读 / 列表 / 检查 / 校验的命令，
 * **在原理上**不得具备迁移能力：
 *
 * - 不改 `schema_meta.schema_version`
 * - 不建任何 `course_*` 表（v8 上）
 * - 不写任何课程行
 * - 不改既有业务数据
 * - 不因"库是旧版"而报错崩溃（要**如实说明**课程层未激活）
 *
 * 判据是**真实临时 SQLite 文件 + 真实 schema 快照对比**，不是源码字符串断言。
 */

let dir: string;
let dbPath: string;

/**
 * 本用例打开过的所有连接，`afterEach` 统一关闭。
 *
 * 为什么必须集中管理：Windows 上残留句柄会让临时目录删不掉（EPERM），
 * 而那个失败会**冒充**成断言失败、掩盖真正的结论（实测踩到）。
 * 因此把"关闭"变成结构性的，而不是靠每个用例自觉。
 */
const handles: DatabaseSync[] = [];

/** 只读 repository（不迁移、不建表、不写版本号）。 */
function readOnlyRepos(): Repositories {
  const db = openDatabaseReadOnly(dbPath);
  handles.push(db);
  return createSqliteRepositories(db);
}

/** 写 repository（会迁移；仅供制造测试前置状态或验证 --commit 语义）。 */
function writeRepos(): Repositories {
  const db = openDatabase(dbPath);
  handles.push(db);
  return createSqliteRepositories(db);
}

/**
 * v8 形态的 DDL：从当前 `SCHEMA_SQL` 中切掉课程层分节。
 *
 * 与 `tests/course-import.test.ts` 用同一种推导方式（带自检）：
 * 课程层 DDL 整体追加在文件末尾，切点稳定；而 v8 的旧 DDL 已不在代码里，
 * 抄写容易随演进失真。
 */
function deriveV8Ddl(): string {
  const marker = "-- 课程层（Course Layer，V1 基础）";
  const index = SCHEMA_SQL.indexOf(marker);
  expect(index, "找不到课程层分节标记，v8 形态无法推导").toBeGreaterThan(0);
  const ddl = SCHEMA_SQL.slice(0, index).trimEnd();
  expect(ddl).not.toContain("course_package");
  for (const table of ["schema_meta", "learner_profile", "exam_paper", "paper_study_state"]) {
    expect(ddl, `切出的 v8 DDL 缺少 ${table}`).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
  }
  return ddl;
}

/** 造一个**有真实业务数据**的 v8 库。 */
function seedV8(file: string): void {
  const db = new DatabaseSync(file);
  db.exec(deriveV8Ddl());
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version','8')").run();
  db.prepare(
    "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run("p1", "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO exam_paper (id, exam_type, exam_year, session, variant, source_kind, verification_status,
       provenance_note, content_version, package_path, manifest_checksum, content_fingerprint,
       section_count, question_count, imported_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("p-real", "CET6", 2024, "December", "set1", "real_past_paper", "partially_verified", "来源说明", 4, "pp", "cs", "fp", 8, 57, "t", "t");
  db.prepare("INSERT INTO paper_study_state (paper_id, pool, updated_at) VALUES (?,?,?)").run(
    "p-real",
    "mock_reserve",
    "2026-01-04T00:00:00.000Z",
  );
  db.close();
}

/** 造一个 v9 库。 */
function seedV9(file: string): void {
  const db = openDatabase(file);
  db.prepare(
    "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run("p1", "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.close();
}

interface Snapshot {
  schemaVersion: string | null;
  courseTables: string[];
  triggers: number;
  papers: number;
  paperVersion: number | null;
  pool: string | null;
  learner: number;
  rowCounts: Record<string, number>;
}

/** 用**只读**连接拍一张完整快照（拍快照本身也绝不能改库）。 */
function snapshot(file: string): Snapshot {
  const db = new DatabaseSync(file, { readOnly: true });
  const tableNames = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((row) => row.name);

  const rowCounts: Record<string, number> = {};
  for (const table of tableNames) {
    rowCounts[table] = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
  }

  const versionRow = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as
    | { value: string }
    | undefined;
  const paper = db.prepare("SELECT content_version FROM exam_paper WHERE id='p-real'").get() as
    | { content_version: number }
    | undefined;
  const pool = db.prepare("SELECT pool FROM paper_study_state WHERE paper_id='p-real'").get() as
    | { pool: string }
    | undefined;

  const result: Snapshot = {
    schemaVersion: versionRow?.value ?? null,
    courseTables: tableNames.filter((name) => name.startsWith("course_")).sort(),
    triggers: Number(
      (db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger'").get() as { c: number }).c,
    ),
    papers: Number((db.prepare("SELECT COUNT(*) AS c FROM exam_paper").get() as { c: number }).c),
    paperVersion: paper?.content_version ?? null,
    pool: pool?.pool ?? null,
    learner: Number((db.prepare("SELECT COUNT(*) AS c FROM learner_profile").get() as { c: number }).c),
    rowCounts,
  };
  db.close();
  return result;
}

function coursePackageCount(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  const has = db
    .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_package'")
    .get();
  const count = has
    ? Number((db.prepare("SELECT COUNT(*) AS c FROM course_package").get() as { c: number }).c)
    : 0;
  db.close();
  return count;
}

beforeEach(() => {
  handles.length = 0;
  dir = mkdtempSync(join(tmpdir(), "cet6-readonly-"));
  dbPath = join(dir, "cet6.db");
  process.env.CET6_CONTENT_ROOT = dir;
  process.env.CET6_DB_PATH = dbPath;
});

afterEach(() => {
  for (const db of handles) {
    try {
      db.close();
    } catch {
      /* 已关闭 */
    }
  }
  handles.length = 0;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 上可能短暂残留；临时目录残留不影响断言 */
  }
});

// ---------------------------------------------------------------------------
// A. v8 上的课程导入预演
// ---------------------------------------------------------------------------

describe("A 只读门禁：v8 上跑课程导入**预演**不得迁移", () => {
  it("预演后 schema_version 仍为 8，且没有任何 course_* 表", () => {
    seedV8(dbPath);
    const before = snapshot(dbPath);
    expect(before.schemaVersion).toBe("8");
    expect(before.courseTables).toEqual([]);

    // 真实跑一遍只读导入路径（与 CLI 的 dry-run 同一条路）
    const plan = planCourseImport(readOnlyRepos());

    const after = snapshot(dbPath);
    expect(after.schemaVersion, "预演把库迁移了 —— 违反只读契约").toBe("8");
    expect(after.courseTables, "预演创建了课程层表").toEqual([]);
    expect(after).toEqual(before);
    expect(plan.report.discovered).toBe(0);
  });

  it("预演如实报告**课程层尚未激活**（而不是假装 v9 或报错）", () => {
    seedV8(dbPath);
    const repos = readOnlyRepos();
    const plan = planCourseImport(repos);

    expect(repos.courses.isActivated()).toBe(false);
    expect(plan.report.courseIndexActivated).toBe(false);
  });

  it("v8 上即使**有课程包可导入**，预演也仍然零写入", () => {
    seedV8(dbPath);
    writeCourseFixture(dir, "c1", buildCourseFixture({ id: "c1" }));
    const before = snapshot(dbPath);

    const plan = planCourseImport(readOnlyRepos());

    // 判定说"新增"（那是 --commit 之后会发生的事）……
    expect(plan.report.counts.insert).toBe(1);
    expect(plan.report.courseIndexActivated).toBe(false);

    // ……但库一个字节都没变。
    const after = snapshot(dbPath);
    expect(after).toEqual(before);
    expect(after.schemaVersion).toBe("8");
    expect(coursePackageCount(dbPath)).toBe(0);
  });

  it("既有业务数据（试卷/版本/训练池/学习者）逐项未变", () => {
    seedV8(dbPath);
    const before = snapshot(dbPath);

    const repos = readOnlyRepos();
    repos.courses.listPackages();
    repos.papers.listPapers();

    const after = snapshot(dbPath);
    expect(after.papers).toBe(before.papers);
    expect(after.paperVersion).toBe(4);
    expect(after.pool).toBe("mock_reserve");
    expect(after.learner).toBe(1);
    expect(after.triggers).toBe(before.triggers);
  });
});

// ---------------------------------------------------------------------------
// B. v8 上的 course:link 读取路径
// ---------------------------------------------------------------------------

describe("B 只读门禁：v8 上 course:link 的 list/segments/dry-run 不得迁移", () => {
  it("list 路径（概览 + 链接列表）在 v8 上零写入", () => {
    seedV8(dbPath);
    const before = snapshot(dbPath);

    const repos = readOnlyRepos();
    // 这三条正是 CLI 的 --list / --segments / 默认核验会走的读路径
    expect(repos.courses.isActivated()).toBe(false);
    expect(repos.courses.getPackage("anything")).toBeNull();
    expect(repos.courses.listLinksForCourse("anything")).toEqual([]);
    const overview = getCourseLinkOverview(repos, "anything");
    expect(overview.verifiedUsable).toBe(0);
    expect(overview.verifiedRows).toBe(0);

    const after = snapshot(dbPath);
    expect(after.schemaVersion, "link 读取路径把库迁移了").toBe("8");
    expect(after.courseTables).toEqual([]);
    expect(after).toEqual(before);
  });

  it("默认的链接核验 dry-run 在 v8 上因课程层未激活而 fail closed，且不写库", () => {
    seedV8(dbPath);
    writeFixturePackage(dir, "paper", buildFixturePackage({ contentVersion: 1 }));
    writeCourseFixture(dir, "c1", buildCourseFixture({ id: "c1" }));
    const before = snapshot(dbPath);

    const result = verifyCanonicalLink(readOnlyRepos(), {
      courseId: "c1",
      courseContentVersion: 1,
      segmentId: "reading.a",
      paperId: "fixture-cet6-2024-12-v1",
      paperContentVersion: 1,
      sectionId: "reading.careful_reading",
      targetScope: "section",
      verificationStatus: "verified",
      verificationRef: "反思",
      dryRun: true,
    });

    // 课程包在 v8 上不存在（课程层未激活）⇒ 如实拒绝，而不是崩溃
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "courseId")).toBe(true);

    const after = snapshot(dbPath);
    expect(after).toEqual(before);
    expect(after.schemaVersion).toBe("8");
  });

  it("只读连接上的**任何**写入都失败（结构性保证，而非自觉）", () => {
    seedV8(dbPath);
    const repos = readOnlyRepos();

    // v8 上连 course_package 表都不存在，因此"写不存在表"与"写只读库"
    // 两条路径都必须失败 —— 没有任何一条能悄悄成功。
    expect(() =>
      repos.courses.appendExposure({
        profileId: "p1",
        courseId: "c",
        segmentId: "s",
        courseContentVersion: 1,
        eventType: "content_rendered",
        occurredAt: "t",
      }),
    ).toThrow();

    expect(snapshot(dbPath).schemaVersion).toBe("8");
  });
});

// ---------------------------------------------------------------------------
// C/D. v9 上的只读路径
// ---------------------------------------------------------------------------

describe("C/D 只读门禁：v9 上只读路径可读，但不得改动 schema 或数据", () => {
  it("v9：预演读得到既有索引，且不修改任何行", () => {
    seedV9(dbPath);
    writeCourseFixture(dir, "c1", buildCourseFixture({ id: "c1" }));
    const rw = writeRepos();
    expect(commitCourseImport(rw, planCourseImport(rw)).written).toBe(1);

    const before = snapshot(dbPath);
    expect(before.schemaVersion).toBe(String(SCHEMA_VERSION));
    expect(before.courseTables.length).toBe(3);

    // 只读路径应读得到它，且判定为 unchanged（不是 insert）
    const ro = readOnlyRepos();
    expect(ro.courses.isActivated()).toBe(true);
    const plan = planCourseImport(ro);
    expect(plan.report.courseIndexActivated).toBe(true);
    expect(plan.report.counts.unchanged).toBe(1);
    expect(plan.report.counts.insert).toBe(0);

    const after = snapshot(dbPath);
    expect(after, "只读预演改动了库").toEqual(before);
    expect(coursePackageCount(dbPath)).toBe(1);
  });

  it("v9：link list 路径只读，且能读到已验证链接", () => {
    seedV9(dbPath);
    writeFixturePackage(dir, "paper", buildFixturePackage({ contentVersion: 1 }));
    writeCourseFixture(dir, "c1", buildCourseFixture({ id: "c1" }));

    const rw = writeRepos();
    // 真题索引必须走真实导入：链接核验会比对磁盘 manifest 校验和（F1），
    // 手工伪造索引行会被如实拒绝 —— 那是正确的 fail-closed 行为，
    // 但不是本用例要测的东西。
    const paperPlan = planImport(rw, { only: ["paper"] });
    expect(paperPlan.report.counts.insert).toBe(1);
    expect(commitImport(rw, paperPlan).ok).toBe(true);

    commitCourseImport(rw, planCourseImport(rw));

    const created = verifyCanonicalLink(rw, {
      courseId: "c1",
      courseContentVersion: 1,
      segmentId: "reading.a",
      paperId: "fixture-cet6-2024-12-v1",
      paperContentVersion: 1,
      sectionId: "reading.careful_reading",
      targetScope: "section",
      verificationStatus: "verified",
      verificationRef: "人工核验",
    });
    expect(created.ok, created.ok ? "" : JSON.stringify(created.issues)).toBe(true);

    const before = snapshot(dbPath);

    // 只读路径读取
    const overview = getCourseLinkOverview(readOnlyRepos(), "c1");
    expect(overview.verifiedUsable).toBe(1);
    expect(overview.verifiedRows).toBe(1);

    const after = snapshot(dbPath);
    expect(after, "link 只读路径改动了库").toEqual(before);
  });

  it("v9：只读连接上写入仍被拒绝（不是'能写只是我们没写'）", () => {
    seedV9(dbPath);
    const ro = readOnlyRepos();
    expect(ro.courses.isActivated()).toBe(true);

    expect(() =>
      ro.courses.appendExposure({
        profileId: "p1",
        courseId: "c",
        segmentId: "s",
        courseContentVersion: 1,
        eventType: "content_rendered",
        occurredAt: "t",
      }),
    ).toThrow(/readonly|read-only/i);
  });
});

// ---------------------------------------------------------------------------
// E. 显式 --commit 必须迁移（只读修复不得削弱写入能力）
// ---------------------------------------------------------------------------

describe("E 写入路径：显式 commit 在 v8 上确实完成 v8 → v9 迁移", () => {
  it("--commit 走写路径 ⇒ 迁移到 v9 并写入课程索引", () => {
    seedV8(dbPath);
    writeCourseFixture(dir, "c1", buildCourseFixture({ id: "c1" }));

    const before = snapshot(dbPath);
    expect(before.schemaVersion).toBe("8");
    expect(before.courseTables).toEqual([]);

    const rw = writeRepos();
    const result = commitCourseImport(rw, planCourseImport(rw));

    const after = snapshot(dbPath);
    expect(result.ok, result.error ?? "").toBe(true);
    expect(result.written).toBe(1);
    expect(after.schemaVersion).toBe("9");
    expect(after.schemaVersion).toBe(String(SCHEMA_VERSION));
    expect(after.courseTables).toEqual([
      "course_canonical_link",
      "course_exposure_event",
      "course_package",
    ]);
    expect(coursePackageCount(dbPath)).toBe(1);

    // 既有数据一条不少、策略不重置
    expect(after.papers).toBe(before.papers);
    expect(after.paperVersion).toBe(4);
    expect(after.pool).toBe("mock_reserve");
    expect(after.learner).toBe(1);
  });

  it("迁移仍是纯增量的：既有行数与语义值逐项保持", () => {
    seedV8(dbPath);
    const before = snapshot(dbPath);

    writeRepos();

    const after = snapshot(dbPath);
    for (const table of ["learner_profile", "exam_paper", "paper_study_state", "schema_meta"]) {
      expect(after.rowCounts[table], `${table} 行数在迁移中变了`).toBe(before.rowCounts[table]);
    }
    expect(after.paperVersion).toBe(4);
    expect(after.pool).toBe("mock_reserve");
  });

  it("新增的课程层只追加触发器在迁移后确实就位（v8 5 个 → v9 9 个）", () => {
    seedV8(dbPath);
    const before = snapshot(dbPath);
    writeRepos();
    const after = snapshot(dbPath);
    expect(before.triggers).toBe(5);
    expect(after.triggers).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// F. SchemaTooNew 仍然失败关闭
// ---------------------------------------------------------------------------

describe("F SchemaTooNew 在两个路径上都失败关闭", () => {
  function seedNewer(file: string): void {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', ?)").run(
      String(SCHEMA_VERSION + 1),
    );
    db.close();
  }

  it("只读打开新版本库 ⇒ SchemaTooNewError（而不是降级使用）", () => {
    seedNewer(dbPath);
    expect(() => openDatabaseReadOnly(dbPath)).toThrow(SchemaTooNewError);
  });

  it("只读打开失败时**不改动**库里的版本号", () => {
    seedNewer(dbPath);
    expect(() => openDatabaseReadOnly(dbPath)).toThrow(SchemaTooNewError);

    const db = new DatabaseSync(dbPath, { readOnly: true });
    const version = (db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as {
      value: string;
    }).value;
    db.close();
    expect(Number(version)).toBe(SCHEMA_VERSION + 1);
  });

  it("写路径同样失败关闭（既有不变量未被削弱）", () => {
    seedNewer(dbPath);
    expect(() => openDatabase(dbPath)).toThrow(SchemaTooNewError);
  });

  it("只读打开**不存在**的库 ⇒ 抛错且不创建文件", () => {
    const missing = join(dir, "nope.db");
    expect(() => openDatabaseReadOnly(missing)).toThrow();
    expect(existsSync(missing)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G. 只读路径不得意外回退到读写成迁移行为
// ---------------------------------------------------------------------------

describe("G 只读路径不得回退到迁移行为", () => {
  it("只读 repository 的底层连接真的只读（反复读操作后库仍不变）", () => {
    seedV8(dbPath);
    const before = snapshot(dbPath);

    for (let pass = 0; pass < 3; pass += 1) {
      const repos = readOnlyRepos();
      repos.courses.isActivated();
      repos.courses.listPackages();
      repos.courses.getPackage("x");
      repos.courses.countPackages();
      repos.courses.hasContentVersion("x", 1);
      repos.courses.listLinksForCourse("x");
      repos.courses.listLinksForSegment("x", "y");
      repos.courses.getLink("z");
      repos.courses.listExposureForProfile("p1", 10);
      repos.courses.listExposureForSegment("p1", "c", "s");
      repos.courses.countExposure("p1");
      repos.papers.listPapers();
      repos.papers.getPaper("p-real");
      repos.papers.listAssets("p-real");
      repos.papers.countPapers();
      repos.learner.getProfile();
    }

    expect(snapshot(dbPath)).toEqual(before);
  });

  it("只读 repository 的 transaction() 里执行写语句会失败（不是静默成功）", () => {
    seedV8(dbPath);
    const repos = readOnlyRepos();
    expect(() =>
      repos.transaction(() => {
        repos.courses.appendExposure({
          profileId: "p1",
          courseId: "c",
          segmentId: "s",
          courseContentVersion: 1,
          eventType: "content_rendered",
          occurredAt: "t",
        });
      }),
    ).toThrow();
    expect(snapshot(dbPath).schemaVersion).toBe("8");
  });

  it("只读路径对每个方法都返回空/安全值，而不是抛 no such table", () => {
    // v8 里没有课程层表；读方法必须**如实返回空**（课程层未激活），
    // 而不是把"未激活"表现成一个 SQL 崩溃 —— 那会把操作者引向错误的排查方向。
    seedV8(dbPath);
    const repos = readOnlyRepos();
    expect(() => {
      expect(repos.courses.listPackages()).toEqual([]);
      expect(repos.courses.getPackage("x")).toBeNull();
      expect(repos.courses.countPackages()).toBe(0);
      expect(repos.courses.listLinksForCourse("x")).toEqual([]);
      expect(repos.courses.listLinksForSegment("x", "y")).toEqual([]);
      expect(repos.courses.getLink("z")).toBeNull();
      expect(repos.courses.listExposureForProfile("p", 5)).toEqual([]);
      expect(repos.courses.listExposureForSegment("p", "c", "s")).toEqual([]);
      expect(repos.courses.countExposure("p")).toBe(0);
      expect(repos.courses.hasContentVersion("x", 1)).toBe(false);
    }).not.toThrow();
  });

  it("只读打开不会创建目录（零文件系统副作用）", () => {
    const nested = join(dir, "a", "b", "c.db");
    expect(() => openDatabaseReadOnly(nested)).toThrow();
    // openDatabase 会 mkdirSync；只读路径**不得**这么做
    expect(existsSync(join(dir, "a"))).toBe(false);
  });

  it("内存库被只读打开明确拒绝（无法反映真实文件状态）", () => {
    expect(() => openDatabaseReadOnly(":memory:")).toThrow(/内存/);
  });
});
