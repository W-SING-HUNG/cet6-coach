import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { attachErrorCollectors, shot } from "./helpers";
import { E2E_ANNOTATION_HANDOFF_PATH, E2E_ANNOTATION_PLAN_PATH } from "./config";

/**
 * **本地标注页面 · 真实浏览器验收**（端口 3240）。
 *
 * ── 为什么这一层必须存在 ──
 *
 * `tests/course-segment-page-execution.test.ts` 在 jsdom 里执行脚本并真实点击，
 * 那一层抓得住接线断裂。但它抓不住一类问题：**只有真浏览器才有的行为** ——
 * 页内确认能不能被点、`scrollIntoView` 会不会抛、布局在真实视口下是不是
 * 把某个控件挤没了、有没有意外的外部请求。
 *
 * 更根本的是：使用者的真实场景是"**第一次打开这个页面**"。
 * 因此这里的用例从**服务端真实生成的 URL**（含 fragment 里的 token）开始导航，
 * 走完整的引导 → 标注 → 保存流程，并把结果落到 UI 证据。
 *
 * ── 全部合成材料 ──
 *
 * 页面里的正文来自 `scripts/e2e-server-annotation.ts` 里写死的
 * `SYNTHETIC_PAGES`（带「合成夹具」标识），**不含**任何真实讲义/真题。
 * 本文件也只断言结构与文案，不引用任何课程内容。
 */

/** 从交接文件读回**真实**的标注 URL（token 在 fragment 里，由服务端生成）。 */
function annotationUrl(): string {
  const handoff = JSON.parse(readFileSync(E2E_ANNOTATION_HANDOFF_PATH, "utf8")) as {
    url: string;
    boundAddress: string;
    port: number;
  };
  // 只接受回环地址：这条同时守卫"这个实例没有对外暴露"
  expect(handoff.url.startsWith("http://127.0.0.1:")).toBe(true);
  expect(handoff.boundAddress).toBe("127.0.0.1");
  expect(handoff.url).toContain("#token=");
  return handoff.url;
}

/**
 * 合成夹具的可标注行总数。
 *
 * 必须与 `scripts/e2e-server-annotation.ts` 里 `SYNTHETIC_PAGES` 的行数之和一致
 * （6 + 4 + 3）。这里写死是**有意的**：夹具行数一变，这些断言立刻变红，
 * 从而强制"界面证据"与"夹具事实"重新对齐，而不是悄悄漂移。
 */
const ANNOTATABLE_LINES = 13;

/**
 * 每一页的行数（页内坐标）。
 *
 * ── 为什么必须按页标注，而不是"1 到 13 一把标下来" ──
 *
 * 计划的选择器是「第几页第几行」——**页内**坐标。因此一个选区只在同一页内
 * 成立（界面会明确提示"选区不能跨页"）。这正是底层契约的直接后果：
 * 一次跨页点击不会**静默**套用到另一页上，而是要求重新点一次终点。
 *
 * 测试必须按同一套语义驱动界面；否则它测的是"我以为的交互"，
 * 而不是产品真实的行为。
 */
const PAGE_LINE_COUNTS = [6, 4, 3] as const;

/** 每一页第一行在**全局 DOM 顺序**里的下标（0 起）。 */
const PAGE_START_INDEX = PAGE_LINE_COUNTS.map((_, index) =>
  PAGE_LINE_COUNTS.slice(0, index).reduce((sum, count) => sum + count, 0),
);

/** 打开标注页面，并断言没有任何外部网络请求（零外部资源是结构事实）。 */
async function openAnnotation(page: Page): Promise<{ external: string[] }> {
  const external: string[] = [];
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("http://127.0.0.1:") || url.startsWith("http://localhost:")) return;
    if (url.startsWith("data:") || url.startsWith("blob:")) return;
    external.push(url);
  });

  await page.goto(annotationUrl());
  // 合成内容必须真的渲染出来（这也是"脚本确实执行了"的浏览器级判据）
  await expect(page.locator(".line")).toHaveCount(ANNOTATABLE_LINES);
  return { external };
}

/** 进入工作区（点掉首次打开的引导）。 */
async function start(page: Page): Promise<void> {
  await page.getByRole("button", { name: "开始标注" }).click();
  await expect(page.getByRole("button", { name: "开始标注" })).toBeHidden();
}

const action = (page: Page) => page.locator("#guideAction");

