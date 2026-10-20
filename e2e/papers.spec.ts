import { test, expect } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot } from "./helpers";
import { E2E_FIXTURE_PAPERS } from "./config";

/**
 * 真题库浏览流程的浏览器级验证。
 *
 * 前置条件：flow.spec.ts 已完成 onboarding 与诊断（Playwright 按文件顺序串行执行），
 * 且 e2e-server 已把夹具试卷写入独立内容根并导入索引。
 *
 * 数据诚实性：本文件出现的每一份试卷都是 `test_fixture`。
 * 断言中明确要求 UI **标注**它是测试夹具 —— 若夹具能在 UI 上冒充真题，
 * 那正是产品内容策略被破坏的证据，测试必须失败。
 */

const PAPER_ID = E2E_FIXTURE_PAPERS[1].id; // 2024-12 set1

test.describe("真题库：浏览 → 详情 → 大题结构 → 返回/刷新", () => {
  test("从 Practice 进入真题库，结构完整且状态诚实", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // ---------------------------------------------------- Practice 有入口
    await page.goto("/practice");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1").first()).toContainText("练习");

    const libraryEntry = page.getByRole("link", { name: /真题库|浏览真题/ });
    await expect(libraryEntry).toBeVisible();
    await libraryEntry.click();

    // ---------------------------------------------------- 真题库列表
    await expect(page).toHaveURL(/\/practice\/papers$/);
    await expect(page.locator("h1").first()).toContainText("真题库");

    // 三份夹具按年份分组出现（用 h2 限定，避免与卡片 h3 的年份文字冲突：
    // `getByRole("heading", { name: /2024 年/ })` 会同时命中分组标题与两张试卷卡片）
    await expect(page.locator("h2", { hasText: "2024 年" }).first()).toBeVisible();
    await expect(page.locator("h2", { hasText: "2023 年" }).first()).toBeVisible();
    await expect(page.getByText("2024 年 12 月 · set1")).toBeVisible();

    // 来源类型必须显式标注：夹具绝不能看起来像真题
    const fixtureBadges = page.getByText("测试夹具", { exact: true });
    expect(await fixtureBadges.count(), "夹具试卷必须标注来源类型").toBeGreaterThan(0);
    await expect(page.getByText("历年真题", { exact: true })).toHaveCount(0);
    // 未核验必须可见
    expect(await page.getByText("未核验", { exact: true }).count()).toBeGreaterThan(0);

    await expectNoHorizontalOverflow(page, "papers list");
    await shot(page, "papers-01-list");

    // ---------------------------------------------------- 打开试卷详情
    await page.getByRole("link", { name: "打开试卷" }).first().click();
    await expect(page).toHaveURL(new RegExp(`/practice/papers/[^/]+$`));

    // 官方结构：四个大类标题全部出现
    for (const heading of ["写作", "听力", "阅读", "翻译"]) {
      await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
    }
    // 8 个大题全在（含 subtype）
    for (const label of [
      "长对话",
      "听力篇章",
      "讲话 / 报道 / 讲座",
      "选词填空",
      "长篇阅读（匹配）",
      "仔细阅读",
      "段落翻译",
    ]) {
      await expect(page.getByText(new RegExp(label.replace(/[（）/·]/g, "."))).first()).toBeVisible();
    }
    // 官方题量与权重如实展示
    await expect(page.getByText(/官方 8 题 · 占卷面 8%/).first()).toBeVisible();
    await expect(page.getByText(/官方 10 题 · 占卷面 20%/).first()).toBeVisible();

    // 来源与版本区块
    await expect(page.getByText("来源与版本")).toBeVisible();
    await expect(page.getByText("内容版本")).toBeVisible();
    await expect(page.getByText("v1", { exact: true }).first()).toBeVisible();

    await expectNoHorizontalOverflow(page, "paper detail");
    await shot(page, "papers-02-detail");

    // ---------------------------------------------------- 进入一个大题
    const sectionLinks = page.getByRole("link", { name: "查看结构" });
    expect(await sectionLinks.count()).toBe(8);
    await sectionLinks.first().click();
    await expect(page).toHaveURL(/\/section\//);

    // 写作大题：题面可见，答案是折叠的
    await expect(page.locator("h1").first()).toContainText("写作");
    await expect(page.getByText("Fixture writing prompt").first()).toBeVisible();
    await expect(page.getByText("答案与解析").first()).toBeVisible();
    await expect(page.getByText("这是结构浏览，不是作答")).toBeVisible();
    await expectNoHorizontalOverflow(page, "paper section writing");
    await shot(page, "papers-03-section-writing");

    // 返回试卷
    await page.getByRole("link", { name: "返回试卷" }).click();
    await expect(page).toHaveURL(new RegExp(`/practice/papers/[^/]+$`));

    // ---------------------------------------------------- 听力大题：音频引用可见
    await page.getByRole("link", { name: "查看结构" }).nth(1).click();
    await expect(page.locator("h1").first()).toContainText("长对话");
    await expect(page.getByText(/assets\/.*\.wav/).first()).toBeVisible();
    await expect(page.getByText("听力原文（建议做完再展开）").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, "paper section listening");
    await shot(page, "papers-04-section-listening");

    // ---------------------------------------------------- 朗读题组分组保持
    await page.getByRole("link", { name: "返回试卷" }).click();
    await page.getByRole("link", { name: "查看结构" }).nth(6).click();
    await expect(page.locator("h1").first()).toContainText("仔细阅读");
    // 两篇文章各自成组：出现两次"文章"
    expect(await page.getByText("文章", { exact: true }).count()).toBe(2);
    await expectNoHorizontalOverflow(page, "paper section reading");
    await shot(page, "papers-05-section-reading");

    // ---------------------------------------------------- 刷新后状态保持
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1").first()).toContainText("仔细阅读");
    await expect(page.getByText("Fixture careful-reading passage.").first()).toBeVisible();

    expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("训练池 / 模考保留的切换真实落库", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`/practice/papers/${PAPER_ID}`);
    await page.waitForLoadState("networkidle");

    const trainingButton = page.getByRole("button", { name: "训练池", exact: true });
    const reserveButton = page.getByRole("button", { name: "模考保留", exact: true });
    await expect(trainingButton).toBeVisible();
    await expect(trainingButton).toHaveAttribute("aria-pressed", "true");

    // 切到模考保留
    await reserveButton.click();
    await expect(reserveButton).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("模考保留", { exact: true }).first()).toBeVisible();

    // 刷新后仍在（真实持久化，不是前端状态）
    await page.reload();
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("button", { name: "模考保留", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    // 列表页的筛选与计数随之变化
    await page.goto("/practice/papers?pool=mock_reserve");
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("2024 年 12 月 · set1")).toBeVisible();

    // 还原，避免影响后续测试
    await page.goto(`/practice/papers/${PAPER_ID}`);
    await page.getByRole("button", { name: "训练池", exact: true }).click();
    await expect(page.getByRole("button", { name: "训练池", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("未实现的执行模式说明为「后续阶段」，不是死按钮", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`/practice/papers/${PAPER_ID}`);
    await page.waitForLoadState("networkidle");

    // 文案已随 Expert Training V1 更新：阅读三题型**现在可以作答**，
    // 听力/写作/翻译仍是仅浏览。断言的是这个真实状态 ——
    // 而不是旧版"全部还不能作答"，那种表述现在会是不诚实的。
    await expect(page.getByText(/现在可以直接作答/)).toBeVisible();
    await expect(page.getByText(/可作答：选词填空、长篇阅读（匹配）、仔细阅读/)).toBeVisible();
    // 仍未实现的部分必须显式说明为"仅浏览"与"后续阶段"，不能是死按钮
    await expect(page.getByText(/仅浏览：听力/)).toBeVisible();
    await expect(page.getByText(/后续阶段：整卷计时模考、听写与按题精听/)).toBeVisible();
    // 不得再出现"听力播放器属于后续阶段"这类与现状矛盾的表述
    await expect(page.getByText(/听力播放器/)).toHaveCount(0);

    // 页面上不得出现无法解释的禁用按钮（禁用元素必须带 title 或可见说明）
    const disabledButtons = page.locator("button[disabled]");
    const count = await disabledButtons.count();
    for (let index = 0; index < count; index += 1) {
      const button = disabledButtons.nth(index);
      const hasTitle = (await button.getAttribute("title")) !== null;
      const text = (await button.textContent()) ?? "";
      expect(hasTitle || text.trim().length > 0, "存在无说明的禁用按钮").toBe(true);
    }

    // 不得提示"听力播放器可用"这类尚未实现的能力
    const body = await page.locator("body").innerText();
    expect(body).not.toContain("播放器已就绪");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});

test.describe("真题库：响应式", () => {
  for (const viewport of [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ] as const) {
    test(`${viewport.name} ${viewport.width}×${viewport.height}：真题库三个层级都无横向溢出`, async ({ page }) => {
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const path of ["/practice/papers", `/practice/papers/${PAPER_ID}`]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await expect(page.locator("h1").first()).toBeVisible();
        await expectNoHorizontalOverflow(page, `${viewport.name} ${path}`);
        await shot(page, `${viewport.name}-${path.replace(/\//g, "-")}`);
      }

      await page.goto(`/practice/papers/${PAPER_ID}`);
      await page.getByRole("link", { name: "查看结构" }).nth(1).click();
      await expect(page.locator("h1").first()).toBeVisible();
      await expectNoHorizontalOverflow(page, `${viewport.name} section`);
      await shot(page, `${viewport.name}-section-listening`);

      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    });
  }
});
