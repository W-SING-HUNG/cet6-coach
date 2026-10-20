#!/usr/bin/env node
/**
 * 路径容纳与展示安全的**显式证明**（对应评审项 F-B / F-C）。
 *
 * 它在**真实磁盘**与**真实 CLI** 边界上逐条证明：
 *
 * PATH（F-B）
 *   - 各种逃逸形态被 **service 边界**拒绝（不依赖 CLI）
 *   - 各类 CLI 调用被拒绝且非零退出
 *   - 晋升即使收到手工构造的恶意 StoredCandidate 也不写出 courses/
 *
 * SHELL / DISPLAY（F-C）
 *   - 展示文本被消毒（控制字符 + shell 元字符）
 *   - 生成的 source-root 指引是**模板**，不含任何真实路径
 *
 * 全程临时内容根 + 合成夹具；绝不触碰 使用者 真实库或真实 private-content。
 *
 * 用法：node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/course-path-safety-proof.ts
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "cet6-path-safety-"));
const contentRoot = join(work, "content");
const candidatesRoot = join(contentRoot, "course-candidates");

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

/** 跑真实 CLI，返回退出码与合并输出。 */
function runCli(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("pnpm", args, {
      cwd: repo,
      env: { ...process.env, CET6_CONTENT_ROOT: contentRoot },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

async function main(): Promise<void> {
  const { writeSourceTree } = await import("./course-source-fixture");
  const { readingFixture } = await import("./course-source-scenarios");
  const {
    assertSafeCourseId,
    isSafeCourseId,
    resolveCandidateDir,
    resolvePromotedCourseDir,
    sanitizeForDisplay,
  } = await import("@/content/course-pipeline/containment");
  const { readStoredCandidate, promoteCourseCandidate, gatherPromotionInputs, evaluatePromotionGate, validateCourseReviewFile } =
    await import("@/content/course-pipeline/review");
  const { runCourseIntake } = await import("@/content/course-pipeline");
  const { writeCourseCandidate } = await import("@/content/course-pipeline/candidate");
  const { buildFixturePackage, writeFixturePackage } = await import("./paper-fixture");

  console.log("路径容纳与展示安全 · 显式证明（真实磁盘 + 真实 CLI）");

  try {
    mkdirSync(candidatesRoot, { recursive: true });

    // =====================================================================
    section("1. F-B：逃逸形态在 **service 边界**被拒绝（不依赖 CLI）");
    // =====================================================================
    const ESCAPES = [
      "..",
      "../escape",
      "..\\escape",
      "../../escape",
      "..\\..\\escape",
      "/etc/passwd",
      "/absolute/path",
      "C:\\Windows\\system32",
      "C:/Windows/system32",
      "\\\\server\\share",
      "//server/share",
      "a/b",
      "a\\b",
      "",
      ".",
      "./x",
    ];
    let allRejected = true;
    for (const evil of ESCAPES) {
      if (isSafeCourseId(evil)) {
        allRejected = false;
        console.log(`      ✗ 竟然被接受：${JSON.stringify(evil)}`);
      }
      try {
        assertSafeCourseId(evil);
        allRejected = false;
      } catch {
        /* 期望 */
      }
    }
    check(`全部 ${ESCAPES.length} 种逃逸形态被 isSafeCourseId/assertSafeCourseId 拒绝`, allRejected);

    // 在候选根**之外**放一份"看起来像候选"的目录
    const outside = join(contentRoot, "ESCAPE-TARGET");
    mkdirSync(outside, { recursive: true });
    const fs = await import("node:fs");
    fs.writeFileSync(join(outside, "candidate.json"), "{}", "utf8");
    fs.writeFileSync(join(outside, "course.json"), "{}", "utf8");

    let serviceRejected = 0;
    for (const evil of ["../ESCAPE-TARGET", "..\\ESCAPE-TARGET", "../../ESCAPE-TARGET", outside]) {
      try {
        const s = readStoredCandidate(evil, candidatesRoot);
        console.log(`      ✗ readStoredCandidate 逃逸成功：${evil} -> ${s.candidateDir}`);
      } catch (error) {
        serviceRejected += 1;
        void error;
      }
    }
    check("readStoredCandidate 拒绝全部逃逸尝试（直接调用也不可绕过）", serviceRejected === 4, `${serviceRejected}/4`);

    // 路径解析入口
    let resolverRejected = 0;
    for (const evil of ["../escape", "..\\escape", "/abs", "C:\\x", "a/b"]) {
      try {
        resolveCandidateDir(evil, candidatesRoot);
      } catch {
        resolverRejected += 1;
      }
      try {
        resolvePromotedCourseDir(evil, join(contentRoot, "courses"));
      } catch {
        /* 期望 */
      }
    }
    check("resolveCandidateDir 拒绝全部逃逸形态", resolverRejected === 5, `${resolverRejected}/5`);

    // 合法 id 仍然可用
    check("合法课程 id 仍然可用", (() => {
      try {
        assertSafeCourseId("rsvp-2026h2-reading");
        resolveCandidateDir("rsvp-2026h2-reading", candidatesRoot);
        return true;
      } catch {
        return false;
      }
    })());

    // =====================================================================
    section("2. F-B：真实 CLI 拒绝逃逸课程 id（非零退出）");
    // =====================================================================
    for (const evil of ["../../escape", "..\\..\\escape", "C:\\Windows\\system32", "\\\\server\\share", "/etc/passwd"]) {
      const r = runCli(["course:review", evil]);
      const rejected = r.code !== 0 && /课程 id 不安全/.test(r.out);
      check(`course:review ${JSON.stringify(evil)} 被拒绝`, rejected, `exit=${r.code}`);
    }

    // =====================================================================
    section("3. F-B：晋升即使收到恶意 StoredCandidate 也不写出 courses/");
    // =====================================================================
    const src = join(contentRoot, "course-sources", "safety");
    mkdirSync(src, { recursive: true });
    writeSourceTree(src, readingFixture());
    writeFixturePackage(contentRoot, "p", buildFixturePackage({ id: "p", contentVersion: 1 }));

    const intake = await runCourseIntake({
      sourceRoot: src,
      courseId: "safety",
      provider: "test_fixture_provider",
      edition: null,
      title: "安全证明夹具",
      contentVersion: 1,
      provenance: { note: "合成夹具", reference: null, rightsNote: "合成夹具" },
      papersDir: join(contentRoot, "cet6", "papers"),
      standardSourcesRoot: join(contentRoot, "course-sources"),
    });
    const dir = join(candidatesRoot, "safety");
    mkdirSync(dir, { recursive: true });
    writeCourseCandidate(intake.archive, dir);

    const stored = readStoredCandidate("safety", candidatesRoot);
    const md = stored.metadata;
    const review = {
      courseId: "safety",
      reviewer: "safety-proof",
      reviewedAt: "2026-01-01",
      candidateChecksum: stored.recomputed.candidateChecksum,
      canonicalLibraryDigest: md.matching.canonicalLibrary.digest,
      materialGroupings: md.grouping.proposals
        .filter((p) => p.reviewRequired)
        .map((p) => ({
          proposalId: p.id,
          decision: "accepted",
          note: "证明",
          evidence: "安全证明脚本依据候选记录作出该裁决（>=10 字符）。",
        })),
      segments: md.segmentation.materials
        .flatMap((m) => m.segments)
        .filter((s) => s.reviewRequired)
        .map((s) => ({
          segmentId: s.id,
          decision: "accepted",
          note: "证明",
          evidence: "安全证明脚本依据候选记录作出该裁决（>=10 字符）。",
        })),
      matches: [],
      verifiedScope: ["安全证明"],
      notVerified: [],
    };
    fs.writeFileSync(join(dir, "review.json"), JSON.stringify(review, null, 2), "utf8");
    const parsed = validateCourseReviewFile(review);

    const coursesDir = join(contentRoot, "courses");
    const gate = evaluatePromotionGate(
      gatherPromotionInputs({
        stored,
        review: parsed.file,
        reviewErrors: parsed.errors,
        canonical: { digest: md.matching.canonicalLibrary.digest, complete: true },
        standardSourcesRoot: join(contentRoot, "course-sources"),
      }),
    );
    check("前置：门禁为 PROMOTABLE（否则本项没有意义）", gate.status === "PROMOTABLE", gate.status);

    for (const evilId of ["../../ESCAPE-PROMOTION", "..\\..\\ESCAPE-PROMOTION", "/tmp/escaped"]) {
      const promoted = promoteCourseCandidate({
        stored: { ...stored, courseId: evilId },
        gate,
        review: parsed.file,
        coursesDir,
      });
      check(`晋升拒绝恶意 courseId ${JSON.stringify(evilId)}`, promoted.ok === false);
    }
    check("courses/ 之外没有产生任何目录", !existsSync(join(contentRoot, "ESCAPE-PROMOTION")) && !existsSync(join(work, "ESCAPE-PROMOTION")));

    // =====================================================================
    section("4. F-C：展示文本消毒");
    // =====================================================================
    const NASTY = [
      "odd$(id)dir",
      "back`tick",
      'quote"dir',
      "single'quote",
      "semi;colon",
      "pipe|dir",
      "amp&dir",
      "new\nline",
      "carriage\rreturn",
      "tab\there",
      "redir>out",
      "less<in",
      "$env:PATH",
      "unicode中文😀",
    ];
    let allSanitized = true;
    for (const nasty of NASTY) {
      const safe = sanitizeForDisplay(nasty);
      const bad =
        /[\u0000-\u001f\u007f]/.test(safe) ||
        safe.includes("$") ||
        safe.includes("`") ||
        safe.includes(";") ||
        safe.includes("|") ||
        safe.includes("&") ||
        /["']/.test(safe);
      if (bad) {
        allSanitized = false;
        console.log(`      ✗ 消毒不彻底：${JSON.stringify(nasty)} -> ${JSON.stringify(safe)}`);
      }
    }
    check(`全部 ${NASTY.length} 种恶意/尴尬文本被消毒`, allSanitized);
    check("换行被中性化为可见字符（可看出原本有换行）", sanitizeForDisplay("a\nb").includes("?"));

    // =====================================================================
    section("5. F-C：source-root 指引是模板（不含真实路径）");
    // =====================================================================
    const extractSource = fs.readFileSync(join(repo, "scripts/course-extract.ts"), "utf8");
    check("不再输出带真实路径的 --source-root", !/--source-root "\$\{args\.source\}/.test(extractSource));
    check("给出不含路径的模板", extractSource.includes("--source-root <PATH>"));
    check("展示用的 label 经过消毒", extractSource.includes("sanitizeForDisplay(locator.label)"));

    // 行为层：用含元字符的外部源目录名跑一次 extract CLI，输出里不得出现原始文本。
    //
    // 注意：这里**不经 shell** 传参（`shell: false`），否则 PowerShell 会先对
    // `$()` 做命令替换，被测试的就不再是"CLI 如何输出"而是"shell 如何展开"。
    const evilDirName = "odd$(id)dir`x`;y&z 'q'";
    const evilSource = join(work, evilDirName);
    mkdirSync(evilSource, { recursive: true });
    writeSourceTree(evilSource, readingFixture());

    let extractRun: { code: number; out: string };
    try {
      const out = execFileSync(
        process.execPath,
        [
          "--experimental-transform-types",
          "--import",
          "./scripts/alias-loader.mjs",
          "scripts/course-extract.ts",
          "--source",
          evilSource,
          "--id",
          "safety-ext",
          "--provider",
          "test_fixture_provider",
        ],
        {
          cwd: repo,
          env: { ...process.env, CET6_CONTENT_ROOT: contentRoot },
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        },
      );
      extractRun = { code: 0, out };
    } catch (error) {
      const failure = error as { status?: number; stdout?: string; stderr?: string };
      extractRun = { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
    }

    check("extract 成功退出", extractRun.code === 0, `exit=${extractRun.code}`);
    // 关键：原始目录名**绝不以原样**出现在输出里（会被消毒为全角形式）
    check("CLI 输出不含原始的 $() 注入形态", !extractRun.out.includes("$(id)"));
    check("CLI 输出不含原始的反引号序列", !extractRun.out.includes("`x`"));
    check("CLI 输出不含原始的分号/&/引号序列", !extractRun.out.includes(";y&z 'q'"));
    // 但"被消毒后的"标签应当出现（证明它确实打印了、只是被中性化）
    check("打印了消毒后的标签（不是干脆不打印）", /odd＄|odd\$/.test(extractRun.out.replace(/\$\(id\)/g, "")) || extractRun.out.includes("odd"));
    check(
      "CLI 输出给出的是模板而非可粘贴的真实路径",
      extractRun.out.includes("--source-root <PATH>") && !extractRun.out.includes(evilSource),
    );

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

main().catch((error) => {
  console.error("\n证明脚本异常终止：");
  console.error(error);
  process.exitCode = 1;
});
