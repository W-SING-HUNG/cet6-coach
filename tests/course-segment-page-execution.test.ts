// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { buildPlanFromSubmission, SESSION_TOKEN_HEADER } from "@/content/course-pipeline/segment-server";
import { validatePlanShape } from "@/content/course-pipeline/segmentation-plan";

/**
 * **执行级守卫**：把服务端真实渲染的页面放进**真实 DOM**，执行它的内联脚本，
 * 然后**真的点按钮**，断言界面确实有反应。
 *
 * ── 为什么必须有这一层（而不是只有语法检查）──
 *
 * 复评证明的缺陷形态是：
 *
 * - HTTP 200；
 * - 现有的「HTTP 200 + 正则」冒烟断言**全绿**；
 * - 而 `new Function(inlineScript)` 抛 `SyntaxError`；
 * - 「新建翻译单元」点了**没有任何反应**（脚本整体没执行）。
 *
 * 语法检查能抓住那条具体的 `SyntaxError`，但抓不住"脚本语法合法、
 * 却因为接线断了而不工作"。因此这里补上**执行 + 交互**这一层：
 * 渲染出的行数、页框数、按钮点击后的 DOM 变化。
 *
 * ── 这一轮新增的一层：**产品可用性**是真实断言对象 ──
 *
 * 使用者 第一次打开页面时**看不懂怎么用**。那不是一个"文案问题"，
 * 而是一组可以机械验证的界面事实：有没有引导、当前动作是否只有一句、
 * 点两下能不能标出闭区间、撤销有没有用、报错是不是人话。
 * 因此下面的用例**真的走完整条流程**（引导 → 新建练习 → 选类别 →
 * 点起点 → 点终点 → 撤销 → 取消标记 → 检查并保存），
 * 而不是断言 HTML 里"出现过某个字符串"。
 *
 * 独立的浏览器代理仍是**完整浏览器验收**门禁；
 * 这一层是进程内的快速回归，两者互补而非替代。
 *
 * ── 为什么这不违反"零新增依赖" ──
 *
 * `jsdom` 已经是项目的 devDependency（`vitest` 用它做组件测试）。
 * 这里只是换一个 `@vitest-environment` 注解，不新增任何包。
 *
 * ── 全部合成数据 ──
 *
 * 夹具正文是**合成**字符串（含对抗性 XSS 载荷），不是任何真实材料。
 */

/** 合成私有数据（含对抗性载荷）。它**只**经 fetch 的 JSON 到达页面。 */
const SYNTHETIC_LINES = [
  "合成正文第一行：用于验证渲染与 XSS 边界。",
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "</textarea>",
  `引号 " 与 & 与 < > 与反斜杠 \\ 与换行转义 \\n`,
  "Unicode：日本語 · Ελληνικά · العربية · emoji 🚇",
  "A".repeat(4000),
];

/** 一个最小的 fetch 响应替身。 */
function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

/**
 * 在 jsdom 里装载页面并执行脚本。
 *
 * 客户端脚本用 `fetch("/api/bootstrap")` 取私有数据。jsdom 不实现
 * fetch，因此这里注入一个替身 —— 它**只**回引导数据，且断言请求带上了
 * token 请求头（这正是"认证后才拿得到正文"那条边界在页面侧的体现）。
 */
async function loadPage(
  options: {
    bootstrapStatus?: number;
    token?: string;
    existingPlan?: unknown;
    /** 让 `/api/plan` 回一个**被拒绝**的响应（用于"服务端拒绝"路径）。 */
    planRejected?: boolean;
    /** 默认点掉引导面板进入工作区；首次打开那一组显式传 false。 */
    enterWorkspace?: boolean;
  } = {},
) {
  const token = options.token ?? "synthetic-token-abcdefghijklmnop";
  const html = renderAnnotationShell();

  // jsdom 由 vitest 的 environment 提供；这里重置文档并执行内联脚本
  document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
  window.location.hash = `#token=${token}`;

  type FetchCall = { url: string; headers: Record<string, string>; body?: string };
  const fetchCalls: FetchCall[] = [];
  const fetchMock = vi.fn(async (input: string, init?: { headers?: Record<string, string>; body?: string }) => {
    fetchCalls.push({ url: String(input), headers: init?.headers ?? {}, body: init?.body });
    if (String(input).includes("/api/bootstrap")) {
      if (options.bootstrapStatus !== undefined && options.bootstrapStatus !== 200) {
        return jsonResponse({ ok: false }, options.bootstrapStatus);
      }
      return jsonResponse({
        ok: true,
        courseId: "wiring-course",
        sourceDigest: "c".repeat(64),
        assets: [
          {
            assetKey: "k",
            label: "handout.pdf",
            sha256: "sha-k",
            pages: [{ page: 1, hasTextLayer: true, lines: SYNTHETIC_LINES }],
          },
        ],
        existingPlan: options.existingPlan ?? null,
      });
    }
    if (options.planRejected === true) {
      return jsonResponse({ ok: false, error: "合成夹具：服务端拒绝该提交" }, 400);
    }
    return jsonResponse({ ok: true, detail: "测试用保存", planDigest: "a".repeat(64) });
  });
  (window as unknown as { fetch: unknown }).fetch = fetchMock;

  // 取出内联脚本并执行（模拟浏览器解析 <script> 的行为）
  const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (match === null) throw new Error("页面里找不到内联脚本");
  new Function(match[1])();

  // 等 fetch 链落定
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await vi.waitFor(() => {
    if (document.querySelectorAll(".line").length === 0) throw new Error("尚未渲染");
  });

  if (options.enterWorkspace !== false) {
    (document.getElementById("startAnnotating") as HTMLButtonElement).click();
  }

  return { token, fetchCalls };
}

