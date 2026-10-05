/**
 * Sessions and working memory (the TTL scratchpad, spec §23): insert, promote
 * (`promoted_memory_id`), and sweep — expired unpromoted rows are purged; promoted rows are
 * preserved by the partial index predicate (database-schema.md §2). Deletion is allowed here only.
 */

import { NewSessionSchema, NewWorkingMemorySchema, uuidv7 } from '@onememory/core';
import type {
  NewSession,
  NewWorkingMemory,
  SessionRecord,
  WorkingMemoryRecord,
  WorkingSweepResult,
} from '@onememory/core';

import type { Database } from '../drivers/client';

import { mapSessionRow, mapWorkingRow } from './row-mappers';
import { parseInput } from './util';

export async function createSession(db: Database, rawInput: NewSession): Promise<SessionRecord> {
  const input = parseInput(NewSessionSchema, rawInput, 'createSession');
  const result = await db.query(
    `INSERT INTO sessions (id, project_id, agent_id, runtime, started_at, ended_at, summary, stats)
       VALUES ($1, $2::uuid, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8::jsonb)
       ON CONFLICT (id) DO UPDATE
         -- An upsert may refine the recorded end (newest non-null wins) but never erase it: the
         -- async extraction path re-upserts sessions without the end fields (mission-14a follow-up 2).
         SET ended_at = coalesce(EXCLUDED.ended_at, sessions.ended_at),
             summary = coalesce(EXCLUDED.summary, sessions.summary),
             stats = EXCLUDED.stats,
             project_id = EXCLUDED.project_id
       RETURNING *`,
    [
      input.id,
      input.project_id ?? null,
      input.agent_id ?? null,
      input.runtime,
      input.started_at,
      input.ended_at ?? null,
      input.summary ?? null,
      JSON.stringify(input.stats ?? {}),
    ],
  );
  return mapSessionRow(result.rows[0]!);
}

export async function insertWorking(
  db: Database,
  rawInput: NewWorkingMemory,
): Promise<WorkingMemoryRecord> {
  const input = parseInput(NewWorkingMemorySchema, rawInput, 'insertWorking');
  const result = await db.query(
    `INSERT INTO working_memory (
        id, session_id, kind, content, importance, confidence, source_id, evidence, expires_at
      ) VALUES (
        $1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8::jsonb, $9::timestamptz
      )
      RETURNING *`,
    [
      input.id ?? uuidv7(),
      input.session_id,
      input.kind,
      input.content,
      input.importance ?? 0.3,
      input.confidence ?? 0.4,
      input.source_id ?? null,
      JSON.stringify(input.evidence ?? []),
      input.expires_at,
    ],
  );
  return mapWorkingRow(result.rows[0]!);
}

export async function markWorkingPromoted(
  db: Database,
  id: string,
  memoryId: string,
): Promise<void> {
  const result = await db.query(
    'UPDATE working_memory SET promoted_memory_id = $2::uuid WHERE id = $1::uuid',
    [id, memoryId],
  );
  if ((result.rowCount ?? 0) === 0) {
    throw new Error(`markWorkingPromoted: working memory ${id} not found`);
  }
}

/**
 * Session-end sweep: purge rows whose TTL expired and that were never promoted. Promoted rows
 * survive (they became durable memories with provenance).
 */
export async function sweepWorking(db: Database, now?: string): Promise<WorkingSweepResult> {
  const result = await db.query(
    `DELETE FROM working_memory
      WHERE expires_at <= coalesce($1::timestamptz, now())
        AND promoted_memory_id IS NULL
      RETURNING id`,
    [now ?? null],
  );
  return { purged: result.rows.length };
}

export async function listWorking(db: Database, sessionId: string): Promise<WorkingMemoryRecord[]> {
  const result = await db.query(
    'SELECT * FROM working_memory WHERE session_id = $1 ORDER BY created_at ASC',
    [sessionId],
  );
  return result.rows.map(mapWorkingRow);
}
