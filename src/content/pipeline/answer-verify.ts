/**
 * Stage 6 — 答案验证。
 *
 * 目的：把"包内答案是否可信"变成一个**有证据强度标注**的结论，而不是一个布尔值。
 *
 * ── 证据强度的分级（本模块的核心）──
 *
 * | 强度 | 含义 | 可达成的核验状态 |
 * | --- | --- | --- |
 * | `single_source` | 只有主源 KEYS 表一个出处 | 上限 `partially_verified` |
 * | `cross_source_agree` | 第二个独立来源**逐题一致** | 上限 `partially_verified`（仍非官方） |
 * | `cross_source_conflict` | 第二个来源与主源不一致 | **阻断**，必须人工裁定 |
 *
 * ── 三条不允许越过的界线 ──
 *
 * 1. **第三方答案表永远不被称为"官方"。** 实测教育部教育考试院从不公开真题与答案，
 * 因此不存在官方答案来源。本模块的输出里没有"官方"这个档位。
 * 2. **第二来源只用于核对，不用于取值。** 冲突时以主源 KEYS 为准，
 *    但冲突本身必须上报而不是被"调和"掉（那是被否决的方案）。
 * 3. **一致 ≠ 正确。** 两个站点可能抄同一份错表。因此"跨来源一致"提升的是
 *    *可信度*，不是 *权威性* —— 核验状态上限仍是 `partially_verified`。
 */

import type { ExamPaperContent } from "@/content/paper/types";
import type { ReviewItem } from "./types";
import { CJK } from "./text-utils";

/** 第三方答案表的一种解析格式：`N. L text` 行式。 */
export interface SecondaryAnswerTable {
  /** 来源说明（人可读，会进入 provenance）。 */
  label: string;
  locator: string;
  /** 题号 → 标签。 */
  answers: Record<number, string>;
  /** 题号 → 该标签对应的选项文本（用于文本级交叉核对，可选）。 */
  texts: Record<number, string>;
  /**
   * 同一题号在该表内出现多次的题号。
   *
   * 这是**来源自身的缺陷**，不是可以"后写覆盖前者"的情形 ——
   * 实测某第三方存档的答案表在第 13 题印了两行（`13. C To prevent germs…`
   * 与 `13. B The adverse effect…`），其中前者文本属于另一道题。
   * 把它如实记录，才能解释为什么该题的答案不可采信。
   *
   * 站名不写在这里：这条记录要说明的是"第三方答案表会串行"这一**事实类别**，
   * 以及本模块如何检测它。点名某个站点只是把一份对第三方内容质量的公开评价
   * 留在仓库里，对读者判断这段代码没有帮助。
   */
  duplicateNumbers: number[];
}

export type AgreementLevel = "single_source" | "cross_source_agree" | "cross_source_conflict";

export interface AnswerVerification {
  level: AgreementLevel;
  /** 主源 KEYS 覆盖的题号数。 */
  primaryCount: number;
  /** 第二来源覆盖的题号数。 */
  secondaryCount: number;
  comparing: number;
  agreeing: number;
  /** 逐题冲突（主源 vs 第二来源）。 */
  conflicts: { number: number; primary: string; secondary: string; secondaryText: string | null }[];
  /** 只在一个来源中出现的题号 —— 不构成"一致"，必须如实区分。 */
  primaryOnly: number[];
  secondaryOnly: number[];
  /** 选项文本级吻合数（仅统计两侧都有文本且答案一致的题）。 */
  textAgreeing: number;
  /** 结论说明（人可读，直接进入复核报告）。 */
  note: string;
}

/**
 * 解析行式第三方答案表：`1. D Both candidates are quite competitive.`
 *
 * 只认这种形态。不同站点的排版差异很大，用一条"通吃"的正则会变成
 * 看起来能跑但随时静默出错的代码（同类理由见 `sources.ts` 的适配器说明）。
 */
