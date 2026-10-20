import type { Repositories } from "@/repositories/ports";
import type { CourseCanonicalLinkRecord, ExamPaperRecord } from "@/repositories/ports";
import type { CourseExposureEvent } from "@/domain/models";
import {
  decidePaperFreshness,
  establishesPotentialContact,
  establishesSeenContent,
  isPaperEligibleForStrictMock as domainIsPaperEligibleForStrictMock,
  type PaperExposureMatch,
  type PaperFreshness,
  type PaperFreshnessUnresolved,
} from "@/domain/paper-freshness";
import { isPaperReservedForMock } from "@/domain/paper";
import { listLinksForSegmentWithUsability } from "./course-link";
import {
  createPackageIntegrityCache,
  readCoursePackageIntegrity,
  readPaperPackageIntegrity,
  type PackageIntegrityCache,
} from "./course-packages";

/**
 * 试卷**模考新鲜度**的读取服务。
 *
 * ── 它回答的唯一问题 ──
 *
 *   "系统能否诚实地断言：这份试卷对这位学习者而言仍然完全没见过？"
 *
 * ── 它是**派生**的，不是存储的（Invariant 4）──
 *
 * 没有新表、没有缓存、没有回填。新鲜度 = f(不可变曝光事实, 不可变复核链接, 当前包完整性)，
 * 在**读取时**算出。
 *
 * 为什么不存：存下来会立刻产生第二个真相，而它会漂移 —— 漂移的具体后果是
 * "库里说未见、事实已见过"。旧曝光行**永不**被改写；一条今天新增的链接
 * 会**自动**让两周前那条曝光参与投影（Invariant 5），因为投影本来就是在读时算的。
 *
 * ── 复用既有的唯一判据，不新造第二套（任务书的硬要求）──
 *
 * "一条链接在运行时是否成立"这个判断**只**由 `course-link.ts` 的
 * `listLinksForSegmentWithUsability` 给出（它内部用 `evaluateLinkRuntimeState`
 * 做版本 + 课程包完整性 + 真题包完整性 + 目标结构四项判定）。
 * 本模块**不**自己比较版本、**不**自己读盘下结论 —— 那会产生第二个判据，
 * 而两个判据必然漂移，漂移的方向就是 fail-open。
 *
 * 本模块只做两件事：
 * 1. 把"可用链接"与"曝光事件"按**精确内容版本**对上（Invariant 5 / 版本语义）；
 * 2. 把"不可用的 verified 链接"如实登记为**未解决条件**（失败关闭）。
 *
 * 包完整性的读取（`readCoursePackageIntegrity` / `readPaperPackageIntegrity`）
 * 只用于**给未解决条件分类与措辞**。可用性判定本身仍然只来自上面那一个入口。
 *
 * ── 绝不越界（Invariant 1）──
 *
 * 本文件不 import `expert` 相关任何符号，也没有任何写入路径：它只读
 * `course_exposure_event` / `course_canonical_link` / 包索引。课程曝光
 * 永远不产生 performance_event / assessment_event / evidence_projection /
 * skill_profile / answer_attempt，也永不产生掌握度、分数、弱项或诊断结论。
 * 由 `tests/architecture.test.ts` 在源码层守护。
 */

// ---------------------------------------------------------------------------
// 读取索引（一次调用内共享包完整性缓存）
// ---------------------------------------------------------------------------

/**
 * 一批试卷的新鲜度索引。
 *
 * 只保存**有结论**的试卷（`exposed` / `uncertain`）。没有任何证据与未解决条件的
 * 试卷不在这里 —— 它们由 `get()` 返回 `pristinePaperFreshness()`。
 *
 * 这样做的理由：库里绝大多数试卷是 pristine 的，把每一份都物化成一个对象
 * 只会让"哪些卷子真的需要注意"淹没在噪声里。
 */
export interface PaperFreshnessIndex {
  profileId: string;
  /** 只含 exposed / uncertain 的试卷。 */
  notable: PaperFreshness[];
  /** 是否读取了课程层（未激活时为 false —— 如实说明，而不是假装没有曝光）。 */
  courseLayerActivated: boolean;
  /** 读取到的曝光事件总数（只读计数，不含任何派生结论）。 */
  exposureEventCount: number;
  /** 任意试卷的新鲜度；没有记录时为 pristine。 */
  get(paperId: string): PaperFreshness;
}

/** 一份**没有**任何证据与未解决条件的试卷的新鲜度。 */
export function pristinePaperFreshness(paperId: string): PaperFreshness {
  return { paperId, state: "pristine", matches: [], unresolved: [] };
}

