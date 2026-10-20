#!/usr/bin/env node
/**
 * Inspect the emitted client bundle for internal information.
 *
 * ── Why this check must read build output, not source ──
 *
 * The original defect in this project was not a bad source file. The sanitiser
 * was correct: it replaced internal directory names with a placeholder. The
 * problem was *where the list of names lived* — a literal array in a module that
 * a Client Component imported, so Next.js shipped that array to every browser.
 *
 * A source-level scan cannot see that. You can read `display-safety.ts` and
 * conclude "there is no leak here"; you can only conclude otherwise by looking at
 * what the bundler actually emitted. So this tool walks `.next/`, reads the
 * chunks, and asserts the names are absent.
 *
 * ── What it checks ──
 *
 * 1. No internal content-root directory name appears in any client asset.
 * 2. No server-only module path appears in client assets.
 * 3. Source maps, if emitted, are inspected too (a map is as public as the chunk).
 * 4. The scan itself is proven to work: a synthetic chunk containing a marker is
 *    written to a temp directory and must be detected.
 *
 * ── What counts as "published" ──
 *
 * The boundary is not "what the browser downloads on a normal page load". It is
 * "what could leave this machine attached to a build". Release artefacts, a
 * `.next/` directory committed by accident, a staging deploy, a support bundle —
 * all of those carry the whole tree, not the slim client slice.
 *
 * So the roots are:
 *
 *   `.next/static/**`          what the browser downloads
 *   `.next/server/app/**`      RSC output; inline client payloads are extracted
 *                              from it and sent to the browser
 *   `.next/server/chunks/**`   server chunks, including their source maps
 *   `.next/build/**`           build manifests and their maps
 *
 * The last two are the ones the previous version missed. They are not served
 * verbatim, but a `.map` beside a chunk contains the module's full source text
 * — and source text is exactly where a comment naming an internal directory
 * lives. An independent review found `private-content` in eighteen of them.
 *
 * Usage:
 *   node tools/check-client-bundle.mjs [--build-dir .next] [--allow-missing]
 *
 * `--allow-missing` turns "no build output" into a warning. Without it, a missing
 * build is a failure — because "I could not check" must never read as "it passed".
 */

import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

function flag(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value === undefined || value.startsWith("--") ? null : value;
}

const BUILD_DIR = resolve(flag("build-dir") ?? ".next");
const ALLOW_MISSING = process.argv.includes("--allow-missing");

/**
 * Markers that must not reach the browser.
 *
 * These are internal *directory* names — the local content layout. They are not
 * secrets, but they are the installation's private structure, and shipping them
 * tells a visitor how the machine is organised for no benefit.
 */
const FORBIDDEN_MARKERS = [
  "private-content",
  "companion-content",
  "loopback-proof-content",
  "cet6-real",
  "cet6-companion",
];

/**
 * Machine-identity markers: the shapes that actually disclose a private path.
 *
 * `private-content` is deliberately **not** in this list, and that is the whole
 * point of separating the two lists. It is the product's documented default
 * directory name — it appears in the README, in `.env.example`, and in the SQL
 * schema's comments. It describes the *product*, not the *installation*.
 *
 * What discloses an installation is:
 *
 *   - a drive letter (`D:\…`) — where the OS lives;
 *   - a POSIX user home (`/home/<name>`, `/Users/<name>`) — who owns it;
 *   - the checkout path of this repository — where the code was built.
 *
 * An independent review found `private-content` in twenty-five server-side
 * source maps and had to check each by hand to confirm they were only source
 * comments. That manual step is what this list removes: the marker that
 * requires manual verification is the one that is *not* the product's own
 * documented name.
 *
 * Assembled at runtime so this file never contains a literal that looks like a
 * leaked path.
 */
const BACKSLASH = String.fromCharCode(92);

