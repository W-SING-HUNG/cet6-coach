import { createHash } from "node:crypto";
import type {
  AnswerAttempt,
  AssessmentEvent,
  CourseExposureEvent,
  DailyPlan,
  DiagnosticAnswer,
  DiagnosticSession,
  EvidenceProjectionRow,
  ExamGoal,
  LearnerProfile,
  LearningRun,
  PerformanceEvent,
  Recommendation,
  ReviewItem,
  SkillProfile,
  StudyPreferences,
  StudySession,
  StudyTask,
  Weakness,
} from "@/domain/models";
import type { DimensionResult } from "@/domain/models";
import type { PaperAsset, PaperProvenance } from "@/content/paper/types";
import type { CourseAsset, CourseProvenance } from "@/content/course/types";
import type {
  CourseExposureEventType,
  CourseLinkTargetScope,
  CourseLinkVerificationStatus,
} from "@/domain/course";
import type {
  PaperExamType,
  PaperPool,
  PaperSectionType,
  PaperSession,
  PaperSourceKind,
  PaperVerificationStatus,
} from "@/domain/paper";
import type { ISODate, Skill } from "@/domain/types";

/**
 * 数据访问边界。
 *
 * 这是 UI/domain 与存储之间唯一的契约。当前实现是 SQLite，
 * 未来换 Supabase/Postgres 时只新增实现类，调用方不动。
 */

export interface OnboardingInput {
  displayName: string;
  preferences: StudyPreferences;
  examName: string;
  examDate: ISODate;
  targetScore: number;
}

export interface LearnerRepository {
  getProfile(): LearnerProfile | null;
  /** 幂等：已存在则更新，不存在则创建。 */
  saveProfile(profileId: string | null, input: OnboardingInput): LearnerProfile;
  updatePreferences(profileId: string, preferences: StudyPreferences): LearnerProfile;
  getGoal(profileId: string): ExamGoal | null;
  saveGoal(profileId: string, input: Omit<OnboardingInput, "displayName" | "preferences">): ExamGoal;
  updateGoal(
    profileId: string,
    patch: { examName?: string; examDate?: ISODate; targetScore?: number },
  ): ExamGoal;
  isOnboarded(): boolean;
}

export interface DiagnosticRepository {
  createSession(profileId: string, itemIds: string[]): DiagnosticSession;
  getSession(id: string): DiagnosticSession | null;
  getLatestSession(profileId: string): DiagnosticSession | null;
  listSessions(profileId: string): DiagnosticSession[];
  saveAnswers(sessionId: string, answers: DiagnosticAnswer[]): void;
  getAnswers(sessionId: string): DiagnosticAnswer[];
  completeSession(
    sessionId: string,
    payload: {
      results: DiagnosticSession["results"];
      dimensionResults: DimensionResult[];
      weaknesses: Weakness[];
      recommendations: Recommendation[];
      partial: boolean;
    },
  ): void;
}

export interface SkillProfileRepository {
  get(profileId: string): SkillProfile | null;
  save(
    profileId: string,
    payload: {
      skills: Record<Skill, SkillProfile["skills"][Skill]>;
      dimensions: DimensionResult[];
      weaknesses: Weakness[];
      recommendations: Recommendation[];
      unassessedNotices: SkillProfile["unassessedNotices"];
      basedOnDiagnosticId: string | null;
    },
  ): SkillProfile;
}

export interface PlanRepository {
  getPlan(profileId: string, date: ISODate): DailyPlan | null;
  getPlanById(planId: string): DailyPlan | null;
  getLatestPlan(profileId: string): DailyPlan | null;
  /** 按日期 upsert 计划，整体替换任务列表（未完成任务的补做在下游处理）。 */
  savePlan(
    profileId: string,
    payload: {
      date: ISODate;
      availableMinutes: number;
      plannedForMinutes: number;
      generatedBy: DailyPlan["generatedBy"];
      notes: string[];
      warnings: string[];
      tasks: Array<Omit<StudyTask, "planId" | "id" | "completedAt"> & { id?: string }>;
    },
  ): DailyPlan;
  updateTaskStatus(
    taskId: string,
    status: StudyTask["status"],
    completedAt: string | null,
  ): StudyTask | null;
  getTask(taskId: string): StudyTask | null;
  /** 查找某日之前仍未完成的 core 任务，用于跨日补做。 */
  getOutstandingCoreTasks(profileId: string, beforeDate: ISODate): StudyTask[];
}

