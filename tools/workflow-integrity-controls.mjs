#!/usr/bin/env node
/**
 * Controls for `tools/check-workflow-integrity.mjs`.
 *
 * ── Why this file exists ──
 *
 * The workflow gate asserts things a reviewer would otherwise have to hold in
 * their head: that both required-check names still exist, that nothing suppresses
 * a failure, that every action is SHA-pinned, that the publication job cannot be
 * skipped. Every one of those is a property that can be *removed* in a one-line
 * edit and would leave a green CI run that no longer means what it says.
 *
 * A guard for that class of property is only worth having if it demonstrably
 * refuses each weakening. So each control below copies the real configuration into
 * a throwaway tree, applies exactly one regression, and requires the gate to fail
 * for the right reason.
 *
 * ── The regression each control applies ──
 *
 *   0. baseline                     unchanged copy passes (without this, 1–8 prove nothing)
 *   1. required-check name changed   the branch-protection identifier is gone
 *   2. `continue-on-error` added     a failing gate becomes a green run
 *   3. `|| true` appended            a non-zero exit is swallowed
 *   4. action pinned to a tag        the tag can be repointed at unreviewed code
 *   5. `needs: quality` added        a red build suppresses the publication gate
 *   6. job-level `if:` added         a fork PR can skip the gate
 *   7. permissions widened          a fork PR gets a write-capable token
 *   8. `--pass-with-no-tests` added  a zero-test collection reports green
 *
 * Usage: node tools/workflow-integrity-controls.mjs
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { withTempDir } from "./temp-workspace.mjs";

const ROOT = process.cwd();
const GATE = join(ROOT, "tools", "check-workflow-integrity.mjs");
const WORKFLOW_REL = join(".github", "workflows", "verify.yml");
const DEPENDABOT_REL = join(".github", "dependabot.yml");
const SCHEDULED_REL = join(".github", "workflows", "dependency-security.yml");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok    ${label}`);
  } else {
    failures += 1;
    console.error(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

const ORIGINAL = readFileSync(join(ROOT, WORKFLOW_REL), "utf8");
const DEPENDABOT = readFileSync(join(ROOT, DEPENDABOT_REL), "utf8");
const SCHEDULED = readFileSync(join(ROOT, SCHEDULED_REL), "utf8");

/**
 * Build a throwaway tree containing what the gate reads, and run the gate inside it.
 *
 * The directory is removed when `withTempDir`'s callback returns, so the gate has to
 * run *before* that — a detail the dependency-security controls got wrong on the
 * first attempt (the gate then reported "no lockfile"), which is why the run and the
 * fixture live in one function rather than being separated.
 */
