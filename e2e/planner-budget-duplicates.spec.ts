import { expect, test } from "@playwright/test";
import {
  E2E_DUPLICATE_ALIAS_COUNT,
  E2E_DUPLICATE_BASE_URL,
  E2E_DUPLICATE_DAY_MINUTES,
} from "./config";
import { attachErrorCollectors, shotViewport } from "./helpers";

/**
 * 重复逾期别名不得把当天预算压空（浏览器级）。
 *
 * ── 为什么这条必须在浏览器上验 ──
 *
 * 缺陷的症状是**用户看到的数字**：库里有 N 条指向同一份真实材料的逾期历史条目时，
 * Today 的「计划占用」会被压得远低于「今天有多少时间」，
 * 甚至在内容明明充足时变成 0。
 *
 * 单元测试守的是服务层的量；这条守的是"学习者实际读到的那个数字"。
 * 服务层的量与界面读的量若各自漂移，单元测试全绿而用户仍然看到假数字。
 *
 * ── 与 `legacy-reading-convergence.spec.ts` 的关系 ──
 *
 * 那条 spec 断言 `计划占用 ≤ 可用时间`（防**虚高**）。
 * 本 spec 断言的是**反方向**：计划占用不得被压成不合理的低值（防**虚低**）。
 * 两者合起来才是完整的不变量 —— 只测一边会放过另一边的缺陷
 * （实测：修好虚高之后，过度预留制造了虚低）。
 *
 * ── 隐私 ──
 *
 * 本实例（3260）只读合成夹具内容根，不碰 `private-content/`，
 * 也不碰 `data/cet6.db`。默认 Playwright 配置下运行。
 */

const BASE = E2E_DUPLICATE_BASE_URL;

/** 把「1 小时 4 分」/「57 分钟」这类标签解析成分钟数。 */
function parseMinutes(label: string): number {
  const hours = /(\d+)\s*小时/.exec(label);
  const mins = /(\d+)\s*分/.exec(label);
  if (!hours && !mins) throw new Error(`无法从「${label}」解析分钟数`);
  return (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0);
}

interface Occupancy {
  available: number;
  planned: number;
}

async function readOccupancy(page: import("@playwright/test").Page): Promise<Occupancy> {
  const text = await page.locator("body").innerText();

  const availableMatch = /今天有多少时间\s*\n?\s*(\d+)/.exec(text);
  expect(availableMatch, "无法从页面解析可用分钟数").not.toBeNull();

  const occupancyMatch = /计划占用\s*\n?\s*([^\n]+)/.exec(text);
  expect(occupancyMatch, "无法从页面解析计划占用").not.toBeNull();

  return {
    available: Number(availableMatch![1]),
    planned: parseMinutes(occupancyMatch![1]),
  };
}

test.describe("重复逾期别名 · 当天预算不得被压空", () => {
  test("10 条指向同一目标的逾期别名：计划占用不得被压成空计划", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${BASE}/today`);
    await expect(page.getByRole("heading", { name: /距离考试还有 \d+ 天/ })).toBeVisible();

    const { available, planned } = await readOccupancy(page);

    // 可用时间被实例固定为 30 分钟（症状最极端的那一档）
    expect(available, "本实例的可用时间应为 30 分钟").toBe(E2E_DUPLICATE_DAY_MINUTES);

    /*
     * 上界：不得虚高（与 legacy spec 同一条不变量）。
     */
    expect(
      planned,
      `计划占用（${planned} 分钟）不得超过可用时间（${available} 分钟）`,
    ).toBeLessThanOrEqual(available);

    /*
     * ── 下界：不得把当天压成空计划（本 spec 的核心）──
     *
     * 库里确实有可训练的真实阅读大题，可用时间也是正常的当天预算，
     * 因此"计划占用 = 0"是**假的** —— 它意味着系统把同一份材料
     * 算成了 N 份，然后声称时间不够。
     *
     * 修复前实测：30 分钟日 + 10 条别名 ⇒ 计划占用 **0**。
     * 因此 `> 0` 在这条实例上是**因果紧致**的判据，不是随手挑的下界。
     */
    expect(
      planned,
      `可用 ${available} 分钟、库里有可训练真题，计划占用却是 ${planned} 分钟 —— ` +
        `${E2E_DUPLICATE_ALIAS_COUNT} 条重复别名把当天预算压空了`,
    ).toBeGreaterThan(0);
  });

  test("重复别名在清单里**可见**（不得靠删除历史条目让数字好看）", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/today`);
    await expect(page.getByRole("heading", { name: /距离考试还有 \d+ 天/ })).toBeVisible();

    /*
     * 多余的别名应显示为「与上一条同一部分」，而不是被静默丢弃。
     * 学习者有权知道自己还有这些历史条目。
     */
    const duplicateBadges = page.getByText("与上一条同一部分");
    await expect(
      duplicateBadges.first(),
      "重复别名应显示「与上一条同一部分」，而不是被悄悄丢掉",
    ).toBeVisible();

    const badgeCount = await duplicateBadges.count();
    expect(
      badgeCount,
      `应至少有 ${E2E_DUPLICATE_ALIAS_COUNT - 1} 条重复项可见`,
    ).toBeGreaterThanOrEqual(1);

    await shotViewport(page, "duplicate-01-today-not-starved");
  });

  test("页面无 pageerror / console error", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.goto(`${BASE}/today`);
    await expect(page.getByRole("heading", { name: /距离考试还有 \d+ 天/ })).toBeVisible();

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });
});
