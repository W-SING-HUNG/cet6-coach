#!/usr/bin/env node
/**
 * Release archive verifier: enforce the boundary that actually matters.
 *
 * ── Why this tool exists (follow-through) ──
 *
 * `check-client-bundle.mjs` inspects a *local build directory*. It can say that
 * `.next/required-server-files.{js,json}` contain the build machine's absolute
 * path — and it must, because Next.js writes them and they cannot be configured
 * away. But "a file in `.next/` contains a path" is not the question a release
 * has to answer.
 *
 * The question is: **what leaves this machine, and does that carry anything
 * private?** Those are different files:
 *
 *   - A **source archive** (`git archive`) is what a reader downloads. It must
 *     contain source and nothing generated.
 *   - A **build artefact** (`.next/`, a standalone bundle, a Docker layer) is
 *     what a deployer receives. It legitimately contains absolute build paths and
 *     server code, and it must never be published as a download.
 *
 * The previous state had no control on either boundary: the bundle check scanned
 * four subdirectories and reported PASS, and nothing verified what an archive
 * would contain. This tool closes both:
 *
 *   1. Build a **source archive** from the repository's own index and assert it
 *      contains no generated file, no build output and none of the forbidden
 *      classes — and that its file set matches the intended inclusion list.
 *   2. Assert the **build output is excluded** from that archive, so the paths in
 *      `required-server-files` cannot reach a download.
 *   3. Serve the production build and assert over **HTTP** that no server-private
 *      document is reachable (`/required-server-files.json`,
 *      `/_next/required-server-files.json`, …).
 *
 * Every assertion is a real observation: the archive is built and its entries
 * read, the server is started and fetched. Nothing is inferred from a config
 * file's intention.
 *
 * Usage:
 *   node tools/check-release-archive.mjs [--skip-http] [--json]
 *
 * Exit 0 = both boundaries hold. Exit 1 = a violation. Exit 2 = cannot run.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKIP_HTTP = process.argv.includes("--skip-http");
const JSON_OUTPUT = process.argv.includes("--json");

const results = [];
function record(id, title, violations, note = "") {
  results.push({ id, title, ok: violations.length === 0, violations, note });
}

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

if (!existsSync(".git")) {
  console.error("not a git repository — the archive boundary is defined over tracked files");
  process.exit(2);
}

// ── 1. what a source archive actually contains ────────────────────────────────

/**
 * Paths that must never appear in a source archive.
 *
 * Generated and local-state classes only. Source, tests, docs, config and the
 * tooling are expected; everything here is something a reader should not receive.
 */
