/**
 * 匹配投影（matching projection）。
 *
 * ── 这一层最容易出错的地方：它与"课程内容"是两件不同的东西 ──
 *
 * 本模块产出的文本**只用于相似度计算**。它：
 *
 * - **永不写入** `course.json`（课程内容是另一套保守得多的归一，见 `segment.ts`）；
 * - **永不覆盖**原始页文本（`ExtractedPage.rawText` 保留源件投影）；
 * - 不改变任何"这段材料是什么"的判断 —— 它是度量，不是内容。
 *
 * 三条文本因此始终可区分：
 *
 * | 层 | 归一强度 | 用途 | 落盘位置 |
 * | --- | --- | --- | --- |
 * | 原始页文本 | 无 | 审计、引文核对 | `candidate.json` |
 * | 课程内容文本 | 排版（断行/空白/段落） | 学习者可见内容 | `course.json` |
 * | 匹配投影 | 激进（NFKC/大小写/连字符/空白） | 相似度 | **不落盘** |
 *
 * ── 允许的保守变换（每一项都有理由）──
 *
 * - **Unicode NFKC**：全角/半角、兼容字形在源件与真题里写法不一致，
 *   而它们显然是同一个字符（`Ａ` 与 `A`、`５` 与 `5`）。
 * - **英文大小写折叠**：`Passage` 与 `PASSAGE` 不是两个词。
 *   只对拉丁字母折叠，因此不会把 CJK 弄坏。
 * - **排版引号/破折号统一**：`’` `‘` `“` `”` 与 `'` `"`；
 *   `—` `–` `‐` 与 `-`。源件与真题来自不同排版工具，这是同一字符的两种印法。
 * - **行尾连字符拆除**：`informa-\ntion` → `information`。
 *   这是 PDF 抽取伪影，**只在"连字符紧邻换行"时**拆除 ——
 *   真实存在的连字符词（`well-known`）不会跨行，因此不受影响。
 * - **空白折叠**：换行、制表、多空格 → 单空格。
 *
 * 刻意**不做**的事：词形还原（lemma）、同义词扩展、停用词删除、
 * 任何模型推断。它们会让"为什么这两段相似"变得不可复现。
 */

import { CJK } from "@/content/pipeline/text-utils";
import { MATCHING_PROJECTION_VERSION } from "./types";

export { MATCHING_PROJECTION_VERSION };

/**
 * 把一段文本投影为匹配用文本。
 *
 * 顺序有讲究：**先拆连字符，再折叠空白**。反过来的话换行已经被折叠成空格，
 * 就再也分不清"行尾连字符"与"词内连字符"了。
 */
export function projectForMatching(input: string): string {
  let text = String(input ?? "");

  // 1) 统一换行
  text = text.replace(/\r\n?/g, "\n");

  // 2) 行尾连字符拆除（必须在空白折叠之前 —— 见上）
  //    只处理"连字符 + 换行"，且连字符前是字母（避免动到 `- 3` 这类列表符）。
  text = text.replace(/([A-Za-z\u00c0-\u024f])-\n[ \t]*/g, "$1");

  // 3) NFKC：全角/兼容字形归一到规范形
  text = text.normalize("NFKC");

  // 4) 排版引号与破折号统一（NFKC 不覆盖这些）
  text = text
    .replace(/[\u2018\u2019\u02bc\u02b9\u2032\u2035]/g, "'")
    .replace(/[\u201c\u201d\u2033\u2036]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/\u2026/g, "...")
    .replace(/\u00a0/g, " ");

  // 5) 大小写折叠。只折拉丁字母 —— CJK 没有大小写，
  //    而 `toLowerCase()` 对它们是无操作，因此直接整体调用是安全的。
  text = text.toLowerCase();

  // 6) 空白折叠
  text = text.replace(/\s+/g, " ").trim();

  return text;
}

/**
 * 匹配投影的**精确指纹**。
 *
 * 用途：两侧投影完全相同时直接给出最强的证据项（`projectionExact`）。
 * 这只是一个**证据字段**，不是匹配结论 —— 相似的内容也会被判"非精确"。
 */
export function projectionFingerprint(input: string): string {
  // 这里刻意不 import node:crypto 之外的东西，也不做哈希缓存：
  // 指纹只用于相等比较，纯字符串本身就够，且能直接进测试断言。
  return projectForMatching(input);
}

// ---------------------------------------------------------------------------
// shingle（n-gram）集合
// ---------------------------------------------------------------------------

/**
 * 生成 shingle 集合。
 *
 * ── 为什么英文与 CJK 用不同的切分 ──
 *
 * 英文按**词**切分（`the quick brown` → `the quick`, `quick brown`）：
 * 字符 n-gram 对英文会被拼写噪声主导，而词级 n-gram 更贴近"用词是否相同"。
 *
 * CJK 按**字符**切分：中文没有词间空格，按空格切会把整段变成一个 token，
 * 于是任何两段中文的相似度都只取决于"是否整段相同"，失去分辨力。
 *
 * 混合文本（中英夹杂）按段分别处理，因此裁判据落在**实际语系**上。
 */
