import type { Repositories } from "@/repositories/ports";
import type { CourseCanonicalLinkRecord } from "@/repositories/ports";
import {
  isPaperReservedForMock,
  isPaperStartableForPractice,
  SECTION_LABELS,
  type PaperSectionType,
} from "@/domain/paper";
import type { LinkedPaperSummary } from "@/lib/course-reveal-contract";
import { listRuntimeLinksForSegment } from "./course-link";

/**
 * 课程段 → 真题 的**展示投影**（唯一实现）。
 *
 * ── 为什么把它单独抽出来（Round 3 P0）──
 *
 * 这个投影原本只存在于 `course-companion.ts`，用于页面渲染。而 409
 * 风险响应需要**同一份**信息（学习者要在"风险已变"的提示里看到
 * 具体是哪份卷子、哪个目标、现在是什么策略状态）。
 *
 * 上一版的做法是让 409 只回三个字段（`paperId` / `reservedForMock` /
 * `trainable`），客户端用一句未校验的类型断言把它当成完整形状 ——
 * 结果是确认面板消失、旧确认被静默采纳、再点一次就绕过了确认门。
 *
 * 修法不是"在客户端猜缺失字段"，而是：**服务端投影成完整形状，
 * 客户端校验它**。因此投影逻辑必须只有一份 —— 两份必然漂移，
 * 而漂移的那一份正是绕过产生的地方。
 *
 * ── 它刻意不做的事 ──
 *
 * 不含任何正文通道（`text` / `transcript` / `referenceTranslation` /
 * `notes`）。本模块的输出可以随页面 HTML 一起下发，因此它只能是
 * 身份与状态。
 */

/**
 * 一段材料指向的真题目标及其当前状态。
 *
 * 形状定义在 `@/lib/course-reveal-contract`（**唯一实现**）——
 * 那里同时提供运行时校验（zod）与编译期类型。本模块只是生产者。
 */
export type { LinkedPaperSummary };

/**
 * 把一段材料已核验的链接投影成展示就绪的列表。
 *
 * 只报**当前可用**的 verified 链接（`listRuntimeLinksForSegment` 已按
 * 语义目标去重并过滤 candidate/rejected/stale）。未匹配 ⇒ 空数组，
 * 那是合法状态，不是错误。
 *
 * ── 为什么按 paperId 分组、并且每组显示**每一个**目标 ──
 *
 * 上一版在这里做了 `if (byPaper.has(link.paperId)) continue;` ——
 * 同一段材料指向同一份卷子的**多个语义目标**时，只显示第一个。
 *
 * 独立审查复现了这个缺陷：一段材料可以同时指向同一份卷子的三个不同目标
 * （例如仔细阅读第 1 组、第 2 组、以及整个大题）。指纹**正确**考虑了
 * 全部链接，但学习者看到的确认说明只提第一个 ——
 * 于是他确认的是"我会消耗这份卷子的第 1 组"，
 * 而系统记录的是"这段材料对应这份卷子的三个目标"。
 *
 * 这不是信息过载，而是**知情同意的范围被悄悄缩小**：揭示会为全部目标
 * 写下潜在接触，而学习者只知道其中一个。
 *
 * 因此改成：按 paperId 分组（**不重复出卡片**），组内列出每一个不同的
 * 语义目标，并给出诚实的条数。策略状态（保留/可训练）是**卷子级**的，
 * 因此每组只显示一次 —— 它不是每个目标各自的属性。
 */
export function projectLinkedPapers(
  repos: Repositories,
  links: CourseCanonicalLinkRecord[],
): LinkedPaperSummary[] {
  /*
   * 按 paperId 聚合：同一份卷子的所有目标合成一个条目。
   *
   * 用 Map 而不是数组 find：`getPackage` 每次要读一次索引行，
   * 逐链接查会让 N 个目标查 N 次。
   */
  const byPaper = new Map<string, { summary: LinkedPaperSummary; targets: string[] }>();

  for (const link of links) {
    const paper = repos.papers.getPaper(link.paperId);
    if (!paper) continue;

    const existing = byPaper.get(link.paperId);
    if (existing) {
      /*
       * 同一个目标只列一次：`listRuntimeLinksForSegment` 已按语义目标去重，
       * 但同一语义目标可能因不同 `createdAt` 留下多条代表行 ——
       * 这里再按**学习者可见的目标描述**去重一次，避免界面出现两行一样的字。
       */
      const label = learnerFacingTarget(link);
      if (!existing.targets.includes(label)) existing.targets.push(label);
      continue;
    }

    const title = paperTitleOf(paper);
    byPaper.set(link.paperId, {
      summary: {
        paperId: link.paperId,
        paperTitle: title,
        // 组内目标列表在下面统一拼装（顺序确定）。
        targetLabel: "",
        runtimeUsable: true,
        unusableReason: null,
        // 策略与事实分开：两个判定都由权威谓词给出，不在这里裸比较。
        trainable: isPaperStartableForPractice(paper),
        reservedForMock: isPaperReservedForMock(paper),
      },
      targets: [learnerFacingTarget(link)],
    });
  }

  return [...byPaper.values()]
    .map(({ summary, targets }) => ({
      ...summary,
      /*
       * 目标描述：单个目标时直接给名字；多个目标时给**全部**并注明条数。
       *
       * 条数是诚实计数 —— 不说"若干"，也不把它们压成一个含糊的
       * "多个大题"（那会让人以为范围比实际更大或更小）。
       */
      targetLabel:
        targets.length === 1
          ? `${summary.paperTitle} · ${targets[0]}`
          : `${summary.paperTitle} · ${targets.join("；")}（共 ${targets.length} 个目标）`,
    }))
    .sort((a, b) => a.paperId.localeCompare(b.paperId));
}

/** 便捷形式：按 courseId + segmentId 直接投影（读盘一次）。 */
export function projectLinkedPapersForSegment(
  repos: Repositories,
  courseId: string,
  segmentId: string,
  cache?: Parameters<typeof listRuntimeLinksForSegment>[3],
): LinkedPaperSummary[] {
  return projectLinkedPapers(
    repos,
    listRuntimeLinksForSegment(repos, courseId, segmentId, cache),
  );
}

/** 试卷标题的产品语言（年份 + 场次 + 套别）。 */
export function paperTitleOf(paper: {
  year: number;
  session: string;
  variant: string;
}): string {
  const session = paper.session === "June" ? "6 月" : paper.session === "September" ? "9 月" : "12 月";
  return `${paper.year} 年 ${session}${paper.variant !== "single" ? ` · ${paper.variant}` : ""}`;
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
export function learnerFacingTarget(link: CourseCanonicalLinkRecord): string {
  const sectionLabel = SECTION_LABELS[link.sectionId as PaperSectionType] ?? link.sectionId;
  if (link.targetScope === "question") {
    const group = link.groupId ? `第 ${groupSuffix(link.groupId)} 组` : "题组未登记";
    return `${sectionLabel}（${group} · 第 ${link.questionId ?? "?"} 题）`;
  }
  if (link.targetScope === "group") {
    return `${sectionLabel}（第 ${groupSuffix(link.groupId ?? "")} 组）`;
  }
  return `${sectionLabel}（整个大题）`;
}

/**
 * 把题组 id 变成序号。
 *
 * 题组 id 形如 `g2`（见 `content/pipeline/detect.ts`）。取不出数字时
 * 原样返回 id —— 不猜。
 */
function groupSuffix(groupId: string): string {
  const match = /(\d+)\s*$/.exec(groupId);
  return match ? match[1] : groupId;
}
