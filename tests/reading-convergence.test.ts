import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { createTestDb, resetDb } from "@/db/client";
import { completeOnboarding } from "@/services/onboarding";
import { startDiagnostic, submitDiagnostic } from "@/services/diagnostic";
import { ensurePlan, getTodayView } from "@/services/plan";
import { getTaskDetail, resolveLegacyReadingTask, submitTask } from "@/services/practice";
import { getContentView } from "@/app/practice/[taskId]/content-view";
import { listReadingTargetCandidates, resolveReadingTask } from "@/services/reading-plan";
import {
  decodeReadingTarget,
  encodeReadingTarget,
  estimateReadingSectionMinutes,
  readingTargetHrefOf,
  taskHrefOf,
} from "@/domain/reading-target";
import { listAllReadingTargets, getSectionTrainingState } from "@/services/expert-training";
import { getPaperDetail } from "@/services/papers";
import { runImport } from "@/services/paper-import";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import { DIAGNOSTIC_ITEMS } from "@/content/diagnostic-bank";
import { CET6_EXAM_DATE } from "@/domain/exam-facts";
import type { Repositories } from "@/repositories/ports";

/**
 * 阅读训练收敛回归（本次改动的核心契约）。
 *
 * ── 被守护的产品规则 ──
 *
 * 「面向 CET-6 的阅读训练只使用真实历年真题，且只走 Expert Training 工作面
 *   与它的不可变台账」——
 * 在本次改动之前，Today 会把 `practice-library.ts` 里**合成**的阅读篇章
 * 排进计划，点进去落在旧执行器 `/practice/[taskId]`，走 Phase-1 的旧闭环。
 * 于是同一个产品里存在两套面向学习者的阅读训练系统，而学习者看到的那一套
 * 是合成材料。
 *
 * 这些测试把收敛结果固定下来。每一条都对应任务书要求的一个断言，
 * 并且**刻意断言"不发生什么"**（不出现合成内容、不写台账、不消耗保留材料）——
 * 因为这条改动的价值恰恰在于防止某条路径重新出现。
 */

// ---------------------------------------------------------------------------
// 夹具：私有内容根 + 测试夹具试卷（sourceKind 恒为 test_fixture）
// ---------------------------------------------------------------------------

const CONTENT_ROOT = join(process.cwd(), "data", "convergence-content");

interface Fixture {
  repos: Repositories;
  profileId: string;
  paperId: string;
}

/**
 * 建立"已 onboard + 已诊断 + 已有真实阅读大题可练"的环境。
 *
 * 内容用 `scripts/paper-fixture.ts` 的夹具构造器：它写死 `sourceKind` 为
 * `test_fixture`，因此**绝不会**冒充真题（见 tests/architecture.test.ts 的门禁）。
 * 内容根指向 `data/` 下的独立目录，不触碰用户的 `private-content/`。
 */
function buildFixture(options?: { pool?: "training" | "mock_reserve" }): Fixture {
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

  // 独立内容根：写入夹具包并走**生产导入路径**建立索引
  process.env.CET6_CONTENT_ROOT = CONTENT_ROOT;
  rmSync(CONTENT_ROOT, { recursive: true, force: true });
  mkdirSync(CONTENT_ROOT, { recursive: true });

  const paperId = "fixture-cet6-2024-12-set1";
  writeFixturePackage(
    CONTENT_ROOT,
    "2024-12-set1",
    buildFixturePackage({ id: paperId, year: 2024, session: "December", variant: "set1" }),
  );
  runImport(repos, { dryRun: false });

  if (options?.pool === "mock_reserve") {
    repos.papers.setPool(paperId, "mock_reserve");
  }

  return { repos, profileId, paperId };
}

function cleanup(): void {
  delete process.env.CET6_CONTENT_ROOT;
  rmSync(CONTENT_ROOT, { recursive: true, force: true });
}

/** 自动跑一次夹具包并清理内容根，避免污染其他测试文件。 */
function withFixture<T>(options: { pool?: "training" | "mock_reserve" } | undefined, fn: (f: Fixture) => T): T {
  const fixture = buildFixture(options);
  try {
    return fn(fixture);
  } finally {
    cleanup();
  }
}

// ---------------------------------------------------------------------------
// 需求 1 & 7：计划里不再出现合成阅读；旧 submitTask 阅读路径不可达
// ---------------------------------------------------------------------------

