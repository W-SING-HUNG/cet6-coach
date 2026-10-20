/**
 * 源目录清点（raw private course directory → immutable inventory）。
 *
 * ── 这个模块是整条流水线的信任边界 ──
 *
 * 它是产品里唯一一处"用户可控路径直接决定读哪些文件"的地方之一
 * （另一处是既有的 `resolveWithinRoot`）。因此所有遍历与安全判定都收敛在这里。
 *
 * ── 清点必须是**不可变事实**，不是"尽量读一下" ──
 *
 * 每一个文件都记录 `bytes` + `sha256`。这两项 + 相对路径构成源快照摘要
 * （`SourceInventory.digest`）。由此：
 *
 *   **源字节一变，候选就必须陈旧。**
 *
 * 若只记文件名，那么"使用者 把 PDF 换成另一份、文件名没变"这件事
 * 会完全不可见 —— 而候选包的所有证据都建立在那份 PDF 的文本上。
 *
 * ── 安全模型 ──
 *
 * 威胁来自**目录内容**（它可能是从别处解压来的）：
 * - 符号链接指到源根之外（`lecture.pdf` 实为 `~/.ssh/id_rsa`）
 * - 目录联接 / 硬链接造成的重复与循环
 * - 极深的嵌套（磁盘上有，逻辑上没有）
 * - 非法设备文件（命名管道会让 `readFile` 永久挂住）
 *
 * 处置：**拒绝并登记**，不静默跳过。源根之外的内容绝不读取。
 *
 * ── 为什么遍历只有**一份实现**（A1 只读检查工作台引入）──
 *
 * A1 需要两种粒度：**只看元数据**（首屏目录树，不解析正文）与
 * **按字节检查**（用户勾选之后的抽取）。若为前者另写一个遍历函数，
 * 就会出现第二套"什么算逃逸、什么算越界"的判据 —— 而两套判据必然漂移，
 * 且漂移的那一套会静默地少拒一个形态。
 *
 * 因此本文件把遍历收敛成**唯一一个** `traverseSourceTree`：
 * 两道防线（`realpathSync` 后 `isWithin`、`fstat` 确认常规文件）、
 * 深度与数量上限、确定性的排序，全部只写一次。
 * `scanSourceDirectory`（读字节）与 `scanSourceTree`（只读元数据）
 * 都只是它的薄包装。
 */

import { createHash } from "node:crypto";
import { openSync, closeSync, fstatSync, readSync, readdirSync, realpathSync, statSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isWithin, normalizeRelativePath } from "@/content/paper/paths";
import {
  type CourseModuleHint,
  type SourceAsset,
  type SourceAssetKind,
  type SourceInventory,
  type SourceInventoryNote,
  type SourceLocator,
} from "./types";
import { COURSE_ASSET_MIME_BY_EXTENSION } from "@/content/course/types";

/**
 * 递归深度上限。
 *
 * 为什么需要它：真实课程目录可能有 `第1套/听力/音频/...` 这样三四层，
 * 但"深到 20 层"只可能来自目录联接造成的环或恶意构造。上限让遍历必然终止，
 * 且超出时**如实上报**而不是静默停止。
 */
export const MAX_SCAN_DEPTH = 12;

/** 一次清点最多处理的文件数。超过即拒绝整次清点（避免把机器读爆）。 */
export const MAX_SCANNED_FILES = 5000;

export class SourceScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceScanError";
  }
}

// ---------------------------------------------------------------------------
// 选择范围（A1 只读检查工作台）
// ---------------------------------------------------------------------------

/**
 * 源目录**选择范围**的判定接口。
 *
 * ── 它为什么是一个接口而不是一组路径 ──
 *
 * 遍历需要在两个位置问问题："这个文件要不要读"与"这个目录要不要进去"。
 * 把答案做成两个函数，遍历就**不需要理解选择范围的数据结构** ——
 * 于是"选择范围从哪来"（A1 的界面勾选、将来的其它来源）不会渗进
 * 这段安全关键的遍历代码里。
 *
 * ── 它的安全语义 ──
 *
 * 判定**只作用于已经通过全部路径安全检查的条目**（调用点在选择判定之前
 * 已经完成 realpath 与容纳校验）。因此"选择范围"既不能用来扩大读取范围，
 * 也不能绕过逃逸判据 —— 它只能把一个本来会被读取的文件**排除掉**。
 *
 * 不提供它时（`scanSourceDirectory` / `scanSourceTree` 的默认）行为
 * **逐字节不变**。
 */
