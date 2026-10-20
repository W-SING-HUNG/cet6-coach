#!/usr/bin/env node
/**
 * F12 的**真实 CLI 边界**证明。
 *
 * 它 spawn 真实的 `pnpm course:review`，并检查：
 *   - BLOCKED / 陈旧 / 源漂移 / 库不完整 的复核 ⇒ 输出里**零** `pnpm course:link`
 *   - PROMOTABLE 的复核 ⇒ 恰好输出预期的 dry-run 命令，且**不带** `--commit`
 *
 * 这补上了单元/集成测试的一个盲区：单元测试直接调用 `buildLinkPlan`，
 * 而这里验证的是**命令行的真实输出**。
 *
 * 全程临时内容根 + 合成夹具；绝不触碰 使用者 真实库或真实 private-content。
 *
 * 用法：node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/course-intake-handoff-proof.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "cet6-handoff-proof-"));
const contentRoot = join(work, "content");
const sourceRoot = join(contentRoot, "course-sources", "handoff");
const COURSE_ID = "handoff";
const candidatesDir = join(contentRoot, "course-candidates", COURSE_ID);

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);
  }
}
function section(title: string): void {
  console.log(`\n${title}`);
}

/** 跑真实 CLI 并返回 stdout+stderr。 */
function runReview(extraArgs: string[] = []): string {
  try {
    return execFileSync("pnpm", ["course:review", COURSE_ID, ...extraArgs], {
      cwd: repo,
      env: { ...process.env, CET6_CONTENT_ROOT: contentRoot },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string };
    return `${failure.stdout ?? ""}${failure.stderr ?? ""}`;
  }
}

/** 统计输出里出现过多少条 course:link 命令。 */
function countLinkCommands(out: string): number {
  return (out.match(/pnpm course:link/g) ?? []).length;
}

async function main(): Promise<void> {
  const { writeSourceTree } = await import("./course-source-fixture");
  const { readingFixture } = await import("./course-source-scenarios");
  const { buildFixturePackage, writeFixturePackage } = await import("./paper-fixture");
  const { readStoredCandidate, validateCourseReviewFile } = await import("@/content/course-pipeline/review");
  const { runCourseIntake } = await import("@/content/course-pipeline");
  const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");

  console.log("F12 · 链接交接的**真实 CLI** 边界证明");

  try {
    // ── 准备：源 + canonical 库 + 候选 ──
    mkdirSync(sourceRoot, { recursive: true });
    writeSourceTree(sourceRoot, readingFixture());
    writeFixturePackage(contentRoot, "p", buildFixturePackage({ id: "p", contentVersion: 1 }));

    const result = await runCourseIntake({
      sourceRoot,
      courseId: COURSE_ID,
      provider: "test_fixture_provider",
      edition: null,
      title: "交接证明夹具",
      contentVersion: 1,
      provenance: { note: "合成夹具", reference: null, rightsNote: "合成夹具" },
      papersDir: join(contentRoot, "cet6", "papers"),
      standardSourcesRoot: join(contentRoot, "course-sources"),
    });
    mkdirSync(candidatesDir, { recursive: true });
    writeCourseCandidate(result.archive, candidatesDir);

    const stored = readStoredCandidate(COURSE_ID, join(contentRoot, "course-candidates"));
    const withSuggestion = stored.metadata.matching.segments.find((s) => s.suggestions.length > 0);
    if (!withSuggestion) {
      console.log("  （夹具没有匹配建议，无法验证交接；跳过）");
      return;
    }
    const top = withSuggestion.suggestions[0];

    /** 写一份 review.json（可覆盖单处，用于制造各类失败状态）。 */
    const signReview = (overrides: Record<string, unknown> = {}): string => {
      const md = stored.metadata;
      const scope = top.target.questionId !== null ? "question" : top.target.groupId !== null ? "group" : "section";
      const review = {
        courseId: COURSE_ID,
        reviewer: "handoff-proof",
        reviewedAt: "2026-01-01",
        candidateChecksum: stored.recomputed.candidateChecksum,
        canonicalLibraryDigest: md.matching.canonicalLibrary.digest,
        materialGroupings: md.grouping.proposals
          .filter((p) => p.reviewRequired)
          .map((p) => ({
            proposalId: p.id,
            decision: "accepted",
            note: "证明：确认该分组。",
            evidence: "证明脚本依据候选记录的 basis 与 evidence 作出该裁决（>=10 字符）。",
          })),
        segments: md.segmentation.materials
          .flatMap((m) => m.segments)
          .filter((s) => s.reviewRequired)
          .map((s) => ({
            segmentId: s.id,
            decision: "accepted",
            note: "证明：确认该段。",
            evidence: "证明脚本依据候选记录的 evidence.cues 与 lineSpan 作出该裁决（>=10 字符）。",
          })),
        matches: [
          {
            segmentId: withSuggestion.segmentId,
            disposition: "accepted_suggestion",
            paperId: top.target.paperId,
            targetScope: scope,
            sectionId: top.target.sectionId,
            groupId: scope === "section" ? null : top.target.groupId,
            questionId: scope === "question" ? top.target.questionId : null,
            note: "证明：接受该建议。",
            evidence: "证明脚本依据建议的逐项证据作出该裁决（>=10 字符）。",
          },
        ],
        verifiedScope: ["证明脚本"],
        notVerified: [],
        ...overrides,
      };
      const parsed = validateCourseReviewFile(review);
      if (!parsed.ok) throw new Error(`review 形状非法：${parsed.errors.join("；")}`);
      writeFileSync(join(candidatesDir, "review.json"), JSON.stringify(review, null, 2), "utf8");
      return stored.recomputed.candidateChecksum;
    };

    // =====================================================================
    section("1. PROMOTABLE + accepted_suggestion ⇒ 恰好一条 dry-run 命令");
    // =====================================================================
    signReview();
    const okOut = runReview();
    check("门禁结论为 PROMOTABLE", /门禁结论：PROMOTABLE/.test(okOut), okOut.match(/门禁结论：\S+/)?.[0]);
    check("输出了交接计划", /已复核链接交接计划/.test(okOut));
    check("恰好 1 条 course:link 命令", countLinkCommands(okOut) === 1, `${countLinkCommands(okOut)} 条`);
    check("命令带 --status verified", /pnpm course:link[^\n]*--status verified/.test(okOut));
    check("命令**不带** --commit", !/pnpm course:link[^\n]*--commit/.test(okOut));

    // =====================================================================
    section("2. 陈旧 candidateChecksum ⇒ 零 course:link 命令");
    // =====================================================================
    signReview({ candidateChecksum: "0".repeat(64) });
    const staleOut = runReview();
    check("门禁不是 PROMOTABLE", !/门禁结论：PROMOTABLE/.test(staleOut), staleOut.match(/门禁结论：\S+/)?.[0]);
    check("输出**零** course:link 命令", countLinkCommands(staleOut) === 0, `${countLinkCommands(staleOut)} 条`);
    check("明确说明交接已抑制", /链接交接已抑制/.test(staleOut));
    check("不再把结果描述为已复核交接计划", !/已复核链接交接计划/.test(staleOut));

    // =====================================================================
    section("3. 源漂移（不重跑抽取）⇒ 零 course:link 命令");
    // =====================================================================
    signReview();
    const handoutPath = join(sourceRoot, "阅读", "reading-handout.pdf");
    const originalBytes = readFileSync(handoutPath);
    writeFileSync(handoutPath, Buffer.concat([originalBytes, Buffer.from("%%DRIFT", "utf8")]));

    const driftOut = runReview();
    check("检测到源已漂移", /源已漂移/.test(driftOut));
    check("门禁不是 PROMOTABLE", !/门禁结论：PROMOTABLE/.test(driftOut));
    check("输出**零** course:link 命令", countLinkCommands(driftOut) === 0, `${countLinkCommands(driftOut)} 条`);
    check("明确说明交接已抑制", /链接交接已抑制/.test(driftOut));

    // 恢复源
    writeFileSync(handoutPath, originalBytes);

    // =====================================================================
    section("4. 源不可用（目录被删除）⇒ 零 course:link 命令");
    // =====================================================================
    signReview();
    const movedRoot = join(work, "source-moved-away");
    execFileSync("node", ["-e", `require('fs').renameSync(${JSON.stringify(sourceRoot)}, ${JSON.stringify(movedRoot)})`]);
    const missingOut = runReview();
    check("门禁不是 PROMOTABLE", !/门禁结论：PROMOTABLE/.test(missingOut));
    check("输出**零** course:link 命令", countLinkCommands(missingOut) === 0, `${countLinkCommands(missingOut)} 条`);
    execFileSync("node", ["-e", `require('fs').renameSync(${JSON.stringify(movedRoot)}, ${JSON.stringify(sourceRoot)})`]);

    // =====================================================================
    section("5. canonical 库不完整 ⇒ 零 course:link 命令（收口实现/文档矛盾）");
    // =====================================================================
    signReview();
    // 放一份**坏**的真题包 ⇒ 库不完整
    const brokenDir = join(contentRoot, "cet6", "papers", "p-broken");
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, "paper.json"), "{ not valid json", "utf8");

    const incompleteOut = runReview();
    check("报告了库不完整", /canonical 库不完整|读取失败/.test(incompleteOut));
    check(
      "canonical_library_complete_for_acceptance 未通过",
      /canonical_library_complete_for_acceptance/.test(incompleteOut) && /不得据此交接/.test(incompleteOut),
    );
    check(
      "输出**零** course:link 命令（实现与文档一致）",
      countLinkCommands(incompleteOut) === 0,
      `${countLinkCommands(incompleteOut)} 条`,
    );
    check("明确说明交接已抑制", /链接交接已抑制/.test(incompleteOut));

    // 清理坏包（恢复库完整）
    rmSync(brokenDir, { recursive: true, force: true });

    // =====================================================================
    section("6. 库不完整 + **没有** accepted_suggestion ⇒ 课程包仍可 PROMOTABLE，交接为空");
    // =====================================================================
    {
      /*
       * 关键细节：`readFailures` **参与库摘要**（F10/库完整性设计）。
       * 因此"库从不完整变完整"或反之都会改变摘要 ⇒ 旧复核立刻陈旧。
       *
       * 要验证"库在**复核时就已经不完整**、且没有接受任何建议 ⇒ 仍可晋升"，
       * 复核里的 canonicalLibraryDigest 必须等于**当前不完整库**的摘要。
       * 所以先放坏包、读出当前摘要，再据此签署复核。
       */
      const brokenPath = join(contentRoot, "cet6", "papers", "p-broken");
      mkdirSync(brokenPath, { recursive: true });
      writeFileSync(join(brokenPath, "paper.json"), "{ not valid json", "utf8");

      // 从 --json 输出里取当前（不完整）库摘要
      const jsonOut = runReview(["--json"]);
      const digestMatch = /"canonicalLibraryDigest":\s*"([0-9a-f]{64})"/.exec(jsonOut);
      check("拿到了当前（不完整）库摘要", digestMatch !== null);
      const incompleteDigest = digestMatch?.[1] ?? "";

      const md = stored.metadata;
      const noAccept = {
        courseId: COURSE_ID,
        reviewer: "handoff-proof",
        reviewedAt: "2026-01-01",
        candidateChecksum: stored.recomputed.candidateChecksum,
        // ← 绑定**当前不完整库**的摘要（模拟"签署时库就已经不完整"）
        canonicalLibraryDigest: incompleteDigest,
        materialGroupings: md.grouping.proposals
          .filter((p) => p.reviewRequired)
          .map((p) => ({
            proposalId: p.id,
            decision: "accepted",
            note: "证明：确认该分组。",
            evidence: "证明脚本依据候选记录作出该裁决（>=10 字符）。",
          })),
        segments: md.segmentation.materials
          .flatMap((m) => m.segments)
          .filter((s) => s.reviewRequired)
          .map((s) => ({
            segmentId: s.id,
            decision: "accepted",
            note: "证明：确认该段。",
            evidence: "证明脚本依据候选记录作出该裁决（>=10 字符）。",
          })),
        matches: [],
        verifiedScope: ["证明脚本"],
        notVerified: [],
      };
      writeFileSync(join(candidatesDir, "review.json"), JSON.stringify(noAccept, null, 2), "utf8");

      const noAcceptOut = runReview();
      check(
        "库不完整但无 accepted_suggestion ⇒ 课程包**仍可** PROMOTABLE（未被一刀切阻断）",
        /门禁结论：PROMOTABLE/.test(noAcceptOut),
        noAcceptOut.match(/门禁结论：\S+/)?.[0],
      );
      check(
        "该项本身通过（没有接受建议 ⇒ 库完整性与交接无关）",
        /canonical_library_complete_for_acceptance/.test(noAcceptOut) &&
          /没有接受任何 canonical 建议/.test(noAcceptOut),
      );
      check("输出**零** course:link 命令", countLinkCommands(noAcceptOut) === 0);
      check("明确说明没有待建链接", /没有任何 `accepted_suggestion`/.test(noAcceptOut));
      rmSync(brokenPath, { recursive: true, force: true });
    }

    // =====================================================================
    section("7. F11 回归：恶意证据仍在 review.json 里，但不进军令");
    // =====================================================================
    {
      const md = stored.metadata;
      const malicious = 'proof "quoted"; $(echo bad); `bad`; $HOME\nnewline';
      const scope = top.target.questionId !== null ? "question" : top.target.groupId !== null ? "group" : "section";
      const evilReview = {
        courseId: COURSE_ID,
        reviewer: "handoff-proof",
        reviewedAt: "2026-01-01",
        candidateChecksum: stored.recomputed.candidateChecksum,
        canonicalLibraryDigest: md.matching.canonicalLibrary.digest,
        materialGroupings: md.grouping.proposals
          .filter((p) => p.reviewRequired)
          .map((p) => ({
            proposalId: p.id,
            decision: "accepted",
            note: "证明：确认该分组。",
            evidence: malicious,
          })),
        segments: md.segmentation.materials
          .flatMap((m) => m.segments)
          .filter((s) => s.reviewRequired)
          .map((s) => ({
            segmentId: s.id,
            decision: "accepted",
            note: "证明：确认该段。",
            evidence: malicious,
          })),
        matches: [
          {
            segmentId: withSuggestion.segmentId,
            disposition: "accepted_suggestion",
            paperId: top.target.paperId,
            targetScope: scope,
            sectionId: top.target.sectionId,
            groupId: scope === "section" ? null : top.target.groupId,
            questionId: scope === "question" ? top.target.questionId : null,
            note: "证明：接受建议。",
            evidence: malicious,
          },
        ],
        verifiedScope: ["证明脚本"],
        notVerified: [],
      };
      writeFileSync(join(candidatesDir, "review.json"), JSON.stringify(evilReview, null, 2), "utf8");

      const evilOut = runReview();
      const linkLines = evilOut.split("\n").filter((line) => line.includes("pnpm course:link"));
      const joined = linkLines.join("\n");
      check("门禁仍为 PROMOTABLE（恶意文本不影响门禁）", /门禁结论：PROMOTABLE/.test(evilOut));
      check("输出了 1 条 course:link 命令", linkLines.length === 1, `${linkLines.length} 条`);
      check("命令里没有 echo bad", !joined.includes("echo bad"));
      check("命令里没有 $HOME", !joined.includes("$HOME"));
      check("命令里没有反引号注入", !/`bad`/.test(joined));
      check("命令里没有换行注入", !joined.includes("\\n"));
      check("命令里没有引号", !joined.includes('"') && !joined.includes("'"));
      check("仍然不带 --commit", !joined.includes("--commit"));
      check("--ref 是受控标识符", /--ref course-review:[a-z0-9._:-]+/.test(joined), joined.slice(0, 160));
      // 证据本身**仍然可读**（没被丢掉，只是不进军令）
      check("自由文本证据仍在 review.json 里", readFileSync(join(candidatesDir, "review.json"), "utf8").includes("echo bad"));
    }

    console.log(`\n${"─".repeat(60)}`);
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      /* Windows 残留无妨 */
    }
  }
}

void existsSync;

main().catch((error) => {
  console.error("\n证明脚本异常终止：");
  console.error(error);
  process.exitCode = 1;
});
