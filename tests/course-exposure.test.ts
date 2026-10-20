import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { commitCourseImport, planCourseImport } from "@/services/course-import";
import {
  recordCourseExposure,
  getSegmentExposureHistory,
  countCourseExposure,
} from "@/services/course-exposure";
import { verifyCanonicalLink } from "@/services/course-link";
import { COURSE_EXPOSURE_EVENT_TYPES } from "@/domain/course";
import type { Repositories } from "@/repositories/ports";
import { buildCourseFixture, writeCourseFixture } from "../scripts/course-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import { planImport, commitImport } from "@/services/paper-import";

/**
 * 课程曝光的**只追加**与**语义边界**测试。
 *
 * 这是本阶段最容易被悄悄破坏的一条约束，因此从三个层面分别固定：
 *
 * 1. **数据库层**：UPDATE / DELETE 必须被 BEFORE 触发器 `RAISE(ABORT)` 阻断
 *    （repository"不提供 update/delete"挡不住直接执行的 SQL）。
 * 2. **服务层**：`course-exposure` 只写曝光，绝不触碰 Expert 台账或旧闭环。
 * 3. **语义层**：曝光**不引用 canonical 题目**作为主身份 ——
 *    一段今天在"未匹配"状态下被学过的材料，日后人工核验出对应关系时，
 *    历史曝光必须仍能被投影到那道题上。若曝光当初写死了 canonical 目标，
 *    这份信息就已经丢了。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

const COURSE_ID = "fixture-course-a";
const SEGMENT_ID = "reading.a";
const PAPER_ID = "fixture-cet6-2024-12-v1";
const PROFILE_ID = "p1";

function seedProfile(): void {
  db.prepare(
    "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(PROFILE_ID, "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

function importCourse(fixture = buildCourseFixture()): void {
  writeCourseFixture(contentRoot, COURSE_ID, fixture);
  const result = commitCourseImport(repos, planCourseImport(repos));
  expect(result.ok, `课程导入失败：${result.error}`).toBe(true);
  expect(result.written).toBe(1);
}

function importPaper(): void {
  writeFixturePackage(contentRoot, "fixture-paper", buildFixturePackage({ contentVersion: 1 }));
  const paperPlan = planImport(repos, { only: ["fixture-paper"] });
  expect(paperPlan.report.counts.insert).toBe(1);
  expect(commitImport(repos, paperPlan).ok).toBe(true);
}

function recordExposure(overrides: Record<string, unknown> = {}) {
  return recordCourseExposure(repos, {
    profileId: PROFILE_ID,
    courseId: COURSE_ID,
    segmentId: SEGMENT_ID,
    courseContentVersion: 1,
    eventType: "content_rendered",
    occurredAt: "2026-02-01T10:00:00.000Z",
    ...overrides,
  });
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint };
  return Number(row.c);
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-exposure-"));
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);
  seedProfile();
});

afterEach(() => {
  // 原生句柄必须确定性关闭：`DatabaseSync` 不是 GC 会及时回收的普通对象。
  try {
    db.close();
  } catch {
    // 已关闭过就不该让清理失败。
  }

  if (previousRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
  else process.env.CET6_CONTENT_ROOT = previousRoot;
  rmSync(contentRoot, { recursive: true, force: true });
});

describe("曝光：可以正常记录", () => {
  it("曝光插入成功，并记录当时看到的内容版本", () => {
    importCourse();
    const result = recordExposure();
    expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
    if (!result.ok) return;

    expect(result.event.profileId).toBe(PROFILE_ID);
    expect(result.event.courseId).toBe(COURSE_ID);
    expect(result.event.segmentId).toBe(SEGMENT_ID);
    expect(result.event.courseContentVersion).toBe(1);
    expect(result.event.eventType).toBe("content_rendered");
    expect(result.event.occurredAt).toBe("2026-02-01T10:00:00.000Z");
    expect(countRows("course_exposure_event")).toBe(1);
  });

  it("全部登记的曝光事件种类都能写入", () => {
    importCourse();
    for (const eventType of COURSE_EXPOSURE_EVENT_TYPES) {
      const result = recordExposure({ eventType });
      expect(result.ok, `事件种类 ${eventType} 应当被接受`).toBe(true);
    }
    expect(countRows("course_exposure_event")).toBe(COURSE_EXPOSURE_EVENT_TYPES.length);
  });

  it("同一段的多次曝光各自成行（曝光是观测流，不是状态）", () => {
    importCourse();
    recordExposure({ occurredAt: "2026-02-01T10:00:00.000Z" });
    recordExposure({ occurredAt: "2026-02-01T10:05:00.000Z" });
    recordExposure({ eventType: "solution_rendered", occurredAt: "2026-02-01T10:06:00.000Z" });

    expect(countRows("course_exposure_event")).toBe(3);
    expect(countCourseExposure(repos, PROFILE_ID)).toBe(3);
  });

  it("未登记的曝光事件种类被拒绝，且不写入", () => {
    importCourse();
    const result = recordExposure({ eventType: "understood_perfectly" as never });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "eventType")).toBe(true);
    expect(countRows("course_exposure_event")).toBe(0);
  });

  it("不存在的课程包 / 段被拒绝（失败关闭）", () => {
    importCourse();

    const noCourse = recordExposure({ courseId: "no-such-course" });
    expect(noCourse.ok).toBe(false);

    const noSegment = recordExposure({ segmentId: "no-such-segment" });
    expect(noSegment.ok).toBe(false);
    if (noSegment.ok) return;
    expect(noSegment.issues.some((issue) => issue.path === "segmentId")).toBe(true);

    expect(countRows("course_exposure_event")).toBe(0);
  });

  it("课程内容版本不匹配时被拒绝（曝光必须记录**当时**看到的那一版）", () => {
    importCourse();
    const result = recordExposure({ courseContentVersion: 2 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "courseContentVersion")).toBe(true);
    expect(countRows("course_exposure_event")).toBe(0);
  });
});

describe("曝光：数据库层只追加（触发器，不是应用层约定）", () => {
  /**
   * 这一组用**裸 SQL** 验证，不经过 repository ——
   * repository"不提供 update/delete"挡不住迁移脚本、调试工具与未来的调用方。
   */

  it("UPDATE 被 BEFORE 触发器阻断", () => {
    importCourse();
    recordExposure();

    expect(
      () => db.prepare("UPDATE course_exposure_event SET event_type = 'declared_seen'").run(),
      "course_exposure_event 允许了 UPDATE —— 不可变观测被就地改写",
    ).toThrow(/只追加/);

    // 数据确实没被动过
    const row = db.prepare("SELECT event_type FROM course_exposure_event").get() as { event_type: string };
    expect(row.event_type).toBe("content_rendered");
  });

  it("DELETE 被 BEFORE 触发器阻断", () => {
    importCourse();
    recordExposure();

    expect(
      () => db.prepare("DELETE FROM course_exposure_event").run(),
      "course_exposure_event 允许了 DELETE —— 历史可以被抹掉",
    ).toThrow(/只追加/);

    expect(countRows("course_exposure_event")).toBe(1);
  });

  it("条件 UPDATE（只改一行）同样被阻断", () => {
    importCourse();
    const result = recordExposure();
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(() =>
      db
        .prepare("UPDATE course_exposure_event SET course_content_version = 9 WHERE id = ?")
        .run(result.event.id),
    ).toThrow(/只追加/);
  });

  it("触发器在库里真实存在（不是只写在 schema.ts 里）", () => {
    const triggers = (
      db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='course_exposure_event'").all() as Array<{
        name: string;
      }>
    ).map((row) => row.name).sort();
    expect(triggers).toEqual([
      "course_exposure_event_append_only_delete",
      "course_exposure_event_append_only_update",
    ]);
  });

  it("resetDb 对曝光历史的行为与 Expert 台账**完全一致**（同一条既存约束）", async () => {
    /**
     * 实测发现（**既存行为，非本轮引入**）：
     * `resetDb` 会先删 `learner_profile`，而只追加的观测表以 `profile_id`
     * 外键引用它，因此当库里存在任何观测行时 `resetDb` 会抛
     * `FOREIGN KEY constraint failed`。
     *
     * 已用对照实验确认这与 Expert 台账的表现**逐字相同**：
     * 只放一条 `performance_event` 时 `resetDb` 同样失败，
     * 报错信息一模一样。因此这不是课程层引入的新问题，而是既存工具的一个
     * 固有边界 —— 本阶段**不修**（超出范围），但如实断言它，
     * 避免将来有人误以为"课程层让 resetDb 坏了"。
     *
     * 它的实际含义是好的那一面：**持有 db 句柄的代码无法借 resetDb
     * 抹掉只追加的历史** —— 无论是 Expert 观测还是课程曝光。
     */
    importCourse();
    recordExposure();
    expect(countRows("course_exposure_event")).toBe(1);

    const { resetDb } = await import("@/db/client");
    expect(
      () => resetDb(db),
      "resetDb 在存在只追加观测时应当失败（这是保护历史，不是缺陷）",
    ).toThrow(/FOREIGN KEY/i);

    // 关键：曝光历史没有被抹掉
    expect(countRows("course_exposure_event")).toBe(1);
    expect(countRows("learner_profile")).toBe(1);
  });

  it("没有观测行时，resetDb 仍然是可用的（保护只针对真正存在的历史）", async () => {
    importCourse();
    // 刻意不写曝光
    expect(countRows("course_exposure_event")).toBe(0);

    const { resetDb } = await import("@/db/client");
    expect(() => resetDb(db)).not.toThrow();
    expect(countRows("learner_profile")).toBe(0);
    // 课程索引与复核记录同样不在清空范围内
    expect(countRows("course_package")).toBe(1);
  });
});

