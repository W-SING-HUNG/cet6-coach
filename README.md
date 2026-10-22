# CET-6 Coach

A local-first CET-6 (College English Test, Band 6) training system.

Not a question bank, not a streak tracker. It closes one loop:

**diagnose → capability profile → dynamic study plan → today's work →
answer and feedback → record the cause → schedule what comes next**

The home screen answers exactly one question: **what should I do next today**.

> **Status: source distribution, pre-1.0.** The application builds, its test
> suite runs, and it is usable today — but it is not published to a registry,
> has no hosted deployment, and carries no stability or support promise. See
> [Feature status](#feature-status) for what is and is not implemented, and
> [`docs/`](docs/) for the data-format contracts.

---

## Contents

- [What it does](#what-it-does)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Bringing your own content](#bringing-your-own-content)
- [Feature status](#feature-status)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Verification](#verification)
- [Privacy and security](#privacy-and-security)
- [Repository policy](#repository-policy)
- [Licensing](#licensing)

---

## What it does

1. **Onboarding** — exam date, target band, and how many minutes you can
   realistically give on a given day.
2. **Diagnostic** — a short, deliberately honest assessment. Each dimension ends
   up in one of three states: `assessed`, `insufficient_evidence`, or
   `unassessed`. "Not measured" is not the same as "weak", and the product never
   blurs the two.
3. **A deterministic planner** — a pure function over exam date, available time,
   capability profile, review queue and overdue tasks. No LLM, no system clock
   reads, no randomness; the same inputs produce the same plan.
4. **Training loop** — reading, vocabulary, translation and writing tasks that run
   end to end and persist their results atomically.
5. **Course companion** — optional. If you have your own course material, the app
   indexes it, lets you link a passage to an exam paper you own, and reveals a
   passage only after an explicit, recorded confirmation (see
   [Bringing your own content](#bringing-your-own-content)).
6. **Progress** — workload, capability estimates and error distribution. It
   deliberately does **not** predict a CET score.

### What it is not

- **It ships no exam papers, no course material, no audio and no answer keys.**
  A fresh install has an empty content library and says so. You supply your own
  material; see below.
- **It does not generate practice questions with an LLM.** Content policy is
  explicit: assessment and training items come from real past papers. AI may
  explain, annotate and give feedback *around* real content; it never invents
  items that stand in for it.
- **It does not convert practice accuracy into a CET score.** Reported CET scores
  are norm-referenced and equated; local accuracy does not carry that
  information. The product refuses to fake the conversion.
- **No accounts, no server, no sync.** One local SQLite database, one machine.

## Requirements

| | |
| --- | --- |
| Node.js | **>= 24.0.0** — the data layer uses the built-in `node:sqlite` module |
| pnpm | **>= 12** (the exact version is pinned in `package.json` as `packageManager`) |
| OS | Windows, macOS or Linux. Developed and verified on Windows + Node 24. |
| Browser | A current Chromium/Firefox/Safari for the UI; Chromium for the E2E suite |

`node:sqlite` is flagged experimental by Node, so an `ExperimentalWarning` on
startup is expected.

## Install and run

```bash
git clone <this-repository-url> cet6-coach
cd cet6-coach

pnpm install --frozen-lockfile
pnpm dev
```

The development server is pinned to **port 3100** (port 3000 is often taken by
other local projects) and binds **loopback only**, so open
<http://127.0.0.1:3100>.

> **Use `127.0.0.1`, not `localhost`.** Both names reach the same server, but a
> browser treats them as two different origins. State-changing requests (the
> course reveal endpoint in particular) are accepted only from the exact origin
> the server reports as trusted, which is `127.0.0.1`. Opening
> `http://localhost:3100` is redirected to the canonical address for ordinary
> page loads; a write that somehow still arrives from the other name is refused
> with a message telling you which address to use. This is deliberate: accepting
> both names would mean accepting two origins for the one request that releases
> private study content.

On first load, `/` redirects through `/onboarding` → `/diagnostic` → `/today`.

For a production build:

```bash
pnpm build
pnpm start          # http://127.0.0.1:3100
```

### First run in a clean checkout

With no content library, the app is fully usable for onboarding, the diagnostic
and today's plan. The practice area shows an empty state with import guidance
rather than fabricating papers — that behaviour is deliberate and is asserted by
the test suite.

## Bringing your own content

The application code and the study content are deliberately separate. Content
lives in a directory the repository does not track.

### 1. Choose a content root

By default the app reads `./private-content` (git-ignored). To put it elsewhere:

```bash
# PowerShell
$env:CET6_CONTENT_ROOT = "D:\study\cet6-content"
# bash
export CET6_CONTENT_ROOT=/home/you/cet6-content
```

### 2. Add exam papers

Papers go under `<content-root>/cet6/papers/<package-dir>/paper.json`, with media
beside the manifest in `assets/`. The full format — every required field, how
questions and sections are modelled, how assets and checksums work — is in
[`docs/past-paper-package.md`](docs/past-paper-package.md).

Validate before importing:

```bash
pnpm content:validate          # check the package against the schema
pnpm content:import            # write it into the local index
pnpm verify:flow               # exercise the service layer against a real file
```

Nothing is auto-generated for you. A malformed package is reported precisely and
refused.

### 3. Add course material (optional)

Course packages go under `<content-root>/courses/<course-id>/course.json`, with
the accompanying PDFs/DOCX in the same package. See
[`docs/course-package.md`](docs/course-package.md).

The pipeline is a sequence of explicit, checkable steps rather than a magic
button:

```bash
pnpm course:validate      # schema + asset checksum checks
pnpm course:extract       # PDF/DOCX -> text, page by page
pnpm course:segment       # propose segments
pnpm course:review        # human review of the proposal
pnpm course:import        # index the reviewed package
pnpm course:link          # link a segment to a paper you own
```

Each step fails closed. `course:review` consumes a review record that a human
wrote; the tool never signs its own work.

### 4. Try it without your own material

Synthetic fixtures exist so the pipeline can be exercised without any real
content. They are clearly labelled everywhere and are hard-wired to
`sourceKind: "test_fixture"`:

```bash
pnpm course:demo-package ./.e2e/demo        # write a synthetic course package
```

A fixture is never presented as course content. See the content policy in
[`content-policy/PRODUCT_PRINCIPLES.md`](content-policy/PRODUCT_PRINCIPLES.md) §6.1.

## Feature status

Implemented and covered by tests:

- onboarding (exam date, target band, daily minutes)
- 17-item diagnostic across vocabulary, reading, writing and translation, plus
  one deliberately pending listening item that renders as `unassessed`
- three-state capability assessment with per-dimension evidence sufficiency,
  shrinkage estimation and confidence
- deterministic planner (pure, timezone-free)
- reading, vocabulary, translation and writing training, persisted with loading,
  error, disabled and success states
- atomic task submission: one submission's writes are one re-entrant transaction,
  rolled back as a unit
- fixed-interval review queue for missed items (**FSRS is not wired up**)
- mid-day time adjustment on the Today screen
- progress view with workload, capability estimates and error distribution
- PWA foundation (installable manifest, icons, conservative service worker)
- course companion: import, review, index, link, and gated reveal
- controlled course intake workbench (candidate generation → human adjudication →
  dry run → promotion → import → link), with three independent write
  authorisations and crash recovery
- browser E2E covering mobile 390×844 and desktop 1440×900

Deliberately not implemented:

- **Listening assessment and training.** There is no original audio. Listening
  sits at `unassessed`: no score, no weakness derived, no weighting. It is 35% of
  the paper and is represented honestly as "important but not yet measured", not
  as "your listening is weak".
- **FSRS adaptive scheduling.** Columns exist; the scheduler is not connected.
- **Cloud sync.** Local SQLite only.
- **AI grading.** The interface is defined; the only registered provider is a
  deterministic local stub, and every output is labelled as such. It is never
  dressed up as model output.
- Speaking, leaderboards, social features, native apps, score prediction.
- PWA installability is verified only over HTTP, not across browsers.

## Architecture

```
src/
  app/             routes (RSC), Server Actions, page components
  components/      UI primitives (own implementations, no CLI-generated code)
  domain/          pure domain logic: types, models, planner, scoring
  services/        orchestration: onboarding, diagnostic, plan, practice, profile
  repositories/    data-access boundary (ports) + SQLite implementation
  content/         versioned content library and the intake pipeline
  ai/              AI provider abstraction + deterministic local stub
  db/              SQLite connection, schema and migrations
tests/             unit, integration and architecture guards
scripts/           CLIs, fixtures and proof scripts
e2e/               Playwright browser tests
docs/              data-format and pipeline contracts
content-policy/    the product charter and content policy
```

Key invariants — each enforced by `tests/architecture.test.ts`, not by
convention:

- the database is reachable only through `src/repositories`; UI and domain code
  must not import `node:sqlite`
- the domain layer depends on no framework, database or LLM SDK
- planner and scoring are pure: they never read the clock or touch the database
- the exam date has exactly one source (`src/domain/exam-facts.ts`)
- date arithmetic is timezone-free; only "what day is it" reads local time
- every route that reads the database is `force-dynamic`
- local grading must state its provenance and must never impersonate AI
- three-state diagnostic semantics: `assessed` carries a real conclusion;
  `insufficient_evidence` and `unassessed` must be unknown
- multi-step writes go through `repos.transaction()` (re-entrant, SAVEPOINT
  inside)
- committed sources contain no real exam text (hash-fingerprint scan; see
  [Verification](#verification))
- internal content-root directory names never reach the client bundle

## Configuration

All configuration is environment variables. Copy `.env.example` and fill in only
what you need; everything has a sane default.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CET6_CONTENT_ROOT` | `./private-content` | where your papers and course packages live |
| `CET6_DB_PATH` | `./data/cet6.db` | SQLite file path |
| `CET6_LOCAL_ORIGIN` | derived from the port | the exact origin trusted for same-origin POST checks |
| `AI_API_KEY` | unset | reserved for a future hosted AI provider; **nothing reads it today** |
| `PORT` | `3100` | HTTP port |

There are no secrets to configure. The app has no accounts, makes no outbound
network calls at runtime, and emits no telemetry.

## Verification

```bash
pnpm lint                     # ESLint
pnpm typecheck                # tsc --noEmit
pnpm test                     # unit + integration (vitest)
pnpm build                    # production build
pnpm e2e                      # Playwright, synthetic content, isolated databases
```

`pnpm e2e` needs the browser binary once:
`pnpm exec playwright install chromium`.

Beyond the standard gates, this repository ships proof scripts for claims a unit
test cannot make on its own:

```bash
pnpm release:check              # forbidden paths, secrets, personal data, internal vocabulary
pnpm release:docs               # every path/command/link named in a Markdown file resolves
pnpm release:history            # history shape, filenames, commit identities and messages
pnpm release:fingerprints       # no real exam text, with a positive control
pnpm release:secrets            # the secret scanner fires on synthetic credentials
pnpm release:bundle             # the emitted client bundle carries no internal directory names
pnpm content:fingerprint-proof  # no real exam text in the tree (positive + negative controls)
pnpm display-safety-proof       # path sanitiser removes paths and keeps the sentence
pnpm next:import-safety         # importing scripts/next.mjs has no side effects
pnpm telemetry:proof            # clean environment: no telemetry opt-in
pnpm e2e:privacy-mutation       # the E2E privacy gate fails when violated
pnpm smoke                      # boots a real production server on a fresh install
```

The `*:proof` scripts and the `release:*` controls are the point of the guard
design: each demonstrates that the check **fails** on a synthetic violation, so a
green result cannot mean "the check was never wired up".

### Known verification limits

- The unit suite is I/O heavy. It is verified with a bounded worker count
  (`pnpm test --maxWorkers=4`). At one worker per file on a small machine,
  individual CLI-spawning tests exceed their per-test timeout. That is a resource
  ceiling, not a test failure; CI uses the same bounded value.
- Browser E2E is verified on Chromium only.
- macOS and Linux are not verified by the maintainer on real hardware; CI runs
  the suite on Linux.

## Privacy and security

- **Local-first.** The database, content and logs stay on your machine. There is
  no server component, no analytics and no telemetry. See
  [`SECURITY.md`](SECURITY.md).
- **Your content is not in this repository, and cannot be** — `.gitignore`
  excludes the content root, the database and the E2E scratch directory.
- **Nothing identifies you.** No names, no accounts, no email; every path in the
  UI and in error messages is sanitised before display.
- **Course material is revealed only on explicit confirmation.** A reveal is a
  POST carrying a risk fingerprint that the server re-checks; if the risk
  changed, the request is refused with `409` and the prior confirmation is
  voided. Reading a passage linked to a paper you are reserving for a mock exam
  is recorded as contact and is surfaced as such *before* you confirm.

If you find a security issue, read [`SECURITY.md`](SECURITY.md) for the reporting
route. Please do not open a public issue for a vulnerability.

## Repository policy

This repository is a **curated public source distribution**, not a mirror of the
internal development history. It has its own Git ancestry: its first commit is a
root commit with no parent, and it shares no objects with any internal repository.

The distribution was **produced** by an explicit allowlist policy and is
**verified** by tooling that ships here:

```
tools/public-release-check.mjs      the gate: refuses a non-conforming tree
tools/audit-history.mjs             history, filename and metadata audit
tools/audit-all-commits.mjs         per-commit full-tree and blob audit
tools/check-exam-fingerprints.mjs   real-exam-prose scan (hash-only rule set)
tools/check-client-bundle.mjs       inspects the emitted client bundle
tools/secret-scan-controls.mjs      positive/negative controls for the secret scan
tools/gate-negative-controls.mjs    proves the gate still refuses prohibited data
tools/dependency-notices.mjs        derives THIRD-PARTY-NOTICES.md from the install
tools/smoke-test.mjs                boots a real server on a fresh install
```

The policy itself is **not** part of this repository, and that is deliberate: it
names paths from the internal tree, which is exactly the kind of information this
distribution exists to keep out. What ships here is the *verification* half —
the checks that refuse a tree that does not conform. Run `pnpm release:check`
(or `pnpm release:history`, `pnpm release:fingerprints`, `pnpm release:bundle`)
to apply them; they all run in CI on every push.

The policy is an allowlist. A file ships only if it matches an `include` pattern
and no `exclude` pattern, so a new file upstream is **excluded by default** until
someone adds it on purpose. `pnpm release:check` enforces the result and runs in
CI on every push.

Intentionally absent: private course material, exam papers, personal study
records, internal engineering and review notes, third-party media without
redistribution rights, and any real exam prose — including the very phrases the
content guard looks for, since the guard stores only truncated SHA-256 digests.

### What the exam-prose guard does and does not do

The content guard (`tools/check-exam-fingerprints.mjs`, rule set in
`tests/support/paper-fingerprints.ts`) stores **hashes**, never the phrases
themselves. A hash has no inverse, so the rule data is safe to publish — which
is the entire point, because the guard it replaced kept the phrases in the test
file and was itself the leak.

That design has a boundary worth stating plainly:

| It catches | It does not catch |
| --- | --- |
| A phrase pasted verbatim | The same phrase reworded, reordered or translated |
| Case, whitespace, line-break and punctuation changes | A phrase with a word swapped or removed |
| A phrase embedded in unrelated text | Text assembled to evade a known digest |

It is a **paste detector**, not a plagiarism detector. It is a strong control for
the threat it addresses — someone copying real exam prose into a commit — and it
is not a control against someone deliberately paraphrasing to evade it.

Two things bound that gap in practice, and neither is the scanner:

1. The rule set is reviewed by a human when a new paper is imported, and the
   import path is a CLI a person runs deliberately.
2. `tools/audit-all-commits.mjs` audits every blob in every commit, so a phrase
   added and later removed is still found.

If you are evaluating this repository as a dependency, treat the guard as one
layer of a review process, not as a proof that no copyrighted material could
ever be present.

## Licensing

> **Status: MIT licensed.** Copyright © 2026 W-SING-HUNG.

This project is released under the **[MIT License](LICENSE)** (SPDX: `MIT`).
The full text ships as [`LICENSE`](LICENSE) and is the operative document — this
section is a summary, not a substitute.

In short:

- **You may** use, copy, modify, merge, publish, distribute, sublicense and sell
  copies of the software, for any purpose, including commercial purposes.
- **You must** include the copyright notice and the permission notice in all
  copies or substantial portions of the software.
- **No warranty.** The software is provided "as is", without warranty of any kind,
  and the authors are not liable for any claim, damages or other liability arising
  from it.

### What this licence does not cover

MIT covers **this project's own source code**, and nothing else. Three things sit
deliberately outside it:

- **Third-party dependencies** retain their own licences — MIT, BSD, Apache-2.0,
  MPL-2.0 and others. See [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) for
  the full inventory. Those obligations survive this project's licence and cannot
  be overridden by it.
- **Examination papers and course material are not included and are not licensed
  by this project.** CET-6 past papers, commercial course material and any audio
  are third-party copyrighted works. Importing them is your responsibility, and
  whether your use is lawful depends on your jurisdiction and the provenance of
  your copy. The MIT grant above does not extend to them — this project cannot
  license what it does not own.
- **Your own study data** — the local SQLite database and anything you import —
  belongs to you, stays on your machine, and is not part of the licensed software.

Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before opening a pull request.

## A note on AI involvement

This project was developed with substantial AI assistance — architecture,
implementation, tests and review. That is a fact about how it was built, and this
repository does not hide it. What it does **not** ship is the internal
collaboration record: prompts, review transcripts, agent task breakdowns and
working notes are development process, not product. The engineering outcome is
here in full and is verifiable by running it.
