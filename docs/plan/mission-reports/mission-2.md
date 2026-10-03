# Mission 2 report — Retrieval engine

**Branch:** `mission/2-retrieval` (worktree `onemem-m2`, base `d26b3e5`)
**Scope delivered:** `@onememory/retrieval` (the core `Searcher` port), read-only storage search
repositories, unit + integration tests, this report.

**Commits**

| Commit | Summary |
|---|---|
| `b61bd7f` | `feat(storage)`: read-only search repositories for retrieval candidate channels |
| `e87669f` | `feat(retrieval)`: hybrid engine (8-stage pipeline, session context, caches) |
| `5a5e2eb` | `fix(retrieval)`: channel correctness bugs found by the test suite |
| `aa82fe8` | `test(retrieval)`: golden fusion, packing property, temporal, dedupe, engine, session-context suites |

---

## 1. What changed

### `packages/storage/src/repositories/search.ts` (new) + one export line in `storage/src/index.ts`

All retrieval SQL lives here (AGENTS.md rule 5), exported as `searchRepo`. Every fetcher takes a
`CandidateFilter` (`statuses`, `window: point | overlap`, optional `projectId`, `types`,
`requiredEntityIds`) as an SQL prefilter. The in-process temporal predicate in retrieval is the
authoritative gate.

- `searchLexical`: Postgres FTS over the stored `search_text` tsvector. Each keyword is wrapped in
  `plainto_tsquery('simple', …)` and the per-term queries are OR-ed, then ranked by `ts_rank`.
- `fetchMemoriesByIds`: filtered readback for vector KNN ids, preserving channel rank order.
- `memoriesForEntities`: entity-bound memories, round-robin across entities with a cap.
- `expandGraphNeighbors`: 1–2 hop BFS over `memory_edges`, with edge validity checked at the
  query instant.
- `latestAcceptedDecisions`, `recentFailures`, `knownFailures`: the typed shortcuts and the
  session-context sections, verified against the decision and failure payload tables.
- `listCurrentMemories`, `listScopeEntities`, `contradictionNeighbors`.

### `packages/retrieval` (new package)

| Module | Stage |
|---|---|
| `understand.ts` | 1. Rules-first query understanding: intent keyword table, keyword extraction, time-scope parsing, entity matching through `entity-index.ts` (alias index with TTL cache) |
| `engine.ts` | 2. Candidate channels: lexical and vector in parallel; graph (entity-bound + 1–2 hop + typed shortcuts) seeded on their heads; working memory for `session_id` |
| `temporal.ts` | 3. Hard temporal/status filter: current / point-in-time (`as_of`) / overlap / full history; disputed rows excluded unless requested, labeled with conflicts when included |
| `dedupe.ts` | 4. Exact `content_hash` collapse, then near-duplicate collapse (cosine ≥ 0.97 inside a (primary entity, type) group) by authority order |
| `fusion.ts` | 5. RRF (k = 60, rank 1 normalized to 1.0) plus additive weighted scoring, `relevance` = score / active weight mass, and an explain decomposition |
| `rerank.ts` | 6. Optional rerank tier: opt-in by config **and** injection, degrades to the fused order with a warning |
| `packing.ts` | 7. Token packer (default 800): summaries by density, then content upgrades, then title-only overflow; `used ≤ budget` is enforced and the packer throws otherwise; never cuts mid-sentence |
| `engine.ts` | 8. Response build (Zod-validated in and out), fire-and-forget `reinforce`, caches (embedding, result, entity) |
| `session-context.ts` | `buildSessionContext`: digest / decisions / failures / procedures / preferences under a 750-token budget, packed line by line with unused share rolling forward |
| `testing.ts` | Test-only subpath `@onememory/retrieval/testing`: `createTestEmbedder` (deterministic keyword-axis embedder, dim 384), `mulberry32` |

Degraded modes are never silent. Each of these produces an explicit `warnings[]` entry and the
search still answers: no embedder, no embedding index, model mismatch, dimension mismatch, vector
or lexical failure, partial graph failure, unresolvable entity filter, rerank requested without a
reranker, digest not built, disputed rows dropped, and budget or overflow drops.

### Bugs found and fixed by the suite (`5a5e2eb`)

- **Lexical recall:** `plainto_tsquery` ANDs every word, so natural-language queries matched
  almost nothing. The channel now ORs one `plainto_tsquery` per extracted keyword.
- **Entity-bound channel:** the filter placeholders started at `$3` while only `$1` was used,
  which raised "could not determine data type of parameter $2". The graph channel had been
  degrading to a warning on every entity query.
- **`listCurrentMemories`:** the `types` filter was never applied.
- **Zero-norm query vectors:** pgvector's cosine distance against a zero vector is NaN, and NaN
  compares greater than every number in Postgres, so `minCosine` admitted every row. The engine
  now skips the KNN call for zero-norm query embeddings.
