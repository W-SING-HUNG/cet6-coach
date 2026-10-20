import Link from "next/link";
import { redirect } from "next/navigation";
import {
  ArrowRight,
  BookOpenCheck,
  Headphones,
  Languages,
  LibraryBig,
  Lock,
  PenLine,
  Play,
} from "lucide-react";
import { getRepositories } from "@/repositories/sqlite";
import { getOnboardingState } from "@/services/onboarding";
import { getTodayView } from "@/services/plan";
import { getPaperLibrary } from "@/services/papers";
import { listAllReadingTargets } from "@/services/expert-training";
import { contentRepository } from "@/content";
import { todayISO } from "@/lib/date";
import {
  PAPER_FRESHNESS_LABELS,
  isPaperEligibleForStrictMock,
} from "@/domain/paper-freshness";
import { isPaperReservedForMock, isPaperStartableForPractice } from "@/domain/paper";
import { Panel } from "@/components/ui/panel";
import { EmptyState } from "@/components/ui/states";
import { Button } from "@/components/ui/button";
import { minutesLabel } from "@/lib/utils";

export const metadata = { title: "练习" };
export const dynamic = "force-dynamic";

/**
 * Practice —— "我可以**刻意选择**练什么"。
 *
 * ── v1 的问题 ──
 * 它是一个"内容库总览"：真题库一格、今日任务一格、然后四张内容卡
 * （阅读/翻译/写作/词汇）+ 一组听力待补卡。结果是**卡片堆**：
 * 学习者要在一屏 8 个形状相同的区块里找"我能点哪个开始练"，
 * 而真题训练这个真正可用的路径只是其中一格。
 *
 * ── v2 的结构 ──
 *
 * 1. **可训练的真题大题**（主要区域）。每份卷子的每个阅读大题一行，
 *    带真实身份（哪年哪场哪部分）、真实状态（未开始/进行中/已完成，练过几次）、
 *    以及**一个**明确动作（开始训练 / 继续训练 / 看结果）。
 *    这才是"我可以选择练什么"的直接回答。
 * 2. **今天计划里的训练**（如果还有未完成的）。
 * 3. **原创练习素材**（as-is，如实标注来源），视觉权重最低。
 * 4. **听力待补素材**：如实说明缺什么，不提供假播放器。
 *
 * ── 模考保留策略（内容门禁）──
 * `pool === "mock_reserve"` 的试卷**不提供训练入口**。
 * 理由：保留未做过的真题是为了留到后期做真实模考 ——
 * 如果这里仍给一个"开始训练"按钮，保留策略就名存实亡，
 * 而"未触碰材料"是**有限资源**（PRODUCT_PRINCIPLES 第 7 条）。
 * 界面明确写出这一点，而不是静默隐藏。
 */
