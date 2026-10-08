# Mission 22: tokenless release (repository metadata, trusted publishing by OIDC)

Branch: `mission/22-tokenless-release` · Base: `a9a8235` (main, the M21 merge) · Decision record:
docs/adr/0014-npm-distribution.md (2026-10-08 amendment) · Found by: the second publish attempt.

## Why

The second publish attempt failed with `EOTP` even though a valid write-capable granular token was
configured. Primary-source diagnosis (npm docs, the npm v12 changelog, community discussion
#201329, token introspection via `/-/npm/v1/tokens`):

- **npm requires 2FA for every publish and removed authenticator-app codes** — the interactive
  proof is a browser challenge (passkey), not a paste-able code.
- **Tokens are being retired as a publishing surface**: bypass-2FA granular tokens lost
  account/org/package management in August 2026 and lose *direct publish* in January 2027;
  non-bypass tokens (ours: `bypass_2fa: false`) cannot publish at all.
- **The sanctioned no-token path is trusted publishing (OIDC)** — but a trusted publisher can only
  be configured on a package that *already exists*, so a brand-new 18-package release cannot start
  there (namespace-wide OIDC is roadmap-only).

So the first release must pass through a human's 2FA, and everything after it must never need a
token again. That required two missing pieces.

## Scope delivered

1. **Repository metadata in every staged manifest** (`repository` with the package's own
   `directory`, `homepage`, `bugs`). Trusted publishing validates `repository.url` against the
   publishing workflow and the npm package page renders all three; npm previously would have
   shown 18 packages with no repo link at all. Derived by pure, unit-tested functions:
   - `githubRepoOf` normalizes every usual GitHub remote/URL form to `https://github.com/<o>/<r>`
     and **refuses** non-GitHub hosts and SSH host *aliases* (`git@github.com-personal:…`) that no
     tool can resolve — better to fail than to publish as something else.
   - `repoMetadataOf` derives the per-package metadata from the **root manifest's** `repository`
     (the single source of truth; `git remote` is aliased here) and refuses to run without one —
     staged manifests must not ship bare (verified non-vacuous: stripping the root `repository`
     fails `release.ts stage`).
2. **`@onememory-ai/*` and `onememory` can publish from CI with no token**
   (`.github/workflows/release.yml`, manual dispatch only): test → build → stage → pack → packed
   smoke → publish, authenticating by OIDC (`id-token: write`, npm ≥ 11.5.1 via `npm@11` on
   Node 24 — the runner's Node 22 ships npm 10, too old for the exchange).

The first release stays human-driven (ADR-0014): `bun run scripts/release.ts publish --yes` in an
interactive terminal, complete npm's browser challenge once, resume with `--from` on any failure.
After it lands, a trusted publisher is configured per package on npmjs.com (`vramasamye` /
`tinymem` / `release.yml`, "Allow npm publish" ticked) and validated within the 2-day expiry by
one CI publish.

## Validation

- `scripts/lib/publish.test.ts`: 22 pass / 0 fail (7 new metadata tests, red-first).
- `release.ts stage`: guard verified non-vacuous (root `repository` stripped → staging refuses);
  all 18 staged manifests carry `repository`/`homepage`/`bugs` with their own `directory`
  (verified against `.release/release-plan.json`).
- Typecheck (`tsc -p scripts/tsconfig.json`) clean; full tooling suites green.

## Files changed

- `scripts/lib/publish.ts` (+`RepoMetadata`, `githubRepoOf`, `repoMetadataOf`; staged-manifest
  metadata), `scripts/lib/publish.test.ts` (red-first), `scripts/release.ts` (stage derives
  metadata from the root manifest), root `package.json` (+`repository`),
  `.github/workflows/release.yml` (new), `docs/adr/0014-npm-distribution.md` (amendment),
  `docs/plan/release-process.md` (authentication + metadata runbook), this report.

## Commits

- `5790525` feat(release): carry repository metadata and publish by trusted publishing
