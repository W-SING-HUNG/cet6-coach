import type { TaskContentRef } from "./models";
import {
  SECTION_SCORE_WEIGHTS,
  WRITTEN_EXAM_DURATION_MINUTES,
  type PaperSectionType,
} from "./paper";

/**
 * "真实真题阅读训练目标"的领域词汇（纯函数，无 I/O）。
 *
 * ── 这个模块解决什么问题 ──
 *
 * 在本次收敛之前，Today 的阅读训练任务引用的是 `practice-library.ts` 里的
 * **合成**阅读篇章，点进去落在 `/practice/[taskId]` 的旧执行器里，
 * 走旧的 Phase-1 闭环（`answer_attempt` / `Weakness` / `review_item`）。
 *
 * 产品规则要求：面向学习者的 CET-6 阅读训练只有一条规范路径 ——
 *
 *   真实历年真题内容 → Expert Training 工作面 → Expert 不可变台账
 *
 * 因此计划任务需要一种新的引用：它指向**某一版真实试卷里的某个阅读大题**，
 * 而不是某个内容库条目。本模块给出这种引用的编码、解码与跳转目标，
 * 全部是确定性字符串变换，因此可以被穷举测试。
 *
 * ── 为什么用字符串编码而不是 JSON ──
 *
 * `study_task.content_ref` 是一个已落库的 JSON 列（`TaskContentRef`）。
 * 保持 `{ contentType, contentId }` 的形状不变，意味着**不需要 schema 迁移**，
 * 也意味着历史行仍然可读（见"历史安全"一节）。
 * `contentId` 编码两个标识，由本模块唯一负责拆分。
 */

/**
 * 编码分隔符。
 *
 * 选 `::` 的依据：试卷 id 由规范化包给出（实测形如 `cet6-2024-12-set1` /
 * `fixture-cet6-2024-12-set1`），大题 id 由 validator 赋为 section type
 * （形如 `reading.careful_reading`）。两者都不含 `::`，而都含 `-` 与 `.`,
 * 因此不能用它们当分隔符。用 `::` 还让编码后的字符串肉眼可读。
 */
export const READING_TARGET_SEPARATOR = "::";

export function encodeReadingTarget(paperId: string, sectionId: string): string {
  return `${paperId}${READING_TARGET_SEPARATOR}${sectionId}`;
}

/** 解码失败返回 null —— 调用方必须按"不可用"处理，不得猜测。 */
export function decodeReadingTarget(
  contentId: string,
): { paperId: string; sectionId: string } | null {
  const index = contentId.indexOf(READING_TARGET_SEPARATOR);
  // index === 0 表示 paperId 为空；两者都必须非空，否则不是一个合法引用
  if (index <= 0) return null;
  const paperId = contentId.slice(0, index);
  const sectionId = contentId.slice(index + READING_TARGET_SEPARATOR.length);
  if (!paperId || !sectionId) return null;
  return { paperId, sectionId };
}

/**
 * 该阅读大题的**排练时间预算**（分钟）。
 *
 * ── 这是一条明确的 Tier D 项目约定，不是官方数据 ──
 *
 * 官方从未拆分单个大题的时长（见 `domain/paper.ts` 的
 * `WRITTEN_EXAM_DURATION_MINUTES` 注释），因此这里**不声称**它是
 * 官方建议时间。它的定义是：
 *
 *   `round(该部分官方分值权重 × 官方笔试总时长)`
 *
 * 也就是"按分值权重线性分摊的排练预算"。它的唯一用途是让 planner 知道
 * 一条任务要占今天多少分钟（PRODUCT_PRINCIPLES 第 6 条要求给出预计分钟数），
 * 以及让"任务时长 = 素材自身时长"这条既有约束继续成立。
 *
 * 它**不**是以下任何东西，且不得被这样呈现：
 * - 不是官方建议用时；
 * - 不是该学习者完成该部分所需的预测时间；
 * - 不是任何形式的测量结果。
 *
 * 取整用 `Math.round`，不做"看起来更专业"的精度修饰。
 */
export function estimateReadingSectionMinutes(type: PaperSectionType): number {
  const weight = SECTION_SCORE_WEIGHTS[type] ?? 0;
  return Math.round(weight * WRITTEN_EXAM_DURATION_MINUTES);
}

/** 真实试卷阅读大题的规范作答 URL。这是**唯一**的深度链接构造点。 */
export function readingTrainingHref(paperId: string, sectionId: string): string {
  return `/practice/papers/${encodeURIComponent(paperId)}/train/${encodeURIComponent(sectionId)}`;
}

/** 从引用直接得到 URL；引用不合法时返回 null。 */
export function readingTargetHrefOf(ref: TaskContentRef | null): string | null {
  if (!ref || ref.contentType !== "reading_target") return null;
  const target = decodeReadingTarget(ref.contentId);
  if (!target) return null;
  return readingTrainingHref(target.paperId, target.sectionId);
}

/**
 * 一个计划任务应该跳到哪。
 *
 * ── 为什么这条规则必须收敛到一处 ──
 *
 * 同一个决定（"点这个任务会去哪"）被三个界面消费：Today 的主导动作、
 * Today 的任务清单、Practice 的"今天计划里的训练"。
 * 早先它们各自写死 `/practice/${task.id}` —— 于是当阅读任务改走
 * Expert Training 之后，只要有一处漏改，学习者就会从那个入口回到
 * 已经被替换掉的旧阅读执行器。把规则写成这个函数，就不存在"某处漏改"。
 *
 * 非阅读任务仍然走旧执行器：写作、翻译、复习、词汇在本次收敛中**保持不变**
 * （它们依赖的是内容库里各自的素材，与真实真题无关）。
 */
export function taskHrefOf(taskId: string, ref: TaskContentRef | null): string {
  return readingTargetHrefOf(ref) ?? `/practice/${taskId}`;
}
