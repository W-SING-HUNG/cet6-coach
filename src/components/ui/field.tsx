import type { ButtonHTMLAttributes, InputHTMLAttributes, TextareaHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const fieldBase =
  "w-full rounded-sm border bg-surface-raised px-3 text-content placeholder:text-content-faint transition-colors disabled:cursor-not-allowed disabled:bg-surface-sunken disabled:opacity-70";

export function Field({
  label,
  hint,
  error,
  suffix,
  htmlFor,
  children,
  className,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  suffix?: string;
  htmlFor?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-content">
        {label}
        {suffix ? <span className="ml-1 font-normal text-content-faint">{suffix}</span> : null}
      </label>
      {children}
      {error ? (
        <p className="text-[12px] text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-[12px] text-content-faint">{hint}</p>
      ) : null}
    </div>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn(fieldBase, "h-10 border-edge-strong text-sm focus:border-accent", className)}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(fieldBase, "border-edge-strong py-2.5 text-sm leading-relaxed focus:border-accent", className)}
      {...props}
    />
  );
}

/** 时间选择：常用档位一键切换，避免手输数字。 */
export function MinuteChips({
  value,
  onChange,
  options = [0, 10, 20, 30, 45, 60, 90, 120],
  disabled,
}: {
  value: number;
  onChange: (value: number) => void;
  options?: number[];
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((option) => {
        const active = option === value;
        return (
          <button
            key={option}
            type="button"
            disabled={disabled}
            onClick={() => onChange(option)}
            aria-pressed={active}
            className={cn(
              "tabular h-8 min-w-11 rounded-sm border px-2 text-[13px] font-medium transition-colors",
              active
                ? "border-accent bg-accent-soft text-accent"
                : "border-edge-strong bg-surface-raised text-content-soft hover:border-content-faint hover:text-content",
              disabled && "cursor-not-allowed opacity-55",
            )}
          >
            {option === 0 ? "0" : option}
          </button>
        );
      })}
    </div>
  );
}

export function ToggleChip({
  active,
  children,
  ...props
}: { active: boolean; children: React.ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={cn(
        "rounded-sm border px-3 py-1.5 text-[13px] font-medium transition-colors",
        active
          ? "border-accent bg-accent-soft text-accent"
          : "border-edge-strong bg-surface-raised text-content-soft hover:border-content-faint hover:text-content",
      )}
      {...props}
    >
      {children}
    </button>
  );
}
