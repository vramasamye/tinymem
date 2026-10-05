/**
 * Retrieval configuration — every weight and tunable of ADR-0004's scoring table is
 * config-overridable (retrieval.md §5: "Default weights (all config-overridable; these ARE the
 * explain decomposition)"). Defaults are the documented table values; half-lives beyond the three
 * the doc names (episodic 30d, decision 400d, failure 180d) are conservative picks recorded as
 * deviations in mission-2.md.
 */

import { DEFAULT_HALF_LIFE_DAYS, type MemoryType, type SearchIntent } from '@onememory/core';

export { DEFAULT_HALF_LIFE_DAYS };

/** Additive scoring weights (retrieval.md §5). `w_type` lives in the affinity matrix itself. */
export interface RetrievalWeights {
  /** Vector channel RRF contribution. */
  w_sem: number;
  /** Lexical channel RRF contribution. */
  w_lex: number;
  /** Graph boost contribution (0 for non-graph candidates, decayed by hops). */
  w_graph: number;
  /** Stored importance. */
  w_imp: number;
  /** Stored confidence. */
  w_conf: number;
  /** Recency decay (per-type half-lives). */
  w_rec: number;
  /** Access frequency log(1+access_count), stamped by last_accessed_at. */
  w_acc: number;
  /** Project match: 1.0 same / 0.7 cross-project / 0.4 user-global. */
  w_proj: number;
  /** Fraction of query entities bound to the memory. */
  w_ent: number;
}

export const DEFAULT_WEIGHTS: RetrievalWeights = {
  w_sem: 0.2,
  w_lex: 0.16,
  w_graph: 0.08,
  w_imp: 0.12,
  w_conf: 0.08,
  w_rec: 0.1,
  w_acc: 0.05,
  w_proj: 0.1,
  w_ent: 0.1,
};

/**
 * Type affinity (retrieval.md §5: "0.01–0.15, intent×type matrix"). The matrix cell IS the
 * weight for that (intent, type) pair — that is why the weight column shows a range instead of
 * a single value. Missing cells mean 0 (no affinity signal).
 */
export type TypeAffinityMatrix = Record<SearchIntent, Partial<Record<MemoryType, number>>>;

export const DEFAULT_TYPE_AFFINITY: TypeAffinityMatrix = {
  fact: { semantic: 0.1, episodic: 0.03, decision: 0.04, failure: 0.02, procedural: 0.04, preference: 0.04, working: 0.02 },
  how_to: { procedural: 0.15, failure: 0.09, decision: 0.03, semantic: 0.06, episodic: 0.02, preference: 0.03, working: 0.05 },
  decision: { decision: 0.15, semantic: 0.06, episodic: 0.03, failure: 0.03, procedural: 0.03, preference: 0.03, working: 0.03 },
  failure: { failure: 0.15, procedural: 0.11, decision: 0.03, semantic: 0.05, episodic: 0.03, preference: 0.02, working: 0.06 },
  preference: { preference: 0.15, decision: 0.05, semantic: 0.05, procedural: 0.03, episodic: 0.02, failure: 0.02, working: 0.03 },
  history: { episodic: 0.15, decision: 0.09, semantic: 0.06, failure: 0.06, procedural: 0.05, preference: 0.05, working: 0.02 },
  context: { working: 0.09, decision: 0.09, semantic: 0.08, procedural: 0.08, preference: 0.08, failure: 0.05, episodic: 0.05 },
};

export interface RetrievalConfig {
  weights: RetrievalWeights;
  /** RRF smoothing constant (retrieval.md: k=60). */
  rrf: { k: number };
  halfLifeDays: Record<MemoryType, number>;
  typeAffinity: TypeAffinityMatrix;
  lexical: { limit: number };
  vector: { limit: number; minCosine: number };
  graph: {
    perEntityLimit: number;
    entityCap: number;
    hops: number;
    expansionCap: number;
    seedTopK: number;
    /** graph boost decay per hop: 0-hop (entity-bound) = 1.0, 1-hop = decay, 2-hop = decay². */
    decay: number;
    shortcutDecisions: number;
    shortcutFailures: number;
  };
  packing: { defaultMaxTokens: number; overflowLimit: number };
  rerank: { enabled: boolean; limit: number };
  nearDuplicate: { cosineThreshold: number };
  /** Cap for derived (sentence-boundary) summaries of memories without a stored content_summary. */
  summaryMaxChars: number;
  /**
   * Code-ref hydration (M4g2): the refs budget of a returned memory — its own cap, independent
   * of the packed token budget (refs are structured metadata riding the response, not packed
   * text). `maxPerMemory` real entries surface, ordered (repository, path); a memory with more
   * refs than the cap gets ONE `<N more refs>` placeholder entry appended (never a silent
   * mid-list truncation).
   */
  codeRefs: { maxPerMemory: number };
  sessionContext: {
    budget: number;
    digestTokens: number;
    decisionTokens: number;
    failureTokens: number;
    procedureTokens: number;
    preferenceTokens: number;
    decisions: number;
    failures: number;
    procedures: number;
    preferences: number;
  };
  caches: {
    embeddingTtlMs: number;
    embeddingMaxEntries: number;
    resultTtlMs: number;
    resultMaxEntries: number;
    entityTtlMs: number;
    entityMaxEntries: number;
  };
}

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  weights: DEFAULT_WEIGHTS,
  rrf: { k: 60 },
  halfLifeDays: DEFAULT_HALF_LIFE_DAYS,
  typeAffinity: DEFAULT_TYPE_AFFINITY,
  lexical: { limit: 50 },
  vector: { limit: 50, minCosine: 0.05 },
  graph: {
    perEntityLimit: 30,
    entityCap: 60,
    hops: 2,
    expansionCap: 40,
    seedTopK: 5,
    decay: 0.8,
    shortcutDecisions: 10,
    shortcutFailures: 10,
  },
  packing: { defaultMaxTokens: 800, overflowLimit: 10 },
  rerank: { enabled: false, limit: 50 },
  nearDuplicate: { cosineThreshold: 0.97 },
  summaryMaxChars: 160,
  codeRefs: { maxPerMemory: 5 },
  sessionContext: {
    budget: 750,
    digestTokens: 200,
    decisionTokens: 250,
    failureTokens: 150,
    procedureTokens: 100,
    preferenceTokens: 50,
    decisions: 8,
    failures: 6,
    procedures: 6,
    preferences: 6,
  },
  caches: {
    embeddingTtlMs: 10 * 60 * 1000,
    embeddingMaxEntries: 256,
    resultTtlMs: 60 * 1000,
    resultMaxEntries: 64,
    entityTtlMs: 30 * 1000,
    entityMaxEntries: 1000,
  },
};