describe("曝光：不得写入 Expert 台账或旧闭环", () => {
  it("记录曝光**不产生**任何 performance_event / assessment_event / evidence_projection", () => {
    importCourse();
    const before = {
      runs: countRows("learning_run"),
      perf: countRows("performance_event"),
      assess: countRows("assessment_event"),
      projection: countRows("evidence_projection"),
    };
    expect(before).toEqual({ runs: 0, perf: 0, assess: 0, projection: 0 });

    for (const eventType of COURSE_EXPOSURE_EVENT_TYPES) {
      recordExposure({ eventType });
    }

    expect(countRows("learning_run")).toBe(before.runs);
    expect(countRows("performance_event")).toBe(before.perf);
    expect(countRows("assessment_event")).toBe(before.assess);
    expect(countRows("evidence_projection")).toBe(before.projection);
  });

  it("记录曝光**不产生**任何 skill_profile / answer_attempt / review_item / study_session", () => {
    importCourse();
    for (const eventType of COURSE_EXPOSURE_EVENT_TYPES) {
      recordExposure({ eventType });
    }

    for (const table of ["skill_profile", "answer_attempt", "review_item", "study_session", "study_task"]) {
      expect(countRows(table), `曝光写入了旧闭环表 ${table}`).toBe(0);
    }
  });

  it("记录曝光**不产生**任何掌握度 / 弱项 / 诊断结论", () => {
    importCourse();
    recordExposure();

    // 旧画像为空
    expect(repos.skillProfile.get(PROFILE_ID)).toBeNull();
    // Expert 投影为空（它是"能力证据"的落点，曝光不得进入）
    expect(repos.expert.readProjection(PROFILE_ID)).toEqual([]);
    // 学习者模型里没有任何"已掌握"之类的主张可写
    expect(countRows("skill_profile")).toBe(0);
  });

  it("曝光事件表的列里**不存在**任何结果/因果字段", () => {
    const columns = (
      db.prepare("PRAGMA table_info(course_exposure_event)").all() as Array<{ name: string }>
    ).map((row) => row.name);

    for (const forbidden of [
      "outcome",
      "score",
      "correct",
      "incorrect",
      "mastery",
      "weakness",
      "mechanism",
      "diagnosis",
      "cause",
      "error_tag",
      "question_id",
      "paper_id",
      "section_id",
    ]) {
      expect(columns, `course_exposure_event 不应包含 ${forbidden} 列`).not.toContain(forbidden);
    }
    // 它有的只是观测身份
    for (const required of [
      "profile_id",
      "course_id",
      "segment_id",
      "course_content_version",
      "event_type",
      "occurred_at",
    ]) {
      expect(columns).toContain(required);
    }
  });
});

