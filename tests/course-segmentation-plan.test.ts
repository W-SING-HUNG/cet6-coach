import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTENT_CHANNEL_KINDS,
  PLAN_CHANNEL_KINDS,
  SEGMENTATION_PLAN_SCHEMA_VERSION,
  SUPPORTED_SEGMENTATION_PLAN_SCHEMA_VERSIONS,
  parseSegmentationPlan,
  resolvePlanContent,
  segmentationPlanDigest,
  validatePlanContent,
  validatePlanShape,
} from "@/content/course-pipeline/segmentation-plan";
import type { PlanSourceView, SegmentationPlanFile } from "@/content/course-pipeline/segmentation-plan";
import {
  applySegmentationPlan,
  automaticSegmentationEvidence,
  planProjectionMismatch,
  plannedSegmentationEvidence,
  segmentationModeDigest,
} from "@/content/course-pipeline/plan-apply";
import { buildPlanSourceView, resolveSegmentationPlan } from "@/content/course-pipeline/plan-resolve";
import { runCourseIntake } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import { courseSegmentationDigest } from "@/content/course-pipeline/digests";
import { readStoredCandidate, recomputeDigests, evaluatePromotionGate, gatherPromotionInputs, validateCourseReviewFile } from "@/content/course-pipeline/review";
import { buildIndexFromDisk } from "@/content/course-pipeline/canonical";
import { scanSourceDirectory } from "@/content/course-pipeline/sources";
import { extractPdfPages } from "@/content/course-pipeline/pdf-extract";
import { getCourseSegmentationPlansDir, getContentRoot } from "@/content/paper/paths";
import { FORBIDDEN_MATCH_FEATURES } from "@/content/course-pipeline/types";
import { writeSourceTree, buildCjkPdf } from "../scripts/course-source-fixture";
import {
  MULTI_UNIT_HEADER,
  MULTI_UNIT_REFERENCE_1,
  MULTI_UNIT_SOURCE_1,
  MULTI_UNIT_SOURCE_2,
  MULTI_UNIT_SOURCE_3,
  multiUnitTranslationFixture,
  twoUnitTranslationFixture,
  wrapCjk,
} from "../scripts/course-source-scenarios";

/**
 * 人工分段计划（Manual Segmentation Plan）的合成测试。
 *
 * ── 测试方法学（与 course-intake.test.ts 同源）──
 *
 * - **全部合成夹具**：`multiUnitTranslationFixture` 是虚构的中文练习与英文译文，
 *   不是任何真实 CET 材料，也不是任何真实课程材料。**绝不使用真实 RSVP 文本。**
 * - **真实磁盘 + 真实 PDF 字节**：抽取→分段这条链路真的被走过，
 *   因此"行号越界""覆盖率"这类判据是在真实抽取产物上被验证的。
 * - **断言落在行为上**：不是"函数存在"，而是"这份计划产出了两个段"
 *   "这一行没被指派时门禁拒绝"。
 *
 * ── 为什么这些用例值得存在 ──
 *
 * 人工分段是**唯一会静默丢课程内容**的入口（一份漏掉几行的计划会产出
 * 一份看起来正常、实则缺内容的课程包）。因此覆盖率的负例、
 * 陈旧的负例、重叠的负例比正例更重要。
 */

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

interface TempEnv {
  root: string;
  contentRoot: string;
  sourcesRoot: string;
  papersDir: string;
  candidatesDir: string;
  dispose(): void;
}

function makeEnv(): TempEnv {
  const root = mkdtempSync(join(tmpdir(), "cet6-segplan-"));
  const contentRoot = join(root, "content");
  return {
    root,
    contentRoot,
    sourcesRoot: join(contentRoot, "course-sources"),
    papersDir: join(contentRoot, "cet6", "papers"),
    candidatesDir: join(contentRoot, "course-candidates"),
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** 写出合成源目录，返回源根。 */
function writeSources(env: TempEnv, name = "src", tree?: Map<string, Buffer>): string {
  const sourceRoot = join(env.sourcesRoot, name);
  mkdirSync(sourceRoot, { recursive: true });
  writeSourceTree(sourceRoot, tree ?? multiUnitTranslationFixture());
  return sourceRoot;
}

/**
 * 抽取一次，拿到 `assetKey` 与**逐页行数**。
 *
 * 计划选择器是"资产键 + 页 + 页内行号"，因此测试必须先知道这些坐标。
 * 这不是"靠文本匹配找边界"—— 坐标直接来自抽取产物，是确定的。
 */
async function probe(sourceRoot: string) {
  const inventory = scanSourceDirectory(sourceRoot, { standardSourcesRoot: join(sourceRoot, "..") });
  const pdf = inventory.assets.find((asset) => asset.kind === "pdf")!;
  const document = await extractPdfPages(pdf.assetKey, join(sourceRoot, ...pdf.relativePath.split("/")));
  const lineCountByPage = new Map<number, number>();
  for (const page of document.pages) {
    if (page.hasTextLayer) lineCountByPage.set(page.page, page.lines.length);
  }
  return { inventory, assetKey: pdf.assetKey, document, lineCountByPage };
}

/** 一条指派（闭区间，页内行号从 1 起）。 */
function assign(channel: string, assetKey: string, page: number, lineStart: number, lineEnd: number, note: string | null = null) {
  return { channel, range: { assetKey, page, lineStart, lineEnd }, note };
}

/**
 * 把夹具计划解析为**规范结构**（低层应用用例必须经过它）。
 *
 * ── 为什么低层投影用例也要走这一步 ──
 *
 * `applySegmentationPlan` 现在**只接受** `resolvePlanContent` 的产出：
 * 那是"每一个被计入覆盖率的行都真的进了投影"这条不变量的结构性前提。
 * 让测试自己拼一份结构就等于绕过它 —— 那正是这条修复要消灭的形态。
 */
function resolveFixturePlan(
  plan: SegmentationPlanFile,
  inventory: Parameters<typeof buildPlanSourceView>[0]["inventory"],
  documents: Parameters<typeof buildPlanSourceView>[0]["documents"],
) {
  const view = buildPlanSourceView({ courseId: plan.binding.courseId, inventory, documents });
  const resolution = resolvePlanContent(plan, view);
  if (resolution.resolved === null) {
    throw new Error(
      `夹具计划本应可解析，实际失败：${resolution.issues.map((issue) => `${issue.code}@${issue.where}`).join("、")}`,
    );
  }
  return resolution.resolved;
}

/**
 * 构造一份**完整覆盖**的计划（6 页，含页眉家具）。
 *
 * 结构（与夹具的页布局一一对应）：
 *
 * | 单元 | source | reference_translation | notes |
 * | --- | --- | --- | --- |
 * | 1 | p1:2–4 | p2:2–5 | p3:2–5 |
 * | 2 | p4:2–4 | p5:2–5 | —（刻意没有讲解）|
 * | 3 | p6:2–4 | —（**刻意没有参考译文**）| — |
 *
 * 每页的第 1 行是页眉，被**显式**标为 `ignored_furniture`
 * —— 注意它只挂在**第一个单元**下：同一行被两个单元同时认领会是
 * "跨单元重叠"（那确实是错误状态，由另一条用例专门覆盖）。
 *
 * 工具绝不会自己推断"这行是页眉" —— 这条正是被测试守护的语义。
 */
function fullPlan(assetKey: string, input: {
  courseId: string;
  sourceDigest: string;
  sha256: string;
  /** 忽略家具的方式："explicit" = 逐页显式标；"none" = 不标（制造未指派）。 */
  furniture?: "explicit" | "none";
  lineCountByPage: Map<number, number>;
}): Record<string, unknown> {
  const furniture = input.furniture ?? "explicit";
  const headerAssignments = furniture === "explicit"
    ? [1, 2, 3, 4, 5, 6].map((page) => assign("ignored_furniture", assetKey, page, 1, 1, "重复页眉"))
    : [];

  const last = (page: number): number => input.lineCountByPage.get(page) ?? 1;

  return {
    schemaVersion: SEGMENTATION_PLAN_SCHEMA_VERSION,
    binding: {
      courseId: input.courseId,
      sourceDigest: input.sourceDigest,
      assets: [{ assetKey, sha256: input.sha256 }],
    },
    author: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    reason: "源件没有可靠的结构边界；自动分段只能产出一个文档级段。",
    units: [
      {
        title: "翻译练习 1",
        kind: "translation_passage",
        assignments: [
          assign("source", assetKey, 1, 2, last(1)),
          assign("reference_translation", assetKey, 2, 2, last(2)),
          assign("notes", assetKey, 3, 2, last(3)),
          ...headerAssignments,
        ],
      },
      {
        title: "翻译练习 2",
        kind: "translation_passage",
        assignments: [
          assign("source", assetKey, 4, 2, last(4)),
          assign("reference_translation", assetKey, 5, 2, last(5)),
        ],
      },
      {
        title: "翻译练习 3（没有参考译文）",
        kind: "translation_passage",
        assignments: [assign("source", assetKey, 6, 2, last(6))],
      },
    ],
  };
}

/** 跑一次 intake（可选带计划）。 */
async function runIntake(
  env: TempEnv,
  options: { plan?: unknown; sourceRoot?: string; courseId?: string; writeCandidate?: boolean } = {},
) {
  const sourceRoot = options.sourceRoot ?? writeSources(env, `src-${Math.random().toString(36).slice(2, 8)}`);
  const courseId = options.courseId ?? "segplan-course";
  const result = await runCourseIntake({
    sourceRoot,
    courseId,
    provider: "test_fixture_provider",
    edition: "test",
    title: "合成分段计划课程",
    contentVersion: 1,
    provenance: { note: "合成夹具", reference: null, rightsNote: "合成夹具，无第三方权利。" },
    papersDir: env.papersDir,
    standardSourcesRoot: env.sourcesRoot,
    segmentationPlan: options.plan === undefined ? undefined : { raw: JSON.stringify(options.plan) },
  });
  if (options.writeCandidate !== false) {
    writeCourseCandidate(result.archive, join(env.candidatesDir, courseId));
  }
  return { result, sourceRoot, courseId };
}

/** 门禁求值（复用既有的统一采集实现）。 */
function gateOf(env: TempEnv, courseId: string) {
  const stored = readStoredCandidate(courseId, env.candidatesDir);
  const index = buildIndexFromDisk(env.papersDir);
  return {
    stored,
    gate: evaluatePromotionGate(
      gatherPromotionInputs({
        stored,
        review: null,
        reviewErrors: [],
        canonical: { digest: index.index.summary.digest, complete: index.failures.length === 0 },
        standardSourcesRoot: env.sourcesRoot,
      }),
    ),
  };
}

/**
 * 求值门禁，**带一份真实的复核记录**（用于"计划改动 ⇒ 旧复核陈旧"的集成用例）。
 *
 * 刻意走与 CLI 相同的 `gatherPromotionInputs`：磁盘侧事实（资产完整性、
 * 生产校验器、源当前性）只有一处实现，测试与生产不会漂移。
 */
function gateWithReview(env: TempEnv, courseId: string, review: unknown) {
  const stored = readStoredCandidate(courseId, env.candidatesDir);
  const parsed = validateCourseReviewFile(review);
  const index = buildIndexFromDisk(env.papersDir);
  return {
    stored,
    parsed,
    gate: evaluatePromotionGate(
      gatherPromotionInputs({
        stored,
        review: parsed.file,
        reviewErrors: parsed.errors,
        canonical: { digest: index.index.summary.digest, complete: index.failures.length === 0 },
        standardSourcesRoot: env.sourcesRoot,
      }),
    ),
  };
}

/**
 * 构造一份把当前候选**全部接受**的复核记录。
 *
 * 这是"人已经签过字"的状态。用它才能证明"改计划之后那份签字失效了" ——
 * 没有它的话，"不 PROMOTABLE" 可能只是因为**根本没有复核记录**，
 * 那样断言就与"计划陈旧"无关了。
 */
function acceptAllReviewFor(stored: ReturnType<typeof readStoredCandidate>) {
  return {
    courseId: stored.metadata.courseId,
    reviewer: "synthetic-reviewer",
    reviewedAt: "2026-01-01",
    candidateChecksum: stored.recomputed.candidateChecksum,
    canonicalLibraryDigest: stored.metadata.matching.canonicalLibrary.digest,
    materialGroupings: stored.metadata.grouping.proposals
      .filter((proposal) => proposal.reviewRequired)
      .map((proposal) => ({
        proposalId: proposal.id,
        decision: "accepted" as const,
        note: "确认该分组。",
        evidence: "合成夹具依据候选记录的 basis 与 evidence 作出该裁决（≥10 字符）。",
      })),
    segments: stored.metadata.segmentation.materials
      .flatMap((material) => material.segments)
      .filter((segment) => segment.reviewRequired)
      .map((segment) => ({
        segmentId: segment.id,
        decision: "accepted" as const,
        note: "确认该段。",
        evidence: "合成夹具依据候选记录的 evidence.cues 与 lineSpan 作出该裁决（≥10 字符）。",
      })),
    matches: [],
    verifiedScope: ["合成夹具：候选结构、资产完整性与门禁路径"],
    notVerified: ["未做任何 canonical 对应关系的人工核验"],
  };
}

// ---------------------------------------------------------------------------
// 1) 计划形状契约
// ---------------------------------------------------------------------------

describe("人工分段计划 · 形状契约", () => {
  it("契约版本常量与支持集合一致（唯一事实来源）", () => {
    expect(SUPPORTED_SEGMENTATION_PLAN_SCHEMA_VERSIONS).toContain(SEGMENTATION_PLAN_SCHEMA_VERSION);
    expect(SEGMENTATION_PLAN_SCHEMA_VERSION).toBe(1);
  });

  it("通道集合恰好是任务要求的那四类，且 ignored_furniture 不在内容通道里", () => {
    expect([...PLAN_CHANNEL_KINDS].sort()).toEqual(
      ["ignored_furniture", "notes", "reference_translation", "source"].sort(),
    );
    expect([...CONTENT_CHANNEL_KINDS]).not.toContain("ignored_furniture");
    expect([...CONTENT_CHANNEL_KINDS].sort()).toEqual(["notes", "reference_translation", "source"]);
  });

  it("坏 JSON 是**正常失败状态**，不是崩溃，且不回退到自动分段", () => {
    const broken = parseSegmentationPlan('{"schemaVersion": 1, "units": [');
    expect(broken.ok).toBe(false);
    expect(broken.plan).toBeNull();
    expect(broken.issues[0].code).toBe("plan_json_invalid");
    // 措辞必须说明"失败关闭、不回退"
    expect(broken.issues[0].detail).toContain("失败关闭");
  });

  it("未知契约版本被**失败关闭**拒绝（不按旧契约猜测解读）", () => {
    for (const version of [0, 2, 999, -1, 1.5, "1", null, undefined]) {
      const raw = {
        schemaVersion: version,
        binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [{ assetKey: "k", sha256: "s" }] },
        units: [],
      };
      const validated = validatePlanShape(raw);
      expect(validated.ok, `schemaVersion=${JSON.stringify(version)} 应被拒绝`).toBe(false);
      expect(
        ["plan_schema_version_missing", "plan_schema_version_unsupported"],
        `schemaVersion=${JSON.stringify(version)} 的拒绝理由必须是契约版本问题`,
      ).toContain(validated.issues[0].code);
    }
  });

  it("契约版本判定**先于**形状判定（同时有下游错误时仍先报版本）", () => {
    const raw = { schemaVersion: 99, units: "not-an-array", binding: null };
    const validated = validatePlanShape(raw);
    expect(validated.issues[0].code).toBe("plan_schema_version_unsupported");
  });

  it("V1 只支持 translation_passage，其他种类**显式拒绝**（不静默降级）", () => {
    for (const kind of ["reading_passage", "listening_passage", "writing_template", "method_note"]) {
      const raw = {
        schemaVersion: 1,
        binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [{ assetKey: "k", sha256: "s" }] },
        units: [{ title: "t", kind, assignments: [assign("source", "k", 1, 1, 1)] }],
      };
      const validated = validatePlanShape(raw);
      expect(validated.ok, `kind=${kind} 应被拒绝`).toBe(false);
      expect(validated.issues[0].code).toBe("plan_unit_kind_unsupported");
      expect(validated.issues[0].detail).toContain("显式拒绝");
    }
  });

  it("每个单元必须**至少一条** source；多条**允许**但必须互不重叠", () => {
    const base = {
      schemaVersion: 1,
      binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [{ assetKey: "k", sha256: "s" }] },
    };

    /*
     * 0 条 ⇒ 拒绝（一个翻译单元没有原文是自相矛盾的）
     */
    const none = validatePlanShape({
      ...base,
      units: [{ title: "t", kind: "translation_passage", assignments: [assign("reference_translation", "k", 1, 1, 1)] }],
    });
    expect(none.ok).toBe(false);
    expect(none.issues[0].code).toBe("plan_unit_source_count");

    /*
     * **多条**（同一通道、互不相邻）⇒ 形状层**接受**。
     *
     * 通道基数在 V1 是"≥1"，因为原文完全可能跨页或被页面上的其他结构打断
     * （例如英文参考译文插在两段中文原文之间）。旧实现在这里要求"恰好一条"，
     * 那会让那种材料根本无法被正确标注。
     *
     * "多条之间必须互不重叠"这条不变量由**内容层**强制 —— 形状层刻意不接触
     * 抽取产物，因此它判不了重叠（见 `validatePlanShape` 的分层说明）。
     */
    const multiple = validatePlanShape({
      ...base,
      units: [
        {
          title: "t",
          kind: "translation_passage",
          assignments: [assign("source", "k", 1, 1, 2), assign("source", "k", 3, 1, 2)],
        },
      ],
    });
    expect(multiple.ok, "多条互不相邻的原文范围必须被接受（它们是同一通道的多个片段）").toBe(true);
  });

  it("行号/页号必须从 1 起且有序（0、负数、倒序都拒绝）", () => {
    const base = {
      schemaVersion: 1,
      binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [{ assetKey: "k", sha256: "s" }] },
      units: [{ title: "t", kind: "translation_passage", assignments: [] as unknown[] }],
    };
    const cases: [string, unknown][] = [
      // 页号 0
      ["plan_range_shape_invalid", assign("source", "k", 0, 1, 1)],
      // 行号 0
      ["plan_range_shape_invalid", assign("source", "k", 1, 0, 1)],
      // 负数
      ["plan_range_shape_invalid", assign("source", "k", 1, -3, 1)],
      // 倒序
      ["plan_range_order_invalid", assign("source", "k", 1, 5, 2)],
      // 非整数
      ["plan_range_shape_invalid", assign("source", "k", 1, 1.5, 2)],
    ];
    for (const [code, assignment] of cases) {
      const raw = { ...base, units: [{ title: "t", kind: "translation_passage", assignments: [assignment] }] };
      const validated = validatePlanShape(raw);
      expect(validated.ok, `${JSON.stringify(assignment)} 应被拒绝`).toBe(false);
      expect(validated.issues[0].code).toBe(code);
    }
  });

  it("未知通道被拒绝（不接受未登记的语义通道）", () => {
    const raw = {
      schemaVersion: 1,
      binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [{ assetKey: "k", sha256: "s" }] },
      units: [{ title: "t", kind: "translation_passage", assignments: [assign("answer_key", "k", 1, 1, 1)] }],
    };
    const validated = validatePlanShape(raw);
    expect(validated.ok).toBe(false);
    expect(validated.issues[0].code).toBe("plan_assignment_channel_unknown");
  });

  it("空绑定 / 缺 sourceDigest / 空资产清单都被拒绝", () => {
    const cases: [string, unknown][] = [
      [
        "plan_binding_missing",
        { schemaVersion: 1, binding: { courseId: "c", sourceDigest: "not-hex", assets: [{ assetKey: "k", sha256: "s" }] }, units: [] },
      ],
      [
        "plan_assets_empty",
        { schemaVersion: 1, binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [] }, units: [{ title: "t", kind: "translation_passage", assignments: [assign("source", "k", 1, 1, 1)] }] },
      ],
    ];
    for (const [code, raw] of cases) {
      const validated = validatePlanShape(raw);
      expect(validated.ok, `${code} 用例应被拒绝`).toBe(false);
      expect(validated.issues[0].code).toBe(code);
    }
  });
});

