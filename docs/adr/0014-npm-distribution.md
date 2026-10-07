# ADR-0014: npm distribution — built `dist/` artifacts, staged publish manifests, Node LTS bins

Status: Accepted (mission M16, 2026-10-07) · Date: 2026-10-07 · Supersedes: none · Builds on:
ADR-0001 (TypeScript/Bun monorepo, Node-compatible published packages)

## Context

Wave B's last item is distribution: `npx onememory init` must be the real install path, and the
phased plan's DoD requires the published artifacts to be smoke-tested in CI. Reconnaissance on
`main` (`e4b6dcb`) found the workspace is not publishable as it stands:

- **Everything is raw TypeScript.** Each manifest points `exports`/`main`/`types` at `./src/*.ts`
  and `bin` at `./src/bin.ts`. Node LTS cannot execute those entrypoints.
- **Relative imports carry no extensions** (0 of ~1000 specifiers, e.g. `'../drivers/client'`), so
  publishing untransformed ESM would fail to resolve under Node's ESM loader.
- **Inter-package deps use `workspace:*`**, which npm does not rewrite at publish time; installing
  such a tarball fails with `Unsupported URL Type "workspace:"`.
- **Bun-only APIs leak into the published surface.** Both bins start with
  `#!/usr/bin/env bun`, and every bin guards execution with `if (import.meta.main)` — a
  Bun/Deno-only property that Node leaves `undefined`, so a Node-installed `onemem` would exit
  silently without doing anything. `Bun.serve` is additionally used by `onemem serve`
  (`apps/api/src/runtime/daemon.ts`) and the MCP HTTP transport (`packages/mcp/src/bin.ts`).
- **No `files` field and no `.npmignore`** anywhere, so `npm pack` would ship sources, tests and
  fixtures.

## Decision

**1. The published artifact is a built `dist/`, one bundle per public entry, plus emitted
declarations.**

- JS: `bun build <entries> --target node --format esm --packages=external --outdir dist --root src`.
  Bundling per entry (not per file) is what makes extensionless relative imports a non-issue while
  keeping every bare specifier (`zod`, `hono`, `@onememory/*`, `node:*`) external — so the
  dependency graph in the manifest is still the truth and no library code is duplicated.
- Types: `tsc -p tsconfig.build.json` with `declaration` + `emitDeclarationOnly`, `rootDir: src`,
  `outDir: dist`, excluding tests and scenario files.
- Entries are **derived from the manifest**: every target in `exports` that is not test-support,
  plus every `bin` target. `@onememory/api` therefore ships both `dist/index.js` and
  `dist/runtime/index.js` (the subpath the CLI imports), and no hand-maintained build table can
  drift from the manifests.
- **Runtime assets ship with the code.** A manifest may list files beyond `dist/` in `files`
  (`@onememory/storage` ships `migrations/`, the SQL set every install needs to create its own
  database). The staging step copies exactly what the manifest declares, and the build anchors such
  paths at the *package root* rather than at a module's own depth: the published bundle inlines
  every module into `dist/index.js`, so a `../../migrations` written for `src/drivers/` resolved
  one level outside the installed package — invisible in the repo, fatal on the first user install
  (caught by the packed smoke).

**2. Repo manifests stay dev-oriented; publishing goes through a staged manifest.**

Package manifests keep pointing at `./src/*.ts` (the monorepo's test and dev loop must keep reading
sources), and gain `"private": true` so `npm publish`/`bun publish` cannot accidentally ship an
unbuilt package. `scripts/release.ts` writes the publishable manifest into a staging directory per
package, where it:

- rewrites every `workspace:*` dependency to `^<version>` (the workspace is single-versioned),
- repoints `exports`/`main`/`types`/`bin` at `dist/`,
- drops test-support subpaths (`./testing`, which import `bun:test`) and the `private` guard,
- adds `files: ["dist"]`, `engines: { node: ">=22" }`, `publishConfig.access: "public"` (scoped
  packages), and strips `scripts`/`devDependencies`.

The staged manifest is the only thing that is packed or published: one reviewed, unit-tested
rewrite instead of 17 hand-edited manifests that can disagree.

**3. Bins run under Node; `serve` is the one Bun-only command.**

