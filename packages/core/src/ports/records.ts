/**
 * Readback records returned by the Store port. These mirror the storage tables (snake_case) and
 * are plain interfaces — inputs are Zod-validated at the boundary, outputs are typed contracts.
 */

import type { EvidenceSpan } from '../schema/extraction';
import type { ExtractionMeta, MemoryQuery } from '../schema/persistence';
import type {
  EntityKind,
  EntityRole,
  JobKind,
  JobStatus,
  MemoryEventAction,
  MemoryStatus,
  RelationType,
  SourceKind,
  WorkingMemoryKind,
} from '../model/types';

export interface UserRecord {
  id: string;
  name: string;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  root_path: string | null;
  git_remote: string | null;
  description: string | null;
  digest: Record<string, unknown>;
  settings: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface SourceRef {
  id: string;
  kind: SourceKind;
  uri?: string;
  title?: string;
}

/** The raw event row read back for the async pipeline (stages 3–4 read this). */
export interface StoredEvent {
  id: string;
  kind: string;
  runtime: string;
  adapter_version: string;
  project_id?: string;
  session_id?: string;
  agent_id?: string;
  user_id?: string;
  payload: Record<string, unknown>;
  content_hash: string;
  redactions: Array<{ kind: string; location: string; length: number }>;
  occurred_at: string;
  ingested_at: string;
  processed_at?: string;
  process_error?: string;
  needs_review: boolean;
}

export type EventIngestStatus = 'stored' | 'duplicate';

export interface EventIngestResult {
  status: EventIngestStatus;
  event_id: string;
  /** Present when the content_hash dedupe matched an already-ingested event. */
  duplicate_of?: string;
}

export type MemoryWriteOutcome = 'inserted' | 'duplicate';

export interface MemoryWriteResult {
  outcome: MemoryWriteOutcome;
  memory: import('../schema/memory').MemoryRecord;
  /** Present when the (scope, type, content_hash) dedupe probe matched an existing memory. */
  existing?: import('../schema/memory').MemoryRecord;
}

export type SupersedeOutcome = 'superseded' | 'winner-duplicate';

export interface SupersedeResult {
  outcome: SupersedeOutcome;
  winner: import('../schema/memory').MemoryRecord;
  loser?: import('../schema/memory').MemoryRecord;
  /** Present when the winner was an exact duplicate of an existing memory. */
  existing?: import('../schema/memory').MemoryRecord;
}

/** Result of the hard-purge primitive (Store.deleteMemory). */
export interface MemoryDeleteResult {
  purged: true;
  /** Snapshot of the row immediately before deletion — what was destroyed. */
  memory: import('../schema/memory').MemoryRecord;
  /** The `'purged'` audit row (memory_events is FK-less, so the trail survives the deletion). */
  audit: MemoryEventRecord;
}

export type { MemoryQuery };

/** One `memory_events` row (append-only audit trail). */
export interface MemoryEventRecord {
  id: string;
  memory_id: string;
  action: MemoryEventAction | (string & {});
  from_status: MemoryStatus | null;
  to_status: MemoryStatus | null;
  actor: string;
  details: Record<string, unknown>;
  at: string;
}

export interface EdgeRecord {
  id: string;
  from_memory_id: string;
  to_memory_id: string;
  relation: RelationType;
  project_id: string | null;
  confidence: number;
  valid_from: string | null;
  valid_until: string | null;
  evidence: EvidenceSpan[];
  created_at: string;
}

export interface EntityRecord {
  id: string;
  project_id: string | null;
  kind: EntityKind;
  name: string;
  normalized_name: string;
  aliases: string[];
  description: string | null;
  confidence: number;
  merged_into: string | null;
  created_at: string;
  updated_at: string;
}

export interface MemoryEntityBinding {
  memory_id: string;
  entity_id: string;
  role: EntityRole;
  weight: number;
  created_at: string;
}

export interface SessionRecord {
  id: string;
  project_id: string | null;
  agent_id: string | null;
  runtime: string;
  started_at: string;
  ended_at: string | null;
  summary: string | null;
  stats: Record<string, unknown>;
}

export interface WorkingMemoryRecord {
  id: string;
  session_id: string;
  kind: WorkingMemoryKind;
  content: string;
  importance: number;
  confidence: number;
  source_id: string | null;
  evidence: EvidenceSpan[];
  promoted_memory_id: string | null;
  expires_at: string;
  created_at: string;
}

export interface WorkingSweepResult {
  /** Number of expired, unpromoted rows purged (working memory is the one table where deletion is allowed). */
  purged: number;
}

export interface JobRecord {
  id: string;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: JobStatus;
  run_at: string;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export type EnqueueOutcome = 'enqueued' | 'existing';

export interface EnqueueJobResult {
  outcome: EnqueueOutcome;
  job: JobRecord;
}

export interface VectorMatch {
  memory_id: string;
  cosine: number;
}

export type ExtractionMetaRecord = ExtractionMeta;
