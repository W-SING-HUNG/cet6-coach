/**
 * canonical CET-6 候选匹配（blocking + explainable evidence scoring）。
 *
 * ── 这个模块只产出一个东西：**建议** ──
 *
 * 它**永不**创建 `verified` 链接，**永不**写数据库，**永不**改任何运行时状态。
 * 高分不是核验，精确指纹不是核验，文件名/套别号/题号更不是。
 *
 * ── 两阶段设计（mature record-linkage 的标准形态）──
 *
 * **STAGE 1 — 分块（blocking）**：只生成**可比的**比较对。
 * 阅读篇章只与规范阅读篇章比；听力长对话只与规范听力长对话比；
 * 写作模板与方法说明**默认不产生任何 canonical 候选**（它们本来就不对应单道真题）。
 * 没有分块，匹配会退化成"每段与全库每道题比"，既慢又会引入大量偶然相似。
 *
 * **STAGE 2 — 可解释的证据打分**：每个候选给出**逐项证据分解**
 * （`MatchEvidence`），每一项都能单独核对。总分只是排序元数据。
 * 刻意**不用** Fellegi-Sunter 的似然比 / 概率：
 * 本项目没有标注数据来校准 `m`/`u` 概率，给出一个"匹配概率 0.87"
 * 会是**看起来可解释、实则不可验证**的数字（PRODUCT_PRINCIPLES 第 2 节）。
 * 因此用确定性的加权证据和，并**同时**把每一项原值暴露出来。
 *
 * ── 明确禁止作为匹配证据的特征 ──
 *
 * 文件名、套别号、课程内物理顺序、裸题号、课程答案、文件夹名。
 * 它们只能出现在 `evidence.contextOnly` 里作展示。
 * 判据由 `tests/course-matching.test.ts` 在**行为层**固定：
 * 构造"文件名/套别号/题号完全相同但内容无关"的夹具，断言它**不产生**候选。
 *
 * ── 歧义 ──
 *
 * 匹配器必须能说：无候选 / 一个强候选 / 多个歧义候选。
 * 前两名过于接近时标记 `ambiguous`，**绝不因为排第一就选中它**。
 *
 * ── 未匹配的语义 ──
 *
 * 未匹配 ≠ 课程材料是伪造/非真题。它只意味着：
 * **当前 canonical 库无法有把握地识别它。**
 */

import { createHash } from "node:crypto";
import { stableStringify } from "@/content/pipeline/fingerprint";
import type { ExamPaperContent, PaperGroup, PaperSection } from "@/content/paper/types";
import { SECTION_LABELS } from "@/domain/paper";
import type { CourseSegmentKind } from "@/domain/course";
import {
  containment,
  hasEnoughSubstance,
  intersectionSize,
  jaccard,
  projectForMatching,
  shingles,
  tokenSet,
} from "./projection";
import {
  MATCHING_ALGORITHM_VERSION,
  MATCHING_PROJECTION_VERSION,
  type CanonicalLibrarySummary,
  type CanonicalTarget,
  type CandidateMatchingResult,
  type MatchEvidence,
  type MatchLabel,
  type MatchSuggestion,
  type ProposedSegment,
  type SegmentMatchResult,
} from "./types";

// ---------------------------------------------------------------------------
// 打分阈值与权重（**全部集中在这里，便于复核者核对**）
// ---------------------------------------------------------------------------

/**
 * 相似度证据的权重。
 *
 * 这些权重**没有被校准过** —— 没有任何标注数据可以校准它们。
 * 因此它们的角色是**排序**，不是概率。汇总时必须连同逐项证据一起给出，
 * 且不得把总分呈现为"匹配概率"。
 */
export const MATCH_WEIGHTS = {
  projectionExact: 0.35,
  bodyContainment: 0.3,
  bodyJaccard: 0.15,
  stemOverlap: 0.1,
  optionOverlap: 0.05,
  structuralConsistency: 0.05,
} as const;

