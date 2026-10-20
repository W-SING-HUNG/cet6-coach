import Link from "next/link";
import { redirect } from "next/navigation";
import { AlertTriangle, ArrowRight, Info, Target, TrendingUp } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getDiagnosticOutcome } from "@/services/diagnostic";
import { getOnboardingState } from "@/services/onboarding";
import { Panel, PageHeader } from "@/components/ui/panel";
import { Notice } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { DIMENSION_LABELS, MASTERY_LABELS, ASSESSMENT_STATUS_LABELS, SKILL_LABELS, SKILL_WEIGHTS, type AssessmentStatus, type DiagnosticDimension } from "@/domain/types";
import type { ConfidenceLevel } from "@/domain/models";
import { cn } from "@/lib/utils";

export const metadata = { title: "诊断结果" };
// 结论来自数据库中的作答，必须请求时渲染
export const dynamic = "force-dynamic";

/**
 * 置信度文案。
 *
 * 关键：low confidence ≠ 没有结论。当 status 为 assessed 时，低置信度表示
 * "这是方向性估计，样本较少"，而不是"信息不足"。把两者说成同一件事，
 * 会让分数与文案互相矛盾（页面上出现"分数 75"却写"证据不足"）。
 */
const CONFIDENCE_COPY: Record<ConfidenceLevel, { label: string; detail: string; tone: string }> = {
  low: { label: "方向性估计", detail: "样本较少，方向可参考但不宜当定论", tone: "text-content-faint" },
  medium: { label: "中等把握", detail: "足以决定先练什么，不足以定论", tone: "text-content-soft" },
  high: { label: "较高把握", detail: "题量与表现都较一致", tone: "text-accent" },
};

