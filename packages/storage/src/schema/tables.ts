/**
 * Drizzle table definitions — a 1:1 mirror of the normative DDL in
 * `docs/architecture/database-schema.md` (names, columns, CHECKs, indexes). Drizzle-kit generates
 * the SQL migrations from this file; the runtime repositories in this package are handwritten
 * parameterized SQL (allowed here: `packages/storage` is the only place with SQL).
 *
 * Note: drizzle expresses CHECK constraints at the table level (`check(name, sql)`), so the
 * column-level CHECKs of the DDL appear in each table's constraint list — same semantics, and the
 * generated migration carries the same CHECK expressions.
 */

import { sql } from 'drizzle-orm';

import {
  boolean,
  check,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  vector,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

import type { EvidenceSpan, OnememoryEvent } from '@onememory/core';

// ---------------------------------------------------------------------------
// Column helpers
// ---------------------------------------------------------------------------

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .default(sql`now()`);
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .default(sql`now()`);

/** `tsvector` is not a built-in drizzle pg type; declare the raw type name. */
const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

// ---------------------------------------------------------------------------
// Identity & scope
// ---------------------------------------------------------------------------

export const users = pgTable('users', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email'),
  created_at: createdAt(),
  updated_at: updatedAt(),
});

export const projects = pgTable('projects', {
  id: uuid('id').primaryKey(),
  name: text('name').notNull(),
  root_path: text('root_path'),
  git_remote: text('git_remote'),
  description: text('description'),
  digest: jsonb('digest').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  created_at: createdAt(),
  updated_at: updatedAt(),
});

// ---------------------------------------------------------------------------
// Provenance & raw events
// ---------------------------------------------------------------------------

export const sources = pgTable(
  'sources',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    uri: text('uri'),
    title: text('title'),
    content_hash: text('content_hash'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    project_id: uuid('project_id').references(() => projects.id),
    created_at: createdAt(),
  },
  (table) => [
    check(
      'sources_kind_check',
      sql`kind IN ('conversation','document','git','terminal','file','web','api','explicit')`,
    ),
  ],
);

export const events = pgTable(
  'events',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    runtime: text('runtime').notNull(),
    adapter_version: text('adapter_version').notNull(),
    project_id: uuid('project_id').references(() => projects.id),
    session_id: text('session_id'),
    agent_id: text('agent_id'),
    user_id: uuid('user_id').references(() => users.id),
    payload: jsonb('payload').$type<OnememoryEvent['payload']>().notNull(),
    content_hash: text('content_hash').notNull(),
    redactions: jsonb('redactions')
      .$type<OnememoryEvent['redactions']>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    occurred_at: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    ingested_at: timestamp('ingested_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`now()`),
    processed_at: timestamp('processed_at', { withTimezone: true, mode: 'string' }),
    process_error: text('process_error'),
    needs_review: boolean('needs_review').notNull().default(false),
  },
  (table) => [
    index('events_project_time_idx').on(table.project_id, table.occurred_at.desc()),
    uniqueIndex('events_dedupe_idx').on(table.project_id, table.kind, table.content_hash),
  ],
);

// ---------------------------------------------------------------------------
// Memories — the canonical table
// ---------------------------------------------------------------------------

