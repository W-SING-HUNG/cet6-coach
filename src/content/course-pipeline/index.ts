/**
 * 流水线编排（`pnpm course:extract` 的核心）。
 *
 * ── 这条链路的每一步都只做一件事，且都能被单独核对 ──
 *
 *   源目录 → 清点(+校验和) → PDF 逐页抽取 → 逻辑材料提案
 *     → 保守分段 → canonical 候选匹配 → 候选包 + 证据报告
 *
 * ── 三条贯穿性的硬约束 ──
 *
 * 1. **不写数据库。** 本模块不 import 任何数据库模块。抽取是纯文件系统操作。
 * 2. **不改源件。** 源目录只读；`scanSourceDirectory` 用只读句柄打开文件。
 * 3. **不创建 verified 链接。** 匹配只产建议；晋升是另一条命令，建链又是第三条。
 *
 * ── 为什么 canonical 库读不出来时**不**失败关闭 ──
 *
 * 抽取与匹配是两件事：即使一份真题包损坏，课程材料仍然可以被规范化、
 * 被人工复核、被晋升（未匹配是合法状态）。因此 canonical 读取失败
 * 会**阻断匹配**（所有段判未匹配）但**不阻断抽取** —— 并把这个事实
 * 明确写进候选与复核事项里，让人看见。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildIndexFromDisk } from "./canonical";
import { buildCourseCandidate, type CourseCandidateArchive } from "./candidate";
import { proposeMaterialGroupings } from "./grouping";
import { extractSegmentsForMaterial } from "./segment";
import { applySegmentationPlan, automaticSegmentationEvidence, planProjectionMismatch, plannedSegmentationEvidence } from "./plan-apply";
import { resolveSegmentationPlan, type ResolvedSegmentationPlan } from "./plan-resolve";
import { assertNoAbsolutePaths, scanSourceDirectory, type SourceSelection } from "./sources";
import { extractPdfPages } from "./pdf-extract";
import { matchSegments, type MatchContext } from "./match";
import type {
  MaterialGroupingResult,
  MaterialSegmentation,
  ParsedDocument,
  ProposedSegment,
  SegmentationModeEvidence,
  SourceInventory,
} from "./types";

export interface RunCourseIntakeInput {
  /** 源目录的**绝对路径**（只在内存里使用，绝不持久化）。 */
  sourceRoot: string;
  courseId: string;
  provider: string;
  edition: string | null;
  title: string;
  contentVersion: number;
  provenance: { note: string; reference: string | null; rightsNote: string };
  /** canonical 真题包目录；默认 `private-content/cet6/papers`。 */
  papersDir?: string;
  /**
   * 标准私有源树根（`private-content/course-sources`）。
   *
   * 提供它时，若 `sourceRoot` 位于该树之内，候选会记录一个
   * **安全的相对定位符**，于是复核/晋升可以自动重新清点当前源来证明未漂移。
   * 源在该树之外时仍可抽取，但**不记录任何位置**（要求复核者再给一次路径）。
   */
  standardSourcesRoot?: string;
  /**
   * **人工分段计划**（显式可选输入）。
   *
   * ── 语义（任务书的核心要求）──
   *
   * - **自动分段仍是默认。** 不传它时行为**完全不变**。
   * - 传它时：先按当前源校验（绑定/越界/重叠/覆盖率），
   *   通过后**确定性地**按计划构造段落，而**不**跑自动判据。
   *
   * ── 为什么必须在**生成候选之前** ──
   *
   * 计划是**结构输入**，`review.json` 是**验收记录**。
   * 若让复核携带结构改动，就会出现死结：改结构 ⇒ 候选校验和变 ⇒
   * 复核立刻陈旧 ⇒ 无法应用。因此结构输入只能在候选生成之前发生。
   *
   * ── 校验失败时的行为：**失败关闭** ──
   *
   * 绝不静默回退到自动分段。那会让"我明明写了计划"与"系统按自动结果跑"
   * 两个事实悄悄分叉 —— 操作者以为自己的结构生效了，实际没有。
   */
  segmentationPlan?: SegmentationPlanInput | undefined;
  /**
   * **文件选择范围**（A1 工作台的可选输入）。
   *
   * ── 为什么它必须在这里，而不能只在 A1 的检查那一步 ──
   *
   * A1 的只读检查与 A3 的候选生成是**两条入口**进入同一个 `scanSourceDirectory`。
   * 早先只有检查那条传了 `selection`，于是界面显示"已排除 2 个文件"，
   * 而**候选生成仍然读整棵源根** —— 排除只发生在预览里，从未发生在产物里。
   *
   * 那是本项目反复登记过的最坏形态：断言/界面与真实产物分叉，
   * 而两边都"看起来正常"。因此 `selection` 必须进编排层。
   *
   * ── 语义（与 `ScanSourceOptions.selection` 完全一致）──
   *
   * - **不提供时行为逐字节不变**（既有 CLI 的整根语义，向后兼容）；
   * - 提供时：被排除的文件与目录**既不读字节、也不进 `assets`** ⇒
   *   因此不影响源摘要、分组、分段与匹配。它是**内容级**的排除，
   *   而不是显示层过滤。
   * - 它**不能扩大**读取范围：路径安全判据（`realpathSync` + `isWithin`）
   *   在它之前独立生效，两者正交。
   */
  selection?: SourceSelection | null;
  /** 只作展示、**不参与打分**的上下文线索。 */
  matchContext?: Partial<MatchContext>;
  now?: () => Date;
}

