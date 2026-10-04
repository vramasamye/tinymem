# Database schema

Status: draft for architecture review · Feeds ADR-0002 (storage), ADR-0005 (graph) · Companion to `memory-model.md`

One Postgres dialect, three deployment targets (embedded PGlite, Docker Postgres+pgvector,
cloud/managed Postgres). **No Neo4j**: the memory graph is relational tables + recursive CTEs
(spec §17). All SQL lives only in `packages/storage` (Drizzle ORM + handwritten SQL for
recursion/vector ops where needed).

---

## 1. Entity-relationship overview

```text
projects 1──n memories 1──n memory_vectors
   │            │ 1──n memory_entities n──1 entities
   │            │ 1──n edges (from/to other memories)
   │            │ 1──1 decisions | failures            (typed payload tables)
   │            │ 1──n memory_code_refs n──1 repositories
   │            │ 1──n memory_events (append-only audit)
   │            └──n superseded_by (self-FK)
   ├──n sessions 1──n working_memory (TTL scratchpad; promotions → memories)
   ├──n sources 1──n memories / events / working_memory (provenance anchor)
   └──n repositories 1──n file_fingerprints / code_symbols

events (append-only raw log) → async pipeline → memories
jobs (internal work queue)   skills (verified procedures → SKILL.md)
```

## 2. Core tables

### Identity & scope

```sql
CREATE TABLE users (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  email       text,                          -- SaaS mode only; local mode = one implicit user
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE projects (
  id          uuid PRIMARY KEY,
  name        text NOT NULL,
  root_path   text,                          -- filesystem anchor, null in pure SaaS mode
  git_remote  text,
  description text,
  digest      jsonb NOT NULL DEFAULT '{}',   -- rollup: summary, stack, conventions (consolidation-rebuilt)
  settings    jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
```

`agents` are NOT a table: `agent_id` is a free text label on memories/events/sessions
("claude-code", "codex", "opus-plan"). A registry buys nothing in Phase 1–3; revisit if analytics
demand it.

### Provenance & raw events

```sql
CREATE TABLE sources (
  id           uuid PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN
    ('conversation','document','git','terminal','file','web','api','explicit')),
  uri          text,                          -- e.g. conversation/session/2026-10-03, file:///docs/x.md
  title        text,
  content_hash text,
  metadata     jsonb NOT NULL DEFAULT '{}',
  project_id   uuid REFERENCES projects(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE events (                         -- append-only raw log (lifecycle stage INGEST)
  id              uuid PRIMARY KEY,
  kind            text NOT NULL,              -- event-memory-schemas.md §2
  runtime         text NOT NULL,
  adapter_version text NOT NULL,
  project_id      uuid REFERENCES projects(id),
  session_id      text,
  agent_id        text,
  user_id         uuid REFERENCES users(id),
  payload         jsonb NOT NULL,
  content_hash    text NOT NULL,
  redactions      jsonb NOT NULL DEFAULT '[]', -- kind+location+length only, never secret values
  occurred_at     timestamptz NOT NULL,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  processed_at    timestamptz,
  process_error   text,
  needs_review    boolean NOT NULL DEFAULT false
);
CREATE INDEX events_project_time_idx ON events (project_id, occurred_at DESC);
CREATE UNIQUE INDEX events_dedupe_idx ON events (project_id, kind, content_hash);
```

### Memories — the canonical table

