/**
 * Stage 4 — 候选规范化包生成。
 *
 * 三条硬约束：
 *
 * 1. **候选放在 `private-content/candidates/<paper-id>/`，不在 `cet6/papers/` 下。**
 *    导入器的 `discover()` 只枚举 `cet6/papers/*`，因此候选包**在原理上**
 *    就不可能被导入 —— 这比"记得不要导入"可靠。
 *
 * 2. **候选显式标记为未批准。** `metadata.status = "candidate"`，
 *    且 `humanReview = null`。门禁会因此判 `REVIEW_REQUIRED`。
 *
 * 3. **不生成内容。** 题干来自源件；听力题干来自第三方文字稿（逐项标 provenance）；
 *    范文与译文一律 `null` —— 不生成会污染对真实水平判断的内容。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { ExamPaperContent, PaperAsset, PaperQuestion, PaperSection } from "@/content/paper/types";
import type {
  CandidateMetadata,
  DetectedQuestion,
  DetectedSection,
  EnrichmentRecord,
  ExtractedDocument,
  GateVerdict,
  ReviewItem,
  SourceRegistration,
  StructuralDetection,
} from "./types";
import { CANDIDATE_PIPELINE_VERSION } from "./types";
import { buildFidelityReport, type FidelitySubject } from "./fidelity";
import { extractEntities, findEntityConflicts, entityConflictsToReview } from "./entities";
import { contentFingerprint, FINGERPRINT_ALGORITHM_VERSION } from "./fingerprint";
import { locateSpan, type FieldAlignment } from "./completeness";

/** 把听力口语题干（第三方重建）叠加到检测结果上。 */
export interface ListeningStemSource {
  /** 题号 → 口语题干。 */
  stems: Record<number, string>;
  locator: string;
  provenance: "third_party_transcript";
}

export interface BuildCandidateInput {
  registration: SourceRegistration;
  doc: ExtractedDocument;
  detection: StructuralDetection;
  stems: ListeningStemSource | null;
  /**
   * 试卷包内资产（音频），已复制到候选目录。
   *
   * **格式注意**：这里用的是磁盘包契约里的字段名 `path`，
   * 而内部模型 `PaperAsset` 用的是 `relativePath` —— 两者是不同层次的表示：
   * 前者是 paper.json 的契约（见 `docs/past-paper-package.md` 与校验器），
   * 后者是代码里的语义名。候选生成器负责转换，**不得**在 paper.json 里写 `relativePath`：
   * 那会让包无法通过生产校验器（实测：`assets[0].path: expected string, received undefined`）。
   */
  assets: PaperAsset[];
  /** 主源 PDF 的文本（用于源保真比对）。由调用方从抽取产物重建。 */
  primarySourceText: string;
  /** 候选目录相对路径（仅用于元数据展示）。 */
  candidatePath: string;
  /**
   * 来源侧的套别标签声明（**不是身份**，仅作 provenance 披露）。
   *
   * 实测教训：同一份被标为「第一套」的试卷，其内容与某第三方站点标为
   * 「第二套」的文字稿逐题对应。因此套别号只能作为**声明的记录**，
   * 不能让任何判据依赖它。
   */
  sourceVariantLabels?: { provider: string; claimedLabel: string; locator: string }[];
  /**
   * 候选包的 `contentVersion`。
   *
   * 默认 1（首次导入）。对**已导入包的语义修正**必须显式递增 ——
 * 因为内容变了而版本不变，历史作答会被静默指向另一道题。
   *
   * 刻意不用"每次生成 +1"：那会让迭代解析器把版本号吹大
   * （任务明确禁止 v1→v7 那种膨胀）。版本号是**作者对"这是第几版内容"的声明**，
   * 因此由来源登记显式给出。
   */
  contentVersion?: number;
}

export interface CandidateArtifacts {
  paper: ExamPaperContent;
  metadata: CandidateMetadata;
  /** 未解决的复核项（含实体冲突）。 */
  review: ReviewItem[];
  /** 源保真主题清单（供复核者查看逐字段判定）。 */
  fidelitySubjects: FidelitySubject[];
  /** 主源区间对齐清单（供源完整性判定使用）。 */
  alignments: FieldAlignment[];
}

/** 从抽取产物重建用于源保真比对的连续文本。 */
export function primarySourceTextOf(doc: ExtractedDocument): string {
  return doc.lines
    .map((line) => line.text)
    .join("\n")
    .replace(/[ \t]+/g, " ");
}