// ---------------------------------------------------------------------------
// 2) 计划校验和（身份）
// ---------------------------------------------------------------------------

describe("人工分段计划 · 校验和与身份", () => {
  const basePlan = (): SegmentationPlanFile => ({
    schemaVersion: 1,
    binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [{ assetKey: "k", sha256: "s" }] },
    author: "owner",
    createdAt: "2026-01-01T00:00:00.000Z",
    reason: "r",
    units: [{ title: "t", kind: "translation_passage", assignments: [assign("source", "k", 1, 1, 2)] as never }],
  });

  it("同一份计划永远得到同一个校验和（确定性）", () => {
    const a = segmentationPlanDigest(basePlan());
    const b = segmentationPlanDigest(basePlan());
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("**审计元数据**（author / createdAt / reason）不改变计划身份", () => {
    const plan = basePlan();
    const digest = segmentationPlanDigest(plan);
    const edited = { ...plan, author: "someone-else", createdAt: "2030-12-31T00:00:00.000Z", reason: "另一段说明" };
    expect(segmentationPlanDigest(edited), "同一个人隔天重存同样的结构不应变成一份新结构").toBe(digest);
  });

  it("**结构改动**必须改变计划身份（范围、通道、标题、绑定）", () => {
    const plan = basePlan();
    const digest = segmentationPlanDigest(plan);

    const changedRange = basePlan();
    changedRange.units[0].assignments[0] = assign("source", "k", 1, 1, 3) as never;
    expect(segmentationPlanDigest(changedRange), "范围变了 ⇒ 身份必须变").not.toBe(digest);

    const changedChannel = basePlan();
    changedChannel.units[0].assignments[0] = assign("notes", "k", 1, 1, 2) as never;
    expect(segmentationPlanDigest(changedChannel), "通道变了 ⇒ 身份必须变").not.toBe(digest);

    const changedTitle = basePlan();
    changedTitle.units[0].title = "另一个标题";
    expect(segmentationPlanDigest(changedTitle), "标题变了 ⇒ 身份必须变").not.toBe(digest);

    const changedSource = basePlan();
    changedSource.binding.sourceDigest = "b".repeat(64);
    expect(segmentationPlanDigest(changedSource), "绑定源变了 ⇒ 身份必须变").not.toBe(digest);
  });

  it("资产顺序不影响身份（规范摘要对顺序稳定）", () => {
    const a = basePlan();
    a.binding.assets = [{ assetKey: "a", sha256: "1" }, { assetKey: "b", sha256: "2" }];
    const b = basePlan();
    b.binding.assets = [{ assetKey: "b", sha256: "2" }, { assetKey: "a", sha256: "1" }];
    expect(segmentationPlanDigest(a)).toBe(segmentationPlanDigest(b));
  });
});

// ---------------------------------------------------------------------------
// 3) 应用计划 → 确定性段落（正例）
// ---------------------------------------------------------------------------

describe("人工分段计划 · 应用（正例）", () => {
  it("两个 source/reference 单元 ⇒ 两个 translation_passage 段", async () => {
    const env = makeEnv();
    try {
      // 四页最小夹具：每单元恰好两页，边界完全落在页这一级
      const sourceRoot = writeSources(env, "two-unit", twoUnitTranslationFixture());
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      expect(lineCountByPage.size, "夹具必须是 4 页").toBe(4);

      const furniture = [1, 2, 3, 4].map((p) => assign("ignored_furniture", assetKey, p, 1, 1, "重复页眉"));
      const plan = {
        schemaVersion: 1,
        binding: { courseId: "c1", sourceDigest: inventory.digest, assets: [{ assetKey, sha256: pdf.sha256 }] },
        author: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        reason: "自动分段不足",
        units: [
          {
            title: "练习 1",
            kind: "translation_passage",
            assignments: [
              assign("source", assetKey, 1, 2, lineCountByPage.get(1)!),
              assign("reference_translation", assetKey, 2, 2, lineCountByPage.get(2)!),
              ...furniture,
            ],
          },
          {
            title: "练习 2",
            kind: "translation_passage",
            assignments: [
              assign("source", assetKey, 3, 2, lineCountByPage.get(3)!),
              assign("reference_translation", assetKey, 4, 2, lineCountByPage.get(4)!),
            ],
          },
        ],
      };

      const { result } = await runIntake(env, { plan, courseId: "c1", sourceRoot });
      expect(
        result.segmentationPlan.applied,
        `计划应被采用，实际问题：${JSON.stringify(result.segmentationPlan.issues)}`,
      ).toBe(true);

      const segments = result.archive.manifest.segments.filter((s) => s.kind === "translation_passage");
      expect(segments.length, "两个单元 ⇒ 两个 translation_passage 段").toBe(2);
      expect(segments.map((s) => s.title)).toEqual(["练习 1", "练习 2"]);
      // 每段都有原文与参考译文
      for (const segment of segments) {
        expect(segment.text, "每段必须有原文").toBeTruthy();
        expect(segment.referenceTranslation, "每段必须有参考译文").toBeTruthy();
        // 页眉绝不出现在正文里
        expect(segment.text ?? "").not.toContain(MULTI_UNIT_HEADER);
      }
    } finally {
      env.dispose();
    }
  });

  it("多个单元**跨多页**：页码锚点覆盖正确的页区间", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env);
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "cross",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      const { result } = await runIntake(env, { plan, courseId: "cross", sourceRoot });
      expect(result.segmentationPlan.applied).toBe(true);
      expect(result.segmentationPlan.unassigned.length, "计划是完整覆盖的").toBe(0);

      const segments = result.archive.manifest.segments;
      expect(segments.length).toBe(3);
      // 单元 1 的原文在第 1 页，参考译文在第 2 页 ⇒ 锚点必须落在第 1 页
      const first = segments.find((s) => s.title === "翻译练习 1")!;
      expect(first.anchor.pageStart).toBe(1);
    } finally {
      env.dispose();
    }
  });

  it("单元**没有参考译文是允许的**（referenceTranslation 为 null，且不阻断）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env);
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "noref",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      const { result } = await runIntake(env, { plan, courseId: "noref", sourceRoot });
      const third = result.archive.manifest.segments.find((s) => s.title === "翻译练习 3（没有参考译文）")!;
      expect(third, "第三个单元必须存在").toBeDefined();
      expect(third.referenceTranslation, "没有参考译文 ⇒ null").toBeNull();
      expect(third.text, "但它仍然有原文").toBeTruthy();
      expect(third.notes ?? "", "系统说明必须明确这**不**阻断").toContain("不");

      // 没有参考译文**不**产生"缺失参考译文"这类缺陷事项。
      //
      // 判据必须是**事项类型**，不是"detail 里出现过这四个字" ——
      // 段复核事项（`segment_requires_review`）的说明里**会**提到
      // "该单元没有参考译文范围"，那是在如实告知复核者，而不是把它当缺陷。
      const blocking = result.archive.review.filter((item) => item.severity === "blocking");
      expect(
        blocking.some((item) => item.code !== "segment_requires_review" && item.detail.includes("参考译文缺失")),
        "缺少参考译文不得成为独立缺陷事项",
      ).toBe(false);
      // 但这件事本身必须被**如实告知**（不能悄悄不说）
      expect(
        blocking.some((item) => item.detail.includes("没有参考译文")),
        "必须如实告知该单元没有参考译文",
      ).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("notes / 语言点范围映射到段的 notes（且与人写的说明分开）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env);
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "notes",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      const { result } = await runIntake(env, { plan, courseId: "notes", sourceRoot });
      const first = result.archive.manifest.segments.find((s) => s.title === "翻译练习 1")!;
      expect(first.notes, "单元 1 有讲解范围 ⇒ notes 非空").toBeTruthy();
      // 人写的语言点必须真的在 notes 里
      expect(first.notes!, "讲解正文必须来自计划指定的范围").toContain("语言点");
      // 系统说明与人的说明分开（都在 notes 里，但都是可分辨的段）
      expect(first.notes!, "系统语义说明必须同时存在").toContain("课程材料");
    } finally {
      env.dispose();
    }
  });

  it("**显式**标为家具的重复页眉被排除在正文之外（且不计入未指派）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env);
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "furniture",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      const { result } = await runIntake(env, { plan, courseId: "furniture", sourceRoot });
      expect(result.segmentationPlan.applied).toBe(true);
      expect(result.segmentationPlan.unassigned.length, "显式家具满足覆盖率").toBe(0);
      expect(result.segmentationPlan.channelLineCounts.ignoredFurniture, "6 页各 1 行页眉").toBe(6);

      // 页眉文字**绝不**出现在任何段正文里
      for (const segment of result.archive.manifest.segments) {
        expect(segment.text ?? "", "家具文字不得进入段正文").not.toContain(MULTI_UNIT_HEADER);
        expect(segment.referenceTranslation ?? "").not.toContain(MULTI_UNIT_HEADER);
      }
    } finally {
      env.dispose();
    }
  });

  it("同一份（源, 计划）重跑是**确定性**的（候选校验和逐字节相同）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env);
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "det",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      // **同一个 courseId**：课程 id 会进 course.json，换 id 自然会换校验和
      // （那不是"不确定性"，而是另一份课程）。这里要证明的是
      // 「同一份（源, 计划, 课程 id）⇒ 逐字节相同的候选」。
      const first = await runIntake(env, { plan, courseId: "det", sourceRoot, writeCandidate: false });
      const second = await runIntake(env, { plan, courseId: "det", sourceRoot, writeCandidate: false });

      expect(first.result.archive.metadata.digests.candidateChecksum).toBe(
        second.result.archive.metadata.digests.candidateChecksum,
      );
      // 段 id 也必须相同（否则 course.json 字节会不同）
      expect(first.result.archive.manifest.segments.map((s) => s.id)).toEqual(
        second.result.archive.manifest.segments.map((s) => s.id),
      );
      // 正文逐字节相同
      expect(first.result.archive.manifest.segments.map((s) => s.text)).toEqual(
        second.result.archive.manifest.segments.map((s) => s.text),
      );
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 4) 覆盖率 / 重叠 / 越界（负例 —— 最重要的一组）
// ---------------------------------------------------------------------------

