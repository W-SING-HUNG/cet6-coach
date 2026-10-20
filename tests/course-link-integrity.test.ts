import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import type { Repositories } from "@/repositories/ports";
import { buildCourseFixture, writeCourseFixture } from "../scripts/course-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import { linkIdOf } from "@/repositories/sqlite/courses";
import { nowISO } from "@/lib/date";

/**
 * 包漂移（package drift）的对抗性测试 —— 本次 Review Fix 的 F1 / F4 / F6。
 *
 * ── 这一组要钉死的那条边界 ──
 *
 * 索引记录的是**导入那一刻**的事实。盘上的 `course.json` / `paper.json`
 * 随时可以被改动，而**内容版本号不会自己变**。
 * 因此"版本相等"**不足以**说明"内容还是复核时那一份"：
 *
 *   版本相等只证明"没有人正式升过版"，不证明"包没被改过"。
 *
 * 修复前的实现正是在这里 fail-open：`verifyCanonicalLink` 只 push 一条
 * warning 然后照样写入，而运行时判据只比版本 —— 于是"不改版本号直接改盘"
 * 这条路径可以创造出链接真相，也可以让一条已失真的链接继续"可用"。
 *
 * ── 为什么每个用例都必须用真实临时文件 ──
 *
 * 漂移的定义就是"盘上的字节变了"。用内存夹具或 mock 校验和都测不到它 ——
 * 那只会测到"我们以为自己比较了校验和"。因此下面全部走
 * 真实临时目录 + 真实 DB + 真实服务路径。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

const COURSE_ID = "fixture-course-a";
const PAPER_ID = "fixture-cet6-2024-12-v1";
const SEGMENT_ID = "reading.a";
const SECTION_ID = "reading.careful_reading";

function importCourse(fixture = buildCourseFixture({ id: COURSE_ID })): void {
  writeCourseFixture(contentRoot, COURSE_ID, fixture);
  const result = commitCourseImport(repos, planCourseImport(repos));
  expect(result.ok, `课程导入失败：${result.error}`).toBe(true);
  expect(result.written).toBe(1);
}

function importPaper(contentVersion = 1): void {
  writeFixturePackage(contentRoot, "fixture-paper", buildFixturePackage({ contentVersion }));
  const plan = planImport(repos, { only: ["fixture-paper"] });
  expect(plan.report.counts.insert).toBe(1);
  expect(commitImport(repos, plan).ok).toBe(true);
  expect(repos.papers.getPaper(PAPER_ID)).not.toBeNull();
}

function courseManifestPath(): string {
  return join(contentRoot, "courses", COURSE_ID, "course.json");
}

function paperManifestPath(): string {
  return join(contentRoot, "cet6", "papers", "fixture-paper", "paper.json");
}

/**
 * 把课程 manifest 改掉，**且不递增 contentVersion**。
 *
 * 同时改 contentVersion 会让校验器以"版本冲突"为由拒绝 ——
 * 那条路径早就有测试了。这里要覆盖的是**版本没动**的那条路径。
 */
function driftCourseOnDisk(): void {
  const path = courseManifestPath();
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    contentVersion: number;
    segments: Array<{ id: string; text?: string | null }>;
  };
  const before = manifest.contentVersion;
  manifest.segments[0].text = `DRIFTED WITHOUT VERSION BUMP ${manifest.segments[0].text ?? ""}`;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  // 自检：确保我们改的确实是"内容变了但版本没变"这种形态。
  expect(manifest.contentVersion, "漂移注入不得改变 contentVersion").toBe(before);
}

/** 把真题 manifest 改掉，**且不递增 contentVersion**（改的是 metadata，仍能通过校验器）。 */
function driftPaperOnDisk(): void {
  const path = paperManifestPath();
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    contentVersion: number;
    provenance: { note: string };
  };
  const before = manifest.contentVersion;
  // 改 provenance：包仍然**能通过校验器**（它不是结构错误），
  // 但字节变了 ⇒ manifest 校验和变了。这正是"能解析但已漂移"的形态。
  manifest.provenance.note = `DRIFTED WITHOUT VERSION BUMP ${manifest.provenance.note}`;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  expect(manifest.contentVersion, "漂移注入不得改变 contentVersion").toBe(before);
}

function sectionLink(overrides: Record<string, unknown> = {}) {
  return {
    courseId: COURSE_ID,
    courseContentVersion: 1,
    segmentId: SEGMENT_ID,
    paperId: PAPER_ID,
    paperContentVersion: 1,
    sectionId: SECTION_ID,
    targetScope: "section" as const,
    verificationStatus: "verified" as const,
    verificationRef: "人工核验：漂移测试 #1",
    ...overrides,
  };
}