/** 排序标签的分数边界。 */
export const MATCH_LABEL_THRESHOLDS = {
  strong: 0.72,
  possible: 0.45,
  weak: 0.2,
} as const;

/**
 * 前两名分差低于此值即判**歧义**。
 *
 * 为什么必须有一个显式阈值而不是"取第一名"：两份真题的篇章都被同一份讲义
 * 收录是真实情形（课程按题型重组，同一篇文章可能出现在多处），
 * 此时两个候选的分数会非常接近，而"选排第一的那个"会把一次**任意的**
 * 排序抖动变成一条看起来确定的结论。
 */
export const AMBIGUITY_SCORE_GAP = 0.05;

/**
 * 主体文本的最小 shingle 体量。
 *
 * 低于它就不产生"相似度证据"（而不是产生一个无意义的 1.0）。
 * 这条闸门让"极短文本被长文本偶然包含"无法伪装成强证据。
 */
export const MIN_BODY_SHINGLES = 12;

/** 主体文本可用的最小字符数。短于此的正文不参与相似度。 */
export const MIN_BODY_CHARS = 60;

// ---------------------------------------------------------------------------
// canonical 索引（**临时、内存中、只读**）
// ---------------------------------------------------------------------------

/** 一个 canonical 组：真题里的一个题组 + 它所属的大题。 */
export interface CanonicalGroupEntry {
  target: CanonicalTarget;
  sectionType: string;
  sectionId: string;
  groupId: string | null;
  /** 主体文本（阅读篇章 / 文字稿 / 翻译原文）。 */
  body: string;
  bodyShingles: Set<string> | null;
  /** 题干文本（拼接）。 */
  stems: string;
  stemTokens: Set<string> | null;
  /** 选项文本（拼接）。 */
  options: string;
  optionTokens: Set<string> | null;
  /** 该组的题量（结构一致性判据）。 */
  questionCount: number;
  /** 该组的题号集合（**只作上下文展示**）。 */
  questionNumbers: number[];
}

/**
 * canonical CET-6 库的**临时内存索引**。
 *
 * ── 为什么是临时的、不进 SQLite / 不做 FTS ──
 *
 * 1. **正文不落库**是课程层与真题层共同的核心约束。
 *    把篇章正文写进 FTS 表就等于把它落了库，且会引入**第二个真相来源** ——
 *    它会在包在盘上漂移时静默过期。而本流水线每次运行都从磁盘上的
 *    规范化包重建索引，因此**不可能**读到陈旧正文。
 * 2. 规模上：当前 3 份真题、目标上限数十份。全量重建的成本远低于
 *    "维护一个会漂移的索引"的代价。
 * 3. 同一条理由排除 vector DB / embeddings：单用户、数十文档、无标注数据，
 *    引入它们会增加供应链面与不可解释性，却换不到可验证的收益。
 */
export interface CanonicalIndex {
  groups: CanonicalGroupEntry[];
  summary: CanonicalLibrarySummary;
}

/**
 * 从**磁盘上的规范化真题包**构建临时索引。
 *
 * 调用方负责读取包（见 `canonical.ts`）—— 本模块不碰文件系统，
 * 因此它无法被用来读取任意路径，也无法写任何东西。
 *
 * `readFailures` 是**读不出来的**真题包。它被纳入摘要（见
 * `canonicalLibraryDigest`），因此"库从不完整变成完整"会改变库摘要 ⇒
 * 旧复核自动陈旧。它也让人能判断"这个建议是否来自一个不完整的库"。
 */
