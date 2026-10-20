/**
 * 课程段候选抽取（conservative, module-aware）。
 *
 * ── 这个模块的首要纪律是"不做什么" ──
 *
 * **不得把每个文件都强行切成详细段。** 一份写作思维导图没有"篇章级"边界，
 * 硬切只会产出看起来合理、实则无意义的段。因此本模块：
 *
 * - 只在**有结构线索**时才切段；
 * - 没有线索时退回**文档级**一个段（`method_note` / `writing_template`），
 *   并如实说明"这是文档级材料，不做精细分段"；
 * - 结构有歧义时**上报复核**，不发明精确边界。
 *
 * ── 源件编号可能是错的 ──
 *
 * 实测教训（真题流水线）：源件的题号会重号、跳号、乱序。
 * 因此**题号只是结构提示，永远不是身份证明**：
 * 它用来找边界，绝不用来断言"这段就是第 46 题"。
 * 编号缺陷原样保留并上报（`SourceAnomaly`），**不静默修正**。
 *
 * ── 段的种类由内容形态决定，不由文件夹名决定 ──
 *
 * 文件夹标签只给一个**候选**模块提示（`moduleHint`），用于选择"先试哪一族结构"。
 * 若模块提示与内容线索冲突，**内容线索赢**，且冲突必须被记下。
 *
 * ── 课程答案的语义 ──
 *
 * 阅读材料里常有"答案/解析"区块。它是 **SOURCE ASSERTION（源件主张）**，
 * 绝不是判分真相，也绝不是 canonical 身份证据。
 * 因此它：
 * - 不进入任何相似度计算（`FORBIDDEN_MATCH_FEATURES`）；
 * - 不进入 `course.json` 的段正文（那会把它变成"课程内容的一部分"）；
 * - 只作为匹配证据里的可见上下文出现。
 */

import { createHash } from "node:crypto";
import { joinTextLines } from "@/content/pipeline/text-utils";
import { pickStableQuote, joinPageText } from "./pdf-extract";
import { hasEnoughSubstance, scriptProfile } from "./projection";
import type { CourseSegmentKind } from "@/domain/course";
import type {
  ExtractedPage,
  MaterialGroupingProposal,
  MaterialSegmentation,
  ParsedDocument,
  ProposedSegment,
  SourceAnomaly,
} from "./types";

// ---------------------------------------------------------------------------
// 结构线索
// ---------------------------------------------------------------------------

/**
 * 词尾判据：**ASCII 词字符之后不再接词字符**。
 *
 * ── 为什么不能用 `\b`（实测踩到的静默缺陷）──
 *
 * JavaScript 的 `\b` 只认 ASCII 词字符（`[A-Za-z0-9_]`）。中文汉字**不是**
 * 词字符，因此 `^参考译文\b` 在 `参考译文（课程材料）` 上**永远不匹配** ——
 * 而它在 `参考译文` 后面紧跟行尾时同样不匹配（因为 `文` 与行尾之间没有
 * "词字符↔非词字符"的转换）。
 *
 * 后果不是报错，而是**静默失效**：翻译段的"参考译文"分区识别、
 * 以及中文答案区块的剥离永远不会发生 —— 于是中文原文与参考译文被合并进
 * 同一个段，而没有人会发现。
 *
 * `(?![a-z0-9])` 表达的是我们真正想要的那件事："这个词到此为止"，
 * 且它对 CJK 与 ASCII **一视同仁**（配合 `i` 标志时 `[a-z0-9]` 也覆盖大写）。
 */
const WORD_END = "(?![a-z0-9])";

/**
 * 阅读篇章起点 —— **只认独立成行的篇章标记**。
 *
 * ── 为什么必须严格到"整行只有标记" ──
 *
 * 实测踩到：`Passage One Questions` 这种"篇章标记 + 该篇章的题目页标题"
 * 的复合行，若用宽松的 `^passage\s+one` 匹配，会在题目页**再切一段** ——
 * 于是一篇篇章变成两段，第二段只有题目。那不是源件的结构，是判据太松造出来的。
 *
 * 因此这里要求：整行**就是**篇章标记（可带尾部标点），不含其他词。
 * 真实的讲义标题行正是这种形态（`Passage One` / `Passage 1`）。
 */
const READING_PASSAGE_MARKER = /^passage\s+(one|two|three|four|five|1|2|3|4|5)\s*[.:、]?\s*$/i;

/**
 * 阅读大题的整体标题（`Part III Reading Comprehension`）。
 *
 * 它**不是**篇章边界，而是一个大题起点：它后面通常紧跟"Questions N to M"，
 * 再由篇章标记划分篇章。若把它当篇章边界，第一个篇章会多出一个只含标题的空段。
 * 因此它只用于"确认这份材料确实是阅读"，不切段。
 */
const READING_SECTION_HEADING = new RegExp(`^(part\\s+[ivx]+\\s+)?reading\\s+comprehension${WORD_END}`, "i");

/**
 * 听力分组标记。
 *
 * `Section A/B/C` 与 `Conversation One` / `Passage One` / `Recording` / `Lecture`
 * 都是真实出现的分组起点；`Questions N to M` 是题组锚点。
 *
 * 刻意**不含**裸 `Passage N`：canonical 听力用 Section A/B/C 划分，
 * 而 `Passage One` 在阅读材料里是篇章标记。放进这里会让阅读材料被误判为听力。
 */
const LISTENING_GROUP_START = new RegExp(
  `^(section\\s+[abc]${WORD_END}|conversation\\s+(one|two|1|2)${WORD_END}|` +
    `recording\\s+(one|two|1|2)${WORD_END}|lecture\\s+(one|two|1|2)${WORD_END}|` +
    `questions?\\s+\\d+\\s+to\\s+\\d+)`,
  "i",
);

/** 翻译原文起点。 */
const TRANSLATION_START = new RegExp(`^(translate|translation|翻译)${WORD_END}`, "i");

/** 参考译文标记。 */
const REFERENCE_TRANSLATION_MARK = new RegExp(
  `^(参考译文|译文|reference\\s+translation|sample\\s+translation)${WORD_END}`,
  "i",
);

/** 分区标记：答案 / 解析。刻意不含 `译文`（那是参考译文标记，见上）。 */
const ANSWER_SECTION_MARK = new RegExp(
  `^(答案|参考答案|答案与解析|解析|answer\\s*keys?${WORD_END}|keys?${WORD_END}|solutions?${WORD_END})`,
  "i",
);

