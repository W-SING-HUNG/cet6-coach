import { test, expect, type Page } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shotViewport } from "./helpers";
import { E2E_FIXTURE_PAPERS } from "./config";

/**
 * 回答问题工作区（v2）的浏览器级验证。
 *
 * 与 `training.spec.ts` 的分工：那个文件守住 v1 就已确立的**闭环语义**
 * （作答 → 交卷 → 确定性判分 → 落库 → 回看），本文件守住 v2 新增的
 * **交互模型**：一题焦点、常驻导航、导航器、标记、选项排除、移动端分段。
 *
 * ── 数据诚实性 ──
 * 本文件涉及的试卷全部是 `test_fixture`（夹具构造器写死来源类型）。
 * 断言只针对**结构与状态**，不断言任何具体题目的答案 ——
 * 那既会让测试因夹具变化而假红，也会把答案写进可提交文件。
 *
 * ── 大题分配 ──
 * 与 training.spec.ts 一样，每条测试用**不同的大题**，避免同一份会话被前一条
 * 测试提交后变成"已完成"页面。缺口用 `matching` / `careful` 的**再练一次**会话补。
 */

const PAPER_ID = E2E_FIXTURE_PAPERS[1].id; // 2024-12 set1

/**
 * 从真题库详情进入指定阅读大题的训练页，并确保处于**作答界面**。
 *
 * ── 为什么必须是自足的，而不能假设前置状态 ──
 * Playwright 按**文件名字母序**串行执行。若把本文件命名为
 * `answering-...`，它会排在 `flow.spec.ts` 之前 —— 那时 onboarding 还没做，
 * 于是 `/practice/papers` 会重定向到 `/onboarding`，训练链接根本不存在
 * （实测：15 条测试全部在 20s 处 `toBeVisible` 超时）。
 * 因此本文件命名为 `ui-workspace.spec.ts`（字母序在 flow 之后），
 * 并且每一步都**不假设**大题处于哪个状态：
 *
 *   · 未开始 → 点「开始训练」
 *   · 已完成 → 点「再练一次」（服务层会开启**新的**会话）
 *   · 进行中 → 直接就是作答界面
 */
async function openAnswering(page: Page, index: number): Promise<void> {
  await page.goto(`/practice/papers/${PAPER_ID}`);
  const trainLinks = page.locator(`a[href*="/train/"]`);
  await expect(trainLinks.first()).toBeVisible();
  await trainLinks.nth(index).click();
  await expect(page).toHaveURL(/\/train\/[^/]+$/);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    // 作答界面的判据是"存在作答控件"。回看模式用列表渲染选项，没有 fieldset，
    // 因此这个判据能可靠区分"在作答"与"在看结果"。
    try {
      await expect(page.locator("fieldset").first()).toBeVisible({ timeout: 6_000 });
      return;
    } catch {
      /* 还没到作答界面：下面按当前屏的状态点进去 */
    }
    const again = page.getByRole("button", { name: /再练一次/ });
    const start = page.getByRole("button", { name: /开始训练/ });
    if ((await again.count()) > 0) await again.first().click();
    else if ((await start.count()) > 0) await start.first().click();
    else break;
  }

  await expect(page.locator("fieldset").first()).toBeVisible({ timeout: 30_000 });
}

/** 当前题的作答控件类型。 */
async function currentKind(page: Page): Promise<"mcq" | "matching" | "cloze" | "none"> {
  if ((await page.locator("fieldset label:has(input[type='radio'])").count()) > 0) {
    const optionButtons = await page.getByRole("button", { name: /排除选项/ }).count();
    return optionButtons > 0 ? "mcq" : "matching";
  }
  const radios = await page.locator("input[type='radio']").count();
  if (radios > 0) return "matching";
  return "none";
}

