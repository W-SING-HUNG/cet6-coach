/**
 * 课程层（Course Layer）的领域词汇。
 *
 * ── 这个文件要守住的那条边界 ──
 *
 * **课程曝光（Course Exposure）≠ 表现证据（Performance Evidence）。**
 *
 * - 表现证据：学习者在 Expert Training 下**独立作答**一道规范真题，
 *   产生 `performance_event` / `assessment_event` / `evidence_projection`。
 * - 课程曝光：学习者**看过/学过**一段课程材料。
 *
 * 后者**永远不得**创建或改写前者的任何一行，也不得产生技能分、掌握度、
 * 弱项或诊断结论。这条不是约定，而是本阶段的服务层与数据库层共同封闭的
 * 事实（见 `content-policy/LEARNING_MODEL.md` 的课程层门禁）。
 *
 * ── provider 中立性 ──
 *
 * 首个真实 provider 是一个商业课程品牌，但本文件里**没有**任何 provider 枚举、
 * 也没有把 provider 名焊进领域标识。`provider` 只是一个被校验的字符串。
 */

// ---------------------------------------------------------------------------
// manifest 的序列化契约版本
// ---------------------------------------------------------------------------

/**
 * 课程 manifest（`course.json`）的**序列化契约版本**。
 *
 * ── 它与 `contentVersion` 回答的是两个完全不同的问题 ──
 *
 * | 字段 | 回答的问题 | 何时递增 |
 * | --- | --- | --- |
 * | `contentVersion` | 这是第几版**语义内容**？ | 课程正文/结构实质变化时 |
 * | `schemaVersion` | 这份 JSON 该按**哪一版契约**解析？ | JSON 形状/字段含义变化时 |
 *
 * 两者**绝不可互相替代**：
 *
 * - 把 `schemaVersion` 当 `contentVersion` 用 ⇒ 一次纯粹的序列化调整
 *   （例如新增一个可选字段、把某字段从字符串改成对象）会被误判成
 *   "课程内容变了"，于是**一批本来完全成立的人工复核链接被无谓地判失效**。
 * - 反过来把 `contentVersion` 当 `schemaVersion` 用 ⇒ 解析器失去
 *   "我能不能读懂这份文件"的判据，遇到未来格式会静默按旧契约解读。
 *
 * 因此：**manifest 升级不得自动使 canonical 链接失效**，
 * 而内容升级必须。
 *
 * 本字段**不参与内容指纹**（见 `content/course/fingerprint.ts`）：
 * 它描述的是文件的序列化形状，不是课程内容本身。
 */
export const COURSE_MANIFEST_SCHEMA_VERSION = 1;

/** 本实现能够解析的 manifest 契约版本集合。 */
export const SUPPORTED_COURSE_MANIFEST_SCHEMA_VERSIONS = [COURSE_MANIFEST_SCHEMA_VERSION] as const;

/**
 * 判定一个 manifest `schemaVersion` 声明是否可用（**唯一实现**）。
 *
 * 刻意分开返回"缺失 / 类型不对 / 太新 / 太旧"，因为对操作者而言
 * 这三种情况的处置完全不同：缺字段 ⇒ 补上；太新 ⇒ 升级应用或降级 manifest。
 * 混成一句"schemaVersion 无效"会让排查变成猜谜。
 */
export function judgeCourseManifestSchemaVersion(
  value: unknown,
): { ok: true; version: number } | { ok: false; message: string } {
  if (value === undefined) {
    return {
      ok: false,
      message:
        `manifest 缺少 schemaVersion（必需字段）。它声明这份 course.json 按哪一版契约解析，` +
        `当前应用支持：${SUPPORTED_COURSE_MANIFEST_SCHEMA_VERSIONS.join(" / ")}。` +
        `它**不是** contentVersion —— 前者是文件格式版本，后者是内容版本。`,
    };
  }

  if (typeof value !== "number" || !Number.isInteger(value)) {
    return {
      ok: false,
      message:
        `schemaVersion 必须是整数，实际为 ${JSON.stringify(value)}。` +
        `当前应用支持：${SUPPORTED_COURSE_MANIFEST_SCHEMA_VERSIONS.join(" / ")}。`,
    };
  }

  if (value > COURSE_MANIFEST_SCHEMA_VERSION) {
    return {
      ok: false,
      message:
        `manifest schemaVersion 为 ${value}，高于本应用支持的 ${COURSE_MANIFEST_SCHEMA_VERSION} —— ` +
        `这份文件由更新的应用写出，按当前契约解析会误读字段。` +
        `请用写出它的新版本应用处理，或把它降级到受支持的版本。`,
    };
  }

  if (value < 1) {
    return {
      ok: false,
      message:
        `manifest schemaVersion 为 ${value}，不是受支持的版本（最小为 1）。` +
        `当前应用支持：${SUPPORTED_COURSE_MANIFEST_SCHEMA_VERSIONS.join(" / ")}。`,
    };
  }

  return { ok: true, version: value };
}

