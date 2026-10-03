# ADR-0002: One Postgres dialect across embedded / Docker / cloud / SaaS

Status: Accepted (user decision 2026-10-03) · Date: 2026-10-03

## Context

Spec §17 named Postgres+pgvector as the default local stack; §29/§30 demand one-command,
ultra-light install; the user's ruling: Postgres via Docker is the local default, and the system
must also self-deploy to any cloud and support a hosted SaaS like Supermemory/Mem0. Maintaining two
SQL dialects (SQLite + Postgres) doubles migration and testing surface (risk R14).

## Decision

**One Postgres dialect, three deployment targets, one migration set:**

| Profile | Engine | Default for | Vector | Notes |
|---|---|---|---|---|
| `server` (default) | Docker Compose Postgres 17 + pgvector (HNSW) | `onemem serve`, teams, self-host, cloud, SaaS | pgvector | canonical, fully supported |
| `embedded` | PGlite (WASM Postgres) + `@electric-sql/pglite-pgvector` | zero-Docker quick start, CI, single-agent local | pgvector ext or fallback | **evaluation-gated**, see below |
| `cloud/SaaS` | managed Postgres (RDS/Neon/Supabase) with pgvector | hosted offering | pgvector | same schema, ADR-0011 |

- **ORM**: Drizzle (pgvector + PGlite adapters), generated SQL migrations committed and exercised
  against BOTH real Postgres and PGlite in the CI matrix (`embedded` / `postgres`).
- **Graph**: relational tables + recursive CTEs. **No Neo4j** (spec §17; validated by landscape:
  Mem0 self-hosted, cognee, and memU all converge on Postgres+pgvector; Graphiti's mandatory Neo4j/
  FalkorDB is a heavy install for a local tool). No pgvectorscale until memory-bound at scale.
- **Jobs**: own `jobs` table + worker loop (SKIP LOCKED, leases, idempotency) — no queue dependency
  initially; pg-boss is the named successor if concurrency/scheduling needs exceed it.

### Embedded profile acceptance gate (NEW — from dependency research)

PGlite is 0.5.x and high-adoption, but: (a) its pgvector extension package is still **0.0.x**
(0.0.9, 2026-08-26); (b) it is **single-owner-process** — concurrent multi-process access to one
data dir is unsafe (SIGSEGV report). Therefore:

1. Embedded profile ships **behind a config flag** and is labeled *experimental* until the
   acceptance suite passes: extension load/DDL, vector values + KNN, generated tsvector + GIN,
   persistence/reopen, backup, migration parity, interruption recovery.
2. **Process model (resolves risk D1)**: embedded storage has exactly one owner process —
   `onemem serve` as a local daemon owns PGlite; CLI and MCP stdio server speak HTTP to it.
   Concurrent multi-agent use routes to the `server` profile. Documented limitation, not hidden.
3. **Escape hatch (R14)**: only if PGlite fails the gate, `bun:sqlite` + sqlite-vec + FTS5 becomes
   the embedded fallback — an isolated implementation behind the same `EmbeddingIndex`/
   storage ports, explicitly *not* a supported second stack for server/cloud.

## Consequences

- Schema in `database-schema.md` is the single source of truth; all SQL lives in `packages/storage`.
- Vector dimension is fixed per deployment (config at init); embedding model swaps go through the
  `re_embed` job (ADR-0006).
- HNSW tuned (`m`, `ef_construction`, `ef_search`) on server; embedded relies on exact/linear KNN
  (fine at ≤10⁵ rows).

## References

`docs/research/dependency-verification.md` §1–§4 (PGlite/pgvector/Drizzle/sqlite-vec verdicts),
§16 (jobs); `docs/research/memory-systems-landscape.md` adopt-items 10 (Postgres convergence),
avoid-item 4 (graph DB dependency); `docs/architecture/database-schema.md` (DDL + GATE-1);
`docs/risks.md` R1/R2/R14/D1.
