#!/usr/bin/env node
/**
 * A3 受控课程接入 · **受控红/绿变异证明**（`pnpm course:a3-mutation`）。
 *
 * ── 它证明什么 ──
 *
 * 一条门禁只有在"把它所防的缺陷真的放回去时确实变红"才算门禁。
 * 本脚本对**真实源码**做逐字节可控变异，每轮：
 *
 *   1. 记录原字节与 sha256；
 *   2. 写入变异；
 *   3. 跑指定的 vitest / 证明用例；
 *   4. 还原并逐字节核对（sha256 必须一致）；
 *   5. 复跑确认恢复。
 *
 * ── 变异清单（每个都是一种真实缺陷形态）──
 *
 * | # | 缺陷形态 | 变异 | 期望 |
 * | --- | --- | --- | --- |
 * | M1 | 备份用"复制文件"而不是一致性快照 | `VACUUM INTO` 换成 `copyFileSync` | A3 备份用例变红 |
 * | M2 | 备份失败仍然继续写入 | 备份失败时不再 return，继续迁移 | A3 迁移用例变红 |
 * | M3 | 跳过"验证备份可恢复" | 不调 `verifyBackupRestorable` 就继续 | A3 备份门禁用例变红 |
 * | M4 | 晋升目标已存在时覆盖 | 删掉"目标已存在即拒绝"的分支 | A3 晋升用例变红 |
 * | M5 | 建链默认写入（不再预演） | `dryRun` 恒定 false | A3 建链用例变红 |
 * | M6 | 裁决归属核对被关闭（A2 R1） | `checkAdjudicationOwnership` 恒返回空数组 | A3 R1 用例变红 |
 * | M7 | 数据库路径退回模块级常量 | `getDbFile()` 改回 import 时定值 | A3 隔离门禁变红 |
 * | M8 | 客户端脚本里混入反引号（F1 形态） | 在 String.raw 原文里插一个反引号 | A3 外壳门禁变红 |
 *
 * ── 两条**刻意不做**变异的地方（如实登记，不伪装覆盖）──
 *
 * - 「备份目标已存在即拒绝覆盖」：与 M1 的"必须是 VACUUM INTO"部分冗余 ——
 *   复制文件同样会覆盖，两条判据在同一次变异下一齐失效，无法区分。
 * - 「`confirmed` 必须为 true」：单元测试直接调服务层（不经过能力对象）
 *   时它不在路径上，它的判据落在 `course:a3-proof` 与 Playwright 里。
 *   本脚本只驱动 vitest，因此对它做变异不会变红 —— 那不是门禁失效，
 *   而是**判据所在的层不同**。如实说明，不用一个假绿来充数。
 *
 * 全程只跑 vitest 入口，不起 HTTP 服务器，不读任何真实材料。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();

const A3_SERVICE = "src/services/course-a3.ts";
/**
 * 备份原语所在的模块。
 *
 * ── 为什么 M1 指向它而不是 `course-a3.ts` ──
 *
 * 本轮把备份原语从 `course-a3.ts` 下沉到 `course-backup.ts`（消除与
 * `course-recovery.ts` 的循环 import）。**判据所在的层**随之移动，
 * 变异锚点必须跟着走 —— 否则它会"锚点无效"，而那种失败看起来像
 * "源码已变、需要更新锚点"，掩盖真正的原因。
 */
const BACKUP_PRIMITIVES = "src/services/course-backup.ts";
const REVIEW = "src/content/course-pipeline/review.ts";
const ADJUDICATION = "src/content/course-pipeline/adjudication.ts";
const CLIENT_SCRIPT = "src/content/course-pipeline/a3-client-script.ts";
const DB_CLIENT = "src/db/client.ts";
const RECOVERY = "src/services/course-recovery.ts";
const WAL_RECOVERY = "src/services/course-wal-recovery.ts";

const A3_TEST = "tests/course-a3-controlled-import.test.ts";
const SHELL_TEST = "tests/course-a3-workbench.test.ts";
const RECOVERY_TEST = "tests/course-a3-recovery.test.ts";
const WAL_RECOVERY_TEST = "tests/course-a3-wal-recovery.test.ts";