/** 建立一条合法的 verified 链接，并证明它当前可用。 */
function establishUsableLink(): void {
  const created = verifyCanonicalLink(repos, sectionLink());
  expect(created.ok, created.ok ? "" : JSON.stringify(created.issues)).toBe(true);
  expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toHaveLength(1);
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-drift-"));
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

// ---------------------------------------------------------------------------
// A. 写入时：课程包漂移
// ---------------------------------------------------------------------------

describe("F1-A 写入时课程包漂移：拒绝建立链接", () => {
  it("盘上 course.json 被改动（版本未变）时 verifyCanonicalLink 失败关闭", () => {
    importPaper();
    importCourse();
    driftCourseOnDisk();

    const result = verifyCanonicalLink(repos, sectionLink());

    expect(result.ok, "包已漂移却仍然写入了链接 —— fail-open").toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "courseId")).toBe(true);
    // 错误必须给出可执行的下一步，而不只是"不对"
    expect(result.issues[0].message).toContain("重新导入");
  });

  it("被拒绝时**一行链接都不写**（行数不变）", () => {
    importPaper();
    importCourse();
    driftCourseOnDisk();

    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(0);
    verifyCanonicalLink(repos, sectionLink());
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(0);
    expect(Number((db.prepare("SELECT COUNT(*) AS c FROM course_canonical_link").get() as { c: number }).c)).toBe(0);
  });

  it("重新导入把索引对齐后，同一份声明又能写入（漂移是可恢复的）", () => {
    importPaper();
    importCourse();
    driftCourseOnDisk();
    expect(verifyCanonicalLink(repos, sectionLink()).ok).toBe(false);

    // 把漂移后的内容正式导入（此时内容确实变了，必须递增版本）
    writeCourseFixture(contentRoot, COURSE_ID, buildCourseFixture({ id: COURSE_ID, contentVersion: 2 }));
    const plan = planCourseImport(repos);
    expect(plan.report.counts.update).toBe(1);
    expect(commitCourseImport(repos, plan).ok).toBe(true);

    // 对**新版本**重新核验即可
    const reverified = verifyCanonicalLink(repos, sectionLink({ courseContentVersion: 2 }));
    expect(reverified.ok, reverified.ok ? "" : JSON.stringify(reverified.issues)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// B. 写入时：真题包漂移（F4）
// ---------------------------------------------------------------------------

describe("F4-B 写入时真题包漂移：拒绝建立链接", () => {
  it("盘上 paper.json 被改动（版本未变）时 verifyCanonicalLink 失败关闭", () => {
    importPaper();
    importCourse();
    driftPaperOnDisk();

    const result = verifyCanonicalLink(repos, sectionLink());

    expect(result.ok, "真题包已漂移却仍然写入了链接 —— fail-open（F4）").toBe(false);
    if (result.ok) return;
    expect(result.issues.some((issue) => issue.path === "paperId")).toBe(true);
    expect(result.issues[0].message).toContain("重新导入");
  });

  it("被拒绝时一行链接都不写", () => {
    importPaper();
    importCourse();
    driftPaperOnDisk();

    verifyCanonicalLink(repos, sectionLink());
    expect(Number((db.prepare("SELECT COUNT(*) AS c FROM course_canonical_link").get() as { c: number }).c)).toBe(0);
  });

  it("漂移的是真题而课程完好时，拒绝原因指向真题（不是笼统失败）", () => {
    importPaper();
    importCourse();
    driftPaperOnDisk();

    const result = verifyCanonicalLink(repos, sectionLink());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // 判据必须能区分"哪一侧漂移了"，否则排查要在两份包之间猜
    expect(result.issues.some((issue) => issue.path === "courseId")).toBe(false);
    expect(result.issues.some((issue) => issue.path === "paperId")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// C/D. 运行时：课程 / 真题漂移立即生效
// ---------------------------------------------------------------------------

describe("F1-C 运行时课程包漂移：链接立即不可用", () => {
  it("建立可用链接后改动 course.json ⇒ 运行时列表立即排除它", () => {
    importPaper();
    importCourse();
    establishUsableLink();

    driftCourseOnDisk();

    // **不需要重新导入、不需要升版本**，运行时必须立刻看到漂移。
    expect(
      listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID),
      "课程包已漂移，运行时链接却仍然可用 —— fail-open",
    ).toEqual([]);
  });

  it("视图给出**漂移**这一具体原因（不是泛泛的不可用）", () => {
    importPaper();
    importCourse();
    establishUsableLink();
    driftCourseOnDisk();

    const views = listLinksForSegmentWithUsability(repos, COURSE_ID, SEGMENT_ID);
    expect(views).toHaveLength(1);
    expect(views[0].runtimeUsable).toBe(false);
    expect(views[0].unusableReason).toContain("没有重新导入");
    expect(views[0].unusableReason).toContain("校验和");
  });

  it("历史复核行不被删除 —— 漂移只让运行时不可用，不改写审计历史", () => {
    importPaper();
    importCourse();
    establishUsableLink();
    driftCourseOnDisk();

    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(1);
  });

  it("把漂移内容正式导入后重新核验，运行时可恢复", () => {
    importPaper();
    importCourse();
    establishUsableLink();
    driftCourseOnDisk();
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toEqual([]);

    writeCourseFixture(contentRoot, COURSE_ID, buildCourseFixture({ id: COURSE_ID, contentVersion: 2 }));
    commitCourseImport(repos, planCourseImport(repos));
    expect(verifyCanonicalLink(repos, sectionLink({ courseContentVersion: 2 })).ok).toBe(true);
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toHaveLength(1);
  });
});

describe("F4-D 运行时真题包漂移：链接立即不可用", () => {
  it("建立可用链接后改动 paper.json ⇒ 运行时列表立即排除它", () => {
    importPaper();
    importCourse();
    establishUsableLink();

    driftPaperOnDisk();

    expect(
      listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID),
      "真题包已漂移，运行时链接却仍然可用 —— fail-open（F4）",
    ).toEqual([]);
  });

  it("视图给出**真题包漂移**这一具体原因", () => {
    importPaper();
    importCourse();
    establishUsableLink();
    driftPaperOnDisk();

    const views = listLinksForSegmentWithUsability(repos, COURSE_ID, SEGMENT_ID);
    expect(views).toHaveLength(1);
    expect(views[0].runtimeUsable).toBe(false);
    expect(views[0].unusableReason).toContain("真题包");
    expect(views[0].unusableReason).toContain("没有重新导入");
  });
});

// ---------------------------------------------------------------------------
// E. 运行时：包缺失 / 不可读
// ---------------------------------------------------------------------------

describe("F1-E 运行时包缺失或不可读：链接不可用", () => {
  it("course.json 被删除 ⇒ 不可用（且不是静默当成未变）", () => {
    importPaper();
    importCourse();
    establishUsableLink();

    rmSync(courseManifestPath(), { force: true });

    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toEqual([]);
    const views = listLinksForSegmentWithUsability(repos, COURSE_ID, SEGMENT_ID);
    expect(views[0].runtimeUsable).toBe(false);
    expect(views[0].unusableReason).toContain("课程包不存在");
  });

  it("course.json 变成无法解析的 JSON ⇒ 不可用", () => {
    importPaper();
    importCourse();
    establishUsableLink();

    writeFileSync(courseManifestPath(), "{ this is not json", "utf8");

    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toEqual([]);
  });

  it("paper.json 被删除 ⇒ 不可用", () => {
    importPaper();
    importCourse();
    establishUsableLink();

    rmSync(paperManifestPath(), { force: true });

    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toEqual([]);
    const views = listLinksForSegmentWithUsability(repos, COURSE_ID, SEGMENT_ID);
    expect(views[0].unusableReason).toContain("真题包不存在");
  });

  it("paper.json 变成无法解析的 JSON ⇒ 不可用", () => {
    importPaper();
    importCourse();
    establishUsableLink();

    writeFileSync(paperManifestPath(), "{ nope", "utf8");

    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// F. 结构漂移：绝不只信数据库的计数/版本
// ---------------------------------------------------------------------------

describe("F1-F 结构漂移：不信数据库计数，只认当前包结构", () => {
  /**
   * 把一条**形状完全合法**的链接行直接写进数据库：
   * 版本都对、课程包与真题包都完好、校验和都匹配 ——
   * 唯一的问题是它声明的**题组在当前真题包里并不存在**。
   *
   * 这模拟的是"数据库里有链接真相，但包结构已经不是那样了"。
   * 只比版本/计数的实现在这里会放行；只认结构的实现会拒绝。
   *
   * 用仓储直接写入是刻意的：服务层会拒绝它（这正是我们要的），
   * 因此只能绕过服务层来构造"库里有、包里没有"这个对抗性状态。
   */
  function insertDanglingGroupLink(): void {
    const id = linkIdOf({
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION_ID,
      groupId: "reading.careful_reading#g_does_not_exist",
      questionId: null,
      targetScope: "group",
      verificationStatus: "verified",
      verificationRef: "人工核验：结构漂移测试",
      note: null,
    });

    repos.courses.appendLink({
      id,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION_ID,
      groupId: "reading.careful_reading#g_does_not_exist",
      questionId: null,
      targetScope: "group",
      verificationStatus: "verified",
      verificationRef: "人工核验：结构漂移测试",
      note: null,
      createdAt: nowISO(),
    });
  }

  it("声明的题组在当前真题包里不存在 ⇒ 运行时不可用（版本与校验和都对）", () => {
    importPaper();
    importCourse();
    insertDanglingGroupLink();

    // 前提自检：这条行确实在库里，且版本与校验和都"没问题"
    expect(repos.courses.listLinksForCourse(COURSE_ID)).toHaveLength(1);
    expect(repos.courses.getPackage(COURSE_ID)?.contentVersion).toBe(1);
    expect(repos.papers.getPaper(PAPER_ID)?.contentVersion).toBe(1);

    expect(
      listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID),
      "库里有链接行、版本也匹配，但目标结构不存在 —— 不得当成可用（不许只信数据库）",
    ).toEqual([]);

    const views = listLinksForSegmentWithUsability(repos, COURSE_ID, SEGMENT_ID);
    expect(views[0].runtimeUsable).toBe(false);
    expect(views[0].unusableReason).toContain("已不存在");
  });

  it("声明的**题目**不存在时同样不可用（question 粒度）", () => {
    importPaper();
    importCourse();

    const id = linkIdOf({
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION_ID,
      groupId: `${SECTION_ID}#g1`,
      questionId: "q_not_in_package",
      targetScope: "question",
      verificationStatus: "verified",
      verificationRef: "人工核验：结构漂移测试",
      note: null,
    });
    repos.courses.appendLink({
      id,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION_ID,
      groupId: `${SECTION_ID}#g1`,
      questionId: "q_not_in_package",
      targetScope: "question",
      verificationStatus: "verified",
      verificationRef: "人工核验：结构漂移测试",
      note: null,
      createdAt: nowISO(),
    });

    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toEqual([]);
  });

  it("结构真实存在的链接仍然是可用的（这条判据不是把所有东西都判死）", () => {
    importPaper();
    importCourse();
    establishUsableLink();

    // 正常路径：结构在 ⇒ 可用。防止上面的用例因为"永远返回空"而误绿。
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toHaveLength(1);
    expect(listLinksForSegmentWithUsability(repos, COURSE_ID, SEGMENT_ID)[0].runtimeUsable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 概览与列表必须共用同一段判据
// ---------------------------------------------------------------------------

describe("F1 概览与列表口径一致（不得一处说可用、一处说不可用）", () => {
  it("课程漂移后 overview 也把它计为失效，而不是可用", () => {
    importPaper();
    importCourse();
    establishUsableLink();

    const before = getCourseLinkOverview(repos, COURSE_ID);
    expect(before.verifiedUsable).toBe(1);
    expect(before.staleVerified).toBe(0);

    driftCourseOnDisk();

    const after = getCourseLinkOverview(repos, COURSE_ID);
    expect(after.verifiedUsable, "概览仍说可用，而列表说不可用 —— 两处判据漂移").toBe(0);
    expect(after.staleVerified).toBe(1);
    expect(after.matchedSegmentIds).toEqual([]);
  });

  it("真题漂移后 overview 同样计为失效", () => {
    importPaper();
    importCourse();
    establishUsableLink();
    driftPaperOnDisk();

    const overview = getCourseLinkOverview(repos, COURSE_ID);
    expect(overview.verifiedUsable).toBe(0);
    expect(overview.staleVerified).toBe(1);
  });

  it("包缺失时 overview 也不谎报可用", () => {
    importPaper();
    importCourse();
    establishUsableLink();
    rmSync(courseManifestPath(), { force: true });

    const overview = getCourseLinkOverview(repos, COURSE_ID);
    expect(overview.verifiedUsable).toBe(0);
    // 段总数读不到时如实给 null（或索引计数），但绝不假装可用
    expect(overview.matchedSegmentIds).toEqual([]);
  });
});
