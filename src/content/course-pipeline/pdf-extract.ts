/**
 * PDF 逐页文本抽取（含逐页来源证据）。
 *
 * ── 复用既有的 pdfjs-dist 适配器，不引入第二个 PDF 解析器 ──
 *
 * 底层复用 `@/content/pipeline/extract.ts` 的 `extractPdf`（pdfjs-dist
 * `legacy/build/pdf.mjs`，Apache-2.0）。那条链路的可靠性已经被真题流水线
 * 用真实源卷验证过：它给出 run 级几何信息
 * （`transform` / `width` / `height` / `fontName` / `hasEOL`），
 * 而几何正是"把 run 重组成视觉行"的唯一基础。
 *
 * **本模块不重复实现抽取**，只把它整理成"逐页 + 可核对"的形态：
 *
 * | 本模块产出 | 用途 |
 * | --- | --- |
 * | `lines[]` | 段边界判据的输入（行级结构线索） |
 * | `rawText` | **原样**的源件投影，用于引文核对与审计 |
 * | `paragraphText` | 仅做排版归一的正文（断行拼接、空白折叠、段落重建） |
 * | `medianLineGap` | 段落边界判据的**可核对**参数 |
 * | `hasTextLayer` | 无文本层的页必须被看见，**不做 OCR** |
 *
 * ── 三条硬约束 ──
 *
 * 1. **不做 OCR。** 无文本层的页如实上报，并让候选进入人工复核。
 * 2. **不调用任何远程服务 / AI。** 抽不到就是抽不到。
 * 3. **不改写源件文本。** 不改错字、不改编号、不补标点。
 *    排版归一（拼接断行）是**有意的**，且只发生在 `paragraphText` 一层 ——
 *    `rawText` 永远保留源件原样，因此任何"归一是否改变了用词"都可以被核对。
 */

import { extractPdf } from "@/content/pipeline/extract";
import { joinTextLines } from "@/content/pipeline/text-utils";
import type { ExtractedDocument } from "@/content/pipeline/types";
import type { ExtractedPage, ParsedDocument } from "./types";

/**
 * 段落边界判据：行间距超过**中位间距**的这个倍数即视为新段落。
 *
 * 为什么用中位数而不是绝对阈值：不同源件的行距差异很大
 * （单倍行距约 14pt、1.5 倍约 21pt），绝对阈值必然在某一类源件上失效。
 * 用相对量不需要为每种排版调参。
 *
 * 1.6 是**保守**取值：宁可少切段落（把两段并成一段，正文仍完整），
 * 也不要多切（把一段正文切成两半，段的边界就错了）。
 */
export const PARAGRAPH_GAP_FACTOR = 1.6;

/**
 * 抽取一个文档资产的文本层。
 *
 * `assetKey` 与 `absolutePath` 由调用方提供：本模块**不做路径解析**
 * （那是 `sources.ts` / 既有 `resolveWithinRoot` 的职责），
 * 因此它无法被用来读取源根之外的文件。
 */
export async function extractPdfPages(assetKey: string, absolutePath: string): Promise<ParsedDocument> {
  let doc: ExtractedDocument;
  try {
    doc = await extractPdf(absolutePath);
  } catch (error) {
    // 抽取失败是一个**结果**，不是异常传播点：候选包必须能如实记录
    // "这个文件没能被解析"，否则一次坏文件会让整次抽取没有产物。
    return {
      assetKey,
      state: "failed",
      pages: [],
      tool: null,
      pagesWithoutTextLayer: [],
      warnings: [],
      error: (error as Error).message,
      deferredMarker: null,
    };
  }

  const pages = buildPages(doc);
  const pagesWithoutTextLayer = pages.filter((page) => !page.hasTextLayer).map((page) => page.page);

  const warnings: string[] = [];
  if (pagesWithoutTextLayer.length > 0) {
    warnings.push(
      `有 ${pagesWithoutTextLayer.length} 页没有文本层（第 ${pagesWithoutTextLayer.join("、")} 页）。` +
        `本版本**不做 OCR** —— 这些页的内容不会被推测，依赖它们的段必须人工复核。`,
    );
  }
  if (pages.length === 0) {
    warnings.push("该 PDF 没有可读的页。");
  }

  return {
    assetKey,
    state: pagesWithoutTextLayer.length === pages.length || pages.length === 0 ? "no_text_layer" : "parsed",
    pages,
    tool: doc.tool,
    pagesWithoutTextLayer,
    warnings,
    error: null,
    deferredMarker: null,
  };
}

