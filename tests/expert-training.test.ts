import { describe, expect, it, beforeEach, afterAll, afterEach } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { TempCleanupError } from "../tools/temp-workspace.mjs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createTestDb } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import type { Repositories } from "@/repositories/ports";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";
import { runImport } from "@/services/paper-import";
import { getPaperDetail } from "@/services/papers";
import {
  getReadingSession,
  getSectionTrainingState,
  listReadingTargets,
  startReadingRun,
  submitReadingRun,
} from "@/services/expert-training";
import { gradeResponse, normalizeAnswerValue, reliableDuration } from "@/domain/expert-training";
import { commitAnswer, isAnswerChangedForSubmission } from "@/domain/expert-training";
import { RunNotCompletableError } from "@/repositories/ports";
import type { PaperQuestion } from "@/content/paper";

/**
 * Expert Training V1 的门禁测试。
 *
 * 覆盖三件事，每件都对应任务里的一条硬要求：
 * 1. **确定性判分** —— 判据只来自真题答案，且未作答不等于答错；
 * 2. **不可变台账** —— 历史观测不能被就地改写，重评只能追加；
 * 3. **真实试卷训练链路** —— 开始 → 作答 → 提交 → 结果 → 回看，且旧路径不受影响。
 *
 * 测试用**合成夹具**（`sourceKind: "test_fixture"`，由夹具构造器写死）。
 * 见 content-policy/PRODUCT_PRINCIPLES.md 第 6.1 节：夹具可合成，但绝不作为学习者内容出现。
 */

let repoDir: string;
let db: DatabaseSync;
let repos: Repositories;
let contentRoot: string;

/*
 * ── The environment variable must be **restored**, not merely deleted ──
 *
 * `beforeEach` sets `CET6_CONTENT_ROOT`; the previous `afterEach` did
 * `delete process.env.CET6_CONTENT_ROOT`. That is correct only when the variable
 * was unset to begin with. If the surrounding shell exports it (a developer
 * running the suite with a content root configured, or another test file in the
 * same worker), deleting it destroys state this file never owned, and every later
 * test in that worker sees a different environment than it started with.
 */
const ORIGINAL_CONTENT_ROOT = process.env.CET6_CONTENT_ROOT;

/**
 * ── Why cleanup is per-test, and why its failure fails the test ──
 *
 * `beforeEach` creates a fresh temporary directory *and* a fresh native SQLite
 * handle for every test, but the original cleanup ran only from
 * `process.on("exit")` and only removed the **last** `repoDir` — so running the
 * file left one directory per test behind. Measured: a full suite run accumulated
 * dozens of `cet6-expert-*` directories.
 *
 * Two further defects were in that cleanup, both found in review:
 *
 *   1. The `catch` printed a line beginning with `FAIL` and then **continued**.
 *      Nothing failed: the test counted as passed and the process exited 0 while a
 *      directory stayed behind. A log line is not a verdict.
 *   2. `repoDir = ""` ran unconditionally, so after a failed removal the reference
 *      was lost and the exit hook had nothing left to retry. The leftover became
 *      untracked at exactly the moment tracking mattered.
 *
 * So: removal failure now **throws**, which fails the test, and the reference is
 * only cleared once the directory is verifiably gone. On failure the path stays
 * registered with the shared helper, so the process-exit handler makes one more
 * attempt — the two layers do not conflict because `rmSync(..., {force:true})` on
 * an absent path is a no-op.
 */
afterEach(() => {
  /*
   * ── Structure: every step must run even if an earlier one fails ──
   *
   * The previous version ran close → assertRemoved → restoreEnv in sequence. When
   * `assertRemoved` threw, the environment restore never executed, so
   * `CET6_CONTENT_ROOT` stayed pointing at the doomed per-test directory —
   * measured: after a failed cleanup the variable held the test's own path instead
   * of the pre-test value (or instead of being absent). Every later test in that
   * worker then saw a different environment than it started with.
   *
   * A `finally` is the reliable structure, and it is deliberately outermost: the
   * environment restore must not depend on whether the database closed or the
   * directory was removed. Failures are collected rather than replacing each
   * other, so the original verdict and the cleanup evidence both survive.
   *
   * Ordering is also deliberate: the native handle closes **before** the tree is
   * deleted, because on Windows an open handle keeps the containing directory busy
   * and that is precisely how such a removal fails intermittently.
   */
  let failure: unknown;

  /* 1. Close the native handle first. */
  try {
    closeDatabaseHandle();
  } catch (error) {
    failure = error;
  }

  /* 2. Remove the directory, preserving ownership if it survives. */
  try {
    if (repoDir) {
      assertRemoved(repoDir);
      /* Cleared only once verifiably gone, so a leftover stays registered. */
      repoDir = "";
    }
  } catch (error) {
    if (failure === undefined) {
      failure = error;
    } else {
      /* Both failed: keep the original as primary, retain the secondary too. */
      attachSecondaryError(failure, error);
    }
  } finally {
    /* 3. Restore the environment — unconditionally, whatever happened above. */
    restoreContentRootEnv();
  }

  if (failure !== undefined) throw failure;
});

/**
 * Close the SQLite handle, distinguishing "already closed" from a real fault.
 *
 * `db.close()` on an already-closed handle is expected here (the `afterAll` sweep
 * closes it again), so that specific condition is tolerated. Any *other* error is
 * real and must not be swallowed: the previous `catch {}` hid every failure,
 * including ones that would explain a later removal failure.
 */
function closeDatabaseHandle(): void {
  try {
    db?.close();
  } catch (error) {
    /*
     * `node:sqlite` raises this for a handle that is already closed. Tolerate only
     * that shape; re-raise everything else so a genuine fault is not masked.
     */
    const code = (error as { code?: unknown } | null)?.code;
    const message = error instanceof Error ? error.message : "";
    const alreadyClosed =
      code === "ERR_INVALID_STATE" || /database is not open|already closed/i.test(message);
    if (!alreadyClosed) throw error;
  }
}

/**
 * Restore `CET6_CONTENT_ROOT` to exactly what it was before the file ran.
 *
 * Deleting it unconditionally was wrong whenever the surrounding shell exported it:
 * that destroys state this file never owned. Restoring the captured value (or
 * deleting when it was absent) is the only form correct in both cases.
 */
function restoreContentRootEnv(): void {
  if (ORIGINAL_CONTENT_ROOT === undefined) {
    delete process.env.CET6_CONTENT_ROOT;
    return;
  }
  process.env.CET6_CONTENT_ROOT = ORIGINAL_CONTENT_ROOT;
}

/**
 * Attach a secondary failure to the primary one without losing either.
 *
 * The primary is re-thrown by the caller, so it stays the visible verdict; the
 * secondary rides along on `cleanupError` and is also printed, because a cleanup
 * problem that only exists inside an object nobody inspects has not been reported.
 */
