/**
 * Disposable temporary workspaces for the release gates.
 *
 * ── The defect this exists to close ──
 *
 * Every gate that proves something builds a throwaway tree in the system temp
 * root and deletes it with `rmSync` at the end of the control. That is correct on
 * the happy path and wrong on every other path, which is the only path that
 * matters for a leak:
 *
 *   - an assertion throws before the matching `rmSync` runs;
 *   - a child process fails, so the control throws out of a `try` that had no
 *     `finally`;
 *   - the module creates its directory at **top level**, before any control runs,
 *     so no control is responsible for it at all.
 *
 * The evidence was on the machine that wrote this file: the temp root held
 * hundreds of directories named after the gates (`gate-ctl-*`, `token-ctl-*`,
 * `licence-gitcfg-*`, `bundle-check-*` …), accumulated over days of runs. Not one
 * of them was created on purpose.
 *
 * ── Why a shared helper rather than a `finally` in every control ──
 *
 * A per-control `finally` fixes the two throw paths above but not the third: the
 * module-level directory is created before the first control, and a `finally`
 * inside a block cannot cover it. It also leaves the next contributor free to
 * write a control without one, which is how the current state arose. So the
 * guarantee is moved into a facility that owns the whole lifetime of the
 * directory:
 *
 *   1. **Scope disposal.** `withTempDir` removes the directory when the callback
 *      returns *or throws* — the `try/finally` shape, written once.
 *   2. **Process-exit safety net.** Every directory created through this module is
 *      registered, and a single `process.on("exit")` handler removes whatever is
 *      still outstanding. `process.exit()` runs `exit` handlers synchronously, so
 *      this also covers the `process.exit(1)` bail-outs the controls use.
 *   3. **Cleanup failure is fatal.** A removal that fails must make the *process*
 *      fail, not just print. See the section below — the previous revision got
 *      this wrong, and printing a line that begins with "FAIL" while exiting 0 is
 *      the same defect one level down.
 *
 * ── Why "report and continue" was still wrong ──
 *
 * The first revision of this file removed the directory, and on failure called
 * `reportCleanupFailure()`, which wrote a line beginning with `FAIL` to stderr and
 * returned. That looks like failure handling and is not: nothing propagated, so
 * `withTempDir` returned a value, the surrounding control counted itself as having
 * passed, and the process exited 0 while a directory stayed behind. A reader
 * grepping the log for `FAIL` would see it; a reader checking `$?` would not.
 *
 * That is precisely the class of defect this whole engagement is about — a check
 * that appears to detect something and cannot fail the build — so the behaviour is
 * now:
 *
 *   - `dispose()` **throws** when the directory is still present afterwards;
 *   - `withTempDir` / `withTempDirAsync` therefore reject/throw on a failed
 *     cleanup, on the success path as well as the throwing path;
 *   - when the body already failed, the original error wins and the cleanup error
 *     is attached as `cleanupError`, so the *primary* failure is preserved and the
 *     cleanup failure is still reported;
 *   - the exit handler forces a **non-zero** exit code.
 *
 * ── Exit-code mechanics, measured rather than assumed ──
 *
 * `process.exitCode` assignment inside an `exit` handler *is* honoured, and it can
 * also **lower** an already-set code (`process.exit(3)` becomes 0 if the handler
 * assigns 0). Verified directly:
 *
 *     process.exit(3) + handler assigns 1  →  1
 *     process.exit(3) + handler assigns 0  →  0     ← the trap
 *     natural exit, exitCode 5, handler assigns 9 → 9
 *
 * So the handler only ever *raises* a zero/undefined code and never overwrites a
 * non-zero one. That keeps a real failure's exit code intact while making a
 * cleanup-only failure visible to `$?`.
 *
 * ── What it deliberately does NOT do ──
 *
 * It never scans the temp root and never deletes anything it did not create. A
 * "clean up all `gate-ctl-*`" sweep would remove another user's or another
 * concurrent run's directories, and a pattern-based sweep is exactly the kind of
 * blunt instrument that turns a hygiene fix into data loss. Ownership here is
 * exclusive: the helper only ever removes paths it created itself, in this
 * process.
 *
 * ── What it does NOT guarantee, stated instead of implied ──
 *
 * `process.on("exit")` does not run when the process is killed by a signal the
 * runtime cannot intercept and does not run at all after SIGKILL, a machine reset
 * or a power loss. **No cleanup can be promised for those cases**, and none is
 * claimed here. The scope disposal path (`withTempDir`) covers them only insofar
 * as the code returns normally; an abrupt kill leaves the directory behind and the
 * next run will not clean it, because ownership is per-process. This is a real
 * limitation of every userspace cleanup mechanism, not something this module
 * solves.
 *
 * Linux CI and Windows both work: `mkdtempSync` resolves through `os.tmpdir()`,
 * and removal retries a few times because Windows releases directory handles
 * slightly after the child process that held them exits.
 */