/** 传入 `runCourseIntake` 的人工分段计划（**已解析的原始文本**）。 */
export interface SegmentationPlanInput {
  /**
   * 计划文件的原始 JSON 文本。
   *
   * 传文本而不是路径，是为了让"计划从哪里读"留在 CLI 层 ——
   * 本模块因此不需要知道计划文件的位置，也就**不可能**把它写进候选。
   */
  raw: string;
}

/**
 * 计划相关阶段的结果（失败关闭时的结构化结论）。
 *
 * 它是 `ResolvedSegmentationPlan` 的**别名**：计划决策只有一处实现
 * （`plan-resolve.ts`），这里刻意不定义第二个略有不同的形状 ——
 * 那会让"CLI 看到的"与"编排实际用的"悄悄分叉。
 */
export type SegmentationPlanOutcome = ResolvedSegmentationPlan;

export interface CourseIntakeStageReport {
  name: string;
  detail: string;
  warnings: string[];
}

export interface CourseIntakeResult {
  archive: CourseCandidateArchive;
  inventory: SourceInventory;
  documents: ParsedDocument[];
  grouping: MaterialGroupingResult;
  segmentation: MaterialSegmentation[];
  stages: CourseIntakeStageReport[];
  /** canonical 库读取失败（必须可见）。 */
  canonicalFailures: { packagePath: string; reason: string }[];
  warnings: string[];
  /**
   * 人工分段计划的处置结果（**永远存在**）。
   *
   * 没传计划时它是 `{ applied: false, issues: [] }`；
   * 传了但校验失败时它是 `{ applied: false, issues: [...] }` ——
   * **失败关闭**，且**绝不**静默回退到自动分段。
   */
  segmentationPlan: SegmentationPlanOutcome;
}

/**
 * 跑完整条抽取链路，产出一个**未复核**的候选包（仍在内存里）。
 *
 * 写盘由 CLI 决定 —— 这样整个链路可以在测试里对内存产物断言，
 * 不必每次都落盘。
 */
