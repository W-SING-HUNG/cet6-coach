/**
 * 人工复核记录（`review.json`）。
 *
 * 这是门禁的最后一块：`human_review_completed` 检查只认这个文件。
 * **工具从不写它** —— 它只能由人签出。这与"不得因为测试通过而自动批准"是同一条约束：
 * 如果流水线能自己生成复核记录，那"人工复核"就只是一句话。
 *
 * 文件里必须声明：谁复核的、何时、以及**核验了哪些范围**。
 * 门禁会核对：每个阻断项都必须被显式裁决（在 `corrections.json` 或本文件的
 * `resolutions` 中），否则不算已裁决。
 */

import type { CandidateMetadata, ReviewCode } from "./types";

export interface HumanReviewFile {
  paperId: string;
  reviewer: string;
  reviewedAt: string;
  /**
   * 复核所针对的**候选内容校验和**。
   *
   * 这是"改了内容但沿用旧批准"的防线：裁决只对这一个校验和有效。
   * 候选内容一变，本记录立即陈旧 ⇒ 门禁判 `REVIEW_REQUIRED`。
   *
   * 必填（可空但必须显式声明）：写 `null` 表示复核者明确接受
   * "本次复核不绑定具体候选版本"，届时门禁会因此判不通过 ——
   * 这是刻意的：不绑定就等于无法证明裁决针对当前内容。
   */
  candidateChecksum: string | null;
  /** 逐条裁决。有修正的项由 corrections.json 化解；其余在此声明裁决与证据。 */
  resolutions: {
    code: ReviewCode;
    where: string;
    /** 裁决结论（人可读）。 */
    resolution: string;
    /** 支持该裁决的证据（外部来源、源件核对结果、独立副本比对等）。 */
    evidence: string;
  }[];
  /** 复核者确认已核对的范围（如实声明，不得声称未做过的核验）。 */
  verifiedScope: string[];
  /** 明确声明**未**核验的范围 —— 这是 `partially_verified` 的依据。 */
  notVerified: string[];
}

export function validateHumanReviewFile(
  raw: unknown,
): { ok: boolean; errors: string[]; file: HumanReviewFile | null } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["复核记录不是对象"], file: null };
  const candidate = raw as Partial<HumanReviewFile>;

  if (typeof candidate.paperId !== "string" || candidate.paperId.trim() === "") errors.push("paperId 缺失");
  if (typeof candidate.reviewer !== "string" || candidate.reviewer.trim() === "") errors.push("reviewer 缺失");
  if (typeof candidate.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.reviewedAt)) {
    errors.push("reviewedAt 必须是 YYYY-MM-DD");
  }
  // candidateChecksum 必须是显式声明的字符串或 null。
  // 缺失（undefined）与 null 不同：前者说明作者没考虑过绑定问题。
  if (candidate.candidateChecksum === undefined) {
    errors.push(
      "candidateChecksum 缺失 —— 复核必须绑定到具体的候选内容校验和（无绑定则无法证明裁决针对当前内容）",
    );
  } else if (candidate.candidateChecksum !== null && !/^[0-9a-f]{64}$/.test(candidate.candidateChecksum)) {
    errors.push("candidateChecksum 必须是 64 位小写十六进制 sha256 或 null");
  }
  if (!Array.isArray(candidate.resolutions)) errors.push("resolutions 必须是数组");
  if (!Array.isArray(candidate.verifiedScope) || candidate.verifiedScope.length === 0) {
    errors.push("verifiedScope 不得为空 —— 必须声明核验了什么");
  }
  if (!Array.isArray(candidate.notVerified)) errors.push("notVerified 必须是数组（没有未核验项时填空数组）");

  if (Array.isArray(candidate.resolutions)) {
    candidate.resolutions.forEach((resolution, index) => {
      const base = `resolutions[${index}]`;
      if (typeof resolution.code !== "string" || resolution.code.trim() === "") errors.push(`${base}.code 缺失`);
      if (typeof resolution.where !== "string" || resolution.where.trim() === "") errors.push(`${base}.where 缺失`);
      if (typeof resolution.resolution !== "string" || resolution.resolution.trim().length < 4) {
        errors.push(`${base}.resolution 不得为空`);
      }
      if (typeof resolution.evidence !== "string" || resolution.evidence.trim().length < 10) {
        errors.push(`${base}.evidence 不得为空且需足够具体（≥10 字符）`);
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors, file: null };
  return { ok: true, errors: [], file: candidate as HumanReviewFile };
}

/** 门禁所需的人工复核形态：**必然非空**（`humanReview === null` 表示没有记录）。 */
export type HumanReviewRecord = NonNullable<CandidateMetadata["humanReview"]>;

/**
 * 把复核记录转成 `CandidateMetadata.humanReview` 的形态（供门禁使用）。
 *
 * 返回类型刻意**不可空**：本函数只在复核记录已通过校验时调用，
 * 因此调用方不该被迫再判一次 null（那会诱使写出 `!` 或多余分支）。
 */
export function toHumanReview(file: HumanReviewFile): HumanReviewRecord {
  return {
    reviewedAt: file.reviewedAt,
    reviewer: file.reviewer,
    resolutions: file.resolutions.map((resolution) => ({
      code: resolution.code,
      where: resolution.where,
      resolution: resolution.resolution,
      evidence: resolution.evidence,
    })),
  };
}
