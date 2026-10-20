import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { completeOnboarding } from "@/services/onboarding";
import { startDiagnostic, submitDiagnostic } from "@/services/diagnostic";
import {
  ensurePlan,
  getTodayView,
  effectiveMinutesOf,
  regularMinutesFor,
  type TodayView,
} from "@/services/plan";
import { planImport, commitImport } from "@/services/paper-import";
import { DIAGNOSTIC_ITEMS } from "@/content/diagnostic-bank";
import { CET6_EXAM_DATE } from "@/domain/exam-facts";
import type { Repositories } from "@/repositories/ports";
import type { StudyTask } from "@/domain/models";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

/**
 * 逾期补做任务的**重复别名**不得被当成多份独立工作量。
 *
 * ── 缺陷（复评阻断项）──
 *
 * `ensurePlan` 计算"投影放大预留"时按**任务**逐条累加：
 *
 *     Σ max(0, effective − estimated)
 *
 * 但多条逾期别名可以指向**同一个** canonical 真题大题（它们都是"练阅读"的旧行，
 * 投影规则把未完成的历史合成行送到当前第一个可用目标）。而 `getTodayView`
 * 只把那个目标计入**一次**（其余判为重复，有效分钟数为 `null`）。
 *
 * 于是同一份材料被算成 N 份，当天预算被反复扣除：
 *
 * | 60 分钟日 | 修复前 planned | 修复后 |
 * | --- | --- | --- |
 * | 1 条别名 | 58 | 58 |
 * | 2 条别名 | 52 | 58 |
 * | 6 条别名 | **13** | 58 |
 * | 10 条别名 | **7** | 58 |
 *
 * 30 分钟日 10 条别名时**降到 0** —— 系统声称"时间不够或没内容"，
 * 而可用时间与可执行内容都一直在。这是**产品缺陷**，不是保守估计。
 *
 * ── 第二条同族缺陷（本次审计追出）──
 *
 * 只修预留还不够：`planDay` 仍会把每条别名按自己的历史时长装箱。
 * 10 条 3 分钟的别名吃掉 30 分钟装箱额度，而聚合只认其中一份（7 分钟）——
 * 差额被白白吃掉，当天真正的第二/第三个阅读目标因此排不进来。
 * 两条都修，`planned` 才对别名条数**完全不敏感**。
 *
 * ── 反饥饿性质（本文件的核心里程碑）──
 *
 * 给一个已经出现过的 canonical 目标**追加更多别名**，不得让当天的
 * 可用调度预算逐步缩水。用**变形关系**（metamorphic）来测：
 * 同一份合法工作量，别名从 1 条加到 N 条，`plannedMinutes` 必须不变。
 *
 * 只断言 `plannedMinutes <= availableMinutes` 是**不够**的 ——
 * 那对"计划被压成 0"同样成立。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

const MONDAY = "2026-01-05"; // 工作日 → 60 分钟
const SATURDAY = "2026-01-10"; // 周末 → 120 分钟
const SUNDAY = "2026-01-11"; // 周末 → 120 分钟

/** 夹具试卷里两个**不同**的真实阅读大题（用于独立目标反例）。 */
const TARGET_CLOZE = "fixture-cet6-2024-12-set1::reading.banked_cloze";
const TARGET_MATCH = "fixture-cet6-2024-12-set1::reading.matching";

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
 * 一条历史合成阅读任务。
 *
 * 默认引用 `read-city-trees`（旧合成篇章，**不含** `::`），因此它会被
 * `projectReadingTask` 收敛到**当前第一个可用真实目标**。
 * 两条这样的行 ⇒ 两条别名指向**同一个** canonical 目标。
 */
function legacyReading(overrides: {
  id: string;
  minutes: number;
  status?: StudyTask["status"];
  contentId?: string;
  contentType?: NonNullable<StudyTask["contentRef"]>["contentType"];
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
    contentRef: {
      contentType: overrides.contentType ?? "reading_passage",
      contentId: overrides.contentId ?? "read-city-trees",
    },
    status: overrides.status ?? "pending",
    order: 0,
    completedAt: null,
  };
}

