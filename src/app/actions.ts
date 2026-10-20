"use server";

import { revalidatePath } from "next/cache";
import { getRepositories } from "@/repositories/sqlite";
import { completeOnboarding, updateGoal, updatePreferences } from "@/services/onboarding";
import { gradeSession, startDiagnostic, submitDiagnostic } from "@/services/diagnostic";
import { ensurePlan, setAvailableMinutes } from "@/services/plan";
import { submitTask, type SubmissionFeedback } from "@/services/practice";
import {
  firstIssueMessage,
  onboardingSchema,
  settingsGoalSchema,
  settingsPreferencesSchema,
} from "@/lib/validation";
import { todayISO } from "@/lib/date";
import type { ActionResult, DiagnosticAnswerInput, TaskAnswerInput } from "@/types/actions";
import type { OnboardingFormValues } from "@/lib/validation";

/**
 * Server Actions —— 唯一的写入入口。
 *
 * 每个 action 只做三件事：校验 → 调用 service → 使缓存失效。
 * 业务逻辑一律不写在这里，因为脚本与测试无法通过 HTTP 复用 action。
 */

function requireProfileId(): string | null {
  return getRepositories().learner.getProfile()?.id ?? null;
}

function revalidateAll() {
  revalidatePath("/today");
  revalidatePath("/diagnostic");
  revalidatePath("/progress");
  revalidatePath("/settings");
  revalidatePath("/onboarding");
}

export async function submitOnboardingAction(
  values: OnboardingFormValues,
): Promise<ActionResult<{ profileId: string }>> {
  const parsed = onboardingSchema.safeParse(values);
  if (!parsed.success) {
    return { ok: false, error: firstIssueMessage(parsed.error) };
  }
  try {
    const result = completeOnboarding(getRepositories(), parsed.data);
    if (!result.ok) return { ok: false, error: result.error };
    revalidateAll();
    return { ok: true, data: { profileId: result.profile.id } };
  } catch (error) {
    return { ok: false, error: `保存失败：${(error as Error).message}` };
  }
}

export async function startDiagnosticAction(): Promise<ActionResult<{ sessionId: string }>> {
  const profileId = requireProfileId();
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };
  try {
    const session = startDiagnostic(getRepositories(), profileId);
    revalidatePath("/diagnostic");
    return { ok: true, data: { sessionId: session.id } };
  } catch (error) {
    return { ok: false, error: `无法开始诊断：${(error as Error).message}` };
  }
}

export async function submitDiagnosticAction(input: {
  sessionId: string;
  answers: DiagnosticAnswerInput[];
}): Promise<ActionResult<{ sessionId: string }>> {
  const profileId = requireProfileId();
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };

  try {
    const result = submitDiagnostic(getRepositories(), input);
    if (!result.ok) return { ok: false, error: result.error };

    // 诊断完成即刻生成今日计划 —— 产品路径要求"做完诊断就看到今天该做什么"
    ensurePlan(getRepositories(), profileId, todayISO(), { generatedBy: "diagnostic_initial" });
    revalidateAll();
    return { ok: true, data: { sessionId: result.sessionId } };
  } catch (error) {
    return { ok: false, error: `提交失败：${(error as Error).message}` };
  }
}

/** 重新计算诊断结论（规则更新后用于刷新画像，不新增作答）。 */
export async function regradeDiagnosticAction(): Promise<ActionResult<undefined>> {
  const profileId = requireProfileId();
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };
  const profile = getRepositories().skillProfile.get(profileId);
  if (!profile?.basedOnDiagnosticId) return { ok: false, error: "还没有可重新计算的诊断结果。" };
  gradeSession(getRepositories(), profile.basedOnDiagnosticId);
  revalidateAll();
  return { ok: true, data: undefined };
}

/** 用户调整今天可用时间 → 计划重排。 */
export async function setTodayMinutesAction(minutes: number): Promise<ActionResult<{ plannedMinutes: number }>> {
  const profileId = requireProfileId();
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };
  const result = setAvailableMinutes(getRepositories(), profileId, minutes, todayISO());
  if (!result.ok) return { ok: false, error: result.error };
  revalidateAll();
  return { ok: true, data: { plannedMinutes: result.plan.plannedForMinutes } };
}

/** 手动重新生成今日计划。 */
export async function regeneratePlanAction(): Promise<ActionResult<undefined>> {
  const profileId = requireProfileId();
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };
  ensurePlan(getRepositories(), profileId, todayISO(), { force: true });
  revalidateAll();
  return { ok: true, data: undefined };
}

export async function submitTaskAction(input: {
  taskId: string;
  answers: TaskAnswerInput[];
  writing: string;
  reviewedItemIds: string[];
  elapsedMinutes?: number;
}): Promise<ActionResult<SubmissionFeedback>> {
  const profileId = requireProfileId();
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };

  try {
    const result = await submitTask(getRepositories(), profileId, input);
    if (!result.ok) return { ok: false, error: result.error };
    revalidateAll();
    return { ok: true, data: result.feedback };
  } catch (error) {
    return { ok: false, error: `提交失败：${(error as Error).message}` };
  }
}

export async function updateGoalAction(input: {
  examName: string;
  examDate: string;
  targetScore: number;
}): Promise<ActionResult<undefined>> {
  const profileId = requireProfileId();
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };
  const parsed = settingsGoalSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssueMessage(parsed.error) };

  try {
    updateGoal(getRepositories(), profileId, parsed.data);
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: `保存失败：${(error as Error).message}` };
  }
}

export async function updatePreferencesAction(input: {
  weekdayMinutes: number;
  weekendMinutes: number;
}): Promise<ActionResult<undefined>> {
  const profileId = requireProfileId();
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };
  const parsed = settingsPreferencesSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: firstIssueMessage(parsed.error) };

  try {
    updatePreferences(getRepositories(), profileId, parsed.data);
    // 偏好变了，今天之后的计划需要按新时间重建
    ensurePlan(getRepositories(), profileId, todayISO(), { force: true });
    revalidateAll();
    return { ok: true, data: undefined };
  } catch (error) {
    return { ok: false, error: `保存失败：${(error as Error).message}` };
  }
}

/** 把今天剩余任务标记为顺延，明天计划会重新考虑它们。 */
export async function deferRemainingAction(): Promise<ActionResult<{ moved: number }>> {
  const profileId = requireProfileId();
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };
  const { deferRemainingTasks } = await import("@/services/plan");
  const result = deferRemainingTasks(getRepositories(), profileId, todayISO());
  revalidateAll();
  return { ok: true, data: { moved: result.moved } };
}
