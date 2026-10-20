# Course Intake + Canonical Matching — Technical Research

Local, single-user TS/Node app (Node 24, `node:sqlite`, `pdfjs-dist` 6.3.289), ~3–50 canonical papers.
Item 1 verified by running `pdfjs-dist@6.3.289` on hand-built PDFs; item 7 by running `node:sqlite`.
**unverified** = could not confirm.

## 1. `pdfjs-dist` text extraction — **adopt**

`TextItem` (JSDoc): `str` = run text, bidi-transformed + Unicode-normalized (unless
`disableNormalization: true`). `transform` = `[a,b,c,d,e,f]`, where **`[4]` = x, `[5]` = y** of the run
origin. `width` = accumulated advance; `height` = `Math.hypot(trm[2],trm[3])`. `fontName` = key into
`TextContent.styles` — a **generated** name (`g_d0_f1`), *not* the PDF font name. `hasEOL` = "Indicating
if the text content is followed by a line-break."

**`hasEOL` is a geometric heuristic, not PDF semantics** — set when the advance to the next run exceeds
~half the text height (horizontal) or width (vertical). It is **not** reliable for structure: a two-column
probe yielded `LeftCol | " " | RightCol(hasEOL)`, so columns are unrecoverable from `hasEOL` alone.
Gap-filling also inserts `str: " "` fillers with `width > 0`, `height: 0`. **Group lines by `transform[5]`,
order within a line by `transform[4]`, treat `hasEOL` as a hint.**

**Image-only / no-text-layer pages: `getTextContent()` returns `{ items: [], styles: {}, lang: null }` —
no throw, no whitespace-only items.** Confirmed on a zero-length content stream and a page containing only
an image/fill operator, so `items.length === 0` is a reliable "no text layer" signal.

**`legacy/build/pdf.mjs` is the correct Node entry point**; requires Node `>=22.13.0 || >=24`.

**Security:** `isEvalSupported` **does not exist in v6.3.289** — zero package-wide occurrences and absent
from `DocumentInitParameters`, so passing it is silently ignored; it is **not** a control here. The real
flags: `disableFontFace` (default **`true` in Node**) uses the built-in path-glyph renderer instead of the
Font Loading API / `@font-face`; `useSystemFonts` (default `false` in Node, forced `false` under
`disableFontFace: true`). Neither affects `getTextContent()`, which reads the ToUnicode CMap, not glyph
outlines. A `Uint8Array` passed as `data` **transfers ownership** to the worker. **Apache-2.0**, SLSA
provenance + OIDC trusted publishing; v6.3.289 (2026-08-29), ~2-month cadence, CodeQL + dependabot in CI.
34.8 MB unpacked, fully local, zero cost.

## 2. W3C Web Annotation selectors — **adopt as the segment interchange shape**

```jsonc
{ "type": "TextQuoteSelector", "exact": "anotation", "prefix": "this is an ", "suffix": " that has some" }
{ "type": "TextPositionSelector", "start": 412, "end": 795 }
{ "type": "RangeSelector", "startSelector": {...}, "endSelector": {...} }  // two other Selectors
// wrapped via SpecificResource: { "source": "<iri>", "selector": { ... } }
```

`TextQuoteSelector` **MUST** have exactly 1 `exact`; `prefix`/`suffix` **SHOULD** have exactly 1 and
**MUST NOT** exceed 1. `TextPositionSelector` **MUST** have exactly 1 `start` and 1 `end`, both
non-negative integers; `start` inclusive, `end` exclusive. Selection is in **Unicode code points**,
logical order, on normalized text.

**Caveat — prefix/suffix are hints, not authority.** If multiple sequences still match after applying
prefix/exact/suffix, the spec says the selection SHOULD be treated as matching **all** of them: the model
tolerates ambiguity rather than promising unique resolution. `TextPositionSelector` is "very brittle with
regards to changes to the resource" and RECOMMENDED to be paired with a State. Emit **both** selectors as
independent evidence; neither is authoritative alone.