describe("需求 1 · Today 的阅读训练不再解析到合成 reading_passage 内容", () => {
  it("计划里的阅读任务引用的是真实真题阅读大题，不是内容库条目", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      const plan = ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120 });
      const reading = plan.tasks.filter((t) => t.kind === "reading_comprehension");

      expect(reading.length, "有可训练的真实阅读大题时，计划里应当有阅读任务").toBeGreaterThan(0);
      for (const task of reading) {
        // 引用类型必须是真实真题目标
        expect(task.contentRef?.contentType).toBe("reading_target");
        // 而绝不能是内容库的合成篇章
        expect(task.contentRef?.contentType).not.toBe("reading_passage");

        const decoded = decodeReadingTarget(task.contentRef!.contentId);
        expect(decoded, `引用应能被解码：${task.contentRef!.contentId}`).not.toBeNull();
        expect(decoded!.paperId).toBe("fixture-cet6-2024-12-set1");
        expect(decoded!.sectionId).toContain("reading.");
      }
    });
  });

  it("计划内容目录不再包含任何 practice-library 的合成阅读篇章", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      const plan = ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120 });
      // 合成阅读篇章的 id 形如 read-city-trees / read-sleep-learning
      for (const task of plan.tasks) {
        expect(task.contentRef?.contentId ?? "").not.toMatch(/^read-/);
        expect(task.contentRef?.contentType).not.toBe("reading_passage");
      }
    });
  });

  it("阅读任务的标题标明真实真题，且 rationale 说的是可核验的事实", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      const view = getTodayView(repos, profileId, "2026-09-28");
      const reading = view.tasks.filter((t) => t.task.kind === "reading_comprehension");
      expect(reading.length).toBeGreaterThan(0);

      for (const item of reading) {
        expect(item.isRealPaperReading).toBe(true);
        expect(item.task.title).toContain("真实真题");
        // rationale 必须陈述安排依据（没做过 / 没做完 / 练过），不得预测分数
        expect(item.task.rationale.length).toBeGreaterThan(0);
        expect(item.task.rationale).not.toMatch(/预测|预计能考|得分/);
      }
    });
  });

  it("需求 7：旧 submitTask 阅读路径从新生成的计划里不可达", async () => {
    const fixture = buildFixture();
    try {
      const { repos, profileId } = fixture;
      const plan = ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120 });
      const reading = plan.tasks.filter((t) => t.kind === "reading_comprehension")!;
      expect(reading.length).toBeGreaterThan(0);

      /*
       * 关键断言：即使**直接把阅读任务的 id 交给旧提交入口**，
       * 它也不能再写入旧闭环的观测 —— 因为阅读任务已经不引用内容库条目，
       * `gradeTaskContent` 找不到可判分的内容，只能返回空 details。
       *
       * 这不是"路径没被调用"，而是"这条路径即使被调用也产不出旧证据"。
       */
      const task = reading[0];
      const result = await submitTask(repos, profileId, {
        taskId: task.id,
        answers: [{ questionId: "whatever", choiceId: "a" }],
        writing: "",
        reviewedItemIds: [],
      });

      if (result.ok) {
        // 若"成功"，也只可能是零题型的空反馈，且不产生任何 attempt
        expect(result.feedback.details).toHaveLength(0);
        expect(result.feedback.totalCount).toBe(0);
      }
      expect(
        repos.records.listRecentAttempts(profileId, 50).length,
        "旧路径不得为阅读任务写入 answer_attempt",
      ).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("阅读任务不写 Expert 之外的旧画像（内容库视角已被切断）", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      const plan = ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120 });
      const reading = plan.tasks.filter((t) => t.kind === "reading_comprehension");
      for (const task of reading) {
        // 旧执行器通过内容库解析内容 —— 真实真题阅读**刻意不在内容库里**
        const detail = getTaskDetail(repos, task.id)!;
        expect(detail.content).toBeNull();
        // 且 content-view 不会为它产出任何可渲染的阅读题面
        const view = getContentView(detail);
        expect(view.kind).not.toBe("reading");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 需求 2：阅读 CTA 指向规范 Expert Training 路由
// ---------------------------------------------------------------------------

describe("需求 2 · 阅读 CTA 到达 canonical Expert Training / 真实真题流程", () => {
  it("任务的跳转目标就是 /practice/papers/{paperId}/train/{sectionId}", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      const view = getTodayView(repos, profileId, "2026-09-28");
      const reading = view.tasks.find((t) => t.task.kind === "reading_comprehension")!;

      expect(reading.isRealPaperReading).toBe(true);
      expect(reading.href).toMatch(/^\/practice\/papers\/[^/]+\/train\/[^/]+$/);
      expect(reading.href).toContain("fixture-cet6-2024-12-set1");
      // 绝不再指向旧执行器
      expect(reading.href).not.toBe(`/practice/${reading.task.id}`);
    });
  });

  it("该 URL 在 Expert Training 服务层确实可打开（不是死链接）", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      const view = getTodayView(repos, profileId, "2026-09-28");
      const reading = view.tasks.find((t) => t.task.kind === "reading_comprehension")!;

      const target = decodeReadingTarget(reading.task.contentRef!.contentId)!;
      const state = getSectionTrainingState(repos, profileId, target.paperId, target.sectionId);

      /*
       * 三种合法结果，且都**不是**"找不到"：
       * - ok：已有会话（进行中或已完成）→ 工作区可直接渲染
       * - not_found："这一部分还没开始训练" → 页面给出开始屏
       * 只要不是 not_trainable / unavailable，这条路就是通的。
       */
      if (state.ok) {
        expect(state.session.sectionId).toBe(target.sectionId);
        expect(state.session.groups.length).toBeGreaterThan(0);
      } else {
        expect(state.code).toBe("not_found");
      }
    });
  });

  it("旧执行器对历史合成阅读任务重定向到规范工作面（而不是渲染合成篇章）", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      /*
       * 构造一条**历史遗留**的阅读任务：它引用的是 practice-library 的
       * 合成篇章（本次改动之前生成的计划就是这种形态）。
       * 它可能仍然躺在今天或前几天的计划里（Today 的「补做」区）。
       */
      const legacy = repos.plan.savePlan(profileId, {
        date: "2026-09-27",
        availableMinutes: 60,
        plannedForMinutes: 12,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [
          {
            kind: "reading_comprehension",
            skill: "reading",
            priority: "core",
            title: "阅读训练 12 分钟",
            rationale: "历史遗留",
            estimatedMinutes: 12,
            contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
            status: "pending",
            order: 0,
          },
        ],
      });

      const task = legacy.tasks[0];
      const resolution = resolveLegacyReadingTask(repos, profileId, task);

      expect(resolution.kind, "历史合成阅读任务必须被重定向，而不是渲染").toBe("redirect");
      if (resolution.kind === "redirect") {
        expect(resolution.href).toMatch(/^\/practice\/papers\/[^/]+\/train\/[^/]+$/);
      }
      void task;
    });
  });

  it("旧执行器绝不为合成阅读任务产出可渲染的阅读视图", () => {
    withFixture(undefined, () => {
      /*
       * 第二道防线：即使有人绕过路由层的重定向，把合成篇章直接交给
       * `getContentView`，它也必须返回"不受支持"，而不是一篇阅读题。
       */
      const view = getContentView({
        task: {
          id: "t-legacy",
          planId: "p-legacy",
          kind: "reading_comprehension",
          skill: "reading",
          priority: "core",
          title: "阅读训练 12 分钟",
          rationale: "",
          estimatedMinutes: 12,
          contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
          status: "pending",
          completedAt: null,
          order: 0,
        },
        content: {
          id: "read-city-trees",
          type: "reading_passage",
          title: "为什么城市需要树",
          passage: "合成正文不应被下发。",
          wordCount: 10,
          questions: [],
          estimatedMinutes: 12,
          tags: [],
        },
        unavailableReason: null,
      });

      expect(view.kind).toBe("unsupported");
      if (view.kind === "unsupported") {
        expect(view.reason).toContain("真实历年真题");
      }
      /*
       * 合成正文绝不能进入**可渲染的字段**。
       *
       * 注意 `title` 里会出现"为什么城市需要树" —— 那是任务/内容的标题，
       * 被用于"这条任务引用的是什么"的说明性文案，不是题面正文。
       * 因此判据必须落在真正会被呈现为阅读材料的地方：`passage`。
       * 断言"整个序列化结果不含该字符串"会把标题也算进去，那是**过强**的断言
       * （它约束的是一条诊断文案不该提到被拒绝的内容名），而不是"合成正文没下发"。
       */
      expect(JSON.stringify(view)).not.toContain("合成正文不应被下发");
      expect(view).not.toHaveProperty("passage");
      expect(view).not.toHaveProperty("questions");
      expect(view).not.toHaveProperty("wordCount");
    });
  });
});

// ---------------------------------------------------------------------------
// 需求 3：模考保留绝不被选为普通阅读练习
// ---------------------------------------------------------------------------

