/**
 * CET-6 官方考试信息的**单一事实来源**。
 *
 * 为什么单独成文件：考试日期此前散落在 service、seed、tests、fixtures 中重复硬编码，
 * 结果一处写错（2026-12-19）就扩散到 6 个文件。现在所有代码只引用这里，
 * 下一次官方改期只需要改一处。
 *
 * 事实来源：教育部教育考试院「全国大学英语四、六级考试报名网」公布的
 * 2026 年下半年考试安排 —— 笔试日期 2026-12-12，CET-6 为当日下午。
 * 见 src/domain/exam-facts.ts 与本文件的单一事实来源说明。
 */

/** 官方笔试日期（CET-4 上午 / CET-6 下午同一天）。 */
export const CET6_EXAM_DATE = "2026-12-12" as const;

/** 官方考试名称，用于 onboarding 默认值与界面展示。 */
export const CET6_EXAM_NAME = "CET-6 2026-12" as const;

/**
 * CET-6 当日的开考时间（本地时间，中国标准时间）。
 * 用途：仅在需要说明"考试在当天下午"时展示，不参与任何日期计算。
 */
export const CET6_SESSION_START = "15:00" as const;

/** 官方公布来源，便于日后核对与追溯。 */
export const CET6_EXAM_DATE_SOURCE =
  "教育部教育考试院 全国大学英语四、六级考试报名网（2026 年下半年笔试：2026-12-12）";
