export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-start gap-3 py-16">
      <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-content-faint">404</p>
      <h1 className="text-2xl font-semibold tracking-tight text-content">页面不存在</h1>
      <p className="text-[13px] leading-relaxed text-content-soft">
        你访问的地址没有对应页面。可能是任务已经完成、计划被重排，或者链接过期。
      </p>
      <a
        href="/today"
        className="mt-2 rounded-sm bg-accent px-4 py-2 text-sm font-medium text-surface-raised transition-colors hover:bg-accent-hover"
      >
        返回 Today
      </a>
    </div>
  );
}
