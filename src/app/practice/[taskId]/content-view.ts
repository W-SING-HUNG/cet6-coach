import type { ContentItem } from "@/content";
import type { Skill } from "@/domain/types";
import type { StudyTask } from "@/domain/models";

/**
 * 内容 → 视图模型。
 *
 * 在服务端完成转换，客户端组件只接收渲染必需的数据。
 * 正确答案**不下发到客户端**（除主观题参考译文外），避免在浏览器里看到答案。
 */

export type QuestionView = {
  id: string;
  prompt: string;
  choices: { id: string; label: string }[];
  /** 仅用于展示，不包含正确答案 */
  hint?: string;
};

/**
 * 任务内容的客户端视图。
 *
 * ── 为什么**没有** `reading` 这一支 ──
 *
 * 面向 CET-6 的阅读训练只使用真实历年真题，而这部分正文来自私有规范包
 * （由 `content/paper` 按内容版本读取），从来不在 `practice-library.ts` 里。
 * 因此"把阅读篇章渲染成客户端视图"这件事在收敛之后**不应该存在**。
 *
 * 与其留一个永远不会被正当调用的分支（它迟早会被某条遗漏路径用上），
 * 这里直接让它在**类型层**不可能出现 —— 见下面 `reading_passage` 的映射。
 */
export type ContentView =
  | { kind: "vocabulary"; title: string; entries: Array<{ id: string; word: string; phonetic: string; sentence: string; choices: { id: string; label: string }[] }>; estimatedMinutes: number }
  | { kind: "translation"; title: string; sourceText: string; estimatedMinutes: number }
  | { kind: "writing"; title: string; prompt: string; minWords: number; maxWords: number; estimatedMinutes: number }
  | { kind: "listening_pending"; title: string; reason: string; required: string[]; estimatedMinutes: number }
  | { kind: "review"; title: string; estimatedMinutes: number }
  | { kind: "unsupported"; title: string; reason: string };

export function getContentView(detail: {
  task: StudyTask;
  content: ContentItem | null;
  unavailableReason: string | null;
}): ContentView {
  const { task, content, unavailableReason } = detail;

  if (unavailableReason) {
    return { kind: "unsupported", title: task.title, reason: unavailableReason };
  }

  if (task.kind === "review" || task.contentRef?.contentType === "review_deck") {
    return { kind: "review", title: task.title, estimatedMinutes: task.estimatedMinutes };
  }

  if (!content) {
    return {
      kind: "unsupported",
      title: task.title,
      reason: "该任务没有绑定可执行的内容。请到 Today 重新生成计划。",
    };
  }

  switch (content.type) {
    /**
     * 内容库里的合成阅读篇章。
     *
     * 这个分支**刻意不产出可渲染的视图**。收敛之后，面向学习者的阅读训练
     * 只走真实真题的 Expert Training 工作面；如果某条历史计划行仍然引用
     * `practice-library.ts` 的篇章，路由层会先把它重定向到规范工作面，
     * 或者在无可用的真实材料时如实报不可用。
     *
     * 万一有调用方绕过那条分流走到这里，得到的也是一个明确的"不受支持"，
     * 而不是一篇看起来正常的合成阅读题 —— 后者会让自造材料冒充真题训练。
     */
    case "reading_passage":
      return {
        kind: "unsupported",
        title: content.title,
        reason:
          "这条任务引用的是产品自造的练习篇章，而面向 CET-6 的阅读训练现在只使用真实历年真题。" +
          "请回到 Today 让计划重新生成 —— 它会给出一条真实真题阅读训练。",
      };
    case "vocabulary_set":
      return {
        kind: "vocabulary",
        title: content.title,
        estimatedMinutes: content.estimatedMinutes,
        entries: content.entries.map((e) => ({
          id: e.id,
          word: e.word,
          phonetic: e.phonetic,
          sentence: e.sentence,
          choices: e.choices,
        })),
      };
    case "translation_prompt":
      return {
        kind: "translation",
        title: content.title,
        sourceText: content.sourceText,
        estimatedMinutes: content.estimatedMinutes,
      };
    case "writing_prompt":
      return {
        kind: "writing",
        title: content.title,
        prompt: content.prompt,
        minWords: content.minWords,
        maxWords: content.maxWords,
        estimatedMinutes: content.estimatedMinutes,
      };
    case "listening_pending":
      return {
        kind: "listening_pending",
        title: content.title,
        reason: content.reason,
        required: content.requiredAssets,
        estimatedMinutes: content.estimatedMinutes,
      };
  }
}

export type { StudyTask, Skill };
