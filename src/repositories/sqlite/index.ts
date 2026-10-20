import type { DatabaseSync } from "node:sqlite";
import { getDbFile, getDb, openDatabaseReadOnly, transaction } from "@/db/client";
import { newId } from "@/lib/id";
import { nowISO } from "@/lib/date";
import type {
  AnswerAttempt,
  DailyPlan,
  DiagnosticAnswer,
  DiagnosticItemResult,
  DiagnosticSession,
  DimensionResult,
  ExamGoal,
  LearnerProfile,
  Recommendation,
  ReviewItem,
  SkillProfile,
  StudySession,
  StudyTask,
  TaskContentRef,
  Weakness,
} from "@/domain/models";
import type {
  DiagnosticDimension,
  ISODate,
  MasteryLevel,
  Skill,
  TaskKind,
  TaskPriority,
} from "@/domain/types";
import type { ConfidenceLevel } from "@/domain/models";
import type {
  DiagnosticRepository,
  LearnerRepository,
  OnboardingInput,
  PlanRepository,
  RecordRepository,
  Repositories,
  ReviewRepository,
  SkillProfileRepository,
} from "../ports";
import { SqlitePaperRepository } from "./papers";
import { SqliteExpertRepository } from "./expert";
import { SqliteCourseRepository } from "./courses";
import { allRows, firstRow, fromBool, json, toBool, toFloat, toInt, toJson, toNullableText, toText, type Row } from "./support";

// ---------------------------------------------------------------------------
// 行映射
// ---------------------------------------------------------------------------

function mapProfile(row: Row): LearnerProfile {
  return {
    id: toText(row.id),
    displayName: toText(row.display_name),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    preferences: {
      weekdayMinutes: toInt(row.weekday_minutes),
      weekendMinutes: toInt(row.weekend_minutes),
    },
  };
}

function mapGoal(row: Row): ExamGoal {
  return {
    id: toText(row.id),
    profileId: toText(row.profile_id),
    examName: toText(row.exam_name),
    examDate: toText(row.exam_date),
    targetScore: toInt(row.target_score),
    scoreHistory: toJson(row.score_history, []),
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
  };
}

function mapSession(row: Row): DiagnosticSession {
  return {
    id: toText(row.id),
    profileId: toText(row.profile_id),
    startedAt: toText(row.started_at),
    completedAt: toNullableText(row.completed_at),
    itemIds: toJson<string[]>(row.item_ids, []),
    answers: [],
    results: [],
    dimensionResults: [],
    weaknesses: [],
    recommendations: [],
    partial: toBool(row.partial),
  };
}

function mapAnswer(row: Row): DiagnosticAnswer {
  return {
    itemId: toText(row.item_id),
    dimension: toText(row.dimension) as DiagnosticDimension,
    choiceId: toNullableText(row.choice_id),
    text: toNullableText(row.answer_text),
    skipped: toBool(row.skipped),
    submittedAt: toText(row.submitted_at),
  };
}

function mapSkillProfile(row: Row): SkillProfile {
  return {
    id: toText(row.id),
    profileId: toText(row.profile_id),
    updatedAt: toText(row.updated_at),
    skills: toJson(row.skills, {} as SkillProfile["skills"]),
    dimensions: toJson<DimensionResult[]>(row.dimensions, []),
    weaknesses: toJson<Weakness[]>(row.weaknesses, []),
    recommendations: toJson<Recommendation[]>(row.recommendations, []),
    unassessedNotices: toJson<SkillProfile["unassessedNotices"]>(row.unassessed_notices, []),
    basedOnDiagnosticId: toNullableText(row.based_on_diagnostic),
  };
}

function mapTask(row: Row, planId: string): StudyTask {
  return {
    id: toText(row.id),
    planId,
    kind: toText(row.kind) as TaskKind,
    skill: toText(row.skill) as Skill,
    priority: toText(row.priority) as TaskPriority,
    title: toText(row.title),
    rationale: toText(row.rationale),
    estimatedMinutes: toInt(row.estimated_minutes),
    contentRef: toJson<TaskContentRef | null>(row.content_ref, null),
    status: toText(row.status) as StudyTask["status"],
    completedAt: toNullableText(row.completed_at),
    order: toInt(row.sort_order),
  };
}

