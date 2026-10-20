import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { PaperVersionConflictError } from "@/repositories/sqlite/papers";
import { planImport, commitImport, runImport } from "@/services/paper-import";
import { getPaperLibrary, getPaperDetail } from "@/services/papers";
import { NormalizedPackageImporter } from "@/content/paper/importer";
import { createPaperCatalog } from "@/content/paper/catalog";
import { SCHEMA_VERSION } from "@/db/schema";
import type { Repositories } from "@/repositories/ports";
import { buildFixturePackage, writeFixturePackage, sha256Hex, makeSilentWav } from "../scripts/paper-fixture";

/**
 * 导入与原子性测试。
 *
 * 测试环境策略：把 `CET6_CONTENT_ROOT` 指向每个用例自己的临时目录，
 * 因此测试**完全不依赖**用户真实的 private-content 目录 ——
 * 这是内容政策的硬性要求（用户私有内容不进测试）。
 *
 * 夹具共有 7 组听力材料（长对话 2 + 篇章 2 + 讲座 3），因此资产数恒为 7。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

function papersDir(): string {
  return join(contentRoot, "cet6", "papers");
}

function writePackage(dirName: string, fixture = buildFixturePackage()): string {
  return writeFixturePackage(contentRoot, dirName, fixture);
}

function countRows(table: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number | bigint };
  return Number(row.c);
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-papers-"));
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);
});

afterEach(() => {
  // 原生句柄必须确定性关闭：`DatabaseSync` 不是 GC 会及时回收的普通对象。
  try {
    db.close();
  } catch {
    // 已关闭过就不该让清理失败。
  }

  if (previousRoot === undefined) delete process.env.CET6_CONTENT_ROOT;
  else process.env.CET6_CONTENT_ROOT = previousRoot;
  rmSync(contentRoot, { recursive: true, force: true });
});

describe("schema：试卷索引表", () => {
  it("当前 schema 建出三张试卷相关表", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    expect(tables).toContain("exam_paper");
    expect(tables).toContain("paper_asset");
    expect(tables).toContain("paper_study_state");
    // 版本钉死改为跟随常量：这条断言的意图是"全新库带上了最新结构"，
    // 而不是"版本号恰好等于 6"。硬编码数字会让每次 schema 演进而非结构变化时误红。
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(6);
    // v6 新增的内容指纹列必须存在于全新库上（否则查询会崩）
    const columns = db
      .prepare("PRAGMA table_info(exam_paper)")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    expect(columns).toContain("content_fingerprint");
  });

  it("v7 建出 Expert 事实台账四张表（全新库，不依赖迁移）", () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    for (const table of ["learning_run", "performance_event", "assessment_event", "evidence_projection"]) {
      expect(tables, `全新库缺少 Expert 台账表 ${table}`).toContain(table);
    }
  });

  it("试卷正文不落库：exam_paper 里没有题目正文列", () => {
    const columns = db
      .prepare("PRAGMA table_info(exam_paper)")
      .all()
      .map((row) => String((row as { name: unknown }).name));
    for (const forbidden of ["sections", "content", "questions", "body", "passage"]) {
      expect(columns, `exam_paper 不应包含正文列 ${forbidden}`).not.toContain(forbidden);
    }
    expect(columns).toContain("manifest_checksum");
    expect(columns).toContain("content_version");
    expect(columns).toContain("verification_status");
  });

  it("同一年同一场次同一套卷只能有一条记录（数据库层面阻止重复导入）", () => {
    const insert = db.prepare(
      `INSERT INTO exam_paper (id, exam_type, exam_year, session, variant, source_kind, verification_status,
         provenance_note, content_version, package_path, manifest_checksum, section_count, question_count,
         imported_at, updated_at)
       VALUES (?, 'CET6', 2024, 'December', 'set1', 'test_fixture', 'unverified', 'n', 1, ?, ?, 1, 1, 't', 't')`,
    );
    expect(() => insert.run("a", "p", "c")).not.toThrow();
    expect(() => insert.run("b", "p2", "c2")).toThrow();
  });
});

describe("空内容库：诚实为空", () => {
  it("目录不存在时发现 0 份且不报错", () => {
    const plan = planImport(repos);
    expect(plan.report.discovered).toBe(0);
    expect(plan.report.entries).toEqual([]);
    expect(plan.report.counts).toEqual({ insert: 0, update: 0, metadataOnly: 0, unchanged: 0, rejected: 0 });
  });

  it("空库提交是空操作，不产生任何写入", () => {
    const result = runImport(repos);
    expect(result.ok).toBe(true);
    expect(result.written).toBe(0);
    expect(countRows("exam_paper")).toBe(0);
  });

  it("目录存在但没有合法包时同样为 0", () => {
    mkdirSync(papersDir(), { recursive: true });
    mkdirSync(join(papersDir(), "not-a-package"), { recursive: true });
    writeFileSync(join(papersDir(), "not-a-package", "readme.txt"), "没有 paper.json");

    const plan = planImport(repos);
    expect(plan.report.discovered).toBe(0);
  });

  it("库为空时 UI 层真实反映空状态，且不泄漏本机路径（F-2）", () => {
    const library = getPaperLibrary(repos);
    expect(library.counts.total).toBe(0);
    expect(library.summaries).toEqual([]);

    /*
     * 曾经的断言是 `expect(library.contentRoot).toBe(contentRoot)` ——
     * 它**要求**服务层把本机绝对路径交出来（独立评审 F-2）。那条断言本身
     * 就是把缺陷写成契约。
     *
     * 换成更强的两条判据：
     *   1. 服务层只能给**展示标签**，且在任何内容根下都是固定产品字符串；
     *   2. 标签不得含本次测试临时目录的任何成分（那个目录名是随机绝对值）。
     *
     * 第 2 条比"等于某个常量"更强：它证明"无论内容根被指到哪里，
     * 泄漏都发生不了"，而不是"在这个配置下恰好没泄漏"。
     */
    expect(library.contentRootLabel).toBe("private-content");
    expect(library.papersDirLabel).toBe("private-content/cet6/papers");

    const rootBasename = contentRoot.split(/[\\/]/).filter(Boolean).pop() ?? "";
    expect(rootBasename).not.toBe("");
    for (const label of [library.contentRootLabel, library.papersDirLabel]) {
      expect(label).not.toContain(rootBasename);
      expect(label).not.toMatch(/[A-Za-z]:\\/); // 盘符
      expect(label).not.toMatch(/^\//); // POSIX 绝对
      expect(label).not.toContain(tmpdir()); // 临时目录根
    }
  });
});

