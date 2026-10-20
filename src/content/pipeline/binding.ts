/**
 * 跨来源内容绑定（CROSS_SOURCE_BINDING）。
 *
 * ── 要解决的问题（本次修复的核心缺陷）──
 *
 * 早先的实现把第三方听力文字稿的题干直接接到包上，判据只有
 * "sources.json 声明它是第 N 套"。实测该判据**完全不可靠**：
 * 被导入的 2024-06 试卷，其**印出选项**属于一个内容族（记为 B 族），
 * 而所绑文字稿的题干属于另一个族（A 族）。结果是 25 个口语题干中
 * 多数的题干与印出选项说的不是同一段录音 —— 而所有结构校验器全绿。
 *
 * ── 为什么不用关键词重合度打分 ──
 *
 * "题干里出现几个选项中的词"这种相似度是**统计判据**：它对正确绑定与错误绑定
 * 都可能给出中等分数，无法给出"是/不是"的结论，也无法解释为什么。
 * 用它来**自动**决定绑定，等于把猜测写成事实。
 *
 * ── 本模块的判据：可证明的绑定，而非相似的绑定 ──
 *
 * | 证据类型 | 含义 | 强度 |
 * | --- | --- | --- |
 * | `secondary_contains_options` | 来源自身印出了与主源同组同序的选项 | 强：可自动 |
 * | `discriminative_term_correlation` | 来源**整体**属于本卷内容族，且该组有长词命中 | 中：可自动 |
 * | `human_binding_artifact` | 人工工件记录等价证据，且指纹仍匹配 | 可自动（需证据） |
 * | `provider_set_label_only` | 只有套别号声明 | **不可** ⇒ REVIEW_REQUIRED |
 * | `none` | 无任何可用信息 | **不可** ⇒ REVIEW_REQUIRED |
 *
 * ── 族覆盖度是核心判据（实测分离度充分）──
 *
 * 以"本卷听力选项的长词（≥10 字母）在来源中的命中比例"衡量：
 *
 * | 来源 | 命中比例 | 判定 |
 * | --- | --- | --- |
 * | A 族文字稿（另一份试卷，必须拒绝） | **12.5%** | 不属同一族 |
 * | B 族文字稿（本卷正确来源） | **59.4%** | 属同一族 |
 * | 第三来源的题干页（B 族） | **45.3%** | 属同一族 |
 *
 * 阈值取 30%，两侧余量充分。**套别号从不参与判定。**
 *
 * 第三行刻意不点出来源站名：它是一条**实测校准记录**，工程含义全在
 * 那个比例上（它证明"非主源的题干页也能落进同一族"）。站名对读者没有
 * 增量信息，却会把一份对第三方内容覆盖率的公开评价留在仓库里。
 * 同类处理见 `sources.ts` 的适配器说明。
 */

import { createHash } from "node:crypto";
import type { ExamPaperContent } from "@/content/paper/types";
import type { ReviewItem } from "./types";
import { compact } from "./fidelity";
import { listeningGroupFingerprint, normalizeForFingerprint, stableStringify } from "./fingerprint";

// ---------------------------------------------------------------------------
// 证据模型
// ---------------------------------------------------------------------------

export type BindingEvidenceKind =
  | "secondary_contains_options"
  | "discriminative_term_correlation"
  | "human_binding_artifact"
  | "provider_set_label_only"
  | "none";

export interface BindingEvidence {
  kind: BindingEvidenceKind;
  detail: string;
  /** `automatically_sufficient` 才可以自动绑定。 */
  strength: "automatically_sufficient" | "review_only" | "insufficient";
  matchedNumbers: number[];
  totalNumbers: number;
  matchedTerms: string[];
}

export interface GroupBinding {
  from: number;
  to: number;
  primaryFingerprint: string;
  locator: string;
  providerSetLabel: string | null;
  evidence: BindingEvidence;
  bound: boolean;
}

