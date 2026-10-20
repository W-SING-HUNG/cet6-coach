/**
 * Content-provenance guard: committed sources must not contain real exam text.
 *
 * ── The defect this module replaces ──
 *
 * The previous guard stored nine identifying phrases taken from real CET-6
 * papers **in the test file itself**, then scanned a hand-written list of ~30
 * paths for them. Two things were wrong, and they compounded:
 *
 * 1. **The guard was the leak.** It existed to keep copyrighted exam prose out of
 *    the repository, and it did that by committing excerpts of that prose. Anyone
 *    with a clone could read the phrases straight out of the guard.
 * 2. **The guard could not see itself.** Its file list contained neither the test
 *    file holding the phrases nor the long-form fixture test that also embedded
 *    six of them. A scanner whose scope excludes its own rule data proves nothing
 *    about the repository; it only proves the author's list.
 *
 * ── What this module does instead ──
 *
 * - **Fingerprints are hashes, never text.** A phrase is stored as
 *   `sha256(normalise(phrase))` truncated to 16 bytes, hex encoded, together with
 *   its token count. A hash cannot be turned back into exam prose, so the rule
 *   data is safe to publish. This is the standard approach for blocklists that
 *   must be public.
 * - **The scan is directory-recursive with an exclusion list**, not an inclusion
 *   list. Every text file is scanned unless it is a synthetic fixture that is
 *   *supposed* to contain exam-shaped text. New files are therefore covered by
 *   default rather than escaping by default.
 * - **The scanner scans its own source.** `tests/` is inside the scan root, so the
 *   rule data file is scanned like any other file. If someone pastes a real phrase
 *   back in, the guard fails on itself.
 *
 * ── Why the token count is stored alongside each digest ──
 *
 * A digest has no inverse, so a scan cannot discover how many tokens produced it.
 * Without that, every position must be hashed at every candidate length 2..12 —
 * roughly eleven SHA-256 calls per token. On a repository-sized scan that blew
 * past the test runner's timeout, and a timed-out guard reports *nothing*, which
 * is indistinguishable from a clean tree. Storing the length turns the inner loop
 * into one hash per position per length that can actually match.
 */

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, openSync, closeSync, readSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * A fingerprint: a truncated SHA-256 digest plus the token count it was built
 * from.
 *
 * **Digests are deliberately one-way.** They let the guard recognise a phrase
 * without storing it. Do not "helpfully" add the plaintext next to a hash — that
 * would restore the original defect in full.
 *
 * Provenance of this set: recorded in the internal engineering record, which is
 * not part of this distribution. The public repository only needs to know *that*
 * these hashes denote real exam material, not which phrases they denote.
 */
export interface Fingerprint {
  /** 32 hex characters = 16 bytes of SHA-256 over the normalised tokens. */
  digest: string;
  /** How many normalised tokens the phrase contained. */
  tokens: number;
}

export const REAL_PAPER_FINGERPRINTS: readonly Fingerprint[] = [
  // Format: { digest, tokens }. Digest only — never the phrase.
  { digest: "0169f83ab29af635f5b476e2fd30b434", tokens: 7 },
  { digest: "5ef0cb463239c84eac507555e1e6004b", tokens: 2 },
  { digest: "86e2bfaf3b0f1c29af47011c530dda7f", tokens: 2 },
  { digest: "4a1e74c4754fa521c05a4e4c6b5a49cf", tokens: 4 },
  { digest: "b6973d0a02cd4168ce43110558ba9393", tokens: 7 },
  { digest: "958ee8c75d0fd474deddf15046abb23c", tokens: 5 },
  { digest: "80572a93209fee80c3fb32c0afb7fb42", tokens: 10 },
  { digest: "828e956438f48a53a9ba3f7f0df3ea8e", tokens: 3 },
  { digest: "1ca941666e395f781f36abc3e0e9ebf1", tokens: 2 },
];

/** Minimum and maximum token counts present in the rule set (used for validation). */
export const MIN_NGRAM = Math.min(...REAL_PAPER_FINGERPRINTS.map((entry) => entry.tokens));
export const MAX_NGRAM = Math.max(...REAL_PAPER_FINGERPRINTS.map((entry) => entry.tokens));

