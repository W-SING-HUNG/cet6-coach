#!/usr/bin/env node
/**
 * E2E **隐私配置门禁自身的**红/绿变异证明。
 *
 * ── 它证明什么 ──
 *
 * "门禁当前是绿的"不能证明门禁真的会拦住回归 —— 一条恒真的断言也是绿的。
 * 因此这里**故意把真实内容启动器写回默认合成清单**（缺陷形态），
 * 逐条证明门禁**确实会变红**，然后逐字节恢复。
 *
 * ── 它**绝不**启动任何服务（硬性要求）──
 *
 * 本脚本施加的变异是**纯配置对象**层面的：它改的是
 * `e2e/web-servers.ts` 里 `SYNTHETIC_WEB_SERVERS` 数组的内容，
 * 然后跑 **vitest**（纯 Node 进程内测试）。
 *
 * vitest **不会**执行 Playwright 的 `webServer` —— 只有 `playwright test`
 * 才会那样做。因此整个过程里：
 *
 * - 没有任何 `next start` 被拉起；
 * - 没有任何内容根被真正读取；
 * - 私有内容既没被打开也没被索引。
 *
 * 脚本会在施加变异**之前**断言这一点（检查自己没有调用 playwright CLI）。
 *
 * ── 每个变异必须证明五件事（沿用既有变异脚本的纪律）──
 *
 * 1. **锚点恰好命中一次** —— 否则"报无法施加并跳过"会让变异测试
 *    **看起来跑了但什么都没验证**。0 次或多次一律判**失败**。
 * 2. **变异真的改变了字节** —— 否则是空操作。
 * 3. **目标测试确实变红**，且失败原因是那条门禁。
 * 4. **恢复逐字节一致** —— 用 sha256 比对。
 * 5. **恢复后重新全绿**。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

interface Mutation {
  id: string;
  guard: string;
  file: string;
  from: string;
  to: string;
  testName: string;
  expectReason: RegExp;
  /**
   * 需要**同时**施加的第二个锚点（同文件、同一次写入）。
   *
   * 有些缺陷形态需要两处改动才成立。P1 就是例子：把真实启动器拼进
   * `webServer` 数组之前，必须先把它 import 进来 —— 否则变异后的文件
   * 会因"未定义标识符"在**加载期**失败，那是"因为错误的理由变红"，
   * 掩盖了真实判据是否有效。
   */
  also?: { from: string; to: string };
}

/** 门禁测试文件（所有变异都作用在它上面）。 */
const GUARD_TEST = "tests/e2e-privacy-config.test.ts";

/**
 * 变异脚本头部的覆盖表（与下方 MUTATIONS 一一对应）。
 *
 * | 编号 | 守卫 | 对应缺陷 |
 * | --- | --- | --- |
 * | P1 | 默认配置的 webServer 实际取值干净 | 真实启动器被拼回默认配置（原始缺陷） |
 * | P2 | 不得用自动探测启用真实路径 | 本机有私有材料即静默放行 |
 * | P3 | testIgnore 必须**实际生效** | 键还在但值为空 ⇒ 真实 spec 回到默认套件 |
 * | P4 | 具名 opt-in 脚本 | 真实配置接进默认 `pnpm e2e` |
 * | P5 | 显式配置必须挂真实实例 | 真实配置忘了挂服务 ⇒ 静默跑空 |
 * | P6 | 两个配置消费同一份清单 | 各自写死清单 ⇒ 新增 spec 时漂移 |
 * | P7 | 源码检查清单覆盖全部已注册启动器 | **未登记的新默认启动器逃过内容根检查** |
 * | P8 | 每个启动器都必须可解析 | 命令无法解析 ⇒ 实例推导判据失效 |
 *
 * 由 `tests/e2e-privacy-config.test.ts` 的同源用例守护这张表与实际数组一致。
 */

