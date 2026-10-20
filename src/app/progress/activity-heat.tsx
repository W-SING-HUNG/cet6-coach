"use client";

import { cn } from "@/lib/client-utils";

/** 28 天训练量热图。用方块密度表达一致性，不用折线图 —— 学习节奏不是连续量。 */
export function ActivityHeat({
  activity,
}: {
  activity: Array<{ date: string; minutes: number; tasksCompleted: number }>;
}) {
  const max = Math.max(...activity.map((a) => a.minutes), 60);

  function intensity(minutes: number): number {
    if (minutes === 0) return 0;
    const ratio = minutes / max;
    if (ratio < 0.25) return 1;
    if (ratio < 0.5) return 2;
    if (ratio < 0.8) return 3;
    return 4;
  }

  const levelClass = [
    "bg-surface-sunken border-edge",
    "bg-accent/20 border-accent/20",
    "bg-accent/40 border-accent/25",
    "bg-accent/65 border-accent/30",
    "bg-accent border-accent",
  ];

  return (
    <div className="rounded-md border border-edge bg-surface-raised px-4 py-4">
      <div className="grid grid-cols-[repeat(14,minmax(0,1fr))] gap-1.5 sm:grid-cols-[repeat(28,minmax(0,1fr))]">
        {activity.map((day) => (
          <div
            key={day.date}
            className={cn("aspect-square rounded-[2px] border", levelClass[intensity(day.minutes)])}
            title={`${day.date}：${day.minutes} 分钟 · ${day.tasksCompleted} 个任务`}
          />
        ))}
      </div>
      <div className="mt-3 flex items-center gap-2 border-t border-edge pt-3">
        <span className="text-[11px] text-content-faint">少</span>
        {[0, 1, 2, 3, 4].map((level) => (
          <span key={level} aria-hidden className={cn("size-2.5 rounded-[2px] border", levelClass[level])} />
        ))}
        <span className="text-[11px] text-content-faint">多</span>
        <span className="ml-auto font-mono text-[11px] text-content-faint">近 28 天</span>
      </div>
    </div>
  );
}
