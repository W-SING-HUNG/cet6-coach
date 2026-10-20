import { describe, expect, it } from "vitest";
import { reconstructPageLines, inferGeometry, LINE_Y_TOLERANCE } from "@/content/pipeline/lines";
import { detectStructure } from "@/content/pipeline/detect";
import { compact, judgeAgainstSource, buildFidelityReport, splitSentences } from "@/content/pipeline/fidelity";
import { extractEntities, findEntityConflicts, entityConflictsToReview, editDistance } from "@/content/pipeline/entities";
import { evaluateGate } from "@/content/pipeline/gate";
import { parseSecondaryAnswerTable, verifyAnswers, detectTableInternalDefects } from "@/content/pipeline/answer-verify";
import {
  applyCorrections,
  validateCorrectionsFile,
  answersStillValid,
} from "@/content/pipeline/corrections";
import { validateHumanReviewFile, toHumanReview } from "@/content/pipeline/review-record";
import { extractStemsFromLineTranscript, extractStemsFromStemCards, htmlToText } from "@/content/pipeline/sources";
import { norm, CJK, joinTextLines } from "@/content/pipeline/text-utils";
import type { ExtractedDocument, ExtractedLine, ExtractedRun, StructuralDetection } from "@/content/pipeline/types";
import type { ExamPaperContent } from "@/content/paper/types";

/**
 * 合成夹具：**全部内容都是编造的**，与任何真实试卷无关。
 *
 * 为什么必须这样：真实 CET 试卷文本有版权、且必须留在 private-content 中。
 * 这些测试验证的是**解析器的行为**，与具体题目内容无关，
 * 因此合成一段结构同形的假试卷就足以覆盖。
 * `tests/architecture.test.ts` 会继续守卫"仓库中不存在真实试卷正文"。
 */

// ---------------------------------------------------------------------------
// 夹具构造器
// ---------------------------------------------------------------------------

function run(text: string, x: number, y: number, width: number, fontName = "f1"): ExtractedRun {
  return { text, x, y, width, height: 10, fontName, hasEOL: false };
}

/**
 * 构造一个「视觉行」序列。
 *
 * 关键：同一份夹具同时覆盖两种真实的选项排版 ——
 * 单栏纵排（每行一个选项）与双栏横排（同一行 A/C、下一行 B/D）。
 */
function buildLines(specs: { page: number; y: number; runs: ExtractedRun[] }[]): ExtractedLine[] {
  const lines: ExtractedLine[] = [];
  for (const spec of specs) {
    lines.push(...reconstructPageLines(spec.page, spec.runs));
  }
  return lines;
}

