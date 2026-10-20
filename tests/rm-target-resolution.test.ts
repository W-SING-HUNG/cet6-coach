import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_MARKERS,
  auditSharedRmSync,
  collectRmSyncCalls,
  type RmSyncCallSite,
} from "./support/source-structure";

/**
 * 删除目标识别的**独立门禁**：别名解析、目标三分类、无法解析时失败关闭。
 *
 * ── 它守的那个缺口 ──
 *
 * 早先判据对 `rmSync` 的实参做**子串匹配**：
 *
 *     markers.some((m) => call.firstArgument.includes(m))
 *
 * 于是只要实参不是直接写出来的共享路径，那条删除就**根本不进入**判定：
 *
 *     const t = E2E_A3_CONTENT_ROOT;
 *     rmSync(t, { recursive: true, force: true });   // 被完全跳过，门禁全绿
 *
 * 这是 fail-open：一条无保护的共享目录删除可以静默通过。
 *
 * ── 本文件确立的三分类 ──
 *
 * | 分类 | 处置 |
 * | --- | --- |
 * | `shared` | 必须通过授权检查；无授权 ⇒ 违规 |
 * | `exclusive` | 放行（已登记的独占合成路径） |
 * | `unresolved` | **违规**（失败关闭，不跳过、不当安全） |
 *
 * ── 为什么 `exclusive` 必须显式登记 ──
 *
 * 若用"没命中共享标记就算独占"，任何拼写错误或新增路径都会自动放行 ——
 * 那只是把 fail-open 挪了个位置。因此独占路径逐个列在 `DEFAULT_MARKERS`
 * 里，未登记的一律 `unresolved`。
 */

const SHARED = DEFAULT_MARKERS.shared;
const GUARD = "E2E_RESET_DB";

/** 便捷：跑一次审计并取唯一调用点。 */
function auditOne(source: string, fileName = "probe.ts"): { audit: ReturnType<typeof auditSharedRmSync>; call: RmSyncCallSite } {
  const audit = auditSharedRmSync(source, SHARED, GUARD, fileName);
  expect(audit.calls.length, `${fileName}：应恰好识别出一条 rmSync`).toBe(1);
  return { audit, call: audit.calls[0] };
}

describe("删除目标识别 · 标识符别名", () => {
  it("**红**：无保护的 const 别名共享路径删除必须 FAIL（判据曾经的缺口）", () => {
    /*
     * 这是本轮要修的那一条原文。修复前 `calls` 是 0 —— 那条删除连
     * 判定范围都没进入，门禁静默通过。
     */
    const { audit, call } = auditOne(
      `const t = E2E_A3_CONTENT_ROOT;
rmSync(t, { recursive: true, force: true });`,
      "alias-unguarded.ts",
    );

    expect(call.target.kind, "别名必须被解析成共享路径").toBe("shared");
    expect(audit.violations.length, "无保护的别名共享删除必须被判为违规").toBe(1);
  });

  it("**绿**：受保护的 const 别名共享路径删除必须 PASS", () => {
    const { audit, call } = auditOne(
      `const t = E2E_A3_CONTENT_ROOT;
if (process.env.E2E_RESET_DB === "1") {
  rmSync(t, { recursive: true, force: true });
}`,
      "alias-guarded.ts",
    );

    expect(call.target.kind).toBe("shared");
    expect(audit.violations, "已授权的别名删除不得被拒").toEqual([]);
  });

  it("**两层别名**：连续两次赋值仍能被正确识别（受保护 ⇒ PASS，无保护 ⇒ FAIL）", () => {
    const guarded = `const a = E2E_A3_CONTENT_ROOT;
const b = a;
if (process.env.E2E_RESET_DB === "1") {
  rmSync(b, { recursive: true, force: true });
}`;
    const unguarded = `const a = E2E_A3_CONTENT_ROOT;
const b = a;
rmSync(b, { recursive: true, force: true });`;

    const g = auditSharedRmSync(guarded, SHARED, GUARD, "two-guarded.ts");
    expect(g.calls.length).toBe(1);
    expect(g.calls[0].target.kind, "两层别名应解析到共享路径").toBe("shared");
    expect(g.violations).toEqual([]);

    const u = auditSharedRmSync(unguarded, SHARED, GUARD, "two-unguarded.ts");
    expect(u.calls.length).toBe(1);
    expect(u.calls[0].target.kind).toBe("shared");
    expect(u.violations.length, "两层别名无保护同样必须失败").toBe(1);
  });

  it("别名解析会记录解析链（诊断可用）", () => {
    const { call } = auditOne(
      `const a = E2E_A3_CONTENT_ROOT;
const b = a;
rmSync(b, { recursive: true, force: true });`,
      "alias-chain.ts",
    );
    expect(call.target.kind).toBe("shared");
    if (call.target.kind === "shared") {
      expect(call.target.aliasChain.length, "应记录经过的别名").toBeGreaterThanOrEqual(2);
    }
  });
});