const MUTATIONS: Mutation[] = [
  {
    id: "P1",
    guard: "默认配置的 webServer 实际取值里不得出现真实内容启动器",
    file: "playwright.config.ts",
    /*
     * 缺陷形态：把真实启动器**加回默认配置** —— 这正是原始缺陷本身。
     *
     * ── 为什么变异点在这里，而不是往合成清单里塞 ──
     *
     * 早先把变异放在 `e2e/web-servers.ts`（把 REAL_CONTENT_WEB_SERVER 插进
     * SYNTHETIC_WEB_SERVERS 数组）。那个写法是**顺序错误的代码**：
     * 该常量定义在清单之后，于是模块在加载时就抛 TDZ 错误
     * （"Cannot access before initialization"）。
     *
     * 那会让门禁"变红"—— 但**因为错误的理由**：测试根本没有执行，
     * 只是 import 失败了。这种"捕获"是假象，且掩盖了真实判据是否有效。
     * 因此变异必须是一个**语法/顺序都合法、语义上确实危险**的改动。
     *
     * 它同时把 import 补上，否则变异后的文件会因未定义标识符而
     * 在加载期失败 —— 那又是"因为错误的理由变红"。
     */
    from: `import { SYNTHETIC_WEB_SERVERS } from "./e2e/web-servers";`,
    to: `import { SYNTHETIC_WEB_SERVERS, REAL_CONTENT_WEB_SERVER } from "./e2e/web-servers";`,
    testName: "实际 webServer 取值里没有私有内容启动器",
    expectReason: /会启动读取私有内容的 webServer|e2e-server-real/,
    /*
     * 第二个锚点：变异必须**同时**把真实启动器拼进 webServer 数组，
     * 否则只补 import 不会改变任何行为（未使用的导入）。
     */
    also: {
      from: `  webServer: [...SYNTHETIC_WEB_SERVERS],`,
      to: `  webServer: [...SYNTHETIC_WEB_SERVERS, REAL_CONTENT_WEB_SERVER],`,
    },
  },
  {
    id: "P2",
    guard: "默认配置的代码不得用自动探测启用真实内容路径",
    file: "playwright.config.ts",
    // 缺陷形态：用"私有内容存在"来自动启用 —— 那会让本机恰好有材料时静默放行。
    from: `  webServer: [...SYNTHETIC_WEB_SERVERS],`,
    to: `  webServer: process.env.CET6_CONTENT_ROOT ? [...SYNTHETIC_WEB_SERVERS] : [...SYNTHETIC_WEB_SERVERS],`,
    testName: "真实内容路径**不靠自动探测**启用",
    expectReason: /不得用|自动探测/,
  },
  {
    id: "P3",
    guard: "默认配置的 testIgnore 必须**实际生效**地排除真实专用 spec",
    file: "playwright.config.ts",
    /*
     * 缺陷形态：把 testIgnore 的值清空。
     *
     * ── 这是本轮新补上的变异，它证明了一个真实缺口 ──
     *
     * 早先的门禁只断言"配置里有 testIgnore 这个键"。把值改成 `[]` 时，
     * 键还在 —— 源码字符串断言照样通过，而"排除"已经不成立：
     * 真实专用 spec 会回到默认套件里，去连一个默认配置**不会启动**的服务。
     *
     * 因此判据必须落在**取值**上（见 tests/e2e-privacy-config.test.ts 的
     * "实际生效地排除"用例）。
     */
    from: `  testIgnore: E2E_REAL_ONLY_SPECS.map((name) => \`**/\${name}\`),`,
    to: `  testIgnore: [],`,
    testName: "实际生效**地排除了全部真实专用 spec",
    expectReason: /未排除真实专用 spec|等于不排除|expected/,
  },
  {
    id: "P4",
    guard: "具名 opt-in 脚本必须存在，且默认脚本不得指向真实配置",
    file: "package.json",
    // 缺陷形态：把真实配置接进默认 e2e 脚本 —— 于是普通的 pnpm e2e 就会读私有内容。
    from: `    "e2e": "playwright test",`,
    to: `    "e2e": "playwright test --config playwright.real.config.ts",`,
    testName: "显式 opt-in 有具名 npm 脚本",
    expectReason: /默认 e2e 脚本不得指向真实配置|expected/,
  },
  {
    id: "P5",
    guard: "显式 opt-in 配置必须真的包含真实内容启动器（否则它没有存在意义）",
    file: "playwright.real.config.ts",
    // 缺陷形态：真实配置忘了挂真实实例 —— 它就会静默跑在没有服务的端口上。
    from: `  webServer: [REAL_CONTENT_WEB_SERVER],`,
    to: `  webServer: [],`,
    testName: "显式配置只挂真实内容启动器",
    expectReason: /必须包含真实内容启动器|expected/,
  },
  {
    id: "P6",
    guard: "两个配置必须消费**同一份**真实专用 spec 清单",
    file: "playwright.config.ts",
    /*
     * 缺陷形态：默认配置改用**自己写死**的清单（而不是共享常量）。
     * 这正是"两份清单各自漂移"的起点：新增一个真实 spec 时只加到一个配置里。
     */
    from: `  testIgnore: E2E_REAL_ONLY_SPECS.map((name) => \`**/\${name}\`),`,
    to: `  testIgnore: ["**/real-paper.local.spec.ts"],`,
    testName: "默认配置把真实专用 spec 排除在外，且与显式配置**消费同一份清单**",
    expectReason: /必须消费 E2E_REAL_ONLY_SPECS|expected/,
  },
  {
    id: "P7",
    guard: "源码级检查清单必须覆盖**全部**实际注册的合成启动器（未登记的新启动器会失败）",
    file: "e2e/web-servers.ts",
    /*
     * 缺陷形态：新增一个默认合成启动器，但**不**把它加进
     * `tests/e2e-privacy-config.test.ts` 的源码检查清单。
     *
     * 这正是任务书里"未登记的新默认启动器不能逃过检查"那条要求守护的
     * 回归：没有这条判据时，新启动器的内容根从未被检查，而门禁全绿。
     *
     * 变异把一个**看似无害的新实例**（注释服务器、端口不冲突、无内容根）
     * 追加进默认清单 —— 它不读私有内容，因此旧的判据全都拦不住它，
     * 而新的实例推导判据必须报出来。
     */
    from: `      PORT: String(E2E_A3_COMPANION_PORT),
    },
  },
] as const;`,
    to: `      PORT: String(E2E_A3_COMPANION_PORT),
    },
  },
  {
    // 变异：一个未登记的新默认启动器（脚本名从未出现在源码检查清单里）。
    // 它不读任何内容，因此只有「实例推导」这类判据能抓住它。
    command: \`node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-unregistered.ts\`,
    url: E2E_COMPANION_BASE_URL,
    reuseExistingServer: false,
    timeout: 180_000,
    stdout: "pipe" as const,
    stderr: "pipe" as const,
    env: {
      PORT: String(E2E_COMPANION_PORT),
    },
  },
] as const;`,
    testName: "源码级检查的清单覆盖**全部**实际注册的合成启动器",
    expectReason: /未出现在源码级检查清单里|逃过了|expected/,
  },
  {
    id: "P8",
    guard: "每个注册的合成启动器都必须能被解析出脚本（解析不出 ⇒ 无法检查）",
    file: "e2e/web-servers.ts",
    /*
     * 缺陷形态：把命令写成**无法解析**的形态（例如多出一个 scripts/ token）。
     * 此时 `launcherScriptOf` 返回 null，实例推导判据失去作用对象 ——
     * 它必须报失败，而不是静默放过。
     */
    from: `    command: \`node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-annotation.ts\`,
    url: E2E_ANNOTATION_BASE_URL,`,
    to: `    command: \`node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/e2e-server-annotation.ts extra-token scripts/decoy.ts\`,
    url: E2E_ANNOTATION_BASE_URL,`,
    testName: "每个注册的合成启动器都能被解析出脚本",
    expectReason: /无法从 webServer 命令解析出启动器脚本|无法解析|expected/,
  },
];

