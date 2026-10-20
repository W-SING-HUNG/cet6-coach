/**
 * 复核与晋升门禁（review + promotion gate）。
 *
 * ── 这个模块的全部价值在于**拒绝** ──
 *
 * 它站在"机器抽取的候选"与"运行时课程包"之间，是唯一允许把候选变成
 * 规范化课程包的通道。因此它的每一条判据都是失败关闭的。
 *
 * ── 三条不可动摇的边界 ──
 *
 * 1. **复核绑定候选校验和。** `review.json` 的裁决只对它复核过的那一份候选有效。
 *    源字节、课程包、分组、分段、**canonical 库**任一变化 ⇒ 校验和变化 ⇒
 *    复核立即陈旧 ⇒ 晋升被拒。**绝不自动刷新人的决定。**
 * 2. **`accepted_suggestion` 不是 `verified`。** 它只表示"这条候选映射已准备好
 *    让人显式建链"。本模块**不调用** `verifyCanonicalLink`，**不写**任何链接，
 *    也**不提供**任何"顺带建链"的开关。
 * 3. **晋升不写任何运行时状态。** 不写课程曝光、不写 Expert 台账、
 *    不建 canonical 链接、不改 planner / mock_reserve。它只做一件事：
 *    把一个通过门禁的规范化课程包**复制**到 `courses/<id>/`。
 *
 * ── 为什么"canonical 匹配未被接受"不阻断晋升 ──
 *
 * 课程材料按题型重组，大量内容（方法说明、模板、老师讲解）本来就不对应单道真题。
 * 因此"一个所有段都未匹配的课程包"完全可以晋升 —— 这不是警告也不是失败。
 * 若晋升要求全匹配，课程层在原理上就不可用（见 `docs/course-package.md` §0）。
 */

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { COURSE_LINK_TARGET_SCOPES, type CourseLinkTargetScope } from "@/domain/course";
import { NormalizedCourseImporter, CourseManifestReadError } from "@/content/course/importer";
import { courseContentFingerprint } from "@/content/course/fingerprint";
import { getCourseCandidatesDir, getCoursesDir, isRegularFile, resolveWithinRoot } from "@/content/paper/paths";
import { COURSE_CANDIDATE_FILENAME, COURSE_CANDIDATE_ASSETS_DIR } from "./candidate";
import { resolveCandidateDir, resolvePromotedCourseDir, sanitizeForDisplay } from "./containment";
import { automaticSegmentationEvidence } from "./plan-apply";
import { scanSourceDirectory } from "./sources";
import type {
  CandidateReviewItem,
  CourseCandidateMetadata,
  CourseReviewFile,
  LinkPlanEntry,
  LinkPlanResult,
  MatchDisposition,
  PromotionCheck,
  PromotionGate,
  PromotionStatus,
  SourceCurrentness,
  SourceCurrentnessState,
  SourceInventory,
  SourceLocator,
} from "./types";
import {
  GROUPING_DECISIONS,
  MATCH_DISPOSITIONS,
  NEVER_RESOLVABLE_BY_REVIEW as NEVER_RESOLVABLE_BY_REVIEW_LIST,
  PROMOTION_STATUSES,
  SEGMENT_DECISIONS,
} from "./types";

export { PROMOTION_STATUSES };

// ---------------------------------------------------------------------------
// review.json 读取与校验
// ---------------------------------------------------------------------------

export interface ReviewValidation {
  ok: boolean;
  errors: string[];
  file: CourseReviewFile | null;
}

/**
 * 校验 `review.json` 的形状。
 *
 * 与真题流水线的 `validateHumanReviewFile` 同一条纪律：
 * **工具从不生成它** —— 它只能由人签出。若流水线能自己写复核记录，
 * "人工复核"就只是一句话。
 */
export function validateCourseReviewFile(raw: unknown): ReviewValidation {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["复核记录不是对象"], file: null };
  }
  const candidate = raw as Partial<CourseReviewFile>;

  if (typeof candidate.courseId !== "string" || candidate.courseId.trim() === "") errors.push("courseId 缺失");
  if (typeof candidate.reviewer !== "string" || candidate.reviewer.trim() === "") errors.push("reviewer 缺失");
  if (typeof candidate.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.reviewedAt)) {
    errors.push("reviewedAt 必须是 YYYY-MM-DD");
  }

  // candidateChecksum 必须**显式声明**：undefined 与 null 不同。
  // 前者说明作者根本没考虑绑定问题；后者是深思后的"不绑定"，且门禁必然因此不通过。
  if (candidate.candidateChecksum === undefined) {
    errors.push(
      "candidateChecksum 缺失 —— 复核必须绑定到具体的候选校验和（不绑定就无法证明裁决针对当前内容）",
    );
  } else if (candidate.candidateChecksum !== null && !/^[0-9a-f]{64}$/.test(candidate.candidateChecksum)) {
    errors.push("candidateChecksum 必须是 64 位小写十六进制 sha256 或 null");
  }

  if (typeof candidate.canonicalLibraryDigest !== "string" || candidate.canonicalLibraryDigest === "") {
    errors.push(
      "canonicalLibraryDigest 缺失 —— 匹配证据依赖 canonical 库；必须声明复核时库的快照，" +
        "否则库变了之后无法判断旧匹配结论是否还成立",
    );
  }

  if (!Array.isArray(candidate.materialGroupings)) errors.push("materialGroupings 必须是数组");
  if (!Array.isArray(candidate.segments)) errors.push("segments 必须是数组");
  if (!Array.isArray(candidate.matches)) errors.push("matches 必须是数组");
  if (!Array.isArray(candidate.verifiedScope) || candidate.verifiedScope.length === 0) {
    errors.push("verifiedScope 不得为空 —— 必须声明核验了什么");
  }
  if (!Array.isArray(candidate.notVerified)) {
    errors.push("notVerified 必须是数组（没有未核验项时填空数组）");
  }

  if (Array.isArray(candidate.materialGroupings)) {
    candidate.materialGroupings.forEach((entry, index) => {
      const base = `materialGroupings[${index}]`;
      if (typeof entry.proposalId !== "string" || entry.proposalId === "") errors.push(`${base}.proposalId 缺失`);
      if (!GROUPING_DECISIONS.includes(entry.decision)) {
        errors.push(`${base}.decision 必须是 ${GROUPING_DECISIONS.join(" / ")}`);
      }
      if (typeof entry.evidence !== "string" || entry.evidence.trim().length < 10) {
        errors.push(`${base}.evidence 不得为空且需足够具体（≥10 字符）`);
      }
    });
  }

  if (Array.isArray(candidate.segments)) {
    candidate.segments.forEach((entry, index) => {
      const base = `segments[${index}]`;
      if (typeof entry.segmentId !== "string" || entry.segmentId === "") errors.push(`${base}.segmentId 缺失`);
      if (!SEGMENT_DECISIONS.includes(entry.decision)) {
        errors.push(`${base}.decision 必须是 ${SEGMENT_DECISIONS.join(" / ")}`);
      }
      if (typeof entry.evidence !== "string" || entry.evidence.trim().length < 10) {
        errors.push(`${base}.evidence 不得为空且需足够具体（≥10 字符）`);
      }
    });
  }

  if (Array.isArray(candidate.matches)) {
    candidate.matches.forEach((entry, index) => {
      const base = `matches[${index}]`;
      if (typeof entry.segmentId !== "string" || entry.segmentId === "") errors.push(`${base}.segmentId 缺失`);
      if (!MATCH_DISPOSITIONS.includes(entry.disposition as MatchDisposition)) {
        errors.push(`${base}.disposition 必须是 ${MATCH_DISPOSITIONS.join(" / ")}`);
      }
      if (typeof entry.evidence !== "string" || entry.evidence.trim().length < 10) {
        errors.push(`${base}.evidence 不得为空且需足够具体（≥10 字符）`);
      }
      // 接受/否决建议时必须指向具体目标 —— 否则裁决无法被应用
      if (entry.disposition !== "intentionally_unmatched") {
        if (typeof entry.paperId !== "string" || entry.paperId === "") {
          errors.push(`${base}.paperId 缺失（${entry.disposition} 必须指向具体真题卷）`);
        }
        if (entry.targetScope !== null && !COURSE_LINK_TARGET_SCOPES.includes(entry.targetScope)) {
          errors.push(`${base}.targetScope 必须是 ${COURSE_LINK_TARGET_SCOPES.join(" / ")} 或 null`);
        }
        if (entry.targetScope === null) {
          errors.push(`${base}.targetScope 缺失（${entry.disposition} 必须声明目标粒度）`);
        }
        if (entry.targetScope !== null && (typeof entry.sectionId !== "string" || entry.sectionId === "")) {
          errors.push(`${base}.sectionId 缺失`);
        }
      }
    });
  }

  if (errors.length > 0) return { ok: false, errors, file: null };
  return { ok: true, errors: [], file: candidate as CourseReviewFile };
}

// ---------------------------------------------------------------------------
// 候选读取
// ---------------------------------------------------------------------------

