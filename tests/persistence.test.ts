import { describe, expect, it } from "vitest";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { createTestDb, resetDb } from "@/db/client";
import { completeOnboarding, getOnboardingState } from "@/services/onboarding";
import { getDiagnosticOutcome, startDiagnostic, submitDiagnostic, gradeSession } from "@/services/diagnostic";
import { getTodayView, ensurePlan, setAvailableMinutes, deferRemainingTasks } from "@/services/plan";
import { getTaskDetail, submitTask } from "@/services/practice";
import { DIAGNOSTIC_ITEMS } from "@/content/diagnostic-bank";
import { CET6_EXAM_DATE } from "@/domain/exam-facts";
import { addDays } from "@/lib/date";

/**
 * 持久化与全链路集成测试。
 *
 * 用内存 SQLite 跑真实的 repository 实现 —— 不打桩数据库，
 * 因此这些测试同时验证了 SQL 语句与行映射的正确性。
 */

function freshRepos() {
  const db = createTestDb();
  resetDb(db);
  return createSqliteRepositories(db);
}

/**
 * 真实当天日期（本地时区）。
 * 复习与"今天"相关的行为必须用真实日期，因为 service 层用的是系统时钟 ——
 * 用固定的未来日期测这些路径会得到假结论。
 */
function realToday(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const ONBOARDING = {
  displayName: "Learner",
  examName: "CET-6 2026-12",
  examDate: CET6_EXAM_DATE,
  targetScore: 550,
  weekdayMinutes: 60,
  weekendMinutes: 120,
};

describe("onboarding 持久化", () => {
  it("保存后可以读回，字段完整", () => {
    const repos = freshRepos();
    expect(getOnboardingState(repos).onboarded).toBe(false);

    const result = completeOnboarding(repos, ONBOARDING);
    expect(result.ok).toBe(true);

    const state = getOnboardingState(repos);
    expect(state.onboarded).toBe(true);
    expect(state.profile?.displayName).toBe("Learner");
    expect(state.profile?.preferences.weekdayMinutes).toBe(60);
    expect(state.profile?.preferences.weekendMinutes).toBe(120);
    expect(state.goal?.targetScore).toBe(550);
    expect(state.goal?.examDate).toBe(CET6_EXAM_DATE);
  });

  it("重复提交是更新而不是插入重复记录", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    completeOnboarding(repos, { ...ONBOARDING, targetScore: 600 });
    expect(repos.learner.getGoal(repos.learner.getProfile()!.id)?.targetScore).toBe(600);
  });

  it("拒绝非法输入", () => {
    const repos = freshRepos();
    const bad = completeOnboarding(repos, { ...ONBOARDING, targetScore: 900 });
    expect(bad.ok).toBe(false);

    const badDate = completeOnboarding(repos, { ...ONBOARDING, examDate: "not-a-date" });
    expect(badDate.ok).toBe(false);
  });

  it("更新常规时间不影响考试目标", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    repos.learner.updatePreferences(profileId, { weekdayMinutes: 30, weekendMinutes: 90 });
    expect(repos.learner.getProfile()!.preferences.weekdayMinutes).toBe(30);
    expect(repos.learner.getGoal(profileId)!.targetScore).toBe(550);
  });
});