interface Mutation {
  id: string;
  guard: string;
  file: string;
  from: string;
  to: string;
  /**
   * 额外的替换对（同一文件内）。
   *
   * 用途：一个缺陷形态有时需要同时破坏多处（例如"三道守卫一起移除"
   * 才等于"没有恢复点却继续迁移"）。每一对都必须**恰好命中一次**。
   */
  also?: { from: string; to: string }[];
  testFile: string;
  /** 期望在变异后失败的具体测试名（确认"红在对的地方"）。 */
  expectTestName: RegExp;
  /**
   * 为 `true` 时，这个变异**期望不被捕获**（用例保持绿）。
   *
   * ── 为什么需要它，而不是把它从清单里删掉 ──
   *
   * 有些安全属性由**多条判据**守护。单独破坏其中一条时，另一条仍然兜住 ⇒
   * 用例保持绿。那不是门禁失效，而是纵深防御 —— 而"证明每一条都独立有效"
   * 恰恰需要把每条**单独**破坏一次并观察结果。
   *
   * 因此这类变异必须显式登记期望（绿），而不是被当成"漏检"悄悄删掉。
   * 本项目已登记过同一形态（A1 的目录身份判定：单独破坏一条
   * 判据不足以让安全属性失效）。
   */
  expectNotCaught?: boolean;
}

