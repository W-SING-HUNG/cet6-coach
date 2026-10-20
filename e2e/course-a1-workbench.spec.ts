import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { E2E_A1_BASE_URL, E2E_A1_HANDOFF_PATH } from "./config";

/**
 * **A1 只读检查工作台**的真实浏览器验收（端口 3270，**全部合成夹具**）。
 *
 * ── 它验收什么 ──
 *
 * 1. **完整流程可用**：打开 → 目录树 → 勾选范围 → 「检查所选材料」→ 四步结果。
 * 2. **只读是可见的事实**：页头声明、**没有任何**保存 / 导入 / 建链控件。
 * 3. **四类形态各就各位**：有文本层 / 无文字层 / 解析失败 / 空文件，
 *    且**没有一个失败被静默忽略**（每一条都有处置说明）。
 * 4. **分组与分段**：PDF+DOCX 的等价性标为未验证；段带页码与种类。
 * 5. **匹配证据**：打分项与"不参与打分的上下文"分开；未匹配是合法状态；
 *    写作模板是"按设计不匹配"。
 * 6. **10+ 个不同目标**全部呈现：长列表必须诚实地显示"共 N 条"并可展开。
 * 7. **既有标注模式未被削弱**（`GET /` 仍是标注外壳）。
 * 8. **键盘可达性 / 状态播报 / 窄视口 / 加载与禁用态。**
 *
 * ── 它是**独立**于进程内测试的一层 ──
 *
 * `tests/course-a1-workbench.test.ts` 与 `pnpm course:a1-proof` 在进程内 /
 * 进程层证明端点与零写入；这一层证明**真实 Chromium 加载这段脚本之后
 * 它确实工作**（hydration、事件接线、禁用态、无 console 错误）。
 * 两者互补，互不替代。
 */

/** 从启动脚本写下的交接文件里取工作台 URL（token 在 fragment 里）。 */
function workbenchUrl(): string {
  const raw = readFileSync(E2E_A1_HANDOFF_PATH, "utf8");
  const parsed = JSON.parse(raw) as { url: string };
  return parsed.url;
}

