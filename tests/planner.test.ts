import { describe, expect, it } from "vitest";
import {
  planDay,
  allocateMinutes,
  daysUntil,
  isWeekend,
  type ContentCatalog,
  type PlannerInput,
} from "@/domain/planner";
import { addDays, diffDays, isWeekendISO, todayISO } from "@/lib/date";
import { CET6_EXAM_DATE } from "@/domain/exam-facts";
import { SKILL_WEIGHTS } from "@/domain/types";
import type { Recommendation, ReviewItem, SkillProfile, StudyTask } from "@/domain/models";
import type { Skill } from "@/domain/types";

/**
 * Planner 单元测试。
 *
 * Planner 是纯函数：不需要数据库、不需要时间 mock、不依赖内容库
 * （内容以 ContentCatalog 桩注入）。
 * 覆盖任务书要求的六个场景，外加边界与安全性场景。
 */

const EXAM_DATE = CET6_EXAM_DATE;

/** 与运行时一致：Phase 1 没有听力素材，因此听力不可执行。 */
const EXECUTABLE: Skill[] = ["reading", "writing", "translation"];

/**
 * 内容目录桩。分钟数与真实内容库同量级
 * （阅读大题 7–26 分钟、写作 25 分钟、翻译 6 分钟、词汇 8 分钟），
 * 因此测试验证的是真实的时长关系，而不是虚构数字。
 *
 * ── 阅读这一格为什么是 `reading_target` ──
 *
 * 面向学习者的 CET-6 阅读训练只使用真实历年真题，因此 planner 的阅读素材
 * 是**真实试卷里的某个阅读大题**（`reading_target`），而不是内容库里的
 * 合成篇章。这个桩如实反映该形态：id 是 `paperId::sectionId` 编码，
 * 时长来自按分值权重分摊的排练预算（见 `domain/reading-target`）。
 */
const READING_CLOZE = "cet6-2024-12-set1::reading.banked_cloze";
const READING_MATCHING = "cet6-2024-12-set1::reading.matching";

const CATALOG: ContentCatalog = {
  reading: [
    { id: READING_CLOZE, type: "reading_target", minutes: 7, label: "2024 年 12 月 · 阅读 · 选词填空" },
    { id: READING_MATCHING, type: "reading_target", minutes: 13, label: "2024 年 12 月 · 阅读 · 长篇阅读（匹配）" },
    { id: "vocab-1", type: "vocabulary_set", minutes: 8 },
  ],
  writing: [{ id: "write-1", type: "writing_prompt", minutes: 25 }],
  translation: [
    { id: "trans-1", type: "translation_prompt", minutes: 6 },
    { id: "trans-2", type: "translation_prompt", minutes: 6 },
  ],
  listening: [],
};

function makeProfile(overrides?: Partial<Record<Skill, number>>): SkillProfile {
  const scores: Record<Skill, number> = {
    listening: 60,
    reading: 60,
    writing: 60,
    translation: 60,
    ...overrides,
  };
  const skills = Object.fromEntries(
    (Object.keys(scores) as Skill[]).map((skill) => [
      skill,
      {
        skill,
        score: scores[skill],
        mastery: "developing" as const,
        confidence: "medium" as const,
        evidenceCount: 5,
        lastUpdatedAt: "2026-09-01T00:00:00.000Z",
      },
    ]),
  ) as SkillProfile["skills"];

  const recommendations: Recommendation[] = (Object.keys(scores) as Skill[]).map((skill) => ({
    skill,
    dimension: skill,
    reason: "test",
    weight: 0.25,
    priority: scores[skill] < 55 ? "core" : "recommended",
  }));

  return {
    id: "sp-1",
    profileId: "p-1",
    updatedAt: "2026-09-01T00:00:00.000Z",
    skills,
    dimensions: [],
    weaknesses: [],
    recommendations,
    unassessedNotices: [],
    basedOnDiagnosticId: "d-1",
  };
}

function baseInput(overrides: Partial<PlannerInput> = {}): PlannerInput {
  return {
    today: "2026-09-26",
    examDate: EXAM_DATE,
    targetScore: 550,
    availableMinutes: 60,
    profile: makeProfile(),
    dueReviewItems: [],
    outstandingTasks: [],
    recentCompletedSkills: [],
    executableSkills: EXECUTABLE,
    contentCatalog: CATALOG,
    ...overrides,
  };
}

