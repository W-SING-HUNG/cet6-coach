/**
 * Report the actual token counts each allowance file needs.
 *
 * ── Why this exists ──
 *
 * A ceiling set by guesswork fails one of two ways: too low and the gate breaks
 * immediately, too high and the file has unlimited headroom, which defeats the
 * purpose of having a ceiling. The only defensible value is the measured one.
 *
 * ── Why it imports the patterns instead of copying them ──
 *
 * The first draft duplicated the gate's pattern table. That is the exact
 * two-sources-of-truth drift that caused the original extension-list bypass: two
 * lists, maintained separately, diverge silently and the check keeps reporting
 * PASS. This tool therefore reads the pattern table **out of the gate's source**,
 * so it can only ever report the number the gate will enforce.
 *
 * Usage: node tools/count-allowance-tokens.mjs
 */

import { readFileSync } from "node:fs";
import { findTokensOutsideComments } from "./structural-scan.mjs";

/**
 * Extract the pattern table from the gate by evaluating that one declaration.
 *
 * Reading the source and `eval`-ing a narrow slice is unusual, but the
 * alternative — exporting the table and importing it — would mean the gate and
 * this tool share a module, and a change made for one would silently change the
 * other's meaning. Extracting at runtime keeps the gate authoritative.
 */
const gateSource = readFileSync("tools/public-release-check.mjs", "utf8");
const tableMatch = /const INTERNAL_PROCESS_PATTERNS = \[([\s\S]*?)\n\];/.exec(gateSource);
if (tableMatch === null) {
  console.error("could not locate INTERNAL_PROCESS_PATTERNS in the gate");
  process.exit(2);
}

const PATTERNS = eval(`[${tableMatch[1].replace(/\/\*[\s\S]*?\*\//g, "")}]`);

if (!Array.isArray(PATTERNS) || PATTERNS.length === 0) {
  console.error("pattern table round-trip failed");
  process.exit(2);
}
console.log(`patterns read from the gate: ${PATTERNS.length}\n`);

const FILES = [
  "tools/public-release-check.mjs",
  "tools/audit-history.mjs",
  "tools/gate-negative-controls.mjs",
  "tools/structural-scan.mjs",
  "tools/guard-token-scanner.mjs",
  "tools/guard-build-boundary.mjs",
  "tools/audit-object-database.mjs",
  "CONTRIBUTING.md",
];

/*
 * The pattern table was read from the gate at the top of this file, so there is
 * no second list to drift. The old duplicate is gone; a mismatch is now
 * impossible by construction rather than detected after the fact.
 */

let total = 0;
console.log("file".padEnd(42), "non-regexp", " regexp", " where");
for (const file of FILES) {
  let source;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    console.log(`${file.padEnd(42)}  (missing)`);
    continue;
  }
  const hits = findTokensOutsideComments(source, PATTERNS);
  const nonRegexp = hits.filter((hit) => hit.where !== "regexp").length;
  const regexp = hits.filter((hit) => hit.where === "regexp").length;
  total += nonRegexp;

  const shapes = [...new Set(hits.map((hit) => `${hit.where}:${hit.category}`))];
  console.log(`${file.padEnd(42)} ${String(nonRegexp).padStart(10)} ${String(regexp).padStart(7)}  ${shapes.join(", ")}`);
}

console.log(`\ntotal non-regexp occurrences across allowance files: ${total}`);
console.log(`patterns enforced: ${PATTERNS.length}`);
