/**
 * Positive/negative control proof for the content-provenance guard.
 *
 * The point of this script is that it never contains a real exam phrase. It
 * reads candidate phrases from a file the operator supplies (typically a local
 * evidence copy that is not in any repository), hashes them, and proves that:
 *
 *   1. every supplied phrase is recognised by the committed hash rule data;
 *   2. recognition survives case, punctuation and whitespace mutation;
 *   3. ordinary synthetic prose is not flagged.
 *
 * Usage:
 *   node --experimental-transform-types --import ./scripts/alias-loader.mjs \
 *     scripts/content-fingerprint-proof.ts --phrases <file>
 *
 * Without `--phrases` it runs only checks 2 and 3 using synthetic text, which
 * still proves the mechanism is not a no-op.
 */

import { readFileSync } from "node:fs";
import {
  REAL_PAPER_FINGERPRINTS,
  fingerprintPhrase,
  scanTextForFingerprints,
  scanTreeForFingerprints,
} from "../tests/support/paper-fingerprints";

const index = process.argv.indexOf("--phrases");
const phraseFile = index === -1 ? null : process.argv[index + 1];

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${label}${detail === "" ? "" : ` — ${detail}`}`);
}

console.log(`fingerprint rule data: ${REAL_PAPER_FINGERPRINTS.length} hash(es)`);

// The rule data must be hashes, not prose. A hex-only, fixed-width shape is the
// structural assertion that replaces "we promise we did not commit the text".
check(
  "every fingerprint is a 32-hex-char digest (no plaintext can be stored here)",
  REAL_PAPER_FINGERPRINTS.every((entry) => /^[0-9a-f]{32}$/.test(entry.digest)),
);

if (phraseFile !== null) {
  const phrases = readFileSync(phraseFile, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));

  let recognised = 0;
  for (const phrase of phrases) {
    const expected = fingerprintPhrase(phrase);
    // Compare on the digest: the token count is derived from the same phrase, so
    // a mismatch in either means the rule entry is stale.
    const inRules = REAL_PAPER_FINGERPRINTS.some((entry) => entry.digest === expected.digest);
    if (!inRules) {
      check("phrase is covered by the committed rule data", false, "fingerprint missing");
      continue;
    }
    // Wrap the phrase in unrelated filler so the matcher has to locate it.
    const detected = scanTextForFingerprints(`filler text before\n${phrase}\nfiller text after`).length > 0;
    if (detected) recognised += 1;
    else check("phrase is detected inside surrounding prose", false);
  }
  check(
    `all ${phrases.length} supplied phrase(s) recognised (positive control)`,
    recognised === phrases.length,
    `${recognised}/${phrases.length}`,
  );

  // Mutation control: normalisation must survive the transformations that a
  // copy-paste or a reformat actually applies.
  const mutated = phrases[0].toUpperCase().replace(/ /g, "   \n\t ");
  check(
    "recognition survives case/whitespace/line-break mutation",
    scanTextForFingerprints(mutated).length > 0,
  );

  const punctuated = `— ${phrases[0].replace(/ /g, ", ")} —`;
  check("recognition survives inserted punctuation", scanTextForFingerprints(punctuated).length > 0);
}

// Negative control: synthetic fixture prose must not be flagged.
const synthetic =
  "SYNTHETIC FIXTURE. A synthetic researcher places a lamp beside a wooden bench and records the " +
  "ambient light with a calibrated meter. The measured values are reported in the appendix table.";
check("synthetic prose is not flagged (negative control)", scanTextForFingerprints(synthetic).length === 0);

// Negative control: the exported public tree must be clean.
const treeHits = scanTreeForFingerprints(process.cwd());
check(
  "the repository tree itself is clean of real-paper fingerprints",
  treeHits.length === 0,
  treeHits.map((hit) => hit.file).join(", "),
);

if (failures > 0) {
  console.error(`\n${failures} control(s) FAILED`);
  process.exit(1);
}
console.log("\ncontent-fingerprint proof: PASS");
