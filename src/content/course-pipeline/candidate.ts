/**
 * 候选包生成（candidate package）。
 *
 * ── 产物分两个文件，职责严格分开 ──
 *
 * | 文件 | 是什么 | 谁读 |
 * | --- | --- | --- |
 * | `course.json` | **规范化课程包**（稳定契约，`schemaVersion: 1`） | 生产 `NormalizedCourseImporter` |
 * | `candidate.json` | 抽取/分组的**全部证据**与复核事项 | 只有人工与本流水线 |
 *
 * 这条分工是本模块最重要的设计决定：
 *
 * **不为候选元数据改 Course Manifest 契约。** 丰富的抽取证据
 * （逐页文本、逐段线索、匹配分解、源件异常）属于 `candidate.json`；
 * 最终 `course.json` 继续使用**现有稳定锚点模型**
 * （`representationId` / `pageStart` / `pageEnd` / `quote`）。
 * 这样"候选阶段引入了什么新证据"与"运行时课程包长什么样"互不牵连，
 * 且 `schemaVersion` 不必因为流水线的内部需要而上升。
 *
 * ── 硬规则 ──
 *
 * - **绝不写绝对路径**进任何一个文件（源根标签只有目录名）。
 * - **绝不生成内容。** 段正文全部来自源件抽取；没有就是没有。
 * - 候选包**不在 `courses/` 下**，因此生产导入器在原理上看不见它。
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COURSE_MANIFEST_SCHEMA_VERSION } from "@/domain/course";
import type {
  CourseAsset,
  CourseMaterial,
  CoursePackageContent,
  CourseSegment,
} from "@/content/course/types";
import { COURSE_ASSET_MIME_BY_EXTENSION } from "@/content/course/types";
import type {
  CandidateMatchingResult,
  CandidateReviewItem,
  CourseCandidateMetadata,
  CourseModuleHint,
  MaterialGroupingResult,
  MaterialSegmentation,
  ParsedDocument,
  ProposedSegment,
  SegmentationModeEvidence,
  SourceAnomaly,
  SourceInventory,
} from "./types";
import { COURSE_PIPELINE_VERSION } from "./types";
import {
  courseCandidateChecksum,
  courseGroupingDigest,
  courseMatchingDigest,
  courseSegmentationDigest,
} from "./digests";

export const COURSE_CANDIDATE_FILENAME = "candidate.json";
export const COURSE_MANIFEST_FILENAME = "course.json";
export const COURSE_CANDIDATE_ASSETS_DIR = "assets";

/**
 * 把内存中的课程模型序列化为 `course.json` 的**磁盘契约**。
 *
 * ── 为什么必须有这一层转换（本项目已经踩过同一个坑）──
 *
 * 内存模型 `CourseAsset` 用 `relativePath`（代码里的语义名），
 * 而磁盘契约用 `path`（见 `docs/course-package.md` §6 与 `validator.ts`）。
 * 直接 `JSON.stringify(course)` 会写出 `relativePath`，于是包
 * **无法通过生产校验器** —— 实测报错：
 * `assets[0].path: Invalid input: expected string, received undefined`。
 *
 * 真题流水线在 `content/pipeline/candidate.ts` 的 `toManifestJson` 里
 * 记录过完全相同的缺陷。这里使用同一套处置：**只改字段名，不改任何内容**。
 * 导入器读回时会把 `path` 再转成 `relativePath`。
 */
export function toCourseManifestJson(course: CoursePackageContent): unknown {
  return {
    id: course.id,
    schemaVersion: course.schemaVersion,
    provider: course.provider,
    edition: course.edition,
    title: course.title,
    contentVersion: course.contentVersion,
    provenance: {
      note: course.provenance.note,
      reference: course.provenance.reference,
      rightsNote: course.provenance.rightsNote,
    },
    materials: course.materials.map((material) => ({
      id: material.id,
      title: material.title,
      representations: material.representations.map((representation) => ({
        id: representation.id,
        assetId: representation.assetId,
        label: representation.label,
      })),
    })),
    segments: course.segments.map((segment) => ({
      id: segment.id,
      materialId: segment.materialId,
      kind: segment.kind,
      order: segment.order,
      title: segment.title,
      representationId: segment.representationId,
      anchor: {
        pageStart: segment.anchor.pageStart,
        pageEnd: segment.anchor.pageEnd,
        quote: segment.anchor.quote,
      },
      audioAssetId: segment.audioAssetId,
      startSeconds: segment.startSeconds,
      endSeconds: segment.endSeconds,
      text: segment.text,
      transcript: segment.transcript,
      referenceTranslation: segment.referenceTranslation,
      notes: segment.notes,
    })),
    assets: course.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      // ← 内存 `relativePath` → 磁盘契约 `path`。这是本函数存在的唯一理由。
      path: asset.relativePath,
      mimeType: asset.mimeType,
      bytes: asset.bytes,
      checksum: asset.checksum,
      label: asset.label,
    })),
  };
}

