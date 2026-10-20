import type { ISODate, ISODateTime, Skill, TaskPriority } from "./types";
import type { CourseExposureEventType } from "./course";

// ---------------------------------------------------------------------------
// 用户与目标
// ---------------------------------------------------------------------------

export interface StudyPreferences {
  /** 工作日常规可投入分钟数 */
  weekdayMinutes: number;
  /** 周末常规可投入分钟数 */
  weekendMinutes: number;
}

export interface LearnerProfile {
  id: string;
  displayName: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  preferences: StudyPreferences;
}

export interface ExamGoal {
  id: string;
  profileId: string;
  examName: string; // 例如 "CET-6 2026-12"
  examDate: ISODate;
  targetScore: number;
  /** 历史成绩仅作参考，绝不参与预测；记录它是为了之后的真实基线对比。 */
  scoreHistory: ScoreRecord[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface ScoreRecord {
  exam: string;
  score: number;
  takenOn: ISODate;
  note?: string;
}

// ---------------------------------------------------------------------------
// 诊断
// ---------------------------------------------------------------------------

export type DiagnosticItemType = "mcq" | "short_text" | "pending_media";

export interface DiagnosticChoice {
  id: string;
  label: string;
}

export interface DiagnosticItem {
  id: string;
  dimension: import("./types").DiagnosticDimension;
  type: DiagnosticItemType;
  /** 难度 1-3，用于之后做分层估计，Phase 1 只用于展示与加权。 */
  difficulty: 1 | 2 | 3;
  prompt: string;
  /** 阅读/写作/翻译类题目的材料 */
  passage?: string;
  choices?: DiagnosticChoice[];
  correctChoiceId?: string;
  /** 选择题在提交后展示的解析 */
  explanation?: string;
  /** 主观题评分要点，供本地 rubric grader 使用；选择题不需要 */
  rubricPoints?: string[];
  /** 听力等暂无素材的题型，用这个字段说明为什么是 pending */
  pendingReason?: string;
  estimatedSeconds: number;
  tags: string[];
}

export interface DiagnosticAnswer {
  itemId: string;
  dimension: import("./types").DiagnosticDimension;
  /** 选择题所选 id；主观题为 null */
  choiceId: string | null;
  /** 主观题作答文本 */
  text: string | null;
  /** 是否跳过（跳过不等于答错，会降低 confidence） */
  skipped: boolean;
  submittedAt: ISODateTime;
}

export interface DiagnosticItemResult {
  itemId: string;
  dimension: import("./types").DiagnosticDimension;
  correct: boolean | null; // 主观 rubric 得分 >= 阈值视为 correct
  earnedPoints: number;
  maxPoints: number;
  skipped: boolean;
}

export type ConfidenceLevel = "low" | "medium" | "high";

export interface DimensionResult {
  dimension: import("./types").DiagnosticDimension;
  /** 0-100 的原始正确率，仅代表本次诊断，不代表 CET 分数 */
  rawScore: number;
  /** 0-100，向 50 收缩后的稳健估计 */
  adjustedScore: number;
  mastery: import("./types").MasteryLevel;
  confidence: ConfidenceLevel;
  /**
   * 评估状态。`unassessed` 时 `rawScore` / `adjustedScore` / `mastery` / `confidence`
   * 都不构成能力结论，UI 必须据此显示"尚未有效评估"，不得显示分数或强弱。
   */
  status: import("./types").AssessmentStatus;
  /** status 为 unassessed 时，说明为什么缺少有效测量手段 */
  unassessedReason: string | null;
  /** 该维度实际计分的题量 */
  gradedItems: number;
  skippedItems: number;
  /** 证据：逐题结果摘要 */
  evidence: DiagnosticItemResult[];
}

export interface Weakness {
  id: string;
  dimension: import("./types").DiagnosticDimension;
  affectedSkills: Skill[];
  label: string;
  detail: string;
  severity: number; // 1-3
  source: "diagnostic" | "practice" | "manual";
}

export interface Recommendation {
  skill: Skill;
  dimension: import("./types").DiagnosticDimension;
  reason: string;
  /** 建议的每日训练权重占比，0-1，合计约为 1 */
  weight: number;
  priority: TaskPriority;
}

export interface DiagnosticSession {
  id: string;
  profileId: string;
  startedAt: ISODateTime;
  completedAt: ISODateTime | null;
  itemIds: string[];
  answers: DiagnosticAnswer[];
  results: DiagnosticItemResult[];
  dimensionResults: DimensionResult[];
  weaknesses: Weakness[];
  recommendations: Recommendation[];
  /** 是否因为中途放弃而部分完成 */
  partial: boolean;
}

// ---------------------------------------------------------------------------
// 能力画像
// ---------------------------------------------------------------------------

export interface SkillState {
  skill: Skill;
  /**
   * 0-100 稳健估计。`status === "unassessed"` 时该值**不是测量结果**，
   * 仅为占位，UI 与 planner 都不得使用它做任何比较或排序。
   */
  score: number;
  mastery: import("./types").MasteryLevel;
  confidence: ConfidenceLevel;
  /** 评估状态；unassessed 表示缺少有效测量手段 */
  status: import("./types").AssessmentStatus;
  unassessedReason: string | null;
  /** 该估计基于多少条证据（诊断题 + 训练作答） */
  evidenceCount: number;
  lastUpdatedAt: ISODateTime;
}

export interface SkillProfile {
  id: string;
  profileId: string;
  updatedAt: ISODateTime;
  skills: Record<Skill, SkillState>;
  dimensions: DimensionResult[];
  weaknesses: Weakness[];
  recommendations: Recommendation[];
  /**
   * 缺少有效测量手段的模块说明（例如未评估的听力）。
   * 刻意与 weaknesses 分开：它是"重要但尚未测量"，不是"有问题"。
   */
  unassessedNotices: import("./scoring").UnassessedNotice[];
  /** 诊断是否已完成 —— Today 依赖这个状态决定显示什么 */
  basedOnDiagnosticId: string | null;
}

// ---------------------------------------------------------------------------
// 计划与任务
// ---------------------------------------------------------------------------

export interface DailyPlan {
  id: string;
  profileId: string;
  date: ISODate;
  /** 当天实际可用分钟数（可能被用户临时修改） */
  availableMinutes: number;
  /** 生成计划时采用的分钟数，用于对比"原计划 vs 实际可用" */
  plannedForMinutes: number;
  tasks: StudyTask[];
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
  /** 计划被重排的次数。用于呈现"我为你重排过 N 次"这种诚实信息。 */
  revisionCount: number;
  /** 该计划由哪次生成策略产生 */
  generatedBy: "diagnostic_initial" | "deterministic_planner" | "carry_over";
  notes: string[];
  /**
   * planner 生成的提示（时间不足、短日模式、放不下的内容等）。
   * 必须落库：这些提示是用户理解"为什么今天的计划变了"的唯一来源，
   * 丢弃它们会让计划在用户眼里显得随机。
   */
  warnings: string[];
}

export interface TaskContentRef {
  contentType: import("./types").TaskContentType;
  contentId: string;
}

export interface StudyTask {
  id: string;
  planId: string;
  kind: import("./types").TaskKind;
  skill: Skill;
  priority: TaskPriority;
  title: string;
  rationale: string;
  estimatedMinutes: number;
  contentRef: TaskContentRef | null;
  status: "pending" | "in_progress" | "completed" | "skipped";
  completedAt: ISODateTime | null;
  order: number;
}

// ---------------------------------------------------------------------------
// 作答与记录
// ---------------------------------------------------------------------------

export interface AnswerAttempt {
  id: string;
  taskId: string | null;
  profileId: string;
  contentItemId: string;
  answerText: string | null;
  choiceId: string | null;
  correct: boolean;
  score: number; // 0-1
  feedback: string;
  errorTags: string[];
  createdAt: ISODateTime;
}

export interface StudySession {
  id: string;
  profileId: string;
  taskId: string | null;
  kind: import("./types").TaskKind;
  skill: Skill;
  startedAt: ISODateTime;
  finishedAt: ISODateTime;
  durationMinutes: number;
  correctCount: number;
  totalCount: number;
  score: number; // 0-1
  feedbackSummary: string;
}

export interface ErrorTag {
  id: string;
  label: string;
  dimension: import("./types").DiagnosticDimension;
  affectedSkills: Skill[];
  description: string;
}

// ---------------------------------------------------------------------------
// 复习队列（Phase 1 只做确定性到期排序，不接 FSRS）
// ---------------------------------------------------------------------------

export interface ReviewItem {
  id: string;
  profileId: string;
  contentItemId: string;
  contentRef: TaskContentRef;
  skill: Skill;
  /** 便于呈现给用户的简短提示 */
  prompt: string;
  dueOn: ISODate;
  /** ts-fsrs 预留字段；Phase 1 写入默认值，调度器未启用 */
  stability: number;
  difficulty: number;
  reps: number;
  lapses: number;
  lastReviewedOn: ISODate | null;
  createdAt: ISODateTime;
}

// ---------------------------------------------------------------------------
// Expert Training 事实台账（V1）
//
// 分层依据：content-policy/LEARNING_MODEL.md 第 1 节 —— 观测 ≠ 解释 ≠ 假设 ≠ 主张。
// 这里只描述**观测**与其**评分结果**，不含任何机制/因果字段。
// 机制假设属于后续阶段的 MechanismHypothesis，不是本文件的范围。
// ---------------------------------------------------------------------------

/**
 * 一次真实真题阅读训练会话。
 *
 * 范围刻意是"试卷的某个阅读大题"：它既是一次可在有限时间内做完的训练单元，
 * 也是可解释的证据范围（同一篇材料上的若干题）。
 *
 * ── 关于 `abandoned` ──
 *
 * 会话是**观测的容器**，不是观测本身（观测在 `PerformanceEvent`，且不可变）。
 * 因此改会话状态与"改写历史"是两件不同的事：
 *
 * - `in_progress` → `completed`：用户交卷了。
 * - `in_progress` → `abandoned`：这个会话永远不会再有观测了。
 *
 * 后者只在一种情况下发生：**内容升版**使一个未提交的会话无法继续
 * （旧会话的题面属于旧版本，不能拿新包去渲染）。此时把它标为已废弃，
 * 让用户能重新开始 —— 否则那部分训练会**永久卡死**，因为旧会话挡住了新会话。
 * 它没有产生任何观测（观测只在交卷时写入），因此废弃不丢任何事实。
 */
export interface LearningRun {
  id: string;
  profileId: string;
  paperId: string;
  /** 事件发生时的内容版本 —— 内容升版后旧事实仍指向它当时的那一版。 */
  contentVersion: number;
  sectionId: string;
  sectionType: string;
  groupIds: string[];
  status: "in_progress" | "completed" | "abandoned";
  itemCount: number;
  startedAt: ISODateTime;
  submittedAt: ISODateTime | null;
  durationSeconds: number | null;
  createdAt: ISODateTime;
}

/**
 * 不可变的作答观测。**记录发生了什么，不记录为什么。**
 *
 * 刻意不存在的字段：mechanism / weakness / errorTag / diagnosis / cause。
 * 一旦允许在观测里写解释，后续所有统计都会把解释当成事实
 * （LEARNING_MODEL 第 1 节的不变式）。
 */
export interface PerformanceEvent {
  id: string;
  runId: string;
  profileId: string;
  /** 稳定真实引用：五项合起来唯一确定"当时的那一道题"。 */
  paperId: string;
  contentVersion: number;
  sectionId: string;
  groupId: string;
  questionId: string;
  questionNumber: number | null;
  questionKind: string;
  responseKind: string;
  responseValue: string | null;
  outcome: "correct" | "incorrect" | "skipped";
  /** 可靠测量到才有值；未测到为 null，绝不猜。 */
  durationSeconds: number | null;
  /** 真实观测到改答案才为 true。 */
  answerChanged: boolean;
  attemptKind: "first_attempt" | "review_attempt";
  gradingSource: string;
  gradingVersion: string;
  sequence: number;
  occurredAt: ISODateTime;
}

/**
 * 评分结果。**可版本化，但不可覆盖历史。**
 *
 * 重新评分（rubric 修订 / 评分者更换）时追加一条新记录并指向被取代的那条，
 * 原有记录保留 —— 因为"当时被判定为 X"与"用今天的标准回看是 Y"
 * 是两个不同的事实，都可能是真的。
 */
export interface AssessmentEvent {
  id: string;
  performanceEventId: string;
  rubricVersion: string;
  outcome: "correct" | "incorrect" | "skipped";
  score: number;
  gradingSource: string;
  supersedesId: string | null;
  note: string | null;
  assessedAt: ISODateTime;
}

/** 可重建的低层派生信号投影。删空后可由不可变事件完整重算。 */
export interface EvidenceProjectionRow {
  profileId: string;
  signal: string;
  value: number;
  computedAt: ISODateTime;
}

/** 批改版本的单一来源。任何判分逻辑变化都必须递增它，否则重评无法与旧结果区分。 */
export const LOCAL_RUBRIC_VERSION = "reading-v1";

// ---------------------------------------------------------------------------
// 课程层（Course Layer）：只追加的课程曝光
// ---------------------------------------------------------------------------

/**
 * 课程曝光观测。**学习者见过/学过一段课程材料。**
 *
 * ── 它与 `PerformanceEvent` 的区别是本类型存在的全部理由 ──
 *
 * 课程曝光**不是表现证据**。它不含 outcome / score / correct / mastery，
 * 也不指向某道真题 —— 因为一段课程材料完全可能在"还不知道它对应哪道题"
 * 的时候就被学过了（课程层允许未匹配无限期存在）。
 *
 * 一旦把 canonical 目标写进曝光的主身份，那段历史就永久无法在日后
 * 人工核验出对应关系时被**回溯投影**到那道真题上 —— 信息在那时被丢弃了。
 * 因此曝光只引用 `(profile, course, segment, 当时看到的内容版本)`，
 * 链接关系留在 `course_canonical_link`，投影属于后续阶段。
 *
 * 与 `PerformanceEvent` 共享的两条纪律：
 * - **只追加**（数据库触发器守护，不是应用层约定）；
 * - **内容版本参与引用** —— 课程升版后旧曝光仍指向它当时的那一版，
 *   绝不合并成一条。
 */
export interface CourseExposureEvent {
  id: string;
  profileId: string;
  courseId: string;
  segmentId: string;
  /** 学习者**当时实际看到的那一版**课程内容。 */
  courseContentVersion: number;
  eventType: CourseExposureEventType;
  occurredAt: ISODateTime;
}
