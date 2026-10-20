/**
 * Stage 5b — 源完整性与结构覆盖（SOURCE_COMPLETENESS + STRUCTURAL_INTEGRITY）。
 *
 * ── 与源保真（SOURCE_FIDELITY）的分工 ──
 *
 * 这是本次修复引入的**独立概念**，不是对源保真的加强。
 *
 * | 概念 | 回答的问题 | 单向/双向 |
 * | --- | --- | --- |
 * | SOURCE_FIDELITY | 包内这段文字，其**用词**是否忠于主源？ | 单向：候选 → 源 |
 * | SOURCE_COMPLETENESS | 主源里有的内容，包内**是否都在**？ | 反向：源 → 候选 |
 *
 * 只有前者时，一类缺陷完全不被发现：**候选字段被截断、被漏掉、
 * 被重复、被接到错的组上**。实测已确认这类缺陷真实存在
 * （第三方题干来自另一份试卷；某题选项在源件里被截断）。
 *
 * 一个早期的实现错误也记录在此以免重犯：曾把"字段为空"判为
 * `UNVERIFIABLE` 就放行 —— 空字段**不是**"无法比对"，
 * 而是"这个必需内容完全缺失"，必须阻断。
 *
 * ── 主源区间对齐（source-span alignment）──
 *
 * 校验不再是"这段文字在源文件某处出现过"，而是：
 *
 *   候选字段 ↔ **显式的主源区间**（页 + 行范围）
 *
 * 抽取产物保留了顺序与几何，因此可以给每个字段分配它的源区间，
 * 再在该区间内比对。这样才能区分：
 * - "这段文字在源件别处出现"（原判据会误判为通过）
 * - "这段文字就应该在这里"（真正确认了位置与完整性）
 */

import type { ExamPaperContent } from "@/content/paper/types";
import type { ExtractedDocument, ExtractedLine, ReviewItem } from "./types";
import { OFFICIAL_NUMBERED_ITEM_TOTAL, SECTION_QUESTION_COUNTS } from "@/domain/paper";
import { compact, splitSentences } from "./fidelity";
import { stableStringify } from "./fingerprint";

// ---------------------------------------------------------------------------
// 机器结果类型（四类可区分）
// ---------------------------------------------------------------------------

/**
 * 机器判定的四个**独立**结论。刻意不合并成一个布尔值 ——
 * 它们在失败原因与处置方式上完全不同。
 */
export type MachineVerdict = "PASS" | "FAIL" | "REVIEW_REQUIRED" | "NOT_APPLICABLE";

export interface MachineResult {
  verdict: MachineVerdict;
  /** 参与判定的单元数。 */
  checked: number;
  issues: ReviewItem[];
  /** 人可读摘要。 */
  summary: string;
}

/** 一个候选字段与其**显式的主源区间**的对应。 */
export interface FieldAlignment {
  /** 候选字段路径。 */
  field: string;
  /** 候选文本。 */
  text: string;
  /** 主源区间：页号 + 行索引范围（含端点）。 */
  span: { page: number; startLine: number; endLine: number };
  /** 该区间的源文本（由对齐阶段填充）。 */
  sourceText?: string;
  /** 字段类型，用于按类型施加不同的完整性要求。 */
  kind: "passage" | "paragraph" | "wordBank" | "option" | "statement" | "prompt" | "translation" | "title";
}

// ---------------------------------------------------------------------------
// 主源区间对齐
// ---------------------------------------------------------------------------

/**
 * 在主源行序列里定位一段文本所在的**连续区间**。
 *
 * ── 为什么必须做跨行匹配 ──
 *
 * 第一版实现按"句子必须完整落在某一行内"匹配，实测产生大量假阳性：
 * - 写作起始句被印在两行（`…right and wrong. So why don't more employees intervene` 之类）；
 * - 全部长文（选词填空文章、长篇阅读 A–O 段、仔细阅读两篇）的句子都跨行；
 * - 短选项（`A blur.`）因长度过滤而被判"无句子可匹配"。
 *
 * 现行算法：把每页的全部行**拼接**成一条紧凑串，并保留"字符偏移 → 行号"的映射，
 * 然后按句子在该串里查找，由字符区间反推行区间。
 *
 * 短文本（不足句子长）退化为整串匹配 —— 否则它们会被误判为"无法定位"。
 */
