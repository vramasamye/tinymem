/**
 * Memory wire representation + typed payloads — a 1:1 Zod mirror of
 * `event-memory-schemas.md` §4–§5. This is what `GET /v1/memories/:id`, MCP `memory_get`, and
 * `onemem inspect` return.
 */

import { z } from 'zod';

import {
  DECISION_STATUSES,
  FAILURE_STATUSES,
  MEMORY_STATUSES,
  MEMORY_TYPES,
  SKILL_STATUSES,
} from '../model/types';

import { EvidenceSpanSchema } from './extraction';

const isoTimestamp = z.iso.datetime();

// ---------------------------------------------------------------------------
// §5 Typed payloads
// ---------------------------------------------------------------------------

export const DecisionPayloadSchema = z.looseObject({
  title: z.string().min(1),
  /** What was decided. */
  decision: z.string().min(1),
  alternatives: z.array(
    z.looseObject({
      option: z.string(),
      why_rejected: z.string().optional(),
    }),
  ),
  /** Optional like the `decisions.rationale` column: absent when the source stated none (M3d — never fabricated). */
  rationale: z.string().optional(),
  /** Roles/names — never emails. */
  participants: z.array(z.string()),
  decided_at: isoTimestamp,
  status: z.enum(DECISION_STATUSES),
  evidence: z.array(EvidenceSpanSchema),
});
export type DecisionPayload = z.infer<typeof DecisionPayloadSchema>;

/**
 * The STORE-stage input projection of {@link DecisionPayloadSchema} (M3d): exactly the fields
 * the `decisions` table persists. The wire payload's `evidence` is a read-time echo of the memory
 * row's own evidence spans (the table has no evidence column), so it is deliberately not part of
 * the store input. Readback always uses the owning memory's canonical evidence.
 */
export const DecisionStorePayloadSchema = DecisionPayloadSchema.omit({ evidence: true });
export type DecisionStorePayload = z.infer<typeof DecisionStorePayloadSchema>;

export const FailurePayloadSchema = z.looseObject({
  problem: z.string().min(1),
  /** Environment, limits, versions. */
  context: z.string().min(1),
  root_cause: z.string().optional(),
  /** Empty until solved. */
  solution: z.string().optional(),
  /** How the fix was proven (command output digest, test result). */
  verification: z.string().optional(),
  status: z.enum(FAILURE_STATUSES),
  /**
   * The recurrence fingerprint (ADR-0009 rule 1) — `failures.signature_hash`, the digest the
   * extraction stage computed (`FailureSignatureSchema.hash`), stored exactly as received.
   * Optional on the wire for pre-M3d records; required for new STORE payload writes.
   */
  signature_hash: z.string().min(1).optional(),
  first_seen_at: isoTimestamp,
  last_seen_at: isoTimestamp,
  /** Incremented on signature match (M14 — the STORE wiring records the initial 1). */
  occurrence_count: z.number().int().min(1),
});
export type FailurePayload = z.infer<typeof FailurePayloadSchema>;

/** STORE cannot omit the NOT NULL signature column, unlike legacy wire records. */
export const FailureStorePayloadSchema = FailurePayloadSchema.extend({
  signature_hash: z.string().min(1),
});
export type FailureStorePayload = z.infer<typeof FailureStorePayloadSchema>;

export const SkillPayloadSchema = z.looseObject({
  /** kebab-case, directory name. */
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'skill name must be kebab-case'),
  description: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'skill version must be semver'),
  status: z.enum(SKILL_STATUSES),
  source: z.looseObject({
    failure_ids: z.array(z.uuid()),
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
});
export type SkillPayload = z.infer<typeof SkillPayloadSchema>;

export const MemoryPayloadSchema = z.union([
  DecisionPayloadSchema,
  FailurePayloadSchema,
  SkillPayloadSchema,
]);
export type MemoryPayload = z.infer<typeof MemoryPayloadSchema>;

// ---------------------------------------------------------------------------
// §4 Memory wire representation
// ---------------------------------------------------------------------------

export const MemoryRecordSchema = z.looseObject({
  id: z.uuid(),
  type: z.enum(MEMORY_TYPES),
  subtype: z.string().optional(),
  title: z.string().optional(),
  content: z.string(),
  content_summary: z.string().optional(),
  status: z.enum(MEMORY_STATUSES),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  access_count: z.number().int().min(0),
  last_accessed_at: isoTimestamp.optional(),
  observed_at: isoTimestamp,
  valid_from: isoTimestamp,
  valid_until: isoTimestamp.optional(),
  created_at: isoTimestamp,
  updated_at: isoTimestamp,
  superseded_by: z.uuid().optional(),
  project_id: z.uuid().optional(),
  user_id: z.uuid().optional(),
  agent_id: z.string().optional(),
  provenance: z.looseObject({
    source: z.looseObject({
      id: z.uuid(),
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
      id: z.uuid(),
      name: z.string(),
      kind: z.string(),
    }),
  ),
  tags: z.array(z.string()),
  token_estimate: z.number().int().min(0),
  /** Per type, §5. */
  payload: MemoryPayloadSchema.optional(),
});
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;
