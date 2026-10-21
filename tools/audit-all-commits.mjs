#!/usr/bin/env node
/**
 * Audit **every commit**, not just the checkout.
 *
 * ── Why the working-tree gate is not enough ──
 *
 * A file removed in a later commit is still reachable through history. This was
 * a real defect in the internal repository: an acceptance-evidence document was
 * added, then deleted, and the delete commit did nothing to remove the object
 * because an earlier ref still reached it. A clean `HEAD` therefore says nothing
 * about what a reader can obtain.
 *
 * This tool walks every commit in the range, and for each one inspects:
 *
 *   - the commit metadata (author, committer, both dates, message)
 *   - the **full tree** at that commit, not the diff
 *   - each blob's content against the same rules the working-tree gate uses
 *
 * Walking the full tree at each commit rather than the diff is deliberately
 * redundant: a diff tells you what changed, but the question here is "was this
 * ever present", and a tree listing answers that directly without having to
 * replay diffs correctly across merges and renames.
 *
 * ── What it never prints ──
 *
 * Paths, hashes, categories and counts. It never prints file contents, and never
 * prints a matched string — the material being audited is the material that must
 * not be reproduced in a report.
 *
 * Usage:
 *   node --experimental-transform-types tools/audit-all-commits.mjs [--json]
 *
 * Exit 0 = every commit clean. Exit 1 = a commit violates a rule. Exit 2 = not a
 * git repository.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const JSON_OUTPUT = process.argv.includes("--json");

function git(args, options = {}) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

if (!existsSync(".git")) {
  console.error("not a git repository");
  process.exit(2);
}

// ── load the same rule set the working-tree gate uses ──
let rules;
try {
  rules = await import(pathToFileURL(join(process.cwd(), "tests", "support", "paper-fingerprints.ts")).href);
} catch (error) {
  console.error(`cannot load fingerprint rules: ${error.message}`);
  console.error("this audit is UNVERIFIED, which is a failure");
  process.exit(2);
}
const { REAL_PAPER_FINGERPRINTS, scanTextForFingerprints } = rules;

/**
 * Paths that must never have existed in any commit.
 *
 * Broader than the working-tree gate's list on purpose: a path that was once
 * committed and later removed is exactly the case a working-tree check misses.
 */
