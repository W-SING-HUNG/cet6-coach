import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 全站页面 gutter 的**结构性**回归门禁。
 *
 * ── 它防的是哪一次真实事故 ──
 *
 * 上一版把画布宽度写到 `@layer base`，而 AppShell 的 `<main>` 带了
 * `px-0`。Tailwind v4 的 utilities 层在 base 之后，于是 `px-0` 一条工具类
 * 就静默把全站页面 gutter 抵消成 0 —— 所有常规页面贴边，而源码里
 * 看起来"明明写了 padding"。这类缺陷不会报错、不会让测试变红，
 * 只会在真实浏览器里表现为"页面贴边"。
 *
 * 因此本门禁检查三件**结构性事实**，而不是像素值：
 *
 * 1. 画布规则必须在 `@layer` **之外**（层外样式胜过任何层，包括 utilities）；
 * 2. AppShell 的 `<main>` 不得携带任何水平内边距工具类；
 * 3. 三类外壳（wide / focused / immersive）都必须有画布规则，
 *    且 immersive 必须保持零内边距（不能为了统一而破坏答题工作区）。
 */

const ROOT = join(__dirname, "..");
const CSS = readFileSync(join(ROOT, "src/app/globals.css"), "utf8");
const SHELL = readFileSync(join(ROOT, "src/components/nav/app-shell.tsx"), "utf8");

/** 取 `@layer base { ... }` 里画布规则的那一段（用来断言它**不**在那里）。 */
function baseLayerBlock(): string {
  const start = CSS.indexOf("@layer base {");
  if (start < 0) return "";
  let depth = 0;
  for (let index = start; index < CSS.length; index += 1) {
    if (CSS[index] === "{") depth += 1;
    else if (CSS[index] === "}") {
      depth -= 1;
      if (depth === 0) return CSS.slice(start, index + 1);
    }
  }
  return CSS.slice(start);
}

/** 找到 `.app-canvas` 主规则在文件中的位置（排除注释里的提及）。 */
function canvasRuleIndex(): number {
  const match = CSS.match(/^\.app-canvas\s*\{/m);
  return match === null ? -1 : (match.index ?? -1);
}

describe("AppShell 全站布局 gutter（结构性门禁）", () => {
  describe("画布规则不得位于 cascade layer 内", () => {
    it("`.app-canvas` 主规则存在", () => {
      expect(canvasRuleIndex()).toBeGreaterThan(-1);
    });

    it("`@layer base` 内**不再**包含画布宽度规则", () => {
      /*
       * 这是本轮修复的核心。若有人为了"整理"把画布规则挪回 @layer base，
       * 那么一条 `px-0` 工具类就能再次把它抵消 —— 本断言会立刻变红。
       */
      const base = baseLayerBlock();
      expect(base).not.toContain(".app-canvas");
      expect(base).not.toContain('[data-shell="wide"]');
      expect(base).not.toContain('[data-shell="focused"]');
    });
  });

  describe("三类外壳都必须有画布规则", () => {
    for (const shell of ["wide", "focused", "immersive"] as const) {
      it(`[data-shell="${shell}"] 有对应的画布规则`, () => {
        expect(CSS).toContain(`[data-shell="${shell}"] .app-canvas`);
      });
    }

    it("Wide 使用 1280px 的居中内容宽度", () => {
      const wideRule = CSS.slice(CSS.indexOf('[data-shell="wide"] .app-canvas'));
      expect(wideRule.slice(0, 200)).toContain("max-width: 1280px");
    });

    it("Focused 保留窄宽度（表单工效），不被拉成 Wide", () => {
      const focusedRule = CSS.slice(CSS.indexOf('[data-shell="focused"] .app-canvas'));
      expect(focusedRule.slice(0, 200)).toContain("max-width: 720px");
    });

    it("Immersive 保持零内边距（答题工作区不得被全局 gutter 破坏）", () => {
      const immersiveRule = CSS.slice(CSS.indexOf('[data-shell="immersive"] .app-canvas'));
      expect(immersiveRule.slice(0, 200)).toContain("max-width: none");
      expect(immersiveRule.slice(0, 200)).toContain("padding-inline: 0");
    });
  });

  describe("响应式 gutter 阶梯（16 / 20 / 24 / 32px）", () => {
    it("Wide 在手机上是 16px", () => {
      const wideRule = CSS.slice(CSS.indexOf('[data-shell="wide"] .app-canvas'));
      expect(wideRule.slice(0, 200)).toContain("padding-inline: 1rem");
    });

    it("Wide 在小平板上提到 20px（1.25rem）", () => {
      expect(CSS).toContain("padding-inline: 1.25rem");
    });

    it("Wide 在平板与桌面上是 24px（1.5rem）", () => {
      expect(CSS).toContain("padding-inline: 1.5rem");
    });

    it("超宽屏是 32px（2rem）", () => {
      expect(CSS).toContain("padding-inline: 2rem");
    });
  });

  describe("AppShell 的 <main> 不得抵消全局 gutter", () => {
    /** `<main ...>` 开始标签里 `className={cn(...)}` 的**实际参数**（剔除注释）。 */
    function mainClassNameArgs(): string {
      const start = SHELL.indexOf("<main");
      const end = SHELL.indexOf(">", start);
      const openTag = SHELL.slice(start, end);
      return openTag
        .split("\n")
        .filter((line) => {
          const trimmed = line.trim();
          // 注释行（块注释续行 / 行注释）不是 className 的实际内容
          return !trimmed.startsWith("*") && !trimmed.startsWith("/*") && !trimmed.startsWith("//");
        })
        .join("\n");
    }

    it("不携带 `px-0`（上一版贴边事故的直接原因）", () => {
      /*
       * 这是"同一事故不得复发"的那一条。`px-0` 出现在 main 上时，
       * 浏览器实测 paddingLeft 会变成 0px —— 即使 CSS 里写着 1.5rem。
       */
      expect(mainClassNameArgs()).not.toMatch(/\bpx-0\b/);
    });

    it("不携带任何水平内边距工具类（px-* / pl-* / pr-*）", () => {
      expect(mainClassNameArgs()).not.toMatch(/\b(px-\d|pl-\d|pr-\d|px-\[)/);
    });

    it("仍然标记 app-canvas（宽度规则的挂载点）", () => {
      expect(SHELL).toContain("app-canvas flex-1");
    });
  });
});
