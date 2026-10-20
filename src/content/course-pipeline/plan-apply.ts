/**
 * 把**人工分段计划**确定性地应用到抽取产物上，产出候选段。
 *
 * ── 这个模块的定位 ──
 *
 * 它是"计划 → 候选段"这条路径的**唯一实现**。自动分段（`segment.ts`）
 * 与它并列：**自动分段仍是默认**，计划是**显式可选输入**。
 *
 *   自动抽取/分组
 *     → 没有计划：走既有 `extractSegmentsForMaterial`（行为**完全不变**）
 *     → 有计划  ：校验计划后，由本模块**确定性**构造段落
 *
 * ── 三条硬约束 ──
 *
 * 1. **确定性。** 同一份（源字节, 计划）必须产出逐字节相同的段。
 *    因此本模块不读时钟、不依赖文件系统枚举顺序、不依赖对象键顺序。
 * 2. **不发明内容。** 段正文全部来自抽取产物的行；计划只提供**结构**。
 * 3. **不写入任何东西。** 纯函数；写盘由 CLI 决定。
 *
 * ── 为什么段 id 也必须是确定性的 ──
 *
 * 段 id 会进入 `course.json`，而 `course.json` 的字节决定 `courseChecksum`。
 * 若 id 里含随机量或时间戳，那么"同一份计划重跑一次"就会产出不同的候选校验和，
 * 复核会被无谓地判成陈旧。因此 id 由 (计划的素材作用域, 序号) 推导。
 *
 * ── 投影**只消费规范解析结构** ──
 *
 * 本模块**不再**自己读 `plan.units[].assignments` 去推坐标。结构来自
 * `resolvePlanContent` 的 `ResolvedPlanContent`：它已经定好
 * "每一行属于哪个单元哪个通道"与"每个通道有哪些范围（按源文档顺序）"。
 *
 * 理由是实测过的缺陷形态：早先的实现让校验、覆盖率、计数、投影
 * **各自推导一遍**计划结构，于是：
 *
 * - 同一个通道的第二条范围被 `find()` 吞掉（覆盖率却报"完整"）；
 * - 同一单元同一通道的重叠被判"幂等"，而投影把重叠行写了两遍。
 *
 * 只有一处推导，才可能保证"每一个被计入覆盖率的范围都真的进了正文"。
 */

import { createHash } from "node:crypto";
import { joinTextLines } from "@/content/pipeline/text-utils";
import { pickStableQuote } from "./pdf-extract";
import { segmentIdOf } from "./segment";
import type {
  ResolvedPlanAssignment,
  ResolvedPlanContent,
  ResolvedPlanUnit,
  SegmentationPlanFile,
} from "./segmentation-plan";
import type {
  ExtractedPage,
  MaterialSegmentation,
  ParsedDocument,
  ProposedSegment,
  SegmentationModeEvidence,
  SourceAnomaly,
} from "./types";

// ---------------------------------------------------------------------------
// 计划里的段 id 作用域
// ---------------------------------------------------------------------------

/**
 * 计划段 id 的作用域前缀。
 *
 * ── 为什么不能直接用材料提案 id ──
 *
 * 自动分段的 id 复用 `segmentIdOf(materialProposalId, ...)`，因为它的段
 * 天然属于某一份材料。人工计划的段也落在某一份材料下（V1 单资产契约），
 * 但它的**作用域**还必须额外绑定"是哪一份计划"：
 *
 * 因此计划用自己的作用域 —— 并且它**必须含计划校验和**：
 *
 * > 人的结构输入一变 ⇒ 计划校验和变 ⇒ **段 id 变** ⇒ `course.json` 变
 * > ⇒ 候选校验和变 ⇒ 已签的复核自动陈旧。
 *
 * 这正是任务书要求的"改变人的结构输入必须改变候选身份"。
 * 若不把校验和放进 id，那么"只把第 3 行挪到另一个单元"这种改动
 * 有可能产出**完全相同**的段 id 集合，从而让旧复核看起来仍然有效。
 */
