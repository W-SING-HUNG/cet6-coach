#!/usr/bin/env node
/**
 * A2 Review Fix · 受控红/绿变异证明（`pnpm course:a2-mutation`）。
 *
 * ── 它证明什么 ──
 *
 * 任务书要求："尤其要证明关闭 staleness guard、传入假摘要、跳过候选生成等
 * 缺陷会导致相关测试失败。"
 *
 * 本脚本对**真实源码**做逐字节可控变异，每轮：
 *   1. 记录原字节与 sha256；
 *   2. 写入变异；
 *   3. 跑指定的 vitest 用例；
 *   4. 还原并逐字节核对（sha256 必须一致）；
 *   5. 复跑确认恢复。
 *
 * 变异清单（每个都对应一种真实缺陷形态；刻意**只选非冗余**的守卫）：
 *
 * | # | 缺陷形态 | 变异 | 期望 |
 * | --- | --- | --- | --- |
 * | M1 | 关掉陈旧防线 | 删掉"客户端摘要必须等于现场重算值"的判据 | A2 用例变红 |
 * | M2 | 跳过源新鲜度检查 | 删掉"重新清点源目录并与候选记录比对"的判据 | A2 用例变红 |
 * | M3 | 绕过整个保存前校验 | `saveAdjudicationReview` 直接用 draft 而不经 `prepareReviewForSave` | A2 用例变红 |
 * | M4 | 允许重复裁决 | 删掉重复 proposalId 去重判据 | A2 用例变红 |
 * | M5 | 计划绑定取自客户端 | 注入计划 binding 时改用客户端提交的 sourceDigest 而非现算值 | A2 计划用例变红 |
 *
 * ── 两条**刻意不做**变异的守卫（如实登记，不伪装覆盖）──
 *
 * - 「摘要必须是 64 位十六进制」的形态判据：它与 M1 的相等性判据**冗余**
 *   （全零串永远对不上现场重算值）。对它做变异不会变红 —— 那不是门禁失效，
 *   而是纵深防御。故不纳入清单，只在此说明。
 * - 「落盘写重算值而非 draft 值」：经 M1 之后二者必然相等，写哪个字节相同。
 *   同理属于冗余层。
 *
 * 全程只跑 vitest 入口，不起 HTTP 服务器，不读任何真实材料。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const ADJUDICATION = "src/content/course-pipeline/adjudication.ts";

interface Mutation {
  id: string;
  guard: string;
  file: string;
  from: string;
  to: string;
  testFile: string;
  /** 期望在变异后失败的具体测试名（用于确认"红在对的地方"）。 */
  expectTestName: RegExp;
  /** 期望在错误输出里出现的片段（进一步确认失败原因正确）。 */
  expectReason?: RegExp;
}

