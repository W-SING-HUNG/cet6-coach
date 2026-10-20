import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** 0-1 分数 → 中文等级标签 */
export function scoreBand(score: number): string {
  if (score >= 0.85) return "很好";
  if (score >= 0.7) return "不错";
  if (score >= 0.5) return "一般";
  return "需要加强";
}

export function minutesLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`;
}
