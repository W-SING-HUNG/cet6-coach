import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SECTION_IS_NUMBERED, type PaperSectionType } from "@/domain/paper";

/**
 * 试卷包测试夹具构造器。
 *
 * 为什么放在 `scripts/` 而不是 `tests/`：
 * 单元测试与浏览器 E2E **两者**都需要它，而 Playwright 禁止 spec 之间互相 import，
 * 也不该去 import 测试目录。放在 scripts/ 下两边都能用。
 *
 * 硬性约束：这里构造出的每一份试卷，`sourceKind` 恒为 `test_fixture`。
 * 参数里不提供覆盖它的选项 —— 让"夹具冒充真题"在构造层面就不可能发生。
 */

const TEST_FIXTURE_SOURCE_KIND = "test_fixture" as const;

/** 生成一个最小但**合法可播放**的 WAV（0.1 秒 8kHz 单声道静音）。 */
export function makeSilentWav(durationSeconds = 0.1): Buffer {
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
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  // 8 位 PCM 的静音电平是 128，不是 0
  buffer.fill(128, 44);

  return buffer;
}

export function sha256Hex(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

interface FixtureOptions {
  id?: string;
  year?: number;
  session?: "June" | "September" | "December";
  variant?: string;
  contentVersion?: number;
  /** 缺失的部分大题，用于构造"部分内容"包。 */
  omitSections?: string[];
  audioLabel?: string;
  /**
   * **长文本布局模式（仅用于视觉评审）**，默认 `false`。
   *
   * ── 为什么需要它 ──
   * 默认模式下每份篇章只有一句占位文本（`"Fixture careful-reading passage."`）。
   * 那足以验证"数据能走到界面"，但**无法评估布局**：
   * 分栏比例、段落换行、长选项折行、词库密度、长文滚动、
   * 粘性头尾是否遮挡内容 —— 这些全都要有真实量级的文本才看得出来。
   *
   * ── 它的边界（三条硬约束）──
   * 1. **不是面向学习者的内容**：文本是合成的、通用话题，
   *    不是任何真实考试的材料。来源类型仍由写死常量
   *    `TEST_FIXTURE_SOURCE_KIND` 决定（界面上有显眼的「测试夹具」徽标），
   *    因此它不可能冒充真题（由架构门禁固定）。
   * 2. **不进生产内容路径**：只在 E2E 内容根（`.e2e/content`）下使用；
   *    `private-content/` 与 `pnpm content:import` 都不会遇到它。
   * 3. **不成为 Expert 证据**：它是软件测试夹具，不产生任何学习者观测。
   *
   * 真正需要它的是 `e2e/review-visual.spec.ts` —— 那套截图的意义就是
   * "在接近真实的文本量级下检查布局"，用一句话的篇章是拍不出结论的。
   */
  longForm?: boolean;
  /**
   * 覆盖仔细阅读大题的篇章正文（**默认 null = 用内置占位句子**）。
   *
   * ── 为什么需要它（A3 端到端证明）──
   *
   * A3 要证明的是**完整的接入路径**，其中包含"建链"这一步 ——
   * 而建链要求机器**真的**在课程段与真题之间提出过一条建议
   * （`accepted_suggestion` 必须指向机器实际提出过的映射，这是硬门禁）。
   *
   * 默认占位句子（`"Fixture careful-reading passage."`）与课程源材料
   * 没有任何内容重叠，因此匹配器**必然**提不出建议，那条路径就无法被覆盖。
   *
   * 传入课程夹具的真实篇章文本后，匹配器基于**内容**提出建议，
   * 于是建链走的是真实判据（投影精确性 / 正文包含度 / Jaccard / 题干与选项重叠）。
   *
   * ── 它**不**放宽任何真题门禁 ──
   *
   * - 来源类型仍是写死的 `TEST_FIXTURE_SOURCE_KIND`（源码级门禁守护：
   *   参数类型里不得出现那个字段名 —— 因此这里的说明也刻意不写它）；
   * - 文本仍是**合成**说明文（`FIXTURE_PASSAGE_A`），不是任何真实考试材料；
   * - 界面上仍是显眼的「测试夹具」。
   *
   * 它只影响"这段合成正文是什么"，不影响"它是什么来源"。
   */
  carefulReadingPassage?: string | null;
}

interface QuestionTemplate {
  kind: "mcq" | "banked_cloze_blank" | "matching_statement" | "writing" | "translation";
}

function buildSection(
  type: string,
  firstNumber: number,
  templates: Array<{ count: number; kind: QuestionTemplate["kind"] }>,
  longForm = false,
  carefulReadingPassage: string | null = null,
): { section: Record<string, unknown>; nextNumber: number; questionCount: number } {
  let number = firstNumber;
  let questionCount = 0;
  const groups: Record<string, unknown>[] = [];

  templates.forEach((template, groupIndex) => {
    // 本组的起始题号 = 前面所有组的题量之和 + 首个题号。
    // 必须用累计值：每组的题量各不相同（听力篇章 4+3、讲座 4+3+3），
    // 用 "本组题量 × 组序" 会算错（这正是此处最初写错的地方）。
    const groupFirstNumber = number;
    // 写作与翻译是主观作答项，官方不编号 —— 题号与 firstNumber 都必须是 null。
    const numbered = SECTION_IS_NUMBERED[type as PaperSectionType];

    const questions: Record<string, unknown>[] = [];
    for (let index = 0; index < template.count; index += 1) {
      const questionNumber = numbered ? number : null;
      const base: Record<string, unknown> = {
        id: numbered ? `q${number}` : `q_${type.replace(/\./g, "_")}`,
        number: questionNumber,
        order: index,
        explanation: `夹具解析：第 ${questionNumber ?? "—"} 题。`,
      };
      if (template.kind === "mcq") {
        base.kind = "mcq";
        if (longForm) {
          // 真实题干常是一句完整的设问；长选项用于检验折行
          base.stem =
            "According to the passage, which of the following best describes the reason that the researchers " +
            "regarded the second presentation of the material as informative rather than redundant?";
          base.options = ["A", "B", "C", "D"].map((letter) => ({
            id: letter,
            label: longOptionLabel(letter, index % 3 === 2 ? "long" : "medium"),
          }));
        } else {
          base.stem = `Fixture question ${questionNumber}`;
          base.options = ["A", "B", "C", "D"].map((letter) => ({ id: letter, label: `Option ${letter}` }));
        }
        base.answer = "B";
      } else if (template.kind === "banked_cloze_blank") {
        base.kind = "banked_cloze_blank";
        base.blankId = String(index + 1);
        base.answer = longForm ? `fixtureword${index + 1}` : `word${index + 1}`;
      } else if (template.kind === "matching_statement") {
        base.kind = "matching_statement";
        base.statement = longForm
          ? LONGFORM_SENTENCES[(index + 4) % LONGFORM_SENTENCES.length]
          : `Fixture statement ${questionNumber}`;
        base.answerParagraph = ["A", "B", "C", "D"][index % 4];
      } else if (template.kind === "writing") {
        base.kind = "writing";
        base.prompt = "Fixture writing prompt: state your view on a familiar topic.";
        base.instructions = "Write at least 150 words.";
        base.referenceEssay = null;
        base.minWords = 150;
        base.maxWords = 200;
      } else {
        base.kind = "translation";
        base.sourceText = "这是夹具用的中文段落，用于验证汉译英题目的结构。";
        base.instructions = "Translate the paragraph into English.";
        base.referenceTranslation = null;
      }
      questions.push(base);
      if (numbered) number += 1;
      questionCount += 1;
    }

    groups.push({
      id: `${type}#g${groupIndex + 1}`,
      order: groupIndex,
      instructions: null,
      audioAssetId: type.startsWith("listening.") ? `audio_${type}#g${groupIndex + 1}` : null,
      transcript: type.startsWith("listening.") ? `Fixture transcript for group ${groupIndex + 1}.` : null,
      passage: null,
      paragraphs: null,
      wordBank: null,
      firstNumber: numbered ? groupFirstNumber : null,
      questions,
    });
  });

  if (type === "reading.careful_reading") {
    groups.forEach((group, i) => {
      // 显式提供的合成篇章优先（A3 端到端证明需要内容真实重叠才能产生匹配建议）
      if (carefulReadingPassage !== null && carefulReadingPassage !== "") {
        group.passage = carefulReadingPassage;
        return;
      }
      // 长文本模式：约 420 词 / 7 段，贴近真实仔细阅读的两篇长文
      group.passage = longForm
        ? longPassage(24, 7, i * 7)
        : "Fixture careful-reading passage.";
    });
  }
  if (type === "reading.banked_cloze") {
    if (longForm) {
      /*
        选词填空：空位由原文里**本来就有**的 `[n]` 占位符表达。
        这里用长句做上下文，让 10 个空分散在 5 段里 ——
        这样才能检验"空位在长文中是否找得到"以及词库并排的密度。
      */
      const blocks: string[] = [];
      for (let b = 0; b < 5; b += 1) {
        const a = LONGFORM_SENTENCES[(b * 3) % LONGFORM_SENTENCES.length];
        const c = LONGFORM_SENTENCES[(b * 3 + 1) % LONGFORM_SENTENCES.length];
        const bIdx = b * 2 + 1;
        blocks.push(`${a} The [${bIdx}] of the argument depends on [${bIdx + 1}] rather than assertion. ${c}`);
      }
      groups[0].passage = blocks.join("\n\n");
      groups[0].wordBank = Array.from({ length: 15 }, (_, index) => `fixtureword${index + 1}`);
    } else {
      groups[0].passage = Array.from({ length: 10 }, (_, index) => `word${index + 1} [${index + 1}] context.`).join(" ");
      groups[0].wordBank = Array.from({ length: 15 }, (_, index) => `word${index + 1}`);
    }
  }
  if (type === "reading.matching") {
    // 长篇阅读真实形态是 A–O 段落（15 段）；夹具原先只有 5 段，检验不出真实密度
    const labels = longForm
      ? ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M", "N", "O"]
      : ["A", "B", "C", "D", "E"];
    groups[0].paragraphs = labels.map((label, index) => ({
      label,
      text: longForm
        ? LONGFORM_SENTENCES[(index * 2) % LONGFORM_SENTENCES.length]
        : `Fixture paragraph ${label}.`,
    }));
  }

  return {
    section: {
      id: type,
      type,
      order: 0,
      title: type,
      instructions: null,
      groups,
    },
    nextNumber: number,
    questionCount,
  };
}

/**
 * 长文本夹具的语料（**合成、通用话题，不来自任何真实考试**）。
 *
 * 这些句子刻意写得"像学术说明文"：每句 20–35 词、含从句与连接词，
 * 段落 4–6 句。目的是让**文本量级**接近真实 CET-6 长篇阅读
 * （约 350–450 词/篇、6–8 段），从而能真实检验：
 * 分栏比例、段落换行、行高、滚动行为、粘性头尾是否遮挡。
 *
 * 它们不是题目材料，也不该被当作学习内容 —— 只在 `.e2e/content` 下使用。
 */
const LONGFORM_SENTENCES: readonly string[] = [
  "Researchers who study how people make decisions have long observed that the same information can lead to strikingly different conclusions depending on the order in which it is presented.",
  "In one widely cited experiment, participants were asked to evaluate two hypothetical candidates whose qualifications had been summarised in advance by an independent panel of reviewers.",
  "The panel had deliberately described each candidate in neutral terms, yet the overwhelming majority of participants reported a clear preference after reading only the first few lines of each profile.",
  "What made the result interesting was not that a preference existed, but that it survived even after the participants were shown the material a second time in the opposite order.",
  "Later work suggested that this persistence arises because people tend to construct an initial interpretation early and then evaluate subsequent details in the light of that interpretation rather than revising it.",
  "The effect is not limited to laboratory settings, and it has been documented in contexts as varied as medical triage, hiring committees, and the appraisal of research proposals.",
  "Critics have pointed out that many of these studies rely on tasks that are artificial in ways that matter, and that the magnitude of the effect shrinks considerably outside the laboratory.",
  "A more cautious reading of the evidence is therefore that order matters, but that it interacts with expertise, motivation, and the amount of time available for deliberation.",
  "Practitioners in fields where consequential judgments are routine have developed a range of procedural safeguards, most of which amount to separating the collection of information from its evaluation.",
  "Whether such safeguards actually improve the quality of decisions, rather than merely making the process easier to defend afterwards, remains an open and genuinely contested question.",
  "Consider the problem of designing a reading test that measures comprehension rather than familiarity with a particular subject matter.",
  "If the passages are drawn from fields that some candidates happen to know well, then differences in scores will reflect background knowledge as much as reading ability.",
  "Test designers therefore try to select passages whose content is unlikely to be familiar, while keeping the vocabulary and the syntactic structures within a defined range.",
  "This is a delicate balance, because passages that are too unfamiliar demand background reasoning that the test is not intended to measure.",
  "The solution adopted by most large-scale assessments is to pilot a larger pool of passages than will ever be used, and to discard those whose statistical behaviour is anomalous.",
  "Anomalous behaviour can take several forms, including unusually low discrimination between stronger and weaker candidates, or unexpectedly high omission rates on particular items.",
  "Omission is a case that deserves separate attention, because a question that a candidate chooses not to answer carries different information from a question answered incorrectly.",
  "Treating the two as equivalent will systematically distort any estimate of ability, and the distortion is largest for candidates who run short of time.",
  "For this reason, many reporting systems present the two categories independently rather than collapsing them into a single accuracy figure.",
];

/** 生成一段 n 句的合成篇章（从固定语料按序取，必要时循环）。 */
function longPassage(sentenceCount: number, paragraphCount: number, offset = 0): string {
  const sentencesPerParagraph = Math.max(1, Math.round(sentenceCount / paragraphCount));
  const paragraphs: string[] = [];
  let cursor = offset;

  for (let p = 0; p < paragraphCount; p += 1) {
    const chunk: string[] = [];
    for (let s = 0; s < sentencesPerParagraph; s += 1) {
      chunk.push(LONGFORM_SENTENCES[cursor % LONGFORM_SENTENCES.length]);
      cursor += 1;
    }
    paragraphs.push(chunk.join(" "));
  }
  return paragraphs.join("\n\n");
}

/**
 * 长选项文本（用于检验选项折行）。
 *
 * 真实 CET-6 选项常有整句长度；短选项（`Option A`）检验不出折行与行高问题。
 */
function longOptionLabel(letter: string, length: "short" | "medium" | "long"): string {
  const base = LONGFORM_SENTENCES[letter.charCodeAt(0) % LONGFORM_SENTENCES.length];
  if (length === "short") return `Option ${letter}: a brief distractor`;
  if (length === "medium") return base.slice(0, 90);
  // long：接近"整句选项"，用于检验多行折行
  return `${base} ${LONGFORM_SENTENCES[(letter.charCodeAt(0) + 3) % LONGFORM_SENTENCES.length]}`;
}

const SECTION_BUILDERS: Array<{
  type: string;
  templates: Array<{ count: number; kind: QuestionTemplate["kind"] }>;
}> = [
  { type: "writing", templates: [{ count: 1, kind: "writing" }] },
  {
    type: "listening.long_conversation",
    templates: [
      { count: 4, kind: "mcq" },
      { count: 4, kind: "mcq" },
    ],
  },
  {
    type: "listening.passage",
    templates: [
      { count: 4, kind: "mcq" },
      { count: 3, kind: "mcq" },
    ],
  },
  {
    type: "listening.talk_report_lecture",
    templates: [
      { count: 4, kind: "mcq" },
      { count: 3, kind: "mcq" },
      { count: 3, kind: "mcq" },
    ],
  },
  { type: "reading.banked_cloze", templates: [{ count: 10, kind: "banked_cloze_blank" }] },
  { type: "reading.matching", templates: [{ count: 10, kind: "matching_statement" }] },
  {
    type: "reading.careful_reading",
    templates: [
      { count: 5, kind: "mcq" },
      { count: 5, kind: "mcq" },
    ],
  },
  { type: "translation", templates: [{ count: 1, kind: "translation" }] },
];

export interface FixturePackage {
  manifest: Record<string, unknown>;
  /** 包内相对路径 → 字节内容。用于写盘与校验和核对。 */
  files: Map<string, Buffer>;
}

/**
 * 构造一份完整的 CET-6 试卷夹具（57 题、8 个大题，结构与官方一致）。
 * 全程 `sourceKind: "test_fixture"`。
 */
export function buildFixturePackage(options: FixtureOptions = {}): FixturePackage {
  const id = options.id ?? "fixture-cet6-2024-12-v1";
  const omit = new Set(options.omitSections ?? []);

  const files = new Map<string, Buffer>();
  const assets: Record<string, unknown>[] = [];

  let nextNumber = 1;
  const sections: Record<string, unknown>[] = [];

  SECTION_BUILDERS.forEach((builder, index) => {
    if (omit.has(builder.type)) {
      // 跳过大题时，题号也必须跳过 —— 官方编号占位必须保留，否则后续题号会整体前移
      if (SECTION_IS_NUMBERED[builder.type as PaperSectionType]) {
        for (const template of builder.templates) nextNumber += template.count;
      }
      return;
    }
    const built = buildSection(
      builder.type,
      nextNumber,
      builder.templates,
      options.longForm ?? false,
      options.carefulReadingPassage ?? null,
    );
    nextNumber = built.nextNumber;
    built.section.order = index;
    sections.push(built.section);

    if (builder.type.startsWith("listening.")) {
      for (const group of built.section.groups as Record<string, unknown>[]) {
        const assetId = String(group.audioAssetId);
        const relativePath = `assets/${assetId.replace(/[^a-zA-Z0-9._-]/g, "_")}.wav`;
        const bytes = makeSilentWav(0.05);
        files.set(relativePath, bytes);
        assets.push({
          id: assetId,
          kind: "audio",
          path: relativePath,
          mimeType: "audio/wav",
          bytes: bytes.length,
          checksum: sha256Hex(bytes),
          label: options.audioLabel ?? `${builder.type} group audio`,
        });
      }
    }
  });

  const manifest: Record<string, unknown> = {
    id,
    examType: "CET6",
    year: options.year ?? 2024,
    session: options.session ?? "December",
    variant: options.variant ?? "set1",
    examDate: null,
    sourceKind: TEST_FIXTURE_SOURCE_KIND,
    verificationStatus: "unverified",
    provenance: {
      note: options.longForm
        ? "自动化测试夹具（长文本布局模式）：结构仿照官方试卷，内容为合成通用说明文，用于视觉评审中的布局检查。不是真题。"
        : "自动化测试夹具：结构仿照官方试卷，但内容为合成文本，不是真题。",
      reference: "scripts/paper-fixture.ts",
      verificationNote: null,
    },
    contentVersion: options.contentVersion ?? 1,
    partial: omit.size > 0,
    sections,
    assets,
  };

  return { manifest, files };
}

/** 把夹具写入磁盘，返回包目录。 */
export function writeFixturePackage(rootDir: string, packageDirName: string, fixture: FixturePackage): string {
  const dir = join(rootDir, "cet6", "papers", packageDirName);
  mkdirSync(dir, { recursive: true });
  for (const [relativePath, bytes] of fixture.files) {
    const target = join(dir, ...relativePath.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(join(dir, "paper.json"), `${JSON.stringify(fixture.manifest, null, 2)}\n`, "utf8");
  return dir;
}
