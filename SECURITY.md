# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Report it privately through either channel:

1. **GitHub Security Advisories** — open a draft advisory on this repository
   ("Security" → "Advisories" → "New draft security advisory"). This is the
   preferred route because it keeps the discussion private and gives us a place
   to coordinate a fix and a disclosure date.
2. If you cannot use advisories, contact the maintainer through the address on
   their GitHub profile and state clearly that the report is a security issue.

Please include:

- the affected version or commit,
- what you did, step by step,
- what you observed, and what you expected,
- the impact you believe it has,
- any proof-of-concept material, ideally minimised.

**Do not include your own study content, exam papers or personal data in a
report.** A minimal reproduction almost never needs them, and this project's
whole design is built on that material staying local. If you think the report
requires it, describe the shape of the data instead and we will work out a safe
way to reproduce.

### What to expect

This is a single-maintainer, pre-1.0 project with no funding. Realistic
expectations:

| | |
| --- | --- |
| Acknowledgement | best effort, within ~7 days |
| Initial assessment | best effort, within ~30 days |
| Fix and coordinated disclosure | depends on severity and complexity |

There is **no bug bounty** and no paid support. Please do not disclose publicly
until a fix is available, or until 90 days have passed, whichever comes first.

## Supported versions

There are no releases yet. Only the current `main` branch is supported.

## Scope

### In scope

The application as shipped by this repository, in particular:

- **The reveal endpoint** (`src/app/api/course/reveal/route.ts`) and its
  confirmation model. It is the only place private study content leaves the
  service layer. Bypassing the explicit-confirmation state machine, forging a
  risk fingerprint, or obtaining passage text without a recorded confirmation are
  all in scope.
- **Origin and CSRF enforcement.** Same-origin POST checks are exact-match; a
  bypass (subdomain, port, scheme, `Origin` omission, `null` origin) is a
  finding.
- **Path containment** in the content pipeline: escaping the content root,
  following a symlink out of it, or a path-traversal bug in course/paper
  resolution.
- **The local annotation/intake servers.** They bind loopback only and use a
  per-session token. Token leakage into HTML, logs or URLs usable cross-origin is
  in scope.
- **Display sanitisation bypasses.** A path or internal directory name reaching
  the DOM, an error body, or the client bundle.
- **Data integrity**: bypassing the append-only triggers, or the re-entrant
  transaction boundary.
- **The dependency or build chain** as configured here (for example a lockfile
  substitution that makes `--frozen-lockfile` install attacker-controlled code).

### Out of scope

- **Anything requiring the attacker to already control your machine, your user
  account or your local files.** This application is explicitly a single-user,
  local-first tool with no authentication. Local privilege boundaries are not a
  security boundary here.
- **The absence of authentication.** That is the design, documented in the README.
  If you expose this app to a network, that is a deployment mistake, not a
  vulnerability. Do not run it on a public interface.
- **Content you imported yourself**, including whether you have the right to.
- **Denial of service against your own local instance.**
- **Reports generated purely by a scanner** with no demonstrated impact. Please
  show the path from input to effect.
- **Missing hardening headers on a local-only HTTP server** with no hostile
  origin in the threat model, unless you can show a concrete exploit.

## Security model of this application

Stating the model makes it possible to judge whether something is a deviation.

1. **Single user, single machine, loopback only.** Servers bind `127.0.0.1`.
   There is no authentication, because there is no remote user.
2. **Exact-origin enforcement.** State-changing requests must come from the exact
   local origin (`127.0.0.1` and `localhost` are *different* origins and are not
   interchangeable). A missing `Origin` is refused, not assumed safe.
3. **Content is revealed only on explicit, recorded confirmation.** The client
   holds a risk fingerprint; the server recomputes it and compares. Mismatch is
   `409` and the client's prior confirmation is voided. The client state machine
   — not the fingerprint — is what proves a human confirmed.
4. **Everything user-visible is sanitised at one exit.** Paths become a neutral
   placeholder; the readable explanation survives.
5. **The client bundle carries no internal layout.** Sanitisation is structural;
   no table of internal directory names ships to the browser.
6. **Content never enters the repository.** Enforced by `.gitignore`, by the
   export allowlist, and by a hash-fingerprint scan of every tracked file.

## Handling of this repository's own history