export default async function PracticePage() {
  const repos = getRepositories();
  const state = getOnboardingState(repos);
  if (!state.onboarded || !state.profile) redirect("/onboarding");

  const today = todayISO();
  const view = getTodayView(repos, state.profile.id, today);
  const library = getPaperLibrary(repos, state.profile.id);
  const readingTargets = listAllReadingTargets(repos, state.profile.id);
  const readings = contentRepository.listReadingPassages();
  const vocab = contentRepository.listVocabularySets();
  const translations = contentRepository.listTranslationPrompts();
  const writings = contentRepository.listWritingPrompts();
  const listening = contentRepository.listListeningPending();

  const pendingTasks = view.tasks.filter((t) => t.task.status !== "completed");
  /*
   * 训练池归属必须走**领域层唯一谓词**，不要写 `pool === "training"`。
   * 页面各自比较字符串正是"保留卷在某一页仍能开始训练"那类缺口的来源。
   */
  const trainable = readingTargets.filter((paper) => isPaperStartableForPractice(paper));
  const reserved = readingTargets.filter((paper) => isPaperReservedForMock(paper));

  return (
    <div className="flex flex-col gap-6">
      <header className="border-b border-edge pb-5">
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
          <div className="min-w-0">
            <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-content sm:text-[30px]">
              练习
            </h1>
            <p className="mt-2 max-w-3xl text-[13.5px] leading-relaxed text-content-soft">
              这里回答「我可以刻意选什么来练」。日常训练仍以 Today 生成的计划为准 ——
              它会根据你的画像决定练什么、练多久；下面是可以自己挑的入口。
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Link
              href="/practice/courses"
              className="inline-flex h-10 items-center gap-2 rounded-sm border border-edge-strong bg-surface-raised px-4 text-[13px] font-medium text-content transition-colors hover:border-content-faint"
            >
              <BookOpenCheck className="size-4 text-content-faint" />
              课程材料
            </Link>
            <Link
              href="/practice/papers"
              className="inline-flex h-10 shrink-0 items-center gap-2 rounded-sm border border-edge-strong bg-surface-raised px-4 text-[13px] font-medium text-content transition-colors hover:border-content-faint"
            >
              <LibraryBig className="size-4 text-content-faint" />
              浏览真题
              <span className="tabular text-[12px] text-content-faint">{library.counts.total} 份</span>
            </Link>
          </div>
        </div>
      </header>

      <section aria-labelledby="trainable-heading">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          {/*
            "真题库" 这个词是 E2E 契约（papers-empty.spec.ts 用
            `section:has-text("真题库")` 定位这一区块），因此必须作为区块标签保留。
            右侧的「N 份」同样被断言（空库时必须显示「0 份」）。
          */}
          <h2
            id="trainable-heading"
            className="text-[15px] font-semibold tracking-tight text-content"
          >
            真题库
            <span className="ml-2 text-[13px] font-normal text-content-faint">
              可训练的阅读大题
            </span>
          </h2>
          <p className="text-[12.5px] text-content-faint">
            <span className="tabular">{library.counts.total} 份</span>
            <span className="mx-1.5">·</span>
            真实历年真题 · 交卷即得确定性判分
          </p>
        </div>

        {trainable.length === 0 ? (
          <EmptyState
            title={library.counts.total === 0 ? "还没有导入真题" : "训练池里还没有可训练的阅读大题"}
            description={
              library.counts.total === 0
                ? "真题内容存放在本机私有目录，需要你自行导入 —— 产品不会生成模拟题来填充这里。"
                : "库里的试卷要么被设为模考保留，要么不含可训练的阅读大题。"
            }
            action={
              <Link href="/practice/papers">
                <Button variant="secondary" size="sm">
                  查看真题库
                </Button>
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-4">
            {trainable.map((paper) => (
              <PaperTrainBlock key={paper.paperId} paper={paper} />
            ))}
          </div>
        )}
      </section>

      {reserved.length > 0 ? (
        <section aria-labelledby="reserved-heading">
          <h2
            id="reserved-heading"
            className="mb-3 text-[15px] font-semibold tracking-tight text-content"
          >
            模考保留
          </h2>
          <div className="rounded-md border border-warn/25 bg-warn-soft px-4 py-3.5">
            <p className="flex items-start gap-2 text-[13px] leading-relaxed text-content-soft">
              <Lock className="mt-0.5 size-4 shrink-0 text-warn" />
              <span>
                下面这些试卷被你标为「模考保留」，因此不提供训练入口。
                刻意留住没做过的真题，后面才能用真正没见过的卷子做模考 ——
                未触碰的材料是有限资源，不是可随意消耗的余额。
              </span>
            </p>
            <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 border-t border-warn/20 pt-3">
              {reserved.map((paper) => {
                /*
                 * ── 保留 ≠ 尚未接触（Invariant 3）──
                 *
                 * 一份保留卷可能已经在课程材料中接触过其中内容。
                 * 那**不改变**它"不提供训练入口"这一策略结论（池归属没变），
                 * 但它改变了"这是一份没见过的卷子"这个隐含承诺 ——
                 * 因此必须在这里如实标注，否则用户会带着错误的预设去用它做严格模考。
                 */
                const freshness = library.freshness?.get(paper.paperId) ?? null;
                const stillFresh = freshness === null || isPaperEligibleForStrictMock(freshness);
                return (
                  <li key={paper.paperId} className="text-[12.5px] text-content-soft">
                    {paper.paperTitle}
                    <span className="ml-2 text-content-faint">
                      {paper.targets.length} 个阅读大题保留
                    </span>
                    {!stillFresh ? (
                      <span className="ml-2 text-warn">
                        · {PAPER_FRESHNESS_LABELS[freshness.state]}
                      </span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
            {library.freshnessCounts.exposed > 0 || library.freshnessCounts.uncertain > 0 ? (
              <p className="mt-3 border-t border-warn/20 pt-3 text-[12px] leading-relaxed text-content-soft">
                标注「{PAPER_FRESHNESS_LABELS.exposed}」或「{PAPER_FRESHNESS_LABELS.uncertain}」
                的试卷，其内容已经通过课程材料被你看到过（或无法确认是否看到过）——
                这不代表你会做或不会做这些题，只说明它们不再是「从未见过」的严格模考材料。
                在真题库的试卷详情页可以看到具体是哪些部分。
              </p>
            ) : null}
          </div>
        </section>
      ) : null}

      <section aria-labelledby="planned-heading">
        <h2
          id="planned-heading"
          className="mb-3 text-[15px] font-semibold tracking-tight text-content"
        >
          今天计划里的训练
        </h2>
        {pendingTasks.length === 0 ? (
          <EmptyState
            title="今天的训练已全部完成"
            description="没有未完成的任务。明天会按同样的规则生成新的计划。"
            action={
              <Link href="/today">
                <Button variant="secondary" size="sm">
                  返回 Today
                </Button>
              </Link>
            }
          />
        ) : (
          <ul className="overflow-hidden rounded-md border border-edge bg-surface-raised">
            {pendingTasks.map((item, index) => (
              <li
                key={item.task.id}
                className={`flex items-center justify-between gap-3 px-4 py-3 ${
                  index !== pendingTasks.length - 1 ? "border-b border-edge" : ""
                }`}
              >
                <div className="min-w-0">
                  {/*
                    标题/时长用**投影后**的字段（F7），不是 `task.title` /
                    `task.estimatedMinutes`。

                    历史合成阅读任务在 Today 上已经被投影成真实真题目标；
                    若这里继续读原始字段，同一条任务在 /practice 上会显示成
                    「阅读训练 12 分钟」—— 而点下去的其实是某个真题大题。
                    同一个数据源，两页不能说两套话。
                  */}
                  <p className="text-[14px] font-medium text-content">{item.displayTitle}</p>
                  <p className="mt-0.5 text-[12px] text-content-faint">
                    {item.task.priority === "core"
                      ? "核心"
                      : item.task.priority === "recommended"
                        ? "推荐"
                        : "可选"}
                    {/* 没有可信时长时只显示优先级与来源，不编造数字 */}
                    {item.displayMinutes !== null ? (
                      <> · {minutesLabel(item.displayMinutes)}</>
                    ) : null}
                    {item.isRealPaperReading ? " · 真实历年真题" : ""}
                  </p>
                  {!item.contentReady && item.contentPendingReason ? (
                    <p className="mt-1.5 max-w-2xl text-[12px] leading-relaxed text-warn">
                      {item.contentPendingReason}
                    </p>
                  ) : null}
                </div>
                {/*
                  动作的唯一裁决顺序（与 Today 一致）：
                  1. 不可执行 → 说明状态，不给 CTA（含不可用的投影阅读任务）
                  2. 同一 canonical 目标已被更优先的一条占用 → 不给第二个 CTA
                  3. 否则给一个指向 canonical 目标的入口
                */}
                {!item.contentReady ? (
                  <span className="shrink-0 rounded-sm border border-warn/25 bg-warn-soft px-2 py-1 text-[11px] text-warn">
                    不可用
                  </span>
                ) : item.canonicalDuplicate ? (
                  <span className="shrink-0 rounded-sm border border-edge-strong bg-surface px-2 py-1 text-[11px] text-content-faint">
                    与上一条同一部分
                  </span>
                ) : (
                  <Link href={item.href} className="shrink-0">
                    <Button size="sm">开始</Button>
                  </Link>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/*
        原创练习素材。
        如实标注来源：这些是项目原创素材，**不是真题**。
        视觉权重刻意最低（放在页面末尾、用折叠区），因为"能练什么真题"
        才是这个页面的主线。
      */}
      <section aria-labelledby="library-heading">
        <h2
          id="library-heading"
          className="mb-3 text-[15px] font-semibold tracking-tight text-content"
        >
          原创练习素材
        </h2>
        <details className="rounded-md border border-edge bg-surface-raised">
          <summary className="cursor-pointer px-4 py-3.5 text-[13.5px] font-medium text-content">
            共 {readings.length + translations.length + writings.length + vocab.length} 项
            <span className="ml-2 font-normal text-content-faint">
              项目原创内容，与历年真题是两类来源
            </span>
          </summary>
          <div className="grid gap-x-6 gap-y-4 border-t border-edge px-4 py-4 sm:grid-cols-2">
            <ContentGroup
              icon={<BookOpenCheck className="size-4" />}
              title="阅读"
              total={readings.length}
              unit="篇"
              items={readings.map((r) => ({
                id: r.id,
                title: r.title,
                meta: `${r.wordCount} 词 · ${r.questions.length} 题`,
              }))}
            />
            <ContentGroup
              icon={<Languages className="size-4" />}
              title="翻译"
              total={translations.length}
              unit="题"
              items={translations.map((t) => ({
                id: t.id,
                title: t.title,
                meta: `${t.keyPoints.length} 个关键信息点`,
              }))}
            />
            <ContentGroup
              icon={<PenLine className="size-4" />}
              title="写作"
              total={writings.length}
              unit="题"
              items={writings.map((w) => ({ id: w.id, title: w.title, meta: `${w.minWords}-${w.maxWords} 词` }))}
            />
            <ContentGroup
              icon={<BookOpenCheck className="size-4" />}
              title="词汇"
              total={vocab.length}
              unit="组"
              items={vocab.map((v) => ({ id: v.id, title: v.title, meta: `${v.entries.length} 个词` }))}
            />
          </div>
        </details>
      </section>

      <section aria-labelledby="listening-heading">
        <h2
          id="listening-heading"
          className="mb-1.5 text-[15px] font-semibold tracking-tight text-content"
        >
          听力素材（待补）
        </h2>
        <p className="mb-3 max-w-3xl text-[13px] leading-relaxed text-content-soft">
          听力占卷面 35%，是权重最高的模块之一。但 Phase 1 没有音频素材，也不会使用来源不明的真题音频。
          以下是已经建模、等待素材的任务类型：
        </p>
        <div className="grid gap-2.5 lg:grid-cols-2">
          {listening.map((item) => (
            <Panel key={item.id} className="border-warn/25 bg-warn-soft">
              <div className="flex items-start gap-3">
                <Headphones className="mt-0.5 size-4 shrink-0 text-warn" />
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-content">{item.title}</p>
                  <p className="mt-1 text-[13px] leading-relaxed text-content-soft">{item.reason}</p>
                  <ul className="mt-2 space-y-0.5 text-[12px] text-content-soft">
                    {item.requiredAssets.map((asset) => (
                      <li key={asset}>· {asset}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </Panel>
          ))}
        </div>
      </section>
    </div>
  );
}

/** 一份可训练试卷：列出它的每个阅读大题及其真实状态与唯一动作。 */
function PaperTrainBlock({
  paper,
}: {
  paper: {
    paperId: string;
    paperTitle: string;
    sourceKind: string;
    targets: Array<{
      sectionId: string;
      label: string;
      questionCount: number;
      groupCount: number;
      firstNumber: number | null;
      lastNumber: number | null;
      lastRun: { status: string; submittedAt?: string | null } | null;
    }>;
  };
}) {
  return (
    <article className="overflow-hidden rounded-md border border-edge bg-surface-raised">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-edge px-4 py-3">
        <h3 className="text-[15px] font-semibold text-content">{paper.paperTitle}</h3>
        <span className="text-[12px] text-content-faint">{paper.targets.length} 个可训练大题</span>
        {/* 来源类型必须可见：真题与夹具/示例包绝不能长得一样 */}
        {paper.sourceKind !== "real_past_paper" ? (
          <span className="rounded-sm border border-danger/30 bg-danger-soft px-1.5 py-0.5 text-[11px] font-medium text-danger">
            非真题来源
          </span>
        ) : null}
      </div>

      <ul>
        {paper.targets.map((target, index) => {
          const inProgress = target.lastRun?.status === "in_progress";
          const completed = target.lastRun?.status === "completed";
          return (
            <li
              key={target.sectionId}
              className={`flex flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3 ${
                index !== paper.targets.length - 1 ? "border-b border-edge" : ""
              }`}
            >
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[14px] font-medium text-content">
                  {target.label}
                  <StatusChip inProgress={inProgress} completed={completed} />
                </p>
                <p className="mt-0.5 flex flex-wrap gap-x-3 text-[12px] text-content-faint">
                  <span className="tabular">
                    {target.questionCount} 题 · {target.groupCount} 组
                  </span>
                  {target.firstNumber !== null && target.lastNumber !== null ? (
                    <span className="tabular">
                      第 {target.firstNumber}–{target.lastNumber} 题
                    </span>
                  ) : null}
                </p>
              </div>

              <Link
                href={`/practice/papers/${paper.paperId}/train/${target.sectionId}`}
                className="inline-flex h-9 shrink-0 items-center gap-2 rounded-sm border border-accent bg-surface-raised px-3.5 text-[13px] font-medium text-accent transition-colors hover:bg-accent hover:text-surface-raised"
              >
                <Play className="size-3.5" />
                {inProgress ? "继续训练" : completed ? "看结果 / 再练一次" : "开始训练"}
              </Link>
            </li>
          );
        })}
      </ul>
    </article>
  );
}

/** 状态不只靠颜色：文字 + 图标同时表达。 */
function StatusChip({ inProgress, completed }: { inProgress: boolean; completed: boolean }) {
  if (inProgress) {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
        <Play className="size-3" />
        进行中
      </span>
    );
  }
  if (completed) {
    return (
      <span className="inline-flex items-center gap-1 rounded-sm border border-succ/30 bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">
        <ArrowRight className="size-3" />
        已完成
      </span>
    );
  }
  return (
    <span className="rounded-sm border border-edge-strong bg-surface px-1.5 py-0.5 text-[11px] text-content-faint">
      未开始
    </span>
  );
}

function ContentGroup({
  icon,
  title,
  total,
  unit,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  total: number;
  unit: string;
  items: Array<{ id: string; title: string; meta: string }>;
}) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-content-faint">{icon}</span>
        <h3 className="text-[13.5px] font-medium text-content">{title}</h3>
        <span className="tabular ml-auto font-mono text-[11px] text-content-faint">
          {total} {unit}
        </span>
      </div>
      {items.length === 0 ? (
        <p className="mt-2 text-[13px] text-content-faint">暂无内容。</p>
      ) : (
        <ul className="mt-2 space-y-1.5">
          {items.map((item) => (
            <li key={item.id} className="flex items-baseline justify-between gap-3">
              <span className="truncate text-[13px] text-content-soft">{item.title}</span>
              <span className="shrink-0 font-mono text-[11px] text-content-faint">{item.meta}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
