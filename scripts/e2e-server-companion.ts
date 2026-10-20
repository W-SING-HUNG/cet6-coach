#!/usr/bin/env node
/**
 * **课程伴随界面（Course Companion）专用**服务器启动器（端口 3265）。
 *
 * ── 它构造的那个状态 ──
 *
 * 一份**合成夹具**课程包被导入索引，且其中一段已被揭示过一次 ——
 * 因此浏览器能同时验证三种状态：
 *
 * | 段 | 构造 | 界面必须表现 |
 * | --- | --- | --- |
 * | `reading.a` | 已揭示过 | 「已看过」+「再看这段」 |
 * | `reading.b` | 未揭示 | 「看这段」 |
 * | `translation.1` | 未揭示 | 「看这段」+ 四个通道说明 |
 *
 * 另外构造一份**包漂移**的课程，用于验证"漂移时不给正文入口"。
 *
 * ── 隔离与内容策略 ──
 *
 * 独立内容根 `.e2e/companion-content`、独立数据库 `.e2e/cet6-companion.db`、
 * 独立端口 3265。课程 provider 恒为 `test_fixture_provider`（夹具构造器写死），
 * 全部正文是合成字符串，带「夹具」标识。它**不碰** `private-content/`，
 * 也**不碰** `data/cet6.db`。
 */

import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  E2E_COMPANION_DB_PATH,
  E2E_COMPANION_PORT,
  E2E_COMPANION_CONTENT_ROOT,
  E2E_COMPANION_COURSE_ID,
  E2E_COMPANION_DRIFTED_COURSE_ID,
  E2E_COMPANION_LINKED_PAPER_ID,
  E2E_COMPANION_SEGMENT_ID,
} from "../e2e/config";
import { buildCourseFixture, writeCourseFixture } from "./course-fixture";
import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { spawnSync } from "node:child_process";
import { spawnNext } from "./spawn-next";

// ------------------------------------------------------------------ 清库
if (process.env.E2E_RESET_DB === "1") {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${E2E_COMPANION_DB_PATH}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  rmSync(E2E_COMPANION_CONTENT_ROOT, { recursive: true, force: true });
}
mkdirSync(dirname(E2E_COMPANION_DB_PATH), { recursive: true });
mkdirSync(E2E_COMPANION_CONTENT_ROOT, { recursive: true });

process.env.CET6_CONTENT_ROOT = E2E_COMPANION_CONTENT_ROOT;
process.env.CET6_DB_PATH = E2E_COMPANION_DB_PATH;

// ------------------------------------------- 先 seed profile（曝光的外键前提）
for (const script of ["seed-onboard.ts"]) {
  console.log(`[companion-server] 构造状态：${script}`);
  const step = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", `scripts/${script}`],
    { stdio: "inherit", env: process.env },
  );
  if (step.status !== 0) {
    console.error(`[companion-server] ${script} 失败`);
    process.exit(1);
  }
}

// ------------------------------------------------ 现在才打开 repository 句柄
const { getRepositories } = await import("@/repositories/sqlite");
const { planCourseImport, commitCourseImport } = await import("@/services/course-import");
const { revealCourseSegment } = await import("@/services/course-exposure");

const repos = getRepositories();
const profileId = repos.learner.getProfile()?.id;
if (!profileId) {
  console.error("[companion-server] seed 之后仍读不到 profile");
  process.exit(1);
}

// ------------------------------------------------------- 写入合成课程夹具
writeCourseFixture(
  E2E_COMPANION_CONTENT_ROOT,
  E2E_COMPANION_COURSE_ID,
  buildCourseFixture({ id: E2E_COMPANION_COURSE_ID }),
);

/*
 * 第二份课程：用于验证**包漂移**时的失败关闭。
 * 先导入，再在盘上改掉 manifest 而不重新导入。
 */
writeCourseFixture(
  E2E_COMPANION_CONTENT_ROOT,
  E2E_COMPANION_DRIFTED_COURSE_ID,
  buildCourseFixture({ id: E2E_COMPANION_DRIFTED_COURSE_ID }),
);

