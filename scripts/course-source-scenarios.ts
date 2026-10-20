/**
 * 课程源目录的**具体夹具场景**（覆盖任务要求的那几类材料）。
 *
 * 每个场景返回一棵"相对路径 → 字节"的树，可直接写进临时目录交给
 * `pnpm course:extract` 或 `runCourseIntake`。
 *
 * ── 目录结构刻意用中文文件夹标签 ──
 *
 * 真实课程目录就是 `阅读/` `听力/` `翻译/` `写作/` 这种形态。
 * 夹具照抄它，才能验证"文件夹标签只作为**候选模块提示**、
 * 绝不作为身份证据"这条规则在真实形态下成立。
 *
 * ── 全部内容都是合成的 ──
 *
 * 主题是通用说明文与虚构对话，**不是**任何真实 CET 材料，
 * 也**不是**任何真实课程材料。它不可能冒充真题或 RSVP 内容。
 */

import {
  FIXTURE_PASSAGE_A,
  FIXTURE_PASSAGE_B,
  FIXTURE_TRANSCRIPT,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
  buildCjkPdf,
  buildImageOnlyPdf,
  buildMinimalDocx,
  buildSilentWav,
  buildTextPdf,
  type FixtureSourceTree,
} from "./course-source-fixture";

/**
 * 场景 1：阅读讲义（**一份讲义内含**篇章 + 题目 + 答案/解析页）。
 *
 * 刻意把三者放在**同一个 PDF** 里：这正是任务描述的"reading handout:
 * passage + questions + answer/explanation pages"形态，也能验证
 * "课程答案区块必须从正文里分开、且不得成为判分真相"。
 *
 * 答案页用英文标记（`Answer Keys`）—— Latin-1 PDF 不能承载中文，
 * 而中文标记的识别由 `tests/course-intake.test.ts` 里的 CJK 用例单独覆盖
 * （那正是 `\b` 对 CJK 失效这个缺陷的守护点）。
 */
export function readingFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();

  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      // 第 1 页：篇章一
      [
        "Reading Handout",
        "Passage One",
        "Questions 46 to 50 are based on the following passage.",
        ...wrap(FIXTURE_PASSAGE_A),
      ],
      // 第 2 页：篇章一的题目
      [
        "Passage One Questions",
        "46. What did early researchers assume about attention?",
        "A) That it operates as a single moveable spotlight.",
        "B) That it can be divided among several targets at once.",
        "C) That it is entirely independent of the task.",
        "D) That it is unaffected by practice.",
        "47. What forced a revision of the early assumption?",
        "A) A change in the definition of attention.",
        "B) Evidence that several objects can be tracked at once.",
      ],
      // 第 3 页：答案与解析（课程主张，**不是**判分真相）
      [
        "Answer Keys",
        "46. A",
        "Explanation: the first paragraph states that early researchers assumed a single spotlight.",
        "47. B",
        "48. C",
        "49. D",
        "50. A",
      ],
      // 第 4 页：篇章二
      ["Passage Two", "Questions 51 to 55 are based on the following passage.", ...wrap(FIXTURE_PASSAGE_B)],
    ]),
  );

  return tree;
}

/** 场景 2：听力（题干讲义 + 文字稿/解析 PDF + 整段 MP3 占位）。 */
export function listeningFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();

  // 题干讲义：只有题目与选项
  tree.set(
    "听力/question-handout.pdf",
    buildTextPdf([
      [
        "Listening Comprehension",
        "Section A",
        "Questions 1 to 4 are based on the conversation you have just heard.",
        "1. A) She needs help with housing. B) She is looking for a lecture hall.",
        "2. A) It closes at four. B) It opens at four.",
        "3. A) Fill in an online form. B) Call the duty officer.",
        "4. A) Routine requests. B) Urgent cases.",
      ],
    ]),
  );

  // 文字稿/解析 PDF：Transcript 分区标记
  //
  // 内容刻意用英文：Latin-1 PDF 不能承载中文（见 buildTextPdf 的说明）。
  // `Transcript` 这个英文分区标记本身就是被识别的判据之一。
  tree.set(
    "听力/transcript-analysis.pdf",
    buildTextPdf([["Transcript and Analysis", "Transcript", ...FIXTURE_TRANSCRIPT.split("\n")]]),
  );

  // 整段音频：**不切分、不重编码**。夹具用真 WAV 字节（校验和路径才会真的被走到）。
  tree.set("听力/listening-full.wav", buildSilentWav(0.1));

  return tree;
}

