import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { commitCourseImport, planCourseImport } from "@/services/course-import";
import { recordCourseExposure } from "@/services/course-exposure";
import { verifyCanonicalLink } from "@/services/course-link";
import {
  getPaperFreshness,
  getPaperFreshnessIndex,
  isPaperEligibleForStrictMock,
  summarizePaperFreshness,
} from "@/services/paper-freshness";
import { getPaperLibrary, getPaperDetailView } from "@/services/papers";
import {
  COURSE_EXPOSURE_SEEN_BASIS,
  EXPOSURE_TYPES_ESTABLISHING_POTENTIAL_CONTACT,
  EXPOSURE_TYPES_ESTABLISHING_SEEN_CONTENT,
  PAPER_FRESHNESS_LABELS,
  decidePaperFreshness,
  describeFreshnessTarget,
  establishesPotentialContact,
  establishesSeenContent,
  explainPaperFreshness,
  explainStrictMockIneligibility,
  findExposureRegistryGaps,
  isPaperEligibleForStrictMock as domainIsEligible,
  type PaperExposureMatch,
} from "@/domain/paper-freshness";
import { COURSE_EXPOSURE_EVENT_TYPES } from "@/domain/course";
import { isPaperStartableForPractice, RESERVED_PAPER_REASON } from "@/domain/paper";
import type { Repositories } from "@/repositories/ports";
import { buildCourseFixture, writeCourseFixture } from "../scripts/course-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import { planImport, commitImport } from "@/services/paper-import";
import { listReadingTargetCandidates } from "@/services/reading-plan";
import { startReadingRun } from "@/services/expert-training";

/**
 * 模考**新鲜度**（Course Exposure → Mock Freshness）的行为矩阵。
 *
 * ── 这组测试守护的那条新语义 ──
 *
 * 系统此前已守住「课程曝光 ≠ 表现证据」。本阶段补上第二条：
 *
 *     **课程曝光到已核验的真题内容 ≠ 这份试卷仍然「完全没见过」。**
 *
 * ── 为什么每一例都要走**真实**的磁盘与数据库 ──
 *
 * 这条能力的全部风险在于「结论与实际事实脱钩」：库里写着 pristine，
 * 而学习者其实已经看过。因此每个用例都真实写入课程包 / 试卷包（临时目录），
 * 真实导入，真实记录曝光，真实核验链接 —— 不做任何 mock。
 * 唯一被直接调用（不经磁盘）的是 domain 层的纯函数，那正是它被抽出来的原因。
 *
 * ── 编号与任务书的 22 条行为用例一一对应 ──
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

const COURSE_ID = "fixture-course-a";
const SEGMENT_ID = "reading.a";
const SEGMENT_B = "reading.b";
const PAPER_A = "fixture-cet6-2024-12-v1"; // 主要被测试卷
const PAPER_B = "fixture-cet6-2024-12-v2"; // 第二份，用于 profile 隔离 / 无关卷等
const PROFILE_A = "p1";
const PROFILE_B = "p2";

const SECTION = "reading.careful_reading";

/**
 * 两份试卷夹具的**身份**必须不同。
 *
 * 唯一约束是 `(exam_type, year, session, variant)`，而 `id` **不参与**它。
 * 因此只换 id 是不够的：两份包会被判成「同一份卷子的两次导入」。
 * 这里让套别号不同，于是它们真的是两份不同的卷子。
 */
const PAPER_IDENTITY: Record<string, { year: number; session: "December"; variant: string }> = {
  [PAPER_A]: { year: 2024, session: "December", variant: "set1" },
  [PAPER_B]: { year: 2024, session: "December", variant: "set2" },
};

function seedProfile(id: string, name: string): void {
  db.prepare(
    "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run(id, name, 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
}

/** 导入（或升版）课程夹具。 */
function importCourse(fixture = buildCourseFixture(), courseId = COURSE_ID): void {
  writeCourseFixture(contentRoot, courseId, fixture);
  const result = commitCourseImport(repos, planCourseImport(repos));
  expect(result.ok, `课程导入失败：${result.error}`).toBe(true);
}

/** 导入（或升版）一份试卷夹具。身份取自 PAPER_IDENTITY。 */
function importPaper(id = PAPER_A, contentVersion = 1, omitSections: string[] = []): void {
  const identity = PAPER_IDENTITY[id] ?? {
    year: 2024,
    session: "December" as const,
    variant: "set1",
  };
  writeFixturePackage(
    contentRoot,
    id,
    buildFixturePackage({ id, contentVersion, omitSections, ...identity }),
  );
  const paperPlan = planImport(repos, { only: [id] });
  const result = commitImport(repos, paperPlan);
  expect(result.ok, `试卷导入失败：${result.error}`).toBe(true);
}

function importBothPapers(): void {
  importPaper(PAPER_A);
  importPaper(PAPER_B);
}

function recordExposure(overrides: Record<string, unknown> = {}) {
  return recordCourseExposure(repos, {
    profileId: PROFILE_A,
    courseId: COURSE_ID,
    segmentId: SEGMENT_ID,
    courseContentVersion: 1,
    eventType: "content_rendered",
    occurredAt: "2026-02-01T10:00:00.000Z",
    ...overrides,
  });
}

/** 建立一条已核验的链接（默认指向 PAPER_A 的仔细阅读大题）。 */
function link(overrides: Record<string, unknown> = {}) {
  return verifyCanonicalLink(repos, {
    courseId: COURSE_ID,
    courseContentVersion: 1,
    segmentId: SEGMENT_ID,
    paperId: PAPER_A,
    paperContentVersion: 1,
    sectionId: SECTION,
    targetScope: "section",
    verificationStatus: "verified",
    verificationRef: "人工核验：用例夹具",
    ...overrides,
  });
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint };
  return Number(row.c);
}

/** 所有与「表现证据 / 学习结论」相关的表 —— 曝光绝不允许写入它们。 */
const EVIDENCE_TABLES = [
  "learning_run",
  "performance_event",
  "assessment_event",
  "evidence_projection",
  "skill_profile",
  "answer_attempt",
  "review_item",
  "study_session",
  "study_task",
  "daily_plan",
];

/** 直接在盘上改动一个规范化包，但**不重新导入** —— 用于构造漂移。 */
function driftManifest(
  relativePathSegments: string[],
  mutate: (manifest: Record<string, unknown>) => void,
): void {
  const manifestPath = join(contentRoot, ...relativePathSegments);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
  mutate(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-freshness-"));
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);
  seedProfile(PROFILE_A, "Learner");
  seedProfile(PROFILE_B, "Other");
});

