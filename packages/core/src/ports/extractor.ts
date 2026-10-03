/**
 * EXTRACT stage port (memory-model.md §8 stage 4): normalized events → candidate memories as a
 * schema-validated `ExtractionResult`. Implemented by `packages/extraction` (M3) — LLM via the
 * model router with a heuristic no-LLM fallback; local AI improves quality, it is never a
 * correctness prerequisite.
 */

import type { OnememoryEvent } from '../schema/event';
import type { ExtractionResult } from '../schema/extraction';
import type { SourceRef } from './records';

export interface ExtractionInput {
  event: OnememoryEvent;
  source: SourceRef;
}

export interface Extractor {
  extract(inputs: ExtractionInput[]): Promise<ExtractionResult>;
}