export interface RecordRepository {
  saveSession(session: Omit<StudySession, "id">): StudySession;
  saveAttempts(attempts: Array<Omit<AnswerAttempt, "id">>): AnswerAttempt[];
  listRecentSessions(profileId: string, limit: number): StudySession[];
  listRecentAttempts(profileId: string, limit: number): AnswerAttempt[];
  /** 按日期聚合最近 N 天的学习分钟数与完成任务数。 */
  getActivity(profileId: string, days: number, today: ISODate): Array<{
    date: ISODate;
    minutes: number;
    tasksCompleted: number;
    sessions: number;
  }>;
  /** 已练过的模块，用于 planner 做轮换。 */
  getRecentlyPractisedSkills(profileId: string, sinceDate: ISODate): Skill[];
  /** 训练层面的累计正确率，用于刷新能力画像的证据。 */
  getSkillEvidence(profileId: string): Partial<Record<Skill, { correct: number; total: number }>>;
  countCompletedTasksOn(profileId: string, date: ISODate): number;
}

export interface ReviewRepository {
  getDueItems(profileId: string, onOrBefore: ISODate): ReviewItem[];
  listAll(profileId: string): ReviewItem[];
  upsert(item: Omit<ReviewItem, "id" | "createdAt"> & { id?: string }): ReviewItem;
  markReviewed(id: string, reviewedOn: ISODate, nextDue: ISODate): void;
}

// ---------------------------------------------------------------------------
// 真题试卷索引
// ---------------------------------------------------------------------------

/**
 * 落库的试卷索引记录（不含正文）。
 *
 * 为什么正文不在这里：正文的规范来源是 private-content 下的规范化包。
 * 库里保存的是**可引用、可校验、可比较版本**的那一部分 ——
 * 这使得"内容更新后历史作答不会被静默指向另一道题"成为可实现的约束。
 */
export interface ExamPaperRecord {
  id: string;
  examType: PaperExamType;
  year: number;
  session: PaperSession;
  variant: string;
  examDate: ISODate | null;
  sourceKind: PaperSourceKind;
  verificationStatus: PaperVerificationStatus;
  provenance: PaperProvenance;
  /** 内容版本，单调递增 */
  contentVersion: number;
  /** 是否只包含部分内容（缺大题） */
  partial: boolean;
  /** 包目录相对于内容根的路径 */
  packagePath: string;
  /** paper.json 的 sha256 */
  manifestChecksum: string;
  /**
   * 印出内容的规范指纹。
   *
   * 与 `manifestChecksum` 分工明确：
   * - 本字段判"这是不是同一版**内容**"（元数据变更不影响它）；
   * - `manifestChecksum` 判"文件是否被改动过"。
   *
   * 可为 null：早期导入的行没有该值。
   */
  contentFingerprint: string | null;
  sectionCount: number;
  questionCount: number;
  importedAt: string;
  updatedAt: string;
  /** 试卷在备考策略中的归属，来自 paper_study_state */
  pool: PaperPool;
}

/** 试卷内某个大题的摘要，用于详情页在没有正文时也能如实展示结构。 */
export interface PaperSectionSummary {
  type: PaperSectionType;
  title: string;
  /** 声明顺序 */
  order: number;
}

export interface PaperImportInput {
  record: Omit<ExamPaperRecord, "importedAt" | "updatedAt" | "pool">;
  assets: PaperAsset[];
}

export type PaperImportDecision =
  | { kind: "insert" }
  | { kind: "update"; fromVersion: number; toVersion: number }
  /**
   * 印出内容未变，仅 provenance / 验证说明这类元数据变新。
   *
   * 允许写入，但**不递增 contentVersion** —— 内容是同一版，
   * 涨版本会让历史作答看起来指向了另一版内容。
   */
  | { kind: "metadata_only"; version: number; checksum: string }
  | { kind: "unchanged"; version: number; checksum: string };

