#!/usr/bin/env node
/**
 * 人工分段计划的**变异测试**（mutation testing）。
 *
 * ── 它证明什么 ──
 *
 * "测试通过"本身不能证明守卫是真的。一条被写弱的断言、一个恒真的条件
 * 都会让测试全绿而缺陷照样存在。因此这里**故意把守卫改回缺陷形态**，
 * 逐条证明对应的测试**确实会变红**，然后恢复。
 *
 * ── 每个变异必须证明五件事（F7：变异工具本身也要自证）──
 *
 * 1. **锚点恰好命中一次** —— 否则脚本会"报无法施加并跳过"，
 *    于是变异测试**看起来跑了但其实什么都没验证**。
 *    命中 0 次或多次一律判**失败**（不是"跳过"）。
 * 2. **变异真的改变了字节** —— 否则那条"变异"是空操作，测试当然是绿的。
 * 3. **目标测试确实变红**，且**失败原因**是那条守卫（不是别的偶然失败）。
 * 4. **恢复逐字节一致** —— 用 sha256 比对，而不是"写回去就当好了"。
 * 5. **恢复后目标测试重新全绿**。
 *
 * 早期版本只做 `spawnSync` 的退出码判断，那满足不了 (1)(2)(4)：
 * 一次行尾差异就能让它静默跳过全部变异而退出 0。
 *
 * ── 覆盖的守卫（任务书要求的九类 + 复评新增）──
 *
 * | 编号 | 守卫 | 对应缺陷 |
 * | --- | --- | --- |
 * | M1 | 源摘要陈旧 | 旧选择器被静默套到新源上 |
 * | M2 | 资产校验和 | 计划绑定的字节已变却照旧生效 |
 * | M3 | 未指派内容 | 人工分段静默丢内容 |
 * | M4 | 重叠（**含同单元同通道**） | 同一行被写进正文两遍（F3） |
 * | M5 | 选择器越界 | 坐标取不到行却照旧产段 |
 * | M6 | 多资产契约 | 跨资产计划静默产出空正文（F6） |
 * | M7 | 投影遍历**每一个**范围 | 第二条范围被吞掉（F2） |
 * | M8 | 投影/计数一致性断言 | 覆盖率与投影脱钩（F2/F3 兜底） |
 * | M9 | 计划校验和参与候选身份 | 改结构后旧复核继续有效（F7） |
 * | M10 | 不可裁决性 | 未指派/绑定不符被一句话化解 |
 * | M11 | 旧候选向后兼容 | 新增字段让历史候选被误判自相矛盾 |
 * | M12 | 未认证端点不下发私有正文与 token | 本机任意进程取得私有内容与写能力（F4） |
 * | M13 | 私有引导端点校验 token | 未认证读走私有正文（F4） |
 * | M14 | 只监听回环 | 私有材料暴露到局域网（F7） |
 * | M15 | 写操作校验 token | 无鉴权写盘 |
 * | M16 | 服务端重建 binding | 过期页面写出陈旧计划 |
 * | M17 | 客户端脚本可编译 | 标注页 JS 语法非法（F1） |
 * | M18 | 显式 --plan 失败关闭 | 显式计划不可用却静默走自动分段（F5） |
 * | M19 | 引导成功后启用 Save | Save 永远停在初始禁用态 ⇒ 流程走不完（复评第二轮阻断项） |
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

interface Mutation {
  /** 变异编号（输出用）。 */
  id: string;
  /** 守的是哪一条语义。 */
  guard: string;
  /** 被变异的文件。 */
  file: string;
  /** 原文（必须唯一命中一次）。 */
  from: string;
  /** 缺陷形态（把守卫去掉/改成 fail-open）。 */
  to: string;
  /** 期望变红的测试文件。 */
  testFile: string;
  /** `-t` 过滤串（用例名的一部分）。 */
  testName: string;  /**
   * 期望的失败原因片段（在测试输出里必须出现）。
   *
   * 这条把"变红"从"退出码非 0"升级为"**因为那条守卫**变红" ——
   * 否则一个无关的偶发失败也会被当成"变异被捕获"。
   */
  expectReason: RegExp;
  /**
   * 需要**同时施加**的伴随变异（同文件、同一次写入）。
   *
   * ── 为什么需要这个字段 ──
   *
   * 有些守卫是**纵深防御**：它只在另一处已经出错时才会触发。
   * 例如"投影/计数一致性"后置断言 —— 投影本身正确时它永远不触发，
   * 因此单独去掉它，任何测试都不会变红。
   *
   * 那种情形下，"单独变异它并要求测试变红"是**不可能满足**的要求。
   * 诚实的做法是把它与它要兜住的缺陷**一起**施加：
   *
   * - 只施加投影缺陷（M7）⇒ 直接的内容断言变红（证明缺陷可见）；
   * - 投影缺陷 **+** 去掉断言（M8）⇒ 若断言是承重的，失败应当发生在
   *   **别处**（或多出一条"断言本该抛出"的证据）。
   *
   * 因此 M8 判据不同：它要求"**去掉断言后**，那条缺陷不再以
   * `投影与覆盖率统计不一致` 的形式被拦下" —— 也就是证明那条断言
   * 确实是唯一以该措辞拦截它的守卫。
   */
  companion?: { from: string; to: string; file?: string };
  /**
   * M8 式的判据：要求失败输出**不再**含 `negateReason`（默认 `expectReason`）。
   *
   * 与 `expectReason` 互斥：二选一。
   */
  negate?: { reason: RegExp };
}