/**
 * 人工绑定工件（`binding.json`）中的一条记录。
 *
 * 人工不能"直接声明绑定成立"—— 必须记录**据以判定的证据**，
 * 且必须绑定到主源选项指纹。内容变化时该工件自动失效。
 */
export interface HumanBindingArtifactRecord {
  from: number;
  to: number;
  primaryFingerprint: string;
  evidence: string;
  corroboratingLocator: string;
}

export interface HumanBindingArtifact {
  paperId: string;
  reviewer: string;
  reviewedAt: string;
  bindings: HumanBindingArtifactRecord[];
}

// ---------------------------------------------------------------------------
// 判别性术语（族覆盖度的基础）
// ---------------------------------------------------------------------------

/**
 * 判别性术语的判据：**长度 ≥ 10 的长词**。
 *
 * ── 为什么 6–9 字母的词不具判别力（实测数据）──
 *
 * 曾用"长度 ≥ 6 且不在常见词表"作为判据，实测**完全无法区分内容族**：
 * 两族在 6+ 字母词上都接近满载（`change`、`century`、`conflict` 在任何
 * 英语听力材料里都会出现）。那等于没有判据。
 *
 * ≥10 字母的词（`sponsorship`、`Copernican`、`extinction`、`individuality`）
 * 是实体性、题材性的，命中比例能清晰分离两个族（12.5% vs 59.4%）。
 */
export const DISCRIMINATIVE_MIN_LENGTH = 10;

/** 族判定阈值。实测错误族 12.5%、正确族 45–59%，取 30%。 */
export const FAMILY_COVERAGE_THRESHOLD = 0.3;

/** 保留词边界的归一化（**不能**用 compact —— 它会删掉空格）。 */
function wordsOf(text: string): string[] {
  return normalizeForFingerprint(text)
    .split(/[^a-z0-9']+/)
    .filter((word) => word.length > 0);
}

/** 从某题组的印出选项里提取判别性术语。 */
export function discriminativeTerms(paper: ExamPaperContent, from: number, to: number): string[] {
  const terms = new Set<string>();
  for (const section of paper.sections) {
    if (!section.type.startsWith("listening.")) continue;
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.kind !== "mcq" || question.number === null) continue;
        if (question.number < from || question.number > to) continue;
        for (const option of question.options) {
          for (const word of wordsOf(option.label)) {
            if (word.length >= DISCRIMINATIVE_MIN_LENGTH) terms.add(word);
          }
        }
      }
    }
  }
  return [...terms].sort();
}

/** 整卷听力的全部判别性术语。 */
export function allDiscriminativeTerms(paper: ExamPaperContent): string[] {
  return discriminativeTerms(paper, 1, 25);
}

/**
 * 族覆盖度：某来源命中了全卷判别性术语的多大比例。
 *
 * 这是区分"关于本卷来源"与"关于另一份试卷来源"的**核心判据**。
 */
export function familyCoverageRatio(
  paper: ExamPaperContent,
  secondaryNormalized: string,
): { ratio: number; matched: number; total: number; matchedTerms: string[] } {
  const terms = allDiscriminativeTerms(paper);
  const matchedTerms = terms.filter((term) => secondaryNormalized.includes(term));
  return {
    ratio: terms.length === 0 ? 0 : matchedTerms.length / terms.length,
    matched: matchedTerms.length,
    total: terms.length,
    matchedTerms,
  };
}

// ---------------------------------------------------------------------------
// 证据计算
// ---------------------------------------------------------------------------

function matchOptionsInSecondary(
  paper: ExamPaperContent,
  from: number,
  to: number,
  secondaryCompact: string,
): { matchedNumbers: number[]; total: number } {
  const matchedNumbers: number[] = [];
  let total = 0;
  for (const section of paper.sections) {
    if (!section.type.startsWith("listening.")) continue;
    for (const group of section.groups) {
      for (const question of group.questions) {
        if (question.kind !== "mcq" || question.number === null) continue;
        if (question.number < from || question.number > to) continue;
        total += 1;
        const options = question.options.map((option) => compact(option.label)).filter((text) => text.length >= 12);
        if (options.length === 0) continue;
        const hits = options.filter((option) => secondaryCompact.includes(option)).length;
        if (hits >= Math.ceil(options.length * 0.75)) matchedNumbers.push(question.number);
      }
    }
  }
  return { matchedNumbers, total };
}

