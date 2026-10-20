import type { PaperQuestion, PaperOption } from "@/content/paper";

/**
 * 真实真题阅读训练的领域语义（纯函数，无 I/O）。
 *
 * 这个模块只做三件事，每一件都必须可被独立验证：
 * 1. **确定性判分** —— 只用真题自带的答案数据，不做任何推断；
 * 2. **观测事实的规范化** —— 把一次作答整理成"发生了什么"，不含"为什么"；
 * 3. **保守反馈** —— 只用确定性信息回答"对/错、正确答案是什么"。
 *
 * ── 刻意的边界（来自 content-policy/LEARNING_MODEL.md）──
 *
 * - **不从单次错误推断机制**。反馈里不出现"你词汇弱""你粗心""你没定位到原文"
 *   这类因果结论。这些属于后续阶段的 MechanismHypothesis，需要独立证据。
 * - **未作答不是答错**。`skipped` 与 `incorrect` 是两种不同的观测：
 *   前者没有证据，后者是一次错误证据。把它们混为一谈会污染后续统计。
 * - **干扰项不携带诊断**。真实 CET 干扰项不是为本系统的诊断构造的
 *   （EVIDENCE_BASE 第 10 条），因此反馈只说"你选了 X"，不说"选 X 说明 Y"。
 */

// ---------------------------------------------------------------------------
// 可训练的大题类型（V1 只做阅读）
// ---------------------------------------------------------------------------

/**
 * V1 支持的真实真题阅读大题。
 *
 * 写作 / 听力 / 翻译**刻意不在**这里：
 * - 听力需要音频交互（后续阶段）；
 * - 写作为主观题，缺 AI 批改时只能做结构匹配，把它当成"已训练"会高估证据；
 * - 翻译同理。
 * 三者都不是 V1 的阻塞项，但把它们标成"可训练"会让证据台账出现低质观测。
 */
export const TRAINABLE_READING_SECTIONS = [
  "reading.banked_cloze",
  "reading.matching",
  "reading.careful_reading",
] as const;

export type TrainableReadingSection = (typeof TRAINABLE_READING_SECTIONS)[number];

export function isTrainableReadingSection(type: string): type is TrainableReadingSection {
  return (TRAINABLE_READING_SECTIONS as readonly string[]).includes(type);
}

// ---------------------------------------------------------------------------
// 作答形态
// ---------------------------------------------------------------------------

/**
 * 学习者的作答形态。
 *
 * 为什么不统一成一个字符串：三种阅读题的"作答"在语义上不同 ——
 * 选一个选项、从词库里选一个词、匹配一个段落标号。
 * 统一成字符串会让"这个值是不是合法选项"这类检查失去依据。
 */
export type ReadingResponseKind = "choice" | "blank" | "paragraph";

export interface ReadingResponse {
  questionId: string;
  kind: ReadingResponseKind;
  /** 规范化后的作答值；未作答为 null。 */
  value: string | null;
}

// ---------------------------------------------------------------------------
// 判定结果
// ---------------------------------------------------------------------------

/**
 * 一次作答的观测结论。
 *
 * 只有这三种，且它们**互不等价**：
 * - `correct`   —— 有证据表明这次做对了
 * - `incorrect` —— 有证据表明这次做错了
 * - `skipped`   —— 没有作答，因此**没有证据**
 *
 * 刻意没有 `careless` / `guessing` / `unknown_mechanism` 之类的值：
 * 那些是解释，不是观测。
 */
export type AnswerOutcome = "correct" | "incorrect" | "skipped";

export interface GradedResponse {
  questionId: string;
  questionNumber: number | null;
  questionKind: PaperQuestion["kind"];
  responseKind: ReadingResponseKind;
  /** 学习者当时的作答值（未作答为 null）——历史事实，原样保存。 */
  responseValue: string | null;
  outcome: AnswerOutcome;
  /** 真题自带的正确答案的可读形式。用于反馈，不参与判定。 */
  correctAnswerLabel: string;
  /** 判定依据的机器可读值。 */
  correctAnswerValue: string;
}