const FORBIDDEN_EVER = [
  [/(^|\/)\.opc\//, "internal engineering records"],
  [/(^|\/)(AGENTS|CLAUDE)\.md$/, "internal agent-instruction document"],
  [/(^|\/)research-shots\//, "third-party screenshots without redistribution rights"],
  [/^private-content\//, "private study content"],
  [/^companion-content\//, "private study content"],
  [/^loopback-proof-content\//, "private study content"],
  [/^data\//, "local database directory"],
  [/^\.e2e\//, "E2E scratch data"],
  [/^\.next\//, "build output"],
  [/^node_modules\//, "installed dependencies"],
  [/^\.pnpm-store\//, "package-manager store"],
  [/(^|\/)public-export-manifest\.json$/, "export tooling output"],
  [/\.(db)(-wal|-shm)?$/, "database"],
  [/\.(log)$/i, "log file"],
  [/\.(pem|key|p12|pfx)$/i, "key material"],
  [/\.(mp3|wav|m4a)$/i, "audio asset"],
  [/\.(pdf|docx)$/i, "document asset"],
  [/\.tsbuildinfo$/, "generated build metadata"],
];

/** Commit-message patterns that must not appear. */
const FORBIDDEN_MESSAGE = [
  [new RegExp("\\b" + ["Qo", "der"].join("") + "\\b", "i"), "internal review role name"],
  [/\bCTO\b/, "internal review role name"],
  [/\bHarness\b/, "internal agent-harness reference"],
  [/\bFINAL\s+PASS\b/i, "internal review verdict"],
  [/\bD-\d{3}\b/, "internal decision-record identifier"],
  [/\.opc\b/, "internal record path"],
  [/\bOwner\b/, "internal role word"],
];

/** Identity shapes that must not appear. */
const FORBIDDEN_IDENTITY = [
  [/@local$/i, "non-routable @local identity"],
  [/^(?:Implementation Agent|agent) </i, "generic agent identity"],
  [/^(?:cet6-prep|cet6)<</i, "project-name placeholder identity"],
];

/** Extensions read as text when scanning blob contents. */
const TEXT_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".css", ".html",
  ".yml", ".yaml", ".txt", ".svg", ".example", ".gitignore", ".gitattributes",
];

const commits = git(["rev-list", "--reverse", "HEAD"]).trim().split("\n").filter(Boolean);
const fingerprints = new Set(REAL_PAPER_FINGERPRINTS);

const results = [];

for (const [index, sha] of commits.entries()) {
  const violations = [];

  // ── metadata ──
  const meta = git(["show", "-s", "--format=%an <%ae>%n%cn <%ce>%n%aI%n%cI%n%B", sha]);
  const [author, committer, authorDate, committerDate, ...bodyParts] = meta.split("\n");
  const message = bodyParts.join("\n");

  for (const [pattern, category] of FORBIDDEN_IDENTITY) {
    if (pattern.test(author)) violations.push({ kind: "identity", detail: `author: ${category}` });
    if (pattern.test(committer)) violations.push({ kind: "identity", detail: `committer: ${category}` });
  }
  for (const [pattern, category] of FORBIDDEN_MESSAGE) {
    if (pattern.test(message)) violations.push({ kind: "message", detail: category });
  }

  // ── the full tree at this commit ──
  const tree = git(["ls-tree", "-r", "-z", "--full-tree", sha]);
  const entries = [];
  for (const record of tree.split("\0")) {
    if (record === "") continue;
    const tab = record.indexOf("\t");
    const metaParts = record.slice(0, tab).split(/\s+/);
    entries.push({ mode: metaParts[0], type: metaParts[1], blob: metaParts[2], path: record.slice(tab + 1) });
  }

  const pathCount = entries.length;

  for (const entry of entries) {
    for (const [pattern, category] of FORBIDDEN_EVER) {
      if (pattern.test(entry.path)) {
        violations.push({ kind: "path", detail: `${entry.path}: ${category}` });
        break;
      }
    }
    // Symlinks and submodules have no place in a source drop.
    if (entry.mode === "120000") violations.push({ kind: "object", detail: `${entry.path}: symlink object` });
    if (entry.mode === "160000") violations.push({ kind: "object", detail: `${entry.path}: submodule gitlink` });
  }

  // ── blob contents against the fingerprint rules ──
  let blobsScanned = 0;
  for (const entry of entries) {
    if (entry.type !== "blob") continue;
    if (!TEXT_EXTENSIONS.some((extension) => entry.path.endsWith(extension))) continue;
    let content;
    try {
      content = git(["cat-file", "blob", entry.blob]);
    } catch {
      continue;
    }
    blobsScanned += 1;
    const hits = scanTextForFingerprints(content, fingerprints);
    if (hits.length > 0) {
      violations.push({ kind: "content", detail: `${entry.path}: ${hits.length} exam-prose fingerprint hit(s)` });
    }
  }

  results.push({
    index: index + 1,
    sha,
    shortSha: sha.slice(0, 12),
    subject: message.split("\n")[0].trim(),
    author,
    committer,
    authorDate,
    committerDate,
    pathCount,
    blobsScanned,
    ok: violations.length === 0,
    violations,
  });
}

// ── output ──
const failed = results.filter((result) => !result.ok);

if (JSON_OUTPUT) {
  console.log(JSON.stringify({ commitCount: results.length, ok: failed.length === 0, results }, null, 2));
} else {
  console.log(`commits audited: ${results.length}\n`);
  for (const result of results) {
    // Dates that disagree between author and committer indicate a rewritten or
    // replayed commit — worth surfacing even when it is benign.
    const datesMatch = result.authorDate.slice(0, 10) === result.committerDate.slice(0, 10);
    console.log(
      `[${result.ok ? "PASS" : "FAIL"}] ${result.index}. ${result.shortSha}  ${result.subject}`,
    );
    console.log(`         author    : ${result.author}`);
    console.log(`         committer : ${result.committer}`);
    console.log(`         dates     : ${result.authorDate}${datesMatch ? "" : ` / ${result.committerDate} (differ)`}`);
    console.log(`         tree      : ${result.pathCount} path(s), ${result.blobsScanned} text blob(s) scanned`);
    for (const violation of result.violations) {
      console.log(`         ! ${violation.kind}: ${violation.detail}`);
    }
  }
  console.log("");
  console.log(
    failed.length === 0
      ? `all ${results.length} commit(s) clean`
      : `${failed.length} of ${results.length} commit(s) FAILED`,
  );
}

process.exit(failed.length === 0 ? 0 : 1);