afterEach(() => {
  /*
   * 原生句柄必须确定性关闭。
   *
   * `DatabaseSync` 持有原生文件句柄与原生内存，只清引用只是让它"可回收"，
   * 并不会在测试结束前真正释放。下面的 rmSync 会删掉它指向的目录，
   * 于是句柄指向一个已消失的文件。这个状态从 JavaScript 完全不可观测，
   * 只在原生层中止时暴露成进程退出码 0xC0000409。
   */
  try {
    db.close();
  } catch {
    // 已关闭过就不该让清理失败。
  }

  if (previousRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
  else process.env.CET6_CONTENT_ROOT = previousRoot;
  rmSync(contentRoot, { recursive: true, force: true });
});

// ===========================================================================
// 用例 1 / 2 —— 基线：没有曝光，或曝光落在未匹配的段上
// ===========================================================================

describe("新鲜度 · 基线（用例 1 / 2）", () => {
  it("1 · 没有任何课程曝光 ⇒ 试卷保持 pristine", () => {
    importBothPapers();
    importCourse();

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("pristine");
    expect(freshness.matches).toEqual([]);
    expect(freshness.unresolved).toEqual([]);
    expect(isPaperEligibleForStrictMock(repos, PROFILE_A, PAPER_A)).toBe(true);
  });

  it("2 · 曝光落在**未匹配**的段上 ⇒ 不会凭空指认出任何试卷", () => {
    importBothPapers();
    importCourse();

    // 只有曝光，没有链接。
    expect(recordExposure().ok).toBe(true);

    // 两份试卷都仍然 pristine —— 未匹配是合法状态，不是「猜一个」。
    for (const paperId of [PAPER_A, PAPER_B]) {
      const freshness = getPaperFreshness(repos, PROFILE_A, paperId);
      expect(freshness.state, `${paperId} 不应被未匹配的曝光污染`).toBe("pristine");
      expect(freshness.matches).toEqual([]);
    }

    // 曝光本身如实存下来了（信息没有丢）。
    expect(repos.courses.countExposure(PROFILE_A)).toBe(1);
  });

  it("2b · 曝光在**别的课程包**上、且该包与试卷无关 ⇒ 试卷仍 pristine", () => {
    importBothPapers();
    importCourse();
    importCourse(buildCourseFixture({ id: "fixture-course-other" }), "fixture-course-other");

    recordExposure({ courseId: "fixture-course-other" });

    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("pristine");
  });
});

// ===========================================================================
// 用例 3 / 4 / 21 —— 顺序无关：历史曝光必须能回溯投影
// ===========================================================================

describe("新鲜度 · 曝光与链接的顺序无关（用例 3 / 4 / 21）", () => {
  it("3 · **先曝光、后核验** ⇒ 历史曝光回溯投影到该真题目标", () => {
    importBothPapers();
    importCourse();

    // 曝光时该段还没有任何链接 —— 这正是历史必须能被投影的场景。
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toEqual([]);
    const exposure = recordExposure({ occurredAt: "2026-02-01T10:00:00.000Z" });
    expect(exposure.ok).toBe(true);
    if (!exposure.ok) return;
    const exposureId = exposure.event.id;

    // 两周后才核验出对应关系。
    const created = link();
    expect(created.ok, created.ok ? "" : JSON.stringify(created.issues)).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("exposed");
    expect(freshness.matches).toHaveLength(1);
    expect(freshness.matches[0].sectionId).toBe(SECTION);
    expect(freshness.matches[0].segmentId).toBe(SEGMENT_ID);
    expect(freshness.matches[0].courseContentVersion).toBe(1);

    // 且**曝光行本身原样未动**（用例 21 的一半：不靠改写曝光来建立投影）。
    const row = db
      .prepare(
        "SELECT id, segment_id, course_content_version, event_type FROM course_exposure_event WHERE id = ?",
      )
      .get(exposureId) as {
      id: string;
      segment_id: string;
      course_content_version: number;
      event_type: string;
    };
    expect(row).toEqual({
      id: exposureId,
      segment_id: SEGMENT_ID,
      course_content_version: 1,
      event_type: "content_rendered",
    });
  });

  it("4 · **先核验、后曝光** ⇒ 得到**同样的** exposed 结果", () => {
    importBothPapers();
    importCourse();

    expect(link().ok).toBe(true);
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("pristine");

    recordExposure({ occurredAt: "2026-03-01T10:00:00.000Z" });

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("exposed");
    expect(freshness.matches).toHaveLength(1);
  });

  it("3b/4b · 两种顺序产生的**证据内容**逐字段相同（顺序不进入结论）", () => {
    /** 走一遍给定顺序，返回证据的可比投影。 */
    function run(order: "exposure-first" | "link-first") {
      const localRoot = mkdtempSync(join(tmpdir(), "cet6-order-"));
      const localDb = createTestDb();
      const localRepos = createSqliteRepositories(localDb);
      const savedRoot = process.env.CET6_CONTENT_ROOT;
      process.env.CET6_CONTENT_ROOT = localRoot;
      try {
        localDb
          .prepare(
            "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
          )
          .run(PROFILE_A, "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

        writeFixturePackage(
          localRoot,
          PAPER_A,
          buildFixturePackage({ id: PAPER_A, ...PAPER_IDENTITY[PAPER_A] }),
        );
        commitImport(localRepos, planImport(localRepos, { only: [PAPER_A] }));
        writeCourseFixture(localRoot, COURSE_ID, buildCourseFixture());
        commitCourseImport(localRepos, planCourseImport(localRepos));

        const expose = () =>
          recordCourseExposure(localRepos, {
            profileId: PROFILE_A,
            courseId: COURSE_ID,
            segmentId: SEGMENT_ID,
            courseContentVersion: 1,
            eventType: "declared_seen",
            occurredAt: "2026-05-05T00:00:00.000Z",
          });
        const verify = () =>
          verifyCanonicalLink(localRepos, {
            courseId: COURSE_ID,
            courseContentVersion: 1,
            segmentId: SEGMENT_ID,
            paperId: PAPER_A,
            paperContentVersion: 1,
            sectionId: SECTION,
            targetScope: "section",
            verificationStatus: "verified",
            verificationRef: "顺序无关用例",
          });

        if (order === "exposure-first") {
          expose();
          verify();
        } else {
          verify();
          expose();
        }

        const freshness = getPaperFreshness(localRepos, PROFILE_A, PAPER_A);
        /*
         * linkId / verificationRef 不参与比较：两种顺序会产生不同的行 id，
         * 那是合理的。比较的是**结论与证据身份**。
         */
        return {
          state: freshness.state,
          matches: freshness.matches.map((match) => ({
            paperId: match.paperId,
            sectionId: match.sectionId,
            groupId: match.groupId,
            questionId: match.questionId,
            targetScope: match.targetScope,
            courseId: match.courseId,
            segmentId: match.segmentId,
            courseContentVersion: match.courseContentVersion,
            firstExposedAt: match.firstExposedAt,
            lastExposedAt: match.lastExposedAt,
            exposureCount: match.exposureCount,
            eventTypes: match.eventTypes,
          })),
        };
      } finally {
        if (savedRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
        else process.env.CET6_CONTENT_ROOT = savedRoot;
        /*
         * Close the handle this iteration opened before removing its scratch root.
         *
         * `createTestDb()` opens `:memory:`, so there is no file to unlink here — but
         * the handle is still a native allocation that should not be left to a
         * finaliser, and closing it in `finally` keeps this helper's ownership rule
         * the same as every other place a database is opened. `run()` is called twice
         * per test, so without this each test leaks two handles.
         *
         * The close is guarded because the success path may already have closed it,
         * and a second close throws on this runtime.
         */
        try {
          localDb.close();
        } catch {
          /* already closed */
        }
        rmSync(localRoot, { recursive: true, force: true });
      }
    }

    const exposureFirst = run("exposure-first");
    const linkFirst = run("link-first");
    expect(exposureFirst).toEqual(linkFirst);
    expect(exposureFirst.state).toBe("exposed");
  });

  it("21 · 后建的链接让**旧**曝光可见，且不重写任何曝光行", () => {
    importBothPapers();
    importCourse();

    recordExposure({ occurredAt: "2026-02-01T10:00:00.000Z" });
    const beforeRows = db
      .prepare("SELECT * FROM course_exposure_event ORDER BY id")
      .all() as Array<Record<string, unknown>>;

    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("pristine");
    expect(link().ok).toBe(true);
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");

    // 曝光表逐字节未变：没有新增、没有改写。
    const afterRows = db
      .prepare("SELECT * FROM course_exposure_event ORDER BY id")
      .all() as Array<Record<string, unknown>>;
    expect(afterRows).toEqual(beforeRows);

    // 而链接表**只有**新增的那一行。
    expect(countRows("course_canonical_link")).toBe(1);
  });
});

// ===========================================================================
// 用例 5 / 6 / 22 —— candidate / rejected 从不建立真题身份
// ===========================================================================

describe("新鲜度 · 未核验的链接不建立真题身份（用例 5 / 6 / 22）", () => {
  for (const status of ["candidate", "rejected"] as const) {
    it(`5/6 · ${status} 链接 ⇒ **不**产生正面投影，且**不**制造不确定性`, () => {
      importBothPapers();
      importCourse();
      recordExposure();

      const result = verifyCanonicalLink(repos, {
        courseId: COURSE_ID,
        courseContentVersion: 1,
        segmentId: SEGMENT_ID,
        paperId: PAPER_A,
        paperContentVersion: 1,
        sectionId: SECTION,
        targetScope: "section",
        verificationStatus: status,
        verificationRef: `${status} 用例`,
      });
      expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);

      // 行确实落库了（审计线索保留）。
      expect(countRows("course_canonical_link")).toBe(1);

      const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
      /*
       * 关键：candidate / rejected **既不是**正面证据（不 exposed），
       * **也不是**不确定性（不 uncertain）。
       *
       * 后一半同样重要：一条机器候选不代表「这段材料可能对应那道题」这个
       * 成立主张。若把它当成不确定性，一次普通的候选生成就会让整库试卷
       * 变成 uncertain —— 那是把噪声当成谨慎。
       */
      expect(freshness.state, `${status} 不应产生任何结论`).toBe("pristine");
      expect(freshness.matches).toEqual([]);
      expect(freshness.unresolved).toEqual([]);
    });
  }

  it("22 · candidate / rejected / stale 永远不会「意外变成」运行时可用的证据", () => {
    importBothPapers();
    importCourse();
    recordExposure();

    // 同一段上同时存在：一条候选、一条否决（外加后面一条 verified 作对照）。
    for (const status of ["candidate", "rejected"] as const) {
      verifyCanonicalLink(repos, {
        courseId: COURSE_ID,
        courseContentVersion: 1,
        segmentId: SEGMENT_ID,
        paperId: PAPER_A,
        paperContentVersion: 1,
        sectionId: SECTION,
        targetScope: "section",
        verificationStatus: status,
        verificationRef: `${status} 用例`,
      });
    }
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("pristine");

    // 现在补一条 verified —— 只有它才产生投影。
    expect(link().ok).toBe(true);
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");

    // 而候选 / 否决那两行仍然**不**贡献证据（证据数 = 1，不是 3）。
    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.matches).toHaveLength(1);
    expect(freshness.matches[0].verificationRef).toBe("人工核验：用例夹具");
    expect(countRows("course_canonical_link")).toBe(3);
  });
});

// ===========================================================================
// 用例 7 / 8 —— 版本身份必须精确
// ===========================================================================

describe("新鲜度 · 版本身份必须精确（用例 7 / 8）", () => {
  it("7 · 课程升版 ⇒ 旧曝光**不会**通过新版本链接被投影为精确正面证据", () => {
    importBothPapers();
    importCourse();

    // v1 上：曝光 + 链接（此时确实 exposed）。
    recordExposure({ courseContentVersion: 1 });
    expect(link().ok).toBe(true);
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");

    // 课程升到 v2：链接**立即失效**。
    importCourse(
      buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }),
    );
    expect(repos.courses.getPackage(COURSE_ID)!.contentVersion).toBe(2);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    /*
     * 结果必须是 **uncertain**，不能是 pristine。
     *
     * 两种错误都会在这里被抓住：
     * - 若实现把「链接失配」当成「没有证据」 ⇒ 变成 pristine（fail open）；
     * - 若实现忽略版本、把 v1 的曝光套到 v2 的链接上 ⇒ 变成 exposed（伪造精确性）。
     */
    expect(freshness.state, "失效链接不得回退成 pristine，也不得跨版本套用").toBe("uncertain");
    expect(freshness.matches).toEqual([]);
    expect(freshness.unresolved.length).toBeGreaterThan(0);
    expect(freshness.unresolved.some((item) => item.code === "link_not_runtime_usable")).toBe(true);
    expect(isPaperEligibleForStrictMock(repos, PROFILE_A, PAPER_A)).toBe(false);
  });

  it("7b · 链接成立但曝光只落在**另一版**上 ⇒ uncertain（不能证明是同一版内容）", () => {
    importBothPapers();
    importCourse();

    // 先在 v1 上看过，但没有链接。
    recordExposure({ courseContentVersion: 1 });

    // 课程升到 v2，并在 v2 上建立链接（新内容、新复核）。
    importCourse(
      buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }),
    );
    const v2Link = verifyCanonicalLink(repos, {
      courseId: COURSE_ID,
      courseContentVersion: 2,
      segmentId: SEGMENT_ID,
      paperId: PAPER_A,
      paperContentVersion: 1,
      sectionId: SECTION,
      targetScope: "section",
      verificationStatus: "verified",
      verificationRef: "v2 复核",
    });
    expect(v2Link.ok, v2Link.ok ? "" : JSON.stringify(v2Link.issues)).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state, "看过 v1、被核验的是 v2 ⇒ 无法证明是同一版").toBe("uncertain");
    expect(freshness.matches).toEqual([]);
    expect(freshness.unresolved.some((item) => item.code === "exposure_version_mismatch")).toBe(true);
  });

  it("8 · 真题升版 ⇒ 旧链接失效，**不得**静默声称当前试卷 pristine", () => {
    importBothPapers();
    importCourse();
    recordExposure({ courseContentVersion: 1 });
    expect(link({ paperContentVersion: 1 }).ok).toBe(true);
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");

    // 试卷升到 v2 —— 那条记录 v1 的链接立即不再可用。
    importPaper(PAPER_A, 2);
    expect(repos.papers.getPaper(PAPER_A)!.contentVersion).toBe(2);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state, "试卷升版后不得静默回到 pristine").toBe("uncertain");
    expect(freshness.matches).toEqual([]);
    expect(freshness.unresolved.length).toBeGreaterThan(0);
  });

  it("8b · 变体卷（不同 paperId）不受影响 —— 身份按 id 而非「看起来像」", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    expect(link({ paperId: PAPER_A }).ok).toBe(true);

    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_B).state, "另一份试卷不受牵连").toBe(
      "pristine",
    );
  });
});

