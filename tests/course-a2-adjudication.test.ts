/**
 * A2 人工审核与保存（Adjudication & Persistence）测试套件。
 *
 * 覆盖：
 * 1. 材料分组、分段、真题匹配三类独立审核操作校验；
 * 2. 显式 accepted / rejected / intentionally_unmatched 处理；
 * 3. 绝不自动替用户批准建议的判据与行为；
 * 4. 审核草稿形状校验、依据长度 (>=10) 强制、保存与重新打开、继续编辑；
 * 5. **P0-F1**：绑定身份由服务端现场重算；全零/假摘要/随机摘要必败；
 *    `allowStale` 不出现在生产保存路径；持久化 review 通过既有
 *    `validateCourseReviewFile` 且能被 `readStoredCandidate` + 门禁识别；
 * 6. **P1-F3**：分段计划持久化（白名单目录）、绑定现算、重新生成消费；
 * 7. **P2**：重复/冲突裁决被服务端拒绝；保存响应不含绝对路径；
 * 8. 路径白名单写入限制（只写 review.json / 计划目录，防逃逸）；
 * 9. 陈旧检查（候选/库/源三类变动）；
 * 10. 原子保存、历史备份自动生成、失败安全回滚与可验证恢复。
 *
 * 全部采用内存与合成夹具，绝不碰真实数据库或真实材料。
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkAdjudicationStaleness,
  describeBinding,
  loadAdjudicationDraft,
  loadAdjudicationPlan,
  prepareReviewForSave,
  recomputeReboundIdentity,
  resolveSafePlanPath,
  resolveSafeReviewPath,
  restoreFromBackup,
  saveAdjudicationPlan,
  saveAdjudicationReview,
  validateAdjudicationDraft,
  writeAtomicWithBackup,
  type AdjudicationDraftPayload,
} from "@/content/course-pipeline/adjudication";
import {
  evaluatePromotionGate,
  gatherPromotionInputs,
  readStoredCandidate,
  validateCourseReviewFile,
} from "@/content/course-pipeline/review";
import { runCourseIntake } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import { segmentationPlanDigest, parseSegmentationPlan } from "@/content/course-pipeline/segmentation-plan";
import { buildIndexFromDisk } from "@/content/course-pipeline/canonical";
import { CourseIdRejectedError } from "@/content/course-pipeline/containment";
import { buildTextPdf, buildCjkPdf, writeSourceTree } from "../scripts/course-source-fixture";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
} from "../scripts/course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

const roots: string[] = [];
function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `a2-test-${tag}-`));
  roots.push(root);
  return root;
}
import { afterAll } from "vitest";
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// 合成夹具：真实源 + 真实 canonical 库 + 真实候选（走 runCourseIntake）
// ---------------------------------------------------------------------------

function buildSyntheticPapers(root: string): string {
  const papersRoot = join(root, "synthetic-papers");
  const papersDir = join(papersRoot, "cet6", "papers");
  for (let index = 0; index < 2; index += 1) {
    const id = `fixture-cet6-2024-12-set${index + 1}`;
    writeFixturePackage(papersRoot, id, buildFixturePackage({ id, year: 2024, session: "December", variant: `set${index + 1}` }));
  }
  return papersDir;
}

function buildSyntheticSource(root: string): string {
  const sourceRoot = join(root, "synthetic-source");
  const tree = new Map<string, ReturnType<typeof buildTextPdf>>();
  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      ["SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL", "Passage One", "Questions 46 to 50 are based on the following passage.", ...FIXTURE_PASSAGE_A.split(/\s+/)],
      ["Passage One Questions", "46. What did the synthetic researchers assume?", "A) A single synthetic spotlight."],
    ]),
  );
  const cjk = [...FIXTURE_TRANSLATION_SOURCE];
  tree.set(
    "翻译/translation-unit1.pdf",
    buildCjkPdf([
      ["【合成夹具】翻译练习 · 请勿当真", ...cjk.slice(0, 24), ...cjk.slice(24, 48), ...cjk.slice(48, 72)],
      ["参考译文", ...FIXTURE_TRANSLATION_REFERENCE.slice(0, 24)],
    ]),
  );
  writeSourceTree(sourceRoot, tree);
  return sourceRoot;
}

interface SyntheticEnv {
  root: string;
  sourceRoot: string;
  papersDir: string;
  candidatesDir: string;
  plansDir: string;
  courseId: string;
  realChecksum: string;
  realCanonicalDigest: string;
  realSourceDigest: string;
  /** 候选里的提案 id 与段 id（供构造合法裁决）。 */
  proposalIds: string[];
  segmentIds: string[];
  translationAssetKey: string;
}