/**
 * The config INPUT the engine accepts: every section merges key-by-key over the defaults, so a
 * caller overrides exactly the weights it wants (`{ weights: { w_imp: 0.4 } }`) without
 * restating the whole table.
 */
export interface RetrievalConfigInput {
  weights?: Partial<RetrievalWeights>;
  rrf?: { k?: number };
  halfLifeDays?: Partial<Record<MemoryType, number>>;
  typeAffinity?: Partial<Record<SearchIntent, Partial<Record<MemoryType, number>>>>;
  lexical?: { limit?: number };
  vector?: { limit?: number; minCosine?: number };
  graph?: {
    perEntityLimit?: number;
    entityCap?: number;
    hops?: number;
    expansionCap?: number;
    seedTopK?: number;
    decay?: number;
    shortcutDecisions?: number;
    shortcutFailures?: number;
  };
  packing?: { defaultMaxTokens?: number; overflowLimit?: number };
  rerank?: { enabled?: boolean; limit?: number };
  nearDuplicate?: { cosineThreshold?: number };
  summaryMaxChars?: number;
  codeRefs?: { maxPerMemory?: number };
  sessionContext?: {
    budget?: number;
    digestTokens?: number;
    decisionTokens?: number;
    failureTokens?: number;
    procedureTokens?: number;
    preferenceTokens?: number;
    decisions?: number;
    failures?: number;
    procedures?: number;
    preferences?: number;
  };
  caches?: {
    embeddingTtlMs?: number;
    embeddingMaxEntries?: number;
    resultTtlMs?: number;
    resultMaxEntries?: number;
    entityTtlMs?: number;
    entityMaxEntries?: number;
  };
}

/** Merge a partial config input over the defaults (every section key-by-key). */
export function mergeConfig(partial?: RetrievalConfigInput): RetrievalConfig {
  const base = DEFAULT_RETRIEVAL_CONFIG;
  if (!partial) return structuredClone(base);
  const merged: RetrievalConfig = {
    weights: { ...base.weights, ...partial.weights },
    rrf: { ...base.rrf, ...partial.rrf },
    halfLifeDays: { ...base.halfLifeDays, ...partial.halfLifeDays },
    typeAffinity: mergeAffinity(base.typeAffinity, partial.typeAffinity),
    lexical: { ...base.lexical, ...partial.lexical },
    vector: { ...base.vector, ...partial.vector },
    graph: { ...base.graph, ...partial.graph },
    packing: { ...base.packing, ...partial.packing },
    rerank: { ...base.rerank, ...partial.rerank },
    nearDuplicate: { ...base.nearDuplicate, ...partial.nearDuplicate },
    summaryMaxChars: partial.summaryMaxChars ?? base.summaryMaxChars,
    codeRefs: { ...base.codeRefs, ...partial.codeRefs },
    sessionContext: { ...base.sessionContext, ...partial.sessionContext },
    caches: { ...base.caches, ...partial.caches },
  };
  return merged;
}

function mergeAffinity(
  base: TypeAffinityMatrix,
  overrides?: Partial<Record<SearchIntent, Partial<Record<MemoryType, number>>>>,
): TypeAffinityMatrix {
  const merged: TypeAffinityMatrix = { ...base };
  if (overrides === undefined) return merged;
  for (const [intent, row] of Object.entries(overrides) as Array<[SearchIntent, Partial<Record<MemoryType, number>>]>) {
    merged[intent] = { ...base[intent], ...row };
  }
  return merged;
}
