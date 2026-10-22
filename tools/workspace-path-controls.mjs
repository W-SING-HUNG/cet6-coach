/**
 * Negative controls for the workspace-path check.
 *
 * Every control plants a synthetic-but-realistic internal path in a throwaway
 * copy of the tree and requires `public-release-check.mjs` to REFUSE it. A gate
 * that has only ever been observed to pass has not been shown to check anything.
 *
 * ── Confinement ──
 *
 * The planted strings are generated at runtime from a base and a counter, so this
 * file never contains a literal that looks like a real workspace path �?the same
 * discipline `tools/smoke-test.mjs` uses for machine names. Failure output is
 * asserted *not* to contain the planted path, because a CI log is as public as
 * the repository: echoing the secret there would move the leak, not remove it.
 *
 * Usage: node tools/workspace-path-controls.mjs
 */

import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createTempDir } from "./temp-workspace.mjs";

const ROOT = process.cwd();
const GATE = join(ROOT, "tools", "public-release-check.mjs");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail === "" ? "" : ` �?${detail}`}`);
  }
}

const BS = String.fromCharCode(92);
const win = (...segments) => segments.join(BS);

/**
 * Build a full-tree copy that the gate accepts, then let the caller plant a leak.
 *
 * Full tree, not a licence-only subset: the other ten checks read `tools/`, the
 * source and the notice files, so a partial tree would make the baseline control
 * fail for reasons unrelated to this clause.
 */
function makeTree(mutate) {
  const dir = createTempDir("wspath-ctl-").path;
  cpSync(ROOT, dir, {
    recursive: true,
    filter: (source) => {
      const rel = source.slice(ROOT.length).replace(/\\/g, "/");
      return !/^\/(node_modules|\.git|\.next|\.e2e|data)(\/|$)/.test(rel);
    },
  });
  mutate(dir);

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "T",
        GIT_AUTHOR_EMAIL: "t@example.com",
        GIT_COMMITTER_NAME: "T",
        GIT_COMMITTER_EMAIL: "t@example.com",
      },
    });
  git("init", "-q", "-b", "master");
  git("add", "-A");
  git("commit", "-q", "-m", "probe");
  return dir;
}

function runGate(dir) {
  try {
    const stdout = execFileSync(process.execPath, [GATE], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, out: stdout };
  } catch (error) {
    return { ok: false, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
  }
}

/** Append a line to a file inside the probe tree, creating it if absent. */
function plant(dir, file, line) {
  const absolute = join(dir, ...file.split("/"));
  const existing = existsSync(absolute) ? readFileSync(absolute, "utf8") : "";
  writeFileSync(absolute, existing + "\n" + line + "\n", "utf8");
}

/**
 * A synthetic internal workspace path, assembled at runtime.
 *
 * Shaped like a real one (drive, two identifier segments, a file) but built from
 * a counter so this file stores no literal instance.
 */
let counter = 0;
function syntheticInternalPath() {
  counter += 1;
  return win(`I:`, `acme-workspace-${counter}`, `staging-${counter}`, "tools", "probe.ts");
}

// ── control 0: the unmodified tree PASSES (otherwise the rest prove nothing) ──
{
  const dir = makeTree(() => {});
  const { ok, out } = runGate(dir);
  check("baseline: an unmodified tree passes the workspace-path check", ok, out.slice(-500));
  rmSync(dir, { recursive: true, force: true });
}

// ── control 1: a Windows workspace path in a source comment ──
{
  const planted = syntheticInternalPath();
  const dir = makeTree((d) => plant(d, "src/lib/date.ts", `// built from ${planted}`));
  const { ok, out } = runGate(dir);
  check(
    "gate REFUSES a Windows workspace path in a source comment",
    !ok && /windows-internal-workspace/.test(out),
    out.slice(-400),
  );
  check("the refusal does not echo the planted path", !out.includes(planted), "the path appeared in gate output");
  rmSync(dir, { recursive: true, force: true });
}

// ── control 2: the same path inside a *test* file (no filename exemption) ──
{
  const planted = syntheticInternalPath();
  const dir = makeTree((d) => plant(d, "tests/paper-paths.test.ts", `const fixture = ${JSON.stringify(planted)};`));
  const { ok, out } = runGate(dir);
  check(
    "gate REFUSES a workspace path in a test file (tests are published too)",
    !ok && /windows-internal-workspace/.test(out),
    out.slice(-400),
  );
  check("the test-file refusal does not echo the path", !out.includes(planted));
  rmSync(dir, { recursive: true, force: true });
}

// ── control 3: a workspace path in documentation ──
{
  const planted = syntheticInternalPath();
  const dir = makeTree((d) => plant(d, "README.md", `Local checkout: \`${planted}\``));
  const { ok, out } = runGate(dir);
  check("gate REFUSES a workspace path in documentation", !ok && /windows-internal-workspace/.test(out), out.slice(-400));
  rmSync(dir, { recursive: true, force: true });
}

