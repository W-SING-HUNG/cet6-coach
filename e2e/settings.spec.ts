import { test, expect } from "@playwright/test";
import { CET6_EXAM_DATE } from "@/domain/exam-facts";
import { attachErrorCollectors } from "./helpers";

/**
 * 学习设置：保存真的落库，刷新之后还在，非法值被拒绝。
 *
 * ── 为什么这个 spec 现在才有 ──
 *
 * `/settings` 此前只被布局与响应式 spec **渲染**过一次（断言 gutter 与标题），
 * 两条保存路径 `updateGoalAction` / `updatePreferencesAction` 既没有浏览器覆盖，
 * 也没有单元测试覆盖 —— 也就是说"改完点保存，计划按新目标重建"这句产品承诺，
 * 在此之前没有任何自动化证据。
 *
 * ── 它守的是什么（按重要性）──
 *
 * 1. **保存真的写入数据库，而不是只在前端改了个 state。**
 *    判据是 `reload()` 之后值仍在。只断言"点了保存出现成功文案"是测不到这一点的：
 *    一个把 `router.refresh()` 去掉、或把 Server Action 换成假实现的回归，仍然会让
 *    成功文案出现。
 * 2. **两组设置互相独立。** 改考试目标不得顺带重置学习时间（反之亦然）。
 *    这是 `SettingsForms` 把两个 `<section>` 分成两份表单的理由，值得断言。
 * 3. **非法值被拒绝，且不写入。** 目标分数低于 220 时服务端 schema 会拒绝；
 *    界面必须给出错误文案，并且库里的旧值不能被改掉。
 * 4. **没有修改时保存键不可用。** 这既是工效，也挡住"空提交"这类无意义写入。
 *
 * ── 数据隔离 ──
 *
 * 本 spec 跑在默认 `playwright.config.ts` 的主实例上（合成夹具试卷、独立数据库
 * `.e2e/cet6-e2e.db`），与日常开发库 `data/cet6.db` 完全隔离。
 *
 * 它**不**假设文件名顺序：前置状态（onboarding + 诊断）由本文件自己通过真实
 * 界面建立，而不是复用 `flow.spec.ts` 留下的状态。早先的布局 spec 曾因为
 * 依赖执行顺序而在单跑时假失败，那是同一类缺陷。
 */

/**
 * 把「1 小时 4 分」/「57 分钟」/「60」这类文本解析成分钟数。
 *
 * 三种形态都要支持，因为它们出现在不同的地方：`Field` 的 label 后缀是
 * `minutesLabel()` 的完整形态（「1 小时」），而 `MinuteChips` 的按钮文字只有
 * 裸数字（「60」）。早先只处理前两种，于是读档位时抛了「无法从「60」解析」。
 */
function parseMinutesLabel(label: string): number {
  const trimmed = label.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);

  const hours = /(\d+)\s*小时/.exec(trimmed);
  const minutes = /(\d+)\s*分/.exec(trimmed);
  if (!hours && !minutes) throw new Error(`无法从「${label}」解析分钟数`);
  return (hours ? Number(hours[1]) * 60 : 0) + (minutes ? Number(minutes[1]) : 0);
}

