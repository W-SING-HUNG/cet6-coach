/**
 * 课程导入与匹配流水线（Course Intake & Matching Pipeline）的类型层。
 *
 * ── 这条流水线在整个产品里的位置 ──
 *
 *   私有原始课程目录 → 资产清点 + 校验和 → PDF 抽取 → 逻辑材料提案
 *     → 课程段候选抽取 → canonical CET-6 候选匹配 → 候选包 + 证据报告
 *     → **人工复核（绑定候选校验和）** → 晋升到 courses/ → 既有 course:import
 *     → 既有 course:link（人工核验，另一条命令）
 *
 * ── 本文件要守住的那条边界（与课程层 Foundation 完全一致）──
 *
 * **机器匹配只产生建议，永远不产生 `verified` canonical 链接。**
 *
 * 高分、精确指纹、文件名、套别号、题号，**没有一个是人工核验**。
 * 因此本流水线里：
 *
 * - 不存在任何"自动建立 verified 链接"的代码路径；
 * - 复核文件里的 `accepted_suggestion` **不是**运行时的 `verified` 链接，
 *   它只表示"这条候选映射已准备好让人显式建链"；
 * - `TEXT_EXTRACTION_DEFERRED`（DOCX）与"无文本层"都是**如实状态**，
 *   不是错误，也绝不用 OCR / 远程 AI / 幻觉补全。
 *
 * ── 三层文本必须分开（不得混为一谈）──
 *
 * 1. **原始页文本**（`rawText`）：源件字节的忠实投影，永不改写。
 * 2. **课程内容文本**（`course.json` 里的 `text`）：只做保守的排版归一
 *    （断行连字符、空白折叠、段落重建），**不改词**。
 * 3. **匹配投影**（`projection.ts`）：NFKC、大小写折叠、连字符拆除、空白折叠 ——
 *    只用于相似度计算，**不是**课程内容，也永不落进 `course.json`。
 */

import type { CourseSegmentKind } from "@/domain/course";

// ---------------------------------------------------------------------------
// 流水线版本
// ---------------------------------------------------------------------------

/** 候选包结构/判据版本。含义变化时必须递增，否则历史候选会被重新解释。 */
export const COURSE_PIPELINE_VERSION = 1;

/**
 * 匹配投影算法版本。
 *
 * 独立于 `COURSE_PIPELINE_VERSION`：投影一改，所有相似度分数与指纹的含义就变了，
 * 因此候选里必须记下"这份分数是哪个投影算出来的"。
 */
export const MATCHING_PROJECTION_VERSION = 1;

/** 匹配打分算法版本（权重与判据）。 */
export const MATCHING_ALGORITHM_VERSION = 1;

// ---------------------------------------------------------------------------
// 资产清点
// ---------------------------------------------------------------------------

/**
 * 源资产的种类。
 *
 * `unsupported` 是一个**合法**值而不是异常：私有课程目录里完全可能有压缩包、
 * 字幕、Excel 之类的东西。它们必须被如实登记并说明"本版本不解析"，
 * 而不是被静默跳过 —— 静默跳过会让"清点"这件事本身不可信。
 */
export const SOURCE_ASSET_KINDS = ["pdf", "docx", "audio", "image", "unsupported"] as const;
export type SourceAssetKind = (typeof SOURCE_ASSET_KINDS)[number];

/**
 * 文本抽取状态。
 *
 * 这张表是本流水线诚实性的核心：**每一种"没抽到文本"都必须有名字**，
 * 且每一种的处置不同。
 */
export const TEXT_EXTRACTION_STATES = [
  /** PDF：成功抽到文本层。 */
  "parsed",
  /** PDF：能打开，但（至少一页）没有文本层。**不做 OCR**，如实上报。 */
  "no_text_layer",
  /**
   * DOCX 等文档：**V1 刻意不解析**。已登记为资产/表示，但绝不假装抽到了文本。
   * 这就是任务要求的 `TEXT_EXTRACTION_DEFERRED`。
   */
  "deferred",
  /** 音频 / 图片：没有"文本层"这个概念。 */
  "not_applicable",
  /** 抽取抛错（文件损坏、非 PDF 字节等）。原样记录错误信息。 */
  "failed",
] as const;
export type TextExtractionState = (typeof TEXT_EXTRACTION_STATES)[number];

/** DOCX 未解析时对外输出的稳定标记（任务显式要求的措辞）。 */
export const TEXT_EXTRACTION_DEFERRED = "TEXT_EXTRACTION_DEFERRED";

