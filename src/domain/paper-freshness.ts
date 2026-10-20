import {
  COURSE_EXPOSURE_EVENT_TYPES,
  type CourseExposureEventType,
  type CourseLinkTargetScope,
} from "./course";
import { SECTION_LABELS, type PaperSectionType } from "./paper";

/**
 * 模考**新鲜度**（Mock Freshness）的领域词汇。
 *
 * ── 这个文件补上的那条语义缺口 ──
 *
 * 系统此前已经守住：
 *
 *     课程曝光（看过材料）≠ 表现证据（独立作答真题）。
 *
 * 但它**没有**守住另一条，而那条同样是诚实的必要条件：
 *
 *     课程曝光到**已核验**的真题内容 ≠ 这份试卷仍然"完全没见过"。
 *
 * 具体情形：学习者看过一段课程材料 → 那段材料讲的就是某份真题的某个大题 →
 * 两周后人工核验出这个对应关系 → 试卷在库里看起来仍然 pristine。那是假的。
 * 学习者可能没有表现出任何能力，但**刺激材料已经不再是新的**。
 *
 * ── 这不是掌握度，是内容事实 ──
 *
 * 本模块刻意**没有**任何分数、权重、掌握度或污染度字段。它回答的只有一件事：
 *
 *     "系统能否诚实地说：这份试卷对这位学习者而言仍然完全没见过？"
 *
 * 三个状态，互斥且穷尽：
 *
 * | 状态 | 含义 | 严格模考 |
 * | --- | --- | --- |
 * | `pristine` | 没有已证明的既往接触，也没有妨碍我们断言新鲜的身份条件 | **可用** |
 * | `exposed` | 已核验的精确证据证明学习者此前看过这份试卷的真题内容 | 不可用 |
 * | `uncertain` | 历史证据 / 链接 / 包状态使我们**无法安全地证明**它仍然没见过 | 不可用 |
 *
 * ── 为什么不能把"不知道"塞进 pristine ──
 *
 * 这是本设计的关键。若把"读不到课程包"或"链接已失配"当成"没接触过"，
 * 系统就会在最需要谨慎的那条路径上 **fail open**：包一旦漂移或升版，
 * 所有受影响的试卷会**自动变回**"安全的未见模考"，而事实恰恰可能是相反的。
 * 因此严格模考资格**失败关闭**：只有真正 `pristine` 才能被描述为未见模考。
 *
 * ── 与 `isPaperStartableForPractice` 的分工（不要合并）──
 *
 * `isPaperStartableForPractice`（见 `./paper`）回答的是
 * "这份试卷的**策略池**允许它作为日常训练材料开始吗"。
 * 那是 使用者的策略选择，与本模块的**内容事实**是两个问题。
 * 一份试卷可以同时是"被标为模考保留"且"已在课程中接触过其中内容" ——
 * 这个矛盾必须被**如实呈现**，而不是被系统悄悄改写掉（见 `decidePaperFreshness`
 * 与 `PAPER_POOL_LABELS`：池归属只由 使用者 改）。
 *
 * 本层是**纯函数**：不读文件、不读数据库、不看时钟（由架构门禁守护）。
 * 包完整性、链接可用性、曝光读取都在服务层（`services/paper-freshness.ts`），
 * 且那里**复用**既有的唯一判据，不新造第二套。
 */

// ---------------------------------------------------------------------------
// 状态模型
// ---------------------------------------------------------------------------

/**
 * 模考新鲜度的状态。
 *
 * 顺序有意：越靠前越"可断言"，越靠后越保守。`uncertain` 排在最后，
 * 提醒调用方它**不是** pristine 的变体，而是一个独立的、更诚实的结论。
 */
export const PAPER_FRESHNESS_STATES = ["pristine", "exposed", "uncertain"] as const;
export type PaperFreshnessState = (typeof PAPER_FRESHNESS_STATES)[number];

/** 状态短标签。用于徽标。不含任何掌握度/成绩措辞。 */
export const PAPER_FRESHNESS_LABELS: Record<PaperFreshnessState, string> = {
  pristine: "尚未接触",
  exposed: "已接触过相关内容",
  uncertain: "是否接触过无法确认",
};

