/**
 * The REST wire schemas the memory explorer consumes — the browser-side mirror of
 * `apps/api/src/server/schemas.ts` + the canonical core schemas.
 *
 * Why a mirror instead of importing `@onememory-ai/core`'s schemas at runtime:
 * `@onememory-ai/core`'s barrel re-exports `model/hashing.ts` (node:crypto), which must
 * never enter the browser bundle. So the explorer consumes core **type-only**
 * (`import type`) and re-declares the runtime Zod schemas here; every re-declaration
 * is `satisfies`-linked to the canonical core type, so any drift between this mirror
 * and the canonical schemas fails `tsc --noEmit` in this package. The API validates
 * responses server-side (`respond()`), and this mirror validates them again at the
 * HTTP boundary in the browser (`AGENTS.md`: Zod at every external boundary).
 *
 * Schema sources (kept 1:1):
 * - search responses: `packages/core/src/schema/search.ts`
 * - memory records + typed payloads: `packages/core/src/schema/memory.ts`
 * - inspect/health/stats/projects: `apps/api/src/server/schemas.ts`
 */

import { z } from 'zod';

import type {
  DecisionPayload,
  EvidenceSpan,
  FailurePayload,
  MemoryRecord,
  MemorySearchResponse,
  Redaction,
  SkillPayload,
} from '@onememory-ai/core';

// The model vocabulary (type-only) — the canonical enum VALUES are used in the UI's
// filter forms; importing the const arrays at runtime would pull the core barrel.
export type {
  DecisionPayload,
  EvidenceSpan,
  FailurePayload,
  MemoryRecord,
  MemorySearchResponse,
  Redaction,
  SkillPayload,
} from '@onememory-ai/core';
export type MemoryType = import('@onememory-ai/core').MemoryType;
export type MemoryStatus = import('@onememory-ai/core').MemoryStatus;
export type DurableMemoryType = import('@onememory-ai/core').DurableMemoryType;

// Mirrors of `packages/core/src/model/types.ts` const arrays (type-level only; the
// runtime filter options below carry the values, asserted against these types).
export const MEMORY_TYPES_UI: readonly MemoryType[] = [
  'episodic',
  'semantic',
  'procedural',
  'decision',
  'failure',
  'preference',
  'working',
] as const;
export const DURABLE_MEMORY_TYPES_UI: readonly DurableMemoryType[] = [
  'episodic',
  'semantic',
  'procedural',
  'decision',
  'failure',
  'preference',
] as const;
export const MEMORY_STATUSES_UI: readonly MemoryStatus[] = [
  'active',
  'stale',
  'superseded',
  'disputed',
  'archived',
] as const;
export const INCLUDE_STATUSES_UI = ['stale', 'superseded', 'archived', 'disputed'] as const;

const isoTimestamp = z.iso.datetime();
const uuid = z.uuid();

// ---------------------------------------------------------------------------
// Shared canonical pieces (1:1 with core)
// ---------------------------------------------------------------------------

export const EvidenceSpanSchema = z
  .looseObject({
    source_id: uuid,
    kind: z.enum(['message', 'range', 'commit', 'line', 'event']),
    /** e.g. "session.jsonl:183", "commit:abc123", "lines 4-9". */
    locator: z.string().min(1),
    excerpt: z.string().max(200),
  }) satisfies z.ZodType<EvidenceSpan>;

export const RedactionSchema = z
  .looseObject({
    kind: z.enum(['api-key', 'password', 'token', 'private-key', 'connection-string', 'other']),
    /** JSON path of the redacted field, e.g. "payload.content". */
    location: z.string().min(1),
    /** Length of the removed secret (audit only — the secret value is NEVER stored). */
    length: z.number().int().min(1),
  }) satisfies z.ZodType<Redaction>;

// ---------------------------------------------------------------------------
// Typed payloads (1:1 with core schema/memory.ts §5)
// ---------------------------------------------------------------------------

export const DecisionPayloadSchema = z
  .looseObject({
    title: z.string().min(1),
    decision: z.string().min(1),
    alternatives: z.array(
      z.looseObject({
        option: z.string(),
        why_rejected: z.string().optional(),
      }),
    ),
    rationale: z.string().optional(),
    /** Roles/names — never emails. */
    participants: z.array(z.string()),
    decided_at: isoTimestamp,
    status: z.enum(['proposed', 'accepted', 'superseded', 'rejected']),
    evidence: z.array(EvidenceSpanSchema),
  }) satisfies z.ZodType<DecisionPayload>;

export const FailurePayloadSchema = z
  .looseObject({
    problem: z.string().min(1),
    context: z.string().min(1),
    root_cause: z.string().optional(),
    /** Empty until solved. */
    solution: z.string().optional(),
    /** How the fix was proven (command output digest, test result). */
    verification: z.string().optional(),
    status: z.enum(['open', 'mitigated', 'solved', 'verified']),
    signature_hash: z.string().min(1).optional(),
    first_seen_at: isoTimestamp,
    last_seen_at: isoTimestamp,
    occurrence_count: z.number().int().min(1),
  }) satisfies z.ZodType<FailurePayload>;

