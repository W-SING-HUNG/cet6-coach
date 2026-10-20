import type { Repositories } from "@/repositories/ports";
import type { AssessmentEventInput } from "@/repositories/ports";
import { getPaperDetail } from "./papers";
import { newId } from "@/lib/id";
import { nowISO } from "@/lib/date";
import { LOCAL_RUBRIC_VERSION, type LearningRun } from "@/domain/models";
import {
  feedbackFor,
  gradeResponses,
  isAnswerChangedForSubmission,
  isTrainableReadingSection,
  reliableDuration,
  responseKindOf,
  summarize,
  summarizeFeedback,
  type GradedResponse,
  type ReadingResponse,
  type ScoreSummary,
  type TrainableReadingSection,
} from "@/domain/expert-training";
import type { ExamPaperContent, PaperQuestion, PaperSection } from "@/content/paper";
import { RunNotCompletableError } from "@/repositories/ports";
import { SECTION_LABELS, isPaperStartableForPractice, RESERVED_PAPER_REASON, type PaperPool, type PaperSectionType } from "@/domain/paper";

/**
 * 真实真题阅读训练服务（Expert Training V1）。
 *
 * 产品闭环的最短可用形态：
 *
 *   真实试卷 → 选取阅读大题 → 呈现真实刺激材料 → 逐题作答 → 提交
 *   → 确定性判分 → 反馈 → 不可变事实落库 → 可回看
 *
 * ── 关键约束（逐条对应质量门禁）──
 *
 * 1. **只用真实真题。** 内容来自已导入的规范化包，不生成任何题目。
 *    这里没有任何"若无内容则造一道"的分支。
 * 2. **确定性判分。** 判据是真题自带的答案，见 `domain/expert-training`。
 * 3. **不污染旧语义。** 本模块**不写** `skill_profile` / `Weakness` /
 *    `answer_attempt`：Expert 证据只进新台账。旧路径完全不受影响。
 * 4. **无 AI 依赖。** 全链路纯确定性，AI 不可用时行为完全相同。
 * 5. **答案不提前下发。** `PaperQuestion` 自带 `answer` / `answerParagraph`，
 *    直接把它交给页面会让答案随 RSC 载荷到达浏览器（用户一开 devtools 就看见了）。
 *    因此可作答视图是**剥离答案后的独立类型**（见 `TrainingQuestionView`），
 *    类型层面就不存在这个字段。
 */

// ---------------------------------------------------------------------------
// 可作答视图（**不含答案**）
// ---------------------------------------------------------------------------

/** 可作答的题型。V1 的判分覆盖这三个。 */
export type TrainableQuestionKind = "mcq" | "banked_cloze_blank" | "matching_statement";

/**
 * 面向作答界面的题目视图。
 *
 * 刻意**没有** `answer` / `answerParagraph` / `explanation` 字段：
 * 提交之前，正确答案不存在于客户端可达的数据里。
 * 这不是"记得别渲染"的约定，而是类型与数据流层面的保证。
 */
export interface TrainingQuestionView {
  id: string;
  number: number | null;
  order: number;
  kind: TrainableQuestionKind;
  /** mcq 的题干。 */
  stem: string | null;
  options: { id: string; label: string }[];
  /** 选词填空：空号（与 passage 中的 `[n]` 对应）。 */
  blankId: string | null;
  /** 长篇阅读：待匹配的陈述句。 */
  statement: string | null;
}

export interface TrainingGroupView {
  id: string;
  order: number;
  instructions: string | null;
  passage: string | null;
  paragraphs: { label: string; text: string }[] | null;
  wordBank: string[] | null;
  firstNumber: number | null;
  questions: TrainingQuestionView[];
}

function toQuestionView(question: PaperQuestion): TrainingQuestionView | null {
  if (question.kind === "mcq") {
    return {
      id: question.id,
      number: question.number,
      order: question.order,
      kind: "mcq",
      stem: question.stem,
      options: question.options.map((option) => ({ id: option.id, label: option.label })),
      blankId: null,
      statement: null,
    };
  }
  if (question.kind === "banked_cloze_blank") {
    return {
      id: question.id,
      number: question.number,
      order: question.order,
      kind: "banked_cloze_blank",
      stem: null,
      options: [],
      blankId: question.blankId,
      statement: null,
    };
  }
  if (question.kind === "matching_statement") {
    return {
      id: question.id,
      number: question.number,
      order: question.order,
      kind: "matching_statement",
      stem: null,
      options: [],
      blankId: null,
      statement: question.statement,
    };
  }
  // 写作 / 翻译不是 V1 的可训练题型
  return null;
}