/**
 * 面向学习者的完整表述（唯一措辞）。
 *
 * 三条文案都必须同时回答"是什么"与"所以呢"：
 * 只说"不确定"会让用户以为功能坏了，而事实是系统在诚实地区分两件事。
 *
 * 刻意**不用**的词：tainted / contaminated / dirty / invalid（把事实说成缺陷）、
 * 以及任何掌握度 / 分数 / 弱项措辞（那是另一条边界，本模块无权断言）。
 */
export const PAPER_FRESHNESS_HEADLINES: Record<PaperFreshnessState, string> = {
  pristine: "模考保留 · 尚未接触",
  exposed: "已在课程中接触过相关真题内容，不再适合作为严格未见模考",
  uncertain: "无法确认是否仍未接触，暂不作为严格模考",
};

/**
 * 把若干子句拼成**标点正确**的一句话。
 *
 * ── 为什么需要它（实测呈现缺陷）──
 *
 * 每个子句可能自带结尾标点（`。` / `；`）。朴素的
 * `clauses.join("；") + "。"` 会产出两种可见的错误：
 *
 * - 子句之间出现 `。；`（前一句的句号后面跟着分隔分号）；
 * - 句尾出现 `。。`（最后一句自带句号，再补一个句号）。
 *
 * 这两种都会**原样出现在学习者看到的页面上** —— React 把字符串当纯文本渲染，
 * 不会替我们收拾标点。因此标点必须由拼装这一处统一决定：
 * 先剥掉每个子句自带的结尾标点，再用 `；` 连接、最后补**一个**句号。
 *
 * 刻意**不引入** Markdown 解析器：这些是纯文本 UI 文案，
 * 引入解析器既是为了一件事引入依赖，也会让"文案里到底会渲染出什么"变得
 * 更难回答。文案本身就不该带标记语法。
 */
export function joinClauses(clauses: readonly string[]): string {
  const cleaned = clauses
    .map((clause) => clause.trim())
    // 只剥结尾的句号 / 分号；`——` 结尾是合法的悬停标点，保留。
    .map((clause) => clause.replace(/[。；;.]+$/u, "").trim())
    .filter((clause) => clause !== "");

  if (cleaned.length === 0) return "";
  return `${cleaned.join("；")}。`;
}

/**
 * 状态解释：为什么得出这个结论，以及它对"严格未见模考"意味着什么。
 *
 * 与 `RESERVED_PAPER_REASON` 同样的纪律：同一件事在两处说两句不同的话，
 * 就是两个真相。因此措辞只此一份。
 *
 * ── 三条措辞纪律（由测试与浏览器验收固定）──
 *
 * 1. **纯文本，不带标记语法。** 面向学习者的字符串里不得出现 `**` 等
 *    Markdown 标记 —— 它们会被当成字面字符渲染出来（实测缺陷）。
 * 2. **标点由 `joinClauses` 统一拼装**，不得手写 `join("；") + "。"`。
 * 3. **断言必须落在证据能支撑的范围内。** `pristine` 的判据是
 *    "**本系统内**没有查到已核验的接触记录"，不是一个关于学习者全部经历的
 *    绝对断言。因此文案必须显式说明这一点，而不是说"从未见过"。
 */