describe("删除目标识别 · 无法确定时失败关闭", () => {
  it("**红**：循环引用的别名必须 FAIL", () => {
    const { audit, call } = auditOne(
      `const a = b;
const b = a;
rmSync(a, { recursive: true, force: true });`,
      "cycle.ts",
    );

    expect(call.target.kind, "循环引用无法解析").toBe("unresolved");
    expect(audit.violations.length, "无法解析必须失败关闭，不得跳过").toBe(1);
    if (call.target.kind === "unresolved") {
      expect(call.target.reason).toMatch(/循环引用|无法/);
    }
  });

  it("**红**：动态赋值（函数返回值）必须 FAIL", () => {
    const { audit, call } = auditOne(
      `const t = pickTarget();
rmSync(t, { recursive: true, force: true });`,
      "dynamic.ts",
    );

    expect(call.target.kind).toBe("unresolved");
    expect(audit.violations.length).toBe(1);
  });

  it("**红**：未登记的路径常量必须 FAIL（不得当作独占放行）", () => {
    const { audit, call } = auditOne(
      `const t = SOME_UNREGISTERED_ROOT;
rmSync(t, { recursive: true, force: true });`,
      "unregistered.ts",
    );

    expect(call.target.kind, "既非共享也未登记独占 ⇒ 无法判断").toBe("unresolved");
    expect(audit.violations.length, "未登记路径必须失败，而不是默认安全").toBe(1);
  });

  it("**红**：即使位于授权条件内，无法解析的目标仍必须 FAIL", () => {
    /*
     * 授权只解决"能不能删共享目录"，不解决"这条到底删什么"。
     * 目标不明时，授权再完整也不能放行。
     */
    const { audit, call } = auditOne(
      `if (process.env.E2E_RESET_DB === "1") {
  rmSync(pickTarget(), { recursive: true, force: true });
}`,
      "guarded-unresolved.ts",
    );

    expect(call.target.kind).toBe("unresolved");
    expect(audit.violations.length, "目标不明时授权不能替代解析").toBe(1);
  });
});

describe("删除目标识别 · 独占合成路径正常通过", () => {
  it("**绿**：已登记的独占源目录清理不需要授权", () => {
    const { audit, call } = auditOne(
      `rmSync(E2E_A3_SOURCE_ROOT, { recursive: true, force: true });`,
      "exclusive-direct.ts",
    );

    expect(call.target.kind).toBe("exclusive");
    expect(audit.violations, "独占路径是合法清场，不应要求授权").toEqual([]);
  });

  it("**绿**：经别名引用的独占路径也不被误拒", () => {
    const { audit, call } = auditOne(
      `const s = E2E_A3_SOURCE_ROOT;
rmSync(s, { recursive: true, force: true });`,
      "exclusive-alias.ts",
    );

    expect(call.target.kind).toBe("exclusive");
    expect(audit.violations, "别名不应让独占路径被误判").toEqual([]);
  });
  it("**绿**：模板拼接的独占数据库路径（受保护）通过", () => {
    const { audit, call } = auditOne(
      `const f = \`\${E2E_A3_DB_PATH}\${suffix}\`;
if (process.env.E2E_RESET_DB === "1") {
  rmSync(f, { force: true });
}`,
      "exclusive-template.ts",
    );

    // `E2E_A3_DB_PATH` 同时出现在共享标记里（它是 A3 的共享库），
    // 因此这里应被归为共享并要求授权 —— 而它确实有授权。
    expect(call.target.kind).toBe("shared");
    expect(audit.violations).toEqual([]);
  });
});

describe("删除目标识别 · 真实生产启动器", () => {
  const LAUNCHERS = readdirSync(join(process.cwd(), "scripts"))
    .filter((name) => /^e2e-server.*\.ts$/.test(name))
    .map((name) => `scripts/${name}`)
    .sort();

  it("被审计的启动器集合非空（防止判据退化为空断言）", () => {
    expect(LAUNCHERS.length).toBeGreaterThan(0);
  });

  for (const launcher of LAUNCHERS) {
    it(`${launcher}：0 违规，且没有无法解析的删除目标`, () => {
      const source = readFileSync(join(process.cwd(), launcher), "utf8");
      const audit = auditSharedRmSync(source, SHARED, GUARD, launcher);

      const unresolved = audit.calls.filter((call) => call.target.kind === "unresolved");
      expect(
        unresolved.map((call) => `line ${call.line}: ${call.firstArgument}`),
        `${launcher} 存在无法解析的删除目标 —— 需要把它登记成独占路径，或修正源码`,
      ).toEqual([]);

      expect(
        audit.violations.map((call) => `line ${call.line}: ${call.firstArgument}`),
        `${launcher} 存在未授权的共享路径删除`,
      ).toEqual([]);
    });
  }

  it("A3 启动器的共享删除确实被识别（非空断言）", () => {
    /*
     * 若解析整体失效，上面每条都会"0 违规"通过。这条钉住最关键的实例：
     * `e2e-server-a3.ts` 里必须真的被识别出共享路径删除。
     */
    const source = readFileSync(join(process.cwd(), "scripts/e2e-server-a3.ts"), "utf8");
    const audit = auditSharedRmSync(source, SHARED, GUARD, "scripts/e2e-server-a3.ts");

    expect(audit.sharedCalls.length, "A3 启动器应至少有一条共享路径删除").toBeGreaterThanOrEqual(2);
  });
});