export function parseSecondaryAnswerTable(
  text: string,
  labelPrefix: string,
  locator: string,
): SecondaryAnswerTable | null {
  const lines = text.split("\n").map((line) => line.trim());
  const start = lines.findIndex((line) => line.includes(labelPrefix));
  if (start < 0) return null;

  const answers: Record<number, string> = {};
  const texts: Record<number, string> = {};
  const duplicateNumbers: number[] = [];

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^(\d{1,2})\.\s*([A-O])\s+(.*)$/.exec(line);
    if (!match) {
      // 表结束后是站点页脚
      if (/^以上是/.test(line) || /^大学英语六级/.test(line) || CJK.test(line)) break;
      continue;
    }
    const number = Number(match[1]);
    if (number < 1 || number > 55) continue;
    if (number in answers) {
      // 同一题号出现两次 ⇒ 该表内部串行。如实记录，不做覆盖。
      if (!duplicateNumbers.includes(number)) duplicateNumbers.push(number);
      continue;
    }
    answers[number] = match[2];
    const rest = match[3].trim();
    if (rest !== "") texts[number] = rest;
  }

  return { label: labelPrefix, locator, answers, texts, duplicateNumbers: duplicateNumbers.sort((a, b) => a - b) };
}

/** 报表自身的内部串行（同一题号出现多次）。 */
export function detectTableInternalDefects(table: SecondaryAnswerTable): string[] {
  return table.duplicateNumbers.length === 0
    ? []
    : [`答案表内部同一题号出现多次（串行）：${table.duplicateNumbers.join(",")}`];
}

function compactForCompare(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * 比对包内答案与第二来源。
 *
 * `scope` 限定参与比对的题号范围 —— 因为第三方页面常常只覆盖听力（1–25）
 * 或只覆盖阅读。把未覆盖的题号算成"不一致"会是假阳性。
 */
export function verifyAnswers(
  paper: ExamPaperContent,
  table: SecondaryAnswerTable,
  scope: { from: number; to: number },
): AnswerVerification {
  const packaged = new Map<number, { answer: string; optionText: string | null }>();
  for (const section of paper.sections) {
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.number === null) continue;
        if (question.kind === "mcq") {
          const option = question.options.find((entry) => entry.id === question.answer);
          packaged.set(question.number, { answer: question.answer, optionText: option ? option.label : null });
        } else if (question.kind === "banked_cloze_blank") {
          const index = (group.wordBank ?? []).indexOf(question.answer);
          packaged.set(question.number, {
            answer: index >= 0 ? "ABCDEFGHIJKLMNO"[index] : "?",
            optionText: question.answer,
          });
        } else if (question.kind === "matching_statement") {
          packaged.set(question.number, { answer: question.answerParagraph, optionText: null });
        }
      }
    }
  }

  const scopedSecondary = Object.entries(table.answers)
    .filter(([key]) => !key.includes("#dup"))
    .map(([key, answer]) => ({ number: Number(key), answer }))
    .filter((entry) => entry.number >= scope.from && entry.number <= scope.to);

  const conflicts: AnswerVerification["conflicts"] = [];
  let agreeing = 0;
  let textAgreeing = 0;
  const primaryOnly: number[] = [];

  for (let n = scope.from; n <= scope.to; n += 1) {
    const ours = packaged.get(n);
    const theirs = scopedSecondary.find((entry) => entry.number === n);
    if (!ours) {
      if (theirs) primaryOnly.push(n);
      continue;
    }
    if (!theirs) continue;
    if (ours.answer !== theirs.answer) {
      conflicts.push({
        number: n,
        primary: ours.answer,
        secondary: theirs.answer,
        secondaryText: table.texts[n] ?? null,
      });
      continue;
    }
    agreeing += 1;
    const secondaryText = table.texts[n];
    if (ours.optionText && secondaryText) {
      const a = compactForCompare(ours.optionText);
      const b = compactForCompare(secondaryText);
      if (a.length > 0 && b.length > 0 && (a.includes(b) || b.includes(a))) textAgreeing += 1;
    }
  }

  const comparing = agreeing + conflicts.length;
  const level: AgreementLevel =
    comparing === 0 ? "single_source" : conflicts.length > 0 ? "cross_source_conflict" : "cross_source_agree";

  const note =
    level === "single_source"
      ? `该范围内没有可用的第二来源，答案只有主源 KEYS 表一个出处（证据强度：单一来源）`
      : level === "cross_source_agree"
        ? `与第二来源逐题比对：${comparing} 题全部一致` +
          (textAgreeing > 0 ? `，其中 ${textAgreeing} 题的选项文本亦吻合` : "") +
          `。注意：一致提升的是可信度而非权威性 —— 两个站点可能抄同一份表，且这些答案都不是官方发布的。`
        : `与第二来源存在 ${conflicts.length} 处分歧（${comparing} 题参与比对）—— 必须人工裁定，不得自动调和`;

  return {
    level,
    primaryCount: packaged.size,
    secondaryCount: scopedSecondary.length,
    comparing,
    agreeing,
    conflicts,
    primaryOnly,
    secondaryOnly: scopedSecondary
      .filter((entry) => !packaged.has(entry.number))
      .map((entry) => entry.number),
    textAgreeing,
    note,
  };
}

