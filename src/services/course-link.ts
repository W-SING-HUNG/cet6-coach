import type { CourseRepository, Repositories } from "@/repositories/ports";
import type {
  CourseCanonicalLinkRecord,
  CourseCanonicalLinkView,
  CoursePackageRecord,
} from "@/repositories/ports";
import {
  COURSE_LINK_TARGET_SCOPES,
  COURSE_LINK_VERIFICATION_STATUSES,
  explainLinkUnusable,
  isLinkRuntimeUsable,
  type CourseLinkTargetScope,
  type CourseLinkVerificationStatus,
} from "@/domain/course";
import type { PaperGroup } from "@/content/paper/types";
import { assertScopeShape, linkIdOf, semanticTargetOf } from "@/repositories/sqlite/courses";
import { nowISO } from "@/lib/date";
import {
  createPackageIntegrityCache,
  paperTargetExists,
  readCoursePackageIntegrity,
  readPaperPackageIntegrity,
  type CoursePackageIntegrityResult,
  type PackageIntegrityCache,
} from "./course-packages";

/**
 * 课程段 → 规范真题位置 的链接服务。
 *
 * ── 这是课程层唯一的"创造真相"入口，因此它的职责是**拒绝** ──
 *
 * 一条链接的含义是："**经人工复核**，这段课程材料对应那道真题。"
 * 系统无法自己知道这件事 —— 课程材料按题型重组过，文件名、套别号、
 * "第 1 套"、物理页码顺序、题号本身都**不是**证明。
 * 因此本模块的全部价值在于：把不合格的链接挡在落库之前，并且在运行时
 * 对已经不再成立的链接失败关闭。
 *
 * ── 失败关闭（fail closed）的三层 ──
 *
 * 1. **写入时**：`verifyCanonicalLink` 逐项校验，任一不成立即拒绝写入；
 * 2. **读取时**：`isLinkRuntimeUsable` 按当前版本重算可用性 ——
 *    课程升版或真题升版都会让旧链接**立即变为不可用**，绝不自动沿用；
 * 3. **候选/否决不进运行时**：`candidate` / `rejected` 可以落库保留审计线索，
 *    但运行时读取一律过滤。
 */

// ---------------------------------------------------------------------------
// 写入：核验并追加一条链接
// ---------------------------------------------------------------------------

export interface VerifyCanonicalLinkInput {
  courseId: string;
  /** 包中声明的课程内容版本。必须与当前索引中的版本一致。 */
  courseContentVersion: number;
  segmentId: string;
  paperId: string;
  /** 包中声明的真题内容版本。必须与当前索引中的版本一致。 */
  paperContentVersion: number;
  sectionId: string;
  groupId?: string | null;
  questionId?: string | null;
  targetScope: CourseLinkTargetScope;
  verificationStatus: CourseLinkVerificationStatus;
  /**
   * 核验/审计引用。**已核验时必填** —— 复核的价值来自"谁、依据什么、何时"。
   * 一条没有出处的 verified 链接与机器候选没有区别，只是自称更可信。
   */
  verificationRef: string;
  note?: string | null;
  /**
   * `true` 时**只校验、不写入**（dry-run）。
   *
   * 为什么它是这个函数的一个参数而不是两个函数：
   * 校验与写入必须共用同一段判据。若拆成 `validateLink` + `commitLink`，
   * 调用方就可能在校验通过之后、写入之前改变输入，或者写入路径自己
   * 漏掉某一项检查 —— 而"预演说没问题、真跑却写进去一条不合规的链接"
   * 正是 dry-run 机制要防的事。
   */
  dryRun?: boolean;
}

