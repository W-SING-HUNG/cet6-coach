import Link from "next/link";
import { redirect } from "next/navigation";
import { ArrowRight, BookOpen, CalendarClock, Clock, Target, TrendingUp } from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getTodayView } from "@/services/plan";
import { explainNoReadingTarget, firstAvailableReadingTarget } from "@/services/reading-plan";
import { todayISO, formatDisplayDate } from "@/lib/date";
import { Panel } from "@/components/ui/panel";
import { Notice } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { TaskList } from "./task-list";
import { TimeAdjuster } from "./time-adjuster";
import { WeekPulse } from "./week-pulse";
import { minutesLabel } from "@/lib/utils";

export const metadata = { title: "今日" };
export const dynamic = "force-dynamic";

/**
 * Today —— 产品最重要的页面。
 *
 * ── v1 的问题（已核实）──
 * "下一步"（计划任务）与"真实真题 · 随时可做"是两个**同权重的强调面板**：
 * 同样的描边、相近的字号、各带一个按钮。放在一起时，学习者要先做一次
 * 取舍才能知道该点哪个 —— 而 PRODUCT_PRINCIPLES 第 14 条要求
 * "打开产品就知道今天做什么；需要用户在多个选项之间权衡，本身就是产品没做完"。
 *
 * ── v2 的解法：一个主导动作，其余按层级退后 ──
 *
 * 1. **主导块**：下一步该做什么。字号最大、只有一个主 CTA、独占一整块宽度。
 *    它是页面上唯一"实心强调"的交互元素。
 * 2. **次强调行**：真题速练。它仍然首屏可见（因为"随时可做"是真实的独立路径），
 *    但视觉层级明确低于主导块，且与主导块同处一个容器 —— 因此不构成第二个
 *    "我该点哪个"的岔路。
 * 3. **支撑区**：任务清单、时间调整、配比、近 7 天。放在宽画布的多列栅格上，
 *    而不是挤在一条窄列 + 300px 侧栏里。
 *
 * 排版顺序即优先级顺序，这一点与 v1 一致；变的是**层级对比度**：
 * v1 让所有区块长得差不多，v2 让主导动作明显更重。
 *
 * ── 宽度 ──
 * Today 属于 `wide` 外壳（AppShell 决定），因此吃满应用画布：
 * 1440 下三列栅格（主区 2 列 + 侧栏 1 列），而不是中间一条窄列。
 */
