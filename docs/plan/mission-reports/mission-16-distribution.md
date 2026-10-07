# Mission 16: npm distribution

Branch: `mission/16-distribution` · Base: `e4b6dcb` (main, the M17 merge) · Closes the M16 row of
Phase 7 Wave B (docs/plan/phased-plan.md) · Decision record: docs/adr/0014-npm-distribution.md ·
Runbook: docs/plan/release-process.md

## Scope delivered

Wave B's last item: make `npx onememory init` the real install path, publish every workspace
package, and smoke-test the published artifacts in CI. Reconnaissance on `main` found the workspace
was **not publishable at all**, so most of this mission is the packaging layer that had to exist
first.

### 1. Portability: the bins could not run under Node (`c51c4e3`)

- `import.meta.main` is Bun/Deno-only; Node leaves it `undefined`, so all five bins would have
  exited silently after install. New `isMainModule(import.meta.url)` in `packages/core`
  (realpath comparison against `process.argv[1]`, so an npm `node_modules/.bin` symlink matches)
  replaces it. The first cut took no argument and compared the *helper's* own URL — a regression
  test now pins the parameter, because a zero-arg version silently reports "not the entry point"
  for every caller.
- The Cursor hook bin declared itself a `bin` but had no shebang at all.

### 2. Build: `dist/` artifacts (`9ec8d93`)

`scripts/build.ts` builds every publishable package: one Node-ESM bundle per **derived** entry
(`exports` minus the test-support family, plus `bin` targets) with `--packages=external`, then
`tsc -p tsconfig.build.json` for declarations. Bins are rewritten to `#!/usr/bin/env node` and
chmod 0755. 18 packages, 24 entries, ~57s, fully offline and deterministic; `dist/` stays
gitignored.

### 3. Stage and pack: a manifest that npm can consume (`9ec8d93`)

Repo manifests keep pointing at `./src/*.ts` (the dev/test loop is untouched) and every publishable
package now sets `"private": true`, so publishing from a package directory is structurally
impossible. `scripts/release.ts` writes the publishable manifest into `.release/stage/`
(`workspace:*` → `^0.1.0`, paths → `dist/`, `files`, `engines`, `publishConfig`, dev-only fields
stripped), copies declared runtime assets, then `npm pack`s in topological dependency order and
records the plan. `publish` requires an explicit `--yes` (or `--dry-run`).

### 4. Smoke: the Node gate (`9ec8d93`)

`scripts/smoke-packed.ts` installs the 18 tarballs into a scratch directory outside the repo with
**npm + Node only** (Bun is stripped from `PATH`; stdin is closed and every child has a timeout),
then runs `onememory init`, `onemem doctor --json`, a `remember` → `search` round-trip through
embedded PGlite, `npx onememory init` + `doctor`, and artifact hygiene checks. CI runs it as the
`packed-artifacts` job on every push.

### Three published-artifact bugs the tooling caught

None of these were visible to the repo's own test suite, which is exactly why the packed smoke is
the gate (ADR-0014 §5–6):

1. **An undeclared dependency.** `@onememory/mcp` imported `@modelcontextprotocol/client` while
   declaring it only as a `devDependency`; npm hoisting hid it in the monorepo, and every consumer
   install failed with `ERR_MODULE_NOT_FOUND`. Fixed in `packages/mcp/package.json`; the release
   pre-flight now extracts real import specifiers from the built bundles and refuses to stage a
   package with undeclared imports.