// ── control 4: a POSIX home path naming a real-looking account ──
{
  /*
   * Assembled at runtime from parts, so this file contains no literal instance
   * of the shape it plants. The gate scans this file too �?correctly �?and a
   * control that stores a real-looking path would be caught by the very check it
   * is testing.
   */
  const home = "/" + "home";
  const account = "probeuser" + String(counter + 1);
  const planted = `${home}/${account}/projects/secret/src/a.ts`;
  const dir = makeTree((d) => plant(d, "src/lib/id.ts", `// see ${planted}`));
  const { ok, out } = runGate(dir);
  check("gate REFUSES a POSIX home path naming an account", !ok && /posix-internal-root/.test(out), out.slice(-400));
  check("the POSIX refusal does not echo the path", !out.includes(planted));
  rmSync(dir, { recursive: true, force: true });
}

// ── control 5: a *different* drive letter and an unfamiliar directory name ──
{
  const planted = win("K:", "totally-unseen-dir", "sub", "a.ts");
  const dir = makeTree((d) => plant(d, "src/lib/utils.ts", `// ${planted}`));
  const { ok, out } = runGate(dir);
  check(
    "gate REFUSES an unfamiliar drive and directory (no denylist)",
    !ok && /windows-internal-workspace/.test(out),
    out.slice(-400),
  );
  rmSync(dir, { recursive: true, force: true });
}

// ── control 6: legitimate content stays green ──
{
  const dir = makeTree((d) => {
    plant(d, "src/lib/probe.ts", [
      `// OS path, present on every machine: ${win("C:", "Windows", "system32", "win.ini")}`,
      `// fixture root: ${win("Q:", "sample-root", "private-content", "courses", "x")}`,
      `// redacted: ${win("D:", "...", "private-content")}`,
      "// url: https://example.com/a/b",
      "// route: /practice/courses/abc/segment/x",
      `// bare marker: "/home/" and "/Users/"`,
      `// escaped relative path: "assets${BS}${BS}sub${BS}${BS}a.wav"`,
      `// escape codes: ${BS}n ${BS}r ${BS}s ${BS}d ${BS}t`,
    ].join("\n"));
  });
  const { ok, out } = runGate(dir);
  check("gate ACCEPTS legitimate OS paths, fixtures, redactions, URLs and routes", ok, out.slice(-600));
  rmSync(dir, { recursive: true, force: true });
}

// ── control 7: a UNC network path naming a machine ──
{
  /*
   * Assembled at runtime: a literal UNC path in this file would itself be a
   * finding in the published tree, which the gate (rightly) rejects.
   */
  const unc = (host, share) => `${BS}${BS}${host}${BS}${share}${BS}secret.txt`;
  const planted = unc(["acme", "build", "agent"].join("-"), "checkout");
  const dir = makeTree((d) => plant(d, "src/lib/net.ts", `// built on ${planted}`));
  const { ok, out } = runGate(dir);
  check("gate REFUSES a UNC network path naming a machine", !ok && /unc-network-path/.test(out), out.slice(-400));
  check("the UNC refusal does not echo the host name", !out.includes("acme-build-agent"));
  rmSync(dir, { recursive: true, force: true });
}

// ── control 8: an unfamiliar UNC host (allowance table, not a denylist) ──
{
  const unc = (host, share) => `${BS}${BS}${host}${BS}${share}${BS}a.ts`;
  const planted = unc("unseen-nas-07", "volume1");
  const dir = makeTree((d) => plant(d, "src/lib/utils.ts", `const p = "${planted}";`));
  const { ok, out } = runGate(dir);
  check(
    "gate REFUSES an unfamiliar UNC host (allowance table, not denylist)",
    !ok && /unc-network-path/.test(out),
    out.slice(-400),
  );
  rmSync(dir, { recursive: true, force: true });
}

// ── control 9: a drive path must NOT be mistaken for a UNC host ──
{
  /*
   * `C:\\Windows\\system32` contains a double backslash, but it is a drive path.
   * If the UNC rule fired here it would report a share on a host called
   * "Windows" �?noise, and noise is how a scanner gets switched off.
   */
  const dir = makeTree((d) => {
    plant(d, "src/lib/probe2.ts", `const p = "C:${BS}${BS}Windows${BS}${BS}system32${BS}win.ini";`);
  });
  const { ok, out } = runGate(dir);
  check("gate does NOT read a drive path as a UNC host", ok && !/unc-network-path/.test(out), out.slice(-600));
  rmSync(dir, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.error(`workspace-path controls: ${failures} FAILED`);
  process.exit(1);
}
console.log("workspace-path controls: PASS �?the gate rejects injected paths and accepts legitimate content");
