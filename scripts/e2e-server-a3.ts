#!/usr/bin/env node
/**
 * A3 受控接入工作台 · E2E 专用实例（端口 3285，完全隔离的合成环境）。
 *
 * ── 它构造的那个状态 ──
 *
 * 一份**合成源目录** + 一份**合成 canonical 真题库**，两者都在 `.e2e/` 下。
 * 工作台启动时：
 *
 * 1. 源根被**预置**进能力对象（因此 spec 不需要弹原生文件夹窗口）；
 * 2. 候选**尚未生成** —— 这正是 A1 → A2 那条断点的起点，spec 会自己走过去；
 * 3. 数据库是一个**全新库**（v9）—— 迁移路径由 `course-a3-proof` 在真实
 *    v8 库上覆盖；这里聚焦"完整用户路径"。
 *
 * ── 三条纪律 ──
 *
 * 1. **不传 `allowStale`**：陈旧一律失败关闭；
 * 2. **不 mock**：晋升 / 导入 / 建链全部调生产服务；
 * 3. **全部合成**：内容根、数据库、真题库都在 `.e2e/` 下，
 *    不碰 `private-content/`、不碰 `data/cet6.db`。
 *
 * ── 它写下的 handoff 文件 ──
 *
 * 只有 URL、token 与**相对标签**。绝不写绝对路径、绝不写课程正文。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import {
  E2E_A3_CONTENT_ROOT,
  E2E_A3_COURSE_ID,
  E2E_A3_DB_PATH,
  E2E_A3_HANDOFF_PATH,
  E2E_A3_PORT,
  E2E_A3_SOURCE_ROOT,
} from "../e2e/config";
import {
  A3_PAGE_PATH,
  newSessionToken,
  startAnnotationServer,
  type AnnotationSession,
  type IntakeCapability,
} from "@/content/course-pipeline/segment-server";
import { renderA3Shell } from "@/content/course-pipeline/a3-page";
import { renderAdjudicationShell } from "@/content/course-pipeline/adjudication-page";
import { renderAnnotationShell } from "@/content/course-pipeline/segment-page";
import { inspectSourceTree, runInspection } from "@/content/course-pipeline/inspection";
void runInspection;
void inspectSourceTree;
import { buildTextPdf, buildCjkPdf, writeSourceTree } from "./course-source-fixture";
import {
  FIXTURE_PASSAGE_A,
  FIXTURE_TRANSLATION_REFERENCE,
  FIXTURE_TRANSLATION_SOURCE,
} from "./course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";
import { createA3Capability } from "./a3-capability";

// ------------------------------------------------------------------ 清场
/*
 * ── 两条清场纪律（本轮修复的一个真实竞态）──
 *
 * 1. **`E2E_A3_CONTENT_ROOT` 只在 `E2E_RESET_DB=1` 时清**。
 *    早先它在**无条件**路径上（`rmSync(...)` 第 69 行），而
 *    `e2e-server-a3-companion.ts`（端口 3286）**同时**读同一个内容根与数据库。
 *    Playwright 的 webServer 是**并发启动**的，于是存在真实时序：
 *
 *        3286 读完内容根 → 3285 删掉它 → 3286 的 Next 实例持有已删除目录
 *
 *    那会让"跨进程读得到"这条验收时而失败时而通过 —— 一个由启动顺序决定的
 *    假失败。（它也是本轮观察到的 `0xC0000409` 崩溃的可疑来源之一：两个
 *    进程对同一目录做删除/遍历，而 Windows 上删除正被遍历的目录会失败。）
 *
 * 2. **`E2E_A3_SOURCE_ROOT` 是 3285 独占的**（合成源目录只被工作台读取），
 *    因此它可以在每次启动时重建 —— 那边不存在共享。
 *
 * 结论：只有**独占**的路径可以无条件重建；**共享**的路径只能由显式的
 * 清场开关（`E2E_RESET_DB=1`，由 `web-servers.ts` 施加在 3285 上）处理，
 * 且必须在两个实例都还没读它之前发生。
 */
if (process.env.E2E_RESET_DB === "1") {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${E2E_A3_DB_PATH}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });
}
// 独占路径：每次启动都重建（没有第二个进程读它）
rmSync(E2E_A3_SOURCE_ROOT, { recursive: true, force: true });
mkdirSync(dirname(E2E_A3_DB_PATH), { recursive: true });
mkdirSync(E2E_A3_CONTENT_ROOT, { recursive: true });