describe("dry-run：预演不写任何东西", () => {
  it("预演报告新增，但数据库保持零行", () => {
    writePackage("p1");
    const result = runImport(repos, { dryRun: true });

    expect(result.dryRun).toBe(true);
    expect(result.written).toBe(0);
    expect(result.report.counts.insert).toBe(1);
    expect(result.report.entries[0].decision).toBe("insert");
    expect(countRows("exam_paper")).toBe(0);
    expect(countRows("paper_asset")).toBe(0);
  });

  it("预演与真实导入给出同一结论（两者共用同一段判定代码）", () => {
    writePackage("p1");
    const planned = planImport(repos);
    const previewDecision = planned.report.entries[0].decision;

    const committed = commitImport(repos, planned);
    expect(committed.written).toBe(1);
    expect(previewDecision).toBe("insert");
    expect(countRows("exam_paper")).toBe(1);
  });
});

describe("有效导入", () => {
  it("导入后索引与资产都落库，正文仍只在磁盘", () => {
    writePackage("p1");
    const result = runImport(repos, { dryRun: false });

    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(countRows("exam_paper")).toBe(1);
    // 3 个听力大题共 7 组（2 + 2 + 3）→ 7 个音频资产
    expect(countRows("paper_asset")).toBe(7);

    const record = repos.papers.getPaper("fixture-cet6-2024-12-v1");
    expect(record).not.toBeNull();
    expect(record?.questionCount).toBe(57);
    expect(record?.sectionCount).toBe(8);
    expect(record?.pool).toBe("training");
    expect(record?.manifestChecksum).toMatch(/^[0-9a-f]{64}$/);
  });

  it("资产只存元数据与包内相对路径，绝不存绝对路径或字节", () => {
    writePackage("p1");
    runImport(repos);
    const assets = repos.papers.listAssets("fixture-cet6-2024-12-v1");
    expect(assets.length).toBeGreaterThan(0);
    for (const asset of assets) {
      expect(asset.relativePath.startsWith("assets/")).toBe(true);
      expect(asset.relativePath).not.toContain(contentRoot);
      expect(asset.relativePath).not.toMatch(/^[a-zA-Z]:/);
      expect(asset.checksum).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.mimeType).toMatch(/^(audio|image)\//);
    }
  });

  it("重复导入同一份包判定为 unchanged，不重复写入", () => {
    writePackage("p1");
    runImport(repos);
    const second = runImport(repos);
    expect(second.written).toBe(0);
    expect(second.report.counts.unchanged).toBe(1);
    expect(second.report.entries[0].decision).toBe("unchanged");
    expect(countRows("exam_paper")).toBe(1);
  });

  it("不同目录名装同一份内容 → 第二条被判为批内重复，而不是撞唯一约束", () => {
    writePackage("dir-a");
    writePackage("dir-b");

    const plan = planImport(repos);
    expect(plan.report.counts.insert).toBe(1);
    expect(plan.report.counts.rejected).toBe(1);

    const rejected = plan.report.entries.find((entry) => entry.decision === "rejected");
    expect(rejected?.issues[0].message).toContain("dir-a");
    expect(rejected?.detail).toContain("同一份试卷");

    // 关键：整批仍然可用 —— 好的那份正常写入，而不是被约束错误整体回滚
    const committed = commitImport(repos, plan);
    expect(committed.ok, committed.error ?? "").toBe(true);
    expect(committed.written).toBe(1);
    expect(countRows("exam_paper")).toBe(1);
  });
});