// ===========================================================================
// 用例 9 —— 包状态不可求证时失败关闭
// ===========================================================================

describe("新鲜度 · 包状态不可求证时失败关闭（用例 9）", () => {
  it("9a · 课程包被删掉 ⇒ uncertain（不是 pristine）", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    expect(link().ok).toBe(true);
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");

    // 把盘上的课程包整个删掉。
    rmSync(join(contentRoot, "courses", COURSE_ID), { recursive: true, force: true });

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("uncertain");
    expect(freshness.unresolved.some((item) => item.code === "course_package_unreadable")).toBe(true);
    expect(isPaperEligibleForStrictMock(repos, PROFILE_A, PAPER_A)).toBe(false);
  });

  it("9b · 课程包在盘上被改动（未重新导入）⇒ uncertain", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    expect(link().ok).toBe(true);

    // 直接改盘上的 course.json，**不升版本、不重新导入**。
    driftManifest(["courses", COURSE_ID, "course.json"], (manifest) => {
      manifest.title = "synthetic fixture title drift";
    });

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("uncertain");
    expect(freshness.unresolved.some((item) => item.code === "course_package_drifted")).toBe(true);
  });

  it("9c · 真题包缺失 ⇒ uncertain，且**不**回退成 pristine", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    expect(link().ok).toBe(true);

    rmSync(join(contentRoot, "cet6", "papers", PAPER_A), { recursive: true, force: true });

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("uncertain");
    expect(isPaperEligibleForStrictMock(repos, PROFILE_A, PAPER_A)).toBe(false);
  });

  it("9d · 真题包被改动（未重新导入）⇒ uncertain", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    expect(link().ok).toBe(true);

    driftManifest(["cet6", "papers", PAPER_A, "paper.json"], (manifest) => {
      manifest.variant = "drift";
    });

    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("uncertain");
  });

  it("9e · 目标大题在新真题包里已不存在 ⇒ uncertain", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    // 链接指向仔细阅读。
    expect(link({ sectionId: SECTION }).ok).toBe(true);
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");

    /*
     * 重新导入一份**不含该大题**的包（omitSections），且升版本 ——
     * 于是链接声明的大题在当前包里不存在。
     */
    importPaper(PAPER_A, 2, [SECTION]);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("uncertain");
    expect(freshness.matches).toEqual([]);
  });
});

// ===========================================================================
// 用例 10 / 11 —— 池归属与新鲜度是两个不同的问题
// ===========================================================================

