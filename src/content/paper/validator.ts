import { z } from "zod";
import {
  ASSET_KINDS,
  type ExamPaperContent,
  type PaperAsset,
  type PaperGroup,
  type PaperQuestion,
  type PaperSection,
  type PaperIssue,
} from "./types";
import {
  OFFICIAL_NUMBERED_ITEM_TOTAL,
  OFFICIAL_SECTION_ORDER,
  PAPER_EXAM_TYPES,
  PAPER_SESSIONS,
  PAPER_SECTION_TYPES,
  PAPER_SOURCE_KINDS,
  PAPER_VERIFICATION_STATUSES,
  SECTION_IS_NUMBERED,
  SECTION_QUESTION_COUNTS,
  type PaperSectionType,
} from "@/domain/paper";
import { ASSET_MIME_BY_EXTENSION } from "./types";
import { UnsafePathError, normalizeRelativePath, pathSafetyCategory } from "./paths";

/**
 * 规范化试卷包的校验器。
 *
 * 分两层：
 * 1. **本文件**：纯函数。形状（zod）+ 语义（手写遍历）。不接触文件系统，
 *    因此可以被单测穷举，也可以在 dry-run 中安全运行。
 * 2. `importer.ts`：读磁盘、比对资产字节与校验和。
 *
 * 为什么语义校验不用 zod 的 superRefine：
 * 需要一次性收集**全部**问题并给出精确位置（`sections[2].groups[1].questions[3].answer`），
 * 而不是只报第一个。手写遍历让路径拼接可见、可测。
 */

// ---------------------------------------------------------------------------
// 形状 schema
// ---------------------------------------------------------------------------

const nullableText = z.string().nullable().default(null);

const optionSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
});

const questionBaseShape = {
  id: z.string().min(1),
  // 题号可为 null：写作与翻译是主观作答项，官方不编号。
  // 是否必须为整数由语义校验按 SECTION_IS_NUMBERED 判定。
  number: z.number().int().min(1).nullable().default(null),
  order: z.number().int().min(0),
  explanation: nullableText,
};

const questionSchema = z.discriminatedUnion("kind", [
  z.object({
    ...questionBaseShape,
    kind: z.literal("mcq"),
    stem: z.string().min(1),
    options: z.array(optionSchema).min(1),
    answer: z.string().min(1),
  }),
  z.object({
    ...questionBaseShape,
    kind: z.literal("banked_cloze_blank"),
    blankId: z.string().min(1),
    answer: z.string().min(1),
  }),
  z.object({
    ...questionBaseShape,
    kind: z.literal("matching_statement"),
    statement: z.string().min(1),
    answerParagraph: z.string().min(1),
  }),
  z.object({
    ...questionBaseShape,
    kind: z.literal("writing"),
    prompt: z.string().min(1),
    instructions: nullableText,
    referenceEssay: nullableText,
    minWords: z.number().int().min(0).nullable().default(null),
    maxWords: z.number().int().min(0).nullable().default(null),
  }),
  z.object({
    ...questionBaseShape,
    kind: z.literal("translation"),
    sourceText: z.string().min(1),
    instructions: nullableText,
    referenceTranslation: nullableText,
  }),
]);

const groupSchema = z.object({
  id: z.string().min(1),
  order: z.number().int().min(0),
  instructions: nullableText,
  audioAssetId: z.string().nullable().default(null),
  transcript: nullableText,
  passage: nullableText,
  paragraphs: z
    .array(z.object({ label: z.string().min(1), text: z.string().min(1) }))
    .nullable()
    .default(null),
  wordBank: z.array(z.string().min(1)).nullable().default(null),
  firstNumber: z.number().int().min(1).nullable().default(null),
  questions: z.array(questionSchema).min(1),
});

const slugPattern = /^[a-z0-9][a-z0-9._-]*$/;

const sectionSchema = z.object({
  // id 会出现在 URL 里（section 浏览页），因此限制为 slug 字符集，
  // 避免路径编码问题与"包作者塞进奇怪字符"导致的链接不可用
  id: z.string().regex(slugPattern, "section id 只能包含小写字母、数字、点、下划线与连字符"),
  type: z.enum(PAPER_SECTION_TYPES),
  order: z.number().int().min(0),
  title: z.string().min(1),
  instructions: nullableText,
  groups: z.array(groupSchema).min(1),
});

const assetSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(ASSET_KINDS),
  path: z.string().min(1),
  mimeType: z.string().min(1),
  bytes: z.number().int().min(0),
  checksum: z.string().regex(/^[0-9a-f]{64}$/, "checksum 必须是 64 位小写十六进制 sha256"),
  label: nullableText,
});

const provenanceSchema = z.object({
  note: z.string().min(1),
  reference: nullableText,
  verificationNote: nullableText,
});

const paperManifestSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "id 只能包含小写字母、数字、点、下划线与连字符"),
  examType: z.enum(PAPER_EXAM_TYPES),
  year: z.number().int().min(2000).max(2100),
  session: z.enum(PAPER_SESSIONS),
  variant: z.string().min(1),
  examDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "examDate 必须是 YYYY-MM-DD")
    .nullable()
    .default(null),
  sourceKind: z.enum(PAPER_SOURCE_KINDS),
  verificationStatus: z.enum(PAPER_VERIFICATION_STATUSES),
  provenance: provenanceSchema,
  contentVersion: z.number().int().min(1),
  /**
   * 包声明自己只包含部分内容。默认 false —— 完整卷是常态，
 * 部分内容必须被显式声明，否则按"不完整"拒绝。
   */
  partial: z.boolean().default(false),
  sections: z.array(sectionSchema).min(1),
  assets: z.array(assetSchema).default([]),
});

type ParsedManifest = z.infer<typeof paperManifestSchema>;

export interface ValidationOutcome {
  ok: boolean;
  paper: (ExamPaperContent & { partial: boolean }) | null;
  issues: PaperIssue[];
  warnings: string[];
}

export function formatIssuePath(path: ReadonlyArray<string | number | symbol>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      out += `[${segment}]`;
    } else if (typeof segment === "string") {
      out += out === "" ? segment : `.${segment}`;
    }
  }
  return out === "" ? "<paper>" : out;
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 校验一份规范化试卷 manifest。
 *
 * 返回的 `paper` 只在 `ok === true` 时非空：调用方无法拿到"校验失败的半成品"，
 * 因此不可能把它写进数据库。
 */
export function validatePaperManifest(raw: unknown): ValidationOutcome {
  const parsed = paperManifestSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      paper: null,
      issues: parsed.error.issues.map((issue) => ({
        path: formatIssuePath(issue.path),
        message: issue.message,
      })),
      warnings: [],
    };
  }

  const issues: PaperIssue[] = [];
  const warnings: string[] = [];

  const assets = normalizeAssets(parsed.data, issues);
  const sections = normalizeSections(parsed.data, assets, issues, warnings);

  validatePaperLevel(parsed.data, sections, issues, warnings);

  if (issues.length > 0) {
    return { ok: false, paper: null, issues, warnings };
  }

  const paper: ExamPaperContent & { partial: boolean } = {
    id: parsed.data.id,
    examType: parsed.data.examType,
    year: parsed.data.year,
    session: parsed.data.session,
    variant: parsed.data.variant,
    examDate: parsed.data.examDate,
    sourceKind: parsed.data.sourceKind,
    verificationStatus: parsed.data.verificationStatus,
    provenance: {
      note: parsed.data.provenance.note,
      reference: parsed.data.provenance.reference,
      verificationNote: parsed.data.provenance.verificationNote,
    },
    contentVersion: parsed.data.contentVersion,
    partial: parsed.data.partial,
    sections,
    assets,
  };

  return { ok: true, paper, issues: [], warnings };
}

// ---------------------------------------------------------------------------
// 资产
// ---------------------------------------------------------------------------