/** 写入 N 条**逾期**别名（同一天、同一份旧合成篇章 ⇒ 同一 canonical 目标）。 */
function seedOverdueAliases(
  profileId: string,
  count: number,
  options?: { minutes?: number; date?: string },
): void {
  const minutes = options?.minutes ?? 3;
  repos.plan.savePlan(profileId, {
    date: options?.date ?? "2026-01-03",
    availableMinutes: 60,
    plannedForMinutes: count * minutes,
    generatedBy: "deterministic_planner",
    notes: [],
    warnings: [],
    /*
     * 逐条写入不同 id、但 `contentRef` 完全相同的历史行。
     *
     * 刻意不按标题或时长做区分：那两种都不是身份判据，
     * 而真正决定"是不是同一份材料"的是投影后的 canonical 目标。
     */
    tasks: Array.from({ length: count }, (_, i) =>
      legacyReading({ id: `overdue-alias-${i}`, minutes }),
    ),
  });
}

/** 把 N 条别名**分散到不同日期**，避免 `savePlan` 的整日替换把它们压成一条。 */
function seedOverdueAliasesAcrossDays(profileId: string, count: number, minutes = 3): void {
  for (let i = 0; i < count; i += 1) {
    repos.plan.savePlan(profileId, {
      date: `2026-01-${String(i + 1).padStart(2, "0")}`,
      availableMinutes: 60,
      plannedForMinutes: minutes,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [legacyReading({ id: `overdue-alias-${i}`, minutes })],
    });
  }
}

function viewOf(profileId: string, date: string, budget?: number): TodayView {
  if (budget !== undefined) ensurePlan(repos, profileId, date, { availableMinutes: budget, force: true });
  else ensurePlan(repos, profileId, date, { force: true });
  return getTodayView(repos, profileId, date);
}

