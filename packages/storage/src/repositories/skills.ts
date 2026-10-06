/**
 * Skills repository (M15 — backlog "Skill generation"): the `SkillStore` port implementation
 * over the M2-landed `skills` table (database-schema.md §2). NO schema change rides on M15 —
 * the table, its status vocabulary (`candidate|verified|promoted|deprecated`) and the
 * usage-count columns predate this mission; this file is the first code that touches them.
 *
 * Discipline copied from the M14.6 events-compaction repo:
 *   - every mutation is ONE transaction that also appends the `memory_events` audit row
 *     (provenance rule, AGENTS.md rule 8) — the same append-only audit path every memory
 *     transition uses. `memory_id` carries the skill's id; the table is FK-less by design.
 *     The skill-status transition rides `details` because `from_status`/`to_status` are
 *     memory-status enums (`NewMemoryEventSchema`).
 *   - status updates are GUARDED (`WHERE id = … AND status = <expected>`), so a second
 *     promoter can never double-flip a row it already moved on from.
 *   - the transition machine itself is core's (`assertSkillTransition`) — validated before any
 *     SQL runs, never re-derived here.
 */

import {
  NewSkillSchema,
  SkillRecordSchema,
  assertSkillTransition,
  uuidv7,
  type EvidenceSpan,
  type FailureRecurrence,
  type NewSkill,
  type SkillRecord,
  type SkillStatus,
  type SkillStore,
  type SkillUsageEvent,
} from '@onememory/core';

import type { Database } from '../drivers/client';
import { pgTextArray, pgUuidArray, toIso } from '../drivers/client';

import { entitiesForMemories, planFilter, type CandidateFilter } from './search';
import { mapMemoryRow, type MemoryJoinRow } from './row-mappers';
import { NotFoundError, parseInput } from './util';

// ---------------------------------------------------------------------------
// Row mapping (the read-back contract — Zod at the storage boundary)
// ---------------------------------------------------------------------------

function asSkillStatuses(statuses: readonly SkillStatus[] | undefined): readonly SkillStatus[] {
  return statuses === undefined || statuses.length === 0
    ? ['candidate', 'verified', 'promoted', 'deprecated']
    : statuses;
}

