import type { DatabaseSync } from "node:sqlite";
import { newId } from "@/lib/id";
import { nowISO } from "@/lib/date";
import { transaction } from "@/db/client";
import type {
  AssessmentEvent,
  EvidenceProjectionRow,
  LearningRun,
  PerformanceEvent,
} from "@/domain/models";
import { signalFor } from "@/domain/expert-training";
import type {
  AssessmentEventInput,
  ExpertRepository,
  LearningRunInput,
  PerformanceEventInput,
} from "../ports";
import { RunNotCompletableError } from "../ports";
import { allRows, firstRow, fromBool, json, toBool, toInt, toJson, toNullableText, toText, type Row } from "./support";

/**
 * Expert Training 事实台账的 SQLite 实现。
 *
 * 设计要点（与 ports.ts 的契约一致）：
 *
 * 1. **只追加。** 本类不提供 update / delete。数据库侧另有触发器兜底，
 *    所以即使有人绕过本类直接写 SQL 也无法改写历史。
 * 2. **观测不含解释。** 写入的字段就是"发生了什么"，
 *    没有 mechanism / weakness / errorTag 之类的因果列。
 * 3. **内容版本参与引用。** 同 (paper_id, section_id, group_id, question_id)
 *    在不同 content_version 下是**不同的**历史条目，绝不合并。
 */

/**
 * 会话不能被完成时抛出的错误 —— 从端口层重新导出，保持实现的调用方不受影响。
 * 定义在 `ports.ts`，因为服务层需要按类型做响应映射而无需依赖具体存储。
 */
export { RunNotCompletableError } from "../ports";

function mapRun(row: Row): LearningRun {
  return {
    id: toText(row.id),
    profileId: toText(row.profile_id),
    paperId: toText(row.paper_id),
    contentVersion: toInt(row.content_version),
    sectionId: toText(row.section_id),
    sectionType: toText(row.section_type),
    groupIds: toJson<string[]>(row.group_ids, []),
    status: toText(row.status) as LearningRun["status"],
    itemCount: toInt(row.item_count),
    startedAt: toText(row.started_at),
    submittedAt: toNullableText(row.submitted_at),
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined
      ? null
      : toInt(row.duration_seconds),
    createdAt: toText(row.created_at),
  };
}

function mapEvent(row: Row): PerformanceEvent {
  return {
    id: toText(row.id),
    runId: toText(row.run_id),
    profileId: toText(row.profile_id),
    paperId: toText(row.paper_id),
    contentVersion: toInt(row.content_version),
    sectionId: toText(row.section_id),
    groupId: toText(row.group_id),
    questionId: toText(row.question_id),
    questionNumber: row.question_number === null || row.question_number === undefined
      ? null
      : toInt(row.question_number),
    questionKind: toText(row.question_kind),
    responseKind: toText(row.response_kind),
    responseValue: toNullableText(row.response_value),
    outcome: toText(row.outcome) as PerformanceEvent["outcome"],
    durationSeconds: row.duration_seconds === null || row.duration_seconds === undefined
      ? null
      : toInt(row.duration_seconds),
    answerChanged: toBool(row.answer_changed),
    attemptKind: toText(row.attempt_kind) as PerformanceEvent["attemptKind"],
    gradingSource: toText(row.grading_source),
    gradingVersion: toText(row.grading_version),
    sequence: toInt(row.sequence),
    occurredAt: toText(row.occurred_at),
  };
}

function mapAssessment(row: Row): AssessmentEvent {
  return {
    id: toText(row.id),
    performanceEventId: toText(row.performance_event_id),
    rubricVersion: toText(row.rubric_version),
    outcome: toText(row.outcome) as AssessmentEvent["outcome"],
    score: toInt(row.score),
    gradingSource: toText(row.grading_source),
    supersedesId: toNullableText(row.supersedes_id),
    note: toNullableText(row.note),
    assessedAt: toText(row.assessed_at),
  };
}

