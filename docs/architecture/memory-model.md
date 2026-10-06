# Memory model

Status: draft for architecture review · Feeds ADR-0003 (memory model) · Owner: coordinating session

This document defines what a memory *is* in onememory: the layer taxonomy, the canonical record,
the status model, the temporal model, provenance, scoring, and the explicit lifecycle pipeline.
Storage details live in `database-schema.md`; retrieval in `retrieval.md`; wire formats in
`event-memory-schemas.md`.

---

## 1. Principles

1. **Memory is typed, not a blob pile.** Every memory has exactly one content type, a scope, entity
   bindings, and provenance. This is what separates onememory from "chunks with embeddings".
2. **Provenance is mandatory.** Every durable memory answers "where did this come from?" with a
   source and at least one evidence span. Unattributable observations stay in working memory.
3. **Temporal validity is first-class.** Facts have a validity window in the real world. "What Node
   version does this project use?" and "what Node version did we use last year?" must return
   different, correct answers.
4. **Append-mostly.** The system never silently deletes important history. Facts get superseded,
   not overwritten. `forget` is an explicit, audited status transition.
5. **Derived, not blindly created.** Semantic memories come from consolidation of multiple
   observations (or an explicit user statement) — never from a single ingested message.
6. **The model must degrade gracefully.** Every stage has a no-LLM path (heuristics, templates,
   statistics). Local AI improves quality; it is never a correctness prerequisite.

## 2. The ten memory layers

The originating spec lists ten layers. Layers are not the same as a `type` enum: a single memory
("Use PostgreSQL for the main database") is simultaneously a decision, project-scoped,
entity-bound (PostgreSQL, this project), and source-backed. Giving it three "types" would fragment
retrieval. So: seven content types plus three structural layers.

| # | Layer | Implemented as |
|---|-------|----------------|
| 1 | **Episodic** | `memories.type = episodic`. Things that happened, immutable once stored (only status/access fields change). Always carries time + provenance. |
| 2 | **Semantic** | `memories.type = semantic`. Derived stable facts. **Only created by consolidation** (cluster of episodes) or an explicit user statement (`onemem remember`). Never from a single observed message. |
| 3 | **Procedural** | `memories.type = procedural`. How-to knowledge: deploys, tests, migrations, recurring fixes. Auto-promoted to a **skill** when verified and repeated (see §9). |
| 4 | **Decision** | `memories.type = decision` + `decisions` payload table (title, decision, alternatives, optional rationale, participants, status: proposed/accepted/superseded/rejected). Evidence is the owning memory's provenance, echoed on read; it is not a `decisions` column. Prevents agents from re-litigating settled architecture. |
| 5 | **Failure** | `memories.type = failure` + `failures` payload table (problem, context, root cause, solution, verification, signature hash, occurrence count). Payload rows are written atomically with the memory and hydrated on memory reads. Highly retrievable on similar errors. |
| 6 | **Preference** | `memories.type = preference`. User/project preferences. Promotion from candidate to durable requires confidence ≥ threshold (configurable; default 0.7) or explicit user statement. |
| 7 | **Working** | Separate `working_memory` table (spec §23): session-scoped current task, hypotheses, files, errors, temporary decisions, open questions. TTL-swept at session end; most of it expires. Promotions re-enter the pipeline as durable candidates. Wire representation still carries type `working`. |
| 8 | **Project** | **Scope, not a type.** `project_id` on every memory, plus a project record with a rollup digest (summary, stack, conventions) rebuilt by consolidation. |
| 9 | **Entity** | **Registry + bindings, not a type.** `entities` table (canonical name, aliases, type) + `memory_entities` bindings. Entity-centric facts keep their natural content type. |
| 10 | **Source** | **Structural layer.** `sources` table + evidence spans + provenance fields on every memory. |

## 3. The canonical memory record

