#!/usr/bin/env node
/**
 * Documentation integrity gate.
 *
 * ── Why this exists ──
 *
 * A documentation reference can silently stop resolving: the README once told
 * readers the repository contained `tools/public-export-policy.json` and
 * `tools/public-export.mjs`. Neither file existed. The export tooling lives
 * outside the public tree on purpose — it names paths from the internal
 * repository — but the README had not been rewritten to match.
 *
 * A README that points at files which are not there is not a cosmetic problem:
 * it is the same class of defect as a gate that claims to check something it
 * does not. The reader cannot tell which statements to trust.
 *
 * ── What it checks ──
 *
 *   1. Every repository-relative path mentioned in a Markdown file exists in
 *      the tracked tree (`git ls-files`), not merely on disk. A path that
 *      exists locally but is git-ignored is still a broken reference for a
 *      reader who clones the repository.
 *   2. Every `pnpm <script>` / `npm run <script>` command mentioned in a
 *      Markdown file resolves to a real script in `package.json`.
 *   3. Every relative Markdown link (`[text](other.md)`) resolves to a file
 *      that exists, and every in-page anchor (`[text](#section)`) resolves to
 *      a heading in that file.
 *
 * ── What it deliberately does not do ──
 *
 * It does not check external URLs. A link to `https://example.com` may be
 * correct today and dead tomorrow; failing a release gate on a third party's
 * uptime would train people to ignore the gate. External links are a
 * documentation-quality concern, not a release-safety one.
 *
 * It does not add a scanning framework. It reads the tree with `git ls-files`
 * and `readFileSync`, and it has no dependencies.
 *
 * Usage:
 *   node tools/check-doc-references.mjs [--root <dir>] [--json]
 *
 * Exit 0 = all references resolve. Exit 1 = a broken reference. Exit 2 = bad
 * invocation.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

// ---------------------------------------------------------------- invocation

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const ROOT = resolve(flag("root") ?? process.cwd());
const JSON_OUTPUT = process.argv.includes("--json");

if (!existsSync(join(ROOT, "package.json"))) {
  console.error(`not a project root (no package.json): ${ROOT}`);
  process.exit(2);
}

// ------------------------------------------------------------- tracked files

/**
 * The set of paths a reader actually gets when they clone.
 *
 * Read from the index rather than the filesystem: a file that exists locally
 * but is git-ignored is invisible to a reader, so a reference to it is still
 * broken. This is the same reason the release gate reads the index for its
 * history audit.
 */
function trackedFiles() {
  const output = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return new Set(output.split("\0").filter((entry) => entry !== ""));
}

/** Markdown files that are part of the public surface. */
function markdownFiles(tracked) {
  return [...tracked].filter((path) => path.endsWith(".md")).sort();
}

/** Script names declared in package.json. */
function declaredScripts() {
  const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  return new Set(Object.keys(manifest.scripts ?? {}));
}

// ------------------------------------------------------------ path extraction

/**
 * Repository-relative paths mentioned in prose.
 *
 * Matches the shapes a README actually uses:
 *   - inline code spans:            `tools/foo.mjs`
 *   - fenced blocks and bare text:  tools/foo.mjs
 *
 * Deliberately narrow, and the narrowness is load-bearing:
 *
 *   - it only accepts a path that *starts* with a known top-level directory;
 *   - it requires a **file extension**. `src/domain/`, `src/repositories` and
 *     `src/content/pipeline/` are directory references; a directory cannot be
 *     resolved to a blob, and flagging it would produce noise that gets the
 *     gate ignored. (This is why the check is on file references specifically.)
 */
const KNOWN_ROOTS = [
  "tools/",
  "scripts/",
  "src/",
  "tests/",
  "e2e/",
  "docs/",
  "content-policy/",
  "public/",
  ".github/",
];

/** Does this candidate look like a file path rather than a directory? */
function looksLikeFile(candidate) {
  // A trailing slash means it is a directory reference.
  if (candidate.endsWith("/")) return false;
  // A glob is not a path: `tools/*.mjs` and `src/**` describe sets, and a
  // member of the set may or may not exist. Flagging one would be a false
  // positive on legitimate configuration (`.gitattributes` uses this form).
  if (candidate.includes("*")) return false;
  // Otherwise require an extension on the last segment.
  const last = candidate.split("/").pop() ?? "";
  return /\.[A-Za-z0-9]+$/.test(last);
}

