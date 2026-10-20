/**
 * 规范内容指纹（canonical content fingerprint）与来源套别标签。
 *
 * ── 要解决的问题 ──
 *
 * 第三方来源用 `Set 1 / Set 2 / Set 3` 标注试卷，但**这些标签不是身份**。
 * 实测：同一份被标为「第一套」的试卷 PDF，其内容与某第三方站点标为
 * 「第二套」的听力答案/文字稿逐题对应，而与同站标为「第一套」的大量不符。
 * 因此：
 *
 * - 跨来源匹配不能靠套别号；
 * - 去重不能靠套别号（两个来源可能用不同编号指同一内容，或反之）；
 * - UI 不能把某个来源的套别号当成事实。
 *
 * ── 指纹的设计 ──
 *
 * 对**印出内容**（primary printed content）的规范投影做 SHA-256。
 * 这是内容身份：两份内容相同、仅来源套别号不同的包，指纹必须相同。
 *
 * **纳入**：写作题目、听力印出选项（按题号顺序、按选项标签顺序）、
 * 选词填空文章与词库、长篇阅读材料与陈述、仔细阅读材料与题干/选项、翻译原文。
 *
 * **排除**（排除项都是"不该影响身份"的东西）：
 * - 来源套别号与 URL（它们是**声明**，不是内容）
 * - 答案（答案可被修正；内容相同就该是同一份试卷）
 * - 第三方口语题干与文字稿（不是主源内容）
 * - 音频校验和、核验说明、包版本、抓取日期
 * - 空白与排版噪声
 *
 * **一个关键取舍**：选项身份用**有序的选项文本**，而不是印出的字母（A/B/C/D）。
 * 理由：实测某题第三项被源件印成 `O)`，经取证修正为 `C` ——
 * 那是**打印标签**的修正，内容没变。若指纹含字母，这次修正会凭空产生一个新身份，
 * 把"同一份试卷的修正版"误报成"另一份试卷"。
 */

import { createHash } from "node:crypto";
import type { ExamPaperContent } from "@/content/paper/types";
import { CJK } from "./text-utils";

/** 指纹算法版本。指纹含义变化时必须递增，否则历史指纹会被重解释。 */
export const FINGERPRINT_ALGORITHM_VERSION = 1;

/**
 * 规范化单段文本用于指纹。
 *
 * 规则（每一项都是为了"同一内容的不同提取产物得到同一指纹"）：
 * - 统一换行、折叠空白（源件的词内插空格伪影不应改变身份）；
 * - 统一撇号字形（`’` → `'`）；
 * - 去除行首的选项字母标记（它们由结构字段承载，不属文本内容的一部分）——
 *   但保留正文内部的字母（例如 `Vitamins`）；
 * - 折叠 CJK 与拉丁之间的空格（中文段落的分行拼接差异不应改变身份）。
 */
export function normalizeForFingerprint(text: string): string {
  return String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/[\u2018\u2019\u02bc\u02b9\u2032]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[ \t\u3000]+/g, " ")
    .replace(/\s*\n\s*/g, " ")
    .trim()
    .toLowerCase();
}

/** CJK 段落与拉丁串之间的空格在提取里不稳定，指纹里按语系折叠。 */
function foldCjkSpacing(text: string): string {
  let out = "";
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === " " && out.length > 0 && index + 1 < text.length) {
      const prev = out[out.length - 1];
      const next = text[index + 1];
      // 任一侧是 CJK 时丢掉这个空格
      if (CJK.test(prev) || CJK.test(next)) continue;
    }
    out += char;
  }
  return out;
}

function segment(text: string): string {
  return foldCjkSpacing(normalizeForFingerprint(text));
}

/**
 * 指纹的规范投影。
 *
 * 返回结构化对象而不是直接拼字符串：这样测试可以断言"哪些内容参与了身份"，
 * 而不必去猜哈希值。
 */
export interface FingerprintProjection {
  algorithmVersion: number;
  writing: string;
  listening: { number: number; options: string[] }[];
  bankedCloze: { passage: string; wordBank: string[]; blanks: string[] };
  matching: { material: string; paragraphs: { label: string; text: string }[]; statements: string[] };
  carefulReading: { material: string; stems: string[]; options: string[][] }[];
  translation: string;
}

