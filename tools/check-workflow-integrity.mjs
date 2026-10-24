#!/usr/bin/env node
/**
 * Workflow and bot-configuration integrity gate.
 *
 * 鈹€鈹€ What this checks, and why each one is a real failure mode 鈹€鈹€
 *
 * 1. **The files are readable and structurally anchored.** A workflow with a
 *    syntax error does not fail loudly: GitHub reports no checks at all, and a
 *    branch protection rule that requires a status check then blocks every pull
 *    request — or, worse, on a repository without required checks, applies no gate
 *    while looking healthy.
 *
 *    ── What this gate does and does not do about YAML ──
 *
 *    It does **not** parse the YAML into a document tree, and does not claim to.
 *    There is no YAML parser in this repository's dependency tree: `js-yaml` is
 *    present only as a transitive package and is not resolvable from the project
 *    root, and CONTRIBUTING.md forbids adding a dependency without a reason.
 *
 *    What it does instead is read each file as text, strip comments, and assert
 *    structural anchors: block membership by indentation, key presence, and the
 *    shape of specific values. That is sufficient for every weakening listed
 *    below, and it fails in the safe direction — an unrecognised reformatting makes
 *    an anchor miss, which fails the gate rather than passing it silently.
 *
 *    It is **not** equivalent to schema validation. Acceptance of the syntax is
 *    decided by GitHub's own workflow loader on every run of the workflow, which is
 *    stronger than anything here could be, and a file GitHub refuses to load
 *    produces no checks at all — visible, not silent.
 *
 * 2. **No `continue-on-error` and no `|| true`.** Both turn a failing step into a
 *    green run. They are the two ways this repository's gates could stop gating
 *    without anyone noticing, and neither is ever correct in these workflows.
 *
 * 3. **No job-level `if:` on any job.** Every job must run on every pull request
 *    and every push, including from forks. An `if:` referencing the actor, the fork
 *    status or a previous job's result is how "the release gate is required"
 *    quietly becomes "the release gate is required when convenient".
 *
 * 4. **No job declares `needs:`.** `quality`, `browser` and `publication` are
 *    independent on purpose. A publication job that waits on `quality` stops
 *    publishing-completeness checks from running when the build is red, which is
 *    exactly when a broken tree must still be proven not to contain private
 *    material.
 *
 * 5. **The three documented job names are unchanged.** They are the identifiers in
 *    the branch protection rule. Renaming one silently removes the required check.
 *
 * 6. **Permissions stay minimal.** The workflow-level permissions must be exactly
 *    `contents: read`, and no job may add `write` scope. A workflow that runs on
 *    fork pull requests with a write token is the supply-chain risk this whole
 *    arrangement exists to avoid.
 *
 * 7. **Every third-party action is pinned to a full 40-character commit SHA**, with
 *    a trailing `# vX.Y.Z` comment recording the release. A tag is a mutable
 *    pointer; a SHA is not. The comment is required so the pin can be re-verified
 *    without an API lookup of the SHA alone.
 *
 * 8. **The browser job runs real specs and cannot pass with no tests.** It must
 *    name the specs explicitly (not rely on "everything under e2e/"), must not pass
 *    `--pass-with-no-tests`, and must not set `retries` above 0.
 *
 * 9. **The Dependabot configuration covers both ecosystems.** An npm entry is what
 *    keeps dependencies current; a `github-actions` entry is what keeps the SHA
 *    pins current. Losing either makes the other's maintenance manual again.
 *
 * 10. **This gate is actually wired into CI.** A guard that nothing invokes is a
 *    document. The publication job must run both this gate and its controls, so a
 *    future edit that removes that wiring fails the very run it was meant to
 *    protect.
 *
 * 11. **The scheduled dependency workflow exists and stays honest.** A daily
 *    advisory check is the only thing that catches an advisory published against an
 *    unchanged lockfile. It must exist, keep least privilege, keep a manual
 *    trigger, and call the same gate rather than a second scanner.
 *
 * ── What it deliberately does not do ──
 *
 * It does not reach the network or call the GitHub API. Whether a *pinned SHA* is
 * still the latest release is a question for Dependabot, which is configured to
 * answer it weekly. This gate answers the question that must be true on every
 * commit: that the pin is a pin at all, and that the gate structure has not been
 * weakened.
 *
 * Usage: node tools/check-workflow-integrity.mjs [--json]
 *
 * Exit 0 = the configuration is structurally sound. Exit 1 = it is not.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const JSON_OUTPUT = process.argv.includes("--json");

let failures = 0;
const problems = [];

function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    problems.push({ label, detail });
    console.error(`FAIL  ${label}${detail === "" ? "" : ` 鈥?${detail}`}`);
  }
}

/*
 * ── The structural reader, stated precisely ──
 *
 * The checks below read these files as **text**, not as a parsed document tree.
 * There is no YAML parser available to this project (see item 1 in the header),
 * so the reader is deliberately minimal: split into lines, strip comments, and
 * identify blocks by indentation.
 *
 * What it can therefore assert:
 *
 *   - the job block names and their indentation,
 *   - which lines belong to which job,
 *   - the presence of specific keys at specific indentation levels,
 *   - the exact text of values it cares about (job names, `run:` commands).
 *
 * What it cannot assert: that the document is valid YAML, that anchors and
 * aliases resolve, or that a value has the type GitHub expects. Those are the
 * workflow loader's job, which runs on every push of this file.
 *
 * The trade is explicit: a handful of regexes against a dependency-free reader,
 * with the failure mode biased toward false refusal. A reformatting this reader
 * does not recognise loses its anchors and fails the gate, which is noisy and
 * safe; the alternative failure — passing silently — is the one this whole file
 * exists to prevent.
 */

