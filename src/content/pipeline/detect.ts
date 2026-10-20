/**
 * Stage 3 — 结构检测。
 *
 * 设计立场：**按语义锚点检测，不按页码或字符串位置检测。**
 * 任务明确禁止"page 3 always starts Section B"这类规则。本模块只依赖三类稳定锚点：
 *
 * 1. **大题标题**：`Part I Writing` / `Part II Listening Comprehension` /
 *    `Part III Reading Comprehension` / `Part IV Translation`。
 * 2. **小节标题**：`Section A|B|C` —— 必须**自我证明**是标题（其后紧跟
 *    Directions / 题组锚点 / Passage 标题 / 题号），因为长文里也会出现 "Section" 字样。
 * 3. **题组说明**：`Questions <a> to <b> are based on …`：同时给出题号区间与题组语义。
 *
 * 选项与词库的切分**按标签（`A)`/`B)`…）而不是按排版栏位**。
 * 理由见 `lines.ts` 顶部记录的实测结论：Word 用跨间隙的空白 run 做栏位对齐，
 * 几何间隙无法区分"标题内的对齐"与"并列栏位"；而选项标签本身就是内容的一部分。
 *
 * 一切**无法由源件确定**的事项都产生 `ReviewItem`，而不是被猜出来。
 */

import type {
  DetectedGroup,
  DetectedQuestion,
  DetectedSection,
  ExtractedDocument,
  ExtractedLine,
  ReviewItem,
  StructuralDetection,
} from "./types";
import { CJK, joinTextLines, norm } from "./text-utils";

// ---------------------------------------------------------------------------
// 锚点模式
// ---------------------------------------------------------------------------

const PART_HEADING = /^Part\s+(I{1,4}|IV)\b\s*(.*)$/;

type PartKind = "writing" | "listening" | "reading" | "translation";

const PART_KIND: { test: RegExp; kind: PartKind }[] = [
  { test: /\bWriting\b/i, kind: "writing" },
  { test: /\bListening\s+Comprehension\b/i, kind: "listening" },
  { test: /\bReading\s+Comprehension\b/i, kind: "reading" },
  { test: /\bTranslation\b/i, kind: "translation" },
];

const SECTION_HEADING = /^Section\s+([A-C])\b/;
const PASSAGE_HEADING = /^Passage\s+(One|Two|Three)\b/i;
const GROUP_ANCHOR = /^Questions?\s*,?\s*(\d+)\s*(?:to|-|\u2013|through)\s*(\d+)\s+are\s+based\s+on\b/i;
const QUESTION_NUMBERED = /^(\d{1,2})\s*[.\uff0e]\s*(.*)$/;
const DIRECTIONS_PREFIX = /^Directions\s*[:.]/i;

const OPTION_LETTERS = "ABCDEFGHIJKLMNO".split("");

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 段落拼接：页切换或行距显著大于常态时视为新段落。 */
function joinWithParagraphs(lines: ExtractedLine[]): string {
  const usable = lines.filter((line) => norm(line.text) !== "");
  if (usable.length === 0) return "";

  const gaps: number[] = [];
  for (let i = 1; i < usable.length; i += 1) {
    if (usable[i].page !== usable[i - 1].page) continue;
    const gap = usable[i - 1].y - usable[i].y;
    if (gap > 0) gaps.push(gap);
  }
  const sorted = [...gaps].sort((a, b) => a - b);
  const median = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 16;
  const threshold = median * 1.5;

  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (let i = 0; i < usable.length; i += 1) {
    if (i > 0) {
      const previous = usable[i - 1];
      const pageBreak = usable[i].page !== previous.page;
      const bigGap = !pageBreak && previous.y - usable[i].y > threshold;
      if (pageBreak || bigGap) {
        if (current.length > 0) paragraphs.push(current);
        current = [];
      }
    }
    current.push(usable[i].text);
  }
  if (current.length > 0) paragraphs.push(current);

  return paragraphs
    .map(joinTextLines)
    .filter((text) => text !== "")
    .join("\n\n");
}

interface LabelSegment {
  label: string;
  text: string;
}

/**
 * 把一行文本按选项/段落标签切成若干段。
 *
 * 例：`2. A)They are becoming impatient. C)They are used to making alterations.`
 *     → 前缀 `2. ` + 段 `A)…`、段 `C)…`
 *
 * `runStarts` 是**排版给出的可靠边界**：整行拼接会把栏位边界变成"无空格相邻"
 * （实测 `A) alpha` + `I) india` → `A) alphaI) india`）。
 * 因此标签可出现在行首、空白之后，**或某个 run 的起点** —— 三者都算合法边界。
 * 早先只认「行首或空白后」，导致 15 项词库只检出 1 项。
 */
function splitLabelSegments(text: string, runStarts: number[] = []): { prefix: string; segments: LabelSegment[] } {
  const boundary = new Set<number>([0, ...runStarts]);
  const isBoundary = (index: number): boolean =>
    boundary.has(index) || /\s/.test(text.slice(0, index).slice(-1)) || index === 0;

  const matches: { label: string; start: number; contentStart: number }[] = [];
  const labelPattern = /([A-O])[).]/g;
  let match: RegExpExecArray | null;
  while ((match = labelPattern.exec(text)) !== null) {
    if (!isBoundary(match.index)) continue;
    matches.push({
      label: match[1],
      start: match.index,
      contentStart: match.index + match[0].length,
    });
  }

  if (matches.length === 0) return { prefix: text, segments: [] };

  const prefix = text.slice(0, matches[0].start).trim();
  const segments: LabelSegment[] = matches.map((entry, i) => {
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    return { label: entry.label, text: text.slice(entry.contentStart, end).trim() };
  });

  return { prefix, segments };
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export interface DetectionInput {
  doc: ExtractedDocument;
  /** 参与官方编号的题目总数（官方 55）。 */
  expectedNumberedTotal: number;
}