const MUTATIONS: Mutation[] = [
  // ── 计划内容层（segmentation-plan.ts）──
  {
    id: "M1",
    guard: "源摘要陈旧守卫（计划必须绑定源快照）",
    file: "src/content/course-pipeline/segmentation-plan.ts",
    from: `  if (plan.binding.sourceDigest !== source.sourceDigest) {
    issues.push({
      code: "plan_binding_source_stale",`,
    to: `  if (false) {
    issues.push({
      code: "plan_binding_source_stale",`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "源摘要变化",
    expectReason: /plan_binding_source_stale|陈旧/,
  },
  {
    id: "M2",
    guard: "资产校验和守卫（计划必须绑定资产字节）",
    file: "src/content/course-pipeline/segmentation-plan.ts",
    from: `    if (asset.sha256 !== bound.sha256) {
      issues.push({
        code: "plan_binding_asset_stale",`,
    to: `    if (false) {
      issues.push({
        code: "plan_binding_asset_stale",`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "资产校验和变化",
    expectReason: /plan_binding_asset_stale|陈旧/,
  },
  {
    id: "M3",
    guard: "未指派内容守卫（人工分段绝不静默丢内容）",
    file: "src/content/course-pipeline/segmentation-plan.ts",
    from: `  if (unassigned.length > 0) {
    issues.push({
      code: "plan_unassigned_content",`,
    to: `  if (false) {
    issues.push({
      code: "plan_unassigned_content",`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "未指派内容",
    expectReason: /未指派|unassigned/,
  },
  {
    id: "M4",
    guard: "重叠守卫（**同一行只允许一个归属**，含同单元同通道）",
    file: "src/content/course-pipeline/segmentation-plan.ts",
    // 原实现：这一行已经被认领过就报重叠。改成恒真 ⇒ 永远"首次认领"，
    // 于是重叠（包括同单元同通道的精确重复）再也检测不到。
    from: `        const existing = claimByLine.get(key);
        if (existing === undefined) {`,
    to: `        const existing = claimByLine.get(key);
        if (true) {`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "精确重复",
    expectReason: /重叠|plan_range_overlap|失败关闭/,
  },
  {
    id: "M5",
    guard: "选择器越界守卫（行号必须落在该页可寻址范围内）",
    file: "src/content/course-pipeline/segmentation-plan.ts",
    from: `      if (lineEnd > lineCount) {`,
    to: `      if (false) {`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "行号越界",
    expectReason: /plan_range_line_out_of_bounds|越界/,
  },
  {
    id: "M6",
    guard: "V1 单资产契约（多资产计划必须显式拒绝）",
    file: "src/content/course-pipeline/segmentation-plan.ts",
    from: `  if (sortedReferenced.length > 1) {`,
    to: `  if (false) {`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "引用了**第二份资产**",
    expectReason: /plan_multi_asset_unsupported|单资产|多资产/,
  },
  {
    id: "M7",
    guard: "投影遍历**每一个**通道范围（绝不 find() 只取第一条）",
    file: "src/content/course-pipeline/plan-apply.ts",
    from: `  const referenceAssignments = unit.assignmentsByChannel.reference_translation;`,
    to: `  const referenceAssignments = unit.assignmentsByChannel.reference_translation.slice(0, 1);`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "每一个**范围都进入正文",
    expectReason: /投影与覆盖率统计不一致|参考译文/,
  },
  {
    id: "M8",
    guard: "投影/计数一致性守卫（覆盖率与投影不得脱钩）",
    file: "src/content/course-pipeline/plan-apply.ts",
    // 原实现：任何通道不符即返回说明。改成恒返回 null ⇒ 守卫失效。
    from: `  const diffs = channels.filter(([key]) => projected[key] !== counted[key]);
  if (diffs.length === 0) return null;`,
    to: `  const diffs = channels.filter(([key]) => projected[key] !== counted[key]);
  if (true) return null;`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "投影/计数一致性守卫**本身有效",
    expectReason: /参考译文|投影|不一致/,
  },

  // ── 身份与摘要（digests.ts / types.ts / review.ts）──
  {
    id: "M9",
    guard: "计划校验和参与候选身份（人的结构输入改变候选身份）",
    file: "src/content/course-pipeline/digests.ts",
    from: `    mode: modeEvidence === undefined ? null : segmentationModeDigest(modeEvidence),`,
    to: `    mode: null,`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "参与分段摘要",
    expectReason: /摘要|身份/,
  },
  {
    id: "M10",
    guard: "不可裁决性（未指派/绑定不符不得被复核裁决化解）",
    file: "src/content/course-pipeline/types.ts",
    from: `  "plan_unassigned_content",
  "plan_binding_mismatch",
] as const;`,
    to: `] as const;`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "不可被任何复核裁决化解",
    expectReason: /plan_unassigned_content|plan_binding_mismatch/,
  },
  {
    id: "M11",
    guard: "旧候选向后兼容（缺 modeEvidence 时如实降级为 automatic）",
    file: "src/content/course-pipeline/review.ts",
    from: `    metadata.segmentation.modeEvidence ?? automaticSegmentationEvidence(),`,
    to: `    metadata.segmentation.modeEvidence ?? undefined,`,
    testFile: "tests/course-segmentation-plan.test.ts",
    testName: "**旧候选**",
    expectReason: /旧候选|自相矛盾/,
  },

  // ── HTTP / 能力边界（segment-server.ts）──
  {
    id: "M12",
    guard: "未认证端点不下发私有正文与 token（F4 能力边界）",
    file: "src/content/course-pipeline/segment-server.ts",
    from: `  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, page());`,
    to: `  if (request.method === "GET" && url.pathname === "/") {
    sendHtml(response, page() + JSON.stringify({ token: session.token, assets: session.config.assets }));`,
    testFile: "tests/course-segment-tool.test.ts",
    testName: "未认证能力边界",
    expectReason: /未认证页面|不得包含|token/,
  },
  {
    id: "M13",
    guard: "私有引导端点必须校验 token（读也要能力）",
    file: "src/content/course-pipeline/segment-server.ts",
    from: `  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    if (!tokenMatches(session.token, headerToken(request))) {`,
    to: `  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    if (false) {`,
    testFile: "tests/course-segment-tool.test.ts",
    testName: "未认证 bootstrap 必须被拒绝",
    expectReason: /403|拒绝|expected/,
  },
  {
    id: "M14",
    guard: "只监听回环（绑到 0.0.0.0 必须被门禁抓住）",
    file: "src/content/course-pipeline/segment-server.ts",
    from: `    server.listen(options.port ?? 0, LOOPBACK_HOST, () => resolve());`,
    to: `    server.listen(options.port ?? 0, "0.0.0.0", () => resolve());`,
    testFile: "tests/course-segment-tool.test.ts",
    testName: "服务器只监听回环常量",
    expectReason: /0\.0\.0\.0|回环/,
  },
  {
    id: "M15",
    guard: "写操作必须校验 token（不得无鉴权写盘）",
    file: "src/content/course-pipeline/segment-server.ts",
    from: `    if (!tokenMatches(session.token, headerToken(request))) {
      // 写操作绝不接受查询串里的 token —— 那会被跨站请求带上
      sendJson(response, 403, { ok: false, error: "写操作需要正确的会话 token 请求头" });
      return;
    }`,
    to: `    if (false) {
      sendJson(response, 403, { ok: false, error: "写操作需要正确的会话 token 请求头" });
      return;
    }`,
    testFile: "tests/course-segment-tool.test.ts",
    testName: "写操作缺少 token",
    expectReason: /403|拒绝|expected/,
  },
  {
    id: "M16",
    guard: "服务端重建 binding（忽略浏览器送来的过期绑定）",
    file: "src/content/course-pipeline/segment-server.ts",
    from: `    binding: {
      courseId: input.courseId,
      sourceDigest: input.sourceDigest,`,
    to: `    binding: {
      courseId: input.courseId,
      sourceDigest: "0".repeat(64),`,
    testFile: "tests/course-segment-tool.test.ts",
    testName: "服务端**忽略**浏览器送来的 binding",
    expectReason: /sourceDigest|binding|expected/,
  },
  {
    id: "M17",
    guard: "客户端脚本可编译（F1 唯一转义边界）",
    file: "src/content/course-pipeline/segment-client-script.ts",
    // 客户端脚本源码里写的是两字符的 `\n` 转义；缺陷形态把它换成**真实换行**
    from: `      var warning = "还有 " + stats.unassigned.length + " 行没有处理。\\n" +`,
    to: `      var warning = "还有 " + stats.unassigned.length + " 行没有处理。\n" +`,
    testFile: "tests/course-segment-tool.test.ts",
    testName: "F1",
    expectReason: /SyntaxError|语法合法|编译/,
  },

  // ── CLI（course-extract.ts）──
  {
    id: "M18",
    guard: "显式 --plan 失败关闭（不得静默回退自动分段）",
    file: "scripts/course-extract.ts",
    from: `    if (!existsSync(planPath)) {
      failClosedPlan(
        "PLAN_NOT_FOUND",
        \`--plan 指定的计划文件不存在。\`,
      );
    }`,
    to: `    if (!existsSync(planPath)) {
      console.error("（变异：静默忽略不存在的显式计划）");
    }`,
    testFile: "tests/course-extract-plan-failclosed.test.ts",
    testName: "指向不存在的文件",
    expectReason: /PLAN_NOT_FOUND|非零退出|expected/,
  },

  // ── 客户端 Save 控件接线（Level-C 复评第二轮的唯一阻断项）──
  {
    id: "M19",
    guard: "引导成功后必须启用 Save（否则控件永远不可达）",
    file: "src/content/course-pipeline/segment-client-script.ts",
    /*
     * 缺陷形态：去掉成功回调里那一行启用 —— 这正是复评证明的缺陷。
     * 页面载入成功、可建单元、可指派，但 Save 永远停在初始禁用态。
     */
    from: `      document.getElementById("save").disabled = false;`,
    to: `      /* 变异：成功回调不再启用 Save */`,
    testFile: "tests/course-segment-page-execution.test.ts",
    testName: "引导成功后 Save 变为可用",
    expectReason: /Save 必须可用|expected false to be true|disabled/,
  },
];

