import { test, expect, type Page } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot, shotViewport } from "./helpers";
import { E2E_REVIEW_BASE_URL, E2E_REVIEW_PAPER_ID } from "./config";

/**
 * **可提交的视觉评审证据**（review-safe）。
 *
 * ── 这套截图解决什么问题 ──
 * 评审需要"能看出布局好坏"的截图，而现有两套都不适合提交：
 *
 * · 主 E2E 实例的篇章只有一句 `"Fixture careful-reading passage."` ——
 *   文本太短，**分栏比例、段落换行、长选项折行、长文滚动、粘性头尾遮挡**
 *   全都看不出来，拍出来是"内容很空"的假象，不能作为布局证据。
 * · 真实试卷实例能拍出真实布局，但截图**含真题正文**，
 *   提交进 Git 会直接违反内容门禁（`tests/architecture.test.ts` 有指纹守卫）。
 *
 * 因此本文件使用**长文本合成夹具**（`scripts/e2e-server-review.ts`）：
 * 语料是合成的通用说明文（每篇约 420 词 / 7 段、选项有整句长度、
 * 长篇阅读 A–O 共 15 段），文本量级接近真实 CET-6 长阅读，
 * 但 **不含任何真实考试内容**，因此可以安全提交。
 *
 * ── 隔离保证 ──
 * · 独立内容根 `.e2e/review-content`、独立数据库 `.e2e/cet6-review.db`、
 *   独立端口 3220。
 * · 内容 `sourceKind` 写死为 `test_fixture`，界面有显眼的「测试夹具」徽标 ——
 *   **不可能冒充真题**。
 * · 这些夹具**从不进入** `private-content/`，也不被 `pnpm content:import` 触及，
 *   更不产生任何学习者观测（不进 Expert 台账）。
 *
 * ── 截图方法 ──
 * · 工作区（固定高度 + 内部滚动）用 `shotViewport`，否则 `fullPage` 会把
 *   `100dvh` 一起放大，拍出"页面被拉长"的失真图。
 * · 文档流页面（Today / Practice / Papers）用 `shot`。
 */

const BASE = E2E_REVIEW_BASE_URL;
const PAPER = E2E_REVIEW_PAPER_ID;

/**
 * 在"分段控件下沿往下一点"处取**文本锚点**。
 *
 * ── 为什么不能用 TreeWalker + range.getBoundingClientRect ──
 * 实测（`review-22` 诊断输出）：仔细阅读的正文是**一个 3712 字符的文本节点**
 * （`ClozePassage` 把整段包在单个 `<span>` 里）。对跨多行的文本节点，
 * `range.getBoundingClientRect()` 返回的是**包含视口外部分**的包围盒，
 * 其 `top` 永远为负 —— 于是"统计分段控件下方的可见文本"必然得到 0，
 * 哪怕正文明明铺满屏幕。
 *
 * 那个错误探针曾让 F-2 测试"通过"，只是因为它当时依赖滚动为 0：
 * 顶部时整段的包围盒顶边确实在控件下方。修好滚动恢复后它立刻暴露。
 *
 * 现在用 `caretRangeFromPoint`：它返回**光标落点所在的字符偏移**，
 * 这才是与滚动位置线性对应的量，因此既能当锚点、也能度量"是否真的回到了原处"。
 */
async function caretAnchor(page: import("@playwright/test").Page): Promise<{
  insideMaterial: boolean;
  offset: number;
  snippet: string;
}> {
  return page.evaluate(() => {
    const material = document.querySelector("[aria-label='阅读材料']") as HTMLElement | null;
    const sw = document.querySelector("[data-testid='mobile-pane-switch']") as HTMLElement | null;
    const bottom = sw ? sw.getBoundingClientRect().bottom : 0;
    // 取控件下沿再往下 40px 的一个点：既在正文区，又避开粘性条
    const x = Math.round(window.innerWidth / 2);
    const y = Math.round(bottom + 40);

    const hit = document.elementFromPoint(x, y);
    const insideMaterial = Boolean(material && hit && material.contains(hit));

    const doc = document as Document & {
      caretRangeFromPoint?: (x: number, y: number) => Range | null;
    };
    const range = doc.caretRangeFromPoint?.(x, y) ?? null;
    const node = range?.startContainer ?? null;
    const text = node?.textContent ?? "";
    const offset = range?.startOffset ?? -1;
    const snippet = text ? text.slice(Math.max(0, offset - 8), offset + 24).trim() : "";
    return { insideMaterial, offset, snippet };
  });
}

