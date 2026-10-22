/**
 * Regression guard: documentation citations inside source code.
 *
 * `check-doc-references.mjs` scans source comments for `docs/*.md` citations.
 * This probe proves the rule *fires*, using a synthetic repository so it never
 * touches the real tree.
 *
 * ── What it plants ──
 *
 * 1. a source comment citing a document that does not exist (dangling);
 * 2. a source comment citing a document the release gate withholds;
 * 3. a legitimate citation of a document that does exist.
 *
 * ── Why no withheld name appears in this file ──
 *
 * An earlier draft wrote one out in this header. That made the probe a third copy
 * of a name that must not be published �?and the doc-reference checker, correctly,
 * then flagged the probe itself. The name is now *read* from the gate's forbidden
 * table at runtime, so the single source of truth stays single.
 *
 * The synthetic fixtures below are assembled at runtime (see `fixtureDoc`) and
 * the resulting basenames are listed in the checker's `SYNTHETIC_DOC_SEGMENTS`,
 * which is how a fixture path is distinguished from a citation.
 *
 * Usage: node tools/guard-source-doc-refs.mjs
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createTempDir } from "./temp-workspace.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok    ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` �?${detail}` : ""}`);
  }
}

/**
 * Pull a withheld `docs/*.md` name out of the gate's forbidden table.
 *
 * Reading it rather than writing it keeps this probe from being the third copy of
 * a name that must not be published.
 *
 * The gate writes this entry as an alternation:
 *
 *     /^docs\/(name-a|name-b|�?\.md$/
 *
 * so the extraction pulls the first alternative and unescapes the `\.` that the
 * regex needs but a filename does not.
 */
function withheldDocName() {
  const gateSource = readFileSync(join(ROOT, "tools", "public-release-check.mjs"), "utf8");
  const tableMatch = /const FORBIDDEN_PATHS = \[([\s\S]*?)\n\];/.exec(gateSource);
  if (tableMatch === null) return null;

  // Matches `/^docs\/(a|b|c)\.md$/` and captures the alternation.
  const match = /\/\^docs\\\/\(([^)]+)\)\\\.md\$\//.exec(tableMatch[1]);
  if (match === null) return null;

  const first = match[1].split("|")[0].trim();
  return `docs/${first}.md`;
}

const WITHHELD = withheldDocName();
if (WITHHELD === null) {
  console.error("could not read a withheld doc name from the gate's forbidden table");
  process.exit(2);
}

/**
 * Fixture paths are assembled at runtime, not written literally.
 *
 * If this file contained the fixture paths as literals, the doc-reference checker
 * would scan *this* file and correctly report citations �?the probe would be
 * accusing itself. The assembly below keeps the probe free of real citations
 * while still producing them inside the temporary tree it builds.
 *
 * The same technique is used for the token probes, and for the same reason: a
 * scanner and its fixtures cannot share a namespace without one flagging the
 * other.
 */
const DOCS = "docs";
const fixtureDoc = (name) => `${DOCS}/${name}`;
// Built from parts so no `docs/*.md` substring appears in this source file.
const PRESENT_DOC = fixtureDoc(`${"pre"}${"sent"}.md`);
const ABSENT_DOC = fixtureDoc(`${"ab"}${"sent"}.md`);
const EXAMPLE_DOC = fixtureDoc(`${"exam"}${"ple"}.md`);

/** Build a synthetic repo the checker can run inside. */
function makeTree(sourceComment) {
  const scratch = createTempDir("n3-").path;
  execFileSync("git", ["init", "-q"], { cwd: scratch, stdio: "ignore" });

  mkdirSync(join(scratch, "tools"), { recursive: true });
  copyFileSync(
    join(ROOT, "tools", "check-doc-references.mjs"),
    join(scratch, "tools", "check-doc-references.mjs"),
  );
  copyFileSync(
    join(ROOT, "tools", "public-release-check.mjs"),
    join(scratch, "tools", "public-release-check.mjs"),
  );

  writeFileSync(join(scratch, "package.json"), '{"name":"n3","private":true}', "utf8");
  writeFileSync(join(scratch, "README.md"), "# n3\n", "utf8");
  mkdirSync(join(scratch, "docs"), { recursive: true });
  // Write the same file the PRESENT_DOC literal names.
  writeFileSync(join(scratch, ...PRESENT_DOC.split("/")), "# present\n", "utf8");
  mkdirSync(join(scratch, "src"), { recursive: true });
  writeFileSync(join(scratch, "src", "mod.ts"), `export const x = 1;\n${sourceComment}\n`, "utf8");

  execFileSync("git", ["add", "-A"], { cwd: scratch, stdio: "ignore" });
  return scratch;
}

function runChecker(scratch) {
  try {
    execFileSync(process.execPath, [join(scratch, "tools", "check-doc-references.mjs")], {
      cwd: scratch,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return 0;
  } catch (error) {
    return error.status ?? 1;
  }
}

console.log("source documentation references\n");

// ── baseline: a legitimate citation must pass ──
{
  const scratch = makeTree(`// see \`${PRESENT_DOC}\` for the contract`);
  check("baseline: a real citation resolves", runChecker(scratch) === 0);
  rmSync(scratch, { recursive: true, force: true });
}

// ── control A: dangling citation must be rejected ──
{
  const scratch = makeTree(`// see \`${ABSENT_DOC}\` for the contract`);
  check("A. dangling source citation is REJECTED", runChecker(scratch) !== 0);
  rmSync(scratch, { recursive: true, force: true });
}

// ── control B: citation of a withheld document must be rejected ──
{
  const scratch = makeTree(`// see \`${WITHHELD}\` for the boundary`);
  check(
    /*
     * The withheld name is deliberately NOT printed.
     *
     * The probe reads it from the gate at runtime precisely so it is never
     * written down; echoing it in the result line would undo that and put the
     * name into every CI log. The category is what a reader needs.
     */
    "B. citation of a withheld document is REJECTED",
    runChecker(scratch) !== 0,
  );
  rmSync(scratch, { recursive: true, force: true });
}

// ── control C: an illustrative example in a comment is not a citation ──
//
// The checker carries a short allowlist of obviously synthetic names so that
// documentation examples and negative-control fixtures are not reported as
// citations. This control proves that allowlist works, and control A proves it is
// narrow enough that a real dangling citation still fails.
{
  const scratch = makeTree(`// a link looks like \`${EXAMPLE_DOC}\` in prose`);
  check("C. synthetic example name is not treated as a citation", runChecker(scratch) === 0);
  rmSync(scratch, { recursive: true, force: true });
}

// ── control D: the real tree must still pass ──
{
  check(
    "D. the actual repository passes",
    (() => {
      try {
        execFileSync(process.execPath, [join(ROOT, "tools", "check-doc-references.mjs")], {
          cwd: ROOT,
          stdio: ["ignore", "pipe", "pipe"],
        });
        return true;
      } catch {
        return false;
      }
    })(),
  );
}

console.log("");
if (failures > 0) {
  console.error(`${failures} probe(s) FAILED`);
  process.exit(1);
}
console.log("source references: enforced");