function normalizeAssets(manifest: ParsedManifest, issues: PaperIssue[]): PaperAsset[] {
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const result: PaperAsset[] = [];

  manifest.assets.forEach((asset, index) => {
    const base = `assets[${index}]`;

    if (seenIds.has(asset.id)) {
      issues.push({ path: `${base}.id`, message: `资产 id 重复：${asset.id}` });
    }
    seenIds.add(asset.id);

    let relativePath: string | null = null;
    try {
      relativePath = normalizeRelativePath(asset.path);
    } catch (error) {
      /*
       * ── 措辞纪律（独立评审 F-2 的同类根因）──
       *
       * `UnsafePathError` 的消息会回显 manifest 里声明的 `asset.path`。
       * 这些 issue 会出现在复核报告与（经 `packageIssue`）界面上，
       * 而 manifest 是**外部数据**。回显它等于让一个 JSON 字段决定
       * 浏览器里出现什么文本。
       *
       * 判定完全保留（`normalizeRelativePath` 的拒绝一点没松），
       * 只是把"为什么"从原文回显换成不含输入的分类原因。
       * 使用者仍然知道是哪个下标（`path` 字段）与该怎么改。
       */
      const reason =
        error instanceof UnsafePathError
          ? `资产路径不合法（${pathSafetyCategory(error)}）。它必须是包内的相对路径，不得含 ..、绝对路径、盘符或 UNC。`
          : "资产路径无法解析。";
      issues.push({ path: `${base}.path`, message: reason });
    }

    if (relativePath !== null) {
      /*
       * ── 这里的回显是安全的，边界要说清 ──
       *
       * 下面几条消息回显 `relativePath` —— 但它是**已经通过
       * `normalizeRelativePath` 的规范化相对路径**：不含 `..`、不含绝对路径、
       * 不含盘符/UNC、不含空字节。因此它不可能携带本机布局信息。
       *
       * 这与 F-2 修掉的那类回显有本质区别：
       *
       *   | 回显什么 | 安全性 |
       *   | --- | --- |
       *   | 规范化后的包内相对路径（此处） | 安全：已被证明 bounded |
       *   | manifest 声明的**原始**路径（`asset.path`，即上面 catch 里那个） | 不安全：外部数据，未验证 |
       *   | 数据库里的 `package_path`（catalog 的 handleFor） | 不安全：库不是可信来源 |
       *   | 服务端绝对路径（`getPapersDir()` 等） | 不安全：盘符 + 用户名 + 安装位置 |
       *
       * 判据因此不是"一律不回显"，而是"只回显已被证明 bounded 的值"。
       * 新增消息时按这个表自查：你回显的那个值，有没有被验证过？
       */
      if (seenPaths.has(relativePath)) {
        issues.push({ path: `${base}.path`, message: `资产路径重复：${relativePath}` });
      }
      seenPaths.add(relativePath);

      const expectedMime = mimeForPath(relativePath);
      if (expectedMime === null) {
        issues.push({
          path: `${base}.path`,
          message: `不支持的资产扩展名：${relativePath}（允许 ${Object.keys(ASSET_MIME_BY_EXTENSION).join(" / ")}）`,
        });
      } else if (asset.mimeType !== expectedMime) {
        // 刻意不信任 manifest 声明的 MIME：以扩展名为准，声明不符即拒绝
        issues.push({
          path: `${base}.mimeType`,
          message: `声明的 MIME 与扩展名不符：声明 ${asset.mimeType}，${relativePath} 应为 ${expectedMime}`,
        });
      }

      const expectedKind = expectedMime?.startsWith("audio/") ? "audio" : "image";
      if (asset.kind !== expectedKind) {
        issues.push({
          path: `${base}.kind`,
          message: `资产类型与扩展名不符：声明 ${asset.kind}，${relativePath} 应为 ${expectedKind}`,
        });
      }
    }

    if (relativePath === null) return;

    result.push({
      id: asset.id,
      kind: asset.kind,
      relativePath,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      checksum: asset.checksum,
      label: asset.label,
    });
  });

  return result;
}

export function mimeForPath(relativePath: string): string | null {
  const lower = relativePath.toLowerCase();
  const dot = lower.lastIndexOf(".");
  if (dot < 0) return null;
  return ASSET_MIME_BY_EXTENSION[lower.slice(dot)] ?? null;
}

// ---------------------------------------------------------------------------
// 大题与题组
// ---------------------------------------------------------------------------

