#!/usr/bin/env node
/**
 * Continuous dependency-security gate.
 *
 * ── The defect this exists to prevent ──
 *
 * A vulnerability scan can return "no vulnerabilities" for two completely
 * different reasons, and only one of them is good news:
 *
 *   1. the scanner read the dependency graph and found nothing; or
 *   2. the scanner read a graph that was empty, and therefore had nothing to
 *      match against.
 *
 * Case 2 produces an identical green result and is indistinguishable from case
 * 1 unless something explicitly checks the size of what was scanned. That is
 * what `pnpm-lock.yaml` in this repository did before this gate existed: pnpm 12
 * writes it as a two-document YAML stream whose first document is a small "boot
 * document" holding only pnpm's own version. A single-document reader takes the
 * first one, finds an importer with no `dependencies`, and concludes the project
 * has none.
 *
 * Measured on this repository while that was true: the GitHub dependency graph
 * reported 19 packages — pnpm, its 15 platform binaries and 3 workflow actions —
 * with `next`, `react`, `sharp` and `pdfjs-dist` all absent. Every Dependabot
 * alert type was therefore silently inert. Upstream: dependabot/dependabot-core
 * issue 15904 and pnpm issue 13805.
 *
 * ── Why the gate is structured as three separate results ──
 *
 * The brief for this change was explicit that a scan which could not run must
 * never be recorded as safe. So the three outcomes are distinct and only one of
 * them exits 0:
 *
 *   PASS   the lockfile has a real graph, the audit ran, and nothing at or above
 *          the threshold was found
 *   FAIL   the audit ran and found something at or above the threshold
 *   ERROR  the audit could not be performed (no lockfile, no network, an
 *          unparseable or empty response, or a pnpm invocation failure) — this
 *          exits non-zero and says so, rather than reporting a clean tree
 *
 * ── The scope is proved, not assumed ──
 *
 * Both the lockfile entry count and the audited dependency count from pnpm's own
 * metadata are compared against a floor. A graph that collapses to a handful of
 * entries fails even if every one of those entries is clean, because "0 issues
 * over 0 packages" is not evidence of anything.
 *
 * ── What this gate does not do ──
 *
 * It does not claim to find every vulnerability. It queries one advisory source
 * (the npm registry advisory bulk endpoint, which is what `pnpm audit` uses),
 * keyed by the exact resolved versions in the lockfile. It therefore cannot see:
 *
 *   - an advisory that the database has not published yet;
 *   - a compromised-but-not-yet-advisory package (supply-chain compromise);
 *   - a vulnerability in a transitive native component that ships inside a
 *     prebuilt binary rather than as an npm package (the `sharp` libvips family
 *     is exactly this shape);
 *   - anything about the workflow actions, which are not npm packages.
 *
 * Those gaps are why the repository also pins actions by commit SHA, pins
 * `next` exactly, and records its dependency decisions in SECURITY.md. This gate
 * is one layer, and it is written to fail closed rather than to look reassuring.
 *
 * Usage:
 *   node tools/check-dependency-security.mjs [--audit-level <low|moderate|high|critical>]
 *                                           [--json] [--root <dir>]
 *
 * Exit 0 = PASS. Exit 1 = FAIL or ERROR. Exit 2 = bad invocation.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------- invocation

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const ROOT = resolve(flag("root") ?? process.cwd());
const JSON_OUTPUT = process.argv.includes("--json");
const AUDIT_LEVEL = flag("audit-level") ?? "high";

const LEVELS = ["low", "moderate", "high", "critical"];
if (!LEVELS.includes(AUDIT_LEVEL)) {
  console.error(`--audit-level must be one of ${LEVELS.join(", ")} (got "${AUDIT_LEVEL}")`);
  process.exit(2);
}

/**
 * Floors that make an empty scan impossible to mistake for a clean one.
 *
 * The numbers are deliberately well below the real values so that ordinary
 * dependency churn does not trip them, but far above the size of a boot document
 * (whose package count is 16: pnpm plus its 15 platform binaries). The measured
 * values when this gate was introduced were 380 snapshot entries and 560 audited
 * dependencies.
 */
const MIN_LOCKFILE_ENTRIES = 100;
const MIN_AUDITED_DEPENDENCIES = 100;

const findings = [];
const errors = [];