export function detectStructure(input: DetectionInput): StructuralDetection {
  const { doc } = input;
  const review: ReviewItem[] = [];
  const sourceAnomalies: string[] = [];
  const margin = doc.geometry.margin;

  if (doc.pagesWithoutTextLayer.length > 0) {
    review.push({
      code: "extraction_page_without_text_layer",
      severity: "blocking",
      where: "<pdf>",
      detail: `第 ${doc.pagesWithoutTextLayer.join(", ")} 页没有文本层；本流水线不做 OCR`,
      evidence: null,
    });
  }

  const lines = doc.lines;
  const parts = findPartHeadings(lines, margin, review);

  if (parts.length === 0) {
    review.push({
      code: "section_anchor_missing",
      severity: "blocking",
      where: "<pdf>",
      detail: "未找到任何有效的大题标题锚点",
      evidence: null,
    });
    return emptyDetection(review, sourceAnomalies);
  }

  const keys = parseKeysTable(lines);
  const sections: DetectedSection[] = [];

  const boundaries = parts.map((entry, i) => ({
    ...entry,
    endExclusive: i + 1 < parts.length ? parts[i + 1].index : lines.length,
  }));

  for (const part of boundaries) {
    const scope = lines.slice(part.index, part.endExclusive);
    sections.push(...detectPart(part.kind, part.heading, scope, margin, review, sourceAnomalies));
  }

  validateNumbering(sections, keys, input.expectedNumberedTotal, review, sourceAnomalies);

  return {
    sections,
    review,
    keys,
    writing: extractWriting(sections),
    translation: extractTranslation(sections),
    sourceAnomalies,
  };
}

function emptyDetection(review: ReviewItem[], sourceAnomalies: string[]): StructuralDetection {
  return {
    sections: [],
    review,
    keys: {},
    writing: { prompt: null, instructions: null, minWords: null, maxWords: null },
    translation: { sourceText: null, instructions: null },
    sourceAnomalies,
  };
}

/**
 * 找大题标题并**验证其确为大题**。
 *
 * 源件末页（KEYS 区）也印 `Part II Listening Comprehension` 作为答案表分节标题。
 * 不验证的话它会变成第二个听力大题，产生空 section 并把真正大题的范围截断。
 */
function findPartHeadings(
  lines: ExtractedLine[],
  margin: number,
  review: ReviewItem[],
): { index: number; kind: PartKind; heading: string }[] {
  const result: { index: number; kind: PartKind; heading: string }[] = [];
  const rejected: string[] = [];

  lines.forEach((line, index) => {
    if (line.x > margin + 8) return;
    const heading = norm(line.text);
    if (!PART_HEADING.test(heading)) return;
    const kind = PART_KIND.find((entry) => entry.test.test(heading))?.kind;
    if (!kind) return;

    if (!looksLikeRealPart(lines, index)) {
      rejected.push(heading);
      return;
    }
    result.push({ index, kind, heading });
  });

  if (rejected.length > 0) {
    review.push({
      code: "section_anchor_conflict",
      severity: "advisory",
      where: "<pdf>",
      detail:
        `排除了 ${rejected.length} 个形似大题标题但不构成大题的锚点（其后无 Directions / Section / 题组锚点 / Passage）：` +
        rejected.join(" | "),
      evidence: "典型来源：源件末页 KEYS 答案表的分节标题",
    });
  }

  return result;
}