const MUTATIONS: Mutation[] = [
  {
    id: "M1",
    guard: "备份必须是 VACUUM INTO（一致性快照），不得用复制文件",
    file: BACKUP_PRIMITIVES,
    from: `    const escaped = backupPath.replace(/'/g, "''");
    db.exec(\`VACUUM INTO '\${escaped}'\`);`,
    to: `    // 变异 M1：退回"复制文件"（缺陷形态：WAL 未 checkpoint 时快照不完整）
    cpSync(db.location(), backupPath);`,
    testFile: A3_TEST,
    expectTestName: /VACUUM INTO|普通文件复制/,
  },
  {
    id: "M2",
    guard: "三道中止守卫全部移除 ⇒ 数据库才真的被写入（缺陷形态）",
    file: A3_SERVICE,
    /*
     * ── 实测结论：`runGuardedImport` 有**三道**互相冗余的中止守卫 ──
     *
     * | 守卫 | 拦住什么 |
     * | --- | --- |
     * | ① `!dbBackup.ok` | 备份调用本身失败（目标已存在 / 不可写） |
     * | ② `!verification.ok` | 备份"成功"但打不开（半截文件） |
     * | ③ `!contentBackup.ok` | 内容目录备份失败（没有内容恢复点） |
     *
     * 单独移除任意一道时，另两道仍兜住（M3 / M4 分别证明前两道）。
     * 因此本变异把**三道一起**移除 —— 那才是"没有恢复点却继续迁移"
     * 这一缺陷形态的真实样子。
     *
     * 期望的红色来自那条**直接**断言"被中止时数据库逐字节不变"的用例：
     * 它是本轮为闭合这个证明缺口补上的（原有用例只断言返回值，
     * 在三道守卫之下无论如何都不会红）。
     */
    from: `  const dbBackup = createDatabaseBackupAt(input.dbFile, dbBackupPath);
  if (!dbBackup.ok || dbBackup.backupPath === null) {
    return {
      ok: false,
      written: 0,
      report: null,
      backup: null,
      error: \`已中止：\${dbBackup.error ?? "备份未完成"}。在取得可恢复的快照之前不会写入数据库。\`,
    };
  }`,
    to: `  const dbBackup = createDatabaseBackupAt(input.dbFile, dbBackupPath);
  if (false) {
    return { ok: false, written: 0, report: null, backup: null, error: "变异 M2：移除守卫 ①" };
  }`,
    also: [
      {
        // 守卫 ②：验证可读回
        from: `  const verification = verifyBackupRestorable(dbBackup.backupPath);
  if (!verification.ok) {`,
        to: `  const verification: { ok: boolean; readable?: boolean; error?: string | null } = { ok: true };
  if (!verification.ok) {`,
      },
      {
        // 守卫 ③：内容目录备份
        from: `  const contentBackup = createContentBackup(input.coursesDir, contentBackupPath);
  if (!contentBackup.ok) {`,
        to: `  const contentBackup = { ok: true, backupPath: null, bytes: 0, sha256: null, error: null };
  if (!contentBackup.ok) {`,
      },
    ],
    testFile: A3_TEST,
    expectTestName: /数据库内容.*逐字节不变/,
  },
  {
    id: "M3",
    guard: "纵深防御 A：只破坏第一道（备份失败检查），第二道仍兜住",
    file: A3_SERVICE,
    /*
     * ── 为什么它**期望保持绿** ──
     *
     * 单独移除"备份失败即中止"之后，`verifyBackupRestorable` 会因为
     * 目标是那份坏文件而返回 ok=false ⇒ 仍然中止。
     *
     * 这条绿**不是漏检**，而是一条正面结论：第二道判据独立有效。
     * 本项目已登记过同一形态（A1 目录身份判定：单独破坏
     * 一条判据不足以让安全属性失效，因此必须逐条单独验证）。
     */
    from: `  const dbBackup = createDatabaseBackupAt(input.dbFile, dbBackupPath);
  if (!dbBackup.ok || dbBackup.backupPath === null) {`,
    to: `  const dbBackup = createDatabaseBackupAt(input.dbFile, dbBackupPath);
  if (false) {`,
    testFile: A3_TEST,
    expectTestName: /./,
    expectNotCaught: true,
  },
  {
    id: "M4",
    guard: "纵深防御 B：只破坏第二道（验证可读回），第一道仍兜住",
    file: A3_SERVICE,
    /*
     * 与 M3 互补：保留第一道，移除第二道（改为恒定通过）。
     *
     * 由于 `VACUUM INTO` 要么成功产出合法库、要么失败（被第一道拦住），
     * 单独移除第二道时用例**仍然绿** —— 第一道兜住了。
     * 这同样是一条正面结论，证明"两道各自独立地足够"。
     */
    from: `  const verification = verifyBackupRestorable(dbBackup.backupPath);
  if (!verification.ok) {`,
    to: `  const verification: { ok: boolean; readable?: boolean; error?: string | null } = { ok: true };
  if (!verification.ok) {`,
    testFile: A3_TEST,
    expectTestName: /./,
    expectNotCaught: true,
  },
  {
    id: "M5",
    guard: "晋升目标已存在时**拒绝覆盖**",
    file: REVIEW,
    from: `  if (existsSync(targetDir)) {
    return {
      ok: false,
      targetDir: null,
      copied: [],
      excluded: [],
      error:
        \`目标课程包已存在：courses/\${input.stored.courseId}。\` +`,
    to: `  // 变异 M4：目标已存在时直接覆盖（缺陷形态：静默替换运行时课程包）
  if (false) {
    return {
      ok: false,
      targetDir: null,
      copied: [],
      excluded: [],
      error:
        \`目标课程包已存在：courses/\${input.stored.courseId}。\` +`,
    testFile: A3_TEST,
    expectTestName: /目标已存在/,
  },
  {
    id: "M6",
    guard: "A3-c 默认 dry-run（不显式 commit 一律零写入）",
    file: A3_SERVICE,
    from: `    const result = verifyCanonicalLink(input.repos, { ...link, dryRun: !input.commit });`,
    to: `    // 变异 M5：总是写入（缺陷形态：预演也会落库）
    const result = verifyCanonicalLink(input.repos, { ...link, dryRun: false });`,
    testFile: A3_TEST,
    expectTestName: /dry-run|零写入|未写入/,
  },
  {
    id: "M7",
    guard: "裁决归属核对（A2 R1）：借用别处 id 的裁决必须被拒",
    file: ADJUDICATION,
    from: `    const violations = checkAdjudicationOwnership(draft, collectCandidateOwnership(stored));
    for (const violation of violations) {
      errors.push(
        \`\${violation.section}[\${violation.index}]：\${violation.reason}\` +
          \`请重新检查并刷新后再保存；系统不会自动删除或改写你的裁决。\`,
      );
    }`,
    to: `    // 变异 M6：关闭归属核对（缺陷形态：借用别处 id 的裁决可保存）
    const violations: { section: string; index: number; referencedId: string; reason: string }[] = [];
    for (const violation of violations) {
      void violation;
    }`,
    testFile: A3_TEST,
    expectTestName: /借用别处|不属于当前候选/,
  },
  {
    id: "M8",
    guard: "数据库路径必须每次现算（隔离缺陷）",
    file: DB_CLIENT,
    from: `export function getDbFile(): string {
  return process.env.CET6_DB_PATH ?? join(process.cwd(), "data", "cet6.db");
}`,
    to: `// 变异 M7：退回 import 时定值（缺陷形态：先 import、后设 env 的调用方写到默认库）
const FROZEN_DB_FILE = process.env.CET6_DB_PATH ?? join(process.cwd(), "data", "cet6.db");
export function getDbFile(): string {
  return FROZEN_DB_FILE;
}`,
    testFile: SHELL_TEST,
    /*
     * 这一条的红色来自**行为**判据：`getDbFile()` 每次调用都反映当前环境。
     * 退回 import 时定值之后，改 `CET6_DB_PATH` 不再改变返回值 ⇒ 那条用例变红。
     */
    expectTestName: /每次调用都反映当前环境/,
  },
  {
    id: "M9",
    guard: "客户端脚本是 String.raw 原文：不得出现反引号（F1 形态）",
    file: CLIENT_SCRIPT,
    from: `  var inFlight = { promote: false, import: false, link: false };`,
    to: "  var inFlight = { promote: false, import: `BROKEN, link: false };",
    testFile: SHELL_TEST,
    /*
     * ── 期望的失败**不是**某条用例，而是整个文件无法解析 ──
     *
     * 反引号提前结束了 `String.raw` 模板，于是那个 `.ts` 模块本身就是
     * 语法错误 —— vitest 连测试都收不上来（报 FAIL <整个文件>）。
     *
     * 这正是该缺陷的真实形态：**整页交互全死**，而不是"某一条断言变红"。
     * 因此判据落在"文件级失败"上，而不是硬凑一个用例名。
     */
    expectTestName: /FAIL\s+tests\/course-a3-workbench\.test\.ts|Transform failed|PARSE_ERROR|Unterminated/,
  },
  {
    id: "M10",
    guard: "内容快照必须**逐文件**校验（同尺寸替换可绕过总字节数判据）",
    file: RECOVERY,
    /*
     * ── 缺陷形态：只比较总字节数 ──
     *
     * 两个文件互换内容、或一个文件被**同尺寸**替换，总字节数完全不变。
     * 若完整性判据只看总量，它会把一份内容已经不对的快照判成"完好"，
     * 于是恢复出一份**与预期不同**的课程包而没有任何报错。
     *
     * 本变异把逐文件比对退化成"只看总字节数"；`course-a3-recovery.test.ts`
     * 里那两条"同尺寸篡改 / 内容互换"的用例必须变红。
     */
    from: `  const ok =
    missing.length === 0 &&
    unexpected.length === 0 &&
    sizeMismatch.length === 0 &&
    checksumMismatch.length === 0 &&
    recomputedDigest === manifest.digest;`,
    to: `  // 变异 M10：只看总字节数（缺陷形态：同尺寸替换不被发现）
  const ok = actual.reduce((sum, entry) => sum + entry.bytes, 0) === manifest.totalBytes;`,
    testFile: RECOVERY_TEST,
    expectTestName: /同尺寸|校验和|互换/,
  },
  {
    id: "M11",
    guard: "替换数据库前必须让 SQLite 收拢 WAL，**不得**自己删 -wal/-shm",
    file: WAL_RECOVERY,
    /*
     * ── 缺陷形态：直接删掉 WAL 边车 ──
     *
     * 这正是本任务要修的原始缺陷：`replaceFileAtomic` 在 rename 之前
     * `rmSync` 掉 `-wal`/`-shm`。
     *
     * SQLite 官方 WAL 文档明确写："If a database file is separated from its
     * WAL file, then transactions that were previously committed to the
     * database might be lost, or the database file might become corrupted."
     *
     * 本变异把 `settleWalBeforeReplace` 的"打开-关闭让 SQLite 收拢"换成
     * "直接把边车删掉"。此时 `course-a3-wal-recovery.test.ts` 里那几条
     * 依赖"WAL 中已提交事务不丢"的用例必须变红。
     *
     * ── 为什么这条变异特别重要 ──
     *
     * 删 WAL **不会报错**，而且大多数时候数据看起来还在（因为多数情况下
     * WAL 是空的）。只有当存在"异常退出后残留 WAL"时它才丢数据 ——
     * 那正是最难被人工发现、也最需要门禁的时刻。
     */
    from: `  let db: DatabaseSync | null = null;
  let checkpointLog = 0;
  let checkpointed = 0;`,
    to: `  // 变异 M11：还原原始缺陷 —— 直接把边车删掉，而不是让 SQLite 收拢
  for (const suffix of ["-wal", "-shm"]) {
    const path = \`\${dbPath}\${suffix}\`;
    if (existsSync(path)) {
      try {
        rmSync(path, { force: true });
      } catch {
        /* 忽略 */
      }
    }
  }
  return {
    ok: true,
    before,
    after: inspectSidecars(dbPath),
    detail: "变异：已删除 WAL 边车",
    error: null,
  };

  let db: DatabaseSync | null = null;
  let checkpointLog = 0;
  let checkpointed = 0;`,
    testFile: WAL_RECOVERY_TEST,
    expectTestName: /收拢|已提交事务|活动连接/,
  },
];

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * 施加变异：锚点必须**恰好命中一次**。
 *
 * 命中 0 次说明源码已变（锚点过期）；命中多于 1 次说明判据不唯一 ——
 * 那时"变红"无法归因到这一处，因此必须失败而不是随便挑一个替换。
 *
 * ── 为什么锚点要**容忍换行符差异** ──
 *
 * 本仓库的文件里同时存在 LF 与 CRLF（不同工具写入的结果，实测确认：
 * `review.ts` / `adjudication.ts` / `db/client.ts` 是 CRLF，而
 * `course-a3.ts` / `a3-client-script.ts` 是 LF）。
 *
 * 若锚点写死一种换行，换行不同的那几个文件就会"锚点无效" ——
 * 而那种失败会被误读成"源码已变、需要更新锚点"，掩盖真正的原因。
 * 因此这里把锚点与源码**都归一成 LF** 再匹配，替换后保持文件原有风格。
 */
