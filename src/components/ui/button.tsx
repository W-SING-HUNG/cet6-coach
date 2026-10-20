import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * 按钮。必须有清晰的状态区分 —— 产品要求"不能点了像没反应"。
 * loading 时禁用并显示进行中文案，而不是只转圈。
 *
 * `ref` 作为普通 prop 传递（React 19 起 `ref` 对函数组件即普通 prop）。
 * 需要它的场景是真实的：对话框打开后要把焦点移到主要动作按钮，
 * 否则键盘用户的焦点会留在弹层外面。
 */

const buttonStyles = cva(
  "inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-55 whitespace-nowrap",
  {
    variants: {
      variant: {
        primary:
          "bg-accent text-surface-raised hover:bg-accent-hover active:translate-y-px",
        secondary:
          "border border-edge-strong bg-surface-raised text-content hover:border-content-faint hover:bg-surface",
        ghost: "text-content-soft hover:bg-surface-sunken hover:text-content",
        danger: "border border-danger/40 text-danger hover:bg-danger-soft",
      },
      size: {
        sm: "h-8 rounded-sm px-3 text-[13px]",
        md: "h-10 rounded-sm px-4 text-sm",
        lg: "h-12 rounded-sm px-6 text-[15px]",
      },
      block: { true: "w-full", false: "" },
    },
    defaultVariants: { variant: "primary", size: "md", block: false },
  },
);

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonStyles> {
  loading?: boolean;
  loadingText?: string;
  icon?: ReactNode;
  ref?: Ref<HTMLButtonElement>;
}

export function Button({
  className,
  variant,
  size,
  block,
  loading = false,
  loadingText = "处理中…",
  icon,
  children,
  disabled,
  type = "button",
  ref,
  ...props
}: ButtonProps) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonStyles({ variant, size, block }), className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading ? (
        <>
          <Spinner />
          {loadingText}
        </>
      ) : (
        <>
          {icon}
          {children}
        </>
      )}
    </button>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-3.5 shrink-0 animate-spin rounded-full border-[1.5px] border-current border-t-transparent",
        className,
      )}
    />
  );
}
