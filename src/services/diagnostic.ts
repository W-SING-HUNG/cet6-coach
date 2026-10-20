import { DIAGNOSTIC_ITEMS } from "@/content/diagnostic-bank";
import {
  applyVocabularyInfluence,
  deriveRecommendations,
  deriveUnassessedNotices,
  deriveWeaknesses,
  scoreDimensions,
  toSkillStates,
} from "@/domain/scoring";
import type { DiagnosticItem, DiagnosticSession } from "@/domain/models";
import type { Repositories } from "@/repositories/ports";
import { nowISO } from "@/lib/date";
import type { DiagnosticAnswerInput } from "@/types/actions";

/**
 * 诊断服务。
 *
 * 流程：创建 session → 保存作答 → 计分 → 写能力画像 → 生成今日计划。
 * 计划在诊断完成时立即生成，因为一条真实的产品路径必须"做完诊断就看到今天该做什么"。
 */

export interface DiagnosticQuestionView {
  item: DiagnosticItem;
  index: number;
  total: number;
}

export function getDiagnosticItems(): DiagnosticItem[] {
  return DIAGNOSTIC_ITEMS;
}

export function findItem(itemId: string): DiagnosticItem | null {
  return DIAGNOSTIC_ITEMS.find((item) => item.id === itemId) ?? null;
}

/** 诊断总时长估算，用于 onboarding 之后告知用户要花多久。 */
export function estimateDiagnosticMinutes(): number {
  const seconds = DIAGNOSTIC_ITEMS.reduce((sum, item) => sum + item.estimatedSeconds, 0);
  return Math.max(1, Math.round(seconds / 60));
}

export function startDiagnostic(repos: Repositories, profileId: string): DiagnosticSession {
  const itemIds = DIAGNOSTIC_ITEMS.map((item) => item.id);
  return repos.diagnostic.createSession(profileId, itemIds);
}

export function getSession(repos: Repositories, sessionId: string): DiagnosticSession | null {
  return repos.diagnostic.getSession(sessionId);
}

export interface SubmitDiagnosticResult {
  ok: true;
  sessionId: string;
}

export interface SubmitDiagnosticError {
  ok: false;
  error: string;
}

/**
 * 提交诊断并落库。
 *
 * 注意：dimensionResults / weaknesses / recommendations **不落库**，
 * 它们在读取时由确定性规则从原始作答重算。这样做的原因：
 * 避免"规则改了但库里的旧结论没更新"这类静默不一致。
 */
export function submitDiagnostic(
  repos: Repositories,
  input: { sessionId: string; answers: DiagnosticAnswerInput[] },
): SubmitDiagnosticResult | SubmitDiagnosticError {
  const session = repos.diagnostic.getSession(input.sessionId);
  if (!session) {
    return { ok: false, error: "诊断会话不存在，可能已被清理。请重新开始诊断。" };
  }

  const validAnswers = input.answers.filter((answer) => findItem(answer.itemId) !== null);
  if (validAnswers.length === 0) {
    return { ok: false, error: "没有有效的作答内容。" };
  }

  const timestamp = nowISO();
  repos.diagnostic.saveAnswers(
    session.id,
    validAnswers.map((answer) => ({
      itemId: answer.itemId,
      dimension: answer.dimension,
      choiceId: answer.choiceId,
      text: answer.text,
      skipped: answer.skipped,
      submittedAt: timestamp,
    })),
  );

  const graded = gradeSession(repos, session.id);
  if (!graded) {
    return { ok: false, error: "诊断评分失败。" };
  }

  return { ok: true, sessionId: session.id };
}

/**
 * 从落库的作答计算完整结论并写入能力画像。
 * 这是唯一会更新 skill_profile 的地方，保证画像与作答始终一致。
 */
export function gradeSession(repos: Repositories, sessionId: string) {
  const session = repos.diagnostic.getSession(sessionId);
  if (!session) return null;

  const answers = session.answers;
  const results = scoreDimensions(DIAGNOSTIC_ITEMS, answers);
  const influenced = applyVocabularyInfluence(results);
  const weaknesses = deriveWeaknesses(influenced);
  const recommendations = deriveRecommendations(influenced);
  // 未评估模块单独成列：它是"重要但尚未测量"，不是弱项，不允许混入 weaknesses
  const unassessedNotices = deriveUnassessedNotices(influenced);

  const answeredCount = answers.filter((a) => !a.skipped).length;
  const partial = answeredCount < DIAGNOSTIC_ITEMS.length;

  const timestamp = nowISO();
  const skills = toSkillStates(influenced, answeredCount, timestamp);

  repos.diagnostic.completeSession(sessionId, {
    results: results.flatMap((r) => r.evidence),
    dimensionResults: influenced,
    weaknesses,
    recommendations,
    partial,
  });

  const profile = repos.skillProfile.save(session.profileId, {
    skills,
    dimensions: influenced,
    weaknesses,
    recommendations,
    unassessedNotices,
    basedOnDiagnosticId: sessionId,
  });

  return {
    sessionId,
    dimensionResults: influenced,
    weaknesses,
    unassessedNotices,
    recommendations,
    skills,
    profile,
    partial,
  };
}

export type DiagnosticOutcome = NonNullable<ReturnType<typeof gradeSession>>;

/**
 * 读取诊断结果。优先从 skill_profile 读取（那是唯一权威），
 * 但维度明细按当前规则从作答重算，避免历史结果与当前规则不一致。
 */
export function getDiagnosticOutcome(repos: Repositories, profileId: string): DiagnosticOutcome | null {
  const profile = repos.skillProfile.get(profileId);
  if (!profile || !profile.basedOnDiagnosticId) return null;
  return gradeSession(repos, profile.basedOnDiagnosticId);
}