describe("需求 3 · mock-reserve 试卷绝不被选为普通阅读练习", () => {
  it("唯一的阅读大题被设为模考保留时，候选列表为空", () => {
    withFixture({ pool: "mock_reserve" }, ({ repos, profileId }) => {
      expect(listReadingTargetCandidates(repos, profileId)).toHaveLength(0);
    });
  });

  it("模考保留时计划里没有阅读任务（不消耗未触碰材料）", () => {
    withFixture({ pool: "mock_reserve" }, ({ repos, profileId }) => {
      const plan = ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120 });
      expect(plan.tasks.some((t) => t.kind === "reading_comprehension")).toBe(false);
      // 而试卷本身仍然可读 —— 它只是不被当作日常训练材料
      const targets = listAllReadingTargets(repos, profileId);
      expect(targets.length).toBeGreaterThan(0);

      /*
       * 字段名与类型现在如实表达语义：`pool`（`PaperPool`）。
       *
       * 早先它叫 `progress` 且类型是 `string`，装的却是 `record.pool` ——
       * 那个不匹配直接导致调用方写裸字符串比较（`progress === "training"`），
       * 绕过领域层唯一的权威谓词。现已改为 `pool: PaperPool`，
       * 并统一经 `isPaperStartableForPractice` / `isPaperReservedForMock` 判断。
       */
      expect(targets[0].pool).toBe("mock_reserve");
    });
  });
  it("模考保留时旧执行器的历史阅读任务给出**具体**原因，而不是笼统不可用", () => {
    withFixture({ pool: "mock_reserve" }, ({ repos, profileId }) => {
      const legacy = repos.plan.savePlan(profileId, {
        date: "2026-09-27",
        availableMinutes: 60,
        plannedForMinutes: 12,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [
          {
            kind: "reading_comprehension",
            skill: "reading",
            priority: "core",
            title: "阅读训练 12 分钟",
            rationale: "",
            estimatedMinutes: 12,
            contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
            status: "pending",
            order: 0,
          },
        ],
      });

      const resolution = resolveLegacyReadingTask(repos, profileId, legacy.tasks[0]);
      expect(resolution.kind).toBe("blocked");
      if (resolution.kind === "blocked") {
        expect(resolution.reason).toContain("模考保留");
        // 必须说清为什么，而不是"暂无内容"
        expect(resolution.reason).toContain("没做过");
      }
    });
  });

  it("模考保留试卷的真实目标引用会被解析为不可用并说明原因", () => {
    withFixture({ pool: "mock_reserve" }, ({ repos, profileId }) => {
      const ref = encodeReadingTarget("fixture-cet6-2024-12-set1", "reading.banked_cloze");
      const resolution = resolveReadingTask(repos, profileId, ref);
      expect(resolution.kind).toBe("unavailable");
      if (resolution.kind === "unavailable") {
        expect(resolution.reason).toContain("模考保留");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 需求 4：没有合适的真实材料 → 如实不可用，绝不用合成内容顶替
// ---------------------------------------------------------------------------

describe("需求 4 · 无可用的真实训练材料时给出如实不可用状态，绝不回退合成内容", () => {
  it("真题库为空时：没有阅读任务，也没有任何合成阅读内容", () => {
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

    const plan = ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120 });

    // 空库 → 没有可训练的阅读大题 → planner 不排阅读任务（不排一个点不开的入口）
    expect(listReadingTargetCandidates(repos, profileId)).toHaveLength(0);
    expect(plan.tasks.some((t) => t.kind === "reading_comprehension")).toBe(false);

    // 而其他模块照常可用 —— 空库不是"整个产品不可用"
    expect(plan.tasks.length).toBeGreaterThan(0);
  });

  it("空库时历史合成阅读任务得到明确的不可用说明，且拒绝渲染合成内容", () => {
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

    const legacy = repos.plan.savePlan(profileId, {
      date: "2026-09-27",
      availableMinutes: 60,
      plannedForMinutes: 12,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        {
          kind: "reading_comprehension",
          skill: "reading",
          priority: "core",
          title: "阅读训练 12 分钟",
          rationale: "",
          estimatedMinutes: 12,
          contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
          status: "pending",
          order: 0,
        },
      ],
    });

    const resolution = resolveLegacyReadingTask(repos, profileId, legacy.tasks[0]);
    expect(resolution.kind).toBe("blocked");
    if (resolution.kind === "blocked") {
      expect(resolution.reason).toContain("真实历年真题");
      expect(resolution.reason).toContain("不会用自造题目顶替");
    }
  });

  it("引用损坏（格式非法）时按不可用处理，不猜测目标", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      for (const broken of ["", "no-separator", "::missing-paper", "missing-section::"]) {
        const resolution = resolveReadingTask(repos, profileId, broken);
        expect(resolution.kind).toBe("unavailable");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// 需求 5：历史完成记录仍然可读（history-safe）
// ---------------------------------------------------------------------------

describe("需求 5 · 历史记录保持可读，不被破坏性改写", () => {
  it("历史计划中的已完成阅读任务仍然能被读出来", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      // 模拟一条历史已完成任务（含合成引用）—— 它必须继续可读
      repos.plan.savePlan(profileId, {
        date: "2026-09-20",
        availableMinutes: 60,
        plannedForMinutes: 12,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [
          {
            id: "historical-task-1",
            kind: "reading_comprehension",
            skill: "reading",
            priority: "core",
            title: "阅读训练 12 分钟",
            rationale: "历史记录",
            estimatedMinutes: 12,
            contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
            status: "completed",
            order: 0,
          },
        ],
      });

      const stored = repos.plan.getPlan(profileId, "2026-09-20")!;
      const task = stored.tasks.find((t) => t.id === "historical-task-1")!;
      // 历史事实原样保留：状态、引用、标题都没被改写
      expect(task.status).toBe("completed");
      expect(task.contentRef?.contentId).toBe("read-city-trees");
      expect(task.title).toBe("阅读训练 12 分钟");
    });
  });

  it("重新生成今天的计划不会删除历史计划里的已完成任务", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      repos.plan.savePlan(profileId, {
        date: "2026-09-20",
        availableMinutes: 60,
        plannedForMinutes: 12,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [
          {
            id: "historical-task-2",
            kind: "reading_comprehension",
            skill: "reading",
            priority: "core",
            title: "阅读训练 12 分钟",
            rationale: "",
            estimatedMinutes: 12,
            contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
            status: "completed",
            order: 0,
          },
        ],
      });

      // 重排今天（force）——历史上已完成的那条不在这份计划里，因此不受影响
      ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120, force: true });
      const historical = repos.plan.getPlan(profileId, "2026-09-20")!;
      expect(historical.tasks.find((t) => t.id === "historical-task-2")?.status).toBe("completed");
    });
  });
});

// ---------------------------------------------------------------------------
// 需求 6 & 8：Expert 台账正常写入；路由规则唯一
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 评审 F1 · 历史合成任务必须被投影成 truthful 的真实真题 CTA
// ---------------------------------------------------------------------------

