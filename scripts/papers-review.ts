#!/usr/bin/env node
/**
 * `pnpm papers:review` —— 复核汇总与晋升。
 *
 * ── 本命令的核心原则：机器事实必须**现场重算** ──
 *
 * 早先的实现信任 `candidate.json` 里缓存的值（`verified`、`sourceChecksumDrift`、
 * 旧的门禁结论）。那样一份被手工编辑过的候选文件就能让"已通过"这件事
 * 与磁盘实际状态脱钩。现在：
 *
 * | 来源 | 处理 |
 * | --- | --- |
 * | 源件校验和 / 漂移 | **从磁盘重算** |
 * | 资产字节与校验和 | **从磁盘重算** |
 * | 源保真 / 源完整性 / 结构完整性 / 跨来源绑定 | **从磁盘重算** |
 * | 实体冲突 | **从磁盘重算** |
 * | 候选内容校验和 | **现场计算** |
 * | 人工裁决（`corrections.json` / `review.json`） | 读取（它是**人的决定**，不是机器事实） |
 *
 * 人工裁决只对它**复核过的那份候选校验和**有效；候选内容一变即判定陈旧。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join, relative } from "node:path";
import { evaluateGate } from "@/content/pipeline/gate";
import { applyCorrections, validateCorrectionsFile, answersStillValid } from "@/content/pipeline/corrections";
import { validateHumanReviewFile, toHumanReview } from "@/content/pipeline/review-record";
import type { CandidateMetadata } from "@/content/pipeline/types";
import type { ExamPaperContent } from "@/content/paper/types";
import { extractPdf, sha256File } from "@/content/pipeline/extract";
import { detectStructure } from "@/content/pipeline/detect";
import { buildCandidate, primarySourceTextOf } from "@/content/pipeline/candidate";
import { evaluateStructuralIntegrity, evaluateSourceCompleteness } from "@/content/pipeline/completeness";
import { buildFidelityReport } from "@/content/pipeline/fidelity";
import { candidateContentChecksum, contentFingerprint } from "@/content/pipeline/fingerprint";
import {
  evaluateBindings,
  stripNavigationGarbage,
  unboundGroupsToReview,
  validateBindingArtifact,
  type GroupBinding,
  type HumanBindingArtifactRecord,
} from "@/content/pipeline/binding";
import {
  extractStemsFromLineTranscript,
  extractStemsFromStemCards,
  htmlToText,
} from "@/content/pipeline/sources";
import { getCandidatesDir, getPapersDir, getRawDir } from "@/content/paper/paths";
import { NormalizedPackageImporter } from "@/content/paper/importer";
import { OFFICIAL_NUMBERED_ITEM_TOTAL, SECTION_LABELS } from "@/domain/paper";
import { createHash } from "node:crypto";

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

/** 现场重算资产校验（不信任 candidate.json 里记录的结果）。 */
function verifyAssetsOnDisk(
  candidateDir: string,
  assets: { relativePath?: string; path?: string; bytes: number; checksum: string }[],
): { declared: number; verified: number; totalBytes: number; issues: string[] } {
  const issues: string[] = [];
  let verified = 0;
  let totalBytes = 0;
  for (const asset of assets) {
    // 内存模型用 `relativePath`，磁盘契约用 `path`。
    // 早先只读 `relativePath`，于是复核时路径为 undefined 并抛
    // "path argument must be of type string"（实测踩到）。
    // 两种形态都要接受 —— 因为同一份数据在内存与磁盘上字段名不同。
    const relativePath = asset.relativePath ?? asset.path;
    if (relativePath === undefined) {
      issues.push("资产记录缺少路径字段（既无 relativePath 也无 path）");
      continue;
    }
    const path = join(candidateDir, relativePath);
    if (!existsSync(path)) {
      issues.push(`资产文件不存在：${relativePath}`);
      continue;
    }
    const buffer = readFileSync(path);
    totalBytes += buffer.length;
    if (buffer.length !== asset.bytes) {
      issues.push(`资产字节数不符：${relativePath} 声明 ${asset.bytes}，磁盘 ${buffer.length}`);
      continue;
    }
    const checksum = createHash("sha256").update(buffer).digest("hex");
    if (checksum !== asset.checksum) {
      issues.push(`资产校验和不符：${relativePath} —— 审核后被改动`);
      continue;
    }
    verified += 1;
  }
  return { declared: assets.length, verified, totalBytes, issues };
}