const WORKFLOW = join(ROOT, ".github", "workflows", "verify.yml");
const DEPENDABOT = join(ROOT, ".github", "dependabot.yml");

if (!existsSync(WORKFLOW)) {
  console.error(`ERROR no workflow at ${WORKFLOW}`);
  process.exit(1);
}

const workflowText = readFileSync(WORKFLOW, "utf8");
const workflowLines = workflowText.split("\n");

/**
 * The workflow with YAML comments removed.
 *
 * 鈹€鈹€ Why every content assertion below reads this and not the raw text 鈹€鈹€
 *
 * This file's own documentation explains *why* `continue-on-error`, `|| true` and
 * `--pass-with-no-tests` are forbidden, so the raw text contains all three. A
 * naive substring check fires on the explanation and the gate fails on its own
 * prose 鈥?the same trap `tests/e2e-privacy-config.test.ts` records for the E2E
 * privacy rules, and the reason `readCode()` exists there.
 *
 * The check that matters is what the *configuration* does, not what the file
 * talks about. Stripping `#` comments (respecting quoted strings, so a `#` inside
 * a value survives) gives exactly that.
 */
function stripYamlComments(text) {
  return text
    .split("\n")
    .map((line) => {
      let inSingle = false;
      let inDouble = false;
      for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === "'" && !inDouble) inSingle = !inSingle;
        else if (character === '"' && !inSingle) inDouble = !inDouble;
        else if (character === "#" && !inSingle && !inDouble) {
          // A `#` only starts a comment at line start or after whitespace.
          if (index === 0 || /\s/.test(line[index - 1])) return line.slice(0, index);
        }
      }
      return line;
    })
    .join("\n");
}

const workflowCode = stripYamlComments(workflowText);
const workflowCodeLines = workflowCode.split("\n");

console.log("workflow integrity\n");

// 鈹€鈹€ 1. basic syntax sanity 鈹€鈹€
/*
 * A tab in indentation is not valid YAML. This is the single most common way a
 * hand-edited workflow breaks, and the failure mode (no checks run at all) is
 * quiet.
 */
check(
  "workflow contains no tab characters in indentation",
  !workflowLines.some((line) => /^\t/.test(line)),
  "YAML forbids tabs for indentation",
);

check("workflow is not empty", workflowText.trim().length > 0);

