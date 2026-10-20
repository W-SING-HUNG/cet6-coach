/**
 * 复核修正（reviewed corrections）。
 *
 * ── 为什么需要独立的修正文件 ──
 * 手工编辑 `paper.json` 来"修好"源件缺陷，会让改动**消失在没有痕迹的地方** ——
 * 那正是内容政策明令禁止的"静默语义修正"。
 *
 * 因此本流水线把复核者的决定做成**显式输入**：
 * 复核者在候选目录写 `corrections.json`，每条修正必须带
 * **理由 + 证据**；流水线应用它，并把每条修正登记进
 * `candidate.json.intentionalTransformations` 与规范化审计记录。
 *
 * ── 允许的修正类型（收窄，且每一种都要求证据非空）──
 *
 * | 类型 | 用途 | 实测案例 |
 * | --- | --- | --- |
 * | `relabel_option` | 源件把选项标签印错 | 2024-06 Q54/Q55 第三项印成 `O)`，独立来源印 `C)` |
 * | `uphold_primary_answer` | 来源间答案分歧，经裁定保留主源取值 | 2025-06 Q13：主源 KEYS=C，第三方表=B，独立解析支持 C |
 *
 * **刻意不做的事**：
 * - 不允许"改写文本"（`replace_text`）。那会让复核者一句话就能把源件内容换掉，
 *   而审计记录无法阻止误用。发现用词不符时，正确做法是核对源件本身。
 * - 不允许修正"缺失内容"。缺内容说明源件不完整，属于"必须换源"的情形，
 *   不是修正能解决的。
 * - **不允许在答案分歧时"改答案"**。`uphold_primary_answer` 只做一件事：
 *   记录"已用外部证据裁定保留主源值"。若证据确实支持第二来源的答案，
 *   那属于"主源错了"这一类更严重的发现，必须换源或人工处理，
 *   不能由本工具悄悄改写答案。
 */

import type { ExamPaperContent, PaperQuestion } from "@/content/paper/types";
import type { ReviewCode, ReviewItem } from "./types";

export interface RelabelOptionCorrection {
  type: "relabel_option";
  /** 定位：题目 id（例如 `q54`）。 */
  questionId: string;
  /** 源件印出的标签。用于校验"我修的是我以为的那一处"。 */
  from: string;
  /** 修正后的标签。 */
  to: string;
  /** 修正理由（人可读）。 */
  reason: string;
  /** **外部证据**。不得为空 —— 没有证据的修正等于猜。 */
  evidence: string;
  /** 该修正化解的复核项代码与位置，用于让门禁知道"这一项已被裁决"。 */
  resolves: { code: ReviewCode; where: string };
}

/**
 * 来源间答案分歧的裁定：**保留主源取值**。
 *
 * 这条修正**不改动任何内容** —— 它只把"已用外部证据裁定"这件事变成
 * 可审计的记录。它之所以是必需的：分歧不能靠"忽略"来解决，
 * 但也不允许工具改写答案。
 */
export interface UpholdPrimaryAnswerCorrection {
  type: "uphold_primary_answer";
  /** 题目 id（例如 `q13`）。 */
  questionId: string;
  /** 主源给出的答案（用于校验"我裁定的正是这一处"）。 */
  primary: string;
  /** 与该主源冲突的第二来源取值。 */
  secondary: string;
  reason: string;
  /** **裁定所依据的外部证据**。不得为空。 */
  evidence: string;
  resolves: { code: ReviewCode; where: string };
}

export type ReviewedCorrection = RelabelOptionCorrection | UpholdPrimaryAnswerCorrection;

export interface CorrectionsFile {
  paperId: string;
  /** 复核者标识。 */
  reviewer: string;
  reviewedAt: string;
  corrections: ReviewedCorrection[];
}

export interface AppliedCorrection {
  type: string;
  where: string;
  from: string;
  to: string;
  reason: string;
  evidence: string;
  reviewer: string;
  reviewedAt: string;
}

export interface ApplyCorrectionsResult {
  applied: AppliedCorrection[];
  /** 修正被拒绝的原因（每条都必须让人看见，不得静默丢弃）。 */
  rejected: string[];
  /** 被修正化解掉的复核项键：`code@where`。 */
  resolvedKeys: Set<string>;
}

