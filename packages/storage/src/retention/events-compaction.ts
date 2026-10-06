/**
 * Events compaction repository (M14.6 — backlog "Events compaction: summarize → purge raw
 * payload after retention window"). The raw `events` log is the only compacted table; the
 * `memory_events` audit trail stays append-only (ADR-0007 rule 6) and `sources` rows are never
 * touched (memory-model.md §6: sources outlive the raw payloads they anchor).
 *
 * Every purge is structurally safe: the DELETE refuses to remove a raw row without its digest
 * summary (an `EXISTS` guard in the same transaction that just wrote the digest), so "summarize
 * first, purge after" is enforced by the SQL itself, not by the caller's discipline.
 */

import {
  NewEventDigestSchema,
  uuidv7,
  type EventDigestRecord,
  type EventsCompactor,
  type NewEventDigest,
  type StoredEvent,
} from '@onememory/core';

import type { Database } from '../drivers/client';
import { pgUuidArray, toIso } from '../drivers/client';
import { mapEventRow } from '../repositories/row-mappers';
import { parseInput } from '../repositories/util';

/** The evidence-span locator prefix that binds a span to a raw event (`event:<id>`). */
const EVENT_LOCATOR_PREFIX = 'event:';

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Raw events older than `olderThan`, oldest first, bounded — the compaction scan. The optional
 * `after` cursor is a `(occurred_at, id)` keyset: every row is visited at most once per pass even
 * while summarize-only rows stay put (their digest is written, their raw row is kept).
 */