export function buildCandidate(input: BuildCandidateInput): CandidateArtifacts {
  const { registration, doc, detection, stems, assets } = input;
  const review: ReviewItem[] = [...detection.review];

  // ── 组 → PaperGroup ──────────────────────────────────────────────────────
  const sections: PaperSection[] = detection.sections.map((section, sectionIndex) => ({
    id: sectionIdOf(section),
    type: section.type,
    order: sectionIndex,
    title: section.title,
    instructions: section.instructions,
    groups: section.groups.map((group, groupIndex) => ({
      id: group.id,
      order: groupIndex,
      instructions: group.instructions,
      audioAssetId: section.type.startsWith("listening.") ? (assets.find((a) => a.kind === "audio")?.id ?? null) : null,
      transcript: null,
      passage: group.passage,
      paragraphs: group.paragraphs,
      wordBank: group.wordBank,
      firstNumber: group.firstNumber,
      questions: group.questions.map((question, questionIndex) =>
        toPaperQuestion(question, questionIndex, section, detection, stems),
      ),
    })),
  }));

  // ── 写作与翻译：用检测到的题面/译面填充 ──────────────────────────────────
  applySubjectiveSections(sections, detection, review);

  // ── 答案：来自源件 KEYS 表 ─────────────────────────────────────────────
  applyAnswers(sections, detection.keys, review);

  // ── 听力题干：第三方重建，逐项登记 provenance ──────────────────────────
  const enrichments: EnrichmentRecord[] = [];
  let thirdPartyStemCount = 0;
  if (stems) {
    for (const section of sections) {
      if (!section.type.startsWith("listening.")) continue;
      for (const group of section.groups) {
        for (const question of group.questions) {
          if (question.kind !== "mcq" || question.number === null) continue;
          const stem = stems.stems[question.number];
          if (stem === undefined) continue;
          question.stem = stem;
          thirdPartyStemCount += 1;
          enrichments.push({
            field: `${section.id}/${group.id}/q${question.number}.stem`,
            provenance: stems.provenance,
            sourceLocator: stems.locator,
            value: stem,
          });
        }
      }
    }
  }

  // 听力题干缺失 → 不能静默放过（源卷不印题干，缺了就无题干可用）
  for (const section of sections) {
    if (!section.type.startsWith("listening.")) continue;
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.kind !== "mcq") continue;
        if (question.stem === null || question.stem.trim() === "") {
          review.push({
            code: "listening_stem_not_in_primary_source",
            severity: "blocking",
            where: `${section.id}/${group.id}/q${question.number}.stem`,
            detail:
              `第 ${question.number} 题的听力口语题干缺失且无法从第三方文字稿补齐。` +
              `源卷不印口语题干，因此不能由主源恢复，也不能由工具猜写。`,
            evidence: null,
          });
        }
      }
    }
  }

  // ── 实体拼写冲突 ───────────────────────────────────────────────────────
  // ── 实体冲突（上下文感知） ──────────────────────────────────────────────
  // 每个实体出现都带**上下文**（哪份材料/哪个题组）。
  // 这是本设计的核心：没有上下文就无法区分"同一人的两种拼写"
  // 与"两个不同的人恰好同名"。
  const entityWhere: { text: string; where: string; context: string }[] = [];
  for (const section of sections) {
    for (const group of section.groups) {
      // 上下文标识：同一份材料/题组内的出现共享它
      const context = `${section.id}/${group.id}`;
      if (group.passage) entityWhere.push({ text: group.passage, where: `${context}.passage`, context });
      if (group.paragraphs) {
        for (const paragraph of group.paragraphs) {
          entityWhere.push({
            text: paragraph.text,
            where: `${context}.paragraphs[${paragraph.label}]`,
            context,
          });
        }
      }
      for (const question of group.questions) {
        const texts: string[] = [];
        if (question.kind === "mcq") {
          texts.push(question.stem ?? "");
          texts.push(...question.options.map((option) => option.label));
        } else if (question.kind === "matching_statement") {
          texts.push(question.statement);
        } else if (question.kind === "writing") {
          texts.push(question.prompt);
        }
        for (const text of texts) {
          if (text) entityWhere.push({ text, where: `${context}/${question.id}`, context });
        }
      }
    }
  }
  const occurrences = entityWhere.flatMap((entry) => extractEntities(entry.text, entry.where, entry.context));
  const conflicts = findEntityConflicts(occurrences);
  review.push(...entityConflictsToReview(conflicts));

  // ── 源保真 ─────────────────────────────────────────────────────────────
  const fidelitySubjects = collectFidelitySubjects(sections, stems?.locator ?? null);
  const fidelity = buildFidelityReport(
    registration.paperId,
    { file: doc.file, sha256: doc.sha256 },
    input.primarySourceText,
    fidelitySubjects,
  );

  if (fidelity.counts.diff > 0) {
    for (const result of fidelity.results.filter((entry) => entry.verdict === "DIFF")) {
      review.push({
        code: "source_checksum_drift",
        severity: "blocking",
        where: result.field,
        detail: `源保真 DIFF：${result.reason}`,
        evidence: result.normalized.slice(0, 240),
      });
    }
  }

  // ── 题目计数（供门禁核对官方题量） ─────────────────────────────────────
  const questionCountsBySection: Record<string, number> = {};
  for (const section of sections) {
    questionCountsBySection[section.type] = section.groups.reduce((sum, group) => sum + group.questions.length, 0);
  }

  const metadataBase = {
    paperId: registration.paperId,
    pipelineVersion: CANDIDATE_PIPELINE_VERSION,
    status: "candidate" as const,
    createdAt: new Date().toISOString().slice(0, 10),
    sourceRegistration: registration,
    extraction: {
      file: doc.file,
      sha256: doc.sha256,
      pages: doc.pages,
      tool: `${doc.tool.name}@${doc.tool.version} (${doc.tool.license})`,
      pagesWithoutTextLayer: doc.pagesWithoutTextLayer,
      geometry: doc.geometry,
    },
    review,
    fidelity,
    // 门禁由调用方在资产校验后求值；此处先放占位，避免生成阶段误判"已通过"
    gate: {
      paperId: registration.paperId,
      status: "REVIEW_REQUIRED" as const,
      checks: [],
      blocking: review.filter((item) => item.severity === "blocking"),
      summary: "门禁尚未求值（候选生成阶段）",
    },
    enrichments,
    keys: detection.keys,
    sourceAnomalies: detection.sourceAnomalies,
    sourceVariantLabels: input.sourceVariantLabels ?? [],
    machine: null,
    listeningBindings: [],
    garbageRemoved: [],
    reviewedCandidateChecksum: null,
    answerVerification: null,
    intentionalTransformations: [],
    humanReview: null,
  };

  void thirdPartyStemCount;
  void input.candidatePath;

  const paper: ExamPaperContent = {
    id: registration.paperId,
    examType: registration.examType,
    year: registration.year,
    session: registration.session,
    variant: registration.variant,
    examDate: registration.expectedExamDate,
    // 候选包**永远**是 real_past_paper + unverified：
    // 它未经人工核验，且"是真题"这件事已由来源登记确认（源件是公开真题 PDF）。
    sourceKind: "real_past_paper",
    verificationStatus: "unverified",
    provenance: {
      note: provenanceNote(registration),
      reference: registration.sources.map((source) => `${source.role}: ${source.locator}`).join(" ; "),
      verificationNote: null,
    },
    // 版本号由来源登记显式给出（默认 1）。
    // 对**已导入包的语义修正**必须递增 —— 内容变了版本不变，
 // 历史作答会被静默指向另一道题。
    contentVersion: input.contentVersion ?? 1,
    partial: false,
    sections,
    assets,
  };

  // 规范内容指纹：在 paper 构造后计算（它是**身份**，与来源套别号无关）
  const candidateFingerprint = contentFingerprint(paper);

  // ── 主源区间对齐（用于源完整性）────────────────────────────────────────
  // 每个声称来自主源的字段都被分配一个**显式的主源区间**（页 + 行范围），
  // 校验在该区间内进行。这样"这段文字在源件别处出现过"不再算通过，
  // 从而能发现截断、错接与重复占用。
  const alignments = buildAlignments(paper, doc);

  const metadata: CandidateMetadata = {
    ...metadataBase,
    contentFingerprint: candidateFingerprint,
    fingerprintAlgorithmVersion: FINGERPRINT_ALGORITHM_VERSION,
  };

  return { paper, metadata, review, fidelitySubjects, alignments };
}

