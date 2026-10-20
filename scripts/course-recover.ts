#!/usr/bin/env node
/**
 * `pnpm course:recover` —— **A3 可执行恢复**（默认预演，真还原须单独授权）。
 *
 * ── 为什么需要这个入口 ──
 *
 * 上一轮交付了"备份的创建与可读回验证"，但 使用者 **没有一条能真的执行**的
 * 恢复路径 —— 一份谁也还原不了的备份不是恢复点。本命令补上那条路径。
 *
 * ── 两条不可动摇的边界 ──
 *
 * | 边界 | 结构性保证 |
 * | --- | --- |
 * | **默认预演，零写入** | 不加 `--commit` 时只列"会还原什么/会失去什么" |
 * | **还原须单独授权** | `--commit` 是**独立于** `course:a3` 导入批准的一次新决定 |
 *
 * ── 它**不**声称什么 ──
 *
 * 数据库与 `courses/` **不是**同一个事务。因此执行前会先保存"还原前状态"，
 * 失败时逐项报告哪一项还原了、哪一项没有，并指出如何回到原处。
 *
 * 用法：
 *   pnpm course:recover --backup <备份目录>              预演（默认，零写入）
 *   pnpm course:recover --backup <dir> --commit --confirm-restore
 *                                                        真正执行还原
 *   pnpm course:recover --list                           列出可用备份
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { getDbFile } from "@/db/client";
import { getContentRoot, getCoursesDir } from "@/content/paper/paths";
import { backupDirNameOf } from "@/services/course-a3";
import {
  executeRestore,
  inspectBackup,
  previewRestore,
  type BackupInspection,
} from "@/services/course-recovery";

interface Args {
  backupDir: string | null;
  commit: boolean;
  confirmRestore: boolean;
  list: boolean;
  preRestoreDir: string | null;
  json: boolean;
}

function argValue(flag: string): string | null {
  const index = process.argv.indexOf(flag);
  if (index < 0 || index + 1 >= process.argv.length) return null;
  const value = process.argv[index + 1];
  return value.startsWith("--") ? null : value;
}

function parseArgs(): Args {
  return {
    backupDir: argValue("--backup"),
    commit: process.argv.includes("--commit"),
    confirmRestore: process.argv.includes("--confirm-restore"),
    list: process.argv.includes("--list"),
    preRestoreDir: argValue("--pre-restore-dir"),
    json: process.argv.includes("--json"),
  };
}

/** 备份根目录（与 `runGuardedImport` 写出位置一致：`<内容根>/a3-backups`）。 */
function backupRootOf(): string {
  return resolve(getCoursesDir(), "..", "a3-backups");
}

function describeInspection(inspection: BackupInspection): void {
  console.log(`  备份目录：${labelOf(inspection.backupDir)}`);
  if (inspection.database !== null) {
    const v = inspection.database.verification;
    console.log(
      `  数据库快照：${inspection.database.fileName}（${inspection.database.bytes} 字节，sha256 ${inspection.database.sha256.slice(0, 12)}…）`,
    );
    console.log(
      `    schema v${v.schemaVersion ?? "?"} · 课程包 ${v.coursePackageCount ?? "（表不存在）"} · 链接行 ${v.courseLinkCount ?? "（表不存在）"} → ${v.ok ? "可读回 ✓" : "不可用 ✗"}`,
    );
  } else {
    console.log("  数据库快照：没有（这次备份未涉及数据库）");
  }
  if (inspection.content !== null) {
    const c = inspection.content.verification;
    console.log(`  内容快照：${inspection.content.dirName}（${c.fileCount} 个文件 / ${c.totalBytes} 字节）`);
    console.log(
      `    完整性：${c.ok ? "逐文件 sha256 与清单一致 ✓" : `不一致 ✗（${c.error ?? ""}）`}`,
    );
  } else {
    console.log("  内容快照：没有（这次备份未涉及课程内容）");
  }
  if (!inspection.usable) {
    console.log("  结论：**不可作为恢复点**");
    for (const problem of inspection.problems) console.log(`    · ${problem}`);
  } else {
    console.log("  结论：可作为恢复点 ✓");
  }
}

/** 只显示末几段路径（**绝不打印绝对路径**）。 */
function labelOf(absolutePath: string): string {
  return absolutePath.split(/[\\/]/).filter((part) => part !== "").slice(-3).join("/") + "/";
}