// ---------------------------------------------------------------------------
// 候选包内容
// ---------------------------------------------------------------------------

export interface CourseCandidateArchive {
  courseId: string;
  /** 包内相对路径 → 字节。含 `course.json`。 */
  files: Map<string, Buffer>;
  manifest: CoursePackageContent;
  metadata: CourseCandidateMetadata;
  review: CandidateReviewItem[];
}

export interface BuildCourseCandidateInput {
  courseId: string;
  provider: string;
  edition: string | null;
  title: string;
  contentVersion: number;
  provenance: { note: string; reference: string | null; rightsNote: string };
  sourceRootLabel: string;
  inventory: SourceInventory;
  /** assetKey → 该资产的内容字节（只含**要进入包**的资产）。 */
  assetBytes: Map<string, Buffer>;
  documents: ParsedDocument[];
  grouping: MaterialGroupingResult;
  segmentation: MaterialSegmentation[];
  /**
   * 段落结构的来源证据（自动 / 人工分段计划）。
   *
   * **必填**：省略即类型错误。理由与 F12 把 `gate` 做成必需参数相同 ——
   * "记得传"是不可靠的，而漏传一次会让候选**看不出**结构是人工定的，
   * 那是一条静默的语义丢失。默认值由调用方显式使用
   * `automaticSegmentationEvidence()` 表达。
   */
  segmentationMode: SegmentationModeEvidence;
  /**
   * 计划**未被采用**的原因（校验失败时非空、且只有失败时才非空）。
   *
   * 由调用方从 `plan-resolve.ts` 的结论转交 —— 候选构建是纯函数（不读盘），
   * 把"计划为什么不能用"的判据留在那一处，避免两处漂移。
   *
   * 非空 ⇒ 候选带**阻断且不可裁决**的 `plan_binding_mismatch` 事项：
   * 当前候选结构**不是**人计划的那一份，因此无论复核怎么写都不得晋升。
   */
  planIssues?: { code: string; where: string; detail: string }[];
  matching: CandidateMatchingResult;
  createdAt: string;
}

/**
 * 组装候选包。
 *
 * 只产生内存中的文件映射与元数据 —— 写盘由调用方决定（`writeCourseCandidate`），
 * 因此"构建"这一步是纯函数式、可在测试里穷举的。
 */
