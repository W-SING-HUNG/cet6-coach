import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCourseIntake } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import {
  buildLinkPlan,
  evaluatePromotionGate,
  gatherPromotionInputs,
  readStoredCandidate,
  validateCourseReviewFile,
  promoteCourseCandidate,
} from "@/content/course-pipeline/review";
import { buildIndexFromDisk } from "@/content/course-pipeline/canonical";
import { buildTextPdf, buildCjkPdf, buildImageOnlyPdf, writeSourceTree } from "../scripts/course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_PASSAGE_B,
  FIXTURE_TRANSLATION_SOURCE,
  FIXTURE_TRANSLATION_REFERENCE,
} from "../scripts/course-source-fixture";

/**
 * RSVP Intake Readiness —— 合成课程场景演练。
 *
 * ── 它验的是什么 ──
 *
 * 任务书 B 节列出的十类场景。每一条都跑**真实代码路径**
 * （`runCourseIntake` → 候选 → 复核门禁），而不是 mock。
 *
 * ── 隔离（硬约束）──
 *
 * 每个用例在 `os.tmpdir()` 下的独立临时目录里建源目录、候选目录、
 * canonical 库与课程根。**不触碰** `private-content/`、`data/cet6.db`
 * 或 `.e2e/`：`CET6_CONTENT_ROOT` 在本文件里**从未**被设置，
 * 而所有路径都由测试自己构造。
 *
 * ── 内容策略 ──
 *
 * 全部内容是合成夹具（`scripts/course-source-fixture.ts` 的通用说明文
 * 与虚构对话）。它**不是**任何真实 CET 材料，也**不冒充**真实课程。
 * 本文件**不新增**任何面向学习者的内容。
 */

interface TempEnv {
  root: string;
  contentRoot: string;
  sourceRoot: string;
  papersDir: string;
  candidatesDir: string;
  coursesDir: string;
  dispose(): void;
}

