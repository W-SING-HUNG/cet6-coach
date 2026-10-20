"use client";

import { useState, useTransition } from "react";
import { Notice } from "@/components/ui/states";
import { PAPER_POOLS, PAPER_POOL_LABELS, type PaperPool } from "@/domain/paper";
import { cn } from "@/lib/utils";
import { setPaperPoolAction } from "../actions";

/**
 * 训练池 / 模考保留的切换。
 *
 * 为什么做成显式按钮而不是自动判断：这是**用户的备考策略**，
 * 不是系统能从进度推断出来的结论。把"我打算留到模考"这种意图
 * 交给算法猜，就会出现"系统擅自把卷子算成已练习"的错误。
 */
export function PoolSwitch({ paperId, pool }: { paperId: string; pool: PaperPool }) {
  const [current, setCurrent] = useState(pool);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function choose(next: PaperPool) {
    if (next === current) return;
    setError(null);
    const previous = current;
    setCurrent(next); // 乐观更新：策略切换是低风险、可回退的
    startTransition(async () => {
      const result = await setPaperPoolAction({ paperId, pool: next });
      if (!result.ok) {
        setCurrent(previous);
        setError(result.error);
      }
    });
  }

  return (
    <div>
      <div
        role="group"
        aria-label="试卷归属"
        className="inline-flex overflow-hidden rounded-sm border border-edge"
      >
        {PAPER_POOLS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={current === value}
            disabled={pending}
            onClick={() => choose(value)}
            className={cn(
              "px-3 py-1.5 text-[13px] font-medium transition-colors disabled:opacity-60",
              current === value ? "bg-accent-soft text-accent" : "bg-surface-raised text-content-soft hover:text-content",
            )}
          >
            {PAPER_POOL_LABELS[value]}
          </button>
        ))}
      </div>
      {pending ? <p className="mt-1.5 text-[12px] text-content-faint">保存中…</p> : null}
      {error ? (
        <Notice tone="danger" className="mt-2">
          {error}
        </Notice>
      ) : null}
    </div>
  );
}