export interface SourceSelection {
  /** 这个（已确认安全的）文件是否在检查范围内。 */
  allowsFile(relativePath: string): boolean;
  /** 这个（已确认安全的）目录是否需要继续深入。 */
  shouldDescend(relativePath: string): boolean;
}

// ---------------------------------------------------------------------------
// 扩展名 → 种类
// ---------------------------------------------------------------------------

/** 文档类扩展名（其中只有 PDF 在 V1 被内容解析）。 */
const DOCUMENT_EXTENSIONS = new Set([".pdf", ".docx", ".doc", ".md", ".txt"]);
const AUDIO_EXTENSIONS = new Set([".mp3", ".m4a", ".wav", ".ogg"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

/**
 * 判定一个扩展名属于哪一种源资产。
 *
 * 刻意**不**信任文件内容嗅探：我们登记的是"这个文件按扩展名是什么"，
 * 而内容层（PDF 解析）会自己验证字节是否真的是 PDF。两者是不同的判据，
 * 混在一起会让"扩展名说谎"这件事无法被单独观察。
 */
export function sourceKindForExtension(extension: string): SourceAssetKind {
  const ext = extension.toLowerCase();
  if (!COURSE_ASSET_MIME_BY_EXTENSION[ext] && !DOCUMENT_EXTENSIONS.has(ext)) {
    if (AUDIO_EXTENSIONS.has(ext)) return "audio";
    if (IMAGE_EXTENSIONS.has(ext)) return "image";
    return "unsupported";
  }
  if (ext === ".pdf") return "pdf";
  if (ext === ".docx" || ext === ".doc") return "docx";
  if (AUDIO_EXTENSIONS.has(ext)) return "audio";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "unsupported";
  return "unsupported";
}

/**
 * **V1 只有 PDF 会被内容解析。**
 *
 * DOCX 刻意不解析（`TEXT_EXTRACTION_DEFERRED`）；音频/图片没有文本层这个概念；
 * 其余类型本版本不支持。这个函数是"谁会被送去解析"的唯一判据。
 */
export function isContentParsed(kind: SourceAssetKind): boolean {
  return kind === "pdf";
}

// ---------------------------------------------------------------------------
// 模块提示（来自文件夹标签 —— **不是身份证据**）
// ---------------------------------------------------------------------------

/**
 * 文件夹标签 → 候选模块提示。
 *
 * 这些标签**只**用于排序与"先看哪一族结构线索"。它们：
 *
 * - 不参与任何相似度计算（见 `FORBIDDEN_MATCH_FEATURES`）；
 * - 不进入 canonical 身份判断；
 * - 即使错了也不会影响匹配结论（匹配只看内容）。
 *
 * 中英标签都要认：真实课程目录里 `阅读` 与 `Reading` 混用是常态。
 */
const MODULE_HINT_BY_LABEL: { pattern: RegExp; hint: CourseModuleHint }[] = [
  { pattern: /^(阅读|阅读理解|reading|read)$/i, hint: "reading" },
  { pattern: /^(听力|听|listening|listen)$/i, hint: "listening" },
  { pattern: /^(翻译|translation|translate)$/i, hint: "translation" },
  { pattern: /^(写作|作文|writing|write)$/i, hint: "writing" },
  { pattern: /^(方法|方法论|技巧|方法课|methods?|methodology|skills?)$/i, hint: "methods" },
];

/** 从路径各级目录名推出候选模块提示（取**最靠近文件**的那一级的命中）。 */
export function inferModuleHint(folderLabels: string[]): { hint: CourseModuleHint | null; basis: string | null } {
  for (let index = folderLabels.length - 1; index >= 0; index -= 1) {
    const label = folderLabels[index].trim();
    for (const entry of MODULE_HINT_BY_LABEL) {
      if (entry.pattern.test(label)) return { hint: entry.hint, basis: label };
    }
  }
  return { hint: null, basis: null };
}

// ---------------------------------------------------------------------------
// 文件名 / 路径归一
// ---------------------------------------------------------------------------

/** 去掉扩展名后的 stem。保留原样（未小写、未归一）。 */
export function stemOf(basename: string): string {
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return basename;
  return basename.slice(0, dot);
}

/** 小写扩展名（含点）；无扩展名为空串。 */
export function extensionOf(basename: string): string {
  const dot = basename.lastIndexOf(".");
  if (dot <= 0) return "";
  return basename.slice(dot).toLowerCase();
}

/**
 * 归一化 stem —— 逻辑材料分组的判据之一。
 *
 * 处理的是**同一份讲义两种导出**的真实形态：
 * `阅读讲义 - 副本`、`阅读讲义(1)`、`Reading Handout v2`、`handout.pdf`/`handout.docx`。
 *
 * 刻意保守：只去掉括号后缀/副本标记/版本后缀与空白，**不做**词干化或同义合并。
 * 激进归一会把两份无关材料合并 —— 而"静默合并无关文件"是明确禁止的。
 */
export function normalizeStem(stem: string): string {
  return stem
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\s\u3000]+/g, " ")
    // 副本 / 拷贝 标记（各平台导出都会带）
    .replace(/[\s_-]*[-_（(]?\s*(副本|拷贝|copy|copie)\s*[)）]?\s*\d*$/i, "")
    // 下载工具的后缀 (1) / (2) / -1 / _1
    .replace(/[\s_-]*[（(]\d+[)）]\s*$/g, "")
    .replace(/[\s_-]+\d+$/g, "")
    // 版本后缀 v1 / v2 / 终版 / final
    .replace(/[\s_-]*(v|ver|version|第)?\s*\d*\s*(版|稿|final|draft)$/i, "")
    // 归一后可能留下尾部分隔符
    .replace(/[\s_-]+$/g, "")
    .trim();
}