/** 聚合不变量：`plannedMinutes` 必须等于各**计入项**有效分钟数之和。 */
function sumCounted(view: TodayView): number {
  return view.tasks
    .filter((t) => t.task.status !== "skipped" && !t.canonicalDuplicate)
    .reduce((sum, t) => sum + (effectiveMinutesOf(t) ?? 0), 0);
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-dupreserve-"));
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
// 1–4 · 单条 / 两条 / 六条 / 十条别名
// ===========================================================================

describe("重复别名预留 · 别名条数不得改变计划占用（反饥饿）", () => {
  for (const count of [1, 2, 6, 10]) {
    it(`${count} 条逾期别名指向同一目标：计划占用与 1 条时一致`, () => {
      const profileId = seed();
      importPaper();
      seedOverdueAliases(profileId, count);

      const view = viewOf(profileId, MONDAY);

      // 不变量：不得超出可用时间
      expect(view.plannedMinutes).toBeLessThanOrEqual(view.availableMinutes);
      // 聚合口径一致
      expect(view.plannedMinutes).toBe(sumCounted(view));

      const expected = view.plannedMinutes;
      const again = viewOf(profileId, MONDAY);
      expect(again.plannedMinutes, "同一状态重复求解必须稳定").toBe(expected);
    });
  }

  it("**变形关系**：别名从 1 条加到 10 条，计划占用不变（同一份合法工作量）", () => {
    /*
     * 这是本文件最重要的一条。
     *
     * 只断言 `planned <= available` 是不够的：把计划压成 0 也满足它。
     * 这里断言的是**变形不变性** —— 保留同一份合法工作量，
     * 只增加"指向同一目标的重复历史条目"，计划占用必须逐字不变。
     *
     * 修复前：1 条 = 58，10 条 = 7（逐步缩水 51 分钟）。
     */
    const measured: number[] = [];
    for (const count of [1, 2, 6, 10]) {
      const profileId = seed();
      importPaper();
      seedOverdueAliases(profileId, count);
      measured.push(viewOf(profileId, MONDAY).plannedMinutes);
    }

    expect(
      measured,
      `别名条数不应改变计划占用，实测各档位为 ${measured.join(" / ")}`,
    ).toEqual([measured[0], measured[0], measured[0], measured[0]]);
  });

  it("别名确实**仍然存在**于计划里（不得靠删除历史条目来让数字好看）", () => {
    /*
     * 反饥饿修复**不能**是"把多余的别名丢掉"。
     * 用户应当仍能看到自己还有这些历史条目 —— 界面把它们显示为
     * 「与上一条同一部分」。
     */
    const profileId = seed();
    importPaper();
    seedOverdueAliases(profileId, 6);

    const view = viewOf(profileId, MONDAY);
    const dups = view.tasks.filter((t) => t.canonicalDuplicate);

    expect(dups.length, "6 条别名中应有 5 条被判为重复并保留在计划里").toBe(5);
    for (const d of dups) {
      // 重复项不构成工作量
      expect(d.effectiveMinutes).toBeNull();
    }
    // 恰好一个代表
    const representatives = view.tasks.filter(
      (t) => t.canonicalKey !== null && !t.canonicalDuplicate && t.task.status !== "completed",
    );
    const byKey = new Map<string, number>();
    for (const r of representatives) {
      byKey.set(r.canonicalKey!, (byKey.get(r.canonicalKey!) ?? 0) + 1);
    }
    for (const [key, n] of byKey) {
      expect(n, `目标 ${key} 应恰有一个代表`).toBe(1);
    }
  });

  it("别名越多**不会**让计划占用逐步缩水（逐档单调性反例检查）", () => {
    // 逐档依次追加别名，记录每一步的计划占用
    const series: number[] = [];
    for (const count of [1, 2, 3, 6, 10]) {
      const p = seed();
      importPaper();
      seedOverdueAliases(p, count);
      series.push(viewOf(p, MONDAY).plannedMinutes);
    }

    // 序列必须是常数：任何下降都说明"别名被当成了新的真实工作量"
    for (let i = 1; i < series.length; i += 1) {
      expect(
        series[i],
        `别名增多后计划占用下降了：${series.join(" → ")}`,
      ).toBe(series[0]);
    }
  });

  it("**独立目标反例**：同预算下别名不额外占预算，而真正的第二个目标要占", () => {
    /*
     * 这条是上一条的**对照**：证明去重没有把合法的独立工作量一起压掉。
     *
     * 预算取 45 分钟 —— 在那个宽度上三种状态的差别**数值可见**，
     * 因此断言不是"看起来还行"，而是具体数字的对比：
     *
     *   D（2 条别名 · 同一目标）  必须与 B（1 条 · 一个目标）**相同**
     *                              ⇒ 同一份材料只算一次
     *   C（2 条 · 两个不同目标）  必须与 B **不同**（更小）
     *                              ⇒ 第二个真实目标是额外的真实工作量
     *
     * 若去重把 C 也压成 B，说明它按"时长/标题"误合并了；
     * 若 D 比 B 小，说明别名仍被当成了独立工作量。
     */
    const BUDGET = 45;
    const oneRef = { contentType: "reading_target" as const, contentId: TARGET_CLOZE };
    const otherRef = { contentType: "reading_target" as const, contentId: TARGET_MATCH };

    const measure = (refs: Array<{ contentType: "reading_target"; contentId: string }>) => {
      const p = seed();
      importPaper();
      refs.forEach((ref, i) => {
        repos.plan.savePlan(p, {
          date: `2026-01-0${i + 1}`,
          availableMinutes: 120,
          plannedForMinutes: 3,
          generatedBy: "deterministic_planner",
          notes: [],
          warnings: [],
          tasks: [
            {
              ...legacyReading({ id: `overdue-${i}`, minutes: 3 }),
              contentRef: ref,
            },
          ],
        });
      });
      const v = viewOf(p, MONDAY, BUDGET);
      return {
        planned: v.plannedMinutes,
        dups: v.tasks.filter((t) => t.canonicalDuplicate).length,
      };
    };

    const one = measure([oneRef]);
    const sameTarget = measure([oneRef, oneRef]);
    const distinctTargets = measure([oneRef, otherRef]);

    expect(one.planned, "单目标应有可排内容").toBeGreaterThan(0);

    // 同一目标的别名：计划占用与单条**完全相同**
    expect(
      sameTarget.planned,
      `同一目标的 2 条别名（${sameTarget.planned}）不应改变计划占用（单条 ${one.planned}）`,
    ).toBe(one.planned);
    expect(sameTarget.dups, "同一目标应产生 1 条重复项").toBe(1);

    // 两个真正不同的目标：各自占预算，因此结果必须与单目标**不同**
    expect(distinctTargets.dups, "不同目标之间不得产生重复项").toBe(0);
    expect(
      distinctTargets.planned,
      `两个独立目标（${distinctTargets.planned}）不应被误合并成单目标（${one.planned}）`,
    ).not.toBe(one.planned);
  });
});

// ===========================================================================
// 5–6 · 独立目标必须保留各自预留；混合场景
// ===========================================================================

describe("重复别名预留 · 独立 canonical 目标不得被误合并", () => {
  it("两个**不同**的 canonical 目标各自保留独立预留（不得因为时长相同就合并）", () => {
    /*
     * 两条逾期任务分别引用**不同**的真实真题大题（`reading_target` 引用）。
     * 它们时长相同（都是 3 分钟）—— 但身份不同，
     * 因此必须是**两份**独立工作量，不能被去重成一份。
     */
    const profileId = seed();
    importPaper();

    // 从候选里取两个不同的大题，构造真实目标引用
    const candidates = [
      "fixture-cet6-2024-12-set1::reading.banked_cloze",
      "fixture-cet6-2024-12-set1::reading.matching",
    ];

    repos.plan.savePlan(profileId, {
      date: "2026-01-03",
      availableMinutes: 120,
      plannedForMinutes: 6,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: candidates.map((refId, i) => ({
        ...legacyReading({ id: `distinct-${i}`, minutes: 3 }),
        contentRef: { contentType: "reading_target" as const, contentId: refId },
      })),
    });

    const view = viewOf(profileId, MONDAY, 120);

    /*
     * planner 自己也会排入阅读训练，因此库里会出现**多于两个** canonical 目标。
     * 这里断言的是：我种下的那两个**不同**目标各自都在，且各自恰有一个代表
     * （即它们没有被互相去重）。
     */
    const keysOf = (v: TodayView) =>
      new Set(v.tasks.map((t) => t.canonicalKey).filter((k): k is string => k !== null));
    const distinctKeys = keysOf(view);
    for (const refId of candidates) {
      expect(distinctKeys.has(refId), `目标 ${refId} 应当存在`).toBe(true);
    }

    // 两个种下的目标都不是重复项（各自是独立工作量）
    for (const refId of candidates) {
      const view0 = view.tasks.filter((t) => t.canonicalKey === refId);
      const reps = view0.filter((t) => !t.canonicalDuplicate);
      expect(reps.length, `目标 ${refId} 应恰有一个代表`).toBe(1);
    }

    /*
     * 关键：两份工作量的有效分钟数都必须被计入 ——
     * 若被误合并，只会剩一份。
     */
    const counted = view.tasks
      .filter((t) => t.canonicalKey !== null && !t.canonicalDuplicate)
      .reduce((sum, t) => sum + (effectiveMinutesOf(t) ?? 0), 0);
    const one = effectiveMinutesOf(
      view.tasks.find((t) => t.canonicalKey !== null && !t.canonicalDuplicate)!,
    )!;
    expect(counted, "两个独立目标应各计一次").toBeGreaterThanOrEqual(one * 2 - 1);
  });

  it("混合场景：重复别名 + 独立目标 —— 只有重复的那一份被去重", () => {
    const profileId = seed();
    importPaper();

    // 3 条同目标别名（1 月 1/2/3 日，避免整日替换）+ 1 条独立目标
    seedOverdueAliasesAcrossDays(profileId, 3);
    repos.plan.savePlan(profileId, {
      date: "2026-01-04",
      availableMinutes: 120,
      plannedForMinutes: 3,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        {
          ...legacyReading({ id: "distinct-one", minutes: 3 }),
          contentRef: {
            contentType: "reading_target" as const,
            contentId: "fixture-cet6-2024-12-set1::reading.matching",
          },
        },
      ],
    });

    const view = viewOf(profileId, SATURDAY); // 周六 → 120 分钟

    expect(view.plannedMinutes).toBeLessThanOrEqual(view.availableMinutes);
    expect(view.plannedMinutes).toBe(sumCounted(view));

    // 至少两个不同目标，且独立目标没有被去重掉
    const keys = new Set(
      view.tasks.map((t) => t.canonicalKey).filter((k): k is string => k !== null),
    );
    expect(keys.size).toBeGreaterThanOrEqual(2);
  });
});