/**
 * 为每个声称来自主源的字段定位其主源区间。
 *
 * 定位失败的字段**仍会进入清单**（span 为 -1），由源完整性判定为缺陷 ——
 * 静默丢弃它们会让"字段根本不在源件里"这件事消失。
 */
function buildAlignments(paper: ExamPaperContent, doc: ExtractedDocument): FieldAlignment[] {
  const alignments: FieldAlignment[] = [];
  const lines = doc.lines;

  const add = (field: string, text: string, kind: FieldAlignment["kind"]): void => {
    if (text.trim() === "") return;
    const span = locateSpan(lines, text);
    if (!span) {
      // 定位失败：用 -1 记录，让完整性地判定为缺陷，而不是假装没有这个字段
      alignments.push({ field, text, span: { page: -1, startLine: -1, endLine: -1 }, kind });
      return;
    }
    // 用起始行的页号作为区间页号
    const page = lines[span.startLine]?.page ?? -1;
    alignments.push({ field, text, span: { page, startLine: span.startLine, endLine: span.endLine }, kind });
  };

  for (const section of paper.sections) {
    for (const group of section.groups) {
      const base = `${section.id}/${group.id}`;
      if (group.passage) add(`${base}.passage`, group.passage, "passage");
      if (section.type === "reading.matching") add(`${base}.instructions`, group.instructions ?? "", "title");
      for (const paragraph of group.paragraphs ?? []) {
        add(`${base}.paragraphs[${paragraph.label}]`, paragraph.text, "paragraph");
      }
      for (const word of group.wordBank ?? []) add(`${base}.wordBank["${word}"]`, word, "wordBank");

      for (const question of group.questions) {
        const questionBase = `${base}/${question.id}`;
        if (question.kind === "mcq") {
          // 听力题干来自第三方，**不属于主源区间** —— 它的绑定由跨来源绑定层负责
          if (!section.type.startsWith("listening.")) add(`${questionBase}.stem`, question.stem, "option");
          for (const option of question.options) add(`${questionBase}.options[${option.id}]`, option.label, "option");
        } else if (question.kind === "writing") {
          add(`${questionBase}.prompt`, question.prompt, "prompt");
        } else if (question.kind === "translation") {
          add(`${questionBase}.sourceText`, question.sourceText, "translation");
        } else if (question.kind === "matching_statement") {
          add(`${questionBase}.statement`, question.statement, "statement");
        }
      }
    }
  }

  return alignments;
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function sectionIdOf(section: DetectedSection): string {
  return section.type.replace(/\./g, "-");
}

/**
 * 从源行回退构造题干时，剥掉行首的题号前缀。
 *
 * 为什么必须有它：`sourceLines` 保存的是**源件原始行**（含 `46. ` 这样的题号，
 * 见 detect.ts 里 `sourceLines: [norm(raw)]`）。当题干没有从标签分段路径
 * 拿到干净文本时（实测仔细阅读的题干走这条回退），题号会被原样带进题干 ——
 * 既污染面向学习者的内容，又让同一份内容在版本之间产生指纹差异。
 *
 * 只剥**行首**的 `N.` / `N．`：题干正文中间的数字（如 `in 2015`）不受影响。
 */
function stemFromSourceLines(sourceLines: string[]): string {
  const joined = sourceLines.join(" ").replace(/\s+/g, " ").trim();
  return joined.replace(/^\s*\d{1,2}\s*[.\uff0e]\s*/, "").trim();
}

function toPaperQuestion(
  question: DetectedQuestion,
  order: number,
  section: DetectedSection,
  detection: StructuralDetection,
  stems: ListeningStemSource | null,
): PaperQuestion {
  const isListening = section.type.startsWith("listening.");

  switch (question.kind) {
    case "mcq":
      return {
        kind: "mcq",
        id: `q${question.number}`,
        number: question.number,
        order,
        explanation: null,
        // 听力题干来自第三方（源卷不印）；此处先留空，稍后由 enrichments 填充
        stem: isListening ? "" : (question.stem ?? stemFromSourceLines(question.sourceLines)),
        options: question.options.map((option) => ({ id: option.printedLabel, label: option.text })),
        answer: "",
      };
    case "banked_cloze_blank":
      return {
        kind: "banked_cloze_blank",
        id: `q${question.number}`,
        number: question.number,
        order,
        explanation: null,
        blankId: question.blankId ?? String(question.number),
        answer: "",
      };
    case "matching_statement":
      return {
        kind: "matching_statement",
        id: `q${question.number}`,
        number: question.number,
        order,
        explanation: null,
        statement: question.statement ?? "",
        answerParagraph: "",
      };
    case "writing": {
      const writing = detection.writing;
      return {
        kind: "writing",
        id: "writing-task",
        number: null,
        order,
        explanation: null,
        prompt: writing.prompt ?? "",
        instructions: writing.instructions,
        referenceEssay: null,
        minWords: writing.minWords,
        maxWords: writing.maxWords,
      };
    }
    case "translation": {
      const translation = detection.translation;
      return {
        kind: "translation",
        id: "translation-task",
        number: null,
        order,
        explanation: null,
        sourceText: translation.sourceText ?? "",
        instructions: translation.instructions,
        referenceTranslation: null,
      };
    }
  }

  void stems;
}

/** 把检测到的写作题面与翻译原文写进对应题目。 */
function applySubjectiveSections(
  sections: PaperSection[],
  detection: StructuralDetection,
  review: ReviewItem[],
): void {
  const writingSection = sections.find((section) => section.type === "writing");
  const translationSection = sections.find((section) => section.type === "translation");

  if (writingSection) {
    const question = writingSection.groups[0]?.questions[0];
    if (question && question.kind === "writing") {
      writingSection.instructions = detection.writing.instructions ?? writingSection.instructions;
      writingSection.groups[0].instructions = detection.writing.instructions ?? writingSection.groups[0].instructions;
      if (!detection.writing.prompt) {
        review.push({
          code: "section_anchor_missing",
          severity: "blocking",
          where: "writing/g1/writing-task.prompt",
          detail: "未能从源件的写作 Directions 中提取到要求句（引号内的起始句）",
          evidence: detection.writing.instructions?.slice(0, 200) ?? null,
        });
      }
    }
  }

  if (translationSection) {
    if (!detection.translation.sourceText) {
      review.push({
        code: "section_anchor_missing",
        severity: "blocking",
        where: "translation/g1/translation-task.sourceText",
        detail: "未能从源件提取到翻译原文（中文段落）",
        evidence: detection.translation.instructions?.slice(0, 200) ?? null,
      });
    }
  }
}

/**
 * 用源件 KEYS 表填充答案。
 *
 * 答案标签必须指向该题**实际存在**的选项 —— 若源件的打印差异使标签对不上
 * （实测 Q54/Q55 第三项印成 `O)`，而 KEYS 给 `C`），此处**不猜**，
 * 而是让检测阶段已产生的 `answer_not_in_options` 阻断项继续拦截。
 */
function applyAnswers(sections: PaperSection[], keys: Record<number, string>, review: ReviewItem[]): void {
  for (const section of sections) {
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.number === null) continue;
        const answer = keys[question.number];
        if (answer === undefined) continue;

        if (question.kind === "mcq") {
          const optionIds = question.options.map((option) => option.id);
          if (optionIds.includes(answer)) {
            question.answer = answer;
          } else {
            // 候选包内保留 KEYS 的原值，但它是无效引用；
            // 检测阶段已登记阻断项，此处只保证候选文件本身可被读取与审阅。
            question.answer = answer;
          }
          continue;
        }

        if (question.kind === "banked_cloze_blank") {
          // 选词填空中 KEYS 给的是词库字母（A–O），包内需要的是**单词**
          const bank = group.wordBank;
          const index = "ABCDEFGHIJKLMNO".indexOf(answer);
          if (bank && index >= 0 && index < bank.length) {
            question.answer = bank[index];
          } else {
            review.push({
              code: "answer_not_in_options",
              severity: "blocking",
              where: `${section.id}/${group.id}/q${question.number}.answer`,
              detail: `选词填空第 ${question.number} 题：KEYS 给出 ${answer}，但无法映射到词库（词库 ${bank?.length ?? 0} 项）`,
              evidence: null,
            });
          }
          continue;
        }

        if (question.kind === "matching_statement") {
          question.answerParagraph = answer;
        }
      }
    }
  }
}

