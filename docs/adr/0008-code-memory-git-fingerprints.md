# ADR-0008: Code memory via git fingerprints — zero-token drift, minimal re-index

Status: Accepted · Date: 2026-10-03

## Context

Spec §13: never re-embed the repository; git fingerprints must make unchanged files cost zero
tokens; drift maps diffs → affected memories → stale → re-index only those. The spec credits
`llm-wiki-loop` as inspiration.

## Decision

Research confirmed llm-wiki-loop (`PALAN-K/llm-wiki-loop`, MIT) is real and analyzed it from
primary sources; we adopt its mechanism, fix its documented failure modes, and add the missing
systemic pieces:

1. **Fingerprint keys** (superset of llm-wiki-loop's `git:<commit>`):
   - `repositories.last_ingested_commit` — the checkpoint (yysun's model): diff
     `last_ingested..HEAD`, process only the changed set, advance the checkpoint only when fully
     processed. Survives its production incident (shallow-clone CI must use `fetch-depth: 0` or
     the content-hash fallback).
   - `file_fingerprints.blob_sha` per path — content-addressed tier that survives shallow clones
     and non-git directories (Bazel/Turbo lesson: store input hashes, not just the commit).
   - Two tiers recorded: `committed` (from the index) and `worktree` (dirty files) — llm-wiki-loop's
     own audit log shows worktree-vs-committed drift is a real trap.
   - `code_symbols.span_hash` — intra-file granularity for symbol-level drift.
2. **Staleness rules** (rename-aware, no TTL — staleness is content-driven, never time-driven):
   `git diff --name-status -M last..HEAD` maps M/D/R/A to `memory_code_refs`; D flags missing-but-
   tracked paths; R resolves successor paths via rename detection (llm-wiki-loop has no rename
   handling; Link's `lnk stale` rule).
3. **Zero-token freshness oracle**: an internal check (surfaced as `onemem check`/doctor) that
   answers "is this knowledge still fresh?" via subprocess git + stored blob SHAs — no LLM, no
   embeddings, no network. This is the `llm-wiki-loop` insight generalized: **drift detection is a
   hash comparison, not a model call.**
4. **Minimal re-index**: only memories whose `memory_code_refs` hit changed paths go `stale`
   (audited) and are queued for re-extraction/re-embedding; everything else is untouched. Symbol
   tables re-extract only changed files (tree-sitter).
5. **Architecture digest** (project layer rollup) rebuilt only when its monitored paths change.

## Consequences

- "Unchanged files cost zero tokens" is a mechanical guarantee, testable in CI (fixture repo →
  touch one file → assert only its memories went stale, zero re-embeds elsewhere).
- System git via argument-safe subprocess (execFile/Bun.spawn, never shell-concatenated) is a
  hard requirement (dependency verdict); isomorphic-git rejected for the indexer.
- Non-git directories degrade to the content-hash tier (slower, still zero-token per unchanged file).

## References

`docs/research/llm-wiki-loop.md` (primary-source analysis incl. their production incidents);
`docs/research/dependency-verification.md` §10 (git tooling verdict), §9 (tree-sitter);
`docs/architecture/database-schema.md` (repositories/file_fingerprints/code_symbols/memory_code_refs);
Letta MemFS (git-backed memory) as convergent validation, https://docs.letta.com/letta-agent/memory .
