/**
 * Regression guard: internal review attribution in product code.
 *
 * ── Why this is a separate check from the release gate ──
 *
 * The gate tolerates a forbidden shape in its own pattern documentation and in
 * synthetic controls, because a scanner must contain what it searches for and a
 * control must contain the shape it rejects. That tolerance is correct but it
 * makes the gate unable to answer the narrower question a reviewer actually asks:
 *
 *     "did the *application* stop attributing work to an internal reviewer?"
 *
 * So this probes the directories that constitute the shipped product and asserts
 * zero occurrences there, while explicitly recording the places where the shape is
 * legitimate — so "we removed them all" is a claim with a stated boundary rather
 * than an overstatement.
 *
 * ── What changed, and why ──
 *
 * This guard used to search for the internal role code as a bare word. Two things
 * were wrong with that:
 *
 *   1. The word is not itself a disclosure — it is an ordinary job title that
 *      appears in legitimate engineering prose. What leaks is the *attribution*:
 *      "reviewed by <name>", "<name> review round 3", a sign-off verdict.
 *   2. Keeping the code in the file to search for it published the code. A guard
 *      that has to spell out the secret is not protecting it.
 *
 * It now searches for the same enforced shapes the release gate uses. That is a
 * *narrower* match per shape and a *broader* question overall: the product no
 * longer needs a specific role name to be flagged for attributing its work to an
 * internal reviewer.
 *
 * ── The boundary, stated ──
 *
 * This cannot detect an arbitrary unknown private name, and does not claim to:
 * the list of names it would need is exactly the thing that must not ship. It
 * detects attribution *records*. Naming a tool in prose without any attribution
 * shape is covered by human review.
 *
 * Usage: node tools/guard-role-references.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directories that constitute the shipped product and its verification. */
const PRODUCT_DIRECTORIES = ["src", "tests", "e2e", "scripts"];

/**
 * Directories where an enforced shape may legitimately appear, each with a reason.
 *
 * Reported rather than silently skipped: an allowance that is not listed is
 * indistinguishable from an oversight.
 */
const ALLOWED_WITH_REASON = [
  ["CONTRIBUTING.md", "describes the excluded categories without naming a concrete token"],
  ["tools/public-release-check.mjs", "defines the enforced shapes and why a bare word is not matched"],
  ["tools/audit-history.mjs", "documents the forbidden commit-message shapes"],
  ["tools/gate-negative-controls.mjs", "synthetic controls must contain the shapes they reject"],
  ["tools/guard-token-scanner.mjs", "the probe must be an enforced shape to be meaningful"],
  ["tools/structural-scan.mjs", "self-test fixtures"],
  ["tools/guard-source-doc-refs.mjs", "no occurrence expected; listed so a future one is reviewed"],
];

/**
 * The enforced shapes, mirroring the release gate.
 *
 * Duplicated deliberately rather than imported: this probe must keep working if
 * the gate's table is edited to be more permissive, and an import would silently
 * import that looseness.
 */
const PATTERNS = [
  /\b[A-Z][A-Za-z0-9._-]{2,23}\s+review\s+round\s+\d+/,
  /\breview(?:ed)?\s+by\s+(?:the\s+)?[A-Z][A-Za-z0-9._-]{2,23}\b/,
  /\b[A-Z][A-Z0-9]{2,15}\s+(?:FINAL\s+)?(?:PASS|APPROVED|SIGNED\s+OFF)\b/,
  /\bfinal\s+pass\b/,
];

/** True when the text contains any enforced attribution/sign-off shape. */
function containsEnforcedShape(text) {
  return PATTERNS.some((pattern) => pattern.test(text));
}

function walk(directory, out = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      walk(absolute, out);
      continue;
    }
    if (statSync(absolute).isFile()) out.push(absolute.replace(/\\/g, "/"));
  }
  return out;
}

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok    ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("internal-role references in the product\n");

// ── product directories must be clean ──
let productFiles = 0;
const productHits = [];
for (const directory of PRODUCT_DIRECTORIES) {
  for (const file of walk(directory)) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    productFiles += 1;
    if (containsEnforcedShape(text)) productHits.push(file);
  }
}

check(
  `zero internal-role references across ${productFiles} product file(s)`,
  productHits.length === 0,
  productHits.join(", "),
);

/*
 * A count of zero is only meaningful if the scan actually looked at something.
 * Without this, a changed directory name would make the check pass by scanning
 * nothing — the classic empty-scope pass.
 */
check("the scan covered a plausible number of files", productFiles > 200, `${productFiles} file(s)`);

// ── the functional semantics the rewritten comments describe must still hold ──
/*
 * The three comments carried engineering meaning, not just an attribution. This
 * asserts the *tests* they introduce still exist and still assert what the new
 * wording claims, so replacing a comment cannot quietly drop a guarantee.
 */
const a1 = readFileSync("tests/course-a1-workbench.test.ts", "utf8");
check(
  "A1 directory-identity suite still present",
  a1.includes("A1 · 验收工具必须核对目录**身份**，而不是目录名"),
);
check(
  "A1 identity suite still asserts a decoy is rejected",
  /accepted[^;]*toBe\(false\)/s.test(a1),
);

const expert = readFileSync("tests/expert-training.test.ts", "utf8");
check(
  "expert-training exactly-once suite still present",
  expert.includes("提交在数据库事务边界上恰好一次"),
);
check(
  "expert-training answer_changed suite still present",
  expert.includes("answer_changed 只记录真正改过的答案"),
);

// ── report the documented allowances, so the boundary is visible ──
console.log("\ndocumented allowances (not part of the product):");
for (const [file, reason] of ALLOWED_WITH_REASON) {
  let present = false;
  try {
    present = containsEnforcedShape(readFileSync(file, "utf8"));
  } catch {
    present = false;
  }
  console.log(`  ${present ? "contains" : "none    "}  ${file.padEnd(36)} ${reason}`);
}

console.log("");
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log("role references: product source and tests are clean");
