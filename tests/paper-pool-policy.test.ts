import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { createTestDb, resetDb } from "@/db/client";
import { completeOnboarding } from "@/services/onboarding";
import { startDiagnostic, submitDiagnostic } from "@/services/diagnostic";
import { runImport } from "@/services/paper-import";
import { getPaperDetail } from "@/services/papers";
import {
  getSectionTrainingState,
  listReadingTargets,
  startReadingRun,
  submitReadingRun,
} from "@/services/expert-training";
import { listReadingTargetCandidates } from "@/services/reading-plan";
import { getTodayView } from "@/services/plan";
import { isPaperStartableForPractice, isPaperReservedForMock, RESERVED_PAPER_REASON } from "@/domain/paper";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import { DIAGNOSTIC_ITEMS } from "@/content/diagnostic-bank";
import { CET6_EXAM_DATE } from "@/domain/exam-facts";
import type { Repositories } from "@/repositories/ports";

/**
 * 训练池策略（`mock_reserve`）的**全入口一致性**回归。
 *
 * ── 这组测试守护的那条产品规则 ──
 *
 *   「模考保留」= 刻意留住没做过的真题，后面才能用真正没见过的卷子做模考。
 *   未触碰的材料是有限资源，不是可随意消耗的余额。
 *   （PRODUCT_PRINCIPLES 第 7 条）
 *
 * ── 为什么需要它（实测缺口）──
 *
 * 这条策略原先只在**部分**入口上成立：
 * `/practice` 列表页排除了保留卷，但**试卷详情页仍渲染「开始训练」**，
 * 而 `startReadingRun` 也不看池归属 —— 实测可以真的开始并写入 `learning_run`。
 * 也就是说"保留"当时只是界面上的说法，不是实际约束。
 *
 * 因此判据收敛到 `isPaperStartableForPractice`，并且**服务层是权威**：
 * 隐藏按钮不足以守住策略，因为学习者可以直接输入 URL。
 *
 * ── 发现（listable）≠ 可开始（startable）──
 *
 * 保留卷的**结构**仍必须可浏览（用户要知道库里有什么、为什么被保留）。
 * 下面的测试同时固定这个区分 —— 不许把列表 API 一刀切成"保留卷返回空"。
 */

const CONTENT_ROOT = join(process.cwd(), "data", "pool-policy-content");
const PAPER = "fixture-cet6-2024-12-set1";
const SECTION = "reading.careful_reading";

interface Fixture {
  repos: Repositories;
  profileId: string;
}

/** 建立"已 onboard + 已诊断 + 已导入一份可训练真题"的环境。 */
function buildFixture(): Fixture {
  const db = createTestDb();
  resetDb(db);
  const repos = createSqliteRepositories(db);

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

  process.env.CET6_CONTENT_ROOT = CONTENT_ROOT;
  rmSync(CONTENT_ROOT, { recursive: true, force: true });
  mkdirSync(CONTENT_ROOT, { recursive: true });
  writeFixturePackage(
    CONTENT_ROOT,
    "2024-12-set1",
    buildFixturePackage({ id: PAPER, year: 2024, session: "December", variant: "set1" }),
  );
  runImport(repos, { dryRun: false });

  return { repos, profileId };
}

function cleanup(): void {
  delete process.env.CET6_CONTENT_ROOT;
  rmSync(CONTENT_ROOT, { recursive: true, force: true });
}

function withFixture<T>(fn: (f: Fixture) => T): T {
  const fixture = buildFixture();
  try {
    return fn(fixture);
  } finally {
    cleanup();
  }
}