function report(level, message) {
  findings.push({ level, message });
}

// ------------------------------------------------------- 1. lockfile presence

const LOCKFILE = join(ROOT, "pnpm-lock.yaml");
if (!existsSync(LOCKFILE)) {
  console.error(`ERROR no pnpm-lock.yaml at ${LOCKFILE}: cannot determine a dependency graph`);
  process.exit(1);
}

const lockfileText = readFileSync(LOCKFILE, "utf8");

/**
 * Does the lockfile carry a leading document marker?
 *
 * pnpm writes that marker only when it emits two documents, and this repository
 * requires the single-document form (see `pnpm-workspace.yaml`). The check is the
 * one pnpm's own documentation prescribes: a file whose first line is `---` has a
 * boot document.
 */
const lines = lockfileText.split("\n");
const hasBootDocument = lines[0].trimEnd() === "---";

/** Top-level keys and the entry count of the first `packages:` / `snapshots:` block. */
function countEntries(key) {
  const start = lines.indexOf(`${key}:`);
  if (start === -1) return 0;
  let count = 0;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {2}\S.*:$/.test(lines[index])) count += 1;
    else if (/^\S/.test(lines[index])) break;
  }
  return count;
}

const packageEntries = countEntries("packages");
const snapshotEntries = countEntries("snapshots");

// ---------------------------------------------- 2. dependency-graph readability

/*
 * The shape check runs first and independently of the audit. If the lockfile is
 * two-document, the audit below would still report a result (pnpm reads both
 * shapes correctly) — but every *other* consumer, including the platform's
 * dependency graph and Dependabot, would read an empty graph. Keeping this as its
 * own failure means the gate refuses the tree for the right reason instead of
 * passing on a technicality.
 */
if (hasBootDocument) {
  errors.push(
    "pnpm-lock.yaml is a two-document YAML stream (leading `---`). " +
      "Dependency scanners read the first document, find no dependencies, and report a clean result over an " +
      "empty graph. Keep `pmOnFail: ignore` in pnpm-workspace.yaml and regenerate the lockfile so it stays " +
      "single-document. See dependabot/dependabot-core#15904.",
  );
}

if (packageEntries < MIN_LOCKFILE_ENTRIES) {
  errors.push(
    `pnpm-lock.yaml resolves to only ${packageEntries} package entr(ies) — below the floor of ${MIN_LOCKFILE_ENTRIES}. ` +
      "A graph this small cannot be the real dependency set, so any scan over it is meaningless.",
  );
}

// ------------------------------------------------------------- 3. run the audit

/**
 * Resolve pnpm to something that can actually be spawned. Returns
 * `{ command, prefixArgs }` or null.
 *
 * ── Why this is not `execFileSync("pnpm", …)` ──
 *
 * On Linux (CI) a bare `pnpm` resolves to a shell script with a shebang, which
 * `execFileSync` runs directly. On Windows the same name is a **POSIX shell
 * script** and is not executable by Node; the working entry points are
 * `pnpm.cmd` and `pnpm.exe`.
 *
 * Two things rule out the obvious shortcuts, and both were measured here:
 *
 *   1. `pnpm.cmd` cannot be spawned without a shell. Node refuses to spawn
 *      `.cmd`/`.bat` files unless `shell: true`, as the fix for CVE-2024-27980 —
 *      a Windows command-injection issue in exactly this path. Measured: it
 *      returns `EINVAL`.
 *   2. `shell: true` would work around that, but Node deprecated passing an
 *      argument array with `shell: true` because the arguments are concatenated
 *      rather than escaped. A security gate should not be the component that
 *      introduces a command-injection path.
 *
 * So this resolves to a real executable: `pnpm.exe` if it is on PATH, otherwise
 * the native binary that the `.cmd` shim itself points at
 * (`<npm-prefix>/node_modules/pnpm/pnpm.exe`). Neither path involves a shell, and
 * the audit arguments are a fixed array — no user input reaches the command line.
 *
 * Returning null is a legitimate outcome: the caller reports it as a scan that
 * could not be performed, and fails closed.
 */
