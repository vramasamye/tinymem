/**
 * Read-only search repositories — the retrieval candidate channels
 * (docs/architecture/retrieval.md stage 2; ADR-0004). NEW FILE added for M2: M1's repositories
 * own the lifecycle pipeline stages (2/6/9/10/11); these add the candidate-generation reads the
 * retrieval engine drives, without touching M1's files:
 *
 *   - lexical    : Postgres FTS over the STORED `search_text` tsvector (`plainto_tsquery('simple')`
 *                  + `ts_rank`) — the always-available channel
 *   - id fetch   : batched record fetch for vector-KNN results (order preserved)
 *   - graph      : entity-bound memories + 1–2 hop edge expansion honoring edge validity windows
 *   - shortcuts  : typed payload reads (accepted decisions, known failures) for intent routing
 *   - session    : current typed memories + project entity registry for session-context assembly
 *
 * The `CandidateFilter` is the retrieval engine's HARD temporal/status filter (retrieval.md stage 3)
 * pushed into SQL as a prefilter. Contract: it must stay an EXACT equivalent of the engine's pure
 * temporal predicate — never narrower, so no candidate the temporal policy would admit is lost
 * here, and never wider in status (the engine still re-checks every candidate in-process).
 */

import type {
  DurableMemoryType,
  EntityRecord,
  MemoryRecord,
  MemoryStatus,
} from '@onememory/core';

import type { Database } from '../drivers/client';
import { pgTextArray, pgUuidArray } from '../drivers/client';

import { mapEntityRow, mapMemoryRow, type MemoryJoinRow, type MemoryRow } from './row-mappers';

// ---------------------------------------------------------------------------
// Shared filter
// ---------------------------------------------------------------------------

/**
 * Validity window pushed into SQL.
 * - `point`: `valid_from ≤ at < valid_until` (NULL until = open) — current and as-of modes.
 * - `overlap`: the memory's window intersects `[from, until)` (NULL bound = open) — historical
 *   range / full-history modes.
 */
export type CandidateWindow =
  | { kind: 'point'; at: string }
  | { kind: 'overlap'; from: string | null; until: string | null };

export interface CandidateFilter {
  /** Allowed statuses — exactly the temporal policy's set (never empty). */
  statuses: readonly MemoryStatus[];
  window: CandidateWindow;
  /** `undefined` = any project; `null` = global scope only (`project_id IS NULL`). */
  projectId?: string | null;
  /**
   * The M17 scope union (mutually exclusive with `projectId`): this project's rows PLUS the
   * caller's user-level rows (`project_id IS NULL AND user_id = caller`) — so user-level
   * memories answer from any project while other projects' rows stay out.
   */
  projectOrUser?: { projectId: string; userId: string };
  types?: readonly DurableMemoryType[];
  /** Candidate must be bound to ALL of these entities (search-request filter semantics). */
  requiredEntityIds?: readonly string[];
}

interface FilterPlan {
  clauses: string[];
  params: unknown[];
}

/**
 * The memory column set every candidate fetcher selects. Mirrors `MEMORY_SELECT` in
 * memories.ts (not exported there); keep the two in sync when the schema changes.
 */
const SEARCH_MEMORY_SELECT = `
  SELECT m.id, m.type, m.subtype, m.title, m.content, m.content_summary, m.status,
         m.importance, m.confidence, m.access_count, m.last_accessed_at, m.observed_at,
         m.valid_from, m.valid_until, m.created_at, m.updated_at, m.superseded_by,
         m.project_id, m.user_id, m.agent_id, m.source_id, m.evidence, m.extraction,
         m.tags, m.token_estimate,
         s.kind AS source_kind, s.uri AS source_uri, s.title AS source_title
  FROM memories m
  JOIN sources s ON s.id = m.source_id
`;

/** Exported for the sibling repositories (the skills repo's recurrence read): ONE filter planner,
 * never a re-derivation — the clauses must not drift from the retrieval policy. */