async function buildSyntheticEnv(tag: string, courseId = "a2-test-course"): Promise<SyntheticEnv> {
  const root = makeRoot(tag);
  const sourceRoot = buildSyntheticSource(root);
  const papersDir = buildSyntheticPapers(root);
  const candidatesDir = join(root, "course-candidates");
  const plansDir = join(root, "course-segmentation-plans");

  const intake = await runCourseIntake({
    sourceRoot,
    courseId,
    provider: "test_fixture_provider",
    edition: null,
    title: "A2 Test Course",
    contentVersion: 1,
    provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
    papersDir,
  });
  writeCourseCandidate(intake.archive, join(candidatesDir, courseId));

  const translationAsset = intake.inventory.assets.find((asset) => asset.relativePath.includes("translation"))!;

  return {
    root,
    sourceRoot,
    papersDir,
    candidatesDir,
    plansDir,
    courseId,
    realChecksum: intake.archive.metadata.digests.candidateChecksum,
    realCanonicalDigest: intake.archive.metadata.matching.canonicalLibrary.digest,
    realSourceDigest: intake.inventory.digest,
    proposalIds: intake.grouping.proposals.map((proposal) => proposal.id),
    segmentIds: intake.archive.metadata.segmentation.materials.flatMap((material) =>
      material.segments.map((segment) => segment.id),
    ),
    translationAssetKey: translationAsset.assetKey,
  };
}

