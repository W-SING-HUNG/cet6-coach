#!/usr/bin/env node
/**
 * **使用者 历史状态专用**服务器启动器（端口 3230 / 3231）。
 *
 * ── 它存在的唯一理由 ──
 *
 * 阅读收敛的验收对象是 使用者的**真实历史状态**：库里有一条更早生成、
 * 至今 pending、引用合成篇章 `reading_passage / read-city-trees` 的阅读任务，
 * 它出现在 Today 的「补做」区里，点下去**过去**会渲染合成文章。
 *
 * 主 E2E 实例（3199）无法复现这个状态：
 * planner 现在产出的全是 `reading_target`，因此主实例上根本没有"历史合成行"。
 * 而数据库被全部 spec 共享、按文件名字母序串行执行，于是早先的写法
 * 只能靠 `zz-` 前缀把 spec 排到最后 —— 那是**顺序依赖**，不是契约：
 * 单独跑、或先于其它 spec 跑，前提就不成立。
 *
 * 这个实例把状态**在启动时写死**，因此 spec 与其它 spec 之间零共享。
 *
 * ── 两种库存状态，两个端口 ──
 *
 * 它们对用户的含义不同、文案也必须不同，因此各自起一个实例：
 *
 * · `--mode=eligible`（3230）：库里有**可训练**的真实阅读大题
 *   → 历史任务应被投影成真实真题 CTA（F1），且不渲染重复入口（F2）。
 * · `--mode=reserved_only`（3231）：有卷子但**全部设为模考保留**
 *   → 历史任务应给出「被设为模考保留」这一具体原因，且不消耗保留材料。
 *
 * ── 数据诚实性 ──
 *
 * 写入的试卷全部由 `scripts/paper-fixture.ts` 构造，`sourceKind` 写死为
 * `test_fixture`（绝不冒充真题）；面内文字是明显的夹具文本
 * （`Fixture careful-reading passage.`），不含任何真题正文。
 * 因此本实例产出的截图**可以**提交进 Git，也没有版权问题。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { spawnSync } from "node:child_process";
import { spawnNext } from "./spawn-next";
import {
  E2E_LEGACY_CONTENT_ROOT,
  E2E_LEGACY_DB_PATH,
  E2E_LEGACY_PORT,
  E2E_LEGACY_RESERVED_CONTENT_ROOT,
  E2E_LEGACY_RESERVED_DB_PATH,
  E2E_LEGACY_RESERVED_PORT,
  E2E_LEGACY_PAPER_ID,
} from "../e2e/config";
import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";
import { ensurePlan } from "@/services/plan";
import { todayISO } from "@/lib/date";

const mode = process.env.LEGACY_MODE === "reserved_only" ? "reserved_only" : "eligible";
const reservedOnly = mode === "reserved_only";

const DB = reservedOnly ? E2E_LEGACY_RESERVED_DB_PATH : E2E_LEGACY_DB_PATH;
const CONTENT_ROOT = reservedOnly ? E2E_LEGACY_RESERVED_CONTENT_ROOT : E2E_LEGACY_CONTENT_ROOT;
const PORT = reservedOnly ? E2E_LEGACY_RESERVED_PORT : E2E_LEGACY_PORT;

// ------------------------------------------------------------------ 清库
if (process.env.E2E_RESET_DB === "1") {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${DB}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  rmSync(CONTENT_ROOT, { recursive: true, force: true });
}
mkdirSync(dirname(DB), { recursive: true });
mkdirSync(CONTENT_ROOT, { recursive: true });

process.env.CET6_CONTENT_ROOT = CONTENT_ROOT;
process.env.CET6_DB_PATH = DB;

// --------------------------------------------------- 写入夹具试卷并导入索引
/*
 * 只写一份卷子。reserved_only 模式下它会被设为 mock_reserve ——
 * 这正是要验证的"有材料但不该被日常训练消耗"的状态。
 */
writeFixturePackage(
  CONTENT_ROOT,
  "2024-12-set1",
  buildFixturePackage({
    id: E2E_LEGACY_PAPER_ID,
    year: 2024,
    session: "December",
    variant: "set1",
  }),
);

const { getRepositories } = await import("@/repositories/sqlite");
const { runImport } = await import("@/services/paper-import");

const imported = runImport(getRepositories(), { dryRun: false });
if (!imported.ok || imported.report.counts.rejected > 0) {
  console.error("[legacy-server] 夹具导入失败");
  process.exit(1);
}

// -------------------------------------------------- onboarding + 诊断
/*
 * 两步都必须完成，否则 /today 会重定向（实测踩过：只做 onboarding 时
 * /today 拍到的是诊断页）。复用既有 seed 脚本，不新写一套状态构造。
 */
for (const script of ["seed-onboard.ts", "seed-diagnostic.ts"]) {
  const step = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", `scripts/${script}`],
    { stdio: "inherit", env: process.env },
  );
  if (step.status !== 0) {
    console.error(`[legacy-server] ${script} 失败`);
    process.exit(1);
  }
}

