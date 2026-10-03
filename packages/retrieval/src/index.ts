/**
 * `@onememory/retrieval` — the core `Searcher` port implementation (ADR-0004): hybrid
 * lexical/vector/graph candidate channels, hard temporal/status filtering, RRF fusion + additive
 * weighted scoring with an explain decomposition, optional rerank tier, token-budget packing,
 * session-context assembly, and explicit (never silent) degraded modes.
 *
 * The package also depends on `@onememory/storage` for the read-only candidate fetchers
 * (`searchRepo`) — SQL stays inside storage per AGENTS.md rule 5.
 */

// The engine + its construction surface
export {
  createRetrievalEngine,
  type RetrievalEngine,
  type RetrievalEngineOptions,
  type RetrievalStorage,
  type CacheStats,
} from './engine';

// Session context (spec §22; the memory_project_context building block)
export {
  buildSessionContext,
  type SessionContext,
  type SessionContextDeps,
  type SessionContextOptions,
  type SessionContextSection,
} from './session-context';

// Configuration (every weight overridable — retrieval.md §5)
export {
  DEFAULT_RETRIEVAL_CONFIG,
  DEFAULT_TYPE_AFFINITY,
  DEFAULT_HALF_LIFE_DAYS,
  DEFAULT_WEIGHTS,
  mergeConfig,
  type RetrievalConfig,
  type RetrievalConfigInput,
  type RetrievalWeights,
  type TypeAffinityMatrix,
} from './config';

// Pipeline stages (pure, exported for tests / SDK composition)
export {
  candidateFromMemory,
  candidateFromWorking,
  mergeCandidates,
  type ChannelRanks,
  type RetrievalCandidate,
} from './candidates';
export {
  classifyIntent,
  extractKeywords,
  parseTimeScope,
  understandQuery,
  type MatchedEntity,
  type QueryUnderstanding,
  type TimeScope,
} from './understand';
export { EntityIndex, type EntityIndexOptions } from './entity-index';
export {
  resolveTemporalPolicy,
  passesTemporalFilter,
  policyAt,
  type TemporalPolicy,
  type TemporalRequestInput,
  type TemporalResolution,
} from './temporal';
export { dedupeCandidates, authorityRank, type DedupeOptions, type DedupeResult, type SimilarityFn } from './dedupe';
export {
  scoreCandidates,
  rrfChannel,
  type ExplainEntry,
  type FusionContext,
  type ScoredCandidate,
} from './fusion';
export { applyRerank, type RerankOutcome } from './rerank';
export { packResults, type PackOptions, type PackResult, type PackableItem, type PackedItem } from './packing';
export { estimateTokens, deriveSummary, deriveLabel, truncateAtWordBoundary, sentencesOf } from './tokens';
