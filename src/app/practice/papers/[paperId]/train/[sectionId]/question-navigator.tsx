"use client";

import { useEffect, useRef, useState } from "react";
import { Bookmark, Check, MinusCircle, X } from "lucide-react";
import { cn } from "@/lib/client-utils";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import type { GradedQuestionView } from "@/services/expert-training";

/**
 * 题目导航器。
 *
 * ── 它解决什么 ──
 * 10 道题、长文章、常在题间反复跳。没有导航器时，"回到第 3 题"意味着
 * 往上翻好几屏；而"还有几题没答"根本没有答案。
 *
 * ── 状态必须靠形状而不是只有颜色 ──
 * 色盲用户、以及在任何屏幕上，"哪个是已答 / 标记 / 当前"都不能只靠色相区分。
 * 因此三重编码：
 *   · 已答     → 实心底 + 对勾图标
 *   · 未答     → 空心 + 无图标
 *   · 标记     → 右上角书签角标
 *   · 当前题   → 外环 + `aria-current`
 * 这些都可被读屏读出（每格有完整 `aria-label`）。
 *
 * ── 响应式 ──
 * 桌面：从顶部按钮弹出的锚定面板。
 * 移动：整屏底部抽屉（手指可达、不会把格子挤成 6px）。
 * 两者共用同一份格子渲染，只换容器。
 */

export interface NavigatorEntry {
  questionId: string;
  number: number | null;
  index: number;
  answered: boolean;
  marked: boolean;
}

