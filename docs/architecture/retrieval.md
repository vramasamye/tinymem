# Retrieval architecture

Status: draft for architecture review · Feeds ADR-0004 (retrieval) · Implements spec §11, §12, §22, §33

Design goal, in one line: **return 5 highly relevant memories and 800 tokens, not 50 memories and
20,000 tokens.** Retrieval optimizes for information density. Raw vector similarity is never the
final ranking (spec §11). Every stage has a no-LLM and no-embedding fallback — retrieval works
fully offline, degraded, never fake.

---

## 1. Pipeline

```text
Query
  ↓ 1. Query understanding          (rules first; cheap LLM optional)
  ↓ 2. Candidate generation         (3 channels in parallel)
  │     ├─ lexical: Postgres FTS (tsquery BM25-style ranking)
  │     ├─ vector: KNN over memory_vectors (pgvector cosine)
  │     └─ graph: entity registry match → entity-bound memories → 1–2 hop edge expansion
  ↓ 3. Temporal & status filtering  (HARD filters — before any scoring)
  ↓ 4. Dedupe within results
  ↓ 5. Fusion (RRF) + weighted scoring
  ↓ 6. Rerank (optional tier: local cross-encoder / hosted reranker)
  ↓ 7. Token budget packing (knapsack, summaries first)
  ↓ 8. Explain assembly
Final memories
```

### Stage 1 — Query understanding

Rules-first (zero cost, always on), LLM-enhanced when a model is configured:

| Step | Rule-based (baseline) | LLM-enhanced (optional) |
|---|---|---|
| Intent | keyword table: "how do we deploy" → `how_to`; "why did we choose" → `decision`; "error/failed/OOM" → `failure`; "last year / before" → `history` | full intent enum incl. mixed intents |
| Entities | match against `entities` (exact + alias + fuzzy via normalized_name) | + entity extraction from free text |
| Time scope | regex: "last year" → range; "in 2025" → point; "now/current" → current | idiomatic ranges |
| Keywords | tokenize, stopword strip, `simple` stemming | concept expansion (Postgres ≈ "the database") |

Output: the `query_understanding` block of the response schema (event-memory-schemas.md §6).

### Stage 2 — Candidate generation

Three independent channels, all time-boxed; each returns (memory_id, channel, raw_rank):

- **Lexical**: `search_text @@ query_ts` + `ts_rank`, top 50. Always available (even with no
  embedding model, no LLM).
- **Vector**: embed query once (cache by query hash), KNN top 50. Skipped if no embedding
  provider configured (local default ships one, so this is rare).
- **Graph**: entity IDs from stage 1 → entity-bound memories (top 30 per entity, cap 60) →
  1-hop edge expansion from top lexical/vector seeds (cap 40). Typed shortcuts: intent `decision`
  pulls latest accepted decisions; intent `failure` pulls matching open/solved failures by
  signature similarity; intent `context` pulls the project digest.

### Stage 3 — Temporal & status filtering (hard)

- Default (`temporal_mode: current`): `valid_from ≤ now < valid_until` AND status IN
  (active, stale). Superseded memories are invisible to "current" answers — that is the Node
  20/22 correctness guarantee.
- `as_of` point-in-time: validity window against `as_of`; superseded included.
- Historical intents (`history`) flip to `temporal_mode: historical` automatically.
- `disputed` memories pass the filter but are **labeled** with their conflict (never silently
  picked as truth).
- No stage after this can resurrect a filtered-out memory: temporal correctness outranks score.

### Stage 4 — Result dedupe

Same `content_hash` → collapse; same (entity, type, subject) with ≥0.97 cosine → keep the higher
authority (explicit > decision > semantic > episodic; then confidence, then recency).

### Stage 5 — Fusion + weighted scoring

RRF (k=60) fuses channels into one ranking so no channel's raw score dominates:

```text
rrf(m) = Σ_channels 1 / (k + raw_rank_channel(m))          normalized to 0..1

final(m) = w_sem·rrf_vector + w_lex·rrf_lexical + w_graph·graph_boost(m)
         + w_imp·importance + w_conf·confidence + w_rec·recency(m)
         + w_acc·access(m)    + w_proj·project_match(m)    + w_ent·entity_overlap(m)
         + w_type·type_affinity(intent, type)
```

Default weights (all config-overridable; these ARE the explain decomposition):

