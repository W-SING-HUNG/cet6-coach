/**
 * A1 只读检查工作台 · 服务层（**零写入**）。
 *
 * ── 这个模块存在的理由 ──
 *
 * 既有流水线（`runCourseIntake`）已经把"源目录 → 清点 → 抽取 → 分组 → 分段
 * → canonical 候选"这条链路建成了，但它的入口是 CLI：需要手写
 * `--source` / `--id` / `--provider` / `--rights-note` 等参数。
 * 使用者 打不开它。
 *
 * A1 只补一件事：**让同一条链路可以从浏览器里按选定范围跑一遍并读懂**。
 *
 * ── 它**绝不**做什么（每一条都是结构性的，不是纪律要求）──
 *
 * | 不做 | 结构性理由 |
 * | --- | --- |
 * | 不 import 任何数据库 / 仓库模块 | 没有连接就**无法**写库 |
 * | 不 import 候选写出器 | 本模块根本没有写候选文件的能力 |
 * | 不 import 课程链接服务 | 因此不可能产生 `verified` 链接 |
 * | 不 import 晋升 / 导入服务 | 不可能晋升 / 导入 |
 * | 不调 `child_process` | 它不能起任何进程（选取器在另一个模块里） |
 *
 * 由 `tests/course-a1-workbench.test.ts` 的源码级门禁守护。
 *
 * ── "零写入"为什么可以是一个结论而不是承诺 ──
 *
 * 本模块从头到尾只调用**只读**函数：`scanSourceTree`（元数据）、
 * `scanSourceDirectory`（读字节但不写）、`extractPdfPages`（pdfjs 只读）、
 * `buildIndexFromDisk`（只读磁盘上的真题包）。它没有任何
 * `writeFileSync` / `mkdirSync` / `appendFile` 调用点 ——
 * 因此"没有写操作"是**可被静态审计**的事实，而不是运行期纪律。
 *
 * ── 为什么检查结果只在内存里 ──
 *
 * 结果**不落盘**（没有缓存、没有 temp 文件、没有 SQLite）。
 * 代价是"刷新页面要重跑一次"，但换来的是 A1 不可能留下任何痕迹 ——
 * 而这正是 A1 与 A2/A3 的分界线：A1 只读，写动作在 A2/A3 各自的显式授权之下。
 */

import { join } from "node:path";
import { buildIndexFromDisk } from "./canonical";
import { proposeMaterialGroupings } from "./grouping";
import { extractSegmentsForMaterial } from "./segment";
import { extractPdfPages } from "./pdf-extract";
import { ALLOWED_SECTION_TYPES, matchSegments } from "./match";
import { scanSourceDirectory, scanSourceTree, type SourceSelection, type SourceTreeSnapshot } from "./sources";
import type {
  CandidateMatchingResult,
  MaterialGroupingResult,
  MaterialSegmentation,
  ParsedDocument,
  SourceInventory,
} from "./types";

// ---------------------------------------------------------------------------
// 选择范围
// ---------------------------------------------------------------------------

/** 一次检查请求的范围选择。**相对路径是稳定身份**（不是绝对路径）。 */
export interface InspectionSelectionInput {
  /** 勾选的目录（相对源根的 POSIX 路径，`""` 表示源根）。 */
  includeDirectories: string[];
  /**
   * 明确排除的文件（相对源根的 POSIX 路径）。
   *
   * ── 为什么"排除"要单独一个集合，而不是"勾选文件" ──
   *
   * 因为最常见的真实操作是**去掉少数几个**（例如整个目录里有一个巨大的音频，
   * 而这次只想看 PDF）。若只支持"勾选文件"，用户每次都要重新勾上百个文件；
   * 而"全选 + 去掉几个"是同一个意图的两种表达。
   */
  excludeFiles: string[];
}

/**
 * 由界面选择构造 `SourceSelection`。
 *
 * ── 安全语义（这是本函数唯一重要的事）──
 *
 * 它**只做排除**：判定只发生在已经通过 `traverseSourceTree` 全部路径安全
 * 检查的条目上。因此：
 *
 * - 形如 `../../etc` 的条目**永远不会被匹配到**（遍历根本不会产出这种
 *   相对路径 —— 逃逸的软链接在更早一层就被拒绝并登记了）；
 * - 它**不能**扩大读取范围：一个未被勾选的目录不会因为"父目录被勾选"
 *   而被读进来（`shouldDescend` 只看该目录自身是否在勾选集合里）；
 * - 它**不能**被用来读取源根之外的东西 —— 那是 `isWithin` 的职责，
 *   而那条判据本函数完全没有参与。
 *
 * 因此"选择范围"是一个**缩小**操作，与路径安全是两件正交的事。
 */