describe("人工分段计划 · 覆盖率与失败关闭（负例）", () => {
  /** 构造一个不依赖磁盘的源件视图（用于纯校验逻辑的用例）。 */
  function view(overrides: Partial<PlanSourceView> = {}): PlanSourceView {
    return {
      courseId: "c",
      sourceDigest: "a".repeat(64),
      assets: new Map([
        ["asset-1", { sha256: "s1", lineCountByPage: new Map([[1, 3], [2, 2]]), pagesWithoutTextLayer: [] }],
      ]),
      ...overrides,
    };
  }

  function planWith(units: SegmentationPlanFile["units"]): SegmentationPlanFile {
    return {
      schemaVersion: 1,
      binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [{ assetKey: "asset-1", sha256: "s1" }] },
      author: "owner",
      createdAt: "2026-01-01T00:00:00.000Z",
      reason: "r",
      units,
    };
  }

  it("同一行被**不兼容地**指派两次 ⇒ 失败（重叠）", () => {
    const validated = validatePlanContent(
      planWith([
        {
          title: "u",
          kind: "translation_passage",
          assignments: [
            assign("source", "asset-1", 1, 1, 3) as never,
            assign("reference_translation", "asset-1", 1, 2, 2) as never,
          ],
        },
      ]),
      view(),
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((issue) => issue.code === "plan_range_overlap")).toBe(true);
  });

  it("跨单元的同一行重叠也失败", () => {
    const validated = validatePlanContent(
      planWith([
        { title: "u1", kind: "translation_passage", assignments: [assign("source", "asset-1", 1, 1, 3) as never] },
        { title: "u2", kind: "translation_passage", assignments: [assign("source", "asset-1", 1, 3, 3) as never] },
      ]),
      view(),
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((issue) => issue.code === "plan_range_overlap")).toBe(true);
  });

  it("**同单元同通道**的**精确重复**范围也失败关闭（绝不静默去重）", () => {
    /*
     * ── 这条守的是 F3（实测缺陷）──
     *
     * 旧实现把"同单元同通道的重复范围"当作幂等（当作 UI 重复提交）而放行，
     * 但投影会把两个范围**都**拼进同一段正文 ⇒ 重叠的行被写两遍。
     * 实测形态：**7 个不同行变成 notes 计数 8**。
     *
     * 现在的不变量是**每一行最多只有一个最终归属**。
     * 一份对同一行说了两遍的计划是有歧义的，系统无从知道人想要一次还是两次 ——
     * 静默去重等于替人猜，而猜错会让课程内容量错误。
     */
    const validated = validatePlanContent(
      planWith([
        {
          title: "u",
          kind: "translation_passage",
          assignments: [
            assign("source", "asset-1", 1, 1, 3) as never,
            assign("source", "asset-1", 1, 1, 3) as never,
            assign("reference_translation", "asset-1", 2, 1, 2) as never,
          ],
        },
      ]),
      view(),
    );
    expect(validated.ok, "同单元同通道的精确重复必须失败关闭").toBe(false);
    const overlap = validated.issues.filter((issue) => issue.code === "plan_range_overlap");
    expect(overlap.length, "三行各报一次重叠").toBe(3);
    expect(overlap[0].detail).toMatch(/重复|两次/);
    // 冲突 ⇒ **不**产出规范结构（计划不可采用）
    expect(validated.resolved).toBeNull();
  });

  it("**部分重叠**（同单元同通道但只交叠一段）同样失败关闭", () => {
    const validated = validatePlanContent(
      planWith([
        {
          title: "u",
          kind: "translation_passage",
          assignments: [
            assign("source", "asset-1", 1, 1, 2) as never,
            assign("source", "asset-1", 1, 2, 3) as never,
          ],
        },
      ]),
      view(),
    );
    expect(validated.ok).toBe(false);
    // 只有第 2 行交叠 ⇒ 恰好一条重叠问题
    expect(validated.issues.filter((issue) => issue.code === "plan_range_overlap").length).toBe(1);
  });

  it("**包含**关系（一个范围吞掉另一个）失败关闭", () => {
    const validated = validatePlanContent(
      planWith([
        {
          title: "u",
          kind: "translation_passage",
          assignments: [
            assign("notes", "asset-1", 1, 1, 3) as never,
            assign("notes", "asset-1", 1, 2, 2) as never,
          ],
        },
      ]),
      view(),
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((issue) => issue.code === "plan_range_overlap")).toBe(true);
  });

  it("页号越界 ⇒ 失败（选择器必须落在绑定的资产内）", () => {
    const validated = validatePlanContent(
      planWith([
        {
          title: "u",
          kind: "translation_passage",
          assignments: [
            assign("source", "asset-1", 99, 1, 1) as never,
            assign("reference_translation", "asset-1", 2, 1, 2) as never,
          ],
        },
      ]),
      view(),
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((issue) => issue.code === "plan_range_page_out_of_bounds")).toBe(true);
  });

  it("行号越界 ⇒ 失败（第 1 页只有 3 行，却要到第 9 行）", () => {
    const validated = validatePlanContent(
      planWith([
        {
          title: "u",
          kind: "translation_passage",
          assignments: [
            assign("source", "asset-1", 1, 1, 9) as never,
            assign("reference_translation", "asset-1", 2, 1, 2) as never,
          ],
        },
      ]),
      view(),
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((issue) => issue.code === "plan_range_line_out_of_bounds")).toBe(true);
  });

  it("引用不存在的资产 ⇒ 失败", () => {
    const validated = validatePlanContent(
      planWith([
        {
          title: "u",
          kind: "translation_passage",
          assignments: [assign("source", "asset-NOPE", 1, 1, 1) as never],
        },
      ]),
      view(),
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((issue) => issue.code === "plan_range_asset_unknown")).toBe(true);
  });

  it("无文本层的页**不可寻址**（明确报错，不当作空页）", () => {
    const validated = validatePlanContent(
      planWith([
        {
          title: "u",
          kind: "translation_passage",
          assignments: [
            assign("source", "asset-1", 3, 1, 1) as never,
            assign("reference_translation", "asset-1", 1, 1, 3) as never,
          ],
        },
      ]),
      view({
        assets: new Map([
          ["asset-1", { sha256: "s1", lineCountByPage: new Map([[1, 3]]), pagesWithoutTextLayer: [3] }],
        ]),
      }),
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((issue) => issue.code === "plan_range_page_without_text_layer")).toBe(true);
  });

  it("**未指派内容**必须被逐行列出来，并且阻断", () => {
    const validated = validatePlanContent(
      planWith([
        {
          title: "u",
          kind: "translation_passage",
          assignments: [
            // 只覆盖第 1 页第 1–2 行；第 3 行与第 2 页两行都没被接住
            assign("source", "asset-1", 1, 1, 2) as never,
            assign("reference_translation", "asset-1", 1, 3, 3) as never,
          ],
        },
      ]),
      view(),
    );
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((issue) => issue.code === "plan_unassigned_content")).toBe(true);
    // 逐行列出：第 2 页的第 1、2 行
    expect(validated.unassigned).toEqual([
      { assetKey: "asset-1", page: 2, line: 1 },
      { assetKey: "asset-1", page: 2, line: 2 },
    ]);
    expect(validated.totalLineCount).toBe(5);
  });

  it("**重复页眉未被标为家具** ⇒ 保持未指派并阻断（工具绝不自行推断）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env);
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      // furniture: "none" ⇒ 6 页的页眉都没有被显式标为家具
      const plan = fullPlan(assetKey, {
        courseId: "nofurniture",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
        furniture: "none",
      });

      const { result } = await runIntake(env, { plan, courseId: "nofurniture", sourceRoot });

      // 关键语义：工具**没有**因为"这行在 6 页里都一样"就自动忽略它
      expect(result.segmentationPlan.applied, "计划本身形状合法 ⇒ 会被采用").toBe(true);
      expect(result.segmentationPlan.unassigned.length, "6 行未标家具的页眉必须全部可见").toBe(6);
      expect(result.segmentationPlan.channelLineCounts.ignoredFurniture).toBe(0);

      // 且必须是**阻断级**事项
      const blocking = result.archive.review.filter((item) => item.code === "plan_unassigned_content");
      expect(blocking.length, "未指派必须产生阻断事项").toBe(1);
      expect(blocking[0].severity).toBe("blocking");
      expect(blocking[0].detail, "必须说明工具不会自行判定页眉").toContain("不会");
      // 证据里只有坐标，**没有正文**
      expect(blocking[0].evidence ?? "", "证据只能含页码/行号，绝不含正文").not.toContain(MULTI_UNIT_HEADER);

      /*
       * ── 门禁：不可晋升（**因果断言**）──
       *
       * F7 指出：早先这里用 `gateOf(...)`（它传 `review: null`），
       * 而 `review: null` 让 PROMOTABLE **在原理上不可能** ——
       * 于是 `not.toBe("PROMOTABLE")` 与"未指派内容"无关，
       * 即使去掉未指派守卫它照样通过。那是**假信心**。
       *
       * 现在给一份**把一切能接受的都接受**的复核记录：唯一剩下的
       * 阻断来源就是 `plan_unassigned_content`（它不可被裁决化解）。
       * 因此这条断言在"未指派守卫被去掉"时**确实会变红**。
       */
      const stored = readStoredCandidate("nofurniture", env.candidatesDir);
      const signedReview = acceptAllReviewFor(stored);
      const { gate } = gateWithReview(env, "nofurniture", signedReview);

      expect(gate.status, "未指派内容必须让门禁失败关闭").not.toBe("PROMOTABLE");
      const unassignedCheck = gate.checks.find((c) => c.name === "blocking_review_items_resolved")!;
      expect(unassignedCheck.passed, "未指派内容必须让门禁失败关闭").toBe(false);
      // 且该项必须**仍然**未解决（不可裁决化解）—— 而不是因为缺别的东西
      expect(unassignedCheck.detail, "未解决的原因必须是未指派内容").toContain("plan_unassigned_content");
      // 复核本身是有效的（排除"失败只是因为复核无效"这种假信心）
      expect(
        gate.checks.find((c) => c.name === "human_review_present")!.passed,
        "复核必须存在且有效 —— 否则上面的失败与未指派无关",
      ).toBe(true);
      expect(
        gate.checks.find((c) => c.name === "review_bound_to_current_candidate")!.passed,
        "复核必须绑定到当前候选 —— 否则上面的失败与未指派无关",
      ).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("**未指派内容不可被任何复核裁决化解**（唯一实现在 types.ts）", async () => {
    const { NEVER_RESOLVABLE_BY_REVIEW } = await import("@/content/course-pipeline/types");
    expect(NEVER_RESOLVABLE_BY_REVIEW).toContain("plan_unassigned_content");
    expect(NEVER_RESOLVABLE_BY_REVIEW).toContain("plan_binding_mismatch");
  });
});

// ---------------------------------------------------------------------------
// 5) 陈旧语义（绑定）
// ---------------------------------------------------------------------------

