#!/usr/bin/env node
/**
 * **模考新鲜度专用**服务器启动器（端口 3250）。
 *
 * ── 它构造的那个状态 ──
 *
 * 三份**合成夹具**试卷全部被标为「模考保留」：
 *
 * | 试卷 | 构造 | 期望状态 |
 * | --- | --- | --- |
 * | `2023-06-set1` | 什么都不做 | `pristine` —— 尚未接触 |
 * | `2024-12-set1` | 有可用链接 + 同版本曝光 | `exposed` —— 已接触过 |
 * | `2024-12-set2` | 课程升版 ⇒ 链接失效 | `uncertain` —— 无法确认 |
 *
 * ── 曝光刻意**早于**链接（这是本能力的核心要求）──
 *
 * 顺序是：先记录课程曝光（那时该段**还没有**任何 canonical 链接），
 * 两周后再人工核验出对应关系。历史曝光因此必须能**回溯投影**到那道真题上 ——
 * 而曝光行本身原样不动（它不以 canonical 目标为主身份）。
 *
 * 若投影只能在"链接先存在"时才成立，这个状态就永远投影不出来。
 *
 * ── 隔离与内容策略 ──
 *
 * 独立内容根 `.e2e/freshness-content`、独立数据库 `.e2e/cet6-freshness.db`、
 * 独立端口 3250。试卷 `sourceKind` 恒为 `test_fixture`（夹具构造器写死），
 * 课程 provider 恒为 `test_fixture_provider`。它**不碰** `private-content/`，
 * 也**不碰** `data/cet6.db`，因此不会读到任何真实 RSVP 私有材料。
 *
 * ── 为什么必须先 seed 再构造曝光 ──
 *
 * `recordCourseExposure` 以 `profile_id` 外键引用 `learner_profile`，
 * 因此 profile 必须先存在。seed 脚本是独立进程（会各开一个库句柄），
 * 因此顺序是：写夹具 → seed profile → **然后**才 import repository 并构造曝光。
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import {
  E2E_FRESHNESS_DB_PATH,
  E2E_FRESHNESS_PORT,
  E2E_FRESHNESS_CONTENT_ROOT,
  E2E_FRESHNESS_PRISTINE_PAPER_ID,
  E2E_FRESHNESS_EXPOSED_PAPER_ID,
  E2E_FRESHNESS_UNCERTAIN_PAPER_ID,
  E2E_FRESHNESS_EXPOSED_COURSE_ID,
  E2E_FRESHNESS_STALE_COURSE_ID,
} from "../e2e/config";
import { buildFixturePackage, writeFixturePackage } from "./paper-fixture";
import { buildCourseFixture, writeCourseFixture } from "./course-fixture";
import { LOOPBACK_HOST } from "@/lib/loopback-guard";
import { spawnSync } from "node:child_process";
import { spawnNext } from "./spawn-next";

// ------------------------------------------------------------------ 清库
if (process.env.E2E_RESET_DB === "1") {
  for (const suffix of ["", "-wal", "-shm"]) {
    const file = `${E2E_FRESHNESS_DB_PATH}${suffix}`;
    if (existsSync(file)) rmSync(file, { force: true });
  }
  rmSync(E2E_FRESHNESS_CONTENT_ROOT, { recursive: true, force: true });
}
mkdirSync(dirname(E2E_FRESHNESS_DB_PATH), { recursive: true });
mkdirSync(E2E_FRESHNESS_CONTENT_ROOT, { recursive: true });

process.env.CET6_CONTENT_ROOT = E2E_FRESHNESS_CONTENT_ROOT;
process.env.CET6_DB_PATH = E2E_FRESHNESS_DB_PATH;

// ------------------------------------------------- 写入合成夹具（试卷 + 课程）
const papers = [
  { id: E2E_FRESHNESS_PRISTINE_PAPER_ID, year: 2023, session: "June" as const, variant: "set1" },
  { id: E2E_FRESHNESS_EXPOSED_PAPER_ID, year: 2024, session: "December" as const, variant: "set1" },
  { id: E2E_FRESHNESS_UNCERTAIN_PAPER_ID, year: 2024, session: "December" as const, variant: "set2" },
];

for (const paper of papers) {
  writeFixturePackage(
    E2E_FRESHNESS_CONTENT_ROOT,
    `${paper.year}-${paper.session}-${paper.variant}`,
    buildFixturePackage({
      id: paper.id,
      year: paper.year,
      session: paper.session,
      variant: paper.variant,
    }),
  );
}

/*
 * 课程包 A（`fixture-course-exposed`）：v1。它的 `reading.a` 段会被核验指向
 * exposed 试卷的 `reading.careful_reading`。
 */
