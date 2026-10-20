import { contentRepository, type ContentItem } from "@/content";
import { getGradingProvider } from "@/ai";
import { gradeWithRubric } from "@/domain/scoring";
import type { Skill } from "@/domain/types";
import type { StudyTask } from "@/domain/models";
import type { Repositories } from "@/repositories/ports";
import { addDays, nowISO, todayISO } from "@/lib/date";
import { taskSubmissionSchema, type TaskSubmission } from "@/lib/validation";
import { applyPracticeEvidence, enqueueReviewForWrongAnswer, recordPracticeWeaknesses } from "./profile";
import { isReadingTargetRef, projectReadingTask } from "./reading-plan";

/**
 * 训练任务执行服务。
 *
 * 这是产品闭环里最关键的一段：开始 → 作答 → 提交 → 反馈 → 落库 → 画像更新。
 * 所有动作都在服务端完成，Server Action 只做一层薄封装。
 */

export interface SubmissionFeedback {
  taskId: string;
  score: number;
  correctCount: number;
  totalCount: number;
  summary: string;
  details: Array<{ questionId: string; prompt: string; correct: boolean; correctAnswer: string; explanation: string }>;
  errorTags: string[];
  /** 由谁给出的反馈。UI 必须如实展示，禁止把本地规则标成 AI。 */
  gradedBy: "local-rubric" | "ai";
  disclaimer: string | null;
  aiMessage: string | null;
  reviewItemsCreated: number;
  newWeaknesses: string[];
  durationMinutes: number;
}

export interface TaskDetail {
  task: StudyTask;
  content: ContentItem | null;
  /** 内容缺失时给出可读原因，UI 显示正式 pending/error 状态 */
  unavailableReason: string | null;
}

export function getTaskDetail(repos: Repositories, taskId: string): TaskDetail | null {
  const task = repos.plan.getTask(taskId);
  if (!task) return null;

  if (!task.contentRef) {
    return { task, content: null, unavailableReason: null };
  }
  if (task.contentRef.contentType === "review_deck") {
    return { task, content: null, unavailableReason: null };
  }
  /**
   * 真实真题阅读大题不属于内容库，因此这里**刻意不查内容库** ——
   * 查了必然为 null，而那个 null 会被下游解释成"内容失效"，
   * 那是错误的原因。它的可用性与跳转由 `reading-plan` 解析。
   */
  if (isReadingTargetRef(task.contentRef.contentType)) {
    return { task, content: null, unavailableReason: null };
  }
  const content = contentRepository.getItem(task.contentRef.contentType, task.contentRef.contentId);
  return {
    task,
    content,
    unavailableReason:
      content === null ? "该任务引用的内容在内容库中不存在。可能是内容已更新，请让计划重新生成。" : null,
  };
}

export type SubmitTaskResult =
  | { ok: true; feedback: SubmissionFeedback }
  | { ok: false; error: string };

export type LegacyReadingRedirect = { kind: "redirect"; href: string };
export type LegacyReadingBlocked = { kind: "blocked"; reason: string };
export type LegacyReadingResolution = LegacyReadingRedirect | LegacyReadingBlocked | { kind: "none" };

/**
 * 旧执行器（`/practice/[taskId]`）对**阅读类任务**的处置。
 *
 * ── 为什么这里必须有一个显式出口，而不是让页面自己处理 ──
 *
 * 收敛之后，新生成的阅读训练任务都直接把学习者送进 Expert Training
 * 工作面。但**历史计划行仍然存在**：一条更早生成、到今天还没做完的
 * 合成阅读任务，它的 `contentRef` 仍然指着 `practice-library.ts` 的篇章，
 * 而它仍然会出现在 Today 的「补做」区里。点进 `/practice/[taskId]` 时若不拦，
 * 学习者就会重新落回那条已经被产品决定淘汰的路径上。
 *
 * ── 它与 Today 用的是同一个投影 ──
 *
 * 判断"这条阅读任务该去哪"只有一份实现（`projectReadingTask`）：
 * Today 用它把历史任务渲染成**真话**（真实卷次与大题），
 * 这里用它决定把请求送到哪里。两处共用意味着
 * "Today 说会去哪"与"点下去真的去哪"在原理上不可能不一致。
 *
 * 非阅读任务一律返回 `none`，旧执行器照常工作。
 */
