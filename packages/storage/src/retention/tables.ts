/**
 * Retention tables — the M14.6 events-compaction schema. The drizzle-kit migration generator
 * reads this file alongside `src/schema/tables.ts` (see `drizzle.config.ts`); the runtime SQL
 * lives in `src/retention/events-compaction.ts`.
 *
 * `memory_events_digest` is deliberately FK-less (like `memory_events`): a digest row must
 * OUTLIVE the raw `events` row it summarizes — that is its entire purpose — so nothing may
 * reference or cascade into it. The `event_id` column is unique: summarize-once idempotency.
 */

import { sql } from 'drizzle-orm';

import { index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'string' })
    .notNull()
    .default(sql`now()`);

/** One digest row per compacted raw event — the surviving lineage record (backlog M14.6). */
export const memoryEventsDigest = pgTable(
  'memory_events_digest',
  {
    id: uuid('id').primaryKey(),
    /** The summarized raw event — the chain `event:<id>` evidence locators resolve against. */
    event_id: uuid('event_id').notNull().unique(),
    kind: text('kind').notNull(),
    runtime: text('runtime').notNull(),
    adapter_version: text('adapter_version').notNull(),
    project_id: uuid('project_id'),
    session_id: text('session_id'),
    agent_id: text('agent_id'),
    user_id: uuid('user_id'),
    /** Preserved verbatim — the events dedupe key member survives compaction. */
    content_hash: text('content_hash').notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true, mode: 'string' }).notNull(),
    ingested_at: timestamp('ingested_at', { withTimezone: true, mode: 'string' }).notNull(),
    /** The bounded one-line payload summary. */
    summary: text('summary').notNull(),
    /** Size of the purged raw payload — the audit of what was removed. */
    payload_bytes: integer('payload_bytes').notNull(),
    /** Redaction records the raw payload carried (count only — ADR-0007 never stores content). */
    redactions_count: integer('redactions_count').notNull().default(0),
    /** The distinct `sources` rows whose evidence spans anchor the event (the lineage shortcut). */
    source_ids: uuid('source_ids').array().notNull().default(sql`'{}'::uuid[]`),
    created_at: createdAt(),
  },
  (table) => [
    index('memory_events_digest_scope_idx').on(table.project_id, table.occurred_at.desc()),
  ],
);
