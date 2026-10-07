/**
 * The tool wire contract — Zod schemas for every MCP tool's input AND output
 * (ADR-0010 §3: "Every tool ships `outputSchema` + `structuredContent`").
 *
 * This module IS the JSON contract surface for the M6/M7 adapters and the M13 CLI: the schemas
 * double as the SDK's `inputSchema`/`outputSchema` (the SDK converts Zod → JSON Schema) and as
 * the boundary validation for handler arguments. All objects are `z.looseObject` — boundaries
 * tolerate unknown fields (event-memory-schemas.md §8).
 *
 * Reuse rules honored here: full memory records reuse core's `MemoryRecordSchema` verbatim
 * (event-memory-schemas.md §4 is the normative wire shape); search rides the retrieval engine's
 * request schema. Nothing in this file invents a new memory kind (D8: working memory stays out).
 */

import { z } from 'zod';

import {
  DURABLE_MEMORY_TYPES,
  EDGE_RELATIONS,
  ENTITY_KINDS,
  EVIDENCE_SPAN_KINDS,
  MemoryRecordSchema,
  SKILL_STATUSES,
} from '@onememory-ai/core';

// ---------------------------------------------------------------------------
// Tool names + profiles
// ---------------------------------------------------------------------------

/** The default 8-tool surface (ADR-0010 §2). */
export const DEFAULT_TOOLS = [
  'memory_search',
  'memory_get',
  'memory_store',
  'memory_update',
  'memory_delete',
  'memory_forget',
  'memory_related',
  'memory_project_context',
] as const;
export type DefaultToolName = (typeof DEFAULT_TOOLS)[number];

/** The curated-list tools added by the `full11` config profile. */
export const FULL11_EXTRA_TOOLS = ['memory_decisions', 'memory_failures', 'memory_skills'] as const;
export type Full11ExtraToolName = (typeof FULL11_EXTRA_TOOLS)[number];

export type ToolName = DefaultToolName | Full11ExtraToolName;

/** Runtime-configurable exposure (ADR-0010 §2: profile `default8` | `full11`). */
export const TOOL_PROFILES = ['default8', 'full11'] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

export function toolsForProfile(profile: ToolProfile): readonly ToolName[] {
  return profile === 'full11' ? [...DEFAULT_TOOLS, ...FULL11_EXTRA_TOOLS] : [...DEFAULT_TOOLS];
}

// ---------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------

const isoTimestamp = z.iso.datetime();
const optionalUuid = z.uuid().optional();

/**
 * The `kind` filter (ADR-0010 §2): the three curated lists plus the type taxonomy, folded into
 * one search surface. `skill` maps to the procedural type — skills ARE promoted procedures
 * (memory-model.md §2/§9); the standalone `skills` payload table is the skillify stage's (M7).
 */
export const SEARCH_KINDS = [
  'decision',
  'failure',
  'skill',
  ...DURABLE_MEMORY_TYPES,
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

/** kind → durable types filter for the retrieval request. */
export function typesForKind(kind: SearchKind): (typeof DURABLE_MEMORY_TYPES)[number][] {
  if (kind === 'skill') return ['procedural'];
  return [kind];
}

/** Caller-supplied evidence (span source ids are attached server-side after source creation). */
export const EvidenceInputSchema = z.object({
  kind: z.enum(EVIDENCE_SPAN_KINDS).optional(),
  locator: z.string().max(200).optional(),
  /** What supports the statement (≤ 200 chars — core's EvidenceSpan cap). */
  excerpt: z.string().min(1).max(200),
});
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

export const EntityInputSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(ENTITY_KINDS).optional(),
});
export type EntityInput = z.infer<typeof EntityInputSchema>;

/** The compact per-result line of every list-shaped tool (progressive disclosure, ADR-0010 §3). */
export const MemoryIndexEntrySchema = z.looseObject({
  id: z.uuid(),
  type: z.string(),
  subtype: z.string().optional(),
  title: z.string().optional(),
  /** One-line summary (content_summary / packed representation). */
  summary: z.string(),
  /** 0–1 relevance for ranked searches; 1 for unranked curated lists. */
  relevance: z.number().min(0).max(1),
  status: z.string().optional(),
  token_estimate: z.number().int().min(0),
});
export type MemoryIndexEntry = z.infer<typeof MemoryIndexEntrySchema>;