export interface StoredCandidate {
  courseId: string;
  candidateDir: string;
  metadata: CourseCandidateMetadata;
  /** `candidate.json` 的原始字节（复核绑定的是**元数据里记录的**合成校验和）。 */
  metadataRaw: string;
  /** `course.json` 的原始字节。 */
  courseRaw: string;
  /** 现场重算的摘要（**不信任候选里缓存的值**）。 */
  recomputed: RecomputedDigests;
}

export interface RecomputedDigests {
  sourceDigest: string;
  courseChecksum: string;
  groupingDigest: string;
  segmentationDigest: string;
  matchingDigest: string;
  candidateChecksum: string;
}

export class CourseCandidateMissingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CourseCandidateMissingError";
  }
}

/**
 * 读取候选包（**只读**）。
 *
 * ── 路径容纳在这里强制（F-B）──
 *
 * 早先这里用 `join(candidatesDir, courseId)`。`join` **会解析** `..`
 * 但**不证明容纳**，因此实测 `readStoredCandidate("../ESCAPE")` 可以读到
 * 候选根**之外**的目录。现在一律经 `resolveCandidateDir`（组合既有
 * `normalizeRelativePath` + `resolveWithinRoot` + `isWithin`）解析，
 * 越界即抛错 —— **service 边界自身拒绝**，不依赖 CLI 先校验。
 */
export function readStoredCandidate(courseId: string, candidatesDir = getCourseCandidatesDir()): StoredCandidate {
  const candidateDir = resolveCandidateDir(courseId, candidatesDir);
  const metadataPath = join(candidateDir, COURSE_CANDIDATE_FILENAME);
  const coursePath = join(candidateDir, "course.json");

  if (!existsSync(metadataPath) || !existsSync(coursePath)) {
    throw new CourseCandidateMissingError(
      `候选包不完整：需要 ${COURSE_CANDIDATE_FILENAME} 与 course.json。先运行 \`pnpm course:extract\`。`,
    );
  }

  const metadataRaw = readFileSync(metadataPath, "utf8");
  let metadata: CourseCandidateMetadata;
  try {
    metadata = JSON.parse(metadataRaw) as CourseCandidateMetadata;
  } catch (error) {
    /*
     * 候选元数据本身不是合法 JSON（F-D 的同类形态）。
     *
     * 这必须是一个**正常的失败状态**，而不是崩到外层错误处理：
     * 否则一次坏文件会让整条复核工作流以堆栈结束，而调用方拿不到
     * "候选损坏 ⇒ 不可晋升、零交接"这个结论。
     */
    throw new CourseCandidateMissingError(
      `候选元数据无法解析（${COURSE_CANDIDATE_FILENAME} 不是合法 JSON）：${(error as Error).message}。` +
        `候选**不可**晋升；请重新运行 \`pnpm course:extract\` 生成候选。`,
    );
  }
  const courseRaw = readFileSync(coursePath, "utf8");

  return {
    courseId,
    candidateDir,
    metadata,
    metadataRaw,
    courseRaw,
    recomputed: recomputeDigests(metadata, courseRaw),
  };
}

/**
 * **现场重算**摘要值。
 *
 * ── 为什么不信任 `candidate.json` 里缓存的值 ──
 *
 * 复核的全部价值是"第二次独立测量"。若晋升时读缓存，
 * 那么被手工编辑过的 `candidate.json` 就能让"已通过"与磁盘实际状态脱钩
 * （真题流水线实测过这个缺陷形态）。
 *
 * 做法：
 * - `courseChecksum` 对**磁盘上的 `course.json` 原始字节**取 sha256；
 * - 其余四项**从元数据里的实际内容重新计算**（而不是复用缓存的摘要字段）。
 *
 * 注意 `sourceDigest` 特殊：它描述的是**源目录**，而晋升发生在源目录可能
 * 已经不存在的机器上。因此它的重算是从候选里记录的**资产清单**重新推导 ——
 * 这仍然是"候选里的事实"，不是"源目录的当前事实"。源目录漂移的检测
 * 发生在 `course:extract` 重跑时（那时会算出不同的 sourceDigest）。
 */
export function recomputeDigests(metadata: CourseCandidateMetadata, courseRaw: string): RecomputedDigests {
  const sourceDigest = metadata.inventory.digest;

  const courseChecksum = createHash("sha256").update(courseRaw, "utf8").digest("hex");

  const groupingDigest = digestOfGrouping(metadata);
  const segmentationDigest = digestOfSegmentation(metadata);
  const matchingDigest = digestOfMatching(metadata);

  const candidateChecksum = checksumOf({
    sourceDigest,
    courseChecksum,
    groupingDigest,
    segmentationDigest,
    matchingDigest,
  });

  return { sourceDigest, courseChecksum, groupingDigest, segmentationDigest, matchingDigest, candidateChecksum };
}

/**
 * 复算候选校验和与各分项摘要。
 *
 * **必须与 `candidate.ts` 使用同一套实现** —— 因此它们都在 `digests.ts` 里，
 * 这里只做「从元数据取内容 → 重新摘要」的编排。
 */
function checksumOf(digests: {
  sourceDigest: string;
  courseChecksum: string;
  groupingDigest: string;
  segmentationDigest: string;
  matchingDigest: string;
}): string {
  return courseCandidateChecksum(digests);
}

function digestOfGrouping(metadata: CourseCandidateMetadata): string {
  return courseGroupingDigest({
    proposals: metadata.grouping.proposals,
    invariantViolations: metadata.grouping.invariantViolations,
    warnings: metadata.grouping.warnings,
  });
}

function digestOfSegmentation(metadata: CourseCandidateMetadata): string {
  /*
   * 结构来源证据（自动 / 人工分段计划）**同时**参与现场重算。
   *
   * 这一点不能漏：`candidate.ts` 生成时把 `modeEvidence` 喂进分段摘要，
   * 若复核时重算**不带**它，那么每一份候选都会立刻被判成"自相矛盾"
   * （现场值与记录值必然不同）—— 门禁会对**全部**候选失败关闭。
   *
   * 反过来若两处都不带它，"把自动结构换成人工计划"就对候选身份不可见，
   * 已签署的复核会被静默沿用。因此两处必须用**同一份**输入。
   *
   * `modeEvidence` 缺失时按自动模式处理：这只会出现在**旧候选**上
   * （本字段是新增的）。它是"如实降级"，不是猜测 —— 旧候选的段落
   * 确实全部由自动判据产出。
   */
  return courseSegmentationDigest(
    metadata.segmentation.materials,
    metadata.segmentation.modeEvidence ?? automaticSegmentationEvidence(),
  );
}

function digestOfMatching(metadata: CourseCandidateMetadata): string {
  return courseMatchingDigest(metadata.matching);
}

// ---------------------------------------------------------------------------
// 门禁
// ---------------------------------------------------------------------------

export interface EvaluatePromotionInput {
  stored: StoredCandidate;
  /** 复核记录；未提供（不存在 `review.json`）时为 null。 */
  review: CourseReviewFile | null;
  /** 复核文件的形状错误（存在但无效时非空）。 */
  reviewErrors: string[];
  /**
   * 当前 canonical 库摘要。
   *
   * 用于检测"复核之后 canonical 库变了" ⇒ 匹配证据陈旧。
   * 传 null 表示"无法读取 canonical 库"（此时该项判不通过）。
   */
  currentCanonicalDigest: string | null;
  /**
   * 资产是否真的存在于候选目录且校验和一致。
   *
   * 由调用方在磁盘上核对（本模块不做 I/O 之外的事），
   * 传入结果是因为它需要读盘而门禁本身应是可穷举的纯逻辑。
   */
  assetIntegrity: { ok: boolean; issues: string[] };
  /** 候选目录里的 `course.json` 是否通过**生产校验器**。 */
  productionValidation: { ok: boolean; issues: string[] };
  /**
   * **源当前性**（F10）：重新清点当前源目录后与候选记录的源摘要比对的结果。
   *
   * 由调用方在磁盘上核对（需要文件系统），门禁本身只消费结论。
   * `null` 表示调用方**没有**做这项检查 —— 此时按 `unavailable` 处理
   * （失败关闭），而不是静默当成"源是新鲜的"。
   */
  sourceCurrentness: SourceCurrentness | null;
  /**
   * 当前 canonical 库快照是否**完整**（没有读不出来的真题包）。
   *
   * 库不完整时**不**阻断课程包晋升（未匹配是合法状态），
   * 但**阻断**把 `accepted_suggestion` 当作可信的建链依据。
   * `null` 表示未知 ⇒ 同样按不完整处理（失败关闭）。
   */
  canonicalLibraryComplete: boolean | null;
}

/**
 * 求值晋升门禁。**失败关闭。**
 *
 * 判定顺序刻意如此：先判"这份候选是不是复核时那一份"，再判"内容本身有没有问题"。
 * 顺序反了的话，一份**陈旧**的复核会在内容检查通过时看起来可以晋升。
 */