/**
 * 既有的 `ExtractedDocument.lines` → 逐页结构。
 *
 * 行顺序由既有的 `reconstructPageLines` 决定（页内按 y 降序 = 从上到下），
 * 本模块**不重排** —— 重排会让"这一行在原件的哪个位置"失去意义。
 */
function buildPages(doc: ExtractedDocument): ExtractedPage[] {
  const byPage = new Map<number, { text: string; y: number }[]>();
  for (const line of doc.lines) {
    const list = byPage.get(line.page) ?? [];
    list.push({ text: line.text, y: line.y });
    byPage.set(line.page, list);
  }

  const pages: ExtractedPage[] = [];
  for (let pageNumber = 1; pageNumber <= doc.pages; pageNumber += 1) {
    const entries = byPage.get(pageNumber) ?? [];
    // 保留抽取顺序（已经是阅读顺序），只把空行剔除出"视觉行"清单
    const lines = entries.map((entry) => entry.text).filter((text) => text.trim() !== "");
    const hasTextLayer = lines.length > 0 && !doc.pagesWithoutTextLayer.includes(pageNumber);

    const rawText = lines.join("\n");
    const gaps = consecutiveGaps(entries);

    pages.push({
      page: pageNumber,
      hasTextLayer,
      lines,
      rawText,
      paragraphText: buildParagraphText(lines, entries, gaps),
      medianLineGap: median(gaps),
    });
  }

  return pages;
}

/** 相邻行的垂直间距（绝对值）。只统计两侧都有文本的行。 */
function consecutiveGaps(entries: { y: number }[]): number[] {
  const gaps: number[] = [];
  for (let index = 1; index < entries.length; index += 1) {
    gaps.push(Math.abs(entries[index - 1].y - entries[index].y));
  }
  return gaps.filter((gap) => gap > 0);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle];
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

/**
 * 段落重建（**只做排版归一，不改词**）。
 *
 * 判据只有一条：相邻视觉行的间距超过中位间距的 `PARAGRAPH_GAP_FACTOR` 倍，
 * 或该行是明显的条目起点（题号 / 选项标签 / 答案标记），即开始新段落。
 *
 * 断行拼接用既有的 `joinTextLines`：它按边界字符的语系决定是否补空格
 * （英文断行必须补，中文断行补了反而污染原文）—— 这是已经过实测验证的实现，
 * 不在这里另写一份。
 */
function buildParagraphText(
  lines: string[],
  entries: { text: string; y: number }[],
  gaps: number[],
): string {
  if (lines.length === 0) return "";
  const medianGap = median(gaps);
  const threshold = medianGap === null ? null : medianGap * PARAGRAPH_GAP_FACTOR;

  // 用**非空行**的几何来切段，因此要重建一份与 lines 对齐的 y 序列
  const solid = entries.filter((entry) => entry.text.trim() !== "");
  const paragraphs: string[][] = [];
  let current: string[] = [];

  for (let index = 0; index < solid.length; index += 1) {
    const text = solid[index].text;
    const previous = index > 0 ? solid[index - 1] : null;
    const gap = previous === null ? null : Math.abs(previous.y - solid[index].y);
    const gapBreaks = threshold !== null && gap !== null && gap > threshold;
    const looksLikeItemStart = isItemStart(text);

    if (current.length > 0 && (gapBreaks || looksLikeItemStart)) {
      paragraphs.push(current);
      current = [];
    }
    current.push(text);
  }
  if (current.length > 0) paragraphs.push(current);

  return paragraphs.map((paragraph) => joinTextLines(paragraph)).join("\n\n");
}

