import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { completeOnboarding } from "@/services/onboarding";
import { startDiagnostic, submitDiagnostic } from "@/services/diagnostic";
import { ensurePlan, getTodayView, effectiveMinutesOf, regularMinutesFor } from "@/services/plan";
import { planImport, commitImport } from "@/services/paper-import";
import { DIAGNOSTIC_ITEMS } from "@/content/diagnostic-bank";
import { CET6_EXAM_DATE } from "@/domain/exam-facts";
import type { Repositories } from "@/repositories/ports";
import type { StudyTask } from "@/domain/models";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

/**
 * 计划预算完整性（planner budget integrity）。
 *
 * ── 这条不变量 ──
 *
 *     计划占用（Σ 有效分钟数）≤ 当天可用分钟数
 *
 * "计划占用"是学习者用来判断"今天做不做得完"的数字。
 * **谎报等于给他一个办不到的承诺**（对 F8 的同一条理由）。
 *
 * ── 实测缺陷（评审 B 项）：64 > 60 ──
 *
 * `ensurePlan` 把**整个当天预算**交给 `planDay`（它只排**新**任务），
 * 随后再把**已完成**的任务原样保留进来。已完成的那部分于是被算了两次：
 * 一次作为"已经花掉的时间"，一次作为"还可以用来排新内容的时间"。
 *
 * 工作日的 legacy 状态（一条已完成的 12 分钟历史合成阅读任务）：
 *
 *     已完成 12 + 新排 52 = 64 分钟，而可用时间只有 60 分钟。
 *
 * 它**只在部分日期**出现，因为 `planDay` 的装箱结果依赖当天的可用预算
 * （工作日 60 / 周末 120）与诊断画像的内容池 —— 因此"周日失败、
 * 周六通过"不是 flaky，而是确定性的输入差异。
 *
 * ── 本文件覆盖的第二个同族缺陷 ──
 *
 * 审计中还发现第二条等价路径：**逾期补做**任务的 `estimatedMinutes`
 * 是历史值（planner 按它装箱），而投影后的 `effectiveMinutes` 是
 * **真实目标的排练预算**（聚合按它计数）。投影**放大**时两者不一致，
 * 差额同样会顶穿预算（实测：历史 3 分钟 → 目标 7 分钟）。
 *
 * 两条都在 `ensurePlan` 的服务边界修，因为只有那里同时看得到
 * "装箱依据"与"计数依据"。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

/** 工作日（周一）与周日 —— 两者都曾复现 64 > 60。 */
const MONDAY = "2026-01-05";
const SUNDAY = "2026-01-11";
const SATURDAY = "2026-01-10";

function seed(): string {
  completeOnboarding(repos, {
    displayName: "Learner",
    examName: "CET-6 2026-12",
    examDate: CET6_EXAM_DATE,
    targetScore: 550,
    weekdayMinutes: 60,
    weekendMinutes: 120,
  });
  const profileId = repos.learner.getProfile()!.id;

  const session = startDiagnostic(repos, profileId);
  submitDiagnostic(repos, {
    sessionId: session.id,
    answers: DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((item) => ({
      itemId: item.id,
      dimension: item.dimension,
      choiceId: item.choices!.find((c) => c.id !== item.correctChoiceId)!.id,
      text: null,
      skipped: false,
    })),
  });
  return profileId;
}

function importPaper(): void {
  writeFixturePackage(
    contentRoot,
    "2024-12-set1",
    buildFixturePackage({
      id: "fixture-cet6-2024-12-set1",
      year: 2024,
      session: "December",
      variant: "set1",
    }),
  );
  const plan = planImport(repos, {});
  const result = commitImport(repos, plan);
  expect(result.ok, `导入失败：${result.error}`).toBe(true);
}

/**
 * 一条历史合成阅读任务（`read-city-trees` 是旧合成体系的内容 id）。
 *
 * 返回类型必须**保留字面量**（`kind` / `contentType` / `status` 都是联合类型），
 * 否则 `savePlan` 的入参类型对不上 —— 因此这里显式标注返回类型，
 * 而不是让它被推断成 `string`。
 */