describe("曝光：未匹配的段被学过，日后核验出对应关系仍可投影", () => {
  it("**先曝光、后建链接**：历史曝光仍指向它当时的那一版段", () => {
    importPaper();
    importCourse();

    // 1) 今天：该段**还没有**任何 canonical 匹配，但学习者已经学过它
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toEqual([]);
    const exposure = recordExposure({ occurredAt: "2026-02-01T10:00:00.000Z" });
    expect(exposure.ok).toBe(true);
    if (!exposure.ok) return;

    // 曝光的主身份里**没有** canonical 目标 —— 这正是它能被日后投影的前提
    expect(exposure.event).not.toHaveProperty("paperId");
    expect(exposure.event).not.toHaveProperty("questionId");
    expect(exposure.event).not.toHaveProperty("sectionId");

    // 2) 两周后：人工核验出这一段对应哪道真题
    const link = verifyCanonicalLink(repos, {
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: "reading.careful_reading",
      targetScope: "section",
      verificationStatus: "verified",
      verificationRef: "人工核验：两周后复核记录 #2",
    });
    expect(link.ok, link.ok ? "" : JSON.stringify(link.issues)).toBe(true);

    // 3) 历史曝光**原样保留**，并且现在能与链接一起被读到 ——
    //    两半信息都在，投影可以在后续阶段进行（本阶段刻意不做投影）
    const history = getSegmentExposureHistory(repos, PROFILE_ID, COURSE_ID, SEGMENT_ID);
    expect(history.exposures).toHaveLength(1);
    expect(history.exposures[0].id).toBe(exposure.event.id);
    expect(history.exposures[0].courseContentVersion).toBe(1);
    expect(history.runtimeLinkTargets).toEqual([
      { paperId: PAPER_ID, sectionId: "reading.careful_reading", scope: "section" },
    ]);
  });

  it("曝光**不会**因为链接尚未建立而被拒绝（未匹配是合法状态）", () => {
    importCourse();
    const result = recordExposure();
    expect(result.ok).toBe(true);
    expect(countRows("course_exposure_event")).toBe(1);
  });

  it("课程升版后，旧曝光仍指向它当时的那一版（不与新版合并）", () => {
    importCourse();
    recordExposure({ courseContentVersion: 1, occurredAt: "2026-02-01T10:00:00.000Z" });

    // 升到 v2
    importCourse(
      buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }),
    );
    expect(repos.courses.getPackage(COURSE_ID)!.contentVersion).toBe(2);

    // 再学一次（新版）
    const second = recordExposure({ courseContentVersion: 2, occurredAt: "2026-03-01T10:00:00.000Z" });
    expect(second.ok).toBe(true);

    // 两条曝光各自保留自己的内容版本
    const history = getSegmentExposureHistory(repos, PROFILE_ID, COURSE_ID, SEGMENT_ID);
    expect(history.exposures).toHaveLength(2);
    expect(history.exposures.map((event) => event.courseContentVersion).sort()).toEqual([1, 2]);
  });
});