describe("新鲜度 · 与训练池策略互不覆盖（用例 10 / 11）", () => {
  it("10 · 保留卷被证明接触过 ⇒ 池**保持** mock_reserve，事实变 exposed，且不再合格", () => {
    importBothPapers();
    importCourse();
    repos.papers.setPool(PAPER_A, "mock_reserve");

    recordExposure();
    expect(link().ok).toBe(true);

    // 池归属**没有被系统改写**（Invariant 3）。
    expect(repos.papers.getPaper(PAPER_A)!.pool, "池归属只能由使用者改").toBe("mock_reserve");

    // 但事实变了。
    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("exposed");
    expect(isPaperEligibleForStrictMock(repos, PROFILE_A, PAPER_A)).toBe(false);

    // 且「能否作为日常训练开始」这一既有结论**没有**被曝光影响。
    expect(isPaperStartableForPractice(repos.papers.getPaper(PAPER_A)!)).toBe(false);
    expect(RESERVED_PAPER_REASON).toContain("模考保留");
  });

  it("10b · 两份结论并存：被标为模考保留 **且** 已接触过 —— 两者都如实可见", () => {
    importBothPapers();
    importCourse();
    repos.papers.setPool(PAPER_A, "mock_reserve");
    recordExposure();
    expect(link().ok).toBe(true);

    const view = getPaperDetailView(repos, PAPER_A, PROFILE_A);
    expect(view).not.toBeNull();
    if (!view) return;

    expect(view.detail.record.pool, "策略结论").toBe("mock_reserve");
    expect(view.freshness!.state, "内容事实").toBe("exposed");
    // 两条结论互相独立 —— 它们不是同一个字段的两种取值。
    expect(view.detail.record.pool === "mock_reserve" && view.freshness!.state === "exposed").toBe(
      true,
    );
  });

  it("11 · 训练池试卷获得曝光 ⇒ 日常训练可用性**完全不变**", () => {
    importBothPapers();
    importCourse();
    expect(repos.papers.getPaper(PAPER_A)!.pool).toBe("training");

    const before = isPaperStartableForPractice(repos.papers.getPaper(PAPER_A)!);
    const runsBefore = repos.expert.listRuns(PROFILE_A, 200).length;

    recordExposure();
    expect(link().ok).toBe(true);
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");

    // 训练池语义不回归：仍然可练，且池没变。
    expect(repos.papers.getPaper(PAPER_A)!.pool).toBe("training");
    expect(isPaperStartableForPractice(repos.papers.getPaper(PAPER_A)!)).toBe(before);

    // planner 的候选发现**不受曝光影响**（本阶段明确不把「看过」变成排序依据）。
    expect(listReadingTargetCandidates(repos, PROFILE_A).length).toBeGreaterThan(0);

    // 曝光**不**创建任何会话。
    expect(repos.expert.listRuns(PROFILE_A, 200).length).toBe(runsBefore);
  });
});

// ===========================================================================
// 用例 12 / 13 / 14 / 15 —— 粒度与整卷聚合
// ===========================================================================

describe("新鲜度 · 目标粒度保留、整卷失败关闭（用例 12 / 13 / 14 / 15）", () => {
  /** 取试卷 A 的一个真实题组与题目 id（来自夹具包，不硬编码）。 */
  function realTarget() {
    const detail = getPaperDetailView(repos, PAPER_A, PROFILE_A)!.detail;
    const section = detail.content!.sections.find((item) => item.id === SECTION)!;
    const group = section.groups[0];
    const question = group.questions[0];
    return { groupId: group.id, questionId: question.id };
  }

  it("12 · section 粒度的已核验曝光 ⇒ 整卷严格新鲜度被破坏，且粒度如实保留", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    expect(link({ targetScope: "section" }).ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("exposed");
    expect(freshness.matches[0].targetScope).toBe("section");
    expect(freshness.matches[0].sectionId).toBe(SECTION);
    expect(freshness.matches[0].groupId).toBeNull();
    expect(isPaperEligibleForStrictMock(repos, PROFILE_A, PAPER_A)).toBe(false);
  });

  it("13 · group 粒度的已核验曝光 ⇒ 同样聚合到整卷", () => {
    importBothPapers();
    importCourse();
    const { groupId } = realTarget();

    recordExposure();
    const created = link({ targetScope: "group", groupId, sectionId: SECTION });
    expect(created.ok, created.ok ? "" : JSON.stringify(created.issues)).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("exposed");
    expect(freshness.matches[0].targetScope).toBe("group");
    expect(freshness.matches[0].groupId).toBe(groupId);
    expect(freshness.matches[0].questionId).toBeNull();
    expect(isPaperEligibleForStrictMock(repos, PROFILE_A, PAPER_A)).toBe(false);
  });

  it("14 · question 粒度的已核验曝光 ⇒ 同样聚合到整卷", () => {
    importBothPapers();
    importCourse();
    const { groupId, questionId } = realTarget();

    recordExposure();
    const created = link({ targetScope: "question", groupId, questionId, sectionId: SECTION });
    expect(created.ok, created.ok ? "" : JSON.stringify(created.issues)).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("exposed");
    expect(freshness.matches[0].targetScope).toBe("question");
    expect(freshness.matches[0].questionId).toBe(questionId);
    expect(freshness.matches[0].groupId).toBe(groupId);
    expect(isPaperEligibleForStrictMock(repos, PROFILE_A, PAPER_A)).toBe(false);
  });

  it("14b · 单题被接触 **不等于** 整卷被掌握（措辞不得越界）", () => {
    importBothPapers();
    importCourse();
    const { groupId, questionId } = realTarget();

    recordExposure();
    expect(link({ targetScope: "question", groupId, questionId, sectionId: SECTION }).ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    const text = explainPaperFreshness(freshness);
    // 必须说明「不代表会/不会做」，且不得出现掌握度 / 分数 / 弱项措辞。
    expect(text).toContain("不代表");
    for (const forbidden of ["掌握度", "正确率", "得分", "弱项", "水平", "能力分"]) {
      expect(text, `原因文案不得出现表现性措辞「${forbidden}」`).not.toContain(forbidden);
    }
    for (const forbidden of ["污染", "脏", "tainted", "contaminated", "invalid"]) {
      expect(text, `原因文案不得把事实说成缺陷「${forbidden}」`).not.toContain(forbidden);
    }
  });

  it("15 · 同一试卷上多个已接触的段 ⇒ 聚合确定，且**不重复膨胀**", () => {
    importBothPapers();
    importCourse();

    // 两个不同的段，各自有曝光与链接，都指向同一份试卷。
    recordExposure({ segmentId: SEGMENT_ID, occurredAt: "2026-02-01T10:00:00.000Z" });
    recordExposure({ segmentId: SEGMENT_B, occurredAt: "2026-02-02T10:00:00.000Z" });

    expect(link({ segmentId: SEGMENT_ID, sectionId: SECTION }).ok).toBe(true);
    expect(link({ segmentId: SEGMENT_B, sectionId: "reading.matching" }).ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("exposed");
    // 两个**不同的目标** ⇒ 两条证据（不是四条，也不是一条）。
    expect(freshness.matches).toHaveLength(2);
    expect(new Set(freshness.matches.map((match) => match.segmentId))).toEqual(
      new Set([SEGMENT_ID, SEGMENT_B]),
    );
  });

  it("15b · 同一目标被多次曝光 / 多次复核 ⇒ 合并成**一条**证据", () => {
    importBothPapers();
    importCourse();

    // 同一段看三次。
    recordExposure({ occurredAt: "2026-02-01T10:00:00.000Z" });
    recordExposure({ occurredAt: "2026-02-02T10:00:00.000Z" });
    recordExposure({ occurredAt: "2026-02-03T10:00:00.000Z" });
    // 同一映射被独立复核两次（不同出处 ⇒ 两行，同一语义目标）。
    expect(link({ verificationRef: "复核者甲" }).ok).toBe(true);
    expect(link({ verificationRef: "复核者乙" }).ok).toBe(true);

    expect(countRows("course_canonical_link")).toBe(2);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("exposed");
    // 语义目标只有一个 ⇒ 证据只有一条。次数如实记录，但不改变聚合。
    expect(freshness.matches).toHaveLength(1);
    expect(freshness.matches[0].exposureCount).toBe(3);
    expect(freshness.matches[0].firstExposedAt).toBe("2026-02-01T10:00:00.000Z");
    expect(freshness.matches[0].lastExposedAt).toBe("2026-02-03T10:00:00.000Z");
  });

  it("15c · 同一段链到**两个不同目标** ⇒ 两条证据，各自成立", () => {
    importBothPapers();
    importCourse();
    recordExposure();

    expect(link({ sectionId: SECTION }).ok).toBe(true);
    expect(link({ sectionId: "reading.matching" }).ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("exposed");
    expect(freshness.matches).toHaveLength(2);
    expect(new Set(freshness.matches.map((match) => match.sectionId))).toEqual(
      new Set([SECTION, "reading.matching"]),
    );
  });
});

// ===========================================================================
// 用例 16 —— 同一段链到不同试卷（不发明排他性）
// ===========================================================================

describe("新鲜度 · 同一段链到多份试卷（用例 16）", () => {
  it("16 · 每份试卷各自按证据判定 —— 不发明「专属性」", () => {
    importBothPapers();
    importCourse();
    recordExposure();

    expect(link({ paperId: PAPER_A, sectionId: SECTION }).ok).toBe(true);
    expect(link({ paperId: PAPER_B, sectionId: "reading.matching" }).ok).toBe(true);

    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_B).state).toBe("exposed");

    // 证据各自独立，互不派生。（既有的链接模型允许多条目标并存，
    // 本能力不额外发明「一段只能对应一份卷子」这条不存在的约束。）
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).matches[0].paperId).toBe(PAPER_A);
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_B).matches[0].paperId).toBe(PAPER_B);
  });
});

