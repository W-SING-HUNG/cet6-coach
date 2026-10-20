/**
 * 半自动真题导入流水线的类型层。
 *
 * 设计原则（同一原则）：
 * 1. **自动化只提出结构，不裁决模糊真相。** 任何无法由源件确定的事项都进入
 *    `ReviewItem`，而不是被猜出来。
 * 2. **主源（试卷 PDF）是唯一正文权威。** 第三方内容只能作为交叉核对，
 *    并且必须在 provenance 里逐项标注来源层级。
 * 3. **候选包与可导入包在物理位置上就分开。** 候选永远不放在
 *    `cet6/papers/` 下，因此导入器的 `discover()` 在原理上就不可能看见它。
 */

import type { PaperSession, PaperSectionType } from "@/domain/paper";

// ---------------------------------------------------------------------------
// Stage 1 — 来源登记
// ---------------------------------------------------------------------------

export type SourceRole = "primary_paper_pdf" | "answer_source" | "listening_audio" | "secondary_reference";

export interface RegisteredSource {
  role: SourceRole;
  /** 来源说明（人可读）。 */
  description: string;
  /** 公开 URL 或本地相对路径。不得为空 —— 闭环要求来源可追溯。 */
  locator: string;
  /** 抓取日期（YYYY-MM-DD）。 */
  retrievedAt: string;
  bytes: number | null;
  sha256: string | null;
  /** 主源是否为文本层 PDF。Stage 2 会实测并回填。 */
  textLayer: "present" | "absent" | "unknown";
  mimeType: string | null;
  note: string | null;
  /**
   * 该来源**自称**的套别标签（例如 `第一套` / `Set 1`）。
   *
   * 刻意放在这里而不是身份字段：实测同一份被标为「第一套」的试卷，
   * 其内容与某第三方站点标为「第二套」的文字稿逐题对应。
   * 因此套别号只是**声明**，任何判据都不得依赖它。
   */
  providerSetLabel?: string | null;
}

export interface SourceRegistration {
  paperId: string;
  examType: "CET6";
  year: number;
  session: PaperSession;
  variant: string;
  expectedExamDate: string | null;
  sources: RegisteredSource[];
}

// ---------------------------------------------------------------------------
// Stage 2 — 抽取产物（原始证据，不修改）
// ---------------------------------------------------------------------------

