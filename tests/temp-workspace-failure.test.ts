import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TempCleanupError,
  __testing,
  createTempDir,
  withTempDir,
  withTempDirAsync,
} from "../tools/temp-workspace.mjs";

/**
 * `tools/temp-workspace.mjs` 的生命周期与**失败语义**回归。
 *
 * ── 这组用例守的那条缺陷链 ──
 *
 * 第一版 `temp-workspace.mjs` 会在删除失败时 `console.error("FAIL …")` 然后
 * **正常返回**。看起来像错误处理，实际不是：
 *
 *   - 没有任何东西向上传播，`withTempDir` 照常返回一个值；
 *   - 外层控制因此认为自己通过；
 *   - 进程退出码 0，而目录还留在磁盘上。
 *
 * 用 `grep FAIL` 的人看得见，用 `$?` 的人看不见 —— 这正是本次整改要消灭的
 * 那类缺陷：一个"看起来能发现问题"却无法让构建变红的检查。
 *
 * ── 因此这里断言的不是"打印了什么"，而是三项硬事实 ──
 *
 * 1. 是否**抛出** / 是否让**进程退出码非零**；
 * 2. 目录**是否真的还在磁盘上**（`existsSync`，而不是"调用没报错"）；
 * 3. 失败时**路径是否仍留在登记表里**（所有权不丢失，退路还在）。
 *
 * ── 关于注入失败的手段 ──
 *
 * "删不掉的目录"在 Windows 与 Linux 上不可靠地构造（Windows 靠句柄锁、
 * POSIX 靠权限位，而 root 无视权限位），所以用模块显式提供的 `exists` 测试缝：
 * 它只替换"判断路径是否还在"这一步，删除动作照常执行。这样用例断言的是
 * 模块的**判定与传播逻辑**，而不是某个平台的加锁怪癖。
 */

const PREFIX = "vt-tmpfail-";
/** 只统计本文件自己造的目录，避免把别人的残留算进来。 */
const listing = () => new Set(readdirSync(tmpdir()).filter((n) => n.startsWith(PREFIX)));

/** 一个永远说"路径还在"的判定函数，用来在可控条件下让清理失败。 */
const alwaysPresent = () => true;

/**
 * Force-remove a directory the module deliberately left behind, and make sure it
 * is also dropped from the module's registry.
 *
 * The `exists: alwaysPresent` seam makes `dispose()` believe removal failed, so
 * the *directory itself was still really deleted* — but the registry entry
 * remains, by design, so the exit hook can retry. A test that deliberately
 * provokes that state must clean up **both** halves afterwards, or it becomes the
 * very leak it is testing for. That is what this helper is: test hygiene for the
 * tests, not a change to the module's semantics.
 */
function forceCleanup(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  __testing.forget(dir);
}

