/**
 * Probe: how does the structural scanner treat markdown?
 *
 * Markdown has no `//` or `/* *\/`. Its only comment form is `<!-- -->`. A fenced
 * code block is *rendered*, so its contents are reader-visible and must be
 * checked.
 *
 * This probe exists because running the JavaScript rules over a `.md` file
 * produced nonsense — an HTML comment read as code, and a fenced block's ``` read
 * as a template opener that swallowed the remainder of the file. Discovering that
 * by accident, in a control, is worse than asserting it here.
 */

import { findTokensOutsideComments } from "./structural-scan.mjs";

const TOKEN = ["Qo", "der"].join("");
const PATTERNS = [[new RegExp(`\\b${TOKEN}\\b`), "role"]];

const cases = [
  // [label, source, language, expectHit, expectWhere]
  ["markdown HTML comment", `<!-- explains why ${TOKEN} is not allowed -->`, "markdown", false, null],
  ["markdown prose", `Do not write ${TOKEN} in a commit message.`, "markdown", true, "code"],
  ["markdown fenced block is visible", "```js\n// " + TOKEN + " is forbidden\n```", "markdown", true, "code"],
  ["markdown inline code", `Use \`${TOKEN}\` never.`, "markdown", true, "code"],
  ["markdown multiple comments", `<!-- ${TOKEN} -->\n\nText.\n\n<!-- ${TOKEN} -->`, "markdown", false, null],
  ["markdown comment then prose", `<!-- ${TOKEN} -->\n\nThen ${TOKEN} appears.`, "markdown", true, "code"],
  ["js line comment", `// ${TOKEN}`, "js", false, null],
  ["js block comment", `/* ${TOKEN} */`, "js", false, null],
  ["js template text", "const x = `" + TOKEN + "`;", "js", true, "template-text"],
];

let failed = 0;
for (const [label, source, language, expectHit, expectWhere] of cases) {
  const hits = findTokensOutsideComments(source, PATTERNS, { language });
  const gotHit = hits.length > 0;
  const whereOk = expectWhere === null || hits.some((hit) => hit.where === expectWhere || (expectWhere === "code" && hit.where === "code"));
  const ok = gotHit === expectHit && whereOk;
  if (ok) {
    console.log(`ok    ${label}`);
  } else {
    failed += 1;
    console.error(
      `FAIL  ${label} — expected hit=${expectHit} where=${expectWhere}, got ${JSON.stringify(hits.map((hit) => hit.where))}`,
    );
  }
}

console.log("");
if (failed > 0) {
  console.error(`${failed} markdown probe case(s) FAILED`);
  process.exit(1);
}
console.log(`markdown probe: PASS (${cases.length} cases)`);