export interface ExtractedRun {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

/**
 * 一条「视觉行」文本。
 *
 * 为什么是整行而不是按栏位切开的单元格：Word 生成的源件用**跨整个间隙的空白 run**
 * 做栏位对齐，因此几何间隙无法区分"标题内的对齐"与"并列栏位"。
 * 实测结论记录在 `lines.ts` 顶部。选项切分改由结构检测层按**选项标签**完成，
 * 判据落在内容上而不是排版上。
 */
export interface ExtractedLine {
  page: number;
  y: number;
  /** 行首 run 的 x（只统计非空白 run）。用于识别缩进与居中标题。 */
  x: number;
  /** 行尾 x（最右非空白 run 的右边界）。 */
  xEnd: number;
  text: string;
  runs: ExtractedRun[];
  /**
   * 每个 run 在 `text` 中的起始偏移。
   *
   * 为什么必须保留：整行拼接会把**栏位边界**变成"无空格相邻"
   * （实测词库左栏 `A) alpha` 与右栏 `I) india` 拼成 `A) alphaI) india`）。
   * 只按空白判断标签边界时，`I)` 前一个字符是字母，因此认不出它是新标签 ——
   * 实测导致 15 项词库只检出 1 项。
   * run 边界是排版给出的**可靠**切分信号，因此显式记录它。
   */
  runStarts: number[];
}

export interface ExtractedDocument {
  file: string;
  sha256: string;
  bytes: number;
  pages: number;
  pageWidth: number;
  pageHeight: number;
  /** 抽取工具与版本 —— 审计需要记录，否则"同一份 PDF 抽出不同文本"无法解释。 */
  tool: { name: string; version: string; license: string };
  pdfInfo: Record<string, unknown>;
  /** 无文本层的页（序号从 1 开始）。非空即说明该 PDF 不适合本流水线。 */
  pagesWithoutTextLayer: number[];
  lines: ExtractedLine[];
  /** 从版面实测推出的正文左边界与段落缩进，写进证据以便复核。 */
  geometry: { margin: number; indent: number; indentAmbiguous: boolean };
}

// ---------------------------------------------------------------------------
// Stage 3 — 结构检测
// ---------------------------------------------------------------------------

export type ReviewSeverity = "blocking" | "advisory";

/**
 * 需要人工裁决的一条事项。
 *
 * `blocking` 会阻止导入 —— 这是"失败关闭"的落点。只有确定性证据不足时才产生，
 * 不允许由"看起来不太对"产生：那会把门禁变成噪音并最终被无视。
 */
export interface ReviewItem {
  /** 稳定 id，便于在审计记录与复核输出中引用。 */
  code: ReviewCode;
  severity: ReviewSeverity;
  /** 指向试卷内位置，尽量精确。 */
  where: string;
  detail: string;
  /** 主源中支持该判定的原文片段（可为空）。 */
  evidence: string | null;
}

export type ReviewCode =
  | "option_label_incomplete"
  | "option_label_unexpected"
  | "option_label_duplicate"
  | "option_text_continuation"
  | "option_text_truncated"
  | "question_number_gap"
  | "question_number_duplicate"
  | "paragraph_label_sequence_broken"
  | "paragraph_label_missing"
  | "word_bank_cardinality"
  | "section_anchor_missing"
  | "section_anchor_conflict"
  | "question_group_anchor_missing"
  | "blank_marker_mismatch"
  | "keys_missing"
  | "keys_numbering_mismatch"
  | "listening_stem_not_in_primary_source"
  | "entity_spelling_conflict"
  | "source_checksum_drift"
  | "extraction_page_without_text_layer"
  | "answer_not_in_options"
  | "careful_reading_passage_boundary_uncertain"
  // ── Phase 2.2 修复新增（完整性 / 绑定 / 陈旧复核）──
  | "structural_requirement_unmet"
  | "required_field_empty"
  | "field_truncated_or_misaligned"
  | "source_span_shared_by_distinct_fields"
  | "source_items_not_covered"
  | "listening_enrichment_unbound"
  | "listening_enrichment_variant_mismatch"
  | "navigation_garbage_in_enrichment"
  | "human_review_stale"
  | "candidate_checksum_changed"
  | "asset_changed_after_review"
  | "content_fingerprint_conflict"
  /**
   * `candidate.json` 记录的指纹与现场重算不一致。
   *
   * 为什么必须**阻断**而不只是警告：指纹是内容身份。记录值与实际内容不符时，
   * 任何依赖它的判断（跨供应商去重、版本判据、审计可追溯性）都在读一个假值。
   * 允许 `IMPORTABLE` 就等于让一份"自称身份为 X、实际身份为 Y"的包进入题库。
   *
   * 解法是通过受支持的复核流程**刷新**它（重新运行 `papers:extract`，
   * 或由复核者显式确认），而不是带着陈旧值放行。
   */
  | "fingerprint_mismatch";

export interface DetectedOption {
  /** 源件上**印出来的**标签，未做任何归一化。 */
  printedLabel: string;
  label: string;
  text: string;
  page: number;
  y: number;
  x: number;
}

export interface DetectedQuestion {
  number: number | null;
  kind: "mcq" | "banked_cloze_blank" | "matching_statement" | "writing" | "translation";
  /** 听力：源件不印题干，此处为 null 并由第三方文字稿补齐。 */
  stem: string | null;
  options: DetectedOption[];
  /** 选择填空：空位标识（用试卷上的真实题号）。 */
  blankId: string | null;
  /** 匹配题：陈述句。 */
  statement: string | null;
  page: number;
  y: number;
  /** 源件中该题的原始行文本（用于源保真核对与审计）。 */
  sourceLines: string[];
}

export interface DetectedGroup {
  id: string;
  order: number;
  sectionType: PaperSectionType;
  /** 源件上的组锚点原文，例如 `Questions 9 to 11 are based on the passage you have just heard.` */
  anchor: string | null;
  firstNumber: number | null;
  lastNumber: number | null;
  questions: DetectedQuestion[];
  passage: string | null;
  paragraphs: { label: string; text: string }[] | null;
  wordBank: string[] | null;
  instructions: string | null;
  pageRange: [number, number];
}

export interface DetectedSection {
  type: PaperSectionType;
  title: string;
  /** 主源上该大题的标题原文（例如 `Part II Listening Comprehension (30 minutes)`）。 */
  anchor: string | null;
  instructions: string | null;
  groups: DetectedGroup[];
}

export interface StructuralDetection {
  sections: DetectedSection[];
  review: ReviewItem[];
  /** 从源件解析出的 KEYS 答案表（题号 → 标签）。 */
  keys: Record<number, string>;
  /** 检测到的写作与翻译原文（主观项）。 */
  writing: { prompt: string | null; instructions: string | null; minWords: number | null; maxWords: number | null };
  translation: { sourceText: string | null; instructions: string | null };
  /** 主源自身的打印异常，必须原样记录，不得静默改写。 */
  sourceAnomalies: string[];
}

// ---------------------------------------------------------------------------
// Stage 5 — 源保真
// ---------------------------------------------------------------------------

export type FidelityVerdict = "PASS" | "DIFF" | "UNVERIFIABLE";

export interface FidelityFieldResult {
  /** 形如 `sections[2].groups[0].questions[3].options[2]`。 */
  field: string;
  verdict: FidelityVerdict;
  /** 包内形式（规范化后）。 */
  normalized: string;
  /** 在主源中找到的形式（命中时）。 */
  sourceForm: string | null;
  reason: string;
}

export interface FidelityReport {
  paperId: string;
  primarySource: { file: string; sha256: string };
  counts: { pass: number; diff: number; unverifiable: number };
  results: FidelityFieldResult[];
}

// ---------------------------------------------------------------------------
// Stage 7 — 听力与第三方富集
// ---------------------------------------------------------------------------

export interface EnrichmentRecord {
  field: string;
  /** 只允许这些值。第三方内容永远不会被标成主源内容。 */
  provenance: "primary_pdf" | "third_party_transcript" | "third_party_secondary";
  sourceLocator: string;
  value: string;
}

// ---------------------------------------------------------------------------
// Stage 8 — 人工复核门禁
// ---------------------------------------------------------------------------

export type GateStatus = "IMPORTABLE" | "REVIEW_REQUIRED" | "BLOCKED";

export interface GateCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface GateVerdict {
  paperId: string;
  status: GateStatus;
  checks: GateCheck[];
  /** 未解决的 blocking 复核项。非空则 status 必不为 IMPORTABLE。 */
  blocking: ReviewItem[];
  /** 该门禁的判定摘要（人可读）。 */
  summary: string;
}

// ---------------------------------------------------------------------------
// 候选包（Stage 4）
// ---------------------------------------------------------------------------

export const CANDIDATE_PIPELINE_VERSION = 1;

export interface CandidateMetadata {
  paperId: string;
  pipelineVersion: number;
  /** 候选状态。只有 `approved` 才允许晋升到 cet6/papers/。 */
  status: "candidate" | "approved";
  createdAt: string;
  sourceRegistration: SourceRegistration;
  extraction: {
    file: string;
    sha256: string;
    pages: number;
    tool: string;
    pagesWithoutTextLayer: number[];
    geometry: ExtractedDocument["geometry"];
  };
  review: ReviewItem[];
  fidelity: FidelityReport;
  gate: GateVerdict;
  enrichments: EnrichmentRecord[];
  keys: Record<number, string>;
  sourceAnomalies: string[];
  /**
   * 规范内容指纹（Phase 2.2 修复新增）。
   *
   * 它是**身份**，与来源套别号无关：两份内容相同、仅来源标注不同的包，
   * 指纹必须相同。用于跨来源去重与"套别标签冲突"的判定。
   */
  contentFingerprint: string;
  /** 指纹算法版本。含义变化时必须递增。 */
  fingerprintAlgorithmVersion: number;
  /** 来源侧的套别标签声明（**不是身份**，仅作 provenance 披露）。 */
  sourceVariantLabels: {
    provider: string;
    claimedLabel: string;
    locator: string;
  }[];
  /**
   * 机器判定的四类独立结果（Phase 2.2 修复新增）。
   *
   * 刻意分开：源保真、源完整性、结构完整性、跨来源绑定回答的是
   * **四个不同的问题**，失败原因与处置方式都不一样。
   */
  machine: {
    sourceFidelity: { verdict: string; checked: number; summary: string };
    sourceCompleteness: { verdict: string; checked: number; summary: string };
    structuralIntegrity: { verdict: string; checked: number; summary: string };
    crossSourceBinding: { verdict: string; checked: number; summary: string };
  } | null;
  /** 听力题组的内容绑定记录。 */
  listeningBindings: {
    from: number;
    to: number;
    primaryFingerprint: string;
    locator: string;
    providerSetLabel: string | null;
    evidenceKind: string;
    evidenceDetail: string;
    evidenceStrength: string;
    bound: boolean;
  }[];
  /** 被剔除的抓取页面导航垃圾（供审计）。 */
  garbageRemoved: { number: number; text: string }[];
  /**
   * 复核所针对的候选内容校验和（Phase 2.2 修复新增）。
   *
   * 人工裁决只对它复核过的那一份候选有效。候选内容变了，
   * 旧裁决立即失效 ⇒ REVIEW_REQUIRED。这防止"改了内容但沿用旧批准"。
   */
  reviewedCandidateChecksum: string | null;
  /**
   * Stage 6 答案验证结果（含证据强度）。
   *
   * `null` 表示未进行跨来源比对 —— 此时答案只有主源 KEYS 表一个出处，
   * 证据强度为单一来源。**不得**把"没比对"写成"已验证"。
   */
  answerVerification: {
    level: "single_source" | "cross_source_agree" | "mostly_agree_with_disagreements" | "cross_source_conflict";
    note: string;
    comparing: number;
    agreeing: number;
    textAgreeing: number;
    conflicts: { number: number; primary: string; secondary: string; secondaryText: string | null }[];
    sources: { label: string; locator: string; internalDefects: string[] }[];
    /**
     * 逐题证据矩阵（Phase 2.2 修复新增）。
     *
     * 为什么必须有它：把整卷答案概括成一个"整体一致"会掩盖个别题的分歧。
     * 实测某卷 25 题里 24 题一致、1 题分歧 —— 而那一题恰恰最需要人看见。
     * 因此对指定题号逐来源输出取值。**任何来源都不称"官方"。**
     */
    evidenceMatrix: {
      number: number;
      outcome: "agree" | "disagree" | "single_source";
      rows: { source: string; locator: string; value: string | null; text: string | null }[];
    }[];
  } | null;
  /**
   * 人工裁决驱动的有意修正（逐条含理由与证据）。
   *
   * 这是"修正必须留痕"的落点：复核者不直接编辑 paper.json，
   * 而是写 `corrections.json`；流水线应用它并把每条登记在这里与审计记录中。
   */
  intentionalTransformations: {
    type: string;
    where: string;
    from: string;
    to: string;
    reason: string;
    evidence: string;
    reviewer: string;
    reviewedAt: string;
  }[];
  /**
   * 人工复核结论。`null` 表示尚未裁决 —— 这正是"候选状态先于导入"的落点：
   * 没有人工裁决的候选，门禁不可能是 IMPORTABLE。
   */
  humanReview: {
    reviewedAt: string;
    reviewer: string;
    resolutions: { code: ReviewCode; where: string; resolution: string; evidence: string }[];
  } | null;
}
