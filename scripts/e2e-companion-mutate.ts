#!/usr/bin/env node
/**
 * 合成伴随实例的**状态变更工具**（仅用于 E2E 回归）。
 *
 * ── 它为什么存在 ──
 *
 * Round 3 的独立审查复现了一个真实绕过：页面 GET 与揭示 POST 之间
 * **风险状态变了**（新建了一条指向模考保留卷的链接），而界面因为
 * 把 409 响应当成完整形状而丢掉了确认面板，于是再点一次就绕过了确认。
 *
 * 复现那个场景需要一个能力：**在页面已经渲染之后**改变链接状态。
 * 浏览器做不到（它没有写库权限），因此由这个脚本承担 ——
 * 它直接操作**合成库**，与真实内容毫无关系。
 *
 * ── 边界（硬约束）──
 *
 * - 只打开 `E2E_COMPANION_DB_PATH` 与 `E2E_COMPANION_CONTENT_ROOT`，
 *   两者都在 `.e2e/` 下；脚本**拒绝**在其它路径上工作。
 * - 不碰 `private-content/`、不碰 `data/cet6.db`、不运行 `e2e:real`。
 * - 每个动作只做一件事，失败即非零退出 —— 不做"尽力而为"的静默降级。
 *
 * 用法：
 *   node ... scripts/e2e-companion-mutate.ts <action> [args...]
 *
 * 动作：
 *   link <segmentId> <paperId> <sectionId>   新建一条 verified 链接
 *   unlink <segmentId>                        移除该段全部链接
 *   pool <paperId> <pool>                     设置卷子的池归属
 *   state <segmentId>                         打印该段的风险状态（JSON）
 *   exposures                                 打印曝光行数（JSON）
 *   uncertain <paperId>                       打印该卷的新鲜度状态
 */

import {
  E2E_COMPANION_DB_PATH,
  E2E_COMPANION_CONTENT_ROOT,
  E2E_COMPANION_COURSE_ID,
} from "../e2e/config";

// ------------------------------------------------------------------ 边界自检
/*
 * 在**打开任何东西之前**确认自己只会在合成路径上工作。
 *
 * 这是"结构性判据"而不是"事后检查"：路径不对就直接退出，
 * 因此不存在"不小心打开了真实库"的可能。
 */
const normalizedDb = E2E_COMPANION_DB_PATH.replace(/\\/g, "/");
if (!normalizedDb.includes("/.e2e/")) {
  console.error(`[mutate] 拒绝运行：数据库路径不在 .e2e/ 下（${normalizedDb}）`);
  process.exit(2);
}
const normalizedRoot = E2E_COMPANION_CONTENT_ROOT.replace(/\\/g, "/");
if (!normalizedRoot.includes("/.e2e/")) {
  console.error(`[mutate] 拒绝运行：内容根不在 .e2e/ 下（${normalizedRoot}）`);
  process.exit(2);
}

process.env.CET6_DB_PATH = E2E_COMPANION_DB_PATH;
process.env.CET6_CONTENT_ROOT = E2E_COMPANION_CONTENT_ROOT;

const [, , action, ...args] = process.argv;

const { getRepositories } = await import("@/repositories/sqlite");
const repos = getRepositories();