```sql
CREATE TABLE memories (
  id              uuid PRIMARY KEY,
  type            text NOT NULL CHECK (type IN
    ('episodic','semantic','procedural','decision','failure','preference')),
  subtype         text,
  title           text,
  content         text NOT NULL,
  content_summary text,
  content_hash    text NOT NULL,              -- sha256 of normalized content (dedupe key)
  status          text NOT NULL DEFAULT 'active' CHECK (status IN
    ('active','stale','superseded','disputed','archived')),
  importance      real NOT NULL CHECK (importance BETWEEN 0 AND 1),
  confidence      real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  access_count    integer NOT NULL DEFAULT 0,
  last_accessed_at timestamptz,
  observed_at     timestamptz NOT NULL,       -- fact time: when true in the world
  valid_from      timestamptz NOT NULL,
  valid_until     timestamptz,                -- NULL = currently valid
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  superseded_by   uuid REFERENCES memories(id),
  project_id      uuid REFERENCES projects(id), -- NULL = cross-project/user-level
  user_id         uuid REFERENCES users(id),
  agent_id        text,
  source_id       uuid NOT NULL REFERENCES sources(id),
  evidence        jsonb NOT NULL DEFAULT '[]', -- EvidenceSpan[]
  extraction      jsonb NOT NULL DEFAULT '{}',  -- {method, model, prompt_version, adapter}
  tags            text[] NOT NULL DEFAULT '{}',
  token_estimate  integer NOT NULL DEFAULT 0,
  search_text     tsvector GENERATED ALWAYS AS (
    to_tsvector('simple', coalesce(title, '') || ' ' || content)
  ) STORED
);

-- Exact-dedupe: one statement per (scope, type); NULL scope coalesced to nil-uuid
CREATE UNIQUE INDEX memories_dedupe_idx ON memories (
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(user_id,    '00000000-0000-0000-0000-000000000000'::uuid),
  type, content_hash);

CREATE INDEX memories_scope_idx     ON memories (project_id, type, status);
-- Hot path: "currently valid" lookups
CREATE INDEX memories_current_idx    ON memories (project_id, observed_at DESC)
  WHERE status IN ('active','stale') AND valid_until IS NULL;
CREATE INDEX memories_temporal_idx  ON memories (project_id, valid_from, valid_until);
CREATE INDEX memories_supersede_idx ON memories (superseded_by) WHERE superseded_by IS NOT NULL;
CREATE INDEX memories_fts_idx       ON memories USING gin (search_text);
```

### Vectors (separate companion table, dimension fixed per deployment)

```sql
CREATE TABLE memory_vectors (
  memory_id uuid PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  model     text NOT NULL,                    -- e.g. 'local/minilm-l6-v2'
  dim       integer NOT NULL,                  -- fixed by config at init (embedding.dimension)
  embedding vector(384)                       -- dim must match config; altered by migration on model change
);
CREATE INDEX memory_vectors_hnsw_idx ON memory_vectors USING hnsw (embedding vector_cosine_ops);
```

Server mode: HNSW as above. Embedded mode (PGlite): plain index or none — brute-force KNN over
10⁴–10⁵ rows is milliseconds (see §5 GATE-1 for the no-pgvector fallback).

### Entities & the memory graph

```sql
CREATE TABLE entities (
  id              uuid PRIMARY KEY,
  project_id      uuid,                        -- NULL = global (PostgreSQL, Docker, Node.js…)
  kind            text NOT NULL CHECK (kind IN
    ('tool','library','language','person','service','concept','project','file','other')),
  name            text NOT NULL,
  normalized_name text NOT NULL,
  aliases         text[] NOT NULL DEFAULT '{}',
  description     text,
  confidence      real NOT NULL DEFAULT 0.5,
  merged_into     uuid REFERENCES entities(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX entities_scope_name_idx ON entities (
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), normalized_name);

CREATE TABLE memory_entities (
  memory_id  uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  entity_id  uuid NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  role       text NOT NULL DEFAULT 'context' CHECK (role IN ('subject','object','context')),
  weight     real NOT NULL DEFAULT 1.0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, entity_id)
);
CREATE INDEX memory_entities_entity_idx ON memory_entities (entity_id);

CREATE TABLE edges (                          -- the memory graph: memory ↔ memory
  id             uuid PRIMARY KEY,
  from_memory_id uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id   uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  relation       text NOT NULL CHECK (relation IN
    ('related_to','depends_on','caused_by','solved_by','decided_by','supersedes',
     'contradicts','derived_from','belongs_to','used_by','modifies')),
  project_id     uuid,
  confidence     real NOT NULL DEFAULT 0.8,
  valid_from     timestamptz,
  valid_until    timestamptz,                 -- edge-level bi-temporality (contradiction invalidation)
  evidence       jsonb NOT NULL DEFAULT '[]',
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (from_memory_id, to_memory_id, relation)
);
CREATE INDEX edges_from_idx ON edges (from_memory_id);
CREATE INDEX edges_to_idx   ON edges (to_memory_id);
```

