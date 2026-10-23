#!/usr/bin/env node
/**
 * Controls for `tools/check-dependency-security.mjs`.
 *
 * ── Why this file exists ──
 *
 * The gate reports PASS / FAIL / ERROR, and the whole point of its design is that
 * only one of those is good news. A gate whose three verdicts have never been
 * observed is indistinguishable from a gate that prints "PASS" unconditionally —
 * which is the exact failure mode the gate itself was written to catch, one level
 * up. So every verdict is produced here by construction, and the harness fails if
 * the gate gives the wrong one.
 *
 * ── The four controls ──
 *
 *   0. BASELINE — the real tree passes. Without this the rest prove nothing:
 *      a gate that always fails would satisfy controls 1–3.
 *   1. VULNERABLE — a real advisory in the resolved graph is a FAIL, not an
 *      ERROR and not a PASS. Uses a pinned version with a published advisory.
 *   2. EMPTY GRAPH — a lockfile that collapses to a boot document is an ERROR.
 *      This is the finding the whole change is about, so it gets its own control.
 *   3. UNREACHABLE INDEX — an advisory endpoint that cannot be reached is an
 *      ERROR. This is the control that distinguishes "nothing found" from
 *      "nothing looked", and it is the reason a scan failure cannot be recorded
 *      as safe.
 *
 * ── Controls 1 and 2 build their own lockfiles ──
 *
 * Control 1 needs the real dependency set (to clear the scope floor) *plus* one
 * vulnerable package, so it copies this repository's manifest and adds a pinned
 * dependency with a known advisory. Control 2 needs the opposite: a lockfile so
 * small that the graph is obviously not real. Both resolve their own lockfile with
 * `pnpm install --lockfile-only`, which needs no network for a package that is
 * already in the store and no network at all for control 2 (it is hand-written).
 *
 * ── On the network ──
 *
 * Control 1 and the baseline query the public advisory index. If that index is
 * unreachable, the *gate* correctly reports ERROR — and this harness would then
 * report a failure for the baseline, which is misleading. So the harness detects
 * that specific situation and says so explicitly rather than blaming the gate.
 *
 * Usage: node tools/dependency-security-controls.mjs
 *
 * Exit 0 = every control produced the verdict it requires.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { withTempDir } from "./temp-workspace.mjs";

const ROOT = process.cwd();
const GATE = join(ROOT, "tools", "check-dependency-security.mjs");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

/**
 * Run the gate against `root` with extra arguments.
 *
 * Returns the verdict and the combined output. The verdict is taken from the
 * process exit code rather than from the printed word, so a gate that printed
 * "PASS" and exited 1 would be caught by the assertions below.
 */
function runGate(root, extraArgs = [], env = process.env) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, "--root", root, ...extraArgs], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env,
      timeout: 300_000,
    });
    return { status: 0, out: stdout };
  } catch (error) {
    return {
      status: error.status ?? 1,
      out: String(error.stdout ?? "") + String(error.stderr ?? ""),
    };
  }
}

/** A verdict the gate printed, as opposed to the exit code. */
function printedVerdict(out) {
  const match = /dependency security: (PASS|FAIL|ERROR)/.exec(out);
  return match === null ? null : match[1];
}

/**
 * Kill network access for a child process on both platforms.
 *
 * `pnpm audit` talks to the registry over HTTPS. Pointing the proxy at an address
 * that refuses connections makes that request fail at the transport layer, which
 * is the condition control 3 needs. The `--registry` flag alone is not enough:
 * the audit endpoint is derived from the registry, but setting only the flag
 * leaves the store and metadata requests pointing at the real registry, and the
 * command can still complete.
 */
function offlineEnv() {
  const unreachable = "http://127.0.0.1:9";
  return {
    ...process.env,
    npm_config_registry: "https://127.0.0.1:9/",
    HTTPS_PROXY: unreachable,
    HTTP_PROXY: unreachable,
    https_proxy: unreachable,
    http_proxy: unreachable,
    NO_PROXY: "",
    no_proxy: "",
  };
}

console.log("dependency security gate — controls\n");

/**
 * Resolve a pnpm invocation usable from this harness.
 *
 * `shell: true` appears here for the same reason the gate avoids it, and the
 * trade is the opposite: this harness builds fixture lockfiles with a *fixed*
 * argument list that carries no variable input, it is not part of the shipped
 * security boundary, and `pnpm.cmd` cannot be spawned on Windows without a shell
 * (Node refuses `.cmd`/`.bat` unless `shell: true`, the fix for CVE-2024-27980).
 * The gate itself must keep passing a concrete binary an argument array.
 */
function resolvePnpmForHarness() {
  if (process.platform !== "win32") return "pnpm";
  const pathEntries = (process.env.PATH ?? "").split(";").filter(Boolean);
  for (const directory of pathEntries) {
    const native = join(directory, "node_modules", "pnpm", "pnpm.exe");
    try {
      readFileSync(native);
      return native;
    } catch {
      // keep looking
    }
  }
  return "pnpm";
}

const PNPM = resolvePnpmForHarness();
const USE_SHELL = process.platform === "win32" && PNPM === "pnpm";

