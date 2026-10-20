/**
 * 第三方来源适配器（Stage 7 的输入侧）。
 *
 * ── 为什么需要"适配器"而不是通用解析 ──
 * 听力口语题干**不在主源 PDF 中**（源卷只印选项），因此只能来自第三方文字稿。
 * 各站点格式互不相同（实测：一处是 `Question 1, what does…` 的行式文字稿，
 * 另一处是 `Q.16` + `题干：…` 的题目卡片）。用一条通用正则去凑会变成
 * "看起来能跑但随时静默出错"的代码。
 *
 * 因此：**每个来源一个显式适配器**，每条适配器只认它自己站点的格式，
 * 并且都返回**带来源层级的结果**。解析失败时返回空而不是半个结果。
 *
 * ── 提取结果的处理原则 ──
 * 这些题干**永远**被标为 `third_party_transcript`，且**永远**产生
 * advisory 级复核项（提醒人工抽查 ASR 错误）。工具不把它们当作主源内容。
 */

export interface ThirdPartyStemExtraction {
  /** 题号 → 口语题干。 */
  stems: Record<number, string>;
  /** 提取到的题号列表（有序）。 */
  numbers: number[];
  /** 适配器标识，写入 provenance。 */
  adapter: string;
  /** 来源定位符（URL）。 */
  locator: string;
  /** 缺失的题号 —— 调用方据此决定是否阻断。 */
  missing: number[];
  /** 提取过程中观察到的问题（供人工复核）。 */
  notes: string[];
}

import { CJK } from "./text-utils";

/**
 * 把 HTML 粗转为纯文本。只保留结构与文字，不做 DOM 解析。
 *
 * ── 必须先剔除**隐藏元素**（实测缺陷）──
 *
 * 部分站点把随机字符塞进 `<span style="display:none">` 作为反爬噪声，
 * 例如题干后面紧跟 `<span style="display:none">SikEJ#[.ngVqf)^dO</span>`。
 * 这些字符**对浏览器用户不可见**，因此不属于页面内容 ——
 * 不剔除就会污染面向学习者的题干（实测把 `SikEJ#[.ngVqf)^dO`
 * 附到了 Q21 题干末尾）。
 *
 * 只剔除**明确声明隐藏**的元素。刻意不做"看起来像乱码就删"的启发式 ——
 * 那会误删真实的专有名词与缩写（`NATO`、`pH`、`Q&A`），
 * 而判据必须可解释：**隐藏声明**是页面的明确语义，"像乱码"不是。
 */
export function htmlToText(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    // 隐藏元素：display:none / visibility:hidden（含内联样式与 style 属性变体）
    .replace(
      /<[a-z][a-z0-9]*\b[^>]*\bstyle\s*=\s*("[^"]*display\s*:\s*none[^"]*"|'[^']*display\s*:\s*none[^']*'|display\s*:\s*none[^>]*)[^>]*>[\s\S]*?<\/[a-z][a-z0-9]*>/gi,
      "",
    )
    .replace(
      /<[a-z][a-z0-9]*\b[^>]*\bstyle\s*=\s*("[^"]*visibility\s*:\s*hidden[^"]*"|'[^']*visibility\s*:\s*hidden[^']*'|visibility\s*:\s*hidden[^>]*)[^>]*>[\s\S]*?<\/[a-z][a-z0-9]*>/gi,
      "",
    )
    // 自闭合/无闭合的隐藏元素（`<span ... style="display:none" />` 之类）
    .replace(
      /<[a-z][a-z0-9]*\b[^>]*\bstyle\s*=\s*("[^"]*(display\s*:\s*none|visibility\s*:\s*hidden)[^"]*"|'[^']*(display\s*:\s*none|visibility\s*:\s*hidden)[^']*')[^>]*\/?>/gi,
      "",
    )
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr|td|section|article)>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const entities: [string, string][] = [
    ["&nbsp;", " "],
    ["&#xA0;", " "],
    ["&#160;", " "],
    ["&amp;", "&"],
    ["&quot;", '"'],
    ["&#39;", "'"],
    ["&apos;", "'"],
    ["&lt;", "<"],
    ["&gt;", ">"],
    ["&ldquo;", "\u201c"],
    ["&rdquo;", "\u201d"],
    ["&lsquo;", "\u2018"],
    ["&rsquo;", "\u2019"],
    ["&mdash;", "\u2014"],
    ["&ndashe;", "\u2013"],
    ["&hellip;", "\u2026"],
    ["&darr;", "\u2193"],
  ];
  for (const [from, to] of entities) text = text.split(from).join(to);

  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter((line) => line !== "")
    .join("\n");
}