export interface EvaluateBindingInput {
  paper: ExamPaperContent;
  from: number;
  to: number;
  locator: string;
  providerSetLabel: string | null;
  secondaryNormalized: string;
  secondaryCompact: string;
  family: { ratio: number; matched: number; total: number; matchedTerms: string[] };
  artifact: HumanBindingArtifactRecord | null;
}

/**
 * 判定某题组的绑定证据。
 *
 * **不存在"相似度够高就绑定"的分支。**
 */
export function evaluateBindingEvidence(input: EvaluateBindingInput): BindingEvidence {
  const { paper, from, to, secondaryNormalized, secondaryCompact, family } = input;

  // 证据 A：来源自身印出了同组选项（最强：逐条选项文本命中）
  const optionMatch = matchOptionsInSecondary(paper, from, to, secondaryCompact);
  if (optionMatch.total > 0 && optionMatch.matchedNumbers.length >= Math.ceil(optionMatch.total * 0.6)) {
    return {
      kind: "secondary_contains_options",
      detail:
        `该来源自身印出了该组的选项：${optionMatch.matchedNumbers.length}/${optionMatch.total} 题的选项文本逐条命中。` +
        `这是最强的内容层面证据，与套别号无关。`,
      strength: "automatically_sufficient",
      matchedNumbers: optionMatch.matchedNumbers,
      totalNumbers: optionMatch.total,
      matchedTerms: [],
    };
  }

  // 证据 B：族覆盖度（该来源是否整体讲的是本卷内容）+ 组内长词关联
  const groupTerms = discriminativeTerms(paper, from, to);
  const groupMatched = groupTerms.filter((term) => secondaryNormalized.includes(term));
  const familyPass = family.ratio >= FAMILY_COVERAGE_THRESHOLD;
  const groupHasEvidence = groupTerms.length === 0 ? familyPass : groupMatched.length > 0;

  if (familyPass && groupHasEvidence) {
    return {
      kind: "discriminative_term_correlation",
      detail:
        `**族覆盖度 ${(family.ratio * 100).toFixed(1)}%**（${family.matched}/${family.total} 个全卷判别性长词命中，` +
        `阈值 ${(FAMILY_COVERAGE_THRESHOLD * 100).toFixed(0)}%）—— 该来源整体讲的就是本卷听力内容；` +
        `该组另有 ${groupMatched.length} 个组内长词命中（${groupMatched.slice(0, 4).join(", ") || "无"}）。` +
        `套别号未参与判定。`,
      strength: "automatically_sufficient",
      matchedNumbers: [],
      totalNumbers: to - from + 1,
      matchedTerms: groupMatched,
    };
  }

  // 证据 C：**人工绑定工件**
  //
  // 顺序刻意放在族判据之后、结论之前：人工裁决可以**弥补**自动证据不足
  // （例如来源只覆盖个别题、或该来源是图片型无法比对文本），
  // 但它必须绑定到主源选项指纹 —— 内容一变该绑定即失效。
  //
  // 早先把工件检查放在族判据之后**且只在族通过时**才走，结果是
  // "族不足时人工工件完全不起作用"。那是凭据链的断裂：人工明确记录过
  // 证据的绑定，不该因为自动判据不足而被丢弃。
  if (input.artifact) {
    const matches = input.artifact.primaryFingerprint === listeningGroupFingerprint(paper, from, to);
    if (matches) {
      return {
        kind: "human_binding_artifact",
        detail:
          `人工绑定工件记录了该组的绑定依据：${input.artifact.evidence}` +
          `（交叉检验来源：${input.artifact.corroboratingLocator}）。` +
          `工件绑定的主源选项指纹与现场重算一致，因此该绑定当前有效。` +
          `自动证据不足的原因：族覆盖度 ${(family.ratio * 100).toFixed(1)}%，` +
          `组内长词命中 ${groupMatched.length} 个，选项文本命中 ${optionMatch.matchedNumbers.length}/${optionMatch.total} 题。`,
        strength: "automatically_sufficient",
        matchedNumbers: [],
        totalNumbers: to - from + 1,
        matchedTerms: [],
      };
    }
    // 指纹不匹配 ⇒ 内容已变，旧绑定失效
    return {
      kind: "provider_set_label_only",
      detail:
        `存在该组的人工绑定工件，但其记录的指纹（${input.artifact.primaryFingerprint.slice(0, 16)}…）` +
        `与现场重算（${listeningGroupFingerprint(paper, from, to).slice(0, 16)}…）不一致 —— ` +
        `**内容已变，旧绑定失效**。自动证据同样不足（族覆盖度 ${(family.ratio * 100).toFixed(1)}%）。`,
      strength: "insufficient",
      matchedNumbers: [],
      totalNumbers: to - from + 1,
      matchedTerms: groupMatched,
    };
  }

  if (!familyPass) {
    return {
      kind: input.providerSetLabel ? "provider_set_label_only" : "none",
      detail:
        (input.providerSetLabel ? `该来源自称「${input.providerSetLabel}」，但**套别号不是身份证据**。` : "") +
        `**族覆盖度仅 ${(family.ratio * 100).toFixed(1)}%**（${family.matched}/${family.total}，` +
        `需 ≥ ${(FAMILY_COVERAGE_THRESHOLD * 100).toFixed(0)}%）—— 该来源与本卷听力内容不属同一族，` +
        `其题干**不得**附加到本卷。组内长词命中 ${groupMatched.length} 个，选项文本命中 ${optionMatch.matchedNumbers.length}/${optionMatch.total} 题。`,
      strength: "insufficient",
      matchedNumbers: [],
      totalNumbers: to - from + 1,
      matchedTerms: groupMatched,
    };
  }

  return {
    kind: input.providerSetLabel ? "provider_set_label_only" : "none",
    detail:
      `该来源的整体族覆盖度达标（${(family.ratio * 100).toFixed(1)}%），但**该组没有任何判别性长词命中**` +
      `（该组共 ${groupTerms.length} 个长词）—— 无法确认该来源覆盖了这一组，需人工裁决。`,
    strength: "insufficient",
    matchedNumbers: [],
    totalNumbers: to - from + 1,
    matchedTerms: [],
  };
}