/** Every result's total token estimate (Codex `output_token_limit` safety, ADR-0010 §3). */
const TokenTotal = z.number().int().min(0);

// ---------------------------------------------------------------------------
// memory_search
// ---------------------------------------------------------------------------

export const MemorySearchInputSchema = z.looseObject({
  query: z.string().min(1).max(2000),
  kind: z.enum(SEARCH_KINDS).optional(),
  project_id: optionalUuid,
  /** Hard ceiling for the packed ID-index (default 800, hard cap 4000). */
  max_tokens: z.number().int().min(1).max(4000).optional(),
  max_memories: z.number().int().min(1).max(50).optional(),
  entities: z.array(z.string().min(1).max(200)).max(20).optional(),
  as_of: isoTimestamp.optional(),
  temporal_mode: z.enum(['current', 'historical']).optional(),
  include: z.array(z.enum(['stale', 'superseded', 'archived', 'disputed'])).max(4).optional(),
  session_id: z.string().min(1).optional(),
  explain: z.boolean().optional(),
});
export type MemorySearchInput = z.infer<typeof MemorySearchInputSchema>;

export const MemorySearchOutputSchema = z.looseObject({
  results: z.array(MemoryIndexEntrySchema),
  tokens: z.looseObject({
    budget: TokenTotal,
    used: TokenTotal,
    packing: z.enum(['summary', 'content', 'title-only']),
  }),
  query_understanding: z.looseObject({
    intent: z.string(),
    entities: z.array(z.looseObject({ name: z.string(), matched_id: optionalUuid })),
    keywords: z.array(z.string()),
  }),
  warnings: z.array(z.string()),
  token_estimate: TokenTotal,
});
export type MemorySearchOutput = z.infer<typeof MemorySearchOutputSchema>;

// ---------------------------------------------------------------------------
// memory_get
// ---------------------------------------------------------------------------

export const MemoryGetInputSchema = z.looseObject({
  id: z.uuid(),
  /** Add the full supersession chain (every revision of this fact, oldest first). */
  include_history: z.boolean().optional(),
  /** Add the append-only audit trail rows (created / status_changed / …). */
  include_audit: z.boolean().optional(),
});
export type MemoryGetInput = z.infer<typeof MemoryGetInputSchema>;

export const MemoryGetOutputSchema = z.looseObject({
  memory: MemoryRecordSchema,
  /** The full record's token estimate (content + title + summary chars / 4). */
  token_estimate: TokenTotal,
  history: z
    .array(
      z.looseObject({
        id: z.uuid(),
        type: z.string(),
        title: z.string().optional(),
        content: z.string(),
        status: z.string(),
        valid_from: isoTimestamp,
        valid_until: isoTimestamp.optional(),
        superseded_by: optionalUuid,
      }),
    )
    .optional(),
  audit: z
    .array(
      z.looseObject({
        action: z.string(),
        from_status: z.string().nullable().optional(),
        to_status: z.string().nullable().optional(),
        actor: z.string(),
        at: isoTimestamp,
      }),
    )
    .optional(),
});
export type MemoryGetOutput = z.infer<typeof MemoryGetOutputSchema>;

// ---------------------------------------------------------------------------
// memory_store
// ---------------------------------------------------------------------------

export const MemoryStoreInputSchema = z.looseObject({
  /** Canonical, self-contained statement (must be interpretable without the conversation). */
  content: z.string().min(1).max(4000),
  type: z.enum(DURABLE_MEMORY_TYPES),
  title: z.string().max(80).optional(),
  subtype: z.string().max(120).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().min(1).max(64)).max(24).optional(),
  project_id: optionalUuid,
  /** explicit.remember scope vocabulary (event-memory-schemas.md §2). */
  scope: z.enum(['project', 'user', 'global']).optional(),
  /** When the fact became true (default: now). */
  observed_at: isoTimestamp.optional(),
  valid_from: isoTimestamp.optional(),
  valid_until: isoTimestamp.optional(),
  source_uri: z.string().max(500).optional(),
  source_title: z.string().max(200).optional(),
  /** Provenance: ≥ 1 span is mandatory for durable writes (memory-model.md §6). */
  evidence: z.array(EvidenceInputSchema).max(10).optional(),
  /** Explicitly replace this memory (append-only supersession; the loser stays as history). */
  supersedes: z.uuid().optional(),
  entities: z.array(EntityInputSchema).max(10).optional(),
  reason: z.string().max(500).optional(),
});
export type MemoryStoreInput = z.infer<typeof MemoryStoreInputSchema>;

