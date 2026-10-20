import { diffDays, isWeekendISO } from "@/lib/date";
import type { Recommendation, ReviewItem, SkillProfile, StudyTask, TaskContentRef } from "./models";
import {
  PRIORITY_ORDER,
  SKILL_LABELS,
  SKILL_WEIGHTS,
  type ISODate,
  type Skill,
  type TaskContentType,
  type TaskKind,
  type TaskPriority,
} from "./types";

/**
 * 确定性每日计划生成器。
 *
 * 约束：
 * - 纯函数。相同输入必须产出相同输出（时间与内容目录都由参数注入，不读系统时钟、不访问数据库）。
 * - 不依赖 React / 数据库 / AI。这是产品在最坏情况下仍然可用的底线。
 * - 不预测分数。rationale 只陈述"为什么安排这个"，不陈述"这样能考多少分"。
 *
 * 关键设计（这一条是实测后重构的）：
 * 任务时长**来自实际内容素材的时长**，而不是把分钟预算直接当成任务时长。
 * 早先的实现把"阅读预算 60 分钟"直接渲染成"阅读训练 60 分钟"，而绑定的素材
 * 只有 12 分钟——任务时长与内容不符，用户在 12 分钟后不知道该做什么。
 * 现在改为：预算决定**安排几项内容**，任务时长等于内容自身时长，
 * 且只安排能在今天时间内完成的内容。
 */

/**
 * 从内容目录取素材的接口。由 service 层从内容库构造，planner 本身不依赖内容库。
 *
 * `label` 与 `priorityRank` 是给**真实真题阅读目标**（`reading_target`）用的：
 * 前者的 id 是一个编码引用，本身不可读；后者表达"继续未完成的训练优先于
 * 开始新的"。两者都是可选，因此既有内容库素材的构造方式完全不受影响。
 */
export interface ContentOption {
  id: string;
  type: TaskContentType;
  minutes: number;
  /** 可读的素材名（目前只有 `reading_target` 需要：它的 id 是编码引用）。 */
  label?: string;
  /**
   * 候选间的优先序：数值小者优先。
   *
   * 缺省视为最不优先。**它会压过同模块内的日期轮换** ——
   * 轮换的目的是让"同一优先级里的材料跨天变化"，而不是让一条
   * 已完成的材料盖过未完成的材料。
   */
  priorityRank?: number;
  /**
   * 为什么排这一条（由 service 层构造，planner 只负责拼接）。
   *
   * 存在这个字段，是因为"为什么是这份真题"只有 service 层知道 ——
   * 它掌握着"这份卷子练到哪了""它属于训练池还是模考保留"这些事实，
   * 而 planner 对内容一无所知（这是它可被穷举测试的前提）。
   */
  rationaleNote?: string;
}

export type ContentCatalog = Partial<Record<Skill, ContentOption[]>>;

export interface PlannerInput {
  today: ISODate;
  examDate: ISODate;
  targetScore: number;
  availableMinutes: number;
  profile: SkillProfile | null;
  dueReviewItems: ReviewItem[];
  /** 之前安排了但未完成的核心任务，需要补做 */
  outstandingTasks: StudyTask[];
  /** 最近 7 天已完成任务所属模块，用于轮换 */
  recentCompletedSkills: Skill[];
  /**
   * 当前真正可执行的模块。听力占卷面 35%，但 Phase 1 没有音频素材；
   * 不告知这一点，planner 每天都会排一个永远点不开的听力任务。
   */
  executableSkills?: Skill[];
  /** 各模块可用的内容素材。缺失即视为该模块没有可执行内容。 */
  contentCatalog?: ContentCatalog;
}

export interface PlannedTask {
  kind: TaskKind;
  skill: Skill;
  priority: TaskPriority;
  title: string;
  rationale: string;
  estimatedMinutes: number;
  contentRef: TaskContentRef | null;
  /** 复习任务需要携带队列大小 */
  reviewItemCount?: number;
}

export interface PlannerOutput {
  tasks: PlannedTask[];
  plannedMinutes: number;
  deferredMinutes: number;
  notes: string[];
  warnings: string[];
}

