#!/usr/bin/env node
/**
 * Enumerate dependency licences from the installed tree.
 *
 * ── Why this exists ──
 *
 * `THIRD-PARTY-NOTICES.md` is a legal document, so it must not be maintained by
 * hand: hand-maintained licence lists drift silently the moment a dependency is
 * added, and nobody notices until a redistribution question is asked. This tool
 * derives the list from what is actually installed, so "regenerate and diff" is
 * a reviewable check.
 *
 * It reads `package.json` files under `<pnpm-store-entry>/node_modules/`, which
 * is where pnpm places the real packages behind its symlinks. It follows
 * no symlinks into the store, makes no network calls and executes nothing from
 * the packages it inspects.
 *
 * Usage:
 *   node tools/dependency-notices.mjs [--json]
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const STORE = join(process.cwd(), "node_modules", ".pnpm");

if (!existsSync(STORE)) {
  console.error("node_modules/.pnpm not found - run 'pnpm install' first.");
  process.exit(2);
}

/** Read a package.json defensively: a malformed one is reported, never thrown. */
function readPackageJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/** Collect direct dependencies (with their declared licence) from the root manifest. */
function directDependencies() {
  const root = readPackageJson(join(process.cwd(), "package.json")) ?? {};
  const result = new Map();
  for (const field of ["dependencies", "devDependencies"]) {
    for (const name of Object.keys(root[field] ?? {})) result.set(name, { field });
  }
  return result;
}

const packages = new Map();
for (const entry of readdirSync(STORE)) {
  const modules = join(STORE, entry, "node_modules");
  if (!existsSync(modules)) continue;

  const candidates = [];
  for (const name of readdirSync(modules)) {
    if (name === ".bin" || name.startsWith(".")) continue;
    if (name.startsWith("@")) {
      for (const scoped of readdirSync(join(modules, name))) {
        candidates.push(join(modules, name, scoped));
      }
      continue;
    }
    candidates.push(join(modules, name));
  }

  for (const directory of candidates) {
    const manifest = readPackageJson(join(directory, "package.json"));
    if (manifest === null || !manifest.name || !manifest.version) continue;
    // Keep the first occurrence: pnpm may place several versions of the same
    // package, and the notices only need each licence family described once.
    if (packages.has(manifest.name)) continue;
    packages.set(manifest.name, {
      version: manifest.version,
      license: manifest.license ?? (Array.isArray(manifest.licenses) ? manifest.licenses.map((l) => l.type ?? l).join(" OR ") : "(not declared)"),
      repository: typeof manifest.repository === "string" ? manifest.repository : manifest.repository?.url ?? "",
    });
  }
}

const direct = directDependencies();
const sorted = [...packages.entries()].sort(([a], [b]) => a.localeCompare(b));

if (process.argv.includes("--json")) {
  console.log(
    JSON.stringify(
      sorted.map(([name, info]) => ({ name, ...info, direct: direct.has(name) })),
      null,
      2,
    ),
  );
  process.exit(0);
}

const byLicense = new Map();
for (const [name, info] of sorted) {
  if (!byLicense.has(info.license)) byLicense.set(info.license, []);
  byLicense.get(info.license).push(`${name}@${info.version}`);
}

console.log(`# Dependency licence inventory\n`);
console.log(`distinct packages installed: ${sorted.length}`);
console.log(`declared as direct dependencies: ${sorted.filter(([name]) => direct.has(name)).length}\n`);

console.log("## Direct dependencies\n");
for (const [name, info] of sorted) {
  if (!direct.has(name)) continue;
  console.log(`- \`${name}@${info.version}\` — ${info.license}${info.repository ? ` — ${info.repository}` : ""}`);
}

console.log("\n## Licence distribution\n");
console.log("| Licence | Count |");
console.log("| --- | --- |");
for (const [license, names] of [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`| ${license} | ${names.length} |`);
}

console.log("\n## Packages by licence\n");
for (const [license, names] of [...byLicense.entries()].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`### ${license} (${names.length})\n`);
  console.log(names.join(", "));
  console.log("");
}

const undeclared = sorted.filter(([, info]) => info.license === "(not declared)");
if (undeclared.length > 0) {
  console.error(`\nWARNING: ${undeclared.length} package(s) declare no licence:`);
  for (const [name, info] of undeclared) console.error(`  ${name}@${info.version}`);
  process.exit(1);
}
