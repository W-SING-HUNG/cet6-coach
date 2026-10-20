import { join } from "node:path";
import type { CoursePackageRecord, ExamPaperRecord } from "@/repositories/ports";
import type { CoursePackageContent } from "@/content/course/types";
import { NormalizedCourseImporter } from "@/content/course/importer";
import { NormalizedPackageImporter } from "@/content/paper/importer";
import { getCoursesDir, getPapersDir, isRegularFile, resolveWithinRoot } from "@/content/paper/paths";

/**
 * 当前**规范化包**的真实状态（完整性 + 结构）。
 *
 * ── 这个模块存在的唯一理由 ──
 *
 * 索引（`course_package` / `exam_paper`）记录的是**导入那一刻**的事实：
 * 校验和、内容版本、题目计数。磁盘上的包随时可能被改动、替换、删除或
 * 部分损坏，而**索引不会自己知道**。
 *
 * 因此"这段课程材料此刻是否仍然对应那道真题"**不能**只由
 * "核对过的版本号是否相等"回答 —— 版本相等只说明"没有人正式升过版"，
 * 不说明"包还是当时那一份"。两者之间的缺口正是 fail-open 的入口：
 * 不改 `contentVersion` 直接改盘上的 `course.json`（或 `paper.json`），
 * 版本比对会全部通过，而链接指向的内容已经换了。
 *
 * 本模块把"读当前包 + 比对索引校验和 + 回答目标结构是否仍在"收敛成
 * **唯一实现**，供写入路径（`verifyCanonicalLink`）与运行时路径
 * （`listRuntimeLinksForSegment` / `getCourseLinkOverview`）共同消费。
 * 两处各写一份必然漂移 —— 那正是本次要修的缺陷形态。
 *
 * ── 缓存边界（关键）──
 *
 * 缓存**只活在一次调用内**（由调用方建好、传进来、用完即弃）。
 * 刻意**不做**跨调用/模块级缓存：那种缓存会在磁盘漂移之后继续返回旧结论，
 * 而"漂移必须立刻可见"正是本模块要保证的事。
 * 一次调用内同一份包只读一次，纯属避免无谓重复 I/O，不是性能优化。
 */

export interface CoursePackageIntegrity {
  ok: true;
  packagePath: string;
  /** 索引中记录的 `course.json` 校验和。 */
  indexedChecksum: string;
  /** 当前磁盘上 `course.json` 的校验和。 */
  actualChecksum: string;
  /** 两者是否一致。false ⇒ 包已漂移，索引过期。 */
  checksumMatches: boolean;
  /** 当前包内的 segment id 集合（结构真实性的判据）。 */
  segmentIds: Set<string>;
  /**
   * **本次调用内**已校验的解析内容。
   *
   * ── 为什么它必须留在这里 ──
   *
   * 上一版的揭示路径先读一次包做校验，落库曝光，然后**又解析一次**
   * `course.json` 取正文。那两次读取之间盘上的文件可以被换掉 ——
   * 于是"校验过的内容"与"下发的内容"不是同一份。
   *
   * 把解析结果放进这个**请求内**的结果里，调用方就只需要一次读取：
   * 校验用它，下发正文也用它。这就是"一个已验证快照"的实体。
   *
   * 它**不跨调用**（缓存由调用方新建、用完即弃，见文件头）——
   * 因此下一次请求仍会重新读盘，磁盘漂移依然立刻可见。
   */
  content: CoursePackageContent;
}

export interface CoursePackageIntegrityFailure {
  ok: false;
  packagePath: string;
  reason: string;
}

export type CoursePackageIntegrityResult = CoursePackageIntegrity | CoursePackageIntegrityFailure;

/** 真题包内某个大题/题组/题目的结构索引。 */
export interface PaperSectionStructure {
  id: string;
  groups: Array<{ id: string; questionIds: Set<string> }>;
}

export interface PaperPackageIntegrity {
  ok: true;
  packagePath: string;
  indexedChecksum: string;
  actualChecksum: string;
  checksumMatches: boolean;
  sections: PaperSectionStructure[];
}

export interface PaperPackageIntegrityFailure {
  ok: false;
  packagePath: string;
  reason: string;
}

export type PaperPackageIntegrityResult = PaperPackageIntegrity | PaperPackageIntegrityFailure;

/**
 * 一次调用内的包读取缓存。
 *
 * 必须由调用方在每次公开调用开始时新建 —— 见文件头的缓存边界说明。
 */
export interface PackageIntegrityCache {
  courses: Map<string, CoursePackageIntegrityResult>;
  papers: Map<string, PaperPackageIntegrityResult>;
}

export function createPackageIntegrityCache(): PackageIntegrityCache {
  return { courses: new Map(), papers: new Map() };
}

/**
 * 读取一个课程包的当前状态。
 *
 * 失败（包不存在 / 缺 manifest / 解析不过）返回 `ok: false` 并给出可读原因 ——
 * 调用方必须**失败关闭**，绝不把"读不到"当成"没变化"。
 */