export function buildCanonicalIndex(
  papers: { paperId: string; content: ExamPaperContent; checksum: string }[],
  readFailures: { packagePath: string; reason: string }[] = [],
): CanonicalIndex {
  const groups: CanonicalGroupEntry[] = [];
  const paperSummaries: CanonicalLibrarySummary["papers"] = [];

  for (const paper of [...papers].sort((a, b) => a.paperId.localeCompare(b.paperId))) {
    let targetCount = 0;
    for (const section of paper.content.sections) {
      for (const group of section.groups) {
        targetCount += 1;
        groups.push(buildGroupEntry(paper.paperId, paper.content.contentVersion, section, group));
      }
    }
    paperSummaries.push({
      paperId: paper.paperId,
      contentVersion: paper.content.contentVersion,
      manifestChecksum: paper.checksum,
      targetCount,
    });
  }

  const failures = [...readFailures].sort((a, b) => a.packagePath.localeCompare(b.packagePath));

  return {
    groups,
    summary: {
      digest: canonicalLibraryDigest(paperSummaries, failures),
      papers: paperSummaries,
      readFailures: failures,
      source: "磁盘上的规范化真题包（private-content/cet6/papers）—— 只读，正文不入库、不入 FTS",
    },
  };
}

/** 库快照是否**完整**（没有读不出来的包）。 */
export function isCanonicalLibraryComplete(summary: CanonicalLibrarySummary): boolean {
  return summary.readFailures.length === 0;
}

function buildGroupEntry(
  paperId: string,
  paperContentVersion: number,
  section: PaperSection,
  group: PaperGroup,
): CanonicalGroupEntry {
  const body = canonicalGroupBody(section, group);
  const stems = group.questions
    .map((question) => {
      if (question.kind === "mcq") return question.stem;
      if (question.kind === "matching_statement") return question.statement;
      if (question.kind === "writing") return question.prompt;
      if (question.kind === "translation") return question.sourceText;
      return "";
    })
    .filter((text) => text !== "")
    .join("\n");

  const options = group.questions
    .flatMap((question) => (question.kind === "mcq" ? question.options.map((option) => option.label) : []))
    .join("\n");

  const questionNumbers = group.questions
    .map((question) => question.number)
    .filter((number): number is number => number !== null);

  return {
    target: {
      paperId,
      paperContentVersion,
      sectionId: section.id,
      sectionType: section.type,
      groupId: group.id,
      questionId: null,
      label: `${paperId} · ${SECTION_LABELS[section.type] ?? section.type} · ${group.id}`,
    },
    sectionType: section.type,
    sectionId: section.id,
    groupId: group.id,
    body,
    bodyShingles: hasEnoughSubstance(body) && body.length >= MIN_BODY_CHARS ? shingles(body) : null,
    stems,
    stemTokens: stems === "" ? null : tokenSet(stems),
    options,
    optionTokens: options === "" ? null : tokenSet(options),
    questionCount: group.questions.length,
    questionNumbers,
  };
}

/** 取一个题组的"主体文本"—— 按题型取对应的那一个字段。 */
export function canonicalGroupBody(section: PaperSection, group: PaperGroup): string {
  if (section.type === "reading.banked_cloze") return group.passage ?? "";
  if (section.type === "reading.matching") {
    const paragraphs = (group.paragraphs ?? []).map((paragraph) => paragraph.text).join("\n");
    return [group.instructions ?? "", paragraphs].filter((text) => text !== "").join("\n");
  }
  if (section.type === "reading.careful_reading") return group.passage ?? "";
  if (section.type.startsWith("listening.")) return group.transcript ?? "";
  if (section.type === "translation") {
    const question = group.questions.find((item) => item.kind === "translation");
    return question && question.kind === "translation" ? question.sourceText : "";
  }
  if (section.type === "writing") {
    const question = group.questions.find((item) => item.kind === "writing");
    return question && question.kind === "writing" ? question.prompt : "";
  }
  return "";
}

/**
 * canonical 库快照摘要：库一变它就变，从而让"旧分数套新库"可见。
 *
 * **`readFailures` 必须参与摘要。** 否则"少读到一份卷"这件事对摘要不可见：
 * 库从不完整变成完整（或反之）时摘要不变，旧复核会静默沿用 ——
 * 而两者的可比内容范围是不同的。
 */