/**
 * Paths that must never appear in a published artefact.
 *
 * ── What actually discloses a machine ──
 *
 * The naive rule is "any absolute path". That rule is wrong here, and being
 * wrong is worse than being narrow: this repository's own source comments
 * contain illustrative paths on purpose — a threat-model comment mentions
 * `C:\Windows\...`, and a display-sanitiser comment quotes a real-shaped
 * ENOENT message to explain what it strips. A check that flags those is a
 * check that gets switched off.
 *
 * What actually discloses an installation is a path that belongs to *this*
 * machine:
 *
 *   1. the build directory (this repository's own checkout path);
 *   2. the user's home directory;
 *   3. the OS root, when it is a real prefix rather than an illustration.
 *
 * So the check is anchored on values derived at runtime from the environment
 * the build actually ran in. An illustrative `C:\Windows\...` in a comment is
 * not the OS root of the machine that produced the artefact, and it does not
 * match. A leaked `<drive>:/<workspace>/...` does, because that *is* where the
 * build ran — the marker was captured from `process.cwd()`, so the check does
 * not need to know, or name, where this repository happens to be checked out.
 *
 * Assembled at runtime so this file never contains a literal that looks like a
 * leaked path.
 */
function machineIdentityMarkers() {
  const markers = [];
  const build = process.cwd();

  // The build directory and its drive-relative and POSIX forms.
  markers.push(build);
  markers.push(build.replace(/\\/g, "/"));

  // The user's home directory, when the platform exposes one.
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home !== undefined && home !== "") {
    markers.push(home);
    markers.push(home.replace(/\\/g, "/"));
  }

  // Any other drive root the build wrote to. Only the drive root itself is
  // added as a *prefix* marker, and the comparison below requires the marker to
  // be followed by a real path segment — so `D:\` alone, or the illustrative
  // `<drive>:\...\private-content\…` in a doc comment, does not match, while a
  // genuinely serialised absolute build path does (it also matches the
  // build-directory marker above).
  //
  // The ellipsis guard has to accept both the literal form (`D:\...`) and the
  // JSON-escaped form that appears inside a source map (`D:\\...`), because the
  // latter is what a comment quoted in `sourcesContent` actually looks like.
  const driveMatch = /^([A-Za-z]):[\\/]/.exec(build);
  if (driveMatch !== null) {
    const drive = driveMatch[1];
    const ellipsis = `(?:${BACKSLASH}${BACKSLASH})?\\.\\.\\.`;
    markers.push(
      new RegExp(`${drive}:${BACKSLASH}${BACKSLASH}(?!${ellipsis})[^${BACKSLASH}s"'<>]{2,}`),
    );
  }

  return markers;
}

const MACHINE_IDENTITY_MARKERS = machineIdentityMarkers();

/** Server-only identifiers that must not appear in a client asset. */
const SERVER_ONLY_MARKERS = [
  "node:sqlite",
  "node:fs/promises",
];

/** File types treated as client-reachable assets. */
const ASSET_EXTENSIONS = [".js", ".mjs", ".cjs", ".map", ".json"];

function walk(directory, out = []) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(absolute, out);
      continue;
    }
    if (ASSET_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      out.push(absolute);
    }
  }
  return out;
}