export function explainPaperFreshness(freshness: PaperFreshness): string {
  switch (freshness.state) {
    case "pristine":
      /*
       * ── 措辞面向**非技术学习者**（评审 A 项要求 5）──
       *
       * 原先那句"内容包与核验链接当前都成立"是内部实现词汇，学习者读不懂
       * （他不知道什么是"内容包"，也不知道"核验链接"是什么）。因此这里
       * 只保留他能理解的两件事：
       *
       * 1. **结论是什么** —— 可以按「尚未接触」使用；
       * 2. **结论的依据范围** —— 只是本应用的记录，不等于现实世界的全部事实。
       *
       * 第 2 条是**必须保留**的：它防止这句话被读成"你绝对没见过"，
       * 而那是一句本应用无权作出的绝对断言。
       */
      return (
        "本应用没有查到你在课程中接触过这份试卷的记录，因此可以按「尚未接触」使用。" +
        "这个判断只依据本应用内保存的课程记录与人工核验结果，" +
        "它不代表你在别的地方从未见过这份材料。"
      );
    case "exposed":
      return (
        `经人工核验的对应关系证明：你在课程中已经看过这份试卷的 ` +
        `${describeFreshnessTargets(freshness.matches)}。` +
        "这不代表你会做或不会做这道题 —— 它只说明刺激材料已经不再是新的，" +
        "因此它不再适合作为「严格未见」的模考材料。"
      );
    case "uncertain":
      return (
        "系统目前无法证明这份试卷仍然完全未被接触。" +
        `已知的具体情况：${joinClauses(freshness.unresolved.map((item) => item.message))}` +
        "在这些身份条件能够被证明之前，它不会被当作严格未见模考 —— " +
        "把「不知道」说成「没见过」正是这里要避免的事。"
      );
  }
}

/**
 * 严格未见模考的资格判据（**唯一实现**）。
 *
 * 失败关闭：只有 `pristine` 才是合格。`exposed` 有正面证据，
 * `uncertain` 是"无法证明"，两者都**不得**被描述为未见模考。
 *
 * 这是本模块存在的最终目的 —— 让"这份卷子还能当严格模考吗"这个问题
 * 只有一个答案来源，而不是散落在若干页面的条件表达式里。
 */
export function isPaperEligibleForStrictMock(freshness: { state: PaperFreshnessState }): boolean {
  return freshness.state === "pristine";
}

/**
 * 不合格时的**学习者可见原因**（唯一措辞）。
 *
 * 与 `RESERVED_PAPER_REASON` 同一条理由：只说"不可用"会让用户以为功能坏了，
 * 而材料其实就在库里、只是它的状态不满足严格模考的前提。
 *
 * 标题与解释之间用全角空格而不是标点连接：标题自身已是一个完整的短句，
 * 再补标点会产出 `。。` 这类重复标点（实测缺陷）。
 */
export function explainStrictMockIneligibility(freshness: PaperFreshness): string {
  if (isPaperEligibleForStrictMock(freshness)) {
    return "这份试卷目前满足严格未见模考的前提。";
  }
  return `${PAPER_FRESHNESS_HEADLINES[freshness.state]}　${explainPaperFreshness(freshness)}`;
}

// ---------------------------------------------------------------------------
// 曝光的"是否算见过"登记表
// ---------------------------------------------------------------------------

/**
 * 一种曝光事件种类**本身**是否足以断言"学习者接触过这段内容"。
 *
 * ── 为什么需要一张登记表，而不是一个 `includes` 白名单 ──
 *
 * 「哪些事件算接触」是一个**产品判断**，它的依据必须可检索、可复核。
 * 若只写一个数组，日后再加一种事件类型时，没有人会注意到这里需要一次决定 ——
 * 于是新事件会**静默地**既不纳入也不排除。登记表 + `findExposureRegistryGaps`
 * 让"漏做决定"变成一条可断言的失败。
 *
 * ── 为什么有两个布尔值，而不是一个 ──
 *
 * "请求过揭示"与"确实看过内容"是两件不同的事（见
 * `COURSE_EXPOSURE_SEEN_BASIS` 的说明）。把它们压成一个布尔值，
 * 就会强迫其中一种被误判成另一种。两个布尔值各回答一个问题：
 * 已确认接触 vs 潜在接触。
 *
 * ── 为什么不给不同种类**不同权重** ──
 *
 * 一个"看过解析"比"看过原文"更严重的分值，听起来精细，实际上是**没有证据的
 * 精确性**：现有材料不支持任何这样的比例。因此每个判定都是二值的。
 */
export interface ExposureTypeSeenBasis {
  /** 该事件种类本身是否足以断言"学习者确实接触过这段内容"。 */
  establishesSeenContent: boolean;
  /**
   * 该事件种类本身是否足以断言"学习者**可能**接触过这段内容"。
   *
   * 它是比 `establishesSeenContent` 更宽的判定：已确认接触蕴含潜在接触。
   */
  establishesPotentialContact: boolean;
  /** 判断依据。写下来，这样"为什么它算/不算"不需要靠猜。 */
  rationale: string;
}

