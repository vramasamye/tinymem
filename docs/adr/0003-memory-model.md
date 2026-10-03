# ADR-0003: Typed memory model, bi-temporal validity, mandatory provenance

Status: Accepted · Date: 2026-10-03

## Context

"Memory is not a vector database" (spec §2). The model must answer current vs. historical questions
correctly (§8), resolve contradictions without deleting history (§9), never create unattributed
durable memories (§32), and keep working memory separate (§23).

## Decision

1. **Seven content types** (`episodic`, `semantic`, `procedural`, `decision`, `failure`,
   `preference`, `working`) + **three structural layers** (project = scope, entity = registry +
   bindings, source = provenance). A memory has exactly one content type; scope/bindings/provenance
   are orthogonal. Full mapping: `memory-model.md` §2. (MIRIX's published six-component taxonomy
   validates per-type schemas; we extend it with decision/failure/procedural payload tables.)
2. **Bi-temporal model on every memory** (from Zep/Graphiti): fact time (`valid_from`/`valid_until`,
   `observed_at`) vs. system time (`created_at`/`updated_at`); `superseded_by` chains preserve
   history. Contradictions **invalidate, never delete** (Zep §2.2.3; Mem0ᵍ edge invalidation).
3. **Status model**: `active` / `stale` / `superseded` / `disputed` / `archived` with audited
   transitions; decay archives, nothing important is silently deleted; `forget` is a tombstone
   transition, `--purge` the only hard delete (both audited).
4. **Provenance invariant**: no `source_id` + evidence spans → not durable (drops to working memory).
5. **Write pipeline off the hot path** (Mem0's own 2026 production lesson + Letta sleep-time):
   ingest is synchronous and cheap; extract/dedupe/resolve/score/store run as async jobs; the
   agent's tool calls never block on an LLM. Contradiction resolution is deferred to the
   consolidation stage unless it is an explicit user statement.
6. **Working memory is a separate table** with session TTL and a promotion filter at session end.
7. **Semantic memories are never created from single observations** — consolidation or explicit
   user statement only (spec §3 "derived, not blindly created", made an invariant).

## Consequences

- Point-in-time queries are index-backed (`valid_from`/`valid_until` partial indexes).
- One dedupe key: `(scope, type, content_hash)` unique index — re-ingesting the same statement
  never duplicates.
- The pipeline's no-LLM heuristic path must satisfy the same invariants (provenance especially).
- UI/benchmarks can trace every memory to evidence (provenance drill-down).

## Deviations from the originating spec (documented in memory-model.md §11)

`relevance` is per-query computed (not stored); `embedding`/`relationships` live in companion
structures; entity/project/source are layers, not type values.

## References

`docs/research/memory-systems-landscape.md` adopt-items 1–3, 6–7; avoid-items 3, 5;
`docs/architecture/memory-model.md` (normative); `docs/architecture/database-schema.md`;
Zep paper https://arxiv.org/abs/2501.13956 ; Mem0 paper https://arxiv.org/abs/2504.19413 ;
MIRIX paper https://arxiv.org/abs/2507.07957 .
