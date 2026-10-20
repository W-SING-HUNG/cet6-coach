#!/usr/bin/env node
/**
 * A3 受控接入 **能力对象**（生产启动器与 E2E 实例的**唯一实现**）。
 *
 * ── 为什么它必须是一个共享模块，而不是各启动器各写一份 ──
 *
 * 本项目在 A1 轮次付过一次明确的代价：那条"真实子进程"用例用的是
 * **自带的 inline 替身脚本**，于是它验证的是替身而不是生产代码 ——
 * 而生产脚本里恰好有一行在目标宿主上必然抛错的赋值，全部绿灯都没抓住。
 *
 * 因此 A3 的能力**只有这一份**：`scripts/course-a3.ts`（生产）与
 * `scripts/e2e-server-a3.ts`（浏览器验收）都调用 `createA3Capability`。
 * 浏览器测试点到的按钮，走的就是 使用者 真实点到的同一段代码。
 *
 * ── 它包含哪些能力 ──
 *
 * | 能力 | 写什么 | 授权 |
 * | --- | --- | --- |
 * | `inspect` / `browse` / `pickFolder` | 什么都不写 | — |
 * | `loadDraft` / `validateDraft` / `saveDraft` / `savePlanDraft` | 候选/计划目录 | 人工裁决本身就是授权 |
 * | `previewCandidate` | **什么都不写** | — |
 * | `generateCandidate` | `course-candidates/<id>/` | 必须 `confirmed: true` |
 * | `previewPromotion` / `readProgress` | **什么都不写** | — |
 * | `promoteCandidate` | `courses/<id>/` | 必须 `confirmed: true`（**单独**） |
 * | `importIndex` | 数据库（含 v8→v9 迁移） | 必须 `confirmed: true`（**单独**） |
 * | `linkCanonical` | 不可变复核行 | 默认预演；`commit: true` 才写（**再次单独**） |
 */

import { existsSync, statSync } from "node:fs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { IntakeCapability } from "@/content/course-pipeline/segment-server";
import { inspectSourceTree, runInspection } from "@/content/course-pipeline/inspection";
import { pickFolder } from "@/content/course-pipeline/folder-picker";
import {
  describeBinding,
  loadAdjudicationDraft,
  loadAdjudicationPlan,
  prepareReviewForSave,
  saveAdjudicationPlan,
  saveAdjudicationReview,
  validateAdjudicationDraft,
  type AdjudicationDraftPayload,
} from "@/content/course-pipeline/adjudication";
import { sanitizeForDisplay } from "@/content/course-pipeline/containment";
import { candidateDirNameOf, isValidCourseId } from "@/content/course-pipeline";
import {
  generateCandidate,
  normalizeCandidateRequest,
  previewCandidateGeneration,
} from "@/content/course-pipeline/candidate-generation";
import {
  buildLinkPlan,
  evaluatePromotionGate,
  gatherPromotionInputs,
  promoteCourseCandidate,
  readStoredCandidate,
  validateCourseReviewFile,
} from "@/content/course-pipeline/review";
import { buildIndexFromDisk } from "@/content/course-pipeline/canonical";
import { getCoursesDir, getCourseSourcesDir } from "@/content/paper/paths";
import { getDbFile } from "@/db/client";
import { getReadOnlyRepositories } from "@/repositories/sqlite";
import {
  backupDirNameOf,
  emptyProgress,
  isA3Complete,
  nextA3Step,
  previewA3,
  runGuardedImport,
  runGuardedLink,
  type A3Progress,
} from "@/services/course-a3";
import type { PromotionGate } from "@/content/course-pipeline/types";
import type { CourseReviewFile } from "@/content/course-pipeline/types";

function labelOf(absolutePath: string): string {
  const parts = absolutePath.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? "source";
}

/** **相对标签**：绝不把绝对路径回给浏览器。 */
export function relativeLabelOf(absolutePath: string): string {
  return sanitizeForDisplay(absolutePath.split(/[\\/]/).slice(-3).join("/"), 80);
}

