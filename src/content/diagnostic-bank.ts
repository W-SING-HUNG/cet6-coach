import type { DiagnosticItem } from "@/domain/models";

/**
 * 诊断题库（原创内容，版本化 seed data）。
 *
 * 设计说明：
 * - 每道题都是扁平 item：dimension / difficulty / tags 决定它如何被评分、如何影响弱项推导。
 * - 阅读用"多题共享一段材料"表达（多个 item 引用同一段 passage），
 *   这样评分、置信度、弱项推导全部复用同一套扁平逻辑，不需要为阅读单独写嵌套分支。
 * - 听力在无音频条件下测「音形对应」这一真实子能力：给出 IPA 让应试者辨认单词。
 *   这**只**衡量音形解码，不代表实时听力理解水平 —— 该限制在 UI 中如实标出。
 * - 音频类题目以 `pending_media` 形式存在，用于验证 pending 状态链路，不参与计分。
 * - 主观题带 rubricPoints，由确定性的本地 rubric grader 评分（关键词覆盖）。
 */

export const DIAGNOSTIC_BANK_VERSION = "2026.09-a";

/** 阅读部分共用的材料。抽成常量避免多处内联导致修改遗漏。 */
const READING_PASSAGE_ATTENTION = `For most of the twentieth century, the cost of copying information fell steadily while the cost of finding it stayed high. Libraries and publishers served as filters: someone else had already decided which books deserved shelf space.

The internet reversed that balance. Copying became nearly free, and the bottleneck moved to attention. The new problem is not scarcity of material but scarcity of the will to sit with any of it. A student who wants to understand a difficult argument now faces a library larger than any physical one, and no shelf has been curated for her.

Researchers who study reading behaviour describe a shift rather than a decline. Readers still consume enormous quantities of text, but they read in shorter bursts, moving between sources before any single argument has had time to settle. The skill that atrophies is not decoding; it is tolerance — the willingness to remain confused for twenty minutes because the alternative is never understanding.`;

