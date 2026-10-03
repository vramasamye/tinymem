/**
 * Zod schemas for the Store/JobQueue port inputs. These are the engine's own API — not a wire
 * format from the docs — but the same boundary discipline applies (AGENTS.md rule: Zod validates
 * every external boundary; `packages/storage` parses every repository argument through these).
 *
 * Field names are snake_case, matching the storage columns and the normative wire formats, so
 * there is exactly one naming convention across events, memories, and SQL.
 */

import { z } from 'zod';

import {
  DURABLE_MEMORY_TYPES,
  EDGE_RELATIONS,
  ENTITY_KINDS,
  ENTITY_ROLES,
  JOB_KINDS,
  MEMORY_EVENT_ACTIONS,
  MEMORY_STATUSES,
  SOURCE_KINDS,
  WORKING_MEMORY_KINDS,
} from '../model/types';

import { EvidenceSpanSchema } from './extraction';

const isoTimestamp = z.iso.datetime();
const optionalUuid = z.uuid().optional();

// ---------------------------------------------------------------------------
// Identity & scope
// ---------------------------------------------------------------------------

export const NewUserSchema = z.looseObject({
  id: optionalUuid,
  name: z.string().min(1),
  /** SaaS mode only; local mode has one implicit user. */
  email: z.string().email().optional(),
});
export type NewUser = z.infer<typeof NewUserSchema>;