/**
 * 曝光事件种类的**接触语义**判断（逐条给出依据）。
 *
 * ── 这里有两个不同的判定，不是一个 ──
 *
 * 上一版只有 `establishesSeenContent` 一个布尔值，于是"请求过揭示"
 * 与"确实看过内容"被压成同一个结论。那是不诚实的：请求只说明
 * 学习者**要求**看，它不证明正文被送达、被送达的内容被读了、
 * 或者那次请求成功了。
 *
 * 因此现在分成两个正交的判定：
 *
 * | 判定 | 回答的问题 | 影响的状态 |
 * | --- | --- | --- |
 * | `establishesSeenContent` | 能否断言"学习者确实看过这段内容"？ | `exposed`（已证明接触） |
 * | `establishesPotentialContact` | 能否断言"学习者**可能**看过"？ | `uncertain`（无法证明仍未见） |
 *
 * 两者都**失败关闭**：任何一条为真的事件，都让该试卷失去严格未见资格。
 * 区别只在于是"已证明"还是"无法证明" —— 而那个区别对学习者很重要。
 *
 * ── 为什么 `reveal_requested` 只能算潜在接触 ──
 *
 * 它记录的是"学习者点了「看这段」"。这一步之后：
 *
 * - 请求可能失败（网络中断、服务端拒绝、包恰好在那时漂移）；
 * - 正文可能已下发但学习者没有读；
 * - 同一次点击可能被重复提交。
 *
 * 因此系统**不能**断言"他看过"。但系统也**不能**说"他没看过" ——
 * 请求本身就是强有力的反向证据。于是正确的结论是 `uncertain`。
 *
 * 把请求算成"确实看过"会让 `exposed` 这个词失去含义：它本来
 * 只用于**已证明**的接触。
 */
export interface ExposureTypeSeenBasis {
  /**
   * 该事件种类本身是否足以断言"学习者确实接触过这段内容"。
   *
   * 只有四种已确认事件为 `true`（见下）。`reveal_requested` 为 `false`。
   */
  establishesSeenContent: boolean;
  /**
   * 该事件种类本身是否足以断言"学习者**可能**接触过这段内容"。
   *
   * `reveal_requested` 为 `true`。四种已确认事件同样为 `true`
   * （已确认当然蕴含可能）—— 于是"已证明"那条路径不会因为漏了
   * 潜在接触判定而 fail open。
   */
  establishesPotentialContact: boolean;
  /** 判断依据。写下来，这样"为什么它算/不算"不需要靠猜。 */
  rationale: string;
}

/**
 * 五种已登记事件种类的判断（逐条给出依据）。
 *
 * 前四种都算**已确认接触**（`establishesSeenContent: true`）。
 * 其中 `declared_seen` 是唯一的一条**自述**而非系统观测 —— 它仍然被纳入，
 * 因为本判据要保护的是 `pristine` 这个**断言**：当学习者自己声明看过时，
 * 系统就没有资格再说"完全没见过"。把自述排除掉会让 pristine 在
 * 恰恰最可疑的情形上 fail open。
 */
