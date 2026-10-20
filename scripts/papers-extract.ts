#!/usr/bin/env node
/**
 * `pnpm papers:extract` —— Stage 1–8：来源登记 → 抽取 → 结构检测 → 候选包
 * → 源保真 → 源完整性 → 答案验证 → 听力富集（含量化绑定）→ 门禁求值。
 *
 * 产物（全部在 gitignored 的 private-content/ 下）：
 *
 *   private-content/raw/<paper-id>/sources.json              来源登记（输入）
 *   private-content/candidates/<paper-id>/paper.json           候选包
 *   private-content/candidates/<paper-id>/candidate.json       元数据
 *   private-content/candidates/<paper-id>/corrections.json     人工修正（可选输入）
 *   private-content/candidates/<paper-id>/review.json          人工复核（可选输入）
 *   private-content/audit/<paper-id>-normalization.md          规范化审计
 *
 * **不写数据库、不修改来源、不自动批准候选。**
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import type { PaperAsset } from "@/content/paper/types";
import type { CandidateMetadata, SourceRegistration } from "@/content/pipeline/types";
import { CANDIDATE_PIPELINE_VERSION } from "@/content/pipeline/types";
import { extractPdf, sha256File } from "@/content/pipeline/extract";
import { candidateContentChecksum as computeCandidateChecksum, contentFingerprint } from "@/content/pipeline/fingerprint";
import { detectStructure } from "@/content/pipeline/detect";
import {
  buildCandidate,
  primarySourceTextOf,
  renderAuditTemplate,
  toManifestJson,
  CANDIDATE_METADATA_FILENAME,
  auditTemplateFilename,
} from "@/content/pipeline/candidate";
import { evaluateGate } from "@/content/pipeline/gate";
import {
  applyCorrections,
  validateCorrectionsFile,
  answersStillValid,
  type AppliedCorrection,
} from "@/content/pipeline/corrections";
import {
  parseSecondaryAnswerTable,
  detectTableInternalDefects,
  verifyAnswers,
  answerConflictsToReview,
  buildAnswerEvidenceMatrix,
  matrixStrength,
  renderEvidenceMatrix,
} from "@/content/pipeline/answer-verify";
import { validateHumanReviewFile, toHumanReview } from "@/content/pipeline/review-record";
import { extractStemsFromLineTranscript, extractStemsFromStemCards, htmlToText } from "@/content/pipeline/sources";
import {
  evaluateBindings,
  unboundGroupsToReview,
  stripNavigationGarbage,
  sourceContentDigest,
  validateBindingArtifact,
  type GroupBinding,
  type HumanBindingArtifactRecord,
} from "@/content/pipeline/binding";
import { evaluateStructuralIntegrity, evaluateSourceCompleteness, type MachineResult } from "@/content/pipeline/completeness";
import { buildFidelityReport } from "@/content/pipeline/fidelity";
import { getAuditDir, getCandidatesDir, getRawDir } from "@/content/paper/paths";
import { OFFICIAL_NUMBERED_ITEM_TOTAL } from "@/domain/paper";

interface RegistryFile {
  paperId: string;
  year: number;
  session: "June" | "September" | "December";
  variant: string;
  examDate: string | null;
  /** 来源侧自称的套别标签（**不是身份**，仅作披露）。 */
  providerVariantLabel?: string;
  sources: {
    role: "primary_paper_pdf" | "answer_source" | "listening_audio" | "secondary_reference";
    description: string;
    locator: string;
    retrievedAt: string;
    path?: string;
    assetName?: string;
    textLayer?: "present" | "absent" | "unknown";
    /** 该来源自称的套别标签。 */
    providerSetLabel?: string;
  }[];
  /**
   * 本候选的内容版本。
   *
 * 首次导入用 1；对**已导入包做语义修正**时必须递增。
   * 刻意不由工具"自动 +1" —— 版本是作者声明，不是程序推断。
   */
  contentVersion?: number;
  /** 听力口语题干来源（第三方）。**每个来源都必须能绑定**，否则阻断。 */
  stems?: {
    adapter: "line_transcript" | "stem_cards";
    locator: string;
    file: string;
    providerSetLabel?: string;
  };
  /**
   * 补充的听力题干来源（可选）。
   *
   * 用途：主来源可能缺个别题（实测某来源缺 Q21）。补充来源只填充**主来源缺失**的题号，
   * 且**同样必须通过内容绑定** —— 否则不得使用。
   * 绝不用补充来源覆盖主来源已有的题干。
   */
  additionalStems?: {
    adapter: "line_transcript" | "stem_cards";
    locator: string;
    file: string;
    providerSetLabel?: string;
  }[];
  answerChecks?: {
    labelPrefix: string;
    locator: string;
    file: string;
    from: number;
    to: number;
  }[];
}

