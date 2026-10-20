import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { createTestDb, resetDb, transaction } from "@/db/client";
import { completeOnboarding, DEFAULT_ONBOARDING } from "@/services/onboarding";
import { startDiagnostic, submitDiagnostic } from "@/services/diagnostic";
import { ensurePlan } from "@/services/plan";
import { getTaskDetail, submitTask } from "@/services/practice";
import { DIAGNOSTIC_ITEMS } from "@/content/diagnostic-bank";
import type { Repositories } from "@/repositories/ports";

/**
 * MAJOR-2 · submitTask 原子性验证。
 *
 * 这些测试刻意在中途注入失败，然后**直接查询数据库**确认所有写入都被回滚。
 * 不允许只 mock 返回值——那样无法证明持久层真的回到了提交前状态。
 */

/** 包装 repository，使指定的第 N 次调用抛错。 */
function injectFault(
  repos: Repositories,
  target: { repo: "plan" | "skillProfile" | "review" | "records"; method: string },
  message = "injected test fault",
): Repositories {
  let tripped = false;
  const wrap = <T extends object>(obj: T, method: string): T => {
    const original = (obj as Record<string, unknown>)[method] as (...args: unknown[]) => unknown;
    const patched = (...args: unknown[]) => {
      if (!tripped) {
        tripped = true;
        throw new Error(message);
      }
      return original.apply(obj, args);
    };
    return new Proxy(obj, {
      get(target2, prop, receiver) {
        if (prop === method) return patched;
        return Reflect.get(target2, prop, receiver);
      },
    });
  };

  return {
    ...repos,
    [target.repo]: wrap(repos[target.repo], target.method),
  } as Repositories;
}

interface Fixture {
  repos: Repositories;
  db: DatabaseSync;
  profileId: string;
  taskId: string;
  questionIds: string[];
}

function makeFixture(): Fixture {
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

  // 完成诊断以建立画像
  const session = startDiagnostic(repos, profileId);
  submitDiagnostic(repos, {
    sessionId: session.id,
    answers: DIAGNOSTIC_ITEMS.filter((i) => i.type === "mcq").map((i) => ({
      itemId: i.id,
      dimension: i.dimension,
      choiceId: i.choices!.find((c) => c.id !== i.correctChoiceId)!.id,
      text: null,
      skipped: false,
    })),
  });

  const plan = ensurePlan(repos, profileId, "2026-09-28", { availableMinutes: 120 });
  /**
   * 载体从「阅读任务」改为「词汇任务」。
   *
   * ── 为什么必须换 ──
   * 这组测试验证的是 `submitTask` 的事务边界（一次提交的六类写入全有或全无），
   * 它需要的是**一个走旧闭环、且带多道客观题的任务**。
   * 阅读训练已经收敛到真实真题的 Expert Training 工作面（那条链路不写
   * `study_session` / `answer_attempt` / `review_item`），因此它不再是这个
   * 断言的有效载体 —— 继续用它只会让测试断言一个已不存在的路径。
   *
   * 词汇任务仍然走旧闭环，且同样是「多道客观题 + 答错进复习队列」，
   * 因此断言强度**完全不变**：注入的四个故障点、回滚计数、重试恰好一次，
   * 全部照原样验证。
   */
  const task = plan.tasks.find((t) => t.kind === "vocabulary_recall")!;
  const detail = getTaskDetail(repos, task.id)!;
  const content = detail.content as Extract<typeof detail.content, { type: "vocabulary_set" }>;
  const questions = content.entries.map((entry) => ({
    id: entry.id,
    correctChoiceId: entry.correctChoiceId,
    wrongChoiceId: entry.choices.find((c) => c.id !== entry.correctChoiceId)!.id,
  }));

  return {
    repos,
    db,
    profileId,
    taskId: task.id,
    // 第一题答错，其余答对 → 能同时验证"错答会产生复习项"
    questionIds: questions.map((q, index) => (index === 0 ? `WRONG:${q.id}` : q.id)),
  };
}

/** 直接查库的持久状态快照。 */
function snapshot(db: DatabaseSync, taskId: string) {
  const one = (sql: string, params: unknown[]) =>
    db.prepare(sql).get(...(params as never[])) as Record<string, unknown>;
  return {
    sessions: Number(one("SELECT COUNT(*) c FROM study_session", []).c),
    attempts: Number(one("SELECT COUNT(*) c FROM answer_attempt", []).c),
    reviewItems: Number(one("SELECT COUNT(*) c FROM review_item", []).c),
    taskStatus: String(one("SELECT status FROM study_task WHERE id = ?", [taskId]).status),
    skillProfileUpdatedAt: String(
      one("SELECT updated_at FROM skill_profile LIMIT 1", []).updated_at,
    ),
    skillProfileJson: String(one("SELECT skills FROM skill_profile LIMIT 1", []).skills),
    weaknessesJson: String(one("SELECT weaknesses FROM skill_profile LIMIT 1", []).weaknesses),
  };
}