export const COURSE_EXPOSURE_SEEN_BASIS: Record<CourseExposureEventType, ExposureTypeSeenBasis> = {
  content_rendered: {
    establishesSeenContent: true,
    establishesPotentialContact: true,
    rationale:
      "材料本身被呈现给学习者 —— 这是「看到内容」最直接的一种，无需任何推断。",
  },
  solution_rendered: {
    establishesSeenContent: true,
    establishesPotentialContact: true,
    rationale:
      "解析/答案被呈现。对「这道题还是新的吗」而言这是最强的反证：学习者已经看过答案。",
  },
  teacher_explanation_seen: {
    establishesSeenContent: true,
    establishesPotentialContact: true,
    rationale:
      "老师讲解被看过。讲解针对的就是这段内容，因此它同样意味着刺激材料不再新鲜。",
  },
  declared_seen: {
    establishesSeenContent: true,
    establishesPotentialContact: true,
    rationale:
      "学习者**自述**已看过。它不是系统观测，因此强度最低；但它仍是学习者本人的肯定主张，" +
      "而 pristine 是一个**肯定断言**（「完全没接触过」）。在没有观测证据否定这个主张时，" +
      "把它排除掉会让系统在最可疑的情形上仍自称未见 —— 那是 fail open。",
  },
  reveal_requested: {
    establishesSeenContent: false,
    establishesPotentialContact: true,
    rationale:
      "学习者**主动请求**揭示这段正文。它只证明「学习者要求看」，不证明正文被送达、" +
      "被送达的内容被读过，也不证明那次请求成功 —— 因此不能算已确认接触。" +
      "但它仍然是强有力的反向证据：请求本身就说明学习者想让这段材料对自己可见。" +
      "所以它是**潜在接触**：让该试卷进入 uncertain（无法证明仍未见），而不是 exposed（已证明接触），" +
      "更绝不是 pristine（完全没接触过）。",
  },
};

/**
 * 参与"已确认接触"判定的曝光事件种类（由登记表**推导**，不是另写一份）。
 */
export const EXPOSURE_TYPES_ESTABLISHING_SEEN_CONTENT: readonly CourseExposureEventType[] =
  COURSE_EXPOSURE_EVENT_TYPES.filter(
    (eventType) => COURSE_EXPOSURE_SEEN_BASIS[eventType].establishesSeenContent,
  );

/**
 * 参与"潜在接触"判定的曝光事件种类（由登记表**推导**）。
 *
 * 它包含全部已确认种类（已确认蕴含可能），因此这条清单是
 * `EXPOSURE_TYPES_ESTABLISHING_SEEN_CONTENT` 的超集。
 */
export const EXPOSURE_TYPES_ESTABLISHING_POTENTIAL_CONTACT: readonly CourseExposureEventType[] =
  COURSE_EXPOSURE_EVENT_TYPES.filter(
    (eventType) => COURSE_EXPOSURE_SEEN_BASIS[eventType].establishesPotentialContact,
  );

/**
 * 判定一个事件种类是否构成**已确认**接触。
 *
 * 查不到时返回 `false` —— 未登记的种类**不**参与判定，但它也不该出现：
 * `findExposureRegistryGaps` 会把"未做决定"报出来，由测试固定。
 */
export function establishesSeenContent(eventType: CourseExposureEventType): boolean {
  return COURSE_EXPOSURE_SEEN_BASIS[eventType]?.establishesSeenContent ?? false;
}

/**
 * 判定一个事件种类是否构成**潜在**接触。
 *
 * 与 `establishesSeenContent` 是两个不同的判定，见 `ExposureTypeSeenBasis`
 * 的说明。未登记的种类返回 `false`。
 */
export function establishesPotentialContact(eventType: CourseExposureEventType): boolean {
  return COURSE_EXPOSURE_SEEN_BASIS[eventType]?.establishesPotentialContact ?? false;
}

/**
 * 登记表的完整性检查：每一种已登记的曝光事件种类都必须**被明确决定过**。
 *
 * 返回空数组表示完整。加了一种新事件类型却忘记在这里做决定时，这里会报出来 ——
 * 于是"新事件被静默忽略"变成一条测试失败，而不是一个没人发现的行为变化。
 */
