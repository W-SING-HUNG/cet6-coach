#!/usr/bin/env node
/**
 * Secret-scanning positive and negative controls over the real tree.
 *
 * ── Why a separate control run ──
 *
 * `public-release-check.mjs` contains an inline control, which is enough to know
 * that the patterns compile and match a synthetic string. It is not enough to
 * answer the question a reviewer actually has: *"if a real credential were in
 * this tree, would the gate catch it, and would it catch it in a file like
 * this?"* A control that only ever runs in memory does not exercise the tree
 * walker, the extension filter, the skip list or the reporting path.
 *
 * So this tool plants real-shaped credentials into a **temporary copy of the
 * tree** and re-runs the actual gate against it. Nothing is written to the real
 * tree, and the planted values are synthetic �?assembled at runtime from
 * fragments so that this file itself never contains a credential-shaped literal.
 *
 * It also proves the negative direction: an ordinary prose file must not be
 * flagged, or the gate would be ignored in practice.
 *
 * ── What it does NOT do ──
 *
 * It does not send anything to a third-party scanning service. A credential that
 * has been transmitted has been disclosed; the control has to run locally.
 *
 * Usage:
 *   node tools/secret-scan-controls.mjs [--keep]
 *
 * Exit 0 = all controls behaved correctly. Exit 1 = a control failed.
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTempDir } from "./temp-workspace.mjs";

const KEEP = process.argv.includes("--keep");
const ROOT = process.cwd();

/** Synthetic credentials, assembled from fragments. None of these is valid. */
function syntheticSecrets() {
  const alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const repeat = (count) => alpha.repeat(Math.ceil(count / alpha.length)).slice(0, count);
  /*
   * The PEM header is assembled too, not written literally.
   *
   * Writing it literally made this very file the only thing the baseline scan
   * reported �?the scanner correctly flagged a private-key header inside the file
   * that plants private-key headers. The tempting "fix" would be to exempt this
   * file from the scan, which is how a scanner ends up not scanning its own
   * directory. Building the string at runtime keeps the scanner honest and keeps
   * the control working.
   */
  const pemHeader = ["-----BEGIN ", "RSA PRIVATE ", "KEY-----"].join("");
  const pemFooter = ["-----END ", "RSA PRIVATE ", "KEY-----"].join("");
  return {
    // GitHub classic personal access token shape: ghp_ + 36 alphanumerics.
    "gh-token.txt": `token = ghp_${repeat(36)}\n`,
    // OpenAI-style key: sk- + 32 or more.
    "openai-key.txt": `OPENAI_API_KEY=sk-${repeat(40)}\n`,
    // AWS access key id: AKIA + 16 uppercase alphanumerics.
    "aws-key.txt": `aws_access_key_id = AKIA${repeat(16).toUpperCase()}\n`,
    // PEM private key header, which is the shape that matters most.
    "fake-key.pem.txt": `${pemHeader}\nnot-a-real-key\n${pemFooter}\n`,
    // The npx/npm token shape.
    "npm-token.txt": `//registry.npmjs.org/:_authToken=npm_${repeat(36)}\n`,
  };
}

let failures = 0;
function check(label, condition, detail = "") {
  if (condition) {
    console.log(`ok    ${label}`);
    return;
  }
  failures += 1;
  console.error(`FAIL  ${label}${detail === "" ? "" : ` �?${detail}`}`);
}

/**
 * Copy the tree to a scratch directory.
 *
 * `.git` is included because the gate's history audit reads it, but the heavy
 * build/dependency directories are not: the controls only need to prove the file
 * walker sees a planted secret, and copying `node_modules` would make the run
 * take minutes.
 */
function cloneTree() {
  const target = createTempDir("cet6-secret-control-").path;
  cpSync(ROOT, target, {
    recursive: true,
    filter: (source) => {
      const name = source.split(/[\\/]/).pop();
      return !["node_modules", ".next", ".pnpm-store", "test-results", "playwright-report"].includes(name);
    },
  });
  return target;
}

