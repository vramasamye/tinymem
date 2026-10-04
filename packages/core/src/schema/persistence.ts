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
import { DecisionStorePayloadSchema, FailureStorePayloadSchema } from './memory';

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

/**
 * The persistable typed payloads (M3d): the projection of a `decisions` or `failures` row a
 * `decision`/`failure` memory may carry at STORE time. The wire payload schemas are the field
 * definitions (reuse, not a divergent model); the only difference is the decision `evidence`
 * echo, which the table does not store (see `DecisionStorePayloadSchema`).
 */
export const NewMemoryPayloadSchema = z.union([DecisionStorePayloadSchema, FailureStorePayloadSchema]);
export type NewMemoryPayload = z.infer<typeof NewMemoryPayloadSchema>;

export const NewMemorySchema = z
  .looseObject({
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
    /**
     * Typed payload row input (M3d), keyed to the memory type by the refinement below: a
     * `decision` memory carries a decision payload, a `failure` memory a failure payload, and
     * every other type carries none (the `skills` table is not memory-keyed — no skill payload
     * here). Absent = no payload row; existing callers are unaffected.
     */
    payload: NewMemoryPayloadSchema.optional(),
  })
  .superRefine((memory, ctx) => {
    if (memory.payload === undefined) return;
    if (memory.type === 'decision') {
      if (!DecisionStorePayloadSchema.safeParse(memory.payload).success) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload'],
          message: "a 'decision' memory may only carry a decision payload",
        });
      }
    } else if (memory.type === 'failure') {
      if (!FailureStorePayloadSchema.safeParse(memory.payload).success) {
        ctx.addIssue({
          code: 'custom',
          path: ['payload'],
          message: "a 'failure' memory may only carry a failure payload",
        });
      }
    } else {
      ctx.addIssue({
        code: 'custom',
        path: ['payload'],
        message: 'payload rows exist only for decision and failure memories',
      });
    }
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

/**
 * Options for the hard-purge primitive (`Store.deleteMemory`) — the destructive counterpart of
 * an archived tombstone. Purges are audited like every other lifecycle action.
 */
export const DeleteMemoryOptionsSchema = z.looseObject({
  /** `system|user:<id>|agent:<id>|job:<kind>` — audited on the 'purged' row. */
  actor: z.string().min(1),
  reason: z.string().optional(),
  /** Extra audit context (e.g. which surface performed the purge). */
  details: z.record(z.string(), z.unknown()).optional(),
});
export type DeleteMemoryOptions = z.infer<typeof DeleteMemoryOptionsSchema>;

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

// ---------------------------------------------------------------------------
// Code memory (M4 — ADR-0008 persistence port inputs)
// ---------------------------------------------------------------------------

/** A Git blob id (40 hex) or plain SHA-256 content hash (64 hex). */
const objectHash = z
  .string()
  .regex(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/, 'a 40- or 64-character lowercase hex object id');

/** A safe repository-relative path: relative, no parent traversal, no NUL. */
const repositoryPath = z
  .string()
  .min(1)
  .refine(
    (value) => !value.startsWith('/') && !value.includes('\0') && !value.split('/').includes('..'),
    'a safe repository-relative path',
  );

export const FingerprintTierSchema = z.enum(['committed', 'worktree']);
export type FingerprintTier = z.infer<typeof FingerprintTierSchema>;

export const EnsureCodeRepositorySchema = z.looseObject({
  project_id: z.uuid(),
  /** Canonical absolute filesystem root; snapshots saved to this repository must match it. */
  root_path: z.string().min(1),
});
export type EnsureCodeRepository = z.infer<typeof EnsureCodeRepositorySchema>;

export const SnapshotFileSchema = z.looseObject({
  path: repositoryPath,
  tier: FingerprintTierSchema,
  /** Git blob id, or a plain SHA-256 content hash on non-Git roots. */
  blob_sha: objectHash,
  mode: z.enum(['100644', '100755']),
});
export type SnapshotFile = z.infer<typeof SnapshotFileSchema>;

/** A (path, tier) whose bytes could not be captured (conflict, unreadable, oversized, …). */
export const UnavailablePathSchema = z.looseObject({
  path: repositoryPath,
  tier: FingerprintTierSchema,
});
export type UnavailablePath = z.infer<typeof UnavailablePathSchema>;

/**
 * One captured snapshot (structurally compatible with a codememory `RepositorySnapshot`, so the
 * pipeline can pass captures straight through; extra keys like per-file algorithms pass).
 */
export const SnapshotInputSchema = z.looseObject({
  /** Must equal the repository row's root_path (checked at the storage boundary). */
  root_path: z.string().min(1),
  /** HEAD at capture; null for unborn HEAD or non-Git roots. */
  head_commit: objectHash.nullable(),
  hash_algorithm: z.enum(['git-sha1', 'git-sha256', 'sha256']),
  mode: z.enum(['git', 'content']),
  exclusion_globs: z.array(z.string()),
  captured_at: isoTimestamp,
  files: z.array(SnapshotFileSchema),
  skipped: z.array(UnavailablePathSchema),
});
export type SnapshotInput = z.infer<typeof SnapshotInputSchema>;

/** Metadata persisted with the latest snapshot (the `repositories.fingerprint` jsonb). */
export const SnapshotMetadataSchema = z.looseObject({
  root_path: z.string().min(1),
  head_commit: objectHash.nullable(),
  hash_algorithm: z.enum(['git-sha1', 'git-sha256', 'sha256']),
  mode: z.enum(['git', 'content']),
  exclusion_globs: z.array(z.string()),
  captured_at: isoTimestamp,
  file_count: z.number().int().min(0),
  skipped_count: z.number().int().min(0),
  /**
   * The (path, tier) entries the latest capture could not read — the honest source for drift's
   * "retained-unavailable" suspicion. Rows persisted before this field existed parse without
   * it; their unreadable-path knowledge is simply absent until the next saveSnapshot.
   */
  skipped: z.array(UnavailablePathSchema).optional(),
});
export type SnapshotMetadata = z.infer<typeof SnapshotMetadataSchema>;

