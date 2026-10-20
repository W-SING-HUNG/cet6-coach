import { describe, expect, it } from "vitest";
import {
  applyVocabularyInfluence,
  deriveRecommendations,
  deriveWeaknesses,
  gradeWithRubric,
  scoreDimensions,
  toConfidence,
  toMastery,
} from "@/domain/scoring";
import { DIAGNOSTIC_ITEMS, summarizeBank } from "@/content/diagnostic-bank";
import { SKILL_WEIGHTS } from "@/domain/types";
import type { AssessmentStatus } from "@/domain/types";
import type { ConfidenceLevel, DiagnosticAnswer, DiagnosticItem, DimensionResult } from "@/domain/models";

/** 构造维度结果的测试辅助，用于直接测试依赖维度输入的纯函数。 */
function dimensionResult(
  dimension: DimensionResult["dimension"],
  adjustedScore: number,
  confidence: ConfidenceLevel = "medium",
  status: AssessmentStatus = "assessed",
): DimensionResult {
  return {
    dimension,
    rawScore: adjustedScore,
    adjustedScore: status === "unassessed" ? 0 : adjustedScore,
    mastery: status === "unassessed" ? "unknown" : "developing",
    confidence,
    status,
    unassessedReason: status === "unassessed" ? "缺少有效测量手段" : null,
    gradedItems: status === "unassessed" ? 0 : 6,
    skippedItems: 0,
    evidence: [],
  };
}

/**
 * 诊断评分测试。
 *
 * 重点验证两件事：
 * 1. 规则本身正确（计分、置信度、弱项、权重）。
 * 2. 诚实性约束成立 —— 证据不足时必须降级而不是给出自信的结论。
 */

function answerFor(item: DiagnosticItem, correct: boolean): DiagnosticAnswer {
  return {
    itemId: item.id,
    dimension: item.dimension,
    choiceId: item.type === "mcq" ? (correct ? item.correctChoiceId! : "zzz") : null,
    text: item.type === "short_text" ? (correct ? "answered" : "") : null,
    skipped: false,
    submittedAt: "2026-09-26T00:00:00.000Z",
  };
}

describe("诊断题库结构", () => {
  it("题目 id 唯一", () => {
    const ids = DIAGNOSTIC_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("覆盖全部五个能力维度", () => {
    const dimensions = new Set(DIAGNOSTIC_ITEMS.map((i) => i.dimension));
    expect([...dimensions].sort()).toEqual(["listening", "reading", "translation", "vocabulary", "writing"]);
  });

  it("每道选择题都有正确答案、选项与解析", () => {
    for (const item of DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq")) {
      expect(item.choices, item.id).toBeDefined();
      expect(item.correctChoiceId, item.id).toBeTruthy();
      expect(item.choices!.map((c) => c.id), item.id).toContain(item.correctChoiceId!);
      expect(item.explanation, item.id).toBeTruthy();
      // 选项 id 必须唯一，否则选择状态会互相覆盖
      expect(new Set(item.choices!.map((c) => c.id)).size, item.id).toBe(item.choices!.length);
    }
  });

  it("阅读题目共享同一段材料，且每题独立计分", () => {
    const reading = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "reading");
    expect(reading.length).toBeGreaterThanOrEqual(4);
    const passages = new Set(reading.map((i) => i.passage));
    // 同一段落用于多题：这是阅读题的正常形态
    expect(passages.size).toBeLessThan(reading.length);
    expect(reading.every((i) => (i.passage?.length ?? 0) > 200)).toBe(true);
  });

  it("pending_media 题目声明了原因且不参与计分", () => {
    const pending = DIAGNOSTIC_ITEMS.filter((i) => i.type === "pending_media");
    expect(pending.length).toBeGreaterThan(0);
    for (const item of pending) {
      expect(item.pendingReason, item.id).toBeTruthy();
      expect(item.estimatedSeconds).toBe(0);
    }
  });

  it("听力维度不再包含任何可计分题（无音频即无效测量）", () => {
    const summary = summarizeBank(DIAGNOSTIC_ITEMS);
    const listening = summary.get("listening")!;
    // 听力只保留一条 pending_media 记录，用于表达 unassessed 状态
    expect(listening.total).toBe(1);
    expect(listening.gradeable).toBe(0);
  });

  it("原 IPA 辨词题已归入 vocabulary，不再是 listening 证据", () => {
    const phonetic = DIAGNOSTIC_ITEMS.filter((i) => i.tags.includes("vocabulary.phonetic_recognition"));
    expect(phonetic.length).toBe(4);
    for (const item of phonetic) {
      expect(item.dimension, item.id).toBe("vocabulary");
      expect(item.tags.some((t) => t.startsWith("listening.")), item.id).toBe(false);
    }
    // 这些题仍可计分（它们对词汇/语音意识有真实价值），只是不再冒充听力
    for (const item of phonetic) {
      expect(item.type, item.id).toBe("mcq");
      expect(item.correctChoiceId, item.id).toBeTruthy();
    }
  });

  it("没有任何题目的 tags 会把音形能力标成听力理解", () => {
    const listeningItems = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "listening");
    for (const item of listeningItems) {
      // 听力只能以 pending_media 形式存在，不允许有可计分的"听力"题
      expect(item.type, item.id).toBe("pending_media");
    }
  });

  it("主观题都带评分要点", () => {
    for (const item of DIAGNOSTIC_ITEMS.filter((i) => i.type === "short_text")) {
      expect(item.rubricPoints?.length ?? 0, item.id).toBeGreaterThan(0);
    }
  });
});

