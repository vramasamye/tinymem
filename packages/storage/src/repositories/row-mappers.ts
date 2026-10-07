/**
 * Row → record mappers. Both drivers return timestamps as JS Date, arrays as JS arrays, and
 * jsonb as parsed values, so one mapper serves PGlite and node-postgres.
 */

import type {
  EdgeRecord,
  EntityRecord,
  JobRecord,
  MemoryEventRecord,
  ProjectRecord,
  SessionRecord,
  StoredEvent,
  UserRecord,
  WorkingMemoryRecord,
} from '@onememory-ai/core';
import type { MemoryRecord, EvidenceSpan } from '@onememory-ai/core';
import {
  EDGE_RELATIONS,
  ENTITY_KINDS,
  JOB_KINDS,
  JOB_STATUSES,
  MEMORY_EVENT_ACTIONS,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  WORKING_MEMORY_KINDS,
} from '@onememory-ai/core';

import { toIso, toIsoOrNull, toStringArray } from '../drivers/client';

export type MemoryRow = Record<string, unknown>;

/** The join shape used by all memory fetchers (memories m + sources s). */
export interface MemoryJoinRow extends MemoryRow {
  source_kind: unknown;
  source_uri: unknown;
  source_title: unknown;
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new TypeError(`storage: expected string for ${field}`);
  return value;
}

function asNumber(value: unknown, field: string): number {
  if (typeof value !== 'number') throw new TypeError(`storage: expected number for ${field}`);
  return value;
}

function asRecord(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`storage: expected object for ${field}`);
  }
  return value as Record<string, unknown>;
}

function asArray<T>(value: unknown, field: string): T[] {
  if (!Array.isArray(value)) throw new TypeError(`storage: expected array for ${field}`);
  return value as T[];
}

/** Cast a string cell to a closed enum, failing loudly on corrupt rows. */
function asEnum<T extends string>(value: unknown, values: readonly T[], field: string): T {
  const text = asString(value, field);
  if ((values as readonly string[]).includes(text)) return text as T;
  throw new TypeError(`storage: invalid ${field} value ${JSON.stringify(text)}`);
}

/**
 * Map a joined memory row to the wire MemoryRecord (§4 of event-memory-schemas.md). Entity
 * bindings are batch-filled by the caller.
 */
export function mapMemoryRow(
  row: MemoryJoinRow,
  entities: MemoryRecord['entities'],
  payload?: MemoryRecord['payload'],
): MemoryRecord {
  const extraction = asRecord(row.extraction, 'extraction');
  const record: MemoryRecord = {
    ...(payload === undefined ? {} : { payload }),
    id: asString(row.id, 'id'),
    type: asEnum(row.type, MEMORY_TYPES, 'type'),
    status: asEnum(row.status, MEMORY_STATUSES, 'status'),
    content: asString(row.content, 'content'),
    importance: asNumber(row.importance, 'importance'),
    confidence: asNumber(row.confidence, 'confidence'),
    access_count: asNumber(row.access_count, 'access_count'),
    observed_at: toIso(row.observed_at),
    valid_from: toIso(row.valid_from),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    evidence: asArray<EvidenceSpan>(row.evidence, 'evidence'),
    entities,
    tags: toStringArray(row.tags),
    token_estimate: asNumber(row.token_estimate, 'token_estimate'),
    provenance: {
      source: {
        id: asString(row.source_id, 'source_id'),
        kind: asString(row.source_kind, 'source_kind'),
        ...(row.source_uri === null || row.source_uri === undefined
          ? {}
          : { uri: asString(row.source_uri, 'source_uri') }),
        ...(row.source_title === null || row.source_title === undefined
          ? {}
          : { title: asString(row.source_title, 'source_title') }),
      },
      evidence: asArray<EvidenceSpan>(row.evidence, 'evidence'),
      extraction: {
        method: asString(extraction.method, 'extraction.method'),
        prompt_version: asString(extraction.prompt_version ?? '', 'extraction.prompt_version'),
        ...(extraction.model === undefined || extraction.model === null
          ? {}
          : { model: asString(extraction.model, 'extraction.model') }),
      },
    },
  };
  const optionalStrings = [
    'subtype',
    'title',
    'content_summary',
    'agent_id',
  ] as const;
  for (const field of optionalStrings) {
    const value = row[field];
    if (value !== null && value !== undefined) {
      (record as Record<string, unknown>)[field] = asString(value, field);
    }
  }
  const lastAccessed = toIsoOrNull(row.last_accessed_at);
  if (lastAccessed !== null) record.last_accessed_at = lastAccessed;
  const validUntil = toIsoOrNull(row.valid_until);
  if (validUntil !== null) record.valid_until = validUntil;
  const supersededBy = row.superseded_by;
  if (supersededBy !== null && supersededBy !== undefined) {
    record.superseded_by = asString(supersededBy, 'superseded_by');
  }
  for (const field of ['project_id', 'user_id'] as const) {
    const value = row[field];
    if (value !== null && value !== undefined) {
      (record as Record<string, unknown>)[field] = asString(value, field);
    }
  }
  return record;
}