export function locateSpan(lines: ExtractedLine[], text: string): { startLine: number; endLine: number } | null {
  if (lines.length === 0) return null;

  // 逐字符建立「紧凑串偏移 → 行号」的映射。
  // 紧凑化会改变长度（删标点与空白），因此映射必须在紧凑化过程中同步构建。
  //
  // 刻意**不**插入页分隔符：正文本来就会跨页（实测中文翻译段落正好跨页），
  // 插入任何标记都会让跨页的字段无法定位。跨页造成的"两段不同内容被拼在
  // 一起"的解引用风险由"同一段文本被用于多个字段"的重复检查覆盖。
  const charLine: number[] = [];
  let haystack = "";

  for (let index = 0; index < lines.length; index += 1) {
    for (const char of compact(lines[index].text)) {
      haystack += char;
      charLine.push(index);
    }
  }

  if (haystack.length === 0) return null;

  /** 找一段紧凑文本，返回其行区间。 */
  const findRange = (needle: string): { startLine: number; endLine: number } | null => {
    if (needle.length === 0) return null;
    const at = haystack.indexOf(needle);
    if (at < 0) return null;
    const end = at + needle.length - 1;
    const startLine = charLine[at];
    const endLine = charLine[end];
    if (startLine === undefined || endLine === undefined || startLine < 0 || endLine < 0) return null;
    return { startLine, endLine };
  };

  // 优先按整段匹配（最快，且对短文本唯一可行）
  const wholeCompacted = compact(text);
  const whole = findRange(wholeCompacted);
  if (whole) return whole;

  // 整段找不到时，按句子逐句定位，取首尾
  const sentences = splitSentences(text)
    .map(compact)
    .filter((sentence) => sentence.length >= 12);
  if (sentences.length === 0) return null;

  const hits: { startLine: number; endLine: number }[] = [];
  for (const sentence of sentences) {
    const range = findRange(sentence);
    if (range) hits.push(range);
  }

  // 命中句数必须过半：不足说明该字段与源件不符，返回 null 让上层判缺陷
  if (hits.length === 0 || hits.length < Math.ceil(sentences.length * 0.5)) return null;

  return {
    startLine: Math.min(...hits.map((hit) => hit.startLine)),
    endLine: Math.max(...hits.map((hit) => hit.endLine)),
  };
}

// ---------------------------------------------------------------------------
// 结构完整性（STRUCTURAL_INTEGRITY）
// ---------------------------------------------------------------------------

/**
 * 官方结构要求。**不依赖"8 个大题"这一条** ——
 * 实测存在只检出 7 个大题的试卷，若只查大题数会漏掉真正的问题。
 * 这里逐项检查官方考试结构的**每一类内容**。
 */
export interface StructuralRequirement {
  id: string;
  /** 人可读描述。 */
  description: string;
  /** 在包内求值该要求。 */
  check: (paper: ExamPaperContent) => { ok: boolean; detail: string };
}

/** 收集某大题类型下的全部题目。 */
function questionsOf(paper: ExamPaperContent, type: string) {
  return paper.sections
    .filter((section) => section.type === type)
    .flatMap((section) => section.groups.flatMap((group) => group.questions));
}

/**
 * 校验一段题目编号在 `[from, to]` 区间内**既齐全又不重复**。
 *
 * 为什么单独抽出：早先每处检查都只写 `for (n = from..to) if (!numbers.includes(n))`
 * —— 那只检查"有没有缺"，**不检查"有没有多"**。
 * 于是"缺 6 但多了一个 5"（重复）会被判通过。
 * 这个缺口由对抗测试发现，且存在于全部四处编号检查中，因此统一修正。
 */
function checkNumberRange(
  numbers: number[],
  from: number,
  to: number,
  label: string,
): { ok: true } | { ok: false; detail: string } {
  const sorted = [...numbers].sort((a, b) => a - b);
  const duplicates = sorted.filter((number, index) => index > 0 && sorted[index - 1] === number);
  if (duplicates.length > 0) {
    return { ok: false, detail: `${label}题号重复：${[...new Set(duplicates)].join(",")}` };
  }
  const missing: number[] = [];
  for (let n = from; n <= to; n += 1) if (!sorted.includes(n)) missing.push(n);
  if (missing.length > 0) {
    return { ok: false, detail: `${label}缺少题号：${missing.join(",")}` };
  }
  return { ok: true };
}

function groupsOf(paper: ExamPaperContent, type: string) {
  return paper.sections.filter((section) => section.type === type).flatMap((section) => section.groups);
}

