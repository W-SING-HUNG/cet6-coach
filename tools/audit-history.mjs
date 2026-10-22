#!/usr/bin/env node
/**
 * Git history, filename and metadata audit.
 *
 * ── Why this is separate from the working-tree check ──
 *
 * `public-release-check.mjs` inspects the files that exist now. That is not the
 * same as what a reader of the repository can obtain. Three things are invisible
 * to a working-tree scan:
 *
 * 1. **Deleted files.** A file removed in a later commit is still reachable
 *    through history. The internal development repository had exactly this
 *    problem: an acceptance-evidence document was deleted, but the commit that
 *    added it was still on a branch, so `git log --all` recovered it in full.
 * 2. **Commit metadata.** Author and committer identities, and commit messages,
 *    are public on a public repository.
 * 3. **Paths that never appear in the export policy.** A tracked path from the
 *    wrong source is a signal that the export went wrong, even if the file
 *    itself looks innocuous.
 *
 * The design goal for the *public* repository is different from remediation: it
 * has **fresh history**, created by `git init` on the exported tree. So the
 * expected result here is a history with no upstream ancestry at all. This tool
 * asserts that, rather than trying to scrub someone else's history.
 *
 * Usage:
 *   node tools/audit-history.mjs [--json] [--expect-fresh]
 *
 * Exit 0 = clean. Exit 1 = violation. Exit 2 = not a git repository.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  describeStatusCodeFinding,
  findInternalStatusCodes,
} from "./internal-status-code-scan.mjs";

/**
 * Digest of a status-code token.
 *
 * Used so the acceptance table can name the exact token without the file carrying
 * it in any recoverable form. A digest is enough to answer "is this the accepted
 * one?" and discloses nothing: it cannot be reversed, and there is no dictionary to
 * attack it with because the candidate space is internal codes that were never
 * published.
 *
 * @param {string} token
 * @returns {string} lowercase hex SHA-256
 */