export function planFilter(filter: CandidateFilter, startIndex: number): FilterPlan {
  if (filter.statuses.length === 0) {
    throw new TypeError('search: candidate filter requires at least one allowed status');
  }
  const clauses: string[] = [];
  const params: unknown[] = [];
  let i = startIndex;

  clauses.push(`m.status = ANY($${i}::text[])`);
  params.push(pgTextArray(filter.statuses));
  i += 1;

  if (filter.window.kind === 'point') {
    // $i is referenced twice on purpose (same parameter, both comparisons).
    clauses.push(`m.valid_from <= $${i}::timestamptz`);
    clauses.push(`(m.valid_until IS NULL OR m.valid_until > $${i}::timestamptz)`);
    params.push(filter.window.at);
    i += 1;
  } else {
    if (filter.window.until !== null) {
      clauses.push(`m.valid_from < $${i}::timestamptz`);
      params.push(filter.window.until);
      i += 1;
    }
    if (filter.window.from !== null) {
      clauses.push(`(m.valid_until IS NULL OR m.valid_until > $${i}::timestamptz)`);
      params.push(filter.window.from);
      i += 1;
    }
  }

  if (filter.types !== undefined && filter.types.length > 0) {
    clauses.push(`m.type = ANY($${i}::text[])`);
    params.push(pgTextArray(filter.types));
    i += 1;
  }

  if (filter.projectId !== undefined) {
    clauses.push(`m.project_id IS NOT DISTINCT FROM $${i}::uuid`);
    params.push(filter.projectId);
    i += 1;
  }

  if (filter.projectOrUser !== undefined) {
    // The M17 scope union: this project's rows PLUS the caller's user-level rows
    // (`project_id IS NULL AND user_id = caller`). Mutually exclusive with `projectId` — an
    // ambiguous scope is a planner bug, so it fails closed instead of guessing.
    if (filter.projectId !== undefined) {
      throw new TypeError('search: candidate filter projectId and projectOrUser are mutually exclusive');
    }
    clauses.push(`(m.project_id = $${i}::uuid OR (m.project_id IS NULL AND m.user_id = $${i + 1}::uuid))`);
    params.push(filter.projectOrUser.projectId, filter.projectOrUser.userId);
    i += 2;
  }

  for (const entityId of filter.requiredEntityIds ?? []) {
    clauses.push(
      `EXISTS (SELECT 1 FROM memory_entities me
                 WHERE me.memory_id = m.id AND me.entity_id = $${i}::uuid)`,
    );
    params.push(entityId);
    i += 1;
  }

  return { clauses, params };
}

/** Batch-load entity bindings for the fetched memories (avoids N+1; same shape as memories.ts).
 * Exported for the sibling repositories (the skills repo's recurrence read). */
