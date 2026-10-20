import { contentRepository } from "@/content";
import { planDay, daysUntil, isWeekend, type ContentCatalog, type ContentOption } from "@/domain/planner";
import type { DailyPlan, StudyTask, TaskContentRef } from "@/domain/models";
import type { ContentItem } from "@/content/types";
import type { Skill } from "@/domain/types";
import type { Repositories } from "@/repositories/ports";
import { addDays, nowISO, todayISO } from "@/lib/date";
import { availableMinutesSchema } from "@/lib/validation";
import { isReadingTargetRef, listReadingTargetCandidates, readingContentOptions, projectReadingTask, canonicalTargetKey, type ReadingTargetCandidate } from "./reading-plan";
import { taskHrefOf } from "@/domain/reading-target";

/**
 * Today 计划服务。
 *
 * 设计要点：计划只生成一次，之后由用户行为驱动重排（而不是每次渲染都重算）。
 * 这样"我今天做了什么"与"我今天的计划"是两个独立但一致的事实。
 */

export interface TodayTaskView {
  task: StudyTask;
  content: ContentItem | null;
  /** 内容素材是否就绪。false 时 UI 必须显示 pending 状态而不是假按钮。 */
  contentReady: boolean;
  contentPendingReason: string | null;
  minutesLabel: string;
  /**
   * 这条任务点下去会去哪。
   *
   * 阅读任务指向真实真题的 Expert Training 工作面；其余任务仍走旧执行器。
   * 规则由 `domain/reading-target` 的 `taskHrefOf` 唯一决定 —— 界面不得自己拼。
   */
  href: string;
  /** 该任务是否为真实真题阅读训练（界面据此措辞，不再靠 kind 猜）。 */
  isRealPaperReading: boolean;
  /**
   * **面向学习者的标题**。阅读任务用解析后的 canonical 真实目标渲染，
   * 而不是历史行里那句早已作废的合成素材标题。
   *
   * 为什么不能直接用 `task.title`：一条历史合成阅读任务的标题写着
   * 「阅读训练 12 分钟」，而它点下去落在某个真实真题大题上。
   * 把旧标题当主文案就是在骗人 —— 它没说清目的地，分钟数也不属于那个大题。
   */
  displayTitle: string;
  /**
   * **面向学习者的时长**（分钟）。
   *
   * 阅读任务用它**真实目标**的排练预算，而不是历史合成素材的时长。
   * 没有可用的真实目标时为 `null` —— **不编造**一个数字。
   */
  displayMinutes: number | null;
  /**
   * canonical 目标身份（`paperId::sectionId`），仅阅读任务有值。
   *
   * 用途是判断两个入口是否指向**同一个地方**（Today 的重复 CTA 检测）。
   * 它是领域标识，不是 URL 字符串 —— 与 URL 怎么写无关。
   */
  canonicalKey: string | null;
  /**
   * 这个 canonical 目标在今天的计划里**已经被更优先的另一条任务占用**。
   *
   * 例：一条「补做」的历史阅读任务与今天新排的阅读任务恰好解析到**同一个**
   * 真实大题。它们是同一件事，不该同时给出两个按钮 ——
   * 界面对这类任务不提供独立 CTA，而是说明它与哪一条是同一部分。
   */
  canonicalDuplicate: boolean;
  /**
   * **这条阅读任务是一件历史事实**：它在旧合成体系下已经完成。
   *
   * 它不收敛、不重包装、没有 canonical 目标。界面对它必须保持历史原样：
   * 沿用历史标题与时长，**不得**显示真实真题来源徽标，
   * **不得**提供任何"去练真题"的动作。见 `projectReadingTask` 的注释。
   */
  isHistoricalCompleted: boolean;
  /**
   * **面向学习者的有效分钟数**（F8）。
   *
   * 当前计划里的一切聚合（配比、计划占用量、顺延量）都必须用它，
   * 而不是 `task.estimatedMinutes` —— 后者是**历史行里存的原始值**，
   * 对一条被投影过的阅读任务来说那个数字属于早已作废的合成素材。
   *
   * 规则（唯一实现，见 `effectiveMinutesOf`）：
   * - 投影成功的阅读任务 → 真实目标的排练预算（`displayMinutes`）
   * - 其他任务 → 现有任务时长
   * - **不可用的投影阅读任务 → `null`**：它今天不构成可执行工作量，
   *   不得把旧的合成时长当作当前工作量计进去。
   * - 历史已完成任务 → 它不构成今天的工作量，同样为 `null`。
   */
  effectiveMinutes: number | null;
  /**
   * 解析出的 canonical 真实真题目标（仅"已收敛"的阅读任务有值）。
   *
   * 服务层内部与测试用它核对"展示的卷次/时长/跳转"三者是否来自**同一个**
   * 目标 —— 它们必须同源，否则会出现"标题说是 A、点下去去了 B"。
   */
  candidate: ReadingTargetCandidate | null;
}