export function evaluatePromotionGate(input: EvaluatePromotionInput): PromotionGate {
  const { stored, review, reviewErrors } = input;
  const checks: PromotionCheck[] = [];
  const candidate = stored.metadata;
  const recomputed = stored.recomputed;

  const cachedChecksum = candidate.digests.candidateChecksum;
  const checksumMatchesCached = cachedChecksum === recomputed.candidateChecksum;

  /*
   * ── F-A：候选身份的**唯一**权威判据是 `candidateChecksum` ──
   *
   * `candidate.json` 里的 `digests.*` 是**派生缓存 / 诊断**，不是信任输入。
   * 运行时对 course.json 的原始字节与分组/分段/匹配的**实际内容**重新取摘要，
   * 并用它们合成现场校验和。因此：
   *
   * - **内容被改动** ⇒ 现场校验和与记录值不符 ⇒ 本项失败（`BLOCKED`）。
   * - **只改某个记录的子摘要**（内容没动）⇒ 现场校验和**仍然一致** ⇒
   *   本项通过。那只是一个过期的缓存值，**不是**"内容被篡改"。
   *
   * 这条区分很重要：子摘要不是第二份真相，因此不得因为一个缓存字段
   * 过期就声称候选内容被改动（那会与同一份输出里的 PROMOTABLE 自相矛盾）。
   * CLI 用"缓存已过期（权威值为现场重算）"的措辞报告这种情形。
   */
  const staleSubDigestCount = (
    [
      [candidate.digests.sourceDigest, recomputed.sourceDigest],
      [candidate.digests.courseChecksum, recomputed.courseChecksum],
      [candidate.digests.groupingDigest, recomputed.groupingDigest],
      [candidate.digests.segmentationDigest, recomputed.segmentationDigest],
      [candidate.digests.matchingDigest, recomputed.matchingDigest],
    ] as const
  ).filter(([recorded, actual]) => recorded !== actual).length;

  checks.push({
    name: "candidate_checksum_self_consistent",
    passed: checksumMatchesCached,
    detail: checksumMatchesCached
      ? `候选校验和与现场重算一致：${recomputed.candidateChecksum.slice(0, 16)}…` +
        (staleSubDigestCount > 0
          ? `（另有 ${staleSubDigestCount} 个**派生的诊断子摘要**记录值已过期：` +
            `它们是缓存，不是信任输入；权威值是现场重算值，因此不构成完整性问题。）`
          : "")
      : `**candidate.json 记录的校验和与现场重算不一致**（记录 ${cachedChecksum.slice(0, 16)}…，` +
        `现场 ${recomputed.candidateChecksum.slice(0, 16)}…）—— 候选内容（course.json 或实际内容）` +
        `与记录不符。任何复核都不能建立在一个自相矛盾的候选上。`,
  });

  // ---- 复核存在且形状合法 ----
  const hasReview = review !== null && reviewErrors.length === 0;
  checks.push({
    name: "human_review_present",
    passed: hasReview,
    detail: hasReview
      ? `复核记录存在：${review!.reviewer}（${review!.reviewedAt}）`
      : reviewErrors.length > 0
        ? `**复核记录存在但无效**：${reviewErrors.join("；")}`
        : "**没有复核记录**（缺少 review.json）。工具**从不**生成它 —— 复核只能由人签出。",
  });

  // ---- 绑定到当前候选（staleness 的核心）----
  const boundChecksum = review?.candidateChecksum ?? null;
  const checksumBound = hasReview && boundChecksum === recomputed.candidateChecksum;
  checks.push({
    name: "review_bound_to_current_candidate",
    passed: checksumBound,
    detail: checksumBound
      ? `复核绑定到当前候选：${recomputed.candidateChecksum.slice(0, 16)}…`
      : boundChecksum === null
        ? "**复核没有绑定候选校验和**（candidateChecksum 为 null）—— 无法证明裁决针对当前内容。"
        : `**复核已陈旧**：复核绑定的是 ${boundChecksum.slice(0, 16)}…，` +
          `而当前候选是 ${recomputed.candidateChecksum.slice(0, 16)}…。` +
          `源内容 / course.json / 分组 / 分段 / 匹配证据 / canonical 库**任一**变化都会导致这个结果。` +
          `必须**重新复核**；系统绝不自动把旧决定套到新候选上。`,
  });

  // ---- canonical 库陈旧 ----
  const libraryCurrent =
    hasReview &&
    input.currentCanonicalDigest !== null &&
    review!.canonicalLibraryDigest === input.currentCanonicalDigest;
  checks.push({
    name: "canonical_library_unchanged_since_review",
    passed: libraryCurrent,
    detail:
      input.currentCanonicalDigest === null
        ? "**无法读取 canonical 库** —— 无法确认匹配建议是否仍然成立（失败关闭）。"
        : libraryCurrent
          ? `canonical 库自复核以来未变：${input.currentCanonicalDigest.slice(0, 16)}…`
          : `**canonical 库自复核以来已变化**（复核时 ${review?.canonicalLibraryDigest.slice(0, 16) ?? "—"}…，` +
            `当前 ${input.currentCanonicalDigest.slice(0, 16)}…）。` +
            `旧匹配分数**不得**被套用到新的 canonical 包上 —— 必须重跑抽取并重新复核。`,
  });

  // ---- 所有 blocking 复核事项都被**正确类型**的裁决化解（F8）----
  const blockingItems = stored.metadata.review.filter((item) => item.severity === "blocking");
  const decisions = collectDecisions(review);
  const unresolved = blockingItems.filter((item) => !isBlockingItemResolved(item, decisions).resolved);
  checks.push({
    name: "blocking_review_items_resolved",
    passed: unresolved.length === 0,
    detail:
      blockingItems.length === 0
        ? "候选没有阻断级复核事项。"
        : unresolved.length === 0
          ? `${blockingItems.length} 项阻断级事项全部已由**正确类型**的裁决化解。`
          : `**${unresolved.length} / ${blockingItems.length} 项阻断级事项未裁决**：` +
            unresolved
              .slice(0, 3)
              .map((item) => `${item.code}@${item.where} —— ${isBlockingItemResolved(item, decisions).reason}`)
              .join("；") +
            (unresolved.length > 3 ? ` 等 ${unresolved.length} 项` : ""),
  });

  // ---- 材料分组：需要复核的必须被明确裁决 ----
  const groupingRequiringDecision = candidate.grouping.proposals.filter((proposal) => proposal.reviewRequired);
  const decidedGroupings = new Set((review?.materialGroupings ?? []).map((entry) => entry.proposalId));
  const undecidedGroupings = groupingRequiringDecision.filter((proposal) => !decidedGroupings.has(proposal.id));
  checks.push({
    name: "material_grouping_decisions_complete",
    passed: undecidedGroupings.length === 0,
    detail:
      groupingRequiringDecision.length === 0
        ? "没有需要裁决的材料分组。"
        : undecidedGroupings.length === 0
          ? `${groupingRequiringDecision.length} 份需要复核的材料分组已全部裁决。`
          : `**${undecidedGroupings.length} / ${groupingRequiringDecision.length} 份材料分组未裁决**：` +
            undecidedGroupings.map((proposal) => proposal.id).join("、") +
            `。含"PDF + DOCX 是同一份内容"这类**未被验证**的提案 —— 它们必须被人工确认。`,
  });

  // ---- 分组裁决必须引用真实提案 id ----
  const proposalIds = new Set(candidate.grouping.proposals.map((proposal) => proposal.id));
  const unknownGroupings = (review?.materialGroupings ?? []).filter((entry) => !proposalIds.has(entry.proposalId));
  checks.push({
    name: "grouping_decisions_reference_real_proposals",
    passed: unknownGroupings.length === 0,
    detail:
      unknownGroupings.length === 0
        ? "分组裁决全部指向存在的提案。"
        : `**裁决引用了不存在的提案**：${unknownGroupings.map((entry) => entry.proposalId).join("、")} —— ` +
          `说明复核记录与候选不匹配。`,
  });

  // ---- 段裁决（excluded 的段必须真的被移除）----
  const segmentIds = new Set(candidate.segmentation.materials.flatMap((material) => material.segments.map((s) => s.id)));
  const unknownSegments = (review?.segments ?? []).filter((entry) => !segmentIds.has(entry.segmentId));
  checks.push({
    name: "segment_decisions_reference_real_segments",
    passed: unknownSegments.length === 0,
    detail:
      unknownSegments.length === 0
        ? "段裁决全部指向存在的段。"
        : `**裁决引用了不存在的段**：${unknownSegments.map((entry) => entry.segmentId).join("、")}`,
  });

  // ---- 匹配裁决：引用真实段与真实建议 ----
  const suggestionIndex = new Map(
    candidate.matching.segments.map((segment) => [
      segment.segmentId,
      new Set(segment.suggestions.map((suggestion) => targetKeyOfSuggestion(suggestion.target))),
    ]),
  );
  const badMatches: string[] = [];
  for (const entry of review?.matches ?? []) {
    const known = suggestionIndex.get(entry.segmentId);
    if (!known) {
      badMatches.push(`${entry.segmentId}（该段不存在）`);
      continue;
    }
    if (entry.disposition === "intentionally_unmatched") continue;
    const key = targetKeyOfReview(entry);
    if (!known.has(key)) {
      badMatches.push(
        `${entry.segmentId} → ${key}（**该组合不在候选建议里**：裁决只能接受或否决机器实际提出过的建议）`,
      );
    }
  }
  checks.push({
    name: "match_decisions_reference_proposed_suggestions",
    passed: badMatches.length === 0,
    detail:
      badMatches.length === 0
        ? "全部匹配裁决都指向机器实际提出过的建议。"
        : `**${badMatches.length} 条匹配裁决无效**：${badMatches.slice(0, 5).join("；")}`,
  });

  // ---- 匹配歧义必须被处置 ----
  // 歧义**不阻断晋升**（未匹配是合法状态），但存在歧义时**必须**有一条显式裁决：
  // 要么选定了某一个，要么明确声明"有意不匹配"。
  const ambiguousSegments = candidate.matching.segments.filter((segment) => segment.ambiguous);
  const matchDecisions = new Map((review?.matches ?? []).map((entry) => [entry.segmentId, entry]));
  const undecidedAmbiguous = ambiguousSegments.filter((segment) => !matchDecisions.has(segment.segmentId));
  checks.push({
    name: "ambiguous_matches_dispositioned",
    passed: undecidedAmbiguous.length === 0,
    detail:
      ambiguousSegments.length === 0
        ? "没有歧义匹配。"
        : undecidedAmbiguous.length === 0
          ? `${ambiguousSegments.length} 处歧义匹配已全部显式处置（选定其一或声明有意不匹配）。`
          : `**${undecidedAmbiguous.length} 处歧义匹配未处置**：` +
            undecidedAmbiguous.map((segment) => segment.segmentId).join("、") +
            `。**不得因为某个候选排第一就默认选中它** —— 必须显式裁决。`,
  });

  // ---- F10：源当前性（**晋升前必须能证明源未漂移**）----
  //
  // 之前只比对"候选记录的源摘要"与"候选记录的资产清单" —— 那证明不了
  // 任何关于**当前源**的事。于是"抽取之后 使用者 换了 PDF、但没重跑抽取"
  // 这件事完全不可见，而候选的全部证据都建立在那一份 PDF 的文本上。
  //
  // 现在：重新清点当前源 → 重算摘要 → 与候选记录比对。
  // 无法定位源根时**失败关闭**（"证明不了"不等于"没问题"）。
  const currentness = input.sourceCurrentness;
  const sourceState: SourceCurrentnessState = currentness?.state ?? "unavailable";
  checks.push({
    name: "source_current_and_unchanged",
    passed: sourceState === "current",
    detail:
      sourceState === "current"
        ? `源未漂移（重新清点摘要一致：${currentness!.currentDigest!.slice(0, 16)}…）。` +
          (currentness!.locatorKind === "standard"
            ? "定位符来自标准源树内的相对路径。"
            : "定位符来自本次显式提供的 --source-root。")
        : sourceState === "drifted"
          ? `**源已漂移**：候选记录的源摘要为 ${currentness!.recordedDigest.slice(0, 16)}…，` +
            `当前重新清点为 ${currentness!.currentDigest!.slice(0, 16)}…。` +
            (currentness!.changedAssets.length > 0
              ? `（变化：${currentness!.changedAssets.slice(0, 5).join("、")}）`
              : "") +
            `\n  候选的全部证据都建立在旧源字节上，因此**不可晋升**。` +
            `请重新生成候选：\n      pnpm course:extract --source <dir> --id ${stored.courseId}`
          : `**无法证明源未漂移**（源不可用或未提供位置）：${currentness?.detail ?? "调用方未执行源当前性检查"}。\n` +
            `  "证明不了"**不等于**"没问题" —— 因此失败关闭。\n` +
            `  若候选由 --source-root 指向外部目录抽取，请再次提供它：\n` +
            `      pnpm course:review ${stored.courseId} --source-root <dir> [--promote]`,
  });

  // ---- canonical 库完整性（**只阻断"接受建议"，不阻断课程包晋升**）----
  //
  // 语义刻意分两层：
  // - 课程包本身仍可晋升：未匹配是合法状态，少读一份真题卷不使课程材料失真。
  // - 但库不完整时，可比对象少了一批 ⇒ "这是最高分建议"不再可信 ⇒
  //   **不得**把 `accepted_suggestion` 当作可信的建链依据。
  const acceptedSuggestions = (review?.matches ?? []).filter(
    (entry) => entry.disposition === "accepted_suggestion",
  );
  const libraryComplete = input.canonicalLibraryComplete === true;
  const acceptanceSafe = acceptedSuggestions.length === 0 || libraryComplete;
  checks.push({
    name: "canonical_library_complete_for_acceptance",
    passed: acceptanceSafe,
    detail:
      acceptedSuggestions.length === 0
        ? "没有接受任何 canonical 建议 —— 因此库是否完整不影响本项。"
        : libraryComplete
          ? `${acceptedSuggestions.length} 条已接受建议所用的 canonical 库是**完整的**。`
          : `**canonical 库不完整，但有 ${acceptedSuggestions.length} 条已接受的建议**。` +
            `读取失败的真题包没有被纳入比较，因此"这是最高分建议"**不可信** —— ` +
            `不得据此交接建链。\n` +
            `  注意：这**不**阻断课程包晋升（未匹配是合法状态）；` +
            `但它阻断"把这条建议当作可信依据"。\n` +
            `  处置：修好读不出来的真题包后重新抽取（\`pnpm course:extract\`），再复核新的校验和。`,
  });

  // ---- 资产完整性 ----
  checks.push({
    name: "assets_present_and_checksummed",
    passed: input.assetIntegrity.ok,
    detail: input.assetIntegrity.ok
      ? "候选内资产齐备，字节数与 sha256 均与 course.json 的声明一致。"
      : `**资产完整性问题**：${input.assetIntegrity.issues.slice(0, 5).join("；")}`,
  });

  // ---- 生产校验器 ----
  checks.push({
    name: "passes_production_course_validator",
    passed: input.productionValidation.ok,
    detail: input.productionValidation.ok
      ? "候选的 course.json 通过**生产同一个** NormalizedCourseImporter 校验。"
      : `**生产校验器拒绝该候选**：${input.productionValidation.issues.slice(0, 5).join("；")}`,
  });

  // ---- F9-A：被**否决**的分组结构不得被原样晋升 ----
  //
  // `rejected` 的含义是"这份分组结构是错的"。而晋升会原样复制候选的
  // `course.json` —— 因此**只要存在 `rejected` 裁决，当前候选就不可晋升**。
  //
  // 刻意**不**在复核阶段自动重组材料：那等于在复核者背后改写一份
  // 已绑定校验和的候选，会立刻让校验和与复核脱钩（F9 的根因之一）。
  // 正确处置是修正源件/分组依据后**重新生成候选**，再复核新校验和。
  const rejectedGroupings = (review?.materialGroupings ?? []).filter(
    (entry) => entry.decision === "rejected",
  );
  checks.push({
    name: "rejected_groupings_block_promotion",
    passed: rejectedGroupings.length === 0,
    detail:
      rejectedGroupings.length === 0
        ? "没有被否决的材料分组。"
        : `**${rejectedGroupings.length} 份材料分组被否决**（${rejectedGroupings
            .map((entry) => entry.proposalId)
            .join("、")}）：晋升会**原样复制**这份被否决的分组结构，因此当前候选**不可晋升**。\n` +
          `  正确处置：修正源目录（或让它按正确的方式分组）后**重新生成候选**：\n` +
          `      pnpm course:extract --source <dir> --id ${stored.courseId}\n` +
          `  然后对**新的**候选校验和重新复核。系统**不会**自动重组已复核的候选。`,
  });

  // ---- F9-B：被**排除**的段不得被原样晋升 ----
  //
  // 与分组同一套 V1 语义：`excluded` 是"这一段不该存在于候选里"，
  // 而当前候选里仍然有它 ⇒ 当前候选不可晋升。
  //
  // 刻意**不**自动删段：那会改写一份已绑定校验和的候选，
  // 让复核立刻陈旧（旧的问题是"死路"，新的问题会是"静默改写"）。
  const excludedSegments = (review?.segments ?? []).filter((entry) => entry.decision === "excluded");
  checks.push({
    name: "excluded_segments_block_promotion",
    passed: excludedSegments.length === 0,
    detail:
      excludedSegments.length === 0
        ? "没有段被排除。"
        : `**${excludedSegments.length} 个段被排除**（${excludedSegments
            .map((entry) => entry.segmentId)
            .join("、")}）：晋升会**原样复制**这些本应被去掉的段，因此当前候选**不可晋升**。\n` +
          `  正确处置：修正源件或分段依据后**重新生成候选**：\n` +
          `      pnpm course:extract --source <dir> --id ${stored.courseId}\n` +
          `  然后对**新的**候选校验和重新复核。系统**不会**在复核阶段自动删段 ` +
          `（那会让复核与校验和脱钩）。`,
  });

  const blocking = unresolved.length > 0 ? unresolved : [];
  const failed = checks.filter((check) => !check.passed);

  let status: PromotionStatus;
  if (failed.some((check) => HARD_CHECKS.has(check.name))) {
    status = "BLOCKED";
  } else if (failed.length > 0) {
    status = "REVIEW_REQUIRED";
  } else {
    status = "PROMOTABLE";
  }

  return {
    courseId: stored.courseId,
    status,
    checks,
    blocking,
    summary: buildSummary(status, failed, stored),
  };
}