/** 去掉题干里的中文解析，只保留英文问句。 */
function englishQuestionOf(raw: string): string {
  const text = raw.replace(/\s+/g, " ").trim();
  // 中文解析通常紧跟在英文问句之后；切在第一个中文字符处
  const firstCjk = text.search(CJK);
  const english = firstCjk > 0 ? text.slice(0, firstCjk) : text;
  return english.replace(/\s+/g, " ").trim().replace(/[,\s]+$/, "");
}

/**
 * 英文数字词 → 阿拉伯数字。
 *
 * 实测排版形态：某来源把第 5 题写成 `Question five，what does the woman say…`，
 * 而同页其他题用阿拉伯数字。只认数字会让该题整条落空。
 * 这是**有意的规范化**：两种写法表达同一个题号，归一化不丢失信息。
 */
const NUMBER_WORDS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14,
  fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, "twenty-one": 21, "twenty-two": 22, "twenty-three": 23,
  "twenty-four": 24, "twenty-five": 25,
};

function toQuestionNumber(token: string): number | null {
  const trimmed = token.trim().toLowerCase();
  if (/^\d{1,2}$/.test(trimmed)) {
    const value = Number(trimmed);
    return value >= 1 && value <= 25 ? value : null;
  }
  return NUMBER_WORDS[trimmed] ?? null;
}

/**
 * 适配器 A：行式文字稿，题干以 `Question N, …` 起头。
 *
 * 实测来源：某第三方站点的听力原文文本页。
 *
 * ── 为什么用**全文本扫描**而不是逐行匹配 ──
 *
 * 该来源的排版极不规则，逐行规则会不断漏题（每一种都由实测缺陷驱动）：
 *
 * | 形态 | 实例 |
 * | --- | --- |
 * | 题号与题干同行 | `Question 1, what does the man say…` |
 * | 英文数字词 | `Question five, what does the woman say…` |
 * | 标记被折行 | `…heard.Question` + 下一行 `five, what does…` |
 * | 说明与下一题挤在同一行 | `Questions 5to8 are based on…heard.Question five, what does…` |
 * | 题号无空格 | `Question12, what do psychologists say?` |
 * | 题号前是句点 | `…you have just heard.Question 22. What…` |
 *
 * 逐行加规则只能追上其中一部分。改为：
 *
 * 1. **先归一化标点**（全角 → 半角）；
 * 2. 在整个文本上扫描 `Question(s)? <token>` 出现位置，
 *    **排除**题组说明形态（`Questions n to m are based on` 里的那个）；
 * 3. 按这些位置把文本切成块，每块归给它的题号；
 * 4. 每块内剥掉说明性尾巴（`are based on …`）与中文解析。
 *
 * 这样行结构不再影响结果。
 *
 * ── 无法解析的题号如实报告，不猜 ──
 *
 * 若某题在来源中确实没有对应文本，它出现在 `missing` 里并由门禁阻断 ——
 * **绝不**补一段猜测的文字。
 *
 * ── 为什么来源写成"某第三方站点"而不是站名 ──
 *
 * 适配器的工程内容全在下面那张表里：排版形态、折行位置、中英文混排。
 * 站名对读者没有增量信息 —— 它不能帮助任何人调试这个解析器 —— 却会把
 * 一份对具体网站内容形态的公开描述留在仓库里。来源定位符在运行时由
 * `sources.json` 传入（`locator` 参数），那才是它该在的地方。
 */