function looksLikeRealPart(lines: ExtractedLine[], startIndex: number): boolean {
  const window = lines.slice(startIndex + 1, startIndex + 90);
  for (const line of window) {
    const text = norm(line.text);
    if (text === "") continue;
    if (DIRECTIONS_PREFIX.test(text)) return true;
    if (SECTION_HEADING.test(text) && line.x < 60) return true;
    if (GROUP_ANCHOR.test(text)) return true;
    if (PASSAGE_HEADING.test(text)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 大题分发
// ---------------------------------------------------------------------------

function detectPart(
  kind: PartKind,
  heading: string,
  scope: ExtractedLine[],
  margin: number,
  review: ReviewItem[],
  sourceAnomalies: string[],
): DetectedSection[] {
  if (kind === "listening") return detectListeningPart(heading, scope, margin, review, sourceAnomalies);
  if (kind === "reading") return detectReadingPart(heading, scope, margin, review, sourceAnomalies);
  return [detectSubjectivePart(kind, heading, scope)];
}

/** 写作 / 翻译：单个大题、单个主观项、无题号。 */
function detectSubjectivePart(
  kind: "writing" | "translation",
  heading: string,
  scope: ExtractedLine[],
): DetectedSection {
  const instructions = collectDirections(scope);
  const bodyLines = kind === "translation" ? collectTranslationBody(scope) : [];
  const body = kind === "translation" ? joinTextLines(bodyLines) : null;

  const firstPage = scope[0]?.page ?? 0;
  const lastPage = scope[scope.length - 1]?.page ?? firstPage;

  return {
    type: kind,
    title: heading,
    anchor: heading,
    instructions,
    groups: [
      {
        id: `${kind}#g1`,
        order: 0,
        sectionType: kind,
        anchor: null,
        firstNumber: null,
        lastNumber: null,
        questions: [
          {
            number: null,
            kind,
            stem: null,
            options: [],
            blankId: null,
            statement: body,
            page: firstPage,
            y: 0,
            sourceLines: scope.map((line) => norm(line.text)).filter((text) => text !== ""),
          },
        ],
        passage: null,
        paragraphs: null,
        wordBank: null,
        instructions,
        pageRange: [firstPage, lastPage],
      },
    ],
  };
}

/**
 * 收集 Directions 段。
 *
 * 停止条件都是**结构锚点**：新小节、题组锚点、Passage 标题、大题标题、
 * 题号、或——对翻译——中文字符的出现（实测源件把 Directions 续行
 * `your answer on Answer Sheet 2.` 与中文段落连排）。
 */
function collectDirections(scope: ExtractedLine[]): string | null {
  const parts: string[] = [];
  let started = false;

  for (const line of scope) {
    const text = norm(line.text);
    if (text === "") continue;

    if (!started) {
      if (DIRECTIONS_PREFIX.test(text)) {
        started = true;
        parts.push(text);
      }
      continue;
    }

    if (
      SECTION_HEADING.test(text) ||
      GROUP_ANCHOR.test(text) ||
      PASSAGE_HEADING.test(text) ||
      PART_HEADING.test(text) ||
      QUESTION_NUMBERED.test(text)
    ) {
      break;
    }
    if (CJK.test(text)) break;
    parts.push(text);
  }

  return parts.length > 0 ? parts.join(" ") : null;
}

/** 翻译正文：Directions 之后含中文的行。 */
function collectTranslationBody(scope: ExtractedLine[]): string[] {
  const body: string[] = [];
  let started = false;
  for (const line of scope) {
    const text = norm(line.text);
    if (text === "") continue;
    // 注意：scope 的**首行就是 `Part IV Translation` 标题本身**。
    // 早先在 started 之前就判断 PART_HEADING 并 break，导致正文恒为空。
    if (started && PART_HEADING.test(text)) break;
    if (!started) {
      if (CJK.test(text) && !DIRECTIONS_PREFIX.test(text)) {
        started = true;
        body.push(line.text);
      }
      continue;
    }
    body.push(line.text);
  }
  return body;
}

// ---------------------------------------------------------------------------
// 听力
// ---------------------------------------------------------------------------

const LISTENING_TYPE_BY_LETTER: Record<
  string,
  "listening.long_conversation" | "listening.passage" | "listening.talk_report_lecture"
> = {
  A: "listening.long_conversation",
  B: "listening.passage",
  C: "listening.talk_report_lecture",
};

function detectListeningPart(
  heading: string,
  scope: ExtractedLine[],
  margin: number,
  review: ReviewItem[],
  sourceAnomalies: string[],
): DetectedSection[] {
  const subsections = findSubsections(scope, margin, review, "listening", heading);

  return subsections.flatMap((sub) => {
    const type = LISTENING_TYPE_BY_LETTER[sub.letter];
    if (!type) {
      review.push({
        code: "section_anchor_conflict",
        severity: "blocking",
        where: `listening/Section ${sub.letter}`,
        detail: `听力出现未知小节字母：${sub.letter}`,
        evidence: null,
      });
      return [];
    }
    const inner = scope.slice(sub.index, sub.endExclusive);
    const groups = detectAnchoredGroups(type, inner, review, sourceAnomalies);
    return [
      {
        type,
        title: `Part II Listening Comprehension · Section ${sub.letter}`,
        anchor: sub.heading,
        instructions: collectDirections(inner),
        groups: groups.map((group, groupIndex) => ({ ...group, order: groupIndex })),
      },
    ];
  });
}

/**
 * 找小节标题。**必须自我证明**：其后若干行内出现 Directions / 题组锚点 /
 * Passage 标题 / 题号。仅凭"文本是 Section A"不足以判定 ——
 * 长文里也会出现 `Section` 字样。
 */
function findSubsections(
  scope: ExtractedLine[],
  margin: number,
  review: ReviewItem[],
  where: string,
  heading: string,
): { index: number; letter: string; heading: string; endExclusive: number }[] {
  const found: { index: number; letter: string; heading: string }[] = [];

  scope.forEach((line, index) => {
    if (line.x > margin + 8) return;
    const text = norm(line.text);
    const match = SECTION_HEADING.exec(text);
    if (!match) return;

    const window = scope.slice(index + 1, index + 8).map((entry) => norm(entry.text));
    const proven = window.some(
      (candidate) =>
        DIRECTIONS_PREFIX.test(candidate) ||
        GROUP_ANCHOR.test(candidate) ||
        PASSAGE_HEADING.test(candidate) ||
        QUESTION_NUMBERED.test(candidate),
    );
    if (!proven) return;
    found.push({ index, letter: match[1], heading: text });
  });

  if (found.length === 0) {
    review.push({
      code: "section_anchor_missing",
      severity: "blocking",
      where,
      detail: "未找到任何可证明的小节标题（Section A/B/C）",
      evidence: heading,
    });
    return [];
  }

  return found.map((entry, i) => ({
    ...entry,
    endExclusive: i + 1 < found.length ? found[i + 1].index : scope.length,
  }));
}

/** 按题组锚点切题组，并切出四选一题目。 */
function detectAnchoredGroups(
  type: DetectedGroup["sectionType"],
  scope: ExtractedLine[],
  review: ReviewItem[],
  sourceAnomalies: string[],
): DetectedGroup[] {
  const anchors: { index: number; from: number; to: number; text: string }[] = [];
  scope.forEach((line, index) => {
    const match = GROUP_ANCHOR.exec(norm(line.text));
    if (!match) return;
    anchors.push({ index, from: Number(match[1]), to: Number(match[2]), text: norm(line.text) });
  });

  if (anchors.length === 0) {
    review.push({
      code: "question_group_anchor_missing",
      severity: "blocking",
      where: type,
      detail: "未找到 `Questions a to b are based on …` 题组锚点",
      evidence: scope.slice(0, 3).map((line) => norm(line.text)).join(" | "),
    });
    return [];
  }

  return anchors.map((anchor, i) => {
    const endExclusive = i + 1 < anchors.length ? anchors[i + 1].index : scope.length;
    const body = scope.slice(anchor.index, endExclusive);
    const questions = detectMcqQuestions(body, review, sourceAnomalies);
    const firstPage = body[0]?.page ?? 0;
    const lastPage = body[body.length - 1]?.page ?? firstPage;
    return {
      id: `${type}#g${i + 1}`,
      order: i,
      sectionType: type,
      anchor: anchor.text,
      firstNumber: anchor.from,
      lastNumber: anchor.to,
      questions,
      passage: null,
      paragraphs: null,
      wordBank: null,
      instructions: null,
      pageRange: [firstPage, lastPage] as [number, number],
    };
  });
}

/**
 * 从题组体切出四选一题目。
 *
 * 逐行处理：行首题号开启新题；同一行内按标签切出的**全部**段都归入该题
 * （双栏排布 `A)…C)…` 因此不会丢选项）；无标签且已有当前题时，
 * 文本追加到最后一个选项并记一条 advisory 提醒。
 */
function detectMcqQuestions(
  body: ExtractedLine[],
  review: ReviewItem[],
  sourceAnomalies: string[],
): DetectedQuestion[] {
  const questions: DetectedQuestion[] = [];
  let current: DetectedQuestion | null = null;
  const appendedLines: { question: number; text: string }[] = [];

  for (const line of body) {
    // 在**原始行文本**上切分：runStarts 与原始文本同坐标系。
    // 先 norm 再切会让偏移失配，从而漏掉栏位边界处的标签。
    const raw = line.text;
    if (norm(raw) === "") continue;

    const numberMatch = QUESTION_NUMBERED.exec(norm(raw));
    let rawRemainder = raw;
    let beganQuestion = false;
    if (numberMatch) {
      const number = Number(numberMatch[1]);
      // 题组体之外的编号（例如页脚）不开启新题
      if (number >= 1 && number <= 55) {
        if (current) questions.push(current);
        current = {
          number,
          kind: "mcq",
          stem: null,
          options: [],
          blankId: null,
          statement: null,
          page: line.page,
          y: line.y,
          sourceLines: [norm(raw)],
        };
        beganQuestion = true;
        // 去掉行首的「N. 」部分：找出第一个非空白、非数字、非点的位置
        const cut = /^\s*\d{1,2}\s*[.\uff0e]\s*/.exec(raw);
        rawRemainder = cut ? raw.slice(cut[0].length) : raw;
      }
    }

    if (!current) continue;

    // 切分偏移：若去掉了题号前缀，runStarts 需要相应左移
    const shiftedStarts = beganQuestion
      ? line.runStarts.map((start) => start - (line.text.length - rawRemainder.length)).filter((start) => start >= 0)
      : line.runStarts;

    const { prefix, segments } = splitLabelSegments(rawRemainder, shiftedStarts);
    if (segments.length > 0) {
      const normalizedPrefix = norm(prefix);
      if (beganQuestion && normalizedPrefix !== "" && current.stem === null && current.options.length === 0) {
        current.stem = normalizedPrefix;
      } else if (normalizedPrefix !== "" && current.options.length > 0) {
        // 标签前的文字属于上一个选项的续文
        const last = current.options[current.options.length - 1];
        last.text = `${last.text} ${normalizedPrefix}`.replace(/\s+/g, " ").trim();
      }
      for (const segment of segments) {
        current.options.push({
          printedLabel: segment.label,
          label: segment.label,
          text: norm(segment.text),
          page: line.page,
          y: line.y,
          x: line.x,
        });
      }
      continue;
    }
    const text = norm(raw);

    // 无标签行
    if (current.options.length === 0) {
      // 题干的续行（仔细阅读题干可能跨行）。
      //
      // **用 rawRemainder 而不是 raw**：开启新题时 raw 已被切掉行首题号，
      // 但 rawRemainder 才是切过的版本。早先用 raw 会让 `46. ` 这个前缀
      // 随题干一起进入 `stem` 与 `sourceLines` —— 实测导致 10 道仔细阅读
      // 题干印成 `46.What is…`，并污染面向学习者的内容。
      const text = norm(beganQuestion ? rawRemainder : raw);
      current.stem = current.stem === null ? text : `${current.stem} ${text}`.replace(/\s+/g, " ").trim();
      current.sourceLines.push(text);
    } else {
      const last = current.options[current.options.length - 1];
      last.text = `${last.text} ${text}`.replace(/\s+/g, " ").trim();
      if (current.number !== null) appendedLines.push({ question: current.number, text });
    }
  }

  if (current) questions.push(current);

  for (const entry of appendedLines) {
    review.push({
      code: "option_text_continuation",
      severity: "advisory",
      where: `q${entry.question}.options`,
      detail: `第 ${entry.question} 题有无标签续行被追加到上一选项，需人工确认是否确为同一选项的换行`,
      evidence: entry.text,
    });
  }

  auditOptions(questions, review, sourceAnomalies);
  return questions;
}

/**
 * 选项完整性审计。
 *
 * **判据是标签的集合，不是阅读顺序。** 源件用双栏排版，
 * 同一道题的选项按「左栏 A、右栏 C、左栏 B、右栏 D」的顺序出现
 * （实测 2024-06 Q2/Q3/Q4 等：`A)…C)…` 一行、`B)…D)…` 下一行）。
 * 那是**排版顺序**，不是缺陷。早先按阅读顺序比对 A/B/C/D，把 16 道正常题
 * 误报为异常 —— 那会淹没真正的缺陷（Q54/Q55 的 `O)`）并让门禁失去意义。
 *
 * 因此：
 * - 标签集合等于 {A,B,C,D} → 正常。选项按标签排序后写入包（有意的规范化，已登记审计）。
 * - 标签集合含非 A–D 的字母（实测 `O)`）或缺少某个 → REVIEW_REQUIRED。
 * - 标签重复 →  REVIEW_REQUIRED（一定是切分错误）。
 */
function auditOptions(questions: DetectedQuestion[], review: ReviewItem[], sourceAnomalies: string[]): void {
  for (const question of questions) {
    if (question.number === null) continue;
    const printed = question.options.map((option) => option.printedLabel);

    let duplicated = false;
    const seen = new Set<string>();
    for (const label of printed) {
      if (seen.has(label)) {
        duplicated = true;
        review.push({
          code: "option_label_duplicate",
          severity: "blocking",
          where: `q${question.number}.options`,
          detail: `第 ${question.number} 题选项标签重复：${label}`,
          evidence: question.options.map((option) => `${option.printedLabel})${option.text}`).join(" | "),
        });
      }
      seen.add(label);
    }
    if (duplicated) continue;

    const expected = OPTION_LETTERS.slice(0, 4);
    const missing = expected.filter((label) => !printed.includes(label));
    const unexpected = printed.filter((label) => !expected.includes(label));

    if (missing.length > 0) {
      const evidence = question.options.map((option) => `${option.printedLabel})${option.text}`).join(" | ");
      if (unexpected.length > 0) {
        // 源件印出了非标准标签（实测 Q54/Q55 第三项印成 `O)`）。
        // 这是**源件的真实打印差异**，原样保留并上报，绝不静默改成 C。
        sourceAnomalies.push(
          `第 ${question.number} 题源件印出的选项标签为 ${printed.join("/")}（应为 ${expected.join("/")}）—— 原样保留，未改写`,
        );
        review.push({
          code: "option_label_unexpected",
          severity: "blocking",
          where: `q${question.number}.options`,
          detail:
            `第 ${question.number} 题的选项标签异常：缺少 ${missing.join("/")}，多出 ${unexpected.join("/")}。` +
            `这可能是源件打印错误，需人工核对原卷后决定该选项的标签。`,
          evidence,
        });
      } else {
        review.push({
          code: "option_label_incomplete",
          severity: "blocking",
          where: `q${question.number}.options`,
          detail: `第 ${question.number} 题缺少选项 ${missing.join("/")}（实际印出 ${printed.join("/") || "无"}）`,
          evidence,
        });
      }
      continue;
    }

    // 标签集合完整 —— 按标签排序，消除双栏阅读顺序带来的 A/C/B/D 排列。
    // 这是**有意的规范化**：包的消费者按标签定位选项，与源件的视觉顺序无关。
    question.options.sort((a, b) => a.printedLabel.localeCompare(b.printedLabel));
  }
}

// ---------------------------------------------------------------------------
// 阅读
// ---------------------------------------------------------------------------

const READING_TYPE_BY_LETTER: Record<string, "reading.banked_cloze" | "reading.matching" | "reading.careful_reading"> =
  {
    A: "reading.banked_cloze",
    B: "reading.matching",
    C: "reading.careful_reading",
  };

function detectReadingPart(
  heading: string,
  scope: ExtractedLine[],
  margin: number,
  review: ReviewItem[],
  sourceAnomalies: string[],
): DetectedSection[] {
  const subsections = findSubsections(scope, margin, review, "reading", heading);
  const sections: DetectedSection[] = [];

  for (const sub of subsections) {
    const type = READING_TYPE_BY_LETTER[sub.letter];
    if (!type) {
      review.push({
        code: "section_anchor_conflict",
        severity: "blocking",
        where: `reading/Section ${sub.letter}`,
        detail: `阅读出现未知小节字母：${sub.letter}`,
        evidence: null,
      });
      continue;
    }
    const inner = scope.slice(sub.index, sub.endExclusive);
    const title = `Part III Reading Comprehension · Section ${sub.letter}`;
    const instructions = collectDirections(inner);

    if (type === "reading.banked_cloze") {
      sections.push({
        type,
        title,
        anchor: sub.heading,
        instructions,
        groups: [detectCloze(inner, instructions, review)],
      });
    } else if (type === "reading.matching") {
      sections.push({
        type,
        title,
        anchor: sub.heading,
        instructions,
        groups: [detectMatching(inner, instructions, sub.letter, review)],
      });
    } else {
      sections.push({
        type,
        title,
        anchor: sub.heading,
        instructions,
        groups: detectCarefulReading(inner, instructions, sub.letter, review, sourceAnomalies),
      });
    }
  }

  return sections;
}

// ---------------------------------------------------------------------------
// 选词填空
// ---------------------------------------------------------------------------

/** 词库项是**单个单词**：实测最长 `intrinsically`（13 字符），且不含句末标点。 */
function asBankWord(text: string): string | null {
  const word = text.trim();
  if (word === "" || word.length > 16) return null;
  if (/[.!?]$/.test(word)) return null;
  return /^[A-Za-z][A-Za-z'-]*$/.test(word) ? word : null;
}

function detectCloze(scope: ExtractedLine[], instructions: string | null, review: ReviewItem[]): DetectedGroup {
  // 词库：全篇扫描"标签 + 单词"的段。只有当 A–O 十五个标签**齐备**时才认作词库，
  // 因此不会把文章里的偶然 `A)` 误判成词库。
  const bankCandidates: { lineIndex: number; label: string; word: string }[] = [];
  scope.forEach((line, lineIndex) => {
    // 传原始文本与 runStarts：词库的左右两栏在整行拼接后**没有空格分隔**
    // （实测 `A) alpha` + `I) india` → `A) alphaI) india`），
    // 只有 run 边界能可靠地标出右栏标签的起点。
    const { segments } = splitLabelSegments(line.text, line.runStarts);
    for (const segment of segments) {
      const word = asBankWord(norm(segment.text));
      if (word !== null) bankCandidates.push({ lineIndex, label: segment.label, word });
    }
  });

  const byLabel = new Map<string, { lineIndex: number; word: string }>();
  for (const candidate of bankCandidates) {
    if (!byLabel.has(candidate.label)) byLabel.set(candidate.label, candidate);
  }
  const bankComplete = OPTION_LETTERS.every((label) => byLabel.has(label));

  const bankEntries = bankComplete
    ? OPTION_LETTERS.map((label) => ({ printedLabel: label, word: byLabel.get(label)!.word }))
    : [];

  const bankStartIndex = bankComplete
    ? Math.min(...OPTION_LETTERS.map((label) => byLabel.get(label)!.lineIndex))
    : -1;

  // 文章：Directions 之后、词库之前
  const passageLines: ExtractedLine[] = [];
  let seenDirections = false;
  const passageEnd = bankStartIndex >= 0 ? bankStartIndex : scope.length;
  for (let i = 0; i < passageEnd; i += 1) {
    const line = scope[i];
    const text = norm(line.text);
    if (text === "") continue;
    if (DIRECTIONS_PREFIX.test(text)) {
      seenDirections = true;
      continue;
    }
    if (!seenDirections) continue;
    passageLines.push(line);
  }

  const rawPassage = joinWithParagraphs(passageLines);
  // 空位标记规范化：源件 `___26___` → 包格式 `[26]`（与参考包一致，有意为之）
  const passage = rawPassage.replace(/_{2,}\s*(\d{1,2})\s*_{2,}/g, "[$1]");

  const blankNumbers: number[] = [];
  for (const line of passageLines) {
    for (const match of line.text.matchAll(/_{2,}\s*(\d{1,2})\s*_{2,}/g)) blankNumbers.push(Number(match[1]));
  }

  const questions: DetectedQuestion[] = blankNumbers.map((number, index) => ({
    number,
    kind: "banked_cloze_blank" as const,
    stem: null,
    options: [],
    blankId: String(number),
    statement: null,
    page: passageLines[0]?.page ?? scope[0]?.page ?? 0,
    y: 0,
    sourceLines: [],
    order: index,
  }));

  if (!bankComplete) {
    review.push({
      code: "word_bank_cardinality",
      severity: "blocking",
      where: "reading/Section A/wordBank",
      detail: `未能在源件中找齐 15 个词库项（A–O），实际检出的标签：${
        [...new Set(bankCandidates.map((entry) => entry.label))].join("") || "（无）"
      }`,
      evidence: bankCandidates.map((entry) => `${entry.label})${entry.word}`).join(" "),
    });
  }

  if (questions.length !== 10) {
    review.push({
      code: "blank_marker_mismatch",
      severity: "blocking",
      where: "reading/Section A",
      detail: `文章应含 10 个空位标记，实际检出 ${questions.length} 个：${blankNumbers.join(",")}`,
      evidence: null,
    });
  }

  const firstPage = scope[0]?.page ?? 0;
  const lastPage = scope[scope.length - 1]?.page ?? firstPage;

  return {
    id: "reading.banked_cloze#g1",
    order: 0,
    sectionType: "reading.banked_cloze",
    anchor: null,
    firstNumber: questions[0]?.number ?? null,
    lastNumber: questions[questions.length - 1]?.number ?? null,
    questions,
    passage: passage || null,
    paragraphs: null,
    wordBank: bankEntries.map((entry) => entry.word),
    instructions,
    pageRange: [firstPage, lastPage],
  };
}

// ---------------------------------------------------------------------------
// 长篇阅读（匹配）
// ---------------------------------------------------------------------------

function detectMatching(
  scope: ExtractedLine[],
  instructions: string | null,
  letter: string,
  review: ReviewItem[],
): DetectedGroup {
  const statementStart = scope.findIndex((line) => {
    const match = QUESTION_NUMBERED.exec(norm(line.text));
    if (!match) return false;
    const n = Number(match[1]);
    return n >= 36 && n <= 45;
  });
  const articleEnd = statementStart >= 0 ? statementStart : scope.length;

  // 段落：行首标签 + 长句内容，且标号顺序为 A,B,C,…
  const paragraphStarts: { index: number; label: string }[] = [];
  for (let i = 0; i < articleEnd; i += 1) {
    const line = scope[i];
    const text = norm(line.text);
    const match = /^([A-O])[).]\s*(.*)$/.exec(text);
    if (!match) continue;
    const rest = match[2].trim();
    if (rest === "") continue;
    if (asBankWord(rest) !== null) continue;
    paragraphStarts.push({ index: i, label: match[1] });
  }

  const labels = paragraphStarts.map((entry) => entry.label);
  const sequential = labels.length > 0 && labels.every((label, i) => label === OPTION_LETTERS[i]);
  if (!sequential) {
    review.push({
      code: labels.length === 0 ? "paragraph_label_missing" : "paragraph_label_sequence_broken",
      severity: "blocking",
      where: `reading/Section ${letter}/paragraphs`,
      detail: `段落标号未构成连续的 A…O 序列，实际检出：${labels.join("") || "（无）"}`,
      evidence: null,
    });
  }

  const paragraphs: { label: string; text: string }[] = [];
  paragraphStarts.forEach((entry, i) => {
    const nextStart = i + 1 < paragraphStarts.length ? paragraphStarts[i + 1].index : articleEnd;
    const body = scope.slice(entry.index, nextStart).filter((line) => norm(line.text) !== "");
    if (body.length === 0) return;
    const first = norm(body[0].text);
    const match = /^([A-O])[).]\s*(.*)$/.exec(first);
    const head = match ? match[2].trim() : first;
    const text = joinTextLines([head, ...body.slice(1).map((line) => line.text)]);
    paragraphs.push({ label: entry.label, text });
  });

  // 文章标题：首个段落之前、水平居中的短行
  const articleTitle = findArticleTitle(scope, paragraphStarts[0]?.index ?? -1, articleEnd);

  const questions: DetectedQuestion[] = [];
  if (statementStart < 0) {
    review.push({
      code: "question_group_anchor_missing",
      severity: "blocking",
      where: `reading/Section ${letter}/statements`,
      detail: "未找到匹配题陈述句（题号 36–45）",
      evidence: null,
    });
  } else {
    let current: DetectedQuestion | null = null;
    for (const line of scope.slice(statementStart)) {
      const text = norm(line.text);
      if (text === "") continue;
      const match = QUESTION_NUMBERED.exec(text);
      const n = match ? Number(match[1]) : null;
      if (match && n !== null && n >= 36 && n <= 45) {
        if (current) questions.push(current);
        current = {
          number: n,
          kind: "matching_statement",
          stem: null,
          options: [],
          blankId: null,
          statement: match[2].trim(),
          page: line.page,
          y: line.y,
          sourceLines: [text],
        };
        continue;
      }
      if (current) {
        current.statement = joinTextLines([current.statement ?? "", line.text]);
        current.sourceLines.push(text);
      }
    }
    if (current) questions.push(current);
  }

  const firstPage = scope[0]?.page ?? 0;
  const lastPage = scope[scope.length - 1]?.page ?? firstPage;

  return {
    id: "reading.matching#g1",
    order: 0,
    sectionType: "reading.matching",
    anchor: null,
    firstNumber: 36,
    lastNumber: 45,
    questions,
    passage: null,
    paragraphs: paragraphs.length > 0 ? paragraphs : null,
    wordBank: null,
    // 与参考包一致：matching 组的 instructions 即文章标题
    instructions: articleTitle ?? instructions,
    pageRange: [firstPage, lastPage],
  };
}

/** 文章标题：段落首行之前的居中短行（实测：源件把标题单独居中印出）。 */
function findArticleTitle(scope: ExtractedLine[], firstParagraphIndex: number, articleEnd: number): string | null {
  if (firstParagraphIndex <= 0) return null;
  const margins = scope.slice(0, articleEnd).map((line) => line.x).filter((x) => Number.isFinite(x));
  if (margins.length === 0) return null;
  const margin = Math.min(...margins);

  for (let i = firstParagraphIndex - 1; i >= 0; i -= 1) {
    const line = scope[i];
    const text = norm(line.text);
    if (text === "") continue;
    if (DIRECTIONS_PREFIX.test(text) || QUESTION_NUMBERED.test(text)) return null;
    if (line.x > margin + 20 && text.length <= 160) return text;
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 仔细阅读
// ---------------------------------------------------------------------------

function detectCarefulReading(
  scope: ExtractedLine[],
  instructions: string | null,
  letter: string,
  review: ReviewItem[],
  sourceAnomalies: string[],
): DetectedGroup[] {
  const passageHeadings: { index: number; label: string }[] = [];
  scope.forEach((line, index) => {
    const text = norm(line.text);
    if (!PASSAGE_HEADING.test(text)) return;
    passageHeadings.push({ index, label: text });
  });

  if (passageHeadings.length === 0) {
    review.push({
      code: "careful_reading_passage_boundary_uncertain",
      severity: "blocking",
      where: `reading/Section ${letter}`,
      detail: "未找到 `Passage One/Two` 标题，无法确定文章边界",
      evidence: null,
    });
    return [];
  }

  return passageHeadings.map((heading, i) => {
    const endExclusive = i + 1 < passageHeadings.length ? passageHeadings[i + 1].index : scope.length;
    const body = scope.slice(heading.index, endExclusive);

    const anchorIndex = body.findIndex((line) => GROUP_ANCHOR.test(norm(line.text)));
    const anchorText = anchorIndex >= 0 ? norm(body[anchorIndex].text) : null;
    const anchorMatch = anchorText ? GROUP_ANCHOR.exec(anchorText) : null;

    const passageStart = anchorIndex >= 0 ? anchorIndex + 1 : 1;
    let firstQuestionIndex = body.length;
    for (let j = passageStart; j < body.length; j += 1) {
      const match = QUESTION_NUMBERED.exec(norm(body[j].text));
      if (!match) continue;
      const n = Number(match[1]);
      if (n >= 46 && n <= 55) {
        firstQuestionIndex = j;
        break;
      }
    }

    const passage = joinWithParagraphs(body.slice(passageStart, firstQuestionIndex));
    const questions = detectMcqQuestions(body.slice(firstQuestionIndex), review, sourceAnomalies);

    const from = anchorMatch ? Number(anchorMatch[1]) : (questions[0]?.number ?? 46);
    const to = anchorMatch ? Number(anchorMatch[2]) : (questions[questions.length - 1]?.number ?? 50);

    if (questions.length !== to - from + 1) {
      review.push({
        code: "question_number_gap",
        severity: "blocking",
        where: `reading/Section ${letter}/${heading.label}`,
        detail: `题组锚点声明 ${from}–${to}（应为 ${to - from + 1} 题），实际检出 ${questions.length} 题`,
        evidence: null,
      });
    }

    const firstPage = body[0]?.page ?? 0;
    const lastPage = body[body.length - 1]?.page ?? firstPage;

    // instructions 采用 `Passage One · <锚点>`，与参考包一致（有意规范化）
    const groupInstructions = anchorText ? `${heading.label} \u00b7 ${anchorText}` : heading.label;

    return {
      id: `reading.careful_reading#g${i + 1}`,
      order: i,
      sectionType: "reading.careful_reading" as const,
      anchor: anchorText,
      firstNumber: from,
      lastNumber: to,
      questions,
      passage: passage || null,
      paragraphs: null,
      wordBank: null,
      instructions: groupInstructions || instructions,
      pageRange: [firstPage, lastPage] as [number, number],
    };
  });
}

// ---------------------------------------------------------------------------
// KEYS 答案表
// ---------------------------------------------------------------------------

/**
 * 解析源卷 KEYS 表：`数字行 + 其下方的字母行`按列配对。
 *
 * 该表位于**第三方存档 PDF** 中，不是教育考试院官方发布的答案。
 */
export function parseKeysTable(lines: ExtractedLine[]): Record<number, string> {
  const keys: Record<number, string> = {};
  const rows: { page: number; text: string; kind: "numbers" | "letters" }[] = [];

  for (const line of lines) {
    const text = norm(line.text);
    if (text === "") continue;
    if (/^\d{1,2}(?:\s+\d{1,2})+$/.test(text)) {
      rows.push({ page: line.page, text, kind: "numbers" });
      continue;
    }
    if (/^[A-O](?:\s+[A-O])+$/.test(text)) {
      rows.push({ page: line.page, text, kind: "letters" });
    }
  }

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (row.kind !== "numbers") continue;
    const next = rows[i + 1];
    if (!next || next.kind !== "letters" || next.page !== row.page) continue;
    const numbers = row.text.split(/\s+/).map(Number);
    const letters = next.text.split(/\s+/);
    if (numbers.length !== letters.length) continue;
    numbers.forEach((number, index) => {
      if (number >= 1 && number <= 55) keys[number] = letters[index];
    });
  }

  return keys;
}

// ---------------------------------------------------------------------------
// 整体校验
// ---------------------------------------------------------------------------

function validateNumbering(
  sections: DetectedSection[],
  keys: Record<number, string>,
  expectedNumberedTotal: number,
  review: ReviewItem[],
  sourceAnomalies: string[],
): void {
  const seen = new Map<number, string>();
  for (const section of sections) {
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.number === null) continue;
        const where = `${section.type}/${group.id}/q${question.number}`;
        const previous = seen.get(question.number);
        if (previous) {
          review.push({
            code: "question_number_duplicate",
            severity: "blocking",
            where,
            detail: `题号 ${question.number} 重复出现：${previous} 与 ${where}`,
            evidence: null,
          });
        }
        seen.set(question.number, where);
      }
    }
  }

  const gaps: number[] = [];
  for (let n = 1; n <= expectedNumberedTotal; n += 1) if (!seen.has(n)) gaps.push(n);
  if (gaps.length > 0) {
    review.push({
      code: "question_number_gap",
      severity: "blocking",
      where: "<paper>",
      detail: `编号题缺失：${gaps.join(",")}（共 ${gaps.length} 个，应为 1–${expectedNumberedTotal}）`,
      evidence: `实际检出 ${seen.size} 个不同题号`,
    });
  }

  const keyCount = Object.keys(keys).length;
  if (keyCount === 0) {
    review.push({
      code: "keys_missing",
      severity: "blocking",
      where: "<pdf>/KEYS",
      detail: "未能从源件解析出 KEYS 答案表",
      evidence: null,
    });
  } else if (keyCount !== expectedNumberedTotal) {
    review.push({
      code: "keys_numbering_mismatch",
      severity: "blocking",
      where: "<pdf>/KEYS",
      detail: `KEYS 表解析出 ${keyCount} 个答案，期望 ${expectedNumberedTotal} 个`,
      evidence: `题号：${Object.keys(keys)
        .map(Number)
        .sort((a, b) => a - b)
        .join(",")}`,
    });
  }

  // 答案必须落在该题**实际印出的**标签内 —— 流水线最有力的自检：
  // 源件打印异常（Q54/Q55 的 `O)`）会在这里被捕到。
  for (const section of sections) {
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.number === null || question.kind !== "mcq") continue;
        const answer = keys[question.number];
        if (!answer) continue;
        const printed = question.options.map((option) => option.printedLabel);
        if (printed.length > 0 && !printed.includes(answer)) {
          const detail = `第 ${question.number} 题：KEYS 表答案 ${answer} 不在该题印出的选项标签（${printed.join("/")}）中`;
          sourceAnomalies.push(detail);
          review.push({
            code: "answer_not_in_options",
            severity: "blocking",
            where: `${section.type}/${group.id}/q${question.number}.answer`,
            detail: `${detail} —— 需人工核对原卷后决定答案标签`,
            evidence: question.options.map((option) => `${option.printedLabel})${option.text}`).join(" | "),
          });
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 写作与翻译
// ---------------------------------------------------------------------------

function extractWriting(sections: DetectedSection[]): StructuralDetection["writing"] {
  const section = sections.find((entry) => entry.type === "writing");
  const group = section?.groups[0];
  if (section === undefined || group === undefined) {
    return { prompt: null, instructions: null, minWords: null, maxWords: null };
  }

  const instructions = group.instructions;
  const quoted = instructions ? /["\u201c]([^"\u201d]{20,})["\u201d]/.exec(instructions) : null;
  const range = instructions
    ? /at least\s+(\d+)\s+words?\s+but\s+no\s+more\s+than\s+(\d+)\s+words?/i.exec(instructions)
    : null;

  return {
    prompt: quoted ? quoted[1].trim() : null,
    instructions,
    minWords: range ? Number(range[1]) : null,
    maxWords: range ? Number(range[2]) : null,
  };
}

function extractTranslation(sections: DetectedSection[]): StructuralDetection["translation"] {
  const section = sections.find((entry) => entry.type === "translation");
  const group = section?.groups[0];
  if (section === undefined || group === undefined) return { sourceText: null, instructions: null };
  return {
    sourceText: group.questions[0]?.statement ?? null,
    instructions: group.instructions,
  };
}
