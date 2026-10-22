#!/usr/bin/env node
/**
 * Negative controls for the release gate's own rules.
 *
 * ── Why this exists ──
 *
 * The gate passing on the current tree proves the tree is clean. It does **not**
 * prove the gate would notice if the tree stopped being clean. That distinction
 * matters more after a correction than before it: the correction removed
 * `AGENTS.md` and `LICENSE`, so the rules that used to guard them must be shown
 * to still fire.
 *
 * This tool builds a **minimal synthetic tree** in a temp directory — a
 * `package.json` plus whatever the control needs — and runs the actual gate
 * against it. Minimal, because copying a real 6 MB tree for each control is slow
 * and, worse, makes it ambiguous whether a failure came from the planted file or
 * from something else in the copy.
 *
 * Each control asserts the gate's exit code, so "the gate printed something" is
 * never mistaken for "the gate refused".
 *
 * Usage:
 *   node --experimental-transform-types tools/gate-negative-controls.mjs
 */

import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDir } from "./temp-workspace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

/**
 * Run a Git command inside a synthetic tree with the operator's configuration
 * neutralised.
 *
 * A control must measure the gate, not the developer's machine. A personal
 * `core.excludesFile` (this engagement hit exactly that: a global `*.local.md`
 * rule) silently changes which files `git add -A` picks up, so a synthetic tree
 * can lose a file its baseline expects and the failure surfaces as an unrelated
 * crash rather than a control verdict. Pinning global/system config to empty
 * files makes every control reproducible on any machine, CI included.
 *
 * The isolation files live in the system temp root rather than beside the tree:
 * they must exist before `git init` creates `.git`, and a caller that deletes the
 * tree must not be able to remove them mid-sequence.
 */
const ISOLATED_GIT_ROOT = createTempDir("gate-ctl-gitcfg-").path;
const ISOLATED_GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: join(ISOLATED_GIT_ROOT, "global-config"),
  GIT_CONFIG_SYSTEM: join(ISOLATED_GIT_ROOT, "system-config"),
  GIT_CONFIG_NOSYSTEM: "1",
};
writeFileSync(ISOLATED_GIT_ENV.GIT_CONFIG_GLOBAL, "", "utf8");
writeFileSync(ISOLATED_GIT_ENV.GIT_CONFIG_SYSTEM, "", "utf8");
const ISOLATED_EXCLUDES = join(ISOLATED_GIT_ROOT, "excludes");
writeFileSync(ISOLATED_EXCLUDES, "", "utf8");

function gitIn(directory, args) {
  return execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: ISOLATED_GIT_ENV,
  });
}

/**
 * Build a minimal tree that the gate will accept.
 *
 * @param {(dir: string) => void} [mutate]
 *   Runs *before* the baseline commit, so a planted defect becomes part of the
 *   baseline tree itself. Use this when the defect is "the tree contains X".
 * @param {(dir: string) => void} [afterCommit]
 *   Runs *after* the baseline commit. Use this when the defect is a change to an
 *   already-committed tree (e.g. unstaging a file), because it needs a real
 *   history to change.
 */
function makeTree(mutate, afterCommit) {
  const scratch = createTempDir("gate-ctl-").path;
  const SYNTHETIC_HOLDER = "Synthetic Control";

  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "synthetic", private: true, license: "MIT" }),
    "utf8",
  );
  /*
   * The baseline tree now carries a **genuine MIT licence**, because that is what
   * the gate requires since the project adopted MIT. The earlier version declared
   * "no licence has been granted", which is now the state the gate *rejects* — a
   * synthetic baseline must describe a compliant tree or every control below
   * measures the wrong failure.
   *
   * The holder is a synthetic name, not the project's copyright holder: a control
   * tree must not carry a real legal identity, and the control would otherwise
   * plant the owner's name into a temporary directory on every CI run.
   */
  writeFileSync(
    join(scratch, "LICENSE"),
    [
      "MIT License",
      "",
      `Copyright (c) 2026 ${SYNTHETIC_HOLDER}`,
      "",
      "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and",
      "associated documentation files (the \"Software\"), to deal in the Software without restriction.",
      "",
      "The above copyright notice and this permission notice shall be included in all copies or",
      "substantial portions of the Software.",
      "",
      "THE SOFTWARE IS PROVIDED \"AS IS\", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT",
      "NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND",
      "NONINFRINGEMENT.",
      "",
      "IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER",
      "LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN",
      "CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(scratch, "README.md"),
    "# Synthetic\n\n> **Status: MIT licensed.**\n\n" +
      "Use it under the MIT License. Examination papers and course material are not included " +
      "and are not licensed by this project.\n",
    "utf8",
  );
  writeFileSync(join(scratch, "SECURITY.md"), "# Security\n", "utf8");
  writeFileSync(join(scratch, "CONTRIBUTING.md"), "# Contributing\n\n## Licensing\n\nUnder the MIT License. Inbound = outbound.\n", "utf8");
  writeFileSync(join(scratch, "THIRD-PARTY-NOTICES.md"), "# Notices\n\nDependencies keep their own licences; this project's licence does not relicense them.\n", "utf8");
  writeFileSync(join(scratch, ".env.example"), "CET6_DB_PATH=./data/cet6.db\n", "utf8");
  writeFileSync(join(scratch, ".gitignore"), "node_modules\n", "utf8");

  /*
   * `tools/` is copied wholesale rather than file by file.
   *
   * The gate asserts that every entry in its self-describing exemption list
   * resolves to a real file — a deliberate anti-rot check ("a renamed cleanup
   * tool must not leave a silent hole"). A baseline tree missing those tools
   * therefore fails for the *right* reason but the *wrong* cause, which would
   * make this control look broken. Copying the directory keeps the baseline
   * honest and costs ~110 KB.
   */
  mkdirSync(join(scratch, "tools"), { recursive: true });
  for (const name of readdirSync(join(ROOT, "tools"))) {
    if (!name.endsWith(".mjs")) continue;
    copyFileSync(join(ROOT, "tools", name), join(scratch, "tools", name));
  }
  mkdirSync(join(scratch, "tests", "support"), { recursive: true });
  copyFileSync(
    join(ROOT, "tests", "support", "paper-fingerprints.ts"),
    join(scratch, "tests", "support", "paper-fingerprints.ts"),
  );

  if (mutate !== undefined) mutate(scratch);

  /*
   * ── Every synthetic tree is a real Git repository with a real commit ──
   *
   * The attribution check no longer asks the filesystem whether a required file
   * exists; it asks Git. That is the fix for the false-green where `.env.example`
   * sat on disk, was excluded by `.env*`, and the gate still said PASS while every
   * clone was missing it.
   *
   * A baseline tree without an index would fail for the *wrong* reason — "cannot
   * verify membership" — and every control built on it would then measure that
   * instead of what it planted. Initialising and committing the baseline keeps
   * each control honest: the tree starts in the state a releasable tree is in, and
   * the control introduces exactly one defect.
   *
   * Order matters: some controls delete or add files inside `mutate` and rely on
   * the staging below to reflect it, so the commit happens *after* `mutate`.
   */
  gitIn(scratch, ["init", "-q"]);
  gitIn(scratch, ["config", "user.email", "ctl@example.invalid"]);
  gitIn(scratch, ["config", "user.name", "Control"]);
  gitIn(scratch, ["config", "commit.gpgsign", "false"]);
  gitIn(scratch, ["config", "core.excludesFile", ISOLATED_EXCLUDES]);
  gitIn(scratch, ["add", "-A"]);
  gitIn(scratch, ["commit", "-q", "-m", "baseline"]);

  if (afterCommit !== undefined) afterCommit(scratch);

  return scratch;
}

