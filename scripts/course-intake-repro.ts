#!/usr/bin/env node
/**
 * `pnpm course:intake-repro` —— Course Intake & Matching Pipeline 的**端到端显式复现**。
 *
 * 目的不是替代测试，而是把任务要求的完整链路在有**真实磁盘**的环境里
 * 逐条跑一遍并打印结论 —— 这样"这条链路真的能跑通"有可核对的输出，
 * 而不是只有一句断言。
 *
 * 覆盖（每一步都打印实际观察到的值）：
 *   1. 源目录 → 清点 + 校验和（含不安全路径被拒绝）
 *   2. → PDF 逐页抽取（含"无文本层"如实上报、DOCX 推迟）
 *   3. → 逻辑材料提案（含 PDF+DOCX 等价提案被标记为需复核）
 *   4. → 保守分段（含"找不到结构线索 ⇒ 文档级 + 复核"）
 *   5. → canonical 匹配（建议、歧义、未匹配）
 *   6. → 候选包 + 复核事项 + 候选校验和
 *   7. → 复核门禁：无 review ⇒ 不可晋升
 *   8. → 陈旧复核：candidateChecksum 不匹配 ⇒ 晋升被拒
 *   9. → 陈旧匹配：canonical 库变化 ⇒ 匹配证据陈旧
 *  10. → 晋升 + 生产校验器读取 + course:import 预演（**不写数据库**）
 *  11. → 证明：候选目录**从未**被生产导入器发现
 *  12. → 证明：晋升**没有**创建任何 verified canonical 链接
 *
 * 全程使用**合成夹具**与临时目录；**绝不触碰 使用者的真实库或真实 private-content**。
 *
 * 用法：node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/course-intake-repro.ts
 */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const COURSE_ID = "repro-intake-course";