describe("scoreDimensions", () => {
  it("全部答对时各维度接近满分", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type !== "pending_media").map((i) => answerFor(i, true));
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, answers);
    const vocab = results.find((r) => r.dimension === "vocabulary")!;
    expect(vocab.rawScore).toBe(100);
    // 收缩估计：即使全对也不会正好 100
    expect(vocab.adjustedScore).toBeGreaterThan(85);
    expect(vocab.adjustedScore).toBeLessThanOrEqual(100);
  });

  it("全部答错时 adjustedScore 被收缩到 50 以下但不为 0", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => answerFor(i, false));
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, answers);
    const vocab = results.find((r) => r.dimension === "vocabulary")!;
    expect(vocab.rawScore).toBe(0);
    expect(vocab.adjustedScore).toBeGreaterThan(0);
    expect(vocab.adjustedScore).toBeLessThan(50);
  });

  it("未作答的维度不计入原始正确率分母", () => {
    const readingAnswers = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "reading")
      .slice(0, 2)
      .map((i) => answerFor(i, true));
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, readingAnswers);
    const reading = results.find((r) => r.dimension === "reading")!;
    expect(reading.gradedItems).toBe(2);
    expect(reading.rawScore).toBe(100);
  });

  it("没作答的题目等同于跳过，不计入正确率分母", () => {
    const item = DIAGNOSTIC_ITEMS.find((i) => i.dimension === "vocabulary")!;
    const skipped: DiagnosticAnswer = {
      ...answerFor(item, false),
      skipped: true,
      choiceId: null,
    };
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, [skipped]);
    const result = results.find((r) => r.dimension === "vocabulary")!;
    // 词汇现有 9 题（5 个词义题 + 4 个音形题），只提交 1 题且标记跳过 → 全部未计分
    const vocabularyItems = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "vocabulary");
    expect(result.gradedItems).toBe(0);
    expect(result.skippedItems).toBe(vocabularyItems.length);
    expect(result.rawScore).toBe(0);
    // 没有任何证据 → 状态为 insufficient_evidence、等级未知，而不是被判定为"弱"
    expect(result.status).toBe("insufficient_evidence");
    expect(result.mastery).toBe("unknown");
  });

  it("写作单篇样本即为充足证据（按该维度真实测量设计）", () => {
    // Phase 1 的写作诊断被刻意设计为 1 道完整写作样本：测量单位是"一篇作文"，
    // 不是"多道题"。因此 1 篇有效作答 ⇒ assessed，但因样本少 confidence 仍为 low。
    const item = DIAGNOSTIC_ITEMS.find((i) => i.dimension === "writing")!;
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, [answerFor(item, true)]);
    const writing = results.find((r) => r.dimension === "writing")!;
    expect(writing.status).toBe("assessed");
    expect(writing.confidence).toBe("low");
    // 关键不变式：assessed 必须给出方向性结论，不能是 unknown
    expect(writing.mastery).not.toBe("unknown");
  });

  it("词汇需 3 道有效题才算充足，1-2 道为 insufficient_evidence", () => {
    const vocabItems = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "vocabulary");
    for (const count of [1, 2]) {
      const results = scoreDimensions(
        DIAGNOSTIC_ITEMS,
        vocabItems.slice(0, count).map((i) => answerFor(i, true)),
      );
      const vocab = results.find((r) => r.dimension === "vocabulary")!;
      expect(vocab.status, `${count} 道应为 insufficient_evidence`).toBe("insufficient_evidence");
      expect(vocab.mastery).toBe("unknown");
    }
    const three = scoreDimensions(
      DIAGNOSTIC_ITEMS,
      vocabItems.slice(0, 3).map((i) => answerFor(i, true)),
    ).find((r) => r.dimension === "vocabulary")!;
    expect(three.status).toBe("assessed");
    expect(three.mastery).not.toBe("unknown");
  });

  it("阅读需 2 道有效题才算充足", () => {
    const readingItems = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "reading");
    const one = scoreDimensions(DIAGNOSTIC_ITEMS, [answerFor(readingItems[0], true)]).find(
      (r) => r.dimension === "reading",
    )!;
    expect(one.status).toBe("insufficient_evidence");
    const two = scoreDimensions(
      DIAGNOSTIC_ITEMS,
      readingItems.slice(0, 2).map((i) => answerFor(i, true)),
    ).find((r) => r.dimension === "reading")!;
    expect(two.status).toBe("assessed");
  });

  it("翻译 1 道有效作答即为充足", () => {
    const transItems = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "translation");
    const one = scoreDimensions(DIAGNOSTIC_ITEMS, [answerFor(transItems[0], true)]).find(
      (r) => r.dimension === "translation",
    )!;
    expect(one.status).toBe("assessed");
    expect(one.mastery).not.toBe("unknown");
  });
});