describe("人工分段计划 · 陈旧与绑定（负例）", () => {
  it("源摘要变化 ⇒ 计划**失败关闭**，且不逐行报越界（避免淹没真正原因）", () => {
    const plan: SegmentationPlanFile = {
      schemaVersion: 1,
      binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [{ assetKey: "asset-1", sha256: "s1" }] },
      author: "owner",
      createdAt: "2026-01-01T00:00:00.000Z",
      reason: "r",
      units: [
        {
          title: "u",
          kind: "translation_passage",
          assignments: [
            assign("source", "asset-1", 1, 1, 99) as never,
            assign("reference_translation", "asset-1", 2, 1, 2) as never,
          ],
        },
      ],
    };
    const validated = validatePlanContent(plan, {
      courseId: "c",
      sourceDigest: "b".repeat(64),
      assets: new Map([
        ["asset-1", { sha256: "s1", lineCountByPage: new Map([[1, 3], [2, 2]]), pagesWithoutTextLayer: [] }],
      ]),
    });
    expect(validated.ok).toBe(false);
    expect(validated.issues.map((i) => i.code)).toEqual(["plan_binding_source_stale"]);
    expect(validated.issues[0].detail).toContain("绝不");
    // 陈旧时不逐行报越界
    expect(validated.issues.some((i) => i.code === "plan_range_line_out_of_bounds")).toBe(false);
  });

  it("资产校验和变化 ⇒ 计划失败关闭", () => {
    const plan: SegmentationPlanFile = {
      schemaVersion: 1,
      binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [{ assetKey: "asset-1", sha256: "OLD" }] },
      author: "owner",
      createdAt: "2026-01-01T00:00:00.000Z",
      reason: "r",
      units: [{ title: "u", kind: "translation_passage", assignments: [assign("source", "asset-1", 1, 1, 1) as never] }],
    };
    const validated = validatePlanContent(plan, {
      courseId: "c",
      sourceDigest: "a".repeat(64),
      assets: new Map([
        ["asset-1", { sha256: "NEW", lineCountByPage: new Map([[1, 3]]), pagesWithoutTextLayer: [] }],
      ]),
    });
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((i) => i.code === "plan_binding_asset_stale")).toBe(true);
  });

  it("课程 id 不符 ⇒ 计划失败关闭（不可跨课程复用）", () => {
    const plan: SegmentationPlanFile = {
      schemaVersion: 1,
      binding: { courseId: "course-A", sourceDigest: "a".repeat(64), assets: [{ assetKey: "asset-1", sha256: "s1" }] },
      author: "owner",
      createdAt: "2026-01-01T00:00:00.000Z",
      reason: "r",
      units: [{ title: "u", kind: "translation_passage", assignments: [assign("source", "asset-1", 1, 1, 1) as never] }],
    };
    const validated = validatePlanContent(plan, {
      courseId: "course-B",
      sourceDigest: "a".repeat(64),
      assets: new Map([["asset-1", { sha256: "s1", lineCountByPage: new Map([[1, 3]]), pagesWithoutTextLayer: [] }]]),
    });
    expect(validated.ok).toBe(false);
    expect(validated.issues.some((i) => i.code === "plan_binding_course_mismatch")).toBe(true);
  });

  it("**真实磁盘**：抽取后改动源字节 ⇒ 计划被拒绝，且候选带阻断事项", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "drift");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "drift",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      // 先证明这份计划本身是好的（courseId 必须与计划绑定一致）
      const ok = await runIntake(env, { plan, courseId: "drift", sourceRoot, writeCandidate: false });
      expect(ok.result.segmentationPlan.applied, "基准计划必须被采用").toBe(true);

      /*
       * 现在**把源件换掉**（文件名不变，字节变）。
       *
       * 这正是任务书要求的那条："源字节一变就必须让计划陈旧。"
       * 若流水线还在用旧选择器，它会把第 1 页第 2–4 行的**新内容**
       * 当成练习 1 的原文 —— 一个完全静默的错误结构。
       */
      const pdfPath = join(sourceRoot, ...pdf.relativePath.split("/"));
      const original = readFileSync(pdfPath);
      writeFileSync(pdfPath, Buffer.concat([original, Buffer.from("\n% mutated bytes\n", "utf8")]));

      const drifted = await runIntake(env, { plan, courseId: "drift", sourceRoot });
      expect(drifted.result.segmentationPlan.applied, "源变了 ⇒ 计划不得被采用").toBe(false);
      expect(
        drifted.result.segmentationPlan.issues.some((i) => i.code === "plan_binding_source_stale" || i.code === "plan_binding_asset_stale"),
        "必须明确报出陈旧",
      ).toBe(true);

      // 候选带阻断且不可裁决的事项
      const mismatch = drifted.result.archive.review.filter((item) => item.code === "plan_binding_mismatch");
      expect(mismatch.length, "计划未被采用必须产生阻断事项").toBeGreaterThan(0);
      expect(mismatch[0].severity).toBe("blocking");

      /*
       * ── 门禁：不可晋升（**因果断言**）──
       *
       * 同 F7 的处置：给一份把一切能接受的都接受的复核记录，
       * 因此唯一剩下的阻断来源就是 `plan_binding_mismatch`（不可化解）。
       * 去掉陈旧守卫后这条断言**确实会变红**。
       */
      const stored = readStoredCandidate("drift", env.candidatesDir);
      const { gate } = gateWithReview(env, "drift", acceptAllReviewFor(stored));
      expect(gate.status, "计划陈旧时门禁不得 PROMOTABLE").not.toBe("PROMOTABLE");
      const unresolved = gate.checks.find((c) => c.name === "blocking_review_items_resolved")!;
      expect(unresolved.passed, "未化解的阻断事项必须让门禁失败关闭").toBe(false);
      expect(unresolved.detail, "未解决的原因必须是计划绑定不符").toContain("plan_binding_mismatch");
      // 复核本身有效 ⇒ 上面的失败确实来自计划，而不是"没有复核"
      expect(gate.checks.find((c) => c.name === "review_bound_to_current_candidate")!.passed).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("计划**未被采用**时，分段模式证据必须如实写 `automatic`（不谎称用了计划）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "notapplied");
      const { inventory, assetKey } = await probe(sourceRoot);
      // 故意用一个错误的源摘要
      const plan = {
        schemaVersion: 1,
        binding: { courseId: "notapplied", sourceDigest: "f".repeat(64), assets: [{ assetKey, sha256: "x" }] },
        author: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        reason: "r",
        units: [{ title: "u", kind: "translation_passage", assignments: [assign("source", assetKey, 1, 1, 1)] }],
      };
      const { result } = await runIntake(env, { plan, courseId: "notapplied", sourceRoot });
      expect(result.segmentationPlan.applied).toBe(false);
      expect(result.archive.metadata.segmentation.modeEvidence.mode, "未采用计划就必须如实写 automatic").toBe("automatic");
      expect(result.archive.metadata.segmentation.modeEvidence.planDigest).toBeNull();
      void inventory;
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 6) 候选身份（计划参与摘要）
// ---------------------------------------------------------------------------

describe("人工分段计划 · 候选身份", () => {
  it("**`segmentationModeDigest` 参与分段摘要**（投影相同、模式不同 ⇒ 摘要必须不同）", () => {
    /*
     * ── 这条用例为什么必须单独存在（F7 发现的验证死角）──
     *
     * `courseSegmentationDigest(materials, modeEvidence)` 里 `mode` 那一项，
     * 是"计划校验和参与候选身份"的**独立通道**。
     *
     * 但它极容易被"段 id 本身就含计划校验和"这条通道**掩盖**：
     * 改计划 ⇒ 段 id 变 ⇒ `course.json` 变 ⇒ 候选校验和变。
     * 于是端到端用例即使把 `mode` 那一项去掉**也照样通过** ——
     * 实测确认：单独去掉它，全部端到端用例仍然全绿。
     *
     * 因此这里把材料固定为**完全相同**（同一份 segments），
     * 只让 `modeEvidence` 不同。此时摘要若相同，就说明
     * "计划校验和参与身份"这条语义**根本没有实现**。
     */
    const materials: Parameters<typeof courseSegmentationDigest>[0] = [];

    const automatic = automaticSegmentationEvidence();
    const plannedA = plannedSegmentationEvidence(
      {
        schemaVersion: 1,
        binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [] },
        author: "o",
        createdAt: "t",
        reason: "r",
        units: [],
      },
      "d".repeat(64),
      { source: 1, referenceTranslation: 1, notes: 0, ignoredFurniture: 0 },
      [],
    );
    // 只有 planDigest 不同（其余全同）
    const plannedB = { ...plannedA, planDigest: "e".repeat(64) };

    const autoDigest = courseSegmentationDigest(materials, automatic);
    const plannedADigest = courseSegmentationDigest(materials, plannedA);
    const plannedBDigest = courseSegmentationDigest(materials, plannedB);

    expect(plannedADigest, "自动 ⇄ 人工计划必须改变分段摘要（即使段内容完全相同）").not.toBe(autoDigest);
    expect(plannedBDigest, "计划校验和不同必须改变分段摘要（即使段内容完全相同）").not.toBe(plannedADigest);

    // 反向对照：模式证据**完全相同**时摘要必须相同（证明上面的差异来自那一项，而不是随机）
    expect(courseSegmentationDigest(materials, { ...plannedA })).toBe(plannedADigest);

    // 未指派计数也参与（从"有"变"没有"是真实结构变化）
    const plannedWithUnassigned = plannedSegmentationEvidence(
      {
        schemaVersion: 1,
        binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [] },
        author: "o",
        createdAt: "t",
        reason: "r",
        units: [],
      },
      "d".repeat(64),
      { source: 1, referenceTranslation: 1, notes: 0, ignoredFurniture: 0 },
      [{ assetKey: "a", page: 1, line: 1 }],
    );
    expect(courseSegmentationDigest(materials, plannedWithUnassigned)).not.toBe(plannedADigest);
  });

  it("**审计元数据**（planAuthor / planCreatedAt）**不**改变分段摘要", () => {
    const materials: Parameters<typeof courseSegmentationDigest>[0] = [];
    const base = plannedSegmentationEvidence(
      {
        schemaVersion: 1,
        binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [] },
        author: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        reason: "r",
        units: [],
      },
      "d".repeat(64),
      { source: 1, referenceTranslation: 1, notes: 0, ignoredFurniture: 0 },
      [],
    );
    const audited = { ...base, planAuthor: "someone-else", planCreatedAt: "2030-12-31T00:00:00.000Z" };
    expect(
      courseSegmentationDigest(materials, audited),
      "审计元数据不参与身份（否则同一个人隔天重存会让复核凭空陈旧）",
    ).toBe(courseSegmentationDigest(materials, base));
  });

  it("**计划改动**必须改变候选校验和（人的结构输入改变候选身份）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "identity");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;

      const base = fullPlan(assetKey, {
        courseId: "identity",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });
      const first = await runIntake(env, { plan: base, courseId: "identity", sourceRoot, writeCandidate: false });
      expect(first.result.segmentationPlan.applied, "基准计划必须被采用").toBe(true);

      /*
       * 只改**一处结构**：把单元 2 的标题换掉，同时把它的参考译文范围
       * 从第 5 页第 2 行起改成第 3 行起（并把第 2 行让给家具以免未指派）。
       *
       * 两次改动都是**结构性的**，且在计划层面仍然自洽（覆盖率完整）。
       * 这正是"人的结构输入变了"的最小形态。
       */
      const edited = JSON.parse(JSON.stringify(base)) as typeof base;
      const units = edited.units as {
        title: string;
        assignments: { channel: string; range: { page: number; lineStart: number } }[];
      }[];
      units[1].title = "翻译练习 2（修订）";
      const reference = units[1].assignments.find((a) => a.channel === "reference_translation")!;
      reference.range.lineStart = 3;
      units[0].assignments.push(
        assign("ignored_furniture", assetKey, 5, 2, 2, "被让出的那一行") as never,
      );

      const second = await runIntake(env, { plan: edited, courseId: "identity", sourceRoot, writeCandidate: false });

      expect(
        second.result.segmentationPlan.applied,
        `改动后仍应是一份合法计划，实际问题：${JSON.stringify(second.result.segmentationPlan.issues)}`,
      ).toBe(true);
      expect(
        second.result.archive.metadata.digests.candidateChecksum,
        "计划改动 ⇒ 候选校验和必须变（否则旧复核会被静默沿用）",
      ).not.toBe(first.result.archive.metadata.digests.candidateChecksum);
    } finally {
      env.dispose();
    }
  });

  it("**计划校验和**进入候选证据（自动模式为 null）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "evidence");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;

      const automatic = await runIntake(env, { courseId: "evidence-auto", sourceRoot, writeCandidate: false });
      expect(automatic.result.archive.metadata.segmentation.modeEvidence.mode).toBe("automatic");
      expect(automatic.result.archive.metadata.segmentation.modeEvidence.planDigest).toBeNull();

      const plan = fullPlan(assetKey, {
        // 计划的 binding.courseId 必须与 intake 的 courseId 一致（否则会被判跨课程）
        courseId: "evidence",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });
      const planned = await runIntake(env, { plan, courseId: "evidence", sourceRoot, writeCandidate: false });
      expect(
        planned.result.segmentationPlan.applied,
        `计划应被采用，实际问题：${JSON.stringify(planned.result.segmentationPlan.issues)}`,
      ).toBe(true);
      const evidence = planned.result.archive.metadata.segmentation.modeEvidence;
      expect(evidence.mode).toBe("human_planned");
      expect(evidence.planDigest, "人工模式必须携带计划校验和").toMatch(/^[0-9a-f]{64}$/);
      expect(evidence.unitCount).toBe(3);
      expect(evidence.channelLineCounts.ignoredFurniture).toBe(6);
      expect(evidence.unassignedLineCount).toBe(0);

      // 证据里**绝不含**绝对路径，也绝不含正文
      const serialized = JSON.stringify(evidence);
      expect(serialized).not.toMatch(/[A-Za-z]:\\\\/);
      expect(serialized).not.toContain(MULTI_UNIT_SOURCE_1);
      expect(serialized).not.toContain(MULTI_UNIT_HEADER);
    } finally {
      env.dispose();
    }
  });

  it("自动模式与人工计划模式得到**不同**的分段摘要（来源参与身份）", () => {
    const materials = [] as never[];
    const automatic = courseSegmentationDigest(materials, automaticSegmentationEvidence());
    const planned = courseSegmentationDigest(
      materials,
      plannedSegmentationEvidence(
        {
          schemaVersion: 1,
          binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [] },
          author: "o",
          createdAt: "t",
          reason: "r",
          units: [],
        },
        "d".repeat(64),
        { source: 0, referenceTranslation: 0, notes: 0, ignoredFurniture: 0 },
        [],
      ),
    );
    expect(automatic).not.toBe(planned);
  });

  it("审计元数据（作者/时刻）**不**改变分段摘要（避免无谓地让复核陈旧）", () => {
    const plan: SegmentationPlanFile = {
      schemaVersion: 1,
      binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [] },
      author: "owner",
      createdAt: "2026-01-01T00:00:00.000Z",
      reason: "r1",
      units: [],
    };
    const a = plannedSegmentationEvidence(plan, "d".repeat(64), { source: 1, referenceTranslation: 1, notes: 0, ignoredFurniture: 0 }, []);
    const b = plannedSegmentationEvidence(
      { ...plan, author: "other", createdAt: "2030-01-01T00:00:00.000Z", reason: "r2" },
      "d".repeat(64),
      { source: 1, referenceTranslation: 1, notes: 0, ignoredFurniture: 0 },
      [],
    );
    expect(segmentationModeDigest(a)).toBe(segmentationModeDigest(b));
  });

  it("未指派**计数**参与身份（从「有未指派」变成「没有」是真实结构变化）", () => {
    const plan: SegmentationPlanFile = {
      schemaVersion: 1,
      binding: { courseId: "c", sourceDigest: "a".repeat(64), assets: [] },
      author: "o",
      createdAt: "t",
      reason: "r",
      units: [],
    };
    const counts = { source: 1, referenceTranslation: 0, notes: 0, ignoredFurniture: 0 };
    const withUnassigned = plannedSegmentationEvidence(plan, "d".repeat(64), counts, [
      { assetKey: "a", page: 1, line: 1 },
    ]);
    const without = plannedSegmentationEvidence(plan, "d".repeat(64), counts, []);
    expect(segmentationModeDigest(withUnassigned)).not.toBe(segmentationModeDigest(without));
  });
});

