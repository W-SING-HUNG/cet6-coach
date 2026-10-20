#!/usr/bin/env node
/**
 * `pnpm course:segment-plan-proof` —— 人工分段计划的**真实 CLI 端到端证明**。
 *
 * ── 它证明什么 ──
 *
 * 走**真实 CLI**（`course:extract` + `course:review`），在隔离内容根上跑：
 *
 * 1. 无计划 ⇒ 自动分段（**默认真实未变**，一个文档级段）；
 * 2. 写入计划 ⇒ 重新抽取 ⇒ **按人的结构产段**，候选校验和改变；
 * 3. 计划陈旧（改源字节）⇒ **失败关闭**，回退自动分段 + 阻断事项，
 *    门禁不 PROMOTABLE，零交接；
 * 4. 未指派内容 ⇒ 候选带阻断事项，门禁不 PROMOTABLE；
 * 5. 计划**不被复制进 courses/**（晋升白名单）；
 * 6. 全程**不打开数据库**。
 *
 * 全部内容为合成夹具；`CET6_CONTENT_ROOT` 指向临时目录 ⇒
 * 绝不触碰 使用者 真实 `private-content/` 或 `data/cet6.db`。
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanSourceDirectory } from "@/content/course-pipeline/sources";
import { extractPdfPages } from "@/content/course-pipeline/pdf-extract";
import { parseSegmentationPlan } from "@/content/course-pipeline/segmentation-plan";
import { writeSourceTree } from "./course-source-fixture";
import { twoUnitTranslationFixture } from "./course-source-scenarios";

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  ✗ ${label}${detail === "" ? "" : ` —— ${detail}`}`);
  }
}

/** 跑真实 CLI，返回 { code, out }。 */
function runCli(args: string[], contentRoot: string): { code: number; out: string } {
  const result = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", ...args],
    {
      encoding: "utf8",
      cwd: process.cwd(),
      env: { ...process.env, CET6_CONTENT_ROOT: contentRoot },
    },
  );
  return { code: result.status ?? -1, out: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "cet6-plan-proof-"));
  const contentRoot = join(root, "content");
  const sourceRoot = join(contentRoot, "course-sources", "plan-proof-src");
  const plansDir = join(contentRoot, "course-segmentation-plans");
  const candidateDir = join(contentRoot, "course-candidates", "plan-proof");
  const coursesDir = join(contentRoot, "courses");
  mkdirSync(sourceRoot, { recursive: true });
  mkdirSync(plansDir, { recursive: true });
  writeSourceTree(sourceRoot, twoUnitTranslationFixture());

  const courseId = "plan-proof";
  console.log("人工分段计划 · 真实 CLI 端到端证明（**合成夹具**）\n");

  // ── 坐标探测（计划的选辑器需要真实页/行号）──
  const inventory = scanSourceDirectory(sourceRoot);
  const asset = inventory.assets.find((a) => a.kind === "pdf")!;
  const document = await extractPdfPages(asset.assetKey, join(sourceRoot, ...asset.relativePath.split("/")));
  const lineCountByPage = new Map<number, number>();
  for (const page of document.pages) if (page.hasTextLayer) lineCountByPage.set(page.page, page.lines.length);
  const last = (page: number): number => lineCountByPage.get(page) ?? 1;

  // ── 1) 无计划：自动分段（默认路径未变）──
  console.log("一、无计划（默认路径）");
  const auto = runCli(
    ["scripts/course-extract.ts", "--source", sourceRoot, "--id", courseId, "--papers-dir", join(contentRoot, "cet6", "papers")],
    contentRoot,
  );
  check("course:extract 退出 0", auto.code === 0, auto.out.slice(-300));
  const autoCandidate = JSON.parse(readFileSync(join(candidateDir, "candidate.json"), "utf8")) as {
    segmentation: { modeEvidence: { mode: string; planDigest: string | null }; materials: unknown[] };
    digests: { candidateChecksum: string };
  };
  check("分段模式如实写 automatic", autoCandidate.segmentation.modeEvidence.mode === "automatic");
  check("自动模式的无计划校验和为 null", autoCandidate.segmentation.modeEvidence.planDigest === null);
  const autoChecksum = autoCandidate.digests.candidateChecksum;
  check("CLI 输出说明走自动分段", auto.out.includes("自动"));

  // ── 2) 写入计划：手动构造（模拟标注工具保存的产物）──
  console.log("\n二、有计划（人工结构）");
  const furniture = [1, 2, 3, 4].map((page) => ({
    channel: "ignored_furniture",
    range: { assetKey: asset.assetKey, page, lineStart: 1, lineEnd: 1 },
    note: "重复页眉",
  }));
  const plan = {
    schemaVersion: 1,
    binding: {
      courseId,
      sourceDigest: inventory.digest,
      assets: [{ assetKey: asset.assetKey, sha256: asset.sha256 }],
    },
    author: "proof",
    createdAt: new Date().toISOString(),
    reason: "源件没有可靠的结构边界；自动分段只产出一个文档级段。",
    units: [
      {
        title: "翻译练习 1",
        kind: "translation_passage",
        assignments: [
          { channel: "source", range: { assetKey: asset.assetKey, page: 1, lineStart: 2, lineEnd: last(1) }, note: null },
          { channel: "reference_translation", range: { assetKey: asset.assetKey, page: 2, lineStart: 2, lineEnd: last(2) }, note: null },
          ...furniture,
        ],
      },
      {
        title: "翻译练习 2",
        kind: "translation_passage",
        assignments: [
          { channel: "source", range: { assetKey: asset.assetKey, page: 3, lineStart: 2, lineEnd: last(3) }, note: null },
          { channel: "reference_translation", range: { assetKey: asset.assetKey, page: 4, lineStart: 2, lineEnd: last(4) }, note: null },
        ],
      },
    ],
  };
  writeFileSync(join(plansDir, `${courseId}.json`), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  const planned = runCli(
    ["scripts/course-extract.ts", "--source", sourceRoot, "--id", courseId, "--papers-dir", join(contentRoot, "cet6", "papers")],
    contentRoot,
  );
  check("带计划重跑 course:extract 退出 0", planned.code === 0, planned.out.slice(-300));
  check("CLI 说明采用了人工计划", planned.out.includes("人工分段计划"));
  check("CLI 说明覆盖率完整", planned.out.includes("覆盖率完整"));

  const plannedCandidate = JSON.parse(readFileSync(join(candidateDir, "candidate.json"), "utf8")) as {
    segmentation: { modeEvidence: { mode: string; planDigest: string | null; unitCount: number; channelLineCounts: Record<string, number> } };
    digests: { candidateChecksum: string };
  };
  check("分段模式为 human_planned", plannedCandidate.segmentation.modeEvidence.mode === "human_planned");
  check("携带计划校验和", /^[0-9a-f]{64}$/.test(plannedCandidate.segmentation.modeEvidence.planDigest ?? ""));
  check("单元数为 2", plannedCandidate.segmentation.modeEvidence.unitCount === 2);
  check("显式家具行数为 4", plannedCandidate.segmentation.modeEvidence.channelLineCounts.ignoredFurniture === 4);
  check(
    "计划改变 ⇒ 候选校验和改变（人的结构输入改变候选身份）",
    plannedCandidate.digests.candidateChecksum !== autoChecksum,
  );

  const manifest = JSON.parse(readFileSync(join(candidateDir, "course.json"), "utf8")) as {
    segments: { id: string; kind: string; title: string; referenceTranslation: string | null }[];
  };
  const translationSegments = manifest.segments.filter((s) => s.kind === "translation_passage");
  check("产出 2 个 translation_passage 段", translationSegments.length === 2, `实际 ${translationSegments.length}`);
  check("段标题来自计划", translationSegments.map((s) => s.title).join("|") === "翻译练习 1|翻译练习 2");
  check("每段都有参考译文", translationSegments.every((s) => s.referenceTranslation !== null));

  // ── 3) 计划不被复制进 courses/ ──
  console.log("\n三、计划不进运行时课程目录");
  const candidateEntries = readdirSync(candidateDir).sort();
  check("候选目录里没有计划文件", !candidateEntries.some((e) => e.includes("segmentation-plan")), candidateEntries.join("、"));
  // 门禁此时应为 REVIEW_REQUIRED（计划不是复核）
  const review = runCli(["scripts/course-review.ts", courseId], contentRoot);
  check("course:review 退出 0", review.code === 0, review.out.slice(-300));
  check("门禁为 REVIEW_REQUIRED（计划 ≠ 复核）", review.out.includes("REVIEW_REQUIRED"));
  check("零晋升（未指定 --promote 时不写 courses/）", !existsSync(coursesDir));
  check("交接被抑制（非 PROMOTABLE ⇒ 零建链命令）", review.out.includes("链接交接已抑制"));
  check("输出里没有 course:link 命令", !review.out.includes("pnpm course:link"));

  // ── 4) 计划陈旧：改源字节 ──
  console.log("\n四、计划陈旧（改源字节但不改计划）");
  const pdfPath = join(sourceRoot, ...asset.relativePath.split("/"));
  writeFileSync(pdfPath, Buffer.concat([readFileSync(pdfPath), Buffer.from("\n% mutated\n", "utf8")]));
  const drifted = runCli(
    ["scripts/course-extract.ts", "--source", sourceRoot, "--id", courseId, "--papers-dir", join(contentRoot, "cet6", "papers")],
    contentRoot,
  );
  check("陈旧计划下 course:extract 仍退出 0（候选仍生成，便于人检查）", drifted.code === 0, drifted.out.slice(-400));
  check("CLI 明确报告计划**未被采用**", drifted.out.includes("计划未被采用") || drifted.out.includes("未被采用"));
  check("CLI 说明已回退自动分段", drifted.out.includes("自动"));

  const driftCandidate = JSON.parse(readFileSync(join(candidateDir, "candidate.json"), "utf8")) as {
    segmentation: { modeEvidence: { mode: string } };
    review: { code: string; severity: string }[];
  };
  check("分段模式如实回退为 automatic", driftCandidate.segmentation.modeEvidence.mode === "automatic");
  const mismatch = driftCandidate.review.filter((r) => r.code === "plan_binding_mismatch");
  check("候选带 plan_binding_mismatch 事项", mismatch.length > 0);
  check("该事项为阻断级", mismatch.every((r) => r.severity === "blocking"));

  const driftReview = runCli(["scripts/course-review.ts", courseId], contentRoot);
  check("陈旧时门禁不 PROMOTABLE", !driftReview.out.includes("门禁结论：PROMOTABLE"));
  check("陈旧时零交接", driftReview.out.includes("链接交接已抑制"));

  // ── 5) 未指派内容阻断 ──
  console.log("\n五、未指派内容（计划漏掉行）");
  // 恢复源，写一份**故意漏掉第 3 页原文**的计划
  writeSourceTree(sourceRoot, twoUnitTranslationFixture());
  const inventory2 = scanSourceDirectory(sourceRoot);
  const asset2 = inventory2.assets.find((a) => a.kind === "pdf")!;
  const document2 = await extractPdfPages(asset2.assetKey, join(sourceRoot, ...asset2.relativePath.split("/")));
  const lineCount2 = new Map<number, number>();
  for (const page of document2.pages) if (page.hasTextLayer) lineCount2.set(page.page, page.lines.length);

  const incomplete = {
    ...plan,
    binding: {
      courseId,
      sourceDigest: inventory2.digest,
      assets: [{ assetKey: asset2.assetKey, sha256: asset2.sha256 }],
    },
    units: [
      {
        title: "只覆盖一页的计划",
        kind: "translation_passage",
        assignments: [
          { channel: "source", range: { assetKey: asset2.assetKey, page: 1, lineStart: 2, lineEnd: lineCount2.get(1)! }, note: null },
          { channel: "reference_translation", range: { assetKey: asset2.assetKey, page: 2, lineStart: 2, lineEnd: lineCount2.get(2)! }, note: null },
        ],
      },
    ],
  };
  writeFileSync(join(plansDir, `${courseId}.json`), `${JSON.stringify(incomplete, null, 2)}\n`, "utf8");

  const incompleteRun = runCli(
    ["scripts/course-extract.ts", "--source", sourceRoot, "--id", courseId, "--papers-dir", join(contentRoot, "cet6", "papers")],
    contentRoot,
  );
  check("未指派计划的 course:extract 退出 0", incompleteRun.code === 0, incompleteRun.out.slice(-400));
  check("CLI 报告未指派行数", incompleteRun.out.includes("未指派"));

  const incompleteCandidate = JSON.parse(readFileSync(join(candidateDir, "candidate.json"), "utf8")) as {
    segmentation: { modeEvidence: { mode: string; unassignedLineCount: number; unassignedCoordinates: unknown[] } };
    review: { code: string; severity: string }[];
  };
  check("计划**仍被采用**（人看到的是自己的结构）", incompleteCandidate.segmentation.modeEvidence.mode === "human_planned");
  check("未指派行数 > 0", incompleteCandidate.segmentation.modeEvidence.unassignedLineCount > 0);
  const unassignedItems = incompleteCandidate.review.filter((r) => r.code === "plan_unassigned_content");
  check("候选带 plan_unassigned_content 事项", unassignedItems.length === 1);
  check("该事项为阻断级", unassignedItems[0]?.severity === "blocking");
  check(
    "未指派坐标只有页码/行号（不含正文）",
    JSON.stringify(incompleteCandidate.segmentation.modeEvidence.unassignedCoordinates).length < 4000,
  );

  const incompleteReview = runCli(["scripts/course-review.ts", courseId], contentRoot);
  check("未指派时门禁不 PROMOTABLE", !incompleteReview.out.includes("门禁结论：PROMOTABLE"));
  check("未指派时零交接", incompleteReview.out.includes("链接交接已抑制"));

  // ── 6) 计划文件本身不含正文与绝对路径 ──
  console.log("\n六、计划文件与候选证据的隐私边界");
  const savedPlanRaw = readFileSync(join(plansDir, `${courseId}.json`), "utf8");
  check("计划里没有绝对路径", !/[A-Za-z]:\\\\|\/home\/|\/Users\//.test(savedPlanRaw));
  check("计划里没有课程正文", !savedPlanRaw.includes("城市轨道交通") && !savedPlanRaw.includes("Operators of urban rail"));
  const evidenceRaw = JSON.stringify(incompleteCandidate.segmentation.modeEvidence);
  check("候选证据里没有课程正文", !evidenceRaw.includes("城市轨道交通") && !evidenceRaw.includes("Operators of urban rail"));
  check("候选证据里没有绝对路径", !/[A-Za-z]:\\\\/.test(evidenceRaw));
  // 计划可被解析（契约一致）
  check("落盘计划可被解析", parseSegmentationPlan(savedPlanRaw).ok);

  // ── 7) 三条命令都不打开数据库 ──
  console.log("\n七、不打开数据库（结构性）");
  check("隔离内容根下没有数据库文件", !existsSync(join(contentRoot, "cet6.db")));
  check("本证明全程未创建 courses/（无晋升）", !existsSync(coursesDir));

  rmSync(root, { recursive: true, force: true });

  console.log("");
  console.log(`通过 ${passed} 项，失败 ${failed} 项。`);
  if (failed > 0) {
    console.log(`失败项：${failures.join("；")}`);
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error("证明脚本失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