import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Paths this process created and has not yet removed.
 *
 * Keyed by the path `mkdtempSync` returned, with the realpath stored alongside so
 * a temp root that is itself a link (`/tmp` → `/private/tmp` on macOS) cannot make
 * removal miss.
 *
 * ── Why a Map and not a Set of realpaths ──
 *
 * The first revision stored only the realpath. That made ownership untraceable
 * from the caller's own handle: on Windows the 8.3 short form of a path
 * (`<user>~1`) and its long form are *different strings even though they name the
 * same directory*, so any bookkeeping keyed on one could not find an entry stored
 * under the other. A registry whose keys the caller cannot reproduce is a registry
 * that cannot be reconciled — and `__testing.forget` demonstrably failed to remove
 * its entry because of exactly that. Keying on the created path fixes it; the
 * realpath is kept for removal.
 *
 * @type {Map<string, string>}
 */
const outstanding = new Map();

/** Set once the exit handler is installed, so it is installed at most once. */
let exitHookInstalled = false;

/** True once the exit handler has started removing; new registrations are then futile. */
let finalising = false;

/**
 * Error codes that are safe to print.
 *
 * A whitelist rather than a blacklist: an unrecognised code becomes the generic
 * `CLEANUP_FAILED`, so a future Node version introducing a code that embeds a path
 * cannot start leaking through this channel. The set is exactly the outcomes a
 * directory removal can produce.
 */
const SAFE_ERROR_CODES = new Set([
  "EACCES",
  "EBUSY",
  "EEXIST",
  "EISDIR",
  "EMFILE",
  "ENOENT",
  "ENOTDIR",
  "ENOTEMPTY",
  "EPERM",
  "EROFS",
  "CLEANUP_FAILED",
]);

/**
 * Reduce anything thrown by the filesystem to a **safe error code**.
 *
 * ── Why the message is not used ──
 *
 * A Node filesystem error carries `<CODE>: <description>, <syscall> '<absolute path>'`
 * in its `message`, plus `errno`, `syscall` and `path` properties. That absolute
 * path is `<home>/AppData/Local/Temp/...` on Windows and `/home/<runner>/...` on
 * Linux — the account name. Redacting only the `displayPath` argument was
 * therefore not enough: the leak arrived through the *cause*, and through the
 * `stack`, which embeds the message.
 *
 * Only `code` survives, and only when it is on the allow-list above. Everything
 * else about the original error — message, path, errno, syscall, stack, the object
 * itself — is deliberately dropped. Nothing downstream can re-expose what was never
 * retained.
 *
 * @param {unknown} error
 * @returns {string}
 */
function safeErrorCode(error) {
  if (typeof error === "object" && error !== null) {
    const code = /** @type {{ code?: unknown }} */ (error).code;
    if (typeof code === "string" && SAFE_ERROR_CODES.has(code)) return code;
  }
  return "CLEANUP_FAILED";
}

/**
 * A cleanup failure, carrying a **redacted** display path and a safe error code.
 *
 * ── What this error must never contain ──
 *
 * The previous revision redacted `displayPath` but then concatenated
 * `cause.message` into the message and kept the whole `cause` object on the error.
 * A Node filesystem error's message embeds the absolute path it failed on, so the
 * full account-bearing path reappeared in:
 *
 *   - `error.message`
 *   - `error.stack` (which prefixes the message)
 *   - `error.cause.message`
 *   - `JSON.stringify(error)`
 *   - `util.inspect(error)` in a console dump or a test failure
 *
 * The error is now built **only** from a safe code and the redacted leaf name.
 * The original cause is not stored at all — not under `cause`, not as a property,
 * not in a closure that `inspect` could reach — because the only thing that would
 * be gained from it is the path we are trying to keep out of the log.
 *
 * Semantics preserved: this is still a real `Error` subclass, still thrown, and
 * still makes the process exit non-zero. Privacy is achieved by removing the
 * sensitive *data*, never by swallowing the failure or resetting an exit code.
 */
