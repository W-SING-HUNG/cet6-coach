/**
 * Negative controls for the **licence clause** of `public-release-check.mjs`.
 *
 * ── Why this file exists, and why the direction inverted ──
 *
 * The gate used to assert that **no** licence had been granted. It now asserts
 * that a genuine MIT licence is present and that every document agrees. Both
 * directions can fail silently in the same way: a check that only ever reports
 * "pass" has not been shown to check anything.
 *
 * Each control below plants a wrong state in a throwaway full-tree copy and
 * requires the real gate to REFUSE it. The baseline control proves the copy is
 * accepted when unmodified — without it, the rest would prove nothing.
 *
 * ── What "wrong" means, and why each case is separate ──
 *
 *   - licence **deleted**             → a clone would receive no grant
 *   - licence **tampered** (body)     → an MIT heading over a different grant
 *   - licence **widened** (copyleft)  → contradictory terms appended
 *   - **holder** blank                → rights that cannot be attributed
 *   - **SPDX conflict**               → package.json disagrees with LICENSE
 *   - **README stale**                → still says "not yet decided"
 *   - **CONTRIBUTING stale**          → contributor told the opposite
 *   - **inbound = outbound missing**  → contributor cannot know what they grant
 *   - **third-party carve-out gone**  → MIT appears to cover dependencies
 *   - **study-content carve-out gone**→ MIT appears to cover exam papers
 *
 * Usage: node tools/license-check-controls.mjs
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const GATE = join(ROOT, "tools", "public-release-check.mjs");

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
 * Build a throwaway copy of the whole tree and let the caller break it.
 *
 * Full tree, not a licence-only subset: the other ten checks read `tools/`, the
 * source and the notice files, so a partial tree would make the baseline control
 * fail for reasons unrelated to the licence clause.
 */
function makeTree(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "licence-ctl-"));
  cpSync(ROOT, dir, {
    recursive: true,
    filter: (source) => {
      const rel = source.slice(ROOT.length).replace(/\\/g, "/");
      return !/^\/(node_modules|\.git|\.next|\.e2e|data)(\/|$)/.test(rel);
    },
  });
  mutate(dir);

  const configRoot = mkdtempSync(join(tmpdir(), "licence-gitcfg-"));
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(configRoot, "global"),
    GIT_CONFIG_SYSTEM: join(configRoot, "system"),
    GIT_CONFIG_NOSYSTEM: "1",
  };
  writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "", "utf8");
  writeFileSync(gitEnv.GIT_CONFIG_SYSTEM, "", "utf8");

  const git = (...args) =>
    execFileSync("git", args, {
      cwd: dir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...gitEnv,
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

function edit(dir, file, transform) {
  const absolute = join(dir, file);
  writeFileSync(absolute, transform(readFileSync(absolute, "utf8")), "utf8");
}

/** Run one mutation, assert the gate refuses, and clean up. */
function expectRefusal(label, mutate, matcher) {
  const dir = makeTree(mutate);
  const { ok, out } = runGate(dir);
  const refused = !ok && matcher.test(out);
  check(label, refused, out.slice(-420));
  rmSync(dir, { recursive: true, force: true });
}

// ── control 0: the unmodified MIT tree PASSES ──
{
  const dir = makeTree(() => {});
  const { ok, out } = runGate(dir);
  check("baseline: an unmodified MIT tree passes", ok, out.slice(-400));
  rmSync(dir, { recursive: true, force: true });
}

// ── control 1: LICENSE deleted while every document still claims MIT ──
expectRefusal(
  "gate REFUSES a tree whose LICENSE was deleted",
  (d) => rmSync(join(d, "LICENSE")),
  /missing licence text|missing licence text:/,
);

// ── control 2: an MIT heading over a different grant ──
expectRefusal(
  "gate REFUSES an MIT heading with a non-MIT body",
  (d) =>
    edit(d, "LICENSE", () =>
      "MIT License\n\nCopyright (c) 2026 W-SING-HUNG\n\n" +
      "You may use this software for personal, noncommercial study only.\n" +
      "Redistribution and modification are prohibited.\n",
    ),
  /not the MIT text/,
);

// ── control 3: MIT plus an appended copyleft term ──
expectRefusal(
  "gate REFUSES MIT with copyleft terms appended",
  (d) =>
    edit(d, "LICENSE", (t) => t + "\nThis software is also subject to the GNU General Public License.\n"),
  /copyleft or noncommercial terms/,
);

// ── control 4: blank copyright holder ──
expectRefusal(
  "gate REFUSES a blank copyright holder line",
  (d) => edit(d, "LICENSE", (t) => t.replace(/Copyright \(c\) 2026 W-SING-HUNG/, "Copyright (c)")),
  /no copyright holder line|placeholder rather than a named holder/,
);

// ── control 5: package.json SPDX disagrees ──
expectRefusal(
  "gate REFUSES a package.json SPDX field that contradicts LICENSE",
  (d) =>
    edit(d, "package.json", (t) => {
      const pkg = JSON.parse(t);
      pkg.license = "ISC";
      return JSON.stringify(pkg, null, 2) + "\n";
    }),
  /license field is "ISC"/,
);

// ── control 6: README still says the licence is undecided ──
expectRefusal(
  "gate REFUSES a README that still says the licence is undecided",
  (d) =>
    edit(d, "README.md", (t) =>
      t.replace(/## Licensing[\s\S]*?(?=\n## )/, "## Licensing\n\n> **Status: no open-source licence has been granted yet.**\nThe licence is not yet decided.\n\n"),
    ),
  /still describes the licence as undecided|does not name the licence/,
);

// ── control 7: CONTRIBUTING still says the licence is undecided ──
expectRefusal(
  "gate REFUSES a CONTRIBUTING that still says the licence is undecided",
  (d) =>
    edit(d, "CONTRIBUTING.md", (t) =>
      t.replace(/## Content and licensing[\s\S]*?(?=\n## )/, "## Content and licensing\n\n**The project's outbound licence is not yet decided.**\n\n"),
    ),
  /still describes the licence as undecided/,
);

// ── control 8: CONTRIBUTING omits inbound = outbound ──
expectRefusal(
  "gate REFUSES a CONTRIBUTING that never states inbound = outbound",
  (d) =>
    edit(d, "CONTRIBUTING.md", (t) =>
      t
        .replace(/\*\*Inbound = outbound\.\*\*/g, "**Contributions.**")
        .replace(/By opening a pull request you agree[\s\S]*?MIT License\./i, "Contributions are welcome."),
    ),
  /does not state that contributions are distributed under the project licence/,
);

// ── control 9: third-party carve-out removed from the notices ──
expectRefusal(
  "gate REFUSES notices that stop carving out third-party dependencies",
  (d) => edit(d, "THIRD-PARTY-NOTICES.md", () => "# Third-Party Notices\n\nSee package.json.\n"),
  /does not record the dependency licence inventory|does not state that the project licence does not relicense/,
);

// ── control 10: study-content carve-out removed from the README ──
expectRefusal(
  "gate REFUSES a README that stops carving out exam papers and course material",
  (d) =>
    edit(d, "README.md", (t) =>
      t.replace(
        /### What this licence does not cover[\s\S]*?(?=Read \[`CONTRIBUTING\.md`)/,
        "### Scope\n\nMIT applies to everything in this repository.\n\n",
      ),
    ),
  /does not carve exam papers/,
);

console.log("");
if (failures > 0) {
  console.error(`licence check controls: ${failures} FAILED`);
  process.exit(1);
}
console.log("licence check controls: PASS — the gate rejects every wrong licence state");