/**
 * 计算**整个库**的新鲜度（一次遍历）。
 *
 * 这是本能力的权威入口：单份试卷的 `getPaperFreshness` 由它派生，
 * 因此"详情页说 A、列表页说 B"在结构上不可能发生。
 *
 * ── 为什么按 segment 分组而不是按 paper ──
 *
 * 曝光事实**只**以 `(profile, course, segment, 当时的内容版本)` 为主身份
 * （这是它能被日后回溯投影的前提，见 `domain/models.ts` 的说明）。
 * 因此连接曝光与真题的唯一途径是经过**链接**，而链接是按 segment 存的。
 */
export function getPaperFreshnessIndex(
  repos: Repositories,
  profileId: string,
  cache: PackageIntegrityCache = createPackageIntegrityCache(),
): PaperFreshnessIndex {
  // 课程层未激活（v8 库）时不存在任何合法的课程层行 —— 这是事实，不是猜测。
  if (!repos.courses.isActivated()) {
    return makeIndex(profileId, new Map(), false, 0);
  }

  const exposures = repos.courses.listAllExposureForProfile(profileId);

  // 按 (courseId, segmentId) 分组。曝光是观测流，同一个段可以有多条。
  const bySegment = new Map<string, { courseId: string; segmentId: string; events: CourseExposureEvent[] }>();
  for (const event of exposures) {
    const key = `${event.courseId}\u0000${event.segmentId}`;
    const group = bySegment.get(key) ?? { courseId: event.courseId, segmentId: event.segmentId, events: [] };
    group.events.push(event);
    bySegment.set(key, group);
  }

  const matchesByPaper = new Map<string, PaperExposureMatch[]>();
  const unresolvedByPaper = new Map<string, PaperFreshnessUnresolved[]>();

  const pushMatch = (match: PaperExposureMatch) => {
    const list = matchesByPaper.get(match.paperId) ?? [];
    list.push(match);
    matchesByPaper.set(match.paperId, list);
  };
  const pushUnresolved = (paperId: string, item: PaperFreshnessUnresolved) => {
    const list = unresolvedByPaper.get(paperId) ?? [];
    list.push(item);
    unresolvedByPaper.set(paperId, list);
  };

  /*
   * 分组的键顺序必须是**确定的** —— 否则当同一份试卷既被证明接触又被登记为
   * 未解决时，`unresolved` 的排列会随查询返回顺序变化。Map 的插入顺序在这里
   * 由 `listAllExposureForProfile` 的 ORDER BY 决定，而那个顺序是 (course_id,
   * segment_id)，本身确定。为稳妥起见仍显式排序。
   */
  const groups = [...bySegment.values()].sort(
    (a, b) => a.courseId.localeCompare(b.courseId) || a.segmentId.localeCompare(b.segmentId),
  );

  for (const group of groups) {
    /*
     * ── 只考察「这位学习者**可能接触过**的段」──
     *
     * 分组的来源是**曝光事件**（见上方的 `bySegment`），因此能走到这里的段
     * 至少有一条曝光。但那条曝光可能落在别的 profile 上吗？不会 ——
     * `listAllExposureForProfile` 已按 profile 过滤。
     *
     * 那么下面那个 `continue` 挡的是什么？它挡的是**既无已确认接触、
     * 也无潜在接触**的段。那种段的链接无论成立与否都不携带任何关于
     * 这位学习者的信息 —— 他既没看过那段材料，也没要求看过它，
     * 所以它不可能造成接触。
     *
     * 这条边界必须显式存在，理由是具体的：一次普通的课程升版会让**任意**
     * 一条陈旧链接失效。若把"没有曝光过的段上的失效链接"也算作不确定性，
     * 整库试卷会因为与本人无关的链接而变成 uncertain —— 于是"无法确认"
     * 不再是一种值得注意的状态，而是一句背景噪声，真正需要注意的那一份
     * 反而被淹没。措辞纪律在这里同样适用：噪声会让信号失效。
     */
    /*
     * 两类事件分开处理（这是 P0-5 修正的核心）：
     *
     * - `seenEvents`：足以断言"确实看过"的事件 —— 它们产生 `exposed`；
     * - `potentialEvents`：只足以断言"可能看过"的事件（当前只有
     *   `reveal_requested`）—— 它们产生 `uncertain`。
     *
     * 为什么要分开：把"请求过揭示"算成"确实看过"会让 `exposed` 这个词
     * 失去含义。它本来只用于**已证明**的接触。而请求只说明学习者想读，
     * 不说明他读到了。
     */
    const seenEvents = group.events.filter((event) => establishesSeenContent(event.eventType));
    const potentialOnlyEvents = group.events.filter(
      (event) =>
        !establishesSeenContent(event.eventType) &&
        establishesPotentialContact(event.eventType),
    );

    // 两类都没有 ⇒ 这段与"见过"无关，不进考察。
    if (seenEvents.length === 0 && potentialOnlyEvents.length === 0) continue;

    // **唯一权威**的运行时可用性判定（含两包完整性与目标结构）。
    const views = listLinksForSegmentWithUsability(repos, group.courseId, group.segmentId, cache);

    /*
     * 已确认曝光的**内容版本**集合。刻意由 `seenEvents` 推导（而不是全部事件）——
     * 两处口径必须同一份，否则一个"只算潜在接触"的事件会通过版本比对
     * 进入正面证据分支，凭空造出一条 `exposed`。
     */
    const seenVersions = new Set(seenEvents.map((event) => event.courseContentVersion));
    /** 潜在接触曝光的内容版本集合（`reveal_requested` 的版本）。 */
    const potentialVersions = new Set(potentialOnlyEvents.map((event) => event.courseContentVersion));

    for (const view of views) {
      const link = view.link;

      // 候选与否决**从不**建立真题身份 —— 既不构成正面证据，也不构成不确定性。
      // 它们不是关于"这段材料对应哪道题"的成立主张。
      if (link.verificationStatus !== "verified") continue;

      if (view.runtimeUsable) {
        if (seenVersions.has(link.courseContentVersion)) {
          /*
           * 链接成立，且**已确认**曝光精确落在它绑定的那一版课程内容上
           * ⇒ 正面证据（`exposed`）。
           *
           * `seenVersions` 由 `seenEvents` 推导，因此这里命中就意味着
           * 至少有一条"足以断言确实看过"的事件在同一版本上。
           */
          const matching = seenEvents.filter(
            (event) => event.courseContentVersion === link.courseContentVersion,
          );

          pushMatch(buildMatch(link, matching));
        } else if (potentialVersions.has(link.courseContentVersion)) {
          /*
           * 链接成立，且**只有**潜在接触落在它绑定的那一版上。
           *
           * 具体情形：学习者点过「看这段」（`reveal_requested`），
           * 但没有任何已确认的看过事件。
           *
           * 正确结论是 **`uncertain`**，不是 `exposed`（没有证明他看过）、
           * 更不是 `pristine`（请求本身就是反向证据）。
           */
          pushUnresolved(link.paperId, {
            code: "potential_contact_only",
            message:
              `学习者请求过阅读这段课程材料（对应本卷的这个大题），但请求本身不证明他读到了 —— ` +
              `系统无法断言他仍然完全没见过，因此不作为严格未见模考。`,
            courseId: link.courseId,
            segmentId: link.segmentId,
            linkId: link.id,
          });
        } else {
          /*
           * 链接当前成立，但**没有任何曝光落在它绑定的那一版课程内容上**。
           *
           * 具体情形：学习者看过 v1 的这段材料，课程后来升到 v2 并被人重新核验，
           * 于是 v2 的链接成立而 v1 的曝光对不上。
           *
           * 正确处置是**不确定**，不是 pristine —— 学习者确实看过这段材料，
           * 只是我们无法证明他看的那一版就是被核验的这一版。
           * "无法证明仍然没见过" ≠ "没见过"。
           */
          const anyVersions = new Set(
            [...seenVersions, ...potentialVersions].filter((version) => Number.isFinite(version)),
          );
          pushUnresolved(link.paperId, {
            code: "exposure_version_mismatch",
            message:
              `这段课程材料被人核验指向这份试卷，但学习者的记录落在课程 v${[...anyVersions]
                .sort((a, b) => a - b)
                .map((version) => `v${version}`)
                .join(" / ")}，` +
              `而被核验的是 v${link.courseContentVersion} —— 无法确认他看到的就是被核验的那一版内容。` +
              `需要重新核验或确认版本对应关系。`,
            courseId: link.courseId,
            segmentId: link.segmentId,
            linkId: link.id,
          });
        }
        continue;
      }

      // verified 但当前**不成立**。失败关闭：登记为未解决，绝不当成 pristine。
      pushUnresolved(link.paperId, classifyUnusable(repos, link, cache));
    }
  }

  const paperIds = new Set([...matchesByPaper.keys(), ...unresolvedByPaper.keys()]);
  const notable = new Map<string, PaperFreshness>();
  for (const paperId of [...paperIds].sort()) {
    const freshness = decidePaperFreshness({
      paperId,
      matches: matchesByPaper.get(paperId) ?? [],
      unresolved: unresolvedByPaper.get(paperId) ?? [],
    });
    /*
     * "值得呈现" ⇔ "不满足严格未见模考资格"（即 exposed 或 uncertain）。
     *
     * 这两个说法**按定义等价**，因此判据经 domain 谓词而不是自己比较状态 ——
     * 自己比较会让"什么算有结论"与"什么算不合格"成为两处独立判断，
     * 将来语义一变就只剩一处被改。
     *
     * 理论上不会走到 pristine 分支（有 paperId 就必有证据或未解决条件），
     * 但保持防御性：不给"毫无结论"的试卷造一条记录。
     */
    if (!domainIsPaperEligibleForStrictMock(freshness)) notable.set(paperId, freshness);
  }

  return makeIndex(profileId, notable, true, exposures.length);
}