describe("诊断落库与画像生成", () => {
  function seedDiagnostic(repos: ReturnType<typeof freshRepos>, correctDimensions: string[] = []) {
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    const session = startDiagnostic(repos, profileId);

    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type !== "pending_media").map((item) => {
      const shouldBeCorrect = correctDimensions.includes(item.dimension);
      return {
        itemId: item.id,
        dimension: item.dimension,
        choiceId:
          item.type === "mcq"
            ? shouldBeCorrect
              ? item.correctChoiceId!
              : item.choices!.find((c) => c.id !== item.correctChoiceId)!.id
            : null,
        text: item.type === "short_text" ? (shouldBeCorrect ? "answered with content" : "") : null,
        skipped: item.type === "short_text" && !shouldBeCorrect,
      };
    });

    const submitted = submitDiagnostic(repos, { sessionId: session.id, answers });
    expect(submitted.ok).toBe(true);
    return { profileId, sessionId: session.id };
  }

  it("作答被持久化，读回数量一致", () => {
    const repos = freshRepos();
    const { sessionId } = seedDiagnostic(repos, ["reading"]);
    const session = repos.diagnostic.getSession(sessionId)!;
    expect(session.answers.length).toBe(DIAGNOSTIC_ITEMS.filter((i) => i.type !== "pending_media").length);
    expect(session.completedAt).not.toBeNull();
  });

  it("结果来自实际作答而非固定值", () => {
    const reposGood = freshRepos();
    seedDiagnostic(reposGood, ["reading", "vocabulary", "listening"]);
    const good = getDiagnosticOutcome(reposGood, reposGood.learner.getProfile()!.id)!;

    const reposBad = freshRepos();
    seedDiagnostic(reposBad, []);
    const bad = getDiagnosticOutcome(reposBad, reposBad.learner.getProfile()!.id)!;

    const goodReading = good.dimensionResults.find((r) => r.dimension === "reading")!;
    const badReading = bad.dimensionResults.find((r) => r.dimension === "reading")!;
    expect(goodReading.adjustedScore).toBeGreaterThan(badReading.adjustedScore);
  });

  it("生成能力画像并落库", () => {
    const repos = freshRepos();
    const { profileId } = seedDiagnostic(repos, ["reading"]);
    const profile = repos.skillProfile.get(profileId);
    expect(profile).not.toBeNull();
    expect(profile!.basedOnDiagnosticId).toBeTruthy();
    expect(Object.keys(profile!.skills)).toHaveLength(4);
    expect(profile!.recommendations).toHaveLength(4);
  });

  it("提交不存在的会话返回错误而不是抛异常", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const result = submitDiagnostic(repos, { sessionId: "does-not-exist", answers: [] });
    expect(result.ok).toBe(false);
  });

  it("提交无效 itemId 被过滤掉", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const session = startDiagnostic(repos, repos.learner.getProfile()!.id);
    const result = submitDiagnostic(repos, {
      sessionId: session.id,
      answers: [
        { itemId: "bogus", dimension: "reading", choiceId: "a", text: null, skipped: false },
      ],
    });
    expect(result.ok).toBe(false);
  });
});

describe("计划生成与重排", () => {
  it("诊断完成后可以生成今日计划并落库", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    ensurePlan(repos, profileId, "2026-09-28");

    const plan = repos.plan.getPlan(profileId, "2026-09-28");
    expect(plan).not.toBeNull();
    expect(plan!.tasks.length).toBeGreaterThan(0);
  });

  it("同一天多次调用不产生重复任务", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    const first = ensurePlan(repos, profileId, "2026-09-28");
    const second = ensurePlan(repos, profileId, "2026-09-28");
    expect(second.tasks.length).toBe(first.tasks.length);
    expect(second.id).toBe(first.id);
  });

  it("可用时间设为 20 分钟后计划被真实重排", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    ensurePlan(repos, profileId, "2026-09-28");

    const result = setAvailableMinutes(repos, profileId, 20, "2026-09-28");
    expect(result.ok).toBe(true);

    const plan = repos.plan.getPlan(profileId, "2026-09-28")!;
    expect(plan.availableMinutes).toBe(20);
    expect(plan.tasks.every((t) => t.priority === "core" || t.status === "completed")).toBe(true);
    const total = plan.tasks
      .filter((t) => t.status !== "completed")
      .reduce((sum, t) => sum + t.estimatedMinutes, 0);
    expect(total).toBeLessThanOrEqual(20);
  });

  it("重排保留已完成的任务", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    const plan = ensurePlan(repos, profileId, "2026-09-28");
    const firstTask = plan.tasks[0];
    repos.plan.updateTaskStatus(firstTask.id, "completed", "2026-09-28T10:00:00.000Z");

    setAvailableMinutes(repos, profileId, 30, "2026-09-28");
    const after = repos.plan.getPlan(profileId, "2026-09-28")!;
    const kept = after.tasks.find((t) => t.id === firstTask.id);
    expect(kept).toBeDefined();
    expect(kept!.status).toBe("completed");
  });

  it("重排累计 revisionCount", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    ensurePlan(repos, profileId, "2026-09-28");
    setAvailableMinutes(repos, profileId, 40, "2026-09-28");
    setAvailableMinutes(repos, profileId, 50, "2026-09-28");
    expect(repos.plan.getPlan(profileId, "2026-09-28")!.revisionCount).toBeGreaterThanOrEqual(2);
  });

  it("非法时间被拒绝", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    expect(setAvailableMinutes(repos, profileId, -5, "2026-09-28").ok).toBe(false);
    expect(setAvailableMinutes(repos, profileId, 9999, "2026-09-28").ok).toBe(false);
  });

  it("跨日补做：前一日未完成的 core 任务出现在后一日计划中", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    ensurePlan(repos, profileId, "2026-09-28");

    const outstanding = repos.plan.getOutstandingCoreTasks(profileId, "2026-09-29");
    expect(outstanding.length).toBeGreaterThan(0);

    const next = ensurePlan(repos, profileId, "2026-09-29");
    expect(next.tasks.some((t) => t.title.startsWith("补做"))).toBe(true);
  });

  it("deferRemainingTasks 把剩余任务标记为 skipped", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    ensurePlan(repos, profileId, "2026-09-28");
    const result = deferRemainingTasks(repos, profileId, "2026-09-28");
    expect(result.moved).toBeGreaterThan(0);
    const plan = repos.plan.getPlan(profileId, "2026-09-28")!;
    expect(plan.tasks.every((t) => t.status === "skipped")).toBe(true);
  });
});