/** 源目录里的一个文件。**相对定位符是唯一被持久化的位置信息。** */
export interface SourceAsset {
  /**
   * 稳定、确定性的资产键。
   *
   * 由相对路径推导（可读 slug + 路径哈希后缀），因此同一份目录重复清点
   * 得到同一批键 —— 候选校验和才能是稳定的。
   */
  assetKey: string;
  /** 相对于**被清点的源根**的 POSIX 路径。绝不写绝对路径。 */
  relativePath: string;
  basename: string;
  /** 去掉扩展名后的名字（原样大小写，未归一）。 */
  stem: string;
  /** 小写扩展名（含点）。无扩展名时为空字符串。 */
  extension: string;
  kind: SourceAssetKind;
  /** 本版本是否解析其内容。`unsupported` / `deferred` / `image` / `audio` 为 false。 */
  contentParsed: boolean;
  bytes: number;
  sha256: string;
  /**
   * 候选模块提示（来自**文件夹标签**）。
   *
   * 它**不是** canonical CET-6 身份证据，也**不是**内容证据 ——
   * 只用于排序与"先看哪一族结构线索"。判据必须始终落在内容上。
   */
  moduleHint: CourseModuleHint | null;
  /** 得出 moduleHint 的依据（命中的文件夹标签原文），供审计。 */
  moduleHintBasis: string | null;
  /** 所在目录的相对路径（源根为空目录时为 null）。 */
  folderContext: string | null;
  /** 路径上每一级目录名（供复核者理解课程是怎么分文件夹的）。 */
  folderLabels: string[];
}

/** 由文件夹标签推出的**候选**模块提示。不是身份。 */
export const COURSE_MODULE_HINTS = ["reading", "listening", "translation", "writing", "methods"] as const;
export type CourseModuleHint = (typeof COURSE_MODULE_HINTS)[number];

/** 同名/同内容等需要复核者知道的事实。 */
export interface SourceInventoryNote {
  code: "duplicate_content" | "same_name_different_bytes" | "unsupported_type" | "empty_file";
  /** 涉及的资产键。 */
  assetKeys: string[];
  detail: string;
}

/** 一次源目录清点的完整结果。 */
export interface SourceInventory {
  /** 源根的可读标签（**只有目录名**，不含任何绝对路径）。 */
  sourceRootLabel: string;
  scannedAt: string;
  assets: SourceAsset[];
  notes: SourceInventoryNote[];
  /** 被拒绝的路径（不安全 / 逃逸 / 非常规文件），必须可见。 */
  rejected: { relativePath: string; reason: string }[];
  /**
   * 清点摘要的规范摘要值：排序后的 (relativePath, bytes, sha256) 的 sha256。
   *
   * 源字节一变它就变 —— 这是"源已漂移 ⇒ 候选陈旧"的判据。
   */
  digest: string;
  /**
   * **源位置定位符** —— 用于在复核/晋升时**重新清点当前源**以证明源未漂移。
   *
   * ── 为什么它不是绝对路径 ──
   *
 * 绝对路径绝不落盘。因此定位符只有两种形态：
   *
   * - `standard`：源位于标准私有树 `private-content/course-sources/<id>/` 之下。
   *   `locator` 是相对该树的**安全相对路径**（经 `normalizeRelativePath` 校验）。
   * - `external`：抽取时用了任意的 `--source-root`。
   *   此时**不记录任何位置**，`locator` 为 null，
   *   并要求复核者在需要证明源新鲜度时**再次提供** `--source-root`。
   *
   * 这样"源当前性"可以被证明，而磁盘布局细节不会进入候选文件。
   */
  sourceLocator: SourceLocator;
}

/** 源位置定位符（**永远不含绝对路径**）。 */
export type SourceLocator =
  | {
      kind: "standard";
      /**
       * 相对 `private-content/course-sources/` 的安全相对路径。
       * 例如 `rsvp-2026h2` 或 `rsvp-2026h2/阅读`。
       */
      locator: string;
    }
  | {
      kind: "external";
      /**
       * 外部源根：**刻意不记录位置**。
       *
       * 保留 `label` 只是为了让人在日志里认出是哪个目录 ——
       * 它**只有目录名**，不含任何上级路径。
       */
      label: string;
      locator: null;
    };

/** 源当前性的三种如实状态（复核预演必须报告它）。 */
export const SOURCE_CURRENTNESS_STATES = [
  /** 重新清点后与候选记录的摘要一致。 */
  "current",
  /** 重新清点后不一致 ⇒ 源已漂移。 */
  "drifted",
  /** 无法定位源根（缺 `--source-root`、目录不存在、或外部源未提供）。 */
  "unavailable",
] as const;
export type SourceCurrentnessState = (typeof SOURCE_CURRENTNESS_STATES)[number];

