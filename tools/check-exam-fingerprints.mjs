#!/usr/bin/env node
/**
 * Standalone content fingerprint scan.
 *
 * ── Why a separate entry point ──
 *
 * The same rule set is applied in three places, deliberately:
 *
 * | Where | Purpose |
 * | --- | --- |
 * | `tests/support/paper-fingerprints.ts` | the rule set and matcher (one source) |
 * | `tests/architecture.test.ts` | fails the unit suite, with vitest reporting |
 * | this tool | runs in CI **without** the test runner |
 *
 * The duplication of *invocation* is the point. If the content guard only ran
 * inside vitest, then a broken vitest config, an accidentally excluded test file,
 * or a `--testPathIgnorePatterns` would silently disable it — and the guard that
 * exists to prevent unnoticed publication would itself go unnoticed. A separate
 * process with its own exit code cannot be skipped by a test-runner flag.
 *
 * It also proves the matcher works before trusting it: a synthetic phrase is
 * hashed and must be found. A scanner that has never matched anything is
 * indistinguishable from a scanner that is broken.
 *
 * Usage:
 *   node tools/check-exam-fingerprints.mjs [--root <dir>] [--quiet]
 *
 * Exit 0 = clean, 1 = hit, 2 = cannot run (which is also a failure).
 */

import { readFileSync, readdirSync, openSync, closeSync, readSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const ROOT = resolve(flag("root") ?? process.cwd());
const QUIET = process.argv.includes("--quiet");

const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", ".next", ".pnpm-store", "coverage",
  "test-results", "playwright-report", ".e2e",
]);

let ruleSet;
try {
  /*
   * The rule set is a `.ts` module. Importing it directly is correct here because
   * CI runs Node with `--experimental-transform-types`.
   *
   * `pathToFileURL` is required, not cosmetic: a bare absolute path such as
   * `D:\repo\tests\...` is parsed by the ESM loader as the *scheme* `d:`, so the
   * import fails on Windows with "only file/data/node URLs are supported". That
   * would turn this check into a hard error on the maintainer's own platform
   * while passing in CI — the reverse of the failure this project already had
   * once, and equally misleading.
   */
  ruleSet = await import(pathToFileURL(join(ROOT, "tests", "support", "paper-fingerprints.ts")).href);
} catch (error) {
  /*
   * Cannot load the rules ⇒ cannot verify ⇒ failure. Reporting this as a pass
   * would be the "scan failed but returned success" defect this tool exists to
   * avoid.
   */
  console.error(`FAIL  cannot load the fingerprint rule set: ${error.message}`);
  console.error("      This check is UNVERIFIED, which is a failure, not a skip.");
  process.exit(2);
}

const { REAL_PAPER_FINGERPRINTS, fingerprintPhrase, scanTextForFingerprints, isScannableText } = ruleSet;

if (!Array.isArray(REAL_PAPER_FINGERPRINTS) || REAL_PAPER_FINGERPRINTS.length === 0) {
  console.error("FAIL  the fingerprint rule set is empty — the check would be vacuous");
  process.exit(2);
}

/*
 * The text/binary decision is imported from the rule set rather than
 * re-declared here, so that this tool, the release gate and the architecture
 * guard cannot drift into three different definitions of "a text file".
 *
 * That drift is what a shared predicate prevents: each scanner carried its own
 * closed extension allow-list, so an extension that nobody had listed — `.bak`,
 * `.markdown`, `.orig` — was silently unscanned by every one of them. The
 * attacker chooses the extension; the scanner must not.
 */
function walk(directory, base, out = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(absolute, base, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const scannable = isScannableText(entry.name, () => {
      const fd = openSync(absolute, "r");
      try {
        const buffer = Buffer.alloc(4096);
        const bytes = readSync(fd, buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytes);
      } finally {
        closeSync(fd);
      }
    });
    if (!scannable) continue;
    out.push(relative(base, absolute).replace(/\\/g, "/"));
  }
  return out;
}

// ── positive control ──
{
  const synthetic = ["synthetic", "probe", "phrase", "for", "this", "check"].join(" ");
  const digest = fingerprintPhrase(synthetic);
  const detected = scanTextForFingerprints(synthetic, new Set([digest])).length > 0;
  if (!detected) {
    console.error("FAIL  the matcher did not detect a digest it was just given — the check is vacuous");
    process.exit(2);
  }
  if (!QUIET) console.log(`ok    positive control: matcher detects a synthetic digest`);
}

// ── the scan ──
const files = walk(ROOT, ROOT);
// The rule set is passed through as-is; the matcher indexes it internally.
const fingerprints = REAL_PAPER_FINGERPRINTS;
const hits = [];

for (const file of files) {
  let text;
  try {
    text = readFileSync(join(ROOT, ...file.split("/")), "utf8");
  } catch {
    continue;
  }
  const found = scanTextForFingerprints(text, fingerprints);
  if (found.length > 0) hits.push({ file, count: found.length });
}

if (!QUIET) {
  console.log(`      scanned ${files.length} text file(s) against ${fingerprints.length} fingerprint(s)`);
}

if (hits.length > 0) {
  console.error(`\nFAIL  real exam text detected in ${hits.length} file(s):`);
  for (const hit of hits) {
    // File and count only. Printing the offset would help locate it, but every
    // additional detail is a chance to reconstruct the protected text.
    console.error(`        ${hit.file} (${hit.count} hit(s))`);
  }
  console.error("\nRemove the material. Do not add an exemption to make this pass.");
  process.exit(1);
}

if (!QUIET) console.log("ok    no real exam text in the tree");
process.exit(0);
