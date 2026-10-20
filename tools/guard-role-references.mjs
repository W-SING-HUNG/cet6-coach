/**
 * Regression guard: internal-role references in product code.
 *
 * ── Why this is a separate check from the release gate ──
 *
 * The gate tolerates a bare role word in its own pattern documentation and in
 * synthetic controls, because a scanner must contain what it searches for and a
 * control must contain the shape it rejects. That tolerance is correct but it
 * makes the gate unable to answer the narrower question a reviewer actually asks:
 *
 *     "did the *application* stop referring to an internal reviewer?"
 *
 * So this probes the directories that constitute the shipped product and asserts
 * zero occurrences there, while explicitly recording the places where the word is
 * legitimate — so "we removed them all" is a claim with a stated boundary rather
 * than an overstatement.
 *
 * Usage: node tools/guard-role-references.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directories that constitute the shipped product and its verification. */
const PRODUCT_DIRECTORIES = ["src", "tests", "e2e", "scripts"];

/**
 * Directories where the word may legitimately appear, each with a reason.
 *
 * Reported rather than silently skipped: an allowance that is not listed is
 * indistinguishable from an oversight.
 */
const ALLOWED_WITH_REASON = [
  ["CONTRIBUTING.md", "states the rule, which requires naming what it forbids"],
  ["tools/public-release-check.mjs", "explains which shapes are matched and why a bare word is not"],
  ["tools/audit-history.mjs", "documents the forbidden commit-message shapes"],
  ["tools/gate-negative-controls.mjs", "synthetic controls must contain the shapes they reject"],
  ["tools/guard-token-scanner.mjs", "documents which token the probe uses and why"],
  ["tools/structural-scan.mjs", "self-test fixtures"],
  ["tools/guard-source-doc-refs.mjs", "no occurrence expected; listed so a future one is reviewed"],
];

const PATTERN = /\bCTO\b/;

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
    if (PATTERN.test(text)) productHits.push(file);
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
    present = PATTERN.test(readFileSync(file, "utf8"));
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