/** 一次"选类别 → 点第一行 → 点最后一行"，**完全不用 Shift**。 */
async function markRange(page: Page, category: string, from: number, to: number): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${category}`) }).click();
  await page.locator(".line").nth(from - 1).click();
  await page.locator(".line").nth(to - 1).click();
}

/** 同上，但用**全局 DOM 下标**（0 起）—— 用于跨页夹具。 */
async function markRangeByIndex(page: Page, category: string, from: number, to: number): Promise<void> {
  await page.getByRole("button", { name: new RegExp(`^${category}`) }).click();
  await page.locator(".line").nth(from).click();
  await page.locator(".line").nth(to).click();
}

/**
 * 走完一份可以保存的最简练习：
 * 新建 → 每页各标一段原文（跳过参考译文）→ 点检查并保存。
 *
 * 参考译文**刻意不标** —— 它本来就是可跳过的，这条同时验证了
 * "不强迫每份练习都有参考译文"这条产品要求。
 */
async function saveMinimalPlan(page: Page): Promise<void> {
  await page.getByRole("button", { name: "+ 新建一份翻译练习" }).click();
  for (let index = 0; index < PAGE_LINE_COUNTS.length; index += 1) {
    const start = PAGE_START_INDEX[index];
    await markRangeByIndex(page, "中文原文", start, start + PAGE_LINE_COUNTS[index] - 1);
  }
  await page.getByRole("button", { name: "检查并保存" }).click();
}

test.describe("本地标注页面 · 真实浏览器", () => {
  test("**首次打开就看得懂**：引导面板出现，三步清楚，主按钮明确", async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await openAnnotation(page);

    // 1) 引导必须是**可见且醒目**的 —— 不是一句藏在角落的提示
    const card = page.locator(".onboarding-card");
    await expect(card).toBeVisible();
    await expect(page.locator("#onboardingTitle")).toHaveText("把这份讲义分成一份份翻译练习");
    await expect(card).toContainText("你不需要修改内容，只需要告诉系统每一段属于什么。");
    await expect(card).toContainText("① 新建一份练习");
    await expect(card).toContainText("② 标出原文、参考译文和老师讲解");
    await expect(card).toContainText("③ 全部处理完后检查并保存");

    // 2) 引导期间**工作区不抢视线**（一次只做一件事）
    await expect(page.locator("main")).toBeHidden();

    // 3) 三步就是三步
    await expect(card.locator("li")).toHaveCount(3);

    await shot(page, "annotation-onboarding");

    expect(errors.pageErrors, "引导画面不得有未捕获异常").toEqual([]);
    expect(errors.consoleErrors, "引导画面不得有 console 错误").toEqual([]);
  });

  test("**点「开始标注」进入工作区**，且当前动作只有一句话", async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await openAnnotation(page);

    await start(page);

    // 工作区必须马上说清"现在该做什么"
    await expect(action(page)).toContainText("新建一份翻译练习");
    await expect(page.locator("#guideWhere")).toContainText("还没有翻译练习");

    // 引导可以被重新打开，也可以再关掉 —— 不挡路
    await page.getByRole("button", { name: "怎么用？" }).click();
    await expect(page.locator(".onboarding-card")).toBeVisible();
    await start(page);

    // 「新建一份翻译练习」是唯一显眼的主操作
    const newUnit = page.getByRole("button", { name: "+ 新建一份翻译练习" });
    await expect(newUnit).toBeEnabled();

    expect(errors.pageErrors).toEqual([]);
    expect(errors.consoleErrors).toEqual([]);
  });

  test("**四类控件**用中文产品语言，每一类带一句解释，且看不到任何英文枚举名", async ({ page }) => {
    await openAnnotation(page);
    await start(page);
    await page.getByRole("button", { name: "+ 新建一份翻译练习" }).click();

    const names = page.locator("#channelBtns .cat-name");
    await expect(names).toHaveText([
      "中文原文",
      "课程参考译文",
      "老师讲解 / 语言点",
      "页眉页脚（忽略）",
    ]);
    // 每一类都有一句人能懂的解释
    await expect(page.locator("#channelBtns .cat-help")).toHaveCount(4);
    await expect(page.locator("#channelBtns")).toContainText("每页重复出现、不是课程正文的内容");
    await expect(page.locator("#channelBtns")).toContainText("没有可以跳过");

    // **正常可见界面里不得出现任何内部枚举名或英文技术词**
    const visible = await page.locator("main").innerText();
    for (const forbidden of [
      "ignored_furniture",
      "reference_translation",
      "translation_passage",
      "unassigned",
      "overlap",
      "Furniture",
      "Source",
      "Notes",
      "checksum",
    ]) {
      expect(visible, `正常界面不得出现「${forbidden}」`).not.toContain(forbidden);
    }

    await shot(page, "annotation-workspace");
  });

  test("**点两下就能标出一个闭区间**：不选起点后再选终点，中途有明确的等待提示", async ({ page }) => {
    await openAnnotation(page);
    await start(page);
    await page.getByRole("button", { name: "+ 新建一份翻译练习" }).click();
    await expect(page.locator("#guideWhere")).toContainText("当前：第 1 份练习");

    // 选类别 ⇒ 必须告诉人先点哪一行
    await page.getByRole("button", { name: /^中文原文/ }).click();
    await expect(action(page)).toContainText("请选择「中文原文」");
    await expect(action(page)).toContainText("先点这一段的第一行，再点最后一行");

    // 点第一行 ⇒ 必须**明确**进入"等待最后一行"状态
    await page.locator(".line").nth(1).click();
    await expect(action(page)).toContainText("已选起点，再点这一段的最后一行");
    await expect(page.locator("#banner")).toContainText("已选起点，再点这一段的最后一行");

    // 点最后一行 ⇒ 闭区间 2~5 整段被标记
    await page.locator(".line").nth(4).click();

    const marked = page.locator(".line.source");
    await expect(marked).toHaveCount(4);
    // 每一行都带**文字标签**（不能只靠颜色）
    await expect(page.locator('.line.source .mark').first()).toHaveText("原文");
    // 标记记录用人话写位置
    await expect(page.locator(".unit .assign").first()).toContainText("中文原文");
    await expect(page.locator(".unit .assign").first()).toContainText("第 1 页 · 第 2 到 5 行");
    // 进度用人话
    await expect(page.locator("#progress")).toContainText(`还有 ${ANNOTATABLE_LINES - 4} 行没有处理`);
    await expect(page.locator("#progress")).toContainText(`已处理 4 / ${ANNOTATABLE_LINES} 行`);
    // 立刻给出下一个动作
    await expect(action(page)).toContainText("课程参考译文");

    await shot(page, "annotation-range-marked");
  });

  test("**标第二类完全不需要 Shift**，并且可以跳过参考译文", async ({ page }) => {
    await openAnnotation(page);
    await start(page);
    await page.getByRole("button", { name: "+ 新建一份翻译练习" }).click();

    // 第一次：原文（第 1 页 1~4 行）
    await markRange(page, "中文原文", 1, 4);
    // 第二次：老师讲解（第 1 页 5~6 行）—— 只用鼠标点两下，**不按任何修饰键**
    await markRange(page, "老师讲解", 5, 6);

    await expect(page.locator(".line.source")).toHaveCount(4);
    await expect(page.locator(".line.notes")).toHaveCount(2);
    await expect(page.locator(".unit .assign")).toHaveCount(2);
    await expect(page.locator(".unit .assign .chip").nth(1)).toHaveText("老师讲解 / 语言点");

    // 两类都标完之后，引导必须说明参考译文**可以跳过**（而不是把它当必填）
    await expect(action(page)).toContainText("课程参考译文");
    await expect(action(page)).toContainText("如果这份练习没有参考译文，可以跳过。");

    // 三行文字标签必须各自可见 —— 颜色之外还有第二编码通道
    await expect(page.locator(".line.source .mark").first()).toHaveText("原文");
    await expect(page.locator(".line.notes .mark").first()).toHaveText("讲解");
  });

  test("**撤销上一步 / 取消这个标记**都能从真实点击中生效", async ({ page }) => {
    await openAnnotation(page);
    await start(page);
    await page.getByRole("button", { name: "+ 新建一份翻译练习" }).click();
    await markRange(page, "中文原文", 1, 4);
    await expect(page.locator(".unit .assign")).toHaveCount(1);

    // 撤销
    await page.getByRole("button", { name: "撤销上一步" }).click();
    await expect(page.locator(".unit .assign")).toHaveCount(0);
    await expect(page.locator(".line.source")).toHaveCount(0);
    await expect(page.locator("#banner")).toContainText("已经撤销上一步");

    // 重新标一条，再用"点那一行 → 取消这个标记"删掉
    await markRange(page, "中文原文", 1, 4);
    await expect(page.locator(".unit .assign")).toHaveCount(1);
    await page.locator(".line").nth(1).click();
    await expect(page.locator("#banner")).toContainText("已经标成「中文原文」");
    await page.getByRole("button", { name: "取消这个标记" }).click();
    await expect(page.locator(".unit .assign")).toHaveCount(0);
    await expect(page.locator("#banner")).toContainText("这个标记已经取消");
  });

  test("**重复标记给出人话纠正**，且保存被自己的检查拦住（不发写请求）", async ({ page }) => {
    await openAnnotation(page);
    await start(page);
    await page.getByRole("button", { name: "+ 新建一份翻译练习" }).click();

    const writes: string[] = [];
    page.on("request", (request) => {
      if (request.method() === "POST") writes.push(request.url());
    });

    await markRange(page, "中文原文", 1, 4);
    await markRange(page, "老师讲解", 3, 6); // 第 3、4 行被标两次

    await expect(page.locator(".line.overlap")).toHaveCount(2);
    await expect(page.locator("#progress")).toContainText("有 2 处内容被重复标记，需要处理");
    await expect(page.locator("#issues")).toContainText("这几行已经被标成其他内容，请先取消原来的标记。");

    // 正常可见文字里不得出现 overlap 这个词
    const visible = await page.locator("main").innerText();
    expect(visible).not.toContain("overlap");

    await page.getByRole("button", { name: "检查并保存" }).click();
    await expect(page.locator("#banner")).toContainText("请先取消原来的标记");
    await expect(page.locator("#done")).toBeHidden();
    expect(writes, "有重复标记时不得发出写请求").toEqual([]);

    await shot(page, "annotation-overlap-feedback");
  });

  test("**检查并保存**走真实的认证保存路径，并给出可关闭页面的成功画面", async ({ page }) => {
    await openAnnotation(page);
    await start(page);

    const writes: { url: string; token: string | undefined; body: string | undefined }[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST") return;
      writes.push({
        url: request.url(),
        token: request.headers()["x-cet6-session-token"],
        body: request.postData() ?? undefined,
      });
    });

    await saveMinimalPlan(page);

    // 成功画面必须出现，且明确告诉人可以关页面
    const done = page.locator("#done");
    await expect(done).toBeVisible();
    await expect(done).toContainText("✓ 已保存");
    await expect(done).toContainText("现在可以关闭这个页面。");
    await expect(done).toContainText("回到 ChatGPT 告诉我：“翻译分段已保存”。");

    // 必须真的发出了一次带 token 的写请求
    expect(writes.length, "必须恰好发出一次写请求").toBe(1);
    expect(writes[0].url).toContain("/api/plan");
    expect(writes[0].token, "写请求必须带会话 token 请求头").toBeTruthy();

    // 提交的仍是**内部通道名**（界面改了，数据契约没改）
    const body = JSON.parse(writes[0].body!) as {
      units: { title: string; kind: string; assignments: { channel: string; lineStart: number; lineEnd: number }[] }[];
    };
    expect(body.units[0].kind).toBe("translation_passage");
    expect(body.units[0].title, "标题就是界面上那句人的话").toBe("第 1 份练习");
    // 三页各一段原文（跨页夹具 ⇒ 三段，而不是硬凑成一段）
    expect(body.units[0].assignments.map((a) => a.channel)).toEqual(["source", "source", "source"]);
    expect(
      body.units[0].assignments.map((a) => `${a.lineStart}-${a.lineEnd}`),
      "每页一段，页内坐标必须正确",
    ).toEqual(["1-6", "1-4", "1-3"]);

    // 成功画面里**不得**夹带任何合成正文
    const doneText = (await done.innerText()) ?? "";
    expect(doneText).not.toContain("城市轨道交通");
    expect(doneText).not.toContain("合成中文原文");

    await shot(page, "annotation-saved");

    // 落盘的计划必须能被真实解析（**合成**计划，隔离在 .e2e 下）
    const saved = readFileSync(E2E_ANNOTATION_PLAN_PATH, "utf8");
    const plan = JSON.parse(saved) as { schemaVersion: number; binding: { sourceDigest: string }; units: unknown[] };
    expect(plan.schemaVersion, "落盘计划必须带契约版本").toBe(1);
    expect(plan.binding.sourceDigest.length, "必须绑定源快照摘要").toBe(64);
    expect(plan.units.length).toBe(1);
    // 计划里没有正文、没有绝对路径
    expect(saved).not.toContain("城市轨道交通");
    expect(saved).not.toContain("合成中文原文");
    expect(/[A-Za-z]:\\/.test(saved), "计划里不得有绝对路径").toBe(false);
  });

  test("成功之后**回到 ChatGPT 只说一句话**，且页面上没有多余的技术信息抢视线", async ({ page }) => {
    await openAnnotation(page);
    await start(page);
    await saveMinimalPlan(page);
    await expect(page.locator("#done")).toBeVisible();

    // 校验和 / 源摘要 / 坐标这些**证据**仍然存在，但收在折叠区里
    const advanced = page.locator("details.advanced");
    await expect(advanced).toBeVisible();
    await expect(advanced).not.toHaveAttribute("open", "");

    // 未展开时，这些技术信息不得出现在正常视线里
    await expect(page.locator("#planDigest")).toBeHidden();

    // 展开之后证据一条不少
    await advanced.locator("summary").click();
    await expect(page.locator("#planDigest")).toBeVisible();
    await expect(page.locator("#planDigest")).toContainText("计划校验和");
    await expect(page.locator("#advancedBody")).toContainText("synthetic-annotation-course");
    await expect(page.locator("#advancedBody")).toContainText("synthetic-fixture-asset");
  });

  test("成功画面**真的出现在眼前**：点完底部的保存按钮后，成功提示必须在视口内", async ({ page }) => {
    /*
     * ── 这条守的是实测评审查出的一个反馈缺陷 ──
     *
     * 「检查并保存」按钮在侧栏**底部**，而成功面板在侧栏**顶部**。
     * 使用者 点保存时侧栏往往已经滚到底 —— 成功提示于是渲染在**视野之外**，
     * 看起来像"点了没反应"。保存其实成功了，人却以为没成。
     *
     * 因此这里断言的**不是**"面板存在"，而是"面板在视口内可见"。
     * 在 jsdom 里没有布局，这条只有在真实浏览器里才成立。
     */
    await openAnnotation(page);
    await start(page);

    // 先把侧栏滚到底部，模拟"人一路标下来、停在保存按钮那里"的真实姿势
    await page.locator("aside").evaluate((el) => { el.scrollTop = el.scrollHeight; });

    await saveMinimalPlan(page);

    const done = page.locator("#done");
    await expect(done).toBeVisible();
    // 面板必须进入**视口**（不只是 DOM 里可见）
    await expect(done).toBeInViewport();
    await expect(done).toContainText("✓ 已保存");
    await expect(done).toContainText("现在可以关闭这个页面。");
  });

  test("整个流程**不产生任何外部网络请求**（零外部资源、无分析、无 CDN）", async ({ page }) => {
    const { external } = await openAnnotation(page);
    await start(page);
    await saveMinimalPlan(page);
    await expect(page.locator("#done")).toBeVisible();

    expect(external, `不得有任何外部请求，实际：${external.join("、")}`).toEqual([]);
  });

  test("页面**不做任何数据库/产品路由跳转**（它只是本机标注工具）", async ({ page }) => {
    const errors = attachErrorCollectors(page);
    await openAnnotation(page);
    await start(page);
    await saveMinimalPlan(page);
    await expect(page.locator("#done")).toBeVisible();

    // 整个过程必须停在同一个标注页面里
    expect(page.url().startsWith("http://127.0.0.1:3240/")).toBe(true);
    expect(page.url()).not.toContain("#token=");

    expect(errors.pageErrors, "整个流程不得有未捕获异常").toEqual([]);
    expect(errors.consoleErrors, "整个流程不得有 console 错误").toEqual([]);
  });

  test("窄视口下四类控件与主操作仍然可见（可能用笔记本或分屏）", async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openAnnotation(page);
    await start(page);
    await page.getByRole("button", { name: "+ 新建一份翻译练习" }).click();

    await expect(page.locator("#channelBtns .cat-name").first()).toBeVisible();
    await expect(page.getByRole("button", { name: "检查并保存" })).toBeVisible();
    await expect(page.locator("#guideAction")).toBeVisible();

    await shot(page, "annotation-narrow-viewport");
  });
});