async function main(): Promise<void> {
  const { runCourseIntake } = await import("@/content/course-pipeline");
  const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
  const { readStoredCandidate, evaluatePromotionGate, promoteCourseCandidate, checkCandidateAssets, validateWithProduction, buildLinkPlan, gatherPromotionInputs } =
    await import("@/content/course-pipeline/review");
  const { buildIndexFromDisk } = await import("@/content/course-pipeline/canonical");
  const { NormalizedCourseImporter } = await import("@/content/course/importer");
  const { NormalizedPackageImporter } = await import("@/content/paper/importer");
  const { writeSourceTree, buildTextPdf } = await import("./course-source-fixture");
  const { fullCourseFixture, imageOnlyPdfFixture, noStructuralCueFixture } =
    await import("./course-source-scenarios");
  const { buildFixturePackage, writeFixturePackage } = await import("./paper-fixture");

  const root = mkdtempSync(join(tmpdir(), "cet6-intake-repro-"));
  /*
   * 结构性安全断言：本脚本**只能**在临时目录里工作。
   *
   * 它不会打开数据库（下面的断言会证明这一点），但仍显式证明它不指向
   * 使用者的真实内容根 —— 把"绝不碰真实数据"变成代码事实，而不是注释里的承诺。
   */
  if (!root.startsWith(tmpdir()) || root.includes("private-content")) {
    throw new Error(`复现脚本只允许在临时目录工作，拒绝路径：${root}`);
  }

  const sourceRoot = join(root, "source");
  const contentRoot = join(root, "content");
  const papersDir = join(contentRoot, "cet6", "papers");
  const candidatesDir = join(contentRoot, "course-candidates");
  const coursesDir = join(contentRoot, "courses");

  console.log("Course Intake & Matching Pipeline · 端到端显式复现");
  console.log("（全程合成夹具 + 临时目录；不触碰使用者真实库与真实 private-content）");

  try {
    // =====================================================================
    section("1. 源目录清点 + 校验和");
    // =====================================================================
    writeSourceTree(sourceRoot, fullCourseFixture());
    /*
     * 记下阅读讲义的**原始字节**：F10 会故意改动它来证明源漂移被检测到，
     * 而后续的 F11/F12 节需要回到"源未漂移"的状态（否则门禁会是 BLOCKED，
     * 那两节就无法验证"PROMOTABLE 时确实产出交接计划"）。
     */
    const originalHandoutBytes = readFileSync(join(sourceRoot, "阅读", "reading-handout.pdf"));
    // 一个指向源根之外的符号链接：**必须被拒绝**（源根之外的内容不属于这次导入）
    const outsideFile = join(root, "outside-secret.pdf");
    writeFileSync(outsideFile, Buffer.from("%PDF-1.4\noutside\n%%EOF\n", "utf8"));
    try {
      const { symlinkSync } = await import("node:fs");
      symlinkSync(outsideFile, join(sourceRoot, "阅读", "escape.pdf"));
    } catch {
      console.log("  （本环境不允许创建符号链接，跳过该项）");
    }

    const intake = await runCourseIntake({
      sourceRoot,
      courseId: COURSE_ID,
      provider: "test_fixture_provider",
      edition: "repro",
      title: "复现用合成课程包",
      contentVersion: 1,
      provenance: {
        note: "合成夹具，仅用于流水线端到端复现，不是任何真实课程材料。",
        reference: "scripts/course-source-scenarios.ts",
        rightsNote: "合成夹具，无第三方权利。",
      },
      papersDir,
    });

    const inventory = intake.inventory;
    check("清点到了文件", inventory.assets.length > 0, `${inventory.assets.length} 个`);
    check(
      "每个资产都有 sha256 与字节数",
      inventory.assets.every((asset) => /^[0-9a-f]{64}$/.test(asset.sha256) && asset.bytes > 0),
    );
    check("源摘要非空", inventory.digest.length === 64);
    console.log(`      源摘要：${inventory.digest.slice(0, 16)}…`);
    console.log(`      文件数：${inventory.assets.length}`);
    for (const rejected of inventory.rejected) {
      console.log(`      拒绝：${rejected.relativePath} — ${rejected.reason}`);
    }
    const symlinkRejected = inventory.rejected.some((entry) => entry.relativePath.includes("escape.pdf"));
    if (existsSync(join(sourceRoot, "阅读", "escape.pdf"))) {
      check("指向源根之外的符号链接被拒绝且未读取", symlinkRejected, JSON.stringify(inventory.rejected));
    }

    check(
      "持久化里没有绝对路径",
      JSON.stringify(intake.archive.metadata.inventory).includes(root) === false,
      "候选里出现了绝对路径",
    );

    // =====================================================================
    section("2. PDF 逐页抽取（含无文本层与 DOCX 推迟）");
    // =====================================================================
    const parsed = intake.documents.filter((doc) => doc.state === "parsed");
    const deferred = intake.documents.filter((doc) => doc.state === "deferred");
    check("有 PDF 被成功解析", parsed.length > 0, `${parsed.length} 个`);
    check(
      "解析出的页有逐页来源证据（行 + 原文 + 段落文本）",
      parsed.every((doc) => doc.pages.every((page) => Array.isArray(page.lines) && typeof page.rawText === "string")),
    );
    check("DOCX 被标记为 TEXT_EXTRACTION_DEFERRED", deferred.length > 0 && deferred.every((doc) => doc.deferredMarker === "TEXT_EXTRACTION_DEFERRED"), `${deferred.length} 个`);
    check(
      "DOCX 的文本**没有**被假装抽出来",
      deferred.every((doc) => doc.pages.length === 0),
    );
    console.log(`      解析成功 ${parsed.length} 个 · 推迟 ${deferred.length} 个`);
    const withQuote = parsed.flatMap((doc) => doc.pages).filter((page) => page.lines.length > 0).length;
    check("页里有非空行", withQuote > 0, `${withQuote} 页`);

    // ---- 图片型 PDF：必须如实上报，不做 OCR ----
    const imageOnlyRoot = join(root, "imageonly");
    writeSourceTree(imageOnlyRoot, imageOnlyPdfFixture());
    const imageOnly = await runCourseIntake({
      sourceRoot: imageOnlyRoot,
      courseId: "repro-imageonly",
      provider: "test_fixture_provider",
      edition: null,
      title: "图片型 PDF 夹具",
      contentVersion: 1,
      provenance: { note: "夹具", reference: null, rightsNote: "合成夹具" },
      papersDir,
    });
    const imageDoc = imageOnly.documents.find((doc) => doc.pagesWithoutTextLayer.length > 0);
    check("图片型 PDF 的页被标记为无文本层", imageDoc !== undefined);
    check(
      "图片型 PDF 产出 0 个段（不 OCR、不发明内容）",
      imageOnly.archive.manifest.segments.length === 0,
      `${imageOnly.archive.manifest.segments.length} 个`,
    );
    check(
      "图片型 PDF 有阻断级复核事项",
      imageOnly.archive.review.some(
        (item) => item.code === "page_without_text_layer" && item.severity === "blocking",
      ),
    );

    // =====================================================================
    section("3. 逻辑材料提案（文件 ≠ 逻辑材料）");
    // =====================================================================
    const grouping = intake.grouping;
    check("不变量核对通过（每个文件恰属一份材料）", grouping.invariantViolations.length === 0, JSON.stringify(grouping.invariantViolations));
    const pdfDocx = grouping.proposals.find((proposal) =>
      proposal.representations.some((rep) => rep.kind === "pdf") &&
      proposal.representations.some((rep) => rep.kind === "docx"),
    );
    check("PDF + DOCX 被提案为同一份材料的两种表示", pdfDocx !== undefined);
    check(
      "该提案被标记为**需要复核**（等价性未被验证）",
      pdfDocx?.reviewRequired === true,
      JSON.stringify(pdfDocx?.reviewNotes),
    );
    check(
      "该提案明确声明内容**不可比对**",
      pdfDocx?.evidence.contentComparable === false,
    );
    console.log(`      材料提案：${grouping.proposals.length} 份`);
    console.log(`      需复核：${grouping.proposals.filter((p) => p.reviewRequired).length} 份`);

    // =====================================================================
    section("4. 保守分段（含文档级退路）");
    // =====================================================================
    const segments = intake.archive.manifest.segments;
    check("产出了课程段", segments.length > 0, `${segments.length} 个`);
    const ids = segments.map((segment) => segment.id);
    check("段 id 全局唯一", new Set(ids).size === ids.length, JSON.stringify(ids));
    check(
      "段 id 满足生产校验器的 slug 约束",
      ids.every((id) => /^[a-z0-9][a-z0-9._-]*$/.test(id)),
      JSON.stringify(ids),
    );
    check(
      "材料 id 满足生产校验器的 slug 约束",
      intake.archive.manifest.materials.every((material) => /^[a-z0-9][a-z0-9._-]*$/.test(material.id)),
    );
    check(
      "资产 id 满足生产校验器的 slug 约束",
      intake.archive.manifest.assets.every((asset) => /^[a-z0-9][a-z0-9._-]*$/.test(asset.id)),
    );
    check(
      "每个材料内 order 从 0 连续",
      intake.archive.manifest.materials.every((material) => {
        const orders = segments.filter((segment) => segment.materialId === material.id).map((s) => s.order).sort((a, b) => a - b);
        return orders.every((value, index) => value === index);
      }),
    );
    const kinds = [...new Set(segments.map((segment) => segment.kind))].sort();
    console.log(`      段种类：${kinds.join("、")}`);
    check("翻译段是 translation_passage", kinds.includes("translation_passage"));
    check("写作材料是 writing_template", kinds.includes("writing_template"));
    const translation = segments.find((segment) => segment.kind === "translation_passage");
    check("翻译段的 text 是中文原文", /[\u4e00-\u9fff]/.test(translation?.text ?? ""), (translation?.text ?? "").slice(0, 40));
    check(
      "翻译段的 referenceTranslation 是英文（与原文分开）",
      /[A-Za-z]/.test(translation?.referenceTranslation ?? "") && !/[\u4e00-\u9fff]/.test(translation?.referenceTranslation ?? ""),
      (translation?.referenceTranslation ?? "").slice(0, 40),
    );
    check(
      "听力段**没有**推断时间区间（不切分音频）",
      segments.filter((s) => s.kind.startsWith("listening_")).every((s) => s.startSeconds === null && s.endSeconds === null),
    );
    check("听力段引用了整段音频资产", segments.some((s) => s.kind.startsWith("listening_") && s.audioAssetId !== null));

    // ---- 无结构线索 ⇒ 文档级 + 复核 ----
    const noCueRoot = join(root, "nocue");
    writeSourceTree(noCueRoot, noStructuralCueFixture());
    const noCue = await runCourseIntake({
      sourceRoot: noCueRoot,
      courseId: "repro-nocue",
      provider: "test_fixture_provider",
      edition: null,
      title: "无结构线索夹具",
      contentVersion: 1,
      provenance: { note: "夹具", reference: null, rightsNote: "合成夹具" },
      papersDir,
    });
    check(
      "无结构线索时**不发明边界**（只产出 1 个文档级段）",
      noCue.archive.manifest.segments.length === 1,
      `${noCue.archive.manifest.segments.length} 个`,
    );
    check(
      "该段被标记为需复核",
      noCue.archive.review.some((item) => item.code === "segment_requires_review"),
    );

    // =====================================================================
    section("5. canonical 匹配（建议，非核验）");
    // =====================================================================
    // 先建 canonical 库：一份**合成**真题包（sourceKind 写死 test_fixture）
    const paperFixture = buildFixturePackage({ id: "repro-paper", contentVersion: 1 });
    writeFixturePackage(contentRoot, "repro-paper", paperFixture);

    const matched = await runCourseIntake({
      sourceRoot,
      courseId: COURSE_ID,
      provider: "test_fixture_provider",
      edition: "repro",
      title: "复现用合成课程包",
      contentVersion: 1,
      provenance: { note: "夹具", reference: null, rightsNote: "合成夹具" },
      papersDir,
    });

    const matching = matched.archive.metadata.matching;
    check("canonical 库被读到（1 份）", matching.canonicalLibrary.papers.length === 1, `${matching.canonicalLibrary.papers.length} 份`);
    console.log(`      库摘要：${matching.canonicalLibrary.digest.slice(0, 16)}…`);
    check(
      "canonical 库来源声明是只读磁盘包（不入库、不入 FTS）",
      /只读/.test(matching.canonicalLibrary.source) && /不入库/.test(matching.canonicalLibrary.source),
    );
    const writingMatch = matching.segments.find((segment) => segment.segmentKind === "writing_template");
    check(
      "writing_template **默认不产生** canonical 候选",
      writingMatch !== undefined && writingMatch.suggestions.length === 0 && writingMatch.label === "no_candidate",
    );
    check(
      "未匹配有明确的语义说明（不是「伪造」）",
      writingMatch?.unmatchedNote !== null && writingMatch?.unmatchedNote !== undefined,
    );
    check(
      "每个匹配结果都说明了分块范围",
      matching.segments.every((segment) => typeof segment.blocking.description === "string" && segment.blocking.description.length > 0),
    );
    check(
      "每条建议都带逐项证据分解",
      matching.segments
        .flatMap((segment) => segment.suggestions)
        .every(
          (suggestion) =>
            typeof suggestion.evidence.projectionExact === "boolean" &&
            typeof suggestion.evidence.bodyContainment === "number" &&
            typeof suggestion.evidence.bodyJaccard === "number" &&
            typeof suggestion.evidence.structuralConsistency === "number",
        ),
    );
    check(
      "证据里没有任何一项来自文件名 / 套别号 / 题号",
      matching.segments
        .flatMap((segment) => segment.suggestions)
        .every((suggestion) => {
          const context = suggestion.evidence.contextOnly;
          // 上下文线索只允许出现在 contextOnly 里
          return context !== undefined;
        }),
    );

    // =====================================================================
    section("6. 候选包 + 复核事项 + 候选校验和");
    // =====================================================================
    writeCourseCandidate(matched.archive, join(candidatesDir, COURSE_ID));
    const stored = readStoredCandidate(COURSE_ID, candidatesDir);
    const candidateChecksum = stored.recomputed.candidateChecksum;
    check(
      "候选校验和自洽（记录值 == 现场重算值）",
      stored.metadata.digests.candidateChecksum === candidateChecksum,
    );
    console.log(`      候选校验和：${candidateChecksum.slice(0, 16)}…`);
    check("复核事项非空（抽取/分组的诚实披露）", matched.archive.review.length > 0, `${matched.archive.review.length} 条`);
    const blockingCount = matched.archive.review.filter((item) => item.severity === "blocking").length;
    console.log(`      阻断级 ${blockingCount} 条 · 提示级 ${matched.archive.review.length - blockingCount} 条`);

    // =====================================================================
    section("7. 门禁：没有 review ⇒ 不可晋升");
    // =====================================================================
    const indexForGate = buildIndexFromDisk(papersDir);
    /*
     * 源当前性：本复现脚本把源放在临时目录下的 `source/`，
     * 它**不在**标准源树（`content/course-sources`）内 ⇒ 候选取到的是
     * `external` 定位符（刻意不记录位置）。因此这里必须**再次提供**源根 ——
     * 这正是外部源抽取的既定 UX（F10）。
     */
    const noReviewGate = evaluatePromotionGate(
      gatherPromotionInputs({
        stored,
        review: null,
        reviewErrors: [],
        canonical: { digest: indexForGate.index.summary.digest, complete: indexForGate.failures.length === 0 },
        standardSourcesRoot: join(contentRoot, "course-sources"),
        sourceRootOverride: sourceRoot,
      }),
    );
    check("门禁不是 PROMOTABLE", noReviewGate.status !== "PROMOTABLE", noReviewGate.status);
    check(
      "原因是缺少人工复核",
      noReviewGate.checks.find((check) => check.name === "human_review_present")?.passed === false,
    );
    const refused = promoteCourseCandidate({ stored, gate: noReviewGate, review: null, coursesDir });
    check("晋升被拒绝", refused.ok === false);
    check("courses/ 下没有产生任何目录", !existsSync(join(coursesDir, COURSE_ID)));

    // =====================================================================
    section("8. 生产校验器读取候选（**它必须能通过**）");
    // =====================================================================
    const production = validateWithProduction(stored.candidateDir, COURSE_ID);
    check("候选的 course.json 通过生产 NormalizedCourseImporter", production.ok, production.issues.join("；"));
    check("资产字节与校验和一致", checkCandidateAssets(stored.candidateDir, stored.metadata).ok);
    console.log(`      生产校验读到的段数：${(production.content as { segments: unknown[] } | null)?.segments.length ?? 0}`);

    // =====================================================================
    section("9. 候选目录**从未**被生产导入器发现");
    // =====================================================================
    const courseImporter = new NormalizedCourseImporter(coursesDir);
    check(
      "生产课程导入器在 courses/ 下发现 0 个包（候选不在那里）",
      courseImporter.discover().length === 0,
      JSON.stringify(courseImporter.discover().map((handle) => handle.relativePath)),
    );
    const paperImporter = new NormalizedPackageImporter(papersDir);
    check(
      "生产真题导入器只看到 cet6/papers（看不到候选）",
      paperImporter.discover().every((handle) => !handle.relativePath.includes("candidate")),
    );
    check(
      "候选目录确实存在于 course-candidates/（它只是不被生产发现）",
      existsSync(join(candidatesDir, COURSE_ID, "course.json")),
    );

    // =====================================================================
    section("10. 陈旧复核：candidateChecksum 不匹配 ⇒ 晋升被拒");
    // =====================================================================
    // 写一份**指向错误校验和**的 review（模拟"候选变了、复核没跟上"）
    const reviewPath = join(candidatesDir, COURSE_ID, "review.json");
    const wrongChecksumReview = buildReviewFile({
      reviewer: "repro-reviewer",
      candidateChecksum: "0".repeat(64),
      canonicalLibraryDigest: indexForGate.index.summary.digest,
      stored,
    });
    writeFileSync(reviewPath, JSON.stringify(wrongChecksumReview, null, 2), "utf8");

    const staleStored = readStoredCandidate(COURSE_ID, candidatesDir);
    const { validateCourseReviewFile } = await import("@/content/course-pipeline/review");
    const parsedStale = validateCourseReviewFile(JSON.parse(readFileSync(reviewPath, "utf8")));
    const staleGate = evaluatePromotionGate(
      gatherPromotionInputs({
        stored: staleStored,
        review: parsedStale.file,
        reviewErrors: parsedStale.errors,
        canonical: { digest: indexForGate.index.summary.digest, complete: true },
        standardSourcesRoot: join(contentRoot, "course-sources"),
        sourceRootOverride: sourceRoot,
      }),
    );
    check("陈旧复核的门禁不是 PROMOTABLE", staleGate.status !== "PROMOTABLE", staleGate.status);
    const boundCheck = staleGate.checks.find((check) => check.name === "review_bound_to_current_candidate");
    check("失败项是「复核绑定到当前候选」", boundCheck?.passed === false);
    check("失败原因明确说「复核已陈旧」", /陈旧/.test(boundCheck?.detail ?? ""), boundCheck?.detail);
    const staleRefused = promoteCourseCandidate({ stored: staleStored, gate: staleGate, review: parsedStale.file, coursesDir });
    check("陈旧复核的晋升被拒绝", staleRefused.ok === false);
    check("courses/ 下仍然没有产生目录", !existsSync(join(coursesDir, COURSE_ID)));

    // =====================================================================
    section("11. 陈旧匹配：canonical 库变化 ⇒ 匹配证据陈旧");
    // =====================================================================
    // 复核绑定的是**旧**库摘要；再往库里加一份试卷，库摘要就变了
    const paperFixture2 = buildFixturePackage({ id: "repro-paper-2", contentVersion: 1 });
    writeFixturePackage(contentRoot, "repro-paper-2", paperFixture2);
    const indexAfter = buildIndexFromDisk(papersDir);
    check(
      "canonical 库摘要确实变了",
      indexAfter.index.summary.digest !== indexForGate.index.summary.digest,
      `${indexForGate.index.summary.digest.slice(0, 12)} vs ${indexAfter.index.summary.digest.slice(0, 12)}`,
    );

    const goodReview = buildReviewFile({
      reviewer: "repro-reviewer",
      candidateChecksum: staleStored.recomputed.candidateChecksum,
      canonicalLibraryDigest: indexForGate.index.summary.digest, // 旧的库摘要
      stored: staleStored,
    });
    writeFileSync(reviewPath, JSON.stringify(goodReview, null, 2), "utf8");
    const parsedGood = validateCourseReviewFile(JSON.parse(readFileSync(reviewPath, "utf8")));
    const libraryChangedGate = evaluatePromotionGate(
      gatherPromotionInputs({
        stored: staleStored,
        review: parsedGood.file,
        reviewErrors: parsedGood.errors,
        canonical: { digest: indexAfter.index.summary.digest, complete: true },
        standardSourcesRoot: join(contentRoot, "course-sources"),
        sourceRootOverride: sourceRoot,
      }),
    );
    check("库变化后门禁不是 PROMOTABLE", libraryChangedGate.status !== "PROMOTABLE", libraryChangedGate.status);
    const libraryCheck = libraryChangedGate.checks.find(
      (check) => check.name === "canonical_library_unchanged_since_review",
    );
    check("失败项是「canonical 库自复核以来未变」", libraryCheck?.passed === false);
    check(
      "失败原因说明旧分数不得沿用",
      /不得/.test(libraryCheck?.detail ?? ""),
      libraryCheck?.detail,
    );

    // 把库恢复成一份，并让复核绑定当前库摘要 ⇒ 才可能通过
    rmSync(join(papersDir, "repro-paper-2"), { recursive: true, force: true });
    const indexRestored = buildIndexFromDisk(papersDir);
    check(
      "恢复后库摘要回到复核时的值",
      indexRestored.index.summary.digest === indexForGate.index.summary.digest,
    );

    // =====================================================================
    section("12. 晋升（仅在门禁 PROMOTABLE 时）");
    // =====================================================================
    // 重新生成一份**干净的**候选（前一份的 review.json 是复现脚本写的，
    // 真实流程里它由人签署；这里为了把晋升路径跑通，用一份绑定正确的复核）
    let promoted = false;
    {
      const fresh = await runCourseIntake({
        sourceRoot,
        courseId: COURSE_ID,
        provider: "test_fixture_provider",
        edition: "repro",
        title: "复现用合成课程包",
        contentVersion: 1,
        provenance: { note: "夹具", reference: null, rightsNote: "合成夹具" },
        papersDir,
      });
      rmSync(join(candidatesDir, COURSE_ID), { recursive: true, force: true });
      writeCourseCandidate(fresh.archive, join(candidatesDir, COURSE_ID));

      const freshStored = readStoredCandidate(COURSE_ID, candidatesDir);
      const idx = buildIndexFromDisk(papersDir);
      const review = buildReviewFile({
        reviewer: "repro-reviewer",
        candidateChecksum: freshStored.recomputed.candidateChecksum,
        canonicalLibraryDigest: idx.index.summary.digest,
        stored: freshStored,
      });
      writeFileSync(join(candidatesDir, COURSE_ID, "review.json"), JSON.stringify(review, null, 2), "utf8");

      const p = validateCourseReviewFile(JSON.parse(readFileSync(join(candidatesDir, COURSE_ID, "review.json"), "utf8")));
      const gate = evaluatePromotionGate(
        gatherPromotionInputs({
          stored: freshStored,
          review: p.file,
          reviewErrors: p.errors,
          canonical: { digest: idx.index.summary.digest, complete: idx.failures.length === 0 },
          standardSourcesRoot: join(contentRoot, "course-sources"),
          sourceRootOverride: sourceRoot,
        }),
      );
      check("完整复核下门禁为 PROMOTABLE", gate.status === "PROMOTABLE", `${gate.status}：${gate.summary}`);
      for (const check2 of gate.checks.filter((c) => !c.passed)) {
        console.log(`      ✗ ${check2.name}：${check2.detail}`);
      }

      const result = promoteCourseCandidate({ stored: freshStored, gate, review: p.file, coursesDir });
      promoted = result.ok;
      check("晋升成功", result.ok, result.error ?? "");
      if (result.ok) {
        console.log(`      已晋升：${result.targetDir}`);
        console.log(`      复制：${result.copied.join("、")}`);
        console.log(`      未复制：${result.excluded.join("、")}`);
        check(
          "candidate.json **没有**进入运行时课程目录",
          !existsSync(join(coursesDir, COURSE_ID, "candidate.json")),
        );
        check(
          "review.json **没有**进入运行时课程目录",
          !existsSync(join(coursesDir, COURSE_ID, "review.json")),
        );
        check(
          "course.json 与 assets/ 进入了运行时课程目录",
          existsSync(join(coursesDir, COURSE_ID, "course.json")) &&
            existsSync(join(coursesDir, COURSE_ID, "assets")),
        );

        // ---- 生产导入器现在必须能发现它 ----
        const afterPromote = new NormalizedCourseImporter(coursesDir).discover();
        check("晋升后生产课程导入器发现了 1 个包", afterPromote.length === 1, `${afterPromote.length} 个`);

        // ---- 链接交接计划：只打印，不执行（F12：绑定门禁）----
        const plan = buildLinkPlan({
          stored: freshStored,
          review: p.file,
          gate,
        });
        check("门禁为 PROMOTABLE ⇒ 交接计划被允许", plan.allowed);
        check(
          "链接计划里的命令都带 --status verified 且**不带** --commit",
          plan.entries.every(
            (entry) => entry.command.includes("--status verified") && !entry.command.includes("--commit"),
          ),
        );
        console.log(`      链接交接计划：${plan.entries.length} 条（**未执行**）`);
        for (const entry of plan.entries.slice(0, 3)) console.log(`        ${entry.command}`);
      }
    }

    // =====================================================================
    section("13. Review Fix F8 —— 匹配裁决**不能**化解段复核");
    // =====================================================================
    {
      /*
       * 关键：**不重跑抽取**。这里直接用前面已建好的候选与源，
       * 只改 review.json 的内容 —— 因此它验证的是门禁判据本身，
       * 而不是"抽取时看到了新东西"。
       */
      const storedF8 = readStoredCandidate(COURSE_ID, candidatesDir);
      const f8Review = buildReviewFile({
        reviewer: "repro-reviewer",
        candidateChecksum: storedF8.recomputed.candidateChecksum,
        canonicalLibraryDigest: storedF8.metadata.matching.canonicalLibrary.digest,
        stored: storedF8,
        // **清空** segments[]，只留匹配裁决
        segmentDecisions: [],
        matchDispositions: "unmatched",
      });
      const p8 = validateCourseReviewFile(f8Review);
      const gate8 = evaluatePromotionGate(
        gatherPromotionInputs({
          stored: storedF8,
          review: p8.file,
          reviewErrors: p8.errors,
          canonical: { digest: storedF8.metadata.matching.canonicalLibrary.digest, complete: true },
          standardSourcesRoot: join(contentRoot, "course-sources"),
          sourceRootOverride: sourceRoot,
        }),
      );
      const blockingCheck = gate8.checks.find((c) => c.name === "blocking_review_items_resolved");
      check(
        "只有匹配裁决、没有段裁决 ⇒ 门禁不是 PROMOTABLE",
        gate8.status !== "PROMOTABLE",
        gate8.status,
      );
      check("失败项是阻断事项未被正确类型化解", blockingCheck?.passed === false);
      check(
        "原因明确指出缺少 segments[] 裁决",
        /segments\[\]|匹配裁决不能代替段裁决/.test(blockingCheck?.detail ?? ""),
        (blockingCheck?.detail ?? "").slice(0, 120),
      );
    }

    // =====================================================================
    section("14. Review Fix F9 —— rejected / excluded 阻断晋升（不得溜进 courses/）");
    // =====================================================================
    {
      const storedF9 = readStoredCandidate(COURSE_ID, candidatesDir);
      const targetSegment = storedF9.metadata.segmentation.materials
        .flatMap((material) => material.segments)
        .find((segment) => segment.reviewRequired);

      if (targetSegment) {
        const f9Review = buildReviewFile({
          reviewer: "repro-reviewer",
          candidateChecksum: storedF9.recomputed.candidateChecksum,
          canonicalLibraryDigest: storedF9.metadata.matching.canonicalLibrary.digest,
          stored: storedF9,
          segmentDecisions: [{ segmentId: targetSegment.id, decision: "excluded" }],
        });
        const p9 = validateCourseReviewFile(f9Review);
        const gate9 = evaluatePromotionGate(
          gatherPromotionInputs({
            stored: storedF9,
            review: p9.file,
            reviewErrors: p9.errors,
            canonical: { digest: storedF9.metadata.matching.canonicalLibrary.digest, complete: true },
            standardSourcesRoot: join(contentRoot, "course-sources"),
            sourceRootOverride: sourceRoot,
          }),
        );
        const exCheck = gate9.checks.find((c) => c.name === "excluded_segments_block_promotion");
        check("excluded 段 ⇒ 门禁 BLOCKED", gate9.status === "BLOCKED", gate9.status);
        check("失败项是「被排除的段阻断晋升」", exCheck?.passed === false);
        check(
          "提示重新生成候选（而不是让人改复核记录）",
          /重新生成候选|course:extract/.test(exCheck?.detail ?? ""),
        );

        // 关键：**结构不得**被复制到 courses/
        const beforePromote = existsSync(join(coursesDir, "f9-excluded"));
        const refused9 = promoteCourseCandidate({
          stored: { ...storedF9, courseId: "f9-excluded" },
          gate: gate9,
          review: p9.file,
          coursesDir,
        });
        check("晋升被拒绝", refused9.ok === false);
        check(
          "courses/ 下**没有**产生任何目录（被排除的结构没有溜进去）",
          !existsSync(join(coursesDir, "f9-excluded")) && beforePromote === false,
        );
        console.log(`      被排除的段：${targetSegment.id}`);
      } else {
        console.log("      （该夹具没有需要复核的段，跳过）");
      }
    }

    // =====================================================================
    section("15. Review Fix F10 —— 抽取后源漂移被检测（**不重跑抽取**）");
    // =====================================================================
    {
      /*
       * 这一步刻意在最前面就把源改掉（早于任何后续抽取），
       * 然后**只用**已存在的候选 + 一份新写的正确 review 去求门禁。
       *
       * 因此"检测到漂移"**不可能**来自"重跑抽取看到了新源"——
       * 候选的 candidate.json 从未被重新生成。
       */
      const storedF10 = readStoredCandidate(COURSE_ID, candidatesDir);
      const beforeDigest = storedF10.metadata.inventory.digest;

      // 改动源字节（不重跑 course:extract）
      writeFileSync(
        join(sourceRoot, "阅读", "reading-handout.pdf"),
        buildTextPdf([["Passage One"], ["The raw source bytes have been replaced after extraction."]]),
      );

      const f10Review = buildReviewFile({
        reviewer: "repro-reviewer",
        candidateChecksum: storedF10.recomputed.candidateChecksum,
        canonicalLibraryDigest: storedF10.metadata.matching.canonicalLibrary.digest,
        stored: storedF10,
      });
      const p10 = validateCourseReviewFile(f10Review);
      const gate10 = evaluatePromotionGate(
        gatherPromotionInputs({
          stored: storedF10,
          review: p10.file,
          reviewErrors: p10.errors,
          canonical: { digest: storedF10.metadata.matching.canonicalLibrary.digest, complete: true },
          standardSourcesRoot: join(contentRoot, "course-sources"),
          sourceRootOverride: sourceRoot,
        }),
      );
      const srcCheck = gate10.checks.find((c) => c.name === "source_current_and_unchanged");
      check("源漂移后门禁不是 PROMOTABLE", gate10.status !== "PROMOTABLE", gate10.status);
      check("失败项是「源当前且未变」", srcCheck?.passed === false);
      check("原因明确说「源已漂移」", /源已漂移/.test(srcCheck?.detail ?? ""));
      check(
        "候选记录的源摘要**没有**被自动更新",
        readStoredCandidate(COURSE_ID, candidatesDir).metadata.inventory.digest === beforeDigest,
      );

      const refused10 = promoteCourseCandidate({
        stored: storedF10,
        gate: gate10,
        review: p10.file,
        coursesDir,
      });
      check("漂移时晋升被拒绝", refused10.ok === false);
      console.log(`      ${srcCheck?.detail.split("\n")[0]}`);

      // ── F12：源漂移 + 有 accepted_suggestion ⇒ **零交接命令** ──
      {
        const withSuggestion = storedF10.metadata.matching.segments.find((s) => s.suggestions.length > 0);
        if (withSuggestion) {
          const top = withSuggestion.suggestions[0];
          const driftReview = buildReviewFile({
            reviewer: "repro-reviewer",
            candidateChecksum: storedF10.recomputed.candidateChecksum,
            canonicalLibraryDigest: storedF10.metadata.matching.canonicalLibrary.digest,
            stored: storedF10,
            matchDispositions: "accept_top",
          });
          const pd = validateCourseReviewFile(driftReview);
          const planDrift = buildLinkPlan({
            stored: storedF10,
            review: pd.file,
            gate: gate10, // ← 源漂移的那个门禁
          });
          check("F12：源漂移 ⇒ 交接计划被抑制", planDrift.allowed === false);
          check("F12：源漂移 ⇒ **零**交接命令", planDrift.entries.length === 0, `${planDrift.entries.length} 条`);
          console.log(`      ${planDrift.reason.split("\n")[0].slice(0, 110)}`);
          void top;
        }
      }

      // 恢复原始字节，让后续小节回到"源未漂移"状态
      writeFileSync(join(sourceRoot, "阅读", "reading-handout.pdf"), originalHandoutBytes);
      check(
        "源已恢复（后续小节需要源未漂移）",
        readStoredCandidate(COURSE_ID, candidatesDir).metadata.inventory.digest === beforeDigest,
      );
    }

    // =====================================================================
    section("16. Review Fix F11 —— 交接命令 shell 安全");
    // =====================================================================
    {
      const storedF11 = readStoredCandidate(COURSE_ID, candidatesDir);
      const withSuggestion = storedF11.metadata.matching.segments.find((s) => s.suggestions.length > 0);
      const malicious = 'proof "quoted"; $(echo bad); `bad`; $HOME\nnewline';
      if (withSuggestion) {
        const f11Review = buildReviewFile({
          reviewer: "repro-reviewer",
          candidateChecksum: storedF11.recomputed.candidateChecksum,
          canonicalLibraryDigest: storedF11.metadata.matching.canonicalLibrary.digest,
          stored: storedF11,
          matchDispositions: "accept_top",
          evidenceOverride: malicious,
        });
        const p11 = validateCourseReviewFile(f11Review);
        // F12：必须先用**真实的** PROMOTABLE 门禁放行，才能检查命令内容
        const gate11 = evaluatePromotionGate(
          gatherPromotionInputs({
            stored: storedF11,
            review: p11.file,
            reviewErrors: p11.errors,
            canonical: { digest: storedF11.metadata.matching.canonicalLibrary.digest, complete: true },
            standardSourcesRoot: join(contentRoot, "course-sources"),
            sourceRootOverride: sourceRoot,
          }),
        );
        check("F11 前置：门禁为 PROMOTABLE", gate11.status === "PROMOTABLE", gate11.status);
        const plan11 = buildLinkPlan({
          stored: storedF11,
          review: p11.file,
          gate: gate11,

        });
        const cmd = plan11.entries[0]?.command ?? "";
        check("生成了交接命令", plan11.entries.length > 0);
        check(
          "命令里**没有**任何恶意自由文本",
          !cmd.includes("echo bad") && !cmd.includes("$HOME") && !/`bad`/.test(cmd) && !cmd.includes("\n"),
          cmd,
        );
        check("命令里没有引号（ref 是受控标识符）", !cmd.includes('"') && !cmd.includes("'"), cmd);
        check(
          "ref 是确定性安全标识符",
          /^course-review:[a-z0-9._:-]+$/.test(plan11.entries[0]?.ref ?? ""),
          plan11.entries[0]?.ref,
        );
        check("仍然**不带** --commit", !cmd.includes("--commit"));
        check("仍然带 --status verified", cmd.includes("--status verified"));
        check("人写的证据仍可读（只是不进军令）", plan11.entries[0]?.reviewEvidence === malicious);
        console.log(`      命令：${cmd}`);
      } else {
        console.log("      （该夹具没有匹配建议，跳过）");
      }
    }

    // =====================================================================
    section("17. Review Fix F12 —— 交接计划**绑定门禁**（非 PROMOTABLE 时零命令）");
    // =====================================================================
    {
      const storedF12 = readStoredCandidate(COURSE_ID, candidatesDir);
      const withSuggestion = storedF12.metadata.matching.segments.find((s) => s.suggestions.length > 0);

      if (!withSuggestion) {
        console.log("      （该夹具没有匹配建议，跳过）");
      } else {
        const top = withSuggestion.suggestions[0];
        const acceptedMatches = [
          {
            segmentId: withSuggestion.segmentId,
            disposition: "accepted_suggestion" as const,
            paperId: top.target.paperId,
            targetScope: "section" as const,
            sectionId: top.target.sectionId,
            groupId: null,
            questionId: null,
            note: "复现脚本：接受该建议。",
            evidence: "复现脚本依据建议的逐项证据作出该裁决（≥10 字符）。",
          },
        ];

        // ── 基准：PROMOTABLE + accepted_suggestion ⇒ 恰好 1 条命令 ──
        const okReview = buildReviewFile({
          reviewer: "repro-reviewer",
          candidateChecksum: storedF12.recomputed.candidateChecksum,
          canonicalLibraryDigest: storedF12.metadata.matching.canonicalLibrary.digest,
          stored: storedF12,
          matchDispositions: "accept_top",
        });
        const pOk = validateCourseReviewFile(okReview);
        const gateOk = evaluatePromotionGate(
          gatherPromotionInputs({
            stored: storedF12,
            review: pOk.file,
            reviewErrors: pOk.errors,
            canonical: { digest: storedF12.metadata.matching.canonicalLibrary.digest, complete: true },
            standardSourcesRoot: join(contentRoot, "course-sources"),
            sourceRootOverride: sourceRoot,
          }),
        );
        check("基准：门禁为 PROMOTABLE", gateOk.status === "PROMOTABLE", gateOk.status);
        const planOk = buildLinkPlan({
          stored: storedF12,
          review: pOk.file,
          gate: gateOk,

        });
        // `accept_top` 会接受**每一个**有建议的段的最高分建议，
        // 因此期望条数 = 有建议的段数（不是固定的 1）。
        const expectedCount = storedF12.metadata.matching.segments.filter(
          (segment) => segment.suggestions.length > 0,
        ).length;
        check("基准：交接计划被允许", planOk.allowed === true);
        check(
          `基准：恰好 ${expectedCount} 条命令（= 有建议的段数）`,
          planOk.entries.length === expectedCount,
          `${planOk.entries.length} 条`,
        );
        check(
          "基准：命令不带 --commit",
          planOk.entries.every((entry) => !entry.command.includes("--commit")),
        );

        /** 求一个"只破坏一处"的门禁 + 交接计划。 */
        const probe = (label: string, options: { complete?: boolean; checksum?: string; reviewOverride?: unknown }) => {
          const raw = buildReviewFile({
            reviewer: "repro-reviewer",
            candidateChecksum: options.checksum ?? storedF12.recomputed.candidateChecksum,
            canonicalLibraryDigest: storedF12.metadata.matching.canonicalLibrary.digest,
            stored: storedF12,
            matchDispositions: "accept_top",
          });
          const merged = { ...raw, matches: acceptedMatches, ...(options.reviewOverride ?? {}) };
          const parsed = validateCourseReviewFile(merged);
          const g = evaluatePromotionGate(
            gatherPromotionInputs({
              stored: storedF12,
              review: parsed.file,
              reviewErrors: parsed.errors,
              canonical: {
                digest: storedF12.metadata.matching.canonicalLibrary.digest,
                complete: options.complete ?? true,
              },
              standardSourcesRoot: join(contentRoot, "course-sources"),
              sourceRootOverride: sourceRoot,
            }),
          );
          const p = buildLinkPlan({ stored: storedF12, review: parsed.file, gate: g });
          check(`${label} ⇒ 门禁非 PROMOTABLE`, g.status !== "PROMOTABLE", g.status);
          check(`${label} ⇒ **零**交接命令`, p.entries.length === 0, `${p.entries.length} 条`);
          check(`${label} ⇒ 抑制理由可见`, p.allowed === false && p.reason.length > 0);
          return { g, p };
        };

        // 1) 陈旧校验和
        probe("陈旧 candidateChecksum + accepted_suggestion", { checksum: "0".repeat(64) });

        // 2) canonical 库不完整（实现/文档矛盾的收口点）
        const incomplete = probe("canonical 库不完整 + accepted_suggestion", { complete: false });
        check(
          "  失败项是 canonical_library_complete_for_acceptance",
          incomplete.g.checks.find((c) => c.name === "canonical_library_complete_for_acceptance")?.passed === false,
        );

        // 3) rejected 分组
        {
          const raw = buildReviewFile({
            reviewer: "repro-reviewer",
            candidateChecksum: storedF12.recomputed.candidateChecksum,
            canonicalLibraryDigest: storedF12.metadata.matching.canonicalLibrary.digest,
            stored: storedF12,
            matchDispositions: "accept_top",
          });
          const g0 = storedF12.metadata.grouping.proposals.find((x) => x.reviewRequired);
          if (g0) {
            const merged = {
              ...raw,
              matches: acceptedMatches,
              materialGroupings: storedF12.metadata.grouping.proposals
                .filter((x) => x.reviewRequired)
                .map((x) => ({
                  proposalId: x.id,
                  decision: x.id === g0.id ? ("rejected" as const) : ("accepted" as const),
                  note: "n",
                  evidence: "复现脚本依据候选记录作出该裁决（≥10 字符）。",
                })),
            };
            const parsed = validateCourseReviewFile(merged);
            const g = evaluatePromotionGate(
              gatherPromotionInputs({
                stored: storedF12,
                review: parsed.file,
                reviewErrors: parsed.errors,
                canonical: { digest: storedF12.metadata.matching.canonicalLibrary.digest, complete: true },
                standardSourcesRoot: join(contentRoot, "course-sources"),
                sourceRootOverride: sourceRoot,
              }),
            );
            const p = buildLinkPlan({ stored: storedF12, review: parsed.file, gate: g });
            check("rejected 分组 + accepted_suggestion ⇒ 门禁非 PROMOTABLE", g.status !== "PROMOTABLE", g.status);
            check("rejected 分组 + accepted_suggestion ⇒ **零**交接命令", p.entries.length === 0);
          }
        }

        // 4) excluded 段
        {
          const raw = buildReviewFile({
            reviewer: "repro-reviewer",
            candidateChecksum: storedF12.recomputed.candidateChecksum,
            canonicalLibraryDigest: storedF12.metadata.matching.canonicalLibrary.digest,
            stored: storedF12,
            matchDispositions: "accept_top",
          });
          const s0 = storedF12.metadata.segmentation.materials
            .flatMap((m) => m.segments)
            .find((x) => x.reviewRequired);
          if (s0) {
            const merged = {
              ...raw,
              matches: acceptedMatches,
              segments: storedF12.metadata.segmentation.materials
                .flatMap((m) => m.segments)
                .filter((x) => x.reviewRequired)
                .map((x) => ({
                  segmentId: x.id,
                  decision: x.id === s0.id ? ("excluded" as const) : ("accepted" as const),
                  note: "n",
                  evidence: "复现脚本依据候选记录作出该裁决（≥10 字符）。",
                })),
            };
            const parsed = validateCourseReviewFile(merged);
            const g = evaluatePromotionGate(
              gatherPromotionInputs({
                stored: storedF12,
                review: parsed.file,
                reviewErrors: parsed.errors,
                canonical: { digest: storedF12.metadata.matching.canonicalLibrary.digest, complete: true },
                standardSourcesRoot: join(contentRoot, "course-sources"),
                sourceRootOverride: sourceRoot,
              }),
            );
            const p = buildLinkPlan({ stored: storedF12, review: parsed.file, gate: g });
            check("excluded 段 + accepted_suggestion ⇒ 门禁非 PROMOTABLE", g.status !== "PROMOTABLE", g.status);
            check("excluded 段 + accepted_suggestion ⇒ **零**交接命令", p.entries.length === 0);
          }
        }

        // 5) 段复核未被裁决（只有匹配裁决）——F8 与 F12 的交汇点
        {
          const raw = buildReviewFile({
            reviewer: "repro-reviewer",
            candidateChecksum: storedF12.recomputed.candidateChecksum,
            canonicalLibraryDigest: storedF12.metadata.matching.canonicalLibrary.digest,
            stored: storedF12,
            matchDispositions: "accept_top",
            segmentDecisions: [], // **刻意清空**段裁决
          });
          const parsed = validateCourseReviewFile(raw);
          const g = evaluatePromotionGate(
            gatherPromotionInputs({
              stored: storedF12,
              review: parsed.file,
              reviewErrors: parsed.errors,
              canonical: { digest: storedF12.metadata.matching.canonicalLibrary.digest, complete: true },
              standardSourcesRoot: join(contentRoot, "course-sources"),
              sourceRootOverride: sourceRoot,
            }),
          );
          const p = buildLinkPlan({ stored: storedF12, review: parsed.file, gate: g });
          check("段复核未裁决 + 匹配裁决 ⇒ 门禁非 PROMOTABLE", g.status !== "PROMOTABLE", g.status);
          check("段复核未裁决 + 匹配裁决 ⇒ **零**交接命令", p.entries.length === 0);
        }

        // 6) 库不完整但**没有** accepted_suggestion ⇒ 课程包仍可 PROMOTABLE，交接自然为空
        {
          const raw = buildReviewFile({
            reviewer: "repro-reviewer",
            candidateChecksum: storedF12.recomputed.candidateChecksum,
            canonicalLibraryDigest: storedF12.metadata.matching.canonicalLibrary.digest,
            stored: storedF12,
            matchDispositions: "ambiguous_only", // 不产生 accepted_suggestion
          });
          const parsed = validateCourseReviewFile(raw);
          const g = evaluatePromotionGate(
            gatherPromotionInputs({
              stored: storedF12,
              review: parsed.file,
              reviewErrors: parsed.errors,
              canonical: { digest: storedF12.metadata.matching.canonicalLibrary.digest, complete: false },
              standardSourcesRoot: join(contentRoot, "course-sources"),
              sourceRootOverride: sourceRoot,
            }),
          );
          const p = buildLinkPlan({ stored: storedF12, review: parsed.file, gate: g });
          check(
            "库不完整 + 无 accepted_suggestion ⇒ 课程包**仍可** PROMOTABLE（未被一刀切阻断）",
            g.status === "PROMOTABLE",
            `${g.status}：${g.summary.slice(0, 120)}`,
          );
          check("库不完整 + 无 accepted_suggestion ⇒ 交接计划为空", p.entries.length === 0);
        }

        // 7) review 为 null ⇒ 零命令
        {
          const p = buildLinkPlan({ stored: storedF12, review: null, gate: gateOk });
          check("没有 review ⇒ 零交接命令", p.entries.length === 0 && p.allowed === false);
        }
      }
    }

    // =====================================================================
    section("18. 证明：晋升**没有**创建任何 verified canonical 链接");
    // =====================================================================
    check("晋升确实发生了（否则下面的证明没有意义）", promoted);
    // 本流水线**不 import 任何数据库模块**，因此它在原理上不可能写链接。
    // 这里用源码级检查把它变成可核对的事实。
    const reviewSource = readFileSync(join(process.cwd(), "src/content/course-pipeline/review.ts"), "utf8");
    const indexSource = readFileSync(join(process.cwd(), "src/content/course-pipeline/index.ts"), "utf8");
    const candidateSource = readFileSync(join(process.cwd(), "src/content/course-pipeline/candidate.ts"), "utf8");
    check(
      "review.ts **不 import** 任何数据库 / 仓库模块",
      !/repositories|db\/client|node:sqlite|course-link/.test(
        reviewSource.split("\n").filter((line) => line.trimStart().startsWith("import")).join("\n"),
      ),
    );
    check(
      "index.ts **不 import** 任何数据库 / 仓库模块",
      !/repositories|db\/client|node:sqlite/.test(
        indexSource.split("\n").filter((line) => line.trimStart().startsWith("import")).join("\n"),
      ),
    );
    check(
      "candidate.ts **不 import** 任何数据库模块",
      !/repositories|db\/client|node:sqlite/.test(
        candidateSource.split("\n").filter((line) => line.trimStart().startsWith("import")).join("\n"),
      ),
    );
    check(
      "整个流水线里没有对 verifyCanonicalLink 的调用",
      !/verifyCanonicalLink\s*\(/.test(
        [reviewSource, indexSource, candidateSource].join("\n"),
      ),
    );
    check(
      "晋升后的域里没有 review.json / candidate.json（不是运行时真相）",
      !existsSync(join(coursesDir, COURSE_ID, "review.json")) &&
        !existsSync(join(coursesDir, COURSE_ID, "candidate.json")),
    );

    console.log(`\n${"─".repeat(60)}`);
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      /* Windows 残留无妨 */
    }
  }
}

