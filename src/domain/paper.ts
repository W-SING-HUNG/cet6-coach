/**
 * 真题试卷的领域词汇。
 *
 * 为什么与 `src/domain/types.ts` 分文件：
 * 那里描述的是"训练闭环"的词汇（技能、任务、题型），这里是"考试内容"的词汇
 * （卷次、来源、核验状态、训练池归属）。两者的变更原因完全不同 ——
 * 官方改题型只影响后者，改学习闭环只影响前者。
 *
 * 这一层刻意不依赖任何 I/O：路径解析、文件读取、数据库索引都在 content /
 * repositories 层，domain 只描述"一份真题试卷应该长什么样"。
 */

// ---------------------------------------------------------------------------
// 考试与卷次
// ---------------------------------------------------------------------------

/** 目前只支持 CET-6。保留枚举形态是为了未来不把 CET-4 混进同一个目录里。 */
export const PAPER_EXAM_TYPES = ["CET6"] as const;
export type PaperExamType = (typeof PAPER_EXAM_TYPES)[number];

/**
 * 考试场次。
 *
 * 只枚举实际存在过的笔试场次。2020 年后 CET 曾因疫情增设 9 月延考场次，
 * 因此它是合法值而不是异常。不引入"未知场次"这种值 —— 缺场次的卷子
 * 不应该被导入，而不是被导入成一条信息不完整的记录。
 */
export const PAPER_SESSIONS = ["June", "September", "December"] as const;
export type PaperSession = (typeof PAPER_SESSIONS)[number];

export const PAPER_SESSION_LABELS: Record<PaperSession, string> = {
  June: "6 月",
  September: "9 月",
  December: "12 月",
};

// ---------------------------------------------------------------------------
// 来源与核验
// ---------------------------------------------------------------------------

/**
 * 内容来源类型。
 *
 * 这是产品内容策略的核心字段：**绝不允许**测试夹具或示例数据
 * 以 `real_past_paper` 的身份出现在生产界面里。
 * 三种值互斥，没有"看起来像真题"这种中间态。
 */
export const PAPER_SOURCE_KINDS = ["real_past_paper", "sample", "test_fixture"] as const;
export type PaperSourceKind = (typeof PAPER_SOURCE_KINDS)[number];

export const PAPER_SOURCE_KIND_LABELS: Record<PaperSourceKind, string> = {
  real_past_paper: "历年真题",
  sample: "示例包（非真题）",
  test_fixture: "测试夹具",
};

/** 非真题来源在 UI 上必须显著标注，不能与真题同视觉层级。 */
export function isProductionRealPaper(sourceKind: PaperSourceKind): boolean {
  return sourceKind === "real_past_paper";
}

/**
 * 核验状态。
 *
 * 语义：一份内容**不能**因为"某个网站说它是真题"就变成真题。
 * 只有逐项核对过（各部分完整、答案与原文一致、音频与试卷对应）才能标 verified。
 */
export const PAPER_VERIFICATION_STATUSES = ["unverified", "partially_verified", "verified"] as const;
export type PaperVerificationStatus = (typeof PAPER_VERIFICATION_STATUSES)[number];

export const PAPER_VERIFICATION_LABELS: Record<PaperVerificationStatus, string> = {
  unverified: "未核验",
  partially_verified: "部分核验",
  verified: "已核验",
};

// ---------------------------------------------------------------------------
// 训练池归属
// ---------------------------------------------------------------------------

/**
 * 试卷在备考策略中的用途。
 *
 * `mock_reserve` 的意义：刻意保留未做过的近年真题，留到后期做真实模考。
 * 这是**用户策略**，不是进度状态，所以它与完成度分开存储。
 */
export const PAPER_POOLS = ["training", "mock_reserve"] as const;
export type PaperPool = (typeof PAPER_POOLS)[number];

export const PAPER_POOL_LABELS: Record<PaperPool, string> = {
  training: "训练池",
  mock_reserve: "模考保留",
};

/**
 * 试卷的练习状态。
 *
 * 诚实性约束：`partially_practiced` / `completed` 需要"试卷级作答记录"作为证据。
 * Phase 2 尚未把作答关联到试卷，因此仓库层只会返回 `untouched` 与 `reserved_mock`。
 * 这两个未接入的状态保留在类型里，是为了让接入时不改变调用方的类型契约 ——
 * 但**不得**在没有数据来源的情况下凭空产生它们。
 */
export const PAPER_PROGRESS_STATES = ["untouched", "partially_practiced", "completed", "reserved_mock"] as const;
export type PaperProgressState = (typeof PAPER_PROGRESS_STATES)[number];

