# Mission 21: release resilience (resumable publish, partial-progress reporting)

Branch: `mission/21-release-resilience` · Base: `9c7beed` (main, the M20 merge) · Decision record:
docs/adr/0014-npm-distribution.md · Found by: the first real publish attempt.

## Why

The first real `publish --yes` failed on package 1 of 18 with `E403` (npm now requires 2FA for
publishing). Two things about that run were worse than the failure itself:

1. **The script stopped without saying what landed.** An npm publish is irreversible, so an
   operator hitting a mid-sequence failure needs an exact account of which packages published —
   `E403` on package 1 was easy to read, but the same failure on package 9 would have left 8
   packages live and no summary.
2. **There was no way to continue.** Re-running published everything again (npm would reject the
   already-published versions), so recovery meant hand-publishing the remainder.

## Scope delivered

- **Partial-progress reporting.** On failure the publish loop names every package that DID publish
  and prints the exact command that resumes after it, or `release: nothing was published`.
- **`--from <name>` / `--only <name>`** — resume at a package (keeping order) or re-run a single
  one. Both are pure functions (`selectPlanned`, `resumeFrom`) with unit tests; an unknown name and
  a contradictory `--from`+`--only` pair are errors, never a silent empty run.
- **`--otp <code>`** pass-through for accounts that publish with a one-time code instead of a
  bypass-2FA token.
- **`scripts/tsconfig.json`** (+ root `@types/bun`) so the release tooling is typechecked like every
  package — it had no tsconfig at all, so the scripts had never been typechecked.

`--yes` remains mandatory for a real publish.

## Validation

- `scripts/lib` suites: 36 pass / 0 fail (5 new selection tests).
- CLI behaviour verified directly: no `--yes` refuses, unknown `--from` errors, `--only` reports
  `nothing was published` when the run fails before the first success.
- Full repo `bun test`: **2133 pass / 56 skip / 0 fail** (2189 tests).

## Files changed

- `scripts/release.ts` (publish loop, flag parsing), `scripts/lib/publish.ts` (+ tests),
  `scripts/tsconfig.json` (new), root `package.json`/`bun.lock` (`@types/bun`), this report.

## Commits

- `5f6c90a` feat(release): make publishing resumable and report partial progress

## Note for the publish

The failure was an authentication requirement, not a packaging defect: npm's "Requiring 2FA for
package publishing" policy now requires either a granular token with **bypass 2FA** enabled or a
per-publish one-time code. Nothing was published by the failed run (verified: `@onememory-ai/core`
and `onememory` both still resolve `404`), so the release is clean to retry.
