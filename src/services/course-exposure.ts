import type { Repositories } from "@/repositories/ports";
import type { CourseExposureEvent } from "@/domain/models";
import type { CoursePackageContent, CourseSegment } from "@/content/course/types";
import type { CoursePackageRecord } from "@/repositories/ports";
import {
  COURSE_EXPOSURE_EVENT_TYPES,
  type CourseExposureEventType,
} from "@/domain/course";
import {
  createPackageIntegrityCache,
  readCoursePackageIntegrity,
  type CoursePackageIntegrity,
  type PackageIntegrityCache,
} from "./course-packages";
import { listRuntimeLinksForSegment } from "./course-link";
import {
  computeRevealRisk,
  explainRiskChange,
  riskFingerprintMatches,
  type RevealRiskDescriptor,
} from "./reveal-risk";
import { nowISO } from "@/lib/date";

/**
 * 课程曝光服务。
 *
 * ── 这个模块存在的全部理由：把一条边界变成代码 ──
 *
 *   **课程曝光（看过材料）≠ 表现证据（独立作答真题）。**
 *
 * 本模块**只**写 `course_exposure_event`。它不调用、不导入、也无法访问
 * Expert 台账与旧闭环的任何写入路径：
 *
 * - 不写 `performance_event` / `assessment_event` / `evidence_projection`；
 * - 不写 `skill_profile` / `Weakness` / `answer_attempt` / `review_item`；
 * - 不产生技能分、掌握度、弱项或任何诊断结论。
 *
 * 这条约束由三重机制守住（不是靠注释）：
 * 1. 本文件**不 import** `expert` repository，也没有对应的方法可调；
 * 2. `tests/architecture.test.ts` 在源码层断言本文件不出现那些写入符号；
 * 3. 曝光表里根本没有 outcome / score / mastery 等字段可写。
 *
 * ── 统一的曝光写入边界（本模块唯一允许的写入入口）──
 *
 * 全部曝光事件 —— 包括 Course Companion 的正文揭示 —— 都必须经过
 * `recordCourseExposure` 这一个服务边界。**禁止**让调用方直接调用
 * 仓储的 `appendExposure` 绕过下面的判定：
 *
 * | 判定 | 为什么必须在服务层 |
 * | --- | --- |
 * | 事件种类已登记 | 仓储层只做白名单，不解释"为什么这一类可以写" |
 * | 课程包在索引中 | 库不是可信来源（与 catalog 同一条理由） |
 * | 内容版本精确等于当前 | 曝光必须记录**当时实际看到**的那一版 |
 * | **manifest 校验和未漂移** | 版本号不变而盘上内容被换掉 ⇒ 曝光会指向一份没人见过的材料 |
 * | 段存在于该版本包中 | repository 层看不到正文 |
 * | 揭示事件幂等 | 同一个揭示动作重复提交不得产生第二条观测 |
 *
 * 这样"绕过边界"在结构上不可能 —— 那条裸仓储方法上没有这些判定，
 * 而 UI 与脚本一律走服务层（由 `tests/architecture.test.ts` 守护：
 * 非服务层不得出现 `appendExposure`）。
 *
 * ── 本阶段刻意**不做**的事（记录在案，防止被当成遗漏）──
 *
 * 用课程曝光去判定"某份真题已不再未触碰"、进而影响 planner / mock_reserve /
 * untouched 选择 —— 那是**后续阶段**的工作。本阶段只把信息**完整保存下来**，
 * 因为那份信息一旦丢失就无法补回：一段今天在"未匹配"状态下被学过的材料，
 * 两周后人工核验出它对应哪道题时，历史曝光必须还能被投影到那道题上。
 * 这正是曝光事件**不把 canonical 目标写进主身份**的原因。
 */

export interface RecordExposureInput {
  profileId: string;
  courseId: string;
  segmentId: string;
  /**
   * 学习者**当时实际看到的那一版**课程内容。
   *
   * 显式传入而不是由服务层从当前索引读取：曝光是**已发生的事实**，
   * 它记录的是当时那一版。若隐式取"当前版本"，一条补录的历史曝光
   * 会被写成今天的版本 —— 那就是在伪造观测。
   */
  courseContentVersion: number;
  eventType: CourseExposureEventType;
  /** 事件发生时刻。缺省为现在。 */
  occurredAt?: string;
}