export async function runCourseIntake(input: RunCourseIntakeInput): Promise<CourseIntakeResult> {
  const now = input.now ?? (() => new Date());
  const stages: CourseIntakeStageReport[] = [];
  const warnings: string[] = [];

  // ── Stage 1：源清点 + 校验和 ──────────────────────────────────────────
  const inventory = scanSourceDirectory(input.sourceRoot, {
    // 提供标准源树根 ⇒ 源若在其中就得到可复用的**相对**定位符
    standardSourcesRoot: input.standardSourcesRoot,
    /*
     * 选择范围在这里生效（**唯一的生效点**）。
     *
     * 它必须传给清点，而不是在拿到 inventory 之后再过滤：
     * 后者会让被排除的文件**先被读字节、先进入源摘要**，于是
     * "排除"变成显示层的事，而候选身份仍然由未排除的全集决定。
     */
    selection: input.selection ?? undefined,
  });
  // 结构性断言：清点结果里绝不能出现绝对路径（它会被写进候选包）
  assertNoAbsolutePaths(inventory, input.sourceRoot);

  stages.push({
    name: "Stage 1 · 资产清点与校验和",
    detail:
      `清点 ${inventory.assets.length} 个文件，共 ${formatBytes(
        inventory.assets.reduce((sum, asset) => sum + asset.bytes, 0),
      )}。` +
      `内容可解析（PDF）：${inventory.assets.filter((asset) => asset.contentParsed).length} 个。` +
      `被拒绝的路径：${inventory.rejected.length} 个。` +
      `源定位符：${
        inventory.sourceLocator.kind === "standard"
          ? `标准源树内的相对路径 \`${inventory.sourceLocator.locator}\`（可自动重证源新鲜度）`
          : "外部源根（**刻意不记录位置**；晋升时需再次提供 --source-root）"
      }。`,
    warnings: inventory.notes.map((note) => `${note.code}：${note.detail}`),
  });
  warnings.push(...inventory.notes.map((note) => note.detail));

  // ── Stage 2：PDF 逐页抽取 ─────────────────────────────────────────────
  const documents: ParsedDocument[] = [];
  for (const asset of inventory.assets) {
    if (asset.kind === "pdf") {
      const absolutePath = join(input.sourceRoot, ...asset.relativePath.split("/"));
      documents.push(await extractPdfPages(asset.assetKey, absolutePath));
      continue;
    }
    // **非 PDF 一律不被内容解析。** 每种"没抽到文本"都有明确的名字。
    documents.push(deferredOrNotApplicable(asset.assetKey, asset.kind));
  }

  const parsedCount = documents.filter((doc) => doc.state === "parsed").length;
  const deferredCount = documents.filter((doc) => doc.state === "deferred").length;
  const noTextCount = documents.filter((doc) => doc.state === "no_text_layer").length;
  const failedCount = documents.filter((doc) => doc.state === "failed").length;

  stages.push({
    name: "Stage 2 · PDF 文本层抽取（逐页来源证据）",
    detail:
      `成功解析 ${parsedCount} 个 PDF；` +
      `无文本层 ${noTextCount} 个；` +
      `**有意推迟**（${"TEXT_EXTRACTION_DEFERRED"}）${deferredCount} 个；` +
      `解析失败 ${failedCount} 个。`,
    warnings: documents.flatMap((doc) => doc.warnings),
  });
  warnings.push(...documents.flatMap((doc) => doc.warnings));

  // ── Stage 3：逻辑材料提案（文件 ≠ 逻辑材料）───────────────────────────
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
  stages.push({
    name: "Stage 3 · 逻辑材料分组提案",
    detail:
      `${inventory.assets.length} 个文件 → ${grouping.proposals.length} 份候选逻辑材料。` +
      `其中 ${grouping.proposals.filter((proposal) => proposal.reviewRequired).length} 份需要人工确认。` +
      (grouping.invariantViolations.length > 0
        ? `**不变量违反 ${grouping.invariantViolations.length} 处**`
        : "不变量核对通过（每个文件恰好属于一份材料）。"),
    warnings: grouping.warnings,
  });
  warnings.push(...grouping.warnings);

  // ── Stage 4：分段（自动为默认；人工计划是显式可选输入）────────────────
  //
  // ── 这一段的语义边界（本任务最核心的一条）──
  //
  //   自动抽取/分组
  //     → 没有计划：走既有 `extractSegmentsForMaterial`（行为**完全不变**）
  //     → 有计划  ：校验后**确定性**构造段落
  //
  // **计划是生成候选的输入，不是复核记录。** 因此它只能在这里生效 ——
  // 候选一旦写出，就**不得**再按任何人的决定去改写它的结构
  // （那会让候选校验和与复核脱钩，见 F9 的语义）。
  const planOutcome = resolveSegmentationPlan({
    input: input.segmentationPlan,
    courseId: input.courseId,
    inventory,
    documents,
    grouping,
  });

  /** 既有自动分段（**默认路径**；无计划时逐字节不变）。 */
  const automaticSegmentation = (): MaterialSegmentation[] =>
    grouping.proposals.map((proposal) =>
      extractSegmentsForMaterial({
        proposal,
        documents: proposal.representations
          .map((representation) => documents.find((doc) => doc.assetKey === representation.assetKey))
          .filter((doc): doc is ParsedDocument => doc !== undefined),
      }),
    );

  /*
   * ── 致命 vs 覆盖缺口：必须先分开，因为两者后果不同 ──
   *
   * - **致命**：计划未被采用（坐标在这份源上无意义）。分段回退到自动判据。
   * - **覆盖缺口**：计划**已**被采用（人看到自己标的结构），缺口单独阻断。
   *
   * `applied === true` 时 `issues` 里只可能有覆盖缺口，因此 fatal 为空。
   */
  const fatalIssues = planOutcome.applied
    ? []
    : planOutcome.issues.filter((issue) => !planOutcome.coverageIssues.includes(issue));

  let segmentation = automaticSegmentation();
  let segmentationMode: SegmentationModeEvidence = automaticSegmentationEvidence();

  if (
    planOutcome.applied &&
    planOutcome.plan !== null &&
    planOutcome.primaryMaterialId !== null &&
    planOutcome.resolved !== null
  ) {
    const primaryProposalId = planOutcome.primaryMaterialId;
    const primaryProposal = grouping.proposals.find((proposal) => proposal.id === primaryProposalId)!;

    const applied = applySegmentationPlan({
      planDigest: planOutcome.planDigest!,
      materialProposalId: primaryProposalId,
      documents: documents.filter((doc) =>
        primaryProposal.representations.some((representation) => representation.assetKey === doc.assetKey),
      ),
      // 投影消费**规范解析结果** —— 绝不自己再读一遍计划
      resolved: planOutcome.resolved,
    });

    /*
     * ── 后置断言：**每一个被计入覆盖率的行都必须真的进了投影** ──
     *
     * 这是 F2/F3 那两条缺陷的直接守卫。它们之所以能一路走到 Browser Agent，
     * 正是因为"覆盖率说完整、投影却少了内容"没有任何地方被比对过。
     *
     * 判据刻意用**计数**而不是"函数有没有被调用"：计数是从同一份
     * `resolved.claimByLine` 与投影实际写出的行分别算出来的，
     * 两者不一致就说明投影与统计脱钩 —— 那必须是一个**抛出的失败**，
     * 而不是静默产出一份缺内容的候选。
     *
     * 判据的**唯一实现**在 `plan-apply.ts` 的 `planProjectionMismatch`
     * （纯函数，因此可以直接被单元测试与变异测试驱动）。
     */
    const mismatch = planProjectionMismatch(applied.projectedLineCounts, planOutcome.channelLineCounts);
    if (mismatch !== null) {
      throw new Error(`${mismatch}（计划校验和 ${planOutcome.planDigest!.slice(0, 16)}…）`);
    }

    /*
     * 计划只定义了它所针对的那份材料的结构。
     *
     * 其余材料**原样走自动分段** —— 那样"计划没提到的材料"不会因为有了一份
     * 计划就凭空消失。（一份计划覆盖整门课是常见情形，但契约不假定如此。
     * 注意计划**只能针对一份资产**：见 V1 单资产契约。）
     */
    segmentation = [
      applied.segmentation,
      ...automaticSegmentation().filter((material) => material.materialProposalId !== primaryProposalId),
    ];

    segmentationMode = plannedSegmentationEvidence(
      planOutcome.plan,
      planOutcome.planDigest!,
      planOutcome.channelLineCounts,
      planOutcome.unassigned,
    );
  }

  const allSegments = segmentation.flatMap((material) => material.segments);
  stages.push({
    name: "Stage 4 · 课程段候选抽取（保守 / 人工计划）",
    detail:
      (segmentationMode.mode === "human_planned"
        ? `分段模式：**人工分段计划**（计划校验和 ${segmentationMode.planDigest!.slice(0, 16)}…，` +
          `${segmentationMode.unitCount} 个单元）。` +
          `通道行数：原文 ${segmentationMode.channelLineCounts.source}、` +
          `参考译文 ${segmentationMode.channelLineCounts.referenceTranslation}、` +
          `讲解 ${segmentationMode.channelLineCounts.notes}、` +
          `显式家具 ${segmentationMode.channelLineCounts.ignoredFurniture}。` +
          (segmentationMode.unassignedLineCount > 0
            ? `**未指派 ${segmentationMode.unassignedLineCount} 行**（阻断：必须修正计划后重新生成候选）。`
            : "覆盖率完整（无未指派内容）。")
        : "分段模式：**自动**（既有保守判据；未提供人工分段计划）。") +
      `产出 ${allSegments.length} 个候选段（来自 ${segmentation.filter((m) => m.segments.length > 0).length} 份材料）。` +
      `按种类：${summarizeByKind(allSegments)}。` +
      `其中 ${allSegments.filter((segment) => segment.reviewRequired).length} 个需要人工确认。`,
    warnings: segmentation.flatMap((material) => material.warnings),
  });
  warnings.push(...segmentation.flatMap((material) => material.warnings));

  /*
   * 计划校验失败 ⇒ **失败关闭**，而且必须是**可见的**失败。
   *
   * 刻意**不**静默回退到自动分段：那会让"我明明写了计划"与
   * "系统按自动结果跑"两个事实悄悄分叉 —— 操作者以为自己的结构生效了。
   * 因此这里把它变成一条**阻断级复核事项**，候选仍会生成（便于人检查
   * 到底哪里不对），但门禁**不可能** PROMOTABLE。
   *
   * ── 只有**致命**问题才走到这里 ──
   *
   * 覆盖缺口（有内容没被通道接住）**不**作废计划：计划照常被采用、
   * 照常按人的结构产段，缺口由 `plan_unassigned_content` 这条阻断事项
   * 单独承载。这样人看到的永远是自己标的那一份结构。
   */
  const fatalIssuesForStage = planOutcome.applied ? [] : planOutcome.issues.filter(
    (issue) => !planOutcome.coverageIssues.includes(issue),
  );
  if (fatalIssuesForStage.length > 0) {
    warnings.push(
      `**人工分段计划未被采用**（${fatalIssuesForStage.length} 项问题）：` +
        fatalIssuesForStage.map((issue) => `${issue.code}@${issue.where} —— ${issue.detail}`).join("；") +
        `。分段**回退到自动判据**，但门禁会因这些问题阻断晋升 —— ` +
        `请修正计划后重新生成候选。`,
    );
    stages.push({
      name: "Stage 4b · 人工分段计划校验（**失败关闭**）",
      detail:
        `提供的计划**未被采用**：${fatalIssuesForStage.length} 项致命问题。` +
        `分段回退到自动判据，且候选带**阻断级**事项 ⇒ 门禁不可能 PROMOTABLE、零晋升、零建链。` +
        `**绝不静默忽略一份有问题的计划。**`,
      warnings: fatalIssuesForStage.map((issue) => `${issue.code}@${issue.where}`),
    });
  }

  // ── Stage 5：canonical 匹配 ───────────────────────────────────────────
  let canonicalFailures: { packagePath: string; reason: string }[] = [];
  let matching;

  if (input.papersDir === undefined) {
    const built = buildIndexFromDisk();
    canonicalFailures = built.failures;
    matching = matchSegments(allSegments, built.index, {
      courseFileName: null,
      courseSetLabel: null,
      courseAnswerKey: null,
      ...input.matchContext,
    });
    warnings.push(...built.warnings);
  } else {
    const built = buildIndexFromDisk(input.papersDir);
    canonicalFailures = built.failures;
    matching = matchSegments(allSegments, built.index, {
      courseFileName: null,
      courseSetLabel: null,
      courseAnswerKey: null,
      ...input.matchContext,
    });
    warnings.push(...built.warnings);
  }

  if (canonicalFailures.length > 0) {
    // ── 不完整的 canonical 库：**不阻断抽取与课程包晋升**，但必须可见 ──
    //
    // 语义刻意分两层（与门禁 `canonical_library_complete_for_acceptance` 一致）：
    //
    // - **课程包**仍可被规范化、复核、晋升 —— 未匹配是合法状态，
    //   少读一份卷不使课程材料本身失真。
    // - **但**在库不完整时，**不得**把某个 `accepted_suggestion` 当作可信的
    //   建链依据：可比对象少了一批，"这是最高分"不再可信。
    //
    // 因此这里只上报，不在抽取阶段拒绝。判定发生在复核/晋升门禁里。
    warnings.push(
      `${canonicalFailures.length} 份 canonical 真题包读取失败，因此匹配是在**不完整的**库上进行的：` +
        canonicalFailures.map((failure) => `${failure.packagePath}（${failure.reason}）`).join("；") +
        `。这些卷的可比内容未被纳入比较 —— "未匹配"与"最高分建议"因此都不可全信。` +
        `课程包仍可复核与晋升；但**接受建议 / 建链交接在库不完整时失败关闭**。`,
    );
  }

  const matched = matching.segments.filter((segment) => segment.suggestions.length > 0).length;
  const ambiguous = matching.segments.filter((segment) => segment.ambiguous).length;
  const notMatchable = matching.segments.filter(
    (segment) => segment.blocking.candidatesConsidered === 0 && segment.suggestions.length === 0,
  ).length;

  stages.push({
    name: "Stage 5 · canonical CET-6 候选匹配（建议，非核验）",
    detail:
      `canonical 库：${matching.canonicalLibrary.papers.length} 份真题包，` +
      `库摘要 ${matching.canonicalLibrary.digest.slice(0, 12)}…。` +
      `有建议的段 ${matched} 个（其中歧义 ${ambiguous} 个）；` +
      `无可比对象的段 ${notMatchable} 个（**按设计不参与匹配**，例如写作模板与方法说明）。` +
      `**机器匹配不产生 verified 链接** —— 高分、精确指纹、文件名、套别号、题号都不是核验。`,
    warnings: canonicalFailures.map((failure) => `${failure.packagePath}：${failure.reason}`),
  });

  // ── Stage 6：候选包 ──────────────────────────────────────────────────
  const assetBytes = new Map<string, Buffer>();
  for (const asset of inventory.assets) {
    // 只把**能进入课程包**的资产带上（扩展名在允许列表内）
    const absolutePath = join(input.sourceRoot, ...asset.relativePath.split("/"));
    try {
      assetBytes.set(asset.assetKey, readFileSync(absolutePath));
    } catch {
      warnings.push(`资产读取失败，未纳入候选包：${asset.relativePath}`);
    }
  }

  const archive = buildCourseCandidate({
    courseId: input.courseId,
    provider: input.provider,
    edition: input.edition,
    title: input.title,
    contentVersion: input.contentVersion,
    provenance: input.provenance,
    sourceRootLabel: inventory.sourceRootLabel,
    inventory,
    assetBytes,
    documents,
    grouping,
    segmentation,
    segmentationMode,
    /*
     * 只把**致命**问题作为"计划未被采用"交给候选。
     *
     * 覆盖缺口**不**属于这一类：计划确实生效了（人看到的结构就是自己标的那份），
     * 缺口由 `plan_unassigned_content` 这条独立事项承载。若把缺口也塞进
     * `planIssues`，候选会同时声称"计划未被采用"与"计划已采用" —— 自相矛盾。
     */
    planIssues: fatalIssues,
    matching,
    createdAt: now().toISOString(),
  });

  const blockingReview = archive.review.filter((item) => item.severity === "blocking").length;
  stages.push({
    name: "Stage 6 · 候选包 + 证据报告",
    detail:
      `段 ${archive.manifest.segments.length} 个、材料 ${archive.manifest.materials.length} 份、` +
      `资产 ${archive.manifest.assets.length} 个。` +
      `复核事项 ${archive.review.length} 条（其中阻断级 ${blockingReview} 条）。` +
      `候选校验和 ${archive.metadata.digests.candidateChecksum.slice(0, 16)}…` +
      `（review.json 必须绑定此值）。`,
    warnings: [],
  });

  return {
    archive,
    inventory,
    documents,
    grouping,
    segmentation,
    stages,
    canonicalFailures,
    warnings: dedupe(warnings),
    segmentationPlan: planOutcome,
  };
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
      // 任务显式要求的稳定标记
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

function summarizeByKind(segments: ProposedSegment[]): string {
  const counts = new Map<string, number>();
  for (const segment of segments) counts.set(segment.kind, (counts.get(segment.kind) ?? 0) + 1);
  if (counts.size === 0) return "（无）";
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([kind, count]) => `${kind} ×${count}`)
    .join("、");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

/** 源快照摘要（供 CLI 与测试核对）。 */
export function sourceDigestOf(inventory: SourceInventory): string {
  return inventory.digest;
}

/** 课程 id 的合法性与目录安全性（CLI 侧使用）。 */
export function isValidCourseId(courseId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(courseId);
}

/** 候选包目录名：由课程 id 推导，**不接受任意路径**。 */
export function candidateDirNameOf(courseId: string): string {
  if (!isValidCourseId(courseId)) {
    throw new Error(
      `课程 id 不合法：${courseId}。只允许小写字母、数字、点、下划线与连字符，且不能以符号开头 ` +
        `（与 course.json 的校验规则一致 —— 否则候选目录名会与包内 id 不一致）。`,
    );
  }
  return courseId;
}

/** 候选校验和的短形式（日志用）。 */
export function shortDigest(digest: string): string {
  return digest.slice(0, 12);
}

/** 内容摘要（用于测试断言确定性）。 */
export function digestOf(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