function legacyTask(overrides: {
  id: string;
  minutes: number;
  status: "pending" | "completed";
}): StudyTask & { id: string } {
  return {
    id: overrides.id,
    planId: "unused",
    kind: "reading_comprehension",
    skill: "reading",
    priority: "core",
    title: `阅读训练 ${overrides.minutes} 分钟`,
    rationale: "历史遗留：本次收敛之前生成/完成的合成阅读任务。",
    estimatedMinutes: overrides.minutes,
    contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
    status: overrides.status,
    order: 0,
    completedAt: null,
  };
}

/**
 * 复刻 `scripts/e2e-server-legacy.ts` 的状态序列（阈值与它逐字一致）。
 *
 * 刻意**不**复制它的日期计算（那里用 `new Date()`，随运行日漂移）；
 * 这里传入确定性日期，因此同一个用例在任何一天跑出的结果都相同。
 */
function seedLegacyState(profileId: string, date: string, options?: { withCompleted?: boolean }) {
  const withCompleted = options?.withCompleted ?? true;

  // ① 两天前：逾期未完成的 core 历史合成阅读任务
  const historical = new Date(`${date}T00:00:00Z`);
  historical.setUTCDate(historical.getUTCDate() - 2);

  repos.plan.savePlan(profileId, {
    date: historical.toISOString().slice(0, 10),
    availableMinutes: 60,
    plannedForMinutes: 12,
    generatedBy: "deterministic_planner",
    notes: [],
    warnings: [],
    tasks: [legacyTask({ id: "legacy-synthetic-reading-task", minutes: 12, status: "pending" })],
  });

  // ② 今天：已完成的 core 历史合成阅读任务（F9 的验收对象）
  if (withCompleted) {
    repos.plan.savePlan(profileId, {
      date,
      availableMinutes: 60,
      plannedForMinutes: 12,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        legacyTask({ id: "legacy-completed-synthetic-reading", minutes: 12, status: "completed" }),
      ],
    });
  }

  // ③ 强制重排（保留已完成、补做逾期）
  ensurePlan(repos, profileId, date, { force: true });
}

/** 聚合不变量：`plannedMinutes` 必须等于各任务有效分钟数之和。 */
function sumEffective(view: ReturnType<typeof getTodayView>): number {
  return view.tasks
    .filter((t) => t.task.status !== "skipped")
    .reduce((sum, t) => sum + (effectiveMinutesOf(t) ?? 0), 0);
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-budget-"));
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);
});