function normalizeSections(
  manifest: ParsedManifest,
  assets: PaperAsset[],
  issues: PaperIssue[],
  warnings: string[],
): PaperSection[] {
  const audioIds = new Set(assets.filter((asset) => asset.kind === "audio").map((asset) => asset.id));
  const globalQuestionIds = new Set<string>();

  return manifest.sections.map((section, sectionIndex) => {
    const sectionBase = `sections[${sectionIndex}]`;
    const isListening = section.type.startsWith("listening.");

    const groups: PaperGroup[] = section.groups.map((group, groupIndex) => {
      const groupBase = `${sectionBase}.groups[${groupIndex}]`;

      if (isListening) {
        if (group.audioAssetId === null) {
          issues.push({ path: `${groupBase}.audioAssetId`, message: "听力题组必须引用音频资产" });
        } else if (!audioIds.has(group.audioAssetId)) {
          issues.push({
            path: `${groupBase}.audioAssetId`,
            message: `引用了不存在的音频资产：${group.audioAssetId}`,
          });
        }
      } else if (group.audioAssetId !== null) {
        issues.push({
          path: `${groupBase}.audioAssetId`,
          message: `非听力题组不应引用音频：${section.type}`,
        });
      }

      const questions: PaperQuestion[] = group.questions.map((question, questionIndex) => {
        const questionBase = `${groupBase}.questions[${questionIndex}]`;
        const numbered = SECTION_IS_NUMBERED[section.type];

        if (globalQuestionIds.has(question.id)) {
          issues.push({ path: `${questionBase}.id`, message: `全卷题目 id 重复：${question.id}` });
        }
        globalQuestionIds.add(question.id);

        if (question.order !== questionIndex) {
          issues.push({
            path: `${questionBase}.order`,
            message: `组内顺序必须连续：期望 ${questionIndex}，实际 ${question.order}`,
          });
        }

        // 题号存在性必须与官方编号规则一致。
        // 这条规则来自实测：源卷存档 PDF 的 KEYS 表只编号听力与阅读，
        // 写作/翻译没有题号；反过来客观题必须有题号，否则无法与答案表对应。
        if (numbered && question.number === null) {
          issues.push({
            path: `${questionBase}.number`,
            message: `${section.type} 属于官方编号部分，题目必须有题号`,
          });
        }
        if (!numbered && question.number !== null) {
          issues.push({
            path: `${questionBase}.number`,
            message: `${section.type} 是主观作答项，官方不编号，题号必须为 null`,
          });
        }

        if (numbered) {
          if (group.firstNumber === null) {
            issues.push({ path: `${groupBase}.firstNumber`, message: "编号部分的题组必须声明 firstNumber" });
          } else if (questionIndex === 0 && group.firstNumber !== question.number) {
            issues.push({
              path: `${groupBase}.firstNumber`,
              message: `firstNumber 与首题题号不一致：声明 ${group.firstNumber}，首题 ${question.number}`,
            });
          }
        } else if (group.firstNumber !== null) {
          issues.push({
            path: `${groupBase}.firstNumber`,
            message: "非编号部分（写作/翻译）不得声明 firstNumber",
          });
        }

        return normalizeQuestion(question, questionBase, group, groupBase, issues);
      });

      if (group.passage !== null && section.type === "reading.banked_cloze") {
        for (const blank of questions) {
          if (blank.kind !== "banked_cloze_blank") continue;
          const marker = `[${blank.blankId}]`;
          if (!group.passage.includes(marker)) {
            issues.push({
              path: `${groupBase}.passage`,
              message: `文章缺少空位标记 ${marker}`,
            });
          }
        }
      }

      if (group.paragraphs !== null) {
        const labels = new Set<string>();
        group.paragraphs.forEach((paragraph, paragraphIndex) => {
          if (labels.has(paragraph.label)) {
            issues.push({
              path: `${groupBase}.paragraphs[${paragraphIndex}].label`,
              message: `段落标号重复：${paragraph.label}`,
            });
          }
          labels.add(paragraph.label);
        });
      }

      const normalized: PaperGroup = {
        id: group.id,
        order: groupIndex,
        instructions: group.instructions,
        audioAssetId: group.audioAssetId,
        transcript: group.transcript,
        passage: group.passage,
        paragraphs: group.paragraphs,
        wordBank: group.wordBank,
        firstNumber: group.firstNumber,
        questions,
      };

      validateGroupShape(section.type, normalized, groupBase, groupIndex, issues, warnings);
      return normalized;
    });

    return {
      id: section.id,
      type: section.type,
      order: sectionIndex,
      title: section.title,
      instructions: section.instructions,
      groups,
    };
  });
}

