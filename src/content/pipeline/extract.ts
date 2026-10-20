/**
 * Stage 2 — 确定性文本抽取（pdfjs-dist 适配器）。
 *
 * 技术选型（实测得出）：
 * - **pdfjs-dist 6.3.289**（Mozilla，Apache-2.0，`legacy/build/pdf.mjs`）。
 *   实测在 Node 24.15.0 下可直接做文本层提取，且给出 run 级几何信息
 *   （transform / width / hasEOL / fontName）—— 这是本流水线全部结构推断的基础。
 * - 不使用 OCR：两套锚点试卷均有完整文本层，实测 9/9 页可提取。
 *   若某页无文本层，如实记录而不是静默跳过。
 * - `@napi-rs/canvas` 是 pdfjs-dist 的 **optional** 依赖，纯文本提取不需要它。
 *
 * 本模块只做 I/O 与格式转换，不做任何结构判断（那是 detect.ts 的职责）。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import type { ExtractedDocument, ExtractedRun } from "./types";
import { inferGeometry, reconstructPageLines, type RawLine } from "./lines";

const PDFJS_ENTRY = "node_modules/pdfjs-dist/legacy/build/pdf.mjs";
const PDFJS_LICENSE = "Apache-2.0";

interface PdfjsTextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

function isTextItem(item: unknown): item is PdfjsTextItem {
  return typeof item === "object" && item !== null && "str" in item && "transform" in item;
}

/** pdfjs 在 Node 下必须在 `legacy/build` 入口加载，否则会走浏览器专有路径。 */
async function loadPdfjs() {
  // Windows 下 import 必须用 file:// URL（实测：直接传 D:\... 会报 ERR_UNSUPPORTED_ESM_URL_SCHEME）
  return import(pathToFileURL(PDFJS_ENTRY).href);
}

export function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 抽取一个 PDF 的文本层。
 *
 * 失败策略：**整体失败**。若抽取过程抛错，不返回"部分结果"——
 * 半份文本进入后续结构推断会产出看起来合理但缺内容的包，那正是要杜绝的。
 */
export async function extractPdf(path: string): Promise<ExtractedDocument> {
  const pdfjs = await loadPdfjs();
  const bytes = readFileSync(path);

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(bytes),
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  }).promise;

  const info = (await doc.getMetadata().catch(() => null)) as { info?: Record<string, unknown> } | null;

  const allLines: RawLine[] = [];
  const pagesWithoutTextLayer: number[] = [];
  let pageWidth = 0;
  let pageHeight = 0;

  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    if (pageNumber === 1) {
      pageWidth = viewport.width;
      pageHeight = viewport.height;
    }

    const content = await page.getTextContent();
    const runs: ExtractedRun[] = [];
    for (const item of content.items as unknown[]) {
      if (!isTextItem(item)) continue;
      runs.push({
        text: item.str,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height,
        fontName: item.fontName,
        hasEOL: item.hasEOL,
      });
    }

    // "提取不到"与"这页没有内容"是两件不同的事：前者必须被如实记录
    if (runs.every((run) => run.text.trim() === "")) {
      pagesWithoutTextLayer.push(pageNumber);
    }

    allLines.push(...reconstructPageLines(pageNumber, runs));
  }

  // 几何推断只在有文本层的页上做
  const bodyLines = allLines.filter((line) => !pagesWithoutTextLayer.includes(line.page));
  const geometry = inferGeometry(bodyLines);

  return {
    file: path,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    bytes: bytes.length,
    pages: doc.numPages,
    pageWidth,
    pageHeight,
    tool: { name: "pdfjs-dist", version: pdfjs.version as string, license: PDFJS_LICENSE },
    pdfInfo: (info?.info ?? {}) as Record<string, unknown>,
    pagesWithoutTextLayer,
    lines: allLines.map((line) => ({
      page: line.page,
      y: line.y,
      x: line.x,
      xEnd: line.xEnd,
      text: line.text,
      runs: line.runs,
      runStarts: line.runStarts,
    })),
    geometry,
  };
}

/** 已装 pdfjs-dist 的版本，用于审计记录（避免手写版本号导致审计失真）。 */
export async function pdfjsVersion(): Promise<string> {
  const pdfjs = await loadPdfjs();
  return pdfjs.version as string;
}
