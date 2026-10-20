import { describe, expect, it } from "vitest";
import { buildFixturePackage } from "../scripts/paper-fixture";
import { REAL_PAPER_FINGERPRINTS, scanTextForFingerprints } from "./support/paper-fingerprints";

/**
 * 夹具构造器的**最小必要验证**（长文本布局模式的引入）。
 *
 * ── 为什么需要这一组 ──
 * 为视觉评审新增了 `longForm` 选项（见 `scripts/paper-fixture.ts` 的说明）。
 * 它改动了 `buildSection` 的内部逻辑，因此必须钉住两件事：
 *
 * 1. **默认行为一字未变**：既有的大量测试都依赖默认夹具的形态
 *    （题量、题号、结构、占位文本）。一旦默认模式被无意改动，
 *    那批测试会以"看似无关"的方式失败。这里用显式断言把默认形态固定下来。
 * 2. **长文本模式确实产出长文本**，且**来源类型仍是 test_fixture** ——
 *    后者是内容政策的硬约束：夹具在任何模式下都不得冒充真题。
 *
 * 覆盖范围刻意最小：只验证"这次改动引入的不变量"，
 * 不复述 `tests/paper-validation.test.ts` 已经覆盖的包结构校验。
 */

const DEFAULT_PKG = buildFixturePackage({ id: "fx-default" });
const LONG_PKG = buildFixturePackage({ id: "fx-long", longForm: true });

type AnySection = { type: string; groups: Array<Record<string, unknown>> };
type AnyQuestion = Record<string, unknown>;

function sections(pkg: ReturnType<typeof buildFixturePackage>): AnySection[] {
  return pkg.manifest.sections as AnySection[];
}

function questions(section: AnySection): AnyQuestion[] {
  return section.groups.flatMap((group) => group.questions as AnyQuestion[]);
}

function findSection(pkg: ReturnType<typeof buildFixturePackage>, type: string): AnySection {
  const found = sections(pkg).find((section) => section.type === type);
  expect(found, `夹具缺少大题 ${type}`).toBeDefined();
  return found!;
}

describe("夹具来源类型不可被覆盖（内容政策硬约束）", () => {
  it("默认模式的 sourceKind 恒为 test_fixture", () => {
    expect(DEFAULT_PKG.manifest.sourceKind).toBe("test_fixture");
  });

  it("长文本模式的 sourceKind 同样是 test_fixture（长文本不改变来源身份）", () => {
    expect(LONG_PKG.manifest.sourceKind).toBe("test_fixture");
  });

  it("provenance.note 明确写出它是合成夹具、不是真题", () => {
    for (const pkg of [DEFAULT_PKG, LONG_PKG]) {
      const note = (pkg.manifest.provenance as { note: string }).note;
      expect(note).toContain("夹具");
      expect(note).toContain("不是真题");
    }
  });

  it("`longForm` 不是 sourceKind 的开关：它只影响文本，不影响来源声明", () => {
    // 两种模式下 sourceKind 与 verificationStatus 必须完全相同
    expect(LONG_PKG.manifest.sourceKind).toBe(DEFAULT_PKG.manifest.sourceKind);
    expect(LONG_PKG.manifest.verificationStatus).toBe(DEFAULT_PKG.manifest.verificationStatus);
  });
});