// ---------------------------------------------------------------------------
// 段（segment）种类
// ---------------------------------------------------------------------------

/**
 * 课程段的种类。
 *
 * 只登记**已被当前研究证明存在**的种类，不做穷举式建模。
 * 新增种类的判据是"真实材料里确实出现了它"，而不是"以后可能用得上"。
 */
export const COURSE_SEGMENT_KINDS = [
  /** 阅读：按题型重新归组的历年真题文章。 */
  "reading_passage",
  /** 听力：长对话（题干讲义 + 整段音频 + 文字稿）。 */
  "listening_conversation",
  /** 听力：篇章。 */
  "listening_passage",
  /** 听力：整段录音材料（讲座/报道）。 */
  "listening_recording",
  /** 翻译：中文原文段落 + 课程参考译文 + 语言点。 */
  "translation_passage",
  /** 写作：模板。 */
  "writing_template",
  /** 写作/通用：方法知识、思维导图式说明。 */
  "method_note",
] as const;

export type CourseSegmentKind = (typeof COURSE_SEGMENT_KINDS)[number];

export const COURSE_SEGMENT_KIND_LABELS: Record<CourseSegmentKind, string> = {
  reading_passage: "阅读 · 篇章",
  listening_conversation: "听力 · 长对话",
  listening_passage: "听力 · 篇章",
  listening_recording: "听力 · 录音",
  translation_passage: "翻译 · 段落",
  writing_template: "写作 · 模板",
  method_note: "方法说明",
};

// ---------------------------------------------------------------------------
// 曝光事件
// ---------------------------------------------------------------------------

/**
 * 曝光事件的种类。**它描述"发生了什么"，不描述"为什么"。**
 *
 * 与 `performance_event` 同一条纪律：一旦允许在观测里写解释，
 * 后续所有统计都会把解释当成事实（见 `content-policy/LEARNING_MODEL.md` 第 1 节）。
 * 因此这里没有 "understood" / "struggled" / "needs_review" 这类词。
 *
 * ── 第 5 种：`reveal_requested`（学习者**请求**揭示正文）──
 *
 * 它是**学习者的显式动作**，与 `declared_seen`（自述）不同：
 * `declared_seen` 是学习者对自己历史状态的声明，而 `reveal_requested`
 * 描述的是"我现在要求系统把这段材料的正文发给我"这一次操作。
 *
 * 它同样算"接触过"：请求揭示的人在拿到正文的那一刻就已经看过它了。
 * 系统没有资格把它排除在"见过"之外 —— 那会让 `pristine` 在最可疑的
 * 路径上 fail open（同 `declared_seen` 的理由）。
 */
export const COURSE_EXPOSURE_EVENT_TYPES = [
  /** 学习者看到了内容本身（材料被呈现）。 */
  "content_rendered",
  /** 学习者看到了题目解析 / 答案。 */
  "solution_rendered",
  /** 学习者看到了老师讲解。 */
  "teacher_explanation_seen",
  /** 学习者自行声明"我看过了"。它是声明，**不是**系统观测到的渲染。 */
  "declared_seen",
  /**
   * 学习者**请求揭示**课程正文。
   *
   * 它必须与写入路径绑定：持久化先于正文下发（见 `services/course-exposure.ts`
   * 的 `revealCourseSegment`），否则"请求了但没记下来"会让一次真实接触
   * 在历史里消失。
   */
  "reveal_requested",
] as const;

export type CourseExposureEventType = (typeof COURSE_EXPOSURE_EVENT_TYPES)[number];

export const COURSE_EXPOSURE_EVENT_LABELS: Record<CourseExposureEventType, string> = {
  content_rendered: "内容已呈现",
  solution_rendered: "解析已呈现",
  teacher_explanation_seen: "讲解已看",
  declared_seen: "自行声明已看",
  reveal_requested: "请求揭示正文",
};

/**
 * 曝光事件里**明确不存在**的字段（由 `tests/course-exposure.test.ts` 与
 * `tests/architecture.test.ts` 在 schema 与源码两层守护）。
 *
 * 写在这里是为了让"为什么没有这些列"可被检索，而不是只能靠读 schema 猜。
 */
export const COURSE_EXPOSURE_FORBIDDEN_FIELDS = [
  "correct",
  "incorrect",
  "outcome",
  "score",
  "mastery",
  "weakness",
  "mechanism",
  "diagnosis",
  "cause",
  "error_tag",
  "question_id",
] as const;

// ---------------------------------------------------------------------------
// canonical 链接
// ---------------------------------------------------------------------------

/**
 * 链接的**目标粒度**。
 *
 * 三者互斥，且必须结构成立：
 * - `section`：整个大题（不能同时声明 group/question）
 * - `group`：某个题组（必须声明 section + group，question 必须为 null）
 * - `question`：某一道题（三者都必须声明）
 *
 * 用"一个 scope 字段 + 可空标识"而不是三个独立的可空链接表：
 * 三张表会让"一条 segment 同时链到 section 与 question"变成可表达的状态，
 * 而那是无意义且必然漂移的状态。
 */