export default async function DiagnosticResultPage() {
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const outcome = getDiagnosticOutcome(repos, state.profile.id);
  if (!outcome) redirect("/diagnostic");

  const { dimensionResults, weaknesses, recommendations, unassessedNotices, partial } = outcome;

  return (
    <div className="mx-auto w-full max-w-3xl">
      <PageHeader
        eyebrow="Diagnostic Result"
        title="你的能力画像"
        lead="下面每个维度的分数是本次作答的稳健估计：答对率会向 50 收缩，题量越少收缩越强，避免把几道题的偶然结果当成能力结论。"
      />

      {partial ? (
        <Notice tone="warn" className="mt-5" title="这是一次部分完成的诊断">
          有题目被跳过或未作答。跳过的题按「证据不足」处理，不会记为答错，但会降低对应维度的置信度。
          你可以随时在 Settings 里重新做一次完整诊断。
        </Notice>
      ) : null}

      <section className="mt-6">
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-content">五个能力维度</h2>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {dimensionResults.map((result, i) => (
            <DimensionCard key={result.dimension} result={result} delay={i} />
          ))}
        </div>
      </section>

      <section className="mt-8">
        <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-content">识别到的薄弱项</h2>
        {weaknesses.length === 0 ? (
          <Panel className="text-[13px] leading-relaxed text-content-soft">
            本次诊断没有识别出置信度足够的薄弱项。这通常意味着两种可能：各维度表现接近且都在中等以上，
            或者题量太少无法形成判断。无论哪种，都建议先按官方分值权重的默认计划练起来，几周后再用训练数据重新评估。
          </Panel>
        ) : (
          <div className="flex flex-col gap-2.5">
            {weaknesses.map((weakness) => (
              <Panel key={weakness.id} className="border-warn/22 bg-warn-soft">
                <div className="flex items-start gap-3">
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[14px] font-medium text-content">{weakness.label}</p>
                      <SeverityDots severity={weakness.severity} />
                    </div>
                    <p className="mt-1.5 text-[13px] leading-relaxed text-content-soft">{weakness.detail}</p>
                    <p className="mt-2 text-[12px] text-content-faint">
                      影响模块：
                      {weakness.affectedSkills.map((skill) => SKILL_LABELS[skill]).join("、")}
                      {" · "}
                      来源：{weakness.source === "diagnostic" ? "本次诊断" : weakness.source === "practice" ? "训练记录" : "手动记录"}
                    </p>
                  </div>
                </div>
              </Panel>
            ))}
          </div>
        )}
      </section>

      {unassessedNotices.length > 0 ? (
        <section className="mt-8" data-testid="unassessed-section">
          <h2 className="mb-1.5 text-[15px] font-semibold tracking-tight text-content">
            重要但尚未评估
          </h2>
          <p className="mb-3 text-[13px] leading-relaxed text-content-soft">
            以下模块占卷面比重很高，但当前缺少有效测量手段，因此没有分数，也没有强弱结论。
            它们不是弱项，只是还没有被测量过。
          </p>
          <div className="flex flex-col gap-2.5">
            {unassessedNotices.map((notice) => (
              <Panel key={notice.dimension} className="border-edge bg-surface-sunken/60">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="text-[14px] font-medium text-content">{notice.label}</p>
                  <span
                    className="rounded-sm border border-edge-strong bg-surface-raised px-1.5 py-0.5 text-[11px] text-content-soft"
                  >
                    {ASSESSMENT_STATUS_LABELS.unassessed}
                  </span>
                  <span className="font-mono text-[11px] text-content-faint">
                    占卷面 {Math.round(SKILL_WEIGHTS[notice.dimension as keyof typeof SKILL_WEIGHTS] * 100)}%
                  </span>
                </div>
                <p className="mt-1.5 text-[13px] leading-relaxed text-content-soft">{notice.detail}</p>
                <p className="mt-2 text-[12px] leading-relaxed text-content-faint">
                  下一步：{notice.nextStep}
                </p>
              </Panel>
            ))}
          </div>
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="mb-1.5 text-[15px] font-semibold tracking-tight text-content">初始训练优先级</h2>
        <p className="mb-3 text-[13px] leading-relaxed text-content-soft">
          基准权重取 CET-6 官方分值（听力 35%、阅读 35%、写作 15%、翻译 15%），
          再按诊断结果调整：低于 60 的模块提高占比，明显稳固的模块降低占比，最后归一化。
          这个权重决定之后每天各模块的训练时长。
        </p>
        <div className="overflow-hidden rounded-md border border-edge bg-surface-raised">
          {recommendations.map((rec, i) => (
            <div
              key={rec.skill}
              className={cn(
                "flex items-start gap-3 px-4 py-3.5",
                i !== recommendations.length - 1 && "border-b border-edge",
              )}
            >
              <div className="w-24 shrink-0">
                <p className="text-[13px] font-medium text-content">{SKILL_LABELS[rec.skill]}</p>
                <p className="tabular mt-0.5 font-mono text-[11px] text-content-faint">
                  {Math.round(rec.weight * 100)}%
                </p>
              </div>
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 h-1 w-full overflow-hidden rounded-full bg-surface-sunken">
                  <div
                    className={cn("h-full", rec.priority === "core" ? "bg-accent" : "bg-content-faint")}
                    style={{ width: `${Math.round(rec.weight * 100)}%` }}
                  />
                </div>
                <p className="text-[12px] leading-relaxed text-content-soft">{rec.reason}</p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-sm border px-1.5 py-0.5 font-mono text-[10px]",
                  rec.priority === "core"
                    ? "border-accent/30 bg-accent-soft text-accent"
                    : "border-edge-strong text-content-faint",
                )}
              >
                {rec.priority === "core" ? "核心" : "推荐"}
              </span>
            </div>
          ))}
        </div>
      </section>

      <section className="mt-8">
        <Notice tone="info" title="这个结果能说明什么、不能说明什么">
          <ul className="mt-1.5 space-y-1.5">
            <li className="flex gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <strong className="font-medium text-content">能说明</strong>：哪些模块当前明显偏弱，第一批训练应该把时间放在哪里。
              </span>
            </li>
            <li className="flex gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <strong className="font-medium text-content">不能说明</strong>：你的 CET-6 分数会是多少。这次诊断只有十几道题，
                不足以支撑分数预测，本产品也不会做没有验证依据的预测。
              </span>
            </li>
            <li className="flex gap-2">
              <Info className="mt-0.5 size-3.5 shrink-0" />
              <span>
                <strong className="font-medium text-content">听力</strong>：CET-6 听力考的是音频理解，
                当前没有音频素材，因此它<strong className="font-medium text-content">尚未有效评估</strong> ——
                既不是低分，也不是高分，训练权重暂按官方基准保留。
              </span>
            </li>
          </ul>
        </Notice>
      </section>

      <div className="mt-8 flex flex-col items-start gap-3 border-t border-edge pt-6 sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2 text-[13px] text-content-faint">
          <Target className="size-4" />
          今日计划已根据这份画像生成。
        </p>
        <div className="flex flex-wrap gap-2">
          <Link href="/progress">
            <Button variant="secondary" icon={<TrendingUp className="size-4" />}>
              查看完整进度
            </Button>
          </Link>
          <Link href="/today">
            <Button icon={<ArrowRight className="size-4" />}>去看今天的计划</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}

