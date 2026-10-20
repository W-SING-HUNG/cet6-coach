import type {
  ListeningPendingContent,
  ReadingPassageContent,
  TranslationPromptContent,
  VocabularySetContent,
  WritingPromptContent,
} from "./types";

/**
 * 练习内容库（原创，版本化 seed data）。
 *
 * 每份材料都标注 estimatedMinutes，planner 依赖它做时间预算。
 * 不做真题库 —— 这些是为训练特定能力而写的原创材料。
 */

export const READING_PASSAGES: ReadingPassageContent[] = [
  {
    id: "read-city-trees",
    type: "reading_passage",
    title: "为什么城市需要树",
    passage:
      "City planners once treated trees as decoration. A new street was designed for traffic first, and whatever green space remained was planted at the end, if the budget allowed it. That order of priorities is now being reversed in a number of cities, not out of sentiment but out of measurement.\n\nStudies of urban heat have found that a mature tree canopy can lower surface temperatures on a street by several degrees. The effect is largest at night, when asphalt releases the heat it absorbed during the day, which is precisely when heat-related illness peaks. Shade also lengthens the life of road surfaces, reducing maintenance costs that cities would otherwise pay repeatedly.\n\nThe argument becomes harder to dismiss when the benefits are converted into the same units the planners already use. A single large tree can intercept thousands of litres of storm water a year, which is water that does not have to be handled by an underground pipe built at considerable expense. Air quality improves measurably along tree-lined corridors, and property values follow.\n\nThe obstacle is not scepticism but time. A tree planted today delivers almost none of these benefits for a decade, while a wider road delivers its benefits immediately. Political cycles reward the visible. Choosing trees means accepting that the person who benefits may not be the person who decides — and that is a harder argument to make than any calculation.",
    wordCount: 243,
    questions: [
      {
        id: "read-city-trees-q1",
        prompt: "What change does the first paragraph describe?",
        choices: [
          { id: "a", label: "Trees are now planted only when budgets allow." },
          { id: "b", label: "The priority given to trees relative to traffic is being reconsidered." },
          { id: "c", label: "City planners have stopped designing for traffic." },
          { id: "d", label: "Decoration has become the main purpose of urban trees." },
        ],
        correctChoiceId: "b",
        explanation:
          "第一段说过去的顺序是「先交通、后绿化」，而 that order of priorities is now being reversed，即优先级顺序正在被颠倒。",
        errorTag: "reading.main_idea",
      },
      {
        id: "read-city-trees-q2",
        prompt: "Why is the cooling effect most valuable at night?",
        choices: [
          { id: "a", label: "Trees grow faster in cooler conditions." },
          { id: "b", label: "Traffic is lighter and so measurement is easier." },
          { id: "c", label: "It coincides with the peak of heat-related illness." },
          { id: "d", label: "Asphalt stops absorbing heat after sunset." },
        ],
        correctChoiceId: "c",
        explanation: "第二段明确说夜间正是 heat-related illness peaks 的时候。",
        errorTag: "reading.detail",
      },
      {
        id: "read-city-trees-q3",
        prompt: "The phrase \"converted into the same units the planners already use\" suggests that the author values ______.",
        choices: [
          { id: "a", label: "appealing to planners' existing decision framework" },
          { id: "b", label: "replacing cost analysis with environmental arguments" },
          { id: "c", label: "reducing the expense of underground pipes" },
          { id: "d", label: "measuring air quality more precisely" },
        ],
        correctChoiceId: "a",
        explanation:
          "作者把效益换算成规划者已经在用的单位（成本、维护费），说明他重视进入对方既有的决策框架。",
        errorTag: "reading.inference",
      },
      {
        id: "read-city-trees-q4",
        prompt: "What is identified as the main obstacle to planting more trees?",
        choices: [
          { id: "a", label: "Scientific disagreement about the benefits." },
          { id: "b", label: "The delay between planting and benefit." },
          { id: "c", label: "The shortage of suitable urban land." },
          { id: "d", label: "Public opposition to higher property values." },
        ],
        correctChoiceId: "b",
        explanation: "最后一段首句直接给出答案：The obstacle is not scepticism but time。",
        errorTag: "reading.detail",
      },
      {
        id: "read-city-trees-q5",
        prompt: "What does the last sentence imply about political decision-making?",
        choices: [
          { id: "a", label: "Calculations are usually unreliable in politics." },
          { id: "b", label: "Long-term benefits are structurally disadvantaged." },
          { id: "c", label: "Road widening is always the cheaper option." },
          { id: "d", label: "Decision-makers are unaware of the research." },
        ],
        correctChoiceId: "b",
        explanation:
          "「受益者未必是决策者」意味着长周期收益在短期政治回报机制下处于结构性劣势。",
        errorTag: "reading.inference",
      },
    ],
    estimatedMinutes: 12,
    tags: ["reading.main_idea", "reading.inference", "reading.detail"],
  },
  {
    id: "read-sleep-learning",
    type: "reading_passage",
    title: "睡眠与记忆固化",
    passage:
      "The idea that sleep helps learning has moved from folk wisdom to laboratory finding, but the mechanism matters more than the headline. During deep sleep the brain replays patterns of activity recorded during the day, and the sequences it replays are not always the ones that were practised longest.\n\nWhat appears to determine which material gets consolidated is not total study time but the difficulty of retrieval. Material that was hard to recall, yet eventually recalled correctly, is preferentially strengthened. Material that was easy throughout the session receives comparatively little overnight benefit, because it was already stable.\n\nThis produces a counter-intuitive instruction. A study session that ends with an easy review, an hour of re-reading notes that already feel familiar, may feel productive and be nearly worthless for consolidation. A session that ends with a difficult attempt, one the learner gets partly wrong before correcting it, leaves the brain with something worth replaying.\n\nThe practical implication is not that sleep should be optimised at the expense of study, but that the two are a single process. Treating sleep as the recovery period after study, rather than as the second half of it, is a scheduling error with measurable costs.",
    wordCount: 219,
    questions: [
      {
        id: "read-sleep-learning-q1",
        prompt: "According to the passage, what determines which material is consolidated?",
        choices: [
          { id: "a", label: "The total number of hours spent studying." },
          { id: "b", label: "The difficulty of retrieving it." },
          { id: "c", label: "How recently the material was first encountered." },
          { id: "d", label: "Whether the material was read aloud." },
        ],
        correctChoiceId: "b",
        explanation: "第二段明确指出决定因素是 difficulty of retrieval，而不是总学习时长。",
        errorTag: "reading.main_idea",
      },
      {
        id: "read-sleep-learning-q2",
        prompt: "What does the author say about re-reading familiar notes?",
        choices: [
          { id: "a", label: "It is the most reliable way to consolidate material." },
          { id: "b", label: "It should replace difficult practice before an exam." },
          { id: "c", label: "It feels useful but contributes little to consolidation." },
          { id: "d", label: "It strengthens material that was hard to recall." },
        ],
        correctChoiceId: "c",
        explanation: "第三段说这类复习 may feel productive and be nearly worthless for consolidation。",
        errorTag: "reading.inference",
      },
      {
        id: "read-sleep-learning-q3",
        prompt: "The word \"preferentially\" in paragraph 2 is closest in meaning to ______.",
        choices: [
          { id: "a", label: "in preference to others" },
          { id: "b", label: "with strong reluctance" },
          { id: "c", label: "in an unpredictable way" },
          { id: "d", label: "only under supervision" },
        ],
        correctChoiceId: "a",
        explanation: "preferentially 表示「优先地、有区别对待地」。",
        errorTag: "reading.vocab_in_context",
      },
      {
        id: "read-sleep-learning-q4",
        prompt: "What is the author's main practical argument?",
        choices: [
          { id: "a", label: "Students should sleep less in order to study more." },
          { id: "b", label: "Sleep should be understood as part of studying, not recovery from it." },
          { id: "c", label: "Study sessions should always end with easy material." },
          { id: "d", label: "Laboratory findings rarely apply to real learners." },
        ],
        correctChoiceId: "b",
        explanation:
          "末段提出两者是 a single process，把睡眠当作学习的另一半而非恢复期。",
        errorTag: "reading.main_idea",
      },
    ],
    estimatedMinutes: 11,
    tags: ["reading.inference", "reading.vocab_in_context"],
  },
];

