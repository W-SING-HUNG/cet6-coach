"use client";

import { cn, formatShortDate } from "@/lib/client-utils";

/** 近 7 天活动柱图。桌面与手机都保持同一信息密度，不做两套。 */
export function WeekPulse({
  activity,
}: {
  activity: Array<{ date: string; minutes: number; tasksCompleted: number }>;
}) {
  const max = Math.max(...activity.map((a) => a.minutes), 60);
  const totalMinutes = activity.reduce((sum, a) => sum + a.minutes, 0);
  const activeDays = activity.filter((a) => a.minutes > 0).length;

  return (
    <div className="rounded-md border border-edge bg-surface-raised p-6">
      <div className="flex items-end justify-between gap-1.5">
        {activity.map((day) => {
          const height = day.minutes === 0 ? 3 : Math.max(6, Math.round((day.minutes / max) * 56));
          return (
            <div key={day.date} className="flex flex-1 flex-col items-center gap-2">
              <span className="tabular font-mono text-[10px] text-content-faint">
                {day.minutes > 0 ? day.minutes : ""}
              </span>
              <div
                className="w-full max-w-9 rounded-sm bg-surface-sunken"
                style={{ height: 56 }}
                title={`${day.date}：${day.minutes} 分钟 · ${day.tasksCompleted} 个任务`}
              >
                <div
                  className={cn(
                    "mt-auto w-full rounded-sm transition-[height] duration-500",
                    day.minutes === 0 ? "bg-edge-strong" : "bg-accent/75",
                  )}
                  style={{ height, marginTop: 56 - height }}
                />
              </div>
              <span className="font-mono text-[10px] text-content-faint">{formatShortDate(day.date)}</span>
            </div>
          );
        })}
      </div>

      <p className="mt-3.5 border-t border-edge pt-3 text-[12px] leading-relaxed text-content-faint">
        7 天共 {totalMinutes} 分钟，{activeDays} 天有学习记录。
        {activeDays < 7
          ? " 有空白的天完全正常 —— 计划会重排，不需要补打卡。"
          : " 保持了稳定节奏。"}
      </p>
    </div>
  );
}