/** Write a fixture lockfile for `path` using the manifest already in place. */
function resolveFixtureLockfile(path) {
  try {
    execFileSync(PNPM, ["install", "--lockfile-only"], {
      cwd: path,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 600_000,
      shell: USE_SHELL,
    });
    return true;
  } catch (error) {
    console.error(
      `      fixture lockfile resolution failed: ${String(error.stderr ?? error.message).trim().split("\n").slice(0, 2).join(" ")}`,
    );
    return false;
  }
}

// ── control 0: the real tree passes ──
{
  const { status, out } = runGate(ROOT);
  check("baseline: the real tree PASSES", status === 0 && printedVerdict(out) === "PASS", out.slice(-400));
  /*
   * The baseline must also be a *substantive* pass. If the advisory index is
   * unreachable the gate correctly says ERROR, and the message below should point
   * at the environment rather than at the gate.
   */
  if (status !== 0 && /did not run|could not be started/.test(out)) {
    console.error("      note: the advisory index was unreachable from this machine;");
    console.error("      the gate is behaving correctly (fail-closed), the environment is not.");
  }
}

// ── control 1: a real advisory is a FAIL ──
/*
 * `lodash@4.17.20` carries published high-severity advisories, and the manifest
 * copied from this repository keeps the resolved graph above the scope floor so
 * the verdict is driven by the advisory rather than by the floor.
 *
 * The gate runs *inside* the temp-dir scope: `withTempDir` removes the directory
 * when its callback returns, so a gate invoked after it would find no lockfile —
 * which is exactly the mistake the first version of this harness made, and it
 * showed up as "could not resolve a fixture lockfile".
 */
withTempDir("depsec-vuln-", (path) => {
  copyFileSync(join(ROOT, "package.json"), join(path, "package.json"));
  copyFileSync(join(ROOT, "pnpm-workspace.yaml"), join(path, "pnpm-workspace.yaml"));

  const manifest = JSON.parse(readFileSync(join(path, "package.json"), "utf8"));
  manifest.dependencies.lodash = "4.17.20";
  writeFileSync(join(path, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (!resolveFixtureLockfile(path)) {
    check("gate FAILS on a tree containing a vulnerable dependency", false, "could not resolve a fixture lockfile");
    return;
  }

  const { status, out } = runGate(path);
  const verdict = printedVerdict(out);
  check(
    "gate FAILS on a tree containing a vulnerable dependency",
    status !== 0 && verdict === "FAIL" && /lodash/.test(out),
    out.slice(-500),
  );
  /*
   * The distinction matters: FAIL means "scanned and found something". An ERROR
   * here would mean the gate could not tell, which is a different bug.
   */
  check("  … and reports FAIL, not ERROR (the scan did happen)", verdict === "FAIL", `verdict=${verdict}`);
});

// ── control 2: an empty graph is an ERROR, never a PASS ──
/*
 * This is the finding the change is about. The fixture is a two-document
 * lockfile whose boot document is the only well-formed part — precisely what
 * pnpm 12 wrote before `pmOnFail: ignore`, and what a naive reader sees as
 * "a project with no dependencies".
 */
withTempDir("depsec-empty-", (path) => {
  copyFileSync(join(ROOT, "package.json"), join(path, "package.json"));
  writeFileSync(
    join(path, "pnpm-lock.yaml"),
    [
      "---",
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .:",
      "    configDependencies: {}",
      "    packageManagerDependencies:",
      "      pnpm:",
      "        specifier: 12.4.2",
      "        version: 12.4.2",
      "",
      "packages:",
      "",
      "  pnpm@12.4.2:",
      "    resolution: {integrity: sha512-CK3GYTGAJ1x8ntraOdzwjJxhrU5+rzMKTzRh8QKw+QdCNFTRF/mOctR/7wYWBwZE17/8lzpqV/UJCm18NosHyQ==}",
      "    engines: {node: '>=18.*'}",
      "    hasBin: true",
      "",
      "snapshots:",
      "",
      "  pnpm@12.4.2: {}",
      "",
      "---",
      "lockfileVersion: '9.0'",
      "",
      "importers:",
      "",
      "  .: {}",
      "",
      "packages: {}",
      "",
      "snapshots: {}",
      "",
    ].join("\n"),
    "utf8",
  );

  const { status, out } = runGate(path);
  const verdict = printedVerdict(out);
  check(
    "gate reports ERROR on a two-document lockfile (the empty-graph defect)",
    status !== 0 && verdict === "ERROR",
    out.slice(-500),
  );
  check("  … and names the cause rather than a generic failure", /two-document/.test(out), out.slice(-500));
  check(
    "  … and never reports a clean result for an empty graph",
    !/dependency security: PASS/.test(out),
    out.slice(-300),
  );
});

// ── control 3: an unreachable advisory index is an ERROR ──
{
  const { status, out } = runGate(ROOT, [], offlineEnv());
  const verdict = printedVerdict(out);
  check(
    "gate reports ERROR when the advisory index is unreachable",
    status !== 0 && verdict === "ERROR",
    out.slice(-500),
  );
  check(
    "  … and never reports PASS when no scan could be performed",
    !/dependency security: PASS/.test(out),
    out.slice(-300),
  );
}

console.log("");
if (failures > 0) {
  console.error(`dependency security controls: ${failures} FAILED`);
  process.exit(1);
}
console.log("dependency security controls: PASS — PASS, FAIL and ERROR are all reachable and distinct");
