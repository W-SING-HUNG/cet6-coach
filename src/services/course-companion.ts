import type { Repositories } from "@/repositories/ports";
import type { CoursePackageContent, CourseSegment } from "@/content/course/types";
import {
  establishesPotentialContact,
  establishesSeenContent,
} from "@/domain/paper-freshness";
import { computeRevealRisk } from "./reveal-risk";
import type { LinkedPaperSummary } from "./course-link-projection";
import { sanitizeDisplayText } from "@/lib/display-safety";
import {
  createPackageIntegrityCache,
  readCoursePackageIntegrity,
  type PackageIntegrityCache,
} from "./course-packages";

export type { LinkedPaperSummary };

/**
 * 课程伴随界面（Course Companion）的读取服务。
 *
 * ── 它回答的问题 ──
 *
 *   "我的课程里有哪些材料，每一段现在是什么状态、对应哪份真题？"
 *
 * ── 它与 `revealCourseSegment` 的分工（关键）──
 *
 * | | 本模块 | `revealCourseSegment` |
 * | --- | --- | --- |
 * | 正文 | **绝不下发** | 唯一的正文出口 |
 * | 写入 | 无 | 先持久化曝光，后下发正文 |
 * | 需要的动作 | 页面加载（GET） | 学习者点「看这段」并确认 |
 *
 * 因此本模块是**只读**的，且返回的形状里没有任何 `text` / `transcript` /
 * `referenceTranslation` / `notes` 字段。列表页只需要身份、层级与状态；
 * 正文只在学习者显式请求时才经 POST 端点下发。
 *
 * 这条分工由 `tests/architecture.test.ts` 在源码层守护
 * （本文件不得出现正文通道字段名）。
 *
 * ── 快照原则（P0-3）──
 *
 * 本模块与揭示路径**共用同一份**包完整性实现，并且只读一次盘：
 * 校验用它，呈现分组/锚点/链接状态也用它。绝不在校验之后再解析一次
 * `course.json` —— 那两次读取之间盘上文件可能被换掉。
 */

/**
 * 一段课程材料在伴随界面上的行。
 */
export interface CourseSegmentSummary {
  courseId: string;
  segmentId: string;
  courseContentVersion: number;
  kind: string;
  title: string;
  /**
   * 这个段当前有哪些内容通道。
   *
   * 只报**存在性**，不报内容 —— 界面据此显示"这段有参考译文"，
   * 而正文本身仍要学习者显式揭示。
   */
  channels: Array<"text" | "transcript" | "referenceTranslation" | "notes">;
  /**
   * 这位学习者在**当前内容版本**上与这段的接触状态。
   *
   * ── 为什么不是布尔值 ──
   *
   * 用 `alreadyRevealed: boolean` 时，"请求过揭示"与"确实看过"在界面上
   * 是同一句话（「已看过」）。那是不诚实的 —— 请求不证明读过（P0-5）。
   *
   * 现在分三态，与 domain 的新鲜度语义同源：
   *
   * | 状态 | 含义 | 界面措辞 |
   * | --- | --- | --- |
   * | `not_contacted` | 无任何记录 | 不给徽标 |
   * | `potential_contact` | 只请求过揭示 | 「请求过阅读」 |
   * | `confirmed_seen` | 有已确认的看过事件 | 「已看过」 |
   */
  contactState: SegmentContactState;
  /**
   * 这一段在源材料里的页码范围（人话）。
   *
   * `null` 表示包没有登记锚点 —— 此时界面必须如实说"未登记页码"，
   * 而不是编一个范围或干脆不提。
   */
  anchorLabel: string | null;
  /** 已核验且当前可用的 canonical 链接（空数组 = 未匹配，合法状态）。 */
  linkedPapers: LinkedPaperSummary[];
  /**
   * 揭示这段材料前必须确认的风险指纹。
   *
   * 页面渲染时随段下发，学习者确认后由 POST 原样回传；服务端重新计算并
   * 比对，不一致 ⇒ 拒绝揭示（P0-1）。**它不含任何正文**，只是对
   * "当前适用的风险"的确定性摘要。
   */
  riskFingerprint: string;
  /**
   * 界面是否必须走确认步骤（**契约**，不是界面的推断）。
   *
   * 恒为 `true` —— 包括**未匹配**的段。上一版界面自己看
   * `linkedPapers.length` 决定要不要确认，于是未匹配段直接揭示了正文，
   * 与质量门禁矛盾（Round 3 P1）。
   *
   * 由服务端下发而不是让界面推断，原因是"要不要确认"是**风险语义**，
   * 而风险语义的权威在服务端。界面据此渲染，不再自己判断。
   */
  requiresConfirmation: boolean;
}