- **Rerank order lost:** the packer re-sorted by fused score. It now treats input order as the
  ranking and uses score only for density.
- **Dedupe merge:** the survivor dropped the other copy's channels when the newer copy won.
- **Open-ended historical windows:** edge validity is now evaluated at `now`, not at `from`.

---

## 2. Tests

- `packages/retrieval`: **76 pass / 0 fail** across 7 files (5,183 expect calls, 1 explain
  snapshot), running against real embedded PGlite. Coverage includes:
  - golden RRF and weight math, hand-computed with the default weights
  - a seeded packing property test (200 random fixtures × budgets) checking `used ≤ budget`, no
    mid-sentence cuts, and exact accounting
  - the temporal gate, including the Node 20 → 22 supersession guarantee
  - dedupe authority order
  - every degraded mode
  - the rerank tier
  - caches and invalidation
  - working memory TTL
  - disputed labeling
  - session context
  - schema validity of responses, plus an assertion that a healthy search returns zero warnings
- `bunx tsc --noEmit`: clean in `packages/retrieval` and `packages/storage`.
- **Repository root `bun test`: 161 pass / 14 skip / 2 fail** (177 tests, 16 files). The 14
  skips are the env-gated Postgres-server leg.

**The 2 failures predate this mission and are not caused by M2.** They are:
- `GATE-1 … FOR UPDATE SKIP LOCKED claim semantics`
- `storage integration (embedded) … jobs: singleton enqueue, claim/lease, …`

Both claim jobs at a hardcoded instant, `'2026-10-03T12:00:00.000Z'`
(`storage/src/integration/gate1.test.ts:188`, `scenarios.ts` jobs scenario), while `enqueue`
stamps `run_at` with the real clock (`repositories/jobs.ts:53`). Since the wall clock passed
2026-10-03 12:00 UTC, `run_at > claim time` and nothing is claimed. The same 2 tests fail on the
untouched base commit `d26b3e5`; this was verified in a temporary detached worktree. Both files
are M1-owned storage files, outside this mission's allowed edits, so they were not changed.

Separately, embedded storage integration runs showed an intermittent PGlite stall (one test
hanging for 60–260 s, a different test each time, including the first migrations test). It did
not reproduce in the final run, and it appeared while other mission worktrees were running PGlite
concurrently.

---

## 3. Deviations from `docs/architecture/retrieval.md` (with reasons)

1. **Half-lives the document leaves unspecified** were picked as defaults: semantic 400 d,
   procedural 180 d, preference 400 d, working 7 d. The document's episodic 30 d / decision 400 d
   / failure 180 d are kept. All are overridable through `config.halfLifeDays`.
2. **Type-affinity matrix values:** the document gives a range ("0.01–0.15, intent×type"). The
   full matrix in `DEFAULT_TYPE_AFFINITY` is this mission's choice; the cell value is the weight.
   The normalization mass includes the intent's maximum affinity, so `relevance ≤ 1`.
3. **Additive `project_digest` response field** for `context` intent. The wire schema is a loose
   object and boundaries must tolerate unknown fields (§8). It warns when the digest is not
   built.
4. **Failure shortcut ranks by recurrence** (`occurrence_count`, recency), not by
   error-signature similarity. Signature matching needs M3/M7 normalization.
5. **Working memory provenance** is reported as `source_kind: 'working'`.
6. **Near-duplicate grouping** uses the *primary* (first-bound) entity only, not every entity
   pair.
7. **Lexical query semantics:** per-keyword OR, not a single `plainto_tsquery` over the raw query
   (the sample in `database-schema.md` §FTS). AND semantics made recall unusable; `ts_rank` still
   ranks multi-term matches higher.
8. **Request `project_id` is a scoring factor, not a hard filter.** Same project = 1.0,
   cross-project = 0.7, user-global = 0.4. This lets cross-project knowledge surface at a
   discount, as the scoring section describes.
9. **Package dependency:** retrieval depends on `@onememory/storage` (for `searchRepo` and the
   `Database` type) in addition to core. The dependency diagram shows retrieval → core only, but
   rule 5 (no SQL outside storage) forces the edge. Coordinator: please reflect this in
   `docs/architecture/`.
10. `SEARCH_MEMORY_SELECT` in `search.ts` duplicates the column list of the module-private
    `MEMORY_SELECT` in `memories.ts`, because missions may not edit existing storage files. Keep
    the two in sync, or export one from `memories.ts` in a coordinator change.

---

## 4. Follow-ups

- **Coordinator / M1 owner:** fix the stale jobs fixtures. Pass `run_at` explicitly or derive
  the claim instant from `Date.now()` in `gate1.test.ts` and the `scenarios.ts` jobs scenario.
  Until then the root `bun test` is red on every branch.
- **Storage:** `EmbeddingIndex.search` should reject or short-circuit zero-norm queries itself,
  because NaN passes `minCosine` (`vectors/embedding-index.ts`). Retrieval guards against this
  today.