## 3. W3C Media Fragments URI — **adopt as convention, with a caveat**

ABNF: `timesegment = "t" "=" timeparam`; `npttimedef = [ "npt:" ] ( npttime [ "," npttime ] ) / ( "," npttime )`.
`#t=75,120` and `#t=npt:75,120` are both valid; `npt:` is optional (NPT is default); a single number is a
start, a leading comma makes it an end; the interval is half-open.

**Caveat: fragment semantics are defined per media type.** §2.2.1 says only media type definitions can
introduce fragment structure, and lists just **Ogg, MPEG-4, MPEG-21**. **`audio/mpeg` is not among them,
and RFC 3003 (its registration) defines no fragment at all.** `#t=` on MP3 is a widely honoured
*convention*, not a standard guarantee: treat the offset as **advisory and verify against decoded duration**.

## 4. Record linkage / candidate generation — **adopt the two-stage architecture**

**(a) Blocking / candidate generation.** All-pairs grows as `n(n-1)/2` — 1M records is ~500B comparisons.
Rules define "blocks" of pairs (e.g. `l.first_name = r.first_name AND l.surname = r.surname`). Splink:
*"It's usually better to use a longer list of strict blocking rules, than a short list of loose blocking
rules"* — each alone may miss a typo'd true match; diverse tight rules make a miss implausible. Equi-joins
are efficient; filter conditions (`levenshtein(...) < 3`) or `OR` inside one rule force materialising every
pair then discarding, so **prefer several equi-join rules over one fuzzy rule**. **(b) Comparison +
scoring**: field evidence aggregates into a score, then a threshold.

**Fellegi–Sunter.** Fellegi & Sunter, *A Theory for Record Linkage*, JASA **64**(328):1183–1210, Dec 1969.
`λ` = prior probability any two records match; `m` = `Pr(observation | match)` (**data quality** — how often
true matches still agree); `u` = `Pr(observation | non-match)` (**coincidence/cardinality**). A field's
evidence is the Bayes factor `m/u`; its match weight is `log2(m/u)`. Assuming conditional independence,
weights are **additive**: `M_obs = log2(λ/(1-λ)) + Σ log2(mᵢ/uᵢ)`. Error types: false match, false non-match.

**Why small projects use deterministic weighted evidence.** Estimating `m`/`u` needs labelled pairs or EM
training, and Splink's own guide documents the catch-22: to know `m` you must already know which records
match, and random pairs are almost all non-matches, so EM needs blocking first to raise match density (`λ`
is circular too). For ~3–50 papers, hand-tuned integer weights (name `+10`, year `+5`, threshold `15`) are
interpretable, diffable, tunable, with no training loop. **The honesty point is the model author's own:**
Robin Linacre warns the model's *"numeric probabilities … are often poor estimates of the true probability
of a match"* and recommends using match weights, not probabilities. Weighted evidence therefore inherits
Fellegi–Sunter's **ordinal ranking** but drops its probabilistic reading — a score, **not a calibrated
probability**. Never surface it as "92% confidence."

**Similarity measures.** Jaccard = `|A∩B| / |A∪B|`. Containment/overlap = `|A∩B| / min(|A|,|B|)` (commonly
the Szymkiewicz–Simpson coefficient — **attribution unverified**; formula standard). Character n-gram
(shingle) similarity applies these to k-shingles (commonly k=3–4). **Pitfall, worked:** if segment
A = `{machine, learning}` (|A|=2) and document B holds those plus 10 more (|B|=12), Jaccard = 2/12 =
**0.167** even though A ⊆ B perfectly — the union is dominated by the long side while the intersection is
capped by the short side. Containment = 2/min(2,12) = **1.0**; as |B| grows, Jaccard → 0 despite full
containment. **When one side is a candidate segment and the other a whole document, containment is right
and Jaccard is wrong.** But containment fails too: it is asymmetric and not a metric — containment(A,B) = 1
whenever A ⊆ B *regardless of B's size*, so a very short A scores 1.0 against every document containing it.
Pair it with a minimum-length floor, or you trade a false-negative problem for a false-positive one.

