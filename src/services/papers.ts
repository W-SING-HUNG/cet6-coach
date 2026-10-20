import type { Repositories } from "@/repositories/ports";
import {
  createPaperCatalog,
  contentRootDisplayLabel,
  papersDirDisplayLabel,
  type PaperDetail,
  type PaperRepositoryBoundary,
  type PaperSummary,
} from "@/content/paper";
import type { PaperPool } from "@/domain/paper";
import type { PaperFreshness } from "@/domain/paper-freshness";
import {
  getPaperFreshnessIndex,
  summarizePaperFreshness,
  type PaperFreshnessIndex,
  type PaperFreshnessSummary,
} from "./paper-freshness";

/**
 * 真题库的读取服务。
 *
 * 为什么在 catalog 之上再加一层：页面需要的不是"包状态"或"索引记录"这样的原始概念，
 * 而是"库里有什么、能做什么"。聚合、排序与空库判定收在这里，页面只负责渲染。
 *
 * 写入（导入）在 `services/paper-import.ts`；本文件**只读**，
 * 除了 `setPaperPool` —— 那改的是学习策略，不是内容。
 *
 * ── 为什么这里要带上模考新鲜度 ──
 *
 * "模考保留"这个承诺的实际含义是"留着一份**没见过**的卷子日后做严格模考"。
 * 而课程曝光可能已经让其中一份不再新鲜（见 `services/paper-freshness.ts`）。
 * 若列表页与详情页各自去问一次新鲜度，两页迟早会给出不同答案 ——
 * 因此它跟其它库级聚合一样收在这里，**一次算出、两页共用**。
 */

export interface PaperLibrary {
  summaries: PaperSummary[];
  /** 按年份倒序分组，便于列表页按年份浏览。 */
  years: Array<{ year: number; papers: PaperSummary[] }>;
  counts: {
    total: number;
    training: number;
    mockReserve: number;
    /** 内容包缺失或校验失败 —— 这两类才是真正"不可读"的。 */
    unavailable: number;
    /** 内容包存在但被改动过，索引已过期。仍可读，但必须标注。 */
    drifted: number;
    /** 其中属于真题（real_past_paper）的数量。用于空库文案的诚实表述。 */
    realPapers: number;
  };
  /**
   * 内容根与试卷目录的**展示用**标签（`private-content` / `private-content/cet6/papers`）。
   *
   * ── 为什么不是绝对路径 ──
   *
   * 曾经这里返回 `getContentRoot()` / `getPapersDir()` 的真实绝对路径，而
   * 真题库空状态把它直接渲染进 HTML（独立评审 F-2）：盘符、用户名、安装位置
   * 因此进入浏览器。绝对路径是**服务端读盘**的输入，不是**界面**的输出。
   *
   * 现在这里只承载展示标签，由 `content/paper/paths.ts` 的投影函数产出 ——
   * 它们是常量字符串，不可能泄漏本机布局。需要真实路径的调用方（导入器、
   * 校验器）继续直接调 `getPapersDir()`，不走这个结构体。
   */
  contentRootLabel: string;
  papersDirLabel: string;
  /**
   * 模考新鲜度索引（一次遍历算出，供列表与详情的行渲染共用）。
   *
   * `null` 表示**没有学习者**（未 onboard）：此时没有任何曝光可言，
   * 因此每一份试卷都是 pristine。用 null 而不是"假装算过"，
   * 是为了让"算不出来"与"算出来是空的"在类型上可区分。
   */
  freshness: PaperFreshnessIndex | null;
  /** 池为 `mock_reserve` 的试卷按新鲜度分档计数。 */
  freshnessCounts: PaperFreshnessSummary;
}

export function getPaperLibrary(repos: Repositories, profileId?: string | null): PaperLibrary {
  const catalog: PaperRepositoryBoundary = createPaperCatalog(repos);
  const summaries = catalog.listSummaries();

  const byYear = new Map<number, PaperSummary[]>();
  for (const summary of summaries) {
    const list = byYear.get(summary.record.year) ?? [];
    list.push(summary);
    byYear.set(summary.record.year, list);
  }

  const freshness = profileId ? getPaperFreshnessIndex(repos, profileId) : null;

  return {
    summaries,
    years: [...byYear.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([year, papers]) => ({ year, papers })),
    counts: {
      total: summaries.length,
      training: summaries.filter((item) => item.record.pool === "training").length,
      mockReserve: summaries.filter((item) => item.record.pool === "mock_reserve").length,
      unavailable: summaries.filter(
        (item) => item.packageStatus === "missing" || item.packageStatus === "invalid",
      ).length,
      drifted: summaries.filter((item) => item.packageStatus === "drifted").length,
      realPapers: summaries.filter((item) => item.record.sourceKind === "real_past_paper").length,
    },
    contentRootLabel: contentRootDisplayLabel(),
    papersDirLabel: papersDirDisplayLabel(),
    freshness,
    freshnessCounts: freshness
      ? summarizePaperFreshness(
          freshness,
          summaries.map((item) => item.record),
        )
      : { pristine: 0, exposed: 0, uncertain: 0 },
  };
}

export function getPaperDetail(repos: Repositories, paperId: string): PaperDetail | null {
  return createPaperCatalog(repos).getDetail(paperId);
}

/**
 * 试卷详情 + 该学习者视角的模考新鲜度。
 *
 * 为什么不在 `PaperDetail` 上加字段：那是**内容层**类型，描述"这份包长什么样"，
 * 与"谁在看"无关。把学习者相关的事实塞进去会让内容层依赖 profile，
 * 也会让同一个包在不同学习者下返回不同内容。因此并排返回，各自守自己的语义。
 */
export interface PaperDetailView {
  detail: PaperDetail;
  freshness: PaperFreshness | null;
}

export function getPaperDetailView(
  repos: Repositories,
  paperId: string,
  profileId?: string | null,
): PaperDetailView | null {
  const detail = getPaperDetail(repos, paperId);
  if (!detail) return null;
  if (!profileId) return { detail, freshness: null };

  // 经索引（而不是单份路径）取得：口径与列表页**逐字相同**。
  return { detail, freshness: getPaperFreshnessIndex(repos, profileId).get(paperId) };
}

/** 设置训练池归属。返回更新后的详情；试卷不存在时返回 null。 */
export function setPaperPool(repos: Repositories, paperId: string, pool: PaperPool): PaperDetail | null {
  const updated = repos.papers.setPool(paperId, pool);
  if (!updated) return null;
  return getPaperDetail(repos, paperId);
}