export interface PaperRepository {
  listPapers(): ExamPaperRecord[];
  getPaper(id: string): ExamPaperRecord | null;
  /** 按 (examType, year, session, variant) 查重 —— 与唯一约束同一口径。 */
  findByIdentity(identity: {
    examType: PaperExamType;
    year: number;
    session: PaperSession;
    variant: string;
  }): ExamPaperRecord | null;
  listAssets(paperId: string): PaperAsset[];
  getAsset(paperId: string, assetId: string): PaperAsset | null;
  /**
   * 判定一次导入会对现有数据做什么。
   *
   * 必须是**纯查询**：dry-run 与真实导入共用它，
   * 这样"预演结果"与"实际结果"不可能不一致。
   */
  decideImport(record: ExamPaperRecord): PaperImportDecision;
  /**
   * 写入索引与资产。调用方负责把它包在 `repos.transaction` 内 ——
   * 一次导入必须整体成功或整体不写入（由原子性门禁固定）。
   */
  saveImport(input: PaperImportInput, decision: PaperImportDecision): ExamPaperRecord;
  /** 设置训练池归属。不改变内容版本。 */
  setPool(paperId: string, pool: PaperPool): ExamPaperRecord | null;
  countPapers(): number;
}

// ---------------------------------------------------------------------------
// Expert Training 事实台账
// ---------------------------------------------------------------------------

/**
 * 会话不能被完成时抛出的错误（可判别）。
 *
 * 定义在**端口层**而不是 SQLite 实现里：服务层需要根据它做响应映射，
 * 而服务层不应依赖具体的存储实现。任何实现都应当在"条件认领失败"时抛它。
 */
export class RunNotCompletableError extends Error {
  constructor(
    readonly runId: string,
    /** 认领失败时库中的真实状态（可能为 null：行不存在）。 */
    readonly actualStatus: string | null,
  ) {
    super(
      `会话 ${runId} 当前状态为 ${actualStatus ?? "不存在"}，不是 in_progress，` +
        `因此不能产生完成事件。拒绝写入以避免重复或非法的事实。`,
    );
    this.name = "RunNotCompletableError";
  }
}

/** 追加一条学习会话。`id` 由调用方生成（便于把事件与 run 放在同一次写入里）。 */
export interface LearningRunInput {
  id: string;
  profileId: string;
  paperId: string;
  contentVersion: number;
  sectionId: string;
  sectionType: string;
  groupIds: string[];
  itemCount: number;
  startedAt: string;
}

/** 追加一条不可变观测。 */
export interface PerformanceEventInput {
  runId: string;
  profileId: string;
  paperId: string;
  contentVersion: number;
  sectionId: string;
  groupId: string;
  questionId: string;
  questionNumber: number | null;
  questionKind: string;
  responseKind: string;
  responseValue: string | null;
  outcome: PerformanceEvent["outcome"];
  durationSeconds: number | null;
  answerChanged: boolean;
  attemptKind: PerformanceEvent["attemptKind"];
  gradingSource: string;
  gradingVersion: string;
  sequence: number;
  occurredAt: string;
}

/** 追加一条评分结果。`performanceEventId` 由仓储在写入时绑定。 */
export interface AssessmentEventInput {
  /** 由 `completeRun` 按观测顺序绑定；单独追加时（重评）必须显式给出。 */
  performanceEventId?: string;
  rubricVersion: string;
  outcome: AssessmentEvent["outcome"];
  score: number;
  gradingSource: string;
  supersedesId?: string | null;
  note?: string | null;
  assessedAt: string;
}

/**
 * Expert 事实台账的读写边界。
 *
 * **没有 update / delete 方法，且这不是遗漏**：感知层面能表达的写入意图
 * 就只有"追加"。数据库侧另有 BEFORE UPDATE/DELETE 触发器兜底，
 * 使绕过本接口的直接 SQL 同样无法改写历史（见 db/schema.ts）。
 */
export interface ExpertRepository {
  startRun(input: LearningRunInput): LearningRun;
  getRun(runId: string): LearningRun | null;
  /** 已完成会话，倒序。用于"回来还能看到历史"。 */
  listRuns(profileId: string, limit: number): LearningRun[];