export function buildSourceSelection(input: InspectionSelectionInput): SourceSelection {
  const directories = new Set(input.includeDirectories.map(normalizeSelectionKey));
  const excluded = new Set(input.excludeFiles.map(normalizeSelectionKey));

  return {
    allowsFile(relativePath) {
      const key = normalizeSelectionKey(relativePath);
      if (excluded.has(key)) return false;
      return isUnderAnySelectedDirectory(key, directories);
    },
    shouldDescend(relativePath) {
      const key = normalizeSelectionKey(relativePath);
      // 目录自身被勾选，或它是某个被勾选目录的祖先（否则走不到勾选的那一层）
      if (directories.has(key)) return true;
      for (const directory of directories) {
        if (directory === "" || directory.startsWith(`${key}/`)) return true;
      }
      return false;
    },
  };
}

/** 选择键的归一：反斜杠统一成 `/`，去掉首尾分隔符。**不含路径解析**。 */
function normalizeSelectionKey(value: string): string {
  return value.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** 这个文件是否落在某个被勾选的目录下（含"勾选源根 = 全选"）。 */
function isUnderAnySelectedDirectory(fileKey: string, directories: Set<string>): boolean {
  if (directories.size === 0) return false;
  if (directories.has("")) return true;
  for (const directory of directories) {
    if (fileKey === directory || fileKey.startsWith(`${directory}/`)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 元数据清单（首屏）
// ---------------------------------------------------------------------------

/** 首屏"这个目录里有什么"。**不读字节、不解析正文。** */
export interface InspectionTreeView {
  /** 源根标签（**只有目录名**）。 */
  sourceRootLabel: string;
  scannedAt: string;
  /** 目录树（相对路径 → 直接子项）。 */
  directories: string[];
  files: {
    relativePath: string;
    basename: string;
    kind: string;
    bytes: number;
    folderContext: string | null;
  }[];
  /** 分类计数（与 Stage 2 的四张卡片同源）。 */
  counts: {
    total: number;
    pdf: number;
    docx: number;
    audio: number;
    image: number;
    unsupported: number;
    empty: number;
  };
  rejected: { relativePath: string; reason: string }[];
  ignoredHidden: number;
  /**
   * 结构摘要（**不是内容摘要**）。
   *
   * 元数据阶段不读字节，因此它只覆盖 (路径, 种类, 字节数)。
   * 名字里带 `structure` 就是为了让人不会把它当成内容指纹 ——
   * 那会是一个"内容改了但大小没变 ⇒ 看起来一致"的静默缺陷。
   */
  structureDigest: string;
}

/** 把元数据快照整理成界面视图。**纯函数**（不读盘、不读时钟）。 */
export function toTreeView(snapshot: SourceTreeSnapshot): InspectionTreeView {
  const files = snapshot.files.map((file) => ({
    relativePath: file.relativePath,
    basename: file.basename,
    kind: file.kind,
    bytes: file.bytes,
    folderContext: file.folderLabels.length > 0 ? file.folderLabels.join("/") : null,
  }));

  const countOf = (kind: string): number => snapshot.files.filter((file) => file.kind === kind).length;

  return {
    sourceRootLabel: snapshot.sourceRootLabel,
    scannedAt: snapshot.scannedAt,
    directories: snapshot.directories,
    files,
    counts: {
      total: snapshot.files.length,
      pdf: countOf("pdf"),
      docx: countOf("docx"),
      audio: countOf("audio"),
      image: countOf("image"),
      unsupported: countOf("unsupported"),
      empty: snapshot.files.filter((file) => file.bytes === 0).length,
    },
    rejected: snapshot.rejected,
    ignoredHidden: snapshot.ignoredHidden,
    structureDigest: snapshot.structureDigest,
  };
}

/**
 * 只读扫描源根，产出首屏视图。
 *
 * `selection` 为 null 时列出**全部**（首屏必须先看到全景才能选择）。
 */
export function inspectSourceTree(sourceRoot: string, selection: SourceSelection | null = null): InspectionTreeView {
  return toTreeView(scanSourceTree(sourceRoot, selection === null ? {} : { selection }));
}

// ---------------------------------------------------------------------------
// 完整检查（Stage 2/3/4 的数据来源）
// ---------------------------------------------------------------------------

/** 检查结果里的一段（界面用）。 */
export interface InspectionSegmentView {
  id: string;
  materialProposalId: string;
  kind: string;
  title: string;
  order: number;
  pageStart: number | null;
  pageEnd: number | null;
  /** 这一段是否**本来就没有可比对象**（例如写作模板 / 方法说明）。 */
  notApplicableByDesign: boolean;
  reviewRequired: boolean;
  reviewNotes: string[];
  anomalyCodes: string[];
}

/** 一份材料的视图（包含它的表示与段）。 */
export interface InspectionMaterialView {
  id: string;
  title: string;
  moduleHint: string | null;
  folderContext: string | null;
  representations: { assetKey: string; sourceRelativePath: string; kind: string; label: string }[];
  basis: string[];
  /** PDF+DOCX 这类**未被验证**的等价性提案 —— 必须人工确认。 */
  unverifiedEquivalence: boolean;
  reviewNotes: string[];
  segments: InspectionSegmentView[];
}

/** 逐项证据视图（**打分项与"不参与打分"的上下文分开**）。 */
export interface InspectionSuggestionView {
  /** 稳定目标身份（`paperId::sectionId::groupId`）。 */
  targetKey: string;
  paperId: string;
  paperContentVersion: number;
  sectionId: string;
  sectionType: string;
  groupId: string | null;
  questionId: string | null;
  label: string;
  score: number;
  matchLabel: string;
  /** **参与打分**的证据。 */
  scoring: {
    projectionExact: boolean;
    bodyContainment: number;
    bodyJaccard: number;
    stemOverlap: number | null;
    optionOverlap: number | null;
    structuralConsistency: number;
  };
  /** **不参与打分**的上下文线索（只作展示）。 */
  contextOnly: {
    courseFileName: string | null;
    courseSetLabel: string | null;
    observedQuestionNumbers: number[];
    canonicalQuestionNumbers: number[];
    courseAnswerKey: string | null;
    notes: string[];
  };
}

/** 一段的匹配结论视图。 */
export interface InspectionMatchView {
  segmentId: string;
  segmentTitle: string;
  segmentKind: string;
  label: string;
  ambiguous: boolean;
  ambiguityNote: string | null;
  unmatchedNote: string | null;
  /** 可比对象数量与说明（`0` 且无建议 ⇒ "按设计不匹配"）。 */
  candidatesConsidered: number;
  blockingDescription: string;
  view: "suggestions" | "ambiguous" | "unmatched" | "not_applicable";
  suggestions: InspectionSuggestionView[];
}

/** 冲突与警告（Stage 2 的"跨文件事实" + 恢复指引）。 */
export interface InspectionIssueView {
  code: string;
  severity: "blocking" | "advisory";
  where: string;
  detail: string;
  /** 人话的"怎么办"。**必须存在** —— 只报错不给处置是缺陷。 */
  recovery: string;
}

/** 完整检查结果（**只在内存里**）。 */
export interface InspectionResult {
  /** 源根标签（**只有目录名**）。 */
  sourceRootLabel: string;
  /** 检查范围的结构摘要（用于陈旧判定，**不是内容指纹**）。 */
  structureDigest: string;
  /** 范围内资产的**内容**摘要（源快照）。 */
  sourceDigest: string;
  inspectedAt: string;
  counts: {
    selected: number;
    excluded: number;
    pdfParsed: number;
    pdfWithoutTextLayer: number;
    pdfFailed: number;
    deferred: number;
    notApplicable: number;
    empty: number;
  };
  inventoryNotes: { code: string; detail: string; assetKeys: string[] }[];
  rejectedPaths: { relativePath: string; reason: string }[];
  materials: InspectionMaterialView[];
  matches: InspectionMatchView[];
  issues: InspectionIssueView[];
  /** canonical 库快照（**读不出来的包必须可见**）。 */
  canonicalLibrary: {
    digest: string;
    papers: { paperId: string; contentVersion: number; targetCount: number }[];
    readFailures: { packagePath: string; reason: string }[];
    complete: boolean;
  };
  /**
   * 匹配结论覆盖的**全部**不同目标数。
   *
   * 界面对它负责：不得因为列表长就悄悄截断（那会把"我只看到 3 个"
   * 伪装成"只有 3 个"）。
   */
  distinctTargetCount: number;
  /**
   * **跨段聚合的目标索引**（去重后按稳定身份排序）。
   *
   * ── 为什么必须有它，而不是只按段列建议 ──
   *
   * 匹配器每段最多保留 5 条建议（既有契约，A1 不改）。因此**单段**的
   * 列表永远不超过 5 条 —— 而"长列表"这件事是真实存在的：
   * 一次检查可以跨段覆盖 10+ 个不同目标（实测 12 份卷子的合成夹具）。
   *
   * 如果界面只按段列，用户就**没有一个地方**能看到"这次检查一共涉及
   * 哪些真题目标" —— 那正是任务书要求"include total counts, stable
   * target identity and expandable/paginated rendering for long lists"
   * 所针对的场景。因此这里给出聚合索引，界面据它做诚实分页。
   */
  targetIndex: InspectionTargetIndexEntry[];
}

/** 跨段聚合索引里的一条目标。 */
export interface InspectionTargetIndexEntry {
  /** 稳定目标身份（`paperId::sectionId::groupId`）。 */
  targetKey: string;
  paperId: string;
  sectionId: string;
  sectionType: string;
  groupId: string | null;
  questionId: string | null;
  label: string;
  /** 提出这个目标建议的段（可能多于一个）。 */
  segmentIds: string[];
  /** 该目标在所有段里的最高分（只是排序元数据）。 */
  bestScore: number;
  bestMatchLabel: string;
}

export interface RunInspectionInput {
  /** 源目录的**绝对路径**。只在内存里使用，**绝不持久化、绝不下发**。 */
  sourceRoot: string;
  /** 课程 id（**只作展示与 slug 校验**，本函数不写任何文件）。 */
  courseId: string;
  /** 范围选择；null ⇒ 全部（行为与既有 CLI 一致）。 */
  selection?: InspectionSelectionInput | null;
  /** canonical 真题包目录；默认 `private-content/cet6/papers`。 */
  papersDir?: string;
}

/**
 * 跑一次**只读**检查。
 *
 * ── 它复用哪一份实现 ──
 *
 * - 清点：`scanSourceDirectory`（**同一份**带 sha256 的实现）
 * - 抽取：`extractPdfPages`（**同一个** pdfjs 适配器）
 * - 分组：`proposeMaterialGroupings`（**同一个**）
 * - 分段：`extractSegmentsForMaterial`（**同一个**；这里刻意不用
 *   `runCourseIntake` 的编排，因为 A1 **不接受**人工分段计划 ——
 *   计划是 A2 的产物，而 A1 连"提交计划"的能力都不应该有）
 * - 匹配：`matchSegments` + `buildIndexFromDisk`（**同一个**）
 *
 * 因此 A1 看到的数字与 `course:extract` 看到的**逐项相同**，
 * 差别只在于 A1 不把候选写出来。
 *
 * ── 为什么选择在**抽取之前**生效 ──
 *
 * 被排除的文件既不被读取、也不进 `inventory.assets`，因此它不参与
 * 源快照摘要、不参与分组、不参与匹配。这是任务书要求的
 * "排除不得影响选中范围的快照与匹配结果"，且它是**内容级**的
 * （而不是显示层的过滤）。
 */
export async function runInspection(input: RunInspectionInput): Promise<InspectionResult> {
  const selection = input.selection == null ? null : buildSourceSelection(input.selection);

  // ── Stage 1：清点（**只在范围内的文件**）──
  const inventory = scanSourceDirectory(
    input.sourceRoot,
    selection === null ? {} : { selection },
  );

  // ── Stage 2：抽取 ──
  const documents: ParsedDocument[] = [];
  for (const asset of inventory.assets) {
    if (asset.kind === "pdf") {
      const absolutePath = join(input.sourceRoot, ...asset.relativePath.split("/"));
      documents.push(await extractPdfPages(asset.assetKey, absolutePath));
      continue;
    }
    documents.push(deferredOrNotApplicable(asset.assetKey, asset.kind));
  }

  // ── Stage 3：分组 ──
  const parsedText = new Map<string, string>();
  for (const doc of documents) {
    if (doc.pages.length === 0) continue;
    parsedText.set(
      doc.assetKey,
      doc.pages
        .filter((page) => page.hasTextLayer)
        .map((page) => page.paragraphText)
        .join("\n\n"),
    );
  }
  const grouping = proposeMaterialGroupings({ assets: inventory.assets, parsedText });

  // ── Stage 4：分段（**自动判据**；A1 不接受人工计划）──
  const segmentation = grouping.proposals.map((proposal) =>
    extractSegmentsForMaterial({
      proposal,
      documents: proposal.representations
        .map((representation) => documents.find((doc) => doc.assetKey === representation.assetKey))
        .filter((doc): doc is ParsedDocument => doc !== undefined),
    }),
  );

  // ── Stage 5：canonical 匹配 ──
  const allSegments = segmentation.flatMap((material) => material.segments);
  const built =
    input.papersDir === undefined ? buildIndexFromDisk() : buildIndexFromDisk(input.papersDir);
  const matching = matchSegments(allSegments, built.index, {
    courseFileName: null,
    courseSetLabel: null,
    courseAnswerKey: null,
  });

  const treeSnapshot = scanSourceTree(input.sourceRoot);

  return assembleInspectionResult({
    inventory,
    documents,
    grouping,
    segmentation,
    matching,
    canonicalFailures: built.failures,
    canonicalWarnings: built.warnings,
    structureDigest: treeSnapshot.structureDigest,
    inspectedAt: new Date().toISOString(),
    totalFilesInRoot: treeSnapshot.files.length,
  });
}

/** 非 PDF 资产的抽取状态：每种"没抽到文本"都有明确的名字。 */
function deferredOrNotApplicable(assetKey: string, kind: string): ParsedDocument {
  if (kind === "docx") {
    return {
      assetKey,
      state: "deferred",
      pages: [],
      tool: null,
      pagesWithoutTextLayer: [],
      warnings: [],
      error: null,
      deferredMarker: "TEXT_EXTRACTION_DEFERRED",
    };
  }
  return {
    assetKey,
    state: "not_applicable",
    pages: [],
    tool: null,
    pagesWithoutTextLayer: [],
    warnings: [],
    error: null,
    deferredMarker: null,
  };
}

// ---------------------------------------------------------------------------
// 组装（**纯函数**：可被单元测试直接驱动）
// ---------------------------------------------------------------------------

export interface AssembleInspectionInput {
  inventory: SourceInventory;
  documents: ParsedDocument[];
  grouping: MaterialGroupingResult;
  segmentation: MaterialSegmentation[];
  matching: CandidateMatchingResult;
  canonicalFailures: { packagePath: string; reason: string }[];
  canonicalWarnings: string[];
  structureDigest: string;
  inspectedAt: string;
  /** 源根下的**全部**文件数（含被排除的），用于诚实报告范围。 */
  totalFilesInRoot: number;
}

/** 匹配结果里的稳定目标身份（`paperId::sectionId::groupId`）。 */
export function targetKeyOf(target: {
  paperId: string;
  sectionId: string;
  groupId: string | null;
}): string {
  return `${target.paperId}::${target.sectionId}::${target.groupId ?? "-"}`;
}

/** 段视图的标题：段自身标题，缺失时退回 id（**不发明标题**）。 */
function segmentTitleOf(segment: { title: string | null; id: string }): string {
  const title = (segment.title ?? "").trim();
  return title === "" ? segment.id : title;
}

/**
 * 这一段是否**按设计**不参与 canonical 匹配。
 *
 * ── 判据必须是种类表，不能是"候选数为 0" ──
 *
 * `candidatesConsidered === 0` 有两种完全不同的成因：
 *
 * | 成因 | 含义 | 界面必须说的话 |
 * | --- | --- | --- |
 * | 种类**按设计**不匹配（写作模板 / 方法讲解） | 正确的产品语义 | 「不需要做任何事」 |
 * | 当前库里没有可比对象 | 一个**可能变化**的状态 | 「未匹配是合法状态」 |
 *
 * 只看候选数会把两者显示成同一句话 —— 于是 使用者 会以为自己的写作材料
 * "没匹配上"，跑去改一份本来就不需要改的东西。
 *
 * 因此判据取**唯一权威来源** `ALLOWED_SECTION_TYPES`（`null` = 按设计不匹配），
 * 不在这里另写一份清单。
 */
export function isNotApplicableByDesign(segmentKind: string): boolean {
  const allowed = ALLOWED_SECTION_TYPES[segmentKind as keyof typeof ALLOWED_SECTION_TYPES];
  return allowed === null || allowed === undefined;
}

/**
 * 把各阶段产物组装成界面视图。
 *
 * 刻意抽成**纯函数**：界面视图的每一条判据（"按设计不匹配"、
 * "歧义"、"未匹配合法"、"不可由复核化解"）都能被单元测试与变异测试
 * 直接驱动，而不需要跑一次真实磁盘检查。
 */
export function assembleInspectionResult(input: AssembleInspectionInput): InspectionResult {
  const { inventory, documents, grouping, segmentation, matching } = input;

  const materialViews: InspectionMaterialView[] = grouping.proposals.map((proposal) => {
    const material = segmentation.find((item) => item.materialProposalId === proposal.id);
    const segments: InspectionSegmentView[] = (material?.segments ?? []).map((segment) => ({
      id: segment.id,
      materialProposalId: segment.materialProposalId,
      kind: segment.kind,
      title: segmentTitleOf(segment),
      order: segment.order,
      pageStart: segment.anchor.pageStart,
      pageEnd: segment.anchor.pageEnd,
      notApplicableByDesign: isNotApplicableByDesign(segment.kind),
      reviewRequired: segment.reviewRequired,
      reviewNotes: segment.reviewNotes,
      anomalyCodes: segment.anomalies.map((anomaly) => anomaly.code),
    }));

    return {
      id: proposal.id,
      title: proposal.title,
      moduleHint: proposal.moduleHint,
      folderContext: proposal.folderContext,
      representations: proposal.representations.map((representation) => ({
        assetKey: representation.assetKey,
        sourceRelativePath: representation.sourceRelativePath,
        kind: representation.kind,
        label: representation.label,
      })),
      basis: proposal.basis,
      /*
       * "未被验证的等价性"= 这份提案包含 DOCX（V1 不解析）或内容无法比对。
       *
       * 判据直接取机器给出的 `contentComparable`，**不自己再推一遍** ——
       * 两处判据必然漂移，而漂移的那一处会让界面说"已验证"。
       */
      unverifiedEquivalence: !proposal.evidence.contentComparable && proposal.representations.length > 1,
      reviewNotes: proposal.reviewNotes,
      segments,
    };
  });

  const matches: InspectionMatchView[] = matching.segments.map((segment) => {
    const material = materialViews.find((item) =>
      item.segments.some((candidate) => candidate.id === segment.segmentId),
    );
    const segmentTitle =
      material?.segments.find((candidate) => candidate.id === segment.segmentId)?.title ?? segment.segmentId;

    /*
     * ── 四态视图：必须能区分"按设计不匹配"与"库里没有可比对象" ──
     *
     * 两者都是 `suggestions: []`，但含义完全不同：
     * - 前者是**正确的产品语义**（写作模板本来就不对应单道真题）；
     * - 后者意味着"当前库无法有把握地识别它"，是一个**可能变化**的状态。
     *
     * 界面把它们显示成同一句话会让 使用者 以为自己的写作材料"没匹配上"，
     * 于是去改一份本来就不需要改的东西。
     *
     * 判据取**种类表**（唯一权威来源），不取"候选数为 0" ——
     * 后者在"库为空"时对每一种材料都成立，包括阅读篇章。
     */
    const notApplicable = isNotApplicableByDesign(segment.segmentKind);
    const view: InspectionMatchView["view"] =
      segment.suggestions.length === 0
        ? notApplicable
          ? "not_applicable"
          : "unmatched"
        : segment.ambiguous
          ? "ambiguous"
          : "suggestions";

    return {
      segmentId: segment.segmentId,
      segmentTitle,
      segmentKind: segment.segmentKind,
      label: segment.label,
      ambiguous: segment.ambiguous,
      ambiguityNote: segment.ambiguityNote,
      unmatchedNote: segment.unmatchedNote,
      candidatesConsidered: segment.blocking.candidatesConsidered,
      blockingDescription: segment.blocking.description,
      view,
      suggestions: segment.suggestions.map((suggestion) => ({
        targetKey: targetKeyOf(suggestion.target),
        paperId: suggestion.target.paperId,
        paperContentVersion: suggestion.target.paperContentVersion,
        sectionId: suggestion.target.sectionId,
        sectionType: suggestion.target.sectionType,
        groupId: suggestion.target.groupId,
        questionId: suggestion.target.questionId,
        label: suggestion.target.label,
        score: suggestion.score,
        matchLabel: suggestion.label,
        scoring: {
          projectionExact: suggestion.evidence.projectionExact,
          bodyContainment: suggestion.evidence.bodyContainment,
          bodyJaccard: suggestion.evidence.bodyJaccard,
          stemOverlap: suggestion.evidence.stemOverlap,
          optionOverlap: suggestion.evidence.optionOverlap,
          structuralConsistency: suggestion.evidence.structuralConsistency,
        },
        contextOnly: {
          courseFileName: suggestion.evidence.contextOnly.courseFileName,
          courseSetLabel: suggestion.evidence.contextOnly.courseSetLabel,
          observedQuestionNumbers: suggestion.evidence.contextOnly.observedQuestionNumbers,
          canonicalQuestionNumbers: suggestion.evidence.contextOnly.canonicalQuestionNumbers,
          courseAnswerKey: suggestion.evidence.contextOnly.courseAnswerKey,
          notes: suggestion.evidence.contextOnly.notes,
        },
      })),
    };
  });

  // 不同目标数（去重后）—— 界面据此诚实地报"共 N 个目标"
  const targetIndex = buildTargetIndex(matches);
  const distinctTargetCount = targetIndex.length;

  const excluded = Math.max(0, input.totalFilesInRoot - inventory.assets.length);
  const stateCount = (state: string): number =>
    documents.filter((doc) => doc.state === state).length;

  const selected = inventory.assets.length;

  return {
    sourceRootLabel: inventory.sourceRootLabel,
    structureDigest: input.structureDigest,
    sourceDigest: inventory.digest,
    inspectedAt: input.inspectedAt,
    counts: {
      selected,
      excluded,
      pdfParsed: stateCount("parsed"),
      pdfWithoutTextLayer: stateCount("no_text_layer"),
      pdfFailed: stateCount("failed"),
      deferred: stateCount("deferred"),
      notApplicable: stateCount("not_applicable"),
      empty: inventory.assets.filter((asset) => asset.bytes === 0).length,
    },
    inventoryNotes: inventory.notes.map((note) => ({
      code: note.code,
      detail: note.detail,
      assetKeys: note.assetKeys,
    })),
    rejectedPaths: inventory.rejected,
    materials: materialViews,
    matches,
    issues: buildIssues({
      inventory,
      documents,
      grouping,
      segmentation,
      matching,
      canonicalFailures: input.canonicalFailures,
    }),
    canonicalLibrary: {
      digest: matching.canonicalLibrary.digest,
      papers: matching.canonicalLibrary.papers.map((paper) => ({
        paperId: paper.paperId,
        contentVersion: paper.contentVersion,
        targetCount: paper.targetCount,
      })),
      readFailures: matching.canonicalLibrary.readFailures,
      complete: matching.canonicalLibrary.readFailures.length === 0,
    },
    distinctTargetCount,
    targetIndex,
  };
}

/**
 * 跨段聚合目标索引（**纯函数**）。
 *
 * ── 去重的判据是稳定身份，不是标签 ──
 *
 * 同一个目标可能被**多个段**同时提名（同一篇篇章被两段引用是真实情形）。
 * 按 `targetKey`（`paperId::sectionId::groupId`）去重，并把提名的段全部记下 ——
 * 这样"这个目标被几段提到"是可核对的事实，而不是一个被合并掉的数字。
 *
 * 排序按稳定身份，**不按分数** —— 分数只是排序元数据，而索引是一份
 * "这次涉及了哪些目标"的清单；按分数排会让"最高分"看起来像"最可信"。
 */
export function buildTargetIndex(matches: InspectionMatchView[]): InspectionTargetIndexEntry[] {
  const byKey = new Map<string, InspectionTargetIndexEntry>();

  for (const match of matches) {
    for (const suggestion of match.suggestions) {
      const existing = byKey.get(suggestion.targetKey);
      if (existing === undefined) {
        byKey.set(suggestion.targetKey, {
          targetKey: suggestion.targetKey,
          paperId: suggestion.paperId,
          sectionId: suggestion.sectionId,
          sectionType: suggestion.sectionType,
          groupId: suggestion.groupId,
          questionId: suggestion.questionId,
          label: suggestion.label,
          segmentIds: [match.segmentId],
          bestScore: suggestion.score,
          bestMatchLabel: suggestion.matchLabel,
        });
        continue;
      }
      if (!existing.segmentIds.includes(match.segmentId)) existing.segmentIds.push(match.segmentId);
      if (suggestion.score > existing.bestScore) {
        existing.bestScore = suggestion.score;
        existing.bestMatchLabel = suggestion.matchLabel;
      }
    }
  }

  return [...byKey.values()]
    .map((entry) => ({ ...entry, segmentIds: [...entry.segmentIds].sort() }))
    .sort((a, b) => a.targetKey.localeCompare(b.targetKey));
}

/**
 * 冲突与警告。
 *
 * ── 每一条都必须同时给"为什么"和"怎么办" ──
 *
 * 既有 CLI 已经这么做（源漂移时打印不含真实路径的命令模板）。
 * A1 沿用同一套措辞纪律：**只报错不给处置**是反馈缺陷，不是简洁。
 *
 * `recovery` 里**绝不**出现绝对路径或真实目录名 —— 它们是人写的模板。
 */
function buildIssues(input: {
  inventory: SourceInventory;
  documents: ParsedDocument[];
  grouping: MaterialGroupingResult;
  segmentation: MaterialSegmentation[];
  matching: CandidateMatchingResult;
  canonicalFailures: { packagePath: string; reason: string }[];
}): InspectionIssueView[] {
  const issues: InspectionIssueView[] = [];
  const { inventory, documents, grouping, segmentation, matching } = input;

  for (const rejected of inventory.rejected) {
    issues.push({
      code: "rejected_path",
      severity: "blocking",
      where: rejected.relativePath,
      detail: `这个条目没有被读取：${rejected.reason}`,
      recovery:
        "确认它是否真的属于这门课。若它是软链接指向别处，请把内容复制进课程目录后重新检查；" +
        "若它不该在这里，从课程目录里移走它。",
    });
  }

  for (const note of inventory.notes) {
    if (note.code === "empty_file") {
      issues.push({
        code: "empty_file",
        severity: "blocking",
        where: note.assetKeys.join("、"),
        detail: note.detail,
        recovery: "多半是导出失败留下的空文件。请重新导出这一份，或把它从课程目录里移走后重新检查。",
      });
    }
    if (note.code === "duplicate_content") {
      issues.push({
        code: "duplicate_content",
        severity: "advisory",
        where: note.assetKeys.join("、"),
        detail: note.detail,
        recovery: "同一个文件的多份副本不构成多份材料。若其中一份是旧的，从课程目录里移走它即可。",
      });
    }
    if (note.code === "same_name_different_bytes") {
      issues.push({
        code: "same_name_different_bytes",
        severity: "blocking",
        where: note.assetKeys.join("、"),
        detail: note.detail,
        recovery:
          "同名不同内容必须分别判断。请确认哪一份是你想用的，把另一份改名或移出课程目录后重新检查。",
      });
    }
    if (note.code === "unsupported_type") {
      issues.push({
        code: "unsupported_type",
        severity: "advisory",
        where: note.assetKeys.join("、"),
        detail: note.detail,
        recovery: "本版本不解析这类文件，它们不会进入课程内容。保留它们不影响其它材料的检查结果。",
      });
    }
  }

  for (const doc of documents) {
    if (doc.state === "failed") {
      issues.push({
        code: "extraction_failed",
        severity: "blocking",
        where: doc.assetKey,
        detail: `这个 PDF 没能被解析：${doc.error ?? "未知原因"}`,
        recovery:
          "这份文件的字节可能已损坏，或它其实是别的格式。请重新导出成 PDF 后替换它，然后重新检查。" +
          "这次检查里其它文件的结果仍然可用。",
      });
    }
    if (doc.state === "no_text_layer") {
      issues.push({
        code: "page_without_text_layer",
        severity: "blocking",
        where: doc.assetKey,
        detail:
          `有 ${doc.pagesWithoutTextLayer.length} 页没有文字层` +
          `（第 ${doc.pagesWithoutTextLayer.slice(0, 20).join("、")}${doc.pagesWithoutTextLayer.length > 20 ? "…" : ""} 页）。`,
        recovery:
          "本工具**不做 OCR**，因此这些页的内容不会被推测。若这几页真的重要，" +
          "请换一份带文字层的导出；若不重要，可以在选择时把它们排除掉。",
      });
    }
    if (doc.state === "deferred") {
      issues.push({
        code: "text_extraction_deferred",
        severity: "advisory",
        where: doc.assetKey,
        detail: "DOCX 在本版本**不被解析**（TEXT_EXTRACTION_DEFERRED）。它被登记为一种表示，但不会产出课程段。",
        recovery: "若这份 DOCX 有对应的 PDF，检查会以 PDF 为准；只有 DOCX 时它不会贡献内容。",
      });
    }
  }

  for (const violation of grouping.invariantViolations) {
    issues.push({
      code: "grouping_invariant_violated",
      severity: "blocking",
      where: "分组",
      detail: violation,
      recovery:
        "这是分组算法的缺陷而不是数据问题。请记录这一步的现场并反馈；" +
        "检查结果里其它部分仍然可用，但不要据此判断分组是否正确。",
    });
  }

  for (const proposal of grouping.proposals) {
    if (!proposal.reviewRequired) continue;
    issues.push({
      code: "material_grouping_requires_review",
      severity: "advisory",
      where: proposal.title,
      detail: proposal.reviewNotes.join("；") || "这份材料分组需要人工确认。",
      recovery:
        "在后续的人工核对步骤里逐条确认（本页只做只读检查，**不会保存任何结论**）。" +
        "若这些文件其实是两份不同内容，它们应当被拆开。",
    });
  }

  const insufficientSegments = segmentation.filter(
    (material) => material.segments.length === 0 && material.documentLevelOnly,
  );
  for (const material of insufficientSegments) {
    const proposal = grouping.proposals.find((item) => item.id === material.materialProposalId);
    issues.push({
      code: "no_segments_extracted",
      severity: "advisory",
      where: proposal?.title ?? material.materialProposalId,
      detail: "这份材料没有产出任何课程段：它没有可用的结构线索，或是整个文档级内容。",
      recovery:
        "这是**刻意**的：工具不发明边界。若需要把它切成多份练习，" +
        "那属于后续的人工标注步骤 —— 本页不会保存结构。",
    });
  }

  for (const match of matching.segments) {
    if (match.ambiguous) {
      issues.push({
        code: "match_ambiguous",
        severity: "advisory",
        where: match.segmentId,
        detail: match.ambiguityNote ?? "前两名建议的分数过于接近。",
        recovery:
          "机器**不会**替你在接近的两个候选之间选一个。请对照逐项证据判断；" +
          "本页只做只读检查，裁决属于后续步骤。",
      });
    }
  }

  for (const failure of input.canonicalFailures) {
    issues.push({
      code: "canonical_library_incomplete",
      severity: "advisory",
      where: failure.packagePath,
      detail: `一份真题包没能被读取：${failure.reason}`,
      recovery:
        "因此这次的匹配是在**不完整的库**上进行的：'未匹配'与'最高分建议'都不可全信。" +
        "请先修好那份真题包，再重新检查课程。",
    });
  }

  return issues;
}

/** A1 允许调用的只读流水线入口（供门禁核对"复用而不是重写"）。 */
export const A1_REUSED_PIPELINE_ENTRIES = [
  "scanSourceDirectory",
  "scanSourceTree",
  "extractPdfPages",
  "proposeMaterialGroupings",
  "extractSegmentsForMaterial",
  "matchSegments",
  "buildIndexFromDisk",
] as const;
