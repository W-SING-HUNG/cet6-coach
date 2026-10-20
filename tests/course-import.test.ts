import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, openDatabase, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import {
  planCourseImport,
  commitCourseImport,
  runCourseImport,
} from "@/services/course-import";
import { NormalizedCourseImporter } from "@/content/course/importer";
import { getCoursesDir, getPapersDir, isRegularFile, resolveWithinRoot, UnsafePathError } from "@/content/paper/paths";
import { createEscapeLink, probeEscapeLink } from "./support/escape-links";
import { SCHEMA_SQL, SCHEMA_VERSION } from "@/db/schema";
import type { Repositories } from "@/repositories/ports";
import { buildCourseFixture, writeCourseFixture, sha256Hex } from "../scripts/course-fixture";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

/**
 * 课程包导入生命周期测试：发现 / 校验 / dry-run / 事务提交 / 幂等 / 回滚。
 *
 * 测试环境策略：把 `CET6_CONTENT_ROOT` 指向每个用例自己的临时目录，
 * 因此测试**完全不依赖** 使用者 真实的 private-content 目录 ——
 * 这是内容政策的硬性要求（用户私有内容不进测试）。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

function writeCourse(dirName: string, fixture = buildCourseFixture()): string {
  return writeCourseFixture(contentRoot, dirName, fixture);
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint };
  return Number(row.c);
}

function tableNames(): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map(
    (row) => row.name,
  );
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-courses-"));
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);
});

afterEach(() => {
  if (previousRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
  else process.env.CET6_CONTENT_ROOT = previousRoot;
  rmSync(contentRoot, { recursive: true, force: true });
});

describe("schema：课程层三张表", () => {
  it("全新库建出三张课程表", () => {
    const tables = tableNames();
    for (const table of ["course_package", "course_canonical_link", "course_exposure_event"]) {
      expect(tables, `全新库缺少课程层表 ${table}`).toContain(table);
    }
  });

  it("课程包正文不落库：course_package 没有正文列", () => {
    const columns = (
      db.prepare("PRAGMA table_info(course_package)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const forbidden of ["content", "body", "segments", "text", "manifest", "materials"]) {
      expect(columns, `course_package 不应包含正文列 ${forbidden}`).not.toContain(forbidden);
    }
    // 但索引事实必须在
    for (const required of [
      "content_version",
      "manifest_checksum",
      "content_fingerprint",
      "package_path",
      "rights_note",
    ]) {
      expect(columns).toContain(required);
    }
  });

  it("course_package 不含任何绝对路径列（便携性）", () => {
    const columns = (
      db.prepare("PRAGMA table_info(course_package)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    for (const forbidden of ["absolute_path", "absolutePath", "root", "content_root"]) {
      expect(columns).not.toContain(forbidden);
    }
  });

  it("provider 是自由字符串列，不是 CHECK 枚举（加一个 provider 不该需要迁移）", () => {
    // 直接插入一个从未见过的 provider 必须成功
    expect(() =>
      db
        .prepare(
          `INSERT INTO course_package (id, provider, edition, title, content_version,
             provenance_note, provenance_ref, rights_note, package_path, manifest_checksum,
             content_fingerprint, material_count, segment_count, asset_count, asset_bytes,
             asset_index, imported_at, updated_at)
           VALUES ('c-x','brand_new_provider',NULL,'t',1,'n',NULL,'r','p','c',NULL,1,1,0,0,'[]','t','t')`,
        )
        .run(),
    ).not.toThrow();
  });
});

describe("课程库为空：诚实为空", () => {
  it("目录不存在时发现 0 份且不报错", () => {
    const plan = planCourseImport(repos);
    expect(plan.report.discovered).toBe(0);
    expect(plan.report.entries).toEqual([]);
    expect(plan.report.counts).toEqual({
      insert: 0,
      update: 0,
      metadataOnly: 0,
      unchanged: 0,
      rejected: 0,
    });
  });

  it("目录存在但没有含 course.json 的子目录时也是 0 份", () => {
    mkdirSync(join(contentRoot, "courses", "not-a-package"), { recursive: true });
    writeFileSync(join(contentRoot, "courses", "not-a-package", "readme.txt"), "no manifest", "utf8");
    const plan = planCourseImport(repos);
    expect(plan.report.discovered).toBe(0);
  });

  it("课程目录与真题目录是两棵独立子树（互不误认）", () => {
    // 把一份**试卷**包放进 cet6/papers/ —— 课程导入器不该看到它
    writeFixturePackage(contentRoot, "a-paper-package", buildFixturePackage());

    // 把一份**课程**包放进 cet6/papers/ —— 真题导入器不该看到它，
    // 课程导入器同样不该（它只枚举 courses/）
    const paperDir = getPapersDir();
    mkdirSync(join(paperDir, "stray-course"), { recursive: true });
    writeFileSync(join(paperDir, "stray-course", "course.json"), "{}", "utf8");

    const plan = planCourseImport(repos);
    // courses/ 目录根本不存在（只有 cet6/papers/），因此课程导入发现 0 份
    expect(plan.report.discovered).toBe(0);

    // 两个目录是不同的路径，且课程根不在试卷根之下
    expect(getCoursesDir()).not.toBe(getPapersDir());
    expect(getCoursesDir().startsWith(getPapersDir())).toBe(false);
  });
});

describe("课程包校验与导入：合法包", () => {
  it("发现并校验合法包，判定为 insert", () => {
    writeCourse("fixture-course-a");
    const plan = planCourseImport(repos);
    expect(plan.report.discovered).toBe(1);
    expect(plan.report.counts.insert).toBe(1);
    expect(plan.report.entries[0].courseId).toBe("fixture-course-a");
    expect(plan.report.entries[0].segmentCount).toBe(6);
    expect(plan.report.entries[0].issues).toEqual([]);
  });

  it("**dry-run 不写任何东西**", () => {
    writeCourse("fixture-course-a");
    const result = runCourseImport(repos, { dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.written).toBe(0);
    expect(result.report.counts.insert).toBe(1);

    // 关键断言：库里一行都没有
    expect(countRows("course_package")).toBe(0);
    expect(repos.courses.countPackages()).toBe(0);
  });

  it("commit 写入预期的索引事实", () => {
    writeCourse("fixture-course-a");
    const plan = planCourseImport(repos);
    const result = commitCourseImport(repos, plan);

    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(countRows("course_package")).toBe(1);

    const record = repos.courses.getPackage("fixture-course-a")!;
    expect(record.provider).toBe("test_fixture_provider");
    expect(record.title).toContain("夹具课程包");
    expect(record.contentVersion).toBe(1);
    expect(record.materialCount).toBe(2);
    expect(record.segmentCount).toBe(6);
    expect(record.assetCount).toBe(4);
    expect(record.provenance.rightsNote).toBeDefined();
    expect(record.provenance.rightsNote).toContain("合成夹具");
    expect(record.packagePath).toBe("fixture-course-a");
    expect(record.manifestChecksum).toMatch(/^[0-9a-f]{64}$/);
    expect(record.contentFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("索引里只保存包内**相对**路径，绝不存绝对路径", () => {
    writeCourse("fixture-course-a");
    commitCourseImport(repos, planCourseImport(repos));

    const row = db
      .prepare("SELECT package_path, asset_index FROM course_package WHERE id = ?")
      .get("fixture-course-a") as { package_path: string; asset_index: string };

    expect(row.package_path).toBe("fixture-course-a");
    // 临时目录的绝对路径不得出现在任何一格
    expect(row.package_path).not.toContain(contentRoot);
    expect(row.asset_index).not.toContain(contentRoot);
    expect(row.asset_index).not.toContain(":\\");
    expect(row.asset_index).toContain("assets/handout.pdf");
  });

  it("已导入的包可以按内容版本查询（链接核验的前置条件）", () => {
    writeCourse("fixture-course-a");
    commitCourseImport(repos, planCourseImport(repos));
    expect(repos.courses.hasContentVersion("fixture-course-a", 1)).toBe(true);
    expect(repos.courses.hasContentVersion("fixture-course-a", 2)).toBe(false);
    expect(repos.courses.hasContentVersion("nope", 1)).toBe(false);
  });
});

describe("课程包导入：畸形包与缺失资产", () => {
  it("manifest 损坏的包被拒绝，且不写入任何数据", () => {
    const dir = join(contentRoot, "courses", "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "course.json"), "{ not json", "utf8");

    const plan = planCourseImport(repos);
    expect(plan.report.counts.rejected).toBe(1);
    expect(plan.report.entries[0].issues.length).toBeGreaterThan(0);

    const result = commitCourseImport(repos, plan);
    expect(result.written).toBe(0);
    expect(countRows("course_package")).toBe(0);
  });

  it("结构不合法（缺 rightsNote）的包被拒绝", () => {
    const fixture = buildCourseFixture();
    const manifest = fixture.manifest as Record<string, unknown>;
    (manifest.provenance as Record<string, unknown>).rightsNote = "";
    writeCourse("bad-rights", { manifest, files: fixture.files });

    const plan = planCourseImport(repos);
    expect(plan.report.counts.rejected).toBe(1);
    expect(plan.report.entries[0].issues.some((i) => i.path.includes("rightsNote"))).toBe(true);
  });

  it("**缺失资产**被拒绝（manifest 声明了但磁盘上没有）", () => {
    const fixture = buildCourseFixture();
    fixture.files.delete("assets/handout.pdf");
    writeCourse("missing-asset", fixture);

    const plan = planCourseImport(repos);
    expect(plan.report.counts.rejected).toBe(1);
    /*
     * 拒绝发生在**路径解析层**（与试卷导入器同一顺序：先词法、再磁盘）。
     *
     * 曾经这里断言消息含"文件不存在"—— 那句话来自 `UnsafePathError`，
     * 而它会**回显被拒绝的路径输入**（`路径不安全：assets/handout.pdf（文件不存在）`）。
     * 独立评审 F-2 之后不再回显（manifest 是外部数据）。
     *
     * 因此改成断言**语义**：该资产被挡住、原因可行动、且不含回显。
     * 判据不绑死具体措辞 —— 绑死措辞会诱使"为了让测试过而把消息改回去"。
     */
    const hit = plan.report.entries[0].issues.find((issue) => issue.path === "assets[0].path");
    expect(hit, "缺失资产必须在路径解析层被拒绝").toBeDefined();
    expect(hit!.message).toMatch(/不可用|不存在|没有随包/);
    expect(hit!.message).not.toContain("handout.pdf");
    // 并且它从未进入写路径
    expect(commitCourseImport(repos, plan).written).toBe(0);
    expect(countRows("course_package")).toBe(0);
  });

  it("**字节数不符**被拒绝", () => {
    const fixture = buildCourseFixture();
    const manifest = fixture.manifest as Record<string, unknown>;
    (manifest.assets as Array<Record<string, unknown>>)[0].bytes = 999999;
    writeCourse("bad-bytes", { manifest, files: fixture.files });

    const plan = planCourseImport(repos);
    expect(plan.report.counts.rejected).toBe(1);
    expect(plan.report.entries[0].issues.some((issue) => issue.message.includes("字节数不符"))).toBe(true);
  });

  it("**校验和不符**被拒绝（长度相同但内容被改 —— 只有哈希能发现）", () => {
    const fixture = buildCourseFixture();
    const dir = writeCourse("bad-checksum", fixture);

    // 关键：**保持字节数不变**，只改内容。
    // 这样"字节数"检查会通过，唯一能发现篡改的就是校验和 ——
    // 否则这条用例根本走不到哈希那一步（实测踩到过）。
    const target = join(dir, "assets", "handout.pdf");
    const original = readFileSync(target);
    const tampered = Buffer.from(original);
    // 换掉中间一个字符（PDF 注释区），长度完全不变
    const at = tampered.indexOf(Buffer.from("fixture reading handout", "utf8"));
    expect(at, "夹具前提：找不到可替换的文本").toBeGreaterThan(0);
    tampered.write("X", at, "utf8");

    expect(tampered.length).toBe(original.length);
    expect(sha256Hex(tampered)).not.toBe(sha256Hex(original));
    writeFileSync(target, tampered);

    const plan = planCourseImport(repos);
    expect(plan.report.counts.rejected).toBe(1);
    expect(plan.report.entries[0].issues.some((issue) => issue.message.includes("校验和不符"))).toBe(true);
  });

  it("manifest 里声明的校验和与磁盘不一致时，导入器确实比对了磁盘（而不是只信声明）", () => {
    // 这条用例防的是"只信 manifest 声明的 checksum"这个实现退化。
    const fixture = buildCourseFixture();
    const dir = writeCourse("trust-check", fixture);
    const manifestPath = join(dir, "course.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const assets = manifest.assets as Array<Record<string, unknown>>;

    // 把声明的 checksum 换成一个**合法格式但内容错误**的值，同时保持 bytes 正确
    assets[0].checksum = sha256Hex(Buffer.from("a different file entirely", "utf8"));
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    const plan = planCourseImport(repos);
    expect(plan.report.counts.rejected).toBe(1);
    expect(plan.report.entries[0].issues.some((issue) => issue.message.includes("校验和不符"))).toBe(true);
  });

  it("批内课程 id 重复时只接受第一个，其余给出可读原因（不影响其它包）", () => {
    writeCourse("copy-a");
    writeCourse("copy-b");
    const plan = planCourseImport(repos);

    expect(plan.report.discovered).toBe(2);
    expect(plan.report.counts.insert).toBe(1);
    expect(plan.report.counts.rejected).toBe(1);
    const rejected = plan.report.entries.find((entry) => entry.decision === "rejected")!;
    expect(rejected.issues.some((issue) => issue.message.includes("课程 id 重复"))).toBe(true);
  });
});