/**
 * Normalise text into a token stream.
 *
 * Lowercases, folds compatibility characters to their ASCII forms, and splits on
 * anything that is not a letter or digit. Apostrophes are kept *inside* words
 * because they distinguish "the tree's owner" from "the trees owner", but they
 * are not tokens of their own.
 */
export function tokenize(text: string): string[] {
  const folded = text.normalize("NFKC").toLowerCase().replace(/[\u2018\u2019\u02bc]/g, "'");
  return folded.match(/[a-z0-9]+(?:'[a-z0-9]+)*/g) ?? [];
}

/** Hash a token gram into a hex fingerprint of the same width as the rule data. */
export function fingerprintGram(gram: readonly string[]): string {
  return createHash("sha256").update(gram.join(" ")).digest("hex").slice(0, 32);
}

/**
 * Hash a whole phrase the same way the rule data was produced.
 *
 * Exported so a maintainer can *add* a fingerprint from a phrase without having
 * to guess the encoding, and so tests can build positive controls at runtime
 * instead of storing a plaintext phrase in the repository.
 */
export function fingerprintPhrase(phrase: string): Fingerprint {
  const tokens = tokenize(phrase);
  return { digest: fingerprintGram(tokens), tokens: tokens.length };
}

/** A single fingerprint hit: which file, and at which token position. */
export interface FingerprintHit {
  file: string;
  /** Index of the first token of the matching gram. */
  tokenIndex: number;
  /** Length of the matching gram, in tokens. */
  gramLength: number;
}

/** Build the digest lookup used by the scan, keyed by token length. */
function indexByLength(fingerprints: readonly Fingerprint[]): Map<number, Set<string>> {
  const byLength = new Map<number, Set<string>>();
  for (const { digest, tokens } of fingerprints) {
    let bucket = byLength.get(tokens);
    if (bucket === undefined) {
      bucket = new Set<string>();
      byLength.set(tokens, bucket);
    }
    bucket.add(digest);
  }
  return byLength;
}

/** Memoise the index per rule-set identity so repeated scans do not rebuild it. */
const indexCache = new WeakMap<readonly Fingerprint[], Map<number, Set<string>>>();

function indexFor(fingerprints: readonly Fingerprint[]): Map<number, Set<string>> {
  const cached = indexCache.get(fingerprints);
  if (cached !== undefined) return cached;
  const built = indexByLength(fingerprints);
  indexCache.set(fingerprints, built);
  return built;
}

/**
 * Scan one file's text for any fingerprint match.
 *
 * Returns matches without echoing the matched tokens: hit reports go to logs and
 * CI output, and printing the matching text would reintroduce the leak in a
 * different place.
 */
export function scanTextForFingerprints(
  text: string,
  fingerprints: readonly Fingerprint[] = REAL_PAPER_FINGERPRINTS,
): FingerprintHit[] {
  const tokens = tokenize(text);
  const hits: FingerprintHit[] = [];
  if (tokens.length === 0) return hits;

  const byLength = indexFor(fingerprints);
  // Longest first: a longer match is more specific, and finding it early keeps
  // reports stable when a phrase overlaps a shorter one.
  const lengths = [...byLength.keys()].sort((a, b) => b - a);

  for (let start = 0; start < tokens.length; start += 1) {
    for (const length of lengths) {
      if (start + length > tokens.length) continue;
      const bucket = byLength.get(length)!;
      if (bucket.has(fingerprintGram(tokens.slice(start, start + length)))) {
        hits.push({ file: "", tokenIndex: start, gramLength: length });
        // One hit per start position is enough: the report only needs to say
        // "this file contains real exam material".
        break;
      }
    }
  }
  return hits;
}

/**
 * Paths (relative to the repository root) exempt from the fingerprint scan.
 *
 * ── This list is now empty, and that is the point ──
 *
 * It previously named `tests/paper-fixture-longform.test.ts`, on the reasoning
 * that the file's *own* test asserts it contains no real paper text, so scanning
 * it was redundant.
 *
 * That reasoning was wrong, and it produced exactly the defect this module exists
 * to prevent. The file did contain six real exam phrases — the same ones its own
 * test was supposed to be checking for. The exemption meant the repository-wide
 * scan never looked at it, while the file's self-check looked for phrases held in
 * a literal list that had itself become the leak. Two guards, each covering the
 * other's blind spot, and neither covering the file.
 *
 * The lesson generalises: a scan with a per-file exemption has a hole exactly the
 * size of that file, and the reason for the exemption is usually the reason it
 * should not exist. If a file genuinely needs to contain exam-shaped text, it
 * should say so in a way a reviewer can see — not be quietly skipped.
 *
 * Kept as an exported constant rather than deleted so that call sites and their
 * tests continue to express "the scanner supports exclusions", and so that adding
 * one requires a visible edit here.
 */
export const FIXTURE_EXCLUSIONS: readonly string[] = [];


/**
 * File extensions that are **known** to be text.
 *
 * This is an allow-list for the common case, not the boundary of the scan.
 * See `isScannableText` for why the boundary is wider than this list.
 */
const TEXT_EXTENSIONS = [
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".css",
  ".html", ".htm", ".yml", ".yaml", ".txt", ".svg", ".example",
  ".gitignore", ".gitattributes", ".npmrc", ".editorconfig",
  ".markdown", ".rst", ".text", ".log", ".bak", ".orig", ".tmp",
  ".patch", ".diff", ".env",
];

/**
 * Extensions that are **known** to be binary. A file with one of these is
 * never read as text, whatever its content looks like.
 *
 * Deliberately a deny-list rather than "sniff the bytes": sniffing means a
 * polyglot file (valid UTF-8 *and* a valid image) is classified by whichever
 * check runs first, and that is exactly the kind of ambiguity an attacker
 * gets to choose.
 */
const BINARY_EXTENSIONS = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico",
  ".pdf", ".docx", ".xlsx", ".pptx", ".doc", ".xls", ".ppt",
  ".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".opus",
  ".mp4", ".mov", ".avi", ".mkv", ".webm",
  ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".db", ".sqlite", ".sqlite3", ".wasm", ".node", ".exe", ".dll",
  ".p12", ".pfx", ".jks",
];

/**
 * Decide whether a file should be read as text for scanning.
 *
 * ── Why this is not just the extension allow-list ──
 *
 * An independent review (finding F-4) demonstrated the hole: exam prose
 * planted in `leak.md.bak` was invisible to both scanners, because `.bak`
 * was in neither list. A closed allow-list means "every extension nobody
 * thought of is unscanned", and an attacker chooses the extension.
 *
 * The rule is therefore **deny-by-default with a content check**:
 *
 *   1. a known-binary extension ⇒ never scanned;
 *   2. a known-text extension ⇒ scanned;
 *   3. anything else ⇒ read the first block and scan it only if it decodes
 *      as UTF-8 without replacement characters.
 *
 * Case 3 is what closes the hole. It is deliberately conservative in the
 * *safe* direction: a file that fails the decode test is skipped, and a
 * skipped file is a file we could not read — which the callers already
 * report honestly. It never invents a classification.
 *
 * Note this makes the scan *wider*, not narrower: a file with an unknown
 * extension that happens to be text is now covered. That is the point.
 */
export function isScannableText(name: string, readHead?: () => Buffer | null): boolean {
  const lower = name.toLowerCase();
  if (BINARY_EXTENSIONS.some((extension) => lower.endsWith(extension))) return false;
  if (TEXT_EXTENSIONS.some((extension) => lower.endsWith(extension))) return true;

  // Unknown extension: fall back to a content probe.
  if (readHead === undefined) return false;
  let head: Buffer | null;
  try {
    head = readHead();
  } catch {
    return false;
  }
  if (head === null || head.length === 0) return false;
  return looksLikeUtf8Text(head);
}

/**
 * Does this byte block decode as UTF-8 text without replacement characters?
 *
 * A NUL byte is treated as binary: it never appears in a text file that is
 * worth scanning, and it is the cheapest reliable signal we have.
 */
function looksLikeUtf8Text(head: Buffer): boolean {
  if (head.includes(0)) return false;
  const decoded = new TextDecoder("utf-8", { fatal: true });
  try {
    decoded.decode(head);
    return true;
  } catch {
    return false;
  }
}

/** Directories the scanner never descends into. */
const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", ".next", ".pnpm-store", "coverage",
  "test-results", "playwright-report", ".e2e",
]);

