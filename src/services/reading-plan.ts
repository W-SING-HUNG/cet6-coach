import type { Repositories } from "@/repositories/ports";
import { isTrainableReadingSection, type TrainableReadingSection } from "@/domain/expert-training";
import {
  decodeReadingTarget,
  encodeReadingTarget,
  estimateReadingSectionMinutes,
} from "@/domain/reading-target";
import { SECTION_LABELS, isPaperReservedForMock, isPaperStartableForPractice, type PaperSectionType } from "@/domain/paper";
import type { ContentOption } from "@/domain/planner";
import { formatPaperTitle, listAllReadingTargets } from "./expert-training";

/**
 * 真实真题阅读训练目标的**发现与选择**。
 *
 * ── 这个模块存在的理由 ──
 *
 * 本次收敛要求 Today 的阅读训练指向真实真题，且必须遵守既有池策略、
 * 不新建第二套试卷选择器、不消耗模考保留材料。这三条合起来意味着
 * "选哪一份材料"这件事必须有一个**单一来源**：它同时被 planner 的内容目录
 * 和 Today 的主导动作消费。
 *
 * 因此本模块只做一件事：把 `listAllReadingTargets`（既有的、唯一的
 * 可训练目标发现）过滤并排序成候选列表，供两处共用。
 * 它**不**读数据库、**不**写任何东西、**不**自己解析内容包 ——
 * 那些都已经是 `services/expert-training.ts` 与 `content/paper` 的职责。
 *
 * ── 选择规则（全部是产品规则，不含心理测量推断）──
 *
 * 1. **模考保留永远排除。** `paper.pool === "mock_reserve"` 的试卷不提供
 *    训练入口（`/practice` 页面已如此对待它们），因此更不能被计划排进来。
 *    "未触碰材料是有限资源"是 PRODUCT_PRINCIPLES 第 7 条，不是可优化项。
 * 2. **进行中的优先。** 一个已经开了没做完的大题，比一份没开始的新材料
 *    更接近"接着做完" —— 也让"继续训练"这个按钮诚实。
 * 3. **其次未开始的。** 同级内按卷次与大题顺序稳定排序。
 * 4. **已完成的最后。** 它们仍可再练（重复支持保持，见 PRODUCT_PRINCIPLES
 *    第 5 条），但排在未触碰材料之后。
 *
 * 这三条不是校准过的权重，也不需要是：它们是**次序规则**，不是分数。
 * 刻意没有"综合加权得分"这类输出 —— 那会伪造精确性（PRODUCT_PRINCIPLES 第 9 节）。
 *
 * ── 明确不做的事 ──
 *
 * - 不做第二套"真实真题阅读"的挑选逻辑：唯一的发现入口仍是
 *   `listAllReadingTargets`。
 * - 不把历史 Phase-1 的合成阅读作答当作 Expert 证据：本模块只读真实试卷与
 *   Expert 会话，完全不碰 `answer_attempt` / `Weakness` / `review_item`。
 * - 不生成任何题目：候选全部来自已导入的真实试卷包。
 */

export interface ReadingTargetCandidate {
  /** 计划任务的 `contentRef.contentId`（`paperId::sectionId`）。 */
  refId: string;
  paperId: string;
  sectionId: string;
  sectionType: TrainableReadingSection;
  /** 可读名，例如「2024 年 12 月 · 仔细阅读」。 */
  label: string;
  paperTitle: string;
  sourceKind: string;
  questionCount: number;
  /** 排练时间预算（分钟）。见 `domain/reading-target` 的 Tier D 说明。 */
  minutes: number;
  /** 该大题最近的会话状态；没练过为 null。 */
  lastRunStatus: "in_progress" | "completed" | "abandoned" | null;
  /** 为什么排它 —— 直接写进任务 rationale，让用户看得到依据。 */
  rationaleNote: string;
  /** 排序键：0 进行中 / 1 未开始 / 2 已完成。 */
  priorityRank: number;
}

/**
 * 按产品规则列出可用的真实真题阅读训练候选。
 *
 * 只在**训练池**里发现；`mock_reserve` 被硬性排除（见文件头的规则 1）。
 */
