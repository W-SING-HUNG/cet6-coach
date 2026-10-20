#!/usr/bin/env node
/**
 * Structural source scanner: find token occurrences that are neither comments nor
 * pattern definitions.
 *
 * ── Why this module exists ──
 *
 * The release gate exempts a handful of files from the internal-vocabulary scan,
 * because those files must *name* the forbidden tokens: a scanner has to contain
 * what it searches for, and `CONTRIBUTING.md` has to be able to say "do not write
 * X".
 *
 * An exemption like that is only legitimate if it is **proven** rather than
 * promised. The first proof attempt stripped comments, strings and RegExp
 * literals with regexes and looked at what remained. It had a hole: the template
 * literal strip removed the whole template including its `${...}` interpolations,
 * so
 *
 *     const x = `SOMETOKEN FINAL PASS ${y}`;
 *
 * became invisible. Template literals are the most ordinary way to build a string
 * in modern JavaScript, which makes them the most likely place for a real
 * reference to appear.
 *
 * ── Why not a better regex ──
 *
 * Template literals nest: `` `a${`b${c}`}d` `` is valid, and an interpolation can
 * contain strings, comments and further templates. Regexes cannot track that
 * nesting, so any pattern-based stripper is approximately correct and fails on
 * the next shape someone writes. A state machine with an explicit stack does not
 * have that failure mode.
 *
 * ── What counts as a hit ──
 *
 * Every position that is **not inside a comment**, classified by where it was
 * found:
 *
 *   - `code`            — ordinary source, including identifiers and operators
 *   - `string`          — a quoted string value
 *   - `template-text`   — the literal characters of a template
 *   - `interpolation`   — the code inside `${...}`
 *   - `regexp`          — a RegExp literal
 *
 * Comments are the only exclusion, because a comment cannot be returned to a
 * user. A string or template *can* be, so tokens there are reported.
 *
 * RegExp literals are reported too. That matters for honesty: the gate's own
 * pattern definitions live in RegExp literals, and reporting them would make the
 * gate fail on itself. The gate therefore does not pass its own pattern
 * definitions through this function — it scans for tokens and lets this module
 * classify; the caller decides what to do with each class. Keeping the
 * classification here, and the policy there, means neither can silently widen the
 * other.
 */

/**
 * @typedef {"code" | "string" | "template-text" | "interpolation" | "regexp"} Region
 *
 * @typedef {object} StructuralHit
 * @property {number} index         character offset of the match
 * @property {string} category      caller-supplied label for the matched pattern
 * @property {Region} where         structural region the match was found in
 * @property {string} sample        a short, redacted excerpt for debugging
 */

/**
 * Scan `source` for `patterns`, ignoring matches inside comments.
 *
 * @param {string} source
 * @param {ReadonlyArray<readonly [RegExp, string]>} patterns
 *   Pattern/category pairs. Each pattern is applied to the non-comment regions,
 *   so it may use lookarounds and word boundaries normally.
 * @param {{ language?: "js" | "markdown" }} [options]
 *   `js` (the default) parses comments, strings, RegExp literals and template
 *   literals. `markdown` treats `<!-- -->` as a comment and everything else as
 *   reader-visible text, because markdown has no other comment syntax and a
 *   fenced code block is still rendered.
 * @returns {StructuralHit[]}
 */