/** 场景 3：翻译（中文原文 + 课程参考译文）。 */
export function translationFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  tree.set(
    "翻译/translation-unit1.pdf",
    buildCjkPdf([
      ["翻译练习", ...wrapCjk(FIXTURE_TRANSLATION_SOURCE)],
      ["参考译文", ...wrapCjk(FIXTURE_TRANSLATION_REFERENCE)],
    ]),
  );
  return tree;
}

/** 场景 4：写作（模板 / 方法材料）。 */
export function writingFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  tree.set(
    "写作/writing-template.pdf",
    buildTextPdf([
      [
        "Writing Template",
        "Introduction: state the topic and your position in one sentence.",
        "Body paragraph one: give the strongest reason with an example.",
        "Body paragraph two: address the most obvious objection.",
        "Conclusion: restate the position without introducing new material.",
        "Note: this template is course material. It does not correspond to any single exam question.",
      ],
    ]),
  );
  return tree;
}

/** 场景 5：同一份逻辑讲义的 PDF + DOCX 两种表示（**等价性是提案，不是事实**）。 */
export function pdfPlusDocxFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  const body = ["Shared Handout", "Passage One", ...wrap(FIXTURE_PASSAGE_A)];
  tree.set("阅读/shared-handout.pdf", buildTextPdf([body]));
  // DOCX 在 V1 **不被解析** —— 它只是一个已登记的表示。
  tree.set("阅读/shared-handout.docx", buildMinimalDocx("shared handout"));
  return tree;
}

/** 覆盖全部五类的合成源目录（端到端证明用）。 */
export function fullCourseFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  for (const part of [
    readingFixture(),
    listeningFixture(),
    translationFixture(),
    writingFixture(),
    pdfPlusDocxFixture(),
  ]) {
    for (const [key, value] of part) tree.set(key, value);
  }
  return tree;
}

// ---------------------------------------------------------------------------
// 人工分段计划专用夹具
// ---------------------------------------------------------------------------

/**
 * **多练习翻译材料**（合成）—— 人工分段计划的主要用例形态。
 *
 * ── 为什么必须单独造一个夹具，而不是复用 `translationFixture` ──
 *
 * `translationFixture` 是"一份材料、一个练习、一段原文 + 一段参考译文"，
 * 它是自动分段**能**处理好的形态。而人工分段计划存在的理由是
 * **自动分段不够用**：多份练习混在一份 PDF 里，且没有可靠的结构标记
 * （没有 `练习一` / `Passage One` 这类能命中的重复边界）。
 *
 * ── 页布局刻意做成一页一义（让测试无需靠文本匹配定位边界）──
 *
 * | 页 | 第 1 行 | 其余行 |
 * | --- | --- | --- |
 * | 1 | 页眉（6 页逐字相同） | 练习 1 中文原文 |
 * | 2 | 页眉 | 练习 1 参考译文 |
 * | 3 | 页眉 | 练习 1 讲解 / 语言点 |
 * | 4 | 页眉 | 练习 2 中文原文 |
 * | 5 | 页眉 | 练习 2 参考译文 **（无讲解）** |
 * | 6 | 页眉 | 练习 3 中文原文 **（无参考译文）** |
 *
 * 因此每个单元的通道边界都落在**页**这一级，测试可以只用
 * "页码 + 页内行号"表达计划，不必做任何自由文本匹配。
 *
 * 「单元 1 跨 3 页」覆盖了"多个单元跨多页"这条要求；
 * 第 5 页覆盖"单元可以没有 notes"；第 6 页覆盖**任务书明确要求**的
 * "不要强迫每个单元都有参考译文"。
 *
 * 页眉恒等 ⇒ 工具的**任何**自动判据都**不得**自行把它判成家具；
 * 它必须由人在计划里显式标成 `ignored_furniture`，否则覆盖率守卫会阻断。
 */