// ---------------------------------------------------------------------------
// 结果视图
// ---------------------------------------------------------------------------

export interface GradedQuestionView {
  questionId: string;
  groupId: string;
  questionNumber: number | null;
  questionKind: string;
  responseKind: string;
  /** 学习者当时的作答值（未作答为 null）。 */
  responseValue: string | null;
  /** 学习者当时所选选项的可读文本（mcq 才有）。 */
  responseLabel: string | null;
  outcome: GradedResponse["outcome"];
  correctAnswerLabel: string;
  feedback: string;
  explanation: string | null;
  options: { id: string; label: string }[];
  /** 该题在题组里的题面（回看时展示，不含答案泄漏问题 —— 此时已提交）。 */
  prompt: string;
}

export interface ReadingTrainingResult {
  runId: string;
  submittedAt: string;
  durationSeconds: number | null;
  summary: ScoreSummary;
  summaryText: string;
  questions: GradedQuestionView[];
}

export interface ReadingTrainingSession {
  paperId: string;
  paperTitle: string;
  contentVersion: number;
  sectionId: string;
  sectionType: TrainableReadingSection;
  sectionLabel: string;
  instructions: string | null;
  run: LearningRun;
  groups: TrainingGroupView[];
  /** 已完成时为结果；未完成时为 null（**因此未提交时页面上不可能有答案**）。 */
  result: ReadingTrainingResult | null;
}

export interface ReadingTrainingTarget {
  sectionId: string;
  sectionType: TrainableReadingSection;
  label: string;
  groupCount: number;
  questionCount: number;
  firstNumber: number | null;
  lastNumber: number | null;
  lastRun: LearningRun | null;
}

export interface SubmitReadingRunInput {
  runId: string;
  responses: Array<{ questionId: string; value: string | null }>;
  /** 前端测得的用时（秒）。不可靠的测量会被丢弃（见 reliableDuration）。 */
  elapsedSeconds?: number | null;
  /** 真实观测到"改过答案"的题 id。没观测到就是空数组。 */
  changedQuestionIds?: string[];
}

export type SubmitReadingRunResult =
  | { ok: true; result: ReadingTrainingResult }
  | {
      ok: false;
      error: string;
      code: "not_found" | "already_submitted" | "invalid" | "content_changed" | "unavailable";
    };

export type OpenTrainingResult =
  | { ok: true; session: ReadingTrainingSession }
  | {
      ok: false;
      error: string;
      code: "not_found" | "not_trainable" | "unavailable" | "content_changed";
    };

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function paperTitle(record: { year: number; session: string; variant: string }): string {
  const session = record.session === "June" ? "6 月" : record.session === "September" ? "9 月" : "12 月";
  return `${record.year} 年 ${session}${record.variant !== "single" ? ` · ${record.variant}` : ""}`;
}

function findSection(content: ExamPaperContent, sectionId: string): PaperSection | null {
  return content.sections.find((section) => section.id === sectionId) ?? null;
}

/**
 * 该在 UI 上显示哪个会话。
 *
 * **这是全应用唯一的"显示哪个会话"判据**，因此它只有一个实现：
 *   进行中 > 最近已完成 > 无。
 *
 * 为什么必须收敛到一处：早先这个决定散落在查询与调用方之间，
 * 而查询内部把优先级写成了"已完成优先"，于是产生了一个真实缺陷 ——
 * 用户点"再练一次"后新会话已创建，界面却继续显示上一轮的结果。
 * 把优先级写在一个函数里，就不存在"两处规则不一致"的可能。
 */
function resolveDisplayRun(
  repos: Repositories,
  profileId: string,
  paperId: string,
  contentVersion: number,
  sectionId: string,
): LearningRun | null {
  const inProgress = repos.expert.findInProgressRun(profileId, paperId, contentVersion, sectionId);
  if (inProgress) return inProgress;
  return repos.expert.findLatestCompletedRun(profileId, paperId, contentVersion, sectionId);
}

function collectQuestions(section: PaperSection): PaperQuestion[] {
  return section.groups.flatMap((group) => group.questions);
}

