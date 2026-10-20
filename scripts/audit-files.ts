/**
 * Ad-hoc audit: run the fingerprint rule set over arbitrary files.
 *
 * Used during public-export review to decide whether a candidate file may ship.
 * It reports only hit counts and file names — never the matched text, because
 * the whole point of the hash-only rule set is that matched text never has to be
 * printed anywhere.
 *
 * Usage:
 *   pnpm audit:files <file> [file...]
 */
import { readFileSync } from "node:fs";
import { scanTextForFingerprints } from "../tests/support/paper-fingerprints";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: node ... scripts/audit-files.ts <file> [file...]");
  process.exit(2);
}

let total = 0;
for (const file of files) {
  const hits = scanTextForFingerprints(readFileSync(file, "utf8"));
  total += hits.length;
  console.log(`${hits.length === 0 ? "clean" : "HIT  "}  ${file}  (${hits.length})`);
}
console.log(`\ntotal fingerprint hits: ${total}`);
process.exit(total === 0 ? 0 : 1);