  /**
   * 该试卷该大题**进行中**的会话。没有则返回 null。
   *
   * 为什么这是一个独立方法而不是"取最近一个会话"：
   * 两种状态的**语义完全不同**，而 UI 对它们的处理也完全不同 ——
   * 有进行中的会话就必须**继续它**（否则用户刚作答的内容会看起来消失了）；
   * 只有没有进行中会话时，才轮到"显示上次结果"。
   *
   * 早先把它和"最近已完成"合并成一个 `findLatestRunForSection` 并让
   * **已完成优先**，产生了一个真实缺陷：用户点"再练一次"后新会话已创建，
   * 但页面状态查询仍返回旧的那个已完成会话，于是界面继续显示旧结果，
   * 新会话在用户眼里根本不存在。拆成两个显式方法后，优先级由调用方明确决定。
   */
  findInProgressRun(
    profileId: string,
    paperId: string,
    contentVersion: number,
    sectionId: string,
  ): LearningRun | null;

  /**
   * **任意内容版本**下进行中的会话。
   *
   * 用途只有一个：识别"有一个旧内容版本的会话还没提交"这种状态，
   * 从而给出明确的重开提示，而不是把它静默当成"没有会话"。
   * 调用方**不得**用它来渲染题目 —— 参见 fail-closed 的内容版本规则。
   */
  findAnyInProgressRun(
    profileId: string,
    paperId: string,
    sectionId: string,
  ): LearningRun | null;

  /**
   * 该试卷该大题最近**已完成**的会话。没有则返回 null。
   *
   * 与 `findInProgressRun` 配对使用：调用方先问"有没有进行中的"，
   * 没有才问"上次结果是什么"。**不得**反过来。
   */
  findLatestCompletedRun(
    profileId: string,
    paperId: string,
    contentVersion: number,
    sectionId: string,
  ): LearningRun | null;

  /**
   * 把一个**未提交**的会话标记为已废弃（`abandoned`）。
   *
   * 唯一用途：内容升版后，旧版本的未提交会话无法继续（不能拿新包渲染旧题面），
   * 而它会被部分唯一索引挡住新会话。不废弃它，那部分训练会**永久卡死**。
   *
   * 安全性：观测只在交卷时写入，因此废弃一个未提交会话**不丢任何事实**。
   * 已提交的会话**不得**被废弃 —— 那才是改写历史（本方法会拒绝并返回 null）。
   */
  abandonRun(runId: string): LearningRun | null;

  /**
   * 完成一次会话。**本方法自身是原子的**：它必须在自己的事务里
   * 以"条件认领"作为第一个动作。
   *
   * ── 为什么必须在持久化边界上保证恰好一次 ──
   *
   * 服务层的 `status === "completed"` 预检查只是**快速失败**，它挡不住：
   * - 两个提交请求同时在途（各自读到 `in_progress`，然后都进入写入路径）；
   * - 重放/重复的请求（用户连点、网络重试、浏览器回退再提交）。
   *
   * 因此真正的不变量在数据库里：**先把 status 从 `in_progress` 原子地
   * 认领为 `completed`（`WHERE id = ? AND status = 'in_progress'`），
   * 只有认领成功的那一次才允许写入事件与评估。**
   * 认领到 0 行即抛 `RunNotCompletableError`，本次调用的全部写入回滚。
   *
   * 这条顺序（先认领、后写事件）与"先写事件、后标完成"相反，是**有意的**：
   * 后者会让两个并发提交都写完事件之后才发现会话已被标记完成 ——
   * 那时重复的观测已经在事务里了。
   *
   * `abandoned` 会话永远不能被认领，因此不可能变成 `completed`。
   */
  completeRun(input: {
    runId: string;
    submittedAt: string;
    durationSeconds: number | null;
    events: PerformanceEventInput[];
    assessments: AssessmentEventInput[];
  }): LearningRun;

  listEventsForRun(runId: string): PerformanceEvent[];
  /** 某道题的全部历史观测（跨会话），用于回看。 */
  listEventsForQuestion(
    profileId: string,
    ref: { paperId: string; contentVersion: number; sectionId: string; groupId: string; questionId: string },
  ): PerformanceEvent[];
  /** 某个已完成会话的全部评分记录。 */
  listAssessmentsForRun(runId: string): AssessmentEvent[];