export type RecordExposureResult =
  | { ok: true; event: CourseExposureEvent }
  | { ok: false; issues: Array<{ path: string; message: string }> };

/** 一次请求内共享的包读取缓存。**不跨调用**（磁盘漂移必须立即可见）。 */
export type ExposureCache = PackageIntegrityCache;

export function createExposureCache(): ExposureCache {
  return createPackageIntegrityCache();
}

/**
 * 记录一次课程曝光。**只追加**，不存在的段/包一律拒绝（失败关闭）。
 *
 * 为什么仍要校验"段存在"：曝光指向一个不存在的段会让历史无法回看，
 * 也无法在后续阶段被投影。校验用的是**该版本的规范化包**，
 * 因此它同时保证"当时看到的确实是这个段"。
 *
 * 注意：这里**不要求**该段有 canonical 链接 —— 未匹配是合法状态，
 * 而且恰恰是最需要被如实记录的状态（见上）。
 *
 * ── 为什么额外校验 manifest 校验和 ──
 *
 * 只比"内容版本相等"是不够的：盘上的 `course.json` 可以在**不升版本**的
 * 情况下被直接替换。此时版本比对全部通过，而曝光指向的是一份
 * 与索引登记时完全不同的材料 —— 那条曝光就成了假的"当时看到的内容"。
 * 因此这里与 `verifyCanonicalLink` 消费**同一份**包完整性实现，
 * 漂移即失败关闭（`course_package_drifted`）。
 */
export function recordCourseExposure(
  repos: Repositories,
  input: RecordExposureInput,
  cache: ExposureCache = createExposureCache(),
): RecordExposureResult {
  if (!COURSE_EXPOSURE_EVENT_TYPES.includes(input.eventType)) {
    return {
      ok: false,
      issues: [
        {
          path: "eventType",
          message: `未登记的曝光事件种类：${input.eventType}（允许 ${COURSE_EXPOSURE_EVENT_TYPES.join(" / ")}）`,
        },
      ],
    };
  }

  // 课程包存在，且请求的版本就是索引中的当前版本。
  //
  // 为什么这里要求"当前版本"（与链接校验同一口径）：曝光记录的是
  // **正在发生**的渲染/学习行为，它必然发生在当前内容上。
  // 补录历史需要显式走迁移，而不是让本接口接受任意版本 ——
  // 后者会让"当时看到的到底是哪一版"变得不可核。
  const validation = validateExposure(repos, input, cache);
  if (!validation.ok) return { ok: false, issues: validation.issues };

  const event = repos.courses.appendExposure({
    profileId: input.profileId,
    courseId: input.courseId,
    segmentId: input.segmentId,
    courseContentVersion: input.courseContentVersion,
    eventType: input.eventType,
    occurredAt: input.occurredAt ?? nowISO(),
  });

  return { ok: true, event };
}

/**
 * 一次曝光写入前的**全部判定**（不含写入）。
 *
 * ── 为什么把它抽出来，而不是让揭示路径自己调 `recordCourseExposure` ──
 *
 * 揭示路径需要"先校验、再决定要不要写"（幂等命中时不写）。
 * 若它直接调用 `recordCourseExposure`，就会先写一条再判断要不要留着 ——
 * 而曝光表**只追加**，写下去就撤不回来。
 *
 * 因此判定与写入必须分开，但**不能分成两个公开 API**：那会多出一个
 * 可以单独调用、从而与服务边界漂移的入口。所以它是本文件的私有函数，
 * 唯一职责是让"写之前先校验"这件事只有一份实现。
 *
 * 揭示路径与普通曝光路径共用它 —— 这就是"统一写入边界"的实体：
 * 两条路径的判定逐字节相同。
 */