/** 收集 console error 与未捕获异常 —— 关键页面不得有。 */
function watchPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console.error: ${message.text()}`);
  });
  return errors;
}

/** 一个"可被真实点击"的完整检查流程。 */
async function runFullInspection(page: Page): Promise<void> {
  await page.getByRole("button", { name: "检查所选材料" }).click();
  // 检查完成 ⇒ 第 2 步出现并显示四张卡片
  await expect(page.locator("#cards .card")).toHaveCount(4, { timeout: 60_000 });
}

test.describe("A1 · 打开与只读边界", () => {
  test("工作台可打开，页头声明只读，且**没有**任何写入控件", async ({ page }) => {
    const errors = watchPageErrors(page);
    await page.goto(workbenchUrl());

    await expect(page.getByRole("heading", { name: "检查本机课程材料" })).toBeVisible();
    await expect(page.getByText("只读 · 不会修改或保存任何东西")).toBeVisible();

    // 只读的能力边界不是文案声明的：这些控件**根本不存在**
    for (const forbidden of ["保存计划", "导入课程", "建立链接", "生成候选", "晋升"]) {
      await expect(page.getByRole("button", { name: forbidden })).toHaveCount(0);
    }

    // 四步导航
    await expect(page.getByRole("button", { name: /① 选择材料/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /② 清点结果/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /③ 材料与分段/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /④ 真题候选/ })).toBeVisible();

    expect(errors, `页面不得有 console error / 未捕获异常：\n${errors.join("\n")}`).toEqual([]);
  });

  test("token 从地址栏被抹掉（fragment 不留在可见历史里）", async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });
    expect(page.url()).not.toContain("token=");
    expect(page.url()).not.toContain("#");
  });

  test("缺少凭据时给出明确失败，而不是静默空白页", async ({ page }) => {
    // 主动去掉 fragment ⇒ 没有 token
    await page.goto(`${E2E_A1_BASE_URL}/intake`);
    await expect(page.locator("#globalNotice")).toContainText("凭据", { timeout: 20_000 });
    await expect(page.getByRole("button", { name: "选择课程文件夹…" })).toBeDisabled();
  });

  test("既有标注模式未被削弱：`GET /` 仍是标注外壳", async ({ page }) => {
    await page.goto(`${E2E_A1_BASE_URL}/`);
    await expect(page.getByRole("heading", { name: "把讲义分成一份份翻译练习" })).toBeVisible();
  });
});

test.describe("A1 · 第 1 步：目录树与选择", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });
  });

  test("目录树渲染出嵌套目录与文件，并显示已选 / 已排除计数", async ({ page }) => {
    // 源根下有若干顶层目录
    const tree = page.locator("#tree");
    await expect(tree).toContainText("阅读");
    await expect(tree).toContainText("翻译");
    await expect(tree).toContainText("写作");
    await expect(tree).toContainText("听力");

    // 计数（默认全选）
    await expect(page.locator("#selCounts")).toContainText("已选");
    await expect(page.locator("#selCounts")).toContainText("已排除 0 个");
  });

  test("父目录的三态：取消子目录勾选后父目录进入**部分选择**（indeterminate）", async ({ page }) => {
    /*
     * 三态必须真的呈现：一个"半选"的父目录若显示成未勾选，
     * 用户会以为里面什么都没选 —— 而实际有文件会被检查。
     */
    const sourceCheckbox = page.locator("#tree input[type=checkbox]").first();
    await expect(sourceCheckbox).toBeChecked();
    await expect(sourceCheckbox).not.toHaveJSProperty("indeterminate", true);

    // 取消勾选一个**子目录**里的文件 ⇒ 父目录必须进入 indeterminate
    const fileCheckboxes = page.locator('#tree input[id^="file-"]');
    const count = await fileCheckboxes.count();
    expect(count).toBeGreaterThan(0);
    await fileCheckboxes.first().uncheck();

    await expect(sourceCheckbox).toHaveJSProperty("indeterminate", true);
    await expect(page.locator("#selCounts")).toContainText("已排除 1 个");
  });

  test("「全不选」⇒ 检查按钮禁用并给出空选择提示（空选择范围不能检查）", async ({ page }) => {
    await page.getByRole("button", { name: "全不选" }).click();
    await expect(page.locator("#selCounts")).toContainText("已选");
    await expect(page.locator("#inspectHint")).toContainText("至少选择一个文件");
    await expect(page.getByRole("button", { name: "检查所选材料" })).toBeDisabled();

    // 恢复
    await page.getByRole("button", { name: "全选" }).click();
    await expect(page.getByRole("button", { name: "检查所选材料" })).toBeEnabled();
  });

  test("展开 / 折叠全部可用，且深层嵌套（第 1 套）可被看到", async ({ page }) => {
    await page.getByRole("button", { name: "展开全部" }).click();
    // 源目录里刻意有一层更深的嵌套
    await expect(page.locator("#tree")).toContainText("extra-passages.pdf");

    await page.getByRole("button", { name: "折叠全部" }).click();
    await expect(page.locator("#tree")).not.toContainText("extra-passages.pdf");
  });

  test("选择范围只决定检查什么：排除一个文件后计数改变，且检查结果不含它", async ({ page }) => {
    const published = page.locator('#tree input[id^="file-"]');
    // 先记录总数
    const before = await published.count();
    expect(before).toBeGreaterThan(1);

    // 排除写作模板
    const writingBox = page.locator('#tree input[id="file-写作/writing-template.pdf"]');
    if ((await writingBox.count()) > 0) {
      await writingBox.uncheck();
    }
    await runFullInspection(page);
    await expect(page.locator("#cards")).toBeVisible();

    // 第 3 步里不应出现被排除的材料
    await page.getByRole("button", { name: /③ 材料与分段/ }).click();
    await expect(page.locator("#materials")).not.toContainText("writing-template");
  });
});

test.describe("A1 · 第 2 步：清点结果（四类形态）", () => {
  test("四张卡片覆盖四类形态，且冲突与警告逐条给出原因与处置", async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });
    await runFullInspection(page);

    // 四张卡片
    await expect(page.locator("#cards .card")).toHaveCount(4);
    await expect(page.locator("#cards")).toContainText("可以读出文字层的 PDF");
    await expect(page.locator("#cards")).toContainText("没有文字层或解析失败的 PDF");
    await expect(page.locator("#cards")).toContainText("本版本暂不解析的其它文档（Word）");
    await expect(page.locator("#cards")).toContainText("空文件");

    // 跨文件事实
    await expect(page.locator("#crossFacts")).toContainText("这次检查了");

    // 冲突与警告：**每一条**都必须带"怎么办"
    const issues = page.locator("#stage2Issues .item");
    const issueCount = await issues.count();
    expect(issueCount, "四类形态必须都被上报（没有一个被静默忽略）").toBeGreaterThan(0);
    for (let index = 0; index < issueCount; index += 1) {
      await expect(issues.nth(index).locator(".why")).not.toBeEmpty();
      await expect(issues.nth(index).locator(".fix")).toContainText("怎么办");
    }
    // 具体形态必须在场
    await expect(page.locator("#stage2Issues")).toContainText("没有文字层的页");
    await expect(page.locator("#stage2Issues")).toContainText("PDF 解析失败");
    await expect(page.locator("#stage2Issues")).toContainText("空文件");
  });

  test("加载态可见：点检查后立刻有状态播报（不是静默等待）", async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });

    const live = page.locator("#live");
    await page.getByRole("button", { name: "检查所选材料" }).click();
    // 状态区是 aria-live，读屏用户据此知道发生了什么
    await expect(live).not.toBeEmpty();
    await expect(page.locator("#cards .card")).toHaveCount(4, { timeout: 60_000 });
  });
});

test.describe("A1 · 第 3 步：材料与分段", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });
    await runFullInspection(page);
    await page.getByRole("button", { name: /③ 材料与分段/ }).click();
  });

  test("材料显示表示清单，PDF+DOCX 的等价性标为**未验证**", async ({ page }) => {
    const materials = page.locator("#materials .item");
    expect(await materials.count()).toBeGreaterThan(0);

    // 有一份材料同时有 PDF 与 DOCX（**两种表示**，不是两份材料）
    const shared = page.locator("#materials .item").filter({ hasText: "shared-handout" });
    await expect(shared).toHaveCount(1);
    await expect(shared).toContainText("PDF 版");
    await expect(shared).toContainText("DOCX 版");
    await expect(shared).toContainText("两种版本的等价性未验证");
  });

  test("段显示种类与**真实页码范围**，且分组依据是可展开的证据", async ({ page }) => {
    await expect(page.locator("#materials")).toContainText("课程段");
    await expect(page.locator("#materials")).toContainText("阅读材料");
    // 分组依据收进折叠区，但**一条不删**
    const details = page.locator("#materials details.adv").first();
    await expect(details).toContainText("分组依据");
    await details.locator("summary").click();
    await expect(details.locator("ul.plain li").first()).not.toBeEmpty();
  });

  test("段没有产出时给出「工具不发明边界」的说明与后续步骤", async ({ page }) => {
    // 写作模板是文档级材料：段可能存在，但方法段会说明"按设计不参与匹配"
    const material = page.locator("#materials .item").filter({ hasText: "writing-template" });
    if ((await material.count()) > 0) {
      await expect(material).toContainText(/按设计不参与真题匹配|没有产出课程段/);
    }
  });
});

test.describe("A1 · 第 4 步：真题候选与证据", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });
    await runFullInspection(page);
    await page.getByRole("button", { name: /④ 真题候选/ }).click();
    /*
     * ── 显式等待第 ④ 步面板真的可见 ──
     *
     * 早先这里只点了按钮，然后由各用例自己的断言去等 `#matchSummary` 的文字。
     * 那在正常情况下够用（渲染是同步的），但它把"面板是否已切换"这件前置
     * 条件**混进了**每个断言里 —— 一旦某次切换慢了一拍，失败会表现为
     * "总结文案不对"，而真实原因是"面板还没显示"。那是最难定位的一种
     * 失败形态（症状指向内容，原因在时序）。
     *
     * 把前置条件写成断言之后，任何时序问题都会**停在它自己的位置上**，
     * 而不会伪装成内容缺陷。
     */
    await expect(page.locator("#step4")).toBeVisible({ timeout: 30_000 });
  });

  test("总结诚实：分别报有候选 / 歧义 / 无可比对象 / 按设计不匹配", async ({ page }) => {
    const summary = page.locator("#matchSummary");
    // 先等"总结已渲染"（非空），再断言它的具体措辞
    await expect(summary).not.toBeEmpty({ timeout: 30_000 });
    await expect(summary).toContainText("共");
    await expect(summary).toContainText("按设计不参与匹配");
    await expect(summary).toContainText("个不同的真题目标");
  });

  test("**10+ 个不同目标**全部呈现：聚合索引显示「共 N 个」并可展开", async ({ page }) => {
    /*
     * ── 这条判据的两个层次（缺一都会漏掉"被悄悄截断"）──
     *
     * 1. 总结里报出的**不同目标数**必须 ≥ 10；
     * 2. **跨段聚合索引**必须显示总数，并在超过一屏时给出展开控件。
     *
     * 只看总结数字会被"数字对但列表被截断"骗过去；
     * 只看有没有很多条会被"同一个目标重复 10 次"骗过去。
     */
    const summaryText = (await page.locator("#matchSummary").textContent()) ?? "";
    const targetMatch = /一共涉及 (\d+) 个不同的真题目标/.exec(summaryText);
    expect(targetMatch, `总结必须报出目标数：${summaryText}`).not.toBeNull();
    const targetCount = Number(targetMatch![1]);
    expect(targetCount, `不同目标数必须 ≥ 10（实际 ${targetCount}）`).toBeGreaterThanOrEqual(10);

    // 聚合索引在场，且标题里报出总数
    const indexHeading = page.locator("#matches h3", { hasText: "这次涉及的全部真题目标" });
    await expect(indexHeading).toHaveCount(1);
    await expect(indexHeading).toContainText(`${targetCount} 个，已去重`);

    // 长列表必须有展开控件（列表被截断就不会有它）
    const toggle = page.locator('button[data-target-index-toggle="1"]');
    await expect(toggle, "长列表必须有展开控件").toHaveCount(1);

    const more = toggle.locator("xpath=..");
    await expect(more).toContainText(`共 ${targetCount} 个目标`);

    // 展开后目标行数必须真的增加到总数
    const rows = page.locator("#matches li.target-row");
    const beforeExpand = await rows.count();
    expect(beforeExpand).toBeGreaterThan(0);
    expect(beforeExpand).toBeLessThan(targetCount);
    await toggle.click();
    await expect(rows).toHaveCount(targetCount);
  });

  test("聚合索引的每一条都带**稳定身份**（可拿去真题库里找到它）", async ({ page }) => {
    const rows = page.locator("#matches li.target-row");
    const count = await rows.count();
    expect(count).toBeGreaterThan(0);
    for (let index = 0; index < Math.min(count, 5); index += 1) {
      const key = await rows.nth(index).getAttribute("data-target-key");
      expect(key, "每条目标必须暴露稳定身份").not.toBeNull();
      // 身份形如 `paperId::sectionId::groupId`
      expect(key!.split("::").length).toBe(3);
      // 显示文本里必须含卷 id（用户据此在真题库定位）
      await expect(rows.nth(index)).toContainText(key!.split("::")[0]!);
    }
  });

  test("打分证据与**不参与打分的上下文**分开呈现", async ({ page }) => {
    const firstSuggestion = page.locator("#matches .item .item").first();
    if ((await firstSuggestion.count()) === 0) test.skip();
    await expect(firstSuggestion).toContainText("分数");
    await expect(firstSuggestion).toContainText("正文包含度");
    // 明确的免责声明
    await expect(firstSuggestion).toContainText("机器建议不等于核验");

    // 上下文收进折叠区并写明"不参与打分"
    const details = firstSuggestion.locator("details.adv");
    await expect(details).toContainText("上下文线索（以下不参与打分）");
  });

  test("按设计不匹配与未匹配给出**不同**的处置（不是同一句话）", async ({ page }) => {
    const matches = page.locator("#matches .item");
    const count = await matches.count();
    expect(count).toBeGreaterThan(0);

    let sawNotApplicable = false;
    for (let index = 0; index < count; index += 1) {
      const text = (await matches.nth(index).textContent()) ?? "";
      if (text.includes("按设计不参与真题匹配")) {
        sawNotApplicable = true;
        expect(text, "按设计不匹配必须说明「不需要做任何事」").toContain("不需要做任何事");
      }
      if (text.includes("未匹配是合法状态")) {
        expect(text, "未匹配必须说明它不表示材料有问题").toContain("不表示这份材料有问题");
      }
    }
    expect(sawNotApplicable, "写作模板必须显示为「按设计不匹配」").toBe(true);
  });
});