// ---------------------------------------- 写入 **使用者的历史遗留阅读任务**
/*
 * 这一步是本实例的核心。它用**生产仓储路径**写一行真实形态的历史数据：
 *
 *   kind: reading_comprehension
 *   contentRef: { contentType: "reading_passage", contentId: "read-city-trees" }
 *   status: pending        ← 至今没做完，因此会出现在 Today 的「补做」区
 *
 * 注意这里**刻意不走 planner**：planner 现在只会产出 `reading_target`，
 * 而我们要的正是它**不会**再产出的那种历史行。用仓储直接写入是唯一诚实的
 * 构造方式 —— 它就是当年那条记录的形状。
 */
{
  const repos = getRepositories();
  const profile = repos.learner.getProfile();
  if (!profile) {
    console.error("[legacy-server] 没有 profile，无法写入历史任务");
    process.exit(1);
  }

  if (reservedOnly) {
    // 唯一那份卷子设为模考保留 → 今天没有任何可训练的真实阅读大题
    repos.papers.setPool(E2E_LEGACY_PAPER_ID, "mock_reserve");
  }

  /*
   * 历史日期：写在前两天，这样它同时满足两个条件 ——
   * 1. 属于"以前安排了但没完成的核心任务"，会进入 Today 的**补做**区；
   * 2. 不会被今天的 planner 重排覆盖掉（重排只动今天的行）。
   */
  const historicalDate = new Date();
  historicalDate.setDate(historicalDate.getDate() - 2);
  const iso = `${historicalDate.getFullYear()}-${String(historicalDate.getMonth() + 1).padStart(2, "0")}-${String(historicalDate.getDate()).padStart(2, "0")}`;

  repos.plan.savePlan(profile.id, {
    date: iso,
    availableMinutes: 60,
    plannedForMinutes: 12,
    generatedBy: "deterministic_planner",
    notes: [],
    warnings: [],
    tasks: [
      {
        id: "legacy-synthetic-reading-task",
        kind: "reading_comprehension",
        skill: "reading",
        priority: "core",
        // 这句标题就是 使用者 在截图上看到的那句
        title: "阅读训练 12 分钟",
        rationale: "历史遗留：本次收敛之前生成的合成阅读任务。",
        estimatedMinutes: 12,
        contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
        status: "pending",
        order: 0,
      },
    ],
  });

  /*
   * 先写**已完成**的历史合成阅读任务（F9 的验收对象）。
   *
   * 它代表真实发生过的事：用户在旧合成体系下做了一份合成阅读题并完成了它。
   * 产品**不得**把它重新标记为真实真题 —— 那是伪造 provenance。
   *
   * ── 顺序很关键（实测踩到）──
   *
   * 它必须写在**今天**这一天（当天计划里已完成的任务会被 `ensurePlan` 保留，
   * 因此它能出现在 Today 上供断言），而且必须在下面的 force 重排**之前**写好 ——
   * `savePlan` 会**整体替换**该日的任务列表，若写在重排之后，
   * 它会把刚补做进来的历史任务一起抹掉（实测：Today 上什么都看不到了）。
   */
  repos.plan.savePlan(profile.id, {
    date: todayISO(),
    availableMinutes: 60,
    plannedForMinutes: 12,
    generatedBy: "deterministic_planner",
    notes: [],
    warnings: [],
    tasks: [
      {
        id: "legacy-completed-synthetic-reading",
        kind: "reading_comprehension",
        skill: "reading",
        priority: "core",
        title: "阅读训练 12 分钟",
        rationale: "历史遗留：本次收敛之前完成的合成阅读任务。",
        estimatedMinutes: 12,
        contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
        status: "completed",
        order: 0,
      },
    ],
  });

  /*
   * 再强制重排今天：`ensurePlan` 会保留已完成条目，同时把那条逾期的
   * pending 历史任务补做进来 —— 两种历史状态于是同时出现在 Today 上。
   */
  ensurePlan(repos, profile.id, todayISO(), { force: true });

  console.log(
    `[legacy-server] 已写入历史合成阅读任务（补做 pending + 已完成各一条，mode=${mode}，paper pool=${
      repos.papers.getPaper(E2E_LEGACY_PAPER_ID)?.pool ?? "?"
    }）`,
  );
}

// ------------------------------------------------------------------ 启动
console.log(`[legacy-server] DB: ${DB}`);
console.log(`[legacy-server] CONTENT_ROOT: ${CONTENT_ROOT}`);
console.log(`[legacy-server] PORT: ${PORT}`);

// 只绑定回环：合成实例绝不对局域网开放（集中边界见 src/proxy.ts）
// CET6_LOCAL_ORIGIN 让"精确同一来源"守卫知道本实例的可信来源
const result = spawnNext("start", PORT, {
  stdio: "inherit",
  env: { ...process.env, CET6_LOCAL_ORIGIN: `http://${LOOPBACK_HOST}:${PORT}` },
});
process.exit(result.status ?? 0);