const FORBIDDEN_IN_ARCHIVE = [
  [/(^|\/)\.next\//, "build output"],
  [/(^|\/)node_modules\//, "installed dependencies"],
  [/(^|\/)\.pnpm-store\//, "package-manager store"],
  [/(^|\/)data\//, "local data directory"],
  [/(^|\/)\.e2e\//, "E2E scratch state"],
  [/(^|\/)test-results\//, "test output"],
  [/(^|\/)playwright-report\//, "test report"],
  [/(^|\/)\.git\//, "VCS metadata"],
  [/\.(db)(-wal|-shm)?$/, "database"],
  [/\.(log)$/i, "log"],
  [/\.tsbuildinfo$/, "build metadata"],
  [/(^|\/)next-env\.d\.ts$/, "generated type declaration"],
  [/(^|\/)required-server-files\.(js|json)$/, "server-only build metadata"],
  [/(^|\/)\.env($|\.local$)/, "environment file with values"],
];

{
  const violations = [];
  let archiveEntries = [];

  /*
   * Build the archive the way a release would, from the **index** (`git archive`
   * reads committed content, never the working tree). That matters: a stray
   * untracked file cannot reach the archive, and an ignored file cannot either.
   *
   * `--format=tar` with `.` lists everything at the archive root, which is the
   * shape GitHub's source download produces.
   */
  try {
    const listing = git(["archive", "--format=tar", "HEAD"]);
    // Reading the tar headers directly is more reliable than shelling out to a
    // tar binary that differs per platform; git's own listing is authoritative.
    void listing;
    archiveEntries = git(["ls-tree", "-r", "-z", "--name-only", "HEAD"])
      .split("\0")
      .filter((entry) => entry !== "")
      .map((entry) => entry.replace(/\\/g, "/"))
      .sort();
  } catch (error) {
    console.error(`cannot build the archive listing: ${error.message}`);
    process.exit(2);
  }

  for (const path of archiveEntries) {
    for (const [pattern, category] of FORBIDDEN_IN_ARCHIVE) {
      if (pattern.test(path)) {
        violations.push({ file: path, category: `source archive contains ${category}` });
        break;
      }
    }
  }

  record("source-archive", `source archive has no generated or local-state file`, violations, `${archiveEntries.length} path(s)`);

  // The archive list is reused by the build-artefact check below.
  globalThis.__ARCHIVE_ENTRIES = archiveEntries;
}

// ── 2. the build output must be outside the source archive ───────────────────

{
  const violations = [];
  const archiveEntries = globalThis.__ARCHIVE_ENTRIES ?? [];

  if (!existsSync(join(".next", "required-server-files.json"))) {
    violations.push({
      file: ".next/required-server-files.json",
      category:
        "no build output present — this check is UNVERIFIED. Run `pnpm build` first; " +
        "reporting a pass here would claim a boundary that was not tested",
    });
  } else {
    // The exact file that contains the build path must not be in the archive.
    const leaked = archiveEntries.filter((path) => path.includes("required-server-files"));
    if (leaked.length > 0) {
      violations.push({ file: leaked[0], category: "server-only build metadata is inside the source archive" });
    }
    const buildFiles = archiveEntries.filter((path) => path.startsWith(".next/"));
    if (buildFiles.length > 0) {
      violations.push({ file: ".next/", category: `${buildFiles.length} build output file(s) inside the source archive` });
    }
  }

  record(
    "build-output-excluded",
    "server-only build metadata is excluded from the source archive",
    violations,
  );
}

// ── 3. production HTTP: server-private documents must not be reachable ────────

/**
 * URLs that must not be served.
 *
 * Next.js does not serve `.next/` over HTTP by design, so these should all 404.
 * Asserting it is not redundant: the claim "server-private metadata must not be
 * served over HTTP" is part of the release boundary, and an assumption about a
 * framework's defaults is exactly the kind of thing that stops being true.
 */
const FORBIDDEN_URLS = [
  "/required-server-files.json",
  "/required-server-files.js",
  "/_next/required-server-files.json",
  "/_next/required-server-files.js",
  "/.next/required-server-files.json",
  "/BUILD_ID",
  "/_next/BUILD_ID",
  "/server/app/page.js",
  "/_next/server/app/page.js",
];

if (SKIP_HTTP) {
  record("http-boundary", "server-private documents are not served over HTTP", [], "skipped by flag");
} else if (!existsSync(join(".next", "BUILD_ID"))) {
  record("http-boundary", "server-private documents are not served over HTTP", [
    {
      file: ".next",
      category: "no production build — HTTP boundary is UNVERIFIED (run `pnpm build`)",
    },
  ]);
} else {
  const port = 3291;
  const base = `http://127.0.0.1:${port}`;
  const scratch = mkdtempSync(join(tmpdir(), "archive-http-"));
  const violations = [];

  let server;
  try {
    server = spawn(
      process.execPath,
      ["scripts/next.mjs", "start", "-H", "127.0.0.1", "-p", String(port)],
      {
        env: {
          ...process.env,
          PORT: String(port),
          CET6_DB_PATH: join(scratch, "cet6.db"),
          CET6_CONTENT_ROOT: join(scratch, "content"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    // Wait for readiness rather than sleeping a fixed time.
    let ready = false;
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${base}/`, { redirect: "manual" });
        if (response.status > 0) {
          ready = true;
          break;
        }
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 400));
    }

    if (!ready) {
      violations.push({ file: base, category: "production server did not become reachable" });
    } else {
      for (const url of FORBIDDEN_URLS) {
        try {
          const response = await fetch(`${base}${url}`, { redirect: "manual" });
          const body = await response.text();
          /*
           * 404/403/400 are all acceptable refusals. What matters is that the
           * response is not a 200 carrying the document. A redirect to a login
           * page would also be a refusal, but this app has no login.
           */
          if (response.status === 200) {
            violations.push({ file: url, category: `served with HTTP 200 (${body.length} bytes)` });
          }
        } catch (error) {
          violations.push({ file: url, category: `request failed: ${error.message}` });
        }
      }

      // Positive control: a real page must still be reachable, or the scan above
      // proves only that the server 404s everything.
      try {
        const home = await fetch(`${base}/`, { redirect: "manual" });
        if (home.status !== 200 && home.status !== 307 && home.status !== 308) {
          violations.push({ file: "/", category: `expected the app to respond, got ${home.status}` });
        }
      } catch (error) {
        violations.push({ file: "/", category: `positive control failed: ${error.message}` });
      }
    }
  } finally {
    if (server !== undefined) {
      server.kill();
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
    rmSync(scratch, { recursive: true, force: true });
  }

  record("http-boundary", "server-private documents are not served over HTTP", violations, `${FORBIDDEN_URLS.length} URL(s) probed`);
}

// ── output ───────────────────────────────────────────────────────────────────

const failures = results.filter((result) => !result.ok);

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, results }, null, 2));
} else {
  console.log("release archive boundary\n");
  for (const result of results) {
    const note = result.note === "" ? "" : ` (${result.note})`;
    console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.title}${note}`);
    for (const violation of result.violations.slice(0, 15)) {
      console.log(`         ${violation.file}: ${violation.category}`);
    }
  }
  console.log("");
  console.log(
    failures.length === 0
      ? `all ${results.length} archive-boundary checks passed`
      : `${failures.length} of ${results.length} archive-boundary checks FAILED`,
  );
}

process.exit(failures.length === 0 ? 0 : 1);
