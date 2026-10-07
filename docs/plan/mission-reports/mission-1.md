# Mission 1 report — Core storage & schema

**Branch:** `mission/1-core-storage`
**Scope delivered:** (A) `@onememory-ai/core`, (B) `@onememory-ai/storage`, (C) GATE-1 verdict, (D) tests, (E) this report.
**Verdict: GATE-1 PASS.** pglite-pgvector works inside PGlite under Bun; the same repository
code passes the identical integration suite on real Postgres + pgvector.

---

## 1. What changed

66 files, ~10.4k lines. `bun test` from repo root: **87 pass / 0 fail / 14 skip** (skips are the
Postgres-server leg, env-gated). With `ONEMEMORY_PG_URL` set: **99 pass / 0 fail / 0 skip**.

### `packages/core` — schema library, memory model, ports (committed)

- **Model** (`src/model/`): RFC 9562 UUIDv7 generator (12-bit monotonic counter, WebCrypto);
  canonical-JSON + NFC/trim/collapse/lowercase **content hashing** (`memoryContentHash`,
  `eventContentHash`) and scope-coalesced **dedupe key**; **bi-temporal predicates**
  (`isValidAt`, `isCurrentlyValid`); the **status transition machine**
  (`ALLOWED_TRANSITIONS`, `assertTransition`, `actionFor`) that produces audited
  `memory_events` drafts (created/status_changed/restored/archived/…).
- **Schemas** (`src/schema/`): 1:1 Zod mirror of event-memory-schemas.md — envelope + the 15
  payload variants as a discriminated union, unknown-kind → `raw.unknown` (never dropped),
  dead-letter validation results; extraction (EvidenceSpan), memory wire record + typed
  decision/failure/skill payloads; all Store/JobQueue **input** schemas (persistence.ts).
  Field naming is snake_case end-to-end (events ↔ memories ↔ SQL, one convention).
- **Ports** (`src/ports/`): `Store` (lifecycle pipeline stages 2/6/9/10/11), `JobQueue`,
  `Embedder` + `EmbeddingIndex`, `Searcher`, `Extractor`, `Reranker`, `EntityResolver`,
  `DriftWatcher`, `Redactor` — plus the readback record contracts.
- 6 test files, **66 tests** (event validation incl. dead-letter paths, hashing, uuidv7 incl.
  overflow/monotonicity, status machine, temporal predicates, wire records).

### `packages/storage` — schema, drivers, repositories, vectors, jobs (committed)

- **Drizzle schema** (`src/schema/tables.ts`): all 21 tables mirroring database-schema.md,
  STORED generated `tsvector` + GIN, coalesce-unique dedupe index, HNSW vector index, partial
  + expression indexes. drizzle-kit 0.31.11 generated migration **committed**
  (`migrations/0000_naive_colossus.sql`, 67 statements) — one migration set, both profiles.
- **Drivers** (`src/drivers/`): a single `Database` client interface; embedded = PGlite
  0.5.8 + `@electric-sql/pglite-pgvector` 0.0.9 (savepoint-nesting transactions); server =
  node-postgres `pg` (pooled, same SQL); idempotent migration runner (advisory-locked on
  server). `createEmbeddedDb` / `createServerDb` return the same `OnememoryStorage`.
- **Repositories** (`src/repositories/`): typed, handwritten parameterized SQL — memories
  (dedupe probe + 23505 race fallback, audited transitions, one-transaction supersession,
  current/as-of/history queries with a cycle-guarded recursive CTE, reinforce), events
  (content_hash dedupe, redactions passthrough, pending pipeline), projects/sources, entities
  (scope-coalesced lookup, idempotent merge), edges (idempotent on (from,to,relation)),
  working memory (TTL sweep; the one table where deletion is allowed), jobs (singleton
  enqueue, `FOR UPDATE SKIP LOCKED` claim with lease-expiry reclaim, exponential backoff,
  dead-letter). Every repository entry is parsed through core's Zod schemas (`parseInput`).
- **Vectors** (`src/vectors/embedding-index.ts`): `EmbeddingIndex` with **pgvector** KNN
  (`<=>`, HNSW) and the GATE-1 **float8[] fallback** (in-process cosine); `'auto'` backend
  probes the extension at runtime, forced `'pgvector'` fails loudly.
