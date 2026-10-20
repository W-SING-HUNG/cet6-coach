import { CONTENT_TYPES as CONTENT_TYPE_LIST } from "@/domain/types";
import type { ContentType, DiagnosticDimension } from "@/domain/types";

/**
 * 内容模型。
 *
 * 内容以版本化 TypeScript 模块存在，便于 diff、review 与类型检查。
 * 所有内容均为本项目原创，不复制任何来源不明的真题或教材。
 */

export interface ContentChoice {
  id: string;
  label: string;
}

export interface ContentQuestion {
  id: string;
  prompt: string;
  choices: ContentChoice[];
  correctChoiceId: string;
  explanation: string;
  /** 该题考查的错因标签，答错时写入 attempt 并可能生成 review item */
  errorTag: string;
}

export interface ReadingPassageContent {
  id: string;
  type: "reading_passage";
  title: string;
  passage: string;
  wordCount: number;
  questions: ContentQuestion[];
  estimatedMinutes: number;
  tags: string[];
}

export interface VocabularyEntry {
  id: string;
  word: string;
  phonetic: string;
  sentence: string;
  gapIndex: number;
  choices: ContentChoice[];
  correctChoiceId: string;
  definition: string;
  errorTag: string;
}

export interface VocabularySetContent {
  id: string;
  type: "vocabulary_set";
  title: string;
  entries: VocabularyEntry[];
  estimatedMinutes: number;
  tags: string[];
}

export interface TranslationPromptContent {
  id: string;
  type: "translation_prompt";
  title: string;
  sourceText: string;
  referenceTranslation: string;
  keyPoints: string[];
  estimatedMinutes: number;
  tags: string[];
}

export interface WritingPromptContent {
  id: string;
  type: "writing_prompt";
  title: string;
  prompt: string;
  minWords: number;
  maxWords: number;
  rubricPoints: string[];
  estimatedMinutes: number;
  tags: string[];
}

/**
 * 听力内容的正式占位形态。
 * Phase 1 没有音频素材，此类型让 UI 能渲染真实的 pending 状态，
 * 而不是把缺素材伪装成"已完成"或塞一个假播放器。
 */
export interface ListeningPendingContent {
  id: string;
  type: "listening_pending";
  title: string;
  reason: string;
  /** Phase 2 需要补什么，写在数据里而不是散落在注释 */
  requiredAssets: string[];
  estimatedMinutes: number;
  tags: string[];
}

export type ContentItem =
  | ReadingPassageContent
  | VocabularySetContent
  | TranslationPromptContent
  | WritingPromptContent
  | ListeningPendingContent;

/**
 * content 层的内容类型必须与 domain 层的 CONTENT_TYPES 完全一致。
 * domain 层不能依赖 content 层，因此这里用编译期断言守住两边不漂移：
 * 任何一侧新增/删除类型而另一侧没跟上，下面这行就会报错。
 */
type DomainContentType = (typeof CONTENT_TYPE_LIST)[number];
type _TypesMatch = ContentItem["type"] extends DomainContentType
  ? DomainContentType extends ContentItem["type"]
    ? true
    : never
  : never;
// 若两边不一致，_TypesMatch 会退化为 never，这里的赋值即报错
const _contentTypeGuard: _TypesMatch = true;
void _contentTypeGuard;

export type { ContentType };

export interface ContentRepository {
  getItem(type: ContentType, id: string): ContentItem | null;
  getReadingPassage(id: string): ReadingPassageContent | null;
  getVocabularySet(id: string): VocabularySetContent | null;
  getTranslationPrompt(id: string): TranslationPromptContent | null;
  getWritingPrompt(id: string): WritingPromptContent | null;
  getListeningPending(id: string): ListeningPendingContent | null;
  listReadingPassages(): ReadingPassageContent[];
  listVocabularySets(): VocabularySetContent[];
  listTranslationPrompts(): TranslationPromptContent[];
  listWritingPrompts(): WritingPromptContent[];
  listListeningPending(): ListeningPendingContent[];
  /** 供 planner 分配内容时使用：按维度随机但有确定性的挑选 */
  pickForSkill(skill: DiagnosticDimension, seed: number): ContentItem | null;
}
