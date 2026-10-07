/**
 * Raw event log (INGEST, stage 2): append-only, deduped by (project_id, kind, content_hash),
 * redactions passthrough. Ingest must never throw on duplicates and never block the agent.
 */

import { OnememoryEventSchema } from '@onememory-ai/core';
import type { EventIngestResult, OnememoryEvent, StoredEvent } from '@onememory-ai/core';

import type { Database } from '../drivers/client';
import { isUniqueViolation } from '../drivers/client';

import { mapEventRow } from './row-mappers';
import { ValidationError, parseInput } from './util';

export async function ingestEvent(
  db: Database,
  event: OnememoryEvent,
): Promise<EventIngestResult> {
  // Boundary enforcement: the event must be a validated canonical envelope.
  const parsed = OnememoryEventSchema.safeParse(event);
  if (!parsed.success) {
    throw new ValidationError('ingestEvent', parsed.error.issues);
  }
  const value = parsed.data;
  const projectId = value.scope.project_id ?? null;

  const duplicate = await db.query<{ id: string }>(
    `SELECT id FROM events
      WHERE project_id IS NOT DISTINCT FROM $1::uuid AND kind = $2 AND content_hash = $3
      LIMIT 1`,
    [projectId, value.kind, value.content_hash],
  );
  const existing = duplicate.rows[0];
  if (existing) {
    return { status: 'duplicate', event_id: existing.id, duplicate_of: existing.id };
  }

  try {
    await db.query(
      `INSERT INTO events (
          id, kind, runtime, adapter_version, project_id, session_id, agent_id, user_id,
          payload, content_hash, redactions, occurred_at, ingested_at
        ) VALUES (
          $1::uuid, $2, $3, $4, $5::uuid, $6, $7, $8::uuid,
          $9::jsonb, $10, $11::jsonb, $12::timestamptz, $13::timestamptz
        )`,
      [
        value.id,
        value.kind,
        value.source.runtime,
        value.source.adapter_version,
        projectId,
        value.scope.session_id ?? null,
        value.scope.agent_id ?? null,
        value.scope.user_id ?? null,
        JSON.stringify(value.payload),
        value.content_hash,
        JSON.stringify(value.redactions),
        value.occurred_at,
        value.ingested_at,
      ],
    );
    return { status: 'stored', event_id: value.id };
  } catch (error) {
    if (isUniqueViolation(error)) {
      const raced = await db.query<{ id: string }>(
        `SELECT id FROM events
          WHERE project_id IS NOT DISTINCT FROM $1::uuid AND kind = $2 AND content_hash = $3
          LIMIT 1`,
        [projectId, value.kind, value.content_hash],
      );
      const winner = raced.rows[0];
      if (winner) {
        return { status: 'duplicate', event_id: winner.id, duplicate_of: winner.id };
      }
    }
    throw error;
  }
}

export async function listPendingEvents(db: Database, limit: number): Promise<StoredEvent[]> {
  const result = await db.query(
    `SELECT * FROM events WHERE processed_at IS NULL ORDER BY occurred_at ASC LIMIT $1`,
    [Math.max(1, Math.floor(limit))],
  );
  return result.rows.map(mapEventRow);
}

export async function markEventProcessed(
  db: Database,
  id: string,
  options?: { process_error?: string; needs_review?: boolean },
): Promise<void> {
  const result = await db.query(
    `UPDATE events
        SET processed_at = now(),
            process_error = $2,
            needs_review = coalesce($3::boolean, needs_review)
      WHERE id = $1::uuid`,
    [id, options?.process_error ?? null, options?.needs_review ?? null],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new ValidationError('markEventProcessed', [
      { code: 'custom', path: ['id'], message: `event ${id} not found` },
    ]);
  }
}

export { parseInput };