/** 对一份来源求值绑定。 */
export function evaluateBindings(
  paper: ExamPaperContent,
  locator: string,
  providerSetLabel: string | null,
  secondaryText: string,
  _otherSources: { locator: string; compact: string }[],
  artifact: HumanBindingArtifactRecord[],
  /**
   * 该来源**实际提供题干**的题号（可选）。
   *
   * 为什么需要它：补充来源可能只覆盖个别题（实测某来源只含 Q21）。
   * 若按整卷题组判定，它会因"没覆盖其他组"而整体失败 ——
   * 但它本来就不负责那些组。因此只判定它实际提供的题号所属的题组。
   */
  suppliedNumbers?: number[],
): GroupBinding[] {
  const groups: { from: number; to: number }[] = [];
  const supplied = suppliedNumbers ? new Set(suppliedNumbers) : null;

  for (const section of paper.sections) {
    if (!section.type.startsWith("listening.")) continue;
    for (const group of section.groups) {
      const numbers = group.questions
        .map((question) => question.number)
        .filter((value): value is number => value !== null);
      if (numbers.length === 0) continue;
      if (supplied && !numbers.some((number) => supplied.has(number))) continue;
      groups.push({ from: Math.min(...numbers), to: Math.max(...numbers) });
    }
  }

  const normalized = normalizeForFingerprint(secondaryText);
  const compactSecondary = compact(secondaryText);
  const family = familyCoverageRatio(paper, normalized);

  return [...groups]
    .sort((a, b) => a.from - b.from)
    .map((group) => {
      const fingerprint = listeningGroupFingerprint(paper, group.from, group.to);
      const record = artifact.find((entry) => entry.from === group.from && entry.to === group.to) ?? null;
      const evidence = evaluateBindingEvidence({
        paper,
        from: group.from,
        to: group.to,
        locator,
        providerSetLabel,
        secondaryNormalized: normalized,
        secondaryCompact: compactSecondary,
        family,
        artifact: record,
      });

      // 人工工件作为**补充**证据：自动证据不足、而工件指纹仍有效时采用
      if (evidence.strength !== "automatically_sufficient" && record && record.primaryFingerprint === fingerprint) {
        return {
          from: group.from,
          to: group.to,
          primaryFingerprint: fingerprint,
          locator,
          providerSetLabel,
          evidence: {
            kind: "human_binding_artifact" as const,
            detail:
              `人工绑定工件记录了该组的绑定依据：${record.evidence}` +
              `（交叉检验来源：${record.corroboratingLocator}）。` +
              `工件指纹与现场重算一致，因此该绑定当前有效。` +
              `自动证据不足的原因：${evidence.detail}`,
            strength: "automatically_sufficient" as const,
            matchedNumbers: [],
            totalNumbers: group.to - group.from + 1,
            matchedTerms: [],
          },
          bound: true,
        };
      }

      return {
        from: group.from,
        to: group.to,
        primaryFingerprint: fingerprint,
        locator,
        providerSetLabel,
        evidence,
        bound: evidence.strength === "automatically_sufficient",
      };
    });
}

