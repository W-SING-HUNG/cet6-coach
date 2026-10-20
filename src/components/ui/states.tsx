import type { ReactNode } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 状态提示组件。
 * 产品要求每个流程都有 loading / error / success / disabled 状态，
 * 这里提供统一的视觉语言，避免各处各写一套。
 */

type Tone = "info" | "success" | "warn" | "danger";

const toneStyles: Record<Tone, { wrap: string; icon: ReactNode }> = {
  info: { wrap: "border-edge bg-surface-sunken text-content-soft", icon: <Info className="size-4 shrink-0" /> },
  success: {
    wrap: "border-succ/25 bg-accent-soft text-accent",
    icon: <CheckCircle2 className="size-4 shrink-0" />,
  },
  warn: { wrap: "border-warn/25 bg-warn-soft text-warn", icon: <AlertTriangle className="size-4 shrink-0" /> },
  danger: {
    wrap: "border-danger/25 bg-danger-soft text-danger",
    icon: <XCircle className="size-4 shrink-0" />,
  },
};

export function Notice({
  tone = "info",
  title,
  children,
  className,
  action,
}: {
  tone?: Tone;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const style = toneStyles[tone];
  return (
    <div
      role={tone === "danger" ? "alert" : "status"}
      className={cn("flex items-start gap-2.5 rounded-md border px-3.5 py-3 text-[13px] leading-relaxed", style.wrap, className)}
    >
      <span className="mt-0.5">{style.icon}</span>
      <div className="min-w-0 flex-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className={cn(title && "mt-0.5", "text-content-soft")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0 self-center">{action}</div> : null}
    </div>
  );
}

/** 统一的加载占位。用固定高度避免布局跳动。 */
export function LoadingBlock({ label = "加载中…", minHeight = 120 }: { label?: string; minHeight?: number }) {
  return (
    <div
      className="flex items-center justify-center gap-2.5 rounded-md border border-edge bg-surface-raised text-[13px] text-content-faint"
      style={{ minHeight }}
      role="status"
      aria-live="polite"
    >
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

/** 正式空状态。用于"功能存在但当前没有内容"，区别于错误。 */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center rounded-md border border-dashed border-edge-strong bg-surface-raised px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? <div className="mb-3 text-content-faint">{icon}</div> : null}
      <p className="text-[15px] font-semibold text-content">{title}</p>
      {description ? (
        <div className="mt-1.5 max-w-md text-[13px] leading-relaxed text-content-soft">{description}</div>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** 错误状态。必须提供恢复路径，不允许死胡同。 */
export function ErrorState({
  title = "出错了",
  message,
  onRetry,
  retryLabel = "重试",
  children,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
  children?: ReactNode;
}) {
  return (
    <div role="alert" className="rounded-md border border-danger/25 bg-danger-soft px-4 py-4">
      <div className="flex items-start gap-2.5">
        <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-danger">{title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-content-soft">{message}</p>
          {children}
        </div>
      </div>
      {onRetry ? (
        <div className="mt-3 pl-6">
          <button
            type="button"
            onClick={onRetry}
            className="rounded-sm border border-danger/40 px-3 py-1.5 text-[13px] font-medium text-danger transition-colors hover:bg-danger/10"
          >
            {retryLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** Pending 状态：功能已建模但素材未就绪。明确说明缺什么，不用假按钮。 */
export function PendingState({
  title,
  reason,
  required,
  className,
}: {
  title: string;
  reason: string;
  required?: string[];
  className?: string;
}) {
  return (
    <div className={cn("rounded-md border border-warn/25 bg-warn-soft px-4 py-4", className)}>
      <div className="flex items-start gap-2.5">
        <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-warn">{title}</p>
          <p className="mt-1 text-[13px] leading-relaxed text-content-soft">{reason}</p>
          {required && required.length > 0 ? (
            <ul className="mt-2 space-y-1 text-[13px] text-content-soft">
              {required.map((item) => (
                <li key={item} className="flex gap-2">
                  <span aria-hidden className="text-warn">
                    ·
                  </span>
                  <span>{item}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </div>
  );
}
