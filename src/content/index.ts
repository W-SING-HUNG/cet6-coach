import type { DiagnosticDimension, Skill } from "@/domain/types";
import { LISTENING_PENDING, READING_PASSAGES, TRANSLATION_PROMPTS, VOCABULARY_SETS, WRITING_PROMPTS } from "./practice-library";
import type { ContentItem, ContentRepository, ContentType } from "./types";

/**
 * 内容仓库实现。
 *
 * UI 与 planner 只能通过这个接口取内容，不得直接 import 具体内容模块 ——
 * 这样未来把内容换成数据库或 AI 生成时，调用方无需改动。
 */

function buildIndex(): Map<string, ContentItem> {
  const index = new Map<string, ContentItem>();
  const all: ContentItem[] = [
    ...READING_PASSAGES,
    ...VOCABULARY_SETS,
    ...TRANSLATION_PROMPTS,
    ...WRITING_PROMPTS,
    ...LISTENING_PENDING,
  ];
  for (const item of all) {
    if (index.has(item.id)) {
      throw new Error(`内容 id 重复：${item.id}`);
    }
    index.set(item.id, item);
  }
  return index;
}

export class StaticContentRepository implements ContentRepository {
  private readonly index = buildIndex();

  getItem(type: ContentType, id: string): ContentItem | null {
    const item = this.index.get(id);
    return item && item.type === type ? item : null;
  }

  getReadingPassage(id: string) {
    const item = this.index.get(id);
    return item?.type === "reading_passage" ? item : null;
  }

  getVocabularySet(id: string) {
    const item = this.index.get(id);
    return item?.type === "vocabulary_set" ? item : null;
  }

  getTranslationPrompt(id: string) {
    const item = this.index.get(id);
    return item?.type === "translation_prompt" ? item : null;
  }

  getWritingPrompt(id: string) {
    const item = this.index.get(id);
    return item?.type === "writing_prompt" ? item : null;
  }

  getListeningPending(id: string) {
    const item = this.index.get(id);
    return item?.type === "listening_pending" ? item : null;
  }

  listReadingPassages() {
    return [...READING_PASSAGES];
  }

  listVocabularySets() {
    return [...VOCABULARY_SETS];
  }

  listTranslationPrompts() {
    return [...TRANSLATION_PROMPTS];
  }

  listWritingPrompts() {
    return [...WRITING_PROMPTS];
  }

  listListeningPending() {
    return [...LISTENING_PENDING];
  }

  /**
   * 按技能挑选内容。使用 seed 做确定性轮换 —— 不使用随机数，
   * 保证同一天生成的计划在多次渲染中稳定一致。
   */
  pickForSkill(skill: DiagnosticDimension, seed: number): ContentItem | null {
    const pool = this.poolFor(skill);
    if (pool.length === 0) return null;
    const index = Math.abs(seed) % pool.length;
    return pool[index];
  }

  private poolFor(skill: Skill | DiagnosticDimension): ContentItem[] {
    switch (skill) {
      case "reading":
        return READING_PASSAGES;
      case "writing":
        return WRITING_PROMPTS;
      case "translation":
        return TRANSLATION_PROMPTS;
      case "listening":
        return LISTENING_PENDING;
      case "vocabulary":
        return VOCABULARY_SETS;
      default:
        return [];
    }
  }
}

export const contentRepository: ContentRepository = new StaticContentRepository();

export * from "./types";