export const STRUCTURAL_REQUIREMENTS: StructuralRequirement[] = [
  {
    id: "writing_present_and_complete",
    description: "写作任务存在，且题目与要求符均在",
    check: (paper) => {
      const questions = questionsOf(paper, "writing");
      if (questions.length !== 1) return { ok: false, detail: `写作题数应为 1，实际 ${questions.length}` };
      const question = questions[0];
      if (question.kind !== "writing") return { ok: false, detail: "写作大题的题目类型不是 writing" };
      if (question.prompt.trim() === "") return { ok: false, detail: "写作题目（起始句）为空" };
      if ((question.instructions ?? "").trim() === "") return { ok: false, detail: "写作要求（instructions）为空" };
      return { ok: true, detail: "写作题目与要求齐备" };
    },
  },
  {
    id: "translation_present_and_complete",
    description: "翻译任务存在，且中文原文非空",
    check: (paper) => {
      const questions = questionsOf(paper, "translation");
      if (questions.length !== 1) return { ok: false, detail: `翻译题数应为 1，实际 ${questions.length}` };
      const question = questions[0];
      if (question.kind !== "translation") return { ok: false, detail: "翻译大题的题目类型不是 translation" };
      if (question.sourceText.trim() === "") return { ok: false, detail: "翻译原文为空" };
      return { ok: true, detail: "翻译原文齐备" };
    },
  },
  {
    id: "listening_numbering_and_options",
    description: "听力 Q1–25 齐备、题号连续且**不重复**、每题 4 个选项",
    check: (paper) => {
      const numbers = questionsOf(paper, "listening.long_conversation")
        .concat(questionsOf(paper, "listening.passage"))
        .concat(questionsOf(paper, "listening.talk_report_lecture"))
        .map((question) => question.number)
        .filter((value): value is number => value !== null);

      const range = checkNumberRange(numbers, 1, 25, "听力");
      if (!range.ok) return { ok: false, detail: range.detail };

      const badOptions: string[] = [];
      for (const type of [
        "listening.long_conversation",
        "listening.passage",
        "listening.talk_report_lecture",
      ] as const) {
        for (const question of questionsOf(paper, type)) {
          if (question.kind !== "mcq") {
            badOptions.push(`q${question.number} 不是四选一`);
            continue;
          }
          if (question.options.length !== 4) {
            badOptions.push(`q${question.number} 有 ${question.options.length} 个选项`);
          }
          if (question.stem.trim() === "") badOptions.push(`q${question.number} 的口语题干为空`);
        }
      }
      if (badOptions.length > 0) return { ok: false, detail: badOptions.slice(0, 6).join("；") };
      return { ok: true, detail: "听力 25 题、题号无重复、每题 4 个选项、题干齐备" };
    },
  },
  {
    id: "banked_cloze_complete",
    description: "选词填空 Q26–35、10 个空、词库完整、空位标记齐备",
    check: (paper) => {
      const groups = groupsOf(paper, "reading.banked_cloze");
      if (groups.length !== 1) return { ok: false, detail: `选词填空组数应为 1，实际 ${groups.length}` };
      const group = groups[0];

      const range = checkNumberRange(
        group.questions.map((question) => question.number).filter((value): value is number => value !== null),
        26,
        35,
        "选词填空",
      );
      if (!range.ok) return { ok: false, detail: range.detail };

      const bank = group.wordBank ?? [];
      if (bank.length !== 15) return { ok: false, detail: `词库应为 15 项，实际 ${bank.length}` };

      const passage = group.passage ?? "";
      if (passage.trim() === "") return { ok: false, detail: "选词填空文章为空" };
      const blankNumbers = group.questions
        .map((question) => question.number)
        .filter((value): value is number => value !== null);
      const missingMarkers = blankNumbers.filter((number) => !passage.includes(`[${number}]`));
      if (missingMarkers.length > 0) {
        return { ok: false, detail: `文章缺少空位标记：${missingMarkers.map((n) => `[${n}]`).join("")}` };
      }

      const emptyAnswers = group.questions.filter(
        (question) => question.kind === "banked_cloze_blank" && question.answer.trim() === "",
      );
      if (emptyAnswers.length > 0) {
        return { ok: false, detail: `${emptyAnswers.length} 个空没有答案` };
      }
      return { ok: true, detail: "选词填空 10 空、15 词库、空位标记与答案齐备" };
    },
  },
  {
    id: "matching_complete",
    description: "长篇阅读 Q36–45、段落标号连续、10 条陈述",
    check: (paper) => {
      const groups = groupsOf(paper, "reading.matching");
      if (groups.length !== 1) return { ok: false, detail: `长篇阅读组数应为 1，实际 ${groups.length}` };
      const group = groups[0];

      const statements = group.questions.filter((question) => question.kind === "matching_statement");
      const range = checkNumberRange(
        statements.map((question) => question.number).filter((value): value is number => value !== null),
        36,
        45,
        "长篇阅读",
      );
      if (!range.ok) return { ok: false, detail: range.detail };

      const paragraphs = group.paragraphs ?? [];
      if (paragraphs.length === 0) return { ok: false, detail: "长篇阅读缺少带标号段落" };

      // 段落标号必须从 A 起连续（缺一个标号意味着材料不完整）
      const labels = paragraphs.map((paragraph) => paragraph.label);
      for (let index = 0; index < labels.length; index += 1) {
        const expected = "ABCDEFGHIJKLMNO"[index];
        if (labels[index] !== expected) {
          return { ok: false, detail: `段落标号不连续：第 ${index + 1} 个应为 ${expected}，实际 ${labels[index]}` };
        }
      }

      const emptyStatements = statements.filter((question) => question.statement.trim() === "");
      if (emptyStatements.length > 0) return { ok: false, detail: `${emptyStatements.length} 条陈述为空` };

      const badTargets = statements.filter((question) => (question.answerParagraph ?? "").trim() === "");
      if (badTargets.length > 0) return { ok: false, detail: `${badTargets.length} 条陈述缺少目标段落` };

      return { ok: true, detail: `长篇阅读 ${paragraphs.length} 段、10 条陈述齐备` };
    },
  },
  {
    id: "careful_reading_complete",
    description: "仔细阅读 Q46–55、两篇文章、10 题各 4 选项",
    check: (paper) => {
      const groups = groupsOf(paper, "reading.careful_reading");
      if (groups.length !== 2) return { ok: false, detail: `仔细阅读应有 2 篇文章，实际 ${groups.length}` };

      const problems: string[] = [];
      for (const group of groups) {
        if ((group.passage ?? "").trim() === "") problems.push(`组 ${group.id} 的文章为空`);
        for (const question of group.questions) {
          if (question.kind !== "mcq") {
            problems.push(`q${question.number} 不是四选一`);
            continue;
          }
          if (question.options.length !== 4) problems.push(`q${question.number} 有 ${question.options.length} 个选项`);
          if (question.stem.trim() === "") problems.push(`q${question.number} 的题干为空`);
        }
      }

      const range = checkNumberRange(
        groups
          .flatMap((group) => group.questions.map((question) => question.number))
          .filter((value): value is number => value !== null),
        46,
        55,
        "仔细阅读",
      );
      if (!range.ok) problems.push(range.detail);

      if (problems.length > 0) return { ok: false, detail: problems.slice(0, 6).join("；") };
      return { ok: true, detail: "仔细阅读两篇、10 题各 4 选项齐备" };
    },
  },
  {
    id: "official_section_counts",
    description: "各大题题量与官方一致（用现有官方常量）",
    check: (paper) => {
      const mismatches: string[] = [];
      for (const section of paper.sections) {
        const actual = section.groups.reduce((sum, group) => sum + group.questions.length, 0);
        const expected = SECTION_QUESTION_COUNTS[section.type];
        if (actual !== expected) mismatches.push(`${section.type}: ${actual}/${expected}`);
      }
      if (mismatches.length > 0) return { ok: false, detail: mismatches.join(", ") };
      return { ok: true, detail: "各大题题量与官方一致" };
    },
  },
  {
    id: "numbered_total",
    description: `编号题总数为 ${OFFICIAL_NUMBERED_ITEM_TOTAL}`,
    check: (paper) => {
      const total = paper.sections
        .flatMap((section) => section.groups.flatMap((group) => group.questions))
        .filter((question) => question.number !== null).length;
      if (total !== OFFICIAL_NUMBERED_ITEM_TOTAL) {
        return { ok: false, detail: `编号题应为 ${OFFICIAL_NUMBERED_ITEM_TOTAL}，实际 ${total}` };
      }
      return { ok: true, detail: `编号题 ${total} 个` };
    },
  },
];