export function projectForFingerprint(paper: ExamPaperContent): FingerprintProjection {
  const projection: FingerprintProjection = {
    algorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
    writing: "",
    listening: [],
    bankedCloze: { passage: "", wordBank: [], blanks: [] },
    matching: { material: "", paragraphs: [], statements: [] },
    carefulReading: [],
    translation: "",
  };

  for (const section of paper.sections) {
    if (section.type === "writing") {
      const question = section.groups.flatMap((group) => group.questions).find((item) => item.kind === "writing");
      if (question && question.kind === "writing") {
        // 写作题目与起始句都参与身份；instructions 含词数要求，也纳入
        projection.writing = [segment(question.prompt), segment(question.instructions ?? "")].join(" | ");
      }
      continue;
    }

    if (section.type === "translation") {
      const question = section.groups.flatMap((group) => group.questions).find((item) => item.kind === "translation");
      if (question && question.kind === "translation") projection.translation = segment(question.sourceText);
      continue;
    }

    if (section.type.startsWith("listening.")) {
      for (const group of section.groups) {
        for (const question of group.questions) {
          if (question.kind !== "mcq" || question.number === null) continue;
          // **只用有序的选项文本**，不含印出字母（见文件头说明）。
          //
          // 注意：这里的排序键是 `id`（即印出字母）。这与"身份用文本不用字形"
          // 的意图存在张力 —— 一次 `relabel_option` 修正会改变排序、进而改变指纹。
          // 已记录为**范围外发现**（见 README 的已知限制），
          // **本次不修**：改动排序会改变**所有已导入包**的指纹值，
          // 而本阶段的任务明确要求保持指纹不变、且只修四项。
          const options = [...question.options]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map((option) => segment(option.label));
          projection.listening.push({ number: question.number, options });
        }
      }
      continue;
    }

    if (section.type === "reading.banked_cloze") {
      for (const group of section.groups) {
        projection.bankedCloze = {
          passage: segment(group.passage ?? ""),
          wordBank: (group.wordBank ?? []).map((word) => segment(word)),
          blanks: group.questions
            .filter((question) => question.kind === "banked_cloze_blank")
            .map((question) => (question.kind === "banked_cloze_blank" ? segment(question.answer) : "")),
        };
      }
      continue;
    }

    if (section.type === "reading.matching") {
      for (const group of section.groups) {
        projection.matching = {
          // matching 组的 instructions 承载文章标题
          material: segment(group.instructions ?? ""),
          paragraphs: (group.paragraphs ?? []).map((paragraph) => ({
            label: paragraph.label,
            text: segment(paragraph.text),
          })),
          statements: group.questions
            .filter((question) => question.kind === "matching_statement")
            .map((question) => (question.kind === "matching_statement" ? segment(question.statement) : "")),
        };
      }
      continue;
    }

    if (section.type === "reading.careful_reading") {
      for (const group of section.groups) {
        projection.carefulReading.push({
          material: segment(group.passage ?? ""),
          stems: group.questions
            .filter((question) => question.kind === "mcq")
            .map((question) => (question.kind === "mcq" ? segment(question.stem) : "")),
          options: group.questions
            .filter((question) => question.kind === "mcq")
            .map((question) =>
              // 同 listening：用**位置顺序**，不用 `id`（`id` 是印出字母，
              // 用它会因标签修正而改变身份）。
              question.kind === "mcq" ? question.options.map((option) => segment(option.label)) : [],
            ),
        });
      }
    }
  }

  // 听力按题号排序：检测顺序可能因版面不同而不同，身份不应随之改变
  projection.listening.sort((a, b) => a.number - b.number);

  return projection;
}

/**
 * 计算内容指纹。
 *
 * 用 JSON 的**稳定序列化**（键按固定顺序）后做 SHA-256 ——
 * 不依赖对象键的枚举顺序，因此同一内容在不同进程/不同 V8 版本下结果一致。
 */
export function contentFingerprint(paper: ExamPaperContent): string {
  const projection = projectForFingerprint(paper);
  return createHash("sha256").update(stableStringify(projection)).digest("hex");
}

/**
 * 稳定的 JSON 序列化：对象键按字典序输出。
 *
 * 为什么不用 `JSON.stringify`：它按插入顺序输出键，
 * 而指纹必须是"同一内容在任何环境下都得同一个值"。
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
}

/**
 * 听力印出选项指纹：**只**覆盖 Q1–25 的印出选项。
 *
 * 用途：把第三方文字稿/音频绑定到正确的选项组。
 * 这是"绑定"的证据基础 —— 一个来源必须能证明它对应这组选项，
 * 而"它自称第一套"不是证明。
 */
export function listeningOptionFingerprint(paper: ExamPaperContent): string {
  const projection = projectForFingerprint(paper);
  return createHash("sha256")
    .update(stableStringify({ algorithmVersion: FINGERPRINT_ALGORITHM_VERSION, listening: projection.listening }))
    .digest("hex");
}

/** 听力某一题组的印出选项指纹（按题号区间）。 */
export function listeningGroupFingerprint(paper: ExamPaperContent, from: number, to: number): string {
  const projection = projectForFingerprint(paper);
  const slice = projection.listening.filter((entry) => entry.number >= from && entry.number <= to);
  return createHash("sha256")
    .update(stableStringify({ algorithmVersion: FINGERPRINT_ALGORITHM_VERSION, from, to, options: slice }))
    .digest("hex");
}

/** 短形式，用于日志与 UI（前 12 位足够区分）。 */
export function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 12);
}

/**
 * 候选内容校验和：人工复核将绑定到它。
 *
 * ── 定义只覆盖**候选内容**，不含派生的诊断信息 ──
 *
 * 早先把复核项清单（`review`）也纳入摘要，产生了一个循环依赖：
 * 人工写 `corrections.json` → 复核项被化解 → 清单变化 → 校验和变化 →
 * 刚写的复核记录立刻被判"陈旧"。那样人工永远追不上这个值。
 *
 * 正确的语义是"**内容**校验和"：它只取决于包本身。
 * `paper.json` 已经包含最终内容（含已应用的修正、已绑定的题干），
 * 因此对它取 sha256 就足以表达"这份候选的内容是什么"。
 * 派生诊断（复核项、绑定细节）不参与 —— 它们描述的是内容的问题，不是内容。
 *
 * 放这里而不是脚本里：验证脚本与本模块都要用它，
 * 而测试不应为了算校验和去 import 一个 CLI 入口脚本。
 */
export function candidateContentChecksum(paperJson: string): string {
  return createHash("sha256").update(paperJson).digest("hex");
}