export function multiUnitTranslationFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  tree.set(
    "翻译/multi-unit-handout.pdf",
    buildCjkPdf([
      [MULTI_UNIT_HEADER, ...wrapCjk(MULTI_UNIT_SOURCE_1)],
      [MULTI_UNIT_HEADER, ...wrap(MULTI_UNIT_REFERENCE_1)],
      [MULTI_UNIT_HEADER, ...wrapCjk(MULTI_UNIT_NOTES_1)],
      [MULTI_UNIT_HEADER, ...wrapCjk(MULTI_UNIT_SOURCE_2)],
      [MULTI_UNIT_HEADER, ...wrap(MULTI_UNIT_REFERENCE_2)],
      [MULTI_UNIT_HEADER, ...wrapCjk(MULTI_UNIT_SOURCE_3)],
    ]),
  );
  return tree;
}

/** 页眉（每页逐字相同，模拟真实重复页眉）。 */
export const MULTI_UNIT_HEADER = "CET6 Translation Practice Handout";

/**
 * **两个单元、四页**的最小翻译材料（合成）。
 *
 * 布局干净到"每个单元恰好占两页"，因此"两个单元 ⇒ 两个段"这类断言
 * 不需要在页里再切行 —— 边界完全落在页这一级：
 *
 * | 页 | 内容 |
 * | --- | --- |
 * | 1 | 页眉 + 练习 1 中文原文 |
 * | 2 | 页眉 + 练习 1 参考译文 |
 * | 3 | 页眉 + 练习 2 中文原文 |
 * | 4 | 页眉 + 练习 2 参考译文 |
 */
export function twoUnitTranslationFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  tree.set(
    "翻译/two-unit-handout.pdf",
    buildCjkPdf([
      [MULTI_UNIT_HEADER, ...wrapCjk(MULTI_UNIT_SOURCE_1)],
      [MULTI_UNIT_HEADER, ...wrap(MULTI_UNIT_REFERENCE_1)],
      [MULTI_UNIT_HEADER, ...wrapCjk(MULTI_UNIT_SOURCE_2)],
      [MULTI_UNIT_HEADER, ...wrap(MULTI_UNIT_REFERENCE_2)],
    ]),
  );
  return tree;
}

/** 合成翻译练习 1 的中文原文（虚构文本）。 */
export const MULTI_UNIT_SOURCE_1 = [
  "城市轨道交通的运营方近年来开始重视乘客在站内的步行体验。",
  "许多车站通过调整指示牌的位置与措辞，缩短了乘客寻找换乘通道的时间。",
].join("");

/** 合成翻译练习 1 的参考译文（**课程材料**）。 */
export const MULTI_UNIT_REFERENCE_1 = [
  "Operators of urban rail transit have begun to pay attention to the walking experience of passengers inside stations.",
  "Many stations have shortened the time passengers spend looking for transfer corridors by adjusting the position and wording of signs.",
].join(" ");

/** 合成翻译练习 1 的讲解（虚构语言点）。 */
export const MULTI_UNIT_NOTES_1 = [
  "语言点：运营方 operators；换乘通道 transfer corridors。",
  "注意「缩短了……时间」常用 shorten the time somebody spends doing。",
].join("");

/** 合成翻译练习 2 的中文原文（虚构文本）。 */
export const MULTI_UNIT_SOURCE_2 = [
  "社区图书馆的功能正在从单纯的借阅场所转向社区活动的组织者。",
  "一些图书馆通过开设免费讲座与手工艺课程，吸引了此前从不进馆的居民。",
].join("");