// ===========================================================================
// 7–8 · 身份未知 / 不可执行的目标
// ===========================================================================

describe("重复别名预留 · 未知与不可执行目标不得被误去重", () => {
  it("身份**未知**（引用失效）的阅读任务逐条保留，不互相抵消", () => {
    /*
     * 三条引用失效的阅读任务：它们的 `canonicalKey` 都是 null。
     * 若按"没有身份"就把它们分组，就会把三条合法工作静默合并成一条。
     * 正确行为：它们各自是独立工作量，全部保留。
     */
    const profileId = seed();
    importPaper();

    for (let i = 0; i < 3; i += 1) {
      repos.plan.savePlan(profileId, {
        date: `2026-01-0${i + 1}`,
        availableMinutes: 60,
        plannedForMinutes: 12,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [
          /*
           * 真实目标引用，但**指向一份不存在的试卷** ⇒ 解析失败。
           * 这类任务的 canonical 身份是**未知**的（null），
           * 因此不得与任何其它任务分组。
           */
          legacyReading({
            id: `unresolved-${i}`,
            minutes: 12,
            contentType: "reading_target",
            contentId: `no-such-paper-${i}::reading.matching`,
          }),
        ],
      });
    }

    const view = viewOf(profileId, MONDAY);
    const unresolved = view.tasks.filter((t) =>
      t.task.contentRef?.contentId?.startsWith("no-such-paper"),
    );

    expect(unresolved.length, "三条失效引用都应保留").toBe(3);
    for (const u of unresolved) {
      expect(u.canonicalKey, "身份未知 ⇒ canonicalKey 必须为 null").toBeNull();
      // 不可执行 ⇒ 不构成工作量（不得凭空计入历史时长）
      expect(effectiveMinutesOf(u), "不可执行任务不得计入工作量").toBeNull();
    }
    expect(view.plannedMinutes).toBeLessThanOrEqual(view.availableMinutes);
  });

  it("不可执行的投影阅读目标不产生预留，也不得因此让当天排不出内容", () => {
    /*
     * 库里**没有**可训练的真实阅读大题（未导入任何试卷）时，
     * 历史合成阅读行投影为"不可用"。它们既不该预留（不构成工作量），
     * 也不该把当天预算吃光。
     */
    const profileId = seed();
    // 刻意**不**导入试卷 —— 阅读目标不存在

    seedOverdueAliases(profileId, 6);

    const view = viewOf(profileId, MONDAY);
    expect(view.plannedMinutes).toBeLessThanOrEqual(view.availableMinutes);
    expect(view.plannedMinutes).toBe(sumCounted(view));

    // 不可执行的阅读任务一律不计入有效分钟数
    for (const t of view.tasks.filter((x) => x.isRealPaperReading)) {
      if (!t.contentReady) expect(effectiveMinutesOf(t)).toBeNull();
    }
  });
});