export async function entitiesForMemories(
  db: Database,
  memoryIds: readonly string[],
): Promise<Map<string, MemoryRecord['entities']>> {
  const map = new Map<string, MemoryRecord['entities']>();
  for (const id of memoryIds) map.set(id, []);
  if (memoryIds.length === 0) return map;
  const result = await db.query<{ memory_id: string; id: string; name: string; kind: string }>(
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

/** Map joined rows to wire MemoryRecords (entity bindings batch-filled). */
async function mapRows(db: Database, rows: readonly MemoryJoinRow[]): Promise<MemoryRecord[]> {
  const entityMap = await entitiesForMemories(db, rows.map((row) => String(row.id)));
  return rows.map((row) => mapMemoryRow(row, entityMap.get(String(row.id)) ?? []));
}

// ---------------------------------------------------------------------------
// Lexical channel (Postgres FTS)
// ---------------------------------------------------------------------------

export interface LexicalSearchOptions {
  /**
   * Query terms. Each is normalized PG-side by `plainto_tsquery('simple', …)` and the per-term
   * queries are OR-ed (`||`): plainto alone ANDs every word, which makes natural-language
   * queries recall almost nothing. `ts_rank` still favors documents matching more terms.
   */
  terms: readonly string[];
  limit: number;
}

/** FTS channel: `search_text @@ (term₁ || term₂ || …)` ranked by `ts_rank`, best first. */
export async function searchLexical(
  db: Database,
  opts: LexicalSearchOptions,
  filter: CandidateFilter,
): Promise<MemoryRecord[]> {
  const terms = opts.terms.map((term) => term.trim()).filter((term) => term.length > 0);
  if (terms.length === 0) return [];
  const tsquery = terms.map((_, index) => `plainto_tsquery('simple', $${index + 1})`).join(' || ');
  const plan = planFilter(filter, terms.length + 1);
  const limitIndex = terms.length + 1 + plan.params.length;
  const result = await db.query<MemoryJoinRow>(
    `${SEARCH_MEMORY_SELECT}
      WHERE m.search_text @@ (${tsquery})
        AND ${plan.clauses.join(' AND ')}
      ORDER BY ts_rank(m.search_text, (${tsquery})) DESC,
               m.observed_at DESC, m.id DESC
      LIMIT $${limitIndex}`,
    [...terms, ...plan.params, opts.limit],
  );
  return mapRows(db, result.rows);
}

// ---------------------------------------------------------------------------
// Id fetch (vector-KNN readback; shared by other channels)
// ---------------------------------------------------------------------------

/**
 * Fetch memories by id WITH the candidate filter applied, preserving input order (the caller's
 * channel rank order). Missing or filtered-out ids are silently absent — the caller keeps ranks
 * of survivors contiguous by re-indexing the result.
 */
export async function fetchMemoriesByIds(
  db: Database,
  ids: readonly string[],
  filter: CandidateFilter,
): Promise<MemoryRecord[]> {
  if (ids.length === 0) return [];
  const plan = planFilter(filter, 2);
  const result = await db.query<MemoryJoinRow>(
    `${SEARCH_MEMORY_SELECT}
      WHERE m.id = ANY($1::uuid[])
        AND ${plan.clauses.join(' AND ')}`,
    [pgUuidArray(ids), ...plan.params],
  );
  const records = await mapRows(db, result.rows);
  const byId = new Map(records.map((record) => [record.id, record]));
  const out: MemoryRecord[] = [];
  for (const id of ids) {
    const record = byId.get(id);
    if (record) out.push(record);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Graph channel
// ---------------------------------------------------------------------------

export interface EntityBoundOptions {
  entityIds: readonly string[];
  /** Top-N per entity by observed_at (retrieval.md: 30 per entity). */
  perEntityLimit: number;
  /** Total cap across entities (retrieval.md: 60). */
  cap: number;
}

/**
 * Entity-bound memories, round-robin across entities by per-entity recency (position 0 of each
 * entity first, then position 1, …) so one noisy entity cannot starve the others. The filter is
 * applied INSIDE each per-entity query, so filtered-out rows do not consume per-entity slots.
 */
export async function memoriesForEntities(
  db: Database,
  opts: EntityBoundOptions,
  filter: CandidateFilter,
): Promise<MemoryRecord[]> {
  const perEntity: string[][] = [];
  for (const entityId of opts.entityIds) {
    const plan = planFilter(filter, 2);
    const limitIndex = 2 + plan.params.length;
    const result = await db.query<{ memory_id: string }>(
      `SELECT me.memory_id
         FROM memory_entities me
         JOIN memories m ON m.id = me.memory_id
        WHERE me.entity_id = $1::uuid
          AND ${plan.clauses.join(' AND ')}
        ORDER BY m.observed_at DESC, me.created_at ASC, m.id DESC
        LIMIT $${limitIndex}`,
      [entityId, ...plan.params, opts.perEntityLimit],
    );
    perEntity.push(result.rows.map((row) => row.memory_id));
  }

  const seen = new Set<string>();
  const collected: string[] = [];
  for (let position = 0; collected.length < opts.cap; position += 1) {
    let advanced = false;
    for (const list of perEntity) {
      const id = list[position];
      if (id === undefined) continue;
      advanced = true;
      if (!seen.has(id)) {
        seen.add(id);
        collected.push(id);
        if (collected.length >= opts.cap) break;
      }
    }
    if (!advanced) break;
  }
  return fetchMemoriesByIds(db, collected, filter);
}

export interface GraphExpansionOptions {
  seedIds: readonly string[];
  /** 1–2 hop expansion (retrieval.md stage 2). */
  hops: number;
  /** Total neighbor cap (retrieval.md: 40), pre-filter count. */
  cap: number;
  /** Edge validity is evaluated at this instant (NULL bounds = always valid). */
  at: string;
}

export interface GraphNeighbor {
  memory: MemoryRecord;
  hops: number;
}

/** One BFS level: neighbor ids per seed, through edges valid at `at`, both directions. */
async function edgeNeighbors(
  db: Database,
  seedIds: readonly string[],
  at: string,
): Promise<Map<string, string[]>> {
  if (seedIds.length === 0) return new Map();
  const result = await db.query<{ from_id: string; to_id: string }>(
    `SELECT e.from_memory_id AS from_id, e.to_memory_id AS to_id
       FROM edges e
      WHERE (e.from_memory_id = ANY($1::uuid[]) OR e.to_memory_id = ANY($1::uuid[]))
        AND (e.valid_from IS NULL OR e.valid_from <= $2::timestamptz)
        AND (e.valid_until IS NULL OR e.valid_until > $2::timestamptz)
      ORDER BY e.created_at ASC, e.id ASC`,
    [pgUuidArray(seedIds), at],
  );
  const seeds = new Set(seedIds);
  const map = new Map<string, string[]>();
  for (const row of result.rows) {
    if (seeds.has(row.from_id)) {
      const list = map.get(row.from_id) ?? [];
      if (!list.includes(row.to_id)) list.push(row.to_id);
      map.set(row.from_id, list);
    }
    if (seeds.has(row.to_id)) {
      const list = map.get(row.to_id) ?? [];
      if (!list.includes(row.from_id)) list.push(row.from_id);
      map.set(row.to_id, list);
    }
  }
  return map;
}

/**
 * BFS edge expansion from seeds, honoring edge validity windows, both edge directions, BFS order
 * deterministic (edge created_at/id). Neighbors are capped BEFORE the memory filter applies; the
 * filter then removes non-passing survivors (a filtered neighbor never resurrects — it is simply
 * absent from the result; its hop count is preserved for the graph boost).
 */
export async function expandGraphNeighbors(
  db: Database,
  opts: GraphExpansionOptions,
  filter: CandidateFilter,
): Promise<GraphNeighbor[]> {
  const hopsById = new Map<string, number>();
  const visited = new Set(opts.seedIds);
  let frontier = [...opts.seedIds];
  const maxHops = Math.max(0, Math.floor(opts.hops));
  for (let hop = 1; hop <= maxHops; hop += 1) {
    if (frontier.length === 0 || hopsById.size >= opts.cap) break;
    const neighborMap = await edgeNeighbors(db, frontier, opts.at);
    const next: string[] = [];
    for (const seed of frontier) {
      for (const neighbor of neighborMap.get(seed) ?? []) {
        if (visited.has(neighbor)) continue;
        visited.add(neighbor);
        hopsById.set(neighbor, hop);
        next.push(neighbor);
        if (hopsById.size >= opts.cap) break;
      }
      if (hopsById.size >= opts.cap) break;
    }
    frontier = next;
  }

  const records = await fetchMemoriesByIds(db, [...hopsById.keys()], filter);
  return records.map((memory) => ({
    memory,
    hops: hopsById.get(memory.id) ?? 1,
  }));
}

// ---------------------------------------------------------------------------
// Typed payload shortcuts (intent routing; decisions / failures payload tables)
// ---------------------------------------------------------------------------

export interface DecisionCandidate {
  memory: MemoryRecord;
  decided_at: string;
  rationale: string | null;
}

/** Decision-intent shortcut: latest `decisions.status = 'accepted'` memories, newest first. */
export async function latestAcceptedDecisions(
  db: Database,
  opts: { limit: number },
  filter: CandidateFilter,
): Promise<DecisionCandidate[]> {
  const plan = planFilter(filter, 1);
  const limitIndex = 1 + plan.params.length;
  const result = await db.query<MemoryJoinRow & { decided_at: string | Date; rationale: string | null }>(
    `SELECT m.id, m.type, m.subtype, m.title, m.content, m.content_summary, m.status,
            m.importance, m.confidence, m.access_count, m.last_accessed_at, m.observed_at,
            m.valid_from, m.valid_until, m.created_at, m.updated_at, m.superseded_by,
            m.project_id, m.user_id, m.agent_id, m.source_id, m.evidence, m.extraction,
            m.tags, m.token_estimate,
            s.kind AS source_kind, s.uri AS source_uri, s.title AS source_title,
            d.decided_at, d.rationale
       FROM decisions d
       JOIN memories m ON m.id = d.memory_id
       JOIN sources s ON s.id = m.source_id
      WHERE d.status = 'accepted'
        AND ${plan.clauses.join(' AND ')}
      ORDER BY d.decided_at DESC, m.id DESC
      LIMIT $${limitIndex}`,
    [...plan.params, opts.limit],
  );
  const records = await mapRows(db, result.rows);
  return result.rows.map((row, index) => ({
    memory: records[index]!,
    decided_at: row.decided_at instanceof Date ? row.decided_at.toISOString() : row.decided_at,
    rationale: row.rationale,
  }));
}

export interface FailureCandidate {
  memory: MemoryRecord;
  problem: string;
  solution: string | null;
  failure_status: string;
  occurrence_count: number;
  last_seen_at: string;
}

/** Failure-intent shortcut: failure memories ordered by recurrence then recency (rules-first
 * stand-in for signature similarity — no LLM in the hot path). */
export async function recentFailures(
  db: Database,
  opts: { limit: number },
  filter: CandidateFilter,
): Promise<FailureCandidate[]> {
  const plan = planFilter(filter, 1);
  const limitIndex = 1 + plan.params.length;
  const result = await db.query<
    MemoryJoinRow & {
      problem: string;
      solution: string | null;
      failure_status: string;
      occurrence_count: number;
      last_seen_at: string | Date;
    }
  >(
    `SELECT m.id, m.type, m.subtype, m.title, m.content, m.content_summary, m.status,
            m.importance, m.confidence, m.access_count, m.last_accessed_at, m.observed_at,
            m.valid_from, m.valid_until, m.created_at, m.updated_at, m.superseded_by,
            m.project_id, m.user_id, m.agent_id, m.source_id, m.evidence, m.extraction,
            m.tags, m.token_estimate,
            s.kind AS source_kind, s.uri AS source_uri, s.title AS source_title,
            f.problem, f.solution, f.status AS failure_status,
            f.occurrence_count, f.last_seen_at
       FROM failures f
       JOIN memories m ON m.id = f.memory_id
       JOIN sources s ON s.id = m.source_id
      WHERE ${plan.clauses.join(' AND ')}
      ORDER BY f.occurrence_count DESC, f.last_seen_at DESC, m.id DESC
      LIMIT $${limitIndex}`,
    [...plan.params, opts.limit],
  );
  const records = await mapRows(db, result.rows);
  return result.rows.map((row, index) => ({
    memory: records[index]!,
    problem: row.problem,
    solution: row.solution,
    failure_status: row.failure_status,
    occurrence_count: row.occurrence_count,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at,
  }));
}

/** Session-context "known failures": open (or still-mitigated) + high-recurrence, most recurring first. */
export async function knownFailures(
  db: Database,
  opts: { limit: number; openStatuses: readonly string[]; minOccurrences: number },
  filter: CandidateFilter,
): Promise<FailureCandidate[]> {
  const plan = planFilter(filter, 3);
  const limitIndex = 3 + plan.params.length;
  const result = await db.query<
    MemoryJoinRow & {
      problem: string;
      solution: string | null;
      failure_status: string;
      occurrence_count: number;
      last_seen_at: string | Date;
    }
  >(
    `SELECT m.id, m.type, m.subtype, m.title, m.content, m.content_summary, m.status,
            m.importance, m.confidence, m.access_count, m.last_accessed_at, m.observed_at,
            m.valid_from, m.valid_until, m.created_at, m.updated_at, m.superseded_by,
            m.project_id, m.user_id, m.agent_id, m.source_id, m.evidence, m.extraction,
            m.tags, m.token_estimate,
            s.kind AS source_kind, s.uri AS source_uri, s.title AS source_title,
            f.problem, f.solution, f.status AS failure_status,
            f.occurrence_count, f.last_seen_at
       FROM failures f
       JOIN memories m ON m.id = f.memory_id
       JOIN sources s ON s.id = m.source_id
      WHERE (f.status = ANY($1::text[]) OR f.occurrence_count >= $2)
        AND ${plan.clauses.join(' AND ')}
      ORDER BY f.occurrence_count DESC, f.last_seen_at DESC, m.id DESC
      LIMIT $${limitIndex}`,
    [pgTextArray(opts.openStatuses), opts.minOccurrences, ...plan.params, opts.limit],
  );
  const records = await mapRows(db, result.rows);
  return result.rows.map((row, index) => ({
    memory: records[index]!,
    problem: row.problem,
    solution: row.solution,
    failure_status: row.failure_status,
    occurrence_count: row.occurrence_count,
    last_seen_at: row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : row.last_seen_at,
  }));
}

// ---------------------------------------------------------------------------
// Session-context building blocks
// ---------------------------------------------------------------------------

export interface TypeListOptions {
  types: readonly DurableMemoryType[];
  limit: number;
  /** `importance` ranks the "what matters most" sections; `observed_at` ranks recency. */
  order?: 'importance' | 'observed_at';
}

/** Current typed memories for session-context sections (procedures, preferences). */
export async function listCurrentMemories(
  db: Database,
  opts: TypeListOptions,
  filter: CandidateFilter,
): Promise<MemoryRecord[]> {
  if (opts.types.length === 0) return [];
  const plan = planFilter({ ...filter, types: opts.types }, 1);
  const limitIndex = 1 + plan.params.length;
  const order = opts.order === 'importance' ? 'm.importance DESC, m.observed_at DESC' : 'm.observed_at DESC';
  const result = await db.query<MemoryJoinRow>(
    `${SEARCH_MEMORY_SELECT}
      WHERE ${plan.clauses.join(' AND ')}
      ORDER BY ${order}, m.id DESC
      LIMIT $${limitIndex}`,
    [...plan.params, opts.limit],
  );
  return mapRows(db, result.rows);
}

/** Keyset position: the last row of the previous page, `observed_at` as exact epoch microseconds. */
export interface MemoryPageCursor {
  observed_at_us: string;
  id: string;
}

export interface MemoryPageOptions {
  types: readonly DurableMemoryType[];
  pageSize: number;
  after?: MemoryPageCursor;
}

export interface MemoryPage {
  memories: MemoryRecord[];
  /** Position of the last returned row when more rows follow, else null. */
  next: MemoryPageCursor | null;
}

/**
 * One keyset page of a filtered memory listing, newest observation first, ties broken by id.
 * The cursor carries `observed_at` as integer epoch microseconds rather than an ISO string:
 * timestamptz stores microseconds and a millisecond ISO round-trip could skip or repeat rows
 * that share a millisecond.
 */
export async function listMemoryPage(
  db: Database,
  opts: MemoryPageOptions,
  filter: CandidateFilter,
): Promise<MemoryPage> {
  if (opts.types.length === 0) return { memories: [], next: null };
  const plan = planFilter({ ...filter, types: opts.types }, 1);
  const clauses = [...plan.clauses];
  const params = [...plan.params];
  if (opts.after !== undefined) {
    const at = params.length + 1;
    clauses.push(
      `(m.observed_at, m.id) < (timestamptz 'epoch' + $${at}::bigint * interval '1 microsecond', $${at + 1}::uuid)`,
    );
    params.push(opts.after.observed_at_us, opts.after.id);
  }
  params.push(opts.pageSize + 1);
  const result = await db.query<MemoryJoinRow & { observed_at_us: string }>(
    `${SEARCH_MEMORY_SELECT.replace(
      'SELECT m.id,',
      "SELECT (extract(epoch FROM m.observed_at) * 1000000)::bigint::text AS observed_at_us, m.id,",
    )}
      WHERE ${clauses.join(' AND ')}
      ORDER BY m.observed_at DESC, m.id DESC
      LIMIT $${params.length}`,
    params,
  );
  const rows = result.rows.slice(0, opts.pageSize);
  const memories = await mapRows(db, rows);
  const last = rows.at(-1);
  return {
    memories,
    next:
      result.rows.length > opts.pageSize && last !== undefined
        ? { observed_at_us: String(last.observed_at_us), id: String(last.id) }
        : null,
  };
}

/** The project entity registry (project scope + global entities) for the in-memory match index. */
export async function listScopeEntities(
  db: Database,
  opts: { projectId?: string | null; limit: number },
): Promise<EntityRecord[]> {
  const result = await db.query<MemoryRow>(
    `SELECT * FROM entities
      WHERE merged_into IS NULL
        AND (project_id IS NOT DISTINCT FROM $1::uuid OR project_id IS NULL)
      ORDER BY (project_id IS NULL) ASC, created_at DESC, id DESC
      LIMIT $2`,
    [opts.projectId ?? null, opts.limit],
  );
  return result.rows.map(mapEntityRow);
}

/** Memories linked by a `contradicts` edge (either direction) — conflict labels for disputed results. */
export async function contradictionNeighbors(
  db: Database,
  memoryId: string,
): Promise<Array<{ memory_id: string }>> {
  const result = await db.query<{ memory_id: string }>(
    `SELECT CASE WHEN e.from_memory_id = $1::uuid THEN e.to_memory_id ELSE e.from_memory_id END AS memory_id
       FROM edges e
      WHERE e.relation = 'contradicts'
        AND (e.from_memory_id = $1::uuid OR e.to_memory_id = $1::uuid)
      ORDER BY e.created_at ASC, e.id ASC`,
    [memoryId],
  );
  return result.rows;
}