export interface SourceCurrentness {
  state: SourceCurrentnessState;
  /** 候选记录的源摘要。 */
  recordedDigest: string;
  /** 重新清点得到的源摘要；不可用时为 null。 */
  currentDigest: string | null;
  /** 源根标签（只有目录名）；不可用时为 null。 */
  sourceRootLabel: string | null;
  /** 变化的资产（人可读，最多若干条）。 */
  changedAssets: string[];
  /** 可读说明 —— 必须同时给出"为什么"与"怎么办"。 */
  detail: string;
  /** 定位符来源：标准树 / 外部显式提供。 */
  locatorKind: SourceLocator["kind"] | null;
}

// ---------------------------------------------------------------------------
// PDF 逐页抽取
// ---------------------------------------------------------------------------

/** 一页的文本（三层里最底层的那一层：**原样保留**）。 */
export interface ExtractedPage {
  page: number;
  /** 这页是否有可用文本层。`false` ⇒ 必须进入人工复核，**不 OCR**。 */
  hasTextLayer: boolean;
  /** 视觉行原文，按阅读顺序。**永不改写。** */
  lines: string[];
  /** 行以 `\n` 连接。保留原样（含行内多余空白）。 */
  rawText: string;
  /** 重建段落后的文本（块间以空行分隔）。仅做排版归一，不改词。 */
  paragraphText: string;
  /** 页内行间距中位数（pt）。用于段落边界判据，供复核者核查。 */
  medianLineGap: number | null;
}

/** 一个文档资产的解析产物。 */
export interface ParsedDocument {
  assetKey: string;
  state: TextExtractionState;
  pages: ExtractedPage[];
  /** 抽取工具与版本（审计需要，否则"同一份 PDF 抽出不同文本"无法解释）。 */
  tool: { name: string; version: string; license: string } | null;
  /** 无文本层的页码（从 1 开始）。 */
  pagesWithoutTextLayer: number[];
  /** 非致命提醒。 */
  warnings: string[];
  /** 抽取失败时的原始错误信息。 */
  error: string | null;
  /**
   * 对 `deferred` 状态的稳定标记（`TEXT_EXTRACTION_DEFERRED`）。
   * 其余状态为 null。
   */
  deferredMarker: string | null;
}

// ---------------------------------------------------------------------------
// 逻辑材料分组（文件 ≠ 逻辑材料）
// ---------------------------------------------------------------------------

/** 一份逻辑材料的一种表示（一个具体文件）。 */
export interface ProposedRepresentation {
  assetKey: string;
  /** 相对源根的路径（审计用，不是包内路径）。 */
  sourceRelativePath: string;
  kind: SourceAssetKind;
  /** 人可读的形态标签，例如 "PDF 版" / "DOCX 版" / "音频"。 */
  label: string;
}

/**
 * 一份逻辑材料的提案。
 *
 * 硬规则：**一个文件不得静默变成两份逻辑材料，一份材料也不得静默吞掉无关文件。**
 * 分组必须把依据写在 `basis` 里，歧义必须 `reviewRequired`。
 */
export interface MaterialGroupingProposal {
  /** 稳定的提案 id（确定性推导，同一输入重复运行得到同一个值）。 */
  id: string;
  title: string;
  /** 归一化后的 stem（分组依据）。 */
  normalizedStem: string;
  /** 文件夹上下文（不同目录**不合并**）。 */
  folderContext: string | null;
  moduleHint: CourseModuleHint | null;
  representations: ProposedRepresentation[];
  /** 分组依据的人可读说明（每条都是一条证据，不是一个结论）。 */
  basis: string[];
  /** 机器把这份提案送上来的**证据字段**（供复核者核对，不是判定）。 */
  evidence: {
    sameNormalizedStem: boolean;
    sameFolderContext: boolean;
    /** 表示覆盖了哪些资产种类（例如 ["pdf","docx"]）。 */
    kinds: SourceAssetKind[];
    /**
     * 同一份材料的两种表示是否**内容可比对**（此版本只有 PDF 可解析）。
     * 为 false 时"它们是同一份内容"纯属**提案**，必须人工确认。
     */
    contentComparable: boolean;
    /** 可比对时，两侧文本的包含度（0–1）；不可比对时为 null。 */
    textContainment: number | null;
  };
  /** 歧义 ⇒ 必须人工裁决，且晋升门禁会拦住它。 */
  ambiguous: boolean;
  ambiguityReason: string | null;
  reviewRequired: boolean;
  /** 需要复核的事项（人可读）。 */
  reviewNotes: string[];
}

