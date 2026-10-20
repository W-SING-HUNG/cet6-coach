#!/usr/bin/env node
/**
 * `pnpm course:segment <course-id>` —— **本地**人工分段标注工具。
 *
 * ── 它是给 使用者 用的操作者工具，不是学习者产品 ──
 *
 * 它启动一个**只监听 127.0.0.1** 的临时服务器，把本机已经拥有的私有材料
 * 渲染在浏览器里，让人把结构标出来，存成一份**分段计划**。
 *
 * ── 它**不**做什么（每一条都由测试或门禁守护）──
 *
 * - 不打开数据库（**不 import 任何数据库模块**）；
 * - 不做任何 Git 操作；
 * - 不生成 `review.json`（那必须由人显式签出）；
 * - 不晋升、不导入、不建链、不改候选；
 * - 不做 OCR、不调用任何远程服务/AI、不发起任何外部网络请求；
 * - **不把课程正文写进终端**（终端输出会被记录进自动化上下文）。
 *
 * ── 为什么必须只监听回环 ──
 *
 * 这个页面显示的是**付费私有材料**。绑定到 `0.0.0.0` 会让同一局域网里的
 * 任何设备都能读取它。因此监听地址是硬编码的 `127.0.0.1`，
 * 并由源码级门禁禁止出现 `0.0.0.0`。
 *
 * 用法：
 *   pnpm course:segment <course-id> [选项]
 *
 * 必填：
 *   <course-id>           课程 id（与 course:extract 的 --id 一致）
 *
 * 选填：
 *   --source <dir>        源目录（默认从计划的绑定/候选推断；外部源必须显式给）
 *   --plan <file>         计划文件路径（默认 private-content/course-segmentation-plans/<id>.json）
 *   --port <n>            监听端口（默认 0 = 系统分配空闲端口）
 *   --no-open             只打印 URL，不尝试打开浏览器
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getCourseSegmentationPlansDir, getCourseSourcesDir } from "@/content/paper/paths";
import { assertSafeCourseId, isPathSafetyError, sanitizeForDisplay } from "@/content/course-pipeline/containment";
import { scanSourceDirectory } from "@/content/course-pipeline/sources";
import { extractPdfPages } from "@/content/course-pipeline/pdf-extract";
import { parseSegmentationPlan, segmentationPlanDigest, validatePlanShape } from "@/content/course-pipeline/segmentation-plan";
import { newSessionToken, startAnnotationServer, LOOPBACK_HOST } from "@/content/course-pipeline/segment-server";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import type { AnnotationServerConfig } from "@/content/course-pipeline/segment-server";

interface Args {
  courseId: string | null;
  source: string | null;
  plan: string | null;
  port: number;
  open: boolean;
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1];
  return value.startsWith("--") ? null : value;
}

function parseArgs(): Args {
  const flags = new Set(["--source", "--plan", "--port", "--no-open"]);
  const positional: string[] = [];
  for (let index = 2; index < process.argv.length; index += 1) {
    const token = process.argv[index];
    if (flags.has(token)) {
      if (token !== "--no-open") index += 1;
      continue;
    }
    if (token.startsWith("--")) continue;
    positional.push(token);
  }
  const portRaw = argValue("--port");
  const port = portRaw === null ? 0 : Number(portRaw);
  return {
    courseId: positional[0] ?? null,
    source: argValue("--source"),
    plan: argValue("--plan"),
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0,
    open: !process.argv.includes("--no-open"),
  };
}

function usage(): never {
  console.error("用法: pnpm course:segment <course-id> [--source <dir>] [--plan <file>] [--port <n>] [--no-open]");
  console.error("");
  console.error("  <course-id>       必填：课程 id（与 course:extract 的 --id 一致）");
  console.error("  --source <dir>    源目录（外部源必须显式提供）");
  console.error("  --plan <file>     计划文件路径（默认 course-segmentation-plans/<id>.json）");
  console.error("  --port <n>        监听端口（默认 0 = 系统分配；只监听 127.0.0.1）");
  console.error("  --no-open         只打印 URL，不尝试打开浏览器");
  process.exit(2);
}

/**
 * **原子写盘**：临时文件 + rename。
 *
 * 直接 `writeFileSync(planPath)` 会在写入过程中留下一个"半截计划"的窗口。
 * 若进程恰好在那里被杀掉（Ctrl+C、断电），一份**完好的**旧计划就被
 * 一份截断的 JSON 覆盖了 —— 而截断的 JSON 是不可恢复的。
 *
 * `rename` 在同一文件系统内是原子的：目标要么是旧的完整内容，
 * 要么是新的完整内容，不存在中间态。
 */
