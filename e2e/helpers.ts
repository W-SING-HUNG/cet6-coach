import { expect, type ConsoleMessage, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { E2E_ARTIFACTS_DIR } from "./config";

/**
 * E2E 共享工具。
 *
 * 放在独立模块而不是某个 spec 里：Playwright 禁止 spec 之间互相 import
 * （会破坏它的测试收集），因此共享代码必须有非 spec 的宿主文件。
 */

export const SHOT_DIR = join(E2E_ARTIFACTS_DIR, "screenshots");
mkdirSync(SHOT_DIR, { recursive: true });

/**
 * 收集浏览器侧错误。
 * pageerror（未捕获异常）与 console.error 都视为关键流程失败。
 */
export function attachErrorCollectors(page: Page) {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  page.on("console", (message: ConsoleMessage) => {
    if (message.type() !== "error") return;
    const text = message.text();
    // 忽略与业务无关的噪音（被 devtools 探测的 favicon 请求等）
    if (/favicon|Download the React DevTools/i.test(text)) return;
    consoleErrors.push(text);
  });

  return { pageErrors, consoleErrors };
}

export async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: true });
}

/**
 * 只截**当前视口**（不滚动扩展）。
 *
 * ── 为什么工作区必须用这个而不是 `shot` ──
 * `fullPage: true` 会让 Playwright 把视口临时放大到整个文档高度。
 * 而回答工作区的高度是 `calc(100dvh - header)` —— `dvh` 会跟着这个放大的
 * 视口一起变大，于是截图变成"页面被拉长"的假象：
 * 实测 1440×900 的仔细阅读工作区被拍成 **1440×2407**，
 * 下半部分是整片空白，看起来像布局坏了，实际上视口内的布局是好的。
 *
 * 这对"固定高度 + 内部滚动"的界面是系统性失真，因此工作区一律用本函数：
 * 它拍下的正是学习者实际看到的那一屏。
 */
export async function shotViewport(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(SHOT_DIR, `${name}.png`), fullPage: false });
}

