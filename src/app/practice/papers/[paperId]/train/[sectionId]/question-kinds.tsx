"use client";

import { Check, Eraser, Quote } from "lucide-react";
import { cn } from "@/lib/client-utils";
import type { TrainingQuestionView } from "@/services/expert-training";

/**
 * 三种阅读题型的作答面板。
 *
 * ── 为什么不共用一个通用 QuestionCard ──
 * 三种题型的**作答动作**在结构上不同：
 *   · 仔细阅读   —— 在 4 个选项里选一个（还要能划掉干扰项）
 *   · 长篇阅读   —— 在 A–O 里定位一个段落（答案是一个标号）
 *   · 选词填空   —— 从 15 个词里选一个填进某个空（词不重复使用）
 * 用同一个通用控件表达这三种，必然要么给阅读题塞一个多余的输入框，
 * 要么给选词填空丢掉"词库"这个真实结构。CET-6 的题型差异是**真实差异**，
 * 不是外观差异。
 *
 * ── 统一的作答语义 ──
 * 三者都遵守同一条边界规则（来自域层 `commitAnswer`）：
 * **离散选择以点击为提交边界**，因此 A→B 会被正确记为"改过答案"，
 * 而首次选择不会。打字不存在于此（全部改为点选了）。
 */

interface PanelBase {
  question: TrainingQuestionView;
  value: string | null;
  disabled: boolean;
  onChoose: (questionId: string, value: string) => void;
  onCommit: (questionId: string, explicitValue?: string) => void;
}

// ---------------------------------------------------------------------------
// A. 仔细阅读：四选一 + 选项排除
// ---------------------------------------------------------------------------

export function CarefulReadingPanel({
  question,
  value,
  eliminated,
  disabled,
  onChoose,
  onCommit,
  onToggleElimination,
}: PanelBase & {
  eliminated: string[];
  onToggleElimination: (optionId: string) => void;
}) {
  return (
    <div>
      {question.stem ? (
        <p className="text-[15px] leading-relaxed font-medium text-content">{question.stem}</p>
      ) : null}

      <fieldset className="mt-3 flex flex-col gap-1.5" disabled={disabled}>
        <legend className="sr-only">选择一个答案</legend>

        {question.options.map((option) => {
          const selected = value === option.id;
          const isEliminated = eliminated.includes(option.id);

          return (
            <div key={option.id} className="flex items-stretch gap-1.5">
              {/*
                选项本体是 <label> + 真实 radio input。
                input 为 sr-only（视觉隐藏、保留键盘与读屏语义），
                用户点击的是 label —— 这既是无障碍正解，也让 E2E 能按真实交互点 label。
              */}
              <label
                className={cn(
                  "flex min-w-0 flex-1 cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 text-[14px] transition-colors",
                  selected
                    ? "border-accent bg-accent-soft text-content"
                    : "border-edge-strong bg-surface-raised text-content-soft hover:border-content-faint hover:bg-surface",
                  isEliminated && !selected && "border-edge bg-surface",
                  disabled && "cursor-not-allowed opacity-70",
                )}
              >
                <input
                  type="radio"
                  name={`q-${question.id}`}
                  value={option.id}
                  checked={selected}
                  // 离散选项：点击**本身**就是提交边界（先写值，再立即提交）
                  onChange={() => {
                    onChoose(question.id, option.id);
                    onCommit(question.id, option.id);
                  }}
                  className="sr-only"
                />
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border font-mono text-[11px] font-semibold transition-colors",
                    selected
                      ? "border-accent bg-accent text-surface-raised"
                      : "border-edge-strong text-content-faint",
                  )}
                >
                  {selected ? <Check className="size-3" strokeWidth={3} /> : option.id.toUpperCase()}
                </span>

                <span
                  className={cn(
                    "min-w-0 transition-colors",
                    // 被排除的选项：划掉并后退，但**仍然可读**
                    // —— 学习者经常要把它恢复回来
                    isEliminated && !selected && "text-strike line-through",
                  )}
                >
                  {option.label}
                </span>
              </label>

              {/*
                排除按钮刻意放在 label **外面**：
                放进 label 内部会让"点排除"同时触发选项选中 —— 而排除
                **不应改变已选答案**（它只是"我不想选它"）。

                键盘可达性：它是真实的 <button>，因此 Tab 可达、Enter/Space 可触发。
                Bluebook 用独立模式 + 专属快捷键把"排除"与"选择"在输入层隔开；
                点击目标分离是同一意图在 Web 上的等价做法 —— 两者都不会误触对方。
                学习者的实际动作路径也更短：不必先切模式。
              */}
              <button
                type="button"
                onClick={() => onToggleElimination(option.id)}
                disabled={disabled}
                aria-pressed={isEliminated}
                aria-label={
                  isEliminated
                    ? `恢复选项 ${option.id.toUpperCase()}`
                    : `排除选项 ${option.id.toUpperCase()}`
                }
                title={isEliminated ? "恢复这个选项" : "划掉这个选项（不影响你已选的答案）"}
                className={cn(
                  /*
                   * 触摸目标 ≥44×44（独立评审 F-4：实测原为 36px 宽）。
                   * 用 `min-h-11 w-11`（2.75rem = 44px）而不是放大图标 ——
                   * 视觉仍紧凑，命中区域变大。它与选项 label 之间仍有 6px
                   * 间距，因此不会与"选择答案"互相误触。
                   */
                  "grid min-h-11 w-11 shrink-0 place-items-center rounded-md border transition-colors disabled:opacity-50",
                  isEliminated
                    ? "border-warn/40 bg-warn-soft text-warn"
                    : "border-edge-strong bg-surface-raised text-content-faint hover:border-content-faint hover:text-content-soft",
                )}
              >
                <Eraser className="size-4" />
              </button>
            </div>
          );
        })}
      </fieldset>

      <p className="mt-3 text-[12px] leading-relaxed text-content-faint">
        划掉的选项只是帮你集中注意力，它不会改变你选的答案，
        也不会被记为「改过答案」—— 恢复随时可以。
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// B. 长篇阅读：段落标号快选
// ---------------------------------------------------------------------------