/**
 * 把锚点规范化到目标文件的**实际行尾**。
 *
 * 仓库 blob 是 LF，而本机 `core.autocrlf=true` 让检出成为 CRLF。
 * 行尾敏感的锚点在 CRLF 上会静默命中 0 次。
 */
function alignLineEndings(anchor: string, fileContent: string): string {
  const usesCrlf = fileContent.includes("\r\n");
  return usesCrlf ? anchor.replace(/\r?\n/g, "\r\n") : anchor.replace(/\r\n/g, "\n");
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface TestRun {
  passed: boolean;
  summary: string;
  output: string;
  executed: number;
}

/**
 * 只跑 vitest（**绝不**跑 playwright）。
 *
 * 这一点是本脚本的安全前提：Playwright 的 webServer 只有 `playwright test`
 * 会启动；vitest 只会加载配置模块并读它的导出对象。
 */
function runGuardTests(name?: string): TestRun {
  const vitestEntry = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  const args =
    name === undefined || name === ""
      ? ["run", GUARD_TEST]
      : ["run", GUARD_TEST, "-t", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")];
  const result = spawnSync(process.execPath, [vitestEntry, ...args], {
    encoding: "utf8",
    shell: false,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/\u001b\[[0-9;]*m/g, "");
  const testsLine = output.split("\n").find((line) => /Tests\s+/.test(line)) ?? "";
  const failed = Number(/(\d+)\s+failed/.exec(testsLine)?.[1] ?? 0);
  const passedCount = Number(/(\d+)\s+passed/.exec(testsLine)?.[1] ?? 0);
  const summaryLines = output
    .split("\n")
    .filter((line) => /Tests\s+\d+|Test Files\s+\d+/.test(line))
    .map((line) => line.trim())
    .join(" | ");
  return {
    passed: result.status === 0,
    summary: summaryLines.trim() || `(退出码 ${result.status})`,
    output,
    executed: failed + passedCount,
  };
}

function main(): void {
  console.log("E2E 隐私配置门禁 · 红/绿变异证明");
  console.log("（全程只跑 vitest；**不启动任何 webServer**，不读任何私有内容）\n");

  /*
   * 安全自证：本脚本的源码里不得出现 playwright CLI 调用，
   * 也不得出现任何真实内容启动器的执行路径。
   */
  const self = readFileSync(new URL(import.meta.url), "utf8");
  const selfCode = self.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  if (/playwright["']?\s*,\s*\[["']test/.test(selfCode) || /spawnSync\(\s*["']playwright/.test(selfCode)) {
    console.error("!! 本脚本试图调用 playwright CLI —— 那会启动 webServer。拒绝执行。");
    process.exitCode = 1;
    return;
  }
  if (!selfCode.includes("vitest.mjs")) {
    console.error("!! 本脚本必须只跑 vitest。拒绝执行。");
    process.exitCode = 1;
    return;
  }
  console.log("安全自证：只调用 vitest 入口模块，未引用 playwright CLI。\n");

  // ── 基准：未变异时必须全绿 ──
  console.log("基准（未变异）");
  const baseline = runGuardTests();
  console.log(`  ${baseline.passed ? "✓" : "✗"} ${GUARD_TEST}  ${baseline.summary}`);
  if (!baseline.passed) {
    console.error("\n基准未通过 ⇒ 变异证明无意义。请先修好门禁。");
    process.exitCode = 1;
    return;
  }

  let caught = 0;
  const problems: string[] = [];

  console.log("");
  for (const mutation of MUTATIONS) {
    const path = join(process.cwd(), mutation.file);
    const original = readFileSync(path, "utf8");
    const originalHash = sha256(original);

    // ① 锚点必须恰好命中一次
    const from = alignLineEndings(mutation.from, original);
    const to = alignLineEndings(mutation.to, original);
    const occurrences = original.split(from).length - 1;
    if (occurrences !== 1) {
      console.log(`  ✗ ${mutation.id} 锚点无效（命中 ${occurrences} 次，需恰好 1 次）：${mutation.guard}`);
      console.log(`      文件：${mutation.file}`);
      problems.push(`${mutation.id}（锚点命中 ${occurrences} 次）`);
      continue;
    }

    const mutated = original.replace(from, to);
    // ② 必须真的改变字节
    if (mutated === original) {
      console.log(`  ✗ ${mutation.id} 变异未改变字节：${mutation.guard}`);
      problems.push(`${mutation.id}（空操作）`);
      continue;
    }

    /*
     * 施加伴随锚点（若声明）。它同样必须恰好命中一次，否则这条变异
     * 可能只改了一半 —— 那样"测试变红"证明的不是我们以为的那件事。
     */
    let withAlso = mutated;
    if (mutation.also) {
      const alsoFrom = alignLineEndings(mutation.also.from, mutated);
      const alsoTo = alignLineEndings(mutation.also.to, mutated);
      const alsoOccurrences = mutated.split(alsoFrom).length - 1;
      if (alsoOccurrences !== 1) {
        console.log(
          `  ✗ ${mutation.id} 伴随锚点无效（命中 ${alsoOccurrences} 次，需恰好 1 次）：${mutation.guard}`,
        );
        problems.push(`${mutation.id}（伴随锚点命中 ${alsoOccurrences} 次）`);
        continue;
      }
      withAlso = mutated.replace(alsoFrom, alsoTo);
      if (withAlso === mutated) {
        console.log(`  ✗ ${mutation.id} 伴随变异未改变字节：${mutation.guard}`);
        problems.push(`${mutation.id}（伴随空操作）`);
        continue;
      }
    }

    let failure: string | null = null;
    try {
      writeFileSync(path, withAlso, "utf8");

      // ③ 门禁必须变红，且失败原因是那条门禁
      const result = runGuardTests(mutation.testName);
      if (result.executed === 0) {
        failure = `-t "${mutation.testName}" 未匹配到任何用例（过滤器无效，变异未被验证）`;
      } else if (result.passed) {
        failure = `门禁仍然全绿（跑了 ${result.executed} 条）⇒ 该门禁拦不住这条回归`;
      } else if (!mutation.expectReason.test(result.output)) {
        failure = `门禁变红了，但失败原因与守卫无关（期望 ${mutation.expectReason}）`;
      } else {
        console.log(`  ✓ ${mutation.id} 被捕获：${mutation.guard}`);
        console.log(`      ${result.summary}`);
      }
    } finally {
      // ④ 无论成败都恢复，并逐字节核对
      writeFileSync(path, original, "utf8");
      if (sha256(readFileSync(path, "utf8")) !== originalHash) {
        console.error(`  !! ${mutation.id} 恢复后字节能不一致 —— 工作区可能残留变异`);
        problems.push(`${mutation.id}（恢复不一致）`);
        process.exitCode = 1;
        return;
      }
    }

    if (failure !== null) {
      console.log(`  ✗ ${mutation.id} **未被正确捕获**：${mutation.guard}`);
      console.log(`      ${failure}`);
      problems.push(mutation.id);
      continue;
    }
    caught += 1;
  }

  // ── ⑤ 恢复后必须重新全绿 ──
  console.log("\n恢复后复验");
  const restored = runGuardTests();
  console.log(`  ${restored.passed ? "✓" : "✗"} ${GUARD_TEST}  ${restored.summary}`);

  console.log("");
  console.log(`结果：${caught} / ${MUTATIONS.length} 个变异被门禁**正确**捕获。`);
  if (problems.length > 0) {
    console.log(`有问题：${problems.join("、")}`);
    process.exitCode = 1;
  }
  if (!restored.passed) {
    console.log("**恢复后未全绿** —— 工作区可能残留变异，请检查。");
    process.exitCode = 1;
  }
}

main();