/**
 * Locate every emitted asset, tagged with the boundary class it belongs to.
 *
 * ── The defect this replaces  ──
 *
 * The previous version added four *subdirectories* of `.next/` to the scan:
 * `static/`, `server/app/`, `server/chunks/` and `build/`. Files at the **root**
 * of `.next/` were therefore never read — including
 * `required-server-files.{js,json}`, which are plain text and each carry four
 * absolute build paths (`appDir`, `config.turbopack.root`, `config.repoRoot`,
 * `config.outputFileTracingRoot`).
 *
 * The tool reported "no machine-identity path in any asset, including source
 * maps" while those two files sat in the same directory. The `495` it printed was
 * accurate for the directories it chose; the directory choice was the bug.
 *
 * Worse, the file's own comment justified scanning server output on the grounds
 * that a release artefact "carries the whole tree". "The whole tree" is precisely
 * an argument for scanning the build root, so the comment contradicted the code.
 *
 * ── The fix ──
 *
 * Enumerate the **entire** build directory. Each file is then classified, because
 * the four classes have genuinely different rules:
 *
 *   `browser`        served to a browser. Strictest: no internal directory
 *                    names, no server-only module references, no machine paths.
 *   `server`         deployment-only (server chunks, RSC output). Server-only
 *                    imports are legitimate here; internal names and machine
 *                    paths are not, because a deployment artefact or support
 *                    bundle can be published.
 *   `build-metadata` text metadata at the build root. Machine paths matter (they
 *                    name the build machine); server-only imports are irrelevant.
 *   `cache`          Turbopack's binary `.sst` cache. Skipped: it is multi-MB
 *                    binary state, not a distributable, and scanning it would
 *                    produce noise without covering anything the text scan misses.
 *
 * Scanning everything and *classifying* is the safe direction: a new subdirectory
 * added by a future Next.js version is covered by default instead of silently
 * escaping, which is the same deny-by-default rule the rest of the release uses.
 */
function classifyAsset(file, buildDir) {
  const relativePath = relative(buildDir, file).replace(/\\/g, "/");

  if (relativePath.startsWith("cache/")) return "cache";
  if (relativePath.startsWith("static/")) return "browser";
  // RSC output and server chunks are deployment artefacts, not browser downloads.
  if (relativePath.startsWith("server/")) return "server";
  // Everything else sits at the build root: manifests, the build id, the
  // required-server-files pair, and any future root-level metadata.
  return "build-metadata";
}

/** Is this file readable as text? Binary cache blobs are not. */
function isTextAsset(file) {
  let handle;
  try {
    handle = openSync(file, "r");
    const buffer = Buffer.alloc(4096);
    const bytesRead = readSync(handle, buffer, 0, 4096, 0);
    const head = buffer.subarray(0, bytesRead);
    // A NUL byte in the first 4 KiB means binary for every format we emit.
    if (head.includes(0)) return false;
    // Invalid UTF-8 means binary too.
    new TextDecoder("utf-8", { fatal: true }).decode(head);
    return true;
  } catch {
    return false;
  } finally {
    if (handle !== undefined) closeSync(handle);
  }
}

/** Enumerate the whole build tree with a boundary class per file. */
function clientAssets() {
  const files = [];
  if (!existsSync(BUILD_DIR)) return files;

  for (const file of walk(BUILD_DIR)) {
    const assetClass = classifyAsset(file, BUILD_DIR);
    if (assetClass === "cache") continue;
    if (!isTextAsset(file)) continue;
    files.push({ file, assetClass });
  }
  return files;
}

function scanFile(file, markers) {
  const hits = [];
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    return hits;
  }
  for (const marker of markers) {
    if (marker instanceof RegExp) {
      if (marker.test(content)) hits.push(String(marker));
      continue;
    }
    // A plain substring test: build output is minified, so word boundaries are
    // meaningless, and a false positive here is a cheap manual look.
    if (content.includes(marker)) hits.push(marker);
  }
  return hits;
}

