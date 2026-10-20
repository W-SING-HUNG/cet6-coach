import { test, expect, type Page } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot } from "./helpers";
import { E2E_FIXTURE_PAPERS } from "./config";

/**
 * Expert Training V1：真实真题阅读训练的浏览器级验证。
 *
 * 覆盖任务要求的完整闭环：
 *   open real paper → start reading training → answer → submit → feedback → persisted history
 *
 * 前置条件：flow.spec.ts 已完成 onboarding 与诊断（Playwright 按文件顺序串行执行），
 * 且 e2e-server 已把夹具试卷导入独立内容根的索引。
 *
 * 数据诚实性：本文件出现的试卷全部是 `test_fixture`（夹具构造器写死来源类型）。
 * 测试夹具是**合成软件夹具**，与面向学习者的内容政策不冲突 ——
 * 它只存在于 E2E 内容根（.e2e/content），从不出现在生产内容路径里
 * （见 content-policy/PRODUCT_PRINCIPLES.md 第 6.1 节）。
 *
 * ── 断言设计约束 ──
 * 只断言**结构与状态**（控件是否存在、按钮是否可用、结果区是否出现、
 * 统计分项是否齐全），不断言"某题答案是 B"之类的具体内容。
 * 这样测试不会因夹具内容变化而假红，也避免把题目答案写进可提交文件。
 */

const PAPER_ID = E2E_FIXTURE_PAPERS[1].id; // 2024-12 set1

/**
 * 作答当前这一屏上的题。
 *
 * ── v1 → v2 的机制变化（断言强度不变）──
 * v1 把整卷题目渲染在一个长表单里，因此"作答全部题"就是遍历页面上所有控件。
 * v2 改为**一次一题**（这正是本次产品目标），所以要把"作答全部题"实现为
 * **逐题作答 + 翻到下一题**。测试的意图与断言强度完全相同：
 * 仍然是"每题都给出一个非空作答，然后交卷"。
 *
 * 三种阅读题型在 v2 里统一为**点选**（选项 / 段落标号 / 词库词），
 * 不再有文本输入框 —— 因此这里只处理 label+radio。
 *
 * 返回实际作答的题数。
 */
async function answerEverything(page: Page): Promise<number> {
  let answered = 0;

  for (let guard = 0; guard < 60; guard += 1) {
    const labels = page.locator("fieldset label:has(input[type='radio'])");
    if ((await labels.count()) > 0) {
      await labels.first().click();
      answered += 1;
    }

    const next = page.getByRole("button", { name: "下一题" }).first();
    if ((await next.count()) === 0) break;
    const disabled = await next.isDisabled();
    if (disabled) break;
    await next.click();
  }

  return answered;
}

/** 从真题库进入指定阅读大题的训练页。 */
async function gotoTraining(page: Page, index: number): Promise<void> {
  await page.goto(`/practice/papers/${PAPER_ID}`);
  const trainLinks = page.locator(`a[href*="/train/"]`);
  await expect(trainLinks.first()).toBeVisible();
  await trainLinks.nth(index).click();
  await expect(page).toHaveURL(/\/train\/[^/]+$/);
}

/**
 * 每条测试用**不同的大题**（阅读三题型正好三个）。
 *
 * 为什么必须这样：同一次 E2E 运行内多个测试共享同一数据库。
 * 若两条测试操作同一个大题，第一条提交后第二条进入的就是**已完成**页面
 * （结果视图，没有作答控件），测试会因为"找不到控件"而失败 ——
 * 那是测试之间互相污染，不是产品缺陷。用独立大题让每条测试自足。
 */
const SECTION_INDEX = {
  cloze: 0,
  matching: 1,
  careful: 2,
} as const;

/** 如果当前在开始屏，点"开始训练"进入作答界面。 */
async function ensureAnswering(page: Page): Promise<void> {
  const start = page.getByRole("button", { name: /开始训练/ });
  if ((await start.count()) > 0) {
    await start.first().click();
    await expect(page.getByText("进行中", { exact: false }).first()).toBeVisible();
  }
}