/**
 * 面向学习者的**有效分钟数**规则（F8）—— 唯一实现。
 *
 * ── 为什么必须收敛到一处 ──
 *
 * 同一个任务会出现在 CTA、任务清单、Practice 计划区，以及若干聚合
 * （今日配比、计划占用量、顺延量）。只要任何一处继续读
 * `task.estimatedMinutes`，页面上就会出现自相矛盾的数字：
 * CTA 说 7 分钟，配比说 12 分钟，而同一条任务只有一份。
 *
 * 因此聚合与展示都必须经过这一个函数，而不是各自 `?? task.estimatedMinutes`。
 *
 * ── 规则（都在"这条任务对今天的计划说了什么真话"这一个判据之下）──
 *
 * 1. **重复项 → `null`。** 两行指向同一个 canonical 目标时，用户只会做一次；
 *    界面也已经不给它独立 CTA（显示「与上一条同一部分」）。
 *    既然它不是**可单独执行的**工作量，就不该在那个目标之外再计一次时长 ——
 *    否则计划负载会虚高到超过可用时间（实测：64 > 60），
 *    而用户看到的"计划占用"就成了一句办不到的话。
 * 2. **不可执行的投影阅读任务 → `null`。** 它今天不是可执行的工作量，
 *    因此不得把旧合成时长（12 分钟）当作当前工作量计进去。
 * 3. **投影成功的阅读任务 → 真实目标的排练预算。**
 * 4. **其余任务 → 任务自身的时长**（含已完成的历史合成任务：它**确实**占用过
 *    当天的时间，抹掉会让"计划占用"小于"已完成"，读起来是坏的）。
 */
export function effectiveMinutesOf(view: TodayTaskView): number | null {
  // 1) 重复项：同一目标只算一次
  if (view.canonicalDuplicate) return null;
  // 2) 不可执行的投影阅读任务：今天不可执行 → 不构成当前工作量
  if (view.isRealPaperReading && !view.contentReady) return null;
  // 3) 投影成功的阅读任务：用真实目标的排练预算
  if (view.isRealPaperReading) return view.displayMinutes;
  // 4) 其余任务：用任务自身的时长
  return view.task.estimatedMinutes;
}

export interface TodayView {
  date: string;
  examDate: string;
  daysRemaining: number;
  targetScore: number;
  examName: string;
  availableMinutes: number;
  plannedMinutes: number;
  completedMinutes: number;
  completedCount: number;
  totalCount: number;
  progress: number;
  tasks: TodayTaskView[];
  nextTask: TodayTaskView | null;
  warnings: string[];
  notes: string[];
  /** 今天是否为"短日"（可用时间明显低于常规），用于 UI 提示 */
  isShortDay: boolean;
  regularMinutes: number;
  /** 今天的复习队列 */
  dueReviewCount: number;
  hasDiagnostic: boolean;
  recentActivity: Array<{ date: string; minutes: number; tasksCompleted: number }>;
  /** 已顺延到明天的分钟数（因时间不足） */
  deferredMinutes: number;
  /**
   * 今天是否已经有一条**指向某个 canonical 真实真题目标**的阅读任务。
   *
   * ── 为什么这必须由服务层算，而不是让界面比字符串 ──
   *
   * Today 有两个可能指向同一份真实大题的入口：主导动作（"下一步"/"补做"）
   * 与次强调的「随时可做」行。Product UI V2 要求**一个主导动作** ——
   * 两个入口指向同一目的地却挂着不同文案，会让学习者先做一次无意义的取舍。
   *
   * 界面若自己比较 href 字符串，就会把"同一个目标"绑在 URL 的书写形式上
   * （编码、尾斜杠、大小写任一变化都会让重复入口悄悄回来）。
   * 这里用领域标识（`canonicalKey`）判断，因此比较的是**目标身份**。
   */
  hasPrimaryReadingTarget: boolean;
}

function resolveContent(ref: TaskContentRef | null): ContentItem | null {
  if (!ref || !ref.contentId) return null;
  // 复习任务引用的是队列而不是内容文件，内容库里没有对应条目
  if (ref.contentType === "review_deck") return null;
  /**
   * 真实真题阅读大题**刻意不在内容库里**。
   *
   * 它的正文来自私有规范包，由 `content/paper` 的 catalog 按内容版本读取
 * 这里返回 null 是正确的：它的可用性由
   * `resolveReadingTask` 判定，而不是由内容库判定。
   */
  if (isReadingTargetRef(ref.contentType)) return null;
  return contentRepository.getItem(ref.contentType, ref.contentId);
}

/**
 * ── canonical 目标的认领：同一个目标只被认领一次（F2）──
 *
 * 这段逻辑有**两个**消费方，而它们必须用同一套判据：
 *
 * 1. `getTodayView` 用它决定谁是重复项 —— 重复项不计入计划负载；
 * 2. `ensurePlan` 用它决定逾期补做任务要预留多少分钟 ——
 *    同一份材料只可能被做一次，它的投影差额也只能预留一次。
 *
 * ── 为什么必须抽出来共用 ──
 *
 * 两个消费方各自算过一遍时，**两个方向相反的漂移都实测出现过**：
 *
 * - 预留**不足** ⇒ 计划占用虚高到超过可用时间（实测超出可用预算）；
 * - 预留**过度** ⇒ 明明有可用时间与可执行内容，却排不出计划
 *   （实测 6 条同一目标的逾期别名把 60 分钟日压到只剩 13 分钟，
 *   10 条时只剩 7 分钟，30 分钟日直接归零）。
 *
 * 后者的根因正是"每个别名各预留一次"：同一份材料被当成了 N 份独立工作量。
 * 把认领逻辑收敛到一处，这两种漂移就不再可能各自发生。
 *
 * 认领顺序刻意与 `nextTask` 的选择顺序一致（进行中 → 待完成 → 其余），
 * 因此**主导动作永远不会是被判为重复的那一条** —— 否则会出现
 * "主 CTA 说重复、次入口反而可用"的荒谬状态。
 *
 * 判据是领域标识（`canonicalKey`），不是 href / 标题 / 任务 id：
 * 编码、尾斜杠、大小写任何变化都不会让同一个目标被当成两个，
 * 而两条时长或标题偶然相同的**不同**任务也不会被错误合并。
 */
