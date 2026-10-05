/**
 * Memories repository — the STORE/RETRIEVE stages over the canonical `memories` table.
 *
 * Invariants enforced here:
 * - exact-dedupe via the `(coalesce(project), coalesce(user), type, content_hash)` unique index —
 *   the probe runs before every insert and the conflict race fallback re-probes;
 * - every status change validates against the core transition machine and appends a `memory_events`
 *   audit row inside the same transaction;
 * - supersession is ONE transaction: winner insert + loser (status/valid_until/superseded_by) +
 *   audit rows for both.
 */

import {
  DeleteMemoryOptionsSchema,
  NewMemorySchema,
  MemoryQuerySchema,
  StatusChangeOptionsSchema,
  SupersedeInputSchema,
  assertTransition,
  creationAudit,
  memoryContentHash,
  transition,
  uuidv7,
} from '@onememory/core';
import type {
  DeleteMemoryOptions,
  DurableMemoryType,
  MemoryDeleteResult,
  MemoryQuery,
  MemoryRecord,
  MemoryStatus,
  MemoryWriteResult,
  NewMemory,
  SourceRef,
  StatusChangeOptions,
  SupersedeResult,
} from '@onememory/core';

import type { Database, QueryResult } from '../drivers/client';
import { pgTextArray, pgUuidArray, toIso } from '../drivers/client';

import { appendMemoryEvent } from './memory-events';
import { insertPayload, payloadsForMemories } from './payloads';
import { mapMemoryRow, type MemoryJoinRow } from './row-mappers';
import { NotFoundError, parseInput } from './util';

const NIL = '00000000-0000-0000-0000-000000000000';
const DEFAULT_QUERY_LIMIT = 100;
const HISTORY_MAX_DEPTH = 100;

const MEMORY_SELECT = `
  SELECT m.id, m.type, m.subtype, m.title, m.content, m.content_summary, m.status,
         m.importance, m.confidence, m.access_count, m.last_accessed_at, m.observed_at,
         m.valid_from, m.valid_until, m.created_at, m.updated_at, m.superseded_by,
         m.project_id, m.user_id, m.agent_id, m.source_id, m.evidence, m.extraction,
         m.tags, m.token_estimate,
         s.kind AS source_kind, s.uri AS source_uri, s.title AS source_title
  FROM memories m
  JOIN sources s ON s.id = m.source_id
`;

interface QueryFilterPlan {
  clauses: string[];
  params: unknown[];
}

/** Build the optional scope/type filters shared by queryCurrent and queryAsOf. */
function planFilters(query: MemoryQuery, startIndex: number): QueryFilterPlan {
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;
  if (query.project_id !== undefined) {
    clauses.push(`m.project_id IS NOT DISTINCT FROM $${i}::uuid`);
    params.push(query.project_id);
    i += 1;
  }
  if (query.user_id !== undefined) {
    clauses.push(`m.user_id IS NOT DISTINCT FROM $${i}::uuid`);
    params.push(query.user_id);
    i += 1;
  }
  if (query.types !== undefined && query.types.length > 0) {
    clauses.push(`m.type = ANY($${i}::text[])`);
    params.push(pgTextArray(query.types));
    i += 1;
  }
  return { clauses, params };
}

/** Batch-load entity bindings for a set of memories (avoids N+1). */
async function entitiesForMemories(
  db: Database,
  memoryIds: readonly string[],
): Promise<Map<string, MemoryRecord['entities']>> {
  const map = new Map<string, MemoryRecord['entities']>();
  for (const id of memoryIds) map.set(id, []);
  if (memoryIds.length === 0) return map;
  const result = await db.query<{
    memory_id: string;
    id: string;
    name: string;
    kind: string;
  }>(
    `SELECT me.memory_id, e.id, e.name, e.kind
       FROM memory_entities me
       JOIN entities e ON e.id = me.entity_id
      WHERE me.memory_id = ANY($1::uuid[])
      ORDER BY me.created_at ASC`,
    [pgUuidArray(memoryIds)],
  );
  for (const row of result.rows) {
    const list = map.get(row.memory_id);
    if (list) list.push({ id: row.id, name: row.name, kind: row.kind });
  }
  return map;
}