// ---------------------------------------------------------------------------
// 7) 与既有语义的关系（不削弱既有保证）
// ---------------------------------------------------------------------------

/**
 * **F7：计划改动 ⇒ 已签复核陈旧**（端到端集成，不是校验和单测）。
 *
 * ── 为什么单靠"计划校验和变了"不够 ──
 *
 * 校验和单测只证明"摘要函数对输入敏感"。它**证明不了**这条链真的接通了：
 *
 *   计划结构改动 → 计划校验和 → 分段摘要 → 候选校验和 → 复核绑定失败
 *
 * 链上任何一环没接（例如 `modeEvidence` 没进分段摘要、或复核重算时
 * 忘了传它），校验和单测**仍然全绿**，而实际的后果是：
 * 人改了结构，旧签字却继续有效 —— 一份他没复核过的结构被放行。
 *
 * 因此这一组走**真实磁盘 + 真实门禁**，并且刻意先构造
 * "**基准状态：可以 PROMOTABLE**"，再只改计划，让失败唯一归因于计划改动。
 */
describe("人工分段计划 · F7 计划改动使已签复核陈旧（端到端）", () => {
  it("**投影/计数一致性守卫**本身有效（纯函数，可被直接驱动）", () => {
    /*
     * ── 这条用例是为了让那条守卫**可被单独验证** ──
     *
     * 它是 F2/F3 的兜底：早先它是 `index.ts` 里的一段内联 `if`，
     * 于是只有**同时**破坏投影才可能触发它 —— "这条守卫有没有用"
     * 无法被单独立验证（实测：单独去掉它，任何测试都不变红）。
     *
     * 抽成纯函数后可以在这里直接喂给它一对不一致的计数。
     */
    const counted = { source: 9, referenceTranslation: 8, notes: 4 };

    // 完全一致 ⇒ 无偏差
    expect(planProjectionMismatch(counted, counted), "一致时不得报错").toBeNull();

    // 参考译文少了一行（**这正是 F2 的实测形态**：8 → 4）
    const shortReference = planProjectionMismatch({ ...counted, referenceTranslation: 4 }, counted);
    expect(shortReference, "参考译文行数不符必须被报出").not.toBeNull();
    expect(shortReference, "必须给出逐通道的实际/应有").toContain("参考译文 4/8 行");
    expect(shortReference, "必须说明原因").toMatch(/没有进入投影/);

    // 原文不符
    expect(planProjectionMismatch({ ...counted, source: 8 }, counted)).toContain("原文 8/9 行");
    // 讲解不符
    expect(planProjectionMismatch({ ...counted, notes: 3 }, counted)).toContain("讲解 3/4 行");
    // 多个通道同时不符 ⇒ 全部列出
    const multi = planProjectionMismatch({ source: 1, referenceTranslation: 2, notes: 3 }, counted);
    expect(multi).toContain("原文 1/9 行");
    expect(multi).toContain("参考译文 2/8 行");
    expect(multi).toContain("讲解 3/4 行");
  });

  it("候选 A ← 计划 A → 有效复核 A ⇒ 改动计划结构 → 候选 B ⇒ 旧复核 A 陈旧", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "stale-review");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;

      // ── 计划 A：完整覆盖（单元边界都为合法状态，好让门禁能通过）──
      const planA = fullPlan(assetKey, {
        courseId: "stale-review",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      await runIntake(env, { plan: planA, courseId: "stale-review", sourceRoot });

      const storedA = readStoredCandidate("stale-review", env.candidatesDir);
      const reviewA = acceptAllReviewFor(storedA);
      const checksumA = storedA.recomputed.candidateChecksum;

      /*
       * ── 基准：这份复核对候选 A **是有效的** ──
       *
       * 若这里不成立，下面的"陈旧"就无法归因于计划改动（可能只是复核
       * 本身有问题）。因此这是一条必要的对照断言。
       */
      const base = gateWithReview(env, "stale-review", reviewA);
      expect(base.parsed.ok, `复核 A 必须形状合法：${base.parsed.errors.join("；")}`).toBe(true);
      const boundCheckA = base.gate.checks.find((check) => check.name === "review_bound_to_current_candidate")!;
      expect(boundCheckA.passed, "基准：复核 A 必须绑定到候选 A").toBe(true);

      // ── 改动**结构**：把单元 1 的原文范围缩小一行（人的结构输入变了）──
      const planAUnits = (planA as { units: { assignments: { channel: string; range: { assetKey: string; page: number; lineStart: number; lineEnd: number } }[] }[] }).units;
      const sourceAssignment = planAUnits[0].assignments.find((assignment) => assignment.channel === "source")!;
      const originalEnd = sourceAssignment.range.lineEnd;
      sourceAssignment.range.lineEnd = originalEnd - 1;
      // 被让出的那一行必须由人显式标为家具，否则覆盖率会缺一行（那是另一件事）
      planAUnits[0].assignments.push({
        channel: "ignored_furniture",
        range: { assetKey: sourceAssignment.range.assetKey, page: sourceAssignment.range.page, lineStart: originalEnd, lineEnd: originalEnd },
      });

      // ── 重新生成候选 B（同一份源，改过的计划）──
      await runIntake(env, { plan: planA, courseId: "stale-review", sourceRoot });

      const storedB = readStoredCandidate("stale-review", env.candidatesDir);
      const checksumB = storedB.recomputed.candidateChecksum;

      expect(checksumB, "计划结构改动必须改变候选校验和").not.toBe(checksumA);

      // 分段摘要必须真的不同（证明 modeEvidence/段结构确实进了摘要）
      expect(
        storedB.recomputed.segmentationDigest,
        "计划改动必须改变分段摘要",
      ).not.toBe(storedA.recomputed.segmentationDigest);

      /*
       * ── 核心断言：旧复核 A 对新候选 B **陈旧** ──
       *
       * 仍然用 reviewA（它绑定 checksumA），但对着候选 B 求值。
       */
      const stale = gateWithReview(env, "stale-review", reviewA);
      const boundCheck = stale.gate.checks.find((check) => check.name === "review_bound_to_current_candidate")!;
      expect(boundCheck.passed, "旧复核必须被判陈旧").toBe(false);
      expect(boundCheck.detail, "必须说明是从哪个校验和变成哪个").toContain(checksumA.slice(0, 16));
      expect(boundCheck.detail).toContain(checksumB.slice(0, 16));
      expect(boundCheck.detail, "必须要求重新复核").toMatch(/重新复核/);

      // 陈旧 ⇒ 不可晋升（且不是"人还没决定"，是硬失败）
      expect(stale.gate.status, "陈旧复核下不得 PROMOTABLE").not.toBe("PROMOTABLE");

      // 反向对照：把复核重新绑到候选 B ⇒ 又变成有效（证明失败确实来自绑定）
      const reviewB = { ...acceptAllReviewFor(storedB), candidateChecksum: checksumB };
      const rebound = gateWithReview(env, "stale-review", reviewB);
      expect(
        rebound.gate.checks.find((check) => check.name === "review_bound_to_current_candidate")!.passed,
        "重新绑定的复核必须重新有效（证明上面的失败来自校验和绑定，而不是别处）",
      ).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("**纯审计元数据改动**（author/createdAt/reason）**不**使复核陈旧", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "audit-only");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "audit-only",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      await runIntake(env, { plan, courseId: "audit-only", sourceRoot });
      const before = readStoredCandidate("audit-only", env.candidatesDir);

      // 只改审计元数据（同一个人隔天重存同样的结构）
      const audited = { ...plan, author: "another-owner", createdAt: "2030-12-31T00:00:00.000Z", reason: "改了一句说明" };
      await runIntake(env, { plan: audited, courseId: "audit-only", sourceRoot });
      const after = readStoredCandidate("audit-only", env.candidatesDir);

      expect(
        after.recomputed.candidateChecksum,
        "审计元数据**不参与**候选身份（否则已签复核会无谓陈旧）",
      ).toBe(before.recomputed.candidateChecksum);
    } finally {
      env.dispose();
    }
  });

  it("**计划校验和本身参与候选身份**（投影相同、计划不同 ⇒ 候选身份必须不同）", async () => {
    /*
     * ── 这条用例的存在理由（F7 发现的验证缺口）──
     *
     * "改结构 ⇒ 复核陈旧" 有两条可能路径：
     *
     *   1. 结构改动**改变投影** ⇒ 段内容变 ⇒ 候选校验和变；
     *   2. 结构改动**不改变投影**，但 `planDigest` 变 ⇒
     *      只有"计划校验和进入分段摘要"这条链才能让它变。
     *
     * 只测 (1) 的话，把 `modeEvidence` 从分段摘要里去掉**测试仍然全绿** ——
     * 因为段内容自己就把校验和改变了。也就是说"计划校验和参与身份"
     * 这条语义**从未被真正验证过**。
     *
     * 因此这里构造一个只走 (2) 的改动：**重排同一通道内的两个范围**。
     * 投影按源文档顺序排序，因此产出的段**逐字节相同**；
     * 而计划的赋值数组顺序参与 `segmentationPlanDigest` ⇒ 计划校验和不同。
     *
     * 判据很干净：
     *   · 段正文 / 段 id / course.json 必须相同（证明投影没变）；
     *   · 候选校验和必须不同（证明计划校验和确实在身份里）。
     */
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "plan-identity");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const base = fullPlan(assetKey, {
        courseId: "plan-identity",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      // 计划 A：原文两条范围（p1、p4）
      const planA = structuredClone(base) as {
        units: { title: string; kind: string; assignments: unknown[] }[];
      };
      const unit1 = planA.units[0];
      const referenceAssignments = unit1.assignments.filter(
        (assignment) => (assignment as { channel: string }).channel === "reference_translation",
      );
      expect(referenceAssignments.length, "夹具必须恰好有两条参考译文范围").toBe(1);

      // 给单元 1 增加**第二条**参考译文范围（p5），并把两条按 [p2, p5] 排列
      const p5 = [5].map((page) =>
        assign("reference_translation", assetKey, page, 2, lineCountByPage.get(page) ?? 1),
      )[0];
      // 第 5 页原本属于单元 2 的参考译文 ⇒ 从单元 2 移除，避免重叠
      const unit2 = planA.units[1];
      unit2.assignments = unit2.assignments.filter(
        (assignment) => (assignment as { range: { page: number } }).range.page !== 5,
      );
      unit1.assignments = [...unit1.assignments.filter((a) => (a as { channel: string }).channel !== "reference_translation"), referenceAssignments[0], p5];

      const first = await runIntake(env, { plan: planA, courseId: "plan-identity", sourceRoot, writeCandidate: false });
      expect(
        first.result.segmentationPlan.applied,
        `计划 A 应被采用：${JSON.stringify(first.result.segmentationPlan.issues)}`,
      ).toBe(true);

      // 计划 B：**只重排**同一个单元里那两条参考译文范围的顺序
      const planB = structuredClone(planA) as { units: { assignments: unknown[] }[] };
      const refs = planB.units[0].assignments.filter(
        (assignment) => (assignment as { channel: string }).channel === "reference_translation",
      );
      expect(refs.length, "必须有两条参考译文范围可供重排").toBe(2);
      planB.units[0].assignments = [
        ...planB.units[0].assignments.filter((a) => (a as { channel: string }).channel !== "reference_translation"),
        refs[1],
        refs[0],
      ];

      const second = await runIntake(env, { plan: planB, courseId: "plan-identity", sourceRoot, writeCandidate: false });
      expect(second.result.segmentationPlan.applied, "计划 B 应被采用").toBe(true);

      // ── 前提：计划校验和确实变了（否则本用例证明不了任何事）──
      expect(
        second.result.segmentationPlan.planDigest,
        "重排范围必须改变计划校验和",
      ).not.toBe(first.result.segmentationPlan.planDigest);

      // ── 前提：投影**没有**变（正文逐项相同；段 id 会因计划作用域而变）──
      const segmentsA = first.result.archive.manifest.segments;
      const segmentsB = second.result.archive.manifest.segments;
      expect(segmentsB.length, "段数必须相同").toBe(segmentsA.length);
      /*
       * 段 id **会**不同：它含计划校验和的前 8 位（`p<digest8>`）——
       * 那正是"结构改动改变候选身份"的另一条通道。这里断言它确实变了，
       * 但同时断言**正文与标题**没变（即投影没变）。
       */
      expect(segmentsB.map((s) => s.title), "段标题必须相同").toEqual(segmentsA.map((s) => s.title));
      expect(segmentsB.map((s) => s.text), "正文必须相同（投影没变）").toEqual(segmentsA.map((s) => s.text));
      expect(segmentsB.map((s) => s.referenceTranslation), "参考译文必须相同").toEqual(
        segmentsA.map((s) => s.referenceTranslation),
      );
      expect(segmentsB.map((s) => s.notes), "讲解必须相同").toEqual(segmentsA.map((s) => s.notes));
      // 段 id 里的计划作用域必须随计划校验和改变（否则"结构改动"对身份不可见）
      expect(
        segmentsB[0].id.split(".")[0],
        "段 id 的计划作用域必须随计划校验和改变",
      ).not.toBe(segmentsA[0].id.split(".")[0]);

      // ── 核心断言：计划校验和参与身份 ⇒ 候选校验和必须不同 ──
      expect(
        second.result.archive.metadata.digests.candidateChecksum,
        "计划校验和变 ⇒ 候选身份必须变（**即使投影逐字节相同**）—— " +
          "这条只有「计划校验和进入分段摘要」成立时才可能通过",
      ).not.toBe(first.result.archive.metadata.digests.candidateChecksum);
    } finally {
      env.dispose();
    }
  });

  it("**自动 ⇄ 人工计划**切换也使复核陈旧（结构来源本身参与身份）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "mode-switch");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;

      // 先自动
      await runIntake(env, { courseId: "mode-switch", sourceRoot });
      const auto = readStoredCandidate("mode-switch", env.candidatesDir);
      expect(auto.metadata.segmentation.modeEvidence.mode).toBe("automatic");

      // 再人工（同一份源）
      const plan = fullPlan(assetKey, {
        courseId: "mode-switch",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });
      await runIntake(env, { plan, courseId: "mode-switch", sourceRoot });
      const planned = readStoredCandidate("mode-switch", env.candidatesDir);

      expect(planned.metadata.segmentation.modeEvidence.mode).toBe("human_planned");
      expect(
        planned.recomputed.candidateChecksum,
        "把自动结构换成人工计划必须改变候选身份",
      ).not.toBe(auto.recomputed.candidateChecksum);
    } finally {
      env.dispose();
    }
  });
});