/** 分组结果 + 不变量核对。 */
export interface MaterialGroupingResult {
  proposals: MaterialGroupingProposal[];
  /** 每个资产键恰好属于一份提案 —— 这是不变量，违反即视为流水线缺陷。 */
  invariantViolations: string[];
  warnings: string[];
}

// ---------------------------------------------------------------------------
// 课程段候选抽取
// ---------------------------------------------------------------------------

/** 抽取过程中识别出的源件异常（**原样保留，不静默修正**）。 */
export interface SourceAnomaly {
  code:
    | "question_number_out_of_order"
    | "question_number_duplicate"
    | "question_number_gap"
    | "answer_marker_without_questions"
    | "reference_translation_without_source"
    | "no_structural_cue"
    | "quote_not_found_in_source"
    | "audio_without_transcript";
  where: string;
  detail: string;
  /** 支持该判定的源件原文片段。 */
  evidence: string | null;
}

/** 一条候选课程段（尚未进入 course.json 的形态）。 */
export interface ProposedSegment {
  id: string;
  materialProposalId: string;
  kind: CourseSegmentKind;
  order: number;
  title: string;
  /** 段锚定的表示 assetKey（页码锚点必须声明它）。 */
  representationAssetKey: string | null;
  anchor: {
    pageStart: number | null;
    pageEnd: number | null;
    quote: string | null;
  };
  /** 听力：整段音频资产键。**不切分、不重编码、不推断时间区间。** */
  audioAssetKey: string | null;
  /** 课程内容正文（只做排版归一）。 */
  text: string | null;
  transcript: string | null;
  referenceTranslation: string | null;
  notes: string | null;
  /**
   * 抽取出这一段时使用的判据（每条都是可核对的证据）。
   * 复核者据此判断"机器凭什么认为这是一段"。
   */
  evidence: {
    /** 命中的结构线索原文。 */
    cues: string[];
    /** 该段覆盖的源件行区间（人可读，例如 `p3:12–p4:8`）。 */
    lineSpan: string | null;
    /** 观测到的题号（**结构提示，不是身份证明**）。 */
    observedQuestionNumbers: number[];
    /** 判据是否只来自文件夹标签而没有内容线索。 */
    folderLabelOnly: boolean;
  };
  /** 需要人工确认才能进入晋升。 */
  reviewRequired: boolean;
  reviewNotes: string[];
  anomalies: SourceAnomaly[];
}

/** 一份材料的段抽取结果。 */
export interface MaterialSegmentation {
  materialProposalId: string;
  moduleHint: CourseModuleHint | null;
  segments: ProposedSegment[];
  /** 该材料是否**刻意不产出段**（例如整份思维导图 → 文档级 method_note 之外的形态）。 */
  documentLevelOnly: boolean;
  warnings: string[];
  anomalies: SourceAnomaly[];
}

// ---------------------------------------------------------------------------
// 分段模式证据（自动 / 人工分段计划）
// ---------------------------------------------------------------------------

/**
 * 这次候选的段落**结构是怎么定下来的**。
 *
 * ── 为什么必须有它（任务书要求）──
 *
 * "候选证据必须说明分段模式是自动还是人工计划，并携带**安全的**计划校验和/引用。"
 *
 * 若没有它，"同一份源被换成人工计划结构"这件事对复核**完全不可见**：
 * 复核者看到一份新的候选校验和，却不知道变的是结构来源。
 *
 * ── 它里面**不得**有什么 ──
 *
 * - **绝对计划路径**（任务书明确禁止；计划位置属于本机布局，不进候选）；
 * - **任何正文**。这里只有**计数与坐标**（页码/行号），没有课程内容。
 *
 * 计划校验和会**参与**候选身份：人的结构输入一变 ⇒ 计划校验和变 ⇒
 * 分段摘要变 ⇒ 候选校验和变 ⇒ 已签的复核自动陈旧。绝不自动沿用旧决定。
 */
export interface SegmentationModeEvidence {
  mode: "automatic" | "human_planned";
  /** 计划校验和；自动模式为 null。 */
  planDigest: string | null;
  /** 计划契约版本；自动模式为 null。 */
  planSchemaVersion: number | null;
  /** 计划里声明的作者/时刻（审计；**不参与**候选身份）。 */
  planAuthor: string | null;
  planCreatedAt: string | null;
  /** 单元数。 */
  unitCount: number;
  /** 各类通道覆盖的行数（**计数**，不含正文）。 */
  channelLineCounts: {
    source: number;
    referenceTranslation: number;
    notes: number;
    ignoredFurniture: number;
  };
  /** 未被任何通道接住的行数。**非 0 即阻断**（覆盖率守卫）。 */
  unassignedLineCount: number;
  /** 未指派的坐标（**只有资产键/页码/行号**，不含正文；最多若干条）。 */
  unassignedCoordinates: { assetKey: string; page: number; line: number }[];
}