process.env.CET6_CONTENT_ROOT = E2E_A3_CONTENT_ROOT;
process.env.CET6_DB_PATH = E2E_A3_DB_PATH;

/*
 * ── 先把 profile 造出来 ──
 *
 * 课程伴随界面（`/practice/courses`）要求学习者已完成初始设置，否则它会
 * `redirect("/onboarding")`。若没有这一步，spec 里"打开伴界面看到课程"
 * 这条断言会落在一个跳转页面上 —— 那种失败与本次改动无关，却难以定位。
 *
 * 它同时给这个库建出完整的 v9 schema（A3 工作台随后写入课程索引）。
 */
function seedProfile(): void {
  const step = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", "scripts/seed-onboard.ts"],
    { stdio: "inherit", env: process.env },
  );
  if (step.status !== 0) {
    console.error("[e2e-server-a3] seed-onboard 失败");
    process.exit(1);
  }
}

// ------------------------------------------------------- 合成源目录（显眼可辨）
function buildSyntheticSource(root: string): void {
  const tree = new Map<string, Buffer>();
  const words = FIXTURE_PASSAGE_A.split(/\s+/).filter((word) => word !== "");
  tree.set(
    "阅读/reading-handout.pdf",
    buildTextPdf([
      [
        "SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL",
        "Passage One",
        "Questions 46 to 50 are based on the following passage.",
        ...words,
      ],
      ["Passage One Questions", "46. What did the synthetic researchers assume?", "A) A single synthetic spotlight."],
    ]),
  );
  const cjk = [...FIXTURE_TRANSLATION_SOURCE];
  tree.set(
    "翻译/translation-unit1.pdf",
    buildCjkPdf([
      ["【合成夹具】翻译练习 · 请勿当真", ...cjk.slice(0, 24), ...cjk.slice(24, 48), ...cjk.slice(48, 72)],
      ["参考译文", ...FIXTURE_TRANSLATION_REFERENCE.slice(0, 24)],
    ]),
  );

  /*
   * ── 第三个文件：**专供选择保真度的 E2E 排除** ──
   *
   * 前两个文件是"必须进候选"的基线。要证明"排除真的生效"，需要一个
   * 用户可以在界面上**去掉**、且去掉之后能被观测到的文件。
   *
   * 它的正文带唯一 ASCII 标记（`selection-marker-do-not-include`），
   * 因此 spec 可以在候选页面上断言"没有出现它"。全是 Latin-1，
   * 因为 `buildTextPdf` 刻意拒绝非 Latin-1 字符。
   */
  tree.set(
    "阅读/optional-handout.pdf",
    buildTextPdf([
      ["SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL", "selection-marker-do-not-include"],
    ]),
  );
  writeSourceTree(root, tree);
}

/**
 * 合成 canonical 真题库（`sourceKind` 由夹具构造器写死为 `test_fixture`）。
 *
 * ── 为什么写在**默认位置**而不是一个自定义目录 ──
 *
 * 因为 A3 能力里的门禁与预演调用的是 `buildIndexFromDisk()`（**无参数**），
 * 它解析 `<内容根>/cet6/papers` —— 也就是真实产品里真题包所在的位置。
 * 写到一个自定义目录再传 `papersDir` 会让 E2E 走一条**生产中不存在**的
 * 路径（生产启动器没有 `--papers-dir`），于是"合成库能跑通"就证明不了
 * "真实库能跑通"。
 */
function buildSyntheticPapers(contentRoot: string): void {
  for (let index = 0; index < 2; index += 1) {
    const id = `fixture-cet6-2024-12-set${index + 1}`;
    writeFixturePackage(
      contentRoot,
      id,
      buildFixturePackage({
        id,
        year: 2024,
        session: "December",
        variant: `set${index + 1}`,
        /*
         * 让仔细阅读的篇章**就是**课程源材料里那一篇（合成说明文）。
         *
         * 这样匹配器会基于**内容**提出真实建议 ⇒ 建链这一步在浏览器里
         * 才有可执行的状态。否则"没有可接受的建议"会让 A3-c 只能被验证为
         * 空路径 —— 而空路径不覆盖"写入不可变行"这条最重的语义。
         */
        carefulReadingPassage: FIXTURE_PASSAGE_A,
      }),
    );
  }
}

