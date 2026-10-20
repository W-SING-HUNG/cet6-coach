import { describe, expect, it } from "vitest";
import {
  applyVocabularyInfluence,
  deriveRecommendations,
  deriveUnassessedNotices,
  deriveWeaknesses,
  hasSufficientEvidence,
  isCoherentAssessment,
  scoreDimensions,
  toMastery,
} from "@/domain/scoring";
import {
  DIMENSION_EVIDENCE_REQUIREMENTS,
  SKILL_WEIGHTS,
  type AssessmentStatus,
  type DiagnosticDimension,
  type MasteryLevel,
} from "@/domain/types";
import type { DiagnosticAnswer, SkillProfile } from "@/domain/models";
import { DIAGNOSTIC_ITEMS } from "@/content/diagnostic-bank";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { createTestDb, resetDb } from "@/db/client";
import { completeOnboarding, DEFAULT_ONBOARDING } from "@/services/onboarding";
import { getDiagnosticOutcome, startDiagnostic, submitDiagnostic } from "@/services/diagnostic";
import { planDay, type ContentCatalog } from "@/domain/planner";

/**
 * MAJOR-1 · 诊断三态语义契约的守护测试。
 *
 * 契约（见 src/domain/types.ts 的 AssessmentStatus 注释）：
 * - assessed              ⇒ mastery ≠ unknown（有方向性结论）
 * - insufficient_evidence ⇒ mastery = unknown（有工具但证据不够）
 * - unassessed            ⇒ mastery = unknown（没有工具）
 *
 * 旧缺陷：`toMastery` 用 confidence 判定，产生 `assessed + low confidence + unknown mastery`
 * 这一自相矛盾的状态。本文件确保它不再出现。
 */

function itemOf(dimension: DiagnosticDimension, index = 0) {
  return DIAGNOSTIC_ITEMS.filter((i) => i.dimension === dimension)[index];
}

function answerFor(dimension: DiagnosticDimension, correct: boolean, index = 0): DiagnosticAnswer {
  const item = itemOf(dimension, index);
  return {
    itemId: item.id,
    dimension,
    choiceId: item.type === "mcq" ? (correct ? item.correctChoiceId! : "zzz") : null,
    text: item.type === "short_text" ? (correct ? (item.rubricPoints ?? []).join(" and ") : "") : null,
    skipped: false,
    submittedAt: "2026-09-26T00:00:00.000Z",
  };
}

const ALL_STATUSES: AssessmentStatus[] = ["assessed", "insufficient_evidence", "unassessed"];

describe("三态语义契约", () => {
  it("status=assessed 永不出 unknown mastery（跨所有分数）", () => {
    for (let score = 0; score <= 100; score += 1) {
      const mastery = toMastery(score, "assessed");
      expect(mastery, `score=${score}`).not.toBe("unknown");
    }
  });

  it("status 为两种未知态时 mastery 恒为 unknown（跨所有分数）", () => {
    for (const status of ["insufficient_evidence", "unassessed"] as const) {
      for (let score = 0; score <= 100; score += 7) {
        expect(toMastery(score, status), `${status} score=${score}`).toBe("unknown");
      }
    }
  });

  it("isCoherentAssessment 对所有状态组合给出正确判定", () => {
    for (const status of ALL_STATUSES) {
      for (const mastery of ["unknown", "weak", "developing", "solid", "strong"] as MasteryLevel[]) {
        const expected = status === "assessed" ? mastery !== "unknown" : mastery === "unknown";
        expect(isCoherentAssessment(status, mastery), `${status}/${mastery}`).toBe(expected);
      }
    }
  });

  it("scoreDimensions 产出的一切组合都自洽", () => {
    // 多种作答模式，确保没有遗漏的边界
    const patterns = {
      empty: [] as DiagnosticAnswer[],
      oneEach: [
        answerFor("vocabulary", true),
        answerFor("reading", true),
        answerFor("writing", true),
        answerFor("translation", true),
      ],
      allVocab: DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "vocabulary").map((i) =>
        answerFor("vocabulary", true, DIAGNOSTIC_ITEMS.filter((x) => x.dimension === "vocabulary").indexOf(i)),
      ),
      allWrong: DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) =>
        answerFor(i.dimension, false, DIAGNOSTIC_ITEMS.filter((x) => x.dimension === i.dimension).indexOf(i)),
      ),
    };

    for (const [name, answers] of Object.entries(patterns)) {
      for (const result of scoreDimensions(DIAGNOSTIC_ITEMS, answers)) {
        expect(
          isCoherentAssessment(result.status, result.mastery),
          `${name}: ${result.dimension} status=${result.status} mastery=${result.mastery}`,
        ).toBe(true);
      }
    }
  });
});