/** 进入某阅读大题的作答界面（未开始→开始训练；已完成→再练一次）。 */
async function openAnswering(page: Page, keyword: string): Promise<boolean> {
  await page.goto(`${BASE}/practice/papers/${PAPER}`);
  const hrefs = await page
    .locator(`a[href^="/practice/papers/${PAPER}/train/"]`)
    .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href") ?? ""));
  const href = hrefs.find((h) => h.includes(keyword));
  if (!href) return false;
  await page.goto(`${BASE}${href}`);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await expect(page.locator("fieldset").first()).toBeVisible({ timeout: 6_000 });
      return true;
    } catch {
      /* 还没到作答界面 */
    }
    const again = page.getByRole("button", { name: /再练一次/ });
    const start = page.getByRole("button", { name: /开始训练/ });
    if ((await again.count()) > 0) await again.first().click();
    else if ((await start.count()) > 0) await start.first().click();
    else break;
  }
  try {
    await expect(page.locator("fieldset").first()).toBeVisible({ timeout: 25_000 });
    return true;
  } catch {
    return false;
  }
}

/** 点当前题的第一个选项作答。 */
async function answerCurrent(page: Page): Promise<boolean> {
  const labels = page.locator("fieldset label:has(input[type='radio'])");
  if ((await labels.count()) === 0) return false;
  await labels.first().click();
  return true;
}