describe("评审 F1 · Today 对历史合成阅读任务的投影是「真话」", () => {
  /**
   * 构造一条**历史遗留**任务：引用合成篇章、至今 pending。
   *
   * 注意：历史日期（两天前）会让它进入 Today 的「补做」区，
   * 而 planner 重新排入逾期任务时**不保留原 id**（它按内容重新生成一行）——
   * 这是既有设计（任务 id 属于"今天的计划行"，不是"那条历史记录"）。
   * 因此下面**按 contentRef 定位**，不按 id：那才是稳定的领域身份。
   */
  function seedLegacySyntheticTask(repos: Repositories, profileId: string): void {
    repos.plan.savePlan(profileId, {
      date: "2026-09-25",
      availableMinutes: 60,
      plannedForMinutes: 12,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        {
          id: "legacy-synthetic-reading",
          kind: "reading_comprehension",
          skill: "reading",
          priority: "core",
          // 这就是 使用者 在截图上看到的那句
          title: "阅读训练 12 分钟",
          rationale: "历史遗留",
          estimatedMinutes: 12,
          contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
          status: "pending",
          order: 0,
        },
      ],
    });
  }

  /** Today 视图里**被投影的历史合成任务**（按 DB 行里的合成引用定位）。 */
  function findLegacyInToday(repos: Repositories, profileId: string) {
    const view = getTodayView(repos, profileId, "2026-09-28");
    /*
     * 判据是**底层引用仍是合成篇章**（`reading_passage`）——
     * 那正是"这一行来自历史"的稳定标识。不能只按 `isRealPaperReading` 过滤：
     * planner 自己也会排出真实阅读任务，那些不是我们要测的对象。
     */
    return view.tasks.find(
      (t) =>
        t.task.contentRef?.contentType === "reading_passage" &&
        t.task.kind === "reading_comprehension",
    );
  }

  it("标题不再是历史合成素材的措辞，而是真实卷次与大题名", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedLegacySyntheticTask(repos, profileId);

      const legacy = findLegacyInToday(repos, profileId);
      expect(legacy, "历史合成任务应出现在 Today 的补做区").toBeDefined();

      // 必须是真实真题阅读训练，且标题标明这一点
      expect(legacy!.isRealPaperReading).toBe(true);
      expect(legacy!.displayTitle).toContain("真实真题");
      /*
       * 标题给学习者的必须是**可读的卷次与大题名**（形如
       * 「真实真题阅读训练 · 2024 年 12 月 · set1 · 阅读 · 仔细阅读」），
       * 而不是内部 id —— 面向学习者的界面不该出现 `fixture-cet6-...`
       * 这类持久化标识。
       */
      expect(legacy!.displayTitle).toMatch(/\d{4} 年 \d+ 月/);
      expect(legacy!.displayTitle).toContain("阅读");
      expect(legacy!.displayTitle).not.toContain("fixture-");
      // 绝不能再暴露合成素材的标题
      expect(legacy!.displayTitle).not.toContain("为什么城市需要树");
      expect(JSON.stringify(legacy)).not.toContain("为什么城市需要树");
    });
  });

  it("时长来自真实目标的排练预算，而不是合成素材的 12 分钟", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedLegacySyntheticTask(repos, profileId);
      const legacy = findLegacyInToday(repos, profileId)!;

      // 历史行携带的仍是合成素材的 12 分钟（它被原样保留在 contentRef 一侧）
      expect(legacy.displayMinutes).not.toBe(12);
      expect(legacy.displayMinutes).toBe(legacy.candidate!.minutes);
      // 排练预算 = round(官方分值权重 × 官方笔试总时长)，恒为正
      expect(legacy.displayMinutes!).toBeGreaterThan(0);
    });
  });

  it("跳转指向该真实目标，且与展示的卷次一致", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedLegacySyntheticTask(repos, profileId);
      const legacy = findLegacyInToday(repos, profileId)!;

      expect(legacy.href).toBe(
        `/practice/papers/${legacy.candidate!.paperId}/train/${legacy.candidate!.sectionId}`,
      );
      expect(legacy.href).toMatch(/^\/practice\/papers\/[^/]+\/train\/[^/]+$/);
      // 绝不指向旧执行器
      expect(legacy.href).not.toBe(`/practice/${legacy.task.id}`);
      /*
       * 标题/时长/跳转三者必须来自**同一个**目标 ——
       * 否则会出现"标题说是 A、点下去去了 B"这种最坏的不一致。
       */
      const label = legacy.candidate!.label;
      expect(legacy.displayTitle).toContain(label);
      expect(legacy.href).toContain(encodeURIComponent(legacy.candidate!.sectionId));
    });
  });

  it("历史 DB 行本身没有被改写（引用与标题原样）", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedLegacySyntheticTask(repos, profileId);
      getTodayView(repos, profileId, "2026-09-28"); // 渲染一次（投影只发生在视图层）

      const row = repos.plan.getTask("legacy-synthetic-reading")!;
      expect(row.title, "历史标题必须原样保留").toBe("阅读训练 12 分钟");
      expect(row.contentRef?.contentType, "历史引用必须原样保留").toBe("reading_passage");
      expect(row.contentRef?.contentId).toBe("read-city-trees");
      expect(row.estimatedMinutes).toBe(12);
      expect(row.status).toBe("pending");
    });
  });

  it("没有可用真实目标时不编造时长，并给出不可用原因", () => {
    // 空库：没有任何可训练的真实阅读大题
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
    seedLegacySyntheticTask(repos, profileId);

    const legacy = findLegacyInToday(repos, profileId)!;

    expect(legacy.contentReady).toBe(false);
    // 没有可信数字时不显示时长（而不是沿用合成素材的 12 分钟）
    expect(legacy.displayMinutes).toBeNull();
    expect(legacy.minutesLabel).toBe("");
    expect(legacy.contentPendingReason).toBeTruthy();
    // 原因必须指向真实材料的缺失，且绝不含合成回退
    expect(legacy.contentPendingReason).toContain("真实历年真题");
    /*
     * 标题同样不得沿用历史行 —— 历史行写着「阅读训练 12 分钟」，
     * 那是合成素材的语义。把它摆在不可用的任务上，会让学习者以为
     * 产品里有一份 12 分钟的合成阅读训练（它其实已不再被使用）。
     */
    expect(legacy.displayTitle).not.toContain("12 分钟");
    expect(legacy.displayTitle).not.toContain("为什么城市需要树");
  });
});

// ---------------------------------------------------------------------------
// 评审 F2 · 同一个 canonical 目标只给一个入口
// ---------------------------------------------------------------------------