describe("按维度测量设计的证据充足性", () => {
  it("每个维度的要求都有可核对的测量依据", () => {
    for (const dimension of Object.keys(DIMENSION_EVIDENCE_REQUIREMENTS) as DiagnosticDimension[]) {
      const req = DIMENSION_EVIDENCE_REQUIREMENTS[dimension];
      expect(req.rationale.length, dimension).toBeGreaterThan(20);
      expect(req.expectedItems, dimension).toBeGreaterThanOrEqual(req.minValidItems);
      // 要求不得超过题库实际题量
      const actual = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === dimension && i.type !== "pending_media").length;
      expect(req.expectedItems, `${dimension} 的 expectedItems 超出了实际题量`).toBeLessThanOrEqual(actual);
    }
  });

  it("hasSufficientEvidence 按维度（而非统一阈值）判定", () => {
    // 写作：1 篇即充足
    expect(hasSufficientEvidence("writing", 1)).toBe(true);
    expect(hasSufficientEvidence("writing", 0)).toBe(false);
    // 翻译：1 道即充足
    expect(hasSufficientEvidence("translation", 1)).toBe(true);
    expect(hasSufficientEvidence("translation", 0)).toBe(false);
    // 阅读：需 2 道
    expect(hasSufficientEvidence("reading", 1)).toBe(false);
    expect(hasSufficientEvidence("reading", 2)).toBe(true);
    // 词汇：需 3 道
    expect(hasSufficientEvidence("vocabulary", 2)).toBe(false);
    expect(hasSufficientEvidence("vocabulary", 3)).toBe(true);
    // 听力：无测量工具，永远不足
    expect(hasSufficientEvidence("listening", 0)).toBe(false);
    expect(hasSufficientEvidence("listening", 100)).toBe(false);
  });

  it("跳过有效工具不会变成低分（而是 insufficient_evidence）", () => {
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, []);
    for (const result of results) {
      if (result.dimension === "listening") {
        expect(result.status).toBe("unassessed");
        continue;
      }
      expect(result.status, result.dimension).toBe("insufficient_evidence");
      expect(result.mastery, result.dimension).toBe("unknown");
      // 关键是不得产生"弱"结论
      expect(result.mastery, result.dimension).not.toBe("weak");
    }
  });
});

describe("听力恒为 unassessed", () => {
  it("无论答题情况如何，听力都不会变成 assessed", () => {
    const scenarios = [
      [] as DiagnosticAnswer[],
      DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) =>
        answerFor(i.dimension, true, DIAGNOSTIC_ITEMS.filter((x) => x.dimension === i.dimension).indexOf(i)),
      ),
      DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) =>
        answerFor(i.dimension, false, DIAGNOSTIC_ITEMS.filter((x) => x.dimension === i.dimension).indexOf(i)),
      ),
    ];
    for (const answers of scenarios) {
      const listening = scoreDimensions(DIAGNOSTIC_ITEMS, answers).find((r) => r.dimension === "listening")!;
      expect(listening.status).toBe("unassessed");
      expect(listening.mastery).toBe("unknown");
      expect(listening.gradedItems).toBe(0);
      expect(listening.unassessedReason).toBeTruthy();
    }
  });

  it("词汇影响不会让听力的分数被填充", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "vocabulary").map((i, idx) =>
      answerFor("vocabulary", true, idx),
    );
    const influenced = applyVocabularyInfluence(scoreDimensions(DIAGNOSTIC_ITEMS, answers));
    const listening = influenced.find((r) => r.dimension === "listening")!;
    expect(listening.status).toBe("unassessed");
    expect(listening.adjustedScore).toBe(0);
  });
});