/** 结构完整性判定（STRUCTURAL_INTEGRITY）。 */
export function evaluateStructuralIntegrity(paper: ExamPaperContent): MachineResult {
  const issues: ReviewItem[] = [];
  let failed = 0;

  for (const requirement of STRUCTURAL_REQUIREMENTS) {
    const outcome = requirement.check(paper);
    if (outcome.ok) continue;
    failed += 1;
    issues.push({
      code: "structural_requirement_unmet",
      severity: "blocking",
      where: `<structure>/${requirement.id}`,
      detail: `${requirement.description} —— ${outcome.detail}`,
      evidence: null,
    });
  }

  return {
    verdict: failed === 0 ? "PASS" : "FAIL",
    checked: STRUCTURAL_REQUIREMENTS.length,
    issues,
    summary:
      failed === 0
        ? `结构完整性：${STRUCTURAL_REQUIREMENTS.length} 项要求全部满足`
        : `结构完整性：${failed}/${STRUCTURAL_REQUIREMENTS.length} 项要求未满足`,
  };
}

// ---------------------------------------------------------------------------
// 源完整性（SOURCE_COMPLETENESS）
// ---------------------------------------------------------------------------

export interface CompletenessInput {
  paper: ExamPaperContent;
  doc: ExtractedDocument;
  /** 已对齐的字段清单（由 candidate 生成阶段产出）。 */
  alignments: FieldAlignment[];
}