describe("置信度与等级阈值", () => {
  it("toConfidence 按有效题量分级", () => {
    expect(toConfidence(0, 0)).toBe("low");
    expect(toConfidence(2, 0)).toBe("low");
    expect(toConfidence(3, 0)).toBe("medium");
    expect(toConfidence(5, 0)).toBe("medium");
    expect(toConfidence(6, 0)).toBe("high");
  });

  it("toMastery 由 status 决定结论存在性，而不是由 confidence 决定", () => {
    // assessed ⇒ 给出方向性等级（即使 confidence 为 low）
    expect(toMastery(95, "assessed")).toBe("strong");
    expect(toMastery(30, "assessed")).toBe("weak");
    expect(toMastery(50, "assessed")).toBe("developing");
    expect(toMastery(70, "assessed")).toBe("solid");
    expect(toMastery(85, "assessed")).toBe("strong");
    // 未评估 / 证据不足 ⇒ 不下结论
    expect(toMastery(95, "unassessed")).toBe("unknown");
    expect(toMastery(95, "insufficient_evidence")).toBe("unknown");
    expect(toMastery(10, "unassessed")).toBe("unknown");
  });
});

describe("词汇对计分模块的影响", () => {
  it("仅影响阅读、写作、翻译，不影响听力", () => {
    const results = scoreDimensions(
      DIAGNOSTIC_ITEMS,
      DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => answerFor(i, false)),
    );
    const before = new Map(results.map((r) => [r.dimension, r.adjustedScore]));
    const after = applyVocabularyInfluence(results);
    const listeningBefore = before.get("listening")!;
    const listeningAfter = after.find((r) => r.dimension === "listening")!.adjustedScore;
    expect(listeningAfter).toBe(listeningBefore);

    const readingBefore = before.get("reading")!;
    const readingAfter = after.find((r) => r.dimension === "reading")!.adjustedScore;
    // 全错时词汇分数低于阅读的收缩值，因此阅读应被拉低
    expect(readingAfter).toBeLessThanOrEqual(readingBefore);
  });

  it("词汇置信度不足时不施加影响", () => {
    const item = DIAGNOSTIC_ITEMS.find((i) => i.dimension === "reading")!;
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, [answerFor(item, false)]);
    const after = applyVocabularyInfluence(results);
    expect(after).toEqual(results);
  });
});

