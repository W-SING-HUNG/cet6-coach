import { redirect } from "next/navigation";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";

/**
 * 必须动态渲染。
 *
 * 这个页面读数据库并根据用户状态重定向。若被静态预渲染（Next.js 默认会尝试），
 * 构建时的重定向目标会被永久固化 —— 实测中表现为：数据库里已有 profile，
 * 访问 / 仍然被送去 /onboarding，循环无法跳出。
 */
export const dynamic = "force-dynamic";

/** 入口分流：未 onboarding → onboarding；未诊断 → diagnostic；否则 Today。 */
export default async function RootPage() {
  const state = getOnboardingState(getRepositories());
  if (!state.onboarded) redirect("/onboarding");
  if (!state.skillProfile?.basedOnDiagnosticId) redirect("/diagnostic");
  redirect("/today");
}
