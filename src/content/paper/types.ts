import type {
  PaperExamType,
  PaperSectionType,
  PaperSession,
  PaperSourceKind,
  PaperVerificationStatus,
} from "@/domain/paper";

/**
 * 规范化试卷包（normalized paper package）的规范模型。
 *
 * 设计取舍（与 Phase 1 的内容层对比）：
 * Phase 1 的 `src/content/` 是**原创训练素材**，直接写成 TypeScript 模块，
 * 因为它们是代码的一部分、需要 diff 与类型检查。
 * 真题不是代码：它是外部真实内容，体量大（含音频）、有版权、不进 Git，
 * 因此以"目录 + manifest + assets"的包形式存在于 private-content 下，
 * 经校验后由数据库建立索引。
 *
 * 两者共享的原则是同一条：**调用方不得直接碰底层存储**。
 * 因此这里同样只暴露接口，不暴露文件路径。
 */

// ---------------------------------------------------------------------------
// 资产
// ---------------------------------------------------------------------------

export const ASSET_KINDS = ["audio", "image"] as const;
export type AssetKind = (typeof ASSET_KINDS)[number];

/** 允许的扩展名 → MIME。不信任 manifest 里声明的 MIME，以扩展名映射为准。 */
export const ASSET_MIME_BY_EXTENSION: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export interface PaperAsset {
  id: string;
  kind: AssetKind;
  /** 相对于试卷包根目录的路径，例如 `assets/listening.mp3`。永远是 POSIX 风格。 */
  relativePath: string;
  mimeType: string;
  /** 包内实际字节数。校验时与磁盘真实值比对，不一致则拒绝。 */
  bytes: number;
  /** 内容 sha256（十六进制）。用于检测"同一路径换了内容"。 */
  checksum: string;
  /** 可选的文字说明，例如"听力 Section A 音频"。 */
  label: string | null;
}

// ---------------------------------------------------------------------------
// 题目
// ---------------------------------------------------------------------------

export interface PaperOption {
  id: string;
  label: string;
}

interface PaperQuestionBase {
  id: string;
  /**
   * 试卷上的**官方题号**，仅客观题有值（1–55）。
   *
   * 实测依据：官方试卷的 KEYS 表只编号 Part II 听力（1–25）与 Part III 阅读（26–55）；
   * 写作与翻译是主观作答项，**没有题号**，因此这里为 `null`。
   * 早先模型假定整卷 1–57 连续是事实错误（见 `src/domain/paper.ts` 的 SECTION_IS_NUMBERED）。
   */
  number: number | null;
  /** 组内顺序，从 0 开始。用于保持原文顺序。 */
  order: number;
  explanation: string | null;
}

/** 普通四选一。听力与仔细阅读都用它。 */
export interface McqQuestion extends PaperQuestionBase {
  kind: "mcq";
  stem: string;
  options: PaperOption[];
  /** 正确选项 id。校验时必须指向存在的 option。 */
  answer: string;
}

/**
 * 选词填空的一个空。
 *
 * 为什么不让每空独立成题：10 个空共享同一篇文章与同一个词库，
 * 拆开就丢掉了"根据上下文选词"这个考点本身。
 * 因此 passage 与 wordBank 在 group 上，这里只描述"第几空、答案是哪个词"。
 */
export interface BankedClozeBlank extends PaperQuestionBase {
  kind: "banked_cloze_blank";
  /** 与 passage 中的 `[n]` 占位符对应。 */
  blankId: string;
  answer: string;
}

/** 长篇阅读（段落匹配）的一条陈述。 */
export interface MatchingStatement extends PaperQuestionBase {
  kind: "matching_statement";
  statement: string;
  /** 匹配到的段落标号（例如 "B"）。校验时必须存在于 group.paragraphs。 */
  answerParagraph: string;
}

/** 写作。1 题，主观。 */
export interface WritingQuestion extends PaperQuestionBase {
  kind: "writing";
  prompt: string;
  instructions: string | null;
  /** 可选：官方或参考范文。没有就是没有，不生成。 */
  referenceEssay: string | null;
  minWords: number | null;
  maxWords: number | null;
}

