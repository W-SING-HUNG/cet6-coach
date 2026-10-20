#!/usr/bin/env node
/**
 * E2E 专用服务器启动器（主实例：内容库有夹具试卷）。
 *
 * 职责：
 * 1. 需要时清空 E2E 数据库（E2E_RESET_DB=1），保证"首次进入"断言从干净状态开始。
 * 2. 在测试内容根下**用夹具构造器**写出试卷包并导入索引 ——
 *    这样浏览器验证的是真实的「发现 → 校验 → 导入 → 浏览」链路，
 *    而不是只把数据塞进数据库。
 * 3. 以生产构建（next start）启动，端口与数据库由 e2e/config.ts 指定。
 *
 * 为什么不在测试内做导入：Playwright 的 webServer 必须在测试开始前就绪，
 * 而页面需要能读到数据。放在这里既保证顺序，也避免测试之间互相依赖。
 *
 * 重要：这里写入的每一份试卷 `sourceKind` 恒为 `test_fixture`。
 * 夹具构造器在类型层面就不允许改它，因此"夹具冒充真题"不可能发生。
 */

import { existsSync, rmSync, mkdirSync } from "node:fs";
import {
  E2E_DB_PATH,
  E2E_PORT,
  E2E_CONTENT_ROOT,
  E2E_FIXTURE_PAPERS,
} from "../e2e/config";
import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";
import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { spawnNext } from "./spawn-next";

// ------------------------------------------------------------------ 清库
if (process.env.E2E_RESET_DB === "1") {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${E2E_DB_PATH}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  rmSync(E2E_CONTENT_ROOT, { recursive: true, force: true });
}
mkdirSync(E2E_CONTENT_ROOT, { recursive: true });

// ------------------------------------------------------- 写入夹具并导入
process.env.CET6_CONTENT_ROOT = E2E_CONTENT_ROOT;
process.env.CET6_DB_PATH = E2E_DB_PATH;

for (const paper of E2E_FIXTURE_PAPERS) {
  const fixture = buildFixturePackage({
    id: paper.id,
    year: paper.year,
    session: paper.session,
    variant: paper.variant,
  });
  writeFixturePackage(E2E_CONTENT_ROOT, `${paper.year}-${paper.session}-${paper.variant}`, fixture);
}

const { getRepositories } = await import("@/repositories/sqlite");
const { runImport } = await import("@/services/paper-import");

const imported = runImport(getRepositories(), { dryRun: false });
console.log(`[e2e-server] 内容根: ${E2E_CONTENT_ROOT}`);
console.log(
  `[e2e-server] 夹具导入: 写入 ${imported.written} 份（发现 ${imported.report.discovered} 份，` +
    `拒绝 ${imported.report.counts.rejected} 份）`,
);
if (!imported.ok) {
  console.error(`[e2e-server] 夹具导入失败：${imported.error}`);
  process.exit(1);
}
if (imported.report.counts.rejected > 0) {
  for (const entry of imported.report.entries) {
    if (entry.decision !== "rejected") continue;
    console.error(`[e2e-server] 夹具被拒 ${entry.packagePath}：`);
    for (const issue of entry.issues) console.error(`  ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}

// ------------------------------------------------------------------ 启动
console.log(`[e2e-server] DB: ${E2E_DB_PATH}`);
console.log(`[e2e-server] PORT: ${E2E_PORT}`);

// 使用 stdio: inherit，避免自动化运行器的管道限制；Next 自身会输出就绪日志
// 只绑定回环：合成实例绝不对局域网开放（集中边界见 src/proxy.ts）
// CET6_LOCAL_ORIGIN 让"精确同一来源"守卫知道本实例的可信来源（端口不同 ⇒ 不同源）
// 遥测设置由 spawnNext 统一注入（见 scripts/spawn-next.ts）
const result = spawnNext("start", E2E_PORT, {
  stdio: "inherit",
  env: { CET6_LOCAL_ORIGIN: `http://${LOOPBACK_HOST}:${E2E_PORT}` },
});

process.exit(result.status ?? 0);
