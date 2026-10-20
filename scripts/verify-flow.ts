#!/usr/bin/env node
/**
 * 关键用户路径验证。
 *
 * 为什么不是浏览器 E2E：
 * 当前环境没有安装 Playwright / 浏览器二进制，下载体积大且可能受网络策略影响，
 * 不应成为产品地基的前置条件（见 README 的「质量门禁」一节）。
 *
 * 替代方案覆盖度：本脚本直接驱动与 Server Action **完全相同**的 service 层，
 * 并使用真实 SQLite 文件（不是内存库），因此验证的是真实的持久化行为。
 * 每个断言都在同一进程内重新读取数据，等价于"刷新页面后数据仍在"。
 *
 * 覆盖路径：onboarding → diagnostic → result → today → complete task → today 状态更新 → reload。
 */

import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * 数据库路径必须在任何 src 模块被求值之前设定：
 * `src/db/client.ts` 在模块加载时读取该环境变量，而 ESM 的静态 import 会被提升到
 * 所有语句之前。因此这里不用静态 import，改为在 main() 内动态导入。
 */
const DB_PATH = join(process.cwd(), "data", "verify.db");
process.env.CET6_DB_PATH = DB_PATH;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    failures.push(label);
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

function resetDatabase(): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${DB_PATH}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
}

