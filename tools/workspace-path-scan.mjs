/**
 * Structural detection of **internal local-workspace paths** in public content.
 *
 * ── The defect this exists to close ──
 *
 * A review of the public candidate found the staging directory of the machine
 * that built it written out as a literal in four public source files: a build
 * tool's comment, a sanitiser fixture, and a test comment.
 *
 * The release scanner did not notice. Reading it explains why, and the reason
 * matters more than the instances:
 *
 *   The scanner matched only **user-home** shapes — `<drive>:\Users\<name>\…`,
 *   `/home/<name>/…`. A workspace directory is not a user home. A staging
 *   directory on any other drive, or under any other name, is still absolute,
 *   still machine-specific, still internal — and it passed the scan untouched.
 *
 * So the check was answering "does this disclose a user account?" when the
 * question a release has to answer is "does this disclose a machine's local
 * layout?". Those are different populations, and the second is much larger.
 *
 * ── Why a shape, and not a list of known-bad directories ──
 *
 * Adding this repository's staging directory to a denylist would make the
 * finding disappear while leaving the defect: the next snapshot built in a
 * differently-named directory would leak that name instead. A denylist also has
 * to *contain* the secret in order to forbid it, which is the "scanner exempts
 * itself" trap this repository already documents elsewhere.
 *
 * This module stores **no private path and no account name**. It decides from
 * structure: drive letter, separator, segment shape, and an allowance table that
 * names only fixture *vocabulary*.
 *
 * ── The three decisions, in order ──
 *
 * 1. **Already redacted?** If any segment is an ellipsis, the author deliberately
 *    elided the machine-specific part, and there is nothing left to disclose.
 * 2. **OS furniture only?** `<drive>:\Windows\system32\win.ini` exists on every
 *    Windows machine and identifies none of them.
 * 3. **Does a segment name an installation?** A segment that is neither
 *    placeholder vocabulary nor OS furniture is a candidate disclosure.
 *
 * ── Allowances, not exemptions ──
 *
 * Fixtures legitimately need to *look* like paths without being real ones. Those
 * are allowed by **normalised shape** (`drive` + first segment), each with a
 * reason, and the list is asserted not to rot in either direction: every allowed
 * shape must still occur, and every occurring shape must be allowed. A new leak
 * presents a new shape and therefore fails. Nothing is skipped by filename, so a
 * real path cannot hide inside a test file merely because it is a test file.
 *
 * ── Confinement ──
 *
 * Findings carry the line, the shape id, and the **normalised** form only. The
 * raw match is deliberately not returned to callers that log, because writing a
 * private path into a CI log relocates the disclosure instead of removing it.
 */

/** Placeholder words that mark a segment as fixture vocabulary, not a real name. */
const PLACEHOLDER_SEGMENTS = new Set([
  "synthetic", "synthetic-user", "synthetic-study", "synthetic-reviewer",
  "sample-root", "sample", "example", "fixture", "fake", "dummy", "placeholder",
  "redacted", "hidden", "user", "username", "you", "your-name", "yourname",
  "someone", "owner", "account", "shortname", "test", "tester", "demo",
  "a", "b", "c", "x", "y", "z", "aa", "bb", "foo", "bar", "baz", "qux",
  "some", "any", "other", "repo", "build", "src", "code", "projects",
]);

/** Segments that are OS furniture rather than an installation's directory. */
const OS_SEGMENTS = new Set([
  "windows", "system32", "syswow64", "win", "win.ini", "program files",
  "program files (x86)", "programdata", "temp", "tmp", "users", "appdata",
  "local", "roaming", "documents", "desktop", "downloads", "etc", "usr", "var",
]);

/**
 * Reviewed fixture vocabulary: normalised shapes that are allowed to appear.
 *
 * Each entry names a *drive plus one segment* — never a full path — and states
 * why it discloses nothing. Adding an entry is a review decision; the control
 * in `tools/workspace-path-controls.mjs` proves both that every entry is still
 * needed and that a shape outside this table is rejected.
 */
export const ALLOWED_SHAPES = new Map([
  ["c:\\root\\…", "prefix-matching fixture: a bare root used to test isWithin"],
  ["c:\\rootx\\…", "prefix-matching fixture: deliberately a near-miss of the root above"],
  ["c:\\temp\\…", "temp-directory fixture: a scratch path, no installation named"],
  ["c:\\windows\\…", "OS path used to prove absolute paths are rejected by validators"],
  ["d:\\study\\…", "README example of where a reader might keep imported content"],
  ["d:\\合成课程目录\\…", "synthetic non-English directory name in a picker fixture"],
  ["d:\\some\\…", "generic placeholder path in a sanitiser fixture"],
  ["d:\\synthetic-user\\…", "synthetic account name in a display-path fixture"],
  ["d:\\repo\\…", "ESM-loader illustration: any checkout path shows the same scheme trap"],
  ["q:\\sample-root\\…", "synthetic root in a sanitiser fixture"],
]);

