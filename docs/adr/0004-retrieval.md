# ADR-0004: Hybrid token-budgeted retrieval with RRF fusion and explainability

Status: Accepted · Date: 2026-10-03

## Context

Spec §11: never rely solely on embeddings; §12: return 5 memories and 800 tokens, not 50 and
20,000; §33: expose why a memory was retrieved. Raw vector similarity must never be the final
ranking.

## Decision

The pipeline in `docs/architecture/retrieval.md`:

1. **Three parallel candidate channels**: lexical (Postgres FTS `ts_rank`), vector (pgvector KNN),
   graph (entity bindings + 1–2 hop expansion + typed shortcuts). Every channel optional at
   runtime — degradation is reported, never silent.
2. **Hard temporal/status filters before scoring** — current-validity questions can never surface
   superseded memories; `as_of` flips to point-in-time semantics.
3. **RRF fusion (k=60)** so no channel's raw score dominates, then **additive weighted scoring**
   over: RRF, importance, confidence, recency (per-type half-life), access frequency, project
   match, entity overlap, type affinity (intent×type matrix). Weights are config; the nonzero
   contributions ARE the `explain` output. Per-type routing shortcuts follow MIRIX's Active
   Retrieval (top-k per layer, typed injection).
4. **Reranking is an opt-in quality tier** (local cross-encoder or hosted), never default —
   dependency research: cross-encoder CPU cost is unproven on target hardware; cohort (Zep) marks
   it the most expensive reranker.
5. **Token budget packing (the anti-dump step)**: knapsack by score density — summaries first,
   content upgrades if budget allows, titles-only overflow line for progressive drill-down
   (`memory_get`/`memory_related`). `used ≤ budget` is a property-tested invariant.
6. **Session context injection** is a compact digest (default 750 tokens) — project digest +
   top decisions + known failures + relevant procedures — never the database (spec §22).

## Options considered

- Pure vector search with a similarity threshold (rejected: violates §11 and temporal correctness).
- LLM query rewriting on the hot path by default (rejected: violates local-first + latency; kept as
  optional enhancement with cached embeddings).
- Client-side fusion exposure (rejected: every agent would reimplement ranking; the engine owns it).

## Consequences

- Benchmarks (M11) gate: retrieval precision/recall, token efficiency, pollution, temporal
  accuracy, contradiction accuracy (spec §25).
- `explain` comes from the scoring decomposition — no extra model call, deterministic.
- Per-type half-lives and weights need tuning data — shipped as config with benchmarked defaults.

## References

`docs/research/memory-systems-landscape.md` adopt-items 4–5, 13; `docs/architecture/retrieval.md`
(normative); `docs/research/dependency-verification.md` §11 (reranker verdict).

## Amendment (2026-10-07): scope admission is hard, and it is a union (M17)

Scope was previously a *soft* signal only: `w_proj` ranked same-project above cross-project, while
candidate generation applied no project predicate at all. Another project's rows could therefore
enter the candidate set and be ranked into an answer (the explain decomposition pinned it as the
factor `cross-project memory`). Normative from `mission/17-scope-identity`:

- A **project-scoped** request (`project_id` present) admits exactly two row sets: that project's
  own rows, plus the calling user's user-level rows (`project_id IS NULL AND user_id = caller`).
  No other project's row enters any channel. Implemented as `CandidateFilter.projectOrUser`
  (`packages/storage/src/repositories/search.ts`, mutually exclusive with `projectId`, failing
  closed on both) and selected by the engine when a user resolver is injected
  (`RetrievalEngineOptions.resolveUserId`).
- Without a resolvable caller, a project-scoped request is **hard project scope**: the union's
  second arm is simply absent. Cross-project leakage is closed either way.
- `w_proj` remains a ranker **within** the admitted set (0.7 still occurs for unscoped requests):
  §5's scoring table is unchanged, only the admission rule around it is new.
- Unscoped requests (no `project_id` — reachable only when no project is registered) keep
  any-project semantics as the wire contract documents.