export const VOCABULARY_SETS: VocabularySetContent[] = [
  {
    id: "vocab-academic-verbs",
    type: "vocabulary_set",
    title: "学术语境高频动词",
    entries: [
      {
        id: "vocab-av-01",
        word: "attribute",
        phonetic: "/əˈtrɪbjuːt/",
        sentence: "Researchers ______ the decline to changes in rainfall.",
        gapIndex: 1,
        choices: [
          { id: "a", label: "attribute" },
          { id: "b", label: "contribute" },
          { id: "c", label: "distribute" },
          { id: "d", label: "substitute" },
        ],
        correctChoiceId: "a",
        definition: "attribute A to B：把 A 归因于 B。",
        errorTag: "vocab.confusable_pair",
      },
      {
        id: "vocab-av-02",
        word: "alleviate",
        phonetic: "/əˈliːvieɪt/",
        sentence: "The new policy did little to ______ pressure on small firms.",
        gapIndex: 1,
        choices: [
          { id: "a", label: "aggravate" },
          { id: "b", label: "alleviate" },
          { id: "c", label: "allocate" },
          { id: "d", label: "accelerate" },
        ],
        correctChoiceId: "b",
        definition: "alleviate：减轻（痛苦、压力）。与 aggravate 构成反义。",
        errorTag: "vocab.confusable_pair",
      },
      {
        id: "vocab-av-03",
        word: "undermine",
        phonetic: "/ˌʌndəˈmaɪn/",
        sentence: "Repeated delays gradually ______ public confidence in the project.",
        gapIndex: 1,
        choices: [
          { id: "a", label: "underlie" },
          { id: "b", label: "undertake" },
          { id: "c", label: "undermine" },
          { id: "d", label: "undergo" },
        ],
        correctChoiceId: "c",
        definition: "undermine：逐渐削弱（信心、地位、基础）。",
        errorTag: "vocab.near_form",
      },
      {
        id: "vocab-av-04",
        word: "deteriorate",
        phonetic: "/dɪˈtɪəriəreɪt/",
        sentence: "Air quality began to ______ after the factory reopened.",
        gapIndex: 1,
        choices: [
          { id: "a", label: "deteriorate" },
          { id: "b", label: "determine" },
          { id: "c", label: "detach" },
          { id: "d", label: "delegate" },
        ],
        correctChoiceId: "a",
        definition: "deteriorate：恶化。正式语境中替代 get worse。",
        errorTag: "vocab.near_form",
      },
      {
        id: "vocab-av-05",
        word: "incur",
        phonetic: "/ɪnˈkɜː/",
        sentence: "Students who miss the deadline may ______ an additional fee.",
        gapIndex: 1,
        choices: [
          { id: "a", label: "incur" },
          { id: "b", label: "incline" },
          { id: "c", label: "indulge" },
          { id: "d", label: "integrate" },
        ],
        correctChoiceId: "a",
        definition: "incur：招致（费用、损失、后果）。",
        errorTag: "vocab.collocation",
      },
      {
        id: "vocab-av-06",
        word: "avert",
        phonetic: "/əˈvɜːt/",
        sentence: "Quick action by the crew ______ a serious accident.",
        gapIndex: 1,
        choices: [
          { id: "a", label: "asserted" },
          { id: "b", label: "averted" },
          { id: "c", label: "avenged" },
          { id: "d", label: "adverted" },
        ],
        correctChoiceId: "b",
        definition: "avert：避免（危险、灾难）；也指移开（目光）。",
        errorTag: "vocab.near_form",
      },
    ],
    estimatedMinutes: 8,
    tags: ["vocab.collocation", "vocab.near_form"],
  },
];