/** 一个最小但结构完整的假试卷（8 大题 / 55 编号题 / 2 主观项）。 */
function syntheticPaperLines(): ExtractedLine[] {
  const specs: { page: number; y: number; runs: ExtractedRun[] }[] = [];
  let y = 780;

  const text = (s: string, x = 36) => run(s, x, y, s.length * 5);

  // Part I Writing
  specs.push({ page: 1, y, runs: [text("Part I Writing (30 minutes)")] });
  y -= 16;
  specs.push({
    page: 1,
    y,
    runs: [text('Directions: For this part, you are allowed 30 minutes to write an essay that begins with the sentence "Sample opening sentence for the synthetic fixture analysis." You can make comments. You should write at least 150 words but no more than 200 words.')],
  });
  y -= 30;

  // Part II Listening — Section A (2 组 × 4 题)
  specs.push({ page: 1, y, runs: [text("Part II Listening Comprehension (30 minutes)")] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("Section A")] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("Directions: In this section, you will hear two long conversations.")] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("Questions 1 to 4 are based on the conversation you have just heard.")] });
  y -= 16;
  // 双栏选项：A/C 一行、B/D 下一行
  specs.push({ page: 1, y, runs: [text("1. A)First alpha option text here. C)Third gamma option text here.")] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("B)Second beta option text here. D)Fourth delta option text here.", 46.6)] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("2. A)Another alpha option. C)Another gamma option.")] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("B)Another beta option. D)Another delta option.", 46.6)] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("3. A)Third question alpha. C)Third question gamma.")] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("B)Third question beta. D)Third question delta.", 46.6)] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("4. A)Fourth question alpha. C)Fourth question gamma.")] });
  y -= 16;
  specs.push({ page: 1, y, runs: [text("B)Fourth question beta. D)Fourth question delta.", 46.6)] });

  specs.push({ page: 1, y, runs: [text("Questions 5 to 8 are based on the conversation you have just heard.")] });
  y -= 16;
  for (let n = 5; n <= 8; n += 1) {
    specs.push({ page: 1, y, runs: [text(`${n}. A)Question${n} alpha. C)Question${n} gamma.`)] });
    y -= 16;
    specs.push({ page: 1, y, runs: [text(`B)Question${n} beta. D)Question${n} delta.`, 46.6)] });
    y -= 16;
  }

  // Section B — 7 题
  specs.push({ page: 2, y: 780, runs: [text("Section B")] });
  y = 764;
  specs.push({ page: 2, y, runs: [text("Directions: In this section, you will hear two passages.")] });
  y -= 16;
  specs.push({ page: 2, y, runs: [text("Questions 9 to 11 are based on the passage you have just heard.")] });
  y -= 16;
  for (let n = 9; n <= 11; n += 1) {
    specs.push({ page: 2, y, runs: [text(`${n}. A)P${n} alpha. C)P${n} gamma.`)] });
    y -= 16;
    specs.push({ page: 2, y, runs: [text(`B)P${n} beta. D)P${n} delta.`, 46.6)] });
    y -= 16;
  }
  specs.push({ page: 2, y, runs: [text("Questions 12 to 15 are based on the passage you have just heard.")] });
  y -= 16;
  for (let n = 12; n <= 15; n += 1) {
    specs.push({ page: 2, y, runs: [text(`${n}. A)P${n} alpha. C)P${n} gamma.`)] });
    y -= 16;
    specs.push({ page: 2, y, runs: [text(`B)P${n} beta. D)P${n} delta.`, 46.6)] });
    y -= 16;
  }

  // Section C — 10 题（3 组）
  specs.push({ page: 3, y: 780, runs: [text("Section C")] });
  y = 764;
  specs.push({ page: 3, y, runs: [text("Directions: In this section, you will hear three recordings.")] });
  y -= 16;
  specs.push({ page: 3, y, runs: [text("Questions 16 to 18 are based on the recording you have just heard.")] });
  y -= 16;
  for (let n = 16; n <= 18; n += 1) {
    specs.push({ page: 3, y, runs: [text(`${n}. A)R${n} alpha. C)R${n} gamma.`)] });
    y -= 16;
    specs.push({ page: 3, y, runs: [text(`B)R${n} beta. D)R${n} delta.`, 51.7)] });
    y -= 16;
  }
  specs.push({ page: 3, y, runs: [text("Questions 19 to 21 are based on the recording you have just heard.")] });
  y -= 16;
  for (let n = 19; n <= 21; n += 1) {
    specs.push({ page: 3, y, runs: [text(`${n}. A)R${n} alpha. C)R${n} gamma.`)] });
    y -= 16;
    specs.push({ page: 3, y, runs: [text(`B)R${n} beta. D)R${n} delta.`, 51.7)] });
    y -= 16;
  }
  specs.push({ page: 3, y, runs: [text("Questions 22 to 25 are based on the recording you have just heard.")] });
  y -= 16;
  for (let n = 22; n <= 25; n += 1) {
    specs.push({ page: 3, y, runs: [text(`${n}. A)R${n} alpha. C)R${n} gamma.`)] });
    y -= 16;
    specs.push({ page: 3, y, runs: [text(`B)R${n} beta. D)R${n} delta.`, 51.7)] });
    y -= 16;
  }

  // Part III Reading — Section A（选词填空，15 词库 / 10 空）
  specs.push({ page: 4, y: 780, runs: [text("Part III Reading Comprehension (40 minutes)")] });
  y = 764;
  specs.push({ page: 4, y, runs: [text("Section A")] });
  y -= 16;
  specs.push({ page: 4, y, runs: [text("Directions: In this section, there is a passage with ten blanks.")] });
  y -= 16;
  const blankSentence = Array.from({ length: 10 }, (_, i) => `word${i} ___${26 + i}___ rest`).join(" of ");
  specs.push({ page: 4, y, runs: [text(`Synthetic cloze passage ${blankSentence} end of passage.`)] });
  y -= 30;
  // 词库：A–H 左栏、I–O 右栏（真实双栏排布）
  const bank = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet", "kilo", "lima", "mike", "november", "oscar"];
  for (let i = 0; i < 8; i += 1) {
    const left = `${"ABCDEFGH"[i]}) ${bank[i]}`;
    const right = i < 7 ? `${"IJKLMNO"[i]}) ${bank[8 + i]}` : "";
    specs.push({ page: 4, y, runs: [text(left, 41.6), run(`${right}`, 300, y, right.length * 5)] });
    y -= 16;
  }

  // Section B — 长篇阅读（15 段 + 10 陈述）
  specs.push({ page: 5, y: 780, runs: [text("Section B")] });
  y = 764;
  specs.push({ page: 5, y, runs: [text("Directions: In this section, you are going to read a passage with ten statements attached to it.")] });
  y -= 16;
  specs.push({ page: 5, y, runs: [run("Synthetic Article Title For Fixture", 180, y, 200)] });
  y -= 16;
  for (let i = 0; i < 15; i += 1) {
    specs.push({ page: 5, y, runs: [text(`${"ABCDEFGHIJKLMNO"[i]}) Paragraph ${i + 1} body text of the synthetic article for the fixture.`)] });
    y -= 16;
  }
  y -= 14;
  for (let n = 36; n <= 45; n += 1) {
    specs.push({ page: 5, y, runs: [text(`${n}.Statement number ${n} of the synthetic matching fixture.`)] });
    y -= 14;
  }

  // Section C — 仔细阅读（2 篇 × 5 题）
  specs.push({ page: 6, y: 780, runs: [text("Section C")] });
  y = 764;
  specs.push({ page: 6, y, runs: [text("Directions: There are 2 passages in this section.")] });
  y -= 16;
  specs.push({ page: 6, y, runs: [text("Passage One")] });
  y -= 16;
  specs.push({ page: 6, y, runs: [text("Questions 46 to 50 are based on the following passage.")] });
  y -= 16;
  specs.push({ page: 6, y, runs: [text("Synthetic careful reading passage one body text for the fixture analysis.")] });
  y -= 30;
  for (let n = 46; n <= 50; n += 1) {
    specs.push({ page: 6, y, runs: [text(`${n}.What is the point of synthetic question ${n}?`)] });
    y -= 14;
    specs.push({ page: 6, y, runs: [text(`A)Alpha answer ${n}. C)Gamma answer ${n}.`)] });
    y -= 14;
    specs.push({ page: 6, y, runs: [text(`B)Beta answer ${n}. D)Delta answer ${n}.`)] });
    y -= 16;
  }
  specs.push({ page: 7, y: 780, runs: [text("Passage Two")] });
  y = 764;
  specs.push({ page: 7, y, runs: [text("Questions 51 to 55 are based on the following passage.")] });
  y -= 16;
  specs.push({ page: 7, y, runs: [text("Synthetic careful reading passage two body text for the fixture analysis.")] });
  y -= 30;
  for (let n = 51; n <= 55; n += 1) {
    specs.push({ page: 7, y, runs: [text(`${n}.What is the point of synthetic question ${n}?`)] });
    y -= 14;
    specs.push({ page: 7, y, runs: [text(`A)Alpha answer ${n}. C)Gamma answer ${n}.`)] });
    y -= 14;
    specs.push({ page: 7, y, runs: [text(`B)Beta answer ${n}. D)Delta answer ${n}.`)] });
    y -= 16;
  }

  // Part IV Translation
  specs.push({ page: 8, y: 780, runs: [text("Part IV Translation (30 minutes)")] });
  y = 764;
  specs.push({ page: 8, y, runs: [text("Directions: For this part, you are allowed 30 minutes to translate a passage from Chinese into English.")] });
  y -= 16;
  specs.push({ page: 8, y, runs: [text("合成翻译段落用于夹具测试，这段文字完全是为了测试而编造的。")] });

  // KEYS 表（页 9）
  y = 700;
  const keys = Array.from({ length: 55 }, (_, i) => (i + 1) % 4);
  const letter = (v: number) => "ABCD"[v];
  for (let block = 0; block < 6; block += 1) {
    const numbers = Array.from({ length: 10 }, (_, i) => block * 10 + i + 1).filter((n) => n <= 55);
    if (numbers.length === 0) break;
    specs.push({ page: 9, y, runs: [run(numbers.join(" "), 57, y, numbers.length * 26)] });
    y -= 16;
    specs.push({ page: 9, y, runs: [run(numbers.map((n) => letter(keys[n - 1])).join(" "), 57, y, numbers.length * 26)] });
    y -= 20;
  }

  return buildLines(specs);
}