/**
 * 从相对路径推导**确定性**的资产键。
 *
 * 为什么不用随机 id / 递增序号：候选包必须能在同一输入上重复生成出
 * **逐字节相同**的 `course.json` 与摘要值。用序号会让"改了目录里文件的顺序"
 * 产生一份新候选 —— 而内容其实没变，那会无谓地让复核记录陈旧。
 *
 * ── 为什么 slug 必须**纯 ASCII** ──
 *
 * 资产键会成为 `course.json` 里的 `assets[].id` / `representations[].id`，
 * 而生产校验器要求这些 id 匹配 `^[a-z0-9][a-z0-9._-]*$`。
 * 真实课程目录大量使用中文文件名（`阅读讲义.pdf`），若把 CJK 保留进 slug，
 * 生成的包会被**生产校验器直接拒绝** —— 而且是在整条链路跑完之后才拒绝。
 *
 * 因此：slug 只保留 ASCII 字母数字，中文名全部落到哈希后缀上。
 * 哈希取自**完整相对路径**，因此不同文件（含纯中文名）仍然得到不同键。
 * 可读性由 `basename` 字段保留（它不参与 id 约束）。
 */
export function assetKeyOf(relativePath: string): string {
  const slug = relativePath
    .normalize("NFKC")
    .toLowerCase()
    // 只保留 ASCII 字母数字；CJK 与其他符号全部变成分隔符
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  const hash = createHash("sha256").update(relativePath, "utf8").digest("hex").slice(0, 8);
  return `${slug === "" ? "asset" : slug}-${hash}`;
}

// ---------------------------------------------------------------------------
// 文件读取（拒绝非普通文件）
// ---------------------------------------------------------------------------

/**
 * 读取一个普通文件的内容。
 *
 * 刻意**不用 `readFileSync`**：命名管道（FIFO）会让它永久阻塞，
 * 而"清点一个用户给的目录"绝不能因为目录里有个 FIFO 就挂住。
 * 因此先 `fstat` 确认是普通文件，再按已知长度读。
 */