export const COURSE_LINK_TARGET_SCOPES = ["section", "group", "question"] as const;
export type CourseLinkTargetScope = (typeof COURSE_LINK_TARGET_SCOPES)[number];

/**
 * 链接的核验状态。
 *
 * **只有 `verified` 能成为运行时链接。** `candidate` / `rejected` 是机器或
 * 人工过程的中间产物，它们可以落库（保留审计线索），但运行时读取路径
 * 一律过滤掉 —— 判据集中在 `isLinkRuntimeUsable` 一处。
 *
 * 为什么允许非 verified 的行落库：把候选/否决**丢掉**会让"这条为什么没被采用"
 * 永久不可回答；而把它们当成链接又会让未核验的猜测进入真相。
 * 两者的正确处置是：存下来，但不让它进入运行时。
 */
export const COURSE_LINK_VERIFICATION_STATUSES = ["verified", "candidate", "rejected"] as const;
export type CourseLinkVerificationStatus = (typeof COURSE_LINK_VERIFICATION_STATUSES)[number];

/**
 * 已验证链接的运行时可用性判据（**唯一实现**）。
 *
 * 失败关闭（fail closed）：下列任一不成立，链接即不可用：
 *
 * 1. 核验状态不是 `verified`；
 * 2. 课程包行不存在（包被删除/从未导入）；
 * 3. **课程内容版本不再匹配** —— 包升版后，被复核的是**旧版**内容，
 *    旧复核结论对不上新版 segment 的边界；
 * 4. **真题内容版本不再匹配** —— 卷子升版后，被复核的那道题可能已经不是
 *    同一道题（`contentVersion` 的定义就是"内容身份"）。
 *
 * ── 为什么第 3、4 条必须失败关闭，而不是"自动跟着升级" ──
 *
 * 链接的价值来自**人工复核过**："这一段的课程材料确实对应那道真题"。
 * 自动升级会把那次复核**静默地**应用到它从未被复核过的新内容上 ——
 * 复核结论被保留，而复核的对象已经换了。这与"历史作答不得被静默指向
 * 另一道题"是同一条原则（见 `PaperVersionConflictError`）。
 *
 * 因此升版后链接状态是 **stale / 不可用**，必须重新核验（重新写入一条
 * 指向新版本的新链接），旧链接原样保留为历史。
 */
export function isLinkRuntimeUsable(input: {
  status: CourseLinkVerificationStatus;
  /** 链接记录的课程内容版本。 */
  courseContentVersion: number;
  /** 链接记录的真题内容版本。 */
  paperContentVersion: number;
  /** 当前课程包索引中的内容版本；包不存在时为 null。 */
  currentCourseContentVersion: number | null;
  /** 当前真题索引中的内容版本；卷子不存在时为 null。 */
  currentPaperContentVersion: number | null;
}): boolean {
  if (input.status !== "verified") return false;
  if (input.currentCourseContentVersion === null) return false;
  if (input.currentPaperContentVersion === null) return false;
  if (input.courseContentVersion !== input.currentCourseContentVersion) return false;
  if (input.paperContentVersion !== input.currentPaperContentVersion) return false;
  return true;
}

/**
 * 链接不可用的**可读原因**（唯一措辞）。
 *
 * 与 `RESERVED_PAPER_REASON` 同样的理由：同一件事在两个地方说两句不同的话，
 * 就是两个真相。措辞必须同时给出"为什么"与"怎么办"。
 */
export function explainLinkUnusable(input: {
  status: CourseLinkVerificationStatus;
  courseContentVersion: number;
  paperContentVersion: number;
  currentCourseContentVersion: number | null;
  currentPaperContentVersion: number | null;
}): string {
  if (input.status === "candidate") {
    return "这条对应关系还是机器候选，未经人工核验，因此不作为运行时链接。";
  }
  if (input.status === "rejected") {
    return "这条对应关系已被人工否决，不作为运行时链接。";
  }
  if (input.currentCourseContentVersion === null) {
    return "课程包已不在索引中（可能未导入或已被移除），无法确认这段材料的当前版本。";
  }
  if (input.courseContentVersion !== input.currentCourseContentVersion) {
    return (
      `课程内容已升版（复核时为 v${input.courseContentVersion}，当前 v${input.currentCourseContentVersion}），` +
      `复核结论不再适用。需要对新版内容重新核验后建立新链接 —— 系统不会自动沿用旧复核。`
    );
  }
  if (input.currentPaperContentVersion === null) {
    return "目标真题不在索引中，无法确认它当前是哪一版内容。";
  }
  if (input.paperContentVersion !== input.currentPaperContentVersion) {
    return (
      `目标真题内容已升版（复核时为 v${input.paperContentVersion}，当前 v${input.currentPaperContentVersion}），` +
      `被复核的那道题可能已经不是同一道题。需要重新核验 —— 系统不会自动把旧复核套到新版本上。`
    );
  }
  return "链接不可用。";
}