export type VerifyCanonicalLinkResult =
  | {
      ok: true;
      /** 本次是否真的写入了新行。`false` = 幂等命中（或 dryRun）。 */
      created: boolean;
      /** dry-run 时**没有**落库，这里的 link 是"将要写入的内容"。 */
      link: CourseCanonicalLinkRecord;
      /** dry-run 时为 true：校验全部通过，但没有写入任何数据。 */
      dryRun: boolean;
      warnings: string[];
    }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/**
 * 核验并追加一条 canonical 链接。**失败关闭。**
 *
 * 校验项（逐条对应任务要求，任一不成立即拒绝）：
 *
 * 1. 课程包存在（索引中）；
 * 2. 请求的课程内容版本**就是当前复核版本** —— 不允许为旧版/未来版建链接；
 * 3. segment 在该版本的规范化课程包中确实存在；
 * 4. 目标真题卷存在；
 * 5. 目标真题 contentVersion **精确匹配**；
 * 6. section/group/question 在该真题包中确实存在；
 * 7. 目标粒度在结构上成立（section 不带 group/question，依此类推）；
 * 8. verified 必须有核验引用。
 *
 * ── 为什么必须读**磁盘上的规范化包**，而不是只信数据库 ──
 *
 * 库里的 `question_count` / `section_count` 只是索引事实，它不包含
 * "这个 group_id 是否存在"。若只比计数，一次内容升版后两个版本的
 * group 集合变化就检测不到，链接会指向一个不存在的题组。
 * 因此第 3、6 项读取包的结构。
 *
 * ── 关于"未匹配" ──
 *
 * 本模块**不要求**任何 segment 有链接。它只在"有人明确要建一条链接"时运行。
 * 一个所有段都未匹配的课程包是完全合法的状态，不需要也不应该产生链接。
 */
