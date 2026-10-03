/**
 * Stage 4 — result dedupe (retrieval.md §4).
 *
 * 1. Same `content_hash` → collapse to one survivor.
 * 2. Same (primary entity, type) with content cosine ≥ 0.97 → keep the higher authority:
 *    explicit user statement > decision > semantic/procedural/failure/preference > episodic,
 *    then confidence, then recency. The cosine requires an embedding provider; without one the
 *    near-duplicate tier is skipped (exact-hash collapse still applies) — an optimization tier,
 *    not a correctness channel, so it degrades without a warning.
 */

import type { RetrievalCandidate } from './candidates';

export type SimilarityFn = (
  a: RetrievalCandidate,
  b: RetrievalCandidate,
) => Promise<number | null>;

export interface DedupeOptions {
  similarity?: SimilarityFn;
  cosineThreshold: number;
}

export interface DedupeResult {
  kept: RetrievalCandidate[];
  exactCollapsed: number;
  nearCollapsed: number;
}

/**
 * Authority rank for collapse decisions (memory-model.md §9 contradiction resolution order,
 * applied to duplicate collapsing): explicit user statement beats agent inference; explicit
 * decision memory beats observation; then confidence, then recency.
 */
export function authorityRank(candidate: RetrievalCandidate): number {
  if (candidate.sourceKind === 'explicit') return 4;
  switch (candidate.type) {
    case 'decision':
      return 3;
    case 'semantic':
    case 'procedural':
    case 'failure':
    case 'preference':
      return 2;
    case 'episodic':
      return 1;
    default:
      return 0;
  }
}

function tieBreak(a: RetrievalCandidate, b: RetrievalCandidate): number {
  if (a.confidence !== b.confidence) return b.confidence - a.confidence;
  const recency = Date.parse(b.observedAt) - Date.parse(a.observedAt);
  if (recency !== 0) return recency;
  return a.id < b.id ? -1 : 1;
}

function betterKeeper(a: RetrievalCandidate, b: RetrievalCandidate): RetrievalCandidate {
  const rankDiff = authorityRank(b) - authorityRank(a);
  if (rankDiff !== 0) return rankDiff > 0 ? b : a;
  return tieBreak(a, b) > 0 ? b : a;
}

export async function dedupeCandidates(
  candidates: readonly RetrievalCandidate[],
  options: DedupeOptions,
): Promise<DedupeResult> {
  // Stage 4.1 — exact content-hash collapse.
  const byHash = new Map<string, RetrievalCandidate>();
  const hashOrder: string[] = [];
  let exactCollapsed = 0;
  for (const candidate of candidates) {
    const existing = byHash.get(candidate.contentHash);
    if (existing === undefined) {
      byHash.set(candidate.contentHash, candidate);
      hashOrder.push(candidate.contentHash);
      continue;
    }
    const keeper = betterKeeper(existing, candidate);
    // Preserve the survivor's channel presence: the keeper keeps the best of both.
    const merged: RetrievalCandidate = { ...keeper };
    for (const [channel, rank] of Object.entries(candidate.channels)) {
      const key = channel as keyof typeof merged.channels;
      const current = merged.channels[key];
      if (current === undefined || rank < current) merged.channels[key] = rank;
    }
    if (candidate.graphBoost > merged.graphBoost) {
      merged.graphBoost = candidate.graphBoost;
      merged.graphSource = candidate.graphSource;
    }
    byHash.set(candidate.contentHash, merged);
    exactCollapsed += 1;
  }
  const unique = hashOrder.map((hash) => byHash.get(hash)!);

  // Stage 4.2 — near-duplicate authority collapse within (primary entity, type) groups.
  let nearCollapsed = 0;
  let kept: RetrievalCandidate[] = unique;
  if (options.similarity !== undefined && unique.length > 1) {
    const groups = new Map<string, RetrievalCandidate[]>();
    for (const candidate of unique) {
      const key = `${candidate.entityIds[0] ?? 'none'}|${candidate.type}`;
      const group = groups.get(key);
      if (group) group.push(candidate);
      else groups.set(key, [candidate]);
    }
    const dropped = new Set<string>();
    for (const group of groups.values()) {
      if (group.length < 2) continue;
      const ordered = [...group].sort((a, b) => authorityRank(b) - authorityRank(a) || tieBreak(a, b));
      const representatives: RetrievalCandidate[] = [];
      for (const candidate of ordered) {
        let duplicate = false;
        for (const representative of representatives) {
          const cosine = await options.similarity(candidate, representative);
          if (cosine !== null && cosine >= options.cosineThreshold) {
            duplicate = true;
            break;
          }
        }
        if (duplicate) {
          dropped.add(candidate.id);
          nearCollapsed += 1;
        } else {
          representatives.push(candidate);
        }
      }
    }
    if (dropped.size > 0) kept = unique.filter((candidate) => !dropped.has(candidate.id));
  }

  return { kept, exactCollapsed, nearCollapsed };
}
