import { test, expect } from "@playwright/test";
import { CET6_EXAM_DATE } from "@/domain/exam-facts";
import {
  SAMPLE_ESSAY,
  attachErrorCollectors,
  chooseFirstOptionPerGroup,
  expectNoHorizontalOverflow,
  hasChoices,
  hasTextarea,
  shot,
} from "./helpers";

/**
 * 关键用户路径 · 真实浏览器端到端验证。
 *
 * 全部通过 UI 操作完成，不直接调用 service / repository 完成业务状态。
 *
 * 数据隔离说明：
 * 本 spec 与 responsive / pwa 共用同一份**独立** E2E 数据库（见 e2e/config.ts），
 * 与日常开发库 data/cet6.db 完全隔离。Playwright 按文件顺序串行执行，
 * 本文件先跑（建立 onboarding + 诊断 + 完成任务），后续文件在此基础上验证布局与 PWA。
 * 单一 chromium project，viewport 在测试内部显式设定 —— 避免两个 project
 * 争用同一份状态而产生与布局无关的假失败。
 */

test.describe("关键路径：onboarding → diagnostic → result → Today → 提交任务 → reload", () => {
  test("完整流程真实可用", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);

    // ---------------------------------------------------------------- landing
    await page.goto("/");
    await expect(page).toHaveURL(/\/onboarding$/);
    await expect(page.getByRole("heading", { name: "先确认三件事" })).toBeVisible();

    // ---------------------------------------------------------------- onboarding
    // Finding 1：官方考试日期必须是默认值
    await expect(page.locator("#examDate")).toHaveValue(CET6_EXAM_DATE);
    // 中性默认值：不是本项目第一位使用者的私人目标分（曾硬编码为 550）。
    await expect(page.locator("#targetScore")).toHaveValue("500");

    // 工作日 60 / 周末 120 预选（MinuteChips 用 aria-pressed 表达选中态）
    await expect(page.locator('button[aria-pressed="true"]', { hasText: "60" }).first()).toBeVisible();
    await expect(page.locator('button[aria-pressed="true"]', { hasText: "120" }).first()).toBeVisible();

    await shot(page, "flow-01-onboarding");
    await expectNoHorizontalOverflow(page, "onboarding");

    await page.getByRole("button", { name: /开始诊断|保存并进入诊断/ }).click();
    await expect(page).toHaveURL(/\/diagnostic$/, { timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "能力诊断" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "diagnostic");

    // ---------------------------------------------------------------- diagnostic
    // 逐题作答直到最后一题。点击 label（真实用户行为）而不是 sr-only 的 radio input。
    for (let guard = 0; guard < 40; guard += 1) {
      const progressText = await page.getByText(/第 \d+ \/ \d+ 题/).first().textContent();
      const match = progressText?.match(/第 (\d+) \/ (\d+) 题/);
      if (!match) break;
      const current = Number(match[1]);
      const total = Number(match[2]);

      const isPending = (await page.getByText(/音频素材待补/).count()) > 0;
      if (!isPending) {
        if (await hasChoices(page)) {
          await chooseFirstOptionPerGroup(page);
        } else if (await hasTextarea(page)) {
          await page.locator("textarea").fill(SAMPLE_ESSAY);
        }
      }

      if (current >= total) break;
      await page.getByRole("button", { name: "下一题" }).click();
    }

    await shot(page, "flow-02-diagnostic");

    await page.getByRole("button", { name: "提交诊断" }).click();
    await expect(page).toHaveURL(/\/diagnostic\/result$/, { timeout: 60_000 });

    // ---------------------------------------------------------------- result
    await expect(page.getByRole("heading", { name: "你的能力画像" })).toBeVisible();

    // Finding 2：听力必须显示"尚未有效评估"，且不以任何形式给出分数或薄弱结论
    const unassessedSection = page.getByTestId("unassessed-section");
    await expect(unassessedSection).toBeVisible();
    await expect(unassessedSection).toContainText("听力");
    await expect(unassessedSection).toContainText("尚未有效评估");
    await expect(unassessedSection).toContainText("占卷面 35%");
    await expect(page.getByTestId("unassessed-badge").first()).toBeVisible();

    // 听力不得出现在薄弱项里
    const weaknessSection = page.locator("section", { hasText: "识别到的薄弱项" });
    await expect(weaknessSection).not.toContainText("听力信息抓取");

    await shot(page, "flow-03-diagnostic-result");
    await expectNoHorizontalOverflow(page, "diagnostic-result");

    // ---------------------------------------------------------------- Today
    await page.getByRole("link", { name: "去看今天的计划" }).click();
    await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });
    // 用 heading 角色限定：Next.js 的路由播报容器（#__next-route-announcer__，
    // role=alert）也会把新页面标题写进去，因此 `getByText(/距离考试还有 \d+ 天/)`
    // 会同时命中它和页面 <h1>，在严格模式下抛 strict mode violation。
    // 播报容器不是 heading，因此按 heading 定位可唯一命中。
    // （这是 SECURITY.md 隐私边界一节已登记的窄修正。）
    await expect(page.getByRole("heading", { name: /距离考试还有 \d+ 天/ })).toBeVisible();
    // 倒计时基于官方日期
    await expect(page.locator("body")).toContainText(CET6_EXAM_DATE);
    await expect(page.getByText("下一步")).toBeVisible();

    const beforeText = await page.getByText(/已完成 \d+ \/ \d+/).first().textContent();
    const beforeMatch = beforeText?.match(/已完成 (\d+) \/ (\d+)/);
    expect(beforeMatch, `无法解析 Today 进度文案：${beforeText}`).not.toBeNull();
    const completedBefore = Number(beforeMatch![1]);

    await shot(page, "flow-04-today");
    await expectNoHorizontalOverflow(page, "today");

    // ---------------------------------------------------------------- 开始任务
    /*
     * ── 本次收敛后这段路径的形态 ──
     *
     * 阅读训练现在**不再**走旧执行器：它的任务在 Today 上直接指向
     * `/practice/papers/{paperId}/train/{sectionId}`（真实真题的 Expert
     * Training 工作面）。该路径由 `zz-reading-convergence.spec.ts` 专门覆盖，
     * 包含 使用者 报告的那条精确路径。
     *
     * 本节继续覆盖**旧闭环**的完整可用性 —— 写作 / 翻译 / 复习 / 词汇
     * 仍然走 `/practice/[taskId]`，它们必须不受收敛影响。
     *
     * 判据用**任务行上的来源标记**：真实真题阅读任务现在带「真实历年真题」
     * 徽标，旧闭环任务没有。因此"取第一条不带该徽标的行"精确表达了
     * 真实意图 —— "旧闭环的任务点进去仍然可以作答并提交"。
     *
     * 这比"标题里含写作训练"稳：后者依赖"今天恰好排了写作任务"，
     * 而那是 planner 按权重与可用时间算出来的结果，不是产品承诺。
     */
    const legacyRow = page
      .locator("li")
      .filter({ has: page.getByRole("link", { name: "开始" }) })
      .filter({ hasNotText: "真实历年真题" })
      .first();
    await expect(legacyRow, "旧闭环应仍有一个可作答的任务").toBeVisible();
    await legacyRow.getByRole("link", { name: "开始" }).click();
    await expect(page).toHaveURL(/\/practice\/[^/]+$/, { timeout: 30_000 });

    if (await hasChoices(page)) {
      await chooseFirstOptionPerGroup(page);
    } else if (await hasTextarea(page)) {
      await page.locator("textarea").fill(SAMPLE_ESSAY);
    }

    await expectNoHorizontalOverflow(page, "practice-task");
    await shot(page, "flow-05-task");

    const submitButton = page.getByRole("button", { name: "提交作答" });
    await expect(submitButton).toBeEnabled();
    await submitButton.click();

    // 成功反馈（loading → success 状态链）
    await expect(page.getByText(/完成得不错|已经记录，继续加强/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("反馈")).toBeVisible();
    // 本地规则评分必须如实标注，不得冒充 AI
    await expect(page.getByText("本地规则评分").first()).toBeVisible();

    await shot(page, "flow-06-feedback");
    await expectNoHorizontalOverflow(page, "feedback");

    // ---------------------------------------------------------------- 返回 Today
    await page.getByRole("button", { name: "返回 Today" }).click();
    await expect(page).toHaveURL(/\/today$/, { timeout: 30_000 });

    const afterText = await page.getByText(/已完成 \d+ \/ \d+/).first().textContent();
    const afterMatch = afterText?.match(/已完成 (\d+) \/ (\d+)/);
    expect(afterMatch).not.toBeNull();
    const completedAfter = Number(afterMatch![1]);
    expect(completedAfter, `完成数未变化（${completedBefore} → ${completedAfter}）`).toBeGreaterThan(completedBefore);

    await shot(page, "flow-07-today-after");

    // ---------------------------------------------------------------- reload
    await page.reload();
    await expect(page.getByText(/距离考试还有 \d+ 天/)).toBeVisible({ timeout: 30_000 });

    const reloadText = await page.getByText(/已完成 \d+ \/ \d+/).first().textContent();
    const reloadMatch = reloadText?.match(/已完成 (\d+) \/ (\d+)/);
    expect(reloadMatch).not.toBeNull();
    expect(Number(reloadMatch![1]), "reload 后完成状态丢失").toBe(completedAfter);
    // 考试日期不漂移
    await expect(page.locator("body")).toContainText(CET6_EXAM_DATE);

    await shot(page, "flow-08-today-reloaded");

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });
});