export function verifyCanonicalLink(
  repos: Repositories,
  input: VerifyCanonicalLinkInput,
): VerifyCanonicalLinkResult {
  const issues: Array<{ path: string; message: string }> = [];
  const warnings: string[] = [];

  // 一次核验只读一次每份包（课程包 + 目标真题包各一次）。
  // 缓存**不跨调用**：磁盘漂移必须在下次调用立刻可见。
  const cache = createPackageIntegrityCache();

  const push = (path: string, message: string) => issues.push({ path, message });

  // ---- 声明形状：先做纯词法检查，避免后面去读磁盘 ----
  if (!COURSE_LINK_TARGET_SCOPES.includes(input.targetScope)) {
    push("targetScope", `未登记的目标粒度：${input.targetScope}`);
  }
  if (!COURSE_LINK_VERIFICATION_STATUSES.includes(input.verificationStatus)) {
    push("verificationStatus", `未登记的核验状态：${input.verificationStatus}`);
  }
  try {
    assertScopeShape(
      input.targetScope,
      input.sectionId,
      input.groupId ?? null,
      input.questionId ?? null,
    );
  } catch (error) {
    push("targetScope", (error as Error).message);
  }
  if (input.verificationStatus === "verified" && input.verificationRef.trim() === "") {
    push(
      "verificationRef",
      "标记 verified 必须给出核验引用（谁、依据什么材料、何时核验的）—— " +
        "一条没有出处的已核验链接与机器候选没有区别，只是自称更可信。",
    );
  }
  if (issues.length > 0) return { ok: false, issues };

  // ---- 1) 课程包存在 ----
  const courseRecord = repos.courses.getPackage(input.courseId);
  if (!courseRecord) {
    return {
      ok: false,
      issues: [
        {
          path: "courseId",
          message: `课程包 ${input.courseId} 不在索引中。先导入课程包，再建立链接。`,
        },
      ],
    };
  }

  // ---- 2) 课程内容版本必须是当前复核版本 ----
  if (input.courseContentVersion !== courseRecord.contentVersion) {
    return {
      ok: false,
      issues: [
        {
          path: "courseContentVersion",
          message:
            `课程内容版本不匹配：请求 v${input.courseContentVersion}，` +
            `索引中为 v${courseRecord.contentVersion}。` +
            `链接只能绑定**当前**版本 —— 为旧版本建链接会让复核结论看起来适用于当前内容。`,
        },
      ],
    };
  }

  // ---- 3) segment 必须存在于该版本的规范化课程包中 ----
  //
  // 同时判定**包完整性**：索引记的 manifest 校验和必须与磁盘现值一致。
  // 早先这里只 push 一条 warning 然后照样写入 —— 那让"包已被改动但没重新导入"
  // 这条路径可以创造出链接真相（Review 的 F1 blocker）。现在它是阻断项。
  const courseIntegrity = readCoursePackageIntegrity(
    {
      id: courseRecord.id,
      packagePath: courseRecord.packagePath,
      manifestChecksum: courseRecord.manifestChecksum,
    },
    cache,
  );
  if (!courseIntegrity.ok) {
    return { ok: false, issues: [{ path: "courseId", message: courseIntegrity.reason }] };
  }
  if (!courseIntegrity.checksumMatches) {
    return {
      ok: false,
      issues: [
        {
          path: "courseId",
          message:
            `课程包已改动但未重新导入（manifest 校验和与索引不一致）：` +
            `索引 ${courseRecord.manifestChecksum.slice(0, 12)}…，磁盘 ${courseIntegrity.actualChecksum.slice(0, 12)}…。` +
            `拒绝写入链接 —— 复核必须针对**已索引的那一版内容**，` +
            `否则这条"已核验"指向的是一份没人复核过的材料。` +
            `请先重新导入课程包（pnpm course:import --commit）并确认内容版本，再核验。`,
        },
      ],
    };
  }

  if (!courseIntegrity.segmentIds.has(input.segmentId)) {
    return {
      ok: false,
      issues: [
        {
          path: "segmentId",
          message:
            `课程段 ${input.segmentId} 不存在于课程包 ${input.courseId} v${input.courseContentVersion} 中。` +
            `拒绝建立指向不存在段的链接。`,
        },
      ],
    };
  }

  // ---- 4) 目标真题卷存在 ----
  const paperRecord = repos.papers.getPaper(input.paperId);
  if (!paperRecord) {
    return {
      ok: false,
      issues: [
        {
          path: "paperId",
          message: `真题卷 ${input.paperId} 不在索引中。链接必须指向一份已导入的真卷。`,
        },
      ],
    };
  }

  // ---- 5) 真题内容版本精确匹配 ----
  if (input.paperContentVersion !== paperRecord.contentVersion) {
    return {
      ok: false,
      issues: [
        {
          path: "paperContentVersion",
          message:
            `真题内容版本不匹配：请求 v${input.paperContentVersion}，` +
            `索引中为 v${paperRecord.contentVersion}。` +
            `版本参与"这是不是同一道题"的身份 —— 允许不匹配会让链接指向另一版内容。`,
        },
      ],
    };
  }

  // ---- 6) 真题包完整性 + section/group/question 必须确实存在 ----
  //
  // 与课程包同一条规则：**版本相等不足以证明内容没变**。
  // 盘上的 paper.json 可以被直接改动而不升版本，此时版本比对会全部通过，
  // 而链接会指向一份已经变了的内容（Review 的 F4，与 F1 同类）。
  const paperIntegrity = readPaperPackageIntegrity(
    {
      id: paperRecord.id,
      packagePath: paperRecord.packagePath,
      manifestChecksum: paperRecord.manifestChecksum,
    },
    cache,
  );
  if (!paperIntegrity.ok) {
    return { ok: false, issues: [{ path: "paperId", message: paperIntegrity.reason }] };
  }
  if (!paperIntegrity.checksumMatches) {
    return {
      ok: false,
      issues: [
        {
          path: "paperId",
          message:
            `真题包已改动但未重新导入（manifest 校验和与索引不一致）：` +
            `索引 ${paperRecord.manifestChecksum.slice(0, 12)}…，磁盘 ${paperIntegrity.actualChecksum.slice(0, 12)}…。` +
            `拒绝写入链接 —— 被复核的那道题可能已经不是同一道题。` +
            `请先重新导入真题包（pnpm content:import --commit）并确认内容版本，再核验。`,
        },
      ],
    };
  }

  if (
    !paperTargetExists(paperIntegrity.sections, {
      sectionId: input.sectionId,
      groupId: input.groupId ?? null,
      questionId: input.questionId ?? null,
      targetScope: input.targetScope,
    })
  ) {
    // 逐层给出可读原因：哪一层不存在、当时有哪些项可用。
    const section = paperIntegrity.sections.find((item) => item.id === input.sectionId);
    if (!section) {
      return {
        ok: false,
        issues: [
          {
            path: "sectionId",
            message:
              `大题 ${input.sectionId} 不存在于真题包 ${input.paperId} v${input.paperContentVersion} 中` +
              `（该包有：${paperIntegrity.sections.map((item) => item.id).join(" / ")}）。`,
          },
        ],
      };
    }
    const group = section.groups.find((item) => item.id === input.groupId);
    if (!group) {
      return {
        ok: false,
        issues: [
          {
            path: "groupId",
            message:
              `题组 ${input.groupId} 不存在于 ${input.paperId} v${input.paperContentVersion} 的 ` +
              `${input.sectionId} 中（该大题有：${section.groups.map((item) => item.id).join(" / ")}）。`,
          },
        ],
      };
    }
    return {
      ok: false,
      issues: [
        {
          path: "questionId",
          message:
            `题目 ${input.questionId} 不存在于 ${input.paperId} v${input.paperContentVersion} 的 ` +
            `${input.sectionId}/${input.groupId} 中。链接不得指向不存在的题目。`,
        },
      ],
    };
  }

  // ---- 7) 计算链接身份（由**复核主张**确定性推导，因此重复写入幂等） ----
  const identity = {
    courseId: input.courseId,
    courseContentVersion: input.courseContentVersion,
    segmentId: input.segmentId,
    paperId: input.paperId,
    paperContentVersion: input.paperContentVersion,
    sectionId: input.sectionId,
    groupId: input.groupId ?? null,
    questionId: input.questionId ?? null,
    targetScope: input.targetScope,
    verificationStatus: input.verificationStatus,
    verificationRef: input.verificationRef,
    note: input.note ?? null,
  };
  const id = linkIdOf(identity);

  // ---- 8) dry-run：全部校验已通过，但不写入任何数据 ----
  //
  // 刻意放在**结构校验之后、写入之前**：这样预演报告的"PASS"与真实写入的
  // 后果是同一段判据的产物，而不是两套代码各自得出的结论。
  if (input.dryRun) {
    const existing = repos.courses.getLink(id);
    if (existing) {
      warnings.push("这份核验声明已经存在（写入将是幂等的，不产生新行）。");
    }
    return {
      ok: true,
      created: false,
      dryRun: true,
      warnings,
      link:
        existing ?? {
          id,
          courseId: input.courseId,
          segmentId: input.segmentId,
          courseContentVersion: input.courseContentVersion,
          paperId: input.paperId,
          paperContentVersion: input.paperContentVersion,
          sectionId: input.sectionId,
          groupId: input.groupId ?? null,
          questionId: input.questionId ?? null,
          targetScope: input.targetScope,
          verificationStatus: input.verificationStatus,
          verificationRef: input.verificationRef,
          note: input.note ?? null,
          createdAt: "",
        },
    };
  }

  // ---- 9) 写出 ----
  const { link, created } = repos.courses.appendLink({
    id,
    courseId: input.courseId,
    segmentId: input.segmentId,
    courseContentVersion: input.courseContentVersion,
    paperId: input.paperId,
    paperContentVersion: input.paperContentVersion,
    sectionId: input.sectionId,
    groupId: input.groupId ?? null,
    questionId: input.questionId ?? null,
    targetScope: input.targetScope,
    verificationStatus: input.verificationStatus,
    verificationRef: input.verificationRef,
    note: input.note ?? null,
    createdAt: nowISO(),
  });

  if (!created) {
    warnings.push("这份核验声明已经存在，本次未产生新行（幂等）。");
  }

  return { ok: true, created, dryRun: false, link, warnings };
}

