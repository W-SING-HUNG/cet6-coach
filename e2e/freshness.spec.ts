import { test, expect } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot } from "./helpers";
import {
  E2E_FRESHNESS_BASE_URL,
  E2E_FRESHNESS_PRISTINE_PAPER_ID,
  E2E_FRESHNESS_EXPOSED_PAPER_ID,
  E2E_FRESHNESS_UNCERTAIN_PAPER_ID,
} from "./config";
import { explainPaperFreshness } from "../src/domain/paper-freshness";

/**
 * pristine 新鲜度的**权威措辞**，直接由 domain 纯函数求得。
 *
 * ── 为什么不写成断言里的字面量副本（关键）──
 *
 * 缺陷的形态是"页面**自己写**了一段 pristine 文案"，而不是"文案写错了"。
 * 因此判据必须能回答："页面上渲染的，是不是 domain 那**同一份**措辞？"
 *
 * 若把期望文案复制成字面量，那么有人改了 domain 措辞、页面也跟着抄一份
 * （或反之），断言仍会通过 —— 而**平行维护两份文案**正是缺陷本身。
 * 因此这里直接计算 domain 的输出，再断言页面**逐字包含**它。
 * 这样只有"页面确实渲染了权威措辞"才能通过。
 */
const PRISTINE_EXPLANATION = explainPaperFreshness({
  paperId: E2E_FRESHNESS_PRISTINE_PAPER_ID,
  state: "pristine",
  matches: [],
  unresolved: [],
});

/**
 * 模考**新鲜度**在界面上的真实呈现（浏览器级验证）。
 *
 * ── 被验收的那个状态 ──
 *
 * 专用实例（端口 3250，`scripts/e2e-server-freshness.ts`）把三份**合成夹具**
 * 试卷全部设为「模考保留」，并构造出三种新鲜度：
 *
 * | 试卷 | 状态 | 界面必须表现 |
 * | --- | --- | --- |
 * | 2023-06 set1 | `pristine` | 不出现任何"已接触"提示 |
 * | 2024-12 set1 | `exposed` | 明确说"已在课程中接触过"，且**不是**严格未见模考 |
 * | 2024-12 set2 | `uncertain` | 明确说"无法确认"，**不得**被呈现为 pristine |
 *
 * ── 为什么必须是独立的数据库实例 ──
 *
 * 主 E2E 实例的库里根本没有课程包、链接与曝光 —— 在那里造不出这个状态；
 * 而它的库被全部 spec 共享，临时造状态会给别的 spec 留副作用，
 * 也会让本 spec 退化成顺序依赖（同一个根因）。
 *
 * ── 内容策略 ──
 *
 * 这里出现的每一份试卷 `sourceKind` 恒为 `test_fixture`，课程 provider 恒为
 * `test_fixture_provider`。断言明确要求界面**标注**它是测试夹具 ——
 * 若夹具能在 UI 上冒充真题，那正是内容策略被破坏的证据。
 *
 * 全程使用 `baseURL: E2E_FRESHNESS_BASE_URL` 覆盖，因此不会误打到主实例。
 */

const PRISTINE = E2E_FRESHNESS_PRISTINE_PAPER_ID;
const EXPOSED = E2E_FRESHNESS_EXPOSED_PAPER_ID;
const UNCERTAIN = E2E_FRESHNESS_UNCERTAIN_PAPER_ID;

/** 该实例上的所有请求都打到 3250 —— 不与主实例共享任何状态。 */
test.use({ baseURL: E2E_FRESHNESS_BASE_URL });

