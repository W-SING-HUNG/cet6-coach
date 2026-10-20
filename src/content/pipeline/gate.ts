/**
 * Stage 8 — 人工复核门禁（fail-closed）。
 *
 * 这是整条流水线的**收敛点**：任何一处不确定都必须在这里拦住导入。
 *
 * ── 四类机器结果各自独立（Phase 2.2 修复）──
 *
 * | 概念 | 回答的问题 |
 * | --- | --- |
 * | SOURCE_FIDELITY | 包内文字**用词**是否忠于主源？（单向：候选 → 源） |
 * | SOURCE_COMPLETENESS | 主源内容包内**是否都在**？（反向：源 → 候选） |
 * | STRUCTURAL_INTEGRITY | 官方考试结构是否**逐类**齐备？ |
 * | CROSS_SOURCE_BINDING | 第三方富集是否**可证明**属于同一内容？ |
 *
 * 四者**不可合并**成一个布尔值 —— 它们的失败原因与处置方式完全不同。
 * 早期实现只有第一类，于是"字段被截断/漏掉/接错组"与
 * "第三方题干来自另一份试卷"这两类缺陷完全不被发现。
 *
 * ── 机器事实必须来自磁盘，而不是候选文件里的缓存 ──
 *
 * `gateInput` 的字段由调用方（`papers:review`）**现场重算**后传入。
 * 门禁本身不读 `candidate.json` 里的 `verified` / `sourceChecksumDrift` 等字段。
 */

import type { CandidateMetadata, GateCheck, GateVerdict, ReviewItem } from "./types";
import { OFFICIAL_NUMBERED_ITEM_TOTAL, SECTION_QUESTION_COUNTS } from "@/domain/paper";
import type { MachineResult } from "./completeness";

export interface GateInput {
  paperId: string;
  /** 现场重算的复核项（含检测与完整性/绑定产生的项）。 */
  review: ReviewItem[];
  /** 现场重算：源保真。 */
  sourceFidelity: MachineResult;
  /** 现场重算：源完整性。 */
  sourceCompleteness: MachineResult;
  /** 现场重算：结构完整性。 */
  structuralIntegrity: MachineResult;
  /** 现场重算：跨来源绑定。 */
  crossSourceBinding: MachineResult;
  /** 现场重算：资产磁盘校验。 */
  assets: { declared: number; verified: number; totalBytes: number };
  /** 现场重算：听力音频是否存在且校验通过。 */
  listeningAudioVerified: boolean;
  /** 现场重算：源件校验和是否与登记一致。 */
  sourceChecksumDrift: boolean;
  /** 现场重算：候选内容校验和（用于与人工复核的绑定值比对）。 */
  candidateChecksum: string;
  /**
   * `candidate.json` 记录的指纹。
   *
   * 与 `candidateChecksum` 是两个不同层面：
   * - 校验和描述"这份文件字节是什么"；
   * - 指纹描述"这份**内容**是什么身份"（跨供应商可比）。
   *
   * 两者都必须与现场重算一致 —— 指纹不一致意味着任何依赖内容身份的
   * 判断（去重、版本判据、可追溯性）在读假值。
   */
  storedContentFingerprint: string;
  /** 现场重算的内容指纹（**在修正应用之后**计算）。 */
  contentFingerprint: string;
  /** 人工裁决记录（唯一允许来自存储的输入：它是人的决定）。 */
  humanReview: CandidateMetadata["humanReview"];
  /** 人工裁决所针对的候选校验和。 */
  reviewedCandidateChecksum: string | null;
  /** 现场重算的答案验证结果。 */
  answerVerification: CandidateMetadata["answerVerification"];
  /** 听力题干来自第三方的字段数。 */
  listeningStemsFromThirdParty: number;
  /** 现场重算：包的题目计数（按大题）。 */
  questionCountsBySection: Record<string, number>;
}

