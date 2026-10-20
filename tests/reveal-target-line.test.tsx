import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import type { LinkedPaperSummary } from "@/lib/course-reveal-contract";

/**
 * `PaperTargetLine` 的**渲染**回归（Final P2 第 1 项）。
 *
 * ── 它守的那个真实缺陷 ──
 *
 * 独立审查复现：`PaperTargetLine` 用 `head.indexOf(" · ")`
 * 切分"卷名"与"目标列表"。但**卷名本身就可能含 `" · "`**：
 * `2024 年 12 月 · set1` 是标准形态（年份 · 场次 · 套别）。
 *
 * 于是：卷名被截成 `2024 年 12 月`（**丢掉套别**）、`set1` 变成第一个
 * 目标的一部分、还可能多出一个孤立 bullet。
 *
 * 学习者看到"我确认的是 2024 年 12 月"，而库里有**好几套** 12 月卷子 ——
 * 这不是排版瑕疵，是**确认范围再次被写错**。
 *
 * ── 判据为什么按**结构**而不是"名字出现过" ──
 *
 * 断言 `getByText(/第 1 组/)` 可见，在卷名被截错时**照样通过**
 * （"第 1 组"还在页面上，只是前面多了个 `set1 ·`）。
 * 因此这里断言**每一种 span 各自的文本**：卷名行的完整文本、
 * 每个目标行的精确文本、以及目标行的数量。
 *
 * ── 隐私 ──
 *
 * 全部是字面量夹具，不碰任何真实内容或数据库。
 */

const { PaperTargetLine } = await import("@/app/practice/courses/[courseId]/reveal-button");

/** 构造一条展示就绪的真题摘要。 */
function summary(overrides: Partial<LinkedPaperSummary> = {}): LinkedPaperSummary {
  return {
    paperId: "fixture-cet6-2024-12-set1",
    paperTitle: "2024 年 12 月 · set1",
    targetLabel: "2024 年 12 月 · set1 · 阅读 · 仔细阅读（整个大题）",
    runtimeUsable: true,
    unusableReason: null,
    trainable: false,
    reservedForMock: true,
    ...overrides,
  };
}

interface Rendered {
  html: string;
  /** 卷名行（`font-medium`）的文本；单目标时为空（没有拆结构）。 */
  title: string;
  /** 目标行（缩进子项）的文本，`· ` 前缀保留。 */
  targets: string[];
  /** 计数行文本（如 `共 3 个目标`）；单目标时为空。 */
  count: string;
}

/**
 * 渲染并按下述结构拆出三部分。
 *
 * 产品的 DOM 结构（见 `PaperTargetLine`）：
 *
 * ```
 * <span class="flex flex-col gap-0.5">        ← 外层
 *   <span class="font-medium text-content">…卷名…</span>
 *   <span class="flex flex-col gap-0.5 pl-3"> ← 目标容器
 *     <span>· 目标1</span>
 *     <span>· 目标2</span>
 *   </span>
 *   <span class="pl-3 text-content-faint">共 N 个目标</span>
 * </span>
 * ```
 *
 * 因此：卷名行 = `font-medium`；目标行 = 目标容器内的 `span`；
 * 计数行 = `text-content-faint`。三者各有**唯一的 className**，
 * 所以可以按 className 精确取到，不需要给产品加测试专用属性。
 */
function renderPaper(paper: LinkedPaperSummary): Rendered {
  const html = renderToStaticMarkup(createElement(PaperTargetLine, { paper }));
  const text = (raw: string): string => raw.replace(/<[^>]+>/g, "").trim();

  const title = /class="font-medium text-content">([\s\S]*?)<\/span>/.exec(html);
  const count = /class="pl-3 text-content-faint">([\s\S]*?)<\/span>/.exec(html);

  const container = /class="flex flex-col gap-0.5 pl-3">([\s\S]*?)<\/span><span class="pl-3/.exec(
    html,
  );
  const targets = container
    ? [...container[1].matchAll(/<span>([\s\S]*?)<\/span>/g)].map((m) => text(m[1]))
    : [];

  return {
    html,
    title: title ? text(title[1]) : "",
    targets,
    count: count ? text(count[1]) : "",
  };
}

