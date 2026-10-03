/**
 * Memory model vocabulary — the enums behind ADR-0003 and `docs/architecture/database-schema.md`.
 *
 * These const arrays are the single source for both the Zod schemas (`src/schema/`) and the
 * Drizzle CHECK constraints (`packages/storage/src/schema/`). Zod enums are *derived* from them;
 * do not duplicate the values anywhere else.
 */

// ---------------------------------------------------------------------------
// Memory content types (ADR-0003: seven content types)
// ---------------------------------------------------------------------------

/** The one content type of a memory. `working` lives in its own table (`working_memory`). */
export const MEMORY_TYPES = [
  'episodic',
  'semantic',
  'procedural',
  'decision',
  'failure',
  'preference',
  'working',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

/** Types stored in the durable `memories` table (working memory is a separate table). */
export const DURABLE_MEMORY_TYPES = [
  'episodic',
  'semantic',
  'procedural',
  'decision',
  'failure',
  'preference',
] as const;
export type DurableMemoryType = (typeof DURABLE_MEMORY_TYPES)[number];

export const WORKING_MEMORY_TYPE = 'working' as const satisfies MemoryType;

/**
 * Extraction-time type markers (`event-memory-schemas.md` §3). Note `semantic_candidate`:
 * semantic memories are never created from single observations (ADR-0003 rule 7) — the extractor
 * emits a candidate and consolidation decides.
 */
export const EXTRACTED_MEMORY_TYPES = [
  'episodic',
  'semantic_candidate',
  'procedural',
  'decision',
  'failure',
  'preference',
] as const;
export type ExtractedMemoryType = (typeof EXTRACTED_MEMORY_TYPES)[number];

// ---------------------------------------------------------------------------
// Status model (memory-model.md §4)
// ---------------------------------------------------------------------------

export const MEMORY_STATUSES = ['active', 'stale', 'superseded', 'disputed', 'archived'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

// ---------------------------------------------------------------------------
// Structural layers
// ---------------------------------------------------------------------------

/** `sources.kind` — provenance anchor kinds (database-schema.md §2). */
export const SOURCE_KINDS = [
  'conversation',
  'document',
  'git',
  'terminal',
  'file',
  'web',
  'api',
  'explicit',
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

/** `entities.kind` (database-schema.md §2). */
export const ENTITY_KINDS = [
  'tool',
  'library',
  'language',
  'person',
  'service',
  'concept',
  'project',
  'file',
  'other',
] as const;
export type EntityKind = (typeof ENTITY_KINDS)[number];

/** `memory_entities.role`. */
export const ENTITY_ROLES = ['subject', 'object', 'context'] as const;
export type EntityRole = (typeof ENTITY_ROLES)[number];

/** `edges.relation` — the memory-graph relation vocabulary (matches `RelationType`). */
export const EDGE_RELATIONS = [
  'related_to',
  'depends_on',
  'caused_by',
  'solved_by',
  'decided_by',
  'supersedes',
  'contradicts',
  'derived_from',
  'belongs_to',
  'used_by',
  'modifies',
] as const;
export type RelationType = (typeof EDGE_RELATIONS)[number];

// ---------------------------------------------------------------------------
// Working memory
// ---------------------------------------------------------------------------

export const WORKING_MEMORY_KINDS = [
  'task',
  'hypothesis',
  'current_file',
  'current_error',
  'temp_decision',
  'open_question',
] as const;
export type WorkingMemoryKind = (typeof WORKING_MEMORY_KINDS)[number];

// ---------------------------------------------------------------------------
// Typed payload statuses
// ---------------------------------------------------------------------------

/** `decisions.status`. */
export const DECISION_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'] as const;
export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** `failures.status`. */
export const FAILURE_STATUSES = ['open', 'mitigated', 'solved', 'verified'] as const;
export type FailureStatus = (typeof FAILURE_STATUSES)[number];

/** `skills.status`. */
export const SKILL_STATUSES = ['candidate', 'verified', 'promoted', 'deprecated'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

// ---------------------------------------------------------------------------
// Audit trail actions (`memory_events.action` vocabulary, database-schema.md §2)
// ---------------------------------------------------------------------------

export const MEMORY_EVENT_ACTIONS = [
  'created',
  'status_changed',
  'reinforced',
  'merged',
  'archived',
  'restored',
  'purged',
  'edited',
  'redacted',
] as const;
export type MemoryEventAction = (typeof MEMORY_EVENT_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Jobs (internal work queue, stages 3–9 and 12–14 of the lifecycle pipeline)
// ---------------------------------------------------------------------------

export const JOB_KINDS = [
  'normalize',
  'extract',
  'consolidate',
  'decay',
  'drift_scan',
  'reindex',
  'skillify',
  're_embed',
  'verify_stale',
] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed', 'dead'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// ---------------------------------------------------------------------------
// Redaction / evidence
// ---------------------------------------------------------------------------

/** `Redaction.kind` (event-memory-schemas.md §1). */
export const REDACTION_KINDS = [
  'api-key',
  'password',
  'token',
  'private-key',
  'connection-string',
  'other',
] as const;
export type RedactionKind = (typeof REDACTION_KINDS)[number];

/** `EvidenceSpan.kind` (event-memory-schemas.md §3). */
export const EVIDENCE_SPAN_KINDS = ['message', 'range', 'commit', 'line', 'event'] as const;
export type EvidenceSpanKind = (typeof EVIDENCE_SPAN_KINDS)[number];

/** `file.changed.change`. */
export const FILE_CHANGE_KINDS = ['created', 'modified', 'deleted', 'renamed'] as const;
export type FileChangeKind = (typeof FILE_CHANGE_KINDS)[number];