export class TempCleanupError extends Error {
  /**
   * @param {string} display safe, already-redacted identifier
   * @param {unknown} [cause] inspected for a safe code only, then discarded
   * @param {string} [codeOverride] pre-validated code, for callers that already
   *   reduced the failure themselves and therefore have no cause to pass
   */
  constructor(display, cause, codeOverride) {
    const code =
      codeOverride !== undefined
        ? SAFE_ERROR_CODES.has(codeOverride)
          ? codeOverride
          : "CLEANUP_FAILED"
        : cause === undefined
          ? "CLEANUP_FAILED"
          : safeErrorCode(cause);
    super(`temporary workspace could not be removed: ${display} (${code})`);
    this.name = "TempCleanupError";
    /** Redacted identifier: `<temp>/<mkdtemp leaf>`. Never an absolute path. */
    this.displayPath = display;
    /** Whitelisted code only. */
    this.code = code;
    /*
     * `cause` is intentionally NOT assigned. Assigning it would put the raw
     * filesystem error back within reach of `inspect`, `JSON.stringify` and any
     * structured dump, which is the leak this class exists to prevent.
     */
  }
}

/**
 * Render a temp path for a log **without** leaking the user or machine.
 *
 * A CI log is as public as the repository, and a temp path is
 * `<home>/AppData/Local/Temp/...` on Windows and `/home/<runner>/...` on Linux —
 * that is, it contains the account name. Printing it whole would move a private
 * detail into a public log to report a cleanup problem. Only the final segment
 * (the `mkdtemp` name, which this module generated) and a stable marker are shown,
 * which is enough to find the directory on the machine that produced the log.
 *
 * @param {string} path
 * @returns {string}
 */
function redactTempPath(path) {
  const base = path.split(/[\\/]/).filter(Boolean).pop() ?? "";
  return `<temp>${"/"}${base}`;
}

/**
 * Remove one path, retrying briefly.
 *
 * Windows keeps a directory handle open for a moment after the process that used
 * it exits, so a single `rmSync` can fail with `EBUSY`/`EPERM` on a directory
 * that is about to become removable. Retrying is not papering over a bug here:
 * the handle is genuinely gone a few milliseconds later.
 *
 * "Removed" means **verified absent**, not "the call did not throw": `rmSync` with
 * `force: true` can return without error while the path survives (a concurrent
 * handle, a partially deleted tree). The existence check is what makes the
 * reported result trustworthy.
 *
 * @param {string} path
 * @param {(path: string) => boolean} existsFn injected so tests can force failure
 * @param {(path: string) => void} [removeFn] injected so a test can raise a real
 *   filesystem error (one that embeds an absolute path) without needing an
 *   actually undeletable directory, which is not reliably constructible across
 *   Windows locks / POSIX permissions / root.
 * @returns {{ removed: boolean, error?: unknown }}
 */
function removeWithRetry(path, existsFn, removeFn) {
  const attempts = 5;
  let lastError;
  /*
   * The real removal keeps the recursive/retry options; an injected one is called
   * exactly as given. Defaulting this parameter to bare `rmSync` would drop the
   * options object and fail every normal removal — so the default is a closure
   * that supplies them.
   */
  const remove =
    removeFn ??
    ((target) => rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 }));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      remove(path);
    } catch (error) {
      lastError = error;
    }
    /*
     * Verify rather than trust the call. `force: true` already turns ENOENT into a
     * non-event, so reaching here with the path still present is a real failure
     * (permissions, a lock, a partially removed tree).
     */
    if (!existsFn(path)) return { removed: true };
    if (attempt < attempts) {
      const until = Date.now() + 40 * attempt;
      while (Date.now() < until) {
        /* bounded spin: this runs during process exit, where timers do not fire */
      }
    }
  }
  return { removed: false, error: lastError };
}

