import type { ISODate } from "@/domain/types";

/**
 * 日期工具。
 *
 * 两条明确规则，避免此前 UTC / 本地时区混用导致的 off-by-one：
 *
 * 1. **"今天是哪一天"用本地时区**（`todayISO`）。用户在东八区，早上 8 点前不该被算成前一天。
 * 2. **YYYY-MM-DD 之间的算术一律时区无关**。纯日期字符串代表"日历上的一天"，
 *    不含时刻，因此统一以 UTC 午夜为锚点做差与偏移 —— 结果与机器时区无关，
 *    在 UTC、东八区、西五区下都得到同一个日历答案。
 *
 * 反例（此前实现的问题）：`daysUntil` 用 UTC 解析，而 `parseISODate`/`diffDays` 用本地时区构造，
 * 同一对日期在不同时区可能得出相差 1 天的结果。
 */

const MS_PER_DAY = 86_400_000;

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(value: string): value is ISODate {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const time = Date.parse(`${value}T00:00:00Z`);
  return !Number.isNaN(time);
}

/** 本地时区的"今天"。这是唯一读取系统时钟的日期函数。 */
export function todayISO(): ISODate {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** 把 Date 转成本地时区的 YYYY-MM-DD。 */
export function formatISODate(date: Date): ISODate {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * 解析纯日期为 UTC 午夜的毫秒数。
 * 内部使用；调用方不应直接依赖它，以免再次引入时区混用。
 */
function toEpochDay(iso: ISODate): number {
  const time = Date.parse(`${iso}T00:00:00Z`);
  if (Number.isNaN(time)) {
    throw new Error(`非法日期：${iso}（应为 YYYY-MM-DD）`);
  }
  return time;
}

/** 时区无关的自然日差（to - from）。 */
export function diffDays(from: ISODate, to: ISODate): number {
  return Math.round((toEpochDay(to) - toEpochDay(from)) / MS_PER_DAY);
}

/** 时区无关的日期偏移。 */
export function addDays(iso: ISODate, days: number): ISODate {
  const shifted = new Date(toEpochDay(iso) + days * MS_PER_DAY);
  return shifted.toISOString().slice(0, 10);
}

/** 时区无关的星期判定：0=周日 … 6=周六。 */
export function weekdayOf(iso: ISODate): number {
  return new Date(toEpochDay(iso)).getUTCDay();
}

export function isWeekendISO(iso: ISODate): boolean {
  const day = weekdayOf(iso);
  return day === 0 || day === 6;
}

/** 用于展示的日期对象。仅用于取年月日与星期，不做算术。 */
export function parseISODate(iso: ISODate): Date {
  return new Date(toEpochDay(iso));
}

export function nowISO(): string {
  return new Date().toISOString();
}

const WEEKDAYS_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 展示用日期。使用 UTC 取件，因此与服务器时区无关。 */
export function formatDisplayDate(iso: ISODate): string {
  const date = parseISODate(iso);
  return `${date.getUTCMonth() + 1} 月 ${date.getUTCDate()} 日 ${WEEKDAYS_ZH[date.getUTCDay()]}`;
}

/** 相对时间描述，用于活动记录。 */
export function relativeDay(iso: ISODate, today: ISODate): string {
  const delta = diffDays(iso, today);
  if (delta === 0) return "今天";
  if (delta === 1) return "昨天";
  if (delta === 2) return "前天";
  if (delta < 0) return `${-delta} 天后`;
  return `${delta} 天前`;
}