/**
 * 哪些检查失败即 `BLOCKED`（而不是 `REVIEW_REQUIRED`）。
 *
 * 区分这两者的意义：`BLOCKED` 表示"这份候选现在**不可能**被晋升，
 * 无论人写什么"（例如候选自相矛盾、生产校验器拒绝）；
 * `REVIEW_REQUIRED` 表示"人还没做完决定"。
 * 把两者混为一谈会让操作者去写复核记录，而问题其实在候选本身。
 */
const HARD_CHECKS = new Set([
  "candidate_checksum_self_consistent",
  "assets_present_and_checksummed",
  "passes_production_course_validator",
  "grouping_decisions_reference_real_proposals",
  "segment_decisions_reference_real_segments",
  "match_decisions_reference_proposed_suggestions",
  /*
   * F9：`rejected` / `excluded` 表示"**当前候选**结构是错的"。
   *
   * 这与"人还没做完决定"（REVIEW_REQUIRED）完全不同：无论人再怎么改
   * review.json，只要被否决的结构还在候选里，它就不能晋升。
   * 因此它们是**硬**失败（BLOCKED），提示操作者去**重新生成候选** ——
   * 那才是唯一正确的处置方向。
   */
  "rejected_groupings_block_promotion",
  "excluded_segments_block_promotion",
  /*
   * canonical 库不完整时的"接受建议"：
   * 它不是"人还没决定完"，而是"这个决定的依据不完整"。
   * 因此同样是硬失败 —— 修好真题包并重新抽取才是正解。
   */
  "canonical_library_complete_for_acceptance",
  /*
   * F10：源当前性。
   *
   * 源漂移或无法证明源新鲜度时**没有任何 review.json 修改能修复它** ——
   * 前者必须重新生成候选，后者必须再次提供 --source-root。
   * 按本文件的定义（BLOCKED = "无论人写什么都不可晋升"），它属于硬失败：
   * 若判成 REVIEW_REQUIRED，操作者会去写复核记录，而问题根本不在那里。
   */
  "source_current_and_unchanged",
]);

