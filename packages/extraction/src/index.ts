/**
 * `@onememory/extraction` — EXTRACT (stage 4) + CLASSIFY (stage 5) implementations.
 *
 * `createHeuristicExtractor()` is the zero-LLM correctness baseline; `createLlmExtractor({router})`
 * adds recall behind the model router; `createFallbackExtractor(llm, heuristic)` is the pipeline's
 * degradation policy. The classifier owns type/subtype assignment and the working-vs-durable
 * routing decision. `createNormalizeHandler` / `createExtractHandler` are the job handler
 * factories M13 wires into the daemon.
 */

// Shared vocabulary and errors
export {
  DEFAULT_THRESHOLDS,
  HEURISTIC_PROMPT_VERSION,
  ExtractionOutputError,
  ExtractionUnavailableError,
  NormalizationError,
  type ClassifiedMemory,
  type ExtractionThresholds,
} from './types';

// Stage 3 NORMALIZE (pure transform + payload parsing)
export {
  buildEvidence,
  eventDigestLine,
  eventTextForMatching,
  normalizeCommand,
  normalizeEvent,
  normalizedDigestLine,
  sourceKindForEvent,
  storedEventToEnvelope,
  NormalizedBatchSchema,
  NormalizedEventSchema,
  type EvidenceEventRef,
  type NormalizedEvent,
} from './events';

// Stage 4 EXTRACT
export { createHeuristicExtractor, type HeuristicExtractorOptions } from './heuristic/extractor';
export {
  buildExtractionPrompt,
  EXTRACTION_PROMPT_VERSION,
  EXTRACTION_SYSTEM_PROMPT,
  LLM_EXTRACTION_SCHEMA,
  type ExtractionPrompt,
  type ExtractionPromptOptions,
  type LlmExtractionOutput,
} from './llm/prompt';
export { createLlmExtractor, type LlmExtractor, type LlmExtractorOptions } from './llm/extractor';
export { createFallbackExtractor, type FallbackExtractorOptions } from './fallback';

// Stage 5 CLASSIFY
export {
  createHeuristicClassifier,
  EXPLICIT_SEMANTIC_SUBTYPE,
  type Classifier,
  type WorkingSignal,
  type WorkingSignalInput,
} from './classifier';

// Future-value gate
export { createFutureValueGate, type FutureValueGate, type GateDecision } from './gate';

// Heuristic vocabulary (exported so M3b and the M11 benchmarks can extend it deliberately)
export {
  COMMAND_DENYLIST,
  DECISION_PATTERNS,
  extractTechMentions,
  isDeniedCommand,
  PREFERENCE_PATTERNS,
  VERSION_PATTERNS,
} from './heuristic/patterns';

// Job handler factories (M13 wiring)
export {
  createNormalizeHandler,
  parseNormalizedBatch,
  type NormalizeHandlerOptions,
  type NormalizeHandlerResult,
  type NormalizeJobLike,
} from './handlers/normalize';
export {
  createExtractHandler,
  type ExtractHandlerOptions,
  type ExtractHandlerResult,
  type ExtractJobLike,
} from './handlers/extract';