function mentionedPaths(text) {
  const found = new Set();
  const candidates = new Set();

  // Inline code spans first: they are the unambiguous case.
  for (const span of text.match(/`[^`\n]+`/g) ?? []) {
    const inner = span.slice(1, -1).trim();
    for (const root of KNOWN_ROOTS) {
      if (inner.startsWith(root) && inner.length > root.length) candidates.add(inner);
    }
  }
  // Then bare occurrences in prose.
  for (const root of KNOWN_ROOTS) {
    const escaped = root.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
    for (const match of text.match(new RegExp(`${escaped}[A-Za-z0-9_@./-]+`, "g")) ?? []) {
      candidates.add(match);
    }
  }

  for (const candidate of candidates) {
    // Strip trailing punctuation that prose adds around a code span.
    const cleaned = candidate.replace(/[.,;:)]+$/, "");
    if (!looksLikeFile(cleaned)) continue;
    // A URL is not a repository path.
    //
    // `https://nodejs.org/docs/latest-v24.x/api/sqlite.html` and
    // `https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/api.js`
    // both *contain* something that looks like a repository path, but they are
    // external documentation. A link to a third party's site is not a
    // release-safety concern (see the file header), so any candidate that
    // occurs inside a URL is skipped rather than reported.
    const insideUrl = new RegExp(
      `[a-z][a-z0-9+.-]*://[^\\s"'()]*${cleaned.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
      "i",
    ).test(text);
    if (insideUrl) continue;
    found.add(cleaned);
  }
  return [...found];
}

/**
 * `pnpm <script>` / `npm run <script>` commands mentioned in prose.
 *
 * pnpm and npm also have *built-in* subcommands (`install`, `exec`, `test`,
 * `run`, `add`, `dlx`). Those are not package scripts, so flagging them would
 * be noise. Only unknown subcommands are reported.
 */
const PACKAGE_MANAGER_BUILTINS = new Set([
  "install",
  "i",
  "add",
  "update",
  "up",
  "remove",
  "rm",
  "uninstall",
  "exec",
  "x",
  "dlx",
  "run",
  "test",
  "t",
  "start",
  "build",
  "create",
  "init",
  "link",
  "unlink",
  "list",
  "ls",
  "outdated",
  "store",
  "why",
  "audit",
  "publish",
  "pack",
  "prune",
  "rebuild",
  "root",
  "bin",
  "config",
  "info",
  "search",
  "view",
  "doctor",
  "env",
  "setup",
  "import",
  "verify",
]);

function mentionedScripts(text) {
  const found = new Set();
  for (const match of text.matchAll(/\b(?:pnpm|npm run|yarn)\s+([a-z][a-z0-9:-]*)/gi)) {
    const name = match[1];
    if (PACKAGE_MANAGER_BUILTINS.has(name)) continue;
    found.add(name);
  }
  return [...found];
}

/**
 * Relative Markdown links: `[text](target)` where target is not a URL.
 *
 * A link to a **directory** (`[text](docs/)`) is legitimate Markdown and is
 * rendered by GitHub as a directory listing. It is resolved against the
 * tracked file set by prefix, so `docs/` passes when any `docs/*` file exists.
 */
function relativeLinks(text) {
  const found = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#)/.test(target)) continue;
    found.push(target.split("#")[0]);
  }
  return found;
}

/** In-page anchors: `[text](#anchor)`. */
function anchors(text) {
  const found = [];
  for (const match of text.matchAll(/\[[^\]]*\]\(#([^)\s]+)\)/g)) {
    found.push(match[1]);
  }
  return found;
}

/** GitHub-style heading anchor for a heading line. */
function headingAnchor(line) {
  return line
    .replace(/^#+\s*/, "")
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

// ------------------------------------------------------------------- the scan

const tracked = trackedFiles();
const scripts = declaredScripts();
const docs = markdownFiles(tracked);

const violations = [];
let pathsChecked = 0;
let scriptsChecked = 0;
let linksChecked = 0;
let anchorsChecked = 0;
let sourceRefsChecked = 0;

for (const doc of docs) {
  const text = readFileSync(join(ROOT, ...doc.split("/")), "utf8");

  // 1. mentioned repository paths must be tracked
  for (const path of mentionedPaths(text)) {
    pathsChecked += 1;
    if (!tracked.has(path)) {
      violations.push({
        file: doc,
        kind: "missing-path",
        detail: `mentions \`${path}\`, which is not in the tracked tree`,
      });
    }
  }

  // 2. mentioned package scripts must be declared
  for (const script of mentionedScripts(text)) {
    scriptsChecked += 1;
    if (!scripts.has(script)) {
      violations.push({
        file: doc,
        kind: "missing-script",
        detail: `mentions \`${script}\`, which is not a script in package.json`,
      });
    }
  }

  // 3. relative Markdown links must resolve
  for (const target of relativeLinks(text)) {
    if (target === "") continue;
    linksChecked += 1;
    const resolved = doc.includes("/") ? join(doc, "..", target) : target;
    // `relative()` drops a trailing separator, so re-add it when the link
    // itself was written with one — that is what distinguishes a directory
    // link (`docs/`) from a file link (`docs/x.md`).
    const normalised =
      relative(ROOT, resolve(ROOT, resolved)).replace(/\\/g, "/") + (target.endsWith("/") ? "/" : "");
    // A link may point at a file or, when it ends in `/`, at a directory.
    // GitHub renders a directory link as a listing, so it is legitimate.
    const isDirectoryLink = normalised.endsWith("/");
    const exists = isDirectoryLink
      ? [...tracked].some((path) => path.startsWith(normalised))
      : tracked.has(normalised);
    if (!exists) {
      violations.push({
        file: doc,
        kind: "broken-link",
        detail: `links to \`${target}\`, which does not resolve to a tracked file`,
      });
    }
  }

  // 4. in-page anchors must resolve to a heading in the same file
  const headings = new Set(
    text
      .split("\n")
      .filter((line) => /^#{1,6}\s/.test(line))
      .map(headingAnchor),
  );
  for (const anchor of anchors(text)) {
    anchorsChecked += 1;
    if (!headings.has(anchor)) {
      violations.push({
        file: doc,
        kind: "broken-anchor",
        detail: `links to \`#${anchor}\`, which is not a heading in this file`,
      });
    }
  }
}

/*
 * ── 5. documentation references inside source code  ──
 *
 * The check above only read `.md` files. Source comments were invisible, and a
 * comment in `src/content/course-pipeline/inspection.ts` cited a document that
 * had never been committed — a dangling reference to an internal engineering
 * record, sitting in the public source, that no gate could see.
 *
 * Two rules, both structural:
 *
 *   a. A `docs/*.md` path mentioned in ANY source file must be tracked.
 *   b. It must also not be a path the release gate forbids. Rule (a) alone would
 *      not catch a file that exists but is withheld from the distribution — and
 *      the withheld set is exactly where internal narrative lives.
 *
 * ── Why this does not hardcode private document names ──
 *
 * Enumerating the forbidden names here would publish them: a scanner containing a
 * list of internal document titles *is* a publication of those titles, and it
 * would be the third place they are written down. Instead rule (b) reads the
 * forbidden-path patterns from the release gate itself, so the single source of
 * truth stays single and this file names no private document.
 *
 * The scanned set is *source*, not every file: markdown is already covered above,
 * and scanning the whole tree twice would double-report.
 */
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".mjs", ".cjs"];
const sourceFiles = [...tracked].filter((path) => SOURCE_EXTENSIONS.some((extension) => path.endsWith(extension)));

/**
 * Read the gate's own forbidden-path table so no private name is repeated here.
 *
 * If the gate's table cannot be parsed, this rule reports itself unverified rather
 * than silently passing — an unparseable source of truth is a failure, not a skip.
 */
function forbiddenReferencePatterns() {
  const gatePath = join(ROOT, "tools", "public-release-check.mjs");
  let gateSource;
  try {
    gateSource = readFileSync(gatePath, "utf8");
  } catch {
    return null;
  }
  const tableMatch = /const FORBIDDEN_PATHS = \[([\s\S]*?)\n\];/.exec(gateSource);
  if (tableMatch === null) return null;

  const patterns = [];
  const patternSource = /\[(\/.*?\/[gimsuy]*),\s*"[^"]*"\]/g;
  let match;
  while ((match = patternSource.exec(tableMatch[1])) !== null) {
    const [, literal] = match;
    const lastSlash = literal.lastIndexOf("/");
    const body = literal.slice(1, lastSlash);
    const flags = literal.slice(lastSlash + 1);
    try {
      patterns.push(new RegExp(body, flags));
    } catch {
      // A pattern we cannot compile is reported by the gate itself; skip here.
    }
  }
  return patterns.length > 0 ? patterns : null;
}

const forbiddenPatterns = forbiddenReferencePatterns();
if (forbiddenPatterns === null) {
  violations.push({
    file: "tools/public-release-check.mjs",
    kind: "unverifiable-source-references",
    detail:
      "cannot read the gate's forbidden-path table, so source doc references are UNVERIFIED — " +
      "an unreadable source of truth is a failure, not a skip",
  });
}

/**
 * `docs/something.md` paths mentioned anywhere in a source file.
 *
 * ── Comments are deliberately NOT stripped ──
 *
 * The first draft stripped comments, on the theory that an example in a comment
 * is illustrative rather than a citation. That was backwards, and a probe caught
 * it: the actual defect was a **comment** citing a withheld document, so
 * stripping comments removed precisely the case the rule exists for. The rule
 * then passed while the defect it was written to find sat untouched.
 *
 * This is the same failure the whole engagement keeps producing in new clothes:
 * a check that removes the thing it is supposed to inspect. The fix is to keep
 * comments and instead exclude the *synthetic names* used by negative controls,
 * which is a narrow, visible list rather than a whole syntactic class.
 */
const SYNTHETIC_DOC_SEGMENTS = new Set([
  "x.md",
  "y.md",
  "something.md",
  "not-a-real-file.md",
  "not-a-secret.md",
  "leak.md",
  "probe.md",
  "example.md",
]);

function mentionedDocsPaths(text) {
  const found = new Set();
  const pattern = /(?:^|[^\w/.-])(docs\/[A-Za-z0-9._/-]+\.md)\b/g;
  let match;
  while ((match = pattern.exec(text)) !== null) {
    const reference = match[1];
    const basename = reference.split("/").pop() ?? "";
    if (SYNTHETIC_DOC_SEGMENTS.has(basename)) continue;
    found.add(reference);
  }
  return found;
}

for (const file of sourceFiles) {
  let text;
  try {
    text = readFileSync(join(ROOT, ...file.split("/")), "utf8");
  } catch {
    continue;
  }
  for (const reference of mentionedDocsPaths(text)) {
    sourceRefsChecked += 1;

    // (a) every referenced document must exist in the tracked tree
    if (!tracked.has(reference)) {
      violations.push({
        file,
        kind: "dangling-source-doc-reference",
        detail:
          `cites \`${reference}\`, which is not a tracked file — ` +
          `the reference is dangling, and naming an unpublished document ` +
          `tells a reader it exists`,
      });
      continue;
    }

    // (b) it must also not be a path withheld from the distribution
    if (forbiddenPatterns !== null) {
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(reference)) {
          violations.push({
            file,
            kind: "withheld-doc-reference",
            detail:
              `cites \`${reference}\`, which the release gate forbids from the ` +
              `distribution — the document is deliberately not published`,
          });
          break;
        }
      }
    }
  }
}

// --------------------------------------------------------------------- output

const summary = {
  root: ROOT,
  ok: violations.length === 0,
  checked: {
    documents: docs.length,
    paths: pathsChecked,
    scripts: scriptsChecked,
    links: linksChecked,
    anchors: anchorsChecked,
    sourceDocReferences: sourceRefsChecked,
    sourceFiles: sourceFiles.length,
  },
  violations,
};

if (JSON_OUTPUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`documentation reference check — ${ROOT}\n`);
  console.log(
    `  ${docs.length} markdown file(s): ` +
      `${pathsChecked} path(s), ${scriptsChecked} command(s), ` +
      `${linksChecked} link(s), ${anchorsChecked} anchor(s) checked`,
  );
  console.log(
    `  ${sourceFiles.length} source file(s): ${sourceRefsChecked} documentation reference(s) checked\n`,
  );
  if (violations.length === 0) {
    console.log("all documentation references resolve");
  } else {
    for (const violation of violations) {
      console.log(`[FAIL] ${violation.file}: ${violation.detail}`);
    }
    console.log(`\n${violations.length} broken reference(s)`);
  }
}

process.exit(violations.length === 0 ? 0 : 1);
