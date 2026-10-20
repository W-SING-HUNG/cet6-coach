#!/usr/bin/env node
/**
 * `pnpm course:a3` —— **A3 受控课程接入工作台**（晋升 / 导入索引 / 建立真题链接）。
 *
 * ── 定位与能力边界 ──
 *
 * 在同一台回环服务器上追加 A3 的只读预演与**三个各自独立**的写动作。
 * A1（只读检查）→ A2（人工裁决）→ A3（正式接入）是三层**不同**的权限，
 * 因此本文件注入的能力与 A1/A2 的启动器刻意不同：
 *
 * | 能力 | A1 | A2 | A3 |
 * | --- | --- | --- | --- |
 * | `inspect` / `browse` | ✓ | ✓ | ✓ |
 * | `loadDraft` / `saveDraft` / `savePlanDraft` | — | ✓ | ✓ |
 * | 生成候选 | — | ✓ | ✓（补齐 A1 → A2 的断点） |
 * | 预演晋升 / 进度 | — | — | ✓ |
 * | **晋升 / 导入 / 建链** | — | — | ✓（三项各自单独确认） |
 *
 * ── 三条不可动摇的边界（每条都是结构性的）──
 *
 * | 边界 | 结构性保证 |
 * | --- | --- |
 * | **三项互相独立** | 三个独立端点 + 三个独立确认；**没有**"全部完成"端点 |
 * | **预演零写入** | 预演走只读路径；晋升门禁不写盘、进度从外部事实推导 |
 * | **写前必有可验证备份** | 导入先 `VACUUM INTO` 取快照并**真的读回来**核对 |
 *
 * ── 能力实现只有一份 ──
 *
 * 全部能力来自 `scripts/a3-capability.ts` —— 生产启动器与浏览器验收实例
 * 共用它。这是 A1 轮次那类"替身脚本"缺陷的直接对策：浏览器测试点到的按钮，
 * 走的就是 使用者 真实点到的同一段代码。
 *
 * ── 它**不**做什么 ──
 *
 * - 不自动批准任何裁决（那仍是 A2 的人工作为）；
 * - 不把三个写动作合成一个按钮；
 * - 不声称整体回滚（跨文件系统 + 数据库没有单一事务 —— 这是事实）；
 * - 不把绝对路径回给浏览器、写进 HTML 或打印到终端。
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import {
  A3_PAGE_PATH,
  newSessionToken,
  startAnnotationServer,
  type AnnotationSession,
} from "@/content/course-pipeline/segment-server";
import { renderA3Shell } from "@/content/course-pipeline/a3-page";
import { renderAdjudicationShell } from "@/content/course-pipeline/adjudication-page";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { createA3Capability } from "./a3-capability";

interface Args {
  port: number;
  open: boolean;
  source: string | null;
  courseId: string | null;
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
    courseId: argValue("--course-id"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs();
  let initialSource: string | null = null;
  if (args.source !== null) {
    const resolved = resolve(args.source);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) initialSource = resolved;
  }

  const token = newSessionToken();
  const capability = createA3Capability(initialSource, args.courseId);

  const session: AnnotationSession = {
    token,
    courseId: args.courseId ?? "a3-promotion",
    sourceDigest: "",
    config: { courseId: args.courseId ?? "a3-promotion", sourceDigest: "", assets: [], existingPlan: null },
    /**
     * A3 模式下的 `/api/plan`：**结构性拒绝**。
     *
     * 分段计划的保存走第 ⑤ 步的专用端点（带完整的绑定校验与白名单路径）；
     * 既有 `/api/plan` 的保存策略由标注 CLI 注入，这里不静默改写成另一套语义。
     */
    savePlan() {
      return {
        ok: false,
        detail: "课程接入工作台请在第 ⑤ 步保存人工裁决与分段计划（已带绑定校验）。",
        planDigest: "",
      };
    },
    intake: capability,
  };

  const handle = await startAnnotationServer(session, {
    port: args.port,
    page: () => renderAnnotationShell(),
    intakePage: () => renderAdjudicationShell(),
    a3Page: () => renderA3Shell(),
  });

  const intakeUrl = `http://${handle.boundAddress}:${handle.port}/intake#token=${handle.token}`;
  const a3Url = `http://${handle.boundAddress}:${handle.port}${A3_PAGE_PATH}#token=${handle.token}`;

  console.log("CET-6 Coach · 课程正式接入工作台（course:a3）");
  console.log(`模式：**A1 只读 + A2 人工裁决 + A3 受控接入**（只监听 ${handle.boundAddress}）`);
  console.log("");
  console.log("【第 1 步 · 检查、生成候选与人工审核】");
  console.log(`  ${intakeUrl}`);
  console.log("");
  console.log("【第 2 步 · 正式接入（三个各自独立的确认）】");
  console.log(`  ${a3Url}`);
  console.log("");
  console.log("【这个工作台不会做什么】");
  console.log("  · 不自动替你批准任何裁决（每条都要你自己选、自己写依据）；");
  console.log("  · 不把晋升 / 导入 / 建链合成一个按钮 —— 三者必须分开确认；");
  console.log("  · 不声称整体回滚（跨文件系统与数据库没有单一事务，这是事实）；");
  console.log("  · 不把绝对路径写进响应、HTML 或本终端。");
  console.log("");
  console.log("【它会写什么（按你的单独授权）】");
  console.log("  · 生成候选：course-candidates/<课程标识>/（旧候选先备份为 .prev-*）；");
  console.log("  · ① 晋升：courses/<课程标识>/（只复制 course.json 与 assets/）；");
  console.log("  · ② 导入：本机数据库（首次会执行 v8 → v9 增量迁移；写前先取可验证快照）；");
  console.log("  · ③ 建链：数据库里不可变的人工复核行（只追加，不能改也不能删）。");
  console.log("");
  console.log("  注意：保存 review.json **不等于**课程已导入 —— 那是第 ② 步的独立动作。");
  console.log("");
  console.log("按 Ctrl+C 结束本次会话。");

  if (args.open) {
    try {
      const { spawn } = await import("node:child_process");
      const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const commandArgs = process.platform === "win32" ? ["/c", "start", "", a3Url] : [a3Url];
      spawn(command, commandArgs, { stdio: "ignore", detached: true }).unref();
    } catch {}
  }

  process.on("SIGINT", () => {
    void handle.close().then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error("工作台启动失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
