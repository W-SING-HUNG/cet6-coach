/**
 * A2 人工审核与保存服务层（Adjudication & Persistence Service）。
 *
 * ── A2 在流水线与工作台中的核心定位 ──
 *
 * A1 是「只读检查」：回答"我现在有什么"，产出检查建议（分组、分段、canonical 匹配），
 * 绝不向磁盘写入任何文件。
 *
 * A2 是「可逆留痕的人工裁决」：
 * 1. 用户审核三类独立建议：
 *    - 材料分组（materialGroupings）: accepted / rejected
 *    - 课程分段（segments）: accepted / excluded
 *    - 真题匹配（matches）: accepted_suggestion / rejected_suggestion / intentionally_unmatched
 * 2. 收集用户显式裁决 + 依据（evidence ≥ 10 字符）+ 审核人 + 审核日期。
 * 3. 严格安全校验：
 *    - 路径容纳与白名单限制（只允许写入 `course-candidates/<courseId>/review.json` 或 `course-segmentation-plans/<courseId>.json`，拒绝任何目录逃逸）
 *    - 检查源文件摘要（sourceDigest）、候选校验和（candidateChecksum）、canonical 库快照版本（canonicalLibraryDigest）是否陈旧/漂移
 * 4. 原子安全写入与备份恢复：
 *    - 采用临时文件写入 + rename 原子替换
 *    - 写入前备份旧版本（`.bak-<timestamp>-<rand>`）
 *    - 写入失败时自动恢复备份，并提供可验证的恢复保证
 * 5. 审核草稿支持：
 *    - 支持加载既有审核草稿、继续编辑、差异对比、重新打开与重新验证。
 * 6. **裁决归属核对（A2 R1）**：保存前逐条证明 proposalId / segmentId /
 *    匹配目标确实属于当前候选。借用别处 id 的裁决在写盘之前被拒绝，
 *    而不是等 A3 晋升时才被发现。
 *
 * ── 关于绑定身份：一律由服务端现场重算（P0-F1 的修复核心）──
 *
 * 浏览器提交的草稿**不携带** `candidateChecksum` / `canonicalLibraryDigest` 作为
 * 可信输入。服务端在保存/校验时：
 *
 * 1. 从磁盘读候选并用 `readStoredCandidate().recomputed.candidateChecksum`
 *    **现场重算**（`digests.ts` 唯一实现，与 `course:extract` 生成时同源）；
 * 2. 从磁盘读 canonical 库并用 `buildIndexFromDisk().index.summary.digest` 现算；
 * 3. 源摘要由调用方提供的源根经 `scanSourceDirectory` 重算（外部源必须显式给路径）。
 *
 * 因此：
 * - 全零 / 随机 / 客户端自算的摘要**不可能**通过（它们对不上现场重算值）；
 * - `allowStale` 只保留给测试用的**显式参数**，生产启动器（`course:adjudication`）
 *   与 E2E 启动器（`e2e-server-a2`）都**不传**它 ⇒ 陈旧一律失败关闭；
 * - 候选不存在 / 不完整 ⇒ 明确报错并禁止写入，绝不兜底伪装成功。
 *
 * ── 严格红线 ──
 * - 不自动替用户批准任何建议（不自动勾选，不静默设为 accept）
 * - 不写 `courses/`，不碰运行时数据库 `data/cet6.db`
 * - 不实现 A3 的晋升、导入或建链操作
 * - 不读取任何外部未经授权的真实材料
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  getCourseCandidatesDir,
  getCourseSegmentationPlansDir,
  isWithin,
} from "@/content/paper/paths";
import { assertSafeCourseId, resolveCandidateDir, sanitizeForDisplay } from "./containment";
import {
  CourseCandidateMissingError,
  readStoredCandidate,
  validateCourseReviewFile,
  type ReviewValidation,
} from "./review";
import { buildIndexFromDisk } from "./canonical";
import { scanSourceDirectory } from "./sources";
import {
  validatePlanShape,
  segmentationPlanDigest,
  type SegmentationPlanFile,
} from "./segmentation-plan";
import type {
  CourseReviewFile,
  GroupingDecision,
  SegmentDecision,
  MatchDisposition,
} from "./types";

/**
 * A2 审核草稿载荷。
 *
 * `candidateChecksum` / `canonicalLibraryDigest` 只作为**界面展示与自我核对**用；
 * 服务端保存时一律用现场重算值覆盖（见文件头说明）。
 */
export interface AdjudicationDraftPayload {
  courseId: string;
  reviewer: string;
  reviewedAt: string; // YYYY-MM-DD
  candidateChecksum: string;
  canonicalLibraryDigest: string;
  sourceDigest: string;
  verifiedScope: string[];
  notVerified: string[];
  materialGroupings: {
    proposalId: string;
    decision: GroupingDecision;
    evidence: string;
  }[];
  segments: {
    segmentId: string;
    decision: SegmentDecision;
    evidence: string;
  }[];
  matches: {
    segmentId: string;
    disposition: MatchDisposition;
    evidence: string;
    paperId: string | null;
    targetScope: "section" | "group" | "question" | null;
    sectionId: string | null;
    groupId: string | null;
    questionId: string | null;
  }[];
}

/**
 * 陈旧性与过期性检查结果
 */
export interface StalenessCheckResult {
  isStale: boolean;
  reasons: string[];
  currentCandidateChecksum: string | null;
  currentCanonicalDigest: string | null;
  currentSourceDigest: string | null;
}

/**
 * 服务端现场重算出的**绑定身份**。
 *
 * 三个值全部来自磁盘现状，绝不取自浏览器提交。
 */
export interface ReboundIdentity {
  candidateChecksum: string;
  canonicalLibraryDigest: string;
  sourceDigest: string;
}

