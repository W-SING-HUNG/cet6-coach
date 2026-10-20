#!/usr/bin/env node
/**
 * `pnpm course:adjudication` —— **A2 课程材料人工审核与保存工作台**。
 *
 * ── 定位与能力边界 ──
 * 扩展 A1 工作台，支持在本地浏览器中：
 * 1. 审核材料分组、分段、真题匹配三类独立建议；
 * 2. 收集用户显式裁决（accepted / rejected / intentionally_unmatched）与依据；
 * 3. 校验审核草稿形状、依据、绑定校验和与真题库版本新鲜度；
 * 4. 原子安全写入候选复核记录（`course-candidates/<id>/review.json`）与
 *    人工分段计划（`course-segmentation-plans/<id>.json`），自动备份历史；
 * 5. 加载既有审核草稿/分段计划并支持继续编辑；
 * 6. **生成课程候选**（补齐 A1 → A2 的断点：候选此前只有命令行入口，
 *    而"候选不存在"会让保存必然失败）。
 *
 * ── 三条不可动摇的边界（每条都是结构性的）──
 *
 * | 边界 | 结构性保证 |
 * | --- | --- |
 * | **不自动批准任何建议** | 界面控件默认为空；服务端不补任何决定 |
 * | **不写 `courses/`、不碰数据库** | 本文件不注入晋升/导入/链接能力 |
 * | **不执行 A3** | 无晋升/导入/建链入口；`savePlan` 在此模式下同样拒绝 |
 *
 * ── 与 A1 / A3 的关系 ──
 *
 * A1 只读、零写入；A2 在同一台服务器上追加"保存"能力。A1 的启动器
 * （`course:workbench`）刻意**不注入** A2 能力，因此 A1 会话在 HTTP 层
 * 就没有任何保存端点可用（`saveDraft` 缺失 ⇒ 501）。
 *
 * 同理，本启动器刻意**不注入** A3 的 `previewPromotion` —— 因此
 * `GET /a3` 在 A2 会话上回 404，且晋升/导入/建链四个端点全部 501。
 * 这条隔离由 `tests/course-a2-http-security.test.ts` 与
 * `tests/course-a3-controlled-import.test.ts` 双向守护。
 *
 * ── 能力实现只有一份 ──
 *
 * 全部能力来自 `scripts/a3-capability.ts`。生产与浏览器验收共用它，
 * 因此测试点到的按钮走的就是 使用者 真实点到的同一段代码。
 */

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";

import { newSessionToken, startAnnotationServer } from "@/content/course-pipeline/segment-server";
import type { AnnotationSession } from "@/content/course-pipeline/segment-server";
import { renderAdjudicationShell } from "@/content/course-pipeline/adjudication-page";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { createA3Capability } from "./a3-capability";

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

async function main(): Promise<void> {
  const args = parseArgs();
  let initialSource: string | null = null;
  if (args.source !== null) {
    const resolved = resolve(args.source);
    if (existsSync(resolved) && statSync(resolved).isDirectory()) {
      initialSource = resolved;
    }
  }

  const token = newSessionToken();
  const capability = createA3Capability(initialSource, null);

  /*
   * ── A2 会话**刻意**不具备 A3 能力 ──
   *
   * `createA3Capability` 返回的对象包含 A3 的四个方法，因此这里把它
   * **显式遮蔽掉**：A2 工作台的职责到"人工裁决与保存"为止。
   *
   * 为什么不给 `createA3Capability` 加一个"模式"参数：那会让
   * "本会话能做什么"取决于一个字符串参数。显式遮蔽让能力边界在
   * 调用处**看得见**，而且无法通过传错参数被打开。
   */
  const a2Only = { ...capability };
  delete (a2Only as Record<string, unknown>).previewPromotion;
  delete (a2Only as Record<string, unknown>).promoteCandidate;
  delete (a2Only as Record<string, unknown>).importIndex;
  delete (a2Only as Record<string, unknown>).linkCanonical;
  delete (a2Only as Record<string, unknown>).readProgress;

  const session: AnnotationSession = {
    token,
    courseId: "a2-adjudication",
    sourceDigest: "",
    config: { courseId: "a2-adjudication", sourceDigest: "", assets: [], existingPlan: null },
    /**
     * A2 模式下的 `/api/plan`：**结构性拒绝**。
     *
     * 分段计划的保存走第 ⑤ 步的专用端点（`savePlanDraft`），它带完整的
     * 绑定校验与白名单路径；既有 `/api/plan` 是标注工具的入口，它的
     * 保存策略由标注 CLI 注入。这里不静默改写成另一套语义。
     */
    savePlan() {
      return {
        ok: false,
        detail: "A2 工作台请在第 ⑤ 步保存人工裁决与分段计划（已带绑定校验）。",
        planDigest: "",
      };
    },
    intake: a2Only,
  };

  const handle = await startAnnotationServer(session, {
    port: args.port,
    page: () => renderAnnotationShell(),
    intakePage: () => renderAdjudicationShell(),
  });

  const workbenchUrl = `http://${handle.boundAddress}:${handle.port}/intake#token=${handle.token}`;

  console.log("CET-6 Coach · 课程材料人工审核与保存工作台（course:adjudication · A2）");
  console.log(`模式：**人工审核与保存**（只监听 ${handle.boundAddress}；不碰生产库；可逆原子保存）`);
  console.log("");
  console.log("【打开工作台】");
  console.log(`  ${workbenchUrl}`);
  console.log("");
  console.log("【这个工作台不会做什么】");
  console.log("  · 不自动替你批准任何建议（每条裁决都必须你自己选、自己写依据）；");
  console.log("  · 不写 courses/、不打开数据库、不做 Git 操作；");
  console.log("  · 不晋升 / 不导入 / 不建链（那些是 A3 的独立批准动作，本会话在 HTTP 层就没有那些端点）。");
  console.log("  · 不把课程正文写进本终端。");
  console.log("");
  console.log("【它会写什么】");
  console.log("  · course-candidates/<课程标识>/ —— 生成的课程候选 + 你的人工审核记录；");
  console.log("  · course-segmentation-plans/<课程标识>.json —— 你的人工分段计划。");
  console.log("  两者都在本机 private-content/ 下，且只在这两个目录里写。");
  console.log("");
  console.log("  注意：保存 review.json **不等于**课程已导入 CET6 Coach —— 那是 A3 的独立动作。");
  console.log("");
  console.log("按 Ctrl+C 结束本次会话。");

  if (args.open) {
    try {
      const { spawn } = await import("node:child_process");
      const command =
        process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const commandArgs = process.platform === "win32" ? ["/c", "start", "", workbenchUrl] : [workbenchUrl];
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