  /** 追加一次重评。**不修改原有评估记录。** */
  appendAssessment(input: AssessmentEventInput): AssessmentEvent;

  /** 用当前不可变事件**整体重算**投影（先删后写，因此是可重建的）。 */
  rebuildProjection(profileId: string): EvidenceProjectionRow[];
  readProjection(profileId: string): EvidenceProjectionRow[];
}

// ---------------------------------------------------------------------------
// 课程层（Course Layer）
// ---------------------------------------------------------------------------

/**
 * 落库的课程包索引记录（**不含正文**）。
 *
 * 为什么正文不在这里：正文的规范来源是 private-content/courses 下的规范化包。
 * 库里保存的是可引用、可校验、可比较版本的那一部分 —— 与 `ExamPaperRecord`
 * 完全同一条理由（见其注释）。
 */
export interface CoursePackageRecord {
  id: string;
  /** 提供方。自由字符串，**不是枚举** —— 首个是一个商业课程品牌，但不是特例。 */
  provider: string;
  edition: string | null;
  title: string;
  /** 内容版本，语义内容变化时才递增。 */
  contentVersion: number;
  provenance: CourseProvenance;
  /** 包目录相对于课程根（private-content/courses）的路径。永不存绝对路径。 */
  packagePath: string;
  /** `course.json` 的 sha256：判"文件是否被改动过"。 */
  manifestChecksum: string;
  /** 规范内容指纹：判"这是不是同一版内容"（元数据变更不影响它）。 */
  contentFingerprint: string | null;
  materialCount: number;
  segmentCount: number;
  assetCount: number;
  assetBytes: number;
  importedAt: string;
  updatedAt: string;
}

export interface CourseImportInput {
  record: Omit<CoursePackageRecord, "importedAt" | "updatedAt">;
  assets: CourseAsset[];
}

/**
 * 一次课程包导入会做什么。语义与 `PaperImportDecision` 逐条对应 ——
 * 判据拆成 checksum（文件）与 fingerprint（内容）是同一条理由：
 * 只改 rightsNote 不得假装成新内容版本。
 */
export type CourseImportDecision =
  | { kind: "insert" }
  | { kind: "update"; fromVersion: number; toVersion: number }
  | { kind: "metadata_only"; version: number; checksum: string }
  | { kind: "unchanged"; version: number; checksum: string };

/**
 * 课程包落库的链接记录。
 *
 * `id` 是**由声明身份确定性推导**的，因此同一份声明重复写入是幂等的。
 */
export interface CourseCanonicalLinkRecord {
  id: string;
  courseId: string;
  segmentId: string;
  courseContentVersion: number;
  paperId: string;
  paperContentVersion: number;
  sectionId: string;
  groupId: string | null;
  questionId: string | null;
  targetScope: CourseLinkTargetScope;
  verificationStatus: CourseLinkVerificationStatus;
  verificationRef: string;
  note: string | null;
  createdAt: string;
}

/** 一条链接连同它的运行时可用性判定。**判定不是存储字段**，而是读时按当前版本算出来的。 */
export interface CourseCanonicalLinkView {
  link: CourseCanonicalLinkRecord;
  /** 当前是否可作为运行时链接使用（fail-closed，见 `isLinkRuntimeUsable`）。 */
  runtimeUsable: boolean;
  /** 不可用时的可读原因；可用时为 null。 */
  unusableReason: string | null;
}

/** 追加一条课程曝光观测。 */
export interface CourseExposureInput {
  profileId: string;
  courseId: string;
  segmentId: string;
  /** 学习者**当时实际看到的那一版**课程内容。 */
  courseContentVersion: number;
  eventType: CourseExposureEventType;
  occurredAt: string;
}