/** 分区标记：文字稿。 */
const TRANSCRIPT_SECTION_MARK = new RegExp(
  `^(听力原文|原文|文字稿|transcript${WORD_END}|script${WORD_END}|listening\\s+text)`,
  "i",
);

/** 题号：行首的 `46.` / `46．` / `46)`（**结构提示，不是身份**）。 */
const QUESTION_NUMBER = /^(\d{1,3})\s*[.．、)）]\s*/;

/** 选项标签 `A)` / `A.` —— 已经印出的选项行。 */
const OPTION_LABEL = /^([A-O])\s*[.)、）]\s*/;

// ---------------------------------------------------------------------------
// 段 id
// ---------------------------------------------------------------------------

/**
 * 段 id 的**唯一构造入口**。
 *
 * ── 为什么必须带材料作用域 ──
 *
 * 实测踩到：两个不同的材料各自产出 `reading.1`，于是 `course.json` 里
 * 出现**重复的 segment id** —— 而生产校验器要求 id 全局唯一，整个包会被拒绝。
 * 更糟的是这个缺陷只在"一个包里有多份同类材料"时才出现，
 * 单材料夹具永远测不到。
 *
 * 因此 id 由 (材料, 序号) 共同决定：取材料提案 id 的短哈希作作用域前缀。
 * 结果仍然满足 `^[a-z0-9][a-z0-9._-]*$`，且**确定性**（同一输入同一 id）。
 *
 * `kindPrefix` 保留在 id 里是为了**人可读**：复核者一眼能看出
 * `m4f2a1c8.reading.2` 是某份材料里的第二个阅读段。
 */
export function segmentIdOf(materialProposalId: string, kindPrefix: string, ordinal: number): string {
  const scope = createHash("sha256").update(materialProposalId, "utf8").digest("hex").slice(0, 8);
  return `m${scope}.${kindPrefix}.${ordinal}`;
}

/**
 * 段的最小文本量。低于它的切片不被独立成段。
 *
 * 理由：源件里的 `Section A` 这类分区标记若紧跟 `Questions 1 to 4`，
 * 会让第一段只剩一个标题（实测踩到）。那不是源件的结构，是判据太细造出来的噪音。
 */
export const MIN_SEGMENT_CHARS = 40;

/** 切片文本是否够"实"（用于把近空切片并入相邻段）。 */
function sliceHasSubstance(slice: LineRef[]): boolean {
  const text = slice.map((line) => line.text).join(" ").replace(/\s+/g, " ").trim();
  return text.length >= MIN_SEGMENT_CHARS;
}

/**
 * 依据边界把行切成有实质内容的切片。
 *
 * **近空切片并入相邻段**，而不是丢弃也不是独立成段：
 * - 丢弃会丢掉源件真实存在的标题行；
 * - 独立成段会产出只有 `Section A` 两个字的内容段（实测踩到）。
 *
 * 合并**双向**：
 * - 中间的近空切片 → 并入**前一段**的尾部；
 * - 开头的近空切片（如 `Section A` 紧接 `Questions 1 to 4`）→ 并入**后一段**的头部，
 *   因为那两行在源件里属于同一个分组。
 *
 * 最后一个切片即使很短也保留 —— 它承载的是源件真实的尾部内容。
 */
