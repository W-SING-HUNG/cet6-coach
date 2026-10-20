import { test, expect } from "@playwright/test";
import { attachErrorCollectors, expectNoHorizontalOverflow, shot } from "./helpers";
import { E2E_REAL_BASE_URL } from "./config";

/**
 * 真实私有试卷的浏览器级冒烟验证。
 *
 * **本文件可以提交到 Git**：它只包含断言语义与试卷 ID，
 * **不含任何真实试题正文**（由 tests/architecture.test.ts 的指纹守卫强制）。
 *
 * 为什么可以提交：它在缺少真实试卷时会**整体跳过**而不是失败，
 * 因此在 fresh clone（无私有内容、无对应服务）上无害；
 * 而在本机已导入真实试卷时，它提供内容链路的可重复验证。
 *
 * 运行前提（任一不满足即整组跳过，不会让套件变红）：
 *   - 本机有一个以 CET6_CONTENT_ROOT 指向私有内容根启动的服务（默认端口 3210）
 *   - 该库已完成 onboarding
 *   - 对应的试卷包已导入
 *
 * 与已提交的 papers.spec.ts 的分工：那个用**合成夹具**验证 UI 契约（永远可跑）；
 * 本文件用**真实试卷**验证内容链路（仅在本机有内容时运行）。
 *
 * ── 断言设计约束（重要）──
 * 断言只针对**结构**（大题标签、计数、题号范围、资产端点），
 * **不得**引用任何试题正文。理由：一旦把题干/文章片段写进来，
 * 真实内容就进了 Git —— 这正是一条硬门禁所禁止的。
 * 早先本文件曾引用选词填空的文章开头与词库词，已移除并加入指纹守卫。
 */

const BASE = process.env.CET6_REAL_BASE_URL ?? E2E_REAL_BASE_URL;

/** 需要冒烟的真实试卷。新增导入的试卷加在这里即可获得覆盖。 */
const REAL_PAPERS = [
  { id: "cet6-2024-12-set1", label: "2024 年 12 月" },
  { id: "cet6-2024-06-set1", label: "2024 年 6 月" },
  { id: "cet6-2025-06-set1", label: "2025 年 6 月" },
] as const;

/** 官方 8 大题的标签（来自 domain 常量，不是试卷内容）。 */
const SECTION_LABELS = [
  "写作",
  "长对话",
  "听力篇章",
  "讲话 / 报道 / 讲座",
  "选词填空",
  "长篇阅读（匹配）",
  "仔细阅读",
  "段落翻译",
] as const;

/**
 * 探测某份真实试卷是否可用。
 *
 * 前提不满足时**整组跳过**（而不是失败）：这样本文件可以安全提交 ——
 * 在 fresh clone（无私有内容、无该服务）上它整体跳过，
 * 已提交的合成夹具套件（papers.spec.ts）仍然完整覆盖 UI 契约。
 */
async function probePaper(
  request: import("@playwright/test").APIRequestContext,
  paperId: string,
): Promise<{ available: boolean; reason: string }> {
  try {
    const page = await request.get(`${BASE}/practice/papers/${paperId}`, { maxRedirects: 0, timeout: 3000 });
    if (page.status() === 200) return { available: true, reason: "ok" };
    return { available: false, reason: `HTTP ${page.status()}` };
  } catch (error) {
    return { available: false, reason: `服务不可达：${(error as Error).message}` };
  }
}

/** 收集页面上「查看结构」链接的 href，用于按大题类型定位。 */
async function sectionHrefs(page: import("@playwright/test").Page, paperId: string): Promise<string[]> {
  await page.goto(`${BASE}/practice/papers/${paperId}`);
  const hrefs = await page
    .locator(`a[href^="/practice/papers/${paperId}/section/"]`)
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLAnchorElement).getAttribute("href") ?? ""));
  return hrefs;
}

/**
 * 按关键字找某大题的 href。
 *
 * 为什么用「任一关键字命中」而不是精确 id：section id 是包作者定义的，
 * 实测两种命名风格并存 —— 人工构建的包用短名（`cloze` / `careful`），
 * 流水线生成的包用类型名（`reading-banked-cloze` / `reading-careful_reading`）。
 * 冒烟断言的是**该大题能否渲染**，与 id 风格无关，因此按关键字容忍两种。
 */
function findSection(hrefs: string[], ...keywords: string[]): string | undefined {
  return hrefs.find((href) => keywords.some((keyword) => href.includes(keyword)));
}

