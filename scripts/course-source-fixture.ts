import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 课程导入流水线的**合成源目录夹具构造器**。
 *
 * ── 三条硬约束（与 paper-fixture / course-fixture 同源）──
 *
 * 1. **内容必须是合成的、且显眼可辨。** 主题是通用说明文与虚构的"夹具课程"，
 *    **不是**任何真实 CET 材料，也**不是**任何真实课程材料（如瑞斯拜 RSVP）。
 *    provider 写死为 `test_fixture_provider`，参数里不提供覆盖它的选项。
 * 2. **不进生产内容路径。** 只在测试临时目录 / E2E 内容根下使用；
 *    `private-content/course-sources/` 与真实 `pnpm course:extract` 都不会遇到它。
 * 3. **不产生任何学习者观测。** 它是软件测试夹具。
 *
 * 放在 `scripts/` 而不是 `tests/`：单元测试与（未来的）E2E 都要用它，
 * 而 Playwright 禁止 spec 之间互相 import。
 *
 * ── 为什么夹具要生成**真的可被 pdfjs 解析**的 PDF ──
 *
 * 课程流水线的核心能力是"从 PDF 文本层抽取并分段"。若夹具只是一个
 * 带 `%PDF` 头的占位字节串，那么 pdfjs 会解析失败或抽出空文本，
 * 整条抽取—分段—匹配链路在测试里**从未被真正走过** ——
 * 那正是"900 个测试没抓到缺陷"的形态。
 *
 * 因此这里手写最小但**结构合法**的 PDF：正确的 xref、Catalog/Pages/Page、
 * 内容流里的 `BT/Tf/Td/Tj/ET`。已在 pdfjs 6.3.289 上实测：能抽出文本
 * （含 `transform[4]/[5]` 几何与 `hasEOL`）。
 */

const FIXTURE_PROVIDER = "test_fixture_provider" as const;