/** A segment that is clearly a redaction rather than a name. */
function isRedactionSegment(segment) {
  if (segment === "") return true;
  // `...`, `…`, `<staging-root>`, `{name}`, `$VAR`, `%ENV%`.
  if (/^[.…]+$/.test(segment)) return true;
  if (/^[<{$%].*[>}$%]$/.test(segment)) return true;
  if (segment.includes("…")) return true;
  return false;
}

/**
 * ── UNC network paths: a machine named directly ──
 *
 * A `\\host\share\…` path names a machine as plainly as `C:\Users\<name>` does,
 * so leaving it undetected was a real gap in scope, not a deliberate exclusion.
 * The earlier V9 pass documented it as out-of-scope and a reviewer accepted that;
 * that acceptance is superseded here because the population turned out to be
 * classifiable without noise.
 *
 * ── Why this is harder than it looks ──
 *
 * `\\` in source text is overloaded three ways:
 *
 *   1. a real UNC path            `<introducer><machine-name><sep><share><sep>src`
 *   2. an escaped relative sep    `<sep><sep>` inside `"assets<sep><sep>sub..."`
 *   3. a regex / string escape    \n  \r  \s  \d  \t
 *
 * A naive "two backslashes then a word" rule fires on all three — a census over
 * this tree produced 135 candidates, of which the overwhelming majority were
 * noise, and a scanner that noisy gets switched off. Two anchors remove the noise
 * structurally rather than by enumerating known-bad cases:
 *
 *   - **Token anchor.** A UNC introducer can only appear where a token *starts*:
 *     start of input, whitespace, a quote, a backtick, an opening bracket or a
 *     comma. If it is preceded by a word character or a `.` it is a separator
 *     *inside* an existing path; if preceded by `:` it belongs to a drive path.
 *     The allow-set is positive, so an unanticipated prefix cannot become a hole.
 *   - **Host shape.** A machine name has at least two characters. One-letter
 *     segments are the escape codes, and they are also excluded explicitly.
 *
 * Synthetic hosts (`\\server\share`, `\\filesystem\…`, `\\host\…`) are allowed by
 * *host* in `ALLOWED_UNC_HOSTS`, with a reason, exactly as fixture paths are — a
 * fixture that must look like a UNC path must not be a real one.
 */
const ESCAPE_CODES = new Set([
  "n", "r", "s", "d", "t", "w", "b", "f", "v", "0", "1", "x", "u", "c", "p",
  "S", "D", "W", "B", "N", "R", "T",
]);

/**
 * Synthetic UNC hosts that disclose nothing, each with a reason.
 *
 * Keyed by the **first segment after the introducer** (the host). An unknown host
 * is a finding: a new name is a new machine until someone says otherwise.
 */
export const ALLOWED_UNC_HOSTS = new Map([
  ["server", "generic placeholder host in path-safety and sanitiser proof scripts"],
  ["host", "generic placeholder used to describe the UNC shape itself"],
  ["fileserver", "synthetic file server in the display-sanitiser fixtures"],
  ["synthetic-nas", "explicitly synthetic NAS in the display-path fixtures"],
  ["sub", "escaped relative separator (`sub/a.wav`), not a host"],
  ["courses", "escaped relative content path, not a host"],
  ["cet6-content", "escaped relative content path, not a host"],
  ["windows", "escaped OS path segment, not a host"],
  ["private-content", "escaped content-root segment in a sanitiser fixture, not a host"],
  ["sample-root", "synthetic root in a sanitiser fixture"],
]);

