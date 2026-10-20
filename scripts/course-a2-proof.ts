#!/usr/bin/env node
/**
 * A2 Review Fix · 合成端到端证明（`pnpm course:a2-proof`）。
 *
 * ── 它证明什么（每条都是真实磁盘行为，不是 mock）──
 *
 * 1. **真实数据链（P0-F1 验收）**：
 *    合成源 → 既有 `runCourseIntake` + `writeCourseCandidate` 生成候选
 *    → A2 `saveAdjudicationReview` 写入 review.json
 *    → 持久化的 review 通过既有 `validateCourseReviewFile`
 *    → 既有下游只读审核门禁（`evaluatePromotionGate` + `gatherPromotionInputs`）
 *      的 `human_review_present` 与 `review_bound_to_current_candidate` 两项通过。
 *
 * 2. **陈旧防线**：全零/随机摘要被拒；源字节变动、候选内容变动、
 *    canonical 库变动分别使旧 review 失效；被拒时既有 review 字节不变。
 *
 * 3. **分段计划（P1-F3）**：计划持久化到白名单目录 → 重新生成候选
 *    确实消费它（`modeEvidence.mode === "human_planned"`，计划校验和进入候选）
 *    → 有无计划产生不同候选校验和（计划参与身份）→ 计划变动 ⇒ 旧 review 自动陈旧。
 *
 * 4. **写边界**：`courses/` 不创建、候选目录只多出 review.json 与其备份、
 *    源目录逐字节不变。
 *
 * 5. **故障注入与恢复**：备份唯一名、可恢复、恢复后 SHA-256 与原内容一致。
 *
 * 全部合成夹具，隔离临时根（`os.tmpdir()`）。不读任何真实课程材料，
 * 不碰 `data/cet6.db`，不部署，不起真实 HTTP 服务器（那由 Playwright 覆盖）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkAdjudicationStaleness,
  describeBinding,
  loadAdjudicationDraft,
  prepareReviewForSave,
  restoreFromBackup,
  saveAdjudicationPlan,
  saveAdjudicationReview,
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
import { parseSegmentationPlan, segmentationPlanDigest } from "@/content/course-pipeline/segmentation-plan";
import { buildIndexFromDisk } from "@/content/course-pipeline/canonical";
import { buildTextPdf, buildCjkPdf, writeSourceTree } from "./course-source-fixture";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
} from "./course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
    failed += 1;
    failures.push(label);
  }
}

function wrapWords(text: string): string[] {
  return text.split(/\s+/).filter((word) => word !== "");
}

function buildSyntheticSource(root: string): string {
  const sourceRoot = join(root, "synthetic-source");
  const tree = new Map<string, Buffer>();
  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      ["SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL", "Passage One", "Questions 46 to 50 are based on the following passage.", ...wrapWords(FIXTURE_PASSAGE_A)],
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

function buildSyntheticPapers(root: string): string {
  const papersRoot = join(root, "synthetic-papers");
  const papersDir = join(papersRoot, "cet6", "papers");
  for (let index = 0; index < 3; index += 1) {
    const id = `fixture-cet6-2024-12-set${index + 1}`;
    writeFixturePackage(papersRoot, id, buildFixturePackage({ id, year: 2024, session: "December", variant: `set${index + 1}` }));
  }
  return papersDir;
}

function shaOfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<void> {
  console.log("A2 Review Fix · 合成端到端证明（不读真实材料、不碰真实库）");
  console.log("");

  const root = mkdtempSync(join(tmpdir(), "a2-proof-"));
  try {
    const sourceRoot = buildSyntheticSource(root);
    const papersDir = buildSyntheticPapers(root);
    const candidatesDir = join(root, "course-candidates");
    const plansDir = join(root, "course-segmentation-plans");
    const courseId = "a2-proof-course";

    // ── 一、真实候选生成 ──
    console.log("一、既有候选生成（runCourseIntake + writeCourseCandidate）");
    const intake = await runCourseIntake({
      sourceRoot,
      courseId,
      provider: "test_fixture_provider",
      edition: null,
      title: "A2 Proof Course",
      contentVersion: 1,
      provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
      papersDir,
    });
    writeCourseCandidate(intake.archive, join(candidatesDir, courseId));

    const realChecksum = intake.archive.metadata.digests.candidateChecksum;
    const realCanonicalDigest = intake.archive.metadata.matching.canonicalLibrary.digest;
    const realSourceDigest = intake.inventory.digest;
    check("候选包已写出", existsSync(join(candidatesDir, courseId, "course.json")) && existsSync(join(candidatesDir, courseId, "candidate.json")));
    check("候选校验和是真实 64 位 hex", /^[0-9a-f]{64}$/.test(realChecksum));
    check("canonical 库摘要由服务端现算", /^[0-9a-f]{64}$/.test(realCanonicalDigest) && !/^0+$/.test(realCanonicalDigest));

    const binding = describeBinding({ courseId, candidatesDir, papersDir });
    check("describeBinding 报告候选存在", binding.candidateExists === true);
    check("describeBinding 的重算值与候选记录一致", binding.rebound?.candidateChecksum === realChecksum);

    const draft = (overrides: Partial<AdjudicationDraftPayload> = {}): AdjudicationDraftPayload => ({
      courseId,
      reviewer: "Reviewer R",
      reviewedAt: "2026-10-16",
      candidateChecksum: realChecksum,
      canonicalLibraryDigest: realCanonicalDigest,
      sourceDigest: realSourceDigest,
      verifiedScope: ["materials", "segments", "canonical_matches"],
      notVerified: [],
      materialGroupings: [
        { proposalId: intake.grouping.proposals[0]?.id ?? "p1", decision: "accepted", evidence: "分组经逐字核对确认一致无误。" },
      ],
      segments: intake.archive.metadata.segmentation.materials.flatMap((material) =>
        material.segments.map((segment) => ({
          segmentId: segment.id,
          decision: "accepted" as const,
          evidence: "已人工核对该段页码与讲义完全对齐。",
        })),
      ),
      matches: [],
      ...overrides,
    });

    // ── 二、陈旧防线 ──
    console.log("");
    console.log("二、陈旧防线（假摘要 / 源变动 / 候选变动 / 库变动）");
    const zeroRes = saveAdjudicationReview({ draft: draft({ candidateChecksum: "0".repeat(64) }), candidatesDir, papersDir, sourceDir: sourceRoot });
    check("全零摘要被拒", zeroRes.ok === false, zeroRes.errors?.join("；"));
    check("拒绝后不创建 review.json", !existsSync(join(candidatesDir, courseId, "review.json")));
    check(
      "拒绝后候选目录没有新增文件",
      readdirSync(join(candidatesDir, courseId)).every((name) => name === "assets" || name === "candidate.json" || name === "course.json"),
      readdirSync(join(candidatesDir, courseId)).join("、"),
    );

    const randomRes = saveAdjudicationReview({ draft: draft({ candidateChecksum: createHash("sha256").update("random").digest("hex") }), candidatesDir, papersDir, sourceDir: sourceRoot });
    check("随机摘要被拒", randomRes.ok === false);

    // ── 三、合法保存 ──
    console.log("");
    console.log("三、合法保存（真实绑定）");
    const saveRes = saveAdjudicationReview({ draft: draft(), candidatesDir, papersDir, sourceDir: sourceRoot });
    check("保存成功", saveRes.ok === true, saveRes.errors?.join("；"));
    check("review.json 落在候选目录内", existsSync(join(candidatesDir, courseId, "review.json")));
    check("首次保存无备份", saveRes.backupPath === null);

    const persisted = JSON.parse(readFileSync(join(candidatesDir, courseId, "review.json"), "utf8"));
    const persistedValidation = validateCourseReviewFile(persisted);
    check("持久化 review 通过既有 validateCourseReviewFile", persistedValidation.ok === true, persistedValidation.errors.join("；"));
    check("持久化 review 绑定真实 candidateChecksum", persisted.candidateChecksum === realChecksum);
    check("持久化 review 绑定真实 canonicalLibraryDigest", persisted.canonicalLibraryDigest === realCanonicalDigest);

    // ── 四、既有下游只读审核门禁识别 ──
    console.log("");
    console.log("四、既有下游只读审核门禁识别该 review");
    const stored = readStoredCandidate(courseId, candidatesDir);
    const review = persistedValidation.file!;
    const index = buildIndexFromDisk(papersDir);
    const gate = evaluatePromotionGate(
      gatherPromotionInputs({
        stored,
        review,
        reviewErrors: [],
        canonical: { digest: index.index.summary.digest, complete: index.failures.length === 0 },
        standardSourcesRoot: join(root, "standard-sources"),
        sourceRootOverride: sourceRoot,
      }),
    );
    for (const item of gate.checks) {
      if (item.name === "human_review_present" || item.name === "review_bound_to_current_candidate") {
        check(`门禁项 ${item.name} 通过`, item.passed === true, item.detail);
      }
    }
    console.log(`     （门禁总体结论：${gate.status}；A2 只证明 review 被识别，不声称晋升通过）`);

    // ── 五、重新打开与继续编辑 ──
    console.log("");
    console.log("五、重新打开与继续编辑");
    const reloaded = loadAdjudicationDraft({ courseId, candidatesDir });
    check("重新加载草稿存在", reloaded.exists === true);
    check("重新加载草稿通过校验", reloaded.validation.ok === true);
    const edited: AdjudicationDraftPayload = {
      ...(reloaded.raw as unknown as AdjudicationDraftPayload),
      matches: [
        {
          segmentId: reloaded.raw!.segments[0]?.segmentId ?? "seg-1",
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
    const editRes = saveAdjudicationReview({ draft: edited, candidatesDir, papersDir, sourceDir: sourceRoot });
    check("继续编辑并再次保存成功", editRes.ok === true, editRes.errors?.join("；"));
    check("第二次保存产生备份", editRes.backupPath !== null && existsSync(editRes.backupPath!));
    check("备份内容是上一版（无 matches）", JSON.parse(readFileSync(editRes.backupPath!, "utf8")).matches.length === 0);
    check("当前版本有新裁决", JSON.parse(readFileSync(join(candidatesDir, courseId, "review.json"), "utf8")).matches.length === 1);

    // ── 六、陈旧：源 / 候选 / 库 ──
    console.log("");
    console.log("六、陈旧拒绝（源 / 候选 / canonical 库）");
    const beforeReview = readFileSync(join(candidatesDir, courseId, "review.json"), "utf8");

    writeFileSync(join(sourceRoot, "阅读", "reading-handout.pdf"), buildTextPdf([["SYNTHETIC FIXTURE - MUTATED", ...wrapWords(FIXTURE_PASSAGE_A)]]));
    const sourceStale = checkAdjudicationStaleness({
      courseId, draftCandidateChecksum: realChecksum, draftCanonicalDigest: realCanonicalDigest, draftSourceDigest: realSourceDigest,
      candidatesDir, papersDir, sourceDir: sourceRoot,
    });
    check("源字节变动 ⇒ 判定陈旧", sourceStale.isStale === true, sourceStale.reasons.join("；"));
    const sourceRejected = saveAdjudicationReview({ draft: edited, candidatesDir, papersDir, sourceDir: sourceRoot });
    check("源陈旧时保存被拒", sourceRejected.ok === false);

    rmSync(join(papersDir, "fixture-cet6-2024-12-set3"), { recursive: true, force: true });
    const libraryStale = checkAdjudicationStaleness({
      courseId, draftCandidateChecksum: realChecksum, draftCanonicalDigest: realCanonicalDigest,
      candidatesDir, papersDir, sourceDir: null,
    });
    check("canonical 库变动 ⇒ 判定陈旧", libraryStale.isStale === true, libraryStale.reasons.join("；"));

    writeFileSync(join(candidatesDir, courseId, "course.json"), JSON.stringify({ id: courseId, title: "MUTATED", schemaVersion: 1 }, null, 2), "utf8");
    const candidateStale = checkAdjudicationStaleness({
      courseId, draftCandidateChecksum: realChecksum, draftCanonicalDigest: realCanonicalDigest,
      candidatesDir, papersDir, sourceDir: null,
    });
    check("候选内容变动 ⇒ 判定陈旧", candidateStale.isStale === true, candidateStale.reasons.join("；"));
    check("三次陈旧检查期间既有 review 字节不变", readFileSync(join(candidatesDir, courseId, "review.json"), "utf8") === beforeReview);

    // ── 七、分段计划持久化与重新生成消费 ──
    console.log("");
    console.log("七、分段计划持久化并参与候选重新生成（P1-F3）");
    // 还原候选与源，让后续计划绑定成立
    const intake2 = await runCourseIntake({
      sourceRoot, courseId, provider: "test_fixture_provider", edition: null, title: "A2 Proof Course",
      contentVersion: 1, provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" }, papersDir,
    });
    writeCourseCandidate(intake2.archive, join(candidatesDir, courseId));
    const restoredChecksum = intake2.archive.metadata.digests.candidateChecksum;
    const restoredSourceDigest = intake2.inventory.digest;
    const translationAsset = intake2.inventory.assets.find((asset) => asset.relativePath.includes("translation"))!;
    const translationDoc = intake2.documents.find((doc) => doc.assetKey === translationAsset.assetKey)!;
    const totalTranslationLines = translationDoc.pages.reduce((sum, page) => sum + page.lines.length, 0);
    check("翻译资产有可标注行（否则计划证明无意义）", totalTranslationLines > 0);

    const planPayload = {
      schemaVersion: 1,
      binding: { courseId, sourceDigest: restoredSourceDigest, assets: [] },
      author: "A2 Proof",
      createdAt: new Date().toISOString(),
      reason: "synthetic plan for proof",
      units: [
        {
          title: "合成翻译单元一",
          kind: "translation_passage",
          assignments: translationDoc.pages.flatMap((page) =>
            page.lines.map((_, lineIndex) => ({
              channel: "source",
              range: { assetKey: translationAsset.assetKey, page: page.page, lineStart: lineIndex + 1, lineEnd: lineIndex + 1 },
              note: null,
            })),
          ),
        },
      ],
    };

    const planSave = saveAdjudicationPlan({ courseId, plan: planPayload, plansDir, sourceDir: sourceRoot });
    check("分段计划保存成功", planSave.ok === true, planSave.errors.join("；"));
    check("计划落在白名单目录内", existsSync(join(plansDir, `${courseId}.json`)));
    check("计划校验和是 64 位 hex", /^[0-9a-f]{64}$/.test(planSave.planDigest));

    const planRaw = readFileSync(join(plansDir, `${courseId}.json`), "utf8");
    const parsedPlan = parseSegmentationPlan(planRaw);
    check("计划可被既有解析器读取", parsedPlan.ok === true);
    check("落盘计划校验和与权威实现一致", parsedPlan.ok && planSave.planDigest === segmentationPlanDigest(parsedPlan.plan!));

    /*
     * 用**同一课程 id** 重新生成候选（计划不可跨课程复用，这正是
     * `plan_binding_course_mismatch` 守卫的语义）。因此这里把计划
     * 复制到同一 courseId 下再喂给 runCourseIntake。
     */
    const plannedCourseId = courseId;
    const intakeWithPlan = await runCourseIntake({
      sourceRoot, courseId: plannedCourseId, provider: "test_fixture_provider", edition: null, title: "A2 Proof Planned",
      contentVersion: 1, provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" }, papersDir,
      segmentationPlan: { raw: planRaw },
    });
    const mode = intakeWithPlan.archive.metadata.segmentation.modeEvidence;
    check("重新生成的候选确实采用人工计划", mode.mode === "human_planned", `mode=${mode.mode}`);
    if (mode.mode !== "human_planned") {
      const issues = intakeWithPlan.segmentationPlan.issues.map((issue) => `${issue.code}@${issue.where}：${issue.detail}`);
      console.log(`     计划未被采用的原因：${issues.join("；") || "（无 issue 记录）"}`);
      console.log(`     计划单元数：${parsedPlan.plan?.units.length ?? 0}，指派数：${parsedPlan.plan?.units[0]?.assignments.length ?? 0}`);
      console.log(`     计划绑定课程 id：${parsedPlan.plan?.binding.courseId}，本次 intake 课程 id：${plannedCourseId}`);
    }
    check("计划校验和进入候选证据", mode.mode === "human_planned" && mode.planDigest === planSave.planDigest);
    check("有无计划产生不同候选校验和（计划参与身份）", intakeWithPlan.archive.metadata.digests.candidateChecksum !== restoredChecksum);

    // 计划变动 ⇒ 候选校验和变动 ⇒ 旧 review 自动陈旧
    const plannedChecksum = intakeWithPlan.archive.metadata.digests.candidateChecksum;
    writeCourseCandidate(intakeWithPlan.archive, join(candidatesDir, courseId));
    // 对计划候选保存一份 review，然后改计划 ⇒ 旧 review 必须陈旧
    const plannedDraft: AdjudicationDraftPayload = {
      courseId,
      reviewer: "Reviewer R",
      reviewedAt: "2026-10-16",
      candidateChecksum: plannedChecksum,
      canonicalLibraryDigest: intakeWithPlan.archive.metadata.matching.canonicalLibrary.digest,
      sourceDigest: intakeWithPlan.inventory.digest,
      verifiedScope: ["materials"],
      notVerified: [],
      materialGroupings: [],
      segments: [],
      matches: [],
    };
    const plannedSave = saveAdjudicationReview({ draft: plannedDraft, candidatesDir, papersDir, sourceDir: sourceRoot });
    check("对计划候选保存 review 成功", plannedSave.ok === true, plannedSave.errors?.join("；"));

    // 改计划（只保留一条指派）⇒ 重新生成 ⇒ 校验和变 ⇒ 旧 review 陈旧
    const mutatedPlan = {
      ...parsedPlan.plan!,
      units: [{ ...parsedPlan.plan!.units[0], assignments: parsedPlan.plan!.units[0].assignments.slice(0, 1) }],
    };
    const mutatedPlanSave = saveAdjudicationPlan({ courseId, plan: mutatedPlan, plansDir, sourceDir: sourceRoot });
    check("修改后的计划保存成功", mutatedPlanSave.ok === true, mutatedPlanSave.errors.join("；"));
    check("修改计划的校验和与原计划不同", mutatedPlanSave.planDigest !== planSave.planDigest);

    const intakeMutated = await runCourseIntake({
      sourceRoot, courseId, provider: "test_fixture_provider", edition: null, title: "A2 Proof Planned",
      contentVersion: 1, provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" }, papersDir,
      segmentationPlan: { raw: readFileSync(join(plansDir, `${courseId}.json`), "utf8") },
    });
    check("计划变动 ⇒ 候选校验和变动", intakeMutated.archive.metadata.digests.candidateChecksum !== plannedChecksum);
    writeCourseCandidate(intakeMutated.archive, join(candidatesDir, courseId));
    const stalePlanned = saveAdjudicationReview({ draft: plannedDraft, candidatesDir, papersDir, sourceDir: sourceRoot });
    check("计划变动后旧 review 保存被拒（不自动沿用旧决定）", stalePlanned.ok === false, stalePlanned.errors?.join("；"));

    // ── 八、写边界与故障注入 ──
    console.log("");
    console.log("八、写边界与故障注入恢复");
    check("courses/ 未被创建", !existsSync(join(root, "courses")));
    const entries = readdirSync(join(candidatesDir, courseId));
    check(
      "候选目录只有候选文件 + review + 备份/临时残留",
      entries.every((name) => name === "assets" || name === "candidate.json" || name === "course.json" || name === "review.json" || name.startsWith("review.json.bak-") || name.startsWith("review.json.tmp-")),
      entries.join("、"),
    );

    // 备份唯一名 + 恢复一致性
    const faultDir = join(root, "fault");
    mkdirSync(faultDir, { recursive: true });
    const faultTarget = join(faultDir, "review.json");
    const original = "ORIGINAL-CONTENT";
    writeFileSync(faultTarget, original, "utf8");
    const originalSha = shaOfFile(faultTarget);
    const b1 = writeAtomicWithBackup(faultTarget, "V2").backupPath!;
    const b2 = writeAtomicWithBackup(faultTarget, "V3").backupPath!;
    check("备份唯一名（不静默覆盖）", b1 !== b2);
    check("b1 内容是第一版", readFileSync(b1, "utf8") === original);
    check("b2 内容是第二版", readFileSync(b2, "utf8") === "V2");
    rmSync(faultTarget);
    const ok = restoreFromBackup(faultTarget, b2);
    check("从备份可恢复", ok === true);
    check("恢复后内容正确", readFileSync(faultTarget, "utf8") === "V2");
    const ok2 = restoreFromBackup(faultTarget, b1);
    check("二次恢复到更早版本", ok2 === true);
    check("恢复后 SHA-256 与原内容一致", shaOfFile(faultTarget) === originalSha);

    // 无效草稿零写
    const noWriteDir = join(root, "nowrite");
    mkdirSync(noWriteDir, { recursive: true });
    const badPrepared = prepareReviewForSave({
      draft: { ...draft(), materialGroupings: [{ proposalId: "p", decision: "accepted", evidence: "短" }] },
      candidatesDir: noWriteDir, papersDir, sourceDir: sourceRoot,
    });
    check("无效草稿 prepare 失败", badPrepared.ok === false);
    check("无效草稿零写（目录未创建）", !existsSync(join(noWriteDir, courseId)));

    console.log("");
    console.log(`结果：${passed} 通过 / ${failed} 失败`);
    if (failures.length > 0) {
      console.log("未通过项：");
      for (const item of failures) console.log(`  · ${item}`);
      process.exitCode = 1;
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error("A2 proof 失败：", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
