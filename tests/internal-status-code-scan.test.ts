import { describe, expect, it } from "vitest";
import {
  ALLOWED_STATUS_CODES,
  describeStatusCodeFinding,
  findInternalStatusCodes,
} from "../tools/internal-status-code-scan.mjs";

/**
 * 内部**状态代号**检测的回归。
 *
 * ── 它守的那个真实缺陷 ──
 *
 * 一次已合并的 PR 正文里带着一个内部验收代号：全大写、下划线连接、编码了某个
 * 私有工作流的状态机取值。它在**合并提交信息**里 —— 公开、永久、随每次克隆
 * 复制。
 *
 * 既有规则全部漏掉它，原因是结构性的：`audit-history.mjs` 与
 * `public-release-check.mjs` 里每一条规则匹配的都是**空格分隔的归因**
 * （`<role> review round <n>`、`reviewed by <Name>`、`<ROLE> PASS`）。
 * 泄露的 token 没有空格，是一个整体标识符，所以整族"大写词用下划线连起来、
 * 以裁决词结尾"的形态都在视野之外。
 *
 * ── 为什么不能直接匹配"任何大写蛇形 token" ──
 *
 * 树里有数百个合法常量名与环境变量名。一律拒绝会让每次运行都变红，而永远
 * 变红的门禁等于被关掉。判据因此落在**泄露 token 与常量名的区别**上：常量
 * 描述取值（`..._VERSION`/`..._PATH`），状态码断言结果（`..._PASS`）。
 */

/**
 * 合成代号在**运行时**拼接，本文件不落完整字面量。
 *
 * 这不是风格问题：本文件也在被发布的树里，而发布门禁会扫描它。若这里直接
 * 写出一个形如内部状态码的字面量，用例自己就会成为一条泄露 —— 与本项目
 * 其它安全用例（`workspace-path-scan.test.ts`、`gate-negative-controls.mjs`）
 * 的写法一致。门禁对"注释里的形状"宽容，对**字符串字面量**不宽容，因此
 * 夹具必须在运行时成形。
 */
const code = (...segments: string[]): string => segments.join("_");

describe("内部状态代号 · 必须抓到", () => {
  /** 合成代号：明显虚构，但保持真实形状（三段以上 + 裁决词结尾）。 */
  const SYNTHETIC: Array<[string, string, string]> = [
    ["三段式 + 裁决词", code("SYNTHETICPROBE", "STAGE", "REVIEW", "APPROVED"), "APPROVED"],
    ["多段 + PASS", code("ALPHAPROBE", "GATE", "FINAL", "PASS"), "PASS"],
    ["下划线裁决词", code("BETAPROBE", "REVIEW", "SIGNED", "OFF"), "SIGNED_OFF"],
    ["小写前缀不影响", code("GAMMAPROBE", "QA", "REJECTED"), "REJECTED"],
    ["BLOCKED 也算裁决", code("DELTAPROBE", "ROUND", "BLOCKED"), "BLOCKED"],
  ];

  for (const [label, token, verdict] of SYNTHETIC) {
    it(`${label} 会被检出`, () => {
      const findings = findInternalStatusCodes(`merge body: ${token}`);
      expect(findings.length, token).toBe(1);
      expect(findings[0].token).toBe(token);
      expect(findings[0].verdict).toBe(verdict);
    });
  }

  it("句子中间的代号也能抓到", () => {
    const token = code("PROBE", "ALPHA", "ROUND", "APPROVED");
    const text = `Independent review done (${token}). Merging now.`;
    expect(findInternalStatusCodes(text).length).toBe(1);
  });

  it("同一段落里多个代号全部抓到", () => {
    const first = code("PROBE", "ONE", "STAGE", "PASS");
    const second = code("PROBE", "TWO", "STAGE", "FAILED");
    const tokens = findInternalStatusCodes(`${first} and ${second}`).map((f) => f.token);
    expect(tokens).toEqual([first, second]);
  });

  it("同一代号重复出现只报一次（按 token 去重）", () => {
    const token = code("PROBE", "ALPHA", "ROUND", "APPROVED");
    expect(findInternalStatusCodes(`${token} ... ${token}`).length).toBe(1);
  });
});

describe("内部状态代号 · 合法内容必须放行", () => {
  const ALLOWED = [
    // 常量名：描述取值，不是裁决。
    "COURSE_MANIFEST_SCHEMA_VERSION",
    "MAX_SAFE_INTEGER",
    "DEFAULT_LOCAL_ORIGIN",
    "E2E_A3_CONTENT_ROOT",
    "ALLOWED_UNC_HOSTS",
    "SYNTHETIC_ASSET_SHA",
    "MIN_QUOTE_LENGTH",
    // 两段式旗标：不是状态码。
    "CI_RED",
    "CI_GREEN",
    // 运行时错误名（在允许表里，有理由）。
    "ERR_MODULE_NOT_FOUND",
  ];

  for (const token of ALLOWED) {
    it(`${token} 不被误报`, () => {
      expect(findInternalStatusCodes(`// see ${token}`), token).toEqual([]);
    });
  }

  it("中性工程说明（未来的提交信息写法）零误报", () => {
    const messages = [
      "fix(tools): judge identities by disclosure, not by commit authorship model",
      "docs: describe commit-exclusion rules without naming internal tokens",
      "refactor(tools): detect internal-process records by shape, not by private names",
      "Merge pull request #3 from W-SING-HUNG/fix/neutral-internal-name-detection",
      "Merging the three reviewed commits; no post-review changes.",
      "Independent security review passed. No post-review changes.",
      "Adds MIT licence; inbound = outbound.",
      "Bumps next to 16.3.6 and re-runs the bundle boundary check.",
    ];
    for (const message of messages) {
      expect(findInternalStatusCodes(message), message).toEqual([]);
    }
  });

  it("普通散文里的全大写单词不是状态码", () => {
    for (const text of [
      "This is IMPORTANT and must be FIXED before release.",
      "The ANSWER is PASS but the DETAILS matter.",
      "Use HTTPS and not HTTP.",
    ]) {
      expect(findInternalStatusCodes(text), text).toEqual([]);
    }
  });

  it("允许表每一条都给出理由（不允许无名豁免）", () => {
    expect(ALLOWED_STATUS_CODES.size).toBeGreaterThan(0);
    for (const [token, reason] of ALLOWED_STATUS_CODES) {
      expect(typeof reason, `${token} 缺少理由`).toBe("string");
      expect(reason.length, `${token} 的理由过短`).toBeGreaterThan(10);
      /*
       * 允许表本身不得收录真实状态码：每一项都必须是**不含裁决词**的常量名，
       * 或明确列为运行时错误名。否则允许表就成了后门。
       */
      const looksLikeStatus = /_(?:PASS|APPROVED|SIGNED_OFF|BLOCKED|VERIFIED|CONFIRMED)$/.test(token);
      expect(looksLikeStatus, `${token} 形如状态码，不得进入允许表`).toBe(false);
    }
  });
});

describe("内部状态代号 · 报告不回显完整代号", () => {
  it("归一化形式丢弃具名首段", () => {
    /*
     * CI 日志与仓库同等公开。把完整代号打进日志等于把泄露从树里搬到日志里。
     */
    const project = "PROJECTPROBE";
    const finding = findInternalStatusCodes(code(project, "STAGE", "REVIEW", "APPROVED"))[0];
    const rendered = describeStatusCodeFinding(finding);
    expect(rendered).toContain("<PROJECT>");
    expect(rendered, "不得回显具名首段").not.toContain(project);
    expect(rendered, "保留裁决词以便定位").toContain("APPROVED");
  });
});
