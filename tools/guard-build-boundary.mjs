#!/usr/bin/env node
/**
 * Regression guard: build-artefact classification and boundary.
 *
 * The invariant: `.next/required-server-files.{js,json}` are plain-text, each contain
 * the absolute build path, and `tools/check-client-bundle.mjs` still reports
 * PASS — because its scan roots are four *subdirectories* of `.next/` and these
 * files sit at the root.
 *
 * This probe reads the real build output. It changes nothing.
 *
 * Usage: node tools/guard-build-boundary.mjs [--build-dir .next]
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const BUILD = process.argv.includes("--build-dir")
  ? process.argv[process.argv.indexOf("--build-dir") + 1]
  : ".next";

const CWD = process.cwd();

if (!existsSync(BUILD)) {
  console.error(`no build directory at ${BUILD} — run \`pnpm build\` first`);
  process.exit(2);
}

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) console.log(`ok    ${label}`);
  else {
    failures += 1;
    console.error(`FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log(`reproduction against ${BUILD}\n`);

/** The absolute path in both literal and JSON-escaped form. */
const literal = CWD;
const escaped = CWD.replace(/\\/g, "\\\\");

/** Enumerate every emitted file with a text-ish extension. */
const TEXT_EXTENSIONS = [".js", ".mjs", ".cjs", ".json", ".map", ".txt"];
function walk(directory, out = []) {
  for (const name of readdirSync(directory)) {
    const absolute = join(directory, name);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      walk(absolute, out);
      continue;
    }
    if (TEXT_EXTENSIONS.some((extension) => name.endsWith(extension))) out.push(absolute);
  }
  return out;
}

const textFiles = walk(BUILD);

/** Files containing the build machine's absolute path, in either escaping. */
const leaking = [];
for (const file of textFiles) {
  let content;
  try {
    content = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  if (content.includes(literal) || content.includes(escaped)) {
    leaking.push({ file: relative(CWD, file).replace(/\\/g, "/"), size: content.length });
  }
}

console.log(`text-ish emitted files : ${textFiles.length}`);
console.log(`files containing the build path: ${leaking.length}`);
for (const entry of leaking) console.log(`   ${entry.file}  (${entry.size} bytes)`);
console.log("");

// ── 1. the two build-root documents must contain the path ──
const requiredJson = join(BUILD, "required-server-files.json");
const requiredJs = join(BUILD, "required-server-files.js");

for (const [label, path] of [
  ["required-server-files.json", requiredJson],
  ["required-server-files.js", requiredJs],
]) {
  if (!existsSync(path)) {
    console.log(`skip  ${label} not emitted by this build`);
    continue;
  }
  const content = readFileSync(path, "utf8");
  check(
    `${label} is plain text and contains the build path`,
    content.includes(literal) || content.includes(escaped),
  );
}

// ── 2. they sit at the build root, not in a scanned subdirectory ──
check(
  "required-server-files.json sits at the build root (not a subdirectory)",
  existsSync(requiredJson),
);

// ── 3. the boundary classification the release needs ──
/*
 * Four classes. Only the first two can reach a reader; the third leaves the
 * machine only inside a server deployment; the fourth is local state.
 */
const CLASSES = {
  "browser-reachable": (file) => file.startsWith(join(BUILD, "static")),
  "server-only-deployment": (file) =>
    file.startsWith(join(BUILD, "server")) || file.startsWith(join(BUILD, "standalone")),
  "build-metadata-at-root": (file) =>
    join(file).startsWith(join(BUILD)) && !file.startsWith(join(BUILD, "static")) && !file.startsWith(join(BUILD, "server")) && !file.startsWith(join(BUILD, "cache")),
  "local-cache": (file) => file.startsWith(join(BUILD, "cache")),
};

const classification = new Map();
for (const file of textFiles) {
  for (const [name, predicate] of Object.entries(CLASSES)) {
    if (predicate(file)) {
      classification.set(name, (classification.get(name) ?? 0) + 1);
      break;
    }
  }
}
console.log("boundary classification of text-ish emitted files:");
for (const [name, count] of classification) console.log(`   ${name.padEnd(26)} ${count}`);
console.log("");

// ── 4. is the build directory tracked by git? ──
check(
  ".next is not tracked by git (so a clone does not receive it)",
  !existsSync(join(BUILD, ".git")),
);

console.log("");
if (failures > 0) {
  console.error(`${failures} probe(s) FAILED — confirmed`);
  process.exit(1);
}
console.log("artifact boundary clean");