export const TRANSLATION_PROMPTS: TranslationPromptContent[] = [
  {
    id: "trans-train-01",
    type: "translation_prompt",
    title: "城市化与通勤",
    sourceText:
      "随着城市不断向外扩张，许多人的通勤时间越来越长，这不仅消耗了他们的精力，也改变了家庭生活的方式。",
    referenceTranslation:
      "As cities continue to expand outward, many people face increasingly long commutes, which not only drains their energy but also changes the way family life is organised.",
    keyPoints: ["as cities continue to expand", "increasingly long commutes", "drains their energy", "changes the way family life is organised"],
    estimatedMinutes: 6,
    tags: ["translation.sentence_split", "translation.relative_clause"],
  },
  {
    id: "trans-train-02",
    type: "translation_prompt",
    title: "传统手工艺",
    sourceText:
      "尽管机器生产已经能够满足绝大部分需求，传统手工艺依然在一部分人当中保持着吸引力，因为它承载的不只是实用价值。",
    referenceTranslation:
      "Although machine production can already meet the vast majority of demand, traditional handicrafts remain attractive to some people, because what they carry is not merely practical value.",
    keyPoints: ["machine production", "meet the vast majority of demand", "remain attractive to some people", "not merely practical value", "what they carry"],
    estimatedMinutes: 6,
    tags: ["translation.concessive_clause", "translation.noun_clause"],
  },
  {
    id: "trans-train-03",
    type: "translation_prompt",
    title: "公共图书馆",
    sourceText:
      "公共图书馆的价值并不只体现在借阅量上，更重要的是它为一个社区提供了一个任何人都可以进入的安静空间。",
    referenceTranslation:
      "The value of a public library is not measured only by how many books are borrowed; more importantly, it provides a community with a quiet space that anyone may enter.",
    keyPoints: ["not measured only by", "more importantly", "provides a community with", "a quiet space", "anyone may enter"],
    estimatedMinutes: 6,
    tags: ["translation.contrast", "translation.attributive_clause"],
  },
];