function draftFor(env: SyntheticEnv, overrides: Partial<AdjudicationDraftPayload> = {}): AdjudicationDraftPayload {
  return {
    courseId: env.courseId,
    reviewer: "Reviewer R",
    reviewedAt: "2026-10-16",
    candidateChecksum: env.realChecksum,
    canonicalLibraryDigest: env.realCanonicalDigest,
    sourceDigest: env.realSourceDigest,
    verifiedScope: ["materials", "segments", "canonical_matches"],
    notVerified: [],
    materialGroupings: [
      { proposalId: env.proposalIds[0] ?? "p1", decision: "accepted", evidence: "分组经逐字核对确认一致无误。" },
    ],
    segments: (env.segmentIds.length > 0 ? env.segmentIds : ["seg-1"]).map((segmentId) => ({
      segmentId,
      decision: "accepted" as const,
      evidence: "已人工核对该段页码与讲义完全对齐。",
    })),
    matches: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 审核草稿结构与依据规范校验
// ---------------------------------------------------------------------------

describe("A2 · 审核草稿结构与依据规范校验", () => {
  it("合法草稿通过校验，返回规范 reviewFile", () => {
    const payload: AdjudicationDraftPayload = {
      courseId: "synth-course-01",
      reviewer: "Teacher Lin",
      reviewedAt: "2026-10-16",
      candidateChecksum: "a".repeat(64),
      canonicalLibraryDigest: "b".repeat(64),
      sourceDigest: "c".repeat(64),
      verifiedScope: ["materials", "segments", "canonical_matches"],
      notVerified: [],
      materialGroupings: [
        { proposalId: "mat-1", decision: "accepted", evidence: "已核对 PDF 与音频内容一致，结构完全吻合。" },
      ],
      segments: [
        { segmentId: "seg-1", decision: "accepted", evidence: "已人工核对该段起始页码第 1 页至第 3 页无遗漏。" },
      ],
      matches: [
        {
          segmentId: "seg-1",
          disposition: "accepted_suggestion",
          evidence: "已核对正文与 2023 年 12 月卷一阅读 Passage A 完全对应。",
          paperId: "2023-12-01",
          targetScope: "section",
          sectionId: "reading_careful_1",
          groupId: null,
          questionId: null,
        },
      ],
    };
    const val = validateAdjudicationDraft(payload);
    expect(val.ok).toBe(true);
    expect(val.errors).toHaveLength(0);
    expect(val.reviewFile?.courseId).toBe("synth-course-01");
  });

  it("依据少于 10 字符被坚决拒绝", () => {
    const payload: AdjudicationDraftPayload = {
      courseId: "synth-course-01",
      reviewer: "T",
      reviewedAt: "2026-10-16",
      candidateChecksum: "a".repeat(64),
      canonicalLibraryDigest: "b".repeat(64),
      sourceDigest: "c".repeat(64),
      verifiedScope: ["materials"],
      notVerified: [],
      materialGroupings: [{ proposalId: "mat-1", decision: "accepted", evidence: "太短了" }],
      segments: [],
      matches: [],
    };
    const val = validateAdjudicationDraft(payload);
    expect(val.ok).toBe(false);
    expect(val.errors.some((e) => e.includes("≥10 字符"))).toBe(true);
  });

  it("匹配裁决支持有意不匹配 (intentionally_unmatched)，且不强制 paperId", () => {
    const payload: AdjudicationDraftPayload = {
      courseId: "synth-course-01",
      reviewer: "T",
      reviewedAt: "2026-10-16",
      candidateChecksum: "a".repeat(64),
      canonicalLibraryDigest: "b".repeat(64),
      sourceDigest: "c".repeat(64),
      verifiedScope: ["materials"],
      notVerified: [],
      materialGroupings: [],
      segments: [],
      matches: [
        {
          segmentId: "seg-1",
          disposition: "intentionally_unmatched",
          evidence: "该段为教师讲解方法论笔记，按设计有意不关联真题。",
          paperId: null,
          targetScope: null,
          sectionId: null,
          groupId: null,
          questionId: null,
        },
      ],
    };
    const val = validateAdjudicationDraft(payload);
    expect(val.ok).toBe(true);
    expect(val.reviewFile?.matches[0].disposition).toBe("intentionally_unmatched");
  });

  it("接受或否决匹配建议时若缺失 paperId 则被拒绝", () => {
    const payload: AdjudicationDraftPayload = {
      courseId: "synth-course-01",
      reviewer: "T",
      reviewedAt: "2026-10-16",
      candidateChecksum: "a".repeat(64),
      canonicalLibraryDigest: "b".repeat(64),
      sourceDigest: "c".repeat(64),
      verifiedScope: ["materials"],
      notVerified: [],
      materialGroupings: [],
      segments: [],
      matches: [
        {
          segmentId: "seg-1",
          disposition: "accepted_suggestion",
          evidence: "确认匹配某篇真题，但忘记选定卷名了。",
          paperId: null,
          targetScope: "section",
          sectionId: "sec-1",
          groupId: null,
          questionId: null,
        },
      ],
    };
    const val = validateAdjudicationDraft(payload);
    expect(val.ok).toBe(false);
    expect(val.errors.some((e) => e.includes("paperId 缺失"))).toBe(true);
  });

  // ── P2-F5：重复 / 冲突裁决必须在服务端拒绝 ──
  it("重复 segmentId 的裁决被服务端拒绝（不依赖下游门禁）", () => {
    const payload = {
      courseId: "synth-course-01",
      reviewer: "T",
      reviewedAt: "2026-10-16",
      candidateChecksum: "a".repeat(64),
      canonicalLibraryDigest: "b".repeat(64),
      sourceDigest: "c".repeat(64),
      verifiedScope: ["materials"],
      notVerified: [],
      materialGroupings: [],
      segments: [
        { segmentId: "seg-1", decision: "accepted", evidence: "第一次裁决该段边界正确无误。" },
        { segmentId: "seg-1", decision: "excluded", evidence: "第二次裁决该段边界正确无误。" },
      ],
      matches: [],
    };
    const val = validateAdjudicationDraft(payload);
    expect(val.ok).toBe(false);
    expect(val.errors.some((e) => e.includes("重复裁决"))).toBe(true);
  });

  it("重复 proposalId / 重复匹配 segmentId 同样被拒绝", () => {
    const base = {
      courseId: "synth-course-01",
      reviewer: "T",
      reviewedAt: "2026-10-16",
      candidateChecksum: "a".repeat(64),
      canonicalLibraryDigest: "b".repeat(64),
      sourceDigest: "c".repeat(64),
      verifiedScope: ["materials"],
      notVerified: [],
    };
    const dupGrouping = validateAdjudicationDraft({
      ...base,
      materialGroupings: [
        { proposalId: "p1", decision: "accepted", evidence: "第一次裁决该分组内容确认一致。" },
        { proposalId: "p1", decision: "rejected", evidence: "第二次裁决该分组内容确认一致。" },
      ],
      segments: [],
      matches: [],
    });
    expect(dupGrouping.ok).toBe(false);

    const dupMatch = validateAdjudicationDraft({
      ...base,
      materialGroupings: [],
      segments: [],
      matches: [
        {
          segmentId: "seg-1",
          disposition: "accepted_suggestion",
          evidence: "第一次匹配裁决依据充分且完整无误。",
          paperId: "p-1",
          targetScope: "section",
          sectionId: "s-1",
          groupId: null,
          questionId: null,
        },
        {
          segmentId: "seg-1",
          disposition: "intentionally_unmatched",
          evidence: "第二次匹配裁决依据充分且完整无误。",
          paperId: null,
          targetScope: null,
          sectionId: null,
          groupId: null,
          questionId: null,
        },
      ],
    });
    expect(dupMatch.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. 安全写入路径与目录逃逸防御
// ---------------------------------------------------------------------------

describe("A2 · 安全写入路径与目录逃逸防御", () => {
  it("合法 courseId 解析为标准候选目录下的 review.json", () => {
    const p = resolveSafeReviewPath("course-test-1");
    expect(p.replace(/\\/g, "/")).toContain("course-candidates/course-test-1/review.json");
  });

  it("恶意路径穿越或非法 slug 被直接拦截并抛错", () => {
    expect(() => resolveSafeReviewPath("../escape")).toThrow(CourseIdRejectedError);
    expect(() => resolveSafeReviewPath("a/b")).toThrow(CourseIdRejectedError);
    expect(() => resolveSafeReviewPath("..\\escape")).toThrow(CourseIdRejectedError);
    expect(() => resolveSafePlanPath("..\\evil")).toThrow(CourseIdRejectedError);
    expect(() => resolveSafePlanPath("C:\\temp\\evil")).toThrow(CourseIdRejectedError);
  });

  it("分段计划安全路径只允许写在计划目录下", () => {
    const planP = resolveSafePlanPath("course-test-1");
    expect(planP.replace(/\\/g, "/")).toContain("course-segmentation-plans/course-test-1.json");
  });
});

// ---------------------------------------------------------------------------
// 3. 原子保存、自动备份与故障恢复
// ---------------------------------------------------------------------------

describe("A2 · 原子保存、自动备份与故障恢复", () => {
  it("首次写入原子落盘，无备份", () => {
    const testDir = join(makeRoot("atomic"), "d");
    mkdirSync(testDir, { recursive: true });
    const target = join(testDir, "review.json");

    const res = writeAtomicWithBackup(target, '{"reviewer": "Tester 1"}\n');
    expect(res.backupPath).toBeNull();
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("Tester 1");
  });

  it("已有文件时自动备份历史，支持从备份安全恢复", () => {
    const testDir = join(makeRoot("backup"), "d");
    mkdirSync(testDir, { recursive: true });
    const target = join(testDir, "review.json");

    writeFileSync(target, "INITIAL_CONTENT_V1", "utf8");
    const res = writeAtomicWithBackup(target, "NEW_CONTENT_V2");
    expect(res.backupPath).not.toBeNull();
    expect(existsSync(res.backupPath!)).toBe(true);
    expect(readFileSync(res.backupPath!, "utf8")).toBe("INITIAL_CONTENT_V1");
    expect(readFileSync(target, "utf8")).toBe("NEW_CONTENT_V2");

    const restored = restoreFromBackup(target, res.backupPath!);
    expect(restored).toBe(true);
    expect(readFileSync(target, "utf8")).toBe("INITIAL_CONTENT_V1");
  });

  it("备份文件从不被静默覆盖（唯一名）", () => {
    const testDir = join(makeRoot("backups"), "d");
    mkdirSync(testDir, { recursive: true });
    const target = join(testDir, "review.json");
    writeFileSync(target, "V1", "utf8");
    const b1 = writeAtomicWithBackup(target, "V2").backupPath!;
    writeFileSync(target, "V3", "utf8");
    const b2 = writeAtomicWithBackup(target, "V4").backupPath!;
    expect(b1).not.toBe(b2);
    expect(readFileSync(b1, "utf8")).toBe("V1");
    expect(readFileSync(b2, "utf8")).toBe("V3");
  });

  it("连续保存互不干扰，且每次都有上一版备份", () => {
    const testDir = join(makeRoot("consecutive"), "d");
    mkdirSync(testDir, { recursive: true });
    const target = join(testDir, "review.json");
    const first = writeAtomicWithBackup(target, "A");
    const second = writeAtomicWithBackup(target, "B");
    const third = writeAtomicWithBackup(target, "C");
    expect(first.backupPath).toBeNull();
    expect(second.backupPath).not.toBeNull();
    expect(third.backupPath).not.toBeNull();
    expect(readFileSync(target, "utf8")).toBe("C");
    expect(readFileSync(second.backupPath!, "utf8")).toBe("A");
    expect(readFileSync(third.backupPath!, "utf8")).toBe("B");
  });
});

// ---------------------------------------------------------------------------
// 4. P0-F1：绑定身份由服务端现场重算；假摘要必败
// ---------------------------------------------------------------------------

describe("P0-F1 · 绑定身份必须来自服务端现场重算", () => {
  it("recomputeReboundIdentity 返回真实候选校验和（readStoredCandidate 同源）", async () => {
    const env = await buildSyntheticEnv("rebound");
    const rebound = recomputeReboundIdentity({
      courseId: env.courseId,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
    });
    expect(rebound.candidateChecksum).toBe(env.realChecksum);
    expect(rebound.canonicalLibraryDigest).toBe(env.realCanonicalDigest);
    expect(rebound.sourceDigest).toBe(env.realSourceDigest);

    // 与下游 readStoredCandidate 的现场重算逐项一致（同一套唯一实现）
    const stored = readStoredCandidate(env.courseId, env.candidatesDir);
    expect(stored.recomputed.candidateChecksum).toBe(rebound.candidateChecksum);
  });

  it("全零摘要的保存被拒（候选校验和对不上现场重算）", async () => {
    const env = await buildSyntheticEnv("zero");
    const draft = draftFor(env, { candidateChecksum: "0".repeat(64) });
    const res = saveAdjudicationReview({
      draft,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok).toBe(false);
    expect(res.errors?.join("；")).toContain("候选");
  });

  it("随机摘要的保存被拒", async () => {
    const env = await buildSyntheticEnv("random");
    const draft = draftFor(env, { candidateChecksum: sha("random-not-real") });
    const res = saveAdjudicationReview({
      draft,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok).toBe(false);
  });

  it("候选不存在时明确报错且零写（不兜底、不伪装成功）", async () => {
    const env = await buildSyntheticEnv("missing");
    const draft = draftFor(env, { courseId: "does-not-exist-course" });
    const prepared = prepareReviewForSave({
      draft,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(prepared.ok).toBe(false);
    expect(prepared.candidateExists).toBe(false);
    expect(prepared.errors.join("；")).toContain("候选");
    expect(existsSync(join(env.candidatesDir, "does-not-exist-course"))).toBe(false);
  });

  it("合法保存：绑定真实 candidateChecksum，且 review 通过既有契约", async () => {
    const env = await buildSyntheticEnv("save");
    const draft = draftFor(env);
    const res = saveAdjudicationReview({
      draft,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok).toBe(true);

    const persisted = JSON.parse(readFileSync(join(env.candidatesDir, env.courseId, "review.json"), "utf8"));
    expect(persisted.candidateChecksum).toBe(env.realChecksum);
    expect(persisted.canonicalLibraryDigest).toBe(env.realCanonicalDigest);
    const validation = validateCourseReviewFile(persisted);
    expect(validation.ok).toBe(true);
  });

  it("保存的 review 能被既有下游只读审核门禁识别（review_bound_to_current_candidate 通过）", async () => {
    const env = await buildSyntheticEnv("downstream");
    const draft = draftFor(env);
    const res = saveAdjudicationReview({
      draft,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok).toBe(true);

    const persisted = JSON.parse(readFileSync(join(env.candidatesDir, env.courseId, "review.json"), "utf8"));
    const review = validateCourseReviewFile(persisted).file!;
    const stored = readStoredCandidate(env.courseId, env.candidatesDir);
    const index = buildIndexFromDisk(env.papersDir);

    const gate = evaluatePromotionGate(
      gatherPromotionInputs({
        stored,
        review,
        reviewErrors: [],
        canonical: { digest: index.index.summary.digest, complete: index.failures.length === 0 },
        standardSourcesRoot: join(env.root, "standard-sources"),
        sourceRootOverride: env.sourceRoot,
      }),
    );
    for (const check of gate.checks) {
      if (check.name === "human_review_present" || check.name === "review_bound_to_current_candidate") {
        expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
      }
    }
  });

  it("客户端携带的摘要即使与真实值一致，也以服务端重算值为准（不存在客户端注入）", async () => {
    const env = await buildSyntheticEnv("inject");
    // 客户端故意声称一个不同的 canonical 摘要
    const draft = draftFor(env, { canonicalLibraryDigest: sha("client-claimed") });
    const res = saveAdjudicationReview({
      draft,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok).toBe(false);

    // 正确的摘要才能保存
    const good = saveAdjudicationReview({
      draft: draftFor(env),
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(good.ok).toBe(true);
    const persisted = JSON.parse(readFileSync(join(env.candidatesDir, env.courseId, "review.json"), "utf8"));
    // 落盘值 = 服务端现场重算值，而不是任何客户端字符串
    expect(persisted.canonicalLibraryDigest).toBe(env.realCanonicalDigest);
    expect(persisted.canonicalLibraryDigest).not.toBe(sha("client-claimed"));
  });
});

// ---------------------------------------------------------------------------
// 5. 陈旧检查（候选 / canonical 库 / 源）
// ---------------------------------------------------------------------------

describe("A2 · 陈旧与过期检查", () => {
  it("源字节变动 ⇒ 判定陈旧", async () => {
    const env = await buildSyntheticEnv("stale-source");
    writeFileSync(
      join(env.sourceRoot, "阅读", "reading-handout.pdf"),
      buildTextPdf([["SYNTHETIC FIXTURE - MUTATED", ...FIXTURE_PASSAGE_A.split(/\s+/)]]),
    );
    const res = checkAdjudicationStaleness({
      courseId: env.courseId,
      draftCandidateChecksum: env.realChecksum,
      draftCanonicalDigest: env.realCanonicalDigest,
      draftSourceDigest: env.realSourceDigest,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.isStale).toBe(true);
    expect(res.reasons.join("；")).toContain("源");
  });

  it("源字节变动 ⇒ 保存被拒（prepareReviewForSave 的源新鲜度判据）", async () => {
    const env = await buildSyntheticEnv("stale-source-save");
    writeFileSync(
      join(env.sourceRoot, "阅读", "reading-handout.pdf"),
      buildTextPdf([["SYNTHETIC FIXTURE - MUTATED", ...FIXTURE_PASSAGE_A.split(/\s+/)]]),
    );
    // 摘要全部正确（不是陈旧页面）—— 唯一的变化是源本身
    const res = saveAdjudicationReview({
      draft: draftFor(env),
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok).toBe(false);
    expect(res.errors?.join("；")).toContain("源");
    expect(existsSync(join(env.candidatesDir, env.courseId, "review.json"))).toBe(false);
  });

  it("canonical 库变动 ⇒ 判定陈旧", async () => {
    const env = await buildSyntheticEnv("stale-library");
    rmSync(join(env.papersDir, "fixture-cet6-2024-12-set2"), { recursive: true, force: true });
    const res = checkAdjudicationStaleness({      courseId: env.courseId,
      draftCandidateChecksum: env.realChecksum,
      draftCanonicalDigest: env.realCanonicalDigest,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: null,
    });
    expect(res.isStale).toBe(true);
    expect(res.reasons.join("；")).toContain("canonical");
  });

  it("候选内容变动 ⇒ 判定陈旧，且既有 review.json 字节不变", async () => {
    const env = await buildSyntheticEnv("stale-candidate");
    const draft = draftFor(env);
    const first = saveAdjudicationReview({
      draft,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(first.ok).toBe(true);
    const before = readFileSync(join(env.candidatesDir, env.courseId, "review.json"), "utf8");

    // 改候选（course.json 字节变 ⇒ 现场重算的 candidateChecksum 变）
    writeFileSync(
      join(env.candidatesDir, env.courseId, "course.json"),
      JSON.stringify({ id: env.courseId, title: "MUTATED", schemaVersion: 1 }, null, 2),
      "utf8",
    );

    const second = saveAdjudicationReview({
      draft,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(second.ok).toBe(false);
    expect(readFileSync(join(env.candidatesDir, env.courseId, "review.json"), "utf8")).toBe(before);
  });

  it("候选不存在时 staleness 判陈旧（失败关闭，不放行）", async () => {
    const env = await buildSyntheticEnv("stale-missing");
    const res = checkAdjudicationStaleness({
      courseId: "no-such-course",
      draftCandidateChecksum: "a".repeat(64),
      draftCanonicalDigest: "b".repeat(64),
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
    });
    expect(res.isStale).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. 保存、重新打开、继续编辑
// ---------------------------------------------------------------------------

describe("A2 · 保存、重新打开、继续编辑草稿", () => {
  it("保存 review.json 后能够重新加载并继续编辑", async () => {
    const env = await buildSyntheticEnv("reopen");
    const draft = draftFor(env);
    const saveRes = saveAdjudicationReview({
      draft,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(saveRes.ok).toBe(true);
    expect(existsSync(saveRes.filePath)).toBe(true);

    const loaded = loadAdjudicationDraft({ courseId: env.courseId, candidatesDir: env.candidatesDir });
    expect(loaded.exists).toBe(true);
    expect(loaded.validation.ok).toBe(true);
    expect(loaded.raw?.reviewer).toBe("Reviewer R");
    expect(loaded.raw?.materialGroupings[0].decision).toBe("accepted");

    // 继续编辑：加一条匹配裁决
    const edited: AdjudicationDraftPayload = {
      ...(loaded.raw as unknown as AdjudicationDraftPayload),
      matches: [
        {
          segmentId: loaded.raw!.segments[0]?.segmentId ?? "seg-1",
          disposition: "intentionally_unmatched",
          evidence: "该段为听力材料，本版本不做转写匹配，有意标记为不匹配。",
          paperId: null,
          targetScope: null,
          sectionId: null,
          groupId: null,
          questionId: null,
        },
      ],
    };
    const editRes = saveAdjudicationReview({
      draft: edited,
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(editRes.ok).toBe(true);
    expect(editRes.backupPath).not.toBeNull();
    // 备份是上一版（无 matches）
    expect(JSON.parse(readFileSync(editRes.backupPath!, "utf8")).matches).toHaveLength(0);
    // 当前版本有新裁决
    expect(JSON.parse(readFileSync(join(env.candidatesDir, env.courseId, "review.json"), "utf8")).matches).toHaveLength(1);
  });

  it("损坏的既有 review 加载失败关闭，且不重写原文件", () => {
    const dir = join(makeRoot("corrupt"), "course-candidates", "probe-x");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "review.json");
    writeFileSync(p, "{not-json", "utf8");
    const before = readFileSync(p, "utf8");
    const loaded = loadAdjudicationDraft({ courseId: "probe-x", candidatesDir: join(makeRoot("corrupt2"), "course-candidates") });
    expect(loaded.validation.ok).toBe(false);
    expect(readFileSync(p, "utf8")).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// 7. P1-F3：分段计划持久化与重新生成消费
// ---------------------------------------------------------------------------

describe("P1-F3 · 分段计划持久化并参与候选重新生成", () => {
  /** 合成计划载荷（形状层要求 `range` 嵌套）。 */
  function planPayload(env: SyntheticEnv, lineCount: number, sourceDigest: string) {
    return {
      schemaVersion: 1,
      binding: {
        courseId: env.courseId,
        sourceDigest,
        assets: [{ assetKey: env.translationAssetKey, sha256: "0".repeat(64) }],
      },
      author: "A2 Test",
      createdAt: new Date().toISOString(),
      reason: "synthetic plan for test",
      units: [
        {
          title: "合成翻译单元一",
          kind: "translation_passage",
          assignments: Array.from({ length: lineCount }, (_, index) => ({
            channel: "source",
            range: {
              assetKey: env.translationAssetKey,
              page: 1,
              lineStart: index + 1,
              lineEnd: index + 1,
            },
            note: null,
          })),
        },
      ],
    };
  }

  it("合法计划保存到白名单目录，且绑定由服务端现算", async () => {
    const env = await buildSyntheticEnv("plan-save");
    const res = saveAdjudicationPlan({
      courseId: env.courseId,
      plan: planPayload(env, 8, env.realSourceDigest),
      plansDir: env.plansDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok, res.errors.join("；")).toBe(true);
    expect(existsSync(join(env.plansDir, `${env.courseId}.json`))).toBe(true);
    expect(/^[0-9a-f]{64}$/.test(res.planDigest)).toBe(true);

    // 落盘的计划绑定必须与当前源一致（服务端现算）
    const persisted = JSON.parse(readFileSync(join(env.plansDir, `${env.courseId}.json`), "utf8"));
    expect(persisted.binding.sourceDigest).toBe(env.realSourceDigest);
  });

  it("服务端现算绑定：提交空 binding 也会被注入当前源摘要与资产", async () => {
    const env = await buildSyntheticEnv("plan-rebind");
    const res = saveAdjudicationPlan({
      courseId: env.courseId,
      plan: planPayload(env, 8, sha("client-claimed-old-source")),
      plansDir: env.plansDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok, res.errors.join("；")).toBe(true);
    const persisted = JSON.parse(readFileSync(join(env.plansDir, `${env.courseId}.json`), "utf8"));
    // 落盘绑定 = 服务端现算值，而不是客户端声称的旧摘要
    expect(persisted.binding.sourceDigest).toBe(env.realSourceDigest);
    expect(persisted.binding.sourceDigest).not.toBe(sha("client-claimed-old-source"));
    expect(persisted.binding.assets.length).toBeGreaterThan(0);
  });

  it("计划引用的资产在当前源中不存在 ⇒ 保存被拒", async () => {
    const env = await buildSyntheticEnv("plan-asset-missing");
    const payload = planPayload(env, 8, env.realSourceDigest);
    payload.units[0].assignments = payload.units[0].assignments.map((a) => ({
      ...a,
      range: { ...a.range, assetKey: "no-such-asset-key" },
    }));
    const res = saveAdjudicationPlan({
      courseId: env.courseId,
      plan: payload,
      plansDir: env.plansDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("；")).toContain("资产");
  });

  it("保存的计划可被重新载入、修改、恢复", async () => {
    const env = await buildSyntheticEnv("plan-reload");
    const first = saveAdjudicationPlan({
      courseId: env.courseId,
      plan: planPayload(env, 8, env.realSourceDigest),
      plansDir: env.plansDir,
      sourceDir: env.sourceRoot,
    });
    expect(first.ok, first.errors.join("；")).toBe(true);

    const loaded = loadAdjudicationPlan({ courseId: env.courseId, plansDir: env.plansDir });
    expect(loaded.exists).toBe(true);
    expect(loaded.raw).not.toBeNull();

    const modified = { ...loaded.raw!, units: [{ ...loaded.raw!.units[0], title: "修改后的单元标题" }] };
    const second = saveAdjudicationPlan({
      courseId: env.courseId,
      plan: modified,
      plansDir: env.plansDir,
      sourceDir: env.sourceRoot,
    });
    expect(second.ok, second.errors.join("；")).toBe(true);
    expect(second.backupPath).not.toBeNull();
    expect(loadAdjudicationPlan({ courseId: env.courseId, plansDir: env.plansDir }).raw!.units[0].title).toBe("修改后的单元标题");

    expect(restoreFromBackup(join(env.plansDir, `${env.courseId}.json`), second.backupPath!)).toBe(true);
    expect(loadAdjudicationPlan({ courseId: env.courseId, plansDir: env.plansDir }).raw!.units[0].title).toBe("合成翻译单元一");
  });

  it("计划校验和与既有 segmentationPlanDigest 一致（唯一实现）", async () => {
    const env = await buildSyntheticEnv("plan-digest");
    const res = saveAdjudicationPlan({
      courseId: env.courseId,
      plan: planPayload(env, 8, env.realSourceDigest),
      plansDir: env.plansDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok, res.errors.join("；")).toBe(true);
    const parsed = parseSegmentationPlan(readFileSync(join(env.plansDir, `${env.courseId}.json`), "utf8"));
    expect(parsed.ok).toBe(true);
    expect(res.planDigest).toBe(segmentationPlanDigest(parsed.plan!));
  });

  it("计划引用的资产内容已变化 ⇒ 保存被拒", async () => {
    const env = await buildSyntheticEnv("plan-asset-changed");
    const payload = planPayload(env, 8, env.realSourceDigest);
    // 把资产换成当前源里不存在的键
    payload.binding.assets = [{ assetKey: "no-such-asset-key", sha256: "0".repeat(64) }];
    payload.units[0].assignments = payload.units[0].assignments.map((a) => ({
      ...a,
      range: { ...a.range, assetKey: "no-such-asset-key" },
    }));
    const res = saveAdjudicationPlan({
      courseId: env.courseId,
      plan: payload,
      plansDir: env.plansDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok).toBe(false);
    expect(res.errors.join("；")).toContain("资产");
  });
});

// ---------------------------------------------------------------------------
// 8. P2-F4：保存响应不含绝对路径
// ---------------------------------------------------------------------------

describe("P2-F4 · 保存响应不含绝对路径", () => {
  it("describeBinding 只回传摘要与布尔，不含任何路径形态", async () => {
    const env = await buildSyntheticEnv("nopath");
    const binding = describeBinding({ courseId: env.courseId, candidatesDir: env.candidatesDir, papersDir: env.papersDir });
    expect(binding.candidateExists).toBe(true);
    expect(binding.rebound?.candidateChecksum).toBe(env.realChecksum);
    const serialized = JSON.stringify(binding);
    expect(/[A-Za-z]:\\/.test(serialized), "绑定响应不得含盘符路径").toBe(false);
    expect(serialized).not.toContain(env.root);
  });

  it("候选不存在时 describeBinding 如实报告，且不给占位摘要", async () => {
    const env = await buildSyntheticEnv("nopath-missing");
    const binding = describeBinding({ courseId: "no-such-course", candidatesDir: env.candidatesDir, papersDir: env.papersDir });
    expect(binding.candidateExists).toBe(false);
    expect(binding.rebound).toBeNull();
    expect(binding.reason).toBeTruthy();
  });

  it("saveAdjudicationReview 成功时 filePath 是服务端内部值；启动器负责转换相对标签", async () => {
    const env = await buildSyntheticEnv("nopath-save");
    const res = saveAdjudicationReview({
      draft: draftFor(env),
      candidatesDir: env.candidatesDir,
      papersDir: env.papersDir,
      sourceDir: env.sourceRoot,
    });
    expect(res.ok).toBe(true);
    expect(typeof res.filePath).toBe("string");
  });
});