describe("评审 F2 · 同一 canonical 目标只被认领一次", () => {
  /**
   * 写入一条历史合成阅读任务（逾期 → 会进 Today 的补做区）。
   *
   * `date` 必须逐条不同：`savePlan` 按日期 upsert 并**整体替换该日的任务列表**，
   * 两次写同一天只会剩最后一条（实测踩到）。
   *
   * 定位一律按 **contentRef 的类型**（`reading_passage`）而不是任务 id：
   * planner 重新排入逾期任务时会生成新的计划行 id（既有设计），
   * 因此 id 不是稳定身份。
   */
  function seedLegacy(
    repos: Repositories,
    profileId: string,
    contentId: string,
    date: string,
  ): void {
    repos.plan.savePlan(profileId, {
      date,
      availableMinutes: 60,
      plannedForMinutes: 12,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        {
          id: `seed-${contentId}`,
          kind: "reading_comprehension",
          skill: "reading",
          priority: "core",
          title: "阅读训练 12 分钟",
          rationale: "",
          estimatedMinutes: 12,
          contentRef: { contentType: "reading_passage", contentId },
          status: "pending",
          order: 0,
        },
      ],
    });
  }

  /** 只取**由历史合成行投影而来**的阅读任务（底层引用仍是 `reading_passage`）。 */
  function legacyProjections(repos: Repositories, profileId: string) {
    const view = getTodayView(repos, profileId, "2026-09-28");
    return view.tasks.filter(
      (t) => t.task.contentRef?.contentType === "reading_passage" && t.isRealPaperReading,
    );
  }

  it("两条历史合成任务解析到同一目标时，只有一个渲染独立入口", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      /*
       * 构造"两条历史任务抢同一个 canonical 目标"。
       *
       * 这是真实可达的状态：两条历史合成任务都被投影到**当前第一个**
       * 可用目标（投影规则对历史行是"送到当前最合适的那一个大题"）。
       */
      seedLegacy(repos, profileId, "read-city-trees", "2026-09-25");
      seedLegacy(repos, profileId, "read-sleep-learning", "2026-09-24");

      const projections = legacyProjections(repos, profileId);
      expect(projections.length, "两条历史任务都应出现在 Today").toBeGreaterThanOrEqual(2);

      // 它们解析到同一个 canonical 目标
      const keys = new Set(projections.map((t) => t.canonicalKey));
      expect(keys.size, "两条历史任务应投影到同一个目标").toBe(1);
      expect([...keys][0]).not.toBeNull();

      // 只认领一次：恰好一个非重复项，其余标记为重复
      const claimed = projections.filter((t) => !t.canonicalDuplicate);
      expect(claimed, "同一目标应有且只有一个非重复项").toHaveLength(1);
      expect(projections.length - claimed.length).toBeGreaterThanOrEqual(1);
    });
  });

  it("认领顺序与主导动作一致：主导动作永远不会被判为重复", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedLegacy(repos, profileId, "read-city-trees", "2026-09-25");
      seedLegacy(repos, profileId, "read-sleep-learning", "2026-09-24");

      const view = getTodayView(repos, profileId, "2026-09-28");
      expect(view.nextTask, "应有主导任务").not.toBeNull();
      // 主导动作不能是被判为重复的那一条 —— 否则界面会自相矛盾
      expect(
        view.nextTask!.canonicalDuplicate,
        "主导动作不得被判为重复项",
      ).toBe(false);
    });
  });

  it("去重的精确不变量：每个 canonical 目标恰有一个非重复代表", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      /*
       * 这条断言的是**一般不变量**，而不是某个具体场景：
       *
       *   在可用的阅读任务里，每个 canonical 目标都恰好有一个
       *   未被标为重复的代表 —— 既不能有两个（重复入口），
       *   也不能一个都没有（目标被藏掉了）。
       *
       * 它同时覆盖"planner 合法排出多个不同大题"的情形，
       * 因此不需要为那种情形另写一条容易误伤的断言。
       */
      seedLegacy(repos, profileId, "read-city-trees", "2026-09-25");
      seedLegacy(repos, profileId, "read-sleep-learning", "2026-09-24");

      const view = getTodayView(repos, profileId, "2026-09-28");
      const ready = view.tasks.filter((t) => t.isRealPaperReading && t.contentReady && t.canonicalKey);

      const representatives = new Map<string, number>();
      for (const t of ready) {
        const key = t.canonicalKey!;
        if (!t.canonicalDuplicate) {
          representatives.set(key, (representatives.get(key) ?? 0) + 1);
        }
      }

      // 每个目标恰好一个代表
      for (const [key, count] of representatives) {
        expect(count, `目标 ${key} 应有且只有一个代表`).toBe(1);
      }
      // 每个出现过的目标都必须有代表（不能被藏掉）
      const allKeys = new Set(ready.map((t) => t.canonicalKey!));
      expect(
        representatives.size,
        "每个 canonical 目标都应有代表",
      ).toBe(allKeys.size);
      // 至少有两个不同目标（历史两条 + planner 自己排的），证明去重没有压扁多样性
      expect(allKeys.size).toBeGreaterThanOrEqual(2);
    });
  });

  it("重复项不重复计入计划负载（同一目标只算一次）", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      /*
       * 两条历史合成任务被投影到**同一个**真实目标。
       *
       * 界面已经不给第二条独立 CTA（显示「与上一条同一部分」），
       * 因为用户只会做一次。既然它不是可单独执行的工作量，
       * 就不该在那个目标之外再计一次时长 —— 否则"计划占用"会虚高，
       * 极端情况下超过可用时间（实测 64 > 60），那句"计划占用"
       * 就成了一句用户办不到的话。
       */
      seedLegacy(repos, profileId, "read-city-trees", "2026-09-25");
      seedLegacy(repos, profileId, "read-sleep-learning", "2026-09-24");

      const view = getTodayView(repos, profileId, "2026-09-28");
      const dupes = view.tasks.filter((t) => t.canonicalDuplicate);
      expect(dupes.length, "应有被判定为重复的项").toBeGreaterThanOrEqual(1);

      // 重复项不构成工作量
      for (const d of dupes) {
        expect(d.effectiveMinutes, "重复项不得计入计划负载").toBeNull();
      }

      // 因此总量 = 各非重复任务的有效分钟数之和
      const sumNonDuplicate = view.tasks
        .filter((t) => t.task.status !== "skipped" && !t.canonicalDuplicate)
        .reduce((sum, t) => sum + (t.effectiveMinutes ?? 0), 0);
      expect(view.plannedMinutes).toBe(sumNonDuplicate);
      expect(view.plannedMinutes).toBeLessThanOrEqual(view.availableMinutes);
    });
  });

  it("不变量：任何夹具状态下「计划占用 ≤ 可用时间」都成立", () => {
    /*
     * ── 为什么这是一条**跨状态**的不变量断言，而不只是某个场景 ──
     *
     * F8 修的是一个具体数字（64 > 60）。但"计划占用不得超过可用时间"是
     * 一条**对学习者成立的承诺**：它回答"今天做不做得完"。
     * 只要它在某个状态组合下被破坏，那句承诺就是假的。
     *
     * 因此这里穷举几个真实可能的状态 × 时间预算（短日 / 工作日 / 长日），
     * 逐个断言。这些组合正是我在审计中用一次性脚本跑过的
     * （当时 7/7 无违规）—— 现在把它固化成永久回归，
     * 而不是留在那个已删除的脚本里。
     */
    const budgets = [20, 60, 180];
    for (const budget of budgets) {
      withFixture(undefined, ({ repos, profileId }) => {
        // 两种历史 pending（会被投影到**同一个**目标 → 触发去重）
        seedLegacy(repos, profileId, "read-city-trees", "2026-09-25");
        seedLegacy(repos, profileId, "read-sleep-learning", "2026-09-24");

        // force 重排，确保补做逻辑真的跑（否则测不到历史任务在位的情形）
        const plan = ensurePlan(repos, profileId, "2026-09-28", {
          availableMinutes: budget,
          force: true,
        });
        const view = getTodayView(repos, profileId, "2026-09-28");

        // 不变量 1：计划占用不得超过可用时间
        expect(
          view.plannedMinutes,
          `可用 ${budget} 分钟时计划占用 ${view.plannedMinutes} 分钟 —— 超出即为谎报`,
        ).toBeLessThanOrEqual(plan.availableMinutes);

        // 不变量 2：重复项一律不构成工作量
        for (const t of view.tasks.filter((x) => x.canonicalDuplicate)) {
          expect(t.effectiveMinutes, "重复项不得计入计划负载").toBeNull();
        }

        // 不变量 3：总量恰为各非重复任务的有效分钟数之和
        const expected = view.tasks
          .filter((t) => t.task.status !== "skipped" && !t.canonicalDuplicate)
          .reduce((sum, t) => sum + (t.effectiveMinutes ?? 0), 0);
        expect(view.plannedMinutes).toBe(expected);
      });
    }
  });

  it("已完成的任务不构成活跃阅读入口", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      const candidate = listReadingTargetCandidates(repos, profileId)[0];
      /*
       * 已完成的任务写在**今天这一天**上。
       *
       * 不能写在前几天：`getOutstandingCoreTasks` 只捞 `pending` / `in_progress`，
       * 已完成的任务不会被带进今天（它留在自己那天，那是正确的）。
       * 而 `ensurePlan` 对当天计划会保留已完成的条目 —— 因此这里能观察到它。
       */
      repos.plan.savePlan(profileId, {
        date: "2026-09-28",
        availableMinutes: 60,
        plannedForMinutes: 12,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [
          {
            id: "done-reading",
            kind: "reading_comprehension",
            skill: "reading",
            priority: "core",
            title: "已完成",
            rationale: "",
            estimatedMinutes: 12,
            contentRef: {
              contentType: "reading_target",
              contentId: encodeReadingTarget(candidate.paperId, candidate.sectionId),
            },
            status: "completed",
            order: 0,
          },
        ],
      });

      const view = getTodayView(repos, profileId, "2026-09-28");
      const done = view.tasks.find((t) => t.task.id === "done-reading")!;

      // 它仍在视图里（当天已完成的任务会被保留），仍解析到真实目标
      expect(done).toBeDefined();
      expect(done.isRealPaperReading).toBe(true);
      expect(done.canonicalKey).not.toBeNull();
      expect(done.task.status).toBe("completed");

      // 但它绝不构成"下一步"：主导动作不会是它
      expect(view.nextTask?.task.id, "主导动作不应是已完成的任务").not.toBe("done-reading");
    });
  });
});