// ---------------------------------------------------------------------------
// canonical 匹配
// ---------------------------------------------------------------------------

/**
 * 匹配结论的**排序标签**。
 *
 * 四个标签**没有一个**等于 `verified`。它们是排序元数据，
 * 不构成任何人工核验，也不得写进任何运行时链接。
 */
export const MATCH_LABELS = [
  "strong_candidate",
  "possible_candidate",
  "weak_candidate",
  "no_candidate",
] as const;
export type MatchLabel = (typeof MATCH_LABELS)[number];

/** 一个 canonical 目标（真题里的一个大题 / 题组 / 题目）。 */
export interface CanonicalTarget {
  paperId: string;
  paperContentVersion: number;
  sectionId: string;
  sectionType: string;
  groupId: string | null;
  questionId: string | null;
  /** 人可读标签。 */
  label: string;
}

/**
 * 一条匹配建议的**逐项证据分解**。
 *
 * 每一项都必须可单独核对；`score` 只是排序用的加权和。
 * **没有任何一项是"文件名的相似度"。** 见 `FORBIDDEN_MATCH_FEATURES`。
 */
export interface MatchEvidence {
  /** 匹配投影的精确指纹是否相同。 */
  projectionExact: boolean;
  /** 主体文本（阅读篇章 / 文字稿 / 翻译原文）的字符 shingle 包含度（0–1）。 */
  bodyContainment: number;
  /** 主体文本的字符 shingle Jaccard（0–1）。 */
  bodyJaccard: number;
  /** 题干 token 包含度（0–1）；两侧都没有题干时为 null。 */
  stemOverlap: number | null;
  /** 选项文本 token 包含度（0–1）；两侧都无选项时为 null。 */
  optionOverlap: number | null;
  /** 结构一致性：题量/组结构是否吻合（0–1）。 */
  structuralConsistency: number;
  /**
   * 只作**上下文展示**的线索 —— **不参与打分**。
   *
   * 文件名、套别号、课程内物理顺序、题号、课程答案，全部只能出现在这里。
   * 它们永远不是身份证明（见 `docs/course-package.md` §7）。
   */
  contextOnly: {
    courseFileName: string | null;
    courseSetLabel: string | null;
    observedQuestionNumbers: number[];
    canonicalQuestionNumbers: number[];
    /** 课程侧答案（SOURCE ASSERTION，**不是**判分真相）。 */
    courseAnswerKey: string | null;
    notes: string[];
  };
}

/** 一条匹配建议。 */
export interface MatchSuggestion {
  target: CanonicalTarget;
  /** 加权总分，**只是排序元数据**。 */
  score: number;
  label: MatchLabel;
  evidence: MatchEvidence;
}

/** 一段的匹配结论。 */
export interface SegmentMatchResult {
  segmentId: string;
  segmentKind: CourseSegmentKind;
  /** 实际执行的**分块（blocking）**范围说明 —— 只与可比内容类型比较。 */
  blocking: { candidatesConsidered: number; description: string };
  /** 按分数降序的建议（可能为空 = no_candidate，这是**合法**状态）。 */
  suggestions: MatchSuggestion[];
  label: MatchLabel;
  /** 前两名过于接近 ⇒ 歧义。**不得因为排第一就选中它。** */
  ambiguous: boolean;
  ambiguityNote: string | null;
  /** 未匹配的语义说明（**不是**"伪造/非真题"）。 */
  unmatchedNote: string | null;
}

/** 整个候选包的匹配汇总。 */
export interface CandidateMatchingResult {
  algorithmVersion: number;
  projectionVersion: number;
  /**
   * 当前 canonical 库的快照摘要。
   *
   * 库一变它就得变，从而让"旧分数套新库"这件事**可见**。
   */
  canonicalLibrary: CanonicalLibrarySummary;
  segments: SegmentMatchResult[];
}

