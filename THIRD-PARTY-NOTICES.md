# Third-Party Notices

CET-6 Coach is distributed with third-party software. This file records the
licences of the dependencies that are installed by `pnpm install --frozen-lockfile`
and, where relevant, shipped (in bundled form) to the browser.

> **The project's own licence is MIT** (see [`LICENSE`](LICENSE)). It applies to
> **this project's source code only**. It does **not** relicense any dependency,
> and it does **not** extend to study content. Every entry below keeps its own
> terms, and the obligations those terms impose (notably MPL-2.0 file-level
> copyleft and Apache-2.0 notice requirements) survive the MIT grant and cannot
> be overridden by it.

> **Scope.** This notice covers **software** dependencies declared in
> `package.json` and resolved by `pnpm-lock.yaml`. It does not — and cannot —
> cover study content: exam papers, course material, audio and answer keys are
> **not distributed with this project**. See "Study content" below.

Generated from the installed dependency tree; see
[Regenerating this file](#regenerating-this-file).

---

## Direct runtime dependencies

These ship in the application bundle or run on the server.

| Package | Version | Licence | Project |
| --- | --- | --- | --- |
| `next` | 16.4.2 | MIT | <https://nextjs.org> |
| `react` | 19.2.8 | MIT | <https://react.dev> |
| `react-dom` | 19.2.8 | MIT | <https://react.dev> |
| `zod` | 4.6.5 | MIT | <https://zod.dev> |
| `ts-fsrs` | 5.4.2 | MIT | <https://github.com/open-spaced-repetition/ts-fsrs> |
| `lucide-react` | 1.48.0 | ISC | <https://lucide.dev> |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | <https://github.com/joe-bell/cva> |
| `clsx` | 2.1.1 | MIT | <https://github.com/lukeed/clsx> |
| `tailwind-merge` | 3.7.0 | MIT | <https://github.com/dcastil/tailwind-merge> |

## Direct development dependencies

These are used to build, lint or test the project. They are not part of the
application runtime.

| Package | Version | Licence |
| --- | --- | --- |
| `typescript` | 5.9.3 | Apache-2.0 |
| `eslint` | 9.39.5 | MIT |
| `eslint-config-next` | 16.4.2 | MIT |
| `vitest` | 5.0.5 | MIT |
| `jsdom` | 30.1.1 | MIT |
| `@playwright/test` | 1.63.0 | Apache-2.0 |
| `@testing-library/react` | 16.3.3 | MIT |
| `@testing-library/jest-dom` | 7.0.1 | MIT |
| `@testing-library/user-event` | 14.6.7 | MIT |
| `tailwindcss` | 4.3.3 | MIT |
| `@tailwindcss/postcss` | 4.3.3 | MIT |
| `postcss` | 8.5.28 | MIT |
| `pdfjs-dist` | 6.3.289 | Apache-2.0 |
| `@types/node` | 24.13.6 | MIT |
| `@types/react` | 19.3.0 | MIT |
| `@types/react-dom` | 19.3.0 | MIT |

`pdfjs-dist` is used by the course-intake pipeline to extract text from PDFs.
Its licence and that of its own bundled dependencies are reproduced in the
package's `LICENSE` file inside `node_modules/pdfjs-dist/`.

## Transitive dependency licences

The lockfile resolves 420 distinct packages. Grouped by declared licence:

| Licence | Count | Example packages |
| --- | --- | --- |
| MIT | 356 | `@babel/*`, `chai`, `jsdom`, `vite`, `vitest`, `zod`, `vite`'s `rolldown` |
| Apache-2.0 | 26 | `typescript`, `@playwright/test`, `pdfjs-dist`, `@swc/helpers`, `sharp`, `class-variance-authority` |
| ISC | 14 | `lucide-react`, `semver`, `minimatch`, `graceful-fs` |
| BSD-2-Clause | 9 | `entities`, `espree`, `estraverse`, `uri-js` |
| MPL-2.0 | 3 | `axe-core`, `lightningcss`, `lightningcss-win32-x64-msvc` |
| BSD-3-Clause | 3 | `esquery`, `source-map-js`, `tough-cookie` |
| MIT-0 | 2 | `@csstools/color-helpers`, `@csstools/css-syntax-patches-for-csstree` |
| CC0-1.0 | 2 | `language-subtag-registry`, `mdn-data` |
| 0BSD | 1 | `tslib` |
| Python-2.0 | 1 | `argparse` |
| CC-BY-4.0 | 1 | `caniuse-lite` |
| BlueOak-1.0.0 | 1 | `lru-cache` |
| Apache-2.0 AND LGPL-3.0-or-later | 1 | `@img/sharp-win32-x64` |

Every dependency's full licence text is present in its own directory under
`node_modules/`. Include those files when redistributing a built artifact.

### Notes on specific licences

- **MPL-2.0** (`axe-core`, `lightningcss`) is file-level copyleft. It applies to
  those files only; it does not extend to this project's source. If you modify
  those packages, your modifications to *their* files must be published under
  MPL-2.0.
- **CC-BY-4.0** (`caniuse-lite`) requires attribution when its data is
  redistributed. The attribution is carried by the package itself; it is a build
  dependency and its data is not embedded in the application output.
- **`@img/sharp-win32-x64`** carries a dual `Apache-2.0 AND LGPL-3.0-or-later`
  declaration. Verified facts, checked against the lockfile and the installed
  tree rather than assumed:
  - it is a **transitive optional dependency of `next`**, not a dependency of
    this project. `package.json` declares no `sharp` entry in either
    `dependencies` or `devDependencies`, and no file under `src/` or `scripts/`
    imports it;
  - it is pulled in so that Next's image-optimisation route *can* work. This
    project uses no `next/image` calls, so the code path is never exercised;
  - `pnpm-workspace.yaml` sets `allowBuilds: { sharp: false }`, so its
    post-install script — the step that would download and verify the platform
    binary — does not run;
  - it is present in the pnpm store because the package manager resolves
    optional dependencies for every platform, but it is not linked into the
    top-level `node_modules` and is not reachable from application code.
  - the resolved `sharp` version is **0.35.5**, which is the version that
    carries the librsvg fix for CVE-2026-96889. The version is not chosen here:
    `next@16.4.2` declares `sharp: ^0.35.5` as an optional dependency, so the
    upgrade follows from the Next.js security update rather than from a
    separate decision. The resolved value is recorded in `pnpm-lock.yaml` and
    is checked by `pnpm audit`.
- **`Python-2.0`** (`argparse`) is an MIT-compatible permissive licence and is
  used only through a build tool.

## Fonts, icons and images

- UI icons come from **`lucide-react`** (ISC). No icon font is bundled.
- **`public/`** contains only assets authored for this project, and no vector
  artwork: a service worker, `favicon.ico`, and four PWA icons
  (`icon-192.png`, `icon-512.png`, `icon-maskable-512.png`,
  `apple-touch-icon.png`) generated programmatically by
  `scripts/generate-icons.mjs`. That script writes the PNG bytes itself from
  arithmetic — no source image is read, and no image library is a dependency —
  so the icons are reproducible (`pnpm icons` regenerates them byte for byte)
  and carry no third-party licence.
- **No third-party screenshots, product photography or icon sets are
  distributed.** This matters: the internal development repository used
  reference screenshots of commercial products during design research, and those
  are deliberately absent here — they were never licensed for redistribution.

## Study content

**CET-6 past papers, commercial course material, listening audio, and answer
keys are not part of this distribution and are not covered by any licence
granted here.**

They are third-party copyrighted works. This project:

- does not ship them,
- does not claim any rights over them, and
- does not assert that redistributing them is lawful.

If you import your own copy into a local installation, that is a private act
between you and your copy. Whether it is lawful depends on your jurisdiction,
how you obtained the material, and the terms you agreed to. See the README's
[Licensing](README.md#licensing) section.

This distinction is structural, not a disclaimer added for form: the repository
has no content directory, the `.gitignore` excludes one, and the test suite fails
if real exam text appears in a tracked file (see
`tests/support/paper-fingerprints.ts`).

## Regenerating this file

```bash
node tools/dependency-notices.mjs
```

The tool walks the installed tree, reads each package's declared licence and
prints the summary above. It performs no network access.

---

If you believe something here is attributed incorrectly or is missing, please
open an issue or contact the maintainer via the route in
[`SECURITY.md`](SECURITY.md).