| Field | Type | Req | Semantics |
|---|---|---|---|
| `id` | uuidv7 | ✓ | Stable ID, time-ordered. |
| `type` | enum: `episodic` `semantic` `procedural` `decision` `failure` `preference` `working` | ✓ | The one content type. |
| `subtype` | text | | Free-form refinement, e.g. `failure.oom`, `preference.language`, `procedural.deploy`. |
| `title` | text ≤ 80 chars | ✓ for decision/failure, else optional | Short label for lists and compression. |
| `content` | text | ✓ | Canonical, self-contained statement. Must be interpretable without the conversation it came from. |
| `content_summary` | text ≤ 160 chars | | Compressed form used for context packing. Generated at store time by cheap model or truncation rules. |
| `content_hash` | sha256 hex | ✓ | Hash of normalized content (lowercased, whitespace-collapsed). Exact-dedupe key. |
| `status` | enum: `active` `stale` `superseded` `disputed` `archived` | ✓ | Lifecycle state; see §4. |
| `importance` | real 0–1 | ✓ | Estimated future value. Set at extraction; user can boost. |
| `confidence` | real 0–1 | ✓ | Source authority × corroboration × verification. |
| `access_count` | int ≥ 0 | ✓ (default 0) | Retrieval reinforcement. |
| `last_accessed_at` | timestamptz | | Reinforcement recency. |
| `observed_at` | timestamptz | ✓ | When the fact became true / was observed in the world. |
| `valid_from` | timestamptz | ✓ (defaults to `observed_at`) | Start of real-world validity window. |
| `valid_until` | timestamptz | nullable | End of validity. NULL = currently valid. |
| `created_at` / `updated_at` | timestamptz | ✓ | System timestamps (bi-temporal: distinct from fact validity). |
| `superseded_by` | uuid | nullable | ID of the memory that replaced this one. |
| `project_id` | uuid | nullable | Project scope. NULL = cross-project (user-level). |
| `user_id` | uuid | nullable | User scope (preferences, personal facts). |
| `agent_id` | text | nullable | Which agent/runtime authored it. |
| `source_id` | uuid | ✓ for durable | FK to `sources`. |
| `evidence` | jsonb array | ✓ for durable | Evidence spans (§6). |
| `extraction` | jsonb | ✓ | Provenance of extraction: method, model, prompt hash, adapter. |
| `tags` | text[] | | Lightweight labels (beyond entity bindings). |
| `token_estimate` | int | ✓ | Cached token count of summary/content. |
| `embedding` | — | — | **Not a column.** Stored in a companion vector structure (pgvector column in server mode / vector table in embedded mode). Documented deviation, §11. |
| `relationships` | — | — | **Not a column.** Stored in `edges` (memory graph). Deviation, §11. |

## 4. Status model

```text
                       ┌──────────── superseded_by link ───────────┐
                       ▼                                           │
  active ──(new fact wins)────────────▶ superseded                  │
     │  ▲                                                             │
     │  └─(re-verified)─ stale ◀──(code drift / TTL)──┐               │
     │                     │                          │               │
     ├─(contradiction,     └──▶ archived ◀──(age × access ×            │
     │   no authority           ▲           importance below threshold, │
     │   winner)                │           or manual)── from any state│
     ▼                         │
  disputed ──(authority resolved / user ruling)──▶ active or superseded
```

| Status | Meaning | In default retrieval? |
|---|---|---|
| `active` | Currently valid. | Yes |
| `stale` | Its evidence changed (code drift) or long unverified. | Only with `include_stale` or historical queries |
| `superseded` | Replaced by a newer fact. Point-in-time queries still see it. | No (historical queries only) |
| `disputed` | Contradiction unresolved (confidence tie). | Yes, with an explicit conflict marker |
| `archived` | Decay threshold reached or manually archived. | No (explicit query only) |

Rules:
- **Never delete**: decay archives. Hard delete exists only as explicit `onemem forget --purge`
  and always writes an audit row.
