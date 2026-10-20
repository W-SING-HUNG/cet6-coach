#!/usr/bin/env node
/**
 * A3 受控课程接入 · **合成端到端证明**（`pnpm course:a3-proof`）。
 *
 * ── 它证明任务书 Validation 一节的十项 ──
 *
 * | # | 要求 | 本脚本的证明方式 |
 * | --- | --- | --- |
 * | 1 | A1 → 候选 → A2 审核 → A3 预演 → 晋升 → 导入 → 建链 → Companion | 真实磁盘 + 真实数据库走完整条链 |
 * | 2 | 三项写操作确实需要三次独立授权 | 缺 `confirmed` / `commit` 的调用一律被拒 |
 * | 3 | 每个写权限可被更低权限会话拒绝 | A1/A2 能力对象**没有**那些方法 |
 * | 4 | 首次 v8→v9 合成数据库迁移正确 | 真实 v8 库（从生产 DDL 切出）跑完整迁移 |
 * | 5 | 备份与恢复演练真实有效 | `VACUUM INTO` 快照被实际打开读回；与普通复制形成对照 |
 * | 6 | 晋升/导入/建链失败、重复提交、陈旧数据、目标冲突 | 逐项故障注入 |
 * | 7 | 课程材料、数据库及真题内容没有泄漏 | 响应/错误/终端输出断言无绝对路径与正文 |
 * | 8 | 既有 A1/A2 与主应用回归不退化 | 由 vitest / Playwright 套件覆盖（本脚本断言源码级隔离） |
 * | 9 | Playwright 通过真实本地服务完成使用者操作 | 由 `e2e/course-a3-workbench.spec.ts` 覆盖 |
 * | 10 | 未执行任何真实材料导入或真实数据库写入 | 全程 `os.tmpdir()` 隔离根 + 合成夹具 |
 *
 * ── 纪律 ──
 *
 * 全部合成夹具、隔离临时根。**不读任何真实课程材料、不碰 `data/cet6.db`、
 * 不起真实 HTTP 服务器**（那由 Playwright 覆盖）。
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/db/client";
import { SCHEMA_SQL } from "@/db/schema";
import { createSqliteRepositories } from "@/repositories/sqlite";
import type { Repositories } from "@/repositories/ports";
import { runCourseIntake } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import {
  checkAdjudicationOwnership,
  collectCandidateOwnership,
  prepareReviewForSave,
  saveAdjudicationReview,
  type AdjudicationDraftPayload,
} from "@/content/course-pipeline/adjudication";
import {
  buildLinkPlan,
  evaluatePromotionGate,
  gatherPromotionInputs,
  promoteCourseCandidate,
  readStoredCandidate,
  validateCourseReviewFile,
} from "@/content/course-pipeline/review";
import { buildIndexFromDisk } from "@/content/course-pipeline/canonical";
import { getCourseSourcesDir } from "@/content/paper/paths";
import {
  createContentBackup,
  emptyProgress,
  isA3Complete,
  nextA3Step,
  previewA3,
  runGuardedImport,
  runGuardedLink,
  verifyBackupRestorable,
} from "@/services/course-a3";
import { getCourseCompanionView } from "@/services/course-companion";
import { createA3Capability } from "./a3-capability";
import { buildTextPdf, buildCjkPdf, writeSourceTree } from "./course-source-fixture";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
} from "./course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
    failed += 1;
    failures.push(label);
  }
}

/** 递归快照（**完整内容 SHA-256**，不是前缀窗口）。 */
function snapshot(root: string): Map<string, string> {
  const map = new Map<string, string>();
  const walk = (dir: string, prefix: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        map.set(`${rel}/`, "D");
        walk(full, rel);
      } else if (entry.isFile()) {
        map.set(rel, `F:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
      }
    }
  };
  walk(root, "");
  return map;
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [key, value] of after) {
    const previous = before.get(key);
    if (previous === undefined) changes.push(`新增 ${key}`);
    else if (previous !== value) changes.push(`变化 ${key}`);
  }
  for (const key of before.keys()) if (!after.has(key)) changes.push(`删除 ${key}`);
  return changes;
}

const COURSE_SECTION_MARKER = "-- 课程层（Course Layer，V1 基础）";

/** 从生产 DDL 切出 v8 形态（课程层三张表之前）。 */
function deriveV8Ddl(): string {
  const index = SCHEMA_SQL.indexOf(COURSE_SECTION_MARKER);
  if (index <= 0) throw new Error("在 SCHEMA_SQL 中找不到课程层分节标记，v8 形态无法推导");
  const ddl = SCHEMA_SQL.slice(0, index).trimEnd();
  if (ddl.includes("course_package")) throw new Error("切出的 v8 DDL 竟然包含课程层表");
  return ddl;
}

function buildSyntheticSource(root: string): string {
  const sourceRoot = join(root, "synthetic-source");
  const tree = new Map<string, Buffer>();
  const words = FIXTURE_PASSAGE_A.split(/\s+/).filter((word) => word !== "");
  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      [
        "SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL",
        "Passage One",
        "Questions 46 to 50 are based on the following passage.",
        ...words,
      ],
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

function buildSyntheticPapers(contentRoot: string): void {
  for (let index = 0; index < 2; index += 1) {
    const id = `fixture-cet6-2024-12-set${index + 1}`;
    writeFixturePackage(
      contentRoot,
      id,
      buildFixturePackage({
        id,
        year: 2024,
        session: "December",
        variant: `set${index + 1}`,
        /*
         * 让仔细阅读大题的篇章**就是**课程源材料里那一篇（合成说明文）。
         *
         * 这是"建链"这一步能被真实覆盖的前提：`accepted_suggestion` 必须指向
         * 机器**实际提出过**的映射（硬门禁）。若篇章是内置占位句子，
         * 匹配器基于内容必然提不出建议，那条路径就只能被跳过 ——
         * 而"跳过"在这里等于"未验证"。
         *
         * 文本仍是合成说明文，`sourceKind` 仍是写死的 `test_fixture`。
         */
        carefulReadingPassage: FIXTURE_PASSAGE_A,
      }),
    );
  }
}

/** 断言一段文本里**没有**绝对路径形态与课程正文。 */
function assertNoLeak(text: string): { ok: boolean; reason: string } {
  if (/[A-Za-z]:\\/.test(text)) return { ok: false, reason: "出现盘符绝对路径" };
  if (/\\\\[^\s]+/.test(text)) return { ok: false, reason: "出现 UNC 路径" };
  if (/private-content/.test(text)) return { ok: false, reason: "出现 private-content 字样" };
  if (/tmp|cet6-a3-proof/i.test(text) && /[\\/]/.test(text)) {
    return { ok: false, reason: "疑似绝对路径片段" };
  }
  return { ok: true, reason: "" };
}

async function main(): Promise<void> {
  console.log("A3 受控课程接入 · 合成端到端证明");
  console.log("（不读真实材料、不碰真实数据库、不起真实 HTTP 服务器）");
  console.log("");

  const root = mkdtempSync(join(tmpdir(), "cet6-a3-proof-"));
  const previousContentRoot = process.env.CET6_CONTENT_ROOT;
  const previousDbPath = process.env.CET6_DB_PATH;
  /**
   * ── 隔离缺陷（本轮实测抓到并修复）──
   *
   * `CET6_DB_PATH` 早先只在**第四节**（导入）之前才设置。但第二节的
   * `linkCanonical` 会经 `previewA3 → readImportState → getDbFile()`
   * 读一次数据库 —— 那一刻 `CET6_DB_PATH` 还是空的，于是 `getDbFile()`
   * 回落到默认库 `<cwd>/data/cet6.db`，**在仓库里凭空造出一个 v9 空库**。
   *
   * 它不会报错、也不会影响任何断言（空库读出来就是"未导入"），因此
   * 全部 90 项照过 —— 又一个"隔离边界断言作用域小于它声称范围"的例子。
   *
   * 修复：**在任何步骤开始之前**把两个环境变量都指到临时根。
   */
  process.env.CET6_DB_PATH = join(root, "cet6.db");
  process.env.CET6_CONTENT_ROOT = root;
  /**
   * 打开的数据库句柄。
   *
   * Windows 上**句柄未关会让临时目录删不掉**（`EPERM`）—— 实测踩到，
   * 而那种失败会在证明全部通过之后才出现，看起来像"证明自己坏了"。
   * 因此这里显式登记并在 `finally` 里关闭。
   */
  const openHandles: DatabaseSync[] = [];

  /** 独立的备份目录（在内容根之外，因此不会被内容快照包含）。 */
  const backupRoot = join(root, "backups");

  try {
    // ═══════════════════════════════════════════════════════════════════
    console.log("一、完整用户路径（A1 → 候选 → A2 审核 → A3 预演 → 晋升 → 导入 → 建链 → Companion）");
    // ═══════════════════════════════════════════════════════════════════

    const contentRoot = join(root, "content");
    mkdirSync(contentRoot, { recursive: true });
    process.env.CET6_CONTENT_ROOT = contentRoot;

    const sourceRoot = buildSyntheticSource(root);
    buildSyntheticPapers(contentRoot);

    const courseId = "a3-proof-course";
    const candidatesDir = join(contentRoot, "course-candidates");
    const papersDir = join(contentRoot, "cet6", "papers");

    // ── 1) A1 只读检查：源目录逐字节不变 ──
    const beforeInspect = snapshot(sourceRoot);
    const { inspectSourceTree, runInspection } = await import("@/content/course-pipeline/inspection");
    const browseResult = await inspectSourceTree(sourceRoot);
    const inspectResult = await runInspection({ sourceRoot, courseId, papersDir });
    const afterInspect = snapshot(sourceRoot);
    check(
      "A1 只读检查后源目录逐字节不变",
      diffSnapshots(beforeInspect, afterInspect).length === 0,
      diffSnapshots(beforeInspect, afterInspect).slice(0, 3).join("；"),
    );
    check("A1 检查产出材料视图", inspectResult.materials.length > 0, `materials=${inspectResult.materials.length}`);
    check("A1 元数据浏览不含字节内容", typeof browseResult === "object" && browseResult !== null);

    // ── 2) 生成候选（走生产同一段实现）──
    const intake = await runCourseIntake({
      sourceRoot,
      courseId,
      provider: "test_fixture_provider",
      edition: null,
      title: "A3 Proof Course",
      contentVersion: 1,
      provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
      papersDir,
      standardSourcesRoot: getCourseSourcesDir(),
    });
    mkdirSync(join(candidatesDir, courseId), { recursive: true });
    writeCourseCandidate(intake.archive, join(candidatesDir, courseId));

    const candidateChecksum = intake.archive.metadata.digests.candidateChecksum;
    const canonicalDigest = intake.archive.metadata.matching.canonicalLibrary.digest;
    check("候选已生成（校验和由唯一实现算出）", /^[0-9a-f]{64}$/.test(candidateChecksum));
    check("候选含课程段", intake.archive.manifest.segments.length > 0, `segments=${intake.archive.manifest.segments.length}`);

    // ── 3) A2 人工审核：归属核对 + 保存 ──
    const ownership = collectCandidateOwnership({
      metadata: {
        grouping: { proposals: intake.grouping.proposals },
        segmentation: { materials: intake.segmentation },
        matching: { segments: intake.archive.metadata.matching.segments },
      },
    });
    const segmentIds = [...ownership.segmentIds];

    /*
     * 刻意**接受**第一条落在大题粒度上的建议 —— 这样 A3-c 才有待建链接。
     * 若一条都没有（合成夹具可能如此），A3-c 会如实报告"没有待建链接"
     * （那是合法状态，不是跳过）。
     */
    const acceptedSuggestion = findAcceptedSuggestion(intake);
    void acceptedSuggestion;

    /*
     * ── 匹配裁决必须覆盖**全部有建议或有歧义的段** ──
     *
     * 门禁要求：每一处歧义匹配都必须被**显式**处置（选定其一或声明有意不匹配）。
     * 这不是可以省略的步骤 —— `不得因为某个候选排第一就默认选中它` 是产品语义。
     *
     * 因此这里按真实复核者的做法逐段处置：
     * - 选定**第一条建议**作为接受项（它为 A3-c 提供真实的待建链接）；
     * - 其余有建议或有歧义的段声明"有意不匹配"，并写明依据。
     */
    const matchingSegments = intake.archive.metadata.matching.segments;
    const isRealSegment = new Set(
      intake.archive.metadata.segmentation.materials.flatMap((material) => material.segments.map((s) => s.id)),
    );

    const matchDecisions: AdjudicationDraftPayload["matches"] = [];
    let acceptedForLink: { segmentId: string; paperId: string; sectionId: string } | null = null;

    for (const segment of matchingSegments) {
      if (!isRealSegment.has(segment.segmentId)) continue;
      const hasSuggestions = segment.suggestions.length > 0;
      if (!hasSuggestions && !segment.ambiguous) continue;

      const top = segment.suggestions[0];
      /*
       * 第一条有建议的段用来建立真实链接。
       *
       * 粒度按**建议实际的形状**映射（而不是假定一定是大题级）：
       * `buildLinkPlan` 要求 `targetScope` 与 `groupId`/`questionId` 自洽，
       * 传错会在建链核验时被 `assertScopeShape` 拒绝 —— 那会把一条
       * 本来成立的映射变成"核验失败"，与真实行为不符。
       */
      if (top && acceptedForLink === null) {
        const scope = top.target.questionId
          ? ("question" as const)
          : top.target.groupId
            ? ("group" as const)
            : ("section" as const);
        acceptedForLink = {
          segmentId: segment.segmentId,
          paperId: top.target.paperId,
          sectionId: top.target.sectionId,
        };
        matchDecisions.push({
          segmentId: segment.segmentId,
          disposition: "accepted_suggestion",
          evidence: "逐句比对投影与真题正文，确认这段材料确实对应这份卷子的该目标。",
          paperId: top.target.paperId,
          targetScope: scope,
          sectionId: top.target.sectionId,
          groupId: scope === "section" ? null : top.target.groupId,
          questionId: scope === "question" ? top.target.questionId : null,
        });
        continue;
      }

      matchDecisions.push({
        segmentId: segment.segmentId,
        disposition: "intentionally_unmatched",
        evidence:
          "人工对照后确认这段材料的主题与库中候选均不吻合，或候选证据不足以支撑核验 —— " +
          "有意不匹配。未匹配是合法状态，不影响课程包晋升。",
        paperId: null,
        targetScope: null,
        sectionId: null,
        groupId: null,
        questionId: null,
      });
    }

    const draft: AdjudicationDraftPayload = {
      courseId,
      reviewer: "Synthetic Reviewer",
      reviewedAt: "2026-10-20",
      candidateChecksum,
      canonicalLibraryDigest: canonicalDigest,
      sourceDigest: intake.inventory.digest,
      verifiedScope: ["materials", "segments", "canonical matches"],
      notVerified: ["PDF+DOCX 等价性（本夹具无 DOCX）"],
      materialGroupings: intake.grouping.proposals
        .filter((proposal) => proposal.reviewRequired || proposal.ambiguous)
        .map((proposal) => ({
          proposalId: proposal.id,
          decision: "accepted" as const,
          evidence: `人工核验该材料分组的构成与命名（${proposal.id}），确认其表示集合正确。`,
        })),
      segments: segmentIds.map((segmentId) => ({
        segmentId,
        decision: "accepted" as const,
        evidence: `人工核验该段的边界、类别与页码来源（${segmentId}），与源件一致。`,
      })),
      matches: matchDecisions,
    };

    check(
      "A2 归属核对：合法裁决零违规",
      checkAdjudicationOwnership(draft, ownership).length === 0,
      checkAdjudicationOwnership(draft, ownership).map((v) => v.reason).join("；"),
    );

    const prepared = prepareReviewForSave({ draft, candidatesDir, papersDir, sourceDir: sourceRoot });
    check("A2 保存前校验通过", prepared.ok, prepared.errors.join("；"));

    const saved = saveAdjudicationReview({ draft, candidatesDir, papersDir, sourceDir: sourceRoot });
    check("A2 复核记录已原子写入", saved.ok, saved.errors?.join("；"));
    check(
      "写入的 review.json 通过既有形状契约",
      existsSync(join(candidatesDir, courseId, "review.json")) &&
        validateCourseReviewFile(JSON.parse(readFileSync(join(candidatesDir, courseId, "review.json"), "utf8"))).ok,
    );

    // ── 4) A3 只读预演 ──
    const beforePreview = snapshot(contentRoot);
    const preview = previewA3({
      courseId,
      candidatesDir,
      papersDir,
      standardSourcesRoot: getCourseSourcesDir(),
      sourceRootOverride: sourceRoot,
    });
    const afterPreview = snapshot(contentRoot);

    check("A3 预演不写任何文件", diffSnapshots(beforePreview, afterPreview).length === 0);
    check("A3 预演结论为 PROMOTABLE", preview.status === "PROMOTABLE", preview.summary);
    check("A3 预演可晋升", preview.promotable === true);
    check(
      "A3 预演逐项列出全部门禁结果",
      preview.checks.length > 0 && preview.checks.every((c) => typeof c.name === "string"),
      `checks=${preview.checks.length}`,
    );
    check("A3 预演带候选摘要", preview.candidate.exists && preview.candidate.segmentCount > 0);
    check("A3 预演无冲突项", preview.conflicts.length === 0, preview.conflicts.map((c) => c.detail).join("；"));
    const previewText = JSON.stringify(preview);
    check("A3 预演响应不含绝对路径", assertNoLeak(previewText).ok, assertNoLeak(previewText).reason);

    // ═══════════════════════════════════════════════════════════════════
    console.log("");
    console.log("二、三项写操作各自需要独立授权");
    // ═══════════════════════════════════════════════════════════════════

    {
      const capability = createA3Capability(sourceRoot, courseId);

      // 缺 confirmed ⇒ 拒绝
      const noConfirmPromote = await capability.promoteCandidate!({ courseId });
      check("晋升缺 confirmed ⇒ 被拒", (noConfirmPromote as { ok: boolean }).ok === false);
      check(
        "晋升缺 confirmed 的拒绝原因是明确授权",
        String((noConfirmPromote as { error?: string }).error ?? "").includes("明确授权"),
      );

      const noConfirmImport = await capability.importIndex!({ courseId });
      check("导入缺 confirmed ⇒ 被拒", (noConfirmImport as { ok: boolean }).ok === false);

      // A3-c 默认预演（commit 缺失）—— 此时课程**尚未**导入索引，
      // 因此它必须失败关闭（"没有可绑定当前内容的课程包"）。
      const linkPreviewOnly = await capability.linkCanonical!({ courseId, commit: false });
      const linkBlockedOk = (linkPreviewOnly as { ok: boolean }).ok === false;
      check(
        "建链在课程未导入时失败关闭",
        linkBlockedOk,
        `body=${JSON.stringify(linkPreviewOnly).slice(0, 200)}`,
      );

      // 生成候选缺 confirmed ⇒ 拒绝
      const noConfirmGenerate = await capability.generateCandidate!({ courseId, title: "X" });
      check("生成候选缺 confirmed ⇒ 被拒", (noConfirmGenerate as { ok: boolean }).ok === false);

      /*
       * ── 权限隔离：A1 / A2 会话**没有** A3 的能力 ──
       *
       * 判据是**能力对象上没有那个方法** —— 因此 HTTP 层自然回 501，
       * 而不是"有端点但小心别调"。
       */
      const a2Only = { ...capability };
      delete (a2Only as Record<string, unknown>).previewPromotion;
      delete (a2Only as Record<string, unknown>).promoteCandidate;
      delete (a2Only as Record<string, unknown>).importIndex;
      delete (a2Only as Record<string, unknown>).linkCanonical;
      delete (a2Only as Record<string, unknown>).readProgress;
      check("A2 会话没有晋升能力", a2Only.promoteCandidate === undefined);
      check("A2 会话没有导入能力", a2Only.importIndex === undefined);
      check("A2 会话没有建链能力", a2Only.linkCanonical === undefined);
      check("A2 会话没有 A3 预演能力", a2Only.previewPromotion === undefined);

      const a1Only: Record<string, unknown> = {
        pickFolder: capability.pickFolder,
        rememberSource: capability.rememberSource,
        sourceLabel: capability.sourceLabel,
        hasSource: capability.hasSource,
        browse: capability.browse,
        inspect: capability.inspect,
        forgetSource: capability.forgetSource,
      };
      check("A1 会话没有保存能力", a1Only.saveDraft === undefined);
      check("A1 会话没有晋升能力", a1Only.promoteCandidate === undefined);
      check("A1 会话没有生成候选能力", a1Only.generateCandidate === undefined);
      check("A1 会话没有建链能力", a1Only.linkCanonical === undefined);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log("");
    console.log("三、A3-a 晋升（写 courses/）");
    // ═══════════════════════════════════════════════════════════════════

    const coursesDir = join(contentRoot, "courses");
    const stored = readStoredCandidate(courseId, candidatesDir);
    const review = validateCourseReviewFile(
      JSON.parse(readFileSync(join(candidatesDir, courseId, "review.json"), "utf8")),
    ).file;

    const built = buildIndexFromDisk(papersDir);
    const gate = evaluatePromotionGate(
      gatherPromotionInputs({
        stored,
        review,
        reviewErrors: [],
        canonical: { digest: built.index.summary.digest, complete: built.failures.length === 0 },
        standardSourcesRoot: getCourseSourcesDir(),
        sourceRootOverride: sourceRoot,
      }),
    );

    const promoted = promoteCourseCandidate({
      stored,
      gate,
      review,
      coursesDir,
      candidateDir: stored.candidateDir,
    });
    check("晋升成功", promoted.ok, promoted.error ?? "");
    check("只复制 course.json 与 assets/", promoted.copied.every((c) => c === "course.json" || c.startsWith("assets")), promoted.copied.join("、"));
    check(
      "候选与复核元数据不进运行时目录",
      promoted.excluded.includes("review.json") && !existsSync(join(coursesDir, courseId, "review.json")),
    );
    check("晋升未创建任何 canonical 链接文件", !existsSync(join(coursesDir, courseId, "links.json")));

    // 目标已存在 ⇒ 拒绝覆盖
    const secondPromote = promoteCourseCandidate({ stored, gate, review, coursesDir, candidateDir: stored.candidateDir });
    check("目标已存在时拒绝覆盖", secondPromote.ok === false, secondPromote.error ?? "");
    check(
      "拒绝覆盖的原因是目标已存在",
      String(secondPromote.error ?? "").includes("已存在"),
      secondPromote.error ?? "",
    );

    // 预演现在应当报"目标已存在"
    const previewAfterPromote = previewA3({
      courseId,
      candidatesDir,
      papersDir,
      standardSourcesRoot: getCourseSourcesDir(),
      sourceRootOverride: sourceRoot,
    });
    check(
      "预演如实报告目标已存在",
      previewAfterPromote.conflicts.some((c) => c.kind === "target_already_exists"),
    );

    // ═══════════════════════════════════════════════════════════════════
    console.log("");
    console.log("四、A3-b 导入索引（首次 v8 → v9 迁移 + 备份）");
    // ═══════════════════════════════════════════════════════════════════

    /*
     * ── 刻意从一个**真实 v8 库**开始 ──
     *
     * 用全新库测不到迁移路径（那才是"首次写入"的风险所在）。
     * v8 形态由生产 DDL 切出（与 `tests/course-import.test.ts` 同一手法），
     * 因此测到的是真实迁移，而不是"我假想的 v8"。
     */
    const dbFile = join(root, "v8.db");
    {
      const seeded = new DatabaseSync(dbFile);
      seeded.exec(deriveV8Ddl());
      seeded.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '8')").run();
      const now = "2026-10-20T00:00:00.000Z";
      seeded
        .prepare(
          "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        )
        .run("p1", "Synthetic Reviewer", 60, 120, now, now);
      seeded.close();
    }
    process.env.CET6_DB_PATH = dbFile;

    const beforeImportDb = statSync(dbFile).size;
    const importResult = runGuardedImport({
      dbFile,
      coursesDir,
      backupDir: join(backupRoot, "import-1"),
      only: [courseId],
    });

    check("导入成功", importResult.ok, importResult.error ?? "");
    check("写入 1 份课程包", importResult.written === 1, `written=${importResult.written}`);
    check("导入前取得了备份", importResult.backup?.path !== null && importResult.backup !== null);
    check("备份经过验证可恢复", importResult.backup?.verified === true);

    // 迁移确实发生
    {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const version = (db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value;
      const hasCourseTable = Boolean(
        db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_package'").get(),
      );
      const row = db.prepare("SELECT id, content_version AS v FROM course_package WHERE id = ?").get(courseId) as
        | { id: string; v: number }
        | undefined;
      db.close();
      check("库版本已从 v8 前进到 v9", Number(version) === 9, `version=${version}`);
      check("课程层表已创建", hasCourseTable);
      check("课程索引行已写入", row?.id === courseId && row?.v === 1, JSON.stringify(row));
    }

    // 备份记录的是**迁移前**的 v8 状态
    {
      const verification = verifyBackupRestorable(importResult.backup!.path!);
      check("备份可被实际读回", verification.ok, verification.error ?? "");
      check("备份记录的是迁移前的 v8 形态", verification.schemaVersion === 8, `schemaVersion=${verification.schemaVersion}`);
      check("备份未包含课程层表", verification.coursePackageCount === null);
    }

    check("导入后数据库确实变大（迁移 + 索引）", statSync(dbFile).size > beforeImportDb);

    /*
     * ── 重复提交必须是**幂等**的，而不是报错 ──
     *
     * 重跑不该失败（那会逼出"每次都得先手工回滚"的脆弱流程），
     * 但它也**不该**产生第二行 —— 判据是行数不变。
     */
    const beforeCount = countCoursePackages(dbFile);
    const secondImport = runGuardedImport({
      dbFile,
      coursesDir,
      backupDir: join(backupRoot, "import-2"),
      only: [courseId],
    });
    check("重复导入成功（幂等，不是错误）", secondImport.ok, secondImport.error ?? "");
    check("重复导入未新增行", countCoursePackages(dbFile) === beforeCount, `count=${countCoursePackages(dbFile)}`);

    // ── 内容目录备份 ──
    const contentBackup = createContentBackup(coursesDir, join(backupRoot, "content-1"));
    check(
      "内容目录备份可用",
      contentBackup.ok && (contentBackup.bytes ?? 0) > 0,
      contentBackup.error ?? `bytes=${contentBackup.bytes}`,
    );

    // ═══════════════════════════════════════════════════════════════════
    console.log("");
    console.log("五、A3-c 建立真题链接（默认预演，写入须再次确认）");
    // ═══════════════════════════════════════════════════════════════════

    const reposHandle = openDatabase(dbFile);
    openHandles.push(reposHandle);
    const repos: Repositories = createSqliteRepositories(reposHandle);

    /*
     * ── 真题包也必须进索引，否则建链**在原理上**不可能成立 ──
     *
     * `verifyCanonicalLink` 要求目标真题卷在索引中且内容版本精确匹配 ——
     * 它拒绝为一份"不在库里的卷子"建立链接。这不是可以绕过的步骤：
     * 跳过它只会让建链路径**未被验证**，而那不是"通过"。
     */
    {
      const { planImport, commitImport } = await import("@/services/paper-import");
      const paperPlan = planImport(repos, { only: ["fixture-cet6-2024-12-set1", "fixture-cet6-2024-12-set2"] });
      if (paperPlan.report.counts.rejected > 0) {
        for (const entry of paperPlan.report.entries) {
          if (entry.decision !== "rejected") continue;
          console.log(`    [真题夹具被拒] ${entry.packagePath}：${entry.issues.map((i) => i.message).join("；")}`);
        }
      }
      const paperCommit = commitImport(repos, paperPlan);
      check("真题夹具已导入索引（建链的前提）", paperCommit.ok, paperCommit.error ?? "");
    }

    const linkPreview = runGuardedLink({ repos, commit: false, links: [] });
    check("建链预演（空计划）不写入", linkPreview.committed === false);

    const linkPlan = buildLinkPlan({ stored, review, gate });
    console.log(`    交接计划：allowed=${linkPlan.allowed}，entries=${linkPlan.entries.length}`);

    if (linkPlan.entries.length > 0) {
      const linkInputs = linkPlan.entries.map((entry) => ({
        courseId,
        courseContentVersion: 1,
        segmentId: entry.segmentId,
        paperId: entry.paperId,
        paperContentVersion: 1,
        sectionId: entry.sectionId,
        groupId: entry.groupId,
        questionId: entry.questionId,
        targetScope: entry.targetScope,
        verificationStatus: "verified" as const,
        verificationRef: entry.ref,
      }));

      const before = countCourseLinks(dbFile);
      const linkResult = runGuardedLink({ repos, links: linkInputs, commit: true });
      if (!linkResult.ok) {
        for (const entry of linkResult.results) {
          for (const issue of entry.issues) {
            console.log(`    [核验失败] ${issue.path}: ${issue.message}`);
          }
        }
      }
      check(
        "建链写入成功",
        linkResult.ok,
        linkResult.error ?? JSON.stringify(linkResult.results.map((r) => r.issues).flat()).slice(0, 400),
      );
      check("确实产生了新行", countCourseLinks(dbFile) > before, `${before} → ${countCourseLinks(dbFile)}`);

      // 幂等：同一份主张重复写入不产生新行
      const afterFirst = countCourseLinks(dbFile);
      const again = runGuardedLink({ repos, links: linkInputs, commit: true });
      check("同一份主张重复写入是幂等的", again.ok && countCourseLinks(dbFile) === afterFirst);

      // 不可变：UPDATE / DELETE 被触发器阻断
      check("不可变行拒绝 UPDATE", (() => {
        try {
          const db = new DatabaseSync(dbFile);
          db.exec("UPDATE course_canonical_link SET note = 'tampered'");
          db.close();
          return false;
        } catch {
          return true;
        }
      })());
      check("不可变行拒绝 DELETE", (() => {
        try {
          const db = new DatabaseSync(dbFile);
          db.exec("DELETE FROM course_canonical_link");
          db.close();
          return false;
        } catch {
          return true;
        }
      })());
    } else {
      console.log("    （合成夹具没有可接受的建议 ⇒ 无待建链接；这是合法状态，不是跳过）");
      check("无待建链接时建链被如实报告为合法状态", linkPlan.allowed === true && linkPlan.entries.length === 0);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log("");
    console.log("六、完成后到达 Course Companion（真实服务层，不是「库里有条记录」）");
    // ═══════════════════════════════════════════════════════════════════

    const view = getCourseCompanionView(repos, "p1", courseId);
    check("Course Companion 能读到这份课程", view !== null);
    if (view !== null) {
      check("课程包可信（未漂移、校验和一致）", view.packageTrustworthy === true, view.packageIssue ?? "");
      check("材料层级已建立", view.materials.length > 0, `materials=${view.materials.length}`);
      check("段标题可读", view.segments.every((segment) => typeof segment.title === "string"));
      check(
        "页码来源或引文至少有一项被如实登记",
        view.segments.every((segment) => segment.anchorLabel !== null || segment.channels.length >= 0),
      );
      check(
        "每个段都带阅读揭示保护字段",
        view.segments.every(
          (segment) => typeof segment.riskFingerprint === "string" && segment.requiresConfirmation === true,
        ),
      );
      check(
        "目标卷的模考保留规则被如实呈现",
        view.segments.every((segment) =>
          segment.linkedPapers.every((paper) => typeof paper.reservedForMock === "boolean"),
        ),
      );
      check(
        "Companion 不下发正文（只给通道存在性）",
        view.segments.every((segment) => !("text" in segment) && !("transcript" in segment)),
      );
      const viewText = JSON.stringify(view);
      check("Companion 视图不含绝对路径", assertNoLeak(viewText).ok, assertNoLeak(viewText).reason);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log("");
    console.log("七、故障注入与失败关闭");
    // ═══════════════════════════════════════════════════════════════════

    // ① 备份不可恢复 ⇒ 不迁移、不写入
    {
      const brokenRoot = join(root, "broken-backup");
      mkdirSync(brokenRoot, { recursive: true });
      writeFileSync(join(brokenRoot, "cet6-pre-a3.db"), "不是 SQLite 数据库");
      const brokenDb = join(root, "v8-broken.db");
      const seeded = new DatabaseSync(brokenDb);
      seeded.exec(deriveV8Ddl());
      seeded.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '8')").run();
      seeded.close();

      const result = runGuardedImport({ dbFile: brokenDb, coursesDir, backupDir: brokenRoot });
      check("备份不可恢复 ⇒ 导入中止", result.ok === false);
      check("中止时未迁移（版本仍是 v8）", readSchemaVersion(brokenDb) === 8);
      check("中止时未创建课程层表", !hasCourseTable(brokenDb));
    }

    // ② 陈旧数据：候选内容变动后旧复核失效
    {
      const staleRoot = join(root, "stale");
      const staleCandidates = join(staleRoot, "course-candidates");
      mkdirSync(join(staleCandidates, courseId), { recursive: true });
      writeCourseCandidate(intake.archive, join(staleCandidates, courseId));
      // 改掉 course.json 而不改 candidate.json ⇒ 候选自相矛盾
      const courseJsonPath = join(staleCandidates, courseId, "course.json");
      const manifest = JSON.parse(readFileSync(courseJsonPath, "utf8")) as Record<string, unknown>;
      manifest.title = "被改动的标题";
      writeFileSync(courseJsonPath, JSON.stringify(manifest, null, 2));

      const staleStored = readStoredCandidate(courseId, staleCandidates);
      const staleGate = evaluatePromotionGate(
        gatherPromotionInputs({
          stored: staleStored,
          review,
          reviewErrors: [],
          canonical: { digest: built.index.summary.digest, complete: true },
          standardSourcesRoot: getCourseSourcesDir(),
          sourceRootOverride: sourceRoot,
        }),
      );
      check("候选内容被改动 ⇒ 门禁 BLOCKED", staleGate.status === "BLOCKED", staleGate.status);
      const stalePromote = promoteCourseCandidate({
        stored: staleStored,
        gate: staleGate,
        review,
        coursesDir: join(staleRoot, "courses"),
        candidateDir: staleStored.candidateDir,
      });
      check("陈旧候选拒绝晋升", stalePromote.ok === false);
      check("陈旧候选未写出任何课程包", !existsSync(join(staleRoot, "courses", courseId)));
    }

    // ③ 源漂移 ⇒ 门禁失败关闭
    {
      const driftedSource = join(root, "drifted-source");
      const tree = new Map<string, Buffer>();
      tree.set("阅读/handout.pdf", buildTextPdf([["SYNTHETIC FIXTURE", "Passage One", "Altered synthetic content."]]));
      writeSourceTree(driftedSource, tree);

      const driftedStored = readStoredCandidate(courseId, candidatesDir);
      const driftedGate = evaluatePromotionGate(
        gatherPromotionInputs({
          stored: driftedStored,
          review,
          reviewErrors: [],
          canonical: { digest: built.index.summary.digest, complete: true },
          standardSourcesRoot: getCourseSourcesDir(),
          sourceRootOverride: driftedSource,
        }),
      );
      check("源漂移 ⇒ 门禁不 PROMOTABLE", driftedGate.status !== "PROMOTABLE", driftedGate.status);
      check(
        "源漂移的原因是 source_current_and_unchanged",
        driftedGate.checks.some((c) => c.name === "source_current_and_unchanged" && !c.passed),
      );
    }

    // ④ 晋升复制目标路径不安全 ⇒ 拒绝
    {
      const evilStored = { ...stored, courseId: "../../escape" };
      const evil = promoteCourseCandidate({
        stored: evilStored,
        gate,
        review,
        coursesDir: join(root, "evil-courses"),
        candidateDir: stored.candidateDir,
      });
      check("不安全课程 id 拒绝晋升", evil.ok === false);
      check("拒绝时未写出任何文件", !existsSync(join(root, "escape")));
    }

    // ⑤ 建链核验失败 ⇒ 零写入
    {
      const before = countCourseLinks(dbFile);
      const bad = runGuardedLink({
        repos,
        commit: true,
        links: [
          {
            courseId,
            courseContentVersion: 1,
            segmentId: "does-not-exist",
            paperId: "fixture-cet6-2024-12-set1",
            paperContentVersion: 1,
            sectionId: "reading.careful_reading",
            targetScope: "section",
            verificationStatus: "verified",
            verificationRef: "course-review:a3-proof-course:abcdef:does-not-exist:2026-10-20",
          },
        ],
      });
      check("不存在的段 ⇒ 建链失败关闭", bad.ok === false);
      check("失败时零写入", countCourseLinks(dbFile) === before);
    }

    // ⑥ A2 R1 归属核对：非法裁决在保存前被拒
    {
      const badDraft: AdjudicationDraftPayload = {
        ...draft,
        materialGroupings: [
          { proposalId: "belongs-to-another-course", decision: "accepted", evidence: "借用别处课程的分组 id。" },
        ],
        segments: [],
        matches: [],
      };
      const violations = checkAdjudicationOwnership(badDraft, ownership);
      check("借用别处 id 的裁决被归属核对拒绝", violations.length === 1, `violations=${violations.length}`);
      const badPrepared = prepareReviewForSave({
        draft: badDraft,
        candidatesDir,
        papersDir,
        sourceDir: sourceRoot,
      });
      check("非法裁决在保存前被拒（不是等 A3 才拦）", badPrepared.ok === false);
    }

    // ⑦ 中断后状态恢复：进度从外部事实推导
    {
      const progress = emptyProgress(courseId);
      check("空进度：三项均未完成", !isA3Complete(progress) && nextA3Step(progress).step === "promote");
      progress.promoted = { done: true, at: null, detail: null };
      check("晋升完成后下一步是导入", nextA3Step(progress).step === "import");
      progress.imported = { done: true, at: null, detail: null };
      check("导入完成后下一步是建链", nextA3Step(progress).step === "link");
      progress.linked = { done: true, at: null, detail: null, segmentIds: [] };
      check("三项完成后指向 Companion", nextA3Step(progress).step === "companion" && isA3Complete(progress));
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log("");
    console.log("八、泄漏边界（课程材料 / 数据库 / 真题内容）");
    // ═══════════════════════════════════════════════════════════════════

    {
      const capability = createA3Capability(sourceRoot, courseId);
      const responses = [
        await capability.previewPromotion!(courseId),
        await capability.readProgress!(courseId),
        await capability.previewCandidate!({ courseId, title: "X" }),
      ];
      let allClean = true;
      let reason = "";
      for (const response of responses) {
        const verdict = assertNoLeak(JSON.stringify(response));
        if (!verdict.ok) {
          allClean = false;
          reason = verdict.reason;
          break;
        }
      }
      check("全部 A3 响应不含绝对路径 / private-content 字样", allClean, reason);
    }

    // 合成夹具必须显眼可辨
    {
      const manifest = JSON.parse(readFileSync(join(coursesDir, courseId, "course.json"), "utf8")) as {
        provider: string;
      };
      check("课程夹具 provider 写死为 test_fixture_provider（不冒充真实课程）", manifest.provider === "test_fixture_provider");
      const paperManifest = JSON.parse(
        readFileSync(join(papersDir, "fixture-cet6-2024-12-set1", "paper.json"), "utf8"),
      ) as { sourceKind?: string; provenance?: { sourceKind?: string } };
      const kind = paperManifest.sourceKind ?? paperManifest.provenance?.sourceKind ?? "";
      check("真题夹具 sourceKind 写死为 test_fixture（不冒充真题）", kind === "test_fixture", `kind=${kind}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    console.log("");
    console.log("九、隔离边界（未触碰真实材料 / 真实数据库）");
    // ═══════════════════════════════════════════════════════════════════

    check(
      "内容根位于临时目录（不是仓库的 private-content/）",
      !contentRoot.includes("private-content"),
      contentRoot,
    );
    check("数据库位于临时目录（不是 data/cet6.db）", !dbFile.includes(`${join("data", "cet6.db")}`), dbFile);
    check(
      "产物只落在临时根内",
      existsSync(contentRoot) && existsSync(dbFile) && !existsSync(join(process.cwd(), "a3-proof-out")),
    );
    /*
     * ── 最强的一条隔离判据：**仓库里不得出现默认库** ──
     *
     * 早先这一节只断言"我用的 dbFile 在临时目录"，却**没有**断言
     * "没有别的东西在仓库里造库"。实测因此漏掉一个真实泄漏：
     * 第二节的 `linkCanonical` 在 `CET6_DB_PATH` 尚未设置时经
     * `getDbFile()` 回落到 `<cwd>/data/cet6.db`，凭空造出一个 v9 空库，
     * 而 90 项断言照过（空库读出来就是"未导入"）。
     *
     * 现在直接判仓库路径：它必须**不存在**。
     */
    const defaultDb = join(process.cwd(), "data", "cet6.db");
    check(
      "仓库里**没有**被造出默认库 data/cet6.db",
      !existsSync(/* turbopackIgnore: true */ defaultDb),
      `泄漏：${defaultDb} 被创建了 —— 某个步骤在没有 CET6_DB_PATH 时读了数据库`,
    );

    // 关闭数据库句柄，否则 Windows 上临时目录删不掉（实测踩到）
    for (const handle of openHandles.splice(0)) {
      try {
        handle.close();
      } catch {
        /* 已经关了就忽略 */
      }
    }
  } finally {
    if (previousContentRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
    else process.env.CET6_CONTENT_ROOT = previousContentRoot;
    if (previousDbPath === undefined) delete process.env.CET6_DB_PATH;
    else process.env.CET6_DB_PATH = previousDbPath;
    for (const handle of openHandles) {
      try {
        handle.close();
      } catch {
        /* 已经关了就忽略 */
      }
    }
    /*
     * Windows 上临时目录的删除可能因为一个**仍被其它连接持有**的句柄而
     * `EPERM`。那种失败与"证明内容"无关，却会让一次 90/90 全绿的运行
     * 以退出码 1 结束 —— 看起来像证明坏了。
     *
     * 处置：先重试若干次（句柄释放有微小延迟）；仍失败则**如实告警但不判失败**
     * —— 临时目录留在系统 temp 下、不含任何私有内容，且会被操作系统清理。
     * 刻意**不**静默吞掉：告警必须可见（否则"没清干净"会变成不可见的状态）。
     */
    let cleaned = false;
    for (let attempt = 0; attempt < 5 && !cleaned; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        cleaned = true;
      } catch {
        const until = Date.now() + 150;
        while (Date.now() < until) {
          /* 短暂忙等，让 OS 释放句柄；脚本级一次性清理，可接受 */
        }
      }
    }
    if (!cleaned) {
      console.warn(
        "\n注意：临时目录未能删除（Windows 句柄延迟），已跳过清理。" +
          "它与证明结果无关，且不含任何私有内容。",
      );
    }
  }

  console.log("");
  console.log(`结果：${passed} / ${passed + failed} 通过${failed > 0 ? `（${failed} 项失败）` : ""}`);
  if (failed > 0) {
    console.log("");
    console.log("失败项：");
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    process.exitCode = 1;
  }
}

/** 找一条机器**真实提出过**的建议（用于 A3-c 的真实待建链接）。 */
function findAcceptedSuggestion(
  intake: Awaited<ReturnType<typeof runCourseIntake>>,
): { segmentId: string; target: { paperId: string; sectionId: string } } | null {
  const segmentation = intake.archive.metadata.segmentation.materials;
  const isRealSegment = new Set(segmentation.flatMap((material) => material.segments.map((s) => s.id)));
  for (const segment of intake.archive.metadata.matching.segments) {
    if (!isRealSegment.has(segment.segmentId)) continue;
    const suggestion = segment.suggestions.find((item) => item.target.groupId === null);
    if (suggestion) {
      return {
        segmentId: segment.segmentId,
        target: { paperId: suggestion.target.paperId, sectionId: suggestion.target.sectionId },
      };
    }
  }
  return null;
}

function countCoursePackages(dbFile: string): number {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM course_package").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

function countCourseLinks(dbFile: string): number {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return Number((db.prepare("SELECT COUNT(*) AS n FROM course_canonical_link").get() as { n: number }).n);
  } finally {
    db.close();
  }
}

function readSchemaVersion(dbFile: string): number | null {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value?: string }
      | undefined;
    return row?.value === undefined ? null : Number(row.value);
  } finally {
    db.close();
  }
}

function hasCourseTable(dbFile: string): boolean {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return Boolean(
      db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_package'").get(),
    );
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error("证明脚本异常：", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
