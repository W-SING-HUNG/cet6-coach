"use client";

import Link from "next/link";
import { CheckCircle2, Circle, Clock, Lock } from "lucide-react";
import { cn, minutesLabel } from "@/lib/utils";
import { PRIORITY_LABELS, SKILL_LABELS, type Skill, type TaskPriority } from "@/domain/types";

/**
 * 今日任务列表。
 *
 * 关键决策：不可执行的任务（素材未就绪）显示为锁定态并给出原因，
 * 而不是渲染一个点了没反应的按钮。
 */

interface TaskItem {
  id: string;
  /** 面向学习者的标题（阅读任务已投影为真实真题目标的措辞）。 */
  title: string;
  rationale: string;
  priority: TaskPriority;
  skill: Skill;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "skipped";
  /** 面向学习者的时长；`null` 表示没有可信的数字（不编造）。 */
  estimatedMinutes: number | null;
  contentReady: boolean;
  pendingReason: string | null;
  /** 目标 URL，由服务层解析（阅读任务指向真实真题工作面）。 */
  href: string;
  /** 是否为真实历年真题阅读训练 —— 界面据此标注来源，不再靠 kind 猜。 */
  isRealPaperReading: boolean;
  /**
   * 这个真实真题目标已被今天另一条更优先的任务占用（同一个大题）。
   *
   * 界面对这类任务**不提供独立 CTA** —— 两个按钮指向同一份材料、
   * 却是两句不同的话，会让学习者先做一次无意义的取舍。
   */
  canonicalDuplicate: boolean;
}

export function TaskList({ tasks }: { tasks: TaskItem[] }) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-edge-strong bg-surface-raised px-5 py-8 text-center">
        <p className="text-[13px] text-content-soft">今天没有任务。</p>
        <p className="mt-1 text-[12px] text-content-faint">
          时间设为 0 时会出现这种情况。把时间调高，计划会重新生成。
        </p>
      </div>
    );
  }

  const ordered = [...tasks].sort((a, b) => {
    const rank = { completed: 2, skipped: 3, in_progress: 0, pending: 1 } as const;
    if (rank[a.status] !== rank[b.status]) return rank[a.status] - rank[b.status];
    /*
     * 同一状态组内按时长升序（先易后难）。
     *
     * 早先这里是 `a.estimatedMinutes - b.estimatedMinutes ? 0 : 0` ——
     * 一个恒返回 0 的死表达式，实际从未排序。现在写清意图，
     * 并把**没有可信时长**的项（`null`，见 `displayMinutes`）排到同组末尾：
     * 它们不该因为"没有数字"而挤到需要时间估算的位置前面。
     */
    if (a.estimatedMinutes === null && b.estimatedMinutes === null) return 0;
    if (a.estimatedMinutes === null) return 1;
    if (b.estimatedMinutes === null) return -1;
    return a.estimatedMinutes - b.estimatedMinutes;
  });

  return (
    <ol className="overflow-hidden rounded-md border border-edge bg-surface-raised">
      {ordered.map((task, index) => (
        <li
          key={task.id}
          className={cn(
            "relative px-6 py-5",
            index !== ordered.length - 1 && "border-b border-edge",
            task.status === "completed" && "bg-surface-sunken/45",
          )}
        >
          <div className="flex items-start gap-3">
            <span className="mt-0.5 shrink-0">
              {task.status === "completed" ? (
                <CheckCircle2 className="size-[18px] text-succ" />
              ) : task.contentReady ? (
                <Circle className="size-[18px] text-edge-strong" />
              ) : (
                <Lock className="size-[18px] text-warn/70" />
              )}
            </span>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <p
                  className={cn(
                    "text-[14px] font-medium",
                    task.status === "completed" ? "text-content-faint line-through" : "text-content",
                  )}
                >
                  {task.title}
                </p>
                <PriorityTag priority={task.priority} />
                <span className="font-mono text-[10px] tracking-wider text-content-faint">
                  {SKILL_LABELS[task.skill]}
                </span>
                {/*
                  来源必须可见：真实历年真题与内容库里的原创素材
                  绝不能长得一样（内容政策门禁）。
                */}
                {task.isRealPaperReading ? (
                  <span className="rounded-sm border border-accent/30 bg-accent-soft px-1.5 py-px text-[10.5px] font-medium text-accent">
                    真实历年真题
                  </span>
                ) : null}
              </div>

              <p className="mt-1 text-[12px] leading-relaxed text-content-faint">
                <Clock className="mr-1 inline size-3 align-[-1px]" />
                {/* 没有可信时长时只显示理由，不显示一个编造的数字 */}
                {task.estimatedMinutes !== null ? (
                  <>
                    {minutesLabel(task.estimatedMinutes)}
                    <span className="mx-1.5">·</span>
                  </>
                ) : null}
                <span className={task.status === "completed" ? "text-content-faint" : "text-content-soft"}>
                  {task.status === "completed" ? doneCopy(task.kind) : task.rationale}
                </span>
              </p>

              {!task.contentReady && task.pendingReason && task.status !== "completed" ? (
                <p className="mt-1.5 rounded-sm border border-warn/25 bg-warn-soft px-2 py-1.5 text-[12px] leading-relaxed text-warn">
                  {task.pendingReason}
                </p>
              ) : null}
            </div>

            <div className="shrink-0">
              {task.status === "completed" ? (
                <span className="rounded-sm border border-succ/25 bg-accent-soft px-2 py-1 text-[11px] font-medium text-accent">
                  已完成
                </span>
              ) : !task.contentReady ? (
                <span className="rounded-sm border border-warn/25 bg-warn-soft px-2 py-1 text-[11px] font-medium text-warn">
                  不可用
                </span>
              ) : task.canonicalDuplicate ? (
                /*
                  同一目标已由更优先的那条任务承载 → 不给独立 CTA。
                  给一个说明而不是第二个按钮：用户点哪个都会去同一个地方。
                */
                <span className="rounded-sm border border-edge-strong bg-surface px-2 py-1 text-[11px] text-content-faint">
                  与上一条同一部分
                </span>
              ) : (
                <Link
                  href={task.href}
                  className="inline-block rounded-sm border border-accent px-3 py-1.5 text-[12px] font-medium text-accent transition-colors hover:bg-accent hover:text-surface-raised"
                >
                  开始
                </Link>
              )}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function PriorityTag({ priority }: { priority: TaskPriority }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-1.5 py-px font-mono text-[10px] tracking-wide",
        priority === "core"
          ? "border-accent/30 bg-accent-soft text-accent"
          : priority === "recommended"
            ? "border-edge-strong text-content-soft"
            : "border-edge text-content-faint",
      )}
    >
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

function doneCopy(kind: string): string {
  const map: Record<string, string> = {
    reading_comprehension: "已完成，错题已加入复习队列。",
    vocabulary_recall: "已完成，错词已加入复习队列。",
    translation_drill: "已完成，已生成反馈。",
    writing_drill: "已完成，已生成反馈。",
    review: "已完成复习，序列已顺延。",
    listening_comprehension: "已完成。",
  };
  return map[kind] ?? "已完成。";
}
