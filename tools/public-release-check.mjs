#!/usr/bin/env node
/**
 * Public release gate.
 *
 * ── What this is for ──
 *
 * The export policy decides what *may* ship. This tool checks that what *is*
 * about to ship actually conforms — on the real tree, not on the policy's
 * intentions. It is the difference between a document and a control.
 *
 * It is deliberately **local and offline**: it never transmits repository
 * contents to a third-party scanning service. A leak cannot be undone by
 * deleting an alert, so the check has to run where the data already is.
 *
 * ── Checks ──
 *
 *   1. forbidden paths      no `.opc/`, no content root, no databases/caches
 *   2. filename audit       no personal names, hostnames, drive paths
 *   3. secrets              patterns for real credential formats
 *   4. secret positive      the scanner is proven to fire on synthetic secrets
 *   5. exam prose           hash-fingerprint scan of every text file
 *   6. fingerprint positive the fingerprint scanner is proven to fire
 *   7. personal data        score/schedule patterns that only a real owner has
 *   8. internal process     review-role and workflow tokens
 *   9. attribution          licence status documented + SECURITY / notices / env example present
 *  10. content-root absence  no study content directory is present at all
 *
 * Every check that can report "pass" must also be provable to report "fail".
 * Checks 4 and 6 are the positive controls that make 3 and 5 meaningful.
 *
 * Usage:
 *   node tools/public-release-check.mjs [--root <dir>] [--json]
 *
 * Exit 0 = conforming. Exit 1 = violation. Exit 2 = bad invocation.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, openSync, closeSync, readSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { findTokensOutsideComments } from "./structural-scan.mjs";
import { describeFinding, findInternalWorkspacePaths } from "./workspace-path-scan.mjs";

// ---------------------------------------------------------------- invocation

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const rootArgument = flag("root");
const ROOT = resolve(rootArgument ?? process.cwd());
const JSON_OUTPUT = process.argv.includes("--json");

if (!existsSync(join(ROOT, "package.json"))) {
  console.error(`not a project root (no package.json): ${ROOT}`);
  process.exit(2);
}

// -------------------------------------------------------------- file walking

const SKIP_DIRECTORIES = new Set([
  ".git",
  "node_modules",
  ".next",
  ".pnpm-store",
  "coverage",
  "test-results",
  "playwright-report",
  ".e2e",
]);

/** Extensions **known** to be text. Not the boundary of the scan — see below. */
const TEXT_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".css", ".html", ".htm",
  ".yml", ".yaml", ".txt", ".svg", ".example", ".gitignore", ".gitattributes",
  ".npmrc", ".editorconfig", ".markdown", ".rst", ".text", ".bak", ".orig",
  ".tmp", ".patch", ".diff",
];

/**
 * Extensions **known** to be binary. Never read as text.
 *
 * A deny-list rather than a byte sniff: sniffing makes a polyglot file's
 * classification depend on which check runs first, and that choice belongs to
 * whoever crafted the file.
 */
const BINARY_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
  ".pdf", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
  ".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".opus",
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".db", ".sqlite", ".sqlite3", ".wasm", ".node", ".exe", ".dll",
  ".p12", ".pfx", ".jks",
];

/**
 * Decide whether a file is read as text for the content scans.
 *
 * ── Why this is wider than an extension list ──
 *
 * A closed allow-list means "every extension nobody thought of is
 * unscanned", and an attacker chooses the extension. The review demonstrated
 * the hole concretely: exam prose planted in `leak.md.bak` was invisible to
 * both scanners, because `.bak` was in neither list.
 *
 * The rule is deny-by-default with a content probe:
 *
 *   1. known-binary extension ⇒ never scanned;
 *   2. known-text extension ⇒ scanned;
 *   3. unknown extension ⇒ read the first block, scan only if it decodes as
 *      UTF-8 without replacement characters and contains no NUL byte.
 *
 * Case 3 is the fix. It is conservative in the safe direction: a file that
 * fails the probe is skipped rather than guessed at, and a skipped file is one
 * we could not read. It never invents a classification.
 */
function isTextFile(file) {
  const lower = file.toLowerCase();
  if (BINARY_EXTENSIONS.some((extension) => lower.endsWith(extension))) return false;
  if (TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;
  if (file === ".gitignore" || file === ".gitattributes" || file === ".npmrc") return true;
  return decodesAsUtf8Text(join(ROOT, ...file.split("/")));
}

/** Read the first block of a file and decide whether it is UTF-8 text. */
function decodesAsUtf8Text(absolutePath) {
  let fd;
  try {
    fd = openSync(absolutePath, "r");
    const buffer = Buffer.alloc(4096);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytes);
    if (head.length === 0) return false;
    if (head.includes(0)) return false;
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* closing a probe handle must never mask the verdict */
      }
    }
  }
}

/**
 * Local build artifacts that `.gitignore` already excludes.
 *
 * The gate walks the filesystem rather than the index, so a developer's local
 * `tsc` run would otherwise fail the release check for a file that can never be
 * committed. The gate is about what may ship; an ignored artifact cannot ship.
 *
 * This is deliberately narrow — two specific generated files, both confirmed
 * ignored — rather than a pattern that could quietly cover a real source file.
 * If either ever *does* get committed, the history audit catches it, because
 * that check reads the index rather than the working tree.
 */
const IGNORED_BUILD_ARTIFACTS = /(^|\/)(?:[^/]+\.tsbuildinfo|next-env\.d\.ts)$/;

function walk(directory, base, out) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORIES.has(entry.name)) continue;
      walk(absolute, base, out);
      continue;
    }
    if (!entry.isFile()) continue;
    const relativePath = relative(base, absolute).replace(/\\/g, "/");
    // Ignored build artifacts are not part of the shippable surface; see the
    // note on IGNORED_BUILD_ARTIFACTS. Their committed status is the history
    // audit's job, and that check reads the index instead of the working tree.
    if (IGNORED_BUILD_ARTIFACTS.test(relativePath)) continue;
    out.push(relativePath);
  }
  return out;
}