export function listReadingTargetCandidates(repos: Repositories, profileId: string): ReadingTargetCandidate[] {
  const papers = listAllReadingTargets(repos, profileId);

  const candidates: ReadingTargetCandidate[] = [];
  for (const paper of papers) {
    // 模考保留：绝不作为普通训练材料被消耗（权威谓词，不要裸比较字符串）。
    if (!isPaperStartableForPractice(paper)) continue;
    for (const target of paper.targets) {
      if (!isTrainableReadingSection(target.sectionType)) continue;
      const lastRunStatus = target.lastRun?.status ?? null;
      candidates.push({
        refId: encodeReadingTarget(paper.paperId, target.sectionId),
        paperId: paper.paperId,
        sectionId: target.sectionId,
        sectionType: target.sectionType,
        label: `${paper.paperTitle} · ${target.label}`,
        paperTitle: paper.paperTitle,
        sourceKind: paper.sourceKind,
        questionCount: target.questionCount,
        minutes: estimateReadingSectionMinutes(target.sectionType as PaperSectionType),
        lastRunStatus,
        rationaleNote: rationaleFor(lastRunStatus, target.questionCount),
        priorityRank: lastRunStatus === "in_progress" ? 0 : lastRunStatus === null ? 1 : 2,
      });
    }
  }

  // 稳定排序：优先序 → 卷次（新卷在前）→ 大题官方顺序。
  // 卷次用 paperId 降序近似（id 内嵌年份与场次，实测形如 cet6-2024-12-set1），
  // 同卷内按 sectionId 升序即官方顺序（reading.banked_cloze < careful < matching）。
  return candidates.sort((a, b) => {
    if (a.priorityRank !== b.priorityRank) return a.priorityRank - b.priorityRank;
    if (a.paperId !== b.paperId) return b.paperId.localeCompare(a.paperId);
    return a.sectionId.localeCompare(b.sectionId);
  });
}

/**
 * 理由文案。
 *
 * 它必须回答"为什么练这个"，而不是"这样能考多少分" ——
 * planner 的 rationale 只陈述安排依据，不做分数预测（产品原则第 7 节）。
 * 措辞里出现的都是**可核验的事实**（没做完 / 没练过 / 练过），不是推断。
 */
function rationaleFor(
  status: "in_progress" | "completed" | "abandoned" | null,
  questionCount: number,
): string {
  const size = `这一个部分有 ${questionCount} 题。`;
  if (status === "in_progress") {
    return `你在这一部分已经开始了、还没交卷。先做完它。${size}`;
  }
  if (status === "completed") {
    return `这一部分你练过一次。重复练习支持保持，但它的迁移价值低于未触碰的真题 —— 它会排在后面。${size}`;
  }
  return `这是还没碰过的真实真题阅读大题。${size}`;
}

/**
 * 计划任务的构造素材。
 *
 * planner 只接受 `{id, type, minutes}` 形状（它对内容一无所知，这是它可被
 * 穷举测试的前提），因此候选在这里被投影成 `ContentOption`。
 * `label` / `priorityRank` / `rationaleNote` 三个字段是本次为此新增的可选位，
 * 它们只影响可读性与排序，不改变 planner 的时间装箱语义。
 */
export function readingContentOptions(candidates: ReadingTargetCandidate[]): ContentOption[] {
  return candidates.map((candidate) => ({
    id: candidate.refId,
    type: "reading_target" as const,
    minutes: candidate.minutes,
    label: candidate.label,
    priorityRank: candidate.priorityRank,
    rationaleNote: candidate.rationaleNote,
  }));
}

// ---------------------------------------------------------------------------
// 计划任务 → 训练目标的解析
// ---------------------------------------------------------------------------

export type ReadingTaskResolution =
  /** 引用合法，且该大题当前可训练：给出规范 URL。 */
  | { kind: "ready"; paperId: string; sectionId: string; href: string; candidate: ReadingTargetCandidate }
  /** 引用合法，但当前不可训练（模考保留 / 内容包不可用 / 大题不在包里）。必须如实说明。 */
  | { kind: "unavailable"; reason: string }
  /** 引用不是阅读目标（写作 / 翻译 / 复习 / 词汇任务）。 */
  | { kind: "not_reading" };

/**
 * 把一个计划任务的引用解析成"点它会去哪"。
 *
 * ── 为什么"不可用"必须与"没有内容"分开 ──
 *
 * 旧实现里，内容缺失时的反应是 `unavailableReason`，而阅读任务的缺失
 * 曾经由"内容库里没有这一条"来表达。收敛之后情况完全不同：
 * 这道题的正文在私有真题包里，它可能因为**用户把卷子设为模考保留**、
 * 或者**内容包被移走/校验失败**而不可用。
 *
 * 这三种原因对用户是不同的事，且都**不允许**回退到合成材料 ——
 * 产品规则明确要求"没有合适的真实材料时给出如实不可用状态，
 * 而不是退回合成的 CET 风格题目"。
 *
 * 因此本函数不返回任何 fallback URL：`unavailable` 就是不可用，
 * 由界面如实呈现并给出恢复路径。
 */