Traversal is 1–2 hops for ranking (index-backed joins); `WITH RECURSIVE` covers deeper graph
questions and timeline reconstruction. No graph DB.

### Typed payloads

```sql
CREATE TABLE decisions (
  memory_id    uuid PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  title        text NOT NULL,
  decision     text NOT NULL,
  alternatives jsonb NOT NULL DEFAULT '[]',   -- [{option, why_rejected}]
  rationale    text,
  participants text[] NOT NULL DEFAULT '{}',
  decided_at   timestamptz NOT NULL,
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN
    ('proposed','accepted','superseded','rejected'))
);

CREATE TABLE failures (
  memory_id       uuid PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
  problem         text NOT NULL,
  context         text NOT NULL,
  root_cause      text,
  solution        text,
  verification    text,                        -- proof the fix worked (command output digest, test result)
  status          text NOT NULL DEFAULT 'open' CHECK (status IN
    ('open','mitigated','solved','verified')),
  signature_hash  text NOT NULL,               -- normalized problem signature for recurrence matching
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  occurrence_count integer NOT NULL DEFAULT 1
);
CREATE INDEX failures_signature_idx ON failures (signature_hash);

CREATE TABLE skills (
  id           uuid PRIMARY KEY,
  project_id    uuid,
  name         text NOT NULL,                 -- kebab-case, == directory name
  description  text NOT NULL,
  version      text NOT NULL DEFAULT '1.0.0',
  status       text NOT NULL DEFAULT 'candidate' CHECK (status IN
    ('candidate','verified','promoted','deprecated')),
  source       jsonb NOT NULL,                 -- {failure_ids, procedure_id}
  verification jsonb NOT NULL,                -- {evidence, verified_at}
  path         text NOT NULL,                 -- skills/<slug>/SKILL.md
  usage_count  integer NOT NULL DEFAULT 0,
  success_rate real,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
```

### Sessions, working memory, jobs, audit