describe("删除目标识别 · 分类本身不改变授权语义", () => {
  it("共享 + 无授权 ⇒ 违规；共享 + 授权 ⇒ 通过（对照）", () => {
    const unguarded = auditSharedRmSync(
      `rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });`,
      SHARED,
      GUARD,
      "u.ts",
    );
    const guarded = auditSharedRmSync(
      `if (process.env.E2E_RESET_DB === "1") {
  rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });
}`,
      SHARED,
      GUARD,
      "g.ts",
    );

    expect(unguarded.violations.length).toBe(1);
    expect(guarded.violations.length).toBe(0);
  });

  it("`collectRmSyncCalls` 默认使用登记的独占标记", () => {
    const calls = collectRmSyncCalls(
      `rmSync(E2E_A3_SOURCE_ROOT, { recursive: true, force: true });`,
      "default-markers.ts",
    );
    expect(calls[0].target.kind).toBe("exclusive");
  });
});

/**
 * 可变别名绕过（本轮修复的漏洞）。
 *
 * ── 缺陷形态 ──
 *
 * 判据依赖"从标识符找到它的 const 声明，读初始化表达式"。但早先的实现
 * **没有核对声明是不是不可变的**：
 *
 *     let target = E2E_A3_SOURCE_ROOT;   // 初始化看起来像独占
 *     target = E2E_A3_CONTENT_ROOT;      // 之后被改成共享路径
 *     rmSync(target, ...);               // 仍按"独占"放行 —— violations=0
 *
 * 这是 fail-open 的典型形态：门禁读的是**初始化那一刻**的值，而实际删除
 * 发生在**重新赋值之后**。
 *
 * ── 修法 ──
 *
 * 只有 `const` 声明才可能作为别名链的一环；`let` / `var` 一律
 * `unresolved`（失败关闭）。这依赖 `NodeFlags.Const` 这个 AST 权威表示，
 * 而不是关键字文本匹配。
 *
 * 刻意**不做**赋值分析：判断"后面有没有条件赋值"需要真正的控制流分析
 * （条件分支、循环、try/catch、闭包捕获），而本门禁的职责是"证明目标
 * 必然是什么"，不是"尽力推断"。拒绝所有可变别名的代价是极少数误报，
 * 放行一个漏报的代价是删掉另一个实例正在读的目录。
 *
 * 实测确认：全部真实启动器的删除目标都是直接常量或 `const` 别名，
 * 因此这条严格规则不阻断任何现有启动器。
 */