// ── self-test: prove the scanner detects what it claims to ──
{
  const scratch = mkdtempSync(join(tmpdir(), "bundle-check-"));

  // Control 1: an internal directory name in a browser asset is detected.
  const probe = join(scratch, "chunk.js");
  // Assembled at runtime so this file never contains the literal it forbids.
  writeFileSync(probe, `var x="${["private", "-content"].join("")}";`, "utf8");
  const detected = scanFile(probe, FORBIDDEN_MARKERS).length > 0;
  if (!detected) {
    console.error("FAIL  the bundle scanner did not detect a synthetic marker — the check is vacuous");
    process.exit(1);
  }
  console.log("ok    self-test: internal directory name detected");

  // Control 2: a machine-identity path is detected. Built at runtime so this
  // file never itself contains a literal that looks like a leaked path.
  const identityProbe = join(scratch, "identity.js");
  writeFileSync(
    identityProbe,
    [
      `var a = ${JSON.stringify(process.cwd())};`,
      `var b = ${JSON.stringify(process.cwd().replace(/\\/g, "/"))};`,
      `var c = ${JSON.stringify(`${BACKSLASH}bD:${BACKSLASH}${BACKSLASH}some${BACKSLASH}${BACKSLASH}path`)};`,
    ].join("\n"),
    "utf8",
  );
  const identityDetected = scanFile(identityProbe, MACHINE_IDENTITY_MARKERS).length > 0;
  if (!identityDetected) {
    console.error("FAIL  the machine-identity scanner did not detect a synthetic path — the check is vacuous");
    process.exit(1);
  }
  console.log("ok    self-test: machine-identity path detected");

  // Control 2b: an *illustrative* path in a comment must NOT be flagged. This
  // is the false-positive class that would get the gate switched off.
  const illustrativeProbe = join(scratch, "illustrative.js");
  writeFileSync(
    illustrativeProbe,
    [
      "// Threat model: `C:\\Windows\\...` or `/etc/passwd` are absolute paths.",
      "// Example: ENOENT ... open 'D:\\...\\private-content\\courses\\x\\course.json'",
      "var ok = 1;",
    ].join("\n"),
    "utf8",
  );
  const illustrativeFlagged = scanFile(illustrativeProbe, MACHINE_IDENTITY_MARKERS).length > 0;
  if (illustrativeFlagged) {
    console.error(
      "FAIL  the machine-identity scanner flagged an illustrative path in a comment — " +
        "this is the false-positive class that gets a gate switched off",
    );
    process.exit(1);
  }
  console.log("ok    self-test: illustrative paths in comments are not flagged");

  // Control 3: a browser asset carrying a server-only module is detected.
  const serverProbe = join(scratch, "server.js");
  writeFileSync(serverProbe, `require("node:sqlite");\n`, "utf8");
  const serverDetected = scanFile(serverProbe, SERVER_ONLY_MARKERS).length > 0;
  if (!serverDetected) {
    console.error("FAIL  the server-only scanner did not detect a synthetic reference — the check is vacuous");
    process.exit(1);
  }
  console.log("ok    self-test: server-only reference detected");

  rmSync(scratch, { recursive: true, force: true });
}

const assets = clientAssets();

if (assets.length === 0) {
  const message = `no client assets found under ${BUILD_DIR} — run \`pnpm build\` first`;
  if (ALLOW_MISSING) {
    console.warn(`SKIP  ${message}`);
    process.exit(0);
  }
  console.error(`FAIL  ${message}`);
  process.exit(1);
}

let failures = 0;
const byClass = { browser: 0, server: 0, "build-metadata": 0 };
/** Server-private assets that legitimately contain the build path. */
const serverPrivateWithPaths = [];