This repository is a curated public source distribution with fresh Git history.
It is not a mirror of any internal development repository. If you find a leftover
artefact — private content, personal data, internal notes, or third-party material
without redistribution rights — treat it as a security report and use the private
channel above. Do not paste the material into a public issue.

## Dependency update policy

### What is checked automatically, and when

Two mechanisms run on every push and every pull request, because each covers a
gap the other cannot:

| Mechanism | Covers | Runs |
| --- | --- | --- |
| `tools/check-dependency-security.mjs` | advisories against the resolved versions in `pnpm-lock.yaml` | every push and PR (`quality` job) |
| Dependabot (`.github/dependabot.yml`) | *new* versions of what is pinned, including the workflow actions | weekly, Monday 06:00 Asia/Shanghai |

The gate is fail-closed by design. It distinguishes three outcomes — the scan
found nothing (PASS), the scan found something at or above `high` (FAIL), and the
scan **could not run** (ERROR, non-zero). A blocked advisory endpoint is an ERROR,
never a silently clean result. It also refuses to report on a lockfile whose
dependency graph is empty or unreadable, because "no vulnerabilities in zero
packages" is not a finding.

`tools/dependency-security-controls.mjs` proves all three outcomes are reachable,
so a PASS cannot mean "the check was never wired up".

> **No single source finds every vulnerability.** The gate queries the npm advisory
> index, keyed by exact resolved versions. It cannot see an unpublished advisory, a
> compromised package that has not been reported yet, a vulnerability inside a
> prebuilt native binary, or anything outside npm. It is one layer. Pinning,
> `--frozen-lockfile`, SHA-pinned workflow actions and human review are the others.

### Repository settings this file cannot control

Dependabot **alerts** and the dependency graph are repository settings, not
configuration files. Their current state is reported in each release's notes
rather than asserted here, because a document that claims a setting is on cannot
verify it.

One consequence worth stating explicitly: Dependabot *security* updates are a
separate switch from the version updates configured in `.github/dependabot.yml`.
Opening a pull request that fixes an advisory does not require that switch, but
having alerts tracked in the Security tab does require the dependency graph to be
readable — which is why `pnpm-workspace.yaml` pins `pmOnFail: ignore`. Without it
pnpm 12 writes a two-document lockfile and the graph reports zero dependencies.

### Scoped exception: `braces` reached only through the lint toolchain

Recorded here rather than suppressed in `dependabot.yml`, because an `ignore:`
entry would also suppress security updates for that package.

| | |
| --- | --- |
| Package | `braces@3.0.3` |
| Advisory | `GHSA-vfj7-8cjw-p6xm` — stack exhaustion from deeply nested patterns |
| Dependency path | `braces` → `micromatch` → `fast-glob` → `@next/eslint-plugin-next` → `eslint-config-next` |
| Reachable from | development only (`devDependencies`); no runtime path |
| Upstream fix | none available — `3.0.3` is the newest published version |
| Status at the time of writing | the advisory was **withdrawn** on 2026-10-23 |

Why this is recorded rather than fixed: there is no fixed version to move to, and
the package is only reachable from the lint toolchain, which never ships. Why it is
recorded at all: "we decided this is fine" needs a date and a re-check condition, or
it silently becomes "we forgot".

**Re-check when any of the following becomes true:**

1. `braces` publishes a version above `3.0.3` — move to it and delete this entry.
2. The advisory is re-published (a withdrawal can be reversed) — re-assess against
   the actual dependency path before accepting it.
3. `eslint-config-next` stops depending on `micromatch`/`fast-glob`, or `micromatch`
   moves to a patched range — the path disappears and this entry is stale.
4. `braces` becomes reachable from anything other than `devDependencies` — this
   exception is void and the dependency needs a real fix.

The gate above does not suppress this package; if the advisory is reinstated, the
automatic scan will report it and this record is what a reviewer compares against.

## Known, accepted limitations

Documented rather than hidden:

- `node:sqlite` is flagged experimental by Node. It is the chosen data layer;
  version pinning is the mitigation.
- No CI-enforced dependency signing or SLSA provenance. The lockfile plus
  `--frozen-lockfile` is the current supply-chain control.
- GitHub secret scanning and push protection are **not yet enabled** for this
  repository; enabling them is a publication prerequisite tracked in the release
  checklist.
- The E2E suite binds several loopback ports and starts many local processes. It
  is intended for a developer machine, not shared infrastructure.