export class SqliteExpertRepository implements ExpertRepository {
  constructor(private readonly db: DatabaseSync) {}

  startRun(input: LearningRunInput): LearningRun {
    const id = input.id || newId();
    this.db
      .prepare(
        `INSERT INTO learning_run
           (id, profile_id, paper_id, content_version, section_id, section_type, group_ids,
            status, item_count, started_at, submitted_at, duration_seconds, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'in_progress', ?, ?, NULL, NULL, ?)`,
      )
      .run(
        id,
        input.profileId,
        input.paperId,
        input.contentVersion,
        input.sectionId,
        input.sectionType,
        json(input.groupIds),
        input.itemCount,
        input.startedAt,
        nowISO(),
      );
    return this.getRun(id)!;
  }

  getRun(runId: string): LearningRun | null {
    const row = firstRow(this.db, "SELECT * FROM learning_run WHERE id = ?", [runId]);
    return row ? mapRun(row) : null;
  }

  listRuns(profileId: string, limit: number): LearningRun[] {
    return allRows(
      this.db,
      "SELECT * FROM learning_run WHERE profile_id = ? ORDER BY created_at DESC LIMIT ?",
      [profileId, limit],
    ).map(mapRun);
  }

  /**
   * 进行中的会话。语义见 ports.ts —— 它必须优先于"最近已完成"。
   *
   * 若因历史原因存在多个（例如早先版本留下），返回**最新创建**的那个，
   * 因为那是用户实际在用的那个。
   */
  findInProgressRun(
    profileId: string,
    paperId: string,
    contentVersion: number,
    sectionId: string,
  ): LearningRun | null {
    const row = firstRow(
      this.db,
      `SELECT * FROM learning_run
       WHERE profile_id = ? AND paper_id = ? AND content_version = ? AND section_id = ?
         AND status = 'in_progress'
       ORDER BY created_at DESC LIMIT 1`,
      [profileId, paperId, contentVersion, sectionId],
    );
    return row ? mapRun(row) : null;
  }

  /** 最近完成的会话。仅在"没有进行中会话"时才应当被使用。 */
  findLatestCompletedRun(
    profileId: string,
    paperId: string,
    contentVersion: number,
    sectionId: string,
  ): LearningRun | null {
    const row = firstRow(
      this.db,
      `SELECT * FROM learning_run
       WHERE profile_id = ? AND paper_id = ? AND content_version = ? AND section_id = ?
         AND status = 'completed'
       ORDER BY submitted_at DESC, created_at DESC LIMIT 1`,
      [profileId, paperId, contentVersion, sectionId],
    );
    return row ? mapRun(row) : null;
  }

  /** 跨内容版本的进行中会话。用于"内容已升版，旧会话需要重开"这条路径。 */
  findAnyInProgressRun(
    profileId: string,
    paperId: string,
    sectionId: string,
  ): LearningRun | null {
    const row = firstRow(
      this.db,
      `SELECT * FROM learning_run
       WHERE profile_id = ? AND paper_id = ? AND section_id = ?
         AND status = 'in_progress'
       ORDER BY created_at DESC LIMIT 1`,
      [profileId, paperId, sectionId],
    );
    return row ? mapRun(row) : null;
  }

  /**
   * 废弃一个未提交的会话。
   *
   * `WHERE status = 'in_progress'` 是安全阀：已完成的会话不会被这条语句碰到，
   * 因此"废弃"在原理上不可能被用来改写历史。若目标不是进行中的会话，
   * 这里返回 null，调用方必须按"未废弃"处理。
   */
  abandonRun(runId: string): LearningRun | null {
    const updated = this.db
      .prepare("UPDATE learning_run SET status = 'abandoned' WHERE id = ? AND status = 'in_progress'")
      .run(runId);
    if (Number(updated.changes) === 0) return null;
    return this.getRun(runId);
  }

