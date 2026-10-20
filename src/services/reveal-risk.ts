import { createHash } from "node:crypto";
import type { Repositories } from "@/repositories/ports";
import { isPaperReservedForMock } from "@/domain/paper";
import { sanitizeDisplayText } from "@/lib/display-safety";
import { listRuntimeLinksForSegment } from "./course-link";
import { projectLinkedPapers, type LinkedPaperSummary } from "./course-link-projection";
import {
  createPackageIntegrityCache,
  readCoursePackageIntegrity,
  type PackageIntegrityCache,
} from "./course-packages";

/**
 * 揭示前的**风险描述符**（risk descriptor）—— 服务端重新评估的唯一入口。
 *
 * ── 这个模块存在的理由（P0-1）──
 *
 * UI 的确认面板**不是**安全边界。它证明"学习者在某个时刻看过一段警告"，
 * 但不证明那段警告描述的还是**当前**的风险。页面 GET 与揭示 POST 之间
 * 可能发生：
 *
 * - 有人**新核验**了一条指向这段材料的链接（此前没有警告，现在有）；
 * - 使用者 把目标真题**改成模考保留**（此前是训练池，现在是保留）；
 * - 链接**失效**（此前有警告，现在没有 —— 反过来也要重新确认）；
 * - 同一份卷子的**目标换了**（从"仔细阅读第 2 组"变成"第 3 组"）；
 * - 课程包**漂移**。
 *
 * ── 指纹证明的是"状态相等"，不是"人点过按钮" ──
 *
 * 这两件事必须分开：
 *
 * | 由谁保证 | 保证什么 |
 * | --- | --- |
 * | 指纹比对（本模块 + 服务层） | 学习者确认时的风险状态 == 当前风险状态 |
 * | 界面状态机（`reveal-button.tsx`） | 学习者**显式**点过「确认阅读」 |
 *
 * 因此指纹**不能**承担"用户确认过"这件事：一个自动重试的客户端可以
 * 回传一个正确的指纹而不经过任何人工确认。界面因此必须自己维护
 * "这一步是显式确认"，而服务端只负责"状态没变"。
 *
 * ── 指纹的完整性（Round 3 P3）──
 *
 * 指纹必须**确定性**地标识被确认的风险上下文。上一版漏了两类事实：
 *
 * 1. **`segmentId` 不在输入里** —— 同一课程里两段材料若链接集合为空，
 *    它们会算出**同一个**指纹。于是"在 A 段确认、在 B 段揭示"可以复用
 *    另一个的确认上下文。
 * 2. **目标的完整身份不全** —— 只带了 `targetScope`，没带
 *    `sectionId` / `groupId` / `questionId`。同一份卷子换一个大题或题组，
 *    指纹不变。
 *
 * 现在两者都进输入。这**不是**"更严格"的装饰：每一条都由
 * `tests/course-companion-reveal.test.ts` 的碰撞用例证明。
 *
 * 指纹**不含**：墙钟时间、随机值、正文字节、密钥、学习者身份
 * （风险是内容与策略的属性，不是某个人的属性）。
 */

/** 揭示前的风险描述符。 */
export interface RevealRiskDescriptor {
  /** 风险指纹（确定性摘要；UI 把它写进 DOM，POST 原样回传）。 */
  fingerprint: string;
  /**
   * 是否**存在**会影响"严格未见模考"的风险关联。
   *
   * `false` 只表示"没有已核验可用的链接指向真题" —— 它**不**表示
   * "这段材料对严格模考安全"（见文件头：未匹配 ≠ 无风险）。
   */
  risky: boolean;
  /**
   * 是否**必须**先确认。
   *
   * **恒为 `true`** —— 包括未匹配的情形。理由具体：如果只因"当前没查到
   * 链接"就免确认，那么"先渲染页面、随后有人新建链接"这条路径就会让
   * 学习者在**没有看过任何警告**的情况下消费保留材料
   * （因为 UI 从未显示过确认面板）。
   *
   * 保留这个字段（而不是直接删掉）是为了让**契约**明确：
   * 界面据它决定是否需要确认步骤，而不是自己看 `papers.length`。
   */
  requiresConfirmation: true;
  /** 风险不可求证时的可读原因；可求时为 null。 */
  unprovableReason: string | null;
  /**
   * 已核验可用的链接指向哪些真题 —— **展示就绪**的完整形状。
   *
   * 与页面渲染时用的是**同一个**投影（`projectLinkedPapers`），
   * 因此 409 响应可以直接渲染，不需要客户端猜任何缺失字段。
   */
  papers: LinkedPaperSummary[];
}

