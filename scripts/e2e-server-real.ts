#!/usr/bin/env node
/**
 * 本地真实试卷冒烟专用服务器启动器（端口 3210）。
 *
 * 为什么需要它：`e2e/real-paper.local.spec.ts` 要验证**真实内容链路**
 * （真实包 → 真实索引 → 浏览器渲染 → 真实音频端点）。这不能用 E2E 夹具实例承担 ——
 * 那个实例的内容根指向 `.e2e/content`，里面只有 `test_fixture` 包。
 *
 * 本启动器因此：
 * 1. 使用**独立数据库** `.e2e/cet6-real.db`，绝不碰日常库 `data/cet6.db`；
 * 2. 使用真实内容根 `private-content/`，并把其中全部真实包导入索引；
 * 3. 完成 onboarding（否则页面会重定向到 onboarding，冒烟无法进行）；
 * 4. 以生产构建启动（`next start`）。
 *
 * **它不修改任何私有内容** —— 只读取 `private-content/cet6/papers/` 并写独立的索引库。
 * 若该目录不存在或为空，服务器仍会启动，冒烟 spec 会整体跳过（不会让套件变红）。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { E2E_REAL_DB_PATH, E2E_REAL_PORT } from "../e2e/config";
import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { telemetryOffEnv } from "./next.mjs";

/**
 * 本启动器的子进程环境。
 *
 * 带上 `NEXT_TELEMETRY_DISABLED`（仓库统一入口，见 `scripts/next.mjs`）——
 * 包括这里 import 真实内容的子进程：它们最终都会起 Next，
 * 因此都属于"遥测旁路审计"的范围（本轮 P1-T 第 9 条）。
 */
const env = {
  ...process.env,
  ...telemetryOffEnv(),
  CET6_DB_PATH: E2E_REAL_DB_PATH,
  CET6_CONTENT_ROOT: join(process.cwd(), "private-content"),
};
const DB = E2E_REAL_DB_PATH;

// ------------------------------------------------------------------ 清库
if (process.env.E2E_RESET_DB === "1") {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${DB}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
}
mkdirSync(dirname(DB), { recursive: true });

// ------------------------------------------------------------------ 导入真实包

console.log("[real-paper-server] 导入真实试卷索引…");
const imported = spawnSync(
  process.execPath,
  ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", "scripts/content-import.ts", "--commit"],
  { stdio: "inherit", env },
);
if (imported.status !== 0) {
  console.warn("[real-paper-server] 导入未成功（可能内容库为空）；冒烟 spec 将整体跳过。");
}

// ------------------------------------------------------------------ onboarding
console.log("[real-paper-server] 确保 onboarding 已完成…");
const onboard = spawnSync(
  process.execPath,
  ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", "scripts/seed-onboard.ts"],
  { stdio: "inherit", env },
);
if (onboard.status !== 0) {
  console.warn("[real-paper-server] onboarding 未成功；冒烟 spec 可能整体跳过。");
}

// ------------------------------------------------------------------ 启动
console.log(`[real-paper-server] 启动生产服务（端口 ${E2E_REAL_PORT}）…`);
/*
 * 走仓库统一入口（`scripts/next.mjs`）而不是裸 next bin：
 * 那样才会带 `NEXT_TELEMETRY_DISABLED`。真实内容实例同样在
 * 遥测旁路审计范围内（本轮 P1-T 第 9 条）。
 */
const server = spawnSync(
  process.execPath,
  ["scripts/next.mjs", "start", "-H", LOOPBACK_HOST, "-p", String(E2E_REAL_PORT)],
  { stdio: "inherit", env },
);
process.exit(server.status ?? 0);