function numberRange(section: PaperSection): { first: number | null; last: number | null } {
  const numbers = collectQuestions(section)
    .map((question) => question.number)
    .filter((value): value is number => typeof value === "number");
  if (numbers.length === 0) return { first: null, last: null };
  return { first: Math.min(...numbers), last: Math.max(...numbers) };
}

function correctValueOf(question: PaperQuestion): string {
  switch (question.kind) {
    case "mcq":
      return question.answer;
    case "banked_cloze_blank":
      return question.answer;
    case "matching_statement":
      return question.answerParagraph;
    default:
      return "";
  }
}

function correctLabelOf(question: PaperQuestion): string {
  if (question.kind === "mcq") {
    const option = question.options.find((item) => item.id === question.answer);
    return option ? `${option.id} — ${option.label}` : question.answer;
  }
  if (question.kind === "banked_cloze_blank") return question.answer;
  if (question.kind === "matching_statement") return `段落 ${question.answerParagraph}`;
  return "";
}

/** 题面的可读文本（结果回看用）。 */
function promptOf(question: PaperQuestion): string {
  switch (question.kind) {
    case "mcq":
      return question.stem;
    case "banked_cloze_blank":
      return `第 ${question.blankId} 空`;
    case "matching_statement":
      return question.statement;
    default:
      return "";
  }
}

// ---------------------------------------------------------------------------
// 目标发现
// ---------------------------------------------------------------------------

/**
 * 列出某份真实试卷里**可训练**的阅读大题。
 *
 * 只返回阅读三题型：听力需要音频交互、写作与翻译需要主观评分。
 * 三者都不是 V1 的阻塞项，但把它们列成"可训练"会让台账出现低质观测。
 */
export function listReadingTargets(
  repos: Repositories,
  profileId: string,
  paperId: string,
): { paperTitle: string; targets: ReadingTrainingTarget[] } | null {
  const detail = getPaperDetail(repos, paperId);
  if (!detail?.content) return null;

  const targets: ReadingTrainingTarget[] = [];
  for (const section of detail.content.sections) {
    if (!isTrainableReadingSection(section.type)) continue;
    const numbers = numberRange(section);
    targets.push({
      sectionId: section.id,
      sectionType: section.type,
      label: SECTION_LABELS[section.type as PaperSectionType],
      groupCount: section.groups.length,
      questionCount: collectQuestions(section).length,
      firstNumber: numbers.first,
      lastNumber: numbers.last,
      // 与 `getSectionTrainingState` 同一条优先级：进行中优先。
      // 这个字段驱动 UI 显示"继续训练"还是"开始训练"，而显示错的那个
      // 正是"再练一次后仍看到旧结果"这个缺陷的入口。
      lastRun: resolveDisplayRun(repos, profileId, paperId, detail.record.contentVersion, section.id),
    });
  }

  return { paperTitle: paperTitle(detail.record), targets };
}

/** 全库可训练的真实真题阅读大题。用于真题库列表与 Today 入口。 */
export function listAllReadingTargets(
  repos: Repositories,
  profileId: string,
): Array<{
  paperId: string;
  paperTitle: string;
  sourceKind: string;
  /**
   * 训练池归属（**权威字段**）。
   *
   * ── 为什么这里从 `progress: string` 改成 `pool: PaperPool` ──
   *
   * 早先这个字段叫 `progress`、类型是 `string`，而它装的其实是
   * `record.pool`（即 `"training"` / `"mock_reserve"`）。那个名字与类型
   * 一起制造了一个真实缺口：调用方于是直接写
   * `paper.progress === "training"` 做裸字符串比较，绕过了领域层唯一的
   * 权威谓词 `isPaperStartableForPractice(record)`。
   *
   * 后果是"能不能开始训练"这件事在 planner、Today 候选、`/practice` 列表
   * 与真实启动守卫上各有一份判据 —— 而它们迟早会漂移。
   *
   * 现在把语义直接写进类型与字段名：调用方拿到的是 `PaperPool`，
   * 必须经 `isPaperStartableForPractice({ pool })` / `isPaperReservedForMock`
   * 判断，写不出"看起来像进度状态的字符串比较"。
   */
  pool: PaperPool;
  targets: ReadingTrainingTarget[];
}> {
  return repos.papers
    .listPapers()
    .map((record) => {
      const listed = listReadingTargets(repos, profileId, record.id);
      if (!listed || listed.targets.length === 0) return null;
      return {
        paperId: record.id,
        paperTitle: listed.paperTitle,
        sourceKind: record.sourceKind,
        pool: record.pool,
        targets: listed.targets,
      };
    })
    .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
}