/**
 * 校验修正文件本身的完整性。
 *
 * 任何一条修正缺少证据 → **整份修正文件作废**。
 * 理由是"部分应用"会让包处于既非源件、也非修正后状态的中间态。
 */
export function validateCorrectionsFile(raw: unknown): { ok: boolean; errors: string[]; file: CorrectionsFile | null } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["修正文件不是对象"], file: null };
  const candidate = raw as Partial<CorrectionsFile>;

  if (typeof candidate.paperId !== "string" || candidate.paperId.trim() === "") errors.push("paperId 缺失");
  if (typeof candidate.reviewer !== "string" || candidate.reviewer.trim() === "") errors.push("reviewer 缺失");
  if (typeof candidate.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.reviewedAt)) {
    errors.push("reviewedAt 必须是 YYYY-MM-DD");
  }
  if (!Array.isArray(candidate.corrections)) {
    errors.push("corrections 必须是数组");
    return { ok: false, errors, file: null };
  }

  candidate.corrections.forEach((correction, index) => {
    const base = `corrections[${index}]`;
    const type = (correction as { type?: unknown }).type;

    if (type !== "relabel_option" && type !== "uphold_primary_answer") {
      errors.push(
        `${base}.type：不支持的修正类型 ${String(type)}（只允许 relabel_option / uphold_primary_answer）`,
      );
      return;
    }

    // 用 Record<string, unknown> 而不是 `Partial<A & B>`：
    // 两个修正类型的 `type` 字面量互斥，取交集会让字段类型塌成 never。
    const entry = correction as unknown as Record<string, unknown>;
    if (typeof entry.questionId !== "string" || entry.questionId.trim() === "") {
      errors.push(`${base}.questionId 缺失`);
    }
    // 证据非空是本机制的**核心约束**：没有证据的修正等于猜
    if (typeof entry.evidence !== "string" || entry.evidence.trim().length < 10) {
      errors.push(`${base}.evidence：证据不得为空且需足够具体（≥10 字符）`);
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < 4) {
      errors.push(`${base}.reason：理由不得为空`);
    }
    const resolves = entry.resolves as Record<string, unknown> | null | undefined;
    if (
      typeof resolves !== "object" ||
      resolves === null ||
      typeof resolves.code !== "string" ||
      typeof resolves.where !== "string"
    ) {
      errors.push(`${base}.resolves：必须声明它化解了哪个复核项（code 与 where）`);
    }

    if (type === "relabel_option") {
      if (typeof entry.from !== "string" || entry.from.trim() === "") errors.push(`${base}.from 缺失`);
      if (typeof entry.to !== "string" || entry.to.trim() === "") errors.push(`${base}.to 缺失`);
    } else {
      if (typeof entry.primary !== "string" || entry.primary.trim() === "") errors.push(`${base}.primary 缺失`);
      if (typeof entry.secondary !== "string" || entry.secondary.trim() === "") errors.push(`${base}.secondary 缺失`);
    }
  });

  if (errors.length > 0) return { ok: false, errors, file: null };
  return { ok: true, errors: [], file: candidate as CorrectionsFile };
}

/**
 * 应用修正。
 *
 * 三条安全约束：
 * 1. 只修正**确实存在**且**当前标签等于 `from`** 的选项 —— 防止修正被应用到一个
 *    已被别的改动改变过的位置上。
 * 2. 同一题不得出现重复的目标标签（会产生两个 `C`）。
 * 3. 拒绝的修正**逐条报告**，不静默丢弃。
 */