/** 未绑定的题组转成阻断项。**绝不自动放行未绑定的题干。** */
export function unboundGroupsToReview(bindings: GroupBinding[]): ReviewItem[] {
  return bindings
    .filter((binding) => !binding.bound)
    .map((binding) => ({
      code: "listening_enrichment_unbound" as const,
      severity: "blocking" as const,
      where: `<enrichment>/Q${binding.from}-${binding.to}`,
      detail:
        `题组 Q${binding.from}–${binding.to} 的第三方题干**无法证明与主源印出选项属于同一内容**：` +
        `${binding.evidence.detail} 该组的题干不得附加到包上。`,
      evidence: `主源选项指纹 ${binding.primaryFingerprint.slice(0, 16)}…（来源：${binding.locator}）`,
    }));
}

/** 绑定摘要。 */
export function bindingSummary(bindings: GroupBinding[]): string {
  const bound = bindings.filter((binding) => binding.bound);
  if (bindings.length === 0) return "无条件绑定（该卷未提供第三方富集）";
  return (
    `${bound.length}/${bindings.length} 个题组建立了内容绑定` +
    `（依据：${[...new Set(bound.map((binding) => binding.evidence.kind))].join(", ") || "无"}）`
  );
}

/** 绑定记录的指纹。 */
export function bindingDigest(bindings: GroupBinding[]): string {
  return createHash("sha256")
    .update(
      stableStringify(
        bindings.map((binding) => ({
          from: binding.from,
          to: binding.to,
          fingerprint: binding.primaryFingerprint,
          kind: binding.evidence.kind,
          bound: binding.bound,
        })),
      ),
    )
    .digest("hex");
}

// ---------------------------------------------------------------------------
// 抓取页面导航垃圾
// ---------------------------------------------------------------------------

const NAVIGATION_MARKERS = [
  "扫一扫", "二维码", "关注公众号", "微信公众号", "版权均属", "任何媒体",
  "稿件来源", "转载稿", "并不意味着", "联系我们", "广告服务",
  "领取", "必背模板", "专项提升", "公开课", "更多>>", "热门推荐",
  "相关文章", "上一篇", "下一篇", "点击下图", "试题+答案", "完整版",
  "版权所有", "考试结束后", "估成绩", "对答案", "在线估分", "答案汇总",
  "小编", "供大家学习", "想了解更多", "未经本网", "免责声明",
];

