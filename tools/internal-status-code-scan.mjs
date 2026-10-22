/**
 * Internal **status-code** detection for public Git metadata.
 *
 * ── The defect this closes ──
 *
 * A merged pull request's body carried an internal acceptance code of the form
 * `PROJECT_STAGE_INDEPENDENT_REVIEW_PASS` — an all-caps, underscore-joined token
 * that encodes a private workflow's state machine. It was in a *merge commit
 * message*, which is public, permanent, and copied into every clone.
 *
 * Every existing rule missed it, and the reason is structural rather than an
 * oversight in any one rule. The rules in `audit-history.mjs` and
 * `public-release-check.mjs` all match **space-separated attribution**:
 *
 *   `<role> review round <n>`      spaces between words
 *   `reviewed by <Name>`           spaces between words
 *   `<ROLE> PASS`                  a single space before the verdict
 *
 * The leaked token had no spaces at all. It was one identifier:
 * underscores, one token, no attribution grammar to hook onto. So the whole
 * family — "a run of capitalised words joined by underscores, ending in a verdict
 * or status word" — was invisible.
 *
 * ── Why the rule cannot simply be "any uppercase snake token" ──
 *
 * The tree legitimately contains hundreds of them: `E2E_A3_CONTENT_ROOT`,
 * `COURSE_MANIFEST_SCHEMA_VERSION`, `MAX_INLINE_BYTES`. They are exported
 * constants, environment variable names and schema keys. A rule that rejected
 * them would make every run red, and a gate that is always red is a gate that has
 * been switched off — the same failure mode the repository already documents for
 * its path checks.
 *
 * So the rule keys on **what makes the leaked token different from a constant
 * name**: it ends in a *verdict* or *process-state* word. A constant describes a
 * value (`..._VERSION`, `..._PATH`, `..._ROOT`); a status code asserts an
 * outcome (`..._PASS`, `..._APPROVED`, `..._SIGNED_OFF`). That is the boundary
 * this module encodes, and it is stated as an explicit word list rather than a
 * vague heuristic so a reader can audit it.
 *
 * ── False positives are a first-class concern ──
 *
 * `MAX_KEEP_ALIVE` and `SESSION_EXPIRED` are status-like but contain a single
 * word that is not a verdict. `ERR_MODULE_NOT_FOUND` contains `NOT_FOUND`, which
 * is a runtime error name, not a workflow verdict — it is on the allow list with
 * a reason. Every allowance is named, never a pattern.
 */

/**
 * Words that assert an outcome rather than describe a value.
 *
 * A code ending in one of these is a **verdict**, not a constant name. The list is
 * deliberately about outcomes of a *process* (review, acceptance, sign-off), so a
 * technical state name such as `NOT_FOUND` or `EXPIRED` is not included.
 */
const VERDICT_WORDS = [
  "PASS",
  "PASSED",
  "FAIL",
  "FAILED",
  "APPROVED",
  "REJECTED",
  "SIGNEDOFF",
  "SIGNED_OFF",
  "CLEARED",
  "ACCEPTED",
  "BLOCKED",
  "COMPLETE",
  "COMPLETED",
  "VERIFIED",
  "CONFIRMED",
  "GREEN",
  "RED",
];

/**
 * Status-like words that appear inside legitimate identifiers, each with a reason.
 *
 * Named individually rather than pattern-matched: an allowance a reader cannot see
 * is indistinguishable from a hole.
 */
export const ALLOWED_STATUS_CODES = new Map([
  ["ERR_MODULE_NOT_FOUND", "Node.js runtime error code, not a workflow verdict"],
  ["ERR_INVALID_ARG_TYPE", "Node.js runtime error code"],
  ["ERR_ASSERTION", "Node.js runtime error code"],
  ["SUPABASE_SERVICE_ROLE_KEY_ENABLED", "environment flag name: describes configuration"],
  ["TELEMETRY_KEY_ENABLED", "environment flag name: describes configuration"],
  ["NEXT_TELEMETRY_DISABLED", "environment variable name published by Next.js"],
  ["CI_GREEN", "no current occurrence; listed so a future one is reviewed deliberately"],
]);

/**
 * An uppercase token of at least three segments joined by underscores, ending in
 * a verdict word.
 *
 * Segment shape: `[A-Z][A-Z0-9]*`. Requiring **three** segments is what separates
 * `PR3_INDEPENDENT_REVIEW_PASS` (an internal status code) from two-segment
 * identifiers such as `CI_GREEN` or `NOT_GREEN`, which are ordinary flags.
 */
const STATUS_CODE_PATTERN = new RegExp(
  `\\b(?:[A-Z][A-Z0-9]*_)+(${VERDICT_WORDS.join("|")})\\b`,
  "g",
);

/**
 * Find internal status codes in a text.
 *
 * @param {string} text
 * @param {{ allowlist?: Map<string,string> }} [options]
 * @returns {Array<{ token: string, line: number, verdict: string }>}
 */
export function findInternalStatusCodes(text, options = {}) {
  const allowlist = options.allowlist ?? ALLOWED_STATUS_CODES;
  const findings = [];
  const seen = new Set();

  for (const match of text.matchAll(STATUS_CODE_PATTERN)) {
    const token = match[0];

    /*
     * Three or more segments: `A_B_PASS` is a status code; `A_PASS` is a flag.
     * Counted on the *token*, not the match, because the verdict word may itself
     * contain an underscore (`SIGNED_OFF`).
     */
    const segments = token.split("_").length;
    if (segments < 3) continue;

    if (allowlist.has(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);

    findings.push({
      token,
      index: match.index,
      line: text.slice(0, match.index).split("\n").length,
      verdict: match[1],
    });
  }

  return findings;
}

/**
 * Render a finding **without** echoing the full token.
 *
 * The same reason every other scanner in this repository confines its output: a CI
 * log is as public as the repository. Printing the whole code would move the
 * disclosure into the log rather than removing it. The leading project segment is
 * dropped and the verdict is kept, which is enough to locate the line.
 *
 * @param {{ token: string, line: number, verdict: string }} finding
 * @returns {string}
 */
export function describeStatusCodeFinding(finding) {
  const segments = finding.token.split("_");
  const shape = ["<PROJECT>", ...segments.slice(1, -1), segments.at(-1)].join("_");
  return `line ${finding.line}: internal status code (${shape})`;
}
