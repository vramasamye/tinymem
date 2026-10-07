/**
 * The LLM extraction prompt and its output schema (ADR-0006 §2: structured output with Zod
 * validation, never trust JSON-shaped output).
 *
 * The model is asked for **event indexes**, not evidence spans: it cannot invent a `source_id`,
 * and the extractor binds every candidate back to a real event with a real provenance anchor. A
 * candidate whose indexes do not resolve is dropped — the provenance invariant (memory-model.md
 * §6) is not negotiable.
 */

import { EXTRACTED_MEMORY_TYPES, WORKING_MEMORY_KINDS } from '@onememory-ai/core';
import { z } from 'zod';

import { normalizedDigestLine, type NormalizedEvent } from '../events';

export const EXTRACTION_PROMPT_VERSION = 'extract-v2';

/**
 * Tolerant mirror of `DecisionExtractionSchema` for model output (M3b): a model that returns
 * `rationale: null` or an over-long option must not burn a retry, so the boundary tolerates it and
 * `parseDecisionPayload()` normalizes the salvageable parts into the canonical payload.
 *
 * Failure signatures are deliberately NOT requested from the model: the digest is computed
 * deterministically by the extractor from the evidence events, so both extractor paths produce the
 * same signature for the same failure.
 */
export const LLM_DECISION_PAYLOAD_SCHEMA = z.object({
  decision: z.string().min(1).max(300),
  alternatives: z
    .array(
      z.object({
        option: z.string().min(1).max(200),
        why_rejected: z.string().max(200).nullish(),
      }),
    )
    .max(6)
    .default([]),
  rationale: z.string().max(300).nullish(),
});

export const LLM_EXTRACTION_SCHEMA = z.object({
  memories: z.array(
    z.object({
      /** `semantic_candidate` for derived facts: single observations never become `semantic`. */
      type: z.enum(EXTRACTED_MEMORY_TYPES),
      content: z.string().min(1).max(500),
      title: z.string().max(80).optional(),
      subtype: z.string().optional(),
      importance: z.number().min(0).max(1),
      confidence: z.number().min(0).max(1),
      entities: z.array(z.string()).default([]),
      /** Indexes into the numbered event digest; ≥ 1 required (provenance). */
      event_indexes: z.array(z.number().int().min(0)).min(1),
      /** One clause explaining why this is worth remembering (the future-value gate). */
      future_value_rationale: z.string().min(1),
      /** Structured decision capture (M3b), for `decision` memories only. */
      decision_payload: LLM_DECISION_PAYLOAD_SCHEMA.nullish(),
      valid_from: z.string().optional(),
      valid_until: z.string().optional(),
    }),
  ),
  working: z
    .array(
      z.object({
        kind: z.enum(WORKING_MEMORY_KINDS),
        content: z.string().min(1).max(300),
        event_indexes: z.array(z.number().int().min(0)).min(1),
      }),
    )
    .default([]),
  session_summary: z.string().max(500).optional(),
});
export type LlmExtractionOutput = z.infer<typeof LLM_EXTRACTION_SCHEMA>;

export interface ExtractionPromptOptions {
  /** Max events included in the prompt (default 60). */
  maxEvents?: number;
  /** Max total prompt characters (default 24000). */
  maxChars?: number;
}

export interface ExtractionPrompt {
  system: string;
  prompt: string;
  /** Index → event, so `event_indexes` in the response resolve to real evidence. */
  included: NormalizedEvent[];
}

export const EXTRACTION_SYSTEM_PROMPT = [
  'You extract durable memories from a coding agent session for a persistent memory engine.',
  'You are given a numbered list of events (conversation messages, terminal commands, errors,',
  'test results, file changes, commits, documents).',
  '',
  'Return ONLY a JSON object with this shape:',
  '{"memories":[{"type":"episodic|semantic_candidate|procedural|decision|failure|preference",',
  '"content":"canonical self-contained statement, max 500 chars","title":"optional, max 80 chars",',
  '"subtype":"optional free-form refinement","importance":0.0,"confidence":0.0,',
  '"entities":["mentioned names"],"event_indexes":[0],"future_value_rationale":"one clause",',
  '"decision_payload":{"decision":"the chosen option","alternatives":[{"option":"the rejected',
  ' option","why_rejected":"why, when stated"}],"rationale":"why the choice was made"}',
  ' (decision memories only, omit otherwise),',
  '"valid_from":"optional ISO timestamp","valid_until":"optional ISO timestamp"}],',
  '"working":[{"kind":"task|hypothesis|current_file|current_error|temp_decision|open_question",',
  '"content":"session-scoped note, max 300 chars","event_indexes":[0]}],',
  '"session_summary":"optional, max 500 chars"}',
  '',
  'Rules:',
  '- Every memory MUST cite at least one event index in event_indexes; never invent a source.',
  '- content must be interpretable without the transcript (no pronouns, no "the file above").',
  '- importance = future value to a future session; confidence = how certain the evidence is.',
  '- future_value_rationale is mandatory: if you cannot justify the memory, do not emit it.',
  '- A fact observed once is type "semantic_candidate", NEVER "semantic": consolidation decides.',
  '- Use "decision" for settled choices (include alternatives in content when stated), "failure"',
  '  for errors with a resolution, "preference" for stated user/project preferences,',
  '  "procedural" for repeatable procedures, "episodic" for observations and stack mentions.',
  '- For a "decision" memory, fill decision_payload from what the transcript actually says: the',
  '  chosen option, the alternatives considered (with why_rejected only when stated), and the',
  '  rationale. Never invent an alternative or a reason that is not in the events.',
  '- Do NOT emit a failure signature or hash: the engine computes it from the cited events.',
  '- Put session-scoped scratch context (current task, open question, hypothesis, unresolved',
  '  error, file being edited) in "working", not in "memories".',
  '- Discard small talk, acknowledgements, and anything with no future value.',
  '- Emit no prose, no markdown fences, only the JSON object.',
].join('\n');

export function buildExtractionPrompt(
  events: readonly NormalizedEvent[],
  options: ExtractionPromptOptions = {},
): ExtractionPrompt {
  const maxEvents = options.maxEvents ?? 60;
  const maxChars = options.maxChars ?? 24_000;
  const included: NormalizedEvent[] = [];
  const lines: string[] = [];
  let used = 0;

  for (const event of events) {
    if (included.length >= maxEvents) break;
    const line = normalizedDigestLine(event, included.length);
    if (used + line.length > maxChars) break;
    used += line.length + 1;
    lines.push(line);
    included.push(event);
  }

  return {
    system: EXTRACTION_SYSTEM_PROMPT,
    prompt: ['Events:', ...lines, '', 'Extract the durable memories as JSON.'].join('\n'),
    included,
  };
}
