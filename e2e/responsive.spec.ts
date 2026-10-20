import { test, expect } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot } from "./helpers";

/**
 * 响应式与导航验证。
 *
 * 本 spec 在每个测试内部显式设定 viewport，因此同一份数据库可以在
 * mobile 与 desktop 两个尺寸下被真实检验，不需要依赖 project 顺序。
 * 前置条件：flow.spec.ts 已完成 onboarding 与诊断（Playwright 按文件顺序串行执行）。
 */

const VIEWPORTS = [
  { name: "mobile", width: 390, height: 844 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

const ROUTES = [
  { path: "/today", heading: /距离考试还有 \d+ 天/ },
  { path: "/practice", heading: "练习" },
  { path: "/practice/papers", heading: "真题库" },
  { path: "/review", heading: "复习队列" },
  { path: "/progress", heading: "进度" },
  { path: "/settings", heading: "设置" },
] as const;

test.describe("响应式与导航", () => {
  for (const viewport of VIEWPORTS) {
    test(`${viewport.name} ${viewport.width}×${viewport.height}：所有主要页面可用且无横向溢出`, async ({ page }) => {
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const route of ROUTES) {
        await page.goto(route.path);
        await page.waitForLoadState("networkidle");

        // 用 h1 定位页面主体内容：导航里也有同名文字，按文本定位会命中隐藏的导航项
        // （实测踩到：/progress 的"进度"先在隐藏的桌面导航里匹配到，导致假失败）
        await expect(page.locator("h1").first()).toBeVisible({ timeout: 20_000 });
        if (route.heading instanceof RegExp) {
          await expect(page.locator("h1").first()).toHaveText(route.heading);
        } else {
          await expect(page.locator("h1").first()).toContainText(route.heading);
        }

        // 无横向溢出
        await expectNoHorizontalOverflow(page, `${viewport.name} ${route.path}`);

        await shot(page, `${viewport.name}-route-${route.path.replace(/\//g, "")}`);
      }

      expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
      expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
    });
  }

  test("导航在移动端与桌面端正确切换形态", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);

    // 移动端：底部导航可见，顶部导航隐藏
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/today");
    const bottomNav = page.locator("nav[aria-label='主导航']");
    await expect(bottomNav).toBeVisible();
    await expect(page.locator("header nav")).toBeHidden();
    for (const label of ["今日", "练习", "复习", "进度", "设置"]) {
      await expect(bottomNav.getByRole("link", { name: label })).toBeVisible();
    }

    // 底部导航不得遮挡 Today 的主要 CTA
    const startLink = page.getByRole("link", { name: "开始" }).first();
    await expect(startLink).toBeVisible();
    const startBox = await startLink.boundingBox();
    const navBox = await bottomNav.boundingBox();
    expect(startBox, "移动端未找到主要 CTA").not.toBeNull();
    expect(navBox, "移动端未找到底部导航").not.toBeNull();
    expect(
      startBox!.y + startBox!.height,
      "移动端主要 CTA 被底部导航遮挡",
    ).toBeLessThanOrEqual(navBox!.y + 1);

    // 桌面端：顶部导航可见，底部导航隐藏
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.reload();
    await expect(page.locator("header nav")).toBeVisible();
    await expect(page.locator("nav[aria-label='主导航']")).toBeHidden();
    for (const label of ["今日", "练习", "复习", "进度", "设置"]) {
      await expect(page.locator("header nav").getByRole("link", { name: label })).toBeVisible();
    }

    await expectNoHorizontalOverflow(page, "desktop today");
    await shot(page, "desktop-today-nav");

    expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("诊断页控件在两个尺寸下都可点击", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      // 诊断已完成 → /diagnostic 会重定向到结果页，两者都说明流程可用
      await page.goto("/diagnostic");
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveURL(/\/diagnostic(\/result)?$/);
      await expectNoHorizontalOverflow(page, `${viewport.name} diagnostic`);
    }

    expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("诊断结果页的未评估状态在两个尺寸下都清楚可读", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);

    for (const viewport of VIEWPORTS) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.goto("/diagnostic/result");
      await page.waitForLoadState("networkidle");

      const section = page.getByTestId("unassessed-section");
      await expect(section).toBeVisible();
      await expect(section).toContainText("尚未有效评估");
      await expect(section).toContainText("听力");

      await expectNoHorizontalOverflow(page, `${viewport.name} result`);
      await shot(page, `${viewport.name}-diagnostic-result-unassessed`);
    }

    expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });
});