/**
 * 源完整性判定。
 *
 * 检查四类反向缺陷：
 *
 * | 缺陷 | 判据 |
 * | --- | --- |
 * | **必需字段为空** | 空 ⇒ FAIL（**不是** UNVERIFIABLE） |
 * | **字段被截断** | 在主源区间内找不到该字段的全部句子 ⇒ FAIL |
 * | **字段重复** | 同一主源区间被两个不同候选字段占用 ⇒ FAIL |
 * | **字段接到错的组** | 主源区间落在另一组的区间内 ⇒ FAIL（由绑定层复核） |
 *
 * 另外检查主源侧：源件中出现但包内未被任何字段覆盖的**题号锚点**。
 */
export function evaluateSourceCompleteness(input: CompletenessInput): MachineResult {
  const { paper, doc, alignments } = input;
  const issues: ReviewItem[] = [];
  let checked = 0;

  // 1) 必需字段不得为空
  const requiredFields: { field: string; text: string; where: string }[] = [];
  for (const section of paper.sections) {
    for (const group of section.groups) {
      if (section.type === "reading.banked_cloze") {
        requiredFields.push({ field: `${section.id}/${group.id}.passage`, text: group.passage ?? "", where: group.id });
      }
      if (section.type === "reading.matching") {
        requiredFields.push({
          field: `${section.id}/${group.id}.instructions`,
          text: group.instructions ?? "",
          where: group.id,
        });
        for (const paragraph of group.paragraphs ?? []) {
          requiredFields.push({
            field: `${section.id}/${group.id}.paragraphs[${paragraph.label}]`,
            text: paragraph.text,
            where: group.id,
          });
        }
      }
      if (section.type === "reading.careful_reading") {
        requiredFields.push({ field: `${section.id}/${group.id}.passage`, text: group.passage ?? "", where: group.id });
      }
      for (const question of group.questions) {
        const base = `${section.id}/${group.id}/${question.id}`;
        if (question.kind === "mcq") {
          requiredFields.push({ field: `${base}.stem`, text: question.stem, where: group.id });
          for (const option of question.options) {
            requiredFields.push({ field: `${base}.options[${option.id}]`, text: option.label, where: group.id });
          }
        } else if (question.kind === "writing") {
          requiredFields.push({ field: `${base}.prompt`, text: question.prompt, where: group.id });
        } else if (question.kind === "translation") {
          requiredFields.push({ field: `${base}.sourceText`, text: question.sourceText, where: group.id });
        } else if (question.kind === "matching_statement") {
          requiredFields.push({ field: `${base}.statement`, text: question.statement, where: group.id });
        }
      }
    }
  }

  for (const field of requiredFields) {
    checked += 1;
    if (field.text.trim() === "") {
      issues.push({
        code: "required_field_empty",
        severity: "blocking",
        where: field.field,
        // 措辞刻意明确：空字段不是"无法比对"
        detail: "必需内容为空。空字段**不是**「无法比对」—— 它是内容完全缺失，必须阻断。",
        evidence: null,
      });
    }
  }

  // 2) 已对齐字段：主源区间内必须能找到全部句子（截断检测）
  for (const alignment of alignments) {
    checked += 1;
    if (alignment.text.trim() === "") continue;

    const span = doc.lines.slice(alignment.span.startLine, alignment.span.endLine + 1);
    const spanCompact = span.map((line) => compact(line.text)).join("");

    const sentences = splitSentences(alignment.text)
      .map(compact)
      .filter((sentence) => sentence.length >= 12);
    if (sentences.length === 0) continue;

    const unmatched = sentences.filter((sentence) => !spanCompact.includes(sentence));
    if (unmatched.length > 0) {
      issues.push({
        code: "field_truncated_or_misaligned",
        severity: "blocking",
        where: alignment.field,
        detail:
          `该字段在主源区间（第 ${alignment.span.page} 页 行 ${alignment.span.startLine}–${alignment.span.endLine}）` +
          `内找不到 ${unmatched.length}/${sentences.length} 个句子 —— 可能是被截断、被改写，或该区间不对应此字段`,
        evidence: unmatched.slice(0, 2).map((sentence) => sentence.slice(0, 160)).join(" ‖ "),
      });
    }
  }

  // 3) 同一候选字段不得**重复出现在源的同一位置**（重复检测）
  //
  // 判据是**同一段候选文本**被映射到同一个源区间：那意味着同一个字段
  // 在包内出现了两次，或两个不同字段引用了同一段源文本。
  //
  // ── 为什么不能按"区间相同"判缺陷 ──
  // 第一版实现把"两个字段共享同一区间"当作缺陷，实测产生大量假阳性：
  // Word 源件会把**两个选项印在同一行**（`A)…C)…`），也会把
  // 题号与小节标题放在同一行。那些字段共享行区间是**源件的正常排版**，
  // 不是缺陷。修正后的判据只查"同一段文本被用两次"。
  const textToFields = new Map<string, string[]>();
  for (const alignment of alignments) {
    const key = compact(alignment.text);
    if (key.length < 12) continue; // 极短文本（单词）本就会在多处出现，不构成重复
    if (!textToFields.has(key)) textToFields.set(key, []);
    textToFields.get(key)!.push(alignment.field);
  }
  for (const [key, fields] of textToFields) {
    if (fields.length <= 1) continue;
    issues.push({
      code: "source_span_shared_by_distinct_fields",
      severity: "blocking",
      where: `<completeness>/<duplicate>`,
      detail:
        `同一段候选内容被用在 ${fields.length} 个不同字段上：${fields.slice(0, 4).join(", ")}。` +
        `这通常是字段被重复填充或内容被误接到另一处。`,
      evidence: key.slice(0, 160),
    });
  }

  // 4) 主源侧的题组锚点必须都在包内被覆盖（源→候选方向）
  const sourceQuestionNumbers = new Set<number>();
  for (const line of doc.lines) {
    const match = /^(\d{1,2})\s*[.\uff0e]\s*\S/.exec(line.text.trim());
    if (!match) continue;
    const number = Number(match[1]);
    if (number >= 1 && number <= 55) sourceQuestionNumbers.add(number);
  }
  const packagedNumbers = new Set(
    paper.sections
      .flatMap((section) => section.groups.flatMap((group) => group.questions))
      .map((question) => question.number)
      .filter((value): value is number => value !== null),
  );
  const sourceOnly = [...sourceQuestionNumbers].filter((number) => !packagedNumbers.has(number)).sort((a, b) => a - b);
  // 源件里出现但包内没有的题号：可能是页内交叉引用（如 "Questions 19 to 21"），
  // 因此只有在**成规模**缺失时才判缺陷
  if (sourceOnly.length >= 3) {
    issues.push({
      code: "source_items_not_covered",
      severity: "blocking",
      where: "<completeness>/<source>",
      detail: `主源出现但包内未覆盖的题号 ${sourceOnly.length} 个：${sourceOnly.join(",")}`,
      evidence: null,
    });
  }

  const blocking = issues.filter((issue) => issue.severity === "blocking");
  return {
    verdict: blocking.length === 0 ? "PASS" : "FAIL",
    checked,
    issues,
    summary:
      blocking.length === 0
        ? `源完整性：${checked} 个单元全部覆盖（无空字段、无截断、无重复占用）`
        : `源完整性：${blocking.length} 处缺陷（空字段 / 截断 / 区间重复占用 / 源侧未覆盖）`,
  };
}

/** 对齐清单的指纹，用于记录"本次完整性判定基于哪份对齐"。 */
export function alignmentDigest(alignments: FieldAlignment[]): string {
  return stableStringify(
    alignments
      .map((alignment) => ({
        field: alignment.field,
        page: alignment.span.page,
        start: alignment.span.startLine,
        end: alignment.span.endLine,
      }))
      .sort((a, b) => a.field.localeCompare(b.field)),
  );
}
