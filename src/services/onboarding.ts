import type { ExamGoal, LearnerProfile, SkillProfile } from "@/domain/models";
import type { Repositories } from "@/repositories/ports";
import { onboardingSchema, type OnboardingFormValues } from "@/lib/validation";
import { CET6_EXAM_DATE, CET6_EXAM_NAME } from "@/domain/exam-facts";

/**
 * Onboarding 服务。
 *
 * ── 预填值是中性默认值，不是某个人的设置 ──
 *
 * 表单需要预填，否则用户面对一排空输入框。早先版本的预填值来自本项目的
 * 第一位使用者：他的目标分与每周时间被写成了应用默认值。那是真实缺陷而非
 * 外观问题 —— 它把一个人的学习计划当成所有人的起点，也把个人数据写进了
 * 公开源码。
 *
 * 现在只预填真正共享的东西：考试日期与名称来自 `@/domain/exam-facts`
 * （单一事实来源）。其余字段刻意留空或取中性值，由使用者自己填写。
 */

export const DEFAULT_ONBOARDING = {
  /**
   * 中性占位称呼，不是任何真实姓名。
   *
   * 不能留空：`onboardingSchema` 要求至少一个字符，空值会让表单永远无法提交
   * （实测：浏览器 E2E 全部卡在等跳转到 /diagnostic）。也不能沿用第一位使用者的
   * 称呼 —— 那会把一个人的身份当成所有安装的默认值。
   */
  displayName: "学习者",
  examName: CET6_EXAM_NAME,
  examDate: CET6_EXAM_DATE,
  /** 中性起点值，不是某个人的目标。schema 要求正整数。 */
  targetScore: 500,
  /** 工作日分钟数的中性起点，使用者可改。 */
  weekdayMinutes: 60,
  /** 周末分钟数的中性起点，使用者可改。 */
  weekendMinutes: 120,
} as const;

export interface OnboardingState {
  onboarded: boolean;
  profile: LearnerProfile | null;
  goal: ExamGoal | null;
  skillProfile: SkillProfile | null;
}

export function getOnboardingState(repos: Repositories): OnboardingState {
  const profile = repos.learner.getProfile();
  if (!profile) {
    return { onboarded: false, profile: null, goal: null, skillProfile: null };
  }
  return {
    onboarded: true,
    profile,
    goal: repos.learner.getGoal(profile.id),
    skillProfile: repos.skillProfile.get(profile.id),
  };
}

export type OnboardingResult =
  | { ok: true; profile: LearnerProfile; goal: ExamGoal }
  | { ok: false; error: string };

export function completeOnboarding(
  repos: Repositories,
  raw: OnboardingFormValues,
): OnboardingResult {
  const parsed = onboardingSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join("；") };
  }
  const values = parsed.data;

  const existing = repos.learner.getProfile();
  const profile = repos.learner.saveProfile(existing?.id ?? null, {
    displayName: values.displayName,
    preferences: {
      weekdayMinutes: values.weekdayMinutes,
      weekendMinutes: values.weekendMinutes,
    },
    examName: values.examName,
    examDate: values.examDate,
    targetScore: values.targetScore,
  });

  const goal = repos.learner.saveGoal(profile.id, {
    examName: values.examName,
    examDate: values.examDate,
    targetScore: values.targetScore,
  });

  return { ok: true, profile, goal };
}

export function updateGoal(
  repos: Repositories,
  profileId: string,
  patch: { examName: string; examDate: string; targetScore: number },
): OnboardingResult {
  const existing = repos.learner.getProfile();
  if (!existing) return { ok: false, error: "尚未完成 onboarding" };
  const goal = repos.learner.updateGoal(profileId, patch);
  return { ok: true, profile: existing, goal };
}

export function updatePreferences(
  repos: Repositories,
  profileId: string,
  preferences: { weekdayMinutes: number; weekendMinutes: number },
): LearnerProfile {
  return repos.learner.updatePreferences(profileId, preferences);
}
