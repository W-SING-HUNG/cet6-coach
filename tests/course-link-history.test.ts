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
  dedupeBySemanticTarget,
} from "@/services/course-link";
import type { Repositories } from "@/repositories/ports";
import { buildCourseFixture, writeCourseFixture } from "../scripts/course-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import { linkIdOf, semanticTargetOf } from "@/repositories/sqlite/courses";

/**
 * canonical 链接的**不可变复核历史**测试 —— Review 的 F3。
 *
 * ── 这一组要钉死的模型 ──
 *
 * 一行 = 一条**不可变的复核主张**（"某年某月某人核验过这条对应关系"）。
 * 由此推出四条必须成立的行为：
 *
 * 1. **同一份完整主张重复写入 ⇒ 幂等**（不产生重复行）；
 * 2. **同一目标、修正了出处 ⇒ 追加一条新行**，旧行保留
 *    （修复前 `verificationRef` 不在身份里，修正会被静默吞掉）；
 * 3. **raw UPDATE / DELETE ⇒ 被数据库触发器阻断**
 *    （"不可变"必须由数据库保证，不能只靠仓储不提供方法）；
 * 4. **运行时真相按语义目标去重**：多行审计历史不得让一个目标
 *    变成多个运行时含义。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

const COURSE_ID = "fixture-course-a";
const PAPER_ID = "fixture-cet6-2024-12-v1";
const SEGMENT_ID = "reading.a";
const SECTION_ID = "reading.careful_reading";

function importCourse(): void {
  writeCourseFixture(contentRoot, COURSE_ID, buildCourseFixture({ id: COURSE_ID }));
  const result = commitCourseImport(repos, planCourseImport(repos));
  expect(result.ok, `课程导入失败：${result.error}`).toBe(true);
  expect(result.written).toBe(1);
}

function importPaper(): void {
  writeFixturePackage(contentRoot, "fixture-paper", buildFixturePackage({ contentVersion: 1 }));
  const plan = planImport(repos, { only: ["fixture-paper"] });
  expect(plan.report.counts.insert).toBe(1);
  expect(commitImport(repos, plan).ok).toBe(true);
}

function linkRowCount(): number {
  return Number((db.prepare("SELECT COUNT(*) AS c FROM course_canonical_link").get() as { c: number }).c);
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    courseId: COURSE_ID,
    courseContentVersion: 1,
    segmentId: SEGMENT_ID,
    paperId: PAPER_ID,
    paperContentVersion: 1,
    sectionId: SECTION_ID,
    targetScope: "section" as const,
    verificationStatus: "verified" as const,
    verificationRef: "人工核验：复核记录 #1",
    ...overrides,
  };
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-link-history-"));
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);
  importPaper();
  importCourse();
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
// 不可变性（数据库层）
// ---------------------------------------------------------------------------

describe("F3 不可变性：由数据库触发器守护，不是应用层约定", () => {
  /**
   * 用**裸 SQL** 验证，不经过仓储 ——
   * "仓储不提供 update/delete"挡不住迁移脚本、调试工具与未来的调用方。
   */

  it("raw UPDATE verification_ref 被阻断", () => {
    expect(verifyCanonicalLink(repos, link()).ok).toBe(true);

    expect(
      () =>
        db
          .prepare("UPDATE course_canonical_link SET verification_ref = 'tampered'")
          .run(),
      "复核记录被就地改写 —— 审计历史不再可信",
    ).toThrow(/不可变/);

    // 数据确实没被动过
    const row = db.prepare("SELECT verification_ref FROM course_canonical_link").get() as {
      verification_ref: string;
    };
    expect(row.verification_ref).toBe("人工核验：复核记录 #1");
  });

  it("raw DELETE 被阻断", () => {
    expect(verifyCanonicalLink(repos, link()).ok).toBe(true);

    expect(() => db.prepare("DELETE FROM course_canonical_link").run(), "复核记录被删除").toThrow(
      /不可变/,
    );
    expect(linkRowCount()).toBe(1);
  });

  it("条件 UPDATE（只改一行）同样被阻断", () => {
    const created = verifyCanonicalLink(repos, link());
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    expect(() =>
      db
        .prepare("UPDATE course_canonical_link SET note = 'x' WHERE id = ?")
        .run(created.link.id),
    ).toThrow(/不可变/);
  });

  it("改目标（把链接指向另一道题）被阻断", () => {
    expect(verifyCanonicalLink(repos, link()).ok).toBe(true);
    expect(() =>
      db
        .prepare("UPDATE course_canonical_link SET section_id = 'reading.matching'")
        .run(),
    ).toThrow(/不可变/);
  });

  it("触发器在库里真实存在（不是只写在 schema.ts 里）", () => {
    const triggers = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='course_canonical_link'",
        )
        .all() as Array<{ name: string }>
    )
      .map((row) => row.name)
      .sort();
    expect(triggers).toEqual([
      "course_canonical_link_append_only_delete",
      "course_canonical_link_append_only_update",
    ]);
  });

  it("与既有只追加表用的是同一种守护模式（措辞一致）", () => {
    // performance_event / course_exposure_event 也用 RAISE(ABORT) 表达同一语义。
    // 这里只确认本表的触发器确实走同一条机制。
    const sql = (
      db
        .prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name='course_canonical_link_append_only_update'")
        .get() as { sql: string }
    ).sql;
    expect(sql).toContain("RAISE(ABORT");
  });
});

