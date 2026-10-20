"use client";

import { AlertTriangle, CheckCircle2, Send } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useModalFocus } from "@/components/ui/use-modal-focus";
import { cn } from "@/lib/client-utils";

/**
 * 交卷确认。
 *
 * ── 为什么必须是阻断式确认 ──
 * 交卷不可撤回（服务层：同一会话恰好一次提交，且已完成不可复用）。
 * 一次误触就消耗掉一整份未触碰的真题材料 —— 那是**有限资源**
 * （PRODUCT_PRINCIPLES 第 7 条）。
 *
 * ── 未作答必须极其显眼 ──
 * 未作答 ≠ 答错，但它同样是"没拿到分的机会"。因此：
 * · 有未答题时，顶部用警示色写出**具体数字**；
 * · 直接列出未答题号，**可点击跳过去**（而不是让学习者自己去找）；
 * · 明确写出"未作答不计为错误，也不产生正确/错误的能力证据"——
 *   这是如实描述系统行为，不是安慰话术。
 *
 * ── 防重复提交 ──
 * 提交中：确认键换成 loading（按钮组件在 loading 时自动 disabled），
 * 取消键同时禁用，弹层不可用 Esc 关闭。
 * 这只是**界面层**的防重；真正的恰好一次由数据库事务边界保证
 * （`completeRun` 的条件认领。前端拦截不是安全边界，
 * 它只负责不让用户看到两个按钮同时转圈。
 */
export function SubmitDialog({
  total,
  answered,
  marked,
  unansweredIndexes,
  pending,
  onJump,
  onCancel,
  onConfirm,
}: {
  total: number;
  answered: number;
  marked: number;
  unansweredIndexes: Array<{ position: number; number: number | null }>;
  pending: boolean;
  onJump: (position: number) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const unanswered = total - answered;

  /*
   * 键盘焦点（F-3）：焦点陷在弹层内、Esc 关闭、关闭后归位。
   *
   * 两处行为差异是**有意**的：
   * · `escapeDisabled: pending` —— 提交进行中不许 Esc 关闭。
   *   此刻关闭会让用户以为操作被取消了，而服务端其实正在落库。
   * · `closeOnBackdrop: false` —— 交卷不可撤回，点空白处误关不合适。
   */
  const { containerRef, onBackdropClick } = useModalFocus({
    open: true,
    onClose: onCancel,
    escapeDisabled: pending,
    closeOnBackdrop: false,
  });

  return (
    <div
      ref={containerRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="submit-dialog-title"
      onClick={onBackdropClick}
      className="fixed inset-0 z-50 flex items-end justify-center bg-content/35 p-0 sm:items-center sm:p-4"
    >
      <div className="w-full max-w-lg rounded-t-lg border border-edge bg-surface-raised pb-[env(safe-area-inset-bottom)] sm:rounded-lg sm:pb-0">
        <div
          className={cn(
            "flex items-center gap-2 border-b border-edge px-5 py-3.5",
            unanswered > 0 && "bg-warn-soft",
          )}
        >
          {unanswered > 0 ? (
            <AlertTriangle className="size-4 shrink-0 text-warn" />
          ) : (
            <CheckCircle2 className="size-4 shrink-0 text-succ" />
          )}
          <h2 id="submit-dialog-title" className="text-[15px] font-semibold text-content">
            确认交卷？
          </h2>
        </div>

        <div className="px-5 py-4">
          {/* 统计：三个数并列，未答用警示色 */}
          <dl className="grid grid-cols-3 gap-2 text-center">
            <Stat label="已作答" value={answered} />
            <Stat
              label="未作答"
              value={unanswered}
              tone={unanswered > 0 ? "warn" : "neutral"}
            />
            <Stat label="已标记" value={marked} tone={marked > 0 ? "warn" : "neutral"} />
          </dl>

          {unanswered > 0 ? (
            <div className="mt-4">
              <p className="text-[13px] font-medium text-warn">
                还有 {unanswered} 题没有作答：
              </p>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {unansweredIndexes.map(({ position, number }) => (
                  <li key={position}>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() => onJump(position)}
                      className="tabular inline-flex h-8 min-w-9 items-center justify-center rounded-sm border border-warn/40 bg-surface-raised px-2 text-[13px] font-medium text-warn transition-colors hover:bg-warn-soft disabled:opacity-50"
                    >
                      {number ?? position + 1}
                    </button>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-[12px] leading-relaxed text-content-soft">
                点题号可以直接跳过去作答。
              </p>
            </div>
          ) : (
            <p className="mt-4 text-[13px] text-content-soft">全部题目都已作答。</p>
          )}

          {/*
            语义必须精确：未作答**不计为错误**，但它确实被系统记录
            （写下一条 `answer.skipped` 观测）。
            说成"没有产生证据"是自相矛盾的 —— 见措辞门禁。
          */}
          <p className="mt-4 border-t border-edge pt-3 text-[12.5px] leading-relaxed text-content-soft">
            未作答不计为错误，也不产生正确/错误的能力证据；系统只记录这题未作答。
            交卷后这次训练即告完成，并留下一条独立记录。之后可以重做，但不会覆盖这次结果。
            <span className="mt-1.5 block text-content-faint">
              交卷之前不会显示答案 —— 提前看到答案会让这次训练失去意义。
            </span>
          </p>
        </div>

        <div className="flex flex-wrap gap-2 border-t border-edge px-5 py-4">
          <Button
            data-autofocus
            onClick={onConfirm}
            loading={pending}
            loadingText="判分中…"
            icon={<Send className="size-4" />}
          >
            确认交卷
          </Button>
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            继续作答
          </Button>
        </div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: "neutral" | "warn";
}) {
  return (
    <div
      className={cn(
        "rounded-md border px-2 py-2.5",
        tone === "warn" ? "border-warn/30 bg-warn-soft" : "border-edge bg-surface",
      )}
    >
      <dd
        className={cn(
          "tabular text-xl font-semibold",
          tone === "warn" ? "text-warn" : "text-content",
        )}
      >
        {value}
      </dd>
      <dt className="mt-0.5 text-[11px] text-content-faint">{label}</dt>
    </div>
  );
}