// ---------------------------------------------------------------------------
// 判分
// ---------------------------------------------------------------------------

/**
 * 规范化作答值再比较。
 *
 * 为什么需要：选词填空的答案是**词库里的词**，而源件与学习者的输入在
 * 大小写与首尾空白上可能不一致（实测词库存在首字母大小写混排）。
 * 把它当作错误是无依据的严格 —— 用词**本身**才是判定对象。
 *
 * 只做两类规范化：去首尾空白 + 大小写折叠。**不做**同义替换、词形归并或
 * 编辑距离匹配 —— 那些会引入"看起来差不多就算对"的判定，正是要避免的。
 */
export function normalizeAnswerValue(value: string): string {
  return value.trim().toLowerCase();
}

/** 某道题可被接受的作答形态。 */
export function responseKindOf(question: PaperQuestion): ReadingResponseKind {
  switch (question.kind) {
    case "mcq":
      return "choice";
    case "banked_cloze_blank":
      return "blank";
    case "matching_statement":
      return "paragraph";
    default:
      throw new Error(`题型 ${question.kind} 不属于 V1 阅读训练的可判分范围`);
  }
}

/** 真题自带的正确答案（原始形式）。 */
function correctValueOf(question: PaperQuestion): string {
  switch (question.kind) {
    case "mcq":
      return question.answer;
    case "banked_cloze_blank":
      return question.answer;
    case "matching_statement":
      return question.answerParagraph;
    default:
      throw new Error(`题型 ${question.kind} 不属于 V1 阅读训练的可判分范围`);
  }
}

/** 正确答案的可读标签：优先给内容本身，而不是字母。 */
function correctLabelOf(question: PaperQuestion): string {
  if (question.kind === "mcq") {
    const option = question.options.find((item) => item.id === question.answer);
    return option ? `${option.id} — ${option.label}` : question.answer;
  }
  if (question.kind === "banked_cloze_blank") return question.answer;
  if (question.kind === "matching_statement") return `段落 ${question.answerParagraph}`;
  return correctValueOf(question);
}

/**
 * 确定性判分。
 *
 * 判据**只有一个**：学习者的作答值是否等于真题自带的答案值（规范化后）。
 * 不存在"看起来接近就部分给分"的分支 —— 阅读客观题没有部分正确。
 */
export function gradeResponse(
  question: PaperQuestion,
  response: ReadingResponse | null,
): GradedResponse {
  const kind = responseKindOf(question);
  const correctValue = correctValueOf(question);
  const rawValue = response?.value ?? null;
  const answered = rawValue !== null && rawValue.trim() !== "";

  let outcome: AnswerOutcome;
  if (!answered) {
    outcome = "skipped";
  } else if (normalizeAnswerValue(rawValue) === normalizeAnswerValue(correctValue)) {
    outcome = "correct";
  } else {
    outcome = "incorrect";
  }

  return {
    questionId: question.id,
    questionNumber: question.number,
    questionKind: question.kind,
    responseKind: kind,
    responseValue: answered ? rawValue : null,
    outcome,
    correctAnswerLabel: correctLabelOf(question),
    correctAnswerValue: correctValue,
  };
}

/** 一组题的整体判分。顺序与传入顺序一致（即官方题序）。 */
export function gradeResponses(
  questions: PaperQuestion[],
  responses: ReadingResponse[],
): GradedResponse[] {
  const byId = new Map(responses.map((item) => [item.questionId, item]));
  return questions.map((question) => gradeResponse(question, byId.get(question.id) ?? null));
}

export interface ScoreSummary {
  correct: number;
  incorrect: number;
  skipped: number;
  total: number;
}