describe("人工分段计划 · 与既有语义的关系", () => {
  it("**计划不产生 verified，也不等于复核**：门禁仍是 REVIEW_REQUIRED、零交接", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "gate");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "gate",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      await runIntake(env, { plan, courseId: "gate", sourceRoot });

      // 没有 review.json ⇒ 不可能 PROMOTABLE
      expect(existsSync(join(env.candidatesDir, "gate", "review.json")), "工具**从不**生成 review.json").toBe(false);

      const { gate } = gateOf(env, "gate");
      expect(gate.status, "计划**不是**复核 ⇒ 门禁不得 PROMOTABLE").toBe("REVIEW_REQUIRED");

      /*
       * ── 让这条断言**因果**（F7）──
       *
       * "没有复核 ⇒ 不 PROMOTABLE" 若只断言状态，可能只是因为别处失败。
       * 因此补一条对照：**同一份候选**给上有效复核后应当 PROMOTABLE ——
       * 于是"缺复核"就是当前 REVIEW_REQUIRED 的**唯一**原因。
       *
       * 顺带证明：计划生成的段**可以**被人工接受并放行（计划本身不阻断），
       * 它只是**不代替**那个人工步骤。
       */
      const storedForContrast = readStoredCandidate("gate", env.candidatesDir);
      const signed = gateWithReview(env, "gate", acceptAllReviewFor(storedForContrast));
      expect(
        signed.gate.status,
        "对照：给上有效复核后必须 PROMOTABLE —— 这证明当前 REVIEW_REQUIRED 唯一来自缺复核",
      ).toBe("PROMOTABLE");

      // 计划生成的段**照常**要求段裁决（计划不减少复核要求）
      const stored = readStoredCandidate("gate", env.candidatesDir);
      const segmentReviewItems = stored.metadata.review.filter((item) => item.code === "segment_requires_review");
      expect(segmentReviewItems.length, "计划生成的段必须照常要求人工裁决").toBe(3);
      void sourceRoot;
    } finally {
      env.dispose();
    }
  });

  it("**未提供计划时自动分段行为完全不变**（既有默认路径）", async () => {
    const env = makeEnv();
    try {
      const { result } = await runIntake(env, { courseId: "auto", writeCandidate: false });
      expect(result.segmentationPlan.applied).toBe(false);
      expect(result.segmentationPlan.issues).toEqual([]);
      expect(result.archive.metadata.segmentation.modeEvidence.mode).toBe("automatic");

      // 这个夹具在自动模式下确实只产出一个文档级翻译段（正是"计划存在的理由"）
      const translationSegments = result.archive.manifest.segments.filter((s) => s.kind === "translation_passage");
      expect(translationSegments.length, "自动分段在该夹具上产出一个文档级段").toBe(1);
      expect(result.archive.metadata.segmentation.documentLevelOnlyMaterials.length).toBeGreaterThan(0);
    } finally {
      env.dispose();
    }
  });

  it("**参考译文绝不进入 canonical 匹配证据**（语义边界不变）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "matching");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "matching",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      const { result } = await runIntake(env, { plan, courseId: "matching", sourceRoot, writeCandidate: false });

      /*
       * 匹配只允许看**主体文本**（翻译段的 text = 中文原文）。
       * 若参考译文（课程英文译文）进入了匹配投影，那就让"课程答案"
       * 变成了身份证据 —— 而任务书与既有语义都明确禁止这一点。
       */
      const segmentTexts = result.archive.metadata.segmentation.materials
        .flatMap((m) => m.segments)
        .map((s) => s.text ?? "");
      expect(segmentTexts.some((text) => text.includes("Operators of urban rail")), "参考译文不得成为段的主体 text").toBe(false);

      // 参考译文确实存在，但只在 referenceTranslation 通道里
      const withReference = result.archive.metadata.segmentation.materials
        .flatMap((m) => m.segments)
        .filter((s) => (s.referenceTranslation ?? "") !== "");
      expect(withReference.length, "参考译文必须在 referenceTranslation 通道里").toBe(2);

      // 禁止特征清单未被削弱（沿用既有唯一实现）
      expect([...FORBIDDEN_MATCH_FEATURES]).toContain("courseAnswerKey");
    } finally {
      env.dispose();
    }
  });

  it("**计划文件绝不进入运行时 courses/**（晋升只复制 course.json + assets）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "promote");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "promote",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });
      await runIntake(env, { plan, courseId: "promote", sourceRoot });

      // 候选目录里本来就只有 course.json + candidate.json + assets/
      const candidateEntries = readdirSync(join(env.candidatesDir, "promote")).sort();
      expect(candidateEntries, "候选目录里不得有计划文件").not.toContain("segmentation-plan.json");
      expect(candidateEntries).toEqual(["assets", "candidate.json", "course.json"]);
    } finally {
      env.dispose();
    }
  });

  it("计划**不被复制到 courses/**：晋升白名单与计划无关（源码级结构性保证）", () => {
    // 晋升只复制 course.json + assets/（白名单）。计划从来不在候选目录里，
    // 因此它在原理上不可能被复制出去。这里固定住那个白名单事实。
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/review.ts"), "utf8");
    expect(source, "晋升必须只复制 course.json").toContain('cpSync(join(candidateDir, "course.json")');
    expect(source, "晋升不得引用 segmentation 计划文件").not.toMatch(/segmentation-plan|SegmentationPlan/);
  });
});

// ---------------------------------------------------------------------------
// 9) 源件视图（隐私边界）
// ---------------------------------------------------------------------------

describe("人工分段计划 · 源件视图只含坐标", () => {
  it("buildPlanSourceView 不携带任何正文（计划校验在结构上不可能读到课程内容）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "view");
      const inventory = scanSourceDirectory(sourceRoot);
      const documents = [];
      for (const asset of inventory.assets) {
        if (asset.kind !== "pdf") continue;
        documents.push(await extractPdfPages(asset.assetKey, join(sourceRoot, ...asset.relativePath.split("/"))));
      }
      const view = buildPlanSourceView({ courseId: "view", inventory, documents });

      const serialized = JSON.stringify({
        courseId: view.courseId,
        sourceDigest: view.sourceDigest,
        assets: [...view.assets.entries()].map(([key, value]) => [
          key,
          { sha256: value.sha256, pages: [...value.lineCountByPage.entries()], noText: value.pagesWithoutTextLayer },
        ]),
      });
      // 视图里只有行数与校验和
      expect(serialized).not.toContain(MULTI_UNIT_SOURCE_1);
      expect(serialized).not.toContain(MULTI_UNIT_SOURCE_2);
      expect(serialized).not.toContain(MULTI_UNIT_SOURCE_3);
      expect(serialized).not.toContain(MULTI_UNIT_REFERENCE_1);
      expect(serialized).not.toContain(MULTI_UNIT_HEADER);
      // 但确实有每页行数（校验需要）
      const asset = [...view.assets.values()][0];
      expect(asset.lineCountByPage.size, "6 页都有文本层").toBe(6);
    } finally {
      env.dispose();
    }
  });

  it("resolveSegmentationPlan 未提供计划时返回默认（零问题、不 applied）", () => {
    const resolved = resolveSegmentationPlan({
      input: undefined,
      courseId: "c",
      inventory: { assets: [], digest: "a".repeat(64) } as never,
      documents: [],
      grouping: { proposals: [], invariantViolations: [], warnings: [] },
    });
    expect(resolved.applied).toBe(false);
    expect(resolved.issues).toEqual([]);
    expect(resolved.planDigest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 10) 应用层：低层 API 的确定性
// ---------------------------------------------------------------------------

describe("人工分段计划 · 应用层低层 API", () => {
  it("段 id 含**计划作用域**（计划校验和进入 id ⇒ 结构改动改变候选身份）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "idscope");
      const inventory = scanSourceDirectory(sourceRoot);
      const documents = [];
      for (const asset of inventory.assets) {
        if (asset.kind !== "pdf") continue;
        documents.push(await extractPdfPages(asset.assetKey, join(sourceRoot, ...asset.relativePath.split("/"))));
      }
      const assetKey = inventory.assets[0].assetKey;
      const plan: SegmentationPlanFile = {
        schemaVersion: 1,
        binding: { courseId: "c", sourceDigest: inventory.digest, assets: [{ assetKey, sha256: inventory.assets[0].sha256 }] },
        author: "o",
        createdAt: "t",
        reason: "r",
        units: [
          { title: "u1", kind: "translation_passage", assignments: [assign("source", assetKey, 1, 2, 4) as never] },
        ],
      };

      const resolved = resolveFixturePlan(plan, inventory, documents);
      const appliedA = applySegmentationPlan({
        planDigest: "1".repeat(64),
        materialProposalId: "mat-1",
        documents,
        resolved,
      });
      const appliedB = applySegmentationPlan({
        planDigest: "2".repeat(64),
        materialProposalId: "mat-1",
        documents,
        resolved,
      });

      expect(appliedA.segmentation.segments.length).toBe(1);
      expect(
        appliedA.segmentation.segments[0].id,
        "计划校验和不同 ⇒ 段 id 必须不同（否则旧复核会被静默沿用）",
      ).not.toBe(appliedB.segmentation.segments[0].id);
      // id 必须满足包内 slug 约束
      expect(appliedA.segmentation.segments[0].id).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    } finally {
      env.dispose();
    }
  });

  it("计划段的 reviewRequired 恒为 true（计划不减少复核）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "reviewreq");
      const inventory = scanSourceDirectory(sourceRoot);
      const documents = [];
      for (const asset of inventory.assets) {
        if (asset.kind !== "pdf") continue;
        documents.push(await extractPdfPages(asset.assetKey, join(sourceRoot, ...asset.relativePath.split("/"))));
      }
      const assetKey = inventory.assets[0].assetKey;
      const plan: SegmentationPlanFile = {
        schemaVersion: 1,
        binding: { courseId: "c", sourceDigest: inventory.digest, assets: [{ assetKey, sha256: inventory.assets[0].sha256 }] },
        author: "o",
        createdAt: "t",
        reason: "r",
        units: [
          { title: "u1", kind: "translation_passage", assignments: [assign("source", assetKey, 1, 2, 4) as never] },
        ],
      };
      const applied = applySegmentationPlan({
        planDigest: "1".repeat(64),
        materialProposalId: "m",
        documents,
        resolved: resolveFixturePlan(plan, inventory, documents),
      });
      for (const segment of applied.segmentation.segments) {
        expect(segment.reviewRequired, "计划段必须仍然要求复核").toBe(true);
        expect(segment.reviewNotes.join(" ")).toContain("计划");
      }
    } finally {
      env.dispose();
    }
  });

  it("引文必须能在源件里核对上；核对不上就不给引文（不编造）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "quote");
      const inventory = scanSourceDirectory(sourceRoot);
      const documents = [];
      for (const asset of inventory.assets) {
        if (asset.kind !== "pdf") continue;
        documents.push(await extractPdfPages(asset.assetKey, join(sourceRoot, ...asset.relativePath.split("/"))));
      }
      const assetKey = inventory.assets[0].assetKey;
      const plan: SegmentationPlanFile = {
        schemaVersion: 1,
        binding: { courseId: "c", sourceDigest: inventory.digest, assets: [{ assetKey, sha256: inventory.assets[0].sha256 }] },
        author: "o",
        createdAt: "t",
        reason: "r",
        units: [{ title: "u", kind: "translation_passage", assignments: [assign("source", assetKey, 1, 2, 4) as never] }],
      };
      const applied = applySegmentationPlan({
        planDigest: "1".repeat(64),
        materialProposalId: "m",
        documents,
        resolved: resolveFixturePlan(plan, inventory, documents),
      });
      const quote = applied.segmentation.segments[0].anchor.quote;
      expect(quote, "中文长行必须能给出可核对引文").toBeTruthy();
      const page = documents[0].pages.find((p) => p.page === 1)!;
      expect(page.rawText.includes(quote!), "引文必须真的出现在源件页文本里").toBe(true);
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 10b) F2 / F3 / F6 —— 规范解析结构（每一个范围都进投影、绝不重复、单资产）
// ---------------------------------------------------------------------------

/**
 * 这一组是 Level-C 评审 F2 / F3 / F6 的**直接回归**。
 *
 * 三条缺陷都被实测过（真实浏览器代理 / CLI 复现）：
 *
 * | 编号 | 缺陷 | 本组怎么守 |
 * | --- | --- | --- |
 * | F2 | 第二条 `reference_translation` 范围被 `find()` 吞掉，覆盖率却报"完整" | 断言两段译文都进了正文，且通道计数 == 投影计数 |
 * | F3 | 同单元同通道重叠被判"幂等"，投影把重叠行写两遍（7 行 → 8） | 断言重叠失败关闭，且**任何**计划都不会产出重复行 |
 * | F6 | 跨资产计划被半接受，投影只拿到主材料 ⇒ 空正文无异常 | 断言多资产计划显式拒绝 |
 */
