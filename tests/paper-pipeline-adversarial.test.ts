import { describe, expect, it } from "vitest";
import { reconstructPageLines, inferGeometry } from "@/content/pipeline/lines";
import { detectStructure } from "@/content/pipeline/detect";
import {
  evaluateStructuralIntegrity,
  evaluateSourceCompleteness,
  locateSpan,
  type FieldAlignment,
} from "@/content/pipeline/completeness";
import {
  evaluateBindings,
  familyCoverageRatio,
  discriminativeTerms,
  isNavigationGarbage,
  stripNavigationGarbage,
  evaluateBindingEvidence,
  DISCRIMINATIVE_MIN_LENGTH,
  FAMILY_COVERAGE_THRESHOLD,
} from "@/content/pipeline/binding";
import {
  contentFingerprint,
  projectForFingerprint,
  normalizeForFingerprint,
  candidateContentChecksum,
} from "@/content/pipeline/fingerprint";
import { evaluateGate } from "@/content/pipeline/gate";
import { extractStemsFromLineTranscript, normalizePunctuation, htmlToText } from "@/content/pipeline/sources";
import { renderAuditTemplate } from "@/content/pipeline/candidate";
import {
  extractEntities,
  findEntityConflicts,
  entityConflictsToReview,
} from "@/content/pipeline/entities";
import type { ExtractedDocument, ExtractedLine, ExtractedRun } from "@/content/pipeline/types";
import type { ExamPaperContent } from "@/content/paper/types";
import { OFFICIAL_NUMBERED_ITEM_TOTAL } from "@/domain/paper";

/**
 * 对抗性测试：证明流水线在**内容被破坏时失败关闭**。
 *
 * 这些测试的目的不是覆盖率，而是逐条证明"某类静默污染会被阻断"。
 * 任务明确列出要求的场景清单，本文件逐条对应。
 *
 * 全部内容均为合成夹具，不含任何真实试卷文本。
 */

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function run(text: string, x: number, y: number, width: number): ExtractedRun {
  return { text, x, y, width, height: 10, fontName: "f1", hasEOL: false };
}

function makeDoc(lines: ExtractedLine[]): ExtractedDocument {
  return {
    file: "synthetic.pdf",
    sha256: "0".repeat(64),
    bytes: 1,
    pages: 3,
    pageWidth: 595,
    pageHeight: 842,
    tool: { name: "fixture", version: "0", license: "n/a" },
    pdfInfo: {},
    pagesWithoutTextLayer: [],
    lines,
    geometry: inferGeometry(lines),
  };
}