export const MemoryStoreOutputSchema = z.looseObject({
  /** The durable memory id (existing id when outcome is "merged"). */
  id: z.uuid(),
  outcome: z.enum(['new', 'merged', 'superseded']),
  /** Set when outcome is "merged": the existing memory that absorbed this write. */
  existing_id: optionalUuid,
  /** Set when outcome is "superseded": the memory this one replaced. */
  superseded_id: optionalUuid,
  /** Secrets removed before persisting (count + kind/location only — values never stored). */
  redactions: z.array(z.looseObject({ kind: z.string(), location: z.string(), length: z.number().int().min(0) })),
  warnings: z.array(z.string()),
  token_estimate: TokenTotal,
});
export type MemoryStoreOutput = z.infer<typeof MemoryStoreOutputSchema>;

// ---------------------------------------------------------------------------
// memory_update
// ---------------------------------------------------------------------------

export const MemoryUpdateInputSchema = z.looseObject({
  id: z.uuid(),
  /** Optimistic concurrency: the `updated_at` revision token from your last read. */
  expected_revision: z.string().min(1),
  /** New canonical statement. Must actually change (metadata-only edits are rejected). */
  content: z.string().min(1).max(4000).optional(),
  title: z.string().max(80).optional(),
  type: z.enum(DURABLE_MEMORY_TYPES).optional(),
  subtype: z.string().max(120).optional(),
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string().min(1).max(64)).max(24).optional(),
  /** Temporal window of the new revision (must start after the old revision's valid_from). */
  valid_from: isoTimestamp.optional(),
  valid_until: isoTimestamp.optional(),
  observed_at: isoTimestamp.optional(),
  /** Fresh provenance for the corrected statement (defaults to the old record's evidence). */
  evidence: z.array(EvidenceInputSchema).max(10).optional(),
  reason: z.string().max(500).optional(),
});
export type MemoryUpdateInput = z.infer<typeof MemoryUpdateInputSchema>;

export const MemoryUpdateOutputSchema = z.looseObject({
  /** The NEW revision's id — use this id from now on (the update mints a new record). */
  id: z.uuid(),
  /** The id you passed in — now superseded, still queryable as history. */
  previous_id: z.uuid(),
  outcome: z.literal('superseded'),
  /** The new revision token (pass this as expected_revision on the next update). */
  revision: z.string(),
  redactions: z.array(z.looseObject({ kind: z.string(), location: z.string(), length: z.number().int().min(0) })),
  warnings: z.array(z.string()),
  token_estimate: TokenTotal,
});
export type MemoryUpdateOutput = z.infer<typeof MemoryUpdateOutputSchema>;

// ---------------------------------------------------------------------------
// memory_delete / memory_forget
// ---------------------------------------------------------------------------

export const MemoryDeleteInputSchema = z.looseObject({
  id: z.uuid(),
  /** Purges are never accidental: the revision token from your last read is required. */
  expected_revision: z.string().min(1),
  reason: z.string().max(500).optional(),
});
export type MemoryDeleteInput = z.infer<typeof MemoryDeleteInputSchema>;

/**
 * The hard-purge result contract, backed by `Store.deleteMemory`: the memories row and its
 * cascaded vectors/bindings/edges/payload rows are deleted, and a 'purged' audit row survives
 * the deletion (memory_events is FK-less by design).
 */
export const MemoryDeleteOutputSchema = z.looseObject({
  id: z.uuid(),
  purged: z.literal(true),
  audit: z.looseObject({
    action: z.literal('purged'),
    from_status: z.string().nullable(),
    actor: z.string(),
    at: isoTimestamp,
  }),
});
export type MemoryDeleteOutput = z.infer<typeof MemoryDeleteOutputSchema>;

