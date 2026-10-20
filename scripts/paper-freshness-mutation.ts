#!/usr/bin/env node
/**
 * 模考新鲜度（Course Exposure → Mock Freshness）的**变异测试**。
 *
 * ── 它证明什么 ──
 *
 * "测试通过"本身不能证明守卫是真的。一条被写弱的断言、一个恒真的条件，
 * 都会让测试全绿而缺陷照样存在。因此这里**故意把守卫改回缺陷形态**，
 * 逐条证明对应的测试**确实会变红**，然后恢复。
 *
 * ── 每个变异必须证明五件事（沿用 `course-segmentation-plan-mutation.ts` 的纪律）──
 *
 * 1. **锚点恰好命中一次** —— 否则脚本"报无法施加并跳过"，
 *    于是变异测试**看起来跑了但其实什么都没验证**。0 次或多次一律判**失败**。
 * 2. **变异真的改变了字节** —— 否则那条"变异"是空操作，测试当然是绿的。
 * 3. **目标测试确实变红**，且**失败原因**是那条守卫（不是别的偶然失败）。
 * 4. **恢复逐字节一致** —— 用 sha256 比对。
 * 5. **恢复后目标测试重新全绿**。
 *
 * ── 本模块特有的两类缺陷（这正是变异必须覆盖它们的理由）──
 *
 * **A 类：fail-open（把"不知道"变成"没见过"）。**
 *
 * 这是本能力最危险的失效形态，而且它**不会**被"正常路径"的测试发现：
 * 正常路径下本来就什么都读得到，因此那条 fail-open 分支永远不会被执行到。
 * 只有真的把包删掉、把链接改失效、把版本升上去，它才暴露 ——
 * 而那正是 M1 ~ M4 在做的事。
 *
 * **B 类：伪造精确性（把"不确定"说成"确定见过"）。**
 *
 * 跨版本套用曝光、忽略链接可用性直接采信 —— 两者都会让系统对一件
 * 它其实不知道的事给出肯定答案。M5、M6、M7 覆盖这一类。
 *
 * ── 覆盖的守卫（与下方 `MUTATIONS` 数组**逐一对应**）──
 *
 * 这张表必须与数组保持同步：它是本文件的"覆盖声明"，而变异测试的价值
 * 完全取决于"声称覆盖了什么"与"实际施加了什么"一致。表漂移会让人
 * 以为某条守卫被覆盖了而实际上没有。由 `tests/paper-freshness.test.ts`
 * 的变异表一致性用例守护（比对 id 与 guard 文本）。
 *
 * | 编号 | 守卫 | 对应缺陷 | 类别 |
 * | --- | --- | --- | --- |
 * | M1 | 资格判据只有 pristine 通过 | 把 uncertain 当成合格模考 | A |
 * | M2 | 包/链接不可求证 ⇒ uncertain | 读不到就当成"没见过"（fail-open） | A |
 * | M3 | 已失效的 verified 链接必须登记 | 静默丢弃历史链接（fail-open） | A |
 * | M4 | 课程包漂移必须失败关闭 | 盘上改包但不重新导入（fail-open） | A |
 * | M5 | 曝光内容版本必须与被核验版本**精确相等** | 忽略版本，任何曝光都算数 | B |
 * | M6 | 曝光版本对不上时必须失败关闭 | 把"看过的是另一版"当成正面证据 | B |
 * | M7 | 候选 / 否决**从不**建立真题身份 | 机器候选变成运行时真相 | B |
 * | M8 | 证据必须按语义目标去重 | 一次复核被算成两个目标 | 结构 |
 * | M9 | 曝光计数**不得**因复核次数膨胀（取 max） | 复核次数伪装成观看次数 | 结构 |
 * | M10 | 事件种类登记表必须参与判定 | 新事件被静默忽略 | 结构 |
 * | M11 | 从未曝光过的段不进入考察 | 无关陈旧链接让整库变 uncertain | 范围 |
 * | M12 | 新鲜度必须按 **profile** 隔离 | 别人的曝光影响我的结论 | 范围 |
 * | M13 | 文案不得含 Markdown 标记 | `**强调**` 被渲染成字面星号（B1） | C |
 * | M14 | 标点必须经 joinClauses | 拼装产出 `。。` / `。；`（B1） | C |
 * | M15 | pristine 必须限定证据范围 | 文案读成系统无权作出的断言（B1） | C |
 * | M16 | 服务层必须委托资格谓词 | 与 domain 重复同一决定（N2） | C |
 * | M17 | 池归属必须经权威谓词 | 裸比较 ⇒ 多一处漂移点（N3） | C |
 * | M18 | 详情页必须渲染权威措辞 | 页面平行维护 pristine 文案 ⇒ 限定丢失（A） | A |
 *
 * 由 `tests/freshness-wording.test.ts` 的同源用例守护这张表与实际数组一致。
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
  testFile: string;
  testName: string;
  expectReason: RegExp;
  /**
   * 需要**同时施加**的伴随变异（同一次写入前先施加、恢复时一并回滚）。
   *
   * ── 为什么需要它 ──
   *
   * M11 守的是"若某个段一条「足以断言见过」的曝光都没有，它就不进入考察"。
   * 而在 V1 里，登记表把**四种事件全部**登记为足以断言见过 ——
   * 于是 `seenEvents.length === 0` 在当前登记表下**永远不成立**，
   * 单独去掉那条守卫，任何测试都不会变红。
   *
   * 那种情形下"单独变异它并要求测试变红"是**不可能满足**的要求，
   * 而硬凑一个恒真断言来"捕获"它只会得到一条空测试。
   * 诚实的做法是把它与让守卫**变得可达**的那处改动一起施加：
   * 先让登记表把某一种事件判为不足，再去掉守卫 —— 此时缺陷才是真的。
   *
   * 该字段同时改变了判据的方向：测试必须在"只有伴随变异"时**通过**
   * （登记表说了它不算，就不能算），在"伴随变异 + 去掉守卫"时**失败**。
   * 因此这里的 `expectReason` 检查的是去掉守卫之后的失败。
   */
  companion?: { from: string; to: string; file?: string };
}

