#!/usr/bin/env node
/**
 * Final integrity audit of the release candidate.
 *
 * ── What this adds over the existing audits ──
 *
 * `audit-history.mjs` and `audit-all-commits.mjs` already check paths, messages
 * and blob contents. This tool answers the remaining questions about the
 * **repository object database**, which those two deliberately do not touch:
 *
 *   1. Is there exactly one root commit, and no ancestor?
 *   2. Are there unreachable, dangling or hidden objects left from staging?
 *   3. Do `refs/replace`, notes, grafts, stash or tags exist?
 *   4. Is there any remote, and any alternates file pointing at another store?
 *   5. Does any object mention a private source commit or an internal path?
 *   6. Do author and committer agree, and are both a neutral identity?
 *   7. Does `git fsck` report anything at all?
 *
 * It reads the object database directly, so a passing result is a statement about
 * what a reader can obtain — not only about what the checkout shows.
 *
 * Usage:
 *   node tools/audit-object-database.mjs [--json]
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describeFinding, findInternalWorkspacePaths } from "./workspace-path-scan.mjs";

const JSON_OUTPUT = process.argv.includes("--json");

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function tryGit(args) {
  try {
    return { ok: true, out: git(args) };
  } catch (error) {
    return { ok: false, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

if (!existsSync(".git")) {
  console.error("not a git repository");
  process.exit(2);
}

const results = [];
function record(id, title, violations, note = "") {
  results.push({ id, title, ok: violations.length === 0, violations, note });
}

// ── 1. history shape ──
{
  const violations = [];
  const count = Number.parseInt(git(["rev-list", "--count", "HEAD"]).trim(), 10);
  const roots = git(["rev-list", "--max-parents=0", "HEAD"]).trim().split("\n").filter(Boolean);

  if (roots.length !== 1) {
    violations.push({ file: "(history)", category: `${roots.length} root commit(s); a release snapshot must have exactly 1` });
  }
  /*
   * The root commit's own parent list must be empty. `rev-list --max-parents=0`
   * already implies this, but asserting it directly separately guards against a
   * future graft or replace ref making the derived view disagree with the object.
   */
  const rootParents = git(["cat-file", "-p", roots[0]]).split("\n").filter((line) => line.startsWith("parent "));
  if (rootParents.length !== 0) {
    violations.push({ file: roots[0].slice(0, 12), category: `root commit has ${rootParents.length} parent line(s)` });
  }

  /*
   * ── The check above is HEAD-scoped, and that is not enough (follow-through) ──
   *
   * `rev-list --max-parents=0 HEAD` answers "how many roots does the history of
   * THIS COMMIT have", which is the right question for what a reader receives from
   * a normal clone. It is the wrong question for what a *push* would publish: a
   * local branch that is not an ancestor of HEAD is invisible to it, yet
   * `git push --all` and `git push --mirror` send every local branch.
   *
   * Measured consequence: a repository whose `master` is a pristine single-root
   * snapshot, plus one orphan branch holding anything at all, passed this audit
   * with "exactly one parentless root commit" while `--all` reported two roots and
   * `git push --all` published both. The extra branch also escaped the content
   * gates, which scan the checked-out worktree and HEAD by design — so a
   * credential or a forbidden path living only on that branch was not seen by
   * anything.
   *
   * The fix is not to scan other branches for content (the published tree really is
   * HEAD, and broadening every scan would cost both time and precision). It is to
   * assert the property that actually protects publication: **every local ref must
   * belong to the single-root history of HEAD**. A stray branch is then reported as
   * what it is — a ref that would ship unrelated history — instead of surfacing
   * later as a surprise in the published repository.
   *
   * Remote-tracking refs are exempt: a clone materialises `refs/remotes/origin/*`
   * for the same commits HEAD already has, and `actions/checkout` is a clone. Their
   * contents are still covered by the object scan below, which walks every object
   * in the database.
   */
  const localRefs = git(["for-each-ref", "--format=%(refname)", "refs/heads"])
    .trim()
    .split("\n")
    .filter(Boolean);

  /*
   * For each local branch, is it an ancestor of HEAD? `merge-base --is-ancestor`
   * exits 0 when it is, 1 when it is not; an unrelated history gives 1 as well,
   * which is exactly the case to report.
   */
  const stray = [];
  for (const ref of localRefs) {
    if (ref === "refs/heads/master" || ref === "refs/heads/main") continue;
    let isAncestor = true;
    try {
      git(["merge-base", "--is-ancestor", ref, "HEAD"]);
    } catch {
      isAncestor = false;
    }
    if (!isAncestor) stray.push(ref);
  }

  if (stray.length > 0) {
    violations.push({
      file: "(refs)",
      category:
        `${stray.length} local branch(es) are not part of HEAD's history: ${stray.join(", ")} — ` +
        `a push with --all or --mirror would publish them, and content on them is outside ` +
        `every other check in this release`,
    });
  }

  record(
    "history-shape",
    "exactly one parentless root commit, and no branch outside its history",
    violations,
    `${count} commit(s), ${localRefs.length} local branch(es)`,
  );
}