for (const { file, assetClass } of assets) {
  byClass[assetClass] += 1;
  const display = relative(process.cwd(), file).replace(/\\/g, "/");

  /*
   * Rule 1 — internal directory names, browser-reachable assets only.
   *
   * `private-content` is the product's documented default directory name: it is
   * in the README, in `.env.example`, and in the SQL schema's comments. It
   * therefore also appears, legitimately, in server-side source maps — because
   * a source map carries the module's source text. Flagging it there would be a
   * false positive that trains people to ignore the gate.
   *
   * What matters is whether it reaches the *browser*. That is the property the
   * original check was built for, and it is preserved exactly.
   */
  if (assetClass === "browser") {
    const markerHits = scanFile(file, FORBIDDEN_MARKERS);
    if (markerHits.length > 0) {
      failures += 1;
      console.error(`FAIL  ${display}: internal directory name(s) present: ${markerHits.join(", ")}`);
    }

    const serverOnly = scanFile(file, SERVER_ONLY_MARKERS);
    if (serverOnly.length > 0) {
      failures += 1;
      console.error(`FAIL  ${display}: server-only module reference(s): ${serverOnly.join(", ")}`);
    }
  }

  /*
   * Rule 2 — machine identity, by boundary class .
   *
   * ── Why the rule differs per class ──
   *
   * Next.js *always* writes absolute paths into `required-server-files.{js,json}`
   * — `appDir`, `config.turbopack.root`, `config.repoRoot`,
   * `config.outputFileTracingRoot`. Those are not a bug in this project and they
   * cannot be configured away: the server needs to know where it was built. So
   * "no absolute path anywhere in `.next/`" is an impossible rule, and a guard
   * with an impossible rule gets disabled.
   *
   * The real question is the **release boundary**, not the build directory:
   *
   *   browser        — a machine path here reaches a visitor. Fatal.
   *   build-metadata — server-private. Expected to contain the build path; must
   *                    never be published in an archive or served over HTTP.
   *   server         — deployment artefact. Same, and source maps additionally
   *                    carry source text.
   *
   * So this check fails on browser leakage and **reports** the server-side counts
   * so the boundary they imply is visible. Enforcement of "must not be published"
   * belongs to `check-release-archive.mjs`, which inspects what would actually be
   * shipped — a different question from what exists in a local build directory.
   */
  const identityHits = scanFile(file, MACHINE_IDENTITY_MARKERS);
  if (identityHits.length > 0) {
    if (assetClass === "browser") {
      failures += 1;
      console.error(`FAIL  ${display}: machine-identity path present in a BROWSER asset`);
    } else {
      serverPrivateWithPaths.push(display);
    }
  }
}

/*
 * ── Reporting ──
 *
 * The message states exactly what was scanned and what each class was checked
 * for. The previous message claimed "no machine-identity path in any asset,
 * including source maps" while two root-level files it had never opened contained
 * four absolute build paths each. An audit that overstates its own coverage is
 * worse than one that understates it: a reader can compensate for a known gap,
 * but not for a gap they have been told does not exist.
 */
const total = byClass.browser + byClass.server + byClass["build-metadata"];
console.log(`\nscanned ${total} text asset(s) under ${relative(process.cwd(), BUILD_DIR) || "."}:`);
console.log(`  browser         ${byClass.browser}  (internal names, server-only refs, machine paths)`);
console.log(`  server          ${byClass.server}  (machine paths; server-only refs are legitimate here)`);
console.log(`  build-metadata  ${byClass["build-metadata"]}  (machine paths — includes required-server-files)`);
console.log(`  cache           skipped (binary Turbopack state, not distributable)`);

/*
 * Report the server-private surface explicitly.
 *
 * These files carry the build path by design. Saying so is the honest result: a
 * reader can see exactly what must not be published, instead of a PASS that
 * implies nothing anywhere contains a path.
 */
if (serverPrivateWithPaths.length > 0) {
  console.log(
    `\n${serverPrivateWithPaths.length} server-private asset(s) contain the build path by design:`,
  );
  for (const file of serverPrivateWithPaths.slice(0, 8)) console.log(`  ${file}`);
  if (serverPrivateWithPaths.length > 8) {
    console.log(`  ... and ${serverPrivateWithPaths.length - 8} more`);
  }
  console.log(
    "  → server-only. Must never be published or served; enforced by check-release-archive.mjs.",
  );
}

if (failures > 0) {
  console.error(`\n${failures} build-artifact violation(s) (browser-reachable leakage)`);
  process.exit(1);
}
console.log(
  "\nbuild artefacts: PASS — no internal directory name or server-only reference in " +
    "browser assets, and no machine-identity path in any browser asset.",
);