// ---------------------------------------------------------------------------
// 评审 F9 · 已完成的历史合成阅读是**历史事实**，不得重包装成真实真题
// ---------------------------------------------------------------------------

describe("评审 F9 · 已完成的历史合成阅读不得被伪装成真题", () => {
  /**
   * 写入一条**已完成**的历史合成阅读任务。
   *
   * 它代表真实发生过的事：用户在旧合成体系下做了一份合成阅读题并完成了它 ——
   * 那份材料不是任何真题。因此它的完成事实必须保持原样。
   */
  function seedCompletedLegacy(repos: Repositories, profileId: string): void {
    repos.plan.savePlan(profileId, {
      date: "2026-09-28",
      availableMinutes: 60,
      plannedForMinutes: 12,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        {
          id: "completed-legacy-synthetic",
          kind: "reading_comprehension",
          skill: "reading",
          priority: "core",
          title: "阅读训练 12 分钟",
          rationale: "历史遗留（当时用的是合成材料）",
          estimatedMinutes: 12,
          contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
          status: "completed",
          order: 0,
        },
      ],
    });
  }

  it("DB 行原样不变：状态、引用、标题、时长都没被改写", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedCompletedLegacy(repos, profileId);
      getTodayView(repos, profileId, "2026-09-28"); // 渲染一次（投影只在视图层）

      const row = repos.plan.getTask("completed-legacy-synthetic")!;
      expect(row.status).toBe("completed");
      expect(row.title).toBe("阅读训练 12 分钟");
      expect(row.contentRef?.contentType).toBe("reading_passage");
      expect(row.contentRef?.contentId).toBe("read-city-trees");
      expect(row.estimatedMinutes).toBe(12);
    });
  });

  it("视图里它是历史事实：不是真实真题、没有 canonical 目标、保留历史标题与时长", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedCompletedLegacy(repos, profileId);

      const view = getTodayView(repos, profileId, "2026-09-28");
      const task = view.tasks.find((t) => t.task.id === "completed-legacy-synthetic")!;
      expect(task).toBeDefined();

      // 关键：**不得**被标记为真实真题阅读
      expect(task.isRealPaperReading, "已完成的合成任务不得被标记为真实真题").toBe(false);
      // 不得分配 canonical 目标 —— 它没有做过任何真题
      expect(task.canonicalKey).toBeNull();
      expect(task.candidate).toBeNull();
      expect(task.isHistoricalCompleted).toBe(true);
      // 历史标题与时长原样保留（那是当时的事实）
      expect(task.displayTitle).toBe("阅读训练 12 分钟");
      expect(task.displayMinutes).toBe(12);
      /*
       * 它的分钟数照常计入今天的聚合 —— 它当时确实占用了那段时间。
       * F9 约束的是**语义**（不得被重新标记为真题），不是抹掉它的时长：
       * 抹掉会让"计划占用"小于"已完成"，读起来是坏的。
       */
      expect(task.effectiveMinutes).toBe(12);
      // 状态仍是 completed
      expect(task.task.status).toBe("completed");
    });
  });

  it("展示文案里不出现任何真题来源语义", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedCompletedLegacy(repos, profileId);
      const task = getTodayView(repos, profileId, "2026-09-28").tasks.find(
        (t) => t.task.id === "completed-legacy-synthetic",
      )!;

      const surface = JSON.stringify(task);
      expect(surface, "不得显示真实真题来源").not.toContain("真实真题");
      expect(surface, "不得出现真题卷次").not.toContain("fixture-cet6");
      expect(surface).not.toContain("2024 年 12 月");
    });
  });

  it("旧执行器**不得**把这条历史完成事实重定向进 Expert Training", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedCompletedLegacy(repos, profileId);
      const task = repos.plan.getTask("completed-legacy-synthetic")!;

      const resolution = resolveLegacyReadingTask(repos, profileId, task);
      expect(
        resolution.kind,
        "已完成的历史合成任务必须留在旧的'已完成'呈现，不得被重定向成真题训练",
      ).toBe("none");
    });
  });

  it("对照 1：**未完成**的历史合成任务确实会收敛到真实目标", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      // 同形态但 pending → 必须收敛（这证明规则不是"合成就一律不投影"）
      repos.plan.savePlan(profileId, {
        date: "2026-09-25",
        availableMinutes: 60,
        plannedForMinutes: 12,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [
          {
            id: "pending-legacy-synthetic",
            kind: "reading_comprehension",
            skill: "reading",
            priority: "core",
            title: "阅读训练 12 分钟",
            rationale: "",
            estimatedMinutes: 12,
            contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
            status: "pending",
            order: 0,
          },
        ],
      });

      const view = getTodayView(repos, profileId, "2026-09-28");
      const task = view.tasks.find(
        (t) => t.task.contentRef?.contentType === "reading_passage" && t.isRealPaperReading,
      )!;
      expect(task, "未完成的历史合成任务必须收敛").toBeDefined();
      expect(task.isRealPaperReading).toBe(true);
      expect(task.canonicalKey).not.toBeNull();
      expect(task.isHistoricalCompleted).toBe(false);
      expect(task.href).toMatch(/^\/practice\/papers\/[^/]+\/train\/[^/]+$/);
    });
  });

  it("对照 2：**已完成**的真实 reading_target 任务保持真题语义", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      /*
       * 这防止"completed 就永不投影"这种过宽的规则。
       * 一条真正练过的真题（引用 `reading_target`）即使已完成，
       * 也仍然是真实真题 —— 它的历史事实**本来就**是真题训练。
       */
      const candidate = listReadingTargetCandidates(repos, profileId)[0];
      repos.plan.savePlan(profileId, {
        date: "2026-09-28",
        availableMinutes: 60,
        plannedForMinutes: 13,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [
          {
            id: "completed-real-target",
            kind: "reading_comprehension",
            skill: "reading",
            priority: "core",
            title: "真实真题阅读训练",
            rationale: "",
            estimatedMinutes: 13,
            contentRef: {
              contentType: "reading_target",
              contentId: encodeReadingTarget(candidate.paperId, candidate.sectionId),
            },
            status: "completed",
            order: 0,
          },
        ],
      });

      const view = getTodayView(repos, profileId, "2026-09-28");
      const task = view.tasks.find((t) => t.task.id === "completed-real-target")!;

      expect(task.isRealPaperReading, "已完成的真题任务仍是真题").toBe(true);
      expect(task.canonicalKey).not.toBeNull();
      expect(task.isHistoricalCompleted).toBe(false);
      expect(task.displayTitle).toContain("真实真题");
      // 它照常计入今天的聚合（已完成的任务确实占用了计划时间）
      expect(task.effectiveMinutes).toBe(task.candidate!.minutes);

      // 旧执行器对它仍应重定向（它本来就是真题训练）
      const resolution = resolveLegacyReadingTask(repos, profileId, task.task);
      expect(resolution.kind).toBe("redirect");
    });
  });
});

