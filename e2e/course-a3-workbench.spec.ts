/**
 * A3 受控课程接入 · **真实浏览器**端到端测试（端口 3285 工作台 + 3286 伴随）。
 *
 * ── 这个 spec 要证明的是任务书里那条完整用户路径 ──
 *
 *   生成课程候选 → 人工裁决 → 保存审核记录 → 只读预演
 *     → ① 晋升 → ② 导入 → ③ 建链 → 在 /practice/courses 看到并打开课程
 *
 * ── 它与"服务层测试"的分工 ──
 *
 * 服务层测试能证明判据正确，但**证明不了**：按钮可点击、hydration 正常、
 * 禁用态与原因真的渲染出来、并发保护生效、中断后重开能恢复现场、
 * 以及**产品界面真的读得到工作台写下的东西**（那是两个进程之间的事）。
 *
 * ── 纪律 ──
 *
 * 全部合成夹具：源目录、真题包、候选都在 `.e2e/` 下。课程 provider 与试卷
 * `sourceKind` 由夹具构造器写死。它**不碰** `private-content/`、
 * **不碰** `data/cet6.db`。源根是**预置**的（自动化里不弹原生窗口）。
 */

import { test, expect, type Page } from "@playwright/test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const HANDOFF_PATH = join(process.cwd(), ".e2e", "a3-workbench.json");

interface WorkbenchHandoff {
  intakeUrl: string;
  a3Url: string;
  port: number;
  boundAddress: string;
  sourceLabel: string | null;
  courseId: string;
}

/*
 * ── 为什么每条用例用**自己的**课程标识 ──
 *
 * A3 的状态活在磁盘（`courses/`）与数据库里，而整个 spec 文件共享一份实例。
 * 若两条用例都用同一个 id，先跑的那条会把课程晋升掉，后跑的那条就会看到
 * "目标已存在" ⇒ 晋升按钮永久禁用 ⇒ 超时。
 *
 * 那是**顺序依赖**，不是契约。每条用例一个独立课程标识之后，
 * 单跑 / 先跑 / 后跑的结果完全相同。
 */
const COURSE_ID_FULL_PATH = "fixture-course-a3-full";
const COURSE_ID_AUTHZ = "fixture-course-a3-authz";

function readHandoff(): WorkbenchHandoff {
  expect(existsSync(HANDOFF_PATH), "e2e-server-a3 必须已写入 handoff 文件").toBe(true);
  return JSON.parse(readFileSync(HANDOFF_PATH, "utf8")) as WorkbenchHandoff;
}

/**
 * 走完"检查 → 生成候选 → 逐条裁决 → 保存审核记录"这一段。
 *
 * 提取成函数是因为下面多条用例都需要一个**已签署复核**的候选，
 * 而每一步都是真实点击（不是预置状态）。
 */
async function prepareReviewedCandidate(
  page: Page,
  handoff: WorkbenchHandoff,
  courseId: string,
): Promise<void> {
  await page.goto(handoff.intakeUrl);

  // ② 清点：源根已预置，直接勾选并检查
  await page.locator("#selectAll").click();
  await page.locator("#inspect").click();
  await expect(page.locator("#globalNotice")).toContainText("检查完成", { timeout: 30_000 });

  // ⑤ 人工审核：先生成候选
  await page.locator("#stepBtn5").click();
  await page.locator("#courseIdInput").fill(courseId);
  await page.locator("#candTitle").fill("A3 E2E Synthetic Course");
  await page.locator("#candProvider").fill("test_fixture_provider");

  await page.locator("#previewCandidateBtn").click();
  await expect(page.locator("#candidateNotice")).toContainText("预演完成", { timeout: 30_000 });

  // 预演通过之后，"确认生成候选"才可点
  await expect(page.locator("#generateCandidateBtn")).toBeEnabled();
  await page.locator("#generateCandidateBtn").click();
  await expect(page.locator("#candidateNotice")).toContainText("课程候选已生成", { timeout: 30_000 });

  /*
   * 生成候选之后**必须回到第 ⑤ 步**。
   *
   * `loadBinding()` 会刷新绑定身份，而裁决控件只在第 ⑤ 步面板可见时
   * 才可交互 —— 不回到这一步的话，下面的 `selectOption` 会一直等一个
   * "resolved but not visible"的元素，直到超时。
   * （这正是浏览器测试才能发现的形态：服务端一切正常。）
   */
  await page.locator("#stepBtn5").click();
  await expect(page.locator("#step5")).toBeVisible();

  // 绑定面板必须显示服务端现场重算的候选校验和（不再是占位）
  await page.locator("#reviewerInput").fill("Synthetic Reviewer");
  await expect(page.locator("#bindingCandidate")).toContainText(/[0-9a-f]{12}/, { timeout: 30_000 });

  // 逐条给出裁决：所有下拉都选一个值，并填足够长的依据
  await fillAllAdjudications(page);
  await page.locator("#validateDraftBtn").click();
  await expect(page.locator("#adjudicationNotice")).toContainText("审核草稿校验通过", { timeout: 30_000 });

  await page.locator("#saveDraftBtn").click();
  await expect(page.locator("#adjudicationNotice")).toContainText("人工审核记录已原子安全保存", { timeout: 30_000 });
}

