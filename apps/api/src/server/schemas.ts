/**
 * The REST wire schemas — Zod at both boundaries (`AGENTS.md`: every external boundary is
 * validated; ADR-0010: the same records the MCP surface returns).
 *
 * Requests are validated by `@hono/zod-openapi` before a handler runs; responses are validated by
 * `respond()` before they leave the process. Validation failures are loud (400 for a request, 500
 * for a response that does not match its own contract) — a response that cannot be described is a
 * bug, not something to send anyway.
 */

// Importing '@hono/zod-openapi' patches the zod instance THAT PACKAGE resolves (at import time,
// not retroactively), so its `z` re-export already carries `.openapi()`. The explicit idempotent
// call below documents the mechanism instead of depending on that side effect. Schemas imported
// from other workspace packages are never annotated — see the note at `SearchRequestSchema`.
import { extendZodWithOpenApi, z as zOpenApi } from '@hono/zod-openapi';

import {
  DURABLE_MEMORY_TYPES,
  MemoryRecordSchema,
  MemorySearchRequestSchema,
  MemorySearchResponseSchema,
  RedactionSchema,
} from '@onememory/core';

import { MAX_MEMORY_PAGE_SIZE, MEMORY_PAGE_INCLUDE } from '../runtime/types';

extendZodWithOpenApi(zOpenApi);
const z = zOpenApi;

const isoTimestamp = z.iso.datetime();

/**
 * The router summary both health and stats report (`llmProfileSummary` from `@onememory/config`):
 * provider ids, kinds and loopback-ness — environment variable NAMES only, never key values.
 */
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