// ===========================================================================
// 用例 17 —— profile 隔离
// ===========================================================================

describe("新鲜度 · profile 之间完全隔离（用例 17）", () => {
  it("17 · 曝光属于 profile A ⇒ profile B 的试卷保持 pristine", () => {
    importBothPapers();
    importCourse();

    recordExposure({ profileId: PROFILE_A });
    expect(link().ok).toBe(true);

    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("exposed");
    expect(
      getPaperFreshness(repos, PROFILE_B, PAPER_A).state,
      "另一个 profile 不得继承别人的曝光",
    ).toBe("pristine");
    expect(isPaperEligibleForStrictMock(repos, PROFILE_B, PAPER_A)).toBe(true);
  });

  it("17b · profile B 自己看过同一段 ⇒ 只影响 B", () => {
    importBothPapers();
    importCourse();

    recordExposure({ profileId: PROFILE_A });
    recordExposure({ profileId: PROFILE_B });
    expect(link().ok).toBe(true);

    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).matches).toHaveLength(1);
    expect(getPaperFreshness(repos, PROFILE_B, PAPER_A).matches).toHaveLength(1);

    // 两者的证据各自绑到自己 profile 的曝光上（计数都是 1，没有互相叠加）。
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).matches[0].exposureCount).toBe(1);
    expect(getPaperFreshness(repos, PROFILE_B, PAPER_A).matches[0].exposureCount).toBe(1);
  });
});

// ===========================================================================
// 用例 18 —— 输出确定性
// ===========================================================================

describe("新鲜度 · 输出确定（用例 18）", () => {
  it("18 · 同一状态重复求解 ⇒ 结果逐字段相同（顺序不依赖查询返回顺序）", () => {
    importBothPapers();
    importCourse();
    recordExposure({ segmentId: SEGMENT_ID });
    recordExposure({ segmentId: SEGMENT_B, occurredAt: "2026-02-02T10:00:00.000Z" });
    expect(link({ segmentId: SEGMENT_ID, sectionId: SECTION }).ok).toBe(true);
    expect(link({ segmentId: SEGMENT_B, sectionId: "reading.matching" }).ok).toBe(true);

    const first = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    const second = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));

    // 且证据顺序由**内容**决定（sectionId 升序），不依赖任何插入顺序。
    const sections = first.matches.map((match) => match.sectionId);
    expect(sections).toEqual([...sections].sort());

    // 整库索引的 notable 列表也是确定的。
    const indexA = getPaperFreshnessIndex(repos, PROFILE_A);
    const indexB = getPaperFreshnessIndex(repos, PROFILE_A);
    expect(JSON.stringify(indexB)).toBe(JSON.stringify(indexA));
  });

  it("18b · 未解决条件的顺序也是确定的", () => {
    importBothPapers();
    importCourse();
    // 两个段上都必须**确实有曝光** —— 没有曝光过的段不进入考察范围（见 18c）。
    recordExposure({ segmentId: SEGMENT_ID });
    recordExposure({ segmentId: SEGMENT_B, occurredAt: "2026-02-02T10:00:00.000Z" });
    expect(link({ paperId: PAPER_A, sectionId: SECTION }).ok).toBe(true);
    expect(link({ paperId: PAPER_A, sectionId: "reading.matching", segmentId: SEGMENT_B }).ok).toBe(
      true,
    );

    // 让课程包漂移 ⇒ 两条链接都变成未解决。
    driftManifest(["courses", COURSE_ID, "course.json"], (manifest) => {
      manifest.edition = "drift";
    });

    const first = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    const second = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(first.unresolved.length).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(second.unresolved)).toBe(JSON.stringify(first.unresolved));
  });

  it("18c · 从未曝光过的段上的（哪怕已失效的）链接**完全不被考察**", () => {
    /*
     * ── 这是一条刻意的、重要的边界 ──
     *
     * 未解决条件的唯一存在理由是「我们无法证明这份试卷仍然未被接触」。
     * 而若某个段**从来没有**曝光，那条链接无论成立与否都不携带任何关于
     * 这位学习者的信息 —— 他没看过那段材料，它不可能造成任何接触。
     *
     * 不这样收口的后果是具体的：一次普通的课程升版会让**任意**一条陈旧链接
     * 失效。若把"没有曝光过的段上的失效链接"也算作不确定性，整库试卷会因为
     * 与本人无关的链接而变成 uncertain —— 于是"无法确认"从一种值得注意的
     * 状态退化成一句背景噪声，真正需要注意的那一份反而被淹没。
     */
    importBothPapers();
    importCourse();

    // 两个段各有链接；但只有 SEGMENT_ID 上**确实有曝光**。
    expect(link({ paperId: PAPER_A, sectionId: SECTION, segmentId: SEGMENT_ID }).ok).toBe(true);
    expect(link({ paperId: PAPER_A, sectionId: "reading.matching", segmentId: SEGMENT_B }).ok).toBe(
      true,
    );
    recordExposure({ segmentId: SEGMENT_ID });

    // 课程升版 ⇒ 两条链接**都**失效。
    importCourse(
      buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }),
    );

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    /*
     * SEGMENT_ID 上确有本人曝光，且那条链接记录的是当时那一版 ——
     * 它是**本人的历史**，因此必须如实登记为 uncertain（不能是 pristine）。
     */
    expect(freshness.state).toBe("uncertain");
    // 而 SEGMENT_B（只有链接、没有任何曝光）不贡献任何条件。
    expect(freshness.unresolved).toHaveLength(1);
    expect(freshness.unresolved[0].segmentId).toBe(SEGMENT_ID);
  });

  it("18d · 段上只有**登记表判定为不足**的事件 ⇒ 同样不进入考察", () => {
    /*
     * ── 这条用例存在的理由：让 18c 的守卫**变得可达** ──
     *
     * 18c 守的是"没有「足以断言见过」的曝光的段不进入考察"。但在 V1 的默认
     * 登记表下，四种事件**全部**登记为"算见过"，因此那条守卫在当前配置下
     * 永远不成立 —— 一条不可达的守卫无法被变异测试证明。
     *
     * 本用例的构造方式让那个边界可达：这里**不**改登记表（改登记表就是
     * 改产品判断），而是把"不足以断言见过"当成本用例的前提去断言。
     *
     * 但 V1 里没有任何一种事件是"不足"的，所以本用例在 V1 下与 18c 同形 ——
     * 它真正的价值在变异测试里：`paper-freshness-mutation.ts` 的 M11 会
     * **同时**施加"把 declared_seen 判为不足"的伴随变异，于是那条守卫变得
     * 可达，而缺陷实现（把所有事件都算数）会在这里给出 uncertain 而不是 pristine。
     *
     * ── 为什么断言是 pristine ──
     *
     * 当段上唯一的事件被登记表判为"不足以断言见过"时，这段材料对这位学习者
     * 而言**没有可证明的接触** —— 因此它必须像"从未看过"一样被排除，
     * 而不是因为"有过一条我们决定不计入的事件"就变成 uncertain。
     * 把不足的事件也算作不确定性，等于让登记表失去意义。
     *
     * ── 说明本用例的确切语义 ──
     *
     * 用 `declared_seen` 作为"待判定"的那一种事件：它是四种里强度最低的
     * （学习者自述，不是系统观测），因此它是**最可能**在未来被重新判定的一种。
     * 本用例固定的是"一旦它被判定为不足，行为应当是什么"。
     */
    importBothPapers();
    importCourse();

    const TARGET_SEGMENT = SEGMENT_B;
    expect(link({ paperId: PAPER_A, sectionId: "reading.matching", segmentId: TARGET_SEGMENT }).ok).toBe(
      true,
    );
    // 该段上**只有** declared_seen（若它被判定为不足，则该段无有效曝光）。
    recordExposure({ segmentId: TARGET_SEGMENT, eventType: "declared_seen" });

    /*
     * 登记表当前把它判为"算见过"（V1 的取值），因此这里先如实断言当前行为：
     * 有有效曝光 + 链接成立 ⇒ exposed。变异测试会把登记表改成"不足"，
     * 届时同一条路径必须给出 pristine。
     */
    const before = getPaperFreshness(repos, PROFILE_A, PAPER_A);

    // 课程升版 ⇒ 链接失效。
    importCourse(
      buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }),
    );
    const after = getPaperFreshness(repos, PROFILE_A, PAPER_A);

    /*
     * 两种登记取值下都必须是"非 pristine"或"pristine"，取决于该事件是否计入 ——
     * 但**关键在于**：只要该事件被计入，链接失效就必须产生 uncertain，
     * 而不是静默回到 pristine。
     */
    if (establishesSeenContent("declared_seen")) {
      expect(before.state, "计入时：成立链接 ⇒ exposed").toBe("exposed");
      expect(after.state, "计入时：失效链接 ⇒ uncertain，不得回退").toBe("uncertain");
    } else {
      // 登记表判为不足 ⇒ 该段不进入考察，两种链接状态下都不产生结论。
      expect(before.state, "不计入时：不产生结论").toBe("pristine");
      expect(after.state, "不计入时：同样不产生结论").toBe("pristine");
      expect(after.unresolved).toEqual([]);
    }
  });
});

