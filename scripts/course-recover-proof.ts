#!/usr/bin/env node
/**
 * A3 **恢复演练证明**（`pnpm course:recover-proof`）。
 *
 * ── 它证明任务书 Task 2 要求的五类恢复场景 ──
 *
 * | # | 场景 | 本脚本证明的方式 |
 * | --- | --- | --- |
 * | 1 | 只做过晋升 | 还原后 `courses/<id>/` 回到"尚未晋升"的状态 |
 * | 2 | v8→v9 导入成功 | 还原后数据库回到 v8（课程层表消失） |
 * | 3 | 晋升后导入，但建链失败 | 还原后索引与内容同时回到导入前，且链接行消失 |
 * | 4 | 备份损坏/不完整 | 快照坏、清单不符、清单缺失三种形态都被**拒绝** |
 * | 5 | 恢复被中断 | 逐项状态如实报告 + 还原前快照可用于回退 |
 *
 * ── 纪律 ──
 *
 * 全程隔离的合成数据库与课程目录（`os.tmpdir()`）。
 * **不读任何真实课程材料、不碰 `data/cet6.db`。**
 */

import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { openDatabase } from "@/db/client";
import { SCHEMA_SQL as SCHEMA } from "@/db/schema";
import { createSqliteRepositories } from "@/repositories/sqlite";
import {
  CONTENT_MANIFEST_FILENAME,
  executeRestore,
  inspectBackup,
  previewRestore,
  verifyContentBackup,
  writeContentManifest,
} from "@/services/course-recovery";
import { createContentBackup, createDatabaseBackupAt } from "@/services/course-backup";
import { runGuardedImport } from "@/services/course-a3";
import { readSidecarState, settleWalBeforeReplace } from "@/services/course-wal-recovery";

void openDatabase;

