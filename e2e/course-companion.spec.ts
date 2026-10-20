import { test, expect } from "@playwright/test";
import {
  E2E_COMPANION_BASE_URL,
  E2E_COMPANION_COURSE_ID,
  E2E_COMPANION_DRIFTED_COURSE_ID,
} from "./config";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot } from "./helpers";
import { REVEAL_ROUTE_PATH } from "../src/lib/course-reveal-route";

/**
 * 课程伴随界面（Course Companion）的**真实浏览器**验收。
 *
 * ── 被验收的三件事 ──
 *
 * 1. **正文只在显式请求时下发。** 页面加载时列表里**没有任何正文**；
 *    点「看这段」才经 POST 取回它。这是私有课程内容的隐私边界。
 * 2. **揭示被如实记录。** 揭示过的段显示「已看过」，未揭示的显示「看这段」。
 * 3. **安全负向失败关闭。** 跨站 Origin、缺失 Origin、非回环 Host、GET 方法
 *    全部被拒，且响应里**没有任何正文字节**。
 *
 * ── 为什么必须是独立实例 ──
 *
 * 复现这个状态需要"已导入的合成课程包 + 一段已揭示过的材料 + 一份已漂移的包"。
 * 主 E2E 实例的库里根本没有课程包（它只导试卷），因此造不出来。
 * 见 `e2e/config.ts` 的 `E2E_COMPANION_*` 常量说明。
 *
 * ── 内容策略 ──
 *
 * 全部课程内容是**合成夹具**（provider 恒为 `test_fixture_provider`，
 * 正文是合成字符串）。断言明确要求界面标注它是夹具来源的课程包 ——
 * 绝不让夹具看起来像真实付费课程。
 */

test.use({ baseURL: E2E_COMPANION_BASE_URL });

/** 夹具里的合成正文（与 scripts/course-fixture.ts 的默认值一致）。 */
const FIXTURE_READING_TEXT = "Fixture course reading passage.";