// ===========================================================================
// 用例 19 / 20 —— 边界：不产生表现证据、曝光只追加
// ===========================================================================

describe("新鲜度 · 绝不越界（用例 19 / 20）", () => {
  it("19 · 求解新鲜度 **不产生**任何表现证据 / 掌握度 / 弱项 / 诊断", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    expect(link().ok).toBe(true);

    // 把整个投影路径走一遍（索引 + 单份 + 详情视图 + 库）。
    getPaperFreshnessIndex(repos, PROFILE_A);
    getPaperFreshness(repos, PROFILE_A, PAPER_A);
    isPaperEligibleForStrictMock(repos, PROFILE_A, PAPER_A);
    getPaperDetailView(repos, PAPER_A, PROFILE_A);
    getPaperLibrary(repos, PROFILE_A);
    summarizePaperFreshness(getPaperFreshnessIndex(repos, PROFILE_A), repos.papers.listPapers());

    for (const table of EVIDENCE_TABLES) {
      expect(countRows(table), `求解新鲜度写入了 ${table}`).toBe(0);
    }
    expect(repos.expert.readProjection(PROFILE_A)).toEqual([]);
    expect(repos.skillProfile.get(PROFILE_A)).toBeNull();
  });

  it("19b · 曝光 + 链接 + 投影之后，Expert 台账仍然为空", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    expect(link().ok).toBe(true);
    getPaperFreshness(repos, PROFILE_A, PAPER_A);

    // 直接尝试在保留卷上开局也会被既有守卫拒绝 —— 与曝光无关。
    repos.papers.setPool(PAPER_A, "mock_reserve");
    const started = startReadingRun(repos, PROFILE_A, PAPER_A, SECTION);
    expect(started.ok).toBe(false);
    expect(countRows("learning_run")).toBe(0);
    expect(countRows("performance_event")).toBe(0);
  });

  it("20 · 曝光表在投影前后**逐行不变**，且 UPDATE / DELETE 仍被触发器阻断", () => {
    importBothPapers();
    importCourse();
    recordExposure({ occurredAt: "2026-02-01T10:00:00.000Z" });
    recordExposure({ eventType: "solution_rendered", occurredAt: "2026-02-02T10:00:00.000Z" });

    const before = db.prepare("SELECT * FROM course_exposure_event ORDER BY id").all();
    expect(link().ok).toBe(true);
    getPaperFreshness(repos, PROFILE_A, PAPER_A);
    const after = db.prepare("SELECT * FROM course_exposure_event ORDER BY id").all();

    expect(after).toEqual(before);

    expect(
      () => db.prepare("UPDATE course_exposure_event SET event_type = 'declared_seen'").run(),
      "曝光表仍必须只追加",
    ).toThrow(/只追加/);
    expect(
      () => db.prepare("DELETE FROM course_exposure_event").run(),
      "曝光表仍必须只追加",
    ).toThrow(/只追加/);
  });

  it("20b · 投影是**派生**的：没有新增任何表或列", () => {
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    // 不得出现任何「新鲜度 / 污染度」缓存表。
    for (const forbidden of ["paper_freshness", "mock_freshness", "exposure_projection"]) {
      expect(tables, `不应存在派生缓存表 ${forbidden}`).not.toContain(forbidden);
    }
    // 试卷索引表不得多出新鲜度列。
    const paperColumns = (
      db.prepare("PRAGMA table_info(exam_paper)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const forbidden of ["freshness", "freshness_state", "exposed", "pristine"]) {
      expect(paperColumns, `exam_paper 不应含 ${forbidden} 列`).not.toContain(forbidden);
    }
  });
});

// ===========================================================================
// 事件种类登记表 —— 「哪些算见过」必须被明确决定
// ===========================================================================

