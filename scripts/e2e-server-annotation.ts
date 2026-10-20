#!/usr/bin/env node
/**
 * **本地标注页面**的 E2E 服务启动器（端口 3240）。
 *
 * ── 它存在的唯一理由 ──
 *
 * 被验收的对象是 `GET /` **真实响应字节**里那段内联脚本 ——
 * 也就是 使用者 真正打开的那个页面。要有真实浏览器证据，就必须有一个
 * **真实的回环服务**在监听，并走一次**真实的 token 握手**。
 * 在 spec 里自己 `new Function(...)` 执行脚本只能证明"脚本可执行"，
 * 证明不了"Chromium 加载这个页面时它确实工作"。
 *
 * ── 它绝不碰真实材料 ──
 *
 * - 可标注的正文是**写死的合成字符串**（下面 `SYNTHETIC_PAGES`），
 *   不是任何真实讲义/真题；它带显眼的「合成夹具」标识；
 * - 计划写到 `.e2e/annotation-plan.json`，**不是** `private-content/`；
 * - 不打开数据库（标注服务器在结构上就没有这个能力）。
 *
 * ── token 怎么交给 spec ──
 *
 * `startAnnotationServer` 生成随机 token 并放在 URL 的 **fragment** 里
 * （fragment 不发给服务器）。这里把那条 URL 写进
 * `.e2e/annotation-handoff.json`（**只有 URL，没有任何正文**），
 * spec 读它并导航 —— 因此测到的是真实凭据流程，而不是旁路。
 *
 * 进程常驻，直到 Playwright 关掉它。
 */

import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import {
  LOOPBACK_HOST,
  newSessionToken,
  startAnnotationServer,
  type AnnotationServerConfig,
} from "@/content/course-pipeline/segment-server";
import { segmentationPlanDigest, validatePlanShape } from "@/content/course-pipeline/segmentation-plan";
import {
  E2E_ANNOTATION_HANDOFF_PATH,
  E2E_ANNOTATION_PLAN_PATH,
  E2E_ANNOTATION_PORT,
} from "../e2e/config";

/**
 * **原子写盘**：临时文件 + rename。
 *
 * 与 `scripts/course-segment.ts` 的 `writeFileAtomic` 语义相同。
 * 这里内联而不是 import：那个模块在导入时会执行它自己的 CLI 主流程
 * （它是个可执行脚本），导入它会直接 `process.exit(2)`。
 * 语义保持"要么旧内容、要么新内容，绝不出现半截 JSON"。
 */
function writeFileAtomic(target: string, content: string): void {
  mkdirSync(dirname(target), { recursive: true });
  const temporary = join(dirname(target), `.${Date.now()}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, content, "utf8");
    renameSync(temporary, target);
  } catch (error) {
    try {
      if (existsSync(temporary)) unlinkSync(temporary);
    } catch {
      /* 尽力而为 */
    }
    throw error;
  }
}

/**
 * **合成**可标注内容。
 *
 * 三页，行数刻意不同（便于断言页内坐标）。
 * 每一页第 1 行都是"每页重复出现"的合成页眉 —— 用于验证
 * 「页眉页脚（忽略）」这一类的真实用法。
 */
const SYNTHETIC_PAGES: { page: number; hasTextLayer: boolean; lines: string[] }[] = [
  {
    page: 1,
    hasTextLayer: true,
    lines: [
      "【合成夹具】CET6 课程讲义 · 第 1 页 · 请勿当真",
      "合成中文原文第一段：城市轨道交通的运营方需要协调多个系统。",
      "合成中文原文第二段：这只是一个用于界面验收的占位句子。",
      "合成参考译文：Operators of urban rail must coordinate several systems.",
      "合成参考译文：This is a placeholder sentence for UI acceptance only.",
      "合成讲解：注意 coordinate 与 several 的搭配用法。",
    ],
  },
  {
    page: 2,
    hasTextLayer: true,
    lines: [
      "【合成夹具】CET6 课程讲义 · 第 2 页 · 请勿当真",
      "合成中文原文第三段：安全冗余是轨道系统的核心设计目标。",
      "合成参考译文：Safety redundancy is a core design goal of rail systems.",
      "合成讲解：redundancy 在这里指「冗余备份」，不是「多余」。",
    ],
  },
  {
    page: 3,
    hasTextLayer: true,
    lines: [
      "【合成夹具】CET6 课程讲义 · 第 3 页 · 请勿当真",
      "合成中文原文第四段：这一页用来验证跨页的标记不会互相干扰。",
      "合成参考译文：This page verifies that marks on different pages stay separate.",
    ],
  },
];

/** 合成资产键与校验和（**不是**任何真实资产的校验和）。 */
const SYNTHETIC_ASSET_KEY = "synthetic-fixture-asset";
const SYNTHETIC_ASSET_SHA = "f".repeat(64);
const SYNTHETIC_SOURCE_DIGEST = "e".repeat(64);
const SYNTHETIC_COURSE_ID = "synthetic-annotation-course";

async function main(): Promise<void> {
  const token = newSessionToken();
  const assets: AnnotationServerConfig["assets"] = [
    {
      assetKey: SYNTHETIC_ASSET_KEY,
      label: "synthetic-handout.pdf",
      sha256: SYNTHETIC_ASSET_SHA,
      pages: SYNTHETIC_PAGES,
    },
  ];

  const session = {
    token,
    courseId: SYNTHETIC_COURSE_ID,
    sourceDigest: SYNTHETIC_SOURCE_DIGEST,
    config: { courseId: SYNTHETIC_COURSE_ID, sourceDigest: SYNTHETIC_SOURCE_DIGEST, assets, existingPlan: null },
    savePlan(plan: Record<string, unknown>) {
      /*
       * 保存实现与 `scripts/course-segment.ts` 完全一致：
       * 先用**权威形状校验**，再原子写盘，校验和用**唯一实现**算。
       * 这里只把落盘位置换成 `.e2e/`（隔离），语义一字不改。
       */
      const shape = validatePlanShape(plan);
      if (!shape.ok || shape.plan === null) {
        return {
          ok: false,
          detail: `计划形状不合法（${shape.issues.length} 项）：${shape.issues.map((i) => i.code).join("、")}`,
          planDigest: "",
        };
      }
      writeFileAtomic(E2E_ANNOTATION_PLAN_PATH, `${JSON.stringify(plan, null, 2)}\n`);
      return { ok: true, detail: "已原子写入隔离目录。", planDigest: segmentationPlanDigest(shape.plan) };
    },
  };

  const handle = await startAnnotationServer(session, {
    port: E2E_ANNOTATION_PORT,
    page: () => renderAnnotationShell(),
  });

  // 交接给 spec：**只有 URL**（token 在 fragment 里），不含任何正文
  mkdirSync(dirname(E2E_ANNOTATION_HANDOFF_PATH), { recursive: true });
  writeFileSync(
    E2E_ANNOTATION_HANDOFF_PATH,
    `${JSON.stringify({ url: handle.url, port: handle.port, boundAddress: handle.boundAddress }, null, 2)}\n`,
    "utf8",
  );

  console.log(`[e2e-server-annotation] 标注界面: http://${LOOPBACK_HOST}:${handle.port}/`);
  console.log(`[e2e-server-annotation] 计划隔离路径: ${E2E_ANNOTATION_PLAN_PATH}`);
  console.log(`[e2e-server-annotation] 合成正文页数: ${SYNTHETIC_PAGES.length}（非真实材料）`);

  // 常驻：由 Playwright 在套件结束时终止
  process.on("SIGINT", () => {
    void handle.close().then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error("[e2e-server-annotation] 启动失败：", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
