#!/usr/bin/env node
/**
 * `pnpm course:import` —— 把私有课程库中的课程包写入索引。
 *
 * 默认是 **dry-run**：只打印会发生什么，不写数据库。
 * 加 `--commit` 才真正写入 —— 顺序刻意为"先看后写"，
 * 因为导入的后果（新增 / 版本升级 / 拒绝）用户必须有机会先看清楚。
 *
 * 与 `content:import`（真题）刻意同构：同一个可信模式，不另创一套。
 *
 * 用法：
 *   pnpm course:import                    预演全部课程包
 *   pnpm course:import --commit           真正导入全部课程包
 *   pnpm course:import <dir> --commit     只导入指定包目录
 *   pnpm course:import --json             以 JSON 输出报告
 */

import { getReadOnlyRepositories, getRepositories } from "@/repositories/sqlite";
import {
  planCourseImport,
  commitCourseImport,
  type CourseImportReport,
} from "@/services/course-import";

function parseArgs(argv: string[]): { commit: boolean; json: boolean; only: string[] } {
  const commit = argv.includes("--commit");
  const json = argv.includes("--json");
  const only = argv.filter((arg) => !arg.startsWith("--"));
  return { commit, json, only };
}

function printReport(report: CourseImportReport, commit: boolean, written: number): void {
  console.log("CET-6 Coach · 课程包导入");
  console.log(`内容根：${report.contentRoot}`);
  console.log(`课程目录：${report.coursesDir}`);
  // 措辞必须**字面为真**：dry-run 连 schema 都不写（只读连接，迁移不可达）。
  console.log(
    `模式：${commit ? "写入（--commit：可迁移 schema 并写入课程索引）" : "预演（dry-run，不写数据库，含 schema）"}`,
  );
  console.log(
    `课程层索引：${report.courseIndexActivated ? "已激活（本库已含课程层表）" : "**尚未激活**（本库没有课程层表）"}`,
  );
  console.log("");

  // v8 库的诚实说明：预演的"新增 N 份"是**将要发生**的后果，不是当前库状态。
  if (!report.courseIndexActivated && report.discovered > 0) {
    console.log(
      "说明：本库尚未激活课程层（没有 course_package 表），因此课程索引当前必然为空 —— " +
        "上面的判定描述的是 **--commit 之后**会发生什么，不是现在库里的状态。",
    );
    if (!commit) {
      console.log(
        "      `--commit` 会先执行**增量** v8 → v9 迁移（建课程层三张表与只追加触发器），" +
          "再在**同一个事务**内写入课程索引。迁移是**提交动作的一部分**，不在预演中发生。",
      );
    }
    console.log("");
  }

  if (report.discovered === 0) {
    console.log("0 份课程包被发现。");
    console.log("把课程包放到上面的目录里（每个包一个子目录，内含 course.json 与 assets/）。");
    console.log("");
    console.log("结果：无事可做（课程库为空是合法状态）");
    return;
  }

  for (const entry of report.entries) {
    const marker =
      entry.decision === "insert"
        ? "+"
        : entry.decision === "update"
          ? "~"
          : entry.decision === "metadata_only"
            ? "m"
            : entry.decision === "unchanged"
              ? "="
              : "x";
    console.log(`${marker} ${entry.packagePath} — ${entry.title}`);
    if (entry.manifestSchemaVersion !== null) {
      // 明确打印被校验通过的 manifest 契约版本：它与内容版本含义不同，
      // 导入后需要能查证"这份文件是按哪一版契约读进来的"。
      console.log(`    manifest schemaVersion: ${entry.manifestSchemaVersion}（文件格式契约版本）`);
    }
    console.log(`    ${entry.detail}（${entry.segmentCount} 个段）`);
    for (const issue of entry.issues) console.log(`    ${issue.path}: ${issue.message}`);
    for (const warning of entry.warnings) console.log(`    ! ${warning}`);
  }

  console.log("");
  console.log(
    `发现 ${report.discovered} 份：新增 ${report.counts.insert} · 升级 ${report.counts.update} · ` +
      `仅元数据 ${report.counts.metadataOnly} · 已最新 ${report.counts.unchanged} · 拒绝 ${report.counts.rejected}`,
  );

  if (commit) {
    console.log(`已写入 ${written} 份课程包索引。`);
    console.log("");
    // 有包被拒绝时不得只说 PASS —— 那会让"这次导入什么都没成功"看起来
    // 像完全成功。拒绝本身不是操作失败（没有任何写入、没有半成品），
    // 但它必须与"全部成功"在结论行上可区分。
    if (report.counts.rejected > 0) {
      console.log(
        `结果：PASS（导入操作已完成，但有 ${report.counts.rejected} 份被拒绝，未写入任何数据）`,
      );
    } else {
      console.log("结果：PASS");
    }
  } else {
    console.log("");
    if (report.counts.insert === 0 && report.counts.update === 0 && report.counts.metadataOnly === 0) {
      console.log("没有需要写入的内容（加 --commit 也是空操作）。");
    } else {
      console.log("这是预演。确认无误后加 --commit 真正写入。");
    }
    if (report.counts.rejected > 0) {
      console.log(`注意：${report.counts.rejected} 份因校验或版本冲突被拒绝，它们不会被部分导入。`);
    }
  }

  // 这条提醒是本阶段的语义边界，不是可选的帮助文本：
  // 导入成功**不**意味着任何段已匹配真题。
  console.log("");
  console.log(
    "提示：导入只建立课程索引。课程段可以永远不匹配任何真题（合法状态）；" +
      "对应关系必须人工核验后用 `pnpm course:link` 建立。",
  );
}

function main(): void {
  const { commit, json, only } = parseArgs(process.argv.slice(2));

  /*
   * ── 只读路径与写入路径在这里**分岔**（本次修复的核心）──
   *
   * 早先无论是否 `--commit` 都先调 `getRepositories()`，而它经由
   * `getDb()` → `openDatabase()` 执行 PRAGMA + 建表 + 迁移 + 写
   * `schema_meta.schema_version`。**打开本身就是写** ——
   * 于是一条自称"预演（dry-run，不写数据库）"的命令会在 v8 库上把它迁移掉。
   *
   * 现在：
   * - 未 `--commit` ⇒ `getReadOnlyRepositories()`（只读连接，迁移在原理上不可达）；
   * - `--commit`    ⇒ `getRepositories()`（显式请求数据库变更，有权触发迁移）。
   *
   * 这不是"打开之后小心别写"，而是**只读路径不具备写入能力**。
   */
  const repos = commit ? getRepositories() : getReadOnlyRepositories();

  const plan = planCourseImport(repos, { only: only.length > 0 ? only : undefined });

  if (json) {
    if (commit) {
      const result = commitCourseImport(repos, plan);
      console.log(JSON.stringify({ dryRun: false, ...result }, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    console.log(
      JSON.stringify(
        { dryRun: true, schemaWrite: false, ok: true, report: plan.report, written: 0, error: null },
        null,
        2,
      ),
    );
    return;
  }

  if (!commit) {
    printReport(plan.report, false, 0);
    return;
  }

  const result = commitCourseImport(repos, plan);
  printReport(result.report, true, result.written);

  if (!result.ok) {
    console.error("");
    console.error(`导入失败：${result.error}`);
    process.exitCode = 1;
  }
}

main();
