#!/usr/bin/env node
/**
 * Review Fix 的九项**显式复现**（开发者验证证据）。
 *
 * 目的不是替代测试，而是把评审要求的九个具体场景在有真实磁盘、真实数据库的
 * 环境里**逐条跑一遍并打印结论** —— 这样"修好了"这句话有可核对的输出，
 * 而不是只有一句断言。
 *
 * 覆盖：
 *   1. 课程包盘上漂移 → 拒绝建立 verified 链接
 *   2. 真题包盘上漂移 → 拒绝建立 verified 链接
 *   3. 课程漂移后，既有运行时链接**立即**不可用
 *   4. 真题漂移后，既有运行时链接**立即**不可用
 *   5. raw SQL UPDATE 复核记录 被阻断
 *   6. raw SQL DELETE 复核记录 被阻断
 *   7. 修正 verificationRef 产生**新的**不可变历史行
 *   8. 同一语义目标的运行时真相**保持单条**（去重）
 *   9. manifest schemaVersion 缺失 / 未来版本 被拒绝
 *
 * ── 每个场景一个**全新环境**（独立临时内容根 + 独立数据库）──
 *
 * 刻意不复用同一个库：场景之间会互相污染（例如场景 1 已经把试卷导入了，
 * 场景 2 再"导入"就会被判 unchanged，于是复现的前提根本不成立）。
 * 每个场景自带环境，才能保证"这条复现确实在说它声称的那件事"。
 *
 * 全部使用**合成夹具**；不触碰 使用者的真实库与真实 private-content。
 *
 * 用法：
 *   node --experimental-transform-types --import ./scripts/alias-loader.mjs \
 *     scripts/course-review-repro.ts
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const COURSE_ID = "repro-course";
const PAPER_ID = "fixture-cet6-2024-12-v1";
const SEGMENT_ID = "reading.a";
const SECTION_ID = "reading.careful_reading";

interface Env {
  root: string;
  db: import("node:sqlite").DatabaseSync;
  repos: import("@/repositories/ports").Repositories;
  dispose(): void;
}

async function makeEnv(): Promise<Env> {
  const { openDatabase } = await import("@/db/client");
  const { createSqliteRepositories } = await import("@/repositories/sqlite");

  const root = mkdtempSync(join(tmpdir(), "cet6-repro-"));

  /*
   * 结构性安全断言：本脚本**只能**打开临时目录里的库。
   *
   * 它走的是写入路径（要复现 --commit 场景），因此必须显式证明
   * 它指向的不是 使用者的真实库。早先的缺陷正是"一个自称只读的命令
   * 经由 getRepositories() 打开了默认库并把它迁移了" ——
   * 这里用断言把"绝不碰真实库"变成代码事实，而不是注释里的承诺。
   */
  const dbPath = join(root, "repro.db");
  if (!dbPath.startsWith(tmpdir()) || dbPath.includes("data")) {
    throw new Error(`复现脚本只允许在临时目录建库，拒绝路径：${dbPath}`);
  }

  process.env.CET6_CONTENT_ROOT = root;
  process.env.CET6_DB_PATH = dbPath;

  const db = openDatabase(dbPath);
  const repos = createSqliteRepositories(db);

  return {
    root,
    db,
    repos,
    dispose() {
      try {
        db.close();
      } catch {
        /* 已关闭 */
      }
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function importFixtures(env: Env, opts: { course?: boolean; paper?: boolean } = {}): Promise<void> {
  const { commitCourseImport, planCourseImport } = await import("@/services/course-import");
  const { planImport, commitImport } = await import("@/services/paper-import");
  const { buildCourseFixture, writeCourseFixture } = await import("./course-fixture");
  const { buildFixturePackage, writeFixturePackage } = await import("./paper-fixture");

  if (opts.paper !== false) {
    writeFixturePackage(env.root, "repro-paper", buildFixturePackage({ contentVersion: 1 }));
    const plan = planImport(env.repos, { only: ["repro-paper"] });
    if (plan.report.counts.insert !== 1) throw new Error("试卷夹具未按预期新增");
    commitImport(env.repos, plan);
  }
  if (opts.course !== false) {
    writeCourseFixture(env.root, COURSE_ID, buildCourseFixture({ id: COURSE_ID }));
    const result = commitCourseImport(env.repos, planCourseImport(env.repos));
    if (!result.ok) throw new Error(`课程导入失败：${result.error}`);
  }
}

function courseManifestPath(env: Env): string {
  return join(env.root, "courses", COURSE_ID, "course.json");
}

function paperManifestPath(env: Env): string {
  return join(env.root, "cet6", "papers", "repro-paper", "paper.json");
}

/** 改动课程正文但**不升 contentVersion**（version 相等 ⇒ 旧实现会 fail-open）。 */
function driftCourse(env: Env): void {
  const path = courseManifestPath(env);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as {
    contentVersion: number;
    segments: Array<{ text?: string | null }>;
  };
  manifest.segments[0].text = `DRIFT ${manifest.segments[0].text ?? ""}`;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

/** 改动真题 provenance 但**不升 contentVersion**（包仍能解析，字节已变）。 */
function driftPaper(env: Env): void {
  const path = paperManifestPath(env);
  const manifest = JSON.parse(readFileSync(path, "utf8")) as { provenance: { note: string } };
  manifest.provenance.note = `DRIFT ${manifest.provenance.note}`;
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    courseId: COURSE_ID,
    courseContentVersion: 1,
    segmentId: SEGMENT_ID,
    paperId: PAPER_ID,
    paperContentVersion: 1,
    sectionId: SECTION_ID,
    targetScope: "section" as const,
    verificationStatus: "verified" as const,
    verificationRef: "人工核验：复现记录",
    ...overrides,
  };
}

function rowCount(env: Env): number {
  return Number(
    (env.db.prepare("SELECT COUNT(*) AS c FROM course_canonical_link").get() as { c: number }).c,
  );
}

async function main(): Promise<void> {
  const { verifyCanonicalLink, listRuntimeLinksForSegment, listLinksForSegmentWithUsability } =
    await import("@/services/course-link");

  console.log("Course Layer Review Fix · 九项显式复现");
  console.log("（每个场景使用独立的临时内容根与独立数据库）");

  // ---- 1. 课程包漂移 → 写入被拒 ----
  section("1. 课程包盘上漂移 → 拒绝建立 verified 链接");
  {
    const env = await makeEnv();
    try {
      await importFixtures(env);
      driftCourse(env);
      const result = verifyCanonicalLink(env.repos, link());
      check("写入被拒绝（fail closed）", !result.ok, result.ok ? "(竟然成功了)" : JSON.stringify(result.issues));
      check("一行链接都没写", rowCount(env) === 0, `实际 ${rowCount(env)}`);
    } finally {
      env.dispose();
    }
  }

  // ---- 2. 真题包漂移 → 写入被拒 ----
  section("2. 真题包盘上漂移 → 拒绝建立 verified 链接");
  {
    const env = await makeEnv();
    try {
      await importFixtures(env);
      driftPaper(env);
      const result = verifyCanonicalLink(env.repos, link());
      check("写入被拒绝（fail closed）", !result.ok, result.ok ? "(竟然成功了)" : JSON.stringify(result.issues));
      check("一行链接都没写", rowCount(env) === 0, `实际 ${rowCount(env)}`);
    } finally {
      env.dispose();
    }
  }

  // ---- 3. 课程漂移 → 运行时链接立即不可用 ----
  section("3. 课程漂移后，既有运行时链接立即不可用（不需重导入/升版本）");
  {
    const env = await makeEnv();
    try {
      await importFixtures(env);
      const created = verifyCanonicalLink(env.repos, link());
      check("先建立一条可用链接", created.ok);
      check("漂移前运行时可用", listRuntimeLinksForSegment(env.repos, COURSE_ID, SEGMENT_ID).length === 1);

      driftCourse(env);

      check(
        "漂移后运行时**立即**不可用",
        listRuntimeLinksForSegment(env.repos, COURSE_ID, SEGMENT_ID).length === 0,
      );
      const views = listLinksForSegmentWithUsability(env.repos, COURSE_ID, SEGMENT_ID);
      check(
        "原因指出包已漂移（可读）",
        views[0]?.unusableReason?.includes("没有重新导入") === true,
        views[0]?.unusableReason ?? "(无)",
      );
      check("审计行未被删除", views.length === 1);
    } finally {
      env.dispose();
    }
  }

  // ---- 4. 真题漂移 → 运行时链接立即不可用 ----
  section("4. 真题漂移后，既有运行时链接立即不可用");
  {
    const env = await makeEnv();
    try {
      await importFixtures(env);
      verifyCanonicalLink(env.repos, link());
      check("漂移前运行时可用", listRuntimeLinksForSegment(env.repos, COURSE_ID, SEGMENT_ID).length === 1);

      driftPaper(env);

      check(
        "漂移后运行时**立即**不可用",
        listRuntimeLinksForSegment(env.repos, COURSE_ID, SEGMENT_ID).length === 0,
      );
      const views = listLinksForSegmentWithUsability(env.repos, COURSE_ID, SEGMENT_ID);
      check(
        "原因指出真题包已漂移",
        views[0]?.unusableReason?.includes("真题包") === true,
        views[0]?.unusableReason ?? "(无)",
      );
    } finally {
      env.dispose();
    }
  }

  // ---- 5/6. raw SQL UPDATE / DELETE 被阻断 ----
  section("5/6. raw SQL UPDATE / DELETE 复核记录 被数据库阻断");
  {
    const env = await makeEnv();
    try {
      await importFixtures(env);
      const created = verifyCanonicalLink(env.repos, link());
      check("先建立一条复核记录", created.ok);
      const id = created.ok ? created.link.id : "";

      let updateBlocked = false;
      try {
        env.db.prepare("UPDATE course_canonical_link SET verification_ref = 'tampered' WHERE id = ?").run(id);
      } catch (error) {
        updateBlocked = /不可变/.test((error as Error).message);
      }
      check("UPDATE 被阻断", updateBlocked);

      let deleteBlocked = false;
      try {
        env.db.prepare("DELETE FROM course_canonical_link WHERE id = ?").run(id);
      } catch (error) {
        deleteBlocked = /不可变/.test((error as Error).message);
      }
      check("DELETE 被阻断", deleteBlocked);

      check("记录仍在且未被改写", rowCount(env) === 1, `实际 ${rowCount(env)}`);
    } finally {
      env.dispose();
    }
  }

  // ---- 7/8. 修正出处追加新行 + 运行时去重 ----
  section("7. 修正 verificationRef 产生**新的**不可变历史行（旧行保留）");
  {
    const env = await makeEnv();
    try {
      await importFixtures(env);
      const first = verifyCanonicalLink(env.repos, link({ verificationRef: "初版出处（有误）" }));
      check("第一条写入成功", first.ok);
      const second = verifyCanonicalLink(env.repos, link({ verificationRef: "修正后的出处" }));
      check("修正后**追加**了新行（created=true，未被吞掉）", second.ok && second.created === true);
      check("历史共有 2 行（旧行保留）", rowCount(env) === 2, `实际 ${rowCount(env)}`);

      if (first.ok && second.ok) {
        check("两行 id 不同", first.link.id !== second.link.id);
        check(
          "旧行的出处未被改写",
          env.repos.courses.getLink(first.link.id)?.verificationRef === "初版出处（有误）",
        );
      }

      section("8. 同一语义目标的运行时真相保持单条（审计行多，目标仍一个）");
      const runtime = listRuntimeLinksForSegment(env.repos, COURSE_ID, SEGMENT_ID);
      check("运行时只返回 1 个目标", runtime.length === 1, `实际 ${runtime.length}`);

      const { getCourseLinkOverview } = await import("@/services/course-link");
      const overview = getCourseLinkOverview(env.repos, COURSE_ID);
      check("overview.verifiedUsable = 1", overview.verifiedUsable === 1, `实际 ${overview.verifiedUsable}`);
      check(
        "overview.verifiedRows = 2（审计行不去重）",
        overview.verifiedRows === 2,
        `实际 ${overview.verifiedRows}`,
      );
      check("匹配段只有一个", overview.matchedSegmentIds.length === 1);
    } finally {
      env.dispose();
    }
  }

  // ---- 9. schemaVersion 缺失 / 未来版本 被拒 ----
  section("9. manifest schemaVersion 缺失 / 未来版本 被明确拒绝");
  {
    const { validateCourseManifest } = await import("@/content/course/validator");
    const { buildCourseFixture } = await import("./course-fixture");

    const missing = validateCourseManifest(buildCourseFixture({ omitSchemaVersion: true }).manifest);
    check("缺失被拒绝", !missing.ok);
    check(
      "错误直说 schemaVersion 问题",
      missing.issues[0]?.path === "schemaVersion" &&
        missing.issues[0].message.includes("缺少 schemaVersion"),
      JSON.stringify(missing.issues),
    );

    const future = validateCourseManifest(buildCourseFixture({ schemaVersion: 2 }).manifest);
    check("未来版本被拒绝", !future.ok);
    check(
      "错误说明它来自更新的应用",
      future.issues[0]?.message.includes("更新的应用") === true,
      JSON.stringify(future.issues),
    );

    const valid = validateCourseManifest(buildCourseFixture().manifest);
    check("schemaVersion = 1 合法", valid.ok && valid.course?.schemaVersion === 1);
  }

  console.log(`\n${"─".repeat(56)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);

  if (failed > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error("\n复现脚本异常终止：");
  console.error(error);
  process.exitCode = 1;
});
