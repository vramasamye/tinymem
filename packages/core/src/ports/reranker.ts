/**
 * Reranker port — optional, opt-in second stage after first-stage retrieval (M2 issue: disabled
 * by default; local cross-encoder or a hosted API behind explicit user opt-in per
 * dependency-verification.md §11). Scores each (query, candidate) pair; cost grows with
 * candidates, so implementations must bound the input set.
 */

export interface RerankCandidate {
  memory_id: string;
  /** The text the reranker scores against the query (summary or content). */
  text: string;
}

export interface RerankedMatch {
  memory_id: string;
  score: number;
}

export interface Reranker {
  /** Returns candidates re-sorted by relevance (score 0–1), best first. */
  rerank(query: string, candidates: RerankCandidate[]): Promise<RerankedMatch[]>;
}
