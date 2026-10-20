import { gradeWithRubric } from "@/domain/scoring";
import {
  AI_STUB_DISCLAIMER,
  AI_UNAVAILABLE_MESSAGE,
  type AIGradingProvider,
  type AIResult,
  type DimensionFeedback,
  type ErrorExplanationInput,
  type TranslationGradingInput,
  type WritingGradingInput,
} from "../provider";

/**
 * 本地确定性 stub。
 *
 * 用途明确：开发期与"未配置 API key"时的降级路径，保证产品在这些情况下仍可用。
 * 所有输出都带 `source: "local-stub"` 与 disclaimer，UI 有义务如实展示，不得冒充 AI。
 */

const STRUCTURE_CHECKS = [
  { label: "开头段", patterns: ["first", "nowadays", "recently", "with the development"], errorTag: "writing.intro_missing" },
  { label: "结尾段", patterns: ["in conclusion", "to sum up", "in a word", "all in all"], errorTag: "writing.conclusion_missing" },
  { label: "论证连接词", patterns: ["because", "therefore", "moreover", "however", "furthermore"], errorTag: "writing.cohesion_weak" },
  { label: "举例或数据", patterns: ["for example", "for instance", "such as", "studies show"], errorTag: "writing.no_support" },
];

export class LocalStubGradingProvider implements AIGradingProvider {
  readonly id = "local-stub";

  isAvailable(): boolean {
    return true;
  }

  async gradeWriting(input: WritingGradingInput): Promise<AIResult<DimensionFeedback>> {
    const words = input.essay.trim().split(/\s+/).filter(Boolean);
    const lower = input.essay.toLowerCase();
    const issues: DimensionFeedback["issues"] = [];

    const min = input.minWords ?? 120;
    const max = input.maxWords ?? 180;

    if (words.length < min) {
      issues.push({
        label: "字数不足",
        detail: `当前约 ${words.length} 词，低于要求的下限 ${min} 词。字数不足会直接影响内容完整性评分。`,
        errorTag: "writing.too_short",
        severity: 3,
      });
    } else if (words.length > max * 1.2) {
      issues.push({
        label: "篇幅超限",
        detail: `当前约 ${words.length} 词，明显超过 ${max} 词上限，考试中会占用其他模块时间。`,
        errorTag: "writing.too_long",
        severity: 2,
      });
    }

    // 句长方差：全部短句通常意味着句式单一
    const sentences = input.essay.split(/[.!?]+/).map((s) => s.trim()).filter(Boolean);
    const avgLen = sentences.length === 0 ? 0 : words.length / sentences.length;

    for (const check of STRUCTURE_CHECKS) {
      if (!check.patterns.some((p) => lower.includes(p))) {
        issues.push({
          label: `缺少${check.label}`,
          detail: `未检测到${check.label}的典型表达。这是结构性提示，不是语义判断。`,
          errorTag: check.errorTag,
          severity: check.label === "论证连接词" ? 2 : 1,
        });
      }
    }

    const hasVariedLength = sentences.some((s) => s.split(/\s+/).length > 20);
    if (!hasVariedLength && sentences.length > 2) {
      issues.push({
        label: "句式偏单一",
        detail: `平均句长约 ${avgLen.toFixed(1)} 词，未出现明显长句。建议至少加入一个从句结构。`,
        errorTag: "writing.sentence_monotony",
        severity: 2,
      });
    }

    // 本地评分：结构性要点覆盖率，明确窄于真实批改维度。
    const structuralPass = STRUCTURE_CHECKS.length - issues.filter((i) => i.errorTag.startsWith("writing.") && i.severity >= 2).length;
    const lengthOk = words.length >= min && words.length <= max * 1.2 ? 1 : 0.5;
    const score = Math.max(0, Math.min(1, (structuralPass / STRUCTURE_CHECKS.length) * 0.6 + lengthOk * 0.4));

    return {
      status: "ok",
      source: "local-stub",
      providerId: this.id,
      message: AI_UNAVAILABLE_MESSAGE,
      data: {
        score: Number(score.toFixed(2)),
        summary: `本地规则评分 ${(score * 100).toFixed(0)} 分（百分制换算前）。检查了字数、段落结构、衔接词与句式变化，共 ${issues.length} 处待改进。`,
        issues,
        suggestions: [
          "先用固定三段结构把框架立住：引入 → 两个分论点 → 结论。",
          "每个分论点补一个具体例子，避免纯抽象论述。",
          "刻意安排至少一个 20 词以上的复合句，提升句式得分。",
        ],
        disclaimer: AI_STUB_DISCLAIMER,
      },
    };
  }

  async gradeTranslation(input: TranslationGradingInput): Promise<AIResult<DimensionFeedback>> {
    const rubricPoints = input.referenceTranslation
      .split(/[；;。.]/)
      .map((s) => s.trim())
      .filter((s) => s.length > 6);

    const graded = gradeWithRubric(input.userTranslation, rubricPoints);
    const issues: DimensionFeedback["issues"] = graded.missed.map((point) => ({
      label: "要点未覆盖",
      detail: `参考译文中的这个信息点在你的译文中未匹配到：${point}`,
      errorTag: "translation.missing_point",
      severity: 2 as const,
    }));

    const wordCount = input.userTranslation.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount === 0) {
      issues.push({
        label: "未作答",
        detail: "翻译区域为空。",
        errorTag: "translation.empty",
        severity: 3,
      });
    }

    return {
      status: "ok",
      source: "local-stub",
      providerId: this.id,
      message: AI_UNAVAILABLE_MESSAGE,
      data: {
        score: Number(graded.score.toFixed(2)),
        summary: `关键信息点覆盖率 ${(graded.score * 100).toFixed(0)}%。这是结构匹配检查，不是语义等价判断；表达质量、搭配和语体均未被评估。`,
        issues,
        suggestions: [
          "先把中文长句切成若干个英文主谓结构，再逐块翻译，最后合并。",
          "关注专有名词与固定译法，这类点是硬性扣分项。",
          "译完后回读一遍，检查是否有漏译的中文分句。",
        ],
        disclaimer: AI_STUB_DISCLAIMER,
      },
    };
  }

  async explainError(input: ErrorExplanationInput): Promise<AIResult<string>> {
    return {
      status: "ok",
      source: "local-stub",
      providerId: this.id,
      message: AI_UNAVAILABLE_MESSAGE,
      data: `你的选择：${input.userAnswer}；正确答案：${input.correctAnswer}。本地规则无法解释语义层面的错误原因，只记录该题所属维度为「${input.dimension}」。接入 AI 服务后这里会给出具体错因分析。`,
    };
  }
}