/**
 * 单份试卷的新鲜度。
 *
 * **刻意委托给批量实现**：若这里另写一套"只算这一份"的逻辑，它迟早会与
 * 列表页的口径漂移 —— 而那种漂移的表现正是"列表说已接触、详情说未接触"。
 * 库里试卷数量是几十份的量级，整库遍历的代价可以忽略。
 */
export function getPaperFreshness(
  repos: Repositories,
  profileId: string,
  paperId: string,
): PaperFreshness {
  return getPaperFreshnessIndex(repos, profileId).get(paperId);
}

/**
 * 严格未见模考资格（服务层入口）。
 *
 * ── 它**必须**委托给 domain 的谓词，不得自己判断 ──
 *
 * 这里曾经写成 `.state === "pristine"` —— 与 `isPaperEligibleForStrictMock`
 * 重复了同一个决定。两处各写一份的后果不是"多写一行"，而是**漂移**：
 * 一旦严格模考语义变化（例如将来某个 `uncertain` 子类被判定为可用），
 * 只有一处会被改，另一处会继续按旧规则回答 —— 而"这份卷子能不能当严格
 * 模考"正是本能力存在的那个问题，两个答案就是没有答案。
 *
 * 因此这里的全部职责只是**取数**（求解新鲜度），判断交给唯一实现。
 * 由 `tests/paper-freshness.test.ts` 的"判定收敛到一处"用例守护。
 */