/** Install the process-exit safety net once. */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    finalising = true;
    const simulate = simulatedFailure();
    let failures = 0;
    /* Iterate over entries: the key is the created path, the value the realpath. */
    for (const [key, removalTarget] of outstanding) {
      const { removed, error } = simulate
        ? { removed: false, error: new Error("simulated cleanup failure (test seam)") }
        : removeWithRetry(removalTarget, existsSync);
      if (removed) {
        outstanding.delete(key);
        continue;
      }
      failures += 1;
      console.error(`FAIL  ${new TempCleanupError(redactTempPath(key), error).message}`);
    }
    if (failures > 0) {
      /*
       * Force a non-zero exit code, but **never lower** one that is already set.
       *
       * Measured: assigning `process.exitCode` in an exit handler is honoured, and
       * it can also turn `process.exit(3)` into 0. Overwriting blindly would
       * therefore erase a real failure's code. Raising only-from-zero keeps a
       * control's own non-zero verdict intact while making a cleanup-only failure
       * visible to `$?`.
       *
       * If a *non-zero* code is already set the failure is still reported on
       * stderr above, so both facts survive: the original exit status and the
       * cleanup problem.
       */
      if (process.exitCode === undefined || process.exitCode === 0) {
        process.exitCode = 1;
      }
    }
  });
}

/**
 * Create a temp directory that this module will remove.
 *
 * Use this instead of a bare `mkdtempSync` whenever the directory's lifetime is
 * the process's — a module-level git-config root, for instance. Prefer
 * `withTempDir` when the directory has a narrower scope.
 *
 * The returned `dispose()` **throws** `TempCleanupError` if the directory survives
 * removal. It does not merely log: a caller that wants to continue after a failed
 * cleanup must say so explicitly by catching, which is the opposite default from
 * the previous revision.
 *
 * @param {string} prefix
 * @param {{ exists?: (path: string) => boolean, remove?: (path: string) => void }} [options]
 *   Test seams. `exists` lets a test force "the path is still there"; `remove` lets
 *   a test raise a genuine filesystem error (the kind whose message embeds an
 *   absolute path) without needing an actually undeletable directory — which is not
 *   reliably constructible on every platform (Windows file locks and POSIX
 *   permission bits differ, and root ignores permission bits entirely).
 * @returns {{ path: string, dispose: () => void }}
 */
export function createTempDir(prefix, options = {}) {
  installExitHook();
  const existsFn = options.exists ?? existsSync;
  const removeFn = options.remove;
  const created = mkdtempSync(join(tmpdir(), prefix));
  /*
   * Keyed by the path `mkdtempSync` returned, which is the only path the caller and
   * this module both hold verbatim. The realpath is stored as the removal target
   * because it is what `rmSync` must traverse when the temp root is a symlink.
   */
  let removalTarget = created;
  try {
    removalTarget = realpathSync.native(created);
  } catch {
    /* keep the literal path if it cannot be resolved */
  }
  if (!finalising) outstanding.set(created, removalTarget);

  /** Idempotent: a second dispose on an already-removed directory is a no-op. */
  let disposed = false;

  return {
    path: created,
    dispose() {
      if (disposed) return;
      disposed = true;
      const { removed, error } = removeWithRetry(created, existsFn, removeFn);
      if (removed) {
        outstanding.delete(created);
        return;
      }
      /*
       * Leave the entry registered so the exit handler makes one more attempt, and
       * throw so the caller cannot mistake this for success.
       *
       * Only the redacted identifier and a whitelisted code reach the error; the
       * filesystem error itself is discarded by the constructor.
       */
      throw new TempCleanupError(redactTempPath(created), error);
    },
  };
}

/**
 * Run `body` with a temp directory that is removed when it returns or throws.
 *
 * ── Two failures at once ──
 *
 * If the body throws and the cleanup then also fails, both are real and both must
 * survive. The **original** error is what propagates, because it is the evidence
 * the caller is looking for ("the control failed"); the cleanup error is attached
 * to it as `cleanupError` and printed, so it cannot be lost either. Letting the
 * cleanup error replace the original would hide the actual test failure — which is
 * exactly the trade this repository has already been bitten by.
 *
 * @template T
 * @param {string} prefix
 * @param {(path: string) => T} body
 * @param {{ exists?: (path: string) => boolean, remove?: (path: string) => void }} [options]
 * @returns {T}
 */
