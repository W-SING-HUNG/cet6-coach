import { test, expect, type Page } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot, shotViewport } from "./helpers";
import { E2E_REAL_BASE_URL } from "./config";

/**
 * v2 视觉证据采集（真实试卷实例，端口 3210）。
 *
 * ── 为什么必须用**真实**试卷，而不是 E2E 夹具 ──
 * 夹具的篇章只有一句 "Fixture careful-reading passage."，题目只有
 * "Fixture question 46"。在那种内容下**无法评估布局**：分栏比例、
 * 长段落可读性、选项换行、词库换行、导航格子密度、滚动行为
 * 全都因为内容太短而看不出问题。
 *
 * 真实试卷的仔细阅读是两篇长文 + 各 5 题，选词填空是一篇 10 空的长文
 * + 15 项词库，长篇阅读是 15 段 + 10 条陈述 —— 只有在这些真实长度下，
 * "原文与题目并排、各自滚动"这个设计是否成立才能被真实检验。
 *
 * ── 数据与提交安全 ──
 * · 使用**独立数据库** `.e2e/cet6-real.db`（见 e2e-server-real.ts），
 *   绝不触碰日常库 data/cet6.db，也不修改 private-content 下的任何文件。
 * · **只读**：本文件不点交卷。原因不只是"安全"——真实试卷是有限资源，
 *   普通运行时不应因为跑一次视觉检查就把它变成"已完成"。因此不做提交，
 *   因此也不需要"再次训练"来恢复状态。
 * · 内容库为空 / 服务未启动时**整体跳过**（与 real-paper.local.spec.ts 同策略），
 *   因此在 fresh clone 上无害。
 *
 * ── 命名 ──
 * 截图统一以 `v2-` 前缀保存到 `.e2e/artifacts/screenshots/`，便于与
 * 夹具实例的截图区分（后者证明交互契约，前者证明真实内容下的布局）。
 *
 * ── 本文件**不**负责的页面 ──
 * `/today`、`/progress`、`/review`、`/settings` 的视觉证据来自主 E2E 实例
 * （`responsive.spec.ts` 产出的 `desktop-route-*.png` / `mobile-route-*.png`）。
 * 理由：真实试卷实例只完成 onboarding、不做诊断，因此那些页面会被重定向到
 * `/diagnostic`——用它们的名字保存诊断页截图是名不副实的证据。
 * 本文件的职责只有一件：采集**依赖真实长内容**才能评估的工作区界面。
 */

const BASE = process.env.CET6_REAL_BASE_URL ?? E2E_REAL_BASE_URL;

/** 本机真实试卷（结构标识，不是试题正文）。 */
const PAPER_ID = "cet6-2024-12-set1";

/**
 * 进入某阅读大题的**作答界面**（只读，不提交）。
 *
 * 大题可能处于三种状态，逐一处理：
 * 未开始 → 点「开始训练」；已完成 → 点「再练一次」；进行中 → 直接进入。
 * 整个过程不点交卷，因此不会消耗这份真实材料。
 */
async function openAnswering(page: Page, sectionKeyword: string): Promise<boolean> {
  await page.goto(`${BASE}/practice/papers/${PAPER_ID}`);
  const hrefs = await page
    .locator(`a[href^="/practice/papers/${PAPER_ID}/train/"]`)
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).getAttribute("href") ?? ""));
  const href = hrefs.find((item) => item.includes(sectionKeyword));
  if (!href) return false;

  await page.goto(`${BASE}${href}`);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await expect(page.locator("fieldset").first()).toBeVisible({ timeout: 6_000 });
      return true;
    } catch {
      /* 还没到作答界面：按当前屏的状态点进去 */
    }
    const again = page.getByRole("button", { name: /再练一次/ });
    const start = page.getByRole("button", { name: /开始训练/ });
    if ((await again.count()) > 0) await again.first().click();
    else if ((await start.count()) > 0) await start.first().click();
    else break;
  }
  try {
    await expect(page.locator("fieldset").first()).toBeVisible({ timeout: 20_000 });
    return true;
  } catch {
    return false;
  }
}