export const PAPER_PROGRESS_LABELS: Record<PaperProgressState, string> = {
  untouched: "未开始",
  partially_practiced: "部分练习",
  completed: "已完成",
  reserved_mock: "模考保留",
};

/** 哪些进度状态目前有真实数据来源。UI 对无来源的状态必须显示"未接入"而不是猜测。 */
export const PAPER_PROGRESS_STATES_WITH_EVIDENCE: PaperProgressState[] = ["untouched", "reserved_mock"];

// ---------------------------------------------------------------------------
// 训练池策略（唯一权威判定）
// ---------------------------------------------------------------------------

/**
 * 一份试卷是否**可以作为日常训练材料开始**。
 *
 * ── 为什么这必须是一个具名谓词，而不是散落的 `pool === "mock_reserve"` ──
 *
 * "模考保留"是一条**产品策略**，不是某个页面的显示细节：
 *
 *   刻意留住没做过的真题，后面才能用真正没见过的卷子做模考。
 *   未触碰的材料是有限资源，不是可随意消耗的余额。
 *   （PRODUCT_PRINCIPLES 第 7 条）
 *
 * 它曾经只在部分路径上被遵守：`/practice` 列表页排除了保留卷，
 * 但**试卷详情页仍渲染「开始训练」**，而 `startReadingRun` 也不看池归属 ——
 * 实测结果是保留卷能被真的开始并写入 `learning_run`，
 * 也就是"保留"只是界面上的说法，不是实际约束。
 *
 * 因此判据收敛到这一个函数：**服务层用它做权威守卫，页面用它决定显示什么**。
 * 页面各自写一份 `pool === "mock_reserve"` 必然漂移 —— 那正是本缺口产生的方式。
 *
 * ── 发现（listable）≠ 可开始（startable）──
 *
 * 保留卷的**结构**仍应可见（来源、核验状态、大题清单、查看结构），
 * 因为用户需要知道"库里有什么、它为什么被保留"。
 * 本谓词只回答"能不能**开始练**"，不回答"能不能看" ——
 * 调用方不要拿它去过滤浏览列表。
 */
export function isPaperStartableForPractice(record: { pool: PaperPool }): boolean {
  return record.pool === "training";
}

/**
 * 这份试卷是否被设为「模考保留」。
 *
 * ── 为什么它也必须是一个具名谓词 ──
 *
 * 它与 `isPaperStartableForPractice` 是**同一个问题的两面**，但调用场景不同：
 *
 * - `isPaperStartableForPractice` 回答"能不能**开始练**"（服务层守卫）；
 * - 本谓词回答"「严格未见模考」这个承诺**是否适用于它**"
 *   （见 `./paper-freshness`，模考新鲜度只对保留卷呈现）。
 *
 * 两者都必须从一处来。第二种场景尤其容易写成裸比较，因为它看起来只是
 * "要不要显示那个徽标"的样式判断 —— 但它的语义是产品承诺的适用范围，
 * 一旦在某一页写错，用户就会在保留卷上看到（或看不到）那个承诺。
 *
 * 刻意与 `isPaperStartableForPractice` **互为反面**而不是互相调用：
 * 若写成 `!isPaperStartableForPractice(record)`，将来若出现第三种池归属
 * （例如"已消耗"），两者会**同时**改变，而它们其实回答不同问题。
 * 由 `tests/paper-pool-policy.test.ts` 固定它们的互补关系。
 */
export function isPaperReservedForMock(record: { pool: PaperPool }): boolean {
  return record.pool === "mock_reserve";
}

/**
 * 保留卷不可开始时的**学习者可见原因**（唯一措辞）。
 *
 * 集中在一处的理由与上面的谓词相同：同一件事在两个页面上说两句不同的话，
 * 就是两个真相。这句文案必须同时给出**为什么**与**怎么办** ——
 * 只说"不可用"会让用户以为功能坏了，而材料其实就在库里。
 */
export const RESERVED_PAPER_REASON =
  "这份试卷当前被设为「模考保留」，不作为日常训练材料。若要练习，请先在真题库中将它移回训练池。";

// ---------------------------------------------------------------------------
// 官方试卷结构
// ---------------------------------------------------------------------------

/**
 * 官方大题（section）标识。
 *
 * 刻意不用 "multiple_choice" 这类通用题型当分类：那会丢掉官方身份，
 * 而"这篇是长对话还是讲座"直接决定训练方式与听力量的分配。
 */