export default async function TodayPage() {
  const repos = getRepositories();
  const state = getOnboardingState(repos);

  if (!state.onboarded || !state.profile) {
    redirect("/onboarding");
  }
  if (!state.skillProfile?.basedOnDiagnosticId) {
    redirect("/diagnostic");
  }

  const today = todayISO();
  const view = getTodayView(repos, state.profile.id, today);
  const goal = state.goal;

  /*
   * 真实真题阅读训练的**次强调**入口（"随时可做"）。
   *
   * ── 它为什么可能被隐去（F2）──
   *
   * 当主导动作本身就是一条真实真题阅读训练时，这个入口会指向**同一个**
   * canonical 目标。两个入口同目的地却挂不同文案 = 让学习者做一次无意义的取舍，
   * 违反 Product UI V2 的"一个主导动作"。因此投影已经把那条任务的标题
   * 改写成真实卷次与大题；此时这个重复入口不再渲染。
   *
   * 它只在**真的提供另一个可选动作**时留下（例如主导动作是写作/翻译，
   * 而复习之外还可以顺手做一篇真题阅读）。
   *
   * 候选来自 `firstAvailableReadingTarget` —— 与 planner 排任务、
   * 与历史任务解析共用同一套规则，**模考保留绝不出现**（早先直接用了
   * `listAllReadingTargets`，会把保留卷也当成"随时可做"）。
   */
  const quickStartTarget = view.hasPrimaryReadingTarget
    ? null
    : firstAvailableReadingTarget(repos, state.profile.id);
  const quickStartInProgress = quickStartTarget?.lastRunStatus === "in_progress";

  /*
   * 没有可训练真题时的**诚实说明**。
   *
   * ── 为什么用服务层的三分诊断，而不是一句写死的导入指引 ──
   *
   * "没有可训练材料"有三种完全不同的原因，出路也不同：
   * 库是空的 → 去导入；卷子全被设为模考保留 → 去调整策略；
   * 内容包不可用 → 去修复。写死"需要你自行导入"在第二种情形下是**误导** ——
   * 材料明明就在库里，用户会以为产品坏了。
   *
   * 这里复用 `explainNoReadingTarget`（与 planner、旧执行器解析共用同一条规则），
   * 因此三处的说明不可能互相矛盾。
   */
  const noReadingReason =
    quickStartTarget === null && !view.hasPrimaryReadingTarget
      ? explainNoReadingTarget(repos, state.profile.id)
      : null;

  return (
    /*
     * ── 为什么这里**不再**写 max-width / px-* ──
     *
     * 上一轮为了消掉 Today 贴边，在这一层加了 `max-w-[1280px]` + `px-*`。
     * 当时全局 gutter 被 `px-0` 抵消，所以那是必要的局部补丁。
     *
     * 本轮已把**唯一权威**的页面 gutter 收回到 `globals.css` 的
     * `.app-canvas`（Wide = 1280px + 响应式 16/20/24/32px）。因此这里
     * 若再保留一层 max-width + padding，两翼边距会被**加倍**
     * （1440 下从 80px 变成 160px），Today 会比其它页面明显更窄。
     *
     * 所以只保留该页**自己的**排版职责：纵向节奏与栅格间距。
     * 卡片内部 padding、任务列表密度、左右栏 gap 等上一轮已验证的调整
     * 全部原样保留。
     */
    <div className="flex flex-col gap-6">
      <TodayHeader
        today={today}
        daysRemaining={view.daysRemaining}
        examDate={view.examDate}
        examName={goal?.examName ?? null}
        targetScore={goal?.targetScore ?? null}
        completedCount={view.completedCount}
        totalCount={view.totalCount}
        completedMinutes={view.completedMinutes}
        dueReviewCount={view.dueReviewCount}
      />

      {view.warnings.length > 0 ? (
        <div className="flex flex-col gap-2.5">
          {view.warnings.map((warning) => (
            <Notice key={warning} tone="warn" title="计划已调整">
              {warning}
            </Notice>
          ))}
        </div>
      ) : null}

      {/*
        主导区：唯一的"下一步"。
        它承载整页最高层级，且内部只有**一个**主 CTA。
        真题速练作为同容器内的次强调行出现 —— 因此学习者不需要在两个
        平行面板之间做取舍。
      */}
      <section aria-label="接下来做什么" className="grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <PrimaryAction view={view} />

        {quickStartTarget ? (
          <div className="flex flex-col justify-between rounded-lg border border-edge bg-surface-raised p-6">
            <div>
              <p className="text-[12px] font-medium text-content-faint">真实真题 · 随时可做</p>
              <h2 className="mt-1.5 text-[16px] leading-snug font-semibold text-content">
                {quickStartTarget.label}
              </h2>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-content-soft">
                {quickStartTarget.questionCount} 题 · 排练预算 {quickStartTarget.minutes} 分钟
                {quickStartInProgress
                  ? " · 上次没做完，可以接着做"
                  : quickStartTarget.lastRunStatus
                    ? " · 做过，可以再练一次"
                    : ""}
              </p>
            </div>
            <div className="mt-4 flex flex-wrap items-center gap-3">
              {/*
                这是**次强调**的可选入口（不经过计划排期），且只在与主导动作
                指向**不同**目标时才出现 —— 否则它就是重复入口（F2）。
                它与主导动作进入的是同一个 Expert Training 工作面：
                全产品只有一条真实真题阅读路径，不存在第二套训练系统。
              */}
              <Link
                href={`/practice/papers/${quickStartTarget.paperId}/train/${quickStartTarget.sectionId}`}
                className="inline-flex h-9 items-center gap-2 rounded-sm border border-accent bg-surface-raised px-3.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent hover:text-surface-raised"
              >
                <BookOpen className="size-4" />
                {quickStartInProgress ? "继续真题训练" : "开始真题训练"}
              </Link>
              <Link
                href="/practice/papers"
                className="text-[12.5px] text-content-faint transition-colors hover:text-content"
              >
                挑别的卷子
              </Link>
            </div>
            <p className="mt-3 border-t border-edge pt-3 text-[12px] leading-relaxed text-content-faint">
              这条路不经过计划排期，随时可用；内容与判分都来自真实历年真题，不依赖 AI。
            </p>
          </div>
        ) : view.hasPrimaryReadingTarget ? null : (
          /*
            只有**确实没有**可用真实真题阅读目标时才显示这段说明。
            主导动作已经是真题阅读训练时（`hasPrimaryReadingTarget`），
            这里必须为空 —— 否则页面上会同时出现"还没有可训练的真题"
            与一条正在练真题的主导动作，自相矛盾。
          */
          <div className="rounded-lg border border-dashed border-edge-strong bg-surface-raised p-6">
            <p className="text-[12px] font-medium text-content-faint">真实真题</p>
            <h2 className="mt-1.5 text-[16px] font-semibold text-content">暂时没有可训练的阅读大题</h2>
            <p className="mt-1.5 text-[12.5px] leading-relaxed text-content-soft">
              {noReadingReason}
            </p>
            <Link
              href="/practice/papers"
              className="mt-3 inline-flex h-9 items-center gap-2 rounded-sm border border-edge-strong px-3.5 text-[13px] font-medium text-content transition-colors hover:border-content-faint"
            >
              查看真题库
              <ArrowRight className="size-3.5" />
            </Link>
          </div>
        )}
      </section>

      {/* 支撑区：宽画布栅格，主区 2/3 + 侧栏 1/3 */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          <section>
            <div className="mb-3 flex flex-wrap items-end justify-between gap-2">
              <h2 className="text-[15px] font-semibold tracking-tight text-content">今天的任务</h2>
              {/*
                E2E 契约：这条文案的 `已完成 N / M` 格式被 flow.spec.ts 解析。
                改格式会静默破坏那条测试的进度断言。
              */}
              <p className="text-[13px] text-content-faint">
                已完成 {view.completedCount} / {view.totalCount}
                {view.totalCount > 0 ? ` · 约 ${minutesLabel(view.completedMinutes)}` : ""}
              </p>
            </div>
            <TaskList
              tasks={view.tasks.map((t) => ({
                id: t.task.id,
                // 投影后的真实标题与时长：阅读任务不能用历史合成素材的语义
                title: t.displayTitle,
                rationale: t.task.rationale,
                priority: t.task.priority,
                skill: t.task.skill,
                kind: t.task.kind,
                status: t.task.status,
                estimatedMinutes: t.displayMinutes,
                contentReady: t.contentReady,
                pendingReason: t.contentPendingReason,
                canonicalDuplicate: t.canonicalDuplicate,
                // 路由由服务层唯一决定：阅读任务指向真实真题工作面，
                // 其余仍走旧执行器。界面不得自己拼 URL。
                href: t.href,
                isRealPaperReading: t.isRealPaperReading,
              }))}
            />
          </section>

          <section>
            <h2 className="mb-3 text-[15px] font-semibold tracking-tight text-content">近 7 天</h2>
            <WeekPulse activity={view.recentActivity} />
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-6">
          <TimeAdjuster
            availableMinutes={view.availableMinutes}
            regularMinutes={view.regularMinutes}
            isShortDay={view.isShortDay}
            plannedMinutes={view.plannedMinutes}
            completedMinutes={view.completedMinutes}
            deferredMinutes={view.deferredMinutes}
          />

          <Panel className="p-6">
            <div className="flex items-center gap-2">
              <Target className="size-4 text-content-faint" />
              <h2 className="text-[13px] font-medium text-content">今天的训练配比</h2>
            </div>
            <ul className="mt-3 space-y-2">
              {/*
                配比用**有效分钟数**（F8），不是 `item.task.estimatedMinutes`。
                同一条任务在 CTA 里显示的是投影后的真实时长，配比必须一致 ——
                否则页面会同时说两个数字，而那条任务只有一份。
                不可执行/历史已完成的任务 `effectiveMinutes` 为 null，不计入。
              */}
              {view.tasks
                .filter((t) => t.task.status !== "skipped" && t.effectiveMinutes !== null)
                .reduce<Array<{ skill: string; minutes: number }>>((acc, item) => {
                  const minutes = item.effectiveMinutes!;
                  const found = acc.find((a) => a.skill === item.task.skill);
                  if (found) found.minutes += minutes;
                  else acc.push({ skill: item.task.skill, minutes });
                  return acc;
                }, [])
                .sort((a, b) => b.minutes - a.minutes)
                .map((entry) => (
                  <li
                    key={entry.skill}
                    className="flex items-center justify-between gap-2 text-[13px]"
                  >
                    <span className="text-content-soft">{SKILL_TEXT[entry.skill] ?? entry.skill}</span>
                    <span className="tabular font-mono text-[12px] text-content-faint">
                      {entry.minutes}m
                    </span>
                  </li>
                ))}
              {view.tasks.length === 0 ? (
                <li className="text-[13px] text-content-faint">今天没有安排任务。</li>
              ) : null}
            </ul>
            <p className="mt-3 border-t border-edge pt-3 text-[12px] leading-relaxed text-content-faint">
              配比来自诊断结果。听力与阅读占卷面 70%，是主要得分区。
            </p>
          </Panel>

          {view.dueReviewCount > 0 ? (
            <Panel className="border-accent/25 bg-accent-soft p-6">
              <div className="flex items-center gap-2">
                <TrendingUp className="size-4 text-accent" />
                <p className="text-[13px] font-medium text-accent">
                  {view.dueReviewCount} 项待复习
                </p>
              </div>
              <p className="mt-1.5 text-[12px] leading-relaxed text-content-soft">
                之前做错的内容进入了遗忘窗口。复习任务已经排在今天的计划里，不会额外增加负担。
              </p>
            </Panel>
          ) : null}

          <Panel className="p-6">
            <p className="text-[13px] font-medium text-content">今天没时间怎么办</p>
            <p className="mt-1.5 text-[12px] leading-relaxed text-content-soft">
              把上方时间调低，计划会立刻重排 —— 核心任务保留、次要任务顺延。
              完全没时间也不用紧张：没有连续打卡要求，跳过一天不会重置任何进度。
            </p>
            <Link href="/settings" className="mt-3 inline-block">
              <Button variant="ghost" size="sm">
                修改常规时间
              </Button>
            </Link>
          </Panel>
        </aside>
      </div>
    </div>
  );
}

const SKILL_TEXT: Record<string, string> = {
  listening: "听力",
  reading: "阅读",
  writing: "写作",
  translation: "翻译",
};

/**
 * 页头。
 *
 * 与 v1 的差异：倒计时不再是页面**唯一**的视觉焦点。
 * v1 把"距离考试还有 N 天"做成 32px 大标题 + 右侧倒计时卡，
 * 于是真正要做的动作被压到标题下面 —— 层级倒置了。
 * v2 让 h1 保持（它回答了"还有多久"，是背景信息），
 * 但把倒计时收成一行内联状态，把整页最强的视觉权重留给"下一步"。
 *
 * 保留内容：日期、h1 文本、考试日期、完成进度 —— 前三项是 E2E 契约。
 */
function TodayHeader({
  today,
  daysRemaining,
  examDate,
  examName,
  targetScore,
  completedCount,
  totalCount,
  completedMinutes,
  dueReviewCount,
}: {
  today: string;
  daysRemaining: number;
  examDate: string;
  examName: string | null;
  targetScore: number | null;
  completedCount: number;
  totalCount: number;
  completedMinutes: number;
  dueReviewCount: number;
}) {
  return (
    <header className="border-b border-edge pb-5">
      <p className="text-[12.5px] font-medium text-content-faint">
        {formatDisplayDate(today)}
        {examName ? <span className="ml-2">{examName}</span> : null}
        {targetScore !== null ? <span className="ml-1.5">· 目标 {targetScore} 分</span> : null}
      </p>

      <div className="mt-1.5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-content sm:text-[30px]">
          距离考试还有 {Math.max(daysRemaining, 0)} 天
        </h1>

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[12.5px]">
          <span className="inline-flex items-center gap-1.5 text-content-soft">
            <CalendarClock className="size-3.5 text-content-faint" />
            <span className="tabular font-mono">{examDate}</span>
          </span>
          <span className="inline-flex items-center gap-1.5 text-content-soft">
            <Clock className="size-3.5 text-content-faint" />
            今日已练 <span className="tabular font-medium text-content">{completedMinutes}</span> 分钟
          </span>
          {dueReviewCount > 0 ? (
            <span className="inline-flex items-center gap-1.5 text-accent">
              <TrendingUp className="size-3.5" />
              <span className="tabular">{dueReviewCount}</span> 项待复习
            </span>
          ) : null}
          <span className="text-content-faint">
            任务 {completedCount}/{totalCount}
          </span>
        </div>
      </div>
    </header>
  );
}

/**
 * 主导动作块。
 *
 * 这是整页唯一的最高层级元素。三种状态都必须给出**一个**明确的动作：
 * 有下一步任务 → "开始"；任务全清 → 说明不需要加练；无任务 → 解释为什么。
 * 没有一种状态是"死胡同"（由架构门禁固定）。
 *
 * `下一步` 这三个字是 E2E 契约（flow.spec.ts 断言它可见），保留为小节标签。
 */
function PrimaryAction({ view }: { view: Awaited<ReturnType<typeof getTodayView>> }) {
  const next = view.nextTask;

  if (view.tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-edge-strong bg-surface-raised p-6">
        <p className="text-[12px] font-medium text-content-faint">下一步</p>
        <h2 className="mt-1.5 text-[19px] font-semibold text-content">今天没有安排</h2>
        <p className="mt-2 max-w-lg text-[13.5px] leading-relaxed text-content-soft">
          可用时间设为 0，所以没有生成任务。这不是失败 —— 把时间调高一点，计划会立刻出现。
        </p>
      </div>
    );
  }

  if (!next) {
    const pendingOnly = view.tasks.filter((t) => t.task.status === "pending").length;
    return (
      <div className="rounded-lg border border-succ/30 bg-accent-soft p-6">
        <p className="text-[12px] font-medium text-accent">下一步</p>
        <h2 className="mt-1.5 text-[19px] font-semibold text-accent">
          {pendingOnly > 0 ? "今天的任务都已完成" : "今天的任务已全部完成"}
        </h2>
        <p className="mt-2 max-w-lg text-[13.5px] leading-relaxed text-content-soft">
          {pendingOnly > 0
            ? `还有 ${pendingOnly} 项任务因为内容素材未就绪暂时无法开始。`
            : "完成了今天的安排。不需要额外加练 —— 计划已经在为明天做准备。"}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border-2 border-accent bg-surface-raised p-6">
      <p className="text-[12px] font-medium text-accent">下一步</p>
      {/*
        标题用**投影后的**文案（`displayTitle`），不是 `task.title`。
        对阅读任务来说这至关重要：历史行的标题写着「阅读训练 12 分钟」，
        而它点下去落在某个真实真题大题上 —— 直接渲染旧标题就是在骗人。
        投影已经把它换成'真实真题阅读训练 · 2025 年 6 月 · 选词填空'这类
        说清目的地的措辞（F1）。
      */}
      <h2 className="mt-1.5 text-[21px] leading-snug font-semibold text-content sm:text-[23px]">
        {next.displayTitle}
      </h2>
      <p className="mt-2 max-w-xl text-[13.5px] leading-relaxed text-content-soft">
        {next.task.rationale}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {/*
          唯一的"下一步"动作。URL 来自服务层投影：
          真实真题阅读任务直接进入 Expert Training 工作面，
          因此这里不会再把学习者送进旧的合成练习执行器。
        */}
        <Link href={next.href}>
          <Button size="lg" icon={<ArrowRight className="size-4" />}>
            {next.isRealPaperReading ? "继续真实真题训练" : "开始"}
          </Button>
        </Link>
        {/*
          时长只在**有真实数字**时显示。阅读任务的分钟数来自它真实目标的
          排练预算；没有可用目标时为 null —— 那时宁可不显示，也不编造一个数字
          （旧实现把合成素材的 12 分钟当成了真实大题的时长）。
        */}
        {next.displayMinutes !== null ? (
          <span className="text-[13px] text-content-faint">
            预计 {minutesLabel(next.displayMinutes)}
          </span>
        ) : null}
        {next.isRealPaperReading ? (
          <span className="rounded-sm border border-accent/30 bg-accent-soft px-2 py-0.5 text-[11.5px] font-medium text-accent">
            真实历年真题
          </span>
        ) : null}
      </div>
    </div>
  );
}