export function findExposureRegistryGaps(): string[] {
  const gaps: string[] = [];
  for (const eventType of COURSE_EXPOSURE_EVENT_TYPES) {
    const basis = COURSE_EXPOSURE_SEEN_BASIS[eventType];
    if (!basis) {
      gaps.push(`曝光事件种类 ${eventType} 没有在 COURSE_EXPOSURE_SEEN_BASIS 中登记判断依据。`);
      continue;
    }
    if (basis.rationale.trim() === "") {
      gaps.push(`曝光事件种类 ${eventType} 的登记缺少判断依据说明。`);
    }
    if (typeof basis.establishesSeenContent !== "boolean") {
      gaps.push(`曝光事件种类 ${eventType} 的 establishesSeenContent 必须是布尔值。`);
    }
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// 新鲜度投影（纯数据形状 + 纯判定）
// ---------------------------------------------------------------------------

/**
 * 一条**已证明**的接触证据（目标级）。
 *
 * 粒度被保留到链接声明的那一层：`section` / `group` / `question`。
 * 整卷新鲜度由这些目标**向上聚合**（任何一处被接触 ⇒ 整卷不再是严格未见），
 * 但两条陈述**不可互换**：
 *
 * - "这份试卷不再是严格未见" —— 本投影支持；
 * - "这位学习者已经掌握/做得出这份试卷" —— **本投影不支持**，
 *   而且它永远不由课程曝光得出（那是 `performance_event` 的事）。
 */
export interface PaperExposureMatch {
  paperId: string;
  /** 证据成立时该证据所绑定的真题内容版本（= 链接记录的版本 = 当前版本）。 */
  paperContentVersion: number;
  sectionId: string;
  groupId: string | null;
  questionId: string | null;
  targetScope: CourseLinkTargetScope;
  courseId: string;
  segmentId: string;
  /** 链接记录的课程内容版本；曝光事件的版本必须与它**精确相等**。 */
  courseContentVersion: number;
  /** 支撑这条证据的不可变复核行 id。 */
  linkId: string;
  /** 复核出处（谁、依据什么、何时核验的）。 */
  verificationRef: string;
  /** 该目标上最早的曝光时刻。 */
  firstExposedAt: string;
  /** 该目标上最晚的曝光时刻。 */
  lastExposedAt: string;
  /**
   * 贡献到这一目标的曝光**事件条数**。
   *
   * 同一段看五次仍然是**一个**被接触的目标 —— 这个计数只如实记录
   * "有过几次"，绝不参与聚合口径（否则"多看了几遍"会被算成
   * "接触了更多内容"，那是凭空造出的严重度）。
   */
  exposureCount: number;
  /** 贡献的事件种类，升序去重。 */
  eventTypes: CourseExposureEventType[];
}

/** 妨碍我们断言"仍然没见过"的具体条件。 */
export interface PaperFreshnessUnresolved {
  code:
    /** 课程包不在了或缺 course.json —— 身份无法求证。 */
    | "course_package_unreadable"
    /** 课程包在盘上被改动但未重新导入 —— 复核针对的那一版已不是当前这一版。 */
    | "course_package_drifted"
    /** 真题包读不到 —— 无法确认当前内容。 */
    | "paper_package_unreadable"
    /** 真题包在盘上被改动但未重新导入 —— 内容身份不再可证。 */
    | "paper_package_drifted"
    /** 链接本身已不成立（一侧升版，或复核声明的题目位置已不存在）。 */
    | "link_not_runtime_usable"
    /**
     * 学习者**请求过**揭示这段材料，但请求不等于看过。
     *
     * 具体情形：他点过「看这段」，于是系统知道他想让这段材料对自己可见 ——
     * 但那一步之后正文可能没送达、送达了没读、或请求本身失败了。
     * 因此系统**不能**说"他看过"（那会进入 `exposed`），也**不能**说
     * "他没看过"（请求就是反向证据）。结论是 `uncertain`。
     */
    | "potential_contact_only"
    /**
     * 链接当前成立，但学习者的曝光落在**另一个**课程内容版本上。
     *
     * 具体情形：他看过 v1 的这段材料，课程升到 v2 并被人重新核验，
     * 于是 v2 的链接成立而 v1 的曝光对不上。我们**无法证明**他看过的那一版
     * 就是被核验的这一版 —— 因此不能把它算作精确的正面证据。
     */
    | "exposure_version_mismatch";
  /** 可读原因（产品语言）。 */
  message: string;
  /** 仅链接相关的 code 有：相关链接与它所在的段。 */
  courseId?: string;
  segmentId?: string;
  linkId?: string;
}

/**
 * 一份试卷的**派生**新鲜度投影。
 *
 * ── 它是派生的，不是存储的 ──
 *
 * 没有对应的表，也没有缓存：它由"不可变的曝光事实 + 不可变的复核链接 +
 * 当前包完整性"在读取时算出。存下来会立刻产生一个会漂移的第二真相，
 * 而漂移在这里的后果是"证书说未见、事实已见过"。
 *
 * `unresolved` 在 `exposed` 时也可能非空 —— 那是有意保留的信息：
 * 一份已经确认被接触过的试卷，同时可能还有一条失配的链接。
 */
export interface PaperFreshness {
  paperId: string;
  state: PaperFreshnessState;
  /** 目标级的已证明证据，按确定性顺序排列。 */
  matches: PaperExposureMatch[];
  /** 妨碍断言新鲜的具体条件，按确定性顺序排列。 */
  unresolved: PaperFreshnessUnresolved[];
}

/**
 * 证据的**语义身份**：同一个"课程段 → 真题目标"映射只算一条，
 * 无论它被看过多少次、被独立复核过多少次。
 *
 * 用 NUL 连接（与 `courseLinkSemanticTarget` 同一手法）：它是唯一不可能
 * 出现在任何 slug / paper id 里的字符，因此不可能构造出两条不同证据拼出同一个串。
 */
export function exposureMatchKey(
  match: Omit<
    PaperExposureMatch,
    "firstExposedAt" | "lastExposedAt" | "exposureCount" | "eventTypes" | "verificationRef" | "linkId"
  >,
): string {
  return [
    match.paperId,
    String(match.paperContentVersion),
    match.sectionId,
    match.groupId ?? "",
    match.questionId ?? "",
    match.targetScope,
    match.courseId,
    String(match.courseContentVersion),
    match.segmentId,
  ].join("\u0000");
}

/**
 * 由证据与未解决条件**判定**新鲜度（**唯一实现**，纯函数）。
 *
 * 优先级：正面证据 > 无法证明 > 可断言新鲜。
 *
 * - 有任何一条已证明的接触 ⇒ `exposed`（它是**事实**，压过不确定性）；
 * - 否则有任何未解决条件 ⇒ `uncertain`（失败关闭：不知道 ≠ 没见过）；
 * - 否则 ⇒ `pristine`。
 *
 * 它同时是排序与去重的收口处：调用方传什么顺序，结果都相同。
 */
export function decidePaperFreshness(input: {
  paperId: string;
  matches: PaperExposureMatch[];
  unresolved: PaperFreshnessUnresolved[];
}): PaperFreshness {
  const matches = dedupeMatches(input.matches).sort(compareMatches);
  const unresolved = dedupeUnresolved(input.unresolved).sort(compareUnresolved);

  const state: PaperFreshnessState =
    matches.length > 0 ? "exposed" : unresolved.length > 0 ? "uncertain" : "pristine";

  return { paperId: input.paperId, state, matches, unresolved };
}

/**
 * 把同一语义目标的多次曝光**合并**为一条证据。
 *
 * 合并规则是确定性的，且**不重复膨胀**：
 *
 * - 时刻取极值（最早 / 最晚）；
 * - 事件种类取并集后升序；
 * - **计数取最大值而不是求和**；
 * - 代表行（`linkId` / `verificationRef`）取字典序最小者 —— 因此结果与输入顺序无关。
 *
 * ── 为什么计数必须取 max 而不是 sum ──
 *
 * `exposureMatchKey` 已经把 `(courseId, segmentId, courseContentVersion, 目标)`
 * 全部纳入身份，因此**同一个 key 下的每条证据都由完全相同的那一组曝光事件构造** ——
 * 它们的计数本来就相等。
 *
 * 求和会引出一种具体的错误：同一组映射被人工独立复核两次（两行不可变复核记录，
 * 这是**允许且预期**的，见 `course-link.ts` 的语义目标去重说明）时，计数会变成
 * 曝光次数的两倍。于是"复核了几次"会伪装成"学习者多看了几次" ——
 * 那是把审计元数据当成了学习者行为。取 max 保持它的含义：**学习者看过几次**。
 */
export function dedupeMatches(matches: PaperExposureMatch[]): PaperExposureMatch[] {
  const byKey = new Map<string, PaperExposureMatch>();

  for (const match of matches) {
    const key = exposureMatchKey(match);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, { ...match, eventTypes: [...match.eventTypes].sort() });
      continue;
    }

    current.firstExposedAt =
      match.firstExposedAt < current.firstExposedAt ? match.firstExposedAt : current.firstExposedAt;
    current.lastExposedAt =
      match.lastExposedAt > current.lastExposedAt ? match.lastExposedAt : current.lastExposedAt;
    // 取 max（不是求和）—— 同一 key 下的计数必然相等，求和只会把复核次数算成曝光次数。
    current.exposureCount = Math.max(current.exposureCount, match.exposureCount);
    current.eventTypes = [...new Set([...current.eventTypes, ...match.eventTypes])].sort();

    // 代表行确定性选取：id 字典序最小；同 id 时出处更小者。
    if (
      match.linkId < current.linkId ||
      (match.linkId === current.linkId && match.verificationRef < current.verificationRef)
    ) {
      current.linkId = match.linkId;
      current.verificationRef = match.verificationRef;
    }
  }

  return [...byKey.values()];
}