describe("deriveWeaknesses", () => {
  it("低置信度维度不产生弱项结论", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "writing").map((i) => answerFor(i, false));
    const weaknesses = deriveWeaknesses(scoreDimensions(DIAGNOSTIC_ITEMS, answers));
    expect(weaknesses.find((w) => w.dimension === "writing")).toBeUndefined();
  });

  it("表现良好的维度不产生弱项", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.dimension === "vocabulary").map((i) => answerFor(i, true));
    const weaknesses = deriveWeaknesses(scoreDimensions(DIAGNOSTIC_ITEMS, answers));
    expect(weaknesses.find((w) => w.dimension === "vocabulary")).toBeUndefined();
  });

  it("薄弱维度产生带 severity 和受影响模块的弱项", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => answerFor(i, false));
    const results = applyVocabularyInfluence(scoreDimensions(DIAGNOSTIC_ITEMS, answers));
    const weaknesses = deriveWeaknesses(results);
    expect(weaknesses.length).toBeGreaterThan(0);
    expect(weaknesses[0].severity).toBeGreaterThanOrEqual(1);
    expect(weaknesses[0].source).toBe("diagnostic");
    expect(weaknesses[0].detail.length).toBeGreaterThan(10);
    const vocabWeakness = weaknesses.find((w) => w.dimension === "vocabulary");
    if (vocabWeakness) {
      expect(vocabWeakness.affectedSkills).toContain("reading");
    }
  });

  it("按 severity 降序排列", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => answerFor(i, false));
    const weaknesses = deriveWeaknesses(applyVocabularyInfluence(scoreDimensions(DIAGNOSTIC_ITEMS, answers)));
    for (let i = 1; i < weaknesses.length; i += 1) {
      expect(weaknesses[i - 1].severity).toBeGreaterThanOrEqual(weaknesses[i].severity);
    }
  });
});

describe("deriveRecommendations", () => {
  it("权重总和为 1", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => answerFor(i, false));
    const recs = deriveRecommendations(applyVocabularyInfluence(scoreDimensions(DIAGNOSTIC_ITEMS, answers)));
    const total = recs.reduce((sum, r) => sum + r.weight, 0);
    expect(total).toBeCloseTo(1, 3);
  });

  it("只输出四个计分模块，不含词汇", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => answerFor(i, false));
    const recs = deriveRecommendations(applyVocabularyInfluence(scoreDimensions(DIAGNOSTIC_ITEMS, answers)));
    expect(recs.map((r) => r.skill).sort()).toEqual(["listening", "reading", "translation", "writing"]);
  });

  it("薄弱模块的权重高于同一模块在全部稳固情形下的权重", () => {
    // 用构造的维度结果直接测试函数，避免"全员薄弱"这种退化输入
    // （全员薄弱时相对权重恰好回到官方比例，这是正确行为，但不适合验证加权方向）
    const mixed = deriveRecommendations([
      dimensionResult("listening", 78),
      dimensionResult("reading", 75),
      dimensionResult("writing", 72),
      dimensionResult("translation", 32),
    ]);
    const allStrong = deriveRecommendations([
      dimensionResult("listening", 78),
      dimensionResult("reading", 75),
      dimensionResult("writing", 72),
      dimensionResult("translation", 74),
    ]);

    const mixedTranslation = mixed.find((r) => r.skill === "translation")!;
    const strongTranslation = allStrong.find((r) => r.skill === "translation")!;

    expect(mixedTranslation.weight).toBeGreaterThan(strongTranslation.weight);
    expect(mixedTranslation.priority).toBe("core");
    expect(mixedTranslation.reason).toContain("偏弱");

    // 未被判定为薄弱的模块权重不超过官方基准：
    // 加权额度来自归一化稀释，不是从其他模块额外扣走，
    // 因此"证据不足的模块拿到更多时间"这种情况不会发生。
    for (const skill of ["listening", "reading", "writing"] as const) {
      expect(mixed.find((r) => r.skill === skill)!.weight, skill).toBeLessThanOrEqual(
        SKILL_WEIGHTS[skill] + 0.0001,
      );
    }
  });

  it("无薄弱模块时直接采用官方分值权重", () => {
    const recs = deriveRecommendations([
      dimensionResult("listening", 78),
      dimensionResult("reading", 75),
      dimensionResult("writing", 72),
      dimensionResult("translation", 74),
    ]);
    for (const skill of ["listening", "reading", "writing", "translation"] as const) {
      const rec = recs.find((r) => r.skill === skill)!;
      expect(rec.weight, skill).toBeCloseTo(SKILL_WEIGHTS[skill], 4);
      expect(rec.priority, skill).toBe("recommended");
    }
  });

  it("证据不足的模块不超过官方基准权重", () => {
    // 只有翻译有中等置信度且薄弱，其余维度证据不足
    const recs = deriveRecommendations([
      dimensionResult("translation", 30),
      dimensionResult("listening", 50, "low"),
      dimensionResult("reading", 50, "low"),
      dimensionResult("writing", 50, "low"),
    ]);
    for (const skill of ["listening", "reading", "writing"] as const) {
      const rec = recs.find((r) => r.skill === skill)!;
      expect(rec.weight, skill).toBeLessThanOrEqual(SKILL_WEIGHTS[skill] + 0.0001);
    }
    const translation = recs.find((r) => r.skill === "translation")!;
    expect(translation.weight).toBeGreaterThan(SKILL_WEIGHTS.translation);
  });

  it("训练权重合计始终为 1（归一化正确）", () => {
    // 用确定性的交替模式而不是随机数 —— 评分链路必须可复现，测试也不该引入随机性
    const modes = [
      { name: "all-wrong", pick: () => false },
      { name: "all-right", pick: () => true },
      { name: "alternating", pick: (i: number) => i % 2 === 0 },
      { name: "every-third", pick: (i: number) => i % 3 === 0 },
    ];

    for (const mode of modes) {
      const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i, index) =>
        answerFor(i, mode.pick(index)),
      );
      const recs = deriveRecommendations(
        applyVocabularyInfluence(scoreDimensions(DIAGNOSTIC_ITEMS, answers)),
      );
      const total = recs.reduce((sum, r) => sum + r.weight, 0);
      expect(total, mode.name).toBeCloseTo(1, 3);
    }
  });

  it("所有 reason 都非空，且不包含分数预测表述", () => {
    const answers = DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => answerFor(i, true));
    const recs = deriveRecommendations(applyVocabularyInfluence(scoreDimensions(DIAGNOSTIC_ITEMS, answers)));
    for (const rec of recs) {
      expect(rec.reason.length).toBeGreaterThan(0);
      expect(rec.reason).not.toMatch(/预测|预计能考|\d{3}\s*分/);
    }
  });
});