async function mapMemoryRows(
  db: Database,
  rows: readonly MemoryJoinRow[],
): Promise<MemoryRecord[]> {
  const entityMap = await entitiesForMemories(db, rows.map((row) => String(row.id)));
  const payloadMap = await payloadsForMemories(db, rows);
  return rows.map((row) => mapMemoryRow(
    row, entityMap.get(String(row.id)) ?? [], payloadMap.get(String(row.id)),
  ));
}

// ---------------------------------------------------------------------------
// Dedupe probe (stage 6)
// ---------------------------------------------------------------------------

export async function findDuplicate(
  db: Database,
  scope: { project_id?: string | null; user_id?: string | null },
  type: DurableMemoryType,
  contentHash: string,
): Promise<MemoryRecord | null> {
  const result = await db.query<MemoryJoinRow>(
    `${MEMORY_SELECT}
      WHERE coalesce(m.project_id, '${NIL}'::uuid) = coalesce($1::uuid, '${NIL}'::uuid)
        AND coalesce(m.user_id, '${NIL}'::uuid) = coalesce($2::uuid, '${NIL}'::uuid)
        AND m.type = $3
        AND m.content_hash = $4
      LIMIT 1`,
    [scope.project_id ?? null, scope.user_id ?? null, type, contentHash],
  );
  const records = await mapMemoryRows(db, result.rows);
  return records[0] ?? null;
}

// ---------------------------------------------------------------------------
// Insert (stage 9) — dedupe probe + insert + creation audit, one transaction
// ---------------------------------------------------------------------------