function claimCanonicalTargets(views: TodayTaskView[]): {
  /** 被判为重复（同一目标已被更优先的一条认领）的任务 id。 */
  duplicateIds: Set<string>;
  /**
   * 按 canonical 目标分组，组内**全部**别名（含被认领的那一条）。
   *
   * 只有带 canonical 身份的任务才会进组 —— 身份未知 / 不可执行的任务
   * **不参与分组**，因此不会互相抵消成"已去重"。
   */
  byCanonicalKey: Map<string, TodayTaskView[]>;
} {
  const claimed = new Set<string>();
  const claimOrder = [
    ...views.filter((view) => view.task.status === "in_progress"),
    ...views.filter((view) => view.task.status === "pending"),
    ...views.filter((view) => view.task.status !== "in_progress" && view.task.status !== "pending"),
  ];
  const duplicateIds = new Set<string>();
  const byCanonicalKey = new Map<string, TodayTaskView[]>();

  for (const view of claimOrder) {
    // 没有 canonical 身份：既不认领，也不判重（不得猜测它是哪一份材料）
    if (!view.canonicalKey) continue;
    const group = byCanonicalKey.get(view.canonicalKey);
    if (group) group.push(view);
    else byCanonicalKey.set(view.canonicalKey, [view]);
    if (claimed.has(view.canonicalKey)) duplicateIds.add(view.task.id);
    else claimed.add(view.canonicalKey);
  }

  return { duplicateIds, byCanonicalKey };
}

/**
 * 逾期补做任务的分区与预留 —— **按 canonical 目标去重，同一目标只算一份工作**。
 *
 * ── 返回三样东西，都来自同一个认领裁决 ──
 *
 * 1. `representatives`：交给 `planDay` 装箱的补做任务，每个 canonical 目标最多一条；
 * 2. `duplicateAliases`：同一目标的其余别名。它们**仍然要留在计划里**
 *    （界面显示「与上一条同一部分」，用户看得到自己还有这些历史条目），
 *    但不参与装箱 —— 因为它们不是独立的工作量；
 * 3. `reserve`：这个目标因"投影放大"需要从预算里预留的分钟数。
 *
 * ── 为什么必须同时修"装箱"与"预留" ──
 *
 * 两者都会让同一份材料被当成 N 份：
 *
 * - 预留按任务累加 ⇒ 6 条别名把 60 分钟日压到 13 分钟，10 条压到 7 分钟，
 *   30 分钟日直接归零 —— 系统声称没时间，而时间一直都在；
 * - 装箱按任务累加 ⇒ 10 条别名各占 3 分钟装箱额度（共 30），
 *   而聚合只认其中一份（7 分钟），差额 23 分钟被白白吃掉，
 *   当天真正的第二/第三个阅读目标因此排不进来。
 *
 * 只修其中一边，另一边仍会把可用时间变成排不出的空转。
 *
 * ── 预留取多少 ──
 *
 * `max(0, effective − min(estimated))`：
 *
 * - 投影**放大**时才需要预留；
 * - 取组内**最小**的历史值，因为 planner 可能只装下最小的那一条别名 ——
 *   那是差额最大的情形，预留必须覆盖它；
 * - 组内历史值相同时（旧模板生成的别名恒等），退化为
 *   `max(0, effective − estimated)`，与别名条数**无关**。
 *   这正是"加别名不会越加越少"的关键性质。
 *
 * ── 不参与去重的任务 ──
 *
 * 没有 canonical 身份的任务（非阅读 / 引用失效的阅读）**逐条保留**，
 * 全部进入 `representatives`：它们各自是独立的合法工作量，
 * 不得因为"都没有身份"而被互相去重。它们的预留为 0
 * （有效分钟数 ≤ 历史值，方向安全）。
 *
 * `toTaskView` + `effectiveMinutesOf` + `claimCanonicalTargets` 全部与
 * `getTodayView` 共用，不另立第二套判据。
 */