export const DIAGNOSTIC_ITEMS: DiagnosticItem[] = [
  // ---------------- vocabulary ----------------
  {
    id: "diag-vocab-01",
    dimension: "vocabulary",
    type: "mcq",
    difficulty: 1,
    prompt: "The new manager was praised for her ______ approach: she solved the budget problem within a week.",
    choices: [
      { id: "a", label: "pragmatic" },
      { id: "b", label: "pessimistic" },
      { id: "c", label: "poetic" },
      { id: "d", label: "passive" },
    ],
    correctChoiceId: "a",
    explanation: "pragmatic 指讲求实际、注重可行性，与「一周内解决预算问题」呼应；其余三项都与效率无关。",
    estimatedSeconds: 40,
    tags: ["vocab.context_clue", "vocab.adjective"],
  },
  {
    id: "diag-vocab-02",
    dimension: "vocabulary",
    type: "mcq",
    difficulty: 2,
    prompt: "Many students ______ their improvement to the weekly study plan they kept.",
    choices: [
      { id: "a", label: "contribute" },
      { id: "b", label: "attribute" },
      { id: "c", label: "distribute" },
      { id: "d", label: "substitute" },
    ],
    correctChoiceId: "b",
    explanation: "attribute A to B 表示「把 A 归因于 B」。contribute to 是「促成」，语义与搭配都不同。",
    estimatedSeconds: 40,
    tags: ["vocab.confusable_pair", "vocab.verb_prep"],
  },
  {
    id: "diag-vocab-03",
    dimension: "vocabulary",
    type: "mcq",
    difficulty: 2,
    prompt: "The company decided to ______ the launch until the safety tests were complete.",
    choices: [
      { id: "a", label: "propose" },
      { id: "b", label: "impose" },
      { id: "c", label: "postpone" },
      { id: "d", label: "presume" },
    ],
    correctChoiceId: "c",
    explanation: "until 引导的时间状语要求谓语表示推迟，postpone 是唯一符合语义的选项。",
    estimatedSeconds: 40,
    tags: ["vocab.context_clue"],
  },
  {
    id: "diag-vocab-04",
    dimension: "vocabulary",
    type: "mcq",
    difficulty: 3,
    prompt: "Her explanation was so ______ that no one needed to ask a follow-up question.",
    choices: [
      { id: "a", label: "lousy" },
      { id: "b", label: "ludicrous" },
      { id: "c", label: "latent" },
      { id: "d", label: "lucid" },
    ],
    correctChoiceId: "d",
    explanation: "lucid 意为清晰易懂，与「没人需要追问」构成因果关系；其余为近形干扰项。",
    estimatedSeconds: 45,
    tags: ["vocab.near_form"],
  },
  {
    id: "diag-vocab-05",
    dimension: "vocabulary",
    type: "mcq",
    difficulty: 3,
    prompt: "These two proposals are ______; you cannot adopt both at once.",
    choices: [
      { id: "a", label: "mutually beneficial" },
      { id: "b", label: "mutually exclusive" },
      { id: "c", label: "mutually dependent" },
      { id: "d", label: "mutually acceptable" },
    ],
    correctChoiceId: "b",
    explanation: "mutually exclusive（互斥）才能解释「不能同时采纳」。这是固定搭配型考点。",
    estimatedSeconds: 45,
    tags: ["vocab.collocation"],
  },

  // ---------------- reading ----------------
  {
    id: "diag-read-01",
    dimension: "reading",
    type: "mcq",
    difficulty: 2,
    passage: READING_PASSAGE_ATTENTION,
    prompt: "What does the passage identify as the main bottleneck in the internet era?",
    choices: [
      { id: "a", label: "The sheer scarcity of high-quality material." },
      { id: "b", label: "The cost of copying information." },
      { id: "c", label: "The limited supply of sustained attention." },
      { id: "d", label: "The disappearance of libraries and publishers." },
    ],
    correctChoiceId: "c",
    explanation:
      "第二段指出瓶颈转移到 attention，并强调问题不是素材稀缺，而是「坐下来读进去的意愿」稀缺。",
    estimatedSeconds: 90,
    tags: ["reading.main_idea"],
  },
  {
    id: "diag-read-02",
    dimension: "reading",
    type: "mcq",
    difficulty: 2,
    passage: READING_PASSAGE_ATTENTION,
    prompt: "The phrase \"The skill that atrophies\" most nearly means a skill that ______.",
    choices: [
      { id: "a", label: "weakens through disuse" },
      { id: "b", label: "develops unexpectedly" },
      { id: "c", label: "becomes unnecessary" },
      { id: "d", label: "is deliberately trained" },
    ],
    correctChoiceId: "a",
    explanation: "atrophy 意为因不用而萎缩，与后文 tolerance 的丧失相呼应。",
    estimatedSeconds: 70,
    tags: ["reading.vocab_in_context"],
  },
  {
    id: "diag-read-03",
    dimension: "reading",
    type: "mcq",
    difficulty: 3,
    passage: READING_PASSAGE_ATTENTION,
    prompt: "How do researchers described in the passage characterise the change?",
    choices: [
      { id: "a", label: "As an outright collapse in reading ability." },
      { id: "b", label: "As a redistribution rather than a loss." },
      { id: "c", label: "As a temporary effect of digital devices." },
      { id: "d", label: "As a problem only affecting students." },
    ],
    correctChoiceId: "b",
    explanation: "第三段明确说 describe a shift rather than a decline，即阅读行为重新分布而非能力滑坡。",
    estimatedSeconds: 70,
    tags: ["reading.detail"],
  },
  {
    id: "diag-read-04",
    dimension: "reading",
    type: "mcq",
    difficulty: 3,
    passage: READING_PASSAGE_ATTENTION,
    prompt: "What can be inferred about curated shelves?",
    choices: [
      { id: "a", label: "They reduced the total amount of information available." },
      { id: "b", label: "They substituted for the work of researchers." },
      { id: "c", label: "They performed a filtering function that is now missing." },
      { id: "d", label: "They were less reliable than algorithmic ranking." },
    ],
    correctChoiceId: "c",
    explanation:
      "第一段说图书馆与出版社充当 filter；第二段说现在 no shelf has been curated for her，即这一过滤功能消失。",
    estimatedSeconds: 90,
    tags: ["reading.inference"],
  },

  // ---------------- writing ----------------
  {
    id: "diag-write-01",
    dimension: "writing",
    type: "short_text",
    difficulty: 2,
    prompt:
      "Write a short argumentative paragraph (60-90 words) answering: Should university students be required to take part-time internships? State your position and give one supporting reason with a concrete example.",
    rubricPoints: [
      "position stated in the opening",
      "one supporting reason",
      "a concrete example such as a company or a survey",
      "linking words between sentences like however or therefore",
      "a closing sentence that restates the position",
      "varied sentence structures rather than short simple sentences",
    ],
    estimatedSeconds: 420,
    tags: ["writing.argument", "writing.structure"],
  },

  // ---------------- translation ----------------
  {
    id: "diag-trans-01",
    dimension: "translation",
    type: "short_text",
    difficulty: 2,
    prompt: "将下面这句话译成英文：",
    passage: "中国的茶文化历史悠久，饮茶不仅是一种日常习惯，也承载着人与人之间的交往方式。",
    rubricPoints: [
      "a long history for tea culture in China",
      "tea drinking",
      "daily habit",
      "not only but also",
      "social interaction between people",
      "ways of communication",
    ],
    estimatedSeconds: 180,
    tags: ["translation.sentence_split"],
  },
  {
    id: "diag-trans-02",
    dimension: "translation",
    type: "short_text",
    difficulty: 3,
    prompt: "将下面这句话译成英文：",
    passage: "高速铁路网络把许多原本需要一整天的行程缩短到几个小时，这改变了人们选择居住地和工作地的方式。",
    rubricPoints: [
      "high-speed rail network",
      "journeys that used to take",
      "a whole day",
      "shorten to a few hours",
      "change the way people choose",
      "where people live and work",
    ],
    estimatedSeconds: 180,
    tags: ["translation.relative_clause"],
  },

  // ---------------- 语音识别（原误标为 listening） ----------------
  // 这四题测的是「看到音标能否辨认单词」，即音形解码 / 拼读能力，属于词汇与语音意识范畴。
  // CET-6 听力考的是长对话、篇章、讲座的**音频理解**；没有音频刺激就不可能测量听力理解，
 // 因此这些题**不能**作为 listening 的证据。
  // 它们仍有真实训练价值（音形对应是拼读与拼写的基础），故归入 vocabulary 并打上明确标签，
  // 而不是为了保留代码继续叫 Listening，也不是编造一个 pseudo-listening 分数。
  {
    id: "diag-phon-01",
    dimension: "vocabulary",
    type: "mcq",
    difficulty: 1,
    prompt: "哪一个单词的读音是 /kənˈvɪnsɪŋ/ ?",
    choices: [
      { id: "a", label: "convincing" },
      { id: "b", label: "convicting" },
      { id: "c", label: "conserving" },
      { id: "d", label: "conveying" },
    ],
    correctChoiceId: "a",
    explanation: "注意第二个音节是 /vɪn/ 而非 /vɪk/ 或 /sɜː/，这是一组常见的音形混淆点。",
    estimatedSeconds: 25,
    tags: ["vocabulary.phonetic_recognition"],
  },
  {
    id: "diag-phon-02",
    dimension: "vocabulary",
    type: "mcq",
    difficulty: 2,
    prompt: "哪一个单词的读音是 /ɪˈvækjueɪt/ ?",
    choices: [
      { id: "a", label: "evaluate" },
      { id: "b", label: "evacuate" },
      { id: "c", label: "evoke" },
      { id: "d", label: "equate" },
    ],
    correctChoiceId: "b",
    explanation:
      "evacuate 读 /ɪˈvækjueɪt/，重音在第二音节且含 /kj/；evaluate 是 /ɪˈvæljueɪt/，第三音节为 /lju/。",
    estimatedSeconds: 25,
    tags: ["vocabulary.phonetic_recognition"],
  },
  {
    id: "diag-phon-03",
    dimension: "vocabulary",
    type: "mcq",
    difficulty: 3,
    prompt: "哪一个单词的读音是 /ˈædəkwət/ ?",
    choices: [
      { id: "a", label: "accurate" },
      { id: "b", label: "adequate" },
      { id: "c", label: "attribute" },
      { id: "d", label: "etiquette" },
    ],
    correctChoiceId: "b",
    explanation: "adequate 的两个弱读音节都接近 /ə/；accurate 的中间音节是 /jə/，二者易混。",
    estimatedSeconds: 25,
    tags: ["vocabulary.phonetic_recognition"],
  },
  {
    id: "diag-phon-04",
    dimension: "vocabulary",
    type: "mcq",
    difficulty: 3,
    prompt: "哪一个单词的读音是 /ˈkɒnsɪkwəns/ ?",
    choices: [
      { id: "a", label: "consequence" },
      { id: "b", label: "constituents" },
      { id: "c", label: "consistency" },
      { id: "d", label: "consultants" },
    ],
    correctChoiceId: "a",
    explanation: "consequence 的第二音节是 /sɪ/，consistency 是 /sɪs/，重音位置也不同。",
    estimatedSeconds: 25,
    tags: ["vocabulary.phonetic_recognition"],
  },

  // ---------------- listening ----------------
  {
    id: "diag-listen-01",
    dimension: "listening",
    type: "pending_media",
    difficulty: 3,
    prompt: "长对话理解（音频素材待补）",
    pendingReason:
      "CET-6 听力理解需要真实音频刺激。Phase 1 未内置音频，也不使用来源不明的真题音频，" +
      "因此听力维度**尚未有效评估** —— 它不会得到分数，也不会被推断为弱项。" +
      "本题的存在是为了让数据模型与 UI 如实表达这一状态。",
    estimatedSeconds: 0,
    tags: ["listening.audio_required"],
  },
];

/** 诊断题量统计，用于 UI 展示预计时长与各维度覆盖。 */
export function summarizeBank(items: DiagnosticItem[]) {
  const byDimension = new Map<string, { total: number; gradeable: number; seconds: number }>();
  for (const item of items) {
    const entry = byDimension.get(item.dimension) ?? { total: 0, gradeable: 0, seconds: 0 };
    entry.total += 1;
    if (item.type !== "pending_media") entry.gradeable += 1;
    entry.seconds += item.estimatedSeconds;
    byDimension.set(item.dimension, entry);
  }
  return byDimension;
}