/** 源保真比对的主题：只纳入**声称来自主源**的文本。 */
function collectFidelitySubjects(sections: PaperSection[], thirdPartyLocator: string | null): FidelitySubject[] {
  const subjects: FidelitySubject[] = [];

  for (const section of sections) {
    const isListening = section.type.startsWith("listening.");
    for (const group of section.groups) {
      if (group.passage) {
        subjects.push({
          field: `sections[${section.id}].groups[${group.id}].passage`,
          text: group.passage,
          origin: "primary",
        });
      }
      if (group.paragraphs) {
        for (const paragraph of group.paragraphs) {
          subjects.push({
            field: `sections[${section.id}].groups[${group.id}].paragraphs[${paragraph.label}]`,
            text: paragraph.text,
            origin: "primary",
          });
        }
      }
      if (group.wordBank) {
        for (const word of group.wordBank) {
          subjects.push({
            field: `sections[${section.id}].groups[${group.id}].wordBank["${word}"]`,
            text: word,
            origin: "primary",
          });
        }
      }
      if (section.type === "reading.matching" && group.instructions) {
        subjects.push({
          field: `sections[${section.id}].groups[${group.id}].instructions[title]`,
          text: group.instructions,
          origin: "primary",
        });
      }

      for (const question of group.questions) {
        const base = `sections[${section.id}].groups[${group.id}].questions[${question.id}]`;
        if (question.kind === "writing") {
          subjects.push({ field: `${base}.prompt`, text: question.prompt, origin: "primary" });
        } else if (question.kind === "translation") {
          subjects.push({ field: `${base}.sourceText`, text: question.sourceText, origin: "primary" });
        } else if (question.kind === "matching_statement") {
          subjects.push({ field: `${base}.statement`, text: question.statement, origin: "primary" });
        } else if (question.kind === "mcq") {
          for (const option of question.options) {
            subjects.push({ field: `${base}.options[${option.id}]`, text: option.label, origin: "primary" });
          }
          // 听力题干不在源卷中（源卷只印选项）
          subjects.push({
            field: `${base}.stem`,
            text: question.stem,
            origin: isListening ? "third_party" : "primary",
          });
        }
      }
    }
  }

  void thirdPartyLocator;
  return subjects;
}

