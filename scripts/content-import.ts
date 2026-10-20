#!/usr/bin/env node
/**
 * `pnpm content:import` —— 把私有内容库中的试卷包写入索引。
 *
 * 默认是 **dry-run**：只打印会发生什么，不写数据库。
 * 加 `--commit` 才真正写入 —— 顺序刻意为"先看后写"，
 * 因为导入的后果（新增 / 版本升级 / 拒绝）用户必须有机会先看清楚。
 *
 * 用法：
 *   pnpm content:import                    预演全部包
 *   pnpm content:import --commit           真正导入全部包
 *   pnpm content:import <dir> --commit     只导入指定包目录
 *   pnpm content:import --json             以 JSON 输出报告（便于脚本消费）
 */

import { getRepositories } from "@/repositories/sqlite";
import { planImport, commitImport, type ImportReport } from "@/services/paper-import";

function parseArgs(argv: string[]): { commit: boolean; json: boolean; only: string[] } {
  const commit = argv.includes("--commit");
  const json = argv.includes("--json");
  const only = argv.filter((arg) => !arg.startsWith("--"));
  return { commit, json, only };
}

function printReport(report: ImportReport, commit: boolean, written: number): void {
  console.log("CET-6 Coach · 真题导入");
  console.log(`内容根：${report.contentRoot}`);
  console.log(`试卷目录：${report.papersDir}`);
  console.log(`模式：${commit ? "写入（--commit）" : "预演（dry-run，不写数据库）"}`);
  console.log("");

  if (report.discovered === 0) {
    console.log("0 份试卷包被发现。");
    console.log("把试卷包放到上面的目录里（每个包一个子目录，内含 paper.json 与 assets/）。");
    console.log("");
    console.log("结果：无事可做（内容库为空是合法状态）");
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
    console.log(`    ${entry.detail}`);
    for (const issue of entry.issues) console.log(`    ${issue.path}: ${issue.message}`);
    for (const warning of entry.warnings) console.log(`    ! ${warning}`);
  }

  console.log("");
  console.log(
    `发现 ${report.discovered} 份：新增 ${report.counts.insert} · 升级 ${report.counts.update} · ` +
      `仅元数据 ${report.counts.metadataOnly} · 已最新 ${report.counts.unchanged} · 拒绝 ${report.counts.rejected}`,
  );

  if (commit) {
    console.log(`已写入 ${written} 份试卷索引（同一年同一场次同一套卷只允许一条记录）。`);
    console.log("");
    console.log("结果：PASS");
  } else {
    console.log("");
    if (report.counts.insert === 0 && report.counts.update === 0) {
      console.log("没有需要写入的内容（加 --commit 也是空操作）。");
    } else {
      console.log("这是预演。确认无误后加 --commit 真正写入。");
    }
    if (report.counts.rejected > 0) {
      console.log(`注意：${report.counts.rejected} 份因校验或版本冲突被拒绝，它们不会被部分导入。`);
    }
  }
}

function main(): void {
  const { commit, json, only } = parseArgs(process.argv.slice(2));
  const repos = getRepositories();

  const plan = planImport(repos, { only: only.length > 0 ? only : undefined });

  if (json) {
    // 机器可读输出用于验证脚本；dry-run 与 commit 共用一个报告结构
    if (commit) {
      const result = commitImport(repos, plan);
      console.log(JSON.stringify({ dryRun: false, ...result }, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify({ dryRun: true, ok: true, report: plan.report, written: 0, error: null }, null, 2));
    return;
  }

  if (!commit) {
    printReport(plan.report, false, 0);
    return;
  }

  const result = commitImport(repos, plan);
  printReport(result.report, true, result.written);

  if (!result.ok) {
    console.error("");
    console.error(`导入失败：${result.error}`);
    process.exitCode = 1;
  }
}

main();