/** canonical 库（当前私有真题包）的只读摘要。 */
export interface CanonicalLibrarySummary {
  /** 排序后的 (paperId, contentVersion, manifestChecksum) 的规范摘要值。 */
  digest: string;
  papers: {
    paperId: string;
    contentVersion: number;
    manifestChecksum: string;
    /** 该卷参与匹配的 canonical 目标数。 */
    targetCount: number;
  }[];
  /**
   * **读不出来的**真题包（必须可见，且参与摘要身份）。
   *
   * ── 为什么它必须存在，以及它意味着什么 ──
   *
   * 一份真题包损坏 / 元数据非法时，它无法进入索引。此时匹配是在一个
   * **不完整的**库上进行的：可比对象少了一批，因此"未匹配"与
   * "某个建议是最高分"这两个结论都**不再完全可信**。
   *
   * 处置（刻意分成两层）：
   *
   * - **不**因为 canonical 匹配不可用而阻断**课程包**晋升 ——
   *   未匹配是合法状态，课程包本身仍然可以被规范化、复核、晋升。
   * - **但**在库不完整时，**绝不**把一个 `accepted_suggestion`
   *   当作可信的建链依据（见 `canonical_library_complete_for_acceptance` 门禁）。
   *
   * 它同时被纳入 `digest`，因此"库从不完整变成完整"会改变摘要 ⇒
   * 旧复核自动陈旧，而不是静默沿用。
   */
  readFailures: { packagePath: string; reason: string }[];
  /** 索引方式说明：本流水线**只读磁盘上的规范化包**，不打开数据库。 */
  source: string;
}

/**
 * **明确禁止**作为匹配证据的特征（只允许出现在 `contextOnly` 里）。
 *
 * 写在这里是为了让"为什么不能用它"可被检索，并由
 * `tests/course-matching.test.ts` 在行为层固定。
 */
export const FORBIDDEN_MATCH_FEATURES = [
  "fileName",
  "providerSetLabel",
  "physicalOrder",
  "bareQuestionNumber",
  "courseAnswerKey",
  "folderName",
] as const;

// ---------------------------------------------------------------------------
// 候选包
// ---------------------------------------------------------------------------

/** 复核门禁里的一条事项。 */
export interface CandidateReviewItem {
  code:
    | "material_grouping_ambiguous"
    | "material_grouping_requires_review"
    /**
     * 分组**不变量**被违反（一个文件属于多份材料，或不属于任何材料）。
     *
     * 这是**流水线缺陷**，不是数据问题，也**不是**人可以裁决的事项 ——
     * 因此它**永远无法**被 review.json 化解（见 `NEVER_RESOLVABLE_BY_REVIEW`）。
     */
    | "grouping_invariant_violated"
    | "segment_requires_review"
    | "text_extraction_deferred"
    | "page_without_text_layer"
    | "extraction_failed"
    | "no_segments_extracted"
    | "source_anomaly"
    | "match_ambiguous"
    | "unsupported_asset"
    | "empty_asset"
    /**
     * 人工分段计划里**有抽取内容没有被任何通道接住**。
     *
     * 它属于"候选自身的事实缺陷"一类：计划漏掉了内容，
     * 因此生成出来的课程包**确实缺内容**。人写一段说明**不能**让那些行
     * 出现在某个段落里 —— 必须**改计划并重新生成候选**。
     *
     * 因此它**不可**被任何复核裁决化解（见 `NEVER_RESOLVABLE_BY_REVIEW`）。
     * 让它可被裁决消掉会制造一条绕过覆盖率守卫的通道：
     * 只要在 review.json 里写一句话，就能把一份悄悄缺内容的包推出去。
     */
    | "plan_unassigned_content"
    /**
     * 计划与当前源**不匹配**（陈旧 / 课程不符 / 资产校验和变化 / 选择器越界）。
     *
     * 同样是事实缺陷：计划是针对**另一份**源字节写的，它的坐标
     * 在这一次的抽取产物上没有意义。处置是**改计划并重新生成候选**。
     */
    | "plan_binding_mismatch";
  severity: "blocking" | "advisory";
  where: string;
  detail: string;
  evidence: string | null;
}

/**
 * 这些阻断事项**不可**由任何复核裁决化解（F8 的语义边界）。
 *
 * 它们描述的是**候选自身的事实缺陷**（文件坏了 / 页没有文本层 / 空文件 /
 * 分组不变量被违反）。人写一段说明**不能**让它们消失 ——
 * 那需要修正源件并**重新生成候选**。
 *
 * 让它们"可被裁决消掉"会制造一条绕过门禁的通道：
 * 只要在 review.json 里写一句话，就能把一份抽取不完整的包推出去。
 *
 * 写在这里而不是 `review.ts`：它是**事项类型的固有属性**，
 * 与门禁实现分开放会诱使两处漂移。
 */
