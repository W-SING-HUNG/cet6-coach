#!/usr/bin/env node
/**
 * Course Companion 揭示路径的**变异测试**。
 *
 * ── 它证明什么 ──
 *
 * "测试通过"本身不能证明守卫是真的。一条被写弱的断言、一个恒真的条件，
 * 都会让测试全绿而缺陷照样存在。因此这里**故意把守卫改回缺陷形态**，
 * 逐条证明对应的测试**确实会变红**，然后恢复。
 *
 * ── 每个变异必须证明五件事（沿用既有纪律）──
 *
 * 1. **锚点恰好命中一次** —— 否则脚本"报无法施加并跳过"会让变异测试
 *    **看起来跑了但其实什么都没验证**。0 次或多次一律判**失败**。
 * 2. **变异真的改变了字节** —— 否则那条"变异"是空操作。
 * 3. **目标测试确实变红**，且**失败原因**是那条守卫（不是别的偶然失败）。
 * 4. **恢复逐字节一致** —— 用 sha256 比对。
 * 5. **恢复后目标测试重新全绿**。
 *
 * ── 覆盖的守卫（与下方 `MUTATIONS` 数组**逐一对应**）──
 *
 * | 编号 | 守卫 | 对应缺陷 | 类别 |
 * | --- | --- | --- | --- |
 * | C1 | 揭示必须先落库再返回正文 | 先给正文后记账 ⇒ 可无痕阅读 | 顺序 |
 * | C2 | 揭示幂等（同版本同段只记一次） | 重复点击被记成多次曝光 | 结构 |
 * | C3 | 包漂移必须失败关闭 | 版本不变换包 ⇒ 下发未登记材料 | fail-open |
 * | C4 | 段不存在必须失败关闭 | 给不存在的段记账 | fail-open |
 * | C5 | 版本不匹配必须失败关闭 | 曝光指向另一版内容 | fail-open |
 * | C6 | 幂等命中不得跳过校验 | 已记录过 ⇒ 之后任意放行 | fail-open |
 * | C7 | `reveal_requested` 是潜在接触且参与判定 | 忽略它 ⇒ 卷子被误判 pristine（P0-5 + 回退约束） | 回退 |
 * | C8 | 伴随视图绝不下发正文 | 列表页顺带带回正文 | 隐私 |
 * | C9 | 揭示只读一次盘（P0-3） | 校验与下发之间换包 ⇒ 返回另一份正文 | 快照 |
 * | C10 | created 来自原子 INSERT（P1-2） | 先 SELECT 再插 ⇒ 并发下谎报创建 | 并发 |
 * | C11 | 揭示前重新评估风险（P0-1） | 只信 UI 确认 ⇒ 风险已变仍放行 | 回退 |
 * | C12 | 风险判定在写入之前（P0-1） | 先写曝光再判风险 ⇒ 被拒也留记录 | 顺序 |
 * | C13 | 客户端不得绕过确认提交（R3-P0） | 按链接数量决定直接 POST ⇒ 409 后绕过确认 | 客户端 |
 * | C14 | 客户端必须校验 409 形状（R3-P0） | 未校验断言 ⇒ 缺字段时静默降级成无风险 | 契约 |
 * | C15 | 服务端必须回完整风险条目（R3-P0） | 只回三字段 ⇒ 面板消失、警告无内容 | 契约 |
 *
 * 由 `tests/course-companion-reveal.test.ts` 的同源用例守护这张表与实际数组一致。
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
}

const MUTATIONS: Mutation[] = [
  // ── 顺序：先持久化，后下发 ──
  {
    id: "C1",
    guard: "揭示必须先落库、后返回正文（顺序不可交换）",
    file: "src/services/course-exposure.ts",
    /*
     * 缺陷形态：把写入曝光挪到返回正文之后。
     *
     * 它在功能测试里**看不出区别**（两条都成功），但它把"可无痕阅读"
     * 变成了可能：一旦读正文与写曝光之间发生任何失败，正文已经离开
     * 服务层而历史里没有记录。
     */
    from: `  const { event, created } = repos.courses.appendRevealExposureOnce({`,
    to: `  const snapshotForLater = readVerifiedSnapshot(
    repos,
    input.courseId,
    input.courseContentVersion,
    cache,
  );
  const segmentForLater = snapshotForLater.ok
    ? snapshotForLater.integrity.content.segments.find((item) => item.id === input.segmentId)
    : undefined;
  const { event, created } = snapshotForLater.ok && segmentForLater
    ? { event: { id: "fake", profileId: input.profileId, courseId: input.courseId, segmentId: input.segmentId, courseContentVersion: input.courseContentVersion, eventType: "reveal_requested" as const, occurredAt: input.occurredAt ?? "" }, created: true }
    : repos.courses.appendRevealExposureOnce({`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "揭示成功时先落库、后返回正文",
    expectReason: /曝光|reveal_requested|expected/,
  },

  // ── 幂等 ──
  {
    id: "C2",
    guard: "揭示幂等：同一内容版本上的重复揭示只留一条观测",
    file: "src/repositories/ports.ts",
    // 缺陷形态：身份里去掉内容版本 ⇒ 升版后的揭示被当成重复。
    from: `        input.profileId,
        input.courseId,
        String(input.courseContentVersion),
        input.segmentId,`,
    to: `        input.profileId,
        input.courseId,
        input.segmentId,`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "不同内容版本的揭示各自算一次",
    expectReason: /曝光|reveal_requested|expected/,
  },

  // ── fail-open 三兄弟 ──
  {
    id: "C3",
    guard: "包漂移必须失败关闭（manifest 校验和与索引不一致）",
    file: "src/services/course-exposure.ts",
    // 缺陷形态：把漂移判定改成恒假 —— 版本号不变而盘上内容被换掉时放行。
    /*
     * 锚点必须**唯一**且**紧跟**判定本身。
     *
     * `course-exposure.ts` 里有两处 `checksumMatches` 判定
     * （`recordCourseExposure` 与 `readVerifiedSnapshot`），
     * 只写 `if (!integrity.checksumMatches) {` 会命中两次 ⇒ 脚本报
     * "锚点无效"并跳过（实测踩到）。
     *
     * 而揭示路径的 `if` 与 `return` 之间还夹着一整段 P2-B 注释，
     * 因此把注释内容一起带进锚点 —— 它本身是揭示路径独有的。
     */
    from: `  if (!integrity.checksumMatches) {
    /*
     * ── 措辞纪律（P2-B）：不给学习者看校验和片段 ──`,
    to: `  if (false) {
    /*
     * ── 措辞纪律（P2-B）：不给学习者看校验和片段 ──`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "**manifest 漂移**",
    expectReason: /漂移|校验和|expected/,
  },
  {
    id: "C4",
    guard: "段不存在必须失败关闭（不得给不存在的段记账）",
    file: "src/services/course-exposure.ts",
    // 缺陷形态：跳过段存在性判定。
    from: `  const segment = integrity.content.segments.find((item) => item.id === input.segmentId);
  if (!segment) {
    return {
      ok: false,
      error:`,
    to: `  const segment =
    integrity.content.segments.find((item) => item.id === input.segmentId) ??
    integrity.content.segments[0];
  if (!segment) {
    return {
      ok: false,
      error:`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "段不存在 ⇒ 拒绝",
    expectReason: /不存在|expected/,
  },
  {
    id: "C5",
    guard: "内容版本不匹配必须失败关闭",
    file: "src/services/course-exposure.ts",
    // 缺陷形态：跳过版本比对 ⇒ 曝光可以指向另一版内容。
    from: `  if (record.contentVersion !== requestedContentVersion) {
    return {
      ok: false,
      error:`,
    to: `  if (false) {
    return {
      ok: false,
      error:`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "内容版本不匹配 ⇒ 拒绝",
    expectReason: /版本不匹配|expected/,
  },
  {
    id: "C6",
    guard: "幂等命中不得跳过包校验（已记录过不代表此刻可求证）",
    file: "src/services/course-exposure.ts",
    /*
     * 缺陷形态：一旦发现库里已有同身份记录，就直接返回成功、不再做任何校验。
     *
     * 这是一个具体的绕过路径：第一次揭示成功后包被换掉，
     * 第二次揭示会因为"已经记录过"而把未登记的材料发出来。
     */
    from: `  const snapshot = readVerifiedSnapshot(repos, input.courseId, input.courseContentVersion, cache);
  if (!snapshot.ok) {`,
    to: `  const alreadyThere = repos.courses
    .listExposureForSegment(input.profileId, input.courseId, input.segmentId)
    .some((event) => event.eventType === "reveal_requested");
  if (alreadyThere) {
    // 缺陷：命中既有记录后直接放行，**不比较 manifest 校验和**。
    // 于是包被换掉之后，第二次揭示仍会成功 —— 而它下发的可能是另一份材料。
    const blind = repos.courses.getPackage(input.courseId);
    if (blind) {
      return {
        ok: true,
        event: {
          id: "cached",
          profileId: input.profileId,
          courseId: input.courseId,
          segmentId: input.segmentId,
          courseContentVersion: input.courseContentVersion,
          eventType: "reveal_requested" as const,
          occurredAt: input.occurredAt ?? "",
        },
        recorded: false,
        content: {
          courseId: input.courseId,
          segmentId: input.segmentId,
          courseContentVersion: input.courseContentVersion,
          kind: "reading_passage",
          title: "漂移后的正文。",
          text: "漂移后的正文。",
          transcript: null,
          referenceTranslation: null,
          notes: null,
        },
        contentChecksum: blind.manifestChecksum,
        indexedContentVersion: blind.contentVersion,
      };
    }
  }
  const snapshot = readVerifiedSnapshot(repos, input.courseId, input.courseContentVersion, cache);
  if (!snapshot.ok) {`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "幂等命中仍重新校验内容完整性",
    expectReason: /漂移|校验和|expected/,
  },

  // ── P0-5：潜在接触语义 + 回退约束 ──
  {
    id: "C7",
    guard: "P0-5：reveal_requested 必须参与新鲜度判定，且只是**潜在接触**",
    file: "src/domain/paper-freshness.ts",
    /*
     * 缺陷形态：把揭示事件从"潜在接触"登记表里摘掉。
     *
     * 这正是任务书第 6 条（回退约束）与 P0-5 共同守护的那件事：
     * 摘掉它之后，一份被揭示过的卷子会重新变回"严格未见"（pristine）
     * —— 那正是本能力要消除的 fail-open。
     */
    from: `  reveal_requested: {
    establishesSeenContent: false,
    establishesPotentialContact: true,`,
    to: `  reveal_requested: {
    establishesSeenContent: false,
    establishesPotentialContact: false,`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "**只有** reveal_requested ⇒ uncertain",
    expectReason: /uncertain|potential_contact_only|expected/,
  },

  // ── 隐私：伴随视图不得下发正文 ──
  {
    id: "C8",
    guard: "伴随视图（列表页）绝不下发正文",
    file: "src/services/course-companion.ts",
    // 缺陷形态：把正文字段塞进列表投影 —— 页面加载就会带回私有正文。
    from: `    channels: channelsOf(segment),
    contactState,
    anchorLabel: describeAnchor(segment),`,
    to: `    channels: channelsOf(segment),
    text: segment.text,
    transcript: segment.transcript,
    referenceTranslation: segment.referenceTranslation,
    notes: segment.notes,
    contactState,
    anchorLabel: describeAnchor(segment),`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "列表视图不含任何正文通道内容",
    expectReason: /正文|Fixture|expected/,
  },

  // ── P0-3：一个已验证快照 ──
  {
    id: "C9",
    guard: "P0-3：揭示必须只用一次读取（不得在落库后再解析一次包）",
    file: "src/services/course-exposure.ts",
    /*
     * 缺陷形态：下发正文前再读一次盘。
     *
     * 它在功能测试里**看不出区别**（两次都读到同一份），但它让
     * "校验过的内容"与"下发的内容"之间出现竞态窗口 —— 盘上文件
     * 在那一刻被换掉，下发的就是另一份，而曝光声称它对应被校验的那一版。
     */
    from: `  return {
    ok: true,
    event,
    recorded: created,
    content: toSegmentContent(integrity.content, segment),`,
    to: `  const fresh = readCoursePackageIntegrity(
    { id: record.id, packagePath: record.packagePath, manifestChecksum: record.manifestChecksum },
    createPackageIntegrityCache(),
  );
  const freshSegment = fresh.ok
    ? fresh.content.segments.find((item) => item.id === input.segmentId)
    : undefined;
  return {
    ok: true,
    event,
    recorded: created,
    content: freshSegment
      ? toSegmentContent(fresh.content, freshSegment)
      : toSegmentContent(integrity.content, segment),`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "一个已验证快照（确定性）",
    expectReason: /被换上|Fixture course reading passage|expected/,
  },

  // ── P1-2：created 必须是原子 INSERT 的结果 ──
  {
    id: "C10",
    guard: "P1-2：`created` 来自原子 INSERT 的 `changes`，不是插入前的 SELECT",
    file: "src/repositories/sqlite/courses.ts",
    /*
     * 缺陷形态：回到"先 SELECT 推断 created"。
     *
     * 它在没有并发时**也能**给出正确答案，因此单独跑测试是绿的 ——
     * 真正的证明是这条竞争注入：另一个连接在 SELECT 之后、INSERT 之前
     * 提交同一身份的行，此时本次 INSERT 被跳过（`changes === 0`），
     * 而缺陷实现会报 `created: true`。
     */
    from: `    const written = this.db
      .prepare(
        \`INSERT INTO course_exposure_event
           (id, profile_id, course_id, segment_id, course_content_version, event_type, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING\`,
      )
      .run(
        id,
        input.profileId,
        input.courseId,
        input.segmentId,
        input.courseContentVersion,
        "reveal_requested",
        input.occurredAt,
      );
    const created = Number(written.changes) === 1;`,
    to: `    const preexisting = firstRow(this.db, "SELECT * FROM course_exposure_event WHERE id = ?", [id]);
    this.db
      .prepare(
        \`INSERT INTO course_exposure_event
           (id, profile_id, course_id, segment_id, course_content_version, event_type, occurred_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO NOTHING\`,
      )
      .run(
        id,
        input.profileId,
        input.courseId,
        input.segmentId,
        input.courseContentVersion,
        "reveal_requested",
        input.occurredAt,
      );
    const created = preexisting === null;`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "P1-2：`created` 来自**原子 INSERT 结果**",
    expectReason: /created=false|conflict|expected/,
  },

  // ── P0-1：风险重确认 ──
  {
    id: "C11",
    guard: "P0-1：揭示前必须在服务端重新评估风险并比对指纹",
    file: "src/services/course-exposure.ts",
    /*
     * 缺陷形态：整个风险重确认被跳过（等于回到"UI 确认即安全"）。
     *
     * 这正是 P0-1 指出的问题：UI 面板不是安全边界，页面 GET 与 POST
     * 之间风险可能已经变了。
     */
    from: `  const risk = computeRevealRisk(repos, input.courseId, input.segmentId, cache);
  if (!riskFingerprintMatches(risk.fingerprint, input.confirmedRiskFingerprint)) {
    return {
      ok: false,
      error: explainRiskChange(),
      code: "risk_changed",
      risk,
    };
  }`,
    to: `  const risk = computeRevealRisk(repos, input.courseId, input.segmentId, cache);
  if (false) {
    return {
      ok: false,
      error: explainRiskChange(),
      code: "risk_changed",
      risk,
    };
  }`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "**页面 GET 之后新建链接**",
    expectReason: /新建链接后必须拒绝|risk_changed|expected/,
  },
  {
    id: "C12",
    guard: "P0-1：风险判定必须在**写入曝光之前**（被拒的揭示不得留记录）",
    file: "src/services/course-exposure.ts",
    /*
     * 缺陷形态：把风险比对挪到落库**之后**。
     *
     * 它仍然会拒绝揭示，但那时曝光已经写下去了 —— 而那条记录会让
     * 对应真题失去严格未见资格，正是本设计要避免的事。
     */
    from: `  const risk = computeRevealRisk(repos, input.courseId, input.segmentId, cache);
  if (!riskFingerprintMatches(risk.fingerprint, input.confirmedRiskFingerprint)) {
    return {
      ok: false,
      error: explainRiskChange(),
      code: "risk_changed",
      risk,
    };
  }

  /*
   * ④ 原子幂等地落库。`,
    to: `  const risk = computeRevealRisk(repos, input.courseId, input.segmentId, cache);

  /*
   * ④ 原子幂等地落库。`,
    testFile: "tests/course-companion-reveal.test.ts",
    testName: "**页面 GET 之后新建链接**",
    expectReason: /新建链接后必须拒绝|expected/,
  },

  // ── Round 3 P0：409 复确认绕过 ──
  {
    id: "C13",
    guard: "R3-P0：客户端不得在点击时绕过确认直接提交",
    file: "src/app/practice/courses/[courseId]/reveal-button.tsx",
    /*
     * 缺陷形态：把审查复现的那条捷径放回去 ——
     * "没有可用链接就直接提交"。
     *
     * 它在 409 之后必然触发：服务端回传的风险视图若被当成不完整形状，
     * `riskContext.papers` 就没有 `runtimeUsable`，过滤后为空 ⇒
     * 点击直接 POST（带着已采纳的新指纹）⇒ 绕过确认。
     *
     * 这条变异由**真实浏览器 E2E** 守护
     * （`e2e/course-companion-round3.spec.ts` 的第 ④ 步：
     * "再次点「看这段」不经显式确认 ⇒ 仍然不揭示、零曝光"）。
     */
    from: `  function onOpenClick() {
    setError(null);
    setNetworkError(null);
    if (confirmedFingerprint !== null && confirmedFingerprint === riskContext.fingerprint) {
      void submitReveal(riskContext.fingerprint);
      return;
    }
    setStep("confirm");
  }`,
    to: `  function onOpenClick() {
    setError(null);
    setNetworkError(null);
    if (riskContext.papers.filter((paper) => paper.runtimeUsable).length === 0) {
      void submitReveal(riskContext.fingerprint);
      return;
    }
    if (confirmedFingerprint !== null && confirmedFingerprint === riskContext.fingerprint) {
      void submitReveal(riskContext.fingerprint);
      return;
    }
    setStep("confirm");
  }`,
    /*
     * 这条变异由**浏览器 E2E** 守护
     * （`e2e/course-companion-round3.spec.ts`），但守护它的**不是**第 ④ 步。
     *
     * ── 实测记录（重要的诚实边界）──
     *
     * 只施加这一条变异（服务端仍回完整形状）时，第 ④ 步**仍然通过** ——
     * 因为 `runtimeUsable` 是 `true`，过滤后不为空，捷径根本不会被触发。
     *
     * 真正抓住它的是这四条（它们里有"未匹配段"或"畸形响应"的情形）：
     *
     * | 用例 | 为什么能抓住 |
     * | --- | --- |
     * | ① 未匹配段：第一次点击要求确认 | 未匹配 ⇒ papers 为空 ⇒ 捷径直接 POST |
     * | 无链接分段：确认面板如实说明 | 同上 |
     * | 畸形 409 响应 ⇒ 界面失败关闭 | 响应被拒 ⇒ riskContext 仍是"未匹配" ⇒ 捷径触发 |
     * | 重复请求：同一次已确认风险可以再次读取 | 幂等路径被捷径提前拦走 |
     *
     * 第 ④ 步守的是**另一件事**：形状正常时，"再次点击"必须只打开面板。
     * 两者互补，缺一不可 —— 因此浏览器 E2E 与本节的门禁都要留。
     *
     * vitest 里跑不了浏览器 E2E，因此这里用**架构门禁**作为目标测试。
     *
     * Round 3 P2-C 之后那条门禁已从"数调用点数量"改成**行为导向**的判据：
     * 每一处 `submitReveal(` 都必须落在一个人工动作处理器里
     * （`onClick=` / `onConfirm=`），或者带确认指纹保护；
     * 并且不得出现"按链接数量决定是否提交"的分支。
     * 这样合法的重构不会误伤，而本变异仍会被抓住（已实测）。
     */
    testFile: "tests/architecture.test.ts",
    testName: "P0-R3：揭示控件不得有绕过确认的提交路径",
    expectReason: /不得按链接数量|既不在人工动作|绕过确认|expected/,
  },
  {
    id: "C14",
    guard: "R3-P0：客户端必须校验 409 响应形状（不得未校验断言）",
    file: "src/app/practice/courses/[courseId]/reveal-button.tsx",
    /*
     * 缺陷形态：把契约校验换成未校验的类型断言 ——
     * 那是绕过产生的另一半根因（服务端漏字段时界面静默降级成"无风险"）。
     */
    from: `      const parsed = parseRevealResponse(raw);

      if (parsed.kind === "invalid") {`,
    to: `      const forced = raw as { ok: true; recorded: boolean; content: RevealedContent; riskFingerprint: string };
      const parsed = { kind: "success" as const, payload: forced };
      void parseRevealResponse;
      void riskViewAllowsReveal;

      if (parsed.kind === "invalid") {`,
    testFile: "tests/architecture.test.ts",
    testName: "P0-R3：揭示控件不得有绕过确认的提交路径",
    expectReason: /不得把端点响应|未校验|expected/,
  },
  {
    id: "C15",
    guard: "R3-P0：服务端 409 必须回**展示就绪**的完整风险条目",
    file: "src/services/reveal-risk.ts",
    /*
     * 缺陷形态：把 `papers` 退回成只有三个字段的旧形状
     * （`paperId` / `reservedForMock` / `trainable`）。
     *
     * 这正是独立审查复现的绕过的一半：界面拿不到 `runtimeUsable` 与
     * `targetLabel`，于是确认面板消失、更新后的警告什么也没说。
     *
     * 另一半（客户端未校验地断言）由 C14 覆盖。两者**同时**存在时
     * 才构成完整绕过 —— 而本轮的修法让任意一半单独存在都会被挡住：
     *  · 只有服务端缺陷 ⇒ C15 让契约测试变红；
     *  · 只有客户端缺陷 ⇒ C14 让架构门禁变红。
     */
    from: `    papers: projectLinkedPapers(repos, links),`,
    to: `    papers: links.map((link) => {
      const src = repos.papers.getPaper(link.paperId);
      return {
        paperId: link.paperId,
        reservedForMock: src ? isPaperReservedForMock(src) : false,
        trainable: false,
      };
    }) as unknown as RevealRiskDescriptor["papers"],`,
    testFile: "tests/course-reveal-endpoint.test.ts",
    testName: "**新建链接**使风险变化",
    expectReason: /必须带|展示|expected/,
  },
];

/**
 * 把锚点文本规范化到目标文件的**实际行尾**。
 *
 * 仓库 blob 是 LF，而本机 `core.autocrlf=true` 让**检出**成为 CRLF。
 * 行尾敏感的锚点在 CRLF 上会静默命中 0 次 —— 脚本会报"无法施加"
 * 并跳过那条变异，于是变异测试**看起来跑了但什么都没验证**。
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
 * 必须回传 `executed`：`vitest run -t <不存在的名字>` 会**退出 0**。
 * 若只信退出码，一个写错的过滤器会被误报成"该守卫的测试是空的"。
 */
function runTests(file: string, name?: string): TestRun {
  const vitestEntry = join(process.cwd(), "node_modules", "vitest", "vitest.mjs");
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

  console.log("Course Companion 揭示路径 · 变异测试（证明守卫不是空断言）");
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

      // ③ 目标测试必须变红且原因正确
      const result = runTests(mutation.testFile, mutation.testName);
      if (result.executed === 0) {
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