export function extractStemsFromLineTranscript(
  text: string,
  locator: string,
): ThirdPartyStemExtraction {
  const normalizedText = normalizePunctuation(text);
  const stems: Record<number, string> = {};
  const notes: string[] = [];

  // 题组说明形态：`Questions 5to8 are based on …` / `Questions 1 to 4 are based on …`
  //
  // 锚点的**末尾条件刻意宽松**：实测存在 `Question 18 of the five styles the
  // speaker discusses which views conflicts as problems to be solved?` ——
  // 题号后直接跟 `of`，既不是标点也不是 `are based on`。
  // 收紧末尾条件会让这题整条落空。真正的排除条件是"这是题组范围"（带 to）。
  const anchorPattern = /Questions?\s*([A-Za-z0-9-]{1,12})\b/gi;

  // 扫描全部锚点，记录位置、题号、以及它是否属于"题组说明"（带 `to m` 或 `are based on`）
  const anchors: { index: number; number: number; isGroupHeader: boolean }[] = [];
  let match: RegExpExecArray | null;
  while ((match = anchorPattern.exec(normalizedText)) !== null) {
    const first = toQuestionNumber(match[1]);
    if (first === null) continue;

    // 判定是否题组说明：向后看一小段，检查是否形如 `to <n> ... are based on`
    const tail = normalizedText.slice(match.index, match.index + 60);
    const isGroupHeader = /^Questions?\s*[A-Za-z0-9-]{1,12}\s*to\s*[A-Za-z0-9-]{1,12}/i.test(tail) ||
      /are\s+based\s+on/i.test(tail.slice(0, 40));

    anchors.push({ index: match.index, number: first, isGroupHeader });
  }

  // 只保留题干锚点（排除题组说明）
  const questionAnchors = anchors.filter((anchor) => !anchor.isGroupHeader);
  // 同一题号可能因重复扫描出现多次，保留首个
  const firstByNumber = new Map<number, number>();
  for (const anchor of questionAnchors) {
    if (!firstByNumber.has(anchor.number)) firstByNumber.set(anchor.number, anchor.index);
  }

  const orderedAnchors = [...firstByNumber.entries()]
    .map(([number, index]) => ({ number, index }))
    .sort((a, b) => a.index - b.index);

  orderedAnchors.forEach((anchor, position) => {
    const end = position + 1 < orderedAnchors.length ? orderedAnchors[position + 1].index : normalizedText.length;
    let chunk = normalizedText.slice(anchor.index, end);

    // 剥掉锚点本身
    chunk = chunk.replace(/^Questions?\s*[A-Za-z0-9-]{1,12}\s*[.,:]?\s*/i, "");
    // 剥掉题组说明的尾巴（它属于下一组的引导语，不是本题干）
    chunk = chunk.replace(/Questions?\s*[A-Za-z0-9-]{1,12}\s*to\s*[A-Za-z0-9-]{1,12}[\s\S]*$/i, "");
    chunk = chunk.replace(/\s+/g, " ").trim();

    const english = englishQuestionOf(chunk);
    if (english.length > 12) stems[anchor.number] = english;
    else notes.push(`第 ${anchor.number} 题的题干过短，可能是跨行切断：${english.slice(0, 60)}`);
  });

  const numbers = Object.keys(stems)
    .map(Number)
    .sort((a, b) => a - b);
  const missing: number[] = [];
  for (let n = 1; n <= 25; n += 1) if (!(n in stems)) missing.push(n);

  return {
    stems,
    numbers,
    adapter: "line_transcript_question_prefix",
    locator,
    missing,
    notes,
  };
}

/**
 * 把全角标点归一化为半角。
 *
 * 第三方整理稿混用两种标点，而解析规则只需要一套。
 * 这是**有意的规范化**：全角与半角在此处表达同一件事（句子边界），
 * 归一化不会丢失内容信息。
 */
export function normalizePunctuation(text: string): string {
  return text
    .replace(/[\uff0c\uff0e\u3002\uff1a\uff1b]/g, (char) => {
      // ，．。：； → 半角等价物
      if (char === "\uff0c" || char === "\uff0e") return ",";
      if (char === "\u3002" || char === "\uff0e") return ".";
      if (char === "\uff1a") return ":";
      if (char === "\uff1b") return ";";
      return char;
    })
    .replace(/\uff1f/g, "?")
    .replace(/\uff01/g, "!")
    .replace(/\u3000/g, " ");
}

/**
 * 适配器 B：题目卡片式，题干在 `题干：` 字段里。
 *
 * 实测来源：某第三方站点的六级听力真题页（每页含 `Q.N` + 选项 + `解析` + `题干：…`）。
 * 卡片顺序即题号顺序，卡片自身印有 `Q.N`。
 *
 * 站名不写在这里，理由同适配器 A：工程内容是页面**结构**，不是它挂在哪个
 * 域名下。定位符由调用方经 `locator` 传入。
 */
export function extractStemsFromStemCards(text: string, locator: string): ThirdPartyStemExtraction {
  const lines = text.split("\n").map((line) => line.trim());
  const stems: Record<number, string> = {};
  const notes: string[] = [];

  let pendingQuestion: number | null = null;

  for (const line of lines) {
    const q = /^Q\.?\s*(\d{1,2})$/.exec(line) ?? /^(\d{1,2})\.\s*$/.exec(line);
    if (q) {
      pendingQuestion = Number(q[1]);
      continue;
    }
    const stem = /^题干\s*[:：]\s*(.*)$/.exec(line);
    if (stem && pendingQuestion !== null) {
      const english = englishQuestionOf(stem[1]);
      if (english.length > 12) {
        stems[pendingQuestion] = english;
      } else {
        notes.push(`Q${pendingQuestion} 的题干过短：${english.slice(0, 60)}`);
      }
      pendingQuestion = null;
    }
  }

  const numbers = Object.keys(stems)
    .map(Number)
    .sort((a, b) => a - b);
  const missing: number[] = [];
  for (let n = 1; n <= 25; n += 1) if (!(n in stems)) missing.push(n);

  return { stems, numbers, adapter: "stem_card_question_field", locator, missing, notes };
}