- Any transition is one-directional except `stale→active` (re-verified) and `archived→active`
  (manual restore) and `disputed→*` (resolution). All transitions are audited (`memory_events`).
- `superseded_by` chains preserve history: Node 20 → Node 22 → Node 24 queryable at any point in time.

## 5. Temporal model (bi-temporal)

Two independent time axes, on every memory:

1. **Fact time** (`valid_from` / `valid_until` / `observed_at`): when the statement was true in the
   world. Set by extraction or supersession (closing a predecessor's `valid_until`).
2. **System time** (`created_at` / `updated_at`): when onememory wrote it.

Query modes derived from these:

| Query | Filter |
|---|---|
| Current ("what does this project use?") | `valid_from ≤ now < valid_until` (NULL open) AND status IN (active, stale) |
| Point-in-time ("what did we use in 2025?") | `valid_from ≤ t < valid_until`, includes superseded, excludes `disputed` |
| Range ("full history of X") | Follow `superseded_by` chain + temporal filter |

Supersession procedure (the Node 20 → Node 22 example from the spec):
1. New memory "Node 22" passes dedupe; contradiction detection finds "Node 20" (same project, same
   entity/subject, incompatible values, temporal overlap).
2. Authority comparison (§9): newer + higher confidence + explicit-decision source wins.
3. Winner stored as `active`. Loser: `status = superseded`, `valid_until = winner.observed_at`,
   `superseded_by = winner.id`. **Both retained.**

## 6. Provenance

```text
source (where)        ──▶ evidence spans (what exactly) ──▶ memory
conversation/session/…     message #183, commit sha, lines 4-9
```

- `sources`: `{id, kind: conversation|document|git|terminal|file|web|api|explicit, uri, title,
  content_hash, metadata, created_at}` — the durable anchor. Retained even if the raw event
  payload is compacted.
- `evidence` spans: `{source_id, kind: message|range|commit|line, locator, excerpt ≤ 200 chars}`.
- `extraction`: `{method: heuristic|llm, model, prompt_version, adapter, session_id}`.
- Store-stage invariant: **no source + evidence → not durable.** The candidate drops to working
  memory with `unattributed` flag instead.
- Verification adds `verified_at` + verifying evidence (e.g., a successful test run).

## 7. Scoring, reinforcement, decay

Stored, static: `importance`, `confidence`. Computed at query time (cheap, no storage):

```text
prominence = importance^0.5 × confidence
             × recency(age, half-life configured per type; episodic decays faster than decision)
             × (1 + log(1 + access_count))
```

- **Reinforcement**: every retrieval hit increments `access_count`, stamps `last_accessed_at`;
  explicit signals (memory cited in an agent's answer, user confirms a skill worked) weight more
  than passive hits.
- **Decay job** (scheduled, idempotent): compute prominence for active memories; below configured
  threshold → `archived`. Factors: age, rare access, low importance, project inactive. Decisions and
  verified procedures are decay-resistant (importance floor).
- **Staleness triggers** (not age-based): linked code fingerprint changed (§ code memory), source
  document changed, or `unverified_for` TTL exceeded → `stale`, queued for re-validation.

## 8. Lifecycle pipeline

The spec's 14 stages, as explicit contracts. Stages 1–2 are the only synchronous hot path;
everything else is asynchronous, retryable, and observable. **No single LLM call is load-bearing
for correctness**: extraction may be LLM or heuristic; every async stage has a fallback.

| # | Stage | Input → Output | Mode | Failure policy |
|---|---|---|---|---|
| 1 | OBSERVE | runtime events → validated `OnememoryEvent` envelope | sync (adapter) | invalid envelope → rejected to dead-letter with reason |
| 2 | INGEST | events → deduped by `content_hash`, redacted, stored in `events` raw log | sync, transactional | never blocks the agent; spill to local queue on DB down |
| 3 | NORMALIZE | raw events → clean text/structured forms (terminal output parsing, diff parsing, PDF/HTML→text) | async job | normalize failure marks event `needs_review`, never drops it |
| 4 | EXTRACT | normalized batch → candidate memories (structured JSON, `event-memory-schemas.md`) | async job | LLM failure → heuristic extractor; both fail → event kept, extraction retried |
| 5 | CLASSIFY | candidates → typed candidates (7 types + subtype) | async (part of extract job) | unknown → defaults to `episodic` with lower confidence |
| 6 | DEDUPLICATE | candidates vs existing: exact hash → embedding similarity → entity-aware → contradiction detection → temporal resolution | async, transactional with STORE | similarity service down → exact-hash only, candidate flagged `dedupe_degraded` |
| 7 | ENTITY RESOLUTION | entity mentions → canonical entities (create/merge/alias) | async | ambiguity → create unresolved entity, flag for later merge |
| 8 | SCORE | candidates → importance/confidence finalized | async | — |
| 9 | STORE | transactional write: memory + edges + entity bindings + vector + FTS + provenance + supersession | async, idempotent (dedupe on retry by hash) | partial write → full rollback, retry |
| 10 | RETRIEVE | query → ranked, token-budgeted results with explanations | sync (hot path) | degraded modes: no embeddings → lexical only; no reranker → RRF only |
| 11 | REINFORCE | retrieval/use signals → access_count, last_accessed_at, feedback | sync, fire-and-forget | loss acceptable |
| 12 | CONSOLIDATE | episode clusters → semantic memories; near-dupes → merges; failures → skill candidates; project digests | scheduled batch | LLM unavailable → templated merge only, LLM merge deferred |
| 13 | DECAY / INVALIDATE | prominence + drift signals → status transitions | scheduled batch | idempotent |
| 14 | ARCHIVE | terminal states → cold partition (still queryable) | scheduled batch | idempotent |

Backpressure: one internal `jobs` table (Postgres) drives stages 3–9 and 12–14; the API/CLI never
awaits them. Job scheduling is round-based with per-stage concurrency limits.

As-built (M3): the NORMALIZE output is not persisted in an `events.normalized` column — the
structured batch is carried in the enqueued `extract` job's payload and recomputed at EXTRACT
(`normalizeEvent` is pure, so this is idempotent and auditable). If normalized forms ever need to
be queryable, a later migration adds the column; no query consumer exists today.

## 9. Consolidation & promotion rules

- **Episodic → semantic** (as-built, mission 14): ≥ 3 episodes with embedding similarity ≥ the
  configured threshold (default 0.97, validated floor 0.9), same project, same primary entity, no
  contradictions among them → derive one semantic memory (templated offline merge by default;
  optional LLM merge via the model router). The new memory carries `derived_from` edges to all
  cluster members; cluster members stay (they are the evidence). Near-identical episodes
  corroborate into the semantic memory before the merge pass collapses the duplicates.
- **Contradiction resolution authority order** (as-built, mission 14): (1) explicit user statement
  beats agent inference; (2) explicit decision memory beats observation; (3) newer `observed_at`
  wins within same class; (4) higher confidence wins; (5) a full tie marks both `disputed` with a
  `contradicts` edge (excluded from current answers, retained in history). Resolution is never
  skipped — an older explicit statement beats a newer inference, and equal-time pairs fall to
  confidence. The winner closes the loser through audited supersession: `valid_until` = the
  winner's observation time when inside the loser's window, else the loser's own `valid_from`
  (zero-width — never valid); the chosen rule is recorded on the audit row.
- **Conflict detection tiers** (as-built, cross-phrasing follow-up): the deterministic
  attribute-template heuristic (same scope, same template, differing scalars, overlapping
  validity) is the offline default and needs no model. When the router has a `conflict` route, an
  opt-in LLM tier adjudicates the pairs the heuristic cannot even form a candidate for — two
  statements answering the same question in different words ("PostgreSQL with pgvector" vs
  "MySQL"). Semantic proximity through the vector channel supplies those candidates for the
  durable claim types (decision / semantic / preference); the model adjudicates them. The tier is
  fail-closed: no route, a provider failure, or an invalid verdict clears the pair (never a
  contradiction without evidence) and is recorded in the run warnings; the local-first default
  (no `conflict` route) is byte-identical to the template heuristic. Every resolution record
  carries `tier: 'template' | 'llm'` naming which tier decided it.
- **Pass order and merge semantics** (as-built, mission 14): the pass runs contradiction →
  derivation → merge → decay (arbitration before absorption; the merge pass also refuses
  contradictory clusters as defense in depth). Near-duplicate merge is keeper-gated: only
  channel-certified cosine ≥ threshold to the keeper absorbs (transitive pairs below threshold
  never merge); absorbed rows close into the survivor and the evidence union is recorded on the
  `merged` audit event (the Store port has no evidence-append primitive — backlog follow-up).
- **Decay/archive** (as-built, mission 14): prominence = importance^0.5 × confidence ×
  0.5^(age/half-life) × (1 + log(1 + access count)); decisions and verified procedures carry a
  0.6 floor; below-threshold memories move to `archived` with an audit row — archive, never
  delete.
- **Failure → skill candidate**: same failure signature (problem embedding similarity ≥ threshold)
  solved ≥ 2 times with an equivalent solution AND at least one verification evidence → generate
  `skills/<slug>/SKILL.md` (when to use, prerequisites, procedure, commands, validation, known
  failure modes). Promotion requires verification; `auto_promote_skills = false` by default (writes
  candidate, asks user via `onemem skills review`).
- **Decision capture**: a decision candidate must eventually carry alternatives + rationale to be
  promoted from `proposed`; otherwise it remains an episodic note.

## 10. Working memory

Session-scoped scratchpad, same table (`type = working`), never in default retrieval:

- Kinds: current task, hypothesis, file being edited, current error, temporary decision, open
  question.
- `session_id` bound; `expires_at` = session end + grace period.
- Session-end sweep (as-built, mission 14a): observing a `session.end` in ingest runs an
  idempotent, DB-only lifecycle pass for that session (stored *and* duplicate end events trigger
  it). A working row promotes iff it is unpromoted, carries its own source and at least one
  evidence span, and has `importance ≥ 0.5` (the "explicitly flagged" arm awaits a schema field).
  Promoted rows become durable **episodic** memories through the audited create path with
  verbatim provenance — they are already extraction output, so they do not re-enter at EXTRACT;
  exact-content duplicates link onto the existing durable memory. The rest expires and is purged
  by the TTL sweep, which is global and preserves promoted rows (working memory is the one
  category where deletion is allowed — it was never durable).
- Rationale: matches how agents actually work (hypotheses change mid-task; most scratch context
  has zero future value) and keeps durable memory clean.

## 11. Documented deviations from the originating spec

1. **`relevance` is computed per query, not stored.** It depends on the query; storing it would be
   meaningless. It appears in every search response and its decomposition is exposed (explain).
2. **`embedding` and `relationships` are not columns on the memory record.** Same information,
   normalized: vectors in a companion structure (pgvector / vector table), relationships in `edges`.
3. **Entity / project / source are structural layers, not `type` values.** One memory has one
   content type but can be project-scoped + entity-bound + source-backed simultaneously. Splitting
   them into types would fragment retrieval and dedupe.
4. **Semantic memories are never created from single observations** — consolidation or explicit
   user statement only. (The spec says "derived, not blindly created"; we make it an invariant.)
5. **`forget` defaults to an audited status transition, not deletion** (`superseded` + tombstone
   + audit). `--purge` hard-deletes. Matches "never silently delete important historical
   information" and the supersession model.
6. **Failure/solution pairs reuse `memories` + payload tables** (`decisions`, `failures`) rather
   than separate top-level tables, so all layers share one lifecycle, one search, one graph.