describe("课程包导入：幂等与版本语义", () => {
  it("**重复导入未变更的包是幂等的**（判定 unchanged，不新增行）", () => {
    writeCourse("fixture-course-a");
    const first = runCourseImport(repos, { dryRun: false });
    expect(first.written).toBe(1);
    expect(countRows("course_package")).toBe(1);

    const plan = planCourseImport(repos);
    expect(plan.report.counts.unchanged).toBe(1);
    expect(plan.report.counts.insert).toBe(0);

    const second = commitCourseImport(repos, plan);
    expect(second.written).toBe(0);
    expect(countRows("course_package")).toBe(1);

    // 版本没有被无谓地改动
    expect(repos.courses.getPackage("fixture-course-a")!.contentVersion).toBe(1);
  });

  it("**元数据变更不涨版本**（只改 rightsNote）", () => {
    writeCourse("fixture-course-a");
    runCourseImport(repos, { dryRun: false });
    const before = repos.courses.getPackage("fixture-course-a")!;

    // 覆盖同一个目录：内容相同、只有 rightsNote 变了
    writeCourse("fixture-course-a", buildCourseFixture({ rightsNote: "更新后的权利说明，内容未变。" }));
    const plan = planCourseImport(repos);

    expect(plan.report.counts.metadataOnly).toBe(1);
    expect(plan.report.entries[0].detail).toContain("不递增版本");

    commitCourseImport(repos, plan);
    const after = repos.courses.getPackage("fixture-course-a")!;
    expect(after.contentVersion).toBe(1);
    expect(after.provenance.rightsNote).toBe("更新后的权利说明，内容未变。");
    // 内容指纹没变（这才是"内容还是同一版"的证据）
    expect(after.contentFingerprint).toBe(before.contentFingerprint);
    expect(after.manifestChecksum).not.toBe(before.manifestChecksum);
    expect(countRows("course_package")).toBe(1);
  });

  it("**内容变更但没有递增 contentVersion 时拒绝**（否则已核验链接会被静默套用）", () => {
    writeCourse("fixture-course-a");
    runCourseImport(repos, { dryRun: false });

    writeCourse(
      "fixture-course-a",
      buildCourseFixture({ readingText: "Entirely different fixture passage body." }),
    );
    const plan = planCourseImport(repos);

    expect(plan.report.counts.rejected).toBe(1);
    expect(plan.report.entries[0].detail).toContain("版本冲突");
    expect(plan.report.entries[0].issues[0].message).toContain("必须递增 contentVersion");

    commitCourseImport(repos, plan);
    // 库中内容版本未被改动
    expect(repos.courses.getPackage("fixture-course-a")!.contentVersion).toBe(1);
  });

  it("内容变更**并**递增版本时判定为 update，且版本前进", () => {
    writeCourse("fixture-course-a");
    runCourseImport(repos, { dryRun: false });

    writeCourse(
      "fixture-course-a",
      buildCourseFixture({ contentVersion: 2, readingText: "A new fixture passage body for v2." }),
    );
    const plan = planCourseImport(repos);
    expect(plan.report.counts.update).toBe(1);
    expect(plan.report.entries[0].detail).toContain("v1 → v2");

    commitCourseImport(repos, plan);
    expect(repos.courses.getPackage("fixture-course-a")!.contentVersion).toBe(2);
    expect(countRows("course_package")).toBe(1);
  });

  it("版本**只能前进**：包声明更低版本时拒绝", () => {
    writeCourse("fixture-course-a", buildCourseFixture({ contentVersion: 3 }));
    runCourseImport(repos, { dryRun: false });
    expect(repos.courses.getPackage("fixture-course-a")!.contentVersion).toBe(3);

    writeCourse("fixture-course-a", buildCourseFixture({ contentVersion: 2 }));
    const plan = planCourseImport(repos);
    expect(plan.report.counts.rejected).toBe(1);
    expect(plan.report.entries[0].issues[0].message).toContain("只能前进");
    expect(repos.courses.getPackage("fixture-course-a")!.contentVersion).toBe(3);
  });

  it("内容未变而作者声明更高版本时被尊重（版本号是作者的断言）", () => {
    writeCourse("fixture-course-a");
    runCourseImport(repos, { dryRun: false });

    writeCourse("fixture-course-a", buildCourseFixture({ contentVersion: 2 }));
    const plan = planCourseImport(repos);
    expect(plan.report.counts.update).toBe(1);
    commitCourseImport(repos, plan);
    expect(repos.courses.getPackage("fixture-course-a")!.contentVersion).toBe(2);
  });
});