function syntheticDoc(): ExtractedDocument {
  const lines = syntheticPaperLines();
  return {
    file: "synthetic-fixture.pdf",
    sha256: "0".repeat(64),
    bytes: 1234,
    pages: 9,
    pageWidth: 595,
    pageHeight: 842,
    tool: { name: "pdfjs-dist", version: "0.0.0-fixture", license: "Apache-2.0" },
    pdfInfo: { Creator: "synthetic fixture" },
    pagesWithoutTextLayer: [],
    lines,
    geometry: inferGeometry(lines),
  };
}

// ---------------------------------------------------------------------------
// Stage 2：行重组
// ---------------------------------------------------------------------------

describe("Stage 2 · 行重组（纯函数）", () => {
  it("同一基线的 run 聚成一行（容差内）", () => {
    const lines = reconstructPageLines(1, [run("Hello", 36, 700, 30), run("world", 70, 700.4, 30)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("Helloworld");
  });

  it("超出容差的 y 分成不同行", () => {
    const lines = reconstructPageLines(1, [run("A", 36, 700, 10), run("B", 36, 700 - LINE_Y_TOLERANCE - 2, 10)]);
    expect(lines).toHaveLength(2);
  });

  it("按阅读顺序输出：先上后下", () => {
    const lines = reconstructPageLines(1, [run("lower", 36, 700, 25), run("upper", 36, 720, 25)]);
    expect(lines[0].text).toBe("upper");
    expect(lines[1].text).toBe("lower");
  });

  it("不丢弃任何 run（空白 run 也保留在 runs 里）", () => {
    const lines = reconstructPageLines(1, [run("A", 36, 700, 10), run("   ", 50, 700, 15), run("B", 70, 700, 10)]);
    expect(lines).toHaveLength(1);
    expect(lines[0].runs).toHaveLength(3);
    // 但文本只由非空白 run 的内容组成时仍是原文；这里 A + 空隙 + B 全保留
    expect(lines[0].text).toContain("A");
    expect(lines[0].text).toContain("B");
  });

  it("文本按 x 顺序拼接，保留词间空格", () => {
    const lines = reconstructPageLines(1, [run("Directions: In", 36, 700, 60), run(" this section.", 96, 700, 60)]);
    expect(lines[0].text).toBe("Directions: In this section.");
  });

  it("几何推断给出正文边界与缩进", () => {
    const lines = reconstructPageLines(1, [
      run("body one", 36, 700, 40),
      run("body two", 36, 684, 40),
      run("body three", 36, 668, 40),
      run("indented a", 46.6, 652, 40),
      run("indented b", 46.6, 636, 40),
      run("indented c", 46.6, 620, 40),
    ]);
    const geometry = inferGeometry(lines);
    expect(geometry.margin).toBe(36);
    expect(geometry.indent).toBe(46.6);
  });

  it("缩进不明确时如实报告，而不是硬挑一个阈值", () => {
    const lines = reconstructPageLines(1, [run("only", 36, 700, 40)]);
    const geometry = inferGeometry(lines);
    expect(geometry.indentAmbiguous).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Stage 3：结构检测
// ---------------------------------------------------------------------------

describe("Stage 3 · 结构检测", () => {
  const detection = detectStructure({ doc: syntheticDoc(), expectedNumberedTotal: 55 });

  it("识别出 8 个大题且类型与官方顺序一致", () => {
    expect(detection.sections.map((section) => section.type)).toEqual([
      "writing",
      "listening.long_conversation",
      "listening.passage",
      "listening.talk_report_lecture",
      "reading.banked_cloze",
      "reading.matching",
      "reading.careful_reading",
      "translation",
    ]);
  });

  it("题量符合官方结构（55 编号题 + 2 主观项 = 57）", () => {
    const total = detection.sections.reduce(
      (sum, section) => sum + section.groups.reduce((acc, group) => acc + group.questions.length, 0),
      0,
    );
    expect(total).toBe(57);
    expect(Object.keys(detection.keys)).toHaveLength(55);
  });

  it("双栏选项全部归入同一题，且按标签排序", () => {
    const lc = detection.sections.find((section) => section.type === "listening.long_conversation");
    const q1 = lc?.groups[0].questions[0];
    expect(q1?.options.map((option) => option.printedLabel)).toEqual(["A", "B", "C", "D"]);
    expect(q1?.options.map((option) => option.text)).toEqual([
      "First alpha option text here.",
      "Second beta option text here.",
      "Third gamma option text here.",
      "Fourth delta option text here.",
    ]);
  });

  it("词库 15 项，含右栏 I–O（双栏排布）", () => {
    const cloze = detection.sections.find((section) => section.type === "reading.banked_cloze");
    expect(cloze?.groups[0].wordBank).toHaveLength(15);
    expect(cloze?.groups[0].wordBank?.[8]).toBe("india");
    expect(cloze?.groups[0].wordBank?.[14]).toBe("oscar");
  });

  it("选词填空空位标记规范化为 [n] 且与 blankId 对应", () => {
    const cloze = detection.sections.find((section) => section.type === "reading.banked_cloze");
    const passage = cloze?.groups[0].passage ?? "";
    for (let n = 26; n <= 35; n += 1) {
      expect(passage).toContain(`[${n}]`);
    }
    expect(cloze?.groups[0].questions.every((question) => question.blankId !== null)).toBe(true);
  });

  it("长篇阅读段落 A–O 齐备", () => {
    const matching = detection.sections.find((section) => section.type === "reading.matching");
    expect(matching?.groups[0].paragraphs).toHaveLength(15);
    expect(matching?.groups[0].paragraphs?.[0].label).toBe("A");
    expect(matching?.groups[0].paragraphs?.[14].label).toBe("O");
  });

  it("仔细阅读两篇文章边界分离", () => {
    const careful = detection.sections.find((section) => section.type === "reading.careful_reading");
    expect(careful?.groups).toHaveLength(2);
    expect(careful?.groups[0].firstNumber).toBe(46);
    expect(careful?.groups[1].firstNumber).toBe(51);
    expect(careful?.groups[0].passage).toContain("passage one");
    expect(careful?.groups[1].passage).toContain("passage two");
  });

  it("写作题目与词数要求被提取", () => {
    expect(detection.writing.prompt).toContain("Sample opening sentence");
    expect(detection.writing.minWords).toBe(150);
    expect(detection.writing.maxWords).toBe(200);
  });

  it("翻译原文（中文段落）被提取", () => {
    expect(detection.translation.sourceText).toContain("合成翻译段落");
    expect(CJK.test(detection.translation.sourceText ?? "")).toBe(true);
  });

  it("KEYS 表解析出 55 个答案", () => {
    expect(Object.keys(detection.keys)).toHaveLength(55);
    expect(detection.keys[1]).toBe("B");
    expect(detection.keys[2]).toBe("C");
  });

  it("没有未解决的阻断项（夹具是结构完整的）", () => {
    const blocking = detection.review.filter((item) => item.severity === "blocking");
    expect(blocking).toEqual([]);
  });
});

describe("Stage 3 · 歧义必须进入 REVIEW_REQUIRED", () => {
  it("缺选项时产生阻断项", () => {
    const lines = buildLines([
      { page: 1, y: 700, runs: [run("Part II Listening Comprehension", 36, 700, 200)] },
      { page: 1, y: 684, runs: [run("Section A", 36, 684, 60)] },
      { page: 1, y: 668, runs: [run("Directions: In this section, you will hear two long conversations.", 36, 668, 400)] },
      { page: 1, y: 652, runs: [run("Questions 1 to 4 are based on the conversation you have just heard.", 36, 652, 400)] },
      // 只有 A、B 两个选项
      { page: 1, y: 636, runs: [run("1. A)Only alpha. B)Only beta.", 36, 636, 300)] },
    ]);
    const doc: ExtractedDocument = {
      ...syntheticDoc(),
      lines,
      geometry: inferGeometry(lines),
    };
    const result = detectStructure({ doc, expectedNumberedTotal: 55 });
    const codes = result.review.filter((item) => item.severity === "blocking").map((item) => item.code);
    expect(codes).toContain("option_label_incomplete");
  });

  it("重复选项标签产生阻断项", () => {
    const lines = buildLines([
      { page: 1, y: 700, runs: [run("Part II Listening Comprehension", 36, 700, 200)] },
      { page: 1, y: 684, runs: [run("Section A", 36, 684, 60)] },
      { page: 1, y: 668, runs: [run("Directions: In this section, you will hear two long conversations.", 36, 668, 400)] },
      { page: 1, y: 652, runs: [run("Questions 1 to 4 are based on the conversation you have just heard.", 36, 652, 400)] },
      { page: 1, y: 636, runs: [run("1. A)alpha. A)alpha again. B)beta. C)gamma.", 36, 636, 400)] },
    ]);
    const doc: ExtractedDocument = { ...syntheticDoc(), lines, geometry: inferGeometry(lines) };
    const result = detectStructure({ doc, expectedNumberedTotal: 55 });
    const codes = result.review.map((item) => item.code);
    expect(codes).toContain("option_label_duplicate");
  });

  it("非标准选项标签被上报为源件异常，且**不**被静默改写", () => {
    const lines = buildLines([
      { page: 1, y: 700, runs: [run("Part II Listening Comprehension", 36, 700, 200)] },
      { page: 1, y: 684, runs: [run("Section A", 36, 684, 60)] },
      { page: 1, y: 668, runs: [run("Directions: In this section, you will hear two long conversations.", 36, 668, 400)] },
      { page: 1, y: 652, runs: [run("Questions 1 to 4 are based on the conversation you have just heard.", 36, 652, 400)] },
      // 第三项印成 O)（真实源件缺陷形态）
      { page: 1, y: 636, runs: [run("1. A)alpha. B)beta. O)gamma. D)delta.", 36, 636, 400)] },
    ]);
    const doc: ExtractedDocument = { ...syntheticDoc(), lines, geometry: inferGeometry(lines) };
    const result = detectStructure({ doc, expectedNumberedTotal: 55 });
    const codes = result.review.map((item) => item.code);
    expect(codes).toContain("option_label_unexpected");

    // 关键：原样保留，未改写为 C
    const listening = result.sections.find((section) => section.type === "listening.long_conversation");
    const labels = listening?.groups[0]?.questions[0]?.options.map((option) => option.printedLabel) ?? [];
    expect(labels).toEqual(["A", "B", "O", "D"]);
    expect(result.sourceAnomalies.some((entry) => entry.includes("O"))).toBe(true);
    // 阻断项必须存在，否则源件缺陷会静默流入包
    expect(result.review.find((item) => item.code === "option_label_unexpected")?.severity).toBe("blocking");
  });

  it("题号缺口产生阻断项", () => {
    const doc = syntheticDoc();
    const trimmed: ExtractedDocument = {
      ...doc,
      lines: doc.lines.filter((line) => !/^9\./.test(norm(line.text)) && !/^B\)P9/.test(norm(line.text))),
    };
    const result = detectStructure({ doc: trimmed, expectedNumberedTotal: 55 });
    expect(result.review.map((item) => item.code)).toContain("question_number_gap");
  });

  it("无文本层的页产生阻断项（本流水线不做 OCR）", () => {
    const doc: ExtractedDocument = { ...syntheticDoc(), pagesWithoutTextLayer: [7] };
    const result = detectStructure({ doc, expectedNumberedTotal: 55 });
    const item = result.review.find((entry) => entry.code === "extraction_page_without_text_layer");
    expect(item?.severity).toBe("blocking");
  });
});

// ---------------------------------------------------------------------------
// Stage 5：源保真
// ---------------------------------------------------------------------------

describe("Stage 5 · 源保真比对", () => {
  const source = "The quick brown fox jumps over the lazy dog. It was strictly controlled by the committee.";

  it("紧凑形式保留撇号（撇号承载用词信息）", () => {
    expect(compact("status's symbol")).toBe("status'ssymbol");
    expect(compact("status symbol")).toBe("statussymbol");
    expect(compact("status's symbol")).not.toBe(compact("status symbol"));
  });

  it("删空白容忍 PDF 提取伪影", () => {
    expect(compact("dece nt")).toBe(compact("decent"));
    expect(compact("he art")).toBe(compact("heart"));
  });

  it("标点与全角半角差异不算语义失败", () => {
    const sourceCompact = compact(source);
    const sentences = new Set(splitSentences(source).map(compact));
    expect(judgeAgainstSource("The quick brown fox jumps over the lazy dog", sourceCompact, sentences).verdict).toBe("PASS");
    expect(judgeAgainstSource("The quick brown fox jumps over the lazy dog.", sourceCompact, sentences).verdict).toBe("PASS");
  });

  it("语义替换被判定为 DIFF", () => {
    const sourceCompact = compact(source);
    const sentences = new Set(splitSentences(source).map(compact));
    // controlled → monitored 正是 2024-12 v1 的真实缺陷形态
    const verdict = judgeAgainstSource("It was strictly monitored by the committee", sourceCompact, sentences);
    expect(verdict.verdict).toBe("DIFF");
  });

  it("缺撇号的差异被抓到（status symbol ≠ status's symbol）", () => {
    const text = "a status's symbol of wealth";
    const sourceCompact = compact(text);
    const sentences = new Set(splitSentences(text).map(compact));
    expect(judgeAgainstSource("a status symbol of wealth", sourceCompact, sentences).verdict).toBe("DIFF");
  });

  it("第三方来源的字段判 UNVERIFIABLE 而不参与比对", () => {
    const report = buildFidelityReport(
      "fixture",
      { file: "x.pdf", sha256: "0".repeat(64) },
      source,
      [
        { field: "a.prompt", text: "The quick brown fox jumps over the lazy dog", origin: "primary" },
        { field: "b.stem", text: "This text is nowhere in the source at all", origin: "third_party" },
      ],
    );
    expect(report.counts.pass).toBe(1);
    expect(report.counts.diff).toBe(0);
    expect(report.counts.unverifiable).toBe(1);
    // 关键：第三方内容即使与主源不符也不记 DIFF —— 它本来就不该在主源里
    expect(report.results.find((result) => result.field === "b.stem")?.verdict).toBe("UNVERIFIABLE");
  });

  it("主源缺失的文本被判 DIFF", () => {
    const report = buildFidelityReport(
      "fixture",
      { file: "x.pdf", sha256: "0".repeat(64) },
      source,
      [{ field: "a.passage", text: "This sentence does not appear in the source material", origin: "primary" }],
    );
    expect(report.counts.diff).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 实体一致性
// ---------------------------------------------------------------------------

describe("实体拼写冲突检测", () => {
  it("编造人名被抽取（判据允许 2–3 个词的连写）", () => {
    // 抽取器允许 2–3 个首字母大写词连写，因此 "Doctor Jane Foxton" 是预期形态。
    // 这是有意的收窄：宁可多带一个称谓，也不要漏掉真实姓名。
    const entities = extractEntities("Doctor Jane Foxton wrote about this.", "q1", "ctx1");
    const surfaces = entities.map((entry) => entry.surface);
    expect(surfaces.some((surface) => surface.includes("Jane Foxton"))).toBe(true);
  });

  it("两词人名也被抽取", () => {
    const entities = extractEntities("The study by Jane Foxton was published.", "q1", "ctx1");
    expect(entities.map((entry) => entry.surface)).toContain("Jane Foxton");
  });

  it("句首常见词不被人名抽取（刻意收窄判据）", () => {
    const entities = extractEntities("The Quick brown fox. According To reports.", "q1", "ctx1");
    expect(entities.some((entry) => entry.surface.startsWith("The "))).toBe(false);
    expect(entities.some((entry) => entry.surface.startsWith("According "))).toBe(false);
  });

  // ── 上下文感知：判据取决于"两个名字是否出现在同一材料里" ──

  it("同一材料内「同首名 + 不同姓氏」被检出（目标案例形态 A）", () => {
    const occurrences = [
      ...extractEntities("Jane Foxton studied this.", "q1", "same-context"),
      ...extractEntities("Jane Foxdon studied this.", "q2", "same-context"),
    ];
    const conflicts = findEntityConflicts(occurrences);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].sameContext).toBe(true);
    expect(conflicts[0].rule).toBe("same_given_name_different_surname");
  });

  it("跨材料的近乎完全相同全名也被检出（但强度为 advisory）", () => {
    const occurrences = [
      ...extractEntities("Jane Foxton studied this.", "q1", "ctx1"),
      ...extractEntities("Jane Foxdon studied this.", "paragraphA", "ctx2"),
    ];
    const conflicts = findEntityConflicts(occurrences);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].sameContext).toBe(false);
    expect(conflicts[0].rule).toBe("near_identical_full_name");
  });

  it("不同实体共享末词**不**被判为冲突", () => {
    const occurrences = [
      ...extractEntities("Peabody Institute Library opened.", "a", "ctx1"),
      ...extractEntities("Richmond Public Library opened.", "b", "ctx2"),
    ];
    expect(findEntityConflicts(occurrences)).toHaveLength(0);
  });

  it("同一实体的完整/截断形式不被判为冲突", () => {
    const occurrences = [
      ...extractEntities("After Professor Ward acted.", "a", "ctx1"),
      ...extractEntities("Professor Ward acted.", "b", "ctx1"),
    ];
    expect(findEntityConflicts(occurrences)).toHaveLength(0);
  });

  it("同一材料内的冲突转成**阻断项**，且不提供正确写法", () => {
    const occurrences = [
      ...extractEntities("Jane Foxton studied this.", "q1", "same-context"),
      ...extractEntities("Jane Foxdon studied this.", "q2", "same-context"),
    ];
    const items = entityConflictsToReview(findEntityConflicts(occurrences));
    expect(items).toHaveLength(1);
    expect(items[0].severity).toBe("blocking");
    expect(items[0].detail).toContain("需外部证据");
    // 不得声称哪个写法正确
    expect(items[0].detail).not.toMatch(/正确写法是|应为/);
  });

  it("编辑距离可用于近似判定", () => {
    // foxton ↔ foxdon：只差一处（x→d 之外还有一处替换），实测距离为 1
    expect(editDistance("foxton", "foxdon")).toBe(1);
    expect(editDistance("abc", "abc")).toBe(0);
    expect(editDistance("", "abc")).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Stage 6：答案验证
// ---------------------------------------------------------------------------

describe("Stage 6 · 答案验证", () => {
  function paperWithAnswers(): ExamPaperContent {
    const questions = Array.from({ length: 5 }, (_, i) => ({
      kind: "mcq" as const,
      id: `q${i + 1}`,
      number: i + 1,
      order: i,
      explanation: null,
      stem: "Synthetic stem",
      options: [
        { id: "A", label: "Alpha" },
        { id: "B", label: "Beta" },
        { id: "C", label: "Gamma" },
        { id: "D", label: "Delta" },
      ],
      answer: "A",
    }));
    return {
      id: "fixture",
      examType: "CET6",
      year: 2024,
      session: "June",
      variant: "set1",
      examDate: null,
      sourceKind: "real_past_paper",
      verificationStatus: "unverified",
      provenance: { note: "fixture", reference: null, verificationNote: null },
      contentVersion: 1,
      partial: false,
      assets: [],
      sections: [
        {
          id: "listening",
          type: "listening.long_conversation",
          order: 0,
          title: "Listening",
          instructions: null,
          groups: [
            {
              id: "g1",
              order: 0,
              instructions: null,
              audioAssetId: "a1",
              transcript: null,
              passage: null,
              paragraphs: null,
              wordBank: null,
              firstNumber: 1,
              questions,
            },
          ],
        },
      ],
    };
  }

  it("解析行式第三方答案表", () => {
    const table = parseSecondaryAnswerTable(
      ["清单：", "1. A Alpha text", "2. B Beta text", "3. C Gamma text"].join("\n"),
      "清单：",
      "https://example.invalid/list",
    );
    expect(table?.answers[1]).toBe("A");
    expect(table?.answers[3]).toBe("C");
    expect(detectTableInternalDefects(table!)).toEqual([]);
  });

  it("同一题号出现两次被记录为表自身缺陷（不静默覆盖）", () => {
    const table = parseSecondaryAnswerTable(
      ["清单：", "13. C Strange text", "13. B Another text"].join("\n"),
      "清单：",
      "https://example.invalid/list",
    );
    expect(table?.duplicateNumbers).toEqual([13]);
    expect(detectTableInternalDefects(table!).join()).toContain("13");
  });

  it("逐题一致时评级为 cross_source_agree", () => {
    const table = parseSecondaryAnswerTable(
      ["清单：", "1. A Alpha", "2. A Alpha", "3. A Alpha", "4. A Alpha", "5. A Alpha"].join("\n"),
      "清单：",
      "x",
    );
    const verification = verifyAnswers(paperWithAnswers(), table!, { from: 1, to: 5 });
    expect(verification.level).toBe("cross_source_agree");
    expect(verification.agreeing).toBe(5);
  });

  it("存在分歧时评级为 cross_source_conflict 并列出分歧", () => {
    const table = parseSecondaryAnswerTable(
      ["清单：", "1. A Alpha", "2. B Beta", "3. A Alpha", "4. A Alpha", "5. A Alpha"].join("\n"),
      "清单：",
      "x",
    );
    const verification = verifyAnswers(paperWithAnswers(), table!, { from: 1, to: 5 });
    expect(verification.level).toBe("cross_source_conflict");
    expect(verification.conflicts).toHaveLength(1);
    expect(verification.conflicts[0].number).toBe(2);
  });

  it("没有第二来源时评级为 single_source（不谎称已验证）", () => {
    const table = parseSecondaryAnswerTable(["清单：", "1. A Alpha"].join("\n"), "清单：", "x");
    const verification = verifyAnswers(paperWithAnswers(), table!, { from: 20, to: 25 });
    expect(verification.level).toBe("single_source");
    expect(verification.comparing).toBe(0);
  });

  it("一致提升的是可信度而非权威性（结论里明确说明）", () => {
    const table = parseSecondaryAnswerTable(["清单：", "1. A Alpha"].join("\n"), "清单：", "x");
    const verification = verifyAnswers(paperWithAnswers(), table!, { from: 1, to: 1 });
    expect(verification.note).toContain("可信度");
    expect(verification.note).toContain("不是官方");
  });
});

// ---------------------------------------------------------------------------
// 修正与人工复核
// ---------------------------------------------------------------------------

describe("复核修正与人工复核记录", () => {
  function minimalPaper(): ExamPaperContent {
    return {
      id: "fixture",
      examType: "CET6",
      year: 2024,
      session: "June",
      variant: "set1",
      examDate: null,
      sourceKind: "real_past_paper",
      verificationStatus: "unverified",
      provenance: { note: "fixture", reference: null, verificationNote: null },
      contentVersion: 1,
      partial: false,
      assets: [],
      sections: [
        {
          id: "reading",
          type: "reading.careful_reading",
          order: 0,
          title: "Reading",
          instructions: null,
          groups: [
            {
              id: "g1",
              order: 0,
              instructions: null,
              audioAssetId: null,
              transcript: null,
              passage: "Synthetic passage body.",
              paragraphs: null,
              wordBank: null,
              firstNumber: 54,
              questions: [
                {
                  kind: "mcq",
                  id: "q54",
                  number: 54,
                  order: 0,
                  explanation: null,
                  stem: "Synthetic stem",
                  options: [
                    { id: "A", label: "Alpha" },
                    { id: "B", label: "Beta" },
                    { id: "O", label: "Gamma" },
                    { id: "D", label: "Delta" },
                  ],
                  answer: "B",
                },
              ],
            },
          ],
        },
      ],
    };
  }

  it("修正文件要求证据、理由与 resolves", () => {
    const invalid = validateCorrectionsFile({
      paperId: "fixture",
      reviewer: "R",
      reviewedAt: "2026-01-01",
      corrections: [{ type: "relabel_option", questionId: "q54", from: "O", to: "C", reason: "x", evidence: "short" }],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join()).toContain("evidence");
  });

  it("合法修正被应用并登记", () => {
    const paper = minimalPaper();
    const file = validateCorrectionsFile({
      paperId: "fixture",
      reviewer: "R",
      reviewedAt: "2026-01-01",
      corrections: [
        {
          type: "relabel_option",
          questionId: "q54",
          from: "O",
          to: "C",
          reason: "源件打印错误",
          evidence: "独立来源印 C，文本逐字一致",
          resolves: { code: "option_label_unexpected", where: "q54.options" },
        },
      ],
    });
    expect(file.ok).toBe(true);
    const outcome = applyCorrections(paper, file.file!);
    expect(outcome.applied).toHaveLength(1);
    expect(outcome.rejected).toEqual([]);
    const question = paper.sections[0].groups[0].questions[0];
    expect(question.kind === "mcq" && question.options.map((option) => option.id)).toEqual(["A", "B", "C", "D"]);
  });

  it("修正重复应用是幂等的", () => {
    const paper = minimalPaper();
    const file = validateCorrectionsFile({
      paperId: "fixture",
      reviewer: "R",
      reviewedAt: "2026-01-01",
      corrections: [
        {
          type: "relabel_option",
          questionId: "q54",
          from: "O",
          to: "C",
          reason: "源件打印错误",
          evidence: "独立来源印 C，文本逐字一致",
          resolves: { code: "option_label_unexpected", where: "q54.options" },
        },
      ],
    });
    const first = applyCorrections(paper, file.file!);
    const second = applyCorrections(paper, file.file!);
    expect(first.applied).toHaveLength(1);
    // 第二次应用必须也成功（不得报告"找不到 O 选项"而失败）
    expect(second.rejected).toEqual([]);
    expect(second.applied).toHaveLength(1);
  });

  it("目标标签被占用时拒绝修正", () => {
    const paper = minimalPaper();
    // 先把 B 改成 C 以便占用 C…… 这里直接构造占用情形：把一个选项设为 C
    const question = paper.sections[0].groups[0].questions[0];
    if (question.kind === "mcq") question.options[1].id = "C";
    const outcome = applyCorrections(paper, {
      paperId: "fixture",
      reviewer: "R",
      reviewedAt: "2026-01-01",
      corrections: [
        {
          type: "relabel_option",
          questionId: "q54",
          from: "O",
          to: "C",
          reason: "源件打印错误",
          evidence: "独立来源印 C，文本逐字一致",
          resolves: { code: "option_label_unexpected", where: "q54.options" },
        },
      ],
    });
    expect(outcome.rejected).toHaveLength(1);
  });

  it("答案分歧的裁定不改写答案，只校验并登记", () => {
    const paper = minimalPaper();
    const outcome = applyCorrections(paper, {
      paperId: "fixture",
      reviewer: "R",
      reviewedAt: "2026-01-01",
      corrections: [
        {
          type: "uphold_primary_answer",
          questionId: "q54",
          primary: "B",
          secondary: "D",
          reason: "裁定保留主源取值",
          evidence: "独立来源解析支持主源取值，且第二来源该表自身串行",
          resolves: { code: "answer_not_in_options", where: "<answers>/q54" },
        },
      ],
    });
    expect(outcome.applied).toHaveLength(1);
    const question = paper.sections[0].groups[0].questions[0];
    expect(question.kind === "mcq" && question.answer).toBe("B");
  });

  it("裁定声明的主源值与包内不符时拒绝", () => {
    const paper = minimalPaper();
    const outcome = applyCorrections(paper, {
      paperId: "fixture",
      reviewer: "R",
      reviewedAt: "2026-01-01",
      corrections: [
        {
          type: "uphold_primary_answer",
          questionId: "q54",
          primary: "D",
          secondary: "B",
          reason: "裁定保留主源取值",
          evidence: "独立来源解析支持主源取值，且第二来源该表自身串行",
          resolves: { code: "answer_not_in_options", where: "<answers>/q54" },
        },
      ],
    });
    expect(outcome.rejected).toHaveLength(1);
  });

  it("修正导致答案指向不存在的选项时能检出", () => {
    const paper = minimalPaper();
    const question = paper.sections[0].groups[0].questions[0];
    if (question.kind === "mcq") {
      question.answer = "O";
      question.options = question.options.filter((option) => option.id !== "O");
    }
    expect(answersStillValid(paper)).toHaveLength(1);
  });

  it("人工复核记录要求核验范围非空", () => {
    const invalid = validateHumanReviewFile({
      paperId: "fixture",
      reviewer: "R",
      reviewedAt: "2026-01-01",
      resolutions: [],
      verifiedScope: [],
      notVerified: [],
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.errors.join()).toContain("verifiedScope");
  });

  it("人工复核记录可转成门禁所需形态", () => {
    const valid = validateHumanReviewFile({
      paperId: "fixture",
      reviewer: "R",
      reviewedAt: "2026-01-01",
      resolutions: [
        {
          code: "option_label_unexpected",
          where: "q54.options",
          resolution: "判定为源件打印错误",
          evidence: "独立来源印 C，文本逐字一致",
        },
      ],
      verifiedScope: ["结构", "源保真"],
      notVerified: ["听力答案仅单一来源"],
      candidateChecksum: "a".repeat(64),
    });
    expect(valid.ok).toBe(true);
    const record = valid.file;
    expect(record).not.toBeNull();
    if (record === null) throw new Error("unreachable");
    expect(toHumanReview(record).reviewer).toBe("R");
    expect(toHumanReview(record).resolutions).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Stage 8：门禁（fail-closed）
// ---------------------------------------------------------------------------

describe("Stage 8 · 门禁必须失败关闭", () => {
  const officialCounts = {
    writing: 1,
    "listening.long_conversation": 8,
    "listening.passage": 7,
    "listening.talk_report_lecture": 10,
    "reading.banked_cloze": 10,
    "reading.matching": 10,
    "reading.careful_reading": 10,
    translation: 1,
  };

  /** 通过态的机器结果（供各用例按需替换为失败态）。 */
  const pass = (summary = "ok") => ({ verdict: "PASS" as const, checked: 1, issues: [], summary });

  /**
   * 门禁输入基线。
   *
   * 注意这里覆盖了**四类独立的机器结果**（源保真 / 源完整性 / 结构完整性 /
   * 跨来源绑定）以及**候选校验和绑定** —— 这正是本阶段修复的核心契约：
   * 它们不可合并，且都必须由调用方现场重算后传入。
   */
  function baseInput(review: StructuralDetection["review"] = []) {
    return {
      paperId: "fixture",
      review,
      sourceFidelity: pass("源保真：通过"),
      sourceCompleteness: pass("源完整性：全部覆盖"),
      structuralIntegrity: pass("结构完整性：全部满足"),
      crossSourceBinding: pass("跨来源绑定：已绑定"),
      questionCountsBySection: { ...officialCounts },
      assets: { declared: 1, verified: 1, totalBytes: 1000 },
      listeningAudioVerified: true,
      listeningStemsFromThirdParty: 25,
      sourceChecksumDrift: false,
      candidateChecksum: "a".repeat(64),
      reviewedCandidateChecksum: "a".repeat(64),
      storedContentFingerprint: "f".repeat(64),
      contentFingerprint: "f".repeat(64),
      humanReview: null as import("@/content/pipeline/types").CandidateMetadata["humanReview"],
      answerVerification: null,
    };
  }

  const humanReview = {
    reviewedAt: "2026-01-01",
    reviewer: "R",
    resolutions: [
      { code: "option_label_unexpected" as const, where: "q54.options", resolution: "r", evidence: "e" },
    ],
  };

  it("候选状态（未人工复核）不可导入", () => {
    const verdict = evaluateGate(baseInput());
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    const check = verdict.checks.find((entry) => entry.name === "human_review_completed");
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain("人工裁决前不可导入");
  });

  it("测试全部通过也不自动批准 —— 人工复核是独立的一项", () => {
    const verdict = evaluateGate({ ...baseInput(), humanReview });
    expect(verdict.status).toBe("IMPORTABLE");
    // 去掉人工复核就立刻不可导入，说明它不是被测试通过"顺带"满足的
    expect(evaluateGate(baseInput()).status).toBe("REVIEW_REQUIRED");
  });

  it("未解决的阻断项阻止导入", () => {
    const review = [
      { code: "word_bank_cardinality" as const, severity: "blocking" as const, where: "w", detail: "d", evidence: null },
    ];
    const verdict = evaluateGate({ ...baseInput(review), humanReview });
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    expect(verdict.checks.find((entry) => entry.name === "no_blocking_review_items")?.passed).toBe(false);
  });

  it("阻断项已有裁决记录时放行（裁决必须有证据）", () => {
    const review = [
      { code: "option_label_unexpected" as const, severity: "blocking" as const, where: "q54.options", detail: "d", evidence: null },
    ];
    const verdict = evaluateGate({ ...baseInput(review), humanReview });
    expect(verdict.checks.find((entry) => entry.name === "all_blocking_items_resolved")?.passed).toBe(true);
  });

  it("源保真存在语义 DIFF 时阻止导入", () => {
    const verdict = evaluateGate({
      ...baseInput(),
      humanReview,
      sourceFidelity: { verdict: "FAIL", checked: 10, issues: [], summary: "源保真：1 处 DIFF" },
    });
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    expect(verdict.checks.find((entry) => entry.name === "source_fidelity_pass")?.passed).toBe(false);
  });

  it("题量不符时阻止导入", () => {
    const bad = evaluateGate({
      ...baseInput(),
      humanReview,
      questionCountsBySection: { ...officialCounts, "reading.matching": 9 },
    });
    expect(bad.status).toBe("REVIEW_REQUIRED");
  });

  it("结构完整性失败时阻止导入（它同时承担编号完整性）", () => {
    const fewerKeys = evaluateGate({
      ...baseInput(),
      humanReview,
      structuralIntegrity: { verdict: "FAIL", checked: 8, issues: [], summary: "结构完整性：1 项未满足" },
    });
    expect(fewerKeys.status).toBe("REVIEW_REQUIRED");
  });

  it("源件校验和漂移时阻止导入", () => {
    const verdict = evaluateGate({ ...baseInput(), humanReview, sourceChecksumDrift: true });
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    expect(verdict.checks.find((entry) => entry.name === "source_checksum_stable")?.passed).toBe(false);
  });

  it("资产未全部校验时阻止导入", () => {
    const verdict = evaluateGate({ ...baseInput(), humanReview, assets: { declared: 2, verified: 1, totalBytes: 10 } });
    expect(verdict.status).toBe("REVIEW_REQUIRED");
  });

  it("听力缺音频时阻止导入", () => {
    const verdict = evaluateGate({ ...baseInput(), humanReview, listeningAudioVerified: false });
    expect(verdict.status).toBe("REVIEW_REQUIRED");
  });

  it("跨来源答案分歧阻止导入（不得自动调和）", () => {
    const verdict = evaluateGate({
      ...baseInput(),
      humanReview,
      answerVerification: {
        level: "cross_source_conflict",
        note: "存在分歧",
        comparing: 25,
        agreeing: 24,
        textAgreeing: 24,
        sources: [],
        evidenceMatrix: [],
        conflicts: [{ number: 13, primary: "C", secondary: "B", secondaryText: "text" }],
      },
    });
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    expect(verdict.checks.find((entry) => entry.name === "answers_evidence_strength_recorded")?.passed).toBe(false);
  });

  it("单一来源**不**阻止导入（它是合法的诚实状态）", () => {
    const verdict = evaluateGate({ ...baseInput(), humanReview, answerVerification: null });
    expect(verdict.status).toBe("IMPORTABLE");
    const check = verdict.checks.find((entry) => entry.name === "answers_evidence_strength_recorded");
    expect(check?.passed).toBe(true);
    expect(check?.detail).toContain("单一来源");
  });

  it("候选内容变化后旧复核失效（陈旧检测）", () => {
    const verdict = evaluateGate({
      ...baseInput(),
      humanReview,
      candidateChecksum: "b".repeat(64),
    });
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    const check = verdict.checks.find((entry) => entry.name === "human_review_matches_candidate_checksum");
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain("陈旧");
  });

  it("复核未绑定校验和时阻止导入", () => {
    const verdict = evaluateGate({ ...baseInput(), humanReview, reviewedCandidateChecksum: null });
    expect(verdict.status).toBe("REVIEW_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// Stage 7：第三方来源适配器
// ---------------------------------------------------------------------------

describe("Stage 7 · 第三方来源适配器", () => {
  it("行式文字稿：题干与题号同行", () => {
    const text = ["Questions 1 to 4 are based on the conversation you have just heard.", "Question 1, what does the speaker say about the fixture?", "Question 2, what is the second synthetic question here?"].join("\n");
    const result = extractStemsFromLineTranscript(text, "x");
    expect(result.stems[1]).toContain("fixture");
    expect(result.stems[2]).toContain("second synthetic");
  });

  it("行式文字稿：题号在续行行首（真实形态）", () => {
    const text = ["Questions 22 to 25 are based on the recording. You have just heard question", "22. What does the synthetic study claim about fixtures?", "Question 23. What is the second synthetic question about?"].join("\n");
    const result = extractStemsFromLineTranscript(text, "x");
    expect(result.stems[22]).toContain("synthetic study");
    expect(result.stems[23]).toContain("second synthetic");
  });

  it("行式文字稿：缺失题号被如实报告", () => {
    const text = ["Question 1, what does the speaker say about the fixture?"].join("\n");
    const result = extractStemsFromLineTranscript(text, "x");
    expect(result.missing).toContain(2);
    expect(result.missing).toContain(25);
  });

  it("题目卡片式：题干取自 题干： 字段，并剥掉中文解析", () => {
    const text = ["Q.16", "A.", "Alpha", "B.", "Beta", "解析", "这是中文解析。", "题干：What does the speaker say about fixtures? 说话者说了什么？原文提到…"].join("\n");
    const result = extractStemsFromStemCards(text, "x");
    expect(result.stems[16]).toBe("What does the speaker say about fixtures?");
  });

  it("HTML 转文本保留结构并解码实体", () => {
    const html = "<p>A &amp; B</p><br><div>C&nbsp;D</div><script>bad()</script>";
    const text = htmlToText(html);
    expect(text).toContain("A & B");
    expect(text).toContain("C D");
    expect(text).not.toContain("bad()");
  });
});

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

describe("文本拼接的语系规则", () => {
  it("英文断行补空格", () => {
    expect(joinTextLines(["give classical", "music a try"])).toBe("give classical music a try");
  });

  it("中文断行不补空格（补了会污染原文）", () => {
    expect(joinTextLines(["如今的中", "式婚礼习俗"])).toBe("如今的中式婚礼习俗");
  });

  it("空白归一化", () => {
    expect(norm("  a    b  ")).toBe("a b");
  });
});