describe("默认模式形态未被改动", () => {
  it("仔细阅读仍是两篇文章，占位文本不变", () => {
    const section = findSection(DEFAULT_PKG, "reading.careful_reading");
    expect(section.groups).toHaveLength(2);
    for (const group of section.groups) {
      expect(group.passage).toBe("Fixture careful-reading passage.");
    }
  });

  it("长篇阅读默认仍是 5 段", () => {
    const section = findSection(DEFAULT_PKG, "reading.matching");
    const paragraphs = section.groups[0].paragraphs as unknown[];
    expect(paragraphs).toHaveLength(5);
  });

  it("选词填空默认词库仍是 15 项、答案仍是 word{n}", () => {
    const section = findSection(DEFAULT_PKG, "reading.banked_cloze");
    expect(section.groups[0].wordBank).toHaveLength(15);
    expect(questions(section)[0].answer).toBe("word1");
  });

  it("仔细阅读默认选项仍是短标签（视觉评审才需要长选项）", () => {
    const section = findSection(DEFAULT_PKG, "reading.careful_reading");
    const options = questions(section)[0].options as Array<{ label: string }>;
    expect(options.map((o) => o.label)).toEqual([
      "Option A",
      "Option B",
      "Option C",
      "Option D",
    ]);
  });

  it("题量与官方结构不变（57 题 / 8 个大题）", () => {
    const all = sections(DEFAULT_PKG).flatMap((section) => questions(section));
    expect(all).toHaveLength(57);
    expect(sections(DEFAULT_PKG)).toHaveLength(8);
  });
});

describe("长文本模式确实产出足以检验布局的文本量", () => {
  it("仔细阅读篇章长度足够检验分栏与换行（> 1200 字符、≥ 6 段）", () => {
    const section = findSection(LONG_PKG, "reading.careful_reading");
    for (const group of section.groups) {
      const passage = String(group.passage);
      expect(passage.length, `篇章仅 ${passage.length} 字符`).toBeGreaterThan(1200);
      expect(passage.split("\n\n").length, "段落数不足").toBeGreaterThanOrEqual(6);
    }
  });

  it("选项长度足够检验折行（最长选项 > 80 字符）", () => {
    const section = findSection(LONG_PKG, "reading.careful_reading");
    const options = questions(section).flatMap(
      (question) => question.options as Array<{ label: string }>,
    );
    const longest = Math.max(...options.map((option) => option.label.length));
    expect(longest, `最长选项仅 ${longest} 字符`).toBeGreaterThan(80);
  });

  it("长篇阅读为 A–O 共 15 段（真实形态的密度）", () => {
    const section = findSection(LONG_PKG, "reading.matching");
    const paragraphs = section.groups[0].paragraphs as Array<{ label: string }>;
    expect(paragraphs.map((p) => p.label)).toEqual(
      "ABCDEFGHIJKLMNO".split(""),
    );
  });

  it("选词填空的空位标记真实存在于原文中（不是我们插进去的）", () => {
    const section = findSection(LONG_PKG, "reading.banked_cloze");
    const passage = String(section.groups[0].passage);
    const blanks = questions(section).map((question) => String(question.blankId));
    for (const blankId of blanks) {
      expect(passage, `原文缺少空位标记 [${blankId}]`).toContain(`[${blankId}]`);
    }
  });

  it("长文本模式的题量与结构仍与官方一致（只换文本，不换结构）", () => {
    const all = sections(LONG_PKG).flatMap((section) => questions(section));
    expect(all).toHaveLength(57);
    expect(sections(LONG_PKG)).toHaveLength(8);
  });

  it("长文本语料是合成的通用说明文，不含任何真实试卷指纹", () => {
    /*
     * 与 tests/architecture.test.ts 的指纹守卫同源：真实试卷的辨识性短语
     * 一旦出现在夹具里就是内容泄漏。这里在**产物层面**再确认一次。
     *
     * 上一版在这里列举了六条真实短语作为被禁集合 —— 也就是说，
     * 这条"防止真题进入仓库"的测试自己把真题写进了仓库。
     * 现在改为比对同一套**摘要**规则数据：不再有任何片段可被读出。
     */
    const serialized = JSON.stringify(LONG_PKG.manifest);
    const hits = scanTextForFingerprints(serialized);
    expect(
      hits.length,
      "夹具含真实试卷内容（指纹命中）。命中位置刻意不回显匹配文本。",
    ).toBe(0);
    // 自检：这条判据不能是空断言 —— 规则数据必须非空，序列化文本必须够长。
    expect(REAL_PAPER_FINGERPRINTS.length).toBeGreaterThan(0);
    expect(serialized.length).toBeGreaterThan(1000);
  });
});
