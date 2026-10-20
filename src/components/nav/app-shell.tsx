"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, BookOpenCheck, CalendarCheck, Layers, Settings2 } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * 应用外壳 —— 路由感知。
 *
 * ── 为什么必须分成三类，而不是一个全局 max-width ──
 *
 * v1 对每个路由都用同一个居中列（`max-w-5xl`）。在 1440 宽的桌面上，
 * 那意味着两侧各留约 200px 空白，而**回答工作区**被压成一条竖排长文：
 * 阅读材料与题目上下堆叠，学习者必须来回滚动几屏才能对照原文。
 *
 * 根因不是"留白太多"，而是**宽度被当成了全局样式**。
 * 真正的判据是：**任务决定宽度**。
 *
 *   wide      普通应用页面（Today / 练习 / 真题库 / 复习 / 进度）
 *             → 需要宽画布做有意义的响应式栅格，而不是一条窄列
 *   focused   表单与设置 → 窄宽度提高表单工效（这里宽反而更难填）
 *   immersive 回答与回看工作区 → 不设上限，由工作区自己管理分栏
 *
 * 实现方式：把类别写进 `data-shell`，宽度规则集中在 `globals.css`
 * （`[data-shell="..."] .app-canvas`）。因此每个路由**只声明自己是哪一类**，
 * 不需要各自硬编码 max-width —— 也就不会出现"某页忘了改"的漂移。
 *
 * 导航可见性：
 * - immersive 隐藏全部应用导航。学习者不该在博客页的框架里做真题，
 *   而且移动端底部导航会与工作区自己的粘性控制条抢位置。
 * - focused 的 onboarding / diagnostic 也隐藏导航（进入前没有可去之处）。
 */

export type ShellKind = "wide" | "focused" | "immersive";

const NAV = [
  { href: "/today", label: "Today", zh: "今日", icon: CalendarCheck },
  { href: "/practice", label: "Practice", zh: "练习", icon: BookOpenCheck },
  { href: "/review", label: "Review", zh: "复习", icon: Layers },
  { href: "/progress", label: "Progress", zh: "进度", icon: BarChart3 },
  { href: "/settings", label: "Settings", zh: "设置", icon: Settings2 },
] as const;

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * 判定路由属于哪一类外壳。
 *
 * 顺序有意义：immersive 的路径同时也是 `/practice/...` 的后代，
 * 因此必须先判 immersive，否则会被 wide 的规则吃掉。
 */
export function shellKindOf(pathname: string): ShellKind {
  // 回答 / 回看工作区：真题阅读训练的作答页
  if (/^\/practice\/papers\/[^/]+\/train\/[^/]+/.test(pathname)) return "immersive";
  // 表单与设置：窄宽度是工效选择，不是"没做完"
  if (pathname === "/settings") return "focused";
  if (pathname === "/onboarding" || pathname.startsWith("/diagnostic")) return "focused";
  return "wide";
}

/** 沉浸式流程隐藏应用导航：进行中的事情只有一件，导航只会成为干扰。 */
function hidesNav(pathname: string): boolean {
  if (shellKindOf(pathname) === "immersive") return true;
  return pathname === "/onboarding" || pathname.startsWith("/diagnostic");
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const shell = shellKindOf(pathname);
  const showNav = !hidesNav(pathname);

  return (
    <div data-shell={shell} className="flex min-h-dvh flex-col bg-surface">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-3 focus:top-3 focus:z-50 focus:rounded-sm focus:bg-content focus:px-3 focus:py-2 focus:text-sm focus:text-surface-raised"
      >
        跳到主要内容
      </a>

      {showNav ? <TopNav pathname={pathname} /> : null}

      <main
        id="main"
        className={cn(
          "app-canvas flex-1",
          /*
           * ── 为什么这里**不再有任何内边距工具类** ──
           *
           * 上一版写的是 `px-0 pb-24 pt-5 sm:pb-10 sm:pt-7`。其中 `px-0`
           * 属于 Tailwind 的 utilities 层，而画布 gutter 当时在 `@layer base`
           * 里 —— utilities 层在后，于是它静默把全站 gutter 抵消成 0，
           * 所有常规页面贴边（浏览器实测 paddingLeft = 0px）。
           *
           * 现在的分工是硬边界：
           * · 页面级 gutter 与上下留白 → `globals.css` 的 `.app-canvas`（层外，唯一权威）；
           * · 沉浸式工作区 → 自己管理一切。
           * 因此 `<main>` 只声明"填满剩余高度"，不再参与任何内边距决定。
           */
          shell === "immersive" && "min-h-0",
        )}
      >
        {children}
      </main>

      {showNav ? <BottomNav pathname={pathname} /> : null}
    </div>
  );
}

function TopNav({ pathname }: { pathname: string }) {
  return (
    <header className="sticky top-0 z-30 hidden border-b border-edge bg-surface-raised sm:block">
      <div className="mx-auto flex w-full max-w-[1600px] items-center gap-6 px-6">
        <Link href="/today" className="flex items-center gap-2 py-3.5">
          <BrandMark />
          <span className="text-[15px] font-semibold tracking-tight text-content">CET-6 Coach</span>
        </Link>
        <nav className="flex items-center gap-1">
          {NAV.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-sm px-3 py-1.5 text-[13px] font-medium transition-colors",
                  active
                    ? "bg-accent-soft text-accent"
                    : "text-content-soft hover:bg-surface-sunken hover:text-content",
                )}
              >
                {item.zh}
                {/*
                  英文副标签保留，但不再用全大写小字：
                  那是 v1 的"编辑排版"痕迹，在应用里它只贡献噪声。
                */}
                <span className="ml-1.5 text-[11px] opacity-55">{item.label}</span>
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

function BottomNav({ pathname }: { pathname: string }) {
  return (
    <nav
      aria-label="主导航"
      className="fixed inset-x-0 bottom-0 z-30 border-t border-edge bg-surface-raised pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      <ul className="flex">
        {NAV.map((item) => {
          const active = isActive(pathname, item.href);
          const Icon = item.icon;
          return (
            <li key={item.href} className="flex-1">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition-colors",
                  active ? "text-accent" : "text-content-faint",
                )}
              >
                <Icon className="size-5" strokeWidth={active ? 2.1 : 1.7} />
                {item.zh}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function BrandMark() {
  return (
    <span
      aria-hidden
      className="grid size-7 place-items-center rounded-sm bg-content text-[13px] font-bold text-surface-raised"
    >
      六
    </span>
  );
}