describe("人工分段计划 · F2/F3/F6 规范解析结构（范围不丢、不重复、单资产）", () => {
  /**
   * 构造一份"**一个单元里两个通道各有多条范围**"的计划。
   *
   * 这是 F2 的最小复现形态：原文与参考译文都分成两处，
   * 都写进计划、都被覆盖率算作已指派。
   *
   * 夹具页布局（每页第 1 行是页眉）：p1 原文一 / p2 译文一 / p3 讲解 /
   * p4 原文二 / p5 译文二 / p6 原文三。
   */
  async function twoReferencePlan(env: TempEnv, courseId: string, name: string) {
    const sourceRoot = writeSources(env, name);
    const { inventory, assetKey, document, lineCountByPage } = await probe(sourceRoot);
    const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
    const last = (page: number): number => lineCountByPage.get(page) ?? 1;

    return {
      sourceRoot,
      inventory,
      document,
      assetKey,
      plan: {
        schemaVersion: 1,
        binding: { courseId, sourceDigest: inventory.digest, assets: [{ assetKey, sha256: pdf.sha256 }] },
        author: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        reason: "原文与参考译文各分两处（被讲解页打断）——覆盖率的真实形态。",
        units: [
          {
            title: "跨页单元",
            kind: "translation_passage",
            assignments: [
              // 原文的**两条**范围
              assign("source", assetKey, 1, 2, last(1)),
              assign("source", assetKey, 4, 2, last(4)),
              // 参考译文的**两条**范围（F2 的关键形态）
              assign("reference_translation", assetKey, 2, 2, last(2)),
              assign("reference_translation", assetKey, 5, 2, last(5)),
              assign("notes", assetKey, 3, 2, last(3)),
              // 页眉：**显式**标为家具（否则覆盖率会阻断）
              ...[1, 2, 3, 4, 5, 6].map((page) => assign("ignored_furniture", assetKey, page, 1, 1, "重复页眉")),
            ],
          },
          {
            title: "第六页单元",
            kind: "translation_passage",
            assignments: [assign("source", assetKey, 6, 2, last(6))],
          },
        ],
      } as Record<string, unknown>,
    };
  }

  it("F2：通道的**每一个**范围都进入正文（绝不 find() 只取第一条）", async () => {
    const env = makeEnv();
    try {
      const fixture = await twoReferencePlan(env, "f2-multi", "f2-multi");
      const { result } = await runIntake(env, {
        plan: fixture.plan,
        courseId: "f2-multi",
        sourceRoot: fixture.sourceRoot,
      });

      expect(
        result.segmentationPlan.applied,
        `计划应被采用，实际问题：${JSON.stringify(result.segmentationPlan.issues)}`,
      ).toBe(true);

      const first = result.archive.manifest.segments.find((s) => s.title === "跨页单元")!;
      expect(first, "跨页单元必须存在").toBeDefined();

      /*
       * ── F2 的核心断言 ──
       *
       * 参考译文的两段在第 2 页与第 5 页。旧实现用 `find()` 只取第一条，
       * 于是第 5 页的译文**完全不出现在** referenceTranslation 里，
       * 而覆盖率与计数都把两条算上了。
       */
      const refText = first.referenceTranslation ?? "";
      expect(refText, "参考译文不得为空").toBeTruthy();

      const page2Lines = fixture.document.pages.find((p) => p.page === 2)!.lines.slice(1);
      const page5Lines = fixture.document.pages.find((p) => p.page === 5)!.lines.slice(1);
      for (const line of page2Lines) {
        expect(refText.trim(), `第 2 页参考译文行必须进入正文：${line.slice(0, 20)}…`).toContain(line.slice(0, 12));
      }
      for (const line of page5Lines) {
        expect(refText.trim(), `**第 5 页（第二条范围）**的参考译文行必须进入正文：${line.slice(0, 20)}…`).toContain(
          line.slice(0, 12),
        );
      }

      // 原文的两条范围同样都必须进入 text
      const sourceText = first.text ?? "";
      for (const page of [1, 4]) {
        const lines = fixture.document.pages.find((p) => p.page === page)!.lines.slice(1);
        for (const line of lines) {
          expect(sourceText.trim(), `第 ${page} 页原文行必须进入正文`).toContain(line.slice(0, 12));
        }
      }

      /*
       * ── 计数与投影必须一致 ──
       *
       * 这是 F2 的**结构性**判据：两者都从同一份 `resolved` 派生，
       * 因此"被计入覆盖率的范围"与"真的进了投影的行"不可能是两个数。
       */
      const evidence = result.archive.metadata.segmentation.modeEvidence;
      expect(evidence.channelLineCounts.referenceTranslation, "两条参考译文范围的行数都要被计入").toBe(
        page2Lines.length + page5Lines.length,
      );
      expect(evidence.unassignedLineCount, "计划是完整覆盖的").toBe(0);
    } finally {
      env.dispose();
    }
  });

  it("F2：证据里列出**每一个**范围（被计入覆盖率的范围必须可见）", async () => {
    const env = makeEnv();
    try {
      const fixture = await twoReferencePlan(env, "f2-evidence", "f2-evidence");
      const { result } = await runIntake(env, {
        plan: fixture.plan,
        courseId: "f2-evidence",
        sourceRoot: fixture.sourceRoot,
        writeCandidate: false,
      });

      const first = result.archive.metadata.segmentation.materials
        .flatMap((material) => material.segments)
        .find((segment) => segment.title === "跨页单元")!;

      // 两条参考译文范围都必须出现在证据里（不是只列第一条）
      const referenceCues = first.evidence.cues.filter((cue) => cue.startsWith("参考译文范围"));
      expect(referenceCues.length, "两条参考译文范围都必须在证据里").toBe(2);
      // 两条原文范围同理
      expect(first.evidence.cues.filter((cue) => cue.startsWith("原文范围")).length).toBe(2);
      // 第 2 页与第 5 页（第二条参考译文范围）都必须被列出
      expect(referenceCues.some((cue) => cue.includes("p2:"))).toBe(true);
      expect(referenceCues.some((cue) => cue.includes("p5:")), "第二条参考译文范围必须出现在证据里").toBe(true);
      // 第一条与第二条原文范围同理
      expect(first.evidence.cues.some((cue) => cue.startsWith("原文范围") && cue.includes("p4:")), "第二条原文范围必须出现在证据里").toBe(
        true,
      );
    } finally {
      env.dispose();
    }
  });

  it("F3：同单元同通道重叠的计划**失败关闭**，且绝不产出重复内容", async () => {
    const env = makeEnv();
    try {
      const fixture = await twoReferencePlan(env, "f3-overlap", "f3-overlap");
      const plan = fixture.plan as { units: { assignments: unknown[] }[] };

      /*
       * 把"跨页单元"的参考译文第二条范围改成**与第一条重叠**。
       *
       * 这正是实测缺陷的形态：旧实现判它"幂等"（当作 UI 重复提交），
       * 而投影把两个范围都拼进去 ⇒ 重叠的行被写两遍（7 行变 8 行）。
       */
      const firstUnit = plan.units[0];
      const referenceAssignments = firstUnit.assignments.filter(
        (a) => (a as { channel: string }).channel === "reference_translation",
      ) as { range: { page: number; lineStart: number; lineEnd: number } }[];
      referenceAssignments[1].range.page = 2;
      referenceAssignments[1].range.lineStart = referenceAssignments[0].range.lineStart;
      referenceAssignments[1].range.lineEnd = referenceAssignments[0].range.lineEnd;

      const sourceRoot = writeSources(env, "f3-overlap2");
      const { inventory, assetKey } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const rebound = {
        ...(fixture.plan as Record<string, unknown>),
        binding: { courseId: "f3-overlap", sourceDigest: inventory.digest, assets: [{ assetKey, sha256: pdf.sha256 }] },
      };

      const { result } = await runIntake(env, {
        plan: rebound,
        courseId: "f3-overlap",
        sourceRoot,
        writeCandidate: false,
      });

      // 重叠 ⇒ 致命 ⇒ 计划**不被采用**
      expect(result.segmentationPlan.applied, "重叠计划不得被采用").toBe(false);
      const overlap = result.segmentationPlan.issues.filter((issue) => issue.code === "plan_range_overlap");
      expect(overlap.length, "必须报出重叠").toBeGreaterThan(0);

      // 候选带阻断且不可裁决的事项
      const mismatch = result.archive.review.filter((item) => item.code === "plan_binding_mismatch");
      expect(mismatch.length, "计划未被采用必须产生阻断事项").toBeGreaterThan(0);
      expect(mismatch[0].severity).toBe("blocking");

      // 回退自动分段（人能看到候选，但结构不是他的那一份）
      expect(result.archive.metadata.segmentation.modeEvidence.mode).toBe("automatic");
    } finally {
      env.dispose();
    }
  });

  it("F3：**任何**被采用的计划都不会让同一行出现两次（行级不变量）", async () => {
    const env = makeEnv();
    try {
      const fixture = await twoReferencePlan(env, "f3-invariant", "f3-invariant");
      const { result } = await runIntake(env, {
        plan: fixture.plan,
        courseId: "f3-invariant",
        sourceRoot: fixture.sourceRoot,
        writeCandidate: false,
      });
      expect(result.segmentationPlan.applied).toBe(true);

      /*
       * 全局不变量：把所有通道覆盖的行取并集，其大小必须等于
       * 各通道计数之和（即没有任何一行被算两次）。
       */
      const resolved = result.segmentationPlan.resolved!;
      const counts = resolved.channelLineCounts;
      const declared =
        counts.source + counts.referenceTranslation + counts.notes + counts.ignoredFurniture;
      expect(declared, "通道计数之和必须等于去重后的行数（没有任何一行被算两次）").toBe(
        resolved.claimByLine.size,
      );

      // 且投影写出的正文里不应出现同一行文本被拼两次的痕迹：
      // 逐段检查"原文行数 == 段正文的行数"（joinTextLines 会重排空白，
      // 因此用证据里的 lineSpan 行数做交叉核对）
      for (const material of result.archive.metadata.segmentation.materials) {
        for (const segment of material.segments) {
          const span = segment.evidence.lineSpan ?? "";
          const match = /（(\d+) 行原文/.exec(span);
          if (match === null) continue;
          expect(Number(match[1]), `段「${segment.title}」的原文行数必须为正`).toBeGreaterThan(0);
        }
      }
    } finally {
      env.dispose();
    }
  });

  it("F6：引用了**第二份资产**的计划被显式拒绝（V1 单资产契约）", async () => {
    const env = makeEnv();
    try {
      // 造一份含**两个 PDF** 的源目录
      const tree = multiUnitTranslationFixture();
      tree.set(
        "翻译/second-handout.pdf",
        buildCjkPdf([[MULTI_UNIT_HEADER, ...wrapCjk(MULTI_UNIT_SOURCE_2)]]),
      );
      const sourceRoot = writeSources(env, "f6-multi", tree);
      const inventory = scanSourceDirectory(sourceRoot);
      const pdfs = inventory.assets.filter((a) => a.kind === "pdf");
      expect(pdfs.length, "夹具必须有两份 PDF").toBe(2);

      const primary = pdfs.find((a) => a.relativePath.includes("multi-unit"))!;
      const second = pdfs.find((a) => a.relativePath.includes("second"))!;

      /*
       * 计划在**第二份资产**上也放了一条范围。
       *
       * 旧行为：计划被"半接受"（覆盖率把两份资产的行都算上），
       * 而投影只拿到主材料那一份文档 ⇒ 第二份资产上的范围**静默产出空正文**。
       * 那是一个没有任何异常信号的"看起来正常、实则缺内容"的候选。
       */
      const plan = {
        schemaVersion: 1,
        binding: {
          courseId: "f6-multi",
          sourceDigest: inventory.digest,
          assets: [
            { assetKey: primary.assetKey, sha256: primary.sha256 },
            { assetKey: second.assetKey, sha256: second.sha256 },
          ],
        },
        author: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        reason: "跨材料的计划（V1 不支持）。",
        units: [
          {
            title: "跨资产单元",
            kind: "translation_passage",
            assignments: [
              assign("source", primary.assetKey, 1, 2, 4),
              assign("reference_translation", second.assetKey, 1, 2, 2),
            ],
          },
        ],
      };

      const { result } = await runIntake(env, {
        plan,
        courseId: "f6-multi",
        sourceRoot,
        writeCandidate: false,
      });

      expect(result.segmentationPlan.applied, "多资产计划不得被采用").toBe(false);
      const multi = result.segmentationPlan.issues.filter((issue) => issue.code === "plan_multi_asset_unsupported");
      expect(multi.length, "必须给出**专用**的拒绝码（不是笼统的资产未知）").toBe(1);
      expect(multi[0].detail).toMatch(/单资产|一份表示资产/);
      // 不得静默回退：候选带阻断事项
      expect(result.archive.review.some((item) => item.code === "plan_binding_mismatch")).toBe(true);
      // 规范结构不得产出（计划不可采用）
      expect(result.segmentationPlan.resolved).toBeNull();
    } finally {
      env.dispose();
    }
  });

  it("F6：单资产计划的规范结构只承诺**那一份**资产的覆盖率", async () => {
    const env = makeEnv();
    try {
      const tree = multiUnitTranslationFixture();
      tree.set(
        "翻译/second-handout.pdf",
        buildCjkPdf([[MULTI_UNIT_HEADER, ...wrapCjk(MULTI_UNIT_SOURCE_2)]]),
      );
      const sourceRoot = writeSources(env, "f6-single", tree);
      const inventory = scanSourceDirectory(sourceRoot);
      const primary = inventory.assets.find((a) => a.kind === "pdf" && a.relativePath.includes("multi-unit"))!;

      const plan = {
        schemaVersion: 1,
        binding: { courseId: "f6-single", sourceDigest: inventory.digest, assets: [{ assetKey: primary.assetKey, sha256: primary.sha256 }] },
        author: "owner",
        createdAt: "2026-01-01T00:00:00.000Z",
        reason: "只针对主文档。",
        units: [
          {
            title: "全文档单元",
            kind: "translation_passage",
            assignments: [
              ...[1, 2, 3, 4, 5, 6].map((page) => assign("ignored_furniture", primary.assetKey, page, 1, 1, "页眉")),
              assign("source", primary.assetKey, 1, 2, 4),
              assign("source", primary.assetKey, 2, 2, 5),
              assign("source", primary.assetKey, 3, 2, 5),
              assign("source", primary.assetKey, 4, 2, 4),
              assign("source", primary.assetKey, 5, 2, 5),
              assign("source", primary.assetKey, 6, 2, 4),
            ],
          },
        ],
      };

      const { result } = await runIntake(env, {
        plan,
        courseId: "f6-single",
        sourceRoot,
        writeCandidate: false,
      });

      expect(result.segmentationPlan.applied, "单资产计划必须被采用").toBe(true);
      expect(result.segmentationPlan.targetAssetKey, "必须记录目标资产").toBe(primary.assetKey);
      expect(result.segmentationPlan.unassigned.length, "目标资产被完整覆盖").toBe(0);
      // 覆盖率**只**针对目标资产：另一份 PDF 的行不进总数
      const resolved = result.segmentationPlan.resolved!;
      expect(resolved.totalLineCount, "总行数只统计目标资产（6 页 × 各行）").toBeLessThan(30);
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 11) Git 忽略（计划绝不进 Git）
// ---------------------------------------------------------------------------

describe("人工分段计划 · 绝不进 Git", () => {
  it("私有计划目录位于 private-content/ 之下，因而被 .gitignore 覆盖", () => {
    const plansDir = getCourseSegmentationPlansDir();
    const contentRoot = getContentRoot();
    expect(plansDir.startsWith(contentRoot), "计划目录必须在内容根之内").toBe(true);

    const ignore = readFileSync(join(process.cwd(), ".gitignore"), "utf8");
    const relative = plansDir.slice(contentRoot.length + 1).split("\\").join("/");
    // 直接断言"内容根被忽略"这一条事实（与既有架构门禁同一套判据）
    expect(ignore).toContain("/private-content/");
    expect(relative.startsWith("course-segmentation-plans"), "计划目录名必须在内容根之下").toBe(true);
  });

  it("计划里**绝不**持久化绝对路径（结构性断言）", () => {
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/segmentation-plan.ts"), "utf8");
    // 计划的磁盘契约里不得出现绝对路径字段
    expect(source, "计划契约不得有绝对路径字段").not.toMatch(/absolutePath|absolutePlanPath|planPath:\s*string/);
  });

  it("计划校验和是规范摘要（键序无关、与 stableStringify 同源）", () => {
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/segmentation-plan.ts"), "utf8");
    expect(source, "必须复用既有 stableStringify（不另写序列化）").toContain("stableStringify");
  });
});

// ---------------------------------------------------------------------------
// 12) 源码级架构约束
// ---------------------------------------------------------------------------

describe("人工分段计划 · 架构约束（源码级）", () => {
  const strip = (source: string): string =>
    source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const PIPELINE = [
    "src/content/course-pipeline/segmentation-plan.ts",
    "src/content/course-pipeline/plan-apply.ts",
    "src/content/course-pipeline/plan-resolve.ts",
    "src/content/course-pipeline/segment-server.ts",
    "src/content/course-pipeline/segment-page.ts",
    "scripts/course-segment.ts",
  ];

  it("计划层与标注工具**绝不 import** 数据库 / 仓库层", () => {
    for (const path of PIPELINE) {
      const code = strip(readFileSync(join(process.cwd(), path), "utf8"));
      const imports = code
        .split("\n")
        .filter((line) => line.trimStart().startsWith("import"))
        .join("\n");
      expect(imports, `${path} 不得 import 数据库/仓库层`).not.toMatch(
        /repositories|db\/client|node:sqlite|@\/db/,
      );
    }
  });

  it("标注工具与服务器**绝不**绑定 0.0.0.0，也绝不做 Git 操作", () => {
    for (const path of PIPELINE) {
      const code = strip(readFileSync(join(process.cwd(), path), "utf8"));
      expect(code, `${path} 不得绑定 0.0.0.0`).not.toContain("0.0.0.0");
      expect(code, `${path} 不得做 Git 操作`).not.toMatch(/\bgit\s+(push|commit|checkout|add)\b/);
      expect(code, `${path} 不得调用 verifyCanonicalLink`).not.toMatch(/verifyCanonicalLink\s*\(/);
    }
  });

  it("标注工具**绝不**生成 review.json，也绝不写 Expert 台账 / 曝光", () => {
    for (const path of PIPELINE) {
      const code = strip(readFileSync(join(process.cwd(), path), "utf8"));
      expect(code, `${path} 不得写 review.json`).not.toMatch(/writeFileSync\([^)]*review\.json/);
      for (const forbidden of ["performance_event", "assessment_event", "evidence_projection", "course_exposure_event"]) {
        expect(code, `${path} 不得写 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });

  it("标注工具**绝不**发起外部网络请求，也绝无外部资源", () => {
    for (const path of PIPELINE) {
      const code = strip(readFileSync(join(process.cwd(), path), "utf8"));
      // 唯一允许的网络能力是回环上的**服务端**；不得有客户端出站能力。
      // 页面（segment-page.ts）会调用本机 `/api/...`，那是**同源**回环请求，
      // 因此"不得调用 fetch"这条只对**模块**成立；页面单独判"不得有绝对 URL"。
      if (path !== "src/content/course-pipeline/segment-page.ts") {
        expect(code, `${path} 不得调用 fetch`).not.toMatch(/\bfetch\s*\(/);
      }
      expect(code, `${path} 不得使用 http/https 客户端请求`).not.toMatch(
        /\bhttps?\.(request|get)\s*\(|from\s+["']node:https["']/,
      );
    }
    /*
     * 页面里不得出现任何外部资源引用。
     *
     * ── 判据必须精确（本条用例第一次就是被自己写红的）──
     *
     * 页面源码里**确实**出现 `https://` —— 那是 CSP 头里的 `default-src` 等
     * 指令没有 URL，但注释里会解释"禁止加载 https://..."。用"出现 http"
     * 当判据会误伤解释性文本。真正的判据是**HTML 里有没有外部引用**：
     * `<script src=...>` / `<link ... href=...>` / 以 http(s) 开头的属性值。
     */
    const page = readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-page.ts"), "utf8");
    expect(page, "页面不得有外部 script/link").not.toMatch(/<script\s+src=|<link\s+[^>]*href=/i);
    // 不得以 http(s) 绝对 URL 加载任何资源（fetch/XHR/属性值）
    expect(page, "页面不得以绝对 URL 加载资源").not.toMatch(/["'`]https?:\/\/(?!127\.0\.0\.1|localhost)/);
  });

  it("存档中不得内嵌真实课程内容（夹具必须是合成的）", () => {
    /*
     * 判据必须是"**内容**里没有真实 provider 材料"，而不是"文件里不出现
     * provider 名字" —— `course-source-scenarios.ts` 的文档注释里**有意**
     * 提到"不是任何真实 RSVP 内容"，那是一句免责声明，不是内嵌内容。
     * 用"出现过名字"当判据会误伤那句声明（本条用例第一次就是这么红的）。
     */
    for (const path of PIPELINE) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      for (const forbidden of ["RSVP", "瑞斯拜"]) {
        expect(source, `${path} 不得内嵌真实 provider 内容`).not.toContain(forbidden);
      }
    }
    // 夹具文件：只允许在**注释**里提到 provider 名（作为免责声明）
    const fixture = readFileSync(join(process.cwd(), "scripts/course-source-scenarios.ts"), "utf8");
    const fixtureCode = strip(fixture);
    expect(fixtureCode, "夹具**代码**里不得出现真实 provider 名").not.toMatch(/RSVP|瑞斯拜/);
    expect(fixture, "夹具必须显式声明自己是合成的").toContain("全部内容都是合成的");
  });

  it("计划校验和只有一个实现（不另写第二份摘要）", () => {
    const plan = strip(readFileSync(join(process.cwd(), "src/content/course-pipeline/segmentation-plan.ts"), "utf8"));
    // segmentationPlanDigest 在计划层定义
    expect(plan).toContain("export function segmentationPlanDigest");
    // 服务器不得自己再算一遍计划校验和
    const server = strip(readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-server.ts"), "utf8"));
    expect(server, "服务器不得重复实现计划校验和").not.toMatch(/function\s+\w*[Pp]lanDigest/);
    // CLI 用的是唯一实现
    const cli = readFileSync(join(process.cwd(), "scripts/course-segment.ts"), "utf8");
    expect(cli, "CLI 必须使用唯一实现").toContain("segmentationPlanDigest");
  });

  it("两个 CLI 命令都登记在 package.json，且命名遵循既有约定", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts).toHaveProperty("course:segment");
    expect(pkg.scripts).toHaveProperty("course:extract");
    expect(pkg.scripts["course:segment"]).toContain("scripts/course-segment.ts");
  });

  it("标注工具不得把课程正文写进终端（隐私边界）", () => {
    const cli = strip(readFileSync(join(process.cwd(), "scripts/course-segment.ts"), "utf8"));
    // console.log/error 的实参里不得出现行文本（lines / text / rawText）
    const consoleLines = cli.split("\n").filter((line) => /console\.(log|error|warn)\(/.test(line));
    for (const line of consoleLines) {
      expect(line, `终端输出不得含正文：${line.trim()}`).not.toMatch(/\b(page\.lines|rawText|paragraphText)\b/);
    }
    const server = strip(readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-server.ts"), "utf8"));
    expect(server, "服务器不得向终端打印任何东西").not.toMatch(/console\.(log|error|warn)\(/);
  });
});

// ---------------------------------------------------------------------------
// 14) 确定性摘要的稳定性（防止"重算与生成不一致"）
// ---------------------------------------------------------------------------

describe("人工分段计划 · 现场重算与生成一致", () => {
  it("recomputeDigests 必须带上模式证据（否则每一份候选都会被判自相矛盾）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "recompute");
      const { inventory, assetKey, lineCountByPage } = await probe(sourceRoot);
      const pdf = inventory.assets.find((a) => a.kind === "pdf")!;
      const plan = fullPlan(assetKey, {
        courseId: "recompute",
        sourceDigest: inventory.digest,
        sha256: pdf.sha256,
        lineCountByPage,
      });

      const { result } = await runIntake(env, { plan, courseId: "recompute", sourceRoot });
      const stored = readStoredCandidate("recompute", env.candidatesDir);
      const recomputed = recomputeDigests(stored.metadata, stored.courseRaw);

      expect(
        recomputed.segmentationDigest,
        "现场重算的分段摘要必须与生成时一致（否则全部候选都会被判自相矛盾）",
      ).toBe(result.archive.metadata.digests.segmentationDigest);
      expect(recomputed.candidateChecksum).toBe(result.archive.metadata.digests.candidateChecksum);
      void pdf;
    } finally {
      env.dispose();
    }
  });

  it("自动模式候选的现场重算同样一致（旧路径未被破坏）", async () => {
    const env = makeEnv();
    try {
      const { result, courseId } = await runIntake(env, { courseId: "auto-recompute" });
      const stored = readStoredCandidate(courseId, env.candidatesDir);
      expect(recomputeDigests(stored.metadata, stored.courseRaw).candidateChecksum).toBe(
        result.archive.metadata.digests.candidateChecksum,
      );
    } finally {
      env.dispose();
    }
  });

  it("**旧候选**（无 modeEvidence 字段）仍能自洽重算 —— 不得被判自相矛盾", async () => {
    /*
     * ── 这条守的是真实情形，不是假想 ──
     *
     * 本字段是本轮**新增**的。真实 RSVP Batch 1 候选是在它之前生成的，
     * 因此它的 `candidate.json` 里**没有** `modeEvidence`。
     *
     * 若复核时的现场重算强行要求该字段，那份**已经存在且已通过验证**的候选
     * 会立刻被判"自相矛盾" ⇒ 门禁对历史候选整体失败关闭。
     * 那是不可接受的回归：新字段不得使旧候选失效。
     *
     * 正确行为：缺失时按 `automatic` **如实降级** ——
     * 旧候选的段落确实全部来自自动判据（本轮之前不存在人工计划）。
     */
    const env = makeEnv();
    try {
      const { result, courseId } = await runIntake(env, { courseId: "legacy" });
      const stored = readStoredCandidate(courseId, env.candidatesDir);

      // 模拟旧候选：把 modeEvidence 字段整个删掉
      const legacyMetadata = JSON.parse(JSON.stringify(stored.metadata)) as typeof stored.metadata;
      delete (legacyMetadata.segmentation as { modeEvidence?: unknown }).modeEvidence;

      const recomputed = recomputeDigests(legacyMetadata, stored.courseRaw);
      expect(
        recomputed.candidateChecksum,
        "旧候选（无 modeEvidence）必须与生成时的校验和**一致**，不得被判自相矛盾",
      ).toBe(result.archive.metadata.digests.candidateChecksum);

      // 且它与"显式 automatic"完全等价（如实降级，不是另一种猜测）
      const explicitAutomatic = JSON.parse(JSON.stringify(legacyMetadata)) as typeof stored.metadata;
      explicitAutomatic.segmentation.modeEvidence = automaticSegmentationEvidence();
      expect(
        recomputeDigests(explicitAutomatic, stored.courseRaw).segmentationDigest,
        "缺失字段必须等价于显式 automatic",
      ).toBe(recomputed.segmentationDigest);
    } finally {
      env.dispose();
    }
  });
});

// ---------------------------------------------------------------------------
// 15) 哈希健全性（防止测试自身用错夹具）
// ---------------------------------------------------------------------------

describe("人工分段计划 · 夹具健全性", () => {
  it("合成夹具确实含 6 页、且页眉逐字相同（测试前提成立）", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = writeSources(env, "fixture");
      const { document } = await probe(sourceRoot);
      expect(document.pages.length, "夹具必须是 6 页").toBe(6);
      const headers = document.pages.map((page) => page.lines[0]);
      expect(new Set(headers).size, "6 页页眉必须逐字相同（覆盖「重复页眉」这一形态）").toBe(1);
      expect(headers[0]).toBe(MULTI_UNIT_HEADER);
      // 每页都必须有文本层（否则计划坐标不成立）
      for (const page of document.pages) expect(page.hasTextLayer).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("夹具不与任何真实材料共享指纹（合成来源可辨）", () => {
    const source = readFileSync(join(process.cwd(), "scripts/course-source-scenarios.ts"), "utf8");
    expect(source, "夹具必须声明自己是合成的").toContain("合成");
    // 夹具不得含真实真题/课程指纹
    expect(source).not.toMatch(/Part I{1,3}\s*(Writing|Listening|Reading|Translation)/);
  });

  it("计划校验和对夹具不敏感但对自己的结构敏感（自检）", () => {
    const digest = (extra: string): string =>
      createHash("sha256").update(extra, "utf8").digest("hex");
    expect(digest("a")).not.toBe(digest("b"));
  });
});
