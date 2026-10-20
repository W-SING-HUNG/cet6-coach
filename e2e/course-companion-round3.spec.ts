import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import {
  E2E_COMPANION_BASE_URL,
  E2E_COMPANION_COURSE_ID,
  E2E_COMPANION_LINKED_PAPER_ID,
} from "./config";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot } from "./helpers";
import { REVEAL_ROUTE_PATH } from "../src/lib/course-reveal-route";

/**
 * Round 3 独立审查所复现的**真实绕过**的回归测试。
 *
 * ── 被复现的缺陷（P0）──
 *
 * 服务端 409 响应里的 `risk.papers` 只带三个字段
 * （`paperId` / `reservedForMock` / `trainable`），而客户端用一句
 * **未校验的 TypeScript 断言**把它当成 `LinkedPaperSummary[]`
 * （那个类型还要求 `runtimeUsable` 与 `targetLabel`）。于是：
 *
 * 1. `runtimeUsable` 是 `undefined` ⇒ `usableLinks` 变空；
 * 2. 确认面板消失（显示条件也是"有可用链接"）；
 * 3. 客户端已采纳服务端回传的**新**指纹；
 * 4. 再点一次「看这段」⇒ 走 `usableLinks.length === 0` 那条捷径 ⇒
 *    直接 POST 新指纹；
 * 5. 模考保留卷在**没有任何知情确认**的情况下被写成 `reveal_requested`，
 *    该卷因此变成 `uncertain`、失去严格未见模考资格。
 *
 * ── 本文件怎么证明修好了 ──
 *
 * 用真实浏览器交互（不是 `page.evaluate` 发裸 fetch）走完完整旅程，
 * 并在关键节点用**独立的合成库查询**核对曝光行数 ——
 * "零曝光"必须由库里的事实证明，而不是由界面说了算。
 *
 * 状态的**变更**（新建链接）由 `scripts/e2e-companion-mutate.ts` 完成：
 * 浏览器没有写库权限，而"页面已渲染之后风险变了"正是本场景的核心。
 * 它只操作 `.e2e/` 下的合成库（脚本自己强制这一点）。
 *
 * ── 内容策略 ──
 *
 * 全部是**合成夹具**。本文件不碰 `private-content/`、不碰 `data/cet6.db`、
 * 不运行 `e2e:real`。
 */

test.use({ baseURL: E2E_COMPANION_BASE_URL });