/**
 * 这一行是不是一个"条目起点"（题号 / 选项标签 / 答案 / 小标题）。
 *
 * 它只用于**切段落**，不用于判断身份。因此宽松是安全的：
 * 切多了一个段落不影响正文完整性（正文仍逐行保留在 `rawText` 里）。
 *
 * 注意这里用 `(?![a-z0-9])` 而不是 `\b`：`\b` 只认 ASCII 词字符，
 * 对中文**永远不匹配** —— 那会让"答案/参考译文"这类中文分区标记静默失效。
 */
function isItemStart(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return false;
  // 题号起点（`46.` / `46．` / `46)`）
  if (/^\d{1,3}\s*[.．、)）]/.test(trimmed)) return true;
  // 选项标签后必须跟内容（`A) text`），避免把孤立的字母行当条目
  if (/^[A-O]\s*[.)、）]\s*\S/.test(trimmed)) return true;
  // 答案 / 译文 / 文字稿这类分区标记（中英并列，词尾用 ASCII 无关的判据）
  if (/^(答案|参考答案|参考译文|解析|译文|听力原文|文字稿|Transcript|KEY|Answer)(?![a-z0-9])/i.test(trimmed)) {
    return true;
  }
  // 大标题
  if (/^(Questions?\s+\d+|Passage\s+(One|Two|Three|Four))(?![a-z0-9])/i.test(trimmed)) return true;
  return false;
}

/**
 * 挑选**稳定引文候选**。
 *
 * ── 为什么引文要"挑"而不是"取开头 100 字" ──
 *
 * `anchor.quote` 的唯一价值是"当页码不可用时，还能把段与源件对上"。
 * 一段正文的开头常常是"上一段延续下来的半句"或纯空白噪声，
 * 那样的引文在源件里**匹配不到**，锚点就形同虚设。
 *
 * 因此挑选规则是：
 * 1. 取正文里第一条**足够长**（≥ `MIN_QUOTE_LENGTH` 字符）的行；
 * 2. 去掉首尾空白，截到 `MAX_QUOTE_LENGTH` 字符；
 * 3. **回源核对**：它必须真的出现在该页的文本里，否则返回 null 并上报异常。
 *
 * 第 3 条是关键：引文是我们**声称**源件里有的东西，因此必须能被核对。
 * 核对不上就不给引文，而不是给一段看起来像样的假引文。
 */
export const MIN_QUOTE_LENGTH = 12;
export const MAX_QUOTE_LENGTH = 120;

export interface QuoteCandidate {
  quote: string | null;
  /** 引文取自哪一页。 */
  page: number | null;
  /** 找不到合格引文时的原因。 */
  reason: string | null;
}

export function pickStableQuote(pages: ExtractedPage[], fromPage = 1): QuoteCandidate {
  for (const page of pages) {
    if (page.page < fromPage) continue;
    if (!page.hasTextLayer) continue;
    const haystack = normalizeForQuoteCheck(page.rawText);
    for (const line of page.lines) {
      const trimmed = line.trim();
      if (trimmed.length < MIN_QUOTE_LENGTH) continue;
      // 跳过纯数字/纯符号的行（页码、装饰线）
      if (!/[\p{L}\p{N}]/u.test(trimmed)) continue;
      const quote = trimmed.slice(0, MAX_QUOTE_LENGTH);
      const needle = normalizeForQuoteCheck(quote);
      if (needle !== "" && haystack.includes(needle)) {
        return { quote, page: page.page, reason: null };
      }
    }
  }
  return { quote: null, page: null, reason: "在源件文本里找不到长度足够的可核对行" };
}

/**
 * 引文核对的归一（**只用于"是否出现在源件里"这一个判断**）。
 *
 * 归一的是 PDF 抽取的排版伪影：空白差异、软连字符。**不**做大小写折叠 ——
 * 引文要能被人拿去源件里搜，因此应当尽量接近原样。
 */
export function normalizeForQuoteCheck(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/\u00ad/g, "")
    .replace(/[ \t\u3000]+/g, " ")
    .trim();
}

/** 把若干页的正文按页顺序拼起来（用于跨页段落）。 */
export function joinPageText(pages: ExtractedPage[], fromPage: number, toPage: number): string {
  return pages
    .filter((page) => page.page >= fromPage && page.page <= toPage && page.hasTextLayer)
    .map((page) => page.paragraphText)
    .join("\n\n")
    .trim();
}
