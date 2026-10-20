import type {
  ConfidenceLevel,
  DiagnosticAnswer,
  DiagnosticItem,
  DimensionResult,
  Recommendation,
  SkillState,
  Weakness,
} from "./models";
import {
  DIAGNOSTIC_DIMENSIONS,
  DIMENSION_EVIDENCE_REQUIREMENTS,
  DIMENSION_LABELS,
  SKILL_WEIGHTS,
  VOCABULARY_FEEDS,
  isValidlyAssessable,
  type AssessmentStatus,
  type DiagnosticDimension,
  type MasteryLevel,
  type Skill,
} from "./types";

/**
 * 诊断评分规则。全部为确定性纯函数 —— 无随机、无时间依赖，便于单测。
 *
 * 诚实性约束：
 * - 本模块只输出"本次诊断表现"的稳健估计，不产生 CET 预测分。
 * - 证据不足时强制降级 confidence 并把分数收缩向 50，避免把 3 道题的偶然结果当成能力结论。
 */

/** 每个维度至少需要多少道有效题才算"中等置信"。 */
const CONFIDENCE_ITEM_THRESHOLDS = { low: 0, medium: 3, high: 6 } as const;

/**
 * 贝叶斯式收缩：把观测正确率向先验 0.5 拉，n 越大越信任观测值。
 *
 * 取值 1.6 是刻意的：它让 5 题全对收敛到 88 分左右（而不是满分），
 * 因为 5 道题本身不足以证明"稳固"；同时不会强到把真实的高分表现压成平庸。
 * 这个常数只影响估计的保守程度，不影响排序方向。
 */
const PRIOR_STRENGTH = 1.6;

/** 主观题及格阈值：覆盖一半以上评分要点视为达标。 */
export const RUBRIC_PASS_THRESHOLD = 0.5;

export function scoreChoiceItem(item: DiagnosticItem, answer: DiagnosticAnswer | undefined): {
  correct: boolean | null;
  earned: number;
  max: number;
  skipped: boolean;
} {
  const max = 1;
  if (!answer || answer.skipped) {
    return { correct: null, earned: 0, max, skipped: true };
  }
  if (item.type === "mcq") {
    const correct = answer.choiceId !== null && answer.choiceId === item.correctChoiceId;
    return { correct, earned: correct ? 1 : 0, max, skipped: false };
  }
  if (item.type === "short_text") {
    const text = (answer.text ?? "").trim();
    // 留空等于未作答，按"证据不足"处理，与主动跳过同等对待
    if (text.length === 0) {
      return { correct: null, earned: 0, max, skipped: true };
    }
    // 主观题走本地 rubric 评分（确定性关键词覆盖），支持部分得分。
    // 它衡量"评分要点是否被覆盖"，不衡量表达质量 —— 这一限制在 UI 中如实标注。
    const rubric = gradeWithRubric(text, item.rubricPoints ?? []);
    return {
      correct: rubric.score >= RUBRIC_PASS_THRESHOLD,
      earned: rubric.score,
      max,
      skipped: false,
    };
  }
  // pending_media 等尚无执行方式的题型：不产生分数，也不算答错
  return { correct: null, earned: 0, max, skipped: false };
}

/**
 * 主观题 / 训练题的 rubric 打分。
 * 通过关键词覆盖率估算，属于确定性本地规则，**不是 AI 批改**。
 * 结果会带 `local-rubric` 标记，UI 不得把它呈现为 AI 结论。
 */