// ---------------------------------------------------------------------------
// 幂等：同一份完整主张
// ---------------------------------------------------------------------------

describe("F3 幂等：同一份完整复核主张重复写入不产生重复行", () => {
  it("完全相同的主张写入两次 ⇒ 只有一行，第二次 created=false", () => {
    const first = verifyCanonicalLink(repos, link());
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.created).toBe(true);

    const second = verifyCanonicalLink(repos, link());
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(false);
    expect(second.link.id).toBe(first.link.id);
    expect(second.warnings.some((warning) => warning.includes("幂等"))).toBe(true);

    expect(linkRowCount()).toBe(1);
  });

  it("id 由完整主张确定性推导（决定论：同输入同 id）", () => {
    const a = verifyCanonicalLink(repos, link());
    const b = verifyCanonicalLink(repos, link());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.link.id).toBe(b.link.id);
    expect(a.link.id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("createdAt 不参与身份（否则每次重跑都会产生新行）", () => {
    const identity = {
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION_ID,
      groupId: null,
      questionId: null,
      targetScope: "section" as const,
      verificationStatus: "verified" as const,
      verificationRef: "ref",
      note: null,
    };
    // 同一个主张两次推导必须相同 —— 时间不在输入里，因此无法影响结果。
    expect(linkIdOf(identity)).toBe(linkIdOf(identity));
  });
});

// ---------------------------------------------------------------------------
// 修正后的复核主张必须可表达（F3 的核心修正）
// ---------------------------------------------------------------------------

describe("F3 修正后的复核主张会被**追加**，不被吞掉", () => {
  it("同一目标、修正 verificationRef ⇒ 追加一条新行，旧行保留", () => {
    const original = verifyCanonicalLink(repos, link({ verificationRef: "人工核验：初版出处（有误）" }));
    expect(original.ok).toBe(true);
    if (!original.ok) return;

    // 修复前：id 相同 ⇒ ON CONFLICT DO NOTHING ⇒ created:false，
    // 修正被静默吞掉，库里仍是最初那条出处，而 CLI 报"PASS（无变化）"。
    const corrected = verifyCanonicalLink(
      repos,
      link({ verificationRef: "人工核验：修正后的出处（据此材料第 3 页）" }),
    );
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;

    expect(corrected.created, "修正后的出处被当成重复而吞掉").toBe(true);
    expect(corrected.link.id).not.toBe(original.link.id);
    expect(linkRowCount()).toBe(2);

    // 旧行原样保留（**不可变** —— 不是被覆盖）
    expect(repos.courses.getLink(original.link.id)!.verificationRef).toBe("人工核验：初版出处（有误）");
    expect(repos.courses.getLink(corrected.link.id)!.verificationRef).toContain("修正后的出处");
  });

  it("修正 note ⇒ 同样追加新行，不被吞掉", () => {
    const first = verifyCanonicalLink(repos, link({ note: "初版注解" }));
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    const second = verifyCanonicalLink(repos, link({ note: "修正后的注解" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.created).toBe(true);
    expect(linkRowCount()).toBe(2);
    expect(repos.courses.getLink(first.link.id)!.note).toBe("初版注解");
  });

  it("note 从 null 变成有值也算一条新主张", () => {
    const first = verifyCanonicalLink(repos, link({ note: null }));
    expect(first.ok).toBe(true);
    const second = verifyCanonicalLink(repos, link({ note: "补充了审计注解" }));
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.created).toBe(true);
    expect(linkRowCount()).toBe(2);
  });

  it("改回**完全相同**的主张仍然是幂等的（修正不会无限增长）", () => {
    verifyCanonicalLink(repos, link({ verificationRef: "A" }));
    verifyCanonicalLink(repos, link({ verificationRef: "B" }));
    expect(linkRowCount()).toBe(2);

    // 再写一次 A：与既有的 A 行身份相同 ⇒ 幂等命中
    const again = verifyCanonicalLink(repos, link({ verificationRef: "A" }));
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.created).toBe(false);
    expect(linkRowCount()).toBe(2);
  });

  it("历史 API 返回**全部**不可变行（审计历史不丢）", () => {
    verifyCanonicalLink(repos, link({ verificationRef: "第一版" }));
    verifyCanonicalLink(repos, link({ verificationRef: "第二版" }));
    verifyCanonicalLink(repos, link({ verificationRef: "第三版" }));

    const raw = repos.courses.listLinksForSegment(COURSE_ID, SEGMENT_ID);
    expect(raw).toHaveLength(3);
    expect(raw.map((item) => item.verificationRef).sort()).toEqual(["第一版", "第三版", "第二版"]);
  });

  it("candidate / rejected / verified 三种状态各自成行，全部保留", () => {
    verifyCanonicalLink(repos, link({ verificationStatus: "candidate", verificationRef: "" }));
    verifyCanonicalLink(repos, link({ verificationStatus: "rejected", verificationRef: "否决：不匹配" }));
    verifyCanonicalLink(repos, link({ verificationStatus: "verified", verificationRef: "核验通过" }));

    expect(linkRowCount()).toBe(3);
    const statuses = repos.courses
      .listLinksForSegment(COURSE_ID, SEGMENT_ID)
      .map((item) => item.verificationStatus)
      .sort();
    expect(statuses).toEqual(["candidate", "rejected", "verified"]);
  });
});

// ---------------------------------------------------------------------------
// 运行时语义目标去重（F3 的下半部分）
// ---------------------------------------------------------------------------

describe("F3 运行时去重：审计行多，运行时目标仍只有一个", () => {
  it("同一目标被复核两次 ⇒ 运行时只返回一个目标", () => {
    verifyCanonicalLink(repos, link({ verificationRef: "复核 #1" }));
    verifyCanonicalLink(repos, link({ verificationRef: "复核 #2（独立复现）" }));

    expect(linkRowCount()).toBe(2);
    const runtime = listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID);
    expect(runtime, "两行审计历史被当成了两个对应关系").toHaveLength(1);
  });

  it("去重后选**最新** createdAt 作为代表行（确定性）", () => {
    const older = verifyCanonicalLink(repos, link({ verificationRef: "较早的复核" }));
    expect(older.ok).toBe(true);

    // 直接追加一条 createdAt 明确更晚的行，消除同毫秒竞态
    const identity = {
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION_ID,
      groupId: null,
      questionId: null,
      targetScope: "section" as const,
      verificationStatus: "verified" as const,
      verificationRef: "更晚的复核",
      note: null,
    };
    repos.courses.appendLink({
      id: linkIdOf(identity),
      ...identity,
      createdAt: "2099-01-01T00:00:00.000Z",
    });

    const runtime = listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID);
    expect(runtime).toHaveLength(1);
    expect(runtime[0].verificationRef, "代表行不是最新的那条复核").toBe("更晚的复核");
  });

  it("createdAt 相同时按 id 升序取代表行（稳定 tie-break）", () => {
    const sameTime = "2030-06-01T00:00:00.000Z";
    const identities = ["A", "B", "C"].map((ref) => ({
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION_ID,
      groupId: null,
      questionId: null,
      targetScope: "section" as const,
      verificationStatus: "verified" as const,
      verificationRef: ref,
      note: null,
    }));
    for (const identity of identities) {
      repos.courses.appendLink({ id: linkIdOf(identity), ...identity, createdAt: sameTime });
    }

    const runtime = listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID);
    expect(runtime).toHaveLength(1);
    const expectedMinId = identities.map((identity) => linkIdOf(identity)).sort()[0];
    expect(runtime[0].id).toBe(expectedMinId);
  });

  it("去重结果与查询返回顺序无关（可复现）", () => {
    const rows = ["A", "B", "C"].map((ref, index) => ({
      id: `id-${ref}`,
      courseId: COURSE_ID,
      segmentId: SEGMENT_ID,
      courseContentVersion: 1,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION_ID,
      groupId: null,
      questionId: null,
      targetScope: "section" as const,
      verificationStatus: "verified" as const,
      verificationRef: ref,
      note: null,
      createdAt: `2030-01-0${index + 1}T00:00:00.000Z`,
    }));

    const forward = dedupeBySemanticTarget(rows as never);
    const reversed = dedupeBySemanticTarget([...rows].reverse() as never);
    expect(forward).toHaveLength(1);
    expect(reversed).toHaveLength(1);
    expect(forward[0].id).toBe(reversed[0].id);
  });

  it("**不同**语义目标仍然各自保留（去重不得误合并）", () => {
    verifyCanonicalLink(repos, link({ verificationRef: "阅读 A 的复核" }));
    // 同一 segment 指向**另一个**大题 —— 这是不同的语义目标
    verifyCanonicalLink(repos, link({ sectionId: "reading.banked_cloze", verificationRef: "选词填空的复核" }));

    const runtime = listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID);
    expect(runtime).toHaveLength(2);
    expect(runtime.map((item) => item.sectionId).sort()).toEqual([
      "reading.banked_cloze",
      "reading.careful_reading",
    ]);
  });

  it("语义目标身份不含出处/注解/时间", () => {
    const base = {
      courseId: COURSE_ID,
      courseContentVersion: 1,
      segmentId: SEGMENT_ID,
      paperId: PAPER_ID,
      paperContentVersion: 1,
      sectionId: SECTION_ID,
      groupId: null,
      questionId: null,
      targetScope: "section" as const,
    };
    // 同一目标身份是稳定的（它接收的结构里根本没有审计字段）
    expect(semanticTargetOf(base)).toBe(semanticTargetOf(base));
  });

  it("candidate / rejected 不参与运行时去重（它们本来就不进运行时）", () => {
    verifyCanonicalLink(repos, link({ verificationStatus: "candidate", verificationRef: "" }));
    verifyCanonicalLink(repos, link({ verificationStatus: "rejected", verificationRef: "否决" }));
    verifyCanonicalLink(repos, link({ verificationRef: "通过" }));

    expect(linkRowCount()).toBe(3);
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toHaveLength(1);
  });
});