- **Write-path cache invalidation:** the result cache has a 60 s TTL and an explicit
  `invalidateCache(projectId?)`. M3/M13 write paths should call it, or a store-level change hook
  should be added.
- LLM-assisted query understanding behind the model router (rules-first stays the offline
  default).
- A real reranker implementation for the `Reranker` port (opt-in tier).
- Retrieval benchmarks (tokens per answer, recall@k on judged queries; GATE for M9/M10).
- Error-signature similarity for the failure shortcut, once M3/M7 normalize signatures.

---

## 5. API surface for M13 (CLI/API) and M5 (MCP)

```ts
import { createRetrievalEngine, buildSessionContext, mergeConfig, DEFAULT_RETRIEVAL_CONFIG }
  from '@onememory/retrieval';
import type { RetrievalEngine, RetrievalConfig, RetrievalConfigInput, SessionContext }
  from '@onememory/retrieval';

// Construction — OnememoryStorage ({ store, client, vectors }) satisfies RetrievalStorage.
function createRetrievalEngine(
  storage: { readonly store: Store; readonly client: Database; readonly vectors?: EmbeddingIndex },
  options?: {
    embedder?: Embedder;            // absent → lexical + graph only (warned)
    reranker?: Reranker;            // used only when config.rerank.enabled
    config?: RetrievalConfigInput;  // per-key partial overrides of DEFAULT_RETRIEVAL_CONFIG
    now?: () => Date;               // injectable clock
  },
): RetrievalEngine;

interface RetrievalEngine {
  // core Searcher port — memory_search (MCP) / `onemem search` + POST /search (M13)
  search(request: MemorySearchRequest): Promise<MemorySearchResponse>; // Zod-validated both ways; rejects invalid input
  readonly config: RetrievalConfig;
  invalidateCache(projectId?: string): void;  // call after writes
  invalidateEntityIndex(): void;              // call after entity create/merge
  cacheStats(): { embeddings: number; results: number; entityScopes: number };
}

// memory_project_context (MCP) / `onemem context` (M13)
function buildSessionContext(
  deps: { store: Store; client: Database },   // OnememoryStorage satisfies this
  projectId: string,
  options?: { budget?: number /* default 750 */; now?: () => Date },
): Promise<SessionContext>;

interface SessionContext {
  project_id: string;
  budget: number;
  used: number;                 // always ≤ budget
  text: string;                 // ready-to-inject block; sections joined by a blank line
  sections: Array<{ kind: 'digest' | 'decisions' | 'failures' | 'procedures' | 'preferences';
                    tokens: number; text: string }>;
  warnings: string[];
}

function mergeConfig(partial?: RetrievalConfigInput): RetrievalConfig;
const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig;
```

`MemorySearchRequest` / `MemorySearchResponse` are core's wire schemas
(`@onememory/core`, event-memory-schemas.md §6). Request fields: `query`, `project_id?`,
`session_id?`, `types?`, `entities?`, `as_of?`, `temporal_mode?`, `include?`, `max_tokens?`
(default 800), `max_memories?` (default 10), `explain?` (default false; when false `explain` is
`[]`). Response: `query_understanding`, `memories[]` (`id`, `type`, `title?`, `summary`,
`content?`, `relevance`, `explain[]`, `temporal`, `provenance`, `conflicts?`),
`tokens { budget, used, packing }`, `warnings[]`, plus `project_digest?` for `context` intent.

**`RetrievalConfig` keys** (all overridable through `RetrievalConfigInput`):

| Key | Contents |
|---|---|
| `weights` | `w_sem` .20, `w_lex` .16, `w_graph` .08, `w_imp` .12, `w_conf` .08, `w_rec` .10, `w_acc` .05, `w_proj` .10, `w_ent` .10 |
| `rrf` | `k` 60 |
| `halfLifeDays` | per memory type (see deviation 1) |
| `typeAffinity` | intent × type matrix |
| `lexical` | `limit` 50 |
| `vector` | `limit` 50, `minCosine` .05 |
| `graph` | `perEntityLimit` 30, `entityCap` 60, `hops` 2, `expansionCap` 40, `seedTopK` 5, `decay` .8, `shortcutDecisions` 10, `shortcutFailures` 10 |
| `packing` | `defaultMaxTokens` 800, `overflowLimit` 10 |
| `rerank` | `enabled` false, `limit` 50 |
| `nearDuplicate` | `cosineThreshold` .97 |
| `summaryMaxChars` | 160 |
| `sessionContext` | `budget` 750; shares 200 / 250 / 150 / 100 / 50; item counts |
| `caches` | TTLs and maximum entries for the embedding, result, and entity caches |

The pure stage functions (`understandQuery`, `resolveTemporalPolicy`, `passesTemporalFilter`,
`dedupeCandidates`, `scoreCandidates`, `applyRerank`, `packResults`, token helpers) are also
exported for SDK composition and tests. Test doubles come from `@onememory/retrieval/testing`.