- **Jobs worker** (`src/jobs/worker.ts`): poll loop, claim/execute via a handler registry that
  throws `JobKindNotImplemented` for unregistered kinds (fails the job, never fake success),
  graceful start/stop, `runOnce()` for deterministic tests.
- `store.ts` binds repositories into the core `Store`/`JobQueue` ports — the only glue other
  missions need.

### Commits (this branch)

1. `feat(core): schema library, memory model, and lifecycle ports`
2. `feat(storage): drizzle schema, migrations, drivers, repositories, vectors, jobs worker`
3. `fix(storage): queryAsOf filter placeholders and float8 array literal` *(bugs caught by the new tests)*
4. `feat(core): injectable clock on JobQueue.fail`
5. `test(storage): GATE-1 acceptance suite and both-profile integration scenarios`

---

## 2. GATE-1 verdict (ADR-0002): **PASS**

Formal suite kept in-repo: `packages/storage/src/integration/gate1.test.ts` (not a throwaway
probe). Environment: Bun 1.3.14, PGlite 0.5.8, `@electric-sql/pglite-pgvector` 0.0.9,
drizzle-orm 0.45.3 / drizzle-kit 0.31.11, zod 4.6.5, pg 8.23.1, pgvector 0.3.0.

| # | Capability | Verdict | Evidence |
|---|-------------|---------|----------|
| 1 | `vector` extension loads in WASM Postgres | PASS | `pg_extension` row, `vector` in `pg_type`, `vector_cosine_ops` in `pg_opclass` |
| 2 | `vector(384)` column DDL + INSERT | PASS | created + inserted via the raw client |
| 3 | HNSW index DDL (`USING hnsw … vector_cosine_ops`) | PASS | the committed schema's index DDL applies |
| 4 | cosine KNN `<=>` | PASS | exact 1.0 / 0.0 on orthonormal axes |
| 5 | STORED generated `tsvector` maintained by Postgres | PASS | column non-null after insert |
| 6 | GIN index + `plainto_tsquery` + `ts_rank` | PASS | correct match + ranking |
| 7 | Partial unique index enforcement (`jobs_singleton_idx`) | PASS | dup pending/running rejected (23505); terminal statuses exempt |
| 8 | Expression unique index with `coalesce` (`memories_dedupe_idx`) | PASS | NULL-scope duplicates collide; same statement per scope |
| 9 | `FOR UPDATE SKIP LOCKED` claim + lease-expiry reclaim arm | PASS | the exact claimJobs statement claims, reclaims after 90s |
| 10 | Cell types: timestamptz (Date/string), `text[]`, jsonb | PASS | round-trips + parameterized writes |
| 11 | Migration idempotency (apply twice; 21 tables) | PASS | drizzle journal; second apply is a no-op |
| 12 | Persistence across close/reopen (rows, vectors, FTS) | PASS | reopened data dir serves all three channels |
| 13 | EmbeddingIndex backend selection honest | PASS | auto→pgvector; forced pgvector without extension → loud error; auto without extension → float8 |
| 14 | Same repositories on BOTH profiles | PASS | embedded PGlite 12/12 scenarios; real Postgres 16 + pgvector (throwaway `pgvector/pgvector:pg16` container): **33/33 pass** |

**Conclusion:** keep pgvector as the embedded vector backend (ADR-0002 stays as written); the
float8 fallback remains as a tested insurance seam, not a primary path.

---

## 3. Test output

- Repo-root `bun test` (default, fully offline): **87 pass / 0 fail / 14 skip** — core 66,
  storage GATE-1 9, storage embedded 12; the 14 skips are the `ONEMEMORY_PG_URL`-gated
  Postgres-server leg (by design — `bun test` must stay local-first).
- With `ONEMEMORY_PG_URL=postgres://…` (server leg verified against a throwaway
  `pgvector/pgvector:pg16` container): storage **33 pass / 0 fail**; repo total **99 pass /
  0 fail / 0 skip**.
- `tsc --noEmit` clean in both packages (strict).
- Integration coverage per the task spec: migrations twice; store→get roundtrip; dedupe
  (same-scope reject, cross-scope + NULL-scope rules); the Node 20 → Node 22 supersession
  scenario (loser status/valid_until/superseded_by + audit rows; current → Node 22 only;
  point-in-time before supersession → Node 20; history → both); audited transitions +
  reinforce; events dedupe + redactions passthrough + pending/processed; entity graph with
  idempotent binds/edges and merge; working-memory sweep (expired unpromoted purged, promoted
  preserved); jobs claim/lease/backoff/dead-letter/singleton; worker loop +
  `JobKindNotImplemented`; both embedding backends end-to-end.