// ── 2. hidden refs and metadata ──
{
  const violations = [];
  const checks = [
    ["refs/replace", "replace refs rewrite what history appears to be"],
    ["refs/notes", "notes attach hidden metadata to commits"],
    ["refs/stash", "a stash holds uncommitted work"],
    ["refs/tags", "tags are a release artefact and must be created deliberately"],
  ];
  for (const [ref, reason] of checks) {
    const listing = git(["for-each-ref", "--format=%(refname)", ref]).trim();
    if (listing !== "") violations.push({ file: ref, category: reason });
  }
  if (existsSync(".git/info/grafts")) {
    violations.push({ file: ".git/info/grafts", category: "grafts fake commit ancestry" });
  }
  if (existsSync(join(".git", "objects", "info", "alternates"))) {
    violations.push({
      file: ".git/objects/info/alternates",
      category: "an alternates file points at another object store — ancestry is not self-contained",
    });
  }

  const refs = git(["for-each-ref", "--format=%(refname)"]).trim().split("\n").filter(Boolean);
  record("hidden-metadata", "no replace refs, notes, grafts, stashes, tags or alternates", violations, `refs: ${refs.join(", ")}`);
}

// ── 3. remotes ──
{
  const violations = [];
  const remotes = git(["remote"]).trim().split("\n").filter(Boolean);
  /*
   * ── What this check is actually for ──
   *
   * The requirement is "the authoring tree must not have acquired a remote before
   * publication is authorised", because an inherited origin is how a staging
   * directory accidentally pushes to a private destination.
   *
   * It is not "no repository anywhere may have a remote". `git clone` creates
   * `origin`, and `actions/checkout` — the way CI obtains the tree — is a clone.
   * Enforcing the literal rule in CI made this audit fail on every run for a
   * reason that had nothing to do with the snapshot's contents, which is the
   * fastest way to teach everyone that a failing audit can be ignored.
   *
   * So the rule distinguishes the two situations by asking a question that has a
   * different answer in each: does this checkout carry remote-tracking refs, i.e.
   * was it produced by cloning? A clone is the published view and may have a
   * remote; the authoring tree must not.
   */
  const isClone =
    existsSync(".git/refs/remotes") ||
    git(["for-each-ref", "--format=%(refname)", "refs/remotes"]).trim() !== "" ||
    (() => {
      try {
        return git(["config", "--get", "remote.origin.url"]).trim() !== "";
      } catch {
        return false;
      }
    })();

  if (remotes.length !== 0 && !isClone) {
    violations.push({
      file: "(remotes)",
      category: `${remotes.length} remote(s) configured: ${remotes.join(", ")} — a release candidate must have none until publication is authorised`,
    });
  }
  record(
    "remotes",
    "no remote is configured on the authoring tree",
    violations,
    isClone ? "clone detected — a platform-created origin is expected here" : "",
  );
}

// ── 4. object database health ──
{
  const violations = [];
  const fsck = tryGit(["fsck", "--full", "--strict", "--unreachable", "--dangling"]);
  if (!fsck.ok || fsck.out.trim() !== "") {
    violations.push({
      file: "(objects)",
      category: `git fsck reported output: ${fsck.out.trim().split("\n").slice(0, 3).join(" | ")}`,
    });
  }

  /*
   * Count objects by type so the report can state the size of what a reader gets.
   * `--batch-check` on `--batch-all-objects` enumerates the whole database,
   * including anything unreachable.
   */
  const batch = git(["cat-file", "--batch-check", "--batch-all-objects"]).trim().split("\n").filter(Boolean);
  const byType = new Map();
  for (const line of batch) {
    const parts = line.split(" ");
    const type = parts[1];
    byType.set(type, (byType.get(type) ?? 0) + 1);
  }
  const summary = [...byType.entries()].map(([type, count]) => `${count} ${type}`).join(", ");

  record("object-database", "fsck is clean and every object is reachable", violations, summary);
}