/** 断言没有明显横向溢出（移动端布局硬性要求）。 */
export async function expectNoHorizontalOverflow(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return { scrollWidth: doc.scrollWidth, clientWidth: doc.clientWidth };
  });
  expect(
    overflow.scrollWidth,
    `${label}: 出现横向溢出 (scrollWidth=${overflow.scrollWidth} > clientWidth=${overflow.clientWidth})`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/**
 * 选择每个选择题组的第一个选项。
 *
 * 为什么点 label 而不是 input：产品里的 radio input 是 `sr-only`（视觉隐藏，
 * 只用于无障碍与键盘操作），真实用户点击的是外层 label。
 * 直接 `input.check()` 会被 label 拦截指针事件而超时 —— 那是测试写法错误，
 * 不是产品缺陷。点 label 既符合真实交互，也真实触发 radio 变更。
 */
export async function chooseFirstOptionPerGroup(page: Page): Promise<number> {
  const groups = page.locator("fieldset");
  const groupCount = await groups.count();
  let chosen = 0;

  if (groupCount > 0) {
    for (let index = 0; index < groupCount; index += 1) {
      const label = groups.nth(index).locator("label:has(input[type='radio'])").first();
      if ((await label.count()) === 0) continue;
      await label.click();
      chosen += 1;
    }
    return chosen;
  }

  // 没有 fieldset 时退化为"整页第一个可选项"
  const fallback = page.locator("label:has(input[type='radio'])").first();
  if ((await fallback.count()) > 0) {
    await fallback.click();
    return 1;
  }
  return 0;
}

/** 是否当前屏幕存在可作答的选择题。 */
export async function hasChoices(page: Page): Promise<boolean> {
  return (await page.locator("label:has(input[type='radio'])").count()) > 0;
}

/** 是否当前屏幕是主观题输入。 */
export async function hasTextarea(page: Page): Promise<boolean> {
  return (await page.locator("textarea").count()) > 0;
}

/** 填充主观题用的作答文本（足够长以触发 rubric 覆盖）。 */
export const SAMPLE_ESSAY =
  "Tea drinking has a long history in China and reflects a daily habit, and it carries the social interaction " +
  "between people as ways of communication. As cities continue to expand outward, many people face increasingly " +
  "long commutes, which not only drains their energy but also changes the way family life is organised. " +
  "In conclusion, however, both tendencies deserve attention, and therefore a balanced approach is preferable.";

/**
 * 确保目标应用实例处于「已完成 onboarding + 诊断」的状态。
 *
 * ── 它解决的那个真实缺陷 ──
 *
 * `/today` 等常规页面在未 onboarding 时会 `redirect("/onboarding")`。
 * 早先 `layout-gutter.spec.ts` 假定自己排在 `flow.spec.ts` 之后运行
 * （Playwright 默认按文件名顺序串行），于是复用了 flow 建立的状态。
 * 结果是：**单独运行**布局测试时 3 条失败、与 flow 一起跑时 8 条通过 ——
 * 一个纯粹由执行顺序决定的假失败。
 *
 * 修法不是强制排序、重试或跳过，而是让需要该状态的测试**自己声明前置条件**。
 *
 * ── 为什么必须走真实 UI ──
 *
 * onboarding 与诊断都经 Next.js Server Action 提交，服务端会做
 * schema 校验与真实的计划重算。绕过它（直接写库）会测试一条
 * **用户永远不会走的路径**，而且进程内直接写库会与共用同一份
 * `CET6_DB_PATH` 的其他 spec 相互覆盖。
 *
 * 因此这里刻意复用与 `flow.spec.ts` 完全相同的那组界面操作：
 * 它们是产品的真实入口，而不是测试专用后门。
 *
 * ── 幂等 ──
 *
 * 若实例已经 onboarded（例如 flow.spec.ts 先跑过），本函数直接返回，
 * 不重复提交 —— 既省时间，也避免把已有的诊断结果覆盖成新的。
 *
 * 返回 `true` 表示"现在可以访问常规页面了"；`false` 表示无法在
 * 当前实例完成（此时调用方应给出清晰的失败信息，而不是继续跑几何断言）。
 */
export async function ensureOnboardedForLayout(page: Page): Promise<boolean> {
  /*
   * 先探一次 /today：若已经 onboarded 且完成诊断，它会停在 /today；
   * 否则会被重定向。用 URL 判断，而不是去查数据库 —— 那才是
   * 学习者实际看到的判据。
   */
  await page.goto("/today");
  await page.waitForLoadState("networkidle");

  if (/\/today$/.test(new URL(page.url()).pathname)) {
    return true;
  }

  // ── onboarding ──
  if (/\/onboarding$/.test(new URL(page.url()).pathname)) {
    const heading = page.getByRole("heading", { name: "先确认三件事" });
    if (!(await heading.isVisible().catch(() => false))) return false;

    // 默认值已由产品填好（考试日期、目标分、时间档位），直接提交即可。
    await page.getByRole("button", { name: /开始诊断|保存并进入诊断/ }).click();
    await page.waitForURL(/\/diagnostic$/, { timeout: 30_000 });
  }

  // ── diagnostic ──
  if (!/\/diagnostic$/.test(new URL(page.url()).pathname)) {
    /*
     * 既不是 /today 也不是 /onboarding：可能是 /diagnostic/result
     * （已确诊）—— 那种情况下再去 /today 试一次即可。
     */
    await page.goto("/today");
    await page.waitForLoadState("networkidle");
    return /\/today$/.test(new URL(page.url()).pathname);
  }

  // 逐题作答直到最后一题（与 flow.spec.ts 同一套界面操作）。
  for (let guard = 0; guard < 40; guard += 1) {
    const progressText = await page.getByText(/第 \d+ \/ \d+ 题/).first().textContent();
    const match = progressText?.match(/第 (\d+) \/ (\d+) 题/);
    if (!match) break;

    const current = Number(match[1]);
    const total = Number(match[2]);

    const isPending = (await page.getByText(/音频素材待补/).count()) > 0;
    if (!isPending) {
      if (await hasChoices(page)) {
        await chooseFirstOptionPerGroup(page);
      } else if (await hasTextarea(page)) {
        await page.locator("textarea").fill(SAMPLE_ESSAY);
      }
    }

    if (current >= total) break;
    await page.getByRole("button", { name: "下一题" }).click();
  }

  await page.getByRole("button", { name: "提交诊断" }).click();
  await page.waitForURL(/\/diagnostic\/result$/, { timeout: 60_000 });

  // 收尾：回到常规页面，确认状态真的可用了。
  await page.goto("/today");
  await page.waitForLoadState("networkidle");
  return /\/today$/.test(new URL(page.url()).pathname);
}