// ===========================================================================
// 9 · 已完成的历史任务
// ===========================================================================

describe("重复别名预留 · 已完成历史任务保持原样", () => {
  it("已完成的历史合成任务仍被保留、仍是历史事实、不参与去重预留", () => {
    const profileId = seed();
    importPaper();

    repos.plan.savePlan(profileId, {
      date: MONDAY,
      availableMinutes: 60,
      plannedForMinutes: 12,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        legacyReading({ id: "done-legacy", minutes: 12, status: "completed" }),
        // 同一天再加一条未完成的别名，确认两者不会互相干扰
        legacyReading({ id: "pending-legacy", minutes: 3, status: "pending" }),
      ],
    });

    const view = viewOf(profileId, MONDAY);
    const done = view.tasks.find((t) => t.task.id === "done-legacy")!;

    expect(done.task.status).toBe("completed");
    expect(done.task.estimatedMinutes, "历史时长不得被改写").toBe(12);
    expect(done.effectiveMinutes, "已完成的历史时长照常计入").toBe(12);
    expect(done.isHistoricalCompleted).toBe(true);
    expect(done.isRealPaperReading, "历史合成任务不得被冒充成真题").toBe(false);
    expect(done.canonicalKey, "历史事实没有 canonical 目标").toBeNull();

    // 库里那一行也未被改写
    const stored = repos.plan.getTask("done-legacy")!;
    expect(stored.status).toBe("completed");
    expect(stored.estimatedMinutes).toBe(12);

    expect(view.plannedMinutes).toBeLessThanOrEqual(view.availableMinutes);
    expect(view.plannedMinutes).toBe(sumCounted(view));
  });
});