function usage(): never {
  console.error("用法: pnpm papers:extract <paper-id> [--registry <registry.json>]");
  process.exit(2);
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const paperId = process.argv[2];
  if (!paperId || paperId.startsWith("--")) usage();

  const registryPath = argValue("--registry") ?? join(getRawDir(), paperId, "sources.json");
  if (!existsSync(registryPath)) {
    console.error(`找不到来源登记文件：${registryPath}`);
    process.exit(1);
  }

  const registry = JSON.parse(readFileSync(registryPath, "utf8")) as RegistryFile;
  if (registry.paperId !== paperId) {
    console.error(`来源登记的 paperId（${registry.paperId}）与命令参数（${paperId}）不一致`);
    process.exit(1);
  }

  console.log(`CET-6 Coach · 半自动试卷抽取流水线（v${CANDIDATE_PIPELINE_VERSION}）`);
  console.log(`试卷：${paperId}`);
  console.log("");

  // ── Stage 1：来源登记 ─────────────────────────────────────────────────
  const primaryEntry = registry.sources.find((source) => source.role === "primary_paper_pdf");
  if (!primaryEntry?.path) {
    console.error("来源登记缺少 primary_paper_pdf 的本地路径（path）");
    process.exit(1);
  }
  const primaryPath = primaryEntry.path;
  if (!existsSync(primaryPath)) {
    console.error(`主源 PDF 不存在：${primaryPath}`);
    process.exit(1);
  }

  const registration: SourceRegistration = {
    paperId,
    examType: "CET6",
    year: registry.year,
    session: registry.session,
    variant: registry.variant,
    expectedExamDate: registry.examDate,
    sources: registry.sources.map((source) => {
      const present = source.path ? existsSync(source.path) : false;
      return {
        role: source.role,
        description: source.description,
        locator: source.locator,
        retrievedAt: source.retrievedAt,
        bytes: present && source.path ? readFileSync(source.path).length : null,
        sha256: present && source.path ? sha256File(source.path) : null,
        textLayer: source.role === "primary_paper_pdf" ? "present" : (source.textLayer ?? "unknown"),
        mimeType: null,
        note: source.path ? `本地：${relative(process.cwd(), source.path)}` : null,
        providerSetLabel: source.providerSetLabel ?? null,
      };
    }),
  };

  console.log("Stage 1 · 来源登记");
  for (const source of registration.sources) {
    const size = source.bytes === null ? "（无本地文件）" : `${source.bytes} 字节`;
    const label = source.providerSetLabel ? ` [自称：${source.providerSetLabel}]` : "";
    console.log(`  ${source.role.padEnd(20)} ${size.padEnd(16)}${label}`);
  }

  // ── Stage 2：抽取 ─────────────────────────────────────────────────────
  console.log("");
  console.log("Stage 2 · 文本层抽取");
  const doc = await extractPdf(primaryPath);
  console.log(`  工具：${doc.tool.name}@${doc.tool.version}`);
  console.log(`  页数：${doc.pages}，视觉行：${doc.lines.length}`);
  console.log(`  无文本层的页：${doc.pagesWithoutTextLayer.length === 0 ? "无" : doc.pagesWithoutTextLayer.join(", ")}`);

  // ── Stage 3：结构检测 ─────────────────────────────────────────────────
  console.log("");
  console.log("Stage 3 · 结构检测");
  const detection = detectStructure({ doc, expectedNumberedTotal: OFFICIAL_NUMBERED_ITEM_TOTAL });
  if (detection.sections.length === 0) {
    console.error("  检测失败：未识别出任何大题。候选包未生成。");
    process.exit(1);
  }
  for (const section of detection.sections) {
    const count = section.groups.reduce((sum, group) => sum + group.questions.length, 0);
    console.log(`  ${section.type.padEnd(32)} ${section.groups.length} 组 / ${count} 题`);
  }
  console.log(`  KEYS 答案表：${Object.keys(detection.keys).length} 项`);

  // ── 资产 ──────────────────────────────────────────────────────────────
  const candidateDir = join(getCandidatesDir(), paperId);
  const assetsDir = join(candidateDir, "assets");
  mkdirSync(assetsDir, { recursive: true });

  const assets: PaperAsset[] = [];
  for (const source of registry.sources) {
    if (source.role !== "listening_audio" || !source.path || !existsSync(source.path)) continue;
    const assetName = source.assetName ?? "listening-full.m4a";
    const target = join(assetsDir, assetName);
    copyFileSync(source.path, target);
    const bytes = readFileSync(target);
    assets.push({
      id: `listening-full-${paperId}`,
      kind: "audio",
      relativePath: `assets/${assetName}`,
      mimeType: assetName.toLowerCase().endsWith(".m4a") ? "audio/mp4" : "audio/mpeg",
      bytes: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      label: `${registry.year}-${
        registry.session === "June" ? "06" : registry.session === "December" ? "12" : "09"
      } CET-6 整卷听力录音（含 Section A/B/C 全部题目）`,
    });
  }

  // ── Stage 7：听力题干富集 + **跨来源绑定** ─────────────────────────────
  let stems: Parameters<typeof buildCandidate>[0]["stems"] = null;
  let garbageRemoved: { number: number; text: string }[] = [];
  const preBindings: { locator: string; providerSetLabel: string | null; stems: Record<number, string>; text: string }[] =
    [];

  if (registry.stems && existsSync(registry.stems.file)) {
    const raw = readFileSync(registry.stems.file, "utf8");
    const text = /<html|<!doctype html/i.test(raw.slice(0, 400)) ? htmlToText(raw) : raw;
    const extraction =
      registry.stems.adapter === "stem_cards"
        ? extractStemsFromStemCards(text, registry.stems.locator)
        : extractStemsFromLineTranscript(text, registry.stems.locator);

    console.log("");
    console.log("Stage 7 · 听力题干富集（第三方）");
    console.log(`  适配器：${extraction.adapter}`);
    console.log(`  来源：${extraction.locator}`);
    console.log(`  该来源自称：${registry.stems.providerSetLabel ?? "（未声明）"}（**套别号不是身份证据**）`);
    console.log(`  提取到 ${extraction.numbers.length} 个候选口语题干`);

    // 剔除抓取页面的导航垃圾
    const cleaned = stripNavigationGarbage(extraction.stems);
    garbageRemoved = cleaned.removed;
    if (garbageRemoved.length > 0) {
      console.log(`  **剔除导航垃圾 ${garbageRemoved.length} 条**（站点 UI 内容，不是试题内容）：`);
      for (const item of garbageRemoved.slice(0, 5)) {
        console.log(`      Q${item.number}: ${JSON.stringify(item.text.slice(0, 70))}`);
      }
    }

    stems = { stems: cleaned.kept, locator: extraction.locator, provenance: "third_party_transcript" };
    preBindings.push({
      locator: extraction.locator,
      providerSetLabel: registry.stems.providerSetLabel ?? null,
      stems: cleaned.kept,
      text,
    });

    // 补充来源：只填充主来源缺失的题号（绝不覆盖已有题干）
    const declaredMissing = Object.entries(cleaned.kept).length < 25
      ? Array.from({ length: 25 }, (_, i) => i + 1).filter((n) => !(n in cleaned.kept))
      : [];
    for (const extra of registry.additionalStems ?? []) {
      if (!existsSync(extra.file)) {
        console.log(`  ! 补充题干来源文件不存在，跳过：${extra.file}`);
        continue;
      }
      const extraRaw = readFileSync(extra.file, "utf8");
      const extraText = /<html|<!doctype html/i.test(extraRaw.slice(0, 400)) ? htmlToText(extraRaw) : extraRaw;
      const extraExtraction =
        extra.adapter === "stem_cards"
          ? extractStemsFromStemCards(extraText, extra.locator)
          : extractStemsFromLineTranscript(extraText, extra.locator);
      const extraCleaned = stripNavigationGarbage(extraExtraction.stems);

      // 只补主来源缺失的题号
      const filled: number[] = [];
      for (const number of declaredMissing) {
        const stem = extraCleaned.kept[number];
        if (stem === undefined) continue;
        stems.stems[number] = stem;
        filled.push(number);
      }
      console.log("");
      console.log(`  Stage 7 补充来源：${extra.locator}`);
      console.log(`      该来源自称：${extra.providerSetLabel ?? "（未声明）"}`);
      console.log(`      补齐题号：${filled.join(",") || "（无）"} —— 仅填充主来源缺失项，不覆盖已有题干`);
      console.log(`      剔除导航垃圾：${extraCleaned.removed.length} 条`);
      // 补充来源同样进入绑定求值（它必须自证属于同一内容）
      preBindings.push({
        locator: extra.locator,
        providerSetLabel: extra.providerSetLabel ?? null,
        stems: extraCleaned.kept,
        text: extraText,
      });
    }
  }

  // ── Stage 4：候选包 ───────────────────────────────────────────────────
  console.log("");
  console.log("Stage 4 · 候选规范化包");
  const built = buildCandidate({
    registration,
    doc,
    detection,
    stems,
    assets,
    primarySourceText: primarySourceTextOf(doc),
    candidatePath: relative(process.cwd(), candidateDir),
    contentVersion: registry.contentVersion,
    sourceVariantLabels: registry.sources
      .filter((source) => source.providerSetLabel)
      .map((source) => ({
        provider: source.description,
        claimedLabel: source.providerSetLabel!,
        locator: source.locator,
      })),
  });

  // ── Stage 7b：绑定求值（含竞争来源检验与人工工件） ────────────────────
  let review = built.review;
  const bindings: GroupBinding[] = [];
  /**
   * 题组级绑定结论（在下方填充）。
   *
   * 声明在这里而不是块内：机器判定（bindingResult）需要它，
   * 而机器判定在块外。
   */
  const groupOutcome: { from: number; to: number; representative: GroupBinding; bound: boolean }[] = [];

  // 人工绑定工件（可选输入）：它必须绑定到主源选项指纹，内容变化即失效
  let bindingArtifactRecords: HumanBindingArtifactRecord[] = [];
  const bindingArtifactPath = join(candidateDir, "binding.json");
  if (existsSync(bindingArtifactPath)) {
    const parsed = validateBindingArtifact(JSON.parse(readFileSync(bindingArtifactPath, "utf8")));
    if (!parsed.ok || !parsed.file) {
      console.error("");
      console.error("人工绑定工件无效（整份作废）：");
      for (const error of parsed.errors) console.error(`  ✗ ${error}`);
      process.exitCode = 1;
      return;
    }
    bindingArtifactRecords = parsed.file.bindings;
    console.log("");
    console.log(`Stage 7b · 人工绑定工件（${parsed.file.reviewer}，${parsed.file.reviewedAt}）`);
    for (const record of bindingArtifactRecords) {
      console.log(`  Q${record.from}–${record.to}：${record.evidence.slice(0, 90)}`);
    }
  }

  // 竞争来源：同一卷的全部第三方来源文本（用于"唯一匹配"检验）
  const competitors: { locator: string; compact: string }[] = [];
  for (const source of registry.sources) {
    if (source.role !== "secondary_reference" || !source.path || !existsSync(source.path)) continue;
    const raw = readFileSync(source.path, "utf8");
    const text = /<html|<!doctype html/i.test(raw.slice(0, 400)) ? htmlToText(raw) : raw;
    competitors.push({ locator: source.locator, compact: text });
  }

  for (const pre of preBindings) {
    const evaluated = evaluateBindings(
      built.paper,
      pre.locator,
      pre.providerSetLabel,
      pre.text,
      competitors,
      bindingArtifactRecords,
      // 只判定该来源**实际提供题干**的题组：补充来源可能只覆盖个别题
      Object.keys(pre.stems).map(Number),
    );
    bindings.push(...evaluated);
    console.log("");
    console.log("Stage 7b · 跨来源内容绑定");
    console.log(`  来源内容摘要：${sourceContentDigest(pre.text).slice(0, 16)}…`);
    console.log(`  竞争来源数：${competitors.length}`);
    for (const binding of evaluated) {
      console.log(`  Q${binding.from}–${binding.to}：${binding.bound ? "已绑定" : "**绑定失败**"}`);
      console.log(`      证据类型：${binding.evidence.kind}（强度：${binding.evidence.strength}）`);
      console.log(`      ${binding.evidence.detail}`);
      console.log(`      主源选项指纹：${binding.primaryFingerprint.slice(0, 16)}…`);
    }
  }
  if (bindings.length > 0) {
    // ── 按题组聚合绑定结论 ──
    //
    // 一个问题组可能由多个来源共同提供题干（实测：主来源缺 Q21，
    // 由补充来源补齐）。此时要求**每个来源单独绑定整组**是过严的 ——
    // 补充来源本来就不负责其他题。
    //
    // 正确判据：**只要有一个来源为该组建立了绑定，该组即视为已绑定**。
    // 未绑定的组才产生阻断项 —— 那意味着该组的题干没有任何来源能自证归属。
    const byGroup = new Map<string, GroupBinding[]>();
    for (const binding of bindings) {
      const key = `${binding.from}-${binding.to}`;
      if (!byGroup.has(key)) byGroup.set(key, []);
      byGroup.get(key)!.push(binding);
    }

    for (const [key, records] of byGroup.entries()) {
      const [from, to] = key.split("-").map(Number);
      const boundRecord = records.find((record) => record.bound);
      const representative = boundRecord ?? records[0];
      console.log(
        `  组 Q${from}–${to}：${boundRecord ? "已绑定" : "**未绑定**"}` +
          `（候选来源 ${records.length} 个` +
          (boundRecord ? `，由 ${boundRecord.locator} 提供绑定证据` : "") +
          `）`,
      );
      for (const record of records) {
        console.log(`      ${record.bound ? "✓" : "✗"} ${record.locator}｜${record.evidence.kind}`);
      }
      groupOutcome.push({ from, to, representative, bound: Boolean(boundRecord) });
    }

    review = [
      ...review,
      ...unboundGroupsToReview(groupOutcome.filter((entry) => !entry.bound).map((entry) => entry.representative)),
    ];
  }

  // ── Stage 6：答案验证 ─────────────────────────────────────────────────
  const answerChecks = registry.answerChecks ?? [];
  if (answerChecks.length > 0) {
    console.log("");
    console.log("Stage 6 · 答案验证（跨来源比对）");
    const sources: NonNullable<CandidateMetadata["answerVerification"]>["sources"] = [];
    const conflicts: NonNullable<CandidateMetadata["answerVerification"]>["conflicts"] = [];
    const notes: string[] = [];
    const tables: { label: string; locator: string; answers: Record<number, string>; texts: Record<number, string> }[] = [];
    let level: "single_source" | "cross_source_agree" | "mostly_agree_with_disagreements" | "cross_source_conflict" =
      "single_source";
    let comparing = 0;
    let agreeing = 0;
    let textAgreeing = 0;

    for (const check of answerChecks) {
      if (!existsSync(check.file)) {
        console.log(`  ! 答案来源文件不存在，跳过：${check.file}`);
        continue;
      }
      const raw = readFileSync(check.file, "utf8");
      const text = /<html|<!doctype html/i.test(raw.slice(0, 400)) ? htmlToText(raw) : raw;
      const table = parseSecondaryAnswerTable(text, check.labelPrefix, check.locator);
      if (!table) {
        console.log(`  ! 在来源中找不到答案表「${check.labelPrefix}」`);
        continue;
      }

      const defects = detectTableInternalDefects(table);
      const verification = verifyAnswers(built.paper, table, { from: check.from, to: check.to });

      console.log(`  来源：${check.locator}`);
      console.log(`    比对 ${verification.comparing} 题：一致 ${verification.agreeing}，分歧 ${verification.conflicts.length}`);
      for (const defect of defects) console.log(`    ! 该表自身缺陷：${defect}`);
      for (const conflict of verification.conflicts) {
        console.log(`    ✗ 第 ${conflict.number} 题分歧：主源=${conflict.primary} 第二来源=${conflict.secondary}`);
      }

      sources.push({ label: table.label, locator: check.locator, internalDefects: defects });
      conflicts.push(...verification.conflicts);
      comparing += verification.comparing;
      agreeing += verification.agreeing;
      textAgreeing += verification.textAgreeing;
      notes.push(verification.note);
      tables.push({ label: table.label, locator: check.locator, answers: table.answers, texts: table.texts });

      if (verification.level !== "single_source") {
        level = verification.conflicts.length > 0 ? "cross_source_conflict" : "cross_source_agree";
      }
      review = [...review, ...answerConflictsToReview(verification, check.locator)];
      for (const defect of defects) {
        review.push({
          code: "answer_not_in_options",
          severity: "advisory",
          where: `<answers-source>/${check.locator}`,
          detail: `${defect} —— 该来源对应题的答案不可采信`,
          evidence: null,
        });
      }
    }

    // ── 逐题证据矩阵 ──
    //
    // 关注题号：全部发生过分歧的题 + 听力里选项含专有名词/数字的关键题
    // （实测 Q19/Q20/Q21/Q25 涉及 Darwin Tree of Life、Tom Oliver 等专有实体，
    //  是跨来源最易出分歧的位置，因此一并列出）。
    const focusNumbers = [
      ...new Set([
        ...conflicts.map((conflict) => conflict.number),
        13, 19, 20, 21, 25,
      ]),
    ].sort((a, b) => a - b);

    const evidenceMatrix = buildAnswerEvidenceMatrix(built.paper, detection.keys, tables, focusNumbers);
    const matrixLevel = matrixStrength(evidenceMatrix.map((entry) => ({
      ...entry,
      distinctValues: new Set(entry.rows.map((row) => row.value).filter((value) => value !== null)).size,
    })));

    // 强度结论以矩阵为准：它才不会把"多数一致但个别分歧"概括成"一致"
    if (tables.length > 0) level = matrixLevel;

    console.log("");
    console.log("  逐题证据矩阵：");
    for (const line of renderEvidenceMatrix(
      evidenceMatrix.map((entry) => ({
        ...entry,
        distinctValues: new Set(entry.rows.map((row) => row.value).filter((value) => value !== null)).size,
      })),
    )) {
      console.log(`    ${line}`);
    }

    built.metadata.answerVerification = {
      level,
      note: notes.join(" "),
      comparing,
      agreeing,
      textAgreeing,
      conflicts,
      sources,
      evidenceMatrix: evidenceMatrix.map((entry) => ({
        number: entry.number,
        outcome: entry.outcome,
        rows: entry.rows.map((row) => ({
          source: row.source,
          locator: row.locator,
          value: row.value,
          text: row.text,
        })),
      })),
    };
  }

  // ── 人工修正 ──────────────────────────────────────────────────────────
  let appliedCorrections: AppliedCorrection[] = [];
  const correctionsPath = join(candidateDir, "corrections.json");
  if (existsSync(correctionsPath)) {
    console.log("");
    console.log("Stage 8a · 应用复核修正（人工裁决）");
    const parsed = validateCorrectionsFile(JSON.parse(readFileSync(correctionsPath, "utf8")));
    if (!parsed.ok || !parsed.file) {
      console.error("  修正文件无效，整份作废：");
      for (const error of parsed.errors) console.error(`    ✗ ${error}`);
      process.exitCode = 1;
      return;
    }
    const outcome = applyCorrections(built.paper, parsed.file);
    appliedCorrections = outcome.applied;
    console.log(`  复核者：${parsed.file.reviewer}（${parsed.file.reviewedAt}）`);
    for (const correction of outcome.applied) {
      console.log(`  ✓ ${correction.where}：${correction.from} → ${correction.to}`);
    }
    for (const rejection of outcome.rejected) console.error(`  ✗ 拒绝：${rejection}`);

    const postIssues = answersStillValid(built.paper);
    if (postIssues.length > 0) review = [...review, ...postIssues];
    review = review.filter((item) => !outcome.resolvedKeys.has(`${item.code}@${item.where}`));

    // 答案分歧同理：已用外部证据裁定保留主源取值的分歧不再阻断，
    // 但**仍留在 answerVerification 的矩阵里**（连同裁定记录）—— 它必须可被追溯，
    // 不能被"解决了"这件事抹掉。只把 conflicts 里已裁定的项移除。
    if (built.metadata.answerVerification) {
      const remaining = built.metadata.answerVerification.conflicts.filter(
        (conflict) => !outcome.resolvedKeys.has(`answer_not_in_options@<answers>/q${conflict.number}`),
      );
      const resolvedCount = built.metadata.answerVerification.conflicts.length - remaining.length;
      built.metadata.answerVerification = {
        ...built.metadata.answerVerification,
        conflicts: remaining,
        level:
          remaining.length === 0 && resolvedCount > 0
            ? "mostly_agree_with_disagreements"
            : built.metadata.answerVerification.level,
        note:
          (resolvedCount > 0
            ? `${resolvedCount} 处来源分歧已经人工裁定并登记（保留主源取值）；`
            : "") + built.metadata.answerVerification.note,
      };
    }
  }

  // ── 人工复核记录 ──────────────────────────────────────────────────────
  let humanReview: CandidateMetadata["humanReview"] = null;
  let reviewedCandidateChecksum: string | null = null;
  const reviewPath = join(candidateDir, "review.json");
  if (existsSync(reviewPath)) {
    const parsed = validateHumanReviewFile(JSON.parse(readFileSync(reviewPath, "utf8")));
    if (!parsed.ok || !parsed.file) {
      console.error("");
      console.error("人工复核记录无效：");
      for (const error of parsed.errors) console.error(`  ✗ ${error}`);
      process.exitCode = 1;
      return;
    }
    humanReview = toHumanReview(parsed.file);
    reviewedCandidateChecksum = parsed.file.candidateChecksum ?? null;
    console.log("");
    console.log("Stage 8b · 人工复核记录");
    console.log(`  复核者：${parsed.file.reviewer}（${parsed.file.reviewedAt}）`);
    console.log(`  绑定候选校验和：${reviewedCandidateChecksum ? `${reviewedCandidateChecksum.slice(0, 12)}…` : "**未绑定**"}`);

    built.paper.verificationStatus = "partially_verified";
    built.paper.provenance.verificationNote =
      `已核验：${parsed.file.verifiedScope.join("；")}。` +
      (parsed.file.notVerified.length > 0 ? `未核验：${parsed.file.notVerified.join("；")}。` : "") +
      `复核者：${parsed.file.reviewer}（${parsed.file.reviewedAt}）。`;
  }

  // ── 内容身份：必须在**修正应用之后**重算（实测缺陷）──────────────────
  //
  // `buildCandidate` 在修正之前就算好了指纹。修正（`relabel_option` /
  // `uphold_primary_answer`）可能改变印出内容 —— 例如 `relabel_option` 改的是
  // 选项**标签**，而指纹刻意用选项文本，因此它通常不改变身份；
  // 但任何改变印出文本的修正都会让旧值失效。
  //
  // 不重算的后果：写进 `candidate.json` 的指纹描述的是**修正前**的内容，
  // 而它就是这份候选对外声明的身份。必须重算。
  const fingerprintBeforeCorrections = built.metadata.contentFingerprint;
  built.metadata.contentFingerprint = contentFingerprint(built.paper);
  if (built.metadata.contentFingerprint !== fingerprintBeforeCorrections) {
    console.log("");
    console.log(
      `  · 修正改变了印出内容：指纹 ${fingerprintBeforeCorrections.slice(0, 12)}… → ${built.metadata.contentFingerprint.slice(0, 12)}…`,
    );
  }

  // ── Stage 5/5b/8：机器结果 ────────────────────────────────────────────
  const paperJson = JSON.stringify(toManifestJson(built.paper), null, 2);

  // 源保真（重新计算，含修正后的 paper）
  const fidelity = buildFidelityReport(
    paperId,
    { file: doc.file, sha256: doc.sha256 },
    primarySourceTextOf(doc),
    collectFidelitySubjectsFor(built.paper),
  );
  built.metadata.fidelity = fidelity;
  if (fidelity.counts.diff > 0) {
    for (const result of fidelity.results.filter((entry) => entry.verdict === "DIFF")) {
      review.push({
        code: "source_checksum_drift",
        severity: "blocking",
        where: result.field,
        detail: `源保真 DIFF：${result.reason}`,
        evidence: result.normalized.slice(0, 240),
      });
    }
  }

  const structuralIntegrity = evaluateStructuralIntegrity(built.paper);
  const sourceCompleteness = evaluateSourceCompleteness({
    paper: built.paper,
    doc,
    alignments: built.alignments,
  });
  review = [...review, ...structuralIntegrity.issues, ...sourceCompleteness.issues];

  const fidelityResult: MachineResult = {
    verdict: fidelity.counts.diff === 0 ? "PASS" : "FAIL",
    checked: fidelity.results.length,
    issues: [],
    summary: `源保真（用词是否忠于主源）：通过 ${fidelity.counts.pass} · DIFF ${fidelity.counts.diff} · 无法比对（第三方）${fidelity.counts.unverifiable}`,
  };
  const bindingResult: MachineResult =
    groupOutcome.length === 0
      ? { verdict: "NOT_APPLICABLE", checked: 0, issues: [], summary: "无条件绑定（未提供第三方听力富集）" }
      : {
          // 判据是**题组级**结论，不是逐来源记录的结论：
          // 一个题组可能由多个来源共同提供题干（主来源缺个别题时由补充来源补齐），
          // 只要有一个来源为该组提供了可证明的绑定，该组即已绑定。
          verdict: groupOutcome.every((entry) => entry.bound) ? "PASS" : "REVIEW_REQUIRED",
          checked: groupOutcome.length,
          issues: [],
          summary:
            `跨来源绑定：${groupOutcome.filter((entry) => entry.bound).length}/${groupOutcome.length} 个题组已建立内容绑定` +
            `（判据：来源的判别性长词覆盖本卷内容族，且该组有组内长词命中；套别号不参与判定）`,
        };

  built.metadata.machine = {
    sourceFidelity: { verdict: fidelityResult.verdict, checked: fidelityResult.checked, summary: fidelityResult.summary },
    sourceCompleteness: {
      verdict: sourceCompleteness.verdict,
      checked: sourceCompleteness.checked,
      summary: sourceCompleteness.summary,
    },
    structuralIntegrity: {
      verdict: structuralIntegrity.verdict,
      checked: structuralIntegrity.checked,
      summary: structuralIntegrity.summary,
    },
    crossSourceBinding: { verdict: bindingResult.verdict, checked: bindingResult.checked, summary: bindingResult.summary },
  };
  built.metadata.listeningBindings = bindings.map((binding) => ({
    from: binding.from,
    to: binding.to,
    primaryFingerprint: binding.primaryFingerprint,
    locator: binding.locator,
    providerSetLabel: binding.providerSetLabel,
    evidenceKind: binding.evidence.kind,
    evidenceDetail: binding.evidence.detail,
    evidenceStrength: binding.evidence.strength,
    bound: binding.bound,
  }));
  built.metadata.garbageRemoved = garbageRemoved;

  const questionCountsBySection: Record<string, number> = {};
  for (const section of built.paper.sections) {
    questionCountsBySection[section.type] = section.groups.reduce((sum, group) => sum + group.questions.length, 0);
  }

  // 候选内容校验和：人工复核绑定到它
  const checksumMetadata: CandidateMetadata = { ...built.metadata, review, reviewedCandidateChecksum: null };
  const currentChecksum = computeCandidateChecksum(paperJson);

  const gate = evaluateGate({
    paperId,
    review,
    sourceFidelity: fidelityResult,
    sourceCompleteness,
    structuralIntegrity,
    crossSourceBinding: bindingResult,
    assets: {
      declared: assets.length,
      verified: assets.length,
      totalBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    },
    listeningAudioVerified: assets.some((asset) => asset.kind === "audio"),
    sourceChecksumDrift: false,
    candidateChecksum: currentChecksum,
    // extract 自己刚算出指纹并写入 candidate.json，因此两侧必然一致。
    // 这里显式传入而不是让门禁跳过检查 —— 门禁的检查项在两条路径上都应生效，
    // 否则"extract 不检查"会成为一个可被利用的缺口。
    storedContentFingerprint: built.metadata.contentFingerprint,
    contentFingerprint: built.metadata.contentFingerprint,
    humanReview,
    reviewedCandidateChecksum,
    answerVerification: built.metadata.answerVerification,
    listeningStemsFromThirdParty: built.metadata.enrichments.length,
    questionCountsBySection,
  });

  const metadata: CandidateMetadata = {
    ...checksumMetadata,
    gate,
    intentionalTransformations: appliedCorrections,
    humanReview,
    reviewedCandidateChecksum,
  };
  metadata.gate.blocking = review.filter((item) => item.severity === "blocking");

  // ── 写出 ──────────────────────────────────────────────────────────────
  writeFileSync(join(candidateDir, "paper.json"), paperJson, "utf8");
  writeFileSync(join(candidateDir, CANDIDATE_METADATA_FILENAME), JSON.stringify(metadata, null, 2), "utf8");

  // ── 审计记录：可安全刷新（实测缺陷）────────────────────────────────────
  //
  // 早先的规则是"已存在 → 不覆盖"。那在**修复之后**成为障碍：
  // 内容已被修正，而审计记录仍在描述旧的来源与绑定状态，
  // 于是"审计记录"与"实际包"互相矛盾 —— 而审计的意义正是可追溯。
  //
  // 现在改为**受支持的安全刷新**：
  //   · 只重写由工具生成的**模板**（`<id>-normalization.md`）；
  //   · 刷新前把旧版本备份到同目录的 `.prev-<时间戳>`，原件永不丢失；
  //   · **不触碰任何源件**（`private-content/raw/` 下的 PDF / HTML / 音频一律只读）；
  //   · **不触碰人工撰写的审计**（`<id>-PROVENANCE.md` 是人的叙述，不由工具生成）。
  //
  // 这条边界很重要：工具拥有的是它自己生成的那一份，不是整个 audit 目录。
  const auditPath = join(getAuditDir(), auditTemplateFilename(paperId));
  mkdirSync(getAuditDir(), { recursive: true });
  if (existsSync(auditPath)) {
    const backupPath = `${auditPath}.prev-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    copyFileSync(auditPath, backupPath);
    console.log("");
    console.log(`审计记录已刷新（旧版备份保留）：${relative(process.cwd(), backupPath)}`);
  }
  writeFileSync(auditPath, renderAuditTemplate(metadata), "utf8");
  console.log(`审计记录（工具生成）已写入：${relative(process.cwd(), auditPath)}`);

  console.log("");
  console.log("Stage 5/5b · 机器判定（四类独立）");
  console.log(`  源保真        ${fidelityResult.verdict.padEnd(16)} ${fidelityResult.summary}`);
  console.log(`  源完整性      ${sourceCompleteness.verdict.padEnd(16)} ${sourceCompleteness.summary}`);
  console.log(`  结构完整性    ${structuralIntegrity.verdict.padEnd(16)} ${structuralIntegrity.summary}`);
  console.log(`  跨来源绑定    ${bindingResult.verdict.padEnd(16)} ${bindingResult.summary}`);
  console.log(`  内容指纹      ${built.metadata.contentFingerprint.slice(0, 16)}…（算法 v${built.metadata.fingerprintAlgorithmVersion}）`);
  console.log(`  候选校验和    ${currentChecksum}`);
  console.log(`                ↑ 人工复核记录（review.json）的 candidateChecksum 必须填此值；`);
  console.log(`                  内容一变它就会失效，门禁会因此判 REVIEW_REQUIRED。`);

  console.log("");
  console.log("Stage 8 · 人工复核门禁");
  for (const check of gate.checks) {
    console.log(`  ${check.passed ? "\u2713" : "\u2717"} ${check.name}`);
    console.log(`      ${check.detail}`);
  }
  console.log("");
  console.log(`门禁结论：${gate.status}`);
  console.log(gate.summary);
  console.log("");
  console.log("**候选包位于 candidates/，导入器看不到它。**");
}

/** 源保真主题（从最终 paper 收集，含修正后的值）。 */
function collectFidelitySubjectsFor(paper: import("@/content/paper/types").ExamPaperContent) {
  const subjects: { field: string; text: string; origin: "primary" | "third_party" }[] = [];
  for (const section of paper.sections) {
    const isListening = section.type.startsWith("listening.");
    for (const group of section.groups) {
      if (group.passage) {
        subjects.push({ field: `${section.id}/${group.id}.passage`, text: group.passage, origin: "primary" });
      }
      if (section.type === "reading.matching" && group.instructions) {
        subjects.push({ field: `${section.id}/${group.id}.instructions`, text: group.instructions, origin: "primary" });
      }
      for (const paragraph of group.paragraphs ?? []) {
        subjects.push({
          field: `${section.id}/${group.id}.paragraphs[${paragraph.label}]`,
          text: paragraph.text,
          origin: "primary",
        });
      }
      for (const word of group.wordBank ?? []) {
        subjects.push({ field: `${section.id}/${group.id}.wordBank["${word}"]`, text: word, origin: "primary" });
      }
      for (const question of group.questions) {
        const base = `${section.id}/${group.id}/${question.id}`;
        if (question.kind === "writing") {
          subjects.push({ field: `${base}.prompt`, text: question.prompt, origin: "primary" });
        } else if (question.kind === "translation") {
          subjects.push({ field: `${base}.sourceText`, text: question.sourceText, origin: "primary" });
        } else if (question.kind === "matching_statement") {
          subjects.push({ field: `${base}.statement`, text: question.statement, origin: "primary" });
        } else if (question.kind === "mcq") {
          for (const option of question.options) {
            subjects.push({ field: `${base}.options[${option.id}]`, text: option.label, origin: "primary" });
          }
          subjects.push({
            field: `${base}.stem`,
            text: question.stem,
            origin: isListening ? "third_party" : "primary",
          });
        }
      }
    }
  }
  return subjects;
}

main().catch((error: unknown) => {
  console.error("抽取失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