const UNC_PATTERN = /(?:^|[\s'"`([,])(\\{2,})([A-Za-z0-9][A-Za-z0-9_.\-]{0,63})\\{1,2}([A-Za-z0-9_.\-]+)/g;

/**
 * Find UNC network paths naming a machine.
 *
 * @param {string} source
 * @param {Map<string,string>} allowedHosts
 * @returns {Array<{ index: number, line: number, shape: string, normalised: string }>}
 */
export function findUncPaths(source, allowedHosts = ALLOWED_UNC_HOSTS) {
  const results = [];
  const pattern = new RegExp(UNC_PATTERN.source, UNC_PATTERN.flags);
  let match;
  while ((match = pattern.exec(source)) !== null) {
    /*
     * A drive prefix immediately before means these backslashes are drive-path
     * separators, not a UNC introducer: `C:\\Windows\\system32` is one path, not
     * a share on a host called `Windows`.
     */
    const before = source.slice(Math.max(0, match.index - 3), match.index);
    if (/[A-Za-z]:[\\/]*$/.test(before)) continue;

    const host = match[2];
    if (host.length < 2) continue;
    if (ESCAPE_CODES.has(host)) continue;
    if (allowedHosts.has(host.toLowerCase())) continue;

    const start = match.index + match[0].indexOf(match[1]);
    results.push({
      index: start,
      line: source.slice(0, start).split("\n").length,
      shape: "unc-network-path",
      /*
       * The **host is not echoed**. A UNC host *is* the machine name, so printing
       * it would move the disclosure from the tree into the CI log rather than
       * removing it. This is stricter than for drive paths, where only the first
       * directory segment is shown: a directory name is a location, a host name
       * is the machine itself.
       */
      normalised: "\\\\<host>\\…",
    });
  }
  return results;
}

/** Split a matched path into segments, dropping the drive and empty tails. */
function segmentsOf(text) {
  return text
    .replace(/^[A-Za-z]:/, "")
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== "");
}

/** Is this whole path made only of OS furniture and placeholder words? */
function isOnlyNonDisclosing(segments) {
  return segments.every((segment) => {
    const lower = segment.toLowerCase();
    return (
      OS_SEGMENTS.has(lower) ||
      PLACEHOLDER_SEGMENTS.has(lower) ||
      isRedactionSegment(segment)
    );
  });
}

/** Does any segment look like a real installation directory? */
function hasInstallationSegment(segments) {
  return segments.some((segment) => {
    const lower = segment.toLowerCase();
    if (OS_SEGMENTS.has(lower)) return false;
    if (PLACEHOLDER_SEGMENTS.has(lower)) return false;
    if (isRedactionSegment(segment)) return false;
    return /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(segment) && segment.length >= 2;
  });
}

/** A drive-letter path, not preceded by a word character (so URLs never match). */
const WINDOWS_ABSOLUTE = /(^|[^\w])((?:[A-Za-z]:[\\/]{1,2})[^\s'"`()<>|]*)/g;

/**
 * Is this a user-profile path whose *account* is a placeholder?
 *
 * For `<drive>:\Users\<account>\…` the disclosure is the account name, not the
 * directories beneath it: `C:\Users\<real-name>\Documents\project` tells a reader
 * who built the artefact, while `C:\Users\synthetic\AppData\Local\cet6-content`
 * names nobody. Treating the trailing segments as the signal would either flag
 * every fixture or (if the whole shape were allowed) stop catching real accounts
 * — and real accounts are the case the original guard got right. So the account
 * alone decides.
 */
function isPlaceholderUserProfile(segments) {
  if (segments.length < 2) return false;
  if (segments[0].toLowerCase() !== "users" && segments[0].toLowerCase() !== "home") {
    return false;
  }
  const account = segments[1].toLowerCase();
  return PLACEHOLDER_SEGMENTS.has(account) || isRedactionSegment(segments[1]);
}

/**
 * Classify one Windows absolute path.
 *
 * @returns {{ finding: boolean, shape: string, normalised: string }}
 */
export function classifyWindowsPath(raw) {
  const segments = segmentsOf(raw);
  const drive = /^([A-Za-z]):/.exec(raw)?.[1]?.toLowerCase() ?? "?";
  const first = segments[0] ?? "";
  const normalised = `${drive}:\\${first.toLowerCase()}\\…`;

  if (segments.length === 0) {
    return { finding: false, shape: "windows-drive-root", normalised: `${drive}:\\` };
  }
  // Rule 1: an ellipsis in the FIRST segment elides everything after the drive,
  // so nothing installation-specific is left. An ellipsis *after* a real segment
  // does not help: `<drive>:\<name>\…` still names `<name>`, which is exactly the
  // disclosure — a redaction at the tail cannot excuse a real head.
  if (segments.length > 0 && /^[.…]+$/.test(segments[0])) {
    return { finding: false, shape: "windows-already-redacted", normalised };
  }
  // Rule 2: a user-profile path with a placeholder account names nobody.
  if (isPlaceholderUserProfile(segments)) {
    return { finding: false, shape: "windows-placeholder-profile", normalised };
  }
  // Rule 3: nothing but OS furniture and placeholder words.
  if (isOnlyNonDisclosing(segments)) {
    return { finding: false, shape: "windows-non-disclosing", normalised };
  }
  // Rule 4: does something in here name an installation?
  if (!hasInstallationSegment(segments)) {
    return { finding: false, shape: "windows-non-disclosing", normalised };
  }
  return { finding: true, shape: "windows-internal-workspace", normalised };
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * POSIX absolute paths handed in by the caller with an explicit root list.
 *
 * A POSIX path carries no marker separating `/home/<name>/project` from
 * `/api/courses`, so this cannot be decided from the text alone. The caller
 * supplies the roots that are machine-specific in its context.
 *
 * ── Why the segment *after* the root is the decisive one ──
 *
 * For home-directory roots (`/home`, `/Users`) the disclosure is the **account**,
 * exactly as with the Windows profile form: `/home/you/project` names nobody,
 * while `/home/<real-name>/project` identifies the builder. The same account
 * rule therefore applies, and it is what keeps the sanitiser fixtures green
 * without a filename exemption. For non-home roots (`/srv`, `/opt`) there is no
 * account, so the ordinary installation-segment rule applies.
 */
export function findPosixRootPaths(source, roots, allowedShapes = ALLOWED_SHAPES) {
  const out = [];
  const HOME_ROOTS = new Set(["/home", "/users"]);
  for (const root of roots) {
    const trimmed = root.replace(/\/+$/, "");
    if (trimmed === "") continue;
    const isHomeRoot = HOME_ROOTS.has(trimmed.toLowerCase());
    /*
     * `\/(?![\s'"`()<>|]|$)` requires a **segment** after the root. A bare marker
     * such as `/home/` or `/Users/` is how a scanner documents the shape it
     * looks for, and it discloses nothing — there is no account in it. Without
     * this the pattern also matched the pattern tables that define it.
     */
    const pattern = new RegExp(
      `(^|[^\\w])(${escapeRegExp(trimmed)}\\/[^\\s'"\`()<>|/][^\\s'"\`()<>|]*)`,
      "g",
    );
    let match;
    while ((match = pattern.exec(source)) !== null) {
      const raw = match[2];
      /*
       * Segments *below* the root. `segmentsOf` strips a Windows drive prefix,
       * which a POSIX path does not have, so the root itself has to be removed
       * first — otherwise `segments[0]` is the root (`home`) rather than the
       * account, and every placeholder account looks real.
       */
      const belowRoot = raw.slice(raw.toLowerCase().indexOf(trimmed.toLowerCase()) + trimmed.length);
      const segments = segmentsOf(belowRoot);
      if (segments.length === 0) continue;
      // A first segment that is an ellipsis hides everything after the root.
      if (/^[.…]+$/.test(segments[0])) continue;
      if (isHomeRoot) {
        // The account is the first segment under the root.
        if (PLACEHOLDER_SEGMENTS.has(segments[0].toLowerCase())) continue;
        if (isRedactionSegment(segments[0])) continue;
      } else if (!hasInstallationSegment(segments)) {
        continue;
      }
      const normalised = `${trimmed.toLowerCase()}/…`;
      if (allowedShapes.has(normalised)) continue;
      out.push({ index: match.index + match[1].length, shape: "posix-internal-root", normalised });
    }
  }
  return out;
}

/**
 * Find every internal local-workspace path in one text.
 *
 * @param {string} source text to scan (comments included on purpose — a leaked
 *   path in a comment is exactly as public as one in a string)
 * @param {{ posixRoots?: readonly string[], allowedShapes?: Map<string,string> }} [options]
 * @returns {Array<{ index: number, line: number, shape: string, normalised: string }>}
 */
export function findInternalWorkspacePaths(source, options = {}) {
  const allowedShapes = options.allowedShapes ?? ALLOWED_SHAPES;
  const allowedUncHosts = options.allowedUncHosts ?? ALLOWED_UNC_HOSTS;
  const results = [];
  const pattern = new RegExp(WINDOWS_ABSOLUTE.source, WINDOWS_ABSOLUTE.flags);
  let match;
  while ((match = pattern.exec(source)) !== null) {
    const start = match.index + match[1].length;
    const classified = classifyWindowsPath(match[2]);
    if (!classified.finding) continue;
    if (allowedShapes.has(classified.normalised)) continue;
    results.push({
      index: start,
      line: source.slice(0, start).split("\n").length,
      shape: classified.shape,
      normalised: classified.normalised,
    });
  }

  /* UNC network paths naming a machine (see `findUncPaths`). */
  for (const hit of findUncPaths(source, allowedUncHosts)) {
    results.push(hit);
  }

  if (options.posixRoots !== undefined) {
    for (const hit of findPosixRootPaths(source, options.posixRoots, allowedShapes)) {
      results.push({
        index: hit.index,
        line: source.slice(0, hit.index).split("\n").length,
        shape: hit.shape,
        normalised: hit.normalised,
      });
    }
  }

  return results.sort((a, b) => a.index - b.index);
}

/**
 * Render a finding for a report **without** echoing the matched text.
 *
 * Callers must use this rather than interpolating the path: a CI log is as
 * public as the repository, and copying the path into it moves the leak.
 */
export function describeFinding(finding) {
  return `line ${finding.line}: ${finding.shape} at ${finding.normalised}`;
}

export const __testing = {
  segmentsOf,
  hasInstallationSegment,
  isOnlyNonDisclosing,
  isRedactionSegment,
  PLACEHOLDER_SEGMENTS,
  OS_SEGMENTS,
};