function buildSummary(status: PromotionStatus, failed: PromotionCheck[], stored: StoredCandidate): string {
  if (status === "PROMOTABLE") {
    const accepted = stored.metadata.matching.segments.filter((segment) =>
      segment.suggestions.some((suggestion) => suggestion.label === "strong_candidate"),
    ).length;
    return (
      "门禁全部通过，可以晋升为规范化课程包。\n" +
      `注意：晋升**不**创建任何 canonical 链接。` +
      (accepted === 0
        ? "这份课程包没有任何段被认定为强候选 —— **未匹配是合法状态**，不影响晋升。"
        : `其中 ${accepted} 个段存在强候选建议，但"接受建议"仍然**不是** verified 链接。`)
    );
  }
  return (
    `${failed.length} 项门禁未通过：\n` +
    failed.map((check) => `  ✗ ${check.name}：${check.detail}`).join("\n")
  );
}

// ---------------------------------------------------------------------------
// 裁决索引（**按事项类型分派，不是一张扁平的 where 集合**）
// ---------------------------------------------------------------------------

/**
 * 复核裁决索引。
 *
 * ── 为什么不能是一张扁平的 `resolvedWhere` 集合（F8 的根因）──
 *
 * 阻断事项的 `where` 是**异构的**：分组事项用 proposalId，段事项用 segmentId，
 * 源件异常用 `segmentId@q46`。而裁决也是异构的：分组裁决、段裁决、匹配裁决。
 *
 * 若把它们都塞进一个 `Set<string>` 再按 `where` 查，就会出现语义串台：
 *
 * > 一条 `segment_requires_review@seg-1` 会因为 review.matches 里
 * > **存在任意一条针对 seg-1 的匹配裁决**而被判"已解决"。
 *
 * 那是错的：
 *
 * - **"我决定它对应哪道真题"**
 *   ≠ **"我确认这段的边界/类别是正确的"**。
 * - 同样，抽取失败 / 无文本层 / 空资产这类**抽取层**问题，
 *   也绝不能被一条匹配裁决消掉。
 *
 * 因此这里按**事项 code** 分派到它**真正需要的那一种裁决**：
 *
 * | 阻断事项 code | 唯一可化解它的裁决 |
 * | --- | --- |
 * | `material_grouping_ambiguous` / `material_grouping_requires_review` | 该 proposalId 的**分组**裁决 |
 * | `segment_requires_review` | 该 segmentId 的**段**裁决 |
 * | `source_anomaly`（段级，where=`seg@x`） | 该段的**段**裁决 |
 * | `match_ambiguous` | 该 segmentId 的**匹配**裁决（它本来就是匹配层事项） |
 * | `extraction_failed` / `page_without_text_layer` / `empty_asset` | **不可被裁决消掉**（见下） |
 * | 其余未知 code | 保守：**必须**有段裁决或分组裁决明确覆盖，否则视为未解决 |
 *
 * ── 哪些事项**根本无法**被"裁决"消掉 ──
 *
 * `extraction_failed`、`page_without_text_layer`、`empty_asset` 与分组不变量违反
 * 描述的是**候选本身的事实缺陷**（文件坏了 / 页没有文本层 / 空文件）。
 * 人写一段说明**不能**让它们消失 —— 那需要修正源件并**重新生成候选**。
 *
 * 让它们"可被裁决消掉"会制造一条绕过门禁的通道：
 * 只要在 review.json 里写一句话，就能把一份抽取不完整的包推出去。
 * 因此它们**始终**未解决（`alwaysBlocking`），门禁会明确告诉操作者
 * "这需要重新生成候选，而不是写复核记录"。
 */
interface DecisionIndex {
  /** 已被**分组**裁决明确覆盖的 proposalId。 */
  decidedGroupings: Set<string>;
  /** 已被**段**裁决明确覆盖的 segmentId。 */
  decidedSegments: Set<string>;
  /** 已被**匹配**裁决明确覆盖的 segmentId。 */
  decidedMatches: Set<string>;
}

/**
 * 这些阻断事项**不可**由任何复核裁决化解。
 *
 * 唯一实现是 `types.ts` 的 `NEVER_RESOLVABLE_BY_REVIEW`（它是事项类型的
 * 固有属性）；这里只是把它转成 Set 以用于查表。
 */
const NEVER_RESOLVABLE_BY_REVIEW = new Set<CandidateReviewItem["code"]>(NEVER_RESOLVABLE_BY_REVIEW_LIST);

/**
 * 判断一条阻断事项是否**已被正确类型的裁决**化解。
 *
 * 返回 `resolved: false` 时 `reason` 说明**缺少哪一种**裁决 ——
 * 这句措辞很重要：它必须告诉操作者去写哪一节，而不是笼统说"未裁决"。
 */
export function isBlockingItemResolved(
  item: CandidateReviewItem,
  decisions: DecisionIndex,
): { resolved: boolean; reason: string } {
  if (NEVER_RESOLVABLE_BY_REVIEW.has(item.code)) {
    return {
      resolved: false,
      reason:
        `该项描述的是**候选自身的事实缺陷**，人写说明不能让它消失。` +
        `请修正源件后**重新生成候选**（pnpm course:extract），再复核新的候选校验和。`,
    };
  }

  switch (item.code) {
    // ── 分组层事项：只认**分组**裁决 ──
    case "material_grouping_ambiguous":
    case "material_grouping_requires_review":
      return decisions.decidedGroupings.has(item.where)
        ? { resolved: true, reason: "已有该材料分组的分组裁决。" }
        : {
            resolved: false,
            reason:
              `缺少 \`materialGroupings[]\` 中针对 \`${item.where}\` 的裁决。` +
              `**匹配裁决不能代替分组裁决** —— "它对应哪道真题"与"这份分组结构对不对"是两件事。`,
          };

    // ── 段层事项：只认**段**裁决（**不**接受匹配裁决）──
    case "segment_requires_review":
      return decisions.decidedSegments.has(item.where)
        ? { resolved: true, reason: "已有该段的段裁决。" }
        : {
            resolved: false,
            reason:
              `缺少 \`segments[]\` 中针对 \`${item.where}\` 的裁决。` +
              `**匹配裁决不能代替段裁决** —— "我决定它对应哪道真题"不等于"我确认了这段的边界/类别"。`,
          };

    // ── 源件异常（段级，where = `segId@...`）：只认**那一段**的段裁决 ──
    case "source_anomaly": {
      const segmentId = item.where.split("@")[0];
      return decisions.decidedSegments.has(segmentId)
        ? { resolved: true, reason: `该段的源件异常已随段裁决一并确认（${segmentId}）。` }
        : {
            resolved: false,
            reason:
              `缺少 \`segments[]\` 中针对 \`${segmentId}\` 的段裁决。` +
              `源件异常属于**那一段**的问题，必须由该段的裁决确认（匹配裁决不算）。`,
          };
    }

    // ── 匹配层事项：只认**匹配**裁决（它本来就是匹配层的问题）──
    case "match_ambiguous":
      return decisions.decidedMatches.has(item.where)
        ? { resolved: true, reason: "已有该段的匹配裁决（歧义必须显式处置）。" }
        : {
            resolved: false,
            reason: `缺少 \`matches[]\` 中针对 \`${item.where}\` 的裁决。`,
          };

    // ── 其余（例如 advisory 被误升级、未来新增 code）：保守处理 ──
    //
    // 未知 code **不得**仅凭"某处有裁决"就放行。要求段裁决覆盖
    // （绝大多数剩余事项都是段级的），否则视为未解决。
    default:
      return decisions.decidedSegments.has(item.where) || decisions.decidedGroupings.has(item.where)
        ? { resolved: true, reason: "已有覆盖该位置的段裁决或分组裁决。" }
        : {
            resolved: false,
            reason:
              `该事项（${item.code}）需要一条明确覆盖 \`${item.where}\` 的段裁决或分组裁决 ` +
              `（未知类型保守处理，不因别处的裁决而放行）。`,
          };
  }
}