---

## 4. Deviations from the normative docs (all deliberate, all verified)

1. **`jobs_singleton_idx` doc DDL is invalid SQL as written.** database-schema.md specifies
   `(kind, payload->>'key')`; Postgres requires parenthesized index expressions. The committed
   schema/migration use `(kind, (payload->>'key'))` — drizzle-kit emits `(payload->>'key')`,
   and GATE-1 proves enforcement. **The doc needs a fix** (see follow-ups).
2. **drizzle-kit emits `DESC NULLS LAST`** where the doc DDL says `DESC`. For the columns
   involved (`observed_at` etc., all NOT NULL), semantics are identical.
3. **Column-level CHECKs became table-level `check()` entries** — drizzle-orm 0.45.3 does not
   support column-level `.check()`. Same names, same predicates, same enforcement (verified
   by migration diff against the doc DDL).
4. **Event payloads carry a `kind` discriminator** (matching the envelope), because a Zod
   discriminated union over 15 variants needs it; `validateOnememoryEvent` injects it into
   doc-shaped payloads. Adapters (M4+) may rely on the injection but SHOULD send it.
5. **`JobQueue.fail` gained an optional `{ now }` injectable clock** (mirrors `claim`) so
   retry/backoff is deterministic through the port. Core-only, additive.
6. **zod is a direct dependency of `@onememory-ai/storage`** (not just core) — repositories
   parse every input through core's schemas at the boundary.
7. **Extension-less embedded boots fail at migration** (loudly): `memory_vectors` uses
   `vector(384)`, so a PGlite build without the vector extension cannot apply the migration
   set. The float8 fallback is fully implemented and tested via forced mode, and `auto`
   selects it when the extension is absent — but on a truly extension-less deployment the
   tables themselves can't be created. A guarded migration is possible later if that scenario
   must be supported (see decisions).

---

## 5. Decisions needed before M2/M3

1. **Doc DDL fix (database-schema.md):** parenthesize `jobs_singleton_idx`'s expression, and
   decide whether to note drizzle's `DESC NULLS LAST`. (Owned by the coordinating session —
   missions don't edit architecture docs.)
2. **Extension-less embedded deployments:** current behavior is a loud migration failure. If
   we must support PGlite-without-pgvector boots, M-something ships a guarded migration
   (DO-block that skips the vector table + a later guarded add). Recommendation: don't —
   `@electric-sql/pglite-pgvector` is a first-class package and GATE-1 passed; document the
   requirement instead.
3. **CI matrix (ADR-0002):** wire `ONEMEMORY_PG_URL` into CI so the server leg runs
   (`bun test` default stays offline/skipped locally). The compose file arrives M13; the
   suite was verified against `pgvector/pgvector:pg16` today, PG17 expected equivalent.
4. **Payload `kind` discriminator:** confirm adapters (M6+) always send it (core injects it
   for doc-shaped payloads, so nothing breaks either way).

## 6. Follow-ups (handed to the coordinating session / later missions)

- database-schema.md jobs_singleton_idx fix (above).
- CI: two legs (`embedded` always; `postgres` with `ONEMEMORY_PG_URL`).
- M13 compose: `CREATE EXTENSION vector` in the init script (createServerDb self-heals today).
- M2 retrieval codes against core ports only (`Store.queryCurrent/queryAsOf/historyOf`,
  `EmbeddingIndex.search`, `Searcher`) — no storage imports needed.
- M3 embeddings implements `Embedder`; register the `re_embed` job kind then. Until a kind is
  registered, the worker dead-letters those jobs loudly by design.
- `memory_events` intentionally has no FK to `memories` (mirrors the doc DDL — the audit trail
  survives hard `--purge` deletes); revisit only if that's not intended.

## 7. What M2/M3 can rely on now

- `createEmbeddedDb(dataDir)` / `createServerDb(url)` → `OnememoryStorage` with
  `store` / `jobs` / `vectors` / `migrate()` / `close()`, identical on both profiles.
- Core schemas + model are importable from `@onememory-ai/core` (Zod-first, snake_case).
- The committed migration is the single source of schema truth for every later mission.
- No placeholder logic anywhere: unimplemented pipeline kinds fail via `JobKindNotImplemented`
  rather than fake success.