function buildAnswers(questionIds: string[]) {
  return questionIds.map((raw) => {
    const isWrong = raw.startsWith("WRONG:");
    const id = raw.replace("WRONG:", "");
    return { questionId: id, markWrong: isWrong };
  });
}

function answersFor(fixture: Fixture) {
  return buildAnswers(fixture.questionIds).map(({ questionId, markWrong }) => {
    const detail = getTaskDetail(fixture.repos, fixture.taskId)!;
    const content = detail.content as Extract<typeof detail.content, { type: "vocabulary_set" }>;
    const q = content.entries.find((x) => x.id === questionId)!;
    return {
      questionId,
      choiceId: markWrong
        ? q.choices.find((c) => c.id !== q.correctChoiceId)!.id
        : q.correctChoiceId,
    };
  });
}

describe("MAJOR-2 · submitTask 原子性（故障注入 + 真实数据库状态检查）", () => {
  const fixtures: Fixture[] = [];

  afterEach(() => {
    fixtures.length = 0;
  });

  it("正常提交：所有写入都生效（对照基线）", async () => {
    const f = makeFixture();
    fixtures.push(f);
    const before = snapshot(f.db, f.taskId);
    expect(before.sessions).toBe(0);
    expect(before.attempts).toBe(0);
    expect(before.taskStatus).toBe("pending");

    const result = await submitTask(f.repos, f.profileId, {
      taskId: f.taskId,
      answers: answersFor(f),
      writing: "",
      reviewedItemIds: [],
    });

    expect(result.ok).toBe(true);
    const after = snapshot(f.db, f.taskId);
    expect(after.sessions).toBe(1);
    expect(after.attempts).toBeGreaterThan(0);
    expect(after.taskStatus).toBe("completed");
    expect(after.reviewItems).toBe(1); // 第一题答错
  });

  it("注入点 1：任务完成状态写入失败 → 全部回滚，无孤儿 session/attempt", async () => {
    const f = makeFixture();
    fixtures.push(f);
    const before = snapshot(f.db, f.taskId);

    f.repos = injectFault(f.repos, { repo: "plan", method: "updateTaskStatus" });

    await expect(
      submitTask(f.repos, f.profileId, {
        taskId: f.taskId,
        answers: answersFor(f),
        writing: "",
        reviewedItemIds: [],
      }),
    ).rejects.toThrow(/injected test fault/);

    const after = snapshot(f.db, f.taskId);
    expect(after, "session 未回滚").toEqual(before);
    expect(after.sessions).toBe(0);
    expect(after.attempts).toBe(0);
    expect(after.taskStatus).toBe("pending");
    expect(after.reviewItems).toBe(0);
  });

  it("注入点 2：画像证据回写失败 → 全部回滚，画像未变", async () => {
    const f = makeFixture();
    fixtures.push(f);
    const before = snapshot(f.db, f.taskId);

    f.repos = injectFault(f.repos, { repo: "skillProfile", method: "save" });

    await expect(
      submitTask(f.repos, f.profileId, {
        taskId: f.taskId,
        answers: answersFor(f),
        writing: "",
        reviewedItemIds: [],
      }),
    ).rejects.toThrow(/injected test fault/);

    const after = snapshot(f.db, f.taskId);
    expect(after).toEqual(before);
    expect(after.skillProfileJson).toBe(before.skillProfileJson);
    expect(after.taskStatus).toBe("pending");
  });

  it("注入点 3：复习项创建失败 → 全部回滚，无残留复习项", async () => {
    const f = makeFixture();
    fixtures.push(f);
    const before = snapshot(f.db, f.taskId);

    f.repos = injectFault(f.repos, { repo: "review", method: "upsert" });

    await expect(
      submitTask(f.repos, f.profileId, {
        taskId: f.taskId,
        answers: answersFor(f),
        writing: "",
        reviewedItemIds: [],
      }),
    ).rejects.toThrow(/injected test fault/);

    const after = snapshot(f.db, f.taskId);
    expect(after).toEqual(before);
    expect(after.reviewItems).toBe(0);
    expect(after.taskStatus).toBe("pending");
  });

  it("注入点 4：answer_attempt 写入中途失败 → session 与 attempts 一并回滚", async () => {
    const f = makeFixture();
    fixtures.push(f);
    const before = snapshot(f.db, f.taskId);

    f.repos = injectFault(f.repos, { repo: "records", method: "saveAttempts" });

    await expect(
      submitTask(f.repos, f.profileId, {
        taskId: f.taskId,
        answers: answersFor(f),
        writing: "",
        reviewedItemIds: [],
      }),
    ).rejects.toThrow(/injected test fault/);

    const after = snapshot(f.db, f.taskId);
    expect(after).toEqual(before);
    expect(after.sessions, "孤儿 session 必须被回滚").toBe(0);
    expect(after.attempts).toBe(0);
  });

  it("回滚后重新正常提交：恰好成功一次", async () => {
    const f = makeFixture();
    fixtures.push(f);

    // 先注入一次失败
    f.repos = injectFault(f.repos, { repo: "plan", method: "updateTaskStatus" });
    await expect(
      submitTask(f.repos, f.profileId, {
        taskId: f.taskId,
        answers: answersFor(f),
        writing: "",
        reviewedItemIds: [],
      }),
    ).rejects.toThrow();

    // 恢复为正常 repository（重建，避免残留的 fault 包装）
    f.repos = createSqliteRepositories(f.db);

    const retry = await submitTask(f.repos, f.profileId, {
      taskId: f.taskId,
      answers: answersFor(f),
      writing: "",
      reviewedItemIds: [],
    });
    expect(retry.ok, retry.ok ? "" : retry.error).toBe(true);

    const after = snapshot(f.db, f.taskId);
    expect(after.sessions, "重试后应恰好 1 条 session").toBe(1);
    expect(after.taskStatus).toBe("completed");

    // 再提交一次必须被拒（重复提交保护仍在）
    const duplicate = await submitTask(f.repos, f.profileId, {
      taskId: f.taskId,
      answers: answersFor(f),
      writing: "",
      reviewedItemIds: [],
    });
    expect(duplicate.ok).toBe(false);
    if (!duplicate.ok) expect(duplicate.error).toContain("已经完成");

    const final = snapshot(f.db, f.taskId);
    expect(final.sessions, "重复提交不得新增 session").toBe(1);
  });
});