**Ambiguity / ties.** Near-identical top-2 scores mean the evidence does not distinguish candidates; picking
rank #1 resolves it via an arbitrary tie-break, yielding an **unstable, silently wrong match** that changes
between runs — visible in Splink's own idiom, `row_number() OVER (PARTITION BY unique_id_l ORDER BY
match_weight DESC)` with **no tie-break column**. Mitigations (sound practice; **no source prescribes this
set**): require a **margin/delta** between rank 1 and 2; **abstain** to human review on thin margins;
tie-break deterministically on a stable ID; **return a candidate set** when unsure. Splink also notes
threshold choice "can have a significant impact on the final linked data produced." At 50 papers, abstaining
is cheap and far safer than a confident wrong link.

## 5. Splink — **not applicable**

Python library (`splink` 5.0.0) for probabilistic linkage on Fellegi–Sunter. **MIT** (Ministry of Justice);
`requires_python >=3.10,<4.0`; core deps **`duckdb>=0.9.2`, `pyarrow>=18.0.0`, `sqlglot>=17.6.0`**. DuckDB
is the default backend and installs automatically — **Spark is not required**. SQLite/PostgreSQL exist with
minimal support; **Athena was dropped in Splink 5**. It is **Python-only** (no Node/TS binding surfaced;
existence of any is **unverified**). Adopting it means shipping a Python 3.10+ interpreter alongside Node,
plus DuckDB's native C++ engine, pyarrow's native binaries and sqlglot — a *second runtime and native
toolchain* for a local single-user app, to solve a ~50-record problem. **Default against; reimplement ~100
lines of weighted-evidence scoring in TS.**

## 6. Docling and Mammoth

**Docling — default against as a dependency** (viable only as a sidecar). IBM-origin (now LF AI & Data)
parser PDF/DOCX/PPTX → `DoclingDocument` → Markdown/JSON. **MIT**, Python `>=3.10` (v2.131.0). Its PDF
pipeline **downloads ML model weights** from Hugging Face (layout + TableFormer; optional OCR); the full
install pulls `torch`/`transformers` — multi-GB. Exact model size **unverified** (docling-slim advertises
~50 MB of *base* deps). DOCX/PPTX need no weights; CPU-only works. **No binding of the Python engine for
Node** — only output consumers (`@docling/docling-core`, `@docling/docling-client`), a separate Python
`docling-serve`, and a third-party Rust port.

**Mammoth — adopt.** npm `mammoth` 1.13.0, `.docx` → semantic HTML via style mapping. **BSD-2-Clause**,
pure JS (Node + browser), 8 runtime deps (`jszip`, `@xmldom/xmldom`, `underscore`, `xmlbuilder`, `lop`,
`base64-js`, `dingbat-to-unicode`, `argparse`), 1.67 MB unpacked. **It handles the OOXML zip itself via
JSZip in `lib/zipfile.js` — no separate unzip step.** Caveats: its docs state it **performs no sanitisation
of the source document** (don't feed untrusted uploads unsanitised); single maintainer; `argparse` pinned at
a very old `~1.0.3`; Markdown output deprecated in favour of HTML→Markdown.

## 7. FTS persistence — **default against**

**Would buy:** tokenized, ranked full-text search with stemming/prefix queries without hand-rolling matching.
**Costs:** a schema migration; a second derived source of truth that **drifts** from the on-disk JSON
packages; invalidation logic per package change; and a still-moving API — `node:sqlite` is **Stability 1.2
— Release Candidate** as of v24.15.0 (this machine's version; bundled SQLite 3.51.3). **Verified:** FTS5
**is** compiled in (`pragma compile_options` shows `ENABLE_FTS5`; `CREATE VIRTUAL TABLE t USING fts5(body)`
succeeds) — the capability is free if ever needed, so the objection is architectural, not technical.
**Why ephemeral wins here:** 3–50 papers is tens-to-low-hundreds of segments; a linear scan over an in-repo
array is microseconds, and FTS5's advantage only appears at a scale this project won't reach. Rebuilding per
run from the packages is simpler **and strictly more correct** than caching, leaving the on-disk packages the
single source of truth with no invalidation logic to get wrong.

## 8. Vector DB / embeddings / external OCR

- **Vector DB** — *not applicable*: no semantic-search requirement; adds an index to keep in sync.
- **Embeddings** — *not applicable*: needs a model or API (network, cost, non-determinism) to improve
  matching that deterministic weighted evidence already handles at this scale.
- **External OCR** — *not applicable now*: `items.length === 0` cleanly flags image-only PDFs, so you can
  **detect and route** them to manual handling without an OCR stack. Revisit only if PDFs prove to be scans.

## Sources

- pdf.js API docs (`TextItem`, `DocumentInitParameters`, `TextContent`): https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html
- pdf.js source (`api.js`; `appendEOL`/`compareWithLastPosition`), Apache-2.0: https://raw.githubusercontent.com/mozilla/pdf.js/master/src/display/api.js · https://github.com/mozilla/pdf.js
- `pdfjs-dist` npm metadata (license, engines, provenance): https://registry.npmjs.org/pdfjs-dist/latest
- pdf.js releases (v6.3.289, 2026-08-29): https://github.com/mozilla/pdf.js/releases
- W3C Web Annotation Data Model (REC 2017-02-23): https://www.w3.org/TR/annotation-model/
- W3C Media Fragments URI 1.0 (REC 2012-09-25; temporal ABNF, §2.2.1): https://www.w3.org/TR/media-frags/
- RFC 3003, *The audio/mpeg Media Type* (no fragment definition): https://www.rfc-editor.org/rfc/rfc3003.txt
- Fellegi & Sunter, *A Theory for Record Linkage*, JASA 64(328):1183–1210, 1969: https://doi.org/10.1080/01621459.1969.10501049
- Splink — Fellegi–Sunter model (`m`, `u`, `λ`, match weights): https://moj-analytical-services.github.io/splink/topic_guides/theory/fellegi_sunter.html
- Splink — blocking rules (`n(n-1)/2`; tight-vs-loose): https://moj-analytical-services.github.io/splink/topic_guides/blocking/blocking_rules.html
- Splink — blocking performance (equi-join vs filter conditions): https://moj-analytical-services.github.io/splink/topic_guides/blocking/performance.html
- Splink — training rationale (m/u catch-22, λ circularity): https://moj-analytical-services.github.io/splink/topic_guides/training/training_rationale.html
- Splink — edge metrics (Type I/II error, precision/recall): https://moj-analytical-services.github.io/splink/topic_guides/evaluation/edge_metrics.html
- Linacre, *Introduction to probabilistic linkage* (match weights over probabilities): https://www.robinlinacre.com/intro_to_probabilistic_linkage/
- Splink — backends + PyPI metadata (MIT, Python >=3.10, duckdb/pyarrow/sqlglot): https://moj-analytical-services.github.io/splink/topic_guides/splink_fundamentals/backends/backends.html · https://pypi.org/project/splink/
- Christophides et al., *End-to-End Entity Resolution for Big Data: A Survey*: https://arxiv.org/abs/1905.06397
- Docling (MIT, Python >=3.10) + model catalog: https://github.com/docling-project/docling · https://docling-project.github.io/docling/usage/model_catalog/
- Mammoth (BSD-2-Clause, JSZip OOXML handling, no sanitisation): https://github.com/mwilliamson/mammoth.js · https://registry.npmjs.org/mammoth/latest
- Node.js `node:sqlite` (Stability 1.2 — Release Candidate, v24.15.0): https://nodejs.org/docs/latest-v24.x/api/sqlite.html
- SQLite FTS5: https://www.sqlite.org/fts5.html
