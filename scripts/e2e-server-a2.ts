/**
 * A2 E2E 专用测试服务器（监听 3280 端口，独立隔离环境）。
 *
 * ── 它为什么必须与 A1 的 E2E 服务器分开 ──
 *
 * 被验收的对象不同：A2 要证明的是"真实候选 + 真实陈旧防线 + 真实保存"，
 * 因此这里的夹具必须是**真实的合成候选**（走 `runCourseIntake` +
 * `writeCourseCandidate`，校验和由 `digests.ts` 唯一实现算出），
 * 而不是手写的假 candidate.json。
 *
 * ── 三条纪律 ──
 *
 * 1. **不传 `allowStale`**：陈旧一律失败关闭（P1-F2 的修复核心）。
 *    测试要证明的是"过期视图保存被拒"这条路真实存在。
 * 2. **不 mock 保存**：`saveDraft` 直接调生产 `saveAdjudicationReview`。
 * 3. **全部合成**：源目录、真题库、候选都在 `.e2e/a2-intake-run/` 下，
 *    不碰 `private-content/`、不碰 `data/cet6.db`。
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  newSessionToken,
  startAnnotationServer,
  type AnnotationSession,
  type IntakeCapability,
} from "@/content/course-pipeline/segment-server";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { renderAdjudicationShell } from "@/content/course-pipeline/adjudication-page";
import { inspectSourceTree, runInspection } from "@/content/course-pipeline/inspection";
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
import { runCourseIntake } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import { buildTextPdf, buildCjkPdf, writeSourceTree } from "./course-source-fixture";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
} from "./course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";
import { E2E_A2_HANDOFF_PATH, E2E_A2_PORT } from "../e2e/config";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(SCRIPT_DIR, "..");
const RUN_ROOT = join(REPO_ROOT, ".e2e", "a2-intake-run");

export const E2E_A2_COURSE_ID = "a2-e2e-fixture";

function buildSyntheticSource(root: string): string {
  const sourceRoot = join(root, "synthetic-source");
  const tree = new Map<string, Buffer>();
  const words = FIXTURE_PASSAGE_A.split(/\s+/).filter((word) => word !== "");
  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      ["SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL", "Passage One", "Questions 46 to 50 are based on the following passage.", ...words],
      ["Passage One Questions", "46. What did the synthetic researchers assume?", "A) A single synthetic spotlight."],
    ]),
  );
  const cjk = [...FIXTURE_TRANSLATION_SOURCE];
  tree.set(
    "翻译/translation-unit1.pdf",
    buildCjkPdf([
      ["【合成夹具】翻译练习 · 请勿当真", ...cjk.slice(0, 24), ...cjk.slice(24, 48), ...cjk.slice(48, 72)],
      ["参考译文", ...FIXTURE_TRANSLATION_REFERENCE.slice(0, 24)],
    ]),
  );
  writeSourceTree(sourceRoot, tree);
  return sourceRoot;
}

function buildSyntheticPapers(root: string): string {
  const papersRoot = join(root, "synthetic-papers");
  const papersDir = join(papersRoot, "cet6", "papers");
  for (let index = 0; index < 3; index += 1) {
    const id = `fixture-cet6-2024-12-set${index + 1}`;
    writeFixturePackage(
      papersRoot,
      id,
      buildFixturePackage({ id, year: 2024, session: "December", variant: `set${index + 1}` }),
    );
  }
  return papersDir;
}

/** 只作展示的相对标签（绝不回传绝对路径）。 */
function relativeLabelOf(absolutePath: string): string {
  return absolutePath.split(/[\\/]/).slice(-3).join("/");
}

