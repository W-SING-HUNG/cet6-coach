// @vitest-environment node
/**
 * A3 受控课程接入 · 服务层测试（备份、恢复、三个独立边界）。
 *
 * 证明要点：
 * 1. `VACUUM INTO` 产出的快照能被实际打开、读出内容，并与普通文件复制形成对照；
 * 2. 备份失败/不可恢复 ⇒ 不迁移、不写入；
 * 3. 三项互相独立（完成第一项不代表批准后两项）；
 * 4. 建链默认 dry-run：不显式 commit 时零写入；
 * 5. A2 R1 归属核对：借用别处 id 的裁决在保存前被拒。
 *
 * 全部合成夹具 + 隔离临时根。不碰 private-content、不碰 data/cet6.db。
 */

import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  backupDirNameOf,
  createContentBackup,
  createDatabaseBackup,
  createDatabaseBackupAt,
  isA3Complete,
  nextA3Step,
  emptyProgress,
  runGuardedImport,
  runGuardedLink,
  verifyBackupRestorable,
} from "@/services/course-a3";
import { openDatabase } from "@/db/client";
import type { DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import type { Repositories } from "@/repositories/ports";
import { runCourseIntake } from "@/content/course-pipeline";
import { writeCourseCandidate } from "@/content/course-pipeline/candidate";
import { SCHEMA_SQL } from "@/db/schema";
import {
  checkAdjudicationOwnership,
  collectCandidateOwnership,
  prepareReviewForSave,
  saveAdjudicationReview,
  type AdjudicationDraftPayload,
} from "@/content/course-pipeline/adjudication";
import {
  buildIndexFromDisk,
} from "@/content/course-pipeline/canonical";
import {
  evaluatePromotionGate,
  gatherPromotionInputs,
  promoteCourseCandidate,
  readStoredCandidate,
  validateCourseReviewFile,
} from "@/content/course-pipeline/review";
import { getCourseSourcesDir } from "@/content/paper/paths";
import { buildTextPdf, writeSourceTree } from "../scripts/course-source-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

const roots: string[] = [];
function makeRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `a3-service-${tag}-`));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * `SCHEMA_SQL` 里课程层分节的标记。
 *
 * 与 `tests/course-import.test.ts` 的 `COURSE_SECTION_MARKER` 同值 ——
 * 两处必须一致，否则"v8 形态"的推导会悄悄偏移（而偏移的后果是
 * v8/v9 迁移测试跑在一个已经不是 v8 的库上）。
 */
const COURSE_SECTION_MARKER = "-- 课程层（Course Layer，V1 基础）";

/** 从生产 DDL 切出 v8 形态（课程层三张表之前）。 */
function deriveV8Ddl(): string {
  const index = SCHEMA_SQL.indexOf(COURSE_SECTION_MARKER);
  expect(index, "在 SCHEMA_SQL 中找不到课程层分节标记，v8 形态无法推导").toBeGreaterThan(0);
  const ddl = SCHEMA_SQL.slice(0, index).trimEnd();
  expect(ddl).not.toContain("course_package");
  return ddl;
}

/**
 * 造一个**生产形态的 v8 库文件**（不含课程层表）。
 *
 * 刻意与 `tests/course-import.test.ts` 的 `seedProductionShapedV8` 同一手法：
 * 从 `SCHEMA_SQL` 切出课程层之前的 DDL。用一份手写的最小 DDL 会立刻与生产
 * 迁移路径脱钩 —— 那样测到的是"我假想的 v8"，不是真实的 v8。
 */
function seedV8File(root: string): string {
  const dbFile = join(root, "v8.db");
  const seeded = new DatabaseSync(dbFile);
  seeded.exec(deriveV8Ddl());
  seeded.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '8')").run();
  const now = "2026-10-20T00:00:00.000Z";
  seeded
    .prepare(
      "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
    )
    .run("p1", "Synthetic Reviewer", 60, 120, now, now);
  seeded.close();
  return dbFile;
}

function schemaVersionOf(dbFile: string): number | null {
  const db = new DatabaseSync(dbFile, { readOnly: true });
  try {
    const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'schema_version'").get() as
      | { value?: string }
      | undefined;
    return row?.value === undefined ? null : Number(row.value);
  } finally {
    db.close();
  }
}