/** 合成翻译练习 2 的参考译文（**课程材料**）。 */
export const MULTI_UNIT_REFERENCE_2 = [
  "The function of community libraries is shifting from a mere lending venue to an organiser of community activities.",
  "Some libraries have attracted residents who never previously entered by offering free lectures and craft courses.",
].join(" ");

/** 合成翻译练习 3 的中文原文（虚构文本；**刻意没有参考译文**）。 */
export const MULTI_UNIT_SOURCE_3 = [
  "越来越多的城市在规划新城区时，会要求开发商预留一定比例的公共绿地。",
  "支持者认为这能缓解热岛效应，批评者则担心它推高了住房成本。",
].join("");


// ---------------------------------------------------------------------------
// 对抗性场景
// ---------------------------------------------------------------------------

/** 无文本层（图片型）PDF：必须被如实上报，**不做 OCR**。 */
export function imageOnlyPdfFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  tree.set("阅读/scanned-handout.pdf", buildImageOnlyPdf(2));
  return tree;
}

/** 不支持的类型（压缩包）必须被登记但**不解析**。 */
export function unsupportedTypeFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  tree.set("阅读/notes.zip", Buffer.from("PK\u0003\u0004fixture-not-a-real-zip", "utf8"));
  tree.set("阅读/handout.pdf", buildTextPdf([["Passage One", ...wrap(FIXTURE_PASSAGE_A)]]));
  return tree;
}

/** 同名不同内容（两个目录下同名 PDF，内容不同）。 */
export function sameNameDifferentBytesFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  tree.set("第1套/handout.pdf", buildTextPdf([["Passage One", ...wrap(FIXTURE_PASSAGE_A)]]));
  tree.set("第2套/handout.pdf", buildTextPdf([["Passage Two", ...wrap(FIXTURE_PASSAGE_B)]]));
  return tree;
}

/** 字节完全相同的重复文件。 */
export function duplicateContentFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  const bytes = buildTextPdf([["Passage One", ...wrap(FIXTURE_PASSAGE_A)]]);
  tree.set("阅读/handout.pdf", bytes);
  tree.set("阅读/handout-copy.pdf", bytes);
  return tree;
}

/** 源件编号缺陷（重号 + 跳号）—— 必须**原样保留**，不静默修正。 */
export function malformedNumberingFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  tree.set(
    "阅读/defective-numbering.pdf",
    buildTextPdf([
      [
        "Passage One",
        `Questions 46 to 50 are based on the following passage.`,
        ...wrap(FIXTURE_PASSAGE_A),
        "46. First question stem printed here.",
        "46. This number is printed twice by the source.",
        "49. Number jumps from 46 to 49.",
        "50. Final stem.",
      ],
    ]),
  );
  return tree;
}

/** 结构线索缺失的阅读材料：必须退回**文档级**输出并标记复核，不发明边界。 */
export function noStructuralCueFixture(): FixtureSourceTree {
  const tree: FixtureSourceTree = new Map();
  tree.set(
    "阅读/unstructured-notes.pdf",
    buildTextPdf([
      [
        "Course Notes",
        ...wrap(FIXTURE_PASSAGE_A),
        ...wrap(FIXTURE_PASSAGE_B),
      ],
    ]),
  );
  return tree;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 把长句按约 70 字符折行，模拟真实 PDF 的行布局。 */
function wrap(text: string, width = 70): string[] {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current === "") {
      current = word;
      continue;
    }
    if (current.length + 1 + word.length > width) {
      lines.push(current);
      current = word;
      continue;
    }
    current += ` ${word}`;
  }
  if (current !== "") lines.push(current);
  return lines;
}

/** CJK 没有词间空格，按固定字数折行。 */
export function wrapCjk(text: string, width = 24): string[] {
  const chars = [...text];
  const lines: string[] = [];
  for (let index = 0; index < chars.length; index += width) {
    lines.push(chars.slice(index, index + width).join(""));
  }
  return lines.filter((line) => line !== "");
}
