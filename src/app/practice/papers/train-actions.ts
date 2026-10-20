"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getRepositories } from "@/repositories/sqlite";
import { startReadingRun, submitReadingRun } from "@/services/expert-training";
import type { ActionResult } from "@/types/actions";

/**
 * 真实真题阅读训练的写入入口。
 *
 * 只有两个动作，且都对应**显式的用户意图**：
 *
 * 1. `startReadingRunAction` —— 用户点了"开始/继续训练"。
 * 2. `submitReadingRunAction` —— 用户点了"交卷"。
 *
 * 为什么"开始"必须是显式动作而不是页面加载时顺手创建：
 * 若 GET 就创建会话，每次误点与刷新都会留下一个空会话。
 * 那会让"练过几次"这类计数变得毫无意义，也让台账里堆满没有观测的空 run。
 */

export async function startReadingRunAction(formData: FormData): Promise<void> {
  const repos = getRepositories();
  const profileId = repos.learner.getProfile()?.id ?? null;
  if (!profileId) redirect("/onboarding");

  const paperId = String(formData.get("paperId") ?? "");
  const sectionId = String(formData.get("sectionId") ?? "");
  if (!paperId || !sectionId) redirect("/practice/papers");

  const result = startReadingRun(repos, profileId, paperId, sectionId);
  const base = `/practice/papers/${paperId}/train/${sectionId}`;

  if (!result.ok) {
    // 失败必须可见。把原因带到页面上，而不是静默回到原状 ——
    // 一个点了没反应的按钮是产品缺陷。
    redirect(`${base}?error=${encodeURIComponent(result.error)}`);
  }

  revalidatePath(base);
  revalidatePath(`/practice/papers/${paperId}`);
  revalidatePath("/today");
  redirect(base);
}

export async function submitReadingRunAction(input: {
  paperId: string;
  sectionId: string;
  runId: string;
  responses: Array<{ questionId: string; value: string | null }>;
  elapsedSeconds: number | null;
  changedQuestionIds: string[];
}): Promise<ActionResult<{ runId: string }>> {
  const repos = getRepositories();
  const profileId = repos.learner.getProfile()?.id ?? null;
  if (!profileId) return { ok: false, error: "请先完成 onboarding。" };

  const result = submitReadingRun(repos, profileId, {
    runId: input.runId,
    responses: input.responses,
    elapsedSeconds: input.elapsedSeconds,
    changedQuestionIds: input.changedQuestionIds,
  });

  if (!result.ok) {
    return { ok: false, error: result.error };
  }

  const base = `/practice/papers/${input.paperId}/train/${input.sectionId}`;
  revalidatePath(base);
  revalidatePath("/practice/papers");
  revalidatePath(`/practice/papers/${input.paperId}`);
  revalidatePath("/today");
  return { ok: true, data: { runId: result.result.runId } };
}