export function canonicalLibraryDigest(
  papers: CanonicalLibrarySummary["papers"],
  readFailures: CanonicalLibrarySummary["readFailures"] = [],
): string {
  const canonical = [
    [...papers]
      .sort((a, b) => a.paperId.localeCompare(b.paperId))
      .map((paper) => `${paper.paperId}\t${paper.contentVersion}\t${paper.manifestChecksum}\t${paper.targetCount}`)
      .join("\n"),
    // 读失败单独一段，避免与包行混淆
    [...readFailures]
      .sort((a, b) => a.packagePath.localeCompare(b.packagePath))
      .map((failure) => `!${failure.packagePath}\t${failure.reason}`)
      .join("\n"),
  ].join("\n--\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// STAGE 1 — 分块
// ---------------------------------------------------------------------------

/**
 * 段的种类 → 允许比较的 canonical 大题类型。
 *
 * `null` 表示**默认不做 canonical 匹配**（写作模板 / 方法说明）。
 * 这不是"暂时没实现"，而是**正确的产品语义**：
 * 模板知识与方法说明本来就不对应单道真题，强行匹配会产出噪音。
 */
export const ALLOWED_SECTION_TYPES: Record<CourseSegmentKind, string[] | null> = {
  reading_passage: ["reading.careful_reading", "reading.matching", "reading.banked_cloze"],
  listening_conversation: ["listening.long_conversation"],
  listening_passage: ["listening.passage"],
  // 录音/讲座与"讲话/报道/讲座"大类比较；对话与篇章都不是它的可比对象
  listening_recording: ["listening.talk_report_lecture"],
  translation_passage: ["translation"],
  writing_template: null,
  method_note: null,
};

/** 段的种类 → 段侧"主体文本"。 */
function segmentBody(segment: ProposedSegment): string {
  if (segment.kind.startsWith("listening_")) return segment.transcript ?? "";
  if (segment.kind === "translation_passage") return segment.text ?? "";
  return segment.text ?? "";
}

/** 段的种类 → 段侧"题干文本"（题面行）。 */
function segmentStems(segment: ProposedSegment): string {
  const source = segment.text ?? segment.transcript ?? "";
  return source
    .split("\n")
    .filter((line) => /^\d{1,3}\s*[.．、)）]\s*\S/.test(line.trim()))
    .join("\n");
}

/** 段的种类 → 段侧"选项文本"。 */
function segmentOptions(segment: ProposedSegment): string {
  const source = segment.text ?? segment.transcript ?? "";
  return source
    .split("\n")
    .filter((line) => /^[A-O]\s*[.)、）]\s*\S/.test(line.trim()))
    .join("\n");
}

// ---------------------------------------------------------------------------
// STAGE 2 — 证据打分
// ---------------------------------------------------------------------------