/**
 * 揭示曝光的**逻辑身份**（确定性推导）。
 *
 * ── 为什么它必须存在 ──
 *
 * 上一版的幂等是 `listExposureForSegment(...).find(...)` 然后才插入 ——
 * 那是 check-then-insert，两个并发请求可以同时通过检查、各自插入一条，
 * 于是"同一个揭示动作"在库里留下两条观测。
 *
 * 用**确定性身份**把幂等交给数据库：身份相同的第二次写入走
 * `ON CONFLICT DO NOTHING`，因此"是否已存在"与"插入"是同一条 SQL 的
 * 原子行为，不存在中间的竞态窗口。
 *
 * ── 为什么不用随机 UUID + 先查 ──
 *
 * 随机 id 让"重复写入同一份声明"无法被数据库识别，只能靠应用层先查 ——
 * 而那正是要消除的竞态。同 `courseLinkIdentity` 的理由。
 *
 * ── 身份里**不含** `occurredAt` ──
 *
 * 时间不是"这次揭示请求"的身份：重试会产生新的 `nowISO()`，
 * 若它参与身份，重试就会被当成一次新的揭示。
 *
 * 用 NUL 作分隔符：它是唯一不可能出现在任何 slug / segment id 里的字符，
 * 因此不可能构造出两个不同身份拼出同一个串。
 */
export function revealExposureIdentity(input: {
  profileId: string;
  courseId: string;
  courseContentVersion: number;
  segmentId: string;
}): string {
  return createHash("sha256")
    .update(
      [
        input.profileId,
        input.courseId,
        String(input.courseContentVersion),
        input.segmentId,
        // 事件种类写死：这个身份只服务 `reveal_requested`。
        // 同段上的 `content_rendered` 等事件**不共享**它 —— 它们的
        // 追加语义原样不变（见 CourseRepository.appendExposure 的说明）。
        "reveal_requested",
      ].join("\u0000"),
    )
    .digest("hex");
}

/**
 * 课程层的读写边界。
 *
 * ── 这个接口刻意**没有**的东西（不是遗漏）──
 *
 * - **没有 update / delete 曝光的方法。** 感知层面能表达的写入意图只有"追加"。
 *   数据库侧另有 BEFORE UPDATE/DELETE 触发器兜底，使绕过本接口的直接 SQL
 *   同样无法改写历史（见 `db/schema.ts`）。
 * - **没有任何写 `performance_event` / `assessment_event` /
 *   `evidence_projection` / `skill_profile` / `answer_attempt` 的方法。**
 *   课程曝光与表现证据是两件事，它们在**接口层面**就不相通 ——
 *   这比"记得别写"可靠得多。
 */
export interface CourseRepository {
  /**
   * 课程层是否**已激活**：`course_package` 表是否存在于此库。
   *
   * 课程层表是 v9 才有的。v8 库里根本没有它们，因此只读命令必须先问这一条，
   * 才能**如实说明"课程层尚未激活"**，而不是抛 `no such table`，
   * 更不是偷偷迁移（见 `content-policy/LEARNING_MODEL.md` 的"只读路径不得迁移"门禁）。
   *
   * 这不是"假装 v9"：未激活 ⇔ 不存在任何合法的课程层行，
   * 因为那些行只可能由 `course:import --commit` 在 v9 上写入。
   * 所以"索引为空"在 v8 上是**事实**。
   */
  isActivated(): boolean;
  listPackages(): CoursePackageRecord[];
  getPackage(id: string): CoursePackageRecord | null;
  /** 发现/校验阶段用：按库中已有记录判断内容是否变化。纯查询，无副作用。 */
  decideImport(record: CoursePackageRecord): CourseImportDecision;
  /**
   * 写入索引与资产。调用方负责包在 `repos.transaction` 内 ——
   * 一次导入必须整体成功或整体不写入。
   */
  saveImport(input: CourseImportInput, decision: CourseImportDecision): CoursePackageRecord;
  countPackages(): number;
  /** 是否已导入某课程包的**某个具体内容版本**（链接核验的前置条件之一）。 */
  hasContentVersion(courseId: string, contentVersion: number): boolean;

  /**
   * 追加一条 canonical 链接。**幂等**：`id` 由声明身份确定性推导，
   * 重复写入同一份声明返回既有行，不产生第二条。
   *
   * 本方法**不做**结构校验 —— 校验必须在服务层完成（见
   * `services/course-link.ts` 的 `verifyCanonicalLink`），
   * 因为校验需要读取课程包正文与真题正文，而 repository 层看不到它们。
   */
  appendLink(link: CourseCanonicalLinkRecord): {
    link: CourseCanonicalLinkRecord;
    /** true 表示这是新写入；false 表示同一份声明已存在（幂等命中）。 */
    created: boolean;
  };
  /** 某一段的全部链接（含 candidate / rejected / stale），按创建时间倒序。 */
  listLinksForSegment(courseId: string, segmentId: string): CourseCanonicalLinkRecord[];
  /** 某课程包的全部链接。 */
  listLinksForCourse(courseId: string): CourseCanonicalLinkRecord[];
  getLink(id: string): CourseCanonicalLinkRecord | null;

