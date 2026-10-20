"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";

/** 全局错误边界。必须给出恢复路径，不允许白屏或死胡同。 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[cet6] 未处理的渲染错误：", error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-16">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-danger">Error</p>
      <h1 className="text-2xl font-semibold tracking-tight text-content">这一页出错了</h1>
      <p className="text-[13px] leading-relaxed text-content-soft">
        数据没有被破坏 —— 已经保存的记录仍然完整。可以先重试，若持续失败请检查数据文件是否可写。
      </p>
      <pre className="w-full overflow-x-auto rounded-sm border border-edge bg-surface-sunken px-3 py-2 font-mono text-[11px] text-content-soft">
        {error.message}
        {error.digest ? `\n(digest: ${error.digest})` : ""}
      </pre>
      <div className="flex gap-2">
        <Button onClick={reset}>重试</Button>
        <a
          href="/today"
          className="inline-flex h-10 items-center rounded-sm border border-edge-strong px-4 text-sm font-medium text-content transition-colors hover:bg-surface-sunken"
        >
          返回 Today
        </a>
      </div>
    </div>
  );
}