| Factor | Weight | Signal |
|---|---|---|
| `w_sem` vector RRF | 0.20 | semantic similarity (as channel rank, not raw cosine) |
| `w_lex` lexical RRF | 0.16 | FTS relevance |
| `w_graph` graph boost | 0.08 | 0 for non-graph candidates, decayed by hops |
| `w_imp` importance | 0.12 | stored |
| `w_conf` confidence | 0.08 | stored |
| `w_rec` recency | 0.10 | exp decay, half-life per type (episodic 30d, decision 400d, failure 180d) |
| `w_acc` access | 0.05 | log(1+access_count), stamped by last_accessed_at |
| `w_proj` project match | 0.10 | 1.0 same project / 0.7 cross-project / 0.4 user-global |
| `w_ent` entity overlap | 0.10 | fraction of query entities bound to the memory |
| `w_type` type affinity | 0.01–0.15 | intent×type matrix (failure intent boosts failure/procedural) |

### Stage 6 — Rerank (optional quality tier)

If a reranker is configured (local cross-encoder via transformers.js, or hosted API in server
mode): rerank top 50 → final order; adds ~50–300ms. If not: RRF + weights is the final order.
Degradation is explicit in the response (`warnings`), never silent.

### Stage 7 — Token budget packing (the anti-dump step)

Budget `max_tokens` (default 800, hard ceiling). Knapsack by **score density** (score/token):

1. Fill with `content_summary` (~30–60 tokens each) in score order.
2. If budget remains, upgrade the top items to full `content`.
3. Overflow items beyond budget → a final "progressive retrieval" line of titles-only
   (`+ N related: title, title, …`) so the agent can drill in via `memory_get` /
   `memory_related` on demand.
4. Never truncate a memory mid-sentence; never exceed budget; duplicates already removed at stage 4.

Response reports `tokens: {budget, used, packing}` so callers (and benchmarks) can audit density.

### Stage 8 — Explainability

Each result carries `explain[]`: the nonzero factor contributions in plain terms
(`+ entity match: PostgreSQL (w=0.10)`, `+ currently valid (temporal filter passed)`). In CLI
(`--explain`) and web UI this is rendered as the spec §33 breakdown. Explain is assembled from
the scoring table, not a separate model call.

## 2. Session context injection (spec §22)

`session.start` or first tool call assembles the **compact context** — NOT the whole database:

| Component | Source | Default budget share |
|---|---|---|
| Project digest | `projects.digest` (consolidation-built rollup: what/stack/conventions) | ~200 tokens |
| Settled decisions | latest N accepted `decision` memories, titles + one-line rationale | ~250 |
| Known failures | open + high-recurrence `failure` memories, problem + solution one-liners | ~150 |
| Relevant procedures | `procedural` memories matching project stack | ~100 |
| Preferences | user preferences for this project/language | ~50 |

Total default budget: 750 tokens, hard-capped, cached per session and updated incrementally on
relevant new memories (not re-run per turn). This is what makes "the agent already knows the
project" true at negligible token cost.

## 3. Hierarchical retrieval (progressive drill-down)

Layer 1: `content_summary` (packed into context) → Layer 2: `memory_get(id)` full content +
provenance → Layer 3: `memory_related(id)` graph neighbors → Layer 4: `source` raw evidence
(excerpt, then stored payload pointer). Agents pay tokens only for the depth they need.

## 4. Degraded modes (explicit, never silent)

| Missing dependency | Behavior | Reported via |
|---|---|---|
| No embedding model | lexical + graph only; vector weight redistributed | `warnings: "vector channel unavailable"` |
| No LLM configured | rule-based query understanding; heuristic extraction only | config + doctor |
| No reranker | RRF + weights final | `warnings` (only when rerank was requested) |
| Embedding index mid-rebuild | pre-rebuild vectors still queried; re_embed is online | system_state |

## 5. Performance & caching

- Embedding cache: query hash → vector (session TTL). Entity lookup: in-memory index per process.
- Result cache: identical (query, scope, temporal_mode) within a session → cached, invalidated by
  writes to the affected project.
- Budget: p50 < 150ms lexical+graph only; p50 < 300ms with vector; rerank adds its cost explicitly.
  These are benchmark targets, enforced by `benchmarks/` regressions, not vibes.

## 6. What is deliberately NOT done

- No raw cosine score exposed as "relevance" — the spec forbids it and it misleads.
- No auto-injecting all project memories at session start — only the compact digest + typed tops.
- No LLM call required anywhere in the hot path (query understanding is rules-first; LLM is a
  quality enhancement).
- No "retrieved = correct": conflicts, staleness, and provenance are surfaced, not hidden.