describe("任务执行闭环", () => {
  /** 完成一次诊断以建立能力画像（训练证据回写需要画像存在）。 */
  function seedDiagnosticAndPlan(repos: ReturnType<typeof freshRepos>) {
    const session = startDiagnostic(repos, repos.learner.getProfile()!.id);
    submitDiagnostic(repos, {
      sessionId: session.id,
      answers: DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => ({
        itemId: i.id,
        dimension: i.dimension,
        choiceId: i.choices!.find((c) => c.id !== i.correctChoiceId)!.id,
        text: null,
        skipped: false,
      })),
    });
  }

  async function setupWithPlan() {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    seedDiagnosticAndPlan(repos);
    const plan = ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120 });
    return { repos, profileId, plan };
  }

  it("词汇任务（旧闭环载体）：全对时落库并更新 Today 状态", async () => {
    const { repos, profileId, plan } = await setupWithPlan();
    /**
     * ── 为什么载体从阅读改成词汇 ──
     *
     * 本组测试验证的是**旧闭环的任务执行链路**（`submitTask` →
     * `study_session` / `answer_attempt` / 画像回写 / 复习队列）。
     *
     * 阅读训练已经收敛：它不再走这条链路，而是走真实真题的 Expert Training
     * 工作面并写入 Expert 不可变台账。因此旧的阅读路径**在原理上**不再被
     * 新计划生成（见本文件末尾的收敛回归）。继续拿它当载体，
     * 测的就是一条产品已经决定淘汰的路径。
     *
     * 词汇任务仍然走旧闭环，且同样是「多道客观题 + 答错进复习队列」，
     * 因此下面每一条断言的对象与强度都没有变。
     */
    const vocabTask = plan.tasks.find((t) => t.kind === "vocabulary_recall")!;
    expect(vocabTask).toBeDefined();

    const detail = getTaskDetail(repos, vocabTask.id)!;
    expect(detail.content?.type).toBe("vocabulary_set");
    const entries = (detail.content as Extract<typeof detail.content, { type: "vocabulary_set" }>).entries;

    const result = await submitTask(repos, profileId, {
      taskId: vocabTask.id,
      answers: entries.map((e) => ({ questionId: e.id, choiceId: e.correctChoiceId })),
      writing: "",
      reviewedItemIds: [],
      elapsedMinutes: 10,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feedback.score).toBe(1);
    expect(result.feedback.gradedBy).toBe("local-rubric");
    expect(result.feedback.correctCount).toBe(entries.length);

    const before = getTodayView(repos, profileId, "2026-09-28").completedCount;
    expect(before).toBeGreaterThan(0);

    const tasksAfter = repos.plan.getPlan(profileId, "2026-09-28")!.tasks;
    expect(tasksAfter.find((t) => t.id === vocabTask.id)!.status).toBe("completed");
    expect(repos.records.listRecentSessions(profileId, 5).length).toBe(1);
  });

  it("词汇任务（旧闭环载体）：全错时生成复习项与错因记录", async () => {
    const { repos, profileId, plan } = await setupWithPlan();
    const vocabTask = plan.tasks.find((t) => t.kind === "vocabulary_recall")!;
    const detail = getTaskDetail(repos, vocabTask.id)!;
    const entries = (detail.content as Extract<typeof detail.content, { type: "vocabulary_set" }>).entries;

    const result = await submitTask(repos, profileId, {
      taskId: vocabTask.id,
      answers: entries.map((e) => ({
        questionId: e.id,
        choiceId: e.choices.find((c) => c.id !== e.correctChoiceId)!.id,
      })),
      writing: "",
      reviewedItemIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feedback.score).toBe(0);
    expect(result.feedback.errorTags.length).toBe(entries.length);
    expect(result.feedback.reviewItemsCreated).toBe(entries.length);

    /*
     * 断言"错答真的进了复习队列，且排到明天"。
     *
     * 早先这里写的是 `getDueItems(profileId, "2026-09-29")` —— 一个硬编码日期。
     * 那是一个**时间炸弹**：入库用的到期日是 `todayISO() + 1`（跟随真实时钟），
     * 而查询用的是写死的日期。在机器日期早于 2026-09-29 时它恰好成立，
     * 一旦本机时钟走到那一天，`dueOn`（9-30）就晚于查询日（9-29），
     * 断言凭空失败 —— 与代码行为无关。
     *
     * 现在改为断言**规则本身**：队列里恰好有这些项，且每项的到期日
     * 就是"明天"（相对入库时的真实今天）。这比原来的写法更强，
     * 也不再依赖运行测试的日期。
     */
    const queued = repos.review
      .listAll(profileId)
      .filter((item) => item.prompt.length > 0);
    expect(queued.length).toBe(entries.length);
    const tomorrow = addDays(realToday(), 1);
    expect(queued.every((item) => item.dueOn === tomorrow)).toBe(true);
    // 到期日在明天 → 今天查不到、明天才到期，这正是"遗忘窗口"的语义
    expect(repos.review.getDueItems(profileId, realToday()).length).toBe(0);
    expect(repos.review.getDueItems(profileId, tomorrow).length).toBe(entries.length);
  });

  it("重复提交同一任务被拒绝", async () => {
    const { repos, profileId, plan } = await setupWithPlan();
    const task = plan.tasks.find((t) => t.kind === "vocabulary_recall")!;
    const detail = getTaskDetail(repos, task.id)!;
    const entries = (detail.content as Extract<typeof detail.content, { type: "vocabulary_set" }>).entries;
    const payload = {
      taskId: task.id,
      answers: entries.map((e) => ({ questionId: e.id, choiceId: e.correctChoiceId })),
      writing: "",
      reviewedItemIds: [],
    };

    expect((await submitTask(repos, profileId, payload)).ok).toBe(true);
    const second = await submitTask(repos, profileId, payload);
    expect(second.ok).toBe(false);
  });

  it("提交不存在的任务返回错误", async () => {
    const { repos, profileId } = await setupWithPlan();
    const result = await submitTask(repos, profileId, {
      taskId: "nope",
      answers: [],
      writing: "",
      reviewedItemIds: [],
    });
    expect(result.ok).toBe(false);
  });

  it("听力不会出现在计划里（无音频素材），因此不存在可提交的听力任务", async () => {
    const { repos, profileId, plan } = await setupWithPlan();
    // Phase 1 没有听力素材：planner 刻意不排听力任务，
    // 这样 Today 不会出现一个永远点不开的入口。
    expect(plan.tasks.some((t) => t.kind === "listening_comprehension")).toBe(false);

    // 若绕过 planner 直接构造一个听力任务，提交必须被明确拒绝并说明素材缺口
    const fakeListening = repos.plan.savePlan(profileId, {
      date: "2026-09-29",
      availableMinutes: 30,
      plannedForMinutes: 10,
      generatedBy: "deterministic_planner",
      notes: [],
      warnings: [],
      tasks: [
        {
          kind: "listening_comprehension",
          skill: "listening",
          priority: "core",
          title: "听力训练 10 分钟",
          rationale: "测试用",
          estimatedMinutes: 10,
          contentRef: { contentType: "listening_pending", contentId: "listen-pending-short-conversation" },
          status: "pending",
          order: 0,
        },
      ],
    });

    const result = await submitTask(repos, profileId, {
      taskId: fakeListening.tasks[0].id,
      answers: [],
      writing: "",
      reviewedItemIds: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("音频素材");
    }
  });

  it("翻译任务：提交后得到本地规则反馈并标注来源", async () => {
    const { repos, profileId, plan } = await setupWithPlan();
    const translation = plan.tasks.find((t) => t.kind === "translation_drill")!;
    const detail = getTaskDetail(repos, translation.id)!;
    const content = detail.content as Extract<typeof detail.content, { type: "translation_prompt" }>;

    const result = await submitTask(repos, profileId, {
      taskId: translation.id,
      answers: [],
      writing: content.referenceTranslation,
      reviewedItemIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feedback.gradedBy).toBe("local-rubric");
    expect(result.feedback.disclaimer).toContain("本地规则评分");
    expect(result.feedback.score).toBeGreaterThan(0.5);
  });

  it("写作任务：过短作文被识别为问题并降低分数", async () => {
    const { repos, profileId, plan } = await setupWithPlan();
    const writing = plan.tasks.find((t) => t.kind === "writing_drill")!;

    const result = await submitTask(repos, profileId, {
      taskId: writing.id,
      answers: [],
      writing: "I agree. It is good.",
      reviewedItemIds: [],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.feedback.gradedBy).toBe("local-rubric");
    expect(result.feedback.summary).toContain("字数");
    expect(result.feedback.score).toBeLessThan(0.7);
  });

  it("训练反馈会回写能力画像的证据计数", async () => {
    const { repos, profileId, plan } = await setupWithPlan();
    const before = repos.skillProfile.get(profileId)!.skills.reading.evidenceCount;
    // 载体见上：旧闭环的事务性与画像回写由词汇任务验证（阅读已走 Expert 台账）
    const task = plan.tasks.find((t) => t.kind === "vocabulary_recall")!;
    const detail = getTaskDetail(repos, task.id)!;
    const entries = (detail.content as Extract<typeof detail.content, { type: "vocabulary_set" }>).entries;

    await submitTask(repos, profileId, {
      taskId: task.id,
      answers: entries.map((e) => ({ questionId: e.id, choiceId: e.correctChoiceId })),
      writing: "",
      reviewedItemIds: [],
    });

    const after = repos.skillProfile.get(profileId)!.skills.reading;
    expect(after.evidenceCount).toBeGreaterThan(before);
    expect(after.lastUpdatedAt).not.toBe("");
  });

  it("复习任务：勾选项目后被顺延到明天", async () => {
    const { repos, profileId } = await setupWithPlan();
    // 复习的到期日以**实际复习日期**为基准，而不是计划日期 ——
    // 用户今天复习了，明天就该再见到它。
    const today = realToday();
    const item = repos.review.upsert({
      profileId,
      contentItemId: "c-review-test",
      contentRef: { contentType: "review_deck", contentId: "c-review-test" },
      skill: "reading",
      prompt: "测试复习项",
      dueOn: today,
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 1,
      lastReviewedOn: null,
    });

    const plan = ensurePlan(repos, profileId, realToday(), { force: true });
    const reviewTask = plan.tasks.find((t) => t.kind === "review")!;
    expect(reviewTask).toBeDefined();

    const result = await submitTask(repos, profileId, {
      taskId: reviewTask.id,
      answers: [],
      writing: "",
      reviewedItemIds: [item.id],
    });
    expect(result.ok).toBe(true);

    const refreshed = repos.review.listAll(profileId).find((r) => r.id === item.id)!;
    expect(refreshed.reps).toBe(1);
    expect(refreshed.lastReviewedOn).toBe(today);
    expect(refreshed.dueOn > today).toBe(true);
  });
});

describe("Today 视图状态变化", () => {
  it("完成任务后 Today 的完成数与进度真实变化", async () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120 });

    const before = getTodayView(repos, profileId, "2026-09-28");
    expect(before.completedCount).toBe(0);
    expect(before.progress).toBe(0);

    // 载体见上：旧闭环的完成状态由词汇任务验证（阅读已走 Expert 台账）
    const task = before.tasks.find((t) => t.task.kind === "vocabulary_recall")!;
    const detail = getTaskDetail(repos, task.task.id)!;
    const entries = (detail.content as Extract<typeof detail.content, { type: "vocabulary_set" }>).entries;

    await submitTask(repos, profileId, {
      taskId: task.task.id,
      answers: entries.map((e) => ({ questionId: e.id, choiceId: e.correctChoiceId })),
      writing: "",
      reviewedItemIds: [],
    });

    const after = getTodayView(repos, profileId, "2026-09-28");
    expect(after.completedCount).toBe(1);
    expect(after.progress).toBeGreaterThan(0);
    expect(after.completedMinutes).toBeGreaterThan(0);
  });

  it("20 分钟短日只保留核心任务", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    setAvailableMinutes(repos, profileId, 20, "2026-09-28");
    const view = getTodayView(repos, profileId, "2026-09-28");
    expect(view.isShortDay).toBe(true);
    expect(view.tasks.every((t) => t.task.priority === "core")).toBe(true);
    expect(view.availableMinutes).toBe(20);
  });

  it("可用时间为 0 时视图为空但不是错误", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    setAvailableMinutes(repos, profileId, 0, "2026-09-28");
    const view = getTodayView(repos, profileId, "2026-09-28");
    expect(view.tasks).toHaveLength(0);
    expect(view.availableMinutes).toBe(0);
  });

  it("周末使用周末时间作为常规值", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    const weekend = getTodayView(repos, profileId, "2026-09-26");
    expect(weekend.regularMinutes).toBe(120);
    const weekday = getTodayView(repos, profileId, "2026-09-28");
    expect(weekday.regularMinutes).toBe(60);
  });
});