function runGate(directory) {
  try {
    execFileSync(
      process.execPath,
      ["--experimental-transform-types", join(directory, "tools", "public-release-check.mjs")],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

/**
 * Run the gate and keep what it said.
 *
 * ── Why the exit code alone is not evidence ──
 *
 * Every control in this file used to assert only `exit !== 0`. A non-zero exit is
 * produced by *anything* that goes wrong: a `ReferenceError` from a planted line
 * that is not valid JavaScript, a missing file, a Git failure, an unhandled
 * exception in a helper. A control written that way reports success when the tool
 * crashes, which is not the property it claims to prove — it proves the process
 * died, not that the privacy rule fired.
 *
 * This variant returns the combined output so a control can assert on the *reason*:
 * the refusal must name the check it expected, and must not be a crash. A crash has
 * no `[FAIL]` line and carries a stack trace; both are asserted against.
 */
function runGateDetailed(directory) {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--experimental-transform-types", join(directory, "tools", "public-release-check.mjs")],
      { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, output: stdout ?? "" };
  } catch (error) {
    return {
      code: error.status ?? 1,
      output: `${error.stdout ?? ""}${error.stderr ?? ""}`,
    };
  }
}

/**
 * Assert a refusal happened *for the named reason*, not because the tool crashed.
 *
 * `expectedCheck` is the human-readable check title the gate prints, so a control
 * cannot pass on an unrelated failure.
 */
function checkRefusedFor(output, expectedCheck) {
  const failedChecks = [...output.matchAll(/\[FAIL\]\s+(.+)/g)].map((m) => m[1].trim());
  const named = failedChecks.some((title) => title.includes(expectedCheck));
  /*
   * A crash shape: an uncaught exception or a module-load error. Neither can be
   * evidence that a privacy rule ran.
   */
  const crashed = /\b(?:ReferenceError|SyntaxError|TypeError|ERR_MODULE_NOT_FOUND)\b/.test(output);
  return { named, crashed, failedChecks };
}

// ── baseline: the synthetic tree must pass, or the controls prove nothing ──
{
  const scratch = makeTree();
  const code = runGate(scratch);
  check("baseline synthetic tree passes the gate", code === 0, `exit ${code}`);
  rmSync(scratch, { recursive: true, force: true });
}

// ── control 1: a reintroduced AGENTS.md must be rejected ──
{
  const scratch = makeTree((dir) => {
    // Synthetic stand-in: the control is about the *path*, not the content.
    writeFileSync(join(dir, "AGENTS.md"), "# Internal working agreements\n\nNot cleared for publication.\n", "utf8");
  });
  const code = runGate(scratch);
  check("gate REFUSES a tree containing AGENTS.md", code !== 0, `exit ${code}`);
  rmSync(scratch, { recursive: true, force: true });
}

// ── control 2: a reintroduced CLAUDE.md must be rejected ──
{
  const scratch = makeTree((dir) => {
    writeFileSync(join(dir, "CLAUDE.md"), "@AGENTS.md\n", "utf8");
  });
  const code = runGate(scratch);
  check("gate REFUSES a tree containing CLAUDE.md", code !== 0, `exit ${code}`);
  rmSync(scratch, { recursive: true, force: true });
}

// ── control 3: a nested copy must be rejected too ──
{
  const scratch = makeTree((dir) => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "AGENTS.md"), "# copied\n", "utf8");
  });
  const code = runGate(scratch);
  check("gate REFUSES a nested AGENTS.md", code !== 0, `exit ${code}`);
  rmSync(scratch, { recursive: true, force: true });
}

// ── control 4: dropping the licence statement must be rejected ──
{
  const scratch = makeTree((dir) => {
    // A README that simply omits the topic reads as "permissive by default".
    writeFileSync(join(dir, "README.md"), "# Synthetic\n\nNo mention of licensing.\n", "utf8");
  });
  const code = runGate(scratch);
  check("gate REFUSES a README that omits the licence status", code !== 0, `exit ${code}`);
  rmSync(scratch, { recursive: true, force: true });
}