/**
 * 计算一段课程材料**当前**的揭示风险。
 *
 * 每次调用都重新读盘、重新查链接、重新查池归属 —— 刻意**不**缓存：
 * 缓存会让"页面 GET 之后风险变了"这件事在 POST 里看不见，而那正是
 * 本模块要抓住的竞态。
 */
export function computeRevealRisk(
  repos: Repositories,
  courseId: string,
  segmentId: string,
  cache: PackageIntegrityCache = createPackageIntegrityCache(),
): RevealRiskDescriptor {
  const record = repos.courses.getPackage(courseId);
  if (!record) {
    /*
     * 包不在索引里 ⇒ 不可求证。
     *
     * 注意这里**也**要把 courseId / segmentId 带进指纹：否则同一课程下
     * 不同段的"包不存在"会共享指纹。
     */
    return unprovable(courseId, segmentId, "这个课程包不在索引中。");
  }

  /*
   * 课程包漂移 ⇒ 风险不可求证。
   *
   * 这一条必须失败关闭：包被换掉之后，"这段材料对应哪道题"这件事本身
   * 已经不可证，因此既不能放行、也不能断言"没有风险"。
   */
  const integrity = readCoursePackageIntegrity(
    {
      id: record.id,
      packagePath: record.packagePath,
      manifestChecksum: record.manifestChecksum,
    },
    cache,
  );
  if (!integrity.ok) {
    /*
     * `integrity.reason` 可能来自低层 `catch`，而那些消息常带磁盘路径。
     * 这个字段**会出现在浏览器里**（409 响应与确认面板），因此在
     * 进入契约之前先消毒（P2-A）。
     *
     * 注意这里**仍然传** `record.manifestChecksum` 给指纹输入 ——
     * 消毒只影响给人看的字符串，不影响判定事实。
     */
    return unprovable(
      courseId,
      segmentId,
      sanitizeDisplayText(integrity.reason),
      record.manifestChecksum,
    );
  }
  if (!integrity.checksumMatches) {
    return unprovable(
      courseId,
      segmentId,
      "这个课程包已在盘上被改动但没有重新导入（内容与索引登记的不一致）。",
      record.manifestChecksum,
    );
  }

  /*
   * 只统计**已核验且当前可用**的 verified 链接。
   *
   * `listRuntimeLinksForSegment` 已经按语义目标去重、过滤
   * candidate/rejected/stale，因此这里拿到的就是"当前成立的对应关系"。
   * 未匹配 ⇒ 空数组，那是合法状态。
   */
  const links = listRuntimeLinksForSegment(repos, courseId, segmentId, cache);

  /*
   * ── 指纹输入（确定性、有序、完整）──
   *
   * 每一段都写清它是什么，用 `\u0000` 分隔字段、`\n` 分隔条目 ——
   * 两种分隔符都不会出现在任何 id / slug 里，因此不可能构造出两个
   * 不同的状态拼出同一个串。
   *
   * 链接按 `id` 排序（不是按查询返回顺序）：顺序本身不是风险，
   * 但"同一状态必须算出同一指纹"要求顺序确定。
   */
  const lines: string[] = [
    // ① 这段材料是谁（segmentId 必须进指纹 —— 见文件头 P3 第 1 条）。
    `course\u0000${courseId}`,
    `segment\u0000${segmentId}`,
    // ② 内容是哪一版（版本 + 校验和：漂移 ⇒ 不可求证）。
    `content-version\u0000${integrity.content.contentVersion}`,
    `content-checksum\u0000${integrity.actualChecksum}`,
  ];

  for (const link of links.slice().sort((a, b) => a.id.localeCompare(b.id))) {
    const paper = repos.papers.getPaper(link.paperId);
    /*
     * ③ 目标是谁 —— **完整**身份，不只是 scope。
     *
     * `sectionId` / `groupId` / `questionId` 都参与：同一份卷子从
     * "仔细阅读第 2 组"换成"第 3 组"是一项不同的风险事实
     * （学习者确认过的是前者的警告）。
     */
    lines.push(
      [
        `link\u0000${link.id}`,
        `paper\u0000${link.paperId}`,
        `paper-version\u0000${link.paperContentVersion}`,
        `link-course-version\u0000${link.courseContentVersion}`,
        `scope\u0000${link.targetScope}`,
        `section\u0000${link.sectionId}`,
        `group\u0000${link.groupId ?? ""}`,
        `question\u0000${link.questionId ?? ""}`,
        // ④ 影响警告措辞的当前策略状态。
        `reserved-for-mock\u0000${paper ? String(isPaperReservedForMock(paper)) : "unknown"}`,
      ].join("\u0001"),
    );
  }

  const fingerprint = createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");

  return {
    fingerprint,
    risky: links.length > 0,
    requiresConfirmation: true,
    unprovableReason: null,
    /*
     * 展示就绪的完整投影 —— 与页面渲染共用同一个实现。
     *
     * 这是 Round 3 P0 的直接修法：409 响应里必须是界面能直接渲染的形状，
     * 而不是"三个字段 + 客户端自己猜剩下四个"。
     */
    papers: projectLinkedPapers(repos, links),
  };
}