  /** 追加一条课程曝光观测。**只追加。** */
  appendExposure(input: CourseExposureInput): CourseExposureEvent;
  /**
   * **原子幂等地**追加一条揭示曝光（`reveal_requested`）。
   *
   * ── 它与 `appendExposure` 的分工 ──
   *
   * | | `appendExposure` | `appendRevealExposureOnce` |
   * | --- | --- | --- |
   * | 幂等 | 否（每次追加新行） | **是**（同一身份只留一行） |
   * | 机制 | 随机 id + INSERT | 确定性 id + `ON CONFLICT DO NOTHING` |
   * | 语义 | 观测流，重复渲染各自成行 | 一个揭示动作就是一次 |
   *
   * 四种既有曝光事件（`content_rendered` / `solution_rendered` /
   * `teacher_explanation_seen` / `declared_seen`）**继续走**
   * `appendExposure`，追加语义一字不变 —— 它们天然是观测流。
   *
   * ── 为什么幂等必须落在数据库层 ──
   *
   * "先查再插"有竞态窗口：两个并发请求可以同时查到"不存在"，
   * 然后各自插入。把身份交给 `ON CONFLICT DO NOTHING` 之后，
   * "是否已存在"与"插入"是同一条 SQL 的原子行为。
   *
   * `created: false` 表示命中既有行 —— 此时返回的行是**库里原有那条**，
   * 它的 `occurredAt` 是首次揭示的时刻，**不会被本次请求覆盖**。
   */
  appendRevealExposureOnce(input: {
    profileId: string;
    courseId: string;
    courseContentVersion: number;
    segmentId: string;
    occurredAt: string;
  }): { event: CourseExposureEvent; created: boolean };
  listExposureForProfile(profileId: string, limit: number): CourseExposureEvent[];
  /**
   * 某 profile 的**全部**曝光（无 LIMIT），按 (course, segment, 时间) 确定排序。
   *
   * 与 `listExposureForProfile` 的分工：那个是"最近看过什么"的**展示**用途，
   * 因此有 LIMIT 且按时间倒序；本方法是**投影**用途 —— 模考新鲜度必须看到
   * 全部历史曝光，漏掉一条就会把"已接触"错报成"尚未接触"。
   * 因此它刻意**没有** LIMIT：截断在这里会静默改变结论。
   */
  listAllExposureForProfile(profileId: string): CourseExposureEvent[];
  /** 某一段的全部曝光（跨版本，按时间倒序）。 */
  listExposureForSegment(profileId: string, courseId: string, segmentId: string): CourseExposureEvent[];
  countExposure(profileId: string): number;
}

export interface Repositories {
  learner: LearnerRepository;
  diagnostic: DiagnosticRepository;
  skillProfile: SkillProfileRepository;
  plan: PlanRepository;
  records: RecordRepository;
  review: ReviewRepository;
  papers: PaperRepository;
  /** Expert Training 事实台账（只追加）。 */
  expert: ExpertRepository;
  /**
   * 课程层（Course Layer）：包索引 + 规范链接 + 只追加的课程曝光。
   *
   * 与 `expert` **完全平行、互不写入**：课程曝光永远不产生表现证据。
   * 见下方 `CourseRepository` 的契约说明。
   */
  courses: CourseRepository;
  /**
   * 跨多个 repository 的原子工作单元。
   *
   * 为什么放在聚合根而不是某个具体 repository：一次业务操作（例如提交训练任务）
   * 会同时写 session / attempts / task 状态 / 画像 / 弱点 / 复习队列，
   * 原子性是**整个聚合**的性质，不属于其中某一张表。
   *
   * 可重入：内部再调用各 repository 自身的事务时使用 SAVEPOINT 嵌套，
   * 因此调用方可以安全地把多个已带事务的方法包在一起。
   */
  transaction<T>(fn: () => T): T;
}