// ---------------------------------------------------------------------------
// 会话读取（**只读**，GET 不产生写入）
// ---------------------------------------------------------------------------

/**
 * 读取某大题的训练状态。
 *
 * **本函数不创建任何记录。** 页面 GET 必须是只读的：
 * 若在读取时顺手创建会话，用户每次误点/刷新都会留下一个空会话，
 * 而空会话会被后续统计当作"一次未完成的训练"。
 * 创建会话只能由显式的 POST（`startReadingRunAction`）触发。
 *
 * ── 优先级（修复"再练一次"后仍显示旧结果的缺陷）──
 *
 * 1. **进行中的会话优先。** 它代表用户当前正在做的事。
 *    排在后面会让用户刚点完"再练一次"却继续看到上一轮的结果。
 * 2. 没有进行中会话时，才显示最近**已完成**的结果。
 *
 * ── 内容版本 fail-closed ──
 *
 * 会话的 `contentVersion` 与当前试卷包不一致时，**绝不**用新包去重建旧会话 ——
 * 那会把新内容的题干与答案显示成"当时的历史记录"。
 * - 进行中的旧版本会话 → 要求重开
 * - 已完成的旧版本会话 → 保留不可变事实，但**不重建题面与答案**
 */
export function getSectionTrainingState(
  repos: Repositories,
  profileId: string,
  paperId: string,
  sectionId: string,
): OpenTrainingResult {
  const detail = getPaperDetail(repos, paperId);
  if (!detail) return { ok: false, error: "试卷不存在。", code: "not_found" };
  if (!detail.content) {
    return { ok: false, error: detail.packageIssue ?? "内容包当前不可用。", code: "unavailable" };
  }

  const section = findSection(detail.content, sectionId);
  if (!section) return { ok: false, error: "这个大题不在这份试卷里。", code: "not_found" };
  if (!isTrainableReadingSection(section.type)) {
    return {
      ok: false,
      error: "V1 的真实真题训练只覆盖阅读三种题型。听力、写作与翻译属于后续阶段。",
      code: "not_trainable",
    };
  }

  /*
   * ── 模考保留：GET 路径同样 fail closed（只读、无副作用）──
   *
   * 页面不能靠"我记得不渲染按钮"来守住策略 —— 学习者可以直接输入 URL。
   * 这里返回 `unavailable`，训练页据此显示保留状态与恢复路径，
   * 且**不**渲染开始/继续/再练一次任何动作。
   *
   * 注意它放在"读会话"之前，因此这一路径**不会**把已有的进行中会话
   * 交给工作区渲染 —— 保留期间不产生新的训练活动。
   * 但会话与历史事实仍在库里，改回训练池后照常可见（无迁移、无销毁）。
   */
  if (!isPaperStartableForPractice(detail.record)) {
    return { ok: false, error: RESERVED_PAPER_REASON, code: "unavailable" };
  }

  const currentVersion = detail.record.contentVersion;

  // 1) 进行中的会话优先 —— 它是用户当前正在做的事
  const inProgress = repos.expert.findInProgressRun(profileId, paperId, currentVersion, section.id);
  if (inProgress) {
    return { ok: true, session: buildSession(repos, inProgress, section, paperTitle(detail.record)) };
  }

  // 2) 跨版本的进行中会话：内容升版了，旧会话不能用新包渲染
  const staleInProgress = repos.expert.findAnyInProgressRun(profileId, paperId, section.id);
  if (staleInProgress) {
    return {
      ok: false,
      error:
        `这一部分的内容已更新到 v${currentVersion}（你未完成的训练开始于 v${staleInProgress.contentVersion}）。` +
        `旧会话不能在新版内容上继续 —— 那会把新版题干当作当时的内容。请重新开始一次训练。`,
      code: "content_changed",
    };
  }

  // 3) 没有进行中会话，才轮到"上次结果"
  const completed = repos.expert.findLatestCompletedRun(profileId, paperId, currentVersion, section.id);
  if (completed) {
    return { ok: true, session: buildSession(repos, completed, section, paperTitle(detail.record)) };
  }

  // 4) 只有**旧版本**的已完成会话：事实保留，但不重建题面
  const staleCompleted = repos.expert.listRuns(profileId, 200).find(
    (run) =>
      run.paperId === paperId &&
      run.sectionId === section.id &&
      run.status === "completed" &&
      run.contentVersion !== currentVersion,
  );
  if (staleCompleted) {
    return {
      ok: false,
      error:
        `你在这部分做过一次训练，但当时的内容版本是 v${staleCompleted.contentVersion}，` +
        `当前包是 v${currentVersion}。那次结果作为历史事实仍被保留，` +
        `但这里不会用新版内容去重建它 —— 那会把新版题干与答案显示成当时的记录。` +
        `现在开始一次新训练即可。`,
      code: "content_changed",
    };
  }

  return { ok: false, error: "这一部分还没开始训练。", code: "not_found" };
}

