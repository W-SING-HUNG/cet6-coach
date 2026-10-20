import { redirect } from "next/navigation";
import Link from "next/link";
import { Info } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getDiagnosticOutcome } from "@/services/diagnostic";
import { todayISO } from "@/lib/date";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { ActivityHeat } from "./activity-heat";
import {
  DIMENSION_LABELS,
  MASTERY_LABELS,
  SKILL_LABELS,
  type DiagnosticDimension,
  type Skill,
} from "@/domain/types";
import { cn } from "@/lib/utils";

export const metadata = { title: "进度" };
export const dynamic = "force-dynamic";

/**
 * Progress —— 支持决策的数据展示。
 *
 * ── 明确不做的事 ──
 * 不显示"CET 预测分"。没有验证依据的分数预测会误导决策
 * （PRODUCT_PRINCIPLES 第 7 节、第 15 条）。
 *
 * ── 反"虚荣仪表盘" ──
 * v2 删掉了 v1 里纯粹装饰性的元素：
 * · 每个模块分数下面的横向进度条（把 0–100 的估计画成进度条，
 *   暗示"完成度"—— 它不是完成度，是一个估计值）；
 * · 错因分布里的条形图（4–8 个标签的计数用小条表示，读者仍需看数字，
 *   条形只贡献噪声）。
 * 保留图形化的只有"训练量热力"—— 它确实回答一个决策问题：
 * "我最近有没有持续在练"。
 *
 * ── 保留的语义契约（不得改动）──
 * · 章节文本「四个计分模块的能力估计」（E2E 用它定位这一区块）。
 * · `data-testid="progress-{status}-{skill}"`（E2E 断言听力必须带无结论徽标）。
 * · 两种"无结论"状态（`unassessed` / `insufficient_evidence`）与"已评估"
 *   互斥，且**不显示分数** —— "没测过"与"水平差"是两件事。
 * · 不得出现"已评估"与"信息不足"同时成立的表述。
 *
 * ── 宽度 ──
 * 属于 `wide` 外壳。宽画布下能力模块用 4 列（一屏看完四个模块），
 * 而不是 v1 的 2 列窄卡。
 */