const MUTATIONS: Mutation[] = [
  {
    id: "M1",
    guard: "客户端摘要必须等于服务端现场重算值（陈旧防线核心）",
    file: ADJUDICATION,
    from: `  if (draft.candidateChecksum !== rebound.candidateChecksum) {
    errors.push(
      \`草稿绑定的候选校验和与当前候选不一致（界面: \${draft.candidateChecksum.slice(0, 12)}…，\` +
        \`当前候选: \${rebound.candidateChecksum.slice(0, 12)}…）。\` +
        \`这通常表示候选已被重新生成而本页是过期视图 —— 请重新检查并刷新后再保存。\`,
    );
  }`,
    to: `  // 变异 M1：删掉"客户端摘要必须等于重算值"的判据（缺陷形态：陈旧视图可保存）`,
    testFile: "tests/course-a2-adjudication.test.ts",
    expectTestName: /全零摘要的保存被拒/,
  },
  {
    id: "M2",
    guard: "源新鲜度：重新清点当前源并与候选记录比对",
    file: ADJUDICATION,
    from: `  if (params.sourceDir && stored !== null && existsSync(params.sourceDir)) {
    try {
      const currentSourceDigest = scanSourceDirectory(params.sourceDir).digest;
      if (currentSourceDigest !== stored.metadata.inventory.digest) {`,
    to: `  if (false && params.sourceDir && stored !== null && existsSync(params.sourceDir)) {
    try {
      const currentSourceDigest = scanSourceDirectory(params.sourceDir).digest;
      if (currentSourceDigest !== stored.metadata.inventory.digest) {`,
    testFile: "tests/course-a2-adjudication.test.ts",
    expectTestName: /源字节变动/,
  },
  {
    id: "M3",
    guard: "保存必须经过 prepareReviewForSave（不得绕过校验）",
    file: ADJUDICATION,
    from: `  // 1. 保存前校验（含现场重算绑定身份与客户端摘要核对）
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
  }`,
    to: `  // 变异 M3：绕过保存前校验（缺陷形态：未校验草稿直接落盘）
  const prepared = {
    ok: true,
    errors: [] as string[],
    reviewFile: params.draft as unknown as CourseReviewFile,
    rebound: null as unknown as ReboundIdentity,
    candidateExists: true,
  };`,
    testFile: "tests/course-a2-adjudication.test.ts",
    expectTestName: /全零摘要的保存被拒/,
  },
  {
    id: "M4",
    guard: "重复 / 冲突裁决必须在服务端拒绝",
    file: ADJUDICATION,
    from: `      if (groupingIds.get(id) === 2) {
        errors.push(\`materialGroupings[\${index}]：proposalId「\${id}」被重复裁决 —— 同一分组只能有一条决定\`);
      }`,
    to: `      // 变异 M4：不再拒绝重复分组裁决`,
    testFile: "tests/course-a2-adjudication.test.ts",
    expectTestName: /重复 proposalId/,
  },
  {
    id: "M5",
    guard: "计划 binding 必须由服务端现算（不得取自客户端）",
    file: ADJUDICATION,
    from: `  const rebound = {
    ...submitted,
    schemaVersion: 1,
    binding: {
      courseId: params.courseId,
      sourceDigest,
      assets: [...assetChecksums].sort((a, b) => a.assetKey.localeCompare(b.assetKey)),
    },
  };`,
    to: `  // 变异 M5：binding 改用客户端提交的值（缺陷形态：陈旧计划可落盘）
  const submittedBinding = (submitted.binding ?? {}) as { sourceDigest?: string };
  const rebound = {
    ...submitted,
    schemaVersion: 1,
    binding: {
      courseId: params.courseId,
      sourceDigest: submittedBinding.sourceDigest ?? sourceDigest,
      assets: [...assetChecksums].sort((a, b) => a.assetKey.localeCompare(b.assetKey)),
    },
  };`,
    testFile: "tests/course-a2-adjudication.test.ts",
    expectTestName: /服务端现算绑定/,
  },
];