function partitionOutstandingForPlanning(
  repos: Repositories,
  profileId: string,
  outstanding: StudyTask[],
): {
  representatives: StudyTask[];
  duplicateAliases: Array<{ task: StudyTask; canonicalKey: string }>;
  reserve: number;
} {
  const views = outstanding.map((task) => toTaskView(repos, profileId, task));
  const { byCanonicalKey } = claimCanonicalTargets(views);

  /*
   * 每个 canonical 目标选一条代表。
   *
   * 用 `claimCanonicalTargets` 的认领顺序（进行中 → 待完成）挑选，
   * 与 `getTodayView` 判定"谁是重复"的顺序**完全一致** ——
   * 否则可能出现"装箱的那条被判为重复、被去重的那条反而被认领"的错位。
   */
  const representativesByKey = new Map<string, StudyTask>();
  for (const group of byCanonicalKey.values()) {
    representativesByKey.set(group[0].canonicalKey!, group[0].task);
  }

  // 再按仓库既有顺序（plan_date, sort_order）分流，保持确定性
  const representatives: StudyTask[] = [];
  const duplicateAliases: Array<{ task: StudyTask; canonicalKey: string }> = [];
  for (const view of views) {
    const key = view.canonicalKey;
    // 无 canonical 身份：独立工作量，逐条保留
    if (key === null) {
      representatives.push(view.task);
      continue;
    }
    if (representativesByKey.get(key)?.id === view.task.id) representatives.push(view.task);
    // 带着自己的 canonical 身份返回：调用方要按"目标是否真被排入"再筛一次
    else duplicateAliases.push({ task: view.task, canonicalKey: key });
  }

  let reserve = 0;
  for (const group of byCanonicalKey.values()) {
    /*
     * 同一 canonicalKey ⇒ 同一试卷同一大题 ⇒ 同一排练预算，
     * 因此组内每一条的 `effectiveMinutes` 必然相等（取第一条即可）。
     */
    const effective = effectiveMinutesOf(group[0]);
    if (effective === null) continue; // 不可执行：今天不构成工作量，无需预留
    const smallestEstimate = Math.min(...group.map((view) => view.task.estimatedMinutes));
    reserve += Math.max(0, effective - smallestEstimate);
  }

  return { representatives, duplicateAliases, reserve };
}

function toTaskView(repos: Repositories, profileId: string, task: StudyTask): TodayTaskView {
  /*
   * 阅读类任务（含**历史合成行**）统一走投影。
   *
   * 判据是任务的 kind，不是它的引用类型 —— 因为需要被收敛的正是那些
   * 引用 `practice-library.ts` 的旧行。投影会给出当前 canonical 真实目标
   * 及其真实卷次/大题名/排练预算；历史 DB 行本身一个字节都不改。
   */
  const projection = projectReadingTask(repos, profileId, task);

  if (projection.kind === "converged") {
    const { candidate, href } = projection;
    return {
      task,
      content: null,
      contentReady: true,
      contentPendingReason: null,
      minutesLabel: `${candidate.minutes} 分钟`,
      href,
      isRealPaperReading: true,
      // 用真实目标的卷次与大题名，而不是历史行里那句合成素材标题
      displayTitle: `真实真题阅读训练 · ${candidate.label}`,
      displayMinutes: candidate.minutes,
      canonicalKey: canonicalTargetKey(candidate),
      // 由 getTodayView 统一裁决（同一目标只认领一次）
      canonicalDuplicate: false,
      isHistoricalCompleted: false,
      /*
       * 初值由 `toTaskView` 给出；`getTodayView` 在裁决完重复标记后会**重算**
       * （见那里的注释）—— 因为重复项不该计入计划负载，
       * 而"谁是重复"要到那时才知道。
       */
      effectiveMinutes: candidate.minutes,
      candidate,
    };
  }

  if (projection.kind === "unavailable") {
    return {
      task,
      content: null,
      contentReady: false,
      contentPendingReason: projection.reason,
      // 不可用时**不展示任何时长**：没有真实目标就没有可信的分钟数
      minutesLabel: "",
      href: taskHrefOf(task.id, task.contentRef),
      isRealPaperReading: true,
      /*
       * 标题也不能沿用历史行（F1 的同一条理由）。
       *
       * 历史行写的是「阅读训练 12 分钟」—— 那是合成素材的语义，
       * 而"12 分钟"这个数字属于一份早已不再被使用的材料。
       * 把它摆在"不可用"的任务上，会让学习者以为产品里有一份
       * 12 分钟的合成阅读训练（它其实已经不存在了）。
       *
       * 这里用中性的领域措辞：说明它是阅读训练、且尚未解析到目标。
       * 具体**为什么**不可用由 `contentPendingReason` 给出（模考保留 /
       * 库为空 / 内容包不可用），那是三件不同的事。
       */
      displayTitle: "阅读训练 · 待重新安排",
      displayMinutes: null,
      canonicalKey: null,
      canonicalDuplicate: false,
      isHistoricalCompleted: false,
      effectiveMinutes: null,
      candidate: null,
    };
  }

  /*
   * **历史事实**：旧合成体系下**已完成**的阅读任务。
   *
   * 它不收敛、不重包装 —— 当时用户做的是一份合成阅读题，不是任何真题。
   * 因此这里原样沿用它的历史语义，并且：
   * - 让 F7/F8 依赖的字段保持历史值（标题与时长都是当年的）；
   * - `isRealPaperReading` 由**调用方**在 typed 收口处置为 false
   *   （见下方 `materialize`：只有 `converged` 才算真实真题）。
   */
  if (projection.kind === "historical_completed") {
    return {
      task,
      content: resolveContent(task.contentRef),
      contentReady: false,
      contentPendingReason: null,
      minutesLabel: `${task.estimatedMinutes} 分钟`,
      href: taskHrefOf(task.id, task.contentRef),
      isRealPaperReading: false,
      displayTitle: task.title,
      displayMinutes: task.estimatedMinutes,
      canonicalKey: null,
      canonicalDuplicate: false,
      isHistoricalCompleted: true,
      /*
       * 它的分钟数**照常计入**今天的聚合 —— 它当时确实占用了那段时间。
       * F9 约束的是语义（不得被重新标记为真题），不是抹掉它的时长。
       */
      effectiveMinutes: task.estimatedMinutes,
      candidate: null,
    };
  }

  const content = resolveContent(task.contentRef);
  const isReview = task.kind === "review" || task.contentRef?.contentType === "review_deck";
  const missing = task.contentRef !== null && content === null && !isReview;
  const pending =
    content?.type === "listening_pending"
      ? content.reason
      : missing
        ? "该任务引用的内容不存在，可能是内容库更新导致的引用失效。"
        : null;

  return {
    task,
    content,
    contentReady: pending === null,
    contentPendingReason: pending,
    minutesLabel: `${task.estimatedMinutes} 分钟`,
    href: taskHrefOf(task.id, task.contentRef),
    isRealPaperReading: false,
    displayTitle: task.title,
    displayMinutes: task.estimatedMinutes,
    canonicalKey: null,
    canonicalDuplicate: false,
    isHistoricalCompleted: false,
    effectiveMinutes: task.estimatedMinutes,
    candidate: null,
  };
}