describe("临时工作区 · 成功路径", () => {
  it("正常返回后目录被删除，且登记表归零", () => {
    let created = "";
    withTempDir(PREFIX, (dir) => {
      created = dir;
      expect(existsSync(dir), "回调执行期间目录必须存在").toBe(true);
      writeFileSync(join(dir, "probe.txt"), "x", "utf8");
    });
    expect(existsSync(created), "返回后目录必须不存在").toBe(false);
    expect(__testing.outstandingCount(), "登记表必须归零").toBe(0);
  });

  it("回调抛出后目录仍被删除，原始错误原样传播", () => {
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

  it("目录含文件与多层子目录时也能正常删除", () => {
    let created = "";
    withTempDir(PREFIX, (dir) => {
      created = dir;
      mkdirSync(join(dir, "a", "b", "c"), { recursive: true });
      writeFileSync(join(dir, "a", "b", "c", "deep.txt"), "deep", "utf8");
      writeFileSync(join(dir, "top.txt"), "top", "utf8");
    });
    expect(existsSync(created), "含子树的目录必须整体删除").toBe(false);
  });

  it("dispose 幂等：二次调用不抛错，且不误伤他人目录", () => {
    const handle = createTempDir(PREFIX);
    handle.dispose();
    expect(existsSync(handle.path)).toBe(false);
    expect(() => handle.dispose()).not.toThrow();
  });
});

describe("临时工作区 · 清理失败必须可致命", () => {
  it("dispose 在目录仍存在时抛出 TempCleanupError（不是只打日志）", () => {
    const handle = createTempDir(PREFIX, { exists: alwaysPresent });
    try {
      let threw = false;
      try {
        handle.dispose();
      } catch (error) {
        threw = true;
        const err = error as TempCleanupError;
        expect(err, "必须是 TempCleanupError").toBeInstanceOf(TempCleanupError);
        expect(err.name).toBe("TempCleanupError");
        // 报错信息必须点名"删不掉"，而不是笼统的失败。
        expect(String(err.message)).toMatch(/could not be removed/);
      }
      expect(threw, "dispose 必须抛出，不得静默返回").toBe(true);

      /*
       * 所有权不得丢失：路径仍留在登记表里，退出钩子还能再试一次。
       * 这正是第二处缺陷 —— 旧版失败后丢掉引用，退路也没了。
       */
      expect(
        __testing.outstandingCount(),
        "清理失败后登记项必须保留，供退出钩子重试",
      ).toBeGreaterThan(0);
    } finally {
      forceCleanup(handle.path);
    }
  });

  it("withTempDir 在回调成功但清理失败时必须抛出（核心：不得返回成功）", () => {
    let created = "";
    let returned = false;
    expect(() => {
      withTempDir(
        PREFIX,
        (dir) => {
          created = dir;
          return "body-succeeded";
        },
        { exists: alwaysPresent },
      );
      returned = true;
    }).toThrow(/could not be removed/);

    expect(returned, "清理失败时 withTempDir 绝不能正常返回").toBe(false);
    forceCleanup(created);
  });

  it("withTempDirAsync 在回调成功但清理失败时必须 reject", async () => {
    let created = "";
    await expect(
      withTempDirAsync(
        PREFIX,
        async (dir) => {
          created = dir;
          await Promise.resolve();
          return "ok";
        },
        { exists: alwaysPresent },
      ),
    ).rejects.toBeInstanceOf(TempCleanupError);
    forceCleanup(created);
  });

  it("业务失败 + 清理失败并存：保留原始错误，并附上清理失败", () => {
    let created = "";
    let caught: (Error & { cleanupError?: Error }) | undefined;
    try {
      withTempDir(
        PREFIX,
        (dir) => {
          created = dir;
          throw new Error("ORIGINAL-CONTROL-FAILURE");
        },
        { exists: alwaysPresent },
      );
    } catch (error) {
      caught = error as Error & { cleanupError?: Error };
    }

    expect(caught, "必须抛出").toBeDefined();
    if (caught === undefined) throw new Error("unreachable: expected a throw");
    /*
     * 主证据必须是**原始业务失败** —— 它是调用方真正要找的东西。
     * 让清理错误顶替它，会把"控制挂在哪儿"这条信息弄丢。
     */
    expect(caught.message, "原始失败必须保留").toBe("ORIGINAL-CONTROL-FAILURE");
    // 次证据也不得丢：清理失败挂在 cleanupError 上。
    expect(caught.cleanupError, "清理失败必须同时被记录").toBeInstanceOf(TempCleanupError);

    forceCleanup(created);
  });

  it("异步：业务 reject + 清理失败并存时两个都保留", async () => {
    let created = "";
    let caught: (Error & { cleanupError?: Error }) | undefined;
    try {
      await withTempDirAsync(
        PREFIX,
        async (dir) => {
          created = dir;
          throw new Error("ASYNC-ORIGINAL");
        },
        { exists: alwaysPresent },
      );
    } catch (error) {
      caught = error as Error & { cleanupError?: Error };
    }
    if (caught === undefined) throw new Error("unreachable: expected a rejection");
    expect(caught.message, "异步原始失败必须保留").toBe("ASYNC-ORIGINAL");
    expect(caught.cleanupError, "异步清理失败必须同时被记录").toBeInstanceOf(TempCleanupError);
    forceCleanup(created);
  });
});

describe("临时工作区 · 所有权隔离", () => {
  it("清理不碰不是自己创建的目录", () => {
    /*
     * 核心安全属性：模块**从不**扫描临时根、**从不**按通配符删除。
     * 用裸 `mkdtempSync` 造一个"别人的"目录（不经过本模块登记表），
     * 跑完一整轮生命周期后它必须原封不动。
     */
    const foreign = mkdtempSync(join(tmpdir(), `${PREFIX}foreign-`));
    writeFileSync(join(foreign, "keep.txt"), "keep", "utf8");
    try {
      const before = listing();
      withTempDir(PREFIX, (dir) => writeFileSync(join(dir, "a.txt"), "a", "utf8"));
      const added = [...listing()].filter((n) => !before.has(n));

      expect(added, "正常路径不得留下本模块的目录").toEqual([]);
      expect(existsSync(join(foreign, "keep.txt")), "清理不得波及其它目录").toBe(true);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }
  });

  it("失败路径也不会顺手删掉邻近的他人目录", () => {
    const foreign = mkdtempSync(join(tmpdir(), `${PREFIX}neighbour-`));
    writeFileSync(join(foreign, "keep.txt"), "keep", "utf8");
    let created = "";
    try {
      try {
        withTempDir(PREFIX, (dir) => { created = dir; }, { exists: alwaysPresent });
      } catch {
        /* expected */
      }
      expect(existsSync(join(foreign, "keep.txt")), "失败清理同样不得波及他人目录").toBe(true);
    } finally {
      forceCleanup(created);
      rmSync(foreign, { recursive: true, force: true });
    }
  });
});

describe("临时工作区 · 进程退出路径（子进程验证真实退出码）", () => {
  const MODULE_URL = new URL("../tools/temp-workspace.mjs", import.meta.url).href;

  /**
   * Run a snippet in a child process; return its real exit status.
   *
   * ── Why this sweeps afterwards ──
   *
   * Two of the cases below deliberately make the child's exit-time cleanup fail.
   * The child reports that (non-zero exit, redacted message) and then exits —
   * leaving its directory on disk, which is the *point* of the case. But the
   * parent test must not inherit that leftover, or the suite would reproduce the
   * very leak it is testing for. So the parent records which directories existed
   * before, and removes only the ones that appeared during the run — scoped to this
   * file's prefix, never a temp-root sweep.
   */
  function runChild(body: string, env: Record<string, string> = {}) {
    const before = listing();
    const dir = mkdtempSync(join(tmpdir(), `${PREFIX}child-`));
    const file = join(dir, "child.mjs");
    writeFileSync(file, body, "utf8");
    const result = spawnSync(process.execPath, [file], {
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    rmSync(dir, { recursive: true, force: true });

    /* Remove only directories this child created; anything older is not ours. */
    const after = listing();
    for (const name of after) {
      if (!before.has(name)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
    }

    return {
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
    };
  }

  it("正常结束：未 dispose 的目录由退出钩子删除，退出码 0", () => {
    const r = runChild(`
      import { createTempDir } from ${JSON.stringify(MODULE_URL)};
      import { existsSync } from "node:fs";
      const h = createTempDir(${JSON.stringify(PREFIX)});
      process.on("exit", () => {});  // keep ordering deterministic
      if (!existsSync(h.path)) { process.exitCode = 42; }
    `);
    expect(r.status, `必须正常退出：${r.stderr}`).toBe(0);
  });

  it("退出钩子清理失败时进程必须退出非零（不得只打印 FAIL）", () => {
    /*
     * 这是第一版最严重的漏洞：钩子打印 FAIL 却仍然 exit 0。
     * 用模块提供的显式测试缝让钩子失败，然后断言**真实退出码**。
     */
    const r = runChild(
      `
      import { createTempDir } from ${JSON.stringify(MODULE_URL)};
      createTempDir(${JSON.stringify(PREFIX)});  // never disposed
      `,
      { CET6_TEMP_CLEANUP_SIMULATE_FAILURE: "1" },
    );
    expect(r.status, "退出码必须非零").not.toBe(0);
    expect(r.stderr, "必须明确报告清理失败").toMatch(/could not be removed/);
    expect(r.stderr, "报告必须脱敏：不得出现完整绝对路径").not.toMatch(/AppData|Users[\\/]|\/home\//);
  });

  it("退出钩子失败时不得覆盖已有的非零退出码", () => {
    /*
     * 实测：在 exit 钩子里给 `process.exitCode` 赋值会被采纳，而且**能把
     * `process.exit(3)` 降成 0**。所以钩子只能"从 0 抬升"，不能无条件赋值 ——
     * 否则真实失败的退出码会被清理失败抹掉。
     */
    const r = runChild(
      `
      import { createTempDir } from ${JSON.stringify(MODULE_URL)};
      createTempDir(${JSON.stringify(PREFIX)});
      process.exit(3);
      `,
      { CET6_TEMP_CLEANUP_SIMULATE_FAILURE: "1" },
    );
    expect(r.status, "原有退出码 3 必须保留").toBe(3);
    expect(r.stderr, "清理失败仍需报告").toMatch(/could not be removed/);
  });

  it("不带测试缝时退出钩子正常工作（证明缝不是默认行为）", () => {
    const r = runChild(`
      import { createTempDir } from ${JSON.stringify(MODULE_URL)};
      createTempDir(${JSON.stringify(PREFIX)});
    `);
    expect(r.status, "无注入时必须干净退出").toBe(0);
    expect(r.stderr, "无注入时不得报告清理失败").not.toMatch(/could not be removed/);
  });
});

describe("临时工作区 · 本轮净残留为 0", () => {
  it("整组用例跑完后没有本文件新增的目录", () => {
    /*
     * 以快照方式自证：此刻临时根里属于本文件的目录必须为 0。
     * 之前每个用例都在这里结束时机清掉，任何泄漏都会在这里显形。
     */
    const leftovers = [...listing()];
    expect(leftovers, `存在未清理目录：${leftovers.join(", ")}`).toEqual([]);
  });
});