export function sha256Hex(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** PDF 字符串字面量的转义（`\`、`(`、`)` 必须转义）。 */
function escapePdfText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * 构造一个**带真实文本层**的最小多页 PDF。
 *
 * 使用 Helvetica + WinAnsiEncoding（单字节），因此**只支持 Latin-1 文本**。
 * 需要中文时用 `buildCjkPdf`（Identity-H + ToUnicode CMap）。
 *
 * ── 为什么要显式拒绝非 Latin-1 字符（实测踩到的静默缺陷）──
 *
 * PDF 内容流里的字号是单字节的，最终由 `Buffer.from(out, "latin1")` 落盘 ——
 * 每个字符被**静默截断为一个字节**。于是往这个函数里传中文会得到
 * 看似正常、实则乱码的 PDF：实测 `"答案与解析"` 变成 `"TH ã•"`，
 * pdfjs 也忠实地把它抽成 `"TH ã•"`。
 *
 * 那是最坏的一类缺陷：**夹具写错了，测试却全绿** —— 因为它验证的是
 * 一段乱码而不是它以为的中文。因此这里**直接抛错**，让夹具作者立刻改用
 * `buildCjkPdf`，而不是产出无法察觉的乱码。
 */
export function buildTextPdf(pages: string[][]): Buffer {
  for (const [pageIndex, lines] of pages.entries()) {
    for (const [lineIndex, line] of lines.entries()) {
      for (const char of line) {
        if (char.codePointAt(0)! > 0xff) {
          throw new Error(
            `buildTextPdf 只支持 Latin-1 文本，但第 ${pageIndex + 1} 页第 ${lineIndex + 1} 行含有 ` +
              `U+${char.codePointAt(0)!.toString(16).toUpperCase()}（${JSON.stringify(char)}）。` +
              `Latin-1 之外的字符会被静默截断成乱码 —— 请改用 buildCjkPdf（Identity-H + ToUnicode）。`,
          );
        }
      }
    }
  }

  const objects: string[] = [];
  const fontObj = 3;
  let next = 4;
  const specs = pages.map((lines) => {
    const contentObj = next++;
    const pageObj = next++;
    return { contentObj, pageObj, lines };
  });

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${specs.map((s) => `${s.pageObj} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[fontObj] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";

  for (const spec of specs) {
    // 用 TL + T* 逐行推进：pdfjs 会给每一行一个独立的 TextItem，
    // 并且 y 坐标逐行递减（与真实源件的"从上到下"一致）。
    let stream = "BT\n/F1 12 Tf\n16 TL\n72 720 Td\n";
    for (const line of spec.lines) {
      stream += `(${escapePdfText(line)}) Tj\nT*\n`;
    }
    stream += "ET\n";
    objects[spec.contentObj] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;
    objects[spec.pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 ${fontObj} 0 R >> >> /Contents ${spec.contentObj} 0 R >>`;
  }

  return assemblePdf(objects, next);
}

/**
 * 构造一个**能抽出中文**的最小 PDF。
 *
 * 原理：用 Type0 / Identity-H 复合字体，CID 从 1 起顺序分配，
 * 并用 `ToUnicode` CMap 把每个 CID 映回真实码位。pdfjs 读 ToUnicode
 * 就能还原出原文 —— 这也是它做文本抽取的真实机制。
 *
 * 为什么必须有它：翻译类课程段的核心内容是**中文原文**。
 * 若夹具无法产出中文文本层，"翻译段的 text 是中文、referenceTranslation 是英文"
 * 这条语义在测试里就无法被验证。
 *
 * 注意：这里**不嵌入真实字体**（没有 FontFile2）。文本抽取走 ToUnicode，
 * 因而不需要字形轮廓 —— 这正是"抽取不需要字体文件"的一个直接体现。
 */
export function buildCjkPdf(pages: string[][]): Buffer {
  const objects: string[] = [];
  const allText = pages.flat().join("");

  const codeToCid = new Map<number, number>();
  for (const char of allText) {
    const cp = char.codePointAt(0)!;
    if (!codeToCid.has(cp)) codeToCid.set(cp, codeToCid.size + 1);
  }

  let bfchar = "";
  for (const [cp, cid] of codeToCid) {
    bfchar += `<${cid.toString(16).toUpperCase().padStart(4, "0")}> <${cp.toString(16).toUpperCase().padStart(4, "0")}>\n`;
  }
  const cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
${codeToCid.size} beginbfchar
${bfchar}endbfchar
endcmap
CMapName currentdict /CMap defineresource pop
end
end`;

  let next = 6; // 1 catalog, 2 pages, 3 ToUnicode, 4 CIDFont, 5 Type0
  const specs = pages.map((lines) => {
    const contentObj = next++;
    const pageObj = next++;
    return { contentObj, pageObj, lines };
  });

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${specs.map((s) => `${s.pageObj} 0 R`).join(" ")}] /Count ${pages.length} >>`;
  objects[3] = `<< /Length ${Buffer.byteLength(cmap, "latin1")} >>\nstream\n${cmap}\nendstream`;
  objects[4] =
    "<< /Type /Font /Subtype /CIDFontType2 /BaseFont /FixtureCJK /CIDSystemInfo " +
    "<< /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 1000 /W [1 [" +
    Array.from({ length: Math.max(1, codeToCid.size) }, () => 1000).join(" ") +
    "]] >>";
  objects[5] =
    "<< /Type /Font /Subtype /Type0 /BaseFont /FixtureCJK /Encoding /Identity-H " +
    "/DescendantFonts [4 0 R] /ToUnicode 3 0 R >>";

  for (const spec of specs) {
    let stream = "BT\n/F1 12 Tf\n16 TL\n72 720 Td\n";
    for (const line of spec.lines) {
      let hex = "";
      for (const char of line) {
        const cid = codeToCid.get(char.codePointAt(0)!)!;
        hex += cid.toString(16).toUpperCase().padStart(4, "0");
      }
      stream += `<${hex}> Tj\nT*\n`;
    }
    stream += "ET\n";
    objects[spec.contentObj] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;
    objects[spec.pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << /Font << /F1 5 0 R >> >> /Contents ${spec.contentObj} 0 R >>`;
  }

  return assemblePdf(objects, next);
}

/**
 * 构造一个**没有文本层**的 PDF（页面上只有一个填充矩形）。
 *
 * 用途：验证"无文本层的页必须被如实上报、不做 OCR"。
 * pdfjs 对这类页返回 `items: []`（实测），因此它走的是
 * `pagesWithoutTextLayer` 那条路径。
 */
export function buildImageOnlyPdf(pageCount = 1): Buffer {
  const objects: string[] = [];
  let next = 3;
  const specs = Array.from({ length: pageCount }, () => {
    const contentObj = next++;
    const pageObj = next++;
    return { contentObj, pageObj };
  });

  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${specs.map((s) => `${s.pageObj} 0 R`).join(" ")}] /Count ${pageCount} >>`;

  for (const spec of specs) {
    // 只画一个矩形：没有任何文本操作符
    const stream = "0.2 0.2 0.2 rg\n72 400 400 300 re\nf\n";
    objects[spec.contentObj] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;
    objects[spec.pageObj] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Resources << >> /Contents ${spec.contentObj} 0 R >>`;
  }

  return assemblePdf(objects, next);
}