/**
 * 把内容库映射成 planner 需要的目录。
 *
 * planner 不接受内容对象，只接受 `{id, type, minutes}` 加少量可选排序/文案位：
 * 它对内容的内容一无所知，只负责排时间。这样内容库变化不会影响 planner 的测试。
 *
 * ── 阅读这一格来自哪里（本次收敛的核心）──
 *
 * 它来自**已导入的真实真题**里可训练的阅读大题，而不是
 * `practice-library.ts` 的合成篇章。`candidates` 可以由调用方预先算好传入 ——
 * 发现候选需要解析试卷包，同一次渲染里算两遍是浪费。
 */
export function getContentCatalog(
  repos: Repositories,
  profileId: string,
  candidates?: ReadingTargetCandidate[],
): ContentCatalog {
  const toOption = (item: ContentItem): ContentOption => ({
    id: item.id,
    type: item.type,
    minutes: item.estimatedMinutes,
  });

  const reading = readingContentOptions(
    candidates ?? listReadingTargetCandidates(repos, profileId),
  );

  return {
    // 词汇组仍然服务阅读能力，但它是**加分项**：planner 只把 PRIMARY_CONTENT_TYPE
    // 当作主题材，因此词汇不会被这条目录挤掉（见 planner 的注释）。
    reading: [...reading, ...contentRepository.listVocabularySets().map(toOption)],
    writing: contentRepository.listWritingPrompts().map(toOption),
    translation: contentRepository.listTranslationPrompts().map(toOption),
    // 听力：只把真正可播放的素材计入。Phase 1 的 listening_pending 是"缺素材声明"，
    // 不是内容，因此刻意不放入目录 —— 否则 planner 会排出一个点不开的听力任务。
    listening: [],
  };
}

/**
 * 当前真正有可执行素材的模块。
 * 由内容库推导，内容补齐后听力会自动回到计划里，不需要改代码。
 *
 * 阅读的"可执行"如今等价于"库里至少有一个训练池中的真实真题阅读大题" ——
 * 空库时它会自然消失，于是 planner 不会排出一条点进去没有内容的阅读任务。
 */
export function getExecutableSkills(
  repos: Repositories,
  profileId: string,
  catalog?: ContentCatalog,
): Skill[] {
  const resolved = catalog ?? getContentCatalog(repos, profileId);
  return (Object.keys(resolved) as Skill[]).filter((skill) => (resolved[skill] ?? []).length > 0);
}

/** 常规可用分钟数：工作日 / 周末分别取自用户偏好。 */
export function regularMinutesFor(repos: Repositories, profileId: string, date: string): number {
  const profile = repos.learner.getProfile();
  if (!profile) return 60;
  return isWeekend(date) ? profile.preferences.weekendMinutes : profile.preferences.weekdayMinutes;
}

/**
 * 为指定日期生成或读取计划。
 * @param force 为 true 时强制重排（例如用户修改了今天可用时间）
 */
