/**
 * Stage 5 — 源保真比对（source-fidelity check）。
 *
 * 要解决的问题：人工/半自动结构化会在**所有结构校验器全绿**的情况下改动源文本的用词
 * （实测案例：源卷 `strictly controlled` 被写成 `strictly monitored`）。
 * 结构校验器检查不了这个 —— 它只看形状，不看字词是否忠于来源。
 *
 * 三个由实测倒逼的设计决定（沿用已验收的 `private-content/tools/check-source-fidelity.mjs`）：
 *
 * 1. **必须删空白**：源卷 PDF 存在词内插空格的提取伪影（实测 `dece nt`、`he art`）。
 * 2. **必须保留撇号**：撇号承载用词信息（`status's symbol` ≠ `status symbol`）。
 * 3. **必须按句子而非整段比对**：分页会在任意位置切断长文。
 *
 * 本模块把该逻辑**从私有脚本提升为仓库内的纯函数**，因此可以被合成夹具穷举测试 ——
 * 原脚本只能跑在真实卷上，无法进 CI。
 *
 * ── 已知局限（如实记录，不掩饰）──
 * 紧凑形式对"词被错误合并/拆分"（therapist ↔ the rapist）不敏感。
 * 本题材下风险极低但非零，因此本核对器**不是唯一防线**，
 * 与规范化审计记录互补。
 */

import type { FidelityFieldResult, FidelityReport, FidelityVerdict } from "./types";

/**
 * 参与源保真比对的一个字段。
 *
 * `origin` 的区分是**必需的**：听力口语题干来自第三方文字稿，
 * 对它做"是否在源卷中"的比对必然失败，而那会淹没真正的偏差。
 */
export interface FidelitySubject {
  /** 形如 `sections[2].groups[0].questions[3].options[2]`。 */
  field: string;
  text: string;
  origin: "primary" | "third_party";
}

/** 紧凑形式：删空白与标点，**保留撇号**，统一小写。 */
export function compact(text: string): string {
  return String(text)
    .replace(/\r\n?/g, "")
    .replace(/[\u2018\u2019\u02bc\u02b9\u2032]/g, "'")
    .replace(/[^\p{L}\p{N}']/gu, "")
    .toLowerCase();
}

/** 按句子切分（保留标点供 compact 使用）。 */
export function splitSentences(text: string): string[] {
  return String(text)
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** 判定一条文本是否能在源件中找到（紧凑形式，整体或逐句）。 */
export function judgeAgainstSource(
  text: string,
  sourceCompact: string,
  sourceSentenceSet: Set<string>,
): { verdict: FidelityVerdict; unmatched: string[] } {
  const compacted = compact(text);
  if (compacted.length === 0) return { verdict: "UNVERIFIABLE", unmatched: [] };
  if (sourceCompact.includes(compacted)) return { verdict: "PASS", unmatched: [] };

  const sentences = splitSentences(text)
    .map(compact)
    .filter((sentence) => sentence.length >= 12);
  if (sentences.length === 0) return { verdict: "DIFF", unmatched: [compacted] };

  const unmatched = sentences.filter(
    (sentence) => !sourceSentenceSet.has(sentence) && !sourceCompact.includes(sentence),
  );
  return unmatched.length === 0 ? { verdict: "PASS", unmatched: [] } : { verdict: "DIFF", unmatched };
}

export interface FidelitySubject {
  /** 形如 `sections[2].groups[0].questions[3].options[2]`。 */
  field: string;
  text: string;
  /**
   * 该字段的来源层级。**只有 `primary` 才参与源保真比对** ——
   * 第三方重建的听力题干不在源卷中，对它做比对必然失败，
   * 而那会掩盖真正的偏差。
   */
  origin: "primary" | "third_party";
}

export function buildFidelityReport(
  paperId: string,
  primarySource: { file: string; sha256: string },
  sourceText: string,
  subjects: FidelitySubject[],
): FidelityReport {
  const sourceCompact = compact(sourceText);
  const sourceSentenceSet = new Set(
    splitSentences(sourceText)
      .map(compact)
      .filter((sentence) => sentence.length >= 12),
  );

  const results: FidelityFieldResult[] = [];
  const counts = { pass: 0, diff: 0, unverifiable: 0 };

  for (const subject of subjects) {
    if (subject.text === null || subject.text === undefined || String(subject.text).trim() === "") continue;

    if (subject.origin !== "primary") {
      counts.unverifiable += 1;
      results.push({
        field: subject.field,
        verdict: "UNVERIFIABLE",
        normalized: subject.text,
        sourceForm: null,
        reason: "该字段来自第三方重建，源卷未印出该内容，因此无法与主源比对",
      });
      continue;
    }

    const { verdict, unmatched } = judgeAgainstSource(subject.text, sourceCompact, sourceSentenceSet);
    if (verdict === "PASS") {
      counts.pass += 1;
      results.push({
        field: subject.field,
        verdict: "PASS",
        normalized: subject.text,
        sourceForm: null,
        reason: "用词与主源一致（差异仅限空白、标点与 PDF 提取伪影）",
      });
    } else if (verdict === "UNVERIFIABLE") {
      counts.unverifiable += 1;
      results.push({
        field: subject.field,
        verdict: "UNVERIFIABLE",
        normalized: subject.text,
        sourceForm: null,
        reason: "紧凑形式为空，无法判定",
      });
    } else {
      counts.diff += 1;
      results.push({
        field: subject.field,
        verdict: "DIFF",
        normalized: subject.text,
        sourceForm: null,
        reason: `主源中找不到以下片段（共 ${unmatched.length} 处）：${unmatched.slice(0, 3).map((s) => s.slice(0, 160)).join(" ‖ ")}`,
      });
    }
  }

  return { paperId, primarySource, counts, results };
}
