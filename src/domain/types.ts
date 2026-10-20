/**
 * Phase 1 公共类型基元。
 * 保持极简：只放真正被多处复用的类型，不做提前抽象。
 */

export type ISODate = string; // YYYY-MM-DD
export type ISODateTime = string; // ISO 8601

/** CET-6 的四个计分模块。口语不参与，目标已明确排除。 */
export const SKILLS = ["listening", "reading", "writing", "translation"] as const;
export type Skill = (typeof SKILLS)[number];

/** CET-6 官方分值权重。用于 planner 分配训练预算，也用于结果的诚实表述。 */
export const SKILL_WEIGHTS: Record<Skill, number> = {
  listening: 0.35,
  reading: 0.35,
  writing: 0.15,
  translation: 0.15,
};

export const SKILL_LABELS: Record<Skill, string> = {
  listening: "听力",
  reading: "阅读",
  writing: "写作",
  translation: "翻译",
};

/** 诊断覆盖的维度。词汇没有独立分值，但它是阅读/写作/翻译的共同前置能力。 */
export const DIAGNOSTIC_DIMENSIONS = [
  "vocabulary",
  "listening",
  "reading",
  "writing",
  "translation",
] as const;
export type DiagnosticDimension = (typeof DIAGNOSTIC_DIMENSIONS)[number];

export const DIMENSION_LABELS: Record<DiagnosticDimension, string> = {
  vocabulary: "词汇",
  listening: "听力",
  reading: "阅读",
  writing: "写作",
  translation: "翻译",
};

/** 词汇维度影响哪些计分模块 —— 用于把词汇表现折进能力画像。 */
export const VOCABULARY_FEEDS: Skill[] = ["reading", "writing", "translation"];

/**
 * 维度/模块的评估状态。
 *
 * 三者是互斥的**测量状态**，不是程度差异。语义契约（由 tests/diagnostic-semantics.test.ts 守护）：
 *
 * - `assessed`：该维度在其**实际测量设计**下获得了足够证据，可以给出方向性估计。
 *   ⇒ 不变式：`mastery !== "unknown"`。confidence 仍可为 low（表示估计窄、不确定），
 *     但 low confidence 不等于"没有结论"。
 * - `insufficient_evidence`：测量机制存在，但本次会话可用的有效证据不足，无法支撑估计。
 *   典型情形：用户跳过了该维度的题、主观作答为空/不可用、覆盖度不足。
 *   ⇒ `mastery === "unknown"`，且不产生弱项结论。
 * - `unassessed`：系统当前**没有**能测量该能力的有效工具（缺素材/缺题型）。
 *   典型情形：无音频刺激的听力。
 *   ⇒ `mastery === "unknown"`，不给分数、不推断强弱、不据此加权。
 *
 * 为什么 `assessed` 不能配 `unknown`：那会让 UI 同时说"已评估"与"信息不足"，
 * 是两个互斥断言。要么证据够（给出方向性结论），要么不够（退回 insufficient_evidence）。
 */
export type AssessmentStatus = "assessed" | "insufficient_evidence" | "unassessed";

export const ASSESSMENT_STATUS_LABELS: Record<AssessmentStatus, string> = {
  assessed: "已评估",
  insufficient_evidence: "证据不足",
  unassessed: "尚未有效评估",
};

/**
 * 各维度的**证据充足性要求**（按真实测量设计定义，不用统一的魔法数字）。
 *
 * 依据是 `src/content/diagnostic-bank.ts` 的实际题库设计：
 * - vocabulary：9 道客观题，题量充足 → 要求至少 3 道有效题。
 * - reading：4 道客观题（共享 1 篇材料）→ 要求至少 2 道（覆盖不仅 1 个考点）。
 * - writing：**刻意只设计 1 道完整写作样本**作为 Phase 1 的写作诊断。
 *   写作的测量单位就是"一篇作文"，不是"多道题"，因此 1 篇有效作文即为充足。
 * 其 rubric 有 6 个评分要点，足以支撑低置信度的方向性估计。
 * - translation：2 道主观题，每道 6 个信息点 → 要求至少 1 道有效作答。
 * - listening：无有效测量工具，恒为 unassessed，不参与此表。
 *
 * `minValidItems` 是"该维度自己的测量单位数下限"，不是跨维度统一的题量阈值。
 */
export interface DimensionEvidenceRequirement {
  /** 判定为 assessed 所需的最少有效计分样本数 */
  minValidItems: number;
  /** 该维度"完整诊断"应有的样本数，用于描述覆盖度 */
  expectedItems: number;
  /** 为什么是这个下限（测量设计依据） */
  rationale: string;
}