function readRegularFile(absolutePath: string): Buffer {
  const fd = openSync(absolutePath, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      throw new SourceScanError(`不是常规文件（可能是设备/管道）：${absolutePath}`);
    }
    const buffer = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read <= 0) break;
      offset += read;
    }
    return offset === stat.size ? buffer : buffer.subarray(0, offset);
  } finally {
    closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// **唯一一份**遍历（元数据 / 内容两种粒度共用）
// ---------------------------------------------------------------------------

/** 遍历见到的一个常规文件。`bytes` / `sha256` 只有内容模式才有。 */
export interface TraversedFile {
  absolutePath: string;
  /** 相对源根的 POSIX 路径。 */
  relativePath: string;
  basename: string;
  stem: string;
  extension: string;
  kind: SourceAssetKind;
  /** 磁盘上的字节数（两种模式都有）。 */
  size: number;
  folderLabels: string[];
  /** 只有 `readContent: true` 时非 null。 */
  bytes: Buffer | null;
  /** 只有 `readContent: true` 时非 null。 */
  sha256: string | null;
}

/** 遍历的收集器。两种粒度各自实现自己的。 */
interface TraversalSink {
  onFile(entry: TraversedFile): void;
  onDirectory(relativePath: string): void;
  onRejected(relativePath: string, reason: string): void;
  onIgnoredHidden(): void;
}

interface TraversalOptions {
  ignoreHidden: boolean;
  /** **只读元数据**时为 false —— 绝不打开文件句柄。 */
  readContent: boolean;
  selection: SourceSelection | null;
}

/**
 * 递归遍历一个源目录。**唯一一份**路径安全实现。
 *
 * 保证（每一条都有明确的失败形态）：
 * - 不跟随源根之外的符号链接 / 目录联接（`realpathSync` + `isWithin`）；
 * - 只读常规文件（`fstat` 确认，挡 FIFO 与设备文件）；
 * - 深度与文件数有上限，超出即**拒绝并上报**（不静默停止）；
 * - 目录不可读**登记**而不中断整次遍历；
 * - 顺序确定（按名字排序），因此清点结果不依赖文件系统返回顺序；
 * - 选择范围只**排除**条目，不能扩大读取范围。
 */
function traverseSourceTree(
  sourceRoot: string,
  options: TraversalOptions,
  sink: TraversalSink,
): string {
  const requestedRoot = resolve(sourceRoot);

  let realRoot: string;
  try {
    realRoot = realpathSync(requestedRoot);
  } catch {
    throw new SourceScanError(`源目录不存在或不可读：${sourceRoot}`);
  }
  if (!statSync(realRoot).isDirectory()) {
    throw new SourceScanError(`源根不是目录：${sourceRoot}`);
  }

  let fileCount = 0;

  /** 递归遍历。`dir` 必须是**已 realpath 且仍在根内**的绝对路径。 */
  function walk(dir: string, depth: number, folderLabels: string[]): void {
    if (depth > MAX_SCAN_DEPTH) {
      sink.onRejected(
        toRelative(realRoot, dir),
        `超过最大递归深度 ${MAX_SCAN_DEPTH}（可能是目录联接造成的环）`,
      );
      return;
    }
    if (fileCount > MAX_SCANNED_FILES) {
      throw new SourceScanError(
        `源目录文件数超过上限 ${MAX_SCANNED_FILES} —— 拒绝处理（请先缩小要导入的目录范围）`,
      );
    }

    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      sink.onRejected(toRelative(realRoot, dir), `目录不可读：${(error as Error).message}`);
      return;
    }

    // 确定性顺序：清点结果不得依赖文件系统返回顺序
    for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
      if (options.ignoreHidden && entry.name.startsWith(".")) {
        sink.onIgnoredHidden();
        continue;
      }

      const childPath = join(dir, entry.name);
      const childRelative = toRelative(realRoot, childPath);

      // ── 符号链接：解析真实路径，越界即拒绝 ──
      let isDirectory = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        let realTarget: string;
        try {
          realTarget = realpathSync(childPath);
        } catch {
          sink.onRejected(childRelative, "符号链接无法解析（可能是断链）");
          continue;
        }
        if (!isWithin(realRoot, realTarget)) {
          // 这是最关键的一条：源目录里的软链接指向根外时，**绝不读取它**。
          sink.onRejected(
            childRelative,
            "符号链接指向源根之外 —— 拒绝读取（源根之外的内容不属于这次导入）",
          );
          continue;
        }
        const targetStat = statSync(realTarget);
        isDirectory = targetStat.isDirectory();
        isFile = targetStat.isFile();
        if (!isDirectory && !isFile) {
          sink.onRejected(childRelative, "符号链接指向非普通文件");
          continue;
        }
      } else if (!isDirectory && !isFile) {
        sink.onRejected(childRelative, "不是常规文件也不是目录（设备/管道/FIFO）");
        continue;
      }

      if (isDirectory) {
        // ── 选择范围：不在范围内的目录**不进入**（也就不读其中任何文件）──
        if (options.selection !== null && !options.selection.shouldDescend(childRelative)) {
          continue;
        }
        // 目录也要 realpath 后再走：Windows 目录联接与大小写差异都由它收敛
        let realDir: string;
        try {
          realDir = realpathSync(childPath);
        } catch {
          sink.onRejected(childRelative, "目录无法解析真实路径");
          continue;
        }
        if (!isWithin(realRoot, realDir)) {
          sink.onRejected(childRelative, "目录解析后落在源根之外");
          continue;
        }
        sink.onDirectory(childRelative);
        walk(realDir, depth + 1, [...folderLabels, entry.name]);
        continue;
      }

      // ── 常规文件 ──
      //
      // 选择范围判定在**读取之前**：被排除的文件既不读字节，也不进摘要、
      // 不进分组、不进匹配。因此"排除"是一个**内容级**的事实，
      // 而不是显示层的过滤。
      if (options.selection !== null && !options.selection.allowsFile(childRelative)) {
        continue;
      }

      const basename = entry.name;
      const extension = extensionOf(basename);
      const kind = sourceKindForExtension(extension);

      let bytes: Buffer | null = null;
      let sha256: string | null = null;
      let size: number;

      if (options.readContent) {
        try {
          bytes = readRegularFile(childPath);
        } catch (error) {
          sink.onRejected(childRelative, `无法读取：${(error as Error).message}`);
          continue;
        }
        sha256 = createHash("sha256").update(bytes).digest("hex");
        size = bytes.length;
      } else {
        // 元数据模式：只取磁盘上的字节数，**绝不打开文件句柄**
        try {
          size = statSync(childPath).size;
        } catch (error) {
          sink.onRejected(childRelative, `无法读取元数据：${(error as Error).message}`);
          continue;
        }
      }

      fileCount += 1;
      sink.onFile({
        absolutePath: childPath,
        relativePath: childRelative,
        basename,
        stem: stemOf(basename),
        extension,
        kind,
        size,
        folderLabels: [...folderLabels],
        bytes,
        sha256,
      });
    }
  }

  walk(realRoot, 0, []);
  return realRoot;
}

