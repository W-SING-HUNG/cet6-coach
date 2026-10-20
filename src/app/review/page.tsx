import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, Layers } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { todayISO } from "@/lib/date";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { SKILL_LABELS } from "@/domain/types";
import { relativeDay } from "@/lib/date";

export const metadata = { title: "复习" };
export const dynamic = "force-dynamic";

/**
 * Review —— "现在什么值得我注意"。
 *
 * ── v1 的问题 ──
 * 它先花一整块篇幅解释"这个队列怎么实现的"（固定间隔、FSRS 字段已预留、
 * 启用后可看板会变），然后才给出到期列表。那是**实现说明**，
 * 不是学习者的决策依据。学习者打开这一页只想知道：
 * 现在有没有该复习的、有几项、都是什么。
 *
 * ── v2 的排序：可行动项优先 ──
 * 1. 到期项（可立即行动）—— 最上层，最显眼，直接可进入。
 * 2. 即将到期（不可行动但有信息价值）—— 收在下面，压缩为单行列表。
 * 3. 诚实说明（固定间隔、不推断掌握度）—— 移到末尾，缩短为一句。
 *
 * ── 诚实性边界（不得越过的措辞）──
 * 复习队列是"错题次日重现"的**固定间隔**规则，不是记忆强度调度。
 * 因此这一页**不**说"你快要忘了"这类推断 —— 系统并不知道遗忘程度；
 * 它只知道某题到了重现时间。同理不得把"错过 1 次"写成"没掌握"。
 */
export default async function ReviewPage() {
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const today = todayISO();
  const due = repos.review.getDueItems(state.profile.id, today);
  const all = repos.review.listAll(state.profile.id);
  const upcoming = all.filter((item) => item.dueOn > today);

  return (
    <div className="flex flex-col gap-6">
      <header className="border-b border-edge pb-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-content sm:text-[30px]">
              复习队列
            </h1>
            <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-content-soft">
              做错的内容会自动进入这里。这一页只回答一件事：<strong className="font-medium text-content">现在有没有该复习的</strong>。
            </p>
          </div>

          <div className="flex shrink-0 gap-6">
            <Metric label="今天到期" value={due.length} tone={due.length > 0 ? "accent" : "neutral"} />
            <Metric label="队列总数" value={all.length} />
          </div>
        </div>
      </header>

      <section aria-labelledby="due-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="due-heading" className="text-[15px] font-semibold tracking-tight text-content">
            今天到期
            {due.length > 0 ? (
              <span className="tabular ml-2 font-mono text-[12px] font-normal text-content-faint">
                {due.length} 项
              </span>
            ) : null}
          </h2>
          {due.length > 0 ? <p className="text-[12.5px] text-content-faint">按到期时间排列</p> : null}
        </div>

        {due.length === 0 ? (
          <EmptyState
            icon={<Layers className="size-6" />}
            title="今天没有需要复习的内容"
            description={
              all.length === 0
                ? "还没有任何复习项。做完训练任务后，答错的内容会自动出现在这里 —— 这是正常状态，不是功能缺失。"
                : `复习队列里有 ${all.length} 项内容，但都还没到重现的时间。`
            }
            action={
              <Link href="/today">
                <Button variant="secondary" size="sm" icon={<ArrowRight className="size-3.5" />}>
                  去 Today 做训练
                </Button>
              </Link>
            }
          />
        ) : (
          /*
            可行动项用宽画布的两列栅格：一屏能看到全部到期项，
            而不是一条窄列往下排。每一项是独立可扫的条目，不是卡片。
          */
          <ul className="grid gap-2.5 lg:grid-cols-2">
            {due.map((item) => (
              <li
                key={item.id}
                className="flex flex-col rounded-md border border-edge bg-surface-raised px-4 py-3"
              >
                <p className="text-[14px] leading-relaxed text-content">{item.prompt}</p>
                <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge pt-2 font-mono text-[11px] text-content-faint">
                  <span>{SKILL_LABELS[item.skill]}</span>
                  <span>到期 {relativeDay(item.dueOn, today)}</span>
                  <span>已复习 {item.reps} 次</span>
                  {item.lapses > 0 ? <span className="text-warn">错过 {item.lapses} 次</span> : null}
                </p>
              </li>
            ))}
          </ul>
        )}
      </section>

      {upcoming.length > 0 ? (
        <section aria-labelledby="upcoming-heading">
          <h2
            id="upcoming-heading"
            className="mb-3 text-[15px] font-semibold tracking-tight text-content"
          >
            即将到期
            <span className="tabular ml-2 font-mono text-[12px] font-normal text-content-faint">
              {upcoming.length} 项
            </span>
          </h2>
          {/*
            不可行动的信息压缩为单行列表 —— 它有价值（让人知道队列在推进），
            但不值得占用卡片级别的高度。
          */}
          <ul className="grid gap-x-6 gap-y-1.5 overflow-hidden rounded-md border border-edge bg-surface-raised px-4 py-3 lg:grid-cols-2">
            {upcoming.slice(0, 12).map((item) => (
              <li
                key={item.id}
                className="flex items-baseline justify-between gap-3 text-[13px]"
              >
                <span className="min-w-0 truncate text-content-soft">{item.prompt}</span>
                <span className="shrink-0 font-mono text-[11px] text-content-faint">
                  {relativeDay(item.dueOn, today)}
                </span>
              </li>
            ))}
            {upcoming.length > 12 ? (
              <li className="text-[12px] text-content-faint">还有 {upcoming.length - 12} 项未显示。</li>
            ) : null}
          </ul>
        </section>
      ) : null}

      {/*
        诚实说明放在末尾并压到一句：
        它是必要的边界声明，但它不是这一页的主线内容。
      */}
      <p className="border-t border-edge pt-4 text-[12.5px] leading-relaxed text-content-faint">
        到期规则是「错题次日重现」的固定间隔，不是基于记忆强度的自适应调度 ——
        系统只知道某题到了重现时间，并不知道你遗忘了多少。
        数据库字段已为 FSRS 预留，启用后这一页的行为会真正变化。
      </p>
    </div>
  );
}

function Metric({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "accent";
}) {
  return (
    <div>
      <p className="text-[11.5px] text-content-faint">{label}</p>
      <p
        className={
          tone === "accent"
            ? "tabular mt-0.5 text-[26px] leading-none font-semibold text-accent"
            : "tabular mt-0.5 text-[26px] leading-none font-semibold text-content"
        }
      >
        {value}
      </p>
    </div>
  );
}