function applyMutation(mutation: Mutation): { applied: boolean; hits: number } {
  const path = join(REPO_ROOT, mutation.file);
  const original = readFileSync(path, "utf8");
  const usesCrlf = original.includes("\r\n");

  // 归一成 LF 做匹配（锚点也按 LF 写）
  let normalized = original.replace(/\r\n/g, "\n");

  // 主替换 + 全部附加替换：每一对都必须恰好命中一次
  const pairs = [{ from: mutation.from, to: mutation.to }, ...(mutation.also ?? [])];
  for (const pair of pairs) {
    const parts = normalized.split(pair.from);
    const hits = parts.length - 1;
    if (hits !== 1) return { applied: false, hits };
    normalized = parts.join(pair.to);
  }

  // 还原文件原有的换行风格 —— 否则"恢复后 sha256 一致"这条判据会因为
  // 换行被就地改写而失败，而那与变异本身无关。
  writeFileSync(path, usesCrlf ? normalized.replace(/\n/g, "\r\n") : normalized, "utf8");
  return { applied: true, hits: 1 };
}

function restore(path: string, original: string): boolean {
  try {
    writeFileSync(path, original, "utf8");
    return true;
  } catch {
    return false;
  }
}

function runVitest(testFile: string): { exitCode: number; output: string } {
  /*
   * 用 vitest 的**默认** reporter（`--reporter=basic` 在 vitest 5 已不存在，
   * 指定它会以"无法加载 reporter 模块"失败，那会让基线检查误判为"基线不绿"）。
   */
  const result = spawnSync(
    process.execPath,
    ["node_modules/vitest/vitest.mjs", "run", testFile],
    { cwd: REPO_ROOT, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } },
  );
  return { exitCode: result.status ?? 1, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

function firstFailureLine(output: string): string {
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("FAIL") || trimmed.startsWith("×") || trimmed.includes("AssertionError")) {
      return trimmed.slice(0, 170);
    }
  }
  return "";
}

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
  /** 该变异是否达到了它**自己声明**的预期（被捕获 / 或保持绿）。 */
  expectationMet: boolean;
}