describe("unassessed（未评估）语义 —— Finding 2 回归", () => {
  const unassessedListening: DimensionResult = dimensionResult("listening", 0, "low", "unassessed");

  it("缺少有效测量手段的维度直接得到 unassessed，且不含任何能力结论", () => {
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, []);
    const listening = results.find((r) => r.dimension === "listening")!;
    expect(listening.status).toBe("unassessed");
    expect(listening.mastery).toBe("unknown");
    expect(listening.gradedItems).toBe(0);
    expect(listening.unassessedReason).toBeTruthy();
    expect(listening.unassessedReason!.length).toBeGreaterThan(20);
  });

  it("IPA 辨词题全对也不能让听力变成已评估", () => {
    // 找到原 IPA 题（现属 vocabulary），全部答对
    const phonetic = DIAGNOSTIC_ITEMS.filter((i) => i.tags.includes("vocabulary.phonetic_recognition"));
    const answers = phonetic.map((i) => answerFor(i, true));
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, answers);

    const listening = results.find((r) => r.dimension === "listening")!;
    // 关键断言：音形能力正确无损于听力——听力依然是 unassessed
    expect(listening.status).toBe("unassessed");
    expect(listening.gradedItems).toBe(0);

    // 而词汇应当因此得到真实证据
    const vocabulary = results.find((r) => r.dimension === "vocabulary")!;
    expect(vocabulary.status).toBe("assessed");
    expect(vocabulary.gradedItems).toBe(phonetic.length);
  });

  it("unassessed 不产生弱项结论", () => {
    const results: DimensionResult[] = [
      unassessedListening,
      dimensionResult("reading", 30), // 真实弱项
    ];
    const weaknesses = deriveWeaknesses(results);
    expect(weaknesses.some((w) => w.dimension === "listening")).toBe(false);
    expect(weaknesses.some((w) => w.dimension === "reading")).toBe(true);
  });

  it("unassessed 不获得加权，权重停在官方基准", () => {
    const results: DimensionResult[] = [
      unassessedListening,
      dimensionResult("reading", 75),
      dimensionResult("writing", 72),
      dimensionResult("translation", 70),
    ];
    const recs = deriveRecommendations(results);
    const listening = recs.find((r) => r.skill === "listening")!;
    expect(listening.weight).toBeCloseTo(SKILL_WEIGHTS.listening, 3);
    expect(listening.priority).toBe("recommended");
    expect(listening.reason).toContain("尚未评估");
    // 权重合计仍为 1
    expect(recs.reduce((s, r) => s + r.weight, 0)).toBeCloseTo(1, 3);
  });

  it("unassessed 不被读成'最弱'而抢走训练时间", () => {
    // 若把 unassessed 的占位 0 分当作最弱，听力会拿到最高权重。
    // 正确行为：它停在 35% 基准，且不高于任何真实评估模块的加权结果。
    const results: DimensionResult[] = [
      unassessedListening,
      dimensionResult("reading", 25), // 真实弱项，应获得加权
    ];
    const recs = deriveRecommendations(results);
    const listening = recs.find((r) => r.skill === "listening")!;
    const reading = recs.find((r) => r.skill === "reading")!;
    expect(listening.weight).toBeLessThan(reading.weight);
  });

  it("unassessed 生成独立的未评估说明，而不是混进 weaknesses", async () => {
    const { deriveUnassessedNotices } = await import("@/domain/scoring");
    const results: DimensionResult[] = [unassessedListening, dimensionResult("reading", 80)];
    const notices = deriveUnassessedNotices(results);
    expect(notices).toHaveLength(1);
    expect(notices[0].dimension).toBe("listening");
    expect(notices[0].label).toContain("尚未有效评估");
    expect(notices[0].nextStep).toContain("听力");
    // 它必须与 weaknesses 互斥
    const weaknesses = deriveWeaknesses(results);
    expect(weaknesses.every((w) => w.dimension !== "listening")).toBe(true);
  });

  it("词表影响不会给 unassessed 维度填充分数", () => {
    const results: DimensionResult[] = [
      dimensionResult("vocabulary", 90),
      unassessedListening,
      dimensionResult("reading", 40),
    ];
    const influenced = applyVocabularyInfluence(results);
    const listening = influenced.find((r) => r.dimension === "listening")!;
    expect(listening.status).toBe("unassessed");
    expect(listening.adjustedScore).toBe(0);
  });

  it("toSkillStates 对 unassessed 输出 status 而非可用分数", async () => {
    const { toSkillStates } = await import("@/domain/scoring");
    const states = toSkillStates([unassessedListening], 10, "2026-09-26T00:00:00.000Z");
    expect(states.listening.status).toBe("unassessed");
    expect(states.listening.score).toBe(0);
    expect(states.listening.mastery).toBe("unknown");
    expect(states.listening.evidenceCount).toBe(0);
    expect(states.listening.unassessedReason).toBeTruthy();
  });

  it("已评估模块与证据不足模块的 status 区分正确", () => {
    const enoughAnswers = DIAGNOSTIC_ITEMS.filter(
      (i) => i.dimension === "reading" && i.type === "mcq",
    ).map((i) => answerFor(i, true));
    const results = scoreDimensions(DIAGNOSTIC_ITEMS, enoughAnswers);
    expect(results.find((r) => r.dimension === "reading")!.status).toBe("assessed");
    // 完全没作答的写作 → insufficient_evidence，而不是 unassessed
    expect(results.find((r) => r.dimension === "writing")!.status).toBe("insufficient_evidence");
  });
});

describe("gradeWithRubric（本地规则评分）", () => {
  it("匹配到关键词时给出部分分数", () => {
    const result = gradeWithRubric(
      "Tea drinking has a long history in China and reflects daily habit.",
      ["a long history", "tea drinking", "social interaction"],
    );
    expect(result.matched).toContain("a long history");
    expect(result.score).toBeCloseTo(2 / 3, 2);
  });

  it("空作答得 0 分", () => {
    const result = gradeWithRubric("", ["something meaningful"]);
    expect(result.score).toBe(0);
    expect(result.missed).toHaveLength(1);
  });

  it("评分要点极短时按整串匹配，不产生假阳性", () => {
    const result = gradeWithRubric("nothing relevant here", ["the way family life is organised"]);
    expect(result.score).toBe(0);
  });

  it("无评分要点时不抛异常", () => {
    const result = gradeWithRubric("any text", []);
    expect(result.score).toBe(0);
  });
});