function runGate(directory) {
  try {
    // The gate imports the fingerprint rule set, which is TypeScript; the control
    // therefore runs Node with the same flags CI uses.
    const output = execFileSync(
      process.execPath,
      ["--experimental-transform-types", join(directory, "tools", "public-release-check.mjs"), "--json"],
      { encoding: "utf8", cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { exitCode: 0, output };
  } catch (error) {
    const stdout = typeof error.stdout === "string" ? error.stdout : error.stdout?.toString() ?? "";
    return { exitCode: error.status ?? 1, output: stdout };
  }
}

/** Extract the secret-check result from the gate's JSON output. */
function secretResult(output) {
  try {
    const parsed = JSON.parse(output);
    return parsed.results.find((result) => result.id === "secrets");
  } catch {
    return undefined;
  }
}

// ── baseline: the real tree must be clean ──
{
  const result = runGate(ROOT);
  const secrets = secretResult(result.output);
  check(
    "baseline: the real tree has no credential-shaped strings",
    result.exitCode === 0,
    `gate exit ${result.exitCode}`,
  );
  check(
    "baseline: the secret check reports zero violations",
    secrets !== undefined && secrets.violations.length === 0,
    `${secrets?.violations.length ?? "n/a"} violation(s)`,
  );
}

// ── positive controls: each planted secret must be caught ──
{
  const scratch = cloneTree();
  try {
    const plantedDirectory = join(scratch, "src");
    mkdirSync(plantedDirectory, { recursive: true });

    const secrets = syntheticSecrets();
    for (const [name, content] of Object.entries(secrets)) {
      writeFileSync(join(plantedDirectory, name), content, "utf8");
    }

    const result = runGate(scratch);
    const secretsResult = secretResult(result.output);

    check(
      "the gate FAILS on a tree containing planted credentials",
      result.exitCode !== 0,
      `gate exit ${result.exitCode}`,
    );

    const reportedFiles = new Set((secretsResult?.violations ?? []).map((violation) => violation.file));
    for (const name of Object.keys(secrets)) {
      check(
        `planted ${name} is detected`,
        reportedFiles.has(`src/${name}`),
        `reported: ${[...reportedFiles].join(", ") || "nothing"}`,
      );
    }

    /*
     * The report must name the file and the category but must **not** echo the
     * credential. A scanner that prints the secret into CI logs has moved the
     * disclosure, not prevented it.
     */
    const sample = Object.values(secrets)[0].trim();
    const rawValue = sample.split("=").pop()?.trim() ?? sample;
    check(
      "the report does not echo the credential value",
      !(secretsResult?.violations ?? []).some((violation) => JSON.stringify(violation).includes(rawValue)),
    );
  } finally {
    if (!KEEP) rmSync(scratch, { recursive: true, force: true });
    else console.log(`      kept scratch tree: ${scratch}`);
  }
}

// ── negative control: prose must not be flagged ──
{
  const scratch = cloneTree();
  try {
    mkdirSync(join(scratch, "docs"), { recursive: true });
    writeFileSync(
      join(scratch, "docs", "not-a-secret.md"),
      [
        "# Configuration notes",
        "",
        "Set the password in your environment. Do not commit a real token.",
        "An API key looks like a long random string, which is why we never paste one here.",
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runGate(scratch);
    const secretsResult = secretResult(result.output);
    const flagged = (secretsResult?.violations ?? []).some((violation) => violation.file === "docs/not-a-secret.md");
    check("prose about credentials is not flagged", !flagged);
  } finally {
    if (!KEEP) rmSync(scratch, { recursive: true, force: true });
    else console.log(`      kept scratch tree: ${scratch}`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} secret-scan control(s) FAILED`);
  process.exit(1);
}
console.log("\nsecret-scan controls: PASS");
