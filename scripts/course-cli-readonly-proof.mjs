#!/usr/bin/env node
/**
 * `pnpm course:cli-readonly-proof` —— **在真实 CLI 边界上**证明只读命令不迁移。
 *
 * 与单元测试互补（`tests/course-readonly-dry-run.test.ts` 走 service 边界）：
 * 这里真的 spawn `pnpm course:import` / `course:link`，用真实临时内容根与
 * 真实临时库，前后对比 schema 快照。
 *
 * 覆盖：
 *   1. course:import（无 --commit）在 v8 上不迁移
 *   2. course:link --list / --segments 在 v8 上不迁移
 *   3. course:import --commit 在 v8 上**确实**迁移到 v9（写入能力未被削弱）
 *   4. 空课程目录：诚实输出 0 份
 *   5. course:validate 根本不打开数据库
 *
 * 全程使用临时目录；**绝不触碰 使用者的真实库**。
 *
 * 用法：node scripts/course-cli-readonly-proof.mjs [repoRoot]
 */

import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 默认取脚本所在目录的上一级（即仓库根），这样 `pnpm course:cli-readonly-proof`
// 直接可用，不必手工传参。
const repoRoot = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0;
let failed = 0;

function check(label, ok, detail = "") {
  if (ok) {
    passed += 1;
    console.log(`  \u2713 ${label}`);
  } else {
    failed += 1;
    console.log(`  \u2717 ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function snapshot(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  const version = db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get();
  const out = {
    version: version ? version.value : null,
    courseTables: tables.filter((t) => t.startsWith("course_")).sort(),
    triggers: Number(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type='trigger'").get().c),
    papers: Number(db.prepare("SELECT COUNT(*) AS c FROM exam_paper").get().c),
    pool: db.prepare("SELECT pool FROM paper_study_state WHERE paper_id='p-real'").get()?.pool ?? null,
    learner: Number(db.prepare("SELECT COUNT(*) AS c FROM learner_profile").get().c),
  };
  db.close();
  return out;
}

/** 从当前 SCHEMA_SQL 切出 v8 DDL（与测试同一推导方式）。 */
function deriveV8Ddl() {
  const schema = readFileSync(join(repoRoot, "src/db/schema.ts"), "utf8");
  const marker = "-- 课程层（Course Layer，V1 基础）";
  const i = schema.indexOf(marker);
  if (i < 0) throw new Error("找不到课程层分节标记");
  const raw = schema.slice(0, i);
  // 取出 SCHEMA_SQL 模板字面量的内容
  const start = raw.indexOf("export const SCHEMA_SQL = `");
  const body = raw.slice(start + "export const SCHEMA_SQL = `".length);
  return body.trimEnd();
}

function seedV8(file) {
  // 目录必须先存在（DatabaseSync 不会建目录）
  mkdirSync(join(file, ".."), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(deriveV8Ddl());
  db.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version','8')").run();
  db.prepare(
    "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
  ).run("p1", "Learner", 60, 120, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.prepare(
    `INSERT INTO exam_paper (id, exam_type, exam_year, session, variant, source_kind, verification_status,
       provenance_note, content_version, package_path, manifest_checksum, content_fingerprint,
       section_count, question_count, imported_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("p-real", "CET6", 2024, "December", "set1", "real_past_paper", "partially_verified", "n", 4, "pp", "cs", "fp", 8, 57, "t", "t");
  db.prepare("INSERT INTO paper_study_state (paper_id, pool, updated_at) VALUES (?,?,?)").run("p-real", "mock_reserve", "t");
  db.close();
}

function runCli(args, env) {
  try {
    const out = execFileSync("pnpm", args, {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

const work = mkdtempSync(join(tmpdir(), "cet6-cli-proof-"));
console.log("CLI 只读/写入行为显式证明");
console.log(`临时工作目录：${work}\n`);

try {
  // ---------- 1. course:import dry-run on v8 ----------
  console.log("1. course:import（无 --commit）在 v8 上不得迁移");
  {
    const root = join(work, "s1");
    const dbPath = join(root, "cet6.db");
    seedV8(dbPath);
    const before = snapshot(dbPath);

    const r = runCli(["course:import"], { CET6_CONTENT_ROOT: root, CET6_DB_PATH: dbPath });
    const after = snapshot(dbPath);

    check("命令成功退出", r.code === 0, `exit=${r.code}`);
    check("schema_version 仍为 8", after.version === "8", `实际 ${after.version}`);
    check("未创建任何 course_* 表", after.courseTables.length === 0, JSON.stringify(after.courseTables));
    check("触发器数未变", after.triggers === before.triggers, `${before.triggers} -> ${after.triggers}`);
    check("输出声称不写数据库（含 schema）", /不写数据库/.test(r.out), "");
  }

  // ---------- 2. course:link --list / --segments on v8 ----------
  console.log("\n2. course:link 的读取路径在 v8 上不得迁移");
  {
    const root = join(work, "s2");
    const dbPath = join(root, "cet6.db");
    seedV8(dbPath);
    const before = snapshot(dbPath);

    const a = runCli(["course:link", "--course", "nope", "--list"], {
      CET6_CONTENT_ROOT: root,
      CET6_DB_PATH: dbPath,
    });
    const b = runCli(["course:link", "--course", "nope", "--segments"], {
      CET6_CONTENT_ROOT: root,
      CET6_DB_PATH: dbPath,
    });
    const after = snapshot(dbPath);

    check("--list 如实报告课程层未激活", /尚未激活/.test(a.out), a.out.slice(0, 120));
    check("--segments 如实报告课程层未激活", /尚未激活/.test(b.out), b.out.slice(0, 120));
    check("两次读取后 schema_version 仍为 8", after.version === "8", `实际 ${after.version}`);
    check("未创建任何 course_* 表", after.courseTables.length === 0);
    check("库快照完全未变", JSON.stringify(after) === JSON.stringify(before));
  }

  // ---------- 3. explicit --commit on v8 DOES migrate ----------
  console.log("\n3. course:import --commit 在 v8 上必须迁移到 v9");
  {
    const root = join(work, "s3");
    const dbPath = join(root, "cet6.db");
    seedV8(dbPath);
    const before = snapshot(dbPath);

    const r = runCli(["course:import", "--commit"], {
      CET6_CONTENT_ROOT: root,
      CET6_DB_PATH: dbPath,
    });
    const after = snapshot(dbPath);

    check("命令成功退出", r.code === 0, `exit=${r.code}`);
    check("schema_version 前进到 9", after.version === "9", `实际 ${after.version}`);
    check(
      "课程层三张表已建立",
      JSON.stringify(after.courseTables) ===
        JSON.stringify(["course_canonical_link", "course_exposure_event", "course_package"]),
      JSON.stringify(after.courseTables),
    );
    check("只追加触发器已就位（5 -> 9）", after.triggers === 9, `${before.triggers} -> ${after.triggers}`);
    check("既有试卷数据保留", after.papers === before.papers && after.pool === "mock_reserve");
  }

  // ---------- 4. no content root: honest empty ----------
  console.log("\n4. 空课程目录：诚实输出 0 份且成功退出");
  {
    const root = join(work, "s4");
    const dbPath = join(root, "cet6.db");
    seedV8(dbPath);
    const r = runCli(["course:import"], { CET6_CONTENT_ROOT: root, CET6_DB_PATH: dbPath });
    check("成功退出", r.code === 0);
    check("如实输出 0 份", /0 份课程包/.test(r.out), r.out.slice(0, 120));
    check("仍不迁移", snapshot(dbPath).version === "8");
  }

  // ---------- 5. course:validate never opens DB ----------
  console.log("\n5. course:validate 不打开数据库（即使库不存在也不受影响）");
  {
    const root = join(work, "s5");
    const dbPath = join(root, "cet6.db"); // 刻意**不创建**
    const r = runCli(["course:validate"], { CET6_CONTENT_ROOT: root, CET6_DB_PATH: dbPath });
    check("成功退出", r.code === 0, `exit=${r.code}`);
    check("未创建数据库文件", !existsSync(dbPath));
  }
} finally {
  try {
    rmSync(work, { recursive: true, force: true });
  } catch {
    /* Windows 残留无妨 */
  }
}

console.log(`\n${"─".repeat(56)}`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) process.exitCode = 1;
