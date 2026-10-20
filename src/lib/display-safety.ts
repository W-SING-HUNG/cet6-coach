/**
 * Display-safety helpers for text that reaches the DOM.
 *
 * ── What it solves ──
 *
 * Low-level errors frequently carry filesystem paths:
 *
 * - `Error: ENOENT: no such file or directory, open 'D:\...\private-content\courses\x\course.json'`
 * - our own `课程包不存在或缺少 course.json：private-content/courses/x`
 *
 * Those strings reach the UI through `packageIssue` or a 404 body. The local
 * directory layout (where the content root lives, what the user is called,
 * which drive letter) is not information a learner needs. It is noise, and it
 * is an unnecessary disclosure surface.
 *
 * ── Why sanitise at the display boundary instead of fixing the sources ──
 *
 * Message sources are not in one place, and new ones will appear (any `catch`
 * can concatenate a path). Fixing sources one by one means relying on "every
 * new catch remembers to sanitise". Sanitising once at the single exit covers
 * new sources automatically.
 *
 * ── What it deliberately does NOT do ──
 *
 * It does not guess what an error means and does not rewrite the technical
 * cause. It does one thing: replace a **path fragment** with a neutral
 * placeholder so the readable explanation survives.
 *
 * ── Client-bundle safety (this module is imported by a Client Component) ──
 *
 * This file is reachable from `reveal-button.tsx`, which carries `"use client"`,
 * so its code ships to every browser that opens the course page. It must
 * therefore never contain a literal list of the internal directory names it is
 * meant to hide — a sanitiser that enumerates the real content-root directory
 * names in a client module discloses the internal layout by the very act of
 * defining what "private" means.
 *
 * Matching below is therefore **structural**: a token is treated as a path when
 * it is shaped like one (drive letter, UNC prefix, absolute POSIX path, or a
 * multi-segment relative fragment whose segments look like content/tooling
 * directories). No project-specific directory name is stored here.
 */

/** Stand-in for a path fragment (reveals no directory name). */
export const PATH_PLACEHOLDER = "（本机私有目录）";

/**
 * A path segment that is unambiguously part of a local content/tooling layout,
 * recognised by **shape** rather than by a hard-coded name.
 *
 * - a dot-prefixed segment is a tool/config directory (`.next`, `.e2e`, `.git`);
 * - a segment mentioning content / fixture / course / paper is application
 *   vocabulary for imported material, i.e. exactly what must not be echoed.
 *
 * None of these enumerates a real directory on the the user's machine, so the
 * pattern discloses nothing even though it ships to the browser.
 */
const PRIVATE_SEGMENT = /^(?:\.[^\s/\\]+|.*(?:content|fixture|course|paper).*)$/i;

/** Windows drive-letter absolute path, e.g. `C:\a\b`. */
const WINDOWS_ABSOLUTE = /[A-Za-z]:\\[^\s'"()]*/g;
/** UNC path, e.g. `\\server\share\...`. */
const UNC_PATH = /\\\\[^\s'"()]+/g;
/**
 * POSIX absolute path with at least two segments, e.g. `/home/a/b`.
 *
 * The leading separator must sit at a **boundary** (start of string, whitespace,
 * quote or opening bracket). Without that anchor the pattern would also eat the
 * tail of a relative fragment — `x-content/courses/y` would lose everything from
 * `/courses` onwards and leave the first segment exposed. That was a real
 * defect in the previous revision, and it is why the anchor is load-bearing
 * rather than cosmetic.
 */
const POSIX_ABSOLUTE = /(^|[\s'"（(\[])\/(?:[^\s/'"()]+\/)+[^\s/'"()]*/g;
/**
 * A candidate token: a run of characters that contains at least one path
 * separator.
 *
 * Whitespace, quotes, brackets and colon-like punctuation terminate a token.
 * Colons matter because the surrounding prose is usually of the form
 * `<human explanation>：<path>`; without them the token would start inside the
 * explanation and the whole phrase (`course.json：…`) would be replaced instead
 * of only the path. Keeping the file name and losing only the layout is the
 * intended trade.
 */
const TOKEN_STOP = `\\s'"()，。；、）】：:`;
const CANDIDATE_TOKEN = new RegExp(`[^${TOKEN_STOP}]+[\\\\/][^${TOKEN_STOP}]*`, "g");

/** Add a placeholder for every duplicated run of placeholders left behind. */
const PLACEHOLDER_RUN = new RegExp(
  `(?:${PATH_PLACEHOLDER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[\\s/\\\\]*)+`,
  "g",
);

/**
 * Rewrite a possibly path-bearing string into safe display text.
 *
 * Order matters: absolute paths are removed first (they may *contain* private
 * segments), then leftover relative fragments are judged segment by segment.
 */
export function sanitizeDisplayText(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return "";

  let text = String(raw);

  text = text.replace(WINDOWS_ABSOLUTE, PATH_PLACEHOLDER);
  text = text.replace(UNC_PATH, PATH_PLACEHOLDER);
  text = text.replace(POSIX_ABSOLUTE, (_match: string, boundary: string) => `${boundary}${PATH_PLACEHOLDER}`);

  /*
   * Leftover relative fragments, e.g. `some-content/courses/x`.
   *
   * A fragment is replaced only when at least one of its segments looks like a
   * private directory, so ordinary prose that happens to contain a slash
   * ("reading/listening 交替") is left alone. Replacing is the safe direction:
   * the worst case is losing a directory name the learner never needed.
   */
  text = text.replace(CANDIDATE_TOKEN, (token: string) => {
    const segments = token.split(/[\\/]+/).filter((segment) => segment !== "");
    if (segments.length < 2) return token;
    const hasPrivateSegment = segments.some((segment) => PRIVATE_SEGMENT.test(segment));
    return hasPrivateSegment ? PATH_PLACEHOLDER : token;
  });

  // Collapse duplicate placeholders and redundant whitespace produced above.
  text = text.replace(PLACEHOLDER_RUN, PATH_PLACEHOLDER);
  return text.replace(/\s{2,}/g, " ").trim();
}

/**
 * Assert that a string carries **no** path trace (used by tests and
 * architecture guards).
 *
 * The predicate is deliberately conservative: a drive letter, a UNC prefix, an
 * absolute POSIX path, or a multi-segment fragment with a private-looking
 * segment all count as a hit.
 */
export function containsPathLeak(text: string): boolean {
  const value = String(text);
  if (/[A-Za-z]:\\/.test(value)) return true;
  if (/\\\\/.test(value)) return true;
  if (/(^|[\s'"（(\[])\/(?:[^\s/'"()]+\/)+/.test(value)) return true;
  const fragments = value.match(CANDIDATE_TOKEN) ?? [];
  return fragments.some((fragment) => {
    const segments = fragment.split(/[\\/]+/).filter((segment) => segment !== "");
    return segments.length >= 2 && segments.some((segment) => PRIVATE_SEGMENT.test(segment));
  });
}