/** 作答当前题（用第一种可用控件）。返回是否真的作答了。 */
async function answerCurrent(page: Page): Promise<boolean> {
  const eliminateButton = page.getByRole("button", { name: /排除选项/ }).first();
  if ((await eliminateButton.count()) > 0) {
    // 仔细阅读：点第一个选项的 label
    await page.locator("fieldset label:has(input[type='radio'])").first().click();
    return true;
  }
  const matchingLabel = page.locator("fieldset label:has(input[type='radio'])").first();
  if ((await matchingLabel.count()) > 0) {
    await matchingLabel.click();
    return true;
  }
  return false;
}

test.describe("回答工作区 v2：一题焦点与常驻导航", () => {
  test("桌面分栏：原文与作答同屏，两者各自可滚动", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAnswering(page, 2); // careful reading

    // 两个区域都在（材料栏 + 作答栏）
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeVisible();
    await expect(page.getByRole("region", { name: "作答区" })).toBeVisible();

    /*
      关键断言：两个区域**同屏并列**，而不是上下堆叠。
      判据用几何而不是 class：材料的左边界 < 作答区的左边界，
      且两者纵向重叠（说明是左右分栏而非上下排列）。
    */
    const material = await page.getByRole("region", { name: "阅读材料" }).boundingBox();
    const answer = await page.getByRole("region", { name: "作答区" }).boundingBox();
    expect(material).not.toBeNull();
    expect(answer).not.toBeNull();
    expect(
      answer!.x,
      "作答区没有排在材料右侧 —— 不是分栏布局",
    ).toBeGreaterThan(material!.x + 100);
    expect(
      Math.abs(answer!.y - material!.y),
      "两个区域纵向错开过大 —— 更像上下堆叠",
    ).toBeLessThan(120);

    // 材料栏宽度应占视图的大部分（55–60% 的目标区间，允许一定偏差）
    const ratio = material!.width / 1440;
    expect(ratio, `材料栏占比 ${(ratio * 100).toFixed(0)}% 过低`).toBeGreaterThan(0.45);
    expect(ratio, `材料栏占比 ${(ratio * 100).toFixed(0)}% 挤掉了作答区`).toBeLessThan(0.72);

    await shotViewport(page, "ui2-03-careful-answering-1440");
    await expectNoHorizontalOverflow(page, "careful reading answering desktop");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("一次只显示一题，且上一题 / 下一题常驻可见", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAnswering(page, 2);

    // 只渲染一个作答 fieldset（一题焦点），不是整卷
    await expect(page.locator("fieldset")).toHaveCount(1);

    const prev = page.getByRole("button", { name: "上一题" }).first();
    const next = page.getByRole("button", { name: "下一题" }).first();
    await expect(prev).toBeVisible();
    await expect(next).toBeVisible();

    // 导航条在视口内（不需要滚动才能用）
    const nextBox = await next.boundingBox();
    expect(nextBox).not.toBeNull();
    expect(nextBox!.y + nextBox!.height, "下一题按钮在视口之外").toBeLessThanOrEqual(900);

    // 交卷入口同样常驻
    await expect(page.getByRole("button", { name: "交卷", exact: true })).toBeVisible();
  });

  test("导航器：状态区分、可跳转、键盘可用", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAnswering(page, 2);

    // 先作答第一题，制造"已答"状态
    await answerCurrent(page);

    // 打开导航器：中心控件显示 "N / 总"
    const trigger = page.locator("button[aria-haspopup='dialog']").first();
    await expect(trigger).toBeVisible();
    await trigger.click();

    const dialog = page.getByRole("dialog", { name: "题目导航" });
    await expect(dialog).toBeVisible();

    /*
      状态必须有多重编码，不能只靠颜色：
      已答的格子带对勾，未答的没有；两者都可被读屏读出完整状态。
    */
    const cells = dialog.locator("button[data-cell]");
    const cellCount = await cells.count();
    expect(cellCount, "导航器没有题目格子").toBeGreaterThan(0);

    // 无障碍名称必须说明题号与状态（不能只有数字）
    const firstLabel = await cells.first().getAttribute("aria-label");
    expect(firstLabel, "导航器格子缺少无障碍名称").toMatch(/第 \d+ 题/);
    expect(firstLabel).toMatch(/已作答|未作答/);

    /*
      已答与未答必须在**无障碍名称**上可区分。
      用 aria-label 判据而不是"找没有文本的格子"：格子里除了题号还有
      对勾/书签图标，`hasText` 无法稳定表达"已答"。
    */
    const labels: string[] = [];
    for (let index = 0; index < cellCount; index += 1) {
      labels.push((await cells.nth(index).getAttribute("aria-label")) ?? "");
    }
    expect(
      labels.some((label) => label.includes("已作答")),
      "没有任何格子被标记为已作答（第一题刚刚才作答过）",
    ).toBe(true);
    expect(
      labels.some((label) => label.includes("未作答")),
      "没有任何格子被标记为未作答（其余题都还没答）",
    ).toBe(true);

    // 当前题有 aria-current
    await expect(dialog.locator("button[aria-current='true']")).toHaveCount(1);

    /*
      几何回归守卫：面板必须完整落在视口内。
      实测过的真实缺陷：`inset-x-0` 与 `lg:right-0` 混用时算出 right:-271.78px，
      面板右边缘落到 1680px，**超出 1440 视口 240px 被裁切** ——
      只露出 2 列格子，看起来像导航器坏了。
      这类缺陷不会被"元素可见"的断言发现（它确实可见，只是被裁掉一半），
      因此必须直接断言矩形边界。
    */
    const box = await dialog.boundingBox();
    expect(box, "导航面板没有几何信息").not.toBeNull();
    const viewport = page.viewportSize();
    expect(box!.x, `面板左边缘 ${box!.x} 超出视口`).toBeGreaterThanOrEqual(0);
    expect(
      box!.x + box!.width,
      `面板右边缘 ${box!.x + box!.width} 超出视口宽度 ${viewport!.width}`,
    ).toBeLessThanOrEqual(viewport!.width + 1);
    expect(box!.y, `面板上边缘 ${box!.y} 超出视口`).toBeGreaterThanOrEqual(0);

    // 跳转：点第 5 个格子（若存在），题号应随之改变
    if (cellCount >= 5) {
      const before = await trigger.innerText();
      await cells.nth(4).click();
      await expect(dialog).toBeHidden();
      const after = await trigger.innerText();
      expect(after, "点击导航格子没有切换题目").not.toBe(before);
    }

    await shotViewport(page, "ui2-04-navigator-1440");
    await expectNoHorizontalOverflow(page, "navigator desktop");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("标记待回看：不改变作答状态，且不进入提交载荷", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAnswering(page, 2);

    const answeredText = await page.getByText(/已作答 \d+ \/ \d+/).first().innerText();

    const mark = page.getByRole("button", { name: "标记", exact: true }).first();
    await expect(mark).toBeVisible();
    await mark.click();

    // 标记后按钮语义变为"已标记"（aria-pressed 如实表达）
    const marked = page.getByRole("button", { name: "已标记", exact: true }).first();
    await expect(marked).toBeVisible();
    expect(await marked.getAttribute("aria-pressed")).toBe("true");

    // 关键：标记**不**改变已作答题数
    const afterText = await page.getByText(/已作答 \d+ \/ \d+/).first().innerText();
    expect(afterText, "标记待回看不应改变已作答题数").toBe(answeredText);

    // 标记状态在导航器里可见
    const trigger = page.locator("button[aria-haspopup='dialog']").first();
    await trigger.click();
    await expect(page.getByRole("dialog", { name: "题目导航" })).toContainText("标记");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "题目导航" })).toBeHidden();
  });

  test("选项排除：划掉与恢复都不改变已选答案", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAnswering(page, 2);

    // 先选第一个选项
    const firstOption = page.locator("fieldset label:has(input[type='radio'])").first();
    await firstOption.click();
    await expect(page.getByText(/已作答 1\s*\/\s*\d+/).first()).toBeVisible();

    // 划掉**另一个**选项（第 3 个）
    const options = page.locator("fieldset label:has(input[type='radio'])");
    const optionCount = await options.count();
    expect(optionCount, "仔细阅读应有多个选项").toBeGreaterThanOrEqual(3);

    const eliminateButtons = page.getByRole("button", { name: /排除选项/ });
    await eliminateButtons.nth(2).click();

    // 恢复按钮出现（语义已变），且选项文本被划掉
    await expect(page.getByRole("button", { name: /恢复选项/ }).first()).toBeVisible();

    // 关键：已作答数不变 —— 排除不是作答动作
    await expect(page.getByText(/已作答 1\s*\/\s*\d+/).first()).toBeVisible();

    // 恢复
    await page.getByRole("button", { name: /恢复选项/ }).first().click();
    await expect(page.getByRole("button", { name: /排除选项/ }).first()).toBeVisible();
    await expect(page.getByText(/已作答 1\s*\/\s*\d+/).first()).toBeVisible();

    await expectNoHorizontalOverflow(page, "option elimination");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});