// ---------------------------------------------------------------------------
// 驱动真实控件的工具函数（全部只经由**真实 DOM 交互**）
// ---------------------------------------------------------------------------

type FetchCall = { url: string; headers: Record<string, string>; body?: string };

const lines = (): HTMLElement[] => [...document.querySelectorAll(".line")] as HTMLElement[];
const btn = (id: string): HTMLButtonElement => document.getElementById(id) as HTMLButtonElement;
const cat = (channel: string): HTMLButtonElement =>
  document.querySelector(`#channelBtns button[data-channel="${channel}"]`) as HTMLButtonElement;
const guideAction = (): string => document.getElementById("guideAction")!.textContent ?? "";
const guideWhere = (): string => document.getElementById("guideWhere")!.textContent ?? "";
const progressText = (): string => document.getElementById("progress")!.textContent ?? "";
const banner = (): HTMLElement => document.getElementById("banner")!;
/**
 * **用户真正能看见的文字**。
 *
 * 必须排除 `<script>` / `<style>`：它们的内容在 DOM 文本里，但浏览器
 * 不渲染它们。用 `document.body.textContent` 会把整段客户端脚本的注释
 * 与内部枚举名算进来 —— 那样"界面里没有技术词"这条断言就恒假，
 * 证明不了任何事。这里按**渲染语义**取文字。
 */
const visibleText = (): string => {
  const clone = document.body.cloneNode(true) as HTMLElement;
  for (const node of [...clone.querySelectorAll("script, style, template")]) node.remove();
  for (const node of [...clone.querySelectorAll("[hidden]")]) node.remove();
  return clone.textContent ?? "";
};
const planWrites = (calls: FetchCall[]): FetchCall[] =>
  calls.filter((call) => call.url.includes("/api/plan"));

/** 一次完整的"选类别 → 点第一行 → 点最后一行"。 */
function markRange(channel: string, from: number, to: number): void {
  cat(channel).click();
  lines()[from - 1].click();
  lines()[to - 1].click();
}

/** 新建一份练习并返回它的序号（从 0 起）。 */
function newUnit(): number {
  btn("newUnit").click();
  return document.querySelectorAll(".unit").length - 1;
}