// ── controls 4a-4d: a required file must be in the RELEASE, not just on disk ──
//
// The defect these exist for was a false green: `.env.example` was present on
// disk, a `.gitignore` rule kept it out of the index, the gate called
// `existsSync`, and it reported PASS — while every clone was missing the file
// the README tells the reader to copy.
//
// A check that only asks the filesystem cannot tell a development tree from a
// published one, so these controls assert the four ways that distinction breaks:
// untracked, staged for deletion, committed in the index but missing from HEAD,
// and a tree with no history at all.
{
  const scratch = makeTree((dir) => {
    /*
     * Simulate the real defect exactly: the file is on disk, and an ignore rule
     * excludes it. `mutate` runs *before* `makeTree` stages and commits, so the
     * ignore rule is enough on its own — `git add -A` will not pick the file up.
     * Adding `-f` anywhere here would defeat the purpose of the control.
     */
    writeFileSync(join(dir, ".gitignore"), "node_modules\n.env*\n", "utf8");
  });
  const code = runGate(scratch);
  check(
    "gate REFUSES a required file that exists on disk but is untracked (the .env.example false green)",
    code !== 0,
    `exit ${code}`,
  );
  rmSync(scratch, { recursive: true, force: true });
}
{
  const scratch = makeTree();
  /*
   * Staged for deletion: the file is in HEAD and the *next* commit drops it. This
   * is the shape a careless "clean up generated files" commit takes, and it is
   * invisible to a filesystem check because `git rm --cached` leaves the file on
   * disk. Removing it from the index while HEAD still has it is precisely the
   * staged-deletion state.
   */
  gitIn(scratch, ["rm", "--cached", "-q", ".env.example"]);
  const code = runGate(scratch);
  check(
    "gate REFUSES a required file staged for deletion",
    code !== 0,
    `exit ${code}`,
  );
  rmSync(scratch, { recursive: true, force: true });
}
{
  const scratch = makeTree();
  /*
   * Tracked in the index, absent from HEAD: the window between `git add` and
   * `git commit`. A release built from HEAD would not carry the file. Reached
   * here by dropping it from HEAD and re-adding it to the index, which is the
   * same observable state.
   */
  gitIn(scratch, ["rm", "--cached", "-q", ".env.example"]);
  gitIn(scratch, ["commit", "-q", "-m", "drop the template"]);
  gitIn(scratch, ["add", "-f", ".env.example"]);
  const code = runGate(scratch);
  check(
    "gate REFUSES a required file staged but not yet committed (absent from HEAD)",
    code !== 0,
    `exit ${code}`,
  );
  rmSync(scratch, { recursive: true, force: true });
}
{
  const scratch = makeTree();
  /*
   * A tree with no repository cannot answer "will this be published?", so the
   * answer must be "unverified", which is a failure. Silently passing here would
   * reintroduce the original bug for any build that happens outside a checkout.
   */
  rmSync(join(scratch, ".git"), { recursive: true, force: true });
  const code = runGate(scratch);
  check(
    "gate REFUSES a tree with no Git history (membership cannot be verified)",
    code !== 0,
    `exit ${code}`,
  );
  rmSync(scratch, { recursive: true, force: true });
}

// ── control 5: an excluded internal record path must be rejected ──
{
  const scratch = makeTree((dir) => {
    mkdirSync(join(dir, ".opc"), { recursive: true });
    writeFileSync(join(dir, ".opc", "DECISIONS.md"), "# decisions\n", "utf8");
  });
  const code = runGate(scratch);
  check("gate REFUSES a tree containing .opc/", code !== 0, `exit ${code}`);
  rmSync(scratch, { recursive: true, force: true });
}

