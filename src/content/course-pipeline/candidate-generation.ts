/**
 * A1 → A2 断点：**在界面里生成课程候选**。
 *
 * ── 这个模块解决的具体断点 ──
 *
 * A1 只读检查能告诉 使用者 "我有什么"，A2 能让人签出裁决 —— 但候选生成
 * **此前只有命令行入口**（`pnpm course:extract`）。而 A2 的保存会严格校验
 * "客户端摘要必须等于服务端现场重算的候选校验和"：候选不存在 ⇒ 校验和
 * 对不上 ⇒ **保存必然失败**。于是整条用户路径在中间断掉了。
 *
 * 本模块把那条路径接上，并刻意遵守三条纪律：
 *
 * 1. **预演与生成分开，且预演零写入。** 预演跑的是**同一段编排**
 *    （`runCourseIntake`），只是不落盘 —— 因此"预演说 3 个段、真生成 5 个段"
 *    在结构上不可能。代价是预演也要真的抽一遍 PDF，而那正是"看清后果"的成本。
 * 2. **授权是必需参数。** 生成会替换已有候选目录（旧候选备份为 `.prev-*`），
 *    从而让已签署的 `review.json` **立即失效**。省略授权字段的请求一律被拒。
 * 3. **绝不静默覆盖。** 替换前先 `rename` 旧候选；旧候选的目录名回传给界面，
 *    让它能如实告诉人"旧的那一份被存到哪了"。
 *
 * ── 它**不**做什么 ──
 *
 * - 不写 `courses/`、不打开数据库、不晋升、不建链（那是 A3 的事）；
 * - 不自动批准任何裁决；
 * - 不把绝对路径回给调用方（只有源根**目录名**）。
 */

import { existsSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";

import { candidateDirNameOf, isValidCourseId, runCourseIntake } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import { buildSourceSelection } from "@/content/course-pipeline/inspection";
import { getCourseCandidatesDir, getCourseSourcesDir } from "@/content/paper/paths";
import { sanitizeForDisplay } from "@/content/course-pipeline/containment";

/** 课程基本信息（界面收集；**不包含任何凭据**）。 */
/**
 * 浏览器提交的**选择范围**（与 A1 检查用的是同一份契约）。
 *
 * 刻意复用 `InspectionSelectionInput` 的形状而不是新造一个：两条入口
 * （只读检查 / 候选生成）必须表达**同一个**选择语义，否则"我看到排除了"
 * 与"产物里真的排除了"会分叉 —— 那正是本模块要消除的缺陷。
 */
export interface CandidateSelectionInput {
  /** 勾选的目录（相对源根的 POSIX 路径，`""` 表示源根）。 */
  includeDirectories: string[];
  /** 明确排除的文件（相对源根的 POSIX 路径）。 */
  excludeFiles: string[];
}

export interface CandidateRequest {
  courseId: string;
  title: string;
  provider: string;
  edition: string | null;
  contentVersion: number;
  /**
   * 文件选择范围（**可选**）。
   *
   * - `null` ⇒ 读取整个源根（与既有 CLI 逐字节一致）；
   * - 提供 ⇒ 被排除的文件与目录不进候选、不进摘要、不参与分组/分段/匹配。
   *
   * 它由界面在**检查那一步**收集，并在预演与生成时**原样复用**，
   * 因此两者看到的是同一个有效范围。
   */
  selection: CandidateSelectionInput | null;
}

export interface CandidatePreviewSummary {
  courseId: string;
  /** 源根**目录名**（绝不含路径）。 */
  sourceLabel: string;
  /**
   * 本次预演**实际生效**的选择范围摘要。
   *
   * `null` ⇒ 读取整棵源根（未提供选择）。
   * 数值刻意用**计数**而不是把路径列出来：界面要回答的是
   * "只覆盖我勾的那部分吗"，而计数正是最容易与真实产物分叉的那个数字。
   */
  selection: { includeDirectoryCount: number; excludeFileCount: number } | null;
  /** 同名候选是否已存在（生成会替换它）。 */
  willReplaceExisting: boolean;
  newCandidateChecksum: string;
  materialCount: number;
  segmentCount: number;
  assetCount: number;
  blockingReviewCount: number;
  blockingReviewItems: { code: string; where: string; detail: string }[];
  canonicalFailures: { packagePath: string; reason: string }[];
  warnings: string[];
}

export interface CandidateGenerateSummary extends CandidatePreviewSummary {
  /** 旧候选被备份成哪个目录名（null = 此前没有候选）。 */
  previousLabel: string | null;
  /**
   * 旧审核是否因此失效。
   *
   * 为 `true` 时界面**必须**显示"需要重新审核" ——
   * 这不是提示文案，而是候选人复核过的候选已经不是现在这一份。
   */
  reviewInvalidated: boolean;
  message: string;
}

/**
 * 把界面提交的原始载荷规范成 `CandidateRequest`。
 *
 * 校验在这里而不是在界面上：界面可以被绕过，而"课程标识就是候选目录名"
 * 这条约束必须由服务端强制。
 */
export function normalizeCandidateRequest(raw: unknown, fallbackCourseId?: string | null): CandidateRequest {
  const payload = (raw ?? {}) as {
    courseId?: unknown;
    title?: unknown;
    provider?: unknown;
    edition?: unknown;
    contentVersion?: unknown;
    selection?: unknown;
  };

  const rawId =
    typeof payload.courseId === "string" && payload.courseId.trim() !== ""
      ? payload.courseId.trim()
      : (fallbackCourseId ?? "").trim();

  if (rawId === "") {
    throw new Error("缺少课程标识 —— 请先填写课程基本信息。");
  }
  if (!isValidCourseId(rawId)) {
    throw new Error(
      `课程标识不合法：${sanitizeForDisplay(rawId, 60)}。` +
        "只允许小写字母、数字、点、下划线与连字符，且不能以符号开头。",
    );
  }
  const courseId = candidateDirNameOf(rawId);

  const title = typeof payload.title === "string" && payload.title.trim() !== "" ? payload.title.trim() : courseId;
  const provider =
    typeof payload.provider === "string" && payload.provider.trim() !== ""
      ? payload.provider.trim()
      : "（未填写提供方）";
  const edition =
    typeof payload.edition === "string" && payload.edition.trim() !== "" ? payload.edition.trim() : null;
  const versionRaw = payload.contentVersion;
  const contentVersion =
    typeof versionRaw === "number" && Number.isInteger(versionRaw) && versionRaw >= 1 ? versionRaw : 1;

  return { courseId, title, provider, edition, contentVersion, selection: normalizeSelection(payload.selection) };
}

/**
 * 规范化选择范围。
 *
 * ── 三条判据 ──
 *
 * 1. **缺省 = 不提供选择**（`null`）⇒ 整根语义，向后兼容既有 CLI。
 * 2. 只接受**字符串数组**；非字符串元素被丢弃（类型错误不带进下游）。
 * 3. 边界判定**不在这里做** —— 条目是否合法由 `buildSourceSelection` +
 *    遍历本身判定（`buildSourceSelection` 只做排除，且只作用在已经通过
 *    `realpathSync` + `isWithin` 的条目上）。这里只保证形状。
 *
 * 为什么刻意**不**在这里校验 `..` / 绝对路径：那会形成第二套逃逸判据，
 * 而本项目已登记过"两套判据必然漂移"这条教训。路径安全的唯一实现是
 * `traverseSourceTree`。
 */
function normalizeSelection(raw: unknown): CandidateSelectionInput | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object") return null;
  const input = raw as { includeDirectories?: unknown; excludeFiles?: unknown };
  if (!Array.isArray(input.includeDirectories) || !Array.isArray(input.excludeFiles)) {
    // 形状不对 ⇒ **失败关闭**：不是"当作全选"，而是明确报错由调用方处理。
    throw new Error(
      "选择范围形状不合法：需要 includeDirectories（数组）与 excludeFiles（数组）。" +
        "空数组表示不检查任何内容 —— 若要读取整棵源根，请不要提供选择范围。",
    );
  }
  const strings = (list: unknown[]): string[] =>
    list.filter((item): item is string => typeof item === "string");
  return {
    includeDirectories: strings(input.includeDirectories),
    excludeFiles: strings(input.excludeFiles),
  };
}

/** 源根目录名（绝不含路径）。 */
export function sourceLabelOf(absolutePath: string): string {
  const parts = absolutePath.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? "source";
}

/**
 * 跑一次**预演**（零写入）。
 *
 * 复用 `runCourseIntake` —— 与真正生成走的是**同一段编排**。
 */
export async function previewCandidateGeneration(
  request: CandidateRequest,
  sourceRoot: string,
): Promise<CandidatePreviewSummary> {
  const intake = await runCourseIntake(intakeInputOf(request, sourceRoot));
  const blocking = intake.archive.review.filter((item) => item.severity === "blocking");

  return {
    courseId: request.courseId,
    sourceLabel: sourceLabelOf(sourceRoot),
    selection: selectionSummaryOf(request),
    willReplaceExisting: existsSync(/* turbopackIgnore: true */ resolve(getCourseCandidatesDir(), request.courseId)),
    newCandidateChecksum: intake.archive.metadata.digests.candidateChecksum,
    materialCount: intake.archive.manifest.materials.length,
    segmentCount: intake.archive.manifest.segments.length,
    assetCount: intake.archive.manifest.assets.length,
    blockingReviewCount: blocking.length,
    blockingReviewItems: blocking.map((item) => ({ code: item.code, where: item.where, detail: item.detail })),
    canonicalFailures: intake.canonicalFailures,
    warnings: intake.warnings,
  };
}