/** 计算单个 (段, canonical 组) 对的逐项证据。 */
function scorePair(
  segment: ProposedSegment,
  segmentBodyText: string,
  segmentStemText: string,
  segmentOptionText: string,
  candidate: CanonicalGroupEntry,
): MatchEvidence {
  const segmentProjection = projectForMatching(segmentBodyText);
  const canonicalProjection = projectForMatching(candidate.body);
  const projectionExact =
    segmentProjection !== "" && canonicalProjection !== "" && segmentProjection === canonicalProjection;

  // ---- 主体文本相似度 ----
  let bodyContainmentValue = 0;
  let bodyJaccardValue = 0;
  const canCompareBodies =
    segmentBodyText.length >= MIN_BODY_CHARS &&
    candidate.body.length >= MIN_BODY_CHARS &&
    candidate.bodyShingles !== null &&
    hasEnoughSubstance(segmentBodyText);

  if (canCompareBodies) {
    const segmentShingles = shingles(segmentBodyText);
    if (segmentShingles.size >= MIN_BODY_SHINGLES) {
      const shared = intersectionSize(segmentShingles, candidate.bodyShingles!);
      // 绝对体量闸门：比例再高，只共享两三个 shingle 也不算证据
      if (shared >= MIN_BODY_SHINGLES) {
        bodyContainmentValue = containment(segmentShingles, candidate.bodyShingles!);
        bodyJaccardValue = jaccard(segmentShingles, candidate.bodyShingles!);
      }
    }
  }

  // ---- 题干 / 选项重叠 ----
  let stemOverlap: number | null = null;
  let optionOverlap: number | null = null;

  const segmentStemTokens = segmentStemText === "" ? null : tokenSet(segmentStemText);
  if (segmentStemTokens !== null && candidate.stemTokens !== null && segmentStemTokens.size >= 4) {
    stemOverlap = containment(segmentStemTokens, candidate.stemTokens);
  }

  const segmentOptionTokens = segmentOptionText === "" ? null : tokenSet(segmentOptionText);
  if (segmentOptionTokens !== null && candidate.optionTokens !== null && segmentOptionTokens.size >= 8) {
    optionOverlap = containment(segmentOptionTokens, candidate.optionTokens);
  }

  // ---- 结构一致性 ----
  const observedNumbers = segment.evidence.observedQuestionNumbers;
  const structuralConsistency = structuralScore(observedNumbers, candidate);

  return {
    projectionExact,
    bodyContainment: round4(bodyContainmentValue),
    bodyJaccard: round4(bodyJaccardValue),
    stemOverlap: stemOverlap === null ? null : round4(stemOverlap),
    optionOverlap: optionOverlap === null ? null : round4(optionOverlap),
    structuralConsistency: round4(structuralConsistency),
    contextOnly: {
      courseFileName: null,
      courseSetLabel: null,
      observedQuestionNumbers: [...observedNumbers].sort((a, b) => a - b),
      canonicalQuestionNumbers: [...candidate.questionNumbers].sort((a, b) => a - b),
      courseAnswerKey: null,
      notes: [
        "下列线索**不参与打分**，只作上下文展示：文件名、套别号、课程内物理顺序、" +
          "裸题号、课程答案。它们都不是身份证明。",
      ],
    },
  };
}

/**
 * 结构一致性（0–1）。
 *
 * ── 为什么题号**不能**直接当判据 ──
 *
 * 源件编号会错（重号/跳号/乱序）。因此这里**不比对具体题号**，
 * 只比对**结构的形状**：
 * - 段内观测到的题号个数与 canonical 组的题量是否吻合；
 * - 题号区间与 canonical 组的题号区间**是否重叠**（重叠只作为弱证据）。
 *
 * 例如"课程里这段有 5 道题、规范仔细阅读组也是 5 道题"是结构证据；
 * 而"课程里写的是 46–50、规范里也是 46–50"**不是**身份证明 ——
 * 一份错编号的源件会给出完全相同的数字。
 */