describe("PaperTargetLine · 卷名与目标的切分（Final P2）", () => {
  it("**单目标**：原样渲染契约串（不拆结构、不加计数）", () => {
    const rendered = renderPaper(summary());
    // 单目标时整个串就是一行可读文本 —— 没有卷名行/目标行/计数行的区分。
    expect(rendered.title).toBe("");
    expect(rendered.targets).toEqual([]);
    expect(rendered.count).toBe("");
    expect(rendered.html).toContain("2024 年 12 月 · set1 · 阅读 · 仔细阅读（整个大题）");
  });

  it("**多目标**：卷名完整（含 `· set1`），目标各自成行", () => {
    const rendered = renderPaper(
      summary({
        targetLabel:
          "2024 年 12 月 · set1 · 阅读 · 仔细阅读（第 1 组）；阅读 · 仔细阅读（第 2 组）；阅读 · 仔细阅读（整个大题）（共 3 个目标）",
      }),
    );

    /*
     * 卷名必须**完整** —— 这是本组最关键的一条。
     * 缺陷形态下这里是 `2024 年 12 月`（`set1` 被切掉并跑进第一个目标）。
     */
    expect(rendered.title).toBe("2024 年 12 月 · set1");

    // 每个目标精确成行，`· ` 前缀保留（那是产品的 bullet 形态）。
    expect(rendered.targets).toEqual([
      "· 阅读 · 仔细阅读（第 1 组）",
      "· 阅读 · 仔细阅读（第 2 组）",
      "· 阅读 · 仔细阅读（整个大题）",
    ]);
    expect(rendered.count).toBe("共 3 个目标");
  });

  it("**多目标**：`set1` 不得出现在任何目标行里", () => {
    /*
     * 缺陷的直接判据：`set1` 是**卷名**的一部分，
     * 绝不能被当成目标的内容。
     */
    const rendered = renderPaper(
      summary({
        targetLabel:
          "2024 年 12 月 · set1 · 阅读 · 仔细阅读（第 1 组）；阅读 · 仔细阅读（第 2 组）（共 2 个目标）",
      }),
    );
    for (const target of rendered.targets) {
      expect(target, `目标行不得混入套别：${target}`).not.toContain("set1");
      expect(target, `目标行不得混入卷名年份：${target}`).not.toContain("2024");
    }
  });

  it("**多目标**：目标行数必须等于目标数（不多出孤立的 `set1` 行）", () => {
    const rendered = renderPaper(
      summary({
        targetLabel:
          "2024 年 12 月 · set1 · 阅读 · 仔细阅读（第 1 组）；阅读 · 仔细阅读（第 2 组）；阅读 · 长篇阅读（匹配）（整个大题）（共 3 个目标）",
      }),
    );
    expect(rendered.targets).toHaveLength(3);
    expect(rendered.count).toBe("共 3 个目标");
  });

  it("**卷名恒定含 ` · `**（年份 · 场次 · 套别）时仍然完整", () => {
    /*
     * `paperTitle` 的形态是 `<年> 年 <月> 月 · <variant>`，
     * 因此它**恒定**含一个 ` · `。这一条确保切分不依赖
     * "卷名里有几个分隔符"这种偶然性质 —— 那正是上一版的错误假设。
     */
    const rendered = renderPaper(
      summary({
        targetLabel:
          "2024 年 12 月 · set1 · 写作（整个大题）；阅读 · 仔细阅读（第 1 组）（共 2 个目标）",
      }),
    );
    expect(rendered.title).toBe("2024 年 12 月 · set1");
    expect(rendered.targets).toEqual(["· 写作（整个大题）", "· 阅读 · 仔细阅读（第 1 组）"]);
  });

  it("**畸形串**（卷名不是 label 的前缀）⇒ 原样显示，不猜结构", () => {
    /*
     * 服务端将来改了拼装格式时，客户端必须**原样显示可读字符串**，
     * 而不是猜一个结构把卷名切错 —— 后者正是本缺陷的形态。
     */
    const rendered = renderPaper(
      summary({
        targetLabel: "某个完全不同的前缀 · 阅读 · 仔细阅读（第 1 组）（共 1 个目标）",
      }),
    );
    // 原样显示：不拆卷名行、不造目标行。
    expect(rendered.title).toBe("");
    expect(rendered.targets).toEqual([]);
    expect(rendered.html).toContain("某个完全不同的前缀 · 阅读 · 仔细阅读（第 1 组）（共 1 个目标）");
  });

  it("**畸形串**（切出的目标为空）⇒ 原样显示，不渲染空壳", () => {
    const rendered = renderPaper(
      summary({ targetLabel: "2024 年 12 月 · set1 （共 0 个目标）" }),
    );
    expect(rendered.title).toBe("");
    expect(rendered.targets).toEqual([]);
    expect(rendered.html).toContain("2024 年 12 月 · set1 （共 0 个目标）");
  });

  it("**单套别卷**（variant 为 single，卷名不含 ` · `）同样正确", () => {
    /*
     * `paperTitleOf` 在 variant 为 `single` 时**不**加套别后缀，
     * 因此卷名是 `2024 年 12 月`（不含 ` · `）。这一条确保
     * "用 paperTitle 长度切"在两种形态下都对 ——
     * 上一版用 `" · "` 定位时，这种形态会把第一个目标当成卷名。
     */
    const rendered = renderPaper(
      summary({
        paperTitle: "2024 年 12 月",
        targetLabel:
          "2024 年 12 月 · 阅读 · 仔细阅读（第 1 组）；阅读 · 仔细阅读（第 2 组）（共 2 个目标）",
      }),
    );
    expect(rendered.title).toBe("2024 年 12 月");
    expect(rendered.targets).toEqual(["· 阅读 · 仔细阅读（第 1 组）", "· 阅读 · 仔细阅读（第 2 组）"]);
  });
});