function resolvePnpm() {
  const pathEntries = (process.env.PATH ?? "")
    .split(process.platform === "win32" ? ";" : ":")
    .filter((entry) => entry !== "");

  const candidates =
    process.platform === "win32"
      ? pathEntries.flatMap((directory) => [
          // A native binary directly on PATH.
          join(directory, "pnpm.exe"),
          // The target of the `pnpm.cmd` shim, one level down.
          join(directory, "node_modules", "pnpm", "pnpm.exe"),
        ])
      : pathEntries.map((directory) => join(directory, "pnpm"));

  for (const candidate of candidates) {
    try {
      if (statSync(candidate).isFile()) return { command: candidate, prefixArgs: [] };
    } catch {
      // not there; keep looking
    }
  }
  return null;
}

/**
 * One audit attempt. Returns `{ stdout, stderr, status, spawnFailure }`.
 *
 * A non-zero exit is ambiguous: `pnpm audit` exits non-zero both when it found
 * advisories (a real result, with JSON on stdout) and when it failed to reach the
 * endpoint (not a result). The caller parses stdout in both cases; only the
 * absence of parseable JSON means "did not run". `ENOENT` is separated out
 * because it means the command was never started at all.
 */
function attemptAudit(command, prefixArgs) {
  try {
    const stdout = execFileSync(command, [...prefixArgs, "audit", "--json"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
      // A hung endpoint must not hang CI.
      timeout: 120_000,
    });
    return { stdout, stderr: "", status: 0, spawnFailure: null };
  } catch (error) {
    return {
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
      status: error.status ?? null,
      spawnFailure: error.code === "ENOENT" || error.code === "EINVAL" ? error.code : null,
    };
  }
}

/**
 * Run the audit, retrying once.
 *
 * The advisory endpoint is a remote service; a single transient connection
 * failure should neither be reported as a vulnerability nor accepted as safety.
 * A persistent failure stays an ERROR.
 */
function runAudit() {
  const resolved = resolvePnpm();
  if (resolved === null) {
    return { stdout: "", stderr: "", status: null, spawnFailure: "not-on-path" };
  }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const result = attemptAudit(resolved.command, resolved.prefixArgs);
    if (result.spawnFailure !== null) {
      return { stdout: "", stderr: result.stderr, status: null, spawnFailure: result.spawnFailure };
    }
    // A parseable payload is a completed scan, whatever the exit code was.
    if (result.stdout.includes("{")) return result;
  }
  return { stdout: "", stderr: "", status: null, spawnFailure: null };
}

const last = runAudit();

let audit = null;
let auditProblem = null;

if (last.spawnFailure === "not-on-path") {
  auditProblem = "the audit command could not be started: no pnpm executable was found on PATH";
} else if (last.spawnFailure !== null) {
  auditProblem = `the audit command could not be started (${last.spawnFailure})`;
} else if (!last.stdout || !last.stdout.includes("{")) {
  auditProblem =
    `the audit did not run: \`pnpm audit --json\` produced no JSON` +
    (last.stderr ? ` (${last.stderr.trim().split("\n").slice(0, 3).join(" ")})` : "") +
    (last.status === null ? "" : ` [exit ${last.status}]`);
} else {
  try {
    // The payload may be preceded by warnings; take the first `{` onward.
    audit = JSON.parse(last.stdout.slice(last.stdout.indexOf("{")));
  } catch (error) {
    auditProblem = `the audit output was not parseable JSON: ${error.message}`;
  }
}