/** 把答案分歧转成阻断项。**不提供"哪个对"的结论。** */
export function answerConflictsToReview(verification: AnswerVerification, locator: string): ReviewItem[] {
  return verification.conflicts.map((conflict) => ({
    code: "answer_not_in_options" as const,
    severity: "blocking" as const,
    where: `<answers>/q${conflict.number}`,
    detail:
      `第 ${conflict.number} 题的答案存在来源分歧：主源 KEYS 表给出 ${conflict.primary}，` +
      `第二来源（${locator}）给出 ${conflict.secondary}。工具不判断哪个正确 —— 需外部证据裁定。`,
    evidence: conflict.secondaryText ? `第二来源的选项文本：${conflict.secondaryText}` : null,
  }));
}

// ---------------------------------------------------------------------------
// 逐题证据矩阵
// ---------------------------------------------------------------------------

/** 一个来源对某题的取值记录。 */
export interface AnswerEvidenceRow {
  /** 来源标识（**永远不称任何来源为"官方"**）。 */
  source: string;
  locator: string;
  /** 该来源的取值；未覆盖为 null。 */
  value: string | null;
  /** 该来源的选项文本（若有）。 */
  text: string | null;
}

/** 某一题的全部来源证据。 */
export interface AnswerEvidenceEntry {
  number: number;
  /** 各来源的取值。 */
  rows: AnswerEvidenceRow[];
  /** 参与的取值种类数。1 = 所有来源一致；>1 = 存在分歧。 */
  distinctValues: number;
  /** 一致 / 分歧。 */
  outcome: "agree" | "disagree" | "single_source";
}

/**
 * 构造逐题答案证据矩阵。
 *
 * ── 为什么需要它（而不是一个"整体一致"的结论）──
 *
 * 把整卷听力答案概括成 `cross_source_agree` 会**掩盖个别题的分歧**：
 * 实测 25 题里 24 题一致、1 题分歧，而那一题恰恰是最需要人看见的。
 * 因此对**指定题号**输出逐来源的取值，让复核者能直接看到：
 * 这一题，每个来源说了什么，是否一致。
 *
 * **任何来源都不被称为"官方"** —— 本项目已确认不存在官方答案来源。
 */