/**
 * 读取候选并用**唯一实现**现场重算绑定身份。
 *
 * 候选不存在 / 不完整 ⇒ 抛 `CourseCandidateMissingError`（调用方据此
 * 给出"先运行 course:extract 生成候选"的明确提示，而不是兜底全零）。
 *
 * `sourceDigest` 取**候选记录的**源摘要（`inventory.digest`）——
 * 它描述"候选是针对哪一份源生成的"。源目录的当前新鲜度由
 * `prepareReviewForSave` 单独重新清点判定（需要源根路径）。
 */
export function recomputeReboundIdentity(params: {
  courseId: string;
  candidatesDir?: string;
  papersDir?: string;
}): ReboundIdentity {
  const safeCourseId = assertSafeCourseId(params.courseId);
  const stored = readStoredCandidate(safeCourseId, params.candidatesDir);

  const index = buildIndexFromDisk(params.papersDir);
  const canonicalLibraryDigest = index.index.summary.digest;
  if (!/^[0-9a-f]{64}$/.test(canonicalLibraryDigest)) {
    // 库摘要不是合法 sha256 ⇒ 无法证明匹配证据的新鲜度 ⇒ 失败关闭
    throw new Error(
      "无法从磁盘上的 canonical 真题库得到合法摘要（库目录缺失或不可读）。" +
        "在证明匹配证据针对哪一份库之前，不能保存人工审核决定。",
    );
  }

  return {
    candidateChecksum: stored.recomputed.candidateChecksum,
    canonicalLibraryDigest,
    sourceDigest: stored.recomputed.sourceDigest,
  };
}

/**
 * 供界面**预先取得绑定身份**的只读函数。
 *
 * ── 为什么需要它（P0-F1 的 UI 验收点）──
 *
 * 界面必须能回答"这份审核将绑定哪一份候选、哪一版真题库"。
 * 但 `prepareReviewForSave` 在草稿还不完整（没填审核人/依据）时就会
 * 提前返回，拿不到重算值。因此这里单独暴露"候选存在性 + 现场重算身份"，
 * 让绑定面板在任何时候都能显示真相。
 *
 * 候选不存在 ⇒ `candidateExists: false`，`rebound: null`。
 * 界面据此给出"先运行 course:extract"的明确提示，而不是显示占位摘要。
 */
export function describeBinding(params: {
  courseId: string;
  candidatesDir?: string;
  papersDir?: string;
}): {
  candidateExists: boolean;
  rebound: ReboundIdentity | null;
  reason: string | null;
} {
  try {
    const rebound = recomputeReboundIdentity({
      courseId: params.courseId,
      candidatesDir: params.candidatesDir,
      papersDir: params.papersDir,
    });
    return { candidateExists: true, rebound, reason: null };
  } catch (err) {
    return {
      candidateExists: false,
      rebound: null,
      reason:
        err instanceof CourseCandidateMissingError
          ? err.message
          : `无法读取候选：${(err as Error).message}`,
    };
  }
}

/**
 * 校验审核草稿是否陈旧（对比当前候选、真题库与源快照）
 */
export function checkAdjudicationStaleness(params: {
  courseId: string;
  draftCandidateChecksum: string;
  draftCanonicalDigest: string;
  draftSourceDigest?: string | null;
  candidatesDir?: string;
  papersDir?: string;
  sourceDir?: string | null;
}): StalenessCheckResult {
  const reasons: string[] = [];
  const safeCourseId = assertSafeCourseId(params.courseId);
  const candidatesDir = params.candidatesDir ?? getCourseCandidatesDir();

  let currentCandidateChecksum: string | null = null;
  let currentCanonicalDigest: string | null = null;
  let currentSourceDigest: string | null = null;

  // 1. 检查候选校验和
  try {
    const stored = readStoredCandidate(safeCourseId, candidatesDir);
    currentCandidateChecksum = stored.recomputed.candidateChecksum;
    if (params.draftCandidateChecksum !== currentCandidateChecksum) {
      reasons.push(
        `候选已更新或发生变动（草稿绑定: ${params.draftCandidateChecksum.slice(0, 12)}…，当前现场重算: ${currentCandidateChecksum.slice(0, 12)}…）`,
      );
    }
  } catch (err) {
    reasons.push(`无法读取候选文件或候选不存在：${(err as Error).message}`);
  }

  // 2. 检查 canonical 库摘要
  try {
    const idx = buildIndexFromDisk(params.papersDir);
    currentCanonicalDigest = idx.index.summary.digest;
    if (currentCanonicalDigest && params.draftCanonicalDigest !== currentCanonicalDigest) {
      reasons.push(
        `canonical 真题库自草稿生成以来已更新（草稿绑定: ${params.draftCanonicalDigest.slice(0, 12)}…，当前库: ${currentCanonicalDigest.slice(0, 12)}…）`,
      );
    }
  } catch (err) {
    reasons.push(`无法读取 canonical 真题库：${(err as Error).message}`);
  }

  // 3. 检查源文件摘要（如果提供了源路径）
  if (params.sourceDir && existsSync(params.sourceDir)) {
    try {
      const inv = scanSourceDirectory(params.sourceDir);
      currentSourceDigest = inv.digest;
      if (params.draftSourceDigest && params.draftSourceDigest !== currentSourceDigest) {
        reasons.push(
          `源课程目录自草稿生成以来已更新或修改（草稿记录: ${params.draftSourceDigest.slice(0, 12)}…，当前源摘要: ${currentSourceDigest.slice(0, 12)}…）`,
        );
      }
    } catch (err) {
      // 源读取失败记为警告原因
      reasons.push(`无法读取源目录：${(err as Error).message}`);
    }
  }

  return {
    isStale: reasons.length > 0,
    reasons,
    currentCandidateChecksum,
    currentCanonicalDigest,
    currentSourceDigest,
  };
}

/**
 * 校验草稿内容的结构与依据规范性
 */