function mapSkillRow(row: Record<string, unknown>): SkillRecord {
  return SkillRecordSchema.parse({
    id: row.id,
    ...(row.project_id === null || row.project_id === undefined ? {} : { project_id: row.project_id }),
    name: row.name,
    description: row.description,
    version: row.version,
    status: row.status,
    source: row.source,
    verification: row.verification,
    path: row.path,
    usage_count: row.usage_count,
    ...(row.success_rate === null || row.success_rate === undefined ? {} : { success_rate: row.success_rate }),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  });
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * The recurrence pool: current failure rows joined to their memories (entity bindings + evidence
 * hydrated), every payload column the generation gate reads, ordered by signature then recency
 * so the matcher groups deterministically. The current-window filter is the retrieval policy's
 * own `planFilter` (statuses active/stale at a point in time) — never re-derived here.
 */
export async function listFailureRecurrences(
  db: Database,
  options: { scope?: { project_id?: string }; limit: number; now?: string },
): Promise<FailureRecurrence[]> {
  const at = options.now ?? new Date().toISOString();
  const filter: CandidateFilter = {
    statuses: ['active', 'stale'],
    window: { kind: 'point', at },
    ...(options.scope?.project_id === undefined ? {} : { projectId: options.scope.project_id }),
  };
  const plan = planFilter(filter, 1);
  const limitIndex = 1 + plan.params.length;
  const result = await db.query<
    MemoryJoinRow & {
      problem: string;
      context: string;
      root_cause: string | null;
      solution: string | null;
      verification: string | null;
      failure_status: string;
      signature_hash: string;
      first_seen_at: string | Date;
      last_seen_at: string | Date;
      occurrence_count: number;
    }
  >(
    `SELECT m.id, m.type, m.subtype, m.title, m.content, m.content_summary, m.status,
            m.importance, m.confidence, m.access_count, m.last_accessed_at, m.observed_at,
            m.valid_from, m.valid_until, m.created_at, m.updated_at, m.superseded_by,
            m.project_id, m.user_id, m.agent_id, m.source_id, m.evidence, m.extraction,
            m.tags, m.token_estimate,
            s.kind AS source_kind, s.uri AS source_uri, s.title AS source_title,
            f.problem, f.context, f.root_cause, f.solution, f.verification,
            f.status AS failure_status, f.signature_hash,
            f.first_seen_at, f.last_seen_at, f.occurrence_count
       FROM failures f
       JOIN memories m ON m.id = f.memory_id
       JOIN sources s ON s.id = m.source_id
      WHERE ${plan.clauses.join(' AND ')}
      ORDER BY f.signature_hash ASC, f.last_seen_at ASC, m.id ASC
      LIMIT $${limitIndex}`,
    [...plan.params, Math.max(1, Math.floor(options.limit))],
  );
  const entityMap = await entitiesForMemories(db, result.rows.map((row) => String(row.id)));
  return result.rows.map((row) => ({
    memory: mapMemoryRow(row, entityMap.get(String(row.id)) ?? []),
    problem: row.problem,
    context: row.context,
    root_cause: row.root_cause,
    solution: row.solution,
    verification: row.verification,
    failure_status: row.failure_status,
    signature_hash: row.signature_hash,
    first_seen_at: row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : row.first_seen_at,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at,
    occurrence_count: row.occurrence_count,
  }));
}

export async function getSkill(db: Database, id: string): Promise<SkillRecord | null> {
  const result = await db.query('SELECT * FROM skills WHERE id = $1::uuid', [id]);
  const row = result.rows[0];
  return row === undefined ? null : mapSkillRow(row);
}

/** The idempotency probe: a skill with this name in this project, any status. */
export async function findSkillByName(
  db: Database,
  name: string,
  scope: { project_id?: string | null },
): Promise<SkillRecord | null> {
  const result = await db.query(
    `SELECT * FROM skills
      WHERE name = $1 AND project_id IS NOT DISTINCT FROM $2::uuid
      ORDER BY updated_at DESC
      LIMIT 1`,
    [name, scope.project_id ?? null],
  );
  const row = result.rows[0];
  return row === undefined ? null : mapSkillRow(row);
}

export async function listSkills(
  db: Database,
  options: { scope?: { project_id?: string | null }; statuses?: readonly SkillStatus[]; limit?: number },
): Promise<SkillRecord[]> {
  const statuses = asSkillStatuses(options.statuses);
  const params: unknown[] = [pgTextArray(statuses)];
  let sql = 'SELECT * FROM skills WHERE status = ANY($1::text[])';
  if (options.scope?.project_id !== undefined) {
    params.push(options.scope.project_id ?? null);
    sql += ` AND project_id IS NOT DISTINCT FROM $${params.length}::uuid`;
  }
  params.push(Math.max(1, Math.floor(options.limit ?? 100)));
  sql += ` ORDER BY updated_at DESC, id DESC LIMIT $${params.length}`;
  const result = await db.query(sql, params);
  return result.rows.map(mapSkillRow);
}

/** The usage hook's read side (AC5): newest captured session events — read-only, never writes. */
export async function listSessionEventsForUsage(
  db: Database,
  options: { scope?: { project_id?: string | null }; limit: number },
): Promise<SkillUsageEvent[]> {
  const params: unknown[] = [];
  let sql = 'SELECT id, kind, session_id, occurred_at, payload FROM events';
  if (options.scope?.project_id !== undefined) {
    params.push(options.scope.project_id ?? null);
    sql += ` WHERE project_id IS NOT DISTINCT FROM $${params.length}::uuid`;
  }
  params.push(Math.max(1, Math.floor(options.limit)));
  sql += ` ORDER BY occurred_at DESC, id DESC LIMIT $${params.length}`;
  const result = await db.query<{
    id: string;
    kind: string;
    session_id: string | null;
    occurred_at: string | Date;
    payload: unknown;
  }>(sql, params);
  return result.rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    session_id: row.session_id,
    occurred_at: row.occurred_at instanceof Date ? row.occurred_at.toISOString() : row.occurred_at,
    payload: row.payload,
  }));
}

// ---------------------------------------------------------------------------
// The audited mutations (one transaction each: the row + its memory_events audit entry)
// ---------------------------------------------------------------------------

/** Append the skill's audit row inside the caller's transaction (`memory_events` is FK-less). */
function skillAuditParams(
  entry: {
    skillId: string;
    action: 'created' | 'status_changed' | 'edited';
    actor: string;
    details: Record<string, unknown>;
  },
  at: string,
): { text: string; params: unknown[] } {
  return {
    text: `INSERT INTO memory_events (id, memory_id, action, from_status, to_status, actor, details, at)
             VALUES ($1::uuid, $2::uuid, $3, NULL, NULL, $4, $5::jsonb, $6::timestamptz)`,
    params: [uuidv7(), entry.skillId, entry.action, entry.actor, JSON.stringify(entry.details), at],
  };
}

/**
 * Insert a candidate + its `created` audit row in ONE transaction. `status` defaults to
 * `candidate`; a later stage must go through {@link updateSkillStatus} (guarded, audited).
 */
