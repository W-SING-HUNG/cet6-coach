/**
 * 合成 E2E 启动器共用的**进程启动**辅助。
 *
 * ── 它解决的两个问题 ──
 *
 * 1. **回环绑定**（P0-1）：每个启动器都要 `-H 127.0.0.1`，
 *    而那必须是**一个字面量**（`LOOPBACK_HOST`），不能各自写一遍。
 * 2. **遥测关闭**（本轮 P1-T）：每个启动器都会 spawn 一个真实的
 *    `next start`。若这里不带 `NEXT_TELEMETRY_DISABLED`，那些进程
 *    就绕过了仓库的遥测保护 —— 而这正是独立审查指出的
 *    "审计合成 web 启动器与相关子进程的旁路"。
 *
 * 因此本模块是启动器 spawn Next 的**唯一入口**：
 * 既统一绑定参数，也统一注入遥测设置。两个保证都有架构门禁守着。
 */

import { spawnSync } from "node:child_process";
import { telemetryOffEnv } from "./next.mjs";

/** 本机回环绑定地址（唯一字面量来源：`src/lib/loopback-guard.ts`）。 */
export const LOOPBACK_HOST = "127.0.0.1";

/**
 * spawn 一个真实的 `next` 进程，带回环绑定与遥测关闭。
 *
 * @param subcommand `start` 或 `dev`
 * @param port 监听端口
 * @param options 其余 spawn 选项（cwd / stdio / env 等）
 *
 * ── env 合并顺序是**硬约束** ──
 *
 * `telemetryOffEnv()` 必须**最后**合并，因此调用方传什么都不能把它盖掉。
 *
 * 上一版把 `...options.env` 放在最后，于是调用方只要传
 * `NEXT_TELEMETRY_DISABLED: undefined`（或 `"0"`）就能关掉保护 ——
 * 而那正是一个"看起来无害的选项"变成旁路的形态。遥测设置是**强制项**，
 * 不是可覆盖的默认值，因此顺序必须反映这一点。
 */
export function spawnNext(
  subcommand: "start" | "dev",
  port: number,
  options: {
    stdio?: "inherit" | "ignore" | "pipe";
    env?: Record<string, string | undefined>;
    cwd?: string;
  } = {},
) {
  return spawnSync(
    process.execPath,
    ["scripts/next.mjs", subcommand, "-H", LOOPBACK_HOST, "-p", String(port)],
    {
      stdio: options.stdio ?? "inherit",
      cwd: options.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...options.env,
        // 强制项放最后：调用方无法覆盖（见上面的说明）。
        ...telemetryOffEnv(),
      },
    },
  );
}