describe("课程包导入：未匹配是合法状态", () => {
  it("**没有任何 canonical 匹配的课程包仍然可以成功导入**", () => {
    writeCourse("fixture-course-a");
    const plan = planCourseImport(repos);
    expect(plan.report.counts.insert).toBe(1);
    expect(plan.report.counts.rejected).toBe(0);

    const result = commitCourseImport(repos, plan);
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);

    // 段全部未匹配：链接表必须是空的，而这不影响导入成功
    expect(countRows("course_canonical_link")).toBe(0);
    expect(repos.courses.listLinksForCourse("fixture-course-a")).toEqual([]);
    expect(repos.courses.getPackage("fixture-course-a")!.segmentCount).toBe(6);
  });

  it("导入不要求真题库存在（两套内容互不依赖）", () => {
    expect(repos.papers.countPapers()).toBe(0);
    writeCourse("fixture-course-a");
    const result = runCourseImport(repos, { dryRun: false });
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
  });
});

describe("课程包导入：事务回滚", () => {
  /**
   * 故障注入：第 2 个条目在写路径上失败。
   *
   * 注入点是真实的 —— 用一个仓储代理，让第 2 次 `saveImport` 抛错。
   * 因为整个提交包在一个事务里，第 1 个包的索引也必须被回滚。
   *
   * 为什么不直接用"坏包"当注入：坏包在**计划阶段**就被拒绝了，
   * 永远进不到写路径。要验证事务边界，失败必须发生在写入**过程中**。
   */
  it("写入过程中失败 ⇒ 整批回滚，库里不留任何半成品", () => {
    writeCourse("course-one", buildCourseFixture({ id: "course-one" }));
    writeCourse("course-two", buildCourseFixture({ id: "course-two" }));

    const plan = planCourseImport(repos);
    expect(plan.report.counts.insert).toBe(2);

    let calls = 0;
    const failing: Repositories = {
      ...repos,
      courses: {
        ...repos.courses,
        saveImport: (input, decision) => {
          calls += 1;
          if (calls === 2) throw new Error("注入的写入失败（第 2 个包）");
          return repos.courses.saveImport(input, decision);
        },
      },
    };

    const result = commitCourseImport(failing, plan);
    expect(result.ok).toBe(false);
    expect(result.written).toBe(0);
    expect(result.error).toContain("整批已回滚");

    // 关键断言：查询数据库确认回滚后的**真实状态**（不是只断言抛了异常）
    expect(countRows("course_package")).toBe(0);
  });

  it("回滚后重试恰好成功一次（失败没有留下副作用）", () => {
    writeCourse("course-one", buildCourseFixture({ id: "course-one" }));
    writeCourse("course-two", buildCourseFixture({ id: "course-two" }));

    const plan = planCourseImport(repos);
    let calls = 0;
    const failing: Repositories = {
      ...repos,
      courses: {
        ...repos.courses,
        saveImport: (input, decision) => {
          calls += 1;
          if (calls === 2) throw new Error("注入的写入失败（第 2 个包）");
          return repos.courses.saveImport(input, decision);
        },
      },
    };
    expect(commitCourseImport(failing, plan).ok).toBe(false);
    expect(countRows("course_package")).toBe(0);

    // 用正常仓储重试：两个包都应写入
    const retry = commitCourseImport(repos, planCourseImport(repos));
    expect(retry.ok).toBe(true);
    expect(retry.written).toBe(2);
    expect(countRows("course_package")).toBe(2);

    // 再重试一次是幂等的空操作
    const again = commitCourseImport(repos, planCourseImport(repos));
    expect(again.ok).toBe(true);
    expect(again.written).toBe(0);
    expect(countRows("course_package")).toBe(2);
  });

  it("整批中只要有坏包，好包仍照常导入（坏包在计划阶段即被隔离）", () => {
    writeCourse("good-course", buildCourseFixture({ id: "good-course" }));
    const dir = join(contentRoot, "courses", "bad-course");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "course.json"), "{ broken", "utf8");

    const plan = planCourseImport(repos);
    expect(plan.report.counts.insert).toBe(1);
    expect(plan.report.counts.rejected).toBe(1);

    const result = commitCourseImport(repos, plan);
    expect(result.ok).toBe(true);
    // 好包照常导入；坏包从未进入写路径（它连 courseId 都解析不出来）
    expect(result.written).toBe(1);
    expect(repos.courses.getPackage("good-course")).not.toBeNull();
    expect(countRows("course_package")).toBe(1);
  });
});