// ---------------------------------------------------------------------------
// 读取：运行时可用性（fail-closed）
// ---------------------------------------------------------------------------

/**
 * 读取某一段的全部链接，**并逐条按当前真实状态重算运行时可用性**。
 *
 * 可用性**不是存储字段**：若把它存成一列，课程/真题每次升版都要去改
 * 所有相关行 —— 那正是"静默升级"的入口，而本层明确拒绝它。
 *
 * ── 判据是**当前盘的真相**，不只是版本号（本次 Review Fix 的核心）──
 *
 * 一条 verified 链接可用，要求下列**全部**成立：
 *
 * 1. `verificationStatus === "verified"`；
 * 2. 课程包在索引中，且链接记录的课程内容版本 = 当前索引版本；
 * 3. 真题卷在索引中，且链接记录的真题内容版本 = 当前索引版本；
 * 4. **当前课程规范化包可读**，且其 manifest 校验和 = 索引登记值；
 * 5. **当前真题规范化包可读**，且其 manifest 校验和 = 索引登记值；
 * 6. 声明的大题/题组/题目在**当前**真题包里仍然结构存在。
 *
 * 第 4~6 条是本轮补上的：只有 2、3 时系统是 **fail-open** 的 ——
 * 直接把盘上的 `course.json` / `paper.json` 改掉而不升版本，
 * 版本比对会全部通过，链接看起来仍然可用，而它指向的内容已经换了。
 *
 * 返回全部链接（含 candidate / rejected / stale），由调用方按
 * `runtimeUsable` 决定用途。这样"有哪些历史复核记录"永远可回答。
 *
 * 一次调用只读一次每份包（`cache`），避免无谓的重复 I/O；
 * 缓存**不跨调用**，因此磁盘漂移在下次读取时立刻可见。
 */