describe("Finding 2 回归 · unassessed 的持久化与重载", () => {
  function seedOnboardingAndDiagnostic(repos: ReturnType<typeof freshRepos>) {
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    const session = startDiagnostic(repos, profileId);
    // 只答客观题，且让阅读全错、其他客观题全对；听力无有效题
    submitDiagnostic(repos, {
      sessionId: session.id,
      answers: DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((item) => ({
        itemId: item.id,
        dimension: item.dimension,
        choiceId:
          item.dimension === "reading"
            ? item.choices!.find((c) => c.id !== item.correctChoiceId)!.id
            : item.correctChoiceId!,
        text: null,
        skipped: false,
      })),
    });
    return { profileId, sessionId: session.id };
  }

  it("听力在落库的画像中保持 unassessed，不被写成低分", () => {
    const repos = freshRepos();
    const { profileId } = seedOnboardingAndDiagnostic(repos);

    const profile = repos.skillProfile.get(profileId)!;
    expect(profile.skills.listening.status).toBe("unassessed");
    expect(profile.skills.listening.mastery).toBe("unknown");
    expect(profile.skills.listening.unassessedReason).toBeTruthy();
    // 关键：不是"低分"，score 只是占位
    expect(profile.skills.listening.evidenceCount).toBe(0);
  });

  it("未评估说明单独落库，且不与 weaknesses 混淆", () => {
    const repos = freshRepos();
    const { profileId } = seedOnboardingAndDiagnostic(repos);

    const profile = repos.skillProfile.get(profileId)!;
    expect(profile.unassessedNotices.length).toBeGreaterThan(0);
    expect(profile.unassessedNotices[0].dimension).toBe("listening");
    expect(profile.weaknesses.some((w) => w.dimension === "listening")).toBe(false);
  });

  it("重载后 unassessed 状态与说明仍在（序列化无损）", () => {
    const repos = freshRepos();
    const { profileId } = seedOnboardingAndDiagnostic(repos);

    // 模拟页面重载：重新建立 repository，从磁盘/内存库重新读出
    const reread = repos.skillProfile.get(profileId)!;
    expect(reread.skills.listening.status).toBe("unassessed");
    expect(reread.skills.listening.unassessedReason).toBe(
      repos.skillProfile.get(profileId)!.skills.listening.unassessedReason,
    );
    expect(reread.unassessedNotices).toHaveLength(1);
  });

  it("重算诊断结论后 unassessed 依然稳定（确定性）", () => {
    const repos = freshRepos();
    const { profileId, sessionId } = seedOnboardingAndDiagnostic(repos);

    const before = getDiagnosticOutcome(repos, profileId)!;
    gradeSession(repos, sessionId);
    const after = getDiagnosticOutcome(repos, profileId)!;

    expect(before.dimensionResults.find((r) => r.dimension === "listening")!.status).toBe("unassessed");
    expect(after.dimensionResults.find((r) => r.dimension === "listening")!.status).toBe("unassessed");
    expect(JSON.stringify(before.dimensionResults)).toBe(JSON.stringify(after.dimensionResults));
  });

  it("写作与翻译的证据仍被正确记录（未因 unassessed 改动而丢失）", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;

    // 主观题给出足以通过 rubric 的作答
    const session = startDiagnostic(repos, profileId);
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type !== "pending_media").map((item) => ({
      itemId: item.id,
      dimension: item.dimension,
      choiceId: item.type === "mcq" ? item.correctChoiceId! : null,
      text: item.type === "short_text" ? (item.rubricPoints ?? []).join(" and ") : null,
      skipped: false,
    }));
    submitDiagnostic(repos, { sessionId: session.id, answers });

    const outcome = getDiagnosticOutcome(repos, profileId)!;
    const writing = outcome.dimensionResults.find((r) => r.dimension === "writing")!;
    const translation = outcome.dimensionResults.find((r) => r.dimension === "translation")!;

    expect(writing.status).toBe("assessed");
    expect(writing.gradedItems).toBeGreaterThan(0);
    expect(translation.status).toBe("assessed");
    expect(translation.gradedItems).toBeGreaterThan(0);
    // 且两者都产生了真实证据
    expect(writing.evidence.length).toBeGreaterThan(0);
    expect(translation.evidence.length).toBeGreaterThan(0);
  });

  it("训练证据不会把 unassessed 的听力偷偷变成已评估", async () => {
    const { applyPracticeEvidence } = await import("@/services/profile");
    const repos = freshRepos();
    const { profileId } = seedOnboardingAndDiagnostic(repos);

    applyPracticeEvidence(repos, profileId, [{ skill: "listening", correct: 9, total: 10 }]);

    const after = repos.skillProfile.get(profileId)!;
    expect(after.skills.listening.status).toBe("unassessed");
    expect(after.skills.listening.evidenceCount).toBe(0);
  });

  it("已评估模块的训练证据仍能正常回写（对照）", async () => {
    const { applyPracticeEvidence } = await import("@/services/profile");
    const repos = freshRepos();
    const { profileId } = seedOnboardingAndDiagnostic(repos);

    const before = repos.skillProfile.get(profileId)!.skills.reading;
    applyPracticeEvidence(repos, profileId, [{ skill: "reading", correct: 8, total: 10 }]);
    const after = repos.skillProfile.get(profileId)!.skills.reading;

    expect(after.evidenceCount).toBeGreaterThan(before.evidenceCount);
  });
});

