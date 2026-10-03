/**
 * Stage 5 — RRF fusion + additive weighted scoring (retrieval.md §5; ADR-0004). PURE: given
 * candidates with channel ranks and stored fields, produce scores + the explain decomposition.
 * The nonzero contributions ARE the explain output — no separate model call, fully deterministic.
 *
 *   rrf_c(m)      = (k+1)/(k+raw_rank_c)      per channel, normalized to 0..1 (rank 1 → 1.0)
 *   score(m)      = w_sem·rrf_vec + w_lex·rrf_lex + w_graph·graph_boost + w_imp·importance
 *                 + w_conf·confidence + w_rec·recency + w_acc·access + w_proj·project_match
 *                 + w_ent·entity_overlap + type_affinity(intent, type)
 *   relevance     = score / active-weight-mass      (0..1; inactive channels renormalize)
 *
 * Raw cosine is NEVER exposed as relevance (spec §11) — the vector channel enters only as an RRF
 * rank. Type affinity's weight lives in the matrix cell (the §5 table shows a 0.01–0.15 range).
 */

import type { MemoryType, ScoreFactor, SearchIntent } from '@onememory/core';

import type { RetrievalCandidate } from './candidates';
import type { RetrievalConfig } from './config';

export interface ExplainEntry {
  factor: ScoreFactor;
  weight: number;
  detail: string;
}

export interface FusionContext {
  intent: SearchIntent;
  requestProjectId?: string;
  now: Date;
  /** Entity ids the query matched (entity-overlap denominator + explain). */
  queryEntityIds: string[];
  /** Channels that actually ran — an unavailable channel's weight is redistributed by mass. */
  activeChannels: { vector: boolean; lexical: boolean };
  /** Human note for the zero-weight temporal_validity explain entry. */
  temporalNote: string;
}

export interface ScoredCandidate {
  candidate: RetrievalCandidate;
  score: number;
  relevance: number;
  explain: ExplainEntry[];
}

/** Per-channel normalized RRF: 1/(k+rank) rescaled so rank 1 → 1.0. */
export function rrfChannel(rank: number, k: number): number {
  if (rank < 1) return 0;
  return (k + 1) / (k + rank);
}

const ACCESS_NORMALIZER = Math.log(11); // log(1 + 10): access_count 10+ → full contribution

export function accessSignal(accessCount: number): number {
  if (accessCount <= 0) return 0;
  return Math.min(1, Math.log(1 + accessCount) / ACCESS_NORMALIZER);
}

export function recencySignal(candidate: RetrievalCandidate, now: Date, halfLifeDays: number): number {
  const ageDays = Math.max(0, (now.getTime() - Date.parse(candidate.observedAt)) / 86_400_000);
  if (halfLifeDays <= 0) return 0;
  return Math.pow(0.5, ageDays / halfLifeDays);
}

export function projectMatchSignal(candidate: RetrievalCandidate, requestProjectId?: string): number {
  if (requestProjectId === undefined) {
    return candidate.projectId === undefined ? 1.0 : 0.7;
  }
  if (candidate.projectId === requestProjectId) return 1.0;
  return candidate.projectId === undefined ? 0.4 : 0.7;
}

export function entityOverlapSignal(candidate: RetrievalCandidate, queryEntityIds: readonly string[]): number {
  if (queryEntityIds.length === 0) return 0;
  const query = new Set(queryEntityIds);
  let matched = 0;
  for (const entityId of candidate.entityIds) {
    if (query.has(entityId)) matched += 1;
  }
  return matched / query.size;
}

/** Max affinity weight for the intent — the normalization mass's type-affinity share. */
export function maxTypeAffinity(config: RetrievalConfig, intent: SearchIntent): number {
  const row = config.typeAffinity[intent];
  let max = 0;
  for (const value of Object.values(row ?? {})) {
    if (typeof value === 'number' && value > max) max = value;
  }
  return max;
}

function describeProjectMatch(candidate: RetrievalCandidate, requestProjectId?: string): string {
  if (requestProjectId === undefined) {
    return candidate.projectId === undefined ? 'global memory matches the unscoped query' : 'project-scoped memory (unscoped query)';
  }
  if (candidate.projectId === requestProjectId) return 'same project';
  return candidate.projectId === undefined ? 'user-global memory' : 'cross-project memory';
}

/**
 * Fuse channels and score every candidate. Sorted best first; ties broken deterministically by
 * candidate id. Explain entries are the nonzero contributions, ordered by factor name for stable
 * snapshots, with the zero-weight `temporal_validity` note always last.
 */
