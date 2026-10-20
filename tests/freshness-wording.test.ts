import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  PAPER_FRESHNESS_HEADLINES,
  PAPER_FRESHNESS_LABELS,
  PAPER_FRESHNESS_STATES,
  decidePaperFreshness,
  explainPaperFreshness,
  explainStrictMockIneligibility,
  isPaperEligibleForStrictMock,
  joinClauses,
  type PaperExposureMatch,
  type PaperFreshness,
} from "@/domain/paper-freshness";

/**
 * 面向学习者的**措辞**因果回归。
 *
 * ── 它守的三类实测缺陷 ──
 *
 * 1. **原始 Markdown 标记泄漏成字面字符。** 文案里写了 `**强调**`，
 *    但 React 把字符串当纯文本渲染 —— 于是用户看到的是带星号的
 *    `**刺激材料已经不再是新的**`。这不是"样式没生效"，是**内容错了**。
 * 2. **拼装引入的重复标点。** 子句自带句号时，朴素的
 *    `join("；") + "。"` 会产出 `。；` 与 `。。`。
 * 3. **断言超出证据范围。** `pristine` 的判据是"本系统内没有查到
 *    已核验的接触记录"，不是一个关于学习者全部经历的绝对断言 ——
 *    文案若是"完全未见过"就是在说一件系统不知道的事。
 *
 * ── 这些判据作用在**最终字符串**上 ──
 *
 * 断言的是 domain 函数**返回的文本**（浏览器的纯文本渲染结果与它逐字相同，
 * 因为页面直接把它放进 JSX 文本节点），而不是"源码里有没有某个字面量"。
 * 源码级断言会被等价改写绕过（换行、拼接、变量），最终字符串不会。
 */

/** 构造一份带未解决条件的 uncertain 新鲜度。 */
function uncertainFreshness(messages: string[]): PaperFreshness {
  return decidePaperFreshness({
    paperId: "fixture-paper",
    matches: [],
    unresolved: messages.map((message, index) => ({
      code: index === 0 ? "course_package_drifted" : "link_not_runtime_usable",
      message,
    })),
  });
}

function exposedFreshness(): PaperFreshness {
  const match: PaperExposureMatch = {
    paperId: "fixture-paper",
    paperContentVersion: 1,
    sectionId: "reading.careful_reading",
    groupId: null,
    questionId: null,
    targetScope: "section",
    courseId: "fixture-course",
    segmentId: "reading.a",
    courseContentVersion: 1,
    linkId: "link-a",
    verificationRef: "fixture verification",
    firstExposedAt: "2026-02-01T00:00:00.000Z",
    lastExposedAt: "2026-02-01T00:00:00.000Z",
    exposureCount: 1,
    eventTypes: ["content_rendered"],
  };
  return decidePaperFreshness({ paperId: "fixture-paper", matches: [match], unresolved: [] });
}

const pristineFreshness = decidePaperFreshness({
  paperId: "fixture-paper",
  matches: [],
  unresolved: [],
});

/** 三态 × 两个解释函数 = 全部面向学习者的字符串。 */
function allLearnerFacingStrings(): Array<{ label: string; text: string }> {
  const cases: Array<{ label: string; freshness: PaperFreshness }> = [
    { label: "pristine", freshness: pristineFreshness },
    { label: "exposed", freshness: exposedFreshness() },
    {
      label: "uncertain（单条未解决）",
      freshness: uncertainFreshness(["这段课程材料所属的课程包已在盘上被改动但没有重新导入。"]),
    },
    {
      label: "uncertain（多条未解决）",
      freshness: uncertainFreshness([
        "这段课程材料所属的课程包已在盘上被改动但没有重新导入。",
        "这条课程材料与真题的对应关系已经不再成立。",
      ]),
    },
  ];

  const out: Array<{ label: string; text: string }> = [];
  for (const { label, freshness } of cases) {
    out.push({ label: `${label} · explainPaperFreshness`, text: explainPaperFreshness(freshness) });
    out.push({
      label: `${label} · explainStrictMockIneligibility`,
      text: explainStrictMockIneligibility(freshness),
    });
  }
  return out;
}