test.describe("真实真题阅读训练：开始 → 作答 → 交卷 → 反馈 → 历史", () => {
  test("试卷详情页为阅读大题提供可用的训练入口", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`/practice/papers/${PAPER_ID}`);

    // 阅读三题型各有"开始训练"
    const trainLinks = page.locator(`a[href*="/train/"]`);
    expect(await trainLinks.count(), "阅读三个大题都应有开始训练入口").toBe(3);

    // 听力不得有训练入口（它不在 V1 可训练范围）
    expect(await page.locator(`a[href*="/train/"][href*="listening"]`).count()).toBe(0);

    await expectNoHorizontalOverflow(page, "paper detail with training entry");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("开始屏说清会发生什么，且尚未作答时没有结果区（答案未泄漏）", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // 本条**只读**：只进入开始屏，不点开始、不提交，因此不会占用大题
    await gotoTraining(page, SECTION_INDEX.cloze);

    // 未开始时是明确的开始屏，不是空白也不是死按钮
    await expect(page.getByRole("button", { name: /开始训练/ }).first()).toBeVisible();
    await expect(page.getByText("交卷之前不会显示答案", { exact: false }).first()).toBeVisible();

    // 关键：尚未作答时不得出现**结果区**。
    // 注意判据不能用 `getByText("正确答案")` —— 开始屏的说明文字里
    // 正当提到了"正确答案"这个词（"交卷后给出…与正确答案"），
    // 那会把说明文案误判为答案泄漏。真正要禁的是结果区的存在。
    await expect(page.getByText("逐题结果", { exact: false })).toHaveCount(0);
    await expect(page.getByText("这份结果怎么读", { exact: false })).toHaveCount(0);
    // 结果里才有的分项统计
    await expect(page.getByText(/未作答 \d+/)).toHaveCount(0);

    await expectNoHorizontalOverflow(page, "training start screen");
    await shot(page, "training-01-start");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("完整流程：作答 → 交卷 → 确定性反馈 → 结果来自服务端", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await gotoTraining(page, SECTION_INDEX.careful);
    await ensureAnswering(page);

    // 真实刺激材料已渲染（材料来自试卷包模型）
    await expect(page.getByText(/材料来自这份真题|按真题原样作答/).first()).toBeVisible();

    const answered = await answerEverything(page);
    expect(answered, "作答界面没有任何可交互的作答控件").toBeGreaterThan(0);

    // 已作答题数可见
    await expect(page.getByText(/已作答 \d+ \/ \d+/).first()).toBeVisible();

    // 交卷 → 必须经过确认步骤（交卷不可撤回，不能一键误触）
    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await expect(page.getByText("确认交卷？", { exact: false }).first()).toBeVisible();
    await page.getByRole("button", { name: /确认交卷/ }).click();

    // 结果区出现：逐题结果 + 三种结论分项 + 诚实性说明
    await expect(page.getByText("逐题结果", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("这份结果怎么读", { exact: false }).first()).toBeVisible();
    await expect(page.getByText(/正确 \d+/).first()).toBeVisible();
    await expect(page.getByText(/错误 \d+/).first()).toBeVisible();
    await expect(page.getByText(/未作答 \d+/).first()).toBeVisible();
    await expect(page.getByText(/正确答案/).first()).toBeVisible();

    // 已提交后不能再交卷
    await expect(page.getByRole("button", { name: /确认交卷/ })).toHaveCount(0);

    await expectNoHorizontalOverflow(page, "training result");
    await shot(page, "training-02-result");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("移动端可用：无横向溢出，作答控件可点", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 390, height: 844 });

    // 用还没提交过的大题，确保验证的是**作答界面**而不是结果视图
    await gotoTraining(page, SECTION_INDEX.matching);
    await expectNoHorizontalOverflow(page, "training mobile start");

    await ensureAnswering(page);
    await expectNoHorizontalOverflow(page, "training mobile answering");

    const interactive =
      (await page.locator("label:has(input[type='radio'])").count()) +
      (await page.locator("input[type='text']").count());
    expect(interactive, "移动端没有可作答的控件").toBeGreaterThan(0);

    // 交卷入口在移动端也必须可达
    await expect(page.getByRole("button", { name: "交卷", exact: true })).toBeVisible();

    // 真的能选一个选项（移动端点击不被遮挡）
    const firstLabel = page.locator("label:has(input[type='radio'])").first();
    if ((await firstLabel.count()) > 0) {
      await firstLabel.click();
      await expect(page.getByText(/已作答 \d+ \/ \d+/).first()).toBeVisible();
    }

    await shot(page, "training-04-mobile");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("再练一次真的进入**新的作答会话**（不只是建了一行数据）", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // 用 matching 大题（本条之外只有"刷新后历史仍在"会占用它，而那条
    // 已经提交完；这里再练一次会新建会话，因此不冲突）
    await gotoTraining(page, SECTION_INDEX.matching);
    await ensureAnswering(page);
    await answerEverything(page);
    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page.getByRole("button", { name: /确认交卷/ }).click();
    await expect(page.getByText("逐题结果", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    // 点"再练一次"
    await page.getByRole("button", { name: /再练一次/ }).click();

    // **关键断言**：必须真的进入作答界面 ——
    // 而不是停留在旧结果上（这正是修复前的缺陷：新会话已创建，
    // 但页面状态查询返回旧的已完成会话，用户看到的是上一轮结果）。
    await expect(page.getByText("进行中", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("逐题结果", { exact: false })).toHaveCount(0);

    // 作答控件真的在，且是空白的（新会话，没有沿用上一轮答案）
    const interactive =
      (await page.locator("label:has(input[type='radio'])").count()) +
      (await page.locator("input[type='text']").count());
    expect(interactive, "新会话里没有可作答的控件").toBeGreaterThan(0);
    await expect(page.getByText(/已作答 0 \/ \d+/).first()).toBeVisible();

    // 交卷入口可用（不是已被提交的状态）
    await expect(page.getByRole("button", { name: "交卷", exact: true })).toBeVisible();

    await expectNoHorizontalOverflow(page, "training restarted");
    await shot(page, "training-05-restart");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("刷新后历史仍在（结果来自已落库的事实，不依赖客户端状态）", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // 本测试**自足**：自己完成一次提交，不依赖前一条测试的副作用。
    // 使用独立的大题，避免与其它测试争用同一份会话状态。
    await gotoTraining(page, SECTION_INDEX.matching);
    await ensureAnswering(page);
    const answered = await answerEverything(page);
    expect(answered).toBeGreaterThan(0);

    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page.getByRole("button", { name: /确认交卷/ }).click();
    await expect(page.getByText("逐题结果", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    const url = page.url();

    // 硬刷新：结果必须重新从服务端读回来
    await page.reload();
    await expect(page.getByText("逐题结果", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("已完成", { exact: false }).first()).toBeVisible();

    // 重新进入同一 URL（模拟"关掉浏览器明天再来"）后仍然能看到
    await page.goto(url);
    await expect(page.getByText("逐题结果", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    await expectNoHorizontalOverflow(page, "training history after reload");
    await shot(page, "training-03-history");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("重复提交被服务端拒绝：结果不翻倍，也不提供再交卷入口", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // cloze 大题在"开始屏"那条测试里只被查看过、从未提交，因此这里可以安全地占用它
    await gotoTraining(page, SECTION_INDEX.cloze);
    await ensureAnswering(page);
    const answered = await answerEverything(page);
    expect(answered).toBeGreaterThan(0);
    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page.getByRole("button", { name: /确认交卷/ }).click();
    await expect(page.getByText("逐题结果", { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    const before = Number(
      /(\d+)\s*\/\s*(\d+)/.exec(await page.getByText(/\d+\/\d+/).first().innerText())?.[2] ?? "0",
    );
    expect(before).toBeGreaterThan(0);

    // 返回再进入：已完成的大题应当直接显示结果，不再提供交卷
    await gotoTraining(page, SECTION_INDEX.cloze);
    await expect(page.getByText("逐题结果", { exact: false }).first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: "交卷", exact: true })).toHaveCount(0);

    // 题数没有翻倍
    const after = Number(
      /(\d+)\s*\/\s*(\d+)/.exec(await page.getByText(/\d+\/\d+/).first().innerText())?.[2] ?? "0",
    );
    expect(after).toBe(before);

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("Today 上有真实真题训练的入口，且可直接进入训练", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/today");

    /*
     * ── 本次收敛（评审 F2）之后，这个入口的形态变了 ──
     *
     * 早先断言的是「真实真题 · 随时可做」这个**独立次强调块**。
     * 但主导动作（"下一步"）本身已经是一条真实真题阅读训练时，
     * 那个块会指向同一个目标 —— 两个入口同目的地、不同文案，
     * 正是 F2 要消除的重复。因此它现在**不再渲染**。
     *
     * 契约没有变弱，只是落点变了：Today 仍然必须有真实真题训练入口
     * （指向 canonical `/practice/papers/.../train/...`），
     * 且点进去直达训练页。这里改为断言那个**统一的**入口本身。
     */
    const readingEntry = page.locator('a[href^="/practice/papers/"][href*="/train/"]');
    await expect(readingEntry.first(), "Today 应有真实真题训练入口").toBeVisible();
    // 不再有重复的独立块
    await expect(page.getByText("真实真题 · 随时可做")).toHaveCount(0);

    await readingEntry.first().click();
    await expect(page).toHaveURL(/\/practice\/papers\/[^/]+\/train\/[^/]+$/);

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});
