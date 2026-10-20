/**
 * 人工分段计划（Manual Segmentation Plan）—— **本地人工结构输入**。
 *
 * ── 它在流水线里的位置（这是本模块最重要的一句话）──
 *
 *   源字节 → 正常本地抽取 → 自动分段尝试
 *     → **【需要时】人工分段计划** → 确定性候选重生成
 *     → 正常校验和绑定的 review.json → 既有晋升/导入/建链
 *
 * **这不是第二套复核机制。**
 *
 * | | 分段计划（本模块） | review.json |
 * | --- | --- | --- |
 * | 是什么 | 生成候选的**输入** | 对已生成候选的**验收记录** |
 * | 何时写 | 自动分段不足时（人类定结构） | 候选生成之后（人类核对） |
 * | 绑定 | 源快照 + 资产校验和 + 计划自身校验和 | 候选校验和 |
 * | 能改候选结构吗 | **它就是结构来源** | **绝不能**（那会让校验和脱钩） |
 *
 * 两条语义因此必须始终成立：
 *
 * - **计划不产生 verified，也不晋升任何东西。** 它只是一份结构输入；
 *   用完仍然要人工签 `review.json`，仍然要走既有的门禁。
 * - **绝不用复核决定反向改写候选结构。** 复核只做裁决，不做重组；
 *   要改结构就改**计划**然后**重新生成候选**。
 *
 * ── 为什么不复用 `review.json` 承载结构 ──
 *
 * `review.json` 绑定的是**候选校验和**。若允许它携带结构改动，就会出现
 * 一个自指的死结：改结构 ⇒ 候选校验和变 ⇒ 复核立刻陈旧 ⇒ 无法应用。
 * 而"在复核阶段自动重组候选"（另一种绕法）等于在复核者背后改写一份
 * 已绑定校验和的候选 —— 这与既有 F9 语义直接冲突。
 * 因此结构输入必须发生在**候选生成之前**，且形态是一份**独立输入**。
 *
 * ── 研究依据（只取原则，不引入任何依赖）──
 *
 * | 来源 | 采纳的原则 |
 * | --- | --- |
 * | Unstructured `by_title` | 边界来自**文档结构**；长度只是打包约束，不是语义边界 |
 * | Unstructured `multipage_sections=True` | **页边界默认不是分段边界** |
 * | Docling `ProvenanceItem` | 结构 = 指向源件的**页码 + 位置指针**，不是正文副本 |
 * | Docling `content_layer` | 家具内容应被**标注**（FURNITURE），而不是被静默丢弃 |
 * | Docling `DocumentOrigin.binary_hash` | 计划必须绑定**源字节身份** |
 * | Label Studio | 人工修正必须成为**显式、可复现的数据**，而不是隐式改写 |
 * | Label Studio（反面） | 它**没有**文档版本字段、**没有**陈旧检测 —— 这项工作必须自己做 |
 *
 * 刻意**不**采纳：DocLang 把正文内嵌进注释文件（那会制造第二个真相来源）。
 */

import { createHash } from "node:crypto";
import { stableStringify } from "@/content/pipeline/fingerprint";
import type { CourseSegmentKind } from "@/domain/course";

// ---------------------------------------------------------------------------
// 契约版本与文件名
// ---------------------------------------------------------------------------

/**
 * 分段计划的**契约版本**。
 *
 * 与课程 manifest 的 `schemaVersion` 同一套推理：它是**文件形状**版本，
 * 不是"这份计划的内容变了"。形状/字段含义变化时才递增。
 *
 * 版本不认识 ⇒ **失败关闭**（绝不按旧契约猜测着解读）。
 */
export const SEGMENTATION_PLAN_SCHEMA_VERSION = 1;

/** 本实现能够解析的计划契约版本集合。 */
export const SUPPORTED_SEGMENTATION_PLAN_SCHEMA_VERSIONS = [SEGMENTATION_PLAN_SCHEMA_VERSION] as const;

/**
 * 计划文件的默认文件名。
 *
 * 默认位置是 `private-content/course-segmentation-plans/<course-id>.json`
 * （见 `getCourseSegmentationPlansDir`）—— **刻意不放在候选目录里**：
 * `course:extract` 重跑会备份并替换整个候选目录，计划放在那里会在每次
 * 重新抽取时被搬进 `.prev-*`，于是"改了源 → 重新抽取 → 计划不见了"。
 */
export const SEGMENTATION_PLAN_FILENAME = "segmentation-plan.json";

/**
 * 计划里每条范围可以承担的**语义通道**。
 *
 * V1 只需要支撑 `translation_passage`，因此通道恰好是任务书要求的那几类：
 *
 * | 通道 | 落到哪 | 语义 |
 * | --- | --- | --- |
 * | `source` | `segment.text` | 课程**原文**（翻译材料里是中文原文） |
 * | `reference_translation` | `segment.referenceTranslation` | 课程**参考译文** |
 * | `notes` | `segment.notes` | 讲解 / 语言点 |
 * | `ignored_furniture` | **不进入任何通道** | 页眉页脚等非内容家具，**显式**忽略 |
 *
 * `ignored_furniture` 是本设计里唯一"允许丢内容"的地方 ——
 * 而它**必须由人显式声明**。工具**绝不**因为某行重复就自行推断"这是页眉"。
 * 这条是覆盖率要求的落点：一条行要么被某个段落的某个通道接住，
 * 要么被**人**标成家具；此外没有第三种出路。
 */
export const PLAN_CHANNEL_KINDS = [
  "source",
  "reference_translation",
  "notes",
  "ignored_furniture",
] as const;
export type PlanChannelKind = (typeof PLAN_CHANNEL_KINDS)[number];

/** 会被写进段落正文的通道（`ignored_furniture` 不在其中）。 */
export const CONTENT_CHANNEL_KINDS = PLAN_CHANNEL_KINDS.filter(
  (kind): kind is Exclude<PlanChannelKind, "ignored_furniture"> => kind !== "ignored_furniture",
);

// ---------------------------------------------------------------------------
// 计划的数据形态
// ---------------------------------------------------------------------------

