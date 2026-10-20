import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { commitCourseImport, planCourseImport } from "@/services/course-import";
import { planImport, commitImport } from "@/services/paper-import";
import {
  verifyCanonicalLink,
  listLinksForSegmentWithUsability,
  listRuntimeLinksForSegment,
  getCourseLinkOverview,
} from "@/services/course-link";
import { isLinkRuntimeUsable } from "@/domain/course";
import type { Repositories } from "@/repositories/ports";
import { buildCourseFixture, writeCourseFixture } from "../scripts/course-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

/**
 * canonical 链接的核验、失败关闭与失效（staleness）测试。
 *
 * 核心命题：**链接的价值来自人工复核**，因此系统必须
 * (a) 拒绝一切结构不成立的链接；
 * (b) 在课程或真题升版后**立即**让它不可用，绝不自动沿用旧复核。
 *
 * 夹具全部合成：课程来自 `scripts/course-fixture.ts`（provider 写死为
 * `test_fixture_provider`），试卷来自 `scripts/paper-fixture.ts`
 * （`sourceKind` 写死为 `test_fixture`）。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

/** 已导入的试卷夹具的固定身份（见 scripts/paper-fixture.ts 的默认值）。 */
const PAPER_ID = "fixture-cet6-2024-12-v1";
const COURSE_ID = "fixture-course-a";

function writeCourse(dirName: string, fixture = buildCourseFixture()): string {
  return writeCourseFixture(contentRoot, dirName, fixture);
}

function importCourse(): void {
  writeCourse(COURSE_ID);
  const result = commitCourseImport(repos, planCourseImport(repos));
  expect(result.ok, `课程导入失败：${result.error}`).toBe(true);
  expect(result.written).toBe(1);
}

/** 把试卷夹具**真正导入索引**（只写盘是不够的 —— 链接核验读的是索引）。 */
function importPaper(contentVersion = 1): void {
  writeFixturePackage(contentRoot, "fixture-paper", buildFixturePackage({ contentVersion }));
  const paperPlan = planImport(repos, { only: ["fixture-paper"] });
  expect(paperPlan.report.counts.insert, "夹具前提：这份试卷应当是新导入").toBe(1);
  expect(commitImport(repos, paperPlan).ok).toBe(true);
  expect(repos.papers.getPaper(PAPER_ID)).not.toBeNull();
}

/** 把试卷升到新版本（内容变化 ⇒ 必须涨版本，由试卷导入器自身的规则保证）。 */
function importPaperUpgrade(contentVersion: number): void {
  writeFixturePackage(contentRoot, "fixture-paper", buildFixturePackage({ contentVersion }));
  const paperPlan = planImport(repos, { only: ["fixture-paper"] });
  expect(paperPlan.report.counts.update).toBe(1);
  expect(commitImport(repos, paperPlan).ok).toBe(true);
}

/** 一次合法的 section 粒度核验声明。 */
function sectionLink(overrides: Record<string, unknown> = {}) {
  return {
    courseId: COURSE_ID,
    courseContentVersion: 1,
    segmentId: "reading.a",
    paperId: PAPER_ID,
    paperContentVersion: 1,
    sectionId: "reading.careful_reading",
    targetScope: "section" as const,
    verificationStatus: "verified" as const,
    verificationRef: "人工核验：夹具复核记录 #1",
    ...overrides,
  };
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-courselink-"));
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);
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

describe("canonical 链接：结构成立的目标被接受", () => {
  it("section 粒度的链接可以建立，并记录两个内容版本", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(repos, sectionLink());
    expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
    if (!result.ok) return;

    expect(result.created).toBe(true);
    expect(result.link.courseId).toBe(COURSE_ID);
    expect(result.link.segmentId).toBe("reading.a");
    // **两个版本都必须被记下** —— 少了任何一个，失效判定都无从谈起
    expect(result.link.courseContentVersion).toBe(1);
    expect(result.link.paperContentVersion).toBe(1);
    expect(result.link.sectionId).toBe("reading.careful_reading");
    expect(result.link.targetScope).toBe("section");
    expect(result.link.verificationStatus).toBe("verified");
    expect(result.link.verificationRef).toContain("人工核验");
  });

  it("question 粒度：section + group + question 都存在时被接受", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(
      repos,
      sectionLink({
        targetScope: "question",
        sectionId: "reading.careful_reading",
        groupId: "reading.careful_reading#g1",
        questionId: "q46",
      }),
    );
    expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
    if (!result.ok) return;
    expect(result.link.targetScope).toBe("question");
    expect(result.link.groupId).toBe("reading.careful_reading#g1");
    expect(result.link.questionId).toBe("q46");
  });

  it("group 粒度：只声明到大题内的题组", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(
      repos,
      sectionLink({
        targetScope: "group",
        sectionId: "reading.careful_reading",
        groupId: "reading.careful_reading#g2",
      }),
    );
    expect(result.ok, result.ok ? "" : JSON.stringify(result.issues)).toBe(true);
    if (!result.ok) return;
    expect(result.link.groupId).toBe("reading.careful_reading#g2");
    expect(result.link.questionId).toBeNull();
  });

  it("未匹配的段不影响其它段建立链接（逐段独立）", () => {
    importPaper();
    importCourse();

    // 只给 reading.a 建链接；其它五个段保持未匹配
    const result = verifyCanonicalLink(repos, sectionLink());
    expect(result.ok).toBe(true);

    const overview = getCourseLinkOverview(repos, COURSE_ID);
    expect(overview.totalSegments).toBe(6);
    expect(overview.matchedSegmentIds).toEqual(["reading.a"]);
    // 未匹配是合法状态，不是失败
    expect(overview.staleVerified).toBe(0);
  });
});