// ---------------------------------------------------------------------------
// 主入口 · 内容清点
// ---------------------------------------------------------------------------

export interface ScanSourceOptions {
  /**
   * 源根标签（**只有目录名**，不含绝对路径）。
   *
   * 它会被写进候选包，因此绝不允许是绝对路径 —— 见 `assertNoAbsolutePaths`。
   */
  sourceRootLabel?: string;
  /** 忽略隐藏条目（`.` 开头）。默认 true，但会登记被忽略的数量。 */
  ignoreHidden?: boolean;
  /**
   * 标准私有源树根（`private-content/course-sources`）。
   *
   * 提供它时，若被清点的源根**位于该树之内**，则会产出一个
   * `standard` 源位置定位符（安全的**相对**路径）——
   * 这样复核/晋升时可以在**不需要人再给一次路径**的情况下证明源未漂移。
   *
   * 不提供、或源根在该树之外时，产出 `external` 定位符（**不记录位置**）。
   */
  standardSourcesRoot?: string;
  /**
   * **检查范围**（A1 只读检查工作台）。
   *
   * 不提供时行为**逐字节不变**。提供时，被排除的文件与目录
   * 既不读字节、也不进 `assets` ⇒ 不影响源摘要、分组、分段与匹配。
   */
  selection?: SourceSelection;
}