export function validateAdjudicationDraft(payload: unknown): {
  ok: boolean;
  errors: string[];
  reviewFile: CourseReviewFile | null;
} {
  const result = validateCourseReviewFile(payload);
  const errors = [...result.errors];

  // ── 重复 / 冲突裁决必须在服务端拒绝（P2-F5）──
  //
  // 既有 `validateCourseReviewFile` 只做**形状**校验：同一个 segmentId
  // 出现两次（一次 accepted、一次 excluded）在形状上完全合法，但它会让
  // "这个段到底被没被排除"变成不可判定的歧义 —— 而下游门禁按 id 建
  // 决策表，后写覆盖先写。那正是"重复条目悄悄改判"的缺陷形态。
  const candidate = payload as Partial<AdjudicationDraftPayload> | null;
  if (candidate && typeof candidate === "object") {
    const groupingIds = new Map<string, number>();
    for (const [index, item] of (candidate.materialGroupings ?? []).entries()) {
      const id = item?.proposalId;
      if (typeof id !== "string" || id === "") continue;
      groupingIds.set(id, (groupingIds.get(id) ?? 0) + 1);
      if (groupingIds.get(id) === 2) {
        errors.push(`materialGroupings[${index}]：proposalId「${id}」被重复裁决 —— 同一分组只能有一条决定`);
      }
    }
    const segmentIds = new Map<string, number>();
    for (const [index, item] of (candidate.segments ?? []).entries()) {
      const id = item?.segmentId;
      if (typeof id !== "string" || id === "") continue;
      segmentIds.set(id, (segmentIds.get(id) ?? 0) + 1);
      if (segmentIds.get(id) === 2) {
        errors.push(`segments[${index}]：segmentId「${id}」被重复裁决 —— 同一分段只能有一条决定`);
      }
    }
    const matchIds = new Map<string, number>();
    for (const [index, item] of (candidate.matches ?? []).entries()) {
      const id = item?.segmentId;
      if (typeof id !== "string" || id === "") continue;
      matchIds.set(id, (matchIds.get(id) ?? 0) + 1);
      if (matchIds.get(id) === 2) {
        errors.push(`matches[${index}]：segmentId「${id}」被重复裁决 —— 同一分段只能有一条匹配决定`);
      }
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    reviewFile: result.file,
  };
}

// ---------------------------------------------------------------------------
// A2 R1 · 裁决归属核对（保存前拒绝"不属于当前候选"的裁决）
// ---------------------------------------------------------------------------

/**
 * 一条**引用了他处对象**的裁决必须证明那个对象属于当前候选。
 *
 * ── 为什么形状校验不够（A2 独立评审 R1）──
 *
 * `validateCourseReviewFile` 只校验**形状**：`proposalId` 是个非空字符串、
 * `segmentId` 是个非空字符串、`disposition` 合法。它**不**知道这些 id 指向的
 * 东西是否真的存在于当前候选里。
 *
 * 后果不是"无害的多余条目"，而是三类真实的失效：
 *
 * 1. **跨课程借用**：评审 A 课程的候选时，把 B 课程的 `proposalId` 写进来。
 *    形状合法，但它化解的是另一门课的事项 —— A 课程的阻断事项仍然未裁决，
 *    而门禁只看到"A 有了一条分组裁决"。
 * 2. **跨候选版本沿用**：候选重新生成后段 id 变了，人复制了旧的 review.json
 *    改几个字。旧 segmentId 不在新候选里 ⇒ 该裁决静默失效。
 * 3. **编造目标**：`accepted_suggestion` 指向一个机器**从未提出过**的
 *    paper/section/group/question 组合 —— 那是凭空创造一条建链依据。
 *
 * 第 3 类尤其危险：下游门禁确实有 `match_decisions_reference_proposed_suggestions`
 * 这一项，但它跑在**晋升时**。也就是说一条非法裁决可以**被保存、被当作
 * "已完成的审核"**，直到 A3 才被发现 —— 而那时人会以为"审核早就做完了"。
 *
 * 因此判据必须前移到**保存前**：非法裁决在写盘之前被拒绝，而不是等 A3 再拦。
 *
 * ── 为什么这是一个纯函数 ──
 *
 * 它只消费"当前候选的事实"与"草稿"，因此可以被行为穷举（给数据、断言结果），
 * 而不是只能靠源码字符串匹配守护。这与 `resolvePickOutcome` / `isBlockingItemResolved`
 * 是同一条纪律。
 *
 * ── 它刻意不做什么 ──
 *
 * - **不**代替下游门禁：`grouping_decisions_reference_real_proposals` 等项
 *   仍然在晋升时独立求值（判据不得只有一处 —— 那是单点失效）。
 * - **不**自动删除非法条目：那是替人猜。它只**报告**并拒绝保存。
 * - **不**接受任何"忽略此项"的开关：一旦存在旁路，这条判据就等于不存在。
 */
export interface OwnershipViolation {
  /** 裁决所在的分组（用于界面定位）。 */
  section: "materialGroupings" | "segments" | "matches";
  /** 该分组内的下标。 */
  index: number;
  /** 被引用但不属于当前候选的对象 id。 */
  referencedId: string;
  /** 人可读的原因（不含绝对路径）。 */
  reason: string;
}

/**
 * 当前候选的**可引用对象集合**。
 *
 * 全部来自 `StoredCandidate`（已由 `readStoredCandidate` 现场读盘），
 * 因此这里不做任何 I/O —— 判据与磁盘访问分开，才能被单独测试。
 */
export interface CandidateOwnership {
  /** 候选里真实存在的材料分组提案 id。 */
  proposalIds: ReadonlySet<string>;
  /** 候选里真实存在的课程段 id。 */
  segmentIds: ReadonlySet<string>;
  /**
   * 段 id → 该段**机器实际提出过**的建议目标键集合。
   *
   * 键的构造与 `review.ts` 的 `targetKeyOfSuggestion` 完全一致
   * （`paperId|sectionId|groupId|questionId`）—— 两处各写一份必然漂移，
   * 而漂移的后果是"保存时放过、晋升时拒绝"这种前后不一致。
   */
  suggestedTargetsBySegment: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * 从候选元数据提取可引用对象集合。
 *
 * 单独成函数（而不是内联进 `checkAdjudicationOwnership`）的理由：
 * 调用方常常已经有 `StoredCandidate`，而"怎么从候选取出这些集合"
 * 与"怎么判定一条裁决非法"是两个可以独立验证的问题。
 */
export function collectCandidateOwnership(stored: {
  metadata: {
    grouping: { proposals: { id: string }[] };
    segmentation: { materials: { segments: { id: string }[] }[] };
    matching: {
      segments: {
        segmentId: string;
        suggestions: {
          target: { paperId: string; sectionId: string; groupId: string | null; questionId: string | null };
        }[];
      }[];
    };
  };
}): CandidateOwnership {
  const proposalIds = new Set(stored.metadata.grouping.proposals.map((proposal) => proposal.id));
  const segmentIds = new Set(
    stored.metadata.segmentation.materials.flatMap((material) => material.segments.map((segment) => segment.id)),
  );

  const suggestedTargetsBySegment = new Map<string, Set<string>>();
  for (const segment of stored.metadata.matching.segments) {
    const keys = new Set<string>();
    for (const suggestion of segment.suggestions) {
      const target = suggestion.target;
      keys.add(`${target.paperId}|${target.sectionId}|${target.groupId ?? ""}|${target.questionId ?? ""}`);
    }
    suggestedTargetsBySegment.set(segment.segmentId, keys);
  }

  return { proposalIds, segmentIds, suggestedTargetsBySegment };
}

/**
 * 判定草稿里的每一条裁决是否**归属于当前候选**。
 *
 * 返回空数组 = 全部合法。非空 = 保存必须被拒绝，且每条违规都要能被人定位
 * （哪一节、第几条、引用了哪个 id）。
 *
 * ── 逐类判据 ──
 *
 * | 分组 | 判据 | 为什么 |
 * | --- | --- | --- |
 * | `materialGroupings` | `proposalId` 必须存在于候选 | 化解的是**这个**候选的事项 |
 * | `segments` | `segmentId` 必须存在于候选 | 同上 |
 * | `matches` | `segmentId` 必须存在于候选 | 匹配裁决必须先锚定一个真实段 |
 * | `matches`（接受/否决） | 目标键必须是该段**机器提出过的**建议 | 不得凭空接受一个从未出现的映射 |
 *
 * `intentionally_unmatched` **不**要求目标键：它的含义就是"这段有意不匹配"，
 * 因此没有目标。这一点与 `validateCourseReviewFile` 的形状规则一致
 * （该 disposition 下 `paperId` 可以缺失）。
 */
export function checkAdjudicationOwnership(
  draft: {
    materialGroupings?: { proposalId?: unknown }[];
    segments?: { segmentId?: unknown }[];
    matches?: {
      segmentId?: unknown;
      disposition?: unknown;
      paperId?: unknown;
      sectionId?: unknown;
      groupId?: unknown;
      questionId?: unknown;
    }[];
  },
  ownership: CandidateOwnership,
): OwnershipViolation[] {
  const violations: OwnershipViolation[] = [];

  for (const [index, entry] of (draft.materialGroupings ?? []).entries()) {
    const proposalId = entry?.proposalId;
    if (typeof proposalId !== "string" || proposalId === "") continue; // 形状错误由既有校验报告
    if (!ownership.proposalIds.has(proposalId)) {
      violations.push({
        section: "materialGroupings",
        index,
        referencedId: proposalId,
        reason:
          `材料分组「${proposalId}」不属于当前候选 —— 裁决只能针对本次生成的这一份候选。` +
          `它可能来自另一门课程，或来自重新生成候选之前的旧版本。`,
      });
    }
  }

  for (const [index, entry] of (draft.segments ?? []).entries()) {
    const segmentId = entry?.segmentId;
    if (typeof segmentId !== "string" || segmentId === "") continue;
    if (!ownership.segmentIds.has(segmentId)) {
      violations.push({
        section: "segments",
        index,
        referencedId: segmentId,
        reason:
          `课程段「${segmentId}」不属于当前候选 —— 段 id 在候选重新生成后可能变化，` +
          `旧审核里的段 id 不会自动适用于新候选。`,
      });
    }
  }

  for (const [index, entry] of (draft.matches ?? []).entries()) {
    const segmentId = entry?.segmentId;
    if (typeof segmentId !== "string" || segmentId === "") continue;
    if (!ownership.segmentIds.has(segmentId)) {
      violations.push({
        section: "matches",
        index,
        referencedId: segmentId,
        reason: `课程段「${segmentId}」不属于当前候选 —— 匹配裁决必须先锚定一个真实存在的段。`,
      });
      // 段本身不存在时，"目标是否被提出过"已无从判断 ⇒ 不必再报第二条
      continue;
    }

    if (entry.disposition === "intentionally_unmatched") continue;

    const targetKey =
      `${String(entry.paperId ?? "")}|${String(entry.sectionId ?? "")}|` +
      `${String(entry.groupId ?? "")}|${String(entry.questionId ?? "")}`;
    const proposed = ownership.suggestedTargetsBySegment.get(segmentId);
    if (!proposed || !proposed.has(targetKey)) {
      violations.push({
        section: "matches",
        index,
        referencedId: `${segmentId} → ${targetKey}`,
        reason:
          `这条匹配裁决指向的目标**不是机器在这段上提出过的建议**。` +
          `裁决只能接受或否决候选里真实出现过的候选映射 ——` +
          `凭空指定一个目标等于未经比较就创造建链依据。`,
      });
    }
  }

  return violations;
}

/**
 * 确定安全 review.json 写入目标路径（强制白名单边界）
 */
export function resolveSafeReviewPath(courseId: string, candidatesDir?: string): string {
  const safeId = assertSafeCourseId(courseId);
  const rootDir = candidatesDir ?? getCourseCandidatesDir();
  const candidateDir = resolveCandidateDir(safeId, rootDir);
  const targetPath = join(candidateDir, "review.json");

  // 深度防御：绝对路径必须在 candidateDir 之内
  if (!isWithin(resolve(candidateDir), resolve(targetPath))) {
    throw new Error(`目标路径逃逸了候选目录: ${sanitizeForDisplay(targetPath, 80)}`);
  }
  return targetPath;
}

/**
 * 确定安全 segmentation plan 写入目标路径（强制白名单边界）
 */
export function resolveSafePlanPath(courseId: string, plansDir?: string): string {
  const safeId = assertSafeCourseId(courseId);
  const rootDir = plansDir ?? getCourseSegmentationPlansDir();
  const targetPath = join(rootDir, `${safeId}.json`);

  // 深度防御：绝对路径必须在 plansDir 之内
  if (!isWithin(resolve(rootDir), resolve(targetPath))) {
    throw new Error(`目标路径逃逸了分段计划目录: ${sanitizeForDisplay(targetPath, 80)}`);
  }
  return targetPath;
}

/**
 * 原子写入文件，并在已有同名文件时先自动备份
 */
export function writeAtomicWithBackup(
  filePath: string,
  content: string,
): { backupPath: string | null; tempPath: string } {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let backupPath: string | null = null;
  if (existsSync(filePath)) {
    backupPath = `${filePath}.bak-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    // 先做安全备份
    writeFileSync(backupPath, readFileSync(filePath));
  }

  const tempPath = `${filePath}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    writeFileSync(tempPath, content, "utf8");
    renameSync(tempPath, filePath);
  } catch (err) {
    // 写入失败时如果临时文件存在，尝试清理
    if (existsSync(tempPath)) {
      try { unlinkSync(tempPath); } catch {}
    }
    // 如果有备份且原文件丢失/损坏，尝试恢复原文件
    if (backupPath && existsSync(backupPath) && !existsSync(filePath)) {
      try { renameSync(backupPath, filePath); } catch {}
    }
    throw err;
  }

  return { backupPath, tempPath };
}

/**
 * 从备份安全还原文件
 */
export function restoreFromBackup(filePath: string, backupPath: string): boolean {
  if (!existsSync(backupPath)) return false;
  try {
    writeFileSync(filePath, readFileSync(backupPath));
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// 保存前校验（形状 + 依据 + 绑定身份）
// ---------------------------------------------------------------------------

/** 决定条目依据长度判据（≥ 10 字符，与既有 review 契约一致）。 */
const MIN_EVIDENCE_CHARS = 10;

/**
 * 保存前校验草稿。
 *
 * ── 为什么必须**核对**客户端摘要而不是覆盖它（P0-F1 的核心语义）──
 *
 * 若服务端直接把客户端摘要覆盖成现场重算值，那么一个**过期页面**
 * （打开后候选已被重新生成）也能成功保存 —— 于是"人复核的是 v1"
 * 与"落盘的 review 绑定 v2"悄悄分叉。那正是整套校验和机制要防的缺陷。
 *
 * 因此顺序是：
 * 1. 服务端从磁盘**现场重算**绑定身份；
 * 2. 客户端提交的摘要**必须与之相等**，否则拒绝（过期页面 / 伪造摘要）；
 * 3. 落盘时写**服务端重算值**（它与第 2 步已验证的客户端值相等）。
 *
 * 任一步失败 ⇒ `ok: false` 且**零写副作用**。
 */
export function prepareReviewForSave(params: {
  draft: AdjudicationDraftPayload;
  candidatesDir?: string;
  papersDir?: string;
  sourceDir?: string | null;
  /** 候选不存在时是否允许继续（测试专用；生产不传）。 */
  allowMissingCandidate?: boolean;
}): {
  ok: boolean;
  errors: string[];
  reviewFile: CourseReviewFile | null;
  rebound: ReboundIdentity | null;
  candidateExists: boolean;
} {
  const draft = params.draft;
  const errors: string[] = [];

  // ── 1) 依据完整性（先于磁盘访问，纯输入校验）──
  const missingEvidence = (
    list: { evidence?: string }[],
    label: string,
  ): string[] =>
    list
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => typeof item.evidence !== "string" || item.evidence.trim().length < MIN_EVIDENCE_CHARS)
      .map(({ index }) => `${label}[${index}]的审核依据不得少于 ${MIN_EVIDENCE_CHARS} 个字符`);

  errors.push(
    ...missingEvidence(draft.materialGroupings ?? [], "材料分组"),
    ...missingEvidence(draft.segments ?? [], "课程分段"),
    ...missingEvidence(draft.matches ?? [], "真题匹配"),
  );

  if (typeof draft.reviewer !== "string" || draft.reviewer.trim() === "") {
    errors.push("审核人姓名缺失");
  }
  if (typeof draft.courseId !== "string" || draft.courseId.trim() === "") {
    errors.push("课程标识缺失");
  }

  // ── 2) 客户端摘要的**形态**判据：全零 / 非 64 位十六进制一律拒绝 ──
  //
  // 这不是"再校验一次"，而是把"兜底值根本不该被提交"变成结构性事实：
  // 全零串来自上一版的客户端兜底，它的出现即说明界面没有拿到真实绑定身份。
  if (!/^[0-9a-f]{64}$/.test(draft.candidateChecksum ?? "")) {
    errors.push(
      "候选校验和缺失或不是 64 位小写十六进制摘要。" +
        "它必须来自本机候选的真实校验和（界面第 ⑤ 步会显示）—— 全零或占位值不被接受。",
    );
  }
  if (!/^[0-9a-f]{64}$/.test(draft.canonicalLibraryDigest ?? "")) {
    errors.push(
      "canonical 真题库摘要缺失或不是 64 位小写十六进制摘要。" +
        "它必须来自本机真题库的真实摘要 —— 全零或占位值不被接受。",
    );
  }

  // ── 3) 候选必须存在且完整（明确提示，绝不兜底）──
  let candidateExists = true;
  let stored: ReturnType<typeof readStoredCandidate> | null = null;
  try {
    stored = readStoredCandidate(draft.courseId, params.candidatesDir);
  } catch (err) {
    candidateExists = false;
    if (!(err instanceof CourseCandidateMissingError) || !params.allowMissingCandidate) {
      errors.push(
        err instanceof CourseCandidateMissingError
          ? `候选不存在或不完整：${err.message}`
          : `候选不可用：${(err as Error).message}`,
      );
    }
  }

  // ── 4) 形状 + 重复裁决校验 ──
  const validation = validateAdjudicationDraft(draft);
  errors.push(...validation.errors);

  // ── 4b) 裁决归属核对（A2 R1）：引用的对象必须属于当前候选 ──
  //
  // 位置刻意在**形状校验之后、现场重算之前**：
  // - 形状先错时没有必要去读盘取归属集合（省掉一次无谓 I/O）；
  // - 但它必须在**任何写盘之前** —— 一条借用别处 id 的裁决一旦被保存，
  //   就会被当成"这门课已经审核完了"，而它的阻断事项其实一条都没化解。
  //
  // `stored` 为 null（候选不存在）时不报归属错误：那时"候选不存在"
  // 已经是一条更根本的错误，再报 N 条归属错误只会把人引向错的方向。
  if (stored !== null) {
    const violations = checkAdjudicationOwnership(draft, collectCandidateOwnership(stored));
    for (const violation of violations) {
      errors.push(
        `${violation.section}[${violation.index}]：${violation.reason}` +
          `请重新检查并刷新后再保存；系统不会自动删除或改写你的裁决。`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, reviewFile: null, rebound: null, candidateExists };
  }

  // ── 5) 服务端现场重算绑定身份（磁盘真相）──
  let rebound: ReboundIdentity;
  try {
    rebound = recomputeReboundIdentity({
      courseId: draft.courseId,
      candidatesDir: params.candidatesDir,
      papersDir: params.papersDir,
    });
  } catch (err) {
    return {
      ok: false,
      errors: [`无法取得可验证的绑定身份：${(err as Error).message}`],
      reviewFile: null,
      rebound: null,
      candidateExists,
    };
  }

  // ── 6) 客户端摘要必须与服务端重算值**相等**（过期页面 / 伪造摘要必败）──
  if (draft.candidateChecksum !== rebound.candidateChecksum) {
    errors.push(
      `草稿绑定的候选校验和与当前候选不一致（界面: ${draft.candidateChecksum.slice(0, 12)}…，` +
        `当前候选: ${rebound.candidateChecksum.slice(0, 12)}…）。` +
        `这通常表示候选已被重新生成而本页是过期视图 —— 请重新检查并刷新后再保存。`,
    );
  }
  if (draft.canonicalLibraryDigest !== rebound.canonicalLibraryDigest) {
    errors.push(
      `草稿绑定的真题库摘要与当前库不一致（界面: ${draft.canonicalLibraryDigest.slice(0, 12)}…，` +
        `当前库: ${rebound.canonicalLibraryDigest.slice(0, 12)}…）。` +
        `匹配证据针对的是另一份真题库 —— 请重新检查并刷新后再保存。`,
    );
  }

  // ── 7) 源新鲜度（若提供了源根）：与**候选记录的**源摘要比对 ──
  //
  // 刻意不与"本次检查范围的摘要"比：A1/A2 的检查可以只选一部分文件，
  // 那份摘要是**部分**快照，与候选的**全量**记录本就不同。
  // 真正的判据是"候选生成之后源有没有变"，即重新清点整个源根。
  if (params.sourceDir && stored !== null && existsSync(params.sourceDir)) {
    try {
      const currentSourceDigest = scanSourceDirectory(params.sourceDir).digest;
      if (currentSourceDigest !== stored.metadata.inventory.digest) {
        errors.push(
          `源课程目录自候选生成以来已变化（候选记录: ${stored.metadata.inventory.digest.slice(0, 12)}…，` +
            `当前源: ${currentSourceDigest.slice(0, 12)}…）。请重新生成候选后再审核。`,
        );
      }
    } catch (err) {
      errors.push(`无法重新清点源目录：${(err as Error).message}`);
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors, reviewFile: null, rebound, candidateExists };
  }

  // ── 8) 用现场重算值构造最终 review 文件体（与第 6 步已验证的值相等）──
  const reviewFile: CourseReviewFile = {
    courseId: draft.courseId,
    reviewer: draft.reviewer,
    reviewedAt: draft.reviewedAt,
    candidateChecksum: rebound.candidateChecksum,
    canonicalLibraryDigest: rebound.canonicalLibraryDigest,
    materialGroupings: (draft.materialGroupings ?? []).map((item) => ({
      proposalId: item.proposalId,
      decision: item.decision,
      evidence: item.evidence,
      note: "",
    })),
    segments: (draft.segments ?? []).map((item) => ({
      segmentId: item.segmentId,
      decision: item.decision,
      evidence: item.evidence,
      note: "",
    })),
    matches: (draft.matches ?? []).map((item) => ({
      segmentId: item.segmentId,
      disposition: item.disposition,
      evidence: item.evidence,
      paperId: item.paperId,
      targetScope: item.targetScope,
      sectionId: item.sectionId,
      groupId: item.groupId ?? null,
      questionId: item.questionId ?? null,
      note: "",
    })),
    verifiedScope: draft.verifiedScope,
    notVerified: draft.notVerified,
  };

  // 最终形状复核（用**现场重算后**的文件体再过一次既有契约）
  const finalValidation = validateCourseReviewFile(reviewFile);
  if (!finalValidation.ok || finalValidation.file === null) {
    return {
      ok: false,
      errors: [`服务端重算后的复核记录仍未通过既有契约：${finalValidation.errors.join("；")}`],
      reviewFile: null,
      rebound,
      candidateExists,
    };
  }

  return { ok: true, errors: [], reviewFile: finalValidation.file, rebound, candidateExists };
}

// ---------------------------------------------------------------------------
// 保存 review.json
// ---------------------------------------------------------------------------

/**
 * A2 保存裁决结果服务。
 *
 * ── 保存路径（P0-F1 修复后的顺序）──
 *
 * 1. `prepareReviewForSave`：依据完整性 → 摘要形态（拒绝全零/占位）→
 *    候选存在 → 形状/重复裁决 → **服务端现场重算** → **客户端摘要必须
 *    与重算值相等** → 源新鲜度 → 构造 review 文件体；
 * 2. 安全路径解析（只允许 `course-candidates/<id>/review.json`）；
 * 3. 原子写 + 备份。
 *
 * `allowStale` **只**存在于显式参数里，供受控测试构造"旧审核"对象。
 * 生产启动器与 E2E 启动器都不传它 ⇒ 陈旧一律失败关闭。
 */
export function saveAdjudicationReview(params: {
  draft: AdjudicationDraftPayload;
  allowStale?: boolean;
  candidatesDir?: string;
  papersDir?: string;
  sourceDir?: string | null;
}): {
  ok: boolean;
  filePath: string;
  backupPath: string | null;
  errors?: string[];
  rebound?: ReboundIdentity;
  candidateMissing?: boolean;
} {
  // 1. 保存前校验（含现场重算绑定身份与客户端摘要核对）
  const prepared = prepareReviewForSave({
    draft: params.draft,
    candidatesDir: params.candidatesDir,
    papersDir: params.papersDir,
    sourceDir: params.sourceDir,
  });

  if (!prepared.ok || prepared.reviewFile === null || prepared.rebound === null) {
    return {
      ok: false,
      filePath: "",
      backupPath: null,
      errors: prepared.errors,
      candidateMissing: !prepared.candidateExists,
    };
  }

  // 2. 安全路径解析（只允许写入 course-candidates/<courseId>/review.json）
  const targetPath = resolveSafeReviewPath(params.draft.courseId, params.candidatesDir);

  // 3. 原子安全写入
  const serialized = JSON.stringify(prepared.reviewFile, null, 2) + "\n";
  const { backupPath } = writeAtomicWithBackup(targetPath, serialized);

  return {
    ok: true,
    filePath: targetPath,
    backupPath,
    rebound: prepared.rebound,
  };
}

/**
 * 读取已有审核草稿（若存在）
 */
export function loadAdjudicationDraft(params: {
  courseId: string;
  candidatesDir?: string;
}): {
  exists: boolean;
  raw: CourseReviewFile | null;
  validation: ReviewValidation;
} {
  const targetPath = resolveSafeReviewPath(params.courseId, params.candidatesDir);
  if (!existsSync(targetPath)) {
    return {
      exists: false,
      raw: null,
      validation: { ok: false, errors: ["复核记录文件不存在"], file: null },
    };
  }

  try {
    const content = readFileSync(targetPath, "utf8");
    const parsed = JSON.parse(content);
    const val = validateCourseReviewFile(parsed);
    return {
      exists: true,
      raw: val.file,
      validation: val,
    };
  } catch (err) {
    return {
      exists: true,
      raw: null,
      validation: {
        ok: false,
        errors: [`读取或解析已存在的 review.json 失败: ${(err as Error).message}`],
        file: null,
      },
    };
  }
}

// ---------------------------------------------------------------------------
// 保存人工分段计划（P1-F3）
// ---------------------------------------------------------------------------

/** 浏览器提交的一条指派（服务端会重新构造绑定）。 */
export interface SubmittedPlanAssignment {
  channel: string;
  assetKey: string;
  page: number;
  lineStart: number;
  lineEnd: number;
  note: string | null;
}

/** 浏览器提交的一个单元。 */
export interface SubmittedPlanUnit {
  title: string;
  kind: string;
  assignments: SubmittedPlanAssignment[];
}

/** 浏览器提交的计划（**不含** binding —— 绑定由服务端构造）。 */
export interface SubmittedPlan {
  author: string;
  reason: string;
  units: SubmittedPlanUnit[];
}

/** 浏览器提交的计划（**不含** binding —— 绑定由服务端构造）。 */
export interface SubmittedPlan {
  author: string;
  reason: string;
  units: SubmittedPlanUnit[];
}

/**
 * 由**服务端**构造计划文件（浏览器只提供结构，不提供绑定）。
 *
 * 与 `buildPlanFromSubmission` 同一套纪律：`binding`（课程 id / 源摘要 /
 * 资产校验和）**一律由服务端在当前时刻重新计算**，否则一个陈旧页面带着
 * 旧 binding 就能写出一份"看起来有效"的陈旧计划。
 */
export function buildAdjudicationPlan(input: {
  submitted: SubmittedPlan;
  courseId: string;
  sourceDigest: string;
  currentAssetChecksums: { assetKey: string; sha256: string }[];
}): SegmentationPlanFile {
  return {
    schemaVersion: 1,
    binding: {
      courseId: input.courseId,
      sourceDigest: input.sourceDigest,
      assets: [...input.currentAssetChecksums]
        .sort((a, b) => a.assetKey.localeCompare(b.assetKey))
        .map((asset) => ({ assetKey: asset.assetKey, sha256: asset.sha256 })),
    },
    author: input.submitted.author,
    createdAt: new Date().toISOString(),
    reason: input.submitted.reason,
    units: input.submitted.units.map((unit) => ({
      title: unit.title,
      kind: unit.kind,
      assignments: unit.assignments.map((assignment) => ({
        channel: assignment.channel,
        range: {
          assetKey: assignment.assetKey,
          page: assignment.page,
          lineStart: assignment.lineStart,
          lineEnd: assignment.lineEnd,
        },
        note: assignment.note ?? null,
      })),
    })),
  } as SegmentationPlanFile;
}

/**
 * 保存人工分段计划。
 *
 * 与 review 的关系（V1 契约，刻意不对称）：
 * - **计划是结构输入**，落在 `course-segmentation-plans/<id>.json`；
 * - **review 是验收记录**，落在 `course-candidates/<id>/review.json`；
 * - 计划**绝不**自动批准任何人工裁决；review 也**绝不**改写候选结构。
 *
 * 保存成功 ⇒ 返回计划校验和（由**唯一实现** `segmentationPlanDigest` 算出）。
 */
export function saveAdjudicationPlan(params: {
  courseId: string;
  plan: unknown;
  plansDir?: string;
  /** 服务端现场扫描源目录得到的资产校验和（绑定用）。 */
  currentAssetChecksums?: { assetKey: string; sha256: string }[];
  sourceDir?: string | null;
  /** 直接给定源摘要（测试用）；与 `sourceDir` 二选一。 */
  sourceDigest?: string;
}): {
  ok: boolean;
  filePath: string;
  backupPath: string | null;
  errors: string[];
  planDigest: string;
} {
  const errors: string[] = [];

  // ── 1) 服务端重算绑定（源摘要 + 资产校验和）──
  //
  // **先于形状校验**：`binding` 一律由服务端现算后注入，浏览器/调用方
  // 永远不需要（也不应该）自己提供它。这与 `buildPlanFromSubmission`
  // 是同一条纪律 —— 否则一个陈旧页面带着旧 binding 就能写出
  // "看起来有效"的陈旧计划。
  let sourceDigest = params.sourceDigest;
  let assetChecksums = params.currentAssetChecksums;
  if (params.sourceDir && existsSync(params.sourceDir)) {
    try {
      const inventory = scanSourceDirectory(params.sourceDir);
      sourceDigest = inventory.digest;
      assetChecksums = inventory.assets.map((asset) => ({ assetKey: asset.assetKey, sha256: asset.sha256 }));
    } catch (err) {
      return {
        ok: false,
        filePath: "",
        backupPath: null,
        errors: [`无法重新清点源目录以计算计划绑定：${(err as Error).message}`],
        planDigest: "",
      };
    }
  }
  if (sourceDigest === undefined || assetChecksums === undefined) {
    return {
      ok: false,
      filePath: "",
      backupPath: null,
      errors: ["缺少源摘要或资产校验和 —— 计划绑定必须由服务端现算（提供 sourceDir 或显式传入二者）"],
      planDigest: "",
    };
  }

  // ── 2) 注入服务端绑定后做形状校验（既有唯一实现）──
  const raw = params.plan as Record<string, unknown> | null;
  const submitted = raw && typeof raw === "object" ? raw : {};
  const rebound = {
    ...submitted,
    schemaVersion: 1,
    binding: {
      courseId: params.courseId,
      sourceDigest,
      assets: [...assetChecksums].sort((a, b) => a.assetKey.localeCompare(b.assetKey)),
    },
  };
  const shape = validatePlanShape(rebound);
  if (!shape.ok || shape.plan === null) {
    return {
      ok: false,
      filePath: "",
      backupPath: null,
      errors: shape.issues.map((issue) => `${issue.code}@${issue.where}：${issue.detail}`),
      planDigest: "",
    };
  }

  // ── 3) 绑定一致性（服务端刚注入，理论上恒真；仍是显式断言）──
  //
  // 判据分两层：
  // - `binding.sourceDigest` 等于当前源摘要（最强守卫：源字节一变即陈旧）；
  // - 计划**引用**的每个资产都存在于当前源（键存在性）。
  //   这里**不**逐个核对 sha256 —— `sourceDigest` 已覆盖"内容变了"。
  const plan = shape.plan;
  if (plan.binding.courseId !== params.courseId) {
    errors.push(`计划绑定的课程 id（${plan.binding.courseId}）与当前课程（${params.courseId}）不一致`);
  }
  if (plan.binding.sourceDigest !== sourceDigest) {
    errors.push(
      `计划绑定的源摘要已陈旧（计划: ${plan.binding.sourceDigest.slice(0, 12)}…，当前源: ${sourceDigest.slice(0, 12)}…）—— ` +
        `计划必须针对当前源重新生成`,
    );
  }
  if (plan.binding.assets.length === 0) {
    errors.push("计划必须绑定它引用的资产的校验和（binding.assets 不得为空）");
  }
  const currentKeys = new Set(assetChecksums.map((asset) => asset.assetKey));
  const referencedKeys = new Set<string>();
  for (const unit of plan.units) {
    for (const assignment of unit.assignments) referencedKeys.add(assignment.range.assetKey);
  }
  for (const key of referencedKeys) {
    if (!currentKeys.has(key)) {
      errors.push(`计划引用的资产在当前源中不存在：${key}`);
    }
  }
  if (errors.length > 0) {
    return { ok: false, filePath: "", backupPath: null, errors, planDigest: "" };
  }

  // ── 4) 安全路径 + 原子写 ──
  const targetPath = resolveSafePlanPath(params.courseId, params.plansDir);
  const serialized = JSON.stringify(plan, null, 2) + "\n";
  const { backupPath } = writeAtomicWithBackup(targetPath, serialized);

  // 校验和由**唯一实现**算出（绝不在这里另写一份）
  const planDigest = segmentationPlanDigest(plan);

  return { ok: true, filePath: targetPath, backupPath, errors: [], planDigest };
}

/** 读取既有分段计划（若存在）。 */
export function loadAdjudicationPlan(params: {
  courseId: string;
  plansDir?: string;
}): {
  exists: boolean;
  raw: SegmentationPlanFile | null;
  issues: string[];
} {
  const targetPath = resolveSafePlanPath(params.courseId, params.plansDir);
  if (!existsSync(targetPath)) {
    return { exists: false, raw: null, issues: [] };
  }
  try {
    const parsed = JSON.parse(readFileSync(targetPath, "utf8"));
    const shape = validatePlanShape(parsed);
    return {
      exists: true,
      raw: shape.plan,
      issues: shape.issues.map((issue) => `${issue.code}@${issue.where}`),
    };
  } catch (err) {
    return { exists: true, raw: null, issues: [`解析失败：${(err as Error).message}`] };
  }
}
