/**
 * 候选摘要值的**唯一实现**。
 *
 * ── 为什么必须单独成文件 ──
 *
 * 有两个地方需要算这些摘要：
 *
 * 1. `candidate.ts` —— 生成候选时算出它们并写进 `candidate.json`；
 * 2. `review.ts` —— 复核/晋升时**现场重算**它们，用来检测候选是否被改动过。
 *
 * 若两处各写一份，"现场重算"就会与"生成时记录"用不同的判据，
 * 于是每一份候选都会立刻被判成"自相矛盾"（或者更糟：两边都错得一致，
 * 于是漂移永远检测不到）。因此摘要的计算收敛在这里。
 *
 * ── 摘要覆盖什么 ──
 *
 * 每一项都对应一个**真实可能变化的输入**，且变化都必须让复核失效：
 *
 * | 摘要 | 覆盖 |
 * | --- | --- |
 * | `sourceDigest` | 源资产的（相对路径, 字节数, sha256）三元组 |
 * | `courseChecksum` | `course.json` 的原始字节 |
 * | `groupingDigest` | 材料分组提案的全部字段 |
 * | `segmentationDigest` | 段抽取结果的全部字段 |
 * | `matchingDigest` | 逐段匹配结论 **+ canonical 库快照** |
 *
 * 最后一项里的 canonical 库快照是本阶段的关键：
 * canonical 库一变，`matchingDigest` 就变 ⇒ 候选校验和变 ⇒ 旧复核陈旧。
 * 这样"旧匹配分数被套到新 canonical 包上"在结构上不可能发生。
 */

import { createHash } from "node:crypto";
import { stableStringify } from "@/content/pipeline/fingerprint";
import { COURSE_PIPELINE_VERSION } from "./types";
import { segmentationModeDigest } from "./plan-apply";
import type {
  CandidateMatchingResult,
  MaterialGroupingResult,
  MaterialSegmentation,
  SegmentationModeEvidence,
} from "./types";

export interface CandidateDigestInput {
  sourceDigest: string;
  courseChecksum: string;
  groupingDigest: string;
  segmentationDigest: string;
  matchingDigest: string;
}

/**
 * 候选校验和 —— **`review.json` 绑定的对象**。
 *
 * 输入刻意包含 `pipelineVersion`：同一次抽取在不同版本的流水线下的产物
 * 不应被当作同一份候选（段的语义可能已经变了）。
 */