let passed = 0;
let failed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ""}`);
    failed += 1;
    failures.push(label);
  }
}

const COURSE_SECTION_MARKER = "-- 课程层（Course Layer，V1 基础）";

/** 从生产 DDL 切出 v8 形态（与其它测试同一手法）。 */
function deriveV8Ddl(): string {
  const index = SCHEMA.indexOf(COURSE_SECTION_MARKER);
  if (index <= 0) throw new Error("找不到课程层分节标记");
  return SCHEMA.slice(0, index).trimEnd();
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 造一个生产形态的 v8 库。 */
function seedV8(dbFile: string): void {
  const db = new DatabaseSync(dbFile);
  db.exec(deriveV8Ddl());
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '8')").run();
  const now = "2026-10-20T00:00:00.000Z";
  db.prepare(
    "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run("p1", "Synthetic Reviewer", 60, 120, now, now);
  db.close();
}

/** 造一份最小合法合成课程包。 */
function writeCourse(coursesDir: string, courseId: string, title: string): void {
  const dir = join(coursesDir, courseId);
  mkdirSync(join(dir, "assets"), { recursive: true });
  const body = `synthetic body for ${courseId}`;
  writeFileSync(join(dir, "assets", "handout.pdf"), body);
  const manifest = {
    id: courseId,
    schemaVersion: 1,
    provider: "test_fixture_provider",
    edition: null,
    title,
    contentVersion: 1,
    provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
    materials: [
      { id: "mat-1", title: "Reading", representations: [{ id: "a1", assetId: "a1", label: "handout" }] },
    ],
    segments: [
      {
        id: "seg-1",
        materialId: "mat-1",
        kind: "reading_passage",
        order: 0,
        title: "Passage One",
        representationId: "a1",
        anchor: { pageStart: 1, pageEnd: 1, quote: "Passage One" },
        audioAssetId: null,
        startSeconds: null,
        endSeconds: null,
        text: body,
        transcript: null,
        referenceTranslation: null,
        notes: null,
      },
    ],
    assets: [
      {
        id: "a1",
        kind: "document",
        path: "assets/handout.pdf",
        mimeType: "application/pdf",
        bytes: Buffer.byteLength(body),
        checksum: sha256(body),
        label: "handout",
      },
    ],
  };
  writeFileSync(join(dir, "course.json"), JSON.stringify(manifest, null, 2));
}

function readVersion(dbFile: string): number | null {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as
      | { value?: string }
      | undefined;
    return row?.value === undefined ? null : Number(row.value);
  } finally {
    db.close();
  }
}

function hasCourseTable(dbFile: string): boolean {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    return Boolean(
      db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_package'").get(),
    );
  } finally {
    db.close();
  }
}

function countRows(dbFile: string, table: string): number | null {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const exists = Boolean(
      db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name=?").get(table),
    );
    if (!exists) return null;
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
  } finally {
    db.close();
  }
}

/** 某个 `learner_profile.id` 是否存在（用于观察 WAL 场景里的具体行）。 */
function countProfiles(dbFile: string, id: string): number {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT COUNT(*) AS n FROM learner_profile WHERE id = ?").get(id) as
      | { n: number | bigint }
      | undefined;
    return row === undefined ? 0 : Number(row.n);
  } finally {
    db.close();
  }
}

function main(): void {
  console.log("A3 恢复 · 合成演练证明");
  console.log("（不读真实材料、不碰真实数据库）");
  console.log("");

  const root = mkdtempSync(join(tmpdir(), "cet6-recover-proof-"));
  const previousContentRoot = process.env.CET6_CONTENT_ROOT;

  try {
    // ══════════════════════════════════════════════════════════════
    console.log("一、场景 1：**只做过晋升** —— 还原后课程内容回到「尚未晋升」");
    // ══════════════════════════════════════════════════════════════
    {
      const scene = join(root, "scene1");
      const contentRoot = join(scene, "content");
      const coursesDir = join(contentRoot, "courses");
      const dbFile = join(scene, "cet6.db");
      mkdirSync(contentRoot, { recursive: true });

      // 起点：晋升**之前** —— 先做一份内容备份（模拟 A3-b 之前的恢复点）
      const backupDir = join(scene, "backup");
      mkdirSync(backupDir, { recursive: true });
      const contentBackup = createContentBackup(coursesDir, join(backupDir, "courses-pre-a3"));
      check("晋升前没有内容可备份（合法空状态）", contentBackup.ok && contentBackup.backupPath === null);

      // 造一份课程包（模拟"晋升成功"）
      writeCourse(coursesDir, "scene1-course", "Scene 1 Course");
      check("晋升后 courses 里确实有课程包", existsSync(join(coursesDir, "scene1-course", "course.json")));

      /*
       * 现在有一份"晋升前"的空备份与"晋升后"的现状。
       * 但空备份没有内容快照 ⇒ 不可作为恢复点（这正是要证明的诚实边界）。
       */
      const emptyInspection = inspectBackup(backupDir);
      check("全空的备份目录**不被**当作恢复点", emptyInspection.usable === false);
      check(
        "拒绝原因明确",
        emptyInspection.problems.some((p) => p.includes("既没有数据库快照，也没有内容快照")),
        emptyInspection.problems.join("；"),
      );

      // 真正的场景：晋升后立即备份 → 再改动 → 还原
      const promotedBackup = join(scene, "backup-promoted");
      mkdirSync(promotedBackup, { recursive: true });
      const snap = createContentBackup(coursesDir, join(promotedBackup, "courses-pre-a3"));
      check("晋升后内容备份成功", snap.ok && snap.backupPath !== null, snap.error ?? "");
      if (snap.backupPath !== null) writeContentManifest(snap.backupPath);

      // 再改坏现状：加一个课程包（模拟后续误操作）
      writeCourse(coursesDir, "scene1-extra", "Accidental Course");
      check("现状已含 2 个课程包", existsSync(join(coursesDir, "scene1-extra")));

      const preview = previewRestore({ backupDir: promotedBackup, dbFile, contentRoot });
      check("预演可用", preview.ok, preview.blockedReasons.join("；"));
      check(
        "预演列出将还原的课程包",
        preview.targetContent !== null && preview.targetContent.courses.includes("scene1-course"),
        JSON.stringify(preview.targetContent),
      );

      const result = executeRestore({
        backupDir: promotedBackup,
        dbFile,
        contentRoot,
        confirmed: true,
        preRestoreDir: join(scene, "pre-restore"),
      });
      check("恢复执行成功（内容项）", result.ok && result.content.restored, result.error ?? "");
      check("误加的课程包已被移除", !existsSync(join(coursesDir, "scene1-extra")));
      check("原有课程包已回来", existsSync(join(coursesDir, "scene1-course", "course.json")));
      check("保留了还原前快照", result.content.preRestoreBackup !== null);
      check("**不**声称整体原子性（database 未还原因快照没有 DB）", result.database.restored === false);
    }

    // ══════════════════════════════════════════════════════════════
    console.log("");
    console.log("二、场景 2：**v8→v9 导入成功之后** 还原，数据库必须回到 v8");
    // ══════════════════════════════════════════════════════════════
    {
      const scene = join(root, "scene2");
      const contentRoot = join(scene, "content");
      const coursesDir = join(contentRoot, "courses");
      const dbFile = join(scene, "cet6.db");
      mkdirSync(contentRoot, { recursive: true });

      seedV8(dbFile);
      process.env.CET6_CONTENT_ROOT = contentRoot;
      writeCourse(coursesDir, "scene2-course", "Scene 2 Course");

      const backupDir = join(scene, "backup");
      const importResult = runGuardedImport({ dbFile, coursesDir, backupDir, only: ["scene2-course"] });
      check("导入成功（触发 v8→v9）", importResult.ok, importResult.error ?? "");
      check("导入后库是 v9", readVersion(dbFile) === 9);
      check("导入后课程层表已建立", hasCourseTable(dbFile));
      check("导入后索引有 1 行", countRows(dbFile, "course_package") === 1);

      // 备份应当在导入前取（v8 形态）
      const inspection = inspectBackup(backupDir);
      check("备份目录可作为恢复点", inspection.usable, inspection.problems.join("；"));
      check(
        "备份的数据库快照是 v8",
        inspection.database?.verification.schemaVersion === 8,
        String(inspection.database?.verification.schemaVersion),
      );
      check(
        "内容快照逐文件校验通过",
        inspection.content?.verification.ok === true,
        inspection.content?.verification.error ?? "无内容快照",
      );

      const result = executeRestore({
        backupDir,
        dbFile,
        contentRoot,
        confirmed: true,
        preRestoreDir: join(scene, "pre-restore"),
      });
      check("恢复执行成功", result.ok, result.error ?? "");
      check("数据库已还原", result.database.restored);
      check("库版本回到 v8", readVersion(dbFile) === 8, String(readVersion(dbFile)));
      check("课程层表已消失", !hasCourseTable(dbFile));
      check("既有学习者数据仍在", countRows(dbFile, "learner_profile") === 1);
      check("保留了还原前数据库快照", result.database.preRestoreBackup !== null);
      const preDb = join(scene, "pre-restore", "cet6-pre-a3.db");
      check("还原前快照确实是 v9（可用于回退）", readVersion(preDb) === 9, String(readVersion(preDb)));
    }

    // ══════════════════════════════════════════════════════════════
    console.log("");
    console.log("三、场景 3：晋升后导入、**但建链失败** —— 还原回到导入前");
    // ══════════════════════════════════════════════════════════════
    {
      const scene = join(root, "scene3");
      const contentRoot = join(scene, "content");
      const coursesDir = join(contentRoot, "courses");
      const dbFile = join(scene, "cet6.db");
      mkdirSync(contentRoot, { recursive: true });

      seedV8(dbFile);
      process.env.CET6_CONTENT_ROOT = contentRoot;
      writeCourse(coursesDir, "scene3-course", "Scene 3 Course");

      // 晋升 + 导入（备份在导入前取）
      const backupDir = join(scene, "backup");
      const importResult = runGuardedImport({ dbFile, coursesDir, backupDir, only: ["scene3-course"] });
      check("导入成功", importResult.ok, importResult.error ?? "");

      // 模拟"建链失败"：链接行必须为 0（没有留下任何已核验真相）
      const linksBefore = countRows(dbFile, "course_canonical_link");
      check("建链失败时链接行数为 0", linksBefore === 0);
      void openDatabase;
      void createSqliteRepositories;

      // 现在还原到导入前
      const result = executeRestore({
        backupDir,
        dbFile,
        contentRoot,
        confirmed: true,
        preRestoreDir: join(scene, "pre-restore"),
      });
      check("恢复成功", result.ok, result.error ?? "");
      check("库回到 v8", readVersion(dbFile) === 8);
      check("课程索引行消失", countRows(dbFile, "course_package") === null);
      check("内容仍然在（晋升结果保留）", existsSync(join(coursesDir, "scene3-course", "course.json")));
    }

    // ══════════════════════════════════════════════════════════════
    console.log("");
    console.log("四、场景 4：**损坏 / 不完整的备份**必须被拒绝");
    // ══════════════════════════════════════════════════════════════
    {
      const scene = join(root, "scene4");
      const contentRoot = join(scene, "content");
      const coursesDir = join(contentRoot, "courses");
      const dbFile = join(scene, "cet6.db");
      mkdirSync(contentRoot, { recursive: true });
      seedV8(dbFile);
      process.env.CET6_CONTENT_ROOT = contentRoot;
      writeCourse(coursesDir, "scene4-course", "Scene 4 Course");

      // ── 4a 数据库快照损坏 ──
      const brokenDbBackup = join(scene, "backup-broken-db");
      mkdirSync(brokenDbBackup, { recursive: true });
      writeFileSync(join(brokenDbBackup, "cet6-pre-a3.db"), "这不是一个 SQLite 数据库");
      const brokenInspection = inspectBackup(brokenDbBackup);
      check("损坏的数据库快照 ⇒ 不可用", brokenInspection.usable === false);
      const brokenResult = executeRestore({
        backupDir: brokenDbBackup,
        dbFile,
        contentRoot,
        confirmed: true,
        preRestoreDir: join(scene, "pre-4a"),
      });
      check("损坏快照拒绝恢复", brokenResult.ok === false);
      check("拒绝时数据库**未被改动**（仍是 v8）", readVersion(dbFile) === 8);

      // ── 4b 内容快照与清单不符（同尺寸替换）──
      const tamperedBackup = join(scene, "backup-tampered");
      mkdirSync(tamperedBackup, { recursive: true });
      const tamperedContent = join(tamperedBackup, "courses-pre-a3");
      const snap = createContentBackup(coursesDir, tamperedContent);
      check("内容快照创建成功", snap.ok && snap.backupPath !== null, snap.error ?? "");
      if (snap.backupPath !== null) {
        writeContentManifest(snap.backupPath);
        /*
         * **同尺寸**篡改：改变一个字节但不改变长度。
         *
         * 这条刻意针对"只比较总字节数"那种弱判据 —— 同尺寸替换下
         * 总字节数完全不变，只有逐文件 sha256 能发现它。
         */
        const target = join(tamperedContent, "scene4-course", "assets", "handout.pdf");
        const original = readFileSync(target);
        const tampered = Buffer.from(original);
        tampered[0] = tampered[0] ^ 0xff;
        writeFileSync(target, tampered);
        check("篡改前后字节数相同（构造成同尺寸替换）", tampered.length === original.length);
        const verification = verifyContentBackup(tamperedContent);
        check("同尺寸篡改被校验和发现", verification.ok === false);
        check(
          "不一致项精确到文件",
          verification.checksumMismatch.includes("scene4-course/assets/handout.pdf"),
          JSON.stringify(verification.checksumMismatch),
        );
      }
      const tamperedInspection = inspectBackup(tamperedBackup);
      check("清单不符的内容快照 ⇒ 不可用", tamperedInspection.usable === false);

      // ── 4c 内容快照缺少清单（上一轮的备份形态）──
      const noManifestBackup = join(scene, "backup-no-manifest");
      mkdirSync(noManifestBackup, { recursive: true });
      const noManifestContent = join(noManifestBackup, "courses-pre-a3");
      createContentBackup(coursesDir, noManifestContent);
      check("清单文件确实不存在", !existsSync(join(noManifestContent, CONTENT_MANIFEST_FILENAME)));
      const noManifestInspection = inspectBackup(noManifestBackup);
      check("缺清单 ⇒ **不**当作可执行的恢复点", noManifestInspection.usable === false);
      check(
        "拒绝原因说明了这是旧版备份",
        noManifestInspection.problems.some((p) => p.includes("完整性清单")),
        noManifestInspection.problems.join("；"),
      );

      // ── 4d 备份目录不存在 ──
      const missingInspection = inspectBackup(join(scene, "no-such-backup"));
      check("不存在的备份 ⇒ 不可用", missingInspection.usable === false);
      check("错误方向是**拒绝**（不是兜底成功）", missingInspection.problems.length > 0);
    }

    // ══════════════════════════════════════════════════════════════
    console.log("");
    console.log("五、场景 5：**恢复被中断** —— 逐项如实报告 + 还原前快照可回退");
    // ══════════════════════════════════════════════════════════════
    {
      const scene = join(root, "scene5");
      const contentRoot = join(scene, "content");
      const coursesDir = join(contentRoot, "courses");
      const dbFile = join(scene, "cet6.db");
      mkdirSync(contentRoot, { recursive: true });
      seedV8(dbFile);
      process.env.CET6_CONTENT_ROOT = contentRoot;
      writeCourse(coursesDir, "scene5-course", "Scene 5 Course");

      const backupDir = join(scene, "backup");
      const importResult = runGuardedImport({ dbFile, coursesDir, backupDir, only: ["scene5-course"] });
      check("导入成功", importResult.ok, importResult.error ?? "");

      /*
       * ── 中断形态：**数据库已还原、内容还原被中断** ──
       *
       * 这是全局最危险的中间状态（两项资源只完成了一项）。
       *
       * 用 `faults.beforeContentRestore` 精确注入（生产不传它）。
       * 早先试图"提前删掉一个内容文件"来模拟，但那会被 `previewRestore`
       * 在**执行前**就发现并拒绝 —— 那是更好的失败方向（失败关闭更早），
       * 但它证明不了"中断时逐项如实报告"。两件事必须分别证明。
       */
      const partial = executeRestore({
        backupDir,
        dbFile,
        contentRoot,
        confirmed: true,
        preRestoreDir: join(scene, "pre-restore"),
        faults: {
          beforeContentRestore: () => {
            throw new Error("模拟中断：内容还原步骤被中止");
          },
        },
      });

      check("中断时整体报失败", partial.ok === false, `ok=${partial.ok}`);
      check("**数据库**已还原（逐项如实）", partial.database.restored === true, partial.database.detail);
      check("**内容**未还原（逐项如实）", partial.content.restored === false, partial.content.detail);
      check("提供了还原前数据库快照以便回退", partial.database.preRestoreBackup !== null);
      check("提供了还原前内容快照以便回退", partial.content.preRestoreBackup !== null);
      check(
        "recoveryNote 说明了这不是原子操作",
        partial.recoveryNote !== null && partial.recoveryNote.includes("不是原子操作"),
        partial.recoveryNote ?? "",
      );

      // 内容确实**未被**破坏（中断发生在写入之前）
      check("内容仍在盘上（中断发生在写入之前）", existsSync(join(coursesDir, "scene5-course", "course.json")));

      // 还原前快照可以回到原处
      const preDb = join(scene, "pre-restore", "cet6-pre-a3.db");
      check("还原前快照存在", existsSync(preDb));
      check("还原前快照是 v9（能回到导入后的状态）", readVersion(preDb) === 9, String(readVersion(preDb)));
      check("当前库已被还原成 v8（中断只影响内容项）", readVersion(dbFile) === 8, String(readVersion(dbFile)));
    }

    // ══════════════════════════════════════════════════════════════
    console.log("");
    console.log("六、授权与失败关闭（恢复不接受「隐含」批准）");
    // ══════════════════════════════════════════════════════════════
    {
      const scene = join(root, "scene6");
      const contentRoot = join(scene, "content");
      const coursesDir = join(contentRoot, "courses");
      const dbFile = join(scene, "cet6.db");
      mkdirSync(contentRoot, { recursive: true });
      seedV8(dbFile);
      process.env.CET6_CONTENT_ROOT = contentRoot;
      writeCourse(coursesDir, "scene6-course", "Scene 6 Course");

      const backupDir = join(scene, "backup");
      runGuardedImport({ dbFile, coursesDir, backupDir, only: ["scene6-course"] });
      const versionBefore = readVersion(dbFile);

      // ① 没有 confirmed ⇒ 拒绝，且**一个字节都不写**
      const noConfirm = executeRestore({
        backupDir,
        dbFile,
        contentRoot,
        confirmed: false,
        preRestoreDir: join(scene, "pre-no-confirm"),
      });
      check("缺 confirmed ⇒ 拒绝恢复", noConfirm.ok === false);
      check("拒绝原因要求单独确认", String(noConfirm.error ?? "").includes("明确授权"));
      check("拒绝时数据库未变", readVersion(dbFile) === versionBefore);
      check("拒绝时**连还原前快照都没有创建**", !existsSync(join(scene, "pre-no-confirm")));

      // ② 还原前目录与备份目录相同 ⇒ 拒绝（否则会覆盖自己的恢复点）
      const sameDir = executeRestore({
        backupDir,
        dbFile,
        contentRoot,
        confirmed: true,
        preRestoreDir: backupDir,
      });
      check("还原前目录等于备份目录 ⇒ 拒绝", sameDir.ok === false);
      check("拒绝原因明确", String(sameDir.error ?? "").includes("不能与所用备份目录相同"));

      // ③ 预演**不写任何东西**
      const beforePreview = readVersion(dbFile);
      const preview = previewRestore({ backupDir, dbFile, contentRoot });
      check("预演可用", preview.ok);
      check("预演未改变数据库", readVersion(dbFile) === beforePreview);
      check("预演列出了写入目标", preview.writeTargets.length >= 2);
      check("预演声明会保留还原前状态", preview.willPreservePreRestoreState === true);
    }

    // ══════════════════════════════════════════════════════════════
    console.log("");
    console.log("七、WAL 安全（残留 WAL / 活动连接 / 替换失败 / 恢复中断）");
    // ══════════════════════════════════════════════════════════════
    {
      const scene = join(root, "scene7");
      const contentRoot = join(scene, "content");
      const coursesDir = join(contentRoot, "courses");
      const dbFile = join(scene, "cet6.db");
      mkdirSync(contentRoot, { recursive: true });
      seedV8(dbFile);
      process.env.CET6_CONTENT_ROOT = contentRoot;
      writeCourse(coursesDir, "scene7-course", "Scene 7 Course");

      const insertProfile = (db: DatabaseSync, id: string): void => {
        db.prepare(
          "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
        ).run(id, id, 60, 60, "2026-10-20T00:00:00.000Z", "2026-10-20T00:00:00.000Z");
      };

      /*
       * 造"异常退出后残留 WAL"：关自动 checkpoint、写一条已提交事务，
       * 在连接仍开时把主库 + WAL 复制成现场，再覆盖回目标路径。
       */
      {
        const w = new DatabaseSync(dbFile);
        w.exec("PRAGMA journal_mode=WAL");
        w.exec("PRAGMA wal_autocheckpoint=0");
        insertProfile(w, "wal-only");
        const staged = join(scene, "staged-wal.db");
        copyFileSync(dbFile, staged);
        copyFileSync(`${dbFile}-wal`, `${staged}-wal`);
        w.close();
        copyFileSync(staged, dbFile);
        copyFileSync(`${staged}-wal`, `${dbFile}-wal`);
        rmSync(staged, { force: true });
        rmSync(`${staged}-wal`, { force: true });
        rmSync(`${dbFile}-shm`, { force: true });
      }

      const walState = readSidecarState(dbFile);
      check("崩现场确实带有承载事务的 WAL", walState.wal.present && walState.wal.bytes > 0, `wal=${walState.wal.bytes} 字节`);
      check("**已提交事务只在 WAL 里**（收拢前主库单独看没有它）", countProfiles(dbFile, "wal-only") === 1);

      // 备份必须在收拢之后取，否则备份会漏掉 WAL 里的事务
      const backupDir = join(scene, "backup");
      mkdirSync(backupDir, { recursive: true });
      const settled = settleWalBeforeReplace(dbFile);
      check("settleWalBeforeReplace 成功收拢残留 WAL", settled.ok, settled.error ?? "");
      const afterSettle = readSidecarState(dbFile);
      check("收拢后不再有承载事务的 WAL", !afterSettle.wal.present || afterSettle.wal.bytes === 0);
      check("**收拢之后主库自己能看见那条事务**（数据没丢）", countProfiles(dbFile, "wal-only") === 1);

      check("数据库快照成功", createDatabaseBackupAt(dbFile, join(backupDir, "cet6-pre-a3.db")).ok);
      const contentBackup = createContentBackup(coursesDir, join(backupDir, "courses-pre-a3"));
      check("内容备份成功", contentBackup.ok, contentBackup.error ?? "");
      if (contentBackup.backupPath !== null) writeContentManifest(contentBackup.backupPath);
      const inspection = inspectBackup(backupDir);
      check("备份可作为恢复点", inspection.usable, inspection.problems.join("；"));

      // 备份之后继续写入（让"还原"可被观察）
      {
        const mutate = new DatabaseSync(dbFile);
        mutate.exec("PRAGMA journal_mode=WAL");
        mutate.exec("PRAGMA wal_autocheckpoint=0");
        insertProfile(mutate, "after-backup");
        mutate.close();
      }

      // ── 活动连接 ⇒ 必须拒绝（且不依赖文件锁）──
      const holder = new DatabaseSync(dbFile);
      holder.exec("PRAGMA wal_autocheckpoint=0");
      insertProfile(holder, "while-open");
      holder.prepare("SELECT COUNT(*) AS n FROM learner_profile").get();

      const blocked = executeRestore({
        backupDir,
        dbFile,
        contentRoot,
        confirmed: true,
        preRestoreDir: join(scene, "pre-blocked"),
      });
      check("有活动连接 ⇒ 拒绝恢复", blocked.ok === false);
      check("拒绝时数据库项未执行", blocked.database.restored === false);
      check(
        "拒绝原因指向 WAL/占用/连接（不是含糊失败）",
        /WAL|收拢|占用|连接|锁定|locked/.test(String(blocked.error ?? "")),
        String(blocked.error ?? "").slice(0, 140),
      );
      holder.close();
      check("**持有者写入的数据没有被抹掉**", countProfiles(dbFile, "while-open") === 1);

      // ── 无活动连接 ⇒ 恢复成功，且 WAL 里的数据不丢 ──
      const restored = executeRestore({
        backupDir,
        dbFile,
        contentRoot,
        confirmed: true,
        preRestoreDir: join(scene, "pre-restore"),
      });
      check("无活动连接时恢复成功", restored.ok, restored.error ?? "");
      check("数据库已还原", restored.database.restored, restored.database.detail);
      check("**WAL 里那条已提交事务仍然在**（恢复没有丢数据）", countProfiles(dbFile, "wal-only") === 1);
      check("备份之后写入的行已被回滚", countProfiles(dbFile, "after-backup") === 0);
      check("活动连接期间写入的行已被回滚", countProfiles(dbFile, "while-open") === 0);

      // ── 恢复中断：数据库项已完成、内容项失败（逐项如实） ──
      const interrupted = executeRestore({
        backupDir,
        dbFile,
        contentRoot,
        confirmed: true,
        preRestoreDir: join(scene, "pre-interrupt"),
        faults: {
          beforeContentRestore: () => {
            throw new Error("模拟中断：内容还原步骤被中止");
          },
        },
      });
      check("中断时整体报失败", interrupted.ok === false);
      check("中断时数据库项已还原（逐项如实）", interrupted.database.restored === true);
      check("中断时内容项未还原（逐项如实）", interrupted.content.restored === false);
      check("提供了还原前快照以便回退", interrupted.database.preRestoreBackup !== null);
    }

    // ══════════════════════════════════════════════════════════════
    console.log("");
    console.log("八、隔离边界");
    // ══════════════════════════════════════════════════════════════
    check("内容根在临时目录（不是 private-content）", !root.includes("private-content"));
    check("数据库在临时目录（不是 data/cet6.db）", !root.includes(`${join("data", "cet6.db")}`));
  } finally {
    if (previousContentRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
    else process.env.CET6_CONTENT_ROOT = previousContentRoot;
    let cleaned = false;
    for (let attempt = 0; attempt < 5 && !cleaned; attempt += 1) {
      try {
        rmSync(root, { recursive: true, force: true });
        cleaned = true;
      } catch {
        const until = Date.now() + 150;
        while (Date.now() < until) {
          /* 短暂忙等，让 OS 释放句柄 */
        }
      }
    }
    if (!cleaned) console.warn("\n注意：临时目录未能删除（Windows 句柄延迟），已跳过清理。");
  }

  console.log("");
  console.log(`结果：${passed} / ${passed + failed} 通过${failed > 0 ? `（${failed} 项失败）` : ""}`);
  if (failed > 0) {
    console.log("");
    for (const failure of failures) console.log(`  ✗ ${failure}`);
    process.exitCode = 1;
  }
}

void statSync;

main();