export const SkillPayloadSchema = z
  .looseObject({
    /** kebab-case, directory name. */
    name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'skill name must be kebab-case'),
    description: z.string().min(1),
    version: z.string().regex(/^\d+\.\d+\.\d+$/, 'skill version must be semver'),
    status: z.enum(['candidate', 'verified', 'promoted', 'deprecated']),
    source: z.looseObject({
      failure_ids: z.array(uuid),
      procedure_id: z.string().optional(),
    }),
    verification: z.looseObject({
      evidence: z.array(EvidenceSpanSchema),
      verified_at: isoTimestamp,
    }),
    /** skills/<slug>/SKILL.md */
    path: z.string().min(1),
    usage_count: z.number().int().min(0),
    success_rate: z.number().min(0).max(1).optional(),
  }) satisfies z.ZodType<SkillPayload>;

// ---------------------------------------------------------------------------
// Memory record (1:1 with core schema/memory.ts §4)
// ---------------------------------------------------------------------------

export const MemoryRecordSchema = z
  .looseObject({
    id: uuid,
    type: z.enum(['episodic', 'semantic', 'procedural', 'decision', 'failure', 'preference', 'working']),
    subtype: z.string().optional(),
    title: z.string().optional(),
    content: z.string(),
    content_summary: z.string().optional(),
    status: z.enum(['active', 'stale', 'superseded', 'disputed', 'archived']),
    importance: z.number().min(0).max(1),
    confidence: z.number().min(0).max(1),
    access_count: z.number().int().min(0),
    last_accessed_at: isoTimestamp.optional(),
    observed_at: isoTimestamp,
    valid_from: isoTimestamp,
    valid_until: isoTimestamp.optional(),
    created_at: isoTimestamp,
    updated_at: isoTimestamp,
    superseded_by: uuid.optional(),
    project_id: uuid.optional(),
    user_id: uuid.optional(),
    agent_id: z.string().optional(),
    provenance: z.looseObject({
      source: z.looseObject({
        id: uuid,
        kind: z.string(),
        uri: z.string().optional(),
        title: z.string().optional(),
      }),
      evidence: z.array(EvidenceSpanSchema),
      extraction: z.looseObject({
        method: z.string(),
        model: z.string().optional(),
        prompt_version: z.string(),
      }),
      verified_at: isoTimestamp.optional(),
    }),
    entities: z.array(
      z.looseObject({
        id: uuid,
        name: z.string(),
        kind: z.string(),
      }),
    ),
    tags: z.array(z.string()),
    token_estimate: z.number().int().min(0),
    payload: z.union([DecisionPayloadSchema, FailurePayloadSchema, SkillPayloadSchema]).optional(),
  }) satisfies z.ZodType<MemoryRecord>;

// ---------------------------------------------------------------------------
// Search response (1:1 with core schema/search.ts)
// ---------------------------------------------------------------------------

export const MemorySearchResponseSchema = z
  .looseObject({
    query_understanding: z.looseObject({
      intent: z.enum(['fact', 'how_to', 'decision', 'failure', 'preference', 'history', 'context']),
      entities: z.array(
        z.looseObject({
          name: z.string(),
          matched_id: uuid.optional(),
        }),
      ),
      time_scope: z
        .looseObject({
          from: isoTimestamp.optional(),
          until: isoTimestamp.optional(),
          mode: z.enum(['current', 'historical']),
        })
        .optional(),
      keywords: z.array(z.string()),
    }),
    memories: z.array(
      z.looseObject({
        id: uuid,
        type: z.enum(['episodic', 'semantic', 'procedural', 'decision', 'failure', 'preference', 'working']),
        title: z.string().optional(),
        /** Packed representation (content_summary). */
        summary: z.string(),
        content: z.string().optional(),
        /** 0–1 final relevance (computed per query, never stored). */
        relevance: z.number().min(0).max(1),
        explain: z.array(
          z.looseObject({
            factor: z.enum([
              'project_match',
              'entity_match',
              'semantic_similarity',
              'lexical_relevance',
              'importance',
              'confidence',
              'recency',
              'access_frequency',
              'temporal_validity',
              'graph_proximity',
              'type_affinity',
            ]),
            weight: z.number(),
            detail: z.string(),
          }),
        ),
        temporal: z.looseObject({
          valid_from: isoTimestamp,
          valid_until: isoTimestamp.optional(),
          status: z.enum(['active', 'stale', 'superseded', 'disputed', 'archived']),
        }),
        provenance: z.looseObject({
          source_kind: z.string(),
          source_uri: z.string().optional(),
          verified_at: isoTimestamp.optional(),
        }),
        conflicts: z
          .array(
            z.looseObject({
              memory_id: uuid,
              note: z.string(),
            }),
          )
          .optional(),
        /** Always present, empty when none are recorded (M4g2). */
        codeRefs: z.array(
          z.looseObject({
            repoId: uuid,
            commitSha: z.string(),
            path: z.string().min(1),
            symbol: z.string().min(1).optional(),
            evidence: z.string().min(1).optional(),
          }),
        ),
      }),
    ),
    tokens: z.looseObject({
      budget: z.number().int().min(0),
      used: z.number().int().min(0),
      packing: z.enum(['summary', 'content', 'title-only']),
    }),
    warnings: z.array(z.string()),
  }) satisfies z.ZodType<MemorySearchResponse>;