export function readCoursePackageIntegrity(
  record: Pick<CoursePackageRecord, "id" | "packagePath" | "manifestChecksum">,
  cache: PackageIntegrityCache,
): CoursePackageIntegrityResult {
  const cached = cache.courses.get(record.packagePath);
  if (cached) return cached;

  const result = ((): CoursePackageIntegrityResult => {
    try {
      // 库里的路径同样要过安全解析 —— **库不是可信来源**（与试卷 catalog 同一条理由）。
      const resolved = resolveWithinRoot(getCoursesDir(), record.packagePath, { mustExist: false });
      if (!isRegularFile(join(resolved.absolutePath, "course.json"))) {
        return {
          ok: false,
          packagePath: record.packagePath,
          /*
           * ── 措辞纪律（P2-B）──
           *
           * 这个字符串会**出现在界面上**（经 `packageIssue` 或 404 响应）。
           * 因此它不得包含内部目录结构（`private-content/courses/...`）
           * 或磁盘绝对路径 —— 那是本机私有布局的信息。
           *
           * 保留可读解释（"包不存在或缺少清单"）与**相对**标识
           * （包 id 本来就是用户自己导入时给的），足以让人采取行动。
           */
          reason: "这个课程包不存在，或缺少 course.json 清单文件。",
        };
      }

      // 刻意用 `parse`（不核对资产字节）：这里要回答的是
      // "manifest 还是不是索引时那一份、结构还是不是那个结构"。
      // 资产字节属于导入期的一次性校验，不该在每次链接读取时重算几十 MB。
      const parsed = new NormalizedCourseImporter().parse({
        relativePath: record.packagePath,
        absolutePath: resolved.absolutePath,
      });

      /*
       * `parsed.content` 与 `parsed.checksum` 来自**同一次读取**：
       * 校验和是对这份解析结果算的，因此"校验和匹配"与"内容是这个"
       * 不可能对不上。调用方拿到的 `content` 就是被校验的那一份 ——
       * 这正是"一个已验证快照"的实现方式（见 `CoursePackageIntegrity.content`）。
       */
      return {
        ok: true,
        packagePath: record.packagePath,
        indexedChecksum: record.manifestChecksum,
        actualChecksum: parsed.checksum,
        checksumMatches: parsed.checksum === record.manifestChecksum,
        segmentIds: new Set(parsed.content.segments.map((segment) => segment.id)),
        content: parsed.content,
      };
    } catch {
      /*
       * ── 措辞纪律（独立评审 F-2 的同类根因）──
       *
       * 这个 `reason` 会经 `packageIssue` 出现在界面上。底层异常消息可能
       * 回显被拒绝的路径输入（`UnsafePathError` 就是这么写的），而
       * `record.packagePath` 来自**数据库**—— 库不是可信来源，一条被污染
       * 的索引行就能让任意字符串进入浏览器。
       *
       * 因此不透传底层消息。判定全部保留（resolveWithinRoot 的拒绝一点没松），
       * 变的只是不给原文。
       */
      return {
        ok: false,
        packagePath: record.packagePath,
        reason:
          "无法读取这个课程包（索引里登记的路径不安全或无法解析）。请重新导入该课程包以刷新索引。",
      };
    }
  })();

  cache.courses.set(record.packagePath, result);
  return result;
}

/** 读取一份真题包的当前状态（含 section/group/question 结构）。 */
export function readPaperPackageIntegrity(
  record: Pick<ExamPaperRecord, "id" | "packagePath" | "manifestChecksum">,
  cache: PackageIntegrityCache,
): PaperPackageIntegrityResult {
  const cached = cache.papers.get(record.id);
  if (cached) return cached;

  const result = ((): PaperPackageIntegrityResult => {
    try {
      const resolved = resolveWithinRoot(getPapersDir(), record.packagePath, { mustExist: false });
      if (!isRegularFile(join(resolved.absolutePath, "paper.json"))) {
        return {
          ok: false,
          packagePath: record.packagePath,
          // 措辞纪律同课程包（P2-B）：不带内部目录结构。
          reason: "这份真题包不存在，或缺少 paper.json 清单文件。",
        };
      }

      const parsed = new NormalizedPackageImporter().parse({
        relativePath: record.packagePath,
        absolutePath: resolved.absolutePath,
      });

      return {
        ok: true,
        packagePath: record.packagePath,
        indexedChecksum: record.manifestChecksum,
        actualChecksum: parsed.checksum,
        checksumMatches: parsed.checksum === record.manifestChecksum,
        sections: parsed.content.sections.map((section) => ({
          id: section.id,
          groups: section.groups.map((group) => ({
            id: group.id,
            questionIds: new Set(group.questions.map((question) => question.id)),
          })),
        })),
      };
    } catch {
      // 措辞纪律同课程包（F-2 同类根因）：不透传可能回显路径的底层消息。
      return {
        ok: false,
        packagePath: record.packagePath,
        reason: "无法读取这份真题包（索引里登记的路径不安全或无法解析）。请重新导入以刷新索引。",
      };
    }
  })();

  cache.papers.set(record.id, result);
  return result;
}

/**
 * 链接声明的目标结构在**当前**真题包里是否仍然存在（唯一实现）。
 *
 * 判据按 scope 递进：`section` 只要求大题在；`group` 还要求题组在；
 * `question` 三者都要。**不信数据库计数** —— 计数说不出"这个 group_id
 * 是否还在"。
 */
export function paperTargetExists(
  sections: PaperSectionStructure[],
  target: {
    sectionId: string;
    groupId: string | null;
    questionId: string | null;
    targetScope: "section" | "group" | "question";
  },
): boolean {
  const section = sections.find((item) => item.id === target.sectionId);
  if (!section) return false;
  if (target.targetScope === "section") return true;

  if (target.groupId === null) return false;
  const group = section.groups.find((item) => item.id === target.groupId);
  if (!group) return false;
  if (target.targetScope === "group") return true;

  if (target.questionId === null) return false;
  return group.questionIds.has(target.questionId);
}