/**
 * 把 review.json 的裁决**按类型**收集成索引。
 *
 * 刻意**不**产出单一的 `resolvedWhere` 集合 —— 那正是 F8 的根因。
 */
export function collectDecisions(review: CourseReviewFile | null): DecisionIndex {
  const decidedGroupings = new Set<string>();
  const decidedSegments = new Set<string>();
  const decidedMatches = new Set<string>();
  if (!review) return { decidedGroupings, decidedSegments, decidedMatches };

  for (const entry of review.materialGroupings) {
    // 只有 `accepted` 才算"确认了这份分组结构"。
    // `rejected` 是"否定它" —— 那由 F9 的门禁单独处理，**不算已解决**。
    if (entry.decision === "accepted") decidedGroupings.add(entry.proposalId);
  }
  for (const entry of review.segments) {
    // 同理：`excluded` 是否定，不算"确认该段"。
    if (entry.decision === "accepted") decidedSegments.add(entry.segmentId);
  }
  for (const entry of review.matches) decidedMatches.add(entry.segmentId);

  return { decidedGroupings, decidedSegments, decidedMatches };
}

function targetKeyOfSuggestion(target: {
  paperId: string;
  sectionId: string;
  groupId: string | null;
  questionId: string | null;
}): string {
  return `${target.paperId}|${target.sectionId}|${target.groupId ?? ""}|${target.questionId ?? ""}`;
}

function targetKeyOfReview(entry: {
  paperId: string | null;
  sectionId: string | null;
  groupId: string | null;
  questionId: string | null;
}): string {
  return `${entry.paperId ?? ""}|${entry.sectionId ?? ""}|${entry.groupId ?? ""}|${entry.questionId ?? ""}`;
}

// ---------------------------------------------------------------------------
// 资产与生产校验（磁盘侧，供门禁输入）
// ---------------------------------------------------------------------------

/** 在候选目录里逐个核对资产字节与校验和。 */
export function checkCandidateAssets(
  candidateDir: string,
  metadata: CourseCandidateMetadata,
): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  // 从 course.json 读取声明的资产（**不信任 candidate.json**）
  let manifestAssets: { relativePath: string; bytes: number; checksum: string }[] = [];
  try {
    const manifest = JSON.parse(readFileSync(join(candidateDir, "course.json"), "utf8")) as {
      assets?: { path?: string; bytes?: number; checksum?: string }[];
    };
    manifestAssets = (manifest.assets ?? []).map((asset) => ({
      relativePath: asset.path ?? "",
      bytes: asset.bytes ?? -1,
      checksum: asset.checksum ?? "",
    }));
  } catch (error) {
    return { ok: false, issues: [`无法读取候选的 course.json：${(error as Error).message}`] };
  }

  for (const asset of manifestAssets) {
    if (asset.relativePath === "") {
      issues.push("course.json 里有资产缺少 path");
      continue;
    }
    // 路径必须在候选目录内 —— 库外的路径绝不允许（同一套两级防线）
    if (asset.relativePath.includes("..") || asset.relativePath.startsWith("/") || /^[a-zA-Z]:/.test(asset.relativePath)) {
      issues.push(`资产路径不安全：${asset.relativePath}`);
      continue;
    }
    const absolute = join(candidateDir, ...asset.relativePath.split("/"));
    if (!isRegularFile(absolute)) {
      issues.push(`资产文件不存在或不是常规文件：${asset.relativePath}`);
      continue;
    }
    const bytes = readFileSync(absolute);
    if (bytes.length !== asset.bytes) {
      issues.push(`资产字节数不符：${asset.relativePath} 声明 ${asset.bytes}，磁盘 ${bytes.length}`);
      continue;
    }
    const checksum = createHash("sha256").update(bytes).digest("hex");
    if (checksum !== asset.checksum) {
      issues.push(`资产校验和不符：${asset.relativePath}`);
    }
  }

  void metadata;
  return { ok: issues.length === 0, issues };
}

/**
 * 用**生产同一个校验器**校验候选包。
 *
 * 为什么必须用它：候选是一个**目录**，而 `NormalizedCourseImporter`
 * 正是运行时读取课程包的那段代码。用别的校验逻辑会让"候选看起来没问题、
 * 导入时才炸"成为可能。
 */
export function validateWithProduction(
  candidateDir: string,
  courseId: string,
): { ok: boolean; issues: string[]; content: unknown } {
  try {
    const importer = new NormalizedCourseImporter(getCourseCandidatesDir());
    const validated = importer.validate({ relativePath: courseId, absolutePath: candidateDir });
    return { ok: true, issues: [], content: validated.content };
  } catch (error) {
    const issues =
      error instanceof CourseManifestReadError
        ? error.issues.map((issue) => `${issue.path}: ${issue.message}`)
        : [(error as Error).message];
    return { ok: false, issues, content: null };
  }
}

// ---------------------------------------------------------------------------
// 门禁输入的**统一采集**（CLI 与测试共用一份实现）
// ---------------------------------------------------------------------------

export interface GatherPromotionInputsOptions {
  stored: StoredCandidate;
  review: CourseReviewFile | null;
  reviewErrors: string[];
  /** 当前 canonical 库（用于摘要比对与完整性判定）。 */
  canonical: { digest: string | null; complete: boolean | null };
  /** 标准源树根（`private-content/course-sources`）。 */
  standardSourcesRoot: string;
  /** 复核者显式提供的当前源根（外部源抽取时必需）。 */
  sourceRootOverride?: string | null;
}

/**
 * 采集门禁所需的**全部磁盘侧事实**。
 *
 * ── 为什么要有这一个函数 ──
 *
 * 门禁本身是纯逻辑（可穷举），但它需要磁盘侧事实：资产完整性、
 * 生产校验器、源当前性。若 CLI 与测试各自拼一遍，就会出现
 * "CLI 检查了源漂移、测试没检查"这类**判据漂移** ——
 * 那正是本项目反复强调要避免的形态。
 *
 * 采集收敛在这里一处，调用方只负责提供"当前库"信息与"源根"。
 */
export function gatherPromotionInputs(options: GatherPromotionInputsOptions): EvaluatePromotionInput {
  const { stored } = options;
  return {
    stored,
    review: options.review,
    reviewErrors: options.reviewErrors,
    currentCanonicalDigest: options.canonical.digest,
    canonicalLibraryComplete: options.canonical.complete,
    assetIntegrity: checkCandidateAssets(stored.candidateDir, stored.metadata),
    productionValidation: validateWithProduction(stored.candidateDir, stored.courseId),
    sourceCurrentness: checkSourceCurrentness({
      stored,
      standardSourcesRoot: options.standardSourcesRoot,
      sourceRootOverride: options.sourceRootOverride ?? null,
    }),
  };
}

// ---------------------------------------------------------------------------
// 晋升
// ---------------------------------------------------------------------------

export interface PromoteInput {
  stored: StoredCandidate;
  gate: PromotionGate;
  review: CourseReviewFile | null;
  coursesDir?: string;
  candidateDir?: string;
}

export interface PromoteResult {
  ok: boolean;
  /** 目标课程包目录（成功时）。 */
  targetDir: string | null;
  /** 复制了哪些文件（相对路径）。 */
  copied: string[];
  /** 明确**没有**复制的东西（必须可见）。 */
  excluded: string[];
  error: string | null;
  /** 晋升后的课程内容指纹（与 Foundation 同一实现）。 */
  contentFingerprint: string | null;
}

/**
 * 通过门禁后晋升候选包。
 *
 * ── 它做什么 ──
 *
 * 把**规范化内容**从 `course-candidates/<id>/` 复制到 `courses/<id>/`：
 * `course.json` + `assets/*`。仅此而已。
 *
 * ── 它**不**做什么（每一条都由测试守护）──
 *
 * - 不写课程曝光（`course_exposure_event`）
 * - 不写 Expert 台账（`performance_event` / `assessment_event` / `evidence_projection`）
 * - 不创建 canonical 链接（**不调用** `verifyCanonicalLink`）
 * - 不改 planner / `mock_reserve` / 试卷 untouched 选择
 * - 不打开数据库（它根本不 import 任何数据库模块）
 * - 不把 `candidate.json` / `review.json` 泄漏进运行时课程目录
 */
