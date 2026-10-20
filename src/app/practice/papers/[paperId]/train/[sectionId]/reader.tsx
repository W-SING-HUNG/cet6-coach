"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  ArrowRight,
  Bookmark,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  Info,
  MinusCircle,
  RotateCcw,
  Send,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/states";
import { cn, minutesLabel } from "@/lib/client-utils";
import {
  startReadingRunAction,
  submitReadingRunAction,
} from "@/app/practice/papers/train-actions";
import type {
  ReadingTrainingResult,
  ReadingTrainingSession,
  TrainingQuestionView,
} from "@/services/expert-training";
import { useTrainingSession } from "./use-training-session";
import { QuestionNavigator, type NavigatorEntry } from "./question-navigator";
import { SubmitDialog } from "./submit-dialog";
import { CarefulReadingPanel, MatchingPanel, BankedClozePanel } from "./question-kinds";
import { StimulusPane } from "./stimulus-pane";

/**
 * 真题阅读训练的回答工作区。
 *
 * ── 与 v1 的根本差异：它是一件**工具**，不是一个页面 ──
 *
 * v1 把整份材料按顺序渲染成一篇长文档：先所有刺激材料，再所有题目。
 * 后果是学习者必须**在两屏之间来回滚动**才能对照原文做题 ——
 * 这不是风格问题，是任务结构问题。
 *
 * v2 按真实任务结构重排：
 *
 * 1. **桌面分栏**（55–60% 材料 / 40–45% 作答）。原文始终在视野内，
 *    两者**各自独立滚动**，滚动题目不会把原文推走。
 * 2. **一次一题**。不再把 10 题堆成一张竖排表单，而是聚焦当前题。
 * 3. **导航常驻**。上一题 / 题号（打开导航器）/ 下一题固定在作答栏底部，
 *    不需要滚到页面末尾才能翻题或交卷。
 * 4. **题型决定交互**。仔细阅读是"原文 + 单选"，长篇阅读是"段落匹配"，
 *    选词填空是"文章空位 + 词库"—— 三者不再共用一个通用卡片。
 * 5. **移动端不是缩小版分栏**，而是"材料 | 题目"分段切换。
 *
 * ── 不可动摇的语义（v1 已验证，v2 原样保留）──
 *
 * - **未提交时页面上没有答案**：`TrainingQuestionView` 不含 answer 字段。
 * - **草稿与改答案判定走域层纯函数**（`commitAnswer`）：打字不算改答案。
 * - **标记待回看与选项排除是纯本地界面状态**，不进提交载荷、不写台账、
 *   不影响判定结果。见 `use-training-session.ts` 的说明。
 * - **结果只来自服务端**：提交后 `router.refresh()` 读回已落库的事实。
 * - **计时是整体测量**：只上报一个总时长，不逐题归因。
 */

type Phase = "answering" | "submitting" | "error";