2. **The SQL migrations were never shipped**, and `migrationsFolder()` resolved
   `../../migrations` relative to the module's own depth — correct for `src/drivers/migrate.ts`,
   but from the inlined `dist/index.js` it pointed one level *outside* the installed package. So
   `init` failed on the first user install with drizzle's `Can't find meta/_journal.json`.
   `migrationsFolder()` now anchors at the package root (found by walking up to the nearest
   `package.json`, which is correct in both layouts) and `@onememory/storage` declares
   `files: ["dist", "migrations"]`.
3. **A bin with no shebang** (Cursor hook, fixed in the portability commit).

## Acceptance criteria vs delivered

| AC (Wave B DoD) | Delivered |
| --- | --- |
| `npx onememory init` scaffolds a scratch project with no repo checkout; `onemem doctor` passes there | Yes, as a CI-enforced check: the packed smoke runs exactly those two commands through `npx` with npm + Node only (Bun absent from PATH) and asserts exit 0 + zero failing doctor checks |
| Packages published | Prepared, not executed: 18 tarballs build, stage and pack cleanly, and the publish plan is printed in dependency order. The registry write is deliberately gated on explicit user confirmation (see below) |
| CI smoke-tests the published artifacts | Yes: the `packed-artifacts` CI job builds → stages → packs → smokes on every push |

## Design decisions

- **Bundled per entry, dependencies external.** Bundling is what makes the repo's ~1000
  extensionless relative imports work on Node's ESM loader; `--packages=external` keeps the
  manifest the single source of truth for the dependency graph. Entries are *derived* from
  `exports`/`bin`, so a new subpath export cannot be forgotten by a build table.
- **Repo manifests stay dev-shaped; the staged manifest is the published one.** 17 hand-maintained
  publish manifests would drift; one reviewed, unit-tested rewrite cannot. `private: true` makes
  the staging path structural rather than a convention.
- **Membership comes from the workspace globs, not from `private`.** Since every publishable
  package is `private: true` as a guard, `private` cannot double as the publishability marker; the
  tooling derives the publishable set from the root `workspaces` globs minus an explicit
  non-publishable list (`apps/web`, `benchmarks/eval`).
- **Runtime assets are declared, not guessed.** `files` in the repo manifest is the published file
  list; the staging step copies exactly that and fails if a declared path is missing.
- **The smoke is the Node-compatibility claim.** ADR-0001 promised Vitest-under-Node in CI, but
  there is no vitest config and the suites import `bun:test`; the honest, end-to-end proof is
  installing the artifacts with npm + Node and driving the CLI. ADR-0014 records that substitution.
- **The Bun boundary is explicit, not hidden.** `serve` and the MCP HTTP transport keep failing
  loudly under Node; the release doc documents `bunx --bun onememory serve` and the backlog tracks
  a Node adapter.

## Validation

- Tooling unit tests (bun:test): `scripts/lib/manifest.test.ts` 8, `publish.test.ts` 12,
  `deps.test.ts` 6 — 26 pass / 0 fail, including checks against the real workspace manifests  (every publishable package derives entries under `src/`, carries the private guard, stages
  without a `workspace:` specifier, and has a cycle-free publish order).
- `packages/core` `is-main-module.test.ts` 8 pass / 0 fail (symlinked bin, missing entry, the
  helper-URL regression).
- Build: 18 packages, 24 entries, 5 bins; `dist/bin.js` shebangs verified `node`.
- Pack: 18 tarballs; `onememory-storage-0.1.0.tgz` verified to contain `migrations/0002_*.sql` and
  `migrations/meta/_journal.json`.
- Packed smoke: **all checks pass** — npm install, artifact hygiene, `onememory init`, `onemem
  doctor` (no failing checks), `remember` → `search`, `npx onememory init` + `doctor`.
- Full repo `bun test` in the mission worktree: **2123 pass / 56 skip / 0 fail** (2179 tests across
  191 files, 613s), up from main's 2089 pass / 56 skip / 1 load-flake — the 34 new tests of this
  mission (26 tooling + 8 `is-main-module`) with zero regressions.

## Files changed

New:
- `scripts/build.ts`, `scripts/release.ts`, `scripts/smoke-packed.ts`
- `scripts/lib/manifest.ts` (+ test), `scripts/lib/publish.ts` (+ test), `scripts/lib/deps.ts` (+ test)
- `packages/core/src/util/is-main-module.ts` (+ test)
- `docs/adr/0014-npm-distribution.md`, `docs/plan/release-process.md`, this report
- 18 × `tsconfig.build.json`

Modified:
- every publishable `package.json` (`private: true`; storage also `files`, mcp also the missing
  dependency)
- the five bins (portable guard; Cursor's missing shebang), `packages/core/src/index.ts`
- `packages/storage/src/drivers/migrate.ts` (package-root anchor)
- `.github/workflows/ci.yaml` (`packed-artifacts` job), `.gitignore` (`.release/`),
  root `package.json` (build/release/smoke scripts), `bun.lock`
- `docs/plan/phased-plan.md` (Wave B status)

## Commits

- `c51c4e3` fix: make every published bin run under Node (portable main-module guard)
- `9ec8d93` feat(release): build, stage and smoke-test the publishable artifacts
- docs commits follow this report.

## Coordinator follow-ups

1. **The real publish is pending explicit user confirmation.** The pipeline is ready: 18 tarballs
   at `.release/tarballs/`, publish order printed by `release.ts order`. The first publish must be
   authorized per ADR-0014's staging rules, and npm provenance/attestation is not wired yet.
2. **Tarball metadata**: no `repository`/`homepage`/`bugs` fields and no per-package README, so npm
   pages will be sparse. Worth a small follow-up before announcing the release.
3. **`test:node` (vitest) is still unwired** — ADR-0001's original wording. The packed smoke
   supersedes it as the Node gate, but the root `test:node` script remains a no-op-ish path; either
   wire it or drop it from ADR-0001's text in a later amendment.
4. **A Node HTTP adapter for `serve`** (`@hono/node-server`) is tracked in the M13 report and the
   backlog; it is a runtime feature, not a packaging one.
