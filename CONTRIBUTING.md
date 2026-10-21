# Contributing

Thanks for taking the time to look. This is a small, opinionated, pre-1.0
project. A few things will save us both time.

## Before you start

- **Open an issue first for anything non-trivial.** This project has strong
  opinions about scope (see [`content-policy/PRODUCT_PRINCIPLES.md`](content-policy/PRODUCT_PRINCIPLES.md));
  a well-built feature that conflicts with them will still be declined.
- **Small, focused pull requests.** One intent per PR, with a commit message that
  describes the actual change.
- **Never include study content.** No exam papers, no course material, no audio,
  no answer keys, and no excerpts of any of them — not in code, tests, fixtures,
  comments, commit messages or screenshots. This is the one rule with no
  exceptions. The test suite scans for real exam text and will fail.

## Development setup

```bash
pnpm install --frozen-lockfile
pnpm dev                 # http://localhost:3100
```

Requirements are in the [README](README.md#requirements). Node >= 24 is not
optional: the data layer uses the built-in `node:sqlite`.

## Before opening a pull request

Run the full gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

If your change touches browser behaviour, also run:

```bash
pnpm exec playwright install chromium   # once
pnpm e2e
```

And if it touches the guards:

```bash
pnpm release:check
pnpm release:docs          # every path/command/link named in a .md file resolves
pnpm content:fingerprint-proof
pnpm display-safety-proof
```

`pnpm release:docs` is not a style check. A README that names a file or a
command which does not exist is the same class of defect as a gate that claims
to check something it does not: the reader cannot tell which statements to
trust. If you add a script to `package.json`, mention it in the README; if you
mention a path in a Markdown file, make sure it is tracked.

State the commands you ran and what you observed in the PR description. A claim
of "tests pass" without the command and its output is not evidence.

## Testing rules

These are not style preferences; they are the reason the suite can be trusted.

- **A failing test is not fixed by deleting it, skipping it, or weakening the
  assertion.** If a test is wrong, change the test *and* explain why the old
  expectation was wrong.
- **Add a failing test before the fix.** For bugs, the reproduction comes first.
- **Guards need positive controls.** If you add a check that scans for something,
  demonstrate it fails on a synthetic violation. A check that has never failed is
  indistinguishable from a check that is not wired up. See
  `scripts/content-fingerprint-proof.ts` for the pattern.
- **Do not make tests pass by making them unreachable.** If a test needs content
  it cannot have in a clean checkout, it must skip *loudly and explicitly*, not
  silently.
- **Synthetic fixtures are allowed; synthetic learner content is not.** See
  [content policy §6.1](content-policy/PRODUCT_PRINCIPLES.md). Fixtures must be
  visibly identifiable and are hard-wired to `sourceKind: "test_fixture"`.

## Code conventions

- **TypeScript, strict.** No `any` unless nothing else is honest; if you need it,
  say why in a comment.
- **Comments explain why, not what.** The code says what it does. A comment earns
  its place by recording a decision, a trap that was actually hit, or a trade-off.
- **Domain logic stays pure.** `src/domain/` must not import React, the
  database, the filesystem, or any LLM SDK. `tests/architecture.test.ts` enforces
  this.
- **Database access only through `src/repositories`.** No `node:sqlite` imports
  in pages, components or services.
- **Multi-step writes go in `repos.transaction()`.**
- **No new dependencies without discussion.** Every dependency is a maintenance
  and licensing liability. The bar is: does this meaningfully reduce risk or
  effort compared to 50 lines of our own code?
- **Server-side only when it needs to be.** Anything touching the filesystem,
  the database or secrets stays on the server. Client components receive
  projected, sanitised data.

## Architectural invariants

These are not conventions to be discussed in review — each is enforced by
`tests/architecture.test.ts`, and a change that violates one fails the suite.
They are listed here so you know what you are walking into before you write code,
not so you can be told about them afterwards.

| Invariant | Why |
| --- | --- |
| `node:sqlite` is importable only from `src/repositories` | one place to audit data access; UI and domain code cannot bypass the boundary |
| `src/domain/` imports no framework, database, filesystem or LLM SDK | domain logic stays testable and portable |
| planner and scoring read no clock and touch no database | same inputs must always produce the same plan |
| the exam date has one source (`src/domain/exam-facts.ts`) | a second copy will drift |
| date arithmetic is timezone-free; only "what day is it" reads local time | otherwise plans shift across DST and machines |
| every route that reads the database declares `force-dynamic` | a cached read would serve stale learner state |
| multi-step writes go through `repos.transaction()` | a partial write leaves the app in a state the planner cannot handle |
| local grading states its provenance and never impersonates AI | the product's honesty claim depends on it |
| three-state diagnostics: `assessed` carries a conclusion, the other two must be unknown | "not measured" must not be rendered as "weak" |
| display text is sanitised at one exit | new error sources are covered without being individually remembered |
| fixtures are hard-wired to `sourceKind: "test_fixture"` | a fixture must never be mistakable for a real paper |
| committed sources contain no real exam text | enforced by hash fingerprints, not by reviewer attention |
| client code carries no internal directory names | what a Client Component imports ships to the browser |

Two rules that are *not* enforced by a test, and therefore depend on you:

- **Do not weaken a guard to make it pass.** If a guard is wrong, fix the guard
  and explain why the old expectation was wrong. Deleting an inconvenient check
  is the failure mode all the others exist to prevent.
- **Do not claim a check passed without running it, on the tree you are shipping.**
  This project has already been burned once by a suite that was green on the
  machine that wrote it and red on a clean checkout.

## How this project uses AI

Development of this project involved substantial AI assistance: architecture,
implementation, tests and review. That is disclosed in the README and is not
something this repository hides.

What is not published is the internal working record — prompts, review threads
and task breakdowns. That material is process, not product: it is specific to one
team's workflow, it contains colleagues' context, and it does not help anyone use
or maintain the code. Its absence is not a concealment of AI involvement; the
involvement is stated plainly in the README.

If you contribute with AI assistance, you do not need to hide it. You do need to
be able to explain and defend the code you submit.


## Content and licensing

**The project's outbound licence is the [MIT License](LICENSE)** (SPDX: `MIT`).
Read the [full text](LICENSE) — it is the operative document, not this summary.

What that means for a contribution:

- **Inbound = outbound.** By opening a pull request you agree that your
  contribution may be distributed under the MIT License.
- **You keep your copyright.** Contributing does not transfer ownership; it grants
  the project the right to distribute your work under the terms above.
- **Third-party material is not covered.** MIT applies to this project's own code.
  A contribution carrying material you do not have the right to license cannot be
  relicensed by it — see below.

**Do not contribute third-party material you do not have the right to license.**
That includes exam papers, commercial course material, textbook excerpts,
screenshots of commercial products, and code copied from a repository whose
licence is incompatible with this one. If you are unsure, ask first.

If you add a dependency, update [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)
by running `node tools/dependency-notices.mjs` and including the diff. Dependency
licences (MIT, BSD, Apache-2.0, MPL-2.0 and others) are unaffected by the project's
own outbound licence, and their obligations survive it.

## What must not appear in a commit

Beyond study content, which has no exceptions, three categories are excluded
because they only make sense inside one team's history:

- **Internal records.** Decision identifiers, ticket prefixes, status-document
  names, the internal record directory. These are matched by shape in
  `tools/public-release-check.mjs`, not by a word list.
- **Internal review verdicts.** The outcome of an internal review or sign-off,
  quoted by role, tool name or review round, and the identifier of any internal
  finding it produced. A commit message and a comment are both public.
- **Internal process narration.** References to the specific assistant tooling,
  session or runtime configuration used while developing, in the sense of "this
  would pollute its context".

AI involvement in development is **not** in that list. It is disclosed in the
README and is not something this repository hides. The distinction is between
*how the code was built* — which is stated plainly — and *one team's working
record*, which is process, not product.

Two deliberate non-rules, recorded so nobody "fixes" them by accident:

- **Role words in prose are not banned.** `maintainer`, `reviewer`, `user` and
  the Chinese equivalents are ordinary engineering vocabulary. What is excluded
  is a *verdict* or a *record*, not the word for a person. A guard that banned
  the words would fire on legitimate prose and get ignored.
- **Naming a third-party source in a comment is discouraged, not forbidden by a
  list.** The check is structural: it matches the *shape* of "measured source:
  `<domain>`". A public list of forbidden brand names would itself publish which
  sources this project used, which is the very thing being kept out.

## Reporting security issues

Do not open a public issue. See [`SECURITY.md`](SECURITY.md).

## Conduct

Be decent. Argue about the work, not the person. Harassment, personal attacks and
dismissive behaviour are not welcome here; maintainers may close or remove any
contribution or comment that violates this, and repeat offenders may be blocked
from the repository.

This is a small project without a formal enforcement committee. If something is
wrong, say so plainly and directly in the relevant thread, or contact the
maintainer through the route in [`SECURITY.md`](SECURITY.md) if it is not
appropriate to raise publicly.