export function promoteCourseCandidate(input: PromoteInput): PromoteResult {
  const coursesDir = input.coursesDir ?? getCoursesDir();
  const candidateDir = input.candidateDir ?? input.stored.candidateDir;

  if (input.gate.status !== "PROMOTABLE") {
    return {
      ok: false,
      targetDir: null,
      copied: [],
      excluded: [],
      error:
        `拒绝晋升：门禁结论为 ${input.gate.status}。\n` +
        `不得用「手工放行」绕过门禁 —— 先解决上面列出的每一项。`,
      contentFingerprint: null,
    };
  }

  /*
   * ── 晋升目标的容纳**独立强制**（F-B）──
   *
   * 这里**不**相信 `input.stored.courseId` 是安全的：一个手工构造的
   * `StoredCandidate`（测试、未来的调用方、被改动的中间状态）可以带上
   * `../../evil` 这样的 id。若直接 `join(coursesDir, id)`，
   * 晋升就会写到 `courses/` 之外 —— 那是本阶段最不可接受的后果之一。
   *
   * 因此目标路径一律经 `resolvePromotedCourseDir` 重新解析并证明容纳。
   * 这一步与 `readStoredCandidate` 的检查**互相独立**：
   * 任一入口被绕过，另一处仍然拦得住。
   */
  let targetDir: string;
  try {
    targetDir = resolvePromotedCourseDir(input.stored.courseId, coursesDir);
  } catch (error) {
    return {
      ok: false,
      targetDir: null,
      copied: [],
      excluded: [],
      error:
        `拒绝晋升：课程 id 不安全，目标可能落在 courses/ 之外 —— ` +
        `${(error as Error).message}。晋升**不**写入任何文件。`,
      contentFingerprint: null,
    };
  }

  // ── 目标已存在时的处置 ──
  //
  // 本阶段**不实现**"对已晋升课程做语义升级"。理由：升级涉及
  // contentVersion 语义与"历史曝光指向哪一版"的判断，而那属于后续阶段。
  // 直接覆盖会让一次误操作静默替换掉现有的运行时课程包 —— 那不可接受。
  if (existsSync(targetDir)) {
    return {
      ok: false,
      targetDir: null,
      copied: [],
      excluded: [],
      error:
        `目标课程包已存在：courses/${input.stored.courseId}。` +
        `本阶段**不实现**对已晋升课程的原地覆盖（那会让一次误操作静默替换运行时课程包）。` +
        `若确实要替换，请先人工把旧包移出 courses/（保留为备份），再重新晋升。`,
      contentFingerprint: null,
    };
  }

  const copied: string[] = [];
  const excluded = [COURSE_CANDIDATE_FILENAME, "review.json"];

  try {
    mkdirSync(targetDir, { recursive: true });

    // 只复制 course.json 与 assets/ 目录下的内容。
    // 用白名单而不是黑名单：黑名单会漏掉未来新增的元数据文件。
    cpSync(join(candidateDir, "course.json"), join(targetDir, "course.json"));
    copied.push("course.json");

    const assetsDir = join(candidateDir, COURSE_CANDIDATE_ASSETS_DIR);
    if (existsSync(assetsDir)) {
      cpSync(assetsDir, join(targetDir, COURSE_CANDIDATE_ASSETS_DIR), { recursive: true });
      copied.push(`${COURSE_CANDIDATE_ASSETS_DIR}/`);
    }
  } catch (error) {
    // 复制失败即回滚已部分写入的目标目录 —— 绝不留下半成品课程包
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
    return {
      ok: false,
      targetDir: null,
      copied: [],
      excluded,
      error: `复制失败（已回滚，未留下半成品课程包）：${(error as Error).message}`,
      contentFingerprint: null,
    };
  }

  // ── 晋升后核对：用生产校验器再读一次目标包 ──
  //
  // 这一步不是仪式：它证明"复制到 courses/ 的那一份"确实能被运行时读到。
  let contentFingerprint: string | null = null;
  try {
    const importer = new NormalizedCourseImporter(coursesDir);
    const validated = importer.validate({ relativePath: input.stored.courseId, absolutePath: targetDir });
    contentFingerprint = courseContentFingerprint(validated.content);
  } catch (error) {
    try {
      rmSync(targetDir, { recursive: true, force: true });
    } catch {
      /* 尽力而为 */
    }
    return {
      ok: false,
      targetDir: null,
      copied: [],
      excluded,
      error:
        `晋升后核对失败（已回滚）：复制到 courses/ 的包无法被生产校验器读取 —— ` +
        `${error instanceof CourseManifestReadError ? error.issues.map((i) => `${i.path}: ${i.message}`).join("；") : (error as Error).message}`,
      contentFingerprint: null,
    };
  }

  return { ok: true, targetDir, copied, excluded, error: null, contentFingerprint };
}

// ---------------------------------------------------------------------------
// 源当前性（F10）
// ---------------------------------------------------------------------------

/**
 * 重新清点**当前**源并与候选记录比对（F10 的判据实现）。
 *
 * ── 它解决的是什么 ──
 *
 * `recomputeDigests` 只能从候选**记录的**资产清单重算 `sourceDigest` ——
 * 那证明的是"候选自洽"，**证明不了**"当前源还是那一份"。
 * 于是"抽取之后 使用者 换了 PDF、但没重跑抽取"完全不可见。
 *
 * 本函数做的是真正的第二次测量：**用同一套清点实现**重新扫一遍当前源，
 * 重算摘要，再比对。
 *
 * ── 源根从哪里来 ──
 *
 * 1. 候选记录了 `standard` 定位符 ⇒ 自动解析到
 *    `standardSourcesRoot/<locator>`，**不需要**人再给路径。
 * 2. 候选记录的是 `external`（或调用方显式提供了 `sourceRootOverride`）
 *    ⇒ 必须由调用方提供当前源根。
 * 3. 都拿不到 ⇒ `unavailable` ⇒ 门禁**失败关闭**。
 *
 * ── 它绝不写任何东西 ──
 *
 * 只读清点。漂移**不会**自动更新候选 —— 必须重新生成候选。
 */
export function checkSourceCurrentness(input: {
  stored: StoredCandidate;
  /** 标准源树根（`private-content/course-sources`）。 */
  standardSourcesRoot: string;
  /** 复核者显式提供的当前源根（外部源抽取时必需）。 */
  sourceRootOverride?: string | null;
}): SourceCurrentness {
  const recorded = input.stored.metadata.inventory;
  const recordedDigest = recorded.digest;

  const unavailable = (detail: string, kind: SourceLocator["kind"] | null): SourceCurrentness => ({
    state: "unavailable",
    recordedDigest,
    currentDigest: null,
    sourceRootLabel: null,
    changedAssets: [],
    detail,
    locatorKind: kind,
  });

  // ── 解析当前源根（**绝不**从候选里读绝对路径 —— 那里根本没有）──
  let currentRoot: string | null = null;
  let locatorKind: SourceLocator["kind"] | null = null;

  if (input.sourceRootOverride !== undefined && input.sourceRootOverride !== null) {
    currentRoot = resolve(input.sourceRootOverride);
    locatorKind = recorded.sourceLocator.kind;
  } else if (recorded.sourceLocator.kind === "standard") {
    // 标准树内的相对定位符 ⇒ 自动解析（**这是"不需要人再给路径"的那条路**）
    try {
      const resolvedPath = resolveWithinRoot(input.standardSourcesRoot, recorded.sourceLocator.locator, {
        mustExist: false,
      });
      currentRoot = resolvedPath.absolutePath;
      locatorKind = "standard";
    } catch (error) {
      return unavailable(
        `候选记录的源定位符无法安全解析：${(error as Error).message}`,
        "standard",
      );
    }
  } else {
    return unavailable(
      `候选由**外部源根**抽取（未记录位置，绝对路径绝不落盘），` +
        `因此无法自动重新清点源。请再次提供它：\`pnpm course:review <id> --source-root <dir>\`。`,
      "external",
    );
  }

  if (!existsSync(/* turbopackIgnore: true */ currentRoot)) {
    // 路径是任意本机字符串 ⇒ 打印前必须消毒（F-C）
    return unavailable(
      `源目录已不存在：${sanitizeForDisplay(currentRoot, 200)}。源不可用 ⇒ 无法证明源未漂移。`,
      locatorKind,
    );
  }

  // ── 重新清点（**同一套实现**）──
  let rescanned: SourceInventory;
  try {
    rescanned = scanSourceDirectory(currentRoot, {
      standardSourcesRoot: input.standardSourcesRoot,
      sourceRootLabel: recorded.sourceRootLabel,
    });
  } catch (error) {
    return unavailable(`重新清点源失败：${(error as Error).message}`, locatorKind);
  }

  if (rescanned.digest === recordedDigest) {
    return {
      state: "current",
      recordedDigest,
      currentDigest: rescanned.digest,
      sourceRootLabel: rescanned.sourceRootLabel,
      changedAssets: [],
      detail: "源未漂移：重新清点得到的摘要与候选记录一致。",
      locatorKind,
    };
  }

  // ── 漂移：列出变化（人可读，帮助定位是哪一份文件被换了）──
  const recordedByPath = new Map(recorded.assets.map((asset) => [asset.relativePath, asset]));
  const currentByPath = new Map(rescanned.assets.map((asset) => [asset.relativePath, asset]));
  const changed: string[] = [];
  for (const [relativePath, asset] of currentByPath) {
    const before = recordedByPath.get(relativePath);
    if (!before) changed.push(`${relativePath}（新增）`);
    else if (before.sha256 !== asset.sha256 || before.bytes !== asset.bytes) {
      changed.push(`${relativePath}（内容变化）`);
    }
  }
  for (const relativePath of recordedByPath.keys()) {
    if (!currentByPath.has(relativePath)) changed.push(`${relativePath}（已删除）`);
  }

  return {
    state: "drifted",
    recordedDigest,
    currentDigest: rescanned.digest,
    sourceRootLabel: rescanned.sourceRootLabel,
    changedAssets: changed.sort(),
    detail:
      `源已漂移：${changed.length} 处变化（${changed.slice(0, 5).join("、")}${changed.length > 5 ? " 等" : ""}）。`,
    locatorKind,
  };
}