async function main(): Promise<void> {
  const paperId = argValue("--paper") ?? process.argv[2];
  if (!paperId || paperId.startsWith("--")) {
    console.error("用法: pnpm papers:review <paper-id> [--promote] [--refresh-fingerprint]");
    console.error("");
    console.error("  --promote              门禁通过后晋升为规范化包");
    console.error("  --refresh-fingerprint 把 candidate.json 记录的指纹刷新为现场重算值");
    console.error("                         （仅用于确认记录值过期；不改变 paper.json 内容）");
    process.exit(2);
  }
  const promote = process.argv.includes("--promote");
  /**
   * 刷新指纹：**受支持的**修复通道。
   *
   * 指纹不一致是"事实矛盾"而非"语义争议"，因此不能靠人工裁决豁免，
   * 只能刷新。刷新有两条合法路径：
   * 1. 重新运行 `papers:extract <id>`（重建整份候选，最彻底）；
   * 2. 本开关 —— 当确认 `candidate.json` 的记录值只是过期、
   *    而 `paper.json` 内容本身正确时，把记录值更新为现场重算值。
   *
   * **它不修改 `paper.json`**：内容由人工修正流程负责，
   * 本开关只同步身份记录。
   */
  const refreshFingerprint = process.argv.includes("--refresh-fingerprint");

  const candidateDir = join(getCandidatesDir(), paperId);
  const metadataPath = join(candidateDir, "candidate.json");
  const paperPath = join(candidateDir, "paper.json");

  console.log("CET-6 Coach · 候选包复核汇总（机器事实现场重算）");
  console.log(`候选：${relative(process.cwd(), candidateDir)}`);
  console.log("");

  if (!existsSync(metadataPath) || !existsSync(paperPath)) {
    console.error("候选包不完整：需要 paper.json 与 candidate.json。先运行 `pnpm papers:extract`。");
    process.exit(1);
  }

  const stored = JSON.parse(readFileSync(metadataPath, "utf8")) as CandidateMetadata;
  const paper = JSON.parse(readFileSync(paperPath, "utf8")) as ExamPaperContent;

  // ── 现场重算：源件校验和与漂移 ────────────────────────────────────────
  const primary = stored.sourceRegistration.sources.find((source) => source.role === "primary_paper_pdf");
  let sourceChecksumDrift = false;
  const sourceIssues: string[] = [];
  if (primary?.note) {
    // note 里记录了本地相对路径
    const localPath = primary.note.replace(/^本地：/, "");
    if (existsSync(localPath)) {
      const actual = sha256File(localPath);
      if (primary.sha256 !== null && actual !== primary.sha256) {
        sourceChecksumDrift = true;
        sourceIssues.push(
          `主源 PDF 校验和与登记不一致：登记 ${primary.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…`,
        );
      }
    } else {
      sourceIssues.push(`主源 PDF 本地文件不存在：${localPath}（无法重算校验和）`);
    }
  }

  // ── 现场重算：抽取 → 检测 → 候选（重建 paper，用于机器判定） ──────────
  const registryPath = join(getRawDir(), paperId, "sources.json");
  const registry = existsSync(registryPath)
    ? (JSON.parse(readFileSync(registryPath, "utf8")) as {
        year: number;
        session: "June" | "September" | "December";
        variant: string;
        examDate: string | null;
      })
    : null;

  let alignments: import("@/content/pipeline/completeness").FieldAlignment[] = [];
  let doc = null as Awaited<ReturnType<typeof extractPdf>> | null;

  if (primary?.note && existsSync(primary.note.replace(/^本地：/, "")) && registry) {
    const localPath = primary.note.replace(/^本地：/, "");
    doc = await extractPdf(localPath);
    const detection = detectStructure({ doc, expectedNumberedTotal: OFFICIAL_NUMBERED_ITEM_TOTAL });

    // 用与 extract 相同的通路重建候选，但**以磁盘上的 paper.json 为准**判定内容，
    // 因此这里只用它取得对齐清单（对齐由主源几何决定，与候选内容无关的字段）
    const rebuilt = buildCandidate({
      registration: stored.sourceRegistration,
      doc,
      detection,
      stems: null,
      assets: [],
      primarySourceText: primarySourceTextOf(doc),
      candidatePath: relative(process.cwd(), candidateDir),
    });
    alignments = rebuilt.alignments;
  } else {
    console.log("  ! 无法重算：缺少主源 PDF 或来源登记 —— 机器判定将如实报告为不可用");
  }

  // ── 现场重算：四类机器结果 ────────────────────────────────────────────
  const fidelity = doc
    ? buildFidelityReport(
        paperId,
        { file: doc.file, sha256: doc.sha256 },
        primarySourceTextOf(doc),
        collectSubjects(paper),
      )
    : null;

  const structuralIntegrity = evaluateStructuralIntegrity(paper);
  const sourceCompleteness = doc
    ? evaluateSourceCompleteness({ paper, doc, alignments })
    : {
        verdict: "REVIEW_REQUIRED" as const,
        checked: 0,
        issues: [
          {
            code: "source_checksum_drift" as const,
            severity: "blocking" as const,
            where: "<completeness>",
            detail: "无法重算源完整性：缺少主源 PDF",
            evidence: null,
          },
        ],
        summary: "源完整性：**未能重算**（缺少主源 PDF）—— 不得视为通过",
      };

  const currentFingerprintBeforeCorrections = contentFingerprint(paper);

  // ── 人工裁决（唯一允许来自存储的输入）────────────────────────────────
  let review = stored.review;

  let humanReview = stored.humanReview;
  let reviewedChecksum = stored.reviewedCandidateChecksum;
  let reviewedAt = stored.reviewedCandidateChecksum;

  const correctionsPath = join(candidateDir, "corrections.json");
  if (existsSync(correctionsPath)) {
    const parsed = validateCorrectionsFile(JSON.parse(readFileSync(correctionsPath, "utf8")));
    if (!parsed.ok || !parsed.file) {
      console.error("修正文件无效（整份作废）：");
      for (const error of parsed.errors) console.error(`  ✗ ${error}`);
      process.exit(1);
    }
    const outcome = applyCorrections(paper, parsed.file);
    review = review.filter((item) => !outcome.resolvedKeys.has(`${item.code}@${item.where}`));
    const postIssues = answersStillValid(paper);
    if (postIssues.length > 0) review = [...review, ...postIssues];
  }

  // ── 内容身份：必须在**修正应用之后**重算（实测缺陷）──────────────────
  //
  // 早先在这一步之前算指纹，于是"修正改变了内容、指纹却仍是修正前的值"：
  // 记录与实际内容不符，而流水线只在控制台打一行 `!` 就继续放行。
  //
  // 正确语义：指纹描述的是**当前发布内容**。修正之后它就是新的内容身份，
  // 因此这里重算，并把它当作判定基准。
  const currentFingerprint = contentFingerprint(paper);
  if (currentFingerprint !== currentFingerprintBeforeCorrections) {
    console.log(
      `  · 修正改变了印出内容：指纹 ${currentFingerprintBeforeCorrections.slice(0, 12)}… → ${currentFingerprint.slice(0, 12)}…`,
    );
  }

  const reviewPath = join(candidateDir, "review.json");
  if (existsSync(reviewPath)) {
    const parsed = validateHumanReviewFile(JSON.parse(readFileSync(reviewPath, "utf8")));
    if (!parsed.ok || !parsed.file) {
      console.error("人工复核记录无效：");
      for (const error of parsed.errors) console.error(`  ✗ ${error}`);
      process.exit(1);
    }
    humanReview = toHumanReview(parsed.file);
    reviewedChecksum = parsed.file.candidateChecksum;
    reviewedAt = parsed.file.candidateChecksum;
  }
  void reviewedAt;

  // ── 现场重算：候选内容校验和 ──────────────────────────────────────────
  //
  // 必须对**磁盘上的原始字节**计算，不能重新序列化：JSON.stringify 会改变
  // 键序与空白，于是同一份内容在 extract 与 review 两侧算出不同摘要，
  // 人工刚绑定的值会立刻被判"陈旧"（实测踩到）。
  // 校验和的语义是"这份候选内容是什么"，因此锚定磁盘字节。
  const paperJson = readFileSync(paperPath, "utf8");
  const currentChecksum = candidateContentChecksum(paperJson);

  // ── 现场重算：资产 ────────────────────────────────────────────────────
  const assetCheck = verifyAssetsOnDisk(candidateDir, paper.assets);

  // ── 现场重算：机器结果 ────────────────────────────────────────────────
  const fidelityResult = {
    verdict: (fidelity === null ? "REVIEW_REQUIRED" : fidelity.counts.diff === 0 ? "PASS" : "FAIL") as
      | "PASS"
      | "FAIL"
      | "REVIEW_REQUIRED",
    checked: fidelity?.results.length ?? 0,
    issues: [] as import("@/content/pipeline/types").ReviewItem[],
    summary:
      fidelity === null
        ? "源保真：**未能重算**（缺少主源 PDF）—— 不得视为通过"
        : `源保真（用词是否忠于主源）：通过 ${fidelity.counts.pass} · DIFF ${fidelity.counts.diff} · 无法比对 ${fidelity.counts.unverifiable}`,
  };

  // ── 现场重算：跨来源绑定 ──────────────────────────────────────────────
  //
  // **不信任 candidate.json 缓存的绑定结论** —— 那是 extract 当时算的。
  // 本阶段的存在意义就是独立重算：若候选被改动、来源被替换、或指纹漂移，
  // 缓存的 PASS 会持续骗过门禁（这正是任务里"复核阶段陈旧/缓存信任"这一类缺陷）。
  //
  // 重算方式与 extract 一致，**并按题组聚合**：一个题组可能由多个来源共同提供
  // 题干，只要有一个来源为该组建立了绑定，该组即已绑定。
  const registryForBinding = existsSync(registryPath)
    ? (JSON.parse(readFileSync(registryPath, "utf8")) as {
        stems?: { adapter: "line_transcript" | "stem_cards"; locator: string; file: string; providerSetLabel?: string };
        additionalStems?: {
          adapter: "line_transcript" | "stem_cards";
          locator: string;
          file: string;
          providerSetLabel?: string;
        }[];
      })
    : null;

  const projectRoot = process.cwd();
  const recomputedBindings: GroupBinding[] = [];
  if (registryForBinding?.stems) {
    const stemSources = [registryForBinding.stems, ...(registryForBinding.additionalStems ?? [])];
    const bindingArtifactPath = join(candidateDir, "binding.json");
    const bindingArtifactRecords =
      existsSync(bindingArtifactPath) &&
      validateBindingArtifact(JSON.parse(readFileSync(bindingArtifactPath, "utf8"))).ok
        ? (JSON.parse(readFileSync(bindingArtifactPath, "utf8")) as { bindings: HumanBindingArtifactRecord[] })
            .bindings
        : [];

    for (const source of stemSources) {
      const absolute = join(projectRoot, source.file);
      if (!existsSync(absolute)) continue;
      const raw = readFileSync(absolute, "utf8");
      const text = /<html|<!doctype html/i.test(raw.slice(0, 400)) ? htmlToText(raw) : raw;
      const extraction =
        source.adapter === "stem_cards"
          ? extractStemsFromStemCards(text, source.locator)
          : extractStemsFromLineTranscript(text, source.locator);
      const cleaned = stripNavigationGarbage(extraction.stems);
      recomputedBindings.push(
        ...evaluateBindings(
          paper,
          source.locator,
          source.providerSetLabel ?? null,
          text,
          [],
          bindingArtifactRecords,
          Object.keys(cleaned.kept).map(Number),
        ),
      );
    }
  }

  // 按题组聚合：任一来源绑定该组即视为该组已绑定
  const groupKeys = new Map<string, GroupBinding[]>();
  for (const binding of recomputedBindings) {
    const key = `${binding.from}-${binding.to}`;
    if (!groupKeys.has(key)) groupKeys.set(key, []);
    groupKeys.get(key)!.push(binding);
  }
  const groupOutcomes = [...groupKeys.values()].map((records) => ({
    representative: records.find((record) => record.bound) ?? records[0],
    bound: records.some((record) => record.bound),
  }));
  const unboundRepresentatives = groupOutcomes.filter((entry) => !entry.bound).map((entry) => entry.representative);

  const bindingResult = {
    verdict: (unboundRepresentatives.length > 0 ? "REVIEW_REQUIRED" : "PASS") as "PASS" | "REVIEW_REQUIRED",
    checked: groupOutcomes.length,
    issues: [] as import("@/content/pipeline/types").ReviewItem[],
    summary:
      groupOutcomes.length === 0
        ? "跨来源绑定：无条件绑定（该卷未提供第三方听力富集）"
        : `跨来源绑定：**现场重算** ${groupOutcomes.filter((entry) => entry.bound).length}/${groupOutcomes.length} 个题组已建立内容绑定` +
          `（判据：来源的判别性长词覆盖本卷内容族；套别号不参与判定）`,
  };

  // 机器判定产生的阻断项（现场重算，不信任缓存）
  review = [
    ...review,
    ...structuralIntegrity.issues,
    ...sourceCompleteness.issues,
    ...sourceIssues.map((issue) => ({
      code: "source_checksum_drift" as const,
      severity: "blocking" as const,
      where: "<source>",
      detail: issue,
      evidence: null,
    })),
    ...assetCheck.issues.map((issue) => ({
      code: "asset_changed_after_review" as const,
      severity: "blocking" as const,
      where: "<assets>",
      detail: issue,
      evidence: null,
    })),
    // 未绑定的题组（现场重算结果，不用缓存）转成阻断项
    ...unboundGroupsToReview(unboundRepresentatives),
  ];

  const questionCountsBySection: Record<string, number> = {};
  for (const section of paper.sections) {
    questionCountsBySection[section.type] = section.groups.reduce((sum, group) => sum + group.questions.length, 0);
  }

  const gate = evaluateGate({
    paperId,
    review,
    sourceFidelity: fidelityResult,
    sourceCompleteness,
    structuralIntegrity,
    crossSourceBinding: bindingResult,
    assets: { declared: assetCheck.declared, verified: assetCheck.verified, totalBytes: assetCheck.totalBytes },
    listeningAudioVerified: paper.assets.some((asset) => asset.kind === "audio") && assetCheck.verified > 0,
    sourceChecksumDrift,
    candidateChecksum: currentChecksum,
    storedContentFingerprint: stored.contentFingerprint,
    contentFingerprint: currentFingerprint,
    humanReview,
    reviewedCandidateChecksum: reviewedChecksum,
    answerVerification: stored.answerVerification,
    listeningStemsFromThirdParty: stored.enrichments.length,
    questionCountsBySection,
  });

  // ── 输出 ──────────────────────────────────────────────────────────────
  console.log("一、来源矩阵（套别号仅为声明，不是身份）");
  for (const source of stored.sourceRegistration.sources) {
    const label = source.providerSetLabel ? ` [自称：${source.providerSetLabel}]` : "";
    console.log(`  ${source.role.padEnd(20)} ${source.locator.slice(0, 60)}${label}`);
  }
  console.log("");

  console.log("二、内容身份（与来源套别号无关）");
  console.log(`  规范内容指纹：${currentFingerprint}（算法 v${stored.fingerprintAlgorithmVersion}）`);
  // 指纹不一致必须**阻断**，不能只是提示（见 ReviewCode.fingerprint_mismatch）。
  // 受支持的做法是通过复核流程刷新它，而不是带着陈旧值放行。
  let storedFingerprint = stored.contentFingerprint;
  const fingerprintStale = stored.contentFingerprint !== currentFingerprint;
  if (fingerprintStale) {
    if (refreshFingerprint) {
      // 受支持的刷新：只更新身份记录，不改内容
      const refreshed = {
        ...stored,
        contentFingerprint: currentFingerprint,
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(metadataPath, `${JSON.stringify(refreshed, null, 2)}\n`, "utf8");
      storedFingerprint = currentFingerprint;
      console.log(
        `  ↻ 已刷新身份记录：${stored.contentFingerprint.slice(0, 12)}… → ${currentFingerprint.slice(0, 12)}…` +
          `（仅更新 candidate.json 的指纹；paper.json 内容未改动）`,
      );
    } else {
      console.log(
        `  ✗ candidate.json 记录的指纹为 ${stored.contentFingerprint.slice(0, 16)}… —— 与现场重算不一致（阻断）`,
      );
    }
  } else {
    console.log("  ✓ candidate.json 记录的指纹与现场重算一致");
  }

  if (storedFingerprint !== currentFingerprint) {
    review = [
      ...review,
      {
        code: "fingerprint_mismatch" as const,
        severity: "blocking" as const,
        where: "<identity>/contentFingerprint",
        detail:
          `candidate.json 记录的指纹与现场重算不一致：记录为 ${storedFingerprint}，` +
          `现场为 ${currentFingerprint}。指纹是内容身份；不一致意味着任何依赖它的判断` +
          `（跨供应商去重、版本判据、审计可追溯性）都在读一个假值。` +
          `请通过受支持的流程刷新：重新运行 \`pnpm papers:extract ${paperId}\` 重建候选，` +
          `或用 \`pnpm papers:review ${paperId} --refresh-fingerprint\` 同步身份记录。` +
          `注意：该项**不可由人工裁决豁免**（见门禁 stored_fingerprint_matches_recomputed）。`,
        evidence: `算法 v${stored.fingerprintAlgorithmVersion}`,
      },
    ];
  }
  if (stored.sourceVariantLabels.length > 0) {
    console.log("  来源侧套别声明：");
    for (const label of stored.sourceVariantLabels) {
      console.log(`      ${label.provider.slice(0, 40)} → 自称「${label.claimedLabel}」`);
    }
  }
  console.log("");

  console.log("三、结构");
  for (const section of paper.sections) {
    const count = section.groups.reduce((sum, group) => sum + group.questions.length, 0);
    console.log(`  ${(SECTION_LABELS[section.type] ?? section.type).padEnd(28)} ${section.groups.length} 组 / ${count} 题`);
  }
  console.log("");

  console.log("四、四类机器判定（现场重算）");
  console.log(`  SOURCE_FIDELITY        ${fidelityResult.verdict.padEnd(16)} ${fidelityResult.summary}`);
  console.log(`  SOURCE_COMPLETENESS    ${sourceCompleteness.verdict.padEnd(16)} ${sourceCompleteness.summary}`);
  console.log(`  STRUCTURAL_INTEGRITY   ${structuralIntegrity.verdict.padEnd(16)} ${structuralIntegrity.summary}`);
  console.log(`  CROSS_SOURCE_BINDING   ${bindingResult.verdict.padEnd(16)} ${bindingResult.summary}`);
  console.log("");

  console.log("五、听力绑定详情");
  if (stored.listeningBindings.length === 0) {
    console.log("  （无第三方听力富集）");
  } else {
    for (const binding of stored.listeningBindings) {
      console.log(`  Q${binding.from}–${binding.to} ${binding.bound ? "已绑定" : "**未绑定**"}`);
      console.log(`      来源：${binding.locator}`);
      console.log(`      自称套别：${binding.providerSetLabel ?? "（未声明）"}（不构成证据）`);
      console.log(`      证据：${binding.evidenceKind} / ${binding.evidenceStrength}`);
      console.log(`      ${binding.evidenceDetail}`);
    }
  }
  console.log("");

  if (stored.garbageRemoved.length > 0) {
    console.log("六、已剔除的抓取页面导航垃圾");
    for (const item of stored.garbageRemoved) {
      console.log(`  Q${item.number}: ${JSON.stringify(item.text.slice(0, 70))}`);
    }
    console.log("");
  }

  console.log("七、答案证据");
  if (stored.answerVerification === null) {
    console.log("  未做跨来源比对（单一来源）");
  } else {
    const verification = stored.answerVerification;
    console.log(`  强度：${verification.level}（比对 ${verification.comparing}，一致 ${verification.agreeing}）`);
    console.log(`  ${verification.note}`);
    for (const conflict of verification.conflicts) {
      console.log(`  ✗ 第 ${conflict.number} 题：主源=${conflict.primary} 第二来源=${conflict.secondary}`);
    }
  }
  console.log("");

  console.log("八、人工裁决状态");
  if (humanReview === null) {
    console.log("  **未裁决。** 候选包在人工填写 review.json 前不可导入。");
  } else {
    console.log(`  复核者：${humanReview.reviewer}，日期：${humanReview.reviewedAt}`);
    console.log(
      `  绑定候选校验和：${reviewedChecksum === null ? "**未绑定**" : `${reviewedChecksum.slice(0, 12)}…`}`,
    );
    console.log(`  当前候选校验和：${currentChecksum.slice(0, 12)}…`);
  }
  console.log("");

  console.log("九、门禁");
  for (const check of gate.checks) {
    console.log(`  ${check.passed ? "\u2713" : "\u2717"} ${check.name}：${check.detail}`);
  }
  console.log("");
  console.log(`门禁结论：${gate.status}`);
  console.log(gate.summary);
  console.log("");

  if (!promote) {
    console.log("（未指定 --promote，候选包保持原位）");
    return;
  }

  if (gate.status !== "IMPORTABLE") {
    console.error("拒绝晋升：门禁未通过。");
    console.error("不得用「手工放行」绕过门禁 —— 先解决上面列出的每一项。");
    process.exitCode = 1;
    return;
  }

  const targetDir = join(getPapersDir(), paperId);
  const targetExists = existsSync(targetDir);

  // ── 晋升前校验候选包（与生产同一个校验器）──
  console.log("晋升前校验候选包（与生产使用同一校验器）…");
  let validated;
  try {
    validated = new NormalizedPackageImporter(getCandidatesDir()).validate({
      relativePath: paperId,
      absolutePath: candidateDir,
    });
    console.log(`  校验通过：${validated.content.id} v${validated.content.contentVersion}`);
  } catch (error) {
    console.error(`  校验失败：${(error as Error).message}`);
    console.error("  拒绝晋升。");
    process.exitCode = 1;
    return;
  }

  // ── 已存在时的**升级**路径（语义修正）──
  //
  // 判定依据：候选的 contentVersion 必须**严格大于**已导入版本，
  // 且已导入包的内容确实不同（否则是重复导入，应拒绝）。
  if (targetExists) {
    const existing = new NormalizedPackageImporter(getPapersDir()).parse({
      relativePath: paperId,
      absolutePath: targetDir,
    });
    const existingVersion = existing.content.contentVersion;
    const incomingVersion = validated.content.contentVersion;

    const upgrades = incomingVersion > existingVersion;
    const existingFp = contentFingerprint(existing.content);
    const incomingFp = contentFingerprint(validated.content);
    const sameFingerprint = existingFp === incomingFp;
    const sameBytes = existing.checksum === validated.checksum;

    /**
     * 版本前进 + 指纹相同 + **字节不同** ⇒ 合法升级。
     *
     * 这是本项目的真实情形，不是边缘情况：指纹刻意排除**第三方口语题干**，
     * 因此"修正听力题干"会让包字节改变、而指纹保持不变。
 * 那类改动是**学习者可见内容**，按策略必须升版本，
     * 却又不会改变内容身份 —— 于是"指纹相同但版本前进"是**正确**的组合。
     *
     * 早先的实现见指纹相同就一律走元数据路径，把这种修正误判为"内容未变"
     * 并拒绝升级（实测踩到：Q21 噪声修复无法晋升）。
     */
    if (upgrades && sameFingerprint && !sameBytes) {
      const backupDir = join(getPapersDir(), `.backup-${paperId}-v${existingVersion}`);
      cpSync(targetDir, backupDir, { recursive: true });
      rmSync(targetDir, { recursive: true, force: true });
      console.log("");
      console.log(`升级路径（身份不变、非指纹内容已修正）：v${existingVersion} → v${incomingVersion}`);
      console.log(`  内容指纹相同：${existingFp.slice(0, 16)}… —— **身份未变**（该修正不在指纹投影内）`);
      console.log(`  但包字节已变，属学习者可见内容的修正 ⇒ 必须升版本`);
      console.log(`  已备份旧版到：${relative(process.cwd(), backupDir)}`);

      mkdirSync(targetDir, { recursive: true });
      cpSync(candidateDir, targetDir, {
        recursive: true,
        filter: (src) =>
          !src.endsWith("candidate.json") && !src.endsWith("corrections.json") && !src.endsWith("review.json"),
      });
      for (const stray of ["candidate.json", "corrections.json", "review.json"]) {
        const path = join(targetDir, stray);
        if (existsSync(path)) rmSync(path);
      }

      console.log("");
      console.log(`已升级到：${relative(process.cwd(), targetDir)}（v${incomingVersion}）`);
      console.log("下一步：pnpm content:validate → pnpm content:import（预演）→ pnpm content:import --commit");
      return;
    }

    if (upgrades && sameFingerprint && sameBytes) {
      console.error("拒绝升级：包字节与已导入版本完全相同 —— 版本涨了但内容一个字都没变。");
      console.error("重跑流水线不会产生差异；若确实有修正，请确认候选里包含它。");
      process.exitCode = 1;
      return;
    }

    if (incomingVersion <= existingVersion) {
      // ── 元数据更新路径 ──
      //
      // 版本不涨是**合法**的一种情形：候选的**印出内容**与已导入包完全一致，
      // 只有 provenance（证据链、逐题矩阵、来源说明）等元数据变新。
      // 这种更新**不得**递增 contentVersion —— 内容是同一版，
 // 涨版本会让历史作答看起来指向了另一版内容。
      //
      // 判据严格：**内容指纹必须完全相同**，且**包字节必须确实不同**
      // （否则就是"什么都没改"，不该产生一次写入）。
      if (incomingVersion === existingVersion && sameFingerprint && !sameBytes) {
        console.log("");
        console.log(`元数据更新（内容指纹相同）：${existingFp.slice(0, 16)}…（算法 v1）`);
        console.log(`  contentVersion 保持 v${existingVersion} —— **内容未变，不涨版本**`);
        console.log(`  仅覆盖 provenance / 验证说明等元数据。`);

          const backupDir = join(getPapersDir(), `.backup-${paperId}-v${existingVersion}-metadata`);
          cpSync(targetDir, backupDir, { recursive: true });
          rmSync(targetDir, { recursive: true, force: true });
          console.log(`  已备份旧版到：${relative(process.cwd(), backupDir)}`);

          mkdirSync(targetDir, { recursive: true });
          cpSync(candidateDir, targetDir, {
            recursive: true,
            filter: (src) =>
              !src.endsWith("candidate.json") && !src.endsWith("corrections.json") && !src.endsWith("review.json"),
          });
          for (const stray of ["candidate.json", "corrections.json", "review.json"]) {
            const path = join(targetDir, stray);
            if (existsSync(path)) rmSync(path);
          }

          console.log("");
          console.log(`已更新：${relative(process.cwd(), targetDir)}（v${incomingVersion}，元数据更新）`);
          console.log("下一步：pnpm content:validate → pnpm content:import（预演）→ pnpm content:import --commit");
          return;
        }

      console.error(
        `拒绝升级：候选版本 v${incomingVersion} 未高于已导入版本 v${existingVersion}。` +
 `内容修正必须递增 contentVersion。请在 sources.json 里显式设置 contentVersion。`,
      );
      process.exitCode = 1;
      return;
    }

    // 内容必须确实变了 —— 版本涨了但内容没变是错误声明
    const existingFingerprint = contentFingerprint(existing.content);
    const incomingFingerprint = contentFingerprint(validated.content);
    console.log("");
    console.log(`升级路径：v${existingVersion} → v${incomingVersion}`);
    console.log(`  已导入内容指纹：${existingFingerprint.slice(0, 16)}…`);
    console.log(`  候选内容指纹：  ${incomingFingerprint.slice(0, 16)}…`);

    if (existingFingerprint === incomingFingerprint) {
      console.error("拒绝升级：内容指纹相同 —— 版本涨了但印出内容未变（可能是仅元数据变更）。");
      console.error("若确实只改元数据，不需要新版本；若有内容修正，请确认候选确实包含修正。");
      process.exitCode = 1;
      return;
    }

    // 覆盖旧包（先备份）
    const backupDir = join(getPapersDir(), `.backup-${paperId}-v${existingVersion}`);
    cpSync(targetDir, backupDir, { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
    console.log(`  已备份旧版到：${relative(process.cwd(), backupDir)}`);

    mkdirSync(targetDir, { recursive: true });
    cpSync(candidateDir, targetDir, {
      recursive: true,
      filter: (src) =>
        !src.endsWith("candidate.json") && !src.endsWith("corrections.json") && !src.endsWith("review.json"),
    });
    for (const stray of ["candidate.json", "corrections.json", "review.json"]) {
      const path = join(targetDir, stray);
      if (existsSync(path)) rmSync(path);
    }

    console.log("");
    console.log(`已升级到：${relative(process.cwd(), targetDir)}（v${incomingVersion}）`);
    console.log(
      "注意：package_path 不变，因此**不会产生重复的试卷行**，学习策略状态（训练池/模考保留）也不受影响。",
    );
    console.log("下一步：pnpm content:validate → pnpm content:import（预演）→ pnpm content:import --commit");
    return;
  }

  // ── 首次晋升 ──
  mkdirSync(getPapersDir(), { recursive: true });
  cpSync(candidateDir, targetDir, {
    recursive: true,
    filter: (src) =>
      !src.endsWith("candidate.json") && !src.endsWith("corrections.json") && !src.endsWith("review.json"),
  });
  for (const stray of ["candidate.json", "corrections.json", "review.json"]) {
    const path = join(targetDir, stray);
    if (existsSync(path)) rmSync(path);
  }

  console.log("");
  console.log(`已晋升到：${relative(process.cwd(), targetDir)}`);
  console.log("下一步：pnpm content:validate → pnpm content:import（预演）→ pnpm content:import --commit");
}

/** 收集源保真主题（从磁盘上的 paper 收集）。 */
function collectSubjects(paper: ExamPaperContent) {
  const subjects: { field: string; text: string; origin: "primary" | "third_party" }[] = [];
  for (const section of paper.sections) {
    const isListening = section.type.startsWith("listening.");
    for (const group of section.groups) {
      if (group.passage) subjects.push({ field: `${section.id}/${group.id}.passage`, text: group.passage, origin: "primary" });
      if (section.type === "reading.matching" && group.instructions) {
        subjects.push({ field: `${section.id}/${group.id}.instructions`, text: group.instructions, origin: "primary" });
      }
      for (const paragraph of group.paragraphs ?? []) {
        subjects.push({ field: `${section.id}/${group.id}.p[${paragraph.label}]`, text: paragraph.text, origin: "primary" });
      }
      for (const word of group.wordBank ?? []) {
        subjects.push({ field: `${section.id}/${group.id}.bank["${word}"]`, text: word, origin: "primary" });
      }
      for (const question of group.questions) {
        const base = `${section.id}/${group.id}/${question.id}`;
        if (question.kind === "writing") subjects.push({ field: `${base}.prompt`, text: question.prompt, origin: "primary" });
        else if (question.kind === "translation") subjects.push({ field: `${base}.sourceText`, text: question.sourceText, origin: "primary" });
        else if (question.kind === "matching_statement") subjects.push({ field: `${base}.statement`, text: question.statement, origin: "primary" });
        else if (question.kind === "mcq") {
          for (const option of question.options) {
            subjects.push({ field: `${base}.options[${option.id}]`, text: option.label, origin: "primary" });
          }
          subjects.push({ field: `${base}.stem`, text: question.stem, origin: isListening ? "third_party" : "primary" });
        }
      }
    }
  }
  return subjects;
}

main().catch((error: unknown) => {
  console.error("复核失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
