import { test, expect, type Page } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shotViewport } from "./helpers";
import {
  E2E_LEGACY_BASE_URL,
  E2E_LEGACY_PAPER_ID,
  E2E_LEGACY_RESERVED_BASE_URL,
  E2E_LEGACY_SYNTHETIC_BODY,
  E2E_LEGACY_SYNTHETIC_CONTENT_ID,
  E2E_LEGACY_SYNTHETIC_TITLE,
} from "./config";

/**
 * 阅读训练收敛 · **使用者 真实历史状态**的端到端验证。
 *
 * ── 使用者 报告的现象（本次改动的起点）──
 *
 * 打开 Today 的阅读任务，看到「补做：阅读训练 12 分钟」，
 * 点进去是一个标题为「为什么城市需要树」的窄居中文章页 ——
 * 那是 `src/content/practice-library.ts` 里的**合成**篇目，不是任何真题。
 *
 * ── 本文件为什么只用独立实例（评审 F5）──
 *
 * 验收对象是 使用者 库里的**真实形态**：一条更早生成、至今 pending、
 * `contentRef` 指向合成篇章的历史阅读任务。主 E2E 实例（3199）**没有**这个对象 ——
 * planner 现在产出的全是 `reading_target`；而且它的库被全部 spec 共享、
 * 按文件名字母序串行执行，因此早先的写法只能靠 `zz-` 前缀把本 spec 排到最后。
 * 那是**顺序依赖**，不是契约：单独跑、或先于其它 spec 跑，前提就不成立。
 *
 * 现在改用两个**专用实例**（`scripts/e2e-server-legacy.ts`），它们在启动时
 * 就把那条历史行写死：
 *
 * - `3230` eligible：库里有可训练的真实阅读大题
 * - `3231` reserved_only：卷子全部设为模考保留
 *
 * 因此本文件与其它 spec **零共享状态**，单跑 / 先跑 / 后跑结果相同。
 * 文件名也刻意不再用 `zz-` 前缀 —— 顺序不再是正确性的一部分。
 *
 * ── 数据诚实性 ──
 *
 * 两个实例写入的试卷都由夹具构造器生成，`sourceKind` 恒为 `test_fixture`，
 * 面内文字是明显的夹具文本，**不含任何真题正文**。
 * 因此本文件产出的截图可以安全提交进 Git。
 */

const ELIGIBLE = E2E_LEGACY_BASE_URL;
const RESERVED_ONLY = E2E_LEGACY_RESERVED_BASE_URL;

/** canonical 真实真题训练路由（pathname 形态）。 */
const CANONICAL_TRAIN_ROUTE = /^\/practice\/papers\/[^/]+\/train\/[^/]+$/;

/** 直连 URL 验证用的阅读大题（夹具卷里必然存在的一个）。 */
const LEGACY_SECTION = "reading.careful_reading";

/**
 * Today 主导区内那条历史阅读任务的链接。
 *
 * 判据是"链接指向真实真题工作面且不是 Button 样式"（那是主导 CTA 的形态），
 * 这样无论它此刻呈现在主导动作还是任务清单里，都能被稳定定位。
 */
function legacyReadingLinks(page: Page) {
  return page.locator('a[href^="/practice/papers/"][href*="/train/"]');
}

/** 断言合成篇目的标题与正文都不在页面上。 */
async function expectNoSyntheticContent(page: Page, label: string) {
  const body = await page.locator("body").innerText();
  expect(body, `${label}：合成篇目「${E2E_LEGACY_SYNTHETIC_TITLE}」不得出现`).not.toContain(
    E2E_LEGACY_SYNTHETIC_TITLE,
  );
  expect(body, `${label}：合成篇目正文不得出现`).not.toContain(E2E_LEGACY_SYNTHETIC_BODY);
  await expect(page.getByText(E2E_LEGACY_SYNTHETIC_TITLE)).toHaveCount(0);
}