export const NEVER_RESOLVABLE_BY_REVIEW: readonly CandidateReviewItem["code"][] = [
  "extraction_failed",
  "page_without_text_layer",
  "empty_asset",
  "grouping_invariant_violated",
  /*
   * 人工分段计划的两类事实缺陷。
   *
   * 它们的共同点：**描述的是候选/计划自身与源件的关系**，
   * 而不是"人对这份结构的判断"。
   *
   * - `plan_unassigned_content`：计划漏掉了内容 ⇒ 候选确实缺内容。
   *   写一句话不会让那些行出现在某个段落里。
   * - `plan_binding_mismatch`：计划的坐标是针对**另一份**源字节的 ⇒
   *   它在这次的抽取产物上根本无意义。
   *
   * 两者的唯一正确处置都是**改计划（或修源件）后重新生成候选**。
   * 若允许裁决化解它们，覆盖率守卫就可以被一句话绕过 ——
   * 那正是本任务最不能接受的形态。
   */
  "plan_unassigned_content",
  "plan_binding_mismatch",
] as const;

/** 候选包元数据（`candidate.json`）。 */
export interface CourseCandidateMetadata {
  courseId: string;
  pipelineVersion: number;
  /** 提议的课程内容版本。 */
  contentVersion: number;
  createdAt: string;
  /** 源根标签（**只有目录名**）。 */
  sourceRootLabel: string;
  inventory: SourceInventory;
  extraction: {
    tool: { name: string; version: string; license: string } | null;
    documents: ParsedDocument[];
  };
  grouping: {
    proposals: MaterialGroupingProposal[];
    invariantViolations: string[];
    warnings: string[];
  };
  segmentation: {
    materials: MaterialSegmentation[];
    documentLevelOnlyMaterials: string[];
    /**
     * 这次段落结构的**来源**：自动判据，还是人工分段计划。
     *
     * 计划模式下它还携带计划的校验和与聚合计数。
     * **绝不**含绝对计划路径，也不含任何正文。
     */
    modeEvidence: SegmentationModeEvidence;
  };
  matching: CandidateMatchingResult;
  review: CandidateReviewItem[];
  /**
   * 各种摘要值。它们共同回答"复核到底复核了哪一份东西"。
   * 任一变化都会让 `candidateChecksum` 变化，从而让 `review.json` 陈旧。
   */
  digests: {
    /** 源资产集合（路径 + 字节 + sha256）。 */
    sourceDigest: string;
    /** `course.json` 原始字节的 sha256。 */
    courseChecksum: string;
    /** 分组提案的规范摘要。 */
    groupingDigest: string;
    /** 段抽取结果的规范摘要。 */
    segmentationDigest: string;
    /** 匹配结论 + canonical 库快照的规范摘要。 */
    matchingDigest: string;
    /** 上面五项的合成 —— **`review.json` 绑定的就是它**。 */
    candidateChecksum: string;
  };
}

// ---------------------------------------------------------------------------
// 复核
// ---------------------------------------------------------------------------

/**
 * 材料分组的复核裁决。
 *
 * ── V1 语义（**刻意只做两件事**）──
 *
 * - `accepted`：确认这份分组（含"PDF + DOCX 是同一份内容"这类**未被验证**的提案），
 *   因此它**可以**满足该分组的复核要求。
 * - `rejected`：**否定了候选当前的分组结构。**
 *   此时**当前候选不可晋升** —— 因为晋升会原样复制那份被否决的分组。
 *
 * `rejected` **不是**一个"已解决"状态。系统**不会**在复核阶段自动重组材料：
 * 那是"在复核者背后改写一份已绑定校验和的候选"，会立刻让校验和与复核脱钩。
 * 正确处置是**重新生成候选**（修正源目录或分组依据），然后复核新的校验和。
 */
export const GROUPING_DECISIONS = ["accepted", "rejected"] as const;
export type GroupingDecision = (typeof GROUPING_DECISIONS)[number];

/**
 * 段的复核裁决。
 *
 * ── V1 语义（与分组同一套，刻意对称）──
 *
 * - `accepted`：确认该段的边界/归类，因此它**可以**满足该段的复核要求。
 * - `excluded`：**否定该段应当存在于当前候选里。**
 *   此时**当前候选不可晋升** —— 因为晋升会原样复制那条该被去掉的段。
 *
 * 与 `rejected` 同理：系统**不会**在复核阶段自动删段（那会改写一份
 * 已绑定校验和的候选）。正确处置是修正源件/分段依据后**重新生成候选**，
 * 再复核新的校验和。
 */
export const SEGMENT_DECISIONS = ["accepted", "excluded"] as const;
export type SegmentDecision = (typeof SEGMENT_DECISIONS)[number];