`dist` bins carry `#!/usr/bin/env node` (the build rewrites the source's `#!/usr/bin/env bun`), and
the `import.meta.main` guards become a portable `isMainModule()` check (`packages/core`), so the
same file works under Node and Bun. `onemem serve` and the MCP `http` transport still require Bun
and keep failing loudly (`"requires the Bun runtime (Bun.serve)"`); running the CLI under Bun
(`bunx --bun onememory serve`) is the documented path for the daemon. Everything else — `init`,
`doctor`, `remember`, `search`, `digest`, `export`, stdio MCP, adapters — runs on Node LTS ≥22.

**4. One version across the workspace, published in dependency order.**

All packages share the version in the manifests (currently `0.1.0`, pre-1.0 honest: the plan's 1.0
line is a product statement, not a claim that the npm surface is frozen). `scripts/release.ts`
publishes in topological order (`core` → leaves → `mcp`/`api` → adapters → `onememory` CLI) so a
consumer never resolves a dependency that does not exist yet. Dist-tag `latest`.

**5. The Node-compatibility claim is verified by a packed-artifact smoke, not by assertion.**

`scripts/smoke-packed.ts` builds, packs every tarball, installs them into a scratch directory
outside the repo with **npm + Node** (no Bun on the PATH), then runs `npx onememory init` and
`onemem doctor` in a fresh project and asserts both exit 0 plus that no installed file contains a
`workspace:` specifier or a `bun` shebang. CI runs it on every push. This replaces the ADR-0001
"CI runs package tests under Vitest" wording as the operative Node gate: the unit suites import
`bun:test`, so the honest Node check is the artifact one, end to end.

**6. Dependency completeness is checked against the built bundles.**

Because the monorepo hoists one `node_modules`, a package can import something it never declared
and still pass every test in the repo — then break every install. The release pre-flight reads the
dist bundles, extracts real import specifiers (column-0 anchored, so template-embedded scaffold
code is not mistaken for imports) and refuses to stage a package whose imports are not all
declared in `dependencies`/`peerDependencies`/`optionalDependencies`. It found
`@modelcontextprotocol/client` hidden in `@onememory/mcp`'s devDependencies on its first run.

## Options considered

- **Publish TypeScript sources and rely on Node ≥22.18 type-stripping** (rejected: requires
  explicit `.ts` import specifiers, disallows the repo's extensionless style, and silently depends
  on a Node minor version for the flagship install path).
- **Unbundled `tsc` emit** (rejected: extensionless relative specifiers break Node ESM; rewriting
  specifiers at build time adds a codemod with no benefit over bundling).
- **`bun publish` straight from the package dir** (rejected as the primary path: it would publish
  the dev manifest's `.ts` entries; a staged manifest is reviewable and testable without a
  registry).
- **Bundling dependencies too** (rejected: duplicated library code, broken dedupe/audit story, and
  `@onememory/*` versions would no longer be expressible as dependencies).
- **Shipping a Node adapter for `serve` now** (`@hono/node-server`) — deferred: it is a runtime
  feature with its own tests, tracked in the M13 report and the backlog, not a packaging concern.

## Consequences

- `npm pack`/`npm publish` are only meaningful through `scripts/release.ts`; the repo manifests'
  `private: true` makes that structural rather than a convention.
- Every build step is deterministic and offline; no bundler config beyond the script's entry
  derivation, no new runtime dependency.
- `.d.ts` files keep extensionless relative specifiers (tsc emit with `moduleResolution: bundler`),
  which is fine for bundler/Node16 consumers and is the documented cost of not adding a
  d.ts-bundler dependency. If a consumer ever needs `nodenext`-clean types, that is a follow-up
  ADR.
- The `serve` gate is now user-visible in the published surface: the CLI documents Bun as the
  daemon runtime, and a Node-only user gets an explicit error instead of a crash.
- CI gains the pack smoke, so a packaging regression fails the build rather than the user's first
  `npx`.

## References

ADR-0001 (stack/runtime), ADR-0002 (embedded profile's single-owner process model),
`docs/plan/phased-plan.md` (Phase 7 Wave B), `docs/architecture/repository-structure.md`
(`scripts/` = release tooling), mission report `docs/plan/mission-reports/mission-16-distribution.md`.