export function resolveLegacyReadingTask(
  repos: Repositories,
  profileId: string,
  task: StudyTask,
): LegacyReadingResolution {
  const projection = projectReadingTask(repos, profileId, task);

  if (projection.kind === "not_reading") return { kind: "none" };

  /*
   * **历史已完成的合成阅读任务**：它是一件历史事实，**不得**被重定向进
   * Expert Training —— 那会让学习者以为当时做的是一份真题。
   * 交给旧执行器按"这个任务已经完成了"如实呈现（`none` = 不拦截）。
   */
  if (projection.kind === "historical_completed") return { kind: "none" };

  if (projection.kind === "converged") return { kind: "redirect", href: projection.href };

  return {
    kind: "blocked",
    reason:
      "这条阅读训练任务引用的是产品自造的练习材料，而面向 CET-6 的阅读训练现在只走真实历年真题。" +
      projection.reason,
  };
}

export async function submitTask(
  repos: Repositories,
  profileId: string,
  raw: Partial<TaskSubmission> & { taskId: string },
): Promise<SubmitTaskResult> {
  const parsed = taskSubmissionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "提交内容无效" };
  }
  const input = parsed.data;

  const task = repos.plan.getTask(input.taskId);
  if (!task) {
    return { ok: false, error: "任务不存在。请返回 Today 重新进入。" };
  }
  if (task.status === "completed") {
    return { ok: false, error: "这个任务已经完成了。" };
  }

  const detail = getTaskDetail(repos, task.id);
  if (!detail) {
    return { ok: false, error: "任务不存在。请返回 Today 重新进入。" };
  }
  if (detail.unavailableReason) {
    return { ok: false, error: detail.unavailableReason };
  }

  const startedAt = nowISO();
  const content = detail.content;

  const listeningUnavailable =
    content?.type === "listening_pending" ||
    (task.kind === "listening_comprehension" && content === null);
  if (listeningUnavailable) {
    return {
      ok: false,
      error:
        "听力训练需要音频素材，Phase 1 尚未内置。这是一个待补的内容缺口，不是一个可以点掉的按钮。",
    };
  }

  const graded = await gradeTaskContent(repos, profileId, task, content, input);

  const finishedAt = nowISO();
  const correctCount = graded.details.filter((d) => d.correct).length;

  // 一次提交的所有持久化效果必须全有或全无。
  //
  // 为什么需要显式事务：这段包含 6 类写入（session → attempts → task 状态 →
  // 画像 → 弱点 → 复习队列）。中途失败会留下矛盾状态，例如"有学习记录但任务仍可提交"，
  // 导致重复计入。事务通过 repositories 的原子执行入口获得，
  // repository 内部各自的事务会用 SAVEPOINT 嵌套（见 db/client.ts 的可重入实现）。
  const outcome = repos.transaction(() => {
    repos.records.saveSession({
      profileId,
      taskId: task.id,
      kind: task.kind,
      skill: task.skill,
      startedAt,
      finishedAt,
      durationMinutes: input.elapsedMinutes ?? task.estimatedMinutes,
      correctCount,
      totalCount: graded.details.length,
      score: graded.score,
      feedbackSummary: graded.summary,
    });

    repos.records.saveAttempts(
      graded.details.map((detail) => ({
        profileId,
        taskId: task.id,
        contentItemId: content?.id ?? task.contentRef?.contentId ?? task.id,
        answerText: null,
        choiceId: null,
        correct: detail.correct,
        score: detail.correct ? 1 : 0,
        feedback: detail.explanation,
        errorTags: detail.correct ? [] : [detail.errorTag].filter(Boolean),
        createdAt: finishedAt,
      })),
    );

    repos.plan.updateTaskStatus(task.id, "completed", finishedAt);

    // 画像更新：训练证据回写
    if (graded.details.length > 0) {
      applyPracticeEvidence(repos, profileId, [
        { skill: task.skill, correct: correctCount, total: graded.details.length },
      ]);
    }

    // 错因 → 弱点 → 后续训练权重
    const addedWeaknesses = recordPracticeWeaknesses(repos, profileId, task.skill, graded.errorTags);

    // 错答 → 复习队列
    let created = 0;
    for (const wrong of graded.details.filter((d) => !d.correct)) {
      enqueueReviewForWrongAnswer(repos, {
        profileId,
        contentItemId: `${content?.id ?? task.id}:${wrong.questionId}`,
        contentRef: task.contentRef,
        skill: task.skill,
        prompt: wrong.prompt.slice(0, 80),
      });
      created += 1;
    }

    // 复习任务本身：把勾选的项目顺延到明天
    if (task.kind === "review" && input.reviewedItemIds.length > 0) {
      const reviewedOn = todayISO();
      const nextDue = addDays(reviewedOn, 1);
      for (const id of input.reviewedItemIds) {
        repos.review.markReviewed(id, reviewedOn, nextDue);
      }
    }

    return { newWeaknesses: addedWeaknesses, reviewItemsCreated: created };
  });

  const { newWeaknesses, reviewItemsCreated } = outcome;

  return {
    ok: true,
    feedback: {
      taskId: task.id,
      score: graded.score,
      correctCount,
      totalCount: graded.details.length,
      summary: graded.summary,
      details: graded.details,
      errorTags: graded.errorTags,
      gradedBy: graded.gradedBy,
      disclaimer: graded.disclaimer,
      aiMessage: graded.aiMessage,
      reviewItemsCreated,
      newWeaknesses: newWeaknesses.map((w) => w.label),
      durationMinutes: input.elapsedMinutes ?? task.estimatedMinutes,
    },
  };
}