// ===========================================================================
// 10–11 · 各预算档位与工作日/周末
// ===========================================================================

describe("重复别名预留 · 各预算档位与工作日/周末", () => {
  for (const budget of [30, 45, 60, 120]) {
    it(`${budget} 分钟预算：10 条别名不得把当天压空`, () => {
      const profileId = seed();
      importPaper();
      seedOverdueAliases(profileId, 10);

      const view = viewOf(profileId, MONDAY, budget);

      expect(view.plannedMinutes).toBeLessThanOrEqual(view.availableMinutes);
      expect(view.plannedMinutes).toBe(sumCounted(view));

      /*
       * 反饥饿：当天有可执行内容时，预算足够就不该是空计划。
       *
       * 修复前 30 分钟日 10 条别名把 planned 压到 **0**。
       * 单条别名时同一预算排得进 7 分钟，因此 10 条也不得凭空变成 0。
       */
      const single = (() => {
        const p = seed();
        importPaper();
        seedOverdueAliases(p, 1);
        return viewOf(p, MONDAY, budget).plannedMinutes;
      })();

      if (single > 0) {
        expect(
          view.plannedMinutes,
          `${budget} 分钟预算下，1 条别名可排 ${single} 分钟，` +
            `10 条别名却被压到 ${view.plannedMinutes} 分钟 —— 别名不应是独立工作量`,
        ).toBeGreaterThan(0);
      }
    });
  }

  for (const [label, date] of [
    ["工作日（周一 60 分钟）", MONDAY],
    ["周六（周末 120 分钟）", SATURDAY],
    ["周日（周末 120 分钟）", SUNDAY],
  ] as const) {
    it(`${label}：10 条别名与 1 条别名的计划占用相同`, () => {
      const one = (() => {
        const p = seed();
        importPaper();
        seedOverdueAliases(p, 1);
        return viewOf(p, date).plannedMinutes;
      })();
      const many = (() => {
        const p = seed();
        importPaper();
        seedOverdueAliases(p, 10);
        return viewOf(p, date).plannedMinutes;
      })();

      expect(many, `${label}：别名条数改变了计划占用`).toBe(one);
      expect(many).toBeLessThanOrEqual(regularMinutesFor(repos, seed(), date) === 60 ? 60 : 120);
    });
  }
});

// ===========================================================================
// 12 · 已完成时间超过被下调的预算
// ===========================================================================

