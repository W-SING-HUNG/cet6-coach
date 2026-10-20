/** Server Action 与 service 层共享的输入类型。 */

export interface DiagnosticAnswerInput {
  itemId: string;
  dimension: "vocabulary" | "listening" | "reading" | "writing" | "translation";
  choiceId: string | null;
  text: string | null;
  skipped: boolean;
}

export interface TaskAnswerInput {
  questionId: string;
  choiceId: string | null;
}

/** Server Action 的统一返回结构。UI 依赖 discriminated union 显示成功/失败。 */
export type ActionResult<T = undefined> =
  | { ok: true; data: T; message?: string }
  | { ok: false; error: string };
