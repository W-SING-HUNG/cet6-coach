import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import type {
  CourseAsset,
  CourseIssue,
  CoursePackageContent,
  NormalizedCourseHandle,
  ValidatedCourse,
} from "./types";
import { getCoursesDir, isRegularFile, resolveWithinRoot } from "@/content/paper/paths";
import { validateCourseManifest } from "./validator";

/**
 * 规范化课程目录包导入器。
 *
 * 包形态（`private-content/courses/<dir>/`）：
 *
 *   course.json         课程 manifest（材料 + 段 + 资产 + 来源 + 版本）
 *   assets/…            PDF / DOCX / MP3 / 图片，路径由 manifest 的 assets[].path 声明
 *
 * 校验顺序刻意与试卷导入器一致：**先词法、再磁盘、最后语义**。
 * 路径不安全时立刻停在路径层，不去读任何文件 ——
 * 否则"读取一个越界文件"这件事本身就已经发生了。
 *
 * `discover()` 只枚举 `courses/*`，**不触碰 `cet6/papers/*`** ——
 * 因此课程包与试卷包在原理上不可能互相误认（见 `paths.ts` 的 getCoursesDir）。
 */

export const COURSE_MANIFEST_FILENAME = "course.json";

export class CourseManifestReadError extends Error {
  constructor(
    readonly issues: CourseIssue[],
    message = "课程包读取失败",
  ) {
    super(message);
    this.name = "CourseManifestReadError";
  }
}