describe("可重入事务机制", () => {
  it("内层使用 SAVEPOINT，嵌套调用不再抛 'cannot start a transaction within a transaction'", () => {
    const db = createTestDb();
    resetDb(db);

    // 旧实现会在此抛错；新实现必须成功
    const result = transaction(db, () => {
      db.exec(
        "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES ('a','A',1,1,'t','t')",
      );
      const inner = transaction(db, () => {
        db.exec(
          "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES ('b','B',1,1,'t','t')",
        );
        return "inner-ok";
      });
      return inner;
    });

    expect(result).toBe("inner-ok");
    const count = db.prepare("SELECT COUNT(*) c FROM learner_profile").get() as { c: number };
    expect(count.c).toBe(2);
  });

  it("内层失败只回滚内层，外层已写入的数据保留", () => {
    const db = createTestDb();
    resetDb(db);

    transaction(db, () => {
      db.exec(
        "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES ('outer','X',1,1,'t','t')",
      );
      expect(() =>
        transaction(db, () => {
          db.exec(
            "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES ('inner','Y',1,1,'t','t')",
          );
          throw new Error("inner failure");
        }),
      ).toThrow("inner failure");
    });

    const rows = db.prepare("SELECT id FROM learner_profile ORDER BY id").all() as Array<{ id: string }>;
    expect(rows.map((r) => r.id)).toEqual(["outer"]);
  });

  it("最外层失败时整个事务回滚（含已成功的内层）", () => {
    const db = createTestDb();
    resetDb(db);

    expect(() =>
      transaction(db, () => {
        db.exec(
          "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES ('a','A',1,1,'t','t')",
        );
        transaction(db, () => {
          db.exec(
            "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES ('b','B',1,1,'t','t')",
          );
        });
        throw new Error("outer failure");
      }),
    ).toThrow("outer failure");

    const count = db.prepare("SELECT COUNT(*) c FROM learner_profile").get() as { c: number };
    expect(count.c, "外层失败应回滚全部").toBe(0);
  });

  it("事务结束后 isTransaction 回到 false，连接可继续使用", () => {
    const db = createTestDb();
    resetDb(db);
    transaction(db, () => {
      db.exec(
        "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES ('x','X',1,1,'t','t')",
      );
    });
    expect(db.isTransaction).toBe(false);
    // 后续独立事务仍可用
    expect(() =>
      transaction(db, () => {
        db.exec("DELETE FROM learner_profile");
      }),
    ).not.toThrow();
  });
});
