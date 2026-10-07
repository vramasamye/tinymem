# Mission 20: packaging hygiene (test scaffolding out of the tarballs)

Branch: `mission/20-packaging-hygiene` · Base: `857b06d` (main, the M19 merge) · Decision record:
docs/adr/0014-npm-distribution.md (§2, amended) · Found by: the M16 npm dry run.

## Why

The `npm publish --dry-run` of all 18 tarballs printed a file list for the CLI that included
`dist/test-support.d.ts`. Auditing every tarball found four packages shipping test-only
declarations:

- `onememory` → `dist/test-support.d.ts`
- `@onememory-ai/consolidation` → `dist/testing.d.ts`
- `@onememory-ai/retrieval` → `dist/testing.d.ts`
- `@onememory-ai/extraction` → `dist/testing/transcripts.d.ts`

No test **code** shipped (the bundles are built from the public entries, and none of them import
the helpers), so this was type-surface only — but a declaration for a helper no consumer can import
is wrong, and it is the kind of leak that grows.

## Root cause

Two mistakes, both in `tsconfig.build.json`'s `exclude` list:

1. `"src/test-support/**"` is a *directory* glob; the CLI's file is `src/test-support.ts`, which it
   never matched.
2. The declaration pass follows imports from the program's roots. Test helpers that other **test
   files** import (`retrieval/src/test-world.ts` → `./testing`,
   `consolidation/src/skills/fixtures.ts` → `../testing`) are in the program unless the importers
   themselves are excluded — excluding `testing.ts` alone was not enough.

## Fix

- The exclude list now covers the whole scaffolding family: `testing.ts`, `testing/**`,
  `test-support.ts`, `test-support/**`, `test-world.ts`, `fixtures.ts`, plus the existing test and
  scenario patterns.
- `scripts/build.ts` asserts no test artifact reaches `dist/` and fails the build with the offending
  paths. Verified **non-vacuous**: removing one exclude fails the build with
  `packages/retrieval emitted test scaffolding into dist (testing.d.ts, test-world.d.ts)`.
- `scripts/smoke-packed.ts` checks the *installed* packages for the same pattern, so the gate
  covers the artifact a user actually receives (a build-only check could be bypassed by a future
  packaging path).

## Validation

- Build: 18 packages, 24 entries; no test artifact under any `dist/` (`find` verified).
- Tarballs: all 18 inspected with `tar -tzf`; zero test-artifact entries.
- Packed smoke under npm + Node: all checks pass, including the new hygiene check.
- Full repo `bun test`: **2128 pass / 56 skip / 0 fail** (2184 tests). The `packages/extraction`
  "re_embed handler" timeout seen in the M19 full-suite run did not recur and passes standalone in
  ~1.2s — load flake, not a regression.

## Files changed

- 18 × `tsconfig.build.json` (exclude list), `scripts/build.ts` (assertion),
  `scripts/smoke-packed.ts` (hygiene check), `docs/adr/0014-npm-distribution.md` (§2 note), this
  report.

## Commits

- `d8f3cd6` fix(release): keep test scaffolding out of the published tarballs
