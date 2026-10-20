import { test, expect } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, chooseFirstOptionPerGroup, hasChoices, hasTextarea, SAMPLE_ESSAY, shot } from "./helpers";
import { E2E_EMPTY_BASE_URL } from "./config";

/**
 * 私有内容库为**空**时的诚实空状态（第二个服务器实例：端口 3200，独立数据库与内容根）。
 *
 * 为什么必须用独立实例而不是在同一实例里造一个"空"分支：
 * 内容根是进程级环境变量。要验证产品在真实空库下的行为，
 * 就必须真的有一个内容根不存在的运行实例。
 *
 * 本文件同时验证一条内容策略硬约束：
 * **空库时绝不出现任何伪造的真题**（例如为了截图好看塞一份「2025 真题」）。
 */

const EMPTY = E2E_EMPTY_BASE_URL;

/** 在空库实例上完成 onboarding + 诊断，否则 /practice 会重定向。 */
async function onboardOnEmptyInstance(page: import("@playwright/test").Page): Promise<void> {
  await page.goto(`${EMPTY}/`);
  await page.waitForLoadState("networkidle");

  if (page.url().includes("/onboarding")) {
    await page.locator("#examDate").waitFor();
    await page.getByRole("button", { name: /开始诊断|保存并进入诊断/ }).click();
    await expect(page).toHaveURL(/\/diagnostic$/, { timeout: 30_000 });

    for (let guard = 0; guard < 40; guard += 1) {
      const progressText = await page.getByText(/第 \d+ \/ \d+ 题/).first().textContent();
      const match = progressText?.match(/第 (\d+) \/ (\d+) 题/);
      if (!match) break;
      const current = Number(match[1]);
      const total = Number(match[2]);

      const isPending = (await page.getByText(/音频素材待补/).count()) > 0;
      if (!isPending) {
        if (await hasChoices(page)) await chooseFirstOptionPerGroup(page);
        else if (await hasTextarea(page)) await page.locator("textarea").fill(SAMPLE_ESSAY);
      }

      if (current >= total) break;
      await page.getByRole("button", { name: "下一题" }).click();
    }

    await page.getByRole("button", { name: "提交诊断" }).click();
    await expect(page).toHaveURL(/\/diagnostic\/result$/, { timeout: 60_000 });
  }
}