/**
 * 读取指定会话（按 runId 回看）。
 *
 * **内容版本必须与当前包一致**，否则返回 null —— 调用方按"不可用"处理。
 *
 * 为什么这条校验是必需的：结果视图需要从**当前试卷包**里取题干与正确答案。
 * 如果会话是旧版本内容产生的，用新包重建就会把**新版的题干与答案**
 * 显示成那次历史的记录；更糟的是，学习者会以为当时看到的题面就是那个。
 * 宁可说"这份历史无法在此版本下渲染"，也不伪造内容。
 *
 * 不可变事实（事件与评估）本身不因此丢失 —— 它们始终在库里，
 * 只是不在此版本下重建题面。
 */
export function getReadingSession(
  repos: Repositories,
  profileId: string,
  runId: string,
): ReadingTrainingSession | null {
  const run = repos.expert.getRun(runId);
  if (!run || run.profileId !== profileId) return null;

  const detail = getPaperDetail(repos, run.paperId);
  if (!detail?.content) return null;

  // fail-closed：不把旧会话挂在新版内容上
  if (detail.record.contentVersion !== run.contentVersion) return null;

  const section = findSection(detail.content, run.sectionId);
  if (!section || !isTrainableReadingSection(section.type)) return null;

  return buildSession(repos, run, section, paperTitle(detail.record));
}

function buildSession(
  repos: Repositories,
  run: LearningRun,
  section: PaperSection,
  title: string,
): ReadingTrainingSession {
  const result = run.status === "completed" ? buildResult(repos, run, section) : null;

  return {
    paperId: run.paperId,
    paperTitle: title,
    contentVersion: run.contentVersion,
    sectionId: section.id,
    sectionType: section.type as TrainableReadingSection,
    sectionLabel: SECTION_LABELS[section.type as PaperSectionType],
    instructions: section.instructions,
    run,
    groups: section.groups.map((group) => ({
      id: group.id,
      order: group.order,
      instructions: group.instructions,
      passage: group.passage,
      paragraphs: group.paragraphs,
      wordBank: group.wordBank,
      firstNumber: group.firstNumber,
      questions: group.questions
        .map(toQuestionView)
        .filter((question): question is TrainingQuestionView => question !== null),
    })),
    result,
  };
}

// ---------------------------------------------------------------------------
// 开始 / 继续（显式写入）
// ---------------------------------------------------------------------------

export type StartRunResult =
  | { ok: true; run: LearningRun; resumed: boolean }
  | {
      ok: false;
      error: string;
      code: "not_found" | "not_trainable" | "unavailable" | "content_changed";
    };

/**
 * 开始一次新的训练会话；若已有一个**未提交**的会话，则继续它。
 *
 * 为什么"继续"与"开始"共用一个入口：用户中途离开再回来时，
 * 上次的会话应当被复用，否则刷新就会丢弃进行中的状态。
 * 但**已完成**的会话绝不复用 —— 每次训练都必须产生一组独立的事实。
 *
 * ── 三条不变式（对应"再练一次"的缺陷修复）──
 *
 * 1. **同一 (profile, paper, 内容版本, 大题) 至多一个进行中会话。**
 *    服务层先查一次（覆盖常见路径），数据库的部分唯一索引再兜一层
 *    （覆盖并发竞态：双击、两个标签页）。索引冲突时复用已存在的那一个，
 *    因此**重复点击不会产生孤儿会话**。
 * 2. **已完成的会话不被复用**，因此"再练一次"总是创建**恰好一个**新会话，
 *    且下一次页面渲染就是那个新会话（`getSectionTrainingState` 让进行中优先）。
 * 3. **旧内容版本的未完成会话会被废弃并重开**，不静默复用也不永久卡死：
 *    复用会把新版题面伪装成旧内容的历史；拒绝会让这部分训练永远无法再开始。
 *    废弃是安全的 —— 未提交的会话里没有任何观测。
 */