export const PAPER_SECTION_TYPES = [
  "writing",
  "listening.long_conversation",
  "listening.passage",
  "listening.talk_report_lecture",
  "reading.banked_cloze",
  "reading.matching",
  "reading.careful_reading",
  "translation",
] as const;
export type PaperSectionType = (typeof PAPER_SECTION_TYPES)[number];

/** 官方顺序。导入时校验 sections 的声明顺序必须与它一致。 */
export const OFFICIAL_SECTION_ORDER: PaperSectionType[] = [
  "writing",
  "listening.long_conversation",
  "listening.passage",
  "listening.talk_report_lecture",
  "reading.banked_cloze",
  "reading.matching",
  "reading.careful_reading",
  "translation",
];

export const SECTION_LABELS: Record<PaperSectionType, string> = {
  writing: "写作",
  "listening.long_conversation": "听力 · 长对话",
  "listening.passage": "听力 · 篇章",
  "listening.talk_report_lecture": "听力 · 讲话/报道/讲座",
  "reading.banked_cloze": "阅读 · 选词填空",
  "reading.matching": "阅读 · 长篇阅读（匹配）",
  "reading.careful_reading": "阅读 · 仔细阅读",
  translation: "翻译",
};

/** 官方分值权重，用于在详情页如实展示"这部分占卷面多少"。 */
export const SECTION_SCORE_WEIGHTS: Record<PaperSectionType, number> = {
  writing: 0.15,
  "listening.long_conversation": 0.08,
  "listening.passage": 0.07,
  "listening.talk_report_lecture": 0.2,
  "reading.banked_cloze": 0.05,
  "reading.matching": 0.1,
  "reading.careful_reading": 0.2,
  translation: 0.15,
};

/** 各部分的题量。写作与翻译各 1 个作答项（主观题）。 */
export const SECTION_QUESTION_COUNTS: Record<PaperSectionType, number> = {
  writing: 1,
  "listening.long_conversation": 8,
  "listening.passage": 7,
  "listening.talk_report_lecture": 10,
  "reading.banked_cloze": 10,
  "reading.matching": 10,
  "reading.careful_reading": 10,
  translation: 1,
};

/**
 * 哪些部分参与**官方题号编号**。
 *
 * 实测依据（2024-12 第 1 套**源卷存档 PDF** 第 9 页的 KEYS 表）：
 * 题号只覆盖 Part II 听力（1–25）与 Part III 阅读（26–55），
 * **写作（Part I）与翻译（Part IV）没有题号** —— 它们是主观作答项，
 * 存档 KEYS 表里也不出现（无客观答案）。
 *
 * 这个区分不是格式细节：它决定"题号连续性"这条校验该怎么施加。
 * 早先的模型假定整卷从写作编号到翻译（1–57），是**对考试本身的事实误判** ——
 * 真实试卷的作答项编号止于 55。现已按源卷材料纠正。
 */
export const SECTION_IS_NUMBERED: Record<PaperSectionType, boolean> = {
  writing: false,
  "listening.long_conversation": true,
  "listening.passage": true,
  "listening.talk_report_lecture": true,
  "reading.banked_cloze": true,
  "reading.matching": true,
  "reading.careful_reading": true,
  translation: false,
};

/**
 * 一份完整试卷中**参与官方编号**的题目总数。
 *
 * 不是"卷面题目总数"（那是 57，含写作与翻译两个主观项）。
 * 55 = 听力 25（8+7+10）+ 阅读 30（10+10+10）。
 */
export const OFFICIAL_NUMBERED_ITEM_TOTAL = 55;

/** 卷面全部作答项数量（含两个主观项），用于完整性表述。 */
export const OFFICIAL_TOTAL_ITEM_COUNT = 57;

/** 每个大题归属的计分模块，用于把试卷结构与已有的 Skill 体系对上。 */
export const SECTION_SKILL: Record<PaperSectionType, "listening" | "reading" | "writing" | "translation"> = {
  writing: "writing",
  "listening.long_conversation": "listening",
  "listening.passage": "listening",
  "listening.talk_report_lecture": "listening",
  "reading.banked_cloze": "reading",
  "reading.matching": "reading",
  "reading.careful_reading": "reading",
  translation: "translation",
};

export function sectionSkill(type: PaperSectionType): "listening" | "reading" | "writing" | "translation" {
  return SECTION_SKILL[type];
}

/** 官方笔试总时长（分钟）。单一部分的时长未官方拆分，因此不编造。 */
export const WRITTEN_EXAM_DURATION_MINUTES = 130;