// ---------------------------------------------------------------------------
// 已复核链接交接计划（**只打印，绝不执行**）
// ---------------------------------------------------------------------------

/**
 * 从**已接受的匹配决定**生成确定性的链接计划。
 *
 * ── 这是本流水线里最需要说清楚的一条边界 ──
 *
 * 它产出的每一条都是一句 `pnpm course:link ... --status verified --ref <safe-ref>`。
 * 它：
 *
 * - **不执行**任何命令；
 * - **不**把 `--status verified` 写进任何运行时真相；
 * - **不**调用 `verifyCanonicalLink`。
 *
 * 理由：`accepted_suggestion` 是"人认为这条候选映射是对的"，
 * 而 `verified` 链接是一条**绑定到具体课程/真题内容版本**的运行时真相。
 * 两者之间隔着一次**显式的建链动作**，那必须由维护者另行授权。
 * 把两者合并会让"复核过候选"悄悄变成"创造了运行时真相"。
 *
 * ── `--ref` 为什么是受控标识符而不是原文（F11）──
 *
 * 复核依据是人写的散文，可能含引号、反引号、`$(...)`、分号、换行。
 * 本项目运行在 Windows/PowerShell 上，而**反斜杠不是 PowerShell 的转义字符** ——
 * 任何自写的转义函数都会产出既不可移植、又能被解释成 shell 语法的字符串。
 * 生成一条"复制粘贴就可能执行任意命令"的文本是不可接受的。
 *
 * 因此命令里只放 `course-review:<courseId>:<checksumPrefix>:<segmentId>:<reviewedAt>`，
 * 每一段都来自**已被校验的字段**（slug / 十六进制摘要 / `YYYY-MM-DD`），
 * 字符集限制为 `[a-z0-9._:-]`。人写的证据留在 `review.json` 里，由它**指向**。
 *
 * ── 为什么必须传 `gate`（F12）──
 *
 * 早先这个函数只读 `review.matches`，因此它**看不见**任何门禁状态：
 * 候选校验和已陈旧、源已漂移、canonical 库不完整、存在被否决的分组或段 ——
 * 这些全部不可见。后果是 CLI 可以一边打印"库不完整，不得据此交接建链"，
 * 一边照样输出 `pnpm course:link ... --status verified`。
 *
 * 省略 `--commit` 只降低了**立即写入**的风险，**不满足产品契约**：
 * 一份失效 / 陈旧 / 不可信的复核**不得**产出"已复核链接交接计划"。
 *
 * 因此 `gate` 是**必需参数**（不是可选开关），且只有 `PROMOTABLE` 才放行。
 * 把它做成必需参数而不是"记得先判断 status"：后者要求每个调用方各自记得，
 * 而漏掉一次就会重新打开这条通道。类型系统在这里比注释可靠。
 */
export function buildLinkPlan(input: {
  stored: StoredCandidate;
  review: CourseReviewFile | null;
  /**
   * 当前候选的晋升门禁结论（**必需**）。
   *
   * 传它进来而不是在函数内部重算：本函数不做 I/O，
   * 而门禁需要读盘（资产、生产校验器、源当前性）。要求调用方提供
   * 已经算好的结论，同时也让"用哪个门禁放行"在调用处**可见**。
   */
  gate: PromotionGate;
}): LinkPlanResult {
  const { stored, review, gate } = input;

  // ── 信任边界：非 PROMOTABLE 一律不产出任何命令 ──
  if (!review) {
    return { allowed: false, reason: "没有复核记录 —— 没有任何已复核的映射可供交接。", entries: [] };
  }
  if (gate.status !== "PROMOTABLE") {
    const failed = gate.checks.filter((check) => !check.passed).map((check) => check.name);
    return {
      allowed: false,
      reason:
        `**链接交接已抑制**：当前复核门禁不是 PROMOTABLE（实际 ${gate.status}）。` +
        `未通过：${failed.slice(0, 5).join("、")}${failed.length > 5 ? ` 等 ${failed.length} 项` : ""}。` +
        `失效 / 陈旧 / 不可信的复核**不得**产出建链命令 —— 请先解决门禁列出的问题。`,
      entries: [],
    };
  }

  const segmentById = new Map(
    stored.metadata.segmentation.materials.flatMap((material) =>
      material.segments.map((segment) => [segment.id, segment] as const),
    ),
  );

  const plan: LinkPlanEntry[] = [];
  for (const entry of review.matches) {
    if (entry.disposition !== "accepted_suggestion") continue;
    if (entry.paperId === null || entry.sectionId === null || entry.targetScope === null) continue;

    const segment = segmentById.get(entry.segmentId);
    if (!segment) continue;

    const scope = entry.targetScope as CourseLinkTargetScope;

    // ── 安全引用标识符：每一段都从**已校验字段**取，且过一遍字符白名单 ──
    const ref = buildSafeReviewRef({
      courseId: stored.courseId,
      candidateChecksum: stored.recomputed.candidateChecksum,
      segmentId: entry.segmentId,
      reviewedAt: review.reviewedAt,
    });

    const parts = [
      "pnpm course:link",
      `--course ${safeCliToken(stored.courseId)}`,
      `--segment ${safeCliToken(entry.segmentId)}`,
      `--paper ${safeCliToken(entry.paperId)}`,
      `--section ${safeCliToken(entry.sectionId)}`,
    ];
    if (scope !== "section" && entry.groupId !== null) parts.push(`--group ${safeCliToken(entry.groupId)}`);
    if (scope === "question" && entry.questionId !== null) parts.push(`--question ${safeCliToken(entry.questionId)}`);
    parts.push(`--scope ${scope}`);
    parts.push("--status verified");
    // `ref` 已在 buildSafeReviewRef 里过滤到安全字符集，无需再加引号
    parts.push(`--ref ${ref}`);

    plan.push({
      segmentId: entry.segmentId,
      segmentTitle: segment.title,
      segmentKind: segment.kind,
      paperId: entry.paperId,
      targetScope: scope,
      sectionId: entry.sectionId,
      groupId: entry.groupId,
      questionId: entry.questionId,
      // 自由文本**只**留在这里供人阅读；它绝不进入 command
      reviewEvidence: entry.evidence,
      ref,
      // 刻意**不加** `--commit`：这条命令默认是 dry-run，
      // 因此即使被误执行也只做校验、不写库。
      command: parts.join(" "),
    });
  }

  return { allowed: true, reason: "门禁为 PROMOTABLE，交接计划可用。", entries: plan.sort((a, b) => a.segmentId.localeCompare(b.segmentId)) };
}

/**
 * 受控字符集（**唯一允许出现在生成命令里的字符**）。
 *
 * 只保留小写字母、数字与 `._:-`。**不含**空格、引号、反引号、`$`、`;`、
 * `|`、`&`、`<`、`>`、换行 —— 因此不可能被解释成 shell 语法。
 */
const SAFE_CLI_TOKEN = /[^a-z0-9._:-]/gi;

/**
 * 把一个字段值规范成**可安全放进命令**的 token。
 *
 * 不安全的字符被替换为 `-`，并**限制长度**。这些值本来就已经过
 * slug / hex / date 约束（见 `validateCourseReviewFile` 与 `course.json` 校验），
 * 因此本函数是**纵深防御**：即使上游校验被绕过，命令里也仍然是安全字符。
 */
export function safeCliToken(value: string): string {
  const cleaned = value.replace(SAFE_CLI_TOKEN, "-").replace(/-{2,}/g, "-").slice(0, 120);
  return cleaned === "" ? "unnamed" : cleaned;
}

/**
 * 构造**确定性、shell 安全**的复核引用标识符。
 *
 * 形态：`course-review:<courseId>:<checksumPrefix>:<segmentId>:<reviewedAt>`
 *
 * 它是**纯身份**：指向 `review.json` 里那一条人写的证据。
 * 同一组输入永远给出同一个值（可复现），且只含 `[a-z0-9._:-]`。
 */
export function buildSafeReviewRef(input: {
  courseId: string;
  candidateChecksum: string;
  segmentId: string;
  reviewedAt: string;
}): string {
  const parts = [
    "course-review",
    safeCliToken(input.courseId),
    // 摘要前缀足以区分候选，且避免把 64 位十六进制塞进命令
    safeCliToken(input.candidateChecksum.slice(0, 16)),
    safeCliToken(input.segmentId),
    safeCliToken(input.reviewedAt),
  ];
  return parts.join(":");
}

// ---------------------------------------------------------------------------
// 摘要实现（与 candidate.ts 共用一份，见 digests.ts）
// ---------------------------------------------------------------------------

import {
  courseCandidateChecksum,
  courseGroupingDigest,
  courseSegmentationDigest,
  courseMatchingDigest,
} from "./digests";