export function planSegmentScope(planDigest: string): string {
  // 作用域取计划校验和的前 8 位：足够区分，且仍然满足包内 id 的 slug 约束。
  return `p${planDigest.slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// 行寻址
// ---------------------------------------------------------------------------

/**
 * 可寻址的行流。
 *
 * 与 `segment.ts` 的 `LineRef` 同一套坐标（资产键 + 页号 + 页内行号），
 * 但**刻意独立**：计划的分段路径不得依赖自动分段内部结构的稳定性 ——
 * 那会让"改自动分段"意外改变"计划分段"的结果。
 */
interface PlanLine {
  text: string;
  assetKey: string;
  page: number;
  /** 页内行号（1 起，与计划选择器一致）。 */
  line: number;
}

/** 行坐标 → 行文本的索引键（与 `planLineKey` 同一套坐标语义）。 */
function lineIndexKey(assetKey: string, page: number, line: number): string {
  return `${assetKey}\u0000${page}\u0000${line}`;
}

/** 把抽取产物摊平成可寻址的行流（**只含有文本层的页**）。 */
export function collectPlanLines(documents: ParsedDocument[]): PlanLine[] {
  const out: PlanLine[] = [];
  for (const document of [...documents].sort((a, b) => a.assetKey.localeCompare(b.assetKey))) {
    for (const page of document.pages) {
      if (!page.hasTextLayer) continue;
      page.lines.forEach((text, index) => {
        out.push({ text, assetKey: document.assetKey, page: page.page, line: index + 1 });
      });
    }
  }
  return out;
}

/**
 * 取出一组**已解析行坐标**对应的文本行。
 *
 * ── 为什么按坐标查而不是再按范围过滤一遍 ──
 *
 * 行坐标已经在 `resolvePlanContent` 里被核对过（落在页内可寻址范围内），
 * 且每一行只属于**一个**最终归属。这里若再按 `lineStart..lineEnd` 过滤一次，
 * 就出现了第二处坐标推导 —— 而那正是 F2/F3 的根因形态。
 * 因此投影只认 `ResolvedPlanAssignment.lines`。
 */
function resolvedLinesOf(
  index: Map<string, PlanLine>,
  assignments: ResolvedPlanAssignment[],
): PlanLine[] {
  const out: PlanLine[] = [];
  for (const assignment of assignments) {
    for (const ref of assignment.lines) {
      const line = index.get(lineIndexKey(ref.assetKey, ref.page, ref.line));
      if (line !== undefined) out.push(line);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 计划 → 段落
// ---------------------------------------------------------------------------

export interface ApplyPlanInput {
  /** 计划的规范摘要（由 `segmentationPlanDigest` 算好传入，避免两处各算一次）。 */
  planDigest: string;
  /** 计划的**素材作用域**（材料提案 id）。计划段挂在它下面。 */
  materialProposalId: string;
  /** 该材料的解析产物。 */
  documents: ParsedDocument[];
  /**
   * **规范解析结果**（`resolvePlanContent` 的产出）。
   *
   * ── 为什么投影必须消费它、而不是自己再读一遍计划 ──
   *
   * 它是"计划结构 × 抽取产物"的**唯一**交汇点：每一行属于哪个单元哪个通道、
   * 每个通道有哪些范围（含单元标题与类型），都在那里定好了。
   * 投影若自己用 `find()` 或按范围重新过滤，就会产出与校验/计数
   * **不同的**第二份结构推导 —— 实测缺陷正是这样发生的
   * （同一个通道的第二条范围只投影了第一条，而覆盖率与计数都把它算上了）。
   *
   * **必填。** 没有它就无法保证"每一个被计入覆盖率的范围都真的进了投影"。
   */
  resolved: ResolvedPlanContent;
}

export interface ApplyPlanResult {
  segmentation: MaterialSegmentation;
  /** 计划没覆盖到的行数（非 0 时门禁会阻断）。 */
  unassignedLineCount: number;
  /**
   * 投影**实际写进**段落的行数（按通道）。
   *
   * 调用方用它做"投影与计数一致"的后置断言：若某个被计入覆盖率的范围
   * 没有真的进投影，这两个数就会对不上 —— 那必须是一条**能被捕获的**
   * 失败，而不是一个静默的内容缺口。
   */
  projectedLineCounts: {
    source: number;
    referenceTranslation: number;
    notes: number;
  };
}

/**
 * 由一个**已解析**的计划确定性地构造候选段。
 *
 * 前置条件：计划已通过 `validatePlanShape` 与 `resolvePlanContent`
 * （`resolved` 只在没有致命问题时非 null）。本函数**不做**校验 ——
 * 校验需要报出结构化问题，而那属于校验层的职责。
 *
 * ── 投影的两条硬规则 ──
 *
 * 1. **某个通道的每一个范围都必须进正文**，按源文档顺序拼接。
 *    **绝不 `find()`。** 计划允许一个通道有多个范围，用 `find()` 会静默丢掉
 *    第二条之后的内容 —— 而覆盖率还会报"完整"。
 * 2. **不发明内容。** 正文全部来自抽取产物的行；结构来自计划。
 */
export function applySegmentationPlan(input: ApplyPlanInput): ApplyPlanResult {
  const { planDigest, materialProposalId, documents, resolved } = input;
  const lineIndex = new Map<string, PlanLine>();
  for (const line of collectPlanLines(documents)) {
    lineIndex.set(lineIndexKey(line.assetKey, line.page, line.line), line);
  }

  const scope = planSegmentScope(planDigest);
  const pages = documents.flatMap((document) => document.pages);

  const projectedLineCounts = { source: 0, referenceTranslation: 0, notes: 0 };

  const segments: ProposedSegment[] = resolved.units.map((unit, index) =>
    buildSegment(unit, index, scope, lineIndex, pages, materialProposalId, projectedLineCounts),
  );

  return {
    segmentation: {
      materialProposalId,
      // 计划分段**不由文件夹标签决定模块** —— 人是显式给出结构的。
      moduleHint: "translation",
      segments,
      /*
       * `documentLevelOnly: false`：计划**就是**在声明这篇材料有多个单元。
       * 置成 true 会与段数自相矛盾（那个字段的含义是"这份材料只有文档级一段"）。
       */
      documentLevelOnly: false,
      warnings: [],
      anomalies: [],
    },
    unassignedLineCount: resolved.unassigned.length,
    projectedLineCounts,
  };
}

function buildSegment(
  unit: ResolvedPlanUnit,
  index: number,
  scope: string,
  lineIndex: Map<string, PlanLine>,
  pages: ExtractedPage[],
  materialProposalId: string,
  projectedLineCounts: { source: number; referenceTranslation: number; notes: number },
): ProposedSegment {
  const title = unit.title;
  // 通道 → 它的**全部**范围（绝不用 find() 只取第一条）
  const sourceAssignments = unit.assignmentsByChannel.source;
  const referenceAssignments = unit.assignmentsByChannel.reference_translation;
  const notesAssignments = unit.assignmentsByChannel.notes;

  const sourceLines = resolvedLinesOf(lineIndex, sourceAssignments);
  const referenceLines = resolvedLinesOf(lineIndex, referenceAssignments);

  projectedLineCounts.source += sourceLines.length;
  projectedLineCounts.referenceTranslation += referenceLines.length;

  const text = joinTextLines(sourceLines.map((line) => line.text));
  const referenceText =
    referenceLines.length > 0 ? joinTextLines(referenceLines.map((line) => line.text)) : null;

  /*
   * `notes` 的**每一个范围**都拼进去（不是只取第一个）。
   * 空片段被过滤掉，但范围之间的顺序是源文档顺序 —— 逐字节确定。
   */
  const notesParts = notesAssignments
    .map((assignment) => joinTextLines(resolvedLinesOf(lineIndex, [assignment]).map((line) => line.text)))
    .filter((part) => part !== "");
  projectedLineCounts.notes += notesAssignments.reduce((sum, assignment) => sum + assignment.lines.length, 0);

  /*
   * `notes` 的两段内容必须分开：
   *
   * - **人写的语言点**（来自计划的 notes 通道）—— 那是人的结构输入；
   * - **系统加的语义说明** —— 它每段都要有，且措辞固定。
   *
   * 合并成一句会让"人写的部分"与"系统写的部分"再也分不开，
   * 而复核者需要能区分这两者。
   */
  const systemNote =
    referenceText === null
      ? "该单元**没有参考译文范围** —— 有的翻译讲义确实只给语言点，因此这**不**阻断。"
      : "referenceTranslation 来自源件的**课程**译文区块（由人工分段计划指定范围）。" +
        "它是**课程材料**，不是唯一正确译法，也不是官方答案。";

  const notesText = [...notesParts, systemNote].filter((part) => part !== "").join("\n\n");

  // 页码跨度来自**原文范围**（参考译文可能在同一页，也可能不在）
  const fromPage = sourceLines[0]?.page ?? 1;
  const toPage = sourceLines[sourceLines.length - 1]?.page ?? fromPage;

  const assetsInSegment = new Set([...sourceLines, ...referenceLines].map((line) => line.assetKey));
  const representationAssetKey = assetsInSegment.size === 1 ? [...assetsInSegment][0] : null;

  const quote = pickQuoteForLines(sourceLines, pages);

  const anomalies: SourceAnomaly[] = [];

  return {
    id: segmentIdOf(`${scope}:${materialProposalId}`, "translation", index + 1),
    materialProposalId,
    kind: "translation_passage",
    order: index,
    title,
    representationAssetKey,
    anchor: {
      // 页码锚点只在**单一表示**下成立（与自动分段同一条判据）
      pageStart: representationAssetKey === null ? null : fromPage,
      pageEnd: representationAssetKey === null ? null : toPage,
      quote,
    },
    audioAssetKey: null,
    text,
    transcript: null,
    referenceTranslation: referenceText,
    notes: notesText,
    evidence: {
      cues: [
        `人工分段计划：单元「${title}」（计划校验和 ${scope}）`,
        // **每一个**范围都列出来 —— 被计入覆盖率的范围必须在证据里可见
        ...sourceAssignments.map((assignment) => `原文范围 ${describeAssignment(assignment)}`),
        ...(referenceAssignments.length === 0
          ? ["（该单元没有参考译文范围）"]
          : referenceAssignments.map((assignment) => `参考译文范围 ${describeAssignment(assignment)}`)),
        ...notesAssignments.map((assignment) => `讲解范围 ${describeAssignment(assignment)}`),
      ],
      lineSpan: `p${fromPage}–p${toPage}（${sourceLines.length} 行原文${referenceLines.length > 0 ? `，${referenceLines.length} 行参考译文` : ""}）`,
      observedQuestionNumbers: [],
      // 结构完全来自人 —— 不是"只靠文件夹标签"
      folderLabelOnly: false,
    },
    /*
     * `reviewRequired: true` —— **人工计划不减少复核**。
     *
     * 这是任务书最强调的一条：**计划不等于复核。**
     * 人定了结构，仍要有人在生成出来的候选上确认"这确实是我想要的结构"。
     * 因此计划生成的段**照常**要求段裁决（`segment_requires_review`），
     * 门禁照常 `REVIEW_REQUIRED`，`review.json` 照常不存在。
     */
    reviewRequired: true,
    reviewNotes: [
      "该段的**结构**来自人工分段计划（不是自动判据），但计划**不是**复核记录 —— " +
        "请确认生成出来的边界/通道划分确实是你想要的那一份，再签 review.json。",
      ...(referenceText === null ? ["该单元没有参考译文范围。"] : []),
    ],
    anomalies,
  };
}

/** 人可读地描述一条指派（**只含坐标，不含正文**）。 */
function describeAssignment(assignment: ResolvedPlanAssignment): string {
  const { assetKey, page, lineStart, lineEnd } = assignment.range;
  return `${assetKey} p${page}:${lineStart}–${lineEnd}`;
}

/**
 * 为一段挑可核对的引文。
 *
 * 与自动分段同一条纪律：引文必须**真的**出现在该页 `rawText` 里，
 * 核对不上就**不给引文**，而不是给一段看起来像样的假引文。
 */
function pickQuoteForLines(slice: PlanLine[], pages: ExtractedPage[]): string | null {
  for (const line of slice) {
    const trimmed = line.text.trim();
    if (trimmed.length < 12) continue;
    if (!/[\p{L}\p{N}]/u.test(trimmed)) continue;
    const page = pages.find((item) => item.page === line.page);
    if (!page) continue;
    const quote = trimmed.slice(0, 120);
    if (page.rawText.includes(quote)) return quote;
    const squeezed = quote.replace(/\s+/g, " ");
    if (page.rawText.replace(/\s+/g, " ").includes(squeezed)) return quote;
  }
  return pickStableQuote(pages).quote;
}

// ---------------------------------------------------------------------------
// 计划模式的候选证据
// ---------------------------------------------------------------------------

// 类型本身住在 `types.ts`（它是候选元数据的一部分，必须与候选同源）。
// 这里只提供**构造器**与**摘要输入**，避免两处各写一份字段清单。

/** 一段计划的**通道行数**（计数，不含正文）。 */
export interface PlanChannelLineCounts {
  source: number;
  referenceTranslation: number;
  notes: number;
}

/**
 * 校验"投影写出的行数"与"覆盖率计入的行数"**逐通道相等**。
 *
 * ── 为什么它必须是一个独立可测的纯函数（F2/F3 的兜底守卫）──
 *
 * 这两条缺陷之所以能一路走到独立复评，正是因为**没有任何地方比对过**
 * "覆盖率说完整"与"投影真的写了内容"。把这条判据放在内联 `if` 里
 * 会产生一个测试上的死角：只有**同时**破坏投影才可能触发它，
 * 于是"这条守卫有没有用"永远无法被单独立验证（实测确认过：
 * 单独去掉内联断言，任何测试都不会变红）。
 *
 * 抽成纯函数后：
 *
 * - 正常路径上它返回 `null`（没有偏差）；
 * - 任何偏差都返回**可读的**说明，含逐通道的 `实际/应有`；
 * - 变异测试可以**直接**用一对伪造的计数调用它，证明它确实会报错 ——
 *   因此"去掉这条守卫"立刻会被一条测试抓住。
 *
 * 三个通道都要求**恰好相等**：`resolved` 的每一行都来自目标资产
 * （计划只针对它），而目标资产必然属于主材料提案，因此投影一定
 * 能取到那些行。任何差值都是投影漏掉了某个范围。
 */
export function planProjectionMismatch(
  projected: PlanChannelLineCounts,
  counted: PlanChannelLineCounts,
): string | null {
  const channels: [keyof PlanChannelLineCounts, string][] = [
    ["source", "原文"],
    ["referenceTranslation", "参考译文"],
    ["notes", "讲解"],
  ];
  const diffs = channels.filter(([key]) => projected[key] !== counted[key]);
  if (diffs.length === 0) return null;

  return (
    `人工分段计划的投影与覆盖率统计不一致：` +
    diffs.map(([key, label]) => `${label} ${projected[key]}/${counted[key]} 行`).join("、") +
    `。这意味着某个被计入覆盖率的范围**没有进入投影** —— 候选会静默缺内容。` +
    `这是一个**必须修复的流水线缺陷**；工具刻意不产出这份候选。`
  );
}

/** 自动模式的证据（**默认**，与计划无关）。 */
export function automaticSegmentationEvidence(): SegmentationModeEvidence {
  return {
    mode: "automatic",
    planDigest: null,
    planSchemaVersion: null,
    planAuthor: null,
    planCreatedAt: null,
    unitCount: 0,
    channelLineCounts: { source: 0, referenceTranslation: 0, notes: 0, ignoredFurniture: 0 },
    unassignedLineCount: 0,
    unassignedCoordinates: [],
  };
}

/**
 * 计划模式的证据（**聚合计数 + 计划校验和**，绝不含正文与绝对路径）。
 *
 * `unassigned` 里的未指派坐标**只保留前若干条**：它足以让人定位问题，
 * 而让证据文件随未指派行数无限膨胀没有任何收益（完整形态由计划校验和唯一确定）。
 */
export function plannedSegmentationEvidence(
  plan: SegmentationPlanFile,
  planDigest: string,
  lineCounts: { source: number; referenceTranslation: number; notes: number; ignoredFurniture: number },
  unassigned: { assetKey: string; page: number; line: number }[],
): SegmentationModeEvidence {
  return {
    mode: "human_planned",
    planDigest,
    planSchemaVersion: plan.schemaVersion,
    planAuthor: plan.author,
    planCreatedAt: plan.createdAt,
    unitCount: plan.units.length,
    channelLineCounts: lineCounts,
    unassignedLineCount: unassigned.length,
    unassignedCoordinates: unassigned.slice(0, 200),
  };
}

/**
 * 计划证据的**规范摘要**（进入 `segmentationDigest` 的输入）。
 *
 * ── 为什么需要单独一个函数 ──
 *
 * `mode` 与 `planDigest` 必须参与候选身份，否则"把自动结果换成计划结果"
 * 对复核不可见。但 `unassignedCoordinates` 是**诊断细节**
 * （它已经由计划结构唯一确定），纳入摘要只会让"多列几条坐标"这种
 * 纯展示变化无谓地改变候选身份。
 *
 * 因此这里只摘要**决定结构的东西**，其中包括 `unassignedLineCount` ——
 * 从"有未指派"变成"没有"是真实的结构变化。
 */
export function segmentationModeDigest(evidence: SegmentationModeEvidence): string {
  const canonical = {
    mode: evidence.mode,
    planDigest: evidence.planDigest,
    planSchemaVersion: evidence.planSchemaVersion,
    unitCount: evidence.unitCount,
    channelLineCounts: evidence.channelLineCounts,
    unassignedLineCount: evidence.unassignedLineCount,
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}