function validateExposure(
  repos: Repositories,
  input: RecordExposureInput,
  cache: ExposureCache,
): { ok: true } | { ok: false; issues: Array<{ path: string; message: string }> } {
  if (!COURSE_EXPOSURE_EVENT_TYPES.includes(input.eventType)) {
    return {
      ok: false,
      issues: [
        {
          path: "eventType",
          message: `未登记的曝光事件种类：${input.eventType}（允许 ${COURSE_EXPOSURE_EVENT_TYPES.join(" / ")}）`,
        },
      ],
    };
  }

  const record = repos.courses.getPackage(input.courseId);
  if (!record) {
    return {
      ok: false,
      issues: [{ path: "courseId", message: `课程包 ${input.courseId} 不在索引中，无法记录曝光。` }],
    };
  }
  if (record.contentVersion !== input.courseContentVersion) {
    return {
      ok: false,
      issues: [
        {
          path: "courseContentVersion",
          message:
            `课程内容版本不匹配：请求 v${input.courseContentVersion}，` +
            `索引中为 v${record.contentVersion}。曝光必须记录学习者**当时实际看到**的那一版。`,
        },
      ],
    };
  }

  // 包完整性：索引登记的 manifest 校验和必须与磁盘现值一致。
  //
  // 与 `verifyCanonicalLink` 共用同一个实现与同一套失败关闭语义：
  // 版本号不变而包被换掉，是这条路径上唯一能让"当时看到的确实是这个段"
  // 说谎的方式。
  const integrity = readCoursePackageIntegrity(
    {
      id: record.id,
      packagePath: record.packagePath,
      manifestChecksum: record.manifestChecksum,
    },
    cache,
  );
  if (!integrity.ok) {
    return {
      ok: false,
      issues: [
        {
          path: "courseId",
          message:
            `无法读取课程包 ${input.courseId} 以确认段身份：${integrity.reason}` +
            `（曝光必须指向一个**当前仍然可求证**的段）。`,
        },
      ],
    };
  }
  if (!integrity.checksumMatches) {
    /*
     * 措辞与揭示路径一致（P2-B）：**不给校验和片段**。
     * 校验和判定本身完全保留，只是不把私有内容身份的指纹拼进消息。
     *
     * 这条路径当前没有 UI 调用方（`recordCourseExposure` 只被测试用），
     * 但措辞与揭示路径保持一致 —— 否则将来接上 UI 时会漏掉这一层。
     */
    return {
      ok: false,
      issues: [
        {
          path: "courseId",
          message:
            `课程包 ${input.courseId} 已在盘上被改动但没有重新导入` +
            `（内容与索引登记的那一份不一致）。拒绝记录曝光 —— ` +
            `否则这条曝光会指向一份与索引登记时不同的材料。` +
            `请先重新导入课程包（pnpm course:import --commit）并确认内容版本。`,
        },
      ],
    };
  }

  // 段必须存在于该版本的规范化包中。repository 层看不到正文，因此这层检查在此。
  if (!integrity.segmentIds.has(input.segmentId)) {
    return {
      ok: false,
      issues: [
        {
          path: "segmentId",
          message: `课程段 ${input.segmentId} 不存在于课程包 ${input.courseId} v${input.courseContentVersion} 中。`,
        },
      ],
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// 正文揭示（reveal）：先持久化，后返回正文
// ---------------------------------------------------------------------------

/**
 * 揭示一次课程正文的结果。
 *
 * `content` **只在 `ok: true` 时非空** —— 这正是"先持久化、后下发"的
 * 结构保证：任何一个判定不通过，调用方拿到的就只有可读原因，
 * 而没有任何正文字节离开服务层。
 */
export type RevealSegmentResult =
  | {
      ok: true;
      event: CourseExposureEvent;
      /** 该段当前版本的正文（只来自已校验的规范化包）。 */
      content: CourseSegmentContent;
      /**
       * 本次调用是否真的新增了一条曝光。
       * `false` = 同一个揭示动作此前已被记录（幂等命中）——
       * 此时仍然返回正文（学习者需要看到它），但不重复写观测。
       */
      recorded: boolean;
      /**
       * 本次下发正文所对应的 `course.json` 校验和。
       *
       * 它让"这份正文来自被校验的那一版"成为**可核对**的事实：
       * 服务层调用方（测试、CLI）能证明下发的正文与索引登记的是同一份，
       * 而不是漂移后的另一份。
       *
       * ── 它**不**出现在 HTTP 响应体里（P2-A）──
       *
       * 这是私有内容的**身份**信息。客户端不需要它做任何决定，
       * 因此端点刻意不下发它（见 `route.ts` 的说明）。上一轮的服务层
       * 注释声称响应包含它，那与实现不一致 —— 现已对齐。
       */
      contentChecksum: string;
      /** 索引登记的内容版本（判定时已与请求版本精确比对）。同上，不下发。 */
      indexedContentVersion: number;
      /** 本次下发所依据的风险描述符（UI 可据此核对一致性）。 */
      risk: RevealRiskDescriptor;
    }
  | {
      /**
       * 风险状态变了 ⇒ 拒绝揭示，且**不写任何曝光**。
       *
       * `error` 只给原因；`risk` 是**更新后的**风险视图，UI 据此重新渲染
       * 确认面板并要求学习者重新确认。
       */
      ok: false;
      error: string;
      code: "risk_changed";
      risk: RevealRiskDescriptor;
    }
  | { ok: false; error: string; code?: undefined };

/**
 * 一段课程正文的可读投影。
 *
 * ── 为什么只取这几个字段 ──
 *
 * 这是唯一会把私有课程正文送出服务层的形状，因此它刻意最小化：
 * 身份（course/segment/version）+ 段种类 + 四个内容通道。
 * 没有资产、没有锚点、没有 manifest 里的其它字段 —— 那些与"学习者
 * 要读这段材料"无关，多给一个就是多一个泄漏面。
 */
export interface CourseSegmentContent {
  courseId: string;
  segmentId: string;
  courseContentVersion: number;
  kind: string;
  title: string;
  /** 主体文本：阅读篇章 / 翻译原文 / 写作模板正文 / 方法说明。 */
  text: string | null;
  /** 听力文字稿。 */
  transcript: string | null;
  /** 课程参考译文（翻译类）。 */
  referenceTranslation: string | null;
  /** 课程讲解 / 语言点 / 方法注解。 */
  notes: string | null;
}

/**
 * 揭示一段课程正文，并**先**把 `reveal_requested` 曝光落库。
 *
 * ── 三条不变式（每条都有测试与变异守护）──
 *
 * 1. **一个已验证快照。** 包只读**一次**，校验与下发共用同一份解析结果。
 *    绝不在曝光落库之后再读一次 `course.json` —— 那两次读取之间盘上的
 *    文件可以被换掉，"校验过的内容"与"下发的内容"就不是同一份。
 * 2. **先持久化、后返回正文。** 任何判定不过，返回里没有任何正文字节。
 * 3. **原子幂等。** 同一个揭示动作（同 profile / course / 内容版本 / 段）
 *    只留一条观测，由数据库的确定性身份 + `ON CONFLICT DO NOTHING` 保证，
 *    而不是"先查再插"的应用层竞态。
 *
 * ── 幂等命中**不跳过**校验 ──
 *
 * "此前记录过"只说明这个动作发生过，**不能**证明此刻包仍然完好。
 * 因此每次调用都重新做全部判定；判定不过时即使已有记录也失败关闭。
 *
 * ── 服务端重新确认风险（P0-1）──
 *
 * UI 的确认面板**不是**安全边界。学习者确认的是"页面渲染时他看到的那段
 * 警告"，而页面 GET 与揭示 POST 之间风险可能已经变了（新建链接、池归属
 * 调整、课程包漂移）。因此揭示前必须在服务端重新算一次风险，并把它与
 * 确认过的指纹比对；不一致 ⇒ 拒绝，且**不写任何曝光**。
 */
export function revealCourseSegment(
  repos: Repositories,
  input: {
    profileId: string;
    courseId: string;
    segmentId: string;
    courseContentVersion: number;
    occurredAt?: string;
    /**
     * 学习者**确认过的**风险指纹（页面渲染时给出）。
     *
     * 省略等同于"没有确认过" ⇒ 一律拒绝。刻意不提供"无风险可免确认"的
     * 旁路：那会让"先渲染、后建链接"这条路径在没有任何警告的情况下
     * 消耗保留材料。
     */
    confirmedRiskFingerprint?: string;
  },
  cache: ExposureCache = createExposureCache(),
): RevealSegmentResult {
  /*
   * ① 读一次包，拿到**本次请求内唯一**的已验证快照。
   *
   * 后面的段身份判定与正文投影都用它，不再碰盘。
   * 漂移 / 读不到 ⇒ 失败关闭，且不写任何观测。
   */
  const snapshot = readVerifiedSnapshot(repos, input.courseId, input.courseContentVersion, cache);
  if (!snapshot.ok) {
    return { ok: false, error: snapshot.error };
  }
  const { record, integrity } = snapshot;

  // ② 段必须存在于这个已校验的快照里。
  const segment = integrity.content.segments.find((item) => item.id === input.segmentId);
  if (!segment) {
    return {
      ok: false,
      error:
        `课程段 ${input.segmentId} 不存在于课程包 ${input.courseId} ` +
        `v${input.courseContentVersion} 中。`,
    };
  }

  /*
   * ③ 在**写入曝光之前**重新评估风险，并比对学习者确认过的指纹。
   *
   * 顺序是硬约束：风险判定必须发生在任何副作用之前。若放在落库之后，
   * 一次被拒绝的揭示仍然留下了曝光记录 —— 而那个记录会让对应真题
   * 失去严格未见资格，正是本设计要避免的事。
   *
   * 风险计算与包快照共用同一个 `cache`：课程包仍然只读一次（P0-3）。
   */
  const risk = computeRevealRisk(repos, input.courseId, input.segmentId, cache);
  if (!riskFingerprintMatches(risk.fingerprint, input.confirmedRiskFingerprint)) {
    return {
      ok: false,
      error: explainRiskChange(),
      code: "risk_changed",
      risk,
    };
  }

  /*
   * ④ 原子幂等地落库。
   *
   * 走到这里说明：包可读、校验和匹配、版本匹配、段存在、风险已确认。
   * 写入用确定性身份 + `ON CONFLICT DO NOTHING`，因此并发/重试都只会
   * 留下一条行，且**不会覆盖**首次揭示的 `occurredAt`。
   */
  const { event, created } = repos.courses.appendRevealExposureOnce({
    profileId: input.profileId,
    courseId: input.courseId,
    courseContentVersion: input.courseContentVersion,
    segmentId: input.segmentId,
    occurredAt: input.occurredAt ?? nowISO(),
  });

  /*
   * ⑤ 用**同一个快照**投影正文。
   *
   * 刻意不再调 `readSegmentContent`：那会重新解析 `course.json`，
   * 于是校验与下发之间出现第二次读取（评审 P0-3 指出的缺陷）。
   */
  return {
    ok: true,
    event,
    recorded: created,
    content: toSegmentContent(integrity.content, segment),
    /** 本次下发的正文所对应的索引校验和（可追溯：它证明这份正文来自被校验的那一版）。 */
    contentChecksum: integrity.actualChecksum,
    /** 索引登记的内容版本（与 `input.courseContentVersion` 相等，判定时已比对）。 */
    indexedContentVersion: record.contentVersion,
    /** 本次下发所依据的风险描述符（UI 可据此核对一致性）。 */
    risk,
  };
}

/**
 * 读取一个课程包的**已验证快照**（一次读盘，校验 + 解析同源）。
 *
 * 它做全部与包相关的判定：包在索引中 / 内容版本精确匹配 / 可读 /
 * manifest 校验和未漂移。任何一项不过即失败关闭。
 */
function readVerifiedSnapshot(
  repos: Repositories,
  courseId: string,
  requestedContentVersion: number,
  cache: ExposureCache,
):
  | { ok: true; record: CoursePackageRecord; integrity: CoursePackageIntegrity }
  | { ok: false; error: string } {
  const record = repos.courses.getPackage(courseId);
  if (!record) {
    return { ok: false, error: `课程包 ${courseId} 不在索引中。` };
  }
  if (record.contentVersion !== requestedContentVersion) {
    return {
      ok: false,
      error:
        `课程内容版本不匹配：请求 v${requestedContentVersion}，索引中为 v${record.contentVersion}。` +
        `揭示必须指向学习者**当时实际看到**的那一版。`,
    };
  }

  const integrity = readCoursePackageIntegrity(
    {
      id: record.id,
      packagePath: record.packagePath,
      manifestChecksum: record.manifestChecksum,
    },
    cache,
  );
  if (!integrity.ok) {
    return { ok: false, error: `无法读取课程包 ${courseId} 以确认段身份：${integrity.reason}` };
  }
  if (!integrity.checksumMatches) {
    /*
     * ── 措辞纪律（P2-B）：不给学习者看校验和片段 ──
     *
     * 上一版把 `索引 … / 磁盘 …` 两段截断的 manifest 校验和拼进了
     * 这条**会出现在浏览器里**的错误消息。
     *
     * 校验和比对本身完全保留在服务层（那是漂移判据，一点没动），
     * 但**学习者不需要看到它**：它既不可行动（没人能凭一段十六进制
     * 判断该怎么做），又是私有内容身份的指纹片段。
     *
     * 保留的是可行动的部分：发生了什么、为什么不给正文、该怎么办。
     */
    return {
      ok: false,
      error:
        `课程包 ${courseId} 已在盘上被改动但没有重新导入` +
        `（内容与索引登记的那一份不一致）。拒绝下发正文 —— ` +
        `否则它可能是一份索引从未登记的材料。` +
        `请先重新导入课程包（pnpm course:import --commit）并确认内容版本。`,
    };
  }

  return { ok: true, record, integrity };
}

/** 把一段投影成最小可读形状（**不含**资产、锚点与 manifest 其它字段）。 */
function toSegmentContent(
  course: CoursePackageContent,
  segment: CourseSegment,
): CourseSegmentContent {
  return {
    courseId: course.id,
    segmentId: segment.id,
    courseContentVersion: course.contentVersion,
    kind: segment.kind,
    title: segment.title,
    text: segment.text,
    transcript: segment.transcript,
    referenceTranslation: segment.referenceTranslation,
    notes: segment.notes,
  };
}

/**
 * 读取某一段的曝光历史（跨内容版本）。
 *
 * 同时给出该段**当前的**可用 canonical 链接 —— 这是后续阶段"把未匹配的
 * 历史曝光投影到后核验出的真题上"所需的两半信息。本阶段只把它们读出来，
 * **不做投影**，也不影响 planner / untouched / mock_reserve。
 */
export interface SegmentExposureHistory {
  courseId: string;
  segmentId: string;
  exposures: CourseExposureEvent[];
  /** 当前可用的 verified 链接（可能为空 —— 未匹配是合法状态）。 */
  runtimeLinkTargets: Array<{ paperId: string; sectionId: string; scope: string }>;
}

export function getSegmentExposureHistory(
  repos: Repositories,
  profileId: string,
  courseId: string,
  segmentId: string,
): SegmentExposureHistory {
  return {
    courseId,
    segmentId,
    exposures: repos.courses.listExposureForSegment(profileId, courseId, segmentId),
    runtimeLinkTargets: listRuntimeLinksForSegment(repos, courseId, segmentId).map((link) => ({
      paperId: link.paperId,
      sectionId: link.sectionId,
      scope: link.targetScope,
    })),
  };
}

/**
 * 曝光总量（只读聚合）。**刻意不含任何"掌握度"派生量。**
 *
 * 若这里返回"课程学习进度百分比"之类的东西，它立刻会被下游当成学习证据。
 * 只返回计数：这是事实，不是结论。
 */
export function countCourseExposure(repos: Repositories, profileId: string): number {
  return repos.courses.countExposure(profileId);
}
