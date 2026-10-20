import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestDb, type DbHandle } from "@/db/client";
import { createSqliteRepositories } from "@/repositories/sqlite";
import { createPaperCatalog } from "@/content/paper/catalog";
import { runImport } from "@/services/paper-import";
import type { Repositories } from "@/repositories/ports";
import { buildFixturePackage, writeFixturePackage } from "../scripts/paper-fixture";

/**
 * 资产服务边界测试。
 *
 * 这是全应用唯一一处"把用户可控标识变成服务端文件读取"的地方，
 * 因此它的约束必须被穷举：客户端**只能**请求已索引的 audio/image 资产，
 * 不能借它读取任何其它文件。
 */

let contentRoot: string;
let db: DbHandle;
let repos: Repositories;
let previousRoot: string | undefined;

const PAPER_ID = "fixture-cet6-2024-12-v1";

function papersDir(): string {
  return join(contentRoot, "cet6", "papers");
}

beforeEach(() => {
  previousRoot = process.env.CET6_CONTENT_ROOT;
  contentRoot = mkdtempSync(join(tmpdir(), "cet6-asset-"));
  process.env.CET6_CONTENT_ROOT = contentRoot;
  db = createTestDb();
  repos = createSqliteRepositories(db);
  writeFixturePackage(contentRoot, "p1", buildFixturePackage());
  runImport(repos);
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
  try {
    rmSync(contentRoot, { recursive: true, force: true });
  } catch {
    /* Windows 上 WAL 句柄可能短暂占用，忽略 */
  }
});

describe("resolveAssetPath：只服务已索引的媒体资产", () => {
  it("能解析已索引的音频资产", () => {
    const catalog = createPaperCatalog(repos);
    const assets = repos.papers.listAssets(PAPER_ID);
    const audio = assets.find((asset) => asset.kind === "audio");
    expect(audio).toBeDefined();

    const resolved = catalog.resolveAssetPath(PAPER_ID, audio!.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.mimeType).toBe("audio/wav");
    expect(resolved!.absolutePath.startsWith(contentRoot)).toBe(true);
  });

  it("未知资产 id → null（不猜路径）", () => {
    const catalog = createPaperCatalog(repos);
    expect(catalog.resolveAssetPath(PAPER_ID, "no-such-asset")).toBeNull();
  });

  it("未知试卷 id → null", () => {
    const catalog = createPaperCatalog(repos);
    expect(catalog.resolveAssetPath("no-such-paper", "whatever")).toBeNull();
  });

  it("客户端无法用资产 id 去读任意文件（标识不是路径）", () => {
    const catalog = createPaperCatalog(repos);
    // 各种"看起来像路径"的输入都必须在索引查找阶段就落空
    for (const candidate of [
      "../../../../etc/passwd",
      "..%2f..%2fpackage.json",
      "assets/../../../package.json",
      "C:/Windows/win.ini",
      "/etc/passwd",
      "paper.json",
    ]) {
      expect(catalog.resolveAssetPath(PAPER_ID, candidate), candidate).toBeNull();
    }
  });

  it("索引中的资产路径被篡改为越界时，解析被拒（库不是可信来源）", () => {
    const assets = repos.papers.listAssets(PAPER_ID);
    const audio = assets.find((asset) => asset.kind === "audio")!;
    db.prepare("UPDATE paper_asset SET relative_path = ? WHERE paper_id = ? AND id = ?").run(
      "../../../../outside.wav",
      PAPER_ID,
      audio.id,
    );

    const catalog = createPaperCatalog(repos);
    expect(catalog.resolveAssetPath(PAPER_ID, audio.id)).toBeNull();
  });

  it("索引中的资产类型被改成非媒体时，解析被拒（类型白名单）", () => {
    const assets = repos.papers.listAssets(PAPER_ID);
    const audio = assets.find((asset) => asset.kind === "audio")!;
    db.prepare("UPDATE paper_asset SET mime_type = ? WHERE paper_id = ? AND id = ?").run(
      "text/plain",
      PAPER_ID,
      audio.id,
    );

    const catalog = createPaperCatalog(repos);
    expect(catalog.resolveAssetPath(PAPER_ID, audio.id)).toBeNull();
  });

  it("资产文件在磁盘上消失时 → null（不返回悬空路径）", () => {
    const assets = repos.papers.listAssets(PAPER_ID);
    const audio = assets.find((asset) => asset.kind === "audio")!;
    rmSync(join(papersDir(), "p1", ...audio.relativePath.split("/")), { force: true });

    const catalog = createPaperCatalog(repos);
    expect(catalog.resolveAssetPath(PAPER_ID, audio.id)).toBeNull();
  });

  it("资产被换成指向根外的符号链接时 → null", () => {
    const outside = mkdtempSync(join(tmpdir(), "cet6-outside-asset-"));
    try {
      writeFileSync(join(outside, "secret.wav"), "classified");
      const assets = repos.papers.listAssets(PAPER_ID);
      const audio = assets.find((asset) => asset.kind === "audio")!;
      const target = join(papersDir(), "p1", ...audio.relativePath.split("/"));
      rmSync(target, { force: true });
      try {
        symlinkSync(join(outside, "secret.wav"), target, "file");
      } catch {
        return; // 环境不允许创建符号链接
      }
      const catalog = createPaperCatalog(repos);
      expect(catalog.resolveAssetPath(PAPER_ID, audio.id)).toBeNull();
    } finally {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
  });

  it("包目录被整段删除时 → null", () => {
    rmSync(join(papersDir(), "p1"), { recursive: true, force: true });
    const assets = repos.papers.listAssets(PAPER_ID);
    const catalog = createPaperCatalog(repos);
    expect(catalog.resolveAssetPath(PAPER_ID, assets[0].id)).toBeNull();
  });
});

describe("资产服务：不暴露任何非索引文件", () => {
  it("包内的非资产文件（paper.json）不可通过资产接口取得", () => {
    const catalog = createPaperCatalog(repos);
    expect(catalog.resolveAssetPath(PAPER_ID, "paper.json")).toBeNull();
  });
  it("内容根之外的既有文件无法被解析为资产", () => {
    const outside = mkdtempSync(join(tmpdir(), "cet6-outside-any-"));
    try {
      const outsideFile = join(outside, "target.wav");
      writeFileSync(outsideFile, "x");
      mkdirSync(join(contentRoot, "cet6", "papers", "p1", "assets"), { recursive: true });

      // 即便把相对路径写成能"回到"外部文件的形状，也必须被拒
      const assets = repos.papers.listAssets(PAPER_ID);
      db.prepare("UPDATE paper_asset SET relative_path = ? WHERE paper_id = ? AND id = ?").run(
        `assets/../../../../${outside.split(/[\\/]/).slice(-2).join("/")}/target.wav`,
        PAPER_ID,
        assets[0].id,
      );

      const catalog = createPaperCatalog(repos);
      expect(catalog.resolveAssetPath(PAPER_ID, assets[0].id)).toBeNull();
    } finally {
      try {
        rmSync(outside, { recursive: true, force: true });
      } catch {
        /* 忽略 */
      }
    }
  });
});