/**
 * 把所有裁决控件都填上。
 *
 * 匹配层刻意选择"接受建议"（若该段有建议），因此 A3-c 有真实待建链接；
 * 没有建议的段选"有意不匹配"（那是合法状态）。
 *
 * ── 为什么逐个 `scrollIntoViewIfNeeded` 之后才操作 ──
 *
 * 第 ⑤ 步的面板很长（每份材料、每个段、每条匹配各一张卡）。Playwright 的
 * `selectOption` 要求元素可交互，而一旦卡片被后续渲染替换，定位就会
 * 一直等一个"resolved 但不可见"的元素直到超时 —— 那种失败信息
 * （352 次 waiting for element to be visible and enabled）完全不指向真实原因。
 * 显式滚动 + 重新定位让每一步都作用在**当前**节点上。
 */
async function fillAllAdjudications(page: Page): Promise<void> {
  const sections = [
    {
      host: "#adjudicationGroupings",
      selectIdPrefix: "grouping-decision-",
      value: "accepted",
      evidence: "经逐字核对该材料的构成与命名，确认分组正确无出入。",
    },
    {
      host: "#adjudicationSegments",
      selectIdPrefix: "segment-decision-",
      value: "accepted",
      evidence: "人工核验该段的边界、类别与页码来源，与源件完全一致。",
    },
  ];

  for (const section of sections) {
    const count = await page.locator(`${section.host} select`).count();
    for (let index = 0; index < count; index += 1) {
      const select = page.locator(`${section.host} select`).nth(index);
      await select.scrollIntoViewIfNeeded();
      await select.selectOption(section.value);
      const input = page.locator(`${section.host} input`).nth(index);
      await input.scrollIntoViewIfNeeded();
      await input.fill(section.evidence);
    }
  }

  const matchCount = await page.locator("#adjudicationMatches select").count();
  for (let index = 0; index < matchCount; index += 1) {
    const select = page.locator("#adjudicationMatches select").nth(index);
    await select.scrollIntoViewIfNeeded();
    // 这一条有没有可用建议？（没有建议时"接受/否决"选项是 disabled 的）
    const acceptDisabled = await select
      .locator('option[value="accepted_suggestion"]')
      .evaluate((option) => (option as HTMLOptionElement).disabled);
    await select.selectOption(acceptDisabled ? "intentionally_unmatched" : "accepted_suggestion");
    const input = page.locator("#adjudicationMatches input").nth(index);
    await input.scrollIntoViewIfNeeded();
    await input.fill(
      acceptDisabled
        ? "人工对照后确认候选证据不足以支撑核验，有意不匹配（未匹配是合法状态）。"
        : "逐句比对投影与真题正文，确认这段材料确实对应这份卷子的该目标。",
    );
  }
}