/**
 * 三项进度**从外部事实重新推导**（不落盘、不依赖上一次会话的内存）。
 *
 * ── 为什么不写一份进度文件 ──
 *
 * 因为"哪几步成功了"的权威来源是外部事实：
 * `courses/<id>/course.json` 是否存在、数据库里有没有那一行、
 * 有没有已核验的链接行。写一个自己的账本就会与那些事实分叉
 * （人手工删了包，而账本仍说"已晋升"）。
 *
 * 这个选择让"中断后重新打开工作台"天然正确：恢复依据是磁盘与数据库。
 */
export function deriveProgress(courseId: string): A3Progress {
  const progress = emptyProgress(courseId);

  const promotedDir = resolve(getCoursesDir(), courseId);
  if (existsSync(promotedDir) && existsSync(resolve(promotedDir, "course.json"))) {
    progress.promoted = { done: true, at: null, detail: `courses/${courseId}/course.json 已存在` };
  }

  try {
    // 只读连接：不迁移、不建表、不写版本号。
    const repos = getReadOnlyRepositories();
    if (repos.courses.isActivated()) {
      const record = repos.courses.getPackage(courseId);
      if (record) {
        progress.imported = {
          done: true,
          at: record.importedAt ?? null,
          detail: `索引中已有 v${record.contentVersion}（${record.segmentCount} 个段）`,
        };
      }
      const links = repos.courses.listLinksForCourse(courseId);
      const verified = links.filter((link) => link.verificationStatus === "verified");
      if (verified.length > 0) {
        progress.linked = {
          done: true,
          at: verified[0]?.createdAt ?? null,
          detail: `已有 ${verified.length} 条已核验链接（不可变行）`,
          segmentIds: [...new Set(verified.map((link) => link.segmentId))].sort(),
        };
      }
    }
  } catch {
    // 读不到库 ⇒ 保持"未完成"（不假装完成，也不假装失败）
  }

  return progress;
}

/** 从候选目录读复核记录（缺失/损坏都如实报告，不兜底）。 */
function readReviewFor(courseId: string): { review: CourseReviewFile | null; errors: string[] } {
  const stored = readStoredCandidate(courseId);
  const reviewPath = resolve(stored.candidateDir, "review.json");
  if (!existsSync(reviewPath)) {
    return { review: null, errors: ["没有复核记录（缺少 review.json）。工具从不生成它 —— 复核只能由人签出。"] };
  }
  try {
    const parsed = validateCourseReviewFile(JSON.parse(readFileSync(reviewPath, "utf8")));
    return { review: parsed.file, errors: parsed.errors };
  } catch (error) {
    return {
      review: null,
      errors: [`review.json 不是合法 JSON（解析失败）：${(error as Error).message}`],
    };
  }
}

/** 现场求值门禁（不信任界面送来的任何东西）。 */
function evaluateGateFor(courseId: string, sourceRootOverride: string | null): PromotionGate {
  const stored = readStoredCandidate(courseId);
  const { review, errors } = readReviewFor(courseId);
  const built = buildIndexFromDisk();
  return evaluatePromotionGate(
    gatherPromotionInputs({
      stored,
      review,
      reviewErrors: errors,
      canonical: { digest: built.index.summary.digest, complete: built.failures.length === 0 },
      standardSourcesRoot: getCourseSourcesDir(),
      sourceRootOverride,
    }),
  );
}

/**
 * 构造 A3 能力对象。
 *
 * `initialSource` / `initialCourseId` 由启动器预置（E2E 用它避免弹原生窗口；
 * 生产用它支持 `--source` / `--course-id`）。
 */