export function courseCandidateChecksum(digests: CandidateDigestInput): string {
  const canonical = stableStringify({
    pipelineVersion: COURSE_PIPELINE_VERSION,
    sourceDigest: digests.sourceDigest,
    courseChecksum: digests.courseChecksum,
    groupingDigest: digests.groupingDigest,
    segmentationDigest: digests.segmentationDigest,
    matchingDigest: digests.matchingDigest,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 材料分组的规范摘要。 */
export function courseGroupingDigest(grouping: MaterialGroupingResult): string {
  const canonical = {
    proposals: [...grouping.proposals]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((proposal) => ({
        id: proposal.id,
        title: proposal.title,
        normalizedStem: proposal.normalizedStem,
        folderContext: proposal.folderContext,
        moduleHint: proposal.moduleHint,
        representations: [...proposal.representations]
          .sort((a, b) => a.assetKey.localeCompare(b.assetKey))
          .map((representation) => ({
            assetKey: representation.assetKey,
            kind: representation.kind,
            label: representation.label,
          })),
        basis: proposal.basis,
        evidence: proposal.evidence,
        ambiguous: proposal.ambiguous,
        reviewRequired: proposal.reviewRequired,
      })),
    invariantViolations: [...grouping.invariantViolations].sort(),
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

/**
 * 段抽取的规范摘要。
 *
 * 覆盖段正文本身（`text` / `transcript` / `referenceTranslation` / `notes`）
 * 以及锚点、音频引用与复核要求 —— 因此"改了段的任何一个字"都会让它变。
 *
 * ── 人工分段计划为什么也在这里 ──
 *
 * 任务书要求："改变人的结构输入**必须**改变候选身份。"
 * 结构来源与计划校验和由 `modeEvidence` 承载，因此把它一并纳入本摘要：
 *
 * - 从自动换成计划（或反过来）⇒ 摘要变 ⇒ 候选校验和变；
 * - 计划的单元/范围被改动（计划校验和随之变）⇒ 摘要变；
 * - 计划绑定到另一份源 ⇒ 摘要变。
 *
 * 三者都会让已签署的复核**自动陈旧**，从而强制重新复核。
 * **绝不自动沿用旧决定。**
 *
 * 注意纳入的是 `segmentationModeDigest(modeEvidence)`（**决定结构的那几项**）
 * 而不是整个 `modeEvidence` —— `planAuthor` / `planCreatedAt` 是审计元数据，
 * 未指派坐标是诊断细节，它们都不应让候选身份无谓地变化。
 */
export function courseSegmentationDigest(
  materials: MaterialSegmentation[],
  modeEvidence?: SegmentationModeEvidence,
): string {
  const canonical = {
    materials: [...materials]
      .sort((a, b) => a.materialProposalId.localeCompare(b.materialProposalId))
      .map((material) => ({
        materialProposalId: material.materialProposalId,
        documentLevelOnly: material.documentLevelOnly,
        segments: [...material.segments]
          .sort((a, b) => a.id.localeCompare(b.id))
          .map((segment) => ({
            id: segment.id,
            kind: segment.kind,
            order: segment.order,
            title: segment.title,
            representationAssetKey: segment.representationAssetKey,
            anchor: segment.anchor,
            audioAssetKey: segment.audioAssetKey,
            text: segment.text,
            transcript: segment.transcript,
            referenceTranslation: segment.referenceTranslation,
            notes: segment.notes,
            reviewRequired: segment.reviewRequired,
            anomalyCodes: segment.anomalies.map((anomaly) => anomaly.code).sort(),
          })),
      })),
    // 结构来源（自动 / 人工计划 + 计划校验和）参与身份
    mode: modeEvidence === undefined ? null : segmentationModeDigest(modeEvidence),
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

/**
 * 匹配结论 + canonical 库快照的规范摘要。
 *
 * **包含 `canonicalLibrary.digest`** —— 这是"canonical 库变化 ⇒ 复核陈旧"
 * 这条要求的落点。若只摘要分数而不含库快照，那么用同一套课程材料
 * 对上新导入的一份真题卷，旧分数会看起来仍然成立。
 *
 * 排除 `contextOnly` 里的展示线索（文件名 / 套别号 / 课程答案）：
 * 它们**不参与打分**，因此不应影响匹配证据的身份。
 * 把它们纳入会让"改一个仅供展示的字段"无谓地让复核失效。
 */
export function courseMatchingDigest(matching: CandidateMatchingResult): string {
  const canonical = {
    algorithmVersion: matching.algorithmVersion,
    projectionVersion: matching.projectionVersion,
    canonicalLibraryDigest: matching.canonicalLibrary.digest,
    segments: [...matching.segments]
      .sort((a, b) => a.segmentId.localeCompare(b.segmentId))
      .map((segment) => ({
        segmentId: segment.segmentId,
        segmentKind: segment.segmentKind,
        label: segment.label,
        ambiguous: segment.ambiguous,
        ambiguityNote: segment.ambiguityNote,
        unmatchedNote: segment.unmatchedNote,
        blocking: segment.blocking,
        suggestions: segment.suggestions.map((suggestion) => ({
          score: suggestion.score,
          label: suggestion.label,
          target: suggestion.target,
          evidence: {
            projectionExact: suggestion.evidence.projectionExact,
            bodyContainment: suggestion.evidence.bodyContainment,
            bodyJaccard: suggestion.evidence.bodyJaccard,
            stemOverlap: suggestion.evidence.stemOverlap,
            optionOverlap: suggestion.evidence.optionOverlap,
            structuralConsistency: suggestion.evidence.structuralConsistency,
          },
        })),
      })),
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}
