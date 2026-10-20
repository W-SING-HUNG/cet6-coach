/**
 * 提取层的纯函数部分：把 PDF 文本 run 重组成「视觉行」。
 *
 * 为什么这部分必须与 pdfjs 解耦：几何重组是本流水线里**最容易静默出错**的一步。
 * 把它写成纯函数后，可以用合成夹具穷举边界情形，不必依赖真实试卷。
 * pdfjs 只在 `extract.ts` 里被调用一次。
 *
 * ── 一个被实测否掉的方案（记录在此以免重犯）──
 * 最初按「同一基线上 run 之间的水平间隙」把行切成若干"单元格"，
 * 期望用几何区分双栏选项（`A)…` 左栏、`C)…` 右栏）。
 * **该方案实测失败**，原因是 Word 生成的源件用**跨整个间隙的空白 run** 做栏位对齐：
 * 实测 `B)They are afraid…`（right=206.2）与 `D)They are concerned…`（x=288.1）
 * 之间夹着一个 `" "` run，宽度恰好覆盖 206.2→288.1。
 * 于是"相邻非空 run 的间隙"是真实的栏位间隙，但同一个机制也把
 * `Part I` 与 `Writing`（间隙 174pt）分开，而它们**必须**属于同一标题行。
 * 换句话说：**几何间隙无法区分"标题的栏位对齐"与"选项的并列栏位"**。
 *
 * 现行方案：**整行合成一个文本**（按 x 顺序拼接全部 run，含空白 run，
 * 因为空白 run 携带词间空格），再由结构检测层按**选项标签**切分。
 * 这样 `2. A)They are becoming impatient. C)They are used to making alterations.`
 * 会先成为一条完整行文本，再按 `A)`/`C)` 标签切成两个选项 ——
 * 判据落在**内容**上，而不是落在排版上，符合"按语义检测"的原则。
 */

import type { ExtractedRun } from "./types";

/** 同一视觉行的 y 容差（pt）。实测同行 run 的 y 抖动 < 0.6pt。 */
export const LINE_Y_TOLERANCE = 1.2;

export interface RawLine {
  page: number;
  y: number;
  /** 行首 run 的 x。用于识别缩进（段落首行）与居中标题。 */
  x: number;
  /** 行尾 x（最右 run 的右边界）。 */
  xEnd: number;
  text: string;
  runs: ExtractedRun[];
  /** 每个 run 在 text 中的起始偏移（见 ExtractedLine.runStarts 的说明）。 */
  runStarts: number[];
}

/** 按 y 容差把一个页面上的 run 聚成视觉行。 */
function clusterByY(runs: ExtractedRun[]): { y: number; runs: ExtractedRun[] }[] {
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x);
  const clusters: { y: number; runs: ExtractedRun[] }[] = [];

  for (const run of sorted) {
    const last = clusters[clusters.length - 1];
    if (last && Math.abs(last.y - run.y) <= LINE_Y_TOLERANCE) {
      last.runs.push(run);
      last.y = (last.y * (last.runs.length - 1) + run.y) / last.runs.length;
      continue;
    }
    clusters.push({ y: run.y, runs: [run] });
  }

  return clusters;
}

/** 页内 run → 视觉行。**不丢弃任何 run**。 */
export function reconstructPageLines(page: number, runs: ExtractedRun[]): RawLine[] {
  const lines: RawLine[] = [];

  for (const cluster of clusterByY(runs)) {
    const ordered = [...cluster.runs].sort((a, b) => a.x - b.x);
    // 文本按 x 顺序拼接全部 run：空白 run 携带词间空格，必须保留
    let text = "";
    const runStarts: number[] = [];
    for (const run of ordered) {
      runStarts.push(text.length);
      text += run.text;
    }
    const solid = ordered.filter((run) => run.text.trim() !== "");
    const geometry = solid.length > 0 ? solid : ordered;
    lines.push({
      page,
      y: cluster.y,
      x: Math.min(...geometry.map((run) => run.x)),
      xEnd: Math.max(...geometry.map((run) => (run.width > 0 ? run.x + run.width : run.x))),
      text,
      runs: ordered,
      runStarts,
    });
  }

  lines.sort((a, b) => b.y - a.y);
  return lines;
}

/**
 * 从版面实测推正文左边界与段落缩进。
 *
 * 为什么需要它：Word 生成的源件用缩进区分**段落首行**，这是判断长篇阅读
 * A–O 段落与仔细阅读长文段落边界的几何依据之一。
 * 若缩进不明确，必须如实报告，而不是挑一个看起来对的阈值。
 */
export function inferGeometry(lines: RawLine[]): {
  margin: number;
  indent: number;
  indentAmbiguous: boolean;
} {
  const bodyLines = lines.filter((line) => line.text.trim().length > 0);
  if (bodyLines.length === 0) return { margin: 0, indent: 0, indentAmbiguous: true };

  const histogram = new Map<number, number>();
  for (const line of bodyLines) {
    const key = Math.round(line.x * 10) / 10;
    histogram.set(key, (histogram.get(key) ?? 0) + 1);
  }

  const ranked = [...histogram.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
  const margin = ranked[0][0];

  const indentCandidates = ranked
    .filter(([x, count]) => x > margin + 5 && count >= 3)
    .sort((a, b) => a[0] - b[0]);

  if (indentCandidates.length === 0) return { margin, indent: margin, indentAmbiguous: true };

  const indent = indentCandidates[0][0];
  const competing = indentCandidates.filter(([x]) => x < indent + 8 && x !== indent);
  return { margin, indent, indentAmbiguous: competing.length > 0 && indent - margin < 4 };
}