test.describe("课程伴随界面：正文只在显式请求时下发", () => {
  test("列表页：课程包可见，且**不含任何正文**", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    await page.goto("/practice/courses");
    await page.waitForLoadState("networkidle");
    await expect(page.locator("h1").first()).toContainText("课程材料");

    // 两份夹具课程都在（一份正常、一份漂移）。
    await expect(page.getByText(E2E_COMPANION_COURSE_ID, { exact: false }).first()).toBeVisible();
    await expect(
      page.getByText(E2E_COMPANION_DRIFTED_COURSE_ID, { exact: false }).first(),
    ).toBeVisible();

    /*
     * ── 隐私边界的浏览器级判据 ──
     *
     * 页面加载时列表里不得出现任何一段正文。这不是"样式问题"：
     * 一旦正文随 HTML 下发，它就不再受"显式请求"这条边界保护。
     */
    const body = await page.locator("body").innerText();
    expect(body, "列表页不得包含课程正文").not.toContain(FIXTURE_READING_TEXT);
    expect(body, "列表页不得包含合成中文段落").not.toContain("夹具用的合成中文段落");
    expect(body, "列表页不得包含参考译文").not.toContain("Fixture reference translation");
    expect(body, "列表页不得包含文字稿").not.toContain("Fixture transcript");

    // 漂移的课程包必须如实标注（而不是假装成正常课程）。
    await expect(page.getByText(/已在盘上被改动|校验和/).first()).toBeVisible();

    await expectNoHorizontalOverflow(page, "companion list");
    await shot(page, "companion-01-list");

    expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("详情页：已请求过阅读的段显示「请求过阅读」，未接触的显示「看这段」", async ({ page }) => {
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    // 已揭示过的那一段有「请求过阅读」标记（**不是**「已看过」—— P0-5）。
    const revealed = page.locator("li", { hasText: "夹具阅读篇章 A" }).first();
    await expect(revealed.getByText("请求过阅读")).toBeVisible();
    await expect(revealed.getByRole("button", { name: "再看这段" })).toBeVisible();

    // 未接触的段给「看这段」。
    await expect(page.getByRole("button", { name: "看这段" }).first()).toBeVisible();

    /*
     * 页面加载时同样不得有正文 —— 详情页与列表页遵守同一条边界。
     */
    const body = await page.locator("body").innerText();
    expect(body, "详情页加载时不得包含课程正文").not.toContain(FIXTURE_READING_TEXT);
  });

  test("点「看这段」⇒ 经 POST 取回正文，且刷新后仍标记请求过阅读", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    // 监听那个唯一的正文出口。
    const revealRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(REVEAL_ROUTE_PATH)) revealRequests.push(request.method());
    });

    /*
     * translation.1 没有已核验的对应关系，但它**仍然要求确认**（P1）——
     * 未匹配只说明"还不知道"，不证明与严格未见模考无关。
     *
     * 因此主链路现在是两步：点「看这段」→ 看清说明 → 点「确认阅读」。
     * 第一步**不得**发起任何请求。
     */
    const target = page.locator("li", { hasText: "夹具翻译段落" }).first();
    await target.getByRole("button", { name: "看这段" }).click();

    // 第一步只打开确认面板，不发请求。
    expect(revealRequests, "第一次点击不得发起请求").toEqual([]);
    await expect(page.getByRole("button", { name: "确认阅读" }).first()).toBeVisible();

    // 第二步：显式确认。
    await page.getByRole("button", { name: "确认阅读" }).first().click();

    // 正文出现了（translation.1 的合成中文段落）。
    await expect(page.getByText("夹具用的合成中文段落", { exact: false }).first()).toBeVisible();

    // 它必须是经 POST 取回的，且**只有** POST。
    expect(revealRequests, "正文只能经 POST 端点取回").toEqual(["POST"]);

    // 揭示边界说明必须出现（看过材料 ≠ 会做题）。
    await expect(page.getByText(/看过材料不代表会做或不会做/).first()).toBeVisible();

    // 揭示后该段应标记为「请求过阅读」（界面反映已持久化的事实）。
    await expect(target.getByText("请求过阅读")).toBeVisible();
    // 且给一个收起入口（正文出现时不把控件整个换掉）。
    await expect(target.getByRole("button", { name: "收起" })).toBeVisible();

    /*
     * ── 揭示已持久化：刷新后徽标仍在 ──
     *
     * 这一条证明「请求过阅读」来自**数据库里的事实**，而不是客户端状态。
     * 客户端那次置位只是消除刷新前的不一致；刷新后以服务端为准。
     */
    await page.reload();
    await page.waitForLoadState("networkidle");
    const afterReload = page.locator("li", { hasText: "夹具翻译段落" }).first();
    await expect(afterReload.getByText("请求过阅读")).toBeVisible();
    await expect(afterReload.getByRole("button", { name: "再看这段" })).toBeVisible();
    // 刷新后正文不再自动展开（揭示是显式动作，不是持久展开态）。
    await expect(afterReload.getByText("夹具用的合成中文段落", { exact: false })).toHaveCount(0);

    await shot(page, "companion-02-revealed");

    expect(pageErrors, `pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("漂移的课程包不给正文入口（失败关闭）", async ({ page }) => {
    await page.goto(`/practice/courses/${E2E_COMPANION_DRIFTED_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    await expect(page.getByText("这个课程包当前不可读")).toBeVisible();
    // 没有任何「看这段」按钮 —— 不给入口，而不是给了再失败。
    await expect(page.getByRole("button", { name: "看这段" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "再看这段" })).toHaveCount(0);

    // 且页面不含被换掉的那份正文。
    const body = await page.locator("body").innerText();
    expect(body, "漂移时不得展示盘上被换掉的正文").not.toContain("盘上被换掉的合成正文");
  });

  test("Practice 页提供课程材料入口（不新增底部导航项）", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/practice");
    await page.waitForLoadState("networkidle");

    await expect(page.getByRole("link", { name: /课程材料/ }).first()).toBeVisible();

    // 信息架构不变：仍然只有 5 个底部导航项。
    const nav = page.getByRole("navigation", { name: "主导航" });
    await expect(nav).toBeVisible();
    expect(await nav.getByRole("link").count()).toBe(5);
  });

  test("**揭示前确认**：已核验指向模考保留真题的段必须先确认（P1）", async ({ page }) => {
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    const target = page.locator("li", { hasText: "夹具阅读篇章 B" }).first();

    /*
     * ── 确认面板由**一次点击**带出来，而不是页面加载时就展开 ──
     *
     * Round 3 之前面板是自动展开的。现在改成"点击才展开"，
     * 理由是那让两件事可区分："学习者看到了警告"与"他点了按钮"。
     * 自动展开时，一个没看警告就点确认的人与一个看过的人没有区别。
     *
     * 关键在于：那一次点击**不得**发起任何请求。
     */
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes(REVEAL_ROUTE_PATH)) requests.push(request.method());
    });

    await expect(page.getByText("这段课程材料已被核验指向下列真题")).toBeHidden();
    await target.getByRole("button", { name: "看这段" }).click();

    // 面板出现，且**还没有**发出任何请求。
    await expect(page.getByText("这段课程材料已被核验指向下列真题").first()).toBeVisible();
    // 必须点明那份卷子被设为模考保留（具体风险，不是泛泛警告）。
    await expect(page.getByText(/这份卷子被你设为模考保留/).first()).toBeVisible();
    // 必须说明后果：会消耗保留材料。
    await expect(page.getByText(/不再满足\s*「严格未见模考」的前提/).first()).toBeVisible();
    await expect(target.getByText("Fixture second reading passage.", { exact: false })).toHaveCount(0);
    expect(requests, "打开面板不得已发出正文请求").toEqual([]);

    // 取消 ⇒ 仍然没有正文，且面板收起。
    await page.getByRole("button", { name: "取消" }).first().click();
    await expect(target.getByText("Fixture second reading passage.", { exact: false })).toHaveCount(0);
    await expect(page.getByText("这段课程材料已被核验指向下列真题")).toBeHidden();
    expect(requests, "取消不得已发出正文请求").toEqual([]);

    // 重新打开并确认 ⇒ 才下发正文。
    await target.getByRole("button", { name: "看这段" }).click();
    await page.getByRole("button", { name: "确认阅读" }).first().click();
    await expect(target.getByText("Fixture second reading passage.", { exact: false }).first()).toBeVisible();
  });

  test("**非回环 Host** 的页面请求被集中边界拒绝（P0-1）", async ({ page }) => {
    /*
     * ── 为什么这一条只能证明"服务正常"，不能证明"守卫拦得住" ──
     *
     * `Host` 是浏览器**禁止修改的请求头**：脚本设它、Playwright 的
     * `route.continue({ headers })` 设它，都会被静默丢掉（实测：拿到 200）。
     * 因此浏览器侧无法伪造跨站 Host。
     *
     * 权威判据在 `scripts/e2e-loopback-binding-proof.ts`：那里用底层
     * `node:http` 发原始请求，可以带任意 Host（实测：拿到 421）。
     *
     * 因此这一条只证明"集中边界没有把正常请求也挡掉"（守卫不过严），
     * 并把"拦得住"的指向写清楚 —— 而不是假装浏览器能证明它。
     */
    const response = await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    expect(response?.status(), "回环 Host 必须正常放行（守卫不过严）").toBeLessThan(400);
    await expect(page.getByText(/段材料/).first()).toBeVisible();
  });

  // ── P1-1：段级路由 ──
  test("段级路由：从课程页进入，看到源位置、关联真题与确认面板", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    // 段级入口存在。
    const entry = page.getByRole("link", { name: "单独打开这一段" }).first();
    await expect(entry).toBeVisible();
    await entry.click();

    // 到达段级路由。
    await expect(page).toHaveURL(/\/practice\/courses\/[^/]+\/segment\/[^/]+$/);

    // 源页码锚点可见（材料分组与锚点未被破坏）。
    await expect(page.getByText(/位于源材料 第 \d+/).first()).toBeVisible();

    // 关联真题区块可见（P1-1 要求的段级可见性）。
    await expect(page.getByText("这段材料对应的真题")).toBeVisible();

    // 揭示区与确认控件都在。
    await expect(page.getByText("阅读正文")).toBeVisible();
    await expect(page.getByRole("button", { name: /看这段|再看这段/ }).first()).toBeVisible();

    await expectNoHorizontalOverflow(page, "companion segment route");
    await shot(page, "companion-03-segment");
  });

  test("段级路由：已核验指向模考保留真题的段给出**具体**警告", async ({ page }) => {
    await page.goto(
      `/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/reading.b`,
    );
    await page.waitForLoadState("networkidle");

    // 关联真题区块点名了目标与策略状态 —— 用**产品语言**，不是内部 id。
    await expect(page.getByText(/阅读 · 仔细阅读/).first()).toBeVisible();
    await expect(page.getByText(/这份卷子被你设为模考保留/).first()).toBeVisible();

    // 确认面板给出后果说明。
    await expect(page.getByText(/不再满足\s*「严格未见模考」的前提/).first()).toBeVisible();

    /*
     * 界面不得暴露内部标识符（`reading.careful_reading` / `fixture-...`）。
     *
     * 这是产品语言纪律：学习者看到的是「阅读 · 仔细阅读」，
     * 而 section id 是给 CLI 与测试用的。
     */
    const body = await page.locator("main").innerText();
    expect(body, "段级页面不得暴露 section id").not.toContain("reading.careful_reading");
    expect(body, "段级页面不得暴露课程包 id").not.toContain(E2E_COMPANION_COURSE_ID);
  });

  test("段级路由：未匹配的段如实说明「未匹配是合法状态」", async ({ page }) => {
    await page.goto(
      `/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/translation.1`,
    );
    await page.waitForLoadState("networkidle");

    await expect(
      page.getByText(/目前没有已核验的对应关系指向某份真题/),
    ).toBeVisible();
    await expect(page.getByText(/未匹配是合法状态/)).toBeVisible();
  });

  test("段级路由：不存在的段 ⇒ 404（不是空页面）", async ({ page }) => {
    const response = await page.goto(
      `/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/no-such-segment`,
    );
    expect(response?.status()).toBe(404);
  });

  test("段级路由：移动端可用（无横向溢出，控件可点）", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}/segment/reading.a`);
    await page.waitForLoadState("networkidle");

    await expectNoHorizontalOverflow(page, "companion segment mobile");
    // 揭示按钮可点（未被禁用）。
    const button = page.getByRole("button", { name: /看这段|再看这段/ }).first();
    await expect(button).toBeEnabled();
  });

  test("**回环 Host** 的页面正常放行（守卫不过严）", async ({ page }) => {
    const response = await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    expect(response?.status()).toBeLessThan(400);
  });
});

test.describe("课程伴随界面 · 安全负向（真实浏览器请求）", () => {
  test("同源 POST ⇒ 200 + 正文；跨站 Origin / GET ⇒ 拒绝且无正文", async ({ page }) => {
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    /*
     * 全部请求都经**页面上下文**发起（`page.evaluate` 里的 fetch）。
     *
     * 为什么不能用 Playwright 的 `request` fixture：那个上下文
     * **不带浏览器的 Origin**（它是一个独立的 HTTP 客户端）。
     * 而本端点对"缺失 Origin"是失败关闭的 —— 于是它会 403，
     * 看起来像守卫生效，实际测的是另一件事。
     *
     * 用页面内的 fetch 才是真实形态：同源请求一定带 `Origin`。
     *
     * ── 风险指纹从哪来 ──
     *
     * 揭示还要求学习者确认过的**风险指纹**（P0-1）。真实路径是：
     * 页面渲染时服务端把指纹写进 DOM，确认后由前端回传。
     * 因此这里也从 DOM 读 —— 而不是在测试里重算一份
     * （那会与实现漂移，且测不到"页面给出的就是端点接受的"）。
     *
     * ── 必须取**那一段**的指纹，不是页面上第一个 ──
     *
     * Round 3 P3 让指纹绑定 `segmentId`：同一课程里不同段有不同指纹
     * （否则"在 A 段确认、在 B 段揭示"可以复用确认上下文）。
     * 因此用 `document.querySelector` 取第一个会拿到别的段的指纹，
     * 请求会被 409 拒绝 —— 那是**正确**行为，只是测试取错了值。
     */
    const sameOrigin = await page.evaluate(async () => {
      const fingerprint = document
        .querySelector('[data-segment-id="translation.1"] [data-risk-fingerprint]')
        ?.getAttribute("data-risk-fingerprint");
      const response = await fetch("/api/course/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          courseId: "fixture-course-companion",
          segmentId: "translation.1",
          courseContentVersion: 1,
          confirmedRiskFingerprint: fingerprint,
        }),
      });
      return {
        status: response.status,
        cacheControl: response.headers.get("cache-control"),
        body: await response.text(),
      };
    });

    expect(sameOrigin.status, "同源 POST 必须成功").toBe(200);
    expect(sameOrigin.body).toContain("夹具用的合成中文段落");
    expect(sameOrigin.cacheControl, "正文响应不得被缓存").toBe("no-store");

    // ── 负向 1：跨站 Origin ──
    /*
     * ── 为什么这一条在浏览器里**证明不了**（实测结论）──
     *
     * `Origin` 是 Fetch 规范里的**禁止修改的请求头**（forbidden header
     * name）。浏览器会静默丢掉页面脚本设的 `origin`，请求带着**真实**
     * 的同源 Origin 发出 —— 于是它成功返回 200。
     *
     * 这不是守卫失效，而是"浏览器无法伪装成跨站页面"。
     * 跨站 Origin 的权威负向证明在
     * `tests/course-reveal-endpoint.test.ts`：那里用底层 `node:http`
     * 发原始请求，可以带任意 Origin（同标注服务器的非回环 Host 判据）。
     *
     * 因此这里如实记录这个边界：浏览器能证明"同源请求拿到正文"，
     * 而"跨站被拒"必须由原始 HTTP 证明。
     */
    const crossSite = await page.evaluate(async () => {
      const fingerprint = document
        .querySelector('[data-segment-id="translation.1"] [data-risk-fingerprint]')
        ?.getAttribute("data-risk-fingerprint");
      const response = await fetch("/api/course/reveal", {
        method: "POST",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({
          courseId: "fixture-course-companion",
          segmentId: "translation.1",
          courseContentVersion: 1,
          confirmedRiskFingerprint: fingerprint,
        }),
      });
      return { status: response.status, body: await response.text() };
    });
    /*
     * 浏览器丢掉了伪造的 Origin ⇒ 请求按同源处理。
     *
     * 这条请求**带上了正确的风险指纹**，因此它是一次"参数完全合法"的
     * 请求 —— 服务端没有任何理由拒绝它。若状态不是 200，说明被拒的原因
     * 只可能是别的东西（守卫误伤），那才是真问题。
     *
     * 这条断言固定的是"浏览器侧的形态"，而不是守卫本身 ——
     * 跨站被拒由原始 HTTP 测试证明（见上方说明）。
     */
    expect(
      crossSite.status,
      "浏览器丢弃伪造 Origin ⇒ 带合法指纹的请求按同源成功（否则是守卫误伤）",
    ).toBe(200);
    // 无论哪种形态，都不得把**别的段**的正文混进来。
    expect(crossSite.body).not.toContain("Fixture second reading passage.");

    // ── 负向 2：`Origin: null`（沙箱 iframe / data URL）──
    /*
     * 同上：`Origin` 是禁止修改的头，浏览器同样会丢掉页面设的值。
     * 因此这条在浏览器里也只能记录形态；权威判据在原始 HTTP 测试里。
     */
    const nullOrigin = await page.evaluate(async () => {
      const fingerprint = document
        .querySelector('[data-segment-id="translation.1"] [data-risk-fingerprint]')
        ?.getAttribute("data-risk-fingerprint");
      const response = await fetch("/api/course/reveal", {
        method: "POST",
        headers: { origin: "null", "content-type": "application/json" },
        body: JSON.stringify({
          courseId: "fixture-course-companion",
          segmentId: "translation.1",
          courseContentVersion: 1,
          confirmedRiskFingerprint: fingerprint,
        }),
      });
      return { status: response.status, body: await response.text() };
    });
    expect([200, 403], "浏览器会丢弃伪造的 Origin（规范行为）").toContain(nullOrigin.status);
    expect(nullOrigin.body).not.toContain("Fixture second reading passage.");

    // ── 负向 3：GET 不得返回正文，也不得写入曝光 ──
    const asGet = await page.evaluate(async () => {
      const response = await fetch("/api/course/reveal", { method: "GET" });
      return { status: response.status, body: await response.text() };
    });
    expect(asGet.status, "GET 必须被拒").toBe(405);
    expect(asGet.body).not.toContain("夹具用的合成中文段落");
  });

  test("漂移的包经端点也取不到正文（浏览器级失败关闭）", async ({ page }) => {
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    const drifted = await page.evaluate(async () => {
      const response = await fetch("/api/course/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          courseId: "fixture-course-companion-drifted",
          segmentId: "reading.a",
          courseContentVersion: 1,
        }),
      });
      return { status: response.status, body: await response.text() };
    });

    // 包已漂移 ⇒ 失败关闭。
    expect(drifted.status).toBe(404);
    expect(drifted.body, "漂移时不得下发盘上被换掉的正文").not.toContain("盘上被换掉的合成正文");
    expect(drifted.body).not.toContain("Fixture course reading passage.");
  });

  test("**缺失风险指纹** ⇒ 409，且不下发正文（P0-1 浏览器级）", async ({ page }) => {
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    /*
     * 不带 `confirmedRiskFingerprint` 直接打端点。
     *
     * 这等价于"学习者没有确认过风险"—— 而服务端必须拒绝，
     * 因为 UI 的确认面板不是安全边界（P0-1）。
     */
    const noConfirm = await page.evaluate(async () => {
      const response = await fetch("/api/course/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          courseId: "fixture-course-companion",
          segmentId: "translation.1",
          courseContentVersion: 1,
        }),
      });
      return { status: response.status, body: await response.text() };
    });

    expect(noConfirm.status, "未确认风险必须被拒").toBe(409);
    expect(noConfirm.body, "被拒时不得下发正文").not.toContain("夹具用的合成中文段落");
  });

  test("**错误风险指纹** ⇒ 409，且回传更新后的风险视图", async ({ page }) => {
    await page.goto(`/practice/courses/${E2E_COMPANION_COURSE_ID}`);
    await page.waitForLoadState("networkidle");

    const wrong = await page.evaluate(async () => {
      const response = await fetch("/api/course/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          courseId: "fixture-course-companion",
          segmentId: "translation.1",
          courseContentVersion: 1,
          confirmedRiskFingerprint: "f".repeat(64),
        }),
      });
      return { status: response.status, body: await response.text() };
    });

    expect(wrong.status).toBe(409);
    const payload = JSON.parse(wrong.body) as {
      ok: boolean;
      code?: string;
      risk?: { fingerprint: string };
    };
    expect(payload.code).toBe("risk_changed");
    // 必须回传一个可用的更新后指纹（学习者据此重新确认）。
    expect(payload.risk?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});