/** 一段材料的接触状态（三态，与新鲜度语义同源）。 */
export type SegmentContactState = "not_contacted" | "potential_contact" | "confirmed_seen";

/**
 * 一段材料指向的真题目标及其当前状态。
 *
 * 形状定义在 `@/lib/course-reveal-contract`（**唯一实现**）——
 * 那里同时提供运行时校验（zod）与编译期类型，服务端与客户端共用。
 * 本模块只负责生产它（经 `./course-link-projection`）。
 *
 * ── 为什么带上"是否可训练"与"是否模考保留" ──
 *
 * 学习者点开一段课程材料之前，需要知道"它对应那份真题现在处于什么状态"。
 * 若那份卷子被设为模考保留，阅读这段材料就是在**消耗保留材料** ——
 * 这个风险必须在揭示**之前**就明确说出来，而不是等揭示完成后才发现。
 */

/** 一份逻辑材料及其段（保留 manifest 的分组与顺序）。 */
export interface CourseMaterialGroup {
  materialId: string;
  title: string;
  /** 这份材料有哪几种文件形态（PDF / DOCX…），只作说明。 */
  representations: string[];
  segments: CourseSegmentSummary[];
}

/** 一个课程包的伴随视图。 */
export interface CourseCompanionView {
  courseId: string;
  title: string;
  provider: string;
  edition: string | null;
  contentVersion: number;
  /** 该版本包是否仍然可求证（漂移/读不到时为 false）。 */
  packageTrustworthy: boolean;
  /** 不可求证时的可读原因；可求证时为 null。 */
  packageIssue: string | null;
  /** 按材料分组的段（保留 manifest 顺序）。 */
  materials: CourseMaterialGroup[];
  /** 全部段的扁平视图（便于计数与测试）。 */
  segments: CourseSegmentSummary[];
}

/**
 * 读取一个课程包的伴随视图。**只读，绝不下发正文。**
 *
 * 漂移或读不到包时如实报告 `packageTrustworthy: false` 并给出原因，
 * 而不是假装成一个空的课程 —— 那是把"无法求证"说成"没有内容"。
 */
