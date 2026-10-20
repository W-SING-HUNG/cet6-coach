#!/usr/bin/env node
/**
 * E2E 专用服务器启动器（第二个实例：内容库**为空**）。
 *
 * 存在的唯一理由：验证「私有内容库为空」时的诚实空状态。
 *
 * 内容根是进程级环境变量，无法在浏览器里切换，因此必须有一个真实的空内容根实例。
 * 若在同一个实例里用一个"假装没数据"的分支去测，测到的就只是那行分支代码，
 * 而不是产品在真实空库下的行为 —— 那正是本次要证明的东西。
 *
 * 与主实例共用同一台机器、不同端口与不同数据库，互不干扰。
 * 此处**不写任何试卷包**：目录刻意不存在，覆盖"连目录都没有"这个分支。
 */

import { existsSync, rmSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { E2E_EMPTY_DB_PATH, E2E_EMPTY_PORT, E2E_EMPTY_CONTENT_ROOT } from "../e2e/config";
import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { spawnNext } from "./spawn-next";

if (process.env.E2E_RESET_DB === "1") {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${E2E_EMPTY_DB_PATH}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  // 明确删掉内容根：本实例要验证的正是"目录都不存在"
  rmSync(E2E_EMPTY_CONTENT_ROOT, { recursive: true, force: true });
}

mkdirSync(dirname(E2E_EMPTY_DB_PATH), { recursive: true });

process.env.CET6_CONTENT_ROOT = join(E2E_EMPTY_CONTENT_ROOT, "not-created");
process.env.CET6_DB_PATH = E2E_EMPTY_DB_PATH;
process.env.PORT = String(E2E_EMPTY_PORT);

console.log(`[e2e-server-empty] 内容根（刻意不存在）: ${process.env.CET6_CONTENT_ROOT}`);
console.log(`[e2e-server-empty] DB: ${E2E_EMPTY_DB_PATH}`);
console.log(`[e2e-server-empty] PORT: ${E2E_EMPTY_PORT}`);

// 只绑定回环：合成实例绝不对局域网开放（集中边界见 src/proxy.ts）
// CET6_LOCAL_ORIGIN 让"精确同一来源"守卫知道本实例的可信来源
const result = spawnNext("start", E2E_EMPTY_PORT, {
  stdio: "inherit",
  env: { ...process.env, CET6_LOCAL_ORIGIN: `http://${LOOPBACK_HOST}:${E2E_EMPTY_PORT}` },
});

process.exit(result.status ?? 0);