function listBackups(): void {
  const root = backupRootOf();
  console.log("CET-6 Coach · A3 可用备份");
  console.log(`备份根：${labelOf(root)}`);
  console.log("");
  if (!existsSync(root)) {
    console.log("还没有任何 A3 备份（目录尚未创建）。");
    return;
  }
  const dirs = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(root, entry.name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

  if (dirs.length === 0) {
    console.log("还没有任何 A3 备份。");
    return;
  }
  for (const dir of dirs) {
    const inspection = inspectBackup(dir);
    console.log(`· ${dir.split(/[\\/]/).slice(-1)[0]}  ${inspection.usable ? "✓ 可用" : "✗ 不可用"}`);
    if (!inspection.usable) {
      for (const problem of inspection.problems) console.log(`    ${problem}`);
    }
  }
}

function main(): void {
  const args = parseArgs();

  if (args.list) {
    listBackups();
    return;
  }

  if (args.backupDir === null) {
    console.error("用法: pnpm course:recover --backup <备份目录> [--commit --confirm-restore]");
    console.error("      pnpm course:recover --list");
    console.error("");
    console.error("  不加 --commit 时是**预演**：只列会还原什么，零写入。");
    console.error("  --commit 需要同时给 --confirm-restore —— 那是**独立于**导入批准的一次新授权。");
    process.exitCode = 2;
    return;
  }

  const backupDir = resolve(args.backupDir);
  const dbFile = getDbFile();
  const contentRoot = getContentRoot();

  console.log("CET-6 Coach · A3 恢复");
  console.log("");

  const inspection = inspectBackup(backupDir);
  console.log("一、备份完整性");
  describeInspection(inspection);
  console.log("");

  const preview = previewRestore({ backupDir, dbFile, contentRoot });
  console.log("二、恢复预演");
  console.log(`  目标库版本：v${preview.targetSchemaVersion ?? "?"}`);
  console.log(`  当前库版本：v${preview.current.schemaVersion ?? "?"}`);
  console.log(
    `  将还原的课程包：${
      preview.targetCoursePackages.length === 0
        ? "（没有）"
        : preview.targetCoursePackages.map((p) => `${p.id}@v${p.contentVersion}`).join("、")
    }`,
  );
  console.log(
    `  当前已有的课程包：${
      preview.current.coursePackages.length === 0
        ? "（没有）"
        : preview.current.coursePackages.map((p) => `${p.id}@v${p.contentVersion}`).join("、")
    }`,
  );
  console.log(`  链接行：快照 ${preview.targetLinkCount ?? "?"} · 当前 ${preview.current.linkCount ?? "?"}`);
  if (preview.targetContent !== null) {
    console.log(
      `  内容快照：${preview.targetContent.fileCount} 个文件 / ${preview.targetContent.totalBytes} 字节` +
        `（课程：${preview.targetContent.courses.join("、") || "无"}）`,
    );
  }
  console.log("");
  console.log("  会写入的位置：");
  for (const target of preview.writeTargets) console.log(`    · ${target}`);
  console.log("");
  console.log("  执行前会先保存**还原前状态**（因此一次半完成的恢复可以回退）。");
  console.log("  说明：数据库与课程内容**不是**同一个事务 —— 本命令不会声称整体原子性。");
  console.log("");

  if (!preview.ok) {
    console.log("三、结论");
    console.log("  **拒绝恢复**：");
    for (const reason of preview.blockedReasons) console.log(`    · ${reason}`);
    process.exitCode = 1;
    return;
  }

  if (!args.commit) {
    console.log("三、结论");
    console.log("  这是预演（**没有写任何东西**）。");
    console.log("  确认无误后执行：");
    console.log(
      `    pnpm course:recover --backup "${args.backupDir}" --commit --confirm-restore`,
    );
    return;
  }

  if (!args.confirmRestore) {
    console.log("三、结论");
    console.log("  **拒绝执行**：--commit 需要同时给 --confirm-restore。");
    console.log("  那是**独立于** A3 导入批准的一次新授权 —— 恢复会覆盖当前的数据库与课程内容。");
    process.exitCode = 1;
    return;
  }

  const preRestoreDir = args.preRestoreDir ?? join(backupRootOf(), `pre-restore-${backupDirNameOf()}`);
  console.log("三、执行恢复");
  const result = executeRestore({ backupDir, dbFile, contentRoot, confirmed: true, preRestoreDir });

  console.log(
    `  数据库：${result.database.restored ? "已还原" : "未还原"} —— ${result.database.detail}`,
  );
  console.log(`  课程内容：${result.content.restored ? "已还原" : "未还原"} —— ${result.content.detail}`);
  if (result.database.preRestoreBackup !== null) {
    console.log(`  还原前数据库快照：${result.database.preRestoreBackup}`);
  }
  if (result.content.preRestoreBackup !== null) {
    console.log(`  还原前内容快照：${result.content.preRestoreBackup}`);
  }
  if (result.recoveryNote !== null) {
    console.log("");
    console.log(`  ${result.recoveryNote}`);
  }
  console.log("");
  if (result.ok) {
    console.log("结果：PASS（逐项结果见上；两者不是同一个事务）");
  } else {
    console.error(`结果：FAIL —— ${result.error ?? "未知原因"}`);
    process.exitCode = 1;
  }
}

main();
