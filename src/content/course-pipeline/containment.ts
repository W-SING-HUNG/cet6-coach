/**
 * 课程 id 的**路径容纳（containment）**边界。
 *
 * ── 这个模块要解决的真实缺陷（独立评审 F-B）──
 *
 * 早先 `readStoredCandidate` 用 `join(candidatesDir, courseId)` 拼路径，
 * `promoteCourseCandidate` 也用 `stored.courseId` 拼晋升目标。
 * 实测确认：`course:review ..\..\escape` **可以读到候选根之外**的目录 ——
 * 只要那个目录里恰好有 `candidate.json` 与 `course.json`。
 *
 * ── 为什么 `path.join` / `path.normalize` 不够 ──
 *
 * 它们**会解析** `..`，但**不证明容纳**：解析的结果可以落在根之外，
 * 而函数本身不会报错。判据必须是"解析后仍在根内"，而不是"路径看起来正常"。
 *
 * ── 设计（不新建第二套路径安全实现）──
 *
 * 全部复用既有机制：
 *
 * | 用途 | 复用的既有实现 |
 * | --- | --- |
 * | 词法层（`..` / 绝对路径 / 盘符 / UNC / `\0`） | `normalizeRelativePath` |
 * | 真实路径层（符号链接逃逸） | `resolveWithinRoot` 内部的 `realpathSync` + `isWithin` |
 * | 容纳判定 | `isWithin` |
 *
 * 本模块只做两件既有机制**没有**覆盖的事：
 *
 * 1. **课程 id 必须是单个 slug 段** —— `normalizeRelativePath` 允许 `a/b`
 *    （它是为包内相对路径设计的），而课程 id 是**目录名**，出现分隔符即非法。
 * 2. 把"根 + id"这一步收敛成**两个语义入口**，让调用方无法各自拼路径。
 *
 * 因此这里是"组合既有判据 + 补一条 slug 约束"，**不是**平行实现。
 */

import { resolve } from "node:path";
import {
  getCourseCandidatesDir,
  getCoursesDir,
  isWithin,
  normalizeRelativePath,
  resolveWithinRoot,
  UnsafePathError,
} from "@/content/paper/paths";

/**
 * 课程 id 的合法形态：**单个 slug 段**。
 *
 * 与 `course.json` 的 `id` 校验规则一致（否则候选目录名会与包内 id 不一致）。
 *
 * 它天然拒绝：
 * - `..` 与 `.`（首字符必须是 `[a-z0-9]`）
 * - 任何分隔符 `/` 或 `\`（不在字符类里）
 * - 空串
 * - 绝对路径、盘符路径、UNC（都含 `/` 或 `\`，或以 `/` 开头）
 *
 * 它**允许** `a..b` 这类含连续点的名字 —— 那是合法的**目录名**，
 * 不含分隔符因而无法上跳；后续 `normalizeRelativePath` 也会再确认一次。
 */
export const COURSE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** 课程 id 被拒绝时抛出（与 `UnsafePathError` 并列，便于调用方区分措辞）。 */
export class CourseIdRejectedError extends Error {
  constructor(
    readonly courseId: string,
    reason: string,
  ) {
    super(`课程 id 不安全：${JSON.stringify(courseId)}（${reason}）`);
    this.name = "CourseIdRejectedError";
  }
}

/** 判定课程 id 是否为合法的单个 slug 段（**唯一实现**）。 */
export function isSafeCourseId(courseId: string): boolean {
  return typeof courseId === "string" && COURSE_ID_PATTERN.test(courseId);
}

/**
 * 校验课程 id，返回它本身；不合法即抛 `CourseIdRejectedError`。
 *
 * 这是**唯一**的课程 id 判据入口：CLI 与 service 都调用它，
 * 因此不存在"某个调用方忘了检查"的形态。
 */
export function assertSafeCourseId(courseId: string): string {
  if (typeof courseId !== "string" || courseId.trim() === "") {
    throw new CourseIdRejectedError(String(courseId), "为空");
  }
  if (!isSafeCourseId(courseId)) {
    throw new CourseIdRejectedError(
      courseId,
      "必须是单个 slug 段（小写字母开头，只含小写字母/数字/点/下划线/连字符）；" +
        "不得含路径分隔符、不得是 . 或 ..、不得是绝对路径/盘符路径/UNC",
    );
  }
  /*
   * 纵深防御：让**既有的**词法判据再确认一次。
   *
   * slug 正则已经拒绝了分隔符，因此这一步在正常输入上恒等通过；
   * 它的价值是：若将来有人放宽上面那个正则，`..` / 绝对路径 / 盘符 /
   * UNC / 空字节仍会在这一层被拦住 —— 而判据来自既有实现，不是这里另写的。
   */
  const normalized = normalizeRelativePath(courseId);
  if (normalized !== courseId || normalized.includes("/")) {
    throw new CourseIdRejectedError(courseId, "规范化后不再是同一个单段目录名");
  }
  return courseId;
}