test.describe("空私有内容库：诚实的空状态", () => {
  test("真题库显示空状态、说明内容目录位置，且不出现任何伪造试卷", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await onboardOnEmptyInstance(page);

    await page.goto(`${EMPTY}/practice/papers`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("h1").first()).toContainText("真题库");
    await expect(page.getByText("还没有导入任何试卷")).toBeVisible();
    // 必须如实说明这是真实状态而不是功能缺失
    await expect(page.getByText(/这是真实状态，不是功能缺失/)).toBeVisible();
    // 必须给出可操作的下一步与目录位置
    await expect(page.getByText("pnpm content:validate")).toBeVisible();
    await expect(page.getByText("pnpm content:import")).toBeVisible();
    /*
     * ── 这里曾经断言页面显示**当前实例真实使用的**绝对内容目录 ──
     *
     * 原断言（F-2 修复前）：
     *
     *     await expect(page.getByText(/not-created/)).toBeVisible();
     *     await expect(page.getByText(/cet6[\\/]papers/)).toBeVisible();
     *
     * 它要求服务层把 `getPapersDir()` 的本机绝对路径渲染进 HTML。独立评审
     * F-2 指出那是一条真实的泄漏面：盘符、用户名、安装位置因此进入浏览器，
     * 而 README 承诺"every path in the UI and in error messages is sanitised"。
     *
     * 换成**更强的一对判据**，而不是把断言删掉了事：
     *
     *   ① 产品级指引仍然在（用户知道该把文件放到内容根的哪个子目录）；
     *   ② 页面上**不存在任何**绝对路径形态 —— 不是"不含我们预期的那个"，
     *      而是"一个都不含"。第 ② 条比原断言更强：原断言只验证"显示了
     *      正确的路径"，新断言验证"任何路径都不显示"。
     *
     * 第 ② 条覆盖三种形态：Windows 盘符、POSIX 用户主目录、UNC。
     * 用 Playwright 拿到的 innerText 判定，因此它检查的是**渲染结果**，
     * 不是源码 —— 与 check-client-bundle 检查构建产物是同一条纪律。
     */
    const emptyStateText = await page.locator("body").innerText();
    // ① 产品级指引：内容根下的固定子路径。
    await expect(page.getByText(/cet6[\\/]?papers|private-content/).first()).toBeVisible();
    // ② 一个绝对路径都不许有。
    expect(emptyStateText, "空状态不得渲染 Windows 盘符绝对路径").not.toMatch(/[A-Za-z]:\\[^\s]+/);
    expect(emptyStateText, "空状态不得渲染 POSIX 用户主目录路径").not.toMatch(/\/(?:home|Users)\/[^\s]+/);
    expect(emptyStateText, "空状态不得渲染 UNC 路径").not.toMatch(/\\\\[^\s]+/);
    // ③ 本实例真实内容根的目录名不得出现（它是临时目录，名字随机）。
    //    这一条证明"配置值没有直传"，而不只是"我们选了不渲染它"。
    expect(emptyStateText).not.toContain("empty-content");
    await expect(page.getByText("docs/past-paper-package.md")).toBeVisible();

    // 关键断言：不得出现任何被当作真题展示的内容
    const body = await page.locator("body").innerText();
    expect(body, "空库不得出现伪造的试卷标题").not.toMatch(/\d{4} 年 \d+ 月/);
    expect(body).not.toContain("打开试卷");
    // 来源徽标级别的检查：页面上不存在标为"历年真题"的试卷。
    // 用 exact 匹配，避免误伤底部策略说明里的"训练内容优先使用真实历年真题"这句话
    // —— 那是产品声明，不是伪造的试卷。
    expect(await page.getByText("历年真题", { exact: true }).count()).toBe(0);
    expect(await page.getByText("测试夹具", { exact: true }).count()).toBe(0);
    // 没有任何指向试卷详情的链接
    expect(await page.locator('a[href^="/practice/papers/"]').count()).toBe(0);
    // 不得出现计数为 0 之外的筛选控件（空库不展示筛选）
    expect(await page.getByText("模考保留", { exact: true }).count()).toBe(0);
    expect(await page.getByText("训练池", { exact: true }).count()).toBe(0);

    await expectNoHorizontalOverflow(page, "empty papers desktop");
    await shot(page, "papers-empty-desktop");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("移动端空状态同样清晰且无横向溢出", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto(`${EMPTY}/practice/papers`);
    await page.waitForLoadState("networkidle");

    await expect(page.locator("h1").first()).toContainText("真题库");
    await expect(page.getByText("还没有导入任何试卷")).toBeVisible();
    await expectNoHorizontalOverflow(page, "empty papers mobile");
    await shot(page, "papers-empty-mobile");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("Practice 页在空库时如实说明需要自行导入，而不是显示 0 份并无解释", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${EMPTY}/practice`);
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1").first()).toContainText("练习");

    const librarySection = page.locator("section", { hasText: "真题库" }).first();
    await expect(librarySection).toBeVisible();
    await expect(librarySection).toContainText("还没有导入真题");
    await expect(librarySection).toContainText("0 份");

    // 不得暗示已有真题
    const text = await librarySection.innerText();
    expect(text).not.toContain("已导入");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("空库时直接访问不存在的试卷返回 404，而不是空壳页面", async ({ page }) => {
    const response = await page.goto(`${EMPTY}/practice/papers/fixture-does-not-exist`);
    await page.waitForLoadState("networkidle");
    expect(response?.status()).toBe(404);
  });
});
