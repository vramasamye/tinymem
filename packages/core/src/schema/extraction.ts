/**
 * Extraction output schemas — a 1:1 Zod mirror of `event-memory-schemas.md` §3.
 * The EXTRACT stage (LLM or heuristic) MUST emit this exact shape; structured,
 * schema-validated — a retry with the validation error is cheaper than corrupting memory.
 */

import { z } from 'zod';

import {
  EDGE_RELATIONS,
  EVIDENCE_SPAN_KINDS,
  EXTRACTED_MEMORY_TYPES,
  WORKING_MEMORY_KINDS,
} from '../model/types';

const isoTimestamp = z.iso.datetime();

export const EvidenceSpanSchema = z.looseObject({
  source_id: z.uuid(),
  kind: z.enum(EVIDENCE_SPAN_KINDS),
  /** e.g. "session.jsonl:183", "commit:abc123", "lines 4-9". */
  locator: z.string().min(1),
  excerpt: z.string().max(200),
});
export type EvidenceSpan = z.infer<typeof EvidenceSpanSchema>;

export const RelationTypeSchema = z.enum(EDGE_RELATIONS);
export type { RelationType } from '../model/types';

export const ExtractedMemorySchema = z.looseObject({
  type: z.enum(EXTRACTED_MEMORY_TYPES),
  /** Canonical, self-contained statement. */
  content: z.string().min(1).max(500),
  title: z.string().max(80).optional(),
  subtype: z.string().optional(),
  importance: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  /** Mentioned entity names (resolved later by the ENTITY RESOLUTION stage). */
  entities: z.array(z.string()),
  relationships: z
    .array(
      z.looseObject({
        target: z.string(),
        relation: RelationTypeSchema,
      }),
    )
    .optional(),
  /** Project hint, if derivable. */
  project: z.string().optional(),
  /** Mandatory for durable memories: ≥ 1 span (provenance invariant, ADR-0003 rule 4). */
  evidence: z.array(EvidenceSpanSchema).min(1),
  valid_from: isoTimestamp.optional(),
  valid_until: isoTimestamp.optional(),
  /** One clause: why this is worth remembering (the future-value gate, §3). */
  future_value_rationale: z.string().optional(),
});
export type ExtractedMemory = z.infer<typeof ExtractedMemorySchema>;

export const WorkingCandidateSchema = z.looseObject({
  kind: z.enum(WORKING_MEMORY_KINDS),
  content: z.string().min(1).max(300),
  session_id: z.string().min(1),
});
export type WorkingCandidate = z.infer<typeof WorkingCandidateSchema>;

export const ExtractionResultSchema = z.looseObject({
  memories: z.array(ExtractedMemorySchema),
  /** Session-scoped notes worth keeping temporarily. */
  working: z.array(WorkingCandidateSchema),
  session_summary: z.string().max(500).optional(),
  extraction_meta: z.looseObject({
    method: z.enum(['llm', 'heuristic']),
    model: z.string().optional(),
    prompt_version: z.string().min(1),
  }),
});
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