```sql
CREATE TABLE sessions (
  id         text PRIMARY KEY,
  project_id uuid REFERENCES projects(id),
  agent_id   text,
  runtime    text NOT NULL,
  started_at timestamptz NOT NULL,
  ended_at   timestamptz,
  summary    text,
  stats      jsonb NOT NULL DEFAULT '{}'
);

CREATE TABLE working_memory (                  -- TTL scratchpad; deletions allowed here
  id                 uuid PRIMARY KEY,
  session_id         text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN
    ('task','hypothesis','current_file','current_error','temp_decision','open_question')),
  content            text NOT NULL,
  importance         real NOT NULL DEFAULT 0.3,
  confidence         real NOT NULL DEFAULT 0.4,
  source_id          uuid REFERENCES sources(id),
  evidence           jsonb NOT NULL DEFAULT '[]',
  promoted_memory_id uuid REFERENCES memories(id),
  expires_at         timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX working_session_idx ON working_memory (session_id);
CREATE INDEX working_expiry_idx  ON working_memory (expires_at) WHERE promoted_memory_id IS NULL;

CREATE TABLE jobs (                            -- internal work queue (stages 3–9, 12–14)
  id           uuid PRIMARY KEY,
  kind         text NOT NULL,                  -- normalize|extract|consolidate|decay|drift_scan|
                                               -- reindex|skillify|re_embed|verify_stale
  payload      jsonb NOT NULL DEFAULT '{}',
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN
    ('pending','running','done','failed','dead')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  locked_by    text,
  locked_at    timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_ready_idx ON jobs (status, run_at);
-- Prevent scheduling duplicate instances of the same logical work
-- (expression index elements must be parenthesized — caught by M1's GATE-1 suite)
CREATE UNIQUE INDEX jobs_singleton_idx ON jobs (kind, (payload->>'key'))
  WHERE status IN ('pending','running');

CREATE TABLE memory_events (                   -- append-only audit trail
  id          uuid PRIMARY KEY,
  memory_id   uuid NOT NULL,
  action      text NOT NULL,                   -- created|status_changed|reinforced|merged|
                                               -- archived|restored|purged|edited|redacted
  from_status text,
  to_status   text,
  actor       text NOT NULL,                   -- system|user:<id>|agent:<id>|job:<kind>
  details     jsonb NOT NULL DEFAULT '{}',
  at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX memory_events_memory_idx ON memory_events (memory_id, at DESC);

CREATE TABLE system_state (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

### Code memory (ADR-0008; sole writer: the `CodeMemoryStore` port — core-declared, storage-implemented)

```sql
CREATE TABLE repositories (
  id                    uuid PRIMARY KEY,
  project_id            uuid NOT NULL REFERENCES projects(id),
  root_path             text NOT NULL,
  remote_url            text,
  head_commit           text,                 -- fingerprint anchor (llm-wiki-loop style)
  last_ingested_commit  text,                 -- checkpoint: diff last_ingested..HEAD only; advanced
                                              --   ONLY by the drift pipeline, never by persistence
  fingerprint           jsonb NOT NULL DEFAULT '{}',
  last_indexed_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX repositories_project_root_idx ON repositories (project_id, root_path);

CREATE TABLE file_fingerprints (              -- zero-token drift oracle (both tiers per path)
  repository_id   uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path           text NOT NULL,
  blob_sha        text NOT NULL,              -- survives shallow clones (content-addressed)
  tier           text NOT NULL DEFAULT 'committed' CHECK (tier IN ('committed','worktree')),
  file_mode      text,                        -- '100644' | '100755'; null = pre-column rows
  last_seen_commit text,
  symbols_hash   text,                        -- hash of the symbol table for this file
  updated_at     timestamptz NOT NULL DEFAULT now(),  -- last VALUE change, not last observation
  PRIMARY KEY (repository_id, tier, path)     -- ADR-0008: committed and worktree coexist per path
);

CREATE TABLE code_symbols (
  id            uuid PRIMARY KEY,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path          text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL,                -- function|class|type|interface|method|const|module
  signature     text,
  line_start    integer,
  line_end      integer,
  span_hash     text,                         -- symbol-body hash → intra-file drift
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX code_symbols_repo_path_idx ON code_symbols (repository_id, path);
CREATE INDEX code_symbols_name_idx     ON code_symbols (repository_id, name);

CREATE TABLE memory_code_refs (               -- which memories rest on which code
  memory_id    uuid NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  repository_id uuid NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  path         text NOT NULL,
  blob_sha     text NOT NULL,                 -- blob the memory was verified against
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, repository_id, path)
);
CREATE INDEX memory_code_refs_repo_idx ON memory_code_refs (repository_id, path);
```

## 3. Multi-tenancy path (local → self-host → SaaS)

| Mode | Tenancy | Mechanism |
|---|---|---|
| Embedded (PGlite) | single user | implicit single `users` row; scoping columns exist but one-value populated |
| Self-host server | small team | API keys → `user_id`; every query already scoped by `project_id`/`user_id` |
| SaaS | orgs/multi-tenant | additive migration adds `orgs` + `org_id` (default org for legacy rows) + Postgres RLS policies |

The schema is tenancy-ready without being tenancy-burdened: all retrieval paths already filter by
scope, so SaaS mode is API-layer + one migration, not a redesign. No artificial open-core limits
(spec §34): the same schema runs everywhere.

## 4. Key query patterns (hot paths)

```sql
-- Current-validity lookup ("what Node version does this project use?")
SELECT * FROM memories
WHERE project_id = $1 AND status IN ('active','stale') AND valid_until IS NULL
  AND search_text @@ plainto_tsquery('simple', $2)
ORDER BY ts_rank(search_text, plainto_tsquery('simple', $2)) DESC LIMIT 20;

-- Point-in-time ("what did we use last year?")
SELECT * FROM memories
WHERE project_id = $1 AND valid_from <= $t AND (valid_until IS NULL OR valid_until > $t)
  AND type = ANY($types);

-- Hybrid recall: KNN + lexical, fused in retrieval package (RRF + weighted scoring)
SELECT memory_id, 1 - (embedding <=> $qvec) AS cosine FROM memory_vectors
  ORDER BY embedding <=> $qvec LIMIT 50;

-- Dedupe probe (stage DEDUPLICATE)
SELECT id, status FROM memories
WHERE coalesce(project_id,'000…'::uuid) = coalesce($proj,'000…'::uuid)
  AND type = $type AND content_hash = $hash;

-- Graph expansion (1–2 hop, ranking)
SELECT DISTINCT m.* FROM memories m
  JOIN memory_entities me ON me.memory_id = m.id
  WHERE me.entity_id = ANY($entity_ids) AND m.status IN ('active','stale')
UNION
SELECT m2.* FROM edges e
  JOIN memories m2 ON m2.id = e.to_memory_id
  WHERE e.from_memory_id = ANY($seed_ids) AND e.relation NOT IN ('contradicts');

-- Drift: memories whose code evidence changed. Refs record worktree-tier evidence blobs (what
-- the agent actually saw), so the join must pin the tier now that both tiers coexist per path.
SELECT r.id AS repo, mcr.memory_id, mcr.path FROM memory_code_refs mcr
  JOIN repositories r ON r.id = mcr.repository_id
  JOIN file_fingerprints ff ON ff.repository_id = mcr.repository_id AND ff.path = mcr.path
    AND ff.tier = 'worktree'
  WHERE r.id = $repo AND ff.blob_sha <> mcr.blob_sha;
```

## 5. Compatibility gates (embedded PGlite vs Postgres server)

| Feature | Postgres (Docker/cloud) | PGlite (embedded) | Gate |
|---|---|---|---|
| `vector` column type + HNSW | pgvector ext, full | pgvector ships as PGlite extension (**verify**) | **GATE-1**: if unavailable → `embedding_alt float8[]` + in-process cosine (brute force over ≤10⁵ rows is fine) |
| Generated `tsvector` column + GIN | yes | yes (real PG semantics) | none |
| Partial + expression unique indexes | yes | yes | none |
| `WITH RECURSIVE` | yes | yes | none |
| Concurrent writers | MVCC, many | single connection | embedded = single local agent; server mode for teams (by design) |
| Migrations | drizzle-kit SQL | same files | one dialect = one migration set |

GATE-1 is resolved by `docs/research/dependency-verification.md`; the fallback is isolated behind
the `EmbeddingIndex` port in `packages/storage`, so a late switch changes one module, not the model.

## 6. Migrations & operations

- Drizzle-kit generates SQL migrations (checked in); `onemem migrate` (embedded) and API boot
  (server) apply them idempotently, guarded by an advisory lock in server mode.
- Never destructive in a minor release: any breaking schema change ships with a dump/restore path
  and a major version bump.
- Vector dimension changes (embedding model swap): `re_embed` job re-populates
  `memory_vectors` offline; old vectors dropped only after success.
- Events table compaction: raw payloads older than N days (default 90) are summarized into
  `sources` and purged — evidence spans survive, raw chatter doesn't. Configurable; 0 = keep forever.
- Retention/decay sweeps are the `decay` job; they flip statuses, they never silently DELETE
  durable memories (`memory_events` records every transition).