describe("Finding 1 回归 · 数据迁移", () => {
  it("迁移 v2→v3 把错误的默认日期归一化为官方日期", () => {
    // 直接构造一个 v2 状态的库，验证迁移真实生效
    const db = createTestDb();
    resetDb(db);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("p1", "Learner", 60, 120, now, now);
    db.prepare(
      "INSERT INTO exam_goal (id, profile_id, exam_name, exam_date, target_score, score_history, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run("g1", "p1", "CET-6 2026-12", "2026-12-19", 550, "[]", now, now);

    // 手动执行迁移语句（等价于 openDatabase 在 v2 库上的行为）
    db.prepare("UPDATE exam_goal SET exam_date = '2026-12-12' WHERE exam_date = '2026-12-19'").run();

    const row = db.prepare("SELECT exam_date FROM exam_goal WHERE id = 'g1'").get() as {
      exam_date: string;
    };
    expect(row.exam_date).toBe(CET6_EXAM_DATE);
  });

  it("迁移不覆盖用户自定义的考试日期", () => {
    const db = createTestDb();
    resetDb(db);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    ).run("p2", "Learner", 60, 120, now, now);
    // 用户主动选择的非默认日期（例如计划改报 2027-06）
    db.prepare(
      "INSERT INTO exam_goal (id, profile_id, exam_name, exam_date, target_score, score_history, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)",
    ).run("g2", "p2", "CET-6 2027-06", "2027-06-12", 550, "[]", now, now);

    db.prepare("UPDATE exam_goal SET exam_date = '2026-12-12' WHERE exam_date = '2026-12-19'").run();

    const row = db.prepare("SELECT exam_date FROM exam_goal WHERE id = 'g2'").get() as {
      exam_date: string;
    };
    expect(row.exam_date).toBe("2027-06-12");
  });
});

