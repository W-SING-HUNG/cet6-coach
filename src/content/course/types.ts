/**
 * 课程包（normalized course package）的规范模型。
 *
 * ── 与真题试卷包的关系（必须先读）──
 *
 * 课程层**不是第二个题库**。CET-6 的规范真相完全留在既有的
 * `exam_paper` + Expert Training 台账里。
 * 课程层只做一件事：把**私人课程材料**规范化、索引、并允许人工核验过的
 * 片段**指向**规范真题位置。方向永远是单向的：
 *
 *   课程材料 → （可选的、人工核验的）canonical 链接 → 真题 section/group/question
 *
 * 反向不成立：课程材料**不得**成为题目、答案或学习者能力证据的来源。
 *
 * ── 与试卷包一致的三条架构约束 ──
 *
 * 1. **正文不落库。** 课程正文（讲义文本、PDF/DOCX、MP3）以 private-content
 *    下的规范化包为规范来源；SQLite 只存索引、版本、校验和与可引用标识。
 * 2. **付费内容不进 Git。** 包放在 `private-content/courses/<course-id>/`，
 *    该目录整体被 `.gitignore` 覆盖（由架构门禁固定）。
 * 3. **provider 不写进通用名字。** `provider` 是一个被校验的普通字符串
 *    （例如 "rsvp"），**没有** provider 枚举、也没有
 *    `rsvpSegment` 这类把首个 provider 焊进领域/存储命名的东西。
 *    换成第二个 provider 时，只应新增一个包目录。
 *
 * ── 段（segment）与出现（occurrence）──
 *
 * `CourseSegment` 同时表达"一段课程内容"与"它在材料中的一次出现"：
 * 同一份讲义里，一篇阅读文章常在练习区与解析区各出现一次 —— 那是两条
 * segment，各有自己的 id 与锚点。刻意**不**再拆出一张 occurrence 表：
 * 当前研究没有出现"同一 occurrence 需要独立身份/独立链接"的证据。
 */

import type { CourseSegmentKind } from "@/domain/course";

// ---------------------------------------------------------------------------
// 资产
// ---------------------------------------------------------------------------

/**
 * 课程资产的种类。
 *
 * 与试卷资产的 `audio` / `image` 相比多了 `document`：课程材料的主力形态是
 * PDF/DOCX 讲义，而试卷包的正文是**印出内容的结构化副本**。
 * 这个差异是真实的，因此两边的资产模型各自成立，不强行合并。
 */
export const COURSE_ASSET_KINDS = ["document", "audio", "image"] as const;
export type CourseAssetKind = (typeof COURSE_ASSET_KINDS)[number];

/**
 * 允许的扩展名 → MIME。
 *
 * 与试卷包同样的规则：**不信任 manifest 声明的 MIME**，以扩展名映射为准，
 * 声明不符即拒绝。理由相同 —— manifest 是外部数据。
 */
export const COURSE_ASSET_MIME_BY_EXTENSION: Record<string, string> = {
  // 文档：课程材料的主要形态
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
  ".md": "text/markdown",
  ".txt": "text/plain",
  // 音频：整段材料，**不做物理切分**
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  // 图片
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};

export interface CourseAsset {
  id: string;
  kind: CourseAssetKind;
  /** 相对于课程包根目录的路径，例如 `assets/handout.pdf`。永远是 POSIX 风格。 */
  relativePath: string;
  mimeType: string;
  /** 磁盘实际字节数。校验时与真实值比对，不一致则拒绝。 */
  bytes: number;
  /** 内容 sha256（十六进制小写）。用于检测"同一路径换了内容"。 */
  checksum: string;
  label: string | null;
}

// ---------------------------------------------------------------------------
// 材料与表示（representations）
// ---------------------------------------------------------------------------

/**
 * 一份逻辑材料的一种**表示**（一个具体文件）。
 *
 * ── 为什么必须有这一层 ──
 *
 * 一份「2026 下半年六级阅读讲义」可能同时存在 PDF 与 DOCX 两个文件。
 * 若把"文件"当作"材料"，同一份讲义就会变成两条重复的课程材料 ——
 * 于是同一段课程内容会在界面上出现两次、被学习者看见两次、被统计两次。
 * 表示层把这件事在**模型层面**消除：文件是表示，材料是逻辑内容。
 * 由 `tests/course-validation.test.ts` 固定这条语义。
 */
export interface CourseRepresentation {
  id: string;
  /** 指向本包 `assets[]` 中的一项。 */
  assetId: string;
  /** 供人阅读的形态说明，例如 "PDF 版" / "DOCX 版"。 */
  label: string;
}

export interface CourseMaterial {
  id: string;
  title: string;
  /** 至少一项。一项表示 = 只有一个文件，这是常态。 */
  representations: CourseRepresentation[];
}

// ---------------------------------------------------------------------------
// 段（segment）
// ---------------------------------------------------------------------------

/**
 * 来源锚点：这一段的出处。
 *
 * `pageStart` / `pageEnd` 只在所选表示的页码体系里成立 —— 因此两者同时出现时
 * 必须声明 `representationId`（PDF 有页码，DOCX 没有）。
 * `quote` 是"稳定文本引证"：当页码不可用时（扫描件、重排版、DOCX），
 * 它是唯一还能把 segment 与源件对上的东西。
 *
 * 刻意**不做**自动对齐：锚点是包作者的声明，不是系统推断出来的。
 */