export function shingles(input: string, size = 3): Set<string> {
  const text = projectForMatching(input);
  const out = new Set<string>();
  if (text === "") return out;

  // 按语系切成连续的 run：CJK run 与拉丁 run 分别处理
  for (const run of splitByScript(text)) {
    if (run.text === "") continue;
    if (run.cjk) {
      // CJK：字符 bigram（比 unigram 更有分辨力，比 trigram 更抗断句差异）
      const chars = [...run.text.replace(/\s+/g, "")];
      const n = 2;
      if (chars.length < n) {
        // 极短中文段落：退化为整串，避免产生空集合
        out.add(`cjk:${chars.join("")}`);
        continue;
      }
      for (let i = 0; i + n <= chars.length; i += 1) {
        out.add(`cjk:${chars.slice(i, i + n).join("")}`);
      }
      continue;
    }

    // 拉丁 / 数字：词级 n-gram
    const words = run.text.split(" ").filter((word) => word !== "");
    if (words.length < size) {
      if (words.length > 0) out.add(`w:${words.join(" ")}`);
      continue;
    }
    for (let i = 0; i + size <= words.length; i += 1) {
      out.add(`w:${words.slice(i, i + size).join(" ")}`);
    }
  }

  return out;
}

/** 把文本切成连续的 CJK / 非 CJK 段。 */
function splitByScript(text: string): { text: string; cjk: boolean }[] {
  const runs: { text: string; cjk: boolean }[] = [];
  let current = "";
  let currentIsCjk: boolean | null = null;

  for (const char of text) {
    // 标点与空格跟随当前 run，避免把一句话切得七零八落
    const isCjk = CJK.test(char);
    const isNeutral = /\s/.test(char) || /[^\p{L}\p{N}]/u.test(char);
    const belongs = currentIsCjk === null || isNeutral ? currentIsCjk : isCjk;
    if (currentIsCjk !== null && belongs !== null && belongs !== currentIsCjk && !isNeutral) {
      runs.push({ text: current, cjk: currentIsCjk });
      current = "";
    }
    if (!isNeutral) currentIsCjk = isCjk;
    current += char;
  }
  if (current !== "") runs.push({ text: current, cjk: currentIsCjk ?? false });

  return runs.filter((run) => run.text.trim() !== "");
}

/**
 * Jaccard 相似度：`|A ∩ B| / |A ∪ B|`。
 *
 * 已知局限（这决定了它在长文本上**不能单独用**）：两侧长度差很多时，
 * 交集再大也会被并集稀释 —— 一段 200 词的真卷篇章与一份把它完整包进去的
 * 讲义，Jaccard 可能只有 0.3，而"讲义确实包含这篇"这件事是 1.0。
 * 因此打分同时使用 `containment`。
 */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const item of small) if (large.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

/**
 * 包含度（overlap coefficient）：`|A ∩ B| / min(|A|, |B|)`。
 *
 * 语义："较短的那一侧有多少被较长的一侧覆盖"。
 *
 * 这正是课程讲义与真题之间**真实**的关系形态：讲义是按题型重组的，
 * 它可能包含整篇真题文章再加上讲解、题目与答案 —— 于是
 * "真题篇目被讲义完整包含"是真的，而 Jaccard 会把它压得很低。
 *
 * 反过来，它也不能单独用：一段很短的无关文本可能被长文本偶然覆盖。
 * 因此打分同时要求"较短侧有足够的绝对体量"（见 `match.ts` 的最小体量闸门）。
 */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const item of small) if (large.has(item)) intersection += 1;
  return intersection / small.size;
}

/** 交集大小（用于"绝对体量"闸门：比例高但只共享两个 shingle 不算证据）。 */
export function intersectionSize(a: Set<string>, b: Set<string>): number {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const item of small) if (large.has(item)) intersection += 1;
  return intersection;
}

/**
 * token 集合（题干 / 选项用）。
 *
 * 与 shingle 不同：这里要的是"用词重叠"，不是"语序短语重叠"。
 * 因此英文按词去重，CJK 按字符去重。
 */
export function tokenSet(input: string): Set<string> {
  const text = projectForMatching(input);
  const out = new Set<string>();
  for (const run of splitByScript(text)) {
    if (run.cjk) {
      for (const char of run.text.replace(/\s+/g, "")) out.add(`c:${char}`);
    } else {
      for (const word of run.text.split(" ")) {
        if (word.length >= 2) out.add(`w:${word}`);
      }
    }
  }
  return out;
}

/** 语系构成（用于"这段文字是中文还是英文"这类**可核对**的判断）。 */
export function scriptProfile(input: string): { cjkChars: number; latinChars: number; cjkRatio: number } {
  const text = String(input ?? "");
  let cjkChars = 0;
  let latinChars = 0;
  for (const char of text) {
    if (CJK.test(char)) cjkChars += 1;
    else if (/[A-Za-z]/.test(char)) latinChars += 1;
  }
  const total = cjkChars + latinChars;
  return { cjkChars, latinChars, cjkRatio: total === 0 ? 0 : cjkChars / total };
}

/**
 * 匹配投影的最小体量闸门（**唯一实现**）。
 *
 * 为什么必须有它：`containment` 在极短文本上会给出无意义的 1.0 ——
 * 一段只有 "the" 的文本会被任何长篇章"完整包含"。因此所有基于
 * shingle 的证据都必须先通过这个闸门，否则"相似度"会变成一个
 * 由文本长度而非内容决定的数字。
 */
export const MIN_SHINGLES_FOR_SIMILARITY = 8;

export function hasEnoughSubstance(input: string): boolean {
  return shingles(input).size >= MIN_SHINGLES_FOR_SIMILARITY;
}
