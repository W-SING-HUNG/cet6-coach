#!/usr/bin/env node
/**
 * `pnpm course:workbench` —— **A1 只读课程检查工作台**（本地、回环、零写入）。
 *
 * ── 它是什么 ──
 *
 * 同一个本地服务器（与 `pnpm course:segment` 同一个进程架构、同一套守卫、
 * 同一个 token），但**不需要 course-id / source 参数**：
 * 目录由 使用者 在浏览器里经**系统原生文件夹选择窗口**指定。
 *
 *     pnpm course:workbench
 *     → 终端打印 http://127.0.0.1:<port>/#token=…
 *     → 浏览器打开 → 选文件夹 → 勾范围 → 「检查所选材料」
 *
 * ── 它**绝不**做什么（每一条都由测试或门禁守护）──
 *
 * - **不写任何文件**：不生成候选、不写复核记录、不写分段计划、
 *   不写临时文件、不建目录；
 * - **不打开数据库**（不 import 任何数据库 / 仓库模块）；
 * - 不做 Git 操作；
 * - 不晋升 / 不导入 / 不建链 / 不改候选；
 * - 不做 OCR、不调用任何远程服务 / AI、不发起任何外部网络请求；
 * - **不把课程正文写进终端**（终端输出会被记录进自动化上下文）。
 *
 * ── 它凭什么能声称"零写入" ──
 *
 * 不是纪律，是**结构**：
 *
 * | 保证 | 机制 |
 * | --- | --- |
 * | 不可能写候选 | 本文件与 `inspection.ts` **都不 import** 候选写出器 |
 * | 不可能写数据库 | 两者都不 import 数据库 / 仓库层 |
 * | 不可能晋升 / 导入 / 建链 | 不 import 那几个服务 |
 * | 不可能碰 Git | 源码里没有任何 `git` 调用 |
 *
 * 因此"跑完 A1 之后磁盘一字未改"是一条**可静态审计**的性质。
 * `scripts/course-a1-workbench-proof.ts` 另在真实进程层做前后快照对照。
 *
 * ── 为什么它只监听回环 ──
 *
 * 这个页面显示的是**付费私有材料**。绑定到 `0.0.0.0` 会让同一局域网里的
 * 任何设备都能触发本机读盘。因此监听地址是硬编码的 `127.0.0.1`，
 * 并由源码级门禁禁止出现 `0.0.0.0`。
 *
 * 用法：
 *   pnpm course:workbench [选项]
 *
 * 选填：
 *   --port <n>     监听端口（默认 0 = 系统分配空闲端口）
 *   --no-open      只打印 URL，不尝试打开浏览器
 *   --source <dir> 跳过选取窗口，直接用这个目录（自动化/排查用；**仍然只读**）
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { newSessionToken, startAnnotationServer } from "@/content/course-pipeline/segment-server";
import type { AnnotationSession, IntakeCapability } from "@/content/course-pipeline/segment-server";
import { renderIntakeShell } from "@/content/course-pipeline/intake-page";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { inspectSourceTree, runInspection } from "@/content/course-pipeline/inspection";
import { pickFolder } from "@/content/course-pipeline/folder-picker";

interface Args {
  port: number;
  open: boolean;
  source: string | null;
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1];
  return value.startsWith("--") ? null : value;
}

function parseArgs(): Args {
  const portRaw = argValue("--port");
  const port = portRaw === null ? 0 : Number(portRaw);
  return {
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0,
    open: !process.argv.includes("--no-open"),
    source: argValue("--source"),
  };
}

function usage(): never {
  console.error("用法: pnpm course:workbench [--port <n>] [--no-open] [--source <dir>]");
  console.error("");
  console.error("  --port <n>      监听端口（默认 0 = 系统分配；只监听 127.0.0.1）");
  console.error("  --no-open       只打印 URL，不尝试打开浏览器");
  console.error("  --source <dir>  跳过选取窗口，直接用这个目录（自动化/排查用；仍然只读）");
  console.error("");
  console.error("这个工作台是**只读**的：不写候选、不写计划、不写数据库、不改任何源文件。");
  process.exit(2);
}

/** 只作展示的目录名（**只有 basename**，不含任何上级路径）。 */
function labelOf(absolutePath: string): string {
  const parts = absolutePath.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? "source";
}

/**
 * A1 能力对象。
 *
 * ── 绝对路径只活在这个闭包里 ──
 *
 * `sourceRoot` 是唯一持有绝对路径的变量，而它：
 * - 不出现在任何返回给浏览器的值里（`sourceLabel()` 只回 basename）；
 * - 不进任何日志（本文件的 console 调用只打印计数与目录名）；
 * - 不落盘（没有缓存、没有临时文件）。
 */