export function QuestionNavigator({
  entries,
  currentIndex,
  mode,
  results,
  onSelect,
}: {
  entries: NavigatorEntry[];
  currentIndex: number;
  /** 作答中区分 已答/未答/标记；交卷后区分 对/错/未作答。 */
  mode: "answering" | "review";
  results: GradedQuestionView[] | null;
  onSelect: (index: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const answeredCount = entries.filter((entry) => entry.answered).length;
  const markedCount = entries.filter((entry) => entry.marked).length;
  const unanswered = entries.length - answeredCount;
  const current = entries[currentIndex];

  /*
   * 键盘焦点（F-3）：与 SubmitDialog **共用同一份实现**。
   *
   * 关闭时把焦点还给触发按钮由 hook 内部完成（它记住打开前的
   * `document.activeElement`）。这里只需要把"关闭"定义为
   * `setOpen(false)` —— 归位是 hook 的职责，不是每个调用点的职责，
   * 这样就不会出现"某处忘了 focus()"的漂移。
   *
   * 遮罩点击由下面那个独立的遮罩元素处理（桌面端遮罩是透明的视觉分离层），
   * 因此这里不使用 hook 的 `onBackdropClick`。
   */
  const { containerRef } = useModalFocus({
    open,
    onClose: () => setOpen(false),
    closeOnBackdrop: false,
  });

  // 打开后把焦点移入第一个格子（键盘用户不必 Tab 穿过整个页面）
  useEffect(() => {
    if (!open) return;
    const first = containerRef.current?.querySelector<HTMLButtonElement>("button[data-cell]");
    first?.focus();
  }, [open, containerRef]);

  function outcomeOf(index: number): GradedQuestionView["outcome"] | null {
    const graded = results?.find((_, position) => position === index);
    return graded?.outcome ?? null;
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={
          current
            ? `题目导航：第 ${current.number ?? currentIndex + 1} 题，共 ${entries.length} 题中的第 ${currentIndex + 1} 题`
            : `题目导航：共 ${entries.length} 题`
        }
        className="tabular inline-flex h-8 items-center gap-1.5 rounded-sm border border-edge-strong bg-surface-raised px-2.5 text-[12px] font-medium text-content-soft transition-colors hover:border-content-faint hover:text-content"
      >
        <GridIcon />
        {/*
          ── 为什么不能只写 `N / M`（实测缺陷）──
          
          CET-6 的题号是**卷面官方编号**（阅读是 26–55），而这里另一个数字是
          "这一大题内的第几题"。直接渲染成 `26 / 10` 会让学习者以为
          "第 26 题，总共 10 题"—— 两个数字属于**不同的计数体系**，
          并排放进同一个 `x / y` 句式就是在制造歧义。
          
          现在显式区分：官方题号用「第 N 题」，组内进度用「i / 总数」，
          并在两者之间用 `·` 分隔。**不重编真实题号** —— 那是试卷上的编号。
        */}
        {current ? (
          <>
            第 {current.number ?? currentIndex + 1} 题
            <span className="text-content-faint">
              · {currentIndex + 1} / {entries.length}
            </span>
          </>
        ) : (
          <span className="text-content-faint">— / {entries.length}</span>
        )}
      </button>

      {open ? (
        <>
          {/* 遮罩：点击空白关闭 */}
          <div
            className="fixed inset-0 z-40 bg-content/25 lg:bg-transparent"
            onClick={() => setOpen(false)}
            aria-hidden
          />

          <div
            ref={containerRef}
            role="dialog"
            aria-modal="true"
            aria-label="题目导航"
            /*
              定位必须写成"同一属性、逐断点覆盖"，不能混用 inset-x-0 与 right-0。
              实测缺陷：`inset-x-0`（等价 left:0; right:0）与 `lg:right-0` 并存时，
              lg 下算出 right: -271.78px —— 因为面板 `lg:w-[22rem]`(352px) 相对
              只有 80px 宽的触发按钮容器定位，右边缘落在 1680px，
              **超出 1440 视口 240px 而被裁切**（截图里只看到 2 列格子）。
              因此这里一律用 left/right/top/bottom 单属性 + lg 覆盖，
              并且桌面端锚定到**视口**（fixed + right-3）而不是那个 80px 的 wrapper。
            */
            className={cn(
              "fixed z-50 flex flex-col border-edge bg-surface-raised",
              // 移动：整屏底部抽屉
              "left-0 right-0 bottom-0 max-h-[75dvh] rounded-t-lg border-t pb-[env(safe-area-inset-bottom)]",
              // 桌面：视口右上锚定的面板（不依赖父容器宽度）
              "lg:left-auto lg:right-3 lg:bottom-auto lg:top-[3.6rem]",
              "lg:w-[22rem] lg:max-h-[min(70dvh,34rem)] lg:rounded-md lg:border lg:pb-0",
            )}
          >
            <div className="flex items-center gap-2 border-b border-edge px-4 py-3">
              <h3 className="text-[13px] font-semibold text-content">
                {mode === "review" ? "回看导航" : "题目导航"}
              </h3>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="关闭导航"
                className="ml-auto grid size-9 place-items-center rounded-sm text-content-soft transition-colors hover:bg-surface-sunken hover:text-content"
              >
                <X className="size-4" />
              </button>
            </div>

            {/* 摘要：直接回答"还有几题没答" */}
            <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-edge px-4 py-2.5 text-[12px]">
              {mode === "answering" ? (
                <>
                  <span className="text-content-soft">
                    已答 <span className="tabular font-medium text-content">{answeredCount}</span>
                  </span>
                  <span className={cn(unanswered > 0 ? "text-warn" : "text-content-faint")}>
                    未答 <span className="tabular font-medium">{unanswered}</span>
                  </span>
                </>
              ) : (
                <span className="text-content-soft">
                  已提交 <span className="tabular font-medium text-content">{entries.length}</span>
                </span>
              )}
              {markedCount > 0 ? (
                <span className="inline-flex items-center gap-1 text-warn">
                  <Bookmark className="size-3 fill-current" />
                  标记 <span className="tabular font-medium">{markedCount}</span>
                </span>
              ) : null}
            </div>

            <div className="scroll-region min-h-0 flex-1 overflow-y-auto p-3">
              <ul className="grid grid-cols-5 gap-1.5 lg:grid-cols-6">
                {entries.map((entry) => {
                  const isCurrent = entry.index === currentIndex;
                  const outcome = mode === "review" ? outcomeOf(entry.index) : null;

                  return (
                    <li key={entry.questionId}>
                      <button
                        type="button"
                        data-cell
                        onClick={() => {
                          onSelect(entry.index);
                          setOpen(false);
                        }}
                        aria-current={isCurrent ? "true" : undefined}
                        aria-label={cellLabel(entry, mode, outcome)}
                        className={cn(
                          "tabular relative grid h-11 w-full place-items-center rounded-sm border text-[13px] font-medium transition-colors",
                          "focus-visible:outline-2 focus-visible:outline-offset-2",
                          cellStyle(entry, isCurrent, mode, outcome),
                        )}
                      >
                        {entry.number ?? entry.index + 1}
                        {entry.answered && mode === "answering" ? (
                          <Check className="absolute bottom-1 right-1 size-3" strokeWidth={3} />
                        ) : null}
                        {mode === "review" && outcome === "skipped" ? (
                          <MinusCircle className="absolute bottom-1 right-1 size-3" />
                        ) : null}
                        {entry.marked ? (
                          <Bookmark
                            className="absolute -top-1 -right-1 size-3.5 fill-warn text-warn"
                            aria-hidden
                          />
                        ) : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>

            {/* 图例：颜色与形状的含义必须在界面上可查，而不是靠猜 */}
            <div className="border-t border-edge px-4 py-2.5">
              <ul className="flex flex-wrap gap-x-4 gap-y-1.5 text-[11px] text-content-faint">
                {mode === "answering" ? (
                  <>
                    <Legend className="border-edge-strong bg-surface-raised" label="未作答" />
                    <Legend
                      className="border-accent/40 bg-accent-soft"
                      label="已作答"
                      icon={<Check className="size-2.5 text-accent" strokeWidth={3} />}
                    />
                    <Legend
                      className="border-edge-strong bg-surface-raised"
                      label="已标记"
                      icon={<Bookmark className="size-2.5 fill-warn text-warn" />}
                    />
                  </>
                ) : (
                  <>
                    <Legend className="border-succ/40 bg-accent-soft" label="正确" />
                    <Legend className="border-danger/40 bg-danger-soft" label="答错" />
                    <Legend
                      className="border-edge-strong bg-surface-raised"
                      label="未作答"
                      icon={<MinusCircle className="size-2.5" />}
                    />
                  </>
                )}
                <Legend className="border-content ring-2 ring-accent/30 bg-surface-raised" label="当前题" />
              </ul>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

function cellLabel(
  entry: NavigatorEntry,
  mode: "answering" | "review",
  outcome: GradedQuestionView["outcome"] | null,
): string {
  const parts = [`第 ${entry.number ?? entry.index + 1} 题`];
  if (mode === "answering") {
    parts.push(entry.answered ? "已作答" : "未作答");
  } else {
    parts.push(
      outcome === "correct" ? "正确" : outcome === "incorrect" ? "答错" : outcome === "skipped" ? "未作答" : "无结果",
    );
  }
  if (entry.marked) parts.push("已标记待回看");
  return parts.join("，");
}

function cellStyle(
  entry: NavigatorEntry,
  isCurrent: boolean,
  mode: "answering" | "review",
  outcome: GradedQuestionView["outcome"] | null,
): string {
  const ring = isCurrent ? "ring-2 ring-accent ring-offset-1 ring-offset-surface-raised" : "";

  if (mode === "review") {
    const tone =
      outcome === "correct"
        ? "border-succ/40 bg-accent-soft text-accent"
        : outcome === "incorrect"
          ? "border-danger/40 bg-danger-soft text-danger"
          : "border-edge-strong bg-surface-raised text-content-faint";
    return cn(tone, ring);
  }

  const tone = entry.answered
    ? "border-accent/40 bg-accent-soft text-accent"
    : "border-edge-strong bg-surface-raised text-content-soft hover:border-content-faint";
  return cn(tone, ring);
}

function Legend({
  className,
  label,
  icon,
}: {
  className: string;
  label: string;
  icon?: React.ReactNode;
}) {
  return (
    <li className="inline-flex items-center gap-1.5">
      <span
        aria-hidden
        className={cn("grid size-4 place-items-center rounded-sm border text-[10px]", className)}
      >
        {icon}
      </span>
      {label}
    </li>
  );
}

function GridIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" aria-hidden fill="currentColor">
      <rect x="1" y="1" width="4" height="4" rx="1" />
      <rect x="6.5" y="1" width="4" height="4" rx="1" />
      <rect x="12" y="1" width="3" height="4" rx="1" />
      <rect x="1" y="6.5" width="4" height="4" rx="1" />
      <rect x="6.5" y="6.5" width="4" height="4" rx="1" />
      <rect x="12" y="6.5" width="3" height="4" rx="1" />
      <rect x="1" y="12" width="4" height="3" rx="1" />
      <rect x="6.5" y="12" width="4" height="3" rx="1" />
      <rect x="12" y="12" width="3" height="3" rx="1" />
    </svg>
  );
}