/** The outbound search request — typed by core; the API validates it server-side. */
export type MemorySearchRequest = import('@onememory-ai/core').MemorySearchRequest;

// ---------------------------------------------------------------------------
// Inspect response (1:1 with apps/api/src/server/schemas.ts)
// ---------------------------------------------------------------------------

export const MemoryEventRecordSchema = z.looseObject({
  id: uuid,
  memory_id: uuid,
  action: z.string(),
  from_status: z.string().nullable(),
  to_status: z.string().nullable(),
  actor: z.string(),
  details: z.record(z.string(), z.unknown()),
  at: isoTimestamp,
});

export const EntityRecordSchema = z.looseObject({
  id: uuid,
  project_id: uuid.nullable(),
  kind: z.string(),
  name: z.string(),
  normalized_name: z.string(),
  aliases: z.array(z.string()),
  description: z.string().nullable(),
  confidence: z.number(),
  merged_into: uuid.nullable(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

export const EdgeRecordSchema = z.looseObject({
  id: uuid,
  from_memory_id: uuid,
  to_memory_id: uuid,
  relation: z.string(),
  project_id: uuid.nullable(),
  confidence: z.number(),
  valid_from: isoTimestamp.nullable(),
  valid_until: isoTimestamp.nullable(),
  evidence: z.array(z.unknown()),
  created_at: isoTimestamp,
});

export const InspectResponseSchema = z.strictObject({
  memory: MemoryRecordSchema,
  /** Supersession chain, oldest first (includes `memory`). */
  history: z.array(MemoryRecordSchema),
  /** Append-only audit trail (memory_events), oldest first. */
  audit: z.array(MemoryEventRecordSchema),
  entities: z.array(EntityRecordSchema),
  edges: z.array(EdgeRecordSchema),
  redactions: z.array(RedactionSchema),
  warnings: z.array(z.string()),
});

/** `GET /v1/projects/{id}/memories` — one keyset page (1:1 with `MemoryPageResponseSchema`). */
export const MemoryPageResponseSchema = z.strictObject({
  project_id: uuid,
  page_size: z.number().int().min(1),
  memories: z.array(MemoryRecordSchema),
  next_cursor: z.string().nullable(),
});
export type MemoryPageResponse = z.infer<typeof MemoryPageResponseSchema>;

// ---------------------------------------------------------------------------
// Health / doctor (1:1 with apps/api/src/server/schemas.ts)
// ---------------------------------------------------------------------------

const llmSummary = z.strictObject({
  profile: z.string(),
  providers: z.array(
    z.strictObject({
      id: z.string(),
      kind: z.string(),
      loopback: z.boolean().nullable(),
      api_key_env: z.string().nullable(),
    }),
  ),
  routed_operations: z.array(z.string()),
  unconfigured_operations: z.array(z.string()),
});

export const HealthResponseSchema = z.strictObject({
  status: z.enum(['ok', 'degraded', 'failed']),
  version: z.string(),
  uptime_ms: z.number().int().min(0),
  pid: z.number().int(),
  config_path: z.string().nullable(),
  storage: z.strictObject({
    profile: z.enum(['embedded', 'server']),
    vector_backend: z.string(),
    vector_model: z.string(),
    vector_dim: z.number().int(),
  }),
  llm: llmSummary,
  embedder: z.strictObject({
    provider: z.string().nullable(),
    model: z.string().nullable(),
    dim: z.number().int().nullable(),
  }),
  network_guard: z.strictObject({
    enforced: z.boolean(),
    attempts: z.number().int().min(0),
    reason: z.string(),
  }),
  warnings: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Projects (1:1 with apps/api/src/server/schemas.ts)
// ---------------------------------------------------------------------------

export const ProjectSchema = z.looseObject({
  id: uuid,
  name: z.string(),
  root_path: z.string().nullable().optional(),
  git_remote: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  digest: z.record(z.string(), z.unknown()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
  created_at: isoTimestamp.optional(),
  updated_at: isoTimestamp.optional(),
});

export const ProjectListResponseSchema = z.strictObject({
  projects: z.array(ProjectSchema),
  warnings: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Stats (1:1 with apps/api/src/server/schemas.ts)
// ---------------------------------------------------------------------------

export const StatsResponseSchema = z.strictObject({
  project_id: uuid,
  storage: z.strictObject({
    profile: z.enum(['embedded', 'server']),
    vector_backend: z.string(),
    vector_model: z.string(),
    vector_dim: z.number().int(),
    data_dir: z.string().nullable(),
  }),
  memories: z.strictObject({
    total: z.number().int().min(0),
    by_status: z.record(z.string(), z.number().int().min(0)),
    by_type: z.record(z.string(), z.number().int().min(0)),
    truncated: z.boolean(),
  }),
  working_memory: z
    .strictObject({ session_id: z.string(), depth: z.number().int().min(0) })
    .nullable(),
  jobs: z
    .strictObject({
      pending: z.number().int().min(0),
      running: z.number().int().min(0),
      dead: z.number().int().min(0),
    })
    .nullable(),
  cache: z.strictObject({
    embeddings: z.number().int().min(0),
    results: z.number().int().min(0),
    entityScopes: z.number().int().min(0),
  }),
  llm: llmSummary,
  warnings: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Session context (1:1 with apps/api/src/server/schemas.ts)
// ---------------------------------------------------------------------------

export const SessionContextResponseSchema = z.strictObject({
  project_id: uuid,
  budget: z.number().int().min(1),
  used: z.number().int().min(0),
  text: z.string(),
  sections: z.array(
    z.strictObject({
      kind: z.enum(['digest', 'decisions', 'failures', 'procedures', 'preferences']),
      tokens: z.number().int().min(0),
      text: z.string(),
    }),
  ),
  warnings: z.array(z.string()),
});

// ---------------------------------------------------------------------------
// Skills review (1:1 with apps/api/src/server/schemas.ts)
// ---------------------------------------------------------------------------

export type SkillStatus = import('@onememory-ai/core').SkillStatus;
export type AgentRuntimeIdUi = import('@onememory-ai/core').AgentRuntimeId;
export const SKILL_STATUSES_UI = ['candidate', 'verified', 'promoted', 'deprecated'] as const satisfies readonly SkillStatus[];

export const SkillSummarySchema = z.strictObject({
  id: uuid,
  project_id: uuid.nullable(),
  name: z.string().min(1),
  description: z.string(),
  version: z.string(),
  status: z.enum(SKILL_STATUSES_UI),
  path: z.string(),
  usage_count: z.number().int().min(0),
  success_rate: z.number().min(0).max(1).nullable(),
  evidence_count: z.number().int().min(0),
  verified_at: isoTimestamp,
  source_failure_ids: z.array(uuid),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
});

export const SkillListResponseSchema = z.strictObject({
  project_id: uuid,
  skills: z.array(SkillSummarySchema),
  warnings: z.array(z.string()),
});

export const SkillReviewResponseSchema = z.strictObject({
  project_id: uuid,
  skill: SkillSummarySchema,
  /** The SKILL.md bytes exactly as promotion would write them. */
  markdown: z.string(),
  audit: z.array(MemoryEventRecordSchema),
  unresolved_failure_ids: z.array(uuid),
});

export const PromoteSkillResponseSchema = z.strictObject({
  project_id: uuid,
  skill: SkillSummarySchema,
  written_path: z.string().min(1),
  skills_root: z.string().min(1),
  skills_root_source: z.enum(['dir-flag', 'runtime-flag', 'config', 'project-default']),
  markdown_bytes: z.number().int().min(0),
});

export const DeprecateSkillResponseSchema = z.strictObject({
  project_id: uuid,
  skill: SkillSummarySchema,
});

// ---------------------------------------------------------------------------
// Inferred wire types for the pages
// ---------------------------------------------------------------------------

export type SkillSummary = z.infer<typeof SkillSummarySchema>;
export type SkillListResponse = z.infer<typeof SkillListResponseSchema>;
export type SkillReviewResponse = z.infer<typeof SkillReviewResponseSchema>;
export type PromoteSkillResponse = z.infer<typeof PromoteSkillResponseSchema>;
export type DeprecateSkillResponse = z.infer<typeof DeprecateSkillResponseSchema>;

export type MemoryEventRecord = z.infer<typeof MemoryEventRecordSchema>;
export type EntityRecord = z.infer<typeof EntityRecordSchema>;
export type EdgeRecord = z.infer<typeof EdgeRecordSchema>;
export type InspectResponse = z.infer<typeof InspectResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type Project = z.infer<typeof ProjectSchema>;
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
export type StatsResponse = z.infer<typeof StatsResponseSchema>;
export type SessionContextResponse = z.infer<typeof SessionContextResponseSchema>;