describe("删除目标识别 · 可变别名必须失败关闭", () => {
  it("**A. 红**：let 初始为 exclusive、之后改成 shared ⇒ 必须拒绝", () => {
    const { audit, call } = auditOne(
      `let target = E2E_A3_SOURCE_ROOT;
target = E2E_A3_CONTENT_ROOT;
rmSync(target, { recursive: true, force: true });`,
      "let-reassigned.ts",
    );

    expect(call.target.kind, "let 声明不可作为目标证明").toBe("unresolved");
    expect(audit.violations.length, "可变别名必须失败关闭").toBe(1);
    if (call.target.kind === "unresolved") {
      expect(call.target.reason).toMatch(/let|重新赋值/);
    }
  });

  it("**B. 红**：var 初始为 exclusive、之后改成 shared ⇒ 必须拒绝", () => {
    const { audit, call } = auditOne(
      `var target = E2E_A3_SOURCE_ROOT;
target = E2E_A3_CONTENT_ROOT;
rmSync(target, { recursive: true, force: true });`,
      "var-reassigned.ts",
    );

    expect(call.target.kind).toBe("unresolved");
    expect(audit.violations.length).toBe(1);
    if (call.target.kind === "unresolved") {
      expect(call.target.reason).toMatch(/var|重新赋值/);
    }
  });

  it("**C. 红**：const 别名引用 let 变量 ⇒ 不能因外层 const 而放行", () => {
    /*
     * 这是最容易漏的一种：外层看起来是 `const`，很"安全"，
     * 但它指向的底层变量是可变的。不可变性必须**逐层**成立，
     * 而不是只看最外层那一条。
     */
    const { audit, call } = auditOne(
      `let mutable = E2E_A3_SOURCE_ROOT;
const alias = mutable;
mutable = E2E_A3_CONTENT_ROOT;
rmSync(alias, { recursive: true, force: true });`,
      "const-over-let.ts",
    );

    expect(call.target.kind, "别名链上有一层可变即无法证明").toBe("unresolved");
    expect(audit.violations.length, "外层 const 不能掩盖底层可变性").toBe(1);
  });

  it("**C2. 红**：let 即使从未重新赋值也必须拒绝（不做赋值分析）", () => {
    /*
     * 若放行"从未被重新赋值的 let"，就需要证明没有条件赋值、没有循环内
     * 赋值、没有被闭包捕获后修改 —— 那已经是控制流分析。
     * 本门禁刻意不承担那个复杂度：一律拒绝。
     */
    const { audit, call } = auditOne(
      `let target = E2E_A3_SOURCE_ROOT;
rmSync(target, { recursive: true, force: true });`,
      "let-not-reassigned.ts",
    );

    expect(call.target.kind).toBe("unresolved");
    expect(audit.violations.length).toBe(1);
  });

  it("**D. 绿**：const 单层别名保持原有通过行为", () => {
    const { audit, call } = auditOne(
      `const s = E2E_A3_SOURCE_ROOT;
rmSync(s, { recursive: true, force: true });`,
      "const-one-level.ts",
    );

    expect(call.target.kind).toBe("exclusive");
    expect(audit.violations).toEqual([]);
  });

  it("**D2. 绿**：const 双层别名保持原有通过行为", () => {
    const { audit, call } = auditOne(
      `const a = E2E_A3_SOURCE_ROOT;
const b = a;
rmSync(b, { recursive: true, force: true });`,
      "const-two-level.ts",
    );

    expect(call.target.kind).toBe("exclusive");
    expect(audit.violations).toEqual([]);
  });

  it("**E. 绿**：受保护的 shared 删除正常通过", () => {
    const { audit } = auditOne(
      `if (process.env.E2E_RESET_DB === "1") {
  rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });
}`,
      "guarded-shared.ts",
    );

    expect(audit.violations).toEqual([]);
  });

  it("**F. 红**：未经授权的 shared 删除继续拒绝", () => {
    const { audit } = auditOne(
      `rmSync(E2E_A3_CONTENT_ROOT, { recursive: true, force: true });`,
      "unguarded-shared.ts",
    );

    expect(audit.violations.length).toBe(1);
  });

  it("**G. 绿**：已登记的直接 exclusive 路径正常通过", () => {
    const { audit, call } = auditOne(
      `rmSync(E2E_A3_SOURCE_ROOT, { recursive: true, force: true });`,
      "direct-exclusive.ts",
    );

    expect(call.target.kind).toBe("exclusive");
    expect(audit.violations).toEqual([]);
  });

  it("**H. 红**：不同作用域同名变量不得被误识别为同一声明", () => {
    /*
     * 早先的查找在每个祖先块里用 `forEachChild` 深搜，于是内层块里的
     * 同名声明会被外层的引用"看见"。结果：引用的其实是外层的
     * `E2E_A3_CONTENT_ROOT`（共享、无授权），却被判成内层的
     * `E2E_A3_SOURCE_ROOT`（独占）而放行。
     */
    const { audit, call } = auditOne(
      `if (true) {
  const t = E2E_A3_SOURCE_ROOT;
  void t;
}
const t = E2E_A3_CONTENT_ROOT;
rmSync(t, { recursive: true, force: true });`,
      "shadowed.ts",
    );

    expect(call.target.kind, "应解析到外层那条声明（共享）").toBe("shared");
    expect(audit.violations.length, "外层共享删除无授权，必须拒绝").toBe(1);
  });

  it("**H2. 绿**：内层引用确实使用内层声明（不是一律拒绝）", () => {
    /*
     * 作用域修复不能变成"凡有同名就拒绝" —— 那样会把正确代码误判。
     * 内层块里的引用必须解析到内层那条 const。
     */
    const { audit, call } = auditOne(
      `const t = E2E_A3_CONTENT_ROOT;
if (true) {
  const t = E2E_A3_SOURCE_ROOT;
  rmSync(t, { recursive: true, force: true });
}`,
      "shadowed-inner.ts",
    );

    expect(call.target.kind, "内层引用应解析到内层声明").toBe("exclusive");
    expect(audit.violations).toEqual([]);
  });
});