function mapPlan(row: Row, tasks: StudyTask[]): DailyPlan {
  return {
    id: toText(row.id),
    profileId: toText(row.profile_id),
    date: toText(row.plan_date),
    availableMinutes: toInt(row.available_minutes),
    plannedForMinutes: toInt(row.planned_for_minutes),
    tasks,
    createdAt: toText(row.created_at),
    updatedAt: toText(row.updated_at),
    revisionCount: toInt(row.revision_count),
    generatedBy: toText(row.generated_by) as DailyPlan["generatedBy"],
    notes: toJson<string[]>(row.notes, []),
    warnings: toJson<string[]>(row.warnings, []),
  };
}

function mapStudySession(row: Row): StudySession {
  return {
    id: toText(row.id),
    profileId: toText(row.profile_id),
    taskId: toNullableText(row.task_id),
    kind: toText(row.kind) as TaskKind,
    skill: toText(row.skill) as Skill,
    startedAt: toText(row.started_at),
    finishedAt: toText(row.finished_at),
    durationMinutes: toInt(row.duration_minutes),
    correctCount: toInt(row.correct_count),
    totalCount: toInt(row.total_count),
    score: toFloat(row.score),
    feedbackSummary: toText(row.feedback_summary),
  };
}

function mapAttempt(row: Row): AnswerAttempt {
  return {
    id: toText(row.id),
    taskId: toNullableText(row.task_id),
    profileId: toText(row.profile_id),
    contentItemId: toText(row.content_item_id),
    answerText: toNullableText(row.answer_text),
    choiceId: toNullableText(row.choice_id),
    correct: toBool(row.correct),
    score: toFloat(row.score),
    feedback: toText(row.feedback),
    errorTags: toJson<string[]>(row.error_tags, []),
    createdAt: toText(row.created_at),
  };
}