if (audit === null) {
  errors.push(
    `${auditProblem} — a scan that could not be performed is NOT a clean scan, so this run fails closed. ` +
      "Re-run when the advisory endpoint is reachable.",
  );
} else {
  const metadata = audit.metadata ?? {};
  const vulnerabilities = metadata.vulnerabilities ?? {};
  const advisories = audit.advisories ?? {};

  const audited =
    Number(metadata.totalDependencies ?? 0) ||
    Number(metadata.dependencies ?? 0) +
      Number(metadata.devDependencies ?? 0) +
      Number(metadata.optionalDependencies ?? 0);

  /*
   * The audit reports its own scope. A scope below the floor means the audit
   * itself read an empty or nearly-empty graph, which is the same silent failure
   * this gate exists to catch, arriving through a different component.
   */
  if (audited < MIN_AUDITED_DEPENDENCIES) {
    errors.push(
      `the audit only inspected ${audited} dependenc(ies) — below the floor of ${MIN_AUDITED_DEPENDENCIES}. ` +
        "Treat this as a failed scan, not as a clean result.",
    );
  }

  const thresholdIndex = LEVELS.indexOf(AUDIT_LEVEL);
  const blocking = [];
  const reported = [];

  for (const advisory of Object.values(advisories)) {
    const severity = String(advisory.severity ?? "unknown").toLowerCase();
    const entry = {
      severity,
      module: advisory.module_name ?? "unknown",
      title: advisory.title ?? "(no title)",
      vulnerable: advisory.vulnerable_versions ?? "?",
      patched: advisory.patched_versions ?? "?",
      url: advisory.url ?? advisory.github_advisory_id ?? "",
      paths: (advisory.findings ?? []).flatMap((finding) => finding.paths ?? []),
    };
    if (LEVELS.indexOf(severity) >= thresholdIndex) blocking.push(entry);
    else reported.push(entry);
  }

  audit = { audited, vulnerabilities, blocking, reported, packageEntries, snapshotEntries };

  for (const entry of blocking) {
    report(
      entry.severity,
      `${entry.module}: ${entry.title} (vulnerable ${entry.vulnerable}; patched ${entry.patched})` +
        `${entry.url ? ` ${entry.url}` : ""}`,
    );
  }
}

// ----------------------------------------------------------------------- output

if (JSON_OUTPUT) {
  console.log(
    JSON.stringify(
      {
        auditLevel: AUDIT_LEVEL,
        lockfile: { bootDocument: hasBootDocument, packageEntries, snapshotEntries },
        audit,
        blocking: findings,
        errors,
        verdict: errors.length > 0 ? "ERROR" : findings.length > 0 ? "FAIL" : "PASS",
      },
      null,
      2,
    ),
  );
} else {
  console.log("dependency security\n");

  console.log(`lockfile          pnpm-lock.yaml`);
  console.log(`  boot document   ${hasBootDocument ? "PRESENT (two-document — scanners read an empty graph)" : "absent (single-document)"}`);
  console.log(`  package entries ${packageEntries}`);
  console.log(`  snapshot entries ${snapshotEntries}   (floor ${MIN_LOCKFILE_ENTRIES})`);
  console.log("");

  if (audit !== null) {
    console.log(`audit threshold   ${AUDIT_LEVEL} and above blocks`);
    console.log(`  dependencies    ${audit.audited}   (floor ${MIN_AUDITED_DEPENDENCIES})`);
    const counts = LEVELS.map((level) => `${level} ${audit.vulnerabilities[level] ?? 0}`).join("  ");
    console.log(`  advisories      ${counts}`);
    console.log("");
  }

  if (audit !== null && audit.reported.length > 0) {
    console.log(`reported, below the blocking threshold (${audit.reported.length}):`);
    for (const entry of audit.reported) {
      console.log(`  ${entry.severity.padEnd(9)} ${entry.module} — ${entry.title}`);
      console.log(`            vulnerable ${entry.vulnerable}; patched ${entry.patched}`);
      if (entry.url) console.log(`            ${entry.url}`);
      if (entry.paths.length > 0) console.log(`            ${entry.paths.slice(0, 4).join(", ")}`);
    }
    console.log("");
  }

  if (findings.length > 0) {
    console.error(`blocking (${findings.length}):`);
    for (const finding of findings) {
      console.error(`  ${finding.level.padEnd(9)} ${finding.message}`);
    }
    console.error("");
  }

  if (errors.length > 0) {
    console.error(`scan integrity (${errors.length}):`);
    for (const message of errors) console.error(`  ${message}`);
    console.error("");
  }
}

/*
 * Verdict. Order matters: an integrity error outranks a positive finding,
 * because "the scan did not happen" must never be summarised as "vulnerable" —
 * that would let a future reader think the tree had been assessed.
 */
if (errors.length > 0) {
  console.error("dependency security: ERROR — the scan could not be trusted. Failing closed.");
  process.exit(1);
}
if (findings.length > 0) {
  console.error(`dependency security: FAIL — ${findings.length} advisor${findings.length === 1 ? "y" : "ies"} at or above "${AUDIT_LEVEL}"`);
  process.exit(1);
}
console.log(
  `dependency security: PASS — ${audit === null ? "?" : audit.audited} dependencies audited, ` +
    `nothing at or above "${AUDIT_LEVEL}"`,
);
