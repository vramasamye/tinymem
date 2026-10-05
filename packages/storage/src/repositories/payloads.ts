/**
 * Memory-keyed payload rows. Writes run on the caller's memory/audit transaction; reads are
 * batched per type, never per memory. No retry updates, recurrence counting or legacy backfill.
 */
import {
  DecisionPayloadSchema,
  DecisionStorePayloadSchema,
  FailurePayloadSchema,
  FailureStorePayloadSchema,
  type MemoryRecord,
  type NewMemory,
} from '@onememory/core';

import type { Database } from '../drivers/client';
import { pgTextArray, pgUuidArray, toIso } from '../drivers/client';
import type { MemoryJoinRow } from './row-mappers';

export async function insertPayload(db: Database, id: string, memory: NewMemory): Promise<void> {
  if (memory.payload === undefined) return;
  if (memory.type === 'decision') {
    const p = DecisionStorePayloadSchema.parse(memory.payload);
    await db.query(
      `INSERT INTO decisions
        (memory_id, title, decision, alternatives, rationale, participants, decided_at, status)
       VALUES ($1::uuid, $2, $3, $4::jsonb, $5, $6::text[], $7::timestamptz, $8)`,
      [id, p.title, p.decision, JSON.stringify(p.alternatives), p.rationale ?? null,
        pgTextArray(p.participants), p.decided_at, p.status],
    );
  } else if (memory.type === 'failure') {
    const p = FailureStorePayloadSchema.parse(memory.payload);
    await db.query(
      `INSERT INTO failures
        (memory_id, problem, context, root_cause, solution, verification, status, signature_hash,
         first_seen_at, last_seen_at, occurrence_count)
       VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10::timestamptz, $11)`,
      [id, p.problem, p.context, p.root_cause ?? null, p.solution ?? null,
        p.verification ?? null, p.status, p.signature_hash, p.first_seen_at,
        p.last_seen_at, p.occurrence_count],
    );
  }
}

export async function payloadsForMemories(
  db: Database,
  rows: readonly MemoryJoinRow[],
): Promise<Map<string, MemoryRecord['payload']>> {
  const payloads = new Map<string, MemoryRecord['payload']>();
  const decisions = rows.filter((row) => row.type === 'decision');
  const failures = rows.filter((row) => row.type === 'failure');
  if (decisions.length > 0) {
    const evidence = new Map(decisions.map((row) => [String(row.id), row.evidence]));
    const result = await db.query(
      'SELECT * FROM decisions WHERE memory_id = ANY($1::uuid[])',
      [pgUuidArray(decisions.map((row) => String(row.id)))],
    );
    for (const row of result.rows) {
      payloads.set(String(row.memory_id), DecisionPayloadSchema.parse({
        title: row.title,
        decision: row.decision,
        alternatives: row.alternatives,
        ...(row.rationale === null ? {} : { rationale: row.rationale }),
        participants: row.participants,
        decided_at: toIso(row.decided_at),
        status: row.status,
        evidence: evidence.get(String(row.memory_id)),
      }));
    }
  }
  if (failures.length > 0) {
    const result = await db.query(
      'SELECT * FROM failures WHERE memory_id = ANY($1::uuid[])',
      [pgUuidArray(failures.map((row) => String(row.id)))],
    );
    for (const row of result.rows) {
      payloads.set(String(row.memory_id), FailurePayloadSchema.parse({
        problem: row.problem,
        context: row.context,
        ...(row.root_cause === null ? {} : { root_cause: row.root_cause }),
        ...(row.solution === null ? {} : { solution: row.solution }),
        ...(row.verification === null ? {} : { verification: row.verification }),
        status: row.status,
        signature_hash: row.signature_hash,
        first_seen_at: toIso(row.first_seen_at),
        last_seen_at: toIso(row.last_seen_at),
        occurrence_count: row.occurrence_count,
      }));
    }
  }
  return payloads;
}