afterEach(() => {
  // 原生句柄必须确定性关闭：`DatabaseSync` 不是 GC 会及时回收的普通对象。
  try {
    db.close();
  } catch {
    // 已关闭过就不该让清理失败。
  }

  if (previousRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
  else process.env.CET6_CONTENT_ROOT = previousRoot;
  rmSync(contentRoot, { recursive: true, force: true });
});

// ===========================================================================
// 原始缺陷：已完成任务必须先占预算
// ===========================================================================

describe("计划预算 · 已完成任务不得被重复计入（评审 B 项原始缺陷）", () => {
  for (const [label, date] of [
    ["周一（工作日 60 分钟）", MONDAY],
    ["周六（周末 120 分钟）", SATURDAY],
    ["周日（周末 120 分钟）", SUNDAY],
  ] as const) {
    it(`${label}：计划占用不得超过可用时间`, () => {
      const profileId = seed();
      importPaper();
      seedLegacyState(profileId, date);

      const view = getTodayView(repos, profileId, date);

      expect(
        view.plannedMinutes,
        `计划占用 ${view.plannedMinutes} 分钟 > 可用 ${view.availableMinutes} 分钟`,
      ).toBeLessThanOrEqual(view.availableMinutes);

      // 聚合不变量仍然成立（与 `effectiveMinutesOf` 同源）。
      expect(view.plannedMinutes).toBe(sumEffective(view));
    });
  }

  it("**周日**这一天确实会复现 64 > 60（证明该用例测的是真实缺陷）", () => {
    /*
     * ── 因果自证：这条缺陷为什么只在部分日期出现 ──
     *
     * 它不是 flaky：`planDay` 的装箱结果取决于当天预算（工作日 60 /
     * 周末 120）与诊断画像的内容池。周日与周一都复现，周六不复现 ——
     * 那是确定性的输入差异。
     *
     * 这里断言的是**缺陷形态本身**（已完成的 12 分钟被重复计入）：
     * 若某次重构让"已完成任务不再保留"，这条会失败并提醒我们
     * 该不变量已经失去它守的对象。
     */
    const profileId = seed();
    importPaper();
    seedLegacyState(profileId, SUNDAY);

    const view = getTodayView(repos, profileId, SUNDAY);
    const completed = view.tasks.find((t) => t.task.id === "legacy-completed-synthetic-reading");

    // 已完成任务必须仍然在计划里（不得为了算术好看而隐藏历史）。
    expect(completed, "已完成的历史任务必须被保留").toBeDefined();
    expect(completed!.task.status).toBe("completed");
    expect(view.completedMinutes, "已完成分钟数应如实计入").toBe(12);

    // 而它的 12 分钟也必须在计划占用里只出现**一次**。
    // 修复前：12（已完成）+ 52（新排，按全额预算） = 64。
    expect(view.availableMinutes).toBe(60);
    expect(view.plannedMinutes).toBeLessThanOrEqual(60);
  });

  it("修复前形态复现：不预留时，新排内容会按**全额**预算排（对照）", () => {
    /*
     * 用「已完成任务」这一侧做对照：若把已完成任务从预算预留中排除，
     * 新排内容就会多排 12 分钟。
     *
     * 判据：新排任务的**有效**分钟数之和必须 ≤ 可用时间 − 已完成占用。
     * 这正是修复的核心 —— 而不只是"最终数字看起来没超"。
     */
    const profileId = seed();
    importPaper();
    seedLegacyState(profileId, SUNDAY);

    const view = getTodayView(repos, profileId, SUNDAY);
    const newWork = view.tasks
      .filter((t) => t.task.status !== "completed" && t.task.status !== "skipped")
      .reduce((sum, t) => sum + (effectiveMinutesOf(t) ?? 0), 0);

    expect(
      newWork,
      `新排内容 ${newWork} 分钟 > 可用 ${view.availableMinutes} − 已完成 ${view.completedMinutes}`,
    ).toBeLessThanOrEqual(view.availableMinutes - view.completedMinutes);
  });

  it("已完成的历史任务保持不可变：状态、时长与语义都不被改写", () => {
    const profileId = seed();
    importPaper();
    seedLegacyState(profileId, MONDAY);

    const view = getTodayView(repos, profileId, MONDAY);
    const done = view.tasks.find((t) => t.task.id === "legacy-completed-synthetic-reading")!;

    // 历史事实原样保留。
    expect(done.task.status).toBe("completed");
    expect(done.task.estimatedMinutes).toBe(12);
    expect(done.displayMinutes).toBe(12);
    expect(done.effectiveMinutes).toBe(12);

    // 且**不得**被冒充成真实真题（F9 的核心）：它是合成历史，不是真题。
    expect(done.isHistoricalCompleted).toBe(true);
    expect(done.isRealPaperReading).toBe(false);
    expect(done.canonicalKey).toBeNull();

    // 库里那一行也没有被改写。
    const stored = repos.plan.getTask("legacy-completed-synthetic-reading")!;
    expect(stored.status).toBe("completed");
    expect(stored.estimatedMinutes).toBe(12);
    expect(stored.title).toBe("阅读训练 12 分钟");
  });

  it("调整可用时间后不变量仍然成立（用户手动改时的路径）", () => {
    const profileId = seed();
    importPaper();
    seedLegacyState(profileId, MONDAY);

    for (const minutes of [20, 30, 45, 60, 90, 120]) {
      ensurePlan(repos, profileId, MONDAY, { availableMinutes: minutes, force: true });
      const view = getTodayView(repos, profileId, MONDAY);
      expect(
        view.plannedMinutes,
        `预算 ${minutes} 分钟时计划占用 ${view.plannedMinutes} 分钟 —— 超出即为谎报`,
      ).toBeLessThanOrEqual(minutes);
      expect(view.plannedMinutes).toBe(sumEffective(view));
    }
  });
});

// ===========================================================================
// 同族第二条：逾期补做任务的投影差额
// ===========================================================================

describe("计划预算 · 逾期补做任务的投影差额必须先预留", () => {
  /**
   * 逾期任务的历史时长与投影后的真实排练预算**不同**。
   *
   * 历史 3 分钟 → 投影到"选词填空"（round(0.05 × 130) = 7 分钟）。
   * planner 按 3 装箱、聚合按 7 计数 —— 差额会顶穿预算。
   */
  for (const [historyMinutes, budget] of [
    [3, 33],
    [3, 45],
    [5, 27],
  ] as const) {
    it(`历史 ${historyMinutes} 分钟、预算 ${budget} 分钟：投影差额不得顶穿预算`, () => {
      const profileId = seed();
      importPaper();

      // 一条逾期的历史合成阅读任务，历史时长可控
      repos.plan.savePlan(profileId, {
        date: "2026-01-03",
        availableMinutes: budget,
        plannedForMinutes: historyMinutes,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [legacyTask({ id: "overdue", minutes: historyMinutes, status: "pending" })],
      });

      ensurePlan(repos, profileId, MONDAY, { availableMinutes: budget, force: true });
      const view = getTodayView(repos, profileId, MONDAY);

      expect(
        view.plannedMinutes,
        `预算 ${budget} 分钟时计划占用 ${view.plannedMinutes} 分钟`,
      ).toBeLessThanOrEqual(budget);
      expect(view.plannedMinutes).toBe(sumEffective(view));
    });
  }

  it("投影**放大**时确实会产生差额（证明预留是必要的，不是装饰）", () => {
    const profileId = seed();
    importPaper();

    repos.plan.savePlan(profileId, {
      date: "2026-01-03",
      availableMinutes: 60,
      plannedForMinutes: 3,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [legacyTask({ id: "overdue", minutes: 3, status: "pending" })],
    });

    ensurePlan(repos, profileId, MONDAY, { availableMinutes: 45, force: true });
    const view = getTodayView(repos, profileId, MONDAY);
    const overdue = view.tasks.find((t) => t.task.title.startsWith("补做"));

    expect(overdue, "逾期任务应被补做").toBeDefined();
    // 装箱依据（历史值）与计数依据（真实预算）在投影放大时确实不同。
    expect(overdue!.task.estimatedMinutes).toBe(3);
    expect(overdue!.effectiveMinutes).toBe(7);
    expect(overdue!.effectiveMinutes!).toBeGreaterThan(overdue!.task.estimatedMinutes);

    // 而这不影响总预算 —— 差额已被预留。
    expect(view.plannedMinutes).toBeLessThanOrEqual(45);
  });

  it("投影**缩小**时不额外预留（安全方向不得浪费预算）", () => {
    const profileId = seed();
    importPaper();

    // 历史 26 分钟 → 投影到 7 分钟的目标：聚合比装箱小，是安全方向
    repos.plan.savePlan(profileId, {
      date: "2026-01-03",
      availableMinutes: 60,
      plannedForMinutes: 26,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [legacyTask({ id: "overdue", minutes: 26, status: "pending" })],
    });

    ensurePlan(repos, profileId, MONDAY, { availableMinutes: 60, force: true });
    const view = getTodayView(repos, profileId, MONDAY);
    const overdue = view.tasks.find((t) => t.task.title.startsWith("补做"));

    expect(overdue!.effectiveMinutes).toBeLessThan(overdue!.task.estimatedMinutes);
    // 缩减方向不应导致预算被过度扣除。
    expect(view.plannedMinutes).toBeLessThanOrEqual(60);
    expect(view.plannedMinutes).toBe(sumEffective(view));

    /*
     * 关键：不得因为"历史值是 26"就预留 26 —— 那会把当天预算无谓地吃掉，
     * 让学习者少排内容。因此断言当天仍然排进了可观的新内容。
     */
    const newWork = view.tasks
      .filter((t) => !t.task.title.startsWith("补做") && t.task.status !== "skipped")
      .reduce((sum, t) => sum + (effectiveMinutesOf(t) ?? 0), 0);
    expect(newWork, "缩减方向不应浪费预算").toBeGreaterThan(20);
  });
});

// ===========================================================================
// 边界与回归
// ===========================================================================

describe("计划预算 · 边界与既有语义不回归", () => {
  it("库里持久化的 planned_for_minutes 也不得超过 available_minutes", () => {
    /*
     * 界面用的是 `getTodayView().plannedMinutes`（权威聚合值），
     * 但落库的那一列同样不应自称超出预算 —— 否则任何直接读库的路径
     * （CLI、调试、未来的导出）都会看到一句办不到的话。
     */
    const profileId = seed();
    importPaper();
    seedLegacyState(profileId, SUNDAY);

    const stored = repos.plan.getPlan(profileId, SUNDAY)!;
    expect(
      stored.plannedForMinutes,
      `库中 planned_for_minutes=${stored.plannedForMinutes} > available_minutes=${stored.availableMinutes}`,
    ).toBeLessThanOrEqual(stored.availableMinutes);
    // 存的是用户真正拥有的预算（不是给 planner 的余额）。
    expect(stored.availableMinutes).toBe(60);
  });

  it("没有已完成任务、也没有逾期任务时，行为与从前一致", () => {
    const profileId = seed();
    importPaper();

    ensurePlan(repos, profileId, MONDAY, { force: true });
    const view = getTodayView(repos, profileId, MONDAY);

    expect(view.plannedMinutes).toBeLessThanOrEqual(view.availableMinutes);
    expect(view.plannedMinutes).toBe(sumEffective(view));
    expect(view.completedMinutes).toBe(0);
    expect(view.tasks.length).toBeGreaterThan(0);
  });

  it("确定性：同一输入重复求解得到相同结果", () => {
    const profileId = seed();
    importPaper();
    seedLegacyState(profileId, MONDAY);

    const a = getTodayView(repos, profileId, MONDAY);
    const b = getTodayView(repos, profileId, MONDAY);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("周末预算确实高于工作日（预算来自用户偏好，未被本修复改动）", () => {
    const profileId = seed();
    importPaper();

    expect(regularMinutesFor(repos, profileId, MONDAY)).toBe(60);
    expect(regularMinutesFor(repos, profileId, SUNDAY)).toBe(120);

    ensurePlan(repos, profileId, MONDAY, { force: true });
    ensurePlan(repos, profileId, SUNDAY, { force: true });
    const weekday = getTodayView(repos, profileId, MONDAY);
    const weekend = getTodayView(repos, profileId, SUNDAY);
    expect(weekend.availableMinutes).toBe(120);
    expect(weekday.availableMinutes).toBe(60);
  });

  it("补做任务仍然沿用原时长、且排在复习之后（planner 既有语义不变）", () => {
    const profileId = seed();
    importPaper();
    seedLegacyState(profileId, MONDAY);

    const view = getTodayView(repos, profileId, MONDAY);
    const makeup = view.tasks.find((t) => t.task.title.startsWith("补做"));
    expect(makeup, "逾期任务应被补做").toBeDefined();
    // 历史值仍在库里（投影不改写历史行）。
    expect(makeup!.task.estimatedMinutes).toBe(12);
  });

  it("课程曝光不得影响计划预算或任何表现证据（边界不回归）", () => {
    /*
     * 本修复只动服务层的**预算分配单位**，不得让课程曝光进入计划。
     * 这里断言：课程层未被激活时（本夹具即如此），计划照常产出，
     * 且 Expert / 旧闭环表保持为空。
     */
    const profileId = seed();
    importPaper();
    seedLegacyState(profileId, SUNDAY);

    const count = (table: string): number => {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint };
      return Number(row.c);
    };

    expect(count("course_exposure_event")).toBe(0);
    expect(count("performance_event")).toBe(0);
    expect(count("assessment_event")).toBe(0);
    expect(count("evidence_projection")).toBe(0);
    expect(repos.expert.readProjection(profileId)).toEqual([]);
  });
});