// ---------------------------------------------------------------------------
// Code refs (M4c — which memories rest on which code)
// ---------------------------------------------------------------------------

/**
 * The code evidence one memory rests on within ONE repository. Refs record worktree-tier
 * evidence only — the bytes the agent actually saw — so no `tier` column is needed and the
 * ref's `blob_sha` must be a worktree-tier fingerprint (matching the normative drift query,
 * which pins `ff.tier = 'worktree'`).
 */
export const RecordCodeRefsSchema = z.looseObject({
  memory_id: z.uuid(),
  repository_id: z.uuid(),
  /** Each path with the worktree-tier blob the memory was extracted against. */
  refs: z
    .array(z.looseObject({ path: repositoryPath, blob_sha: objectHash }))
    .min(1)
    .refine((refs) => new Set(refs.map((ref) => ref.path)).size === refs.length, {
      message: 'duplicate ref paths in one recordCodeRefs call',
    }),
});
export type RecordCodeRefs = z.infer<typeof RecordCodeRefsSchema>;

// ---------------------------------------------------------------------------
// Drift apply (M4e — retargeting refs and advancing the ingestion checkpoint)
// ---------------------------------------------------------------------------

/**
 * Move ONE memory's ref from a path that disappeared to the path its exact content now lives at
 * (drift's `successor_path`). The ref keeps its evidence blob; persistence re-verifies the move
 * against the persisted worktree tier before writing.
 */
export const RetargetCodeRefSchema = z
  .looseObject({
    memory_id: z.uuid(),
    repository_id: z.uuid(),
    from_path: repositoryPath,
    to_path: repositoryPath,
  })
  .refine((input) => input.from_path !== input.to_path, {
    message: 'from_path and to_path must differ',
  });
export type RetargetCodeRef = z.infer<typeof RetargetCodeRefSchema>;

/**
 * Compare-and-set of `repositories.last_ingested_commit`. `to_commit` must be the repository's
 * current persisted `head_commit` (the latest capture), and the stored checkpoint must still
 * equal `expected_last_ingested_commit` — so a pipeline holding an older drift report can never
 * move the checkpoint behind a newer capture or overwrite a concurrent advance.
 */
export const AdvanceCheckpointSchema = z.looseObject({
  repository_id: z.uuid(),
  expected_last_ingested_commit: objectHash.nullable(),
  to_commit: objectHash,
});
export type AdvanceCheckpoint = z.infer<typeof AdvanceCheckpointSchema>;

// ---------------------------------------------------------------------------
// Symbol tables (M4d — ADR-0008 "Symbol tables re-extract only changed files")
// ---------------------------------------------------------------------------

/** The extraction kind vocabulary shared by every grammar (one cross-language set). */
export const SYMBOL_KINDS = [
  'class',
  'enum',
  'function',
  'impl',
  'interface',
  'method',
  'module',
  'struct',
  'trait',
  'type',
] as const;
export const SymbolKindSchema = z.enum(SYMBOL_KINDS);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

/** The grammars the extractor can load; other source extensions are outside the symbol domain. */
export const SYMBOL_LANGUAGES = ['go', 'javascript', 'python', 'rust', 'tsx', 'typescript'] as const;
export const SymbolLanguageSchema = z.enum(SYMBOL_LANGUAGES);
export type SymbolLanguage = z.infer<typeof SymbolLanguageSchema>;

/** A 64-character lowercase hex SHA-256 (span and symbol-table hashes are always SHA-256). */
const sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'a 64-character lowercase hex SHA-256');

export const SymbolRecordSchema = z.looseObject({
  name: z.string().min(1).max(512),
  kind: SymbolKindSchema,
  /** Normalized single-line declaration header (comments stripped, whitespace collapsed, capped). */
  signature: z.string().max(256),
  /** 1-based inclusive line range of the symbol's span. */
  line_start: z.number().int().min(1),
  line_end: z.number().int().min(1),
  /** SHA-256 of the symbol's normalized span — intra-file granularity (ADR-0008). */
  span_hash: sha256Hex,
}).refine((symbol) => symbol.line_start <= symbol.line_end, {
  message: 'line_start must not exceed line_end',
});
export type SymbolRecordInput = z.infer<typeof SymbolRecordSchema>;

export const SymbolFileInputSchema = z.looseObject({
  path: repositoryPath,
  language: SymbolLanguageSchema,
  /**
   * Document-order symbol table for this file. May be empty: a file in a known language can
   * legitimately declare nothing (the file is still covered, with a hash over an empty table).
   */
  symbols: z.array(SymbolRecordSchema),
  /** Hash over the ordered symbol table — the per-file rewrite guard. */
  symbols_hash: sha256Hex,
});
export type SymbolFileInput = z.infer<typeof SymbolFileInputSchema>;

/**
 * One extraction's persistable coverage. A scoped save (re-extraction of only changed files)
 * covers exactly the files it extracted; persistence replaces the rows of covered files and
 * never touches uncovered paths — files the extraction could not read are simply not covered,
 * so their last-known rows stay retained-unavailable, exactly like snapshot fingerprints.
 */
export const SymbolTableSaveSchema = z.looseObject({
  files: z
    .array(SymbolFileInputSchema)
    .min(1)
    .refine((files) => new Set(files.map((file) => file.path)).size === files.length, {
      message: 'duplicate file paths in one saveSymbolTable call',
    }),
});
export type SymbolTableSave = z.infer<typeof SymbolTableSaveSchema>;