export function getCourseCompanionView(
  repos: Repositories,
  profileId: string,
  courseId: string,
  cache: PackageIntegrityCache = createPackageIntegrityCache(),
): CourseCompanionView | null {
  const record = repos.courses.getPackage(courseId);
  if (!record) return null;

  const integrity = readCoursePackageIntegrity(
    {
      id: record.id,
      packagePath: record.packagePath,
      manifestChecksum: record.manifestChecksum,
    },
    cache,
  );

  const base = {
    courseId: record.id,
    title: record.title,
    provider: record.provider,
    edition: record.edition,
    contentVersion: record.contentVersion,
  };

  if (!integrity.ok) {
    return {
      ...base,
      packageTrustworthy: false,
      /*
       * 在**显示边界**消毒：`integrity.reason` 可能来自低层的 `catch`，
       * 而那些消息常常带磁盘路径（P2-B）。这里统一抹掉，而不是逐个
       * 修改消息来源 —— 新来源会自动被覆盖。
       */
      packageIssue: `读不到这个课程包：${sanitizeDisplayText(integrity.reason)}`,
      materials: [],
      segments: [],
    };
  }
  if (!integrity.checksumMatches) {
    return {
      ...base,
      packageTrustworthy: false,
      packageIssue:
        `这个课程包已在盘上被改动但没有重新导入（manifest 校验和与索引不一致）。` +
        `请先重新导入（pnpm course:import --commit）并确认内容版本，再阅读它的内容。`,
      materials: [],
      segments: [],
    };
  }

  /*
   * 直接复用完整性读取里**同一份**已校验解析结果（P0-3 的快照原则）。
   *
   * 上一版在这里又解析了一次 `course.json` —— 与上面的校验是两次读取，
   * 中间盘上文件可能被换掉。现在两者共用 `integrity.content`。
   */
  const content = integrity.content;

  /*
   * 接触状态：**一次查询**取回，而不是逐段查询。
   *
   * 判据刻意带上内容版本 —— 升版后旧版本的接触不算是新版本的接触。
   * 状态按 domain 的登记表推导（`establishesSeenContent` /
   * `establishesPotentialContact`），不在这里重写一遍判据 ——
   * 两处各写一份必然漂移。
   */
  const relevant = repos.courses
    .listAllExposureForProfile(profileId)
    .filter(
      (event) => event.courseId === courseId && event.courseContentVersion === content.contentVersion,
    );

  const confirmedBySegment = new Set(
    relevant
      .filter((event) => establishesSeenContent(event.eventType))
      .map((event) => event.segmentId),
  );
  const potentialBySegment = new Set(
    relevant
      .filter(
        (event) =>
          !establishesSeenContent(event.eventType) &&
          establishesPotentialContact(event.eventType),
      )
      .map((event) => event.segmentId),
  );

  const segments = content.segments
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((segment) =>
      toSegmentSummary(
        segment,
        content,
        record.id,
        contactStateOf(segment.id, confirmedBySegment, potentialBySegment),
        repos,
        cache,
      ),
    );

  return {
    ...base,
    packageTrustworthy: true,
    packageIssue: null,
    materials: groupByMaterial(content, segments),
    segments,
  };
}