/**
 * 一个**结构选择器**（structural selector）。
 *
 * ── 为什么是"资产键 + 页号 + 页内行序号"而不是自由文本 ──
 *
 * 任务书明确要求：**不得用自由文本匹配作为边界身份的主要判据。**
 * 理由是它会静默漂移 —— 改一个空格、换一次 PDF 抽取器、或源件里同一句话
 * 出现两次，都会让"匹配到的位置"悄悄变成另一处，而没有任何报错。
 *
 * 因此选择器只引用**既有抽取产物**里已经稳定的坐标：
 *
 * - `assetKey`：既有 `SourceAsset.assetKey`（确定性、纯 ASCII、含路径哈希）；
 * - `page`：既有 `ExtractedPage.page`（1 起）；
 * - `lineStart` / `lineEnd`：`ExtractedPage.lines[]` 的**页内**下标（1 起，闭区间）。
 *
 * 这些坐标对**同一份源字节**是确定的、可复现的，且能被独立核对
 * （复核者可以按坐标回源数到那一行）。它们**不**保证对另一份源字节仍指同一内容 ——
 * 而那正是计划必须绑定源摘要的原因（见下）。
 */
export interface PlanLineRange {
  /** 既有清点产出的资产键。 */
  assetKey: string;
  /** 页号（1 起，与 `ExtractedPage.page` 一致）。 */
  page: number;
  /** 页内起始行号（1 起，与 `ExtractedPage.lines[]` 下标 + 1 一致）。 */
  lineStart: number;
  /** 页内结束行号（1 起，**闭区间**）。 */
  lineEnd: number;
}

/** 一条范围 + 它承担的通道。 */
export interface PlanAssignment {
  channel: PlanChannelKind;
  range: PlanLineRange;
  /** 人写的说明（审计用；可以解释"为什么把这几行当成页眉"）。 */
  note: string | null;
}

/**
 * 一个**人工定义的分段单元**。
 *
 * ── 通道基数（V1 契约，必须显式且自洽）──
 *
 * 一个单元里，每个通道可以有**多个**范围，而不是只能一条：
 *
 * | 通道 | 基数 | 为什么 |
 * | --- | --- | --- |
 * | `source` | **≥ 1** | 一个翻译单元没有原文是自相矛盾的 |
 * | `reference_translation` | 0 或更多 | 任务书要求"**不要强迫每个单元都有参考译文**" |
 * | `notes` | 0 或更多 | 讲解可以分成若干互不相邻的片段 |
 * | `ignored_furniture` | 0 或更多 | 家具可以分散在多页 |
 *
 * **为什么允许多个范围**：一个语义通道完全可能**跨页**或被页面上的其他结构
 * 打断（例如原文在 p1 与 p3，中间夹着参考译文）。只允许一条会让那种材料
 * 根本无法被正确标注。
 *
 * 由此产生两条不可动摇的推论：
 *
 * 1. **投影必须把某个通道的每一个范围都拼进去**（按源文档顺序），
 *    绝不能用 `find()` 只取第一条 —— 那会静默丢掉第二条范围的内容。
 * 2. **抽取出的每一行最多只能有一个最终归属**（见 `resolvePlanContent`）。
 *    同一个单元、同一个通道里的两个范围只要重叠，就属于"同一行被指派了两次"
 *    —— **失败关闭**，绝不静默去重。去重会让"计划说了一件事、系统做了另一件事"。
 */
export interface PlanUnit {
  /** 人可读的单元标题（会成为候选段标题）。 */
  title: string;
  /** 段种类。V1 只支持 `translation_passage`，写在这里是为了不必再改契约。 */
  kind: CourseSegmentKind;
  assignments: PlanAssignment[];
}

/**
 * 计划的**绑定信息**（身份与陈旧语义的落点）。
 *
 * 全部字段都是"这份计划是针对哪一份东西写的"的显式声明。
 * 任一不匹配 ⇒ 计划陈旧 ⇒ **失败关闭**，绝不把旧选择器静默套到新源上。
 */
export interface SegmentationPlanBinding {
  /** 课程 id。 */
  courseId: string;
  /**
   * 计划所针对的源快照摘要（既有 `SourceInventory.digest`）。
   *
   * **源字节一变，计划立刻陈旧。** 这是本设计里最强的一条守卫：
   * 选择器是"第几页第几行"，它只对**那一份**源字节有意义。
   */
  sourceDigest: string;
  /**
   * 计划所针对的资产（`assetKey` → sha256）。
   *
   * 冗余于 `sourceDigest`，但**刻意保留**：源目录里新增一个无关文件会改变
   * `sourceDigest`，而这里能让人一眼看出"被引用的那份资产本身有没有变"。
   * 两处都判，报告更精确。
   */
  assets: { assetKey: string; sha256: string }[];
}

/** 一份完整的计划文件（磁盘契约）。 */
export interface SegmentationPlanFile {
  schemaVersion: number;
  binding: SegmentationPlanBinding;
  /** 写计划的人（审计）。 */
  author: string;
  /** 写作时刻（审计；**不参与**计划校验和 —— 见下）。 */
  createdAt: string;
  /**
   * 计划所针对的**候选来源模式**说明（人可读，审计用）。
   *
   * 它解释"为什么需要人工结构"：自动分段证据不足。它**不参与**校验和。
   */
  reason: string;
  units: PlanUnit[];
}

// ---------------------------------------------------------------------------
// 计划校验和（身份）
// ---------------------------------------------------------------------------

/**
 * 计划里**参与身份**的部分。
 *
 * ── 哪些字段被**刻意排除** ──
 *
 * - `author` / `createdAt` / `reason`：审计元数据。同一个人隔一天把同样的
 *   结构重存一次，**不应当**变成一份不同的结构输入 —— 那会让候选校验和无谓地变，
 *   进而让已经签好的复核凭空陈旧。这与既有"审计元数据不参与语义身份"的
 * 原则一致。
 *
 * 保留的是**真正决定候选结构**的东西：契约版本、绑定、单元与它们的范围。
 *
 * ── 为什么需要它 ──
 *
 * 任务书要求："改变人的结构输入**必须**改变候选身份"。
 * 因此计划校验和会进入候选证据；候选校验和随之变化 ⇒
 * 已签署的复核自动陈旧 ⇒ 必须对新结构重新复核。**绝不自动沿用旧决定。**
 */