export function listLinksForSegmentWithUsability(
  repos: Repositories,
  courseId: string,
  segmentId: string,
  cache: PackageIntegrityCache = createPackageIntegrityCache(),
): CourseCanonicalLinkView[] {
  const courseRecord = repos.courses.getPackage(courseId);
  const links = repos.courses.listLinksForSegment(courseId, segmentId);

  // 课程包完整性：**一次调用只算一次**（同一门课的所有链接共用同一份包）。
  const courseIntegrity = courseRecord
    ? readCoursePackageIntegrity(
        {
          id: courseRecord.id,
          packagePath: courseRecord.packagePath,
          manifestChecksum: courseRecord.manifestChecksum,
        },
        cache,
      )
    : null;

  return links.map((link) => {
    const evaluation = evaluateLinkRuntimeState(link, {
      courseRecord,
      courseIntegrity,
      repos,
      cache,
    });

    return {
      link,
      runtimeUsable: evaluation.usable,
      unusableReason: evaluation.usable ? null : evaluation.reason,
    };
  });
}

/**
 * **唯一权威**的运行时可用性求值（纯函数 + 已读好的包状态）。
 *
 * 抽出来是为了让 `listLinksForSegmentWithUsability` 与
 * `getCourseLinkOverview` 共用**同一段判据** —— 两处各写一份必然漂移，
 * 而漂移的一种具体后果就是"概览说可用、实际列表说不可用"。
 */
function evaluateLinkRuntimeState(
  link: CourseCanonicalLinkRecord,
  ctx: {
    courseRecord: CoursePackageRecord | null;
    courseIntegrity: CoursePackageIntegrityResult | null;
    repos: Repositories;
    cache: PackageIntegrityCache;
  },
): { usable: boolean; reason: string | null } {
  const paperRecord = ctx.repos.papers.getPaper(link.paperId);

  // ---- 先做纯版本/状态判定，拿到既有的可读措辞（保持措辞单一来源）----
  const versionUsable = isLinkRuntimeUsable({
    status: link.verificationStatus,
    courseContentVersion: link.courseContentVersion,
    paperContentVersion: link.paperContentVersion,
    currentCourseContentVersion: ctx.courseRecord?.contentVersion ?? null,
    currentPaperContentVersion: paperRecord?.contentVersion ?? null,
  });

  if (!versionUsable) {
    return {
      usable: false,
      reason: explainLinkUnusable({
        status: link.verificationStatus,
        courseContentVersion: link.courseContentVersion,
        paperContentVersion: link.paperContentVersion,
        currentCourseContentVersion: ctx.courseRecord?.contentVersion ?? null,
        currentPaperContentVersion: paperRecord?.contentVersion ?? null,
      }),
    };
  }

  // 到这里 status === verified 且两侧版本都匹配，且两侧记录都存在。
  // 剩下的判据是"盘的真相是否仍与索引一致"。

  // ---- 课程包完整性 ----
  if (!ctx.courseIntegrity || !ctx.courseIntegrity.ok) {
    return { usable: false, reason: ctx.courseIntegrity?.reason ?? "课程包不可读。" };
  }
  if (!ctx.courseIntegrity.checksumMatches) {
    return { usable: false, reason: explainPackageDrift("course") };
  }

  // ---- 真题包完整性 ----
  // paperRecord 在此必然非空（版本判定已通过），但保持防御性写法。
  if (!paperRecord) {
    return { usable: false, reason: "目标真题不在索引中，无法确认它当前是哪一版内容。" };
  }
  const paperIntegrity = readPaperPackageIntegrity(
    {
      id: paperRecord.id,
      packagePath: paperRecord.packagePath,
      manifestChecksum: paperRecord.manifestChecksum,
    },
    ctx.cache,
  );
  if (!paperIntegrity.ok) {
    return { usable: false, reason: paperIntegrity.reason };
  }
  if (!paperIntegrity.checksumMatches) {
    return { usable: false, reason: explainPackageDrift("paper") };
  }

  // ---- 目标结构在**当前**包里是否仍然存在 ----
  const targetExists = paperTargetExists(paperIntegrity.sections, {
    sectionId: link.sectionId,
    groupId: link.groupId,
    questionId: link.questionId,
    targetScope: link.targetScope,
  });
  if (!targetExists) {
    return {
      usable: false,
      reason:
        `复核时声明的大题/题组/题目在当前真题包中已不存在（${describeLinkTarget(link)}），` +
        `因此这条对应关系不再可用。需要重新核验。`,
    };
  }

  return { usable: true, reason: null };
}