async function main(): Promise<void> {
  // 动态导入：确保上面设置的 CET6_DB_PATH 先生效
  const { getRepositories } = await import("@/repositories/sqlite");
  const { completeOnboarding, getOnboardingState, DEFAULT_ONBOARDING } = await import("@/services/onboarding");
  const { getDiagnosticItems, getDiagnosticOutcome, startDiagnostic, submitDiagnostic } = await import(
    "@/services/diagnostic"
  );
  const { ensurePlan, getTodayView, setAvailableMinutes } = await import("@/services/plan");
  const { getTaskDetail, submitTask } = await import("@/services/practice");
  const { SCHEMA_VERSION } = await import("@/db/schema");
  const { CET6_EXAM_DATE } = await import("@/domain/exam-facts");

  console.log("CET-6 Coach · 关键路径验证");
  console.log(`数据库文件：${DB_PATH}`);
  console.log(`schema 版本：${SCHEMA_VERSION}`);

  resetDatabase();

  const repos = getRepositories();

  // ---------------------------------------------------------------- onboarding
  section("1. 首次进入 → onboarding");
  check("初始状态下未完成 onboarding（应重定向到 /onboarding）", !getOnboardingState(repos).onboarded);

  const onboarded = completeOnboarding(repos, {
    displayName: "Learner",
    examName: DEFAULT_ONBOARDING.examName,
    examDate: DEFAULT_ONBOARDING.examDate,
    targetScore: DEFAULT_ONBOARDING.targetScore,
    weekdayMinutes: DEFAULT_ONBOARDING.weekdayMinutes,
    weekendMinutes: DEFAULT_ONBOARDING.weekendMinutes,
  });
  check("onboarding 保存成功", onboarded.ok, onboarded.ok ? "" : onboarded.error);

  const afterOnboarding = getOnboardingState(repos);
  check("profile 已落库", afterOnboarding.profile !== null);
  /*
   * The expected value comes from the product's own default, not a literal.
   *
   * This assertion used to hard-code `=== 550`, which was true when a particular
   * onboarding run happened to use 550 and became a *false failure* the moment the
   * neutral default was set to 500. The bug was in the check, not the product:
   * this script submits `DEFAULT_ONBOARDING.targetScore` two calls above and then
   * asserted a different number. Reading the constant back makes the assertion
   * test the round-trip it actually cares about — what was submitted is what was
   * persisted — and it cannot drift from the product default again.
   */
  check(
    `目标分数 = ${DEFAULT_ONBOARDING.targetScore}（产品默认值，原样落库）`,
    afterOnboarding.goal?.targetScore === DEFAULT_ONBOARDING.targetScore,
  );
  check(`考试日期 = ${CET6_EXAM_DATE}（官方日期）`, afterOnboarding.goal?.examDate === CET6_EXAM_DATE);
  check("工作日时间 = 60", afterOnboarding.profile?.preferences.weekdayMinutes === 60);
  check("周末时间 = 120", afterOnboarding.profile?.preferences.weekendMinutes === 120);
  check("尚无能力画像（应重定向到 /diagnostic）", afterOnboarding.skillProfile === null);

  if (!onboarded.ok) {
    report();
    return;
  }
  const profileId = onboarded.profile.id;

  // ---------------------------------------------------------------- diagnostic
  section("2. diagnostic 完整作答");
  const items = getDiagnosticItems();
  check(`诊断题量 = 17`, items.length === 17);
  check("覆盖五个维度", new Set(items.map((i) => i.dimension)).size === 5);

  const session = startDiagnostic(repos, profileId);
  check("诊断会话已创建", Boolean(session.id));

  // 刻意构造一个有区分度的作答模式：阅读/词汇较差，听力/写作较好。
  // 这样后续可以验证"结果确实来自作答"。
  const answers = items
    .filter((i) => i.type !== "pending_media")
    .map((item) => {
      const weakDimension = item.dimension === "reading" || item.dimension === "vocabulary";
      const correct = !weakDimension;
      return {
        itemId: item.id,
        dimension: item.dimension,
        choiceId:
          item.type === "mcq"
            ? correct
              ? item.correctChoiceId!
              : item.choices!.find((c) => c.id !== item.correctChoiceId)!.id
            : null,
        text:
          item.type === "short_text"
            ? correct
              ? (item.rubricPoints ?? []).join(" and ")
              : "nothing relevant written here"
            : null,
        skipped: false,
      };
    });

  const submitted = submitDiagnostic(repos, { sessionId: session.id, answers });
  check("诊断提交成功", submitted.ok, submitted.ok ? "" : submitted.error);

  // ---------------------------------------------------------------- result
  section("3. diagnostic result 来自真实作答");
  const outcome = getDiagnosticOutcome(repos, profileId);
  check("生成了诊断结论", outcome !== null);

  if (outcome) {
    check("五个维度都有结果", outcome.dimensionResults.length === 5);

    const reading = outcome.dimensionResults.find((r) => r.dimension === "reading")!;
    const writing = outcome.dimensionResults.find((r) => r.dimension === "writing")!;
    check(
      `阅读分数（${reading.adjustedScore}）低于写作分数（${writing.adjustedScore}）——结果反映实际作答`,
      reading.adjustedScore < writing.adjustedScore,
    );

    check("识别出薄弱项（阅读/词汇）", outcome.weaknesses.length > 0);
    check(
      "薄弱项包含词汇或阅读",
      outcome.weaknesses.some((w) => w.dimension === "vocabulary" || w.dimension === "reading"),
    );
    check("给出四个模块的训练优先级", outcome.recommendations.length === 4);

    const weightSum = outcome.recommendations.reduce((s, r) => s + r.weight, 0);
    check(`训练权重归一化（合计 ${weightSum.toFixed(3)}）`, Math.abs(weightSum - 1) < 0.001);

    check("弱项模块优先级为 core", outcome.recommendations.some((r) => r.priority === "core"));
    check(
      "每个维度都带 confidence 证据",
      outcome.dimensionResults.every((r) => ["low", "medium", "high"].includes(r.confidence)),
    );
    check(
      "结论中不含分数预测表述",
      outcome.recommendations.every((r) => !/预测|预计能考/.test(r.reason)),
    );
  }

  const profile = repos.skillProfile.get(profileId);
  check("能力画像已落库", profile !== null);
  check("画像关联到本次诊断", Boolean(profile?.basedOnDiagnosticId));
  check("画像包含四个计分模块", Object.keys(profile?.skills ?? {}).length === 4);

  // ---------------------------------------------------------------- today
  section("4. today dashboard 基于 planner 生成任务");
  const today = "2026-09-28"; // 周一
  const view = getTodayView(repos, profileId, today);

  check(`距考试天数 = ${view.daysRemaining}`, view.daysRemaining > 0);
  check("今天有任务", view.tasks.length > 0, `实际 ${view.tasks.length} 项`);
  check("初始完成数为 0", view.completedCount === 0);
  check("初始进度为 0", view.progress === 0);
  check("计划时长不超过可用时间", view.plannedMinutes <= view.availableMinutes);
  check("工作日使用 60 分钟常规值", view.regularMinutes === 60);

  const plan = ensurePlan(repos, profileId, today);
  check("计划已落库", plan.tasks.length > 0);

  check(
    "不含听力任务（Phase 1 无音频素材，避免排一个点不开的入口）",
    !plan.tasks.some((t) => t.kind === "listening_comprehension"),
  );
  check(
    "每个任务的时长都等于其内容的时长（不谎报）",
    plan.tasks.every((t) => {
      if (t.kind === "review" || !t.contentRef) return true;
      // 真实真题阅读的时长来自"按分值权重分摊的排练预算"，不是内容库条目
      if (t.contentRef.contentType === "reading_target") return t.estimatedMinutes > 0;
      const detail = getTaskDetail(repos, t.id);
      return detail?.content?.estimatedMinutes === t.estimatedMinutes;
    }),
  );
  check("存在可执行的待完成任务", view.nextTask !== null);
  check(
    "所有任务都绑定了内容或复习队列",
    plan.tasks.every((t) => t.contentRef !== null),
  );

  /*
   * 阅读收敛（本次改动的核心规则）。
   *
   * 此刻试题库是**空的**（真题导入在下面的第 10 节才发生），因此：
   * - 计划里不应有阅读任务 —— 否则就是一个点不开、或点进去没有真实材料的入口；
   * - 更不能有任何引用 `practice-library.ts` 合成篇章的任务。
   * 这才是"没有合适的真实材料时给出不可用状态，而不是回退合成题目"。
   */
  check(
    "空真题库时不排阅读任务（不排一个点不开的入口）",
    !plan.tasks.some((t) => t.kind === "reading_comprehension"),
  );
  check(
    "计划里不存在任何引用合成阅读篇章的任务",
    !plan.tasks.some((t) => t.contentRef?.contentType === "reading_passage"),
  );

  // ---------------------------------------------------------------- task completion
  section("5. 完成一个训练任务（旧闭环载体：词汇）");
  /*
   * 载体说明：本节验证的是旧闭环的任务执行链路（session → attempts →
   * 任务状态 → 画像 → 弱点 → 复习队列）。阅读训练已收敛到真实真题的
   * Expert Training 工作面（那条链路由第 11 节验证），因此这里用词汇任务
   * 作为载体 —— 它同样走旧闭环、同样是"多道客观题 + 答错进复习队列"。
   *
   * 词汇是**加分项**：planner 只在"核心任务排完且时间有富余"时排它
   * （判据见 `planDay` 的可选段）。工作日 60 分钟恰好排不到，因此这里
   * 把当天可用时间调到 90 分钟 —— 这也是所有者真实的周末预算量级，
   * 不是为了让测试通过而编造的状态。
   */
  setAvailableMinutes(repos, profileId, 90, today);
  const viewForTask = getTodayView(repos, profileId, today);
  const target = viewForTask.tasks.find((t) => t.task.kind === "vocabulary_recall" && t.contentReady);
  check("找到一个可执行的词汇任务", target !== undefined);

  if (!target) {
    report();
    return;
  }

  const detail = getTaskDetail(repos, target.task.id);
  const content = detail?.content;
  check("任务内容已解析", content !== null);
  check("内容是词汇组", content?.type === "vocabulary_set");

  // 真正下发给浏览器的是 getContentView 的产物，因此必须检查它而不是原始内容对象
  const { getContentView } = await import("@/app/practice/[taskId]/content-view");
  const clientView = getContentView(detail!);
  check("客户端视图不含正确答案字段", !JSON.stringify(clientView).includes("correctChoiceId"));
  check("客户端视图不含解析文本（避免提前泄露答案）", !JSON.stringify(clientView).includes("explanation"));

  const entries = content?.type === "vocabulary_set" ? content.entries : [];
  check(`词汇题量 = ${entries.length}`, entries.length >= 4);

  // 刻意答错第一题、答对其他题，验证"部分正确"的反馈与错因记录
  const submission = await submitTask(repos, profileId, {
    taskId: target.task.id,
    answers: entries.map((e, index) => ({
      questionId: e.id,
      choiceId:
        index === 0
          ? e.choices.find((c) => c.id !== e.correctChoiceId)!.id
          : e.correctChoiceId,
    })),
    writing: "",
    reviewedItemIds: [],
    elapsedMinutes: 10,
  });

  check("提交成功", submission.ok, submission.ok ? "" : submission.error);

  if (submission.ok) {
    const fb = submission.feedback;
    check(`正确 ${fb.correctCount}/${fb.totalCount}`, fb.correctCount === fb.totalCount - 1);
    check("分数符合部分正确（0<score<1）", fb.score > 0 && fb.score < 1);
    check("反馈来源标注为本地规则评分", fb.gradedBy === "local-rubric");
    check("答错内容进入复习队列", fb.reviewItemsCreated === 1);
    check("有可读的反馈摘要", fb.summary.length > 0);
  }

  // ---------------------------------------------------------------- state change
  section("6. today 状态真实更新");
  const after = getTodayView(repos, profileId, today);
  check("完成数 +1", after.completedCount === 1);
  check("进度大于 0", after.progress > 0);
  check("已完成时长大于 0", after.completedMinutes > 0);
  check(
    "该任务状态变为 completed",
    repos.plan.getPlan(profileId, today)!.tasks.find((t) => t.id === target.task.id)?.status === "completed",
  );
  check("学习记录已写入", repos.records.listRecentSessions(profileId, 5).length === 1);
  check("逐题记录已写入", repos.records.listRecentAttempts(profileId, 20).length === entries.length);
  /*
   * 复习项的到期日是"入库时的今天 + 1"，因此断言必须相对真实今天，
   * 不能写死日期 —— 写死会在机器时钟走到那天之后凭空失败（时间炸弹）。
   */
  const { todayISO: realTodayOf, addDays: addDaysOf } = await import("@/lib/date");
  check(
    "复习队列出现 1 项，且到期日为明天",
    repos.review.getDueItems(profileId, addDaysOf(realTodayOf(), 1)).length === 1,
  );

  // ---------------------------------------------------------------- persistence
  section("7. reload / 重新建立连接后数据仍在");
  const reread = getOnboardingState(repos);
  /*
   * Same defect as the assertion fixed above, in its mirrored form: this one
   * hard-coded `=== 500` while the other hard-coded `=== 550`. Reading the
   * product default keeps both in step with the product and with each other.
   */
  check(
    "onboarding 数据仍在",
    reread.profile?.displayName === "Learner" &&
      reread.goal?.targetScore === DEFAULT_ONBOARDING.targetScore,
  );
  check("能力画像仍在", reread.skillProfile?.basedOnDiagnosticId === session.id);

  const planAgain = repos.plan.getPlan(profileId, today);
  check("今日计划仍在", planAgain !== null);
  check("已完成任务状态保持", planAgain?.tasks.some((t) => t.status === "completed") === true);

  const viewAgain = getTodayView(repos, profileId, today);
  check("Today 完成数未回退", viewAgain.completedCount === 1);
  check(
    "重排计划不会抹掉已完成记录",
    (() => {
      setAvailableMinutes(repos, profileId, 40, today);
      const afterRerank = getTodayView(repos, profileId, today);
      return afterRerank.completedCount === 1;
    })(),
  );
  check(
    "重排后总时长仍不超过新的可用时间",
    (() => {
      const p = repos.plan.getPlan(profileId, today)!;
      const total = p.tasks.filter((t) => t.status !== "completed").reduce((s, t) => s + t.estimatedMinutes, 0);
      return total <= p.availableMinutes;
    })(),
  );

  // ---------------------------------------------------------------- short day
  section("8. 短日模式（20 分钟）");
  const shortView = getTodayView(repos, profileId, "2026-09-29");
  setAvailableMinutes(repos, profileId, 20, "2026-09-29");
  const shortAfter = getTodayView(repos, profileId, "2026-09-29");
  check("识别为短日", shortAfter.isShortDay);
  check("短日总时长不超过 20 分钟", shortAfter.plannedMinutes <= 20);
  check("短日只保留核心任务", shortAfter.tasks.every((t) => t.task.priority === "core"));
  check("短日给出明确提示", shortAfter.warnings.some((w) => w.includes("分钟")), JSON.stringify(shortAfter.warnings));
  void shortView;

  // ---------------------------------------------------------------- empty day
  section("9. 完全没时间（0 分钟）");
  setAvailableMinutes(repos, profileId, 0, "2026-09-30");
  const emptyDay = getTodayView(repos, profileId, "2026-09-30");
  check("不产生任务", emptyDay.tasks.length === 0);
  check("不抛异常且视图可用", emptyDay.availableMinutes === 0);

  check("既有记录未受影响", repos.records.listRecentSessions(profileId, 5).length === 1);

  // ---------------------------------------------------------------- 真题库（Phase 2）
  section("10. 真题库：导入索引 → 浏览 → 版本 → 策略");

  const { getPaperLibrary, getPaperDetail } = await import("@/services/papers");
  const { planImport, runImport } = await import("@/services/paper-import");
  const { buildFixturePackage, writeFixturePackage } = await import("./paper-fixture");
  const { mkdirSync } = await import("node:fs");

  // 用独立的测试内容根，绝不触碰用户真实的 private-content
  const contentRoot = join(process.cwd(), "data", "verify-content");
  process.env.CET6_CONTENT_ROOT = contentRoot;
  rmSync(contentRoot, { recursive: true, force: true });
  mkdirSync(contentRoot, { recursive: true });

  check("空内容库时发现 0 份（诚实为空，不伪造内容）", planImport(repos).report.discovered === 0);
  check("空库时列表为空", getPaperLibrary(repos).counts.total === 0);

  writeFixturePackage(
    contentRoot,
    "2024-12-set1",
    buildFixturePackage({ id: "verify-paper-2024-12-set1", year: 2024, session: "December", variant: "set1" }),
  );
  writeFixturePackage(
    contentRoot,
    "2023-06-set1",
    buildFixturePackage({ id: "verify-paper-2023-06-set1", year: 2023, session: "June", variant: "set1" }),
  );

  const dryRun = runImport(repos, { dryRun: true });
  check("dry-run 报告新增且零写入", dryRun.report.counts.insert === 2 && dryRun.written === 0);
  check("dry-run 后数据库仍为空（预演不落库）", repos.papers.countPapers() === 0);

  const imported = runImport(repos, { dryRun: false });
  check("导入写入两份试卷", imported.ok && imported.written === 2);
  check("索引题量正确（57 题）", repos.papers.getPaper("verify-paper-2024-12-set1")?.questionCount === 57);
  check("索引大题数正确（8 个）", repos.papers.getPaper("verify-paper-2024-12-set1")?.sectionCount === 8);

  const repeat = runImport(repos);
  check("重复导入判定为已最新（不重复写入）", repeat.written === 0 && repeat.report.counts.unchanged === 2);

  const library = getPaperLibrary(repos);
  check("列表按年份倒序", library.years[0]?.year === 2024);
  check("库计数正确", library.counts.total === 2 && library.counts.training === 2);
  check(
    "夹具来源如实标注为 test_fixture（不冒充真题）",
    library.summaries.every((s) => s.record.sourceKind === "test_fixture"),
  );
  check("库中真题数量为 0（不谎报）", library.counts.realPapers === 0);

  const paperDetail = getPaperDetail(repos, "verify-paper-2024-12-set1");
  check("详情页能读到完整结构", paperDetail?.content?.sections.length === 8);
  check("详情页包状态正常", paperDetail?.packageStatus === "ok");
  check(
    "听力组持有音频引用",
    paperDetail?.content?.sections.some((s) => s.groups.some((g) => g.audioAssetId)) === true,
  );
  check("资产元数据已落库", (paperDetail?.assets.length ?? 0) === 7);

  // 训练池 / 模考保留
  repos.papers.setPool("verify-paper-2024-12-set1", "mock_reserve");
  check("设为模考保留后进度状态随之变化", getPaperDetail(repos, "verify-paper-2024-12-set1")?.progress === "reserved_mock");
  check("列表计数反映策略", getPaperLibrary(repos).counts.mockReserve === 1);

  // 内容包缺失时不假装可用
  rmSync(join(contentRoot, "cet6", "papers", "2023-06-set1"), { recursive: true, force: true });
  const missing = getPaperDetail(repos, "verify-paper-2023-06-set1");
  check("包被删除后状态为 missing", missing?.packageStatus === "missing");
  check("包缺失时不返回任何题目", missing?.content === null);

  // 内容包身份来自 manifest 内容而非磁盘存在性：被删的包原样放回后，
  // 索引无需变更。这不是"忽略缺失"，而是正确语义 ——
  // 缺失由 catalog 的 packageStatus 表达（上一节已验证），导入判定只看内容是否变过。
  writeFixturePackage(
    contentRoot,
    "2023-06-set1",
    buildFixturePackage({ id: "verify-paper-2023-06-set1", year: 2023, session: "June", variant: "set1" }),
  );
  const restored = runImport(repos);
  check(
    "包原样放回后判定为已最新（导入判定只看内容是否变化）",
    restored.report.counts.unchanged === 2 && restored.written === 0,
    JSON.stringify(restored.report.counts),
  );
  check("恢复后包状态回到 ok", getPaperDetail(repos, "verify-paper-2023-06-set1")?.packageStatus === "ok");

  // 索引存在而包永久缺失时，导入不会静默删除索引 ——
  // 删除索引是用户的决定，不是一次导入的副作用。
  rmSync(join(contentRoot, "cet6", "papers", "2023-06-set1"), { recursive: true, force: true });
  const afterRemoval = runImport(repos);
  check("包缺失时导入不删除既有索引", repos.papers.getPaper("verify-paper-2023-06-set1") !== null);
  check("缺失的包不出现在导入报告中", afterRemoval.report.discovered === 1);
  writeFixturePackage(
    contentRoot,
    "2023-06-set1",
    buildFixturePackage({ id: "verify-paper-2023-06-set1", year: 2023, session: "June", variant: "set1" }),
  );

  // 内容实质变化但未升版本 → 必须拒绝（保护历史作答不被静默重定向）
  //
  // 注意这里改的是**印出内容**（写作题面），不是资产标签。
  // 资产标签（audioLabel）不属于内容指纹的投影 —— 改它只算元数据更新，
  // 会正确地走 metadata_only 而不是拒绝。要验证"拒绝"这条路径，
  // 必须改真正进入内容指纹的字段。
  const mutatedContent = buildFixturePackage({
    id: "verify-paper-2023-06-set1",
    year: 2023,
    session: "June",
    variant: "set1",
    contentVersion: 1,
  });
  {
    const sections = mutatedContent.manifest.sections as Record<string, unknown>[];
    const groups = sections[0].groups as Record<string, unknown>[];
    (groups[0].questions as Record<string, unknown>[])[0].prompt = "内容已实质改动的写作题面";
  }
  writeFixturePackage(contentRoot, "2023-06-set1", mutatedContent);
  const versionConflict = runImport(repos);
  check(
    "内容变化但版本未升 → 拒绝导入",
    versionConflict.report.counts.rejected === 1 && versionConflict.written === 0,
    JSON.stringify(versionConflict.report.counts),
  );
  check(
    "版本冲突的拒绝理由明确指向 contentVersion",
    versionConflict.report.entries.some((entry) => entry.issues.some((i) => i.message.includes("contentVersion"))),
  );

  // 升版本后同一改动可以正常导入
  writeFixturePackage(
    contentRoot,
    "2023-06-set1",
    buildFixturePackage({
      id: "verify-paper-2023-06-set1",
      year: 2023,
      session: "June",
      variant: "set1",
      contentVersion: 2,
      audioLabel: "改动过的音频标签",
    }),
  );
  const upgraded = runImport(repos);
  check("升版本后升级成功", upgraded.report.counts.update === 1 && upgraded.written === 1);
  check("索引版本号已更新", repos.papers.getPaper("verify-paper-2023-06-set1")?.contentVersion === 2);

  // 内容版本升级不得重置用户的策略选择
  check(
    "版本升级未重置模考保留策略",
    repos.papers.getPaper("verify-paper-2024-12-set1")?.pool === "mock_reserve",
  );

  // ---------------------------------------------------------------- 阅读收敛（Phase 3）
  section("11. 阅读训练收敛到真实真题（Expert Training）");

  const { listReadingTargetCandidates, resolveReadingTask, explainNoReadingTarget } = await import(
    "@/services/reading-plan"
  );
  const { decodeReadingTarget } = await import("@/domain/reading-target");
  const { submitReadingRun, getSectionTrainingState } = await import("@/services/expert-training");

  /*
   * 状态：2024-12 那套被设为 mock_reserve（上一节），2023-06 在训练池。
   * 这正是验证"保留材料不被消耗"的真实场景。
   */
  const candidates = listReadingTargetCandidates(repos, profileId);
  check(
    "候选只来自训练池（模考保留的卷子不在其中）",
    candidates.length > 0 && candidates.every((c) => c.paperId === "verify-paper-2023-06-set1"),
  );
  check(
    "候选全部是真实真题阅读大题",
    candidates.every((c) => c.sectionId.startsWith("reading.")),
  );

  // 计划里的阅读任务此时必须引用真实真题阅读目标
  const planAfterImport = ensurePlan(repos, profileId, "2026-10-05", {
    availableMinutes: 180,
    force: true,
  });
  const readingTasks = planAfterImport.tasks.filter((t) => t.kind === "reading_comprehension");
  check("导入真题后计划排出了阅读任务", readingTasks.length > 0, `实际 ${readingTasks.length} 项`);
  check(
    "阅读任务引用的是真实真题阅读大题，而不是合成篇章",
    readingTasks.length > 0 && readingTasks.every((t) => t.contentRef?.contentType === "reading_target"),
  );

  const viewAfterImport = getTodayView(repos, profileId, "2026-10-05");
  const readingView = viewAfterImport.tasks.find((t) => t.task.kind === "reading_comprehension");
  check("阅读任务在 Today 上标记为真实真题", readingView?.isRealPaperReading === true);
  check(
    "阅读任务的跳转指向 canonical Expert Training 路由",
    readingView?.href.startsWith("/practice/papers/") === true &&
      readingView!.href.includes("/train/"),
    readingView?.href ?? "",
  );
  check(
    "跳转不再指向旧执行器",
    readingView !== undefined && readingView.href !== `/practice/${readingView.task.id}`,
  );

  // 模考保留卷的真实目标引用必须被解析为不可用，并说明原因
  const reservedResolution = resolveReadingTask(
    repos,
    profileId,
    `verify-paper-2024-12-set1::reading.careful_reading`,
  );
  check(
    "模考保留卷的阅读目标不可作为普通训练",
    reservedResolution.kind === "unavailable",
  );
  check(
    "不可用原因明确指出是模考保留",
    reservedResolution.kind === "unavailable" && reservedResolution.reason.includes("模考保留"),
  );

  // 走一次真实的 Expert 提交，验证不可变台账
  if (readingTasks.length > 0) {
    const target = decodeReadingTarget(readingTasks[0].contentRef!.contentId)!;
    const state = getSectionTrainingState(repos, profileId, target.paperId, target.sectionId);
    check("该大题的训练状态可读（不是死链接）", state.ok || state.code === "not_found");

    const { getPaperDetail: getDetail } = await import("@/services/papers");
    const paperDetail = getDetail(repos, target.paperId);
    const section = paperDetail?.content?.sections.find((s) => s.id === target.sectionId);
    check("能从内容包读到该大题的题面", section !== undefined);

    if (section) {
      const started = repos.expert.startRun({
        id: "verify-run-1",
        profileId,
        paperId: target.paperId,
        contentVersion: paperDetail!.record.contentVersion,
        sectionId: target.sectionId,
        sectionType: section.type,
        groupIds: section.groups.map((g) => g.id),
        itemCount: section.groups.reduce((sum, g) => sum + g.questions.length, 0),
        startedAt: "2026-10-05T00:00:00.000Z",
      });
      check("Expert 会话已创建", started.status === "in_progress");

      // 为每道题给出一个非空作答（只取选项/词库/段落的首项，不读答案字段）
      const responses = section.groups.flatMap((group) =>
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

      const submittedReading = submitReadingRun(repos, profileId, {
        runId: started.id,
        responses,
        elapsedSeconds: 480,
        changedQuestionIds: [],
      });
      check("Expert 提交成功", submittedReading.ok, submittedReading.ok ? "" : submittedReading.error);

      if (submittedReading.ok) {
        const events = repos.expert.listEventsForRun(started.id);
        const assessments = repos.expert.listAssessmentsForRun(started.id);
        check("观测与评分成对写入", events.length === assessments.length && events.length > 0);
        check(
          "观测里不含任何因果字段",
          events.every((e) => !("mechanism" in e) && !("weakness" in e) && !("diagnosis" in e)),
        );
        check(
          "未作答与答错是两种不同结论",
          events.every((e) => ["correct", "incorrect", "skipped"].includes(e.outcome)),
        );
      }

      // 阅读链路**不得**写入旧闭环
      const attemptsBefore = repos.records.listRecentAttempts(profileId, 50).length;
      check(
        "Expert 阅读训练不写旧 answer_attempt",
        attemptsBefore === entries.length,
        `期望 ${entries.length}（来自第 5 节的词汇任务），实际 ${attemptsBefore}`,
      );
    }
  }

  // 不可用说明必须指向"导入真题"或"调整保留策略"，而不是笼统的"暂无内容"
  const emptyExplanation = explainNoReadingTarget(repos, profileId);
  check("不可用说明是可读的非空文案", emptyExplanation.length > 0);

  report();
}

function report(): void {
  console.log("\n" + "─".repeat(56));
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.log("\n失败项：");
    for (const f of failures) console.log(`  · ${f}`);
    process.exitCode = 1;
  } else {
    console.log("关键用户路径验证全部通过。");
  }
}

main().catch((error) => {
  console.error("\n验证脚本异常终止：");
  console.error(error);
  process.exitCode = 1;
});
