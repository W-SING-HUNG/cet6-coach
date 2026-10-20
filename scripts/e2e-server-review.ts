#!/usr/bin/env node
/**
 * **仅用于视觉评审**的服务器启动器（端口 3220）。
 *
 * ── 为什么需要它（而不是复用现有实例）──
 * 现有两个实例都不适合出"可提交的评审证据"：
 *
 * · 主 E2E 实例（3199）的夹具篇章只有一句 `"Fixture careful-reading passage."`。
 *   那种文本量级**拍不出有意义的布局证据** —— 分栏比例、段落换行、
 *   长选项折行、长文滚动、粘性头尾是否遮挡，全都需要接近真实的文本量。
 * · 真实试卷实例（3210）能拍出真实布局，但它的截图**含真题正文**，
 *   因此不能提交进 Git（内容门禁；`tests/architecture.test.ts` 有指纹守卫）。
 *
 * 因此这里用**长文本合成夹具**（`buildFixturePackage({ longForm: true })`）
 * 拍一套既接近真实布局、又**可以安全提交**的截图。
 *
 * ── 隔离保证（四条）──
 * 1. **独立内容根** `.e2e/review-content`（不是 `private-content/`，
 *    也不是主实例的 `.e2e/content`）。
 * 2. **独立数据库** `.e2e/cet6-review.db`（不碰 `data/cet6.db`）。
 * 3. 内容 `sourceKind` 由 `TEST_FIXTURE_SOURCE_KIND` **写死**为 `test_fixture`，
 *    界面上有显眼的「测试夹具」徽标 —— 不可能冒充真题。
 * 4. 使用**镜像端口 3220**，不与 3199 / 3200 / 3210 冲突，
 *    因此其余门禁可以同时运行。
 *
 * 它**不写入任何生产路径**，也不修改 `private-content/`。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { E2E_REVIEW_DB_PATH, E2E_REVIEW_PORT, E2E_REVIEW_CONTENT_ROOT } from "../e2e/config";
import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { spawnSync } from "node:child_process";
import { spawnNext } from "./spawn-next";
import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";

// ------------------------------------------------------------------ 清库
if (process.env.E2E_RESET_DB === "1") {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${E2E_REVIEW_DB_PATH}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  rmSync(E2E_REVIEW_CONTENT_ROOT, { recursive: true, force: true });
}
mkdirSync(dirname(E2E_REVIEW_DB_PATH), { recursive: true });
mkdirSync(E2E_REVIEW_CONTENT_ROOT, { recursive: true });

process.env.CET6_CONTENT_ROOT = E2E_REVIEW_CONTENT_ROOT;
process.env.CET6_DB_PATH = E2E_REVIEW_DB_PATH;

// ------------------------------------------------- 写入**长文本**夹具并导入
/*
 * 只写一份卷子：视觉评审关心的是布局，不是"库里有几份试卷"。
 * 多一份只会让 /practice 的列表更长，不会增加布局信息。
 */
const fixture = buildFixturePackage({
  id: "fixture-cet6-2024-12-set1-review",
  year: 2024,
  session: "December",
  variant: "set1",
  longForm: true,
});
writeFixturePackage(E2E_REVIEW_CONTENT_ROOT, "2024-December-set1-review", fixture);

const { getRepositories } = await import("@/repositories/sqlite");
const { runImport } = await import("@/services/paper-import");

const imported = runImport(getRepositories(), { dryRun: false });
console.log(`[review-server] 内容根: ${E2E_REVIEW_CONTENT_ROOT}`);
console.log(`[review-server] 长文本夹具导入: 写入 ${imported.written} 份`);
if (!imported.ok || imported.report.counts.rejected > 0) {
  console.error(`[review-server] 夹具导入失败`);
  process.exit(1);
}

// --------------------------------------------------- onboarding + 诊断
/*
 * 必须完成这两步，否则 `/today`、`/progress`、`/review` 会重定向到
 * onboarding / 诊断页，评审截图就会拍到别的页面（实测踩过：
 * 真实实例只做 onboarding，`/today` 拍到的是诊断页）。
 * 复用既有的 seed 脚本，不新写一套状态构造逻辑。
 */
for (const script of ["seed-onboard.ts", "seed-diagnostic.ts"]) {
  console.log(`[review-server] 构造评审状态：${script}`);
  const step = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", `scripts/${script}`],
    { stdio: "inherit", env: process.env },
  );
  if (step.status !== 0) {
    console.error(`[review-server] ${script} 失败`);
    process.exit(1);
  }
}

// ------------------------------------------------------------------ 启动
console.log(`[review-server] DB: ${E2E_REVIEW_DB_PATH}`);
console.log(`[review-server] PORT: ${E2E_REVIEW_PORT}`);

// 只绑定回环：合成实例绝不对局域网开放（集中边界见 src/proxy.ts）
// CET6_LOCAL_ORIGIN 让"精确同一来源"守卫知道本实例的可信来源
const result = spawnNext("start", E2E_REVIEW_PORT, {
  stdio: "inherit",
  env: { ...process.env, CET6_LOCAL_ORIGIN: `http://${LOOPBACK_HOST}:${E2E_REVIEW_PORT}` },
});
process.exit(result.status ?? 0);