const ALL_FILES = walk(ROOT, ROOT, []);
const TEXT_FILES = ALL_FILES.filter((file) => isTextFile(file));

/** Read a text file, tolerating a stray BOM and binary-ish content. */
function readText(file) {
  try {
    return readFileSync(join(ROOT, ...file.split("/")), "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------- reporting

const results = [];
function record(id, title, violations, note = "") {
  results.push({ id, title, ok: violations.length === 0, violations, note });
}

// ------------------------------------------------------- 1. forbidden paths

/**
 * Paths that must never appear in a public tree, by category.
 *
 * Each entry is a regex over the repository-relative path. The categories are
 * separate so a failure message can say *what kind* of thing leaked without
 * printing the file's contents.
 */
const FORBIDDEN_PATHS = [
  [/^\.opc\//, "internal engineering records"],
  [/^private-content\//, "private study content"],
  [/^data\//, "local database directory"],
  [/^\.e2e\//, "E2E scratch directory"],
  [/^\.next\//, "build output"],
  [/^\.pnpm-store\//, "package-manager content store"],
  [/^node_modules\//, "installed dependencies"],
  [/\.db($|-wal$|-shm$)/, "SQLite database file"],
  [/\.(pem|key|p12|pfx)$/i, "private key material"],
  [/(^|\/)\.env($|\.local$|\.production$)/, "environment file with values"],
  [/\.(log)$/i, "log file"],
  [/\.tsbuildinfo$/, "incremental build metadata"],
  [/(^|\/)research-shots\//, "third-party research screenshots"],
  [/^docs\/(course-intake-pipeline|rsvp-integration-readiness|reading-convergence-evidence|ui-v2-visual-evidence)\.md$/, "internal engineering narrative"],
  /*
   * Original internal agent-instruction and engineering-charter documents.
   * These belong to the private process and are explicitly not cleared for
   * publication. Public contributor guidance lives in CONTRIBUTING.md, which is
   * authored independently for this distribution.
   */
  [/(^|\/)(AGENTS|CLAUDE)\.md$/, "internal agent-instruction document"],
];

{
  const violations = [];
  for (const file of ALL_FILES) {
    for (const [pattern, category] of FORBIDDEN_PATHS) {
      if (pattern.test(file)) {
        violations.push({ file, category });
        break;
      }
    }
  }
  record("forbidden-paths", "no forbidden paths present", violations);
}

// ------------------------------------------------------------ 2. filename audit

/**
 * Personal identifiers and machine identities in *names*.
 *
 * The specific strings (an account handle, a drive root) are not stored here;
 * the patterns match the *shape* of an identity leak, which is what generalises
 * to the next contributor.
 */
const FILENAME_PATTERNS = [
  [/(^|\/)[A-Za-z]:[\\/]/, "absolute Windows path in a filename"],
  [/(^|\/)(Users|home)[\\/][^/]+[\\/]/, "absolute user-home path in a filename"],
  [/@[a-z0-9.-]+\.(com|net|org|cn)/i, "email address in a filename"],
  [/(^|\/)(Desktop|Documents|Downloads)[\\/]/i, "user-profile folder in a filename"],
];

{
  const violations = [];
  for (const file of ALL_FILES) {
    for (const [pattern, category] of FILENAME_PATTERNS) {
      if (pattern.test(file)) {
        violations.push({ file, category });
        break;
      }
    }
  }
  record("filename-audit", "filenames carry no paths or identities", violations);
}

// ---------------------------------------------------------------- 3. secrets

/**
 * Credential shapes that are unambiguously real, not placeholders.
 *
 * Deliberately format-based rather than entropy-based: entropy scanners produce
 * noise, and noise gets suppressed, and suppression is how a real secret ships.
 * Each pattern below matches a *known vendor format*.
 */
const SECRET_PATTERNS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/, "PEM private key block"],
  [/\bghp_[A-Za-z0-9]{36}\b/, "GitHub personal access token (classic)"],
  [/\bgithub_pat_[A-Za-z0-9_]{60,}\b/, "GitHub fine-grained token"],
  [/\bgho_[A-Za-z0-9]{36}\b/, "GitHub OAuth token"],
  [/\bsk-[A-Za-z0-9]{32,}\b/, "OpenAI-style API key"],
  [/\bsk-ant-[A-Za-z0-9-]{32,}\b/, "Anthropic API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key id"],
  [/\bASIA[0-9A-Z]{16}\b/, "AWS temporary access key id"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/, "Slack token"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\bglpat-[A-Za-z0-9_-]{20,}\b/, "GitLab personal access token"],
  [/\bnpm_[A-Za-z0-9]{36}\b/, "npm access token"],
  [/\bdop_v1_[a-f0-9]{64}\b/, "DigitalOcean token"],
  [/\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/, "SendGrid API key"],
  [
    /\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["'][^"'\s]{12,}["']/i,
    "hard-coded credential assignment",
  ],
];

/**
 * Scan text for secret patterns.
 *
 * Exported through the module scope so the positive-control check below can call
 * the *same* function the real scan uses. A control that exercises a copy of the
 * scanner proves nothing about the scanner.
 */
function scanForSecrets(text) {
  const hits = [];
  for (const [pattern, category] of SECRET_PATTERNS) {
    if (pattern.test(text)) hits.push(category);
  }
  return hits;
}

{
  const violations = [];
  for (const file of TEXT_FILES) {
    const hits = scanForSecrets(readText(file));
    // One report per file, not per match: the category is enough to act on, and
    // reproducing the matched text would put the secret back into a log.
    if (hits.length > 0) violations.push({ file, category: hits.join("; ") });
  }
  record("secrets", "no credential-shaped strings in text files", violations);
}

// ------------------------------------------------------ 4. secret positive control

{
  /*
   * Build synthetic credentials at runtime from fragments.
   *
   * They are assembled here rather than written literally so that this file
   * never itself contains a string that looks like a live credential — otherwise
   * the scanner would (correctly) flag its own test data, and the obvious "fix"
   * would be to add an exemption, which is how real scanners get neutered.
   */
  const fake = [
    ["gh", "p_", "A".repeat(36)].join(""),
    ["sk", "-", "B".repeat(32)].join(""),
    ["AK", "IA", "C".repeat(16)].join(""),
    ["-----BEGIN ", "RSA PRIVATE KEY-----"].join(""),
  ];
  const undetected = fake.filter((sample) => scanForSecrets(sample).length === 0);

  // Negative control: ordinary prose must not be flagged, or the scanner is
  // useless and will be ignored.
  const prose = "The quick brown fox jumps over the lazy dog while the build runs.";
  const falsePositive = scanForSecrets(prose).length > 0;

  const violations = [];
  if (undetected.length > 0) {
    violations.push({
      file: "tools/public-release-check.mjs",
      category: `${undetected.length} synthetic credential(s) were NOT detected — the secret scan is not wired up`,
    });
  }
  if (falsePositive) {
    violations.push({
      file: "tools/public-release-check.mjs",
      category: "ordinary prose was flagged as a secret — the scanner is too broad to be useful",
    });
  }
  record(
    "secrets-positive-control",
    "the secret scanner detects synthetic credentials and ignores prose",
    violations,
  );
}

// ---------------------------------------------------------- 5. exam prose scan

/**
 * Fingerprint scan against the rule set in `tests/support/paper-fingerprints.ts`.
 *
 * Imported dynamically so this tool still runs if the test helper is temporarily
 * broken: the check then fails loudly instead of silently passing.
 */
let fingerprintCheck;
{
  const violations = [];
  try {
    const fingerprintRules = await import(
      new URL(`../tests/support/paper-fingerprints.ts`, import.meta.url).href
    ).catch(() => import(join(ROOT, "tests/support/paper-fingerprints.ts")));

    const fingerprints = fingerprintRules.REAL_PAPER_FINGERPRINTS;
    let scanned = 0;
    for (const file of TEXT_FILES) {
      const hits = fingerprintRules.scanTextForFingerprints(readText(file), fingerprints);
      scanned += 1;
      if (hits.length > 0) {
        violations.push({ file, category: `real exam text detected (${hits.length} fingerprint hit(s))` });
      }
    }
    fingerprintCheck = { fingerprintRules, scanned };
    record(
      "exam-prose",
      `no real exam text in ${scanned} text file(s)`,
      violations,
      `rule set: ${fingerprints.length} hash(es)`,
    );
  } catch (error) {
    violations.push({
      file: "tests/support/paper-fingerprints.ts",
      category: `cannot load the fingerprint rule set, so this check is UNVERIFIED: ${error.message}`,
    });
    record("exam-prose", "no real exam text in text files", violations);
  }
}

// --------------------------------------------- 6. fingerprint positive control

{
  /*
   * The fingerprint rule data is hashes, so a plaintext sample cannot be pulled
   * out of it. Instead this control hashes a phrase composed at runtime and
   * confirms the scanner matches it, plus confirms a near-miss does not match.
   *
   * That proves the matcher normalises, hashes and compares — the three things
   * that could silently break and make check 5 vacuous.
   */
  const violations = [];
  if (fingerprintCheck === undefined) {
    violations.push({
      file: "tests/support/paper-fingerprints.ts",
      category: "positive control could not run because the rule set failed to load",
    });
  } else {
    const { fingerprintRules } = fingerprintCheck;
    // Synthetic phrase, assembled here, never a real exam excerpt.
    const phrase = ["synthetic", "control", "phrase", "for", "the", "scanner"].join(" ");
    const fingerprint = fingerprintRules.fingerprintPhrase(phrase);
    const detected = fingerprintRules.scanTextForFingerprints(phrase, [fingerprint]).length > 0;
    if (!detected) {
      violations.push({
        file: "tests/support/paper-fingerprints.ts",
        category: "the scanner did not match a digest it was just given — check 5 is vacuous",
      });
    }
    const mutated = phrase.toUpperCase().replace(/ /g, "   \n ");
    if (fingerprintRules.scanTextForFingerprints(mutated, [fingerprint]).length === 0) {
      violations.push({
        file: "tests/support/paper-fingerprints.ts",
        category: "matching is case/whitespace sensitive — reformatted text would slip through",
      });
    }
    const nearMiss = ["synthetic", "control", "phrase", "for", "another", "scanner"].join(" ");
    if (fingerprintRules.scanTextForFingerprints(nearMiss, [fingerprint]).length > 0) {
      violations.push({
        file: "tests/support/paper-fingerprints.ts",
        category: "an unrelated phrase matched — the scanner is too broad",
      });
    }
  }
  record("fingerprint-positive-control", "the fingerprint scanner matches, normalises and discriminates", violations);
}

// ------------------------------------------------------------ 7. personal data

/**
 * Patterns that indicate a *specific person's* study record rather than a
 * generic product rule.
 *
 * The delicate part: the product legitimately discusses scores in prose
 * ("historical scores are background, not truth"). What must not ship is a
 * concrete pair of numbers attributed to the owner, or a personal schedule.
 * So these match concrete numeric claims next to first-person/owner framing.
 */
const PERSONAL_DATA_PATTERNS = [
  [/四级\s*[:：]?\s*[0-9]{3}/, "concrete CET-4 score attributed to a person"],
  [/六级\s*(?:约|大约)?\s*[0-9]{3}/, "concrete CET-6 score attributed to a person"],
  [/起点是四级\s*[0-9]{3}/, "owner's starting-score sentence"],
  [/工作日约\s*[0-9]+\s*分钟[、,]\s*周末约\s*[0-9]+\s*分钟/, "owner's personal weekly schedule"],
  [/目标分数?\s*[:：]\s*[0-9]{3}\+?/, "a person's private target band"],
  [/我的(?:分数|成绩|目标|时间)/, "first-person personal study data"],
];

{
  const violations = [];
  for (const file of TEXT_FILES) {
    const text = readText(file);
    for (const [pattern, category] of PERSONAL_DATA_PATTERNS) {
      if (pattern.test(text)) violations.push({ file, category });
    }
  }
  record("personal-data", "no person-specific study records", violations);
}

// --------------------------------------------------------- 8. internal process

/**
 * Tokens from an internal development workflow.
 *
 * Note the distinction the task demands: AI involvement must NOT be hidden, so
 * generic technology names are fine. What is excluded is the *internal process*
 * — review-role codes, workflow stage names, ticket prefixes, and decision
 * identifiers that only make sense inside one team's log.
 */
const INTERNAL_PROCESS_PATTERNS = [
  [new RegExp("\\b" + ["Qo", "der"].join("") + "\\b", "i"), "internal review role name"],
  /*
   * The bare acronym is deliberately **not** matched.
   *
   * It once appeared in a few comments as a role reference ("must be
   * authorised by <role>"). Those were prose, not records: no decision, no
   * finding, no instruction from a specific person. They have been reworded to
   * "maintainer" because an unexplained internal role code is noise for a
   * reader — but matching the bare word would be the wrong control, for two
   * reasons:
   *
   *   1. it would also match a legitimate technical use (a `cto` acronym in a
   *      domain module, a vendor name in a dependency), and a guard that fires
   *      on correct code gets switched off;
   *   2. the thing that must not ship is the *record* — the verdict, the
   *      ticket, the decision identifier — which the patterns below already
   *      cover by shape.
   *
   * What ships is judged by what it discloses, not by which words it contains.
   */
  [/\bCTO\s+(?:FINAL\s+)?(?:PASS|REVIEW|复核)/i, "internal review verdict"],
  /*
   * `Harness` is matched **only** in the sense the internal process used it: a
   * Chinese sentence referring to the agent runtime whose context must not be
   * polluted (that is, the runtime name adjacent to CJK prose). It is written
   * unanchored at first, which
   * flagged forty legitimate TypeScript identifiers (`interface Harness`,
   * `startHarness`, `harness.port`) — a test harness is ordinary engineering
   * English and suppressing it would be the wrong fix. The pattern now requires
   * a CJK character immediately adjacent, which no identifier has.
   */
  [/[\u4e00-\u9fff]\s*\/?\s*Harness|Harness\s*[\u4e00-\u9fff]/, "internal agent-harness reference"],
  [/\bD-\d{3}\b/, "internal decision-record identifier"],
  [/\.opc\//, "internal record path"],
  [/\b(?:PROJECT_STATUS|QUALITY_GATES|PROJECT_CONTEXT)\b/, "internal record name"],
  [/\bOwner(?:'s)?\s+(?:情况|真实情况|本机|不需要|执行)/, "owner-specific operating instruction"],
];

/**
 * Files exempt from the internal-process token scan, because their job is to
 * *describe* the forbidden tokens.
 *
 * This is not a loophole. A scanner that greps for a string must contain that
 * string, so a naive scan flags the scanner. The usual fix — adding the scanner
 * to an ignore list — is exactly the "scanner exempts itself" defect that this
 * whole release exists to correct (the original content guard omitted its own
 * file from its file list).
 *
 * The distinction that makes this safe: these files contain the tokens **as
 * quoted pattern definitions**, not as prose referring to a real internal
 * record. They are reviewable in one place, and the check that actually matters
 * — "does the shipped source reference an internal record?" — still runs over
 * every other file. To keep them honest, the exemption list is asserted below:
 * each entry must exist, and each must actually contain a pattern literal.
 */
/**
 * Allowances for files that must contain internal-process tokens.
 *
 * ── Why an allowance with a count, not an exemption ──
 *
 * An exemption says "skip this file". An allowance says "this file may contain
 * exactly N occurrences, and here is why". The difference is what happens when
 * someone adds another one: with an exemption, nothing; with an allowance, the
 * build fails.
 *
 * That matters because the realistic way a leak arrives is not a brand-new file —
 * it is one more sentence added to a file that was already allowed to mention the
 * topic.
 *
 * ── Why each entry is here ──
 *
 * `tools/public-release-check.mjs`
 *   Its pattern table is RegExp literals (tolerated separately), and its comments
 *   explain which shapes are matched. A scanner must contain what it searches
 *   for.
 *
 * `tools/audit-history.mjs`
 *   Same reason: it defines the forbidden commit-message shapes.
 *
 * `tools/gate-negative-controls.mjs`
 *   Writes synthetic prose and a synthetic record directory containing forbidden
 *   tokens, in order to prove the gate refuses them. The tokens must be real
 *   string values for the control to be meaningful.
 *
 * `tools/structural-scan.mjs`
 *   Its self-test builds synthetic sources containing a forbidden token, to prove
 *   the scanner classifies template and interpolation positions correctly.
 *
 * `tools/guard-token-scanner.mjs`, `tools/guard-build-boundary.mjs`
 *   Regression guards. They assemble tokens at runtime and need the surrounding
 *   shape to test it.
 *
 * `CONTRIBUTING.md`
 *   States the rules **without naming any internal token**. It used to carry a
 *   counted allowance of 2 on the grounds that "a rule of the form 'do not write
 *   X' has to name X". That reasoning was wrong for this file: the rules here are
 *   about a *category* (sign-offs, record identifiers, assistant-tool session
 *   narration), and a category can be described without reproducing a real tool
 *   name or a real sign-off. Naming them published exactly the material the rules
 *   exist to keep out.
 *
 *   The ceiling is therefore **0**. Markdown is not otherwise exempt: it has no
 *   comments, so every character is prose the reader sees — which is precisely why
 *   a concrete example in prose is a disclosure, not documentation.
 */
const TOKEN_ALLOWANCES = new Map([
  ["tools/public-release-check.mjs", { max: 0, why: "pattern table is RegExp literals only — no string tokens needed" }],
  ["tools/audit-history.mjs", { max: 0, why: "pattern table is RegExp literals only — no string tokens needed" }],
  ["tools/gate-negative-controls.mjs", { max: 2, why: "synthetic controls must contain the shapes they reject" }],
  ["tools/structural-scan.mjs", { max: 0, why: "self-test tokens are assembled at runtime" }],
  ["tools/guard-token-scanner.mjs", { max: 0, why: "guard tokens are assembled at runtime" }],
  ["tools/guard-build-boundary.mjs", { max: 0, why: "guard tokens are assembled at runtime" }],
  [
    "tools/audit-object-database.mjs",
    { max: 4, why: "names the forbidden paths it scans the object database for" },
  ],
  ["CONTRIBUTING.md", { max: 0, why: "describes the rules by category and never names a concrete token" }],
]);

{
  const violations = [];

  // The exemption list must not rot: a renamed or deleted tool must not leave a
  // silent hole.
  // An allowance for a file that no longer exists is rot: the next file with that
  // name would inherit a permission nobody reviewed.
  for (const file of TOKEN_ALLOWANCES.keys()) {
    if (!existsSync(join(ROOT, ...file.split("/")))) {
      violations.push({ file, category: "allowance names a file that does not exist — remove it" });
    }
  }

  /*
   * ── The exemption must be *provable*, not promised ──
   *
   * The list above says these files are exempt because they contain the
   * forbidden tokens "as quoted pattern definitions". That was a comment, not
   * a check: nothing stopped a future edit from pasting a real internal review
   * conversation into one of them, and the exemption would have carried on
   * covering it.
   *
   * So the claim is now asserted mechanically. For every exempt file, every
   * occurrence of every forbidden token must sit in one of:
   *
   *   1. a comment (`// …` or `/* … *\/`);
   *   2. a RegExp literal (`/…/ `) or a string literal (`"…"`, `'…'`, `` `…` ``).
   *
   * Anything else — an identifier, a template interpolation into executable
   * code, a bare word in prose — is a violation. This is the same
   * "strip comments, then look" technique the architecture guard uses, applied
   * in the safe direction: instead of trusting the file, we prove it.
   *
   * The check is deliberately syntactic. It cannot tell "a pattern that happens
   * to look like prose" from "prose", and it does not try to: what it proves is
   * that no forbidden token is part of the *code*, which is the part that could
   * actually name a real record.
   */
  for (const [file, allowance] of TOKEN_ALLOWANCES) {
    if (!existsSync(join(ROOT, ...file.split("/")))) continue;
    const raw = readText(file);

    /*
     * ── The structural scan, not a regex strip  ──
     *
     * This previously stripped comments, strings and RegExp literals with a
     * chain of regexes, then scanned what remained. The template-literal step
     * was
     *
     *     .replace(/`(?:[^`\\]|\\.)*`/g, "``")
     *
     * which removes the **whole** template including its `${...}` interpolations.
     * A forbidden token inside a template literal — the most ordinary way to
     * build a string in modern JavaScript — therefore vanished from the text being
     * checked, in exactly the files whose exemption is supposed to be *proven*
     * rather than trusted.
     *
     * `findTokensOutsideComments` replaces that chain with a single-pass state
     * machine that tracks quotes, escapes, RegExp class brackets and nested
     * template interpolations. Regexes cannot follow template nesting
     * (`` `a${`b${c}`}d` `` is legal), so "write a better pattern" would have
     * produced another approximately-correct stripper.
     */
    /*
     * Markdown is parsed with markdown's own structure, not JavaScript's.
     *
     * Running the JS rules over a `.md` file misreads it: `<!-- … -->` came out as
     * *code* (so a comment counted as a hit) and a fenced block's ``` opened a
     * template that swallowed the rest of the file. Neither guess was acceptable.
     */
    const hits = findTokensOutsideComments(raw, INTERNAL_PROCESS_PATTERNS, {
      language: file.endsWith(".md") ? "markdown" : "js",
    });

    let counted = 0;
    for (const hit of hits) {
      /*
       * RegExp literals are reported by the scanner but tolerated here.
       *
       * The gate's own pattern definitions live in RegExp literals, and a
       * scanner must contain what it searches for. That tolerance is narrow and
       * mechanical, which is the point: it covers exactly the shape a pattern
       * definition takes, and nothing a program could return to a user.
       */
      if (hit.where === "regexp") continue;
      counted += 1;
    }

    /*
     * The allowance is a ceiling, not a target.
     *
     * Exceeding it means the file gained a reference nobody reviewed. Coming in
     * under it is fine — that happens whenever a comment is reworded — but the
     * count is reported so a reviewer can see the headroom shrinking.
     */
    if (counted > allowance.max) {
      violations.push({
        file,
        category:
          `${counted} internal-process token occurrence(s) exceed the allowance of ` +
          `${allowance.max} (${allowance.why}) — a new reference arrived without review`,
      });
    }
  }

  for (const file of TEXT_FILES) {
    if (TOKEN_ALLOWANCES.has(file)) continue;
    const text = readText(file);

    /*
     * The main scan is structural too (follow-through).
     *
     * It previously applied `pattern.test(text)` to the raw file. That has two
     * defects the exemption proof had already been fixed for:
     *
     *   1. A token inside a comment counted as a violation. Comments are how code
     *      explains *which* shapes are forbidden, so the un-comment-aware version
     *      punished the documentation it depends on — and a guard that fires on
     *      correct code gets switched off.
     *   2. It could not distinguish a token in a string from a token in code, so
     *      the classifier's work was only used for the allowance files.
     *
     * Both scans now use the same structural reader, with the language chosen by
     * extension. `regexp` is still tolerated here for the same narrow reason as in
     * the allowance loop: pattern definitions must contain the shapes they match.
     */
    const language = file.endsWith(".md") ? "markdown" : "js";
    const hits = findTokensOutsideComments(text, INTERNAL_PROCESS_PATTERNS, { language });

    for (const hit of hits) {
      if (hit.where === "regexp") continue;
      violations.push({ file, category: `${hit.category} (found in ${hit.where})` });
    }
  }
  record("internal-process", "no internal workflow tokens", violations);
}

// ------------------------------------------------------------- 9. attribution

{
  const required = [
    ["README.md", "readme"],
    ["SECURITY.md", "security policy"],
    ["CONTRIBUTING.md", "contribution guide"],
    ["THIRD-PARTY-NOTICES.md", "third-party licence notices"],
    [".env.example", "configuration template"],
    /*
     * `LICENSE` is now required, not forbidden. It is listed here as well as
     * checked below so that its membership is verified the same way as every
     * other required file: present in the index, present in HEAD, not staged for
     * deletion. A LICENSE that exists on disk but is untracked would leave every
     * clone without a licence — the same false-green class as `.env.example`.
     */
    ["LICENSE", "licence text"],
  ];
  const violations = [];

  /*
   * ── "Present" must mean present in the *release*, not on this disk ──
   *
   * The previous version of this check called `existsSync`. That made it blind
   * to the single most consequential difference between a development tree and
   * a published one, and it produced a false green on this very repository:
   * `.env.example` existed on disk, a `.gitignore` rule (`.env*`) kept it out of
   * the index, and the gate reported PASS while every fresh clone was missing the
   * file the README tells the reader to copy. The first CI run after publication
   * would have gone red, and the gate that was supposed to catch that had
   * already said yes.
   *
   * So the question is asked of Git, not of the filesystem. Three states are
   * distinguished because they are three different failures:
   *
   *   absent from index  → it will not be published at all
   *   staged deletion   → it is being removed by the commit under review
   *   not in HEAD       → the commit that will be pushed does not contain it
   *
   * Every project tree here is a Git repository, and the synthetic trees the
   * negative controls build are initialised as repositories for exactly this
   * reason. A tree with no Git index at all cannot answer the question, so it is
   * reported as unverified rather than waved through — "I could not check" must
   * never read as "it passed".
   */
  const git = (args) => {
    try {
      return {
        ok: true,
        out: execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
      };
    } catch (error) {
      return { ok: false, out: "", stderr: String(error.stderr ?? ""), status: error.status ?? 1 };
    }
  };

  const isRepository = git(["rev-parse", "--git-dir"]).ok;

  /** Paths currently in the index (staged content of the next commit). */
  let indexPaths = null;
  if (isRepository) {
    const listed = git(["ls-files", "-z"]);
    if (listed.ok) {
      indexPaths = new Set(listed.out.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")));
    }
  }

  /** Paths in the committed tree, or null when there is no commit yet. */
  let headPaths = null;
  if (isRepository) {
    const listed = git(["ls-tree", "-r", "--name-only", "-z", "HEAD"]);
    if (listed.ok) {
      headPaths = new Set(listed.out.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")));
    }
  }

  /** Files present in the index but scheduled for deletion. */
  let stagedDeletions = new Set();
  if (isRepository) {
    /*
     * `--diff-filter=D --cached` compares HEAD with the index: a path listed
     * here exists in HEAD and has been removed from the staged snapshot. That is
     * precisely "the release candidate is dropping a file it still needs".
     */
    const deleted = git(["diff", "--cached", "--name-only", "--diff-filter=D", "-z", "HEAD"]);
    if (deleted.ok) {
      stagedDeletions = new Set(deleted.out.split("\0").filter(Boolean).map((p) => p.replace(/\\/g, "/")));
    }
  }

  for (const [file, description] of required) {
    const onDisk = existsSync(join(ROOT, file));

    if (!isRepository) {
      violations.push({
        file,
        category: `cannot verify ${description}: the tree is not a Git repository, so its public membership is unknowable`,
      });
      continue;
    }

    if (stagedDeletions.has(file)) {
      violations.push({
        file,
        category: `${description} is staged for deletion — the release candidate would drop it`,
      });
      continue;
    }

    if (indexPaths !== null && !indexPaths.has(file)) {
      violations.push({
        file,
        category: onDisk
          ? `missing ${description}: the file exists on disk but is NOT tracked, so a clone would not receive it`
          : `missing ${description}: not present on disk and not tracked`,
      });
      continue;
    }

    /*
     * An index entry is necessary but not sufficient: the commit that actually
     * gets pushed is HEAD, and a release built from HEAD rather than from the
     * index would not carry a newly staged file. Checked only when a commit
     * exists, because the pre-commit state legitimately has none.
     */
    if (headPaths !== null && !headPaths.has(file)) {
      violations.push({
        file,
        category: `missing ${description}: tracked in the index but absent from HEAD — commit it before release`,
      });
      continue;
    }

    if (!onDisk) {
      /*
       * Indexed and committed but not checked out: not a release defect (the
       * published tree is HEAD, not this working directory), yet it means the
       * content checks below cannot run, which would make them vacuous.
       */
      violations.push({
        file,
        category: `${description} is committed but not present on disk — content checks would be vacuous`,
      });
    }
  }

  /*
   * `.env.example` must contain placeholders only. A value that looks real is
   * how a template becomes a leak — this catches the case where someone fills
   * one in "just for testing" and commits it.
   */
  const envExample = readText(".env.example");
  if (envExample !== "") {
    for (const line of envExample.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "" || trimmed.startsWith("#")) continue;
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(trimmed);
      if (match === null) continue;
      const [, name, value] = match;
      if (value !== "" && !/^(?:\.\/|\.\.\/|[0-9]+$|1$|eligible$|http:\/\/127\.0\.0\.1)/.test(value)) {
        violations.push({
          file: ".env.example",
          category: `${name} has a non-placeholder value`,
        });
      }
    }
  }

  /*
   * ── Licence: `LICENSE` must exist, be genuine MIT, and agree with every
   *    document that makes a licensing claim ──
   *
   * The previous version of this check asserted the **absence** of a licence
   * ("no open-source licence has been granted yet"). That is now the wrong
   * direction: the project ships MIT. The assertion was *inverted*, not deleted —
   * deleting it would silently stop checking the most consequential legal fact
   * in the tree.
   *
   * Four independent failures are checked, because they fail separately:
   *
   *   1. `LICENSE` missing entirely — the README would then claim a grant the
   *      tree does not carry.
   *   2. `LICENSE` present but not MIT (a different licence under an MIT heading,
   *      or an edited body) — identified by clauses unique to MIT, not by title.
   *   3. Documents disagreeing — README, CONTRIBUTING and `package.json` must all
   *      name the same licence. A per-document check passed while the probe's
   *      CONTRIBUTING still said "not yet decided"; that is why they are now
   *      compared *to each other*.
   *   4. The MIT grant being extended over material the project does not own —
   *      third-party dependencies and study content must still be carved out.
   */
  const readme = readText("README.md");
  /*
   * Markdown emphasis is presentation, not meaning. Strip it before judging
   * sentences about licence status so `**not** covered` reads as `not covered`.
   */
  const readmePlain = readme.replace(/\*\*|__|`/g, "");
  const licenceText = readText("LICENSE");
  const contributing = readText("CONTRIBUTING.md");
  const notices = readText("THIRD-PARTY-NOTICES.md");
  const pkg = JSON.parse(readText("package.json"));

  const LICENCE_SPDX = "MIT";

  if (licenceText === "") {
    violations.push({
      file: "LICENSE",
      category: "missing licence text — the README claims a grant the tree does not carry",
    });
  } else {
    /*
     * MIT's clauses wrap across lines in the canonical text ("IN NO / EVENT SHALL
     * THE AUTHORS…"), so every marker is matched against a whitespace-collapsed
     * copy. Matching the raw text produced a false failure on a byte-exact copy of
     * the official file — a check that rejects the very artefact it should accept
     * is worse than no check, because it gets disabled.
     */
    const licenceCompact = licenceText.replace(/\s+/g, " ");
    /*
     * Match MIT by its operative clauses, not by its title: a file headed "MIT
     * License" whose body grants something else must not pass. Each marker is a
     * phrase MIT contains that distinguishes it from other common licences.
     */
    const markers = [
      [/Permission is hereby granted, free of charge/, "permission grant"],
      [/to any person obtaining a copy/i, "recipient scope"],
      [/The above copyright notice and this permission notice shall be included/i, "notice-retention condition"],
      [/THE SOFTWARE IS PROVIDED "AS IS"/, "warranty disclaimer"],
      [/WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED/i, "disclaimer scope"],
      [/NONINFRINGEMENT/i, "noninfringement clause"],
      [/IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE/i, "liability limitation"],
      [/arising from, out of or in connection with the software/i, "scope of liability"],
    ];
    for (const [pattern, label] of markers) {
      if (!pattern.test(licenceCompact)) {
        violations.push({
          file: "LICENSE",
          category: `not the MIT text — missing ${label}`,
        });
      }
    }

    /*
     * A copyleft or noncommercial term inside an supposedly-MIT file is a
     * contradiction, not a variant. Checked explicitly because such a file would
     * still satisfy every marker above if the terms were appended.
     */
    if (/\b(?:GNU General Public License|GNU Affero|Affero General Public|Noncommercial|NonCommercial|MPL-2\.0|Mozilla Public License)\b/.test(licenceText)) {
      violations.push({
        file: "LICENSE",
        category: "carries copyleft or noncommercial terms alongside MIT — contradictory grant",
      });
    }

    /*
     * The copyright line must name a holder. An MIT file with a blank or
     * placeholder holder grants rights that cannot be attributed, and the notice
     * retention condition refers to a notice that does not exist.
     *
     * `[^\S\n]+` rather than `\s+`: the holder must be on the *same line* as
     * `Copyright (c)`. Allowing newlines made `Copyright (c)` followed by a blank
     * line capture the next paragraph ("Permission is hereby granted…") as the
     * holder — a false negative that let a nameless grant pass.
     */
    const holder = /Copyright[^\S\n]*\(c\)[^\S\n]*([^ \n][^\n]*)/i.exec(licenceText);
    if (holder === null) {
      violations.push({ file: "LICENSE", category: "no copyright holder line" });
    } else {
      const value = holder[1].trim();
      if (value === "" || /<[^>]*>|\bplaceholder\b|\byear\b|\bholders?\b/i.test(value)) {
        violations.push({
          file: "LICENSE",
          category: "copyright holder line is a placeholder rather than a named holder",
        });
      }
    }
  }

  /* ── Cross-document agreement ── */
  for (const [file, text] of [
    ["README.md", readme],
    ["CONTRIBUTING.md", contributing],
  ]) {
    if (!/\bMIT\b/.test(text)) {
      violations.push({ file, category: "does not name the licence that LICENSE carries" });
    }
    /*
     * A stale "not decided / not yet selected" sentence directly contradicts a
     * shipped LICENSE. Matched on meaning rather than one exact string, so a
     * reworded version is still caught.
     */
    if (/(?:licen[cs]e)[^.\n]{0,40}(?:not\s+(?:yet\s+)?(?:been\s+)?(?:decided|selected|chosen))|(?:not\s+yet\s+decided)/i.test(text)) {
      violations.push({
        file,
        category: "still describes the licence as undecided, contradicting LICENSE",
      });
    }
  }
  if (!/inbound\s*=\s*outbound|may be distributed under the MIT|under the same licen[cs]e|under the MIT License/i.test(contributing)) {
    violations.push({
      file: "CONTRIBUTING.md",
      category: "does not state that contributions are distributed under the project licence (inbound = outbound)",
    });
  }
  if (pkg.license !== LICENCE_SPDX) {
    violations.push({
      file: "package.json",
      category: `license field is ${JSON.stringify(pkg.license)} — expected ${JSON.stringify(LICENCE_SPDX)} to match LICENSE`,
    });
  }

  /*
   * ── The grant must not be extended over what the project does not own ──
   *
   * MIT covers this project's code. Dependencies keep their own terms, and exam
   * papers / course material are not the project's to license. Both carve-outs
   * must be present and explicit; silence would read as "the MIT grant covers
   * everything here too".
   */
  if (notices === "") {
    violations.push({
      file: "THIRD-PARTY-NOTICES.md",
      category: "missing third-party notices — dependency licences are not the project's to relicense",
    });
  } else {
    if (!/dependenc/i.test(notices)) {
      violations.push({
        file: "THIRD-PARTY-NOTICES.md",
        category: "does not record the dependency licence inventory the MIT grant cannot override",
      });
    }
    if (!/does not (?:relicense|rellicen[cs]e|cover)|cannot be overridden|survive/i.test(notices)) {
      violations.push({
        file: "THIRD-PARTY-NOTICES.md",
        category: "does not state that the project licence does not relicense third-party dependencies",
      });
    }
  }
  /*
   * The carve-out sentence wraps across lines too, so it is matched against a
   * whitespace-collapsed copy for the same reason as the MIT markers: a check
   * that fails on the correct wording is a check that gets switched off.
   */
  const readmeCompact = readmePlain.replace(/\s+/g, " ");
  if (
    !/(?:examination papers|exam papers|past papers|course material|study content)[^.]{0,120}not (?:included|covered|licen[cs]ed)/i.test(
      readmeCompact,
    ) &&
    !/not (?:included|covered|licen[cs]ed)[^.]{0,120}(?:examination papers|exam papers|past papers|course material|study content)/i.test(
      readmeCompact,
    )
  ) {
    violations.push({
      file: "README.md",
      category: "does not carve exam papers / course material out of the MIT grant",
    });
  }

  record("attribution", "required legal and configuration files present, placeholder-only, licence status documented", violations);
}

// ------------------------------------------------------ 10. content-root absence

{
  /*
   * The strongest statement available: the study-content directory must not
   * exist at all in a public tree. Not "should be ignored" — absent. If it is
   * present, something copied it in, and `.gitignore` will not save anyone who
   * builds a release from the directory rather than from git.
   */
  const violations = [];
  for (const name of ["private-content", "companion-content", "loopback-proof-content"]) {
    if (existsSync(join(ROOT, name))) {
      violations.push({ file: name, category: "study-content directory is present" });
    }
  }
  record("content-root-absence", "no study-content directory in the tree", violations);
}

// ------------------------------------------- 11. internal workspace paths

/**
 * Absolute paths belonging to the machine that built this snapshot.
 *
 * ── Why this is a separate check, and why it is not section 2 ──
 *
 * Section 2 audits **filenames** for drive letters and user-profile folders. It
 * cannot see a path written inside a *file*, and that is where this defect
 * actually occurred: a build tool's comment, a sanitiser fixture and a test
 * comment each quoted the staging directory of the authoring machine.
 *
 * The pre-existing structural check in `audit-object-database.mjs` did scan
 * object *contents*, but only for **user-home** shapes (`<drive>:\Users\…`,
 * `/home/…`). A workspace directory is not a user home, so four real
 * disclosures passed both gates. The detector is now shared
 * (`tools/workspace-path-scan.mjs`) and decides from structure rather than from
 * a list of names — see that file for the three rules and the allowance table.
 *
 * ── Why findings do not quote the path ──
 *
 * A CI log is as public as the repository. Printing the matched text would move
 * the disclosure into the log rather than remove it from the tree, so each
 * finding is reported by file, line, shape and a **normalised** prefix only.
 */
{
  const violations = [];
  let examined = 0;
  let withContent = 0;

  /*
   * The comment syntax of a file does not change whether a path in it is public,
   * so every text file is scanned whole. There is deliberately no filename skip
   * list: exempting tests is precisely how a leak survives, because a test file
   * is published exactly like any other.
   */
  for (const file of TEXT_FILES) {
    examined += 1;
    const text = readText(file);
    if (text === "") continue;
    withContent += 1;

    /*
     * POSIX roots are supplied explicitly because a POSIX path has no syntactic
     * marker separating `/home/<name>/project` from `/api/courses`. Only roots
     * that are machine-specific on this platform are passed; application routes
     * are therefore green by construction rather than by exception.
     */
    const findings = findInternalWorkspacePaths(text, {
      posixRoots: ["/home", "/Users", "/srv", "/opt", "/var/builds"],
    });

    for (const finding of findings) {
      violations.push({ file, category: describeFinding(finding) });
    }
  }

  /*
   * A scan that read nothing would pass silently, so the gate must fail closed on
   * an empty scope — the same discipline the other checks use.
   *
   * The guard is **relative, not absolute**: it asserts that every text file the
   * tree actually contains was examined. A fixed "at least N files" floor was
   * tried first and rejected, because it turned a legitimate control red: the
   * token-scanner's synthetic tree deliberately contains only a couple of dozen
   * files, and a floor of 50 made *that* control fail for a reason unrelated to
   * the token it was testing. A scope check must describe this tree, not a
   * particular size of tree.
   */
  if (TEXT_FILES.length === 0) {
    violations.push({
      file: "tools/public-release-check.mjs",
      category: "no text files were discovered — the check would be vacuous",
    });
  } else if (examined !== TEXT_FILES.length) {
    violations.push({
      file: "tools/public-release-check.mjs",
      category: `examined ${examined} of ${TEXT_FILES.length} text file(s) — some were skipped`,
    });
  } else if (withContent === 0) {
    violations.push({
      file: "tools/public-release-check.mjs",
      category: "every text file read as empty — the check would be vacuous",
    });
  }

  record(
    "workspace-paths",
    "no absolute local-workspace path in any text file",
    violations,
    `${withContent} text file(s)`,
  );
}

// --------------------------------------------------------------------- output

const failures = results.filter((result) => !result.ok);

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ root: ROOT, ok: failures.length === 0, results }, null, 2));
} else {
  console.log(`public release check — ${ROOT}\n`);
  for (const result of results) {
    const mark = result.ok ? "PASS" : "FAIL";
    const note = result.note === "" ? "" : `  (${result.note})`;
    console.log(`[${mark}] ${result.title}${note}`);
    for (const violation of result.violations.slice(0, 20)) {
      console.log(`         ${violation.file}: ${violation.category}`);
    }
    if (result.violations.length > 20) {
      console.log(`         ... and ${result.violations.length - 20} more`);
    }
  }
  console.log("");
  console.log(
    failures.length === 0
      ? `all ${results.length} checks passed`
      : `${failures.length} of ${results.length} checks FAILED`,
  );
}

process.exit(failures.length === 0 ? 0 : 1);