export function createA3Capability(
  initialSource: string | null,
  initialCourseId: string | null,
): IntakeCapability {
  let sourceRoot: string | null = initialSource;
  let courseId: string | null = initialCourseId;

  const resolveSource = (): string => {
    if (sourceRoot === null) throw new Error("还没有选择课程目录");
    return sourceRoot;
  };

  const requireSource = (): string => {
    const root = resolveSource();
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      throw new Error("已选课程目录不存在或不是目录 —— 请重新选择。");
    }
    return root;
  };

  /** 课程标识必须由服务端强制（界面可以被绕过）。 */
  const requireCourseId = (payload: unknown): string => {
    const raw = payload as { courseId?: unknown } | null;
    const submitted =
      raw && typeof raw.courseId === "string" && raw.courseId.trim() !== "" ? raw.courseId.trim() : null;
    const id = submitted ?? courseId;
    if (id === null || id === "") {
      throw new Error("缺少课程标识 —— 请先填写课程基本信息。");
    }
    if (!isValidCourseId(id)) {
      throw new Error(
        `课程标识不合法：${sanitizeForDisplay(id, 60)}。` +
          "只允许小写字母、数字、点、下划线与连字符，且不能以符号开头。",
      );
    }
    return candidateDirNameOf(id);
  };

  return {
    async pickFolder() {
      return pickFolder({ startDirectory: sourceRoot });
    },
    rememberSource(sourcePath: string) {
      sourceRoot = resolve(sourcePath);
    },
    sourceLabel() {
      return sourceRoot === null ? null : labelOf(sourceRoot);
    },
    hasSource() {
      return sourceRoot !== null && existsSync(sourceRoot) && statSync(sourceRoot).isDirectory();
    },
    async browse() {
      return inspectSourceTree(resolveSource());
    },
    async inspect(selection) {
      return runInspection({ sourceRoot: resolveSource(), courseId: "a3-adjudication", selection });
    },
    forgetSource() {
      sourceRoot = null;
    },

    // ── A2 人工裁决与保存能力 ──

    async loadDraft(id: string) {
      return {
        review: loadAdjudicationDraft({ courseId: id }),
        plan: loadAdjudicationPlan({ courseId: id }),
      };
    },

    async describeBinding(id: string) {
      return describeBinding({ courseId: id });
    },

    async validateDraft(payload: unknown) {
      const draft = payload as AdjudicationDraftPayload;
      const validation = validateAdjudicationDraft(draft);
      const prepared = prepareReviewForSave({ draft, sourceDir: sourceRoot });
      const binding = describeBinding({ courseId: draft.courseId });
      return {
        ok: validation.ok && prepared.ok,
        validation: { ok: validation.ok && prepared.ok, errors: [...validation.errors, ...prepared.errors] },
        candidateExists: binding.candidateExists,
        bindingReason: binding.reason,
        rebound: binding.rebound,
      };
    },

    async saveDraft(payload: unknown) {
      const draft = payload as AdjudicationDraftPayload;
      const res = saveAdjudicationReview({ draft, sourceDir: sourceRoot });
      if (!res.ok) {
        return { ok: false, errors: res.errors ?? ["保存未通过"], candidateMissing: res.candidateMissing === true };
      }
      return {
        ok: true,
        fileLabel: relativeLabelOf(res.filePath),
        candidateChecksum: res.rebound?.candidateChecksum ?? null,
        canonicalLibraryDigest: res.rebound?.canonicalLibraryDigest ?? null,
        hasBackup: res.backupPath !== null,
        message: "已原子安全写入本机私有目录（旧版已自动备份）。",
      };
    },

    async savePlanDraft(payload: unknown) {
      const plan = payload as Record<string, unknown>;
      const res = saveAdjudicationPlan({
        courseId: String(plan.courseId ?? ""),
        plan,
        sourceDir: sourceRoot,
      });
      if (!res.ok) return { ok: false, errors: res.errors };
      return {
        ok: true,
        fileLabel: relativeLabelOf(res.filePath),
        planDigest: res.planDigest,
        hasBackup: res.backupPath !== null,
        message:
          "分段计划已保存。候选结构来自这份计划 —— 请重新生成候选，" +
          "已签署的 review 会因候选校验和变化而自动失效。",
      };
    },

    // ── A1 → A2 断点：生成课程候选 ──

    async previewCandidate(payload: unknown) {
      const request = normalizeCandidateRequest(payload, courseId);
      const preview = await previewCandidateGeneration(request, requireSource());
      return { ok: true, preview };
    },

    async generateCandidate(payload: unknown) {
      const raw = payload as { confirmed?: unknown } | null;
      // 明确授权是**必需**的：生成会替换已有候选并让已签署的审核立即失效。
      if (raw?.confirmed !== true) {
        return {
          ok: false,
          errors: ["缺少明确授权：生成候选需要显式确认（这会替换已有候选并使旧审核失效）。"],
        };
      }
      const request = normalizeCandidateRequest(payload, courseId);
      const summary = await generateCandidate(request, requireSource());
      courseId = request.courseId;
      return { ok: true, ...summary };
    },

    // ── A3 受控接入能力 ──

    async previewPromotion(id: string) {
      const safeId = candidateDirNameOf(id);
      return previewA3({
        courseId: safeId,
        standardSourcesRoot: getCourseSourcesDir(),
        sourceRootOverride: sourceRoot,
      });
    },

    async readProgress(id: string) {
      const safeId = candidateDirNameOf(id);
      const progress = deriveProgress(safeId);
      const next = nextA3Step(progress);
      /*
       * ── 返回的形状刻意**不**再包一层 `progress` ──
       *
       * 端点本身已经把它放在 `{ ok: true, progress: ... }` 里。
       * 若这里再返回 `{ progress: {...} }`，客户端拿到的就是
       * `res.body.progress.progress` —— 而**读错一层不会报错**：
       * `progress.promoted` 只是 undefined，界面于是把"已完成"显示成
       * "尚未执行"。实测正是这个形态。
       *
       * 因此这里直接返回三项进度本身，加上它派生出的结论。
       */
      return {
        ...progress,
        complete: isA3Complete(progress),
        nextStep: next.step,
        nextLabel: next.label,
        companionPath: "/practice/courses",
        coursePath: `/practice/courses/${encodeURIComponent(safeId)}`,
      };
    },

    /**
     * A3-a 晋升（写 `courses/`）—— **第一个不可逆动作**。
     *
     * 门禁结论由服务端现场重算：绝不使用界面送来的 status。
     */
    async promoteCandidate(payload: unknown) {
      const raw = payload as { courseId?: unknown; confirmed?: unknown };
      if (raw.confirmed !== true) {
        return { ok: false, error: "缺少明确授权：晋升需要显式确认。" };
      }
      const id = requireCourseId(payload);

      const stored = readStoredCandidate(id);
      const { review, errors } = readReviewFor(id);
      const gate = evaluateGateFor(id, sourceRoot);

      const result = promoteCourseCandidate({ stored, gate, review });
      if (!result.ok) return { ok: false, error: result.error, status: gate.status };

      return {
        ok: true,
        copied: result.copied,
        excluded: result.excluded,
        contentFingerprint: result.contentFingerprint,
        message:
          `已晋升到 courses/${id}/（只复制 ${result.copied.join("、")}）。` +
          "晋升不创建任何链接、不写数据库、不改 planner / 模考保留。",
        progress: deriveProgress(id),
        /** 复核记录的形状错误也要如实回传（非空说明它其实不该晋升成功）。 */
        reviewErrors: errors,
      };
    },

    /**
     * A3-b 导入索引（写数据库，首次触发 v8 → v9）。
     *
     * 备份失败 ⇒ 不迁移、不写入。
     */
    async importIndex(payload: unknown) {
      const raw = payload as { courseId?: unknown; confirmed?: unknown; only?: unknown };
      if (raw.confirmed !== true) {
        return { ok: false, error: "缺少明确授权：导入索引需要显式确认（首次会执行 v8 → v9 迁移）。" };
      }
      const id = requireCourseId(payload);

      // 备份目录放在 `courses/` 的**兄弟位置**，因此不会被内容备份自身包含。
      const backupRoot = resolve(getCoursesDir(), "..", "a3-backups", backupDirNameOf());
      const only = Array.isArray(raw.only)
        ? raw.only.filter((item): item is string => typeof item === "string")
        : [id];

      const result = runGuardedImport({
        /*
         * 用 `getDbFile()` 而**不是**模块级常量：导入会真的打开/迁移那个库，
         * 因此"哪一个库"必须由**当时**的环境决定。用常量会让
         * "先 import、后设 CET6_DB_PATH"的调用方静默写到默认库上
         * （本轮实测踩到的隔离缺陷）。
         */
        dbFile: getDbFile(),
        coursesDir: getCoursesDir(),
        backupDir: backupRoot,
        only,
      });

      if (!result.ok) {
        return {
          ok: false,
          error: result.error,
          backup: result.backup ? { label: relativeLabelOf(result.backup.path ?? "") } : null,
        };
      }

      return {
        ok: true,
        written: result.written,
        backup: result.backup
          ? {
              label: relativeLabelOf(result.backup.path ?? ""),
              bytes: result.backup.bytes,
              verified: result.backup.verified,
            }
          : null,
        message:
          `已写入课程索引（${result.written} 份）。` +
          (result.backup?.verified ? "写入前已取得一份**经验证可恢复**的数据库快照。" : ""),
        progress: deriveProgress(id),
      };
    },

    /**
     * A3-c 建立真题链接。
     *
     * **默认预演**（`commit !== true`）。写入需要 `commit === true`，
     * 那是界面上"确认写入"按钮发出的**第二次**单独授权。
     */
    async linkCanonical(payload: unknown) {
      const raw = payload as { courseId?: unknown; commit?: unknown };
      const id = requireCourseId(payload);
      const commit = raw.commit === true;

      // 预演与写入都必须先算出门禁与交接计划 —— **同一段判据**
      const preview = previewA3({
        courseId: id,
        standardSourcesRoot: getCourseSourcesDir(),
        sourceRootOverride: sourceRoot,
      });

      /*
       * ── 建链的判据是 `gatePassed`，**不是** `promotable` ──
       *
       * 两者在真实路径上会分叉：晋升成功之后目标就在盘上了（`promotable`
       * 变 false），但 A3-c 本来就发生在 A3-a **之后**。
       * 用 `promotable` 会让"做完第 ① 步之后第 ③ 步反而不能做了"。
       *
       * 建链真正需要的是"这份复核是可信的" —— 那正是 `gatePassed`。
       */
      if (!preview.gatePassed) {
        return {
          ok: false,
          allowed: false,
          error:
            "门禁不是「可以晋升」，因此**不得**产出建链依据 —— " +
            "失效 / 陈旧 / 不可信的复核不得变成运行时真相。",
          reason: preview.summary,
        };
      }
      if (!preview.linkPlan.allowed) {
        return { ok: false, allowed: false, error: preview.linkPlan.reason ?? "链接交接计划被抑制。" };
      }
      if (preview.linkPlan.entries.length === 0) {
        return {
          ok: true,
          allowed: true,
          committed: false,
          results: [],
          message:
            "没有任何「接受建议」的匹配裁决 —— 因此没有待建链接。" +
            "课程包可以完全未匹配地存在，那是合法状态。",
          progress: deriveProgress(id),
        };
      }

      const link = await buildLinkInputs(id);
      if (link.error !== null) return { ok: false, allowed: true, error: link.error };

      const result = runGuardedLink({ repos: link.repos, links: link.inputs, commit });
      if (!result.ok) {
        return {
          ok: false,
          allowed: true,
          committed: commit,
          results: result.results,
          error:
            (result.error ?? "有链接未通过核验。") +
            " 逐条原因：" +
            result.results
              .flatMap((entry) => entry.issues.map((issue) => `${issue.path}：${issue.message}`))
              .join("；"),
        };
      }

      const written = result.results.filter((entry) => entry.ok && !entry.alreadyExists).length;
      const idempotent = result.results.filter((entry) => entry.alreadyExists).length;

      return {
        ok: true,
        allowed: true,
        committed: result.committed,
        results: result.results,
        message: commit
          ? `已写入 ${written} 条不可变复核记录（幂等命中 ${idempotent} 条）。` +
            "提醒：这些行**不能改也不能删**，修正只能追加新行。"
          : `建链预演通过：${result.results.length} 条链接校验通过，**未写入任何数据**。`,
        progress: commit ? deriveProgress(id) : undefined,
      };
    },
  };
}