async function available(page: Page): Promise<boolean> {
  try {
    const response = await page.goto(`${BASE}/practice/papers/${PAPER_ID}`, {
      timeout: 5_000,
      waitUntil: "domcontentloaded",
    });
    return response?.status() === 200;
  } catch {
    return false;
  }
}

test.describe("v2 视觉证据：真实长篇章下的布局", () => {
  test.beforeEach(async ({ page }) => {
    const ok = await available(page);
    test.skip(!ok, "跳过视觉证据采集：真实试卷实例不可用（内容库为空或服务未启动）");
  });

  test("仔细阅读：桌面分栏下的真实长文与选项", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "careful")), "该卷未提供可作答的仔细阅读大题");

    await expectNoHorizontalOverflow(page, "real careful 1440");
    await shotViewport(page, "v2-real-01-careful-answering-1440");

    // 打开导航器
    await page.locator("button[aria-haspopup='dialog']").first().click();
    await expect(page.getByRole("dialog", { name: "题目导航" })).toBeVisible();
    await shotViewport(page, "v2-real-02-navigator-1440");
    await page.keyboard.press("Escape");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("仔细阅读：1024 与 390 下的同一界面", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 768 });
    test.skip(!(await openAnswering(page, "careful")), "该卷未提供可作答的仔细阅读大题");
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "real careful 1024");
    await shotViewport(page, "v2-real-03-careful-answering-1024");

    await page.setViewportSize({ width: 390, height: 844 });
    await page.reload();
    await expect(page.locator("fieldset").first()).toBeVisible({ timeout: 30_000 });
    await expectNoHorizontalOverflow(page, "real careful 390");
    await shotViewport(page, "v2-real-04-careful-mobile-question");

    // 移动端材料侧（分段切换的另一态）
    await page.getByRole("tab", { name: /查看原文/ }).click();
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeVisible();
    await expectNoHorizontalOverflow(page, "real careful 390 material");
    await shotViewport(page, "v2-real-05-careful-mobile-material");
  });

  test("选词填空：真实长文 + 15 项词库的并排布局", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "cloze")), "该卷未提供可作答的选词填空大题");

    // 真实结构必须暴露出来：空位标记与词库
    expect(await page.locator("[data-blank]").count(), "原文中应渲染空位标记").toBeGreaterThan(0);
    await expect(page.getByText(/词库共 \d+ 个词/)).toBeVisible();

    await expectNoHorizontalOverflow(page, "real cloze 1440");
    await shotViewport(page, "v2-real-06-banked-cloze-1440");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("长篇阅读：真实段落标号点选", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "matching")), "该卷未提供可作答的长篇阅读大题");

    await expect(page.getByText("这句话出自哪一个段落？")).toBeVisible();
    const labels = page.locator("fieldset label:has(input[type='radio'])");
    expect(await labels.count(), "长篇阅读应给出段落标号选项").toBeGreaterThan(5);

    await expectNoHorizontalOverflow(page, "real matching 1440");
    await shotViewport(page, "v2-real-07-matching-1440");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("交卷确认：真实题量下的未答提示", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "cloze")), "该卷未提供可作答的选词填空大题");

    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "确认交卷？" })).toBeVisible();
    await shotViewport(page, "v2-real-08-submit-confirm-1440");

    // 只关闭，不提交 —— 真实材料不被消耗
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "确认交卷？" })).toBeHidden();
  });

  /*
    说明：本文件**不采集** `/today` 的截图。
    理由：真实试卷实例（`e2e-server-real.ts`）只做 onboarding，**不做诊断**，
    因此 `/today` 会重定向到 `/diagnostic` —— 拍出来的是诊断页，
    用 Today 的名字保存它是名不副实的证据。
    Today / Practice / Progress / Review 的视觉证据由主 E2E 实例提供
    （`responsive.spec.ts` 的 `desktop-route-*.png`），那个实例完成了完整诊断。
    这里只采集**依赖真实长内容**的工作区界面 —— 那是夹具内容无法评估的部分。
  */
  test("练习与真题库：真实内容下的宽画布", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${BASE}/practice`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("真题库").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, "real practice 1440");
    await shot(page, "v2-real-09-practice-1440");

    await page.goto(`${BASE}/practice/papers`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("历年真题", { exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page, "real papers 1440");
    await shot(page, "v2-real-10-papers-1440");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});