function gateOn(mutate) {
  return withTempDir("wfctl-", (path) => {
    mkdirSync(join(path, ".github", "workflows"), { recursive: true });
    writeFileSync(join(path, WORKFLOW_REL), ORIGINAL, "utf8");
    writeFileSync(join(path, DEPENDABOT_REL), DEPENDABOT, "utf8");
    writeFileSync(join(path, SCHEDULED_REL), SCHEDULED, "utf8");
    mutate(join(path, WORKFLOW_REL), join(path, DEPENDABOT_REL), join(path, SCHEDULED_REL));

    try {
      const stdout = execFileSync(process.execPath, [GATE], {
        cwd: path,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      return { ok: true, out: stdout };
    } catch (error) {
      return { ok: false, out: String(error.stdout ?? "") + String(error.stderr ?? "") };
    }
  });
}

/** Apply a text transform to the workflow inside the fixture. */
const editWorkflow = (transform) => (workflowPath) => {
  writeFileSync(workflowPath, transform(readFileSync(workflowPath, "utf8")), "utf8");
};

/** Require that the gate refuses, and that its message names `matcher`. */
function expectRefusal(label, mutate, matcher) {
  const { ok, out } = gateOn(mutate);
  const refused = !ok && matcher.test(out);
  check(label, refused, out.split("\n").filter((line) => line.startsWith("FAIL")).join(" | ").slice(0, 300));
}

console.log("workflow integrity — controls\n");

// ── control 0: the unmodified configuration passes ──
{
  const { ok, out } = gateOn(() => {});
  check("baseline: the real configuration PASSES", ok, out.slice(-400));
}

// ── control 1: a required-check name changed ──
expectRefusal(
  "gate REFUSES a renamed required-check job",
  editWorkflow((text) => text.replace("    name: public release gate", "    name: publication")),
  /keeps its required-check name "public release gate"/,
);

// ── control 2: continue-on-error added to a step ──
expectRefusal(
  "gate REFUSES a step that tolerates its own failure",
  editWorkflow((text) => text.replace("      - name: Lint\n        run: pnpm lint", "      - name: Lint\n        continue-on-error: true\n        run: pnpm lint")),
  /continue-on-error/,
);

// ── control 3: `|| true` appended to a gate command ──
expectRefusal(
  "gate REFUSES a command that swallows a non-zero exit",
  editWorkflow((text) => text.replace("run: node tools/audit-object-database.mjs", "run: node tools/audit-object-database.mjs || true")),
  /\|\| true/,
);

// ── control 4: an action pinned back to a mutable tag ──
expectRefusal(
  "gate REFUSES an action pinned to a tag instead of a commit SHA",
  editWorkflow((text) => text.replace("@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1", "@v7")),
  /not a 40-character commit SHA/,
);

// ── control 5: publication gated on quality ──
expectRefusal(
  "gate REFUSES a publication job that waits on the build",
  editWorkflow((text) => text.replace("    name: public release gate\n    runs-on: ubuntu-latest", "    name: public release gate\n    needs: quality\n    runs-on: ubuntu-latest")),
  /declares no `needs:`/,
);

// ── control 6: a job-level `if:` that a fork PR fails ──
expectRefusal(
  "gate REFUSES a job that a fork pull request can skip",
  editWorkflow((text) =>
    text.replace(
      "    name: public release gate\n    runs-on: ubuntu-latest",
      "    name: public release gate\n    if: github.event.pull_request.head.repo.full_name == github.repository\n    runs-on: ubuntu-latest",
    ),
  ),
  /no job-level `if:`/,
);

// ── control 7: widened permissions ──
expectRefusal(
  "gate REFUSES a write-capable permission on a fork-PR workflow",
  editWorkflow((text) => text.replace("    name: lint, types, tests, build\n    runs-on: ubuntu-latest", "    name: lint, types, tests, build\n    permissions:\n      contents: write\n    runs-on: ubuntu-latest")),
  /write permission/,
);

// ── control 8: the browser job allowed to collect nothing ──
expectRefusal(
  "gate REFUSES a browser job that can pass with zero tests",
  editWorkflow((text) => text.replace("          --retries=0", "          --retries=0\n          --pass-with-no-tests")),
  /pass with zero tests/,
);

// ── control 9: a dependency gate removed from the quality job ──
expectRefusal(
  "gate REFUSES removal of the dependency security gate",
  editWorkflow((text) => text.replace("        run: node tools/check-dependency-security.mjs", "        run: echo skipped")),
  /runs the dependency security gate/,
);

// ── control 10: Dependabot loses its action coverage ──
expectRefusal(
  "gate REFUSES a Dependabot config that stops maintaining the action pins",
  (_workflowPath, dependabotPath) => {
    const text = readFileSync(dependabotPath, "utf8");
    // Remove the entire github-actions entry, from its comment header to EOF.
    writeFileSync(dependabotPath, text.slice(0, text.indexOf("  # ── GitHub Actions ──")), "utf8");
  },
  /github-actions ecosystem/,
);

// ── control 11: an `ignore:` entry reintroduced ──
expectRefusal(
  "gate REFUSES a Dependabot `ignore:` entry (it would also suppress security updates)",
  (_workflowPath, dependabotPath) => {
    const text = readFileSync(dependabotPath, "utf8");
    writeFileSync(dependabotPath, text.replace("    open-pull-requests-limit: 5", "    open-pull-requests-limit: 5\n    ignore:\n      - dependency-name: \"braces\""), "utf8");
  },
  /no `ignore:` block/,
);
// ── control 12: the gate is unwired from CI ──
/*
 * The defect this control exists for actually happened in this project: the gate
 * was written, reviewed and passing locally, while no workflow invoked it. It
 * guarded nothing on a pull request until someone noticed.
 *
 * So the wiring is asserted, and this control proves the assertion can fail.
 */
expectRefusal(
  "gate REFUSES a CI configuration that stops running the workflow integrity gate",
  editWorkflow((text) => text.replace("        run: node tools/check-workflow-integrity.mjs", "        run: echo removed")),
  /runs the workflow integrity gate/,
);

// ── control 13: the gate's own controls are unwired ──
expectRefusal(
  "gate REFUSES a CI configuration that stops running the integrity controls",
  editWorkflow((text) => text.replace("        run: node tools/workflow-integrity-controls.mjs", "        run: echo removed")),
  /runs the workflow integrity controls/,
);

// ── control 14: a pre-existing release gate deleted ──
/*
 * The publication job accumulated thirteen checks over several review rounds, and
 * each one exists because something was once allowed through. Deleting any of
 * them is the failure mode those rounds were about, so the gate asserts their
 * presence and this control takes one away.
 */
expectRefusal(
  "gate REFUSES removal of a pre-existing release gate (Git object audit)",
  editWorkflow((text) =>
    text.replace("      - name: Git object database audit\n        # Walks every object, including unreachable ones, and rejects a stored\n        # machine-account path, an internal record name or a non-neutral identity.\n        run: node tools/audit-object-database.mjs\n", ""),
  ),
  /still runs every pre-existing release gate/,
);

// ── control 15: the scheduled workflow deleted ──
expectRefusal(
  "gate REFUSES a missing scheduled dependency workflow",
  (_workflowPath, _dependabotPath, scheduledPath) => rmSync(scheduledPath, { force: true }),
  /scheduled dependency workflow exists/,
);

// ── control 16: the schedule itself removed ──
expectRefusal(
  "gate REFUSES a scheduled workflow with no cron trigger",
  (_workflowPath, _dependabotPath, scheduledPath) => {
    const text = readFileSync(scheduledPath, "utf8");
    writeFileSync(scheduledPath, text.replace(/  schedule:\n(?:.*\n)*?  workflow_dispatch:/, "  workflow_dispatch:"), "utf8");
  },
  /cron schedule/,
);

// ── control 17: the manual trigger removed ──
expectRefusal(
  "gate REFUSES a scheduled workflow with no manual trigger",
  (_workflowPath, _dependabotPath, scheduledPath) => {
    const text = readFileSync(scheduledPath, "utf8");
    writeFileSync(scheduledPath, text.replace("  workflow_dispatch:\n", ""), "utf8");
  },
  /manual dispatch/,
);

// ── control 18: the scheduled job escalates to a write scope ──
expectRefusal(
  "gate REFUSES a scheduled workflow with write permissions",
  (_workflowPath, _dependabotPath, scheduledPath) => {
    const text = readFileSync(scheduledPath, "utf8");
    writeFileSync(scheduledPath, text.replace("  contents: read", "  contents: write"), "utf8");
  },
  /least privilege/,
);

// ── control 19: a second scanner implementation appears ──
expectRefusal(
  "gate REFUSES a scheduled workflow that stops calling the shared gate",
  (_workflowPath, _dependabotPath, scheduledPath) => {
    const text = readFileSync(scheduledPath, "utf8");
    writeFileSync(scheduledPath, text.replace("run: node tools/check-dependency-security.mjs", "run: pnpm audit"), "utf8");
  },
  /same dependency gate/,
);

// ── control 20: the scheduled scan allowed to fail quietly ──
expectRefusal(
  "gate REFUSES a scheduled scan that suppresses its own failure",
  (_workflowPath, _dependabotPath, scheduledPath) => {
    const text = readFileSync(scheduledPath, "utf8");
    writeFileSync(scheduledPath, text.replace("run: node tools/check-dependency-security.mjs", "run: node tools/check-dependency-security.mjs || true"), "utf8");
  },
  /does not suppress failures/,
);

// ── control 21: the daily run bloated into the full browser flow ──
expectRefusal(
  "gate REFUSES a scheduled run that also boots Chromium",
  (_workflowPath, _dependabotPath, scheduledPath) => {
    const text = readFileSync(scheduledPath, "utf8");
    writeFileSync(scheduledPath, text.replace("      - name: Dependency security controls", "      - name: Playwright\n        run: pnpm exec playwright test\n\n      - name: Dependency security controls"), "utf8");
  },
  /does not retry Chromium|Chromium/,
);

// ── control 22: the scheduled workflow gains permission to open PRs ──
expectRefusal(
  "gate REFUSES a scheduled workflow that would open pull requests",
  (_workflowPath, _dependabotPath, scheduledPath) => {
    const text = readFileSync(scheduledPath, "utf8");
    writeFileSync(scheduledPath, text.replace("      - name: Dependency security controls", "      - name: Open a fix\n        run: gh pr create --fill\n\n      - name: Dependency security controls"), "utf8");
  },
  /does not open or merge pull requests/,
);

console.log("");if (failures > 0) {
  console.error(`workflow integrity controls: ${failures} FAILED`);
  process.exit(1);
}
console.log("workflow integrity controls: PASS — every weakening the gate claims to catch is refused");
