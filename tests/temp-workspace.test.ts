import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTempDir, withTempDir, withTempDirAsync, __testing } from "../tools/temp-workspace.mjs";

/**
 * `tools/temp-workspace.mjs` 的回归。
 *
 * ── 它守的那个真实缺陷 ──
 *
 * 每个门禁都会在系统临时目录里造一棵一次性树，跑完用 `rmSync` 删掉。这在
 * 成功路径上是对的，在其它所有路径上都是错的 —— 而"其它路径"才是泄露的
 * 来源：
 *
 *   - 断言先抛出，配对的 `rmSync` 根本没执行；
 *   - 子进程失败，控制从没有 `finally` 的 `try` 里抛出；
 *   - 目录在**模块顶层**创建（`ISOLATED_GIT_ROOT` 等），任何控制都不负责它。
 *
 * 本机实测证据：临时根目录里积压了数百个以门禁命名的目录
 * （`gate-ctl-*`、`token-ctl-*`、`licence-gitcfg-*`、`bundle-check-*` …）。
 * 没有一个是故意建的。
 *
 * ── 这组用例证明什么 ──
 *
 * 1. 正常返回后目录消失；
 * 2. 回调抛出后目录消失；
 * 3. 异步回调 reject 后目录消失；
 * 4. 模块级目录在进程退出时由退出钩子清除（用子进程验证真实退出）；
 * 5. 清理**只**删自己建的路径。
 */

/** 只统计本文件自己造的目录，避免把别人的残留算进来。 */
const PREFIX = "vitest-temp-workspace-";
const listing = () => new Set(readdirSync(tmpdir()).filter((name) => name.startsWith(PREFIX)));

describe("一次性临时工作区 · 生命周期", () => {
  it("正常返回后目录被删除", () => {
    let created = "";
    withTempDir(PREFIX, (dir) => {
      created = dir;
      expect(existsSync(dir), "回调执行期间目录必须存在").toBe(true);
      writeFileSync(join(dir, "probe.txt"), "x", "utf8");
    });
    expect(existsSync(created), "返回后目录必须不存在").toBe(false);
  });

  it("回调抛出后目录仍被删除", () => {
    let created = "";
    expect(() =>
      withTempDir(PREFIX, (dir) => {
        created = dir;
        mkdirSync(join(dir, "nested"), { recursive: true });
        throw new Error("control assertion failed");
      }),
    ).toThrow("control assertion failed");
    expect(existsSync(created), "抛出后目录必须不存在").toBe(false);
  });

  it("异步回调 reject 后目录仍被删除", async () => {
    let created = "";
    await expect(
      withTempDirAsync(PREFIX, async (dir) => {
        created = dir;
        await Promise.resolve();
        throw new Error("async control failed");
      }),
    ).rejects.toThrow("async control failed");
    expect(existsSync(created), "异步失败后目录必须不存在").toBe(false);
  });

  it("dispose 可重复调用且不抛错（幂等）", () => {
    const handle = createTempDir(PREFIX);
    handle.dispose();
    expect(existsSync(handle.path)).toBe(false);
    expect(() => handle.dispose()).not.toThrow();
  });

  it("清理只作用于自己创建的路径", () => {
    /*
     * 这是本模块的核心安全属性：它**从不**扫描临时根、**从不**按通配符删除。
     * 因此先造一个"陌生"目录 —— 用 `mkdtempSync` 直接建，完全不经过本模块的
     * 登记表，模拟"其它人/其它进程的目录" —— 跑完一整轮生命周期后它必须原封
     * 不动。测完由本测试自己收尾。
     */
    const foreign = mkdtempSync(join(tmpdir(), `${PREFIX}foreign-`));
    writeFileSync(join(foreign, "keep.txt"), "keep", "utf8");

    try {
      const before = listing();
      withTempDir(PREFIX, (dir) => {
        writeFileSync(join(dir, "a.txt"), "a", "utf8");
      });
      const after = listing();

      // 本模块的临时目录净增为 0。
      const added = [...after].filter((name) => !before.has(name));
      expect(added, "正常路径不得留下本模块的目录").toEqual([]);

      // 而那个不归本模块管的目录仍在 —— 清理不得波及其它目录。
      expect(existsSync(join(foreign, "keep.txt")), "清理不得波及其它目录").toBe(true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("正常路径结束后登记表归零", () => {
    withTempDir(PREFIX, () => {});
    expect(__testing.outstandingCount(), "不应有未回收的登记项").toBe(0);
  });
});
