import { notFound, redirect } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, ArrowRight, BookOpenCheck } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getTaskDetail, resolveLegacyReadingTask } from "@/services/practice";
import { Notice } from "@/components/ui/states";
import { getContentView } from "./content-view";
import { TaskRunner } from "./task-runner";

export const metadata = { title: "训练" };
export const dynamic = "force-dynamic";

/**
 * 旧任务执行器路由。
 *
 * ── 它在本次收敛中的角色 ──
 *
 * 这个路由仍然服务**写作 / 翻译 / 复习 / 词汇**任务：它们依赖内容库里各自的
 * 素材（原创 prompt 与词表），与真实真题无关，因此本次不改动它们的行为。
 *
 * **阅读训练不再走这里。** 产品规则要求面向学习者的 CET-6 阅读训练只有一条
 * 规范路径（真实历年真题 → Expert Training 工作面 → 不可变台账）。
 * 因此本页对阅读类任务做两件事之一：
 *
 * 1. 能解析到可用的真实真题阅读大题 → **重定向**到 Expert Training。
 *    这是最诚实的兑现方式：用户点的是"练阅读"，就把他送到规范工作面。
 * 2. 解析不到（真题库为空 / 该卷被设为模考保留 / 内容包不可用）→
 *    **如实说明不可用**，并给出恢复路径。
 *
 * 关键约束：**第 2 条绝不回退到合成阅读篇章。** 旧实现会在这种情况下
 * 把 `practice-library.ts` 的原创篇章渲染成一个看起来正常的训练页 ——
 * 那正是产品决定淘汰的行为（自造材料冒充 CET-6 阅读训练）。
 */
export default async function PracticeTaskPage({ params }: { params: Promise<{ taskId: string }> }) {
  const { taskId } = await params;
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const detail = getTaskDetail(repos, taskId);
  if (!detail) notFound();

  const profileId = state.profile.id;

  /*
   * 阅读任务的收敛出口。
   *
   * 必须在渲染任何内容之前判定 —— 否则历史计划行会在这一帧里
   * 被渲染成合成阅读页，哪怕下一秒就被重定向，那也已经晚了：
   * 页面的 HTML 一旦生成，合成篇章就已经下发过一次。
   */
  const legacyReading = resolveLegacyReadingTask(repos, profileId, detail.task);
  if (legacyReading.kind === "redirect") {
    redirect(legacyReading.href);
  }
  if (legacyReading.kind === "blocked") {
    return <UnavailableReading reason={legacyReading.reason} />;
  }

  const contentView = getContentView(detail);
  const dueItems =
    detail.task.kind === "review"
      ? repos.review
          .getDueItems(profileId, new Date().toISOString().slice(0, 10))
          .map((item) => ({ id: item.id, prompt: item.prompt, skill: item.skill, dueOn: item.dueOn }))
      : [];

  return (
    <div>
      <Link
        href="/today"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-content-faint transition-colors hover:text-content"
      >
        <ArrowLeft className="size-3.5" />
        返回 Today
      </Link>

      <TaskRunner
        task={{
          id: detail.task.id,
          title: detail.task.title,
          kind: detail.task.kind,
          skill: detail.task.skill,
          priority: detail.task.priority,
          rationale: detail.task.rationale,
          estimatedMinutes: detail.task.estimatedMinutes,
          status: detail.task.status,
        }}
        content={contentView}
        unavailableReason={detail.unavailableReason}
        dueItems={dueItems}
      />
    </div>
  );
}

/**
 * 阅读训练不可用状态。
 *
 * 三条出路，没有一条是死胡同：回到 Today 重排、去真题库导入/调整卷子。
 * 文案必须说清**为什么**不可用 —— 这三个原因（库为空、卷子被保留、
 * 内容升版）对用户是完全不同的事，笼统的"暂无内容"会把它们混成一件事。
 */
function UnavailableReading({ reason }: { reason: string }) {
  return (
    <div className="mx-auto max-w-2xl">
      <Link
        href="/today"
        className="mb-5 inline-flex items-center gap-1.5 text-[13px] text-content-faint transition-colors hover:text-content"
      >
        <ArrowLeft className="size-3.5" />
        返回 Today
      </Link>

      <p className="font-mono text-[10px] tracking-[0.16em] text-content-faint uppercase">Reading</p>
      <h1 className="mt-1.5 text-[24px] leading-tight font-semibold tracking-tight text-content">
        这条阅读训练当前不可用
      </h1>
      <p className="mt-2.5 text-[13.5px] leading-relaxed text-content-soft">
        面向 CET-6 的阅读训练只使用真实历年真题。这条任务无法解析到可用的真题材料，
        因此它不会退回到产品自造的练习题 —— 那类内容不能代表真实考试的难度与陷阱结构。
      </p>

      <Notice tone="warn" className="mt-5" title="具体原因">
        {reason}
      </Notice>

      <div className="mt-5 flex flex-wrap items-center gap-2.5 border-t border-edge pt-4">
        <Link
          href="/practice/papers"
          className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-accent bg-surface-raised px-3.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent hover:text-surface-raised"
        >
          <BookOpenCheck className="size-4" />
          查看真题库
        </Link>
        <Link
          href="/today"
          className="inline-flex h-9 items-center gap-1.5 rounded-sm border border-edge-strong px-3.5 text-[13px] font-medium text-content transition-colors hover:border-content-faint"
        >
          返回 Today
          <ArrowRight className="size-3.5" />
        </Link>
      </div>
    </div>
  );
}
