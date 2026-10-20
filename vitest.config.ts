import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Vite 8 has native tsconfig-paths support; the vite-tsconfig-paths plugin
    // is no longer needed.
    tsconfigPaths: true,
  },
  test: {
    environment: "node",
    // Also collect `.tsx`: component-level (jsdom) tests need real rendering to
    // pin down wiring. Pure-function tests cannot assert *which event* a submit
    // boundary is attached to.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    globals: false,
    // Uses an in-memory node:sqlite database so tests share no state.
    pool: "forks",
    reporters: ["default"],

    /*
     * ── Timeouts ──
     *
     * Several tests spawn a **real Node subprocess** to run a CLI end to end
     * (`scripts/course-extract.ts` and friends). That is deliberate — a mocked
     * CLI would not prove the CLI works — but it means their duration is
     * dominated by process startup plus module transform, not by the logic under
     * test.
     *
     * Measured on the maintainer's machine: ~1.2-1.9 s in isolation, ~6 s when
     * the whole suite runs and every worker competes for CPU. The default 5 s
     * timeout therefore produced a failure that was purely a **resource
     * ceiling**: green when run alone, red in the full suite, with no assertion
     * message to explain it.
     *
     * Raising the timeout is the correct fix rather than trimming the test. The
     * alternative — `--maxWorkers=1` — would make the suite unusably slow, and
     * loosening the assertion would stop testing the real CLI. The budget below
     * is roughly 5x the observed worst case: enough headroom for a slow CI
     * runner, still short enough to fail a genuine hang.
     *
     * Note that this does not hide a real hang: a test that never completes
     * still fails, just later, and the timeout report names the test.
     */
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