export function isPaperEligibleForStrictMock(
  repos: Repositories,
  profileId: string,
  paperId: string,
): boolean {
  return domainIsPaperEligibleForStrictMock(getPaperFreshness(repos, profileId, paperId));
}

/**
 * 库级别的汇总计数。用于列表页的说明文案（"有几份保留卷已经接触过"）。
 *
 * 刻意**不含**任何质量分数或比例制结论 —— 只数事实。
 */
export interface PaperFreshnessSummary {
  pristine: number;
  exposed: number;
  uncertain: number;
}

export function summarizePaperFreshness(
  index: PaperFreshnessIndex,
  papers: Array<Pick<ExamPaperRecord, "id" | "pool">>,
): PaperFreshnessSummary {
  const summary: PaperFreshnessSummary = { pristine: 0, exposed: 0, uncertain: 0 };
  for (const paper of papers) {
    /*
     * 只统计**模考保留**的试卷：那是"严格未见模考"这个承诺实际被作出的地方。
     * 训练池试卷被接触是正常且预期的，把它算进"有问题"会制造假警报。
     *
     * 判据必须经**权威池谓词**，不得写裸的 `pool !== "mock_reserve"`：
     * 池归属的判定已经收敛到 `domain/paper.ts`，多写一处就多一处漂移点。
     * 由 `tests/paper-pool-policy.test.ts` 在源码层守护。
     */
    if (!isPaperReservedForMock(paper)) continue;
    summary[index.get(paper.id).state] += 1;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function makeIndex(
  profileId: string,
  notable: Map<string, PaperFreshness>,
  courseLayerActivated: boolean,
  exposureEventCount: number,
): PaperFreshnessIndex {
  return {
    profileId,
    notable: [...notable.values()],
    courseLayerActivated,
    exposureEventCount,
    get(paperId: string): PaperFreshness {
      return notable.get(paperId) ?? pristinePaperFreshness(paperId);
    },
  };
}

/**
 * 由一条**可用**链接与匹配到的那一版曝光构造证据。
 *
 * `exposureCount` 只如实记录"看过几次"，**不参与**聚合口径 ——
 * 否则"多看了两遍"会被算成"接触了更多内容"，那是凭空造出的严重度。
 */
function buildMatch(link: CourseCanonicalLinkRecord, events: CourseExposureEvent[]): PaperExposureMatch {
  const times = events.map((event) => event.occurredAt).sort();
  return {
    paperId: link.paperId,
    paperContentVersion: link.paperContentVersion,
    sectionId: link.sectionId,
    groupId: link.groupId,
    questionId: link.questionId,
    targetScope: link.targetScope,
    courseId: link.courseId,
    segmentId: link.segmentId,
    courseContentVersion: link.courseContentVersion,
    linkId: link.id,
    verificationRef: link.verificationRef,
    firstExposedAt: times[0] ?? "",
    lastExposedAt: times[times.length - 1] ?? "",
    exposureCount: events.length,
    eventTypes: [...new Set(events.map((event) => event.eventType))].sort(),
  };
}

/**
 * 给一条"verified 但当前不成立"的链接分类并措辞。
 *
 * ── 与可用性判定的边界（重要）──
 *
 * 这个函数**不决定**链接是否可用 —— 那个决定已经由
 * `listLinksForSegmentWithUsability` 做出，本函数只在"不可用"这个既成结论上
 * 补充**为什么不可用**的可读原因。
 *
 * 它复用的是同一份包完整性实现（`services/course-packages.ts`），
 * 因此不会产生第二个判据；只是把同一份事实换个说法讲给用户听。
 */
function classifyUnusable(
  repos: Repositories,
  link: CourseCanonicalLinkRecord,
  cache: PackageIntegrityCache,
): PaperFreshnessUnresolved {
  const base = { courseId: link.courseId, segmentId: link.segmentId, linkId: link.id };

  // ---- 课程侧 ----
  const courseRecord = repos.courses.getPackage(link.courseId);
  if (!courseRecord) {
    return {
      ...base,
      code: "course_package_unreadable",
      message:
        "这段课程材料所属的课程包已不在索引中，因此无法确认它对应哪道真题。",
    };
  }
  const courseIntegrity = readCoursePackageIntegrity(
    {
      id: courseRecord.id,
      packagePath: courseRecord.packagePath,
      manifestChecksum: courseRecord.manifestChecksum,
    },
    cache,
  );
  if (!courseIntegrity.ok) {
    return {
      ...base,
      code: "course_package_unreadable",
      message: "这段课程材料所属的课程包当前读不到，因此无法确认它对应哪道真题。",
    };
  }
  if (!courseIntegrity.checksumMatches) {
    return {
      ...base,
      code: "course_package_drifted",
      message:
        "这段课程材料所属的课程包已在盘上被改动但没有重新导入，" +
        "人工核验过的对应关系因此不再成立。",
    };
  }

  // ---- 真题侧 ----
  const paperRecord = repos.papers.getPaper(link.paperId);
  if (!paperRecord) {
    return {
      ...base,
      code: "paper_package_unreadable",
      message: "被核验指向的真题已不在索引中，因此无法确认它现在是哪一版内容。",
    };
  }
  const paperIntegrity = readPaperPackageIntegrity(
    {
      id: paperRecord.id,
      packagePath: paperRecord.packagePath,
      manifestChecksum: paperRecord.manifestChecksum,
    },
    cache,
  );
  if (!paperIntegrity.ok) {
    return {
      ...base,
      code: "paper_package_unreadable",
      message: "被核验指向的真题包当前读不到，因此无法确认那道题现在是哪一版内容。",
    };
  }
  if (!paperIntegrity.checksumMatches) {
    return {
      ...base,
      code: "paper_package_drifted",
      message:
        "被核验指向的真题包已在盘上被改动但没有重新导入，" +
        "因此无法确认当前这份试卷的内容是否仍然等同。",
    };
  }

  /*
   * 两侧包都读得到、也都没漂移，但链接仍不成立。
   *
   * 剩下的原因只有两类：一侧**内容版本已经升过**，或复核时声明的大题/题组/题目
   * 在当前包里已不存在。两种都意味着"那次人工复核不再覆盖当前内容"。
   *
   * 措辞刻意不细分成两句：区分它们需要复刻 `evaluateLinkRuntimeState` 的内部分支，
   * 而那正好是任务书禁止的"第二个更弱的判据"。用户需要知道的同一件事是：
   * 这条对应关系已经不再成立，需要重新核验。
   */
  return {
    ...base,
    code: "link_not_runtime_usable",
    message:
      `这条课程材料与真题的对应关系已经不再成立` +
      `（课程 v${link.courseContentVersion} → 真题 v${link.paperContentVersion}）。` +
      "内容升版或题目位置变化都会让一次人工复核不再覆盖当前内容 —— " +
      "需要重新核验后才能确认这份试卷是否仍然未被接触。",
  };
}