export const MemoryForgetInputSchema = z.looseObject({
  id: z.uuid(),
  /** Undo a previous forget (archived → active, audited as "restored"). */
  recover: z.boolean().optional(),
  expected_revision: z.string().min(1).optional(),
  reason: z.string().max(500).optional(),
});
export type MemoryForgetInput = z.infer<typeof MemoryForgetInputSchema>;

export const MemoryForgetOutputSchema = z.looseObject({
  id: z.uuid(),
  status: z.enum(['archived', 'active']),
  action: z.enum(['archived', 'restored']),
  audit: z.looseObject({
    action: z.string(),
    from_status: z.string(),
    to_status: z.string(),
    actor: z.string(),
    at: isoTimestamp,
  }),
  /** A tombstone is always recoverable (recover: true on this same tool). */
  recoverable: z.boolean(),
  redactions: z.array(z.looseObject({ kind: z.string(), location: z.string(), length: z.number().int().min(0) })),
  token_estimate: TokenTotal,
});
export type MemoryForgetOutput = z.infer<typeof MemoryForgetOutputSchema>;

// ---------------------------------------------------------------------------
// memory_related
// ---------------------------------------------------------------------------

export const MemoryRelatedInputSchema = z.looseObject({
  id: z.uuid(),
  relations: z.array(z.enum(EDGE_RELATIONS)).max(11).optional(),
  direction: z.enum(['both', 'outgoing', 'incoming']).optional(),
  /** Include edges whose validity window has expired. */
  include_expired: z.boolean().optional(),
  max: z.number().int().min(1).max(50).optional(),
});
export type MemoryRelatedInput = z.infer<typeof MemoryRelatedInputSchema>;

export const MemoryRelatedOutputSchema = z.looseObject({
  id: z.uuid(),
  related: z.array(
    z.looseObject({
      memory: MemoryRecordSchema,
      relation: z.enum(EDGE_RELATIONS),
      direction: z.enum(['outgoing', 'incoming']),
    }),
  ),
  token_estimate: TokenTotal,
});
export type MemoryRelatedOutput = z.infer<typeof MemoryRelatedOutputSchema>;

// ---------------------------------------------------------------------------
// memory_project_context
// ---------------------------------------------------------------------------

export const MemoryProjectContextInputSchema = z.looseObject({
  project_id: optionalUuid,
  /** Token budget for the packed context block (default 750, hard cap 4000). */
  budget: z.number().int().min(1).max(4000).optional(),
});
export type MemoryProjectContextInput = z.infer<typeof MemoryProjectContextInputSchema>;

export const MemoryProjectContextOutputSchema = z.looseObject({
  project_id: z.uuid(),
  budget: TokenTotal,
  used: TokenTotal,
  token_estimate: TokenTotal,
  /** The assembled, ready-to-inject context block (sections joined by a blank line). */
  text: z.string(),
  sections: z.array(
    z.looseObject({
      kind: z.enum(['digest', 'decisions', 'failures', 'procedures', 'preferences']),
      tokens: TokenTotal,
      text: z.string(),
    }),
  ),
  warnings: z.array(z.string()),
});
export type MemoryProjectContextOutput = z.infer<typeof MemoryProjectContextOutputSchema>;

// ---------------------------------------------------------------------------
// full11: curated lists
// ---------------------------------------------------------------------------

export const MemoryDecisionsInputSchema = z.looseObject({
  project_id: optionalUuid,
  limit: z.number().int().min(1).max(50).optional(),
  as_of: isoTimestamp.optional(),
});
export type MemoryDecisionsInput = z.infer<typeof MemoryDecisionsInputSchema>;

export const MemoryDecisionsOutputSchema = z.looseObject({
  results: z.array(
    MemoryIndexEntrySchema.extend({
      decided_at: isoTimestamp,
      rationale: z.string().optional(),
    }),
  ),
  warnings: z.array(z.string()),
  token_estimate: TokenTotal,
});
export type MemoryDecisionsOutput = z.infer<typeof MemoryDecisionsOutputSchema>;

export const MemoryFailuresInputSchema = z.looseObject({
  project_id: optionalUuid,
  limit: z.number().int().min(1).max(50).optional(),
  as_of: isoTimestamp.optional(),
});
export type MemoryFailuresInput = z.infer<typeof MemoryFailuresInputSchema>;