/** 点"仍然保存"/"替换并保存"这类页内确认里的肯定项。 */
function confirmYes(): void {
  const box = document.getElementById("confirmBox")!;
  const yes = box.querySelector("button.primary") as HTMLButtonElement | null;
  if (yes === null) throw new Error("没有出现页内确认");
  yes.click();
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.innerHTML = "<head></head><body></body>";
  window.location.hash = "";
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// 原有安全 / 结构守卫（不变）
// ---------------------------------------------------------------------------

describe("标注页面在真实 DOM 里执行（jsdom）", () => {
  it("**渲染出可标注行与页框**（缺陷形态下两者都是 0）", async () => {
    await loadPage();
    /*
     * 复评在 Browser Agent 里观察到的正是这两个数为 0：
     *   renderedLines = 0 / pageBoxes = 0
     * 它们为 0 的根因就是脚本语法错误 ⇒ 整段脚本没执行。
     */
    expect(document.querySelectorAll(".page").length, "pageBoxes 必须 > 0").toBe(1);
    expect(document.querySelectorAll(".line").length, "renderedLines 必须 > 0").toBe(SYNTHETIC_LINES.length);
  });

  it("页面渲染正文**只作为数据**（对抗性载荷不产生元素、不执行）", async () => {
    await loadPage();

    // 载荷必须**原样**出现在 DOM 文本里（作为数据），而不是被解析成元素
    const txTexts = [...document.querySelectorAll(".line .tx")].map((el) => el.textContent ?? "");
    expect(txTexts).toContain("<script>alert(1)</script>");
    expect(txTexts).toContain("<img src=x onerror=alert(1)>");
    expect(txTexts).toContain("</textarea>");

    // 关键：页面里不得真的出现注入的元素
    expect(document.querySelectorAll("#doc script").length, "正文里的 <script> 不得变成元素").toBe(0);
    expect(document.querySelectorAll("#doc img").length, "正文里的 <img> 不得变成元素").toBe(0);
    expect(document.querySelectorAll("#doc textarea").length, "正文里的 </textarea> 不得破坏结构").toBe(0);

    // 超长行必须完整进入 DOM（不被截断）
    expect(txTexts.some((text) => text.length === 4000), "4000 字符的长行必须完整渲染").toBe(true);
    // Unicode 必须完好
    expect(txTexts.some((text) => text.includes("🚇") && text.includes("Ελληνικά"))).toBe(true);
  });

  it("页面用 token 请求头读私有数据（正文不经 HTML 内嵌）", async () => {
    const { token, fetchCalls } = await loadPage();
    expect(fetchCalls.length, "必须发起引导请求").toBeGreaterThan(0);
    const bootstrapCall = fetchCalls.find((call) => call.url.includes("/api/bootstrap"));
    expect(bootstrapCall, "必须请求 /api/bootstrap").toBeDefined();
    expect(bootstrapCall!.headers["x-cet6-session-token"], "必须带 token 请求头").toBe(token);
    // 页面 HTML 里不得有内嵌引导数据
    expect(renderAnnotationShell()).not.toContain('id="bootstrap"');
  });

  it("token 在读完后立刻从地址栏移除（fragment 不留在可见历史里）", async () => {
    const { token } = await loadPage();
    expect(window.location.hash, "fragment 必须已被 replaceState 抹掉").not.toContain(token);
  });

  it("缺少 token 时给出明确失败，而不是静默空白页", async () => {
    const html = renderAnnotationShell();
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
    window.location.hash = ""; // 没有 token
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    (window as unknown as { fetch: unknown }).fetch = fetchMock;

    const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)!;
    new Function(match[1])();

    const bannerEl = document.getElementById("banner")!;
    expect(bannerEl.textContent, "必须明确说明缺少会话凭据").toContain("凭据");
    expect(bannerEl.className, "必须是错误状态").toContain("err");
    // 且不得发起任何私有数据请求
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("引导请求被拒时给出明确失败（不假装已载入）", async () => {
    const html = renderAnnotationShell();
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
    window.location.hash = "#token=some-token";
    (window as unknown as { fetch: unknown }).fetch = vi.fn(async () => jsonResponse({ ok: false }, 403));

    const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)!;
    new Function(match[1])();

    await vi.waitFor(() => {
      const b = document.getElementById("banner")!;
      if (!b.textContent?.includes("无法载入")) throw new Error("尚未失败");
    });
    expect(document.getElementById("save") as HTMLButtonElement).toHaveProperty("disabled", true);
    expect(document.querySelectorAll(".line").length, "失败时不得渲染任何行").toBe(0);
  });

  it("保存按钮在数据载入前是禁用的（不产生半截计划）", () => {
    const html = renderAnnotationShell();
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
    const save = document.getElementById("save") as HTMLButtonElement;
    expect(save.disabled, "初始必须是禁用态（loading 状态）").toBe(true);
    const newUnitBtn = document.getElementById("newUnit") as HTMLButtonElement;
    expect(newUnitBtn.disabled, "新建练习按钮初始也必须禁用").toBe(true);
  });

  it("页面脚本里没有任何外部资源引用（零外部资源是结构事实）", () => {
    const html = renderAnnotationShell();
    expect(html).not.toMatch(/<script\s+[^>]*\bsrc=/i);
    expect(html).not.toMatch(/<link\s+[^>]*\bhref=/i);
    expect(html).not.toMatch(/<iframe/i);
    // 页面源码文件里不得有 CDN 引用
    const source = readFileSync(join(process.cwd(), "src/content/course-pipeline/segment-page.ts"), "utf8");
    for (const forbidden of ["cdn.", "unpkg", "jsdelivr", "googleapis"]) {
      expect(source, `不得引用 ${forbidden}`).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// 验收 1~3 —— 首次打开、引导、无技术词
// ---------------------------------------------------------------------------

describe("首次打开 · 引导（验收 1、2、3）", () => {
  it("① 首次打开出现引导面板：标题 / 一句说明 / 恰好三步 / 一个主按钮", async () => {
    await loadPage({ enterWorkspace: false });

    expect(document.body.classList.contains("onboarding-open"), "首次打开必须处于引导态").toBe(true);

    const panel = document.querySelector(".onboarding")!;
    expect(panel, "必须存在引导面板").not.toBeNull();

    const title = document.getElementById("onboardingTitle")!;
    expect(title.textContent, "标题必须是产品任务，不是内部术语").toBe("把这份讲义分成一份份翻译练习");

    const text = panel.textContent ?? "";
    expect(text, "必须说明不需要改内容").toContain("你不需要修改内容，只需要告诉系统每一段属于什么。");
    expect(text, "第一步").toContain("① 新建一份练习");
    expect(text, "第二步").toContain("② 标出原文、参考译文和老师讲解");
    expect(text, "第三步").toContain("③ 全部处理完后检查并保存");

    // 三步就是三步 —— 不做教程墙
    expect(panel.querySelectorAll(".onboarding-steps li").length, "引导必须恰好三步").toBe(3);

    const start = btn("startAnnotating");
    expect(start, "必须有主按钮").not.toBeNull();
    expect(start.textContent, "主按钮文案").toBe("开始标注");
  });

  it("② 点「开始标注」进入工作区，且工作区给出**一句话**的当前动作", async () => {
    await loadPage({ enterWorkspace: false });
    btn("startAnnotating").click();

    expect(document.body.classList.contains("onboarding-open"), "引导必须关闭").toBe(false);
    expect(guideAction(), "必须立刻给出唯一的当前动作").toContain("新建一份翻译练习");
    // 四类控件此刻还不可用（没有练习可标）—— 不让人在错误的状态下乱点
    expect(cat("source").disabled, "还没有练习时类别按钮不可用").toBe(true);
  });

  it("引导可以被「怎么用？」重新打开（不占正常视线，但永远找得到）", async () => {
    await loadPage();
    expect(document.body.classList.contains("onboarding-open")).toBe(false);

    btn("help").click();
    expect(document.body.classList.contains("onboarding-open"), "必须能重新打开引导").toBe(true);
    expect(document.getElementById("onboardingTitle")!.textContent).toBe("把这份讲义分成一份份翻译练习");

    btn("startAnnotating").click();
    expect(document.body.classList.contains("onboarding-open")).toBe(false);
  });

  it("③ 正常界面里**不出现任何技术枚举名/诊断词**（验收 3）", async () => {
    await loadPage({ existingPlan: null });
    const unitIndex = newUnit();
    expect(unitIndex).toBe(0);
    markRange("source", 1, 2);
    // 制造一次重叠，让"问题区"也渲染出来 —— 那里最容易漏出内部词汇
    cat("notes").click();
    lines()[2].click();
    lines()[3].click();

    const text = visibleText();
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
      "sha256",
      "plan_unassigned_content",
      "plan_range_overlap",
    ]) {
      expect(text, `正常可见界面不得出现内部词汇「${forbidden}」`).not.toContain(forbidden);
    }
    // 内部枚举名只允许留在 data-channel 属性里（不可见）
    expect(cat("ignored_furniture").dataset.channel, "属性里仍是内部名（数据契约不变）").toBe("ignored_furniture");
  });

  it("四类控件的可见文案与解释句都是中文产品语言", async () => {
    await loadPage();
    newUnit();

    const names = [...document.querySelectorAll("#channelBtns .cat-name")].map((el) => el.textContent);
    expect(names, "四类必须是这四句产品语言").toEqual([
      "中文原文",
      "课程参考译文",
      "老师讲解 / 语言点",
      "页眉页脚（忽略）",
    ]);

    const helps = [...document.querySelectorAll("#channelBtns .cat-help")].map((el) => el.textContent ?? "");
    expect(helps.length, "每一类都必须带一句解释").toBe(4);
    for (const help of helps) expect(help.trim().length, "解释句不得为空").toBeGreaterThan(6);
    expect(helps[3], "页眉页脚的解释必须说清「每页重复出现」").toContain("每页重复出现");
    expect(helps[0], "原文的解释必须说清「要翻译的中文」").toContain("要翻译的中文");
    expect(helps[1], "参考译文的解释必须说清「没有可以跳过」").toContain("没有可以跳过");

    // 使用者 永远不需要理解 "Furniture"
    expect(visibleText(), "不得出现 Furniture").not.toContain("Furniture");
  });
});

// ---------------------------------------------------------------------------
// 验收 4~11 —— 引导式标注流程
// ---------------------------------------------------------------------------

describe("引导式标注流程（验收 4~11）", () => {
  it("④ 可以新建「第 1 份练习」，且用人的话命名而不是内部 id", async () => {
    await loadPage();
    expect(document.querySelectorAll(".unit").length, "初始没有练习").toBe(0);

    const index = newUnit();
    expect(index, "第一份练习的序号是 0").toBe(0);
    expect(document.querySelectorAll(".unit").length, "点击后必须出现一份练习").toBe(1);

    const title = document.querySelector(".unit input") as HTMLInputElement;
    expect(title.value, "标题必须是「第 1 份练习」").toBe("第 1 份练习");
    expect(guideWhere(), "当前练习必须用人话表达").toBe("当前：第 1 份练习");
    expect(cat("source").disabled, "有了练习后类别按钮必须可用").toBe(false);
  });

  it("⑤⑥⑦⑧⑨ 选类别 → 点第一行 → 进入等待终点态 → 点最后一行 ⇒ 闭区间整段被标记", async () => {
    await loadPage();
    newUnit();

    // ⑤ 选「中文原文」
    cat("source").click();
    expect(cat("source").dataset.on, "类别按钮必须显示为已选").toBe("1");
    expect(guideAction(), "选完类别必须告诉人下一步点什么").toContain("请选择「中文原文」");
    expect(guideAction(), "必须说清是先点第一行再点最后一行").toContain("先点这一段的第一行，再点最后一行");

    // ⑥ 点第一行
    lines()[1].click();

    // ⑦ 界面**明确**进入"等待最后一行"的状态（这是旧版最缺的一条）
    expect(guideAction(), "必须明确说出已选起点").toContain("已选起点，再点这一段的最后一行");
    expect(banner().textContent, "横幅也要说同一件事").toContain("已选起点，再点这一段的最后一行");
    expect(lines()[1].classList.contains("anchor"), "起点行必须有可见的锚点样式").toBe(true);

    // ⑧ 点最后一行（第 5 行）
    lines()[4].click();

    // ⑨ 闭区间 2–5 整段被标记：4 行全部着色 + 全部带文字标签
    const marked = [...document.querySelectorAll(".line.source")] as HTMLElement[];
    expect(marked.length, "2~5 行恰好 4 行被标记").toBe(4);
    expect(marked.map((el) => el.dataset.line)).toEqual(["2", "3", "4", "5"]);

    // 文字标签必须存在（不能只靠颜色）
    for (const el of marked) {
      expect(el.classList.contains("marked"), "被标记行必须带 marked 类").toBe(true);
      expect(el.querySelector(".mark")!.textContent, "每一行都要有可见的文字标签").toBe("原文");
    }

    const record = document.querySelector(".unit .assign")!;
    expect(record.textContent, "记录必须用中文类别名").toContain("中文原文");
    expect(record.textContent, "记录必须写清是人话的位置").toContain("第 1 页 · 第 2 到 5 行");
    expect(guideAction(), "标记完成后必须给出**下一个**动作").toContain("课程参考译文");
  });

  it("⑩ 不需要 Shift：选另一个类别再点两下即可标记第二类", async () => {
    await loadPage();
    newUnit();

    markRange("source", 1, 2);
    // 第二次标注**完全不使用 Shift**，只靠"选类别 → 点起点 → 点终点"
    markRange("notes", 3, 4);

    expect(document.querySelectorAll(".line.source").length, "原文 2 行").toBe(2);
    expect(document.querySelectorAll(".line.notes").length, "讲解 2 行").toBe(2);
    expect(document.querySelectorAll(".unit .assign").length, "两条标记记录").toBe(2);

    const chips = [...document.querySelectorAll(".unit .assign .chip")].map((el) => el.textContent);
    expect(chips, "两条记录都是中文类别名").toEqual(["中文原文", "老师讲解 / 语言点"]);

    // 反向的闭区间也必须成立：先点**下面**的行，再点**上面**的行。
    // 这里用 5~7 这 3 行（此前未被标记，因此不会与上面的范围重叠）。
    cat("ignored_furniture").click();
    lines()[6].click(); // 先点第 7 行
    lines()[4].click(); // 再点第 5 行 —— 反向，得到闭区间 5~7
    const reversed = [...document.querySelectorAll(".line.ignored_furniture")] as HTMLElement[];
    expect(reversed.map((el) => el.dataset.line), "反向选择必须得到同一个闭区间 5~7").toEqual(["5", "6", "7"]);
    expect(reversed[0].querySelector(".mark")!.textContent, "反向标记也要带文字标签").toBe("页眉页脚");
    expect(progressText(), "反向标记后不得出现重复标记").not.toContain("重复标记");
  });

  it("⑪ 参考译文可以跳过：引导明说可跳，且不标它也能保存", async () => {
    const page = await loadPage();
    newUnit();
    markRange("source", 1, SYNTHETIC_LINES.length);

    // 引导必须明说"没有参考译文可以跳过"，而不是把它当成必填
    const action = guideAction();
    expect(action, "必须推荐标参考译文").toContain("课程参考译文");
    expect(action, "必须明说可以跳过").toContain("如果这份练习没有参考译文，可以跳过。");

    // 跳过后保存必须成功（参考译文不是必填）
    expect(btn("save").disabled, "有效状态下 Save 必须可达").toBe(false);
    btn("save").click();
    await vi.waitFor(() => {
      if (document.getElementById("done")!.hidden) throw new Error("尚未完成");
    });
    expect(planWrites(page.fetchCalls).length, "跳过参考译文后必须能保存成功").toBe(1);
    expect(banner().className, "必须是成功态").toContain("ok");
  });

  it("点第一行之前没选类别 ⇒ 明确纠正，而不是静默什么都不发生", async () => {
    await loadPage();
    newUnit();
    lines()[0].click();

    expect(banner().textContent, "必须告诉人要先选类别").toContain("请先在右边选一个类别");
    expect(document.querySelectorAll(".unit .assign").length, "不得产生任何标记").toBe(0);
  });

  it("“完成这份练习，开始下一份”建出「第 2 份练习」并把它设为当前", async () => {
    await loadPage();
    newUnit();
    markRange("source", 1, 3);

    const next = btn("nextUnit");
    expect(next.textContent, "按钮文案必须是人的话").toContain("完成这份练习，开始下一份");
    next.click();

    expect(document.querySelectorAll(".unit").length, "必须出现第二份练习").toBe(2);
    const titles = [...document.querySelectorAll(".unit input")].map((el) => (el as HTMLInputElement).value);
    expect(titles, "两份练习都用人的话命名").toEqual(["第 1 份练习", "第 2 份练习"]);
    expect(guideWhere(), "当前练习必须切到第二份").toBe("当前：第 2 份练习");
  });
});

// ---------------------------------------------------------------------------
// 验收 12~14 —— 撤销、取消标记、人话进度
// ---------------------------------------------------------------------------

describe("撤销 / 取消标记 / 人话进度（验收 12~14）", () => {
  it("⑫ 「撤销上一步」真的撤销掉刚才的标记（并支持 Ctrl+Z）", async () => {
    await loadPage();
    newUnit();

    markRange("source", 1, 3);
    expect(document.querySelectorAll(".unit .assign").length, "先有一条标记").toBe(1);

    const undoBtn = btn("undo");
    expect(undoBtn.disabled, "有可撤销的操作时按钮必须可用").toBe(false);
    undoBtn.click();

    expect(document.querySelectorAll(".unit .assign").length, "撤销后标记必须消失").toBe(0);
    expect(document.querySelectorAll(".line.source").length, "撤销后不得残留着色").toBe(0);
    expect(banner().textContent, "必须确认撤销发生了").toContain("已经撤销上一步");

    // 再撤一次也应该回到"新建练习之前"的状态
    undoBtn.click();
    expect(document.querySelectorAll(".unit").length, "连续撤销必须逐级回退").toBe(0);
    expect(btn("undo").disabled, "没有可撤销的操作时按钮必须禁用").toBe(true);

    // Ctrl+Z 也要能用
    newUnit();
    markRange("source", 1, 2);
    expect(document.querySelectorAll(".unit .assign").length).toBe(1);
    window.dispatchEvent(new window.KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true }));
    expect(document.querySelectorAll(".unit .assign").length, "Ctrl+Z 必须也能撤销").toBe(0);
  });

  it("⑬ 可以取消已有的标记：点那一行选中它，再点「取消这个标记」", async () => {
    await loadPage();
    newUnit();
    markRange("source", 1, 3);

    // 点已标记的行 ⇒ 选中那条标记（而不是报错）
    lines()[1].click();
    expect(banner().textContent, "点已标记的行必须说明它现在是什么").toContain("已经标成「中文原文」");
    expect(btn("unmark").disabled, "选中标记后「取消这个标记」必须可用").toBe(false);
    expect(guideAction(), "必须告诉人接下来能做什么").toContain("取消这个标记");

    btn("unmark").click();
    expect(document.querySelectorAll(".unit .assign").length, "标记必须被移除").toBe(0);
    expect(document.querySelectorAll(".line.source").length, "界面必须立刻反映移除").toBe(0);
    expect(banner().textContent, "必须确认移除").toContain("这个标记已经取消");
  });

  it("取消标记也可以直接从练习清单里点该条记录的按钮", async () => {
    await loadPage();
    newUnit();
    markRange("source", 1, 3);
    markRange("notes", 4, 5);

    const removeButtons = [...document.querySelectorAll(".unit .assign button")] as HTMLButtonElement[];
    expect(removeButtons.length, "两条记录各有一个取消按钮").toBe(2);
    removeButtons[0].click();

    const chips = [...document.querySelectorAll(".unit .assign .chip")].map((el) => el.textContent);
    expect(chips, "被点的那条必须消失，另一条保留").toEqual(["老师讲解 / 语言点"]);
  });

  it("「取消当前选择」可以放弃已经点下的起点", async () => {
    await loadPage();
    newUnit();
    cat("source").click();
    lines()[1].click();
    expect(lines()[1].classList.contains("anchor"), "先确认起点已建立").toBe(true);

    btn("cancelPick").click();

    expect(document.querySelectorAll(".line.anchor").length, "起点必须被清除").toBe(0);
    expect(document.querySelectorAll(".line.picked").length, "预览必须被清除").toBe(0);
    expect(document.querySelectorAll(".unit .assign").length, "取消选择不得产生标记").toBe(0);
    expect(banner().textContent, "必须确认取消").toContain("已经取消当前的选择");
  });

  it("⑭ 剩余未处理行数用**人话**表达并随标注实时更新", async () => {
    await loadPage();
    const total = SYNTHETIC_LINES.length;
    newUnit();

    expect(progressText(), "初始必须报告还有多少行没处理").toContain(`还有 ${total} 行没有处理`);
    expect(progressText(), "必须给出分母").toContain(`已处理 0 / ${total} 行`);

    markRange("source", 1, 3);
    expect(progressText(), "标了 3 行后必须更新").toContain(`还有 ${total - 3} 行没有处理`);
    expect(progressText(), "计数必须同步").toContain(`已处理 3 / ${total} 行`);

    markRange("notes", 4, total);
    expect(progressText(), "全部标完后必须说全部处理好了").toContain(`全部 ${total} 行都处理好了`);
    expect(progressText(), "不得再报未处理").not.toContain("没有处理");
  });
});

// ---------------------------------------------------------------------------
// 验收 15 —— 重叠必须是**人话**纠正，且底层拒绝不变
// ---------------------------------------------------------------------------

describe("重叠（验收 15）", () => {
  it("⑮ 重叠给出人话纠正，且不出现 overlap / 技术词", async () => {
    await loadPage();
    newUnit();
    markRange("source", 1, 3);
    // 再把第 2~4 行标成讲解 ⇒ 第 2、3 行被标了两次
    markRange("notes", 2, 4);

    const text = visibleText();
    expect(text, "必须用人话说明重复标记").toContain("有 2 处内容被重复标记，需要处理");
    expect(text, "必须给出纠正动作").toContain("这几行已经被标成其他内容，请先取消原来的标记。");
    expect(text, "必须给出行位置，让人找得到").toContain("第 1 页 · 第 2 行");
    expect(text, "不得出现 overlap 这个词").not.toContain("overlap");

    // 重叠行必须有可见标记
    expect(document.querySelectorAll(".line.overlap").length, "必须标出重叠行").toBe(2);
    // 引导必须把人的注意力引到纠正上
    expect(guideAction(), "引导必须指向纠正动作").toContain("被标了两次");
  });
});

// ---------------------------------------------------------------------------
// 验收 16~19 —— 检查并保存
// ---------------------------------------------------------------------------

describe("检查并保存（验收 16~19）", () => {
  it("⑯⑱ `检查并保存` 走既有的认证保存路径，并在有效状态下保存成功", async () => {
    const page = await loadPage();
    newUnit();
    markRange("source", 1, SYNTHETIC_LINES.length);

    const save = btn("save");
    expect(save.textContent, "按钮文案必须是「检查并保存」").toBe("检查并保存");
    expect(save.disabled, "有效状态下 Save 必须可用").toBe(false);
    expect(planWrites(page.fetchCalls).length, "点击之前不得有任何写请求").toBe(0);

    save.click();
    await vi.waitFor(() => {
      if (document.getElementById("done")!.hidden) throw new Error("尚未到达成功状态");
    });

    const writes = planWrites(page.fetchCalls);
    expect(writes.length, "必须恰好发出一次写请求").toBe(1);
    expect(writes[0].url, "必须打既有的保存端点").toContain("/api/plan");
    expect(writes[0].headers[SESSION_TOKEN_HEADER], "写请求必须带会话 token 请求头").toBe(page.token);
  });

  it("⑰ 无效状态（没有原文）不得假装成功，也不得发出写请求", async () => {
    const page = await loadPage();
    newUnit(); // 建了练习但什么都不标
    expect(btn("save").disabled, "控件本身仍可达（由点击处理器与服务端判定有效性）").toBe(false);

    btn("save").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(planWrites(page.fetchCalls).length, "无原文时不得发出写请求").toBe(0);
    expect(banner().className, "必须是错误态").toContain("err");
    expect(banner().textContent, "必须说清缺什么").toContain("中文原文");
    expect(document.getElementById("done")!.hidden, "绝不能显示成功面板").toBe(true);
    expect(visibleText(), "绝不能出现已保存").not.toContain("✓ 已保存");
  });

  it("⑰b 服务端拒绝时不得假装成功（成功判定只看服务端回包）", async () => {
    const page = await loadPage({ planRejected: true });
    newUnit();
    markRange("source", 1, SYNTHETIC_LINES.length);

    btn("save").click();
    await vi.waitFor(() => {
      if (!banner().className.includes("err")) throw new Error("尚未失败");
    });

    expect(planWrites(page.fetchCalls).length, "请求必须发出去（被拒是服务端的判断）").toBe(1);
    expect(banner().textContent, "必须如实报出失败").toContain("没能保存");
    expect(document.getElementById("done")!.hidden, "失败时绝不能显示成功面板").toBe(true);
    expect(document.getElementById("planDigest")!.textContent, "失败时不得显示计划校验和").not.toContain("计划校验和");
  });

  it("提交前必须确认未处理的行（页内确认，可被真实点击）", async () => {
    const page = await loadPage();
    newUnit();
    markRange("source", 1, 2); // 只标 2 行，仍有未处理的行

    btn("save").click();
    await vi.waitFor(() => {
      if (document.getElementById("confirmBox")!.hidden) throw new Error("尚未出现确认");
    });
    expect(document.getElementById("confirmBox")!.textContent, "确认必须用人话说明后果").toContain("行没有处理");
    expect(planWrites(page.fetchCalls).length, "确认之前不得写").toBe(0);

    // 选"回去继续标" ⇒ 不保存
    const no = [...document.querySelectorAll("#confirmBox button")].find(
      (b) => b.textContent === "回去继续标",
    ) as HTMLButtonElement;
    no.click();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(planWrites(page.fetchCalls).length, "选择继续标注时不得写").toBe(0);
    expect(banner().textContent, "必须如实说明已取消").toContain("已取消保存");

    // 再点一次并选"仍然保存" ⇒ 必须真的写
    btn("save").click();
    await vi.waitFor(() => {
      if (document.getElementById("confirmBox")!.hidden) throw new Error("尚未出现确认");
    });
    confirmYes();
    await vi.waitFor(() => {
      if (planWrites(page.fetchCalls).length === 0) throw new Error("尚未写入");
    });
    expect(planWrites(page.fetchCalls).length, "选仍然保存时必须真的写").toBe(1);
  });

  it("⑲ 成功画面：✓ 已保存 + 现在可以关闭这个页面 + 回去怎么说", async () => {
    await loadPage();
    newUnit();
    markRange("source", 1, SYNTHETIC_LINES.length);
    btn("save").click();

    await vi.waitFor(() => {
      if (document.getElementById("done")!.hidden) throw new Error("尚未到达成功状态");
    });

    const done = document.getElementById("done")!;
    const text = done.textContent ?? "";
    expect(text, "必须有成功标题").toContain("✓ 已保存");
    expect(text, "必须明确告诉人可以关页面").toContain("现在可以关闭这个页面。");
    expect(text, "必须给出回去之后说什么").toContain("回到 ChatGPT 告诉我：“翻译分段已保存”。");

    // 这个提示里**不得**夹带任何私有课程内容
    for (const line of SYNTHETIC_LINES) {
      if (line.length > 10) expect(text, "成功提示不得夹带课程正文").not.toContain(line);
    }
    // 不许自己编成功 —— 只依据服务端回包
    expect(banner().className, "横幅必须是成功态").toContain("ok");
  });

  it("折叠的「高级信息」里证据一条不少（校验和 / 坐标 / 源摘要）", async () => {
    await loadPage();
    newUnit();
    markRange("source", 1, 3);

    const advanced = document.querySelector("details.advanced")!;
    expect(advanced, "必须有折叠的高级信息").not.toBeNull();

    const digest = document.getElementById("planDigest")!;
    expect(advanced.contains(digest), "计划校验和必须住在高级信息里").toBe(true);

    const body = document.getElementById("advancedBody")!.textContent ?? "";
    expect(body, "必须保留源摘要证据").toContain("c".repeat(64));
    expect(body, "必须保留资产校验和证据").toContain("sha-k");
    expect(body, "必须保留坐标清单证据").toContain("p1:1-3");
    expect(body, "必须保留课程 id").toContain("wiring-course");
  });
});

// ---------------------------------------------------------------------------
// 验收 20 —— 保存的契约必须与既有权威域模型兼容
// ---------------------------------------------------------------------------

describe("保存契约（验收 20）", () => {
  it("⑳ 页面提交的载荷经服务端重建后，仍与既有计划契约逐字段兼容", async () => {
    const page = await loadPage();
    newUnit();
    markRange("source", 1, 3);
    markRange("reference_translation", 4, 5);
    markRange("ignored_furniture", 6, 6);
    markRange("notes", 7, 7);

    btn("save").click();
    await vi.waitFor(() => {
      if (document.getElementById("done")!.hidden) throw new Error("尚未保存");
    });

    const write = planWrites(page.fetchCalls)[0];
    const submitted = JSON.parse(write.body!) as {
      author: string;
      reason: string;
      units: {
        title: string;
        kind: string;
        assignments: {
          channel: string; assetKey: string; page: number;
          lineStart: number; lineEnd: number; note: string | null;
        }[];
      }[];
    };

    // ── 提交的通道名必须仍是**内部枚举名**（界面改了，数据契约没改）──
    expect(submitted.units[0].title, "练习标题就是界面上的人话名字").toBe("第 1 份练习");
    expect(submitted.units[0].kind, "段种类不变").toBe("translation_passage");
    expect(
      submitted.units[0].assignments.map((a) => a.channel),
      "四条标记的内部通道名必须原样",
    ).toEqual(["source", "reference_translation", "ignored_furniture", "notes"]);
    expect(submitted.units[0].assignments[0]).toEqual({
      channel: "source", assetKey: "k", page: 1, lineStart: 1, lineEnd: 3, note: null,
    });

    // ── 服务端按**当前时刻**重建 binding（浏览器不参与 binding）──
    const plan = buildPlanFromSubmission({
      submitted: { author: submitted.author, reason: submitted.reason, units: submitted.units },
      courseId: "wiring-course",
      sourceDigest: "c".repeat(64),
      currentAssetChecksums: new Map([["k", "sha-k"]]),
    });

    // ── 产出的计划必须仍能通过既有权威形状校验 ──
    const shape = validatePlanShape(plan);
    expect(shape.ok, `重建的计划必须形状合法：${JSON.stringify(shape.issues)}`).toBe(true);
    expect(shape.plan!.units.length).toBe(1);
    expect(
      shape.plan!.units[0].assignments.map((a) => a.channel),
      "经权威解析后的通道顺序与语义必须保持",
    ).toEqual(["source", "reference_translation", "ignored_furniture", "notes"]);
  });

  it("页面提交的字段里**没有** binding（binding 只能由服务端重建）", async () => {
    const page = await loadPage();
    newUnit();
    markRange("source", 1, SYNTHETIC_LINES.length);
    btn("save").click();
    await vi.waitFor(() => {
      if (document.getElementById("done")!.hidden) throw new Error("尚未保存");
    });

    const write = planWrites(page.fetchCalls)[0];
    const submitted = JSON.parse(write.body!) as Record<string, unknown>;
    expect(submitted, "浏览器不得提交 binding").not.toHaveProperty("binding");
    expect(submitted, "浏览器不得提交 schemaVersion").not.toHaveProperty("schemaVersion");
    expect(Object.keys(submitted).sort(), "提交的字段必须恰好是这三样").toEqual(["author", "reason", "units"]);
  });
});

// ---------------------------------------------------------------------------
// Save 控件的可达性 —— 三态状态机（既有阻断项的守卫，不变）
// ---------------------------------------------------------------------------

/**
 * **为什么单独成组**：这里守的是一条**接线**而不是一条算法。
 *
 * 复评证明的缺陷形态：页面的**引导成功路径**启用了「新建练习」，
 * 却**没有**启用「保存计划」。于是：
 *
 * - 载入成功、可建练习、可指派四类、可多范围；
 * - 唯独 Save 永远停在 `disabled`（初始态），点它**发不出任何请求**；
 * - 手工把 `save.disabled = false` 之后，保存**立刻成功**。
 *
 * 因此保存实现本身是健康的，坏的是控件状态接线。语法检查、正则断言、
 * 甚至"按钮点击有反应"都抓不住它 —— 只有**真的走完整条流程并点 Save**
 * 才能抓住。这正是本组存在的原因。
 */
describe("Save 控件可达性（三态状态机）", () => {
  it("**引导成功后 Save 变为可用**（既有阻断项的守卫）", async () => {
    await loadPage();
    expect(btn("save").disabled, "引导成功后 Save 必须可用（否则整个流程走不完）").toBe(false);
    expect(btn("newUnit").disabled, "引导成功后新建练习也必须可用").toBe(false);
  });

  it("**载入中 Save 保持禁用**（bootstrap 尚未 resolve 时不得可点）", () => {
    const html = renderAnnotationShell();
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
    window.location.hash = "#token=some-token";

    /*
     * 让引导请求**永不 resolve** ⇒ 页面停在"载入中"这一态。
     * 这条证明"初始禁用"确实生效，而不是靠"成功回调恰好没跑"蒙对。
     */
    (window as unknown as { fetch: unknown }).fetch = vi.fn(() => new Promise(() => {}));

    const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)!;
    new Function(match[1])();

    expect(btn("save").disabled, "载入中 Save 必须禁用").toBe(true);
    expect(btn("newUnit").disabled, "载入中新建练习也必须禁用").toBe(true);
    expect(document.querySelectorAll(".line").length, "载入中不得渲染任何行").toBe(0);
  });

  it("**引导失败后 Save 保持禁用**（不得留下可点的半死控件）", async () => {
    const html = renderAnnotationShell();
    document.documentElement.innerHTML = html.replace(/^<!doctype html>/i, "");
    window.location.hash = "#token=some-token";
    (window as unknown as { fetch: unknown }).fetch = vi.fn(async () => jsonResponse({ ok: false }, 403));

    const match = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i.exec(html)!;
    new Function(match[1])();

    await vi.waitFor(() => {
      const b = document.getElementById("banner")!;
      if (!b.textContent?.includes("无法载入")) throw new Error("尚未失败");
    });
    expect(btn("save").disabled, "引导失败后 Save 必须保持禁用").toBe(true);
    expect(btn("newUnit").disabled).toBe(true);
  });

  it("**重叠状态不得发出写请求**（重叠保护 authoritative 且未被削弱）", async () => {
    const page = await loadPage();
    newUnit();
    markRange("source", 1, 3);
    markRange("notes", 2, 4); // 第 2、3 行被标两次

    expect(document.querySelectorAll(".line.overlap").length, "必须标出重叠行").toBeGreaterThan(0);

    btn("save").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(planWrites(page.fetchCalls).length, "存在重叠时不得发出写请求").toBe(0);
    expect(banner().className).toContain("err");
    expect(banner().textContent, "必须给出人话的重叠纠正").toContain("已经被标成其他内容，请先取消原来的标记");
  });
});