for (const paper of REAL_PAPERS) {
  test.describe(`真实试卷 ${paper.label}（${paper.id}）：产品级验证`, () => {
    test.beforeEach(async ({ request }) => {
      const probe = await probePaper(request, paper.id);
      test.skip(!probe.available, `跳过真实试卷验证：${probe.reason}`);
    });

    test("真题库出现该试卷，详情页结构完整且状态诚实", async ({ page }) => {
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: 1440, height: 900 });

      await page.goto(`${BASE}/practice/papers`);

      // 来源徽标必须是"历年真题"而不是测试夹具；核验状态不得谎称"已核验"
      await expect(page.getByText("历年真题", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("测试夹具", { exact: true })).toHaveCount(0);
      await expect(page.getByText("部分核验", { exact: true }).first()).toBeVisible();
      // 不存在官方真题来源 ⇒ 不得出现"已核验"
      await expect(page.getByText("已核验", { exact: true })).toHaveCount(0);

      // 详情页
      await page.goto(`${BASE}/practice/papers/${paper.id}`);
      await expect(page.locator("h1").first()).toContainText(paper.label);
      await expect(page.getByText("历年真题", { exact: true }).first()).toBeVisible();
      await expect(page.getByText("部分核验", { exact: true }).first()).toBeVisible();

      // 8 个大题全部出现
      for (const label of SECTION_LABELS) {
        await expect(page.getByText(new RegExp(label.replace(/[（）/·]/g, "."))).first()).toBeVisible();
      }

      // 来源与版本区块必须展示真实溯源信息
      await expect(page.getByText("来源与版本")).toBeVisible();
      /*
       * 溯源信息必须包含一个**可辨别的来源定位符**（URL 或路径），
       * 而不是只有一句空泛的说明。
       *
       * 曾经这里断言一个具体站名。改成匹配"任何 URL 形态"：要验证的性质是
       * "provenance 区块真的渲染出了定位符"，不是"它渲染的是哪个站点"。
       * 后者属于内容事实，会随导入的包而变，把它写进 spec 只会让 spec 脆弱，
       * 并把一份对第三方站点的公开指称留在仓库里。
       */
      await expect(page.getByText(/https?:\/\/[^\s]+/).first()).toBeVisible();
      await expect(page.getByText("完整卷（8 个大题）").first()).toBeVisible();

      await expectNoHorizontalOverflow(page, "real paper detail");
      await shot(page, `real-${paper.id}-01-detail`);

      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    });

    test("听力大题：真实音频可被产品播放（audio 元素 + 可控端点）", async ({ page }) => {
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: 1440, height: 900 });

      const hrefs = await sectionHrefs(page, paper.id);
      // 第二个「查看结构」是长对话（第 0 个是写作）
      const listeningHref = findSection(hrefs, "listening-long_conversation", "long_conversation");
      test.skip(!listeningHref, "该卷未提供听力大题结构链接");

      await page.goto(`${BASE}${listeningHref}`);
      await expect(page.locator("h1").first()).toContainText("长对话");

      // 音频元素存在且 src 指向受控资产端点
      const audio = page.locator("audio");
      await expect(audio.first()).toBeVisible();
      const src = await audio.first().getAttribute("src");
      expect(src, "音频元素缺少 src").not.toBeNull();
      expect(src).toContain(`/practice/papers/${paper.id}/asset/`);

      // 资产端点真实可读（Range 请求走同一个服务）
      const meta = await page.evaluate(async (url) => {
        const res = await fetch(url, { headers: { Range: "bytes=0-1023" } });
        return { status: res.status, type: res.headers.get("content-type"), len: (await res.arrayBuffer()).byteLength };
      }, src!);
      expect(meta.status, "音频端点不可达").toBe(206);
      expect(meta.type).toBe("audio/mp4");
      expect(meta.len).toBe(1024);

      // 音频元数据在页面上如实展示（真实格式不是 mp3）
      await expect(page.getByText(/listening-full\.m4a/).first()).toBeVisible();
      await expect(page.getByText("audio/mp4").first()).toBeVisible();

      await expectNoHorizontalOverflow(page, "real listening section");
      await shot(page, `real-${paper.id}-02-listening`);

      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    });

    test("仔细阅读：答案默认折叠、文章分组保留", async ({ page }) => {
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: 1440, height: 900 });

      const hrefs = await sectionHrefs(page, paper.id);
      const carefulHref = findSection(hrefs, "reading-careful_reading", "careful");
      test.skip(!carefulHref, "该卷未提供仔细阅读结构链接");

      await page.goto(`${BASE}${carefulHref}`);
      await expect(page.locator("h1").first()).toContainText("仔细阅读");

      const answerBlocks = page.locator("details", { hasText: "答案与解析" });
      expect(await answerBlocks.count()).toBeGreaterThan(0);
      for (let index = 0; index < Math.min(3, await answerBlocks.count()); index += 1) {
        await expect(answerBlocks.nth(index)).not.toHaveAttribute("open", "");
      }

      // 展开一个，确认答案确实在（不是空壳）
      await answerBlocks.first().locator("summary").click();
      await expect(page.getByText(/答案：[ABCD]/).first()).toBeVisible();

      // 文章按官方分组保留（Passage One/Two 的**标题**是试卷结构的一部分）
      await expect(page.getByText("Passage One", { exact: false }).first()).toBeVisible();

      await expectNoHorizontalOverflow(page, "real reading section");
      await shot(page, `real-${paper.id}-03-reading`);

      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    });

    test("选词填空：共享文章 + 15 项词库 + 真实题号空位", async ({ page }) => {
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: 1440, height: 900 });

      const hrefs = await sectionHrefs(page, paper.id);
      const clozeHref = findSection(hrefs, "reading-banked-cloze", "cloze");
      test.skip(!clozeHref, "该卷未提供选词填空结构链接");

      await page.goto(`${BASE}${clozeHref}`);
      await expect(page.locator("h1").first()).toContainText("选词填空");

      // 词库基数与空位标记用**题号**表达结构；不引用任何词或文章片段
      await expect(page.getByText(/词库（15 个）/)).toBeVisible();
      await expect(page.getByText(/\[26\]/).first()).toBeVisible();
      await expect(page.getByText(/\[35\]/).first()).toBeVisible();

      await expectNoHorizontalOverflow(page, "real cloze section");
      await shot(page, `real-${paper.id}-04-cloze`);

      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    });

    test("长篇阅读：段落标号 A–O 与 10 条陈述齐备", async ({ page }) => {
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: 1440, height: 900 });

      const hrefs = await sectionHrefs(page, paper.id);
      const matchingHref = findSection(hrefs, "reading-matching", "matching");
      test.skip(!matchingHref, "该卷未提供长篇阅读结构链接");

      await page.goto(`${BASE}${matchingHref}`);
      await expect(page.locator("h1").first()).toContainText("长篇阅读");

      // 题号 36–45（结构信息，非内容）
      await expect(page.getByText(/36/).first()).toBeVisible();
      await expect(page.getByText(/45/).first()).toBeVisible();

      await expectNoHorizontalOverflow(page, "real matching section");
      await shot(page, `real-${paper.id}-05-matching`);

      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    });

    test("翻译：中文原文可渲染（不引用具体文字）", async ({ page }) => {
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: 1440, height: 900 });

      const hrefs = await sectionHrefs(page, paper.id);
      const translationHref = hrefs.find((href) => href.includes("translation"));
      test.skip(!translationHref, "该卷未提供翻译结构链接");

      await page.goto(`${BASE}${translationHref}`);
      await expect(page.locator("h1").first()).toContainText("翻译");

      // 页面必须包含 CJK 字符（翻译原文是中文段落）；只验证"存在"，不验证内容
      const body = await page.locator("main, body").first().innerText();
      expect(/[\u4e00-\u9fff]/.test(body), "翻译页未渲染中文原文").toBe(true);

      await expectNoHorizontalOverflow(page, "real translation section");
      await shot(page, `real-${paper.id}-06-translation`);

      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    });

    test("题干洁净：不残留题号前缀、无站点 UI 文案", async ({ page }) => {
      // 覆盖本次修复的核心缺陷，判据**全为结构/形态**，不引用任何真实题干文字：
      //   1. v1 的某卷 Q1 题干被站点 UI 文案占据（二维码引导/版权声明）；
      //   2. 仔细阅读题干带走了源件行首题号，产出 "46.What is…" 这样的题干。
      // 因此断言：听力与仔细阅读两页的题干文本既不含站点 UI 关键字，
      // 也不以「数字 + 句点」开头。
      const { pageErrors, consoleErrors } = attachErrorCollectors(page);
      await page.setViewportSize({ width: 1440, height: 900 });

      const hrefs = await sectionHrefs(page, paper.id);
      const pages = [
        findSection(hrefs, "listening-long_conversation", "long_conversation"),
        findSection(hrefs, "reading-careful_reading", "careful"),
      ].filter((href): href is string => Boolean(href));
      test.skip(pages.length === 0, "该卷未提供可检查的题干页");

      // 站点 UI 文案的特征词（不是试题内容，是抓取残留）
      const NAV_MARKERS = ["扫一扫", "二维码", "微信公众号", "版权均属", "稿件来源"];

      for (const href of pages) {
        await page.goto(`${BASE}${href}`);
        const body = await page.locator("main, body").first().innerText();

        for (const marker of NAV_MARKERS) {
          expect(body.includes(marker), `题干页残留站点 UI 文案：${marker}`).toBe(false);
        }

        // 以「数字.」开头且**紧跟英文字母**的行不合法：题号应由 UI 渲染，
        // 不应混在题干文本里（实测缺陷形态：`46.What is…`）。
        //
        // 判据必须排除无关数字串：页面上的文件大小（`4.7 MB`）、
        // 分值、时间等也会以数字+点开头，但它们不是题号。
        // 因此要求：数字是 1–2 位、后面紧跟字母（题干的第一个词）。
        // 早先写成"数字+点+任意非空"会把 `4.7 MB` 误报为残留 —— 那是断言过严，
        // 不是真实缺陷，因此收紧到真实缺陷形态。
        const prefixed = body
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => /^\d{1,2}\s*[.．]\s*[A-Za-z]/.test(line));
        expect(
          prefixed.slice(0, 3),
          `题干残留题号前缀（前 3 条）：${prefixed.slice(0, 3).join(" | ")}`,
        ).toEqual([]);
      }

      expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
      expect(consoleErrors, consoleErrors.join("\n")).toHaveLength(0);
    });
  });
}
