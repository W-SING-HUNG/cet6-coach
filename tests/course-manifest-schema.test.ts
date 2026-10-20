import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { validateCourseManifest } from "@/content/course/validator";
import { courseContentFingerprint } from "@/content/course/fingerprint";
import { commitCourseImport, planCourseImport } from "@/services/course-import";
import {
  COURSE_MANIFEST_SCHEMA_VERSION,
  SUPPORTED_COURSE_MANIFEST_SCHEMA_VERSIONS,
  judgeCourseManifestSchemaVersion,
} from "@/domain/course";
import type { Repositories } from "@/repositories/ports";
import { buildCourseFixture, writeCourseFixture, minimalCourseManifest } from "../scripts/course-fixture";

/**
 * manifest `schemaVersion`（序列化契约版本）的测试 —— Review 的 F2。
 *
 * ── 为什么需要它，以及它**不是**什么 ──
 *
 * | 字段 | 回答的问题 |
 * | --- | --- |
 * | `contentVersion` | 这是第几版**语义内容**？ |
 * | `schemaVersion` | 这份 JSON 该按**哪一版契约**解析？ |
 *
 * 本文件要钉死两件事：
 * 1. 缺失 / 非法 / 未来版本必须被**明确地**拒绝（错误信息直说版本问题，
 *    而不是抛出一串无关的下游字段错误）；
 * 2. `schemaVersion` **不得**被当作 `contentVersion` 使用 ——
 *    特别是它**不参与内容指纹**，因此一次纯粹的格式升级不会
 *    让一批本来成立的人工复核链接失效。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type AnyRecord = Record<string, unknown>;

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-schemaver-"));
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

describe("F2 manifest schemaVersion：接受受支持版本", () => {
  it("schemaVersion = 1 是合法的，并被规范化进内容模型", () => {
    const outcome = validateCourseManifest(buildCourseFixture().manifest);
    expect(outcome.issues).toEqual([]);
    expect(outcome.ok).toBe(true);
    expect(outcome.course!.schemaVersion).toBe(1);
    expect(COURSE_MANIFEST_SCHEMA_VERSION).toBe(1);
  });

  it("最小夹具也带 schemaVersion", () => {
    const outcome = validateCourseManifest(minimalCourseManifest());
    expect(outcome.ok).toBe(true);
    expect(outcome.course!.schemaVersion).toBe(COURSE_MANIFEST_SCHEMA_VERSION);
  });

  it("受支持版本集合是显式的单一来源", () => {
    expect([...SUPPORTED_COURSE_MANIFEST_SCHEMA_VERSIONS]).toEqual([COURSE_MANIFEST_SCHEMA_VERSION]);
  });
});

describe("F2 manifest schemaVersion：缺失与非法值必须被明确拒绝", () => {
  it("缺失时拒绝，且错误**直说**是 schemaVersion 的问题", () => {
    const outcome = validateCourseManifest(buildCourseFixture({ omitSchemaVersion: true }).manifest);

    expect(outcome.ok).toBe(false);
    expect(outcome.course).toBeNull();
    // 关键：报的是 schemaVersion，而不是某个无关的下游字段
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0].path).toBe("schemaVersion");
    expect(outcome.issues[0].message).toContain("缺少 schemaVersion");
    // 并且明确区分它与 contentVersion —— 这是最容易混淆的一处
    expect(outcome.issues[0].message).toContain("contentVersion");
  });

  it("0 被拒绝（低于受支持的最小版本）", () => {
    const outcome = validateCourseManifest(buildCourseFixture({ schemaVersion: 0 }).manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0].path).toBe("schemaVersion");
    expect(outcome.issues[0].message).toContain("不是受支持的版本");
  });

  it("负数被拒绝", () => {
    const outcome = validateCourseManifest(buildCourseFixture({ schemaVersion: -1 }).manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0].path).toBe("schemaVersion");
  });

  it("非整数被拒绝", () => {
    const manifest = clone(buildCourseFixture().manifest) as AnyRecord;
    manifest.schemaVersion = 1.5;
    const outcome = validateCourseManifest(manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0].path).toBe("schemaVersion");
    expect(outcome.issues[0].message).toContain("整数");
  });

  it("字符串被拒绝（不得靠隐式转换蒙混过关）", () => {
    for (const bogus of ["1", "v1", ""]) {
      const manifest = clone(buildCourseFixture().manifest) as AnyRecord;
      manifest.schemaVersion = bogus;
      const outcome = validateCourseManifest(manifest);
      expect(outcome.ok, `schemaVersion=${JSON.stringify(bogus)} 应被拒绝`).toBe(false);
      expect(outcome.issues[0].path).toBe("schemaVersion");
      expect(outcome.issues[0].message).toContain("整数");
    }
  });

  it("null / 布尔值 / 对象都被拒绝", () => {
    for (const bogus of [null, true, {}, []]) {
      const manifest = clone(buildCourseFixture().manifest) as AnyRecord;
      manifest.schemaVersion = bogus;
      const outcome = validateCourseManifest(manifest);
      expect(outcome.ok, `schemaVersion=${JSON.stringify(bogus)} 应被拒绝`).toBe(false);
      expect(outcome.issues[0].path).toBe("schemaVersion");
    }
  });

  it("未来版本（2）被拒绝，且错误说明它来自更新的应用", () => {
    const outcome = validateCourseManifest(buildCourseFixture({ schemaVersion: 2 }).manifest);

    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0].path).toBe("schemaVersion");
    expect(outcome.issues[0].message).toContain("高于本应用支持");
    expect(outcome.issues[0].message).toContain("更新的应用");
  });

  it("非常大的未来版本同样被明确拒绝（不越界、不静默接受）", () => {
    const outcome = validateCourseManifest(buildCourseFixture({ schemaVersion: 999 }).manifest);
    expect(outcome.ok).toBe(false);
    expect(outcome.issues[0].path).toBe("schemaVersion");
  });
});

describe("F2 判据是纯函数且可单测（唯一实现）", () => {
  it("judge 对受支持版本返回 ok", () => {
    const verdict = judgeCourseManifestSchemaVersion(1);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.version).toBe(1);
  });

  it("judge 对各种非法输入返回可读原因", () => {
    for (const bogus of [undefined, null, "1", 1.5, 0, -3, 2, 999, true, {}]) {
      const verdict = judgeCourseManifestSchemaVersion(bogus);
      expect(verdict.ok, `${JSON.stringify(bogus)} 应被判定为不可用`).toBe(false);
      if (!verdict.ok) expect(verdict.message.length).toBeGreaterThan(0);
    }
  });
});

describe("F2 schemaVersion 不得冒充 contentVersion", () => {
  it("两者是独立字段：改 schemaVersion 不改变 contentVersion", () => {
    const base = validateCourseManifest(buildCourseFixture({ contentVersion: 7 }).manifest).course!;
    expect(base.schemaVersion).toBe(1);
    expect(base.contentVersion).toBe(7);

    // 高版本 manifest 会被拒；用判据函数直接确认"契约版本"与"内容版本"无关：
    // 内容版本 7 并不会让 schemaVersion 变成 7。
    expect(base.schemaVersion).not.toBe(base.contentVersion);
  });

  it("schemaVersion 为未来版本时**先报版本问题**，而不是下游字段错误", () => {
    // 同时制造一个下游错误（title 为空），确认报的是 schemaVersion。
    // 理由：按未知契约解析时，其余字段的报错可能是误读的产物。
    const manifest = clone(buildCourseFixture({ schemaVersion: 2 }).manifest) as AnyRecord;
    manifest.title = "";
    const outcome = validateCourseManifest(manifest);

    expect(outcome.ok).toBe(false);
    expect(outcome.issues).toHaveLength(1);
    expect(outcome.issues[0].path).toBe("schemaVersion");
  });

  it("**schemaVersion 不参与内容指纹** —— 格式升级不得使复核失效", () => {
    const a = validateCourseManifest(buildCourseFixture({ schemaVersion: 1 }).manifest).course!;

    // 直接构造一个"契约版本不同、其余完全相同"的内容对象，
    // 验证指纹只取决于课程内容。（受支持版本目前只有 1，
    // 因此这里在模型层面比较，而不是靠喂一个会被拒绝的 manifest。）
    const b = { ...a, schemaVersion: 2 };

    expect(b.schemaVersion).not.toBe(a.schemaVersion);
    expect(
      courseContentFingerprint(b),
      "schemaVersion 参与了内容指纹 —— 一次纯序列化升级会让复核链接无谓失效",
    ).toBe(courseContentFingerprint(a));
  });

  it("指纹投影里不含 schemaVersion 字段名（源码级确认）", async () => {
    const { projectCourseForFingerprint } = await import("@/content/course/fingerprint");
    const projection = projectCourseForFingerprint(
      validateCourseManifest(buildCourseFixture().manifest).course!,
    );
    expect(Object.keys(projection)).not.toContain("schemaVersion");
    expect(JSON.stringify(projection)).not.toContain("schemaVersion");
  });

  it("内容真的变了时指纹**仍然**会变（上面那条不是因为指纹失效）", () => {
    const a = validateCourseManifest(buildCourseFixture().manifest).course!;
    const b = validateCourseManifest(
      buildCourseFixture({ readingText: "A completely different body." }).manifest,
    ).course!;
    expect(courseContentFingerprint(b)).not.toBe(courseContentFingerprint(a));
  });
});

describe("F2 schemaVersion 必须出现在导入报告里（可排查）", () => {
  it("导入计划报告暴露被校验通过的 manifest 契约版本", () => {
    writeCourseFixture(contentRoot, "c1", buildCourseFixture({ id: "c1" }));
    const plan = planCourseImport(repos);

    expect(plan.report.entries).toHaveLength(1);
    expect(plan.report.entries[0].manifestSchemaVersion).toBe(1);
    expect(plan.report.entries[0].decision).toBe("insert");
  });

  it("包被拒绝时该字段为 null（不谎报一个版本号）", () => {
    writeCourseFixture(contentRoot, "bad", buildCourseFixture({ id: "bad", omitSchemaVersion: true }));
    const plan = planCourseImport(repos);

    expect(plan.report.entries[0].decision).toBe("rejected");
    expect(plan.report.entries[0].manifestSchemaVersion).toBeNull();
    expect(plan.report.entries[0].issues.some((issue) => issue.path === "schemaVersion")).toBe(true);
  });

  it("缺少 schemaVersion 的包在导入阶段被拒绝且不写入任何行", () => {
    writeCourseFixture(contentRoot, "bad", buildCourseFixture({ id: "bad", omitSchemaVersion: true }));
    const plan = planCourseImport(repos);
    const result = commitCourseImport(repos, plan);

    expect(result.written).toBe(0);
    expect(Number((db.prepare("SELECT COUNT(*) AS c FROM course_package").get() as { c: number }).c)).toBe(0);
  });

  it("合法包能正常导入，且索引里的 contentVersion 来自内容版本（不是契约版本）", () => {
    writeCourseFixture(contentRoot, "c1", buildCourseFixture({ id: "c1", contentVersion: 5 }));
    const result = commitCourseImport(repos, planCourseImport(repos));

    expect(result.written).toBe(1);
    const record = repos.courses.getPackage("c1")!;
    expect(record.contentVersion).toBe(5);
    // SQLite schema 里**没有**为 schemaVersion 加列 —— 它是 manifest 契约，
    // 不是持久化事实（见 DECISIONS：不为纯粹的文件格式版本改库结构）。
    const columns = (
      db.prepare("PRAGMA table_info(course_package)").all() as Array<{ name: string }>
    ).map((row) => row.name);
    expect(columns).not.toContain("schema_version");
  });
});