/**
 * 从**已复核的交接计划**构造 `verifyCanonicalLink` 的输入。
 *
 * ── 为什么必须重读 review.json 与当前索引 ──
 *
 * 链接声明的每一个字段（课程版本、真题版本、段 id、目标）都必须是
 * **当前**事实：拿界面送来的值就等于让浏览器决定"绑定到哪一版内容"。
 */
type LinkInputsResult =
  | { error: string; repos: null; inputs: [] }
  | {
      error: null;
      repos: import("@/repositories/ports").Repositories;
      inputs: import("@/services/course-link").VerifyCanonicalLinkInput[];
    };

async function buildLinkInputs(courseId: string): Promise<LinkInputsResult> {
  const { getRepositories } = await import("@/repositories/sqlite");

  const repos = getRepositories();
  const record = repos.courses.getPackage(courseId);
  if (!record) {
    return {
      error: `课程包 ${courseId} 不在索引中 —— 请先完成第 ② 步（导入索引）。`,
      repos: null,
      inputs: [],
    };
  }

  const stored = readStoredCandidate(courseId);
  const { review } = readReviewFor(courseId);
  if (review === null) return { error: "复核记录缺失或无效，无法产出建链依据。", repos: null, inputs: [] };

  const inputs: import("@/services/course-link").VerifyCanonicalLinkInput[] = [];
  for (const entry of review.matches) {
    if (entry.disposition !== "accepted_suggestion") continue;
    if (entry.paperId === null || entry.sectionId === null || entry.targetScope === null) continue;

    const paper = repos.papers.getPaper(entry.paperId);
    if (!paper) {
      return { error: `目标真题卷 ${entry.paperId} 不在索引中 —— 先导入真题包。`, repos: null, inputs: [] };
    }

    inputs.push({
      courseId,
      courseContentVersion: record.contentVersion,
      segmentId: entry.segmentId,
      paperId: entry.paperId,
      paperContentVersion: paper.contentVersion,
      sectionId: entry.sectionId,
      groupId: entry.groupId,
      questionId: entry.questionId,
      targetScope: entry.targetScope,
      verificationStatus: "verified",
      verificationRef: buildRef(courseId, stored.recomputed.candidateChecksum, entry.segmentId, review.reviewedAt),
    });
  }
  return { error: null, repos, inputs };
}