export function MatchingPanel({
  question,
  value,
  disabled,
  paragraphLabels,
  onChoose,
  onCommit,
  onShowMaterial,
}: PanelBase & {
  paragraphLabels: string[];
  onShowMaterial?: () => void;
}) {
  return (
    <div>
      <p className="flex gap-2.5 text-[15px] leading-relaxed text-content">
        <Quote className="mt-1 size-4 shrink-0 text-content-faint" />
        <span className="min-w-0">{question.statement}</span>
      </p>

      <p className="mt-4 text-[13px] font-medium text-content-soft">
        这句话出自哪一个段落？
      </p>

      {/*
        段落标号快选。
        长篇阅读的作答值是**一个标号**，因此给一排字母比给一个输入框更贴近任务：
        不需要打字，不需要猜格式，也天然排除非法输入。
      */}
      <fieldset className="mt-2.5" disabled={disabled}>
        <legend className="sr-only">选择这句话所在的段落标号</legend>
        <ul className="flex flex-wrap gap-1.5">
          {paragraphLabels.map((label) => {
            const selected = value?.toUpperCase() === label.toUpperCase();
            return (
              <li key={label}>
                <label
                  className={cn(
                    "grid size-11 cursor-pointer place-items-center rounded-md border text-[15px] font-semibold transition-colors",
                    selected
                      ? "border-accent bg-accent text-surface-raised"
                      : "border-edge-strong bg-surface-raised text-content-soft hover:border-content-faint hover:bg-surface hover:text-content",
                    disabled && "cursor-not-allowed opacity-70",
                  )}
                >
                  <input
                    type="radio"
                    name={`q-${question.id}`}
                    value={label}
                    checked={selected}
                    onChange={() => {
                      onChoose(question.id, label);
                      onCommit(question.id, label);
                    }}
                    className="sr-only"
                  />
                  {label}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <p className="text-[13px] text-content-soft">
          当前选择：
          <span className="ml-1.5 font-semibold text-content">
            {value ? `段落 ${value.toUpperCase()}` : "尚未选择"}
          </span>
        </p>
        {onShowMaterial ? (
          <button
            type="button"
            onClick={onShowMaterial}
            className="ml-auto text-[12px] font-medium text-accent hover:underline lg:hidden"
          >
            查看原文
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// C. 选词填空：词库点选
// ---------------------------------------------------------------------------

export function BankedClozePanel({
  question,
  value,
  disabled,
  wordBank,
  usedElsewhere,
  onAssign,
  onClear,
  onShowMaterial,
}: Omit<PanelBase, "onChoose" | "onCommit"> & {
  wordBank: string[];
  /**
   * 已被**其它**空使用的词。
   *
   * 注意语义：它们**仍然可点**，因为学习者是靠点击来"把词挪过来"。
   * 这里只用来做视觉退后（"已用于其它空"），不是禁用条件。
   */
  usedElsewhere: string[];
  /**
   * 独占式分配：把词给当前空，并把其它持有者清空。
   *
   * 为什么不是 `onChoose` + `onCommit` 两次调用：
   * 那会留下"两个空同时持有同一个词"的中间态，
   * 违反"每个词至多使用一次"（独立评审证明的真实缺陷 F-1）。
   * 转移必须在**一次**状态写入内完成，因此这里只有一个回调。
   */
  onAssign: (word: string) => void;
  onClear: () => void;
  onShowMaterial?: () => void;
}) {
  const selected = value?.trim() ?? "";

  return (
    <div>
      <div className="flex items-baseline gap-2">
        <span className="tabular text-[15px] font-semibold text-content">
          第 {question.blankId} 空
        </span>
        <span className="text-[13px] text-content-faint">
          {selected ? `已选：${selected}` : "从词库里选一个词"}
        </span>
      </div>

      <p className="mt-1.5 text-[12px] leading-relaxed text-content-faint">
        词库共 {wordBank.length} 个词，每个词至多使用一次。
        点一个已被其它空占用的词，会把它<em className="font-medium not-italic text-content-soft">移过来</em>
        （原来的空会被清空）。
      </p>

      {/*
        词库常驻在作答栏。为什么不放在材料栏：
        选词是**当前动作**，它必须和"正在做的那一空"在一起；
        放远一点就变成"在两个区域之间来回看"。
      */}
      <fieldset className="mt-3" disabled={disabled}>
        <legend className="sr-only">选择要填入第 {question.blankId} 空的词</legend>
        <ul className="flex flex-wrap gap-1.5">
          {wordBank.map((word) => {
            const isSelected = selected.toLowerCase() === word.toLowerCase();
            const usedByOther = usedElsewhere.some(
              (other) => other.toLowerCase() === word.toLowerCase(),
            );

            return (
              <li key={word}>
                <label
                  className={cn(
                    "inline-flex min-h-11 cursor-pointer items-center rounded-md border px-3 font-mono text-[13px] transition-colors",
                    isSelected
                      ? "border-accent bg-accent text-surface-raised"
                      : usedByOther
                        ? // 已被其它空占用：仍然可点（点击即转移），但明显退后
                          "border-edge bg-surface text-content-faint hover:border-content-faint"
                        : "border-edge-strong bg-surface-raised text-content-soft hover:border-content-faint hover:bg-surface hover:text-content",
                    disabled && "cursor-not-allowed opacity-70",
                  )}
                >
                  <input
                    type="radio"
                    name={`q-${question.id}`}
                    value={word}
                    checked={isSelected}
                    // 单次原子分配：跨空转移由 hook 在一次状态写入内完成
                    onChange={() => onAssign(word)}
                    className="sr-only"
                  />
                  {word}
                  {usedByOther ? (
                    <span className="ml-1.5 text-[10px] text-content-faint">已用于其它空</span>
                  ) : null}
                </label>
              </li>
            );
          })}
        </ul>
      </fieldset>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        {selected ? (
          <button
            type="button"
            onClick={onClear}
            disabled={disabled}
            className="inline-flex items-center gap-1.5 rounded-sm border border-edge-strong px-2.5 py-1.5 text-[12px] text-content-soft transition-colors hover:border-content-faint hover:text-content disabled:opacity-50"
          >
            <Eraser className="size-3.5" />
            清空这一空
          </button>
        ) : null}
        {onShowMaterial ? (
          <button
            type="button"
            onClick={onShowMaterial}
            className="ml-auto text-[12px] font-medium text-accent hover:underline lg:hidden"
          >
            查看原文
          </button>
        ) : null}
      </div>
    </div>
  );
}