export async function insertSkill(
  db: Database,
  rawCandidate: NewSkill,
  options: { actor: string; at?: string },
): Promise<SkillRecord> {
  const candidate = parseInput(NewSkillSchema, rawCandidate, 'insertSkill');
  if (candidate.status !== undefined && candidate.status !== 'candidate') {
    // ADR-0009 rule 2: generation only ever creates candidates — promotion is the review flow.
    throw new Error(`storage: insertSkill refuses a non-candidate status (${candidate.status})`);
  }
  const at = options.at ?? new Date().toISOString();
  const id = candidate.id ?? uuidv7();
  return db.transaction(async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO skills
         (id, project_id, name, description, version, status, source, verification, path,
          usage_count, created_at, updated_at)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10,
               $11::timestamptz, $11::timestamptz)
       RETURNING *`,
      [
        id,
        candidate.project_id ?? null,
        candidate.name,
        candidate.description,
        candidate.version ?? '1.0.0',
        candidate.status ?? 'candidate',
        JSON.stringify(candidate.source),
        JSON.stringify(candidate.verification),
        candidate.path,
        candidate.usage_count ?? 0,
        at,
      ],
    );
    const audit = skillAuditParams(
      {
        skillId: id,
        action: 'created',
        actor: options.actor,
        details: {
          kind: 'skill',
          name: candidate.name,
          status: candidate.status ?? 'candidate',
          path: candidate.path,
          source: candidate.source,
        },
      },
      at,
    );
    await tx.query(audit.text, audit.params);
    return mapSkillRow(inserted.rows[0]!);
  });
}

/**
 * ONE transaction: guarded status flip (`WHERE id = … AND status = <expected>`) + the
 * `status_changed` audit row. The transition is validated by core's machine first.
 */
export async function updateSkillStatus(
  db: Database,
  id: string,
  to: SkillStatus,
  options: { actor: string; note?: string; details?: Record<string, unknown>; at?: string },
): Promise<SkillRecord> {
  const existing = await getSkill(db, id);
  if (existing === null) throw new NotFoundError('skill', id);
  assertSkillTransition(existing.status, to);
  const at = options.at ?? new Date().toISOString();
  return db.transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE skills
          SET status = $2, updated_at = $3::timestamptz
        WHERE id = $1::uuid AND status = $4
        RETURNING *`,
      [id, to, at, existing.status],
    );
    if ((updated.rowCount ?? 0) === 0) {
      // The guarded update lost the race — report honestly, never a stale flip.
      throw new NotFoundError(`skill (status moved from ${existing.status})`, id);
    }
    const audit = skillAuditParams(
      {
        skillId: id,
        action: 'status_changed',
        actor: options.actor,
        details: {
          kind: 'skill',
          name: existing.name,
          from: existing.status,
          to,
          path: existing.path,
          ...(options.note === undefined ? {} : { note: options.note }),
          ...(options.details === undefined ? {} : { extra: options.details }),
        },
      },
      at,
    );
    await tx.query(audit.text, audit.params);
    return mapSkillRow(updated.rows[0]!);
  });
}

/**
 * Refresh a CANDIDATE's evidence (new failures of the same signature joined the group) + the
 * `edited` audit row — one transaction. Only legal while the row is still a candidate; a
 * verified/promoted skill never mutates its evidence (its SKILL.md is the frozen artifact).
 */
export async function refreshSkillEvidence(
  db: Database,
  id: string,
  next: {
    failure_ids: readonly string[];
    description: string;
    verification: { evidence: EvidenceSpan[]; verified_at: string };
  },
  options: { actor: string; added_failure_ids: readonly string[]; at?: string },
): Promise<SkillRecord> {
  const existing = await getSkill(db, id);
  if (existing === null) throw new NotFoundError('skill', id);
  if (existing.status !== 'candidate') {
    throw new Error(
      `storage: refreshSkillEvidence refuses a ${existing.status} skill — evidence refresh is a candidate-stage operation`,
    );
  }
  const at = options.at ?? new Date().toISOString();
  return db.transaction(async (tx) => {
    const updated = await tx.query(
      `UPDATE skills
          SET source = jsonb_set(source, '{failure_ids}', $2::jsonb),
              description = $3,
              verification = $4::jsonb,
              updated_at = $5::timestamptz
        WHERE id = $1::uuid AND status = 'candidate'
        RETURNING *`,
      [
        id,
        JSON.stringify([...next.failure_ids]),
        next.description,
        JSON.stringify(next.verification),
        at,
      ],
    );
    if ((updated.rowCount ?? 0) === 0) throw new NotFoundError(`skill (no longer candidate)`, id);
    const audit = skillAuditParams(
      {
        skillId: id,
        action: 'edited',
        actor: options.actor,
        details: {
          kind: 'skill',
          name: existing.name,
          reason: 'recurrence_refresh',
          added_failure_ids: [...options.added_failure_ids],
          failure_ids: [...next.failure_ids],
        },
      },
      at,
    );
    await tx.query(audit.text, audit.params);
    return mapSkillRow(updated.rows[0]!);
  });
}

// ---------------------------------------------------------------------------
// The port binding
// ---------------------------------------------------------------------------

/** Build the core `SkillStore` port over a Database (embedded or server — the same code). */
export function createSkillStore(db: Database): SkillStore {
  return {
    listFailureRecurrences: (options) => listFailureRecurrences(db, options),
    insertSkill: (candidate, options) => insertSkill(db, candidate, options),
    getSkill: (id) => getSkill(db, id),
    findSkillByName: (name, scope) => findSkillByName(db, name, scope),
    listSkills: (options) => listSkills(db, options),
    updateSkillStatus: (id, to, options) => updateSkillStatus(db, id, to, options),
    refreshSkillEvidence: (id, next, options) => refreshSkillEvidence(db, id, next, options),
    listSessionEventsForUsage: (options) => listSessionEventsForUsage(db, options),
  };
}