function makeReviewItem(id: string): ReviewItem {
  return {
    id,
    profileId: "p-1",
    contentItemId: `c-${id}`,
    contentRef: { contentType: "review_deck", contentId: `c-${id}` },
    skill: "reading",
    prompt: "复习项",
    dueOn: "2026-09-26",
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 1,
    lastReviewedOn: null,
    createdAt: "2026-09-25T00:00:00.000Z",
  };
}

function makeOutstandingTask(id: string, minutes: number): StudyTask {
  return {
    id,
    planId: "plan-old",
    kind: "translation_drill",
    skill: "translation",
    priority: "core",
    title: "昨天的翻译训练",
    rationale: "",
    estimatedMinutes: minutes,
    contentRef: { contentType: "translation_prompt", contentId: "trans-1" },
    status: "pending",
    completedAt: null,
    order: 0,
  };
}

describe("Finding 1 回归 · 考试日期与时区", () => {
  it("EXAM_DATE 来自单一事实来源，且为官方日期 2026-12-12", () => {
    expect(EXAM_DATE).toBe("2026-12-12");
    expect(CET6_EXAM_DATE).toBe("2026-12-12");
  });

  it("planner 的 notes 使用正确剩余天数", () => {
    const out = planDay(baseInput({ today: "2026-12-11", examDate: CET6_EXAM_DATE }));
    expect(out.notes.some((n) => n.includes("距考试 1 天"))).toBe(true);
  });

  it("考试当天剩余 0 天，且不报'已过'", () => {
    const out = planDay(baseInput({ today: CET6_EXAM_DATE, examDate: CET6_EXAM_DATE }));
    expect(out.notes.some((n) => n.includes("距考试 0 天"))).toBe(true);
    expect(out.warnings.some((w) => w.includes("已过"))).toBe(false);
  });

  it("考试次日才报'日期已过'", () => {
    const out = planDay(baseInput({ today: "2026-12-13", examDate: CET6_EXAM_DATE }));
    expect(out.warnings.some((w) => w.includes("考试日期已过"))).toBe(true);
  });

  it("目标日期为 2026-12-12 时，planDay 不因日期错位而误判", () => {
    // 旧代码用 UTC 解析而本地时区构造，可能在部分时区把 12-12 算成 12-13 从而报"已过"
    const out = planDay(baseInput({ today: "2026-12-12", examDate: CET6_EXAM_DATE }));
    expect(out.warnings.some((w) => w.includes("已过"))).toBe(false);
  });
});

describe("Finding 2 回归 · planner 不把未评估当作弱项", () => {
  function profileWithUnassessedListening(): SkillProfile {
    const base = makeProfile();
    return {
      ...base,
      skills: {
        ...base.skills,
        // 模拟真实状态：听力未评估（score 占位 0，但 status 表明未测量）
        listening: {
          skill: "listening",
          score: 0,
          mastery: "unknown",
          confidence: "low",
          status: "unassessed",
          unassessedReason: "无音频素材",
          evidenceCount: 0,
          lastUpdatedAt: "2026-09-01T00:00:00.000Z",
        },
      },
      recommendations: base.recommendations.map((r) =>
        r.skill === "listening"
          ? { ...r, weight: SKILL_WEIGHTS.listening, priority: "recommended" as const }
          : r,
      ),
    };
  }

  it("未评估的听力不会出现在 Today 计划里（无素材），且不被当作弱项加权", () => {
    const profile = profileWithUnassessedListening();
    const out = planDay(baseInput({ profile, availableMinutes: 120 }));
    // 听力不可执行 → 不排任务
    expect(out.tasks.some((t) => t.skill === "listening")).toBe(false);
    // 其他模块仍正常排课
    expect(out.tasks.length).toBeGreaterThan(0);
    // notes 说明听力为什么不排，而不是静默丢弃
    expect(out.notes.some((n) => n.includes("听力"))).toBe(true);
  });

  it("未评估模块的占位 0 分不会让它抢到最高预算", () => {
    const profile = profileWithUnassessedListening();
    // 只允许可执行模块时，预算按权重分配；听力权重为基准 0.35（未被加权）
    const budget = allocateMinutes(100, profile.recommendations, ["reading", "writing", "translation"]);
    expect(budget.listening).toBe(0);
    expect(budget.reading + budget.writing + budget.translation).toBe(100);
  });

  it("真实弱项仍然正确提高优先级（对照：不因 unassessed 逻辑被削弱）", () => {
    const weakTranslation = profileWithUnassessedListening();
    weakTranslation.recommendations = weakTranslation.recommendations.map((r) =>
      r.skill === "translation" ? { ...r, priority: "core" as const, weight: 0.3 } : { ...r, weight: 0.2333 },
    );
    const out = planDay(baseInput({ profile: weakTranslation, availableMinutes: 120 }));
    const translationTasks = out.tasks.filter((t) => t.skill === "translation");
    expect(translationTasks.length).toBeGreaterThan(0);
    expect(translationTasks.every((t) => t.priority === "core")).toBe(true);
  });
});