  /**
   * 完成一次会话。**恰好一次**由数据库的条件认领保证。
   *
   * 顺序刻意是「**先认领、后写事件**」：
   *
   * 1. `UPDATE learning_run SET status='completed' ... WHERE id=? AND status='in_progress'`
   *    —— 这是**认领**。改到 0 行说明这个会话已经被完成过（或已废弃/不存在），
   *    立即抛 `RunNotCompletableError`，本次调用不写任何事件。
   * 2. 认领成功后才追加观测与评估。
   *
   * 反过来（先写事件、后无条件标完成）会让两个并发/重放提交**都写完事件**
   * 才发现会话已不再是 in_progress —— 重复的观测那时已经在事务里了。
   * 把认领放在最前，第二个提交在第一步就被挡下，事件集为空。
   *
   * 整个方法在自己的事务里运行（可重入：调用方再包一层时用 SAVEPOINT 嵌套），
   * 因此认领之后任何时候失败，认领本身也会回滚 —— 不会留下"已完成但没有观测"
   * 或"认领了却没写成"的半状态。
   */
  completeRun(input: {
    runId: string;
    submittedAt: string;
    durationSeconds: number | null;
    events: PerformanceEventInput[];
    assessments: AssessmentEventInput[];
  }): LearningRun {
    return transaction(this.db, () => {
      // ---- 1) 条件认领：唯一允许进入写入路径的入口 ----
      const claim = this.db
        .prepare(
          `UPDATE learning_run
           SET status = 'completed', submitted_at = ?, duration_seconds = ?
           WHERE id = ? AND status = 'in_progress'`,
        )
        .run(input.submittedAt, input.durationSeconds, input.runId);

      if (Number(claim.changes) === 0) {
        // 读回真实状态，让错误可诊断（已完成 / 已废弃 / 不存在）
        const current = firstRow(this.db, "SELECT status FROM learning_run WHERE id = ?", [input.runId]);
        throw new RunNotCompletableError(
          input.runId,
          current ? toText(current.status) : null,
        );
      }

      // ---- 2) 认领成功，本次调用独占写入权 ----
      const eventStmt = this.db.prepare(
        `INSERT INTO performance_event
           (id, run_id, profile_id, paper_id, content_version, section_id, group_id, question_id,
            question_number, question_kind, response_kind, response_value, outcome, duration_seconds,
            answer_changed, attempt_kind, grading_source, grading_version, sequence, occurred_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const assessmentStmt = this.db.prepare(
        `INSERT INTO assessment_event
           (id, performance_event_id, rubric_version, outcome, score, grading_source,
            supersedes_id, note, assessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );

      const eventIds: string[] = [];
      for (const event of input.events) {
        const id = newId();
        eventIds.push(id);
        eventStmt.run(
          id,
          input.runId,
          event.profileId,
          event.paperId,
          event.contentVersion,
          event.sectionId,
          event.groupId,
          event.questionId,
          event.questionNumber,
          event.questionKind,
          event.responseKind,
          event.responseValue,
          event.outcome,
          event.durationSeconds,
          fromBool(event.answerChanged),
          event.attemptKind,
          event.gradingSource,
          event.gradingVersion,
          event.sequence,
          event.occurredAt,
        );
      }

      // 评估与观测一一对应（按顺序），因此用下标关联，不依赖调用方传 id。
      input.assessments.forEach((assessment, index) => {
        const performanceEventId = eventIds[index];
        if (!performanceEventId) return; // 没有对应观测的评估不写入 —— 评估必须挂在观测上
        assessmentStmt.run(
          newId(),
          performanceEventId,
          assessment.rubricVersion,
          assessment.outcome,
          assessment.score,
          assessment.gradingSource,
          assessment.supersedesId ?? null,
          assessment.note ?? null,
          assessment.assessedAt,
        );
      });

      return this.getRun(input.runId)!;
    });
  }

  listEventsForRun(runId: string): PerformanceEvent[] {
    return allRows(
      this.db,
      "SELECT * FROM performance_event WHERE run_id = ? ORDER BY sequence ASC",
      [runId],
    ).map(mapEvent);
  }

  listEventsForQuestion(
    profileId: string,
    ref: { paperId: string; contentVersion: number; sectionId: string; groupId: string; questionId: string },
  ): PerformanceEvent[] {
    return allRows(
      this.db,
      `SELECT * FROM performance_event
       WHERE profile_id = ? AND paper_id = ? AND content_version = ?
         AND section_id = ? AND group_id = ? AND question_id = ?
       ORDER BY occurred_at DESC`,
      [profileId, ref.paperId, ref.contentVersion, ref.sectionId, ref.groupId, ref.questionId],
    ).map(mapEvent);
  }

  listAssessmentsForRun(runId: string): AssessmentEvent[] {
    return allRows(
      this.db,
      `SELECT a.* FROM assessment_event a
       JOIN performance_event e ON e.id = a.performance_event_id
       WHERE e.run_id = ?
       ORDER BY a.assessed_at ASC`,
      [runId],
    ).map(mapAssessment);
  }

  appendAssessment(input: AssessmentEventInput): AssessmentEvent {
    // 重评必须显式指向它重新评价的那条观测。
    // 允许缺省会让"评估"变成悬空记录 —— 评估的意义就在于它有评价对象。
    const performanceEventId = input.performanceEventId;
    if (!performanceEventId) {
      throw new Error("appendAssessment 需要 performanceEventId：评估必须挂在一条观测上。");
    }
    const id = newId();
    this.db
      .prepare(
        `INSERT INTO assessment_event
           (id, performance_event_id, rubric_version, outcome, score, grading_source,
            supersedes_id, note, assessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        performanceEventId,
        input.rubricVersion,
        input.outcome,
        input.score,
        input.gradingSource,
        input.supersedesId ?? null,
        input.note ?? null,
        input.assessedAt,
      );
    const row = firstRow(this.db, "SELECT * FROM assessment_event WHERE id = ?", [id]);
    return mapAssessment(row!);
  }

  /**
   * 整体重算投影。
   *
   * 为什么"先删后写"是安全的：`evidence_projection` **不是事实来源**，
   * 它完全由不可变的 `performance_event` 派生。删空后立刻重算得到同一结果，
   * 因此这里不存在"丢失数据"的可能 —— 真正不可删除的是事件表。
   *
   * 重算口径刻意**只有低层事实**：正确的次数、错误的次数、未作答的次数。
   * 不产生"阅读能力 0.7"这类推断值。
   */
  rebuildProjection(profileId: string): EvidenceProjectionRow[] {
    const rows = allRows(
      this.db,
      `SELECT outcome, COUNT(*) AS c FROM performance_event
       WHERE profile_id = ? GROUP BY outcome`,
      [profileId],
    );

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(signalFor(toText(row.outcome) as PerformanceEvent["outcome"]), toInt(row.c));
    }

    const computedAt = nowISO();
    this.db.prepare("DELETE FROM evidence_projection WHERE profile_id = ?").run(profileId);

    const insert = this.db.prepare(
      `INSERT INTO evidence_projection (profile_id, signal, value, computed_at) VALUES (?, ?, ?, ?)`,
    );
    const result: EvidenceProjectionRow[] = [];
    for (const signal of ["answer.correct", "answer.incorrect", "answer.skipped"] as const) {
      const value = counts.get(signal) ?? 0;
      insert.run(profileId, signal, value, computedAt);
      result.push({ profileId, signal, value, computedAt });
    }
    return result;
  }

  readProjection(profileId: string): EvidenceProjectionRow[] {
    return allRows(
      this.db,
      "SELECT * FROM evidence_projection WHERE profile_id = ? ORDER BY signal ASC",
      [profileId],
    ).map((row) => ({
      profileId: toText(row.profile_id),
      signal: toText(row.signal),
      value: toInt(row.value),
      computedAt: toText(row.computed_at),
    }));
  }
}