const MUTATIONS: Mutation[] = [
  // ── A 类：fail-open（把"不知道"变成"没见过"）──
  {
    id: "M1",
    guard: "严格模考资格：只有 pristine 通过（uncertain 也必须不合格）",
    file: "src/domain/paper-freshness.ts",
    from: `export function isPaperEligibleForStrictMock(freshness: { state: PaperFreshnessState }): boolean {
  return freshness.state === "pristine";
}`,
    to: `export function isPaperEligibleForStrictMock(freshness: { state: PaperFreshnessState }): boolean {
  return freshness.state !== "exposed";
}`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "资格判据只有 pristine 通过",
    expectReason: /expected true to be false|uncertain/,
  },
  {
    id: "M2",
    guard: "包/链接不可求证必须失败关闭（不得回退成 pristine）",
    file: "src/domain/paper-freshness.ts",
    // 缺陷形态：把"无法证明"折叠进 pristine —— 也就是任务书禁止的那件事。
    from: `  const state: PaperFreshnessState =
    matches.length > 0 ? "exposed" : unresolved.length > 0 ? "uncertain" : "pristine";`,
    to: `  const state: PaperFreshnessState = matches.length > 0 ? "exposed" : "pristine";`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "只有未解决条件、没有证据",
    expectReason: /不知道 ≠ 没见过|uncertain|expected/,
  },
  {
    id: "M3",
    guard: "已失效的 verified 链接必须登记为未解决（不得静默丢弃）",
    file: "src/services/paper-freshness.ts",
    from: `      // verified 但当前**不成立**。失败关闭：登记为未解决，绝不当成 pristine。
      pushUnresolved(link.paperId, classifyUnusable(repos, link, cache));`,
    to: `      // 变异：静默丢弃已失效的链接（fail-open）。`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "课程升版 ⇒ 旧曝光",
    expectReason: /uncertain|expected/,
  },
  {
    id: "M4",
    guard: "包漂移必须失败关闭（课程包被改动未重新导入）",
    file: "src/services/paper-freshness.ts",
    from: `  if (!courseIntegrity.checksumMatches) {
    return {
      ...base,
      code: "course_package_drifted",`,
    to: `  if (false) {
    return {
      ...base,
      code: "course_package_drifted",`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "课程包在盘上被改动",
    expectReason: /course_package_drifted|uncertain|expected/,
  },

  // ── B 类：伪造精确性 ──
  {
    id: "M5",
    guard: "曝光的内容版本必须与被核验版本**精确相等**",
    file: "src/services/paper-freshness.ts",
    // 缺陷形态：只要该段有曝光就算数，忽略版本 —— v1 的曝光被套到 v2 的链接上。
    from: `        if (seenVersions.has(link.courseContentVersion)) {`,
    to: `        if (seenVersions.size > 0) {`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "链接成立但曝光只落在",
    expectReason: /exposure_version_mismatch|uncertain|expected/,
  },
  {
    id: "M6",
    guard: "曝光版本对不上时必须**失败关闭**（不得当成正面证据）",
    file: "src/services/paper-freshness.ts",
    // 缺陷形态：把"看过的是另一版"直接当成正面证据 —— 伪造精确性。
    from: `          const anyVersions = new Set(
            [...seenVersions, ...potentialVersions].filter((version) => Number.isFinite(version)),
          );
          pushUnresolved(link.paperId, {
            code: "exposure_version_mismatch",`,
    to: `          const anyVersions = new Set(
            [...seenVersions, ...potentialVersions].filter((version) => Number.isFinite(version)),
          );
          pushMatch(buildMatch(link, seenEvents));
          if (false) pushUnresolved(link.paperId, {
            code: "exposure_version_mismatch",`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "链接成立但曝光只落在",
    expectReason: /exposure_version_mismatch|uncertain|expected/,
  },
  {
    id: "M7",
    guard: "候选 / 否决**从不**建立真题身份",
    file: "src/services/paper-freshness.ts",
    from: `      if (link.verificationStatus !== "verified") continue;`,
    to: `      if (false) continue;`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "candidate 链接",
    expectReason: /pristine|expected/,
  },
  {
    id: "M8",
    guard: "证据必须按语义目标**去重**",
    file: "src/domain/paper-freshness.ts",
    from: `  const matches = dedupeMatches(input.matches).sort(compareMatches);`,
    to: `  const matches = [...input.matches].sort(compareMatches);`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "同一目标被多次曝光 / 多次复核",
    expectReason: /toHaveLength|expected/,
  },
  {
    id: "M9",
    guard: "曝光计数**不得**因复核次数而膨胀（取 max，不是求和）",
    file: "src/domain/paper-freshness.ts",
    from: `    current.exposureCount = Math.max(current.exposureCount, match.exposureCount);`,
    to: `    current.exposureCount += match.exposureCount;`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "同一目标被多次曝光 / 多次复核",
    expectReason: /exposureCount|expected/,
  },

  // ── 登记表与范围收口 ──
  {
    id: "M10",
    guard: "曝光事件种类登记表必须参与判定（新事件不得被静默忽略）",
    file: "src/domain/paper-freshness.ts",
    /*
     * 缺陷形态：只认一种硬编码事件，其余全部判为"不算见过"。
     *
     * 判据落在**登记表取值**上（`solution_rendered` 等被摘掉），
     * 因为"参与判定"这件事的产品权威就在登记表里。函数层的
     * `establishesSeenContent` 只是它的转发。
     */
    from: `  solution_rendered: {
    establishesSeenContent: true,
    establishesPotentialContact: true,`,
    to: `  solution_rendered: {
    establishesSeenContent: false,
    establishesPotentialContact: true,`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "`reveal_requested` 是潜在接触，其余四种是已确认接触",
    expectReason: /已确认接触|应算作|expected/,
  },
  {
    id: "M11",
    guard: "**从未接触过**的段不进入考察（无关的陈旧链接不得制造不确定性）",
    file: "src/services/paper-freshness.ts",
    /*
     * 缺陷形态：把"过滤出足以断言接触的事件"退化成"全部事件"。
     *
     * 这条守卫需要伴随变异才可达：把 `declared_seen` 的两个判定都判为
     * false，于是"只靠 declared_seen 的段"就成为那个可达的边界 ——
     * 正确的实现会把它排除在考察之外（pristine），而缺陷实现会因为它
     * 链接失效而变成 uncertain。
     */
    from: `    const seenEvents = group.events.filter((event) => establishesSeenContent(event.eventType));
    const potentialOnlyEvents = group.events.filter(
      (event) =>
        !establishesSeenContent(event.eventType) &&
        establishesPotentialContact(event.eventType),
    );

    // 两类都没有 ⇒ 这段与"见过"无关，不进考察。
    if (seenEvents.length === 0 && potentialOnlyEvents.length === 0) continue;`,
    to: `    const seenEvents = group.events.filter(() => true);
    const potentialOnlyEvents = group.events.filter(
      (event) =>
        !establishesSeenContent(event.eventType) &&
        establishesPotentialContact(event.eventType),
    );

    // 两类都没有 ⇒ 这段与"见过"无关，不进考察。
    if (seenEvents.length === 0 && potentialOnlyEvents.length === 0) continue;`,
    companion: {
      file: "src/domain/paper-freshness.ts",
      from: `  declared_seen: {
    establishesSeenContent: true,
    establishesPotentialContact: true,`,
      to: `  declared_seen: {
    establishesSeenContent: false,
    establishesPotentialContact: false,`,
    },
    testFile: "tests/paper-freshness.test.ts",
    testName: "18d · 段上只有**登记表判定为不足**的事件",
    expectReason: /unresolved|不计入时|expected/,
  },
  {
    id: "M12",
    guard: "新鲜度必须按 **profile** 隔离",
    file: "src/repositories/sqlite/courses.ts",
    // 缺陷形态：忽略 profile 过滤 —— 别人的曝光会影响我的结论。
    from: `      \`SELECT * FROM course_exposure_event WHERE profile_id = ?
       ORDER BY course_id ASC, segment_id ASC, occurred_at ASC, id ASC\`,
      [profileId],`,
    to: `      \`SELECT * FROM course_exposure_event WHERE ? IS NOT NULL
       ORDER BY course_id ASC, segment_id ASC, occurred_at ASC, id ASC\`,
      [profileId],`,
    testFile: "tests/paper-freshness.test.ts",
    testName: "曝光属于 profile A",
    expectReason: /pristine|expected/,
  },

  // ── C 类：措辞与单一事实来源（Review Fix B1 / N2 / N3）──
  {
    id: "M13",
    guard: "面向学习者的文案不得含 Markdown 标记（B1）",
    file: "src/domain/paper-freshness.ts",
    /*
     * 缺陷形态：把强调标记写回文案 —— 这正是实测缺陷本身。
     * React 把字符串当纯文本渲染，因此用户会看到字面星号。
     */
    from: `        "这不代表你会做或不会做这道题 —— 它只说明刺激材料已经不再是新的，" +`,
    to: `        "这不代表你会做或不会做这道题 —— 它只说明**刺激材料已经不再是新的**，" +`,
    testFile: "tests/freshness-wording.test.ts",
    testName: "所有解释文案都不含",
    expectReason: /泄漏了 Markdown 标记/,
  },
  {
    id: "M14",
    guard: "标点必须由 joinClauses 统一拼装（不得产出 。。 / 。；）（B1）",
    file: "src/domain/paper-freshness.ts",
    // 缺陷形态：退回朴素的 join + 句号 —— 子句自带句号时会产出 。； 与 。。。
    from: `        \`已知的具体情况：\${joinClauses(freshness.unresolved.map((item) => item.message))}\` +`,
    to: `        \`已知的具体情况：\${freshness.unresolved.map((item) => item.message).join("；")}。\` +`,
    testFile: "tests/freshness-wording.test.ts",
    testName: "解释文案里不出现",
    expectReason: /重复标点|。。|。；/,
  },
  {
    id: "M15",
    guard: "pristine 文案必须限定证据范围（不得作绝对断言）（B1）",
    file: "src/domain/paper-freshness.ts",
    /*
     * 缺陷形态：把"依据只来自本应用、不代表别处"这层限定整段去掉，
     * 让文案读成系统无权作出的绝对断言（"你从未见过"）。
     */
    from: `        "这个判断只依据本应用内保存的课程记录与人工核验结果，" +
        "它不代表你在别的地方从未见过这份材料。"`,
    to: `        "你从未见过这份材料。"`,
    testFile: "tests/freshness-wording.test.ts",
    testName: "pristine 文案必须限定证据范围",
    expectReason: /必须说明依据只来自本应用|绝对断言|不代表/,
  },
  {
    id: "M18",
    guard: "详情页不得自带 pristine 文案（必须渲染 domain 权威措辞）（A）",
    file: "src/app/practice/papers/[paperId]/page.tsx",
    /*
     * 缺陷形态：把页面自带的硬编码 pristine 文案写回去。
     *
     * 这正是评审 A 项的结构性缺陷：页面平行维护一份文案，
     * 而 domain 的证据范围限定永远不会被渲染。
     * 这里插在权威组件之前，因此**渲染顺序上会先出现硬编码文案** ——
     * 浏览器级断言（"不得残留旧文案"）会变红。
     */
    from: `          {freshness ? (
            <div className="mt-3 border-t border-edge pt-3">
              <StrictMockEligibility freshness={freshness} />
            </div>
          ) : null}`,
    to: `          {freshness ? (
            <div className="mt-3 border-t border-edge pt-3">
              {strictMockEligible ? (
                <p>尚未接触。系统没有发现任何已核验的既往接触记录，且内容包与核验链接当前都成立。</p>
              ) : null}
              <StrictMockEligibility freshness={freshness} />
            </div>
          ) : null}`,
    testFile: "tests/freshness-wording.test.ts",
    testName: "详情页不得自带 pristine 解释文案",
    expectReason: /又自带了一段 pristine 解释|系统没有发现任何已核验的既往接触记录/,
  },
  {
    id: "M16",
    guard: "服务层必须委托 domain 的资格谓词（不得自己比较状态）（N2）",
    file: "src/services/paper-freshness.ts",
    // 缺陷形态：退回自己比较状态字符串 —— 与 domain 重复同一个决定。
    from: `  return domainIsPaperEligibleForStrictMock(getPaperFreshness(repos, profileId, paperId));`,
    to: `  return getPaperFreshness(repos, profileId, paperId).state === "pristine";`,
    testFile: "tests/freshness-wording.test.ts",
    testName: "服务层不得自己比较状态字符串",
    expectReason: /不得自己比较|domainIsPaperEligibleForStrictMock/,
  },
  {
    id: "M17",
    guard: "池归属必须经权威谓词（不得裸比较）（N3）",
    file: "src/services/paper-freshness.ts",
    // 缺陷形态：退回裸的池比较 —— 多一处漂移点。
    from: `    if (!isPaperReservedForMock(paper)) continue;`,
    to: `    if (paper.pool !== "mock_reserve") continue;`,
    /*
     * 这条守卫在 **architecture.test.ts**（源码级"服务层不得自带池比较"），
     * 不在 wording 文件里 —— 措辞文件测的是文案，不是这次比较。
     * 早先指向错误的文件会让它报"门禁仍然全绿"，那是**文件名写错**，
     * 而不是守卫失效。
     */
    testFile: "tests/architecture.test.ts",
    testName: "池归属判定必须经权威谓词",
    expectReason: /不得自带池比较|isPaperReservedForMock/,
  },
];