describe("版本变更：不能静默把历史作答指向另一道题", () => {
  it("内容变了但 contentVersion 未升 → 拒绝导入", () => {
    writePackage("p1", buildFixturePackage());
    runImport(repos);

    const mutated = buildFixturePackage();
    const sections = mutated.manifest.sections as Record<string, unknown>[];
    const groups = sections[0].groups as Record<string, unknown>[];
    (groups[0].questions as Record<string, unknown>[])[0].prompt = "改过的写作题面";
    writePackage("p1", mutated);

    const result = runImport(repos);
    expect(result.report.counts.rejected).toBe(1);
    expect(result.report.entries[0].issues[0].message).toContain("contentVersion");

    const record = repos.papers.getPaper("fixture-cet6-2024-12-v1");
    expect(record?.contentVersion).toBe(1);
  });

  it("contentVersion 倒退 → 拒绝", () => {
    writePackage("p1", buildFixturePackage({ contentVersion: 3 }));
    runImport(repos);

    writePackage("p1", buildFixturePackage({ contentVersion: 2 }));
    const result = runImport(repos);
    expect(result.report.counts.rejected).toBe(1);
    expect(result.report.entries[0].issues[0].message).toContain("只能前进");
  });

  it("contentVersion 递增 → 升级成功，版本号更新", () => {
    writePackage("p1", buildFixturePackage({ contentVersion: 1 }));
    runImport(repos);

    writePackage("p1", buildFixturePackage({ contentVersion: 2 }));
    const result = runImport(repos);

    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(result.report.counts.update).toBe(1);
    const record = repos.papers.getPaper("fixture-cet6-2024-12-v1");
    expect(record?.contentVersion).toBe(2);
    expect(countRows("exam_paper")).toBe(1);
  });

  it("升级时资产整体替换，不留悬空旧资产", () => {
    writePackage("p1", buildFixturePackage({ contentVersion: 1 }));
    runImport(repos);
    const before = repos.papers.listAssets("fixture-cet6-2024-12-v1");
    expect(before).toHaveLength(7);

    writePackage("p1", buildFixturePackage({ contentVersion: 2 }));
    runImport(repos);

    const after = repos.papers.listAssets("fixture-cet6-2024-12-v1");
    expect(after).toHaveLength(7);
    expect(after.map((asset) => asset.id).sort()).toEqual(before.map((asset) => asset.id).sort());
  });

  it("decideImport 是纯查询：连续调用不改变任何状态", () => {
    const record = {
      id: "fixture-cet6-2024-12-v1",
      examType: "CET6" as const,
      year: 2024,
      session: "December" as const,
      variant: "set1",
      examDate: null,
      sourceKind: "test_fixture" as const,
      verificationStatus: "unverified" as const,
      provenance: { note: "n", reference: null, verificationNote: null },
      contentVersion: 1,
      partial: false,
      packagePath: "p1",
      manifestChecksum: "x".repeat(64),
      contentFingerprint: null,
      sectionCount: 8,
      questionCount: 57,
      importedAt: "",
      updatedAt: "",
      pool: "training" as const,
    };
    const first = repos.papers.decideImport(record);
    const second = repos.papers.decideImport(record);
    expect(first).toEqual(second);
    expect(countRows("exam_paper")).toBe(0);
  });
});