async function main(): Promise<void> {
  rmSync(RUN_ROOT, { recursive: true, force: true });
  mkdirSync(RUN_ROOT, { recursive: true });

  const sourceRoot = buildSyntheticSource(RUN_ROOT);
  const papersDir = buildSyntheticPapers(RUN_ROOT);
  const candidatesDir = join(RUN_ROOT, "course-candidates");
  const plansDir = join(RUN_ROOT, "course-segmentation-plans");

  // ── 真实候选：走既有流水线（校验和由唯一实现算出）──
  const intake = await runCourseIntake({
    sourceRoot,
    courseId: E2E_A2_COURSE_ID,
    provider: "test_fixture_provider",
    edition: null,
    title: "A2 E2E Fixture",
    contentVersion: 1,
    provenance: { note: "synthetic e2e fixture", reference: null, rightsNote: "synthetic" },
    papersDir,
  });
  writeCourseCandidate(intake.archive, join(candidatesDir, E2E_A2_COURSE_ID));

  const realChecksum = intake.archive.metadata.digests.candidateChecksum;
  const realCanonicalDigest = intake.archive.metadata.matching.canonicalLibrary.digest;
  const realSourceDigest = intake.inventory.digest;
  const proposalIds = intake.grouping.proposals.map((proposal) => proposal.id);
  const segmentIds = intake.archive.metadata.segmentation.materials.flatMap((material) =>
    material.segments.map((segment) => segment.id),
  );

  const token = newSessionToken();

  const capability: IntakeCapability = {
    async pickFolder() {
      return {
        outcome: "selected",
        path: sourceRoot,
        detail: "已选择测试源文件夹",
        newFolderButtonHidden: true,
      };
    },
    rememberSource() {},
    sourceLabel() {
      return "synthetic-source";
    },
    hasSource() {
      return true;
    },
    async browse() {
      return inspectSourceTree(sourceRoot);
    },
    async inspect(selection) {
      return runInspection({
        sourceRoot,
        courseId: E2E_A2_COURSE_ID,
        selection,
        papersDir,
      });
    },
    forgetSource() {},

    async loadDraft(courseId: string) {
      return {
        review: loadAdjudicationDraft({ courseId, candidatesDir }),
        plan: loadAdjudicationPlan({ courseId, plansDir }),
      };
    },

    async describeBinding(courseId: string) {
      return describeBinding({ courseId, candidatesDir, papersDir });
    },

    async validateDraft(payload: unknown) {
      const draft = payload as AdjudicationDraftPayload;
      const validation = validateAdjudicationDraft(draft);
      const prepared = prepareReviewForSave({
        draft,
        candidatesDir,
        papersDir,
        sourceDir: sourceRoot,
      });
      const binding = describeBinding({ courseId: draft.courseId, candidatesDir, papersDir });
      return {
        ok: validation.ok && prepared.ok,
        validation: {
          ok: validation.ok && prepared.ok,
          errors: [...validation.errors, ...prepared.errors],
        },
        candidateExists: binding.candidateExists,
        bindingReason: binding.reason,
        rebound: binding.rebound,
      };
    },

    async saveDraft(payload: unknown) {
      const draft = payload as AdjudicationDraftPayload;
      // **不传 allowStale**：陈旧必须失败关闭
      const res = saveAdjudicationReview({
        draft,
        candidatesDir,
        papersDir,
        sourceDir: sourceRoot,
      });
      if (!res.ok) {
        return {
          ok: false,
          errors: res.errors ?? ["保存未通过"],
          candidateMissing: res.candidateMissing === true,
        };
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
        plansDir,
        sourceDir: sourceRoot,
      });
      if (!res.ok) {
        return { ok: false, errors: res.errors };
      }
      return {
        ok: true,
        fileLabel: relativeLabelOf(res.filePath),
        planDigest: res.planDigest,
        hasBackup: res.backupPath !== null,
        message: "分段计划已保存。",
      };
    },
  };

  const session: AnnotationSession = {
    token,
    courseId: E2E_A2_COURSE_ID,
    sourceDigest: realSourceDigest,
    config: { courseId: E2E_A2_COURSE_ID, sourceDigest: realSourceDigest, assets: [], existingPlan: null },
    savePlan() {
      return { ok: false, detail: "A2 模式请走第 ⑤ 步的分段计划保存端点。", planDigest: "" };
    },
    intake: capability,
  };

  const handle = await startAnnotationServer(session, {
    port: E2E_A2_PORT,
    page: () => renderAnnotationShell(),
    intakePage: () => renderAdjudicationShell(),
  });

  mkdirSync(dirname(E2E_A2_HANDOFF_PATH), { recursive: true });
  writeFileSync(
    E2E_A2_HANDOFF_PATH,
    JSON.stringify(
      {
        url: `http://${handle.boundAddress}:${handle.port}/intake#token=${handle.token}`,
        port: handle.port,
        boundAddress: handle.boundAddress,
        sourceLabel: capability.sourceLabel(),
        courseId: E2E_A2_COURSE_ID,
        /** 真实绑定身份（spec 用它构造合法草稿）。 */
        candidateChecksum: realChecksum,
        canonicalLibraryDigest: realCanonicalDigest,
        sourceDigest: realSourceDigest,
        proposalIds,
        segmentIds,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  console.log(`[e2e-server-a2] A2 审核工作台: http://${handle.boundAddress}:${handle.port}/intake`);
  console.log(`[e2e-server-a2] 合成候选: ${E2E_A2_COURSE_ID}（candidateChecksum ${realChecksum.slice(0, 12)}…）`);

  process.on("SIGINT", () => {
    try { rmSync(E2E_A2_HANDOFF_PATH, { force: true }); } catch {}
    try { rmSync(RUN_ROOT, { recursive: true, force: true }); } catch {}
    void handle.close().then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error("[e2e-server-a2] 启动失败：", error);
  process.exit(1);
});