/** Top-level keys, i.e. unindented `key:` lines. */
const topLevelKeys = workflowLines
  .filter((line) => /^[A-Za-z_"'].*:/.test(line))
  .map((line) => line.slice(0, line.indexOf(":")));

check("workflow declares `jobs`", topLevelKeys.includes("jobs"));
check("workflow declares `on`", topLevelKeys.includes("on"));

// 鈹€鈹€ 2. no failure-suppressing constructs anywhere 鈹€鈹€
check(
  "no `continue-on-error` in the workflow configuration",
  !/continue-on-error/.test(workflowCode),
  "continue-on-error turns a failing gate into a green run",
);
check(
  "no `|| true` in the workflow configuration",
  !/\|\|\s*true\b/.test(workflowCode),
  "`|| true` swallows a non-zero exit and makes the step unfailable",
);
check(
  "no `set +e` in the workflow configuration",
  !/set\s+\+e/.test(workflowCode),
  "disabling errexit inside a gate step defeats the gate",
);
/*
 * The `run:` values are where a suppression would actually be written, so they
 * are read from the comment-stripped text as a set. Asserting on the whole file
 * would also match the prose above; asserting on the commands is the real check.
 */
const runCommands = [...workflowCode.matchAll(/^\s*run:\s*(.+)$/gm)].map((match) => match[1].trim());
check("workflow has at least one run step", runCommands.length > 0, `${runCommands.length} run command(s)`);
check(
  "no run command suppresses a non-zero exit",
  !runCommands.some((command) => /\|\|\s*true\b/.test(command) || /^true\b/.test(command)),
  runCommands.filter((command) => /\|\|\s*true\b/.test(command)).join("; "),
);

// 鈹€鈹€ 3. job structure 鈹€鈹€
/** Slice the lines belonging to the job whose name matches. */
function jobBlock(name) {
  const start = workflowCodeLines.findIndex((line) => new RegExp(`^ {2}${name}:\\s*$`).test(line));
  if (start === -1) return null;
  let end = workflowCodeLines.length;
  for (let index = start + 1; index < workflowCodeLines.length; index += 1) {
    if (/^ {2}[A-Za-z_][\w-]*:\s*$/.test(workflowCodeLines[index])) {
      end = index;
      break;
    }
  }
  return { start, end, lines: workflowCodeLines.slice(start, end) };
}

const EXPECTED_JOBS = [
  { key: "quality", name: "lint, types, tests, build" },
  { key: "browser", name: "browser (synthetic)" },
  { key: "publication", name: "public release gate" },
];

for (const job of EXPECTED_JOBS) {
  const block = jobBlock(job.key);
  check(`job \`${job.key}\` exists`, block !== null);
  if (block === null) continue;

  const declaredName = new RegExp(`^ {4}name:\\s*"?${job.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"?\\s*$`);
  check(
    `job \`${job.key}\` keeps its required-check name "${job.name}"`,
    block.lines.some((line) => declaredName.test(line)),
    "this string is the required status check in branch protection; renaming it removes the check",
  );

  /*
   * A job-level `if:` is the fork-PR bypass. Step-level `if:` would be too, but
   * asserting the job level covers the realistic mistake.
   */
  check(
    `job \`${job.key}\` has no job-level \`if:\``,
    !block.lines.some((line) => /^ {4}if:/.test(line)),
    "a conditional job can be skipped, and a skipped required check is not a passed one",
  );

  check(
    `job \`${job.key}\` declares no \`needs:\``,
    !block.lines.some((line) => /^ {4}needs:/.test(line)),
    "the jobs are independent on purpose: a red build must not suppress the publication gate",
  );
}

// 鈹€鈹€ 4. permissions 鈹€鈹€
const permissionsIndex = workflowCodeLines.findIndex((line) => /^permissions:/.test(line));
check("workflow declares top-level `permissions`", permissionsIndex !== -1);

if (permissionsIndex !== -1) {
  const declared = [];
  for (let index = permissionsIndex + 1; index < workflowCodeLines.length; index += 1) {
    const line = workflowCodeLines[index];
    if (/^\S/.test(line)) break;
    if (/^\s+\S/.test(line)) declared.push(line.trim());
  }
  check(
    "workflow-level permissions are exactly `contents: read`",
    declared.length === 1 && declared[0] === "contents: read",
    `declared: ${declared.join(", ") || "(none)"}`,
  );
}

check(
  "no job escalates to a write permission",
  !/^\s+\S+:\s*write\s*$/m.test(workflowCode),
  "a write token on a workflow that runs on fork PRs is the supply-chain risk this arrangement exists to avoid",
);

// 鈹€鈹€ 5. actions pinned to full commit SHAs 鈹€鈹€
/*
 * Matches `uses: owner/repo@<ref>` and captures the ref plus an optional trailing
 * comment. Local composite actions (`./path`) are exempt: they live in this
 * repository and change with the commit under test.
 *
 * The `uses:` reference is read from the comment-stripped text, so a commented-out
 * step cannot satisfy the check. The `# vX.Y.Z` release note is read from the
 * **raw** line instead, because it is a comment by definition — stripping
 * comments first would make it impossible to require one.
 */
const usesLines = workflowLines
  .map((line, index) => ({ raw: line.trim(), code: (workflowCodeLines[index] ?? "").trim() }))
  .filter((entry) => /^(?:-\s+)?uses:/.test(entry.code));

check("workflow uses at least one external action", usesLines.length > 0);

const unpinned = [];
const missingVersionComment = [];
for (const { raw, code } of usesLines) {
  const match = /uses:\s*(\S+)/.exec(code);
  if (match === null) continue;
  const reference = match[1];
  if (reference.startsWith("./")) continue; // local action, versioned by the commit

  const atIndex = reference.lastIndexOf("@");
  if (atIndex === -1) {
    unpinned.push(`${reference} (no ref)`);
    continue;
  }
  const ref = reference.slice(atIndex + 1);
  if (!/^[0-9a-f]{40}$/.test(ref)) unpinned.push(`${reference} (ref "${ref}" is not a 40-character commit SHA)`);

  // The trailing comment must record the release, or a reader cannot tell what
  // the SHA is without an API call.
  if (!/#\s*v?\d+\.\d+/.test(raw)) missingVersionComment.push(reference);
}

check(
  "every external action is pinned to a full commit SHA",
  unpinned.length === 0,
  unpinned.join("; "),
);
check(
  "every pinned action records its release in a trailing comment",
  missingVersionComment.length === 0,
  missingVersionComment.join("; "),
);

// 鈹€鈹€ 6. the browser job actually runs specs 鈹€鈹€
const browserBlock = jobBlock("browser");
if (browserBlock === null) {
  check("browser job present for spec assertions", false);
} else {
  const browserText = browserBlock.lines.join("\n");

  check(
    "browser job installs Chromium with system dependencies",
    /playwright install\s+--with-deps\s+chromium/.test(browserText),
    "without --with-deps the browser launches and fails on a missing shared library",
  );

  const namedSpecs = ["e2e/flow.spec.ts", "e2e/settings.spec.ts", "e2e/course-companion.spec.ts"];
  for (const spec of namedSpecs) {
    check(`browser job runs ${spec}`, browserText.includes(spec));
  }

  check(
    "browser job cannot pass with zero tests",
    !/--pass-with-no-tests/.test(browserText),
    "--pass-with-no-tests turns a zero-test collection into a green run",
  );

  check(
    "browser job does not retry failures",
    !/--retries[= ]+[1-9]/.test(browserText),
    "a retry converts a flake into a green run and hides the flake",
  );

  check(
    "browser job uploads no artefact",
    !/upload-artifact/.test(browserText),
    "test screenshots and traces must not become published documents without an explicit decision",
  );
}

// 鈹€鈹€ 7. the quality job runs the dependency gates 鈹€鈹€
const qualityBlock = jobBlock("quality");
if (qualityBlock === null) {
  check("quality job present for dependency-gate assertions", false);
} else {
  const qualityText = qualityBlock.lines.join("\n");
  check(
    "quality job runs the dependency security gate",
    qualityText.includes("tools/check-dependency-security.mjs"),
  );
  check(
    "quality job runs the dependency security controls",
    qualityText.includes("tools/dependency-security-controls.mjs"),
  );
  check(
    "dependency gates run before the long test step",
    qualityText.indexOf("check-dependency-security.mjs") < qualityText.indexOf("pnpm test:ci"),
    "a supply-chain failure should surface in the first minute, not after the suite",
  );
}

// 鈹€鈹€ 8. Dependabot configuration 鈹€鈹€
check("Dependabot configuration exists", existsSync(DEPENDABOT));

if (existsSync(DEPENDABOT)) {
  /* Comment-stripped for the same reason as the workflow: the file explains its
   * own choices in prose, and a substring check would match the explanation. */
  const dependabotText = stripYamlComments(readFileSync(DEPENDABOT, "utf8"));

  check(
    "Dependabot config declares version 2",
    /^version:\s*2\s*$/m.test(dependabotText),
  );

  const ecosystems = [...dependabotText.matchAll(/package-ecosystem:\s*"?([\w-]+)"?/g)].map((match) => match[1]);
  check("Dependabot covers the npm ecosystem", ecosystems.includes("npm"));
  check("Dependabot covers the github-actions ecosystem", ecosystems.includes("github-actions"));

  check(
    "Dependabot sets an open-pull-requests-limit for every ecosystem",
    (dependabotText.match(/open-pull-requests-limit:/g) ?? []).length === ecosystems.length,
    `without a limit the bot can open more pull requests than anyone will read (${ecosystems.length} ecosystem(s))`,
  );

  /*
   * An `ignore:` entry suppresses security updates as well as version updates, so
   * a transitive advisory with no fix must be recorded in SECURITY.md instead of
   * hidden here. This asserts the file contains no `ignore:` block at all, which
   * is a stronger and simpler rule than reviewing each entry.
   */
  check(
    "Dependabot config contains no `ignore:` block",
    !/^\s*ignore:\s*$/m.test(dependabotText),
    "ignore: also suppresses security updates; record scoped exceptions in SECURITY.md instead",
  );

  check(
    "Dependabot groups security updates explicitly",
    /applies-to:\s*security-updates/.test(dependabotText),
    "grouping security updates keeps a multi-package advisory as one reviewable fix",
  );
}
// ── 9. this gate is wired into CI, and so are its controls ──
/*
 * ── Why a gate checks its own wiring ──
 *
 * The first version of this file was written, reviewed, and never invoked by any
 * workflow. It passed locally and in `pnpm verify`, and it guarded nothing on a
 * pull request — which is the exact defect its own header describes, committed by
 * the file that describes it.
 *
 * That is not an argument for trusting the author more carefully next time. It is
 * an argument that "the gate runs in CI" has to be an assertion, not a memory. So
 * the publication job must invoke this gate and its controls, and removing either
 * line fails the run it was meant to protect.
 *
 * The publication job is the right home: it is the job that cannot be skipped, so
 * a browser or build failure cannot suppress the check on the CI configuration.
 */
const publicationBlock = jobBlock("publication");
if (publicationBlock === null) {
  check("publication job present for CI-configuration assertions", false);
} else {
  const publicationText = publicationBlock.lines.join("\n");
  check(
    "publication job runs the workflow integrity gate",
    publicationText.includes("tools/check-workflow-integrity.mjs"),
    "a gate nothing invokes is a document, not a control",
  );
  check(
    "publication job runs the workflow integrity controls",
    publicationText.includes("tools/workflow-integrity-controls.mjs"),
    "the gate's own ability to fail must be exercised on every pull request too",
  );
  check(
    "publication job still runs every pre-existing release gate",
    [
      "tools/public-release-check.mjs",
      "tools/audit-history.mjs",
      "tools/audit-object-database.mjs",
      "tools/check-exam-fingerprints.mjs",
      "tools/check-doc-references.mjs",
      "tools/gate-negative-controls.mjs",
      "tools/secret-scan-controls.mjs",
      "tools/workspace-path-controls.mjs",
      "tools/license-check-controls.mjs",
      "tools/guard-token-scanner.mjs",
      "tools/guard-source-doc-refs.mjs",
      "tools/guard-role-references.mjs",
      "tools/check-release-archive.mjs",
    ].every((tool) => publicationText.includes(tool)),
    "the history, privacy, object, secret and artefact gates must all survive",
  );
}

// ── 10. the scheduled dependency workflow ──
/*
 * ── Why a second workflow file is checked here rather than trusted ──
 *
 * The scheduled audit is the only mechanism that catches an advisory published
 * against an unchanged lockfile — the case where no commit happens to trigger the
 * pull-request gate. Three `undici` advisories appeared that way during this
 * project. A daily run is therefore load-bearing, and a load-bearing workflow
 * needs the same treatment as the required ones.
 *
 * What is asserted here is the configuration only. Whether the schedule actually
 * fires cannot be checked from a pull request: GitHub ignores `schedule` triggers
 * on non-default branches, runs can be delayed, and scheduled workflows are
 * disabled automatically on inactive public repositories. The first real
 * scheduled or manual run can only be accepted after this merges.
 */
const SCHEDULED = join(ROOT, ".github", "workflows", "dependency-security.yml");
check("scheduled dependency workflow exists", existsSync(SCHEDULED));

if (existsSync(SCHEDULED)) {
  const scheduledRaw = readFileSync(SCHEDULED, "utf8");
  const scheduledCode = stripYamlComments(scheduledRaw);

  check(
    "scheduled workflow declares a cron schedule",
    /^\s*-\s*cron:\s*["']?\S+/m.test(scheduledCode),
    "without a cron entry the workflow would only ever run manually",
  );
  check(
    "scheduled workflow supports manual dispatch",
    /^ {2}workflow_dispatch:\s*$/m.test(scheduledCode),
    "a manual trigger is the fallback when the schedule is delayed or disabled",
  );
  check(
    "scheduled workflow keeps least privilege",
    /^permissions:\s*\n\s+contents:\s*read\s*$/m.test(scheduledCode) && !/^\s+\S+:\s*write\s*$/m.test(scheduledCode),
    "the scheduled job must stay read-only",
  );
  check(
    "scheduled workflow calls the same dependency gate, not a second scanner",
    scheduledCode.includes("tools/check-dependency-security.mjs"),
    "two implementations of the same check can disagree; there must be one",
  );
  check(
    "scheduled workflow also runs the gate's controls",
    scheduledCode.includes("tools/dependency-security-controls.mjs"),
    "a nightly PASS is only meaningful if the gate can still fail",
  );
  check(
    "scheduled workflow does not retry Chromium or the full release flow",
    !/playwright/i.test(scheduledCode) && !/check-release-archive|public-release-check|audit-history/.test(scheduledCode),
    "a daily run must stay cheap; Chromium and the publication gates belong to verify.yml",
  );
  check(
    "scheduled workflow does not open or merge pull requests",
    !/(pulls|merge|approve|gh pr create)/i.test(scheduledCode),
    "this workflow reports; deciding what to do with a finding is a human action",
  );
  check(
    "scheduled workflow uses no secret",
    !/\$\{\{\s*secrets\./.test(scheduledRaw),
    "no secret is needed to query a public advisory index",
  );
  check(
    "scheduled workflow pins its actions to full commit SHAs",
    (() => {
      const refs = [...scheduledCode.matchAll(/uses:\s*(\S+)/g)]
        .map((match) => match[1])
        .filter((reference) => !reference.startsWith("./"));
      return refs.length > 0 && refs.every((reference) => /@[0-9a-f]{40}$/.test(reference));
    })(),
    "an unpinned action in a scheduled workflow is the same supply-chain risk as anywhere else",
  );
  check(
    "scheduled workflow does not suppress failures",
    !/continue-on-error|\|\|\s*true\b/.test(scheduledCode),
    "a scheduled scan that cannot fail is a nightly no-op",
  );
}

console.log("");if (JSON_OUTPUT) {
  console.log(JSON.stringify({ failures, problems }, null, 2));
}
if (failures > 0) {
  console.error(`workflow integrity: ${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("workflow integrity: PASS 鈥?gate structure, pins and bot configuration are sound");