writeCourseFixture(
  E2E_FRESHNESS_CONTENT_ROOT,
  E2E_FRESHNESS_EXPOSED_COURSE_ID,
  buildCourseFixture({ id: E2E_FRESHNESS_EXPOSED_COURSE_ID }),
);

/*
 * 课程包 B（`fixture-course-stale`）：先写 v1，建立链接后再升到 v2 使其失效。
 */
writeCourseFixture(
  E2E_FRESHNESS_CONTENT_ROOT,
  E2E_FRESHNESS_STALE_COURSE_ID,
  buildCourseFixture({
    id: E2E_FRESHNESS_STALE_COURSE_ID,
    contentVersion: 1,
    readingText: "Fixture stale course v1 body. Synthetic text, not CET material.",
  }),
);

// ------------------------------------------- 先 seed profile（曝光的外键前提）
for (const script of ["seed-onboard.ts", "seed-diagnostic.ts"]) {
  console.log(`[freshness-server] 构造状态：${script}`);
  const step = spawnSync(
    process.execPath,
    ["--experimental-transform-types", "--import", "./scripts/alias-loader.mjs", `scripts/${script}`],
    { stdio: "inherit", env: process.env },
  );
  if (step.status !== 0) {
    console.error(`[freshness-server] ${script} 失败`);
    process.exit(1);
  }
}

// ------------------------------------------------ 现在才打开 repository 句柄
const { getRepositories } = await import("@/repositories/sqlite");
const { runImport } = await import("@/services/paper-import");
const { planCourseImport, commitCourseImport } = await import("@/services/course-import");
const { recordCourseExposure } = await import("@/services/course-exposure");
const { verifyCanonicalLink } = await import("@/services/course-link");

const repos = getRepositories();
const profileId = repos.learner.getProfile()?.id;
if (!profileId) {
  console.error("[freshness-server] seed 之后仍读不到 profile");
  process.exit(1);
}

// ---------------------------------------------------------------- 导入试卷
const imported = runImport(repos, { dryRun: false });
if (!imported.ok || imported.report.counts.rejected > 0) {
  console.error("[freshness-server] 试卷夹具导入失败");
  process.exit(1);
}

// ---------------------------------------------------------------- 导入课程 v1
/*
 * `planCourseImport` 是**纯计划**（零写入），它不返回 ok/error ——
 * 包级问题记录在 `report.entries[].issues` 里。因此这里检查 rejected 计数。
 */
const coursePlan = planCourseImport(repos);
if (coursePlan.report.counts.rejected > 0) {
  for (const entry of coursePlan.report.entries) {
    if (entry.decision !== "rejected") continue;
    console.error(`[freshness-server] 课程夹具被拒 ${entry.packagePath}：`);
    for (const issue of entry.issues) console.error(`  ${issue.path}: ${issue.message}`);
  }
  process.exit(1);
}
const committed = commitCourseImport(repos, coursePlan);
if (!committed.ok) {
  console.error(`[freshness-server] 课程夹具导入失败：${committed.error}`);
  process.exit(1);
}

// ------------------------------------------------- 把三份试卷全部设为保留
for (const paper of papers) {
  repos.papers.setPool(paper.id, "mock_reserve");
}

// =====================================================================
// 构造状态 1 · **exposed**：先曝光、后核验（历史曝光必须能回溯投影）
// =====================================================================

// ① 今天：`reading.a` 段**还没有**任何 canonical 链接，但学习者已经学过了。
const exposure = recordCourseExposure(repos, {
  profileId,
  courseId: E2E_FRESHNESS_EXPOSED_COURSE_ID,
  segmentId: "reading.a",
  courseContentVersion: 1,
  eventType: "content_rendered",
  occurredAt: "2026-02-01T10:00:00.000Z",
});
if (!exposure.ok) {
  console.error(`[freshness-server] 曝光写入失败：${JSON.stringify(exposure.issues)}`);
  process.exit(1);
}

// ② 两周后：人工核验出这一段对应哪份真题的哪个大题。
const link = verifyCanonicalLink(repos, {
  courseId: E2E_FRESHNESS_EXPOSED_COURSE_ID,
  courseContentVersion: 1,
  segmentId: "reading.a",
  paperId: E2E_FRESHNESS_EXPOSED_PAPER_ID,
  paperContentVersion: 1,
  sectionId: "reading.careful_reading",
  targetScope: "section",
  verificationStatus: "verified",
  verificationRef: "synthetic fixture verification (e2e freshness)",
});
if (!link.ok) {
  console.error(`[freshness-server] 链接核验失败：${JSON.stringify(link.issues)}`);
  process.exit(1);
}