export function findTokensOutsideComments(source, patterns, options = {}) {
  const regions = classifyRegions(source, options.language ?? "js");
  /** @type {StructuralHit[]} */
  const hits = [];

  for (const [pattern, category] of patterns) {
    /*
     * Rebuild the source with comment regions blanked to spaces.
     *
     * Blanking rather than deleting keeps every offset intact, which matters
     * because the region classification is reported alongside the match. Using
     * spaces instead of a sentinel character means no pattern can accidentally
     * match the filler, and `\b`/lookarounds behave as they would on the original
     * text apart from the removed comment.
     */
    const blanked = blankRegions(source, regions, (region) => region.kind === "comment");

    /*
     * Force the `g` flag.
     *
     * The caller's patterns are written for `RegExp.prototype.test`, so most have
     * no `/g`. `exec` on a non-global regex returns the first match *every* time
     * and never advances `lastIndex` — which is an infinite loop, and one that
     * manifests as an out-of-memory crash rather than an obvious hang. Cloning
     * with `g` makes iteration terminate, and leaves the caller's regex untouched.
     */
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    const scanner = new RegExp(pattern.source, flags);

    let match;
    while ((match = scanner.exec(blanked)) !== null) {
      const index = match.index;
      const region = regionAt(regions, index);
      hits.push({
        index,
        category,
        where: region === null ? "code" : region.kind,
        // Redact: the report goes to CI logs, and echoing the token would move
        // the disclosure rather than prevent it.
        sample: redact(blanked.slice(index, index + match[0].length)),
      });
      // Zero-length matches would loop forever even with `g`.
      if (match[0].length === 0) scanner.lastIndex += 1;
    }
  }

  return hits;
}

/** Replace matched regions with spaces, preserving offsets. */
function blankRegions(source, regions, shouldBlank) {
  const characters = [...source];
  for (const region of regions) {
    if (!shouldBlank(region)) continue;
    for (let index = region.start; index < region.end; index += 1) {
      // Keep newlines so line numbers and `$`/`^` behaviour survive.
      if (characters[index] !== "\n" && characters[index] !== "\r") characters[index] = " ";
    }
  }
  return characters.join("");
}

/** The region containing `index`, or null if outside all recorded regions. */
function regionAt(regions, index) {
  for (const region of regions) {
    if (index >= region.start && index < region.end) return region;
  }
  return null;
}

/** Show enough to locate a hit without reproducing the token. */
function redact(text) {
  const trimmed = text.trim();
  if (trimmed.length === 0) return "(empty)";
  return `${trimmed[0]}${"*".repeat(Math.max(0, Math.min(trimmed.length - 1, 6)))}`;
}

/**
 * Classify every character of `source` into a region kind.
 *
 * A single forward pass with an explicit stack. The states that matter:
 *
 *   code            — default
 *   line comment    — `//` to end of line
 *   block comment   — `/*` to `*\/`
 *   string          — `'…'` or `"…"`, escape-aware, ends at an unescaped newline
 *                     (an unterminated string is a syntax error, but a scanner
 *                     must not loop forever on bad input)
 *   template        — backtick-delimited; on `${` pushes an interpolation frame
 *   regexp          — `/…/ flags`, tracked with a bracket class counter so `[/]`
 *                     does not terminate it early
 *
 * Regex-vs-division disambiguation is the classic hard part. The heuristic used
 * here is the standard one: a `/` starts a RegExp when the previous significant
 * character cannot end an expression (an operator, an opening bracket, a comma,
 * `return`, `=>` …). It is a heuristic — JavaScript itself needs a parser to be
 * exact — but for the purpose of this module a misclassification can only move a
 * token between two *reported* classes, never into the excluded comment class.
 * That is the safe direction, and it is stated here rather than left implicit.
 */
function classifyRegions(source, language = "js") {
  /*
   * ── Language dispatch ──
   *
   * The scanner was written for JavaScript. Markdown was added to the allowance
   * list later, and running the JS rules over a `.md` file produced nonsense:
   * `<!-- … -->` was classified as *code* (so a comment counted as a hit), and a
   * fenced code block's ``` opened a template that swallowed the rest of the file.
   *
   * Guessing was not acceptable either way. Treating HTML comments as comments in
   * markdown is correct — they are invisible to a reader, so a token inside one is
   * documentation, not content. A fenced block is *visible*, so its contents are
   * prose the reader sees and must be checked.
   */
  if (language === "markdown") return classifyMarkdownRegions(source);
  return classifyJsRegions(source);
}

/**
 * Markdown regions.
 *
 * Only two constructs are structural:
 *
 *   - `<!-- … -->` is an HTML comment. A reader does not see it, so a token there
 *     is documentation.
 *   - everything else is reader-visible text, including fenced code blocks. A
 *     fenced block is rendered, so a token inside one is published content.
 *
 * Deliberately not parsed: emphasis, links, tables, front matter. They do not
 * change whether a character is visible, which is the only question here.
 */