function createIntakeCapability(initialSource: string | null): IntakeCapability {
  let sourceRoot: string | null = initialSource;

  const resolveSource = (): string => {
    if (sourceRoot === null) throw new Error("还没有选择课程目录");
    return sourceRoot;
  };

  return {
    async pickFolder() {
      const picked = await pickFolder({
        // 已经选过一次时，从上次的位置继续（更接近原生工具的行为）
        startDirectory: sourceRoot,
      });
      return picked;
    },
    rememberSource(sourcePath: string) {
      sourceRoot = resolve(sourcePath);
    },
    sourceLabel() {
      return sourceRoot === null ? null : labelOf(sourceRoot);
    },
    hasSource() {
      return sourceRoot !== null && existsSync(sourceRoot) && statSync(sourceRoot).isDirectory();
    },
    async browse() {
      return inspectSourceTree(resolveSource());
    },
    async inspect(selection) {
      return runInspection({
        sourceRoot: resolveSource(),
        /*
         * 课程 id 只用于展示与 slug 校验。A1 **不写任何文件**，
         * 因此这里不生成也不持久化它 —— 一个固定的只读占位值即可。
         */
        courseId: "a1-readonly-inspection",
        selection,
      });
    },
    forgetSource() {
      sourceRoot = null;
    },
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (process.argv.includes("--help")) usage();

  let initialSource: string | null = null;
  if (args.source !== null) {
    const resolved = resolve(args.source);
    if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
      // 只打印**目录名**，绝不打印绝对路径
      console.error(`源目录不存在或不是目录：${labelOf(resolved)}`);
      process.exit(1);
    }
    initialSource = resolved;
  }

  const token = newSessionToken();
  const capability = createIntakeCapability(initialSource);

  const session: AnnotationSession = {
    token,
    /*
     * 既有标注字段仍然必须存在（同一个会话形状）。A1 不使用它们：
     * `/api/plan` 的写能力由**启动器**决定是否提供 —— 见下方 `savePlan`。
     */
    courseId: "a1-readonly-inspection",
    sourceDigest: "",
    config: { courseId: "a1-readonly-inspection", sourceDigest: "", assets: [], existingPlan: null },
    /**
     * ── A1 模式下的 `/api/plan`：**结构性不可用** ──
     *
     * 任务书要求："the existing `/api/plan` save capability must be
     * inaccessible in A1 mode **at the server layer**, regardless of
     * whether a button is visible."
     *
     * 这里的实现不是"界面不放按钮"，而是**这个回调拒绝一切写入**。
     * 注意它连"计划形状是否合法"都不看 —— 一个形状完全合法的计划
     * 在 A1 模式下同样被拒。那条判据与"按钮在不在"没有任何关系。
     */
    savePlan() {
      return {
        ok: false,
        detail: "A1 只读工作台不具备保存计划的能力（这是设计，不是错误）。",
        planDigest: "",
      };
    },
    intake: capability,
  };

  const handle = await startAnnotationServer(session, {
    port: args.port,
    /*
     * `GET /` 仍然回既有的标注外壳（一个静态文档）。
     *
     * A1 模式**没有**把 `course:segment` 的标注能力拿掉 —— 但那个页面
     * 在 A1 里没有实际用途（它需要已抽取的可标注行，而这里 `assets` 为空，
     * 页面会如实显示"没有可标注内容"）。真正的写入能力已经在 `savePlan`
     * 那一层被拒绝，因此"标注页面挂在同一进程上"不构成一条写路径。
     */
    page: () => renderAnnotationShell(),
    intakePage: () => renderIntakeShell(),
  });

  /*
   * ── 工作台 URL 必须显式构造 ──
   *
   * `handle.url` 形如 `http://127.0.0.1:<port>/#token=…` —— 路径在 `#`
   * **之前**。若对整条 URL 做 `replace(/\/$/, "/intake")`，`/intake` 会被
   * 接到 fragment **之后**，于是浏览器打开的是 `GET /`（标注外壳）而不是
   * 工作台。因此这里显式拼：路径 + fragment。
   */
  const workbenchUrl = `http://${handle.boundAddress}:${handle.port}/intake#token=${handle.token}`;

  console.log("CET-6 Coach · 课程材料只读检查工作台（course:workbench · A1）");
  console.log(`模式：**只读检查**（只监听 ${handle.boundAddress}；不打开数据库；不写任何文件）`);
  console.log("");
  console.log("【打开工作台】");
  console.log(`  ${workbenchUrl}`);
  console.log("");
  console.log("  说明：URL 的 **# 之后**带着本次会话的随机 token。");
  console.log("        浏览器**不会**把 # 之后的部分发给任何服务器 —— 因此它不进访问日志。");
  console.log("        页面读到后会立刻把它从地址栏抹掉。");
  console.log("        该 token 只在本进程存活期间有效，进程退出即失效。");
  console.log("        本服务**只监听回环地址**，局域网上的其他设备无法访问。");
  console.log("");
  console.log("  注意：上面这一行是**敏感操作者输出** —— 请不要把它粘贴到任何日志、");
  console.log("        工单或聊天里。整条 URL 自己用即可。");
  console.log("");
  console.log("【这个工作台不会做什么】");
  console.log("  · 不写候选包、不写复核记录、不写分段计划、不写任何临时文件；");
  console.log("  · 不打开数据库、不做 Git 操作、不发起任何外部网络请求；");
  console.log("  · 不晋升 / 不导入 / 不建链 / 不改候选；");
  console.log("  · 不修改任何源文件（源目录全程只读打开）；");
  console.log("  · 不把课程正文写进本终端（只打印计数与目录名）。");
  console.log("");
  console.log("【它可以做什么】");
  console.log("  · 列出所选目录里的文件与文件夹（只读元数据，不解析内容）；");
  console.log("  · 按你勾选的范围做一次完整检查：清点 → 抽取 → 分组 → 分段 → 真题候选建议；");
  console.log("  · 如实报告冲突、警告与处置建议（全部在页面上，不进终端）。");
  console.log("");
  console.log("按 Ctrl+C 结束本次会话（不会留下任何文件）。");

  if (args.open) {
    try {
      const { spawn } = await import("node:child_process");
      const command =
        process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const commandArgs = process.platform === "win32" ? ["/c", "start", "", workbenchUrl] : [workbenchUrl];
      // stdio: "ignore" —— 不捕获子进程输出（也避免管道阻塞）
      spawn(command, commandArgs, { stdio: "ignore", detached: true }).unref();
    } catch {
      console.log("（未能自动打开浏览器 —— 请手动把上面的 URL 粘贴到浏览器。）");
    }
  }

  process.on("SIGINT", () => {
    void handle.close().then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error("工作台启动失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