function normalizeQuestion(
  question: ParsedManifest["sections"][number]["groups"][number]["questions"][number],
  base: string,
  group: ParsedManifest["sections"][number]["groups"][number],
  groupBase: string,
  issues: PaperIssue[],
): PaperQuestion {
  switch (question.kind) {
    case "mcq": {
      const optionIds = new Set<string>();
      question.options.forEach((option, optionIndex) => {
        if (optionIds.has(option.id)) {
          issues.push({
            path: `${base}.options[${optionIndex}].id`,
            message: `选项 id 重复：${option.id}`,
          });
        }
        optionIds.add(option.id);
      });

      if (question.options.length !== 4) {
        issues.push({
          path: `${base}.options`,
          message: `CET-6 客观题恒为四选一，实际 ${question.options.length} 个选项`,
        });
      }

      if (!optionIds.has(question.answer)) {
        issues.push({
          path: `${base}.answer`,
          message: `答案指向不存在的选项：${question.answer}`,
        });
      }

      return {
        kind: "mcq",
        id: question.id,
        number: question.number,
        order: question.order,
        explanation: question.explanation,
        stem: question.stem,
        options: question.options,
        answer: question.answer,
      };
    }
    case "banked_cloze_blank": {
      const wordBank = group.wordBank ?? [];
      if (wordBank.length === 0) {
        issues.push({ path: `${groupBase}.wordBank`, message: "选词填空必须提供词库" });
      } else if (!wordBank.includes(question.answer)) {
        issues.push({
          path: `${base}.answer`,
          message: `答案不在词库中：${question.answer}`,
        });
      }
      return {
        kind: "banked_cloze_blank",
        id: question.id,
        number: question.number,
        order: question.order,
        explanation: question.explanation,
        blankId: question.blankId,
        answer: question.answer,
      };
    }
    case "matching_statement": {
      const labels = new Set((group.paragraphs ?? []).map((paragraph) => paragraph.label));
      if (labels.size === 0) {
        issues.push({ path: `${groupBase}.paragraphs`, message: "段落匹配必须提供带标号的段落" });
      } else if (!labels.has(question.answerParagraph)) {
        issues.push({
          path: `${base}.answerParagraph`,
          message: `匹配目标段落不存在：${question.answerParagraph}（可用 ${[...labels].join("/")}）`,
        });
      }
      return {
        kind: "matching_statement",
        id: question.id,
        number: question.number,
        order: question.order,
        explanation: question.explanation,
        statement: question.statement,
        answerParagraph: question.answerParagraph,
      };
    }
    case "writing": {
      if (question.minWords !== null && question.maxWords !== null && question.minWords > question.maxWords) {
        issues.push({ path: `${base}.minWords`, message: "最少词数大于最多词数" });
      }
      return {
        kind: "writing",
        id: question.id,
        number: question.number,
        order: question.order,
        explanation: question.explanation,
        prompt: question.prompt,
        instructions: question.instructions,
        referenceEssay: question.referenceEssay,
        minWords: question.minWords,
        maxWords: question.maxWords,
      };
    }
    case "translation": {
      if (!/[\u4e00-\u9fff]/.test(question.sourceText)) {
        issues.push({
          path: `${base}.sourceText`,
          message: "翻译原文应包含中文（CET-6 为汉译英）",
        });
      }
      return {
        kind: "translation",
        id: question.id,
        number: question.number,
        order: question.order,
        explanation: question.explanation,
        sourceText: question.sourceText,
        instructions: question.instructions,
        referenceTranslation: question.referenceTranslation,
      };
    }
  }
}

