import { contentRepository, type ContentItem } from "@/content";
import { getGradingProvider } from "@/ai";
import { applyVocabularyInfluence, deriveRecommendations, deriveUnassessedNotices, toMastery } from "@/domain/scoring";
import type { AssessmentStatus } from "@/domain/types";
import type { DimensionResult, StudyTask, Weakness } from "@/domain/models";
import type { Skill } from "@/domain/types";
import type { Repositories } from "@/repositories/ports";
import { addDays, nowISO, todayISO } from "@/lib/date";

/**
 * 训练证据 → 能力画像 的回写。
 *
 * 与诊断的区别：诊断建立初始画像，训练持续修正它。
 * 修正规则是确定性的，且**不覆盖**诊断的 dimension 明细，只在计分模块层面做证据混合。
 */

/** 训练证据的权重上限：不能让几次练习完全推翻一次完整诊断。 */
const PRACTICE_BLEND_WEIGHT = 0.4;

export interface PracticeEvidence {
  skill: Skill;
  correct: number;
  total: number;
}

/**
 * 把训练正确率混合进对应模块的能力估计。
 * @returns 更新后的 skill profile（若无可更新的画像则返回 null）
 */
export function applyPracticeEvidence(repos: Repositories, profileId: string, evidence: PracticeEvidence[]) {
  const profile = repos.skillProfile.get(profileId);
  if (!profile) return null;

  const now = nowISO();
  const skills = { ...profile.skills };
  let touched = false;

  for (const item of evidence) {
    if (item.total === 0) continue;
    const current = skills[item.skill];
    if (!current) continue;
    // 未评估模块不得被训练证据悄悄变成"已评估"：
    // 没有有效测量手段的模块，其证据来源本身就不成立（例如无音频的听力）。
    if (current.status === "unassessed") continue;

    const observed = item.correct / item.total;
    const observedScore = observed * 100;
    const evidenceWeight = Math.min(PRACTICE_BLEND_WEIGHT, item.total / 12);
    const blended = Math.round(current.score * (1 - evidenceWeight) + observedScore * evidenceWeight);

    // 训练证据会让该模块进入 assessed（有真实作答就有方向性结论）。
    // 这与诊断的"证据充足性"不冲突：诊断阈值管的是"一次诊断能否支撑结论"，
    // 而训练证据是持续累积的独立来源，一旦存在就让结论存在。
    const nextStatus: AssessmentStatus = "assessed";

    skills[item.skill] = {
      ...current,
      score: blended,
      mastery: toMastery(blended, nextStatus),
      status: nextStatus,
      confidence: current.confidence === "low" ? "low" : current.confidence,
      evidenceCount: current.evidenceCount + item.total,
      lastUpdatedAt: now,
    };
    touched = true;
  }

  if (!touched) return profile;

  // 重新计算训练权重，使计划真正跟随训练表现变化。
  const dimensionResults: DimensionResult[] = Object.keys(skills).map((key) => {
    const skill = key as Skill;
    const state = skills[skill];
    return {
      dimension: skill,
      rawScore: state.score,
      adjustedScore: state.score,
      mastery: state.mastery,
      confidence: state.confidence,
      status: state.status,
      unassessedReason: state.unassessedReason,
      gradedItems: state.evidenceCount,
      skippedItems: 0,
      evidence: [],
    };
  });

  const influenced = applyVocabularyInfluence(dimensionResults);
  const recommendations = deriveRecommendations(influenced);
  const unassessedNotices = deriveUnassessedNotices(influenced);

  return repos.skillProfile.save(profileId, {
    skills,
    // 保留诊断产生的维度明细：它来自真实诊断题，训练数据不应伪造诊断证据。
    dimensions: profile.dimensions,
    weaknesses: profile.weaknesses,
    recommendations,
    unassessedNotices,
    basedOnDiagnosticId: profile.basedOnDiagnosticId,
  });
}

/**
 * 从错误标签里提炼训练型弱点。
 * 当某个模块的近期错误达到阈值时，追加一条 source: "practice" 的弱点，
 * 下一次生成计划时会通过 recommendations 提高该模块的训练权重。
 */
export function recordPracticeWeaknesses(
  repos: Repositories,
  profileId: string,
  skill: Skill,
  errorTags: string[],
): Weakness[] {
  const profile = repos.skillProfile.get(profileId);
  if (!profile) return [];

  const attempts = repos.records.listRecentAttempts(profileId, 40).filter((a) => !a.correct);
  const tagCounts = new Map<string, number>();
  for (const attempt of attempts) {
    for (const tag of attempt.errorTags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }

  const existing = new Map(profile.weaknesses.map((w) => [w.id, w]));
  let added: Weakness[] = [];

  for (const tag of errorTags) {
    const count = tagCounts.get(tag) ?? 0;
    if (count < 2) continue;
    const id = `practice:${tag}`;
    if (existing.has(id)) continue;
    const weakness: Weakness = {
      id,
      dimension: skill,
      affectedSkills: [skill],
      label: `重复出错：${tag}`,
      detail: `该错因在最近的练习中出现了 ${count} 次。计划已相应提高该模块的训练占比。`,
      severity: count >= 4 ? 3 : 2,
      source: "practice",
    };
    added = [...added, weakness];
  }

  if (added.length === 0) return [];

  repos.skillProfile.save(profileId, {
    skills: profile.skills,
    dimensions: profile.dimensions,
    weaknesses: [...profile.weaknesses, ...added],
    recommendations: profile.recommendations,
    unassessedNotices: profile.unassessedNotices,
    basedOnDiagnosticId: profile.basedOnDiagnosticId,
  });

  return added;
}

/** 把内容素材的时长估算与实际用时对齐，用于 Today 的时间统计。 */
export function estimateContentMinutes(content: ContentItem | null, fallback: number): number {
  if (!content) return fallback;
  return content.estimatedMinutes ?? fallback;
}

/** 错答 → 生成复习项，明天进入复习队列。 */
export function enqueueReviewForWrongAnswer(
  repos: Repositories,
  params: {
    profileId: string;
    contentItemId: string;
    contentRef: StudyTask["contentRef"];
    skill: Skill;
    prompt: string;
    on?: string;
  },
): void {
  const base = params.on ?? todayISO();
  repos.review.upsert({
    profileId: params.profileId,
    contentItemId: params.contentItemId,
    contentRef: params.contentRef ?? { contentType: "review_deck", contentId: params.contentItemId },
    skill: params.skill,
    prompt: params.prompt,
    dueOn: addDays(base, 1),
    stability: 0,
    difficulty: 0,
    reps: 0,
    lapses: 1,
    lastReviewedOn: null,
  });
}

export { contentRepository, getGradingProvider };