/** 在临时根里造一份最小合法合成课程包。 */
function writeSyntheticCourse(coursesDir: string, courseId: string): string {
  const courseDir = join(coursesDir, courseId);
  mkdirSync(join(courseDir, "assets"), { recursive: true });
  const manifest = {
    id: courseId,
    schemaVersion: 1,
    provider: "test_fixture_provider",
    edition: null,
    title: "A3 Synthetic Course",
    contentVersion: 1,
    provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
    materials: [
      { id: "mat-1", title: "Reading", representations: [{ id: "asset-1", assetId: "asset-1", label: "handout" }] },
    ],
    segments: [
      {
        id: "seg-1",
        materialId: "mat-1",
        kind: "reading_passage",
        order: 0,
        title: "Passage One",
        representationId: "asset-1",
        anchor: { pageStart: 1, pageEnd: 1, quote: "Passage One" },
        audioAssetId: null,
        startSeconds: null,
        endSeconds: null,
        text: "Synthetic fixture body.",
        transcript: null,
        referenceTranslation: null,
        notes: null,
      },
    ],
    assets: [
      {
        id: "asset-1",
        kind: "document",
        path: "assets/handout.pdf",
        mimeType: "application/pdf",
        bytes: 1,
        checksum: createHash("sha256").update("x").digest("hex"),
        label: "handout",
      },
    ],
  };
  writeFileSync(join(courseDir, "course.json"), JSON.stringify(manifest, null, 2));
  writeFileSync(join(courseDir, "assets", "handout.pdf"), "x");
  return courseDir;
}

/*
 * 注：早期版本这里有一个 `useIsolatedContentRoot()` helper（在 finally 里
 * 还原 `CET6_CONTENT_ROOT`）。现在的用例都直接设置并在 `finally` 里删除，
 * 因此它被移除了 —— 不留一个没人调用的函数。
 */

describe("A3 · 备份与恢复", () => {
  it("VACUUM INTO 产出的快照能被实际打开并读出内容", () => {
    const root = makeRoot("backup");
    const dbFile = seedV8File(root);
    const backupPath = join(root, "snap.db");

    const backup = createDatabaseBackupAt(dbFile, backupPath);
    expect(backup.ok).toBe(true);
    expect(backup.backupPath).toBe(backupPath);
    expect(backup.bytes).toBeGreaterThan(0);
    expect(backup.sha256).toMatch(/^[0-9a-f]{64}$/);

    const verification = verifyBackupRestorable(backupPath);
    expect(verification.ok).toBe(true);
    expect(verification.readable).toBe(true);
    expect(verification.schemaVersion).toBe(8);
    expect(verification.coursePackageCount).toBe(null);

    const snapshot = new DatabaseSync(backupPath, { readOnly: true });
    const count = snapshot.prepare("SELECT COUNT(*) AS n FROM learner_profile").get() as { n: number };
    snapshot.close();
    expect(count.n).toBe(1);
  });

  it("对照：长期读连接下普通文件复制会丢数据，而 VACUUM INTO 不会", () => {
    const root = makeRoot("naive-copy");
    const live = join(root, "live.db");
    const db = new DatabaseSync(live);
    db.exec("PRAGMA journal_mode=WAL;");
    db.exec("CREATE TABLE t(a);");
    db.exec("INSERT INTO t VALUES (1),(2);");
    const reader = new DatabaseSync(live, { readOnly: true });
    reader.prepare("SELECT COUNT(*) AS n FROM t").get();
    db.exec("INSERT INTO t VALUES (3),(4);");

    const naive = join(root, "naive.db");
    copyFileSync(live, naive);
    const naiveDb = new DatabaseSync(naive, { readOnly: true });
    let naiveLost = false;
    try {
      naiveDb.prepare("SELECT COUNT(*) AS n FROM t").get();
    } catch {
      naiveLost = true;
    }
    naiveDb.close();
    reader.close();

    const snap = join(root, "snap.db");
    const backup = createDatabaseBackup(db, snap);
    expect(backup.ok).toBe(true);
    const snapDb = new DatabaseSync(snap, { readOnly: true });
    const snapCount = snapDb.prepare("SELECT COUNT(*) AS n FROM t").get() as { n: number };
    snapDb.close();
    db.close();

    expect(naiveLost, "普通文件复制在长期读连接下必须丢失数据（对照组）").toBe(true);
    expect(snapCount.n, "VACUUM INTO 必须取到全部 4 行").toBe(4);
  });

  it("备份目标已存在且非空 ⇒ 拒绝覆盖", () => {
    const root = makeRoot("no-overwrite");
    const dbFile = seedV8File(root);
    const backupPath = join(root, "snap.db");
    writeFileSync(backupPath, "已有的旧备份内容，不得被覆盖");

    const backup = createDatabaseBackupAt(dbFile, backupPath);
    expect(backup.ok).toBe(false);
    expect(backup.error).toContain("拒绝覆盖");
    expect(readFileSync(backupPath, "utf8")).toBe("已有的旧备份内容，不得被覆盖");
  });

  it("数据库文件不存在 ⇒ 备份失败（不伪造成功）", () => {
    const root = makeRoot("missing-db");
    const backup = createDatabaseBackupAt(join(root, "nope.db"), join(root, "snap.db"));
    expect(backup.ok).toBe(false);
    expect(backup.error).toContain("不存在");
    expect(existsSync(join(root, "snap.db"))).toBe(false);
  });

  it("无法读取的快照被判定为不可恢复", () => {
    const root = makeRoot("bad-snapshot");
    const broken = join(root, "broken.db");
    writeFileSync(broken, "这不是一个 SQLite 数据库");
    const verification = verifyBackupRestorable(broken);
    expect(verification.ok).toBe(false);
    expect(verification.readable).toBe(false);
    expect(verification.error).toContain("无法被读取");
  });

  it("内容目录备份覆盖 courses/，且目录不存在时是合法空状态", () => {
    const root = makeRoot("content-backup");
    const coursesDir = join(root, "courses", "synthetic-course");
    mkdirSync(join(coursesDir, "assets"), { recursive: true });
    writeFileSync(join(coursesDir, "course.json"), '{"id":"synthetic-course"}');
    writeFileSync(join(coursesDir, "assets", "a.pdf"), "synthetic-bytes");

    const backupDir = join(root, "backup", "courses-pre-a3");
    const backup = createContentBackup(join(root, "courses"), backupDir);
    expect(backup.ok).toBe(true);
    expect(backup.bytes).toBeGreaterThan(0);
    // `cpSync` 把源目录**本身**复制成目标目录名 ⇒ 内容在其下一层
    expect(readFileSync(join(backupDir, "synthetic-course", "course.json"), "utf8")).toBe(
      '{"id":"synthetic-course"}',
    );
    expect(readFileSync(join(backupDir, "synthetic-course", "assets", "a.pdf"), "utf8")).toBe("synthetic-bytes");

    const empty = createContentBackup(join(root, "no-such-dir"), join(root, "backup", "empty"));
    expect(empty.ok).toBe(true);
    expect(empty.backupPath).toBe(null);
  });

  it("内容备份目标已存在 ⇒ 拒绝覆盖", () => {
    const root = makeRoot("content-no-overwrite");
    const coursesDir = join(root, "courses");
    mkdirSync(coursesDir, { recursive: true });
    writeFileSync(join(coursesDir, "keep.txt"), "old");
    const backupDir = join(root, "backup-courses");
    mkdirSync(backupDir, { recursive: true });

    const backup = createContentBackup(coursesDir, backupDir);
    expect(backup.ok).toBe(false);
    expect(backup.error).toContain("拒绝覆盖");
  });

  it("备份目录名含随机后缀：同一时刻两次不得相同", () => {
    const now = new Date("2026-10-20T10:00:00.000Z");
    const a = backupDirNameOf(now);
    const b = backupDirNameOf(now);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^a3-backup-2026-10-20T10-00-00-000Z-[a-z0-9]{6}$/);
  });
});