/** 走合成状态变更工具（同步执行，失败即抛）。 */
function mutate(...args: string[]): string {
  return execFileSync(
    process.execPath,
    [
      "--experimental-transform-types",
      "--import",
      "./scripts/alias-loader.mjs",
      "scripts/e2e-companion-mutate.ts",
      ...args,
    ],
    { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
  ).trim();
}

/** 当前曝光行数（**独立**读合成库）。 */
function exposureCount(): number {
  return (JSON.parse(mutate("exposures")) as { count: number }).count;
}

/** 某段当前的风险状态（服务端口径）。 */
function riskState(segmentId: string): {
  fingerprint: string;
  risky: boolean;
  requiresConfirmation: boolean;
  papers: Array<{
    paperId: string;
    paperTitle: string;
    targetLabel: string;
    runtimeUsable: boolean;
    reservedForMock: boolean;
  }>;
} {
  return JSON.parse(mutate("state", segmentId));
}

/** 某份卷的新鲜度状态。 */
function freshness(paperId: string): { state: string; unresolved: string[] } {
  return JSON.parse(mutate("uncertain", paperId));
}

/**
 * 让**页面渲染之后**风险发生变化，从而让随后的 POST 得到 409。
 *
 * ── 为什么需要一个专门的辅助 ──
 *
 * 409 的前提是"页面拿到指纹时的状态 ≠ POST 时的状态"。因此每个需要 409
 * 的用例都必须：① 先让页面加载；② 再改变风险；③ 才发起请求。
 * 把这三步写成一个函数，避免某个用例漏掉第 ② 步而"因为错误的理由变绿"
 * （实测踩到：漏掉第 ② 步时断言 `风险状态已变化` 会因为找不到元素而失败，
 * 而那与守卫无关）。
 *
 * 变化方式用**池归属**（训练 ⇄ 模考保留）：它是可逆的，且不影响
 * 其它用例依赖的链接存在性。
 */
async function renderThenChangeRisk(
  page: import("@playwright/test").Page,
  segmentId: string,
): Promise<void> {
  /*
   * ⓪ 确保这个段**确实**有已核验链接 —— 否则改动池归属不会改变指纹，
   *    也就不会产生 409，用例会因为"找不到提示"而超时。
   *
   * 这一步让用例可以**单独运行**（`-g "④"`），而不是依赖前面的用例
   * 先建好链接。实测踩到：缺这一步时，单独跑会因为错误的失败原因变红。
   */
  if (riskState(segmentId).papers.length === 0) {
    mutate("link", segmentId, E2E_COMPANION_LINKED_PAPER_ID, SECTION_BY_SEGMENT[segmentId] ?? "writing");
  }

  // ① 先确保是"训练池"——一个与最终状态不同的起点。
  mutate("pool", E2E_COMPANION_LINKED_PAPER_ID, "training");

  // ② 页面在这个状态下渲染并拿到指纹。
  await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/${segmentId}`);
  await page.waitForLoadState("networkidle");

  // ③ 渲染之后改成模考保留 ⇒ 风险事实变了。
  mutate("pool", E2E_COMPANION_LINKED_PAPER_ID, "mock_reserve");
}

/** 段 → 它对应的大题（建链接时需要给出具体目标）。 */
const SECTION_BY_SEGMENT: Record<string, string> = {
  "writing.1": "writing",
  "reading.b": "reading.careful_reading",
  "translation.1": "translation",
};

test.describe("Round 3 · 409 复确认绕过回归（P0）", () => {
  /*
   * 本组按顺序执行：它们共享同一个合成实例的状态（链接是有状态的）。
   * 串行是**故意**的 —— 每个用例都在前一个留下的状态上继续，
   * 而那正是真实使用中的形态。
   */
  test.describe.configure({ mode: "serial" });

  test("① 未匹配段：第一次点击**要求确认**，且不发起 POST", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);

    /*
     * 前提：`method.1` 没有被核验的对应关系。
     *
     * 刻意不用 `writing.1`：那个段现在**有**多个已核验目标
     * （P1-M 的多目标验收状态），因此它不再是"未匹配"的例子。
     * `method.1` 是夹具里唯一没有任何链接的段。
     */
    const before = riskState("method.1");
    expect(before.papers, "夹具的 method.1 起始必须未匹配").toEqual([]);
    expect(before.requiresConfirmation, "未匹配也必须要求确认（P1）").toBe(true);

    const exposuresBefore = exposureCount();

    /*
     * 监视揭示请求 —— 这一条是本用例的核心判据。
     * 用**监听**而不是"看结果"：即使请求被拒，它也算发生过了。
     */
    const revealRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(REVEAL_ROUTE_PATH)) revealRequests.push(request.method());
    });

    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/method.1`);
    await page.waitForLoadState("networkidle");

    const target = page.locator("body");
    await target.getByRole("button", { name: "看这段" }).first().click();

    // 第一次点击之后：确认面板出现，且**没有任何 POST**。
    const panel = page.locator("div", { hasText: "还没有已核验的对应关系" }).first();
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/并不证明|不.*证明/).first()).toBeVisible();
    expect(revealRequests, "第一次点击不得发起任何揭示请求").toEqual([]);
    expect(exposureCount(), "第一次点击不得写入曝光").toBe(exposuresBefore);

    // 取消 ⇒ 曝光仍不变。
    await page.getByRole("button", { name: "取消" }).click();
    await expect(panel).toBeHidden();
    expect(revealRequests, "取消不得发起请求").toEqual([]);
    expect(exposureCount(), "取消不得写入曝光").toBe(exposuresBefore);

    expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("② 页面渲染后变更链接 ⇒ 旧指纹被拒（409），零曝光", async ({ page }) => {
    const exposuresBefore = exposureCount();

    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/writing.1`);
    await page.waitForLoadState("networkidle");

    // 页面已经拿到"未匹配"的指纹。
    const atRender = riskState("writing.1");

    /*
     * ── 关键一步：页面渲染**之后**改变风险 ──
     *
     * 新建一条 verified 链接，指向一份**模考保留**的真题。
     * 这正是审查复现的场景：页面以为"没有风险"，实际已经有了。
     */
    mutate("link", "writing.1", E2E_COMPANION_LINKED_PAPER_ID, "writing");
    const after = riskState("writing.1");
    expect(after.fingerprint, "新建链接必须改变指纹").not.toBe(atRender.fingerprint);
    expect(after.papers.length).toBe(1);

    /*
     * 学习者此刻点「看这段」并确认（带着**旧**指纹）。
     *
     * 因为页面渲染时的风险与现在不同，POST 必须被 409 拒绝。
     */
    await page.getByRole("button", { name: "看这段" }).first().click();
    // 页面此刻展示的仍是旧状态（无对应关系）—— 那是它渲染时的事实。
    await page.getByRole("button", { name: "确认阅读" }).click();

    // 服务端必须拒绝。
    await expect(page.getByText(/风险状态已变化/).first()).toBeVisible();
    expect(exposureCount(), "被拒的揭示不得写入曝光").toBe(exposuresBefore);
  });

  test("③ 更新后的警告必须**点名**具体卷子与目标", async ({ page }) => {
    await renderThenChangeRisk(page, "writing.1");

    await page.getByRole("button", { name: "看这段" }).first().click();
    await page.getByRole("button", { name: "确认阅读" }).click();

    await expect(page.getByText(/风险状态已变化/).first()).toBeVisible();

    /*
     * ── 这是 Round 3 P0 的核心断言 ──
     *
     * 上一版 409 的 `papers` 只有三个字段，界面拿不到可读名字，
     * 于是"更新后的警告"实际上什么也没说 —— 学习者被要求重新确认，
     * 却看不到他在确认什么。
     *
     * 现在必须点名：年份 + 场次 + **大题**（产品语言）。
     */
    const notice = page.locator("div", { hasText: "风险状态已变化" }).first();
    await expect(notice.getByText(/2024 年 12 月/).first()).toBeVisible();
    await expect(notice.getByText(/写作/).first()).toBeVisible();
    // 必须说明策略状态（会消耗保留材料）。
    await expect(notice.getByText(/模考保留/).first()).toBeVisible();

    // 不得暴露内部标识符。
    const noticeText = await notice.innerText();
    expect(noticeText, "警告不得暴露 section id").not.toContain("writing_template");
    expect(noticeText, "警告不得暴露试卷包 id").not.toContain(E2E_COMPANION_LINKED_PAPER_ID);
  });

  test("④ 再次点「看这段」**不经**显式确认 ⇒ 仍然不揭示、零曝光", async ({ page }) => {
    const exposuresBefore = exposureCount();

    /*
     * 本用例**自带**触发 409 的完整前提（渲染 → 变风险 → POST）。
     *
     * 刻意不依赖 ③ 留下的界面状态：这样单独跑这一个用例（`-g "④"`）
     * 也是有意义的。实测踩到：依赖前一个用例时，单独运行会让断言因为
     * "找不到按钮"而超时 —— 那是**错误的失败原因**，
     * 而错误的失败原因不能证明任何守卫。
     */
    await renderThenChangeRisk(page, "writing.1");

    // 先触发 409，让界面采纳服务端回传的新风险视图。
    await page.getByRole("button", { name: "看这段" }).first().click();
    await page.getByRole("button", { name: "确认阅读" }).click();
    await expect(page.getByText(/风险状态已变化/).first()).toBeVisible();
    expect(exposureCount(), "被拒的那次不得写入曝光").toBe(exposuresBefore);

    const revealRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(REVEAL_ROUTE_PATH)) revealRequests.push(request.method());
    });

    /*
     * ── 被复现的绕过就在这里 ──
     *
     * 上一版：409 之后界面因为把响应当成不完整形状而丢掉 `runtimeUsable`，
     * 于是"没有可用链接 ⇒ 直接提交"那条捷径被触发 —— 它带着已采纳的
     * 新指纹 POST，服务端认为已确认，保留卷被写成曝光。
     *
     * 现在：再次点击**只**打开确认面板，不发起任何请求。
     */
    await page.getByRole("button", { name: "看这段" }).first().click();
    // 面板重新出现（要求显式确认）—— 这一条本身就是绕过的反面判据。
    await expect(page.getByRole("button", { name: "确认阅读" })).toBeVisible();
    expect(revealRequests, "再次点击不得发起揭示请求").toEqual([]);
    expect(exposureCount(), "再次点击不得写入曝光").toBe(exposuresBefore);

    // 点「取消」同样不得写入。
    await page.getByRole("button", { name: "取消" }).click();
    expect(exposureCount(), "取消不得写入曝光").toBe(exposuresBefore);
    expect(revealRequests, "取消不得发起请求").toEqual([]);
  });

  test("⑤ 显式确认更新后的风险 ⇒ 200 + 恰好一条曝光；保留卷变 uncertain", async ({ page }) => {
    const exposuresBefore = exposureCount();

    await renderThenChangeRisk(page, "writing.1");

    // 触发 409 ⇒ 界面采纳新的风险视图。
    await page.getByRole("button", { name: "看这段" }).first().click();
    await page.getByRole("button", { name: "确认阅读" }).click();
    await expect(page.getByText(/风险状态已变化/).first()).toBeVisible();
    expect(exposureCount(), "被拒的那次不得写入曝光").toBe(exposuresBefore);

    // 打开更新后的确认面板并**显式确认**。
    await page.getByRole("button", { name: "看这段" }).first().click();
    await page.getByRole("button", { name: "确认阅读" }).click();

    // 正文出现（写作模板的合成正文）。
    await expect(page.getByText(/Fixture writing template/).first()).toBeVisible();

    // 恰好一条新曝光。
    expect(exposureCount(), "显式确认后必须恰好写入一条曝光").toBe(exposuresBefore + 1);

    /*
     * 保留卷因此变成 `uncertain` —— 而这一次是**合法且知情**的：
     * 学习者看到了点名到具体卷子与目标的警告，并显式确认过。
     */
    const after = freshness(E2E_COMPANION_LINKED_PAPER_ID);
    expect(after.state, "保留卷必须变 uncertain").toBe("uncertain");
    expect(after.unresolved, "原因必须是潜在接触，而不是已确认看过").toContain(
      "potential_contact_only",
    );
  });

  test("⑥ 刷新页面：持久化状态诚实呈现", async ({ page }) => {
    const exposuresBefore = exposureCount();

    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/writing.1`);
    await page.waitForLoadState("networkidle");

    /*
     * 刷新后徽标来自**服务端**（不是客户端状态）。
     *
     * 措辞必须是「请求过阅读」而不是「已看过」—— 请求不证明读过（P0-5）。
     */
    await expect(page.getByText("请求过阅读").first()).toBeVisible();
    await expect(page.getByText("已看过")).toHaveCount(0);

    // 正文不会因为刷新而自动展开（揭示是显式动作）。    await expect(page.getByText(/Fixture writing template/)).toHaveCount(0);

    // 刷新不产生新曝光。
    expect(exposureCount(), "刷新不得写入曝光").toBe(exposuresBefore);
  });
});

