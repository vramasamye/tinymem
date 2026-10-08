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
  keeping every bare specifier (`zod`, `hono`, `@onememory-ai/*`, `node:*`) external — so the
  dependency graph in the manifest is still the truth and no library code is duplicated.
- Types: `tsc -p tsconfig.build.json` with `declaration` + `emitDeclarationOnly`, `rootDir: src`,
  `outDir: dist`, excluding tests and scenario files.
- Entries are **derived from the manifest**: every target in `exports` that is not test-support,
  plus every `bin` target. `@onememory-ai/api` therefore ships both `dist/index.js` and
  `dist/runtime/index.js` (the subpath the CLI imports), and no hand-maintained build table can
  drift from the manifests.
- **Runtime assets ship with the code.** A manifest may list files beyond `dist/` in `files`
  (`@onememory-ai/storage` ships `migrations/`, the SQL set every install needs to create its own
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

**Test scaffolding never ships, and that is asserted rather than assumed.** Excluding a subpath
from `exports` is not enough: the declaration pass follows imports, so a test helper imported by
another test file (`test-world.ts`, `skills/fixtures.ts`, `test-support.ts`,
`testing/transcripts.ts`) still lands in `dist/` unless the *importers* are excluded too — which is
how four stray `*.d.ts` files reached the tarballs until the first dry run showed them.
`tsconfig.build.json` now excludes the whole scaffolding family, `scripts/build.ts` fails the build
if any test artifact reaches `dist/`, and the packed smoke checks the installed packages for the
same. Dropping one exclude is enough to fail the build, so the guard is not decorative.

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
`@modelcontextprotocol/client` hidden in `@onememory-ai/mcp`'s devDependencies on its first run.

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
  `@onememory-ai/*` versions would no longer be expressible as dependencies).
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

## Amendment (2026-10-07): the workspace scope is `@onememory-ai`

The release was prepared with the workspace scope `@onememory`. At publish time the npm org
`onememory` turned out to be **already claimed by a third party** — it owns zero packages (both
`@onememory/core` and `@onememory` resolved 404), but the scope itself is unavailable, so those
names could never be published by this project. The workspace scope is therefore `@onememory-ai`
(`mission/19-scope-rename`):

- **17 internal packages** publish as `@onememory-ai/<name>`. The rename is mechanical and total:
  manifests, imports, docs, ADRs and the lockfile.
- **The CLI package keeps the unscoped name `onememory`**, because that is what the documented
  install path depends on: `npx onememory init`. Unscoped names are independent of orgs, and the
  registry shows `onememory` unpublished. The binary name `onemem` is unaffected (npm reserves
  package names, not bin names — `onemem` is taken as both an org and a package, which is exactly
  why the CLI is named `onememory`).
- **A guard test enforces it** (`scripts/lib/scope.test.ts`): every publishable package is under the
  new scope, the CLI is the only unscoped name, and no source file still references the abandoned
  scope. The guard assembles the abandoned scope from string fragments, because a single literal
  would itself be rewritten by any future scope sweep — the first run of the guard flagged its own
  comments, which is the failure mode the fragments exist to prevent.

One residual risk this amendment records: npm may reject a *new* unscoped package name that
collides with an existing org name. If `onememory` is refused at publish time, the fallback is to
publish the CLI as `@onememory-ai/onememory` and document `npx @onememory-ai/onememory init`.

## Amendment (2026-10-08): publishing authenticates by 2FA in a terminal, and by trusted publishing (OIDC) in CI — never by a stored token

Preparing the first release hit npm's 2026 authentication policy head-on:

- **npm requires 2FA for every publish.** An account set to `auth-and-writes` gets `EOTP` for any
  write, and npm has removed TOTP authenticator apps, so the interactive proof is a browser
  challenge (passkey/security key), not a paste-able code.
- **Tokens are being retired as a publishing surface.** Bypass-2FA granular access tokens lost
  account/org/package management in August 2026 and lose *direct publish* in January 2027, when
  their write surface shrinks to staging (npm v12 changelog; community discussion #201329). A
  non-bypass token — like the one configured for this release — cannot publish at all: every
  attempt returns `EOTP`.
- **The sanctioned no-token path is trusted publishing (OIDC)**, but a trusted publisher can only
  be configured on a package that already exists. For a brand-new 18-package release that is a
  chicken-and-egg problem (namespace-wide OIDC is roadmap-only, no date).

Decisions:

1. **The first release is human-driven.** A person runs
   `bun run scripts/release.ts publish --yes` in an interactive terminal, completes npm's browser
   challenge once, and lets the resumable publish loop (M21) carry the sequence; a failure resumes
   with `--from`. No stored token is involved at any point.
2. **Every later release publishes from CI by OIDC** (`.github/workflows/release.yml`):
   `id-token: write`, npm CLI ≥ 11.5.1 on Node ≥ 24, workflow-dispatch only — a registry write is
   deliberate. After the first release, a trusted publisher is configured per package on npmjs.com
   (GitHub Actions, `vramasamye` / `tinymem` / `release.yml`, "Allow npm publish" ticked, since
   configurations created after 2026-09-03 default to stage-only). Each configuration must
   complete a successful publish within 2 days or it expires; that expiry only deletes the
   configuration, never the package.
3. **Staged manifests carry repository metadata, derived from the root manifest.** Trusted
   publishing validates `repository.url` against the publishing workflow, and the npm package page
   renders `repository`/`homepage`/`bugs`. A monorepo package points at the repo with `directory`
   naming its own subdirectory. The root `package.json` is the single source of truth for the URL —
   the git remote may carry an SSH host *alias* (`git@github.com-personal:…`) that no tool can
   resolve — and staging refuses to run without it: a bare package page is a defect, not a
   convenience. `scripts/lib/publish.ts` derives and unit-tests all of this
   (`githubRepoOf`, `repoMetadataOf`).

The granular token configured during release preparation (`onememorynpm`) has no bypass and
therefore no publishing use; it is revoked once the trusted publishers are validated.

## Amendment (2026-10-08): the CLI is `@onememory-ai/cli`

The first release published all 17 scoped packages and then the registry refused the unscoped CLI:
`403 Forbidden — Package name too similar to existing package one-memory`. The residual risk the
2026-10-07 amendment recorded came true, though through npm's similar-name check rather than an org
collision. That check does not apply to names inside a scope the publisher owns, so:

- **The CLI package is `@onememory-ai/cli`.** Every published package now lives under one scope;
  there is no unscoped name left for the registry to refuse. `cli` was chosen over the earlier
  fallback `@onememory-ai/onememory` because the scope already says "onememory".
- **The install path is `npx @onememory-ai/cli init`.** npx runs a package's only bin, so the
  command works unchanged; the binary stays `onemem`. Running the daemon under Bun, where the bin
  name differs from the package name, is `bunx --bun -p @onememory-ai/cli onemem serve`.
- **The guard tightens** (`scripts/lib/scope.test.ts`): no publishable package may be unscoped, the
  smoke must drive `npx @onememory-ai/cli`, and the root entry docs must advertise that command and
  never the refused one.

Mentions of `npx onememory init` earlier in this ADR and in mission reports are the historical
record of what was planned; this amendment supersedes them.

## References

ADR-0001 (stack/runtime), ADR-0002 (embedded profile's single-owner process model),
`docs/plan/phased-plan.md` (Phase 7 Wave B), `docs/architecture/repository-structure.md`
(`scripts/` = release tooling), mission report `docs/plan/mission-reports/mission-16-distribution.md`.