// ---------------------------------------------------------------------------
// 评审 F8 · 分钟数聚合必须用有效分钟数
// ---------------------------------------------------------------------------

describe("评审 F8 · 当前计划的聚合不得泄露历史合成时长", () => {
  /** 一条 pending 的历史合成任务（存 12 分钟，投影到真实目标）。 */
  function seedPendingLegacy(repos: Repositories, profileId: string): void {
    repos.plan.savePlan(profileId, {
      date: "2026-09-25",
      availableMinutes: 180,
      plannedForMinutes: 12,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        {
          id: "pending-legacy-time",
          kind: "reading_comprehension",
          skill: "reading",
          priority: "core",
          title: "阅读训练 12 分钟",
          rationale: "",
          estimatedMinutes: 12,
          contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
          status: "pending",
          order: 0,
        },
      ],
    });
  }

  it("存储 12 分钟 → 投影 7 分钟；CTA / 清单 / 聚合全都用 7", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      seedPendingLegacy(repos, profileId);

      const view = getTodayView(repos, profileId, "2026-09-28");
      const legacy = view.tasks.find(
        (t) => t.task.contentRef?.contentType === "reading_passage" && t.isRealPaperReading,
      )!;

      // 存储值仍是历史事实
      expect(legacy.task.estimatedMinutes).toBe(12);
      // 展示与有效值都是真实目标的排练预算
      expect(legacy.displayMinutes).toBe(legacy.candidate!.minutes);
      expect(legacy.effectiveMinutes).toBe(legacy.candidate!.minutes);
      expect(legacy.effectiveMinutes).not.toBe(12);
      expect(legacy.displayMinutes).toBe(7); // 选词填空：round(0.05 × 130)

      /*
       * 聚合不变量：`plannedMinutes` 必须等于各任务**有效分钟数**之和，
       * 因此它包含 7 而不是 12。
       */
      const sumEffective = view.tasks
        .filter((t) => t.task.status !== "skipped")
        .reduce((sum, t) => sum + (t.effectiveMinutes ?? 0), 0);
      expect(view.plannedMinutes).toBe(sumEffective);

      // 明确验证：那个 12 没有以任何方式混进当前计划的总量
      const withoutLegacy = sumEffective - legacy.effectiveMinutes!;
      expect(view.plannedMinutes - withoutLegacy).toBe(7);
    });
  });

  it("不可用的投影阅读任务不计入当前计划总量", () => {
    // 空库 → 历史任务投影失败（无可用真实目标）
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
    seedPendingLegacy(repos, profileId);

    const view = getTodayView(repos, profileId, "2026-09-28");
    const legacy = view.tasks.find(
      (t) => t.task.contentRef?.contentType === "reading_passage",
    )!;

    expect(legacy.contentReady).toBe(false);
    // 不可执行 → 不构成当前工作量，那个 12 不得计入
    expect(legacy.effectiveMinutes).toBeNull();
    const sumEffective = view.tasks
      .filter((t) => t.task.status !== "skipped")
      .reduce((sum, t) => sum + (t.effectiveMinutes ?? 0), 0);
    expect(view.plannedMinutes).toBe(sumEffective);
    /*
     * 它自身那个 12 没有进入总量：把所有**其它**任务的有效分钟数加起来，
     * 必须恰好等于总量（即这条任务贡献了 0）。
     */
    const othersOnly = view.tasks
      .filter((t) => t.task.id !== legacy.task.id && t.task.status !== "skipped")
      .reduce((sum, t) => sum + (t.effectiveMinutes ?? 0), 0);
    expect(view.plannedMinutes).toBe(othersOnly);
  });

  it("历史已完成任务的分钟数照常计入（它当时确实占用了那段时间）", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      repos.plan.savePlan(profileId, {
        date: "2026-09-28",
        availableMinutes: 60,
        plannedForMinutes: 12,
        generatedBy: "deterministic_planner",
        notes: [],
        warnings: [],
        tasks: [
          {
            id: "completed-legacy-time",
            kind: "reading_comprehension",
            skill: "reading",
            priority: "core",
            title: "阅读训练 12 分钟",
            rationale: "",
            estimatedMinutes: 12,
            contentRef: { contentType: "reading_passage", contentId: "read-city-trees" },
            status: "completed",
            order: 0,
          },
        ],
      });

      const view = getTodayView(repos, profileId, "2026-09-28");
      const done = view.tasks.find((t) => t.task.id === "completed-legacy-time")!;
      // 历史时长原样保留，并计入聚合 —— 它当时确实占用了 12 分钟
      expect(done.effectiveMinutes).toBe(12);
      expect(done.displayMinutes).toBe(12);
      expect(view.completedMinutes).toBe(12);
      // 但它**不是**真实真题（F9 的核心），也不提供任何真题入口
      expect(done.isRealPaperReading).toBe(false);
      expect(done.canonicalKey).toBeNull();
      expect(view.plannedMinutes).toBeGreaterThanOrEqual(view.completedMinutes);
    });
  });
});

// ---------------------------------------------------------------------------
// 评审 F7 · Practice 计划区必须消费 TodayTaskView
// ---------------------------------------------------------------------------

describe("评审 F7 · Practice 计划区使用投影后的字段", () => {
  it("页面不得再读 item.task.title / item.task.estimatedMinutes", () => {
    /*
     * 白盒断言：F7 的根因正是 Practice 页直接读了原始任务字段。
     * 这是一条**源码级**守卫 —— 它防止那个读法以任何形式回来，
     * 而 UI 行为由 `e2e/legacy-reading-convergence.spec.ts` 在浏览器里验证。
     */
    const source = readFileSync(join(process.cwd(), "src/app/practice/page.tsx"), "utf8");
    expect(source.includes("item.task.title"), "Practice 不得读原始任务标题").toBe(false);
    expect(
      source.includes("item.task.estimatedMinutes"),
      "Practice 不得读原始任务时长",
    ).toBe(false);
    // 它必须消费投影后的字段
    expect(source).toContain("item.displayTitle");
    expect(source).toContain("item.displayMinutes");
    expect(source).toContain("item.canonicalDuplicate");
  });
});