/**
 * 受控字符集的复核引用（与 `review.ts` 的 `buildSafeReviewRef` 同形）。
 *
 * 这里刻意重写而不是 import：`review.ts` 的那个是**候选→命令**用的，
 * 而这里是**候选→数据库行**。两者的目的不同，但字符集约束相同 ——
 * 而字符白名单只有一份（下面的正则），不是两套判据。
 */
function buildRef(courseId: string, checksum: string, segmentId: string, reviewedAt: string): string {
  const clean = (value: string) =>
    value.replace(/[^a-z0-9._:-]/gi, "-").replace(/-{2,}/g, "-").slice(0, 120) || "unnamed";
  return ["course-review", clean(courseId), clean(checksum.slice(0, 16)), clean(segmentId), clean(reviewedAt)].join(
    ":",
  );
}

/** 供 E2E 与证明脚本复用：门禁预演（只读）。 */
export function previewGateOf(courseId: string, sourceRootOverride: string | null): ReturnType<typeof previewA3> {
  return previewA3({
    courseId: candidateDirNameOf(courseId),
    standardSourcesRoot: getCourseSourcesDir(),
    sourceRootOverride,
  });
}

/** 供 E2E 与证明脚本复用：交接计划（只读，绝不执行）。 */
export function linkPlanOf(courseId: string, sourceRootOverride: string | null) {
  const safeId = candidateDirNameOf(courseId);
  const stored = readStoredCandidate(safeId);
  const { review } = readReviewFor(safeId);
  return buildLinkPlan({ stored, review, gate: evaluateGateFor(safeId, sourceRootOverride) });
}