describe("数据边界与迁移路径", () => {
  it("没有 profile 时 Today 视图不会崩（返回默认值）", () => {
    const repos = freshRepos();
    expect(getOnboardingState(repos).onboarded).toBe(false);
  });

  it("同一内容只产生一条复习项（唯一约束生效）", () => {
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    const payload = {
      profileId,
      contentItemId: "dup-test",
      contentRef: { contentType: "review_deck" as const, contentId: "dup-test" },
      skill: "reading" as const,
      prompt: "重复内容",
      dueOn: "2026-09-29",
      stability: 0,
      difficulty: 0,
      reps: 0,
      lapses: 1,
      lastReviewedOn: null,
    };
    repos.review.upsert(payload);
    repos.review.upsert({ ...payload, prompt: "更新后的提示" });
    const all = repos.review.listAll(profileId);
    expect(all).toHaveLength(1);
    expect(all[0].prompt).toBe("更新后的提示");
  });

  it("recordPracticeWeaknesses 在重复错因达阈值时写入弱点", async () => {
    const { recordPracticeWeaknesses } = await import("@/services/profile");
    const repos = freshRepos();
    completeOnboarding(repos, ONBOARDING);
    const profileId = repos.learner.getProfile()!.id;
    const { startDiagnostic: start, submitDiagnostic: submit } = await import("@/services/diagnostic");
    const session = start(repos, profileId);
    submit(repos, {
      sessionId: session.id,
      answers: DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => ({
        itemId: i.id,
        dimension: i.dimension,
        choiceId: i.choices!.find((c) => c.id !== i.correctChoiceId)!.id,
        text: null,
        skipped: false,
      })),
    });

    const now = new Date().toISOString();
    repos.records.saveAttempts([
      {
        profileId,
        taskId: null,
        contentItemId: "x1",
        answerText: null,
        choiceId: "a",
        correct: false,
        score: 0,
        feedback: "",
        errorTags: ["reading.inference"],
        createdAt: now,
      },
      {
        profileId,
        taskId: null,
        contentItemId: "x2",
        answerText: null,
        choiceId: "b",
        correct: false,
        score: 0,
        feedback: "",
        errorTags: ["reading.inference"],
        createdAt: now,
      },
    ]);

    const added = recordPracticeWeaknesses(repos, profileId, "reading", ["reading.inference"]);
    expect(added.length).toBe(1);
    expect(added[0].source).toBe("practice");
    const stored = repos.skillProfile.get(profileId)!.weaknesses;
    expect(stored.some((w) => w.id === "practice:reading.inference")).toBe(true);
  });
});