/**
 * 识别抓取页面的导航/推广垃圾。
 *
 * 实测缺陷：来源页面的题干被抽成了版权声明与公众号推广文字
 * （`打开手机微信【扫一扫】…` / `凡本网注明"稿件来源…"`）。
 * 这类内容**不是试题内容**，必须识别并剔除。
 *
 * 判据刻意保守（只拦明显是站点 UI 的内容），避免误删真实题干：
 * 命中任一 UI 特征词即判垃圾；此外，真实听力题干都是疑问句，
 * 完全没有问句特征的短文本也判垃圾。
 *
 * ── 特征词表里刻意不含任何机构/品牌名 ──
 *
 * 早先的表里有两个具体品牌。把它们换成通用形态（`在线估分` / `答案汇总`）
 * 不削弱判定：真正起作用的特征是**页面 UI 的形状**（"扫一扫"、"版权均属"、
 * "估成绩"这类短语），不是它挂在哪个域名下。留着一个品牌名只会把一份
 * 对第三方网站的公开评价留在仓库里，收益是零。
 */
export function isNavigationGarbage(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === "") return true;
  if (NAVIGATION_MARKERS.some((marker) => trimmed.includes(marker))) return true;
  const looksLikeQuestion = /\?/.test(trimmed) || /^(what|why|how|which|who|where|when|according)\b/i.test(trimmed);
  return !looksLikeQuestion;
}

/** 过滤题干集合里的导航垃圾，返回剔除记录。 */
export function stripNavigationGarbage(stems: Record<number, string>): {
  kept: Record<number, string>;
  removed: { number: number; text: string }[];
} {
  const kept: Record<number, string> = {};
  const removed: { number: number; text: string }[] = [];
  for (const [key, value] of Object.entries(stems)) {
    const number = Number(key);
    if (isNavigationGarbage(value)) {
      removed.push({ number, text: value.slice(0, 200) });
      continue;
    }
    kept[number] = value;
  }
  return { kept, removed };
}

/** 来源内容摘要（供审计）。 */
export function sourceContentDigest(text: string): string {
  return createHash("sha256").update(normalizeForFingerprint(text)).digest("hex");
}

/** 校验人工绑定工件。 */
export function validateBindingArtifact(
  raw: unknown,
): { ok: boolean; errors: string[]; file: HumanBindingArtifact | null } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: ["绑定工件不是对象"], file: null };
  const candidate = raw as Partial<HumanBindingArtifact>;

  if (typeof candidate.paperId !== "string" || candidate.paperId.trim() === "") errors.push("paperId 缺失");
  if (typeof candidate.reviewer !== "string" || candidate.reviewer.trim() === "") errors.push("reviewer 缺失");
  if (typeof candidate.reviewedAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(candidate.reviewedAt)) {
    errors.push("reviewedAt 必须是 YYYY-MM-DD");
  }
  if (!Array.isArray(candidate.bindings)) {
    errors.push("bindings 必须是数组");
    return { ok: false, errors, file: null };
  }
  candidate.bindings.forEach((binding, index) => {
    const base = `bindings[${index}]`;
    if (typeof binding.from !== "number" || typeof binding.to !== "number") {
      errors.push(`${base}：from/to 必须是数字`);
    }
    if (typeof binding.primaryFingerprint !== "string" || !/^[0-9a-f]{64}$/.test(binding.primaryFingerprint)) {
      errors.push(`${base}.primaryFingerprint 必须是 64 位小写十六进制 sha256`);
    }
    if (typeof binding.evidence !== "string" || binding.evidence.trim().length < 20) {
      errors.push(`${base}.evidence：判定依据不得为空且需足够具体（≥20 字符）`);
    }
    if (typeof binding.corroboratingLocator !== "string" || binding.corroboratingLocator.trim() === "") {
      errors.push(`${base}.corroboratingLocator：必须给出交叉检验来源`);
    }
  });

  if (errors.length > 0) return { ok: false, errors, file: null };
  return { ok: true, errors: [], file: candidate as HumanBindingArtifact };
}
