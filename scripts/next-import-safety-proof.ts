#!/usr/bin/env node
/**
 * `scripts/next.mjs` 的**导入无副作用**回归（Final P2 第 2 项）。
 *
 * ── 它守的那个真实缺陷 ──
 *
 * 独立审查复现：在一个 `process.argv` **非空**的 CLI 里
 * `import { telemetryOffEnv } from "./scripts/next.mjs"`，会意外触发
 * `main(argv)`，用 **import 者自己的参数**去 spawn Next.js。
 *
 * 根因是入口判断只加在**空 argv** 分支上：
 *
 * ```js
 * if (argv.length === 0) { if (isMainModule()) { …exit… } }   // ← 有判断
 * else { main(argv); }                                        // ← 没有判断！
 * ```
 *
 * 于是"argv 非空 + 被 import"这条路径直接跑了 `main`。
 * 实测后果：起了一个**不受控的 Next 进程**
 * （`Invalid project directory provided, no such directory: …some-positional-arg`）。
 *
 * ── 为什么必须是**子进程**测试 ──
 *
 * 副作用发生在**模块求值**阶段，而且取决于 `process.argv` ——
 * 这两件事在同一个进程内的单元测试里都无法如实复现
 * （vitest 自己的 argv 就非空，且模块只求值一次）。
 * 因此必须真的起一个子进程，各自带自己的 argv。
 *
 * ── 隐私与安全边界 ──
 *
 * - 只用**合成且无害**的参数（`some-positional-arg`、`--synthetic-flag`）；
 * - 刻意不用 `dev` / `start` 这类会起监听器的子命令 ——
 *   那会开一个不受控的端口；
 * - 不访问 `private-content/`、真实数据库或任何真实派生物；
 * - 不起真实的 Next 服务（"直接调用"那一组只用 `telemetry status`，
 *   它是只读的）。
 */

import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 一个 import `next.mjs` 的最小脚本（写在临时目录，跑完即删）。 */
const IMPORTER_SOURCE = `
import { telemetryOffEnv, TELEMETRY_OFF_ENV } from "./scripts/next.mjs";
// 导入成功必须留下**可观测**的痕迹，否则"没输出"与"没执行"无法区分。
process.stdout.write("IMPORTED:" + JSON.stringify(telemetryOffEnv()) + ":" + TELEMETRY_OFF_ENV);
`;