function mapReviewItem(row: Row): ReviewItem {
  return {
    id: toText(row.id),
    profileId: toText(row.profile_id),
    contentItemId: toText(row.content_item_id),
    contentRef: toJson<TaskContentRef>(row.content_ref, { contentType: "review_deck", contentId: "" }),
    skill: toText(row.skill) as Skill,
    prompt: toText(row.prompt),
    dueOn: toText(row.due_on),
    stability: toFloat(row.stability),
    difficulty: toFloat(row.difficulty),
    reps: toInt(row.reps),
    lapses: toInt(row.lapses),
    lastReviewedOn: toNullableText(row.last_reviewed_on),
    createdAt: toText(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// Learner
// ---------------------------------------------------------------------------

class SqliteLearnerRepository implements LearnerRepository {
  constructor(private readonly db: DatabaseSync) {}

  getProfile(): LearnerProfile | null {
    const row = firstRow(this.db, "SELECT * FROM learner_profile LIMIT 1", []);
    return row ? mapProfile(row) : null;
  }

  isOnboarded(): boolean {
    return this.getProfile() !== null;
  }

  saveProfile(profileId: string | null, input: OnboardingInput): LearnerProfile {
    const existing = profileId
      ? firstRow(this.db, "SELECT * FROM learner_profile WHERE id = ?", [profileId])
      : firstRow(this.db, "SELECT * FROM learner_profile LIMIT 1", []);
    const now = nowISO();

    if (existing) {
      this.db
        .prepare(
          "UPDATE learner_profile SET display_name = ?, weekday_minutes = ?, weekend_minutes = ?, updated_at = ? WHERE id = ?",
        )
        .run(
          input.displayName,
          input.preferences.weekdayMinutes,
          input.preferences.weekendMinutes,
          now,
          toText(existing.id),
        );
      return mapProfile(firstRow(this.db, "SELECT * FROM learner_profile WHERE id = ?", [toText(existing.id)])!);
    }

    const id = profileId ?? newId();
    this.db
      .prepare(
        "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        id,
        input.displayName,
        input.preferences.weekdayMinutes,
        input.preferences.weekendMinutes,
        now,
        now,
      );
    return mapProfile(firstRow(this.db, "SELECT * FROM learner_profile WHERE id = ?", [id])!);
  }

  updatePreferences(profileId: string, preferences: { weekdayMinutes: number; weekendMinutes: number }): LearnerProfile {
    this.db
      .prepare("UPDATE learner_profile SET weekday_minutes = ?, weekend_minutes = ?, updated_at = ? WHERE id = ?")
      .run(preferences.weekdayMinutes, preferences.weekendMinutes, nowISO(), profileId);
    const row = firstRow(this.db, "SELECT * FROM learner_profile WHERE id = ?", [profileId]);
    if (!row) throw new Error(`profile 不存在：${profileId}`);
    return mapProfile(row);
  }

  getGoal(profileId: string): ExamGoal | null {
    const row = firstRow(this.db, "SELECT * FROM exam_goal WHERE profile_id = ? LIMIT 1", [profileId]);
    return row ? mapGoal(row) : null;
  }

  saveGoal(profileId: string, input: { examName: string; examDate: ISODate; targetScore: number }): ExamGoal {
    const existing = this.getGoal(profileId);
    const now = nowISO();
    if (existing) {
      this.db
        .prepare("UPDATE exam_goal SET exam_name = ?, exam_date = ?, target_score = ?, updated_at = ? WHERE id = ?")
        .run(input.examName, input.examDate, input.targetScore, now, existing.id);
      return mapGoal(firstRow(this.db, "SELECT * FROM exam_goal WHERE id = ?", [existing.id])!);
    }
    const id = newId();
    this.db
      .prepare(
        "INSERT INTO exam_goal (id, profile_id, exam_name, exam_date, target_score, score_history, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, profileId, input.examName, input.examDate, input.targetScore, json([]), now, now);
    return mapGoal(firstRow(this.db, "SELECT * FROM exam_goal WHERE id = ?", [id])!);
  }

  updateGoal(
    profileId: string,
    patch: { examName?: string; examDate?: ISODate; targetScore?: number },
  ): ExamGoal {
    const existing = this.getGoal(profileId);
    if (!existing) throw new Error("尚未设置考试目标");
    this.db
      .prepare("UPDATE exam_goal SET exam_name = ?, exam_date = ?, target_score = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.examName ?? existing.examName,
        patch.examDate ?? existing.examDate,
        patch.targetScore ?? existing.targetScore,
        nowISO(),
        existing.id,
      );
    return mapGoal(firstRow(this.db, "SELECT * FROM exam_goal WHERE id = ?", [existing.id])!);
  }
}

// ---------------------------------------------------------------------------
// Diagnostic
// ---------------------------------------------------------------------------

class SqliteDiagnosticRepository implements DiagnosticRepository {
  constructor(private readonly db: DatabaseSync) {}

  createSession(profileId: string, itemIds: string[]): DiagnosticSession {
    const id = newId();
    this.db
      .prepare("INSERT INTO diagnostic_session (id, profile_id, started_at, item_ids, partial) VALUES (?, ?, ?, ?, 0)")
      .run(id, profileId, nowISO(), json(itemIds));
    return this.getSession(id)!;
  }

  getSession(id: string): DiagnosticSession | null {
    const row = firstRow(this.db, "SELECT * FROM diagnostic_session WHERE id = ?", [id]);
    if (!row) return null;
    const session = mapSession(row);
    session.answers = this.getAnswers(id);
    return session;
  }

  getLatestSession(profileId: string): DiagnosticSession | null {
    const row = firstRow(
      this.db,
      "SELECT * FROM diagnostic_session WHERE profile_id = ? AND completed_at IS NOT NULL ORDER BY completed_at DESC LIMIT 1",
      [profileId],
    );
    return row ? this.getSession(toText(row.id)) : null;
  }

  listSessions(profileId: string): DiagnosticSession[] {
    return allRows(
      this.db,
      "SELECT * FROM diagnostic_session WHERE profile_id = ? ORDER BY started_at DESC",
      [profileId],
    ).map((row) => mapSession(row));
  }

  saveAnswers(sessionId: string, answers: DiagnosticAnswer[]): void {
    transaction(this.db, () => {
      const stmt = this.db.prepare(
        `INSERT INTO diagnostic_answer (id, session_id, item_id, dimension, choice_id, answer_text, skipped, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id, item_id) DO UPDATE SET
           choice_id = excluded.choice_id,
           answer_text = excluded.answer_text,
           skipped = excluded.skipped,
           submitted_at = excluded.submitted_at`,
      );
      for (const answer of answers) {
        stmt.run(
          newId(),
          sessionId,
          answer.itemId,
          answer.dimension,
          answer.choiceId,
          answer.text,
          fromBool(answer.skipped),
          answer.submittedAt,
        );
      }
    });
  }

  getAnswers(sessionId: string): DiagnosticAnswer[] {
    return allRows(this.db, "SELECT * FROM diagnostic_answer WHERE session_id = ? ORDER BY submitted_at", [
      sessionId,
    ]).map(mapAnswer);
  }

  completeSession(
    sessionId: string,
    payload: {
      results: DiagnosticItemResult[];
      dimensionResults: DimensionResult[];
      weaknesses: Weakness[];
      recommendations: Recommendation[];
      partial: boolean;
    },
  ): void {
    this.db
      .prepare("UPDATE diagnostic_session SET completed_at = ?, partial = ? WHERE id = ?")
      .run(nowISO(), fromBool(payload.partial), sessionId);
  }
}

// ---------------------------------------------------------------------------
// Skill profile
// ---------------------------------------------------------------------------

class SqliteSkillProfileRepository implements SkillProfileRepository {
  constructor(private readonly db: DatabaseSync) {}

  get(profileId: string): SkillProfile | null {
    const row = firstRow(this.db, "SELECT * FROM skill_profile WHERE profile_id = ?", [profileId]);
    return row ? mapSkillProfile(row) : null;
  }

  save(
    profileId: string,
    payload: {
      skills: Record<Skill, SkillProfile["skills"][Skill]>;
      dimensions: DimensionResult[];
      weaknesses: Weakness[];
      recommendations: Recommendation[];
      unassessedNotices: SkillProfile["unassessedNotices"];
      basedOnDiagnosticId: string | null;
    },
  ): SkillProfile {
    const now = nowISO();
    const existing = this.get(profileId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE skill_profile SET skills = ?, dimensions = ?, weaknesses = ?, recommendations = ?, unassessed_notices = ?, based_on_diagnostic = ?, updated_at = ? WHERE profile_id = ?`,
        )
        .run(
          json(payload.skills),
          json(payload.dimensions),
          json(payload.weaknesses),
          json(payload.recommendations),
          json(payload.unassessedNotices),
          payload.basedOnDiagnosticId,
          now,
          profileId,
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO skill_profile (id, profile_id, skills, dimensions, weaknesses, recommendations, unassessed_notices, based_on_diagnostic, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          newId(),
          profileId,
          json(payload.skills),
          json(payload.dimensions),
          json(payload.weaknesses),
          json(payload.recommendations),
          json(payload.unassessedNotices),
          payload.basedOnDiagnosticId,
          now,
        );
    }
    return this.get(profileId)!;
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

class SqlitePlanRepository implements PlanRepository {
  constructor(private readonly db: DatabaseSync) {}

  getPlan(profileId: string, date: ISODate): DailyPlan | null {
    const row = firstRow(this.db, "SELECT * FROM daily_plan WHERE profile_id = ? AND plan_date = ?", [
      profileId,
      date,
    ]);
    return row ? this.mapPlanWithTasks(row) : null;
  }

  getPlanById(planId: string): DailyPlan | null {
    const row = firstRow(this.db, "SELECT * FROM daily_plan WHERE id = ?", [planId]);
    return row ? this.mapPlanWithTasks(row) : null;
  }

  getLatestPlan(profileId: string): DailyPlan | null {
    const row = firstRow(
      this.db,
      "SELECT * FROM daily_plan WHERE profile_id = ? ORDER BY plan_date DESC LIMIT 1",
      [profileId],
    );
    return row ? this.mapPlanWithTasks(row) : null;
  }

  private mapPlanWithTasks(row: Row): DailyPlan {
    const planId = toText(row.id);
    const tasks = allRows(this.db, "SELECT * FROM study_task WHERE plan_id = ? ORDER BY sort_order", [planId]).map(
      (taskRow) => mapTask(taskRow, planId),
    );
    return mapPlan(row, tasks);
  }

  savePlan(
    profileId: string,
    payload: {
      date: ISODate;
      availableMinutes: number;
      plannedForMinutes: number;
      generatedBy: DailyPlan["generatedBy"];
      notes: string[];
      warnings: string[];
      tasks: Array<Omit<StudyTask, "planId" | "id" | "completedAt"> & { id?: string }>;
    },
  ): DailyPlan {
    const existing = this.getPlan(profileId, payload.date);
    const now = nowISO();

    return transaction(this.db, () => {
      let planId: string;
      if (existing) {
        planId = existing.id;

        // 保留已完成任务，只替换未完成的部分 —— 重排不能抹掉用户已经付出的努力。
        const completed = existing.tasks.filter((t) => t.status === "completed");
        const completedIds = new Set(completed.map((t) => t.id));
        const incomingIds = new Set(payload.tasks.map((t) => t.id).filter(Boolean) as string[]);
        const orphaned = completed.filter((t) => !incomingIds.has(t.id));

        this.db
          .prepare(
            "UPDATE daily_plan SET available_minutes = ?, planned_for_minutes = ?, generated_by = ?, notes = ?, warnings = ?, revision_count = revision_count + 1, updated_at = ? WHERE id = ?",
          )
          .run(
            payload.availableMinutes,
            payload.plannedForMinutes,
            payload.generatedBy,
            json(payload.notes),
            json(payload.warnings),
            now,
            planId,
          );

        // 清掉未完成且不在新计划中的任务，避免列表累积重复项
        const keepIds = new Set([...completedIds, ...incomingIds]);
        const all = allRows(this.db, "SELECT id FROM study_task WHERE plan_id = ?", [planId]);
        const del = this.db.prepare("DELETE FROM study_task WHERE id = ?");
        for (const row of all) {
          const id = toText(row.id);
          if (!keepIds.has(id)) del.run(id);
        }

        // 已完成任务补回计划末尾，保证"今天已经做完的事"仍然可见
        let order = payload.tasks.length;
        const insertCompleted = this.db.prepare(
          "UPDATE study_task SET sort_order = ? WHERE id = ?",
        );
        const insertMissing = this.db.prepare(
          `INSERT INTO study_task (id, plan_id, kind, skill, priority, title, rationale, estimated_minutes, content_ref, status, completed_at, sort_order)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?)`,
        );
        for (const task of [...completed.filter((t) => incomingIds.has(t.id)), ...orphaned]) {
          if (incomingIds.has(task.id)) {
            insertCompleted.run(order++, task.id);
          } else {
            insertMissing.run(
              task.id,
              planId,
              task.kind,
              task.skill,
              task.priority,
              task.title,
              task.rationale,
              task.estimatedMinutes,
              json(task.contentRef),
              task.completedAt,
              order++,
            );
          }
        }
      } else {
        planId = newId();
        this.db
          .prepare(
            `INSERT INTO daily_plan (id, profile_id, plan_date, available_minutes, planned_for_minutes, generated_by, revision_count, notes, warnings, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
          )
          .run(
            planId,
            profileId,
            payload.date,
            payload.availableMinutes,
            payload.plannedForMinutes,
            payload.generatedBy,
            json(payload.notes),
            json(payload.warnings),
            now,
            now,
          );
      }

      const taskStmt = this.db.prepare(
        `INSERT INTO study_task (id, plan_id, kind, skill, priority, title, rationale, estimated_minutes, content_ref, status, completed_at, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           skill = excluded.skill,
           priority = excluded.priority,
           title = excluded.title,
           rationale = excluded.rationale,
           estimated_minutes = excluded.estimated_minutes,
           content_ref = excluded.content_ref,
           sort_order = excluded.sort_order`,
      );

      payload.tasks.forEach((task, index) => {
        taskStmt.run(
          task.id ?? newId(),
          planId,
          task.kind,
          task.skill,
          task.priority,
          task.title,
          task.rationale,
          task.estimatedMinutes,
          json(task.contentRef),
          task.status,
          null,
          index,
        );
      });

      return this.getPlanById(planId)!;
    });
  }

  updateTaskStatus(taskId: string, status: StudyTask["status"], completedAt: string | null): StudyTask | null {
    this.db
      .prepare("UPDATE study_task SET status = ?, completed_at = ? WHERE id = ?")
      .run(status, completedAt, taskId);
    return this.getTask(taskId);
  }

  getTask(taskId: string): StudyTask | null {
    const row = firstRow(this.db, "SELECT * FROM study_task WHERE id = ?", [taskId]);
    if (!row) return null;
    return mapTask(row, toText(row.plan_id));
  }

  getOutstandingCoreTasks(profileId: string, beforeDate: ISODate): StudyTask[] {
    return allRows(
      this.db,
      `SELECT t.* FROM study_task t
       JOIN daily_plan p ON p.id = t.plan_id
       WHERE p.profile_id = ? AND p.plan_date < ? AND t.priority = 'core' AND t.status IN ('pending', 'in_progress')
       ORDER BY p.plan_date ASC, t.sort_order ASC`,
      [profileId, beforeDate],
    ).map((row) => mapTask(row, toText(row.plan_id)));
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

class SqliteRecordRepository implements RecordRepository {
  constructor(private readonly db: DatabaseSync) {}

  saveSession(session: Omit<StudySession, "id">): StudySession {
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO study_session (id, profile_id, task_id, kind, skill, started_at, finished_at, duration_minutes, correct_count, total_count, score, feedback_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        session.profileId,
        session.taskId,
        session.kind,
        session.skill,
        session.startedAt,
        session.finishedAt,
        session.durationMinutes,
        session.correctCount,
        session.totalCount,
        session.score,
        session.feedbackSummary,
      );
    return { id, ...session };
  }

  saveAttempts(attempts: Array<Omit<AnswerAttempt, "id">>): AnswerAttempt[] {
    return transaction(this.db, () => {
      const stmt = this.db.prepare(
        `INSERT INTO answer_attempt (id, profile_id, task_id, content_item_id, answer_text, choice_id, correct, score, feedback, error_tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      return attempts.map((attempt) => {
        const id = newId();
        stmt.run(
          id,
          attempt.profileId,
          attempt.taskId,
          attempt.contentItemId,
          attempt.answerText,
          attempt.choiceId,
          fromBool(attempt.correct),
          attempt.score,
          attempt.feedback,
          json(attempt.errorTags),
          attempt.createdAt,
        );
        return { id, ...attempt };
      });
    });
  }

  listRecentSessions(profileId: string, limit: number): StudySession[] {
    return allRows(
      this.db,
      "SELECT * FROM study_session WHERE profile_id = ? ORDER BY finished_at DESC LIMIT ?",
      [profileId, limit],
    ).map(mapStudySession);
  }

  listRecentAttempts(profileId: string, limit: number): AnswerAttempt[] {
    return allRows(
      this.db,
      "SELECT * FROM answer_attempt WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?",
      [profileId, limit],
    ).map(mapAttempt);
  }

  getActivity(
    profileId: string,
    days: number,
    today: ISODate,
  ): Array<{ date: ISODate; minutes: number; tasksCompleted: number; sessions: number }> {
    const rows = allRows(
      this.db,
      `SELECT substr(finished_at, 1, 10) AS day,
              SUM(duration_minutes) AS minutes,
              COUNT(*) AS sessions
       FROM study_session
       WHERE profile_id = ?
       GROUP BY day`,
      [profileId],
    );

    const taskRows = allRows(
      this.db,
      `SELECT substr(t.completed_at, 1, 10) AS day, COUNT(*) AS completed
       FROM study_task t
       JOIN daily_plan p ON p.id = t.plan_id
       WHERE p.profile_id = ? AND t.status = 'completed' AND t.completed_at IS NOT NULL
       GROUP BY day`,
      [profileId],
    );

    const byDay = new Map<string, { minutes: number; tasksCompleted: number; sessions: number }>();
    for (const row of rows) {
      const day = toText(row.day);
      byDay.set(day, {
        minutes: toInt(row.minutes),
        sessions: toInt(row.sessions),
        tasksCompleted: 0,
      });
    }
    for (const row of taskRows) {
      const day = toText(row.day);
      const entry = byDay.get(day) ?? { minutes: 0, sessions: 0, tasksCompleted: 0 };
      entry.tasksCompleted = toInt(row.completed);
      byDay.set(day, entry);
    }

    const result: Array<{ date: ISODate; minutes: number; tasksCompleted: number; sessions: number }> = [];
    const [y, m, d] = today.split("-").map(Number);
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = new Date(y, (m ?? 1) - 1, d ?? 1);
      date.setDate(date.getDate() - i);
      const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
      const entry = byDay.get(iso) ?? { minutes: 0, tasksCompleted: 0, sessions: 0 };
      result.push({ date: iso, ...entry });
    }
    return result;
  }

  getRecentlyPractisedSkills(profileId: string, sinceDate: ISODate): Skill[] {
    const rows = allRows(
      this.db,
      `SELECT DISTINCT skill FROM study_session
       WHERE profile_id = ? AND substr(finished_at, 1, 10) >= ?`,
      [profileId, sinceDate],
    );
    return rows.map((row) => toText(row.skill) as Skill);
  }

  getSkillEvidence(profileId: string): Partial<Record<Skill, { correct: number; total: number }>> {
    const rows = allRows(
      this.db,
      `SELECT s.skill AS skill,
              SUM(s.correct_count) AS correct,
              SUM(s.total_count) AS total
       FROM study_session s
       WHERE s.profile_id = ? AND s.total_count > 0
       GROUP BY s.skill`,
      [profileId],
    );
    const result: Partial<Record<Skill, { correct: number; total: number }>> = {};
    for (const row of rows) {
      result[toText(row.skill) as Skill] = {
        correct: toInt(row.correct),
        total: toInt(row.total),
      };
    }
    return result;
  }

  countCompletedTasksOn(profileId: string, date: ISODate): number {
    const row = firstRow(
      this.db,
      `SELECT COUNT(*) AS c FROM study_task t
       JOIN daily_plan p ON p.id = t.plan_id
       WHERE p.profile_id = ? AND p.plan_date = ? AND t.status = 'completed'`,
      [profileId, date],
    );
    return row ? toInt(row.c) : 0;
  }
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

class SqliteReviewRepository implements ReviewRepository {
  constructor(private readonly db: DatabaseSync) {}

  getDueItems(profileId: string, onOrBefore: ISODate): ReviewItem[] {
    return allRows(
      this.db,
      "SELECT * FROM review_item WHERE profile_id = ? AND due_on <= ? ORDER BY due_on ASC",
      [profileId, onOrBefore],
    ).map(mapReviewItem);
  }

  listAll(profileId: string): ReviewItem[] {
    return allRows(this.db, "SELECT * FROM review_item WHERE profile_id = ? ORDER BY due_on ASC", [
      profileId,
    ]).map(mapReviewItem);
  }

  upsert(item: Omit<ReviewItem, "id" | "createdAt"> & { id?: string }): ReviewItem {
    const existing = firstRow(
      this.db,
      "SELECT * FROM review_item WHERE profile_id = ? AND content_item_id = ?",
      [item.profileId, item.contentItemId],
    );
    const now = nowISO();
    if (existing) {
      this.db
        .prepare(
          `UPDATE review_item SET content_ref = ?, skill = ?, prompt = ?, due_on = ?, stability = ?, difficulty = ?, reps = ?, lapses = ? WHERE id = ?`,
        )
        .run(
          json(item.contentRef),
          item.skill,
          item.prompt,
          item.dueOn,
          item.stability,
          item.difficulty,
          item.reps,
          item.lapses,
          toText(existing.id),
        );
      return mapReviewItem(firstRow(this.db, "SELECT * FROM review_item WHERE id = ?", [toText(existing.id)])!);
    }
    const id = item.id ?? newId();
    this.db
      .prepare(
        `INSERT INTO review_item (id, profile_id, content_item_id, content_ref, skill, prompt, due_on, stability, difficulty, reps, lapses, last_reviewed_on, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        item.profileId,
        item.contentItemId,
        json(item.contentRef),
        item.skill,
        item.prompt,
        item.dueOn,
        item.stability,
        item.difficulty,
        item.reps,
        item.lapses,
        item.lastReviewedOn,
        now,
      );
    return mapReviewItem(firstRow(this.db, "SELECT * FROM review_item WHERE id = ?", [id])!);
  }

  markReviewed(id: string, reviewedOn: ISODate, nextDue: ISODate): void {
    this.db
      .prepare("UPDATE review_item SET reps = reps + 1, last_reviewed_on = ?, due_on = ? WHERE id = ?")
      .run(reviewedOn, nextDue, id);
  }
}

// ---------------------------------------------------------------------------
// 组合与单例
// ---------------------------------------------------------------------------

export function createSqliteRepositories(db: DatabaseSync = getDb()): Repositories {
  return {
    learner: new SqliteLearnerRepository(db),
    diagnostic: new SqliteDiagnosticRepository(db),
    skillProfile: new SqliteSkillProfileRepository(db),
    plan: new SqlitePlanRepository(db),
    records: new SqliteRecordRepository(db),
    review: new SqliteReviewRepository(db),
    papers: new SqlitePaperRepository(db),
    expert: new SqliteExpertRepository(db),
    courses: new SqliteCourseRepository(db),
    // 聚合级原子边界：可重入（内层用 SAVEPOINT 嵌套）
    transaction: <T,>(fn: () => T) => transaction(db, fn),
  };
}

let cached: Repositories | null = null;

/** 应用运行时使用的 repository 集合。切换后端时只改这里。 */
export function getRepositories(): Repositories {
  if (!cached) {
    cached = createSqliteRepositories();
  }
  return cached;
}

/**
 * 清掉 repository 组合的模块级缓存。
 *
 * ── 它为什么必须存在 ──
 *
 * `getRepositories()` 缓存的是**一整个组合**，而组合里每个 repository
 * 都持有一个具体的数据库连接。测试若要在一个进程内切换到另一个库
 * （例如 `tests/course-reveal-endpoint.test.ts` 每个用例一个临时库），
 * 只改 `globalThis.__cet6Db` 是不够的 —— 组合仍然指向旧连接，
 * 于是断言会去检查一个**已经不在使用的库**。
 *
 * 那种失败特别危险：它看起来像"功能坏了"，实际是测试接错了库。
 * 因此这里给一个显式的重置入口，而不是让测试去摸模块内部状态。
 *
 * 生产代码**不得**调用它：那会让连接在请求之间被反复重建。
 */
export function __resetRepositoriesForTests(): void {
  cached = null;
}

/**
 * **只读** repository 集合：dry-run / 只读 / 列表 / 检查类命令专用。
 *
 * ── 为什么它必须存在（而不是"用 getRepositories 然后小心别写"）──
 *
 * `getRepositories()` → `getDb()` → `openDatabase()` 会执行 PRAGMA、
 * 建表、应用迁移并写 `schema_meta.schema_version`。**打开本身就是写**。
 * 因此一条自称"预演（dry-run，不写数据库）"的命令，只要走那条路，
 * 就可能在旧库上把它迁移掉 —— 使用者的真实库正是这样从 v8 变成 v9 的。
 *
 * 本函数用 `openDatabaseReadOnly` 打开连接：不建目录、不建表、不迁移、
 * 不写版本号。而且任何写入都会在 SQLite 层以
 * `attempt to write a readonly database` 失败 —— 因此"只读"是**结构性**保证，
 * 不依赖调用方自觉。
 *
 * 需要写入的命令（例如 `course:import --commit`）**必须**走
 * `getRepositories()`：那是显式请求数据库变更的入口，也正因如此它才有权触发迁移。
 */
export function createReadOnlyRepositories(dbFile: string): Repositories {
  return createSqliteRepositories(openDatabaseReadOnly(dbFile));
}

/**
 * 只读打开默认库（`CET6_DB_PATH` / `data/cet6.db`），不迁移、不创建。
 *
 * ── 为什么用 `getDbFile()` 而不是 `DB_FILE` 常量 ──
 *
 * 只读路径**每次调用都现算**库路径，因此"先 import、后设 CET6_DB_PATH"
 * 的进程（E2E 启动器、证明脚本）读到的会是**当前**那个库。
 * 用 import 时定下的常量会让这类调用方静默读到另一个库 ——
 * 而那种错误不报错、只让断言作用在错的库上。
 */
export function getReadOnlyRepositories(): Repositories {
  return createReadOnlyRepositories(getDbFile());
}

export type { MasteryLevel, ConfidenceLevel };