/**
 * 汇总。
 *
 * 入参只要求 `outcome`，让它同时适用于判分产物与**读回来的结果视图** ——
 * 后者不含判分中间字段（它读的是已落库的事实）。这样"提交时的汇总"
 * 与"回看时的汇总"走的是同一段代码，不会出现两套口径。
 */
export function summarize(graded: Array<{ outcome: AnswerOutcome }>): ScoreSummary {
  return {
    correct: graded.filter((item) => item.outcome === "correct").length,
    incorrect: graded.filter((item) => item.outcome === "incorrect").length,
    skipped: graded.filter((item) => item.outcome === "skipped").length,
    total: graded.length,
  };
}

// ---------------------------------------------------------------------------
// 反馈（只用确定性信息）
// ---------------------------------------------------------------------------

/**
 * 逐题反馈。
 *
 * 反馈的义务是**说清事实**：这次的结果、正确答案是什么、以及错在哪里可比对。
 * 它**不**解释"为什么错" —— 那需要机制级证据，而一次作答不构成该证据
 * （LEARNING_MODEL 第 4 节「诊断警示规则」第 1 条）。
 */
export function feedbackFor(
  graded: GradedResponse,
  options: PaperOption[],
  explanation: string | null,
): string {
  if (graded.outcome === "skipped") {
    // 未作答的语义必须精确：它不计为错误，但**它确实被记录** ——
    // 系统写下的是一条 `answer.skipped` 观测。
    // 早先的措辞说"没有产生证据"，而事件表里确实有一条，那是自相矛盾的。
    return `未作答。这一题的正确答案是 ${graded.correctAnswerLabel}。未作答不计为错误，也不产生正确或错误的能力证据；系统只记录这题未作答。`;
  }
  if (graded.outcome === "correct") {
    return explanation
      ? `正确。${explanation}`
      : `正确。正确答案是 ${graded.correctAnswerLabel}。`;
  }

  const chosen =
    graded.responseKind === "choice"
      ? options.find((item) => item.id === graded.responseValue)
      : undefined;
  const chosenText = chosen ? `你选了 ${chosen.id} — ${chosen.label}` : null;

  const parts = [`不正确。正确答案是 ${graded.correctAnswerLabel}。`];
  if (chosenText) parts.push(chosenText);
  if (explanation) parts.push(explanation);
  parts.push("这里只记录这一次的作答结果；它本身还不足以判定某个能力上的原因。");
  return parts.join(" ");
}