export const memories = pgTable(
  'memories',
  {
    id: uuid('id').primaryKey(),
    type: text('type').notNull(),
    subtype: text('subtype'),
    title: text('title'),
    content: text('content').notNull(),
    content_summary: text('content_summary'),
    content_hash: text('content_hash').notNull(),
    status: text('status').notNull().default('active'),
    importance: real('importance').notNull(),
    confidence: real('confidence').notNull(),
    access_count: integer('access_count').notNull().default(0),
    last_accessed_at: timestamp('last_accessed_at', { withTimezone: true, mode: 'string' }),
    observed_at: timestamp('observed_at', { withTimezone: true, mode: 'string' }).notNull(),
    valid_from: timestamp('valid_from', { withTimezone: true, mode: 'string' }).notNull(),
    valid_until: timestamp('valid_until', { withTimezone: true, mode: 'string' }),
    created_at: createdAt(),
    updated_at: updatedAt(),
    superseded_by: uuid('superseded_by').references((): AnyPgColumn => memories.id),
    project_id: uuid('project_id').references(() => projects.id),
    user_id: uuid('user_id').references(() => users.id),
    agent_id: text('agent_id'),
    source_id: uuid('source_id')
      .notNull()
      .references(() => sources.id),
    evidence: jsonb('evidence')
      .$type<EvidenceSpan[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    extraction: jsonb('extraction')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    token_estimate: integer('token_estimate').notNull().default(0),
    search_text: tsvector('search_text').generatedAlwaysAs(
      sql`to_tsvector('simple', coalesce(title, '') || ' ' || content)`,
    ),
  },
  (table) => [
    check(
      'memories_type_check',
      sql`type IN ('episodic','semantic','procedural','decision','failure','preference')`,
    ),
    check(
      'memories_status_check',
      sql`status IN ('active','stale','superseded','disputed','archived')`,
    ),
    check('memories_importance_check', sql`importance BETWEEN 0 AND 1`),
    check('memories_confidence_check', sql`confidence BETWEEN 0 AND 1`),
    // Exact-dedupe: one statement per (scope, type); NULL scope coalesced to nil-uuid
    uniqueIndex('memories_dedupe_idx').on(
      sql`coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      sql`coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.type,
      table.content_hash,
    ),
    index('memories_scope_idx').on(table.project_id, table.type, table.status),
    // Hot path: "currently valid" lookups
    index('memories_current_idx')
      .on(table.project_id, table.observed_at.desc())
      .where(sql`status IN ('active','stale') AND valid_until IS NULL`),
    index('memories_temporal_idx').on(table.project_id, table.valid_from, table.valid_until),
    index('memories_supersede_idx')
      .on(table.superseded_by)
      .where(sql`superseded_by IS NOT NULL`),
    index('memories_fts_idx').using('gin', table.search_text),
  ],
);

// ---------------------------------------------------------------------------
// Vectors (companion table; dimension fixed per deployment — config at init)
// ---------------------------------------------------------------------------

export const memoryVectors = pgTable(
  'memory_vectors',
  {
    memory_id: uuid('memory_id')
      .primaryKey()
      .references(() => memories.id, { onDelete: 'cascade' }),
    model: text('model').notNull(),
    dim: integer('dim').notNull(),
    embedding: vector('embedding', { dimensions: 384 }),
  },
  (table) => [
    index('memory_vectors_hnsw_idx').using('hnsw', table.embedding.op('vector_cosine_ops')),
  ],
);

// ---------------------------------------------------------------------------
// Entities & the memory graph
// ---------------------------------------------------------------------------

export const entities = pgTable(
  'entities',
  {
    id: uuid('id').primaryKey(),
    project_id: uuid('project_id'),
    kind: text('kind').notNull(),
    name: text('name').notNull(),
    normalized_name: text('normalized_name').notNull(),
    aliases: text('aliases').array().notNull().default(sql`'{}'::text[]`),
    description: text('description'),
    confidence: real('confidence').notNull().default(0.5),
    merged_into: uuid('merged_into').references((): AnyPgColumn => entities.id),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    check(
      'entities_kind_check',
      sql`kind IN ('tool','library','language','person','service','concept','project','file','other')`,
    ),
    uniqueIndex('entities_scope_name_idx').on(
      sql`coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)`,
      table.normalized_name,
    ),
  ],
);

export const memoryEntities = pgTable(
  'memory_entities',
  {
    memory_id: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    entity_id: uuid('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
    role: text('role').notNull().default('context'),
    weight: real('weight').notNull().default(1.0),
    created_at: createdAt(),
  },
  (table) => [
    check('memory_entities_role_check', sql`role IN ('subject','object','context')`),
    primaryKey({ columns: [table.memory_id, table.entity_id] }),
    index('memory_entities_entity_idx').on(table.entity_id),
  ],
);

export const edges = pgTable(
  'edges',
  {
    id: uuid('id').primaryKey(),
    from_memory_id: uuid('from_memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    to_memory_id: uuid('to_memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    relation: text('relation').notNull(),
    project_id: uuid('project_id'),
    confidence: real('confidence').notNull().default(0.8),
    valid_from: timestamp('valid_from', { withTimezone: true, mode: 'string' }),
    valid_until: timestamp('valid_until', { withTimezone: true, mode: 'string' }),
    evidence: jsonb('evidence')
      .$type<EvidenceSpan[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    created_at: createdAt(),
  },
  (table) => [
    check(
      'edges_relation_check',
      sql`relation IN ('related_to','depends_on','caused_by','solved_by','decided_by','supersedes','contradicts','derived_from','belongs_to','used_by','modifies')`,
    ),
    unique('edges_from_to_relation_unique').on(
      table.from_memory_id,
      table.to_memory_id,
      table.relation,
    ),
    index('edges_from_idx').on(table.from_memory_id),
    index('edges_to_idx').on(table.to_memory_id),
  ],
);

// ---------------------------------------------------------------------------
// Typed payloads
// ---------------------------------------------------------------------------

export const decisions = pgTable(
  'decisions',
  {
    memory_id: uuid('memory_id')
      .primaryKey()
      .references(() => memories.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    decision: text('decision').notNull(),
    alternatives: jsonb('alternatives')
      .$type<Array<{ option: string; why_rejected?: string }>>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    rationale: text('rationale'),
    participants: text('participants').array().notNull().default(sql`'{}'::text[]`),
    decided_at: timestamp('decided_at', { withTimezone: true, mode: 'string' }).notNull(),
    status: text('status').notNull().default('proposed'),
  },
  (table) => [
    check(
      'decisions_status_check',
      sql`status IN ('proposed','accepted','superseded','rejected')`,
    ),
  ],
);

export const failures = pgTable(
  'failures',
  {
    memory_id: uuid('memory_id')
      .primaryKey()
      .references(() => memories.id, { onDelete: 'cascade' }),
    problem: text('problem').notNull(),
    context: text('context').notNull(),
    root_cause: text('root_cause'),
    solution: text('solution'),
    verification: text('verification'),
    status: text('status').notNull().default('open'),
    signature_hash: text('signature_hash').notNull(),
    first_seen_at: timestamp('first_seen_at', { withTimezone: true, mode: 'string' }).notNull(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true, mode: 'string' }).notNull(),
    occurrence_count: integer('occurrence_count').notNull().default(1),
  },
  (table) => [
    check('failures_status_check', sql`status IN ('open','mitigated','solved','verified')`),
    index('failures_signature_idx').on(table.signature_hash),
  ],
);

export const skills = pgTable(
  'skills',
  {
    id: uuid('id').primaryKey(),
    project_id: uuid('project_id'),
    name: text('name').notNull(),
    description: text('description').notNull(),
    version: text('version').notNull().default('1.0.0'),
    status: text('status').notNull().default('candidate'),
    source: jsonb('source').$type<Record<string, unknown>>().notNull(),
    verification: jsonb('verification').$type<Record<string, unknown>>().notNull(),
    path: text('path').notNull(),
    usage_count: integer('usage_count').notNull().default(0),
    success_rate: real('success_rate'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    check(
      'skills_status_check',
      sql`status IN ('candidate','verified','promoted','deprecated')`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Sessions, working memory, jobs, audit
// ---------------------------------------------------------------------------

export const sessions = pgTable('sessions', {
  id: text('id').primaryKey(),
  project_id: uuid('project_id').references(() => projects.id),
  agent_id: text('agent_id'),
  runtime: text('runtime').notNull(),
  started_at: timestamp('started_at', { withTimezone: true, mode: 'string' }).notNull(),
  ended_at: timestamp('ended_at', { withTimezone: true, mode: 'string' }),
  summary: text('summary'),
  stats: jsonb('stats').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
});

export const workingMemory = pgTable(
  'working_memory',
  {
    id: uuid('id').primaryKey(),
    session_id: text('session_id')
      .notNull()
      .references(() => sessions.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    content: text('content').notNull(),
    importance: real('importance').notNull().default(0.3),
    confidence: real('confidence').notNull().default(0.4),
    source_id: uuid('source_id').references(() => sources.id),
    evidence: jsonb('evidence')
      .$type<EvidenceSpan[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    promoted_memory_id: uuid('promoted_memory_id').references(() => memories.id),
    expires_at: timestamp('expires_at', { withTimezone: true, mode: 'string' }).notNull(),
    created_at: createdAt(),
  },
  (table) => [
    check(
      'working_memory_kind_check',
      sql`kind IN ('task','hypothesis','current_file','current_error','temp_decision','open_question')`,
    ),
    index('working_session_idx').on(table.session_id),
    index('working_expiry_idx')
      .on(table.expires_at)
      .where(sql`promoted_memory_id IS NULL`),
  ],
);

export const jobs = pgTable(
  'jobs',
  {
    id: uuid('id').primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    status: text('status').notNull().default('pending'),
    run_at: timestamp('run_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`now()`),
    attempts: integer('attempts').notNull().default(0),
    max_attempts: integer('max_attempts').notNull().default(3),
    locked_by: text('locked_by'),
    locked_at: timestamp('locked_at', { withTimezone: true, mode: 'string' }),
    last_error: text('last_error'),
    created_at: createdAt(),
    updated_at: updatedAt(),
  },
  (table) => [
    check('jobs_status_check', sql`status IN ('pending','running','done','failed','dead')`),
    index('jobs_ready_idx').on(table.status, table.run_at),
    // Prevent scheduling duplicate instances of the same logical work. NOTE: index expressions
    // must be parenthesized in Postgres — the DDL doc's `(kind, payload->>'key')` shorthand is
    // invalid SQL as written (reported in mission-1.md); drizzle-kit emits `(payload->>'key')`.
    uniqueIndex('jobs_singleton_idx')
      .on(table.kind, sql`(payload->>'key')`)
      .where(sql`status IN ('pending','running')`),
  ],
);

export const memoryEvents = pgTable(
  'memory_events',
  {
    id: uuid('id').primaryKey(),
    memory_id: uuid('memory_id').notNull(),
    action: text('action').notNull(),
    from_status: text('from_status'),
    to_status: text('to_status'),
    actor: text('actor').notNull(),
    details: jsonb('details').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    at: timestamp('at', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [index('memory_events_memory_idx').on(table.memory_id, table.at.desc())],
);

export const systemState = pgTable('system_state', {
  key: text('key').primaryKey(),
  value: jsonb('value').$type<Record<string, unknown>>().notNull(),
  updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .default(sql`now()`),
});

// ---------------------------------------------------------------------------
// Code memory (Phase 2 tables — defined now, exercised later)
// ---------------------------------------------------------------------------

export const repositories = pgTable('repositories', {
  id: uuid('id').primaryKey(),
  project_id: uuid('project_id')
    .notNull()
    .references(() => projects.id),
  root_path: text('root_path').notNull(),
  remote_url: text('remote_url'),
  head_commit: text('head_commit'),
  last_ingested_commit: text('last_ingested_commit'),
  fingerprint: jsonb('fingerprint')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`),
  last_indexed_at: timestamp('last_indexed_at', { withTimezone: true, mode: 'string' }),
  created_at: createdAt(),
  updated_at: updatedAt(),
});

export const fileFingerprints = pgTable(
  'file_fingerprints',
  {
    repository_id: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    blob_sha: text('blob_sha').notNull(),
    tier: text('tier').notNull().default('committed'),
    last_seen_commit: text('last_seen_commit'),
    symbols_hash: text('symbols_hash'),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    check('file_fingerprints_tier_check', sql`tier IN ('committed','worktree')`),
    primaryKey({ columns: [table.repository_id, table.path] }),
  ],
);

export const codeSymbols = pgTable(
  'code_symbols',
  {
    id: uuid('id').primaryKey(),
    repository_id: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    signature: text('signature'),
    line_start: integer('line_start'),
    line_end: integer('line_end'),
    span_hash: text('span_hash'),
    updated_at: timestamp('updated_at', { withTimezone: true, mode: 'string' })
      .notNull()
      .default(sql`now()`),
  },
  (table) => [
    index('code_symbols_repo_path_idx').on(table.repository_id, table.path),
    index('code_symbols_name_idx').on(table.repository_id, table.name),
  ],
);

export const memoryCodeRefs = pgTable(
  'memory_code_refs',
  {
    memory_id: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'cascade' }),
    repository_id: uuid('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    blob_sha: text('blob_sha').notNull(),
    created_at: createdAt(),
  },
  (table) => [
    primaryKey({ columns: [table.memory_id, table.repository_id, table.path] }),
    index('memory_code_refs_repo_idx').on(table.repository_id, table.path),
  ],
);
