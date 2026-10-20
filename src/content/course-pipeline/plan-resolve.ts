/**
 * 把"原始计划文本 + 当前抽取产物"解析为**一次结构决策**。
 *
 * ── 为什么单独成模块 ──
 *
 * `index.ts` 的职责是编排六个阶段；而"计划能不能用"包含
 * 解析、绑定校验、选择器校验、覆盖率校验与主材料选择五件事。
 * 把它们塞进编排函数会让那一段变成无法单独核对的黑盒。
 *
 * ── 它守的核心语义：**绝静默回退** ──
 *
 * 计划校验失败时返回 `applied: false` 且带**结构化问题清单**，
 * 调用方据此生成**阻断级**复核事项。
 *
 * 刻意**不**提供"校验失败就当作没传计划"的便捷路径 ——
 * 那会让操作者以为自己的结构生效了，而实际跑的是自动判据。
 * 一份有问题的计划必须是**可见的失败**，不是**无声的忽略**。
 */

import {
  isFatalPlanValidationCode,
  parseSegmentationPlan,
  resolvePlanContent,
  segmentationPlanDigest,
} from "./segmentation-plan";
import type {
  PlanContentResolution,
  PlanSourceView,
  PlanValidationIssue,
  ResolvedPlanContent,
  SegmentationPlanFile,
} from "./segmentation-plan";
import type { MaterialGroupingResult, ParsedDocument, SourceInventory } from "./types";

/** 分段计划解析/校验的完整结论。 */
export interface ResolvedSegmentationPlan {
  /** 计划是否可以**真的**用来构造段落。 */
  applied: boolean;
  /** 计划（仅当它至少通过了形状与内容校验）。 */
  plan: SegmentationPlanFile | null;
  /** 计划校验和（仅当 `applied`）。 */
  planDigest: string | null;
  /** 校验问题（形状层 + 内容层 + 挂载层）。非空 ⇒ 至少有一条问题。 */
  issues: PlanValidationIssue[];
  /**
   * **非致命**的覆盖缺口（只有 `plan_unassigned_content`）。
   *
   * 它**不**阻止计划被采用（人看到的结构仍然是自己标的那一份），
   * 但会变成一条**阻断级**复核事项 ⇒ 门禁不可能 PROMOTABLE。
   *
   * 与 `issues` 分开是为了让调用方能如实区分"计划作废了"与
   * "计划生效了，但有内容没被接住"—— 两者的操作者动作完全不同。
   */
  coverageIssues: PlanValidationIssue[];
  /** 计划应当挂载到哪一份材料提案（`applied` 时非 null）。 */
  primaryMaterialId: string | null;
  /**
   * 计划针对的**唯一**表示资产（V1 单资产契约）。
   *
   * `applied` 时非 null。它是覆盖率的判据范围，也参与计划绑定。
   */
  targetAssetKey: string | null;
  /**
   * **规范解析结果** —— 投影与计数的唯一输入。
   *
   * `applied` 时非 null。计划一旦被采用，结构就**只**以它为准；
   * 投影不得自己再读一遍计划（那会产出第二份、可能不同的结构推导）。
   */
  resolved: ResolvedPlanContent | null;
  /** 计划引用的资产键（审计与主材料选择用）。 */
  referencedAssetKeys: string[];
  /** 各类通道覆盖的行数（**从 `resolved` 派生**）。 */
  channelLineCounts: {
    source: number;
    referenceTranslation: number;
    notes: number;
    ignoredFurniture: number;
  };
  /** 未指派的内容行。 */
  unassigned: { assetKey: string; page: number; line: number }[];
}

/** 未提供计划时的结论（**默认路径**）。 */
function noPlan(): ResolvedSegmentationPlan {
  return {
    applied: false,
    plan: null,
    planDigest: null,
    issues: [],
    coverageIssues: [],
    primaryMaterialId: null,
    targetAssetKey: null,
    resolved: null,
    referencedAssetKeys: [],
    channelLineCounts: { source: 0, referenceTranslation: 0, notes: 0, ignoredFurniture: 0 },
    unassigned: [],
  };
}

