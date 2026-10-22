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
 *   3. **Explicit failure reporting.** If removal fails, that is reported on
 *      stderr by name — never swallowed. A cleanup that silently fails is the
 *      same defect one level down.
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
 * Linux CI and Windows both work: `mkdtempSync` resolves through `os.tmpdir()`,
 * and removal retries a few times because Windows releases directory handles
 * slightly after the child process that held them exits.
 */

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Paths this process created and has not yet removed.
 *
 * A `Set` of the *real* paths (symlinks resolved) so a temp root that is itself a
 * link (`/tmp` → `/private/tmp` on macOS) cannot make removal miss.
 */
const outstanding = new Set();

/** Set once the exit handler is installed, so it is installed at most once. */
let exitHookInstalled = false;

/** True once the exit handler has started removing; new registrations are then futile. */
let finalising = false;

/**
 * Remove one path, retrying briefly.
 *
 * Windows keeps a directory handle open for a moment after the process that used
 * it exits, so a single `rmSync` can fail with `EBUSY`/`EPERM` on a directory
 * that is about to become removable. Retrying is not papering over a bug here:
 * the handle is genuinely gone a few milliseconds later.
 *
 * @param {string} path
 * @returns {{ removed: boolean, error?: Error }}
 */
function removeWithRetry(path) {
  const attempts = 5;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 40 });
      return { removed: true };
    } catch (error) {
      lastError = error;
      /*
       * `force: true` already turns ENOENT into a non-event, so a throw here is a
       * real failure (permissions, a lock, a path that is not a directory).
       * Pause only between attempts.
       */
      if (attempt < attempts) {
        const until = Date.now() + 40 * attempt;
        while (Date.now() < until) {
          /* bounded spin: this runs during process exit, where timers do not fire */
        }
      }
    }
  }
  return { removed: false, error: lastError };
}

/**
 * Report a cleanup failure without throwing.
 *
 * Throwing here would replace the real failure (a control that already failed)
 * with a cleanup error, which is how the original leak stayed invisible. The
 * report is loud and names the path, because an unreported leftover is the defect.
 */
function reportCleanupFailure(path, error) {
  const detail = error instanceof Error ? `${error.code ?? error.name}: ${error.message}` : String(error);
  console.error(`FAIL  temporary workspace could not be removed: ${path} — ${detail}`);
}

/** Install the process-exit safety net once. */
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    finalising = true;
    for (const path of outstanding) {
      const { removed, error } = removeWithRetry(path);
      if (removed) outstanding.delete(path);
      else reportCleanupFailure(path, error);
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
 * @param {string} prefix
 * @returns {{ path: string, dispose: () => void }}
 */
export function createTempDir(prefix) {
  installExitHook();
  const created = mkdtempSync(join(tmpdir(), prefix));
  /*
   * Record the real path: on a platform where the temp root is a symlink, the
   * path returned by `mkdtempSync` and the path `rmSync` must traverse can differ.
   */
  let key = created;
  try {
    key = realpathSync.native(created);
  } catch {
    /* keep the literal path if it cannot be resolved */
  }
  if (!finalising) outstanding.add(key);

  return {
    path: created,
    dispose() {
      const { removed, error } = removeWithRetry(created);
      if (removed) {
        outstanding.delete(key);
        return;
      }
      /* One retry on the original path, then report — never swallow. */
      reportCleanupFailure(created, error);
    },
  };
}

/**
 * Run `body` with a temp directory that is removed when it returns or throws.
 *
 * @template T
 * @param {string} prefix
 * @param {(path: string) => T} body
 * @returns {T}
 */
export function withTempDir(prefix, body) {
  const handle = createTempDir(prefix);
  try {
    return body(handle.path);
  } finally {
    handle.dispose();
  }
}

/**
 * Async variant of `withTempDir`.
 *
 * @template T
 * @param {string} prefix
 * @param {(path: string) => Promise<T>} body
 * @returns {Promise<T>}
 */
export async function withTempDirAsync(prefix, body) {
  const handle = createTempDir(prefix);
  try {
    return await body(handle.path);
  } finally {
    handle.dispose();
  }
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
  outstandingPaths: () => [...outstanding],
};