/** 未解决条件的去重（按 code + message + 链接身份）。 */
export function dedupeUnresolved(items: PaperFreshnessUnresolved[]): PaperFreshnessUnresolved[] {
  const byKey = new Map<string, PaperFreshnessUnresolved>();
  for (const item of items) {
    const key = [item.code, item.message, item.courseId ?? "", item.segmentId ?? "", item.linkId ?? ""].join(
      "\u0000",
    );
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()];
}

/**
 * 证据的确定性排序。
 *
 * 顺序由**内容**决定，不依赖任何查询返回顺序：先按真题位置（大题 → 题组 → 题目），
 * 再按课程侧身份（课程 → 内容版本 → 段），最后按复核行 id。
 * 因此同一次调用的输出可复现，跨调用也一致。
 */
export function compareMatches(a: PaperExposureMatch, b: PaperExposureMatch): number {
  return (
    a.sectionId.localeCompare(b.sectionId) ||
    (a.groupId ?? "").localeCompare(b.groupId ?? "") ||
    (a.questionId ?? "").localeCompare(b.questionId ?? "") ||
    a.paperId.localeCompare(b.paperId) ||
    a.courseId.localeCompare(b.courseId) ||
    a.courseContentVersion - b.courseContentVersion ||
    a.segmentId.localeCompare(b.segmentId) ||
    a.linkId.localeCompare(b.linkId)
  );
}

