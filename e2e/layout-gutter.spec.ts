import { test, expect } from "@playwright/test";
import { attachErrorCollectors, ensureOnboardedForLayout } from "./helpers";

/**
 * 全站页面级 gutter 的**真实浏览器**回归。
 *
 * ── 为什么需要这一条，而不是只有源码测试 ──
 *
 * `tests/app-shell-layout.test.ts` 检查的是**源码结构**：画布规则不在
 * `@layer` 内、`<main>` 不带 `px-*`、三类外壳都有规则。那些断言必要但
 * **不充分** —— 它无法证明浏览器**实际计算**出来的 padding 是多少。
 *
 * 这里守的正是那个差额。这条用例存在的直接原因是一个真实缺陷：
 * 画布规则曾写在 `@layer base`，而 `<main>` 带了 `px-0`；Tailwind v4
 * 把 utilities 放在 base 之后的层里，于是源码里"明明写了 1.5rem"，
 * 浏览器 computed padding 却是 `0px`，**全站页面贴边**。
 * 只有真实浏览器读数能抓住这种"源码对、结果错"的形态。
 *
 * ── 独立可运行（本轮修复）──
 *
 * 这些断言依赖 `/today` 等页面**真的渲染出来**；未 onboarding 时产品会
 * 重定向到 `/onboarding`，shell 分类与几何都会不同。
 *
 * 早先本文件隐含依赖 `flow.spec.ts` 先跑过并建立好状态 ——
 * 于是**单独运行**它会有 3 条失败，与 flow 一起跑则 8 条通过。
 * 那是纯粹由执行顺序决定的假失败。
 *
 * 现在改为由本文件**自己声明前置条件**：`ensureOnboardedForLayout` 通过
 * 产品的真实 UI 建立所需状态（幂等，已建立则直接返回），
 * 因此单独运行与并入全套都是一样的结论。
 *
 * ── 判据选择 ──
 *
 * 只断言**契约性**的三件事，不锁定像素细节：
 * 1. 三类外壳各自的 computed padding-inline / max-width 形态正确；
 * 2. 所有常规页面在四个视口下都**有**左右留白，且无横向溢出；
 * 3. 同类页面（wide）使用**同一个**内容左边界 —— 即 Today 与其他 wide
 *    页共享同一条 gutter，不是各写一份。
 *
 * 不比对具体像素值（那样每次设计微调都要改测试），只比对
 * "关系"与"最小安全留白"。
 */

/*
 * 前置状态：在本文件**所有**用例之前建立一次。
 *
 * 用 `test.beforeAll` + 一次性浏览器上下文，而不是每个用例各跑一遍 ——
 * 后者会重复提交诊断（虽然幂等，但白等几十秒）。
 */
let prerequisitesReady = false;

test.beforeAll(async ({ browser }) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    prerequisitesReady = await ensureOnboardedForLayout(page);
  } finally {
    await context.close();
  }
});

/** 四档视口：手机 / 平板 / 桌面 / 超宽屏。 */
const VIEWPORTS = [
  { name: "mobile", width: 375, height: 667, minGutter: 16 },
  { name: "tablet", width: 768, height: 1024, minGutter: 20 },
  { name: "desktop", width: 1440, height: 900, minGutter: 24 },
  { name: "wide", width: 1920, height: 1080, minGutter: 32 },
] as const;

/** 常规 wide 页面（不含需要真实材料的页面，避免依赖数据状态）。 */
const WIDE_ROUTES = ["/today", "/practice", "/practice/papers", "/practice/courses", "/review", "/progress"] as const;

/** focused 页面（窄栏表单）。 */
const FOCUSED_ROUTES = ["/settings"] as const;

/** 读取 `<main>` 的布局事实。 */
async function readMainLayout(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const main = document.querySelector("main");
    if (!main) return null;
    const style = getComputedStyle(main);
    const shell = document.querySelector("[data-shell]")?.getAttribute("data-shell") ?? null;
    const docEl = document.documentElement;
    const firstChild = main.firstElementChild as HTMLElement | null;
    const childRect = firstChild?.getBoundingClientRect() ?? null;
    return {
      shell,
      paddingLeft: parseFloat(style.paddingLeft),
      paddingRight: parseFloat(style.paddingRight),
      maxWidth: style.maxWidth,
      overflow: docEl.scrollWidth > docEl.clientWidth,
      /** 首个内容块相对视口的左边界（即内容的真实视觉起点）。 */
      contentLeft: childRect === null ? null : Math.round(childRect.left),
    };
  });
}