describe("canonical 链接：失败关闭（fail closed）", () => {
  it("课程包不存在时拒绝", () => {
    importPaper();
    const result = verifyCanonicalLink(repos, sectionLink());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "courseId")).toBe(true);
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toEqual([]);
  });

  it("目标真题卷不存在时拒绝", () => {
    importCourse();
    const result = verifyCanonicalLink(repos, sectionLink({ paperId: "no-such-paper" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "paperId")).toBe(true);
  });

  it("**错误的课程内容版本**被拒绝", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(repos, sectionLink({ courseContentVersion: 99 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "courseContentVersion")).toBe(true);
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toEqual([]);
  });

  it("**错误的真题内容版本**被拒绝（不允许静默升级）", () => {
    importPaper(1);
    importCourse();

    const result = verifyCanonicalLink(repos, sectionLink({ paperContentVersion: 2 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "paperContentVersion")).toBe(true);
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toEqual([]);
  });

  it("**不存在的 segment** 被拒绝", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(repos, sectionLink({ segmentId: "no-such-segment" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "segmentId")).toBe(true);
  });

  it("**不存在的大题**被拒绝，并列出该包实际有哪些大题", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(repos, sectionLink({ sectionId: "reading.nonexistent" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "sectionId")).toBe(true);
    // 错误信息必须可定位（列出可用项），否则复核者只能猜
    expect(result.issues.some((issue) => issue.message.includes("该包有"))).toBe(true);
  });

  it("**不存在的题组**被拒绝", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(
      repos,
      sectionLink({
        targetScope: "group",
        sectionId: "reading.careful_reading",
        groupId: "reading.careful_reading#g99",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "groupId")).toBe(true);
  });

  it("**不存在的题目**被拒绝", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(
      repos,
      sectionLink({
        targetScope: "question",
        sectionId: "reading.careful_reading",
        groupId: "reading.careful_reading#g1",
        questionId: "q_not_there",
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "questionId")).toBe(true);
  });
});

describe("canonical 链接：目标粒度必须结构成立", () => {
  it("section 粒度不得携带 group / question", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(
      repos,
      sectionLink({ targetScope: "section", groupId: "reading.careful_reading#g1" }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.message.includes("不得同时声明"))).toBe(true);
  });

  it("group 粒度不得携带 question", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(
      repos,
      sectionLink({
        targetScope: "group",
        sectionId: "reading.careful_reading",
        groupId: "reading.careful_reading#g1",
        questionId: "q26",
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("question 粒度缺少 questionId 时被拒绝", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(
      repos,
      sectionLink({
        targetScope: "question",
        sectionId: "reading.careful_reading",
        groupId: "reading.careful_reading#g1",
      }),
    );
    expect(result.ok).toBe(false);
  });

  it("未登记的目标粒度被拒绝", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(repos, sectionLink({ targetScope: "paper" as never }));
    expect(result.ok).toBe(false);
  });
});

describe("canonical 链接：核验出处与状态", () => {
  it("**verified 必须有核验引用**（没有出处的已核验与机器候选无异）", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(repos, sectionLink({ verificationRef: "   " }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "verificationRef")).toBe(true);
  });

  it("candidate 可以没有核验引用（它是机器候选，不是复核结论）", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(
      repos,
      sectionLink({ verificationStatus: "candidate", verificationRef: "" }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.link.verificationStatus).toBe("candidate");
  });

  it("**candidate / rejected 绝不进入运行时链接**（但保留在库里作为审计线索）", () => {
    importPaper();
    importCourse();

    const candidate = verifyCanonicalLink(
      repos,
      sectionLink({
        verificationStatus: "candidate",
        verificationRef: "",
        note: "机器候选：待人工复核",
      }),
    );
    expect(candidate.ok).toBe(true);

    const rejected = verifyCanonicalLink(
      repos,
      sectionLink({ verificationStatus: "rejected", verificationRef: "人工否决：材料不对应" }),
    );
    expect(rejected.ok).toBe(true);

    // 两条都在库里（审计线索不丢）
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(2);
    // 但运行时链接为空 —— 判据收敛在 isLinkRuntimeUsable 一处
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toEqual([]);

    // 逐条原因可读
    const views = listLinksForSegmentWithUsability(repos, COURSE_ID, "reading.a");
    expect(views).toHaveLength(2);
    for (const view of views) {
      expect(view.runtimeUsable).toBe(false);
      expect(view.unusableReason).toBeTruthy();
    }
  });

  it("未登记的核验状态被拒绝", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(
      repos,
      sectionLink({ verificationStatus: "probably_fine" as never }),
    );
    expect(result.ok).toBe(false);
  });
});