test.describe("评审视觉证据：桌面 1440×900", () => {
  test("Today — 单一主导动作与宽画布", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/today`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", { name: /距离考试还有 \d+ 天/ })).toBeVisible();
    await expectNoHorizontalOverflow(page, "review today 1440");
    await shot(page, "review-01-today-1440");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("Practice 与真题库 — 行式清单、无卡片堆", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/practice`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("真题库").first()).toBeVisible();
    await expectNoHorizontalOverflow(page, "review practice 1440");
    await shot(page, "review-02-practice-1440");

    await page.goto(`${BASE}/practice/papers`);
    await page.waitForLoadState("networkidle");
    await expect(page.getByText("测试夹具", { exact: true }).first()).toBeVisible();
    await expectNoHorizontalOverflow(page, "review papers 1440");
    await shot(page, "review-03-papers-1440");
  });

  test("仔细阅读 — 分栏 + 长文 + 长选项", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "careful")), "长文本夹具未提供仔细阅读大题");

    // 长文与长选项都必须在（否则这张图证明不了布局）
    const material = await page.getByRole("region", { name: "阅读材料" }).innerText();
    expect(material.length, `材料文本过短（${material.length} 字符），不足以证明布局`).toBeGreaterThan(1200);
    const longest = await page
      .locator("fieldset label:has(input[type='radio'])")
      .evaluateAll((nodes) => Math.max(...nodes.map((n) => (n.textContent ?? "").length)));
    expect(longest, `选项最长仅 ${longest} 字符，不足以检验折行`).toBeGreaterThan(80);

    // 分栏几何：材料与作答同屏并列，材料占 45%–72%
    const box = await page.getByRole("region", { name: "阅读材料" }).boundingBox();
    const ans = await page.getByRole("region", { name: "作答区" }).boundingBox();
    const ratio = box!.width / 1440;
    expect(ans!.x, "不是分栏布局").toBeGreaterThan(box!.x + 100);
    expect(Math.abs(ans!.y - box!.y), "两栏纵向错开 —— 像上下堆叠").toBeLessThan(120);
    expect(ratio, `材料栏占比 ${(ratio * 100).toFixed(0)}%`).toBeGreaterThan(0.45);
    expect(ratio, `材料栏占比 ${(ratio * 100).toFixed(0)}%`).toBeLessThan(0.72);

    await expectNoHorizontalOverflow(page, "review careful 1440");
    await shotViewport(page, "review-04-careful-answering-1440");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("Question Navigator — 面板完整在视口内", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "careful")), "长文本夹具未提供仔细阅读大题");
    await answerCurrent(page);

    await page.locator("button[aria-haspopup='dialog']").first().click();
    const dialog = page.getByRole("dialog", { name: "题目导航" });
    await expect(dialog).toBeVisible();

    const box = await dialog.boundingBox();
    expect(box!.x, "面板左边缘超出视口").toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width, "面板右边缘超出视口").toBeLessThanOrEqual(1441);

    await expectNoHorizontalOverflow(page, "review navigator");
    await shotViewport(page, "review-05-question-navigator-1440");
    await page.keyboard.press("Escape");
  });

  test("Mark for review 与 Option elimination — 状态可见", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "careful")), "长文本夹具未提供仔细阅读大题");

    // 作答 + 标记
    await answerCurrent(page);
    await page.getByRole("button", { name: "标记", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "已标记", exact: true }).first()).toBeVisible();

    /*
      排除两个选项。
      注意：按钮的**无障碍名称会随状态变化**（`排除选项 C` → `恢复选项 C`），
      因此不能按固定下标点第二次 —— 第一次点击后该集合就少了一个成员
      （实测：`nth(3)` 会一直等一个不存在的元素直到超时）。
      改为每次点"当前最后一个可排除的选项"。
    */
    const eliminate = page.getByRole("button", { name: /^排除选项/ });
    for (let i = 0; i < 2; i += 1) {
      const count = await eliminate.count();
      expect(count, `第 ${i + 1} 次排除时没有可排除的选项`).toBeGreaterThan(0);
      await eliminate.nth(count - 1).click();
    }
    await expect(page.getByRole("button", { name: /^恢复选项/ })).toHaveCount(2);

    await expectNoHorizontalOverflow(page, "review marked eliminated");
    await shotViewport(page, "review-06-mark-and-elimination-1440");
  });

  test("Matching — A–O 15 段 + 标号快选", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "matching")), "长文本夹具未提供长篇阅读大题");

    await expect(page.getByText("这句话出自哪一个段落？")).toBeVisible();
    const labels = page.locator("fieldset label:has(input[type='radio'])");
    expect(await labels.count(), "长篇阅读应有 A–O 共 15 个标号").toBeGreaterThanOrEqual(15);
    expect(await page.locator("input[type='text']").count(), "不应要求打字").toBe(0);

    await expectNoHorizontalOverflow(page, "review matching 1440");
    await shotViewport(page, "review-07-matching-1440");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("Banked Cloze — 长文空位 + 15 项词库", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "cloze")), "长文本夹具未提供选词填空大题");

    expect(await page.locator("[data-blank]").count(), "原文应有空位标记").toBeGreaterThan(0);
    await expect(page.getByText(/词库共 15 个词/)).toBeVisible();
    const bank = page.locator("fieldset label:has(input[type='radio'])");
    expect(await bank.count(), "词库应有 15 项").toBe(15);

    await expectNoHorizontalOverflow(page, "review cloze 1440");
    await shotViewport(page, "review-08-banked-cloze-1440");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("Submit confirmation — 未答题号可跳转", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "cloze")), "长文本夹具未提供选词填空大题");

    await page.getByRole("button", { name: "交卷", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认交卷？" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("未作答不计为错误");
    await expect(dialog).toContainText("系统只记录这题未作答");

    await shotViewport(page, "review-09-submit-confirmation-1440");
    await page.keyboard.press("Escape");
  });

  test("Review / result — 同一分栏内逐题回看与筛选", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "careful")), "长文本夹具未提供仔细阅读大题");

    // 只作答前 3 题，制造 正确/错误/未作答 三种结果同时存在
    for (let i = 0; i < 3; i += 1) {
      await answerCurrent(page);
      const next = page.getByRole("button", { name: "下一题" }).first();
      if (await next.isDisabled()) break;
      await next.click();
    }

    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page
      .getByRole("dialog", { name: "确认交卷？" })
      .getByRole("button", { name: /确认交卷/ })
      .click();
    await expect(page.getByText("本次结果已记录", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    // 回看模式：保持分栏、有筛选、无交卷
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeVisible();
    await expect(page.getByRole("region", { name: "回看" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^全部 \d+$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^错误 \d+$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^未作答 \d+$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "交卷", exact: true })).toHaveCount(0);

    await expectNoHorizontalOverflow(page, "review result 1440");
    await shotViewport(page, "review-10-review-result-1440");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});