// ── controls 6-9: the documentation reference check must reject bad refs ──
//
// The defect class: a README that names tools which do not exist in this
// repository. A check that only proves "the current tree is clean" cannot
// catch that returning, so these controls plant the same defect in a scratch
// tree and assert the check refuses it.
{
  /** Copy the doc checker into a scratch tree that is otherwise valid. */
  function makeDocTree(mutate) {
    /*
     * `makeTree` already initialises a repository and commits a baseline, and the
     * doc checker reads `git ls-files`. A control that edits a document after the
     * baseline commit must re-stage and re-commit, otherwise the index would still
     * describe the pre-defect tree and the checker would scan the wrong content.
     *
     * The restaging belongs in `afterCommit`, not `mutate`: `mutate` runs before
     * `git init`, so a `git add` there would run against a tree that is not yet a
     * repository.
     */
    if (mutate === undefined) return makeTree();
    return makeTree(undefined, (dir) => {
      mutate(dir);
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "-m", "control"]);
    });
  }

  function runDocCheck(directory) {
    try {
      execFileSync(
        process.execPath,
        [join(directory, "tools", "check-doc-references.mjs")],
        { cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return 0;
    } catch (error) {
      return error.status ?? 1;
    }
  }

  // Baseline: the synthetic tree's references all resolve.
  {
    const scratch = makeDocTree();
    const code = runDocCheck(scratch);
    check("baseline: synthetic documentation resolves", code === 0, `exit ${code}`);
    rmSync(scratch, { recursive: true, force: true });
  }

  // 6: a README that names a tools/ file which does not exist.
  {
    const scratch = makeDocTree((dir) => {
      writeFileSync(
        join(dir, "README.md"),
        "# Synthetic\n\nSee `tools/public-export.mjs` for how this was built.\n",
        "utf8",
      );
    });
    const code = runDocCheck(scratch);
    check("doc check REFUSES a README naming a nonexistent tools/ file", code !== 0, `exit ${code}`);
    rmSync(scratch, { recursive: true, force: true });
  }

  // 7: a README that names a package script which does not exist.
  {
    const scratch = makeDocTree((dir) => {
      writeFileSync(
        join(dir, "README.md"),
        "# Synthetic\n\nRun `pnpm release:nonexistent` to do the thing.\n",
        "utf8",
      );
    });
    const code = runDocCheck(scratch);
    check("doc check REFUSES a README naming a nonexistent package script", code !== 0, `exit ${code}`);
    rmSync(scratch, { recursive: true, force: true });
  }

  // 8: a relative Markdown link to a file that does not exist.
  {
    const scratch = makeDocTree((dir) => {
      writeFileSync(
        join(dir, "README.md"),
        "# Synthetic\n\nSee [the contract](docs/not-a-real-file.md) for details.\n",
        "utf8",
      );
    });
    const code = runDocCheck(scratch);
    check("doc check REFUSES a broken relative Markdown link", code !== 0, `exit ${code}`);
    rmSync(scratch, { recursive: true, force: true });
  }

  // 9: an in-page anchor that does not resolve to a heading.
  {
    const scratch = makeDocTree((dir) => {
      writeFileSync(
        join(dir, "README.md"),
        "# Synthetic\n\nJump to [the missing section](#no-such-heading).\n",
        "utf8",
      );
    });
    const code = runDocCheck(scratch);
    check("doc check REFUSES a broken in-page anchor", code !== 0, `exit ${code}`);
    rmSync(scratch, { recursive: true, force: true });
  }

  // 10: a *directory* reference and an external URL must NOT be flagged,
  // otherwise the check becomes noise and gets ignored.
  {
    const scratch = makeDocTree((dir) => {
      mkdirSync(join(dir, "docs"), { recursive: true });
      writeFileSync(join(dir, "docs", "real.md"), "# Real\n", "utf8");
      writeFileSync(
        join(dir, "README.md"),
        [
          "# Synthetic",
          "",
          "See [`docs/`](docs/) for the contracts.",
          "",
          "Upstream reference: https://nodejs.org/docs/latest-v24.x/api/sqlite.html",
          "",
          "The `src/domain/` directory holds pure logic.",
          "",
        ].join("\n"),
        "utf8",
      );
    });
    const code = runDocCheck(scratch);
    check("doc check does NOT flag directory refs, URLs or package-manager builtins", code === 0, `exit ${code}`);
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── controls 11-14: unknown file extensions must not be a scanning blind spot ──
//
// The defect class: both content scanners carried a closed extension allow-list, so
// exam prose planted in `leak.md.bak` was invisible to every one of them. The
// attacker chooses the extension; the scanner must not. These controls plant
// the same phrase under extensions nobody listed and assert the gate refuses
// the tree.
{
  const fingerprintRules = await import(
    new URL("../tests/support/paper-fingerprints.ts", import.meta.url).href
  );
  const { fingerprintPhrase } = fingerprintRules;

  /** A synthetic phrase, assembled at runtime — never real exam material. */
  const phrase = ["a", "synthetic", "control", "phrase", "for", "the", "scanner"].join(" ");
  const fingerprint = fingerprintPhrase(phrase);

  /** Build a tree whose rule set contains our synthetic digest. */
  function makeFingerprintTree(plant) {
    const scratch = makeTree();
    mkdirSync(join(scratch, "docs"), { recursive: true });
    plant(join(scratch, "docs"));
    const ruleSrc = readFileSync(
      new URL("../tests/support/paper-fingerprints.ts", import.meta.url),
      "utf8",
    );
    writeFileSync(
      join(scratch, "tests", "support", "paper-fingerprints.ts"),
      ruleSrc.replace(
        "export const REAL_PAPER_FINGERPRINTS: readonly Fingerprint[] = [",
        `export const REAL_PAPER_FINGERPRINTS: readonly Fingerprint[] = [\n  { digest: "${fingerprint.digest}", tokens: ${fingerprint.tokens} },`,
      ),
      "utf8",
    );
    return scratch;
  }

  function runGateJson(dir) {
    try {
      const output = execFileSync(
        process.execPath,
        ["--experimental-transform-types", join(dir, "tools", "public-release-check.mjs"), "--json", "--root", dir],
        { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
      return { exitCode: 0, output };
    } catch (error) {
      return { exitCode: error.status ?? 1, output: error.stdout?.toString() ?? "" };
    }
  }

  function flaggedFiles(dir) {
    const { output } = runGateJson(dir);
    try {
      const parsed = JSON.parse(output);
      return new Set(parsed.results.find((r) => r.id === "exam-prose").violations.map((v) => v.file));
    } catch {
      return new Set();
    }
  }

  // Baseline: a known-text extension is flagged.
  {
    const scratch = makeFingerprintTree((docs) => writeFileSync(join(docs, "plain.md"), `${phrase}\n`, "utf8"));
    const { exitCode } = runGateJson(scratch);
    check("baseline: a .md file carrying the phrase is refused", exitCode !== 0, `exit ${exitCode}`);
    rmSync(scratch, { recursive: true, force: true });
  }

  // 11-13: the three extensions the review used to demonstrate the hole.
  for (const name of ["leak.md.bak", "note.markdown", "orig.ts.orig"]) {
    const scratch = makeFingerprintTree((docs) => writeFileSync(join(docs, name), `${phrase}\n`, "utf8"));
    const flagged = flaggedFiles(scratch);
    const { exitCode } = runGateJson(scratch);
    check(`gate REFUSES the phrase in \`${name}\``, exitCode !== 0 && flagged.has(`docs/${name}`),
      `exit ${exitCode}, flagged: ${[...flagged].join(", ") || "nothing"}`);
    rmSync(scratch, { recursive: true, force: true });
  }

  // 14: a binary file must NOT be flagged, or the gate becomes noise.
  {
    const scratch = makeFingerprintTree((docs) =>
      // A real PNG header followed by NUL bytes: text-shaped content would be a
      // false positive here, because the *bytes* are what decides.
      writeFileSync(join(docs, "blob.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x01])),
    );
    const flagged = flaggedFiles(scratch);
    check("a binary file is NOT flagged (no false positive)", !flagged.has("docs/blob.png"),
      `flagged: ${[...flagged].join(", ")}`);
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── control 15: a self-exemption must be provable, not promised ──
//
// The defect class: the release gate exempts some of its own files from the
// internal-process scan, on the stated grounds that they contain the forbidden
// tokens only "as quoted pattern definitions". That was a comment, not a check.
// This control plants a forbidden token as *code* in an exempt file and asserts
// the gate now refuses it.
{
  const scratch = makeTree();
  const exemptFile = join(scratch, "tools", "public-release-check.mjs");
  const original = readFileSync(exemptFile, "utf8");
  /*
   * A forbidden token as executable code, not as a pattern literal. This is the
   * exact shape the exemption was supposed to cover and did not: a bare word in
   * code that no comment or string literal contains.
   *
   * ── Why the planted word is a shape and not a bare acronym ──
   *
   * This control used to plant a bare role acronym. That passed for the wrong
   * reason: the acronym is *not* one of the enforced shapes (see the note in
   * `INTERNAL_PROCESS_PATTERNS` about not matching a bare word), so the gate did
   * not refuse it as a token — the planted line was a bare identifier, the module
   * threw a ReferenceError, and the non-zero exit was read as a refusal. A
   * control that passes because the tool crashed proves nothing about the scan.
   *
   * The planted text is now a real enforced shape — a review attribution — placed
   * in an executable position, so the non-zero exit can only mean the token scan
   * fired. `expectPlanted` still asserts the anchor was found.
   */
  const planted = original.replace(
    "const SKIP_DIRECTORIES = new Set([",
    'const SKIP_DIRECTORIES = new Set([\n  // planted by the exemption control\n  "Syntheticprobe review round 3",',
  );
  expectPlanted(planted, original);
  writeFileSync(exemptFile, planted, "utf8");

  const { code, output } = runGateDetailed(scratch);
  const { named, crashed } = checkRefusedFor(output, "no internal workflow tokens");
  check(
    "gate REFUSES a forbidden token appearing as code in an exempt file",
    code !== 0 && named && !crashed,
    code === 0 ? "ACCEPTED — the exemption covered executable code" : crashed ? "CRASHED — this control was proving a ReferenceError, not a refusal" : "refused by a different check",
  );
  rmSync(scratch, { recursive: true, force: true });
}

/** The control is only meaningful if the plant actually changed the file. */
function expectPlanted(planted, original) {
  if (planted === original) {
    console.error("FAIL  exemption control could not find its anchor — the gate's shape changed");
    process.exit(1);
  }
}

/*
 * ── control 20: template literals must not hide a token  ──
 *
 * Regression control for template-literal scanning. The old
 * proof stripped whole template literals — including their `${...}`
 * interpolations — so a token inside one was invisible in exactly the files whose
 * exemption is supposed to be *proven*.
 *
 * Three shapes, because "template literal" is not one thing: literal text, an
 * interpolation, and a nested template.
 */
{
  /*
   * The probe is a full enforced shape, not a bare word.
   *
   * It has to be: the gate matches review attributions and sign-off verdicts by
   * shape, not by a list of names (see the note in `INTERNAL_PROCESS_PATTERNS`).
   * A bare invented word is not a violation, so planting one would have asserted
   * "the gate refuses any identifier in a template" — which is not a rule this
   * project has, and would have been a control that passes only if the gate were
   * wrong.
   */
  const token = "Syntheticprobe review round 3";

  /*
   * Each shape must be *valid JavaScript* in which the forbidden token is present.
   *
   * This is what the previous version missed. It interpolated the raw token text
   * into `${...}`, which makes the planted expression a bare phrase like
   * `${Syntheticprobe review round 3}` — not a string, but three identifiers and a
   * space. The module threw, the process exited non-zero, and the control read that
   * as "the gate refused it". It was proving a ReferenceError, in the very control
   * whose subject is that a token in a template is still seen.
   *
   * The interpolation now carries a *quoted string literal*, so the file parses and
   * runs, and the only thing that can fail it is the scan. The paired assertion in
   * the loop checks the refusal's stated reason and rejects a crash, so the defect
   * cannot come back silently.
   */
  const quoted = JSON.stringify(token);
  const shapes = [
    ["20a", `const v = \`${token}\`;`, "literal text"],
    ["20b", `const v = \`a \${${quoted}} b\`;`, "interpolation"],
    ["20c", `const v = \`a \${\`b \${${quoted}} c\`} d\`;`, "nested template"],
  ];

  for (const [id, line, label] of shapes) {
    const scratch = makeTree((dir) => {
      const target = join(dir, "tools", "public-release-check.mjs");
      writeFileSync(target, `${readFileSync(target, "utf8")}\n${line}\n`, "utf8");
    });
    const { code, output } = runGateDetailed(scratch);
    /*
     * The refusal must be the internal-process scan naming the attribution rule —
     * not a crash, and not some other check that happened to go red. This is the
     * difference between "the token was seen in a template" and "the module threw".
     */
    const { named, crashed } = checkRefusedFor(output, "no internal workflow tokens");
    check(
      `control ${id}: gate REFUSES a token in a template (${label})`,
      code !== 0 && named && !crashed,
      code === 0
        ? "ACCEPTED — the token was invisible in this position"
        : crashed
          ? "CRASHED — non-zero exit was not produced by the token scan"
          : "refused, but not by the internal-process check",
    );
    rmSync(scratch, { recursive: true, force: true });
  }
}

/*
 * ── control 21: a markdown comment is documentation, not content  ──
 *
 * The counterpart that keeps control 20 from degenerating into "reject every
 * template". A token inside `<!-- -->` is invisible to a reader, so it is
 * documentation, and an allowance file may contain it.
 */
{
  const token = "Syntheticprobe";
  const scratch = makeTree((dir) => {
    const target = join(dir, "docs", "note.md");
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, `<!-- explains why ${token} is not allowed -->\n`, "utf8");
  });
  check("control 21: gate ACCEPTS a token inside a markdown comment", runGate(scratch) === 0);
  rmSync(scratch, { recursive: true, force: true });
}

// ── control 15b: the contribution guide has no blanket skip ──
//
// The contribution guide states the rules, so it is the file most likely to be
// granted a blanket skip. It has none: its allowance is a **ceiling of 0**, so
// any occurrence of an enforced shape in it must be refused — whether the text
// sits in code or in prose.
//
// ── What this control plants, and why it changed ──
//
// It used to plant a bare identifier and assert rejection. That stopped
// discriminating twice over: the guide no longer needs to name any token, and a
// bare identifier is not one of the enforced shapes, so the planted line was
// simply an undefined name rather than a scan hit.
//
// It now plants a real enforced shape into the real guide. The property asserted
// is the one that matters for this file: prose in a `.md` file is reader-visible,
// so a review attribution written there is a disclosure and must be refused.
{
  const scratch = makeTree();
  const guide = join(scratch, "CONTRIBUTING.md");

  /*
   * Copy the real guide so the planted sentence lands in the file whose exemption
   * is in question, not in a placeholder that might behave differently.
   */
  copyFileSync(join(ROOT, "CONTRIBUTING.md"), guide);
  const original = readFileSync(guide, "utf8");
  writeFileSync(guide, `${original}\n\nSign-off: Syntheticprobe review round 3.\n`, "utf8");

  const { code, output } = runGateDetailed(scratch);
  const { named, crashed } = checkRefusedFor(output, "no internal workflow tokens");
  check(
    "gate REFUSES an enforced shape written into the contribution guide",
    code !== 0 && named && !crashed,
    code === 0 ? "ACCEPTED — a reader-visible phrase in the guide passed" : crashed ? "CRASHED" : "refused by a different check",
  );
  rmSync(scratch, { recursive: true, force: true });
}
// ── controls 16-18: the client-bundle check must cover server-side maps ──
//
// The defect class: a bundle check that scans only `.next/static/` and
// `.next/server/app/`. Server-side chunks and their source maps were not
// covered, so a machine path serialised into a `*.map` passed unnoticed. These
// controls build a fake build directory containing genuine leaks and assert the
// check refuses it.
{
  /** A fake `.next/` with a browser asset and a server-side map. */
  function makeBuildDir(plantBrowser, plantServerMap) {
    const dir = createTempDir("bundle-ctl-").path;
    mkdirSync(join(dir, "static", "chunks"), { recursive: true });
    mkdirSync(join(dir, "server", "chunks"), { recursive: true });
    mkdirSync(join(dir, "server", "app"), { recursive: true });
    // Something for the walker to find in each root, so an empty tree is not
    // mistaken for a pass.
    writeFileSync(join(dir, "static", "chunks", "app.js"), "var a=1;\n", "utf8");
    writeFileSync(join(dir, "server", "app", "page.js"), "var b=2;\n", "utf8");
    if (plantBrowser !== undefined) plantBrowser(dir);
    if (plantServerMap !== undefined) plantServerMap(dir);
    return dir;
  }

  /**
   * Run the bundle check and always return its output.
   *
   * The first version returned `output: ""` on success, keeping stdout only in
   * the failure branch. That is fine for controls asserting a non-zero exit, but
   * it makes a control asserting *what was reported on success* untestable — it
   * would compare against an empty string and fail forever, which is how a real
   * regression gets mistaken for a broken control.
   *
   * Using `spawnSync` rather than a try/catch around `execFileSync` keeps stdout
   * available in both cases.
   */
  function runBundleCheck(buildDir) {
    const result = spawnSync(
      process.execPath,
      [join(ROOT, "tools", "check-client-bundle.mjs"), "--build-dir", buildDir],
      { cwd: ROOT, encoding: "utf8" },
    );
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return { exitCode: result.status ?? 1, output };
  }

  // Baseline: a clean fake build passes.
  {
    const dir = makeBuildDir();
    const { exitCode } = runBundleCheck(dir);
    check("baseline: a clean build directory passes", exitCode === 0, `exit ${exitCode}`);
    rmSync(dir, { recursive: true, force: true });
  }

  // 16: an internal directory name in a browser asset is refused.
  {
    const dir = makeBuildDir((d) =>
      writeFileSync(join(d, "static", "chunks", "leak.js"), `var x="${["private", "-content"].join("")}";\n`, "utf8"),
    );
    const { exitCode, output } = runBundleCheck(dir);
    check(
      "bundle check REFUSES an internal directory name in a browser asset",
      exitCode !== 0 && output.includes("internal directory name"),
      `exit ${exitCode}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // 17: a server-only module reference in a browser asset is refused.
  {
    const dir = makeBuildDir((d) =>
      writeFileSync(join(d, "static", "chunks", "db.js"), `require("node:sqlite");\n`, "utf8"),
    );
    const { exitCode, output } = runBundleCheck(dir);
    check(
      "bundle check REFUSES a server-only reference in a browser asset",
      exitCode !== 0 && output.includes("server-only"),
      `exit ${exitCode}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  /*
   * 18: the build directory's own path in a *server-side* source map.
   *
   * ── Why the expectation changed with ──
   *
   * The original control asserted that a machine path in a server-side `.map` fails.
   * That was defensible while the tool only scanned four subdirectories, because
   * a map was the only place such a path could appear.
   *
   * proved Next.js *always* writes absolute paths into
   * `required-server-files.{js,json}` — they cannot be configured away. So "any
   * machine path anywhere in the build fails" became an impossible rule, and an
   * impossible rule gets disabled. The boundary was redrawn:
   *
   *   - a machine path in a **browser** asset is fatal (visitor-facing);
   *   - a machine path in a **server** asset is expected, and is *reported* so the
   *     publisher can see what must not ship;
   *   - `check-release-archive.mjs` enforces that those server files are excluded
   *     from any published archive and are not served over HTTP.
   *
   * This control therefore asserts the new, still-meaningful property: a server
   * map carrying the build path is **reported** rather than silently ignored.
   * Control 17b below covers the fatal case.
   */
  {
    const dir = makeBuildDir(undefined, (d) => {
      writeFileSync(
        join(d, "server", "chunks", "src.js.map"),
        JSON.stringify({
          version: 3,
          sources: ["webpack://./src/db/client.ts"],
          sourcesContent: [`const p = "${ROOT.replace(/\\/g, "/")}/data/cet6.db";`],
        }),
        "utf8",
      );
    });
    const { exitCode, output } = runBundleCheck(dir);
    check(
      "bundle check REPORTS the build path in a server-side source map (boundary)",
      exitCode === 0 && output.includes("server-private asset"),
      `exit ${exitCode}, output has report line: ${output.includes("server-private asset")}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  /*
   * 17b: the fatal case — the same path in a **browser** asset must fail.
   *
   * Without this, control 18's relaxation could hide a real regression: the tool
   * would report everything and refuse nothing.
   */
  {
    const dir = makeBuildDir((d) =>
      writeFileSync(
        join(d, "static", "chunks", "boot.js"),
        `var root = "${ROOT.replace(/\\/g, "/")}";\n`,
        "utf8",
      ),
    );
    const { exitCode, output } = runBundleCheck(dir);
    check(
      "bundle check REFUSES the build path in a BROWSER asset (fatal)",
      exitCode !== 0 && output.includes("BROWSER asset"),
      `exit ${exitCode}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }

  // 19: an *illustrative* path in a comment must NOT be refused, or the gate
  //     becomes noise. The repository's own threat-model comments contain
  //     `C:\Windows\...` and a quoted ENOENT message on purpose.
  {
    const dir = makeBuildDir(undefined, (d) => {
      writeFileSync(
        join(d, "server", "chunks", "docs.js.map"),
        JSON.stringify({
          version: 3,
          sources: ["webpack://./src/x.ts"],
          sourcesContent: [
            "// Threat model: `C:\\Windows\\...` or `/etc/passwd` are absolute paths.",
            "// Example: ENOENT ... open 'D:\\...\\private-content\\courses\\x\\course.json'",
          ],
        }),
        "utf8",
      );
    });
    const { exitCode } = runBundleCheck(dir);
    check("bundle check does NOT refuse illustrative paths in comments", exitCode === 0, `exit ${exitCode}`);
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── controls 22-24: a branch outside HEAD's history must be rejected ──
/*
 * The defect these exist for (found in the V6 publication revalidation).
 *
 * `audit-object-database.mjs` asserted "exactly one parentless root commit" with
 * `git rev-list --max-parents=0 HEAD`. That answers "how many roots does this
 * commit's history have", which is the right question for what a clone of the
 * default branch receives. It is the wrong question for what a **push** publishes:
 * a local branch that is not an ancestor of HEAD is invisible to a HEAD-scoped
 * query, yet `git push --all` and `git push --mirror` send every local branch.
 *
 * Measured consequence: `master` a pristine single-root snapshot, plus one orphan
 * branch holding anything at all, passed the audit with "exactly one parentless
 * root commit" while `--all` reported two roots and `git push --all` published
 * both. Content on that branch also escaped every content gate, because those scan
 * the checked-out worktree and HEAD by design.
 *
 * The fix asserts that every **local branch** belongs to HEAD's history. These
 * controls prove the assertion fires, and — equally important — that it does not
 * fire on the states a legitimate checkout actually has: one branch, and a clone's
 * remote-tracking refs.
 */
{
  /**
   * Run the object-database audit against a scratch repo.
   *
   * The script is invoked by its path in *this* checkout (ROOT), with `cwd` set to
   * the scratch tree, because the audit inspects the repository at its working
   * directory. Pointing at `join(directory, "tools", …)` would look for the tool
   * inside the synthetic tree, which only has a README.
   */
  function runObjectAudit(directory) {
    try {
      execFileSync(process.execPath, [join(ROOT, "tools", "audit-object-database.mjs")], {
        cwd: directory,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        env: ISOLATED_GIT_ENV,
      });
      return { exitCode: 0, output: "" };
    } catch (error) {
      return { exitCode: error.status ?? 1, output: `${error.stdout ?? ""}${error.stderr ?? ""}` };
    }
  }

  /** Build a synthetic repo with one committed root, then let the caller mutate it. */
  function makeAuditTree(mutate) {
    const scratch = createTempDir("audit-ctl-").path;
    gitIn(scratch, ["init", "-q"]);
    gitIn(scratch, ["config", "user.email", "maintainer@users.noreply.github.com"]);
    gitIn(scratch, ["config", "user.name", "CET6 Coach Maintainer"]);
    gitIn(scratch, ["config", "commit.gpgsign", "false"]);
    writeFileSync(join(scratch, "README.md"), "# synthetic\n", "utf8");
    gitIn(scratch, ["add", "-A"]);
    gitIn(scratch, ["commit", "-q", "-m", "Initial public source distribution"]);
    if (mutate !== undefined) mutate(scratch);
    return scratch;
  }

  // 22: the baseline must pass, or the controls below prove nothing.
  {
    const scratch = makeAuditTree();
    const { exitCode } = runObjectAudit(scratch);
    check("control 22: audit ACCEPTS a single-branch single-root repository", exitCode === 0, `exit ${exitCode}`);
    rmSync(scratch, { recursive: true, force: true });
  }

  // 23: an orphan branch that is not an ancestor of HEAD must be rejected.
  {
    const scratch = makeAuditTree((dir) => {
      gitIn(dir, ["checkout", "-q", "--orphan", "stray"]);
      writeFileSync(join(dir, "stray.md"), "# unrelated history\n", "utf8");
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "-m", "stray root"]);
      gitIn(dir, ["checkout", "-q", "master"]);
    });
    const { exitCode, output } = runObjectAudit(scratch);
    check(
      "control 23: audit REFUSES a local branch outside HEAD's history",
      exitCode !== 0 && /not part of HEAD's history/.test(output),
      `exit ${exitCode}, message present: ${/not part of HEAD's history/.test(output)}`,
    );
    rmSync(scratch, { recursive: true, force: true });
  }

  // 24: a *clone* materialises remote-tracking refs; those must not be reported.
  //     `actions/checkout` is a clone, so a false positive here would make the
  //     publication job red on a correct tree — the failure mode that teaches
  //     people to ignore a gate.
  {
    const origin = makeAuditTree();
    const clone = createTempDir("audit-clone-").path;
    try {
      gitIn(clone, ["clone", "-q", origin, "."]);
      const { exitCode } = runObjectAudit(clone);
      check(
        "control 24: audit ACCEPTS a clone (remote-tracking refs are not stray branches)",
        exitCode === 0,
        `exit ${exitCode}`,
      );
    } finally {
      rmSync(clone, { recursive: true, force: true });
      rmSync(origin, { recursive: true, force: true });
    }
  }

  /*
   * ── control 25: editing an exempt tool must not fail the object audit ──
   *
   * The defect class: the object→path map was built from `HEAD` alone, while the
   * "naming it is the function" exemption is looked up *by path*. The previous
   * revision of an exempt file is still a reachable object and still contains the
   * names its function requires, but it is not in `HEAD`, so it had no path, so
   * the exemption could not apply. Result: **any** commit that merely reworded a
   * comment in one of these tools failed the audit with "object contains '.opc/'",
   * pointing at the superseded blob.
   *
   * That is worse than a normal false positive. It makes the gate fail on exactly
   * the change a contributor is asked to make (fix a leak by editing the tool),
   * and the only ways out are to delete the check or to stop editing the tools —
   * both of which reduce safety. So the behaviour is pinned here.
   *
   * The baseline commit writes the exempt tool; the second commit edits one line.
   * Both revisions contain the forbidden name, only the older one is out of HEAD.
   */
  {
    const dir = createTempDir("audit-exempt-").path;
    try {
      gitIn(dir, ["init", "-q"]);
      gitIn(dir, ["config", "user.email", "maintainer@users.noreply.github.com"]);
      gitIn(dir, ["config", "user.name", "CET6 Coach Maintainer"]);
      gitIn(dir, ["config", "commit.gpgsign", "false"]);
      mkdirSync(join(dir, "tools"), { recursive: true });
      /*
       * The forbidden name is assembled at runtime, the same way the neighbouring
       * controls do it: this file is itself scanned, and planting the name as a
       * literal here would spend the allowance that exists for the *controls*
       * rather than documenting anything.
       */
      const RECORD_DIR = ["." , "opc", "/"].join("");
      const tool = join(dir, "tools", "audit-history.mjs");
      writeFileSync(tool, `// a scanner names what it refuses: "${RECORD_DIR}"\n`, "utf8");
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "-m", "Initial public source distribution"]);

      // The realistic edit: reword a comment in the exempt tool, touching nothing else.
      writeFileSync(tool, `// a scanner names what it refuses: "${RECORD_DIR}" (reworded)\n`, "utf8");
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "-m", "docs: reword a comment"]);

      const { exitCode, output } = runObjectAudit(dir);
      check(
        "control 25: audit ACCEPTS a reworded exempt tool (superseded blob keeps its path)",
        exitCode === 0,
        `exit ${exitCode}${exitCode === 0 ? "" : ` — ${output.split("\n").find((l) => l.includes("object contains")) ?? ""}`}`,
      );

      /*
       * The counterpart that stops control 25 from becoming "exempt everything":
       * the same forbidden name in a file that is NOT on the list must still be
       * refused, even though the map now covers every revision.
       */
      writeFileSync(join(dir, "src-leak.md"), `leaked record path: "${RECORD_DIR}"\n`, "utf8");
      gitIn(dir, ["add", "-A"]);
      gitIn(dir, ["commit", "-q", "-m", "test: plant a name outside the list"]);
      const second = runObjectAudit(dir);
      check(
        "control 25b: audit still REFUSES the same name in a non-exempt file",
        second.exitCode !== 0,
        `exit ${second.exitCode}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/*
 * ── control 26: an underscore-joined internal status code must be refused ──
 *
 * The defect class: every rule in the token table matched **space-separated
 * attribution** (`<role> review round 3`, `reviewed by <Name>`, `<ROLE> PASS`).
 * An internal acceptance code is one underscore-joined identifier, so the whole
 * family was invisible — which is how one reached public `master` inside a merge
 * commit's body.
 *
 * Three directions, because any one alone proves too little:
 *
 *   26a  a synthetic status code in published prose is REFUSED, for that reason;
 *   26b  the refusal does not echo the code (a CI log is as public as the repo);
 *   26c  neutral engineering prose and constant names stay GREEN — a rule that
 *        fires on correct writing gets switched off, which is how guards die.
 *
 * The code is assembled at runtime: this file is itself scanned, and planting a
 * literal would spend the allowance that exists for the controls.
 */
{
  const STATUS_CODE = ["SYNTHETICPROBE", "STAGE", "REVIEW", "APPROVED"].join("_");

  // 26a / 26b: plant it in markdown prose — reader-visible, no comment tolerance.
  {
    const scratch = makeTree((dir) => {
      writeFileSync(
        join(dir, "NOTES.md"),
        `# Notes\n\nMerged after sign-off: ${STATUS_CODE}.\n`,
        "utf8",
      );
    });
    const { code, output } = runGateDetailed(scratch);

    /*
     * Assert the *reason*, not merely a non-zero exit: a ReferenceError or a
     * missing file also exits non-zero, and a control that accepts that proves
     * nothing about the status-code rule.
     */
    const { named, crashed } = checkRefusedFor(output, "underscore-joined internal status code");
    check(
      "control 26a: gate REFUSES an underscore-joined status code in published prose",
      code !== 0 && named && !crashed,
      code === 0
        ? "ACCEPTED — the status-code rule did not fire"
        : crashed
          ? "CRASHED — this control was proving an exception, not a refusal"
          : "refused by a different check",
    );

    check(
      "control 26b: the status-code refusal does not echo the planted code",
      !output.includes(STATUS_CODE),
      "the planted code appeared in gate output",
    );

    rmSync(scratch, { recursive: true, force: true });
  }

  // 26c: neutral engineering prose must stay green.
  {
    const neutral = [
      "# Neutral notes",
      "",
      "fix(tools): judge identities by disclosure, not by commit authorship model",
      "docs: describe commit-exclusion rules without naming internal tokens",
      "refactor(tools): detect internal-process records by shape, not by private names",
      "Merging the three reviewed commits; no post-review changes.",
      "Independent security review passed. No post-review changes.",
      "Adds MIT licence; inbound = outbound.",
      "See COURSE_MANIFEST_SCHEMA_VERSION and MAX_SAFE_INTEGER for the field names.",
      "A runtime error such as ERR_MODULE_NOT_FOUND is handled by the loader.",
      "",
    ].join("\n");
    const scratch = makeTree((dir) => {
      writeFileSync(join(dir, "NOTES.md"), neutral, "utf8");
    });
    const { code, output } = runGateDetailed(scratch);
    check(
      "control 26c: gate ACCEPTS neutral engineering prose and constant names",
      code === 0,
      output
        .split("\n")
        .filter((line) => /status code|FAIL/.test(line))
        .slice(0, 4)
        .join(" | "),
    );
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.error(`\n${failures} gate control(s) FAILED`);
  process.exit(1);
}
console.log("\ngate negative controls: PASS");