/** 低于这个时长不值得安排。 */
const MIN_TASK_MINUTES = 5;
/** 时间紧张时切换到短日模式的阈值。 */
const SHORT_DAY_THRESHOLD = 30;
/** 单个模块一天最多安排几项内容，避免 Today 被同一模块刷屏。 */
const MAX_BLOCKS_PER_SKILL = 2;
/** 复习任务的最长时长，防止复习吞掉一天。 */
const MAX_REVIEW_MINUTES = 15;
/** 每项复习内容的估算分钟数。 */
const REVIEW_MINUTES_PER_ITEM = 3;

export function daysUntil(today: ISODate, examDate: ISODate): number {
  // 复用 lib/date 的时区无关实现：纯日期差的语义必须与"今天"的本地时区定义分离，
  // 否则同一对日期在不同机器时区会得出相差 1 天的结果。
  return diffDays(today, examDate);
}

export function isWeekend(date: ISODate): boolean {
  return isWeekendISO(date);
}

/**
 * 依据能力画像决定各模块的训练分钟预算。
 *
 * 若传入 executableSkills，被排除模块的预算按比例转给可执行模块，
 * 保证"计划里的每一项都真的能开始"，且可训练总量不因缺素材而缩水。
 */
export function allocateMinutes(
  totalMinutes: number,
  recommendations: Recommendation[] | null,
  executableSkills?: Skill[],
): Record<Skill, number> {
  const budget = { listening: 0, reading: 0, writing: 0, translation: 0 } as Record<Skill, number>;
  const allSkills = Object.keys(SKILL_WEIGHTS) as Skill[];
  const executable = executableSkills && executableSkills.length > 0 ? executableSkills : allSkills;

  const weights = new Map<Skill, number>();
  if (recommendations && recommendations.length > 0) {
    for (const rec of recommendations) weights.set(rec.skill, rec.weight);
  } else {
    for (const skill of allSkills) weights.set(skill, SKILL_WEIGHTS[skill]);
  }

  // 只保留可执行模块的权重，并按比例放大回原始总和
  const executableWeight = executable.reduce((sum, skill) => sum + (weights.get(skill) ?? 0), 0);
  const totalWeight = [...weights.values()].reduce((a, b) => a + b, 0) || 1;
  const scale = executableWeight > 0 ? totalWeight / executableWeight : 0;

  for (const skill of allSkills) {
    if (!executable.includes(skill)) continue;
    budget[skill] = Math.round((weights.get(skill) ?? 0) * scale * totalMinutes);
  }

  // 四舍五入的差额补给权重最高的可执行模块
  const allocated = executable.reduce((sum, skill) => sum + budget[skill], 0);
  const drift = totalMinutes - allocated;
  if (drift !== 0 && executable.length > 0) {
    const heaviest = [...executable].sort((a, b) => (weights.get(b) ?? 0) - (weights.get(a) ?? 0))[0];
    budget[heaviest] = Math.max(0, budget[heaviest] + drift);
  }

  return budget;
}

/** 主题材时长低于此值时不做短日裁剪。 */

/**
 * 每个模块用于"技能训练"的主题材类型。
 *
 * 为什么需要这个映射：阅读模块的候选里同时有阅读题和词汇组，
 * 但两者是不同的训练活动 —— 词汇组属于可选的加分项，不该占用阅读预算，
 * 否则"词汇巩固"这个可选槽位永远拿不到素材（阅读块会先把它消耗掉）。
 */
const PRIMARY_CONTENT_TYPE: Record<Skill, TaskContentType> = {
  /**
   * 阅读的主题材是**真实真题的阅读大题**，不是内容库里的合成篇章。
   *
   * 这条是本次收敛的核心：在它改成 `reading_target` 之前，planner 会把
   * `practice-library.ts` 的合成阅读篇章排进 Today，学习者点进去落在旧执行器里，
   * 走旧的 Phase-1 闭环。产品规则要求面向学习者的阅读训练只有一条路径
   * （真实真题 → Expert Training → Expert 台账），因此目录侧必须切断这条来源。
   */
  reading: "reading_target",
  writing: "writing_prompt",
  translation: "translation_prompt",
  listening: "listening_pending",
};

interface SelectedBlock {
  skill: Skill;
  option: ContentOption;
}