/** 整组的总结文案。区分"没做对"与"没作答"。 */
export function summarizeFeedback(summary: ScoreSummary): string {
  const parts = [`${summary.correct}/${summary.total} 题正确`];
  if (summary.incorrect > 0) parts.push(`${summary.incorrect} 题答错`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} 题未作答`);
  return `${parts.join("，")}。`;
}

// ---------------------------------------------------------------------------
// 观测事实的构造（给不可变台账用）
// ---------------------------------------------------------------------------

/**
 * 计时是否**可靠到可以记为事实**。
 *
 * 判据刻意保守：只有落在 [1 秒, 30 分钟] 的测量才记为事实，否则记 null。
 * 理由：CTF/PWA 场景下浏览器可能被挂起、用户可能离开页面，
 * 这类测量值一旦写进台账就会被后续当成"用时"证据使用。
 * **宁可不记，也不要写下不可信的数字**（EVIDENCE_BASE 第 11 条：
 * 反应时阈值是情境敏感的，不能当作通用判据）。
 */
export const MIN_RELIABLE_SECONDS = 1;
export const MAX_RELIABLE_SECONDS = 30 * 60;

export function reliableDuration(value: unknown): number | null {
  const seconds = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(seconds)) return null;
  if (seconds < MIN_RELIABLE_SECONDS || seconds > MAX_RELIABLE_SECONDS) return null;
  return Math.round(seconds);
}

/** 投影信号名。刻意只有两个低层事实，不做机制推断。 */
export const EVIDENCE_SIGNALS = ["answer.correct", "answer.incorrect", "answer.skipped"] as const;
export type EvidenceSignalName = (typeof EVIDENCE_SIGNALS)[number];

export function signalFor(outcome: AnswerOutcome): EvidenceSignalName {
  switch (outcome) {
    case "correct":
      return "answer.correct";
    case "incorrect":
      return "answer.incorrect";
    case "skipped":
      return "answer.skipped";
  }
}

// ---------------------------------------------------------------------------
// 改答案的判定（`answer_changed`）
// ---------------------------------------------------------------------------

/**
 * 一次"提交答案"动作的结果：新的已提交值 + 该题是否算作"改过答案"。
 */
export interface CommitResult {
  /** 已提交的值；清空为 null。 */
  committed: string | null;
  /** 这题是否发生过**有意义的修改**。 */
  changed: boolean;
}

/**
 * 判定一次**提交动作**是否构成"改过答案"。
 *
 * ── 为什么需要"提交边界"这个概念 ──
 *
 * 文本类作答（选词填空、段落匹配）在输入过程中会逐字符变化：
 * 输入 `word` 会经过 `w` → `wo` → `wor` → `word`。
 * 若把每一次变化都当成"改答案"，那么**任何一个打字输入的人都会被记录为
 * "改过答案"** —— 这条观测就变成了噪音，而它本应表达的是
 * "学习者先给了一个答案，后来又改了主意"。
 *
 * 测量不可靠时**记 false，而不是编造证据**（EVIDENCE_BASE 第 11 条：
 * 反应时/行为阈值是情境敏感的，不能当作通用判据）。
 * 因此这条规则刻意保守：
 *
 * | 情形 | changed |
 * | --- | --- |
 * | 首次填入（此前从未提交过非空值） | `false` |
 * | 提交值与上次相同 | 保持原值 |
 * | 非空 → 另一个非空（真正的改主意） | `true` |
 * | 清空（最终为未作答） | `false`（**回滚**，见下） |
 *
 * **清空必须回滚 changed**：若用户填了一个词又删掉，
 * 最终提交的是"未作答"。此时说"他改过答案"没有依据 ——
 * 这题没有产生任何作答证据。
 *
 * 离散选择（四选一）本来就以点击为提交边界，因此同样走这个函数：
 * 点 A → 点 B 会得到 `changed = true`，这符合真实交互。
 */
export function commitAnswer(
  previousCommitted: string | null,
  nextValue: string,
  alreadyChanged: boolean,
): CommitResult {
  const next = nextValue.trim() === "" ? null : nextValue.trim();
  const previous = previousCommitted === null || previousCommitted.trim() === ""
    ? null
    : previousCommitted.trim();

  // 清空：最终没有作答 → 不保留"改过"的结论
  if (next === null) {
    return { committed: null, changed: false };
  }

  // 首次填入完成的答案：这不是"修改"，是"第一次作答"
  if (previous === null) {
    return { committed: next, changed: false };
  }

  // 值没变：保持既有结论（重焦点、重新触碰同一个输入框不应改变它）
  if (previous === next) {
    return { committed: next, changed: alreadyChanged };
  }

  // 非空 → 另一个非空：这是真正的"改了答案"
  return { committed: next, changed: true };
}

/**
 * 交卷时的最终裁决：`answer_changed` 只对**确实提交了非空答案**的题成立。
 *
 * 这是服务端的守卫，不依赖客户端正确实现 —— 即便前端送来一个矛盾的
 * `changed` 声明（例如某题最终为空却被标为改过），这里也会把它消掉。
 * 观测的可靠性不能建立在"调用方没写错"之上。
 */
export function isAnswerChangedForSubmission(
  finalValue: string | null,
  claimedChanged: boolean,
): boolean {
  if (!claimedChanged) return false;
  // 未作答的题不存在"改了答案"这回事：它的最终结果是"没有作答"
  return finalValue !== null && finalValue.trim() !== "";
}