describe("canonical 链接：幂等", () => {
  it("同一份核验声明重复写入**不产生第二条**", () => {
    importPaper();
    importCourse();

    const first = verifyCanonicalLink(repos, sectionLink());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);

    const second = verifyCanonicalLink(repos, sectionLink());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.link.id).toBe(first.link.id);
    expect(second.warnings.some((warning) => warning.includes("幂等"))).toBe(true);

    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(1);
  });

  it("链接 id 由声明确定性推导（同输入同 id，与时间无关）", () => {
    importPaper();
    importCourse();
    const first = verifyCanonicalLink(repos, sectionLink());
    const second = verifyCanonicalLink(repos, sectionLink());
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.link.id).toBe(second.link.id);
    expect(first.link.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("**候选**与**已核验**是两条独立的行（状态变化不销毁审计线索）", () => {
    importPaper();
    importCourse();

    const candidate = verifyCanonicalLink(
      repos,
      sectionLink({ verificationStatus: "candidate", verificationRef: "" }),
    );
    const verified = verifyCanonicalLink(repos, sectionLink());
    expect(candidate.ok && verified.ok).toBe(true);
    if (!candidate.ok || !verified.ok) return;

    expect(candidate.link.id).not.toBe(verified.link.id);
    const all = repos.courses.listLinksForCourse(COURSE_ID);
    expect(all).toHaveLength(2);
    expect(all.map((link) => link.verificationStatus).sort()).toEqual(["candidate", "verified"]);
    // 只有 verified 那条进入运行时
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toHaveLength(1);
  });

  it("不同目标（不同大题）是两条独立的链接", () => {
    importPaper();
    importCourse();

    const a = verifyCanonicalLink(repos, sectionLink({ sectionId: "reading.banked_cloze" }));
    const b = verifyCanonicalLink(repos, sectionLink({ sectionId: "reading.matching" }));
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.link.id).not.toBe(b.link.id);
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(2);
  });
});

describe("canonical 链接：dry-run 不写库", () => {
  it("dryRun 时全部校验通过但**一行都不写**", () => {
    importPaper();
    importCourse();

    const result = verifyCanonicalLink(repos, { ...sectionLink(), dryRun: true });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.dryRun).toBe(true);
    expect(result.created).toBe(false);

    // 关键断言：库里没有任何链接
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toEqual([]);
  });

  it("dry-run 与真实写入使用**同一段判据**：非法声明在两种模式下都被拒绝", () => {
    importPaper();
    importCourse();

    const bad = sectionLink({ sectionId: "not-a-section" });
    const dry = verifyCanonicalLink(repos, { ...bad, dryRun: true });
    const real = verifyCanonicalLink(repos, bad);
    expect(dry.ok).toBe(false);
    expect(real.ok).toBe(false);
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toEqual([]);
  });
});