/**
 * 按"缺口最大者优先"挑选内容，而不是按固定份额切分。
 *
 * 为什么要这样（实测后重构）：
 * 早先按 allocateMinutes 给每个模块固定的分钟预算，然后只挑放得进预算的内容。
 * 结果是写作（素材 25 分钟）在工作日 60 分钟下永远拿不到 20 分钟的预算 ——
 * 写作占卷面 15%，却一次也排不上，计划在结构上放弃了它。
 *
 * 现在改为缺口驱动：每个模块有一个目标分钟数，每轮把下一条内容给"当前最落后于目标"
 * 的模块。素材粒度粗于预算也没关系 —— 落后的模块会自然拿到机会，
 * 同时总量仍被 available 严格约束，不会超时。
 */
function selectBlocksByDeficit(
  available: number,
  targets: Record<Skill, number>,
  catalog: ContentCatalog,
  executable: Skill[],
  daySeed: number,
): SelectedBlock[] {
  // 只保留主题材、且单项放得进今天时间的候选
  const pools = new Map<Skill, ContentOption[]>();
  for (const skill of executable) {
    const primaryType = PRIMARY_CONTENT_TYPE[skill];
    const options = (catalog[skill] ?? []).filter(
      (option) => option.type === primaryType && option.minutes <= available,
    );
    if (options.length === 0) continue;
    // 候选顺序 = 显式优先序 → 同序内按日期种子确定性轮换。
    //
    // 为什么要分两步而不是"整体按种子轮换"：真实真题阅读用它表达
    // "继续没做完的训练优先于开始一份新的"。若把优先序和轮换混在一起，
    // 一个未完成的大题会在某些日期被轮换到已练过的大题之后 ——
    // 那正是这条优先序要防的事。分组后组内轮换，两个意图互不干扰。
    const sorted = [...options].sort((a, b) => {
      const rank =
        (a.priorityRank ?? Number.MAX_SAFE_INTEGER) - (b.priorityRank ?? Number.MAX_SAFE_INTEGER);
      return rank !== 0 ? rank : a.id.localeCompare(b.id);
    });
    const buckets = new Map<number, ContentOption[]>();
    for (const option of sorted) {
      const rank = option.priorityRank ?? Number.MAX_SAFE_INTEGER;
      const bucket = buckets.get(rank) ?? [];
      bucket.push(option);
      buckets.set(rank, bucket);
    }
    const rotated = [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .flatMap(([, bucket]) => {
        const offset = daySeed % bucket.length;
        return bucket.map((_, i) => bucket[(offset + i) % bucket.length]);
      });
    pools.set(skill, rotated);
  }

  // 稳定顺序：目标高的优先，相同则按模块名，保证输出确定
  const ordered = [...pools.keys()].sort((a, b) => {
    const diff = (targets[b] ?? 0) - (targets[a] ?? 0);
    return diff !== 0 ? diff : a.localeCompare(b);
  });

  const allocated = new Map<Skill, number>();
  const counts = new Map<Skill, number>();
  const usedIds = new Set<string>();
  const chosen: SelectedBlock[] = [];
  let remaining = available;

  for (;;) {
    let bestSkill: Skill | null = null;
    let bestDeficit = Number.NEGATIVE_INFINITY;
    let bestOption: ContentOption | null = null;

    for (const skill of ordered) {
      if ((counts.get(skill) ?? 0) >= MAX_BLOCKS_PER_SKILL) continue;
      const option = pools.get(skill)!.find(
        (candidate) => !usedIds.has(candidate.id) && candidate.minutes <= remaining,
      );
      if (!option) continue;
      const deficit = (targets[skill] ?? 0) - (allocated.get(skill) ?? 0);
      if (deficit > bestDeficit) {
        bestDeficit = deficit;
        bestSkill = skill;
        bestOption = option;
      }
    }

    if (bestSkill === null || bestOption === null) break;
    // 所有模块都已达标就不再继续塞内容，避免为填满时间而安排低价值训练
    if (bestDeficit <= 0 && chosen.length > 0) break;

    chosen.push({ skill: bestSkill, option: bestOption });
    usedIds.add(bestOption.id);
    allocated.set(bestSkill, (allocated.get(bestSkill) ?? 0) + bestOption.minutes);
    counts.set(bestSkill, (counts.get(bestSkill) ?? 0) + 1);
    remaining -= bestOption.minutes;
  }

  return chosen;
}

/**
 * 主入口。规则顺序即优先级顺序：
 * 1. 复习项 —— 遗忘曲线不等人，永远优先。
 * 2. 补做逾期核心任务 —— 承诺过的核心训练不能被静默丢弃。
 * 3. 按诊断权重的技能训练 —— 阅读/写作/翻译为主得分区。
 * 4. 可选加分项 —— 只在时间有富余时出现。
 */
export function planDay(input: PlannerInput): PlannerOutput {
  const warnings: string[] = [];
  const notes: string[] = [];
  const remaining = daysUntil(input.today, input.examDate);
  const available = Math.max(0, input.availableMinutes);

  notes.push(`距考试 ${Math.max(remaining, 0)} 天。`);
  if (remaining < 0) {
    warnings.push("目标考试日期已过，请到 Settings 更新考试日期。");
  }

  const allSkills = Object.keys(SKILL_WEIGHTS) as Skill[];
  const executable =
    input.executableSkills && input.executableSkills.length > 0 ? input.executableSkills : allSkills;
  const excluded = allSkills.filter((skill) => !executable.includes(skill));
  const catalog: ContentCatalog = input.contentCatalog ?? {};

  if (excluded.length > 0) {
    notes.push(
      `${excluded.map((s) => SKILL_LABELS[s]).join("、")}当前没有可执行的内容素材，` +
        `相应时间已转给可训练的模块，而不是排成点不开的任务。`,
    );
  }

  const candidates: PlannedTask[] = [];
  /** 显式排序阶梯：复习 → 补做 → 技能训练 → 加分项。同一个阶梯内按时长降序。 */
  const tiers = new Map<PlannedTask, number>();
  const push = (task: PlannedTask, tier: number) => {
    candidates.push(task);
    tiers.set(task, tier);
  };
  const usedContentIds = new Set<string>();

  // 复习优先
  const dueCount = input.dueReviewItems.length;
  if (dueCount > 0) {
    const minutes = Math.max(MIN_TASK_MINUTES, Math.min(dueCount * REVIEW_MINUTES_PER_ITEM, MAX_REVIEW_MINUTES));
    push(
      {
        kind: "review",
        skill: input.dueReviewItems[0].skill,
        priority: "core",
        title: `复习待巩固内容（${dueCount} 项）`,
        rationale: `有 ${dueCount} 项内容进入遗忘窗口。复习排在最前面，因为遗忘的代价高于新学。`,
        estimatedMinutes: minutes,
        contentRef: { contentType: "review_deck", contentId: `due-${input.today}` },
        reviewItemCount: dueCount,
      },
      0,
    );
  }

  // 2) 补做逾期核心任务：沿用原时长，不重算
  for (const task of input.outstandingTasks) {
    push(
      {
        kind: task.kind,
        skill: task.skill,
        priority: "core",
        title: `补做：${task.title}`,
        rationale: "这是之前安排了但没有完成的核心训练，优先补上而不是重新排新内容。",
        estimatedMinutes: task.estimatedMinutes,
        contentRef: task.contentRef,
      },
      1,
    );
    if (task.contentRef) usedContentIds.add(task.contentRef.contentId);
  }

  // 3) 技能训练：按"缺口最大者优先"挑选内容
  const targets = allocateMinutes(available, input.profile?.recommendations ?? null, input.executableSkills);
  const evidenceBacked = (input.profile?.recommendations?.length ?? 0) > 0;
  const baseRationale = evidenceBacked
    ? "训练占比来自你的诊断结果。"
    : "还没有诊断结果，先按 CET-6 官方分值权重建立基线。";
  const daySeed = Number(input.today.replace(/-/g, ""));

  // 已经排进补做任务的素材不再重复安排
  const forSelection: ContentCatalog = {};
  for (const skill of executable) {
    forSelection[skill] = (catalog[skill] ?? []).filter((option) => !usedContentIds.has(option.id));
  }

  const blocks = selectBlocksByDeficit(available, targets, forSelection, executable, daySeed);
  const skippedForTime: string[] = [];

  for (const skill of executable) {
    if (blocks.some((b) => b.skill === skill)) continue;
    const options = (catalog[skill] ?? []).filter((o) => o.type === PRIMARY_CONTENT_TYPE[skill]);
    if (options.length === 0) {
      continue;
    }
    const shortest = [...options].sort((a, b) => a.minutes - b.minutes)[0];
    if (shortest.minutes > available) {
      skippedForTime.push(`${SKILL_LABELS[skill]}（单项需要 ${shortest.minutes} 分钟）`);
    }
  }

  for (const block of blocks) {
    const rec = input.profile?.recommendations?.find((r) => r.skill === block.skill);
    const priority: TaskPriority =
      rec?.priority ?? (SKILL_WEIGHTS[block.skill] >= 0.35 ? "core" : "recommended");
    const repeatedRecently = input.recentCompletedSkills.includes(block.skill);
    const index = blocks.filter((b) => b.skill === block.skill).indexOf(block);

    push(
      {
        kind: kindForContent(block.option.type, block.skill),
        skill: block.skill,
        priority,
        title: titleForContent(block.option, block.skill, index),
        rationale:
          `${baseRationale}${rec ? ` ${rec.reason}` : ""}` +
          `${repeatedRecently && index === 0 ? " 近几天已练过该模块，今天减少一项以轮换到其他模块。" : ""}` +
          `${block.option.rationaleNote ? ` ${block.option.rationaleNote}` : ""}`,
        estimatedMinutes: block.option.minutes,
        contentRef: { contentType: block.option.type, contentId: block.option.id },
      },
      2,
    );
  }

  if (skippedForTime.length > 0) {
    warnings.push(
      `今天时间不够，以下内容未安排：${skippedForTime.join("、")}。把时间调高会重新排进来。`,
    );
  }

  // 保证至少有一个 core 任务：短日必须至少有一件可以开始的事
  if (candidates.length > 0 && !candidates.some((c) => c.priority === "core")) {
    candidates[0] = {
      ...candidates[0],
      priority: "core",
      rationale: `${candidates[0].rationale} 今天时间有限，这是最优先的一项。`,
    };
  }

  // 短日收窄：只做核心内容。
  // 理由：时间只有 20 分钟时，把时间花在"推荐"项上意味着核心内容被挤掉。
  // 如果连一个 core 都排不进来，就把唯一放得下的那项提为 core ——
  // 这是"只能做这一件事"，而不是把推荐项谎称成核心项。
  if (available > 0 && available <= SHORT_DAY_THRESHOLD) {
    const coreOnly = candidates.filter((c) => c.priority === "core");
    if (coreOnly.length > 0) {
      candidates.length = 0;
      candidates.push(...coreOnly);
    } else if (candidates.length > 1) {
      const smallest = [...candidates].sort((a, b) => a.estimatedMinutes - b.estimatedMinutes)[0];
      candidates.length = 0;
      candidates.push({ ...smallest, priority: "core" });
    }
  }

  // 4) 可选加分项：仅在时间有富余时
  const reserved = candidates.reduce((sum, c) => sum + c.estimatedMinutes, 0);
  const slack = available - reserved;
  if (slack >= 10 && available > 60) {
    // 词汇素材已可能被当作阅读内容排进去，因此这里按类型从整个目录里找，
    // 而不是只看 catalog.reading —— 否则词汇加分项永远拿不到名额。
    const vocab = Object.values(catalog)
      .flat()
      .find(
        (option) =>
          option.type === "vocabulary_set" &&
          option.minutes <= slack &&
          !usedContentIds.has(option.id),
      );
    if (vocab) {
      usedContentIds.add(vocab.id);
      push(
        {
          kind: "vocabulary_recall",
          skill: "reading",
          priority: "optional",
          title: `词汇巩固：${vocab.minutes} 分钟`,
          rationale: "今天的核心任务已排完且仍有富余时间，加一轮词汇巩固。时间不够时可以直接跳过。",
          estimatedMinutes: vocab.minutes,
          contentRef: { contentType: vocab.type, contentId: vocab.id },
        },
        3,
      );
    }
  }

  candidates.sort((a, b) => {
    const tierDiff = (tiers.get(a) ?? 2) - (tiers.get(b) ?? 2);
    if (tierDiff !== 0) return tierDiff;
    const byPriority = PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (byPriority !== 0) return byPriority;
    return b.estimatedMinutes - a.estimatedMinutes;
  });

  // 贪心装箱：只放得下的，绝不裁剪任务时长
  // （裁剪会产生"任务说 10 分钟但内容要 25 分钟"的谎报）
  const kept: PlannedTask[] = [];
  let used = 0;
  let deferred = 0;

  for (const candidate of candidates) {
    if (used + candidate.estimatedMinutes <= available) {
      kept.push(candidate);
      used += candidate.estimatedMinutes;
    } else {
      deferred += candidate.estimatedMinutes;
    }
  }

  if (available > 0 && available <= SHORT_DAY_THRESHOLD) {
    warnings.push(
      `今天只有 ${available} 分钟，已切换为短日模式：只保留放得下的内容，其余顺延。`,
    );
  } else if (deferred > 0) {
    warnings.push(`今天时间偏少，约 ${deferred} 分钟的内容已顺延。`);
  }

  if (kept.length === 0) {
    warnings.push("今天没有可安排的时间或内容。计划保持为空，这不是失败 —— 明天会按同样的规则重新生成。");
  }

  return {
    tasks: kept,
    plannedMinutes: used,
    deferredMinutes: deferred,
    notes,
    warnings,
  };
}

function kindForSkill(skill: Skill): TaskKind {
  switch (skill) {
    case "listening":
      return "listening_comprehension";
    case "reading":
      return "reading_comprehension";
    case "writing":
      return "writing_drill";
    case "translation":
      return "translation_drill";
  }
}

/**
 * 题型由**素材类型**决定，而不是由所属模块决定。
 * 原因：词汇组也服务阅读能力，但它是词汇训练 ——
 * 若按模块命名，用户会看到"阅读训练"点进去却是单词填空。
 */
function kindForContent(type: TaskContentType, skill: Skill): TaskKind {
  switch (type) {
    case "vocabulary_set":
      return "vocabulary_recall";
    case "listening_pending":
      return "listening_comprehension";
    // 真实真题阅读大题与内容库的阅读篇章都归为阅读训练任务
    case "reading_target":
      return "reading_comprehension";
    default:
      return kindForSkill(skill);
  }
}

/** 任务标题同样按素材类型命名，保证标题与点进去的内容一致。 */
function titleForContent(option: ContentOption, skill: Skill, index: number): string {
  const suffix = index > 0 ? "（第二项）" : "";
  switch (option.type) {
    case "vocabulary_set":
      return `词汇训练 ${option.minutes} 分钟${suffix}`;
    case "reading_passage":
      return `阅读训练 ${option.minutes} 分钟${suffix}`;
    /**
     * 真实真题阅读大题。
     *
     * 措辞刻意写成「真实真题阅读训练」并把**卷次与大题名**放进标题：
     * 学习者必须一眼看出这条通往的是真实真题，而不是产品自造的材料 ——
     * 这正是本次收敛要让界面说清的事（合成材料不得冒充真题）。
     */
    case "reading_target":
      return `真实真题阅读训练 · ${option.label ?? "阅读大题"}${suffix}`;
    case "writing_prompt":
      return `写作训练 ${option.minutes} 分钟${suffix}`;
    case "translation_prompt":
      return `翻译训练 ${option.minutes} 分钟${suffix}`;
    case "listening_pending":
      return `听力训练 ${option.minutes} 分钟${suffix}`;
    default:
      return titleForSkill(skill, option.minutes, index);
  }
}

function titleForSkill(skill: Skill, minutes: number, index: number): string {
  const suffix = index > 0 ? "（第二篇）" : "";
  switch (skill) {
    case "listening":
      return `听力训练 ${minutes} 分钟${suffix}`;
    case "reading":
      return `阅读训练 ${minutes} 分钟${suffix}`;
    case "writing":
      return `写作训练 ${minutes} 分钟${suffix}`;
    case "translation":
      return `翻译训练 ${minutes} 分钟${suffix}`;
  }
}

export function summarizeBudget(tasks: StudyTask[] | PlannedTask[]): string {
  const bySkill = new Map<Skill, number>();
  for (const task of tasks) {
    bySkill.set(task.skill, (bySkill.get(task.skill) ?? 0) + task.estimatedMinutes);
  }
  return [...bySkill.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([skill, minutes]) => `${SKILL_LABELS[skill]} ${minutes}min`)
    .join(" · ");
}