/**
 * 包漂移的**唯一措辞**。
 *
 * 同时给出"为什么"与"怎么办"：只说"不可用"会让操作者以为链接坏了，
 * 而实际上需要的是重新导入把索引对齐到盘上的内容。
 */
function explainPackageDrift(side: "course" | "paper"): string {
  const what = side === "course" ? "课程包" : "真题包";
  const fix = side === "course" ? "pnpm course:import --commit" : "pnpm content:import --commit";
  return (
    `${what}已在盘上被改动，但**没有重新导入**（manifest 校验和与索引不一致）。` +
    `版本号虽然未变，包的内容已经不是复核时那一份 —— 因此这条链接立即不可用。` +
    `如需继续使用，请先重新导入（${fix}）并确认内容版本，然后重新核验。`
  );
}

/**
 * 运行时链接：只返回**当前可用**的 verified 链接，且按**语义目标去重**。
 *
 * 这是所有下游（规划器、未触碰判定、未来 UI）应当使用的入口。
 *
 * ── 为什么必须去重（Review 的 F3）──
 *
 * 一行 = 一条不可变复核主张。同一组映射被独立复核两次、或出处被修正后
 * 重新核验，会产生**多条**都指向同一目标的 verified 行。
 * 若原样返回，"复核了一次"与"复核了两次"在下游看起来就是**两个不同的
 * 对应关系** —— 一个 canonical 目标凭空多出一个含义。
 *
 * 去重按 `courseLinkSemanticTarget`（不含出处/注解/时间），
 * 代表行选取**确定性**：`createdAt` 最新者，平手时按 id 升序 ——
 * 因此同一次调用的结果与顺序无关、可复现。
 *
 * 原始历史 API（`listLinksForSegment` / `listLinksForSegmentWithUsability`）
 * 仍然返回**每一条**不可变行，去重只发生在运行时真相这一层。
 */
export function listRuntimeLinksForSegment(
  repos: Repositories,
  courseId: string,
  segmentId: string,
  cache: PackageIntegrityCache = createPackageIntegrityCache(),
): CourseCanonicalLinkRecord[] {
  const usable = listLinksForSegmentWithUsability(repos, courseId, segmentId, cache)
    .filter((view) => view.runtimeUsable)
    .map((view) => view.link);

  return dedupeBySemanticTarget(usable);
}

/**
 * 按语义目标去重，并选出确定性代表行。
 *
 * 代表行 = `createdAt` 最新；`createdAt` 相同则 id 字典序最小。
 * 这样"同一目标被复核多次"在运行时始终收敛到**一条**真相，
 * 且选谁是确定的（不依赖查询返回顺序）。
 */
export function dedupeBySemanticTarget(
  links: CourseCanonicalLinkRecord[],
): CourseCanonicalLinkRecord[] {
  const byTarget = new Map<string, CourseCanonicalLinkRecord>();

  for (const link of links) {
    const target = semanticTargetOf({
      courseId: link.courseId,
      courseContentVersion: link.courseContentVersion,
      segmentId: link.segmentId,
      paperId: link.paperId,
      paperContentVersion: link.paperContentVersion,
      sectionId: link.sectionId,
      groupId: link.groupId,
      questionId: link.questionId,
      targetScope: link.targetScope,
    });

    const current = byTarget.get(target);
    if (!current || isNewerRepresentative(link, current)) byTarget.set(target, link);
  }

  // 输出顺序按语义目标 id 排序 —— 稳定，不依赖 Map 插入顺序。
  return [...byTarget.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, link]) => link);
}

function isNewerRepresentative(candidate: CourseCanonicalLinkRecord, current: CourseCanonicalLinkRecord): boolean {
  if (candidate.createdAt !== current.createdAt) return candidate.createdAt > current.createdAt;
  return candidate.id < current.id;
}