/** 翻译。1 题，中译英。 */
export interface TranslationQuestion extends PaperQuestionBase {
  kind: "translation";
  sourceText: string;
  instructions: string | null;
  referenceTranslation: string | null;
}

export type PaperQuestion =
  | McqQuestion
  | BankedClozeBlank
  | MatchingStatement
  | WritingQuestion
  | TranslationQuestion;

export type PaperQuestionKind = PaperQuestion["kind"];

// ---------------------------------------------------------------------------
// 题组（一个刺激材料 + 绑定其上的题目）
// ---------------------------------------------------------------------------

/**
 * 题组。
 *
 * 存在的理由：CET-6 的绝大多数题目都不是孤立的选择题，而是"一段材料 + 若干题"。
 * 长对话 2 段各 4 题、篇章 2 篇、讲座 3 篇、选词填空 1 篇 10 空、
 * 长篇阅读 1 篇 10 句、仔细阅读 2 篇各 5 题。
 * 用统一的 group 表达，就能在**不丢结构**的前提下让所有大题共用一条渲染/校验链路。
 */
export interface PaperGroup {
  id: string;
  order: number;
  instructions: string | null;
  /** 听力：音频资产 id。非听力组为 null。 */
  audioAssetId: string | null;
  /** 听力原文。没有就是没有，不由 AI 补全。 */
  transcript: string | null;
  /** 阅读：文章正文（选词填空用 `[1]`…`[10]` 标记空位）。 */
  passage: string | null;
  /** 长篇阅读：带标号的段落。 */
  paragraphs: { label: string; text: string }[] | null;
  /** 选词填空：词库原文顺序（官方题面给的 15 个词，10 个被使用）。 */
  wordBank: string[] | null;
  /**
   * 该组在试卷上的起始题号。仅客观题组有值；写作/翻译组为 `null`（无题号）。
   */
  firstNumber: number | null;
  questions: PaperQuestion[];
}

// ---------------------------------------------------------------------------
// 大题（section）
// ---------------------------------------------------------------------------

export interface PaperSection {
  id: string;
  type: PaperSectionType;
  order: number;
  title: string;
  instructions: string | null;
  groups: PaperGroup[];
}

// ---------------------------------------------------------------------------
// 来源与核验
// ---------------------------------------------------------------------------

export interface PaperProvenance {
  /** 来源描述，人可读。例如"XX 站公开页面，2024 年 12 月第 1 套"。 */
  note: string;
  /** 来源引用（URL 或本地文件名）。可以为 null，但 note 不能为空。 */
  reference: string | null;
  /** 核验者与核验范围说明。已核验时必须写明核验了什么。 */
  verificationNote: string | null;
}

// ---------------------------------------------------------------------------
// 试卷
// ---------------------------------------------------------------------------

export interface ExamPaperContent {
  /** 稳定标识。导入后不会随内容更新而改变，历史记录才能安全引用它。 */
  id: string;
  examType: PaperExamType;
  year: number;
  session: PaperSession;
  /** 同一场次的多套卷。单套卷用 "single"。 */
  variant: string;
  /** 官方考试日期，未知则为 null（不猜）。 */
  examDate: string | null;
  sourceKind: PaperSourceKind;
  verificationStatus: PaperVerificationStatus;
  provenance: PaperProvenance;
  /**
   * 内容版本号。内容实质变化时必须单调递增 ——
 * 这是"历史作答不会被静默指向另一道题"的唯一保证。
   */
  contentVersion: number;
  /**
   * 显式声明"这份包只包含部分内容"。
   *
   * 为什么需要它而不是让校验器自己判断：官方题量是硬约束，
   * 缺大题的包必须被**作者显式承认**为部分内容，否则一律按"不完整"拒绝。
 * 这样"少了两篇听力"就不可能因为校验器宽容而被静默接受。
   */
  partial: boolean;
  sections: PaperSection[];
  assets: PaperAsset[];
}

// ---------------------------------------------------------------------------
// 导入边界
// ---------------------------------------------------------------------------