/** 跑一个子进程，返回输出与退出码。 */
function run(
  command: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    shell: false,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    combined: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

let failed = 0;
function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${label}${detail === "" ? "" : `（${detail}）`}`);
  }
}

/**
 * Next 进程**真的被起来**时会留下的痕迹。
 *
 * 判据刻意用"启动横幅"而不是"端口在听"：后者要在子进程退出前探测，
 * 而不受控的进程可能起不来（例如参数不是合法目录）——
 * 那正是审查复现的形态（报 `Invalid project directory` 后退出）。
 * 两种情况都算"被意外启动"，都必须让测试红。
 */
const NEXT_STARTED_MARKERS = [
  "Next.js",
  "▲ Next.js",
  "Local:",
  "Invalid project directory",
  "could not be found",
  "ENOENT",
];

function looksLikeNextStarted(output: string): boolean {
  return NEXT_STARTED_MARKERS.some((marker) => output.includes(marker));
}

function main() {
  console.log("scripts/next.mjs 导入无副作用 · 子进程回归\n");

  /*
   * importer 必须放在**仓库内**：它用相对路径 `./next.mjs` 导入，
   * 而 Node 的 ESM 相对导入按**导入者文件的位置**解析 ——
   * 放临时目录会解析到别处（实测踩到 ERR_MODULE_NOT_FOUND）。
   * 因此写在仓库根下一个临时名，finally 里删掉。
   */
  const importerPath = join(process.cwd(), "zz-next-import-probe.mjs");
  try {
    writeFileSync(importerPath, IMPORTER_SOURCE, "utf8");

    /*
     * ── ① import + **空** argv ──
     *
     * 这是上一版唯一被覆盖的分支，必须继续成立。
     */
    const noArgs = run(process.execPath, [importerPath]);
    check(
      "import（无额外参数）⇒ 只打印导入痕迹，不起 Next",
      noArgs.combined.includes("IMPORTED:") && !looksLikeNextStarted(noArgs.combined),
      noArgs.combined.trim().slice(0, 160),
    );
    check("import（无额外参数）⇒ 退出码 0", noArgs.status === 0, `退出码 ${noArgs.status}`);
    check(
      "import（无额外参数）⇒ 不打印 CLI 用法错误",
      !noArgs.combined.includes("用法：node scripts/next.mjs"),
    );

    /*
     * ── ② import + **非空** argv（被复现的缺陷路径）──
     *
     * 参数刻意是**无害**的位置参数：它不是一个合法的 Next 项目目录，
     * 因此万一 `main` 真的跑了，Next 会立刻报错退出 ——
     * 那正好留下痕迹，而不会起一个持续监听的东西。
     */
    const withArgs = run(process.execPath, [
      importerPath,
      "some-positional-arg",
      "--synthetic-flag",
      "value",
    ]);
    check(
      "import（带任意位置参数）⇒ 只打印导入痕迹，不起 Next",
      withArgs.combined.includes("IMPORTED:") && !looksLikeNextStarted(withArgs.combined),
      withArgs.combined.trim().slice(0, 200),
    );
    check(
      "import（带任意位置参数）⇒ 退出码 0（没有被 process.exit 打断）",
      withArgs.status === 0,
      `退出码 ${withArgs.status}`,
    );
    check(
      "import（带任意位置参数）⇒ 不打印 CLI 用法错误",
      !withArgs.combined.includes("用法：node scripts/next.mjs"),
    );

    /*
     * ── ③ import 者自己 argv 里的 Next 子命令**不得**被执行 ──
     *
     * 这一条比 ② 更严：参数本身就是 `telemetry status`。
     * 若 `main(argv)` 被触发，它会**真的**跑一次 Next CLI ——
     * 输出里会出现 `Status:`。判据是那个串**不得**出现。
     */
    const nextishArgs = run(process.execPath, [importerPath, "telemetry", "status"]);
    check(
      "import（参数含 telemetry status）⇒ 不得执行该 Next 命令",
      nextishArgs.combined.includes("IMPORTED:") && !nextishArgs.combined.includes("Status:"),
      nextishArgs.combined.trim().slice(0, 200),
    );

    /*
     * ── ④ 直接调用必须**仍然工作**（不能把入口整个关掉）──
     *
     * 只修"import 有副作用"而把直接调用也弄坏，是另一种失败。
     * 用 `telemetry status` 而不是 `dev`/`start`：它是只读的，
     * 不会起监听器（本脚本不得开不受控的端口）。
     */
    const direct = run(process.execPath, [join("scripts", "next.mjs"), "telemetry", "status"]);
    check(
      "直接调用 telemetry status ⇒ 真的执行了 Next 命令",
      direct.combined.includes("Status:"),
      direct.combined.trim().slice(0, 200),
    );
    check(
      "直接调用 ⇒ 遥测保护仍然生效（NextEXT_TELEMETRY_DISABLED 已注入）",
      /Status:\s*Disabled/i.test(direct.combined),
      direct.combined.trim().slice(0, 200),
    );

    /*
     * ── ⑤ 直接调用但**不给**子命令 ⇒ 用法错误 + 退出码 2 ──
     *
     * 这一条固定"入口仍然会拒绝无效用法"—— 它是上一版就有的行为，
     * 修 import 副作用时不能被顺手删掉。
     */
    const noSubcommand = run(process.execPath, [join("scripts", "next.mjs")]);
    check(
      "直接调用但无子命令 ⇒ 打印用法错误",
      noSubcommand.combined.includes("用法：node scripts/next.mjs"),
    );
    check(
      "直接调用但无子命令 ⇒ 退出码 2",
      noSubcommand.status === 2,
      `退出码 ${noSubcommand.status}`,
    );

    /*
     * ── ⑥ 退出码透传（直接调用路径的行为契约）──
     *
     * `next telemetry status` 成功时退出 0。若 wrapper 把退出码吞了，
     * CI 就看不到失败 —— 因此单独固定一条。
     */
    check("直接调用成功 ⇒ 退出码 0", direct.status === 0, `退出码 ${direct.status}`);
  } finally {
    rmSync(importerPath, { force: true });
  }

  console.log(`\n结果：${failed === 0 ? "通过" : `${failed} 项失败`}`);
  if (failed > 0) process.exitCode = 1;
}

main();