// ---------------------------------------------------------------- 导入课程
const plan = planCourseImport(repos);
if (plan.report.counts.rejected > 0) {
  for (const entry of plan.report.entries) {
    if (entry.decision !== "rejected") continue;
    console.error(`[companion-server] 课程夹具被拒 ${entry.packagePath}：`);
    for (const issue of entry.issues) console.error(`  ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}
const committed = commitCourseImport(repos, plan);
if (!committed.ok) {
  console.error(`[companion-server] 课程夹具导入失败：${committed.error}`);
  process.exit(1);
}

// ------------------------------------------- 构造状态：一份**已核验链接**的真题
/*
 * 为什么必须有它：P1 要求"揭示已核验指向真题的段之前给出明确警告"。
 * 没有真题与链接，就造不出那个风险状态，浏览器也就无从验证确认这一步。
 *
 * 全部是合成夹具（`sourceKind` 写死 `test_fixture`）。
 */
const { buildFixturePackage, writeFixturePackage } = await import("./paper-fixture");
const { planImport, commitImport } = await import("@/services/paper-import");
const { verifyCanonicalLink } = await import("@/services/course-link");

writeFixturePackage(
  E2E_COMPANION_CONTENT_ROOT,
  E2E_COMPANION_LINKED_PAPER_ID,
  buildFixturePackage({
    id: E2E_COMPANION_LINKED_PAPER_ID,
    year: 2024,
    session: "December",
    variant: "set1",
  }),
);
const paperPlan = planImport(repos, { only: [E2E_COMPANION_LINKED_PAPER_ID] });
if (paperPlan.report.counts.insert !== 1) {
  console.error("[companion-server] 真题夹具导入失败");
  process.exit(1);
}
if (!commitImport(repos, paperPlan).ok) {
  console.error("[companion-server] 真题夹具提交失败");
  process.exit(1);
}

// 把 reading.b 核验指向那份真题的仔细阅读，并把卷子设为**模考保留**。
const linked = verifyCanonicalLink(repos, {
  courseId: E2E_COMPANION_COURSE_ID,
  courseContentVersion: 1,
  segmentId: "reading.b",
  paperId: E2E_COMPANION_LINKED_PAPER_ID,
  paperContentVersion: 1,
  sectionId: "reading.careful_reading",
  targetScope: "section",
  verificationStatus: "verified",
  verificationRef: "synthetic fixture verification (e2e companion)",
});
if (!linked.ok) {
  console.error(
    `[companion-server] 链接核验失败：${linked.issues.map((issue) => issue.message).join(" ")}`,
  );
  process.exit(1);
}
repos.papers.setPool(E2E_COMPANION_LINKED_PAPER_ID, "mock_reserve");

/*
 * `writing.1` 上再造**多个语义目标**指向同一份卷子。
 *
 * 这是 Round 3 P1-M 的验收状态：一段材料同时对应同一份真题的
 * 仔细阅读第 1 组、第 2 组、以及"整个大题"。
 *
 * 独立审查复现的缺陷是"只显示第一个目标" —— 学习者确认的范围比
 * 系统记录的范围小。因此这里刻意造出三目标状态，
 * 让 E2E 能断言三个都出现在界面上。
 */
const MULTI_TARGET_SEGMENT = "writing.1";
for (const [scope, groupId] of [
  ["group", "reading.careful_reading#g1"],
  ["group", "reading.careful_reading#g2"],
  ["section", null],
] as const) {
  const multi = verifyCanonicalLink(repos, {
    courseId: E2E_COMPANION_COURSE_ID,
    courseContentVersion: 1,
    segmentId: MULTI_TARGET_SEGMENT,
    paperId: E2E_COMPANION_LINKED_PAPER_ID,
    paperContentVersion: 1,
    sectionId: "reading.careful_reading",
    targetScope: scope,
    groupId,
    questionId: null,
    verificationStatus: "verified",
    verificationRef: "synthetic fixture verification (e2e multi-target)",
  });
  if (!multi.ok) {
    console.error(
      `[companion-server] 多目标链接核验失败（${scope}/${groupId ?? "-"}）：` +
        multi.issues.map((issue) => issue.message).join(" "),
    );
    process.exit(1);
  }
}

// ------------------------------------- 构造状态：reading.a 已经被揭示过一次
/*
 * 揭示现在要求学习者确认过的**风险指纹**（P0-1）。这里按页面渲染的同一条
 * 路径从服务端算出当时的指纹，然后带上去 —— 这正是真实点击会做的事。
 */
const { computeRevealRisk } = await import("@/services/reveal-risk");
const revealRisk = computeRevealRisk(repos, E2E_COMPANION_COURSE_ID, E2E_COMPANION_SEGMENT_ID);
const reveal = revealCourseSegment(repos, {
  profileId,
  courseId: E2E_COMPANION_COURSE_ID,
  segmentId: E2E_COMPANION_SEGMENT_ID,
  courseContentVersion: 1,
  occurredAt: "2026-02-01T10:00:00.000Z",
  confirmedRiskFingerprint: revealRisk.fingerprint,
});
if (!reveal.ok) {
  console.error(`[companion-server] 构造揭示状态失败：${reveal.error}`);
  process.exit(1);
}

// ------------------------------- 构造状态：第二份课程**已漂移**（不重新导入）
const driftedManifestPath = join(
  E2E_COMPANION_CONTENT_ROOT,
  "courses",
  E2E_COMPANION_DRIFTED_COURSE_ID,
  "course.json",
);
const driftedManifest = JSON.parse(readFileSync(driftedManifestPath, "utf8")) as Record<string, unknown>;
const driftedSegments = driftedManifest.segments as Array<Record<string, unknown>>;
if (driftedSegments.length > 0) {
  driftedSegments[0].text = "盘上被换掉的合成正文 —— 索引从未登记过它。";
}
writeFileSync(driftedManifestPath, `${JSON.stringify(driftedManifest, null, 2)}\n`, "utf8");

// ---------------------------------------------------- 自证：状态确实造出来了
const { getCourseCompanionView } = await import("@/services/course-companion");
const view = getCourseCompanionView(repos, profileId, E2E_COMPANION_COURSE_ID);
if (!view) {
  console.error("[companion-server] 读不到伴随视图");
  process.exit(1);
}
const revealedSegment = view.segments.find((segment) => segment.segmentId === E2E_COMPANION_SEGMENT_ID);
if (!revealedSegment || revealedSegment.contactState === "not_contacted") {
  console.error("[companion-server] 构造的「已请求过揭示」状态与预期不符，拒绝启动");
  process.exit(1);
}

/*
 * 自证：reading.b 必须有一条**当前可用**的链接指向那份模考保留卷。
 *
 * 没有这一条，P1 的"揭示前确认"就没有可验证的状态，而浏览器测试会
 * 因为看不到确认面板而失败 —— 那种失败信息与本任务无关，难以定位。
 * 因此在启动前就让"状态没造出来"立刻可见。
 */
const linkedSegment = view.segments.find((segment) => segment.segmentId === "reading.b");
if (!linkedSegment || linkedSegment.linkedPapers.length === 0) {
  console.error(
    "[companion-server] reading.b 没有可用的 canonical 链接 —— 拒绝启动（否则 P1 确认流程无可验证状态）",
  );
  process.exit(1);
}
const linkedPaper = linkedSegment.linkedPapers[0];
if (!linkedPaper.reservedForMock) {
  console.error("[companion-server] 链接目标未被设为模考保留 —— 拒绝启动（P1 警告无可验证状态）");
  process.exit(1);
}

console.log(`[companion-server] 内容根: ${E2E_COMPANION_CONTENT_ROOT}`);
console.log(`[companion-server] DB: ${E2E_COMPANION_DB_PATH}`);
console.log(`[companion-server] 课程夹具导入: ${committed.written} 份`);
console.log(
  `[companion-server] 段数: ${view.segments.length}；已揭示: ${E2E_COMPANION_SEGMENT_ID}；` +
    `漂移课程: ${E2E_COMPANION_DRIFTED_COURSE_ID}`,
);

// ------------------------------------------------------------------ 启动
console.log(`[companion-server] PORT: ${E2E_COMPANION_PORT}`);

// 只绑定回环：合成实例绝不对局域网开放（集中边界见 src/proxy.ts）
// CET6_LOCAL_ORIGIN 让"精确同一来源"守卫知道本实例的可信来源
// 遥测设置由 spawnNext 统一注入（见 scripts/spawn-next.ts）
const result = spawnNext("start", E2E_COMPANION_PORT, {
  stdio: "inherit",
  env: { CET6_LOCAL_ORIGIN: `http://${LOOPBACK_HOST}:${E2E_COMPANION_PORT}` },
});
process.exit(result.status ?? 0);