export function ensurePlan(
  repos: Repositories,
  profileId: string,
  date: string,
  options?: { availableMinutes?: number; force?: boolean; generatedBy?: DailyPlan["generatedBy"] },
): DailyPlan {
  const existing = repos.plan.getPlan(profileId, date);
  const profile = repos.skillProfile.get(profileId);
  const goal = repos.learner.getGoal(profileId);

  const regular = regularMinutesFor(repos, profileId, date);

  if (existing && !options?.force && options?.availableMinutes === undefined) {
    return existing;
  }

  const availableMinutes = options?.availableMinutes ?? existing?.availableMinutes ?? regular;
  const examDate = goal?.examDate ?? addDays(date, 180);

  const dueReviews = repos.review.getDueItems(profileId, date);
  const outstanding = repos.plan.getOutstandingCoreTasks(profileId, date);
  const recentSkills = repos.records.getRecentlyPractisedSkills(profileId, addDays(date, -6));

  // 真实真题阅读候选只发现一次，目录与可执行模块共用它（避免重复解析试卷包）
  const readingCandidates = listReadingTargetCandidates(repos, profileId);
  const catalog = getContentCatalog(repos, profileId, readingCandidates);

  /*
   * 保留已完成任务：重排不应抹掉今天已经做过的事。
   *
   * 它们在下面被原样搬进新计划（不是待办，但确实是当天发生过的事实）。
   */
  const done = (existing?.tasks ?? []).filter((t) => t.status === "completed");

  /*
   * ── 单位对齐：planner 按 `estimatedMinutes` 装箱，聚合按 `effectiveMinutes` 计数 ──
   *
   * 两处**单位不同**，因此在"投影改变了时长"的任务上会各自漂移。投影只作用于
   * 阅读类任务，而新排的阅读任务其目录时长与投影后的目标预算**恒等**
   * （见 `getContentCatalog` 的 `readingContentOptions`），因此差额只可能来自：
   *
   * 1. **已完成任务**：它们先占预算，`planDay` 只拿剩下的（见下）。
   * 2. **逾期补做任务**：它的 `estimatedMinutes` 是**历史值**，而投影后
   *    `effectiveMinutes` 是**真实目标的排练预算**。投影可能把它**放大**
   *    （实测：历史 12 分钟 → 目标 26 分钟），于是 planner 按 12 装箱、
   *    聚合按 26 计数 —— 差额会顶穿当天预算。
   *
   * 第二条是本次审计中按同一缺陷类追出来的（评审只报了第一条）。
   * 两条都在**服务边界**修，因为只有这里同时看得到"装箱依据"与"计数依据"。
   */
  const doneMinutes = done.reduce(
    (sum, task) => sum + (effectiveMinutesOf(toTaskView(repos, profileId, task)) ?? 0),
    0,
  );

  /*
   * 逾期补做任务：按 **canonical 目标**分区，同一目标只当**一份**工作量。
   *
   * 只有 `representatives` 进 `planDay` 装箱 —— 同一目标的其余别名虽然
   * 仍然留在计划里（界面显示「与上一条同一部分」），但不占装箱额度，
   * 因为它们不是独立可执行的工作量。
   *
   * 刻意复用 `toTaskView` + `effectiveMinutesOf` + `claimCanonicalTargets`
   * （与 `getTodayView` 完全同一套），不另写"这条补做任务会占多少分钟"
   * 或"谁和谁是同一份材料"的第二套判据 —— 两套必然漂移，
   * 而两种漂移方向都已经实测过：预留不足 ⇒ 计划虚高；过度预留 ⇒ 计划为空。
   */
  const {
    representatives: outstandingRepresentatives,
    duplicateAliases: outstandingDuplicateAliases,
    reserve: outstandingReserve,
  } = partitionOutstandingForPlanning(repos, profileId, outstanding);

  const budgetForNewWork = Math.max(0, availableMinutes - doneMinutes - outstandingReserve);

  const output = planDay({
    today: date,
    examDate,
    targetScore: goal?.targetScore ?? 550,
    /*
     * **只把剩余预算交给 planner**：已完成的那部分已经花掉了，
     * 补做任务的投影差额也已经预留 —— 两者都不能再被排一次。
     * 这是本不变量唯一的实现点。
     */
    availableMinutes: budgetForNewWork,
    profile,
    dueReviewItems: dueReviews,
    /*
     * 只交**每个 canonical 目标一条代表**：同一目标的其余别名不是独立工作量，
     * 让它们参与装箱会白白吃掉当天额度（实测 10 条别名吃掉 23 分钟）。
     */
    outstandingTasks: outstandingRepresentatives,
    recentCompletedSkills: recentSkills,
    executableSkills: getExecutableSkills(repos, profileId, catalog),
    contentCatalog: catalog,
  });

  // 内容已由 planner 直接绑定（时长来自素材本身），这里不再二次分配。
  const tasks = output.tasks;

  /*
   * ── 只有**真的排进今天**的目标才保留它的重复别名 ──
   *
   * 别名不占装箱额度，但 `getTodayView` 会让每个 canonical 目标贡献
   * **一条**有效分钟数 —— 无论它是被认领的代表还是别名。
   *
   * 因此若代表因为放不下而**没有被排入**（预算太小），别名也不能落库：
   * 否则那个目标今天根本没被安排，却仍会以别名身份计入计划占用。
   * 实测（历史 12 分钟 → 目标 7 分钟，可用 5 分钟）：
   * 代表放不进 ⇒ planned=0 正确；但别名一落库 ⇒ **planned=7 > 可用 5**。
   *
   * 判据用**装箱结果**，不是"代表是否存在" —— 只有 planner 真的收下了它，
   * 这个目标今天才算被安排。
   *
   * 这里必须走 `projectReadingTask` 而不是直接读 `contentRef`：补做任务的引用
   * 仍是历史合成篇章（`reading_passage`），它的 canonical 身份只有**投影**
   * 之后才存在。新排的阅读任务则携带 `reading_target` 引用，
   * 投影对它同样是幂等的（直接解析到同一个目标）。
   */
  const packedCanonicalKeys = new Set(
    tasks
      .map((task) => {
        // planner 排出的任务一定是 pending 的新任务
        const projection = projectReadingTask(repos, profileId, { ...task, status: "pending" });
        return projection.kind === "converged" ? canonicalTargetKey(projection.candidate) : null;
      })
      .filter((key): key is string => key !== null),
  );
  const persistedAliases = outstandingDuplicateAliases.filter((alias) =>
    packedCanonicalKeys.has(alias.canonicalKey),
  );

  return repos.plan.savePlan(profileId, {
    date,
    // 存**用户真正拥有的**当天预算（不是给 planner 的那个余额）：
    // "今天有多少时间"必须如实显示 60，而不是扣除后的余额。
    availableMinutes,
    /*
     * ── 落库的计划总量：为什么它不再等于"显示的计划占用" ──
     *
     * 这个数**不是**学习者看到的"计划占用"（那个是 `getTodayView` 的
     * `plannedMinutes`，由 `effectiveMinutesOf` 统一算出）。它的用途是让
     * **库里**也有一句不夸大当天安排的话。
     *
     * 它与显示值的关系**可以往两个方向偏**，不能简单说成"保守"：
     *
     * - 补做任务被投影放大时，显示值会比它**大**（实测 57 落库 / 52 显示：
     *   落库按历史值算，显示按真实目标预算算）；
     * - 同一目标存在多条重复别名时，显示值会比它**小**
     *   （显示只认一份，落库含全部别名行）。
     *
     * 因此**唯一权威的显示口径始终是 `getTodayView().plannedMinutes`**。
     *
     * `planned_for_minutes ≤ available_minutes` 也**不是**普遍成立的：
     * 用户可以把今天的可用时间改到比**已经完成的**时间还少
     * （实测：已完成 40 分钟，可用改成 0）。那时诚实的记录就是
     * "落库 40 / 可用 0，且不再排新内容" —— 已完成的事实不该被抹掉
 * 或压缩到可用时间以内来让这条不等式成立。
     */
    plannedForMinutes: doneMinutes + output.plannedMinutes,
    generatedBy: options?.generatedBy ?? (existing ? "deterministic_planner" : profile ? "diagnostic_initial" : "deterministic_planner"),
    notes: output.notes,
    // planner 的提示必须落库：它是用户理解"今天计划为何如此"的唯一来源
    warnings: output.warnings,
    tasks: [
      ...done.map((task) => ({
        id: task.id,
        kind: task.kind,
        skill: task.skill,
        priority: task.priority,
        title: task.title,
        rationale: task.rationale,
        estimatedMinutes: task.estimatedMinutes,
        contentRef: task.contentRef,
        status: task.status,
        order: task.order,
      })),
      ...tasks.map((task, index) => ({
        kind: task.kind,
        skill: task.skill,
        priority: task.priority,
        title: task.title,
        rationale: task.rationale,
        estimatedMinutes: task.estimatedMinutes,
        contentRef: task.contentRef,
        status: "pending" as const,
        order: done.length + index,
      })),
      /*
       * 同一 canonical 目标的重复别名**仍然留在今天的计划里**（当且仅当该目标
       * 今天真的被排入，见上面 `persistedAliases`）。
       *
       * 它们不参与装箱（不占当天额度，见 `partitionOutstandingForPlanning`），
       * 但也不该从学习者眼前消失：界面会把它们显示为「与上一条同一部分」，
       * 让他知道自己还有这些历史条目，而不是以为它们被悄悄丢掉了。
       */
      ...persistedAliases.map(({ task }, index) => ({
        kind: task.kind,
        skill: task.skill,
        priority: task.priority,
        title: task.title,
        rationale: task.rationale,
        estimatedMinutes: task.estimatedMinutes,
        contentRef: task.contentRef,
        status: "pending" as const,
        order: done.length + tasks.length + index,
      })),
    ],
  });
}

