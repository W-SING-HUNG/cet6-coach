import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 内容区块。用留白和一条细线划分层级，而不是靠彩色卡片堆叠。 */
export function Panel({
  className,
  children,
  as: Tag = "section",
  ...props
}: HTMLAttributes<HTMLElement> & { as?: "section" | "div" | "article" }) {
  return (
    <Tag
      className={cn("rounded-md border border-edge bg-surface-raised px-4 py-4 sm:px-5 sm:py-5", className)}
      {...props}
    >
      {children}
    </Tag>
  );
}

export function PanelHeader({
  title,
  hint,
  action,
  className,
}: {
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("mb-3 flex items-start justify-between gap-3", className)}>
      <div className="min-w-0">
        <h2 className="text-[15px] font-semibold tracking-tight text-content">{title}</h2>
        {hint ? <p className="mt-0.5 text-[13px] leading-relaxed text-content-faint">{hint}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** 页面标题区。用于每个顶层路由的第一屏。 */
export function PageHeader({
  eyebrow,
  title,
  lead,
  aside,
}: {
  eyebrow?: ReactNode;
  title: ReactNode;
  lead?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <header className="flex flex-col gap-3 border-b border-edge pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {eyebrow ? (
          <p className="mb-1.5 font-mono text-[11px] uppercase tracking-[0.16em] text-content-faint">{eyebrow}</p>
        ) : null}
        <h1 className="text-[26px] leading-tight font-semibold tracking-tight text-content sm:text-[32px]">
          {title}
        </h1>
        {lead ? <p className="mt-2 max-w-2xl text-sm leading-relaxed text-content-soft">{lead}</p> : null}
      </div>
      {aside ? <div className="shrink-0">{aside}</div> : null}
    </header>
  );
}

export function Divider({ className }: { className?: string }) {
  return <hr className={cn("border-0 border-t border-edge", className)} />;
}