function attachSecondaryError(primary: unknown, secondary: unknown): void {
  if (primary !== null && typeof primary === "object") {
    try {
      (primary as { cleanupError?: unknown }).cleanupError = secondary;
    } catch {
      /* a frozen error object must not lose the secondary entirely */
    }
  }
  const text = secondary instanceof Error ? secondary.message : String(secondary);
  console.error(`FAIL  (secondary) ${text}`);
}

/**
 * Remove `dir` and fail loudly if it survives.
 *
 * "Did not throw" is not "is gone": `rmSync` can return while the path remains (a
 * busy handle on Windows, a partially removed tree). The verdict is the existence
 * check, not the absence of an exception.
 *
 * ── Why the underlying error text is NOT included ──
 *
 * A Node filesystem error's message embeds the absolute path it failed on
 * (`EPERM: operation not permitted, rmdir '<drive>:\Users\<account>\AppData\...'`).
 * Concatenating it into our own error put the local account path into a test
 * failure that CI publishes. Only a whitelisted error code is carried through —
 * the same rule `tools/temp-workspace.mjs` applies — because the code identifies
 * the *kind* of failure without disclosing the location.
 */
function assertRemoved(dir: string): void {
  let failureCode = "CLEANUP_FAILED";
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
  } catch (error) {
    failureCode = safeErrorCode(error);
  }
  if (existsSync(dir)) {
    /* The code is passed directly: no cause object is retained, by design. */
    throw new TempCleanupError(redactForLog(dir), undefined, failureCode);
  }
}

/**
 * Reduce a filesystem error to a short, safe code.
 *
 * Mirrors the allow-list in `tools/temp-workspace.mjs`: a known code passes
 * through, anything else becomes `CLEANUP_FAILED`. The list is duplicated rather
 * than imported because this file's assertions run under the test runner and the
 * helper's internal table is not part of its public surface.
 */
function safeErrorCode(error: unknown): string {
  const ALLOWED = new Set([
    "EACCES", "EBUSY", "EEXIST", "EISDIR", "EMFILE", "ENOENT",
    "ENOTDIR", "ENOTEMPTY", "EPERM", "EROFS",
  ]);
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && ALLOWED.has(code) ? code : "CLEANUP_FAILED";
}

/** Redact the account-bearing prefix; only the generated leaf name is shown. */
function redactForLog(dir: string): string {
  return `<temp>/${dir.split(/[\\/]/).filter(Boolean).pop() ?? ""}`;
}

beforeEach(() => {
  repoDir = mkdtempSync(join(tmpdir(), "cet6-expert-"));
  contentRoot = join(repoDir, "content");
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);

  /* 导入一份完整夹具试卷，得到一个真实的"试卷 → 大题 → 题目"结构 */
  const fixture = buildFixturePackage({ id: "fixture-cet6-2024-12-set1" });
  writeFixturePackage(contentRoot, "2024-12-set1", fixture);
  const result = runImport(repos, { dryRun: false });
  expect(result.ok, `夹具导入失败：${result.error ?? ""}`).toBe(true);
});

function onboard(): string {
  const profile = repos.learner.saveProfile(null, {
    displayName: "Learner",
    preferences: { weekdayMinutes: 60, weekendMinutes: 120 },
    examName: "CET-6",
    examDate: "2026-12-12",
    targetScore: 550,
  });
  return profile.id;
}

function readingSectionId(type: string): string {
  const detail = repos.papers.listPapers()[0];
  const listed = listReadingTargets(repos, onboard(), detail.id);
  const target = listed?.targets.find((item) => item.sectionType === type);
  if (!target) throw new Error(`夹具里没有可训练的 ${type} 大题`);
  return target.sectionId;
}

/**
 * 仅测试用：从**原始内容**读取正确答案。
 *
 * 为什么必须这样写：面向作答界面的视图（`TrainingQuestionView`）**刻意不含
 * `answer` 字段**，因此测试也无法从它那里拿到答案 —— 这正是要验证的性质。
 * 测试要构造"答对"，就得绕过产品视图、直接读内容层，
 * 这恰好证明了答案只在服务端判分时才被读取。
 */