/**
 * 推导源位置定位符（**永远不含绝对路径**）。
 *
 * 三种情形：
 *
 * 1. 提供了标准源树根，且被清点的源根在其之内 ⇒ `standard` +
 *    相对该树的 POSIX 相对路径（经 `normalizeRelativePath` 校验）。
 * 2. 否则 ⇒ `external`，**刻意不记录任何位置**（只有目录名标签）。
 *
 * 第 2 种情况下"源当前性"无法自动证明，必须由复核者再次提供 `--source-root`。
 * 这是刻意的：把绝对路径写进候选文件会让候选无法在另一台机器上被理解，
 * 而且会泄漏本机目录结构。
 */
export function sourceLocatorFor(
  absoluteSourceRoot: string,
  standardSourcesRoot: string | null,
  label: string,
): SourceLocator {
  if (standardSourcesRoot !== null) {
    const standardRoot = resolve(standardSourcesRoot);
    const realStandard = existsSync(/* turbopackIgnore: true */ standardRoot)
      ? realpathSync(/* turbopackIgnore: true */ standardRoot)
      : standardRoot;
    if (isWithin(realStandard, absoluteSourceRoot) && realStandard !== absoluteSourceRoot) {
      const relativeToStandard = relative(realStandard, absoluteSourceRoot).split(sep).join("/");
      try {
        // 走既有安全解析：拒绝 `..` / 绝对路径 / 盘符 / 空字节
        const safe = normalizeRelativePath(relativeToStandard);
        return { kind: "standard", locator: safe };
      } catch {
        // 相对路径不安全（理论上不该发生，因为 isWithin 已通过）⇒ 退回 external
      }
    }
  }
  return { kind: "external", label, locator: null };
}

/**
 * 递归清点一个私有源目录。
 *
 * **不跟随越界符号链接、不读源根之外、不改动任何源文件。**
 */
export function scanSourceDirectory(sourceRoot: string, options: ScanSourceOptions = {}): SourceInventory {
  const ignoreHidden = options.ignoreHidden ?? true;
  const selection = options.selection ?? null;

  const assets: SourceAsset[] = [];
  const notes: SourceInventoryNote[] = [];
  const rejected: { relativePath: string; reason: string }[] = [];
  const warnings: string[] = [];
  let ignoredHidden = 0;

  const realRoot = traverseSourceTree(
    sourceRoot,
    { ignoreHidden, readContent: true, selection },
    {
      onFile(entry) {
        const { hint, basis } = inferModuleHint(entry.folderLabels);
        assets.push({
          assetKey: assetKeyOf(entry.relativePath),
          relativePath: entry.relativePath,
          basename: entry.basename,
          stem: entry.stem,
          extension: entry.extension,
          kind: entry.kind,
          contentParsed: isContentParsed(entry.kind),
          bytes: entry.size,
          sha256: entry.sha256!,
          moduleHint: hint,
          moduleHintBasis: basis,
          folderContext: entry.folderLabels.length > 0 ? entry.folderLabels.join("/") : null,
          folderLabels: entry.folderLabels,
        });

        if (entry.size === 0) {
          // 空文件**不阻断清点**，但必须被看见 —— 它多半是导出失败的产物
          notes.push({
            code: "empty_file",
            assetKeys: [assetKeyOf(entry.relativePath)],
            detail: `文件为 0 字节：${entry.relativePath}（可能是导出失败，内容解析必然为空）`,
          });
        }
      },
      onDirectory() {
        /* 内容清点不需要目录清单 */
      },
      onRejected(relativePath, reason) {
        rejected.push({ relativePath, reason });
      },
      onIgnoredHidden() {
        ignoredHidden += 1;
      },
    },
  );

  // ── 跨文件事实：重复内容、同名不同内容、不支持类型 ──
  notes.push(...collectCrossFileNotes(assets));

  if (ignoredHidden > 0) {
    warnings.push(`忽略了 ${ignoredHidden} 个隐藏条目（以 . 开头）。`);
  }

  const digest = computeSourceDigest(assets);

  return {
    sourceRootLabel: options.sourceRootLabel ?? baseLabelOf(realRoot),
    scannedAt: new Date().toISOString(),
    assets,
    notes,
    rejected,
    digest,
    sourceLocator: sourceLocatorFor(
      realRoot,
      options.standardSourcesRoot ?? null,
      options.sourceRootLabel ?? baseLabelOf(realRoot),
    ),
  };
}