export function buildCourseCandidate(input: BuildCourseCandidateInput): CourseCandidateArchive {
  const files = new Map<string, Buffer>();

  // ── 1) 资产：用**确定性的包内路径**（原文件名可能含空格/中文/重名） ──
  const assetPathByKey = new Map<string, string>();
  const assets: CourseAsset[] = [];

  const includedAssets = input.inventory.assets.filter((asset) => input.assetBytes.has(asset.assetKey));
  for (const asset of [...includedAssets].sort((a, b) => a.assetKey.localeCompare(b.assetKey))) {
    const bytes = input.assetBytes.get(asset.assetKey)!;
    const relativePath = `${COURSE_CANDIDATE_ASSETS_DIR}/${asset.assetKey}${asset.extension}`;
    assetPathByKey.set(asset.assetKey, relativePath);
    files.set(relativePath, bytes);

    // MIME 以**扩展名映射**为准（不信任任何声明），与生产校验器同一判据
    const mimeType = COURSE_ASSET_MIME_BY_EXTENSION[asset.extension];
    if (mimeType === undefined) continue;

    assets.push({
      id: asset.assetKey,
      kind: mimeType.startsWith("audio/") ? "audio" : mimeType.startsWith("image/") ? "image" : "document",
      relativePath,
      mimeType,
      bytes: bytes.length,
      checksum: createHash("sha256").update(bytes).digest("hex"),
      label: asset.basename,
    });
  }

  // ── 2) 材料：来自分组提案，但**只保留有段引用的表示** ──
  //
  // 为什么不能把所有提案里的所有表示都塞进 materials：
  // 校验器要求"一个资产只能属于一份材料"。若某个资产的扩展名不在允许列表内
  // （kind === "unsupported"），它不会有 asset 条目，于是表示会指向不存在的资产
  // ⇒ 包校验失败。因此这里**只声明真的进入了包的表示**。
  const representedKeys = new Set<string>();
  for (const material of input.segmentation) {
    const proposal = input.grouping.proposals.find((item) => item.id === material.materialProposalId);
    if (!proposal) continue;
    for (const representation of proposal.representations) {
      if (assetPathByKey.has(representation.assetKey)) representedKeys.add(representation.assetKey);
    }
  }

  const materials: CourseMaterial[] = [];
  const segmentRepresentationId = new Map<string, string>();

  for (const proposal of [...input.grouping.proposals].sort((a, b) => a.id.localeCompare(b.id))) {
    const representations = proposal.representations
      .filter((representation) => representedKeys.has(representation.assetKey))
      .map((representation) => ({
        id: representation.assetKey,
        assetId: representation.assetKey,
        label: representation.label,
      }));
    if (representations.length === 0) continue;

    materials.push({
      id: proposal.id,
      title: proposal.title,
      representations,
    });
    for (const representation of representations) {
      segmentRepresentationId.set(`${proposal.id}/${representation.assetId}`, representation.id);
    }
  }

  // ── 3) 段：来自抽取结果。**按材料顺序连续编号 order。** ──
  const segments: CourseSegment[] = [];
  const materialOrder = new Map<string, number>();

  for (const material of input.segmentation) {
    const proposal = input.grouping.proposals.find((item) => item.id === material.materialProposalId);
    if (!proposal) continue;
    if (!materials.some((item) => item.id === proposal.id)) continue;

    for (const segment of [...material.segments].sort((a, b) => a.order - b.order)) {
      const order = materialOrder.get(proposal.id) ?? 0;
      materialOrder.set(proposal.id, order + 1);

      const representationId =
        segment.representationAssetKey === null
          ? null
          : (segmentRepresentationId.get(`${proposal.id}/${segment.representationAssetKey}`) ?? null);

      // 页码锚点**必须**同时声明表示（否则"第 12 页"指向哪份文件不可知）——
      // 这是生产校验器的硬要求。若拿不到表示 id，就放弃页码而保留引文。
      const hasPageAnchor = segment.anchor.pageStart !== null;
      const anchor = {
        pageStart: hasPageAnchor && representationId !== null ? segment.anchor.pageStart : null,
        pageEnd: hasPageAnchor && representationId !== null ? segment.anchor.pageEnd : null,
        quote: segment.anchor.quote,
      };

      const audioAssetId =
        segment.audioAssetKey !== null && assetPathByKey.has(segment.audioAssetKey)
          ? segment.audioAssetKey
          : null;

      segments.push({
        id: segment.id,
        materialId: proposal.id,
        kind: segment.kind,
        order,
        title: segment.title,
        representationId,
        anchor,
        audioAssetId,
        // **本版本不产生时间区间**：源件没有显式给出，音频不被读取/切分/转写。
        startSeconds: null,
        endSeconds: null,
        text: segment.text,
        transcript: segment.transcript,
        referenceTranslation: segment.referenceTranslation,
        notes: segment.notes,
      });
    }
  }

  const manifest: CoursePackageContent = {
    id: input.courseId,
    schemaVersion: COURSE_MANIFEST_SCHEMA_VERSION,
    provider: input.provider,
    edition: input.edition,
    title: input.title,
    contentVersion: input.contentVersion,
    provenance: {
      note: input.provenance.note,
      reference: input.provenance.reference,
      rightsNote: input.provenance.rightsNote,
    },
    materials,
    segments,
    assets,
  };

  // ── 4) 复核事项（机器能确定"必须人工看"的全部情况）──
  const review = collectReviewItems(input);

  const manifestJson = `${JSON.stringify(toCourseManifestJson(manifest), null, 2)}\n`;
  files.set(COURSE_MANIFEST_FILENAME, Buffer.from(manifestJson, "utf8"));

  const courseChecksum = createHash("sha256").update(manifestJson, "utf8").digest("hex");
  const groupingHash = courseGroupingDigest(input.grouping);
  // 结构来源（自动 / 人工计划 + 计划校验和）参与分段摘要 ⇒ 参与候选身份
  const segmentationHash = courseSegmentationDigest(input.segmentation, input.segmentationMode);
  const matchingHash = courseMatchingDigest(input.matching);

  const metadata: CourseCandidateMetadata = {
    courseId: input.courseId,
    pipelineVersion: COURSE_PIPELINE_VERSION,
    contentVersion: input.contentVersion,
    createdAt: input.createdAt,
    sourceRootLabel: input.sourceRootLabel,
    inventory: input.inventory,
    extraction: {
      tool: input.documents.find((doc) => doc.tool !== null)?.tool ?? null,
      documents: input.documents,
    },
    grouping: {
      proposals: input.grouping.proposals,
      invariantViolations: input.grouping.invariantViolations,
      warnings: input.grouping.warnings,
    },
    segmentation: {
      materials: input.segmentation,
      documentLevelOnlyMaterials: input.segmentation
        .filter((material) => material.documentLevelOnly)
        .map((material) => material.materialProposalId),
      modeEvidence: input.segmentationMode,
    },
    matching: input.matching,
    review,
    digests: {
      sourceDigest: input.inventory.digest,
      courseChecksum,
      groupingDigest: groupingHash,
      segmentationDigest: segmentationHash,
      matchingDigest: matchingHash,
      candidateChecksum: "",
    },
  };

  metadata.digests.candidateChecksum = courseCandidateChecksum(metadata.digests);

  return { courseId: input.courseId, files, manifest, metadata, review };
}