function main(): void {
  console.log("A3 受控课程接入 · 受控红/绿变异证明");
  console.log("（只跑 vitest；不起 HTTP 服务器；不读真实材料）");
  console.log("");

  // 逐文件记录基线字节
  const baseline = new Map<string, { text: string; sha: string }>();
  for (const file of [A3_SERVICE, BACKUP_PRIMITIVES, RECOVERY, WAL_RECOVERY, REVIEW, ADJUDICATION, CLIENT_SCRIPT, DB_CLIENT]) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    baseline.set(file, { text, sha: sha256(text) });
  }

  // 变异前先确认目标用例是**绿**的（否则"变红"没有意义）
  console.log("基线复绿检查（变异之前）");
  for (const testFile of [A3_TEST, SHELL_TEST, RECOVERY_TEST, WAL_RECOVERY_TEST]) {
    const result = runVitest(testFile);
    const green = result.exitCode === 0;
    console.log(`  ${green ? "✓" : "✗"} ${testFile} 基线为绿`);
    if (!green) {
      console.log("    基线不绿 ⇒ 无法进行变异证明。先修好基线。");
      process.exitCode = 1;
      return;
    }
  }

  const results: MutationResult[] = [];

  for (const mutation of MUTATIONS) {
    console.log("");
    console.log(`${mutation.id} · ${mutation.guard}`);
    const path = join(REPO_ROOT, mutation.file);
    const base = baseline.get(mutation.file)!;

    const { applied, hits } = applyMutation(mutation);
    if (!applied) {
      console.log(`  ✗ 锚点无效（命中 ${hits} 次，需恰好 1 次）—— 源码已变，请更新本脚本的锚点`);
      restore(path, base.text);
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
        expectationMet: false,
      });
      continue;
    }

    const mutated = runVitest(mutation.testFile);
    const caught = mutated.exitCode !== 0;
    const failedTestMatched = mutation.expectTestName.test(mutated.output);
    const reasonSnippet = firstFailureLine(mutated.output);

    /*
     * ── 每个变异的"通过"定义取决于它期望什么 ──
     *
     * - 普通变异：**必须被捕获**（用例变红），且红在预期的位置。
     * - `expectNotCaught` 变异：**必须保持绿** —— 它证明的是
     *   "另一道判据确实独立地兜住了"，那是一条正面结论，不是漏检。
     *
     * 两种都必须还原后逐字节一致并复绿。
     */
    const expectationMet = mutation.expectNotCaught ? !caught : caught && failedTestMatched;

    if (mutation.expectNotCaught) {
      console.log(
        `  ${!caught ? "✓" : "✗"} ${
          !caught ? "保持绿（另一道判据独立兜住 —— 纵深防御成立）" : "**意外变红**（说明两道判据并不独立）"
        }`,
      );
      if (caught && reasonSnippet) console.log(`      ${reasonSnippet}`);
    } else {
      console.log(`  ${caught ? "✓" : "✗"} ${caught ? "被捕获（用例变红）" : "**未被捕获**（门禁失效）"}`);
      console.log(`  ${failedTestMatched ? "✓" : "✗"} 失败落在预期用例（${mutation.expectTestName}）`);
      if (reasonSnippet) console.log(`      ${reasonSnippet}`);
    }

    restore(path, base.text);
    const restoredByteIdentical = sha256(readFileSync(path, "utf8")) === base.sha;
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
      expectationMet,
    });
  }

  console.log("");
  console.log("汇总");
  const okCount = results.filter(
    (r) => r.applied && r.expectationMet && r.restoredByteIdentical && r.greenAfterRestore,
  ).length;
  for (const result of results) {
    const ok = result.applied && result.expectationMet && result.restoredByteIdentical && result.greenAfterRestore;
    console.log(`  ${ok ? "✓" : "✗"} ${result.id} ${result.guard}`);
  }
  console.log("");
  console.log(`结果：${okCount} / ${results.length} 个变异符合各自预期并逐字节恢复`);
  console.log(
    "（其中标注「保持绿」的变异证明的是纵深防御：单独破坏一条判据时另一条仍然兜住。）",
  );

  let allBaselineIdentical = true;
  for (const [file, base] of baseline) {
    const finalSha = sha256(readFileSync(join(REPO_ROOT, file), "utf8"));
    const same = finalSha === base.sha;
    if (!same) allBaselineIdentical = false;
    console.log(`  ${same ? "✓" : "✗"} ${file} sha256 ${same ? "与基线一致" : "**与基线不一致（异常！）**"}`);
  }

  if (!allBaselineIdentical) process.exitCode = 1;
  if (okCount !== results.length) process.exitCode = 1;
}

main();