test.describe("学习设置 · 保存 → 刷新 → 仍在", () => {
  /* 前置状态只建一次：三条用例共用同一个已 onboard 的实例。 */
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto("/today");
      await page.waitForLoadState("networkidle");
      if (/\/today$/.test(new URL(page.url()).pathname)) return;

      /* ── onboarding ── */
      await expect(page.getByRole("heading", { name: "先确认三件事" })).toBeVisible();
      await page.getByRole("button", { name: /开始诊断|保存并进入诊断/ }).click();
      await expect(page).toHaveURL(/\/diagnostic$/, { timeout: 30_000 });

      /* ── diagnostic：逐题作答到最后一题 ── */
      for (let guard = 0; guard < 40; guard += 1) {
        const progressText = await page.getByText(/第 \d+ \/ \d+ 题/).first().textContent();
        const match = progressText?.match(/第 (\d+) \/ (\d+) 题/);
        if (!match) break;
        const current = Number(match[1]);
        const total = Number(match[2]);

        const isPending = (await page.getByText(/音频素材待补/).count()) > 0;
        if (!isPending) {
          const groups = page.locator("fieldset");
          const groupCount = await groups.count();
          if (groupCount > 0) {
            for (let index = 0; index < groupCount; index += 1) {
              const label = groups.nth(index).locator("label:has(input[type='radio'])").first();
              if ((await label.count()) === 0) continue;
              await label.click();
            }
          } else if ((await page.locator("textarea").count()) > 0) {
            await page.locator("textarea").fill(
              "A short but complete answer for the assessment, with a clear point and a reason.",
            );
          }
        }

        if (current >= total) break;
        await page.getByRole("button", { name: "下一题" }).click();
      }

      await page.getByRole("button", { name: "提交诊断" }).click();
      await expect(page).toHaveURL(/\/diagnostic\/result$/, { timeout: 60_000 });
    } finally {
      await context.close();
    }
  });

  test("考试目标保存后刷新仍在，且不会悄悄改掉学习时间", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

    const goalSection = page.locator("section", { has: page.getByRole("heading", { name: "考试目标" }) });
    const preferences = page.locator("section", { has: page.getByRole("heading", { name: "常规可投入时间" }) });

    /* ── 记录学习时间的当前值，用于证明两组设置互相独立 ── */
    const weekdayChip = preferences
      .locator("div")
      .filter({ has: page.locator('label:text-is("工作日每天")') })
      .locator('button[aria-pressed="true"]');
    const weekdayBefore = parseMinutesLabel(await weekdayChip.first().innerText());

    /* ── 改考试目标 ── */
    const scoreInput = goalSection.locator('input[type="number"]');
    const scoreBefore = await scoreInput.inputValue();
    const newScore = scoreBefore === "620" ? "635" : "620";

    // 保存键在未修改时不可用 —— 这本身就是一条断言
    const saveGoal = goalSection.getByRole("button", { name: "保存目标" });
    await expect(saveGoal, "未修改时保存键应不可用").toBeDisabled();

    await scoreInput.fill(newScore);
    await expect(saveGoal, "修改后保存键应可用").toBeEnabled();
    await saveGoal.click();

    await expect(goalSection.getByText("考试目标已保存，今日计划已按新目标重建。")).toBeVisible({
      timeout: 30_000,
    });

    /* ── 刷新：值必须来自数据库，而不是客户端 state ── */
    await page.reload();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    const goalSectionAfter = page.locator("section", { has: page.getByRole("heading", { name: "考试目标" }) });
    await expect(
      goalSectionAfter.locator('input[type="number"]'),
      "刷新后目标分数应仍为新值 —— 否则保存没有落库",
    ).toHaveValue(newScore);

    /* ── 考试日期不得因为改分数而漂移（单一事实来源）── */
    await expect(goalSectionAfter.locator('input[type="date"]')).toHaveValue(CET6_EXAM_DATE);

    /* ── 学习时间没有被这次保存影响 ── */
    const weekdayAfter = parseMinutesLabel(
      await page
        .locator("div")
        .filter({ has: page.locator('label:text-is("工作日每天")') })
        .locator('button[aria-pressed="true"]')
        .first()
        .innerText(),
    );
    expect(weekdayAfter, "改考试目标不应改动学习时间").toBe(weekdayBefore);

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("常规学习时间保存后刷新仍在", async ({ page }) => {
    const { pageErrors, consoleErrors } = attachErrorCollectors(page);

    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

    const preferences = page.locator("section", { has: page.getByRole("heading", { name: "常规可投入时间" }) });
    const saveTimes = preferences.getByRole("button", { name: "保存时间" });
    await expect(saveTimes, "未修改时保存键应不可用").toBeDisabled();

    /* 工作日那一组 chip（周末是另一组，两者独立） */
    const weekdayField = page.locator("div").filter({ has: page.locator('label:text-is("工作日每天")') });
    const chips = weekdayField.locator("button[aria-pressed]");
    expect(await chips.count(), "时间档位必须存在").toBeGreaterThan(0);

    const currentMinutes = parseMinutesLabel(
      await weekdayField.locator('button[aria-pressed="true"]').first().innerText(),
    );

    /*
     * 挑一个与当前不同的档位。不依赖 onboarding 的默认值：默认值属于产品
     * 承诺，会随产品调整，而"选一个不同的档位"永远成立。
     */
    const candidates = [30, 45, 60, 90, 120];
    const target = candidates.find((value) => value !== currentMinutes);
    if (target === undefined) throw new Error(`没有可用的不同档位（当前 ${currentMinutes}）`);

    await weekdayField.getByRole("button", { name: String(target), exact: true }).first().click();

    await expect(saveTimes, "选择新档位后保存键应可用").toBeEnabled();
    await saveTimes.click();
    await expect(preferences.getByText("常规时间已保存，今日计划已重建。")).toBeVisible({ timeout: 30_000 });

    await page.reload();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

    /*
     * 刷新后的判据是**选中的档位**，不是文案里的数字：aria-pressed 由服务端
     * 下发的新值决定，因此它同时证明了"写入"与"回读"。
     */
    const weekdayAfter = parseMinutesLabel(
      await page
        .locator("div")
        .filter({ has: page.locator('label:text-is("工作日每天")') })
        .locator('button[aria-pressed="true"]')
        .first()
        .innerText(),
    );
    expect(weekdayAfter, "刷新后学习时间应仍为新选择").toBe(target);

    expect(pageErrors, `浏览器 pageerror：\n${pageErrors.join("\n")}`).toHaveLength(0);
    expect(consoleErrors, `浏览器 console error：\n${consoleErrors.join("\n")}`).toHaveLength(0);
  });

  test("非法目标分数被拒绝，且库里的旧值不被覆盖", async ({ page }) => {
    /*
     * 负向路径。目标分数的 schema 是 220–710，因此 100 一定被拒。
     *
     * ── 为什么要断言旧值不变，而不只是"出现错误文案" ──
     *
     * 一个只在前端拦住的实现会显示错误、但服务端仍可能已经写入了非法值；
     * 反过来，一个只在服务端拦住的实现可能不显示错误。两条一起断言才说明
     * "拒绝"这件事是完整的：既没有写入，也如实告诉了用户。
     *
     * ── 拒绝文案的判据必须是**本次出现的** ──
     *
     * 页面上本来就有静态提示「220 - 710」（那是 `Field` 的 hint）。用
     * `/220|710|无效|范围/` 去匹配会立刻命中那条静态提示，于是断言无论保存是否
     * 被拒都会通过 —— 一条永远为真的断言比没有断言更糟。
     *
     * 因此这里：先修改输入，再读取页面上**错误文案的区域**（`role="alert"`
     * 与两个状态 span），要求其中出现一段在点击前**不存在**的新文本。
     */
    await page.goto("/settings");
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();

    const goalSection = page.locator("section", { has: page.getByRole("heading", { name: "考试目标" }) });
    const scoreInput = goalSection.locator('input[type="number"]');
    const validBefore = await scoreInput.inputValue();

    const savedMessagesBefore = await goalSection.locator("span.text-danger, span.text-accent").allInnerTexts();

    // 绕过 min/max 属性直接置值，模拟真实用户手动输入越界数字
    await scoreInput.fill("100");
    await goalSection.getByRole("button", { name: "保存目标" }).click();

    /*
     * 断言拒绝发生了。两种可能都接受，但必须有其一：
     *   - 出现了一条点击前不存在的错误文案；或
     *   - 保存键变回不可用（客户端 schema 直接拦下，根本没发请求）。
     */
    await expect
      .poll(
        async () => {
          const spans = await goalSection.locator("span.text-danger").allInnerTexts();
          const fresh = spans.filter((text) => !savedMessagesBefore.includes(text) && text.trim() !== "");
          if (fresh.length > 0) return `message:${fresh.join("|")}`;
          const disabled = await goalSection.getByRole("button", { name: "保存目标" }).isDisabled();
          return disabled ? "disabled" : null;
        },
        { timeout: 30_000, message: "越界的目标分数必须被拒绝（出现新的错误文案，或保存键不可用）" },
      )
      .not.toBeNull();

    await page.reload();
    await expect(page.getByRole("heading", { name: "设置" })).toBeVisible();
    const goalSectionAfter = page.locator("section", { has: page.getByRole("heading", { name: "考试目标" }) });
    await expect(
      goalSectionAfter.locator('input[type="number"]'),
      "被拒绝的值不得写入数据库：刷新后应仍是原来的合法值",
    ).toHaveValue(validBefore);
  });
});