describe("坏包：绝不部分导入", () => {
  it("校验失败的包被拒绝且数据库零写入", () => {
    const fixture = buildFixturePackage();
    const sections = fixture.manifest.sections as Record<string, unknown>[];
    const groups = sections[1].groups as Record<string, unknown>[];
    (groups[0].questions as Record<string, unknown>[])[0].answer = "Z";
    writePackage("bad", fixture);

    const result = runImport(repos);
    expect(result.written).toBe(0);
    expect(result.report.counts.rejected).toBe(1);
    expect(countRows("exam_paper")).toBe(0);
    expect(countRows("paper_asset")).toBe(0);
  });

  it("缺音频文件的包被拒绝（引用了不存在的资产）", () => {
    const fixture = buildFixturePackage();
    writePackage("bad-audio", fixture);
    const assets = fixture.manifest.assets as Record<string, unknown>[];
    rmSync(join(papersDir(), "bad-audio", ...String(assets[0].path).split("/")), { force: true });

    const result = runImport(repos);
    expect(result.written).toBe(0);
    /*
     * 判据是"第一个资产被报了问题"，不是某句具体措辞。
     *
     * 独立评审 F-2 之后，资产不可用的消息不再回显 manifest 声明的路径原文
     * （那等于让一个 JSON 字段决定界面文本），改成一句固定的、
     * 不含输入的中文说明。因此这里断言**语义**（该资产被拒、原因可行动）
     * 与**定位**（`assets[0].path`），而不是某个字面量 —— 否则每次改措辞
     * 都要改测试，而那会诱使"为了让测试过而把消息改回去"。
     */
    const issues = result.report.entries[0].issues;
    expect(issues.some((issue) => issue.path === "assets[0].path")).toBe(true);
    const hit = issues.find((issue) => issue.path === "assets[0].path");
    expect(hit!.message).toMatch(/不可用|不存在|不是常规文件/);
    expect(hit!.message).not.toContain("secret");
    expect(countRows("exam_paper")).toBe(0);
  });

  it("音频字节数与 manifest 不符被拒绝", () => {
    const fixture = buildFixturePackage();
    writePackage("bad-bytes", fixture);
    const assets = fixture.manifest.assets as Record<string, unknown>[];
    writeFileSync(join(papersDir(), "bad-bytes", ...String(assets[0].path).split("/")), makeSilentWav(0.01));

    const result = runImport(repos);
    expect(result.report.entries[0].issues.some((issue) => issue.message.includes("字节数不符"))).toBe(true);
  });

  it("音频内容被替换（长度相同、字节不同）被拒绝：校验和真正生效", () => {
    const fixture = buildFixturePackage();
    writePackage("bad-hash", fixture);
    const assets = fixture.manifest.assets as Record<string, unknown>[];
    const target = join(papersDir(), "bad-hash", ...String(assets[0].path).split("/"));
    const original = readFileSync(target);
    const tampered = Buffer.from(original);
    tampered[tampered.length - 1] = tampered[tampered.length - 1] ^ 0xff;
    expect(sha256Hex(tampered)).not.toBe(sha256Hex(original));
    writeFileSync(target, tampered);

    const result = runImport(repos);
    expect(result.report.entries[0].issues.some((issue) => issue.message.includes("校验和不符"))).toBe(true);
    expect(countRows("exam_paper")).toBe(0);
  });

  it("多个包中有一个坏：好的照常写入，坏的完全没有痕迹", () => {
    writePackage("good-1", buildFixturePackage({ id: "fixture-a", variant: "set1" }));

    const bad = buildFixturePackage({ id: "fixture-b", variant: "set2" });
    const sections = bad.manifest.sections as Record<string, unknown>[];
    (sections[0].groups as Record<string, unknown>[])[0].questions = [];
    writePackage("bad-2", bad);

    const result = runImport(repos);
    expect(result.report.counts.insert).toBe(1);
    expect(result.report.counts.rejected).toBe(1);
    expect(countRows("exam_paper")).toBe(1);
    expect(repos.papers.getPaper("fixture-b")).toBeNull();
  });
});