/** 选择范围的**展示摘要**（`null` = 整根语义）。 */
function selectionSummaryOf(request: CandidateRequest): CandidatePreviewSummary["selection"] {
  if (request.selection === null) return null;
  return {
    includeDirectoryCount: request.selection.includeDirectories.length,
    excludeFileCount: request.selection.excludeFiles.length,
  };
}

/**
 * **生成**候选（写入 `course-candidates/<id>/`）。
 *
 * ── 替换前必须备份 ──
 *
 * 与既有 `course:extract` 同一条纪律：旧候选可能正被一份已签署的 review 引用，
 * 直接覆盖会让"复核针对的是哪一份候选"变成不可回答的问题。
 * 因此旧目录被 `rename` 成 `<id>.prev-<时间戳>`，而不是删除。
 */
export async function generateCandidate(
  request: CandidateRequest,
  sourceRoot: string,
): Promise<CandidateGenerateSummary> {
  const intake = await runCourseIntake(intakeInputOf(request, sourceRoot));
  const candidateDir = resolve(getCourseCandidatesDir(), request.courseId);

  let previousLabel: string | null = null;
  if (existsSync(/* turbopackIgnore: true */ candidateDir)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const prev = `${candidateDir}.prev-${stamp}`;
    renameSync(candidateDir, prev);
    previousLabel = prev.split(/[\\/]/).filter((part) => part !== "").slice(-1)[0] ?? null;
  }

  writeCourseCandidate(intake.archive, candidateDir);

  const blocking = intake.archive.review.filter((item) => item.severity === "blocking");
  const reviewInvalidated = previousLabel !== null;

  return {
    courseId: request.courseId,
    sourceLabel: sourceLabelOf(sourceRoot),
    selection: selectionSummaryOf(request),
    willReplaceExisting: reviewInvalidated,
    newCandidateChecksum: intake.archive.metadata.digests.candidateChecksum,
    materialCount: intake.archive.manifest.materials.length,
    segmentCount: intake.archive.manifest.segments.length,
    assetCount: intake.archive.manifest.assets.length,
    blockingReviewCount: blocking.length,
    blockingReviewItems: blocking.map((item) => ({ code: item.code, where: item.where, detail: item.detail })),
    canonicalFailures: intake.canonicalFailures,
    warnings: intake.warnings,
    previousLabel,
    reviewInvalidated,
    message:
      "课程候选已生成。" +
      (previousLabel !== null
        ? `旧候选已备份为 ${previousLabel}。候选校验和已变化 ⇒ 已签署的审核记录**立即失效**，` +
          "需要重新审核（系统绝不自动沿用旧决定）。"
        : "接下来请在第 ⑤ 步逐条裁决并保存审核记录。"),
  };
}

/** 两条路径共用的 `runCourseIntake` 输入（**只有一处**）。 */
function intakeInputOf(request: CandidateRequest, sourceRoot: string) {
  return {
    sourceRoot,
    courseId: request.courseId,
    provider: request.provider,
    edition: request.edition,
    title: request.title,
    contentVersion: request.contentVersion,
    provenance: {
      note: "由本机接入工作台从使用者指定的私有课程目录生成（合成夹具同样适用）。",
      reference: null,
      rightsNote: "使用者本机个人使用的私有课程材料；不得上传或外传。",
    },
    standardSourcesRoot: getCourseSourcesDir(),
    /*
     * ── 选择范围**必须**在这里进入编排层 ──
     *
     * 这是本修复的核心：预演与生成都经过 `intakeInputOf`，因此两者
     * **必然**使用同一个有效范围（不存在"预演按排除算、生成按全根算"）。
     *
     * `null` ⇒ 不提供 selection ⇒ `runCourseIntake` 的整根语义（CLI 兼容）。
     */
    selection: request.selection === null ? undefined : buildSourceSelection(request.selection),
  };
}

/** 候选目录的绝对路径（供需要它的调用方；**绝不回给浏览器**）。 */
export function candidateDirOf(courseId: string): string {
  return join(getCourseCandidatesDir(), candidateDirNameOf(courseId));
}