test.describe("Round 3 · 契约与边界变体", () => {
  test("无链接分段：确认面板如实说明「未匹配是合法状态」", async ({ page }) => {
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/method.1`);
    await page.waitForLoadState("networkidle");

    const state = riskState("method.1");
    expect(state.papers).toEqual([]);

    await page.getByRole("button", { name: "看这段" }).first().click();

    /*
     * 断言必须落在**确认面板**里，而不是页面上任意一处。
     *
     * 段级页面本身也有一段"目前没有已核验的对应关系"的说明
     * （那是页面级的上下文），若用全局 `getByText` 匹配，两者都会命中 ——
     * 于是这条用例会在"面板根本没出现"的情况下也通过（实测踩到）。
     */
    const panel = page.locator("div", { hasText: "还没有已核验的对应关系" }).first();
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/未匹配是合法状态/).first()).toBeVisible();
    // 必须明确"不是安全的证明"。
    await expect(panel.getByText(/并不证明|不.*证明/).first()).toBeVisible();
    // 确认与取消都在。
    await expect(panel.getByRole("button", { name: "确认阅读" })).toBeVisible();
    await expect(panel.getByRole("button", { name: "取消" })).toBeVisible();
  });

  test("链接失效（真题包读不到）⇒ 指纹变化并重新要求确认", async () => {
    const before = riskState("reading.b");
    expect(before.papers.length, "reading.b 起始应有链接").toBeGreaterThan(0);

    // 让这份真题包当前读不到 ⇒ 链接在运行时不再成立。
    mutate("hide-paper", E2E_COMPANION_LINKED_PAPER_ID);
    const after = riskState("reading.b");
    expect(after.papers, "包读不到时不得再报可用链接").toEqual([]);
    expect(after.fingerprint, "链接失效必须改变指纹").not.toBe(before.fingerprint);

    /*
     * 恢复（后续用例与其它 spec 依赖 reading.b 上有那条链接）。
     *
     * 用"包读不到"而不是"把核验状态改成 rejected"正是因为这一点：
     * 前者是可逆的，后者会在共享实例上留下永久状态。
     */
    mutate("show-paper", E2E_COMPANION_LINKED_PAPER_ID);
    const restored = riskState("reading.b");
    expect(restored.papers.length, "恢复包之后链接必须重新可用").toBeGreaterThan(0);
    expect(restored.fingerprint, "恢复后指纹必须回到原值").toBe(before.fingerprint);
  });

  test("池归属变化 ⇒ 指纹变化", async () => {
    const before = riskState("reading.b");
    expect(before.papers[0].paperId).toBe(E2E_COMPANION_LINKED_PAPER_ID);

    mutate("pool", E2E_COMPANION_LINKED_PAPER_ID, "training");
    const training = riskState("reading.b");
    expect(training.fingerprint, "池归属变化必须改变指纹").not.toBe(before.fingerprint);

    mutate("pool", E2E_COMPANION_LINKED_PAPER_ID, "mock_reserve");
    const reserved = riskState("reading.b");
    expect(reserved.fingerprint, "改回保留也必须改变指纹").not.toBe(training.fingerprint);
    expect(reserved.fingerprint, "回到原状态应恢复原指纹").toBe(before.fingerprint);
  });

  test("**畸形 409 响应** ⇒ 界面失败关闭，不采纳任何字段", async ({ page }) => {
    const exposuresBefore = exposureCount();

    /*
     * 拦截端点，返回**上一版的形态**（papers 只有三个字段）。
     *
     * 这正是"服务端将来漏一个字段"的模拟。客户端必须把它判为不可信，
     * 而**不是**当成"没有风险"然后放行。
     */
    await page.route(`**${REVEAL_ROUTE_PATH}`, async (route) => {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        headers: { "cache-control": "no-store" },
        body: JSON.stringify({
          ok: false,
          error: "风险状态已变化",
          code: "risk_changed",
          risk: {
            fingerprint: "a".repeat(64),
            risky: true,
            requiresConfirmation: true,
            unprovableReason: null,
            // ← 缺 runtimeUsable / targetLabel / paperTitle / unusableReason
            papers: [{ paperId: "p", reservedForMock: true, trainable: false }],
          },
        }),
      });
    });

    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/translation.1`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "看这段" }).first().click();
    await page.getByRole("button", { name: "确认阅读" }).click();

    // 必须给出"服务返回了无法识别的结果"，而不是显示一个不完整的风险面板。
    await expect(page.getByText(/无法识别|不完整/)).toBeVisible();
    // 且不得下发正文。
    await expect(page.getByText(/夹具用的合成中文段落/)).toHaveCount(0);
    expect(exposureCount(), "畸形响应不得导致曝光写入").toBe(exposuresBefore);
  });

  test("**网络错误** ⇒ 中文可操作提示 + 重试入口，且不显示浏览器原文", async ({ page }) => {
    const exposuresBefore = exposureCount();

    await page.route(`**${REVEAL_ROUTE_PATH}`, async (route) => {
      await route.abort("connectionrefused");
    });

    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/translation.1`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: "看这段" }).first().click();
    await page.getByRole("button", { name: "确认阅读" }).click();

    // 中文、可操作的说明。
    await expect(page.getByText(/没有连上本机服务|连接中断/).first()).toBeVisible();
    // 重试入口可用。
    await expect(page.getByRole("button", { name: "重试" })).toBeVisible();
    // 不得出现浏览器原文。
    const body = await page.locator("body").innerText();
    expect(body, "不得显示 Failed to fetch 这类浏览器原文").not.toContain("Failed to fetch");
    expect(body).not.toContain("TypeError");

    expect(exposureCount(), "网络失败不得写入曝光").toBe(exposuresBefore);
  });

  test("**重复请求**：同一次已确认风险可以再次读取，但只留一条曝光", async ({ page }) => {
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/method.1`);
    await page.waitForLoadState("networkidle");

    const before = exposureCount();

    // 第一次：显式确认。
    await page.getByRole("button", { name: "看这段" }).first().click();
    await page.getByRole("button", { name: "确认阅读" }).click();
    await expect(page.getByText(/夹具方法说明：这一段刻意没有页码锚点/).first()).toBeVisible();
    expect(exposureCount()).toBe(before + 1);

    // 收起后"再看这段"：同一次已确认风险 ⇒ 可以直接读取（不再要求确认）。
    await page.getByRole("button", { name: "收起" }).click();
    await page.getByRole("button", { name: "再看这段" }).first().click();
    await expect(page.getByText(/夹具方法说明：这一段刻意没有页码锚点/).first()).toBeVisible();

    // 幂等：仍然只有一条曝光。
    expect(exposureCount(), "同一次已确认风险的重复读取不得产生新曝光").toBe(before + 1);
  });

  /**
   * P1-M / Final P2：多目标的**渲染结构**必须正确。
   *
   * 独立审查复现的缺陷：`PaperTargetLine` 用 `" · "` 切分卷名与目标，
   * 而**卷名本身含 `" · "`**（`2024 年 12 月 · set1` 是标准形态：
   * 年份 · 场次 · 套别）。于是：
   *
   * - 卷名被截成 `2024 年 12 月`，**丢掉套别 `set1`**；
   * - `set1` 被当成第一个目标的一部分；
   * - 可能多出一个孤立的 bullet。
   *
   * 学习者看到"我确认的是 2024 年 12 月"—— 而库里有**好几套** 12 月卷子。
   * 这不是排版瑕疵，是**确认范围再次被写错**。
   *
   * ── 为什么这条测试查**结构**而不只是"名字出现过" ──
   *
   * 上一版只断言 `getByText(/第 1 组/)` 可见。那种断言在卷名被截错时
   * **照样通过**（"第 1 组"还在页面上，只是前面多了个 `set1 ·`）。
   * 因此这里断言 DOM 结构：标题元素里的**完整**卷名、bullet 的**精确**文本、
   * 以及 bullet 的数量。
   */
  test("P1-M · 多目标：确认面板的**渲染结构**正确（卷名含套别）", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/writing.1`);
    await page.waitForLoadState("networkidle");

    // 服务端口径：这个段有多个语义目标指向同一份卷子。
    const state = riskState("writing.1");
    expect(state.papers).toHaveLength(1);
    expect(state.papers[0].targetLabel).toMatch(/共 \d+ 个目标/);
    // 服务端下发的卷名**必须**含套别 —— 这是本用例的前提。
    expect(state.papers[0].paperTitle, "夹具卷名必须含套别 set1").toBe("2024 年 12 月 · set1");

    await page.getByRole("button", { name: /看这段|再看这段/ }).first().click();
    const panel = page.getByTestId("reveal-confirmation");
    await expect(panel).toBeVisible();

    /*
     * ① 卷名必须**完整**（含 `· set1`）。
     *
     * 判据用 `toHaveText` 精确匹配，而不是 `toContainText` ——
     * 后者在"2024 年 12 月 · set1 · 阅读 · 仔细阅读（第 1 组）"这种
     * 串上也会通过，而那正是缺陷形态（套别跑到了目标里）。
     */
    const titleLine = panel.locator("span.font-medium", { hasText: "2024 年 12 月" }).first();
    await expect(titleLine).toHaveText("2024 年 12 月 · set1");

    /*
     * ② 每一个 bullet 的文本必须**精确**匹配一个目标。
     *
     * 这是最关键的一条：缺陷形态下第一个 bullet 会是
     * `· set1 · 阅读 · 仔细阅读（第 1 组）` —— "set1" 混进了目标。
     * 用精确集合比对，任何杂质都会让断言失败。
     */
    const bullets = panel.locator("span.pl-3 > span", { hasText: "· " });
    const bulletTexts = (await bullets.allInnerTexts()).map((text) => text.trim());
    const cleaned = bulletTexts.map((text) => text.replace(/^·\s*/, "").trim());

    for (const target of cleaned) {
      expect(
        target,
        `bullet 里不得混入套别或卷名片段：${target}`,
      ).not.toContain("set1");
      expect(target, "bullet 不得混入卷名年份").not.toContain("2024");
    }

    // 每个目标都必须是「大题（粒度）」形态，而不是被拼坏的串。
    /*
     * 形态：`<大题名>（<粒度>）`，其中粒度是 `第 N 组` / `整个大题` /
     * `第 <题目 id> 题`。大题名本身可能含 ` · `（如 `阅读 · 仔细阅读`），
     * 因此**不**用 `" · "` 做任何切分 —— 只校验整体形态。
     */
    for (const target of cleaned) {
      expect(target, `目标描述形态不正确：${target}`).toMatch(
        /^.+（第 \d+ 组|整个大题|第 \S+ 题）$/,
      );
    }

    /*
     * ③ bullet 数量必须等于服务端的目标数。
     *
     * 缺陷形态会**多出**一个（`set1` 自己变成一个 bullet），
     * 因此"数量精确相等"是直接判据。
     */
    const expectedCount = Number(
      /共 (\d+) 个目标/.exec(state.papers[0].targetLabel)?.[1] ?? "0",
    );
    expect(
      cleaned.length,
      `bullet 数（${cleaned.length}）必须等于服务端目标数（${expectedCount}）`,
    ).toBe(expectedCount);

    /*
     * ④ 条数文本必须正确。
     * 用 `toHaveText` 精确匹配 —— 缺陷形态会显示错的数字或把 set1 算进去。
     */
    const countLine = panel.locator("span.text-content-faint", { hasText: "个目标" }).first();
    await expect(countLine).toHaveText(`共 ${expectedCount} 个目标`);

    /*
     * ⑤ 卷子只出现一次（不因多目标而重复出卡片）。
     * 判据是目标行只有一行 —— 用 testid 精确定位，不数卷名出现次数
     * （卷名在标题与计数说明里都会出现，实测数它会得到 2）。
     */
    await expect(panel.locator("ul").first().locator("> li")).toHaveCount(1);

    // 卷子级策略状态只显示一次。
    await expect(panel.getByText(/这份卷子被你设为模考保留/)).toHaveCount(1);

    // 不得暴露内部标识符。
    const panelText = await panel.innerText();
    expect(panelText, "不得暴露题组 id").not.toContain("reading.careful_reading#g1");
    expect(panelText, "不得暴露 section id").not.toContain("reading.careful_reading");
    expect(panelText, "不得暴露试卷包 id").not.toContain(E2E_COMPANION_LINKED_PAPER_ID);
  });

  test("P1-M · 多目标：**409 的更新警告**同样列出每一个目标", async ({ page }) => {
    /*
     * 三个界面（课程页 / 段级页 / 409 更新警告）必须显示**同一份**完整信息。
     * 这一条专门验证 409 那条路径 —— 它走的是同一个投影，
     * 但客户端拿的是线上一份 JSON，因此要单独证明一次。
     */
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/writing.1`);
    await page.waitForLoadState("networkidle");

    // 制造风险变化（池归属），从而得到 409。
    mutate("pool", E2E_COMPANION_LINKED_PAPER_ID, "training");
    await page.reload();
    await page.waitForLoadState("networkidle");
    mutate("pool", E2E_COMPANION_LINKED_PAPER_ID, "mock_reserve");

    await page.getByRole("button", { name: /看这段|再看这段/ }).first().click();
    await page.getByRole("button", { name: "确认阅读" }).click();
    await expect(page.getByText(/风险状态已变化/).first()).toBeVisible();

    const notice = page.locator("div", { hasText: "风险状态已变化" }).first();
    /*
     * 409 的更新警告走的是**线上一份 JSON**（服务端投影 ⇒ 契约校验 ⇒
     * 客户端渲染），因此它要与页面初渲染**同样正确**。这里用与初渲染
     * 同一条结构判据：完整卷名 + 精确 bullet + 正确条数。
     */
    await expect(notice.locator("span.font-medium", { hasText: "2024 年 12 月" }).first()).toHaveText(
      "2024 年 12 月 · set1",
    );

    const bullets = notice.locator("span.pl-3 > span", { hasText: "· " });
    const cleaned = (await bullets.allInnerTexts()).map((text) =>
      text.trim().replace(/^·\s*/, "").trim(),
    );
    const expectedCount = Number(
      /共 (\d+) 个目标/.exec(riskState("writing.1").papers[0].targetLabel)?.[1] ?? "0",
    );
    expect(
      cleaned.length,
      `409 警告的 bullet 数（${cleaned.length}）必须等于服务端目标数（${expectedCount}）`,
    ).toBe(expectedCount);
    for (const target of cleaned) {
      expect(target, `409 警告的 bullet 不得混入套别：${target}`).not.toContain("set1");
      expect(target, `409 警告的 bullet 不得混入卷名年份：${target}`).not.toContain("2024");
    }
    await expect(
      notice.locator("span.text-content-faint", { hasText: "个目标" }).first(),
    ).toHaveText(`共 ${expectedCount} 个目标`);
  });

  test("P1-M · 多目标：课程页（列表）也显示每一个目标", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    const row = page.locator("li", { hasText: "夹具写作模板" }).first();
    await expect(row).toBeVisible();

    await row.getByRole("button", { name: /看这段|再看这段/ }).first().click();
    const panel = page.getByTestId("reveal-confirmation");

    /*
     * 课程页（列表）与段级页用**同一个**组件，因此这里同样断言结构 ——
     * 特别是完整卷名（含套别），因为列表页的行宽更窄，更容易被截错。
     */
    await expect(panel.locator("span.font-medium", { hasText: "2024 年 12 月" }).first()).toHaveText(
      "2024 年 12 月 · set1",
    );
    const cleaned = (await panel.locator("span.pl-3 > span", { hasText: "· " }).allInnerTexts()).map(
      (text) => text.trim().replace(/^·\s*/, "").trim(),
    );
    for (const target of cleaned) {
      expect(target, `课程页 bullet 不得混入套别：${target}`).not.toContain("set1");
    }
    expect(cleaned.length).toBeGreaterThan(1);
    await expect(panel.locator("span.text-content-faint", { hasText: "个目标" }).first()).toBeVisible();
  });

  test("P1-M · 多目标：移动端 390px 不横向溢出且卷名完整", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/writing.1`);
    await page.waitForLoadState("networkidle");

    await page.getByRole("button", { name: /看这段|再看这段/ }).first().click();
    const panel = page.getByTestId("reveal-confirmation");
    await expect(panel.locator("span.text-content-faint", { hasText: "个目标" }).first()).toBeVisible();

    /*
     * 390px 上同样必须显示**完整**卷名。
     *
     * 窄屏是这套结构最容易出问题的地方：一行放不下时若靠 CSS 截断
     * （`truncate` / `overflow-hidden`），`set1` 会在视觉上消失 ——
     * 而那与"被切错"对学习者是一样的结果。因此这里在窄屏再断言一次。
     */
    await expect(panel.locator("span.font-medium", { hasText: "2024 年 12 月" }).first()).toHaveText(
      "2024 年 12 月 · set1",
    );

    await expectNoHorizontalOverflow(page, "companion multi-target mobile");
    await shot(page, "companion-multi-target-mobile");
  });
});
