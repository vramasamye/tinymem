/**
 * Stage 6 — optional rerank tier (ADR-0004: opt-in quality enhancement, never a default). The
 * `Reranker` port stays injectable (core); this module drives it over the top-N fused candidates.
 * A reranker failure degrades to the fused order with a warning — retrieval never fails because
 * a quality tier is down.
 */

import type { Reranker } from '@onememory-ai/core';

import type { ScoredCandidate } from './fusion';

export interface RerankOutcome {
  ranked: ScoredCandidate[];
  error?: string;
}

/** Rerank the head of the fused ranking; candidates the reranker omits keep their fused order after it. */
export async function applyRerank(
  scored: readonly ScoredCandidate[],
  query: string,
  reranker: Reranker,
  limit: number,
): Promise<RerankOutcome> {
  try {
    const head = scored.slice(0, limit);
    const tail = scored.slice(limit);
    const matches = await reranker.rerank(
      query,
      head.map((entry) => ({
        memory_id: entry.candidate.id,
        text: entry.candidate.contentSummary ?? entry.candidate.content,
      })),
    );
    const byId = new Map(head.map((entry) => [entry.candidate.id, entry]));
    const ranked: ScoredCandidate[] = [];
    const seen = new Set<string>();
    for (const match of matches) {
      const entry = byId.get(match.memory_id);
      if (entry && !seen.has(match.memory_id)) {
        seen.add(match.memory_id);
        ranked.push(entry);
      }
    }
    for (const entry of head) {
      if (!seen.has(entry.candidate.id)) ranked.push(entry);
    }
    return { ranked: [...ranked, ...tail] };
  } catch (error) {
    return { ranked: [...scored], error: error instanceof Error ? error.message : String(error) };
  }
}