switch (action) {
  case "link": {
    const [segmentId, paperId, sectionId] = args;
    if (!segmentId || !paperId || !sectionId) {
      console.error("[mutate] link 需要 <segmentId> <paperId> <sectionId>");
      process.exit(2);
    }
    const { verifyCanonicalLink } = await import("@/services/course-link");
    const result = verifyCanonicalLink(repos, {
      courseId: E2E_COMPANION_COURSE_ID,
      courseContentVersion: 1,
      segmentId,
      paperId,
      paperContentVersion: 1,
      sectionId,
      targetScope: "section",
      verificationStatus: "verified",
      verificationRef: "E2E 合成状态变更（Round 3 绕过回归）",
    });
    if (!result.ok) {
      console.error(`[mutate] link 失败：${JSON.stringify(result.issues)}`);
      process.exit(1);
    }
    console.log(JSON.stringify({ ok: true, action, segmentId, paperId, sectionId }));
    break;
  }

  case "unlink": {
    const [segmentId] = args;
    if (!segmentId) {
      console.error("[mutate] unlink 需要 <segmentId>");
      process.exit(2);
    }
    /*
     * 链接是只追加的（有 BEFORE DELETE 触发器），因此"移除"的实际含义是
     * "把它的核验状态改成 rejected" —— 那正是产品里"这条对应关系不再成立"
     * 的记录方式。
     */
    const { listLinksForSegmentWithUsability } = await import("@/services/course-link");
    const views = listLinksForSegmentWithUsability(repos, E2E_COMPANION_COURSE_ID, segmentId);
    let changed = 0;
    for (const view of views) {
      if (view.link.verificationStatus === "verified") {
        repos.courses.appendLink({
          ...view.link,
          id: `${view.link.id}-rejected`,
          verificationStatus: "rejected",
          verificationRef: "E2E 合成状态变更：移除对应关系",
        });
        changed += 1;
      }
    }
    console.log(JSON.stringify({ ok: true, action, segmentId, rejected: changed }));
    break;
  }

  case "hide-paper": {
    const [paperId] = args;
    if (!paperId) {
      console.error("[mutate] hide-paper 需要 <paperId>");
      process.exit(2);
    }
    /*
     * 把合成试卷包目录**改名**，模拟"这份真题包当前读不到"。
     *
     * 为什么用改名而不是删：改名是**可逆**的（`show-paper` 改回来），
     * 而本 spec 需要在一个实例上反复造出/撤销这个状态。
     * 改名与删除对运行时判据的效果相同 —— `runtimeUsable` 要求包可读。
     */
    const { renameSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const from = join(E2E_COMPANION_CONTENT_ROOT, "cet6", "papers", paperId);
    const to = `${from}.hidden`;
    if (!existsSync(from)) {
      console.error(`[mutate] hide-paper 找不到包：${from}`);
      process.exit(1);
    }
    renameSync(from, to);
    console.log(JSON.stringify({ ok: true, action, paperId }));
    break;
  }

  case "show-paper": {
    const [paperId] = args;
    if (!paperId) {
      console.error("[mutate] show-paper 需要 <paperId>");
      process.exit(2);
    }
    const { renameSync, existsSync } = await import("node:fs");
    const { join } = await import("node:path");
    const from = join(E2E_COMPANION_CONTENT_ROOT, "cet6", "papers", `${paperId}.hidden`);
    const to = join(E2E_COMPANION_CONTENT_ROOT, "cet6", "papers", paperId);
    if (!existsSync(from)) {
      console.error(`[mutate] show-paper 找不到被隐藏的包：${from}`);
      process.exit(1);
    }
    renameSync(from, to);
    console.log(JSON.stringify({ ok: true, action, paperId }));
    break;
  }

  case "pool": {
    const [paperId, pool] = args;
    if (!paperId || !pool) {
      console.error("[mutate] pool 需要 <paperId> <pool>");
      process.exit(2);
    }
    if (pool !== "training" && pool !== "mock_reserve") {
      console.error(`[mutate] pool 必须是 training 或 mock_reserve，收到 ${pool}`);
      process.exit(2);
    }
    repos.papers.setPool(paperId, pool);
    console.log(JSON.stringify({ ok: true, action, paperId, pool }));
    break;
  }

  case "state": {
    const [segmentId] = args;
    if (!segmentId) {
      console.error("[mutate] state 需要 <segmentId>");
      process.exit(2);
    }
    const { computeRevealRisk } = await import("@/services/reveal-risk");
    const risk = computeRevealRisk(repos, E2E_COMPANION_COURSE_ID, segmentId);
    console.log(
      JSON.stringify({
        fingerprint: risk.fingerprint,
        risky: risk.risky,
        requiresConfirmation: risk.requiresConfirmation,
        papers: risk.papers.map((paper) => ({
          paperId: paper.paperId,
          /*
           * `paperTitle` 必须一起输出：E2E 用它核对"卷名是否完整"。
           * Final P2 的缺陷正是卷名被 `" · "` 切错（丢掉 `set1`），
           * 而 `paperTitle` 是契约里独立校验过的字段 ——
           * 它是客户端切分卷名与目标的唯一可靠边界。
           */
          paperTitle: paper.paperTitle,
          targetLabel: paper.targetLabel,
          runtimeUsable: paper.runtimeUsable,
          reservedForMock: paper.reservedForMock,
        })),
      }),
    );
    break;
  }

  case "exposures": {
    /*
     * 曝光行数的**独立**判据（经仓储层读合成库，而不是问服务层
     * "你觉得写了几条"）。
     *
     * 这一条很重要：它证明"零曝光"不是界面说了算，而是库里真的没有。
     */
    const profile = repos.learner.getProfile();
    const rows = profile
      ? repos.courses.listExposureForProfile(profile.id, 1000)
      : [];
    console.log(
      JSON.stringify({
        count: rows.filter((event) => event.eventType === "reveal_requested").length,
      }),
    );
    break;
  }

  case "uncertain": {
    const [paperId] = args;
    if (!paperId) {
      console.error("[mutate] uncertain 需要 <paperId>");
      process.exit(2);
    }
    const { getPaperFreshness } = await import("@/services/paper-freshness");
    const profile = repos.learner.getProfile();
    if (!profile) {
      console.error("[mutate] 没有 profile");
      process.exit(1);
    }
    const freshness = getPaperFreshness(repos, profile.id, paperId);
    console.log(
      JSON.stringify({
        state: freshness.state,
        unresolved: freshness.unresolved.map((item) => item.code),
      }),
    );
    break;
  }

  default: {
    console.error(`[mutate] 未知动作：${action ?? "(缺省)"}`);
    process.exit(2);
  }
}