describe("曝光：读取与聚合", () => {
  it("按 profile 读取曝光（倒序）", () => {
    importCourse();
    recordExposure({ occurredAt: "2026-02-01T10:00:00.000Z" });
    recordExposure({ occurredAt: "2026-02-03T10:00:00.000Z" });
    recordExposure({ occurredAt: "2026-02-02T10:00:00.000Z" });

    const events = repos.courses.listExposureForProfile(PROFILE_ID, 10);
    expect(events.map((event) => event.occurredAt)).toEqual([
      "2026-02-03T10:00:00.000Z",
      "2026-02-02T10:00:00.000Z",
      "2026-02-01T10:00:00.000Z",
    ]);
  });

  it("其它 profile 的曝光不会混进来", () => {
    importCourse();
    db.prepare(
      "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("p2", "Other", 30, 60, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    recordExposure({ profileId: PROFILE_ID });
    recordExposure({ profileId: "p2" });

    expect(countCourseExposure(repos, PROFILE_ID)).toBe(1);
    expect(countCourseExposure(repos, "p2")).toBe(1);
    expect(repos.courses.listExposureForProfile(PROFILE_ID, 10)).toHaveLength(1);
  });

  it("未匹配的段的历史里，runtimeLinkTargets 为空（如实，不是错误）", () => {
    importCourse();
    recordExposure();

    const history = getSegmentExposureHistory(repos, PROFILE_ID, COURSE_ID, SEGMENT_ID);
    expect(history.exposures).toHaveLength(1);
    expect(history.runtimeLinkTargets).toEqual([]);
  });

  it("失效（stale）的链接不出现在 runtimeLinkTargets 里", () => {
    importPaper();
    importCourse();
    verifyCanonicalLink(repos, {
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: "reading.careful_reading",
      targetScope: "section",
      verificationStatus: "verified",
      verificationRef: "人工核验 #3",
    });
    recordExposure();
    expect(getSegmentExposureHistory(repos, PROFILE_ID, COURSE_ID, SEGMENT_ID).runtimeLinkTargets).toHaveLength(1);

    // 课程升版 ⇒ 链接失效 ⇒ 投影目标为空（历史曝光仍在）
    importCourse(
      buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }),
    );

    const history = getSegmentExposureHistory(repos, PROFILE_ID, COURSE_ID, SEGMENT_ID);
    expect(history.exposures).toHaveLength(1);
    expect(history.runtimeLinkTargets).toEqual([]);
  });
});
