/**
 * 名称/实体一致性检测（上下文感知版）。
 *
 * ── 要解决的问题 ──
 *
 * 一份真实包可能在同一实体的拼写上自相矛盾（题干里一种写法、文字稿里另一种），
 * 且没有任何记录说明哪个对。这类矛盾意味着至少一处是错的，
 * 而它不会被任何结构校验器发现。
 *
 * ── 为什么第一版实现失败 ──
 *
 * 第一版用两条**全局**规则：
 * 1. 按共享末词归组 → 立刻产生大量假阳性（两个不同机构名共享 `library` 被判为冲突）。
 * 2. 收窄为"首词相同或极近、末词不同" → 又**漏掉了目标案例**：
 *    目标案例是**姓氏差异很大**（音近但拼写完全不同），首词相近只是巧合；
 *    同时它会把两个在不同材料里各自独立、恰好同名的人误判为冲突。
 *
 * 根因：判据是**全局的**，而"是否冲突"取决于**上下文**。
 * 两个名字在同一段材料里指同一个人时，拼写不同就是冲突；
 * 在两个无关的材料里，即使首词相同也可能是两个人。
 *
 * ── 现行设计：分组上下文内的双规则 ──
 *
 * 只在**同一材料/同组上下文**内比较，并分两条规则：
 *
 * | 规则 | 判据 | 抓到的形态 |
 * | --- | --- | --- |
 * ── 只用真实存在的案例形态（姓名已抽象为合成样本）──
 *
 * | 规则 | 判据 | 抓到的形态 |
 * | --- | --- | --- |
 * | A | **同一首名 + 不同姓氏** | 同一材料内 `<Given> <SurnameA>` ↔ `<Given> <SurnameB>` |
 * | B | **同一姓氏 + 名字近拼写** | 同一材料内 `<GivenA> <Surname>` ↔ `<GivenB> <Surname>`（A/B 编辑距离 ≤ 2） |
 *
 * 跨无关上下文（不同材料）时，要求**几乎完全相同**的全名才判冲突
 * （末词编辑距离 ≤ 1 且首词相同），因此
 * `Tom Oliver` 与 `Tom Parker` 在无关材料里**不会**被判为冲突。
 *
 * **本模块只报告冲突，从不改写姓名。** 判定正确写法需要外部证据。
 */

import type { ReviewItem } from "./types";
import { compact } from "./fidelity";

/** 一次实体出现。`context` 是它所属的材料/题组。 */
export interface EntityOccurrence {
  /** 抽取到的原样写法。 */
  surface: string;
  /** 归一化（小写、去标点）后的键。 */
  key: string;
  /** 位置描述，供人工定位。 */
  where: string;
  /**
   * 上下文标识：同一段材料/同一题组的出现共享它。
   *
   * 这是本设计的核心 —— 没有它就无法区分"同一人的两种拼写"与
   * "两个不同的人恰好同名"。
   */
  context: string;
}

export interface EntityConflict {
  /** 触发冲突的规则。 */
  rule: "same_given_name_different_surname" | "same_surname_near_given_name" | "near_identical_full_name";
  /** 是否在同一上下文内检出（同上下文为强冲突）。 */
  sameContext: boolean;
  /** 参与冲突的写法（有序）。 */
  spellings: string[];
  occurrences: EntityOccurrence[];
}

// ---------------------------------------------------------------------------
// 抽取
// ---------------------------------------------------------------------------

/**
 * 人名样式：2–3 个首字母大写的词。
 *
 * 只允许 2–3 个词：单个大写词（句首词、专有名词）噪音太大；
 * 4 个以上极少是人名（多为机构名，误报率高）。
 * 这是**有意收窄**：宁可漏报，也不要制造需要人工逐条排除的噪音。
 */
