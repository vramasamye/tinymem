# Mission 19: workspace scope rename (`@onememory` → `@onememory-ai`)

Branch: `mission/19-scope-rename` · Base: `f20c1ea` (main, the M16 merge) · Unblocks the M16
publish · Decision record: docs/adr/0014-npm-distribution.md (amendment, 2026-10-07) · Runbook:
docs/plan/release-process.md

## Why

M16 prepared the whole release against the scope `@onememory`. At publish time the npm org
`onememory` turned out to be **already claimed by a third party**: the registry reports the org as
existing (`200`) while owning zero packages — `@onememory/core` and the unscoped `onememory` both
resolve `404`. The scope was therefore unusable, and the 17 internal packages could never publish
under it.

Two facts decided the shape of the fix:

- **`onemem` is taken** as both an org and a package, which is precisely why the CLI package is
  named `onememory` rather than `onemem` (npm reserves *package* names, not bin names — the
  `onemem` binary is unaffected).
- **The unscoped `onememory` package name is free** (`404`), and unscoped names are independent of
  orgs. So the flagship install path — `npx onememory init` — survives the scope change untouched.

`@onememory-ai` was chosen as the replacement scope: closest to the brand, reads as a package scope
rather than a domain (`@getonememory` reads like a marketing URL in an import), and free as both an
org and a package.

## Scope delivered

1. **A guard test first** (`scripts/lib/scope.test.ts`, 5 tests) pinning the three invariants: every
   publishable package is under the new scope, the CLI is the only unscoped package name, and no
   source file references the abandoned scope.
2. **The rename**: 377 files rewritten by a text-safe sweep (skips binaries, `node_modules`,
   `dist`, `.release`, `.git`, the local PGlite data dir), covering every manifest, import, doc,
   ADR, CI file, script and `bun.lock`.
3. **Re-verification**: typechecks for 11 packages, the tooling suites (31 tests), a full
   build → stage → pack, and the packed-artifact smoke under Node.

## The guard's own failure mode (worth recording)

The first guard run **failed on itself**. The sweep rewrote the guard's `@onememory(?![-\w])`
patterns into `@onememory-ai(?![-\w])` — which matches everything — and also rewrote the guard's
comments into contradictions. A scope sweep is a rename of its own subject matter, so any literal
of the old scope inside the guard becomes a false-positive generator the moment the sweep runs.

Fixed by assembling the abandoned scope from string fragments (`'@' + 'onememory'`) and keeping the
literal out of comments entirely, with a comment explaining why. The next such sweep cannot corrupt
it. This is the kind of self-inflicted trap that a "just run sed" rename ships silently.

## Validation

- `scripts/lib/scope.test.ts`: 5 pass / 0 fail (plus the 26 M16 tooling tests, all still green —
  31 total). The guard is non-vacuous: it scans 500+ files and asserts the scan itself.
- Typechecks: core, storage, retrieval, mcp, config, llm, adapters (claude/codex/cursor), api, cli
  — all clean.
- Build: 18 packages, 24 entries; staged manifests verified (`@onememory-ai/mcp` with
  `@onememory-ai/*` deps rewritten to `^0.1.0`; the CLI staged as `onememory` with bin `onemem`).
- Pack: 17 scoped tarballs (`onememory-ai-*.tgz`) plus the unscoped `onememory-0.1.0.tgz`.
- Packed smoke under npm + Node (Bun stripped from PATH): **all checks pass** — install, artifact
  hygiene, `onememory init`, `onemem doctor` (no failing checks), `remember` → `search`, and
  `npx onememory init` + `doctor`.
- Full repo `bun test`: recorded in the commit message.

## Files changed

New:
- `scripts/lib/scope.test.ts`, this report.

Modified:
- 377 files across `packages/`, `packages/adapters/`, `apps/`, `docs/`, `scripts/`, `.github/`,
  root configs and `bun.lock` (every `@onememory/` reference → `@onememory-ai/`).
- `docs/adr/0014-npm-distribution.md` (scope amendment), `docs/plan/release-process.md` (scope
  note), `docs/plan/phased-plan.md` (M16 row).

## Residual risk (carried into the publish)

npm may reject a *new* unscoped package name that collides with an existing org name. The registry
currently shows `onememory` unpublished, so the first publish attempt is the real test. Fallback if
it is refused: publish the CLI as `@onememory-ai/onememory` and document
`npx @onememory-ai/onememory init`. That is recorded in the ADR-0014 amendment.

## Commits

- `feat: rename the workspace scope to @onememory-ai` (with the guard test and the docs sync).

## Coordinator follow-ups

1. The publish itself remains gated on npm auth in the working shell (the org was created in the
   user's browser session; `npm whoami` still returns `ENEEDAUTH` here).
2. If the CLI name is refused, apply the documented fallback before announcing the release.