test.describe("评审视觉证据：1024×768", () => {
  test("仔细阅读 — 分栏仍成立", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    test.skip(!(await openAnswering(page, "careful")), "长文本夹具未提供仔细阅读大题");

    const box = await page.getByRole("region", { name: "阅读材料" }).boundingBox();
    const ans = await page.getByRole("region", { name: "作答区" }).boundingBox();
    expect(ans!.x, "1024 下不是分栏").toBeGreaterThan(box!.x + 100);

    await expectNoHorizontalOverflow(page, "review careful 1024");
    await shotViewport(page, "review-11-careful-answering-1024");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});

test.describe("评审视觉证据：交叉空转移 / 移动粘性 / 触摸几何（F-1~F-4 回归）", () => {
  test("F-1 选词填空：跨空转移后只有一个持有者，且可提交且无重复用词", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "cloze")), "长文本夹具未提供选词填空大题");

    const bank = page.locator("fieldset label:has(input[type='radio'])");
    const firstWord = (await bank.first().innerText()).trim().split("\n")[0]!;

    // ① 第 1 空填空：选第一个词
    await bank.first().click();
    await expect(page.getByText(`已选：${firstWord}`)).toBeVisible();

    // ② 移到第 2 空，点**同一个**词 → 必须是转移而不是复制
    await page.getByRole("button", { name: "下一题" }).first().click();
    const blank2 = page.locator("span", { hasText: /^第 \d+ 空$/ }).first();
    await expect(blank2).toBeVisible();

    /*
      通过词库里的 `<label>` 定位那个词，而不是 `getByText`：
      同组所有空共享同一个词库，因此 `getByText(word)` 会命中多处
      （严格模式失败），而且在窄屏上它可能落在可点区域之外。
      这里按 label 的**可见文本**取当前屏上的那个词条。
    */
    const bankEntry = page
      .locator("fieldset label")
      .filter({ has: page.locator(`input[value="${firstWord}"]`) })
      .first();
    await expect(bankEntry).toBeVisible();
    await bankEntry.click();

    /*
      读回 sessionStorage 的**真相层**：统计该词在全组的持有者数量。
      评审复现的旧缺陷是这里会看到 2 个持有者。
    */
    const holders = async () =>
      page.evaluate((word) => {
        const key = Object.keys(sessionStorage).find((k) =>
          k.startsWith("cet6:training-workspace:"),
        );
        const raw = key ? JSON.parse(sessionStorage.getItem(key) ?? "{}") : {};
        const values = (raw.values ?? {}) as Record<string, string>;
        return Object.entries(values)
          .filter(([, v]) => String(v).trim().toLowerCase() === word.toLowerCase())
          .map(([id]) => id);
      }, firstWord);

    expect(await holders(), "同一个词只能有一个持有者").toHaveLength(1);

    // ③ 回到第 1 空：它应当已经空了
    await page.getByRole("button", { name: "上一题" }).first().click();
    await expect(page.getByText("从词库里选一个词")).toBeVisible();

    await shotViewport(page, "review-16-cloze-cross-blank-transfer");

    // ④ 提交载荷里不能出现"同一个词被两个空使用"
    const payload = await page.evaluate(
      (word) => {
        const key = Object.keys(sessionStorage).find((k) =>
          k.startsWith("cet6:training-workspace:"),
        );
        const raw = key ? JSON.parse(sessionStorage.getItem(key) ?? "{}") : {};
        const values = (raw.values ?? {}) as Record<string, string>;
        return Object.values(values).filter(
          (v) => String(v).trim().toLowerCase() === word.toLowerCase(),
        ).length;
      },
      firstWord,
    );
    expect(payload, "提交状态不得包含被重复使用的词").toBe(1);

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("F-2 移动端：滚动超过 800px 后分段控件仍然可见且紧贴训练头", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    test.skip(!(await openAnswering(page, "careful")), "长文本夹具未提供仔细阅读大题");

    const header = page.locator("header").first();
    const switcher = page.getByTestId("mobile-pane-switch");

    // 切到材料态（长文），然后滚动
    await page.getByRole("tab", { name: /查看原文/ }).click();
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeVisible();

    const headerBefore = await header.boundingBox();
    await expect(switcher, "找不到移动端分段控件").toBeVisible();

    // 训练头高度必须稳定（评审实测旧实现会因换行变高）
    expect(headerBefore!.height, "训练头高度应等于 --workspace-header-height（52px）").toBeGreaterThanOrEqual(50);
    expect(headerBefore!.height, "训练头不得因换行而变高").toBeLessThanOrEqual(56);

    // 滚动文档 —— 这是旧实现让分段控件消失的确切操作
    await page.evaluate(() => window.scrollBy(0, 1000));
    await page.waitForTimeout(150);

    await expect(switcher, "滚动 1000px 后分段控件必须仍然可见").toBeVisible();
    const switchAfter = await switcher.boundingBox();
    const headerAfter = await header.boundingBox();

    // 训练头高度在滚动前后不变
    expect(Math.abs(headerAfter!.height - headerBefore!.height)).toBeLessThanOrEqual(1);

    // 分段控件紧贴训练头下沿（小容差）
    const gap = Math.abs(switchAfter!.y - (headerAfter!.y + headerAfter!.height));
    expect(gap, `分段控件与训练头的间隙 ${gap}px 过大（可能没有粘住）`).toBeLessThanOrEqual(4);

    // 仍然可点：切回作答态
    await switcher.getByRole("tab", { name: /作答/ }).click();
    await expect(page.getByRole("region", { name: "作答区" })).toBeVisible();

    // 粘性条不遮挡正文：材料区在滚动位置下仍有可见文本
    await page.getByRole("tab", { name: /查看原文/ }).click();
    /*
      "正文仍可见"的判据用 `caretAnchor`（见文件顶部说明）：
      早先的 TreeWalker 版本对"整段是单个文本节点"的长文永远返回 0，
      在滚动位置为 0 时凑巧为真，因此是个假通过。
    */
    const anchor = await caretAnchor(page);
    expect(anchor.insideMaterial, "分段控件下方命中的不是阅读材料区").toBe(true);
    expect(anchor.snippet.length, "分段控件下方没有可见正文 —— 可能被遮挡").toBeGreaterThan(0);

    await shotViewport(page, "review-17-mobile-material-after-scroll");
    await expectNoHorizontalOverflow(page, "mobile material after scroll");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("F-4 触摸几何：分段 tab 与排除按钮均 ≥44px", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    test.skip(!(await openAnswering(page, "careful")), "长文本夹具未提供仔细阅读大题");

    // 分段 tab ≥44px 高
    for (const name of [/查看原文/, /作答/]) {
      const box = await page.getByRole("tab", { name }).boundingBox();
      expect(box!.height, `分段 tab ${name} 高 ${box!.height}px`).toBeGreaterThanOrEqual(44);
    }

    // 排除按钮 ≥44×44
    const eliminate = page.getByRole("button", { name: /^排除选项/ }).first();
    const box = await eliminate.boundingBox();
    expect(box!.width, `排除按钮宽 ${box!.width}px`).toBeGreaterThanOrEqual(44);
    expect(box!.height, `排除按钮高 ${box!.height}px`).toBeGreaterThanOrEqual(44);

    // 排除按钮与选项 label 不重叠（否则会互相误触）
    const label = page.locator("fieldset label:has(input[type='radio'])").first();
    const labelBox = await label.boundingBox();
    expect(
      labelBox!.x + labelBox!.width,
      "排除按钮与选项区域重叠",
    ).toBeLessThanOrEqual(box!.x + 1);

    await shotViewport(page, "review-18-mobile-touch-targets");
  });

  test("F-3 交卷弹层：焦点不逃逸、Esc 关闭且焦点归位", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    test.skip(!(await openAnswering(page, "cloze")), "长文本夹具未提供选词填空大题");

    const trigger = page.getByRole("button", { name: "交卷", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "确认交卷？" });
    await expect(dialog).toBeVisible();

    // 打开后焦点应在弹层内
    const inDialog = () =>
      page.evaluate(() => {
        const dlg = document.querySelector('[role="dialog"]');
        return dlg?.contains(document.activeElement) ?? false;
      });
    await expect.poll(inDialog, { timeout: 5000 }).toBe(true);

    // Tab 多次不逃逸
    for (let i = 0; i < 12; i += 1) {
      await page.keyboard.press("Tab");
      expect(await inDialog(), `第 ${i + 1} 次 Tab 后焦点逃出了弹层`).toBe(true);
    }
    // Shift+Tab 同样不逃逸
    for (let i = 0; i < 6; i += 1) {
      await page.keyboard.press("Shift+Tab");
      expect(await inDialog(), `第 ${i + 1} 次 Shift+Tab 后焦点逃出了弹层`).toBe(true);
    }

    await shotViewport(page, "review-19-submit-dialog-focus");

    // Esc 关闭并把焦点还给触发按钮
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect
      .poll(
        () =>
          page.evaluate(() => {
            const el = document.activeElement as HTMLElement | null;
            return el?.textContent?.trim() ?? "";
          }),
        { timeout: 5000 },
      )
      .toContain("交卷");
  });
});