describe("日期与时间工具", () => {
  it("daysUntil 计算自然日差", () => {
    expect(daysUntil(CET6_EXAM_DATE, CET6_EXAM_DATE)).toBe(0);
    expect(daysUntil("2026-12-11", CET6_EXAM_DATE)).toBe(1);
    expect(daysUntil("2026-12-13", CET6_EXAM_DATE)).toBe(-1);
    // 2026-09-26 → 2026-12-12：9/26→10/26 为 30 天，→11/26 为 31 天，→12/12 为 16 天
    expect(daysUntil("2026-09-26", CET6_EXAM_DATE)).toBe(77);
  });

  it("daysUntil 与时区无关（UTC / 东八区 / 西五区 结果一致）", () => {
    // 纯日期差的语义不应依赖机器时区：这是此前 UTC 与本地时区混用的缺陷回归防护。
    const originalTZ = process.env.TZ;
    const results: number[] = [];
    for (const tz of ["UTC", "Asia/Shanghai", "America/New_York", "Pacific/Kiritimati"]) {
      process.env.TZ = tz;
      results.push(daysUntil("2026-09-26", CET6_EXAM_DATE));
    }
    process.env.TZ = originalTZ;
    expect(new Set(results).size).toBe(1);
    expect(results[0]).toBe(77);
  });

  it("addDays 跨月跨年与闰年都时区无关", () => {
    expect(addDays("2026-12-11", 1)).toBe(CET6_EXAM_DATE);
    expect(addDays("2026-12-12", -1)).toBe("2026-12-11");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // 闰年
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01"); // 非闰年
  });

  it("addDays / diffDays 在多时区下结果一致", () => {
    const originalTZ = process.env.TZ;
    const added: string[] = [];
    const diffs: number[] = [];
    for (const tz of ["UTC", "Asia/Shanghai", "America/New_York", "Pacific/Auckland"]) {
      process.env.TZ = tz;
      added.push(addDays("2026-12-11", 1));
      diffs.push(diffDays("2026-09-26", CET6_EXAM_DATE));
    }
    process.env.TZ = originalTZ;
    expect(new Set(added).size).toBe(1);
    expect(added[0]).toBe(CET6_EXAM_DATE);
    expect(new Set(diffs).size).toBe(1);
  });

  it("isWeekendISO 与时区无关，且与 planner.isWeekend 一致", () => {
    const originalTZ = process.env.TZ;
    const results: boolean[] = [];
    for (const tz of ["UTC", "Asia/Shanghai", "America/New_York"]) {
      process.env.TZ = tz;
      results.push(isWeekendISO("2026-09-26")); // 周六
      results.push(isWeekendISO("2026-09-28")); // 周一
    }
    process.env.TZ = originalTZ;
    expect(results.slice(0, 2)).toEqual([true, false]);
    expect(new Set(results).size).toBe(2);
    // planner 的封装必须与底层实现一致
    expect(isWeekend("2026-09-26")).toBe(isWeekendISO("2026-09-26"));
    expect(isWeekend("2026-09-28")).toBe(isWeekendISO("2026-09-28"));
  });

  it("todayISO 返回合法的本地日期字符串", () => {
    const today = todayISO();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // 与本地时区的年月日一致（不得是 UTC 的前一天/后一天）
    const now = new Date();
    const expected = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate(),
    ).padStart(2, "0")}`;
    expect(today).toBe(expected);
  });

  it("isWeekend 区分周六周日", () => {
    expect(isWeekend("2026-09-26")).toBe(true);
    expect(isWeekend("2026-09-27")).toBe(true);
    expect(isWeekend("2026-09-28")).toBe(false);
  });
});

describe("任务时长必须来自真实内容", () => {
  it("每个任务的时长等于其绑定内容的时长", () => {
    const out = planDay(baseInput({ availableMinutes: 120 }));
    expect(out.tasks.length).toBeGreaterThan(0);
    for (const task of out.tasks) {
      if (task.kind === "review") continue;
      const option = Object.values(CATALOG)
        .flat()
        .find((o) => o.id === task.contentRef?.contentId);
      expect(option, `任务 ${task.title} 的内容应在目录中`).toBeDefined();
      expect(task.estimatedMinutes, task.title).toBe(option!.minutes);
    }
  });

  it("内容引用指向真实存在的素材，不是占位空 id", () => {
    const out = planDay(baseInput({ availableMinutes: 120 }));
    for (const task of out.tasks) {
      expect(task.contentRef?.contentId, task.title).toBeTruthy();
    }
  });

  it("今天的任务总时长不超过可用时间", () => {
    for (const minutes of [0, 5, 8, 10, 12, 20, 25, 30, 45, 60, 90, 120, 180]) {
      const out = planDay(baseInput({ availableMinutes: minutes }));
      expect(out.plannedMinutes, `available=${minutes}`).toBeLessThanOrEqual(minutes);
    }
  });

  it("不能产生'时长超过内容实际需要'的任务（不裁剪、不谎报）", () => {
    const out = planDay(baseInput({ availableMinutes: 90 }));
    const allowedMinutes = new Set(Object.values(CATALOG).flat().map((o) => o.minutes));
    for (const task of out.tasks) {
      if (task.kind === "review") continue;
      expect(allowedMinutes.has(task.estimatedMinutes), task.title).toBe(true);
    }
  });
});

describe("场景 1 · 工作日 60 分钟", () => {
  const input = baseInput({ today: "2026-09-28", availableMinutes: 60 });

  it("产出多个任务且恰好用满或接近用满", () => {
    const out = planDay(input);
    expect(out.tasks.length).toBeGreaterThanOrEqual(3);
    expect(out.plannedMinutes).toBeLessThanOrEqual(60);
    expect(out.plannedMinutes).toBeGreaterThan(30);
  });

  it("阅读权重最高，因此安排阅读内容", () => {
    const out = planDay(input);
    expect(out.tasks.some((t) => t.skill === "reading")).toBe(true);
  });

  it("不可执行的模块（听力）不出现在计划中，并在 notes 里说明原因", () => {
    const out = planDay(input);
    expect(out.tasks.some((t) => t.skill === "listening")).toBe(false);
    expect(out.notes.some((n) => n.includes("听力"))).toBe(true);
  });

  it("允许听力后计划中会出现听力任务", () => {
    const out = planDay(
      baseInput({
        availableMinutes: 60,
        executableSkills: ["listening", "reading", "writing", "translation"],
        contentCatalog: {
          ...CATALOG,
          listening: [{ id: "listen-1", type: "listening_pending", minutes: 10 }],
        },
      }),
    );
    expect(out.tasks.some((t) => t.skill === "listening")).toBe(true);
  });
});

describe("场景 2 · 周末 120 分钟", () => {
  const input = baseInput({ today: "2026-09-26", availableMinutes: 120 });

  it("比工作日安排更多任务与更长总时长", () => {
    const weekend = planDay(input);
    const weekday = planDay(baseInput({ today: "2026-09-28", availableMinutes: 60 }));
    expect(weekend.tasks.length).toBeGreaterThan(weekday.tasks.length);
    expect(weekend.plannedMinutes).toBeGreaterThan(weekday.plannedMinutes);
  });

  it("包含 optional 词汇加分项（时间富余时）", () => {
    const out = planDay(input);
    expect(out.tasks.some((t) => t.priority === "optional")).toBe(true);
  });

  it("时间充足时不产生顺延警告", () => {
    const out = planDay(input);
    expect(out.warnings.filter((w) => w.includes("顺延"))).toHaveLength(0);
  });
});

describe("场景 3 · 只有 20 分钟", () => {
  const input = baseInput({ availableMinutes: 20 });

  it("总时长不超过 20 分钟", () => {
    const out = planDay(input);
    expect(out.plannedMinutes).toBeLessThanOrEqual(20);
  });

  it("不含 optional", () => {
    const out = planDay(input);
    expect(out.tasks.every((t) => t.priority !== "optional")).toBe(true);
  });

  it("明确告知已进入短日模式", () => {
    const out = planDay(input);
    expect(out.warnings.some((w) => w.includes("20 分钟"))).toBe(true);
    expect(out.warnings.some((w) => w.includes("短日"))).toBe(true);
  });

  it("至少保留一项可以立刻开始的任务", () => {
    const out = planDay(input);
    expect(out.tasks.length).toBeGreaterThan(0);
    expect(out.tasks.some((t) => t.priority === "core")).toBe(true);
  });

  it("20 分钟内放不下写作（25 分钟），应在警告中说明", () => {
    const out = planDay(input);
    expect(out.tasks.some((t) => t.skill === "writing")).toBe(false);
  });

  it("复习队列在短日下依然优先", () => {
    const out = planDay(baseInput({ availableMinutes: 20, dueReviewItems: [makeReviewItem("r1"), makeReviewItem("r2")] }));
    expect(out.tasks[0].kind).toBe("review");
  });
});

describe("场景 4 · 用户漏做了昨天", () => {
  const outstanding = [makeOutstandingTask("t-old", 12)];

  it("逾期核心任务被补做且排在最前", () => {
    const out = planDay(baseInput({ availableMinutes: 60, outstandingTasks: outstanding }));
    expect(out.tasks[0].title).toContain("补做");
    expect(out.tasks[0].priority).toBe("core");
  });

  it("补做任务沿用原时长，不重新估算", () => {
    const out = planDay(baseInput({ availableMinutes: 60, outstandingTasks: outstanding }));
    expect(out.tasks[0].estimatedMinutes).toBe(12);
  });

  it("复习项仍然排在补做任务之前", () => {
    const out = planDay(
      baseInput({ availableMinutes: 60, outstandingTasks: outstanding, dueReviewItems: [makeReviewItem("r1")] }),
    );
    expect(out.tasks[0].kind).toBe("review");
    expect(out.tasks[1].title).toContain("补做");
  });

  it("补做任务不会被顺延（时间足够时）", () => {
    const out = planDay(baseInput({ availableMinutes: 60, outstandingTasks: outstanding }));
    expect(out.tasks.some((t) => t.title.includes("补做"))).toBe(true);
  });
});

describe("场景 5 · 某个模块明显薄弱", () => {
  it("薄弱模块获得更多训练时间与 core 优先级", () => {
    const weakTranslation: SkillProfile = {
      ...makeProfile({ translation: 30, listening: 75, reading: 75, writing: 70 }),
    };
    weakTranslation.recommendations = weakTranslation.recommendations.map((r) =>
      r.skill === "translation" ? { ...r, priority: "core", weight: 0.3 } : { ...r, weight: 0.23 },
    );

    const out = planDay(baseInput({ availableMinutes: 120, profile: weakTranslation }));
    const translation = out.tasks.filter((t) => t.skill === "translation");
    expect(translation.length).toBeGreaterThan(0);
    expect(translation.every((t) => t.priority === "core")).toBe(true);
  });

  it("allocateMinutes 在推荐权重下归一化", () => {
    const budget = allocateMinutes(100, [
      { skill: "listening", dimension: "listening", reason: "", weight: 0.4, priority: "core" },
      { skill: "reading", dimension: "reading", reason: "", weight: 0.4, priority: "core" },
      { skill: "writing", dimension: "writing", reason: "", weight: 0.1, priority: "recommended" },
      { skill: "translation", dimension: "translation", reason: "", weight: 0.1, priority: "recommended" },
    ]);
    expect(budget.listening).toBe(40);
    expect(budget.reading).toBe(40);
    expect(budget.writing).toBe(10);
    expect(budget.translation).toBe(10);
  });

  it("无诊断时退回官方分值权重 35/35/15/15", () => {
    const budget = allocateMinutes(100, null);
    expect(budget.listening).toBe(35);
    expect(budget.reading).toBe(35);
    expect(budget.writing).toBe(15);
    expect(budget.translation).toBe(15);
  });

  it("排除听力后额度转给其余模块，总量守恒", () => {
    const budget = allocateMinutes(100, null, ["reading", "writing", "translation"]);
    expect(budget.listening).toBe(0);
    expect(budget.reading + budget.writing + budget.translation).toBe(100);
    expect(budget.reading).toBeGreaterThan(35);
  });
});

describe("场景 6 · 任务时长超过可用时间", () => {
  it("放不下的任务不被安排，也不会被裁剪成假时长", () => {
    const outstanding = [makeOutstandingTask("t-big", 90)];
    const out = planDay(baseInput({ availableMinutes: 45, outstandingTasks: outstanding }));
    expect(out.plannedMinutes).toBeLessThanOrEqual(45);
    const big = out.tasks.find((t) => t.title.includes("补做"));
    // 90 分钟放不进 45 分钟 → 不安排，而不是报成 45 分钟
    expect(big).toBeUndefined();
    expect(out.deferredMinutes).toBeGreaterThan(0);
  });

  it("放得下的任务正常安排", () => {
    const outstanding = [makeOutstandingTask("t-small", 30)];
    const out = planDay(baseInput({ availableMinutes: 45, outstandingTasks: outstanding }));
    expect(out.tasks.some((t) => t.title.includes("补做"))).toBe(true);
  });

  it("时间少于最短内容时长时产出空计划并给出解释", () => {
    // 目录里最短是 6 分钟（翻译）
    const out = planDay(baseInput({ availableMinutes: 3 }));
    expect(out.tasks).toHaveLength(0);
    expect(out.warnings.some((w) => w.includes("没有可安排"))).toBe(true);
  });

  it("可用时间为 0 时不产生任务且不抛异常", () => {
    const out = planDay(baseInput({ availableMinutes: 0 }));
    expect(out.tasks).toHaveLength(0);
    expect(out.plannedMinutes).toBe(0);
  });
});

describe("边界与确定性", () => {
  it("相同输入产出相同结果（纯函数）", () => {
    const input = baseInput({ availableMinutes: 75, dueReviewItems: [makeReviewItem("r1")] });
    expect(JSON.stringify(planDay(input))).toBe(JSON.stringify(planDay(input)));
  });

  it("同一天不同调用选择相同的材料（确定性轮换）", () => {
    const a = planDay(baseInput({ availableMinutes: 60 }));
    const b = planDay(baseInput({ availableMinutes: 60 }));
    expect(a.tasks.map((t) => t.contentRef?.contentId)).toEqual(b.tasks.map((t) => t.contentRef?.contentId));
  });

  it("不同日期轮换到不同材料", () => {
    const a = planDay(baseInput({ today: "2026-09-26", availableMinutes: 60 }));
    const b = planDay(baseInput({ today: "2026-09-29", availableMinutes: 60 }));
    expect(a.tasks.map((t) => t.contentRef?.contentId)).not.toEqual(b.tasks.map((t) => t.contentRef?.contentId));
  });

  it("考试日期已过时给出提示", () => {
    const out = planDay(baseInput({ examDate: "2026-01-01" }));
    expect(out.warnings.some((w) => w.includes("考试日期已过"))).toBe(true);
  });

  it("无诊断画像时仍能产出可执行的起始任务", () => {
    const out = planDay(baseInput({ availableMinutes: 30, profile: null }));
    expect(out.tasks.length).toBeGreaterThan(0);
    expect(out.tasks.every((t) => EXECUTABLE.includes(t.skill))).toBe(true);
  });

  it("复习项过多时复习时长被限制，不会吞掉全部时间", () => {
    const many = Array.from({ length: 30 }, (_, i) => makeReviewItem(`r${i}`));
    const out = planDay(baseInput({ availableMinutes: 60, dueReviewItems: many }));
    const review = out.tasks.find((t) => t.kind === "review");
    expect(review).toBeDefined();
    expect(review!.estimatedMinutes).toBeLessThanOrEqual(15);
  });

  it("每个任务都有非空 rationale（Today 必须能解释为什么练这个）", () => {
    const out = planDay(baseInput({ availableMinutes: 120, dueReviewItems: [makeReviewItem("r1")] }));
    for (const task of out.tasks) {
      expect(task.rationale.trim().length, task.title).toBeGreaterThan(0);
    }
  });

  it("无内容素材时产出空计划并说明，而不是排一个点不开的任务", () => {
    const out = planDay(baseInput({ availableMinutes: 60, contentCatalog: {} }));
    expect(out.tasks).toHaveLength(0);
    expect(out.warnings.some((w) => w.includes("没有可安排"))).toBe(true);
  });

  it("同一份材料一天只被安排一次（不会重复出现）", () => {
    const out = planDay(baseInput({ availableMinutes: 300 }));
    const ids = out.tasks.map((t) => t.contentRef?.contentId).filter(Boolean) as string[];
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("每个模块每天最多安排两项主题材，避免 Today 被同一模块刷屏", () => {
    const out = planDay(baseInput({ availableMinutes: 300 }));
    const bySkillPrimary = new Map<string, number>();
    for (const task of out.tasks) {
      // 只统计按模块预算排进来的技能训练项；复习与词汇加分项不算
      if (task.kind === "review" || task.kind === "vocabulary_recall") continue;
      bySkillPrimary.set(task.skill, (bySkillPrimary.get(task.skill) ?? 0) + 1);
    }
    for (const [skill, count] of bySkillPrimary) {
      expect(count, skill).toBeLessThanOrEqual(2);
    }
  });
});