export const WRITING_PROMPTS: WritingPromptContent[] = [
  {
    id: "write-train-01",
    type: "writing_prompt",
    title: "是否应该限制大学生使用手机",
    prompt:
      "Some universities restrict mobile phone use during lectures. Write an essay of 120-180 words stating whether you agree with such restrictions and why.",
    minWords: 120,
    maxWords: 180,
    rubricPoints: [
      "a clear statement of position in the introduction",
      "at least two supporting reasons",
      "a concrete example or evidence",
      "transition words linking the paragraphs",
      "a conclusion that restates the position",
    ],
    estimatedMinutes: 25,
    tags: ["writing.argument", "writing.structure"],
  },
  {
    id: "write-train-02",
    type: "writing_prompt",
    title: "线上学习的利弊",
    prompt:
      "Write an essay of 120-180 words on the advantages and disadvantages of online learning for university students.",
    minWords: 120,
    maxWords: 180,
    rubricPoints: [
      "a clear statement of position in the introduction",
      "one advantage and one disadvantage",
      "transition words linking the paragraphs",
      "a conclusion that restates the position",
    ],
    estimatedMinutes: 25,
    tags: ["writing.structure"],
  },
];

/**
 * 听力内容的正式 pending 记录。
 * 这不是"忘了做"，而是明确记录 Phase 1 的素材缺口及其补全条件。
 */
export const LISTENING_PENDING: ListeningPendingContent[] = [
  {
    id: "listen-pending-short-conversation",
    type: "listening_pending",
    title: "短对话理解",
    reason:
      "CET-6 听力短对话需要音频素材与配套题目。Phase 1 未内置音频，也不使用来源不明的真题音频。",
    requiredAssets: ["8 段 30-60 秒原创英文对话音频", "每段 1-2 道配套选择题", "音频文本稿（用于解析）"],
    estimatedMinutes: 10,
    tags: ["listening.audio_required"],
  },
  {
    id: "listen-pending-lecture",
    type: "listening_pending",
    title: "讲座/讲话理解",
    reason: "讲座题型需要 2-3 分钟的英文音频材料，同样属于 Phase 1 范围外的素材缺口。",
    requiredAssets: ["3 段 2-3 分钟原创英文学术讲座音频", "每段 3 道配套题目", "完整音频文本稿"],
    estimatedMinutes: 15,
    tags: ["listening.audio_required"],
  },
];