/** 未解决条件的确定性排序。 */
export function compareUnresolved(
  a: PaperFreshnessUnresolved,
  b: PaperFreshnessUnresolved,
): number {
  return (
    a.code.localeCompare(b.code) ||
    (a.courseId ?? "").localeCompare(b.courseId ?? "") ||
    (a.segmentId ?? "").localeCompare(b.segmentId ?? "") ||
    (a.linkId ?? "").localeCompare(b.linkId ?? "") ||
    a.message.localeCompare(b.message)
  );
}

/**
 * 目标的可读描述（供 UI 与原因文案使用）。
 *
 * 刻意用**目标粒度**的措辞（大题 / 题组 / 题），而不是"污染范围"这类词：
 * 它描述的是"你见过哪一部分"，不是"你被扣了多少分"。
 */
export function describeFreshnessTarget(
  match: Pick<PaperExposureMatch, "sectionId" | "groupId" | "questionId" | "targetScope">,
): string {
  const sectionLabel = SECTION_LABELS[match.sectionId as PaperSectionType] ?? match.sectionId;
  if (match.targetScope === "question") {
    return `${sectionLabel} · ${match.groupId ?? "—"} · 第 ${match.questionId ?? "—"} 题`;
  }
  if (match.targetScope === "group") {
    return `${sectionLabel} · ${match.groupId ?? "—"} 组`;
  }
  return `${sectionLabel}（整个大题）`;
}

/** 把多条证据的可读目标**去重**后串起来，用于一句话说明。 */
export function describeFreshnessTargets(matches: PaperExposureMatch[]): string {
  const labels = [...new Set(matches.map((match) => describeFreshnessTarget(match)))].sort();
  return labels.join("、");
}