function classifyMarkdownRegions(source) {
  const regions = [];
  let index = 0;
  const length = source.length;

  while (index < length) {
    if (source.startsWith("<!--", index)) {
      const start = index;
      const close = source.indexOf("-->", index + 4);
      index = close === -1 ? length : close + 3;
      regions.push({ kind: "comment", start, end: index });
      continue;
    }
    index += 1;
  }

  return regions;
}

function classifyJsRegions(source) {
  /** @type {{kind: Region | "comment", start: number, end: number}[]} */
  const regions = [];

  const push = (kind, start, end) => regions.push({ kind, start, end });

  /** Stack of "is this interpolation, or a nested template?" frames. */
  const templateStack = [];
  /** Start offsets of open `${...}` interpolations, innermost last. */
  const interpolationStarts = [];

  let index = 0;
  const length = source.length;
  /** Last significant (non-space, non-comment) character, for regex detection. */
  let previousSignificant = "";

  /** Is a `/` at this position a RegExp opener rather than division? */
  function regexAllowed() {
    if (previousSignificant === "") return true;
    // After these, an expression is expected, so `/` opens a RegExp.
    return /[({[,;:!&|?+\-*%^~<>=\n]/.test(previousSignificant);
  }

  while (index < length) {
    const char = source[index];
    const next = source[index + 1];

    // ── inside a template's literal text ──
    if (templateStack.length > 0 && templateStack[templateStack.length - 1] === "template") {
      const start = index;
      while (index < length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === "`") break;
        if (source[index] === "$" && source[index + 1] === "{") {
          // Interpolation begins after `${`.
          index += 2;
          push("template-text", start, index - 2);
          // The `${` itself belongs to the template, not the expression.
          regions.push({ kind: "template-text", start: index - 2, end: index });
          templateStack.push("interpolation");
          /*
           * Record where the interpolation's code begins. The region is closed
           * when the matching `}` is consumed; the open frame keeps its start so
           * nesting works.
           */
          interpolationStarts.push(index);
          // Signal the outer loop that we are now in code.
          previousSignificant = "{";
          break;
        }
        index += 1;
      }
      if (index >= length) {
        push("template-text", start, length);
        templateStack.pop();
        break;
      }
      if (source[index] === "`") {
        push("template-text", start, index);
        index += 1;
        templateStack.pop();
        previousSignificant = "`";
      }
      continue;
    }

    // ── line comment ──
    if (char === "/" && next === "/") {
      const start = index;
      while (index < length && source[index] !== "\n") index += 1;
      push("comment", start, index);
      continue;
    }

    // ── block comment ──
    if (char === "/" && next === "*") {
      const start = index;
      index += 2;
      while (index < length && !(source[index] === "*" && source[index + 1] === "/")) index += 1;
      index = Math.min(length, index + 2);
      push("comment", start, index);
      continue;
    }

    // ── template literal opens ──
    if (char === "`") {
      index += 1;
      templateStack.push("template");
      continue;
    }

    // ── interpolation closes ──
    if (
      char === "}" &&
      templateStack.length > 0 &&
      templateStack[templateStack.length - 1] === "interpolation"
    ) {
      // Close the region that began after `${`, so its characters are reported
      // as `interpolation` rather than plain `code`.
      const expressionStart = interpolationStarts.pop();
      if (expressionStart !== undefined && index > expressionStart) {
        push("interpolation", expressionStart, index);
      }
      templateStack.pop();
      index += 1;
      previousSignificant = "}";
      continue;
    }

    // ── quoted string ──
    if (char === '"' || char === "'") {
      const quote = char;
      const start = index;
      index += 1;
      while (index < length) {
        if (source[index] === "\\") {
          index += 2;
          continue;
        }
        if (source[index] === quote) {
          index += 1;
          break;
        }
        // An unescaped newline ends an unterminated string; do not run to EOF.
        if (source[index] === "\n") break;
        index += 1;
      }
      push("string", start, index);
      previousSignificant = quote;
      continue;
    }

    // ── RegExp literal ──
    if (char === "/" && regexAllowed()) {
      const start = index;
      index += 1;
      let inClass = false;
      let closed = false;
      while (index < length) {
        const current = source[index];
        if (current === "\\") {
          index += 2;
          continue;
        }
        if (current === "\n") break;
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) {
          index += 1;
          closed = true;
          break;
        }
        index += 1;
      }
      if (closed) {
        // Consume flags.
        while (index < length && /[a-z]/i.test(source[index])) index += 1;
        push("regexp", start, index);
        previousSignificant = "/";
        continue;
      }
      // Not a RegExp after all (e.g. a division with no closing slash): treat the
      // slash as an operator and continue from where we were.
      index = start + 1;
      previousSignificant = "/";
      continue;
    }

    // ── ordinary code character ──
    if (!/\s/.test(char)) previousSignificant = char;
    index += 1;
  }

  return regions;
}

/** Exposed for tests: the raw region classification. */
export { classifyRegions };

// ── self-test ─────────────────────────────────────────────────────────────────
/*
 * Runs when this file is executed directly. Each case states the *structural*
 * shape being tested, because the thing that went wrong before was a shape nobody
 * had enumerated.
 */
if (process.argv[1] && process.argv[1].endsWith("structural-scan.mjs")) {
  const TOKEN = ["Qo", "der"].join("");
  const PATTERNS = [[/\bQoder\b/, "role"]];

  const cases = [
    // [description, source, expectHit, expectWhere]
    ["bare identifier is code", `const ${TOKEN} = 1;`, true, "code"],
    ["double-quoted string value", `const x = "${TOKEN}";`, true, "string"],
    ["single-quoted string value", `const x = '${TOKEN}';`, true, "string"],
    ["template literal text", `const x = \`${TOKEN} FINAL PASS\`;`, true, "template-text"],
    ["template interpolation", `const x = \`a\${${TOKEN}}b\`;`, true, "interpolation"],
    ["nested template", `const x = \`a\${\`b\${${TOKEN}}\`}c\`;`, true, "interpolation"],
    ["regexp literal", `const re = /${TOKEN}/;`, true, "regexp"],
    ["line comment is excluded", `// ${TOKEN} FINAL PASS`, false, null],
    ["block comment is excluded", `/* ${TOKEN} FINAL PASS */`, false, null],
    ["comment then code still detects", `// ${TOKEN}\nconst a = "${TOKEN}";`, true, "string"],
    ["token after an unterminated template", `const x = \`unterminated ${TOKEN}`, true, "template-text"],
    ["division is not a regexp", `const a = b / c; const d = "${TOKEN}";`, true, "string"],
    ["regexp class with slash", `const re = /[/]${TOKEN}/; const z = 1;`, true, "regexp"],
    ["escaped quote inside string", `const x = "a\\"${TOKEN}";`, true, "string"],
    ["template with escaped backtick", `const x = \`a\\\`${TOKEN}\`;`, true, "template-text"],
    ["no token at all", `const x = \`nothing here\`;`, false, null],
  ];

  let failed = 0;
  for (const [description, source, expectHit, expectWhere] of cases) {
    const hits = findTokensOutsideComments(source, PATTERNS);
    const gotHit = hits.length > 0;
    const ok = gotHit === expectHit && (expectWhere === null || hits.some((hit) => hit.where === expectWhere));
    if (ok) {
      console.log(`ok    ${description}`);
    } else {
      failed += 1;
      console.error(
        `FAIL  ${description} — expected hit=${expectHit} where=${expectWhere}, got ${JSON.stringify(hits.map((h) => h.where))}`,
      );
    }
  }

  console.log("");
  if (failed > 0) {
    console.error(`${failed} structural-scan self-test case(s) FAILED`);
    process.exit(1);
  }
  console.log(`structural-scan self-test: PASS (${cases.length} cases)`);
}
