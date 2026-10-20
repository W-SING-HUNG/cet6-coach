import { z } from "zod";

/**
 * 校验 schema。所有用户输入在进入 service 层之前必须经过这里。
 * 不依赖任何框架，因此脚本、测试与 Server Action 共用同一套规则。
 */

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "日期格式必须是 YYYY-MM-DD")
  .refine((value) => !Number.isNaN(Date.parse(`${value}T00:00:00Z`)), "日期无效");

export const onboardingSchema = z.object({
  displayName: z.string().trim().min(1, "请填写称呼").max(40, "称呼过长"),
  examName: z.string().trim().min(1).max(60).default("CET-6 2026-12"),
  examDate: isoDate,
  targetScore: z.coerce
    .number()
    .int("目标分数必须是整数")
    .min(220, "CET-6 总分低于 220 无意义")
    .max(710, "CET-6 总分上限为 710"),
  weekdayMinutes: z.coerce
    .number()
    .int()
    .min(0, "不能为负数")
    .max(600, "单日学习时间上限为 600 分钟"),
  weekendMinutes: z.coerce.number().int().min(0).max(600, "单日学习时间上限为 600 分钟"),
});

export type OnboardingFormValues = z.input<typeof onboardingSchema>;

export const diagnosticAnswerSchema = z.object({
  itemId: z.string().min(1),
  dimension: z.enum(["vocabulary", "listening", "reading", "writing", "translation"]),
  choiceId: z.string().nullable(),
  text: z.string().nullable(),
  skipped: z.boolean(),
});

export const diagnosticSubmissionSchema = z.object({
  sessionId: z.string().min(1),
  answers: z.array(diagnosticAnswerSchema).min(1, "没有任何作答"),
});

export const taskSubmissionSchema = z.object({
  taskId: z.string().min(1),
  /** 客观题作答 */
  answers: z
    .array(
      z.object({
        questionId: z.string().min(1),
        choiceId: z.string().nullable(),
      }),
    )
    .default([]),
  /** 主观题作答 */
  writing: z.string().default(""),
  /** 复习任务勾选 */
  reviewedItemIds: z.array(z.string()).default([]),
  /** 实际用时（分钟），由前端计时得出；缺失时用估算值 */
  elapsedMinutes: z.coerce.number().min(0).max(600).optional(),
});

export type TaskSubmission = z.infer<typeof taskSubmissionSchema>;

export const settingsGoalSchema = z.object({
  examName: z.string().trim().min(1).max(60),
  examDate: isoDate,
  targetScore: z.coerce.number().int().min(220).max(710),
});

export const settingsPreferencesSchema = z.object({
  weekdayMinutes: z.coerce.number().int().min(0).max(600),
  weekendMinutes: z.coerce.number().int().min(0).max(600),
});

export const availableMinutesSchema = z.coerce
  .number()
  .int()
  .min(0, "不能为负数")
  .max(600, "单日上限 600 分钟");

/** 把 zod 错误压成单条可展示文案。 */
export function firstIssueMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "输入无效";
  const path = issue.path.join(".");
  return path ? `${path}: ${issue.message}` : issue.message;
}