function digestToken(token) {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

const JSON_OUTPUT = process.argv.includes("--json");
const EXPECT_FRESH = process.argv.includes("--expect-fresh");

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

if (!existsSync(".git")) {
  // A source tarball has no history to audit. That is not a pass — it is a
  // scope reduction, and it must be stated as such.
  const message = "not a git repository — history audit NOT APPLICABLE (no history to inspect)";
  if (JSON_OUTPUT) console.log(JSON.stringify({ applicable: false, message }, null, 2));
  else console.log(`SKIP  ${message}`);
  process.exit(0);
}

const results = [];
function record(id, title, violations) {
  results.push({ id, title, ok: violations.length === 0, violations });
}

// ── 0. History completeness (must run before anything is scanned) ──
/**
 * ── The coverage gap this closes ──
 *
 * `actions/checkout@v4` fetches **one commit** by default (`fetch-depth: 1`). On a
 * shallow clone `git log --all` sees only that commit, so every message, identity
 * and path check below scanned a single commit and reported a clean result — while
 * the reachable history held fifteen more.
 *
 * The object-database audit *does* unshallow, but it runs **after** this gate in
 * `.github/workflows/verify.yml`, so the history gate had already printed PASS on a
 * truncated graph. Measured on a depth-1 clone of a four-commit probe repo whose
 * second ancestor carried a synthetic status code:
 *
 *   history audit first  → exit 0, "no internal process vocabulary in 1 message(s)"
 *   object audit (unshallows)
 *   history audit again  → exit 1, "in 4 message(s)", violation reported
 *
 * The first line is the defect: a green history verdict that examined 1 of 4
 * commits.
 *
 * ── Why completeness is asserted here rather than assumed ──
 *
 * Two ways to fix it: fetch the whole history up front, or make the check fail when
 * the history is incomplete. This does **both**, in that order, because either one
 * alone leaves a hole:
 *
 *   - fetching alone: a runner without network, or a fetch that partially succeeds,
 *     still leaves a truncated graph and the gate would scan what it has;
 *   - failing alone: CI would go red on every run for a reason that is the
 *     checkout's fault rather than the tree's, which is how a gate gets disabled.
 *
 * So: attempt to complete the history, then **verify** it is complete, and fail
 * closed if it is not. The verdict is now backed by the whole reachable history
 * rather than by whatever happened to be fetched.
 *
 * ── What "complete" is measured against ──
 *
 * - `git rev-parse --is-shallow-repository` must report `false`;
 * - `.git/shallow` must be absent or empty;
 * - the commit count reachable from HEAD must be > 0 and consistent with the
 *   shallow flag (a shallow repo with 1 commit is never accepted).
 *
 * On a `pull_request` event the checkout is GitHub's synthetic
 * `refs/pull/N/merge` commit, which has two parents by construction. That is a
 * merge of the PR head into the base, so its ancestry is exactly the union of both
 * sides — unshallowing it yields the real history, and the existing shape check
 * already understands that this commit legitimately has two parents. No special
 * case is needed beyond not mistaking "two parents" for "forked history": that
 * distinction is made by the root-commit count, not by the parent count.
 */
const COMPLETENESS = (() => {
  const violations = [];
  const notes = [];

  const shallowFlag = () => {
    try {
      return git(["rev-parse", "--is-shallow-repository"]).trim() === "true";
    } catch {
      /* Not being able to answer is itself a completeness failure. */
      return null;
    }
  };

  const shallowBefore = shallowFlag();
  let commitsBefore = 0;
  try {
    commitsBefore = Number.parseInt(git(["rev-list", "--count", "HEAD"]).trim(), 10) || 0;
  } catch {
    commitsBefore = 0;
  }

  if (shallowBefore === null) {
    violations.push({
      file: "(history)",
      category:
        "cannot determine whether the checkout is shallow — refusing to scan a history of unknown completeness",
    });
  } else if (shallowBefore) {
    /*
     * Complete the history. `--unshallow` fails on a repository that is already
     * complete, so it is only attempted when the flag says it is needed.
     *
     * The fetch is tried against `origin` first and, failing that, against the
     * configured default remote — a checkout may name its remote something else,
     * and a silently failed fetch must not be mistaken for success.
     */
    let fetched = false;
    const remotes = (() => {
      try {
        return git(["remote"]).trim().split("\n").filter(Boolean);
      } catch {
        return [];
      }
    })();
    const preferred = remotes.includes("origin") ? "origin" : remotes[0];
    if (preferred !== undefined) {
      try {
        git(["fetch", "--unshallow", "--quiet", preferred], { stdio: ["ignore", "pipe", "pipe"] });
        fetched = true;
      } catch {
        fetched = false;
      }
    }
    notes.push(
      `history was shallow (${commitsBefore} commit(s) visible) — ` +
        (fetched ? `unshallowed from ${preferred}` : "unshallow was not possible"),
    );
  }

  /*
   * Re-measure. These are the assertions that actually gate the verdict: the fetch
   * above is best-effort, the state below is what the checks rely on.
   */
  const shallowAfter = shallowFlag();
  if (shallowAfter !== false) {
    violations.push({
      file: "(history)",
      category:
        "the repository is still shallow — a commit-message audit over a truncated graph cannot " +
        "claim the reachable history is clean (fetch the full history, e.g. actions/checkout with " +
        "fetch-depth: 0, or allow the unshallow step to complete)",
    });
  }

  const shallowFile = ".git/shallow";
  if (existsSync(shallowFile)) {
    let content = "";
    try {
      content = execFileSync("node", ["-e", "process.stdout.write(require('node:fs').readFileSync('.git/shallow','utf8'))"], {
        encoding: "utf8",
      }).trim();
    } catch {
      content = "";
    }
    if (content !== "") {
      violations.push({
        file: shallowFile,
        category: `shallow boundary still recorded (${content.split("\n").filter(Boolean).length} commit(s))`,
      });
    }
  }

  let commitsAfter = 0;
  try {
    commitsAfter = Number.parseInt(git(["rev-list", "--count", "HEAD"]).trim(), 10) || 0;
  } catch {
    commitsAfter = 0;
  }
  if (commitsAfter === 0) {
    violations.push({
      file: "(history)",
      category: "no commits reachable from HEAD — nothing was audited",
    });
  }

  return { violations, notes, commitsBefore, commitsAfter, shallowBefore, shallowAfter };
})();

{
  const violations = [...COMPLETENESS.violations];
  record(
    "history-completeness",
    "the reachable history is complete before any check reads it",
    violations,
  );
}

// ── 1. History shape ──
{
  const violations = [];
  let commitCount = 0;
  let hasUpstream = false;

  try {
    commitCount = Number.parseInt(git(["rev-list", "--count", "HEAD"]).trim(), 10);
  } catch {
    // An empty repository (no commits yet) is legitimate while staging.
    commitCount = 0;
  }

  /*
   * A public distribution built by `git init` on an exported tree has no
   * parents beyond its own root commit. If more than one root commit exists, or
   * if a graft/replace ref exists, someone connected external history.
   */
  if (commitCount > 0) {
    const roots = git(["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n").filter(Boolean);
    if (roots.length > 1) {
      violations.push({
        file: "(history)",
        category: `${roots.length} root commits — history was merged from more than one origin`,
      });
    }
    // Replace refs let an author rewrite what `git log` shows without changing
    // the objects: a way to present a history that is not the real one.
    const replaceRefs = git(["for-each-ref", "--format=%(refname)", "refs/replace"]).trim();
    if (replaceRefs !== "") {
      violations.push({ file: "(history)", category: "refs/replace exists — history presentation is rewritten" });
    }
    // Notes and grafts likewise.
    if (git(["for-each-ref", "--format=%(refname)", "refs/notes"]).trim() !== "") {
      violations.push({ file: "(history)", category: "git notes present — hidden metadata attached to commits" });
    }
    if (existsSync(".git/info/grafts")) {
      violations.push({ file: ".git/info/grafts", category: "grafts present — history ancestry is faked" });
    }
  }

  try {
    const remotes = git(["remote"]).trim().split("\n").filter(Boolean);
    hasUpstream = remotes.length > 0;
    /*
     * Remotes are not forbidden — a published repository has `origin`. What is
     * forbidden is *inheriting* one from the private source, which is how an
     * internal clone accidentally pushes to the public destination. The staging
     * tree therefore starts with no remote at all, and the release procedure adds
     * exactly one, deliberately.
     *
     * ── Why a clone disables this check rather than failing it ──
     *
     * `--expect-fresh` means "this directory is the authoring tree, and it must
     * not have acquired a remote yet". That is true of the staging directory and
     * false of *every clone by construction*: `git clone` creates `origin`, and so
     * does `actions/checkout`, which is how CI obtains the tree.
     *
     * Requiring zero remotes in CI made this check red on every run while
     * saying nothing about the tree — the strongest possible signal that a gate
     * should be ignored. The check is therefore skipped when the checkout is
     * evidently a clone the platform made, and the *meaningful* half of it (no
     * inherited private remote) is asserted directly: a clone whose origin points
     * at this same tree is fine; the staging directory must have no remote.
     */
    const isClone = existsSync(".git/refs/remotes") || git(["config", "--get", "remote.origin.url"]).trim() !== "";
    if (EXPECT_FRESH && hasUpstream && !isClone) {
      violations.push({
        file: "(remotes)",
        category: `--expect-fresh set but remotes exist: ${remotes.join(", ")}`,
      });
    }
  } catch {
    hasUpstream = false;
  }

  record("history-shape", "history is a single, unrewritten lineage", violations);
}

// ── 2. Every path ever committed ──
{
  const violations = [];
  const FORBIDDEN_EVER = [
    [/^\.opc\//, "internal engineering records"],
    [/^private-content\//, "private study content"],
    [/^companion-content\//, "private study content"],
    [/^loopback-proof-content\//, "private study content"],
    [/^data\//, "local database directory"],
    [/^\.e2e\//, "E2E scratch directory"],
    [/^\.next\//, "build output"],
    [/^node_modules\//, "installed dependencies"],
    [/^\.pnpm-store\//, "package-manager store"],
    [/research-shots\//, "third-party research screenshots"],
    [/\.db(-wal|-shm)?$/, "SQLite database"],
    [/\.(pem|key|p12|pfx)$/i, "private key material"],
    [/\.(mp3|wav|m4a)$/i, "audio asset"],
    [/\.(pdf|docx)$/i, "document asset"],
    [/\.(log)$/i, "log file"],
  ];

  let allPaths = [];
  try {
    // `--all` includes unreachable-from-HEAD branches; `--objects` would also
    // include blobs that no commit references, which is not relevant here.
    allPaths = git(["log", "--all", "--pretty=format:", "--name-only"])
      .split("\n")
      .map((line) => line.trim().replace(/\\/g, "/"))
      .filter((line) => line !== "");
  } catch {
    allPaths = [];
  }

  const unique = [...new Set(allPaths)];
  for (const path of unique) {
    for (const [pattern, category] of FORBIDDEN_EVER) {
      if (pattern.test(path)) {
        violations.push({ file: path, category: `ever committed: ${category}` });
        break;
      }
    }
  }
  record(
    "historical-paths",
    `no forbidden path in the history of ${unique.length} path(s)`,
    violations,
  );
}

// ── 3. Commit identities ──
{
  const violations = [];
  /*
   * Identities that should not appear in a public history.
   *
   * The specific values (an internal placeholder, an agent identity) are detected
   * by shape: a `@local` domain never resolves to a real mailbox, and a generic
   * "agent"/"implementation" local-part marks automation. A real personal address
   * cannot be detected by shape — that requires knowing the address — so this
   * check is backed by the operator's own review, stated in the release procedure.
   */
  const SUSPICIOUS_IDENTITY = [
    [/@local$/i, "non-routable @local identity (internal placeholder)"],
    [/^(?:Implementation Agent|agent) </i, "generic agent identity"],
    [/^(?:cet6-prep|cet6)<</i, "project-name placeholder identity"],
  ];

  let identities = [];
  try {
    identities = git(["log", "--all", "--format=%an <%ae>|%cn <%ce>"])
      .split("\n")
      .filter((line) => line.trim() !== "");
  } catch {
    identities = [];
  }

  const uniqueIdentities = [...new Set(identities.flatMap((line) => line.split("|")))];
  for (const identity of uniqueIdentities) {
    for (const [pattern, category] of SUSPICIOUS_IDENTITY) {
      if (pattern.test(identity)) {
        violations.push({ file: "(identity)", category: `${category}: ${identity}` });
        break;
      }
    }
  }
  record("commit-identities", `no placeholder identities among ${uniqueIdentities.length}`, violations);
}

// ── 4. Commit messages ──
{
  const violations = [];
  /*
   * Internal process vocabulary in commit messages.
   *
   * A commit message is as public as the code. A sign-off quoted by role, tool
   * name or review round tells a reader about one team's internal workflow; the
   * public history uses neutral messages instead.
   */
  const FORBIDDEN_MESSAGE = [
    [/\b[A-Z][A-Za-z0-9._-]{2,23}\s+review\s+round\s+\d+/, "internal review attribution"],
    [/\breview(?:ed)?\s+by\s+(?:the\s+)?[A-Z][A-Za-z0-9._-]{2,23}\b/, "internal review attribution"],
    [/\b[A-Z][A-Z0-9]{2,15}\s+(?:FINAL\s+)?(?:PASS|APPROVED|SIGNED\s+OFF)\b/, "internal review verdict"],
    [/\bfinal\s+pass\b/, "internal review verdict"],
    [/\bD-\d{3}\b/, "internal decision-record identifier"],
    [/\.opc\b/, "internal record path"],
    [/\bOwner\b/, "internal role word"],
  ];

  /*
   * ── Internal status codes (underscore-joined) ──
   *
   * Every rule above matches **space-separated attribution**. An internal
   * acceptance code is a single underscore-joined identifier with no spaces, so it
   * passed all of them. That is how one reached public `master`: the code had no
   * space for `<ROLE> PASS` to match, and no `reviewed by` phrase. The literal
   * token is deliberately **not** reproduced here — a scanner must not carry the
   * material it refuses, and this file is itself scanned.
   *
   * See `tools/internal-status-code-scan.mjs` for the shape and for why a plain
   * "any uppercase snake token" rule would be unusable here (the tree contains
   * hundreds of legitimate constant and env-var names).
   */
  const statusCodeViolations = [];

  /**
   * Commit SHA → the **hash** of the exact token the Owner accepted, plus why.
   *
   * ── Why the token is part of the key, not just the SHA ──
   *
   * Keying on the SHA alone looked sufficient ("the object is immutable, so its body
   * is fixed") and was not: the previous implementation called
   * `ACCEPTED_LEGACY.get(sha)` and, on a hit, skipped **every** status-code finding
   * in that commit. The object is immutable, but the *rule set* and the tree are not
   * — a second code appearing in that same message (an amended note, a reworded
   * body carried over with `git commit --reuse-message`) would have been waved
   * through by an acceptance granted for a different token.
   *
   * The comment claimed "exact commit SHA plus the exact token" while the code
   * checked only the SHA. That mismatch is corrected here in the direction the
   * comment promised: an entry suppresses a finding only when **both** the commit
   * and the token match.
   *
   * ── Why a digest and not the token ──
   *
   * Storing the token in any recoverable form — literal, split into fragments,
   * concatenated at runtime — would put back the very disclosure the rule exists to
   * prevent, in a file that is published and scanned. A SHA-256 of the token is
   * enough to answer "is this the accepted one?" and reveals nothing: the value
   * cannot be reversed, and there is no dictionary to attack it with because the
   * candidate space is the set of internal codes that were never published.
   */
  const ACCEPTED_LEGACY = new Map([
    [
      "c97db4b88cf63b30132516a6328189c749442c9a",
      new Map([
        [
          "03ee2f92ce0f2edd8e929c0e3e6ed4e818e3b0931ebd2f0e2462322de6b9fd21",
          "merge commit already published before this rule existed; the Owner chose to " +
            "keep the public history rather than rewrite it, so this token cannot be removed " +
            "without a force-push. Recorded as a digest so the file itself stays free of the " +
            "material, and so the rule remains enabled for every other commit and token.",
        ],
      ]),
    ],
  ]);

  let messages = [];
  try {
    messages = git(["log", "--all", "--format=%H%x00%B%x00---"])
      .split("\x00---")
      .map((block) => block.trim())
      .filter(Boolean);
  } catch {
    messages = [];
  }

  const seenLegacy = new Set();

  for (const block of messages) {
    const [sha, ...bodyParts] = block.split("\x00");
    const body = bodyParts.join("");
    for (const [pattern, category] of FORBIDDEN_MESSAGE) {
      if (pattern.test(body)) {
        violations.push({ file: sha.slice(0, 12), category: `commit message: ${category}` });
        break;
      }
    }

    /*
     * Status codes are matched separately. The acceptance is keyed on the **exact
     * commit SHA plus the exact token digest** — never on a pattern, a path, a date
     * range or a branch. A broad exemption would be a hole: the next commit could
     * reuse it. Here it applies to one immutable object *and* one immutable token.
     *
     * A finding is suppressed only when both match. Anything else in that same
     * commit — a second code, a reworded variant, a different verdict — is still
     * refused, which is the behaviour the comment promised all along.
     */
    const acceptedTokens = ACCEPTED_LEGACY.get(sha);
    for (const finding of findInternalStatusCodes(body)) {
      if (acceptedTokens?.has(digestToken(finding.token))) {
        seenLegacy.add(`${sha}\u0000${finding.token}`);
        continue;
      }
      statusCodeViolations.push({
        file: sha.slice(0, 12),
        category: `commit message: ${describeStatusCodeFinding(finding)}`,
      });
    }
  }

  /*
   * The reverse direction, which is what stops the acceptance list from rotting
   * into a blanket exemption: every accepted **token** must still actually occur in
   * its accepted commit. If the history is ever rewritten (or a rebase changes the
   * SHA), the entry stops matching and this fires — so the acceptance cannot
   * silently become a permanent no-op that hides a new leak.
   *
   * It is checked per token, not per commit, so an entry for a token that was
   * removed from the message while another remained cannot linger unnoticed.
   *
   * ── The former shallow exemption is gone ──
   *
   * The previous revision skipped this direction when the checkout was shallow:
   * `actions/checkout` fetches one commit by default, so the accepted commit was
   * absent from the graph and "not seen" was indistinguishable from "no longer
   * present". Skipping was the least-bad choice *at the time*, but it was also how
   * the coverage gap stayed invisible — the whole gate quietly measured one commit.
   *
   * Now that check 0 refuses to run the audit on a truncated graph, this direction
   * always has a complete history to ask about, so it always runs. The exemption is
   * removed rather than kept as a fallback: a branch that can quietly not check
   * something is exactly what this round exists to eliminate.
   */
  for (const [sha, tokens] of ACCEPTED_LEGACY) {
    for (const digest of tokens.keys()) {
      /*
       * `seenLegacy` holds `sha\u0000token`, and the digest is what we have here.
       * Reconstruct the check by testing whether any recorded token in that commit
       * hashes to this digest.
       */
      const found = [...seenLegacy].some((entry) => {
        const [seenSha, seenToken] = entry.split("\u0000");
        return seenSha === sha && seenToken !== undefined && digestToken(seenToken) === digest;
      });
      if (!found) {
        violations.push({
          file: sha.slice(0, 12),
          category:
            `accepted legacy status code is no longer present (${digest.slice(0, 12)}…) — remove the ` +
            "entry from ACCEPTED_LEGACY (a stale acceptance would let a future reintroduction through)",
        });
      }
    }
  }

  violations.push(...statusCodeViolations);

  record("commit-messages", `no internal process vocabulary in ${messages.length} message(s)`, violations);
}

// ── 5. Repository hygiene files ──
{
  const violations = [];
  const required = [".gitignore", ".gitattributes"];
  for (const file of required) {
    if (!existsSync(file)) {
      violations.push({ file, category: "missing" });
    }
  }
  /*
   * `.gitattributes` is required, not optional: without a line-ending policy,
   * a Windows checkout writes CRLF into files that other tools then compare
   * byte-wise. That is precisely how one of this project's guards failed
   * deterministically on Windows while passing on the machine that wrote it.
   */
  if (existsSync(".gitattributes")) {
    const attributes = execFileSync("node", ["-e", "process.stdout.write(require('node:fs').readFileSync('.gitattributes','utf8'))"], {
      encoding: "utf8",
    });
    for (const expected of ["* text=auto", "*.ts", "*.md"]) {
      if (!attributes.includes(expected)) {
        violations.push({ file: ".gitattributes", category: `missing policy for '${expected}'` });
      }
    }
  }
  record("repository-hygiene", "line-ending and ignore policy present", violations);
}

// ── output ──
const failures = results.filter((result) => !result.ok);

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, results }, null, 2));
} else {
  for (const result of results) {
    console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.title}`);
    for (const violation of result.violations) {
      console.log(`         ${violation.file}: ${violation.category}`);
    }
  }
  console.log("");
  console.log(
    failures.length === 0
      ? `all ${results.length} history checks passed`
      : `${failures.length} of ${results.length} history checks FAILED`,
  );
}

process.exit(failures.length === 0 ? 0 : 1);