describe("课程包导入：--only 过滤", () => {
  it("只处理指定的包目录", () => {
    writeCourse("course-one", buildCourseFixture({ id: "course-one" }));
    writeCourse("course-two", buildCourseFixture({ id: "course-two" }));

    const plan = planCourseImport(repos, { only: ["course-two"] });
    expect(plan.report.discovered).toBe(1);
    expect(plan.report.entries[0].packagePath).toBe("course-two");
  });

  it("指定的包目录不存在时发现 0 份（不报错）", () => {
    writeCourse("course-one", buildCourseFixture({ id: "course-one" }));
    const plan = planCourseImport(repos, { only: ["nope"] });
    expect(plan.report.discovered).toBe(0);
  });
});

describe("课程包导入器：拓扑与路径安全", () => {
  it("discover 只做一层枚举，不递归进子目录", () => {
    writeCourse("outer");
    // 在包内再放一个看起来像包的子目录 —— 它不该被当成第二个包
    const nested = join(contentRoot, "courses", "outer", "nested-package");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "course.json"), "{}", "utf8");

    const handles = new NormalizedCourseImporter(getCoursesDir()).discover();
    expect(handles.map((handle) => handle.relativePath)).toEqual(["outer"]);
  });

  it("隐藏目录（. 开头）被忽略", () => {
    writeCourse(".hidden-package");
    writeCourse("visible");
    const handles = new NormalizedCourseImporter(getCoursesDir()).discover();
    expect(handles.map((handle) => handle.relativePath)).toEqual(["visible"]);
  });

  it("包内资产是符号链接并指向内容根之外时被拒绝", () => {
    /*
     * ── 这个测试原先为什么没有在断言任何东西 ──
     *
     * 旧夹具把"外部文件"写在了**内容根之内**：
     *
     *     const outside = join(contentRoot, "outside-secret.pdf");
     *
     * 它并不在根外，因此 `resolveWithinRoot` 正确地**接受了**它 ——
     * 断言"必须被拒绝"在语义上就不可能成立。
     *
     * 更糟的是，旧实现用 `catch { return; }` 兜住符号链接创建失败。
     * 非管理员 Windows 创建符号链接会拿到 `EPERM`，于是这个测试在 Windows 上
     * **每一次都在 catch 里 return**：一条安全断言都没执行，却记为通过。
     *
     * ── 现在的判据 ──
     *
     * 1. 内容根与"根外"是**两个独立的临时目录**，链接目标真的在根外；
     * 2. 真的建一个指向它的重解析点（POSIX 符号链接 / Windows junction），
     *    并**验证它确实解析到根外**；
     * 3. 真实调用产品的路径校验（`resolveWithinRoot`），断言它**拒绝**；
     * 4. 断言拒绝原因是"符号链接指向内容根之外"，**不是** ENOENT/EPERM；
     * 5. 同一目录下的**合法内部资产仍然可读**（证明不是把整包否掉）。
     *
     * 本机两种形态都不可用时显式失败，绝不静默通过。
     */
    const capability = probeEscapeLink();
    expect(
      capability.available,
      `本机无法构造指向根外的链接，这条安全断言无法执行：${capability.unavailableReason ?? "unknown"}`,
    ).toBe(true);

    const fixture = buildCourseFixture();
    const dir = writeCourse("symlink-escape", fixture);
    /*
     * 另建一个**不受影响**的包。
     *
     * junction 形态会把整个父目录换成指向根外的联接，因此"包内合法资产仍可读"
     * 这个不变量不能在同一包里验证 —— 那里所有资产都确实已逃逸。
     * 用一个正常包来证明：拒绝是**有针对性的**，不是把所有包一并否掉。
     */
    const healthyDir = writeCourse("healthy-course", buildCourseFixture({ id: "healthy-course" }));
    const healthyAsset = resolveWithinRoot(healthyDir, "assets/handout.pdf");
    expect(isRegularFile(healthyAsset.absolutePath), "未受影响的包内合法资产必须仍然可读").toBe(true);

    // 根外的独立目录（与 contentRoot 无关）
    const outsideRoot = mkdtempSync(join(tmpdir(), "cet6-course-outside-"));
    try {
      // manifest 实际引用的资产路径 —— 逃逸入口必须落在同一条路径上，
      // 否则导入器根本不会碰到它，"端到端拒绝"就成了空话。
      const escaping = createEscapeLink(dir, outsideRoot, capability, "assets/handout.pdf");

      // ① 产品确实拒绝
      expect(
        () => resolveWithinRoot(dir, escaping),
        "指向内容根之外的资产必须被拒绝",
      ).toThrow(UnsafePathError);

      // ② 拒绝原因必须是"逃逸"，不是"文件不存在"或其他失败
      let reason = "";
      try {
        resolveWithinRoot(dir, escaping);
      } catch (error) {
        expect(error).toBeInstanceOf(UnsafePathError);
        reason = (error as UnsafePathError).reason;
      }
      expect(reason, `拒绝原因必须是逃逸，实际为「${reason}」`).toContain("符号链接指向内容根之外");

      // ③ 端到端：导入计划把该包判为拒绝，另一个包照常
      const plan = planCourseImport(repos);
      expect(plan.report.counts.rejected).toBe(1);
      expect(plan.report.counts.insert, "未受影响的包必须照常被接受").toBe(1);
      expect(
        plan.report.entries.find((entry) => entry.packagePath === "symlink-escape")?.issues.length,
        "被拒绝的包必须给出至少一条可行动的问题说明",
      ).toBeGreaterThan(0);
    } finally {
      rmSync(outsideRoot, { recursive: true, force: true });
    }
  });
});

