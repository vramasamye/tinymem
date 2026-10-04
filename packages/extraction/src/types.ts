/**
 * `@onememory/extraction` — the EXTRACT (stage 4) and CLASSIFY (stage 5) stage implementations
 * (memory-model.md §8, event-memory-schemas.md §3).
 *
 * Two extractors, one contract:
 * - `createHeuristicExtractor()` — the **correctness baseline**: zero LLM, zero network, explicit
 *   language patterns, error+resolution pairing, recurring-command detection, versioned facts,
 *   stack mentions. Lower recall than an LLM, correct shape, always available.
 * - `createLlmExtractor({ router })` — batch prompt over event digests via the model router
 *   (operation `extract`), structured output validated against a Zod schema, evidence spans bound
 *   back to real events. Never load-bearing: the extract job falls back to heuristics.
 *
 * Both apply the **future-value gate**: a candidate without a rationale, without evidence, or
 * below the importance/confidence floor is discarded, not stored (event-memory-schemas.md §3).
 */

import type { ExtractedMemoryType } from '@onememory/core';

/**
 * `extraction_meta.prompt_version` for the heuristic extractor. Bumped to `heuristic-v2` when M3b
 * added decision alternatives/rationale capture, failure signatures, and failing-test incidents —
 * stored provenance must be able to tell which rule set produced a memory.
 */
export const HEURISTIC_PROMPT_VERSION = 'heuristic-v2';

export interface ExtractionThresholds {
  /** Future-value gate: candidates below this importance are discarded. */
  min_importance: number;
  /** Future-value gate: semantic candidates below this confidence are discarded. */
  min_confidence: number;
  /** Cap per batch after sorting by importance (token/pollution control). */
  max_memories: number;
  /** Cap on session-scoped working notes per batch. */
  max_working: number;
  /** Recurring single command threshold (task brief: ≥ 2 occurrences). */
  min_command_occurrences: number;
  /** Recurring command-sequence threshold (≥ 2 occurrences). */
  min_sequence_occurrences: number;
  /** Working-memory TTL from the last observed event (memory-model.md §10). */
  working_ttl_hours: number;
}

export const DEFAULT_THRESHOLDS: ExtractionThresholds = {
  min_importance: 0.45,
  min_confidence: 0.5,
  max_memories: 50,
  max_working: 20,
  min_command_occurrences: 2,
  min_sequence_occurrences: 2,
  working_ttl_hours: 24,
};

/** Normalization failure (stage 3): the event is flagged `needs_review`, never dropped. */
export class NormalizationError extends Error {
  constructor(
    message: string,
    public readonly eventId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'NormalizationError';
  }
}

/** The router could not serve the `extract` operation — the caller degrades to heuristics. */
export class ExtractionUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ExtractionUnavailableError';
  }
}

/** The model router was reached but never produced schema-valid output within the retry budget. */
export class ExtractionOutputError extends Error {
  constructor(
    message: string,
    public readonly attempts: number,
    public readonly providerId: string,
    public readonly lastRaw?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ExtractionOutputError';
  }
}

/** What the durable type of a classified candidate is, and why. */
export interface ClassifiedMemory {
  type: ExtractedMemoryType;
  subtype?: string;
  /**
   * The type the STORE stage writes. `semantic_candidate` is never stored as `semantic`
   * (ADR-0003 rule 7) — it is stored as an episodic observation awaiting consolidation, unless it
   * came from an explicit user statement (`semantic.explicit`), which memory-model.md §9 permits.
   */
  durable_type: 'episodic' | 'semantic' | 'procedural' | 'decision' | 'failure' | 'preference';
  /** True when the candidate must be tagged as awaiting consolidation. */
  awaiting_consolidation: boolean;
}