export async function listCompactableEvents(
  db: Database,
  options: { olderThan: string; limit: number; scope?: { project_id?: string }; after?: { occurred_at: string; id: string } },
): Promise<StoredEvent[]> {
  const params: unknown[] = [options.olderThan];
  let sql = 'SELECT * FROM events WHERE occurred_at < $1::timestamptz';
  if (options.scope?.project_id !== undefined) {
    params.push(options.scope.project_id);
    sql += ` AND project_id IS NOT DISTINCT FROM $${params.length}::uuid`;
  }
  if (options.after !== undefined) {
    params.push(options.after.occurred_at, options.after.id);
    sql += ` AND (occurred_at, id) > ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
  }
  params.push(Math.max(1, Math.floor(options.limit)));
  sql += ` ORDER BY occurred_at ASC, id ASC LIMIT $${params.length}`;
  const result = await db.query(sql, params);
  return result.rows.map(mapEventRow);
}

/** Which of these event ids already have a digest row (the summarize-once idempotency probe). */
export async function digestedEventIds(
  db: Database,
  eventIds: readonly string[],
): Promise<Set<string>> {
  if (eventIds.length === 0) return new Set();
  const result = await db.query<{ event_id: string }>(
    'SELECT event_id FROM memory_events_digest WHERE event_id = ANY($1::uuid[])',
    [pgUuidArray(eventIds)],
  );
  return new Set(result.rows.map((row) => row.event_id));
}

/**
 * The distinct `sources` rows whose evidence spans anchor these events — read from the durable
 * span stores (`memories.evidence`, `edges.evidence`, locator `event:<id>`). Carried on the
 * digest rows as the lineage shortcut: after the raw row is purged, the digest still answers
 * "which sources referenced this event".
 */
export async function sourcesForEvents(
  db: Database,
  eventIds: readonly string[],
): Promise<Map<string, string[]>> {
  const links = new Map<string, string[]>();
  if (eventIds.length === 0) return links;
  const locators = eventIds.map((id) => `${EVENT_LOCATOR_PREFIX}${id}`);
  const result = await db.query<{ locator: string | null; source_id: string | null }>(
    `SELECT DISTINCT el->>'locator' AS locator, el->>'source_id' AS source_id
       FROM memories m, jsonb_array_elements(m.evidence) el
      WHERE el->>'locator' = ANY($1::text[])
      UNION
     SELECT DISTINCT el->>'locator' AS locator, el->>'source_id' AS source_id
       FROM edges e, jsonb_array_elements(e.evidence) el
      WHERE el->>'locator' = ANY($1::text[])`,
    [locators],
  );
  for (const row of result.rows) {
    const locator = row.locator;
    const sourceId = row.source_id;
    if (locator === null || !locator.startsWith(EVENT_LOCATOR_PREFIX) || sourceId === null) continue;
    const eventId = locator.slice(EVENT_LOCATOR_PREFIX.length);
    const sources = links.get(eventId);
    if (sources === undefined) links.set(eventId, [sourceId]);
    else if (!sources.includes(sourceId)) sources.push(sourceId);
  }
  return links;
}

/** Raw `events` rows matching the scope — the retention ceiling metric for the report. */
export async function countRawEvents(
  db: Database,
  scope?: { project_id?: string },
): Promise<number> {
  if (scope?.project_id !== undefined) {
    const result = await db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM events WHERE project_id IS NOT DISTINCT FROM $1::uuid',
      [scope.project_id],
    );
    return result.rows[0]?.count ?? 0;
  }
  const result = await db.query<{ count: number }>('SELECT count(*)::int AS count FROM events');
  return result.rows[0]?.count ?? 0;
}

/** Digest lookup — the resolver for `event:<id>` evidence locators after compaction. */
export async function getEventDigest(
  db: Database,
  eventId: string,
): Promise<EventDigestRecord | null> {
  const result = await db.query('SELECT * FROM memory_events_digest WHERE event_id = $1::uuid', [
    eventId,
  ]);
  const row = result.rows[0];
  return row === undefined ? null : mapDigestRow(row);
}

// ---------------------------------------------------------------------------
// The one mutation: digests + purge in a single transaction
// ---------------------------------------------------------------------------

/**
 * ONE transaction: write the digest rows (unique on `event_id` — conflicts are no-ops, so a
 * crashed pass re-runs cleanly), then delete the raw rows. The DELETE carries an `EXISTS` guard:
 * a raw event is only ever removed when its digest row exists — in the same transaction for
 * first-time summaries, from an earlier pass for already-summarized events.
 */
export async function applyCompaction(
  db: Database,
  batch: { digests: NewEventDigest[]; purgeEventIds: readonly string[] },
): Promise<{ summarized: number; purged: number }> {
  const digests = batch.digests.map((digest, index) =>
    parseInput(NewEventDigestSchema, digest, `applyCompaction.digests[${index}]`),
  );
  if (digests.length === 0 && batch.purgeEventIds.length === 0) {
    return { summarized: 0, purged: 0 };
  }
  return db.transaction(async (tx) => {
    let summarized = 0;
    if (digests.length > 0) {
      const columns = 16;
      const values: string[] = [];
      const params: unknown[] = [];
      digests.forEach((digest, index) => {
        const base = index * columns;
        values.push(
          `($${base + 1}::uuid, $${base + 2}::uuid, $${base + 3}, $${base + 4}, $${base + 5}, ` +
            `$${base + 6}::uuid, $${base + 7}, $${base + 8}, $${base + 9}::uuid, $${base + 10}, ` +
            `$${base + 11}::timestamptz, $${base + 12}::timestamptz, $${base + 13}, $${base + 14}, ` +
            `$${base + 15}, $${base + 16}::uuid[])`,
        );
        params.push(
          digest.id ?? uuidv7(),
          digest.event_id,
          digest.kind,
          digest.runtime,
          digest.adapter_version,
          digest.project_id ?? null,
          digest.session_id ?? null,
          digest.agent_id ?? null,
          digest.user_id ?? null,
          digest.content_hash,
          digest.occurred_at,
          digest.ingested_at,
          digest.summary,
          digest.payload_bytes,
          digest.redactions_count ?? 0,
          pgUuidArray(digest.source_ids ?? []),
        );
      });
      const inserted = await tx.query(
        `INSERT INTO memory_events_digest (
           id, event_id, kind, runtime, adapter_version, project_id, session_id, agent_id,
           user_id, content_hash, occurred_at, ingested_at, summary, payload_bytes,
           redactions_count, source_ids
         ) VALUES ${values.join(', ')}
         ON CONFLICT (event_id) DO NOTHING`,
        params,
      );
      summarized = inserted.rowCount ?? 0;
    }

    let purged = 0;
    if (batch.purgeEventIds.length > 0) {
      const deleted = await tx.query(
        `DELETE FROM events e
          WHERE e.id = ANY($1::uuid[])
            AND EXISTS (SELECT 1 FROM memory_events_digest d WHERE d.event_id = e.id)`,
        [pgUuidArray(batch.purgeEventIds)],
      );
      purged = deleted.rowCount ?? 0;
    }
    return { summarized, purged };
  });
}

// ---------------------------------------------------------------------------
// Row mapping (readback contract)
// ---------------------------------------------------------------------------

function asText(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`storage: expected string for ${field}`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new TypeError(`storage: expected integer for ${field}`);
  }
  return value;
}

function mapDigestRow(row: Record<string, unknown>): EventDigestRecord {
  return {
    id: asText(row.id, 'memory_events_digest.id'),
    event_id: asText(row.event_id, 'memory_events_digest.event_id'),
    kind: asText(row.kind, 'memory_events_digest.kind'),
    runtime: asText(row.runtime, 'memory_events_digest.runtime'),
    adapter_version: asText(row.adapter_version, 'memory_events_digest.adapter_version'),
    project_id: row.project_id === null ? null : asText(row.project_id, 'memory_events_digest.project_id'),
    session_id: row.session_id === null ? null : asText(row.session_id, 'memory_events_digest.session_id'),
    agent_id: row.agent_id === null ? null : asText(row.agent_id, 'memory_events_digest.agent_id'),
    user_id: row.user_id === null ? null : asText(row.user_id, 'memory_events_digest.user_id'),
    content_hash: asText(row.content_hash, 'memory_events_digest.content_hash'),
    occurred_at: toIso(row.occurred_at),
    ingested_at: toIso(row.ingested_at),
    summary: asText(row.summary, 'memory_events_digest.summary'),
    payload_bytes: asNumber(row.payload_bytes, 'memory_events_digest.payload_bytes'),
    redactions_count: asNumber(row.redactions_count, 'memory_events_digest.redactions_count'),
    source_ids: ((): string[] => {
      const value = row.source_ids;
      if (value === null || value === undefined) return [];
      if (!Array.isArray(value)) {
        throw new TypeError('storage: expected array for memory_events_digest.source_ids');
      }
      return value.map((entry) => String(entry));
    })(),
    created_at: toIso(row.created_at),
  };
}

// ---------------------------------------------------------------------------
// The port binding
// ---------------------------------------------------------------------------

/** Build the core `EventsCompactor` port over a Database (embedded or server — same code). */
export function createEventsCompactor(db: Database): EventsCompactor {
  return {
    listCompactableEvents: (options) => listCompactableEvents(db, options),
    digestedEventIds: (eventIds) => digestedEventIds(db, eventIds),
    sourcesForEvents: (eventIds) => sourcesForEvents(db, eventIds),
    applyCompaction: (batch) => applyCompaction(db, batch),
    countRawEvents: (scope) => countRawEvents(db, scope),
    getEventDigest: (eventId) => getEventDigest(db, eventId),
  };
}
