import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TempCleanupError, __testing, withTempDir } from "../tools/temp-workspace.mjs";

/**
 * 定向回归：清理失败与**环境恢复**的关系。
 *
 * ── 它守的那个真实缺陷 ──
 *
 * `tests/expert-training.test.ts` 的 `afterEach` 原先按顺序执行：
 *
 *     close db  →  assertRemoved(repoDir)  →  恢复 CET6_CONTENT_ROOT
 *
 * `assertRemoved` 抛出后，第三步**永不执行**。实测：一次失败的清理之后，
 * `CET6_CONTENT_ROOT` 仍然指向那个即将被删的测试目录，而不是测试前的原值
 * （或在它原本不存在时被保留）。同一 worker 里后续所有测试因此看到的环境
 * 与开始时不同 —— 一个测试的基础设施故障会污染其它测试。
 *
 * 本文件用**同样的结构**复现并锁定修复后的行为：清理失败必须让测试失败，
 * 但环境**无论如何**都要恢复。
 */

const PREFIX = "vt-envrestore-";

describe("清理失败不得阻断环境恢复", () => {
  /**
   * 一个最小的 afterEach 结构替身，保持与真实实现相同的顺序与责任：
   * 关闭 → 清理 → **finally 恢复环境**。
   */
  function runAfterEachShape({
    cleanupFails,
    originalValue,
    cleanupTarget,
  }: {
    cleanupFails: boolean;
    originalValue: string | undefined;
    cleanupTarget: string;
  }): { threw: unknown; envAfter: string | undefined } {
    // beforeEach 的等价动作：把变量指向测试自己的目录。
    process.env.CET6_CONTENT_ROOT = join(cleanupTarget, "content");

    let failure: unknown;
    try {
      // 清理步骤：注入失败，模拟"目录删不掉"。
      if (cleanupFails) {
        throw new TempCleanupError("<temp>/leaf", undefined, "EPERM");
      }
    } catch (error) {
      failure = error;
    } finally {
      /* 关键：无论清理成败，环境必须恢复。 */
      if (originalValue === undefined) delete process.env.CET6_CONTENT_ROOT;
      else process.env.CET6_CONTENT_ROOT = originalValue;
    }

    const envAfter = process.env.CET6_CONTENT_ROOT;
    return { threw: failure, envAfter };
  }

  it("环境变量原本**不存在**：清理失败后仍被删除", () => {
    const dir = mkdtempSync(join(tmpdir(), PREFIX));
    try {
      const { threw, envAfter } = runAfterEachShape({
        cleanupFails: true,
        originalValue: undefined,
        cleanupTarget: dir,
      });
      expect(threw, "清理失败必须被报告").toBeInstanceOf(TempCleanupError);
      expect(envAfter, "原本不存在则必须仍不存在").toBeUndefined();
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("环境变量原本**有值**：清理失败后恢复为该值", () => {
    const dir = mkdtempSync(join(tmpdir(), PREFIX));
    const ORIGINAL = "/synthetic/original/content-root";
    try {
      const { threw, envAfter } = runAfterEachShape({
        cleanupFails: true,
        originalValue: ORIGINAL,
        cleanupTarget: dir,
      });
      expect(threw, "清理失败必须被报告").toBeInstanceOf(TempCleanupError);
      expect(envAfter, "必须恢复为测试前的值").toBe(ORIGINAL);
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("清理成功时环境同样恢复（正常路径语义不变）", () => {
    const dir = mkdtempSync(join(tmpdir(), PREFIX));
    const ORIGINAL = "/synthetic/other-root";
    try {
      const { threw, envAfter } = runAfterEachShape({
        cleanupFails: false,
        originalValue: ORIGINAL,
        cleanupTarget: dir,
      });
      expect(threw, "不该有失败").toBeUndefined();
      expect(envAfter).toBe(ORIGINAL);
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("业务异常与清理异常并存时，两个都被保留", () => {
    /*
     * 主证据是原始业务失败；次证据挂在 cleanupError 上，且不影响环境恢复。
     */
    const dir = mkdtempSync(join(tmpdir(), PREFIX));
    const ORIGINAL = "/synthetic/dual-root";
    try {
      process.env.CET6_CONTENT_ROOT = join(dir, "content");
      let primary: (Error & { cleanupError?: Error }) | undefined;
      try {
        try {
          throw new Error("ORIGINAL-BUSINESS-FAILURE");
        } catch (businessError) {
          // 模拟 afterEach：清理也失败，两者归并
          const cleanupError = new TempCleanupError("<temp>/leaf", undefined, "EBUSY");
          Object.assign(businessError as Error, { cleanupError });
          throw businessError;
        }
      } catch (error) {
        primary = error as Error & { cleanupError?: Error };
      } finally {
        process.env.CET6_CONTENT_ROOT = ORIGINAL;
      }

      expect(primary?.message, "原始业务失败必须保留").toBe("ORIGINAL-BUSINESS-FAILURE");
      expect(primary?.cleanupError, "清理失败必须同时保留").toBeInstanceOf(TempCleanupError);
      expect(process.env.CET6_CONTENT_ROOT, "环境仍必须恢复").toBe(ORIGINAL);
    } finally {
      delete process.env.CET6_CONTENT_ROOT;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("TempCleanupError 不得携带本机路径", () => {
  /** 形如真实 Windows 账户目录的合成绝对路径（含 canary 便于断言）。 */
  const SECRET = ["C:", "Users", "SyntheticAccountName", "AppData", "Local", "Temp", "canary"].join("\\");

  /** 构造一个"真实的" Node 文件系统错误：message/path/syscall 都带绝对路径。 */
  function filesystemError(code = "EPERM"): Error {
    const error = new Error(`${code}: operation not permitted, rmdir '${SECRET}'`);
    Object.assign(error, { code, errno: -4048, syscall: "rmdir", path: SECRET });
    return error;
  }

  /** 扫描一个字符串是否泄露了路径或账户名。 */
  const leaks = (text: string): boolean =>
    text.includes("SyntheticAccountName") || text.includes(SECRET);

  it("message / stack / JSON / inspect 均不含路径", async () => {
    const { inspect } = await import("node:util");
    const error = new TempCleanupError("<temp>/aborted", filesystemError());

    expect(leaks(error.message), `message 泄露：${error.message}`).toBe(false);
    expect(leaks(String(error.stack)), "stack 泄露").toBe(false);
    expect(leaks(JSON.stringify(error, Object.getOwnPropertyNames(error))), "JSON 泄露").toBe(false);
    expect(leaks(inspect(error, { depth: 5 })), "inspect 泄露").toBe(false);
  });

  it("不保留原始 cause 对象", () => {
    const error = new TempCleanupError("<temp>/aborted", filesystemError());
    expect((error as { cause?: unknown }).cause, "不得挂载 cause").toBeUndefined();
    /* 也不得把 path 存成自定义属性 */
    expect(leaks(JSON.stringify(error, Object.getOwnPropertyNames(error)))).toBe(false);
  });

  it("只保留白名单内的错误代码，未知代码收敛为通用常量", () => {
    expect(new TempCleanupError("<temp>/x", filesystemError("EPERM")).code).toBe("EPERM");
    expect(new TempCleanupError("<temp>/x", filesystemError("EBUSY")).code).toBe("EBUSY");
    expect(new TempCleanupError("<temp>/x", filesystemError("EWEIRD")).code).toBe("CLEANUP_FAILED");
    expect(new TempCleanupError("<temp>/x").code).toBe("CLEANUP_FAILED");
    /* 非 Error 抛出物也不能变成路径载体 */
    expect(new TempCleanupError("<temp>/x", SECRET).code).toBe("CLEANUP_FAILED");
  });

  it("通过公开 API 抛出的错误同样不含路径", () => {
    let caught: TempCleanupError | undefined;
    /*
     * The injected `remove` never deletes, so the directory survives by design —
     * that is the condition under test. The test must therefore clean it up itself,
     * or it becomes the leak it is asserting against.
     */
    let created = "";
    try {
      withTempDir("canary-", (dir) => {
        created = dir;
        return "ok";
      }, {
        exists: () => true,
        remove: () => {
          throw filesystemError("EPERM");
        },
      });
    } catch (error) {
      caught = error as TempCleanupError;
    } finally {
      if (created) {
        rmSync(created, { recursive: true, force: true });
        __testing.forget(created);
      }
    }
    expect(caught, "必须抛出").toBeInstanceOf(TempCleanupError);
    expect(caught?.code, "真实代码应被保留").toBe("EPERM");
    expect(leaks(caught?.message ?? ""), "message 泄露").toBe(false);
    expect(leaks(String(caught?.stack ?? "")), "stack 泄露").toBe(false);
  });
});