describe("措辞 · 学习者可见文本必须是纯文本（无 Markdown 标记泄漏）", () => {
  it("所有解释文案都不含 `**` 等 Markdown 强调标记", () => {
    for (const { label, text } of allLearnerFacingStrings()) {
      expect(text, `${label} 泄漏了 Markdown 标记：${text}`).not.toContain("**");
    }
  });

  it("也不含其它常见 Markdown 标记形态（行内代码 / 标题 / 链接语法）", () => {
    for (const { label, text } of allLearnerFacingStrings()) {
      // 行内代码反引号：文案里出现会在页面上显示成字面反引号。
      expect(text, `${label} 泄漏了行内代码标记`).not.toContain("`");
      // Markdown 标题 / 列表前缀。
      expect(text, `${label} 泄漏了标题标记`).not.toMatch(/^#{1,6}\s/m);
      expect(text, `${label} 泄漏了链接语法`).not.toMatch(/\]\(https?:/);
    }
  });

  it("标签与标题同样不得含标记（它们直接渲染在徽标与提示里）", () => {
    for (const text of [...Object.values(PAPER_FRESHNESS_LABELS), ...Object.values(PAPER_FRESHNESS_HEADLINES)]) {
      expect(text, `标签/标题泄漏了标记：${text}`).not.toContain("**");
      expect(text, `标签/标题泄漏了标记：${text}`).not.toContain("`");
    }
  });
});

describe("措辞 · 拼装不得引入重复或矛盾标点", () => {
  it("**复现原缺陷**：子句自带句号时，朴素拼接会产出 `。。` 与 `。；`", () => {
    /*
     * 这条用例证明本组测试不是空断言：它把**修复前**的拼装方式写出来，
     * 断言它确实会产出缺陷形态。因此下面那些"不得出现"的断言是有意义的 ——
     * 它们拦的是一个真实存在过的写法，而不是一个假想的写法。
     */
    const clauses = ["第一句已经结束。", "第二句也已经结束。"];
    const naive = `${clauses.join("；")}。`;
    expect(naive, "朴素拼装必须复现出 。；").toContain("。；");
    expect(naive, "朴素拼装必须复现出 。。").toContain("。。");

    // 而正确的拼装不产生这两种形态。
    const fixed = joinClauses(clauses);
    expect(fixed).not.toContain("。；");
    expect(fixed).not.toContain("。。");
    expect(fixed).toBe("第一句已经结束；第二句也已经结束。");
  });

  it("解释文案里不出现 `。。` / `。；` / `；。` 这类重复标点", () => {
    for (const { label, text } of allLearnerFacingStrings()) {
      for (const bad of ["。。", "。；", "；。", "，，", "、、"]) {
        expect(text, `${label} 出现重复标点「${bad}」：${text}`).not.toContain(bad);
      }
    }
  });

  it("标题与解释之间不得直接用句号连接（那会产生 `。。`）", () => {
    const uncertain = uncertainFreshness(["某个身份条件不成立。"]);
    const strict = explainStrictMockIneligibility(uncertain);
    // 标题本身以句号结尾的形态（exposed / uncertain）必须用空格而非句号衔接。
    expect(strict).not.toContain("。。");
    expect(strict).toContain(PAPER_FRESHNESS_HEADLINES[uncertain.state]);
  });

  it("多条未解决条件的文案以分号连接、以**一个**句号结束", () => {
    const uncertain = uncertainFreshness([
      "条件甲已经不成立。",
      "条件乙也已经不成立；",
      "条件丙同样不成立",
    ]);
    const text = explainPaperFreshness(uncertain);

    // 结尾恰好一个句号。
    expect(text.endsWith("。")).toBe(true);
    expect(text.endsWith("。。")).toBe(false);
    // 三个条件都被如实带上（信息不丢）。
    for (const fragment of ["条件甲", "条件乙", "条件丙"]) {
      expect(text, `缺少条件「${fragment}」`).toContain(fragment);
    }
    // 子句之间用分号。
    expect(text).toContain("；");
  });

  it("joinClauses 自身：空输入、单条、带各种结尾标点", () => {
    expect(joinClauses([])).toBe("");
    expect(joinClauses([""])).toBe("");
    expect(joinClauses(["只有一句。"])).toBe("只有一句。");
    expect(joinClauses(["甲；", "乙。", "丙"])).toBe("甲；乙；丙。");
    // 结尾是 `——`（悬停标点）时不应被当成句末标点剥掉。
    expect(joinClauses(["甲 ——", "乙。"])).toBe("甲 ——；乙。");
  });
});

describe("措辞 · 断言不得超出证据范围", () => {
  it("pristine 文案必须限定证据范围，而不是断言「完全没见过」", () => {
    const text = explainPaperFreshness(pristineFreshness);

    /*
     * ── 必须限定范围，而不是作绝对断言 ──
     *
     * 本应用只知道自己的记录，**不知道**学习者在别处是否见过这份材料。
     * 因此文案必须显式说明这个边界。
     */
    expect(text, "必须说明依据只来自本应用").toContain("本应用");
    expect(
      text,
      "必须说明它不代表别处的情况（否则读起来像绝对断言）",
    ).toMatch(/不代表[\s\S]{0,16}(别的地方|系统之外)/);

    /*
     * 不得出现"完全未见过 / 从未见过"这类**绝对**断言 ——
     * 注意区分「断言」与「否定该断言」：正当写法
     * "它不代表你在别的地方从未见过这份材料" 里的"从未见过"是被否定的对象。
     * 因此只在**肯定语境**下判违规。
     */
    for (const line of text.split(/[。；]/)) {
      if (!/从未见过|完全未见过|完全没有见过/.test(line)) continue;
      expect(
        /不代表|不是|并非|无法|不能/.test(line),
        `pristine 文案在肯定语境下作了绝对断言：${line}`,
      ).toBe(true);
    }
  });

  it("pristine 文案必须对**非技术学习者**可读（不得暴露内部实现词汇）", () => {
    /*
     * 评审 A 项要求 5。原先那句"内容包与核验链接当前都成立"是内部词汇：
     * 学习者不知道什么是"内容包"，也不知道"核验链接"指什么 ——
     * 一句读不懂的限定等于没有限定。
     */
    const text = explainPaperFreshness(pristineFreshness);

    for (const jargon of ["内容包", "核验链接", "manifest", "checksum", "指纹"]) {
      expect(text, `pristine 文案不得出现内部实现词汇「${jargon}」`).not.toContain(jargon);
    }

    // 必须给出可执行的结论（"可以按…使用"），而不只是描述状态。
    expect(text, "应当给出学习者可据以行动的结论").toMatch(/可以按/);
  });

  it("exposed 文案必须显式否认「见过 = 会做」，且不得出现掌握度措辞", () => {
    const text = explainPaperFreshness(exposedFreshness());

    // 必须显式说明"不代表会做或不会做"—— 内容事实不得被读成能力判断。
    expect(text).toMatch(/不代表你会做或不会做/);
    // 必须把断言限定在"刺激材料不再是新的"。
    expect(text).toContain("刺激材料已经不再是新的");

    for (const forbidden of [
      "掌握",
      "熟练",
      "水平",
      "得分",
      "正确率",
      "能力",
      "弱项",
      "熟练度",
    ]) {
      expect(text, `exposed 文案不得暗示能力/掌握「${forbidden}」`).not.toContain(forbidden);
    }
  });

  it("uncertain 文案必须把「无法证明」与「没见过」明确区分开", () => {
    const text = explainPaperFreshness(uncertainFreshness(["某个身份条件不成立。"]));
    expect(text).toContain("无法证明");
    // 必须点出这正是要避免的混淆。
    expect(text).toMatch(/不知道.*没见过/);
  });

  it("所有文案都不使用把事实说成缺陷的词", () => {
    for (const { label, text } of allLearnerFacingStrings()) {
      for (const forbidden of ["污染", "脏", "tainted", "contaminated", "dirty", "invalid", "失效"]) {
        expect(text, `${label} 不得把事实说成缺陷「${forbidden}」：${text}`).not.toContain(forbidden);
      }
    }
  });

  it("不合格原因对 exposed 与 uncertain 给出**不同**的话（不得一句话糊过去）", () => {
    const exposed = explainStrictMockIneligibility(exposedFreshness());
    const uncertain = explainStrictMockIneligibility(uncertainFreshness(["甲不成立。"]));
    expect(exposed).not.toBe(uncertain);
    expect(exposed).toContain("不再适合");
    expect(uncertain).toContain("暂不作为");
  });
});

describe("措辞 · 严格模考资格只有**一个**实现（N2：消除重复判定）", () => {
  it("服务层不得自己比较状态字符串（必须委托 domain 谓词）", () => {
    /*
     * 这里曾经写成 `.state === "pristine"` —— 与 domain 的谓词重复了同一个
     * 决定。两处的后果是漂移：语义一变只有一处被改，于是"这份卷子能不能
     * 当严格模考"会有两个答案。
     *
     * 判据是**服务层代码里不得出现状态比较**，且必须调用 domain 谓词。
     */
    const source = readFileSync(join(process.cwd(), "src/services/paper-freshness.ts"), "utf8");
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    /*
     * 判据必须避开**本条测试自身的说明文字**：上面那段注释里写了
     * `.state === "pristine"`（用于说明这个缺陷形态），剥注释后不会再命中。
     * 但为了避免"注释剥离后仍残留说明"的偶然，这里把判据锚定到
     * **赋值/返回位置**：比较必须出现在某个表达式里，而不是任意文本片段。
     */
    expect(
      /\.state\s*===\s*["']pristine["']/.test(code),
      "服务层不得自己比较 .state === 'pristine'（应委托 domain 谓词）",
    ).toBe(false);
    expect(
      /\.state\s*!==\s*["']pristine["']/.test(code),
      "服务层不得自己比较 .state !== 'pristine'",
    ).toBe(false);

    // 必须确实委托给 domain 的那一个实现。
    expect(code).toContain("domainIsPaperEligibleForStrictMock");
  });

  it("domain 谓词是唯一实现，且失败关闭（只认 pristine）", () => {
    const domain = readFileSync(join(process.cwd(), "src/domain/paper-freshness.ts"), "utf8");
    const implementations = domain.split("export function isPaperEligibleForStrictMock").length - 1;
    expect(implementations, "资格谓词必须只有一个实现").toBe(1);

    // 三态穷举：只有 pristine 合格。
    for (const state of PAPER_FRESHNESS_STATES) {
      expect(
        isPaperEligibleForStrictMock({ state }),
        `${state} 的资格判定必须失败关闭`,
      ).toBe(state === "pristine");
    }
  });

  it("服务层与 domain 对同一状态给出**一致**的答案（对照，防漂移）", () => {
    /*
     * 直接对照三态下的资格判定结果。
     *
     * 用**完整构造**的新鲜度对象（含 matches / unresolved）而不是
     * `{ state } as PaperFreshness` 的类型断言：后者会让
     * `explainStrictMockIneligibility` 在 exposed / uncertain 分支上
     * 读到 undefined —— 那是测试自己造出的假崩溃，不是产品缺陷。
     */
    const cases: PaperFreshness[] = [
      pristineFreshness,
      exposedFreshness(),
      uncertainFreshness(["某个身份条件不成立。"]),
    ];

    for (const freshness of cases) {
      // 两个入口都必须给出可读结果。
      expect(explainStrictMockIneligibility(freshness).length).toBeGreaterThan(0);
      expect(explainPaperFreshness(freshness).length).toBeGreaterThan(0);

      // domain 谓词是唯一真相：只有 pristine 合格。
      expect(isPaperEligibleForStrictMock(freshness)).toBe(freshness.state === "pristine");
    }

    // 三态齐全（避免上面只覆盖了部分状态）。
    expect(new Set(cases.map((item) => item.state))).toEqual(new Set(PAPER_FRESHNESS_STATES));
  });
});

describe("变异脚本 · 覆盖声明必须与实际变异一致", () => {
  /**
   * 变异脚本头部的 Markdown 表是它的"覆盖声明"。
   *
   * 变异测试的全部价值建立在"声称覆盖了什么"与"实际施加了什么"一致之上 ——
   * 表一旦漂移（例如插入一个变异后编号整体后移），人就会以为某条守卫被覆盖了，
   * 而实际施加的是别的东西。这类漂移**不会**让变异测试变红：
   * 每个变异各自仍然是绿的，只是整体覆盖声明变成了谎言。
   *
   * 因此这里做一次纯文本比对：表里列出的每个 `M<n>` 的守卫描述，
   * 必须能在数组里找到对应 id 且关键词一致。
   */
  function mutationSource(): string {
    return readFileSync(join(process.cwd(), "scripts/paper-freshness-mutation.ts"), "utf8");
  }

  it("表里列出的每个 M<n> 都在数组里存在，且 guard 关键词一致", () => {
    const source = mutationSource();

    // 数组里实际的 id → guard。
    const actual = new Map<string, string>();
    const arrayRe = /id:\s*"(M\d+)",\s*\r?\n\s*guard:\s*"([^"]+)"/g;
    let hit: RegExpExecArray | null;
    while ((hit = arrayRe.exec(source)) !== null) actual.set(hit[1], hit[2]);

    expect(actual.size, "变异数组不得为空").toBeGreaterThan(0);

    /*
     * 表行形态：`| M1 | 守卫描述 | 缺陷 | 类别 |`。
     * 只取前两个单元格做比对（缺陷与类别是解释性文字）。
     */
    const tableRows = source
      .split(/\r?\n/)
      .filter((line) => /^\s*\*\s*\|\s*M\d+\s*\|/.test(line))
      .map((line) => line.replace(/^\s*\*\s*/, ""));

    expect(tableRows.length, "覆盖表必须列出全部变异").toBe(actual.size);

    for (const row of tableRows) {
      const cells = row.split("|").map((cell) => cell.trim());
      const id = cells[1];
      const described = cells[2];
      expect(actual.has(id), `覆盖表里的 ${id} 在变异数组里不存在`).toBe(true);

      const guard = actual.get(id)!;
      /*
       * 比对方式：**字符级重叠度**，而不是子串包含。
       *
       * 表是摘要（"资格判据只有 pristine 通过"），guard 是完整描述
       * （"严格模考资格：只有 pristine 通过（uncertain 也必须不合格）"），
       * 因此要求逐字包含是过严的 —— 那会让一条正确的表也变红，
       * 进而诱使人把断言改弱。
       *
       * 取描述里去掉标记与空白后的字符集合，要求它**大部分**出现在 guard 里。
       * 阈值 0.6：既能抓住"编号整体后移"这类真漂移（描述会指向完全不同的
       * 守卫，重叠度通常远低于此），又容得下摘要措辞的正常差异。
       */
      const normalize = (text: string): string => text.replace(/\*\*/g, "").replace(/\s/g, "");
      const describedChars = [...new Set(normalize(described))];
      const guardNorm = normalize(guard);
      const overlap = describedChars.filter((char) => guardNorm.includes(char)).length;
      const ratio = overlap / describedChars.length;

      expect(
        ratio,
        `覆盖表 ${id} 的描述「${described}」与数组里的 guard「${guard}」重叠度过低（${ratio.toFixed(2)}）—— 表可能已漂移`,
      ).toBeGreaterThanOrEqual(0.6);
    }
  });

  it("数组里每个变异都被覆盖表列出（无遗漏）", () => {
    const source = mutationSource();
    const ids: string[] = [];
    const arrayRe = /id:\s*"(M\d+)",/g;
    let hit: RegExpExecArray | null;
    while ((hit = arrayRe.exec(source)) !== null) ids.push(hit[1]);

    for (const id of ids) {
      expect(
        new RegExp(`\\|\\s*${id}\\s*\\|`).test(source),
        `变异 ${id} 未在覆盖表中列出`,
      ).toBe(true);
    }
  });

  it("变异脚本**不**经过 shell 执行（避免 `**` 被 glob 或二次解析）", () => {
    /*
     * 实测脆弱点：早先通过 `node_modules/.bin/vitest.cmd` + `shell: true` 调用，
     * 参数要跨 Node → cmd.exe → vitest 两层解析。用例名里的 `**` 在部分 shell
     * 里会被展开，而 Windows 下 `shell: true` 的参数拼接行为本身是 Node 官方
     * 警告的形态（DEP0190）。改为直接执行 vitest 入口模块后参数逐字传递。
     */
    const source = mutationSource();
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    expect(code, "不得再使用 shell: true").not.toMatch(/shell:\s*true/);
    expect(code, "不得再调用 .bin/vitest 包装脚本").not.toContain('".bin"');
    // 必须直接执行入口模块。
    expect(code).toContain("vitest.mjs");
    expect(code).toContain("spawnSync(process.execPath");
  });
});

describe("措辞 · 源码中面向学习者的 JSX 文本不得含原始 Markdown", () => {
  /** 递归列出 src/app 与 src/components 下的源码文件。 */
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, out);
      else if (/\.(tsx|ts)$/.test(entry)) out.push(full);
    }
    return out;
  }

  it("JSX 可见文本里不存在 `**` 强调标记（含本轮修复的三处）", () => {
    /*
     * 判据必须**剥掉注释**：注释里会写 `**强调**` 用于说明，
     * 那是正确的文档而不是泄漏（同 paper-pool-policy 的先例）。
     * 因此先把块注释整体替换为空白，再扫描。
     */
    const offenders: string[] = [];
    for (const file of [...walk("src/app"), ...walk("src/components")]) {
      const source = readFileSync(file, "utf8");
      // 块注释（含 JSX 注释 {/* ... */}）整体抹成等长空白，保留行号。
      const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
      withoutComments.split(/\r?\n/).forEach((line, index) => {
        if (!line.includes("**")) return;
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return;
        offenders.push(`${file}:${index + 1}: ${trimmed}`);
      });
    }

    expect(offenders, `以下 JSX 文本会把 ** 渲染成字面字符：\n${offenders.join("\n")}`).toEqual([]);
  });

  it("该判据不是空断言：它确实能发现**已知曾经存在过**的形态", () => {
    /*
     * 因果自证：把本轮修复前的那一行字面量交给同一个判据形态，
     * 必须被判定为违规。这证明上面的扫描真的在做事。
     */
    const historicalDefect = "                下面这些试卷被你标为「模考保留」，因此**不提供训练入口**。";
    const withoutComments = historicalDefect; // 无注释
    const flagged = withoutComments
      .split(/\r?\n/)
      .filter((line) => line.includes("**"))
      .filter((line) => !line.trim().startsWith("//"));
    expect(flagged.length, "判据必须能发现历史缺陷形态").toBe(1);

    // 而修复后的形态不被标记。
    const fixed = "                下面这些试卷被你标为「模考保留」，因此不提供训练入口。";
    expect(fixed.includes("**")).toBe(false);
  });
});