export function getTodayView(repos: Repositories, profileId: string, date: string): TodayView {
  const plan = ensurePlan(repos, profileId, date);
  const goal = repos.learner.getGoal(profileId);
  const profile = repos.skillProfile.get(profileId);
  const examDate = goal?.examDate ?? addDays(date, 180);

  const built = plan.tasks.map((task) => toTaskView(repos, profileId, task));

  /*
   * ── 同一 canonical 目标只能被"认领"一次（F2）──
   *
   * 认领规则由 `claimCanonicalTargets` 唯一实现 —— 它同时服务本函数
   * （决定谁是重复项）与 `ensurePlan`（决定逾期补做要预留多少分钟）。
   * 见那里的注释：两个消费方各自算一遍时，预留不足与过度预留**都**实测出现过。
   */
  const { duplicateIds } = claimCanonicalTargets(built);

  /*
   * ── 重复标记必须在 `effectiveMinutes` 之前落定 ──
   *
   * `effectiveMinutes` 依赖 `canonicalDuplicate`（重复项不计入计划负载），
   * 而重复是谁由下面的认领循环决定。因此认领必须先跑，
   * 再据此**重算**有效分钟数 —— 否则 `toTaskView` 里那个初值会留在原地，
   * 计划占用就会把同一份材料算两次（实测 64 > 60）。
   */
  const tasks = built
    .map((view) => (duplicateIds.has(view.task.id) ? { ...view, canonicalDuplicate: true } : view))
    .map((view) => ({ ...view, effectiveMinutes: effectiveMinutesOf(view) }));

  const completed = plan.tasks.filter((t) => t.status === "completed");
  const activeTasks = plan.tasks.filter((t) => t.status !== "completed");

  /*
   * ── 分钟数聚合必须用**有效分钟数**，不是 `task.estimatedMinutes`（F8）──
   *
   * `task.estimatedMinutes` 是**历史行里存的原始值**。对一条被投影过的阅读任务
   * 来说，那个数字属于早已作废的合成素材（例如 12 分钟），而它今天实际是
   * 另一个大题（例如 7 分钟）。若聚合继续读原始值，同一个任务会同时
   * 以两个数字出现（CTA 说 7、配比说 12），页面自相矛盾。
   *
   * 因此下面全部经由 `effectiveMinutesOf`：
   * - 可执行的投影阅读任务 → 真实目标的排练预算；
   * - 其余任务 → 任务自身时长；
   * - 不可用的投影阅读任务 → **不计入**（它今天不是可执行工作量）；
   * - 历史已完成的合成任务 → **不计入**（它不是今天的活）。
   *
   * `completedMinutes` 是唯一例外：它表达"**已经做掉**了多少分钟"，
   * 因此用具历史真实性的 `displayMinutes`（一条已完成的历史任务确实花过
   * 那段时间），而不是"可执行工作量"。`displayMinutes` 为 null 时记 0。
   */
  const sumEffective = (predicate: (view: TodayTaskView) => boolean): number =>
    tasks.reduce((sum, view) => {
      if (!predicate(view)) return sum;
      return sum + (view.effectiveMinutes ?? 0);
    }, 0);

  const completedMinutes = tasks.reduce(
    (sum, view) =>
      view.task.status === "completed" ? sum + (view.displayMinutes ?? 0) : sum,
    0,
  );
  const plannedMinutes = sumEffective((view) => view.task.status !== "skipped");

  /*
   * 主导之外的阅读入口是否已被占用。
   *
   * 判据是"活跃任务里是否存在一条指向 canonical 真实真题目标的阅读任务"。
   * 只看**未完成且非重复**的任务：一条已完成的阅读任务不该阻止今天的
   * "随时可做"入口，而重复项本来就不会渲染成独立入口。
   */
  const hasPrimaryReadingTarget = tasks.some(
    (view) =>
      view.isRealPaperReading &&
      view.canonicalKey !== null &&
      !view.canonicalDuplicate &&
      view.task.status !== "completed" &&
      view.contentReady,
  );

  const regular = regularMinutesFor(repos, profileId, date);
  const dueReviews = repos.review.getDueItems(profileId, date);
  const activity = repos.records.getActivity(profileId, 7, date);

  const warnings = [...plan.warnings];
  /*
   * 顺延量同样用有效分钟数（F8）：它表达"今天放不下、要顺延多少分钟"，
   * 因此不能被一条不可执行的投影阅读任务的历史时长污染。
   */
  const deferred = tasks.reduce(
    (sum, view) =>
      view.task.status === "pending" && view.task.priority === "optional" && plan.availableMinutes < 60
        ? sum + (view.effectiveMinutes ?? 0)
        : sum,
    0,
  );

  const remainingMinutes = plan.availableMinutes - completedMinutes;
  if (plan.availableMinutes > 0 && remainingMinutes < 5 && activeTasks.length > 0) {
    warnings.push("今天的计划时间已经用满，剩余任务可以顺延到明天。");
  }

  return {
    date,
    examDate,
    daysRemaining: daysUntil(date, examDate),
    targetScore: goal?.targetScore ?? 550,
    examName: goal?.examName ?? "CET-6",
    availableMinutes: plan.availableMinutes,
    plannedMinutes,
    completedMinutes,
    completedCount: completed.length,
    totalCount: plan.tasks.length,
    progress: plan.tasks.length === 0 ? 0 : completed.length / plan.tasks.length,
    tasks,
    nextTask:
      tasks.find((t) => t.task.status === "in_progress") ??
     tasks.find((t) => t.task.status === "pending" && t.contentReady) ??
      null,
    warnings,
    notes: plan.notes,
    isShortDay: plan.availableMinutes <= 30 && plan.availableMinutes < regular,
    regularMinutes: regular,
    dueReviewCount: dueReviews.length,
    hasDiagnostic: Boolean(profile?.basedOnDiagnosticId),
    recentActivity: activity.map((a) => ({
      date: a.date,
      minutes: a.minutes,
      tasksCompleted: a.tasksCompleted,
    })),
    deferredMinutes: deferred,
    hasPrimaryReadingTarget,
  };
}

/** 用户调整今天可用时间 → 重排计划。这是"适应现实生活"的核心操作。 */
export function setAvailableMinutes(
  repos: Repositories,
  profileId: string,
  minutes: number,
  date: string = todayISO(),
): { ok: true; plan: DailyPlan } | { ok: false; error: string } {
  const parsed = availableMinutesSchema.safeParse(minutes);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "时间无效" };
  }
  const plan = ensurePlan(repos, profileId, date, {
    availableMinutes: parsed.data,
    force: true,
    generatedBy: "deterministic_planner",
  });
  return { ok: true, plan };
}

/** 把今天未完成的非核心任务顺延到明天的计划里。 */
export function deferRemainingTasks(
  repos: Repositories,
  profileId: string,
  date: string,
): { ok: true; moved: number } {
  const plan = repos.plan.getPlan(profileId, date);
  if (!plan) return { ok: true, moved: 0 };
  const remaining = plan.tasks.filter((t) => t.status === "pending");
  for (const task of remaining) {
    repos.plan.updateTaskStatus(task.id, "skipped", nowISO());
  }
  return { ok: true, moved: remaining.length };
}
