#!/usr/bin/env node
/**
 * Regression guard: template and interpolation scanning.
 *
 * The invariant to test: `tools/public-release-check.mjs` strips whole template
 * literals — including `${...}` interpolations — before re-scanning an exempt
 * file for internal-process tokens. If true, a forbidden token placed inside a
 * template literal in an exempt file is invisible to the "provable exemption"
 * check.
 *
 * This probe does NOT modify the staging tree. It copies the two exempt files
 * into a minimal synthetic tree, plants the probe, and runs the real gate.
 *
 * Usage: node tools/guard-token-scanner.mjs
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Synthesise a minimal tree the gate accepts, then mutate. */
function makeTree(mutate) {
  const scratch = mkdtempSync(join(tmpdir(), "n1-"));

  writeFileSync(
    join(scratch, "package.json"),
    JSON.stringify({ name: "n1", private: true, license: "MIT" }),
    "utf8",
  );
  /*
   * The baseline tree carries a genuine MIT licence, because that is what the
   * gate requires since the project adopted MIT. The earlier version declared
   * "no licence has been granted", which the gate now *rejects* — so the baseline
   * failed before any control ran, and every control below measured that instead
   * of the token it planted.
   *
   * The holder is synthetic: a control tree must not carry the project's real
   * copyright holder.
   */
  writeFileSync(
    join(scratch, "LICENSE"),
    [
      "MIT License",
      "",
      "Copyright (c) 2026 Synthetic Control",
      "",
      "Permission is hereby granted, free of charge, to any person obtaining a copy of this software and",
      'associated documentation files (the "Software"), to deal in the Software without restriction.',
      "",
      "The above copyright notice and this permission notice shall be included in all copies or",
      "substantial portions of the Software.",
      "",
      'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT',
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
    "# N1\n\n> **Status: MIT licensed.**\n\n" +
      "Use it under the MIT License. Examination papers and course material are not included " +
      "and are not licensed by this project.\n",
    "utf8",
  );
  writeFileSync(join(scratch, "SECURITY.md"), "# Security\n", "utf8");
  writeFileSync(
    join(scratch, "THIRD-PARTY-NOTICES.md"),
    "# Notices\n\nDependencies keep their own licences; this project's licence does not relicense them.\n",
    "utf8",
  );
  writeFileSync(join(scratch, ".env.example"), "CET6_DB_PATH=./data/cet6.db\n", "utf8");
  writeFileSync(join(scratch, ".gitignore"), "node_modules\ndata\n.next\n", "utf8");

  /*
   * `CONTRIBUTING.md` is *not* copied from the real tree.
   *
   * It is one of the files with a counted token allowance, so a verbatim copy
   * would arrive already at its ceiling and every control that appends one more
   * token would pass for the wrong reason. A clean placeholder makes each control
   * measure exactly what it planted. It still has to satisfy the licence clause,
   * which requires the file to name the licence and state inbound = outbound.
   */
  writeFileSync(
    join(scratch, "CONTRIBUTING.md"),
    "# Contributing\n\nBe decent.\n\n## Licensing\n\nUnder the MIT License. Inbound = outbound.\n",
    "utf8",
  );

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

  if (mutate) mutate(scratch);

  /*
   * The gate now asks Git whether a required file will actually be published, so
   * this synthetic tree has to be a repository with a real commit — otherwise the
   * baseline fails with "membership cannot be verified" and every control below
   * would be measuring that instead of the token it planted.
   *
   * Git is run with the operator's configuration neutralised. A personal
   * `core.excludesFile` would silently change what `git add -A` picks up and make
   * the result depend on the machine, which is exactly what a control must not do.
   */
  const configRoot = mkdtempSync(join(tmpdir(), "token-ctl-gitcfg-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(configRoot, "global-config"),
    GIT_CONFIG_SYSTEM: join(configRoot, "system-config"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "", "utf8");
  writeFileSync(gitEnv.GIT_CONFIG_SYSTEM, "", "utf8");
  const git = (args) => execFileSync("git", args, { cwd: scratch, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: gitEnv });
  git(["init", "-q"]);
  git(["config", "user.email", "ctl@example.invalid"]);
  git(["config", "user.name", "Control"]);
  git(["config", "commit.gpgsign", "false"]);
  git(["config", "core.excludesFile", join(configRoot, "excludes")]);
  writeFileSync(join(configRoot, "excludes"), "", "utf8");
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "baseline"]);

  return scratch;
}

function gateExit(directory) {
  try {
    execFileSync(process.execPath, [join(directory, "tools", "public-release-check.mjs")], {
      cwd: directory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

/**
 * A forbidden token, assembled so this probe file never contains one literally
 * (the probe lives in the tree the gate scans).
 *
 * The token must be one the gate actually enforces. Bare `CTO` is deliberately
 * *not* matched (see the comment on INTERNAL_PROCESS_PATTERNS: a bare acronym
 * would also fire on legitimate technical uses, and a guard that fires on
 * correct code gets switched off). The review-role name and the decision-record
 * identifier are the enforced shapes, so the probe uses them.
 */
/*
 * A synthetic probe that is a full ENFORCED SHAPE, not a bare name.
 *
 * The gate matches internal-process material by shape: a review attribution
 * ("<Name> review round N"), a sign-off verdict, a decision-record identifier.
 * It deliberately does not match an arbitrary word, because doing so would fire
 * on legitimate code.
 *
 * The probe therefore has to be a shape the rules actually name. An earlier
 * revision of this file used the internal workflow's own assistant-tool name,
 * assembled from fragments. That was wrong twice: it published the name for any
 * reader to reconstruct, and it left these probes asserting that the gate rejects
 * a bare identifier — which is not a rule this project has.
 *
 * `Syntheticprobe` is a plainly invented placeholder. Pairing it with
 * `review round 3` makes it the enforced attribution shape, so every probe below
 * asks a real question: is a violation of a real rule visible in this position?
 */
const TOKEN = "Syntheticprobe review round 3";
const TOKEN_2 = "D-042";

/*
 * ── Which file each control plants into ──
 *
 * `CONTRIBUTING.md` used to be the natural target. Because it carries a
 * **counted allowance** (it must name the rules it states), so appending one more
 * token stays under the ceiling and the control would pass for the wrong reason.
 *
 * The controls therefore plant into files with **no allowance at all**. That is
 * the correct target anyway: the question here is whether a token in a
 * template is visible to the scanner, and the answer should not depend on which
 * file it lands in.
 */
const TARGET = "docs/probe.md";

/** Create the no-allowance target file. */
function plant(scratch, content) {
  mkdirSync(join(scratch, "docs"), { recursive: true });
  writeFileSync(join(scratch, TARGET), `${content}\n`, "utf8");
}

/**
 * An allowed file's *own* ceiling must still be enforced.
 *
 * `CONTRIBUTING.md` is copied verbatim from the real tree in the baseline, so it
 * arrives already at its allowance. Appending a token to it must therefore be
 * rejected — not because templates are invisible, but because the ceiling moved.
 */
function appendToQuota(scratch, line) {
  const path = join(scratch, "CONTRIBUTING.md");
  writeFileSync(path, `${readFileSync(path, "utf8")}\n${line}\n`, "utf8");
}

console.log("token scanner: template and interpolation handling\n");

/* ── baseline ── */
{
  const scratch = makeTree();
  check("baseline synthetic tree passes", gateExit(scratch) === 0);
  rmSync(scratch, { recursive: true, force: true });
}

/*
 * ── A: an enforced shape in an unquoted expression position ──
 *
 * The violation is assembled at runtime and written into the string being
 * concatenated, so the probe never carries it as a literal of its own — but the
 * gate still has to see it, because the file it scans does carry it.
 */
{
  const scratch = makeTree((dir) => plant(dir, `const x = ${TOKEN};`));
  check("A. enforced shape in an unquoted position is REJECTED", gateExit(scratch) !== 0);
  rmSync(scratch, { recursive: true, force: true });
}

/*
 * ── B: the shape the old proof *believed* it verified ──
 *
 * A quoted string is a value a program can return, so a token there is reported.
 * The old proof stripped it and found nothing; that was not verification, it was
 * deletion. Rejection is the correct behaviour, and the allowance mechanism — not
 * a blanket skip — is how the files that genuinely need such strings cope.
 */
{
  const scratch = makeTree((dir) => plant(dir, `const x = "${TOKEN}";`));
  check("B. quoted string value is REJECTED", gateExit(scratch) !== 0);
  rmSync(scratch, { recursive: true, force: true });
}

/* ── C: token inside a template's literal text ── */
{
  const scratch = makeTree((dir) => plant(dir, `const x = \`${TOKEN}\`;`));
  const code = gateExit(scratch);
  check(
    "C. template literal text containing the token is REJECTED (regression)",
    code !== 0,
    code === 0 ? "ACCEPTED — template literals were stripped whole" : "",
  );
  rmSync(scratch, { recursive: true, force: true });
}

/* ── C2: a second enforced shape, same position ── */
{
  const scratch = makeTree((dir) => plant(dir, `const x = \`see ${TOKEN_2} for details\`;`));
  check("C2. decision-record id in template text is REJECTED", gateExit(scratch) !== 0);
  rmSync(scratch, { recursive: true, force: true });
}

/* ── C3: token reachable only through an interpolation ── */
{
  const scratch = makeTree((dir) => plant(dir, `const x = \`value: \${${TOKEN}}\`;`));
  check("C3. token inside a template interpolation is REJECTED", gateExit(scratch) !== 0);
  rmSync(scratch, { recursive: true, force: true });
}

/* ── C4: nested template, the shape a regex cannot track ── */
{
  const scratch = makeTree((dir) =>
    plant(dir, `const x = \`a\${\`b\${${TOKEN}}\`}c\`;`),
  );
  check("C4. token in a nested template is REJECTED", gateExit(scratch) !== 0);
  rmSync(scratch, { recursive: true, force: true });
}

/*
 * ── D: a token added to an *allowed* file beyond its ceiling ──
 *
 * This is the realistic arrival path for a leak: not a new file, but one more
 * line in a file that was already permitted to mention the topic.
 *
 * The real `CONTRIBUTING.md` must be copied for this to test anything: the whole
 * point is that it already sits exactly at its ceiling, so one more token pushes
 * it over. Copying a blank placeholder instead would leave headroom and the
 * control would pass for the wrong reason — which is what it did on the first
 * attempt.
 */
{
  const scratch = makeTree((dir) => {
    copyFileSync(join(ROOT, "CONTRIBUTING.md"), join(dir, "CONTRIBUTING.md"));
    appendToQuota(dir, `const z = \`\${a}${TOKEN}\`;`);
  });
  check("D. token beyond an allowance ceiling is REJECTED", gateExit(scratch) !== 0);
  rmSync(scratch, { recursive: true, force: true });
}

/*
 * ── E: comments remain legitimate ──
 *
 * A comment is not returned to a user, and documentation has to be able to name
 * what it forbids. This is the one exclusion, and it must keep working or the
 * gate would be unusable.
 *
 * The probe file is `.md`, so the scanner parses it as markdown, where the only
 * comment form is `<!-- -->`. Writing a `//` comment into a `.md` file would not
 * test markdown — it would test a JavaScript comment sitting inside a file that
 * is not JavaScript, which is exactly the confusion this control uncovered.
 */
{
  const scratch = makeTree((dir) => plant(dir, `<!-- explains why ${TOKEN} is not allowed -->`));
  check("E. token in a markdown comment is ACCEPTED", gateExit(scratch) === 0);
  rmSync(scratch, { recursive: true, force: true });
}

/*
 * ── E2: a fenced code block is rendered, so it is NOT a comment ──
 *
 * This is the counterpart that makes E meaningful: if everything in markdown were
 * "a comment", E would pass trivially and check nothing.
 */
{
  const scratch = makeTree((dir) =>
    plant(dir, ["```js", `// ${TOKEN} is forbidden`, "```"].join("\n")),
  );
  check("E2. token in a fenced code block is REJECTED (it is rendered)", gateExit(scratch) !== 0);
  rmSync(scratch, { recursive: true, force: true });
}

// ── control F: non-exempt file must reject templates regardless ──
{
  const scratch = makeTree((dir) => {
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(join(dir, "docs", "leak.md"), `const x = \`${TOKEN}\`;\n`, "utf8");
  });
  check("F. non-exempt file with a template is REJECTED (main scan intact)", gateExit(scratch) !== 0);
  rmSync(scratch, { recursive: true, force: true });
}

console.log("");
if (failures > 0) {
  console.error(`${failures} probe(s) FAILED`);
  process.exit(1);
}
console.log("token scanner: no bypass");