export interface CourseSourceAnchor {
  pageStart: number | null;
  pageEnd: number | null;
  quote: string | null;
}

export interface CourseSegment {
  id: string;
  /** 指向本包 `materials[]` 中的一项。 */
  materialId: string;
  kind: CourseSegmentKind;
  /** 声明顺序，用于稳定呈现。 */
  order: number;
  title: string;
  /** 锚点涉及的表示。页码锚点必须声明它；没有锚点时为 null。 */
  representationId: string | null;
  anchor: CourseSourceAnchor;

  /**
   * 听力：**整段音频**资产 id（整卷 MP3 或整段录音）。
   *
   * 硬约束：**不因为"每段一个文件更整齐"就切分或重编码音频**。
   * 时间区间只作为模型里可选的补充信息存在（`startSeconds` / `endSeconds`），
   * 本阶段**不做**任何音频处理，也不从音频里推断区间。
   */
  audioAssetId: string | null;
  /** 可选时间区间（秒）。两者都给出时必须 end > start。本阶段不产生它。 */
  startSeconds: number | null;
  endSeconds: number | null;

  /** 主体文本：阅读篇章 / 翻译原文 / 写作模板正文 / 方法说明。 */
  text: string | null;
  /** 听力文字稿。没有就是没有，**不由 AI 补全**。 */
  transcript: string | null;
  /** 课程参考译文（翻译类）。它是课程材料，**不是**唯一正确译法。 */
  referenceTranslation: string | null;
  /** 课程讲解 / 语言点 / 方法注解。 */
  notes: string | null;
}

// ---------------------------------------------------------------------------
// 来源与权利
// ---------------------------------------------------------------------------

/**
 * 课程包的来源与权利说明。
 *
 * 与试卷的 `PaperProvenance` 刻意分开：试卷的核验讨论的是"这是不是真题"，
 * 课程的来源讨论的是"这份付费材料从哪来、能不能留在本机"。
 * 两者的判据与措辞完全不同，合并会迫使其中一方说谎。
 */
export interface CourseProvenance {
  /** 来源描述，人可读。不能为空。 */
  note: string;
  /** 来源引用（购买渠道/课程名/本地文件名）。可为 null。 */
  reference: string | null;
  /**
   * **权利说明：这份材料为什么可以合法保存在本机。**
   *
   * 必填。课程材料是付费内容，它留在本机的前提必须被作者显式写下，
   * 否则一个包可以静默地变成"来源不明的付费材料"。
   */
  rightsNote: string;
}

// ---------------------------------------------------------------------------
// 课程包
// ---------------------------------------------------------------------------

export interface CoursePackageContent {
  /** 稳定课程 id。导入后不随内容更新而改变，历史曝光才能安全引用它。 */
  id: string;
  /**
   * **manifest 的序列化契约版本**（必需）。
   *
   * 与 `contentVersion` 分工严格不同：前者判"这份 JSON 该按哪一版契约解析"，
   * 后者判"这是第几版语义内容"。manifest 升版**不得**使 canonical 链接失效；
   * 内容升版必须。见 `domain/course.ts` 的说明。
   */
  schemaVersion: number;
  /**
   * 提供方。**自由字符串，不是枚举** —— 首个 provider 是一个商业课程品牌，
   * 但架构上它与其他 provider 完全等价。
   */
  provider: string;
  /** 版次 / 期次标签，例如 "2026 下半年"。可为 null。 */
  edition: string | null;
  title: string;
  /**
   * **语义内容**版本。内容实质变化时才递增 ——
   * 只改 provenance / 权利说明这类元数据不得涨版本（见 `contentFingerprint`）。
   */
  contentVersion: number;
  provenance: CourseProvenance;
  materials: CourseMaterial[];
  segments: CourseSegment[];
  assets: CourseAsset[];
}

// ---------------------------------------------------------------------------
// 导入边界
// ---------------------------------------------------------------------------

/** 一个已规范化、尚未校验的课程包（仍是磁盘上的目录，未解析）。 */
export interface NormalizedCourseHandle {
  /** 包目录相对于 courses root 的路径。 */
  relativePath: string;
  /** 磁盘绝对路径。仅导入器内部使用，不得外泄给 UI。 */
  absolutePath: string;
}

/** 解析并校验后的候选课程包。 */
export interface ValidatedCourse {
  content: CoursePackageContent;
  /** `course.json` 的 sha256。用于重复/变更检测。 */
  checksum: string;
  packageRelativePath: string;
  /** 校验期间产生的非致命提醒。 */
  warnings: string[];
}

/** 失败时的一条结构化错误，必须带精确位置（`segments[2].materialId`）。 */
export interface CourseIssue {
  path: string;
  message: string;
}

/**
 * 课程包导入器边界。
 *
 * 与试卷包一样，这里只有"规范化目录包"一个实现。
 * 未来的"PDF/DOCX → 规范化课程包"抽取链路应当是**另一个**实现，
 * 且必须先产出规范化包、经人工复核，才能进入导入器 ——
 * 本阶段**不实现**它。
 */
export interface CoursePackageImporter {
  readonly kind: "normalized_course_package";
  readonly label: string;
  discover(): NormalizedCourseHandle[];
  /** 解析 + **逐个校验资产真实字节与校验和**。不产生任何写入。 */
  validate(handle: NormalizedCourseHandle): ValidatedCourse;
  /** 只解析结构，**不读资产字节**（页面读取用）。 */
  parse(handle: NormalizedCourseHandle): ValidatedCourse;
}