/**
 * 整个课程包的链接概览。用于 CLI 与后续阶段的"哪些段已匹配"报告。
 *
 * `matched` / `unmatched` 的区分是**如实报告**，不是质量分数 ——
 * 未匹配是合法状态（见 `services/course-import.ts` 的说明）。
 */
export interface CourseLinkOverview {
  courseId: string;
  currentContentVersion: number | null;
  totalSegments: number | null;
  /**
   * **按语义目标去重后**的可用链接数。
   *
   * 去重的原因见 `listRuntimeLinksForSegment`：同一映射被独立复核多次
   * 会产生多条都成立的不可变行，但它们描述的是**同一个**运行时目标。
   * 不去重会把"复核了两次"报成"有两个对应关系"。
   */
  verifiedUsable: number;
  /** 不可用的 verified 行数（含版本失配与包漂移）。 */
  staleVerified: number;
  candidates: number;
  rejected: number;
  /** **全部**不可变复核行的总数（审计历史，不去重）。 */
  verifiedRows: number;
  /** 有可用运行时目标的 segment id 集合（已去重）。 */
  matchedSegmentIds: string[];
}

export function getCourseLinkOverview(
  repos: Repositories,
  courseId: string,
  cache: PackageIntegrityCache = createPackageIntegrityCache(),
): CourseLinkOverview {
  const record = repos.courses.getPackage(courseId);
  const links = repos.courses.listLinksForCourse(courseId);

  // 课程包完整性：整个概览只读一次。
  const courseIntegrity = record
    ? readCoursePackageIntegrity(
        {
          id: record.id,
          packagePath: record.packagePath,
          manifestChecksum: record.manifestChecksum,
        },
        cache,
      )
    : null;

  let staleVerified = 0;
  let candidates = 0;
  let rejected = 0;
  let verifiedRows = 0;
  const usableLinks: CourseCanonicalLinkRecord[] = [];

  for (const link of links) {
    if (link.verificationStatus === "candidate") {
      candidates += 1;
      continue;
    }
    if (link.verificationStatus === "rejected") {
      rejected += 1;
      continue;
    }

    verifiedRows += 1;
    // 与列表路径**共用同一段判据** —— 两处各写一份必然漂移，
    // 后果是"概览说可用、实际列表说不可用"。
    const evaluation = evaluateLinkRuntimeState(link, {
      courseRecord: record,
      courseIntegrity,
      repos,
      cache,
    });
    if (evaluation.usable) usableLinks.push(link);
    else staleVerified += 1;
  }

  // 运行时目标去重：同一语义目标只算一个。
  const deduped = dedupeBySemanticTarget(usableLinks);

  // 段总数从磁盘包读取。读不到就如实给 null —— 不猜。
  let totalSegments: number | null = record?.segmentCount ?? null;
  if (courseIntegrity?.ok) {
    totalSegments = courseIntegrity.segmentIds.size;
  }

  return {
    courseId,
    currentContentVersion: record?.contentVersion ?? null,
    totalSegments,
    verifiedUsable: deduped.length,
    staleVerified,
    candidates,
    rejected,
    verifiedRows,
    matchedSegmentIds: [...new Set(deduped.map((link) => link.segmentId))].sort(),
  };
}

// ---------------------------------------------------------------------------
// 内部：可读描述
// ---------------------------------------------------------------------------
//
// 注意：包的路径解析与结构读取**已经全部搬到 `./course-packages`**。
// 本文件不再自己拼路径或读盘 —— 那是"唯一实现"边界的一部分：
// 写入路径与运行时路径必须消费同一份包状态判据。

/** 供测试与 CLI 使用：链接目标的可读描述。 */
export function describeLinkTarget(link: CourseCanonicalLinkRecord): string {
  const base = `${link.paperId} v${link.paperContentVersion} · ${link.sectionId}`;
  if (link.targetScope === "question") return `${base} / ${link.groupId} / ${link.questionId}`;
  if (link.targetScope === "group") return `${base} / ${link.groupId}`;
  return base;
}

/** 组内题号区间，用于人工核验时的可读确认。 */
export function groupQuestionIds(group: PaperGroup): string[] {
  return group.questions.map((question) => question.id);
}

export type { CourseRepository };