/**
 * 把合成真题包写入索引。
 *
 * ── 为什么必须先做这一步 ──
 *
 * `verifyCanonicalLink` 要求目标真题卷在索引中且内容版本精确匹配。
 * 没有它，A3-c 在原理上只能失败关闭 —— 于是"建链"这条路径永远走不到。
 */
async function seedPapersIntoIndex(): Promise<number> {
  const { getRepositories } = await import("@/repositories/sqlite");
  const { planImport, commitImport } = await import("@/services/paper-import");
  const repos = getRepositories();
  const plan = planImport(repos, { only: ["fixture-cet6-2024-12-set1", "fixture-cet6-2024-12-set2"] });
  if (plan.report.counts.rejected > 0) {
    for (const entry of plan.report.entries) {
      if (entry.decision !== "rejected") continue;
      console.error(`[e2e-server-a3] 真题夹具被拒 ${entry.packagePath}：`);
      for (const issue of entry.issues) console.error(`  ${issue.path}: ${issue.message}`);
    }
    process.exit(1);
  }
  const committed = commitImport(repos, plan);
  if (!committed.ok) {
    console.error(`[e2e-server-a3] 真题夹具导入失败：${committed.error}`);
    process.exit(1);
  }
  return committed.written;
}

async function main(): Promise<void> {
  seedProfile();
  buildSyntheticSource(E2E_A3_SOURCE_ROOT);
  buildSyntheticPapers(E2E_A3_CONTENT_ROOT);
  const papersWritten = await seedPapersIntoIndex();

  const token = newSessionToken();

  /**
   * 与生产启动器**同一份能力实现**（`scripts/a3-capability.ts`）。
   *
   * 刻意不在这里另写一份简化版：那样 spec 验证的就是一个**替身**，
   * 而生产路径可能完全不同步。这正是本项目在 A1 轮次付过代价的缺陷形态
   * （"真实子进程"用例用的是自带替身脚本）。
   */
  const capability: IntakeCapability = createA3Capability(E2E_A3_SOURCE_ROOT, null);

  const session: AnnotationSession = {
    token,
    courseId: "a3-e2e",
    sourceDigest: "",
    config: { courseId: "a3-e2e", sourceDigest: "", assets: [], existingPlan: null },
    savePlan() {
      return { ok: false, detail: "A3 工作台请在第 ⑤ 步保存人工裁决与分段计划。", planDigest: "" };
    },
    intake: capability,
  };

  const handle = await startAnnotationServer(session, {
    port: E2E_A3_PORT,
    page: () => renderAnnotationShell(),
    intakePage: () => renderAdjudicationShell(),
    a3Page: () => renderA3Shell(),
  });

  mkdirSync(dirname(E2E_A3_HANDOFF_PATH), { recursive: true });
  writeFileSync(
    E2E_A3_HANDOFF_PATH,
    `${JSON.stringify(
      {
        intakeUrl: `http://${handle.boundAddress}:${handle.port}/intake#token=${handle.token}`,
        a3Url: `http://${handle.boundAddress}:${handle.port}${A3_PAGE_PATH}#token=${handle.token}`,
        port: handle.port,
        boundAddress: handle.boundAddress,
        /** 合成源根的**目录名**（绝不含路径）。 */
        sourceLabel: capability.sourceLabel(),
        courseId: E2E_A3_COURSE_ID,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  console.log(`[e2e-server-a3] A3 工作台: http://${handle.boundAddress}:${handle.port}${A3_PAGE_PATH}`);
  console.log(`[e2e-server-a3] 合成源根已预置；候选尚未生成（spec 会自己走完整条路径）`);
  console.log(`[e2e-server-a3] 合成真题包已进索引：${papersWritten} 份（建链的前提）`);

  process.on("SIGINT", () => {
    try {
      rmSync(E2E_A3_HANDOFF_PATH, { force: true });
    } catch {}
    void handle.close().then(() => process.exit(0));
  });
}

main().catch((error: unknown) => {
  console.error("[e2e-server-a3] 启动失败：", error);
  process.exit(1);
});