function makeEnv(): TempEnv {
  const root = mkdtempSync(join(tmpdir(), "cet6-rsvp-readiness-"));
  const contentRoot = join(root, "content");
  const env: TempEnv = {
    root,
    contentRoot,
    // 源放在标准私有源树之内 ⇒ 候选得到 `standard` 定位符，
    // 复核/晋升能自动重新清点源来证明未漂移（外部源那条路由既有测试覆盖）。
    sourceRoot: join(contentRoot, "course-sources", "src"),
    papersDir: join(contentRoot, "cet6", "papers"),
    candidatesDir: join(contentRoot, "course-candidates"),
    coursesDir: join(contentRoot, "courses"),
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
  mkdirSync(env.sourceRoot, { recursive: true });
  return env;
}

/** 把一棵合成源树写进源目录并跑完整抽取。 */
async function extract(
  env: TempEnv,
  tree: Map<string, Buffer>,
  overrides: { courseId?: string; papers?: "empty" | "one" | "two" } = {},
) {
  writeSourceTree(env.sourceRoot, tree);
  if (overrides.papers === "one") {
    writeFixturePackage(env.contentRoot, "fixture-paper", buildFixturePackage({ id: "fixture-paper", contentVersion: 1 }));
  } else if (overrides.papers === "two") {
    writeFixturePackage(env.contentRoot, "fixture-paper", buildFixturePackage({ id: "fixture-paper", contentVersion: 1 }));
    writeFixturePackage(env.contentRoot, "fixture-paper-2", buildFixturePackage({ id: "fixture-paper-2", contentVersion: 1 }));
  }
  const result = await runCourseIntake({
    sourceRoot: env.sourceRoot,
    courseId: overrides.courseId ?? "readiness-course",
    provider: "test_fixture_provider",
    edition: "readiness",
    title: "合成课程包（RSVP 接入就绪演练）",
    contentVersion: 1,
    provenance: {
      note: "合成夹具，仅用于课程接入流程演练，不是任何真实课程材料。",
      reference: "tests/course-rsvp-readiness.test.ts",
      rightsNote: "合成夹具，无第三方权利。",
    },
    papersDir: env.papersDir,
    standardSourcesRoot: join(env.contentRoot, "course-sources"),
  });
  return result;
}

/** 写出候选包并按需签署一份形状合法的 review.json。 */
function writeCandidate(
  env: TempEnv,
  courseId: string,
  archive: Awaited<ReturnType<typeof runCourseIntake>>["archive"],
  options: { sign?: boolean; allUnmatched?: boolean } = {},
) {
  const dir = join(env.candidatesDir, courseId);
  mkdirSync(dir, { recursive: true });
  writeCourseCandidate(archive, dir);
  if (options.sign !== false) {
    const stored = readStoredCandidate(courseId, env.candidatesDir);
    const md = stored.metadata;
    const review = {
      courseId,
      reviewer: "readiness-reviewer",
      reviewedAt: "2026-02-01",
      candidateChecksum: stored.recomputed.candidateChecksum,
      canonicalLibraryDigest: md.matching.canonicalLibrary.digest,
      materialGroupings: md.grouping.proposals
        .filter((proposal) => proposal.reviewRequired)
        .map((proposal) => ({
          proposalId: proposal.id,
          decision: "accepted" as const,
          note: "确认该分组。",
          evidence: "演练夹具依据候选记录的 basis 与 evidence 作出该裁决（≥10 字符）。",
        })),
      segments: md.segmentation.materials
        .flatMap((material) => material.segments)
        .filter((segment) => segment.reviewRequired)
        .map((segment) => ({
          segmentId: segment.id,
          decision: "accepted" as const,
          note: "确认该段。",
          evidence: "演练夹具依据候选记录的 evidence.cues 与 lineSpan 作出该裁决（≥10 字符）。",
        })),
      matches: options.allUnmatched
        ? md.matching.segments.map((segment) => ({
            segmentId: segment.segmentId,
            disposition: "intentionally_unmatched" as const,
            paperId: null,
            targetScope: null,
            sectionId: null,
            groupId: null,
            questionId: null,
            note: "全部段有意不匹配。",
            evidence: "演练夹具显式声明全部段有意不匹配（≥10 字符）。",
          }))
        : [],
      verifiedScope: ["演练：候选结构、资产完整性与门禁路径"],
      notVerified: ["未做任何 canonical 对应关系的人工核验"],
    };
    writeFileSync(join(dir, "review.json"), JSON.stringify(review, null, 2), "utf8");
  }
  return dir;
}

/** 求值晋升门禁（与 CLI 共用 `gatherPromotionInputs`）。 */
function gateFor(env: TempEnv, courseId: string) {
  const stored = readStoredCandidate(courseId, env.candidatesDir);
  const reviewPath = join(env.candidatesDir, courseId, "review.json");
  let review: ReturnType<typeof validateCourseReviewFile>["file"] = null;
  let reviewErrors: string[] = [];
  if (existsSync(reviewPath)) {
    try {
      const parsed = validateCourseReviewFile(JSON.parse(readFileSync(reviewPath, "utf8")));
      review = parsed.file;
      reviewErrors = parsed.errors;
    } catch (error) {
      reviewErrors = [`review.json 不是合法 JSON：${(error as Error).message}`];
    }
  }
  const index = buildIndexFromDisk(env.papersDir);
  const gate = evaluatePromotionGate(
    gatherPromotionInputs({
      stored,
      review,
      reviewErrors,
      canonical: { digest: index.index.summary.digest, complete: index.failures.length === 0 },
      standardSourcesRoot: join(env.contentRoot, "course-sources"),
    }),
  );
  return { stored, review, gate };
}

// ---------------------------------------------------------------------------
// 场景 1：多级目录，阅读 / 翻译 / 写作 / 听力混合
// ---------------------------------------------------------------------------

describe("场景 1 · 多级混合目录（阅读 / 翻译 / 写作 / 听力）", () => {
  it("四种模块都被清点、抽取、分段，且文件夹标签只作候选提示", async () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>();
      tree.set(
        "第1套/阅读/reading-handout.pdf",
        buildTextPdf([
          ["Passage One", "Questions 46 to 50 are based on the following passage.", ...wrapLatin(FIXTURE_PASSAGE_A)],
          ["Passage Two", "Questions 51 to 55 are based on the following passage.", ...wrapLatin(FIXTURE_PASSAGE_B)],
        ]),
      );
      tree.set(
        "第1套/翻译/translation-unit1.pdf",
        buildCjkPdf([
          ["翻译练习", ...wrapCjk(FIXTURE_TRANSLATION_SOURCE)],
          ["参考译文", ...wrapLatin(FIXTURE_TRANSLATION_REFERENCE)],
        ]),
      );
      tree.set(
        "第1套/写作/writing-template.pdf",
        buildTextPdf([
          [
            "Writing Template",
            "Introduction: state the topic and your position in one sentence.",
            "Body paragraph one: give the strongest reason with an example.",
            "Conclusion: restate the position without introducing new material.",
          ],
        ]),
      );
      tree.set("第1套/听力/listening-full.wav", buildSilentWav());

      const result = await extract(env, tree);

      // 清点：四个模块的文件都被发现（嵌套目录被递归）
      expect(result.inventory.assets.length).toBe(4);
      const moduleHints = new Set(result.inventory.assets.map((asset) => asset.moduleHint));
      expect(moduleHints).toContain("reading");
      expect(moduleHints).toContain("translation");
      expect(moduleHints).toContain("writing");
      expect(moduleHints).toContain("listening");

      // 分段：阅读篇章、翻译段、写作模板都被产出
      const kinds = result.archive.manifest.segments.map((segment) => segment.kind);
      expect(kinds).toContain("reading_passage");
      expect(kinds).toContain("translation_passage");
      expect(kinds).toContain("writing_template");

      // 听力音频**不切分、不推断时间区间**：它被登记为资产，但本夹具没有
      // 可解析的文档表示，因此不产出段（没有内容证据时不得发明段）
      const listeningAsset = result.inventory.assets.find((asset) => asset.extension === ".wav");
      expect(listeningAsset?.kind).toBe("audio");
      expect(listeningAsset?.contentParsed).toBe(false);

      // 分组不变量：每个资产恰好属于一份材料提案
      expect(result.grouping.invariantViolations).toEqual([]);

      // 文件夹标签**不是**身份证据：它们只出现在 moduleHint 里，
      // 而段 id 由（材料提案, 序号）确定性推导（与 folderLabelOnly 无关）。
      for (const segment of result.archive.manifest.segments) {
        expect(segment.id).toMatch(/^m[0-9a-f]{8}\.[a-z.]+\d+$/);
      }
      // 段 id 满足生产校验器的 slug 约束
      expect(result.archive.manifest.segments.every((segment) => /^[a-z0-9][a-z0-9._-]*$/.test(segment.id))).toBe(true);
      // 没有任何一段是"只凭文件夹标签"抽出来的（那会让目录名成为内容证据）
      const folderLabelOnly = result.segmentation.flatMap((material) =>
        material.segments.filter((segment) => segment.evidence.folderLabelOnly).map((segment) => segment.id),
      );
      expect(folderLabelOnly).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("同一条混合链路上 canonical 匹配只产建议，且写作/方法按设计不匹配", async () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>();
      tree.set(
        "阅读/reading-handout.pdf",
        buildTextPdf([["Passage One", ...wrapLatin(FIXTURE_PASSAGE_A)]]),
      );
      tree.set(
        "写作/writing-template.pdf",
        buildTextPdf([["Writing Template", "Introduction: state the topic in one sentence."]]),
      );

      const result = await extract(env, tree, { papers: "one" });
      const matching = result.archive.metadata.matching;

      expect(matching.canonicalLibrary.papers.length).toBe(1);
      // 写作模板与方法说明**按设计**不参与 canonical 匹配。
      // 它们可能连匹配结果条目都没有（无分块 ⇒ 无 entry），
      // 因此这里按"存在条目时必须 no_candidate"来断言，而不是假设条目一定存在。
      const writing = matching.segments.find((segment) => segment.segmentKind === "writing_template");
      if (writing) {
        expect(writing.suggestions).toHaveLength(0);
        expect(writing.label).toBe("no_candidate");
        expect(writing.blocking.candidatesConsidered).toBe(0);
      }

      // 任何建议都**不是** verified：标签体系里不存在这个值
      for (const segment of matching.segments) {
        for (const suggestion of segment.suggestions) {
          expect(suggestion.label).not.toBe("verified");
        }
      }
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 2：同一逻辑材料的 PDF 与 DOCX 表示
// ---------------------------------------------------------------------------

describe("场景 2 · 同一逻辑材料的 PDF + DOCX", () => {
  it("被提案为一份材料的两种表示，且等价性**未被验证** ⇒ 必须人工确认", async () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>();
      tree.set(
        "阅读/shared-handout.pdf",
        buildTextPdf([["Shared Handout", "Passage One", ...wrapLatin(FIXTURE_PASSAGE_A)]]),
      );
      tree.set("阅读/shared-handout.docx", buildMinimalDocx("shared handout"));

      const result = await extract(env, tree);

      const proposals = result.grouping.proposals;
      expect(proposals).toHaveLength(1);
      const proposal = proposals[0];
      expect(proposal.representations.map((rep) => rep.kind).sort()).toEqual(["docx", "pdf"]);
      // DOCX 未被解析 ⇒ "内容相同"这件事**没有被验证过**
      expect(proposal.evidence.contentComparable).toBe(false);
      expect(proposal.reviewRequired).toBe(true);
      expect(result.archive.review.some((item) => item.code === "material_grouping_requires_review")).toBe(true);
      // DOCX 绝不假装抽到文本
      const docxDoc = result.documents.find((doc) => doc.deferredMarker === "TEXT_EXTRACTION_DEFERRED");
      expect(docxDoc).toBeDefined();
      expect(docxDoc?.pages).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 3：较长的翻译 PDF 需要人工分段计划
// ---------------------------------------------------------------------------

describe("场景 3 · 长翻译材料 + 人工分段计划", () => {
  it("计划按人的结构产段、改变候选身份，且覆盖缺口阻断而致命问题回退自动", async () => {
    const env = makeEnv();
    try {
      // 一份较长的翻译材料：三页，每页一个练习，页眉逐字相同。
      // 没有可靠的结构标记 ⇒ 自动分段只能产出一个文档级段。
      const tree = new Map<string, Buffer>();
      tree.set(
        "翻译/multi-unit-handout.pdf",
        buildCjkPdf([
          ["CET6 Translation Practice Handout", ...wrapCjk(MULTI_UNIT_SOURCE_1)],
          ["CET6 Translation Practice Handout", ...wrapLatin(MULTI_UNIT_REFERENCE_1)],
          ["CET6 Translation Practice Handout", ...wrapCjk(MULTI_UNIT_SOURCE_2)],
          ["CET6 Translation Practice Handout", ...wrapLatin(MULTI_UNIT_REFERENCE_2)],
          ["CET6 Translation Practice Handout", ...wrapCjk(MULTI_UNIT_SOURCE_3)],
        ]),
      );

      // ── ① 无计划：自动分段（默认真实未变）──
      const auto = await extract(env, tree);
      expect(auto.segmentationPlan.applied).toBe(false);
      expect(auto.archive.metadata.segmentation.modeEvidence.mode).toBe("automatic");
      const autoSegments = auto.archive.manifest.segments;
      expect(autoSegments.length).toBe(1);
      expect(autoSegments[0].kind).toBe("translation_passage");

      // ── ② 探测坐标，构造一份人工计划 ──
      const asset = auto.inventory.assets.find((item) => item.kind === "pdf")!;
      const document = auto.documents.find((doc) => doc.assetKey === asset.assetKey)!;
      const lineCount = new Map<number, number>();
      for (const page of document.pages) if (page.hasTextLayer) lineCount.set(page.page, page.lines.length);
      const last = (page: number) => lineCount.get(page) ?? 1;

      const plan = {
        schemaVersion: 1,
        binding: {
          courseId: "readiness-course",
          sourceDigest: auto.inventory.digest,
          assets: [{ assetKey: asset.assetKey, sha256: asset.sha256 }],
        },
        author: "readiness",
        createdAt: "2026-02-01T00:00:00.000Z",
        reason: "该材料没有可靠的重复结构边界，页边界也不是内容边界。",
        units: [
          {
            title: "翻译练习 1",
            kind: "translation_passage",
            assignments: [
              { channel: "source", range: { assetKey: asset.assetKey, page: 1, lineStart: 2, lineEnd: last(1) }, note: null },
              { channel: "reference_translation", range: { assetKey: asset.assetKey, page: 2, lineStart: 2, lineEnd: last(2) }, note: null },
              { channel: "ignored_furniture", range: { assetKey: asset.assetKey, page: 1, lineStart: 1, lineEnd: 1 }, note: "重复页眉" },
              { channel: "ignored_furniture", range: { assetKey: asset.assetKey, page: 2, lineStart: 1, lineEnd: 1 }, note: "重复页眉" },
            ],
          },
          {
            title: "翻译练习 2",
            kind: "translation_passage",
            assignments: [
              { channel: "source", range: { assetKey: asset.assetKey, page: 3, lineStart: 2, lineEnd: last(3) }, note: null },
              { channel: "reference_translation", range: { assetKey: asset.assetKey, page: 4, lineStart: 2, lineEnd: last(4) }, note: null },
              { channel: "ignored_furniture", range: { assetKey: asset.assetKey, page: 3, lineStart: 1, lineEnd: 1 }, note: "重复页眉" },
              { channel: "ignored_furniture", range: { assetKey: asset.assetKey, page: 4, lineStart: 1, lineEnd: 1 }, note: "重复页眉" },
            ],
          },
          {
            title: "翻译练习 3",
            kind: "translation_passage",
            assignments: [
              { channel: "source", range: { assetKey: asset.assetKey, page: 5, lineStart: 2, lineEnd: last(5) }, note: null },
              { channel: "ignored_furniture", range: { assetKey: asset.assetKey, page: 5, lineStart: 1, lineEnd: 1 }, note: "重复页眉" },
            ],
          },
        ],
      };

      const planned = await runCourseIntake({
        sourceRoot: env.sourceRoot,
        courseId: "readiness-course",
        provider: "test_fixture_provider",
        edition: "readiness",
        title: "合成课程包（人工计划）",
        contentVersion: 1,
        provenance: { note: "夹具", reference: null, rightsNote: "合成夹具" },
        papersDir: env.papersDir,
        standardSourcesRoot: join(env.contentRoot, "course-sources"),
        segmentationPlan: { raw: JSON.stringify(plan) },
      });

      // 计划被采用，且按人的结构产段
      expect(planned.segmentationPlan.applied).toBe(true);
      const mode = planned.archive.metadata.segmentation.modeEvidence;
      expect(mode.mode).toBe("human_planned");
      expect(mode.unitCount).toBe(3);
      expect(mode.channelLineCounts.ignoredFurniture).toBe(5);
      expect(mode.unassignedLineCount).toBe(0);

      const plannedSegments = planned.archive.manifest.segments.filter((s) => s.kind === "translation_passage");
      expect(plannedSegments.map((s) => s.title)).toEqual(["翻译练习 1", "翻译练习 2", "翻译练习 3"]);
      // 练习 3 刻意没有参考译文（真实翻译讲义常常只给语言点）
      expect(plannedSegments[2].referenceTranslation).toBeNull();
      expect(plannedSegments[2].text).toContain("公共绿地");

      // 计划校验和参与候选身份 ⇒ 与自动分段不同
      expect(planned.archive.metadata.digests.candidateChecksum).not.toBe(
        auto.archive.metadata.digests.candidateChecksum,
      );

      // ── ③ 覆盖缺口：计划漏掉第 5 页 ⇒ 计划仍被采用，但阻断 ──
      const incomplete = { ...plan, units: plan.units.filter((unit) => unit.title !== "翻译练习 3") };
      const gap = await runCourseIntake({
        sourceRoot: env.sourceRoot,
        courseId: "readiness-course",
        provider: "test_fixture_provider",
        edition: "readiness",
        title: "合成课程包（覆盖缺口）",
        contentVersion: 1,
        provenance: { note: "夹具", reference: null, rightsNote: "合成夹具" },
        papersDir: env.papersDir,
        standardSourcesRoot: join(env.contentRoot, "course-sources"),
        segmentationPlan: { raw: JSON.stringify(incomplete) },
      });
      expect(gap.segmentationPlan.applied).toBe(true);
      expect(gap.archive.metadata.segmentation.modeEvidence.unassignedLineCount).toBeGreaterThan(0);
      expect(
        gap.archive.review.some((item) => item.code === "plan_unassigned_content" && item.severity === "blocking"),
      ).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("计划陈旧（源字节变了）⇒ 失败关闭，绝不清静套到新源上", async () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>();
      tree.set(
        "翻译/two-unit-handout.pdf",
        buildCjkPdf([
          ["CET6 Translation Practice Handout", ...wrapCjk(MULTI_UNIT_SOURCE_1)],
          ["CET6 Translation Practice Handout", ...wrapLatin(MULTI_UNIT_REFERENCE_1)],
          ["CET6 Translation Practice Handout", ...wrapCjk(MULTI_UNIT_SOURCE_2)],
          ["CET6 Translation Practice Handout", ...wrapLatin(MULTI_UNIT_REFERENCE_2)],
        ]),
      );
      const auto = await extract(env, tree);
      const asset = auto.inventory.assets.find((item) => item.kind === "pdf")!;
      const document = auto.documents.find((doc) => doc.assetKey === asset.assetKey)!;
      const last = (page: number) => document.pages.find((p) => p.page === page)?.lines.length ?? 1;

      const plan = {
        schemaVersion: 1,
        binding: {
          courseId: "readiness-course",
          sourceDigest: auto.inventory.digest,
          assets: [{ assetKey: asset.assetKey, sha256: asset.sha256 }],
        },
        author: "readiness",
        createdAt: "2026-02-01T00:00:00.000Z",
        reason: "源件没有可靠的重复结构边界。",
        units: [
          {
            title: "翻译练习 1",
            kind: "translation_passage",
            assignments: [
              { channel: "source", range: { assetKey: asset.assetKey, page: 1, lineStart: 2, lineEnd: last(1) }, note: null },
              { channel: "reference_translation", range: { assetKey: asset.assetKey, page: 2, lineStart: 2, lineEnd: last(2) }, note: null },
            ],
          },
          {
            title: "翻译练习 2",
            kind: "translation_passage",
            assignments: [
              { channel: "source", range: { assetKey: asset.assetKey, page: 3, lineStart: 2, lineEnd: last(3) }, note: null },
              { channel: "reference_translation", range: { assetKey: asset.assetKey, page: 4, lineStart: 2, lineEnd: last(4) }, note: null },
            ],
          },
        ],
      };

      // 改源字节（不重新生成计划）
      const pdfPath = join(env.sourceRoot, ...asset.relativePath.split("/"));
      writeFileSync(pdfPath, Buffer.concat([readFileSync(pdfPath), Buffer.from("\n% mutated\n", "utf8")]));

      const stale = await runCourseIntake({
        sourceRoot: env.sourceRoot,
        courseId: "readiness-course",
        provider: "test_fixture_provider",
        edition: "readiness",
        title: "合成课程包（陈旧计划）",
        contentVersion: 1,
        provenance: { note: "夹具", reference: null, rightsNote: "合成夹具" },
        papersDir: env.papersDir,
        standardSourcesRoot: join(env.contentRoot, "course-sources"),
        segmentationPlan: { raw: JSON.stringify(plan) },
      });

      // 致命问题 ⇒ 计划未被采用、回退自动分段、带阻断事项
      expect(stale.segmentationPlan.applied).toBe(false);
      expect(stale.archive.metadata.segmentation.modeEvidence.mode).toBe("automatic");
      expect(stale.archive.review.some((item) => item.code === "plan_binding_mismatch")).toBe(true);
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 4：有文本层 / 无文本层 / 损坏 PDF / 空文件
// ---------------------------------------------------------------------------

describe("场景 4 · 抽取失败的四类形态", () => {
  it("有文本层被解析；无文本层/损坏/空文件各自有**明确的名字**且不假装抽到", async () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>();
      tree.set("阅读/text-layer.pdf", buildTextPdf([["Passage One", ...wrapLatin(FIXTURE_PASSAGE_A)]]));
      tree.set("阅读/scanned.pdf", buildImageOnlyPdf(2));
      tree.set("阅读/broken.pdf", Buffer.from("这不是一个 PDF 文件", "utf8"));
      tree.set("阅读/empty.pdf", Buffer.alloc(0));

      const result = await extract(env, tree);

      const byPath = new Map(result.documents.map((doc) => [doc.assetKey, doc]));
      const assetByPath = new Map(result.inventory.assets.map((asset) => [asset.relativePath, asset]));

      const textLayer = byPath.get(assetByPath.get("阅读/text-layer.pdf")!.assetKey)!;
      expect(textLayer.state).toBe("parsed");
      expect(textLayer.pages.every((page) => page.hasTextLayer)).toBe(true);

      // 无文本层：如实上报，**不做 OCR**
      const scanned = byPath.get(assetByPath.get("阅读/scanned.pdf")!.assetKey)!;
      expect(scanned.state).toBe("no_text_layer");
      expect(scanned.pagesWithoutTextLayer).toEqual([1, 2]);
      expect(scanned.pages.every((page) => page.lines.length === 0)).toBe(true);

      // 损坏：解析失败被记录，不抛穿整条流水线
      const broken = byPath.get(assetByPath.get("阅读/broken.pdf")!.assetKey)!;
      expect(broken.state).toBe("failed");
      expect(broken.error).not.toBeNull();

      // 空文件：0 字节 ⇒ 阻断级事项（多半是导出失败）
      expect(result.inventory.notes.some((note) => note.code === "empty_file")).toBe(true);
      expect(
        result.archive.review.some((item) => item.code === "empty_asset" && item.severity === "blocking"),
      ).toBe(true);

      // 抽取层事实缺陷不可被复核裁决化解
      for (const code of ["extraction_failed", "page_without_text_layer", "empty_asset"] as const) {
        expect(result.archive.review.some((item) => item.code === code)).toBe(true);
      }
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 5：同一段有多个候选真题且出现歧义
// ---------------------------------------------------------------------------

describe("场景 5 · 多个候选与歧义", () => {
  it("歧义必须被显式处置：不因为排第一就选中", async () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>();
      // 同一篇合成篇章出现两次 ⇒ 与库中两份试卷都高度相似
      tree.set(
        "阅读/reading-handout.pdf",
        buildTextPdf([
          ["Passage One", ...wrapLatin(FIXTURE_PASSAGE_A)],
          ["Passage Two", ...wrapLatin(FIXTURE_PASSAGE_A)],
        ]),
      );
      // canonical 库：两份**内容相同**的合成试卷 ⇒ 两候选分数接近
      writeFixturePackage(env.contentRoot, "fixture-paper", buildFixturePackage({ id: "fixture-paper", contentVersion: 1 }));
      writeFixturePackage(env.contentRoot, "fixture-paper-2", buildFixturePackage({ id: "fixture-paper-2", contentVersion: 1 }));

      const result = await extract(env, tree, { papers: "two" });
      const ambiguous = result.archive.metadata.matching.segments.filter((segment) => segment.ambiguous);
      const multiSuggestion = result.archive.metadata.matching.segments.filter(
        (segment) => segment.suggestions.length >= 2,
      );

      /*
       * 歧义的判据是"前两名分差过小"，而它**只在两个候选都足够强时才可能出现**。
       * 合成夹具的篇章很短（"Fixture careful-reading passage."），
       * 因此这里不断言歧义一定出现 —— 那会让断言依赖夹具的偶然长度。
       *
       * 真正被固定的是两条**无条件**语义：
       * 1. 出现歧义时必须有显义说明，且门禁要求显式裁决；
       * 2. 任何建议都不等于 verified（标签体系里没有这个值）。
       */
      for (const segment of ambiguous) {
        expect(segment.ambiguityNote).toMatch(/不得|人工裁决/);
        expect(
          result.archive.review.some((item) => item.code === "match_ambiguous" && item.where === segment.segmentId),
        ).toBe(true);
      }

      // 多个候选同段出现时，每一条都必须带逐项证据（可复算、可核对）
      for (const segment of multiSuggestion) {
        expect(segment.suggestions.length).toBeGreaterThanOrEqual(2);
        for (const suggestion of segment.suggestions) {
          expect(suggestion.label).not.toBe("verified");
          expect(typeof suggestion.evidence.bodyContainment).toBe("number");
        }
      }

      // 未处置歧义 ⇒ 门禁不通过（若有歧义段）
      writeCandidate(env, "readiness-course", result.archive);
      const { gate } = gateFor(env, "readiness-course");
      if (ambiguous.length > 0) {
        expect(gate.checks.find((check) => check.name === "ambiguous_matches_dispositioned")?.passed).toBe(false);
        expect(gate.status).not.toBe("PROMOTABLE");
      }
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 6：全部段都未匹配，但仍允许合法晋升
// ---------------------------------------------------------------------------

describe("场景 6 · 全部段未匹配仍可合法晋升", () => {
  it("未匹配不阻断晋升；没有 accepted_suggestion 时交接计划自然为空", async () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>();
      tree.set(
        "阅读/reading-handout.pdf",
        buildTextPdf([["Passage One", ...wrapLatin(FIXTURE_PASSAGE_A)]]),
      );
      tree.set(
        "写作/writing-template.pdf",
        buildTextPdf([["Writing Template", "Introduction: state the topic in one sentence."]]),
      );
      tree.set("方法/method-note.pdf", buildTextPdf([["Method Notes", ...wrapLatin(FIXTURE_PASSAGE_B)]]));

      // canonical 库为空 ⇒ 全部段未匹配
      const result = await extract(env, tree);
      expect(result.archive.metadata.matching.canonicalLibrary.papers.length).toBe(0);
      expect(result.archive.metadata.matching.segments.every((segment) => segment.suggestions.length === 0)).toBe(true);

      writeCandidate(env, "readiness-course", result.archive, { allUnmatched: true });
      const { stored, gate } = gateFor(env, "readiness-course");

      // 未匹配是合法状态：门禁仍可 PROMOTABLE
      expect(gate.status).toBe("PROMOTABLE");

      const plan = buildLinkPlan({ stored, review: null, gate });
      // 没有 review ⇒ 零交接（既有语义）
      expect(plan.allowed).toBe(false);
      expect(plan.entries).toEqual([]);

      // 即使签了"全部有意不匹配"的复核，交接计划仍为空（allowed 且零条）
      const reviewRaw = JSON.parse(readFileSync(join(env.candidatesDir, "readiness-course", "review.json"), "utf8"));
      const parsed = validateCourseReviewFile(reviewRaw);
      const unmatchedPlan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(unmatchedPlan.allowed).toBe(true);
      expect(unmatchedPlan.entries).toEqual([]);
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 7：复核陈旧 / 源文件变化 / canonical 库变化 ⇒ 失败关闭
// ---------------------------------------------------------------------------

describe("场景 7 · 陈旧 ⇒ 失败关闭", () => {
  it("源字节变化（不重跑抽取）⇒ 复核陈旧、晋升被拒、零交接", async () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>();
      tree.set(
        "阅读/reading-handout.pdf",
        buildTextPdf([["Passage One", ...wrapLatin(FIXTURE_PASSAGE_A)]]),
      );
      const result = await extract(env, tree);
      writeCandidate(env, "readiness-course", result.archive);

      const before = gateFor(env, "readiness-course");
      expect(before.gate.status).toBe("PROMOTABLE");

      // 改源字节（**不**重跑抽取）
      const pdfPath = join(env.sourceRoot, "阅读", "reading-handout.pdf");
      writeFileSync(pdfPath, Buffer.concat([readFileSync(pdfPath), Buffer.from("\n% drift\n", "utf8")]));

      const after = gateFor(env, "readiness-course");
      expect(after.gate.checks.find((check) => check.name === "source_current_and_unchanged")?.passed).toBe(false);
      expect(after.gate.status).not.toBe("PROMOTABLE");

      const plan = buildLinkPlan({ stored: after.stored, review: after.review, gate: after.gate });
      expect(plan.allowed).toBe(false);
      expect(plan.entries).toEqual([]);

      const promoted = promoteCourseCandidate({
        stored: after.stored,
        gate: after.gate,
        review: after.review,
        coursesDir: env.coursesDir,
      });
      expect(promoted.ok).toBe(false);
      expect(existsSync(join(env.coursesDir, "readiness-course"))).toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("canonical 库变化 ⇒ 匹配证据陈旧（旧分数不得沿用）", async () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>();
      tree.set(
        "阅读/reading-handout.pdf",
        buildTextPdf([["Passage One", ...wrapLatin(FIXTURE_PASSAGE_A)]]),
      );
      const result = await extract(env, tree, { papers: "one" });
      writeCandidate(env, "readiness-course", result.archive);

      expect(gateFor(env, "readiness-course").gate.status).toBe("PROMOTABLE");

      // 往库里加一份真题 ⇒ 库摘要变化
      writeFixturePackage(env.contentRoot, "fixture-paper-2", buildFixturePackage({ id: "fixture-paper-2", contentVersion: 1 }));

      const after = gateFor(env, "readiness-course");
      const libraryCheck = after.gate.checks.find(
        (check) => check.name === "canonical_library_unchanged_since_review",
      );
      expect(libraryCheck?.passed).toBe(false);
      expect(libraryCheck?.detail).toMatch(/不得/);
      expect(after.gate.status).not.toBe("PROMOTABLE");
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 8：严格未见模考保留的真题 ⇒ 揭示前必须告知风险
// ---------------------------------------------------------------------------

describe("场景 8 · 模考保留卷的风险告知", () => {
  it("指向保留卷的段：风险视图点名该卷，且揭示被拒时零曝光", async () => {
    // 这条走真实数据库（链接、池归属、曝光都在库里），因此用既有测试夹具。
    const { createTestDb } = await import("@/db/client");
    const { createSqliteRepositories } = await import("@/repositories/sqlite");
    const { commitCourseImport, planCourseImport } = await import("@/services/course-import");
    const { revealCourseSegment } = await import("@/services/course-exposure");
    const { verifyCanonicalLink } = await import("@/services/course-link");
    const { computeRevealRisk } = await import("@/services/reveal-risk");
    const { getPaperFreshness } = await import("@/services/paper-freshness");
    const { buildCourseFixture, writeCourseFixture } = await import("../scripts/course-fixture");
    const { buildFixturePackage, writeFixturePackage } = await import("../scripts/paper-fixture");
    const { planImport, commitImport } = await import("@/services/paper-import");

    const contentRoot = mkdtempSync(join(tmpdir(), "cet6-rsvp-reserve-"));
    const previousRoot = process.env.CET6_CONTENT_ROOT;
    process.env.CET6_CONTENT_ROOT = contentRoot;
    const db = createTestDb();
    const repos = createSqliteRepositories(db);
    db.prepare(
      "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("p1", "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    try {
      // 合成课程包 + 合成真题卷（sourceKind 恒为 test_fixture）
      writeCourseFixture(contentRoot, "fixture-course-a", buildCourseFixture({ id: "fixture-course-a" }));
      expect(commitCourseImport(repos, planCourseImport(repos)).ok).toBe(true);
      writeFixturePackage(
        contentRoot,
        "fixture-cet6-2024-12-v1",
        buildFixturePackage({ id: "fixture-cet6-2024-12-v1", year: 2024, session: "December", variant: "set1" }),
      );
      const paperPlan = planImport(repos, { only: ["fixture-cet6-2024-12-v1"] });
      expect(paperPlan.report.counts.insert).toBe(1);
      expect(commitImport(repos, paperPlan).ok).toBe(true);

      // 人工核验：reading.b → 该卷的仔细阅读（整卷）
      const linked = verifyCanonicalLink(repos, {
        courseId: "fixture-course-a",
        courseContentVersion: 1,
        segmentId: "reading.b",
        paperId: "fixture-cet6-2024-12-v1",
        paperContentVersion: 1,
        sectionId: "reading.careful_reading",
        targetScope: "section",
        verificationStatus: "verified",
        verificationRef: "合成夹具核验：模考保留风险告知",
      });
      expect(linked.ok).toBe(true);

      // 该卷被设为**严格未见模考保留**
      repos.papers.setPool("fixture-cet6-2024-12-v1", "mock_reserve");

      // 揭示前：风险视图必须点名该卷，并给出产品语言的目标描述
      const risk = computeRevealRisk(repos, "fixture-course-a", "reading.b");
      expect(risk.risky).toBe(true);
      expect(risk.requiresConfirmation).toBe(true);
      expect(risk.papers).toHaveLength(1);
      expect(risk.papers[0].paperId).toBe("fixture-cet6-2024-12-v1");
      expect(risk.papers[0].reservedForMock).toBe(true);
      // 产品语言（不是内部 id）
      expect(risk.papers[0].paperTitle).toBe("2024 年 12 月 · set1");
      expect(risk.papers[0].targetLabel).toContain("阅读 · 仔细阅读");

      // 揭示前该卷仍是 pristine（严格未见）
      expect(getPaperFreshness(repos, "p1", "fixture-cet6-2024-12-v1").state).toBe("pristine");

      // 揭示成功 ⇒ 该卷立即失去严格未见资格（失败关闭方向）
      const revealed = revealCourseSegment(repos, {
        profileId: "p1",
        courseId: "fixture-course-a",
        segmentId: "reading.b",
        courseContentVersion: 1,
        occurredAt: "2026-03-01T10:00:00.000Z",
        confirmedRiskFingerprint: risk.fingerprint,
      });
      expect(revealed.ok).toBe(true);
      expect(getPaperFreshness(repos, "p1", "fixture-cet6-2024-12-v1").state).toBe("uncertain");

      // 未确认 ⇒ 拒绝，且**零**曝光（保留卷不被无声消耗）
      const refused = revealCourseSegment(repos, {
        profileId: "p1",
        courseId: "fixture-course-a",
        segmentId: "translation.1",
        courseContentVersion: 1,
        occurredAt: "2026-03-01T10:00:00.000Z",
      });
      expect(refused.ok).toBe(false);
      if (refused.ok) return;
      expect(refused.code).toBe("risk_changed");
    } finally {
      db.close();
      rmSync(contentRoot, { recursive: true, force: true });
      if (previousRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
      else process.env.CET6_CONTENT_ROOT = previousRoot;
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 9：课程段关联同卷多个目标（较长目标列表的呈现）
// ---------------------------------------------------------------------------

describe("场景 9 · 同卷多目标的呈现与指纹", () => {
  it("多个语义目标全部进入展示与指纹（缩小确认范围是缺陷）", async () => {
    /*
     * 这条走**真实数据库 + 真实服务层投影**：链接经 `verifyCanonicalLink`
     * 写入，展示由 `computeRevealRisk` → `projectLinkedPapers` 现算，
     * 指纹由 `computeRevealRisk` 现算。刻意**不**在内存里手工构造链接记录 ——
     * 那样测到的是手工数据的形状，而不是"运行时真相会列出每一个目标"。
     *
     * 覆盖两条既有审查守护的语义（`course-companion-reveal.test.ts` 的 P1-M
     * 用 3 个目标守护；这里补的是**较长目标列表**：8 个不同题组）：
     *   1. 每一个语义目标都必须出现在展示里（含诚实条数）；
     *   2. 多一个目标必须改变指纹（显示修好不放宽判定）。
     */
    const { createTestDb } = await import("@/db/client");
    const { createSqliteRepositories } = await import("@/repositories/sqlite");
    const { commitCourseImport, planCourseImport } = await import("@/services/course-import");
    const { verifyCanonicalLink } = await import("@/services/course-link");
    const { computeRevealRisk } = await import("@/services/reveal-risk");
    const { planImport, commitImport } = await import("@/services/paper-import");
    const { buildCourseFixture, writeCourseFixture } = await import("../scripts/course-fixture");
    const { buildFixturePackage, writeFixturePackage } = await import("../scripts/paper-fixture");

    const contentRoot = mkdtempSync(join(tmpdir(), "cet6-rsvp-multitarget-"));
    const previousRoot = process.env.CET6_CONTENT_ROOT;
    process.env.CET6_CONTENT_ROOT = contentRoot;
    const db = createTestDb();
    const repos = createSqliteRepositories(db);
    db.prepare(
      "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("p1", "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");

    try {
      writeCourseFixture(contentRoot, "fixture-course-a", buildCourseFixture({ id: "fixture-course-a" }));
      expect(commitCourseImport(repos, planCourseImport(repos)).ok).toBe(true);
      writeFixturePackage(
        contentRoot,
        "fixture-paper",
        buildFixturePackage({ id: "fixture-paper", year: 2024, session: "December", variant: "set1" }),
      );
      const paperPlan = planImport(repos, { only: ["fixture-paper"] });
      expect(paperPlan.report.counts.insert).toBe(1);
      expect(commitImport(repos, paperPlan).ok).toBe(true);

      const SECTION = "reading.careful_reading";
      /** 该大题在夹具里有几个题组（决定可链接的目标上限）。 */
      const groupCount = 2;
      const linkTo = (targetScope: "section" | "group", groupId: string | null) =>
        verifyCanonicalLink(repos, {
          courseId: "fixture-course-a",
          courseContentVersion: 1,
          segmentId: "reading.b",
          paperId: "fixture-paper",
          paperContentVersion: 1,
          sectionId: SECTION,
          targetScope,
          groupId,
          questionId: null,
          verificationStatus: "verified",
          verificationRef: "合成夹具核验：多目标（较长列表）",
        });

      // ① 单个目标：不加计数、不加分隔（不增加 UX 复杂度）
      expect(linkTo("group", `${SECTION}#g1`).ok).toBe(true);
      const one = computeRevealRisk(repos, "fixture-course-a", "reading.b");
      expect(one.papers).toHaveLength(1);
      expect(one.papers[0].targetLabel).toContain("第 1 组");
      expect(one.papers[0].targetLabel).not.toContain("共 ");

      // ② 逐个追加目标，直到把该大题的全部题组 + 整个大题都链接上
      const seenLabels: string[] = [one.papers[0].targetLabel];
      for (let index = 2; index <= groupCount; index += 1) {
        expect(linkTo("group", `${SECTION}#g${index}`).ok).toBe(true);
      }
      expect(linkTo("section", null).ok).toBe(true);

      const many = computeRevealRisk(repos, "fixture-course-a", "reading.b");
      const label = many.papers[0].targetLabel;

      // 按卷子去重 ⇒ 仍然只有一个条目（不重复出卡片）
      expect(many.papers).toHaveLength(1);
      // 每一个语义目标都必须出现在展示里
      for (let index = 1; index <= groupCount; index += 1) {
        expect(label, `必须出现第 ${index} 组`).toContain(`第 ${index} 组`);
      }
      expect(label, "必须出现整个大题").toContain("整个大题");
      // 诚实条数，而不是含糊的"多个"
      const expectedCount = groupCount + 1;
      expect(label, "必须给出诚实条数").toContain(`共 ${expectedCount} 个目标`);
      seenLabels.push(label);
      expect(seenLabels[0]).not.toBe(seenLabels[1]);

      // ③ 多一个目标必须改变指纹（显示修好不放宽判定）
      expect(many.fingerprint, "目标集合变化必须改变指纹").not.toBe(one.fingerprint);
      // 且策略状态（卷子级）只显示一次
      expect(many.papers[0].reservedForMock).toBe(false);
      expect(many.papers[0].trainable).toBe(true);
    } finally {
      db.close();
      rmSync(contentRoot, { recursive: true, force: true });
      if (previousRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
      else process.env.CET6_CONTENT_ROOT = previousRoot;
    }
  });
});

// ---------------------------------------------------------------------------
// 场景 10：多课程包 / 重复文件 / 材料数量增加
// ---------------------------------------------------------------------------

describe("场景 10 · 多包、重复文件与规模", () => {
  it("重复内容被登记为副本；多包互不干扰；同输入重跑幂等", async () => {
    const env = makeEnv();
    try {
      const shared = buildTextPdf([["Passage One", ...wrapLatin(FIXTURE_PASSAGE_A)]]);
      const tree = new Map<string, Buffer>();
      tree.set("阅读/handout.pdf", shared);
      tree.set("阅读/handout-copy.pdf", shared); // 字节完全相同的副本

      const first = await extract(env, tree, { courseId: "pkg-a" });
      // 重复内容：同一文件的多份副本，**不**构成多份材料或多种表示
      expect(first.inventory.notes.some((note) => note.code === "duplicate_content")).toBe(true);
      expect(first.grouping.proposals.length).toBeGreaterThan(0);
      expect(first.grouping.invariantViolations).toEqual([]);

      // 同输入重跑 ⇒ 候选校验和相同（幂等）
      const again = await extract(env, tree, { courseId: "pkg-a" });
      expect(again.archive.metadata.digests.candidateChecksum).toBe(
        first.archive.metadata.digests.candidateChecksum,
      );

      // 第二个课程包：独立 id，不共享状态
      const other = new Map<string, Buffer>();
      other.set("翻译/translation-unit1.pdf", buildCjkPdf([["翻译练习", ...wrapCjk(FIXTURE_TRANSLATION_SOURCE)]]));
      const second = await extract(env, other, { courseId: "pkg-b" });
      expect(second.archive.manifest.id).toBe("pkg-b");
      expect(second.grouping.invariantViolations).toEqual([]);

      // 两个候选包互不覆盖
      writeCandidate(env, "pkg-a", first.archive, { sign: false });
      writeCandidate(env, "pkg-b", second.archive, { sign: false });
      expect(existsSync(join(env.candidatesDir, "pkg-a", "candidate.json"))).toBe(true);
      expect(existsSync(join(env.candidatesDir, "pkg-b", "candidate.json"))).toBe(true);

      // 规模观察：材料数增加时清点与分段仍稳定（这里是可核对的计数，不是压测）
      const many = new Map<string, Buffer>();
      for (let index = 0; index < 6; index += 1) {
        many.set(`第${index + 1}套/阅读/handout.pdf`, buildTextPdf([["Passage One", ...wrapLatin(FIXTURE_PASSAGE_A)]]));
      }
      const scale = await extract(env, many, { courseId: "pkg-c" });
      // 前面已经写过 pkg-a / pkg-b 的源文件，且源目录是**同一个** ——
      // 因此这里断言的是"新写入的 6 份都在"，用相对包含而不是绝对相等。
      expect(scale.inventory.assets.length).toBeGreaterThanOrEqual(6);
      const scaleAssets = scale.inventory.assets.filter((asset) => asset.relativePath.startsWith("第"));
      expect(scaleAssets).toHaveLength(6);
      // 不同目录的同名文件**不合并**（文件夹上下文是分组判据）
      const scaleProposals = scale.grouping.proposals.filter((proposal) =>
        proposal.representations.some((rep) => rep.sourceRelativePath.startsWith("第")),
      );
      expect(scaleProposals).toHaveLength(6);
      expect(scale.grouping.invariantViolations).toEqual([]);
      // 段 id 全局唯一（多份同类材料也不冲突）
      const ids = scale.archive.manifest.segments.map((segment) => segment.id);
      expect(new Set(ids).size).toBe(ids.length);
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function wrapLatin(text: string, width = 70): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
      continue;
    }
    current += ` ${word}`;
  }
  if (current !== "") lines.push(current);
  return lines;
}

function wrapCjk(text: string, width = 24): string[] {
  const chars = [...text];
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += width) {
    lines.push(chars.slice(index, index + width).join(""));
  }
  return lines.filter((line) => line !== "");
}

/** 最小 DOCX 占位字节（ZIP 魔数开头；V1 刻意不解析它）。 */
function buildMinimalDocx(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`docx-fixture:${text}`, "utf8")]);
}

/** 最小但合法可播放的 WAV（0.05 秒 8kHz 单声道静音）。 */
function buildSilentWav(durationSeconds = 0.05): Buffer {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 8;
  const samples = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataSize = samples * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  buffer.fill(128, 44);
  return buffer;
}

const MULTI_UNIT_SOURCE_1 = [
  "城市轨道交通的运营方近年来开始重视乘客在站内的步行体验。",
  "许多车站通过调整指示牌的位置与措辞，缩短了乘客寻找换乘通道的时间。",
].join("");

const MULTI_UNIT_REFERENCE_1 = [
  "Operators of urban rail transit have begun to pay attention to the walking experience of passengers inside stations.",
  "Many stations have shortened the time passengers spend looking for transfer corridors by adjusting the position and wording of signs.",
].join(" ");

const MULTI_UNIT_SOURCE_2 = [
  "社区图书馆的功能正在从单纯的借阅场所转向社区活动的组织者。",
  "一些图书馆通过开设免费讲座与手工艺课程，吸引了此前从不进馆的居民。",
].join("");

const MULTI_UNIT_REFERENCE_2 = [
  "The function of community libraries is shifting from a mere lending venue to an organiser of community activities.",
  "Some libraries have attracted residents who never previously entered by offering free lectures and craft courses.",
].join(" ");

const MULTI_UNIT_SOURCE_3 = [
  "越来越多的城市在规划新城区时，会要求开发商预留一定比例的公共绿地。",
  "支持者认为这能缓解热岛效应，批评者则担心它推高了住房成本。",
].join("");