export function segmentationPlanDigest(plan: SegmentationPlanFile): string {
  const canonical = {
    schemaVersion: plan.schemaVersion,
    binding: {
      courseId: plan.binding.courseId,
      sourceDigest: plan.binding.sourceDigest,
      assets: [...plan.binding.assets]
        .sort((a, b) => a.assetKey.localeCompare(b.assetKey))
        .map((asset) => ({ assetKey: asset.assetKey, sha256: asset.sha256 })),
    },
    units: plan.units.map((unit) => ({
      title: unit.title,
      kind: unit.kind,
      assignments: unit.assignments.map((assignment) => ({
        channel: assignment.channel,
        range: {
          assetKey: assignment.range.assetKey,
          page: assignment.range.page,
          lineStart: assignment.range.lineStart,
          lineEnd: assignment.range.lineEnd,
        },
        note: assignment.note,
      })),
    })),
  };
  return createHash("sha256").update(stableStringify(canonical), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 校验：形状层（不依赖抽取产物）
// ---------------------------------------------------------------------------

export interface PlanValidationIssue {
  /** 稳定的机器可读错误码（供门禁与 UI 分类）。 */
  code: PlanValidationCode;
  /** 出问题的大致位置。 */
  where: string;
  /** 人可读说明 —— 必须同时给出"为什么"与"怎么办"。 */
  detail: string;
}

/**
 * 计划问题的**稳定错误码**。
 *
 * 它是机器可读分类，因此 UI 与门禁可以按类型措辞，而不必去解析人写的句子。
 * 自动化侧只允许看到这些**码与计数**（安全元数据），**绝不**看到正文。
 */
export type PlanValidationCode =
  | "plan_not_object"
  | "plan_schema_version_missing"
  | "plan_schema_version_unsupported"
  | "plan_binding_missing"
  | "plan_binding_course_mismatch"
  | "plan_assets_empty"
  | "plan_unit_empty"
  | "plan_unit_kind_unsupported"
  | "plan_unit_title_missing"
  | "plan_unit_source_count"
  | "plan_assignment_channel_unknown"
  | "plan_range_shape_invalid"
  | "plan_range_order_invalid"
  | "plan_range_asset_unknown"
  | "plan_range_page_out_of_bounds"
  | "plan_range_line_out_of_bounds"
  | "plan_range_page_without_text_layer"
  | "plan_range_overlap"
  | "plan_unassigned_content"
  /**
   * V1 **单资产契约**被违反：计划引用了不止一份表示资产。
   *
   * 跨材料的人工分段在 V1 不被支持，且必须**显式拒绝** ——
   * 部分接受会让另一份资产上的范围静默产出空正文。
   */
  | "plan_multi_asset_unsupported"
  | "plan_binding_source_stale"
  | "plan_binding_asset_stale"
  | "plan_binding_asset_missing"
  | "plan_json_invalid";

/**
 * **致命**的计划问题码：计划**不能被采用**（坐标在这份源上无意义，
 * 或计划对结构说了两遍而系统无从裁决）。
 *
 * ── 与"覆盖缺口"的分界（两类后果完全不同）──
 *
 * | 类别 | 例 | 计划是否被采用 | 后果 |
 * | --- | --- | --- | --- |
 * | **致命** | 绑定陈旧 / 越界 / 任何重叠 / 多资产 | **不采用** | 回退自动分段 + 阻断 |
 * | **覆盖缺口** | 有内容行没被任何通道接住 | **采用** | 按人的结构产段 + 阻断 |
 *
 * 覆盖缺口**不**作废计划：否则人看到的候选结构就**不是**自己标的那一份
 * —— 那正是要避免的静默分叉。
 *
 * 分类是**错误码的固有属性**，因此写在这里与码同处一地；
 * `plan-resolve.ts` 消费它，不再自己维护第二份清单（两份必然漂移）。
 */
export const FATAL_PLAN_VALIDATION_CODES: readonly PlanValidationCode[] = [
  "plan_not_object",
  "plan_schema_version_missing",
  "plan_schema_version_unsupported",
  "plan_binding_missing",
  "plan_binding_course_mismatch",
  "plan_assets_empty",
  "plan_unit_empty",
  "plan_unit_kind_unsupported",
  "plan_unit_title_missing",
  "plan_unit_source_count",
  "plan_assignment_channel_unknown",
  "plan_range_shape_invalid",
  "plan_range_order_invalid",
  "plan_range_asset_unknown",
  "plan_range_page_out_of_bounds",
  "plan_range_line_out_of_bounds",
  "plan_range_page_without_text_layer",
  "plan_range_overlap",
  "plan_multi_asset_unsupported",
  "plan_binding_source_stale",
  "plan_binding_asset_stale",
  "plan_binding_asset_missing",
  "plan_json_invalid",
] as const;

/** 判定一个计划问题码是否致命（计划不可采用）。 */
export function isFatalPlanValidationCode(code: PlanValidationCode): boolean {
  return FATAL_PLAN_VALIDATION_CODES.includes(code);
}

/** 计划形状校验结果（纯形状，不接触抽取产物）。 */
export interface PlanShapeValidation {
  ok: boolean;
  issues: PlanValidationIssue[];
  plan: SegmentationPlanFile | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 校验计划文件**形状**。
 *
 * 刻意分成两阶段（形状 → 内容）：
 * 形状层可以在**没有源件**的情况下运行（UI 早期反馈、坏文件诊断）；
 * 内容层需要抽取产物，才能判断行号越界与覆盖率。
 * 混成一层会让"文件根本不是计划"与"计划指向了不存在的行"报出同一种错。
 */
export function validatePlanShape(raw: unknown): PlanShapeValidation {
  const issues: PlanValidationIssue[] = [];
  const fail = (code: PlanValidationCode, where: string, detail: string): PlanShapeValidation => {
    issues.push({ code, where, detail });
    return { ok: false, issues, plan: null };
  };

  if (!isPlainObject(raw)) {
    return fail(
      "plan_not_object",
      "<root>",
      "分段计划必须是一个 JSON 对象。若这是坏文件，请重新用 `pnpm course:segment` 生成。",
    );
  }

  // ── 契约版本（**先于**形状判定，与 manifest 同一套纪律）──
  const schemaVersion = raw.schemaVersion;
  if (schemaVersion === undefined) {
    return fail(
      "plan_schema_version_missing",
      "<root>.schemaVersion",
      `计划缺少 schemaVersion（必需）。当前应用支持：` +
        `${SUPPORTED_SEGMENTATION_PLAN_SCHEMA_VERSIONS.join(" / ")}。` +
        `它声明这份计划按哪一版契约解析 —— 与"计划内容变了"是两件事。`,
    );
  }
  if (
    typeof schemaVersion !== "number" ||
    !Number.isInteger(schemaVersion) ||
    !(SUPPORTED_SEGMENTATION_PLAN_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion)
  ) {
    return fail(
      "plan_schema_version_unsupported",
      "<root>.schemaVersion",
      `计划契约版本不受支持：${JSON.stringify(schemaVersion)}。` +
        `当前应用支持：${SUPPORTED_SEGMENTATION_PLAN_SCHEMA_VERSIONS.join(" / ")}。` +
        `**不按旧契约猜测着解读** —— 请升级应用或重新生成计划。`,
    );
  }

  // ── 绑定 ──
  if (!isPlainObject(raw.binding)) {
    return fail(
      "plan_binding_missing",
      "<root>.binding",
      "计划缺少 binding。它必须声明这份计划针对哪个课程、哪一份源快照、哪些资产校验和 —— " +
        "否则源件一换，旧选择器就会被静默套到新源上。",
    );
  }
  const binding = raw.binding;
  if (typeof binding.courseId !== "string" || binding.courseId === "") {
    return fail("plan_binding_missing", "binding.courseId", "binding.courseId 缺失或为空。");
  }
  if (typeof binding.sourceDigest !== "string" || !/^[0-9a-f]{64}$/.test(binding.sourceDigest)) {
    return fail(
      "plan_binding_missing",
      "binding.sourceDigest",
      "binding.sourceDigest 必须是 64 位小写十六进制 sha256（既有 SourceInventory.digest）。",
    );
  }
  if (!Array.isArray(binding.assets) || binding.assets.length === 0) {
    return fail(
      "plan_assets_empty",
      "binding.assets",
      "binding.assets 不得为空 —— 计划必须绑定它引用的资产的校验和。",
    );
  }
  const boundAssets = new Map<string, string>();
  for (const [index, asset] of binding.assets.entries()) {
    if (!isPlainObject(asset) || typeof asset.assetKey !== "string" || typeof asset.sha256 !== "string") {
      return fail(
        "plan_binding_missing",
        `binding.assets[${index}]`,
        "binding.assets[] 每项必须是 { assetKey, sha256 }（都是字符串）。",
      );
    }
    boundAssets.set(asset.assetKey, asset.sha256);
  }

  // ── 单元 ──
  if (!Array.isArray(raw.units) || raw.units.length === 0) {
    return fail(
      "plan_unit_empty",
      "<root>.units",
      "计划必须至少有一个单元。空计划会产出零个段 —— 那不是「人工定了结构」，而是没有结构。",
    );
  }

  const units: PlanUnit[] = [];
  for (const [unitIndex, rawUnit] of raw.units.entries()) {
    const unitWhere = `units[${unitIndex}]`;
    if (!isPlainObject(rawUnit)) {
      return fail("plan_unit_empty", unitWhere, "单元必须是一个对象。");
    }
    if (typeof rawUnit.title !== "string" || rawUnit.title.trim() === "") {
      return fail("plan_unit_title_missing", `${unitWhere}.title`, "单元必须有非空标题（会成为候选段标题）。");
    }
    /*
     * V1 只支持 `translation_passage`。
     *
     * 刻意**显式拒绝**其他种类，而不是"先接受着，反正也产不出对的东西"：
     * 一份声明了 `reading_passage` 的计划若被静默当成翻译处理，
     * 产出的段会带着错误的 kind 一路走到运行时课程包 —— 那是最糟的一类缺陷。
     */
    if (rawUnit.kind !== "translation_passage") {
      return fail(
        "plan_unit_kind_unsupported",
        `${unitWhere}.kind`,
        `V1 人工分段只支持 translation_passage，实际为 ${JSON.stringify(rawUnit.kind)}。` +
          `其他种类**显式拒绝**（不做静默降级）—— 静默降级会让错误的段种类进入运行时课程包。`,
      );
    }
    if (!Array.isArray(rawUnit.assignments) || rawUnit.assignments.length === 0) {
      return fail("plan_unit_source_count", `${unitWhere}.assignments`, "单元必须至少有一条范围指派。");
    }

    const assignments: PlanAssignment[] = [];
    for (const [assignmentIndex, rawAssignment] of rawUnit.assignments.entries()) {
      const assignmentWhere = `${unitWhere}.assignments[${assignmentIndex}]`;
      if (!isPlainObject(rawAssignment)) {
        return fail("plan_assignment_channel_unknown", assignmentWhere, "范围指派必须是一个对象。");
      }
      if (
        typeof rawAssignment.channel !== "string" ||
        !(PLAN_CHANNEL_KINDS as readonly string[]).includes(rawAssignment.channel)
      ) {
        return fail(
          "plan_assignment_channel_unknown",
          `${assignmentWhere}.channel`,
          `channel 必须是 ${PLAN_CHANNEL_KINDS.join(" / ")} 之一，实际为 ` +
            `${JSON.stringify(rawAssignment.channel)}。`,
        );
      }
      const range = rawAssignment.range;
      if (
        !isPlainObject(range) ||
        typeof range.assetKey !== "string" ||
        range.assetKey === "" ||
        !Number.isInteger(range.page) ||
        !Number.isInteger(range.lineStart) ||
        !Number.isInteger(range.lineEnd)
      ) {
        return fail(
          "plan_range_shape_invalid",
          `${assignmentWhere}.range`,
          "range 必须是 { assetKey: string(非空), page/lineStart/lineEnd: 整数 }。",
        );
      }
      const page = range.page as number;
      const lineStart = range.lineStart as number;
      const lineEnd = range.lineEnd as number;
      if (page < 1 || lineStart < 1 || lineEnd < 1) {
        return fail(
          "plan_range_shape_invalid",
          `${assignmentWhere}.range`,
          `页号与行号都从 **1** 起（PDF 页 1、页内行 1）。实际 page=${page}、` +
            `lineStart=${lineStart}、lineEnd=${lineEnd}。0 或负数不是合法的选择器。`,
        );
      }
      if (lineStart > lineEnd) {
        return fail(
          "plan_range_order_invalid",
          `${assignmentWhere}.range`,
          `lineStart（${lineStart}）不得大于 lineEnd（${lineEnd}）—— 范围是闭区间且必须有序。`,
        );
      }

      let note: string | null = null;
      if (rawAssignment.note !== undefined && rawAssignment.note !== null) {
        if (typeof rawAssignment.note !== "string") {
          return fail("plan_range_shape_invalid", `${assignmentWhere}.note`, "note 必须是字符串或 null。");
        }
        note = rawAssignment.note;
      }

      assignments.push({
        channel: rawAssignment.channel as PlanChannelKind,
        range: { assetKey: range.assetKey as string, page, lineStart, lineEnd },
        note,
      });
    }

    /*
     * 一个翻译单元**至少一条** `source` —— 没有原文是自相矛盾的。
     *
     * ── 为什么**不再**要求"恰好一条" ──
     *
     * 原文完全可能跨页或被页面上的其他结构打断（例如英文参考译文插在
     * 两段中文原文之间）。只允许一条会让那种材料根本无法被正确标注。
     * 因此基数是 **≥ 1**，而"多个范围**互不重叠**"这条不变量由内容层的
     * `resolvePlanContent` 强制（那里能看到真实页码与行号）。
     *
     * 形状层无法判重叠：它**刻意**不接触抽取产物（见 `validatePlanShape`
     * 的分层说明），因此这里只判"有没有"。
     */
    const sourceCount = assignments.filter((assignment) => assignment.channel === "source").length;
    if (sourceCount < 1) {
      return fail(
        "plan_unit_source_count",
        `${unitWhere}.assignments`,
        `每个单元必须**至少**有一条 channel="source"（实际 ${sourceCount} 条）。` +
          `0 条 ⇒ 这个翻译单元没有原文。` +
          `（可以有**多条**：原文允许跨页或被其他结构打断；` +
          `但多条之间必须互不重叠，否则内容层的重叠守卫会失败关闭。）`,
      );
    }

    units.push({ title: rawUnit.title, kind: "translation_passage", assignments });
  }

  const author = typeof raw.author === "string" && raw.author.trim() !== "" ? raw.author : "unknown";
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : "";
  const reason = typeof raw.reason === "string" ? raw.reason : "";

  return {
    ok: true,
    issues: [],
    plan: {
      schemaVersion: SEGMENTATION_PLAN_SCHEMA_VERSION,
      binding: {
        courseId: binding.courseId,
        sourceDigest: binding.sourceDigest,
        assets: [...binding.assets].map((asset) => ({
          assetKey: String(asset.assetKey),
          sha256: String(asset.sha256),
        })),
      },
      author,
      createdAt,
      reason,
      units,
    },
  };
}

// ---------------------------------------------------------------------------
// 校验：内容层（需要抽取产物）
// ---------------------------------------------------------------------------

/**
 * 计划校验所需的**源件事实**（抽取产物的最小投影）。
 *
 * 刻意只接受"页码 → 页内行数"与资产校验和，而**不接受正文**：
 * 内容层校验只需要知道"这一页有几行"，不需要读到那些行是什么。
 * 这直接支撑了隐私边界 —— 本模块的校验逻辑无法看到课程正文。
 */
export interface PlanSourceView {
  /** 课程 id（与 `plan.binding.courseId` 比对）。 */
  courseId: string;
  /** 既有 `SourceInventory.digest`。 */
  sourceDigest: string;
  /** assetKey → 该资产的事实。 */
  assets: Map<
    string,
    {
      sha256: string;
      /**
       * 页号 → 该页的**可寻址行数**。
       *
       * 无文本层的页不出现在这里（它是"不可寻址"，不是"0 行"）——
       * 这两者必须区分：前者要人去看源件，后者是空页。
       */
      lineCountByPage: Map<number, number>;
      /** 没有文本层的页码。 */
      pagesWithoutTextLayer: number[];
    }
  >;
}

/** 一个**内容行坐标**（只有页码与行号，**绝不含正文**）。 */
export interface PlanLineRef {
  assetKey: string;
  page: number;
  line: number;
}

/**
 * 一个**已解析的范围**：范围本身 + 它实际覆盖的行。
 *
 * 这是"计划决定的结构"与"抽取产物"交汇后的形态 —— 它已经过越界判定，
 * 因此 `lines` 里的每一个坐标都确实可寻址。投影只需按顺序把 `lines` 拼起来，
 * 不必再自己推一遍坐标。
 */
export interface ResolvedPlanAssignment {
  unitIndex: number;
  channel: PlanChannelKind;
  range: PlanLineRange;
  /** 该范围覆盖的行（闭区间，已确认落在页内可寻址范围中）。 */
  lines: PlanLineRef[];
  /** 源文档顺序键 —— 投影与计数都按它排序，保证确定性。 */
  orderKey: string;
}

/** 一个已解析的单元：每个通道的**全部**范围（不是一个）。 */
export interface ResolvedPlanUnit {
  index: number;
  title: string;
  kind: CourseSegmentKind;
  /**
   * 通道 → 该通道的范围列表，**已按源文档顺序排序**。
   *
   * 列表而不是单值：一个语义通道可以跨页或被其他结构打断。
   * 任何消费方都必须**遍历整个列表**，绝不能用 `find()` 只取第一条。
   */
  assignmentsByChannel: Record<PlanChannelKind, ResolvedPlanAssignment[]>;
}

/**
 * **规范解析结果**（canonical resolved representation）。
 *
 * ── 为什么必须有这一个结构（本模块最重要的一条纪律）──
 *
 * 早先的实现让**五条路径各自推导一遍**计划的结构：
 * 校验按 `assignments` 迭代、覆盖率另算一张 claim 表、计数再扫一遍、
 * 投影用 `find()` 取第一个 `reference_translation`、证据又读计数。
 * 五份推导必然漂移，而漂移的后果已经实测过：
 *
 * - 计划里两条 `reference_translation` 范围都被"算作已指派"，
 *   但投影只消费了第一条 ⇒ **第二条的内容静默消失**，而覆盖率还报"完整"；
 * - 同一单元同一通道的两个**重叠**范围被判成"幂等"，
 *   而投影把两个范围都拼进去 ⇒ **重叠的行被写了两遍**（7 行变 8 行）。
 *
 * 因此现在**只有一处推导**：本结构。校验、覆盖率、通道计数、投影、
 * 候选证据全部从它派生。任何"再算一遍"的写法都是缺陷。
 */
export interface ResolvedPlanContent {
  /**
   * 计划针对的**唯一**表示资产（V1 单资产契约）。
   *
   * 覆盖率的范围就是它 —— 计划明确只针对这一份资产，
   * 因此"每一行都被接住"这句话只对它成立。源目录里的其他资产属于
   * 其他材料，由自动分段照常处理（不在本计划的覆盖率承诺之内）。
   */
  targetAssetKey: string;
  units: ResolvedPlanUnit[];
  /** 每一行的**唯一**归属：`planLineKey(...)` → 单元与通道。 */
  claimByLine: Map<string, { unitIndex: number; channel: PlanChannelKind }>;
  /** 目标资产里没有被任何通道接住的行。 */
  unassigned: PlanLineRef[];
  /** 各通道覆盖的行数（**从 `claimByLine` 派生**，不是另算一遍）。 */
  channelLineCounts: {
    source: number;
    referenceTranslation: number;
    notes: number;
    ignoredFurniture: number;
  };
  /** 被显式标为家具的行数（= `channelLineCounts.ignoredFurniture`）。 */
  furnitureLineCount: number;
  /** 被某个**内容**通道接住的行数。 */
  assignedLineCount: number;
  /** 目标资产可寻址的行总数。 */
  totalLineCount: number;
}

/** 内容层解析结果。`resolved` 仅在 `ok` 时非 null。 */
export interface PlanContentResolution {
  ok: boolean;
  issues: PlanValidationIssue[];
  resolved: ResolvedPlanContent | null;
}

/** 内容层校验的完整结果（`resolvePlanContent` 的兼容视图）。 */
export interface PlanContentValidation {
  ok: boolean;
  issues: PlanValidationIssue[];
  /** 未指派的内容行（**分页/逐行**列出，供 UI 高亮；不含正文）。 */
  unassigned: PlanLineRef[];
  /** 被显式标为家具的行数。 */
  furnitureLineCount: number;
  /** 被某个通道接住的行数。 */
  assignedLineCount: number;
  /** 该资产可寻址的行总数。 */
  totalLineCount: number;
  /** **规范解析结果**（`ok` 时非 null）—— 投影与计数都从它派生。 */
  resolved: ResolvedPlanContent | null;
}

/** 一行内容的唯一键（与投影的 claim 表共用同一套坐标）。 */
export function planLineKey(assetKey: string, page: number, line: number): string {
  return `${assetKey}\u0000${page}\u0000${line}`;
}

/**
 * 内容层校验：绑定新鲜度 → 选择器合法性 → 重叠 → **覆盖率**。
 *
 * ── 覆盖率为什么必须在这里失败关闭 ──
 *
 * 任务书把这条列为关键边界：**人工分段绝不能静默丢内容。**
 * 一段被漏掉的行会让课程包在一个看不见的地方缺内容 —— 而"缺的那部分"
 * 恰恰可能是学习者最需要的一题。因此规则是：
 *
 * > 每一行要么落在某个单元的某个通道里，要么被**人**显式标成
 * > `ignored_furniture`。**没有第三种出路。**
 *
 * 特别注意：工具**绝不**因为"这一行在别的页也出现过"就自行判定它是页眉 ——
 * 重复是**线索**，不是**决定**。必须有人把它标成家具。
 */
export function validatePlanContent(
  plan: SegmentationPlanFile,
  source: PlanSourceView,
): PlanContentValidation {
  const resolution = resolvePlanContent(plan, source);
  const resolved = resolution.resolved;
  return {
    ok: resolution.ok,
    issues: resolution.issues,
    unassigned: resolved?.unassigned ?? [],
    furnitureLineCount: resolved?.furnitureLineCount ?? 0,
    assignedLineCount: resolved?.assignedLineCount ?? 0,
    totalLineCount: resolved?.totalLineCount ?? 0,
    resolved,
  };
}

/**
 * **把计划解析为唯一一份规范结构**（canonical resolved representation）。
 *
 * 这是计划内容层判定的**唯一实现**：绑定新鲜度、选择器越界、重叠、
 * 覆盖率、通道计数全部在这里一次算完，结果装在 `ResolvedPlanContent` 里。
 * 校验、投影、候选证据都消费同一个结果，不再各自推导。
 *
 * ── 三条失败关闭判据 ──
 *
 * 1. **绑定**：源摘要 / 资产校验和 / 课程 id 任一不符 ⇒ 坐标在这份源上无意义。
 * 2. **越界**：页无文本层 / 页号越界 / 行号越界 ⇒ 选择器取不到那一行。
 * 3. **重叠**：**任何**两个范围覆盖到同一行 ⇒ 失败关闭。
 *
 * ── 重叠为什么**连"同单元同通道"也不放过** ──
 *
 * 早先的实现把"同单元同通道的重复范围"当作幂等（UI 重复提交）而放行，
 * 但投影会把两个范围**都**拼进同一段正文 ⇒ 重叠的行被写两遍。
 * 实测形态：7 个不同行变成 notes 计数 8。
 *
 * 一条计划是**一份关于结构的声明**。同一个通道里的两个范围重叠，
 * 意味着这份声明对那几行说了两次 —— 系统无从知道人想要一次还是两次。
 * 静默去重等于**替人猜**，而猜错会让课程内容量错误。
 * 因此 V1 的不变量收紧为：
 *
 * > **每一行抽取内容最多只有一个最终归属。**
 *
 * 这也正是覆盖率判据的同一句话（"每一行要么落在某个通道里、要么被显式标为家具"），
 * 只是从"至少一次"补齐为"恰好一次"。因此**精确重复的范围必须由人去删掉一条** ——
 * UI 会阻止明显的重复，但**服务端与领域层始终是权威判据**。
 *
 * 刻意**不做**"静默去重"：那会掩盖一份自相矛盾的计划，
 * 而它恰恰是"人以为系统按自己的结构跑了、实际没有"这类静默分叉的来源。
 */
export function resolvePlanContent(plan: SegmentationPlanFile, source: PlanSourceView): PlanContentResolution {
  const issues: PlanValidationIssue[] = [];

  // ── 1) 绑定：课程 id ──
  if (plan.binding.courseId !== source.courseId) {
    issues.push({
      code: "plan_binding_course_mismatch",
      where: "binding.courseId",
      detail:
        `计划绑定的是课程 ${JSON.stringify(plan.binding.courseId)}，而当前候选是 ` +
        `${JSON.stringify(source.courseId)}。计划不可跨课程复用 —— 请对正确的课程重新标注。`,
    });
  }

  // ── 2) 绑定：源摘要（**陈旧语义的核心**）──
  if (plan.binding.sourceDigest !== source.sourceDigest) {
    issues.push({
      code: "plan_binding_source_stale",
      where: "binding.sourceDigest",
      detail:
        `**分段计划已陈旧**：计划绑定源摘要 ${plan.binding.sourceDigest.slice(0, 16)}…，` +
        `当前源摘要是 ${source.sourceDigest.slice(0, 16)}…。` +
        `选择器是"第几页第几行"，它**只对那一份源字节有意义**。` +
        `**绝不**把旧选择器静默套到新源上 —— 请重新标注并保存计划，然后重新生成候选。`,
    });
  }

  // ── 3) 绑定：资产校验和 ──
  for (const bound of plan.binding.assets) {
    const asset = source.assets.get(bound.assetKey);
    if (!asset) {
      issues.push({
        code: "plan_binding_asset_missing",
        where: `binding.assets[${bound.assetKey}]`,
        detail:
          `计划引用了当前源里不存在的资产 ${JSON.stringify(bound.assetKey)}。` +
          `源件集合已经变了 —— 计划必须重新标注。`,
      });
      continue;
    }
    if (asset.sha256 !== bound.sha256) {
      issues.push({
        code: "plan_binding_asset_stale",
        where: `binding.assets[${bound.assetKey}]`,
        detail:
          `资产 ${JSON.stringify(bound.assetKey)} 的字节已变化（计划记录 ` +
          `${bound.sha256.slice(0, 16)}…，当前 ${asset.sha256.slice(0, 16)}…）。` +
          `计划已陈旧，**失败关闭**。`,
      });
    }
  }

  /*
   * ── 4) 选择器越界 / 重叠 / 覆盖率 ──
   *
   * 覆盖率判定需要**每一页的可寻址行数**。若绑定已经陈旧，行号很可能整体
   * 错位，此时再逐个报"越界"只会淹没真正的原因（源变了）。
   * 因此陈旧时**跳过**后续逐行判定，只报那条陈旧 —— 让人直接去重新标注。
   */
  const bindingFresh = !issues.some(
    (issue) =>
      issue.code === "plan_binding_source_stale" ||
      issue.code === "plan_binding_asset_stale" ||
      issue.code === "plan_binding_asset_missing" ||
      issue.code === "plan_binding_course_mismatch",
  );

  if (!bindingFresh) {
    return {
      ok: false,
      issues,
      resolved: null,
    };
  }

  /*
   * ── 4) V1 单资产契约：计划**只针对一份表示资产** ──
   *
   * 人工分段是"这一个翻译文档的结构"（见 docs §17）。
   * 跨材料/跨资产的计划在 V1 **不被支持**，而且必须**显式拒绝**：
   * 一份横跨两份资产的计划若被部分接受，投影只会拿到主材料的那一份文档，
   * 于是另一份资产上的范围会**静默产出空正文** —— 一个没有任何异常信号的
   * "看起来正常、实则缺内容"的候选。那正是本模块最不能接受的形态。
   *
   * 因此判据是"计划引用的资产必须恰好是**一个**"。
   */
  const referencedAssetKeys = new Set<string>();
  for (const unit of plan.units) {
    for (const assignment of unit.assignments) referencedAssetKeys.add(assignment.range.assetKey);
  }
  const sortedReferenced = [...referencedAssetKeys].sort();
  if (sortedReferenced.length > 1) {
    issues.push({
      code: "plan_multi_asset_unsupported",
      where: "<binding.assets>",
      detail:
        `V1 的人工分段计划**只针对一份表示资产**，但这份计划引用了 ${sortedReferenced.length} 份：` +
        `${sortedReferenced.map((key) => JSON.stringify(key)).join("、")}。` +
        `跨资产的计划在 V1 **不被支持**（投影只会拿到主材料那一份文档，` +
        `另一份资产上的范围会静默产出空正文）。**失败关闭** —— ` +
        `请为每一份资产分别建计划；若确实需要跨材料结构，请先确认契约。`,
    });
    return { ok: false, issues, resolved: null };
  }

  const targetAssetKey = sortedReferenced[0]!;
  const targetAsset = source.assets.get(targetAssetKey);
  if (targetAsset === undefined) {
    issues.push({
      code: "plan_range_asset_unknown",
      where: `<binding.assets[${targetAssetKey}]>`,
      detail: `计划引用的资产 ${JSON.stringify(targetAssetKey)} 在当前源里不存在 —— 计划必须重新标注。`,
    });
    return { ok: false, issues, resolved: null };
  }

  // 覆盖率的分母**只有目标资产**（计划只对它的完整性作出承诺）
  let totalLineCount = 0;
  for (const count of targetAsset.lineCountByPage.values()) totalLineCount += count;

  const claimByLine = new Map<string, { unitIndex: number; channel: PlanChannelKind }>();
  const units: ResolvedPlanUnit[] = [];
  /** 范围 → 它覆盖的行，供投影直接使用（避免第二处坐标推导）。 */
  const resolvedByAssignment = new Map<PlanAssignment, ResolvedPlanAssignment>();

  for (const [unitIndex, unit] of plan.units.entries()) {
    const resolvedUnit: ResolvedPlanUnit = {
      index: unitIndex,
      title: unit.title,
      kind: unit.kind,
      assignmentsByChannel: {
        source: [],
        reference_translation: [],
        notes: [],
        ignored_furniture: [],
      },
    };

    for (const assignment of unit.assignments) {
      const { assetKey, page, lineStart, lineEnd } = assignment.range;
      const channel = assignment.channel;
      const where = `units[${unitIndex}]/${channel}@${assetKey}:p${page}:${lineStart}-${lineEnd}`;

      // -- 资产必须存在且**必须就是目标资产**（单资产契约的逐条强制）--
      const asset = source.assets.get(assetKey);
      if (!asset) {
        issues.push({
          code: "plan_range_asset_unknown",
          where,
          detail: `范围引用了当前源里不存在的资产 ${JSON.stringify(assetKey)}。`,
        });
        continue;
      }

      // -- 页必须有文本层（无文本层 = 不可寻址，不是"空页"）--
      if (asset.pagesWithoutTextLayer.includes(page)) {
        issues.push({
          code: "plan_range_page_without_text_layer",
          where,
          detail:
            `第 ${page} 页**没有文本层**，因此这一页的行号不可寻址。` +
            `本版本不做 OCR —— 该页上的内容无法被计划的坐标选中。` +
            `请核对该页在源件里的真实形态。`,
        });
        continue;
      }

      // -- 页号必须在范围内 --
      const lineCount = asset.lineCountByPage.get(page);
      if (lineCount === undefined) {
        issues.push({
          code: "plan_range_page_out_of_bounds",
          where,
          detail:
            `第 ${page} 页超出该资产的可寻址页范围（` +
            `${asset.lineCountByPage.size} 页有文本层）。选择器越界。`,
        });
        continue;
      }

      // -- 行号必须在范围内 --
      if (lineEnd > lineCount) {
        issues.push({
          code: "plan_range_line_out_of_bounds",
          where,
          detail:
            `第 ${page} 页只有 ${lineCount} 行，而范围要求到第 ` +
            `${lineEnd} 行。选择器越界 —— 请重新核对这一页的行号。`,
        });
        continue;
      }

      /*
       * ── 逐行认领：**任何**第二次认领都是失败 ──
       *
       * 包括同单元同通道（见 `resolvePlanContent` 的说明）。
       * 判据是"这一行已经有归属了"，而不是"归给谁"。
       */
      const lines: PlanLineRef[] = [];
      for (let line = lineStart; line <= lineEnd; line += 1) {
        const key = planLineKey(assetKey, page, line);
        const existing = claimByLine.get(key);
        if (existing === undefined) {
          claimByLine.set(key, { unitIndex, channel });
          lines.push({ assetKey, page, line });
          continue;
        }

        const samePlace = existing.channel === channel && existing.unitIndex === unitIndex;
        issues.push({
          code: "plan_range_overlap",
          where,
          detail: samePlace
            ? `第 ${page} 页第 ${line} 行被**同一通道重复指派了两次**` +
              `（units[${unitIndex}]/${channel}）。` +
              `计划是**一份**结构声明；同一行出现两次意味着系统无法知道你要一次还是两次，` +
              `而把两个范围都拼进正文会让内容**重复** —— 失败关闭，请删掉多余的那条范围。`
            : `第 ${page} 页第 ${line} 行被指派了两次：` +
              `已在 units[${existing.unitIndex}]/${existing.channel}，此处又出现在 ` +
              `units[${unitIndex}]/${channel}。` +
              `同一行不可能同时是原文与参考译文（或分属两个单元）—— 失败关闭，请修正计划。`,
        });

        /*
         * 已经冲突 ⇒ 这一行**不再**进入 `lines`。
         *
         * 理由：`resolved` 只在 `ok` 时被消费，而 `ok` 必然为 false
         * （issues 非空）。因此不需要为"冲突时投影该怎么办"发明语义 ——
         * 计划根本不会被采用。这里只是让冲突行不重复计数。
         */
      }

      if (lines.length > 0) {
        const resolvedAssignment: ResolvedPlanAssignment = {
          unitIndex,
          channel,
          range: assignment.range,
          lines,
          // 源文档顺序：资产键 → 页 → 起始行。同一通道的多个范围据此拼接。
          orderKey: `${assetKey}\u0000${String(page).padStart(8, "0")}\u0000${String(lineStart).padStart(8, "0")}`,
        };
        resolvedByAssignment.set(assignment, resolvedAssignment);
        resolvedUnit.assignmentsByChannel[channel].push(resolvedAssignment);
      }
    }

    // 每个通道的范围按源文档顺序排序 ⇒ 投影的拼接顺序有唯一定义
    for (const channel of PLAN_CHANNEL_KINDS) {
      resolvedUnit.assignmentsByChannel[channel].sort((a, b) => a.orderKey.localeCompare(b.orderKey));
    }
    units.push(resolvedUnit);
  }

  /*
   * ── 5) 覆盖率：未指派的内容行必须**可见**并且**阻断** ──
   *
   * 逐行、逐页比对**目标资产**。落在 `ignored_furniture` 里的行满足覆盖率
   * （那是**人**显式声明的），因此不算未指派。
   */
  const unassigned: PlanLineRef[] = [];
  for (const [page, lineCount] of targetAsset.lineCountByPage) {
    for (let line = 1; line <= lineCount; line += 1) {
      if (!claimByLine.has(planLineKey(targetAssetKey, page, line))) {
        unassigned.push({ assetKey: targetAssetKey, page, line });
      }
    }
  }

  if (unassigned.length > 0) {
    issues.push({
      code: "plan_unassigned_content",
      where: "<coverage>",
      detail:
        `**有 ${unassigned.length} 行抽取内容没有被任何指派接住**。` +
        `人工分段绝不能静默丢内容：每一行要么落在某个单元的某个通道里，` +
        `要么被**人**显式标为 \`ignored_furniture\`。` +
        `注意工具**不会**因为某行在多页重复就自行判定它是页眉 —— ` +
        `"这是家具"必须由人明确声明。` +
        `未指派的行号见候选证据（只列页码与行号，不含正文）。`,
    });
  }

  /*
   * ── 6) 计数：**从 `claimByLine` 派生**（不是再扫一遍 assignments）──
   *
   * 这是 F2 的关键落点：早先计数按 assignments 累加，
   * 于是"两条 reference_translation 范围"被算作两段内容，
   * 而投影只消费了第一条 —— 计数与投影对不上，覆盖率却报"完整"。
   * 现在两者读的是同一张 claim 表。
   */
  let furnitureLineCount = 0;
  let assignedLineCount = 0;
  for (const entry of claimByLine.values()) {
    if (entry.channel === "ignored_furniture") furnitureLineCount += 1;
    else assignedLineCount += 1;
  }

  const channelLineCounts = {
    source: 0,
    referenceTranslation: 0,
    notes: 0,
    ignoredFurniture: furnitureLineCount,
  };
  for (const entry of claimByLine.values()) {
    if (entry.channel === "source") channelLineCounts.source += 1;
    else if (entry.channel === "reference_translation") channelLineCounts.referenceTranslation += 1;
    else if (entry.channel === "notes") channelLineCounts.notes += 1;
  }

  /*
   * ── `resolved` 的产出条件：**只要没有致命问题** ──
   *
   * 覆盖缺口（`plan_unassigned_content`）**不**阻止产出规范结构 ——
   * 计划照常被采用、照常按人的结构产段，缺口由那条阻断事项单独承载。
   * 若这里因为"有缺口"就不给 `resolved`，计划就会被作废并回退自动分段，
   * 于是人看到的**不是**自己标的那一份结构（静默分叉）。
   *
   * 反之，只要有**一条**致命问题，`resolved` 必须为 null：
   * 坐标越界/陈旧/重叠时强行产段会产出一份看起来正常、实则错位或重复的结构。
   */
  const fatal = issues.some((issue) => isFatalPlanValidationCode(issue.code));
  const ok = issues.length === 0;
  const resolved: ResolvedPlanContent | null = fatal
    ? null
    : {
        targetAssetKey,
        units,
        claimByLine,
        unassigned,
        channelLineCounts,
        furnitureLineCount,
        assignedLineCount,
        totalLineCount,
      };

  return { ok, issues, resolved };
}

// ---------------------------------------------------------------------------
// 解析（坏 JSON 是正常失败状态）
// ---------------------------------------------------------------------------

export interface PlanParseResult {
  ok: boolean;
  issues: PlanValidationIssue[];
  plan: SegmentationPlanFile | null;
}

/**
 * 解析计划文件的原始文本。
 *
 * 与既有 F-D 同一套纪律：坏 JSON 是**可预期的失败状态**，不是崩溃。
 * 一份被截断的计划必须产出一个明确的 invalid 结论，其后果是确定的：
 * 候选生成拒绝它、门禁不 PROMOTABLE、零晋升、零建链、**不碰数据库**。
 *
 * 注意：**解析失败时绝不回退到自动分段并当作无事发生。**
 * 那会让"我明明写了计划"与"系统按自动结果跑"两个事实悄悄分叉 ——
 * 操作者以为自己的结构生效了，实际没有。
 */
export function parseSegmentationPlan(raw: string): PlanParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          code: "plan_json_invalid",
          where: "<root>",
          detail:
            `分段计划不是合法 JSON（解析失败）：${(error as Error).message}。` +
            `候选生成**失败关闭**（不会静默回退到自动分段）—— 请修正或重新生成计划。`,
        },
      ],
      plan: null,
    };
  }
  const shape = validatePlanShape(parsed);
  return { ok: shape.ok, issues: shape.issues, plan: shape.plan };
}