// ---------------------------------------------------------------------------
// 候选校验和
// ---------------------------------------------------------------------------

// 摘要的**唯一实现**在 `digests.ts`：复核/晋升时会从这里**现场重算**，
// 两边共用一份，才能真的检测出"候选被改动过"。
export { courseCandidateChecksum as candidateChecksumOf } from "./digests";

// ---------------------------------------------------------------------------
// 复核事项收集
// ---------------------------------------------------------------------------

/**
 * 把"机器能确定的、需要人看的"全部事项收集成结构化清单。
 *
 * **失败关闭的落点。** 有效级别的 `blocking` 事项不解决就不能晋升；
 * `advisory` 必须被看见但不阻断（例如"未匹配"根本不是问题）。
 */
export function collectReviewItems(input: BuildCourseCandidateInput): CandidateReviewItem[] {
  const items: CandidateReviewItem[] = [];

  // ---- 0) 人工分段计划的**覆盖率与绑定**（事实缺陷，**不可**被裁决化解）----
  //
  // 这一段用 `input.segmentationMode` 而不是把计划本身传进来：
  // 候选元数据不应携带计划文件（它住在 private-content 的候选目录里，
  // 且绝不能被复制到 courses/）。
  //
  // 两类事项都是**阻断级**且**不可裁决**：
  // - 有内容没被接住 ⇒ 候选确实缺内容，改 review.json 不会让它出现；
  // - 计划与源不匹配 ⇒ 计划的坐标在这次的抽取产物上没有意义。
  // 两者的唯一正解都是**改计划（或修源件）后重新生成候选**。
  if (input.segmentationMode.mode === "human_planned") {
    if (input.segmentationMode.unassignedLineCount > 0) {
      items.push({
        code: "plan_unassigned_content",
        severity: "blocking",
        where: "<segmentation-plan>",
        detail:
          `**人工分段计划漏掉了 ${input.segmentationMode.unassignedLineCount} 行抽取内容**。` +
          `人工分段绝不能静默丢内容：每一行要么落在某个单元的某个通道里，` +
          `要么被**人**显式标为 \`ignored_furniture\`。` +
          `工具**不会**因为某行在多页重复就自行判定它是页眉 —— ` +
          `"这是家具"必须由人明确声明。` +
          `该项**不可**由复核裁决化解：请修正计划并**重新生成候选**。` +
          `未指派的坐标（只有页码与行号，不含正文）见候选证据的 ` +
          `\`segmentation.modeEvidence.unassignedCoordinates\`。`,
        evidence:
          input.segmentationMode.unassignedCoordinates
            .slice(0, 20)
            .map((entry: { assetKey: string; page: number; line: number }) => `${entry.assetKey} p${entry.page}:${entry.line}`)
            .join("；") || null,
      });
    }
  }

  /*
   * ---- 0b) 计划**未被采用**（校验失败 ⇒ 失败关闭）----
   *
   * 刻意由调用方通过 `planIssues` 传进来，而不是在这里重新解析一次：
   * 候选构建是**纯函数**（不读盘），把"计划为什么不能用"的判断留在
   * `plan-resolve.ts` 一处，避免两处判据漂移。
   *
   * 为什么是**阻断且不可裁决**：计划是结构输入。一份有问题的计划意味着
   * "当前候选的结构**不是**人想要的那一份"。写一段复核说明不会让候选
   * 变成人想要的结构 —— 那需要修正计划并重新生成候选。
   */
  for (const issue of input.planIssues ?? []) {
    items.push({
      code: "plan_binding_mismatch",
      severity: "blocking",
      where: `<segmentation-plan>@${issue.where}`,
      detail:
        `**人工分段计划未被采用**（${issue.code}）：${issue.detail}` +
        `\n  分段已回退到自动判据，因此当前候选的结构**不是**你计划的那一份。` +
        `该项**不可**由复核裁决化解 —— 请修正计划（或源件）后**重新生成候选**。`,
      evidence: issue.code,
    });
  }

  // ---- 1) 抽取状态（每一种"没抽到"都必须有名字）----
  for (const doc of input.documents) {
    const asset = input.inventory.assets.find((item) => item.assetKey === doc.assetKey);
    const where = asset?.relativePath ?? doc.assetKey;

    if (doc.state === "deferred") {
      // 不是错误，是**如实的推迟**。但必须被看见。
      items.push({
        code: "text_extraction_deferred",
        severity: "advisory",
        where,
        detail:
          `${doc.deferredMarker}：该文件已被登记为资产/表示，但 V1 **刻意不解析**其文本。` +
          `因此"它的文本内容是什么"在本候选里**没有答案**，绝不假装抽到了。` +
          `若它的内容对这份课程包是必需的，请人工补充或转换格式后重跑。`,
        evidence: null,
      });
    }

    if (doc.state === "failed") {
      items.push({
        code: "extraction_failed",
        severity: "blocking",
        where,
        detail: `文本抽取失败：${doc.error ?? "未知错误"}。不推测其内容 —— 请人工检查该文件。`,
        evidence: null,
      });
    }

    if (doc.pagesWithoutTextLayer.length > 0) {
      items.push({
        code: "page_without_text_layer",
        severity: "blocking",
        where,
        detail:
          `第 ${doc.pagesWithoutTextLayer.join("、")} 页没有文本层（图片型页）。` +
          `本版本**不做 OCR**、不调用远程 AI。这些页上的内容不会被推测，` +
          `因此依赖它们的段的完整性**无法由机器保证** —— 必须人工核对源件。`,
        evidence: null,
      });
    }
  }

  // ---- 2) 分组歧义与"未被验证的等价" ----
  for (const proposal of input.grouping.proposals) {
    if (proposal.ambiguous) {
      items.push({
        code: "material_grouping_ambiguous",
        severity: "blocking",
        where: proposal.id,
        detail: proposal.ambiguityReason ?? "该材料分组存在歧义，必须人工裁决。",
        evidence: proposal.representations.map((representation) => representation.sourceRelativePath).join(" / "),
      });
    } else if (proposal.reviewRequired) {
      items.push({
        code: "material_grouping_requires_review",
        severity: "blocking",
        where: proposal.id,
        detail: proposal.reviewNotes.join(" "),
        evidence: proposal.basis.join("；"),
      });
    }
  }

  if (input.grouping.invariantViolations.length > 0) {
    items.push({
      // 用**专用** code：分组不变量违反是流水线缺陷，**不是**可裁决的事项。
      // 早先它复用了 `material_grouping_requires_review`，那会让它看起来
      // 像"人写一条分组裁决就能解决"—— 而实际上它根本不该被放行。
      code: "grouping_invariant_violated",
      severity: "blocking",
      where: "<grouping>",
      detail:
        "分组不变量被违反（这是流水线缺陷，不是数据问题）：" +
        input.grouping.invariantViolations.join("；") +
        " 该项**不可**由复核裁决化解；必须修正流水线或源数据后重新生成候选。",
      evidence: null,
    });
  }

  // ---- 3) 段抽取：需要复核的段 + 源件异常 ----
  for (const material of input.segmentation) {
    for (const segment of material.segments) {
      if (segment.reviewRequired) {
        items.push({
          code: "segment_requires_review",
          severity: "blocking",
          where: segment.id,
          detail: segment.reviewNotes.join(" ") || "该段需要人工确认其边界或归类。",
          evidence: segment.evidence.cues.join("；") || null,
        });
      }
      for (const anomaly of segment.anomalies) {
        items.push(anomalyToReviewItem(anomaly, segment.id));
      }
    }

    if (material.segments.length === 0) {
      items.push({
        code: "no_segments_extracted",
        severity: "advisory",
        where: material.materialProposalId,
        detail:
          material.warnings.join(" ") ||
          "该材料没有产出任何课程段。这在没有内容证据时是**正确**的行为，不是失败。",
        evidence: null,
      });
    }
  }

  // ---- 4) 匹配歧义（**不阻断匹配**，但必须让人看见）----
  for (const segment of input.matching.segments) {
    if (segment.ambiguous) {
      items.push({
        code: "match_ambiguous",
        severity: "advisory",
        where: segment.segmentId,
        detail: segment.ambiguityNote ?? "存在多个分数接近的候选。",
        evidence: segment.suggestions
          .slice(0, 3)
          .map((suggestion) => `${suggestion.target.label} = ${suggestion.score}`)
          .join("；"),
      });
    }
  }

  // ---- 5) 源清点里的跨文件事实 ----
  for (const note of input.inventory.notes) {
    if (note.code === "unsupported_type") {
      items.push({
        code: "unsupported_asset",
        severity: "advisory",
        where: "<inventory>",
        detail: note.detail,
        evidence: note.assetKeys.join(", "),
      });
    } else if (note.code === "empty_file") {
      items.push({
        code: "empty_asset",
        severity: "blocking",
        where: "<inventory>",
        detail: note.detail,
        evidence: note.assetKeys.join(", "),
      });
    }
  }

  // ---- 6) 清点里被拒绝的路径必须可见 ----
  if (input.inventory.rejected.length > 0) {
    items.push({
      code: "unsupported_asset",
      severity: "advisory",
      where: "<inventory>",
      detail:
        `${input.inventory.rejected.length} 个路径被拒绝（未读取）。` +
        `最常见的原因是符号链接指向源根之外 —— 源根之外的内容不属于这次导入。`,
      evidence: input.inventory.rejected
        .slice(0, 10)
        .map((entry) => `${entry.relativePath}: ${entry.reason}`)
        .join("；"),
    });
  }

  // 稳定排序：候选校验和必须可复现
  return items.sort(
    (a, b) => a.code.localeCompare(b.code) || a.where.localeCompare(b.where) || a.detail.localeCompare(b.detail),
  );
}