export function resolveReadingTask(
  repos: Repositories,
  profileId: string,
  refId: string,
): ReadingTaskResolution {
  const decoded = decodeReadingTarget(refId);
  if (!decoded) {
    return {
      kind: "unavailable",
      reason:
        "这条阅读任务的引用格式无法解析，因此不能进入训练。返回 Today 让计划重新生成即可。",
    };
  }

  const candidates = listReadingTargetCandidates(repos, profileId);
  const candidate = candidates.find((item) => item.refId === refId);
  if (candidate) {
    return {
      kind: "ready",
      paperId: candidate.paperId,
      sectionId: candidate.sectionId,
      href: `/practice/papers/${encodeURIComponent(candidate.paperId)}/train/${encodeURIComponent(candidate.sectionId)}`,
      candidate,
    };
  }

  // 不在候选里 → 找出**具体**原因，而不是笼统说"不可用"。
  // 顺序即诊断顺序：先问"这份卷子还在不在"，再问"它为什么不被推荐"。
  const papers = listAllReadingTargets(repos, profileId);
  const paper = papers.find((item) => item.paperId === decoded.paperId);

  if (!paper) {
    return {
      kind: "unavailable",
      reason:
        "这条任务引用的试卷已不在真题库里（内容包可能被移除或索引已重建）。" +
        "产品不会用自造题目顶替它 —— 请回到 Today 让计划重新生成。",
    };
  }

  if (isPaperReservedForMock(paper)) {
    return {
      kind: "unavailable",
      reason:
        `这份试卷（${paper.paperTitle}）已被设为「模考保留」，因此不作为日常训练材料。` +
        "刻意留住没做过的真题，后面才能用真正没见过的卷子做模考。" +
        "想现在练它，请先到真题库把它移出模考保留。",
    };
  }

  const target = paper.targets.find((item) => item.sectionId === decoded.sectionId);
  if (!target) {
    return {
      kind: "unavailable",
      reason:
        "这份试卷当前的版本里没有这个阅读大题（内容可能已升版）。" +
        "产品不会用旧题面凑一个新的 —— 请回到 Today 让计划重新生成。",
    };
  }

  return {
    kind: "unavailable",
    reason: "这条阅读任务当前不可用。请回到 Today 让计划重新生成。",
  };
}

/** 该任务是否是一条阅读训练任务（决定它走哪条执行路径）。 */
export function isReadingTargetRef(contentType: string | undefined): contentType is "reading_target" {
  return contentType === "reading_target";
}

// ---------------------------------------------------------------------------
// 计划任务 → canonical 真实真题目标（Today 与旧执行器共用的唯一投影）
// ---------------------------------------------------------------------------

export type ReadingTaskProjection =
  /** 已收敛到某个真实真题阅读大题：给出 canonical 目标与 URL。 */
  | { kind: "converged"; candidate: ReadingTargetCandidate; href: string }
  /** 这是阅读任务，但当前没有可用的真实真题目标。必须如实说明，绝不回退合成内容。 */
  | { kind: "unavailable"; reason: string }
  /**
   * **历史事实**：一条在旧合成体系下**已经完成**的阅读任务。
   *
   * 它不收敛、不重包装、不给 canonical 目标 —— 见下方长注释。
   */
  | { kind: "historical_completed" }
  /** 不是阅读任务（写作 / 翻译 / 复习 / 词汇）。 */
  | { kind: "not_reading" };