export function buildAnswerEvidenceMatrix(
  paper: ExamPaperContent,
  primaryKeys: Record<number, string>,
  tables: { label: string; locator: string; answers: Record<number, string>; texts: Record<number, string> }[],
  focusNumbers: number[],
): AnswerEvidenceEntry[] {
  // 包内取值（选词填空与匹配题要换算成标签，才能与 KEYS 表比）
  const packaged = new Map<number, { value: string; text: string | null }>();
  for (const section of paper.sections) {
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.number === null) continue;
        if (question.kind === "mcq") {
          const option = question.options.find((entry) => entry.id === question.answer);
          packaged.set(question.number, { value: question.answer, text: option ? option.label : null });
        } else if (question.kind === "banked_cloze_blank") {
          const index = (group.wordBank ?? []).indexOf(question.answer);
          packaged.set(question.number, {
            value: index >= 0 ? "ABCDEFGHIJKLMNO"[index] : "?",
            text: question.answer,
          });
        } else if (question.kind === "matching_statement") {
          packaged.set(question.number, { value: question.answerParagraph, text: null });
        }
      }
    }
  }

  return focusNumbers.map((number) => {
    const rows: AnswerEvidenceRow[] = [];

    // 主源 KEYS 表（第三方存档中的答案表 —— 如实标注，不称官方）
    const primary = primaryKeys[number] ?? null;
    const packagedValue = packaged.get(number);
    rows.push({
      source: "主源存档 PDF 的 KEYS 表（第三方存档，非官方发布）",
      locator: "primary_paper_pdf",
      value: primary,
      text: packagedValue?.text ?? null,
    });

    // 包内最终取值（可能经人工裁定）
    rows.push({
      source: "包内最终取值（可能经人工裁决修正）",
      locator: "paper.json",
      value: packagedValue?.value ?? null,
      text: packagedValue?.text ?? null,
    });

    // 各第二来源
    for (const table of tables) {
      const value = table.answers[number] ?? null;
      rows.push({
        source: table.label,
        locator: table.locator,
        value,
        text: value !== null ? (table.texts[number] ?? null) : null,
      });
    }

    const observed = rows.map((row) => row.value).filter((value): value is string => value !== null);
    const distinctValues = new Set(observed).size;
    const outcome: AnswerEvidenceEntry["outcome"] =
      observed.length <= 1 ? "single_source" : distinctValues > 1 ? "disagree" : "agree";

    return { number, rows, distinctValues, outcome };
  });
}

/**
 * 把逐题矩阵转成**如实**的强度结论。
 *
 * 当存在分歧时**不得**概括为 `cross_source_agree`。
 */
export function matrixStrength(matrix: AnswerEvidenceEntry[]): "single_source" | "cross_source_agree" | "mostly_agree_with_disagreements" | "cross_source_conflict" {
  const withEvidence = matrix.filter((entry) => entry.rows.some((row) => row.value !== null));
  if (withEvidence.length === 0) return "single_source";

  const agreeCount = matrix.filter((entry) => entry.outcome === "agree").length;
  const disagree = matrix.filter((entry) => entry.outcome === "disagree").length;
  const hasMultipleSources = matrix.some((entry) => entry.rows.filter((row) => row.value !== null).length > 1);

  if (!hasMultipleSources) return "single_source";
  if (disagree === 0) return "cross_source_agree";
  // 有分歧但也有一致：用能表达"多数一致但存在分歧"的档位，
  // 而不是笼统写 cross_source_agree（那会掩盖分歧）
  return agreeCount > 0 ? "mostly_agree_with_disagreements" : "cross_source_conflict";
}

/** 矩阵的人可读行（供审计与复核输出）。 */
export function renderEvidenceMatrix(matrix: AnswerEvidenceEntry[]): string[] {
  const lines: string[] = [];
  for (const entry of matrix) {
    const label =
      entry.outcome === "agree" ? "各来源一致" : entry.outcome === "disagree" ? "**存在分歧**" : "单一来源";
    lines.push(`第 ${entry.number} 题（${label}，${entry.distinctValues} 种取值）`);
    for (const row of entry.rows) {
      if (row.value === null) continue;
      const text = row.text ? ` — ${row.text.slice(0, 80)}` : "";
      lines.push(`      ${row.value}${text}`);
      lines.push(`        ← ${row.source}`);
    }
  }
  return lines;
}