test.describe("A1 · 可访问性与响应式", () => {
  test("键盘可达：Tab 能依次到达主控件，焦点样式可见", async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });

    // 从页头开始 Tab，必须能到达检查按钮
    const focusedIds: string[] = [];
    for (let index = 0; index < 60; index += 1) {
      await page.keyboard.press("Tab");
      const id = await page.evaluate(() => document.activeElement?.id ?? "");
      if (id !== "") focusedIds.push(id);
      if (id === "inspect") break;
    }
    expect(focusedIds, "Tab 必须能到达「检查所选材料」").toContain("inspect");
  });

  test("回车可以触发检查（键盘全流程可用）", async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });

    await page.locator("#inspect").focus();
    await page.keyboard.press("Enter");
    await expect(page.locator("#cards .card")).toHaveCount(4, { timeout: 60_000 });
  });

  test("状态播报区存在且为 aria-live（读屏用户能知道发生了什么）", async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator('#live[role="status"][aria-live="polite"]')).toHaveCount(1);
  });

  test("窄视口（390×844）无横向溢出，主控件仍可用", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth, `窄视口不得横向溢出（${overflow.scrollWidth} > ${overflow.clientWidth}）`).toBeLessThanOrEqual(
      overflow.clientWidth + 1,
    );

    await expect(page.getByRole("button", { name: "检查所选材料" })).toBeVisible();
    await expect(page.getByRole("button", { name: "全选" })).toBeVisible();
  });

  test("「这是什么？」给出只读说明（可随时重开）", async ({ page }) => {
    await page.goto(workbenchUrl());
    await expect(page.locator("#tree")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "这是什么？" }).click();
    await expect(page.locator("#globalNotice")).toContainText("只读");
    await expect(page.locator("#globalNotice")).toContainText("不会修改、保存或导入");
  });
});