function rawAnswerValue(sectionId: string, questionId: string): string | null {
  const paper = repos.papers.listPapers()[0];
  const detail = getPaperDetail(repos, paper.id);
  const section = detail?.content?.sections.find((item) => item.id === sectionId);
  const question = section?.groups
    .flatMap((group) => group.questions)
    .find((item) => item.id === questionId);
  if (!question) return null;
  switch (question.kind) {
    case "mcq":
      return question.answer;
    case "banked_cloze_blank":
      return question.answer;
    case "matching_statement":
      return question.answerParagraph;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// 确定性判分（纯函数）
// ---------------------------------------------------------------------------

describe("确定性判分：只用真题答案，不做推断", () => {
  const mcq: PaperQuestion = {
    id: "q1",
    kind: "mcq",
    number: 46,
    order: 0,
    explanation: null,
    stem: "Fixture stem",
    options: [
      { id: "A", label: "Option A" },
      { id: "B", label: "Option B" },
    ],
    answer: "B",
  };

  const blank: PaperQuestion = {
    id: "b1",
    kind: "banked_cloze_blank",
    number: 26,
    order: 0,
    explanation: null,
    blankId: "1",
    answer: "word1",
  };

  const matching: PaperQuestion = {
    id: "m1",
    kind: "matching_statement",
    number: 36,
    order: 0,
    explanation: null,
    statement: "Fixture statement",
    answerParagraph: "B",
  };

  it("答对 / 答错 / 未作答是三种互不等价的结论", () => {
    expect(gradeResponse(mcq, { questionId: "q1", kind: "choice", value: "B" }).outcome).toBe("correct");
    expect(gradeResponse(mcq, { questionId: "q1", kind: "choice", value: "A" }).outcome).toBe("incorrect");
    // 关键：未作答**不是**答错 —— 它没有产生证据
    expect(gradeResponse(mcq, { questionId: "q1", kind: "choice", value: null }).outcome).toBe("skipped");
    expect(gradeResponse(mcq, null).outcome).toBe("skipped");
    expect(gradeResponse(mcq, { questionId: "q1", kind: "choice", value: "   " }).outcome).toBe("skipped");
  });

  it("选词填空按词本身判定，大小写与空白不构成错误", () => {
    expect(gradeResponse(blank, { questionId: "b1", kind: "blank", value: "word1" }).outcome).toBe("correct");
    expect(gradeResponse(blank, { questionId: "b1", kind: "blank", value: " Word1 " }).outcome).toBe("correct");
    expect(gradeResponse(blank, { questionId: "b1", kind: "blank", value: "word2" }).outcome).toBe("incorrect");
  });

  it("匹配题按段落标号判定", () => {
    expect(gradeResponse(matching, { questionId: "m1", kind: "paragraph", value: "B" }).outcome).toBe("correct");
    expect(gradeResponse(matching, { questionId: "m1", kind: "paragraph", value: "A" }).outcome).toBe("incorrect");
  });

  it("不做'接近就算对'的模糊匹配", () => {
    // 编辑距离、同义、词形归并都不被接受
    expect(gradeResponse(blank, { questionId: "b1", kind: "blank", value: "word" }).outcome).toBe("incorrect");
    expect(gradeResponse(blank, { questionId: "b1", kind: "blank", value: "words1" }).outcome).toBe("incorrect");
    expect(normalizeAnswerValue("  Word1  ")).toBe("word1");
  });

  it("反馈不含机制推断措辞", () => {
    const graded = gradeResponse(mcq, { questionId: "q1", kind: "choice", value: "A" });
    // 反馈由服务层组装；这里断言判定结果里没有承载解释的字段
    expect(Object.keys(graded)).not.toContain("mechanism");
    expect(Object.keys(graded)).not.toContain("weakness");
    expect(Object.keys(graded)).not.toContain("errorTag");
  });

  it("不可靠的计时被丢弃，而不是写进台账", () => {
    expect(reliableDuration(120)).toBe(120);
    expect(reliableDuration(0)).toBeNull(); // 0 秒不是测量
    expect(reliableDuration(-5)).toBeNull();
    expect(reliableDuration(60 * 60)).toBeNull(); // 1 小时：更像离开页面，不是作答用时
    expect(reliableDuration(null)).toBeNull();
    expect(reliableDuration("abc")).toBeNull();
    expect(reliableDuration(Number.NaN)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 真实试卷训练链路
// ---------------------------------------------------------------------------

describe("真实真题阅读训练：开始 → 作答 → 提交 → 回看", () => {
  it("能列出夹具试卷里三个可训练的阅读大题", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const listed = listReadingTargets(repos, profileId, paper.id);

    expect(listed).not.toBeNull();
    const types = listed!.targets.map((target) => target.sectionType).sort();
    expect(types).toEqual(["reading.banked_cloze", "reading.careful_reading", "reading.matching"]);

    // 每个目标都带真实结构信息
    for (const target of listed!.targets) {
      expect(target.questionCount).toBeGreaterThan(0);
      expect(target.groupCount).toBeGreaterThan(0);
      expect(target.lastRun).toBeNull(); // 还没练过
    }
  });

  it("不可训练的大题被拒绝（听力/写作/翻译不在 V1 范围）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const listening = startReadingRun(repos, profileId, paper.id, "listening.long_conversation");
    expect(listening.ok).toBe(false);
    if (!listening.ok) expect(listening.code).toBe("not_trainable");
  });

  it("完整链路：开始、提交、得到确定性结果并落库", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");

    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    expect(started.ok).toBe(true);
    if (!started.ok) return;

    const session = getReadingSession(repos, profileId, started.run.id);
    expect(session).not.toBeNull();
    // 未提交时不得有任何结果（防止答案提前泄漏到视图）
    expect(session!.result).toBeNull();

    const questions = session!.groups.flatMap((group) => group.questions);
    expect(questions.length).toBeGreaterThan(0);

    // 第一题按正确答案作答 → 必然 correct
    const first = questions[0];
    const correctValue = rawAnswerValue(sectionId, first.id) ?? "";
    const submitted = submitReadingRun(repos, profileId, {
      runId: started.run.id,
      responses: [
        { questionId: first.id, value: correctValue },
        { questionId: questions[1].id, value: "__definitely_wrong__" },
        // 第三题刻意不提交 → skipped
      ],
      elapsedSeconds: 300,
    });

    expect(submitted.ok, submitted.ok ? "" : submitted.error).toBe(true);
    if (!submitted.ok) return;

    const result = submitted.result;
    expect(result.summary.total).toBe(questions.length);
    expect(result.summary.correct).toBe(1);
    expect(result.summary.incorrect).toBe(1);
    expect(result.summary.skipped).toBe(questions.length - 2);
    expect(result.durationSeconds).toBe(300);

    // 每题都带反馈与正确答案展示
    for (const question of result.questions) {
      expect(question.feedback.length).toBeGreaterThan(0);
      expect(question.correctAnswerLabel.length).toBeGreaterThan(0);
    }
  });

  it("结果可回看：重新读取会话仍得到同一份结果", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.banked_cloze");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);

    const session = getReadingSession(repos, profileId, started.run.id)!;
    const questions = session.groups.flatMap((group) => group.questions);

    submitReadingRun(repos, profileId, {
      runId: started.run.id,
      responses: questions.map((question) => ({
        questionId: question.id,
        value: rawAnswerValue(sectionId, question.id),
      })),
    });

    const reloaded = getReadingSession(repos, profileId, started.run.id);
    expect(reloaded!.result).not.toBeNull();
    expect(reloaded!.result!.summary.correct).toBe(questions.length);
    expect(reloaded!.result!.summary.skipped).toBe(0);
  });

  it("重复提交被拒绝（一次作答只产生一组事实）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.matching");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);

    const first = submitReadingRun(repos, profileId, { runId: started.run.id, responses: [] });
    expect(first.ok).toBe(true);

    const second = submitReadingRun(repos, profileId, { runId: started.run.id, responses: [] });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already_submitted");

    // 事件数没有被第二次提交翻倍
    const events = repos.expert.listEventsForRun(started.run.id);
    const session = getReadingSession(repos, profileId, started.run.id)!;
    expect(events.length).toBe(session.groups.flatMap((group) => group.questions).length);
  });

  it("未提交的进行中会话在刷新后可以继续（不丢失已开始状态）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");

    const first = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!first.ok) throw new Error(first.error);

    // 模拟刷新：再次调用同一个入口
    const second = startReadingRun(repos, profileId, paper.id, sectionId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    expect(second.resumed).toBe(true);
    expect(second.run.id).toBe(first.run.id);
  });

  it("未提交时答案不在视图里（客户端不可能提前拿到正确答案）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);

    const session = getReadingSession(repos, profileId, started.run.id)!;
    // 未提交 ⇒ 没有任何结果
    expect(session.result).toBeNull();

    // 逐题检查：可作答视图里不得出现答案字段
    for (const group of session.groups) {
      for (const question of group.questions) {
        expect(Object.keys(question)).not.toContain("answer");
        expect(Object.keys(question)).not.toContain("answerParagraph");
        expect(Object.keys(question)).not.toContain("explanation");
      }
    }

    // 关键：把整个会话对象序列化后，真实答案**不以任何形式**出现
    const serialized = JSON.stringify(session);
    for (const group of session.groups) {
      for (const question of group.questions) {
        const answer = rawAnswerValue(sectionId, question.id);
        if (!answer || question.kind === "mcq") continue; // mcq 答案可能恰好等于某个选项 id，不足以作判据
        // 选词填空/匹配题的答案是具体词/段落号，不应出现在未提交的载荷里
        // （该词可能同时出现在词库中，因此只在"答案不在选项集合里"时才断言）
        const inWordBank = group.wordBank?.includes(answer) ?? false;
        if (!inWordBank) {
          expect(serialized.includes(`"${answer}"`), `未提交载荷里出现了答案 ${answer}`).toBe(false);
        }
      }
    }
  });

  it("读取训练状态是只读的：不创建会话", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");

    // 从未开始过：读取应当明确说"还没开始"，且**不留下任何记录**
    const before = repos.expert.listRuns(profileId, 50).length;
    const state = getSectionTrainingState(repos, profileId, paper.id, sectionId);
    expect(state.ok).toBe(false);
    if (!state.ok) expect(state.code).toBe("not_found");
    expect(repos.expert.listRuns(profileId, 50).length).toBe(before);

    // 多次读取仍不产生记录（刷新页面是无副作用的）
    getSectionTrainingState(repos, profileId, paper.id, sectionId);
    getSectionTrainingState(repos, profileId, paper.id, sectionId);
    expect(repos.expert.listRuns(profileId, 50).length).toBe(before);
  });

  it("已完成后再进入会开一个新会话（每次训练都是独立观测）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");

    const first = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!first.ok) throw new Error(first.error);
    submitReadingRun(repos, profileId, { runId: first.run.id, responses: [] });

    const second = startReadingRun(repos, profileId, paper.id, sectionId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.run.id).not.toBe(first.run.id);
    expect(second.resumed).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 回归：`findLatestRunForSection` 让已完成优先，导致"再练一次"后
  // UI 仍显示旧结果（新会话在用户眼里不存在）。以下四条锁住修复后的语义。
  // -------------------------------------------------------------------------

  it("回归：完成第一轮 → 再练一次 → GET 状态必须显示**新**会话为进行中", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");

    // 第一轮：开始 → 提交
    const first = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!first.ok) throw new Error(first.error);
    submitReadingRun(repos, profileId, { runId: first.run.id, responses: [] });

    // 再练一次（这正是用户点按钮时发生的事）
    const second = startReadingRun(repos, profileId, paper.id, sectionId);
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // **关键断言**：页面状态必须指向新会话，且它是进行中的、没有结果。
    // 修复前这里会返回旧的那个已完成会话，result 非空 —— 用户看到旧结果。
    const state = getSectionTrainingState(repos, profileId, paper.id, sectionId);
    expect(state.ok, state.ok ? "" : state.error).toBe(true);
    if (!state.ok) return;

    expect(state.session.run.id).toBe(second.run.id);
    expect(state.session.run.status).toBe("in_progress");
    expect(state.session.result).toBeNull();
    // 旧会话仍然存在且已提交（历史没有被破坏）
    expect(repos.expert.getRun(first.run.id)?.status).toBe("completed");
  });

  it("回归：第二轮未完成时，再进入会继续**同一个**未完成会话", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.matching");

    const first = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!first.ok) throw new Error(first.error);
    submitReadingRun(repos, profileId, { runId: first.run.id, responses: [] });

    const second = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!second.ok) throw new Error(second.error);

    // 模拟"刷新后又点了继续"
    const third = startReadingRun(repos, profileId, paper.id, sectionId);
    expect(third.ok).toBe(true);
    if (!third.ok) return;

    expect(third.resumed).toBe(true);
    expect(third.run.id).toBe(second.run.id);
    expect(third.run.id).not.toBe(first.run.id);

    // 状态查询也指向同一个
    const state = getSectionTrainingState(repos, profileId, paper.id, sectionId);
    expect(state.ok).toBe(true);
    if (state.ok) expect(state.session.run.id).toBe(second.run.id);
  });

  it("回归：重复点击/刷新不产生孤儿进行中会话（数据库唯一索引兜底）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.banked_cloze");

    const first = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!first.ok) throw new Error(first.error);

    // 连续多次"开始"（用户连点 / 多标签页）
    for (let i = 0; i < 5; i += 1) {
      const again = startReadingRun(repos, profileId, paper.id, sectionId);
      expect(again.ok).toBe(true);
      if (again.ok) expect(again.run.id).toBe(first.run.id);
    }

    // 进行中的会话**恰好一个**
    const runs = repos.expert
      .listRuns(profileId, 100)
      .filter((run) => run.sectionId === sectionId && run.status === "in_progress");
    expect(runs).toHaveLength(1);

    // 数据库层也直接确认只有一条
    const count = db
      .prepare(
        `SELECT COUNT(*) AS c FROM learning_run
         WHERE profile_id = ? AND paper_id = ? AND content_version = ? AND section_id = ?
           AND status = 'in_progress'`,
      )
      .get(profileId, paper.id, paper.contentVersion, sectionId) as { c: number };
    expect(Number(count.c)).toBe(1);
  });

  it("数据库唯一索引本身拒绝第二条进行中会话（不只是服务层在防）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);

    // 绕过服务层，直接插一条同键的进行中会话 —— 必须被索引拒绝
    expect(() =>
      db
        .prepare(
          `INSERT INTO learning_run
             (id, profile_id, paper_id, content_version, section_id, section_type, group_ids,
              status, item_count, started_at, submitted_at, duration_seconds, created_at)
           VALUES ('dup', ?, ?, ?, ?, 'reading.careful_reading', '[]', 'in_progress', 1, 't', NULL, NULL, 't')`,
        )
        .run(profileId, paper.id, paper.contentVersion, sectionId),
    ).toThrow();
  });

  it("提交时忽略不属于本大题的 questionId（不产生野生事件）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);

    submitReadingRun(repos, profileId, {
      runId: started.run.id,
      responses: [{ questionId: "not-a-real-question", value: "B" }],
    });

    const events = repos.expert.listEventsForRun(started.run.id);
    expect(events.some((event) => event.questionId === "not-a-real-question")).toBe(false);
  });

  it("Expert 训练不写旧路径（不污染 skill_profile / answer_attempt）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);
    submitReadingRun(repos, profileId, { runId: started.run.id, responses: [] });

    // 旧闭环的数据一条都不应被 Expert 训练写入
    expect(repos.skillProfile.get(profileId)).toBeNull();
    expect(repos.records.listRecentAttempts(profileId, 10)).toHaveLength(0);
    expect(repos.records.listRecentSessions(profileId, 10)).toHaveLength(0);
    expect(repos.review.listAll(profileId)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 不可变台账
// ---------------------------------------------------------------------------

describe("不可变事实台账", () => {
  function submittedRun(): { profileId: string; runId: string } {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);
    submitReadingRun(repos, profileId, { runId: started.run.id, responses: [] });
    return { profileId, runId: started.run.id };
  }

  it("每条作答都产生了带稳定真实引用的观测", () => {
    const { profileId, runId } = submittedRun();
    const events = repos.expert.listEventsForRun(runId);
    expect(events.length).toBeGreaterThan(0);

    const paper = repos.papers.listPapers()[0];
    for (const event of events) {
      expect(event.paperId).toBe(paper.id);
      expect(event.contentVersion).toBe(paper.contentVersion);
      expect(event.sectionId.length).toBeGreaterThan(0);
      expect(event.groupId.length).toBeGreaterThan(0);
      expect(event.questionId.length).toBeGreaterThan(0);
      expect(["correct", "incorrect", "skipped"]).toContain(event.outcome);
      expect(event.gradingVersion).toBe("reading-v1");
    }
    expect(profileId.length).toBeGreaterThan(0);
  });

  it("直接 UPDATE 历史观测被数据库拒绝", () => {
    const { runId } = submittedRun();
    const event = repos.expert.listEventsForRun(runId)[0];
    expect(() => {
      db.prepare("UPDATE performance_event SET outcome = 'correct' WHERE id = ?").run(event.id);
    }).toThrow(/只追加/);
  });

  it("直接 DELETE 历史观测被数据库拒绝", () => {
    const { runId } = submittedRun();
    const event = repos.expert.listEventsForRun(runId)[0];
    expect(() => {
      db.prepare("DELETE FROM performance_event WHERE id = ?").run(event.id);
    }).toThrow(/只追加/);
  });

  it("直接 UPDATE / DELETE 评估历史同样被拒绝", () => {
    const { runId } = submittedRun();
    const assessment = repos.expert.listAssessmentsForRun(runId)[0];
    expect(() => {
      db.prepare("UPDATE assessment_event SET outcome = 'incorrect' WHERE id = ?").run(assessment.id);
    }).toThrow(/只追加/);
    expect(() => {
      db.prepare("DELETE FROM assessment_event WHERE id = ?").run(assessment.id);
    }).toThrow(/只追加/);
  });

  it("重评**追加**一条新评估，原记录仍在", () => {
    const { runId } = submittedRun();
    const event = repos.expert.listEventsForRun(runId)[0];
    const before = repos.expert.listAssessmentsForRun(runId).filter(
      (item) => item.performanceEventId === event.id,
    );
    expect(before.length).toBe(1);

    repos.expert.appendAssessment({
      performanceEventId: event.id,
      rubricVersion: "reading-v2",
      outcome: before[0].outcome === "correct" ? "incorrect" : "correct",
      score: 1,
      gradingSource: "recalibration",
      supersedesId: before[0].id,
      note: "重新评分测试",
      assessedAt: new Date().toISOString(),
    });

    const after = repos.expert.listAssessmentsForRun(runId).filter(
      (item) => item.performanceEventId === event.id,
    );
    // 两条都在 —— 历史没有被覆盖
    expect(after.length).toBe(2);
    expect(after.map((item) => item.rubricVersion).sort()).toEqual(["reading-v1", "reading-v2"]);
    const appended = after.find((item) => item.rubricVersion === "reading-v2")!;
    expect(appended.supersedesId).toBe(before[0].id);
    // 旧的仍然指向它当时的判定
    expect(after.find((item) => item.rubricVersion === "reading-v1")!.id).toBe(before[0].id);
  });

  it("观测里不存在任何因果/诊断字段（列名层面守护）", () => {
    const columns = db
      .prepare("PRAGMA table_info(performance_event)")
      .all()
      .map((row) => String((row as { name: unknown }).name));

    for (const forbidden of ["mechanism", "weakness", "error_tag", "diagnosis", "cause", "reason"]) {
      expect(columns, `performance_event 不应含因果字段 ${forbidden}`).not.toContain(forbidden);
    }
    // 必须有的观测字段
    for (const required of [
      "response_value",
      "outcome",
      "duration_seconds",
      "answer_changed",
      "attempt_kind",
      "grading_source",
      "grading_version",
    ]) {
      expect(columns, `performance_event 缺少观测字段 ${required}`).toContain(required);
    }
  });

  it("内容版本变化后旧事件仍指向它当时的版本（引用不被静默改写）", () => {
    const { profileId, runId } = submittedRun();
    const event = repos.expert.listEventsForRun(runId)[0];
    const recordedVersion = event.contentVersion;

    // 查询必须带上版本才命中；不带版本会得到全集，因此这里验证"版本参与身份"
    const same = repos.expert.listEventsForQuestion(profileId, {
      paperId: event.paperId,
      contentVersion: recordedVersion,
      sectionId: event.sectionId,
      groupId: event.groupId,
      questionId: event.questionId,
    });
    expect(same.length).toBeGreaterThan(0);

    const other = repos.expert.listEventsForQuestion(profileId, {
      paperId: event.paperId,
      contentVersion: recordedVersion + 99,
      sectionId: event.sectionId,
      groupId: event.groupId,
      questionId: event.questionId,
    });
    expect(other).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 可重建投影
// ---------------------------------------------------------------------------

describe("证据投影可重建", () => {
  it("删空投影后可由不可变事件完整重算", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);
    const session = getReadingSession(repos, profileId, started.run.id)!;
    const questions = session.groups.flatMap((group) => group.questions);

    submitReadingRun(repos, profileId, {
      runId: started.run.id,
      responses: [
        { questionId: questions[0].id, value: rawAnswerValue(sectionId, questions[0].id) },
        { questionId: questions[1].id, value: "__wrong__" },
      ],
    });

    const first = repos.expert.readProjection(profileId);
    const valueOf = (rows: typeof first, signal: string) =>
      rows.find((row) => row.signal === signal)?.value ?? 0;
    expect(valueOf(first, "answer.correct")).toBe(1);
    expect(valueOf(first, "answer.incorrect")).toBe(1);

    // 抹掉派生层（它不是事实来源），再从事件重算
    db.exec(`DELETE FROM evidence_projection WHERE profile_id = '${profileId}'`);
    expect(repos.expert.readProjection(profileId)).toHaveLength(0);

    const rebuilt = repos.expert.rebuildProjection(profileId);
    expect(valueOf(rebuilt, "answer.correct")).toBe(1);
    expect(valueOf(rebuilt, "answer.incorrect")).toBe(1);
  });

  it("投影只包含低层事实，不含机制推断信号", () => {
    const profileId = onboard();
    const rows = repos.expert.rebuildProjection(profileId);
    for (const row of rows) {
      expect(["answer.correct", "answer.incorrect", "answer.skipped"]).toContain(row.signal);
    }
    // 明确不允许的信号名
    for (const forbidden of ["vocabulary.weak", "reading.weak", "careless", "mechanism"]) {
      expect(rows.some((row) => row.signal === forbidden)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 内容版本 fail-closed（任务第 3 项）
// ---------------------------------------------------------------------------

describe("历史内容版本不匹配时失败关闭", () => {
  /**
   * 模拟"内容升版"：直接改写索引里的 `content_version`。
   *
   * 为什么这样模拟是**真实**的：`learning_run.content_version` 记录的是
   * 会话创建时索引里的版本号；而读取路径从 `getPaperDetail()` 拿到的
   * "当前版本"同样来自索引。因此把索引版本号调高，就精确复现了
   * "旧会话 + 新包"这个真实状态（真实场景里它由一次真实的重新导入造成）。
   */
  function bumpPaperVersion(paperId: string, to: number): void {
    db.prepare("UPDATE exam_paper SET content_version = ? WHERE id = ?").run(to, paperId);
  }

  it("进行中的旧版本会话：拒绝用新包渲染，并要求重开", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");

    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);
    expect(started.run.contentVersion).toBe(paper.contentVersion);

    // 内容升版（旧会话仍是旧版本）
    bumpPaperVersion(paper.id, paper.contentVersion + 1);

    // 状态查询必须**拒绝**渲染，而不是把新包当成旧内容
    const state = getSectionTrainingState(repos, profileId, paper.id, sectionId);
    expect(state.ok, "旧版本会话不应被新包重建").toBe(false);
    if (!state.ok) expect(state.code).toBe("content_changed");
    if (!state.ok) {
      expect(state.error).toContain("v" + (paper.contentVersion + 1));
    }

    // 按 runId 直接回看同样必须失败关闭
    expect(getReadingSession(repos, profileId, started.run.id)).toBeNull();
  });

  it("已完成的旧版本会话：事实保留，但不重建题面与答案", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.matching");

    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);
    const session = getReadingSession(repos, profileId, started.run.id)!;
    const questions = session.groups.flatMap((group) => group.questions);
    submitReadingRun(repos, profileId, {
      runId: started.run.id,
      responses: [{ questionId: questions[0].id, value: rawAnswerValue(sectionId, questions[0].id) }],
    });

    const eventsBefore = repos.expert.listEventsForRun(started.run.id);
    expect(eventsBefore.length).toBeGreaterThan(0);

    // 内容升版
    bumpPaperVersion(paper.id, paper.contentVersion + 1);

    // 状态查询：只有旧版本已完成会话 → 必须 fail closed，不给结果视图
    const state = getSectionTrainingState(repos, profileId, paper.id, sectionId);
    expect(state.ok).toBe(false);
    if (!state.ok) {
      expect(state.code).toBe("content_changed");
      expect(state.error).toContain("历史");
    }

    // 按 runId 回看：也必须拒绝（否则会用新包重建新版题面与答案）
    expect(getReadingSession(repos, profileId, started.run.id)).toBeNull();

    // **不可变事实一条不少** —— fail closed 只影响渲染，不影响历史
    const eventsAfter = repos.expert.listEventsForRun(started.run.id);
    expect(eventsAfter).toHaveLength(eventsBefore.length);
    expect(eventsAfter.map((e) => e.id)).toEqual(eventsBefore.map((e) => e.id));
    expect(repos.expert.getRun(started.run.id)?.status).toBe("completed");
  });

  it("旧版本未完成会话不会永久卡死：重开时会废弃它并建立新会话", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.banked_cloze");

    const stale = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!stale.ok) throw new Error(stale.error);

    bumpPaperVersion(paper.id, paper.contentVersion + 1);

    // 用户点"重新开始" —— 必须成功，而不是被旧会话挡住
    const fresh = startReadingRun(repos, profileId, paper.id, sectionId);
    expect(fresh.ok, fresh.ok ? "" : fresh.error).toBe(true);
    if (!fresh.ok) return;
    expect(fresh.run.id).not.toBe(stale.run.id);
    expect(fresh.run.contentVersion).toBe(paper.contentVersion + 1);

    // 旧会话被废弃（它本来就没有观测，因此没有事实被改写）
    expect(repos.expert.getRun(stale.run.id)?.status).toBe("abandoned");
    expect(repos.expert.listEventsForRun(stale.run.id)).toHaveLength(0);

    // 新会话可以正常提交
    const submitted = submitReadingRun(repos, profileId, { runId: fresh.run.id, responses: [] });
    expect(submitted.ok).toBe(true);
  });

  it("abandonRun 不能废弃**已完成**的会话（否则就是改写历史）", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);
    submitReadingRun(repos, profileId, { runId: started.run.id, responses: [] });

    // 已完成 → 拒绝废弃
    expect(repos.expert.abandonRun(started.run.id)).toBeNull();
    expect(repos.expert.getRun(started.run.id)?.status).toBe("completed");

    // 不存在的会话同样返回 null，不报错
    expect(repos.expert.abandonRun("no-such-run")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 恰好一次提交
//
// 一次提交必须在数据库事务边界上恰好生效一次：重放不翻倍，失败不半写。
// 这组用例固定住该语义，而不是固定住某次评审的结论。
// ---------------------------------------------------------------------------

describe("提交在数据库事务边界上恰好一次", () => {
  /** 造一个可提交的会话，返回 runId 与该大题的题数。 */
  function freshRun(): { profileId: string; runId: string; questionCount: number } {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);
    const session = getReadingSession(repos, profileId, started.run.id)!;
    const questionCount = session.groups.flatMap((g) => g.questions).length;
    return { profileId, runId: started.run.id, questionCount };
  }

  function ledgerCounts(runId: string): { events: number; assessments: number } {
    const events = repos.expert.listEventsForRun(runId);
    const assessments = repos.expert.listAssessmentsForRun(runId);
    return { events: events.length, assessments: assessments.length };
  }

  it("顺序重复提交被拒绝，且不产生额外事件", () => {
    const { profileId, runId, questionCount } = freshRun();

    const first = submitReadingRun(repos, profileId, { runId, responses: [] });
    expect(first.ok).toBe(true);
    const afterFirst = ledgerCounts(runId);
    expect(afterFirst.events).toBe(questionCount);
    expect(afterFirst.assessments).toBe(questionCount);

    const second = submitReadingRun(repos, profileId, { runId, responses: [] });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already_submitted");

    // 事件与评估数**没有变化**：重复提交没有产生任何新事实
    const afterSecond = ledgerCounts(runId);
    expect(afterSecond.events).toBe(afterFirst.events);
    expect(afterSecond.assessments).toBe(afterFirst.assessments);
  });

  it("模拟陈旧/重放的第二次完成：零额外事件，且抛可判别错误", () => {
    const { profileId, runId, questionCount } = freshRun();
    submitReadingRun(repos, profileId, { runId, responses: [] });
    const baseline = ledgerCounts(runId);

    // 直接重放写入路径（绕过服务层的 status 预检查）——
    // 这正是"两个请求同时在途"时第二个请求会走到的代码。
    const occurredAt = new Date().toISOString();
    expect(() =>
      repos.expert.completeRun({
        runId,
        submittedAt: occurredAt,
        durationSeconds: 60,
        events: [
          {
            runId,
            profileId,
            paperId: repos.papers.listPapers()[0].id,
            contentVersion: repos.papers.listPapers()[0].contentVersion,
            sectionId: "reading.careful_reading",
            groupId: "g1",
            questionId: "replayed-question",
            questionNumber: 1,
            questionKind: "mcq",
            responseKind: "choice",
            responseValue: "A",
            outcome: "incorrect",
            durationSeconds: null,
            answerChanged: false,
            attemptKind: "first_attempt",
            gradingSource: "replay",
            gradingVersion: "reading-v1",
            sequence: 0,
            occurredAt,
          },
        ],
        assessments: [
          {
            rubricVersion: "reading-v1",
            outcome: "incorrect",
            score: 0,
            gradingSource: "replay",
            supersedesId: null,
            note: null,
            assessedAt: occurredAt,
          },
        ],
      }),
    ).toThrow(RunNotCompletableError);

    // 关键断言：重放**没有写入任何事件或评估**
    const after = ledgerCounts(runId);
    expect(after.events, "重放产生了额外事件").toBe(baseline.events);
    expect(after.events).toBe(questionCount);
    expect(after.assessments, "重放产生了额外评估").toBe(baseline.assessments);
    expect(after.assessments).toBe(questionCount);
  });

  it("投影计数不会翻倍", () => {
    const { profileId, runId } = freshRun();
    submitReadingRun(repos, profileId, { runId, responses: [] });
    const first = repos.expert.readProjection(profileId);
    const sum = (rows: typeof first) => rows.reduce((acc, row) => acc + row.value, 0);
    const totalAfterFirst = sum(first);

    // 重复提交（被拒）后重算投影：总数不变
    submitReadingRun(repos, profileId, { runId, responses: [] });
    repos.expert.rebuildProjection(profileId);
    const second = repos.expert.readProjection(profileId);
    expect(sum(second), "重复提交使投影计数翻倍").toBe(totalAfterFirst);
  });

  it("abandoned 会话不能被提交，也不能变成 completed", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.matching");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);

    // 废弃它
    const abandoned = repos.expert.abandonRun(started.run.id);
    expect(abandoned?.status).toBe("abandoned");

    // 服务层拒绝
    const result = submitReadingRun(repos, profileId, { runId: started.run.id, responses: [] });
    expect(result.ok).toBe(false);

    // 直接重放写入路径同样被拒（认领条件不含 abandoned）
    expect(() =>
      repos.expert.completeRun({
        runId: started.run.id,
        submittedAt: new Date().toISOString(),
        durationSeconds: null,
        events: [],
        assessments: [],
      }),
    ).toThrow(RunNotCompletableError);

    // 状态**仍然是 abandoned**，没有变成 completed
    expect(repos.expert.getRun(started.run.id)?.status).toBe("abandoned");
    expect(repos.expert.listEventsForRun(started.run.id)).toHaveLength(0);
  });

  it("失败不留部分台账：认领成功但事件写入失败时，整体回滚", () => {
    const { profileId, runId } = freshRun();
    const paper = repos.papers.listPapers()[0];
    const occurredAt = new Date().toISOString();

    // 注入一个会在**事件写入阶段**失败的输入：
    // run_id 是 NOT NULL 且有外键，用一个不存在的 run 触发约束失败。
    // 但这里要验证的是"认领成功后失败也回滚"，因此让事件指向非法 runId。
    expect(() =>
      repos.transaction(() =>
        repos.expert.completeRun({
          runId,
          submittedAt: occurredAt,
          durationSeconds: null,
          // group_id 为 NOT NULL；传 null 让 INSERT 抛错
          events: [
            {
              runId,
              profileId,
              paperId: paper.id,
              contentVersion: paper.contentVersion,
              sectionId: "reading.careful_reading",
              groupId: null as unknown as string,
              questionId: "q",
              questionNumber: 1,
              questionKind: "mcq",
              responseKind: "choice",
              responseValue: "A",
              outcome: "correct",
              durationSeconds: null,
              answerChanged: false,
              attemptKind: "first_attempt",
              gradingSource: "test",
              gradingVersion: "reading-v1",
              sequence: 0,
              occurredAt,
            },
          ],
          assessments: [],
        }),
      ),
    ).toThrow();

    // 关键：会话**没有**停留在 completed，也没有留下任何事件
    const run = repos.expert.getRun(runId);
    expect(run?.status, "失败后会话不应是 completed").toBe("in_progress");
    expect(repos.expert.listEventsForRun(runId)).toHaveLength(0);

    // 而且它仍然可以正常提交一次（没有留下"用过一次"的副作用）
    const retry = submitReadingRun(repos, profileId, { runId, responses: [] });
    expect(retry.ok, retry.ok ? "" : retry.error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// answer_changed 的可靠性
//
// 只有**真正改过**的答案才应记为改答案。逐步输入一个词不是"改了又改"，
// 因为产品的提交边界在失焦，不在每次按键。
// ---------------------------------------------------------------------------

describe("answer_changed 只记录真正改过的答案", () => {
  it("逐字符输入一个词 → 不记为改答案（按真实 UI 的调用序列）", () => {
    /*
     * 这里必须模拟**组件真实的调用序列**，而不是"每按一个键就提交一次"：
     *
     *   按键 → onChange → 只更新输入值（不碰 changed）
     *   失焦/回车 → onBlur → commitAnswer（这是唯一的提交边界）
     *
     * 若把 commitAnswer 挂在按键上，那么 w → wo → wor → word 每一步都是
     * "非空 → 另一个非空"，必然被判成改答案 —— 但那不是产品行为，
     * 而是测试把提交边界放错了地方。产品的边界在 blur。
     */
    let committed: string | null = null;
    let committedValue = ""; // 输入框当前值
    let changed = false;

    for (const partial of ["w", "wo", "wor", "word"]) {
      // onChange：只更新输入值
      committedValue = partial;
    }
    // onBlur：唯一的提交边界
    const result = commitAnswer(committed, committedValue, changed);
    committed = result.committed;
    changed = result.changed;

    expect(changed, "打字不应被记为改答案").toBe(false);
    expect(committed).toBe("word");
  });

  it("多次失焦重入（未改变内容）不产生改答案", () => {
    // 用户点进输入框、又点出去、再点回来 —— 值没变，不应记改答案
    let committed: string | null = null;
    let changed = false;
    for (let i = 0; i < 3; i += 1) {
      const result = commitAnswer(committed, "word", changed);
      committed = result.committed;
      changed = result.changed;
    }
    expect(changed).toBe(false);
  });

  it("首次填入完整答案 → false", () => {
    const result = commitAnswer(null, "word", false);
    expect(result.committed).toBe("word");
    expect(result.changed).toBe(false);
  });

  it("已提交的 B → 改成 C → true", () => {
    const first = commitAnswer(null, "B", false);
    expect(first.changed).toBe(false);

    const second = commitAnswer(first.committed, "C", first.changed);
    expect(second.committed).toBe("C");
    expect(second.changed).toBe(true);
  });

  it("填入后又清空 → 回滚为 false（因为最终未作答）", () => {
    const filled = commitAnswer(null, "word", false);
    expect(filled.changed).toBe(false);

    const cleared = commitAnswer(filled.committed, "", filled.changed);
    expect(cleared.committed).toBeNull();
    expect(cleared.changed, "清空后不应保留'改过'的结论").toBe(false);
  });

  it("重复提交同一个值不改变判定（失焦重入不应伪造证据）", () => {
    const first = commitAnswer(null, "B", false);
    const again = commitAnswer(first.committed, "B", first.changed);
    expect(again.changed).toBe(false);

    const changedOnce = commitAnswer(null, "B", false);
    const moved = commitAnswer(changedOnce.committed, "C", changedOnce.changed);
    expect(moved.changed).toBe(true);
    // 再次失焦到同一个值 C：保持 true（这次改动确实发生过）
    const stable = commitAnswer(moved.committed, "C", moved.changed);
    expect(stable.changed).toBe(true);
  });

  it("首尾空白不影响判定", () => {
    const first = commitAnswer(null, " B ", false);
    expect(first.committed).toBe("B");
    expect(first.changed).toBe(false);
    const same = commitAnswer(first.committed, "B", first.changed);
    expect(same.changed).toBe(false);
  });

  it("服务端守卫：最终为空的题即使被声明改过，也记为 false", () => {
    // 矛盾声明（空值 + changed=true）必须被消掉
    expect(isAnswerChangedForSubmission(null, true)).toBe(false);
    expect(isAnswerChangedForSubmission("", true)).toBe(false);
    expect(isAnswerChangedForSubmission("   ", true)).toBe(false);
    // 正常情形
    expect(isAnswerChangedForSubmission("B", true)).toBe(true);
    expect(isAnswerChangedForSubmission("B", false)).toBe(false);
    // 未作答的题永远为 false
    expect(isAnswerChangedForSubmission(null, false)).toBe(false);
  });

  it("端到端：打字输入不会被落库为 answer_changed=true", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.banked_cloze");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);

    const session = getReadingSession(repos, profileId, started.run.id)!;
    const questions = session.groups.flatMap((g) => g.questions);
    const first = questions[0];

    // 模拟用户逐字符输入后只提交一次（前端只会在 blur 时声明"改过"，
    // 而打字阶段不会声明）—— 这里直接提交，声明为空。
    submitReadingRun(repos, profileId, {
      runId: started.run.id,
      responses: questions.map((q) => ({
        questionId: q.id,
        value: q.id === first.id ? "word1" : null,
      })),
      changedQuestionIds: [],
    });

    const events = repos.expert.listEventsForRun(started.run.id);
    for (const event of events) {
      expect(event.answerChanged, `${event.questionId} 被错误记为改过答案`).toBe(false);
    }
  });

  it("端到端：真的改了答案会被落库", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.careful_reading");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);

    const session = getReadingSession(repos, profileId, started.run.id)!;
    const questions = session.groups.flatMap((g) => g.questions);
    const first = questions[0];

    submitReadingRun(repos, profileId, {
      runId: started.run.id,
      responses: questions.map((q) => ({
        questionId: q.id,
        value: q.kind === "mcq" ? (q.id === first.id ? "B" : null) : null,
      })),
      changedQuestionIds: [first.id],
    });

    const events = repos.expert.listEventsForRun(started.run.id);
    const target = events.find((e) => e.questionId === first.id);
    expect(target?.answerChanged).toBe(true);
  });

  it("端到端：清空后提交为 skipped 时 answer_changed 为 false", () => {
    const profileId = onboard();
    const paper = repos.papers.listPapers()[0];
    const sectionId = readingSectionId("reading.banked_cloze");
    const started = startReadingRun(repos, profileId, paper.id, sectionId);
    if (!started.ok) throw new Error(started.error);

    const session = getReadingSession(repos, profileId, started.run.id)!;
    const questions = session.groups.flatMap((g) => g.questions);
    const first = questions[0];

    // 用户填了又清空 —— 前端声明它"改过"（因为确实动过），
    // 但服务端必须以最终值为准消掉这个结论。
    submitReadingRun(repos, profileId, {
      runId: started.run.id,
      responses: questions.map((q) => ({ questionId: q.id, value: null })),
      changedQuestionIds: [first.id],
    });

    const target = repos.expert
      .listEventsForRun(started.run.id)
      .find((e) => e.questionId === first.id);
    expect(target?.outcome).toBe("skipped");
    expect(target?.answerChanged, "未作答的题不应被记为改过答案").toBe(false);
  });
});

/*
 * Exit-time safety net for the case where `afterEach` never ran — the test file
 * threw during collection, or the process was ended before the hook completed.
 *
 * ── Why this does NOT ignore errors ──
 *
 * The previous version wrapped removal in `catch { /* ignore *\/ }`, so a failed
 * removal at exit produced no signal at all: exit code 0, one log line, a
 * directory left on disk. It now reports and sets a **non-zero** exit code, and
 * only raises a zero code (never overwrites a real failure's code — measured
 * behaviour: assigning `process.exitCode` in an exit handler is honoured and can
 * also *lower* an existing value, so an unconditional assignment would erase a
 * genuine failure's status).
 *
 * This handler is a backstop, not a guarantee: it does not run on SIGKILL, machine
 * reset or power loss, and no cleanup is claimed for those cases.
 */
process.on("exit", () => {
  if (!repoDir) return;
  if (existsSync(repoDir)) {
    const shown = redactForLog(repoDir);
    try {
      rmSync(repoDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 40 });
    } catch {
      /* reported below via the existence check, which is the real verdict */
    }
    if (existsSync(repoDir)) {
      console.error(`FAIL  temporary workspace could not be removed at exit: ${shown}`);
      if (process.exitCode === undefined || process.exitCode === 0) {
        process.exitCode = 1;
      }
    }
  }
});

/*
 * Release the native database handle once, at the end of the file.
 *
 * `DatabaseSync` holds a native file handle and native heap; dropping the
 * reference only makes it collectable. Left unclosed, the handle outlives the
 * test file and is cleaned up whenever (and however) a finaliser happens to run —
 * a native abort there surfaces as exit code 0xC0000409, not as a JS error.
 *
 * The same defect produced an intermittent full-suite crash in
 * `course-reveal-endpoint.test.ts`; fixing only that file would have removed one
 * symptom and left the class in place.
 *
 * Per-test handles are closed in `afterEach` now, so this is the final sweep and
 * is expected to find the handle already closed.
 */
afterAll(() => {
  // 原生句柄必须确定性关闭：`DatabaseSync` 不是 GC 会及时回收的普通对象。
  try {
    db?.close();
  } catch {
    // 已关闭过就不该让清理失败。
  }
});
