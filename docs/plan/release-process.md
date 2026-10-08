# Release process (npm)

How a commit becomes `npx @onememory-ai/cli init` on a user's machine. Decisions live in
[ADR-0014](../adr/0014-npm-distribution.md); this is the operational runbook.

## The shape of a release

The repo manifests are **dev manifests**: `exports`/`main`/`types` point at `./src/*.ts`, `bin` at
`./src/bin.ts`, and every publishable package sets `"private": true` — so nothing can be published
from a package directory, by accident or otherwise. Publishing goes through a **staged manifest**
whose `dist/` paths, rewritten `workspace:*` dependencies and published file list are derived by
`scripts/lib/publish.ts` and unit-tested against the real workspace.

```
bun run build                 # dist/ JS + .d.ts for all 18 packages (scripts/build.ts)
bun run scripts/release.ts order        # the publish plan, in dependency order (no writes)
bun run scripts/release.ts stage        # .release/stage/<pkg>/ with the publishable manifest
bun run scripts/release.ts pack         # .release/tarballs/*.tgz + .release/release-plan.json
bun run scripts/smoke-packed.ts         # install the tarballs with npm + node and drive the CLI
bun run scripts/release.ts publish --dry-run   # npm's per-tarball dry run
bun run scripts/release.ts publish --yes       # the real publish (explicitly confirmed)
```

`.release/` is gitignored; `dist/` is gitignored and never committed.

## What the build produces

Per publishable package: one bundled ESM file per public entry (`dist/index.js`, plus
`dist/runtime/index.js` for `@onememory-ai/api`, `dist/bin.js` for the five bins) and declarations
mirroring the source layout. Bare specifiers stay external (`--packages=external`), so the
manifest's dependency graph is the truth; bundling is what makes the repo's extensionless relative
imports work on Node's ESM loader. Bins are rewritten to `#!/usr/bin/env node` and chmod 0755.

Runtime assets declared in a manifest's `files` ship alongside `dist/` —
`@onememory-ai/storage` ships its SQL `migrations/`, without which no install could migrate its own
database.

## What the smoke proves (and why it is the real gate)

The unit suites run under Bun and import `bun:test`, so they cannot prove Node compatibility. The
smoke installs the packed tarballs into a scratch directory with **npm and Node only** (Bun is
stripped from `PATH` for every child process) and then:

1. `onemem init` scaffolds a scratch project (local preset, offline),
2. `onemem doctor --json` reports no failing checks,
3. `onemem remember` → `onemem search` round-trips a memory through embedded PGlite,
4. `npx @onememory-ai/cli init` + `doctor` — the documented install path,
5. hygiene: `node` shebangs, no `workspace:` specifiers, no `bun` shebangs in the installed files.

CI runs exactly this (`packed-artifacts` job) on every push. It has already paid for itself: the
first run caught an undeclared dependency (`@modelcontextprotocol/client` in `@onememory-ai/mcp`,
invisible in the monorepo because npm hoists), the missing SQL migrations, and a bundle-relative
path that resolved outside the installed package.

## Versioning and order

One version across the workspace (currently `0.1.0`, pre-1.0 honest). `release.ts` refuses to run
if the manifests disagree. Publish order is topological over `@onememory-ai/*` edges, alphabetical
within a level, and is printed by `release.ts order`; the CLI (`@onememory-ai/cli`) is always last.

**Scope.** All 18 packages publish under `@onememory-ai` — the npm org `onememory` was already
claimed by a third party (ADR-0014 amendment, 2026-10-07), and the registry refused the unscoped
CLI name as too similar to an existing package (amendment, 2026-10-08). The CLI is
`@onememory-ai/cli` with the bin `onemem`, so the documented install path is
`npx @onememory-ai/cli init`. `scripts/lib/scope.test.ts` enforces that no publishable package is
unscoped and that the root docs advertise that command.

To cut a release: bump `version` in every manifest (they must match), run the pipeline above, then
publish in the printed order. Bumping the version is deliberately manual — it is a product
decision, not a build artifact.

## Publishing and authentication (npm 2026 rules)

npm requires 2FA for every publish and is retiring token-based publishing entirely (bypass-2FA
tokens lose *direct publish* in January 2027; non-bypass tokens cannot publish at all). The
interactive proof is a **browser challenge** — npm removed authenticator-app codes — so there are
exactly two supported paths, recorded in ADR-0014's 2026-10-08 amendment:

**The first release of a package is human-driven.** In an *interactive* terminal:

```
bun run scripts/release.ts publish --yes
```

npm prints an auth URL (or offers to open it); complete the passkey challenge in the browser and
the publish proceeds. `release.ts` spawns npm with inherited stdio for exactly this reason: npm
only runs the browser flow when stdin and stdout are a TTY, and with piped output it fails fast
with `EOTP` and a redacted URL. If a package fails mid-sequence, the run reports exactly what published and
the `--from` command that resumes (`--only <name>` re-runs one package; `--otp <code>` passes a
numeric code through if npm ever offers one). npm redacts the challenge URL to `***` in captured
output, so this cannot be driven from a non-interactive shell — that is by design.

**Every later release publishes from CI by trusted publishing (OIDC)** — no token anywhere:

1. Once a package exists, configure its trusted publisher on npmjs.com → package → Settings →
   Trusted publishing: provider **GitHub Actions**, organization `vramasamye`, repository
   `tinymem`, workflow filename `release.yml`, and tick **"Allow npm publish"** (configurations
   created after 2026-09-03 default to stage-only). A configuration must complete a successful
   publish within **2 days** or it expires (deleting the configuration, never the package) — so
   configure and then run the workflow promptly.
2. Run the **release** workflow (manual dispatch only): it tests, builds, stages, packs, runs the
   packed smoke, and publishes — authenticating with a short-lived OIDC token via
   `id-token: write` (npm ≥ 11.5.1, Node 24). Nothing about the git remote matters to npm: the
   staged manifest's `repository.url` must match `github.com/vramasamye/tinymem`, which
   `repoMetadataOf` derives from the root manifest.

All 18 packages (the CLI included) need their own one-time trusted
publisher configuration; 18 clicks, once, and no token ever exists to leak or rotate.

## Repository metadata

Staged manifests carry `repository` (with `directory` naming the package's own subdirectory),
`homepage` and `bugs`, derived by `scripts/lib/publish.ts` from the **root manifest's**
`repository` — the single source of truth, because the git remote may be an SSH alias
(`git@github.com-personal:…`) that no tool can resolve to a URL. Staging refuses to run if the
root manifest has no GitHub `repository`; `scripts/lib/scope.test.ts`-style unit tests pin the
derivation (`githubRepoOf`, `repoMetadataOf`).

## The Bun boundary

`onemem serve` (the daemon) and the MCP `http` transport use `Bun.serve` and fail with an explicit
message under Node. Everything else — `init`, `doctor`, `remember`, `search`, `digest`, `export`,
the adapters, and the stdio MCP server — runs on Node LTS ≥ 22. Running the daemon under Bun is
the documented path: `bunx --bun -p @onememory-ai/cli onemem serve`. A Node HTTP adapter is tracked in the backlog,
not in the packaging layer.