function structuralScore(observedNumbers: number[], candidate: CanonicalGroupEntry): number {
  if (observedNumbers.length === 0 || candidate.questionCount === 0) return 0;

  // 1) 题量吻合度
  const countRatio =
    observedNumbers.length === candidate.questionCount
      ? 1
      : 1 - Math.abs(observedNumbers.length - candidate.questionCount) / Math.max(observedNumbers.length, candidate.questionCount);

  // 2) 题号区间重叠度（**弱证据**，权重已很低）
  let rangeOverlap = 0;
  if (candidate.questionNumbers.length > 0) {
    const observedMin = Math.min(...observedNumbers);
    const observedMax = Math.max(...observedNumbers);
    const canonicalMin = Math.min(...candidate.questionNumbers);
    const canonicalMax = Math.max(...candidate.questionNumbers);
    const overlap = Math.min(observedMax, canonicalMax) - Math.max(observedMin, canonicalMin) + 1;
    const union = Math.max(observedMax, canonicalMax) - Math.min(observedMin, canonicalMin) + 1;
    rangeOverlap = union > 0 ? Math.max(0, overlap) / union : 0;
  }

  // 题量权重更高：区间重叠会被错误的编号轻易伪造，题量则不会
  return Math.max(0, countRatio) * 0.7 + rangeOverlap * 0.3;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** 由逐项证据算加权总分（**只是排序元数据**）。 */
export function scoreOf(evidence: MatchEvidence): number {
  let total = 0;
  let weightSum = 0;

  total += (evidence.projectionExact ? 1 : 0) * MATCH_WEIGHTS.projectionExact;
  weightSum += MATCH_WEIGHTS.projectionExact;

  total += evidence.bodyContainment * MATCH_WEIGHTS.bodyContainment;
  weightSum += MATCH_WEIGHTS.bodyContainment;

  total += evidence.bodyJaccard * MATCH_WEIGHTS.bodyJaccard;
  weightSum += MATCH_WEIGHTS.bodyJaccard;

  if (evidence.stemOverlap !== null) {
    total += evidence.stemOverlap * MATCH_WEIGHTS.stemOverlap;
    weightSum += MATCH_WEIGHTS.stemOverlap;
  }
  if (evidence.optionOverlap !== null) {
    total += evidence.optionOverlap * MATCH_WEIGHTS.optionOverlap;
    weightSum += MATCH_WEIGHTS.optionOverlap;
  }

  total += evidence.structuralConsistency * MATCH_WEIGHTS.structuralConsistency;
  weightSum += MATCH_WEIGHTS.structuralConsistency;

  return weightSum === 0 ? 0 : round4(total / weightSum);
}

export function labelFor(score: number): MatchLabel {
  if (score >= MATCH_LABEL_THRESHOLDS.strong) return "strong_candidate";
  if (score >= MATCH_LABEL_THRESHOLDS.possible) return "possible_candidate";
  if (score >= MATCH_LABEL_THRESHOLDS.weak) return "weak_candidate";
  return "no_candidate";
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** 匹配上下文里的**非内容**线索（只作展示，不参与打分）。 */
export interface MatchContext {
  /** 课程文件名（展示用，**不参与打分**）。 */
  courseFileName: string | null;
  /** 课程侧自称的套别标签（展示用，**不参与打分**）。 */
  courseSetLabel: string | null;
  /** 课程侧答案（SOURCE ASSERTION，展示用，**不参与打分**）。 */
  courseAnswerKey: string | null;
}

/**
 * 对一批候选段做 canonical 匹配。
 *
 * **不写任何东西**：没有数据库调用、没有文件写入、没有远程请求。
 */
export function matchSegments(
  segments: ProposedSegment[],
  index: CanonicalIndex,
  context: MatchContext = { courseFileName: null, courseSetLabel: null, courseAnswerKey: null },
): CandidateMatchingResult {
  const results = segments
    .map((segment) => matchOne(segment, index, context))
    .sort((a, b) => a.segmentId.localeCompare(b.segmentId));

  return {
    algorithmVersion: MATCHING_ALGORITHM_VERSION,
    projectionVersion: MATCHING_PROJECTION_VERSION,
    canonicalLibrary: index.summary,
    segments: results,
  };
}

function matchOne(
  segment: ProposedSegment,
  index: CanonicalIndex,
  context: MatchContext,
): SegmentMatchResult {
  const allowed = ALLOWED_SECTION_TYPES[segment.kind];

  // ── 分块（STAGE 1）──
  if (allowed === null) {
    return {
      segmentId: segment.id,
      segmentKind: segment.kind,
      blocking: {
        candidatesConsidered: 0,
        description:
          `${segment.kind} **默认不参与 canonical 匹配**：写作模板与方法说明本来就不对应单道真题。` +
          `这是正确的产品语义，不是能力缺失。`,
      },
      suggestions: [],
      label: "no_candidate",
      ambiguous: false,
      ambiguityNote: null,
      unmatchedNote:
        "该段按设计不参与 canonical 匹配。它在课程层是完全合法的内容，且**不需要**任何链接。",
    };
  }

  const candidates = index.groups.filter((entry) => allowed.includes(entry.sectionType));

  if (candidates.length === 0) {
    return {
      segmentId: segment.id,
      segmentKind: segment.kind,
      blocking: {
        candidatesConsidered: 0,
        description:
          `当前 canonical 库里没有任何可比的大题（允许的类型：${allowed.join(" / ")}）。` +
          `候选数 0，因此不产生建议。`,
      },
      suggestions: [],
      label: "no_candidate",
      ambiguous: false,
      ambiguityNote: null,
      unmatchedNote:
        "当前 canonical 库（私有真题包）里没有可比的大题，因此无法识别这段材料。**未匹配是合法状态** —— " +
        "它**不**意味着这段材料是伪造的或不是真题材料，只意味着现有库无法有把握地识别它。",
    };
  }

  // ── 证据打分（STAGE 2）──
  const bodyText = segmentBody(segment);
  const stemText = segmentStems(segment);
  const optionText = segmentOptions(segment);

  const scored: MatchSuggestion[] = candidates
    .map((candidate) => {
      const evidence = scorePair(segment, bodyText, stemText, optionText, candidate);
      // 只作展示的非内容线索（**不参与打分**）
      evidence.contextOnly.courseFileName = context.courseFileName;
      evidence.contextOnly.courseSetLabel = context.courseSetLabel;
      evidence.contextOnly.courseAnswerKey = context.courseAnswerKey;
      return { target: candidate.target, score: scoreOf(evidence), label: "no_candidate" as MatchLabel, evidence };
    })
    .filter((suggestion) => suggestion.score > 0)
    .sort((a, b) => b.score - a.score || a.target.label.localeCompare(b.target.label));

  const top = scored.slice(0, 5).map((suggestion) => ({ ...suggestion, label: labelFor(suggestion.score) }));

  if (top.length === 0) {
    return {
      segmentId: segment.id,
      segmentKind: segment.kind,
      blocking: {
        candidatesConsidered: candidates.length,
        description: `${candidates.length} 个可比大题全部被评估，没有任何一个产生非零证据。`,
      },
      suggestions: [],
      label: "no_candidate",
      ambiguous: false,
      ambiguityNote: null,
      unmatchedNote:
        "在可比范围内没有任何内容证据支持某个 canonical 目标。**未匹配是合法状态** —— " +
        "它意味着当前 canonical 库无法有把握地识别这段材料，而不是「这段材料是假的」。",
    };
  }

  // ── 歧义判定 ──
  //
  // 前两名过于接近 ⇒ 标记歧义。**不得因为排第一就选中它。**
  const ambiguous =
    top.length >= 2 && top[0].score - top[1].score < AMBIGUITY_SCORE_GAP && top[1].score > MATCH_LABEL_THRESHOLDS.weak;

  const ambiguityNote = ambiguous
    ? `前两名候选的分数过于接近（${top[0].score} vs ${top[1].score}，差 ${round4(top[0].score - top[1].score)} < ${AMBIGUITY_SCORE_GAP}）。` +
      `**不得**因为排名第一就选定它 —— 必须人工裁决，或标记为有意不匹配。` +
      `这在课程材料里是真实情形：同一篇真题文章可能被同一份讲义在不同位置收录多次。`
    : null;

  return {
    segmentId: segment.id,
    segmentKind: segment.kind,
    blocking: {
      candidatesConsidered: candidates.length,
      description:
        `只与 ${allowed.join(" / ")} 这几类可比大题比较（分块），共 ${candidates.length} 个候选。` +
        `文件名 / 套别号 / 物理顺序 / 裸题号 / 课程答案**都未参与打分**。`,
    },
    suggestions: top,
    label: top[0].label,
    ambiguous,
    ambiguityNote,
    unmatchedNote: null,
  };
}

/** 匹配结果的规范摘要（用于候选校验和）。**包含 canonical 库摘要**。 */
export function matchingDigest(result: CandidateMatchingResult): string {
  const canonical = {
    algorithmVersion: result.algorithmVersion,
    projectionVersion: result.projectionVersion,
    canonicalLibraryDigest: result.canonicalLibrary.digest,
    segments: [...result.segments]
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