/** 该部分的题面作答（只取首项，不读答案字段）。 */
function answerEveryQuestion(repos: Repositories, paperId: string, sectionId: string) {
  const detail = getPaperDetail(repos, paperId)!;
  const section = detail.content!.sections.find((s) => s.id === sectionId)!;
  return section.groups.flatMap((group) =>
    group.questions.map((question) => {
      switch (question.kind) {
        case "mcq":
          return { questionId: question.id, value: question.options[0]?.id ?? null };
        case "banked_cloze_blank":
          return { questionId: question.id, value: group.wordBank?.[0] ?? null };
        case "matching_statement":
          return { questionId: question.id, value: group.paragraphs?.[0]?.label ?? null };
        default:
          return { questionId: question.id, value: null };
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// 1 · 训练池：一切照常
// ---------------------------------------------------------------------------

describe("训练池策略 · 训练池试卷行为不变", () => {
  it("可练 → startReadingRun 成功并创建一个会话", () => {
    withFixture(({ repos, profileId }) => {
      expect(isPaperStartableForPractice(repos.papers.getPaper(PAPER)!)).toBe(true);

      const before = repos.expert.listRuns(profileId, 200).length;
      const result = startReadingRun(repos, profileId, PAPER, SECTION);

      expect(result.ok, result.ok ? "" : result.error).toBe(true);
      expect(repos.expert.listRuns(profileId, 200).length).toBe(before + 1);
    });
  });

  it("可练 → getSectionTrainingState 正常返回（开始屏或已有会话）", () => {
    withFixture(({ repos, profileId }) => {
      const state = getSectionTrainingState(repos, profileId, PAPER, SECTION);
      // 还没开始 → not_found（页面据此渲染开始屏）
      expect(state.ok).toBe(false);
      if (!state.ok) expect(state.code).toBe("not_found");
    });
  });
});

// ---------------------------------------------------------------------------
// 2 · 服务层权威守卫：保留卷拒绝创建会话
// ---------------------------------------------------------------------------

describe("训练池策略 · 服务层是权威守卫", () => {
  it("保留卷 → startReadingRun 返回 unavailable，且**不创建任何会话**", () => {
    withFixture(({ repos, profileId }) => {
      repos.papers.setPool(PAPER, "mock_reserve");
      expect(isPaperStartableForPractice(repos.papers.getPaper(PAPER)!)).toBe(false);

      const before = repos.expert.listRuns(profileId, 200).length;
      const result = startReadingRun(repos, profileId, PAPER, SECTION);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe("unavailable");
        // 原因必须可读、且同时给出"为什么"与"怎么办"
        expect(result.error).toContain("模考保留");
        expect(result.error).toContain("移回训练池");
      }
      expect(repos.expert.listRuns(profileId, 200).length, "不得创建会话").toBe(before);
    });
  });

  it("保留卷 → 守卫在**读取会话之前**，因此不会复用/渲染已有的进行中会话", () => {
    withFixture(({ repos, profileId }) => {
      // 先在训练池下开一个会话
      const started = startReadingRun(repos, profileId, PAPER, SECTION);
      expect(started.ok).toBe(true);

      // 再切成保留
      repos.papers.setPool(PAPER, "mock_reserve");

      const again = startReadingRun(repos, profileId, PAPER, SECTION);
      expect(again.ok, "保留期间不得复用进行中会话").toBe(false);
      if (!again.ok) expect(again.code).toBe("unavailable");

      // 但那个会话**没有被销毁**（它是真实发生过的事）
      const stillThere = repos.expert
        .listRuns(profileId, 200)
        .some((run) => run.sectionId === SECTION && run.status === "in_progress");
      expect(stillThere, "已有的进行中会话不得被静默废弃/销毁").toBe(true);
    });
  });

  it("保留卷 → getSectionTrainingState 返回 unavailable（GET 路径同样封闭）", () => {
    withFixture(({ repos, profileId }) => {
      repos.papers.setPool(PAPER, "mock_reserve");
      const state = getSectionTrainingState(repos, profileId, PAPER, SECTION);

      expect(state.ok).toBe(false);
      if (!state.ok) {
        expect(state.code).toBe("unavailable");
        expect(state.error).toBe(RESERVED_PAPER_REASON);
      }
    });
  });

  it("保留卷 → 直接访问训练页不会被交给工作区（GET 只读、无写入）", () => {
    withFixture(({ repos, profileId }) => {
      repos.papers.setPool(PAPER, "mock_reserve");
      const before = repos.expert.listRuns(profileId, 200).length;

      // 模拟页面 GET：读取状态多次
      getSectionTrainingState(repos, profileId, PAPER, SECTION);
      getSectionTrainingState(repos, profileId, PAPER, SECTION);

      expect(repos.expert.listRuns(profileId, 200).length, "GET 不得产生写入").toBe(before);
    });
  });
});

// ---------------------------------------------------------------------------
// 3 · 历史数据安全：切换池归属不销毁任何事实
// ---------------------------------------------------------------------------

describe("训练池策略 · 切换池归属不销毁历史", () => {
  it("保留期间：已完成的结果与观测**原样保留**", () => {
    withFixture(({ repos, profileId }) => {
      // 在训练池下完整做一次并交卷
      const started = startReadingRun(repos, profileId, PAPER, SECTION);
      expect(started.ok).toBe(true);
      if (!started.ok) return;

      const submitted = submitReadingRun(repos, profileId, {
        runId: started.run.id,
        responses: answerEveryQuestion(repos, PAPER, SECTION),
        elapsedSeconds: 600,
        changedQuestionIds: [],
      });
      expect(submitted.ok, submitted.ok ? "" : submitted.error).toBe(true);

      const eventsBefore = repos.expert.listEventsForRun(started.run.id).length;
      expect(eventsBefore).toBeGreaterThan(0);

      // 切成保留
      repos.papers.setPool(PAPER, "mock_reserve");

      // 事实必须还在
      const run = repos.expert.getRun(started.run.id)!;
      expect(run.status, "已完成的历史不得被改写").toBe("completed");
      expect(repos.expert.listEventsForRun(started.run.id).length).toBe(eventsBefore);

      // 而且不能再开新的
      const again = startReadingRun(repos, profileId, PAPER, SECTION);
      expect(again.ok).toBe(false);
      if (!again.ok) expect(again.code).toBe("unavailable");
    });
  });

  it("保留期间：已完成的历史结果仍可**读取**（只读不删），但不能再开启新训练", () => {
    withFixture(({ repos, profileId }) => {
      const started = startReadingRun(repos, profileId, PAPER, SECTION);
      if (!started.ok) throw new Error("前置失败");
      submitReadingRun(repos, profileId, {
        runId: started.run.id,
        responses: answerEveryQuestion(repos, PAPER, SECTION),
        elapsedSeconds: 600,
        changedQuestionIds: [],
      });

      repos.papers.setPool(PAPER, "mock_reserve");

      // 历史 run 仍在（getRun 是只读读取）
      expect(repos.expert.getRun(started.run.id)).not.toBeNull();
      // 但训练页状态是"不可用"（保留期间不暴露"再练一次"）
      const state = getSectionTrainingState(repos, profileId, PAPER, SECTION);
      expect(state.ok).toBe(false);
      if (!state.ok) expect(state.code).toBe("unavailable");
    });
  });
});

// ---------------------------------------------------------------------------
// 4 · 保留 → 训练（恢复）：一切回来
// ---------------------------------------------------------------------------

describe("训练池策略 · 移回训练池后恢复", () => {
  it("保留 → 训练：startReadingRun 恢复可用", () => {
    withFixture(({ repos, profileId }) => {
      repos.papers.setPool(PAPER, "mock_reserve");
      expect(startReadingRun(repos, profileId, PAPER, SECTION).ok).toBe(false);

      repos.papers.setPool(PAPER, "training");
      expect(isPaperStartableForPractice(repos.papers.getPaper(PAPER)!)).toBe(true);

      const after = startReadingRun(repos, profileId, PAPER, SECTION);
      expect(after.ok, after.ok ? "" : after.error).toBe(true);
    });
  });

  it("保留 → 训练：若此前有进行中会话，则**复用**它而不是新建（不产生孤儿）", () => {
    withFixture(({ repos, profileId }) => {
      const first = startReadingRun(repos, profileId, PAPER, SECTION);
      if (!first.ok) throw new Error("前置失败");

      repos.papers.setPool(PAPER, "mock_reserve");
      repos.papers.setPool(PAPER, "training");

      const countBefore = repos.expert.listRuns(profileId, 200).length;
      const resumed = startReadingRun(repos, profileId, PAPER, SECTION);

      expect(resumed.ok).toBe(true);
      if (resumed.ok) {
        expect(resumed.resumed, "应复用进行中的会话").toBe(true);
        expect(resumed.run.id).toBe(first.run.id);
      }
      expect(repos.expert.listRuns(profileId, 200).length, "不得新建").toBe(countBefore);
    });
  });
});

// ---------------------------------------------------------------------------
// 5 · 发现 ≠ 可开始（不许把列表一刀切）
// ---------------------------------------------------------------------------

describe("训练池策略 · 发现（listable）区别于可开始（startable）", () => {
  it("保留卷的**结构**仍可浏览：listReadingTargets 不返回空", () => {
    withFixture(({ repos, profileId }) => {
      repos.papers.setPool(PAPER, "mock_reserve");

      const listed = listReadingTargets(repos, profileId, PAPER);
      expect(listed, "保留卷仍需可浏览结构").not.toBeNull();
      expect(listed!.targets.length, "应仍列出 3 个阅读大题供浏览").toBe(3);
    });
  });

  it("但保留卷**不可开始** —— 每条列出的目标都不构成可练（服务层拒绝）", () => {
    withFixture(({ repos, profileId }) => {
      repos.papers.setPool(PAPER, "mock_reserve");
      const listed = listReadingTargets(repos, profileId, PAPER)!;

      for (const target of listed.targets) {
        // 列出来了，但拿它去开始会被拒 —— "listed" 不等于 "startable"
        const started = startReadingRun(repos, profileId, PAPER, target.sectionId);
        expect(started.ok, `${target.sectionId} 不应可开始`).toBe(false);
      }
    });
  });

  it("保留卷不进入候选（Today / planner 路径）", () => {
    withFixture(({ repos, profileId }) => {
      repos.papers.setPool(PAPER, "mock_reserve");
      expect(listReadingTargetCandidates(repos, profileId)).toHaveLength(0);

      // Today 上也不得出现阅读任务（不消耗保留材料）
      const view = getTodayView(repos, profileId, "2026-09-28");
      expect(view.tasks.some((t) => t.task.kind === "reading_comprehension")).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 6 · 策略谓词本身（唯一权威）
// ---------------------------------------------------------------------------

describe("训练池策略 · 判定收敛到一处", () => {
  it("isPaperStartableForPractice：training 可练，mock_reserve 不可练", () => {
    expect(isPaperStartableForPractice({ pool: "training" })).toBe(true);
    expect(isPaperStartableForPractice({ pool: "mock_reserve" })).toBe(false);
  });

  it("原因文案同时给出「为什么」与「怎么办」", () => {
    expect(RESERVED_PAPER_REASON).toContain("模考保留");
    expect(RESERVED_PAPER_REASON).toContain("移回训练池");
  });

  it("界面与服务层用的是同一个谓词（不是各自写一份 pool 比较）", () => {
    /*
     * 源码级守卫：这次缺口的成因正是"同一条规则只有部分入口遵守"，
     * 而修复方式是收敛到一个具名谓词。若有人日后在页面里重新写
     * 裸的池比较，就会重新出现漂移 —— 这里把它挡住。
     *
     * ── 判据必须排除注释 ──
     * 朴素的正则会把**讲解这条规则本身**的注释也算成违规
     * （实测踩到：详情页那句"页面不自己写 pool === mock_reserve"被命中）。
     * 因此先剥掉注释再检查，否则守卫会禁止我们记录为什么不能那样写。
     *
     * ── 本轮扩展 ──
     * 模考新鲜度让"这份卷子是否被设为保留"多了一个消费方
     * （"严格未见模考"这个承诺只对保留卷适用）。列表页、详情页、徽标
     * 三处都新增了该判断，因此一并纳入守卫 —— 新增消费方正是
     * 裸比较最容易重新长出来的地方。
     */
    const stripComments = (source: string): string =>
      source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");

    const files = [
      ["paper detail", "src/app/practice/papers/[paperId]/page.tsx"],
      ["train page", "src/app/practice/papers/[paperId]/train/[sectionId]/page.tsx"],
      ["papers list", "src/app/practice/papers/page.tsx"],
      ["paper badges", "src/app/practice/papers/badges.tsx"],
    ] as const;

    for (const [label, path] of files) {
      const source = readFileSync(join(process.cwd(), path), "utf8");
      const code = stripComments(source);
      expect(
        /pool\s*===\s*["']mock_reserve["']/.test(code),
        `${label} 的**代码**不得自带池比较（应收敛到具名谓词）`,
      ).toBe(false);
    }

    // 详情页与训练页用「可开始」谓词；列表/详情/徽标用「保留」谓词。
    for (const path of [
      "src/app/practice/papers/[paperId]/page.tsx",
      "src/app/practice/papers/[paperId]/train/[sectionId]/page.tsx",
    ]) {
      expect(readFileSync(join(process.cwd(), path), "utf8"), `${path} 应使用权威谓词`).toContain(
        "isPaperStartableForPractice",
      );
    }
    for (const path of [
      "src/app/practice/papers/[paperId]/page.tsx",
      "src/app/practice/papers/page.tsx",
      "src/app/practice/papers/badges.tsx",
    ]) {
      expect(readFileSync(join(process.cwd(), path), "utf8"), `${path} 应使用保留谓词`).toContain(
        "isPaperReservedForMock",
      );
    }
  });

  it("两个池谓词**互补**，且都不依赖对方的取反", () => {
    /*
     * 若把 `isPaperReservedForMock` 写成 `!isPaperStartableForPractice(...)`，
     * 将来一旦出现第三种池归属，两者会**同时**改变 —— 而它们其实回答
     * 两个不同的问题（"能练吗" vs "模考承诺适用吗"）。这条守卫要求
     * 它们各自独立判定，且在当前的两种取值上互补。
     */
    for (const pool of ["training", "mock_reserve"] as const) {
      expect(isPaperStartableForPractice({ pool })).toBe(!isPaperReservedForMock({ pool }));
    }

    const domain = readFileSync(join(process.cwd(), "src/domain/paper.ts"), "utf8");
    const reservedBody = /export function isPaperReservedForMock\([\s\S]*?\n\}/.exec(domain)?.[0] ?? "";
    expect(reservedBody.length).toBeGreaterThan(40);
    expect(reservedBody, "保留谓词不得靠取反另一个谓词实现").not.toContain(
      "!isPaperStartableForPractice",
    );
  });
});