describe("canonical 链接：课程升版后失效（staleness）", () => {
  it("课程内容升版后，旧链接**立即不可用**，且不自动沿用", () => {
    importPaper();
    importCourse();

    const created = verifyCanonicalLink(repos, sectionLink());
    expect(created.ok).toBe(true);
    // 升版前可用
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toHaveLength(1);

    // 课程升到 v2（内容真的变了，因此必须涨版本）
    writeCourse(
      COURSE_ID,
      buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }),
    );
    const plan = planCourseImport(repos);
    expect(plan.report.counts.update).toBe(1);
    expect(commitCourseImport(repos, plan).ok).toBe(true);
    expect(repos.courses.getPackage(COURSE_ID)!.contentVersion).toBe(2);

    // **运行时链接变为空** —— 这是本层的核心保证
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toEqual([]);

    // 但历史链接行仍在（不销毁历史），并且原因可读
    const views = listLinksForSegmentWithUsability(repos, COURSE_ID, "reading.a");
    expect(views).toHaveLength(1);
    expect(views[0].runtimeUsable).toBe(false);
    expect(views[0].unusableReason).toContain("课程内容已升版");
    expect(views[0].unusableReason).toContain("不会自动沿用旧复核");
    expect(views[0].link.courseContentVersion).toBe(1);
  });

  it("升版后必须**重新核验**才能建立新链接（旧行不被改写）", () => {
    importPaper();
    importCourse();
    expect(verifyCanonicalLink(repos, sectionLink()).ok).toBe(true);

    writeCourse(
      COURSE_ID,
      buildCourseFixture({ contentVersion: 2, readingText: "A genuinely different v2 body." }),
    );
    commitCourseImport(repos, planCourseImport(repos));

    // 旧版本声明现在会被拒绝（链接只能绑定当前版本）
    const staleAttempt = verifyCanonicalLink(repos, sectionLink());
    expect(staleAttempt.ok).toBe(false);

    // 对新版本重新核验 ⇒ 新链接，旧链接原样保留
    const reverified = verifyCanonicalLink(repos, sectionLink({ courseContentVersion: 2 }));
    expect(reverified.ok, reverified.ok ? "" : JSON.stringify(reverified.issues)).toBe(true);
    if (!reverified.ok) return;
    expect(reverified.link.courseContentVersion).toBe(2);
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toHaveLength(1);

    // 两行都在：旧的是历史记录，新的是当前复核
    const all = repos.courses.listLinksForCourse(COURSE_ID);
    expect(all).toHaveLength(2);
    expect(all.map((link) => link.courseContentVersion).sort()).toEqual([1, 2]);

    // 概览如实区分可用与已失效
    const overview = getCourseLinkOverview(repos, COURSE_ID);
    expect(overview.verifiedUsable).toBe(1);
    expect(overview.staleVerified).toBe(1);
  });

  it("**元数据变更（只改 rightsNote）不会让链接失效**", () => {
    importPaper();
    importCourse();
    expect(verifyCanonicalLink(repos, sectionLink()).ok).toBe(true);

    writeCourse(COURSE_ID, buildCourseFixture({ rightsNote: "更新后的权利说明。" }));
    const plan = planCourseImport(repos);
    expect(plan.report.counts.metadataOnly).toBe(1);
    commitCourseImport(repos, plan);

    // 内容版本未变 ⇒ 链接仍然可用。这正是"元数据不涨版本"要保护的东西。
    expect(repos.courses.getPackage(COURSE_ID)!.contentVersion).toBe(1);
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toHaveLength(1);
  });
});

describe("canonical 链接：真题升版后失效（staleness）", () => {
  it("真题内容升版后，旧链接**立即不可用**，绝不静默套用到新版本", () => {
    importPaper(1);
    importCourse();

    const created = verifyCanonicalLink(repos, sectionLink());
    expect(created.ok).toBe(true);
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toHaveLength(1);

    // 把真题导入为 v2（内容变化必须涨版本 —— 由试卷导入器自己的规则保证）
    importPaperUpgrade(2);
    expect(repos.papers.getPaper(PAPER_ID)!.contentVersion).toBe(2);

    // **运行时链接变为空**
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toEqual([]);

    const views = listLinksForSegmentWithUsability(repos, COURSE_ID, "reading.a");
    expect(views).toHaveLength(1);
    expect(views[0].runtimeUsable).toBe(false);
    expect(views[0].unusableReason).toContain("目标真题内容已升版");
    expect(views[0].unusableReason).toContain("不会自动把旧复核套到新版本上");
    // 链接记录的仍是复核时的那一版
    expect(views[0].link.paperContentVersion).toBe(1);
  });

  it("课程与真题**同时**升版后重新核验才能恢复可用", () => {
    importPaper(1);
    importCourse();
    expect(verifyCanonicalLink(repos, sectionLink()).ok).toBe(true);

    writeCourse(
      COURSE_ID,
      buildCourseFixture({ contentVersion: 2, readingText: "v2 body for the double upgrade." }),
    );
    commitCourseImport(repos, planCourseImport(repos));
    importPaperUpgrade(2);

    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toEqual([]);

    const reverified = verifyCanonicalLink(
      repos,
      sectionLink({ courseContentVersion: 2, paperContentVersion: 2 }),
    );
    expect(reverified.ok, reverified.ok ? "" : JSON.stringify(reverified.issues)).toBe(true);
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, "reading.a")).toHaveLength(1);
  });

  it("纯函数判据：任一版本不匹配即不可用（穷举矩阵）", () => {
    const base = {
      status: "verified" as const,
      courseContentVersion: 1,
      paperContentVersion: 1,
      currentCourseContentVersion: 1,
      currentPaperContentVersion: 1,
    };

    expect(isLinkRuntimeUsable(base)).toBe(true);
    // 课程版本不匹配
    expect(isLinkRuntimeUsable({ ...base, currentCourseContentVersion: 2 })).toBe(false);
    // 真题版本不匹配
    expect(isLinkRuntimeUsable({ ...base, currentPaperContentVersion: 2 })).toBe(false);
    // 包/卷不存在
    expect(isLinkRuntimeUsable({ ...base, currentCourseContentVersion: null })).toBe(false);
    expect(isLinkRuntimeUsable({ ...base, currentPaperContentVersion: null })).toBe(false);
    // 非 verified
    expect(isLinkRuntimeUsable({ ...base, status: "candidate" })).toBe(false);
    expect(isLinkRuntimeUsable({ ...base, status: "rejected" })).toBe(false);
  });
});