export function startReadingRun(
  repos: Repositories,
  profileId: string,
  paperId: string,
  sectionId: string,
): StartRunResult {
  const detail = getPaperDetail(repos, paperId);
  if (!detail) return { ok: false, error: "试卷不存在。", code: "not_found" };
  if (!detail.content) {
    return { ok: false, error: detail.packageIssue ?? "内容包当前不可用。", code: "unavailable" };
  }

  /*
   * ── 模考保留：服务层的**权威守卫**（fail closed）──
   *
   * 这是唯一的策略判据处。隐藏按钮是不够的：学习者可以直接输入 URL，
   * 或经由任何未隐藏的入口调用到这里 —— 实测确认过，
   * 修这个守卫之前保留卷能被真正开始并写入 `learning_run`。
   *
   * 放在"内容可用"之后、"读会话"之前：这样拒绝是**无副作用**的 ——
   * 不创建会话、不复用已有的进行中会话、不改池归属、不废弃任何东西。
   *
   * 为什么**不**在这里顺手废弃已有的进行中会话：
   * 一条在"这份卷子还是训练池时"开下的会话，是真实发生过的行为。
   * 把卷子改成保留不应该**销毁**它 —— 用户可能只是暂时把它挪出去。
   * 因此语义是"保留期间不再产生新的训练活动"，而不是"抹掉过去"。
 * 已完成的历史更不受影响。
   */
  if (!isPaperStartableForPractice(detail.record)) {
    return { ok: false, error: RESERVED_PAPER_REASON, code: "unavailable" };
  }

  const section = findSection(detail.content, sectionId);
  if (!section) return { ok: false, error: "这个大题不在这份试卷里。", code: "not_found" };
  if (!isTrainableReadingSection(section.type)) {
    return { ok: false, error: "这一部分不属于 V1 可训练范围。", code: "not_trainable" };
  }

  const questions = collectQuestions(section);
  if (questions.length === 0) {
    return { ok: false, error: "这个大题在当前内容包里没有题目，无法开始训练。", code: "unavailable" };
  }

  const currentVersion = detail.record.contentVersion;

  // 1) 已有**同版本**进行中的会话 → 继续它（刷新/回到页面都走这条）
  const inProgress = repos.expert.findInProgressRun(profileId, paperId, currentVersion, section.id);
  if (inProgress) {
    return { ok: true, run: inProgress, resumed: true };
  }

  // 2) 存在**旧版本**的未完成会话 → 废弃它后才能新建。
  //
  // 为什么废弃而不是拒绝：拒绝会让这部分训练永久卡死（旧会话占着唯一索引）。
  // 废弃是安全的 —— 未提交的会话里没有观测，没有事实被改写。
  // 用户看到的是"开始了新训练"，而不是"点不动"。
  const stale = repos.expert.findAnyInProgressRun(profileId, paperId, section.id);
  if (stale) {
    const abandoned = repos.expert.abandonRun(stale.id);
    if (!abandoned) {
      // 未能废弃（状态已变）—— 说明另一个请求刚处理过，重查一次
      const retry = repos.expert.findInProgressRun(profileId, paperId, currentVersion, section.id);
      if (retry) return { ok: true, run: retry, resumed: true };
      return {
        ok: false,
        error: "这部分存在一个旧版本的未完成训练，当前无法自动重开。请刷新页面后重试。",
        code: "content_changed",
      };
    }
  }

  // 3) 创建新会话。唯一索引兜住并发：冲突说明另一个请求刚好建过，
  //    此时复用它而不是报错 —— 用户意图是"开始练习"，不是"必须由我创建"。
  try {
    const run = repos.expert.startRun({
      id: newId(),
      profileId,
      paperId,
      contentVersion: currentVersion,
      sectionId: section.id,
      sectionType: section.type,
      groupIds: section.groups.map((group) => group.id),
      itemCount: questions.length,
      startedAt: nowISO(),
    });
    return { ok: true, run, resumed: false };
  } catch (error) {
    const raced = repos.expert.findInProgressRun(profileId, paperId, currentVersion, section.id);
    if (raced) return { ok: true, run: raced, resumed: true };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 结果（读已落库的事实，不重新判分）
// ---------------------------------------------------------------------------

function buildResult(
  repos: Repositories,
  run: LearningRun,
  section: PaperSection,
): ReadingTrainingResult {
  const events = repos.expert.listEventsForRun(run.id);
  const groupOf = new Map<string, string>();
  const questionOf = new Map<string, PaperQuestion>();
  for (const group of section.groups) {
    for (const question of group.questions) {
      groupOf.set(question.id, group.id);
      questionOf.set(question.id, question);
    }
  }

  const questions: GradedQuestionView[] = events.map((event) => {
    const question = questionOf.get(event.questionId) ?? null;
    const options = question && question.kind === "mcq" ? question.options : [];
    const graded: GradedResponse = {
      questionId: event.questionId,
      questionNumber: event.questionNumber,
      questionKind: event.questionKind as PaperQuestion["kind"],
      responseKind: event.responseKind as GradedResponse["responseKind"],
      responseValue: event.responseValue,
      outcome: event.outcome,
      correctAnswerLabel: question ? correctLabelOf(question) : "",
      correctAnswerValue: question ? correctValueOf(question) : "",
    };
    const chosen =
      question && question.kind === "mcq" && event.responseValue
        ? question.options.find((option) => option.id === event.responseValue) ?? null
        : null;

    return {
      questionId: event.questionId,
      groupId: groupOf.get(event.questionId) ?? event.sectionId,
      questionNumber: event.questionNumber,
      questionKind: event.questionKind,
      responseKind: event.responseKind,
      responseValue: event.responseValue,
      responseLabel: chosen ? `${chosen.id} — ${chosen.label}` : null,
      outcome: event.outcome,
      correctAnswerLabel: graded.correctAnswerLabel,
      feedback: feedbackFor(graded, options, question?.explanation ?? null),
      explanation: question?.explanation ?? null,
      options,
      prompt: question ? promptOf(question) : "",
    };
  });

  const summary = summarize(questions);
  return {
    runId: run.id,
    submittedAt: run.submittedAt ?? run.createdAt,
    durationSeconds: run.durationSeconds,
    summary,
    summaryText: summarizeFeedback(summary),
    questions,
  };
}

// ---------------------------------------------------------------------------
// 提交
// ---------------------------------------------------------------------------

/**
 * 提交并落库。
 *
 * 全部写入在一个事务里，顺序为"追加观测 → 追加评估 → 标记会话完成"。
 * 任一步失败则整体回滚，不会出现"会话已完成但没有观测"这种无证据的完成态。
 */
export function submitReadingRun(
  repos: Repositories,
  profileId: string,
  input: SubmitReadingRunInput,
): SubmitReadingRunResult {
  const run = repos.expert.getRun(input.runId);
  if (!run || run.profileId !== profileId) {
    return { ok: false, error: "训练会话不存在。", code: "not_found" };
  }
  if (run.status === "completed") {
    // 一次作答只产生一组事实。重复提交必须被拒绝，而不是追加第二份证据。
    return { ok: false, error: "这次训练已经提交过了。", code: "already_submitted" };
  }
  if (run.status === "abandoned") {
    // 废弃只发生在"内容升版使旧会话无法继续"。它从未产生观测，
    // 因此不能事后被提交成一份"完成"的事实。
    return {
      ok: false,
      error: "这次训练已被放弃（它属于旧版内容，无法在新版上继续）。请重新开始一次训练。",
      code: "not_found",
    };
  }

  const detail = getPaperDetail(repos, run.paperId);
  if (!detail?.content) {
    return { ok: false, error: "内容包当前不可用，无法提交。", code: "unavailable" };
  }
  const section = findSection(detail.content, run.sectionId);
  if (!section || !isTrainableReadingSection(section.type)) {
    return { ok: false, error: "这一大题已不在当前内容包里。", code: "not_found" };
  }

  // 内容版本必须与开始时一致：若内容在训练期间升版，
  // 把作答挂到新版会让历史被静默指向另一份材料（内容版本递增要防的正是这件事）。
  if (detail.record.contentVersion !== run.contentVersion) {
    return {
      ok: false,
      error: "内容版本在训练期间发生了变化。为避免把这次作答挂到另一版内容上，提交被拒绝。请重新开始。",
      code: "content_changed",
    };
  }

  const questions = collectQuestions(section);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const groupOfQuestion = new Map<string, string>();
  for (const group of section.groups) {
    for (const question of group.questions) groupOfQuestion.set(question.id, group.id);
  }

  // 作答形态**由题型推导**，不由调用方声明：
  // "选词填空提交了一个选项 id"这类不匹配会让台账出现不可能的观测。
  const responses: ReadingResponse[] = input.responses
    .filter((item) => questionById.has(item.questionId))
    .map((item) => ({
      questionId: item.questionId,
      kind: responseKindOf(questionById.get(item.questionId)!),
      value: item.value,
    }));

  const graded = gradeResponses(questions, responses);
  const duration = reliableDuration(input.elapsedSeconds);
  const changed = new Set(input.changedQuestionIds ?? []);
  const occurredAt = nowISO();

  const events = graded.map((item, index) => ({
    runId: run.id,
    profileId,
    paperId: run.paperId,
    contentVersion: run.contentVersion,
    sectionId: run.sectionId,
    groupId: groupOfQuestion.get(item.questionId) ?? run.sectionId,
    questionId: item.questionId,
    questionNumber: item.questionNumber,
    questionKind: item.questionKind,
    responseKind: item.responseKind,
    responseValue: item.responseValue,
    outcome: item.outcome,
    // 计时是**整组**测量，无法逐题归因，因此逐题记 null。
    // 把它摊到每道题上会制造"某题用了 X 秒"这种没有依据的精确性。
    durationSeconds: null,
    // 改答案的最终裁决在服务端：前端送来的声明必须与**实际提交的作答**
    // 相容。测量不可靠时记 false，而不是把矛盾写进台账
    // （见 domain/expert-training 的 isAnswerChangedForSubmission）。
    answerChanged: isAnswerChangedForSubmission(item.responseValue, changed.has(item.questionId)),
    attemptKind: "first_attempt" as const,
    gradingSource: "local-deterministic",
    gradingVersion: LOCAL_RUBRIC_VERSION,
    sequence: index,
    occurredAt,
  }));

  const assessments: AssessmentEventInput[] = graded.map((item) => ({
    rubricVersion: LOCAL_RUBRIC_VERSION,
    outcome: item.outcome,
    score: item.outcome === "correct" ? 1 : 0,
    gradingSource: "local-deterministic",
    supersedesId: null,
    note: null,
    assessedAt: occurredAt,
  }));

  /*
   * 写入失败必须被映射成安全响应，而不是把内部错误抛给 UI。
   *
   * `RunNotCompletableError` 的含义是"这个会话已经不能产生完成事件了" ——
   * 几乎总是因为另一次提交刚刚赢了这场竞争（或它已被废弃）。
   * 把它映射为 `already_submitted`（用户能理解的语义），
   * 而不是 `invalid`（会让用户以为是自己的输入有问题）。
   *
   * 注意：**这里不是唯一防线**。恰好一次由 `completeRun` 的条件认领在
   * 数据库事务边界上保证；这个 catch 只负责把结果翻译成用户可读的响应。
   */
  try {
    const result = repos.transaction(() => {
      repos.expert.completeRun({
        runId: run.id,
        submittedAt: occurredAt,
        durationSeconds: duration,
        events,
        assessments,
      });
      // 投影是可重建的派生层：提交后即时刷新，保证读到的聚合值与事件一致。
      repos.expert.rebuildProjection(profileId);
      return buildResult(repos, repos.expert.getRun(run.id)!, section);
    });

    return { ok: true, result };
  } catch (error) {
    if (error instanceof RunNotCompletableError) {
      // 认领失败 → 本次调用写入的事件与评估已随事务回滚，台账里没有多余行。
      return {
        ok: false,
        error:
          error.actualStatus === "abandoned"
            ? "这次训练已被放弃，无法提交。请重新开始一次训练。"
            : "这次训练已经提交过了。",
        code: "already_submitted",
      };
    }
    throw error;
  }
}

/** 该大题的历史训练次数（已完成 + 进行中），用于诚实展示"练过几次"。 */
export function countRunsForSection(
  repos: Repositories,
  profileId: string,
  paperId: string,
  contentVersion: number,
  sectionId: string,
): number {
  return repos.expert
    .listRuns(profileId, 200)
    .filter(
      (run) =>
        run.paperId === paperId &&
        run.contentVersion === contentVersion &&
        run.sectionId === sectionId,
    ).length;
}

export { paperTitle as formatPaperTitle };
export type { TrainableReadingSection };