export const NewProjectSchema = z.looseObject({
  id: optionalUuid,
  name: z.string().min(1),
  /** Filesystem anchor; null in pure SaaS mode. */
  root_path: z.string().optional(),
  git_remote: z.string().optional(),
  description: z.string().optional(),
  digest: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type NewProject = z.infer<typeof NewProjectSchema>;

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

export const NewSourceSchema = z.looseObject({
  id: optionalUuid,
  kind: z.enum(SOURCE_KINDS),
  uri: z.string().optional(),
  title: z.string().optional(),
  content_hash: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  project_id: optionalUuid,
});
export type NewSource = z.infer<typeof NewSourceSchema>;

// ---------------------------------------------------------------------------
// Memories (STORE stage inputs)
// ---------------------------------------------------------------------------

/** Provenance of extraction (memory-model.md §6). */
export const ExtractionMetaSchema = z.looseObject({
  method: z.enum(['llm', 'heuristic']),
  model: z.string().optional(),
  prompt_version: z.string().min(1),
  adapter: z.string().optional(),
  session_id: z.string().optional(),
});
export type ExtractionMeta = z.infer<typeof ExtractionMetaSchema>;

export const NewMemorySchema = z.looseObject({
  id: optionalUuid,
  type: z.enum(DURABLE_MEMORY_TYPES),
  subtype: z.string().optional(),
  title: z.string().max(80).optional(),
  content: z.string().min(1),
  content_summary: z.string().max(160).optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  /** When the fact became true / was observed in the world. */
  observed_at: isoTimestamp,
  /** Defaults to `observed_at`. */
  valid_from: isoTimestamp.optional(),
  valid_until: isoTimestamp.optional(),
  project_id: optionalUuid,
  user_id: optionalUuid,
  agent_id: z.string().optional(),
  source_id: z.uuid(),
  /** Provenance invariant (ADR-0003 rule 4): durable memories carry ≥ 1 evidence span. */
  evidence: z.array(EvidenceSpanSchema).min(1),
  extraction: ExtractionMetaSchema,
  tags: z.array(z.string()).optional(),
  token_estimate: z.number().int().min(0).optional(),
});
export type NewMemory = z.infer<typeof NewMemorySchema>;

export const StatusChangeOptionsSchema = z.looseObject({
  /** `system|user:<id>|agent:<id>|job:<kind>` — audited on every transition. */
  actor: z.string().min(1),
  reason: z.string().optional(),
  /** e.g. supersession closes the loser's window at the winner's observed_at. */
  valid_until: isoTimestamp.optional(),
  superseded_by_id: z.uuid().optional(),
  details: z.record(z.string(), z.unknown()).optional(),
});
export type StatusChangeOptions = z.infer<typeof StatusChangeOptionsSchema>;

export const SupersedeInputSchema = z.looseObject({
  winner: NewMemorySchema,
  loser_id: z.uuid(),
  actor: z.string().min(1),
  reason: z.string().optional(),
});
export type SupersedeInput = z.infer<typeof SupersedeInputSchema>;

export const MemoryQuerySchema = z.looseObject({
  project_id: optionalUuid,
  user_id: optionalUuid,
  types: z.array(z.enum(DURABLE_MEMORY_TYPES)).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type MemoryQuery = z.infer<typeof MemoryQuerySchema>;

// ---------------------------------------------------------------------------
// Graph primitives
// ---------------------------------------------------------------------------

export const NewEdgeSchema = z.looseObject({
  id: optionalUuid,
  from_memory_id: z.uuid(),
  to_memory_id: z.uuid(),
  relation: z.enum(EDGE_RELATIONS),
  project_id: optionalUuid,
  confidence: z.number().min(0).max(1).optional(),
  valid_from: isoTimestamp.optional(),
  valid_until: isoTimestamp.optional(),
  evidence: z.array(EvidenceSpanSchema).optional(),
});
export type NewEdge = z.infer<typeof NewEdgeSchema>;

export const NewEntitySchema = z.looseObject({
  id: optionalUuid,
  /** NULL = global (PostgreSQL, Docker, Node.js…). */
  project_id: optionalUuid,
  kind: z.enum(ENTITY_KINDS),
  name: z.string().min(1),
  /** Computed from `name` when absent (normalized: NFC, trimmed, collapsed, lowercased). */
  normalized_name: z.string().optional(),
  aliases: z.array(z.string()).optional(),
  description: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type NewEntity = z.infer<typeof NewEntitySchema>;

export const MergeEntitiesInputSchema = z.looseObject({
  /** The entity that loses (gets `merged_into`). */
  source_id: z.uuid(),
  /** The canonical entity that survives. */
  target_id: z.uuid(),
});
export type MergeEntitiesInput = z.infer<typeof MergeEntitiesInputSchema>;

export const EntityBindingSchema = z.looseObject({
  entity_id: z.uuid(),
  role: z.enum(ENTITY_ROLES).optional(),
  weight: z.number().min(0).optional(),
});
export type EntityBinding = z.infer<typeof EntityBindingSchema>;

// ---------------------------------------------------------------------------
// Sessions & working memory
// ---------------------------------------------------------------------------

export const NewSessionSchema = z.looseObject({
  /** Runtime session id (text PK — runtime-native, not a uuid). */
  id: z.string().min(1),
  project_id: optionalUuid,
  agent_id: z.string().optional(),
  runtime: z.string().min(1),
  started_at: isoTimestamp,
  ended_at: isoTimestamp.optional(),
  summary: z.string().optional(),
  stats: z.record(z.string(), z.unknown()).optional(),
});
export type NewSession = z.infer<typeof NewSessionSchema>;

export const NewWorkingMemorySchema = z.looseObject({
  id: optionalUuid,
  session_id: z.string().min(1),
  kind: z.enum(WORKING_MEMORY_KINDS),
  content: z.string().min(1),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  source_id: optionalUuid,
  evidence: z.array(EvidenceSpanSchema).optional(),
  expires_at: isoTimestamp,
});
export type NewWorkingMemory = z.infer<typeof NewWorkingMemorySchema>;

// ---------------------------------------------------------------------------
// Audit trail
// ---------------------------------------------------------------------------

export const NewMemoryEventSchema = z.looseObject({
  id: optionalUuid,
  memory_id: z.uuid(),
  action: z.enum(MEMORY_EVENT_ACTIONS),
  from_status: z.enum(MEMORY_STATUSES).nullable().optional(),
  to_status: z.enum(MEMORY_STATUSES).nullable().optional(),
  actor: z.string().min(1),
  details: z.record(z.string(), z.unknown()).optional(),
  at: isoTimestamp.optional(),
});
export type NewMemoryEvent = z.infer<typeof NewMemoryEventSchema>;

// ---------------------------------------------------------------------------
// Jobs (internal work queue)
// ---------------------------------------------------------------------------

export const EnqueueJobSchema = z.looseObject({
  kind: z.enum(JOB_KINDS),
  /** Singleton key: prevents duplicate instances of the same logical work while pending/running. */
  key: z.string().min(1),
  payload: z.record(z.string(), z.unknown()).optional(),
  run_at: isoTimestamp.optional(),
  max_attempts: z.number().int().min(1).optional(),
});
export type EnqueueJobInput = z.infer<typeof EnqueueJobSchema>;

export const ClaimJobsSchema = z.looseObject({
  claimant: z.string().min(1),
  limit: z.number().int().min(1).max(100).optional(),
  lease_seconds: z.number().int().min(1).optional(),
  /** Injectable clock for tests. */
  now: isoTimestamp.optional(),
});
export type ClaimJobsInput = z.infer<typeof ClaimJobsSchema>;