/** 一个已规范化、尚未校验的试卷包（仍是磁盘上的目录，未解析）。 */
export interface NormalizedPackageHandle {
  /** 包目录相对于 content root 的路径。 */
  relativePath: string;
  /** 磁盘绝对路径。仅导入器内部使用，不得外泄给 UI。 */
  absolutePath: string;
}

/** 解析并校验后的候选试卷。 */
export interface ValidatedPaper {
  content: ExamPaperContent;
  /** 试卷数据文件（通常是 paper.json）的 sha256。用于重复/变更检测。 */
  checksum: string;
  packageRelativePath: string;
  /** 校验期间产生的非致命提醒（例如某组缺 transcript）。 */
  warnings: string[];
}

/** 导入失败时的一条结构化错误，必须带精确位置。 */
export interface PaperIssue {
  /** 形如 `sections[2].groups[1].questions[3].answer`；整卷级问题为 `<paper>`。 */
  path: string;
  message: string;
}

/**
 * 包导入器边界。
 *
 * 目前只有一个实现：规范化目录包（normalized_package）。
 * 未来"PDF + MP3 → 规范化包"的原始源导入应当是**另一个**实现，
 * 它必须先产出规范化包，而不是直接写数据库 ——
 * 这样"AI 提取的结果"与"已核验的真卷"在类型层面就不可能混淆。
 * 本阶段不实现该实现，也不建插件注册表。
 */
export interface PaperPackageImporter {
  readonly kind: "normalized_package";
  readonly label: string;
  /** 发现 content root 下所有候选包。 */
  discover(): NormalizedPackageHandle[];
  /** 解析 + 校验单个包。**不产生任何写入**。 */
  validate(handle: NormalizedPackageHandle): ValidatedPaper;
}

/**
 * 原始源（PDF / MP3）导入的边界描述。
 *
 * **状态已变更**：本阶段（Phase 2.2）实现了半自动流水线，
 * 位置在 `src/content/pipeline/`，命令为 `pnpm papers:extract` / `pnpm papers:review`。
 * 因此这里的 `supported` 由 `false` 改为 `"semi_automatic"` —— 措辞刻意不用 `true`：
 * 流水线**不**自动产出可导入的包，它只产出**候选**，必须经人工复核门禁才能晋升。
 */
export const RAW_SOURCE_IMPORT_BOUNDARY = {
  /** `semi_automatic`：有工具链，但接受内容仍需人工裁决。 */
  supported: "semi_automatic" as const,
  /** 实现的入口。写下来是为了让调用方不必去猜工具在哪。 */
  implementation: {
    module: "src/content/pipeline/",
    extractCommand: "pnpm papers:extract <paper-id>",
    reviewCommand: "pnpm papers:review <paper-id> [--promote]",
    /** 候选包位置。**刻意不在** `cet6/papers/` 下，导入器看不到它。 */
    candidatesDir: "private-content/candidates/",
    rawDir: "private-content/raw/<paper-id>/",
  },
  /** 实际的链路（与原计划一致：抽取结果先变成包，不直接写数据库）。 */
  intendedPipeline: [
    "raw/<paper-id>/sources.json 登记主源/答案/音频/第三方来源及其校验和",
    "抽取主源 PDF 的文本层（pdfjs-dist，不使用 OCR）",
    "按语义锚点检测结构；无法确定的事项进入 REVIEW_REQUIRED",
    "产出候选包到 candidates/<paper-id>/（未批准状态）",
    "源保真比对 + 答案验证 + 听力题干富集（逐项标 provenance）",
    "人工书写 corrections.json / review.json 裁决阻断项",
    "门禁全部通过后晋升到 cet6/papers/，再用同一个校验器导入",
  ],
  /** 明确不做的事。 */
  willNotDo: [
    "由 AI 直接写入数据库",
    "把抽取结果自动标为 verified",
    "在没有人工核对的情况下把内容标为 real_past_paper",
    "对图片型 PDF 使用 OCR（本流水线只支持文本层，无文本层即阻断）",
    "在运行时用 LLM 解析试卷（结构由确定性代码检测，不由模型判断）",
  ],
} as const;