/**
 * 把锚点文本规范化到目标文件的**实际行尾**。
 *
 * 仓库 blob 是 LF，而本机 `core.autocrlf=true` 让**检出**成为 CRLF。
 * 变异脚本里的锚点用 `\n` 写，直接替换在 CRLF 文件上会命中 0 次 ——
 * 脚本会报"无法施加"并跳过那条变异，于是变异测试**看起来跑了但什么都没验证**。
 * 这与记录的架构门禁缺陷是同一个根因。
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
  executed: number;
}

/**
 * 跑一组测试，返回是否通过 + 摘要 + 原始输出 + **实际执行的用例数**。
 *
 * 必须回传 `executed`：`vitest run -t <不存在的名字>` 会**退出 0**
 * （"没有用例匹配"不是失败）。若只信退出码，一个写错的过滤器会被误报成
 * "该守卫的测试是空的" —— 而真实问题是脚本写错了名字。
 */
function runTests(file: string, name?: string): TestRun {
  /*
   * 直接执行 vitest 的**入口模块**（`node <vitest.mjs> ...`），而不是
   * 经由 `node_modules/.bin/vitest.cmd` + `shell: true`。
   *
   * ── 为什么必须换掉 shell 形态 ──
   *
   * 本仓库的用例名里大量使用 `**强调**` 与中文标点。经 shell 传参时：
   *
   * 1. 字符串要跨 **两层**解析（Node → cmd.exe → vitest），任何一层对
   *    引号/反斜杠的处理差异都会改变最终到达 vitest 的参数；
   * 2. `**` 在部分 shell 里会被展开（glob），于是过滤器可能匹配到别的名字；
   * 3. Windows 的 `shell: true` 与 Node 官方文档警告的行为（DEP0190）
   *    正是"参数被拼接而不是转义"。
   *
   * 改为直接 `spawnSync(process.execPath, [vitestEntry, ...args])` 后，
   * 参数**不再经过任何 shell**，因此过滤器是逐字传递的。
   * vitest 的 `-t` 仍按正则解释，所以转义保留（见下）。
   */
  const vitestEntry = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
  // vitest 的 -t 是**正则**：用例名里的 `**` 是非法正则，必须按字面量转义。
  const args =
    name === undefined || name === ""
      ? ["run", file]
      : ["run", file, "-t", name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")];
  const result = spawnSync(process.execPath, [vitestEntry, ...args], {
    encoding: "utf8",
    // 不经过 shell：参数逐字传递，不存在 glob 展开或二次解析。
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
  const root = process.cwd();

  console.log("模考新鲜度 · 变异测试（证明守卫不是空断言）");
  console.log(
    `共 ${MUTATIONS.length} 个变异；每个都要求：锚点唯一命中 / 确实改字节 / 目标测试变红且原因对 / 恢复逐字节一致 / 恢复后全绿。\n`,
  );

  // ── 基准：未变异时目标测试必须全绿 ──
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

    /*
     * 伴随变异的目标文件（可能是另一个文件）。它的原文与哈希也要留着，
     * 因为恢复必须把**两个**文件都逐字节还原。
     */
    const companionPath = mutation.companion
      ? join(root, mutation.companion.file ?? mutation.file)
      : null;
    const companionOriginal = companionPath ? readFileSync(companionPath, "utf8") : null;
    const companionHash = companionOriginal === null ? null : sha256(companionOriginal);

    /** 把两个文件都恢复到原始状态，并逐字节核对。 */
    const restore = (): void => {
      writeFileSync(path, original, "utf8");
      if (companionPath !== null && companionOriginal !== null) {
        writeFileSync(companionPath, companionOriginal, "utf8");
      }
    };
    /** 恢复后的一致性核对。返回不一致的文件名（空数组表示一致）。 */
    const verifyRestored = (): string[] => {
      const bad: string[] = [];
      if (sha256(readFileSync(path, "utf8")) !== originalHash) bad.push(mutation.file);
      if (companionPath !== null && companionHash !== null) {
        if (sha256(readFileSync(companionPath, "utf8")) !== companionHash) {
          bad.push(mutation.companion?.file ?? mutation.file);
        }
      }
      return bad;
    };

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

    // 伴随变异的锚点同样必须唯一命中。
    let companionFrom = "";
    let companionTo = "";
    if (mutation.companion && companionOriginal !== null) {
      companionFrom = alignLineEndings(mutation.companion.from, companionOriginal);
      companionTo = alignLineEndings(mutation.companion.to, companionOriginal);
      const companionOccurrences = companionOriginal.split(companionFrom).length - 1;
      if (companionOccurrences !== 1) {
        console.log(
          `  ✗ ${mutation.id} 伴随变异锚点无效（命中 ${companionOccurrences} 次，需恰好 1 次）：${mutation.guard}`,
        );
        problems.push(`${mutation.id}（伴随锚点命中 ${companionOccurrences} 次）`);
        continue;
      }
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
      /*
       * 先单独施加伴随变异并跑一次：那条"边界"必须在**正确实现**下
       * 表现得与预期一致（即测试仍然全绿）—— 否则说明伴随变异本身
       * 已经破坏了别的语义，这个变异就证明不了任何事。
       */
      if (mutation.companion && companionPath !== null && companionOriginal !== null) {
        writeFileSync(companionPath, companionOriginal.replace(companionFrom, companionTo), "utf8");
        const companionOnly = runTests(mutation.testFile, mutation.testName);
        if (companionOnly.executed === 0) {
          failure = `-t "${mutation.testName}" 未匹配到任何用例（过滤器无效）`;
        } else if (!companionOnly.passed) {
          /*
           * 只施加伴随变异就让测试变红 ⇒ 那条测试测的不是本守卫，
           * 而是伴随变异改动的另一件事。这会让"捕获"变成假象。
           */
          failure = `只施加伴随变异（登记表判为不足）时测试就变红了 ⇒ 该测试测的不是本守卫`;
        }
      }

      if (failure === null) {
        // ③ 施加缺陷变异（伴随变异已在位），目标测试必须变红且原因正确
        writeFileSync(path, mutated, "utf8");
        const result = runTests(mutation.testFile, mutation.testName);
        if (result.executed === 0) {
          failure = `-t "${mutation.testName}" 未匹配到任何用例（过滤器无效，变异未被验证）`;
        } else if (result.passed) {
          failure = `测试仍然全绿（跑了 ${result.executed} 条）⇒ 该守卫的测试是空的`;
        } else if (!mutation.expectReason.test(result.output)) {
          failure = `测试变红了，但失败原因与守卫无关（期望 ${mutation.expectReason}）`;
        } else {
          console.log(`  ✓ ${mutation.id} 被捕获：${mutation.guard}`);
          if (mutation.companion) {
            console.log(`      （含伴随变异：让该守卫在 V1 默认登记表下变得可达）`);
          }
          console.log(`      ${result.summary}`);
        }
      }
    } finally {
      // ④ 无论成败都恢复**两个**文件，并逐字节核对
      restore();
      const bad = verifyRestored();
      if (bad.length > 0) {
        console.error(`  !! ${mutation.id} 恢复后字节能不一致（${bad.join("、")}）—— 工作区可能残留变异`);
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