/**
 * 把"根 + 课程 id"解析为**已证明容纳**的绝对路径。
 *
 * 两级防线全在既有实现里：
 * 1. `normalizeRelativePath`（词法层）
 * 2. `resolveWithinRoot` 的 `realpathSync` + `isWithin`（真实路径层）
 *
 * `mustExist: false`：目标可能尚未创建（晋升目标）。注意这不削弱安全检查 ——
 * `resolveWithinRoot` 只在路径**不存在**时跳过真实路径层，
 * 路径存在时**依然**做符号链接容纳检查。
 */
function resolveCourseDirUnderRoot(root: string, courseId: string, rootLabel: string): string {
  const safeId = assertSafeCourseId(courseId);

  const resolved = resolveWithinRoot(root, safeId, { mustExist: false });

  // 显式再断言一次（消费既有 `isWithin`，不是另写判据）
  const absoluteRoot = resolve(root);
  if (!isWithin(absoluteRoot, resolved.absolutePath)) {
    throw new CourseIdRejectedError(courseId, `解析后落在 ${rootLabel} 之外`);
  }
  return resolved.absolutePath;
}

/** 候选目录（`course-candidates/<id>`），**已证明容纳**。 */
export function resolveCandidateDir(
  courseId: string,
  candidatesDir: string = getCourseCandidatesDir(),
): string {
  return resolveCourseDirUnderRoot(candidatesDir, courseId, "候选根");
}

/** 晋升目标（`courses/<id>`），**已证明容纳**。 */
export function resolvePromotedCourseDir(courseId: string, coursesDir: string = getCoursesDir()): string {
  return resolveCourseDirUnderRoot(coursesDir, courseId, "课程根");
}

/** 判断一个错误是否为"路径/课程 id 不安全"（供 CLI 统一措辞）。 */
export function isPathSafetyError(error: unknown): error is Error {
  return error instanceof CourseIdRejectedError || error instanceof UnsafePathError;
}

/**
 * 把任意本机字符串变成**仅用于展示**的安全文本（F-C）。
 *
 * ── 它防的是什么 ──
 *
 * 目录名是**任意本机字符串**：可以含 `$()`、反引号、引号、分号、管道、`&`，
 * 甚至**换行**。换行是最危险的一种 —— 它能让一行展示文本"伪造"出
 * 一整条看起来可执行的命令：
 *
 *     候选的目录名标签：odd
 *     pnpm course:link ... --status verified     ← 被伪造出来的"命令"
 *
 * 因此展示用的字符串必须：
 *
 * - 去掉换行/回车/制表等控制字符（杜绝伪造命令行）；
 * - 把 shell 元字符替换为可见的替代写法（让人看得出"这里原本是特殊字符"，
 *   而不是得到一个看起来可安全粘贴的字符串）；
 * - 截断到合理长度。
 *
 * **它不是转义函数**：它产出的文本**永远不可当作命令执行**，
 * 只用于人眼阅读。这一点必须在调用处明确（见 CLI 的措辞）。
 */
export function sanitizeForDisplay(value: string, maxLength = 80): string {
  const neutralized = String(value)
    // 控制字符（含 \n \r \t）先变成可见的 `?`，杜绝伪造命令行
    .replace(/[\u0000-\u001f\u007f]/g, "?")
    // shell 元字符换成全角形式，明确"这不是可直接粘贴的原文"
    .replace(/\$/g, "＄")
    .replace(/`/g, "｀")
    .replace(/;/g, "；")
    .replace(/\|/g, "｜")
    .replace(/&/g, "＆")
    .replace(/</g, "＜")
    .replace(/>/g, "＞")
    .replace(/"/g, "”")
    .replace(/'/g, "’");
  return neutralized.length > maxLength ? `${neutralized.slice(0, maxLength)}…` : neutralized;
}
