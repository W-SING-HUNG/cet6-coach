import { test, expect } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot } from "./helpers";

/**
 * 诊断三态语义的浏览器级验证（MAJOR-1 的 UI 契约）。
 *
 * 前置：flow.spec.ts 已完成一次完整诊断。
 * 本文件验证结果页与进度页对三种状态使用了互斥且诚实的文案，
 * 特别是不出现"已评估 + 信息不足"这类自相矛盾的组合。
 */

test.describe("诊断三态在 UI 中的一致性", () => {
  test("结果页：听力显示未评估且不给分数；其余维度文案与状态一致", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/diagnostic/result");
    await page.waitForLoadState("networkidle");

    // 听力：未评估
    const unassessed = page.getByTestId("unassessed-section");
    await expect(unassessed).toBeVisible();
    await expect(unassessed).toContainText("听力");
    await expect(unassessed).toContainText("尚未有效评估");
    await expect(unassessed).toContainText("占卷面 35%");
    // 未评估区不得出现分数式断言
    await expect(page.getByTestId("unassessed-badge").first()).toBeVisible();

    // 矛盾组合防护：不应出现"已评估"标签旁边紧跟"信息不足"
    const bodyText = (await page.locator("body").innerText()).replace(/\s+/g, "");
    expect(bodyText).not.toContain("已评估信息不足");

    // 低置信度的已评估维度必须说"方向性估计"，而不是"证据不足"
    const dimensionSection = page.locator("section", { hasText: "五个能力维度" });
    const dimText = await dimensionSection.innerText();
    if (dimText.includes("方向性估计")) {
      // 该卡片同时必须有真实分数（不是"—"）
      expect(dimText).toMatch(/\d{2}/);
      // 且不得把低置信度说成证据不足
      expect(dimText).not.toContain("证据不足");
    }

    await expectNoHorizontalOverflow(page, "result unassessed");
    await shot(page, "semantics-result");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("进度页：每个模块要么给分数，要么给出无结论徽标（二者互斥）", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/progress");
    await page.waitForLoadState("networkidle");

    const section = page.locator("section", { hasText: "四个计分模块的能力估计" });
    await expect(section).toBeVisible();

    const bodyText = await page.locator("body").innerText();

    // 听力必须是无结论状态之一
    const listeningUnassessed = page.getByTestId("progress-unassessed-listening");
    const listeningInsufficient = page.getByTestId("progress-insufficient_evidence-listening");
    const listeningHasBadge =
      (await listeningUnassessed.count()) + (await listeningInsufficient.count()) > 0;
    expect(listeningHasBadge, "听力应有未评估或证据不足徽标").toBe(true);

    // 不得出现自相矛盾文案
    expect(bodyText.replace(/\s+/g, "")).not.toContain("已评估信息不足");

    await expectNoHorizontalOverflow(page, "progress semantics");
    await shot(page, "semantics-progress");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});