function provenanceNote(registration: SourceRegistration): string {
  const primary = registration.sources.find((source) => source.role === "primary_paper_pdf");
  const audio = registration.sources.find((source) => source.role === "listening_audio");
  const secondary = registration.sources.filter((source) => source.role === "secondary_reference");

  const parts = [
    `${registration.year} 年 ${registration.session === "June" ? "6" : registration.session === "December" ? "12" : "9"} 月 ` +
      `CET-6（${registration.variant}）半自动导入。`,
    `试卷正文（题干、选项、文章、写作与翻译题目）取自**主源存档 PDF**：${primary?.locator ?? "（未登记）"}。`,
    audio ? `听力音频取自：${audio.locator}。` : "未提供听力音频。",
  ];

  if (secondary.length > 0) {
    parts.push(
      `交叉核对与听力口语题干重建使用第三方来源（**非主源、非官方**）：` +
        secondary.map((source) => `${source.description} ${source.locator}`).join("；") +
        `。`,
    );
  }

  parts.push(
    "听力 Q1–Q25 的**口语题干**不在主源 PDF 中（源卷只印选项），由第三方文字稿重建；" +
      "逐项来源见包的 enrichments 记录。",
  );
  parts.push(
    "答案取自**主源存档 PDF 末页的 KEYS 表**——该表位于第三方存档 PDF 中，" +
      "**不是**教育部教育考试院官方发布的答案。",
  );

  return parts.join("");
}

/** 计算文件 sha256（候选目录内的资产校验用）。 */
export function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/**
 * 把内存中的试卷模型序列化为 `paper.json` 的**磁盘契约**。
 *
 * 为什么必须有这一层转换：内存模型 `PaperAsset` 用 `relativePath`（代码里的语义名），
 * 而磁盘契约用 `path`（见 `docs/past-paper-package.md` 与 `validator.ts`）。
 * 直接 `JSON.stringify(paper)` 会写出 `relativePath`，导致包**无法通过生产校验器** ——
 * 实测报错：`assets[0].path: expected string, received undefined`。
 *
 * 转换只做字段改名，不做任何内容改写；导入器读回时会把 `path` 再转成 `relativePath`。
 */