interface GradedDetail {
  questionId: string;
  prompt: string;
  correct: boolean;
  correctAnswer: string;
  explanation: string;
  errorTag: string;
}

interface GradedTask {
  score: number;
  summary: string;
  details: GradedDetail[];
  errorTags: string[];
  gradedBy: "local-rubric" | "ai";
  disclaimer: string | null;
  aiMessage: string | null;
}

async function gradeTaskContent(
  repos: Repositories,
  profileId: string,
  task: StudyTask,
  content: ContentItem | null,
  input: TaskSubmission,
): Promise<GradedTask> {
  const answerMap = new Map(input.answers.map((a) => [a.questionId, a.choiceId]));

  if (content?.type === "reading_passage") {
    const details: GradedDetail[] = content.questions.map((question) => {
      const choiceId = answerMap.get(question.id) ?? null;
      return {
        questionId: question.id,
        prompt: question.prompt,
        correct: choiceId !== null && choiceId === question.correctChoiceId,
        correctAnswer:
          question.choices.find((c) => c.id === question.correctChoiceId)?.label ?? question.correctChoiceId,
        explanation: question.explanation,
        errorTag: question.errorTag,
      };
    });
    const correct = details.filter((d) => d.correct).length;
    return {
      score: details.length === 0 ? 0 : correct / details.length,
      summary: `阅读 ${correct}/${details.length} 题正确。错误题目已加入复习队列，明天会再次出现。`,
      details,
      errorTags: details.filter((d) => !d.correct).map((d) => d.errorTag),
      gradedBy: "local-rubric",
      disclaimer: null,
      aiMessage: null,
    };
  }

  if (content?.type === "vocabulary_set") {
    const details: GradedDetail[] = content.entries.map((entry) => {
      const choiceId = answerMap.get(entry.id) ?? null;
      return {
        questionId: entry.id,
        prompt: `${entry.word} — ${entry.sentence.replace("______", "______")}`,
        correct: choiceId !== null && choiceId === entry.correctChoiceId,
        correctAnswer: entry.choices.find((c) => c.id === entry.correctChoiceId)?.label ?? entry.correctChoiceId,
        explanation: `${entry.phonetic} ${entry.definition}`,
        errorTag: entry.errorTag,
      };
    });
    const correct = details.filter((d) => d.correct).length;
    return {
      score: details.length === 0 ? 0 : correct / details.length,
      summary: `词汇 ${correct}/${details.length} 题正确。`,
      details,
      errorTags: details.filter((d) => !d.correct).map((d) => d.errorTag),
      gradedBy: "local-rubric",
      disclaimer: null,
      aiMessage: null,
    };
  }

  if (content?.type === "translation_prompt") {
    const provider = getGradingProvider();
    const result = await provider.gradeTranslation({
      sourceText: content.sourceText,
      referenceTranslation: content.referenceTranslation,
      userTranslation: input.writing,
    });
    const data = result.data;
    const matched = content.keyPoints.filter((point) =>
      input.writing.toLowerCase().includes(firstKeyword(point)),
    );
    const details: GradedDetail[] = content.keyPoints.map((point) => ({
      questionId: point,
      prompt: point,
      correct: matched.includes(point),
      correctAnswer: "参考译文包含该信息点",
      explanation: `参考译文：${content.referenceTranslation}`,
      errorTag: "translation.missing_point",
    }));
    return {
      score: data?.score ?? 0,
      summary:
        data?.summary ??
        `关键信息点覆盖 ${matched.length}/${content.keyPoints.length}。本地规则只做结构匹配，未评估表达质量。`,
      details,
      errorTags: details.filter((d) => !d.correct).map((d) => d.errorTag),
      gradedBy: result.source === "ai" ? "ai" : "local-rubric",
      disclaimer: data?.disclaimer ?? (result.source === "ai" ? null : result.message),
      aiMessage: result.source === "ai" ? null : result.message,
    };
  }

  if (content?.type === "writing_prompt") {
    const provider = getGradingProvider();
    const result = await provider.gradeWriting({
      prompt: content.prompt,
      essay: input.writing,
      minWords: content.minWords,
      maxWords: content.maxWords,
    });
    const data = result.data;
    const localRubric = gradeWithRubric(input.writing, content.rubricPoints);
    const details: GradedDetail[] = content.rubricPoints.map((point) => ({
      questionId: point,
      prompt: point,
      correct: localRubric.matched.includes(point),
      correctAnswer: "作文中应体现该要点",
      explanation: localRubric.matched.includes(point) ? "已检测到该要点。" : "未检测到该要点的典型表达。",
      errorTag: "writing.rubric_missing",
    }));
    const issues = data?.issues.map((i) => `· ${i.label}：${i.detail}`).join("\n") ?? "";
    return {
      score: data?.score ?? localRubric.score,
      summary: `${data?.summary ?? "本地规则评分"}${issues ? `\n\n${issues}` : ""}`,
      details,
      errorTags: data?.issues.map((i) => i.errorTag) ?? [],
      gradedBy: result.source === "ai" ? "ai" : "local-rubric",
      disclaimer: data?.disclaimer ?? (result.source === "ai" ? null : result.message),
      aiMessage: result.source === "ai" ? null : result.message,
    };
  }

  if (task.kind === "review" || task.contentRef?.contentType === "review_deck") {
    const items = repos.review.getDueItems(profileId, todayISO());
    const reviewed = new Set(input.reviewedItemIds);
    const details: GradedDetail[] = items.map((item) => ({
      questionId: item.id,
      prompt: item.prompt,
      correct: reviewed.has(item.id),
      correctAnswer: "标记为已复习",
      explanation: reviewed.has(item.id)
        ? "已标记复习完成，将顺延到明天再次出现。"
        : "未标记复习完成，该项会留在队列中。",
      errorTag: reviewed.has(item.id) ? "" : "review.skipped",
    }));
    const done = details.filter((d) => d.correct).length;
    return {
      score: details.length === 0 ? 1 : done / details.length,
      summary:
        details.length === 0
          ? "复习队列当前为空，本次任务记为完成。"
          : `复习完成 ${done}/${details.length} 项。`,
      details,
      errorTags: details.filter((d) => !d.correct).map((d) => d.errorTag),
      gradedBy: "local-rubric",
      disclaimer: null,
      aiMessage: null,
    };
  }

  return {
    score: 0,
    summary: "该任务类型在 Phase 1 还没有可执行的作答方式。",
    details: [],
    errorTags: [],
    gradedBy: "local-rubric",
    disclaimer: null,
    aiMessage: null,
  };
}

function firstKeyword(point: string): string {
  const tokens = point.toLowerCase().split(/\s+/).filter((t) => t.length >= 4);
  return tokens[0] ?? point.toLowerCase();
}

export function skillOfTask(repos: Repositories, taskId: string): Skill | null {
  return repos.plan.getTask(taskId)?.skill ?? null;
}
