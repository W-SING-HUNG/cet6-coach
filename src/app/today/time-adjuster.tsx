"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Clock, Minus, Plus, RotateCcw } from "lucide-react";
import { Notice } from "@/components/ui/states";
import { setTodayMinutesAction, regeneratePlanAction } from "@/app/actions";
import { cn, minutesLabel } from "@/lib/utils";

/**
 * 时间适配器 —— "计划要适应现实生活"的具体实现。
 *
 * 两种输入方式并存：常用档位快选（20/30/60 分钟）和微调按钮。
 * 每次调整都会真实重排计划并落库，不是前端假操作。
 */

const PRESETS = [0, 20, 30, 45, 60, 90] as const;

export function TimeAdjuster({
  availableMinutes,
  regularMinutes,
  isShortDay,
  plannedMinutes,
  completedMinutes,
  deferredMinutes,
}: {
  availableMinutes: number;
  regularMinutes: number;
  isShortDay: boolean;
  plannedMinutes: number;
  completedMinutes: number;
  deferredMinutes: number;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<number | null>(null);

  const shown = optimistic ?? availableMinutes;
  const remaining = Math.max(0, plannedMinutes - completedMinutes);

  function apply(minutes: number) {
    const clamped = Math.max(0, Math.min(600, minutes));
    setError(null);
    setOptimistic(clamped);
    startTransition(async () => {
      const result = await setTodayMinutesAction(clamped);
      if (!result.ok) {
        setError(result.error);
        setOptimistic(null);
        return;
      }
      setOptimistic(null);
      router.refresh();
    });
  }

  return (
    <div className="rounded-md border border-edge bg-surface-raised p-6">
      <div className="flex items-center gap-2">
        <Clock className="size-4 text-content-faint" />
        <h2 className="text-[13px] font-medium text-content">今天有多少时间</h2>
      </div>

      <div className="mt-3 flex items-baseline gap-2">
        <span className="tabular text-3xl leading-none font-semibold text-content">{shown}</span>
        <span className="text-[13px] text-content-faint">分钟</span>
        {shown !== regularMinutes ? (
          <span className="ml-auto text-[12px] text-content-faint">
            常规 {regularMinutes} 分钟
          </span>
        ) : null}
      </div>

      {isShortDay ? (
        <p className="mt-2 text-[12px] leading-relaxed text-warn">
          短日模式：已只保留最高优先级的任务。
        </p>
      ) : null}

      <div className="mt-3 flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset}
            type="button"
            disabled={pending}
            onClick={() => apply(preset)}
            className={cn(
              "tabular h-8 rounded-sm border px-2.5 text-[12px] font-medium transition-colors",
              shown === preset
                ? "border-accent bg-accent-soft text-accent"
                : "border-edge-strong text-content-soft hover:border-content-faint hover:text-content",
              pending && "cursor-not-allowed opacity-55",
            )}
          >
            {preset === 0 ? "没时间" : `${preset}m`}
          </button>
        ))}
      </div>

      <div className="mt-2.5 flex items-center gap-1.5">
        <button
          type="button"
          disabled={pending || shown === 0}
          onClick={() => apply(shown - 10)}
          aria-label="减少 10 分钟"
          className="grid size-8 place-items-center rounded-sm border border-edge-strong text-content-soft transition-colors hover:border-content-faint hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Minus className="size-3.5" />
        </button>
        <button
          type="button"
          disabled={pending || shown >= 600}
          onClick={() => apply(shown + 10)}
          aria-label="增加 10 分钟"
          className="grid size-8 place-items-center rounded-sm border border-edge-strong text-content-soft transition-colors hover:border-content-faint hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
        >
          <Plus className="size-3.5" />
        </button>
        <button
          type="button"
          disabled={pending}
          onClick={() => apply(regularMinutes)}
          className="ml-1 inline-flex h-8 items-center gap-1.5 rounded-sm px-2 text-[12px] text-content-soft transition-colors hover:bg-surface-sunken hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
        >
          <RotateCcw className="size-3.5" />
          用常规值
        </button>
      </div>

      <dl className="mt-3.5 space-y-1.5 border-t border-edge pt-3.5 text-[12px]">
        <div className="flex justify-between">
          <dt className="text-content-faint">计划占用</dt>
          <dd className="tabular text-content-soft">{minutesLabel(plannedMinutes)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-content-faint">剩余</dt>
          <dd className={cn("tabular", remaining === 0 ? "text-warn" : "text-content-soft")}>
            {minutesLabel(remaining)}
          </dd>
        </div>
        {deferredMinutes > 0 ? (
          <div className="flex justify-between">
            <dt className="text-content-faint">顺延</dt>
            <dd className="tabular text-content-faint">{minutesLabel(deferredMinutes)}</dd>
          </div>
        ) : null}
      </dl>

      {pending ? (
        <p className="mt-3 text-[12px] text-content-faint" role="status">
          正在按 {shown} 分钟重排…
        </p>
      ) : null}

      {error ? (
        <Notice tone="danger" className="mt-3">
          {error}
        </Notice>
      ) : null}

      <button
        type="button"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            await regeneratePlanAction();
            router.refresh();
          })
        }
        className="mt-3 w-full rounded-sm border border-edge-strong py-1.5 text-[12px] text-content-soft transition-colors hover:border-content-faint hover:text-content disabled:cursor-not-allowed disabled:opacity-50"
      >
        重新生成计划
      </button>
    </div>
  );
}