describe("canonical 链接：包文件缺失时失败关闭", () => {
  it("课程包文件被删掉后，链接核验被拒绝（不拿索引当真相）", () => {
    importPaper();
    importCourse();

    // 删掉磁盘上的 course.json —— 索引还在，但结构已不可读
    rmSync(join(contentRoot, "courses", COURSE_ID, "course.json"), { force: true });

    const result = verifyCanonicalLink(repos, sectionLink());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "courseId")).toBe(true);
  });

  it("真题包文件被删掉后，链接核验被拒绝", () => {
    importPaper();
    importCourse();

    rmSync(join(contentRoot, "cet6", "papers", "fixture-paper", "paper.json"), { force: true });

    const result = verifyCanonicalLink(repos, sectionLink());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "paperId")).toBe(true);
  });

  it("目标卷从索引消失后，已有链接在运行时不可用，且**复核记录不被销毁**", () => {
    importPaper();
    importCourse();
    expect(verifyCanonicalLink(repos, sectionLink()).ok).toBe(true);

    // 直接删掉试卷索引行（模拟卷子被移除 / 重新整理索引）
    db.exec("DELETE FROM paper_study_state");
    db.exec("DELETE FROM paper_asset");
    db.exec("DELETE FROM exam_paper");
    expect(repos.papers.getPaper(PAPER_ID)).toBeNull();

    // **人工复核记录仍在库里** —— 它不是外键子行，不会被级联删除。
    // 这是「容器状态可以变，历史事实不能改」在课程层的落实：
    // 卷子被移出索引是**索引**的变化，不该抹掉"某年某月某人核验过这条对应关系"。
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(1);

    // 但它不再可用，且原因可读
    const views = listLinksForSegmentWithUsability(repos, COURSE_ID, "reading.a");
    expect(views).toHaveLength(1);
    expect(views[0].runtimeUsable).toBe(false);
    expect(views[0].unusableReason).toContain("目标真题不在索引中");
  });
});

describe("canonical 链接：表结构约束与历史保留", () => {
  it("链接行不会因课程包重新导入而被删除（历史复核记录保留）", () => {
    importPaper();
    importCourse();
    expect(verifyCanonicalLink(repos, sectionLink()).ok).toBe(true);

    // 重复导入（unchanged）后链接仍在
    commitCourseImport(repos, planCourseImport(repos));
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(1);

    // 元数据更新后链接仍在
    writeCourse(COURSE_ID, buildCourseFixture({ provenanceNote: "换了来源说明。" }));
    commitCourseImport(repos, planCourseImport(repos));
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(1);
  });

  it("链接的唯一性由确定性主键承担：同一份声明写入两次只有一行", () => {
    importPaper();
    importCourse();
    verifyCanonicalLink(repos, sectionLink());

    const rows = db.prepare("SELECT COUNT(*) AS c FROM course_canonical_link").get() as { c: number };
    expect(Number(rows.c)).toBe(1);

    // 再写一次同一身份也必须被 ON CONFLICT 挡住
    verifyCanonicalLink(repos, sectionLink());
    const after = db.prepare("SELECT COUNT(*) AS c FROM course_canonical_link").get() as { c: number };
    expect(Number(after.c)).toBe(1);
  });
});
