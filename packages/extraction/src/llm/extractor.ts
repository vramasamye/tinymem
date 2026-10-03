/**
 * The LLM extractor (ADR-0006 §1: extraction uses a cheap/medium model **if configured**;
 * heuristics otherwise — the model is never load-bearing).
 *
 * Flow: normalized batch → numbered digest prompt → `ModelRouter.generateStructured` (operation
 * `extract`, Zod-validated, bounded retry on invalid JSON) → evidence binding → the same
 * future-value gate the heuristic extractor uses → schema-valid `ExtractionResult`.
 *
 * Failure semantics: an unavailable route raises `ExtractionUnavailableError` so the caller can
 * fall back to heuristics (`createFallbackExtractor`); a provider that never produces valid output
 * raises `ExtractionOutputError` carrying the attempt count and the last raw text.
 */

import {
  ExtractionResultSchema,
  type EvidenceSpan,
  type ExtractedMemory,
  type ExtractionInput,
  type ExtractionResult,
  type Extractor,
  type WorkingCandidate,
} from '@onememory/core';
import { RouterUnavailableError, type ModelOperation, type ModelRouter } from '@onememory/llm';

import { buildEvidence, normalizeEvent, type NormalizedEvent } from '../events';
import { createFutureValueGate } from '../gate';
import {
  DEFAULT_THRESHOLDS,
  ExtractionOutputError,
  ExtractionUnavailableError,
  type ExtractionThresholds,
} from '../types';

import { EXTRACTION_PROMPT_VERSION, LLM_EXTRACTION_SCHEMA, buildExtractionPrompt } from './prompt';

export interface LlmExtractorOptions {
  router: ModelRouter;
  /** Routing-table operation (default `extract`). */
  operation?: ModelOperation;
  thresholds?: Partial<ExtractionThresholds>;
  maxEvents?: number;
  maxChars?: number;
  maxRetries?: number;
}

export interface LlmExtractor extends Extractor {
  /** Last model id used, for diagnostics/`system_state` (null before the first call). */
  readonly lastModel: string | null;
}

export function createLlmExtractor(options: LlmExtractorOptions): LlmExtractor {
  const operation: ModelOperation = options.operation ?? 'extract';
  const gate = createFutureValueGate({ thresholds: options.thresholds });
  let lastModel: string | null = null;

  return {
    get lastModel(): string | null {
      return lastModel;
    },

    async extract(inputs: ExtractionInput[]): Promise<ExtractionResult> {
      const normalized: NormalizedEvent[] = [];
      const sourceByEventId = new Map<string, string>();
      for (const input of inputs) {
        sourceByEventId.set(input.event.id, input.source.id);
        try {
          normalized.push(normalizeEvent(input));
        } catch {
          // Malformed payloads are flagged `needs_review` upstream; skip them here.
        }
      }
      normalized.sort((a, b) => a.occurred_at.localeCompare(b.occurred_at));

      const { system, prompt, included } = buildExtractionPrompt(normalized, {
        ...(options.maxEvents === undefined ? {} : { maxEvents: options.maxEvents }),
        ...(options.maxChars === undefined ? {} : { maxChars: options.maxChars }),
      });

      let generated;
      try {
        generated = await options.router.generateStructured({
          operation,
          schema: LLM_EXTRACTION_SCHEMA,
          schemaName: 'ExtractionResult',
          schemaDescription:
            'Durable memories extracted from a coding-agent session, each citing supporting event indexes',
          system,
          prompt,
          ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        });
      } catch (error) {
        if (error instanceof RouterUnavailableError) {
          throw new ExtractionUnavailableError(
            `model router has no route for operation '${operation}': ${error.message}`,
            { cause: error },
          );
        }
        throw error;
      }

      if (!generated.ok) {
        throw new ExtractionOutputError(
          generated.error.message,
          generated.error.attempts,
          generated.error.provider_id,
          generated.error.last_raw,
        );
      }

      lastModel = `${generated.route.provider_id}/${generated.route.model}`;
      const output = generated.value;

      const memories: ExtractedMemory[] = [];
      for (const candidate of output.memories) {
        const evidence: EvidenceSpan[] = [];
        for (const index of candidate.event_indexes) {
          const event = included[index];
          if (!event) continue;
          evidence.push(
            buildEvidence(
              {
                id: event.event_id,
                kind: event.kind,
                payload: event.commit ? { sha: event.commit.sha } : undefined,
              },
              sourceByEventId.get(event.event_id) ?? event.source_id,
              event.text,
            ),
          );
        }
        if (evidence.length === 0) continue; // provenance is mandatory — drop, never store
        memories.push({
          type: candidate.type,
          ...(candidate.title === undefined ? {} : { title: candidate.title }),
          ...(candidate.subtype === undefined ? {} : { subtype: candidate.subtype }),
          content: candidate.content,
          importance: candidate.importance,
          confidence: candidate.confidence,
          entities: candidate.entities,
          evidence,
          ...(candidate.valid_from === undefined ? {} : { valid_from: candidate.valid_from }),
          ...(candidate.valid_until === undefined ? {} : { valid_until: candidate.valid_until }),
          future_value_rationale: candidate.future_value_rationale,
        });
      }

      const working: WorkingCandidate[] = [];
      for (const candidate of output.working) {
        const event = candidate.event_indexes
          .map((index) => included[index])
          .find((value) => value !== undefined);
        if (!event?.session_id) continue; // working memory is session-scoped by definition
        working.push({
          kind: candidate.kind,
          content: candidate.content,
          session_id: event.session_id,
        });
      }

      const gated = gate.apply({
        memories,
        working,
        ...(output.session_summary === undefined ? {} : { session_summary: output.session_summary }),
        extraction_meta: {
          method: 'llm',
          model: lastModel ?? undefined,
          prompt_version: EXTRACTION_PROMPT_VERSION,
        },
      });

      return ExtractionResultSchema.parse(gated.result);
    },
  };
}
