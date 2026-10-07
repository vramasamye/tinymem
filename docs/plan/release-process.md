# Release process (npm)

How a commit becomes `npx onememory init` on a user's machine. Decisions live in
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
`dist/runtime/index.js` for `@onememory/api`, `dist/bin.js` for the five bins) and declarations
mirroring the source layout. Bare specifiers stay external (`--packages=external`), so the
manifest's dependency graph is the truth; bundling is what makes the repo's extensionless relative
imports work on Node's ESM loader. Bins are rewritten to `#!/usr/bin/env node` and chmod 0755.

Runtime assets declared in a manifest's `files` ship alongside `dist/` —
`@onememory/storage` ships its SQL `migrations/`, without which no install could migrate its own
database.

## What the smoke proves (and why it is the real gate)

The unit suites run under Bun and import `bun:test`, so they cannot prove Node compatibility. The
smoke installs the packed tarballs into a scratch directory with **npm and Node only** (Bun is
stripped from `PATH` for every child process) and then:

1. `onememory init` scaffolds a scratch project (local preset, offline),
2. `onemem doctor --json` reports no failing checks,
3. `onemem remember` → `onemem search` round-trips a memory through embedded PGlite,
4. `npx onememory init` + `doctor` — the documented install path,
5. hygiene: `node` shebangs, no `workspace:` specifiers, no `bun` shebangs in the installed files.

CI runs exactly this (`packed-artifacts` job) on every push. It has already paid for itself: the
first run caught an undeclared dependency (`@modelcontextprotocol/client` in `@onememory/mcp`,
invisible in the monorepo because npm hoists), the missing SQL migrations, and a bundle-relative
path that resolved outside the installed package.

## Versioning and order

One version across the workspace (currently `0.1.0`, pre-1.0 honest). `release.ts` refuses to run
if the manifests disagree. Publish order is topological over `@onememory/*` edges, alphabetical
within a level, and is printed by `release.ts order`; the CLI (`onememory`) is always last.

To cut a release: bump `version` in every manifest (they must match), run the pipeline above, then
publish in the printed order. Bumping the version is deliberately manual — it is a product
decision, not a build artifact.

## The Bun boundary

`onemem serve` (the daemon) and the MCP `http` transport use `Bun.serve` and fail with an explicit
message under Node. Everything else — `init`, `doctor`, `remember`, `search`, `digest`, `export`,
the adapters, and the stdio MCP server — runs on Node LTS ≥ 22. Running the daemon under Bun is
the documented path: `bunx --bun onememory serve`. A Node HTTP adapter is tracked in the backlog,
not in the packaging layer.