/**
 * Recursively list files under `root`, skipping build output and VCS metadata.
 *
 * Uses the real filesystem rather than `git ls-files` so the guard also works on
 * an exported tree that has no history, and so it can be pointed at build output
 * by the client-bundle check.
 */
export function listScannableFiles(root: string): string[] {
  const results: string[] = [];

  /*
   * ── 为什么单个条目消失不是错误 ──
   *
   * 这个遍历在**实时工作树**上运行，而 `vitest` 默认按测试文件并行。
   * 树里有些目录是**测试自己创建又删除**的（例如
   * `data/pool-policy-content`、`data/convergence-content`）。
   * 于是 walk 与那些测试的 `rmSync` 构成一个真实的 TOCTOU 竞争：
   * `readdirSync` 看到了名字，随后的 `statSync` 却拿到 `ENOENT`。
   *
   * 实测证据（**未修改的 V10 上也会发生**，属既有缺陷）：
   * 同时跑 `architecture.test.ts` 与 `paper-pool-policy.test.ts`，6 次里 1 次
   * 报 `ENOENT … data/pool-policy-content/…/audio_listening…wav`。
   *
   * 修法必须**不能**是"吞掉所有错误"：那会把真正的权限/IO 故障也变成静默通过。
   * 因此只对**单条目消失**（ENOENT / ENOTDIR）跳过该条目 —— 它已经不在了，
   * 也就没有可扫描的内容；其他错误照常抛出。被跳过的条目会记入
   * `skippedDuringWalk`，由调用方（架构守卫）断言"这不是覆盖缺口"。
   */
  const skippedDuringWalk: string[] = [];

  function walk(directory: string): void {
    let names: string[];
    try {
      names = readdirSync(directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        skippedDuringWalk.push(relative(root, directory).replace(/\\/g, "/"));
        return;
      }
      throw error;
    }

    for (const name of names) {
      if (SKIP_DIRECTORIES.has(name)) continue;
      const absolute = join(directory, name);
      let stats: ReturnType<typeof statSync>;
      try {
        stats = statSync(absolute);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // 条目在 readdir 与 stat 之间被删除：并发测试的合法行为，不是泄露。
        if (code === "ENOENT" || code === "ENOTDIR") {
          skippedDuringWalk.push(relative(root, absolute).replace(/\\/g, "/"));
          continue;
        }
        throw error;
      }
      if (stats.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!stats.isFile()) continue;
      let scannable: boolean;
      try {
        scannable = isScannableText(name, () => {
          // Read only the first block: enough to classify, cheap on a large tree.
          const fd = openSync(absolute, "r");
          try {
            const buffer = Buffer.alloc(4096);
            const bytes = readSync(fd, buffer, 0, buffer.length, 0);
            return buffer.subarray(0, bytes);
          } finally {
            closeSync(fd);
          }
        });
      } catch (error) {
        // 同上：文件在分类读取期间消失。
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          skippedDuringWalk.push(relative(root, absolute).replace(/\\/g, "/"));
          continue;
        }
        throw error;
      }
      if (!scannable) continue;
      results.push(relative(root, absolute).replace(/\\/g, "/"));
    }
  }

  walk(root);
  lastWalkSkips.length = 0;
  lastWalkSkips.push(...skippedDuringWalk);
  return results.sort();
}

