#!/usr/bin/env node
/**
 * **Next.js 命令的统一入口** —— 仓库自带的遥测关闭层。
 *
 * ── 它解决的问题（独立审查 P1）──
 *
 * 上一轮的门禁断言"Next.js telemetry 已关闭"，但它读的是
 * **机器全局配置**（`%APPDATA%/nextjs-nodejs/Config/config.json`）。
 *
 * 于是出现一个真实的失效场景：在一台干净的机器上做全新 checkout，
 * 没有任何全局 opt-out —— 门禁**失败**，而仓库本身什么都没做错。
 * 换句话说，那份保护**无法从仓库本身复现**。
 *
 * 更糟的是，要"修好"它，使用者 必须手动跑一条
 * 机器全局命令（`next telemetry disable`）。而本轮任务书明确禁止
 * 要求 使用者 做这件事、也禁止修改全局系统配置。
 *
 * ── 修法：把设置放进仓库，让每次调用都带上 ──
 *
 * Next.js 官方支持的关闭方式是环境变量 `NEXT_TELEMETRY_DISABLED`。
 * 官方文档：https://nextjs.org/telemetry
 *
 * 已验证的取值逻辑（`next/dist/telemetry/storage.js` 第 252/291 行）：
 *
 *   const { NEXT_TELEMETRY_DISABLED } = process.env;
 *   get isDisabled() {
 *     if (!!this.NEXT_TELEMETRY_DISABLED || !this.conf) return true;   // ← 短路
 *     return this.conf.get(TELEMETRY_KEY_ENABLED, true) === false;
 *   }
 *
 * 注意第一行：env 为真时**直接短路**，根本不读全局配置。
 * 因此 env 方式完全独立于机器状态 —— 这正是"仓库自足"需要的性质。
 *
 * ── 为什么不用 `telemetry: false` 写进 `next.config.ts` ──
 *
 * 因为那**不是**一个受支持的选项。Next 16 的 `NextConfig` 类型里没有
 * `telemetry` 字段（本轮已核对官方 `next.config.js` 文档与安装的类型定义）。
 * 写一个不存在的配置项不会报错，只会静默无效 —— 那比不写更糟：
 * 它会让人以为保护已经就位。
 *
 * ── 为什么需要这个 wrapper 而不是直接在 npm script 里写 `VAR=1` ──
 *
 * 因为 `VAR=1 next dev` 这种写法在 Windows 的 `cmd`/`powershell` 下
 * **不成立**，而本仓库在 Windows 上开发。要跨平台就只有两条路：
 * 引入 `cross-env` 依赖，或者用 Node 自己设 env 再 spawn。
 * 任务书要求不引入不必要依赖，因此选后者。
 *
 * ── 它同时是"遥测设置只有一处"的保证 ──
 *
 * 所有 Next 调用（`dev` / `build` / `start` / `telemetry status` /
 * Playwright 的 webServer / 各 E2E 启动器）都走这里，
 * 因此"哪条路径漏了设置"是一个可以被测试检查的问题，
 * 而不是靠人记得。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/** 本仓库要求的遥测设置（**唯一实现**）。 */
export const TELEMETRY_OFF_ENV = "NEXT_TELEMETRY_DISABLED";

/** 给子进程注入的环境补丁。 */
export function telemetryOffEnv() {
  return { [TELEMETRY_OFF_ENV]: "1" };
}

/**
 * 解析 `next` 的可执行入口。
 *
 * 刻意**不**用 `pnpm exec next`：那要多起一层 pnpm 与 shell，
 * 而且把 env 传递交给 shell —— 而 shell 的行为跨平台不一致。
 * 直接 require Next 自己的 bin 更短、更快、更可预测。
 */
function resolveNextBin() {
  return require.resolve("next/dist/bin/next");
}

/**
 * 跑一条 Next 命令，带上仓库的遥测设置。
 *
 * 行为对齐 npm script：退出码透传，stdio 继承（因此 `next dev` 的
 * 输出照常显示，HMR 也照常工作）。
 */
function main(argv) {
  const child = spawn(process.execPath, [resolveNextBin(), ...argv], {
    stdio: "inherit",
    env: { ...process.env, ...telemetryOffEnv() },
  });

  child.on("exit", (code, signal) => {
    // 被信号杀死时（Ctrl+C / SIGTERM）用 130，与 shell 的惯例一致。
    if (signal) process.exit(130);
    process.exit(code ?? 0);
  });
}

/*
 * ── 执行入口（严格限定）──
 *
 * `main()` **只**在本文件被直接执行时运行。
 *
 * 这个文件同时被其它脚本 `import`（为了拿 `telemetryOffEnv()`），
 * 因此 import 时绝不能有副作用：不 spawn 子进程、不打印、不 `process.exit`。
 *
 * 上一版只在 **空 argv** 分支上加了 `isMainModule()` 判断，非空分支没有 ——
 * 于是"在一个 argv 非空的 CLI 里 import 它"会直接跑 `main(argv)`，
 * 用 import 者自己的参数去 spawn Next.js（独立审查复现：
 * 起了一个不受控的监听器）。判据必须覆盖**两个**分支，
 * 因此提到这里统一判断一次。
 */
if (isMainModule()) {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    console.error(
      "[next.mjs] 用法：node scripts/next.mjs <next 子命令> [参数…]\n" +
        "例：node scripts/next.mjs dev -H 127.0.0.1 -p 3100",
    );
    process.exit(2);
  }
  main(argv);
}
// 被 import：什么都不做，只导出 telemetryOffEnv / TELEMETRY_OFF_ENV。

/**
 * 判断本文件是不是**直接执行**的入口。
 *
 * 用 `import.meta.url` 与 `process.argv[1]` 比较，而不是 `require.main` ——
 * 后者在 ESM 里是 `undefined`。
 */
function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}
