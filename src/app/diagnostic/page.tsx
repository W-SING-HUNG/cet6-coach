import Link from "next/link";
import { redirect } from "next/navigation";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { estimateDiagnosticMinutes, getDiagnosticItems } from "@/services/diagnostic";
import { DiagnosticRunner } from "./diagnostic-runner";

export const metadata = { title: "诊断" };
// 依据"是否已完成诊断"做重定向，必须请求时渲染
export const dynamic = "force-dynamic";

export default async function DiagnosticPage() {
  const repos = getRepositories();
  const state = getOnboardingState(repos);

  if (!state.onboarded || !state.profile) {
    redirect("/onboarding");
  }

  // 已完成诊断 → 直接看结果，避免用户重复作答
  if (state.skillProfile?.basedOnDiagnosticId) {
    redirect("/diagnostic/result");
  }

  const items = getDiagnosticItems();

  return (
    <div className="mx-auto w-full max-w-2xl">
      <header className="mb-7">
        <p className="mb-2 font-mono text-[11px] uppercase tracking-[0.18em] text-content-faint">Diagnostic</p>
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-content sm:text-[32px]">
          能力诊断
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-content-soft">
          {items.length} 题，约 {estimateDiagnosticMinutes()} 分钟。不会的题可以直接跳过 —— 跳过会被记录为「证据不足」，
          比乱猜更有价值，因为它不会污染你的能力估计。
        </p>
        <p className="mt-2 text-[13px] leading-relaxed text-content-faint">
          结果是本次作答的稳健估计，用来决定先练什么。
          <strong className="font-medium text-content-soft">它不是 CET-6 分数预测。</strong>
        </p>
      </header>

      <DiagnosticRunner
        items={items.map((item) => ({
          id: item.id,
          dimension: item.dimension,
          type: item.type,
          difficulty: item.difficulty,
          prompt: item.prompt,
          passage: item.passage ?? null,
          choices: item.choices ?? null,
          pendingReason: item.pendingReason ?? null,
          estimatedSeconds: item.estimatedSeconds,
        }))}
      />

      <p className="mt-6 text-center text-[12px] text-content-faint">
        想先看看别处？
        <Link href="/today" className="ml-1 underline decoration-edge-strong underline-offset-2 hover:text-content">
          返回 Today
        </Link>
      </p>
    </div>
  );
}