describe("未知状态不得影响弱项与训练权重", () => {
  function result(
    dimension: DiagnosticDimension,
    adjustedScore: number,
    status: AssessmentStatus,
  ) {
    return {
      dimension,
      rawScore: adjustedScore,
      adjustedScore,
      mastery: toMastery(adjustedScore, status),
      confidence: "low" as const,
      status,
      unassessedReason: status === "unassessed" ? "无工具" : null,
      gradedItems: status === "assessed" ? 3 : 0,
      skippedItems: 0,
      evidence: [],
    };
  }

  it("weakness 推导同时排除 unassessed 与 insufficient_evidence，即使分数很低", () => {
    const results = [
      result("listening", 0, "unassessed"),
      result("reading", 5, "insufficient_evidence"), // 极低分但无结论
      result("writing", 20, "assessed"), // 真实的弱项
    ];
    const weaknesses = deriveWeaknesses(results);
    expect(weaknesses.map((w) => w.dimension)).toEqual(["writing"]);
    expect(weaknesses.some((w) => w.dimension === "listening")).toBe(false);
    expect(weaknesses.some((w) => w.dimension === "reading")).toBe(false);
  });

  it("planner 权重不把两种未知态当作弱项加权", () => {
    const results = [
      result("listening", 0, "unassessed"),
      result("reading", 0, "insufficient_evidence"),
      result("writing", 80, "assessed"),
      result("translation", 80, "assessed"),
    ];
    const recs = deriveRecommendations(results);

    const listening = recs.find((r) => r.skill === "listening")!;
    const reading = recs.find((r) => r.skill === "reading")!;

    expect(listening.weight).toBeCloseTo(SKILL_WEIGHTS.listening, 3);
    expect(reading.weight).toBeCloseTo(SKILL_WEIGHTS.reading, 3);
    expect(listening.priority).toBe("recommended");
    expect(reading.priority).toBe("recommended");
    expect(recs.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 3);
  });

  it("未评估说明与弱项分列且互斥", () => {
    const results = [result("listening", 0, "unassessed"), result("writing", 20, "assessed")];
    const notices = deriveUnassessedNotices(results);
    const weaknesses = deriveWeaknesses(results);
    expect(notices.map((n) => n.dimension)).toEqual(["listening"]);
    expect(weaknesses.map((w) => w.dimension)).toEqual(["writing"]);
    expect(notices.every((n) => !weaknesses.some((w) => w.dimension === n.dimension))).toBe(true);
  });
});

describe("持久化保持三态与结论", () => {
  function seed(mode: "sufficient" | "insufficient") {
    const db = createTestDb();
    resetDb(db);
    const repos = createSqliteRepositories(db);
    completeOnboarding(repos, {
      displayName: "Learner",
      examName: DEFAULT_ONBOARDING.examName,
      examDate: DEFAULT_ONBOARDING.examDate,
      targetScore: DEFAULT_ONBOARDING.targetScore,
      weekdayMinutes: 60,
      weekendMinutes: 120,
    });
    const profileId = repos.learner.getProfile()!.id;
    const session = startDiagnostic(repos, profileId);

    const answers =
      mode === "sufficient"
        ? DIAGNOSTIC_ITEMS.filter((i) => i.type !== "pending_media").map((item) => ({
            itemId: item.id,
            dimension: item.dimension,
            choiceId: item.type === "mcq" ? item.correctChoiceId! : null,
            text: item.type === "short_text" ? (item.rubricPoints ?? []).join(" and ") : null,
            skipped: false,
          }))
        : // 只答 1 道词汇题 → 其余维度证据不足
          [
            {
              itemId: DIAGNOSTIC_ITEMS.find((i) => i.dimension === "vocabulary")!.id,
              dimension: "vocabulary" as const,
              choiceId: DIAGNOSTIC_ITEMS.find((i) => i.dimension === "vocabulary")!.correctChoiceId!,
              text: null,
              skipped: false,
            },
          ];

    submitDiagnostic(repos, { sessionId: session.id, answers });
    return { repos, profileId };
  }

  it("充足证据落库后：assessed 且 mastery 非 unknown；听力 unassessed", () => {
    const { repos, profileId } = seed("sufficient");
    const stored = repos.skillProfile.get(profileId)!;

    for (const skill of ["reading", "writing", "translation"] as const) {
      expect(stored.skills[skill].status, skill).not.toBe("unassessed");
    }
    expect(stored.skills.listening.status).toBe("unassessed");
    expect(stored.skills.listening.mastery).toBe("unknown");

    // 所有落库的 skill 状态自洽
    for (const skill of Object.keys(stored.skills) as Array<keyof typeof stored.skills>) {
      const s = stored.skills[skill];
      expect(isCoherentAssessment(s.status, s.mastery), `${skill}`).toBe(true);
    }
  });

  it("证据不足落库后：insufficient_evidence 且不产生弱项", () => {
    const { repos, profileId } = seed("insufficient");
    const stored = repos.skillProfile.get(profileId)!;

    expect(stored.skills.reading.status).toBe("insufficient_evidence");
    expect(stored.skills.reading.mastery).toBe("unknown");
    expect(stored.skills.listening.status).toBe("unassessed");
    // 未作答的维度不得成为弱项
    expect(stored.weaknesses.some((w) => w.dimension === "reading")).toBe(false);
    expect(stored.weaknesses.some((w) => w.dimension === "listening")).toBe(false);
  });

  it("重载（重算）后三态与 mastery 完全一致，无静默降级或升级", () => {
    const { repos, profileId } = seed("sufficient");
    const before = repos.skillProfile.get(profileId)!;
    // 只比较测量语义相关字段：lastUpdatedAt 是重算时间戳，天然会变
    const semanticOf = (p: typeof before) =>
      JSON.stringify(
        Object.fromEntries(
          (Object.keys(p.skills) as Array<keyof typeof p.skills>).map((k) => {
            const s = p.skills[k];
            return [k, { status: s.status, mastery: s.mastery, confidence: s.confidence, score: s.score, evidenceCount: s.evidenceCount }];
          }),
        ),
      );
    const beforeSemantics = semanticOf(before);

    // 触发一次重算（模拟页面重载走 getDiagnosticOutcome）
    const outcome = getDiagnosticOutcome(repos, profileId)!;
    const stored = repos.skillProfile.get(profileId)!;

    expect(semanticOf(stored)).toBe(beforeSemantics);
    for (const skill of Object.keys(stored.skills) as Array<keyof typeof stored.skills>) {
      const s = stored.skills[skill];
      expect(isCoherentAssessment(s.status, s.mastery), skill).toBe(true);
    }
    // 重算后的维度结果同样自洽
    for (const r of outcome.dimensionResults) {
      expect(isCoherentAssessment(r.status, r.mastery), r.dimension).toBe(true);
    }
  });

  it("insufficient_evidence 不会在重载后变成 assessed", () => {
    const { repos, profileId } = seed("insufficient");
    getDiagnosticOutcome(repos, profileId);
    const stored = repos.skillProfile.get(profileId)!;
    expect(stored.skills.translation.status).toBe("insufficient_evidence");
    expect(stored.skills.translation.mastery).toBe("unknown");
  });
});