test.describe("全站布局 · 页面 gutter 的真实计算值", () => {
  /*
   * 前置条件断言。
   *
   * 刻意放在**每条用例内部**而不是只放在 beforeAll：若前置建立失败，
   * 失败信息应当出现在每个依赖它的用例上，而不是变成一堆
   * "shell 是 focused/onboarding" 这类难以定位的几何错误。
   */
  function assertPrerequisites(): void {
    expect(
      prerequisitesReady,
      "布局前置状态未能建立（/today 仍被重定向到 /onboarding）。" +
        "本文件通过产品的真实 onboarding + 诊断界面建立该状态；" +
        "若这里失败，说明应用实例本身不可用，而不是布局有问题。",
    ).toBe(true);
  }

  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} ${viewport.width}×${viewport.height}：常规页面都有安全 gutter 且无横向溢出`, async ({
      page,
    }) => {
      assertPrerequisites();
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const route of [...WIDE_ROUTES, ...FOCUSED_ROUTES]) {
        await page.goto(route);
        await page.waitForLoadState("networkidle");

        const layout = await readMainLayout(page);
        expect(layout, `${route}：找不到 <main>`).not.toBeNull();

        // 1) 承重结构：页面 gutter 掌握在共享画布手上
        expect(
          layout!.paddingLeft,
          `${route} @${viewport.width}：主内容区左侧 padding 为 ${layout!.paddingLeft}px —— ` +
            `页面贴边。页面级 gutter 必须由共享画布给出，不得被 px-0 之类的工具类抵消。`,
        ).toBeGreaterThanOrEqual(viewport.minGutter);

        expect(
          layout!.paddingRight,
          `${route} @${viewport.width}：左右 gutter 必须对称（右 ${layout!.paddingRight}px）`,
        ).toBe(layout!.paddingLeft);

        // 2) 内容的真实视觉起点不能贴边（computed padding 生效的最终证据）
        expect(
          layout!.contentLeft,
          `${route} @${viewport.width}：内容左边界贴边（${layout!.contentLeft}px）`,
        ).not.toBeNull();
        expect(layout!.contentLeft!).toBeGreaterThan(0);

        // 3) 无横向溢出
        expect(layout!.overflow, `${route} @${viewport.width}：出现横向溢出`).toBe(false);
      }

      expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
      expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
    });
  }

  test("wide 与 focused 使用各自的宽度策略，但共享同一套 gutter 阶梯", async ({ page }) => {
    assertPrerequisites();
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/today");
    await page.waitForLoadState("networkidle");
    const wide = await readMainLayout(page);

    await page.goto("/settings");
    await page.waitForLoadState("networkidle");
    const focused = await readMainLayout(page);

    expect(wide!.shell).toBe("wide");
    expect(focused!.shell).toBe("focused");

    // 宽度策略不同：wide 更宽，focused 保持表单可读的窄栏。
    const wideMax = wide!.maxWidth === "none" ? Infinity : parseFloat(wide!.maxWidth);
    const focusedMax = focused!.maxWidth === "none" ? Infinity : parseFloat(focused!.maxWidth);
    expect(wideMax, "wide 外壳应有明确的 1280px 上限").toBe(1280);
    expect(focusedMax, "focused 外壳应保留窄栏（不超过 720px）").toBeLessThanOrEqual(720);

    // 但 gutter 完全一致 —— 视觉节奏统一，差异只来自宽度策略。
    expect(
      focused!.paddingLeft,
      "focused 与 wide 必须共享同一套响应式 gutter",
    ).toBe(wide!.paddingLeft);
  });

  test("所有 wide 页面共享同一条内容左边界（Today 不是特例）", async ({ page }) => {
    /*
     * 这是"Today 曾被单独加一层 max-width 导致边距加倍"那次的回归。
     *
     * 若某一页自己又包了一层容器，它的 contentLeft 会明显大于其它页 ——
     * 于是即使"每页都有 gutter"，全站看起来仍不统一。
     */
    assertPrerequisites();
    await page.setViewportSize({ width: 1440, height: 900 });

    const leftEdges: Array<{ route: string; left: number }> = [];
    for (const route of WIDE_ROUTES) {
      await page.goto(route);
      await page.waitForLoadState("networkidle");
      const layout = await readMainLayout(page);
      expect(layout!.shell, `${route} 应是 wide 外壳`).toBe("wide");
      leftEdges.push({ route, left: layout!.contentLeft! });
    }

    const reference = leftEdges[0];
    for (const entry of leftEdges.slice(1)) {
      expect(
        entry.left,
        `${entry.route} 的内容左边界 ${entry.left}px 与 ${reference.route} 的 ${reference.left}px 不一致 —— ` +
          `同类页面必须共享同一条 gutter，不能有页面自己再包一层容器。`,
      ).toBe(reference.left);
    }
  });

  test("沉浸式工作区**不受**全站 gutter 影响（答题分栏的硬边界）", async ({ page }) => {
    /*
     * immersive 的判据是**路由形态**，与内容是否可用无关：
     * AppShell 在内容渲染之前就已确定 data-shell。
     *
     * 因此这里用一个不存在的试卷 id —— 它仍然会进入 immersive 外壳，
     * 于是能验证"全局 gutter 没有侵入答题工作区"这条边界，
     * 而不需要伪造任何真实学习数据。
     */
    assertPrerequisites();
    for (const viewport of [
      { width: 375, height: 667 },
      { width: 1440, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      await page.goto("/practice/papers/layout-probe-not-a-real-paper/train/reading.careful");
      await page.waitForLoadState("networkidle");

      const layout = await readMainLayout(page);
      expect(layout, "沉浸式页面必须仍有 <main>").not.toBeNull();
      expect(layout!.shell, "答题路由必须判定为 immersive 外壳").toBe("immersive");

      /*
       * 0 padding 是**刻意的**：分栏宽度、工作区高度与固定操作栏
       * 全部由工作区自己管理。任何全局 gutter 都会破坏"原文与题目并排"。
       */
      expect(layout!.paddingLeft, "沉浸式工作区不得被加上全局 gutter").toBe(0);
      expect(layout!.paddingRight, "沉浸式工作区不得被加上全局 gutter").toBe(0);
      expect(layout!.maxWidth, "沉浸式工作区不设宽度上限").toBe("none");
      expect(layout!.overflow, "沉浸式页面出现横向溢出").toBe(false);
    }
  });
});