export default async function ProgressPage() {
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const profileId = state.profile.id;
  const today = todayISO();
  const skillProfile = repos.skillProfile.get(profileId);
  const outcome = getDiagnosticOutcome(repos, profileId);
  const activity = repos.records.getActivity(profileId, 28, today);
  const sessions = repos.records.listRecentSessions(profileId, 20);
  const attempts = repos.records.listRecentAttempts(profileId, 60);

  const totalMinutes = activity.reduce((sum, a) => sum + a.minutes, 0);
  const activeDays = activity.filter((a) => a.minutes > 0).length;
  const totalTasks = activity.reduce((sum, a) => sum + a.tasksCompleted, 0);

  const errorCounts = new Map<string, number>();
  for (const attempt of attempts) {
    if (attempt.correct) continue;
    for (const tag of attempt.errorTags) {
      errorCounts.set(tag, (errorCounts.get(tag) ?? 0) + 1);
    }
  }
  const topErrors = [...errorCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);

  if (!skillProfile?.basedOnDiagnosticId) {
    return (
      <div className="flex flex-col gap-6">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-content sm:text-[30px]">
          进度
        </h1>
        <EmptyState
          title="还没有能力画像"
          description="完成诊断后才能看到能力估计随训练的变化。没有基线的话，任何曲线都没有解释意义。"
          action={
            <Link href="/diagnostic">
              <Button>去做诊断</Button>
            </Link>
          }
        />
      </div>
    );
  }

  const skills = Object.keys(skillProfile.skills) as Skill[];

  return (
    <div className="flex flex-col gap-6">
      <header className="border-b border-edge pb-5">
        <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-4">
          <div className="min-w-0">
            <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-content sm:text-[30px]">
              进度
            </h1>
            <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-content-soft">
              下面每类数据都有明确的证据来源：训练量来自学习记录，能力估计来自诊断加训练证据，
              错因来自逐题结果。
            </p>
          </div>

          <dl className="flex shrink-0 flex-wrap gap-x-7 gap-y-3">
            <HeaderStat label="近 28 天时长" value={`${totalMinutes}`} unit="分钟" sub={`${activeDays} 天有记录`} />
            <HeaderStat label="完成任务数" value={`${totalTasks}`} unit="个" sub="近 28 天" />
            <HeaderStat
              label="训练记录"
              value={`${sessions.length}`}
              unit="次"
              sub={sessions.length > 0 ? `最近 ${sessions[0].finishedAt.slice(0, 10)}` : "还没有记录"}
            />
          </dl>
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          {/*
            章节标题保持原文 —— 它是 E2E 的定位锚点。
          */}
          <section aria-labelledby="skills-heading">
            <h2 id="skills-heading" className="text-[15px] font-semibold tracking-tight text-content">
              四个计分模块的能力估计
            </h2>
            <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-content-soft">
              初始值来自诊断，之后随着训练证据按权重混合。训练证据不会完全推翻一次完整诊断。
            </p>

            <ul className="mt-4 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
              {skills.map((skill) => {
                const s = skillProfile.skills[skill];
                // 两种"无结论"状态都不显示分数：
                // unassessed = 没有测量工具；insufficient_evidence = 证据不够。
                const noConclusion = s.status !== "assessed";
                const badge =
                  s.status === "unassessed"
                    ? "尚未有效评估"
                    : s.status === "insufficient_evidence"
                      ? "证据不足"
                      : null;
                return (
                  <li
                    key={skill}
                    className={cn(
                      "rounded-md border px-3.5 py-3",
                      noConclusion
                        ? "border-dashed border-edge-strong bg-surface/60"
                        : "border-edge bg-surface-raised",
                    )}
                  >
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-[13.5px] font-medium text-content">{SKILL_LABELS[skill]}</p>
                      {badge ? (
                        <span
                          data-testid={`progress-${s.status}-${skill}`}
                          className="shrink-0 rounded-sm border border-edge-strong bg-surface px-1.5 py-0.5 text-[11px] text-content-soft"
                        >
                          {badge}
                        </span>
                      ) : (
                        <p className="tabular text-[22px] leading-none font-semibold text-content">
                          {s.score}
                        </p>
                      )}
                    </div>

                    {noConclusion ? (
                      <p className="mt-2 text-[12px] leading-relaxed text-content-soft">
                        {s.status === "unassessed"
                          ? (s.unassessedReason ?? "该模块当前缺少有效测量手段。")
                          : "该模块可以测，但目前的证据还不足以给出分数与结论。"}
                      </p>
                    ) : (
                      <p className="mt-2 text-[11.5px] text-content-faint">
                        {MASTERY_LABELS[s.mastery]} · 证据 {s.evidenceCount} 条
                        {s.confidence === "low" ? " · 方向性估计" : ""}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {outcome ? (
            <section aria-labelledby="dimensions-heading">
              <h2
                id="dimensions-heading"
                className="text-[15px] font-semibold tracking-tight text-content"
              >
                五个维度的诊断明细
              </h2>
              <div className="mt-3 overflow-hidden rounded-md border border-edge bg-surface-raised">
                {outcome.dimensionResults.map((result, i) => (
                  <div
                    key={result.dimension}
                    className={cn(
                      "flex items-center gap-3 px-4 py-2.5",
                      i !== outcome.dimensionResults.length - 1 && "border-b border-edge",
                    )}
                  >
                    <span className="w-14 shrink-0 text-[13px] text-content">
                      {DIMENSION_LABELS[result.dimension]}
                    </span>
                    {/*
                      保留一条细的分数示意 —— 但**只在有真实分数时**渲染。
                      无结论维度显示空的轨道 + "—"，视觉上明确"这里没有数字"。
                    */}
                    <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-sunken">
                      <div
                        className={cn(
                          "h-full",
                          result.status !== "assessed"
                            ? "bg-transparent"
                            : result.confidence === "low"
                              ? "bg-content-faint/40"
                              : "bg-accent/80",
                        )}
                        style={{ width: `${result.status === "assessed" ? result.adjustedScore : 0}%` }}
                      />
                    </div>
                    <span className="tabular w-9 shrink-0 text-right font-mono text-[12.5px] text-content-soft">
                      {result.status === "assessed" ? result.adjustedScore : "—"}
                    </span>
                    <span className="w-16 shrink-0 text-right font-mono text-[11px] text-content-faint">
                      {result.status === "assessed"
                        ? `${result.gradedItems} 题`
                        : result.status === "unassessed"
                          ? "未评估"
                          : "证据不足"}
                    </span>
                  </div>
                ))}
              </div>
              <p className="mt-2 max-w-2xl text-[12px] leading-relaxed text-content-faint">
                维度明细来自诊断作答，按当前规则重算。诊断维度（含词汇）与计分模块不是同一个集合：
                词汇没有独立分值，通过权重影响阅读、写作、翻译。
              </p>
            </section>
          ) : null}

          <section aria-labelledby="errors-heading">
            <h2 id="errors-heading" className="text-[15px] font-semibold tracking-tight text-content">
              错因分布
            </h2>
            {topErrors.length === 0 ? (
              <p className="mt-3 rounded-md border border-edge bg-surface-raised px-4 py-3.5 text-[13px] leading-relaxed text-content-soft">
                还没有足够的错题记录。做过训练任务后，这里会按错因标签聚合，
                重复出现的错因会推动计划调整训练权重。
              </p>
            ) : (
              /*
                用「标签 + 计数」的紧凑列表，而不是条形图。
                理由：读者需要的判断是"哪个错因占比最大"，
                这由排序 + 计数就能回答；为 8 个标签画 8 条等宽小条并不帮助判断。
              */
              <ul className="mt-3 divide-y divide-edge overflow-hidden rounded-md border border-edge bg-surface-raised">
                {topErrors.map(([tag, count], i) => (
                  <li key={tag} className="flex items-center gap-3 px-4 py-2.5">
                    <span className="tabular w-6 shrink-0 font-mono text-[12px] text-content-faint">
                      {i + 1}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-mono text-[12.5px] text-content-soft">
                      {tag}
                    </span>
                    <span className="tabular shrink-0 text-[13px] font-medium text-content">{count}</span>
                    <span className="shrink-0 text-[11.5px] text-content-faint">次</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <section aria-labelledby="activity-heading">
            <h2
              id="activity-heading"
              className="text-[15px] font-semibold tracking-tight text-content"
            >
              训练量分布
            </h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-content-soft">
              深色表示当天有训练记录。空白的天不影响任何进度 —— 计划会重排，不需要补打卡。
            </p>
            <div className="mt-3">
              <ActivityHeat activity={activity} />
            </div>
          </section>

          {skillProfile.weaknesses.length > 0 ? (
            <section aria-labelledby="weaknesses-heading">
              <h2
                id="weaknesses-heading"
                className="text-[15px] font-semibold tracking-tight text-content"
              >
                记录在案的弱点
              </h2>
              <ul className="mt-3 flex flex-col gap-2.5">
                {skillProfile.weaknesses.map((weakness) => (
                  <li
                    key={weakness.id}
                    className="rounded-md border border-edge bg-surface-raised px-3.5 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-[13.5px] font-medium text-content">{weakness.label}</p>
                      <span className="rounded-sm border border-edge-strong px-1.5 py-px font-mono text-[10px] text-content-faint">
                        {weakness.source === "diagnostic"
                          ? "诊断"
                          : weakness.source === "practice"
                            ? "训练"
                            : "手动"}
                      </span>
                    </div>
                    <p className="mt-1.5 text-[12.5px] leading-relaxed text-content-soft">
                      {weakness.detail}
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <section className="rounded-md border border-edge-strong bg-surface-raised px-3.5 py-3.5">
            <p className="flex items-start gap-2 text-[12.5px] leading-relaxed text-content-soft">
              <Info className="mt-px size-3.5 shrink-0 text-content-faint" />
              <span>
                <span className="font-medium text-content">这里没有 CET-6 预测分。</span>
                16 道诊断题加若干次训练不足以支撑可靠的分数预测，显示一个看似精确的数字只会误导复习决策。
                要看的是：弱项是否在被训练、错因是否在减少、训练量是否可持续。
              </span>
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}

function HeaderStat({
  label,
  value,
  unit,
  sub,
}: {
  label: string;
  value: string;
  unit: string;
  sub: string;
}) {
  return (
    <div>
      <dt className="text-[11.5px] text-content-faint">{label}</dt>
      <dd className="mt-0.5 flex items-baseline gap-1.5">
        <span className="tabular text-[24px] leading-none font-semibold text-content">{value}</span>
        <span className="text-[12px] text-content-faint">{unit}</span>
      </dd>
      <dd className="mt-1 text-[11.5px] text-content-faint">{sub}</dd>
    </div>
  );
}

export type { DiagnosticDimension };