describe("新鲜度 · 曝光事件种类登记表", () => {
  it("登记表完整：每一种已登记事件都有明确判断与依据", () => {
    expect(findExposureRegistryGaps()).toEqual([]);
  });

  it("每一种登记事件的两个判断都是显式布尔值（不是靠数组遗漏来决定）", () => {
    for (const eventType of COURSE_EXPOSURE_EVENT_TYPES) {
      const basis = COURSE_EXPOSURE_SEEN_BASIS[eventType];
      expect(basis, `${eventType} 缺少登记`).toBeDefined();
      expect(typeof basis.establishesSeenContent).toBe("boolean");
      expect(typeof basis.establishesPotentialContact).toBe("boolean");
      expect(basis.rationale.trim().length, `${eventType} 缺少依据说明`).toBeGreaterThan(10);
    }
  });

  it("参与判定的两个集合都由登记表**推导**，不是另写一份", () => {
    const derivedSeen = COURSE_EXPOSURE_EVENT_TYPES.filter(
      (eventType) => COURSE_EXPOSURE_SEEN_BASIS[eventType].establishesSeenContent,
    );
    expect(EXPOSURE_TYPES_ESTABLISHING_SEEN_CONTENT).toEqual(derivedSeen);

    const derivedPotential = COURSE_EXPOSURE_EVENT_TYPES.filter(
      (eventType) => COURSE_EXPOSURE_SEEN_BASIS[eventType].establishesPotentialContact,
    );
    expect(EXPOSURE_TYPES_ESTABLISHING_POTENTIAL_CONTACT).toEqual(derivedPotential);

    /*
     * 潜在接触集合必须是已确认集合的**超集**。
     *
     * 若某个事件"算已确认看过"却"不算潜在接触"，那条路径就会漏掉
     * 潜在接触判定 —— 而已证明接触当然蕴含可能接触。
     */
    for (const eventType of EXPOSURE_TYPES_ESTABLISHING_SEEN_CONTENT) {
      expect(
        EXPOSURE_TYPES_ESTABLISHING_POTENTIAL_CONTACT,
        `${eventType} 算已确认接触就必须也算潜在接触`,
      ).toContain(eventType);
    }
  });

  it("**只有** reveal_requested ⇒ uncertain（潜在接触），绝不是 pristine 也不是 exposed", () => {
    /*
     * P0-5 的核心行为判据。
     *
     * 揭示请求只说明"学习者要求看"，不证明他读到了。因此：
     * - 不是 `exposed`（那需要已证明接触）；
     * - 更不是 `pristine`（请求本身就是反向证据）；
     * - 只能是 `uncertain`（无法证明仍未见）。
     */
    importBothPapers();
    importCourse();

    recordExposure({ eventType: "reveal_requested" });
    expect(link().ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state, "只请求过揭示必须是 uncertain").toBe("uncertain");
    expect(freshness.matches, "潜在接触不得产生正面证据").toEqual([]);
    expect(freshness.unresolved.map((item) => item.code)).toContain("potential_contact_only");
    // 而它仍然不满足严格未见模考资格（失败关闭）。
    expect(domainIsEligible(freshness), "潜在接触不得被当成严格未见模考").toBe(false);
  });

  it("**混合事件**：reveal_requested + content_rendered ⇒ exposed（已确认压过潜在）", () => {
    importBothPapers();
    importCourse();

    recordExposure({ eventType: "reveal_requested", occurredAt: "2026-02-01T10:00:00.000Z" });
    recordExposure({ eventType: "content_rendered", occurredAt: "2026-02-02T10:00:00.000Z" });
    expect(link().ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state, "有已确认看过 ⇒ exposed").toBe("exposed");
    expect(freshness.matches).toHaveLength(1);
    /*
     * 正面证据只列**已确认**事件。
     *
     * 这是有意的：`exposed` 的含义是"已证明接触"，而 `reveal_requested`
     * 不构成证明。把它列进证据会让证据看起来比实际更强。
     */
    expect(freshness.matches[0].eventTypes).toEqual(["content_rendered"]);
  });

  it("**版本漂移**：揭示落在 v1、链接核验在 v2 ⇒ uncertain", () => {
    importBothPapers();
    importCourse();

    recordExposure({ eventType: "reveal_requested", occurredAt: "2026-02-01T10:00:00.000Z" });

    // 课程升到 v2，然后在 v2 上核验链接。
    importCourse(
      buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }),
    );
    expect(
      verifyCanonicalLink(repos, {
        courseId: COURSE_ID,
        courseContentVersion: 2,
        segmentId: SEGMENT_ID,
        paperId: PAPER_A,
        paperContentVersion: 1,
        sectionId: SECTION,
        targetScope: "section",
        verificationStatus: "verified",
        verificationRef: "版本漂移用例",
      }).ok,
    ).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state, "版本漂移必须失败关闭").toBe("uncertain");
    expect(freshness.unresolved.map((item) => item.code)).toContain("exposure_version_mismatch");
  });

  it("**迟核验**：先揭示、后核验，历史揭示仍参与判定（回退约束）", () => {
    importBothPapers();
    importCourse();

    // 揭示时该段还没有任何链接。
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toEqual([]);
    recordExposure({ eventType: "reveal_requested", occurredAt: "2026-02-01T10:00:00.000Z" });
    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("pristine");

    // 两周后才核验出对应关系。
    expect(link().ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state, "迟核验必须让旧揭示参与判定").toBe("uncertain");
  });

  it("**回退兼容**：直接写库的 reveal_requested 行同样参与判定", () => {
    /*
     * 这一条守护"UI 被撤回"那条路径：将来若 Companion 界面不存在了，
     * 直接落在库里的 `reveal_requested` 行仍必须被投影逻辑读到。
     */
    importBothPapers();
    importCourse();

    repos.courses.appendExposure({
      profileId: PROFILE_A,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      eventType: "reveal_requested",
      occurredAt: "2026-02-01T10:00:00.000Z",
    });
    expect(link().ok).toBe(true);

    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("uncertain");
  });

  it("**其它 profile** 的揭示不影响本 profile 的结论", () => {
    /*
     * PROFILE_A / PROFILE_B 由全局 beforeEach 一并 seed，因此这里**不**
     * 再 seed 一次 —— 重复插入同 id 会触发主键冲突（实测踩到）。
     */
    importBothPapers();
    importCourse();

    recordExposure({ profileId: PROFILE_B, eventType: "reveal_requested" });
    expect(link().ok).toBe(true);

    expect(getPaperFreshness(repos, PROFILE_A, PAPER_A).state).toBe("pristine");
    expect(getPaperFreshness(repos, PROFILE_B, PAPER_A).state).toBe("uncertain");
  });

  it("潜在接触**不得**因重复揭示而放大（一次与五次同一结论）", () => {
    importBothPapers();
    importCourse();

    for (let index = 0; index < 5; index += 1) {
      recordExposure({
        eventType: "reveal_requested",
        occurredAt: `2026-02-0${index + 1}T10:00:00.000Z`,
      });
    }
    expect(link().ok).toBe(true);

    const freshness = getPaperFreshness(repos, PROFILE_A, PAPER_A);
    expect(freshness.state).toBe("uncertain");
    expect(freshness.matches).toEqual([]);
    // 五条潜在接触折叠成一个未解决条件（不重复膨胀）。
    expect(freshness.unresolved.filter((item) => item.code === "potential_contact_only")).toHaveLength(1);
  });

  it("每个判定都是**二值**的：不存在权重 / 严重度 / 污染分数", () => {
    /*
     * 上一版这里断言"只有两个字段"。现在登记项有三个字段（两个判定 + 依据），
     * 但**二值**这条纪律不变：每个判定仍然只有 true/false，
     * 没有任何权重、严重度或分数。
     */
    for (const eventType of COURSE_EXPOSURE_EVENT_TYPES) {
      const keys = Object.keys(COURSE_EXPOSURE_SEEN_BASIS[eventType]).sort();
      expect(keys, `${eventType} 的登记不应有额外字段`).toEqual([
        "establishesPotentialContact",
        "establishesSeenContent",
        "rationale",
      ]);

      const basis = COURSE_EXPOSURE_SEEN_BASIS[eventType];
      // 两个判定都必须是布尔（二值），不得出现数字权重。
      expect(typeof basis.establishesSeenContent, `${eventType} 的已确认判定必须是布尔`).toBe("boolean");
      expect(typeof basis.establishesPotentialContact, `${eventType} 的潜在判定必须是布尔`).toBe("boolean");
      expect(basis.rationale.trim().length, `${eventType} 必须写明判断依据`).toBeGreaterThan(10);
    }
  });

  it("未登记的事件种类两个判定都为**不参与**（保守：不凭空算作见过）", () => {
    expect(establishesSeenContent("brand_new_event" as never)).toBe(false);
    expect(establishesPotentialContact("brand_new_event" as never)).toBe(false);
  });

  it("`reveal_requested` 是潜在接触，其余四种是已确认接触", () => {
    /*
     * 这是 P0-5 的登记表级判据。
     *
     * 揭示只记录"学习者要求看"，它不证明正文被送达或被读 ——
     * 因此它不能进入 `exposed`（已证明接触），只能进入 `uncertain`。
     */
    for (const eventType of COURSE_EXPOSURE_EVENT_TYPES) {
      const basis = COURSE_EXPOSURE_SEEN_BASIS[eventType];
      if (eventType === "reveal_requested") {
        expect(basis.establishesSeenContent, "reveal_requested 不得算作已确认接触").toBe(false);
        expect(basis.establishesPotentialContact, "reveal_requested 必须算作潜在接触").toBe(true);
        continue;
      }
      expect(basis.establishesSeenContent, `${eventType} 应算作已确认接触`).toBe(true);
      // 已确认蕴含潜在：否则"已证明接触"反而漏掉潜在接触判定。
      expect(basis.establishesPotentialContact, `${eventType} 应同时算作潜在接触`).toBe(true);
    }
  });
});

// ===========================================================================
// domain 纯函数层：状态判定与失败关闭
// ===========================================================================

