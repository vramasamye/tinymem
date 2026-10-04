# Mission 4: fingerprint foundation (first slice)

Branch: `mission/4-codememory` · Base: `1089c70` · ADR: `0008-code-memory-git-fingerprints.md`

## Delivered scope

`packages/codememory` provides schema-validated repository snapshots and change reports:

- argument-safe, read-only system Git inspection;
- separate index (`committed`) and raw-byte worktree fingerprints;
- SHA-1/SHA-256 Git blob hashes and a non-Git SHA-256 fallback;
- NUL-delimited filename parsing, including spaces, tabs, newlines, and Unicode;
- checkpoint-to-HEAD rename evidence, plus conservative exact one-to-one hash matching when
  history is unavailable;
- built-in security exclusions, additive caller globs, generated-directory exclusions, and no
  symlink/submodule following;
- honest `unavailable` entries for conflicts, oversized/unreadable files, with whole-scan failure
  on budgets rather than a truncated "fresh" result;
- pure snapshot comparison independent of Git history or a model provider.

No source contents or remote URLs are returned. Git filters/fsmonitor helpers are not invoked,
and lazy object fetches/remote protocols are disabled.

## Dependency reuse

The system Git choice reuses ADR-0008 and the dependency-verification verdict, rather than
reimplementing Git. The package reuses `@onememory/security` exclusions and Zod. Native Node
subprocess/filesystem/crypto APIs keep the implementation Bun- and Node-compatible. The accepted
primary-source research is in `docs/research/dependency-verification.md` §10 and
`docs/research/llm-wiki-loop.md`; supplementary focused Git-contract research runs separately.

## Validation

- Package unit + real-Git integration suite: 19 pass, 0 fail, 1 Linux-only invalid-filename test
  skipped on macOS (which rejects that fixture filename).
- Package TypeScript strict check: clean.
- Bundled Node smoke: Node 20.19.5 and 26.1.0 pass capture, unchanged comparison, and mutation
  detection. Node 22 was not installed in the environment, so that exact runtime was not tested.
- Full-repository suite: 897 pass, 0 fail, 17 environment/platform-gated skips (914 tests, 69 files).
- Pure exact-rename comparison benchmark (local macOS/Bun run): p50 about 3.8 ms at 1k paths,
  26.8 ms at 10k, and 329.6 ms at 100k. These include boundary validation and are measurements on
  this host, not release latency guarantees. Comparison uses grouped hash indexes, not quadratic
  pairwise matching.

## Explicitly not complete

This is a bounded foundation, not completion of M4 or Phase 2. Persistence, `DriftWatcher`,
audited stale-memory application, rename retargeting of `memory_code_refs`, symbol parsing,
minimal re-index jobs, architecture digests, and M3b decision/failure enrichment remain pending.
No ingestion checkpoint is advanced by this API.

The existing `file_fingerprints` table has one row per repository/path even though ADR-0008 needs
two tiers. The persistence slice must address that with a preserving migration before writing
both tiers. This foundation requires no schema change.