function anomalyToReviewItem(anomaly: SourceAnomaly, segmentId: string): CandidateReviewItem {
  // 题号缺陷**原样保留**，只提醒。它不阻断 —— 因为题号本来就不是身份证明，
  // 一个错编号不会让课程段变得不可用，但它必须被看见。
  const severity: CandidateReviewItem["severity"] =
    anomaly.code === "reference_translation_without_source" ? "blocking" : "advisory";
  return {
    code: "source_anomaly",
    severity,
    where: `${segmentId}@${anomaly.where}`,
    detail: `${anomaly.code}：${anomaly.detail}`,
    evidence: anomaly.evidence,
  };
}

// ---------------------------------------------------------------------------
// 写盘
// ---------------------------------------------------------------------------

/** 写出候选包目录。**只写候选目录，绝不触碰 courses/。** */
export function writeCourseCandidate(archive: CourseCandidateArchive, candidateDir: string): void {
  mkdirSync(candidateDir, { recursive: true });
  for (const [relativePath, bytes] of archive.files) {
    const target = join(candidateDir, ...relativePath.split("/"));
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(
    join(candidateDir, COURSE_CANDIDATE_FILENAME),
    `${JSON.stringify(archive.metadata, null, 2)}\n`,
    "utf8",
  );
}

/** 段所属材料的模块提示（供 CLI 汇总展示）。 */
export function moduleHintOfSegment(
  segment: ProposedSegment,
  segmentation: MaterialSegmentation[],
): CourseModuleHint | null {
  return segmentation.find((material) => material.materialProposalId === segment.materialProposalId)?.moduleHint ?? null;
}
