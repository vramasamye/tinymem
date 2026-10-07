/**
 * Append-only audit trail (`memory_events`). Every memory status transition MUST land here in the
 * same transaction as the change (called by the memories repository).
 */

import { NewMemoryEventSchema, uuidv7 } from '@onememory-ai/core';
import type { MemoryEventAuditDraft, MemoryEventRecord, NewMemoryEvent } from '@onememory-ai/core';

import type { Database } from '../drivers/client';

import { mapMemoryEventRow } from './row-mappers';
import { parseInput } from './util';

/** Input accepted by {@link appendMemoryEvent}: the port schema or the model's audit draft. */
export type NewMemoryEventInput = NewMemoryEvent | MemoryEventAuditDraft;

export async function appendMemoryEvent(
  db: Database,
  rawEntry: NewMemoryEventInput,
): Promise<MemoryEventRecord> {
  const entry = parseInput(NewMemoryEventSchema, rawEntry, 'appendMemoryEvent');
  const result = await db.query(
    `INSERT INTO memory_events (id, memory_id, action, from_status, to_status, actor, details, at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::timestamptz)
       RETURNING *`,
    [
      entry.id ?? uuidv7(),
      entry.memory_id,
      entry.action,
      entry.from_status ?? null,
      entry.to_status ?? null,
      entry.actor,
      JSON.stringify(entry.details ?? {}),
      entry.at ?? new Date().toISOString(),
    ],
  );
  return mapMemoryEventRow(result.rows[0]!);
}

export async function listMemoryEvents(
  db: Database,
  memoryId: string,
): Promise<MemoryEventRecord[]> {
  const result = await db.query(
    'SELECT * FROM memory_events WHERE memory_id = $1::uuid ORDER BY at DESC',
    [memoryId],
  );
  return result.rows.map(mapMemoryEventRow);
}