function sliceByBoundaries(lines: LineRef[], boundaries: Boundary[]): { boundary: Boundary; slice: LineRef[] }[] {
  const raw: { boundary: Boundary; slice: LineRef[] }[] = [];

  for (const [index, boundary] of boundaries.entries()) {
    const next = boundaries[index + 1];
    const slice = lines.slice(boundary.index, next?.index ?? lines.length);
    if (slice.length === 0) continue;
    raw.push({ boundary, slice });
  }

  if (raw.length <= 1) return raw;

  const out: { boundary: Boundary; slice: LineRef[] }[] = [];

  for (const [index, entry] of raw.entries()) {
    const previous = out[out.length - 1];

    if (sliceHasSubstance(entry.slice)) {
      out.push(entry);
      continue;
    }

    if (previous !== undefined) {
      // 中间的近空切片：并入前一段尾部
      previous.slice = [...previous.slice, ...entry.slice];
      continue;
    }

    // 开头的近空切片：**向前**并入下一段（若没有下一段则只能自成一段）
    const nextEntry = raw[index + 1];
    if (nextEntry !== undefined) {
      nextEntry.slice = [...entry.slice, ...nextEntry.slice];
      continue;
    }

    out.push(entry);
  }

  return out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

export interface SegmentMaterialInput {
  proposal: MaterialGroupingProposal;
  /** 该材料各表示的解析产物（只有 PDF 会有）。 */
  documents: ParsedDocument[];
  /** 资产键 → 该资产的模块提示依据（审计用）。 */
  moduleHintBasis?: Map<string, string | null>;
}

/**
 * 对一份材料提案做保守的段抽取。
 *
 * 返回的段**尚未进入 course.json** —— 它们是候选，且带完整证据。
 */
export function extractSegmentsForMaterial(input: SegmentMaterialInput): MaterialSegmentation {
  const { proposal, documents } = input;
  const warnings: string[] = [];

  // 可解析的表示：只有 PDF。取第一个（若有多个 PDF，它们已被分组逻辑判过）
  const parsed = documents.find((doc) => doc.pages.length > 0 && doc.state !== "failed") ?? null;

  if (parsed === null) {
    // ── 没有可解析内容 ──
    // 这是**合法**状态。绝不能凭空造段。
    return {
      materialProposalId: proposal.id,
      moduleHint: proposal.moduleHint,
      segments: [],
      documentLevelOnly: false,
      warnings: buildNoContentWarnings(proposal, documents),
      anomalies: buildNoContentAnomalies(proposal, documents),
    };
  }

  const pages = parsed.pages;
  const allText = pages
    .filter((page) => page.hasTextLayer)
    .map((page) => page.paragraphText)
    .join("\n\n");

  // 无文本层的页：段边界可能落在看不见的内容上 ⇒ 必须复核
  const noTextPages = pages.filter((page) => !page.hasTextLayer).map((page) => page.page);

  if (noTextPages.length > 0) {
    warnings.push(
      `该材料的第 ${noTextPages.join("、")} 页没有文本层。` +
        `本版本不做 OCR —— 这些页上的内容不会被推测，段的完整性无法保证。`,
    );
  }

  if (!hasEnoughSubstance(allText)) {
    // 文本层存在但内容极少（例如整页是一张图 + 一行页眉）
    return {
      materialProposalId: proposal.id,
      moduleHint: proposal.moduleHint,
      segments: [],
      documentLevelOnly: false,
      warnings: [
        ...warnings,
        "该材料虽然能解析，但可用的文本量极少 —— 不足以支撑有意义的段抽取，因此不产出段。",
      ],
      anomalies: [
        {
          code: "no_structural_cue",
          where: proposal.id,
          detail: "文本量低于相似度最小体量闸门，不产出段（避免产出无意义的碎片段）。",
          evidence: allText.slice(0, 120),
        },
      ],
    };
  }

  // ── 按候选模块分发 ──
  //
  // 模块提示只决定"先试哪一族结构"。若那一族找不到任何线索，
  // 会退回内容驱动的通用处理，并记录这次回退。
  //
  // 注意：可解析的文档**可能不止一个** —— 一个听力套装典型地由
  // "题干讲义 PDF + 文字稿 PDF + 整段音频"组成。因此听力分支拿到的是
  // **全部**可解析文档，而其余分支用主文档（第一个有内容的 PDF）。
  const allParsed = documents.filter((doc) => doc.pages.length > 0 && doc.state !== "failed");
  const hint = proposal.moduleHint;
  let segmentation: MaterialSegmentation;

  if (hint === "reading") {
    segmentation = segmentReading(proposal, pages, parsed, { noTextPages });
  } else if (hint === "listening") {
    segmentation = segmentListening(proposal, allParsed, parsed, { noTextPages });
  } else if (hint === "translation") {
    segmentation = segmentTranslation(proposal, pages, parsed, { noTextPages });
  } else if (hint === "writing" || hint === "methods") {
    segmentation = segmentWritingOrMethods(proposal, pages, parsed, { noTextPages });
  } else {
    // 无模块提示：用内容自身判定，而不是"默认当阅读"
    segmentation = segmentUnknownModule(proposal, pages, parsed, { noTextPages }, allParsed);
  }

  return {
    ...segmentation,
    warnings: [...warnings, ...segmentation.warnings],
  };
}

// ---------------------------------------------------------------------------
// 无内容时的诚实输出
// ---------------------------------------------------------------------------

function buildNoContentWarnings(proposal: MaterialGroupingProposal, documents: ParsedDocument[]): string[] {
  const warnings: string[] = [];
  const deferred = documents.filter((doc) => doc.state === "deferred");
  const failed = documents.filter((doc) => doc.state === "failed");
  const noText = documents.filter((doc) => doc.state === "no_text_layer");

  for (const doc of deferred) {
    warnings.push(
      `资产 ${doc.assetKey} 的文本抽取被**有意推迟**（${doc.deferredMarker}）：` +
        `V1 不解析该格式。它已登记为表示，但绝不假装抽到了文本。`,
    );
  }
  for (const doc of failed) {
    warnings.push(`资产 ${doc.assetKey} 解析失败：${doc.error ?? "未知错误"}。不做任何推测。`);
  }
  for (const doc of noText) {
    warnings.push(`资产 ${doc.assetKey} 没有可用文本层（第 ${doc.pagesWithoutTextLayer.join("、")} 页）。不做 OCR。`);
  }

  if (warnings.length === 0) {
    warnings.push("该材料没有任何可解析的内容，因此不产出段。");
  }

  // 明确说明这不是错误，而是被如实记录的状态
  warnings.push(
    `材料「${proposal.title}」未产出任何课程段。` +
      `这是**合法**状态：没有内容证据时不得发明段。`,
  );
  return warnings;
}

function buildNoContentAnomalies(
  proposal: MaterialGroupingProposal,
  documents: ParsedDocument[],
): SourceAnomaly[] {
  const out: SourceAnomaly[] = [];
  for (const doc of documents) {
    if (doc.state !== "deferred") continue;
    out.push({
      code: "no_structural_cue",
      where: `${proposal.id}/${doc.assetKey}`,
      detail:
        `TEXT_EXTRACTION_DEFERRED：该资产为 DOCX（或同类文档），V1 刻意不解析其文本。` +
        `它被登记为表示，但没有内容可供分段 —— 这是如实状态，不是失败。`,
      evidence: null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 阅读
// ---------------------------------------------------------------------------

interface SegmentContext {
  noTextPages: number[];
}

function segmentReading(
  proposal: MaterialGroupingProposal,
  pages: ExtractedPage[],
  parsed: ParsedDocument,
  context: SegmentContext,
): MaterialSegmentation {
  const representationKey = parsed.assetKey;
  const lines = collectLines(pages, representationKey);
  // 只认**独立成行**的篇章标记。`Passage One Questions` 这类复合行不是边界
  // （它会在题目页再切一段，把一篇篇章变成两段）。
  const boundaries = findBoundaries(lines, READING_PASSAGE_MARKER, "passage");

  // 有"阅读大题标题"但没有篇章标记 ⇒ 仍按文档级输出（不发明边界）
  const hasSectionHeading = lines.some((line) => READING_SECTION_HEADING.test(line.text.trim()));
  if (boundaries.length === 0) {
    return documentLevelReading(proposal, pages, parsed, context, {
      reason: hasSectionHeading
        ? "源件里有阅读大题标题，但没有可识别的篇章级标记（Passage One / Passage Two 这类独立成行的标题）"
        : "源件里找不到篇章级结构线索",
    });
  }

  const segments: ProposedSegment[] = [];
  const anomalies: SourceAnomaly[] = [];
  const warnings: string[] = [];

  for (const [index, entry] of sliceByBoundaries(lines, boundaries).entries()) {
    const { boundary, slice } = entry;

    const observed = extractQuestionNumbers(slice);
    const answerBlocks = slice.filter((line) => ANSWER_SECTION_MARK.test(line.text.trim()));

    // 把"答案/解析"从正文里**分开**：正文进 text，讲解与答案线索进 notes 与证据。
    // 课程答案**不得**成为 canonical 判分真相，因此它不进 text。
    const { passage, courseAnswerKey } = splitReadingBody(slice);

    const quote = pickQuoteForSlice(pages, slice);
    const pageStart = slice[0].page;
    const pageEnd = slice[slice.length - 1].page;

    const cues = [boundary.cue];
    if (answerBlocks.length > 0) cues.push(`答案区块标记：${answerBlocks[0].text.trim().slice(0, 40)}`);

    const reviewNotes: string[] = [];
    if (observed.length === 0) {
      reviewNotes.push(
        "该段内没有观测到题号 —— 它可能是一篇没有配套题目的阅读材料。" +
          "这不影响把它作为课程段，但意味着无法用题号做任何结构核对（题号本来也不是身份证明）。",
      );
    }
    if (courseAnswerKey !== null) {
      reviewNotes.push(
        `该段内含课程答案区块（${courseAnswerKey.slice(0, 40)}）。` +
          `课程答案是**源件主张**，不是判分真相，也不是 canonical 身份证据。`,
      );
    }
    if (pageStart !== pageEnd && spansMissingPage(slice, pages)) {
      reviewNotes.push("该段跨越了没有文本层的页 —— 段边界可能不完整，必须人工确认。");
    }
    const numberDefects = checkQuestionNumberSequence(observed);
    anomalies.push(...numberDefects);

    segments.push({
      id: segmentIdOf(proposal.id, "reading", index + 1),
      materialProposalId: proposal.id,
      kind: "reading_passage",
      order: index,
      title: boundary.title ?? `阅读篇章 ${index + 1}`,
      representationAssetKey: representationKey,
      anchor: { pageStart, pageEnd, quote },
      audioAssetKey: null,
      text: passage,
      transcript: null,
      referenceTranslation: null,
      notes: buildReadingNotes(slice, courseAnswerKey),
      evidence: {
        cues,
        lineSpan: `${pageStart}:${slice[0].indexInPage + 1}–${pageEnd}:${slice[slice.length - 1].indexInPage + 1}`,
        observedQuestionNumbers: observed,
        folderLabelOnly: false,
      },
      reviewRequired: reviewNotes.length > 0 || numberDefects.length > 0,
      reviewNotes,
      anomalies: numberDefects,
    });
  }

  return {
    materialProposalId: proposal.id,
    moduleHint: proposal.moduleHint,
    segments,
    documentLevelOnly: false,
    warnings,
    anomalies,
  };
}

/** 阅读：没有篇章标记时的文档级退路。**不硬切**。 */
function documentLevelReading(
  proposal: MaterialGroupingProposal,
  pages: ExtractedPage[],
  parsed: ParsedDocument,
  context: SegmentContext,
  reason: { reason: string },
): MaterialSegmentation {
  const text = joinPageText(pages, 1, Number.MAX_SAFE_INTEGER);
  const quote = pickStableQuote(pages);
  const fromPage = pages.find((page) => page.hasTextLayer)?.page ?? 1;
  const toPage = [...pages].reverse().find((page) => page.hasTextLayer)?.page ?? fromPage;

  return {
    materialProposalId: proposal.id,
    moduleHint: proposal.moduleHint,
    segments: [
      {
        id: segmentIdOf(proposal.id, "reading", 1),
        materialProposalId: proposal.id,
        kind: "reading_passage",
        order: 0,
        title: proposal.title,
        representationAssetKey: parsed.assetKey,
        anchor: { pageStart: fromPage, pageEnd: toPage, quote: quote.quote },
        audioAssetKey: null,
        text,
        transcript: null,
        referenceTranslation: null,
        notes: null,
        evidence: {
          cues: ["（未找到篇章级结构线索，按文档级输出）"],
          lineSpan: `p${fromPage}–p${toPage}`,
          observedQuestionNumbers: [],
          folderLabelOnly: false,
        },
        // 文档级输出**必须**复核：它没有被结构证据切成多段。
        reviewRequired: true,
        reviewNotes: [
          `该材料被标记为阅读，但 ${reason.reason} —— ` +
            "因此按**文档级**输出一个段，而不是发明精确边界。" +
            "若这份材料其实包含多篇篇章，请人工拆分（或修正源件后重跑）。",
        ],
        anomalies: [
          {
            code: "no_structural_cue",
            where: proposal.id,
            detail: `${reason.reason}，按文档级输出一个 reading_passage 段。`,
            evidence: quote.reason,
          },
        ],
      },
    ],
    documentLevelOnly: true,
    warnings: [
      ...(context.noTextPages.length > 0
        ? [`该材料第 ${context.noTextPages.join("、")} 页没有文本层，不做 OCR。`]
        : []),
      "该材料按文档级输出（未找到篇章级边界线索）。",
    ],
    anomalies: [],
  };
}

/** 把阅读段的正文与课程答案区块分开。 */
function splitReadingBody(slice: LineRef[]): { passage: string; courseAnswerKey: string | null } {
  const answerStart = slice.findIndex((line) => ANSWER_SECTION_MARK.test(line.text.trim()));
  if (answerStart < 0) {
    return { passage: joinTextLines(slice.map((line) => line.text)), courseAnswerKey: null };
  }
  const bodyLines = slice.slice(0, answerStart).map((line) => line.text);
  const answerLines = slice.slice(answerStart).map((line) => line.text);
  return {
    passage: joinTextLines(bodyLines),
    // 课程答案是**源件主张**：保留原文供复核，但只作为证据，不做判分真相。
    courseAnswerKey: joinTextLines(answerLines).slice(0, 600),
  };
}

function buildReadingNotes(slice: LineRef[], courseAnswerKey: string | null): string | null {
  const notes: string[] = [];
  // 语言点 / 讲解：源件里常见的 rubric 行
  const rubric = slice
    .map((line) => line.text.trim())
    .filter((text) => /^(语言点|词汇|讲解|解析|考点|notes?|vocabulary)/i.test(text));
  if (rubric.length > 0) notes.push(rubric.slice(0, 5).join("；"));
  if (courseAnswerKey !== null) {
    notes.push(
      `源件在本段内给出了课程答案/解析区块（下列内容为**源件主张**，不是判分真相）：\n${courseAnswerKey}`,
    );
  }
  return notes.length === 0 ? null : notes.join("\n\n");
}

// ---------------------------------------------------------------------------
// 听力
// ---------------------------------------------------------------------------

function segmentListening(
  proposal: MaterialGroupingProposal,
  parsedDocuments: ParsedDocument[],
  primary: ParsedDocument,
  context: SegmentContext,
): MaterialSegmentation {
  // 一份听力套装可能有**多个** PDF（题干讲义 + 文字稿）。
  // 分区标记（`Section A` / `Transcript`）可能出现在其中任意一个文件里，
  // 因此这里对**全部**可解析文档做行流分析。
  const lines = collectLinesFromDocuments(parsedDocuments);
  const boundaries = findBoundaries(lines, LISTENING_GROUP_START, "listening");
  const audioAssetKey = proposal.representations.find((rep) => rep.kind === "audio")?.assetKey ?? null;
  const labelOf = (assetKey: string): string =>
    proposal.representations.find((rep) => rep.assetKey === assetKey)?.sourceRelativePath ?? assetKey;

  if (boundaries.length === 0) {
    // 没有分组线索：按文档级输出一个段，且**不猜测音频的时间区间**。
    const text = parsedDocuments
      .map((doc) => doc.pages.filter((page) => page.hasTextLayer).map((page) => page.paragraphText).join("\n\n"))
      .join("\n\n")
      .trim();
    const quote = pickStableQuote(primary.pages);
    const toPage = primary.pages.length;
    return {
      materialProposalId: proposal.id,
      moduleHint: proposal.moduleHint,
      segments: [
        {
          id: segmentIdOf(proposal.id, "listening", 1),
          materialProposalId: proposal.id,
          kind: "listening_recording",
          order: 0,
          title: proposal.title,
          representationAssetKey: primary.assetKey,
          anchor: { pageStart: 1, pageEnd: toPage, quote: quote.quote },
          audioAssetKey,
          text: null,
          transcript: text,
          referenceTranslation: null,
          notes: null,
          evidence: {
            cues: ["（未找到分组结构线索，按整段文档级输出）"],
            lineSpan: `p1–p${toPage}`,
            observedQuestionNumbers: [],
            folderLabelOnly: false,
          },
          reviewRequired: true,
          reviewNotes: [
            "该听力材料**找不到分组结构线索**（Conversation / Passage / Recording 标记）。" +
              "因此按整段输出一个段，而不是发明分组边界。",
            audioAssetKey === null
              ? "该材料没有音频资产 —— 它只可能是讲义或文字稿。"
              : "音频按**整段**引用，本版本不切分、不重编码、**不推断时间区间**。",
          ],
          anomalies: [
            {
              code: "no_structural_cue",
              where: proposal.id,
              detail: "未找到听力分组线索，按整段文档级输出。",
              evidence: quote.reason,
            },
          ],
        },
      ],
      documentLevelOnly: true,
      warnings: [...(context.noTextPages.length > 0 ? [`第 ${context.noTextPages.join("、")} 页无文本层。`] : [])],
      anomalies: [],
    };
  }

  const segments: ProposedSegment[] = [];
  const anomalies: SourceAnomaly[] = [];
  let conversationIndex = 0;
  let passageIndex = 0;
  let recordingIndex = 0;

  for (const [order, entry] of sliceByBoundaries(lines, boundaries).entries()) {
    const { boundary, slice } = entry;

    const kind = classifyListeningGroup(boundary.cue);
    const ordinal =
      kind === "listening_conversation"
        ? (conversationIndex += 1)
        : kind === "listening_passage"
          ? (passageIndex += 1)
          : (recordingIndex += 1);

    const text = joinTextLines(slice.map((line) => line.text));
    const observed = extractQuestionNumbers(slice);
    const quote = pickQuoteForSliceForSlice(slice, parsedDocuments);
    const pageStart = slice[0].page;
    const pageEnd = slice[slice.length - 1].page;

    // 页码锚点只在**单个表示**的页码体系里成立。跨文件（讲义 + 文字稿）的段
    // 拿不到唯一表示，因此放弃页码而保留引文 —— 见 `singleRepresentationOf`。
    const sliceRepresentation = singleRepresentationOf(slice);

    const numberDefects = checkQuestionNumberSequence(observed);
    anomalies.push(...numberDefects);

    const isTranscript = TRANSCRIPT_SECTION_MARK.test(boundary.cue.trim());
    const reviewNotes: string[] = [];
    if (audioAssetKey === null) {
      reviewNotes.push(
        "该听力段没有音频资产 —— 本层要求听力段引用**整段**音频（不切分）。" +
          "若这份材料确实只有文字稿，请在复核时确认它应作为文字稿材料处理。",
      );
    } else {
      reviewNotes.push(
        "音频按**整段**引用：本版本不切分、不重编码、**不推断 startSeconds/endSeconds**" +
          "（源件没有显式给出时间区间）。",
      );
    }
    if (isTranscript) {
      reviewNotes.push("该段的起点是文字稿分区标记 —— 它承载 transcript 而不是题面。");
    }
    if (sliceRepresentation === null) {
      reviewNotes.push(
        `该段跨越了多个文件（${[...new Set(slice.map((line) => labelOf(line.assetKey)))].join("、")}），` +
          `因此**不声明页码锚点**（页码只在某一个文件的页码体系里成立），只保留可核对的引文。`,
      );
    }
    if (numberDefects.length > 0) {
      reviewNotes.push("该段观测到题号缺陷（重号/跳号/乱序）。题号只是结构提示，不是身份证明；缺陷已原样保留。");
    }

    segments.push({
      id: segmentIdOf(proposal.id, kindPrefix(kind), ordinal),
      materialProposalId: proposal.id,
      kind,
      order,
      title: boundary.title ?? `${kindTitle(kind)} ${ordinal}`,
      // 段锚定到它实际来自的那个文件（跨文件时为 null，由 anchor 的引文承担定位）
      representationAssetKey: sliceRepresentation,
      anchor: {
        pageStart: sliceRepresentation === null ? null : pageStart,
        pageEnd: sliceRepresentation === null ? null : pageEnd,
        quote,
      },
      audioAssetKey,
      text: null,
      transcript: text,
      referenceTranslation: null,
      notes: null,
      evidence: {
        cues: [boundary.cue],
        lineSpan: `${labelOf(slice[0].assetKey)}:${pageStart}:${slice[0].indexInPage + 1}` +
          `–${labelOf(slice[slice.length - 1].assetKey)}:${pageEnd}:${slice[slice.length - 1].indexInPage + 1}`,
        observedQuestionNumbers: observed,
        folderLabelOnly: false,
      },
      reviewRequired: reviewNotes.length > 0,
      reviewNotes,
      anomalies: numberDefects,
    });
  }

  return {
    materialProposalId: proposal.id,
    moduleHint: proposal.moduleHint,
    segments,
    documentLevelOnly: false,
    warnings: [
      ...(context.noTextPages.length > 0
        ? [`该材料第 ${context.noTextPages.join("、")} 页没有文本层，不做 OCR。`]
        : []),
    ],
    anomalies,
  };
}

function classifyListeningGroup(cue: string): CourseSegmentKind {
  const text = cue.trim();
  if (/^section\s+a/i.test(text) || /conversation/i.test(text)) return "listening_conversation";
  if (/^section\s+b/i.test(text) || /^passage/i.test(text)) return "listening_passage";
  return "listening_recording";
}

function kindPrefix(kind: CourseSegmentKind): string {
  switch (kind) {
    case "listening_conversation":
      return "listening.conversation";
    case "listening_passage":
      return "listening.passage";
    default:
      return "listening.recording";
  }
}

function kindTitle(kind: CourseSegmentKind): string {
  switch (kind) {
    case "listening_conversation":
      return "听力长对话";
    case "listening_passage":
      return "听力篇章";
    default:
      return "听力录音";
  }
}

// ---------------------------------------------------------------------------
// 翻译
// ---------------------------------------------------------------------------

function segmentTranslation(
  proposal: MaterialGroupingProposal,
  pages: ExtractedPage[],
  parsed: ParsedDocument,
  context: SegmentContext,
): MaterialSegmentation {
  const lines = collectLines(pages, parsed.assetKey);

  // 找"参考译文"标记的位置：它把中文原文与课程英文译文分开。
  const translationMark = lines.findIndex((line) => REFERENCE_TRANSLATION_MARK.test(line.text.trim()));
  const startMark = lines.findIndex((line) => TRANSLATION_START.test(line.text.trim()));
  const start = startMark >= 0 ? startMark : 0;

  // 中文原文 = 从起点到参考译文标记之前
  const sourceSlice = translationMark > start ? lines.slice(start + (startMark >= 0 ? 1 : 0), translationMark) : lines.slice(start);
  const referenceSlice = translationMark >= 0 ? lines.slice(translationMark + 1) : [];

  const sourceText = joinTextLines(sourceSlice.map((line) => line.text));
  const referenceText = referenceSlice.length > 0 ? joinTextLines(referenceSlice.map((line) => line.text)) : null;

  const reviewNotes: string[] = [];
  const anomalies: SourceAnomaly[] = [];

  if (referenceText === null) {
    // 有的翻译讲义只给语言点，不给整段参考译文 —— 这是真实形态，只提醒不阻断
    reviewNotes.push(
      "该翻译材料**没有找到参考译文标记**（参考译文/译文/Reference Translation）。" +
        "有的翻译讲义确实只给语言点，因此这不阻断；但若源件里本有译文，说明标记未被识别，请人工确认。",
    );
  }

  // 中文原文必须是中文。若抽出来的是英文，说明模块提示或标记判断有误。
  const profile = scriptProfile(sourceText);
  if (profile.cjkChars === 0 && sourceText !== "") {
    anomalies.push({
      code: "reference_translation_without_source",
      where: proposal.id,
      detail:
        "该段被标记为翻译，但抽出的正文里**没有中文字符** —— " +
        "翻译段的 text 应是中文原文，因此这个判定很可能是错的。原样上报，不自动改判。",
      evidence: sourceText.slice(0, 120),
    });
    reviewNotes.push("抽出的中文原文里没有中文字符，必须人工确认这段到底是不是翻译材料。");
  }

  const quote = pickStableQuote(pages);
  const fromPage = sourceSlice[0]?.page ?? 1;
  const toPage = sourceSlice[sourceSlice.length - 1]?.page ?? fromPage;

  return {
    materialProposalId: proposal.id,
    moduleHint: proposal.moduleHint,
    segments: [
      {
        id: segmentIdOf(proposal.id, "translation", 1),
        materialProposalId: proposal.id,
        kind: "translation_passage",
        order: 0,
        title: proposal.title,
        representationAssetKey: parsed.assetKey,
        anchor: { pageStart: fromPage, pageEnd: toPage, quote: quote.quote },
        audioAssetKey: null,
        text: sourceText,
        transcript: null,
        // 它是**课程参考译文**，不是唯一正确译法，也不是官方答案。
        referenceTranslation: referenceText,
        notes:
          referenceText === null
            ? null
            : "referenceTranslation 来自源件的课程译文区块。它是**课程材料**，" +
              "不是唯一正确译法，也不是官方答案。",
        evidence: {
          cues: [
            translationMark >= 0
              ? `参考译文标记：${lines[translationMark].text.trim().slice(0, 40)}`
              : "（未找到参考译文标记）",
          ],
          lineSpan: `p${fromPage}–p${toPage}`,
          observedQuestionNumbers: [],
          folderLabelOnly: startMark < 0 && translationMark < 0,
        },
        reviewRequired: reviewNotes.length > 0 || anomalies.length > 0,
        reviewNotes,
        anomalies,
      },
    ],
    documentLevelOnly: true,
    warnings: [
      ...(context.noTextPages.length > 0
        ? [`该材料第 ${context.noTextPages.join("、")} 页没有文本层，不做 OCR。`]
        : []),
      "翻译材料按文档级输出一个段（中文原文 + 课程参考译文）。",
    ],
    anomalies,
  };
}

// ---------------------------------------------------------------------------
// 写作 / 方法
// ---------------------------------------------------------------------------

function segmentWritingOrMethods(
  proposal: MaterialGroupingProposal,
  pages: ExtractedPage[],
  parsed: ParsedDocument,
  context: SegmentContext,
): MaterialSegmentation {
  const text = joinPageText(pages, 1, Number.MAX_SAFE_INTEGER);
  const quote = pickStableQuote(pages);
  const fromPage = pages.find((page) => page.hasTextLayer)?.page ?? 1;
  const toPage = [...pages].reverse().find((page) => page.hasTextLayer)?.page ?? fromPage;

  // 写作 / 方法材料**刻意按文档级输出**：
  // 一份写作思维导图或模板没有"篇章级"边界，硬切只会产出无意义的段。
  const kind: CourseSegmentKind = proposal.moduleHint === "writing" ? "writing_template" : "method_note";

  return {
    materialProposalId: proposal.id,
    moduleHint: proposal.moduleHint,
    segments: [
      {
        id: segmentIdOf(proposal.id, kind === "writing_template" ? "writing" : "method", 1),
        materialProposalId: proposal.id,
        kind,
        order: 0,
        title: proposal.title,
        representationAssetKey: parsed.assetKey,
        anchor: { pageStart: fromPage, pageEnd: toPage, quote: quote.quote },
        audioAssetKey: null,
        text,
        transcript: null,
        referenceTranslation: null,
        notes:
          "该材料按**文档级**输出：写作模板与方法说明本来就没有篇章级边界，" +
          "强行细分只会产生无意义的段。",
        evidence: {
          cues: [`模块提示：${proposal.moduleHint ?? "（无）"}`],
          lineSpan: `p${fromPage}–p${toPage}`,
          observedQuestionNumbers: [],
          folderLabelOnly: false,
        },
        reviewRequired: false,
        reviewNotes: [
          kind === "writing_template"
            ? "写作模板**不要求**匹配任何 canonical 题目 —— 模板知识不对应单道真题。"
            : "方法说明**不要求**匹配任何 canonical 题目。",
        ],
        anomalies: [],
      },
    ],
    documentLevelOnly: true,
    warnings: [
      ...(context.noTextPages.length > 0
        ? [`该材料第 ${context.noTextPages.join("、")} 页没有文本层，不做 OCR。`]
        : []),
    ],
    anomalies: [],
  };
}

// ---------------------------------------------------------------------------
// 无模块提示：由内容自身判定
// ---------------------------------------------------------------------------

function segmentUnknownModule(
  proposal: MaterialGroupingProposal,
  pages: ExtractedPage[],
  parsed: ParsedDocument,
  context: SegmentContext,
  allParsed: ParsedDocument[],
): MaterialSegmentation {
  const lines = collectLines(pages, parsed.assetKey);
  const text = joinPageText(pages, 1, Number.MAX_SAFE_INTEGER);
  const profile = scriptProfile(text);
  const hasQuestions = lines.some((line) => QUESTION_NUMBER.test(line.text.trim()));
  const hasOptions = lines.some((line) => OPTION_LABEL.test(line.text.trim()));
  const hasTranscriptMark = lines.some((line) => TRANSCRIPT_SECTION_MARK.test(line.text.trim()));
  const hasReadingMark = lines.some((line) => READING_PASSAGE_MARKER.test(line.text.trim()));

  // 判据全部落在**内容**上。文件夹名不参与。
  if (hasReadingMark && hasQuestions) {
    return segmentReading(proposal, pages, parsed, context);
  }
  if (hasTranscriptMark || (hasQuestions && hasOptions && lines.length > 40)) {
    // 听力分支需要**全部**可解析文档（套装可能由讲义 + 文字稿两个 PDF 组成）
    return segmentListening(proposal, allParsed, parsed, context);
  }
  if (profile.cjkRatio > 0.5 && !hasQuestions) {
    // 以中文为主且没有题目：很可能是翻译或方法材料
    return segmentTranslation(proposal, pages, parsed, context);
  }

  // 真的判不出来：输出一个 method_note 文档级段，并**明确标记复核**。
  const quote = pickStableQuote(pages);
  return {
    materialProposalId: proposal.id,
    moduleHint: null,
    segments: [
      {
        id: segmentIdOf(proposal.id, "method", 1),
        materialProposalId: proposal.id,
        kind: "method_note",
        order: 0,
        title: proposal.title,
        representationAssetKey: parsed.assetKey,
        anchor: {
          pageStart: pages.find((page) => page.hasTextLayer)?.page ?? 1,
          pageEnd: pages.length,
          quote: quote.quote,
        },
        audioAssetKey: null,
        text,
        transcript: null,
        referenceTranslation: null,
        notes: null,
        evidence: {
          cues: ["（内容里没有识别出任何已登记的结构线索）"],
          lineSpan: `p1–p${pages.length}`,
          observedQuestionNumbers: [],
          folderLabelOnly: false,
        },
        // 判不出模块 ⇒ **必须**人工归类
        reviewRequired: true,
        reviewNotes: [
          "该材料既没有文件夹模块提示，内容里也没有识别出已登记的结构线索" +
            "（篇章标记 / 听力分组 / 翻译标记 / 写作模板）。" +
            "因此按**文档级 method_note** 输出，且必须人工确认它的真实归类 —— " +
            "系统不猜。",
        ],
        anomalies: [
          {
            code: "no_structural_cue",
            where: proposal.id,
            detail: "无法从内容判定模块，按文档级 method_note 输出并标记人工复核。",
            evidence: text.slice(0, 160),
          },
        ],
      },
    ],
    documentLevelOnly: true,
    warnings: [`该材料无法判定模块（无文件夹提示、无内容线索）。`],
    anomalies: [],
  };
}

// ---------------------------------------------------------------------------
// 行级工具
// ---------------------------------------------------------------------------

interface LineRef {
  text: string;
  page: number;
  /** 该行在**本页**内的序号（从 1 开始）。 */
  indexInPage: number;
  /** 全局序号。 */
  index: number;
  /**
   * 该行来自哪个资产。
   *
   * 必须有它：一份听力套装可能由**多个 PDF**（题干讲义 + 文字稿）组成，
   * 而页码只在**某一个表示的页码体系**里成立。若不知道行来自哪个文件，
   * 就会写出"第 2 页"却指向错误的表示 —— 那是一个静默的错误锚点。
   */
  assetKey: string;
}

/**
 * 收集行。
 *
 * `documents` 按传入顺序拼接；**每个文档独立编号**（`indexInPage` 从 1 起），
 * 因此跨文档的段不会被误认为在同一页里连续。
 */
function collectLines(pages: ExtractedPage[], assetKey: string): LineRef[] {
  const out: LineRef[] = [];
  let index = 0;
  for (const page of pages) {
    if (!page.hasTextLayer) continue;
    page.lines.forEach((text, pageIndex) => {
      out.push({ text, page: page.page, indexInPage: pageIndex + 1, index, assetKey });
      index += 1;
    });
  }
  return out;
}

/** 把多个表示的页拼成一条行流（用于"一份材料多个 PDF"的听力套装）。 */
function collectLinesFromDocuments(documents: ParsedDocument[]): LineRef[] {
  const out: LineRef[] = [];
  for (const doc of documents) {
    const lines = collectLines(doc.pages, doc.assetKey);
    // 重新编号全局 index，保证跨文档严格递增
    for (const line of lines) out.push({ ...line, index: out.length });
  }
  return out;
}

/** 一个切片是否全部来自同一个表示（页码锚点只有在这种情况下才成立）。 */
function singleRepresentationOf(slice: LineRef[]): string | null {
  const keys = new Set(slice.map((line) => line.assetKey));
  return keys.size === 1 ? [...keys][0] : null;
}

interface Boundary {
  index: number;
  cue: string;
  title: string | null;
}

/** 按正则找边界。**返回的是候选**，不判断身份。 */
function findBoundaries(lines: LineRef[], pattern: RegExp, kind: "passage" | "listening"): Boundary[] {
  const boundaries: Boundary[] = [];
  for (const [index, line] of lines.entries()) {
    const trimmed = line.text.trim();
    if (trimmed === "") continue;
    if (!pattern.test(trimmed)) continue;
    // 只接受**短行**作为标题式标记：长句里出现 "passage" 不是分段点
    if (trimmed.length > 90) continue;
    boundaries.push({
      index,
      cue: trimmed,
      title: kind === "passage" ? trimmed.slice(0, 60) : trimmed.slice(0, 60),
    });
  }
  return boundaries;
}

/** 观测到的题号（**结构提示**）。 */
function extractQuestionNumbers(lines: LineRef[]): number[] {
  const numbers: number[] = [];
  for (const line of lines) {
    const match = QUESTION_NUMBER.exec(line.text.trim());
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) numbers.push(value);
  }
  return numbers;
}

/**
 * 题号序列缺陷检查。
 *
 * ── 为什么它只产生 anomaly 而**不修正任何东西** ──
 *
 * 源件的编号确实会错（真题流水线实测过重号与跳号）。但"正确的编号是什么"
 * 只有人知道 —— 系统补一个号，就等于伪造了一条源件里不存在的事实。
 * 因此这里只**报告**：原样保留，让人带证据裁决。
 */
function checkQuestionNumberSequence(numbers: number[]): SourceAnomaly[] {
  const out: SourceAnomaly[] = [];
  const seen = new Set<number>();
  for (const [index, number] of numbers.entries()) {
    if (seen.has(number)) {
      out.push({
        code: "question_number_duplicate",
        where: `q${number}`,
        detail: `题号 ${number} 在同一段内出现多次。题号只是结构提示，因此不据此推断身份；缺陷原样保留。`,
        evidence: null,
      });
      continue;
    }
    seen.add(number);
    if (index > 0 && number < numbers[index - 1]) {
      out.push({
        code: "question_number_out_of_order",
        where: `q${number}`,
        detail: `题号 ${numbers[index - 1]} 之后出现更小的 ${number}。源件编号可能乱序或来源不同；**不修正**，原样上报。`,
        evidence: null,
      });
    }
  }
  const sorted = [...seen].sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index += 1) {
    const gap = sorted[index] - sorted[index - 1];
    if (gap > 1 && gap <= 5) {
      out.push({
        code: "question_number_gap",
        where: `q${sorted[index - 1]}–q${sorted[index]}`,
        detail: `题号从 ${sorted[index - 1]} 跳到 ${sorted[index]}（缺 ${gap - 1} 个）。可能源件确实缺题，也可能是编号缺陷；**不补号**。`,
        evidence: null,
      });
    }
  }
  return out;
}

function spansMissingPage(slice: LineRef[], pages: ExtractedPage[]): boolean {
  const from = slice[0].page;
  const to = slice[slice.length - 1].page;
  return pages.some((page) => page.page >= from && page.page <= to && !page.hasTextLayer);
}

/** 为一段挑可核对的引文（必须能在源件里找到 —— 见 pdf-extract 的说明）。 */
function pickQuoteForSlice(pages: ExtractedPage[], slice: LineRef[]): string | null {
  return pickQuoteFromSliceLines(slice, pages);
}

/**
 * 为一段挑可核对引文（**多文档**版本）。
 *
 * 用于听力套装：切片里的行可能来自不同的 PDF，因此必须按行自身的
 * `assetKey` 去找它所属的那份文档，而不能假定"所有行都在同一个文件里"。
 */
function pickQuoteForSliceForSlice(slice: LineRef[], documents: ParsedDocument[]): string | null {
  const candidates = slice
    .map((line) => ({ text: line.text, page: line.page, assetKey: line.assetKey }))
    .filter((entry) => entry.text.trim().length >= 12 && /[\p{L}\p{N}]/u.test(entry.text));

  for (const candidate of candidates) {
    const doc = documents.find((item) => item.assetKey === candidate.assetKey);
    const page = doc?.pages.find((item) => item.page === candidate.page);
    if (!page) continue;
    const quote = candidate.text.trim().slice(0, 120);
    if (page.rawText.includes(quote)) return quote;
    const squeezed = quote.replace(/\s+/g, " ");
    if (page.rawText.replace(/\s+/g, " ").includes(squeezed)) return quote;
  }
  return null;
}

/** 单文档版本的引文挑选。 */
function pickQuoteFromSliceLines(slice: LineRef[], pages: ExtractedPage[]): string | null {
  const candidates = slice
    .map((line) => ({ text: line.text, page: line.page }))
    .filter((entry) => entry.text.trim().length >= 12 && /[\p{L}\p{N}]/u.test(entry.text));

  for (const candidate of candidates) {
    const page = pages.find((item) => item.page === candidate.page);
    if (!page) continue;
    const quote = candidate.text.trim().slice(0, 120);
    // 回源核对：引文必须真的出现在该页文本里
    if (page.rawText.includes(quote)) return quote;
    // 行内空白与源件不一致时退一步核对（空白是 PDF 抽取的伪影）
    const squeezed = quote.replace(/\s+/g, " ");
    if (page.rawText.replace(/\s+/g, " ").includes(squeezed)) return quote;
  }
  return null;
}

// 段的规范摘要由 `digests.ts` 的唯一实现提供（复核时会现场重算同一份）。
export { courseSegmentationDigest as segmentationDigest } from "./digests";
