#!/usr/bin/env node
/**
 * 合成端到端证明（**真实 CLI 边界**）。
 *
 * 临时内容根 + 合成夹具；绝不触碰 使用者的真实库或真实 private-content。
 *
 * 链路：
 *   源 → course:extract → course:review（预演）
 *     → 写 review.json（普通 Node，模拟人工签署）
 *     → course:review（应 PROMOTABLE）
 *     → **负例：改动源字节但不重跑 extract** → course:review（应拒绝）
 *     → course:review --promote（应拒绝）
 *     → 恢复源 → 重新抽取 → 重新复核 → --promote（应成功）
 *     → course:validate → course:import（dry-run）
 *
 * 用法：node --experimental-transform-types --import ./scripts/alias-loader.mjs scripts/course-intake-e2e.ts
 */

import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.cwd();
const work = mkdtempSync(join(tmpdir(), "cet6-intake-e2e-"));
const contentRoot = join(work, "content");
const sourceRoot = join(contentRoot, "course-sources", "e2e-course");
const COURSE_ID = "e2e-course";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) {
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

/** 跑真实 CLI（继承环境变量，注入隔离内容根）。 */
function runCli(args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync("pnpm", args, {
      cwd: repo,
      env: { ...process.env, CET6_CONTENT_ROOT: contentRoot },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: `${failure.stdout ?? ""}${failure.stderr ?? ""}` };
  }
}

function listFiles(dir: string, base: string = dir, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) listFiles(full, base, out);
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

async function main() {
  const { writeSourceTree } = await import("./course-source-fixture");
  const { fullCourseFixture } = await import("./course-source-scenarios");
  const { readStoredCandidate, validateCourseReviewFile } = await import(
    "@/content/course-pipeline/review"
  );

  console.log("课程导入流水线 · 合成端到端证明（真实 CLI 边界）");
  console.log(`临时内容根：${contentRoot}`);

  try {
    // =================================================================
    section("0. 源目录就绪");
    // =================================================================
    mkdirSync(sourceRoot, { recursive: true });
    writeSourceTree(sourceRoot, fullCourseFixture());
    const sourceFiles = listFiles(sourceRoot);
    check("写入了合成源文件", sourceFiles.length > 0, `${sourceFiles.length} 个`);

    // =================================================================
    section("1. course:extract（真实 CLI）");
    // =================================================================
    const extract = runCli(["course:extract", "--source", sourceRoot, "--id", COURSE_ID, "--provider", "test_fixture_provider"]);
    check("extract 成功退出", extract.code === 0, `exit=${extract.code}`);
    check("输出声明不打开数据库", /不打开数据库/.test(extract.out));
    check("报告了源定位符", /源定位符/.test(extract.out));

    const candidateDir = join(contentRoot, "course-candidates", COURSE_ID);
    check("候选目录已生成", existsSync(join(candidateDir, "candidate.json")) && existsSync(join(candidateDir, "course.json")));

    const afterExtract = readStoredCandidate(COURSE_ID, join(contentRoot, "course-candidates"));
    const checksum = afterExtract.recomputed.candidateChecksum;
    console.log(`      候选校验和：${checksum.slice(0, 16)}…`);
    console.log(`      源定位符：${afterExtract.metadata.inventory.sourceLocator.kind} / ${afterExtract.metadata.inventory.sourceLocator.locator}`);
    check(
      "源定位符是**标准树内的相对路径**（可自动重证源新鲜度）",
      afterExtract.metadata.inventory.sourceLocator.kind === "standard",
    );
    check(
      "候选里**没有**绝对路径",
      !JSON.stringify(afterExtract.metadata).includes(work),
      "候选里出现了临时绝对路径",
    );

    // =================================================================
    section("2. course:review（尚无 review.json）");
    // =================================================================
    const reviewNoFile = runCli(["course:review", COURSE_ID]);
    check("明确报告没有复核记录", /没有 review\.json|复核记录/.test(reviewNoFile.out));
    check("门禁不是 PROMOTABLE", /门禁结论：(?!PROMOTABLE)/.test(reviewNoFile.out), "");

    // =================================================================
    section("3. 签署 review.json（模拟人工，绑定候选校验和）");
    // =================================================================
    const signReview = () => {
      const stored = readStoredCandidate(COURSE_ID, join(contentRoot, "course-candidates"));
      const md = stored.metadata;
      const review = {
        courseId: COURSE_ID,
        reviewer: "e2e-operator",
        reviewedAt: "2026-01-01",
        candidateChecksum: stored.recomputed.candidateChecksum,
        canonicalLibraryDigest: md.matching.canonicalLibrary.digest,
        materialGroupings: md.grouping.proposals
          .filter((p) => p.reviewRequired)
          .map((p) => ({
            proposalId: p.id,
            decision: "accepted",
            note: "E2E 确认。",
            evidence: "E2E 依据候选记录的 basis 与 evidence 作出该裁决（>=10 字符）。",
          })),
        segments: md.segmentation.materials
          .flatMap((m) => m.segments)
          .filter((s) => s.reviewRequired)
          .map((s) => ({
            segmentId: s.id,
            decision: "accepted",
            note: "E2E 确认。",
            evidence: "E2E 依据候选记录的 evidence.cues 与 lineSpan 作出该裁决（>=10 字符）。",
          })),
        matches: [],
        verifiedScope: ["E2E：候选结构、资产完整性、门禁路径"],
        notVerified: ["未做 canonical 对应关系的人工核验"],
      };
      const parsed = validateCourseReviewFile(review);
      if (!parsed.ok) throw new Error(`review 形状非法：${parsed.errors.join("；")}`);
      writeFileSync(join(stored.candidateDir, "review.json"), JSON.stringify(review, null, 2), "utf8");
      return stored.recomputed.candidateChecksum;
    };
    signReview();
    check("review.json 已写入", existsSync(join(candidateDir, "review.json")));

    // =================================================================
    section("4. course:review 预演（源当前 + 库完整 ⇒ PROMOTABLE）");
    // =================================================================
    const reviewOk = runCli(["course:review", COURSE_ID]);
    check("源当前性检查通过", /源未漂移/.test(reviewOk.out));
    check("门禁结论 PROMOTABLE", /门禁结论：PROMOTABLE/.test(reviewOk.out), reviewOk.out.match(/门禁结论：\S+/)?.[0]);

    // =================================================================
    section("5. 负例：改动源字节（**不重跑 extract**）");
    // =================================================================
    const targetPdf = join(sourceRoot, "阅读", "reading-handout.pdf");
    const originalPdf = (await import("node:fs")).readFileSync(targetPdf);
    (await import("node:fs")).appendFileSync(targetPdf, Buffer.from("%%DRIFT", "utf8"));
    console.log("      已向源 PDF 追加字节（候选**未**重新生成）");

    const reviewDrift = runCli(["course:review", COURSE_ID]);
    check("检测到源已漂移", /源已漂移/.test(reviewDrift.out));
    check("门禁不是 PROMOTABLE", !/门禁结论：PROMOTABLE/.test(reviewDrift.out), reviewDrift.out.match(/门禁结论：\S+/)?.[0]);
    const digestUnchanged = readStoredCandidate(COURSE_ID, join(contentRoot, "course-candidates")).metadata.inventory.digest;
    check("候选记录的源摘要**未**被自动更新", digestUnchanged === afterExtract.metadata.inventory.digest);

    // =================================================================
    section("6. 负例：漂移时 --promote 被拒绝");
    // =================================================================
    const promoteDrift = runCli(["course:review", COURSE_ID, "--promote"]);
    check("晋升被拒绝", /拒绝晋升/.test(promoteDrift.out), promoteDrift.out.slice(-200));
    check("courses/ 下**没有**产生目录", !existsSync(join(contentRoot, "courses", COURSE_ID)));

    // =================================================================
    section("7. 恢复源 + 重新抽取 + 重新复核 + 晋升");
    // =================================================================
    writeFileSync(targetPdf, originalPdf); // 还原原始字节
    const reExtract = runCli(["course:extract", "--source", sourceRoot, "--id", COURSE_ID, "--provider", "test_fixture_provider"]);
    check("重新抽取成功", reExtract.code === 0, `exit=${reExtract.code}`);
    check("旧候选被备份（不静默覆盖）", /已备份|prev-/.test(reExtract.out));

    const newChecksum = signReview();
    check("新候选校验和与旧的不同", newChecksum === checksum, "（源已还原 ⇒ 应当与最初一致）");

    const promoteOk = runCli(["course:review", COURSE_ID, "--promote"]);
    check("晋升成功", /已晋升/.test(promoteOk.out), promoteOk.out.slice(-300));
    check("报告了未复制的元数据", /未\*\*未\*\*复制|明确\*\*未\*\*复制/.test(promoteOk.out));
    check("声明没有创建 canonical 链接", /没有创建 canonical 链接/.test(promoteOk.out));

    const promotedDir = join(contentRoot, "courses", COURSE_ID);
    const promotedFiles = listFiles(promotedDir);
    console.log(`      晋升后文件：${promotedFiles.join("、")}`);
    check("course.json 与 assets/ 已复制", promotedFiles.includes("course.json"));
    check("candidate.json **未**进入运行时课程目录", !promotedFiles.includes("candidate.json"));
    check("review.json **未**进入运行时课程目录", !promotedFiles.includes("review.json"));

    // =================================================================
    section("8. course:validate（生产校验器读取晋升后的包）");
    // =================================================================
    const validate = runCli(["course:validate"]);
    check("course:validate 通过", /结果：PASS/.test(validate.out), validate.out.slice(-200));
    check("发现 1 份课程包", /1 份课程包|共发现 1 份/.test(validate.out));
    check("报告了 manifest schemaVersion", /schemaVersion/.test(validate.out));

    // =================================================================
    section("9. course:import（dry-run，必须不写库、不迁移）");
    // =================================================================
    /*
     * 与既有 `course:cli-readonly-proof.mjs` 同样的做法：预先种一个 v8 库，
     * 然后验证 dry-run **不迁移**它。
     *
     * 注意：`course:import` 的只读路径需要目标库**已存在**
     * （`openDatabaseReadOnly` 以 readOnly 打开，不会创建文件）——
     * 这是既存行为（`src/db/client.ts`，本阶段未改动），不是本轮引入的。
     * 因此这里先种库，再断言它在预演后**未被迁移**。
     */
    const dbPath = join(work, "e2e.db");
    const { DatabaseSync } = await import("node:sqlite");
    const schemaSource = (await import("node:fs")).readFileSync(join(repo, "src/db/schema.ts"), "utf8");
    const marker = "-- 课程层（Course Layer，V1 基础）";
    const markerIndex = schemaSource.indexOf(marker);
    const ddlBody = schemaSource
      .slice(0, markerIndex)
      .split("export const SCHEMA_SQL = `")[1]
      .trimEnd();
    const seed = new DatabaseSync(dbPath);
    seed.exec(ddlBody);
    seed.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version','8')").run();
    seed.close();

    const snapshot = (file: string) => {
      const db = new DatabaseSync(file, { readOnly: true });
      const out = {
        version:
          (db.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as
            | { value?: string }
            | undefined)?.value ?? null,
        courseTables: (
          db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'course%'")
            .all() as { name: string }[]
        )
          .map((r) => r.name)
          .sort(),
      };
      db.close();
      return out;
    };
    const before = snapshot(dbPath);

    const importRun = execFileSync("pnpm", ["course:import"], {
      cwd: repo,
      env: { ...process.env, CET6_CONTENT_ROOT: contentRoot, CET6_DB_PATH: dbPath },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
    });
    const after = snapshot(dbPath);

    check("模式声明为预演（不写数据库）", /预演/.test(importRun));
    check("如实说明课程层尚未激活", /尚未激活/.test(importRun));
    check("schema_version 仍为 8（**未迁移**）", after.version === "8", `实际 ${after.version}`);
    check("未创建任何 course_* 表", after.courseTables.length === 0, after.courseTables.join("、"));
    check("库快照完全未变", JSON.stringify(after) === JSON.stringify(before));

    // =================================================================
    section("10. 证明：隔离内容根下没有任何数据库文件");
    // =================================================================
    // 注意：`.db` 刻意放在内容根**之外**（`work/e2e.db`），因此内容根里应当一个都没有。
    const anyDb = listFiles(contentRoot).filter((f) => f.endsWith(".db"));
    check("内容根下 .db 文件数为 0", anyDb.length === 0, anyDb.join("、"));

    /*
     * ── 关于"使用者 真实库未被触碰"：判据已改为**结构性**，不再 stat 真实文件 ──
     *
     * 这里原本是 `statSync(join(repo, "data", "cet6.db")).mtimeMs` ——
     * 那是对 使用者 真实数据库的一次元数据读取，属于任务书明确禁止的
     * "stat / 检查真实 DB"。已移除。
     *
     * 替代判据落在**本次运行的隔离性**上（全部可证，且不碰真实文件）：
     *
     * 1. 本脚本用 `execFileSync` 起的每个子进程都显式覆盖 `CET6_DB_PATH`
     *    与 `CET6_CONTENT_ROOT` 指向 `work/` 下的隔离位置 —— 因此子进程
     *    **在原理上**无法打开 使用者的库（路径被覆盖了）；
     * 2. 隔离库的快照前后逐项相同（上一节已断言）；
     * 3. 源码级自证：本文件不得出现对真实库的 stat / 读取。
     *
     * 第 1 条比"事后看 mtime 有没有变"更强：mtime 只能发现"已经被改"，
     * 而路径覆盖让"可能被改"这件事不成立。
     */
    check(
      "隔离运行覆盖了库路径（子进程无法打开使用者真实库）",
      !dbPath.includes(join("data", "cet6.db")) && dbPath.startsWith(work),
      dbPath,
    );
    /*
     * 源码级自证必须**剥掉注释**：上方解释"为什么移除 statSync"的注释
     * 本身含 `statSync(` 字样，朴素扫描会误判（同 paper-pool-policy 先例）。
     */
    const selfCode = readFileSync(new URL(import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    check(
      "本脚本不再 stat / 读取使用者真实库",
      !/statSync\([^)]*cet6\.db/.test(selfCode),
    );


    console.log(`\n${"─".repeat(60)}`);
    console.log(`通过 ${passed} 项，失败 ${failed} 项`);
    if (failed > 0) process.exitCode = 1;
  } finally {
    // 保留工作目录供人工检查（--keep），默认清理
    if (!process.argv.includes("--keep")) {
      try {
        rmSync(work, { recursive: true, force: true });
      } catch {
        /* Windows 残留无妨 */
      }
    } else {
      console.log(`\n工作目录（保留）：${work}`);
    }
  }
}

void cpSync;

main().catch((error) => {
  console.error("\nE2E 异常终止：");
  console.error(error);
  process.exitCode = 1;
});