/** 大题级别的结构约束：题组形态必须与官方题型一致。 */
function validateGroupShape(
  type: PaperSectionType,
  group: PaperGroup,
  base: string,
  index: number,
  issues: PaperIssue[],
  warnings: string[],
): void {
  const kinds = group.questions.map((question) => question.kind);

  switch (type) {
    case "writing":
    case "translation": {
      const expected = type === "writing" ? "writing" : "translation";
      if (kinds.some((kind) => kind !== expected)) {
        issues.push({ path: `${base}.questions`, message: `${type} 大题只能包含 ${expected} 题目` });
      }
      break;
    }
    case "reading.banked_cloze": {
      if (group.passage === null) issues.push({ path: `${base}.passage`, message: "选词填空缺少文章" });
      if (kinds.some((kind) => kind !== "banked_cloze_blank")) {
        issues.push({ path: `${base}.questions`, message: "选词填空只能包含 banked_cloze_blank 题目" });
      }
      const blankIds = new Set<string>();
      for (const [blankIndex, question] of group.questions.entries()) {
        if (question.kind !== "banked_cloze_blank") continue;
        if (blankIds.has(question.blankId)) {
          issues.push({
            path: `${base}.questions[${blankIndex}].blankId`,
            message: `空位编号重复：${question.blankId}`,
          });
        }
        blankIds.add(question.blankId);
      }
      // 官方规则：词库每词至多使用一次
      const usedAnswers = group.questions
        .filter((question) => question.kind === "banked_cloze_blank")
        .map((question) => (question.kind === "banked_cloze_blank" ? question.answer : ""));
      const seenAnswers = new Set<string>();
      for (const [answerIndex, answer] of usedAnswers.entries()) {
        if (seenAnswers.has(answer)) {
          issues.push({
            path: `${base}.questions[${answerIndex}].answer`,
            message: `词库词被重复使用：${answer}（官方规则每词至多一次）`,
          });
        }
        seenAnswers.add(answer);
      }
      break;
    }
    case "reading.matching": {
      if (group.paragraphs === null || group.paragraphs.length === 0) {
        issues.push({ path: `${base}.paragraphs`, message: "长篇阅读缺少带标号的段落" });
      }
      if (kinds.some((kind) => kind !== "matching_statement")) {
        issues.push({ path: `${base}.questions`, message: "长篇阅读只能包含 matching_statement 题目" });
      }
      break;
    }
    case "reading.careful_reading": {
      if (group.passage === null) issues.push({ path: `${base}.passage`, message: "仔细阅读缺少文章" });
      if (kinds.some((kind) => kind !== "mcq")) {
        issues.push({ path: `${base}.questions`, message: "仔细阅读只能包含四选一题目" });
      }
      break;
    }
    case "listening.long_conversation":
    case "listening.passage":
    case "listening.talk_report_lecture": {
      if (kinds.some((kind) => kind !== "mcq")) {
        issues.push({ path: `${base}.questions`, message: "听力题组只能包含四选一题目" });
      }
      if (group.transcript === null) {
        warnings.push(`${base}：缺少听力原文（transcript），本组只能按音频训练`);
      }
      break;
    }
  }

  if (group.passage === null && group.paragraphs === null && type !== "listening.long_conversation") {
    for (const question of group.questions) {
      if (question.kind === "mcq" && type.startsWith("listening.")) break;
      if (question.kind === "mcq" && type === "reading.careful_reading") {
        issues.push({ path: `${base}.passage`, message: `第 ${index + 1} 组缺少文章` });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 整卷约束
// ---------------------------------------------------------------------------

function validatePaperLevel(
  manifest: ParsedManifest,
  sections: PaperSection[],
  issues: PaperIssue[],
  warnings: string[],
): void {
  // 1. 大题顺序必须是官方顺序的子序列（保持官方相对次序，允许 partial 缺项）
  const indices = sections.map((section) => OFFICIAL_SECTION_ORDER.indexOf(section.type));
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] <= indices[i - 1]) {
      issues.push({
        path: `sections[${i}].type`,
        message: `大题顺序不符合官方结构：${sections[i].type} 不应出现在 ${sections[i - 1].type} 之后`,
      });
    }
  }

  const sectionTypes = new Set(sections.map((section) => section.type));
  if (sectionTypes.size !== sections.length) {
    const seen = new Set<PaperSectionType>();
    sections.forEach((section, index) => {
      if (seen.has(section.type)) {
        issues.push({ path: `sections[${index}].type`, message: `大题类型重复：${section.type}` });
      }
      seen.add(section.type);
    });
  }

  if (sections.length > 0 && sections[0].type !== "writing" && !manifest.partial) {
    issues.push({ path: "sections[0].type", message: "完整试卷必须从写作开始" });
  }

  // 2. 编号部分的题号必须严格递增，完整卷还必须从 1 连续到官方编号总数（55）。
  //
  // 为什么是 55 而不是 57：源卷存档 PDF 的 KEYS 表只编号听力（1–25）与阅读（26–55）。
  // 写作与翻译是主观作答项，没有题号（见 SECTION_IS_NUMBERED）。
  // 早先按 1–57 施加连续性，等于要求一份**不存在的**编号方式 ——
  // 那会让每一份真实试卷都校验失败。
  //
  // 为什么 partial 包允许缺口：题号是试卷上的官方编号，不是数组下标。
  // 一份真卷若缺听力讲座（第 17–26 题），选词填空仍从第 27 题开始 —— 那是试卷原样。
  const numberedNumbers = sections
    .filter((section) => SECTION_IS_NUMBERED[section.type])
    .flatMap((section) =>
      section.groups.flatMap((group) =>
        group.questions.map((question) => question.number).filter((value): value is number => value !== null),
      ),
    );

  let previousNumber = 0;
  for (const [index, value] of numberedNumbers.entries()) {
    if (value <= previousNumber) {
      issues.push({
        path: `sections[*].groups[*].questions[*].number`,
        message: `题号必须严格递增：第 ${index + 1} 个编号题号 ${value} 出现在 ${previousNumber} 之后`,
      });
    }
    previousNumber = value;
  }

  if (!manifest.partial) {
    if (numberedNumbers.length > 0 && numberedNumbers[0] !== 1) {
      issues.push({ path: "sections", message: `完整试卷的编号必须从第 1 题开始，实际从第 ${numberedNumbers[0]} 题开始` });
    }
    if (numberedNumbers.length !== OFFICIAL_NUMBERED_ITEM_TOTAL) {
      issues.push({
        path: "sections",
        message:
          `完整试卷应有 ${OFFICIAL_NUMBERED_ITEM_TOTAL} 个编号题（听力 25 + 阅读 30），` +
          `实际 ${numberedNumbers.length} 个`,
      });
    }
    if (previousNumber !== OFFICIAL_NUMBERED_ITEM_TOTAL && numberedNumbers.length > 0) {
      issues.push({
        path: "sections",
        message: `编号必须连续到 ${OFFICIAL_NUMBERED_ITEM_TOTAL}，实际到第 ${previousNumber} 题`,
      });
    }
  }

  // 3. 各部分题量必须符合官方值（partial 包降级为提醒）
  for (const [sectionIndex, section] of sections.entries()) {
    const actual = section.groups.reduce((sum, group) => sum + group.questions.length, 0);
    const expected = SECTION_QUESTION_COUNTS[section.type];
    if (actual !== expected) {
      const message = `sections[${sectionIndex}].groups：${section.type} 官方题量为 ${expected}，实际 ${actual}`;
      if (manifest.partial) {
        warnings.push(message);
      } else {
        issues.push({ path: `sections[${sectionIndex}].groups`, message });
      }
    }
  }

  // 4. 来源与核验的语义一致性
  if (manifest.verificationStatus === "verified") {
    if (manifest.partial) {
      issues.push({
        path: "verificationStatus",
        message: "部分内容的试卷不可能已核验：partial 为 true 时不得标记 verified",
      });
    }
    if (manifest.sourceKind !== "real_past_paper") {
      issues.push({
        path: "verificationStatus",
        message: `只有 real_past_paper 才能标记 verified，当前来源为 ${manifest.sourceKind}`,
      });
    }
    if (manifest.provenance.verificationNote === null) {
      issues.push({
        path: "provenance.verificationNote",
        message: "标记 verified 时必须写明核验了什么（verificationNote）",
      });
    }
  }

  if (manifest.sourceKind === "test_fixture" && manifest.verificationStatus !== "unverified") {
    warnings.push("测试夹具不应声称已核验，界面会始终按 test_fixture 标注");
  }

  // 5. 听力必须有音频；缺音频的听力卷子无法训练，必须显式说明
  const listeningSections = sections.filter((section) => section.type.startsWith("listening."));
  if (listeningSections.length > 0 && manifest.assets.filter((asset) => asset.kind === "audio").length === 0) {
    issues.push({ path: "assets", message: "含听力大题的试卷必须提供音频资产" });
  }

  // 6. 完整卷缺大题时的提醒（不阻断，partial 场景由题量校验兜底）
  if (!manifest.partial) {
    for (const type of OFFICIAL_SECTION_ORDER) {
      if (!sectionTypes.has(type)) {
        issues.push({ path: "sections", message: `完整试卷缺少大题：${type}` });
      }
    }
  }

  const numbered = sections.flatMap((section) => section.groups.flatMap((group) => group.questions));
  if (numbered.length === 0) {
    issues.push({ path: "sections", message: "试卷不包含任何题目" });
  }
}