export function scoreCandidates(
  candidates: readonly RetrievalCandidate[],
  ctx: FusionContext,
  config: RetrievalConfig,
): ScoredCandidate[] {
  const weights = config.weights;
  const queryEntityIdSet = new Set(ctx.queryEntityIds);
  const mass =
    (ctx.activeChannels.vector ? weights.w_sem : 0) +
    (ctx.activeChannels.lexical ? weights.w_lex : 0) +
    weights.w_graph +
    weights.w_imp +
    weights.w_conf +
    weights.w_rec +
    weights.w_acc +
    weights.w_proj +
    weights.w_ent +
    maxTypeAffinity(config, ctx.intent);

  const scored: ScoredCandidate[] = candidates.map((candidate) => {
    const contributions: Array<{ factor: ScoreFactor; weight: number; signal: number; detail: string }> = [];

    if (ctx.activeChannels.vector && candidate.channels.vector !== undefined) {
      const signal = rrfChannel(candidate.channels.vector, config.rrf.k);
      contributions.push({
        factor: 'semantic_similarity',
        weight: weights.w_sem,
        signal,
        detail: `vector channel rank #${candidate.channels.vector} (RRF k=${config.rrf.k})`,
      });
    }
    if (ctx.activeChannels.lexical && candidate.channels.lexical !== undefined) {
      const signal = rrfChannel(candidate.channels.lexical, config.rrf.k);
      contributions.push({
        factor: 'lexical_relevance',
        weight: weights.w_lex,
        signal,
        detail: `FTS rank #${candidate.channels.lexical}`,
      });
    }
    if (candidate.graphBoost > 0) {
      contributions.push({
        factor: 'graph_proximity',
        weight: weights.w_graph,
        signal: candidate.graphBoost,
        detail: candidate.graphSource ?? 'graph proximity',
      });
    }
    contributions.push({
      factor: 'importance',
      weight: weights.w_imp,
      signal: candidate.importance,
      detail: `importance ${candidate.importance.toFixed(2)}`,
    });
    contributions.push({
      factor: 'confidence',
      weight: weights.w_conf,
      signal: candidate.confidence,
      detail: `confidence ${candidate.confidence.toFixed(2)}`,
    });
    const halfLife = config.halfLifeDays[candidate.type] ?? 180;
    const recency = recencySignal(candidate, ctx.now, halfLife);
    contributions.push({
      factor: 'recency',
      weight: weights.w_rec,
      signal: recency,
      detail: `observed ${candidate.observedAt.slice(0, 10)} (half-life ${halfLife}d for ${candidate.type})`,
    });
    if (candidate.accessCount > 0) {
      contributions.push({
        factor: 'access_frequency',
        weight: weights.w_acc,
        signal: accessSignal(candidate.accessCount),
        detail: `access_count ${candidate.accessCount}`,
      });
    }
    const projectSignal = projectMatchSignal(candidate, ctx.requestProjectId);
    if (projectSignal > 0) {
      contributions.push({
        factor: 'project_match',
        weight: weights.w_proj,
        signal: projectSignal,
        detail: describeProjectMatch(candidate, ctx.requestProjectId),
      });
    }
    if (ctx.queryEntityIds.length > 0 && candidate.entityIds.length > 0) {
      const matchedNames = candidate.entityNames.filter((_, index) =>
        queryEntityIdSet.has(candidate.entityIds[index] ?? ''),
      );
      if (matchedNames.length > 0) {
        const overlap = matchedNames.length / ctx.queryEntityIds.length;
        contributions.push({
          factor: 'entity_match',
          weight: weights.w_ent,
          signal: overlap,
          detail: `entity match: ${matchedNames.join(', ')} (${matchedNames.length}/${ctx.queryEntityIds.length} query entities)`,
        });
      }
    }
    const affinity = config.typeAffinity[ctx.intent]?.[candidate.type as MemoryType] ?? 0;
    if (affinity > 0) {
      contributions.push({
        factor: 'type_affinity',
        weight: affinity,
        signal: 1,
        detail: `intent '${ctx.intent}' favors type '${candidate.type}'`,
      });
    }

    const score = contributions.reduce((sum, entry) => sum + entry.weight * entry.signal, 0);
    const explain: ExplainEntry[] = [
      ...contributions
        .filter((entry) => entry.weight * entry.signal > 1e-9)
        .map((entry) => ({ factor: entry.factor, weight: round(entry.weight), detail: entry.detail })),
      { factor: 'temporal_validity', weight: 0, detail: ctx.temporalNote },
    ];
    explain.sort((a, b) => {
      if (a.factor === 'temporal_validity') return 1;
      if (b.factor === 'temporal_validity') return -1;
      return a.factor.localeCompare(b.factor);
    });

    return {
      candidate,
      score,
      relevance: mass > 0 ? Math.min(1, Math.max(0, score / mass)) : 0,
      explain,
    };
  });

  scored.sort((a, b) => b.score - a.score || (a.candidate.id < b.candidate.id ? -1 : 1));
  return scored;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