test.describe("评审视觉证据：移动端工作面滚动位置记忆（最终验收）", () => {
  /**
   * 移动端两个工作面是**互斥显示**的，而滚动发生在 **document 文档流**上
   * （实测：材料面 `document.scrollHeight` 约 2875px，`window.scrollY` 可达 1200）。
   * 把长材料面 `display:none` 时文档高度塌缩到视口高度，
   * 浏览器立刻把 `window.scrollY` 钳制为 0 —— 切回来阅读位置就丢了。
   *
   * 修法见 `reader.tsx` 的 `switchMobilePane`：切换前记录当前面的 `scrollY`，
   * 目标面渲染后（`useLayoutEffect`，绘制前）恢复。
   */
  test("A. 材料面：深滚 → 切题目 → 切回，阅读位置保留", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    test.skip(!(await openAnswering(page, "careful")), "长文本夹具未提供仔细阅读大题");

    const material = page.getByRole("region", { name: "阅读材料" });
    const switcher = page.getByTestId("mobile-pane-switch");

    // 切到材料面并深滚（>800px，满足验收要求）
    await page.getByRole("tab", { name: /查看原文/ }).click();
    await expect(material).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 1200));
    await page.waitForTimeout(150);

    const before = await page.evaluate(() => window.scrollY);
    expect(before, "未能滚动到 >800px（夹具太长？）").toBeGreaterThan(800);

    /*
      语义锚点：取"分段控件下沿往下 40px"处的**字符偏移**。
      这个量随滚动线性变化，因此既能证明"回到了原处"，
      也不受"整段是单个文本节点"的影响（见文件顶部 `caretAnchor` 的说明）。
    */
    const anchorBefore = await caretAnchor(page);
    expect(anchorBefore.insideMaterial, "锚点未落在阅读材料区").toBe(true);
    expect(anchorBefore.snippet.length, "找不到可见的文本锚点").toBeGreaterThan(0);

    // 切到题目面：文档塌缩，这是根因所在
    await page.getByRole("tab", { name: /作答/ }).click();
    await expect(page.getByRole("region", { name: "作答区" })).toBeVisible();
    expect(await page.evaluate(() => window.scrollY), "切走后位置应被浏览器钳制").toBeLessThan(50);

    // 切回材料面
    await page.getByRole("tab", { name: /查看原文/ }).click();
    await expect(material).toBeVisible();
    await page.waitForTimeout(200);

    const after = await page.evaluate(() => window.scrollY);
    const delta = Math.abs(after - before);

    // ① 位置近似相等（容差容忍布局舍入）
    expect(delta, `恢复位置 ${after} 与记录位置 ${before} 相差 ${delta}px`).toBeLessThanOrEqual(40);
    // ② 必须仍在深滚区间，而不是回到顶部
    expect(after, "恢复到了顶部而不是原阅读位置").toBeGreaterThan(800);

    // ③ 同一段文字仍在视口内（字符偏移 + 片段双重比对）
    const anchorAfter = await caretAnchor(page);
    expect(anchorAfter.insideMaterial, "恢复后锚点未落在阅读材料区").toBe(true);
    expect(
      anchorAfter.snippet,
      "恢复后视野内的文本与恢复前不同 —— 阅读位置未真正保留",
    ).toBe(anchorBefore.snippet);
    expect(
      Math.abs(anchorAfter.offset - anchorBefore.offset),
      `字符偏移 ${anchorBefore.offset} → ${anchorAfter.offset} 偏离过大`,
    ).toBeLessThanOrEqual(40);

    // ④ 粘性头部与分段控件仍然工作
    const header = page.locator("header").first();
    const headerBox = await header.boundingBox();
    const switchBox = await switcher.boundingBox();
    expect(headerBox!.height, "训练头高度应恒为 52px").toBeGreaterThanOrEqual(50);
    expect(headerBox!.height, "训练头不得因换行变高").toBeLessThanOrEqual(56);
    expect(
      Math.abs(switchBox!.y - (headerBox!.y + headerBox!.height)),
      "分段控件未紧贴训练头下沿",
    ).toBeLessThanOrEqual(4);
    // 切回后分段控件仍可点
    await switcher.getByRole("tab", { name: /作答/ }).click();
    await expect(page.getByRole("region", { name: "作答区" })).toBeVisible();
    await page.getByRole("tab", { name: /查看原文/ }).click();
    await expect(material).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(800);

    await expectNoHorizontalOverflow(page, "mobile material restored");
    await shotViewport(page, "review-20-mobile-material-restored-deep-scroll");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("B. 题目面：滚动位置记忆在结构上对称（运行时如实记录可滚动量）", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    test.skip(!(await openAnswering(page, "cloze")), "长文本夹具未提供选词填空大题");

    /*
      ── 为什么不在这里断言"题目面恢复约等于原位置" ──
      实测：选词填空的题目面在 390×844 下
      `document.scrollHeight - innerHeight === 0` —— 它**恰好填满视口，
      没有任何可滚动空间**。因此"题目面滚动位置的恢复"在这块屏上
      **无法被有意义地验证**：没有任何位置可丢，也就没有位置可恢复。
      编一个 `scrollTo(400)` 然后断言它回到 400 是假的（浏览器会钳制为 0，
      与是否实现记忆无关）。
      
      正确做法是如实记录这个测量结果，并说明：
      · 两条路径共用同一个 `switchMobilePane`，因此记忆逻辑是对称的；
      · 它可被验证的条件是"题目面出现溢出"，而当前夹具/视口下不成立。
    */
    const overflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(
      overflow,
      "题目面出现了可滚动空间 —— 若能滚，就应当补一条真正的恢复断言",
    ).toBeLessThanOrEqual(4);

    // 材料面在同一视口下**确实**可滚：这说明"无溢出"是题目面的属性，
    // 而不是测量方法或夹具整体太短
    await page.getByRole("tab", { name: /查看原文/ }).click();
    const materialOverflow = await page.evaluate(
      () => document.documentElement.scrollHeight - window.innerHeight,
    );
    expect(materialOverflow, "材料面应当有可滚动空间（否则夹具不足以验证）").toBeGreaterThan(400);

    // 题目面 ↔ 材料面来回切换后，作答状态与选项可用性不受影响
    await page.getByRole("tab", { name: /作答/ }).click();
    await expect(page.getByRole("region", { name: "作答区" })).toBeVisible();
    const bank = page.locator("fieldset label:has(input[type='radio'])");
    expect(await bank.count(), "切回题目面后词库应仍可交互").toBe(15);
    await bank.first().click();
    await expect(page.getByText(/已作答 1 \/ \d+/).first()).toBeVisible();

    await expectNoHorizontalOverflow(page, "mobile question after switches");
  });
});