const PERSON_NAME =
  /\b([A-Z][a-z]{1,}(?:['-][A-Za-z]+)?)\s+([A-Z][a-z]{1,}(?:['-][A-Za-z]+)?)(?:\s+([A-Z][a-z]{1,}(?:['-][A-Za-z]+)?))?\b/g;

/** 句首常见词与组织名首词：出现在首位时不太可能是人名。 */
const NON_NAME_LEAD = new Set([
  "The", "This", "That", "These", "Those", "When", "While", "However", "Although",
  "Because", "According", "In", "On", "At", "For", "But", "And", "As", "It", "Its",
  "Their", "There", "They", "We", "You", "He", "She", "Question", "Questions",
  "Passage", "Section", "Part", "United", "New", "North", "South", "East", "West",
  "Los", "San", "University", "College", "Institute",
]);

/**
 * 称谓/头衔。它与 NON_NAME_LEAD 分开处理。
 *
 * 为什么必须分开：`Doctor Jane Foxton` 里的 `Doctor` 不是姓名的一部分，
 * 但**也不该让整个名字被丢弃** —— 早先把它并入 NON_NAME_LEAD 后，
 * 该匹配被整体 `continue`，结果 `Jane Foxton` 完全抽不到，
 * 实体冲突检测因此漏掉这个真实姓名（实测由测试发现）。
 * 正确做法是**剥掉称谓后继续匹配**。
 */
const HONORIFICS = new Set([
  "Professor", "Doctor", "Doctorate", "Mister", "Mrs", "Ms", "Miss",
  "Sir", "Lord", "Lady", "Saint", "St", "Dr", "Prof",
]);

export function extractEntities(text: string, where: string, context: string): EntityOccurrence[] {
  const found: EntityOccurrence[] = [];
  PERSON_NAME.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = PERSON_NAME.exec(text)) !== null) {
    const surface = match[0].replace(/\s+/g, " ").trim();
    if (NON_NAME_LEAD.has(match[1])) continue;

    // 称谓开头的匹配：剥掉称谓，保留其后的姓名
    if (HONORIFICS.has(match[1])) {
      const tokens = surface.split(" ");
      const withoutHonorific = tokens.slice(1).join(" ").trim();
      if (withoutHonorific !== "") {
        found.push({ surface: withoutHonorific, key: normalizeEntity(withoutHonorific), where, context });
      }
      continue;
    }

    found.push({ surface, key: normalizeEntity(surface), where, context });
  }
  return found;
}

function normalizeEntity(surface: string): string {
  return surface
    .toLowerCase()
    .replace(/[^a-z0-9' -]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Levenshtein 距离。 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let previous = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i += 1) {
    const current = [i, ...Array.from({ length: n }, () => 0)];
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost);
    }
    previous = current;
  }
  return previous[n];
}

/** 名字（首词）是否"近拼写"：编辑距离 ≤ 2 且长度相近。 */
function nearSpelling(a: string, b: string): boolean {
  if (a === b) return true;
  const distance = editDistance(a, b);
  const lengthGap = Math.abs(a.length - b.length);
  return distance <= 2 && lengthGap <= 2;
}

/** 姓氏（末词）是否"音近但拼写不同"。ASR 错误常把姓氏听成完全不同的拼写。 */
function differentSurname(a: string, b: string): boolean {
  if (a === b) return false;
  // 音近的判据刻意宽：ASR 可能把姓氏识别成差异很大的拼写
  // （实测目标案例的姓氏字形差异极大）。因此只要**不同**就进入候选，
  // 由"同一首名 + 同一上下文"来保证精度。
  return true;
}

// ---------------------------------------------------------------------------
// 冲突判定
// ---------------------------------------------------------------------------

/**
 * 找出实体冲突。
 *
 * 两条规则各自带上下文条件 —— 这是与第一版的根本区别。
 */
export function findEntityConflicts(occurrences: EntityOccurrence[]): EntityConflict[] {
  const usable = occurrences.filter((occurrence) => {
    const tokens = occurrence.key.split(" ").filter((token) => token.length > 0);
    return tokens.length >= 2 && tokens[0].length >= 3;
  });

  const conflicts: EntityConflict[] = [];
  const consumed = new Set<string>();

  // 先按上下文分组：同上下文内的比较是强判据
  const byContext = new Map<string, EntityOccurrence[]>();
  for (const occurrence of usable) {
    if (!byContext.has(occurrence.context)) byContext.set(occurrence.context, []);
    byContext.get(occurrence.context)!.push(occurrence);
  }

  const pairKey = (a: EntityOccurrence, b: EntityOccurrence): string =>
    [a.surface, b.surface].sort().join("||");

  // ── 规则 A / B：同一上下文内 ──
  for (const [context, members] of byContext) {
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i];
        const b = members[j];
        if (a.key === b.key) continue;

        const tokensA = a.key.split(" ");
        const tokensB = b.key.split(" ");
        // 词数不同时无法可靠拆分首名/姓氏 —— 这是"完整形式 vs 带前缀"，
        // 不是冲突（实测判据）
        if (tokensA.length !== tokensB.length) continue;

        const givenA = tokensA[0];
        const givenB = tokensB[0];
        const surnameA = tokensA[tokensA.length - 1];
        const surnameB = tokensB[tokensB.length - 1];

        // 规则 A：同一首名 + 不同姓氏
        if (givenA === givenB && differentSurname(surnameA, surnameB)) {
          const key = pairKey(a, b);
          if (consumed.has(key)) continue;
          consumed.add(key);
          conflicts.push({
            rule: "same_given_name_different_surname",
            sameContext: true,
            spellings: [...new Set([a.surface, b.surface])].sort(),
            occurrences: [a, b],
          });
          continue;
        }

        // 规则 B：同一姓氏 + 名字近拼写
        if (surnameA === surnameB && nearSpelling(givenA, givenB)) {
          const key = pairKey(a, b);
          if (consumed.has(key)) continue;
          consumed.add(key);
          conflicts.push({
            rule: "same_surname_near_given_name",
            sameContext: true,
            spellings: [...new Set([a.surface, b.surface])].sort(),
            occurrences: [a, b],
          });
          continue;
        }

        void context;
      }
    }
  }

  // ── 跨无关上下文：要求几乎完全相同的全名 ──
  // 这条刻意极严，避免把两个恰好同名的人误判为同一实体
  for (let i = 0; i < usable.length; i += 1) {
    for (let j = i + 1; j < usable.length; j += 1) {
      const a = usable[i];
      const b = usable[j];
      if (a.context === b.context) continue; // 同上下文已由上面处理
      if (a.key === b.key) continue;

      const tokensA = a.key.split(" ");
      const tokensB = b.key.split(" ");
      if (tokensA.length !== tokensB.length) continue;

      const givenA = tokensA[0];
      const givenB = tokensB[0];
      const surnameA = tokensA[tokensA.length - 1];
      const surnameB = tokensB[tokensB.length - 1];

      // 跨上下文只在"首名相同 且 姓氏几乎相同"时才判冲突
      // ⇒ `Tom Oliver` vs `Tom Parker` 不满足（姓氏差异大）⇒ 不报
      const identicalGiven = givenA === givenB;
      const almostSameSurname = editDistance(surnameA, surnameB) <= 1;
      if (!identicalGiven || !almostSameSurname) continue;

      const key = pairKey(a, b);
      if (consumed.has(key)) continue;
      consumed.add(key);
      conflicts.push({
        rule: "near_identical_full_name",
        sameContext: false,
        spellings: [...new Set([a.surface, b.surface])].sort(),
        occurrences: [a, b],
      });
    }
  }

  return conflicts.sort((a, b) => a.spellings.join().localeCompare(b.spellings.join()));
}