export function withTempDir(prefix, body, options = {}) {
  const handle = createTempDir(prefix, options);
  let result;
  let bodyError;
  try {
    result = body(handle.path);
  } catch (error) {
    bodyError = error;
  }
  try {
    handle.dispose();
  } catch (cleanupError) {
    if (bodyError !== undefined) {
      /*
       * Both failed. Preserve the primary failure and record the secondary one on
       * it, then report the secondary loudly so neither is hidden.
       */
      try {
        bodyError.cleanupError = cleanupError;
      } catch {
        /* a frozen error object must not swallow the cleanup failure */
      }
      console.error(`FAIL  (secondary) ${cleanupError.message}`);
      throw bodyError;
    }
    throw cleanupError;
  }
  if (bodyError !== undefined) throw bodyError;
  return result;
}

/**
 * Async variant of `withTempDir`. Same two-failure semantics.
 *
 * @template T
 * @param {string} prefix
 * @param {(path: string) => Promise<T>} body
 * @param {{ exists?: (path: string) => boolean, remove?: (path: string) => void }} [options]
 * @returns {Promise<T>}
 */
export async function withTempDirAsync(prefix, body, options = {}) {
  const handle = createTempDir(prefix, options);
  let result;
  let bodyError;
  try {
    result = await body(handle.path);
  } catch (error) {
    bodyError = error;
  }
  try {
    handle.dispose();
  } catch (cleanupError) {
    if (bodyError !== undefined) {
      try {
        bodyError.cleanupError = cleanupError;
      } catch {
        /* ignore a frozen error object */
      }
      console.error(`FAIL  (secondary) ${cleanupError.message}`);
      throw bodyError;
    }
    throw cleanupError;
  }
  if (bodyError !== undefined) throw bodyError;
  return result;
}

/**
 * Diagnostics for the release controls' own self-test.
 *
 * Exposed so a control can assert both directions: that a normal run leaves
 * nothing behind, and that the exit path removes a directory created at module
 * top level. Without that, "we clean up now" is an unverified claim.
 */
export const __testing = {
  outstandingCount: () => outstanding.size,
  outstandingPaths: () => [...outstanding.keys()],
  redactTempPath,
  /**
   * Drop a path from the registry without touching the disk.
   *
   * Only for tests that deliberately provoke a failed cleanup: the directory has
   * really been removed by the test itself, but the registry entry survives by
   * design (so the exit hook can retry). Without this a test that provokes the
   * failure state becomes the leak it is testing for.
   *
   * Matches on the created path **and**, failing that, on a realpath match, so a
   * caller that only holds one of the two forms can still reconcile.
   *
   * @param {string} path
   */
  forget(path) {
    if (outstanding.delete(path)) return;
    for (const [key, target] of outstanding) {
      if (target === path) {
        outstanding.delete(key);
        return;
      }
    }
    try {
      const resolved = realpathSync.native(path);
      for (const [key, target] of outstanding) {
        if (target === resolved) {
          outstanding.delete(key);
          return;
        }
      }
    } catch {
      /* path already gone: nothing to reconcile by realpath */
    }
  },
};

/**
 * ── Test seam for the exit path ──
 *
 * The exit handler is the one branch a unit test cannot reach by construction: it
 * runs after the test process is already ending. To verify it *without* inventing
 * an undeletable directory (which is not reliably constructible — Windows file
 * locks and POSIX permission bits behave differently, and running as root ignores
 * permission bits entirely), the handler honours an explicit opt-in flag:
 *
 *   CET6_TEMP_CLEANUP_SIMULATE_FAILURE=1
 *
 * When set, the exit handler treats every outstanding directory as
 * unremovable. A child process launched with that flag must exit **non-zero**,
 * which is what the negative control asserts. The flag is read at exit time and
 * has no effect on the normal path — production runs never set it.
 */
function simulatedFailure() {
  return process.env.CET6_TEMP_CLEANUP_SIMULATE_FAILURE === "1";
}