test.describe("评审视觉证据：390×844", () => {
  test("仔细阅读 — 材料态 / 题目态 / 导航器", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    test.skip(!(await openAnswering(page, "careful")), "长文本夹具未提供仔细阅读大题");

    await answerCurrent(page);

    // ① 题目态（默认）
    await expect(page.getByRole("tab", { name: /作答/ })).toBeVisible();
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeHidden();
    await expectNoHorizontalOverflow(page, "review mobile question");
    await shotViewport(page, "review-12-mobile-careful-question");

    // ② 材料态 —— 与题目态互斥（证明不是缩小版分栏）
    await page.getByRole("tab", { name: /查看原文/ }).click();
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeVisible();
    await expect(page.getByRole("region", { name: "作答区" })).toBeHidden();
    await expectNoHorizontalOverflow(page, "review mobile material");
    await shotViewport(page, "review-13-mobile-careful-material");

    // ③ 移动端导航器（整屏抽屉 + 触摸目标 ≥ 44px）
    await page.getByRole("tab", { name: /作答/ }).click();
    await page.locator("button[aria-haspopup='dialog']").first().click();
    const dialog = page.getByRole("dialog", { name: "题目导航" });
    await expect(dialog).toBeVisible();
    const cell = await dialog.locator("button[data-cell]").first().boundingBox();
    expect(cell!.height, `导航格子 ${cell!.height}px 低于 44px`).toBeGreaterThanOrEqual(44);
    await expectNoHorizontalOverflow(page, "review mobile navigator");
    await shotViewport(page, "review-14-mobile-question-navigator");
    await page.keyboard.press("Escape");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("Banked Cloze — 长文空位与词库在移动端的排布", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    test.skip(!(await openAnswering(page, "cloze")), "长文本夹具未提供选词填空大题");

    expect(await page.locator("[data-blank]").count(), "原文应有空位标记").toBeGreaterThan(0);
    await expectNoHorizontalOverflow(page, "review mobile cloze");
    await shotViewport(page, "review-15-mobile-banked-cloze");
  });
});