describe("原子性：写入失败时整批回滚", () => {
  it("事务中途抛错后，数据库回到导入前的真实状态", () => {
    writePackage("p1", buildFixturePackage({ id: "fixture-a", variant: "set1" }));
    writePackage("p2", buildFixturePackage({ id: "fixture-b", variant: "set2" }));

    const plan = planImport(repos);
    expect(plan.report.counts.insert).toBe(2);
    expect(countRows("exam_paper")).toBe(0);

    // 故障注入：在第二个包写入时抛错
    const original = repos.papers.saveImport.bind(repos.papers);
    let calls = 0;
    repos.papers.saveImport = (input, decision) => {
      calls += 1;
      if (calls === 2) throw new Error("注入的写入故障");
      return original(input, decision);
    };

    const result = commitImport(repos, plan);
    expect(result.ok).toBe(false);
    expect(result.written).toBe(0);
    expect(result.error).toContain("整批已回滚");

    // 关键断言：查询数据库确认回滚后的真实状态，而不是只断言抛了异常
    expect(countRows("exam_paper")).toBe(0);
    expect(countRows("paper_asset")).toBe(0);
  });

  it("回滚后修正故障再重试恰好成功一次", () => {
    writePackage("p1", buildFixturePackage({ id: "fixture-a", variant: "set1" }));
    writePackage("p2", buildFixturePackage({ id: "fixture-b", variant: "set2" }));

    const original = repos.papers.saveImport.bind(repos.papers);
    let fail = true;
    let calls = 0;
    repos.papers.saveImport = (input, decision) => {
      calls += 1;
      if (fail && calls === 2) throw new Error("注入的写入故障");
      return original(input, decision);
    };

    const failed = commitImport(repos, planImport(repos));
    expect(failed.ok).toBe(false);
    expect(countRows("exam_paper")).toBe(0);

    fail = false;
    const retried = runImport(repos);
    expect(retried.ok).toBe(true);
    expect(retried.written).toBe(2);
    expect(countRows("exam_paper")).toBe(2);

    // 再跑一次：已是最新，不再重复写入
    const third = runImport(repos);
    expect(third.written).toBe(0);
    expect(countRows("exam_paper")).toBe(2);
  });

  it("资产写入失败时，试卷索引行也不会留下", () => {
    writePackage("p1", buildFixturePackage({ id: "fixture-a", variant: "set1" }));
    writePackage("p2", buildFixturePackage({ id: "fixture-b", variant: "set2" }));

    const plan = planImport(repos);
    const original = repos.papers.saveImport.bind(repos.papers);
    let calls = 0;
    repos.papers.saveImport = (input, decision) => {
      calls += 1;
      if (calls === 2) throw new Error("资产写入故障");
      return original(input, decision);
    };

    commitImport(repos, plan);
    expect(countRows("exam_paper")).toBe(0);
    expect(countRows("paper_asset")).toBe(0);
  });
});