// ---------------------------------------------------------------------------
// 主入口 · **只读元数据**（A1 首屏目录树）
// ---------------------------------------------------------------------------

/** 元数据清单里的一个文件（**没有**内容哈希 —— 因此不需要读字节）。 */
export interface SourceTreeFile {
  /** 相对源根的 POSIX 路径。**这是选择范围的稳定身份。** */
  relativePath: string;
  basename: string;
  stem: string;
  extension: string;
  kind: SourceAssetKind;
  bytes: number;
  folderLabels: string[];
}

/** 只读元数据清单。 */
export interface SourceTreeSnapshot {
  /** 源根标签（**只有目录名**，不含任何绝对路径）。 */
  sourceRootLabel: string;
  scannedAt: string;
  /** 全部目录（相对源根，POSIX），已排序。 */
  directories: string[];
  files: SourceTreeFile[];
  rejected: { relativePath: string; reason: string }[];
  ignoredHidden: number;
  /**
   * **结构摘要**：只覆盖 (相对路径, 种类, 字节数)。
   *
   * ── 它刻意**不是**内容摘要 ──
   *
   * 元数据阶段不读字节，因此它无从覆盖内容。把它与
   * `SourceInventory.digest`（含 sha256）混用会让"内容变了但大小没变"
   * 这类改动看起来一致。因此它是另一个具名字段，且名称里写明是结构。
   */
  structureDigest: string;
}