/**
 * 把一条**阅读类**计划任务投影成 canonical 真实真题目标。
 *
 * ── 为什么需要它，以及为什么必须只有一份实现 ──
 *
 * 收敛之后，学习者看到的阅读训练只有一种东西：真实真题的某个阅读大题。
 * 但**历史计划行**不会因此消失 —— 一条几天前生成、今天仍 pending 的合成阅读
 * 任务（`reading_passage / read-city-trees`）会出现在 Today 的「下一步」或
 * 「补做」区里。它的 `title` 写着「阅读训练 12 分钟」、时长 12 分钟，
 * 而点下去实际会落在某个真实真题大题上。
 *
 * 如果 Today 直接渲染历史行，学习者看到的就是一条**不真实的** CTA：
 * 它没说清目的地是真题，它的分钟数属于早已作废的合成素材语义，
 * 而"到底会去哪"要等点击之后才知道。正确做法是：
 *
 *   **在渲染之前就把历史任务投影成当前 canonical 目标，
 *     用真实目标的卷次、大题名与排练预算来展示。**
 *
 * ── 但"收敛"只适用于**还没发生的事**（status 是关键判据）──
 *
 * 上面那套推理的前提是：这条任务**还没有完成**，因此把它指向真实真题
 * 是"兑现用户意图"。
 *
 * **已完成**的合成阅读任务是另一回事：它是一件**已经发生过的历史事实** ——
 * 当时用户在旧体系下真的做了一份合成阅读题并完成了它。
 * 它**没有**做过任何真题。若把它的引用投影成 `reading_target`，
 * 界面就会显示「真实真题阅读训练 · 2024 年 12 月 · 选仔细阅读」，
 * 而那条记录根本不是真题训练 —— 那是**伪造 provenance**，
 * 直接违反「不得把旧合成证据提升为 Expert 语义」。
 *
 * 因此判据必须是 **status + 引用类型**，而不是任务标题之类的字符串：
 *
 * | status | 引用类型 | 处置 |
 * | --- | --- | --- |
 * | `completed` | 合成 `reading_passage` | **历史事实**：原样保留，不收敛、不重包装 |
 * | `pending` / `in_progress` | 合成 `reading_passage` | 收敛到当前真实目标 |
 * | 任意 | 真实 `reading_target` | 保持真实真题语义（含已完成） |
 *
 * 最后一行同样重要：**已完成的真实真题任务不能被"
 * ' 反向压扁成非真题**（"completed 就永不投影"是过宽的规则）。
 *
 * 历史 DB 行**一个字节都不改**——
 * 投影只发生在面向学习者的这一层。
 *
 * 旧执行器（`/practice/[taskId]`）的重定向判断也用同一个函数，
 * 因此"Today 说会去哪"与"点下去真的去哪"在原理上不可能不一致，
 * 且**已完成的历史合成任务在两条路径上都不会被伪装成真题**。
 */
export function projectReadingTask(
  repos: Repositories,
  profileId: string,
  task: {
    kind: string;
    status: string;
    contentRef: { contentType: string; contentId: string } | null;
  },
): ReadingTaskProjection {
  // 只处理阅读训练。写作 / 翻译 / 复习 / 词汇在本次收敛中刻意保持原样。
  if (task.kind !== "reading_comprehension") return { kind: "not_reading" };

  // 1) 任务自己带真实目标引用：以它为准（它是当时被明确选中的那一个大题）
  const ownRef = isReadingTargetRef(task.contentRef?.contentType)
    ? task.contentRef!.contentId
    : null;
  if (ownRef) {
    const resolution = resolveReadingTask(repos, profileId, ownRef);
    if (resolution.kind === "ready") {
      return { kind: "converged", candidate: resolution.candidate, href: resolution.href };
    }
    if (resolution.kind === "unavailable") {
      return { kind: "unavailable", reason: resolution.reason };
    }
  }

  /*
   * 2) 引用是**旧的合成篇章**（或引用缺失）。
   *
   * 如果这条任务**已经完成**，它就是一件历史事实，不收敛、不重包装 ——
   * 见函数头的表格。判据用 status，不是标题字符串。
   */
  if (task.status === "completed") {
    return { kind: "historical_completed" };
  }

  /*
   * 3) 未完成的历史合成引用：把它投影到**当前**可用的第一个真实目标。
   *
   * 为什么这是诚实的：用户意图是"练阅读"，而产品规则规定阅读训练只用真实真题。
   * 因此把他送到当前可用的真实大题上，是兑现意图的唯一方式 ——
   * 既不渲染合成篇章，也不用旧题面凑一个。
   *
   * 选哪一条由 `listReadingTargetCandidates` 决定（进行中 > 未开始 > 已完成，
   * 且已排除模考保留），与 planner 排新任务时用的是**同一套规则**。
   */
  const candidate = listReadingTargetCandidates(repos, profileId)[0];
  if (candidate) {
    return {
      kind: "converged",
      candidate,
      href: `/practice/papers/${encodeURIComponent(candidate.paperId)}/train/${encodeURIComponent(candidate.sectionId)}`,
    };
  }

  return { kind: "unavailable", reason: explainNoReadingTarget(repos, profileId) };
}