describe("新鲜度 · domain 状态模型（纯函数）", () => {
  function match(overrides: Partial<PaperExposureMatch> = {}): PaperExposureMatch {
    return {
      paperId: PAPER_A,
      paperContentVersion: 1,
      sectionId: SECTION,
      groupId: null,
      questionId: null,
      targetScope: "section",
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      linkId: "link-a",
      verificationRef: "ref",
      firstExposedAt: "2026-02-01T00:00:00.000Z",
      lastExposedAt: "2026-02-01T00:00:00.000Z",
      exposureCount: 1,
      eventTypes: ["content_rendered"],
      ...overrides,
    };
  }

  it("无证据、无未解决 ⇒ pristine，且合格", () => {
    const freshness = decidePaperFreshness({ paperId: PAPER_A, matches: [], unresolved: [] });
    expect(freshness.state).toBe("pristine");
    expect(domainIsEligible(freshness)).toBe(true);
  });

  it("有证据 ⇒ exposed，且不合格", () => {
    const freshness = decidePaperFreshness({
      paperId: PAPER_A,
      matches: [match()],
      unresolved: [],
    });
    expect(freshness.state).toBe("exposed");
    expect(domainIsEligible(freshness)).toBe(false);
  });

  it("**关键**：只有未解决条件、没有证据 ⇒ uncertain，**不是** pristine", () => {
    const freshness = decidePaperFreshness({
      paperId: PAPER_A,
      matches: [],
      unresolved: [{ code: "course_package_drifted", message: "包已漂移" }],
    });
    expect(freshness.state, "不知道 ≠ 没见过").toBe("uncertain");
    expect(domainIsEligible(freshness)).toBe(false);
  });

  it("证据压过不确定性（事实优先于无法证明）", () => {
    const freshness = decidePaperFreshness({
      paperId: PAPER_A,
      matches: [match()],
      unresolved: [{ code: "course_package_drifted", message: "包已漂移" }],
    });
    expect(freshness.state).toBe("exposed");
    // 但未解决条件仍然如实保留（信息不丢）。
    expect(freshness.unresolved).toHaveLength(1);
  });

  it("资格判据只有 pristine 通过（穷举三态）", () => {
    expect(domainIsEligible({ state: "pristine" })).toBe(true);
    expect(domainIsEligible({ state: "exposed" })).toBe(false);
    expect(domainIsEligible({ state: "uncertain" })).toBe(false);
  });

  it("三态都有可读标签，且不含表现性措辞", () => {
    for (const state of ["pristine", "exposed", "uncertain"] as const) {
      expect(PAPER_FRESHNESS_LABELS[state]).toBeTruthy();
    }
    const allText = Object.values(PAPER_FRESHNESS_LABELS).join(" ");
    for (const forbidden of ["掌握", "得分", "正确率", "弱项", "污染"]) {
      expect(allText, `标签不得含「${forbidden}」`).not.toContain(forbidden);
    }
  });

  it("原因文案对三态都给出可读说明，且不合格原因含「不再适合 / 暂不」", () => {
    const exposed = decidePaperFreshness({ paperId: PAPER_A, matches: [match()], unresolved: [] });
    const uncertain = decidePaperFreshness({
      paperId: PAPER_A,
      matches: [],
      unresolved: [{ code: "paper_package_drifted", message: "真题包已漂移" }],
    });
    const pristine = decidePaperFreshness({ paperId: PAPER_A, matches: [], unresolved: [] });

    expect(explainPaperFreshness(exposed)).toContain("不再是新的");
    expect(explainPaperFreshness(uncertain)).toContain("无法证明");
    expect(explainPaperFreshness(pristine)).toContain("尚未接触");
    expect(explainStrictMockIneligibility(exposed)).toContain("不再适合");
    expect(explainStrictMockIneligibility(uncertain)).toContain("暂不作为");
    expect(explainStrictMockIneligibility(pristine)).toContain("满足");
  });

  it("目标描述按粒度变化（大题 / 题组 / 题）", () => {
    expect(describeFreshnessTarget(match({ targetScope: "section" }))).toContain("整个大题");
    expect(
      describeFreshnessTarget(match({ targetScope: "group", groupId: "reading.careful_reading#g1" })),
    ).toContain("组");
    expect(
      describeFreshnessTarget(
        match({ targetScope: "question", groupId: "reading.careful_reading#g1", questionId: "q26" }),
      ),
    ).toContain("第 q26 题");
  });

  it("同样目标的多条证据合并：时刻取极值、种类升序去重、**计数不膨胀**", () => {
    /*
     * ── 计数为什么必须取 max 而不是求和 ──
     *
     * `exposureMatchKey` 把 (课程, 段, 课程版本, 目标) 全部纳入身份，因此同一个
     * key 下的每条证据都由**完全相同的那一组曝光事件**构造 —— 计数本来就相等。
     *
     * 求和会引出一个具体错误：同一组映射被人工独立复核两次（两行不可变复核记录，
     * 这是允许且预期的）时，计数会变成曝光次数的两倍 —— 于是"复核了几次"
     * 伪装成"学习者多看了几次"，把审计元数据当成了学习者行为。
     */
    const freshness = decidePaperFreshness({
      paperId: PAPER_A,
      matches: [
        match({
          firstExposedAt: "2026-02-03T00:00:00.000Z",
          lastExposedAt: "2026-02-03T00:00:00.000Z",
          eventTypes: ["declared_seen"],
          exposureCount: 2,
          linkId: "link-b",
        }),
        match({
          firstExposedAt: "2026-02-01T00:00:00.000Z",
          lastExposedAt: "2026-02-01T00:00:00.000Z",
          exposureCount: 2,
          linkId: "link-a",
        }),
      ],
      unresolved: [],
    });

    // 同一语义目标 ⇒ 一条证据（不是两条）。
    expect(freshness.matches).toHaveLength(1);
    // 两次复核**没有**把计数翻倍：它仍然是"看过 2 次"。
    expect(freshness.matches[0].exposureCount).toBe(2);
    // 时刻取极值（跨越两条行）。
    expect(freshness.matches[0].firstExposedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(freshness.matches[0].lastExposedAt).toBe("2026-02-03T00:00:00.000Z");
    // 事件种类升序去重。
    expect(freshness.matches[0].eventTypes).toEqual(["content_rendered", "declared_seen"]);
    // 代表行确定性选取：id 字典序最小者。
    expect(freshness.matches[0].linkId).toBe("link-a");
  });

  it("整库索引只登记**有结论**的试卷", () => {
    importBothPapers();
    importCourse();
    recordExposure();
    expect(link().ok).toBe(true);

    const index = getPaperFreshnessIndex(repos, PROFILE_A);
    expect(index.notable.map((item) => item.paperId)).toEqual([PAPER_A]);
    expect(index.courseLayerActivated).toBe(true);
    expect(index.exposureEventCount).toBe(1);
    // 未登记的试卷按需返回 pristine，而不是 undefined。
    expect(index.get(PAPER_B).state).toBe("pristine");
  });

  it("课程层未激活（v8 形态）⇒ 全部 pristine，且如实报告未激活", () => {
    /*
     * 用一个**不含课程层表**的库模拟 v8：直接删掉那三张表。
     * 这是真实可能的状态（尚未 course:import --commit 的库），
     * 而「读不到」必须表现为「课程层未激活」，不是崩溃、也不是假装有曝光。
     */
    for (const table of ["course_exposure_event", "course_canonical_link", "course_package"]) {
      db.prepare(`DROP TABLE IF EXISTS ${table}`).run();
    }

    const index = getPaperFreshnessIndex(repos, PROFILE_A);
    expect(index.courseLayerActivated).toBe(false);
    expect(index.exposureEventCount).toBe(0);
    expect(index.notable).toEqual([]);
    expect(index.get(PAPER_A).state).toBe("pristine");
  });

  it("空库（没有任何课程层行）⇒ 索引为空但不报错", () => {
    const index = getPaperFreshnessIndex(repos, PROFILE_A);
    expect(index.notable).toEqual([]);
    expect(index.exposureEventCount).toBe(0);
    expect(index.get("nonexistent-paper").state).toBe("pristine");
  });
});

// ===========================================================================
// 库级汇总
// ===========================================================================

describe("新鲜度 · 库级汇总只统计保留卷", () => {
  it("训练池试卷被接触**不**计入「需要处理」的计数", () => {
    importBothPapers();
    importCourse();
    // PAPER_A 训练池、PAPER_B 保留。
    repos.papers.setPool(PAPER_B, "mock_reserve");
    recordExposure();
    expect(link({ paperId: PAPER_A }).ok).toBe(true);

    const summaries = repos.papers
      .listPapers()
      .map((record) => ({ id: record.id, pool: record.pool }));
    const summary = summarizePaperFreshness(getPaperFreshnessIndex(repos, PROFILE_A), summaries);

    // 被接触的是训练池那份 ⇒ 保留卷里的「需要处理」计数为 0。
    expect(summary).toEqual({ pristine: 1, exposed: 0, uncertain: 0 });
  });

  it("保留卷被接触 ⇒ 计入 exposed 计数", () => {
    importBothPapers();
    importCourse();
    repos.papers.setPool(PAPER_A, "mock_reserve");
    recordExposure();
    expect(link({ paperId: PAPER_A }).ok).toBe(true);

    const summaries = repos.papers
      .listPapers()
      .map((record) => ({ id: record.id, pool: record.pool }));
    const summary = summarizePaperFreshness(getPaperFreshnessIndex(repos, PROFILE_A), summaries);

    expect(summary.exposed).toBe(1);
    // PAPER_B 是训练池，不计入任何一档。
    expect(summary.pristine + summary.exposed + summary.uncertain).toBe(1);
  });

  it("列表页与详情页拿到**同一个**结论（口径单一来源）", () => {
    importBothPapers();
    importCourse();
    repos.papers.setPool(PAPER_A, "mock_reserve");
    recordExposure();
    expect(link().ok).toBe(true);

    const library = getPaperLibrary(repos, PROFILE_A);
    const fromLibrary = library.freshness!.get(PAPER_A);
    const fromDetail = getPaperDetailView(repos, PAPER_A, PROFILE_A)!.freshness!;

    expect(JSON.stringify(fromDetail)).toBe(JSON.stringify(fromLibrary));
  });
});