/** 结构摘要的规范序列。(相对路径, 种类, 字节数) 排序后取 sha256。 */
export function computeStructureDigest(files: SourceTreeFile[]): string {
  const canonical = [...files]
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((file) => `${file.relativePath}\t${file.kind}\t${file.bytes}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * **只读元数据**遍历：列出目录与文件，**绝不打开文件句柄**。
 *
 * 它存在的理由是具体的：真实课程目录可能有一份几十 MB 的 PDF 与整段音频。
 * 首屏"这个目录里有什么"不应该把每一个文件都哈希一遍 ——
 * 那既慢，又在用户**还没有选择**任何东西时就做了远超必要的 I/O。
 *
 * 安全保证与 `scanSourceDirectory` **完全同一份**（见 `traverseSourceTree`）：
 * 逃逸的符号链接、设备文件、深度与数量上限的处理一字不差。
 */
export function scanSourceTree(
  sourceRoot: string,
  options: { ignoreHidden?: boolean; selection?: SourceSelection; sourceRootLabel?: string } = {},
): SourceTreeSnapshot {
  const ignoreHidden = options.ignoreHidden ?? true;
  const selection = options.selection ?? null;
  const files: SourceTreeFile[] = [];
  const directories: string[] = [];
  const rejected: { relativePath: string; reason: string }[] = [];
  let ignoredHidden = 0;

  const realRoot = traverseSourceTree(
    sourceRoot,
    { ignoreHidden, readContent: false, selection },
    {
      onFile(entry) {
        files.push({
          relativePath: entry.relativePath,
          basename: entry.basename,
          stem: entry.stem,
          extension: entry.extension,
          kind: entry.kind,
          bytes: entry.size,
          folderLabels: entry.folderLabels,
        });
      },
      onDirectory(relativePath) {
        directories.push(relativePath);
      },
      onRejected(relativePath, reason) {
        rejected.push({ relativePath, reason });
      },
      onIgnoredHidden() {
        ignoredHidden += 1;
      },
    },
  );

  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  directories.sort((a, b) => a.localeCompare(b));

  return {
    sourceRootLabel: options.sourceRootLabel ?? baseLabelOf(realRoot),
    scannedAt: new Date().toISOString(),
    directories,
    files,
    rejected,
    ignoredHidden,
    structureDigest: computeStructureDigest(files),
  };
}

/** 相对源根的 POSIX 风格路径。 */
function toRelative(root: string, absolutePath: string): string {
  const rel = relative(root, absolutePath);
  if (rel === "") return ".";
  return rel.split(sep).join("/");
}

/** 源根标签：**只有目录名**，不含任何上级路径。 */
function baseLabelOf(absoluteRoot: string): string {
  const parts = absoluteRoot.split(/[\\/]/).filter((part) => part !== "");
  return parts[parts.length - 1] ?? "source";
}

/**
 * 源快照摘要。
 *
 * 覆盖 (相对路径, 字节数, sha256) 三元组的规范序列。**任一变化都变。**
 * 这就是"源字节变了 ⇒ 候选陈旧"的判据。
 */
export function computeSourceDigest(assets: SourceAsset[]): string {
  const canonical = [...assets]
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath))
    .map((asset) => `${asset.relativePath}\t${asset.bytes}\t${asset.sha256}`)
    .join("\n");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/** 只在跨文件层面才能看出来的事实。 */
function collectCrossFileNotes(assets: SourceAsset[]): SourceInventoryNote[] {
  const notes: SourceInventoryNote[] = [];

  // 1) 内容完全相同（同一份文件被放了两次）
  const byChecksum = new Map<string, SourceAsset[]>();
  for (const asset of assets) {
    const list = byChecksum.get(asset.sha256) ?? [];
    list.push(asset);
    byChecksum.set(asset.sha256, list);
  }
  for (const [checksum, group] of byChecksum) {
    if (group.length < 2) continue;
    notes.push({
      code: "duplicate_content",
      assetKeys: group.map((asset) => asset.assetKey).sort(),
      detail:
        `字节完全相同（sha256 ${checksum.slice(0, 12)}…）：` +
        group.map((asset) => asset.relativePath).join("、") +
        `。它们是同一个文件的多份副本 —— 不构成多份逻辑材料，也不构成多种表示。`,
    });
  }

  // 2) 同名不同内容（**同一路径在两个不同目录下**）。
  //    这是"使用者 以为改好了、其实改的是另一份"的真实形态。
  const byName = new Map<string, SourceAsset[]>();
  for (const asset of assets) {
    const list = byName.get(asset.basename) ?? [];
    list.push(asset);
    byName.set(asset.basename, list);
  }
  for (const [basename, group] of byName) {
    if (group.length < 2) continue;
    const distinct = new Set(group.map((asset) => asset.sha256));
    if (distinct.size < 2) continue;
    notes.push({
      code: "same_name_different_bytes",
      assetKeys: group.map((asset) => asset.assetKey).sort(),
      detail:
        `同名但内容不同：${basename}（出现在 ${group.map((asset) => asset.relativePath).join("、")}）。` +
        `文件名的相似**不是**内容相同的证据 —— 它们必须被分别判断。`,
    });
  }

  // 3) 不支持的类型：如实登记，不静默跳过
  const unsupported = assets.filter((asset) => asset.kind === "unsupported");
  if (unsupported.length > 0) {
    notes.push({
      code: "unsupported_type",
      assetKeys: unsupported.map((asset) => asset.assetKey).sort(),
      detail:
        `本版本不支持解析的类型 ${unsupported.length} 个：` +
        unsupported.map((asset) => asset.relativePath).join("、") +
        `。它们被登记但不会被解析，也不会进入课程包。`,
    });
  }

  return notes;
}

/**
 * 结构性断言：清点结果里**不得出现绝对路径**。
 *
 * 这是"不得把绝对路径写进 manifest"这条硬规则在流水线入口处的落点。
 * 放在这里而不是只靠 review：一旦绝对路径进了候选包，它就会被提交、
 * 被另一台机器读到，而那时它已经是一份无法复现的泄漏。
 */
export function assertNoAbsolutePaths(inventory: SourceInventory, sourceRoot: string): void {
  const absoluteRoot = resolve(sourceRoot);
  for (const asset of inventory.assets) {
    if (isAbsolute(asset.relativePath)) {
      throw new SourceScanError(`清点结果里出现了绝对路径：${asset.relativePath}`);
    }
    // 路径必须真的落在源根内（纯字符串检查）
    const rebased = resolve(absoluteRoot, asset.relativePath.split("/").join(sep));
    if (!isWithin(absoluteRoot, rebased)) {
      throw new SourceScanError(`清点结果里的路径逃出了源根：${asset.relativePath}`);
    }
  }
}