export async function insertMemory(db: Database, candidate: NewMemory): Promise<MemoryWriteResult> {
  const input = parseInput(NewMemorySchema, candidate, 'insertMemory');
  const contentHash = memoryContentHash(input.content);
  const scope = { project_id: input.project_id ?? null, user_id: input.user_id ?? null };

  return db.transaction(async (tx) => {
    const existing = await findDuplicate(tx, scope, input.type, contentHash);
    if (existing) return { outcome: 'duplicate' as const, memory: existing, existing };

    const id = input.id ?? uuidv7();
    const status: MemoryStatus = input.status ?? 'active';
    const inserted = await tx.query(
        `INSERT INTO memories (
            id, type, subtype, title, content, content_summary, content_hash, status,
            importance, confidence, observed_at, valid_from, valid_until,
            project_id, user_id, agent_id, source_id, evidence, extraction, tags, token_estimate
          ) VALUES (
            $1::uuid, $2, $3, $4, $5, $6, $7, $8,
            $9, $10, $11::timestamptz, $12::timestamptz, $13::timestamptz,
            $14::uuid, $15::uuid, $16, $17::uuid, $18::jsonb, $19::jsonb, $20::text[], $21
          ) ON CONFLICT (
            (coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)),
            (coalesce(user_id, '00000000-0000-0000-0000-000000000000'::uuid)),
            type, content_hash
          ) DO NOTHING RETURNING id`,
        [
          id,
          input.type,
          input.subtype ?? null,
          input.title ?? null,
          input.content,
          input.content_summary ?? null,
          contentHash,
          status,
          input.importance,
          input.confidence,
          input.observed_at,
          input.valid_from ?? input.observed_at,
          input.valid_until ?? null,
          input.project_id ?? null,
          input.user_id ?? null,
          input.agent_id ?? null,
          input.source_id,
          JSON.stringify(input.evidence),
          JSON.stringify(input.extraction),
          pgTextArray(input.tags ?? []),
          input.token_estimate ?? 0,
        ],
      );
    if (inserted.rows.length === 0) {
      // DO NOTHING keeps a raced server transaction usable (23505 would abort it).
      const raced = await findDuplicate(tx, scope, input.type, contentHash);
      if (raced) return { outcome: 'duplicate' as const, memory: raced, existing: raced };
      throw new Error('storage: dedupe conflict winner disappeared');
    }

    await insertPayload(tx, id, input);
    const actor = input.agent_id !== undefined ? `agent:${input.agent_id}` : 'system';
    await appendMemoryEvent(
      tx,
      creationAudit(id, status, actor, undefined, { source_id: input.source_id }),
    );
    const memory = await getMemory(tx, id);
    if (!memory) throw new NotFoundError('memory', id);
    return { outcome: 'inserted' as const, memory };
  });
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getMemory(db: Database, id: string): Promise<MemoryRecord | null> {
  const result = await db.query<MemoryJoinRow>(`${MEMORY_SELECT} WHERE m.id = $1::uuid LIMIT 1`, [id]);
  const records = await mapMemoryRows(db, result.rows);
  return records[0] ?? null;
}

export async function queryCurrent(db: Database, query: MemoryQuery): Promise<MemoryRecord[]> {
  const input = parseInput(MemoryQuerySchema, query, 'queryCurrent');
  const filters = planFilters(input, 1);
  const limit = input.limit ?? DEFAULT_QUERY_LIMIT;
  const where = ["m.status IN ('active','stale')", 'm.valid_until IS NULL', ...filters.clauses];
  const result = await db.query<MemoryJoinRow>(
    `${MEMORY_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY m.observed_at DESC, m.id DESC
      LIMIT $${filters.params.length + 1}`,
    [...filters.params, limit],
  );
  return mapMemoryRows(db, result.rows);
}

export async function queryAsOf(db: Database, at: string, query: MemoryQuery): Promise<MemoryRecord[]> {
  const input = parseInput(MemoryQuerySchema, query, 'queryAsOf');
  // $1 = `at`; scope/type filters start at $2.
  const filters = planFilters(input, 2);
  const limit = input.limit ?? DEFAULT_QUERY_LIMIT;
  // Point-in-time: window match; superseded retained; disputed excluded (memory-model.md §5).
  const where = [
    'm.valid_from <= $1::timestamptz',
    '(m.valid_until IS NULL OR m.valid_until > $1::timestamptz)',
    "m.status <> 'disputed'",
    ...filters.clauses,
  ];
  const result = await db.query<MemoryJoinRow>(
    `${MEMORY_SELECT}
      WHERE ${where.join(' AND ')}
      ORDER BY m.valid_from DESC, m.id DESC
      LIMIT $${filters.params.length + 2}`,
    [at, ...filters.params, limit],
  );
  return mapMemoryRows(db, result.rows);
}

/** The full supersession chain containing `memoryId` (oldest first). */
export async function historyOf(db: Database, memoryId: string): Promise<MemoryRecord[]> {
  // Climb to the tip of the superseded_by chain (with a cycle guard).
  let tip: string | null = null;
  let current: string | null = memoryId;
  const seen = new Set<string>();
  for (let hops = 0; hops < HISTORY_MAX_DEPTH && current !== null; hops++) {
    if (seen.has(current)) throw new Error(`storage: superseded_by cycle at ${current}`);
    seen.add(current);
    // Explicit annotations break a control-flow inference cycle (current ← memory ← row).
    const row: QueryResult<{ id: string; superseded_by: string | null }> = await db.query(
      'SELECT id, superseded_by FROM memories WHERE id = $1::uuid',
      [current],
    );
    const memory: { id: string; superseded_by: string | null } | undefined = row.rows[0];
    if (!memory) {
      if (hops === 0) throw new NotFoundError('memory', memoryId);
      break;
    }
    tip = memory.id;
    current = memory.superseded_by;
  }
  if (!tip) throw new NotFoundError('memory', memoryId);

  // Depth-bounded recursive CTE collects the whole chain below the tip.
  const result = await db.query<MemoryJoinRow>(
    `WITH RECURSIVE chain AS (
        SELECT id, 0 AS depth FROM memories WHERE id = $1::uuid
        UNION ALL
        SELECT m.id, c.depth + 1
          FROM memories m JOIN chain c ON m.superseded_by = c.id
         WHERE c.depth < ${HISTORY_MAX_DEPTH}
      )
      ${MEMORY_SELECT}
      WHERE m.id IN (SELECT id FROM chain)
      ORDER BY m.valid_from ASC, m.observed_at ASC, m.id ASC`,
    [tip],
  );
  return mapMemoryRows(db, result.rows);
}

// ---------------------------------------------------------------------------
// Status transitions (audited) and supersession
// ---------------------------------------------------------------------------

interface MemoryStatusRow {
  id: string;
  status: MemoryStatus;
  valid_from: string | Date;
}
type MemoryStatusRowLike = MemoryStatusRow & Record<string, unknown>;

export async function updateMemoryStatus(
  db: Database,
  id: string,
  to: MemoryStatus,
  rawOptions: StatusChangeOptions,
): Promise<MemoryRecord> {
  const options = parseInput(StatusChangeOptionsSchema, rawOptions, 'updateMemoryStatus');
  return db.transaction(async (tx) => {
    const locked = await tx.query<MemoryStatusRowLike>(
      'SELECT id, status, valid_from FROM memories WHERE id = $1::uuid FOR UPDATE',
      [id],
    );
    const current = locked.rows[0];
    if (!current) throw new NotFoundError('memory', id);

    assertTransition(current.status, to);
    const { audit } = transition({
      memoryId: id,
      from: current.status,
      to,
      actor: options.actor,
      reason: options.reason,
      details: options.details,
    });

    await tx.query(
      `UPDATE memories
          SET status = $2,
              valid_until = coalesce($3::timestamptz, valid_until),
              superseded_by = coalesce($4::uuid, superseded_by),
              updated_at = now()
        WHERE id = $1::uuid`,
      [id, to, options.valid_until ?? null, options.superseded_by_id ?? null],
    );
    await appendMemoryEvent(tx, {
      id: uuidv7(),
      memory_id: audit.memory_id,
      action: audit.action,
      from_status: audit.from_status,
      to_status: audit.to_status,
      actor: audit.actor,
      details: audit.details,
      at: audit.at,
    });
    const updated = await getMemory(tx, id);
    if (!updated) throw new NotFoundError('memory', id);
    return updated;
  });
}

export async function supersede(db: Database, rawInput: {
  winner: NewMemory;
  loser_id: string;
  actor: string;
  reason?: string;
}): Promise<SupersedeResult> {
  const input = parseInput(SupersedeInputSchema, rawInput, 'supersede');
  return db.transaction(async (tx) => {
    const contentHash = memoryContentHash(input.winner.content);
    const existing = await findDuplicate(
      tx,
      { project_id: input.winner.project_id ?? null, user_id: input.winner.user_id ?? null },
      input.winner.type,
      contentHash,
    );
    if (existing) {
      return { outcome: 'winner-duplicate' as const, winner: existing, existing };
    }

    const locked = await tx.query<MemoryStatusRowLike & { observed_at: string | Date }>(
      'SELECT id, status, valid_from, observed_at FROM memories WHERE id = $1::uuid FOR UPDATE',
      [input.loser_id],
    );
    const loser = locked.rows[0];
    if (!loser) throw new NotFoundError('memory', input.loser_id);

    const winnerObservedAt = input.winner.observed_at;
    if (new Date(toIso(loser.valid_from)).getTime() >= new Date(winnerObservedAt).getTime()) {
      throw new Error(
        `supersede: winner observed_at (${winnerObservedAt}) must be after the loser's valid_from (${toIso(loser.valid_from)})`,
      );
    }
    assertTransition(loser.status, 'superseded');

    // Winner insert (status forced active per the supersession procedure, memory-model.md §5).
    const inserted = await insertMemory(tx, { ...input.winner, status: 'active' });
    if (inserted.outcome !== 'inserted') {
      // Re-probed duplicate inside this transaction — report it, change nothing.
      return {
        outcome: 'winner-duplicate' as const,
        winner: inserted.existing ?? inserted.memory,
        existing: inserted.existing ?? inserted.memory,
      };
    }
    const winner = inserted.memory;

    // Loser: status=superseded, valid_until=winner.observed_at, superseded_by=winner.id.
    const loserTransition = transition({
      memoryId: input.loser_id,
      from: loser.status,
      to: 'superseded',
      actor: input.actor,
      reason: input.reason,
      details: { superseded_by: winner.id },
    });
    await tx.query(
      `UPDATE memories
          SET status = 'superseded',
              valid_until = $2::timestamptz,
              superseded_by = $3::uuid,
              updated_at = now()
        WHERE id = $1::uuid`,
      [input.loser_id, winnerObservedAt, winner.id],
    );
    await appendMemoryEvent(tx, {
      id: uuidv7(),
      memory_id: loserTransition.audit.memory_id,
      action: loserTransition.audit.action,
      from_status: loserTransition.audit.from_status,
      to_status: loserTransition.audit.to_status,
      actor: loserTransition.audit.actor,
      details: loserTransition.audit.details,
      at: loserTransition.audit.at,
    });

    const loserRecord = await getMemory(tx, input.loser_id);
    if (!loserRecord) throw new NotFoundError('memory', input.loser_id);
    return { outcome: 'superseded' as const, winner, loser: loserRecord };
  });
}

/**
 * Hard purge — the destructive counterpart of a forget tombstone. Deletes the memories row in
 * ONE transaction: vectors, entity bindings, edges, decisions/failures/code-ref rows cascade
 * (schema `ON DELETE CASCADE`); the two NON-cascading references are cleared first so FKs never
 * block the purge (losers of a supersession lose their forward pointer; promoted working rows
 * are un-linked — their content survives and TTL sweeps resume). The 'purged' audit row is
 * appended after the delete in the same transaction: `memory_events` is FK-less by design, so
 * the trail survives the purge. Returns null when the id is unknown.
 */
export async function deleteMemory(
  db: Database,
  id: string,
  rawOptions: DeleteMemoryOptions,
): Promise<MemoryDeleteResult | null> {
  const options = parseInput(DeleteMemoryOptionsSchema, rawOptions, 'deleteMemory');
  return db.transaction(async (tx) => {
    const locked = await tx.query<{ id: string; status: MemoryStatus } & Record<string, unknown>>(
      'SELECT id, status FROM memories WHERE id = $1::uuid FOR UPDATE',
      [id],
    );
    const current = locked.rows[0];
    if (!current) return null;
    const memory = await getMemory(tx, id);
    if (!memory) throw new NotFoundError('memory', id);

    // RETURNING keeps the counts portable across the PGlite and node-postgres drivers.
    const clearedSupersededBy = await tx.query<{ id: string }>(
      'UPDATE memories SET superseded_by = NULL, updated_at = now() WHERE superseded_by = $1::uuid RETURNING id',
      [id],
    );
    const clearedPromotions = await tx.query<{ id: string }>(
      'UPDATE working_memory SET promoted_memory_id = NULL WHERE promoted_memory_id = $1::uuid RETURNING id',
      [id],
    );

    await tx.query('DELETE FROM memories WHERE id = $1::uuid', [id]);

    const audit = await appendMemoryEvent(tx, {
      memory_id: id,
      action: 'purged',
      from_status: current.status,
      to_status: null,
      actor: options.actor,
      details: {
        ...options.details,
        reason: options.reason,
        cleared_superseded_by: clearedSupersededBy.rows.length,
        cleared_promoted_links: clearedPromotions.rows.length,
      },
    });
    return { purged: true as const, memory, audit };
  });
}

/** Stage 11 REINFORCE: bump access_count + last_accessed_at (fire-and-forget, not audited). */
export async function reinforce(db: Database, memoryIds: readonly string[], at?: string): Promise<void> {
  if (memoryIds.length === 0) return;
  await db.query(
    `UPDATE memories
        SET access_count = access_count + 1,
            last_accessed_at = coalesce($2::timestamptz, now())
      WHERE id = ANY($1::uuid[])`,
    [pgUuidArray(memoryIds), at ?? null],
  );
}

export type { SourceRef };