describe("需求 8 · 跳转规则收敛到一处（界面不得自己拼 URL）", () => {
  it("阅读引用 → 真实真题工作面；其他引用 → 旧执行器", () => {
    const readingRef = { contentType: "reading_target" as const, contentId: encodeReadingTarget("paper-1", "reading.matching") };
    expect(taskHrefOf("task-1", readingRef)).toBe("/practice/papers/paper-1/train/reading.matching");

    const writingRef = { contentType: "writing_prompt" as const, contentId: "write-1" };
    expect(taskHrefOf("task-1", writingRef)).toBe("/practice/task-1");

    expect(taskHrefOf("task-1", null)).toBe("/practice/task-1");
    expect(taskHrefOf("task-1", { contentType: "review_deck", contentId: "deck" })).toBe("/practice/task-1");
  });

  it("编码/解码互为逆运算，且拒绝非法输入", () => {
    const ref = encodeReadingTarget("cet6-2024-12-set1", "reading.careful_reading");
    expect(ref).toBe("cet6-2024-12-set1::reading.careful_reading");
    expect(decodeReadingTarget(ref)).toEqual({
      paperId: "cet6-2024-12-set1",
      sectionId: "reading.careful_reading",
    });

    expect(decodeReadingTarget("")).toBeNull();
    expect(decodeReadingTarget("::x")).toBeNull();
    expect(decodeReadingTarget("x::")).toBeNull();
    expect(decodeReadingTarget("nosep")).toBeNull();
  });

  it("时长估算由分值权重分摊，并对三个阅读大题给出可解释的值", () => {
    // 官方笔试 130 分钟；权重 0.05 / 0.10 / 0.20（见 domain/paper）
    expect(estimateReadingSectionMinutes("reading.banked_cloze")).toBe(7);
    expect(estimateReadingSectionMinutes("reading.matching")).toBe(13);
    expect(estimateReadingSectionMinutes("reading.careful_reading")).toBe(26);
    // 严格单调：分值与预算同向，不做无依据的调整
    expect(estimateReadingSectionMinutes("reading.banked_cloze")).toBeLessThan(
      estimateReadingSectionMinutes("reading.matching"),
    );
    expect(estimateReadingSectionMinutes("reading.matching")).toBeLessThan(
      estimateReadingSectionMinutes("reading.careful_reading"),
    );
  });

  it("readingTargetHrefOf 只对真实真题引用返回 URL", () => {
    expect(readingTargetHrefOf({ contentType: "reading_target", contentId: "a::b" })).toBe(
      "/practice/papers/a/train/b",
    );
    expect(readingTargetHrefOf({ contentType: "writing_prompt", contentId: "a::b" })).toBeNull();
    expect(readingTargetHrefOf(null)).toBeNull();
  });
});

describe("候选排序规则（进行中 > 未开始 > 已完成）", () => {
  it("优先级顺序正确：未开始的阅读大题排在已完成的之前", () => {
    withFixture(undefined, ({ repos, profileId }) => {
      const targets = listAllReadingTargets(repos, profileId)[0].targets;
      expect(targets.length).toBe(3);

      const candidates = listReadingTargetCandidates(repos, profileId);
      // 初始状态：全部未开始 → priorityRank 全为 1
      expect(candidates.every((c) => c.priorityRank === 1)).toBe(true);

      // 给其中一个开出进行中会话 → 它必须排到第一
      const chosen = candidates[0];
      expect(repos.expert.startRun({
        id: "run-in-progress",
        profileId,
        paperId: chosen.paperId,
        contentVersion: 1,
        sectionId: chosen.sectionId,
        sectionType: chosen.sectionType,
        groupIds: [],
        itemCount: chosen.questionCount,
        startedAt: "2026-09-27T00:00:00.000Z",
      })).toBeTruthy();

      const reranked = listReadingTargetCandidates(repos, profileId);
      expect(reranked[0].sectionId).toBe(chosen.sectionId);
      expect(reranked[0].priorityRank).toBe(0);
      expect(reranked[0].rationaleNote).toContain("还没交卷");
    });
  });
});

describe("需求 6 · Expert Training 的不可变证据仍然正常记录", () => {
  it("通过真实真题链路提交后，observations 与 assessments 都成对写入", async () => {
    const { submitReadingRun, getSectionTrainingState: getState } = await import("@/services/expert-training");
    const fixture = buildFixture();
    try {
      const { repos, profileId } = fixture;

      const state = getState(repos, profileId, fixture.paperId, "reading.careful_reading");
      expect(state.ok).toBe(false); // 还没开始

      const candidates = listReadingTargetCandidates(repos, profileId);
      const target = candidates.find((c) => c.sectionId === "reading.careful_reading")!;
      expect(target).toBeDefined();

      const run = repos.expert.startRun({
        id: "run-evidence",
        profileId,
        paperId: target.paperId,
        contentVersion: 1,
        sectionId: target.sectionId,
        sectionType: target.sectionType,
        groupIds: [],
        itemCount: target.questionCount,
        startedAt: "2026-09-27T00:00:00.000Z",
      });
      expect(run.status).toBe("in_progress");

      const result = submitReadingRun(repos, profileId, {
        runId: run.id,
        responses: answerEveryQuestion(repos, fixture.paperId, target.sectionId),
        elapsedSeconds: 600,
        changedQuestionIds: [],
      });

      expect(result.ok, result.ok ? "" : result.error).toBe(true);
      const events = repos.expert.listEventsForRun(run.id);
      const assessments = repos.expert.listAssessmentsForRun(run.id);

      expect(events.length).toBe(target.questionCount);
      expect(assessments.length).toBe(target.questionCount);
      // 未作答不计为错误 —— 这里全部作答了，因此只有 correct / incorrect
      for (const event of events) {
        expect(["correct", "incorrect", "skipped"]).toContain(event.outcome);
        // 观测里不存在任何因果字段
        expect(Object.keys(event)).not.toContain("mechanism");
        expect(Object.keys(event)).not.toContain("weakness");
      }
    } finally {
      cleanup();
    }
  });
});

/** 为该大题的每道题给出一个非空作答（不关心对错，只要求产生观测）。 */
function answerEveryQuestion(
  repos: Repositories,
  paperId: string,
  sectionId: string,
): Array<{ questionId: string; value: string | null }> {
  /*
   * 从**当前内容包**读取题面结构来生成作答。
   *
   * 注意这里读的是 `getPaperDetail`（内容包），不是可作答视图 ——
   * 提交需要为每道题给一个值，而生成"任意一个非空值"必须知道题面形状。
   * 这不违反"答案不下发到客户端"：本函数只取 options / wordBank / paragraphs
   * 的**第一项**当作作答，从不读取 `answer` / `answerParagraph` 字段。
   */
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