export const DIMENSION_EVIDENCE_REQUIREMENTS: Record<DiagnosticDimension, DimensionEvidenceRequirement> = {
  vocabulary: {
    minValidItems: 3,
    expectedItems: 9,
    rationale: "9 道客观题，3 道以上才能跨越单一考点；低于 3 道不足以形成方向性判断。",
  },
  reading: {
    minValidItems: 2,
    expectedItems: 4,
    rationale: "4 道客观题共享 1 篇材料，2 道以上才覆盖到不同考点类型（主旨/推断/细节）。",
  },
  writing: {
    minValidItems: 1,
    expectedItems: 1,
    rationale:
      "Phase 1 的写作诊断被刻意设计为 1 道完整写作样本 —— 写作的测量单位是「一篇作文」而非「多道题」。" +
      "该样本含 6 个 rubric 要点，足以支撑低置信度的方向性估计。",
  },
  translation: {
    minValidItems: 1,
    expectedItems: 2,
    rationale: "2 道主观题各含 6 个信息点，1 道有效作答即可给出方向性判断。",
  },
  listening: {
    minValidItems: 0,
    expectedItems: 0,
    rationale: "无音频素材，缺少有效测量工具，恒为 unassessed（不适用证据充足性判定）。",
  },
};

export type MasteryLevel = "unknown" | "weak" | "developing" | "solid" | "strong";

/**
 * 判定某个维度是否具备"有效测量手段"。
 *
 * 目前唯一没有有效手段的是听力：CET-6 听力考的是长对话、篇章、讲座的**音频理解**，
 * 没有音频刺激就不可能测量。IPA 辨词测的是音形解码（拼读），属于词汇/语音意识范畴，
 * 不能作为听力理解的证据。
 *
 * 未来接入音频素材后，把 listening 从这里移除即可，无需改动调用方。
 */
export const UNASSESSED_DIMENSIONS: DiagnosticDimension[] = ["listening"];

export function isValidlyAssessable(dimension: DiagnosticDimension): boolean {
  return !UNASSESSED_DIMENSIONS.includes(dimension);
}

export const MASTERY_LABELS: Record<MasteryLevel, string> = {
  unknown: "信息不足",
  weak: "明显薄弱",
  developing: "有待提升",
  solid: "基本稳固",
  strong: "相对优势",
};

export type TaskPriority = "core" | "recommended" | "optional";

export const PRIORITY_LABELS: Record<TaskPriority, string> = {
  core: "核心",
  recommended: "推荐",
  optional: "可选",
};

export const PRIORITY_ORDER: Record<TaskPriority, number> = {
  core: 0,
  recommended: 1,
  optional: 2,
};

/** 训练任务的题型。Phase 1 只实现其中一部分，其余保留给后续阶段。 */
export const TASK_KINDS = [
  "vocabulary_recall",
  "reading_comprehension",
  "listening_comprehension",
  "translation_drill",
  "writing_drill",
  "review",
] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/**
 * 内容素材的类型标识。
 *
 * 刻意定义在 domain 层：planner 需要按素材类型分组（例如区分"阅读题"与"词汇组"），
 * 但 domain 不应反向依赖 content 模块。content 层的内容类型与此一一对应，
 * 由编译期断言保证两边不漂移。
 * 注意：这里只包含**真实内容素材**，不含 review_deck ——
 * 复习任务引用的是队列而非内容文件，不属于内容库。
 */
export const CONTENT_TYPES = [
  "reading_passage",
  "vocabulary_set",
  "translation_prompt",
  "writing_prompt",
  "listening_pending",
] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/**
 * 任务可以引用的目标类型。
 *
 * 三类，且只有第一类是**内容库素材**：
 * - `ContentType`：`src/content/practice-library.ts` 的素材。
 * - `review_deck`：复习队列（不是内容文件）。
 * - `reading_target`：**真实试卷里某个可训练的阅读大题**。
 *
 * ── 为什么 `reading_target` 不在 `CONTENT_TYPES` 里 ──
 *
 * 它与 `review_deck` 是同一类东西：引用的**不是内容库条目**。
 * 真实真题的正文从不进入 `contentRepository`（它存在私有包目录里，
 * 由 `content/paper` 的 catalog 按版本读取。
 * 把它塞进 `CONTENT_TYPES` 会强行要求 `content/types.ts` 也有对应成员，
 * 而那一层的编译期断言正是用来保证"内容库成员两边一致"的 ——
 * 加进去会把这个约束变成谎言。
 *
 * `contentId` 的编码由 `domain/reading-target.ts` 定义（`paperId::sectionId`）。
 */
export type TaskContentType = ContentType | "review_deck" | "reading_target";
