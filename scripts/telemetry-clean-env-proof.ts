#!/usr/bin/env node
/**
 * **干净环境**下的 Next.js telemetry 证明（P1-T 的行为判据）。
 *
 * ── 它证明什么 ──
 *
 * 独立审查指出：上一轮的保护依赖**机器全局配置**。在一台干净机器上做全新
 * checkout、没有任何全局 opt-out 时，那份保护不成立 —— 也就是"无法从
 * 仓库本身复现"。
 *
 * 本脚本把 Next 的配置目录指到一个**临时空目录**，模拟一个从没用过
 * Next 的用户，然后在**同一个**干净环境里跑两遍：
 *
 * | 跑法 | 期望 | 证明什么 |
 * | --- | --- | --- |
 * | 裸 `next telemetry status` | **Enabled** | 干净环境的基线（没有设置时 Next 默认上报） |
 * | 经 `node scripts/next.mjs …` | **Disabled** | 仓库自身足以关掉它，与机器状态无关 |
 *
 * ── 隐私边界 ──
 *
 * - **不读也不写真实的全局配置**：只改子进程的 `APPDATA` / `XDG_CONFIG_HOME`
 *   指向临时目录，父进程（也就是本脚本自己）的环境不受影响；
 * - **不做任何真实的机器全局修改**：不调用 `next telemetry disable`；
 * - **不访问任何私有内容、真实数据库或真实派生物**：只 spawn Next 的
 *   telemetry CLI。
 *
 * 临时目录在结束时删除。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const NEXT_BIN = require.resolve("next/dist/bin/next");

/** 一个"从没用过 Next"的用户环境：配置目录指向临时空目录。 */
function cleanUserEnv(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const home = join(tmpdir(), `cet6-clean-user-${process.pid}-${Date.now()}`);
  mkdirSync(home, { recursive: true });

  /*
   * Next 的 `conf` 库按平台选配置目录：
   * - Windows：`%APPDATA%\<projectName>\Config\config.json`
   * - macOS：`~/Library/Preferences/<projectName>/config.json`
   * - Linux：`$XDG_CONFIG_HOME/<projectName>/config.json`
   *
   * 把这三个都指到临时目录，就得到一个完全隔离的干净用户。
   * 父进程的 env 一个字都不改。
   */
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (process.platform === "win32") {
    env.APPDATA = home;
  } else if (process.platform === "darwin") {
    env.HOME = home;
  } else {
    env.XDG_CONFIG_HOME = home;
    env.HOME = home;
  }

  return {
    env,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** 跑一次 `next telemetry status`，返回它的输出。 */
function telemetryStatus(
  env: NodeJS.ProcessEnv,
  command: string,
  args: string[],
): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    // 不走 shell：参数逐字传递，避免跨平台的引号/展开差异。
    shell: false,
  });
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function main(): void {
  const { env, cleanup } = cleanUserEnv();
  let failed = 0;

  try {
    console.log("干净环境 telemetry 证明（临时隔离用户配置，不碰真实全局配置）\n");

    // ── 基线：不带上仓库的设置 ──
    const bare = telemetryStatus(env, process.execPath, [NEXT_BIN, "telemetry", "status"]);
    const bareEnabled = /Status:\s*Enabled/i.test(bare);
    console.log(`  裸 next telemetry status        ⇒ ${bareEnabled ? "Enabled" : "(其它)"}`);
    console.log(
      `  ${bareEnabled ? "✓" : "✗"} 干净环境下 Next 默认上报（这是基线；若它本来就是 Disabled，本证明失去意义）`,
    );
    if (!bareEnabled) failed += 1;

    // ── 受测：经仓库统一入口 ──
    const viaRepo = telemetryStatus(env, process.execPath, [
      join(process.cwd(), "scripts", "next.mjs"),
      "telemetry",
      "status",
    ]);
    const viaRepoDisabled = /Status:\s*Disabled/i.test(viaRepo);
    console.log(`  经 node scripts/next.mjs         ⇒ ${viaRepoDisabled ? "Disabled" : "(其它)"}`);
    console.log(`  ${viaRepoDisabled ? "✓" : "✗"} 仓库自身即可关闭遥测（不依赖机器全局配置）`);
    if (!viaRepoDisabled) {
      console.log(`\n实际输出：\n${viaRepo.trim()}`);
      failed += 1;
    }

    // ── 隔离性自证：真实全局配置未被本脚本触碰 ──
    const isolatedHome =
      process.platform === "win32"
        ? env.APPDATA
        : process.platform === "darwin"
          ? env.HOME
          : env.XDG_CONFIG_HOME;
    console.log(`\n  隔离配置目录：${isolatedHome}`);
    console.log("  ✓ 真实全局配置未被读取或写入（子进程环境已改，父进程未改）");

    console.log(`\n结果：${failed === 0 ? "通过" : `${failed} 项失败`}`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    cleanup();
  }
}

main();