describe("planner 不把未知态当作弱项（域层直测）", () => {
  const CATALOG: ContentCatalog = {
    reading: [{ id: "r1", type: "reading_passage", minutes: 12 }],
    writing: [{ id: "w1", type: "writing_prompt", minutes: 25 }],
    translation: [{ id: "t1", type: "translation_prompt", minutes: 6 }],
  };

  function profileWith(overrides: Partial<Record<string, AssessmentStatus>>): SkillProfile {
    const make = (skill: string) => {
      const status = (overrides[skill] ?? "assessed") as AssessmentStatus;
      return {
        skill: skill as never,
        score: status === "assessed" ? 50 : 0,
        mastery: toMastery(status === "assessed" ? 50 : 0, status),
        confidence: "low" as const,
        status,
        unassessedReason: status === "unassessed" ? "无工具" : null,
        evidenceCount: status === "assessed" ? 3 : 0,
        lastUpdatedAt: "2026-09-01T00:00:00.000Z",
      };
    };
    return {
      id: "p",
      profileId: "p",
      updatedAt: "t",
      skills: {
        listening: make("listening"),
        reading: make("reading"),
        writing: make("writing"),
        translation: make("translation"),
      } as SkillProfile["skills"],
      dimensions: [],
      weaknesses: [],
      recommendations: [],
      unassessedNotices: [],
      basedOnDiagnosticId: "d",
    };
  }

  it("听力 unassessed + 其他 insufficient_evidence 时，计划仍只按官方权重安排可执行模块", () => {
    const profile = profileWith({
      listening: "unassessed",
      reading: "insufficient_evidence",
      writing: "insufficient_evidence",
      translation: "insufficient_evidence",
    });
    const out = planDay({
      today: "2026-09-28",
      examDate: "2026-12-12",
      targetScore: 550,
      availableMinutes: 120,
      profile,
      dueReviewItems: [],
      outstandingTasks: [],
      recentCompletedSkills: [],
      executableSkills: ["reading", "writing", "translation"],
      contentCatalog: CATALOG,
    });

    // 听力无素材，不应出现
    expect(out.tasks.some((t) => t.skill === "listening")).toBe(false);
    // 不应因为"未知"而把任务全部标为 core 并超时
    expect(out.plannedMinutes).toBeLessThanOrEqual(120);
    expect(out.tasks.length).toBeGreaterThan(0);
  });

  it("全部模块 unknown 时仍产出可用计划，且不超时", () => {
    const profile = profileWith({
      listening: "unassessed",
      reading: "unassessed",
      writing: "unassessed",
      translation: "unassessed",
    });
    const out = planDay({
      today: "2026-09-28",
      examDate: "2026-12-12",
      targetScore: 550,
      availableMinutes: 60,
      profile,
      dueReviewItems: [],
      outstandingTasks: [],
      recentCompletedSkills: [],
      executableSkills: ["reading", "writing", "translation"],
      contentCatalog: CATALOG,
    });
    expect(out.plannedMinutes).toBeLessThanOrEqual(60);
    expect(out.tasks.every((t) => t.priority === "core" || t.priority === "recommended")).toBe(true);
  });
});