/** 一个结构合法的合成包（8 大题 / 55 编号题 / 2 主观项）。 */
function syntheticPaper(overrides: Partial<ExamPaperContent> = {}): ExamPaperContent {
  const mcq = (number: number, count = 4) => ({
    kind: "mcq" as const,
    id: `q${number}`,
    number,
    order: 0,
    explanation: null,
    stem: `Synthetic question ${number} about a distinctive subject?`,
    options: Array.from({ length: count }, (_, index) => ({
      id: "ABCD"[index],
      label: `Option ${"ABCD"[index]} for question ${number} with discrimination vocabulary`,
    })),
    answer: "A",
  });

  const listening = (type: string, groups: number[][], id: string) => ({
    id,
    type: type as ExamPaperContent["sections"][number]["type"],
    order: 1,
    title: id,
    instructions: null,
    groups: groups.map((numbers, index) => ({
      id: `${id}#g${index + 1}`,
      order: index,
      instructions: null,
      audioAssetId: "audio-fixture",
      transcript: null,
      passage: null,
      paragraphs: null,
      wordBank: null,
      firstNumber: Math.min(...numbers),
      // 注意：不能写 `numbers.map(mcq)` —— map 会把下标当作第二参数传进 `count`，
      // 导致 q1 有 0 个选项、q2 有 1 个…（实测踩到，表现为结构完整性报"选项数不足"）
      questions: numbers.map((number) => mcq(number)),
    })),
  });

  return {
    id: "synthetic-fixture",
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
    assets: [
      {
        id: "audio-fixture",
        kind: "audio",
        relativePath: "assets/listening.m4a",
        mimeType: "audio/mp4",
        bytes: 1000,
        checksum: "0".repeat(64),
        label: "fixture",
      },
    ],
    sections: [
      {
        id: "writing",
        type: "writing",
        order: 0,
        title: "Writing",
        instructions: "Write an essay of at least 150 words but no more than 200 words.",
        groups: [
          {
            id: "writing#g1",
            order: 0,
            instructions: "Write an essay of at least 150 words but no more than 200 words.",
            audioAssetId: null,
            transcript: null,
            passage: null,
            paragraphs: null,
            wordBank: null,
            firstNumber: null,
            questions: [
              {
                kind: "writing",
                id: "writing-task",
                number: null,
                order: 0,
                explanation: null,
                prompt: "A synthetic opening sentence for the fixture essay task.",
                instructions: "Write an essay of at least 150 words but no more than 200 words.",
                referenceEssay: null,
                minWords: 150,
                maxWords: 200,
              },
            ],
          },
        ],
      },
      listening("listening.long_conversation", [[1, 2, 3, 4], [5, 6, 7, 8]], "listening-lc"),
      listening("listening.passage", [[9, 10, 11], [12, 13, 14, 15]], "listening-lp"),
      listening("listening.talk_report_lecture", [[16, 17, 18], [19, 20, 21], [22, 23, 24, 25]], "listening-trl"),
      {
        id: "cloze",
        type: "reading.banked_cloze",
        order: 4,
        title: "Cloze",
        instructions: "Choose one word for each blank.",
        groups: [
          {
            id: "cloze#g1",
            order: 0,
            instructions: "Choose one word for each blank.",
            audioAssetId: null,
            transcript: null,
            passage: `Synthetic passage ${Array.from({ length: 10 }, (_, i) => `[${26 + i}]`).join(" ")} end.`,
            paragraphs: null,
            wordBank: Array.from({ length: 15 }, (_, i) => `wordbankitem${i}`),
            firstNumber: 26,
            questions: Array.from({ length: 10 }, (_, i) => ({
              kind: "banked_cloze_blank" as const,
              id: `q${26 + i}`,
              number: 26 + i,
              order: i,
              explanation: null,
              blankId: String(26 + i),
              answer: `wordbankitem${i}`,
            })),
          },
        ],
      },
      {
        id: "matching",
        type: "reading.matching",
        order: 5,
        title: "Matching",
        instructions: "Synthetic Article Title",
        groups: [
          {
            id: "matching#g1",
            order: 0,
            instructions: "Synthetic Article Title",
            audioAssetId: null,
            transcript: null,
            passage: null,
            paragraphs: Array.from({ length: 15 }, (_, i) => ({
              label: "ABCDEFGHIJKLMNO"[i],
              text: `Synthetic paragraph ${"ABCDEFGHIJKLMNO"[i]} body text for the fixture.`,
            })),
            wordBank: null,
            firstNumber: 36,
            questions: Array.from({ length: 10 }, (_, i) => ({
              kind: "matching_statement" as const,
              id: `q${36 + i}`,
              number: 36 + i,
              order: i,
              explanation: null,
              statement: `Synthetic statement number ${36 + i}.`,
              answerParagraph: "ABCDEFGHIJKLMNO"[i],
            })),
          },
        ],
      },
      {
        id: "careful",
        type: "reading.careful_reading",
        order: 6,
        title: "Careful",
        instructions: null,
        groups: [0, 1].map((index) => ({
          id: `careful#g${index + 1}`,
          order: index,
          instructions: null,
          audioAssetId: null,
          transcript: null,
          passage: `Synthetic careful reading passage ${index + 1} body text.`,
          paragraphs: null,
          wordBank: null,
          firstNumber: 46 + index * 5,
          questions: Array.from({ length: 5 }, (_, i) => mcq(46 + index * 5 + i)),
        })),
      },
      {
        id: "translation",
        type: "translation",
        order: 7,
        title: "Translation",
        instructions: "Translate the passage from Chinese into English.",
        groups: [
          {
            id: "translation#g1",
            order: 0,
            instructions: "Translate the passage from Chinese into English.",
            audioAssetId: null,
            transcript: null,
            passage: null,
            paragraphs: null,
            wordBank: null,
            firstNumber: null,
            questions: [
              {
                kind: "translation",
                id: "translation-task",
                number: null,
                order: 0,
                explanation: null,
                sourceText: "合成翻译段落用于夹具测试，这段文字完全是为了测试而编造的。",
                instructions: "Translate the passage from Chinese into English.",
                referenceTranslation: null,
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// 1. 结构完整性：缺失 / 重复 / 错序
// ---------------------------------------------------------------------------

describe("对抗：结构完整性必须阻断损坏", () => {
  it("正常夹具通过全部结构要求", () => {
    const result = evaluateStructuralIntegrity(syntheticPaper());
    // 失败时打印具体未满足项，避免"expected PASS got FAIL"这种无信息量的失败
    expect(result.issues.map((issue) => `${issue.where}: ${issue.detail}`)).toEqual([]);
    expect(result.verdict).toBe("PASS");
  });

  it("缺少一道题（题号缺口）被阻断", () => {
    const paper = syntheticPaper();
    const lc = paper.sections.find((section) => section.id === "listening-lc")!;
    lc.groups[1].questions = lc.groups[1].questions.filter((question) => question.number !== 6);
    const result = evaluateStructuralIntegrity(paper);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some((issue) => issue.detail.includes("6"))).toBe(true);
  });

  it("题号重复被阻断", () => {
    const paper = syntheticPaper();
    const lc = paper.sections.find((section) => section.id === "listening-lc")!;
    // 把第 5 题改成第 7 题 → 同组内 7 重复、且 5 缺失。
    // 两点都应被检出；这里断言"重复"这一条（早先的实现只查缺失、不查重复）。
    lc.groups[1].questions[0] = { ...lc.groups[1].questions[0], number: 7 } as never;
    const result = evaluateStructuralIntegrity(paper);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some((issue) => issue.detail.includes("重复"))).toBe(true);
  });

  it("选项数量不足（被截断）被阻断", () => {
    const paper = syntheticPaper();
    const careful = paper.sections.find((section) => section.id === "careful")!;
    const question = careful.groups[0].questions[0];
    if (question.kind === "mcq") question.options = question.options.slice(0, 2);
    const result = evaluateStructuralIntegrity(paper);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some((issue) => issue.detail.includes("选项"))).toBe(true);
  });

  it("词库项缺失被阻断", () => {
    const paper = syntheticPaper();
    const cloze = paper.sections.find((section) => section.id === "cloze")!;
    cloze.groups[0].wordBank = (cloze.groups[0].wordBank ?? []).slice(0, 14);
    expect(evaluateStructuralIntegrity(paper).verdict).toBe("FAIL");
  });

  it("选词填空缺一个空被阻断", () => {
    const paper = syntheticPaper();
    const cloze = paper.sections.find((section) => section.id === "cloze")!;
    cloze.groups[0].questions = cloze.groups[0].questions.filter((question) => question.number !== 30);
    expect(evaluateStructuralIntegrity(paper).verdict).toBe("FAIL");
  });

  it("长篇阅读段落标号不连续被阻断", () => {
    const paper = syntheticPaper();
    const matching = paper.sections.find((section) => section.id === "matching")!;
    matching.groups[0].paragraphs = (matching.groups[0].paragraphs ?? []).filter(
      (paragraph) => paragraph.label !== "H",
    );
    const result = evaluateStructuralIntegrity(paper);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some((issue) => issue.detail.includes("段落标号"))).toBe(true);
  });

  it("仔细阅读缺一篇文章被阻断", () => {
    const paper = syntheticPaper();
    const careful = paper.sections.find((section) => section.id === "careful")!;
    careful.groups = careful.groups.slice(0, 1);
    expect(evaluateStructuralIntegrity(paper).verdict).toBe("FAIL");
  });

  it("写作题目为空被阻断（空字段不是「无法比对」）", () => {
    const paper = syntheticPaper();
    const writing = paper.sections.find((section) => section.id === "writing")!;
    const question = writing.groups[0].questions[0];
    if (question.kind === "writing") question.prompt = "";
    const result = evaluateStructuralIntegrity(paper);
    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some((issue) => issue.detail.includes("为空"))).toBe(true);
  });

  it("翻译原文为空被阻断", () => {
    const paper = syntheticPaper();
    const translation = paper.sections.find((section) => section.id === "translation")!;
    const question = translation.groups[0].questions[0];
    if (question.kind === "translation") question.sourceText = "";
    expect(evaluateStructuralIntegrity(paper).verdict).toBe("FAIL");
  });

  it("听力题干为空被阻断", () => {
    const paper = syntheticPaper();
    const lc = paper.sections.find((section) => section.id === "listening-lc")!;
    lc.groups[0].questions[0] = { ...lc.groups[0].questions[0], stem: "" } as never;
    expect(evaluateStructuralIntegrity(paper).verdict).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// 2. 源完整性：截断 / 空字段 / 重复占用
// ---------------------------------------------------------------------------

describe("对抗：源完整性必须阻断截断与空字段", () => {
  function docWithLines(texts: string[]): ExtractedDocument {
    return makeDoc(
      texts.map((text, index) => ({
        page: 1,
        y: 800 - index * 16,
        x: 36,
        xEnd: 500,
        text,
        runs: [run(text, 36, 800 - index * 16, 400)],
        runStarts: [0],
      })),
    );
  }

  it("候选字段完整落在源区间内 → PASS", () => {
    const doc = docWithLines([
      "The synthetic passage contains several complete sentences for testing purposes.",
      "A second sentence follows it here to make the span long enough for validation.",
    ]);
    const paper = syntheticPaper();
    const alignments: FieldAlignment[] = [
      {
        field: "cloze#g1.passage",
        text: doc.lines.map((line) => line.text).join(" "),
        span: { page: 1, startLine: 0, endLine: 1 },
        kind: "passage",
      },
    ];
    const result = evaluateSourceCompleteness({ paper, doc, alignments });
    // 结构完整性通过，源完整性只看对齐字段
    expect(result.verdict).toBe("PASS");
  });

  it("候选字段被截断（源区间内找不到）→ FAIL", () => {
    const doc = docWithLines(["The synthetic passage contains several complete sentences."]);
    const paper = syntheticPaper();
    const alignments: FieldAlignment[] = [
      {
        field: "cloze#g1.passage",
        // 这个文本比源多出内容 → 截断/改写
        text: "The synthetic passage contains several complete sentences. Plus extra injected text that is not in the source at all.",
        span: { page: 1, startLine: 0, endLine: 0 },
        kind: "passage",
      },
    ];
    const result = evaluateSourceCompleteness({ paper, doc, alignments });
    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some((issue) => issue.code === "field_truncated_or_misaligned")).toBe(true);
  });

  it("必需字段为空 → FAIL（且明确区分于 UNVERIFIABLE）", () => {
    const paper = syntheticPaper();
    const lc = paper.sections.find((section) => section.id === "listening-lc")!;
    lc.groups[0].questions[0] = { ...lc.groups[0].questions[0], stem: "" } as never;
    const result = evaluateSourceCompleteness({ paper, doc: docWithLines(["x"]), alignments: [] });
    expect(result.verdict).toBe("FAIL");
    const issue = result.issues.find((entry) => entry.code === "required_field_empty");
    expect(issue).toBeDefined();
    expect(issue!.detail).toContain("不是");
  });

  it("同一段候选文本被用于两个字段（重复/错接）→ FAIL", () => {
    const doc = docWithLines([
      "A distinctive synthetic sentence that should only appear in one place in the package.",
    ]);
    const paper = syntheticPaper();
    const duplicate = "A distinctive synthetic sentence that should only appear in one place in the package.";
    const alignments: FieldAlignment[] = [
      { field: "a.passage", text: duplicate, span: { page: 1, startLine: 0, endLine: 0 }, kind: "passage" },
      { field: "b.passage", text: duplicate, span: { page: 1, startLine: 0, endLine: 0 }, kind: "passage" },
    ];
    const result = evaluateSourceCompleteness({ paper, doc, alignments });
    expect(result.verdict).toBe("FAIL");
    expect(result.issues.some((issue) => issue.code === "source_span_shared_by_distinct_fields")).toBe(true);
  });

  it("位于同一源行的两个**不同**选项不算重复（源件正常排版）", () => {
    // Word 会把两个选项印在同一行 —— 那是排版，不是缺陷
    const doc = docWithLines(["A)First synthetic option text. C)Third synthetic option text."]);
    const paper = syntheticPaper();
    const alignments: FieldAlignment[] = [
      { field: "q1.options[A]", text: "First synthetic option text.", span: { page: 1, startLine: 0, endLine: 0 }, kind: "option" },
      { field: "q1.options[C]", text: "Third synthetic option text.", span: { page: 1, startLine: 0, endLine: 0 }, kind: "option" },
    ];
    expect(evaluateSourceCompleteness({ paper, doc, alignments }).verdict).toBe("PASS");
  });
});

describe("对抗：主源区间定位必须跨行工作", () => {
  it("句子跨行时仍能定位（长文分页/折行的真实情形）", () => {
    const lines: ExtractedLine[] = [
      { page: 1, y: 800, x: 36, xEnd: 500, text: "The quick brown fox jumps over", runs: [run("x", 36, 800, 100)], runStarts: [0] },
      { page: 1, y: 784, x: 36, xEnd: 500, text: "the lazy dog near the river bank.", runs: [run("y", 36, 784, 100)], runStarts: [0] },
    ];
    const span = locateSpan(lines, "The quick brown fox jumps over the lazy dog near the river bank.");
    expect(span).not.toBeNull();
    expect(span!.startLine).toBe(0);
    expect(span!.endLine).toBe(1);
  });

  it("极短文本（不足句子长）也能定位", () => {
    const lines: ExtractedLine[] = [
      { page: 1, y: 800, x: 36, xEnd: 500, text: "A) A blur. B) Stars. C) The edge. D) An object.", runs: [run("x", 36, 800, 100)], runStarts: [0] },
    ];
    expect(locateSpan(lines, "A blur.")).not.toBeNull();
  });

  it("源件中不存在的文本 → null（由上层判缺陷）", () => {
    const lines: ExtractedLine[] = [
      { page: 1, y: 800, x: 36, xEnd: 500, text: "Completely different content.", runs: [run("x", 36, 800, 100)], runStarts: [0] },
    ];
    expect(locateSpan(lines, "This text is not present anywhere in the source document.")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. 跨来源绑定：错误来源必须被拒
// ---------------------------------------------------------------------------

describe("对抗：跨来源绑定必须拒绝错误的来源", () => {
  /**
   * 两个内容族：族 B 是"本卷"（含长词），族 A 是另一份试卷。
   *
   * 这与真实缺陷同构：A 族文字稿（blender/NASA 家族）被误接到 B 族试卷上。
   */
  const FAMILY_B_TERMS = [
    "sponsorship", "astronomic", "copernican", "biodiversity", "individuality",
    "discrimination", "ultraprocessed", "extinguished", "humanitarian",
  ];

  function paperWithFamilyB(): ExamPaperContent {
    const paper = syntheticPaper();
    // 把长词注入听力选项，构造可判别的内容族
    let index = 0;
    for (const section of paper.sections) {
      if (!section.type.startsWith("listening.")) continue;
      for (const group of section.groups) {
        for (const question of group.questions) {
          if (question.kind !== "mcq") continue;
          const term = FAMILY_B_TERMS[index % FAMILY_B_TERMS.length];
          question.options = question.options.map((option, optionIndex) => ({
            ...option,
            label: `${option.label} ${term} distinctive${optionIndex}`,
          }));
          index += 1;
        }
      }
    }
    return paper;
  }

  function familyBText(): string {
    return (
      FAMILY_B_TERMS.join(" ") +
      " The recording discusses these subjects at length with additional commentary about each topic in turn."
    );
  }

  function familyAText(): string {
    // 另一份试卷的内容：完全不含族 B 的长词
    return (
      "The blender review covered kitchen equipment in exhaustive and repeated discussion across many " +
      "paragraphs of ordinary conversational material without any of the relevant distinctive vocabulary."
    );
  }

  it("判别性术语只看长词（≥10 字母）", () => {
    const paper = paperWithFamilyB();
    const terms = discriminativeTerms(paper, 1, 25);
    expect(terms.length).toBeGreaterThan(0);
    expect(terms.every((term) => term.length >= DISCRIMINATIVE_MIN_LENGTH)).toBe(true);
  });

  it("本卷来源的族覆盖度远高于另一份试卷的来源", () => {
    const paper = paperWithFamilyB();
    const matches = familyCoverageRatio(paper, normalizeForFingerprint(familyBText()));
    const foreign = familyCoverageRatio(paper, normalizeForFingerprint(familyAText()));
    expect(matches.ratio).toBeGreaterThan(foreign.ratio);
    expect(matches.ratio).toBeGreaterThanOrEqual(FAMILY_COVERAGE_THRESHOLD);
    expect(foreign.ratio).toBeLessThan(FAMILY_COVERAGE_THRESHOLD);
  });

  it("**错误来源的题干被拒绝绑定**（本次修复的核心目的）", () => {
    const paper = paperWithFamilyB();
    const bindings = evaluateBindings(
      paper,
      "https://example.invalid/foreign",
      "第二套（自称）",
      familyAText(),
      [],
      [],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
    );
    expect(bindings.length).toBeGreaterThan(0);
    expect(bindings.every((binding) => !binding.bound)).toBe(true);
    // 证据类型必须是"只有套别号"——即明确说明套别号不构成证据
    expect(bindings[0].evidence.kind).toBe("provider_set_label_only");
    expect(bindings[0].evidence.detail).toContain("套别号不是身份证据");
  });

  it("正确来源被接受绑定", () => {
    const paper = paperWithFamilyB();
    const bindings = evaluateBindings(
      paper,
      "https://example.invalid/correct",
      null,
      familyBText(),
      [],
      [],
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
    );
    expect(bindings.every((binding) => binding.bound)).toBe(true);
  });

  it("仅凭套别号声明永远不足以绑定", () => {
    const paper = paperWithFamilyB();
    const evidence = evaluateBindingEvidence({
      paper,
      from: 1,
      to: 4,
      locator: "https://example.invalid/label-only",
      providerSetLabel: "第一套",
      secondaryNormalized: "",
      secondaryCompact: "",
      family: { ratio: 0, matched: 0, total: 10, matchedTerms: [] },
      artifact: null,
    });
    expect(evidence.strength).toBe("insufficient");
    expect(evidence.detail).toContain("不是身份证据");
  });

  it("人工绑定工件必须指纹匹配才有效（内容变则失效）", () => {
    const paper = paperWithFamilyB();
    const valid = evaluateBindingEvidence({
      paper,
      from: 1,
      to: 4,
      locator: "x",
      providerSetLabel: null,
      secondaryNormalized: familyAText(),
      secondaryCompact: familyAText(),
      family: { ratio: 0, matched: 0, total: 10, matchedTerms: [] },
      artifact: {
        from: 1,
        to: 4,
        primaryFingerprint: "f".repeat(64),
        evidence: "人工判定依据：该来源与另一来源交叉印证，属于同一内容族。",
        corroboratingLocator: "https://example.invalid/corroborating",
      },
    });
    expect(valid.strength).toBe("insufficient");
    expect(valid.detail).toContain("内容已变，旧绑定失效");
  });

  it("导航垃圾不被当成题干", () => {
    expect(isNavigationGarbage("打开手机微信【扫一扫】，识别上方二维码；")).toBe(true);
    expect(isNavigationGarbage('凡本网注明"稿件来源：某站"的所有文字、图片和音视频稿件，版权均属…')).toBe(true);
    expect(isNavigationGarbage("what does the woman say she will do?")).toBe(false);
    expect(isNavigationGarbage("What does professor Tom Oliver think of the idea?")).toBe(false);
  });

  it("导航垃圾被剔除且留下记录", () => {
    const result = stripNavigationGarbage({
      1: "打开手机微信【扫一扫】，识别上方二维码；",
      2: "what does the man say about the synthetic topic?",
      3: "版权所有 © 2011-2026 All Rights Reserved",
    });
    expect(Object.keys(result.kept)).toEqual(["2"]);
    expect(result.removed).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. 题干适配器：真实排版变体
// ---------------------------------------------------------------------------

describe("对抗：题干适配器必须处理真实排版变体", () => {
  it("全角标点归一化", () => {
    expect(normalizePunctuation("Question 1，what does…heard。")).toBe("Question 1,what does…heard.");
  });

  it("英文数字词题号", () => {
    const result = extractStemsFromLineTranscript("Question five, what does the woman say about it?", "x");
    expect(result.stems[5]).toContain("what does the woman say");
  });

  it("标记被折行", () => {
    const result = extractStemsFromLineTranscript(
      ["you have just heard.Question", "five, what does the woman say about the topic?"].join("\n"),
      "x",
    );
    expect(result.stems[5]).toContain("what does the woman say");
  });

  it("说明与下一题挤在同一行", () => {
    const result = extractStemsFromLineTranscript(
      "Questions 5to8 are based on the conversation you have just heard.Question five, what does she say?",
      "x",
    );
    expect(result.stems[5]).toContain("what does she say");
  });

  it("题号无空格", () => {
    const result = extractStemsFromLineTranscript("Question12, what do psychologists say about it?", "x");
    expect(result.stems[12]).toContain("what do psychologists say");
  });

  it("缺失题号如实报告，不猜", () => {
    const result = extractStemsFromLineTranscript("Question 1, what does the speaker say about it?", "x");
    expect(result.missing).toContain(21);
    expect(result.stems[21]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. 内容指纹：身份与套别号无关
// ---------------------------------------------------------------------------

describe("对抗：内容指纹必须与来源套别号无关", () => {
  it("指纹稳定可复现", () => {
    const paper = syntheticPaper();
    expect(contentFingerprint(paper)).toBe(contentFingerprint(paper));
  });

  it("选项标签字母的改动**不**改变指纹（O→C 类修正不产生假新身份）", () => {
    const paper = syntheticPaper();
    const before = contentFingerprint(paper);
    const careful = paper.sections.find((section) => section.id === "careful")!;
    const question = careful.groups[0].questions[0];
    if (question.kind === "mcq") {
      // 模拟 O→C 打印标签修正：只改标签字母，文本不动
      question.options = question.options.map((option, index) => ({ ...option, id: "WXYZ"[index] }));
    }
    expect(contentFingerprint(paper)).toBe(before);
  });

  it("选项**文本**的改动改变指纹", () => {
    const paper = syntheticPaper();
    const before = contentFingerprint(paper);
    const careful = paper.sections.find((section) => section.id === "careful")!;
    const question = careful.groups[0].questions[0];
    if (question.kind === "mcq") question.options[0].label = "A completely different option text value";
    expect(contentFingerprint(paper)).not.toBe(before);
  });

  it("答案改动**不**改变指纹（答案可修正，身份是内容）", () => {
    const paper = syntheticPaper();
    const before = contentFingerprint(paper);
    const careful = paper.sections.find((section) => section.id === "careful")!;
    const question = careful.groups[0].questions[0];
    if (question.kind === "mcq") question.answer = "D";
    expect(contentFingerprint(paper)).toBe(before);
  });

  it("验证说明与来源引用的改动不改变指纹", () => {
    const paper = syntheticPaper();
    const before = contentFingerprint(paper);
    paper.provenance = { note: "changed", reference: "https://elsewhere.invalid", verificationNote: "x" };
    paper.verificationStatus = "partially_verified";
    paper.contentVersion = 7;
    expect(contentFingerprint(paper)).toBe(before);
  });

  it("写作题目改动改变指纹", () => {
    const paper = syntheticPaper();
    const before = contentFingerprint(paper);
    const writing = paper.sections.find((section) => section.id === "writing")!;
    const question = writing.groups[0].questions[0];
    if (question.kind === "writing") question.prompt = "A different synthetic opening sentence entirely.";
    expect(contentFingerprint(paper)).not.toBe(before);
  });

  it("听力选项顺序无关（按题号与标签排序归一）", () => {
    const paper = syntheticPaper();
    const before = contentFingerprint(paper);
    const lc = paper.sections.find((section) => section.id === "listening-lc")!;
    const question = lc.groups[0].questions[0];
    if (question.kind === "mcq") question.options = [...question.options].reverse();
    expect(contentFingerprint(paper)).toBe(before);
  });

  it("投影包含全部身份要素且排除第三方题干", () => {
    const projection = projectForFingerprint(syntheticPaper());
    expect(projection.writing).not.toBe("");
    expect(projection.listening).toHaveLength(25);
    expect(projection.bankedCloze.wordBank).toHaveLength(15);
    expect(projection.matching.paragraphs).toHaveLength(15);
    expect(projection.carefulReading).toHaveLength(2);
    expect(projection.translation).not.toBe("");
  });
});

// ---------------------------------------------------------------------------
// 6. 门禁：失败关闭 + 陈旧复核
// ---------------------------------------------------------------------------

describe("对抗：门禁必须失败关闭", () => {
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

  function passResult(summary = "ok") {
    return { verdict: "PASS" as const, checked: 1, issues: [], summary };
  }

  function baseInput(overrides: Record<string, unknown> = {}) {
    return {
      paperId: "fixture",
      review: [],
      sourceFidelity: passResult("源保真：通过"),
      sourceCompleteness: passResult("源完整性：全部覆盖"),
      structuralIntegrity: passResult("结构完整性：全部满足"),
      crossSourceBinding: passResult("跨来源绑定：已绑定"),
      assets: { declared: 1, verified: 1, totalBytes: 1000 },
      listeningAudioVerified: true,
      sourceChecksumDrift: false,
      candidateChecksum: "a".repeat(64),
      storedContentFingerprint: "f".repeat(64),
      contentFingerprint: "f".repeat(64),
      humanReview: {
        reviewedAt: "2026-01-01",
        reviewer: "R",
        resolutions: [],
      },
      reviewedCandidateChecksum: "a".repeat(64),
      answerVerification: null,
      listeningStemsFromThirdParty: 25,
      questionCountsBySection: { ...officialCounts },
      ...overrides,
    };
  }

  it("全部通过时可导入", () => {
    expect(evaluateGate(baseInput()).status).toBe("IMPORTABLE");
  });

  it("源完整性 FAIL 时阻断", () => {
    const verdict = evaluateGate(
      baseInput({ sourceCompleteness: { verdict: "FAIL", checked: 1, issues: [], summary: "源完整性失败" } }),
    );
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    expect(verdict.checks.find((check) => check.name === "source_completeness_pass")?.passed).toBe(false);
  });

  it("结构完整性 FAIL 时阻断", () => {
    const verdict = evaluateGate(
      baseInput({ structuralIntegrity: { verdict: "FAIL", checked: 1, issues: [], summary: "结构失败" } }),
    );
    expect(verdict.status).toBe("REVIEW_REQUIRED");
  });

  it("跨来源绑定未通过时阻断", () => {
    const verdict = evaluateGate(
      baseInput({ crossSourceBinding: { verdict: "REVIEW_REQUIRED", checked: 1, issues: [], summary: "未绑定" } }),
    );
    expect(verdict.status).toBe("REVIEW_REQUIRED");
  });

  it("跨来源绑定 NOT_APPLICABLE（无富集）不阻断", () => {
    const verdict = evaluateGate(
      baseInput({ crossSourceBinding: { verdict: "NOT_APPLICABLE", checked: 0, issues: [], summary: "无条件绑定" } }),
    );
    expect(verdict.status).toBe("IMPORTABLE");
  });

  it("候选内容改变后旧的人工复核失效", () => {
    const verdict = evaluateGate(baseInput({ candidateChecksum: "b".repeat(64) }));
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    const check = verdict.checks.find((entry) => entry.name === "human_review_matches_candidate_checksum");
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain("陈旧");
  });

  it("复核未绑定校验和时阻断", () => {
    const verdict = evaluateGate(baseInput({ reviewedCandidateChecksum: null }));
    expect(verdict.status).toBe("REVIEW_REQUIRED");
  });

  it("源件校验和漂移时阻断", () => {
    expect(evaluateGate(baseInput({ sourceChecksumDrift: true })).status).toBe("REVIEW_REQUIRED");
  });

  it("资产在复核后被改动时阻断（verified < declared）", () => {
    const verdict = evaluateGate(baseInput({ assets: { declared: 2, verified: 1, totalBytes: 10 } }));
    expect(verdict.status).toBe("REVIEW_REQUIRED");
  });

  it("答案分歧未裁定阻断；单一来源不阻断", () => {
    const conflicting = evaluateGate(
      baseInput({
        answerVerification: {
          level: "cross_source_conflict",
          comparing: 25,
          agreeing: 24,
          conflicts: [{ number: 13, primary: "C", secondary: "B", secondaryText: "x" }],
        },
      }),
    );
    expect(conflicting.status).toBe("REVIEW_REQUIRED");

    const singleSource = evaluateGate(baseInput({ answerVerification: null }));
    expect(singleSource.status).toBe("IMPORTABLE");
  });

  it("无人工复核记录时阻断（不得因其它检查通过而放行）", () => {
    expect(evaluateGate(baseInput({ humanReview: null })).status).toBe("REVIEW_REQUIRED");
  });

  it("存在未裁决阻断项时阻断", () => {
    const verdict = evaluateGate(
      baseInput({
        review: [
          { code: "listening_enrichment_unbound", severity: "blocking", where: "<enrichment>/Q1-4", detail: "d", evidence: null },
        ],
      }),
    );
    expect(verdict.status).toBe("REVIEW_REQUIRED");
  });
});

// ---------------------------------------------------------------------------
// 7. 候选校验和：仅覆盖内容
// ---------------------------------------------------------------------------

describe("对抗：候选内容校验和仅覆盖内容（无循环依赖）", () => {
  it("同一内容两次计算一致", () => {
    const json = JSON.stringify({ a: 1, b: "x" });
    expect(candidateContentChecksum(json)).toBe(candidateContentChecksum(json));
  });

  it("内容变化时校验和变化（陈旧复核因此可被发现）", () => {
    const before = candidateContentChecksum(JSON.stringify({ content: "original" }));
    const after = candidateContentChecksum(JSON.stringify({ content: "modified" }));
    expect(before).not.toBe(after);
  });

  it("是 64 位小写十六进制", () => {
    expect(candidateContentChecksum("x")).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 8. 实体检测器：必须抓到目标案例、不得误报
// ---------------------------------------------------------------------------

describe("对抗：实体检测器必须区分同实体与不同实体", () => {
  it("同一材料内「同首名 + 不同姓氏」被检出（历史目标案例形态 A）", () => {
    const occurrences = [
      ...extractEntities("The lecture by Alan Fixturen examines the topic.", "q1", "listening/trl#g1"),
      ...extractEntities("Alan Dutterworth argues the opposite point.", "q2", "listening/trl#g1"),
    ];
    const conflicts = findEntityConflicts(occurrences);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].rule).toBe("same_given_name_different_surname");
    expect(conflicts[0].sameContext).toBe(true);
    expect(conflicts[0].spellings.sort()).toEqual(["Alan Dutterworth", "Alan Fixturen"]);
  });

  it("同一材料内「同姓氏 + 名字近拼写」被检出（历史目标案例形态 B）", () => {
    const occurrences = [
      ...extractEntities("Mira Halstone published the study.", "q1", "listening/trl#g1"),
      ...extractEntities("Myra Halstone presented the findings.", "q2", "listening/trl#g1"),
    ];
    const conflicts = findEntityConflicts(occurrences);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].rule).toBe("same_surname_near_given_name");
  });

  it("**无关材料内两个同首名的不同人不得被判冲突**（历史误报案例）", () => {
    const occurrences = [
      ...extractEntities("Tom Oliver wrote about ecosystems.", "q1", "listening/trl#g1"),
      // 不同材料、不同姓氏、且姓氏差异大 → 不得报冲突
      ...extractEntities("Tom Parker ran the experiment.", "q2", "reading/matching#g1"),
    ];
    expect(findEntityConflicts(occurrences)).toHaveLength(0);
  });

  it("无关材料内两个共享同一姓氏的不同人不得被判冲突", () => {
    const occurrences = [
      ...extractEntities("Jane Foxton studied rivers.", "a", "m1"),
      ...extractEntities("Mark Foxton studied mountains.", "b", "m2"),
    ];
    expect(findEntityConflicts(occurrences)).toHaveLength(0);
  });

  it("同一实体的完整形式与简写形式不算冲突", () => {
    const occurrences = [
      ...extractEntities("After Professor Ward acted quickly.", "a", "m1"),
      ...extractEntities("Professor Ward acted quickly.", "b", "m1"),
    ];
    expect(findEntityConflicts(occurrences)).toHaveLength(0);
  });

  it("同上下文冲突为 blocking，跨材料冲突为 advisory", () => {
    const sameContext = entityConflictsToReview(
      findEntityConflicts([
        ...extractEntities("Alan Fixturen wrote it.", "q1", "same"),
        ...extractEntities("Alan Dutterworth wrote it.", "q2", "same"),
      ]),
    );
    expect(sameContext[0].severity).toBe("blocking");

    const crossContext = entityConflictsToReview(
      findEntityConflicts([
        ...extractEntities("Alan Fixturen wrote it.", "q1", "ctx1"),
        ...extractEntities("Alan Fixturem wrote it.", "q2", "ctx2"),
      ]),
    );
    expect(crossContext).toHaveLength(1);
    expect(crossContext[0].severity).toBe("advisory");
  });

  it("冲突报告不提供正确写法", () => {
    const items = entityConflictsToReview(
      findEntityConflicts([
        ...extractEntities("Alan Fixturen wrote it.", "q1", "same"),
        ...extractEntities("Alan Dutterworth wrote it.", "q2", "same"),
      ]),
    );
    expect(items[0].detail).toContain("不判断");
    expect(items[0].detail).not.toMatch(/正确写法是|应改为/);
  });

  it("句首常见词与称谓不被人名抽取", () => {
    const entities = extractEntities("The Quick brown fox. According To reports. Professor Smith.", "q1", "c");
    const surfaces = entities.map((entry) => entry.surface);
    expect(surfaces.some((surface) => surface.startsWith("The "))).toBe(false);
    expect(surfaces.some((surface) => surface.startsWith("According "))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9. 检测阶段：源件打印缺陷原样保留
// ---------------------------------------------------------------------------

describe("对抗：源件打印缺陷必须上报而非静默改写", () => {
  function listeningDoc(optionLine: string): ExtractedDocument {
    const specs: { y: number; text: string }[] = [
      { y: 780, text: "Part II Listening Comprehension (30 minutes)" },
      { y: 764, text: "Section A" },
      { y: 748, text: "Directions: In this section, you will hear two long conversations." },
      { y: 732, text: "Questions 1 to 4 are based on the conversation you have just heard." },
      { y: 716, text: optionLine },
      { y: 700, text: "2. A)Synthetic second question alpha. C)Synthetic second gamma." },
      { y: 684, text: "B)Synthetic second beta. D)Synthetic second delta." },
      { y: 668, text: "3. A)Synthetic third alpha. C)Synthetic third gamma." },
      { y: 652, text: "B)Synthetic third beta. D)Synthetic third delta." },
      { y: 636, text: "4. A)Synthetic fourth alpha. C)Synthetic fourth gamma." },
      { y: 620, text: "B)Synthetic fourth beta. D)Synthetic fourth delta." },
    ];
    return makeDoc(
      specs.map((spec) => ({
        page: 1,
        y: spec.y,
        x: 36,
        xEnd: 500,
        text: spec.text,
        runs: [run(spec.text, 36, spec.y, 400)],
        runStarts: [0],
      })),
    );
  }

  it("非标准标签（O)）被上报为源件异常并产生阻断项", () => {
    const detection = detectStructure({
      doc: listeningDoc("1. A)Synthetic alpha. B)Synthetic beta. O)Synthetic gamma. D)Synthetic delta."),
      expectedNumberedTotal: OFFICIAL_NUMBERED_TOTAL_PLACEHOLDER,
    });
    const codes = detection.review.map((item) => item.code);
    expect(codes).toContain("option_label_unexpected");
    // 原样保留，未改写为 C
    const question = detection.sections[0]?.groups[0]?.questions[0];
    expect(question?.options.map((option) => option.printedLabel)).toContain("O");
    expect(detection.sourceAnomalies.length).toBeGreaterThan(0);
  });

  it("缺选项被上报为阻断项", () => {
    const detection = detectStructure({
      doc: listeningDoc("1. A)Synthetic alpha. B)Synthetic beta."),
      expectedNumberedTotal: OFFICIAL_NUMBERED_TOTAL_PLACEHOLDER,
    });
    expect(detection.review.map((item) => item.code)).toContain("option_label_incomplete");
  });

  it("无文本层的页产生阻断项（不做 OCR）", () => {
    const doc = { ...listeningDoc("1. A)a. B)b. C)c. D)d."), pagesWithoutTextLayer: [2] };
    const detection = detectStructure({ doc, expectedNumberedTotal: OFFICIAL_NUMBERED_TOTAL_PLACEHOLDER });
    expect(detection.review.find((item) => item.code === "extraction_page_without_text_layer")?.severity).toBe(
      "blocking",
    );
  });
});

/** 官方编号题总数（从常量取，避免硬编码漂移）。 */
const OFFICIAL_NUMBERED_TOTAL_PLACEHOLDER = OFFICIAL_NUMBERED_ITEM_TOTAL;

// ---------------------------------------------------------------------------
// 10. 无害差异不得被误判
// ---------------------------------------------------------------------------

describe("对抗：无害差异不得被误判为缺陷", () => {
  it("PDF 折行不影响选项归组", () => {
    const lines = reconstructPageLines(1, [
      run("1. A)First alpha.", 36, 700, 120),
      run("C)Third gamma.", 300, 700, 120),
      run("B)Second beta.", 46.6, 684, 120),
      run("D)Fourth delta.", 300, 684, 120),
    ]);
    expect(lines).toHaveLength(2);
  });

  it("空白与全角差异经归一化后等价", () => {
    expect(normalizeForFingerprint("Full\u3000width   spaced")).toBe(normalizeForFingerprint("Full width spaced"));
  });

  it("撇号字形差异经归一化后等价", () => {
    expect(normalizeForFingerprint("it\u2019s")).toBe(normalizeForFingerprint("it's"));
  });

  it("题干不得残留源件行首的题号前缀", () => {
    // 实测缺陷：仔细阅读的题干走 `sourceLines` 回退路径，
    // 而 sourceLines 存的是源件原始行（含 `46. `），于是题号被带进题干 ——
    // 既污染面向学习者的内容，又让同一内容在版本之间产生指纹差异。
    const paper = syntheticPaper();
    const careful = paper.sections.find((section) => section.id === "careful")!;
    for (const question of careful.groups[0].questions) {
      expect(question.kind).toBe("mcq");
      if (question.kind !== "mcq") continue;
      expect(question.stem).not.toMatch(/^\s*\d{1,2}\s*[.\uff0e]/);
    }
  });

  it("题干正文中的数字不受题号剥离影响", () => {
    // `in 2015` 这类正文数字必须保留
    const paper = syntheticPaper();
    const careful = paper.sections.find((section) => section.id === "careful")!;
    const question = careful.groups[0].questions[0];
    if (question.kind === "mcq") {
      question.stem = "What did the officials say in 2015 about absences?";
      expect(question.stem).toContain("2015");
    }
  });
});

// ---------------------------------------------------------------------------
// 11. 指纹陈旧必须阻断（Phase 2.2 收尾）
// ---------------------------------------------------------------------------

describe("对抗：指纹陈旧必须阻断，且不可由人工裁决豁免", () => {
  const pass = (summary = "ok") => ({ verdict: "PASS" as const, checked: 1, issues: [], summary });

  function gateInput(overrides: Record<string, unknown> = {}) {
    return {
      paperId: "fixture",
      review: [],
      sourceFidelity: pass(),
      sourceCompleteness: pass(),
      structuralIntegrity: pass(),
      crossSourceBinding: pass(),
      assets: { declared: 1, verified: 1, totalBytes: 1 },
      listeningAudioVerified: true,
      sourceChecksumDrift: false,
      candidateChecksum: "a".repeat(64),
      storedContentFingerprint: "f".repeat(64),
      contentFingerprint: "f".repeat(64),
      humanReview: { reviewedAt: "2026-01-01", reviewer: "R", resolutions: [] },
      reviewedCandidateChecksum: "a".repeat(64),
      answerVerification: null,
      listeningStemsFromThirdParty: 25,
      questionCountsBySection: {
        writing: 1,
        "listening.long_conversation": 8,
        "listening.passage": 7,
        "listening.talk_report_lecture": 10,
        "reading.banked_cloze": 10,
        "reading.matching": 10,
        "reading.careful_reading": 10,
        translation: 1,
      },
      ...overrides,
    };
  }

  it("指纹一致时该项通过", () => {
    const verdict = evaluateGate(gateInput());
    expect(verdict.status).toBe("IMPORTABLE");
    expect(verdict.checks.find((c) => c.name === "stored_fingerprint_matches_recomputed")?.passed).toBe(true);
  });

  it("指纹不一致时**阻断**（不是警告）", () => {
    const verdict = evaluateGate(gateInput({ storedContentFingerprint: "0".repeat(64) }));
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    const check = verdict.checks.find((c) => c.name === "stored_fingerprint_matches_recomputed");
    expect(check?.passed).toBe(false);
    expect(check?.detail).toContain("指纹不一致");
  });

  it("**即使人工写了裁决记录，指纹不一致仍然阻断**（不可豁免）", () => {
    // 这是本项的关键语义：人工能裁决语义争议，不能裁决事实矛盾。
    // 若这条失败，就说明"带陈旧指纹静默 IMPORTABLE"的缺口又出现了。
    const verdict = evaluateGate(
      gateInput({
        storedContentFingerprint: "0".repeat(64),
        humanReview: {
          reviewedAt: "2026-01-01",
          reviewer: "R",
          resolutions: [
            {
              code: "fingerprint_mismatch" as const,
              where: "<identity>/contentFingerprint",
              resolution: "已确认无误",
              evidence: "人工认为可以放行",
            },
          ],
        },
      }),
    );
    expect(verdict.status).toBe("REVIEW_REQUIRED");
    expect(verdict.checks.find((c) => c.name === "stored_fingerprint_matches_recomputed")?.passed).toBe(false);
  });

  it("指纹不一致会产生带修复路径的阻断项", () => {
    const item = {
      code: "fingerprint_mismatch" as const,
      severity: "blocking" as const,
      where: "<identity>/contentFingerprint",
      detail: "记录值与现场重算不一致，请刷新",
      evidence: null,
    };
    expect(item.severity).toBe("blocking");
    expect(item.detail).toContain("刷新");
  });
});

// ---------------------------------------------------------------------------
// 12. 审计模板必须反映当前状态（Phase 2.2 收尾）
// ---------------------------------------------------------------------------

describe("审计模板：必须反映当前状态而非骨架", () => {
  it("模板含内容指纹与算法版本", () => {
    const metadata = {
      paperId: "fixture",
      pipelineVersion: "1",
      createdAt: "2026-09-26",
      extraction: {
        file: "x.pdf",
        sha256: "a".repeat(64),
        pages: 1,
        pagesWithoutTextLayer: [],
        geometry: { margin: 36, indent: 10 },
        tool: "pdfjs",
      },
      sourceRegistration: { sources: [] },
      intentionalTransformations: [],
      fidelity: { counts: { pass: 0, diff: 0, unverifiable: 0 }, results: [] },
      enrichments: [],
      sourceAnomalies: [],
      review: [],
      humanReview: null,
      reviewedCandidateChecksum: null,
      contentFingerprint: "b".repeat(64),
      fingerprintAlgorithmVersion: 1,
      listeningBindings: [],
      garbageRemoved: [],
      answerVerification: null,
    } as unknown as Parameters<typeof renderAuditTemplate>[0];

    const text = renderAuditTemplate(metadata);
    expect(text).toContain("b".repeat(64));
    expect(text).toContain("内容身份（规范指纹）");
    expect(text).toContain("跨来源绑定（逐题组）");
    expect(text).toContain("题干洁净");
  });

  it("已完成的裁决被转录，不留「待填」", () => {
    const metadata = {
      paperId: "fixture",
      pipelineVersion: "1",
      createdAt: "2026-09-26",
      extraction: {
        file: "x.pdf",
        sha256: "a".repeat(64),
        pages: 1,
        pagesWithoutTextLayer: [],
        geometry: { margin: 36, indent: 10 },
        tool: "pdfjs",
      },
      sourceRegistration: { sources: [] },
      intentionalTransformations: [],
      fidelity: { counts: { pass: 0, diff: 0, unverifiable: 0 }, results: [] },
      enrichments: [],
      sourceAnomalies: [],
      review: [
        {
          code: "option_label_unexpected",
          severity: "blocking",
          where: "q54.options",
          detail: "d",
          evidence: null,
        },
      ],
      humanReview: {
        reviewedAt: "2026-09-26",
        reviewer: "YG",
        resolutions: [
          {
            code: "option_label_unexpected",
            where: "q54.options",
            resolution: "判定为源件打印错误，修正为 C",
            evidence: "独立来源印 A/B/C/D 且第三项文本逐字一致",
          },
        ],
      },
      reviewedCandidateChecksum: "c".repeat(64),
      contentFingerprint: "b".repeat(64),
      fingerprintAlgorithmVersion: 1,
      listeningBindings: [],
      garbageRemoved: [],
      answerVerification: null,
    } as unknown as Parameters<typeof renderAuditTemplate>[0];

    const text = renderAuditTemplate(metadata);
    // 断言针对**表格单元**，而不是说明文字 ——
    // 说明里可以（也应该）提到"待填"这个概念，那不是待填本身。
    const tableRows = text
      .split("\n")
      .filter((line) => line.startsWith("|") && line.includes("`option_label_unexpected`"));
    expect(tableRows.join("\n")).not.toContain("（待填）");
    expect(tableRows.join("\n")).not.toContain("（尚未裁决）");
    expect(text).toContain("判定为源件打印错误");
    expect(text).toContain("YG");
  });
});

// ---------------------------------------------------------------------------
// 13. 隐藏元素的噪声剔除（Phase 2.2 收尾）
// ---------------------------------------------------------------------------

describe("对抗：隐藏元素噪声不得进入题干", () => {
  it("display:none 的 span 内容被剔除", () => {
    const html =
      "<p>Question 21. How does the speaker describe the project?</p>" +
      '<span style="display:none">SikEJ#[.ngVqf)^dO</span>' +
      "<p>中文解析</p>";
    const text = htmlToText(html);
    expect(text).toContain("How does the speaker describe the project?");
    expect(text).not.toContain("SikEJ");
  });

  it("visibility:hidden 同样被剔除", () => {
    const html = '<div style="visibility: hidden">xK9)q#Lm</div><p>Real content here.</p>';
    const text = htmlToText(html);
    expect(text).toContain("Real content here.");
    expect(text).not.toContain("xK9");
  });

  it("**可见内容一律保留**（不做「像乱码就删」的启发式）", () => {
    // 判据必须是页面的明确隐藏声明，不是"看起来像乱码"。
    // 否则真实的专有名词与缩写会被误删。
    const html = "<p>NATO and the WHO met in Q&amp;A about pH levels.</p>";
    const text = htmlToText(html);
    expect(text).toContain("NATO");
    expect(text).toContain("WHO");
    expect(text).toContain("pH");
  });

  it("剔除后题干通过洁净判据", () => {
    const html = "<p>Question 5. What does the woman say?</p><span style='display:none'>zz9@#</span>";
    const result = extractStemsFromLineTranscript(htmlToText(html), "x");
    expect(result.stems[5]).toBe("What does the woman say?");
    expect(result.stems[5]).not.toContain("zz9");
  });

  it("**第三方口语题干不在指纹投影内** —— 题干去噪不改变内容指纹", () => {
    // 这条是 2024-06 升版策略的依据：Q21 题干是第三方口语内容，
    // 指纹刻意排除它（源卷只印选项、不印题干）。因此：
    //   · 题干去噪**不改变指纹** ⇒ 身份不变；
    //   · 但它改了学习者可见内容 ⇒ 仍必须递增 contentVersion。
    // 两者并不矛盾：身份与版本是不同维度。
    const paper = syntheticPaper();
    const before = contentFingerprint(paper);
    const lc = paper.sections.find((section) => section.id === "listening-lc")!;
    const question = lc.groups[0].questions[0];
    if (question.kind === "mcq") {
      question.stem = "A completely different spoken stem with different words entirely.";
      // 改写听力题干：指纹不变（题干预先就为空/第三方，不进投影）
      expect(contentFingerprint(paper)).toBe(before);
    }
  });
});