test.describe("模考新鲜度：三种状态在真题库中如实呈现", () => {
  test("列表页：已接触与无法确认**可见**，未接触不产生噪声", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/practice/papers");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1").first()).toContainText("真题库");

    // 三份夹具都在，且来源类型必须显式标注（夹具绝不能看起来像真题）。
    expect(await page.getByText("测试夹具", { exact: true }).count()).toBeGreaterThan(0);
    await expect(page.getByText("历年真题", { exact: true })).toHaveCount(0);

    /*
     * ── 已接触：徽标 + 一段"为什么" ──
     *
     * 徽标只有三五个字，回答不了"为什么它不再是严格未见模考" ——
     * 而那是 UX 验收明确要求的。因此这里同时断言两样都在：
     * 徽标（"已接触过相关内容"）与它旁边那段解释（"经人工核验的对应关系证明…"）。
     */
    await expect(page.getByText("已接触过相关内容").first()).toBeVisible();
    await expect(page.getByText(/经人工核验的对应关系证明/).first()).toBeVisible();

    // 必须说明"不代表会/不会做" —— 内容事实不得被读成能力判断。
    await expect(page.getByText(/不代表你会做或不会做/).first()).toBeVisible();

    // ── 无法确认：必须也可见，且与"已接触"是不同的说法 ──
    await expect(page.getByText("是否接触过无法确认").first()).toBeVisible();
    await expect(page.getByText(/系统目前/).first()).toBeVisible();

    await expectNoHorizontalOverflow(page, "freshness papers list");
    await shot(page, "freshness-01-list");

    expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("列表页：库级提示说明有几份保留卷已不再是严格未见", async ({ page }) => {
    await page.goto("/practice/papers");
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("有模考保留的试卷已不再是严格未见")).toBeVisible();
    // 计数必须与构造的状态一致（1 份 exposed + 1 份 uncertain）。
    await expect(page.getByText(/有 1 份保留卷的内容已通过课程材料接触过/)).toBeVisible();
    await expect(page.getByText(/另有 1 份无法确认是否仍未接触/)).toBeVisible();
  });

  test("详情页：已接触的保留卷**不是** pristine 模考，且池归属未被改写", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto(`/practice/papers/${EXPOSED}`);
    await page.waitForLoadState("networkidle");

    // ── 那条明确的事实陈述 ──
    await expect(page.getByText("这不是一份严格未见的模考卷")).toBeVisible();
    await expect(
      page.getByText(/已在课程中接触过相关真题内容，不再适合作为严格未见模考/).first(),
    ).toBeVisible();
    // 必须指出**具体是哪个部分**被接触过（用户要能理解为什么）。
    await expect(page.getByText(/已接触的目标/)).toBeVisible();
    await expect(page.getByText(/仔细阅读/).first()).toBeVisible();

    /*
     * ── Invariant 3：策略与事实并存 ──
     *
     * 池归属**没有**被系统改写（仍然是"模考保留"），
     * 而"严格未见模考资格"另有一块如实说明。
     * 两条结论必须同时可见 —— 系统不得悄悄把保留卷挪进训练池。
     */
    await expect(page.getByRole("button", { name: "模考保留", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect(page.getByText("严格未见模考资格")).toBeVisible();

    // ── 不得把事实说成缺陷，也不得给出掌握度/成绩暗示 ──
    const body = await page.locator("body").innerText();
    for (const forbidden of ["污染", "脏", "失效模考", "掌握度", "得分", "正确率", "弱项"]) {
      expect(body, `界面不得出现「${forbidden}」`).not.toContain(forbidden);
    }

    await expectNoHorizontalOverflow(page, "freshness paper detail exposed");
    await shot(page, "freshness-02-detail-exposed");

    expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("详情页：无法确认的保留卷**不得**被呈现为 pristine", async ({ page }) => {
    await page.goto(`/practice/papers/${UNCERTAIN}`);
    await page.waitForLoadState("networkidle");

    // 必须给出"无法确认"的说明，而不是一个看起来一切正常的页面。
    await expect(page.getByText("无法确认这份卷子是否仍未接触")).toBeVisible();
    await expect(
      page.getByText(/无法确认是否仍未接触，暂不作为严格模考/).first(),
    ).toBeVisible();
    // 且必须说明为什么无法确认（具体到包/链接层面）。
    await expect(page.getByText(/无法证明/).first()).toBeVisible();

    await shot(page, "freshness-03-detail-uncertain");
  });

  test("详情页：未接触的保留卷**不**出现任何「已接触」提示，且显示证据范围限定", async ({ page }) => {
    await page.goto(`/practice/papers/${PRISTINE}`);
    await page.waitForLoadState("networkidle");

    // 它是保留卷，因此"模考保留"徽标在。
    await expect(page.getByText("模考保留", { exact: true }).first()).toBeVisible();
    // 但它尚未接触：因此不得出现暴露/不确定的提示。
    await expect(page.getByText("这不是一份严格未见的模考卷")).toHaveCount(0);
    await expect(page.getByText("无法确认这份卷子是否仍未接触")).toHaveCount(0);
    await expect(page.getByText(/已接触过相关真题内容/)).toHaveCount(0);

    // 而"严格未见模考资格"区块应说明它当前合格。
    await expect(page.getByText("严格未见模考资格")).toBeVisible();

    /*
     * ── 必须渲染 domain 的**权威**措辞，逐字相同 ──
     *
     * 这条断言是本轮缺陷的回归判据：详情页原先在合格分支里自己写了一段
     * pristine 文案，而 `FreshnessNotice` 对 pristine 返回 null ——
     * 于是 domain 里那句**证据范围限定**永远不会被渲染。
     *
     * 期望值由 domain 函数**现算**（见文件顶部 PRISTINE_EXPLANATION），
     * 不是字面量副本。因此只有"页面真的渲染了权威措辞"才能通过：
     * 改 domain 而不同步页面、或页面平行维护自己的文案，都会立刻失败。
     */
    const panelText = await page.locator("section", { hasText: "备考归属" }).first().innerText();
    expect(
      panelText,
      "pristine 详情页必须逐字渲染 domain 的权威措辞",
    ).toContain(PRISTINE_EXPLANATION);

    await shot(page, "freshness-04-detail-pristine");
  });

  test("详情页：pristine 证据范围限定必须**可见**，且无重复或标点异常（A 回归）", async ({
    page,
  }) => {
    /*
     * ── 本用例对应评审的 A 项 ──
     *
     * 核心是那句**证据范围限定**：结论的依据只是"本系统内"的记录，
     * 系统**无权**断言学习者在现实世界从未见过这份材料。
     *
     * 判据全部落在**渲染后的文本**上（innerText），而不是源码字符串 ——
     * 页面上到底写了什么，只有这里能证明。
     */
    await page.goto(`/practice/papers/${PRISTINE}`);
    await page.waitForLoadState("networkidle");

    const section = page.locator("section", { hasText: "备考归属" });
    const panelText = await section.first().innerText();

    /*
     * ① 证据范围限定必须**逐字**出现（期望值由 domain 现算，不是副本）。
     *
     * 这一条同时覆盖两件事：限定在不在，以及它是不是**权威那一份**。
     */
    expect(panelText, "pristine 区块必须逐字包含 domain 的权威措辞").toContain(
      PRISTINE_EXPLANATION,
    );

    // ② 限定必须语义完整：说明依据只来自本应用，且不代表别处。
    expect(panelText, "缺少「本应用」这一依据范围说明").toContain("本应用");
    expect(
      panelText,
      "必须说明它不代表别处的情况（否则读起来像绝对断言）",
    ).toMatch(/不代表[\s\S]{0,16}别的地方/);

    // ③ 不得出现系统**无权作出**的绝对断言。
    for (const overreach of ["完全未见过", "从未见过这份材料"]) {
      expect(
        panelText.includes(overreach) && !/不代表|不是|并非|无法|不能/.test(panelText),
        `pristine 区块不得在肯定语境下断言「${overreach}」`,
      ).toBe(false);
    }

    // ④ 不得残留旧硬编码文案（证明 JSX 已改为消费 domain 措辞）。
    expect(
      panelText,
      "不得残留页面自带的 pristine 解释（应改为 domain 权威措辞）",
    ).not.toContain("系统没有发现任何已核验的既往接触记录");

    // ⑤ 同一份权威措辞不得被渲染两次（重复渲染）。
    const occurrences = panelText.split(PRISTINE_EXPLANATION).length - 1;
    expect(occurrences, "pristine 权威措辞在同一区块内不得重复渲染").toBe(1);

    // ⑤ 标点与标记纪律（沿用语料级回归的同一组判据）。
    const body = await page.locator("body").innerText();
    expect(body, "渲染文本不得含 Markdown 标记").not.toContain("**");
    for (const bad of ["。。", "。；", "；。", "，，", "、、"]) {
      expect(body, `渲染文本含重复标点「${bad}」`).not.toContain(bad);
    }

    await shot(page, "freshness-06-pristine-caveat");
  });

  test("训练池 CTA 无回归：保留卷仍不提供训练入口，且说明原因", async ({ page }) => {
    /*
     * 本阶段**只**新增事实呈现，不得改动池策略的任何既有行为。
     * 保留卷（无论新鲜度如何）都不提供作答训练入口。
     */
    for (const paperId of [PRISTINE, EXPOSED, UNCERTAIN]) {
      await page.goto(`/practice/papers/${paperId}`);
      await page.waitForLoadState("networkidle");

      await expect(
        page.getByText(/这份试卷被设为模考保留|不提供作答训练/).first(),
        `${paperId} 应说明为何不能作答`,
      ).toBeVisible();

      // 不含"开始训练"入口（那是训练池才有的）。
      await expect(page.getByRole("link", { name: "开始训练" })).toHaveCount(0);
    }
  });

  test("Practice 页：保留区块标注新鲜度，且普通训练入口无回归", async ({ page }) => {
    await page.goto("/practice");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1").first()).toContainText("练习");

    // 保留区块存在，且列出的卷子上带新鲜度标注。
    await expect(page.getByRole("heading", { name: "模考保留" })).toBeVisible();
    await expect(page.getByText("已接触过相关内容").first()).toBeVisible();
    await expect(page.getByText("是否接触过无法确认").first()).toBeVisible();

    // 保留区块的说明必须解释这些标注的含义（否则用户不知道那是什么意思）。
    await expect(page.getByText(/不代表你会做或不会做这些题/).first()).toBeVisible();

    await expectNoHorizontalOverflow(page, "freshness practice");
    await shot(page, "freshness-05-practice");
  });

  test("措辞纪律：不得出现污染/掌握度语言，也不得暗示能力结论", async ({ page }) => {
    for (const path of ["/practice", "/practice/papers", `/practice/papers/${EXPOSED}`]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").innerText();

      for (const forbidden of [
        "污染",
        "tainted",
        "contaminated",
        "dirty",
        "掌握度",
        "正确率",
        "弱项",
        "能力分",
      ]) {
        expect(body, `${path} 不得出现「${forbidden}」`).not.toContain(forbidden);
      }
    }
  });

  test("措辞纪律：**渲染后的文本**不得含 Markdown 标记或重复标点（B1）", async ({ page }) => {
    /*
     * ── 这是 B1 缺陷的浏览器级回归 ──
     *
     * 缺陷形态：文案里写了 `**强调**`，而 React 把字符串当纯文本渲染 ——
     * 于是用户看到的是带星号的字面字符。这是**内容错误**，不是样式问题。
     *
     * 另一类是拼装引入的重复标点：子句自带句号时
     * `join("；") + "。"` 会产出 `。；` 与 `。。`。
     *
     * ── 为什么必须在浏览器里断言 ──
     *
     * domain 层的字符串断言证明不了"页面上真的没渲染出来"：
     * 页面可能对文本做了额外的包装或拼接。因此这里取**渲染后的 innerText** ——
     * 也就是用户真正看到的那串字符。
     */
    const paths = [
      "/practice",
      "/practice/papers",
      `/practice/papers/${EXPOSED}`,
      `/practice/papers/${UNCERTAIN}`,
      `/practice/papers/${PRISTINE}`,
    ];

    for (const path of paths) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const body = await page.locator("body").innerText();

      // 原始 Markdown 强调标记：渲染后绝不应当出现。
      expect(body, `${path} 渲染出的文本含 Markdown 标记 **`).not.toContain("**");
      // 行内代码反引号同理（`**` 之外最常见的泄漏形态）。
      expect(body, `${path} 渲染出的文本含行内代码标记`).not.toContain("`");

      // 重复 / 矛盾标点（拼装缺陷的可见形态）。
      for (const bad of ["。。", "。；", "；。", "，，", "、、"]) {
        expect(body, `${path} 渲染出的文本含重复标点「${bad}」`).not.toContain(bad);
      }
    }
  });

  test("无第六个底部导航项（信息架构不变）", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/practice/papers");
    await page.waitForLoadState("networkidle");

    const nav = page.getByRole("navigation", { name: "主导航" });
    await expect(nav).toBeVisible();
    // 既有的 5 项：Today / 练习 / 复习 / 进度 / 设置。
    expect(await nav.getByRole("link").count()).toBe(5);

    // 移动端底部导航不得与内容重叠到不可用（页面底部留白必须足够）。
    await expectNoHorizontalOverflow(page, "freshness mobile bottom nav");
  });
});

test.describe("模考新鲜度：响应式", () => {
  for (const viewport of [
    { name: "mobile", width: 390, height: 844 },
    { name: "desktop", width: 1440, height: 900 },
  ] as const) {
    test(`${viewport.name} ${viewport.width}×${viewport.height}：三份卷子三个层级都无横向溢出`, async ({
      page,
    }) => {
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: viewport.width, height: viewport.height });

      for (const path of [
        "/practice/papers",
        `/practice/papers/${PRISTINE}`,
        `/practice/papers/${EXPOSED}`,
        `/practice/papers/${UNCERTAIN}`,
      ]) {
        await page.goto(path);
        await page.waitForLoadState("networkidle");
        await expect(page.locator("h1").first()).toBeVisible();
        await expectNoHorizontalOverflow(page, `${viewport.name} ${path}`);
      }

      // 关键提示在窄屏下仍然可读（不是被截断的徽标）。
      await page.goto(`/practice/papers/${EXPOSED}`);
      await page.waitForLoadState("networkidle");
      await expect(
        page.getByText(/已在课程中接触过相关真题内容，不再适合作为严格未见模考/).first(),
      ).toBeVisible();

      await shot(page, `freshness-${viewport.name}-responsive`);

      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    });
  }
});