// =====================================================================
// 构造状态 2 · **uncertain**：链接先成立，随后课程升版使其失效
// =====================================================================

// ③ 学习者确实学过 stale 课程的 `reading.b`（v1）。
const staleExposure = recordCourseExposure(repos, {
  profileId,
  courseId: E2E_FRESHNESS_STALE_COURSE_ID,
  segmentId: "reading.b",
  courseContentVersion: 1,
  eventType: "teacher_explanation_seen",
  occurredAt: "2026-02-02T10:00:00.000Z",
});
if (!staleExposure.ok) {
  console.error(`[freshness-server] 陈旧课程曝光写入失败：${JSON.stringify(staleExposure.issues)}`);
  process.exit(1);
}

// ④ 在 v1 上核验一条链接。
const staleLink = verifyCanonicalLink(repos, {
  courseId: E2E_FRESHNESS_STALE_COURSE_ID,
  courseContentVersion: 1,
  segmentId: "reading.b",
  paperId: E2E_FRESHNESS_UNCERTAIN_PAPER_ID,
  paperContentVersion: 1,
  sectionId: "reading.matching",
  targetScope: "section",
  verificationStatus: "verified",
  verificationRef: "synthetic fixture verification (e2e freshness, later invalidated)",
});
if (!staleLink.ok) {
  console.error(`[freshness-server] 陈旧链接核验失败：${JSON.stringify(staleLink.issues)}`);
  process.exit(1);
}

// ⑤ 课程升到 v2 ⇒ 上面那条链接**立即不可用**。曝光仍在（它指向 v1）。
writeCourseFixture(
  E2E_FRESHNESS_CONTENT_ROOT,
  E2E_FRESHNESS_STALE_COURSE_ID,
  buildCourseFixture({
    id: E2E_FRESHNESS_STALE_COURSE_ID,
    contentVersion: 2,
    readingText: "Fixture stale course v2 body. A genuinely different version.",
  }),
);
const reimport = commitCourseImport(repos, planCourseImport(repos));
if (!reimport.ok) {
  console.error(`[freshness-server] 课程升版失败：${reimport.error}`);
  process.exit(1);
}

// ---------------------------------------------------- 自证：状态确实造出来了
const { getPaperFreshnessIndex } = await import("@/services/paper-freshness");
const index = getPaperFreshnessIndex(repos, profileId);
const observed = {
  pristine: index.get(E2E_FRESHNESS_PRISTINE_PAPER_ID).state,
  exposed: index.get(E2E_FRESHNESS_EXPOSED_PAPER_ID).state,
  uncertain: index.get(E2E_FRESHNESS_UNCERTAIN_PAPER_ID).state,
};

console.log(`[freshness-server] 内容根: ${E2E_FRESHNESS_CONTENT_ROOT}`);
console.log(`[freshness-server] DB: ${E2E_FRESHNESS_DB_PATH}`);
console.log(`[freshness-server] 试卷夹具导入: 写入 ${imported.written} 份`);
console.log(`[freshness-server] 课程夹具导入: ${committed.written} 份`);
console.log(
  `[freshness-server] 新鲜度自证: pristine=${observed.pristine} ` +
    `exposed=${observed.exposed} uncertain=${observed.uncertain}`,
);

/*
 * 期望不成立就**不启动** —— 让"实例起不来"立刻可见，
 * 而不是让浏览器测试去猜为什么页面上没有那个状态。
 */
if (
  observed.pristine !== "pristine" ||
  observed.exposed !== "exposed" ||
  observed.uncertain !== "uncertain"
) {
  console.error(
    "[freshness-server] 构造的新鲜度状态与预期不符，拒绝启动（否则门禁会验证一个不存在的状态）。",
  );
  process.exit(1);
}

// ------------------------------------------------------------------ 启动
console.log(`[freshness-server] PORT: ${E2E_FRESHNESS_PORT}`);

// 只绑定回环：合成实例绝不对局域网开放（集中边界见 src/proxy.ts）
// CET6_LOCAL_ORIGIN 让"精确同一来源"守卫知道本实例的可信来源
const result = spawnNext("start", E2E_FRESHNESS_PORT, {
  stdio: "inherit",
  env: { ...process.env, CET6_LOCAL_ORIGIN: `http://${LOOPBACK_HOST}:${E2E_FRESHNESS_PORT}` },
});
process.exit(result.status ?? 0);