/**
 * canonical 目标的**结构化身份**，用于判断两个入口是否指向同一个地方。
 *
 * ── 为什么不能比字符串 ──
 *
 * 比较 href 字符串看起来够用，但它把"同一个目标"这件事绑在了 URL 的书写形式上：
 * 编码、查询串、尾斜杠、大小写任何一处变化都会让同一个目标被判定为不同，
 * 于是重复入口悄悄回来。身份来自**领域标识**（试卷 id + 大题 id），
 * 与 URL 怎么写无关。
 */
export function canonicalTargetKey(target: { paperId: string; sectionId: string }): string {
  return encodeReadingTarget(target.paperId, target.sectionId);
}

/**
 * 当前 Today 的「随时可做」入口应该指向哪个真实真题目标。
 *
 * ── 与列表页的区别（这条决定了它必须独立存在）──
 *
 * `listAllReadingTargets` 用于**浏览**：它列出库里全部可训练大题，含模考保留的
 * （列表页需要展示它们并说明为什么不给训练入口）。
 *
 * 而 Today 的这个入口是**直接开始训练**的动作，因此必须遵守同一条候选规则：
 * **模考保留绝不出现在这里。** 早先它直接用了 `listAllReadingTargets`，
 * 于是把模考保留的卷子也当成了"随时可做" —— 那会消耗刻意留下的未触碰材料
 * （PRODUCT_PRINCIPLES 第 7 条）。
 *
 * 现在它复用 `listReadingTargetCandidates`：与 planner 排新任务、
 * 与旧执行器解析历史任务用的是**同一套**候选与排序规则。
 */
export function firstAvailableReadingTarget(
  repos: Repositories,
  profileId: string,
): ReadingTargetCandidate | null {
  return listReadingTargetCandidates(repos, profileId)[0] ?? null;
}

/**
 * "为什么现在没有可用的阅读训练材料"。
 *
 * ── 为什么需要这个诊断，而不是一句笼统的"暂无内容" ──
 *
 * 三种原因对用户是**完全不同的事**，且出路完全不同：
 *
 * - **库里根本没有真题** → 去导入（他需要的是内容）。
 * - **有卷子但全被设为模考保留** → 去移出保留（他需要的是策略调整）。
 *   这是最容易误伤的情形：材料明明就在库里，界面上却什么都没有，
 *   用户会以为产品坏了。
 * - **卷子内容不可用**（包缺失 / 校验失败）→ 去修内容包。
 *
 * 把这些混成一句"暂无可用内容"，就是把系统的工作推给用户（产品原则第 13 条）。
 * planner 决定"排不排阅读任务"时用的是同一条规则，因此两处必须给出
 * 互不矛盾的说明。
 */
export function explainNoReadingTarget(
  repos: Repositories,
  profileId: string,
): string {
  const all = listAllReadingTargets(repos, profileId);
  const trainable = all.filter(
    (paper) => isPaperStartableForPractice(paper) && paper.targets.length > 0,
  );
  if (trainable.length > 0) {
    // 理论不可达：调用方只在"没有候选"时才问，而候选来自 trainable。
    // 保留这条分支是为了让函数在任何输入下都给出可读说明，而不是空字符串。
    return "当前有可训练的阅读大题，请刷新页面重试。";
  }

  if (all.length === 0) {
    return (
      "真题库里还没有可训练的阅读大题。阅读训练只使用真实历年真题，" +
      "产品不会用自造题目顶替 —— 请先导入真题包（见真题库页面的导入说明），" +
      "然后回到 Today 让计划重新生成。"
    );
  }

  const reserved = all.filter((paper) => isPaperReservedForMock(paper));
  if (reserved.length === all.length) {
    return (
      `库里的 ${reserved.length} 份试卷当前都被设为「模考保留」，因此不作为日常训练材料。` +
      "刻意留住没做过的真题，后面才能用真正没见过的卷子做模考 —— " +
      "想现在练，请到真题库把其中一份移出模考保留，然后回到 Today 让计划重新生成。"
    );
  }

  return (
    "库里有试卷，但当前没有解析出可训练的阅读大题（内容包可能缺失或校验失败）。" +
    "请到真题库确认内容包状态，然后回到 Today 让计划重新生成。"
  );
}

export { formatPaperTitle, SECTION_LABELS };