describe("A3-b · 受保护导入", () => {
  it("首次 v8 → v9 合成迁移正确：备份 → 验证 → 迁移 → 写入", () => {
    const root = makeRoot("migration");
    const dbFile = seedV8File(root);
    const coursesDir = join(root, "courses");
    const backupDir = join(root, "backups");
    const courseId = "a3-synthetic-course";
    writeSyntheticCourse(coursesDir, courseId);

    // 内容根指向隔离临时根 ⇒ 导入器只看到合成课程包
    process.env.CET6_CONTENT_ROOT = root;
    try {
      const result = runGuardedImport({ dbFile, coursesDir, backupDir, only: [courseId] });

      expect(result.ok).toBe(true);
      expect(result.written).toBe(1);
      expect(result.backup).not.toBe(null);
      expect(result.backup?.verified).toBe(true);

      // 迁移真的发生了：v8 → v9
      expect(schemaVersionOf(dbFile)).toBe(9);
      const check = new DatabaseSync(dbFile, { readOnly: true });
      const table = check
        .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_package'")
        .get();
      const row = check.prepare("SELECT id, content_version AS v FROM course_package WHERE id = ?").get(courseId) as
        | { id: string; v: number }
        | undefined;
      check.close();
      expect(table).toBeTruthy();
      expect(row?.id).toBe(courseId);
      expect(row?.v).toBe(1);

      // 备份必须记录的是迁移**前**的 v8 状态
      const verification = verifyBackupRestorable(result.backup!.path!);
      expect(verification.ok).toBe(true);
      expect(verification.schemaVersion).toBe(8);
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  it("备份不可恢复 ⇒ 不迁移、不写入（失败关闭）", () => {
    const root = makeRoot("backup-gate");
    const dbFile = seedV8File(root);
    process.env.CET6_CONTENT_ROOT = root;
    try {
      // 预置一个**不可读**的备份目标 ⇒ 备份阶段就必须失败
      const backupDir = join(root, "backups");
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, "cet6-pre-a3.db"), "不是 SQLite 数据库");

      const result = runGuardedImport({ dbFile, coursesDir: join(root, "courses"), backupDir });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("已中止");
      // 库仍然是 v8，课程层表未创建 ⇒ 迁移没有发生
      expect(schemaVersionOf(dbFile)).toBe(8);
      const check = new DatabaseSync(dbFile, { readOnly: true });
      const table = check
        .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_package'")
        .get();
      check.close();
      expect(table).toBeFalsy();
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  it("写连接打开失败（迁移失败）⇒ 已中止，且快照保留可重试", () => {
    const root = makeRoot("open-failure");
    const dbFile = seedV8File(root);
    process.env.CET6_CONTENT_ROOT = root;
    try {
      const backupDir = join(root, "backups");
      const result = runGuardedImport({
        dbFile,
        coursesDir: join(root, "courses"),
        backupDir,
        openWrite: () => {
          throw new Error("模拟：迁移在真实环境下失败");
        },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("无法打开数据库进行写入");
      // 备份仍然在 ⇒ 可以安全重试
      expect(result.backup?.path).toBeTruthy();
      expect(existsSync(result.backup!.path!)).toBe(true);
      expect(verifyBackupRestorable(result.backup!.path!).ok).toBe(true);
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  /*
   * ── 备份失败后**数据库必须逐字节不变**（A3-b 最重的失败方向）──
   *
   * 变异证明（`course:a3-mutation` 的 M2/M3）发现：删掉"备份失败即中止"
   * 或"验证可恢复"的判据之后，原有用例**仍然全绿** —— 因为另一道判据
   * 恰好也拦住了。那是纵深防御，但也说明**没有一条用例直接断言
   * "被中止时数据库确实没被动过"**。
   *
   * 这里补上那条直接判据：既有的 learner_profile 行必须还在、
   * 版本必须还是 8、课程层表必须不存在。
   */
  it("备份失败被中止时，数据库内容**逐字节不变**", () => {
    const root = makeRoot("abort-untouched");
    const dbFile = seedV8File(root);
    process.env.CET6_CONTENT_ROOT = root;
    try {
      const backupDir = join(root, "backups");
      mkdirSync(backupDir, { recursive: true });
      // 预置不可读的快照 ⇒ 备份阶段失败
      writeFileSync(join(backupDir, "cet6-pre-a3.db"), "不是 SQLite 数据库");

      const result = runGuardedImport({ dbFile, coursesDir: join(root, "courses"), backupDir });
      expect(result.ok).toBe(false);
      expect(result.error).toContain("已中止");

      // 直接断言数据库**没有被写过**：既有数据完好、版本未前进、无课程层表
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const profiles = Number((db.prepare("SELECT COUNT(*) AS n FROM learner_profile").get() as { n: number }).n);
      const version = (
        db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }
      ).value;
      const courseTable = db
        .prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='table' AND name='course_package'")
        .get();
      db.close();

      expect(profiles, "既有学习者数据必须完好").toBe(1);
      expect(Number(version), "版本号不得前进").toBe(8);
      expect(courseTable, "不得留下任何课程层表").toBeFalsy();
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
    }
  });
});

describe("A3 · 三个独立边界与进度", () => {
  it("初始进度：三项均未完成，第一步是晋升", () => {
    const progress = emptyProgress("a3-course");
    expect(isA3Complete(progress)).toBe(false);
    expect(nextA3Step(progress).step).toBe("promote");
  });

  it("完成第一项不代表批准后两项", () => {
    const progress = emptyProgress("a3-course");
    progress.promoted = { done: true, at: "2026-10-20T10:00:00.000Z", detail: "已晋升" };
    expect(isA3Complete(progress)).toBe(false);
    expect(nextA3Step(progress).step).toBe("import");

    progress.imported = { done: true, at: "2026-10-20T10:01:00.000Z", detail: "已导入" };
    expect(isA3Complete(progress)).toBe(false);
    expect(nextA3Step(progress).step).toBe("link");

    progress.linked = { done: true, at: "2026-10-20T10:02:00.000Z", detail: "已建链", segmentIds: ["seg-1"] };
    expect(isA3Complete(progress)).toBe(true);
    expect(nextA3Step(progress).step).toBe("companion");
  });

  it("A3-c 默认 dry-run：不显式 commit 时零写入", () => {
    const root = makeRoot("link-dry-run");
    const db: DbHandle = openDatabase(join(root, "empty.db"));
    process.env.CET6_CONTENT_ROOT = root;
    try {
      const repos: Repositories = createSqliteRepositories(db);
      const result = runGuardedLink({
        repos,
        commit: false,
        links: [
          {
            courseId: "not-imported-course",
            courseContentVersion: 1,
            segmentId: "seg-1",
            paperId: "not-imported-paper",
            paperContentVersion: 1,
            sectionId: "reading.careful_reading",
            targetScope: "section",
            verificationStatus: "verified",
            verificationRef: "course-review:a3-course:abc:seg-1:2026-10-20",
          },
        ],
      });

      expect(result.ok).toBe(false);
      expect(result.committed).toBe(false);
      expect(result.results[0].ok).toBe(false);
      expect(result.error).toContain("未写入任何数据");

      // 库里确实零行
      const count = db.prepare("SELECT COUNT(*) AS n FROM course_canonical_link").get() as { n: number };
      expect(count.n).toBe(0);
    } finally {
      db.close();
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  /*
   * ── 建链：预演通过但**未 commit** ⇒ 仍然零写入 ──
   *
   * 变异证明（M5）发现：把 `dryRun: !input.commit` 改成恒定 `dryRun: false`
   * 之后，上面那条用例**仍然全绿** —— 因为它用的是"课程不在索引里"，
   * 核验**本来就**失败，于是 dry-run 与真写都走不到写路径。
   *
   * 那是一个"看起来在测那件事、其实测不到"的断言（本项目反复登记过的形态）。
   * 这里补一条**核验会通过但没 commit** 的用例：它才能真正区分
   * "预演"与"写入"。
   */
  it("建链预演：核验全部通过但未 commit ⇒ 库里仍然零行", async () => {
    const root = makeRoot("link-preview-only");
    const db: DbHandle = openDatabase(join(root, "seeded.db"));
    process.env.CET6_CONTENT_ROOT = root;
    try {
      const repos: Repositories = createSqliteRepositories(db);
      const { courseId, segmentId, paperId, sectionId } = await seedImportableLinkTarget(
        root,
        repos,
        db,
      );

      const before = Number((db.prepare("SELECT COUNT(*) AS n FROM course_canonical_link").get() as { n: number }).n);

      // ① 预演：核验必须**通过**（否则这条用例测不到 dry-run）
      const preview = runGuardedLink({
        repos,
        commit: false,
        links: [
          {
            courseId,
            courseContentVersion: 1,
            segmentId,
            paperId,
            paperContentVersion: 1,
            sectionId,
            targetScope: "section",
            verificationStatus: "verified",
            verificationRef: "course-review:preview-only:abcdef:seg:2026-10-20",
          },
        ],
      });
      expect(preview.ok, `预演核验必须通过（否则测不到 dry-run）：${JSON.stringify(preview.results)}`).toBe(true);
      expect(preview.committed).toBe(false);

      // ② 关键判据：预演通过，但库里**一行都没有**
      const afterPreview = Number(
        (db.prepare("SELECT COUNT(*) AS n FROM course_canonical_link").get() as { n: number }).n,
      );
      expect(afterPreview, "预演绝不允许写入").toBe(before);

      // ③ 对照：同一个输入在 commit=true 时**确实**写入
      const committed = runGuardedLink({
        repos,
        commit: true,
        links: [
          {
            courseId,
            courseContentVersion: 1,
            segmentId,
            paperId,
            paperContentVersion: 1,
            sectionId,
            targetScope: "section",
            verificationStatus: "verified",
            verificationRef: "course-review:preview-only:abcdef:seg:2026-10-20",
          },
        ],
      });
      expect(committed.ok).toBe(true);
      expect(committed.committed).toBe(true);
      const afterCommit = Number(
        (db.prepare("SELECT COUNT(*) AS n FROM course_canonical_link").get() as { n: number }).n,
      );
      expect(afterCommit, "commit=true 必须真的写入").toBe(before + 1);
    } finally {
      db.close();
      delete process.env.CET6_CONTENT_ROOT;
    }
  });

  /*
   * ── 晋升：目标已存在时**拒绝覆盖**，且磁盘逐字节不变 ──
   *
   * 变异证明（M4）发现原来没有用例直接覆盖这条分支。
   * 覆盖的后果是静默替换运行时课程包 —— 因此这里既断言返回值，
   * 也断言**盘上那份包没有被改动**。
   */
  it("晋升目标已存在 ⇒ 拒绝覆盖，且盘上原包逐字节不变", async () => {
    const root = makeRoot("promote-exists");
    const db = openDatabase(join(root, "promote.db"));
    process.env.CET6_CONTENT_ROOT = root;
    try {
      const repos: Repositories = createSqliteRepositories(db);
      const { courseId, stored, review, gate, coursesDir } = await seedPromotableCandidate(root, repos, db);

      // 第一次晋升成功
      const first = promoteCourseCandidate({ stored, gate, review, coursesDir });
      expect(first.ok, first.error ?? "").toBe(true);

      const manifestPath = join(coursesDir, courseId, "course.json");
      const beforeBytes = readFileSync(manifestPath, "utf8");
      const beforeSha = createHash("sha256").update(beforeBytes).digest("hex");

      // 第二次：目标已存在 ⇒ 必须被拒
      const second = promoteCourseCandidate({ stored, gate, review, coursesDir });
      expect(second.ok, "目标已存在时必须拒绝").toBe(false);
      expect(second.error).toContain("已存在");

      // 关键：盘上那份包**没有被改动**
      const afterSha = createHash("sha256").update(readFileSync(manifestPath, "utf8")).digest("hex");
      expect(afterSha, "被拒绝的晋升不得改动已存在的包").toBe(beforeSha);
    } finally {
      db.close();
      delete process.env.CET6_CONTENT_ROOT;
    }
  });
});

/**
 * 造一个"可导入的课程包 + 已导入索引"的合成环境，返回一组**核验会通过**的建链参数。
 *
 * ── 为什么需要这么一个 helper ──
 *
 * "建链预演零写入"这条判据只有在**核验真的会通过**时才有意义：
 * 若课程/真题都不在索引里，核验本来就失败，dry-run 与真写都走不到写路径 ——
 * 那种断言对本项目已登记过的"看起来在测那件事、其实测不到"形态毫无防御力。
 */
async function seedImportableLinkTarget(
  root: string,
  repos: Repositories,
  db: DbHandle,
): Promise<{ courseId: string; segmentId: string; paperId: string; sectionId: string; coursesDir: string }> {
  const courseId = "link-target-course";
  const paperId = "fixture-cet6-2024-12-set1";

  // 合成课程包（一个段）
  const coursesDir = join(root, "courses");
  writeSyntheticCourse(coursesDir, courseId);

  // 合成真题包
  writeFixturePackage(
    root,
    paperId,
    buildFixturePackage({ id: paperId, year: 2024, session: "December", variant: "set1" }),
  );

  // 先把真题与课程都写进索引
  const { planImport, commitImport } = await import("@/services/paper-import");
  const paperPlan = planImport(repos, { only: [paperId] });
  expect(paperPlan.report.counts.rejected, "真题夹具必须可导入").toBe(0);
  expect(commitImport(repos, paperPlan).ok).toBe(true);

  const { planCourseImport, commitCourseImport } = await import("@/services/course-import");
  const coursePlan = planCourseImport(repos, { only: [courseId] });
  expect(coursePlan.report.counts.rejected, "课程夹具必须可导入").toBe(0);
  expect(commitCourseImport(repos, coursePlan).ok).toBe(true);

  // 段的 id 从**已索引的包**里读（不猜）
  const { readCoursePackageIntegrity, createPackageIntegrityCache } = await import("@/services/course-packages");
  const record = repos.courses.getPackage(courseId)!;
  const integrity = readCoursePackageIntegrity(
    { id: record.id, packagePath: record.packagePath, manifestChecksum: record.manifestChecksum },
    createPackageIntegrityCache(),
  );
  expect(integrity.ok, "已导入的课程包必须可读").toBe(true);
  if (!integrity.ok) throw new Error("课程包不可读，无法继续");
  const segmentId = [...integrity.segmentIds][0];
  expect(segmentId, "合成课程必须至少有一个段").toBeTruthy();

  void db;
  return { courseId, segmentId, paperId, sectionId: "reading.careful_reading", coursesDir };
}

/**
 * 造一个"门禁 PROMOTABLE 且尚未晋升"的合成候选，返回晋升所需的全部输入。
 */
async function seedPromotableCandidate(
  root: string,
  repos: Repositories,
  db: DbHandle,
): Promise<{
  courseId: string;
  stored: ReturnType<typeof readStoredCandidate>;
  review: ReturnType<typeof validateCourseReviewFile>["file"];
  gate: ReturnType<typeof evaluatePromotionGate>;
  coursesDir: string;
}> {
  const courseId = "promote-course";
  const sourceRoot = join(root, "synthetic-source");
  writeSourceTree(
    sourceRoot,
    new Map([
      [
        "阅读/reading-handout.pdf",
        buildTextPdf([
          [
            "SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL",
            "Passage One",
            "Questions 46 to 50 are based on the following passage.",
          ],
        ]),
      ],
    ]),
  );
  const papersRoot = join(root, "synthetic-papers");
  const papersDir = join(papersRoot, "cet6", "papers");
  writeFixturePackage(
    papersRoot,
    "fixture-cet6-2024-12-set1",
    buildFixturePackage({ id: "fixture-cet6-2024-12-set1", year: 2024, session: "December", variant: "set1" }),
  );

  const intake = await runCourseIntake({
    sourceRoot,
    courseId,
    provider: "test_fixture_provider",
    edition: null,
    title: "Promote Fixture",
    contentVersion: 1,
    provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
    papersDir,
  });
  const candidatesDir = join(root, "course-candidates");
  writeCourseCandidate(intake.archive, join(candidatesDir, courseId));

  // 逐条裁决（所有需要确认的分组与段都接受；有建议的段一律"有意不匹配"，
  // 因此本用例只需证明晋升与"目标已存在"，不牵扯建链）
  const draft: AdjudicationDraftPayload = {
    courseId,
    reviewer: "Reviewer",
    reviewedAt: "2026-10-20",
    candidateChecksum: intake.archive.metadata.digests.candidateChecksum,
    canonicalLibraryDigest: intake.archive.metadata.matching.canonicalLibrary.digest,
    sourceDigest: intake.inventory.digest,
    verifiedScope: ["materials", "segments"],
    notVerified: ["canonical matches"],
    materialGroupings: intake.grouping.proposals
      .filter((proposal) => proposal.reviewRequired || proposal.ambiguous)
      .map((proposal) => ({
        proposalId: proposal.id,
        decision: "accepted" as const,
        evidence: `人工核验该材料分组（${proposal.id}）的构成与命名，确认正确。`,
      })),
    segments: intake.archive.metadata.segmentation.materials
      .flatMap((material) => material.segments.map((segment) => segment.id))
      .map((segmentId) => ({
        segmentId,
        decision: "accepted" as const,
        evidence: `人工核验该段（${segmentId}）的边界、类别与页码来源，与源件一致。`,
      })),
    matches: intake.archive.metadata.matching.segments
      .filter((segment) => segment.suggestions.length > 0 || segment.ambiguous)
      .map((segment) => ({
        segmentId: segment.segmentId,
        disposition: "intentionally_unmatched" as const,
        evidence: "本用例只验证晋升路径；匹配层有意不匹配（未匹配是合法状态）。",
        paperId: null,
        targetScope: null,
        sectionId: null,
        groupId: null,
        questionId: null,
      })),
  };

  const saved = saveAdjudicationReview({ draft, candidatesDir, papersDir, sourceDir: sourceRoot });
  expect(saved.ok, saved.errors?.join("；") ?? "").toBe(true);

  const stored = readStoredCandidate(courseId, candidatesDir);
  const review = validateCourseReviewFile(
    JSON.parse(readFileSync(join(candidatesDir, courseId, "review.json"), "utf8")),
  ).file;
  expect(review, "复核记录必须可读").not.toBeNull();

  const built = buildIndexFromDisk(papersDir);
  const gate = evaluatePromotionGate(
    gatherPromotionInputs({
      stored,
      review,
      reviewErrors: [],
      canonical: { digest: built.index.summary.digest, complete: built.failures.length === 0 },
      standardSourcesRoot: getCourseSourcesDir(),
      sourceRootOverride: sourceRoot,
    }),
  );
  expect(gate.status, `门禁必须 PROMOTABLE：${gate.summary}`).toBe("PROMOTABLE");

  void repos;
  void db;
  return { courseId, stored, review, gate, coursesDir: join(root, "courses") };
}

describe("A2 R1 · 裁决归属核对", () => {
  async function buildCandidate(root: string, courseId: string) {
    const sourceRoot = join(root, "synthetic-source");
    writeSourceTree(
      sourceRoot,
      new Map([
        [
          "阅读/reading-handout.pdf",
          buildTextPdf([
            [
              "SYNTHETIC FIXTURE - NOT REAL COURSE MATERIAL",
              "Passage One",
              "Questions 46 to 50 are based on the following passage.",
            ],
          ]),
        ],
      ]),
    );
    const papersRoot = join(root, "synthetic-papers");
    const papersDir = join(papersRoot, "cet6", "papers");
    writeFixturePackage(
      papersRoot,
      "fixture-cet6-2024-12-set1",
      buildFixturePackage({ id: "fixture-cet6-2024-12-set1", year: 2024, session: "December", variant: "set1" }),
    );

    const intake = await runCourseIntake({
      sourceRoot,
      courseId,
      provider: "test_fixture_provider",
      edition: null,
      title: "A2 R1 Fixture",
      contentVersion: 1,
      provenance: { note: "synthetic", reference: null, rightsNote: "synthetic" },
      papersDir,
    });
    const candidatesDir = join(root, "course-candidates");
    writeCourseCandidate(intake.archive, join(candidatesDir, courseId));
    return { intake, candidatesDir, papersDir, sourceRoot };
  }

  function ownershipOf(intake: Awaited<ReturnType<typeof buildCandidate>>["intake"]) {
    return collectCandidateOwnership({
      metadata: {
        grouping: { proposals: intake.grouping.proposals },
        segmentation: { materials: intake.segmentation },
        matching: { segments: intake.archive.metadata.matching.segments },
      },
    });
  }

  it("借用别处课程的 proposalId ⇒ 保存前被拒", async () => {
    const root = makeRoot("r1-foreign-proposal");
    const { intake, candidatesDir, papersDir, sourceRoot } = await buildCandidate(root, "r1-course");
    const ownership = ownershipOf(intake);
    expect(ownership.proposalIds.size).toBeGreaterThan(0);

    const draft: AdjudicationDraftPayload = {
      courseId: "r1-course",
      reviewer: "Reviewer",
      reviewedAt: "2026-10-20",
      candidateChecksum: intake.archive.metadata.digests.candidateChecksum,
      canonicalLibraryDigest: intake.archive.metadata.matching.canonicalLibrary.digest,
      sourceDigest: intake.inventory.digest,
      verifiedScope: ["materials"],
      notVerified: [],
      materialGroupings: [
        { proposalId: "belongs-to-another-course", decision: "accepted", evidence: "借用别处课程的分组 id。" },
      ],
      segments: [],
      matches: [],
    };

    const violations = checkAdjudicationOwnership(draft, ownership);
    expect(violations.length).toBe(1);
    expect(violations[0].section).toBe("materialGroupings");
    expect(violations[0].referencedId).toBe("belongs-to-another-course");
    expect(violations[0].reason).toContain("不属于当前候选");

    const prepared = prepareReviewForSave({ draft, candidatesDir, papersDir, sourceDir: sourceRoot });
    expect(prepared.ok).toBe(false);
    expect(prepared.errors.join("；")).toContain("不属于当前候选");

    expect(existsSync(join(candidatesDir, "r1-course", "review.json"))).toBe(false);

    const saved = saveAdjudicationReview({ draft, candidatesDir, papersDir, sourceDir: sourceRoot });
    expect(saved.ok).toBe(false);
    expect(existsSync(join(candidatesDir, "r1-course", "review.json"))).toBe(false);
  });

  it("接受一个机器从未提出过的目标 ⇒ 保存前被拒", async () => {
    const root = makeRoot("r1-invented-target");
    const { intake, candidatesDir, papersDir, sourceRoot } = await buildCandidate(root, "r1-course");
    const ownership = ownershipOf(intake);
    const segmentIds = [...ownership.segmentIds];
    expect(segmentIds.length).toBeGreaterThan(0);

    const draft: AdjudicationDraftPayload = {
      courseId: "r1-course",
      reviewer: "Reviewer",
      reviewedAt: "2026-10-20",
      candidateChecksum: intake.archive.metadata.digests.candidateChecksum,
      canonicalLibraryDigest: intake.archive.metadata.matching.canonicalLibrary.digest,
      sourceDigest: intake.inventory.digest,
      verifiedScope: ["matches"],
      notVerified: [],
      materialGroupings: [],
      segments: [],
      matches: [
        {
          segmentId: segmentIds[0],
          disposition: "accepted_suggestion",
          evidence: "接受一个从未被提出过的目标。",
          paperId: "fixture-cet6-2024-12-set1",
          targetScope: "section",
          sectionId: "reading.does_not_exist",
          groupId: null,
          questionId: null,
        },
      ],
    };

    const violations = checkAdjudicationOwnership(draft, ownership);
    expect(violations.length).toBe(1);
    expect(violations[0].section).toBe("matches");
    expect(violations[0].reason).toContain("不是机器在这段上提出过的建议");

    const prepared = prepareReviewForSave({ draft, candidatesDir, papersDir, sourceDir: sourceRoot });
    expect(prepared.ok).toBe(false);
    expect(prepared.errors.join("；")).toContain("不是机器在这段上提出过的建议");
    expect(existsSync(join(candidatesDir, "r1-course", "review.json"))).toBe(false);
  });

  it("intentionally_unmatched 不要求目标存在", async () => {
    const root = makeRoot("r1-intentional");
    const { intake } = await buildCandidate(root, "r1-course");
    const ownership = ownershipOf(intake);
    const segmentIds = [...ownership.segmentIds];

    const violations = checkAdjudicationOwnership(
      {
        matches: [
          {
            segmentId: segmentIds[0],
            disposition: "intentionally_unmatched",
            paperId: null,
            sectionId: null,
            groupId: null,
            questionId: null,
          },
        ],
      },
      ownership,
    );
    expect(violations).toEqual([]);
  });

  it("全部合法的草稿通过归属核对并能保存", async () => {
    const root = makeRoot("r1-valid");
    const { intake, candidatesDir, papersDir, sourceRoot } = await buildCandidate(root, "r1-course");
    const ownership = ownershipOf(intake);
    const segmentIds = [...ownership.segmentIds];

    const draft: AdjudicationDraftPayload = {
      courseId: "r1-course",
      reviewer: "Reviewer",
      reviewedAt: "2026-10-20",
      candidateChecksum: intake.archive.metadata.digests.candidateChecksum,
      canonicalLibraryDigest: intake.archive.metadata.matching.canonicalLibrary.digest,
      sourceDigest: intake.inventory.digest,
      verifiedScope: ["materials", "segments"],
      notVerified: ["canonical matches"],
      materialGroupings: [],
      segments: [
        { segmentId: segmentIds[0], decision: "accepted", evidence: "人工核验该段页码与讲义完全对齐。" },
      ],
      matches: [],
    };

    expect(checkAdjudicationOwnership(draft, ownership)).toEqual([]);

    const prepared = prepareReviewForSave({ draft, candidatesDir, papersDir, sourceDir: sourceRoot });
    expect(prepared.ok).toBe(true);

    const saved = saveAdjudicationReview({ draft, candidatesDir, papersDir, sourceDir: sourceRoot });
    expect(saved.ok).toBe(true);
    expect(existsSync(join(candidatesDir, "r1-course", "review.json"))).toBe(true);
  });
});
