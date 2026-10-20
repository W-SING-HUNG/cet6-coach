import { existsSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * 私有内容根的路径边界。
 *
 * 为什么单独成模块：私有内容导入要读**本机文件**，这是产品里唯一一处
 * 用户可控路径直接决定读哪个文件的地方。所有路径解析必须收敛到这一个函数，
 * 否则安全性就无法被一处审计、一处测试（由架构门禁固定）。
 *
 * 文件名里的 `paper` 是历史命名债：本模块实际是**整个私有内容根**的边界，
 * 课程包（`private-content/courses/`）同样使用它。刻意**没有**为课程层再写
 * 一份路径解析 —— 那会立刻产生第二个审计点与第二套逃逸判据，而两套判据
 * 必然漂移。课程层因此复用本模块的 `resolveWithinRoot` / `normalizeRelativePath`。
 *
 * 威胁模型（可能来自导入包，也就是"外部数据"）：
 * - `../../../etc/passwd` 这类相对逃逸
 * - `C:\Windows\...` 或 `/etc/passwd` 这类绝对路径
 * - `assets/link.mp3` 是符号链接，实际指向内容根之外
 * - 大小写/分隔符混淆（Windows 下 `\` 与 `/` 等价）
 */

/** 私有内容根。默认 `<cwd>/private-content`，可用环境变量覆盖（E2E 用）。 */
export function getContentRoot(): string {
  const configured = process.env.CET6_CONTENT_ROOT;
  const root = configured && configured.trim() !== "" ? configured : join(process.cwd(), "private-content");
  return resolve(root);
}

/** 试卷包在内容根下的固定子路径。 */
export function getPapersDir(): string {
  return join(getContentRoot(), "cet6", "papers");
}

// ---------------------------------------------------------------------------
// 展示用路径投影（display projection）
//
// ── 为什么需要它 ──
//
// `getContentRoot()` / `getPapersDir()` 返回的是**本机绝对路径**。它们是
// 服务端读盘的必要输入，但**绝不是**用户可见文本：盘符、用户名、安装位置
// 都是本机私有布局信息。
//
// 曾经的缺陷（独立评审 F-2）：真题库空状态把 `library.papersDir` 直接渲染进
// HTML。它是一个**配置值直传**的出口，绕过了 `lib/display-safety.ts` 的
// 显示消毒（那个模块的威胁模型只覆盖"错误消息带路径"）。
//
// 修法不是"记得要消毒"—— 那依赖每一个新出口都记得调用 sanitizer。这里是
// **结构性**修法：把"这个路径给人看时长什么样"收敛成一组纯函数，与
// "这个路径读盘时长什么样"（上面的 getter）分开。页面与服务层**只能**
// 拿到投影结果，绝对路径根本不进入可渲染的数据结构。
//
// ── 投影规则 ──
//
// 1. 只输出**内容根之下**的 POSIX 相对路径（`cet6/papers`、`courses`）；
// 2. 内容根本身显示为固定占位名（`private-content`），**不含**盘符与用户名；
// 3. 若内容根被 `CET6_CONTENT_ROOT` 指到一个自定义位置，展示时同样只出现
//    占位名 + 相对子路径 —— 使用者自己知道他把根设在了哪里，界面不需要复述；
// 4. 这些字符串**永不**由磁盘路径推导，因此不可能泄漏真实布局。
// ---------------------------------------------------------------------------

/** 内容根在界面上的固定占位名（产品文档化的默认目录名，非本机路径）。 */
export const CONTENT_ROOT_DISPLAY_NAME = "private-content";

/** 把内容根投影为界面用的占位名。 */
export function contentRootDisplayLabel(): string {
  return CONTENT_ROOT_DISPLAY_NAME;
}

/** 把试卷目录投影为界面用的**仓库相对**指引（如 `private-content/cet6/papers`）。 */
export function papersDirDisplayLabel(): string {
  return `${CONTENT_ROOT_DISPLAY_NAME}/cet6/papers`;
}

/** 把课程目录投影为界面用的**仓库相对**指引（如 `private-content/courses`）。 */
export function coursesDirDisplayLabel(): string {
  return `${CONTENT_ROOT_DISPLAY_NAME}/courses`;
}

/** 把课程原始来源目录投影为界面指引（如 `private-content/course-sources`）。 */
export function courseSourcesDirDisplayLabel(): string {
  return `${CONTENT_ROOT_DISPLAY_NAME}/course-sources`;
}

/**
 * 把**任意**内容根内的绝对路径投影为界面用的相对指引。
 *
 * 用于错误消息与诊断输出：调用方给一个绝对路径，这里还一个
 * `<占位名>/<相对子路径>`；不在内容根内时只还占位名（失败关闭方向：
 * 宁可少给信息，也不要把盘符/用户名送出去）。
 */
export function toDisplayPath(absolutePath: string): string {
  let root: string;
  let target: string;
  try {
    root = realpathSync(getContentRoot());
  } catch {
    root = getContentRoot();
  }
  try {
    target = realpathSync(absolutePath);
  } catch {
    target = absolutePath;
  }
  const rel = relative(root, target).split(sep).join("/");
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return CONTENT_ROOT_DISPLAY_NAME;
  }
  return `${CONTENT_ROOT_DISPLAY_NAME}/${rel}`;
}

/**
 * 候选包的目录（未批准的规范化包）。
 *
 * **刻意不在 `cet6/papers/` 之下**：导入器的 `discover()` 只枚举
 * `cet6/papers/*`，因此候选包在**原理上**就不可能被导入 ——
 * 这比"记得不要导入候选"可靠得多。
 */
export function getCandidatesDir(): string {
  return join(getContentRoot(), "candidates");
}

/** 原始来源目录（下载的 PDF / 音频 / 第三方页面）。 */
export function getRawDir(): string {
  return join(getContentRoot(), "raw");
}

/**
 * 课程包目录（Course Layer）。
 *
 * 与 `cet6/papers/` 平行的独立子树，**不是它的子目录**：
 * 两个导入器的 `discover()` 各自只枚举自己的目录，因此
 * "课程包被真题导入器误当成试卷"（或反之）在原理上不可能 ——
 * 这比"记得过滤"可靠得多。这条由 `tests/course-import.test.ts` 固定。
 */
export function getCoursesDir(): string {
  return join(getContentRoot(), "courses");
}

/**
 * 课程**原始来源**目录（Course Intake Pipeline）。
 *
 * 放的是 使用者的私有原始课程目录（某个商业课程的文件树）的**导入副本**，
 * 或者由 CLI 用 `--source-root` 指向的任意本机私有目录。
 *
 * 与 `courses/` 分开的理由和候选包同源：原始来源里混着 PDF/DOCX/MP3/图片/压缩包，
 * 它们**不是**规范化课程包。放在同目录下会让"这个包里有什么"变得不可判定。
 */
export function getCourseSourcesDir(): string {
  return join(getContentRoot(), "course-sources");
}

/**
 * 课程**候选包**目录（尚未人工复核 / 尚未晋升）。
 *
 * **刻意不在 `courses/` 之下。** 与真题候选包同一条原理：
 * `NormalizedCourseImporter.discover()` 只枚举 `courses/*`，
 * 因此候选包在**原理上**就不可能被生产导入器当成运行时课程包。
 * 这比"记得不要导入候选"可靠得多 —— 由 `tests/course-intake.test.ts` 固定。
 */
export function getCourseCandidatesDir(): string {
  return join(getContentRoot(), "course-candidates");
}

/**
 * 人工分段计划的默认目录（`private-content/course-segmentation-plans/`）。
 *
 * ── 为什么单独一个目录，而不是直接放进候选目录 ──
 *
 * 计划是**生成候选的输入**，而候选目录是**产物**。
 * `course:extract` 重跑时会**备份并替换**整个候选目录 ——
 * 若计划住在候选目录里，它会在每一次重新抽取时被搬进 `.prev-*` 备份，
 * 于是"改了源 → 重新抽取 → 计划不见了"。
 *
 * 因此计划住在**稳定**的位置，候选目录只读它。
 *
 * ── 它同样受 `private-content/` 保护 ──
 *
 * 计划里有课程结构（坐标 + 人写的说明），因此与课程材料同属私有内容，
 * 由 `.gitignore` 的 `/private-content/` 忽略 —— **绝不进 Git**。
 */
export function getCourseSegmentationPlansDir(): string {
  return join(getContentRoot(), "course-segmentation-plans");
}

/** 审计记录目录。 */
export function getAuditDir(): string {
  return join(getContentRoot(), "audit");
}

export class UnsafePathError extends Error {
  constructor(
    readonly input: string,
    readonly reason: string,
  ) {
    super(`路径不安全：${input}（${reason}）`);
    this.name = "UnsafePathError";
  }
}

/**
 * 取一个路径拒绝的**分类原因**，不含被拒绝的输入本身。
 *
 * 为什么需要它：`UnsafePathError.message` 的形态是
 * `路径不安全：<input>（<reason>）` —— 它**回显输入**。当输入来自 manifest
 * （外部数据）或数据库（不可信来源）时，把这条消息送到界面上就等于让那个
 * 来源决定浏览器里出现什么文本。
 *
 * 这个函数给出**同一条判据的分类标签**（`.. 上跳`、`绝对路径`、`盘符路径`…），
 * 足以让人改对，又不必回显输入。`reason` 由构造函数原样保存，因此它永远
 * 与判定一致，不会漂移成第二套判据。
 */
export function pathSafetyCategory(error: UnsafePathError): string {
  return error.reason;
}

/**
 * 把 manifest 里声明的相对路径规范化为 POSIX 风格，或抛出。
 *
 * 只做**词法**检查（不接触文件系统），因此可以用于任何声明值的校验，
 * 包括磁盘上尚不存在的路径。
 */
export function normalizeRelativePath(input: string): string {
  if (typeof input !== "string" || input.trim() === "") {
    throw new UnsafePathError(String(input), "空路径");
  }
  // 反斜杠在 manifest 中一律视为分隔符，规范化成 POSIX 风格
  const unified = input.replace(/\\/g, "/").trim();

  if (unified.startsWith("/")) {
    throw new UnsafePathError(input, "不允许绝对路径");
  }
  // Windows 盘符与 UNC（`C:/`、`//server/share`）
  if (/^[a-zA-Z]:/.test(unified)) {
    throw new UnsafePathError(input, "不允许盘符路径");
  }
  if (unified.includes("\0")) {
    throw new UnsafePathError(input, "包含空字节");
  }

  const segments = unified.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new UnsafePathError(input, "包含 .. 上跳");
  }
  if (segments.some((segment) => segment === ".")) {
    throw new UnsafePathError(input, "包含 . 段");
  }

  const cleaned = segments.filter((segment) => segment.length > 0).join("/");
  if (cleaned === "") {
    throw new UnsafePathError(input, "规范化后为空");
  }
  return cleaned;
}