/**
 * 把锚点文本规范化到目标文件的**实际行尾**。
 *
 * ── 为什么必须这样 ──
 *
 * 仓库 blob 是 LF，而本机 `core.autocrlf=true` 让**检出**成为 CRLF。
 * 变异脚本里的锚点是用 `\n` 写的多行字符串，直接 `String.replace`
 * 在 CRLF 文件上会命中 0 次 —— 脚本会报"无法施加"并跳过那条变异，
 * 于是变异测试**看起来跑了但其实什么都没验证**。
 *
 * 这与记录的架构门禁缺陷是**同一个根因**：
 * 行尾敏感的文本匹配在 Windows 检出上静默失效。
 */
function alignLineEndings(anchor: string, fileContent: string): string {
  const fileUsesCrlf = fileContent.includes("\r\n");
  return fileUsesCrlf ? anchor.replace(/\r?\n/g, "\r\n") : anchor.replace(/\r\n/g, "\n");
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

interface TestRun {
  passed: boolean;
  summary: string;
  output: string;
  /** 实际执行的用例数（从摘要行解析）。 */
  executed: number;
}

/**
 * 跑一组测试，返回是否通过 + 摘要 + 原始输出 + **实际执行的用例数**。
 *
 * 直接调 `node_modules/.bin/vitest`（不经 pnpm 外壳）：
 * 本机 `spawnSync(..., { shell: true })` 下 `pnpm.cmd` 的行为不稳定
 * （实测拿不到摘要且退出码不可靠）。直接调二进制也让"跑的是哪一份 vitest"
 * 明确可见，而不是经由一层包管理器的解析。
 *
 * ── 为什么必须回传 `executed` ──
 *
 * `vitest run -t <不存在的名字>` 会**退出 0**（"没有用例匹配"不是失败）。
 * 于是"变异后测试仍然全绿"这个判据会把**过滤器写错**误报成
 * "该守卫的测试是空的" —— 而反过来，一个只匹配到 0 个用例的变异
 * 更危险：它会让变异测试**看起来跑了但什么都没验证**。
 * 因此调用方必须核对 `executed > 0`。
 */
function runTests(file: string, name?: string): TestRun {
  const vitest = join(
    process.cwd(),
    "node_modules",
    ".bin",
    process.platform === "win32" ? "vitest.cmd" : "vitest",
  );
  /*
   * `name` 缺省时**不传** `-t`：传空串会让 vitest 按"名字含空串"过滤 ——
   * 实测那会把用例全筛掉（`no tests`），于是基准永远"不通过"。
   *
   * ── 为什么必须转义 ──
   *
   * vitest 的 `-t` 把过滤串当**正则**。本仓库的用例名里大量使用
   * `**强调**` 这类 Markdown 标记，而 `**` 是非法正则（`Nothing to repeat`）
   * —— 实测直接传会让 vitest 抛 `SyntaxError`，于是过滤器失效。
   * 这里把过滤串按**字面量**转义，调用方因此可以写任意用例名片段。
   */
  const args =
    name === undefined || name === ""
      ? ["run", file]
      : ["run", file, "-t", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")];
  const result = spawnSync(vitest, args, {
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.replace(/\u001b\[[0-9;]*m/g, "");
  /*
   * 解析"实际跑了多少条用例"。
   *
   * vitest 的摘要行有**多种形状**（实测都出现过）：
   *   `Tests  1 failed | 77 skipped (78)`
   *   `Tests  1 failed | 1 passed | 76 skipped (78)`
   *   `Tests  5 passed (5)`
   * 早期版本只匹配"failed | N passed"这一种，于是上面第一种形状被算成
   * **0 条**，进而把"过滤器有效"误判为"未匹配到用例"。
   * 现在把 failed 与 passed 各自抽出来相加，对形状不敏感。
   */
  const testsLine = output.split("\n").find((line) => /Tests\s+/.test(line)) ?? "";
  const failed = Number(/(\d+)\s+failed/.exec(testsLine)?.[1] ?? 0);
  const passedCount = Number(/(\d+)\s+passed/.exec(testsLine)?.[1] ?? 0);
  const executed = failed + passedCount;
  const summaryLines = output
    .split("\n")
    .filter((line) => /Tests\s+\d+|Test Files\s+\d+/.test(line))
    .map((line) => line.trim())
    .join(" | ");
  return {
    passed: result.status === 0,
    summary: summaryLines.trim() || `(退出码 ${result.status})`,
    output,
    executed,
  };
}

function main(): void {
  const root = process.cwd();

  console.log("人工分段计划 · 变异测试（证明守卫不是空断言）");
  console.log(
    `共 ${MUTATIONS.length} 个变异；每个都要求：锚点唯一命中 / 确实改字节 / 目标测试变红且原因对 / 恢复逐字节一致 / 恢复后全绿。\n`,
  );

  // ── 基准：未变异时相关测试必须全绿，否则"变异后变红"没有意义 ──
  console.log("基准（未变异）");
  const baselineFiles = [...new Set(MUTATIONS.map((mutation) => mutation.testFile))];
  let baselineGreen = true;
  for (const file of baselineFiles) {
    const run = runTests(file);
    console.log(`  ${run.passed ? "✓" : "✗"} ${file}  ${run.summary}`);
    if (!run.passed) baselineGreen = false;
  }
  if (!baselineGreen) {
    console.error("\n基准未通过 ⇒ 变异测试无意义。请先修好测试。");
    process.exitCode = 1;
    return;
  }

  let caught = 0;
  const problems: string[] = [];

  console.log("");
  for (const mutation of MUTATIONS) {
    const path = join(root, mutation.file);
    const original = readFileSync(path, "utf8");
    const originalHash = sha256(original);

    // ① 锚点必须**恰好**命中一次（0 次或多次都判失败，不跳过）
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
    // ② 变异必须**真的**改变字节
    if (mutated === original) {
      console.log(`  ✗ ${mutation.id} 变异未改变字节：${mutation.guard}`);
      problems.push(`${mutation.id}（空操作）`);
      continue;
    }

    let failure: string | null = null;
    try {
      writeFileSync(path, mutated, "utf8");

      // ③ 目标测试必须**真的跑了**、变红，且原因必须是那条守卫
      const result = runTests(mutation.testFile, mutation.testName);
      if (result.executed === 0) {
        /*
         * 过滤器没匹配到任何用例 ⇒ 这个变异**什么都没验证**。
         * 必须判失败：否则它会以"测试仍然全绿"的假象被误读成
         * "守卫的测试是空的"，而真实问题是脚本写错了名字。
         */
        failure = `-t "${mutation.testName}" 未匹配到任何用例（过滤器无效，变异未被验证）`;
      } else if (result.passed) {
        failure = `测试仍然全绿（跑了 ${result.executed} 条）⇒ 该守卫的测试是空的`;
      } else if (!mutation.expectReason.test(result.output)) {
        failure = `测试变红了，但失败原因与守卫无关（期望 ${mutation.expectReason}）`;
      } else {
        console.log(`  ✓ ${mutation.id} 被捕获：${mutation.guard}`);
        console.log(`      ${result.summary}`);
      }
    } finally {
      // ④ 无论成败都恢复，并**逐字节**核对
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
  let restoredAllGreen = true;
  for (const file of baselineFiles) {
    const run = runTests(file);
    console.log(`  ${run.passed ? "✓" : "✗"} ${file}  ${run.summary}`);
    if (!run.passed) restoredAllGreen = false;
  }

  console.log("");
  console.log(`结果：${caught} / ${MUTATIONS.length} 个变异被测试**正确**捕获。`);
  if (problems.length > 0) {
    console.log(`有问题：${problems.join("、")}`);
    process.exitCode = 1;
  }
  if (!restoredAllGreen) {
    console.log("**恢复后未全绿** —— 工作区可能残留变异，请检查。");
    process.exitCode = 1;
  }
}

main();
