/**
 * Retrieval port (stage 10 RETRIEVE, memory-model.md §8): query → ranked, token-budgeted
 * results with explanations. Implemented by `packages/retrieval` (M2): hybrid lexical (tsvector
 * + ts_rank) / vector (KNN) / graph expansion, RRF fusion, weighted scoring, token packing.
 *
 * Degradation contract: when a channel is unavailable (no embeddings, no reranker), the
 * implementation degrades and reports it via `warnings` — never silently.
 */

import type { MemorySearchRequest, MemorySearchResponse } from '../schema/search';

export interface Searcher {
  search(request: MemorySearchRequest): Promise<MemorySearchResponse>;
}