/** 一位学习者可见的全部课程包（伴随界面的入口列表）。 */
export function listCourseCompanionViews(
  repos: Repositories,
  profileId: string,
): CourseCompanionView[] {
  const cache = createPackageIntegrityCache();
  return repos.courses
    .listPackages()
    .map((record) => getCourseCompanionView(repos, profileId, record.id, cache))
    .filter((view): view is CourseCompanionView => view !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

function toSegmentSummary(
  segment: CourseSegment,
  content: CoursePackageContent,
  courseId: string,
  contactState: SegmentContactState,
  repos: Repositories,
  cache: PackageIntegrityCache,
): CourseSegmentSummary {
  /*
   * 风险计算**只做一次**，然后同时取指纹、链接与确认契约。
   *
   * 分开调用会读两次盘，而且给了"指纹来自一次计算、链接来自另一次"
   * 的空间 —— 那正是"界面展示的与确认的不是同一份事实"的成因。
   * `computeRevealRisk` 内部用同一个 `cache`，因此这里是一次读盘。
   */
  const risk = computeRevealRisk(repos, courseId, segment.id, cache);

  return {
    courseId,
    segmentId: segment.id,
    courseContentVersion: content.contentVersion,
    kind: segment.kind,
    title: segment.title,
    channels: channelsOf(segment),
    contactState,
    anchorLabel: describeAnchor(segment),
    linkedPapers: risk.papers,
    riskFingerprint: risk.fingerprint,
    /*
     * 确认契约由服务端下发（**恒为 true**）。
     *
     * 界面不得自己推断"有没有风险" —— 那正是 Round 3 P1 的缺陷形态：
     * 未匹配段被界面判为"无需确认"，于是直接揭示。
     */
    requiresConfirmation: risk.requiresConfirmation,
  };
}

/**
 * 把一段的来源锚点说成人话。
 *
 * 没有页码锚点时返回 `null`（而不是 `"未登记"` 之类的占位串）——
 * 调用方要能区分"没有锚点"与"有一个空标签"。
 */
function describeAnchor(segment: CourseSegment): string | null {
  const { pageStart, pageEnd, quote } = segment.anchor;
  if (pageStart === null || pageStart === undefined) {
    return quote ? "源文引证定位" : null;
  }
  if (pageEnd === null || pageEnd === undefined || pageEnd === pageStart) {
    return `第 ${pageStart} 页`;
  }
  return `第 ${pageStart}–${pageEnd} 页`;
}

/**
 * 链接目标的**学习者可见**描述。
 *
 * 与 `describeLinkTarget`（CLI / 测试用）的区别是措辞：这里说
 * 「阅读 · 仔细阅读（第 2 组）」而不是 `reading.careful_reading / g2`。
 *
 * 未登记的大题类型回退到 id —— 那总比编一个看起来像人话的标签诚实：
 * 学习者能看出这是个未知类型，而不是被一个猜测的标签误导。
 */

/** 按 manifest 的材料分组，保留段在包内的声明顺序。 */
function groupByMaterial(
  content: CoursePackageContent,
  segments: CourseSegmentSummary[],
): CourseMaterialGroup[] {
  const bySegmentId = new Map(segments.map((segment) => [segment.segmentId, segment]));

  /*
   * 分组的键顺序必须确定：按 manifest 里材料的声明顺序走，
   * 于是界面呈现的顺序与包一致，不依赖查询返回顺序。
   */
  const groups: CourseMaterialGroup[] = content.materials.map((material) => ({
    materialId: material.id,
    title: material.title,
    representations: material.representations.map((representation) => representation.label),
    segments: [],
  }));

  for (const segment of content.segments.slice().sort((a, b) => a.order - b.order)) {
    const summary = bySegmentId.get(segment.id);
    if (!summary) continue;

    const group = groups.find((item) => item.materialId === segment.materialId);
    if (group) {
      group.segments.push(summary);
      continue;
    }

    /*
     * 段引用了一个不存在的材料 —— 规范化包校验器会拒绝这种包，
     * 因此这里理论上不可达。保持防御性：归入一个明确的"未分组"桶，
     * 而不是静默丢弃（丢弃会让一段材料在界面上消失）。
     */
    groups.push({
      materialId: `__unassigned_${segment.materialId}`,
      title: "未归组的材料",
      representations: [],
      segments: [summary],
    });
  }

  // 没有段的材料不显示（空分组只是噪声）。
  return groups.filter((group) => group.segments.length > 0);
}

/** 这段有哪些内容通道（只报存在性）。 */
function channelsOf(segment: CourseSegment): Array<"text" | "transcript" | "referenceTranslation" | "notes"> {
  const channels: Array<"text" | "transcript" | "referenceTranslation" | "notes"> = [];
  if (segment.text !== null && segment.text !== "") channels.push("text");
  if (segment.transcript !== null && segment.transcript !== "") channels.push("transcript");
  if (segment.referenceTranslation !== null && segment.referenceTranslation !== "") {
    channels.push("referenceTranslation");
  }
  if (segment.notes !== null && segment.notes !== "") channels.push("notes");
  return channels;
}

/** 由两类集合推导一段的接触状态（已确认压过潜在）。 */
function contactStateOf(
  segmentId: string,
  confirmed: Set<string>,
  potential: Set<string>,
): SegmentContactState {
  if (confirmed.has(segmentId)) return "confirmed_seen";
  if (potential.has(segmentId)) return "potential_contact";
  return "not_contacted";
}