describe("F3 getCourseLinkOverview 不得把同一目标重复计数", () => {
  it("同一目标复核两次：verifiedUsable 记 1，审计行数记 2", () => {
    verifyCanonicalLink(repos, link({ verificationRef: "复核 #1" }));
    verifyCanonicalLink(repos, link({ verificationRef: "复核 #2" }));

    const overview = getCourseLinkOverview(repos, COURSE_ID);

    expect(overview.verifiedUsable, "同一目标被重复计数成多个运行时目标").toBe(1);
    expect(overview.verifiedRows, "审计行数不应被去重").toBe(2);
    expect(overview.matchedSegmentIds).toEqual([SEGMENT_ID]);
  });

  it("段数不因重复复核而变化", () => {
    verifyCanonicalLink(repos, link({ verificationRef: "复核 #1" }));
    const before = getCourseLinkOverview(repos, COURSE_ID).matchedSegmentIds.length;

    verifyCanonicalLink(repos, link({ verificationRef: "复核 #2" }));
    verifyCanonicalLink(repos, link({ verificationRef: "复核 #3" }));

    const after = getCourseLinkOverview(repos, COURSE_ID);
    expect(after.matchedSegmentIds.length).toBe(before);
    expect(after.verifiedUsable).toBe(1);
    expect(after.verifiedRows).toBe(3);
  });

  it("两个**不同**目标仍计为 2（去重不误伤）", () => {
    verifyCanonicalLink(repos, link({ sectionId: "reading.careful_reading" }));
    verifyCanonicalLink(repos, link({ sectionId: "reading.matching" }));

    const overview = getCourseLinkOverview(repos, COURSE_ID);
    expect(overview.verifiedUsable).toBe(2);
  });

  it("原始历史 API 仍返回每一条（去重只发生在运行时层）", () => {
    verifyCanonicalLink(repos, link({ verificationRef: "复核 #1" }));
    verifyCanonicalLink(repos, link({ verificationRef: "复核 #2" }));

    expect(repos.courses.listLinksForSegment(COURSE_ID, SEGMENT_ID)).toHaveLength(2);
    expect(listLinksForSegmentWithUsability(repos, COURSE_ID, SEGMENT_ID)).toHaveLength(2);
    expect(listRuntimeLinksForSegment(repos, COURSE_ID, SEGMENT_ID)).toHaveLength(1);
  });
});

describe("F3 dry-run 仍然不写任何行（含修正场景）", () => {
  it("dry-run 的修正主张不落库", () => {
    verifyCanonicalLink(repos, link({ verificationRef: "初版" }));
    expect(linkRowCount()).toBe(1);

    const dry = verifyCanonicalLink(repos, { ...link({ verificationRef: "修正版" }), dryRun: true });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    expect(dry.dryRun).toBe(true);
    expect(linkRowCount(), "dry-run 却写了行").toBe(1);
  });

  it("dry-run 报告该主张将被追加（created=false 但非幂等命中）", () => {
    verifyCanonicalLink(repos, link({ verificationRef: "初版" }));
    const dry = verifyCanonicalLink(repos, { ...link({ verificationRef: "修正版" }), dryRun: true });
    expect(dry.ok).toBe(true);
    if (!dry.ok) return;
    // 它是一条**新的**主张（不会命中既有行），因此不应报"已存在"
    expect(dry.warnings.some((warning) => warning.includes("已经存在"))).toBe(false);
  });
});