interface MutationResult {
  id: string;
  guard: string;
  applied: boolean;
  anchorHits: number;
  caught: boolean;
  failedTestMatched: boolean;
  reasonSnippet: string;
  restoredByteIdentical: boolean;
  greenAfterRestore: boolean;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function runVitest(testFile: string): { exitCode: number; output: string } {
  const result = spawnSync(
    "npx",
    ["vitest", "run", testFile],
    { cwd: REPO_ROOT, encoding: "utf8", shell: process.platform === "win32" },
  );
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return { exitCode: result.status ?? -1, output };
}

function applyMutation(mutation: Mutation): { applied: boolean; hits: number } {
  const path = join(REPO_ROOT, mutation.file);
  const source = readFileSync(path, "utf8");
  const parts = source.split(mutation.from);
  if (parts.length !== 2) {
    return { applied: false, hits: parts.length - 1 };
  }
  writeFileSync(path, parts.join(mutation.to), "utf8");
  return { applied: true, hits: 1 };
}

function restore(path: string, original: string): boolean {
  writeFileSync(path, original, "utf8");
  return readFileSync(path, "utf8") === original;
}

async function main(): Promise<void> {
  console.log("A2 Review Fix · 受控红/绿变异证明");
  console.log("（全程只跑 vitest；不起 HTTP 服务器；不读任何真实材料）");
  console.log("");

  const path = join(REPO_ROOT, ADJUDICATION);
  const original = readFileSync(path, "utf8");
  const originalSha = sha256(original);

  // ── 基准（未变异）──
  console.log("基准（未变异）");
  const baseline = runVitest("tests/course-a2-adjudication.test.ts");
  const baselineGreen = baseline.exitCode === 0;
  console.log(`  ${baselineGreen ? "✓" : "✗"} tests/course-a2-adjudication.test.ts ${baselineGreen ? "全绿" : `非零退出（${baseline.exitCode}）`}`);
  if (!baselineGreen) {
    console.error("基准不是全绿 —— 变异证明无意义，先修好基线。");
    process.exitCode = 1;
    return;
  }

  const results: MutationResult[] = [];

  for (const mutation of MUTATIONS) {
    console.log("");
    console.log(`${mutation.id} · ${mutation.guard}`);
    const { applied, hits } = applyMutation(mutation);
    if (!applied) {
      console.log(`  ✗ 锚点无效（命中 ${hits} 次，需恰好 1 次）—— 源码已变，请更新本脚本的锚点`);
      results.push({
        id: mutation.id,
        guard: mutation.guard,
        applied: false,
        anchorHits: hits,
        caught: false,
        failedTestMatched: false,
        reasonSnippet: "",
        restoredByteIdentical: false,
        greenAfterRestore: false,
      });
      restore(path, original);
      continue;
    }

    const mutated = runVitest(mutation.testFile);
    const caught = mutated.exitCode !== 0;
    const failedTestMatched = mutation.expectTestName.test(mutated.output);
    const reasonSnippet = firstFailureLine(mutated.output);

    console.log(`  ${caught ? "✓" : "✗"} ${caught ? "被捕获" : "**未被捕获**（门禁失效）"}`);
    console.log(`  ${failedTestMatched ? "✓" : "✗"} 失败落在预期用例（${mutation.expectTestName}）`);
    if (reasonSnippet) console.log(`      ${reasonSnippet}`);
    if (mutation.expectReason && !mutation.expectReason.test(mutated.output)) {
      console.log(`  ✗ 失败原因不符合预期（${mutation.expectReason}）`);
    }

    const restoredByteIdentical = restore(path, original) && sha256(readFileSync(path, "utf8")) === originalSha;
    console.log(`  ${restoredByteIdentical ? "✓" : "✗"} 还原后 sha256 逐字节一致`);

    const after = runVitest(mutation.testFile);
    const greenAfterRestore = after.exitCode === 0;
    console.log(`  ${greenAfterRestore ? "✓" : "✗"} 恢复后复绿`);

    results.push({
      id: mutation.id,
      guard: mutation.guard,
      applied: true,
      anchorHits: hits,
      caught,
      failedTestMatched,
      reasonSnippet,
      restoredByteIdentical,
      greenAfterRestore,
    });
  }

  // ── 汇总 ──
  console.log("");
  console.log("汇总");
  const okCount = results.filter((r) => r.applied && r.caught && r.failedTestMatched && r.restoredByteIdentical && r.greenAfterRestore).length;
  for (const result of results) {
    const status = result.applied && result.caught && result.failedTestMatched && result.restoredByteIdentical && result.greenAfterRestore ? "✓" : "✗";
    console.log(`  ${status} ${result.id} ${result.guard}`);
  }
  console.log("");
  console.log(`结果：${okCount} / ${results.length} 个变异被门禁正确捕获并逐字节恢复`);

  const finalSha = sha256(readFileSync(path, "utf8"));
  console.log(`  源码最终 sha256：${finalSha === originalSha ? "与基线一致" : "**与基线不一致（异常！）**"}`);
  if (finalSha !== originalSha) process.exitCode = 1;
  if (okCount !== results.length) process.exitCode = 1;
}

function firstFailureLine(output: string): string {
  const lines = output.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("FAIL") || trimmed.startsWith("×") || trimmed.includes("AssertionError")) {
      return trimmed.slice(0, 160);
    }
  }
  return "";
}

main().catch((error: unknown) => {
  console.error("变异证明失败：", error instanceof Error ? (error.stack ?? error.message) : error);
  process.exitCode = 1;
});