export function toManifestJson(paper: ExamPaperContent): unknown {
  return {
    id: paper.id,
    examType: paper.examType,
    year: paper.year,
    session: paper.session,
    variant: paper.variant,
    examDate: paper.examDate,
    sourceKind: paper.sourceKind,
    verificationStatus: paper.verificationStatus,
    provenance: {
      note: paper.provenance.note,
      reference: paper.provenance.reference,
      verificationNote: paper.provenance.verificationNote,
    },
    contentVersion: paper.contentVersion,
    partial: paper.partial,
    sections: paper.sections,
    assets: paper.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      path: asset.relativePath,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      checksum: asset.checksum,
      label: asset.label,
    })),
  };
}

/** 候选包的元数据文件名。与 paper.json 分开，二者一同构成候选包。 */
export const CANDIDATE_METADATA_FILENAME = "candidate.json";

/** 规范化审计模板文件名（写入 private-content/audit/）。 */
export function auditTemplateFilename(paperId: string): string {
  return `${paperId}-normalization.md`;
}

/** 生成规范化审计模板。**只填空缺骨架，不含任何未经验证的结论。** */
export function renderAuditTemplate(metadata: CandidateMetadata): string {
  const lines: string[] = [];
  lines.push(`# ${metadata.paperId} · 规范化审计记录`);
  lines.push("");
  lines.push("本文件逐条登记从**主源 PDF** 到**规范化包**之间的每一处有意改动。");
  lines.push("位于 `private-content/`（gitignored），不随代码分发。");
  lines.push("");
  lines.push(`- 流水线版本：v${metadata.pipelineVersion}`);
  lines.push(`- 候选生成日期：${metadata.createdAt}`);
  lines.push(`- 提取工具：${metadata.extraction.tool}`);
  lines.push(`- 主源 PDF：${metadata.extraction.file}`);
  lines.push(`- 主源 sha256：\`${metadata.extraction.sha256}\``);
  lines.push(`- 页数：${metadata.extraction.pages}`);
  lines.push(`- 无文本层的页：${metadata.extraction.pagesWithoutTextLayer.length === 0 ? "无" : metadata.extraction.pagesWithoutTextLayer.join(", ")}`);
  lines.push(`- 版面几何：正文左边界 ${metadata.extraction.geometry.margin}pt，段落缩进 ${metadata.extraction.geometry.indent}pt`);
  lines.push("");
  lines.push("## 一、来源登记");
  lines.push("");
  lines.push("| 角色 | 来源 | 定位符 | 抓取日期 | 字节 | sha256 | 文本层 |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const source of metadata.sourceRegistration.sources) {
    lines.push(
      `| ${source.role} | ${source.description} | ${source.locator} | ${source.retrievedAt} | ${
        source.bytes ?? "-"
      } | ${source.sha256 ? `${source.sha256.slice(0, 16)}…` : "-"} | ${source.textLayer} |`,
    );
  }
  lines.push("");
  lines.push("## 二、有意的规范化（逐条登记）");
  lines.push("");
  lines.push("**规则**：每一处与主源的语义偏离，要么被证明是有意的并登记在此，要么按缺陷处理。禁止静默的语义修正。");
  lines.push("");
  lines.push("以下是本流水线**必然产生**的规范化。复核者需逐条确认其确为有意，并补充任何本工具未预见的改动。");
  lines.push("");
  lines.push("| # | 位置 | 主源形式 | 包内形式 | 理由 | 证据 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  lines.push(
    "| 1 | 选词填空文章 | 空位写作 `___26___` | 写作 `[26]` | 与既有参考包格式一致，便于渲染定位空位 | 校验器要求 passage 含 `[blankId]` 标记 |",
  );
  lines.push(
    "| 2 | 全文文本 | PDF 按视觉行切分，行尾无空格 | 按语系补空格（英文断行补、中文断行不补） | PDF 提取产物不是原文；不补空格会把英文单词粘连 | 实测中文断行补空格会污染原文（2025-06 翻译） |",
  );
  lines.push(
    "| 3 | 四选一选项顺序 | 源件双栏排版，阅读顺序可能是 A/C/B/D | 按标签 A/B/C/D 排序 | 包的消费者按标签定位选项，与视觉顺序无关 | 实测 2024-06 多题为 A/C/B/D 阅读顺序 |",
  );
  lines.push(
    "| 4 | 仔细阅读组 instructions | 源件分印 `Passage One` 与 `Questions 46 to 50 …` 两行 | 合并为 `Passage One · Questions 46 to 50 …` | 与既有参考包一致，单字段承载两行信息 | 参考包 `careful#g1.instructions` |",
  );
  lines.push(
    "| 5 | 长篇阅读组 instructions | 源件把文章标题单独居中印出 | 标题写入 `instructions`，段落正文不含标题 | 与既有参考包一致（matching 组 instructions 即标题） | 参考包 `matching#g1.instructions` |",
  );
  lines.push("");
  lines.push("### 人工裁决驱动的修正（逐条含证据）");
  lines.push("");
  lines.push(
    "复核者不直接编辑 `paper.json`，而是在候选目录写 `corrections.json`；" +
      "流水线应用它并在此逐条登记。**这是修正唯一被允许的入口** —— " +
      "手工改 JSON 会让改动消失在没有痕迹的地方。",
  );
  lines.push("");
  if (metadata.intentionalTransformations.length === 0) {
    lines.push("（无。本卷未申报任何人工修正。）");
  } else {
    lines.push("| # | 位置 | 修正前 | 修正后 | 理由 | 证据 | 复核者 |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    metadata.intentionalTransformations.forEach((transform, index) => {
      lines.push(
        `| ${index + 1} | \`${transform.where}\` | ${transform.from} | ${transform.to} | ${transform.reason} | ${transform.evidence.replace(/\|/g, "\\|")} | ${transform.reviewer}（${transform.reviewedAt}） |`,
      );
    });
  }
  lines.push("");
  lines.push("## 三、源保真核对结果");
  lines.push("");
  lines.push(`- 通过：${metadata.fidelity.counts.pass}`);
  lines.push(`- DIFF：${metadata.fidelity.counts.diff}`);
  lines.push(`- 无法比对（第三方来源）：${metadata.fidelity.counts.unverifiable}`);
  lines.push("");
  if (metadata.fidelity.counts.diff > 0) {
    lines.push("**存在的 DIFF（必须逐条处理）**：");
    lines.push("");
    for (const result of metadata.fidelity.results.filter((entry) => entry.verdict === "DIFF")) {
      lines.push(`- \`${result.field}\`：${result.reason}`);
    }
    lines.push("");
  }
  lines.push("## 四、第三方富集（逐项披露）");
  lines.push("");
  lines.push("**这些内容不是主源内容。** 主源 PDF 只印听力选项，不印口语题干。");
  lines.push("");
  if (metadata.enrichments.length === 0) {
    lines.push("（无）");
  } else {
    lines.push("| 字段 | 来源层级 | 来源定位符 |");
    lines.push("| --- | --- | --- |");
    for (const enrichment of metadata.enrichments) {
      lines.push(`| \`${enrichment.field}\` | ${enrichment.provenance} | ${enrichment.sourceLocator} |`);
    }
  }
  lines.push("");
  lines.push("## 五、源件自身的异常（原样保留，未改写）");
  lines.push("");
  if (metadata.sourceAnomalies.length === 0) {
    lines.push("（未检出）");
  } else {
    for (const anomaly of metadata.sourceAnomalies) lines.push(`- ${anomaly}`);
  }
  lines.push("");
  lines.push(
    "> **重新调查过的过往结论、第三方来源缺失题的处置、以及 Q19 这类" +
      "「标点差异 vs 语义截断」的判定，属于人的调查结论，记在同目录的 " +
      "`<paper-id>-PROVENANCE.md`（人工撰写，工具不改写）。**",
  );
  lines.push("");
  lines.push("## 六、未解决的歧义（REVIEW_REQUIRED）");
  lines.push("");
  const blocking = metadata.review.filter((item) => item.severity === "blocking");
  if (blocking.length === 0) {
    lines.push("（无）");
  } else {
    lines.push("| # | 代码 | 位置 | 说明 | 证据 |");
    lines.push("| --- | --- | --- | --- | --- |");
    blocking.forEach((item, index) => {
      lines.push(
        `| ${index + 1} | \`${item.code}\` | \`${item.where}\` | ${item.detail} | ${(item.evidence ?? "-").replace(/\|/g, "\\|").slice(0, 300)} |`,
      );
    });
  }
  lines.push("");
  lines.push("## 七、人工裁决记录（工具不代填，但**已完成**的裁决必须在此出现）");
  lines.push("");
  lines.push("> 每个阻断项都必须在这里出现，并给出**外部证据**。");
  lines.push("> 工具不替人做决定；但它**必须如实转录**人已经做出的决定 ——");
  lines.push("> 若这里仍是「（待填）」而门禁已判 IMPORTABLE，两者互相矛盾。");
  lines.push("");
  lines.push("| 代码 | 位置 | 裁决 | 证据 |");
  lines.push("| --- | --- | --- | --- |");
  const resolutions = metadata.humanReview?.resolutions ?? [];
  for (const item of blocking) {
    const applied = resolutions.find((entry) => entry.code === item.code && entry.where === item.where);
    if (applied) {
      lines.push(
        `| \`${item.code}\` | \`${item.where}\` | ${applied.resolution.replace(/\|/g, "\\|")} | ${applied.evidence.replace(/\|/g, "\\|")} |`,
      );
    } else {
      lines.push(`| \`${item.code}\` | \`${item.where}\` | （尚未裁决） | （尚未裁决） |`);
    }
  }
  if (blocking.length === 0) lines.push("| — | — | 无阻断项 | — |");
  lines.push("");
  if (metadata.humanReview !== null) {
    lines.push(
      `复核者：${metadata.humanReview.reviewer}（${metadata.humanReview.reviewedAt}）；` +
        `绑定候选校验和：${metadata.reviewedCandidateChecksum ? `\`${metadata.reviewedCandidateChecksum.slice(0, 16)}…\`` : "**未绑定**"}`,
    );
  } else {
    lines.push("复核：**尚未完成**（无 `review.json`）。");
  }
  lines.push("");
  lines.push("## 八、内容身份（规范指纹）");
  lines.push("");
  lines.push(`- 算法版本：v${metadata.fingerprintAlgorithmVersion}`);
  lines.push(`- 内容指纹：\`${metadata.contentFingerprint}\``);
  lines.push("");
  lines.push(
    "指纹只覆盖**印出内容**（写作题面、听力印出选项文本、选词填空、匹配材料与陈述、" +
      "仔细阅读材料与题干、翻译原文）。**不含**来源与 URL、套别号、答案、第三方口语题干、" +
      "听力原文、音频校验和、验证说明、版本号。",
  );
  lines.push("");
  lines.push("因此：**套别号不是身份，指纹才是。** 同一份内容被不同站点标为不同套别时，指纹相同；");
  lines.push("内容不同而套别号相同时，指纹不同。");
  lines.push("");
  lines.push("## 九、跨来源绑定（逐题组）");
  lines.push("");
  lines.push("**判据是内容族覆盖度（≥10 字母判别性术语的命中比例），套别号不参与判定。**");
  lines.push("");
  if (metadata.listeningBindings.length === 0) {
    lines.push("（本卷未提供第三方听力富集，无条件绑定）");
  } else {
    lines.push("| 题组 | 结论 | 证据类型 | 来源 | 主源选项指纹 |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const binding of metadata.listeningBindings) {
      lines.push(
        `| Q${binding.from}–${binding.to} | ${binding.bound ? "已绑定" : "**未绑定**"} | \`${binding.evidenceKind}\` | ${
          binding.locator
        }${binding.providerSetLabel ? `（自称：${binding.providerSetLabel}）` : ""} | \`${binding.primaryFingerprint.slice(0, 16)}…\` |`,
      );
    }
    lines.push("");
    for (const binding of metadata.listeningBindings) {
      lines.push(`- Q${binding.from}–${binding.to}：${binding.evidenceDetail}`);
    }
  }
  lines.push("");
  lines.push("## 十、题干洁净（抓取噪声剔除记录）");
  lines.push("");
  if (metadata.garbageRemoved.length === 0) {
    lines.push("（未检出需要剔除的噪声）");
  } else {
    lines.push("以下内容在题干装配前被识别为**站点 UI / 隐藏元素噪声**并剔除，不占用真实题号：");
    lines.push("");
    for (const item of metadata.garbageRemoved) {
      lines.push(`- Q${item.number}：\`${item.text.replace(/`/g, "'").slice(0, 120)}\``);
    }
  }
  lines.push("");
  lines.push("## 十一、答案来源强度");
  lines.push("");
  lines.push("| 项 | 说明 |");
  lines.push("| --- | --- |");
  lines.push("| 取值来源 | 主源存档 PDF 末页 KEYS 表 |");
  lines.push("| 是否官方 | **否**。该表位于第三方存档 PDF 中，不是教育部教育考试院发布的答案 |");
  const verification = metadata.answerVerification;
  if (verification === null) {
    lines.push("| 独立来源 | （未做跨来源比对） |");
  } else {
    lines.push(
      `| 证据强度 | \`${verification.level}\`（比对 ${verification.comparing} 题，一致 ${verification.agreeing}，分歧 ${verification.conflicts.length}） |`,
    );
    lines.push(`| 独立来源 | ${verification.sources.map((source) => source.locator).join("；") || "无"} |`);
    if (verification.evidenceMatrix.length > 0) {
      lines.push("");
      lines.push("**逐题证据矩阵**（关注题号的每个来源取值与选项文本）：");
      lines.push("");
      for (const entry of verification.evidenceMatrix) {
        lines.push(`- 第 ${entry.number} 题（${entry.outcome === "agree" ? "各来源一致" : entry.outcome === "disagree" ? "**存在分歧**" : "单一来源"}）`);
        for (const row of entry.rows) {
          if (row.value === null) continue;
          lines.push(`    - ${row.value}${row.text ? ` — ${row.text.slice(0, 80)}` : ""} ← ${row.source}`);
        }
      }
    }
  }
  lines.push("");
  lines.push("## 十二、听力来源区分");
  lines.push("");
  lines.push("| 内容 | 来源 |");
  lines.push("| --- | --- |");
  lines.push("| 听力音频 | 主源来源站的整卷录音（未切分、未重编码） |");
  lines.push("| 听力选项 | 主源 PDF |");
  lines.push("| 听力口语题干 | **第三方文字稿重建**（源卷不印）；每个题组都必须通过内容绑定 |");
  lines.push("| 听力字幕/文字稿 | 见 enrichments（若提供） |");
  lines.push("");

  return lines.join("\n");
}

/** 供门禁与复核输出使用：把门禁结果附回元数据。 */
export function attachGate(metadata: CandidateMetadata, gate: GateVerdict): CandidateMetadata {
  return { ...metadata, gate };
}