/**
 * canonical 匹配的复核处置。
 *
 * **三者都不是 verified。**
 * `accepted_suggestion` 的含义是"这条候选映射已准备好让人**显式**建链"，
 * 而不是"系统已确认它对应那道真题"。
 */
export const MATCH_DISPOSITIONS = [
  "accepted_suggestion",
  "rejected_suggestion",
  "intentionally_unmatched",
] as const;
export type MatchDisposition = (typeof MATCH_DISPOSITIONS)[number];

export interface CourseReviewFile {
  courseId: string;
  reviewer: string;
  reviewedAt: string;
  /** 复核所针对的候选校验和。**必填**（可显式为 null，但那样门禁必然不通过）。 */
  candidateChecksum: string | null;
  /** 复核时看到的 canonical 库摘要。库变了 ⇒ 匹配证据陈旧。 */
  canonicalLibraryDigest: string;
  materialGroupings: {
    proposalId: string;
    decision: GroupingDecision;
    note: string;
    evidence: string;
  }[];
  segments: {
    segmentId: string;
    decision: SegmentDecision;
    note: string;
    evidence: string;
  }[];
  matches: {
    segmentId: string;
    disposition: MatchDisposition;
    /** 接受/否决建议时必须指向具体目标。 */
    paperId: string | null;
    targetScope: "section" | "group" | "question" | null;
    sectionId: string | null;
    groupId: string | null;
    questionId: string | null;
    note: string;
    evidence: string;
  }[];
  verifiedScope: string[];
  notVerified: string[];
}

// ---------------------------------------------------------------------------
// 晋升
// ---------------------------------------------------------------------------

export const PROMOTION_STATUSES = ["PROMOTABLE", "REVIEW_REQUIRED", "BLOCKED"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export interface PromotionCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface PromotionGate {
  courseId: string;
  status: PromotionStatus;
  checks: PromotionCheck[];
  /** 未解决的门禁事项。非空 ⇒ status 必不为 PROMOTABLE。 */
  blocking: CandidateReviewItem[];
  summary: string;
}

/**
 * 链接交接计划的求值结果。
 *
 * ── 为什么是结构化的而不是"直接返回数组"（F12）──
 *
 * 交接计划是一条**信任边界**的产物：它由"人已复核过的映射"推导，
 * 因此只有在复核与候选**整体可信**时才允许产出。
 * 返回结构化的 `allowed` + `reason` 让"为什么没有计划"成为**可打印、可测试**的事实，
 * 而不是让调用方从"数组为空"去猜原因（空数组既可能是"没有被接受的建议"，
 * 也可能是"门禁没通过"—— 两者的处置完全不同）。
 */
export interface LinkPlanResult {
  /** 是否允许产出交接计划。`false` ⇒ `entries` 必为空。 */
  allowed: boolean;
  /** 人可读理由。`allowed: false` 时必须说明**为什么**被抑制。 */
  reason: string;
  /** 允许时非空；被抑制时**必须**为空数组。 */
  entries: LinkPlanEntry[];
}

export interface LinkPlanEntry {
  segmentId: string;
  segmentTitle: string;
  segmentKind: CourseSegmentKind;
  paperId: string;
  targetScope: "section" | "group" | "question";
  sectionId: string;
  groupId: string | null;
  questionId: string | null;
  /**
   * 复核依据的**自由文本**（人写的散文）。
   *
   * **它绝不会进入生成的命令。** 只在这里供人阅读；
   * 命令里放的是下面那个受控标识符。
   */
  reviewEvidence: string;
  /**
   * **安全引用标识符** —— 命令里唯一承载"复核出处"的东西。
   *
   * 形态：`course-review:<courseId>:<checksumPrefix>:<segmentId>:<reviewedAt>`
   *
   * ── 为什么不能直接把自由文本塞进命令 ──
   *
   * 复核依据是人写的散文，可能包含引号、反引号、`$(...)`、分号、换行等。
   * 本项目运行在 Windows/PowerShell 环境里，而**反斜杠不是 PowerShell 的转义字符** ——
   * 任何"我自己写一个转义函数"的做法都会产出既不可移植、又能被解释成 shell 语法的字符串。
   *
   * 因此命令里只允许出现**受控字符集**（小写字母/数字/`._:-`），
   * 且每个片段都来自已被校验的字段（slug / 十六进制摘要 / 日期）。
   * 人写的证据留在 `review.json` 里，由这个标识符**指向**。
   */
  ref: string;
  /**
   * 可直接执行的命令文本。**本流水线从不执行它。**
   *
   * 它**不带** `--commit`（默认 dry-run），且其 `--ref` 只含安全标识符。
   */
  command: string;
}