/**
 * 从抽取产物构造**源件视图**（计划校验所需的最小投影）。
 *
 * ── 隐私边界：这里**只有行数，没有正文** ──
 *
 * `PlanSourceView` 只记录"某一页有多少行可寻址"。计划校验的全部判据
 * （绑定、越界、重叠、覆盖率）都只需要行数与坐标，**不需要**读到那些行是什么。
 *
 * 因此本函数刻意**不**传出任何 `lines[]` 文本。这让"计划校验"这条链路
 * 在结构上不可能成为正文泄漏点，也让自动化侧只能看到计数与坐标。
 */
export function buildPlanSourceView(input: {
  courseId: string;
  inventory: SourceInventory;
  documents: ParsedDocument[];
}): PlanSourceView {
  const assets = new Map<string, { sha256: string; lineCountByPage: Map<number, number>; pagesWithoutTextLayer: number[] }>();

  for (const asset of input.inventory.assets) {
    const document = input.documents.find((doc) => doc.assetKey === asset.assetKey);
    const lineCountByPage = new Map<number, number>();
    const pagesWithoutTextLayer: number[] = [];

    if (document !== undefined) {
      for (const page of document.pages) {
        // **无文本层的页是"不可寻址"，不是"0 行"** —— 这两者必须区分：
        // 前者要人去看源件，后者是真正的空页。因此不写进 lineCountByPage。
        if (!page.hasTextLayer) {
          pagesWithoutTextLayer.push(page.page);
          continue;
        }
        lineCountByPage.set(page.page, page.lines.length);
      }
    }

    assets.set(asset.assetKey, { sha256: asset.sha256, lineCountByPage, pagesWithoutTextLayer });
  }

  return { courseId: input.courseId, sourceDigest: input.inventory.digest, assets };
}

/**
 * 选出一份计划应当挂载的**主材料**。
 *
 * ── V1 单资产契约 ──
 *
 * 计划**只针对一份表示资产**（`resolvePlanContent` 已强制），
 * 因此这里的判据是：**哪一份材料提案含有那个资产**。
 * 由于分组不变量保证"一个文件恰好属于一份材料"，答案是唯一的 ——
 * 不存在"按引用数打分"的必要（那套计分只在跨资产时才有意义，
 * 而跨资产在 V1 是被显式拒绝的）。
 *
 * ── 为什么要显式判"没有材料提案包含它" ──
 *
 * 若那份资产没有被任何提案接纳（分组异常），计划就无处可挂。
 * 那必须**失败关闭**，而不是把段挂到随便一份材料上。
 */
export function pickPrimaryMaterialForPlan(
  grouping: MaterialGroupingResult,
  targetAssetKey: string,
): string | null {
  const matches = [...grouping.proposals]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((proposal) => proposal.representations.some((representation) => representation.assetKey === targetAssetKey));

  if (matches.length === 0) return null;
  /*
   * 多于一份提案包含同一资产 ⇒ 分组不变量已被违反（那本身是一条
   * 阻断级事项，由分组层单独报出）。这里仍然给出**确定性的**答案
   * （按 id 升序取第一份），以免"选哪一份材料"变成不确定的行为。
   */
  return matches[0]!.id;
}

/** 计划引用的全部资产键（确定性排序）。 */
function referencedAssetKeysOf(plan: SegmentationPlanFile): string[] {
  const keys = new Set<string>();
  for (const unit of plan.units) {
    for (const assignment of unit.assignments) keys.add(assignment.range.assetKey);
  }
  return [...keys].sort();
}

/**
 * 解析并校验计划，产出一个**明确的**结构决策。
 *
 * 校验顺序刻意如此（与门禁同一条推理）：
 * **先判"这份计划是不是针对当前源写的"，再判"计划内部自不自洽"。**
 * 顺序反了的话，一份**陈旧**的计划会在一堆"行号越界"里被淹没，
 * 而真正的原因（源变了）反而看不见。
 */
