#!/usr/bin/env node
/**
 * **重复逾期别名专用**服务器启动器（端口 3260）。
 *
 * ── 它存在的唯一理由 ──
 *
 * 复现一个**用户可见**的症状：库里存在多条指向**同一份真实材料**的逾期历史条目时，
 * 系统把"当天可用时间"算成不够用，于是 Today 显示一个被压空（或几乎压空）的计划。
 *
 * 实测（60 分钟日 / 10 条别名）：计划占用只剩 7 分钟、47 分钟被白白闲置；
 * 30 分钟日直接归零 —— 而可用时间与可执行内容都一直在。
 *
 * 主实例无法复现这个状态：它的任务全部由 planner 生成，产出的都是
 * `reading_target`，不会出现"多条别名指向同一目标"。
 * legacy 实例（3230）也不行：它刻意只写**一条**别名，
 * 因为它的断言是围绕单条历史行建立的。
 *
 * 因此这里把状态**在启动时写死**，与其它 spec 之间零共享状态
 * （同一个根因与同一条纪律）。
 *
 * ── 数据诚实性 ──
 *
 * 试卷全部由 `scripts/paper-fixture.ts` 构造，`sourceKind` 写死为
 * `test_fixture`（绝不冒充真题）；面内文字是明显的夹具文本。
 * 本实例不碰 `private-content/`，也不碰 `data/cet6.db`。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { spawnSync } from "node:child_process";
import { spawnNext } from "./spawn-next";
import {
  E2E_DUPLICATE_ALIAS_COUNT,
  E2E_DUPLICATE_CONTENT_ROOT,
  E2E_DUPLICATE_DAY_MINUTES,
  E2E_DUPLICATE_DB_PATH,
  E2E_DUPLICATE_PAPER_ID,
  E2E_DUPLICATE_PORT,
} from "../e2e/config";
import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";
import { ensurePlan } from "@/services/plan";
import { todayISO } from "@/lib/date";

const DB = E2E_DUPLICATE_DB_PATH;
const CONTENT_ROOT = E2E_DUPLICATE_CONTENT_ROOT;
const PORT = E2E_DUPLICATE_PORT;

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
writeFixturePackage(
  CONTENT_ROOT,
  "2024-12-set1",
  buildFixturePackage({
    id: E2E_DUPLICATE_PAPER_ID,
    year: 2024,
    session: "December",
    variant: "set1",
  }),
);

const { getRepositories } = await import("@/repositories/sqlite");
const { runImport } = await import("@/services/paper-import");

const imported = runImport(getRepositories(), { dryRun: false });
if (!imported.ok || imported.report.counts.rejected > 0) {
  console.error("[duplicate-server] 夹具导入失败");
  process.exit(1);
}

// -------------------------------------------------- onboarding + 诊断
/*
 * 两步都必须完成，否则 /today 会重定向。
 * 复用既有 seed 脚本，不新写一套状态构造。
 */
for (const script of ["seed-onboard.ts", "seed-diagnostic.ts"]) {
  const step = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", `scripts/${script}`],
    { stdio: "inherit", env: process.env },
  );
  if (step.status !== 0) {
    console.error(`[duplicate-server] ${script} 失败`);
    process.exit(1);
  }
}

// ---------------------------------------- 写入 N 条**重复的**逾期历史别名
{
  const repos = getRepositories();
  const profile = repos.learner.getProfile();
  if (!profile) {
    console.error("[duplicate-server] 没有 profile，无法写入历史别名");
    process.exit(1);
  }

  /*
   * 每一条别名都引用**同一份**旧合成篇章 `read-city-trees`。
   *
   * 它们因此会被投影到**同一个** canonical 真实目标 —— 这正是缺陷的触发条件：
   * 同一份材料被当成了 N 份独立工作量。
   *
   * 逐条写在**不同日期**上：`savePlan` 会整体替换某一天的任务列表，
   * 写同一天只会剩下最后一条（实测踩到）。
   * 这些日期都早于今天，因此全部进入 Today 的「补做」区。
   */
  for (let i = 0; i < E2E_DUPLICATE_ALIAS_COUNT; i += 1) {
    const d = new Date();
    d.setDate(d.getDate() - (i + 2)); // 从两天前开始，逐条往前
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

    repos.plan.savePlan(profile.id, {
      date: iso,
      availableMinutes: 60,
      plannedForMinutes: 3,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        {
          id: `overdue-alias-${i}`,
          kind: "reading_comprehension",
          skill: "reading",
          priority: "core",
          title: "阅读训练 3 分钟",
          rationale: "历史遗留：本次收敛之前生成的合成阅读任务。",
          estimatedMinutes: 3,
          contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
          status: "pending",
          order: 0,
        },
      ],
    });
  }

  /*
   * ── 把今天的可用时间固定为 30 分钟（让断言**因果紧致**的关键）──
   *
   * 评审复现给出三档数据，其中 30 分钟日是**症状最极端**的一档：
   *
   *   30 分钟日 + 10 条别名 ⇒ 计划占用 **0**（系统声称时间不够）
   *
   * 因此在这个实例上，"计划占用 > 0" 不是随手挑的下界，
   * 而正是缺陷会打破的那条线 —— 缺陷形态下当天排不出任何内容。
   *
   * 先写今天这一行（`ensurePlan(force)` 会沿用 `existing.availableMinutes`），
   * 再强制重排。
   */
  repos.plan.savePlan(profile.id, {
    date: todayISO(),
    availableMinutes: E2E_DUPLICATE_DAY_MINUTES,
    plannedForMinutes: 0,
    generatedBy: "deterministic_planner",
    notes: [],
    warnings: [],
    tasks: [],
  });

  ensurePlan(repos, profile.id, todayISO(), { force: true });

  console.log(
    `[duplicate-server] 已写入 ${E2E_DUPLICATE_ALIAS_COUNT} 条指向同一目标的逾期别名` +
      `（今天可用 ${E2E_DUPLICATE_DAY_MINUTES} 分钟）`,
  );
}

// ------------------------------------------------------------------ 启动
console.log(`[duplicate-server] DB: ${DB}`);
console.log(`[duplicate-server] CONTENT_ROOT: ${CONTENT_ROOT}`);
console.log(`[duplicate-server] PORT: ${PORT}`);

// 只绑定回环：合成实例绝不对局域网开放（集中边界见 src/proxy.ts）
// CET6_LOCAL_ORIGIN 让"精确同一来源"守卫知道本实例的可信来源
const result = spawnNext("start", PORT, {
  stdio: "inherit",
  env: { ...process.env, CET6_LOCAL_ORIGIN: `http://${LOOPBACK_HOST}:${PORT}` },
});
process.exit(result.status ?? 0);