export function mapEntityRow(row: MemoryRow): EntityRecord {
  return {
    id: asString(row.id, 'id'),
    project_id: (row.project_id === null || row.project_id === undefined
      ? null
      : asString(row.project_id, 'project_id')) as EntityRecord['project_id'],
    kind: asEnum(row.kind, ENTITY_KINDS, 'kind'),
    name: asString(row.name, 'name'),
    normalized_name: asString(row.normalized_name, 'normalized_name'),
    aliases: toStringArray(row.aliases),
    description: (row.description === null || row.description === undefined
      ? null
      : asString(row.description, 'description')) as EntityRecord['description'],
    confidence: asNumber(row.confidence, 'confidence'),
    merged_into: (row.merged_into === null || row.merged_into === undefined
      ? null
      : asString(row.merged_into, 'merged_into')) as EntityRecord['merged_into'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function mapEdgeRow(row: MemoryRow): EdgeRecord {
  const validFrom = toIsoOrNull(row.valid_from);
  const validUntil = toIsoOrNull(row.valid_until);
  return {
    id: asString(row.id, 'id'),
    from_memory_id: asString(row.from_memory_id, 'from_memory_id'),
    to_memory_id: asString(row.to_memory_id, 'to_memory_id'),
    relation: asEnum(row.relation, EDGE_RELATIONS, 'relation'),
    project_id: (row.project_id === null || row.project_id === undefined
      ? null
      : asString(row.project_id, 'project_id')) as EdgeRecord['project_id'],
    confidence: asNumber(row.confidence, 'confidence'),
    valid_from: validFrom,
    valid_until: validUntil,
    evidence: asArray<EvidenceSpan>(row.evidence, 'evidence'),
    created_at: toIso(row.created_at),
  };
}

export function mapMemoryEventRow(row: MemoryRow): MemoryEventRecord {
  return {
    id: asString(row.id, 'id'),
    memory_id: asString(row.memory_id, 'memory_id'),
    action: asEnum(row.action, MEMORY_EVENT_ACTIONS, 'action'),
    from_status: (row.from_status === null || row.from_status === undefined
      ? null
      : asEnum(row.from_status, MEMORY_STATUSES, 'from_status')) as MemoryEventRecord['from_status'],
    to_status: (row.to_status === null || row.to_status === undefined
      ? null
      : asEnum(row.to_status, MEMORY_STATUSES, 'to_status')) as MemoryEventRecord['to_status'],
    actor: asString(row.actor, 'actor'),
    details: asRecord(row.details, 'details'),
    at: toIso(row.at),
  };
}

export function mapSessionRow(row: MemoryRow): SessionRecord {
  return {
    id: asString(row.id, 'id'),
    project_id: (row.project_id === null || row.project_id === undefined
      ? null
      : asString(row.project_id, 'project_id')) as SessionRecord['project_id'],
    agent_id: (row.agent_id === null || row.agent_id === undefined
      ? null
      : asString(row.agent_id, 'agent_id')) as SessionRecord['agent_id'],
    runtime: asString(row.runtime, 'runtime'),
    started_at: toIso(row.started_at),
    ended_at: toIsoOrNull(row.ended_at),
    summary: (row.summary === null || row.summary === undefined
      ? null
      : asString(row.summary, 'summary')) as SessionRecord['summary'],
    stats: asRecord(row.stats, 'stats'),
  };
}

export function mapWorkingRow(row: MemoryRow): WorkingMemoryRecord {
  return {
    id: asString(row.id, 'id'),
    session_id: asString(row.session_id, 'session_id'),
    kind: asEnum(row.kind, WORKING_MEMORY_KINDS, 'kind'),
    content: asString(row.content, 'content'),
    importance: asNumber(row.importance, 'importance'),
    confidence: asNumber(row.confidence, 'confidence'),
    source_id: (row.source_id === null || row.source_id === undefined
      ? null
      : asString(row.source_id, 'source_id')) as WorkingMemoryRecord['source_id'],
    evidence: asArray<EvidenceSpan>(row.evidence, 'evidence'),
    promoted_memory_id: (row.promoted_memory_id === null || row.promoted_memory_id === undefined
      ? null
      : asString(row.promoted_memory_id, 'promoted_memory_id')) as WorkingMemoryRecord['promoted_memory_id'],
    expires_at: toIso(row.expires_at),
    created_at: toIso(row.created_at),
  };
}

export function mapJobRow(row: MemoryRow): JobRecord {
  return {
    id: asString(row.id, 'id'),
    kind: asEnum(row.kind, JOB_KINDS, 'kind'),
    payload: asRecord(row.payload, 'payload'),
    status: asEnum(row.status, JOB_STATUSES, 'status'),
    run_at: toIso(row.run_at),
    attempts: asNumber(row.attempts, 'attempts'),
    max_attempts: asNumber(row.max_attempts, 'max_attempts'),
    locked_by: (row.locked_by === null || row.locked_by === undefined
      ? null
      : asString(row.locked_by, 'locked_by')) as JobRecord['locked_by'],
    locked_at: toIsoOrNull(row.locked_at),
    last_error: (row.last_error === null || row.last_error === undefined
      ? null
      : asString(row.last_error, 'last_error')) as JobRecord['last_error'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function mapEventRow(row: MemoryRow): StoredEvent {
  const processedAt = toIsoOrNull(row.processed_at);
  const record: StoredEvent = {
    id: asString(row.id, 'id'),
    kind: asString(row.kind, 'kind'),
    runtime: asString(row.runtime, 'runtime'),
    adapter_version: asString(row.adapter_version, 'adapter_version'),
    payload: asRecord(row.payload, 'payload'),
    content_hash: asString(row.content_hash, 'content_hash'),
    redactions: asArray<Record<string, unknown>>(row.redactions, 'redactions') as StoredEvent['redactions'],
    occurred_at: toIso(row.occurred_at),
    ingested_at: toIso(row.ingested_at),
    needs_review: Boolean(row.needs_review),
  };
  for (const field of ['project_id', 'session_id', 'agent_id', 'user_id'] as const) {
    const value = row[field];
    if (value !== null && value !== undefined) {
      (record as unknown as Record<string, unknown>)[field] = asString(value, field);
    }
  }
  if (processedAt !== null) record.processed_at = processedAt;
  const processError = row.process_error;
  if (processError !== null && processError !== undefined) {
    record.process_error = asString(processError, 'process_error');
  }
  return record;
}

export function mapProjectRow(row: MemoryRow): ProjectRecord {
  return {
    id: asString(row.id, 'id'),
    name: asString(row.name, 'name'),
    root_path: (row.root_path === null || row.root_path === undefined
      ? null
      : asString(row.root_path, 'root_path')) as ProjectRecord['root_path'],
    git_remote: (row.git_remote === null || row.git_remote === undefined
      ? null
      : asString(row.git_remote, 'git_remote')) as ProjectRecord['git_remote'],
    description: (row.description === null || row.description === undefined
      ? null
      : asString(row.description, 'description')) as ProjectRecord['description'],
    digest: asRecord(row.digest, 'digest'),
    settings: asRecord(row.settings, 'settings'),
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}

export function mapUserRow(row: MemoryRow): UserRecord {
  return {
    id: asString(row.id, 'id'),
    name: asString(row.name, 'name'),
    email: (row.email === null || row.email === undefined
      ? null
      : asString(row.email, 'email')) as UserRecord['email'],
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
  };
}
