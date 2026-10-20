/**
 * Behavioural proof for the display sanitiser, run as a real script.
 *
 * Kept as a runnable proof, not only as a vitest case, because the interesting
 * failure mode is not "does the regex match" but "does the module still hold no
 * internal directory names after a refactor". A unit test can pass while a
 * hard-coded marker table is reintroduced; a byte-level check of the module
 * source cannot.
 *
 * Run with:
 *   pnpm display-safety-proof
 */

import {
  containsPathLeak,
  PATH_PLACEHOLDER,
  sanitizeDisplayText,
} from "../src/lib/display-safety";

/** Input strings that must be sanitised. None of them is real content. */
const LEAKY_INPUTS = [
  String.raw`ENOENT: no such file or directory, open 'Q:\sample-root\private-content\courses\x\course.json'`,
  "课程包不存在或缺少 course.json：private-content/courses/fixture-x",
  "无法读取 /home/owner/.config/nextjs/config.json",
  String.raw`\\fileserver\share\private-content\x`,
  "课程包不存在或缺少 course.json：companion-content/courses/y",
  "读取 loopback-proof-content/a3 失败",
  ".e2e/cet6.db 打不开",
  "cet6-real/papers 缺失",
  "cet6-companion/papers 缺失",
];

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

for (const input of LEAKY_INPUTS) {
  const cleaned = sanitizeDisplayText(input);
  check(
    `sanitises ${JSON.stringify(input.slice(0, 48))}`,
    !containsPathLeak(cleaned) && cleaned.length > 0,
    JSON.stringify(cleaned),
  );
}

// Negative control 1: ordinary prose containing a slash must survive untouched,
// or the sanitiser would mangle legitimate explanations.
const prose = "reading/listening 交替进行";
check("preserves ordinary prose with a slash", sanitizeDisplayText(prose) === prose);

// Negative control 2: a plain sentence is untouched.
const plain = "这段材料还没有已核验的对应关系。";
check("preserves a plain sentence", sanitizeDisplayText(plain) === plain);

// The readable explanation must survive sanitisation — that is the whole
// contract: remove the path, keep the meaning.
const explained = sanitizeDisplayText("课程包不存在或缺少 course.json：private-content/courses/x");
check("keeps the readable explanation", explained.includes("course.json"), JSON.stringify(explained));

// Structural check on the module source: no project directory name may appear as
// a string literal. This is the regression guard for the original defect, where
// a literal marker table shipped to the browser.
const moduleSource = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL("../src/lib/display-safety.ts", import.meta.url), "utf8"),
);
const forbiddenLiterals = [
  "private-content",
  "companion-content",
  "loopback-proof-content",
  "cet6-real",
  "cet6-companion",
];
for (const literal of forbiddenLiterals) {
  // Allow appearance inside comments (they legitimately document examples) but
  // not inside a string literal.
  const asString = new RegExp(`["'\`]${literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
  check(`module has no string literal "${literal}"`, !asString.test(moduleSource));
}

console.log(`\nplaceholder = ${JSON.stringify(PATH_PLACEHOLDER)}`);
if (failures > 0) {
  console.error(`\n${failures} display-safety proof case(s) FAILED`);
  process.exit(1);
}
console.log("display-safety proof: PASS");