describe("P0：v8 → v9 课程层迁移", () => {
  function newTempDir(): string {
    return mkdtempSync(join(tmpdir(), "cet6-course-migration-"));
  }

  /**
   * **真正的 v8 形态 DDL。**
   *
   * 从当前 `SCHEMA_SQL` 中**切掉**课程层那一段得到 —— 课程层的 DDL 是整体
   * 追加在文件末尾的，因此这个切法得到的正是 v8 的真实形态。
   *
   * 为什么不手工抄一份 v8 DDL（像 `tests/schema-safety.test.ts` 的 `V6_DDL` 那样）：
   * v6 的 DDL 已经不在 `schema.ts` 里了，抄写是唯一办法；而 v8 的形态**仍然
   * 可以从单一来源推导**，推导比抄写更不容易随代码演进悄悄失真。
   *
   * 下面两条断言是这个推导的**自检**：一旦有人重排 schema.ts 使其不再成立，
   * 测试会明确失败，而不是拿着错误的前提继续跑出一个假的绿灯。
   */
  const COURSE_SECTION_MARKER = "-- 课程层（Course Layer，V1 基础）";

  function deriveV8Ddl(): string {
    const index = SCHEMA_SQL.indexOf(COURSE_SECTION_MARKER);
    expect(index, "在 SCHEMA_SQL 中找不到课程层分节标记，v8 形态无法推导").toBeGreaterThan(0);
    const ddl = SCHEMA_SQL.slice(0, index).trimEnd();
    // 自检 1：切出来的 DDL 不得包含任何课程层表
    expect(ddl).not.toContain("course_package");
    expect(ddl).not.toContain("course_canonical_link");
    expect(ddl).not.toContain("course_exposure_event");
    // 自检 2：它必须仍然包含 v8 的全部关键表（否则切点错了）
    for (const table of [
      "schema_meta",
      "learner_profile",
      "exam_paper",
      "paper_asset",
      "paper_study_state",
      "learning_run",
      "performance_event",
      "assessment_event",
      "evidence_projection",
    ]) {
      expect(ddl, `切出的 v8 DDL 缺少 ${table}，切点可能不对`).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
    }
    return ddl;
  }

  /**
   * 一个"生产形态的 v8 库"：含学习者数据、已导入的真实试卷索引、
   * Expert 台账（run + 观测 + 评估 + 投影）与训练池策略。
   *
   * 用真实 v8 DDL 建库、把版本写成 8，然后由 `openDatabase` 走**生产迁移路径**升级。
   */
  function seedProductionShapedV8(file: string): void {
    const seeded = new DatabaseSync(file);
    seeded.exec(deriveV8Ddl());
    seeded.prepare("INSERT INTO schema_meta (key, value) VALUES ('schema_version', '8')").run();

    const now = "2026-01-01T00:00:00.000Z";
    seeded
      .prepare(
        "INSERT INTO learner_profile (id, display_name, weekday_minutes, weekend_minutes, created_at, updated_at) VALUES (?,?,?,?,?,?)",
      )
      .run("p1", "Learner", 60, 120, now, now);
    seeded
      .prepare(
        `INSERT INTO exam_paper (id, exam_type, exam_year, session, variant, source_kind,
           verification_status, provenance_note, content_version, package_path, manifest_checksum,
           content_fingerprint, section_count, question_count, imported_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "cet6-2024-12-set1",
        "CET6",
        2024,
        "December",
        "set1",
        "real_past_paper",
        "partially_verified",
        "来源说明",
        4,
        "2024-12-set1",
        "checksum-abc",
        "fingerprint-abc",
        8,
        57,
        now,
        now,
      );
    seeded
      .prepare("INSERT INTO paper_study_state (paper_id, pool, updated_at) VALUES (?,?,?)")
      .run("cet6-2024-12-set1", "mock_reserve", now);

    // Expert 台账：一条已完成会话 + 观测 + 评估 + 投影
    seeded
      .prepare(
        `INSERT INTO learning_run (id, profile_id, paper_id, content_version, section_id, section_type,
           group_ids, status, item_count, started_at, submitted_at, duration_seconds, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "run-1",
        "p1",
        "cet6-2024-12-set1",
        4,
        "reading.careful_reading",
        "reading.careful_reading",
        '["g1"]',
        "completed",
        1,
        now,
        now,
        300,
        now,
      );
    seeded
      .prepare(
        `INSERT INTO performance_event (id, run_id, profile_id, paper_id, content_version, section_id,
           group_id, question_id, question_number, question_kind, response_kind, response_value,
           outcome, duration_seconds, answer_changed, attempt_kind, grading_source, grading_version,
           sequence, occurred_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        "pe-1",
        "run-1",
        "p1",
        "cet6-2024-12-set1",
        4,
        "reading.careful_reading",
        "g1",
        "q1",
        46,
        "mcq",
        "choice",
        "B",
        "correct",
        40,
        0,
        "first_attempt",
        "local_rubric",
        "reading-v1",
        0,
        now,
      );
    seeded
      .prepare(
        `INSERT INTO assessment_event (id, performance_event_id, rubric_version, outcome, score,
           grading_source, supersedes_id, note, assessed_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run("ae-1", "pe-1", "reading-v1", "correct", 1, "local_rubric", null, null, now);
    seeded
      .prepare("INSERT INTO evidence_projection (profile_id, signal, value, computed_at) VALUES (?,?,?,?)")
      .run("p1", "answer.correct", 1, now);
    seeded.close();
  }

  it("真实 v8 库升级后：既有数据一条不少，课程层三张表就位", () => {
    const dir = newTempDir();
    const file = join(dir, "v8-production.db");
      /*
       * Holds the close for the handle opened below, so the finally block can release
       * it even when an assertion throws before the success-path close is reached.
       */
      let cleanup: (() => void) | undefined;
    try {
      seedProductionShapedV8(file);

      // 迁移**之前**的形态（这一份是真正的 v8）
      const probe = new DatabaseSync(file);
      const before = {
        version: Number(
          (probe.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value,
        ),
        learner: Number((probe.prepare("SELECT COUNT(*) AS c FROM learner_profile").get() as { c: number }).c),
        paper: Number((probe.prepare("SELECT COUNT(*) AS c FROM exam_paper").get() as { c: number }).c),
        pool: Number((probe.prepare("SELECT COUNT(*) AS c FROM paper_study_state").get() as { c: number }).c),
        run: Number((probe.prepare("SELECT COUNT(*) AS c FROM learning_run").get() as { c: number }).c),
        event: Number((probe.prepare("SELECT COUNT(*) AS c FROM performance_event").get() as { c: number }).c),
        assessment: Number((probe.prepare("SELECT COUNT(*) AS c FROM assessment_event").get() as { c: number }).c),
        projection: Number((probe.prepare("SELECT COUNT(*) AS c FROM evidence_projection").get() as { c: number }).c),
      };
      expect(before.version, "夹具前提：这必须是一份 v8 库").toBe(8);
      // 夹具前提：v8 库里**没有**课程层表
      const v8Tables = (
        probe.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(v8Tables).not.toContain("course_package");
      probe.close();

      // 走**生产路径**升级（不是测试复刻）
      const db2 = openDatabase(file);
      cleanup = () => db2.close();
      const version = Number(
        (db2.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value,
      );
      expect(version).toBe(SCHEMA_VERSION);
      expect(SCHEMA_VERSION).toBe(9);

      // 数据一条不少
      expect(Number((db2.prepare("SELECT COUNT(*) AS c FROM learner_profile").get() as { c: number }).c)).toBe(before.learner);
      expect(Number((db2.prepare("SELECT COUNT(*) AS c FROM exam_paper").get() as { c: number }).c)).toBe(before.paper);
      expect(Number((db2.prepare("SELECT COUNT(*) AS c FROM paper_study_state").get() as { c: number }).c)).toBe(before.pool);
      expect(Number((db2.prepare("SELECT COUNT(*) AS c FROM learning_run").get() as { c: number }).c)).toBe(before.run);
      expect(Number((db2.prepare("SELECT COUNT(*) AS c FROM performance_event").get() as { c: number }).c)).toBe(before.event);
      expect(Number((db2.prepare("SELECT COUNT(*) AS c FROM assessment_event").get() as { c: number }).c)).toBe(before.assessment);
      expect(Number((db2.prepare("SELECT COUNT(*) AS c FROM evidence_projection").get() as { c: number }).c)).toBe(before.projection);

      // 关键字段逐项核对（不只是行数）
      const paper = db2.prepare("SELECT * FROM exam_paper WHERE id='cet6-2024-12-set1'").get() as Record<string, unknown>;
      expect(Number(paper.content_version)).toBe(4);
      expect(String(paper.source_kind)).toBe("real_past_paper");
      expect(String(paper.verification_status)).toBe("partially_verified");
      expect(String(paper.content_fingerprint)).toBe("fingerprint-abc");
      expect(Number(paper.question_count)).toBe(57);
      expect(String(paper.provenance_note)).toBe("来源说明");

      const event = db2.prepare("SELECT * FROM performance_event WHERE id='pe-1'").get() as Record<string, unknown>;
      expect(Number(event.content_version)).toBe(4);
      expect(String(event.outcome)).toBe("correct");
      expect(String(event.question_id)).toBe("q1");
      expect(String(event.response_value)).toBe("B");

      // **策略不重置**（课程层迁移绝不能碰这个）
      const pool = db2.prepare("SELECT pool FROM paper_study_state WHERE paper_id='cet6-2024-12-set1'").get() as {
        pool: string;
      };
      expect(pool.pool).toBe("mock_reserve");

      // 课程层三张表就位且为空（迁移不伪造历史）
      for (const table of ["course_package", "course_canonical_link", "course_exposure_event"]) {
        expect(Number((db2.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c)).toBe(0);
      }

      // 曝光只追加触发器已就位
      const triggers = (
        db2.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(triggers).toContain("course_exposure_event_append_only_update");
      expect(triggers).toContain("course_exposure_event_append_only_delete");
      // 复核记录同样只追加（Review Fix F3）。**刻意仍是 v9**：
      // 本分支尚未合并，这两条触发器属于同一个 v9 定义的一部分，
      // 不需要为一次实现迭代造一个假的 v10（见 DECISIONS）。
      expect(triggers).toContain("course_canonical_link_append_only_update");
      expect(triggers).toContain("course_canonical_link_append_only_delete");

      // 迁移后的库上，复核记录**确实拦得住**写操作（不只是触发器存在）
      db2
        .prepare(
          `INSERT INTO course_canonical_link (id, course_id, segment_id, course_content_version,
             paper_id, paper_content_version, section_id, group_id, question_id,
             target_scope, verification_status, verification_ref, note, created_at)
           VALUES ('l1','c1','s1',1,'p1',1,'sec',NULL,NULL,'section','verified','ref',NULL,'t')`,
        )
        .run();
      expect(() =>
        db2.prepare("UPDATE course_canonical_link SET verification_ref = 'x' WHERE id = 'l1'").run(),
      ).toThrow(/不可变/);
      expect(() => db2.prepare("DELETE FROM course_canonical_link WHERE id = 'l1'").run()).toThrow(/不可变/);

      db2.close();
    } finally {
      /*
       * Close before the directory is removed: a failed assertion skips the close
       * above, and deleting the file under a live native handle is the condition that
       * produces a native abort rather than a test failure.
       */
      try {
        cleanup?.();
      } catch {
        /* already closed on the success path */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("迁移后 Expert 台账与课程层**都**可用（迁移产物可用，不只是结构存在）", () => {
    const dir = newTempDir();
    const file = join(dir, "v8-usable.db");
      /*
       * Holds the close for the handle opened below, so the finally block can release
       * it even when an assertion throws before the success-path close is reached.
       */
      let cleanup: (() => void) | undefined;
    try {
      seedProductionShapedV8(file);
      const migrated = openDatabase(file);
      cleanup = () => migrated.close();
      const migratedRepos = createSqliteRepositories(migrated);

      // 既有 Expert 能力不受影响
      expect(migratedRepos.learner.getProfile()?.displayName).toBe("Learner");
      expect(migratedRepos.papers.countPapers()).toBe(1);
      expect(
        migratedRepos.expert.listEventsForQuestion("p1", {
          paperId: "cet6-2024-12-set1",
          contentVersion: 4,
          sectionId: "reading.careful_reading",
          groupId: "g1",
          questionId: "q1",
        }),
      ).toHaveLength(1);

      // 课程层可用
      expect(migratedRepos.courses.countPackages()).toBe(0);
      expect(migratedRepos.courses.listPackages()).toEqual([]);

      migrated.close();
    } finally {
      /*
       * Close before the directory is removed: a failed assertion skips the close
       * above, and deleting the file under a live native handle is the condition that
       * produces a native abort rather than a test failure.
       */
      try {
        cleanup?.();
      } catch {
        /* already closed on the success path */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("迁移是幂等的：重复打开同一个库结果不变", () => {
    const dir = newTempDir();
    const file = join(dir, "v8-idempotent.db");
      /*
       * Holds the close for the handle opened below, so the finally block can release
       * it even when an assertion throws before the success-path close is reached.
       */
      let cleanup: (() => void) | undefined;
    try {
      seedProductionShapedV8(file);
      openDatabase(file).close();
      const second = openDatabase(file);
      cleanup = () => second.close();
      const version = Number(
        (second.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value,
      );
      expect(version).toBe(SCHEMA_VERSION);
      expect(Number((second.prepare("SELECT COUNT(*) AS c FROM performance_event").get() as { c: number }).c)).toBe(1);
      // 课程层表没有被重复创建成多份
      const courseTables = (
        second.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'course_%'").all() as Array<{
          name: string;
        }>
      ).map((row) => row.name);
      expect(courseTables.sort()).toEqual(["course_canonical_link", "course_exposure_event", "course_package"]);
      second.close();
    } finally {
      /*
       * Close before the directory is removed: a failed assertion skips the close
       * above, and deleting the file under a live native handle is the condition that
       * produces a native abort rather than a test failure.
       */
      try {
        cleanup?.();
      } catch {
        /* already closed on the success path */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  /**
   * 迁移**失败**注入。
   *
   * 注入点：`course_canonical_link` 预先以一个**列不匹配**的表存在。
   * `CREATE TABLE IF NOT EXISTS` 见到同名表就跳过，随后
   * `CREATE INDEX ... ON course_canonical_link(course_id, segment_id)` 必然抛
   * "no such column: course_id"（已实测确认）。
   *
   * 由此验证三条不变式：版本号不前进；既有数据完好；
   * v9 的其它表不被留下（证明是整体回滚，而不是"前面的成功了"）。
   */
  it("迁移中段失败时整体回滚：版本不前进、既有数据完好、其它新表不留痕", () => {
    const dir = newTempDir();
    const file = join(dir, "v8-atomic.db");
      /*
       * Holds the close for the handle opened below, so the finally block can release
       * it even when an assertion throws before the success-path close is reached.
       */
      let cleanup: (() => void) | undefined;
    try {
      seedProductionShapedV8(file);
      // 把 course_canonical_link 造成错形态，让 v9 迁移在索引那一步真实失败
      const broken = new DatabaseSync(file);
      broken.exec("CREATE TABLE course_canonical_link (bogus TEXT)");
      broken.close();

      let message = "";
      try {
        openDatabase(file);
        throw new Error("本应抛出迁移失败");
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/no such column|course_id/i);

      const verify = new DatabaseSync(file);
      cleanup = () => verify.close();

      // 不变式 1：版本号没有前进（仍是 8）
      const version = (
        verify.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }
      ).value;
      expect(Number(version), "迁移失败后版本号却前进了").toBe(8);

      // 不变式 2：既有数据完好
      expect(Number((verify.prepare("SELECT COUNT(*) AS c FROM learner_profile").get() as { c: number }).c)).toBe(1);
      expect(Number((verify.prepare("SELECT COUNT(*) AS c FROM performance_event").get() as { c: number }).c)).toBe(1);

      // 不变式 3：v9 的其它两张表没有被留下（整体回滚，不是部分提交）
      const tables = (
        verify.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      expect(tables, "迁移失败却留下了 course_package —— 不是整体回滚").not.toContain("course_package");
      expect(tables, "迁移失败却留下了 course_exposure_event —— 不是整体回滚").not.toContain(
        "course_exposure_event",
      );

      verify.close();
    } finally {
      /*
       * Close before the directory is removed: a failed assertion skips the close
       * above, and deleting the file under a live native handle is the condition that
       * produces a native abort rather than a test failure.
       */
      try {
        cleanup?.();
      } catch {
        /* already closed on the success path */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("修好结构后同一个库可以正常迁移（回滚没有留下副作用）", () => {
    const dir = newTempDir();
    const file = join(dir, "v8-recover.db");
      /*
       * Holds the close for the handle opened below, so the finally block can release
       * it even when an assertion throws before the success-path close is reached.
       */
      let cleanup: (() => void) | undefined;
    try {
      seedProductionShapedV8(file);
      const broken = new DatabaseSync(file);
      broken.exec("CREATE TABLE course_canonical_link (bogus TEXT)");
      broken.close();

      expect(() => openDatabase(file)).toThrow();

      // 模拟用户/开发者修好了那个不兼容的表
      const fix = new DatabaseSync(file);
      fix.exec("DROP TABLE course_canonical_link");
      fix.close();

      const recovered = openDatabase(file);
      cleanup = () => recovered.close();
      const version = Number(
        (recovered.prepare("SELECT value FROM schema_meta WHERE key='schema_version'").get() as { value: string }).value,
      );
      expect(version).toBe(SCHEMA_VERSION);

      // 课程层表全部就位，且既有数据仍在
      const tables = (
        recovered.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
      ).map((row) => row.name);
      for (const table of ["course_package", "course_canonical_link", "course_exposure_event"]) {
        expect(tables).toContain(table);
      }
      expect(Number((recovered.prepare("SELECT COUNT(*) AS c FROM learner_profile").get() as { c: number }).c)).toBe(1);
      recovered.close();
    } finally {
      /*
       * Close before the directory is removed: a failed assertion skips the close
       * above, and deleting the file under a live native handle is the condition that
       * produces a native abort rather than a test failure.
       */
      try {
        cleanup?.();
      } catch {
        /* already closed on the success path */
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