/** 冲突转成复核项。**工具只报告，不选择正确拼写。** */
export function entityConflictsToReview(conflicts: EntityConflict[]): ReviewItem[] {
  return conflicts.map((conflict) => {
    const ruleText =
      conflict.rule === "same_given_name_different_surname"
        ? "同一首名、不同姓氏"
        : conflict.rule === "same_surname_near_given_name"
          ? "同一姓氏、名字近拼写"
          : "跨材料的近乎完全相同全名";

    return {
      code: "entity_spelling_conflict" as const,
      // 同上下文的冲突更可能是真实缺陷（同一段材料里一个人不应有两种写法）
      severity: conflict.sameContext ? ("blocking" as const) : ("advisory" as const),
      where: `<entities>/${conflict.spellings.join("|")}`,
      detail:
        `包内对同一实体出现 ${conflict.spellings.length} 种拼写：${conflict.spellings.join(" / ")}` +
        `（判定规则：${ruleText}${conflict.sameContext ? "，且位于同一材料上下文" : "，位于不同材料"}）。` +
        `工具**不判断哪种正确** —— 需外部证据并登记审计记录。`,
      evidence: conflict.occurrences
        .slice(0, 6)
        .map((occurrence) => `${occurrence.surface} @ ${occurrence.where}`)
        .join(" | "),
    };
  });
}

/** 便于诊断：把实体键拆成"首名 / 姓氏"。 */
export function splitName(surface: string): { given: string; surname: string } {
  const key = compact(surface);
  const tokens = key.split(" ");
  return { given: tokens[0] ?? "", surname: tokens[tokens.length - 1] ?? "" };
}