/**
 * 风险不可求证的描述符（失败关闭）。
 *
 * 指纹仍由**确定性输入**推导（课程 + 段 + 原因 + 索引登记的内容校验和），
 * 因此同一个"不可求证"状态在两次请求间保持一致 —— 学习者确认过的是
 * 同一个状态，而不是一个每次都变的靶子。
 *
 * 不带时间戳：它会让同一个状态每次都算出不同指纹。
 */
function unprovable(
  courseId: string,
  segmentId: string,
  reason: string,
  indexedChecksum?: string,
): RevealRiskDescriptor {
  const fingerprint = createHash("sha256")
    .update(
      [
        `course\u0000${courseId}`,
        `segment\u0000${segmentId}`,
        `unprovable\u0000${reason}`,
        `indexed-checksum\u0000${indexedChecksum ?? ""}`,
      ].join("\n"),
      "utf8",
    )
    .digest("hex");

  return {
    fingerprint,
    risky: true,
    requiresConfirmation: true,
    unprovableReason: reason,
    papers: [],
  };
}

/**
 * 比对"学习者确认过的指纹"与"当前指纹"。
 *
 * 用**定长**比较：避免因长度差异泄露信息（同 token 比较的纪律）。
 */
export function riskFingerprintMatches(expected: string, provided: unknown): boolean {
  if (typeof provided !== "string" || provided === "") return false;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a[index] ^ b[index];
  return diff === 0;
}

/** 拒绝原因的可读措辞（UI 据此提示"请重新确认"）。 */
export function explainRiskChange(): string {
  return (
    `这段材料的风险状态在页面打开之后发生了变化` +
    `（可能新建或失效了一条对应关系、目标真题的归属或具体目标被调整，或课程包被改动）。` +
    `为了不让你在不知情的情况下消耗保留材料，请查看更新后的风险说明并重新确认。`
  );
}

/** 供 UI 与测试使用：风险指纹的输入行（便于诊断"为什么指纹变了"）。 */
export function describeFingerprintInputs(
  repos: Repositories,
  courseId: string,
  segmentId: string,
  cache?: PackageIntegrityCache,
): string[] {
  const record = repos.courses.getPackage(courseId);
  if (!record) return [`course\u0000${courseId}`, `segment\u0000${segmentId}`, "package\u0000missing"];
  const links = listRuntimeLinksForSegment(repos, courseId, segmentId, cache);
  return [
    `course\u0000${courseId}`,
    `segment\u0000${segmentId}`,
    ...links.map((link) => `link\u0000${link.id}\u0000${link.sectionId}`),
  ];
}
