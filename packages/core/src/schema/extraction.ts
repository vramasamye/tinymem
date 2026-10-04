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

/**
 * Decision capture carried by a `decision` candidate (M3b enrichment): the extraction-time subset
 * of `memory.ts`'s `DecisionPayloadSchema` (the `decisions` payload table, database-schema.md),
 * bounded for token safety. Memory-model.md §9 makes "alternatives + rationale" the precondition
 * for promoting a decision beyond `proposed`; EXTRACT captures them, the (later) STORE wiring
 * persists them.
 *
 * `title`, `participants`, `decided_at`, `status` and `evidence` are STORE-stage concerns: they
 * derive from the candidate's memory row (`title`, `observed_at`, `status` default `proposed`) and
 * the candidate's own evidence spans, so they are deliberately not part of the extraction contract.
 */
export const DecisionAlternativeSchema = z.looseObject({
  /** The option that was NOT chosen. */
  option: z.string().min(1).max(200),
  /** Why it was rejected, when the transcript states it. */
  why_rejected: z.string().min(1).max(200).optional(),
});
export type DecisionAlternative = z.infer<typeof DecisionAlternativeSchema>;

export const DecisionExtractionSchema = z.looseObject({
  /** The chosen option, verbatim minus the surrounding decision language. */
  decision: z.string().min(1).max(300),
  alternatives: z.array(DecisionAlternativeSchema).max(4),
  rationale: z.string().min(1).max(300).optional(),
});
export type DecisionExtraction = z.infer<typeof DecisionExtractionSchema>;

/** What produced a failure signature: the event kind the signature was normalized from. */
export const FAILURE_SIGNATURE_ORIGINS = ['error', 'command', 'test', 'tool'] as const;
export type FailureSignatureOrigin = (typeof FAILURE_SIGNATURE_ORIGINS)[number];

/**
 * Failure signature carried by a `failure` candidate (M3b enrichment) — the stable fingerprint
 * that makes recurrence recognition possible (ADR-0009 rule 1: "failures are fingerprinted
 * (`signature_hash` + embedding of the problem statement)").
 *
 * Field mapping to the `failures` payload table: `type`/`hash` → `signature_hash` (the digest is
 * the signature), `normalized_message` → the normalization of `problem`, `command`/`tool` →
 * `context`. `hash` covers `type` + `normalized_message` only, so the same failure reached
 * through a different tool collapses to one signature; `command`/`tool` are recorded context.
 *
 * `origin` names the event kind the signature came from: `error` (`error.raised`), `command`
 * (a non-zero `terminal.output`), `test` (`test.results` with failures), or `tool` (a failing
 * `conversation.tool_result`). `error_origin` is only ever populated for `origin: 'error'` — a
 * tool-result failure is not an `error.raised`, so it carries `origin: 'tool'` and no
 * `error_origin`.
 */
export const FAILURE_ERROR_ORIGINS = ['terminal', 'test', 'build', 'runtime', 'tool'] as const;

export const FailureSignatureSchema = z.looseObject({
  /** Normalized error class (see the enrichment rules for the ordered pattern table). */
  type: z.string().min(1).max(64),
  /** Stable digest of `type` + `normalized_message`; the recurrence key. */
  hash: z.string().min(8).max(64),
  /** The noise-normalized message the digest was computed over (reproducible by design). */
  normalized_message: z.string().min(1).max(300),
  origin: z.enum(FAILURE_SIGNATURE_ORIGINS),
  /** `error.raised.origin`, when the signature came from an error event. */
  error_origin: z.enum(FAILURE_ERROR_ORIGINS).optional(),
  /** Failing executable, tool name, or test framework, when the event carried one. */
  tool: z.string().min(1).max(80).optional(),
  /** The failing command, normalized by `normalizeCommand()`, when the failure was a command. */
  command: z.string().min(1).max(200).optional(),
});
export type FailureSignature = z.infer<typeof FailureSignatureSchema>;

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
  /**
   * Structured decision capture (M3b). Present only on `decision` candidates whose source text
   * stated alternatives and/or a rationale; `content` always remains the human-readable statement.
   */
  decision_payload: DecisionExtractionSchema.optional(),
  /**
   * Structured failure fingerprint (M3b). Present only on `failure` candidates derived from an
   * error/terminal/test failure event.
   */
  failure_signature: FailureSignatureSchema.optional(),
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
