# Mission 24 — the CLI is `@onememory-ai/cli`

**Branch:** `mission/24-cli-scoped-name` · **Decision:** ADR-0014 amendment (2026-10-08, "the CLI
is `@onememory-ai/cli`")

## Why

The first human-driven release (ADR-0014, 2026-10-08 authentication amendment) published all 17
scoped packages at `0.1.0`, then the registry refused the CLI:

```
403 Forbidden - PUT https://registry.npmjs.org/onememory - Package name too similar to existing
package one-memory
```

npm's similar-name check applies to unscoped names only. Moving the CLI into the scope we own
removes the last name the registry can refuse.

The same release surfaced a tooling defect, fixed just before this mission (`d572e6d`):
`release.ts` ran npm through Bun's `$`, which pipes stdio. npm 11 only runs its browser 2FA flow
when stdin and stdout are a TTY (`lib/utils/auth.js`), so it failed fast with `EOTP` and a
redacted URL even in the user's own terminal. npm is now spawned with inherited stdio.

## What changed

- `apps/cli/package.json`: name `@onememory-ai/cli` (bin `onemem` unchanged); `bun.lock` synced.
- `scripts/lib/scope.test.ts` (red first, 4 failing): every publishable package must be under
  `@onememory-ai`; the smoke must drive `npx @onememory-ai/cli`; `README.md` and `AGENTS.md` must
  advertise `npx @onememory-ai/cli init` and never the refused command.
- `scripts/smoke-packed.ts`: installed-CLI path and the npx install path use the scoped name.
- `scripts/lib/publish.test.ts`: the real-workspace order assertion names the scoped CLI.
- Docs: `README.md`, `AGENTS.md`, `docs/plan/release-process.md` (scope, TTY note, daemon command
  `bunx --bun -p @onememory-ai/cli onemem serve`), `docs/architecture/repository-structure.md`,
  ADR-0014 amendment. Earlier mission reports keep `npx onememory init` as the historical record.

The MCP server name `onememory` (ADR-0010) is a protocol identity, not a package name, and is
unchanged.

## Verification

- `bun test scripts`: 42 pass / 0 fail. `apps/cli`: 88 pass / 0 fail; `tsc --noEmit` clean.
- build → stage → pack: 18 tarballs, every planned name under `@onememory-ai`.
- Packed smoke (npm + Node only): all checks passed, including `npx @onememory-ai/cli init` and
  `doctor`.
- `release.ts publish --dry-run --only @onememory-ai/cli`: clean.

## Remaining

The user publishes the one missing package:
`bun run scripts/release.ts publish --yes --only @onememory-ai/cli`. The 17 live packages are
unaffected by this rename; the CLI depends on them at `^0.1.0`.