export function gradeWithRubric(
  text: string,
  rubricPoints: string[],
): { score: number; matched: string[]; missed: string[] } {
  const normalized = text.toLowerCase();
  const matched: string[] = [];
  const missed: string[] = [];
  for (const point of rubricPoints) {
    const keywords = point
      .toLowerCase()
      .split(/[^a-z0-9']+/i)
      .filter((token) => token.length >= 4);
    const hit = keywords.length === 0 ? false : keywords.some((token) => normalized.includes(token));
    if (hit) {
      matched.push(point);
    } else {
      missed.push(point);
    }
  }
  const total = rubricPoints.length || 1;
  return { score: matched.length / total, matched, missed };
}

/**
 * 由分数得出**方向性**等级。这是"表现落在哪一档"，不含证据量判断。
 * 证据量由 `AssessmentStatus` 表达，两者刻意分离（见 types.ts 的语义契约）。
 */
export function masteryFromScore(adjustedScore: number): MasteryLevel {
  if (adjustedScore < 40) return "weak";
  if (adjustedScore < 58) return "developing";
  if (adjustedScore < 78) return "solid";
  return "strong";
}

/**
 * 唯一的主等级入口。
 *
 * 不变式（tests/diagnostic-semantics.test.ts 守护）：
 * - `assessed` ⇒ mastery ≠ unknown（有方向性结论）
 * - `insufficient_evidence` / `unassessed` ⇒ mastery = unknown（不下结论）
 *
 * 旧实现用 `confidence === "low"` 强制返回 unknown，导致
 * `assessed + low confidence ⇒ mastery unknown` 这一自相矛盾的状态：
 * 系统同时断言"已评估"和"信息不足"。现在 confidence 只描述估计的宽窄，
 * 不再决定"有没有结论"。
 */
export function toMastery(adjustedScore: number, status: AssessmentStatus): MasteryLevel {
  if (status !== "assessed") return "unknown";
  return masteryFromScore(adjustedScore);
}

/**
 * 一致性自检：状态与等级是否矛盾。
 * 供测试与开发期断言使用，不参与生产分支。
 */
export function isCoherentAssessment(status: AssessmentStatus, mastery: MasteryLevel): boolean {
  if (status === "assessed") return mastery !== "unknown";
  return mastery === "unknown";
}

export function toConfidence(gradedItems: number, skipped: number): ConfidenceLevel {
  const effective = gradedItems - Math.min(skipped, gradedItems);
  if (effective >= CONFIDENCE_ITEM_THRESHOLDS.high) return "high";
  if (effective >= CONFIDENCE_ITEM_THRESHOLDS.medium) return "medium";
  return "low";
}

/**
 * 按该维度的实际测量设计判定证据是否充足。
 *
 * 不使用跨维度统一的题量阈值 —— 写作的测量单位是"一篇作文"（1 个样本即完整），
 * 词汇是"多道客观题"（需跨越单一考点）。要求定义在 DIMENSION_EVIDENCE_REQUIREMENTS。
 *
 * 缺少有效测量工具的维度（如无音频的听力）恒返回 false：
 * 不存在"样本数够多就能测出听力理解"的情形，因为缺的是**工具**而不是样本量。
 */
export function hasSufficientEvidence(dimension: DiagnosticDimension, gradedItems: number): boolean {
  if (!isValidlyAssessable(dimension)) return false;
  const requirement = DIMENSION_EVIDENCE_REQUIREMENTS[dimension];
  return gradedItems >= requirement.minValidItems;
}

/**
 * 未评估维度的说明文案。
 * 必须解释"缺什么"，而不是让用户以为系统坏了或以为自己很差。
 */
const UNASSESSED_REASONS: Partial<Record<DiagnosticDimension, string>> = {
  listening:
    "CET-6 听力考的是长对话、篇章与讲座的音频理解，需要真实音频刺激才能测量。" +
    "当前没有音频素材，因此听力尚未有效评估 —— 这既不是低分，也不是高分。",
};

export function scoreDimensions(
  items: DiagnosticItem[],
  answers: DiagnosticAnswer[],
): DimensionResult[] {
  const answerByItem = new Map(answers.map((a) => [a.itemId, a]));

  return DIAGNOSTIC_DIMENSIONS.map((dimension) => {
    const dimensionItems = items.filter((i) => i.dimension === dimension);
    const evidence = dimensionItems.map((item) => {
      const answer = answerByItem.get(item.id);
      const graded = scoreChoiceItem(item, answer);
      return {
        itemId: item.id,
        dimension,
        correct: graded.correct,
        earnedPoints: graded.earned,
        maxPoints: graded.max,
        skipped: graded.skipped,
      };
    });

    const graded = evidence.filter((e) => !e.skipped && e.correct !== null);
    const skippedItems = evidence.filter((e) => e.skipped).length;
    const earned = graded.reduce((sum, e) => sum + e.earnedPoints, 0);
    const maxPoints = graded.reduce((sum, e) => sum + e.maxPoints, 0);
    const rawScore = maxPoints === 0 ? 0 : Math.round((earned / maxPoints) * 100);

    // 缺少有效测量工具 → 直接返回 unassessed。
    // 此时 score / mastery / confidence 一律不构成能力结论，
    // 尤其不能因为"没做过"就落到 low confidence 再被读成"弱项"。
    if (!isValidlyAssessable(dimension)) {
      return {
        dimension,
        rawScore: 0,
        adjustedScore: 0,
        mastery: "unknown" as MasteryLevel,
        confidence: "low" as ConfidenceLevel,
        status: "unassessed" as AssessmentStatus,
        unassessedReason: UNASSESSED_REASONS[dimension] ?? "该维度当前缺少有效测量手段。",
        gradedItems: 0,
        skippedItems,
        evidence,
      };
    }

    const status: AssessmentStatus = hasSufficientEvidence(dimension, graded.length)
      ? "assessed"
      : "insufficient_evidence";
    const confidence = toConfidence(graded.length, skippedItems);
    // 收缩估计：低证据时结果向 50 靠拢，防止小样本噪声当成能力。
    const adjustedRatio = (earned + PRIOR_STRENGTH * 0.5) / (maxPoints + PRIOR_STRENGTH);
    const adjustedScore = Math.round(adjustedRatio * 100);

    return {
      dimension,
      rawScore,
      adjustedScore,
      mastery: toMastery(adjustedScore, status),
      confidence,
      status,
      unassessedReason: null,
      gradedItems: graded.length,
      skippedItems,
      evidence,
    };
  });
}

/** 把词汇表现折进依赖词汇的计分模块。词汇权重低于模块自身表现。 */
export function applyVocabularyInfluence(results: DimensionResult[]): DimensionResult[] {
  const vocabulary = results.find((r) => r.dimension === "vocabulary");
  if (!vocabulary || vocabulary.confidence === "low") return results;

  const blend = 0.25;
  return results.map((result) => {
    if (result.dimension === "vocabulary") return result;
    // 未评估维度不得被其他维度的分数"填充" —— 它必须保持 unassessed
    if (result.status === "unassessed") return result;
    if (!VOCABULARY_FEEDS.includes(result.dimension as Skill)) return result;
    const blended = Math.round(result.adjustedScore * (1 - blend) + vocabulary.adjustedScore * blend);
    return {
      ...result,
      adjustedScore: blended,
      // 词汇影响只调整分数，不改变该维度自身的评估状态与结论存在性
      mastery: toMastery(blended, result.status),
    };
  });
}

const WEAKNESS_COPY: Record<
  DiagnosticDimension,
  { label: string; detail: (score: number) => string }
> = {
  vocabulary: {
    label: "词汇量与词义辨析",
    detail: (s) =>
      `本次诊断词汇正确率约 ${s}%。词汇是阅读、翻译、写作的共同前置能力，优先补词汇的边际收益最高。`,
  },
  listening: {
    label: "听力信息抓取",
    detail: (s) =>
      `本次诊断听力正确率约 ${s}%。听力占卷面 35%，是权重最高的两个模块之一，需要固定频次训练。`,
  },
  reading: {
    label: "阅读定位与长难句",
    detail: (s) =>
      `本次诊断阅读正确率约 ${s}%。阅读同样占 35%，需重点训练段落主旨定位与长难句拆解。`,
  },
  writing: {
    label: "写作结构与表达",
    detail: (s) => `本次诊断写作表现约 ${s}%。建议先固定文章结构模板，再补句式和衔接表达。`,
  },
  translation: {
    label: "翻译句式转换",
    detail: (s) => `本次诊断翻译表现约 ${s}%。问题多集中在中文流水句如何切分为英文从句结构。`,
  },
};

/**
 * 未评估维度的说明条目（不是弱项）。
 *
 * 产品需要能表达"重要但尚未测量"，这与"你的听力很弱"是完全不同的结论。
 * 因此它走独立字段，不混进 weaknesses 数组 —— 一旦混进去，
 * 下游（planner 加权、UI 红色警示、进度统计）都会把它当成问题处理。
 */
export interface UnassessedNotice {
  dimension: DiagnosticDimension;
  affectedSkills: Skill[];
  label: string;
  detail: string;
  /** 后续需要什么才能建立测量 */
  nextStep: string;
}

export function deriveUnassessedNotices(results: DimensionResult[]): UnassessedNotice[] {
  return results
    .filter((result) => result.status === "unassessed")
    .map((result) => ({
      dimension: result.dimension,
      affectedSkills: [result.dimension as Skill],
      label: `${DIMENSION_LABELS[result.dimension]}尚未有效评估`,
      detail: result.unassessedReason ?? "该维度当前缺少有效测量手段。",
      nextStep:
        "完成正式听力诊断（需要音频素材）后，这里会更新为真实的测量结果与置信度。",
    }));
}

export function deriveWeaknesses(results: DimensionResult[]): Weakness[] {
  const weaknesses: Weakness[] = [];
  for (const result of results) {
    // 门只由 status 把守，不由 confidence 把守。
    //
    // 为什么（与三态契约保持一致）：一旦判定为 assessed，就表示"证据已足够支撑方向性结论"。
    // 此时若因 confidence 低而拒绝生成弱项，会出现自相矛盾的表现：
    // 维度卡片给出 mastery="weak" 的结论，弱项列表却说"没有识别到弱项"。
    // 低置信度只影响结论的确定性措辞，不影响结论是否存在。
    // 证据不足的风险已由上游的充分性判定（insufficient_evidence / unassessed）拦住了。
    if (result.status !== "assessed") continue;
    if (result.adjustedScore >= 65) continue;
    const copy = WEAKNESS_COPY[result.dimension];
    const severity = result.adjustedScore < 40 ? 3 : result.adjustedScore < 55 ? 2 : 1;
    const affectedSkills: Skill[] =
      result.dimension === "vocabulary" ? VOCABULARY_FEEDS : [result.dimension as Skill];
    // 低置信度的弱项保留，但在文案中标注证据强度，避免被当成定论
    const evidenceNote =
      result.confidence === "low" ? "（样本较少，方向性提示）" : "";
    weaknesses.push({
      id: `diag:${result.dimension}`,
      dimension: result.dimension,
      affectedSkills,
      label: copy.label,
      detail: `${copy.detail(result.adjustedScore)}${evidenceNote}`,
      severity,
      source: "diagnostic",
    });
  }
  return weaknesses.sort((a, b) => b.severity - a.severity);
}

/**
 * 初始训练权重。
 *
 * 基准权重取 CET-6 官方分值（听力 35% / 阅读 35% / 写作 15% / 翻译 15%）。
 *
 * 规则刻意保持两条，且有明确理由：
 * 1. **只有被判定为薄弱的模块获得加权**；稳固和证据不足的模块一律停在官方基准。
 * 2. 加权后的总额必然大于 1，最后统一归一化 —— 也就是说，薄弱的模块拿到的额度
 *    来自所有模块的等比稀释，而不是从"强项"身上额外扣走。
 *
 * 为什么不做"强项倒扣"（实测后修正）：倒扣后再归一化会把额度漏给**完全没有证据**的模块，
 * 数学上权重和仍为 1，语义上却是凭空加权。现在证据不足的模块权重恒 ≤ 官方基准，
 * 没有任何数据支撑的模块不会因为别人表现好而获得更多训练时间。
 */
export function deriveRecommendations(results: DimensionResult[]): Recommendation[] {
  const skillResult = new Map<Skill, DimensionResult>();
  for (const result of results) {
    if (result.dimension === "vocabulary") continue;
    skillResult.set(result.dimension as Skill, result);
  }

  const skills = Object.keys(SKILL_WEIGHTS) as Skill[];
  const weak = new Set<Skill>();
  const raw = new Map<Skill, number>();

  for (const skill of skills) {
    const base = SKILL_WEIGHTS[skill];
    const result = skillResult.get(skill);

    // 未评估 / 证据不足：停在官方基准权重。
    // 关键约束：不得把"未知"读成"最差"而加权 —— 那会把 35% 的时间
    // 押在一个从未测量过的模块上，也会让用户以为听力已经被判定为弱项。
    if (!result || result.status === "unassessed" || result.confidence === "low") {
      raw.set(skill, base);
      continue;
    }

    const gap = 60 - result.adjustedScore;
    if (gap > 0) {
      weak.add(skill);
      raw.set(skill, base * (1 + Math.min(gap / 100, 0.5)));
    } else {
      raw.set(skill, base);
    }
  }

  const total = [...raw.values()].reduce((a, b) => a + b, 0) || 1;

  return skills
    .map((skill) =>
      buildRecommendation(skill, raw.get(skill)! / total, skillResult.get(skill), weak.has(skill)),
    )
    .sort((a, b) => b.weight - a.weight);
}

function buildRecommendation(
  skill: Skill,
  weight: number,
  result: DimensionResult | undefined,
  isWeak: boolean,
): Recommendation {
  const base = SKILL_WEIGHTS[skill];
  let reason: string;
  if (result?.status === "unassessed") {
    reason =
      `该模块占卷面 ${Math.round(base * 100)}%，但当前缺少有效测量手段，尚未评估。` +
      `先按官方权重保留时间，等正式诊断后可再调整。`;
  } else if (!result || result.confidence === "low") {
    reason = `证据不足，先按官方分值权重（${Math.round(base * 100)}%）建立基线。`;
  } else if (isWeak) {
    reason = `诊断显示该模块偏弱（${result.adjustedScore}）且占卷面 ${Math.round(base * 100)}%，提高训练占比。`;
  } else {
    reason = `诊断显示该模块相对稳固（${result.adjustedScore}），保持官方权重做维持性训练。`;
  }
  return {
    skill,
    dimension: skill as DiagnosticDimension,
    reason,
    weight: Number(weight.toFixed(4)),
    priority: isWeak ? ("core" as const) : ("recommended" as const),
  };
}

/**
 * 把维度结果折算成四个计分模块的能力状态。
 *
 * `unassessed` 模块的 score 仅作占位（不参与任何比较），
 * 由 status 字段承载真实语义 —— 这样 UI 与 planner 都无法"顺手"拿 score 当结论。
 */
export function toSkillStates(
  results: DimensionResult[],
  evidenceCount: number,
  updatedAt: string,
): Record<Skill, SkillState> {
  const byDim = new Map(results.map((r) => [r.dimension, r]));

  return Object.fromEntries(
    (Object.keys(SKILL_WEIGHTS) as Skill[]).map((skill) => {
      const result = byDim.get(skill);
      const status: AssessmentStatus = result?.status ?? "insufficient_evidence";
      const confidence = result?.confidence ?? "low";
      // unassessed 时 score 不构成测量结果，统一记 0 并靠 status 表达语义，
      // 避免"占位 50"被误读为"中等水平"。
      const score = status === "unassessed" ? 0 : (result?.adjustedScore ?? 0);
      const state: SkillState = {
        skill,
        score,
        mastery: toMastery(score, status),
        confidence,
        status,
        unassessedReason: result?.unassessedReason ?? null,
        evidenceCount: status === "unassessed" ? 0 : (result?.gradedItems ?? evidenceCount),
        lastUpdatedAt: updatedAt,
      };
      return [skill, state];
    }),
  ) as Record<Skill, SkillState>;
}