test.describe("A3 · 受控课程接入", () => {
  test("工作台可打开；token 从 URL fragment 清除；三项独立确认卡都在", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.a3Url);

    await expect(page.locator("h1")).toContainText("课程正式接入");
    await expect(page.locator(".badge")).toContainText("三项各自单独确认");
    await expect(page).not.toHaveURL(/#token=/);

    // 三张独立执行卡必须各自在场
    await expect(page.locator("#promoteCard")).toBeVisible();
    await expect(page.locator("#importCard")).toBeVisible();
    await expect(page.locator("#linkCard")).toBeVisible();

    // **不得**存在"全部完成"之类的复合按钮
    const buttonTexts = await page.locator("button").allTextContents();
    expect(
      buttonTexts.some((text) => /全部完成|一键|全部执行/.test(text)),
      "不得存在把三项合成一个动作的按钮",
    ).toBe(false);

    // 页面不得显示绝对路径
    const body = await page.locator("body").innerText();
    expect(/[A-Za-z]:\\/.test(body), "界面不得显示盘符绝对路径").toBe(false);
  });

  test("三项写操作在预演通过前都不可执行，且各自给出原因", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.a3Url);
    await page.locator("#courseIdInput").fill(COURSE_ID_FULL_PATH);

    // 还没预演 ⇒ 三个写按钮都禁用
    await expect(page.locator("#promoteBtn")).toBeDisabled();
    await expect(page.locator("#importBtn")).toBeDisabled();
    await expect(page.locator("#linkCommitBtn")).toBeDisabled();

    // 进度读取：三项均未完成，且明确显示"下一步"
    await page.locator("#loadProgressBtn").click();
    await expect(page.locator("#progressNotice")).toContainText("已读取接入进度", { timeout: 30_000 });
    await expect(page.locator('#stepList li[data-step="promote"]')).toHaveAttribute("data-state", "current");
    await expect(page.locator('#stepList li[data-step="import"]')).toHaveAttribute("data-state", "blocked");
    await expect(page.locator('#stepList li[data-step="link"]')).toHaveAttribute("data-state", "blocked");
  });

  test("候选不存在时预演如实报告，且不写入任何东西", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.a3Url);
    await page.locator("#courseIdInput").fill("no-such-candidate-course");
    await page.locator("#previewBtn").click();

    await expect(page.locator("#previewNotice")).toContainText("当前不可执行", { timeout: 30_000 });
    await expect(page.locator("#previewBody")).toContainText("候选不存在");
    // 不可执行的原因必须显示出来
    await expect(page.locator("#promoteBlocked")).toBeVisible();
    await expect(page.locator("#promoteBtn")).toBeDisabled();
  });

  test("**完整用户路径**：生成候选 → 审核 → 预演 → 晋升 → 导入 → 建链 → Course Companion", async ({
    page,
    browser,
  }) => {
    /*
     * 这条用例刻意**走完**整条真实路径（含 PDF 抽取、晋升、v8→v9 迁移、
     * 建链、跨进程打开产品界面），因此它需要比默认 180 秒更宽的预算。
     *
     * 放宽的是**时间**，不是断言强度：每一步仍然要求真实点击 + 真实响应。
     */
    test.setTimeout(420_000);

    const handoff = readHandoff();

    // ── 第 1 段：检查 + 生成候选 + 人工裁决 + 保存复核记录 ──
    await prepareReviewedCandidate(page, handoff, COURSE_ID_FULL_PATH);

    // ── 第 2 段：A3 只读预演 ──
    await page.goto(handoff.a3Url);
    await page.locator("#courseIdInput").fill(COURSE_ID_FULL_PATH);
    await page.locator("#previewBtn").click();
    await expect(page.locator("#previewNotice")).toContainText("预演完成", { timeout: 30_000 });
    await expect(page.locator("#previewBody")).toContainText("可以晋升");
    await expect(page.locator("#promoteBtn")).toBeEnabled();

    // ── 第 3 段：① 晋升（单独授权）──
    await page.locator("#promoteBtn").click();
    await expect(page.locator("#globalNotice")).toContainText("已晋升", { timeout: 30_000 });

    // ── 第 4 段：② 导入（单独授权；此前必须先完成晋升）──
    await expect(page.locator("#importBtn")).toBeEnabled({ timeout: 30_000 });
    await page.locator("#importBtn").click();
    await expect(page.locator("#globalNotice")).toContainText("已写入课程索引", { timeout: 60_000 });

    // ── 第 5 段：③ 建链（先预演，再单独确认写入）──
    await expect(page.locator("#linkPreviewBtn")).toBeEnabled({ timeout: 30_000 });
    await page.locator("#linkPreviewBtn").click();
    await expect(page.locator("#linkNotice")).toContainText("建链预演通过", { timeout: 30_000 });
    // 预演之前"确认写入"必须禁用；预演通过之后才可点
    await expect(page.locator("#linkCommitBtn")).toBeEnabled({ timeout: 30_000 });
    await page.locator("#linkCommitBtn").click();
    await expect(page.locator("#globalNotice")).toContainText(/已写入 \d+ 条不可变复核记录/, { timeout: 30_000 });

    // ── 第 6 段：进度必须显示三项全部完成，并出现进入 Companion 的入口 ──
    await expect(page.locator("#donePanel")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('#stepList li[data-step="promote"]')).toHaveAttribute("data-state", "done");
    await expect(page.locator('#stepList li[data-step="import"]')).toHaveAttribute("data-state", "done");
    await expect(page.locator('#stepList li[data-step="link"]')).toHaveAttribute("data-state", "done");

    /*
     * ── 第 7 段：在产品自己的界面上看到这份课程 ──
     *
     * 用**新的**浏览器上下文打开一个**不同的**端口（3286，Next.js 应用），
     * 因此这条断言跨进程：工作台写下的东西，产品界面真的读得到。
     *
     * 它同时满足任务书的"不能只验证数据库里有一条记录"：
     * 这里验证的是页面渲染、材料层级、段标题与页码来源。
     */
    const context = await browser.newContext();
    const product = await context.newPage();
    try {
      await product.goto("http://127.0.0.1:3286/practice/courses");

      // 1) 课程出现在**产品自己的**列表页上
      await expect(product.locator("body")).toContainText("A3 E2E Synthetic Course", { timeout: 30_000 });
      await expect(product.locator("body")).toContainText(COURSE_ID_FULL_PATH);

      /*
       * 2) 打开 Course Companion。
       *
       * 用课程 id 精确定位那一行里的「打开课程」，而不是按标题 ——
       * 同一列表里可能有多门合成课程（本文件其它用例也会建课），
       * 按标题点会点到别人的行上。
       */
      const row = product.locator("li", { hasText: COURSE_ID_FULL_PATH }).first();
      await row.getByRole("link", { name: "打开课程" }).click();
      await expect(product).toHaveURL(new RegExp(`/practice/courses/${COURSE_ID_FULL_PATH}`), { timeout: 30_000 });

      // 3) 材料层级与段标题必须真的渲染出来（不是"库里有条记录"）
      const courseBody = await product.locator("body").innerText();
      expect(courseBody.length, "课程详情页必须有内容").toBeGreaterThan(200);
      // 合成夹具的段来自这两份材料
      expect(courseBody).toMatch(/阅读|翻译|材料|课程段/);

      /*
       * 4) 段级页确实可达，且带阅读揭示保护。
       *
       * 这是"真实使用路径"的最后一段：列表 → 详情 → 段级页。
       */
      const segmentLink = product.locator('a[href*="/segment/"]').first();
      if ((await segmentLink.count()) > 0) {
        await segmentLink.click();
        await expect(product).toHaveURL(/\/segment\//, { timeout: 30_000 });
        const segmentBody = await product.locator("body").innerText();
        // 正文默认不下发：页面给的是"看这段"入口
        expect(segmentBody).toMatch(/看这段|阅读正文|已经看过|未匹配|没有已核验/);
        expect(/[A-Za-z]:\\/.test(segmentBody), "段级页不得显示绝对路径").toBe(false);
      }

      // 5) 任何产品页面都不得泄漏绝对路径
      expect(/[A-Za-z]:\\/.test(courseBody), "产品界面不得显示绝对路径").toBe(false);
    } finally {
      await context.close();
    }
  });

  test("三项确实需要三次独立授权：跳过任一项，后一项不可执行", async ({ page }) => {
    test.setTimeout(300_000);
    const handoff = readHandoff();
    await prepareReviewedCandidate(page, handoff, COURSE_ID_AUTHZ);

    await page.goto(handoff.a3Url);
    await page.locator("#courseIdInput").fill(COURSE_ID_AUTHZ);
    await page.locator("#previewBtn").click();
    await expect(page.locator("#previewNotice")).toContainText("预演完成", { timeout: 30_000 });

    /*
     * 只完成 ① 晋升 —— ② 与 ③ 必须仍然不可执行，且给出原因。
     *
     * 这是"完成第一项绝不代表批准后两项"的**行为**判据：
     * 不是靠文案承诺，而是按钮真的点不了。
     */
    await page.locator("#promoteBtn").click();
    await expect(page.locator("#globalNotice")).toContainText("已晋升", { timeout: 30_000 });

    // ② 导入按钮虽然可点（前置条件已满足），但**尚未执行**；③ 必须先做它自己的预演
    await expect(page.locator("#linkCommitBtn")).toBeDisabled();
    await expect(page.locator("#linkPreviewBtn")).toBeEnabled();
    // 建链预演的结论尚未产生 ⇒ 写入按钮不可点
    await expect(page.locator("#linkBlocked")).toBeHidden();

    /*
     * 进度条如实显示：① 完成、② 是下一步（current）、③ 尚未轮到（blocked）。
     *
     * ② 必须是 `current` —— 它是下一个该做的动作；若显示成 `blocked`，
     * 说明"下一步"的推导把"还没做"错当成了"不能做"。
     */
    await page.locator("#loadProgressBtn").click();
    await expect(page.locator('#stepList li[data-step="promote"]')).toHaveAttribute("data-state", "done", {
      timeout: 30_000,
    });
    await expect(page.locator('#stepList li[data-step="import"]')).toHaveAttribute("data-state", "current");
    await expect(page.locator('#stepList li[data-step="link"]')).toHaveAttribute("data-state", "blocked");

    /*
     * ── 关键判据：跳过 ② 直接做 ③ 时，导入这一步必须仍然"未完成" ──
     *
     * 完成 ① 之后进度里 `imported.done` **必须**还是 false ——
     * 这正是"完成第一项绝不代表批准后两项"的实质。
     */
    const progress = await page.locator("#stepList").innerText();
    expect(progress).toContain("已成功");
    expect(progress.match(/已成功/g)?.length ?? 0, "此刻只有 ① 应当显示已成功").toBe(1);
  });

  test("A1 / A2 会话不能访问 A3 写端点（能力隔离）", async ({ request }) => {
    const handoff = readHandoff();
    const token = (handoff.a3Url.split("#token=")[1] ?? "").trim();

    // A3 的会话 token 对 A2 端口无效 ⇒ 守卫层先拒绝
    const toA2 = await request.post("http://127.0.0.1:3280/api/intake/promote", {
      headers: { "x-cet6-session-token": token, origin: "http://127.0.0.1:3280" },
      data: { courseId: COURSE_ID_FULL_PATH, confirmed: true },
    });
    expect(toA2.status()).toBe(403);

    // 缺 Origin ⇒ 403（敏感 POST 必须精确同源）
    const noOrigin = await request.post(`http://127.0.0.1:${handoff.port}/api/intake/promote`, {
      headers: { "x-cet6-session-token": token },
      data: { courseId: COURSE_ID_FULL_PATH, confirmed: true },
    });
    expect(noOrigin.status()).toBe(403);

    // 缺 token ⇒ 403
    const noToken = await request.post(`http://127.0.0.1:${handoff.port}/api/intake/import-index`, {
      headers: { origin: `http://127.0.0.1:${handoff.port}` },
      data: { courseId: COURSE_ID_FULL_PATH, confirmed: true },
    });
    expect(noToken.status()).toBe(403);
  });

  test("A3 页面在 A2 / A1 实例上不可达（结构性隔离）", async ({ request }) => {
    // A2 实例（3280）与 A1 实例（3270）都没有 A3 页面 ⇒ 404
    const a2 = await request.get("http://127.0.0.1:3280/a3");
    expect(a2.status()).toBe(404);
    const a1 = await request.get("http://127.0.0.1:3270/a3");
    expect(a1.status()).toBe(404);
  });

  test("界面只显示相对写入位置，绝不显示绝对路径", async ({ page }) => {
    const handoff = readHandoff();
    await page.goto(handoff.a3Url);
    const body = await page.locator("body").innerText();

    // 绝对路径（盘符 / 用户目录 / 临时目录）一律不得出现
    expect(/[A-Za-z]:\\/.test(body), "不得显示盘符绝对路径").toBe(false);
    expect(body).not.toContain("AppData");
    expect(body).not.toContain("\\\\");

    /*
     * `private-content/courses/<课程标识>/` 是**相对**位置标签，必须显示 ——
     * 任务书明确要求界面对每个操作说清"将写到哪里"。
     * 它与"泄漏绝对路径"是两件事：前者是产品契约的一部分，
     * 后者会暴露 使用者的本机目录结构。
     */
    await expect(page.locator("#promoteCard")).toContainText("private-content/courses/");
  });

  /**
   * **文件选择保真度**：在第 ① 步去掉一个文件之后，候选必须真的不含它。
   *
   * ── 为什么这条必须是浏览器测试 ──
   *
   * 服务层测试能证明"传了 selection 就生效"，但证明不了**界面有没有把它传下去**。
   * 独立评审指出的正是这条缝：界面显示"已排除 N 个"，而候选生成仍然读整根。
   * 只有真实点掉一个勾、真实点"确认生成"、再从**产物侧**核对，才闭合它。
   */
  test("移除一个文件后，候选**真的**不含它（选择范围贯穿到产物）", async ({ page }) => {
    test.setTimeout(300_000);
    const handoff = readHandoff();
    const courseId = "fixture-course-a3-selection";

    await page.goto(handoff.intakeUrl);
    await page.locator("#selectAll").click();
    await page.locator("#inspect").click();
    await expect(page.locator("#globalNotice")).toContainText("检查完成", { timeout: 30_000 });

    /*
     * ── 先回到第 ① 步面板 ──
     *
     * 目录树在 `#step1` 里，而 `showStep()` 只在当前步骤显示对应面板。
     * 若不点 `#stepBtn1`，树节点虽然存在于 DOM 且可被定位，但**不可见** ⇒
     * `uncheck()` 会一直等到超时。这是真实用户行为（他本来就在第 ① 步）。
     */
    await page.locator("#stepBtn1").click();
    await expect(page.locator("#step1")).toBeVisible();

    /*
     * 在第 ① 步的目录树里**去掉** `optional-handout.pdf` 那个勾。
     *
     * ── 为什么用 id 精确定位而不是按序号 ──
     *
     * 树节点带稳定 id（`file-<相对路径>`），而序号会随夹具目录结构漂移。
     */
    const checkbox = page.locator("#file-阅读\\/optional-handout\\.pdf");
    await expect(checkbox, "夹具里必须有一个可被排除的文件").toHaveCount(1);
    await expect(checkbox).toBeChecked();
    await checkbox.uncheck();
    await expect(checkbox).not.toBeChecked();

    // 排除之后**必须重新检查** —— 范围变了，检查结果才是新的有效范围
    await page.locator("#inspect").click();
    await expect(page.locator("#globalNotice")).toContainText("检查完成", { timeout: 30_000 });

    // ⑤ 生成候选
    await page.locator("#stepBtn5").click();
    await page.locator("#courseIdInput").fill(courseId);
    await page.locator("#candTitle").fill("A3 Selection Fixture");
    await page.locator("#candProvider").fill("test_fixture_provider");

    await page.locator("#previewCandidateBtn").click();
    await expect(page.locator("#candidateNotice")).toContainText("预演完成", { timeout: 30_000 });

    /*
     * 预演必须**显式声明**本次覆盖的范围（这是本修复的界面验收点）。
     *
     * 判据用 `data-selection-scope="active"`，而不是匹配一段会随文案调整
     * 而变化的中文 —— 前者是结构性事实。
     */
    await expect(page.locator('#candidatePreview [data-selection-scope="active"]')).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.locator('#candidatePreview [data-selection-scope="whole-root"]')).toHaveCount(0);

    await page.locator("#generateCandidateBtn").click();
    await expect(page.locator("#candidateNotice")).toContainText("课程候选已生成", { timeout: 30_000 });

    /*
     * ── 从**产物侧**核对：候选里不得出现那个被排除内容的标记 ──
     *
     * 通过"第 ④ 步的真题候选/第 ③ 步的材料与分段"看不到文件级别的证据，
     * 因此这里用 Node 侧直接读候选目录 —— 那才是产物。
     */
    const candidateDir = join(process.cwd(), ".e2e", "a3-content", "course-candidates", courseId);
    expect(existsSync(join(candidateDir, "course.json")), "候选必须已落盘").toBe(true);

    const assetDir = join(candidateDir, "assets");
    const assetFiles = existsSync(assetDir) ? readdirSync(assetDir) : [];
    expect(assetFiles.length, "候选必须有资产").toBeGreaterThan(0);

    // 逐个资产读字节，确认没有任何一个含被排除内容的标记
    for (const name of assetFiles) {
      const bytes = readFileSync(join(assetDir, name));
      expect(
        bytes.includes(Buffer.from("selection-marker-do-not-include", "utf8")),
        `候选资产 ${name} 含被排除内容的标记 —— 排除没有生效`,
      ).toBe(false);
    }

    // 反向：已选的文件**必须**在（证明我们不是"全都排除了"）
    expect(assetFiles.length, "已选文件必须仍在候选里").toBeGreaterThanOrEqual(2);
  });
});