export function Reader({
  paperId,
  sectionId,
  session,
}: {
  paperId: string;
  sectionId: string;
  session: ReadingTrainingSession;
}) {
  const router = useRouter();

  /**
   * 题目按**真实题序**展平（跨组保持顺序）。
   * 一次一题的导航、题号、进度都以这个序列为准。
   */
  const allQuestions = useMemo(
    () => session.groups.flatMap((group) => group.questions),
    [session.groups],
  );
  const questionCount = allQuestions.length;

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("answering");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [submitOpen, setSubmitOpen] = useState(false);
  /** 移动端分段：材料还是题目。桌面端忽略。 */
  const [mobilePane, setMobilePane] = useState<"material" | "question">("question");

  /**
   * 移动端两个工作面的**滚动位置记忆**（纯临时交互状态）。
   *
   * ── 为什么需要它（实测根因）──
   * 移动端两个面是**互斥显示**的（`hidden` / `block`），而滚动发生在
   * **document 文档流**上（实测：材料态 `document.documentElement.scrollHeight`
   * 约 2875px，`window.scrollY` 可达 1200；而材料栏自身的 `scroll-region`
   * 在移动端 `scrollHeight === clientHeight`，因为 `lg:workspace-height`
   * 只在 lg 断点生效）。
   *
   * 于是把材料面 `display:none` 时文档高度**塌缩到视口高度**，
   * 浏览器立刻把 `window.scrollY` 钳制为 0 —— 切回来时阅读位置就丢了。
   * 这不是 F-2 引入的回归，而是移动端切换一直存在的缺陷。
   *
   * ── 修法 ──
   * 在**改变 `mobilePane` 之前**记录当前面的 `window.scrollY`；
   * 目标面渲染出来、布局稳定后（下一帧）恢复该面的记录值。
   * 两个面各自独立记忆，因此"题目滚到中间 → 看原文 → 回题目"也能回到原处。
   *
   * `useRef` 而不是 `useState`：它只在切换的那一刻被读写，
   * 不参与渲染，因此不该触发重渲染。它也**不落库、不入证据**
 * （同一原则：这是临时界面状态）。
   */
  const paneScroll = useRef<{ material: number; question: number }>({
    material: 0,
    question: 0,
  });
  /** 待恢复的目标位置；`null` 表示当前不需要恢复。 */
  const paneRestore = useRef<number | null>(null);

  /**
   * 切换移动端工作面（**唯一入口**）。
   *
   * 所有切换点（分段控件、题目导航器、未答题跳转、查看原文按钮）
   * 都必须走这里，否则会出现"某条路径记得保存位置、另一条不记得"的漂移。
   *
   * ── 为什么副作用放在 updater **外面** ──
   * 早先把"记录滚动位置"写在 `setMobilePane(current => ...)` 的 updater 内部。
   * 那是错的：React 要求 state updater 是**纯函数**，
   * 在并发/严格模式下它可能被调用多次，重复写 ref 会产生不可预测的结果。
   * 现在先读当前值、记录、再 `setState`，updater 不承担任何副作用。
   */
  const switchMobilePane = useCallback(
    (next: "material" | "question") => {
      if (mobilePane === next) return;
      // ① 在隐藏当前面**之前**记录它的滚动位置
      paneScroll.current[mobilePane] = window.scrollY;
      // ② 记下目标面要恢复的位置，交给恢复 effect 处理
      paneRestore.current = paneScroll.current[next];
      setMobilePane(next);
    },
    [mobilePane],
  );

  /*
   * 恢复滚动位置。
   *
   * ── 为什么用 `useLayoutEffect` 而不是 effect + rAF ──
   * 这是实测踩到的缺陷：早先用"下一帧再 scrollTo"，结果**首个切换**
   * 会把 `paneRestore` 设为 0（该面还没被滚过），那个延迟的 `scrollTo(0)`
   * 竟落到用户随后的滚动**之后**执行，把刚滚下去的位置又拽回顶部 ——
   * 修复反而制造了"总是回到 0"的假象（实测 `windowScrollY` 
   * 在滚动后读数为 0）。
   *
   * `useLayoutEffect` 在 DOM 变更后、浏览器**绘制前**同步执行：
   * 此时目标面已经拿到 `display`，文档高度也已恢复，因此可以直接写 `scrollY`，
   * 且不会与之后的用户滚动竞争。
   *
   * `target > 0` 才动：0 表示"这个面本来就在顶部"，无需干预 ——
   * 对它执行 `scrollTo` 只会在首次进入时制造一次无意义的写入。
   */
  useLayoutEffect(() => {
    const target = paneRestore.current;
    paneRestore.current = null;
    if (target === null || target <= 0) return;
    window.scrollTo({ top: target, behavior: "instant" as ScrollBehavior });
  }, [mobilePane]);

  const api = useTrainingSession(session.run.id);
  const result = session.result;
  const isDone = result !== null;
  const submitting = phase === "submitting";

  // 计时起点只在 effect 里读时钟 —— render 期间读时间会破坏 React 纯度
  const startedAtRef = useRef<number | null>(null);
  useEffect(() => {
    if (startedAtRef.current === null) startedAtRef.current = Date.now();
  }, []);

  const current = allQuestions[Math.min(index, Math.max(0, questionCount - 1))] ?? null;

  const navigatorEntries: NavigatorEntry[] = useMemo(
    () =>
      allQuestions.map((question, position) => ({
        questionId: question.id,
        number: question.number,
        index: position,
        answered: api.answeredIds.has(question.id),
        marked: api.markedIds.has(question.id),
      })),
    [allQuestions, api.answeredIds, api.markedIds],
  );

  const goTo = useCallback(
    (next: number) => {
      if (questionCount === 0) return;
      setIndex(Math.max(0, Math.min(questionCount - 1, next)));
    },
    [questionCount],
  );

  /**
   * 当前题所属的**材料组**。
   * 题型需要的结构（段落标号、词库）挂在这个组上，而不是在题目上 ——
   * 因为 10 个空共享同一篇文章与同一个词库（见 `PaperGroup` 的模型说明）。
   */
  const groupOf = useCallback(
    (question: TrainingQuestionView | null) =>
      question === null
        ? null
        : (session.groups.find((group) =>
            group.questions.some((item) => item.id === question.id),
          ) ?? null),
    [session.groups],
  );

  /**
   * 已被**其它**空占用的词。
   *
   * 这是真实规则（每词至多使用一次），因此界面上要让它们明显不可选 ——
   * 但**仍然允许点选**：学习者可能发现自己填错了、需要把词挪过来。
   * 硬性禁用会制造一个无法从界面纠正的状态。
   */
  const usedWordsFor = useCallback(
    (question: TrainingQuestionView | null) => {
      const group = groupOf(question);
      if (!group || question === null) return [];
      return group.questions
        .filter((item) => item.id !== question.id)
        .map((item) => api.state.values[item.id] ?? "")
        .filter((word) => word.trim() !== "");
    },
    [groupOf, api.state.values],
  );

  /**
   * 当前空所在题组里的**全部兄弟姐妹 id**（含自己）。
   *
   * 这是选词填空"每词至多使用一次"的**作用域**：词库在题组上，
   * 因此唯一性判定也只能在题组内 —— 跨题组比较会把两份不同文章的词库
   * 混成一套，那既不符合真实题型，也会误清别的组里的作答。
   */
  const siblingIdsFor = useCallback(
    (question: TrainingQuestionView | null) =>
      groupOf(question)?.questions.map((item) => item.id) ?? [],
    [groupOf],
  );

  /**
   * 键盘：← / → 翻题，Esc 由各弹层自行处理。
   * 刻意**不**在输入框内劫持方向键 —— 那会破坏文本编辑与画面阅读。
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (submitOpen || isDone) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable) return;
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        goTo(index - 1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        goTo(index + 1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [goTo, index, submitOpen, isDone]);

  function handleSubmit() {
    if (isDone) return;
    setError(null);
    setSubmitOpen(false);
    setPhase("submitting");

    const started = startedAtRef.current ?? Date.now();
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - started) / 1000));

    startTransition(async () => {
      const response = await submitReadingRunAction({
        paperId,
        sectionId,
        runId: session.run.id,
        responses: allQuestions.map((question) => ({
          questionId: question.id,
          value: api.state.values[question.id] ?? null,
        })),
        elapsedSeconds,
        // 只上报"改过答案"的题。标记与排除**不在这里** —— 它们不是证据。
        changedQuestionIds: api.state.changed,
      });

      if (!response.ok) {
        setError(response.error);
        setPhase("error");
        return;
      }

      // 作答已成为不可变事实：清掉本地草稿，否则"重做"会看起来带着上一轮答案
      api.reset();
      setPhase("answering");
      router.refresh();
    });
  }

  if (questionCount === 0) {
    return (
      <div className="p-6">
        <Notice tone="warn" title="这一部分没有可作答的题目">
          内容包里的这个大题没有题目，因此无法开始作答。
        </Notice>
      </div>
    );
  }

  return (
    /*
     * `--workspace-header-height` 定义在**这个共同祖先**上，而不是训练头内部。
     *
     * ── 为什么必须在这里（独立评审 F-2 的根因）──
     * CSS 自定义属性**不跨兄弟节点继承**，只沿祖先链向下继承。
     * 早先它写在 `<TrainingHeader>` 的 style 上，而移动端分段控件是它的
     * **兄弟**，于是 `top-[var(--workspace-header-height)]` 里的变量为空，
     * 整条声明退化为 `top: auto` —— 粘性定位失效，
     * 长文滚动约 800–1200px 后分段控件直接滚出屏幕（实测复现）。
     *
     * 定义在这个包裹层后，训练头、分段控件、材料/作答栏都能读到同一个值，
     * 因此"分段控件紧贴头部下沿"这件事由**一个来源**保证，
     * 不依赖任何硬编码几何。
     */
    <div
      className="flex min-h-dvh flex-col bg-surface"
      style={{ ["--workspace-header-height" as string]: "3.25rem" }}
    >
      <TrainingHeader
        session={session}
        result={result}
        total={questionCount}
        answered={api.answeredCount}
        paperId={paperId}
        navigatorSlot={
          <QuestionNavigator
            entries={navigatorEntries}
            currentIndex={index}
            mode={isDone ? "review" : "answering"}
            results={result?.questions ?? null}
            onSelect={(next) => {
              goTo(next);
              switchMobilePane("question");
            }}
          />
        }
        markedCount={api.markedIds.size}
      />

      {isDone ? (
        <ReviewWorkspace
          result={result}
          session={session}
          index={index}
          onNavigate={goTo}
          paperId={paperId}
          sectionId={sectionId}
        />
      ) : (
        <>
          {/* 移动端分段开关：桌面隐藏 */}
          <div
            data-testid="mobile-pane-switch"
            className="sticky top-[var(--workspace-header-height)] z-20 border-b border-edge bg-surface-raised px-3 py-1.5 lg:hidden"
          >
            <div
              role="tablist"
              aria-label="材料与题目"
              /* 两个 tab 各占一半；`p-1` 内边距 + 44px 的 tab 高度 = 52px 整体 */
              className="grid grid-cols-2 gap-1 rounded-md bg-surface-sunken p-1"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mobilePane === "material"}
                onClick={() => switchMobilePane("material")}
                /* 触摸目标 ≥44px（F-4）：`min-h-11` = 2.75rem */
                className={cn(
                  "min-h-11 rounded-sm text-[13px] font-medium transition-colors",
                  mobilePane === "material"
                    ? "bg-surface-raised text-content shadow-sm"
                    : "text-content-soft",
                )}
              >
                查看原文
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={mobilePane === "question"}
                onClick={() => switchMobilePane("question")}
                className={cn(
                  "min-h-11 rounded-sm text-[13px] font-medium transition-colors",
                  mobilePane === "question"
                    ? "bg-surface-raised text-content shadow-sm"
                    : "text-content-soft",
                )}
              >
                作答
                <span className="tabular ml-1.5 text-[11px] text-content-faint">
                  {index + 1}/{questionCount}
                </span>
              </button>
            </div>
          </div>

          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            {/* ── 材料栏 ──────────────────────────────────────────────
                桌面：独立滚动区，占 55–60%。
                移动：整屏切换，与题目互斥显示。 */}
            <section
              aria-label="阅读材料"
              className={cn(
                "min-w-0 lg:block lg:w-[56%] lg:shrink-0 lg:border-r lg:border-edge",
                mobilePane === "material" ? "block" : "hidden",
              )}
            >
              <div className="lg:workspace-height scroll-region lg:px-8 lg:py-6">
                <StimulusPane session={session} activeQuestion={current} />
              </div>
            </section>

            {/* ── 作答栏 ──────────────────────────────────────────────
                桌面占 44%，内部为"题干区（滚动）+ 导航条（固定）"。 */}
            <section
              aria-label="作答区"
              className={cn(
                "flex min-w-0 flex-1 flex-col",
                mobilePane === "question" ? "flex" : "hidden lg:flex",
              )}
            >
              <div className="lg:workspace-height scroll-region min-h-0 flex-1 px-4 pt-4 pb-6 sm:px-6 lg:px-8 lg:pt-6">
                <QuestionFocus
                  question={current}
                  index={index}
                  total={questionCount}
                  value={api.state.values[current.id] ?? null}
                  isMarked={api.markedIds.has(current.id)}
                  eliminated={api.state.eliminated[current.id] ?? []}
                  disabled={submitting}
                  onChoose={api.setValue}
                  onCommit={api.commitValue}
                  onClear={() => api.clearValue(current.id)}
                  onToggleMark={() => api.toggleMark(current.id)}
                  onToggleElimination={(optionId) => api.toggleElimination(current.id, optionId)}
                  /* 题型的**真实结构**来自它所属的材料组，而不是猜测 */
                  paragraphLabels={
                    groupOf(current)?.paragraphs?.map((paragraph) => paragraph.label) ?? []
                  }
                  wordBank={groupOf(current)?.wordBank ?? []}
                  usedElsewhere={usedWordsFor(current)}
                  /* 同一题组内的兄弟空：选词填空的"每词至多一次"作用域就是这个集合 */
                  onAssignExclusive={(word) =>
                    api.assignExclusiveValue(current.id, word, siblingIdsFor(current))
                  }
                  onShowMaterial={() => switchMobilePane("material")}
                />
              </div>

              {error ? (
                <div className="px-4 pb-3 sm:px-6 lg:px-8">
                  <Notice tone="danger" title="提交失败">
                    {error}
                    <span className="mt-1 block text-[12px]">
                      你的作答仍在这页上（也在本地草稿里），修好问题后可以直接重试。
                    </span>
                  </Notice>
                </div>
              ) : null}

              <QuestionNavBar
                index={index}
                total={questionCount}
                onPrev={() => goTo(index - 1)}
                onNext={() => goTo(index + 1)}
                canSubmit={!submitting}
                submitting={submitting}
                onSubmit={() => setSubmitOpen(true)}
              />
            </section>
          </div>
        </>
      )}

      {submitOpen && !isDone ? (
        <SubmitDialog
          total={questionCount}
          answered={api.answeredCount}
          marked={api.markedIds.size}
          unansweredIndexes={allQuestions
            .map((question, position) => ({ question, position }))
            .filter(({ question }) => !api.answeredIds.has(question.id))
            .map(({ question, position }) => ({ position, number: question.number }))}
          pending={pending && submitting}
          onJump={(position) => {
            goTo(position);
            switchMobilePane("question");
            /*
             * 跳转后必须**关闭弹层**。
             * 弹层的语义是"确认交卷"，而点击题号表达的是"我还没答完，先去答它"——
             * 这是两个相反的决定。留着弹层会让学习者以为还得再点一次确认，
             * 或者误以为跳转没生效（题面被弹层盖住）。
             */
            setSubmitOpen(false);
          }}
          onCancel={() => setSubmitOpen(false)}
          onConfirm={handleSubmit}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 训练头
// ---------------------------------------------------------------------------

/**
 * 沉浸式训练头。
 *
 * 只放**真实有用**的信息：这是什么卷的哪一部分、已答多少、标记数、
 * 用时、离开的出口、以及导航器。刻意不放：内容版本、包状态、来源徽标 ——
 * 那些属于核对页，放在作答界面上只是把元数据倒给学习者。
 *
 * 当前题号**不在**这里重复：导航器按钮（`第 N / 总`）常驻头部右侧，
 * 它既显示位置又是跳转入口。同一个数字出现两遍只是噪声。
 */
function TrainingHeader({
  session,
  result,
  total,
  answered,
  paperId,
  navigatorSlot,
  markedCount,
}: {
  session: ReadingTrainingSession;
  result: ReadingTrainingResult | null;
  total: number;
  answered: number;
  paperId: string;
  navigatorSlot: React.ReactNode;
  markedCount: number;
}) {
  const progress = total > 0 ? (answered / total) * 100 : 0;

  return (
    /*
     * 训练头：**高度必须精确等于** `--workspace-header-height`。
     *
     * 变量定义在工作区共同祖先上（见 Reader 根节点），这里只**消费**它。
     * 高度写成 `h-[var(--workspace-header-height)]` 而不是魔法数字，
     * 因此"移动端分段控件紧贴头部下沿"由同一个来源保证。
     *
     * ── 移动端单行约束（F-2 的第二半）──
     * 旧实现的内层行用了 `flex-wrap`，且把 `paperTitle` 一起塞进同一个
     * 弹性行里。390 宽下这一行**必然换行**，头部实际高度变得大于 3.25rem，
     * 于是粘性偏移错位（分段控件要么盖住头部、要么留缝隙）。
     *
     * 现在：整行 `flex-nowrap`；身份信息 `truncate`；
     * 低优先级元数据（卷号/日期、用时、标记数）在窄屏**隐藏**；
     * 进度保留但用紧凑写法。因此移动端始终一行、高度恒定。
     */
    <header className="sticky top-0 z-30 h-[var(--workspace-header-height)] border-b border-edge bg-surface-raised">
      <div className="flex h-full flex-nowrap items-center gap-2 px-2 sm:gap-3 sm:px-5 lg:px-8">
        <Link
          href={`/practice/papers/${paperId}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-sm px-2 py-1.5 text-[13px] text-content-soft transition-colors hover:bg-surface-sunken hover:text-content"
        >
          <ArrowLeft className="size-4" />
          <span className="hidden sm:inline">离开</span>
        </Link>

        <div className="flex min-w-0 flex-1 flex-nowrap items-center gap-2">
          <span className="truncate text-[13px] font-medium text-content">
            {session.sectionLabel}
          </span>
          {/*
            会话状态是**真实有用**的信息：它回答
            "我现在是在做新一遍，还是在看上一遍的结果"。
          */}
          <span
            className={cn(
              "shrink-0 rounded-sm border px-1.5 py-px text-[11px] font-medium",
              "border-accent/30 bg-accent-soft text-accent",
            )}
          >
            {result !== null ? "已完成" : "进行中"}
          </span>
          {/* 卷号/日期：低优先级，只在宽屏显示，避免窄屏换行 */}
          <span className="hidden truncate font-normal text-content-faint lg:inline">
            {session.paperTitle}
          </span>
        </div>

        <div className="flex shrink-0 flex-nowrap items-center gap-2 text-[12px] text-content-faint sm:gap-3">
          {/*
            进度必须在**移动端也可见**（它是小屏上唯一的进度来源）。
            文案在所有视口下**统一**为 `已作答 N / M` ——
            不按断点改文案：那会让"移动端显示什么"变成第二套契约，
            既有 E2E 与文档都得跟着分裂。窄屏靠 `whitespace-nowrap`
            与隐藏低优先级元数据来保证单行，而不是靠改文字。
          */}
          <span
            className="tabular inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap"
            aria-label={`已作答 ${answered} / ${total}`}
          >
            <CheckCircle2 className="size-3.5" />
            已作答 {answered} / {total}
          </span>
          {markedCount > 0 ? (
            <span className="tabular hidden items-center gap-1.5 text-warn sm:inline-flex">
              <Bookmark className="size-3.5" />
              标记 {markedCount}
            </span>
          ) : null}
          {result?.durationSeconds ? (
            <span className="tabular hidden items-center gap-1.5 lg:inline-flex">
              <Clock className="size-3.5" />
              {minutesLabel(Math.round(result.durationSeconds / 60))}
            </span>
          ) : null}
          {navigatorSlot}
        </div>
      </div>

      {/*
        进度线**绝对定位**在头部底沿：它因此不参与高度计算，
        头部高度恒等于 `--workspace-header-height`（不会有 2px 累积偏差）。
      */}
      <div className="absolute inset-x-0 bottom-0 h-0.5 bg-surface-sunken" aria-hidden>
        <div
          className="h-full bg-accent transition-[width] duration-200 ease-out"
          style={{ width: `${progress}%` }}
        />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// 当前题
// ---------------------------------------------------------------------------

function QuestionFocus({
  question,
  index,
  total,
  value,
  isMarked,
  eliminated,
  disabled,
  paragraphLabels,
  wordBank,
  usedElsewhere,
  onChoose,
  onCommit,
  onAssignExclusive,
  onClear,
  onToggleMark,
  onToggleElimination,
  onShowMaterial,
}: {
  question: TrainingQuestionView;
  index: number;
  total: number;
  value: string | null;
  isMarked: boolean;
  eliminated: string[];
  disabled: boolean;
  paragraphLabels: string[];
  wordBank: string[];
  usedElsewhere: string[];
  onChoose: (questionId: string, value: string) => void;
  onCommit: (questionId: string, explicitValue?: string) => void;
  onAssignExclusive: (word: string) => void;
  onClear: () => void;
  onToggleMark: () => void;
  onToggleElimination: (optionId: string) => void;
  onShowMaterial: () => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <span className="tabular rounded-sm bg-surface-sunken px-2 py-0.5 text-[12px] font-medium text-content-soft">
          {question.number !== null ? `第 ${question.number} 题` : `第 ${index + 1} 题`}
        </span>
        <span className="text-[12px] text-content-faint">
          {index + 1} / {total}
        </span>

        <button
          type="button"
          onClick={onToggleMark}
          aria-pressed={isMarked}
          className={cn(
            "ml-auto inline-flex h-8 items-center gap-1.5 rounded-sm border px-2.5 text-[12px] font-medium transition-colors",
            isMarked
              ? "border-warn/40 bg-warn-soft text-warn"
              : "border-edge-strong bg-surface-raised text-content-soft hover:border-content-faint hover:text-content",
          )}
        >
          <Bookmark className={cn("size-3.5", isMarked && "fill-current")} />
          {isMarked ? "已标记" : "标记"}
        </button>
      </div>

      {/*
        题型分发：三种阅读题型的回答方式在结构上不同，
        因此各自有专用面板，而不是套同一个通用卡片。
      */}
      {question.kind === "mcq" ? (
        <CarefulReadingPanel
          question={question}
          value={value}
          eliminated={eliminated}
          disabled={disabled}
          onChoose={onChoose}
          onCommit={onCommit}
          onToggleElimination={onToggleElimination}
        />
      ) : question.kind === "matching_statement" ? (
        <MatchingPanel
          question={question}
          value={value}
          disabled={disabled}
          paragraphLabels={paragraphLabels}
          onChoose={onChoose}
          onCommit={onCommit}
          onShowMaterial={onShowMaterial}
        />
      ) : (
        <BankedClozePanel
          question={question}
          value={value}
          disabled={disabled}
          wordBank={wordBank}
          usedElsewhere={usedElsewhere}
          /*
            只传一个 `onAssign`：跨空清理由 `assignExclusiveValue`
            在一次状态写入内完成，因此面板**不需要**知道兄弟 id ——
            把作用域细节留在 hook 里，界面层就无法"忘记清理旧持有者"。
          */
          onAssign={onAssignExclusive}
          onClear={onClear}
          onShowMaterial={onShowMaterial}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 固定导航条
// ---------------------------------------------------------------------------

/**
 * 常驻导航条。
 *
 * 这是"不必滚到页面底部才能翻题"的直接实现：它固定在作答栏底部，
 * 无论题目多长都在拇指/光标可达处。
 * `pb-[env(safe-area-inset-bottom)]` 让移动端的 iPhone 横条不遮住按钮。
 *
 * 回看模式（`mode="review"`）**不出现交卷键** —— 已提交的事实不可再提交，
 * 渲染一个禁用的交卷按钮只会制造"我是不是还能交一次"的疑问。
 */
function QuestionNavBar(
  props:
    | {
        mode?: "answering";
        index: number;
        total: number;
        onPrev: () => void;
        onNext: () => void;
        canSubmit: boolean;
        submitting: boolean;
        onSubmit: () => void;
      }
    | {
        mode: "review";
        index: number;
        total: number;
        onPrev: () => void;
        onNext: () => void;
      },
) {
  const { index, total, onPrev, onNext } = props;
  const hasPrev = index > 0;
  const hasNext = index < total - 1;
  const isReview = props.mode === "review";

  return (
    <div className="sticky bottom-0 border-t border-edge bg-surface-raised pb-[env(safe-area-inset-bottom)]">
      <div className="flex items-center gap-2 px-3 py-2.5 sm:px-5 lg:px-8">
        <Button
          variant="secondary"
          onClick={onPrev}
          disabled={!hasPrev || (!isReview && props.submitting)}
          icon={<ChevronLeft className="size-4" />}
          className="flex-1 sm:flex-none"
        >
          上一题
        </Button>

        <Button
          variant="secondary"
          onClick={onNext}
          disabled={!hasNext || (!isReview && props.submitting)}
          className="flex-1 sm:flex-none"
        >
          下一题
          <ChevronRight className="size-4" />
        </Button>

        {/*
          这里**刻意不再重复**"已作答 N / 总"。
          训练头已经常驻显示它；在导航条里再放一份会让同一个数字出现两次，
          而且早先那份带 `hidden sm:inline`，于是在手机上进度只存在于
          被隐藏的那个元素里 —— 测试与真实用户都会找不到它。
          一个数字只在一个地方出现，且始终可见。
        */}

        {!isReview ? (
          <Button
            onClick={props.onSubmit}
            disabled={!props.canSubmit}
            loading={props.submitting}
            loadingText="判分中…"
            icon={<Send className="size-4" />}
            className="ml-auto"
          >
            交卷
          </Button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 回看模式
// ---------------------------------------------------------------------------

/**
 * 交卷后的逐题回看。
 *
 * 关键产品决定：**保持同一个空间心智模型**。
 * 不把学习者丢到一个"结果网页"上，而是留在同一套分栏里 ——
 * 左边仍是那份原文，右边换成"这题的结果 + 正确答案 + 你的作答"。
 * 因此"回看第 7 题为什么错"不需要重新建立空间认知。
 *
 * 诚实边界：这里**不**编造解析。只呈现确定性事实：
 * 对/错/未作答、正确选项、你的选择。域层 `feedbackFor` 的措辞原样使用。
 */
function ReviewWorkspace({
  result,
  session,
  index,
  onNavigate,
  paperId,
  sectionId,
}: {
  result: ReadingTrainingResult;
  session: ReadingTrainingSession;
  index: number;
  onNavigate: (next: number) => void;
  paperId: string;
  sectionId: string;
}) {
  const graded = result.questions[index] ?? null;
  const [filter, setFilter] = useState<"all" | "incorrect" | "skipped">("all");

  if (!graded) {
    return (
      <div className="p-6">
        <Notice tone="warn" title="这一题没有结果记录">
          结果里没有第 {index + 1} 题。请用题号导航切换到有记录的题目。
        </Notice>
      </div>
    );
  }

  const filteredIndexes = result.questions
    .map((item, position) => ({ item, position }))
    .filter(({ item }) => (filter === "all" ? true : item.outcome === filter))
    .map(({ position }) => position);

  return (
    <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
      <section
        aria-label="阅读材料"
        className="min-w-0 border-b border-edge lg:w-[56%] lg:shrink-0 lg:border-r lg:border-b-0"
      >
        <div className="lg:workspace-height scroll-region px-4 py-5 lg:px-8 lg:py-6">
          <StimulusPane session={session} activeQuestion={null} />
        </div>
      </section>

      <section aria-label="回看" className="flex min-w-0 flex-1 flex-col">
        <div className="lg:workspace-height scroll-region min-h-0 flex-1 px-4 py-5 sm:px-6 lg:px-8">
          <ReviewSummary result={result} />

          {/* 筛选：把注意力导向需要看的部分，而不是"全部重看一遍" */}
          <div className="mt-5 flex flex-wrap items-center gap-1.5">
            <h2 className="mr-1 text-[13px] font-semibold text-content">逐题结果</h2>
            {(
              [
                { key: "all", label: `全部 ${result.summary.total}` },
                { key: "incorrect", label: `错误 ${result.summary.incorrect}` },
                { key: "skipped", label: `未作答 ${result.summary.skipped}` },
              ] as const
            ).map((option) => (
              <button
                key={option.key}
                type="button"
                aria-pressed={filter === option.key}
                onClick={() => setFilter(option.key)}
                className={cn(
                  "rounded-sm border px-2.5 py-1.5 text-[12px] font-medium transition-colors",
                  filter === option.key
                    ? "border-accent/35 bg-accent-soft text-accent"
                    : "border-edge-strong bg-surface-raised text-content-soft hover:border-content-faint hover:text-content",
                )}
              >
                {option.label}
              </button>
            ))}
            {filteredIndexes.length > 0 ? (
              <button
                type="button"
                onClick={() => onNavigate(filteredIndexes[0])}
                className="ml-auto inline-flex items-center gap-1 text-[12px] text-accent hover:underline"
              >
                跳到第一题
                <ArrowRight className="size-3.5" />
              </button>
            ) : (
              <span className="ml-auto self-center text-[12px] text-content-faint">
                这个筛选下没有题目
              </span>
            )}
          </div>

          <ReviewQuestion
            graded={graded}
            position={index}
            total={result.questions.length}
            correctedAnswerIndex={filteredIndexes}
            onNavigate={onNavigate}
          />

          <div className="mt-6 flex flex-wrap gap-2 border-t border-edge pt-5">
            <Link href="/today">
              <Button icon={<ArrowRight className="size-4" />}>返回 Today</Button>
            </Link>
            <Link href={`/practice/papers/${paperId}`}>
              <Button variant="secondary">返回试卷</Button>
            </Link>
            {/*
              "再练一次"必须真的开启新会话（服务层：已完成会话永不复用），
              因此点下去会直接进入新的作答界面，而不是回到某个浏览页。
            */}
            <form action={startReadingRunAction}>
              <input type="hidden" name="paperId" value={paperId} />
              <input type="hidden" name="sectionId" value={sectionId} />
              <Button type="submit" variant="ghost" icon={<RotateCcw className="size-3.5" />}>
                再练一次
              </Button>
            </form>
          </div>

          <p className="mt-4 flex items-start gap-1.5 text-[12px] leading-relaxed text-content-faint">
            <Info className="mt-px size-3.5 shrink-0" />
            再练一次会开启新的训练记录并保留这次的。重复练习同一份材料对保持有帮助，
            但要检验「是否真的掌握了」，需要在其他没做过的真题上再看一次。
          </p>
        </div>

        <QuestionNavBar
          mode="review"
          index={index}
          total={result.questions.length}
          onPrev={() => onNavigate(index - 1)}
          onNext={() => onNavigate(index + 1)}
        />
      </section>
    </div>
  );
}

function ReviewSummary({ result }: { result: ReadingTrainingResult }) {
  const { summary } = result;
  const allCorrect = summary.correct === summary.total && summary.total > 0;

  return (
    <div
      className={cn(
        "rounded-md border px-4 py-3.5",
        allCorrect ? "border-succ/30 bg-accent-soft" : "border-edge bg-surface-raised",
      )}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className={cn("text-[15px] font-semibold", allCorrect ? "text-accent" : "text-content")}>
          {allCorrect ? "全部正确" : "本次结果已记录"}
        </p>
        <p className="tabular text-2xl font-semibold text-content">
          {summary.correct}
          <span className="text-base text-content-faint">/{summary.total}</span>
        </p>
      </div>

      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-[12px]">
        <span className="inline-flex items-center gap-1.5 text-succ">
          <CheckCircle2 className="size-3.5" />
          正确 {summary.correct}
        </span>
        <span className="inline-flex items-center gap-1.5 text-danger">
          <XCircle className="size-3.5" />
          错误 {summary.incorrect}
        </span>
        <span className="inline-flex items-center gap-1.5 text-content-faint">
          <MinusCircle className="size-3.5" />
          未作答 {summary.skipped}
        </span>
        {result.durationSeconds ? (
          <span className="inline-flex items-center gap-1.5 text-content-faint">
            <Clock className="size-3.5" />
            用时 {minutesLabel(Math.round(result.durationSeconds / 60))}
          </span>
        ) : null}
      </div>

      {/*
        诚实性边界：一次作答不足以支撑机制结论（LEARNING_MODEL 第 4 节）。
        这里刻意不写"你词汇弱""定位不准"。
      */}
      <div className="mt-2.5 border-t border-edge pt-2.5">
        <p className="text-[12px] font-medium text-content-soft">这份结果怎么读</p>
        <p className="mt-1 text-[12px] leading-relaxed text-content-soft">
          它记录的是「这一次你答得怎么样」，还不足以判断某个能力上的原因 ——
          那种结论需要跨多次、跨材料的证据。
        </p>
      </div>
    </div>
  );
}

function ReviewQuestion({
  graded,
  position,
  total,
  correctedAnswerIndex,
  onNavigate,
}: {
  graded: ReadingTrainingResult["questions"][number];
  position: number;
  total: number;
  correctedAnswerIndex: number[];
  onNavigate: (next: number) => void;
}) {
  const isCorrect = graded.outcome === "correct";
  const isSkipped = graded.outcome === "skipped";
  const positionInFiltered = correctedAnswerIndex.indexOf(position);

  return (
    <article className="mt-5 rounded-md border border-edge bg-surface-raised">
      <div className="flex items-center gap-2 border-b border-edge px-4 py-2.5">
        {isCorrect ? (
          <CheckCircle2 className="size-4 shrink-0 text-succ" />
        ) : isSkipped ? (
          <MinusCircle className="size-4 shrink-0 text-content-faint" />
        ) : (
          <XCircle className="size-4 shrink-0 text-danger" />
        )}
        <span className="tabular text-[12px] font-medium text-content-soft">
          {graded.questionNumber !== null ? `第 ${graded.questionNumber} 题` : `第 ${position + 1} 题`}
        </span>
        <span
          className={cn(
            "rounded-sm px-1.5 py-0.5 text-[11px] font-medium",
            isCorrect
              ? "bg-accent-soft text-accent"
              : isSkipped
                ? "bg-surface-sunken text-content-faint"
                : "bg-danger-soft text-danger",
          )}
        >
          {isCorrect ? "正确" : isSkipped ? "未作答" : "不正确"}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            disabled={positionInFiltered <= 0}
            onClick={() => onNavigate(correctedAnswerIndex[positionInFiltered - 1])}
            aria-label="上一个筛选结果"
            className="grid size-7 place-items-center rounded-sm border border-edge-strong text-content-soft transition-colors hover:text-content disabled:opacity-40"
          >
            <ChevronLeft className="size-3.5" />
          </button>
          <button
            type="button"
            disabled={
              positionInFiltered < 0 || positionInFiltered >= correctedAnswerIndex.length - 1
            }
            onClick={() => onNavigate(correctedAnswerIndex[positionInFiltered + 1])}
            aria-label="下一个筛选结果"
            className="grid size-7 place-items-center rounded-sm border border-edge-strong text-content-soft transition-colors hover:text-content disabled:opacity-40"
          >
            <ChevronRight className="size-3.5" />
          </button>
        </div>
      </div>

      <div className="px-4 py-4">
        <p className="text-[14px] leading-relaxed text-content">{graded.prompt}</p>

        {graded.options.length > 0 ? (
          <ul className="mt-3 flex flex-col gap-1.5">
            {graded.options.map((option) => {
              const isCorrectOption = graded.correctAnswerLabel.startsWith(`${option.id} —`);
              const isChosen = graded.responseValue === option.id;
              return (
                <li
                  key={option.id}
                  className={cn(
                    "flex items-start gap-2.5 rounded-sm border px-3 py-2 text-[13px]",
                    isCorrectOption
                      ? "border-succ/35 bg-accent-soft text-content"
                      : isChosen
                        ? "border-danger/35 bg-danger-soft text-content"
                        : "border-edge text-content-soft",
                  )}
                >
                  <span className="mt-0.5 shrink-0 font-mono text-[11px] font-semibold">
                    {option.id.toUpperCase()}
                  </span>
                  <span className="min-w-0">{option.label}</span>
                  {isCorrectOption ? (
                    <span className="ml-auto shrink-0 text-[11px] font-medium text-accent">正确答案</span>
                  ) : null}
                  {isChosen && !isCorrectOption ? (
                    <span className="ml-auto shrink-0 text-[11px] font-medium text-danger">你的选择</span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1.5 text-[13px]">
            <div className="flex gap-2">
              <dt className="text-content-faint">你的作答</dt>
              <dd className="text-content">{graded.responseValue ?? "（未作答）"}</dd>
            </div>
            <div className="flex gap-2">
              <dt className="text-content-faint">正确答案</dt>
              <dd className="font-medium text-accent">{graded.correctAnswerLabel}</dd>
            </div>
          </dl>
        )}

        <p className="mt-3 border-t border-edge pt-3 text-[12.5px] leading-relaxed text-content-soft">
          {graded.feedback}
        </p>

        {/* 题号跳转：让"把所有错题过一遍"这件事不用靠翻页完成 */}
        <p className="mt-3 text-[12px] text-content-faint">
          共 {total} 题 · 当前位置 {position + 1}
        </p>
      </div>
    </article>
  );
}