/** 把对象表拼成完整的 PDF 字节（含正确的 xref 与 trailer）。 */
function assemblePdf(objects: string[], next: number): Buffer {
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let i = 1; i < next; i += 1) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${next}\n0000000000 65535 f \n`;
  for (let i = 1; i < next; i += 1) {
    out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${next} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** 最小 DOCX 占位字节（ZIP 魔数开头）。**V1 刻意不解析它。** */
export function buildMinimalDocx(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`docx-fixture:${text}`, "utf8")]);
}

/** 生成一个最小但**合法可播放**的 WAV（0.05 秒 8kHz 单声道静音）。 */
export function buildSilentWav(durationSeconds = 0.05): Buffer {
  const sampleRate = 8000;
  const channels = 1;
  const bitsPerSample = 8;
  const samples = Math.max(1, Math.round(sampleRate * durationSeconds));
  const dataSize = samples * channels * (bitsPerSample / 8);
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  buffer.fill(128, 44);

  return buffer;
}

/** 一个合成源目录：相对路径 → 字节。 */
export type FixtureSourceTree = Map<string, Buffer>;

/** 把源目录夹具写盘，返回源根目录。 */
export function writeSourceTree(root: string, tree: FixtureSourceTree): string {
  for (const [relativePath, bytes] of tree) {
    const target = join(root, ...relativePath.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, bytes);
  }
  return root;
}

// ---------------------------------------------------------------------------
// 合成课程材料语料
// ---------------------------------------------------------------------------

/**
 * **合成阅读篇章**（通用说明文，不是任何真实 CET 材料）。
 *
 * 刻意写成"像学术说明文"：每句 15–30 词、含从句。目的是让
 * 段抽取与相似度计算在**有真实量级文本**的情况下被验证 ——
 * 用一句话的篇章测不出分段与匹配的行为。
 */
export const FIXTURE_PASSAGE_A = [
  "The study of how people allocate attention across competing sources of information has a long history in experimental psychology.",
  "Early researchers assumed that attention operated as a single spotlight that could be directed at one location at a time.",
  "Later work showed that observers can track several independently moving objects simultaneously, which forced a revision of that assumption.",
  "The revised view holds that attentional resources are distributed rather than switched, and that the distribution is limited in capacity.",
  "Under this account, performance declines not because attention moves away, but because the available capacity is divided among more targets.",
  "This distinction matters because the two explanations predict different patterns of error as the number of targets increases.",
  "A divided-capacity account predicts gradual degradation, whereas a switching account predicts discrete lapses at the moment of transfer.",
  "Experiments that manipulated the rate of target motion found evidence for gradual degradation rather than discrete lapses.",
  "The same experiments also found substantial individual differences that the capacity account does not by itself explain.",
  "Whether those differences reflect stable traits or fluctuating state remains a genuinely open question in the literature.",
].join(" ");

/** 合成阅读篇章 B（与 A 不同主题，用于验证"两篇文章是两段"）。 */
export const FIXTURE_PASSAGE_B = [
  "Urban planners have increasingly turned to the concept of the fifteen-minute neighbourhood as an organising principle.",
  "The idea is that most daily needs should be reachable on foot or by bicycle within a quarter of an hour.",
  "Proponents argue that this reduces dependence on private vehicles and improves public health outcomes.",
  "Critics point out that the concept assumes a density that many existing settlements simply do not have.",
  "They also note that the measure ignores the quality of the destinations, counting only their proximity.",
  "A grocery store that is close but poorly stocked does not deliver the benefit the concept promises.",
  "Empirical evaluations have therefore begun to combine proximity measures with measures of destination quality.",
  "These composite measures produce noticeably different rankings of neighbourhoods than proximity alone.",
  "The disagreement is not merely technical, because the two measures imply different policy priorities.",
  "Which measure is appropriate depends on whether the goal is reduced travel or improved access to services.",
].join(" ");

/** 合成听力文字稿（虚构对话，不是任何真实听力内容）。 */
export const FIXTURE_TRANSCRIPT = [
  "Conversation One",
  "W: Excuse me, I am looking for the department that handles student housing enquiries.",
  "M: That would be the office on the second floor, but I should warn you that it closes at four today.",
  "W: That is a problem, because I cannot get there before half past four.",
  "M: In that case you might try the online form, which is processed the next working day.",
  "W: Does the online form cover urgent cases as well, or only routine requests?",
  "M: Urgent cases are handled separately, but you have to telephone the duty officer to flag them.",
  "W: I see. Then I will call the duty officer first and fill in the form afterwards.",
].join("\n");

/** 合成中文翻译原文（虚构文本，不是任何真实考题或课程材料）。 */
export const FIXTURE_TRANSLATION_SOURCE = [
  "随着城市人口的持续增长，公共交通系统的效率成为城市管理者关注的焦点。",
  "许多城市开始重新评估自行车道与步行空间的价值，因为它们不仅缓解了交通压力，也改善了居民的日常体验。",
  "研究表明，当骑行环境足够安全时，短距离出行中选择自行车的人数会显著上升。",
].join("");

/** 合成课程参考译文（**课程材料**，不是唯一正确译法）。 */
export const FIXTURE_TRANSLATION_REFERENCE = [
  "As urban populations continue to grow, the efficiency of public transport systems has become a central concern for city administrators.",
  "Many cities have begun to reassess the value of cycle lanes and pedestrian space, because these not only relieve traffic pressure but also improve residents' daily experience.",
  "Research indicates that when the cycling environment is sufficiently safe, the number of people choosing bicycles for short trips rises markedly.",
].join(" ");

export { FIXTURE_PROVIDER };