export const MemoryFailuresOutputSchema = z.looseObject({
  results: z.array(
    MemoryIndexEntrySchema.extend({
      /** open | mitigated | solved | verified (failures payload status). */
      failure_status: z.string(),
      solution: z.string().optional(),
      occurrence_count: z.number().int().min(1),
      last_seen_at: isoTimestamp,
    }),
  ),
  warnings: z.array(z.string()),
  token_estimate: TokenTotal,
});
export type MemoryFailuresOutput = z.infer<typeof MemoryFailuresOutputSchema>;

export const MemorySkillsInputSchema = z.looseObject({
  project_id: optionalUuid,
  limit: z.number().int().min(1).max(50).optional(),
  /** Hard ceiling for the packed list (default 500 — the skills serving budget). */
  max_tokens: z.number().int().min(1).max(4000).optional(),
  /**
   * Which skill statuses to serve (default: promoted + verified — the consumable list the
   * runtimes pick up; candidates await the `onemem skills review` flow, ADR-0009 rule 2).
   */
  statuses: z.array(z.enum(SKILL_STATUSES)).max(4).optional(),
});
export type MemorySkillsInput = z.infer<typeof MemorySkillsInputSchema>;

export const MemorySkillsOutputSchema = z.looseObject({
  results: z.array(
    MemoryIndexEntrySchema.extend({
      /** kebab-case skill name (the directory name and the loader key). */
      name: z.string().optional(),
      /** Semver of the served SKILL.md. */
      version: z.string().optional(),
      /** Project-relative artifact path, `skills/<name>/SKILL.md` (promote writes it). */
      path: z.string().optional(),
    }),
  ),
  /** The budget accounting (progressive disclosure, ADR-0010 §3). */
  tokens: z.looseObject({
    budget: TokenTotal,
    used: TokenTotal,
    packing: z.enum(['summary', 'title-only']),
  }),
  warnings: z.array(z.string()),
  token_estimate: TokenTotal,
});
export type MemorySkillsOutput = z.infer<typeof MemorySkillsOutputSchema>;

// ---------------------------------------------------------------------------
// The registry: name → input/output schema pair (server.ts wires handlers to this)
// ---------------------------------------------------------------------------

export interface ToolSchemaSpec {
  readonly input: z.ZodType;
  readonly output: z.ZodType;
}

export const TOOL_SCHEMAS: Readonly<Record<ToolName, ToolSchemaSpec>> = {
  memory_search: { input: MemorySearchInputSchema, output: MemorySearchOutputSchema },
  memory_get: { input: MemoryGetInputSchema, output: MemoryGetOutputSchema },
  memory_store: { input: MemoryStoreInputSchema, output: MemoryStoreOutputSchema },
  memory_update: { input: MemoryUpdateInputSchema, output: MemoryUpdateOutputSchema },
  memory_delete: { input: MemoryDeleteInputSchema, output: MemoryDeleteOutputSchema },
  memory_forget: { input: MemoryForgetInputSchema, output: MemoryForgetOutputSchema },
  memory_related: { input: MemoryRelatedInputSchema, output: MemoryRelatedOutputSchema },
  memory_project_context: {
    input: MemoryProjectContextInputSchema,
    output: MemoryProjectContextOutputSchema,
  },
  memory_decisions: { input: MemoryDecisionsInputSchema, output: MemoryDecisionsOutputSchema },
  memory_failures: { input: MemoryFailuresInputSchema, output: MemoryFailuresOutputSchema },
  memory_skills: { input: MemorySkillsInputSchema, output: MemorySkillsOutputSchema },
};

/**
 * The shape every error result's structuredContent carries (the SDK skips outputSchema
 * validation for `isError: true` results, so this is validated only by our own tests).
 */
export const ToolErrorPayloadSchema = z.looseObject({
  error: z.looseObject({
    code: z.string(),
    message: z.string(),
    /** e.g. { current_revision } on revision_conflict, { memory_id } on not_found. */
    details: z.record(z.string(), z.unknown()).optional(),
  }),
});
export type ToolErrorPayload = z.infer<typeof ToolErrorPayloadSchema>;