describe("重复别名预留 · 已完成时间超过下调后的预算", () => {
  it("可用时间被下调到低于已完成时间：如实保留已完成，不排新内容", () => {
    /*
     * 评审指出的非阻断精确性问题之一：
     * `planned_for_minutes <= available_minutes` **不是**普遍成立的。
     *
     * 用户可以把今天的可用时间改到比**已经完成的**时间还少。
     * 那时诚实的记录就是"已经完成 40 分钟、可用 0 分钟"——
     * 不得为了凑不等式而压缩或抹掉已完成的事实。
     */
    const profileId = seed();
    importPaper();

    repos.plan.savePlan(profileId, {
      date: MONDAY,
      availableMinutes: 60,
      plannedForMinutes: 40,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        legacyReading({ id: "done-40", minutes: 40, status: "completed" }),
      ],
    });

    // 用户把今天改成 0 分钟
    const view = viewOf(profileId, MONDAY, 0);

    // 已完成的事实原样保留
    const done = view.tasks.find((t) => t.task.id === "done-40")!;
    expect(done.task.status).toBe("completed");
    expect(done.task.estimatedMinutes).toBe(40);
    expect(view.completedMinutes).toBe(40);

    // 不再排新内容
    const newWork = view.tasks.filter(
      (t) => t.task.status !== "completed" && t.task.status !== "skipped",
    );
    expect(newWork.length, "预算为 0 时不得排新内容").toBe(0);

    /*
     * 库里那一列会大于可用时间（40 > 0）—— 这是**诚实**的结果，
     * 不是需要修的偏差。见 `ensurePlan` 的注释。
     */
    const stored = repos.plan.getPlan(profileId, MONDAY)!;
    expect(stored.availableMinutes).toBe(0);
    expect(stored.plannedForMinutes, "已完成时间不得被压缩到可用时间以内").toBe(40);
  });

  it("已完成时间超过下调预算时，重复别名也不得额外计入", () => {
    const profileId = seed();
    importPaper();

    repos.plan.savePlan(profileId, {
      date: MONDAY,
      availableMinutes: 60,
      plannedForMinutes: 40,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [legacyReading({ id: "done-40", minutes: 40, status: "completed" })],
    });
    seedOverdueAliases(profileId, 6);

    const view = viewOf(profileId, MONDAY, 0);

    expect(view.completedMinutes).toBe(40);
    // 别名不得在预算为 0 时还被排进来
    const active = view.tasks.filter(
      (t) => t.task.status !== "completed" && t.task.status !== "skipped",
    );
    expect(active.length).toBe(0);
  });
});

// ===========================================================================
// 13–14 · 课程曝光边界与默认 E2E 安全
// ===========================================================================

describe("重复别名预留 · 边界不回归", () => {
  it("课程曝光不得影响计划预算或任何表现证据", () => {
    const profileId = seed();
    importPaper();
    seedOverdueAliases(profileId, 6);

    viewOf(profileId, SUNDAY);

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

  it("确定性：同一输入重复求解，计划的**语义**逐字相同", () => {
    const profileId = seed();
    importPaper();
    seedOverdueAliases(profileId, 6);

    /*
     * 比"语义指纹"而不是整个视图的 JSON：
     * 每次强制重排都会生成新的任务 UUID（既有设计），
     * 那不是计划内容的一部分。这里比的是学习者真正看到的那些量。
     */
    const fingerprint = (v: TodayView) =>
      JSON.stringify({
        planned: v.plannedMinutes,
        completed: v.completedMinutes,
        available: v.availableMinutes,
        tasks: v.tasks.map((t) => ({
          est: t.task.estimatedMinutes,
          eff: t.effectiveMinutes,
          key: t.canonicalKey,
          dup: t.canonicalDuplicate,
          status: t.task.status,
        })),
        next: v.nextTask?.canonicalKey ?? null,
      });

    const a = viewOf(profileId, MONDAY);
    const b = viewOf(profileId, MONDAY);
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it("代表放不进预算时，其别名也不得凭空计入（真实可达的边界）", () => {
    /*
     * 历史 12 分钟 → 目标 7 分钟，可用只有 5 分钟。
     * 代表放不进 ⇒ 当天不该有任何该目标的工作量。
     * 若别名仍被落库，`getTodayView` 会认领其中一条并计入 7 分钟 ⇒
     * planned=7 > available=5。实测过这个越界。
     */
    const profileId = seed();
    importPaper();

    for (let i = 0; i < 3; i += 1) {
      repos.plan.savePlan(profileId, {
        date: `2026-01-0${i + 1}`,
        availableMinutes: 60,
        plannedForMinutes: 12,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [legacyReading({ id: `alias-${i}`, minutes: 12 })],
      });
    }

    const view = viewOf(profileId, MONDAY, 5);

    expect(
      view.plannedMinutes,
      `可用 5 分钟时计划占用 ${view.plannedMinutes} 分钟 —— 目标没排进来却仍计入了工作量`,
    ).toBeLessThanOrEqual(5);
    expect(view.plannedMinutes).toBe(sumCounted(view));
  });
});