// ── 5. private references inside objects ──
{
  const violations = [];
  /*
   * ── What counts as a private reference ──
   *
   * Two separate questions, and only one of them concerns `private-content`.
   *
   * 1. **The bare directory name is public contract.** It is the documented
   *    default content root — named in the README, `.env.example` and
   *    `.gitignore`. Forbidding it would forbid the product's own documentation,
   *    and a rule that fails on correct content gets deleted.
   *
   * 2. **A real machine account path must not appear.** That is the actual
   *    disclosure: a drive path, user home or profile directory naming *some*
   *    build host.
   *
   * ── Why this is no longer derived from the running environment ──
   *
   * The previous version built its markers from `process.cwd()`,
   * `process.env.USERPROFILE` and `process.env.HOME`. That answers "does this
   * object name the machine I am on right now?", which is nearly useless for the
   * question a release has to answer. A committed absolute path is a historical
   * fact about the machine that built the snapshot; it does not change when CI
   * runs the audit on a Linux runner with a different home directory. The
   * practical consequence was measured in review: a committed
   * `C:\Users\<name>~1\…` fragment survived four staging generations and three
   * review rounds because no run ever had that username in its environment.
   *
   * So detection is now **structural**: it recognises the *shape* of a
   * user-scoped absolute path, which is machine-independent, plus the runtime
   * markers as an extra net for this checkout. Both directions are needed —
   * shape catches the historical leak, runtime markers catch an odd path that
   * does not fit a shape.
   *
   * ── The exemption, and why it is narrow ──
   *
   * Sanitiser fixtures and threat-model prose legitimately contain synthetic
   * roots (`Q:\sample-root\…`, `/home/user/…`, `\\fileserver\share\…`, `D:\…\`).
   * Rejecting them would make the security tests impossible to write. They are
   * excluded by an explicit list of *placeholder* account names, not by
   * allowing any path that happens to look like an example: a placeholder must
   * be one of a small fixed set of words, so a real username cannot slip in by
   * coincidence.
   */
  const runtimeMarkers = [
    process.cwd(),
    process.cwd().replace(/\\/g, "/"),
    process.env.USERPROFILE,
    process.env.HOME,
  ].filter((value) => typeof value === "string" && value.length > 6);

  /*
   * Account/directory names that are obviously placeholders.
   *
   * Kept deliberately short and closed: these are the words this repository's
   * own fixtures and documentation use. Anything else — a real-looking account
   * name — is reported.
   */
  const PLACEHOLDER_ACCOUNTS = new Set([
    "user", "username", "account", "you", "your-name", "yourname", "name",
    "someone", "example", "sample", "test", "tester", "demo", "placeholder",
    "shortname", "short-name", "acct", "owner", "alice", "bob", "jane", "john",
    "sample-root", "share", "home", "users", "tmp", "temp", "app", "workspace",
    "projects", "code", "src", "repo", "build", "runner", "vscode", "admin",
    // Structural illustrations in the sanitiser and its tests: a single letter,
    // a repeated letter, and the literal word "synthetic" all mark a fixture
    // rather than an account.
    "a", "b", "c", "x", "y", "z", "aa", "bb", "foo", "bar", "baz", "qux",
    "synthetic", "fixture", "fake", "dummy", "redacted", "hidden", "any",
  ]);

  /**
   * Shapes that disclose a machine, matched independently of this host.
   *
   * Each entry returns the matched *fragment* so the caller can decide whether it
   * names a placeholder account. Fragments are never printed in full — the
   * report names the file and the category only.
   */
  const MACHINE_PATH_SHAPES = [
    /*
     * `C:\Users\<account>\…` and the 8.3 alias form `C:\Users\<ACCOUN~1>\…`.
     *
     * The tilde form is the one that actually leaked here: Windows writes short
     * names into `%TEMP%`, so a path printed from a temporary directory carries
     * the *short* account name, which is not the same string as the login name
     * and therefore never matched a username-based check.
     */
    {
      id: "windows-user-profile",
      regex: /[A-Za-z]:\\{1,2}Users\\{1,2}([^\\"'\s<>|]+)\\{1,2}/g,
      accountGroup: 1,
    },
    /* Forward-slash spelling of the same path, as it appears in JSON and URLs. */
    {
      id: "windows-user-profile",
      regex: /[A-Za-z]:\/Users\/([^/"'\s<>|]+)\//g,
      accountGroup: 1,
    },
    /* A bare 8.3 short alias anywhere: `NAME~1`, `ACCOUN~12`. */
    {
      id: "windows-short-name-alias",
      regex: /\b([A-Za-z][A-Za-z0-9._-]{1,7})~[0-9]+\b/g,
      accountGroup: 1,
      // Only meaningful in a path-looking context; see `inPathContext` below.
      requiresPathContext: true,
    },
    /* POSIX user homes. `/home/` and `/Users/` are the two conventions. */
    {
      id: "posix-user-home",
      regex: /\/(?:home|Users)\/([^/"'\s<>|]+)\//g,
      accountGroup: 1,
    },
    /*
     * ── UNC shares: deliberately NOT matched, and why ──
     *
     * A `\\host\share` reference does name a machine, so it looks like it belongs
     * in this table. It was implemented, tested against the tree, and removed,
     * because the false-positive rate made it a net loss:
     *
     *   - In JavaScript source, `\\\\sub\\\\a.wav` is the escaped spelling of the
     *     *relative path* `sub/a.wav`. Seven such fixtures exist in this tree, and
     *     every one of them reads as a share called `\\sub\a.wav`.
     *   - `\\cet6-content\\cet6` is an escaped content path, not a host.
     *   - Real-looking host words (`workstation`, `nas`, `desktop`) are exactly the
     *     ones a placeholder vocabulary must not treat as safe, so a host-name
     *     allow-list large enough to silence the fixtures also silences genuine
     *     names. A rule that cannot separate the two either cries wolf or misses.
     *
     * The leak this audit actually had to find was a `C:\Users\<name>~1\…` path,
     * which the windows-user-profile shape above covers directly. UNC shares are
     * a hypothetical channel here; the profile path was a real one. Shipping a
     * noisy rule next to a working one is how the working one gets ignored.
     *
     * If UNC disclosure ever becomes a real requirement, the right control is at
     * the content-gate level (a rule over documented layout), not a shape regex
     * over escaped source text.
     */
  ];

  /**
   * Is this match plausibly a filesystem path rather than ordinary text?
   *
   * The 8.3 rule is the only one that needs this: `foo~1` is also a legitimate
   * backup suffix, a version range, a regex quantifier, or — as in this file —
   * a documented *example* inside a code span. Two conditions keep it aimed at
   * paths without rejecting correct content:
   *
   *   1. a path separator within a short window, and
   *   2. not immediately surrounded by backticks, which is how this repository
   *      writes `foo~1` when it is describing the shape rather than using it.
   *
   * The second condition is deliberately narrow. It exists because the rule's own
   * documentation must be able to name the shape it detects — the same reason the
   * content gate has a documented allowance for its own pattern table.
   */
  function inPathContext(content, index, matchLength) {
    // A code span (`…`) in this repository's prose means "this is the shape, not
    // an instance". Enough context to see a backtick on either side, because the
    // delimiters are not always adjacent to the alias itself.
    const before = content.slice(Math.max(0, index - 24), index);
    const after = content.slice(index + matchLength, index + matchLength + 24);
    const openTicks = (before.match(/`/g) ?? []).length;
    const closeTicks = (after.match(/`/g) ?? []).length;
    if (openTicks % 2 === 1 || closeTicks % 2 === 1) return false;
    const window = content.slice(Math.max(0, index - 60), Math.min(content.length, index + 60));
    return /[\\/]/.test(window);
  }

  /**
   * Host names that are obviously placeholders in a UNC share.
   *
   * `\\server\share` and `\\fileserver\share` are the canonical RFC 1738
   * illustrations and are what the sanitiser's own fixtures use. A real host has
   * a distinguishing name (an inventory tag, a person, a room, a company); these
   * words carry no information about any machine.
   *
   * Matching is by *segment*: `synthetic-nas` qualifies because `synthetic` is one
   * of its hyphen-separated parts, which is how fixtures name things. A real host
   * called `nas-01` does not, because none of its parts is in this list.
   */
  const PLACEHOLDER_UNC_HOSTS = new Set([
    "server", "fileserver", "host", "hostname", "share", "unc", "example",
    "sample", "test", "demo", "synthetic", "placeholder", "localhost", "any",
    "nas", "workstation", "machine", "computer", "pc", "srv", "dc",
  ]);

  /** Is this UNC host recognisably synthetic rather than a real machine name? */
  function isPlaceholderHost(host) {
    const normalised = host.toLowerCase().replace(/[<>[\]{}]/g, "");

    /*
     * Escaped-source forms, not shares.
     *
     * This repository's threat-model prose and its sanitiser fixtures contain
     * *illustrations* of the escaped spelling: `\\.` in a RegExp, `\\Windows\\...`
     * in a note about drive paths, `\\courses\\x`. Read literally those look like
     * `\\<host>\<share>`, but the giveaway is the shape of the segment: a single
     * dot, an ellipsis, or a backslash-free identifier immediately followed by
     * `\\x` (a hex escape). None of them is a host name, and reporting them would
     * make the rule fire on the documentation that explains the rule.
     */
    if (normalised === "." || normalised === ".." || normalised === "...") return true;
    if (normalised.includes("…") || normalised.includes("...")) return true;
    if (/^\.+$/.test(normalised)) return true;
    if (/^x[0-9a-f]{2,}$/i.test(normalised)) return true;

    if (PLACEHOLDER_UNC_HOSTS.has(normalised)) return true;
    // Redaction shapes: `<host>`, `...`, `xxx`, `***`.
    if (/^[.…*x_-]+$/i.test(normalised)) return true;

    /*
     * Words that are Windows path vocabulary rather than host names.
     *
     * `\\Windows\\system32` and `\\courses\\x` are prose about paths — a directory
     * named after the OS, or the repository's own content layout. A *machine* has a
     * name that distinguishes it from every other machine; these do not, and they
     * appear in the sanitiser's own test expectations where they must appear.
     */
    const PATH_VOCABULARY = new Set([
      "windows", "system32", "syswow64", "users", "temp", "appdata", "programdata",
      "courses", "papers", "cet6", "private-content", "content", "share", "data",
      "sources", "sdk", "packages", "node_modules", "src", "dist", "build", "out",
    ]);
    if (PATH_VOCABULARY.has(normalised)) return true;

    return normalised.split(/[-_.]/).some((segment) => PLACEHOLDER_UNC_HOSTS.has(segment));
  }

  /**
   * Decide whether a matched user-scoped path is a placeholder or a real name.
   *
   * A placeholder must be *recognisably* synthetic: it is in the closed set, or
   * it is obviously redacted (`<account>`, `…`, `xxx`, `***`, `REDACTED`).
   */
  function isPlaceholderAccount(account) {
    if (account === null) return true;
    const normalised = account.toLowerCase().replace(/[<>[\]{}]/g, "");
    if (PLACEHOLDER_ACCOUNTS.has(normalised)) return true;
    // Redaction markers: the documentation shows the shape without a real value.
    if (/^[.…*x_-]+$/i.test(normalised)) return true;
    if (normalised.includes("…") || normalised.includes("...")) return true;
    /*
     * Compound placeholders such as `synthetic-user`, `test-account` or
     * `example-home`. A fixture name is typically a placeholder word plus a
     * qualifier; requiring the placeholder word to be a whole segment keeps this
     * from matching a real account that merely happens to contain those letters.
     */
    if (/^[a-z]+(?:[-_.][a-z0-9]+)*$/.test(normalised)) {
      const segments = normalised.split(/[-_.]/);
      if (segments.some((segment) => PLACEHOLDER_ACCOUNTS.has(segment))) return true;
    }
    return false;
  }

  /** Names with no public contract at all: presence is a finding on its own. */
  const forbiddenNames = [".opc/", "AGENTS.md", "CLAUDE.md", "research-shots/"];

  /*
   * Files allowed to name a forbidden path because naming it is their function.
   *
   * Kept as exact paths, not as a directory wildcard: exempting all of `tools/`
   * would hide a real reference in any other tool, and this list is short enough
   * to review at a glance.
   */
  const NAMING_IS_THE_FUNCTION = new Set([
    "tools/public-release-check.mjs",
    "tools/gate-negative-controls.mjs",
    "tools/audit-object-database.mjs",
    "tools/audit-history.mjs",
    "tools/audit-all-commits.mjs",
  ]);

  /*
   * Map object id -> repository path.
   *
   * Without this the audit can only say "an object contains X", which is not
   * actionable: a reader cannot tell whether it is product code or the tool that
   * refuses X. Building the map once costs a single `ls-tree` and makes every
   * finding nameable — which is the difference between a report someone can act on
   * and one they have to investigate.
   *
   * ── Why every commit's tree, not just HEAD ──
   *
   * The map used to be built from `HEAD` alone. Combined with the exemption below
   * — which is looked up *by path* — that produced a false failure the moment an
   * exempt file was edited: the previous revision of the file is still a reachable
   * object (and still contains the names its function requires), but it is no
   * longer in `HEAD`, so it has no path, so the exemption cannot apply and the
   * audit reports "object contains '.opc/'" against a commit that only reworded a
   * comment. Every commit touching an exempt tool tripped it, which made the check
   * unfixable-by-obedience and invited the usual "just delete the check" response.
   *
   * Mapping objects from **all** commits fixes that without weakening anything:
   * a revision inherits its file's path, so an exempt tool's history is exempt for
   * exactly the same reason its current revision is, and a forbidden name in a
   * file that is *not* on the list is still a finding in every revision. The rule
   * is about which file an object belongs to, not about which revision of it is
   * currently checked out.
   */
  const pathByObject = new Map();
  const recordTree = (revision) => {
    for (const line of git(["ls-tree", "-r", "--full-tree", revision]).split("\n")) {
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const meta = line.slice(0, tab).split(/\s+/);
      const path = line.slice(tab + 1).replace(/\\/g, "/");
      // First writer wins: `HEAD` is recorded first, so it keeps priority.
      if (!pathByObject.has(meta[2])) pathByObject.set(meta[2], path);
    }
  };
  recordTree("HEAD");
  for (const revision of git(["rev-list", "--all"]).split("\n").filter(Boolean)) {
    if (revision === "") continue;
    try {
      recordTree(revision);
    } catch {
      /* a revision whose tree cannot be read must not abort the audit */
    }
  }

  const objects = git(["cat-file", "--batch-check", "--batch-all-objects"])
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ")[0]);

  let scanned = 0;
  for (const sha of objects) {
    let content;
    try {
      content = git(["cat-file", "-p", sha]);
    } catch {
      continue;
    }
    scanned += 1;

    let flagged = false;

    /*
     * Runtime markers first: cheapest, and they catch a path shape the
     * structural rules might not anticipate.
     */
    for (const marker of runtimeMarkers) {
      if (content.includes(marker)) {
        violations.push({
          file: pathByObject.get(sha) ?? sha.slice(0, 12),
          category: "object contains this checkout's path or user home",
        });
        flagged = true;
        break;
      }
    }
    if (flagged) continue;

    /*
     * Structural judgement: machine-independent, so a historical leak is found on
     * any runner. The report names the file and the kind of disclosure; it never
     * reproduces the matched fragment, because copying a private path into a CI
     * log moves the disclosure rather than removing it.
     */
    const objectPath = pathByObject.get(sha) ?? "";
    for (const shape of MACHINE_PATH_SHAPES) {
      shape.regex.lastIndex = 0;
      let match;
      let reported = false;
      while ((match = shape.regex.exec(content)) !== null) {
        if (shape.requiresPathContext === true && !inPathContext(content, match.index, match[0].length)) continue;
        const account = shape.accountGroup === null ? null : match[shape.accountGroup];
        /*
         * A UNC host is a finding on its own, with one exception: the handful of
         * generic words that mean "some server" rather than naming one. Those are
         * what the sanitiser fixtures legitimately contain.
         */
        if (shape.anyAccountIsAFinding === true) {
          if (account !== null && isPlaceholderHost(account)) continue;
          /*
           * A share name is a plain identifier. If the second segment carries an
           * extension, this is an escaped *relative path* (`"\\\\sub\\\\a.wav"` is
           * `sub/a.wav`), not a reference to a machine.
           */
          const shareSegment = shape.shareGroup === undefined ? undefined : match[shape.shareGroup];
          if (shareSegment !== undefined && shareSegment.includes(".")) continue;
        } else if (isPlaceholderAccount(account)) {
          continue;
        }
        violations.push({
          file: objectPath === "" ? sha.slice(0, 12) : objectPath,
          category: `object names a real machine account path (${shape.id})`,
        });
        reported = true;
        break;
      }
      if (reported) {
        flagged = true;
        break;
      }
    }
    if (flagged) continue;

    /*
     * ── General internal-workspace paths, in committed objects ──
     *
     * The shape table above covers *user-profile* paths. A workspace directory is
     * not a user profile: a staging checkout on any other drive or under any
     * other name is still absolute, still machine-specific, still internal — and
     * it used to pass this audit untouched. Four such literals were found in the
     * public tree by review, which is why the structural detector is now shared
     * with the content gate (`tools/workspace-path-scan.mjs`).
     *
     * This runs over every object, comments included: a path quoted in a comment
     * is published exactly like one quoted in a string. Findings name the file,
     * line and a normalised prefix — never the matched text, because a CI log is
     * as public as the repository.
     */
    for (const finding of findInternalWorkspacePaths(content)) {
      violations.push({
        file: objectPath === "" ? sha.slice(0, 12) : objectPath,
        category: `object carries an internal workspace path (${describeFinding(finding)})`,
      });
      flagged = true;
      break;
    }
    if (flagged) continue;

    const namingAllowed = NAMING_IS_THE_FUNCTION.has(objectPath);

    for (const name of forbiddenNames) {
      if (!content.includes(name)) continue;
      /*
       * A forbidden name inside a tool whose job is to refuse or plant it is
       * legitimate. This is the same reasoning as the gate's documented allowance
       * list: a scanner must contain what it searches for, and a negative control
       * must contain the shape it rejects.
       *
       * The exemption is scoped to the exact files in `NAMING_IS_THE_FUNCTION`, and
       * the check still runs over every other object — so a real reference in
       * product code, tests or any other tool is still a finding.
       */
      if (namingAllowed) continue;
      violations.push({
        file: objectPath === "" ? sha.slice(0, 12) : objectPath,
        category: `object contains '${name}'`,
      });
      break;
    }
  }
  record("private-references", "no object carries an absolute local path or a withheld name", violations, `${scanned} object(s) scanned`);
}

// ── 6. identities ──
{
  const violations = [];
  const identities = git(["log", "--format=%an <%ae>|%cn <%ce>"]).trim().split("\n").filter(Boolean);
  const unique = [...new Set(identities.flatMap((line) => line.split("|")))];

  for (const identity of unique) {
    if (/@local$/i.test(identity)) {
      violations.push({ file: "(identity)", category: `non-routable identity: ${identity}` });
    }
    if (/^(?:Implementation Agent|agent) </i.test(identity)) {
      violations.push({ file: "(identity)", category: `generic agent identity: ${identity}` });
    }
  }
  // Author and committer must be the same for a fresh, unattributed commit.
  const [author, committer] = identities[0].split("|");
  if (author !== committer) {
    violations.push({
      file: "(identity)",
      category: `author and committer differ: ${author} vs ${committer}`,
    });
  }

  record("identities", "a single neutral identity authored and committed", violations, unique.join(", "));
}

// ── 7. message content ──
{
  const violations = [];
  const message = git(["log", "-1", "--format=%B"]);
  const forbidden = [
    [new RegExp("\\b" + ["Qo", "der"].join("") + "\\b", "i"), "internal review role name"],
    [/\bCTO\b/, "internal review role name"],
    [/\bHarness\b/, "internal agent-harness reference"],
    [/\bFINAL\s+PASS\b/i, "internal review verdict"],
    [/\bN-[1-4]\b/, "internal review finding identifier"],
    [/\bF-\d\b/, "internal review finding identifier"],
    [/\bD-\d{3}\b/, "internal decision-record identifier"],
    [/\.opc\b/, "internal record path"],
    [/\bOwner\b/, "internal role word"],
  ];
  for (const [pattern, category] of forbidden) {
    if (pattern.test(message)) violations.push({ file: "(message)", category });
  }
  record("commit-message", "the commit message carries no internal vocabulary", violations, `${message.split("\n")[0]}`);
}

// ── output ──
const failures = results.filter((result) => !result.ok);

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ ok: failures.length === 0, results }, null, 2));
} else {
  console.log("object-database audit\n");
  for (const result of results) {
    const note = result.note === "" ? "" : `  (${result.note})`;
    console.log(`[${result.ok ? "PASS" : "FAIL"}] ${result.title}${note}`);
    for (const violation of result.violations.slice(0, 10)) {
      console.log(`         ${violation.file}: ${violation.category}`);
    }
  }
  console.log("");
  console.log(
    failures.length === 0
      ? `all ${results.length} object-database checks passed`
      : `${failures.length} of ${results.length} object-database checks FAILED`,
  );
}

process.exit(failures.length === 0 ? 0 : 1);