function DimensionCard({
  result,
  delay,
}: {
  result: {
    dimension: DiagnosticDimension;
    rawScore: number;
    adjustedScore: number;
    mastery: string;
    confidence: ConfidenceLevel;
    status: AssessmentStatus;
    unassessedReason: string | null;
    gradedItems: number;
    skippedItems: number;
  };
  delay: number;
}) {
  // 未评估：不给分数、不给强弱、不给置信度。
  // 显示 0 分或"薄弱"都会把"没测过"曲解成"水平差"，这是测量有效性问题。
  if (result.status === "unassessed") {
    return (
      <Panel className={cn("reveal border-edge bg-surface-sunken/60", `reveal-${Math.min(delay + 1, 4)}`)}>
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[14px] font-medium text-content">{DIMENSION_LABELS[result.dimension]}</p>
          <span
            data-testid="unassessed-badge"
            className="shrink-0 rounded-sm border border-edge-strong bg-surface-raised px-1.5 py-0.5 text-[11px] font-medium text-content-soft"
          >
            尚未有效评估
          </span>
        </div>
        <div
          aria-hidden
          className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full border border-dashed border-edge-strong bg-transparent"
        />
        <p className="mt-2.5 text-[12px] leading-relaxed text-content-soft">
          {result.unassessedReason ?? "该维度当前缺少有效测量手段。"}
        </p>
        <p className="mt-1.5 font-mono text-[11px] text-content-faint">无音频样本 · 不产生分数</p>
      </Panel>
    );
  }

  // 证据不足：测量机制存在，但本次会话没有足够有效证据 → 不显示分数。
  if (result.status === "insufficient_evidence") {
    return (
      <Panel className={cn("reveal border-edge bg-surface-sunken/40", `reveal-${Math.min(delay + 1, 4)}`)}>
        <div className="flex items-baseline justify-between gap-2">
          <p className="text-[14px] font-medium text-content">{DIMENSION_LABELS[result.dimension]}</p>
          <span
            data-testid="insufficient-badge"
            className="shrink-0 rounded-sm border border-edge-strong bg-surface-raised px-1.5 py-0.5 text-[11px] font-medium text-content-soft"
          >
            证据不足
          </span>
        </div>
        <div
          aria-hidden
          className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full border border-dashed border-edge-strong bg-transparent"
        />
        <p className="mt-2.5 text-[12px] leading-relaxed text-content-soft">
          这个维度可以测，但本次作答的有效样本不够，因此不给分数也不下结论。
          完成该维度的题目后，这里会更新为可参考的估计。
        </p>
        <p className="mt-1.5 font-mono text-[11px] text-content-faint">
          计分 {result.gradedItems} 题
          {result.skippedItems > 0 ? ` · 跳过 ${result.skippedItems} 题` : ""} · 未形成结论
        </p>
      </Panel>
    );
  }

  const confidence = CONFIDENCE_COPY[result.confidence];
  return (
    <Panel className={cn("reveal", `reveal-${Math.min(delay + 1, 4)}`)}>
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-[14px] font-medium text-content">{DIMENSION_LABELS[result.dimension]}</p>
        <p className="tabular text-xl font-semibold text-content">{result.adjustedScore}</p>
      </div>
      <div className="mt-2.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken">
        <div
          className={cn(
            "h-full transition-[width] duration-500",
            result.confidence === "low"
              ? "bg-content-faint/45"
              : result.adjustedScore < 40
                ? "bg-danger/70"
                : result.adjustedScore < 58
                  ? "bg-warn/70"
                  : "bg-accent",
          )}
          style={{ width: `${result.adjustedScore}%` }}
        />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px]">
        <span className="text-content-soft">{MASTERY_LABELS[result.mastery as keyof typeof MASTERY_LABELS]}</span>
        <span className={confidence.tone} title={confidence.detail}>
          {confidence.label}
        </span>
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-content-faint">
        计分 {result.gradedItems} 题{result.skippedItems > 0 ? ` · 跳过 ${result.skippedItems} 题` : ""} · 原始正确率{" "}
        {result.rawScore}%
      </p>
    </Panel>
  );
}

function SeverityDots({ severity }: { severity: number }) {
  return (
    <span aria-label={`严重程度 ${severity} / 3`} className="flex gap-0.5">
      {[1, 2, 3].map((level) => (
        <span
          key={level}
          aria-hidden
          className={cn("size-1.5 rounded-full", level <= severity ? "bg-warn" : "bg-edge-strong")}
        />
      ))}
    </span>
  );
}