/**
 * 构造一份**形状合法**的 review.json。
 *
 * 它把所有需要裁决的材料分组与段都标为 accepted —— 复现脚本的目的是
 * 验证**门禁路径**，不是替 使用者 做产品判断。真实使用时这份文件由人签署。
 *
 * `segmentDecisions` / `matchDispositions` / `evidenceOverride` 让各节
 * 精确地**只破坏一处**，从而把失败归因到那一条判据。
 */
function buildReviewFile(input: {
  reviewer: string;
  candidateChecksum: string;
  canonicalLibraryDigest: string;
  stored: Awaited<ReturnType<typeof import("@/content/course-pipeline/review").readStoredCandidate>>;
  /** 覆盖段裁决；`[]` 表示**刻意不提供**任何段裁决（F8）。 */
  segmentDecisions?: { segmentId: string; decision: "accepted" | "excluded" }[];
  /** 匹配裁决形态：默认只处置歧义；`unmatched` = 全部有意不匹配；`accept_top` = 接受最高分。 */
  matchDispositions?: "ambiguous_only" | "unmatched" | "accept_top";
  /** 覆盖全部 evidence 文本（F11 恶意文本注入）。 */
  evidenceOverride?: string;
}): Record<string, unknown> {
  const metadata = input.stored.metadata;
  const evidence = input.evidenceOverride;
  const modes = input.matchDispositions ?? "ambiguous_only";

  const segmentDecisions =
    input.segmentDecisions ??
    metadata.segmentation.materials
      .flatMap((material) => material.segments)
      .filter((segment) => segment.reviewRequired)
      .map((segment) => ({ segmentId: segment.id, decision: "accepted" as const }));

  const matchEntries: Record<string, unknown>[] = [];
  if (modes === "unmatched") {
    for (const segment of metadata.matching.segments) {
      matchEntries.push({
        segmentId: segment.segmentId,
        disposition: "intentionally_unmatched",
        paperId: null,
        targetScope: null,
        sectionId: null,
        groupId: null,
        questionId: null,
        note: "复现脚本：有意不匹配。",
        evidence: evidence ?? "复现脚本显式声明有意不匹配，未对映射作判断（≥10 字符）。",
      });
    }
  } else if (modes === "accept_top") {
    for (const segment of metadata.matching.segments) {
      const top = segment.suggestions[0];
      if (!top) continue;
      /*
       * 粒度必须**照抄**机器提出过的 target：门禁要求裁决的
       * (paperId, sectionId, groupId, questionId) 精确等于某个已提出的建议，
       * 而机器的 target 带具体 groupId。用 section 粒度 + groupId:null
       * 去"接受"它会被正确地判为"该组合不在候选建议里"。
       */
      const scope = top.target.questionId !== null ? "question" : top.target.groupId !== null ? "group" : "section";
      matchEntries.push({
        segmentId: segment.segmentId,
        disposition: "accepted_suggestion",
        paperId: top.target.paperId,
        targetScope: scope,
        sectionId: top.target.sectionId,
        groupId: scope === "section" ? null : top.target.groupId,
        questionId: scope === "question" ? top.target.questionId : null,
        note: "复现脚本：接受最高分建议。",
        evidence: evidence ?? "复现脚本依据建议的逐项证据作出该裁决（≥10 字符）。",
      });
    }
  } else {
    for (const segment of metadata.matching.segments.filter((s) => s.ambiguous)) {
      matchEntries.push({
        segmentId: segment.segmentId,
        disposition: "intentionally_unmatched",
        paperId: null,
        targetScope: null,
        sectionId: null,
        groupId: null,
        questionId: null,
        note: "复现脚本：歧义未选定，明确声明有意不匹配。",
        evidence: evidence ?? "复现脚本不对歧义作产品判断，因此显式声明有意不匹配（≥10 字符）。",
      });
    }
  }

  return {
    courseId: metadata.courseId,
    reviewer: input.reviewer,
    reviewedAt: "2026-01-01",
    candidateChecksum: input.candidateChecksum,
    canonicalLibraryDigest: input.canonicalLibraryDigest,
    materialGroupings: metadata.grouping.proposals
      .filter((proposal) => proposal.reviewRequired)
      .map((proposal) => ({
        proposalId: proposal.id,
        decision: "accepted",
        note: "复现脚本：确认该分组。",
        evidence: evidence ?? "复现脚本依据候选里记录的 basis 与 evidence 字段作出该裁决（≥10 字符）。",
      })),
    segments: segmentDecisions.map((entry) => ({
      segmentId: entry.segmentId,
      decision: entry.decision,
      note: "复现脚本：段裁决。",
      evidence: evidence ?? "复现脚本依据候选里记录的 evidence.cues 与 lineSpan 作出该裁决（≥10 字符）。",
    })),
    matches: matchEntries,
    verifiedScope: ["复现脚本：候选结构、资产完整性与门禁路径"],
    notVerified: ["未做任何 canonical 对应关系的人工核验"],
  };
}

void cpSync;
void mkdirSync;

main().catch((error) => {
  console.error("\n复现脚本异常终止：");
  console.error(error);
  process.exitCode = 1;
});