describe("措辞 · 详情页必须渲染 domain 权威措辞（A 项源码级守护）", () => {
  /**
   * ── 这条守的是评审 A 项那个**结构性**缺陷 ──
   *
   * 详情页曾在合格分支里**自己写了一段 pristine 文案**，而
   * `FreshnessNotice` 对 pristine 返回 `null` —— 于是 domain 里那句
   * 证据范围限定永远不会被渲染。
   *
   * 注意这条不是"文案写错了"，而是**权威措辞被绕过了**：
   * 页面自带一份平行文案，两份迟早漂移，而漂移的后果是
   * 限定被静默丢掉。因此判据必须落在"页面是否自己写新鲜度文案"上。
   *
   * 浏览器级回归在 `e2e/freshness.spec.ts`（断言渲染后的 innerText）；
   * 这里做源码级兜底，让"退回硬编码"在单元层就变红。
   */
  const DETAIL_PAGE = "src/app/practice/papers/[paperId]/page.tsx";

  it("详情页不得自带 pristine 解释文案（必须消费 domain 权威措辞）", () => {
    const code = readFileSync(join(process.cwd(), DETAIL_PAGE), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");

    /*
     * 历史缺陷的两段字面量 —— 任一出现即说明页面又开始自带文案。
     * 用历史原文而不是泛化判据：泛化判据会误伤正当的 UI 文案。
     */
    for (const hardcoded of [
      "系统没有发现任何已核验的既往接触记录",
      "且内容包与核验链接当前都成立",
      "它可以作为未见模考材料",
    ]) {
      expect(
        code.includes(hardcoded),
        `${DETAIL_PAGE} 又自带了一段 pristine 解释（「${hardcoded}」）—— ` +
          "应改为渲染 domain 的 explainPaperFreshness",
      ).toBe(false);
    }

    // 必须确实消费那个**唯一**呈现组件。
    expect(code, "详情页必须使用 StrictMockEligibility 呈现三态").toContain("StrictMockEligibility");
  });

  it("该判据不是空断言：它确实能发现历史缺陷形态", () => {
    /*
     * 因果自证：把修复前的 JSX 片段交给同一个判据，必须被判为违规。
     */
    const historicalDefect = `
      {strictMockEligible ? (
        <p className="mt-1 text-[12px] leading-relaxed text-content-faint">
          尚未接触。系统没有发现任何已核验的既往接触记录，
          且内容包与核验链接当前都成立 —— 它可以作为未见模考材料。
        </p>
      ) : null}`;

    const flagged = ["系统没有发现任何已核验的既往接触记录", "且内容包与核验链接当前都成立"].filter(
      (hardcoded) => historicalDefect.includes(hardcoded),
    );
    expect(flagged.length, "判据必须能发现历史缺陷形态").toBe(2);

    // 而修复后的形态（只有组件调用）不被标记。
    const fixed = `
      {freshness ? (
        <div className="mt-3 border-t border-edge pt-3">
          <StrictMockEligibility freshness={freshness} />
        </div>
      ) : null}`;
    for (const hardcoded of ["系统没有发现任何已核验的既往接触记录", "且内容包与核验链接当前都成立"]) {
      expect(fixed.includes(hardcoded)).toBe(false);
    }
    expect(fixed).toContain("StrictMockEligibility");
  });

  it("唯一呈现组件对三态都给出可见解释（不得对 pristine 返回 null）", () => {
    /*
     * `FreshnessNotice` 对 pristine 返回 null 是**徽标**的合理行为，
     * 但**说明**不能也返回 null —— 那正是限定丢失的机制。
     * 因此合格态的说明必须由另一个组件承担。
     */
    const badges = readFileSync(join(process.cwd(), "src/app/practice/papers/badges.tsx"), "utf8");
    const code = badges.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

    // 必须存在这个组件。
    expect(code, "必须存在 StrictMockEligibility 组件").toContain(
      "export function StrictMockEligibility",
    );

    // 它的函数体**不得**对 pristine 提前返回 null。
    const body =
      /export function StrictMockEligibility\([\s\S]*?\r?\n\}/.exec(code)?.[0] ?? "";
    expect(body.length, "未找到 StrictMockEligibility 函数体").toBeGreaterThan(80);
    expect(body, "StrictMockEligibility 不得对任何状态提前返回 null").not.toMatch(
      /state === "pristine"\)\s*return null/,
    );
    // 它必须渲染 domain 的权威措辞。
    expect(body, "必须渲染 domain 的 explainPaperFreshness").toContain("explainPaperFreshness");
  });
});