export function writeFileAtomic(target: string, content: string): void {
  const directory = dirname(target);
  mkdirSync(directory, { recursive: true });
  const temporary = join(directory, `.${Date.now()}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, target);
  } catch (error) {
    // 清理临时文件，绝不留下垃圾
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      /* 尽力而为 */
    }
    throw error;
  }
}

/** 从候选元数据里取出源定位符与课程 id（用于推断源根）。 */
function readCandidateSourceHint(courseId: string): { sourceRoot: string | null; label: string } {
  // 刻意只读**候选**（course-candidates/），不读数据库、不读 courses/
  const metadataPath = join(
    resolve(process.cwd(), process.env.CET6_CONTENT_ROOT ?? "private-content", "course-candidates", courseId),
    "candidate.json",
  );
  if (!existsSync(metadataPath)) return { sourceRoot: null, label: courseId };
  try {
    const metadata = JSON.parse(readFileSync(metadataPath, "utf8")) as {
      inventory?: { sourceLocator?: { kind?: string; locator?: string | null; label?: string } };
    };
    const locator = metadata.inventory?.sourceLocator;
    if (locator?.kind === "standard" && typeof locator.locator === "string") {
      return { sourceRoot: join(getCourseSourcesDir(), ...locator.locator.split("/")), label: locator.locator };
    }
    return { sourceRoot: null, label: locator?.label ?? courseId };
  } catch {
    return { sourceRoot: null, label: courseId };
  }
}

async function main(): Promise<void> {
  const args = parseArgs();
  if (args.courseId === null) usage();

  try {
    assertSafeCourseId(args.courseId);
  } catch (error) {
    console.error(`拒绝：${(error as Error).message}`);
    process.exit(2);
  }

  const planPath = args.plan === null
    ? join(getCourseSegmentationPlansDir(), `${args.courseId}.json`)
    : resolve(args.plan);

  // ── 决定源根：显式 --source 优先；否则尝试从候选推断 ──
  //
  // 源根的位置**只出现在内存里**：计划与候选都不记录绝对路径
  // （外部源的那种情况下连相对定位符都没有 —— 见既有的
  // `sourceLocatorFor` 契约）。因此这里不需要保留任何路径标签。
  let sourceRoot: string | null = args.source === null ? null : resolve(args.source);
  if (sourceRoot === null) {
    sourceRoot = readCandidateSourceHint(args.courseId).sourceRoot;
  }

  console.log("CET-6 Coach · 课程人工分段标注（course:segment）");
  console.log(`课程：${args.courseId}`);
  console.log(`模式：**本地标注**（只监听 ${LOOPBACK_HOST}；不打开数据库；不做 Git 操作）`);
  console.log("");

  if (sourceRoot === null || !existsSync(sourceRoot)) {
    console.error("找不到源目录。这个工具需要读取**源件**才能渲染可标注的行。");
    console.error("");
    console.error("处置：显式提供源目录：");
    console.error("    pnpm course:segment <course-id> --source <PATH>");
    console.error("");
    console.error("说明：外部源根的位置**刻意不落盘**（绝对路径绝不进候选/计划），");
    console.error("      因此外部源每次都需要显式给出。上面是**模板**，不含任何真实路径。");
    process.exit(1);
  }

  // ── 只读清点 + 抽取（与 course:extract 同一套实现）──
  const inventory = scanSourceDirectory(sourceRoot, {
    standardSourcesRoot: getCourseSourcesDir(),
  });

  const assets: AnnotationServerConfig["assets"] = [];
  let totalLines = 0;
  for (const asset of inventory.assets) {
    if (asset.kind !== "pdf") {
      assets.push({ assetKey: asset.assetKey, label: sanitizeForDisplay(asset.basename, 80), sha256: asset.sha256, pages: [] });
      continue;
    }
    const document = await extractPdfPages(asset.assetKey, join(sourceRoot, ...asset.relativePath.split("/")));
    totalLines += document.pages.reduce((sum, page) => sum + (page.hasTextLayer ? page.lines.length : 0), 0);
    assets.push({
      assetKey: asset.assetKey,
      label: sanitizeForDisplay(asset.basename, 80),
      sha256: asset.sha256,
      pages: document.pages.map((page) => ({
        page: page.page,
        hasTextLayer: page.hasTextLayer,
        lines: page.hasTextLayer ? page.lines : [],
      })),
    });
  }

  // ── 已存在的计划：用于"继续标注" ──
  let existingPlan: unknown = null;
  if (existsSync(planPath)) {
    const parsed = parseSegmentationPlan(readFileSync(planPath, "utf8"));
    // 坏计划**不**让工具崩掉：它是可预期的失败状态。
    // 页面会从空状态开始，操作者可以覆盖它。
    existingPlan = parsed.ok ? parsed.plan : null;
    if (!parsed.ok) {
      console.log(`注意：${sanitizeForDisplay(planPath.split(/[\\/]/).pop() ?? "", 80)} 不是一份可解析的计划`);
      console.log(`      （${parsed.issues.length} 项问题：${parsed.issues.map((i) => i.code).join("、")}）。`);
      console.log("      本会话将从空状态开始；保存会覆盖它。");
      console.log("");
    }
  }

  const token = newSessionToken();
  const session = {
    token,
    courseId: args.courseId,
    sourceDigest: inventory.digest,
    config: { courseId: args.courseId, sourceDigest: inventory.digest, assets, existingPlan },
    savePlan(plan: Record<string, unknown>) {
      // 保存前用**权威实现**校验形状；形状不合法就不落盘。

      const shape = validatePlanShape(plan);
      if (!shape.ok || shape.plan === null) {
        return {
          ok: false,
          detail: `计划形状不合法（${shape.issues.length} 项）：${shape.issues.map((i) => i.code).join("、")}`,
          planDigest: "",
        };
      }
      writeFileAtomic(planPath, `${JSON.stringify(plan, null, 2)}\n`);
      // 校验和由**唯一实现**算（绝不在这里另写一份）
      const digest = segmentationPlanDigest(shape.plan);
      return { ok: true, detail: "已原子写入本机私有目录。", planDigest: digest };
    },
  };

  const handle = await startAnnotationServer(session, {
    port: args.port,
    // 页面是**静态外壳**：它不接受会话数据，因此未认证的 GET / 不含任何私有内容
    page: () => renderAnnotationShell(),
  });

  // ── 安全元数据摘要（**绝不含正文**）──
  console.log("【可标注内容（安全元数据）】");
  console.log(`  资产 ${assets.length} 个 · 可标注行 ${totalLines} 行 · 源摘要 ${inventory.digest.slice(0, 16)}…`);
  console.log("");
  console.log("【打开标注界面】");
  console.log(`  ${handle.url}`);
  console.log("");
  console.log("  说明：URL 的 **# 之后**带着本次会话的随机 token。");
  console.log("        浏览器**不会**把 # 之后的部分发给任何服务器 —— 因此它不进访问日志，");
  console.log("        也不出现在本服务的请求目标里。页面读到后会立刻把它从地址栏抹掉。");
  console.log("        写操作必须带上它（经自定义请求头），读私有内容同样需要它。");
  console.log("        该 token 只在本进程存活期间有效，进程退出即失效。");
  console.log("        本服务**只监听回环地址**，局域网上的其他设备无法访问。");
  console.log("");
  console.log("  注意：上面这一行是**敏感操作者输出** —— 请不要把它粘贴到任何日志、");
  console.log("        工单或聊天里，也不要用它创建快捷方式。整条 URL 自己用即可。");
  console.log("");
  console.log("【这个工具不会做什么】");
  console.log("  · 不打开数据库、不做 Git 操作、不发起任何外部网络请求；");
  console.log("  · 不生成 review.json（那必须由人显式签出）；");
  console.log("  · 不晋升 / 不导入 / 不建链 / 不改候选；");
  console.log("  · 不把课程正文写进本终端（只打印计数与坐标）。");
  console.log("");
  console.log("【保存之后】");
  console.log("  计划写入本机 private-content/（**不进 Git**）。然后**重新生成候选**：");
  console.log("      pnpm course:extract --source <PATH> --id " + args.courseId);
  console.log("  候选必须从输入重新生成 —— 工具**绝不**在原地改写已写出的候选。");
  console.log("  注意：计划**不是**复核记录。review.json 仍然必须由人签出。");
  console.log("");
  console.log("按 Ctrl+C 结束本次标注会话。");

  if (args.open) {
    // 尽力而为地打开浏览器；失败不影响使用（URL 已经打印出来了）
    try {
      const { spawn } = await import("node:child_process");
      const command =
        process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
      const commandArgs = process.platform === "win32" ? ["/c", "start", "", handle.url] : [handle.url];
      // stdio: "ignore" —— 不捕获子进程输出（也不需要，且避免管道阻塞）
      spawn(command, commandArgs, { stdio: "ignore", detached: true }).unref();
    } catch {
      console.log("（未能自动打开浏览器 —— 请手动把上面的 URL 粘贴到浏览器。）");
    }
  }

  // Ctrl+C 时干净退出
  process.on("SIGINT", () => {
    void handle.close().then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  if (isPathSafetyError(error)) {
    console.error(`拒绝：${(error as Error).message}`);
    process.exit(2);
  }
  console.error("标注工具启动失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