/**
 * 最近一次 `listScannableFiles` 因并发删除而跳过的条目（相对路径）。
 *
 * 存在它是为了让"跳过"**可被断言**，而不是悄悄发生：架构守卫会检查
 * 这些路径只可能落在测试自建的临时目录（`data/`）下，不会落在源码目录，
 * 因此一次竞争不可能掩盖源码里的真问题。
 */
export const lastWalkSkips: string[] = [];

/**
 * Scan a directory tree for real-paper fingerprints.
 *
 * `root` is the repository root. Returns one hit per offending file.
 */
export function scanTreeForFingerprints(
  root: string,
  options: {
    fingerprints?: readonly Fingerprint[];
    exclusions?: readonly string[];
  } = {},
): FingerprintHit[] {
  const fingerprints = options.fingerprints ?? REAL_PAPER_FINGERPRINTS;
  const exclusions = new Set(options.exclusions ?? FIXTURE_EXCLUSIONS);
  const hits: FingerprintHit[] = [];

  for (const file of listScannableFiles(root)) {
    if (exclusions.has(file)) continue;
    const text = readFileSync(join(root, ...file.split("/")), "utf8");
    for (const hit of scanTextForFingerprints(text, fingerprints)) {
      hits.push({ ...hit, file });
    }
  }
  return hits;
}