test.describe("阅读收敛 · 历史状态（独立实例，无顺序依赖）", () => {
  test.use({ baseURL: ELIGIBLE });

  test("F1+F2 · 历史合成任务在 Today 上已经呈现 truthful 真实真题 CTA，且只有一个阅读入口", async ({
    page,
  }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${ELIGIBLE}/today`);
    await expect(page.getByRole("heading", { name: /距离考试还有 \d+ 天/ })).toBeVisible();

    // ---------------------------------------------------------------- F1
    /*
     * 关键断言 0：**那条历史任务真的进入了今天**。
     *
     * ── 为什么必须显式断言它（实测踩到的坑）──
     *
     * 本实例的存在意义就是复现 使用者的状态。但早先的种子脚本先跑了
     * `seed-diagnostic`（它会为今天生成计划），而 `ensurePlan` 在
     * "当天已有计划"时直接返回既有计划 —— 于是**补做逻辑根本没跑**，
     * 那条历史任务压根没进 Today。
     *
     * 那时 E2E 仍然"通过"了：它断言的是 planner 自己排出来的真实阅读任务。
     * 那证明的是"新任务被投影正确"，**不是** 使用者的路径
     * （"引用合成篇章的历史任务被投影正确"）。两者是不同的对象 ——
     * 这正是截图复核（F3）发现的：图上 Today 里没有那条历史任务。
     *
     * ── 判据为什么用 rationale ──
     *
     * 补做任务的**标题**会被投影改写（这正是 F1 要做的），因此"补做"这两个字
     * 不再出现在标题里。但 planner 为 tier 1 生成的 **rationale** 是稳定的
     * 领域文案（"之前安排了但没有完成的核心训练"），且投影**不修改 rationale**
     * —— 它是"为什么今天有这条任务"的事实说明，不是素材描述。
     */
    await expect(
      page.getByText("之前安排了但没有完成的核心训练", { exact: false }).first(),
      "历史未完成的核心任务必须进入 Today 的补做区（否则本 spec 没有复现该历史状态）",
    ).toBeVisible();

    // 那条补做任务必须是**真实真题**阅读训练（F1 的核心），
    // 且不得再暴露历史合成素材的标题
    const makeupRow = page
      .locator("li")
      .filter({ hasText: "之前安排了但没有完成的核心训练" })
      .first();
    await expect(makeupRow).toContainText("真实真题");
    await expect(makeupRow).not.toContainText("阅读训练 12 分钟");

    /*
     * 关键断言 1：**点击之前**页面就已经说清目的地是真实真题。
     *
     * 使用者 看到的旧形态是「补做：阅读训练 12 分钟」—— 它既没说清目的地
     * 是真题，那个 "12 分钟" 也属于早已作废的合成素材语义。
     * 现在历史行被投影成当前 canonical 目标，标题来自真实卷次与大题。
     */
    const primary = page.getByRole("region", { name: "接下来做什么" });
    await expect(primary).toBeVisible();

    const primaryHeading = primary.getByRole("heading").first();
    await expect(primaryHeading, "主导标题必须标明这是真实真题训练").toContainText("真实真题");
    // 不得再暴露历史合成素材的措辞
    await expect(primaryHeading).not.toContainText("阅读训练 12 分钟");

    // 主导区里唯一的阅读入口必须指向 canonical 路由
    const primaryReadingLinks = primary.locator('a[href*="/train/"]');
    await expect(primaryReadingLinks.first()).toBeVisible();
    const primaryHref = await primaryReadingLinks.first().getAttribute("href");
    expect(primaryHref, "历史任务必须投影为 canonical 真实真题路由").toMatch(CANONICAL_TRAIN_ROUTE);

    // "真实历年真题" 徽标可见（来源类型对学习者透明）
    await expect(primary.getByText("真实历年真题").first()).toBeVisible();

    // ---------------------------------------------------------------- F2
    /*
     * 关键断言 2：**主导区内只有一个阅读动作**。
     *
     * 评审指出的重复是这两个：
     *   A. 主导动作（"下一步" / "补做：阅读训练 12 分钟"）
     *   B. 同容器里的「真实真题 · 随时可做」块
     * 两者指向同一个目的地，却挂着不同文案 —— 学习者要先做一次无意义的取舍。
     *
     * 修法是：主导动作已经是真实真题阅读训练时，**不再渲染 B**。
     * 判据只取主导区，不取整页 —— 因为「今天的任务」清单里本来就会列出
     * 同一条任务（那是 Product UI V2 既有的、已验收的结构：
     * 主导动作是某一项的高亮，清单是全部任务的盘点）。
     * 把清单行也算成"重复入口"会误伤那个设计。
     */
    await expect(
      primary.getByText("随时可做"),
      "主导动作已是真实真题阅读训练时，不得再渲染「随时可做」入口（F2）",
    ).toHaveCount(0);

    const primaryReadingHrefs = await primary
      .locator('a[href*="/train/"]')
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href") ?? ""));

    // 主导区里恰好一个阅读动作，且是 canonical 路由
    expect(primaryReadingHrefs.length, "主导区应恰好有一个阅读动作").toBe(1);
    expect(primaryReadingHrefs[0]).toMatch(CANONICAL_TRAIN_ROUTE);
    // 且它就是上面那条主导标题
    expect(await primaryReadingHrefs[0]).toBe(primaryHref);

    await expectNoSyntheticContent(page, "Today（eligible）");
    await shotViewport(page, "legacy-01-today-truthful-cta");

    /*
     * ── 计划占用不得谎报（F8 的边界）──
     *
     * "计划占用"是学习者用来判断"今天做不做得完"的数字。它必须只统计
     * **可单独执行的**工作量：
     * · 同一 canonical 目标的重复项只算一次（界面本来就不给第二个 CTA）；
     * · 不可执行的投影阅读任务不计入。
     *
     * 修复前实测出现过"计划占用 1 小时 4 分"而可用时间只有 60 分钟 ——
     * 那句数字是用户办不到的，因此是假的。
     *
     * 判据是**数值比较**：从页面把两个时长解析成分钟再比。
     *
     * ── 定位为什么用"整页文本 + 正则" ──
     *
     * "今天有多少时间"的可用分钟数是**裸数字**（`{shown}`）加一个独立的
     * 「分钟」span —— 它不是「60 分钟」这样的整串。我先后试过文本正则与
     * `span` 过滤，都在这个面板上超时（实测三次）。
     *
     * 整页 `innerText` 一次就能拿到，且这两个标签在页面里各自唯一，
     * 因此用正则从整页文本里取比逐层定位 DOM 更可靠。
     */
    const parseMinutes = (label: string): number => {
      const hours = /(\d+)\s*小时/.exec(label);
      const mins = /(\d+)\s*分/.exec(label);
      if (!hours && !mins) throw new Error(`无法从「${label}」解析分钟数`);
      return (hours ? Number(hours[1]) * 60 : 0) + (mins ? Number(mins[1]) : 0);
    };

    const pageText = await page.locator("body").innerText();

    // 可用分钟数：标题之后出现的第一个数字
    const availableMatch = /今天有多少时间\s*\n?\s*(\d+)/.exec(pageText);
    expect(availableMatch, "无法从页面解析可用分钟数").not.toBeNull();
    const available = Number(availableMatch![1]);

    // 计划占用：该标签之后到行尾的内容（形如「57 分钟」）
    const occupancyMatch = /计划占用\s*\n?\s*([^\n]+)/.exec(pageText);
    expect(occupancyMatch, "无法从页面解析计划占用").not.toBeNull();
    const planned = parseMinutes(occupancyMatch![1]);

    expect(available, "可用时间应可解析出正值").toBeGreaterThan(0);
    expect(
      planned,
      `计划占用（${planned} 分钟）不得超过可用时间（${available} 分钟）—— 否则那句数字是假的`,
    ).toBeLessThanOrEqual(available);

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("F1 续 · 点击历史任务直达 canonical Expert 工作区，合成内容全程缺席", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${ELIGIBLE}/today`);
    const link = legacyReadingLinks(page).first();
    await expect(link).toBeVisible();

    // 记下点击前的 URL，证明这**不是**旧执行器
    const beforeHref = await link.getAttribute("href");
    expect(beforeHref).not.toMatch(/^\/practice\/[^/]+$/);

    await link.click();
    await page.waitForURL(/\/practice\/papers\/[^/]+\/train\/[^/]+$/);

    const url = new URL(page.url());
    expect(url.pathname, "必须落在 canonical Expert Training 路由上").toMatch(CANONICAL_TRAIN_ROUTE);
    // 绝不能是旧的合成练习执行器
    expect(url.pathname).not.toMatch(/^\/practice\/[^/]+$/);

    // 这一页必须说清它练的是真题的某个阅读大题
    await expect(page.getByText(/阅读 · /).first()).toBeVisible();

    // 可能的两种状态（未开始 / 已完成、或进行中直接接管）都能进入工作区
    const startButton = page.getByRole("button", { name: /开始训练/ });
    const retryButton = page.getByRole("button", { name: /再练一次/ });
    const material = page.getByRole("region", { name: "阅读材料" });
    const answer = page.getByRole("region", { name: "作答区" });

    if ((await startButton.count()) > 0) {
      await expect(page.getByText("交卷之前不会显示答案", { exact: false }).first()).toBeVisible();
      await startButton.first().click();
    } else if ((await retryButton.count()) > 0) {
      await retryButton.first().click();
    }

    // ---------------------------------------------------------------- 沉浸式工作区
    await expect(material, "应进入沉浸式作答工作区（材料面）").toBeVisible({ timeout: 30_000 });
    await expect(answer, "应进入沉浸式作答工作区（作答面）").toBeVisible();
    await expect(page.getByRole("button", { name: "交卷", exact: true })).toBeVisible();

    // 沉浸式外壳：不渲染应用导航
    await expect(page.getByRole("navigation", { name: "主导航" })).toHaveCount(0);

    /*
     * 分栏几何：桌面 1440 下材料与作答**并排**，而不是上下堆叠的长文。
     * 这正是"旧的合成路径把材料与题目堆成一条竖排窄长文"的反面。
     */
    const materialBox = await material.boundingBox();
    const answerBox = await answer.boundingBox();
    expect(materialBox!.y, "材料与作答应并排（top 相同）").toBeCloseTo(answerBox!.y, 0);
    expect(materialBox!.x, "材料面在左").toBeLessThan(answerBox!.x);

    /*
     * F6-2 回归：导航 chip 不得再用 `N / M` 这种把两个计数体系
     * （官方题号 / 组内序）并排的歧义写法。
     */
    const navigatorChip = page.locator("button[aria-haspopup='dialog']").first();
    if ((await navigatorChip.count()) > 0) {
      const chipText = (await navigatorChip.innerText()).replace(/\s+/g, " ").trim();
      expect(chipText, `导航 chip 文案应含「第 N 题」，实际：${chipText}`).toContain("第");
      expect(chipText).toContain("题");
    }

    await expectNoSyntheticContent(page, "Expert 工作区");
    await expectNoHorizontalOverflow(page, "legacy convergence workspace");
    await shotViewport(page, "legacy-02-expert-workspace");

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("F5 · reserved_only：全部模考保留时给出**具体**原因，且绝不消耗保留材料", async ({
    page,
  }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${RESERVED_ONLY}/today`);
    await expect(page.getByRole("heading", { name: /距离考试还有 \d+ 天/ })).toBeVisible();

    /*
     * 关键断言：历史阅读任务在这里**不可用**，而且原因必须说明
     * "卷子被设为模考保留" —— 材料明明在库里，笼统的"暂无内容"
     * 会让用户以为功能坏了（这正是 `explainNoReadingTarget` 的三分诊断）。
     */
    const body = await page.locator("body").innerText();
    expect(body, "必须说明具体原因是模考保留").toContain("模考保留");
    expect(body, "必须解释为什么保留（后面要做模考）").toContain("没做过");

    // 绝不消耗保留材料：不得提供任何指向该卷训练的入口
    const trainLinks = page.locator('a[href*="/train/"]');
    expect(
      await trainLinks.count(),
      "模考保留的卷子绝不能被当成日常训练材料（不得出现训练入口）",
    ).toBe(0);

    // 也不得回退合成内容
    await expectNoSyntheticContent(page, "Today（reserved_only）");

    /*
     * 不可用时**不得再展示历史合成素材的标题与时长**（F1 的同一条理由）。
     *
     * ── 判据必须落在**那条不可用的补做任务**上，不是整页 ──
     *
     * 这一页上确实还会出现「阅读训练 12 分钟」—— 那是**已完成**的历史任务，
     * F9 明确要求它保持历史原貌（它当时做的不是真题）。
     * 因此"整页不含该字符串"是**过强**的断言：它会误伤那条正确的历史呈现。
     *
     * 要禁止的是：那条**不可用**的任务（投影失败的历史 pending 任务）
     * 继续用历史合成语义呈现自己。
     */
    const unavailableRow = page
      .locator("li")
      .filter({ hasText: "之前安排了但没有完成的核心训练" })
      .first();
    await expect(unavailableRow, "不可用的补做任务应可见").toBeVisible();
    await expect(
      unavailableRow,
      "不可用的历史任务不得再暴露合成素材的标题与时长",
    ).not.toContainText("阅读训练 12 分钟");
    await expect(unavailableRow, "不可用时不得显示任何时长").not.toContainText("12 分钟");

    await shotViewport(page, "legacy-03-reserved-only-unavailable");

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("F7 · Practice 计划区使用同一套投影字段，不再显示历史合成语义", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${ELIGIBLE}/practice`);
    await expect(page.getByRole("heading", { name: "今天计划里的训练" })).toBeVisible();

    /*
     * 关键断言：Practice 的"今天计划里的训练"里，那条历史任务必须
     * 以**投影后**的措辞出现 —— 它与 Today 说的是同一件事。
     *
     * 修前它显示「补做：阅读训练 12 分钟」（原始任务字段），
     * 而点下去的其实是某个真题大题 —— 同一个数据源，两页两套话。
     */
    const planSection = page.locator("section", { hasText: "今天计划里的训练" });
    await expect(planSection).toContainText("真实真题");
    await expect(
      planSection,
      "Practice 不得再把历史合成语义当作当前阅读任务展示",
    ).not.toContainText("阅读训练 12 分钟");

    // 那条投影任务在 Practice 上的时长必须与 Today 一致（真实目标的排练预算 7 分钟）
    const planText = await planSection.innerText();
    expect(planText, "Practice 应显示投影后的排练预算").toContain("7 分钟");

    // 不出现重复的第二条独立入口（同 canonical 目标只给一个动作）
    const startLinks = await planSection
      .locator("a[href*='/train/']")
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href") ?? ""));
    const unique = new Set(startLinks);
    expect(unique.size, `Practice 出现了重复的阅读目标入口：${startLinks.join(", ")}`).toBe(
      startLinks.length,
    );

    await expectNoHorizontalOverflow(page, "practice planned section");
    await shotViewport(page, "legacy-04-practice-projected");

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("F9 · 已完成的历史合成阅读保持历史原貌，不被伪装成真题", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`${ELIGIBLE}/today`);
    await expect(page.getByRole("heading", { name: /距离考试还有 \d+ 天/ })).toBeVisible();

    /*
     * 那条已完成的历史合成任务在"今天的任务"里以**历史原貌**出现：
     * 标题仍是「阅读训练 12 分钟」，且**不得**带真实真题来源徽标。
     *
     * 它必须与那条被收敛的 pending 历史任务形成对比 ——
     * 后者显示「真实真题阅读训练 · ...」，前者显示历史标题。
     */
    const completedRow = page
      .locator("li")
      .filter({ hasText: "阅读训练 12 分钟" })
      .first();
    await expect(
      completedRow,
      "已完成的历史合成任务必须以其历史标题出现（它当时做的不是真题）",
    ).toBeVisible();
    await expect(completedRow).toContainText("已完成");
    // 关键：它**不得**被标为真实真题
    await expect(
      completedRow,
      "已完成的历史合成任务不得显示真实真题来源徽标",
    ).not.toContainText("真实历年真题");

    // 也不得提供任何"去练真题"的动作
    expect(
      await completedRow.locator("a[href*='/train/']").count(),
      "已完成的历史合成任务不得提供真题训练入口",
    ).toBe(0);

    await expectNoSyntheticContent(page, "Today（已完成历史任务所在页）");
    await shotViewport(page, "legacy-05-completed-historical-fact");

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("F9 · 直接访问已完成的历史任务 URL：如实呈现已完成，不被重定向进 Expert", async ({
    page,
  }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    /*
     * 白盒修复的浏览器侧验证：旧执行器对**已完成的历史合成任务**
     * 返回 `none`（不拦截），因此页面按"这个任务已经完成了"如实呈现。
     *
     * 修前它会重定向进 Expert Training —— 让用户以为当时做的是一份真题。
     */
    await page.goto(`${ELIGIBLE}/practice/legacy-completed-synthetic-reading`);

    // 不得落在真实真题训练路由上
    expect(
      new URL(page.url()).pathname,
      "已完成的历史合成任务不得被重定向进 Expert Training",
    ).not.toMatch(CANONICAL_TRAIN_ROUTE);

    // 如实呈现"已完成"
    await expect(page.getByText("这个任务已经完成了", { exact: false }).first()).toBeVisible();
    await expectNoSyntheticContent(page, "已完成历史任务的直接访问");

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("训练池策略 · reserved_only：详情页结构可见但无训练入口，直连 URL 也被挡", async ({
    page,
  }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // ---------------------------------------------------------------- 详情页
    await page.goto(`${RESERVED_ONLY}/practice/papers/${E2E_LEGACY_PAPER_ID}`);

    /*
     * 关键断言 1：**结构仍然可见** —— 保留不等于把整卷藏起来。
     * 用户需要知道库里有什么、它为什么被保留。
     *
     * 判据用小节标签本身（详情页的 `GROUP_LABELS`，形如「选词填空」），
     * 不是「阅读 · 选词填空」——那是**别处**（Today 的投影标题）的措辞。
     */
    await expect(page.getByText("试卷结构").first()).toBeVisible();
    await expect(page.getByText("选词填空").first()).toBeVisible();

    // 关键断言 2：「查看结构」仍在（浏览不是消耗材料）
    expect(
      await page.locator('a[href*="/section/"]').count(),
      "保留卷仍应提供「查看结构」",
    ).toBeGreaterThan(0);

    // 关键断言 3：**没有任何「开始训练」入口**（这才是本次修复的核心）
    expect(
      await page.locator('a[href*="/train/"]').count(),
      "模考保留卷不得暴露任何训练入口",
    ).toBe(0);
    await expect(page.getByText("开始训练")).toHaveCount(0);

    // 关键断言 4：每行阅读大题上显示的是锁定态，而不是按钮
    await expect(page.getByText("模考保留").first()).toBeVisible();

    // 关键断言 5：说明为什么不能练、以及怎么办（不是死胡同）
    const bodyText = await page.locator("body").innerText();
    expect(bodyText, "必须说明移回训练池后才能练").toContain("移回训练池");

    // 「题目与作答」那段文案也必须跟着变（原来无条件说"现在可以直接作答"）
    expect(
      bodyText,
      "保留卷上不得再声称阅读大题「现在可以直接作答」",
    ).not.toContain("现在可以直接作答");

    await expectNoHorizontalOverflow(page, "reserved paper detail");

    /*
     * 截图分两张：首屏（来源与版本 + 池徽标）与**阅读部分**。
     * 后者是本次修复的落点 —— 必须能看到阅读大题行显示的是锁定态、
     * 而不是「开始训练」按钮。只拍首屏会漏掉听力/写作部分，
     * 看不到真正改动的那几行（实测踩到）。
     */
    await shotViewport(page, "legacy-06-reserved-paper-detail");
    await page.getByRole("heading", { name: "阅读", exact: true }).scrollIntoViewIfNeeded();
    await shotViewport(page, "legacy-06b-reserved-reading-section");

    // ---------------------------------------------------------------- 直连 URL
    /*
     * 关键断言 5：**直接输入训练 URL 也必须被挡住**。
     * 隐藏按钮是不够的 —— 学习者可以直接敲地址，或在旧书签里点进来。
     */
    await page.goto(`${RESERVED_ONLY}/practice/papers/${E2E_LEGACY_PAPER_ID}/train/${LEGACY_SECTION}`);

    await expect(
      page.getByText("这份试卷当前不能开始训练").first(),
      "直连训练 URL 应显示保留态，而不是开始屏",
    ).toBeVisible();
    await expect(page.getByText("模考保留").first()).toBeVisible();

    // 不得渲染任何开始/继续/再练一次的动作
    expect(await page.getByRole("button", { name: /开始训练/ }).count(), "不得有开始按钮").toBe(0);
    expect(await page.getByRole("button", { name: /再练一次/ }).count(), "不得有再练按钮").toBe(0);
    await expect(page.locator("fieldset"), "不得进入作答界面").toHaveCount(0);

    // 恢复路径必须在（回试卷页调整池归属）
    await expect(
      page.getByRole("link", { name: /去调整训练池归属/ }).first(),
      "必须给出恢复路径",
    ).toBeVisible();

    await shotViewport(page, "legacy-07-reserved-direct-url-blocked");

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("训练池策略 · eligible：可练时入口照常存在（对照，防止修过头）", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    /*
     * 对照组：同一个页面在**训练池**下必须仍然提供训练入口。
     * 没有这条，上面的"零入口"断言可能只是因为我把整页改坏了。
     *
     * ── 判据用「开始训练」链接是否存在，而不是「模考保留」这四个字 ──
     * 「模考保留」在 `PoolSwitch` 里恒存在（那是**设置控件**的两个选项之一，
     * 不是状态徽标），因此拿它当状态判据会永远命中（实测踩到）。
     */
    await page.goto(`${ELIGIBLE}/practice/papers/${E2E_LEGACY_PAPER_ID}`);

    expect(
      await page.locator('a[href*="/train/"]').count(),
      "训练池的卷子应保留训练入口",
    ).toBeGreaterThan(0);
    await expect(page.getByText("开始训练").first()).toBeVisible();
    // 训练池下不得出现"不能开始"的说法
    const poolText = await page.locator("body").innerText();
    expect(poolText, "训练池卷子上不得说不能开始训练").not.toContain("这份试卷当前不能开始训练");

    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("历史数据安全 · 那些旧行原样保留，没有被改写或删除", async ({ page }) => {
    /*
     * 浏览器侧只能验证外部表现：历史任务的引用仍然是**合成**内容 id，
     * 而我们**没有**为了隐藏它而删除内容库条目 —— 该条目依然存在，
     * 只是不再可渲染为阅读训练（`getContentView` 返回 unsupported）。
     *
     * 数据库层面的"行未被改写"由 `tests/reading-convergence.test.ts` 直接断言。
     */
    await page.goto(`${ELIGIBLE}/today`);
    await expectNoSyntheticContent(page, "Today");

    // 合成内容 id 不应出现在任何面向学习者的链接里
    const hrefs = await page
      .locator("a[href]")
      .evaluateAll((nodes) => nodes.map((n) => (n as HTMLAnchorElement).getAttribute("href") ?? ""));
    for (const href of hrefs) {
      expect(href, "面向学习者的链接不得指向合成内容条目").not.toContain(
        E2E_LEGACY_SYNTHETIC_CONTENT_ID,
      );
    }
  });
});