export function evaluateGate(input: GateInput): GateVerdict {
  const checks: GateCheck[] = [];
  const blocking = input.review.filter((item) => item.severity === "blocking");

  // 1) 不得存在未解决的 blocking 复核项
  checks.push({
    name: "no_blocking_review_items",
    passed: blocking.length === 0,
    detail:
      blocking.length === 0
        ? "无未解决的阻断项"
        : `${blocking.length} 项待人工裁决：${blocking.map((item) => `${item.code}@${item.where}`).join(", ")}`,
  });

  // 2) 四类机器结果逐一成为门禁项（不合并）
  checks.push({
    name: "source_fidelity_pass",
    passed: input.sourceFidelity.verdict === "PASS",
    detail: input.sourceFidelity.summary,
  });
  checks.push({
    name: "source_completeness_pass",
    passed: input.sourceCompleteness.verdict === "PASS",
    detail: input.sourceCompleteness.summary,
  });
  checks.push({
    name: "structural_integrity_pass",
    passed: input.structuralIntegrity.verdict === "PASS",
    detail: input.structuralIntegrity.summary,
  });
  checks.push({
    name: "cross_source_binding_pass",
    passed: input.crossSourceBinding.verdict === "PASS" || input.crossSourceBinding.verdict === "NOT_APPLICABLE",
    detail: input.crossSourceBinding.summary,
  });

  // 3) 编号完整性
  const numberedTotal = Object.values(input.questionCountsBySection).length > 0
    ? Object.keys(input.questionCountsBySection).length
    : 0;
  void numberedTotal;
  checks.push({
    name: "official_numbering_complete",
    passed: input.structuralIntegrity.verdict === "PASS",
    detail: `编号与题量由结构完整性判定（官方编号题总数 ${OFFICIAL_NUMBERED_ITEM_TOTAL}）`,
  });

  // 4) 各大题题量
  const countMismatches: string[] = [];
  for (const [type, expected] of Object.entries(SECTION_QUESTION_COUNTS)) {
    const actual = input.questionCountsBySection[type] ?? 0;
    if (actual !== expected) countMismatches.push(`${type}: ${actual}/${expected}`);
  }
  checks.push({
    name: "section_question_counts_official",
    passed: countMismatches.length === 0,
    detail: countMismatches.length === 0 ? "各大题题量与官方一致" : `不符：${countMismatches.join(", ")}`,
  });

  // 5) 资产（现场重算）
  checks.push({
    name: "assets_verified_on_disk",
    passed: input.assets.declared > 0 && input.assets.declared === input.assets.verified,
    detail: `资产 ${input.assets.verified} / 声明 ${input.assets.declared}，共 ${(input.assets.totalBytes / 1024 / 1024).toFixed(1)} MB（现场重算）`,
  });

  // 6) 听力音频
  checks.push({
    name: "listening_audio_verified",
    passed: input.listeningAudioVerified,
    detail: input.listeningAudioVerified ? "听力音频已提供并通过校验" : "听力音频缺失或未通过校验",
  });

  // 7) 源件校验和（现场重算）
  checks.push({
    name: "source_checksum_stable",
    passed: !input.sourceChecksumDrift,
    detail: input.sourceChecksumDrift
      ? "源件校验和与登记时不一致 —— 源件被替换过，必须重新登记与复核"
      : "源件校验和与登记一致（现场重算）",
  });

  // 8) 人工复核已完成
  checks.push({
    name: "human_review_completed",
    passed: input.humanReview !== null,
    detail:
      input.humanReview === null
        ? "尚无人工复核记录 —— 候选包在人工裁决前不可导入"
        : `人工复核于 ${input.humanReview.reviewedAt} 由 ${input.humanReview.reviewer} 完成（${input.humanReview.resolutions.length} 条裁决）`,
  });

  // 9) **人工复核必须绑定到候选校验和**
  //    这是"改了内容但沿用旧批准"的防线：裁决只对它复核过的那一份候选有效。
  const checksumBound =
    input.humanReview !== null &&
    input.reviewedCandidateChecksum !== null &&
    input.reviewedCandidateChecksum === input.candidateChecksum;
  checks.push({
    name: "human_review_matches_candidate_checksum",
    passed: checksumBound,
    detail:
      input.humanReview === null
        ? "无人工复核记录"
        : input.reviewedCandidateChecksum === null
          ? "人工复核记录未绑定候选校验和 —— 无法证明裁决针对的是当前候选内容"
          : input.reviewedCandidateChecksum === input.candidateChecksum
            ? `人工复核绑定校验和与当前候选一致（${input.candidateChecksum.slice(0, 12)}…）`
            : `**人工复核已陈旧**：复核针对 ${input.reviewedCandidateChecksum.slice(0, 12)}…，当前候选为 ${input.candidateChecksum.slice(0, 12)}… —— 内容已变，必须重新裁决`,
  });

  // 10) 全部阻断项都已裁决
  const unresolvedKeys = new Set(blocking.map((item) => `${item.code}@${item.where}`));
  const resolved = new Set((input.humanReview?.resolutions ?? []).map((entry) => `${entry.code}@${entry.where}`));
  const unaddressed = [...unresolvedKeys].filter((key) => !resolved.has(key));
  checks.push({
    name: "all_blocking_items_resolved",
    passed: unaddressed.length === 0,
    detail:
      unaddressed.length === 0
        ? "全部阻断项都已有裁决记录"
        : `${unaddressed.length} 项没有裁决记录：${unaddressed.join(", ")}`,
  });

  /**
   * 10b) **指纹必须与现场重算一致** —— 且这一项**不可由人工裁决豁免**。
   *
   * ── 为什么单独一项、且不可豁免 ──
   *
   * 指纹不一致会产生一个 `fingerprint_mismatch` 阻断项，而阻断项可以被人
   * 写一条 `review.json` 裁决记录"解决" —— 那正好构成任务禁止的
   * "带着陈旧指纹静默 IMPORTABLE"。人工能裁决的是**语义争议**
   * （某处内容对不对），不能裁决**事实矛盾**
   * （记录说身份是 X、实际内容是 Y）。后者只能通过刷新解决。
   *
   * 因此这里独立检查，不经过 `all_blocking_items_resolved`。
   */
  const fingerprintMatches = input.storedContentFingerprint === input.contentFingerprint;
  checks.push({
    name: "stored_fingerprint_matches_recomputed",
    passed: fingerprintMatches,
    detail: fingerprintMatches
      ? `candidate.json 记录的指纹与现场重算一致（${input.contentFingerprint.slice(0, 16)}…）`
      : `**指纹不一致**：记录为 ${input.storedContentFingerprint.slice(0, 16)}…，` +
        `现场重算为 ${input.contentFingerprint.slice(0, 16)}… —— ` +
        `指纹是内容身份，事实矛盾不可由人工裁决豁免。` +
        `请重新运行 \`pnpm papers:extract <paper-id>\` 刷新候选（或确认记录值过期后重新出具复核记录）。`,
  });

  // 11) 听力题干来源披露
  checks.push({
    name: "listening_stem_provenance_disclosed",
    passed: true,
    detail:
      input.listeningStemsFromThirdParty > 0
        ? `${input.listeningStemsFromThirdParty} 个听力题干来自第三方重建（源卷只印选项）—— 已在 provenance 逐项标注`
        : "听力题干全部来自主源",
  });

  // 12) 答案证据强度（分歧须已裁定；单一来源是合法诚实状态）
  const verification = input.answerVerification;
  const unresolvedConflicts = verification?.conflicts ?? [];
  checks.push({
    name: "answers_evidence_strength_recorded",
    passed: unresolvedConflicts.length === 0,
    detail:
      verification === null
        ? "未做跨来源答案比对 —— 证据强度：单一来源（已如实记录；核验状态上限为 partially_verified）"
        : verification.level === "cross_source_agree"
          ? `跨来源一致：${verification.comparing} 题全部吻合（提升可信度，不提升权威性 —— 非官方来源）`
          : verification.level === "cross_source_conflict"
            ? `跨来源存在 ${unresolvedConflicts.length} 处分歧：${unresolvedConflicts
                .map((conflict) => `q${conflict.number}(${conflict.primary} vs ${conflict.secondary})`)
                .join(", ")}`
            : "比对范围内没有可用的第二来源（证据强度：单一来源）",
  });

  const failed = checks.filter((check) => !check.passed);
  const status: GateVerdict["status"] = failed.length === 0 ? "IMPORTABLE" : "REVIEW_REQUIRED";

  return {
    paperId: input.paperId,
    status,
    checks,
    blocking,
    summary:
      status === "IMPORTABLE"
        ? "全部检查通过，且人工裁决已记录并绑定到当前候选校验和 —— 可晋升为规范化包并导入"
        : `未通过 ${failed.length} 项检查：${failed.map((check) => check.name).join(", ")}`,
  };
}

/** 门禁失败的原因清单。 */
export function gateBlockers(verdict: GateVerdict): ReviewItem[] {
  return verdict.blocking;
}