export function resolveSegmentationPlan(input: {
  input: { raw: string } | undefined;
  courseId: string;
  inventory: SourceInventory;
  documents: ParsedDocument[];
  grouping: MaterialGroupingResult;
}): ResolvedSegmentationPlan {
  if (input.input === undefined) return noPlan();

  // ── 1) 解析（坏 JSON 是正常失败状态，不是崩溃）──
  const parsed = parseSegmentationPlan(input.input.raw);
  if (!parsed.ok || parsed.plan === null) {
    return { ...noPlan(), issues: parsed.issues };
  }
  const plan = parsed.plan;

  // ── 2) 内容层解析（**唯一实现**：绑定 → 单资产 → 越界 → 重叠 → 覆盖率 → 计数）──
  const view = buildPlanSourceView({
    courseId: input.courseId,
    inventory: input.inventory,
    documents: input.documents,
  });
  const content: PlanContentResolution = resolvePlanContent(plan, view);

  const referencedAssetKeys = referencedAssetKeysOf(plan);

  /*
   * ── 两类问题必须分开（这是本任务覆盖率语义的落点）──
   *
   * | 类别 | 例 | 计划是否被采用 | 后果 |
   * | --- | --- | --- | --- |
   * | **致命** | 绑定陈旧 / 越界 / **任何**重叠 / 多资产 | **不采用**（失败关闭）| 回退自动分段 + 阻断事项 |
   * | **覆盖缺口** | 有内容行没被任何通道接住 | **采用** | 按计划产段 + 阻断事项 |
   *
   * 为什么覆盖缺口**不**阻止采用计划：
   *
   * - 任务书的语义是"未指派内容必须**可见**并且**阻断**候选验收"，
   *   **不是**"整份计划作废"。若这里回退到自动分段，人看到的候选结构
   *   就**不是**他自己标的那一份了 —— 他会以为自己的结构生效了，
   *   而实际跑的是自动判据，那正是我们要避免的静默分叉。
   * - 按计划产段 + 一条阻断事项，人能在**自己的结构**上看到那个缺口在哪，
   *   补起来也直接（改计划 → 重新生成候选）。
   *
   * 致命问题则相反：坐标本身在这份源上无意义（陈旧/越界），
   * 或者计划的结构对系统而言有歧义（重叠/多资产）——
   * 强行按它产段会产出一份**看起来正常、实则错位或重复**的结构。
   *
   * 分类的**唯一实现**在 `segmentation-plan.ts`（与错误码同处一地）；
   * 这里刻意不维护第二份清单 —— 两份必然漂移。
   */
  const fatalIssues = content.issues.filter((issue) => isFatalPlanValidationCode(issue.code));
  const coverageIssues = content.issues.filter((issue) => !isFatalPlanValidationCode(issue.code));

  const issues: PlanValidationIssue[] = [...content.issues];

  /*
   * ── 3) 挂载：计划必须落在**含有目标资产**的那一份材料下 ──
   *
   * 只有在**没有致命问题**时才判它。否则"源已陈旧"会把所有行都算成
   * 未指派，于是"没有主材料"这类次级结论也会跟着冒出来 —— 噪音淹没有效信息。
   */
  let primaryMaterialId: string | null = null;
  const targetAssetKey = content.resolved?.targetAssetKey ?? null;
  if (fatalIssues.length === 0 && targetAssetKey !== null) {
    primaryMaterialId = pickPrimaryMaterialForPlan(input.grouping, targetAssetKey);
    if (primaryMaterialId === null) {
      issues.push({
        code: "plan_range_asset_unknown",
        where: "<materials>",
        detail:
          "计划针对的资产不属于任何材料提案（分组阶段没有把它归入任何材料）。" +
          "候选段必须挂在某一份材料下，因此无法应用该计划。" +
          "**失败关闭** —— 不静默回退到自动分段。",
      });
    }
  }

  const applied = fatalIssues.length === 0 && primaryMaterialId !== null && content.resolved !== null;

  return {
    applied,
    plan,
    planDigest: applied ? segmentationPlanDigest(plan) : null,
    issues,
    coverageIssues,
    primaryMaterialId,
    targetAssetKey: applied ? targetAssetKey : null,
    // 投影只认这一份结构 —— 计划被采用时它必须存在
    resolved: applied ? content.resolved : null,
    referencedAssetKeys,
    // 计数**从同一份规范解析结果派生**（不再另扫一遍 assignments）
    channelLineCounts: content.resolved?.channelLineCounts ?? {
      source: 0,
      referenceTranslation: 0,
      notes: 0,
      ignoredFurniture: 0,
    },
    unassigned: content.resolved?.unassigned ?? [],
  };
}