export function applyCorrections(paper: ExamPaperContent, file: CorrectionsFile): ApplyCorrectionsResult {
  const applied: AppliedCorrection[] = [];
  const rejected: string[] = [];
  const resolvedKeys = new Set<string>();

  for (const correction of file.corrections) {
    if (correction.type === "uphold_primary_answer") {
      // 裁定类修正**不改动内容**：只校验"我裁定的正是那一处"，然后登记。
      const located = findMcq(paper, correction.questionId);
      if (!located) {
        rejected.push(`${correction.questionId}：找不到该四选一题目，裁定未登记`);
        continue;
      }
      if (located.question.answer !== correction.primary) {
        rejected.push(
          `${correction.questionId}：包内答案（${located.question.answer}）与本裁定声明的主源值（${correction.primary}）不一致，裁定未登记`,
        );
        continue;
      }
      applied.push({
        type: correction.type,
        where: `${located.section.id}/${located.group.id}/${located.question.id}.answer`,
        from: correction.secondary,
        to: correction.primary,
        reason: correction.reason,
        evidence: correction.evidence,
        reviewer: file.reviewer,
        reviewedAt: file.reviewedAt,
      });
      resolvedKeys.add(`${correction.resolves.code}@${correction.resolves.where}`);
      continue;
    }

    // relabel_option
    const located = findOption(paper, correction.questionId, correction.from);
    if (!located) {
      // 幂等性：同一个修正文件可能被应用多次（extract 之后 review 会再应用一次）。
      // 若目标标签**已经存在**且源标签已不存在，说明这条修正本就已生效 ——
      // 那是正常状态，不是错误。把它当成"已应用"登记，而不是拒绝。
      // 理由：把幂等状态报成失败，会逼出"每次 review 前先手工回滚"这种脆弱流程。
      const already = findOption(paper, correction.questionId, correction.to);
      if (already) {
        applied.push({
          type: correction.type,
          where: `${already.section.id}/${already.group.id}/${already.question.id}.options[${correction.to}]`,
          from: correction.from,
          to: correction.to,
          reason: correction.reason,
          evidence: correction.evidence,
          reviewer: file.reviewer,
          reviewedAt: file.reviewedAt,
        });
        resolvedKeys.add(`${correction.resolves.code}@${correction.resolves.where}`);
        continue;
      }
      rejected.push(
        `${correction.questionId}：找不到标签为 ${correction.from} 的选项，且目标标签 ${correction.to} 也不存在（题号或标签已变），修正未应用`,
      );
      continue;
    }
    if (correction.from === correction.to) {
      rejected.push(`${correction.questionId}：from 与 to 相同（${correction.from}），无需修正`);
      continue;
    }
    const conflict = located.question.options.find(
      (option) => option.id === correction.to && option.id !== correction.from,
    );
    if (conflict) {
      rejected.push(`${correction.questionId}：目标标签 ${correction.to} 已被另一个选项占用，修正会产生重复标签`);
      continue;
    }

    located.option.id = correction.to;
    applied.push({
      type: correction.type,
      where: `sections[${paper.sections.indexOf(located.section)}].groups[${located.section.groups.indexOf(
        located.group,
      )}].questions[${located.group.questions.indexOf(located.question)}].options[${correction.from}]`,
      from: correction.from,
      to: correction.to,
      reason: correction.reason,
      evidence: correction.evidence,
      reviewer: file.reviewer,
      reviewedAt: file.reviewedAt,
    });
    resolvedKeys.add(`${correction.resolves.code}@${correction.resolves.where}`);
  }

  return { applied, rejected, resolvedKeys };
}

function findMcq(
  paper: ExamPaperContent,
  questionId: string,
): {
  question: Extract<PaperQuestion, { kind: "mcq" }>;
  section: ExamPaperContent["sections"][number];
  group: ExamPaperContent["sections"][number]["groups"][number];
} | null {
  for (const section of paper.sections) {
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.kind !== "mcq" || question.id !== questionId) continue;
        return { question, section, group };
      }
    }
  }
  return null;
}

function findOption(
  paper: ExamPaperContent,
  questionId: string,
  printedLabel: string,
): {
  question: Extract<PaperQuestion, { kind: "mcq" }>;
  option: { id: string; label: string };
  section: ExamPaperContent["sections"][number];
  group: ExamPaperContent["sections"][number]["groups"][number];
} | null {
  for (const section of paper.sections) {
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.kind !== "mcq" || question.id !== questionId) continue;
        const option = question.options.find((entry) => entry.id === printedLabel);
        if (!option) continue;
        return { question, option, section, group };
      }
    }
  }
  return null;
}

/** 修正后重新核对答案引用：答案必须仍指向存在的选项。 */
export function answersStillValid(paper: ExamPaperContent): ReviewItem[] {
  const issues: ReviewItem[] = [];
  for (const section of paper.sections) {
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.kind !== "mcq") continue;
        if (!question.options.some((option) => option.id === question.answer)) {
          issues.push({
            code: "answer_not_in_options",
            severity: "blocking",
            where: `${section.id}/${group.id}/${question.id}.answer`,
            detail: `修正后答案 ${question.answer} 不再指向任何存在的选项`,
            evidence: question.options.map((option) => option.id).join("/"),
          });
        }
      }
    }
  }
  return issues;
}
