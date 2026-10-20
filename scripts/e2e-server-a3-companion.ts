#!/usr/bin/env node
/**
 * **A3 课程伴随界面**实例启动器（端口 3286，Next.js 应用）。
 *
 * ── 为什么它必须是**独立的一个启动器**，而不是在 `web-servers.ts` 里写一行 `next start` ──
 *
 * 本仓库有两条已登记的架构纪律，写一行内联命令会同时违反它们：
 *
 * 1. **每个会起 Next 的启动器都必须走 `spawnNext`**（统一注入
 *    `NEXT_TELEMETRY_DISABLED` + 回环绑定）。内联 `next start` 会绕开那套设置 ——
 *    而它正是 `tests/architecture.test.ts` 的 P1-T 门禁在守的东西。
 * 2. **每个默认注册的合成实例都必须被隐私门禁逐一证明过内容根安全**。
 *    那份清单从 `scripts/e2e-server*.ts` 推导，内联命令解析出的
 *    `scripts/next.mjs` 不在清单里 ⇒ 它逃过了"启动器内部不得把内容根
 *    指向私有内容"这条判据（实测确实被门禁抓到）。
 *
 * ── 它与 A3 工作台实例的关系 ──
 *
 * 两者指向**同一份**数据库与内容根，但**不是**同一个进程：
 * 工作台是回环 Node 服务（`e2e-server-a3.ts`），本实例是产品自己的 Next 应用。
 * 因此"工作台写下的东西，产品界面真的读得到"是一条**跨进程**被检验的性质。
 *
 * ── 隔离 ──
 *
 * 独立端口 3286；内容根与数据库来自 `e2e/config.ts` 的 A3 常量
 * （`.e2e/a3-content` / `.e2e/cet6-a3.db`）。它**不碰** `private-content/`，
 * 也**不碰** `data/cet6.db`。
 */

import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { spawnNext } from "./spawn-next";
import { E2E_A3_COMPANION_PORT } from "../e2e/config";

/*
 * 数据库路径与内容根**刻意不从环境变量读取**，而是由启动器显式设置 ——
 * 因为 Playwright 的 webServer env 与这里可能不一致，而"这个实例读哪个库"
 * 是本文件的核心契约。显式设置让它在任何调用方式下都成立。
 */
if (!process.env.CET6_DB_PATH) {
  const { E2E_A3_DB_PATH, E2E_A3_CONTENT_ROOT } = await import("../e2e/config");
  process.env.CET6_DB_PATH = E2E_A3_DB_PATH;
  process.env.CET6_CONTENT_ROOT = E2E_A3_CONTENT_ROOT;
}

console.log(`[a3-companion] PORT: ${E2E_A3_COMPANION_PORT}`);
console.log(`[a3-companion] DB: ${process.env.CET6_DB_PATH}`);
console.log(`[a3-companion] CONTENT_ROOT: ${process.env.CET6_CONTENT_ROOT}`);

/*
 * 只绑定回环；`CET6_LOCAL_ORIGIN` 让"精确同一来源"守卫知道本实例的可信来源。
 * 遥测设置由 `spawnNext` 统一注入（见 `scripts/spawn-next.ts`）。
 */
const result = spawnNext("start", E2E_A3_COMPANION_PORT, {
  stdio: "inherit",
  env: { CET6_LOCAL_ORIGIN: `http://${LOOPBACK_HOST}:${E2E_A3_COMPANION_PORT}` },
});
process.exit(result.status ?? 0);