function sha256(buffer: Buffer | string): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export class NormalizedCourseImporter {
  readonly kind = "normalized_course_package" as const;
  readonly label = "规范化课程包";

  constructor(private readonly coursesDir: string = getCoursesDir()) {}

  /**
   * 发现内容根下的所有候选课程包。
   *
   * 只做一层目录枚举：包必须直接位于 `courses/<dir>/`。
   * 嵌套任意深度会让"哪些文件属于哪个包"变得不明确，并扩大路径攻击面。
   */
  discover(): NormalizedCourseHandle[] {
    // turbopackIgnore：私有内容根刻意位于项目之外，见 catalog.ts 的说明。
    if (!existsSync(/* turbopackIgnore: true */ this.coursesDir)) return [];
    let entries: string[];
    try {
      entries = readdirSync(/* turbopackIgnore: true */ this.coursesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);
    } catch {
      return [];
    }

    const handles: NormalizedCourseHandle[] = [];
    for (const name of entries.sort()) {
      const absolutePath = join(this.coursesDir, name);
      if (!existsSync(/* turbopackIgnore: true */ join(absolutePath, COURSE_MANIFEST_FILENAME))) continue;
      handles.push({ relativePath: name, absolutePath });
    }
    return handles;
  }

  /**
   * 只解析结构，**不读资产字节**。
   *
   * 用途：页面需要展示"这个包里有什么"时不必去哈希几十 MB 的 PDF/MP3。
   * 索引与包是否一致，靠比对「包内声明的 checksum」与「库中索引的 checksum」
   * 判断 —— 同样的可信度，但不读盘。
   */
  parse(handle: NormalizedCourseHandle): ValidatedCourse {
    return this.readAndValidate(handle, { verifyAssets: false });
  }

  /**
   * 解析 + **逐个校验资产真实字节与校验和**，不产生任何写入。
   *
   * 失败时抛 `CourseManifestReadError`，携带精确到字段位置的问题列表。
   */
  validate(handle: NormalizedCourseHandle): ValidatedCourse {
    return this.readAndValidate(handle, { verifyAssets: true });
  }

  private readAndValidate(
    handle: NormalizedCourseHandle,
    options: { verifyAssets: boolean },
  ): ValidatedCourse {
    const issues: CourseIssue[] = [];

    const manifestPath = resolveWithinRoot(handle.absolutePath, COURSE_MANIFEST_FILENAME);
    if (!isRegularFile(manifestPath.absolutePath)) {
      throw new CourseManifestReadError([{ path: COURSE_MANIFEST_FILENAME, message: "包内缺少 course.json" }]);
    }

    const rawText = readFileSync(/* turbopackIgnore: true */ manifestPath.absolutePath, "utf8");
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawText);
    } catch (error) {
      throw new CourseManifestReadError([
        { path: COURSE_MANIFEST_FILENAME, message: `JSON 解析失败：${(error as Error).message}` },
      ]);
    }

    const outcome = validateCourseManifest(parsedJson);
    if (!outcome.ok || !outcome.course) {
      throw new CourseManifestReadError(outcome.issues);
    }

    const course = outcome.course;
    const assets = options.verifyAssets ? this.verifyAssets(handle, course, issues) : course.assets;

    if (issues.length > 0) {
      throw new CourseManifestReadError(issues);
    }

    return {
      content: { ...course, assets },
      checksum: sha256(rawText),
      packageRelativePath: handle.relativePath,
      warnings: outcome.warnings,
    };
  }

  /**
   * 校验每个资产的真实字节与校验和。
   *
   * 为什么必须比对磁盘而不是相信 manifest：manifest 是外部数据。
   * 若只信它声明的 checksum，"包内容与索引不一致"这件事就永远无法被发现 ——
   * 用户看到的会是"PDF 打不开"，而不是"包已损坏"。
   *
   * **只哈希被引用的资产。** 一个包目录里可能残留着未被任何段/表示引用的文件
   * （作者换了版本、忘了删）。它们不参与索引，因此不该让整个包校验失败 ——
   * 但也**不静默忽略**：会作为提醒报出，让作者自己决定删不删。
   */
  private verifyAssets(
    handle: NormalizedCourseHandle,
    course: CoursePackageContent,
    issues: CourseIssue[],
  ): CourseAsset[] {
    const verified: CourseAsset[] = [];

    course.assets.forEach((asset, index) => {
      const base = `assets[${index}]`;
      let resolved: { absolutePath: string; relativePath: string };
      try {
        resolved = resolveWithinRoot(handle.absolutePath, asset.relativePath);
      } catch {
        // 措辞纪律同 paper importer（F-2 同类根因）：不回显 manifest 声名的
        // 路径原文，也不区分"越界"与"文件不存在"（两者的可行动下一步相同）。
        // 判定保留在 resolveWithinRoot 里，一点没松。
        issues.push({
          path: `${base}.path`,
          message:
            "这个资产当前不可用（路径越出了课程包目录，或文件没有随包一起放置）。" +
            "请确认文件已就位且 manifest 里的 path 是包内相对路径，然后重新导入。",
        });
        return;
      }

      if (!isRegularFile(resolved.absolutePath)) {
        issues.push({
          path: `${base}.path`,
          // 同上：不回显 manifest 声明的路径原文。
          message: "资产文件不存在或不是常规文件。请确认文件已随包一起放置。",
        });
        return;
      }

      const size = statSync(/* turbopackIgnore: true */ resolved.absolutePath).size;
      if (size !== asset.bytes) {
        issues.push({
          path: `${base}.bytes`,
          message: `字节数不符：manifest 声明 ${asset.bytes}，磁盘实际 ${size}`,
        });
        return;
      }

      const actual = sha256(readFileSync(/* turbopackIgnore: true */ resolved.absolutePath));
      if (actual !== asset.checksum) {
        issues.push({
          path: `${base}.checksum`,
          message: `校验和不符：manifest 声明 ${asset.checksum.slice(0, 12)}…，磁盘实际 ${actual.slice(0, 12)}…`,
        });
        return;
      }

      verified.push(asset);
    });

    return verified;
  }

  /** 包目录的可读名称。 */
  static displayName(handle: NormalizedCourseHandle): string {
    return basename(handle.absolutePath);
  }

  /** 包内声明的资产总字节数（不含未声明文件）。 */
  static declaredAssetBytes(course: CoursePackageContent): number {
    return course.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  }
}

/** 便捷入口：不做任何写入地校验一个课程包。 */
export function validateCoursePackage(handle: NormalizedCourseHandle, importer?: NormalizedCourseImporter) {
  return (importer ?? new NormalizedCourseImporter()).validate(handle);
}