test.describe("回答工作区 v2：题型专用交互", () => {
  test("仔细阅读：四选一 + 排除按钮", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAnswering(page, 2);

    expect(await currentKind(page)).toBe("mcq");
    const options = page.locator("fieldset label:has(input[type='radio'])");
    expect(await options.count()).toBeGreaterThanOrEqual(4);
    await expect(page.getByRole("button", { name: /排除选项/ }).first()).toBeVisible();
  });

  test("长篇阅读：段落标号点选，不需要打字", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAnswering(page, 1); // matching

    // 陈述句作为当前任务
    await expect(page.getByText("这句话出自哪一个段落？")).toBeVisible();

    // 标号是可点的 radio（不是文本输入框）
    const labels = page.locator("fieldset label:has(input[type='radio'])");
    const labelCount = await labels.count();
    expect(labelCount, "长篇阅读应给出段落标号选项").toBeGreaterThan(0);
    expect(
      await page.locator("input[type='text']").count(),
      "长篇阅读不应要求打字输入标号",
    ).toBe(0);

    // 点一个标号即作答
    await labels.first().click();
    await expect(page.getByText(/已作答 1\s*\/\s*\d+/).first()).toBeVisible();

    await shotViewport(page, "ui2-05-matching-1440");
    await expectNoHorizontalOverflow(page, "matching desktop");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("选词填空：词库点选、替换答案、清空", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAnswering(page, 0); // banked cloze

    // 空号与词库都在作答栏
    await expect(page.getByText(/第 \d+ 空/).first()).toBeVisible();
    await expect(page.getByText(/词库共 \d+ 个词/)).toBeVisible();

    const bank = page.locator("fieldset label:has(input[type='radio'])");
    const bankCount = await bank.count();
    expect(bankCount, "词库应给出可点选的词").toBeGreaterThan(0);
    expect(
      await page.locator("input[type='text']").count(),
      "选词填空不应要求打字输入单词",
    ).toBe(0);

    // 选第一个词
    await bank.first().click();
    await expect(page.getByText(/已作答 1\s*\/\s*\d+/).first()).toBeVisible();

    // 替换为第二个词（改答案路径）
    await bank.nth(1).click();
    await expect(page.getByText(/已作答 1\s*\/\s*\d+/).first()).toBeVisible();

    // 清空这一空
    const clear = page.getByRole("button", { name: /清空这一空/ }).first();
    if ((await clear.count()) > 0) {
      await clear.click();
      await expect(page.getByText(/已作答 0\s*\/\s*\d+/).first()).toBeVisible();
    }

    // 原文里的空位标记可见（选词填空的结构必须暴露出来）
    const blankMarkers = page.locator("[data-blank]");
    expect(await blankMarkers.count(), "原文中应渲染出空位标记").toBeGreaterThan(0);

    await shotViewport(page, "ui2-06-banked-cloze-1440");
    await expectNoHorizontalOverflow(page, "banked cloze desktop");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});

test.describe("回答工作区 v2：交卷确认", () => {
  test("未作答时交卷确认把数量与题号都摆出来，且可跳回去", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    // 用 matching 的再练一次会话（前面的测试只读，不提交）
    await openAnswering(page, 1);

    await page.getByRole("button", { name: "交卷", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "确认交卷？" });
    await expect(dialog).toBeVisible();

    // 统计三项并列
    await expect(dialog).toContainText("已作答");
    await expect(dialog).toContainText("未作答");
    await expect(dialog).toContainText("已标记");

    // 有未答题时必须显示具体数字与可跳转题号
    await expect(dialog).toContainText(/还有 \d+ 题没有作答/);
    await expect(dialog).toContainText("点题号可以直接跳过去作答");

    // 未作答语义必须精确（不得说成"没有产生证据"）
    await expect(dialog).toContainText("未作答不计为错误");
    await expect(dialog).toContainText("系统只记录这题未作答");

    // 点击未答题号应关闭弹层并跳过去
    const jump = dialog.locator("ul button").first();
    if ((await jump.count()) > 0) {
      await jump.click();
      await expect(dialog).toBeHidden();
    }

    await shotViewport(page, "ui2-07-submit-confirm-1440");
    await expectNoHorizontalOverflow(page, "submit confirm");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("后台提交进行中时确认键进入 loading，且不能重复点击", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openAnswering(page, 2);

    await page.getByRole("button", { name: "交卷", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "确认交卷？" });
    await expect(dialog).toBeVisible();

    const confirm = dialog.getByRole("button", { name: /确认交卷/ });
    await confirm.click();

    /*
      提交后界面必须进入不可重复触发的状态。
      不依赖"必须恰好看到 loading 字样"（服务端可能极快返回），
      而是断言：确认交卷键要么处于 aria-busy，要么已经消失
      （结果区出现时确认键不再存在）。二者都说明没有留下可再次点击的入口。
    */
    await expect(async () => {
      const stillThere = await page.getByRole("button", { name: /确认交卷/ }).count();
      if (stillThere === 0) return;
      const busy = await page
        .getByRole("button", { name: /确认交卷/ })
        .first()
        .getAttribute("aria-busy");
      expect(busy).toBe("true");
    }).toPass({ timeout: 20_000 });

    // 最终必须出现结果（或结果区），且不再有交卷入口
    await expect(page.getByText("本次结果已记录", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole("button", { name: "交卷", exact: true })).toHaveCount(0);
  });
});

test.describe("回答工作区 v2：回看模式", () => {
  test("交卷后留在同一套分栏内逐题回看，可筛选且不再提供交卷", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    // 用 careful reading 的再练一次会话（前一条测试已提交过一次）
    await openAnswering(page, 2);
    const answered = await answerCurrent(page);
    expect(answered).toBe(true);

    await page.getByRole("button", { name: "交卷", exact: true }).click();
    await page.getByRole("dialog", { name: "确认交卷？" }).getByRole("button", { name: /确认交卷/ }).click();
    await expect(page.getByText("本次结果已记录", { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    // 空间心智模型保持：原文仍在左侧
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeVisible();
    await expect(page.getByRole("region", { name: "回看" })).toBeVisible();

    // 三种筛选并列（文案与 training.spec.ts 的既有契约一致）
    await expect(page.getByRole("button", { name: /^全部 \d+$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^错误 \d+$/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /^未作答 \d+$/ })).toBeVisible();

    // 回看模式下**不再**提供交卷（已提交的事实不可再提交）
    await expect(page.getByRole("button", { name: "交卷", exact: true })).toHaveCount(0);

    // 逐题导航仍在
    await expect(page.getByRole("button", { name: "下一题" }).first()).toBeVisible();

    // 结果区必须包含确定性事实与诚实性边界
    await expect(page.getByText(/正确答案|你的作答/).first()).toBeVisible();
    await expect(page.getByText(/还不足以判断某个能力上的原因/).first()).toBeVisible();

    await shotViewport(page, "ui2-08-review-1440");
    await expectNoHorizontalOverflow(page, "review mode desktop");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});

test.describe("回答工作区 v2：移动端", () => {
  test("材料 / 作答分段切换，底部导航常驻，无横向溢出", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openAnswering(page, 2);

    // 分段开关存在
    const materialTab = page.getByRole("tab", { name: /查看原文/ });
    const questionTab = page.getByRole("tab", { name: /作答/ });
    await expect(materialTab).toBeVisible();
    await expect(questionTab).toBeVisible();

    // 默认在作答侧：材料区域不可见
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeHidden();
    await expect(page.getByRole("region", { name: "作答区" })).toBeVisible();

    /*
      关键断言：分段切换**不是**把桌面分栏压扁。
      判据：两态下各自只有一个区域可见（互斥），而不是两个都挤在一屏。
    */
    await materialTab.click();
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeVisible();
    await expect(page.getByRole("region", { name: "作答区" })).toBeHidden();
    await shotViewport(page, "ui2-10-mobile-material");

    await questionTab.click();
    await expect(page.getByRole("region", { name: "作答区" })).toBeVisible();
    await expect(page.getByRole("region", { name: "阅读材料" })).toBeHidden();

    // "查看原文"必须是一个明显动作即可达（作答栏里也有入口）
    await expect(page.getByText("查看原文").first()).toBeVisible();

    // 底部控制条常驻且不被裁掉
    const next = page.getByRole("button", { name: "下一题" }).first();
    await expect(next).toBeVisible();
    const box = await next.boundingBox();
    expect(box, "移动端找不到下一题按钮").not.toBeNull();
    expect(box!.y + box!.height, "底部控制条超出视口").toBeLessThanOrEqual(845);

    // 移动端不得出现应用底部导航（沉浸式外壳隐藏它，避免与工作区抢位置）
    await expect(page.locator("nav[aria-label='主导航']")).toHaveCount(0);

    await shotViewport(page, "ui2-11-mobile-question");
    await expectNoHorizontalOverflow(page, "answering mobile");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });

  test("在材料与题目间来回切换时，作答状态保留", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAnswering(page, 2);

    // 作答
    await answerCurrent(page);
    await expect(page.getByText(/已作答 1\s*\/\s*\d+/).first()).toBeVisible();

    // 切到原文再切回来
    await page.getByRole("tab", { name: /查看原文/ }).click();
    await page.getByRole("tab", { name: /作答/ }).click();

    // 作答状态必须仍在
    await expect(page.getByText(/已作答 1\s*\/\s*\d+/).first()).toBeVisible();
    const checked = await page
      .locator("input[type='radio']:checked")
      .count();
    expect(checked, "切换材料/题目后作答选择丢失").toBeGreaterThan(0);
  });

  test("移动端导航器为整屏抽屉，格子足够大可点", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openAnswering(page, 2);

    await page.locator("button[aria-haspopup='dialog']").first().click();
    const dialog = page.getByRole("dialog", { name: "题目导航" });
    await expect(dialog).toBeVisible();

    const cell = dialog.locator("button[data-cell]").first();
    const box = await cell.boundingBox();
    expect(box, "移动端导航格子不存在").not.toBeNull();
    // 触摸目标最小 44px 是移动端可用性的硬底线
    expect(box!.height, `导航格子高度 ${box!.height}px 低于 44px 触摸底线`).toBeGreaterThanOrEqual(44);

    await expectNoHorizontalOverflow(page, "mobile navigator");
  });
});

test.describe("回答工作区 v2：1024 尺寸", () => {
  test("1024×768 下仍为分栏，且材料保持可见", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1024, height: 768 });
    await openAnswering(page, 2);

    await expect(page.getByRole("region", { name: "阅读材料" })).toBeVisible();
    await expect(page.getByRole("region", { name: "作答区" })).toBeVisible();

    const material = await page.getByRole("region", { name: "阅读材料" }).boundingBox();
    const answer = await page.getByRole("region", { name: "作答区" }).boundingBox();
    expect(answer!.x, "1024 下没有分栏").toBeGreaterThan(material!.x + 100);

    await shotViewport(page, "ui2-09-careful-answering-1024");
    await expectNoHorizontalOverflow(page, "careful reading 1024");
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
    expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
  });
});