describe("训练池 / 模考保留", () => {
  it("默认属于训练池", () => {
    writePackage("p1");
    runImport(repos);
    expect(repos.papers.getPaper("fixture-cet6-2024-12-v1")?.pool).toBe("training");
  });

  it("可以设为模考保留，且进度状态随之变为 reserved_mock", () => {
    writePackage("p1");
    runImport(repos);
    repos.papers.setPool("fixture-cet6-2024-12-v1", "mock_reserve");

    const detail = getPaperDetail(repos, "fixture-cet6-2024-12-v1");
    expect(detail?.record.pool).toBe("mock_reserve");
    expect(detail?.progress).toBe("reserved_mock");
  });

  it("内容版本升级不会重置用户的策略选择（两件事分表存储）", () => {
    writePackage("p1", buildFixturePackage({ contentVersion: 1 }));
    runImport(repos);
    repos.papers.setPool("fixture-cet6-2024-12-v1", "mock_reserve");

    writePackage("p1", buildFixturePackage({ contentVersion: 2 }));
    runImport(repos);

    const record = repos.papers.getPaper("fixture-cet6-2024-12-v1");
    expect(record?.contentVersion).toBe(2);
    expect(record?.pool).toBe("mock_reserve");
  });

  it("未接入作答记录时进度只能是 untouched 或 reserved_mock（不猜测）", () => {
    writePackage("p1");
    runImport(repos);
    expect(getPaperDetail(repos, "fixture-cet6-2024-12-v1")?.progress).toBe("untouched");
  });

  it("设置未知试卷的归属返回 null 而不是抛错", () => {
    expect(repos.papers.setPool("nonexistent", "mock_reserve")).toBeNull();
  });

  it("库层面按池筛选可用（列表服务如实计数）", () => {
    writePackage("a", buildFixturePackage({ id: "fixture-a", variant: "set1" }));
    writePackage("b", buildFixturePackage({ id: "fixture-b", variant: "set2" }));
    runImport(repos);
    repos.papers.setPool("fixture-b", "mock_reserve");

    const library = getPaperLibrary(repos);
    expect(library.counts.total).toBe(2);
    expect(library.counts.training).toBe(1);
    expect(library.counts.mockReserve).toBe(1);
  });
});

