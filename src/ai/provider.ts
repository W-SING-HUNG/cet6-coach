/**
 * AI 能力边界。
 *
 * 铁律：
 * - domain / repository / UI 层不得 import 任何供应商 SDK。
 * - 只有 `src/ai/providers/*` 允许依赖具体 LLM 客户端。
 * - 未配置 API key 时必须走 `unavailable` 分支，返回明确标记，**不得**伪装成 AI 结果。
 */

import type { DiagnosticDimension } from "@/domain/types";

export type AIStatus = "ok" | "unavailable" | "error";

export interface AIResult<T> {
  status: AIStatus;
  /** 结果来源，UI 必须据此如实标注，禁止把 stub 呈现为 AI */
  source: "ai" | "local-stub" | "none";
  providerId: string;
  data: T | null;
  /** 面向用户的可读说明（如"未配置 API key，以下为本地规则评分"） */
  message: string;
}

export interface WritingGradingInput {
  prompt: string;
  essay: string;
  /** 字数要求，CET-6 作文通常 120-180 词 */
  minWords?: number;
  maxWords?: number;
}

export interface TranslationGradingInput {
  sourceText: string;
  referenceTranslation: string;
  userTranslation: string;
}

export interface DimensionFeedback {
  /** 0-1 */
  score: number;
  summary: string;
  /** 具体问题，每条对应一个可训练的点 */
  issues: Array<{
    label: string;
    detail: string;
    errorTag: string;
    severity: 1 | 2 | 3;
  }>;
  /** 可复用的改进建议 */
  suggestions: string[];
  /** 若由本地 stub 生成，UI 必须显示这个标记 */
  disclaimer?: string;
}

export interface ErrorExplanationInput {
  question: string;
  userAnswer: string;
  correctAnswer: string;
  dimension: DiagnosticDimension;
}

export interface AIGradingProvider {
  readonly id: string;
  /** 该 provider 当前是否可用（例如是否配置了 key）。 */
  isAvailable(): boolean;
  gradeWriting(input: WritingGradingInput): Promise<AIResult<DimensionFeedback>>;
  gradeTranslation(input: TranslationGradingInput): Promise<AIResult<DimensionFeedback>>;
  explainError(input: ErrorExplanationInput): Promise<AIResult<string>>;
}

/**
 * 已移除：`generateQuestions()`
 *
 * 它（连同 `QuestionGenerationInput` / `GeneratedQuestionDraft`）是"AI 出题"能力的接口，
 * 与内容政策直接冲突 —— 评估与训练内容只能来自真实历年真题
 * （见 `content-policy/PRODUCT_PRINCIPLES.md` 第 6 节、第 8 节）。
 *
 * 移除理由不只是政策：保留这个接口会诱导后续实现误用它 ——
 * 一个"能生成题目"的方法摆在那里，迟早会有人为了让界面显得有内容而调用它，
 * 而合成题会替换掉真实评测的难度分布与陷阱结构，让测出来的表现不再代表考试表现。
 *
 * 移除前已实测确认无任何调用方（仅定义与 local-stub 里的实现）。
 * 本产品的题目来源只有一条：`private-content/` 下导入的真实试卷。
 */

/** 未配置任何 provider 时的统一提示文案。 */
export const AI_UNAVAILABLE_MESSAGE =
  "未配置 AI 服务，当前使用本地规则评分。它只能检查结构性要点，不能替代真实批改。";

export const AI_STUB_DISCLAIMER = "本地规则评分，非 AI 批改";