export const ErrorResponseSchema = z
  .strictObject({
    error: z.strictObject({
      code: z.enum(['not_found', 'invalid_request', 'conflict', 'unavailable', 'internal']),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .openapi('ErrorResponse');

export const HealthResponseSchema = z
  .strictObject({
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
  })
  .openapi('HealthResponse');

export const DoctorCheckSchema = z
  .strictObject({
    id: z.string(),
    title: z.string(),
    status: z.enum(['pass', 'warn', 'fail', 'info']),
    detail: z.string(),
    remediation: z.string().optional(),
  })
  .openapi('DoctorCheck');

export const DoctorReportSchema = z
  .strictObject({
    status: z.enum(['ok', 'degraded', 'failed']),
    exit_code: z.union([z.literal(0), z.literal(1)]),
    generated_at: isoTimestamp,
    version: z.string(),
    config_path: z.string().nullable(),
    config: z.unknown().nullable(),
    summary: z.strictObject({
      pass: z.number().int().min(0),
      warn: z.number().int().min(0),
      fail: z.number().int().min(0),
      info: z.number().int().min(0),
    }),
    checks: z.array(DoctorCheckSchema),
    /** Agent-runtime wiring (Claude Code, Codex): scaffold presence + MCP URL vs daemon config. */
    runtimes: z.array(DoctorCheckSchema),
  })
  .openapi('DoctorReport');

export const ProjectSchema = z
  .looseObject({
    id: z.uuid(),
    name: z.string(),
    root_path: z.string().nullable().optional(),
    git_remote: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    digest: z.record(z.string(), z.unknown()).optional(),
    settings: z.record(z.string(), z.unknown()).optional(),
    created_at: isoTimestamp.optional(),
    updated_at: isoTimestamp.optional(),
  })
  .openapi('Project');

export const ProjectListResponseSchema = z
  .strictObject({ projects: z.array(ProjectSchema), warnings: z.array(z.string()) })
  .openapi('ProjectListResponse');

export const CreateProjectRequestSchema = z
  .strictObject({
    name: z.string().min(1).max(200),
    root_path: z.string().min(1).optional(),
    git_remote: z.string().min(1).optional(),
    description: z.string().max(2000).optional(),
  })
  .openapi('CreateProjectRequest');

const IngestOutcomeSchema = z
  .strictObject({
    index: z.number().int().min(0),
    status: z.enum(['stored', 'duplicate', 'excluded', 'dead-letter']),
    event_id: z.uuid().optional(),
    duplicate_of: z.uuid().optional(),
    reason: z.string().optional(),
    redactions: z.array(RedactionSchema).optional(),
  })
  .openapi('IngestOutcome');

export const IngestRequestSchema = z
  .strictObject({
    /**
     * Event envelopes. The canonical shape (`id`, `ingested_at`, `content_hash`, `redactions`) is
     * preferred; a draft that omits them is completed from the payload (canonical JSON hash via
     * `@onememory/core`) before validation, so adapters do not re-implement hashing.
     */
    events: z.array(z.unknown()).min(1).max(500),
  })
  .openapi('IngestRequest');

export const IngestResponseSchema = z
  .strictObject({
    outcomes: z.array(IngestOutcomeSchema),
    stored: z.number().int().min(0),
    duplicates: z.number().int().min(0),
    excluded: z.number().int().min(0),
    dead_lettered: z.number().int().min(0),
    normalize_job_id: z.uuid().nullable(),
    warnings: z.array(z.string()),
  })
  .openapi('IngestResponse');

export const RememberRequestSchema = z
  .strictObject({
    content: z.string().min(1).max(20_000),
    type: z.enum(DURABLE_MEMORY_TYPES).optional(),
    title: z.string().min(1).max(80).optional(),
    subtype: z.string().min(1).max(80).optional(),
    importance: z.number().min(0).max(1).optional(),
    confidence: z.number().min(0).max(1).optional(),
    tags: z.array(z.string().min(1).max(64)).max(50).optional(),
    entities: z.array(z.string().min(1).max(200)).max(50).optional(),
  })
  .openapi('RememberRequest');

export const RememberResponseSchema = z
  .strictObject({
    outcome: z.enum(['inserted', 'duplicate']),
    memory_id: z.uuid(),
    redactions: z.array(RedactionSchema),
    duplicate_of: z.uuid().optional(),
    warnings: z.array(z.string()),
  })
  .openapi('RememberResponse');

export const ForgetRequestSchema = z
  .strictObject({ reason: z.string().max(500).optional() })
  .openapi('ForgetRequest');

export const ForgetResponseSchema = z
  .strictObject({
    memory_id: z.uuid(),
    from_status: z.string(),
    to_status: z.string(),
    audit_event_id: z.string(),
    restore_hint: z.string(),
    purge_hint: z.string(),
    note: z.string(),
  })
  .openapi('ForgetResponse');

export const PurgeRequestSchema = z
  .strictObject({
    /** The revision token (updated_at) from your last read — a purge can never be accidental. */
    expected_revision: z.string().min(1),
    reason: z.string().max(500).optional(),
  })
  .openapi('PurgeRequest');

export const PurgeResponseSchema = z
  .strictObject({
    memory_id: z.uuid(),
    purged: z.literal(true),
    from_status: z.string(),
    /** The surviving 'purged' audit row id. */
    audit_event_id: z.string(),
    note: z.string(),
  })
  .openapi('PurgeResponse');

export const MemoryEventRecordSchema = z
  .looseObject({
    id: z.uuid(),
    memory_id: z.uuid(),
    action: z.string(),
    from_status: z.string().nullable(),
    to_status: z.string().nullable(),
    actor: z.string(),
    details: z.record(z.string(), z.unknown()),
    at: isoTimestamp,
  })
  .openapi('MemoryEventRecord');

export const EntityRecordSchema = z
  .looseObject({
    id: z.uuid(),
    project_id: z.uuid().nullable(),
    kind: z.string(),
    name: z.string(),
    normalized_name: z.string(),
    aliases: z.array(z.string()),
    description: z.string().nullable(),
    confidence: z.number(),
    merged_into: z.uuid().nullable(),
    created_at: isoTimestamp,
    updated_at: isoTimestamp,
  })
  .openapi('EntityRecord');

export const EdgeRecordSchema = z
  .looseObject({
    id: z.uuid(),
    from_memory_id: z.uuid(),
    to_memory_id: z.uuid(),
    relation: z.string(),
    project_id: z.uuid().nullable(),
    confidence: z.number(),
    valid_from: isoTimestamp.nullable(),
    valid_until: isoTimestamp.nullable(),
    evidence: z.array(z.unknown()),
    created_at: isoTimestamp,
  })
  .openapi('EdgeRecord');

export const InspectResponseSchema = z
  .strictObject({
    memory: MemoryRecordSchema,
    history: z.array(MemoryRecordSchema),
    audit: z.array(MemoryEventRecordSchema),
    entities: z.array(EntityRecordSchema),
    edges: z.array(EdgeRecordSchema),
    redactions: z.array(RedactionSchema),
    warnings: z.array(z.string()),
  })
  .openapi('InspectResponse');

export const StatsResponseSchema = z
  .strictObject({
    project_id: z.uuid(),
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
  })
  .openapi('StatsResponse');

export const SessionContextSchema = z
  .strictObject({
    project_id: z.uuid(),
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
  })
  .openapi('SessionContext');

/**
 * Schemas imported from other workspace packages are reused AS-IS, never `.openapi()`-annotated.
 *
 * `.openapi()` is a prototype patch applied to the zod instance *this package* resolves, and it
 * is not retroactive: `@onememory/core`'s schemas are usually constructed before this module is
 * evaluated (every CLI process loads core before the API surface), so `MemorySearchRequestSchema
 * .openapi(...)` throws in exactly those processes. The OpenAPI generator still describes the
 * schemas structurally — only the cosmetic $ref name is lost, which is a price worth paying for a
 * surface that works from any entry point.
 */
export const SearchRequestSchema = MemorySearchRequestSchema;
export const SearchResponseSchema = MemorySearchResponseSchema;

export const IdParamSchema = z.object({ id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }) });
export const MemoryIdParamSchema = z.object({
  id: z.uuid().openapi({ param: { name: 'id', in: 'path' } }),
  memoryId: z.uuid().openapi({ param: { name: 'memoryId', in: 'path' } }),
});

export const ListQuerySchema = z.strictObject({
  q: z.string().min(1).max(2000).optional(),
  max_tokens: z.coerce.number().int().min(1).max(100_000).optional(),
  max_memories: z.coerce.number().int().min(1).max(1000).optional(),
});

/** `a,b,c` over a fixed vocabulary — kept a plain validated string so the OpenAPI doc stays structural. */
function commaList(values: readonly string[]) {
  const one = `(?:${values.join('|')})`;
  return z.string().regex(new RegExp(`^${one}(?:,${one})*$`));
}

export const MemoryPageQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(500).optional(),
  page_size: z.coerce.number().int().min(1).max(MAX_MEMORY_PAGE_SIZE).optional(),
  types: commaList(DURABLE_MEMORY_TYPES).optional(),
  include: commaList(MEMORY_PAGE_INCLUDE).optional(),
});

export const MemoryPageResponseSchema = z
  .strictObject({
    project_id: z.uuid(),
    page_size: z.number().int().min(1),
    memories: z.array(MemoryRecordSchema),
    next_cursor: z.string().nullable(),
  })
  .openapi('MemoryPage');

export const ContextQuerySchema = z.strictObject({
  budget: z.coerce.number().int().min(1).max(100_000).default(750),
  session_id: z.string().min(1).max(200).optional(),
});

export const StatsQuerySchema = z.strictObject({
  session: z.string().min(1).max(200).optional(),
});