/** 判定 `candidate` 是否落在 `root` 内（纯字符串比较，两侧都应为绝对路径）。 */
export function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  if (rel === "") return true;
  return !rel.startsWith("..") && !isAbsolute(rel);
}

export interface ResolvedPath {
  /** 归一化后的绝对路径。 */
  absolutePath: string;
  /** 相对内容根的 POSIX 路径，用于持久化与展示。 */
  relativePath: string;
}

/**
 * 把内容根内的相对路径解析为绝对路径，并拒绝任何逃逸。
 *
 * 两级防线：
 * 1. 词法层：`normalizeRelativePath` 拦截 `..` / 绝对路径 / 盘符。
 * 2. 真实路径层：若目标已存在，用 `realpathSync` 解析符号链接后再比对前缀 ——
 *    词法检查对"根内合法路径指向根外的软链接"无能为力。
 *
 * `mustExist` 为 false 时允许目标是尚不存在的路径（
 * 此时真实路径层无法生效，调用方必须确保该路径只被创建、不被读取）。
 */
export function resolveWithinRoot(root: string, input: string, options: { mustExist?: boolean } = {}): ResolvedPath {
  const relativePath = normalizeRelativePath(input);
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, relativePath.split("/").join(sep));

  if (!isWithin(absoluteRoot, absolutePath)) {
    throw new UnsafePathError(input, "解析后落在内容根之外");
  }

  const mustExist = options.mustExist ?? true;
  // 见 catalog.ts 的同类说明：私有内容根刻意位于项目之外，
  // 因此这里明确告诉 Turbopack 不要把该路径纳入静态追踪。
  if (!existsSync(/* turbopackIgnore: true */ absolutePath)) {
    if (mustExist) throw new UnsafePathError(input, "文件不存在");
    return { absolutePath, relativePath };
  }

  // 符号链接检查：真实路径也必须在根内
  const realRoot = existsSync(/* turbopackIgnore: true */ absoluteRoot)
    ? realpathSync(/* turbopackIgnore: true */ absoluteRoot)
    : absoluteRoot;
  const realTarget = realpathSync(/* turbopackIgnore: true */ absolutePath);
  if (!isWithin(realRoot, realTarget)) {
    throw new UnsafePathError(input, "符号链接指向内容根之外");
  }

  return { absolutePath: realTarget, relativePath };
}

/** 判定路径是否为常规文件（拒绝目录与设备文件）。 */
export function isRegularFile(absolutePath: string): boolean {
  try {
    return statSync(absolutePath).isFile();
  } catch {
    return false;
  }
}