describe("内容包与索引的一致性", () => {
  it("包被删除时状态为 missing，且详情页不展示任何题目", () => {
    writePackage("p1");
    runImport(repos);
    rmSync(join(papersDir(), "p1"), { recursive: true, force: true });

    const detail = getPaperDetail(repos, "fixture-cet6-2024-12-v1");
    expect(detail?.packageStatus).toBe("missing");
    expect(detail?.content).toBeNull();
    expect(detail?.packageIssue).toContain("不存在");
  });

  it("包被手工改动时状态为 drifted，索引仍可读但如实标注", () => {
    writePackage("p1");
    runImport(repos);
    const manifestPath = join(papersDir(), "p1", "paper.json");
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    parsed.variant = "set1-edited";
    writeFileSync(manifestPath, JSON.stringify(parsed), "utf8");

    const library = getPaperLibrary(repos);
    expect(library.counts.drifted).toBe(1);
    expect(library.summaries[0].packageStatus).toBe("drifted");
    expect(library.summaries[0].packageIssue).toContain("校验和");
  });

  it("包结构损坏时状态为 invalid，错误信息带原因", () => {
    writePackage("p1");
    runImport(repos);
    writeFileSync(join(papersDir(), "p1", "paper.json"), "{ 这不是 JSON", "utf8");

    const detail = getPaperDetail(repos, "fixture-cet6-2024-12-v1");
    expect(detail?.packageStatus).toBe("invalid");
    expect(detail?.packageIssue).toContain("JSON");
  });

  it("索引中的包路径同样经过安全解析（库不是可信来源）", () => {
    writePackage("p1");
    runImport(repos);
    /*
     * 直接把库里的 package_path 篡改成一个越界值。这是"库不是可信来源"的
     * 具体形态：一条被污染（或手工编辑）的索引行。
     */
    db.prepare("UPDATE exam_paper SET package_path = ? WHERE id = ?").run("../../../etc", "fixture-cet6-2024-12-v1");

    const detail = getPaperDetail(repos, "fixture-cet6-2024-12-v1");
    expect(detail?.packageStatus).toBe("invalid");

    /*
     * ── 这里曾经断言 `packageIssue` 含"路径不安全"（F-2 同类根因）──
     *
     * 那条消息来自 `UnsafePathError`，而它的形态是
     * `路径不安全：../../../etc（包含 .. 上跳）` —— **回显了被拒绝的输入**。
     * 这个字符串会经 `packageIssue` 出现在界面上，于是"数据库里的任意字符串"
     * 变成了"浏览器里出现的文本"。
     *
     * 判定完全保留（越界即 invalid，一点没松），换的是更强的两条：
     *   1. 消息必须是固定的、不含任何输入回显的说明；
     *   2. 被篡改进去的那个值不得出现在消息里。
     *
     * 第 2 条是真正的隐私判据：它证明"即使库里躺着任意字符串，它也到不了
     * 界面"，而不是"这次恰好说的是一句好听的话"。
     */
    expect(detail?.packageIssue).toBe(
      "索引里记录的内容包路径不安全或无法解析（可能被手工改动过）。请重新导入该内容包以刷新索引。",
    );
    expect(detail?.packageIssue).not.toContain("../../../etc");
    expect(detail?.packageIssue).not.toContain("etc");
    expect(detail?.packageIssue).not.toMatch(/[A-Za-z]:\\/);
  });

  it("详情页读取用 parse 而非 validate：不重新哈希音频，但结构完整", () => {
    writePackage("p1");
    runImport(repos);
    const importer = new NormalizedPackageImporter(papersDir());
    const parsed = importer.parse({ relativePath: "p1", absolutePath: join(papersDir(), "p1") });
    expect(parsed.content.sections).toHaveLength(8);
    expect(parsed.content.assets).toHaveLength(7);
  });
});

describe("目录发现的范围", () => {
  it("只发现直接子目录，且必须含 paper.json", () => {
    writePackage("ok");
    mkdirSync(join(papersDir(), "empty-dir"), { recursive: true });
    mkdirSync(join(papersDir(), ".hidden"), { recursive: true });
    writeFileSync(join(papersDir(), ".hidden", "paper.json"), "{}");

    const nested = buildFixturePackage();
    mkdirSync(join(papersDir(), "parent", "child"), { recursive: true });
    writeFileSync(join(papersDir(), "parent", "child", "paper.json"), JSON.stringify(nested.manifest), "utf8");

    const importer = new NormalizedPackageImporter(papersDir());
    expect(importer.discover().map((handle) => handle.relativePath)).toEqual(["ok"]);
  });
});

describe("catalog 边界：页面不直接碰文件系统", () => {
  it("catalog 只暴露结构与状态，不暴露绝对路径", () => {
    writePackage("p1");
    runImport(repos);
    const catalog = createPaperCatalog(repos);
    const detail = catalog.getDetail("fixture-cet6-2024-12-v1");

    expect(detail?.record.packagePath).toBe("p1");
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain(contentRoot);
    expect(serialized).not.toContain(contentRoot.replace(/\\/g, "/"));
  });
});

describe("版本冲突错误的类型可区分", () => {
  it("包本身的问题与包和库的冲突使用不同错误类型", () => {
    const conflict = new PaperVersionConflictError("x");
    expect(conflict.name).toBe("PaperVersionConflictError");
    expect(conflict).toBeInstanceOf(Error);
  });
});
