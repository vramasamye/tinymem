/**
 * Consolidation configuration and the run report — the package's own boundary types.
 *
 * The config input is Zod-validated in `runConsolidation` (AGENTS.md: Zod validates every
 * external boundary; the library entry is one). The report is an output document (plain
 * interfaces, like `StatsResult`), printed by the CLI and consumable by the daemon-side
 * scheduler (a coordinator follow-up).
 */

import { z } from 'zod';

import { DEFAULT_HALF_LIFE_DAYS, type MemoryStatus } from '@onememory/core';

import type { ContradictionTier } from './contradiction';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** The default actor for every consolidation mutation (database-schema.md §2: `job:<kind>`). */
export const DEFAULT_CONSOLIDATION_ACTOR = 'job:consolidate';

/**
 * Recency half-lives per memory type — one shared table with retrieval (retrieval.md §5 names
 * episodic 30d, decision 400d, failure 180d). Decay and retrieval scoring must age a memory at
 * the same rate or the two stages disagree about what matters.
 */
export const CONSOLIDATION_HALF_LIFE_DAYS = DEFAULT_HALF_LIFE_DAYS;

/**
 * The lowest accepted near-duplicate cosine (review finding P2-5). The default stays 0.97 (the
 * retrieval-dedupe threshold); a config may TIGHTEN it, but below 0.9 the "near-duplicate"
 * merge stops collapsing near-duplicates and starts collapsing distinct facts — so the floor
 * is mandatory, not a suggestion.
 */
export const MIN_NEAR_DUPLICATE_COSINE = 0.9;

/**
 * The lowest accepted derivation cluster size. memory-model.md §9 makes ≥ 3 corroborating
 * episodes the floor for a semantic memory (one semantic row is never derived from a pair);
 * the boundary enforces it instead of trusting the caller.
 */
export const MIN_DERIVATION_CLUSTER_SIZE = 3;

export const ConsolidationConfigSchema = z.looseObject({
  nearDuplicate: z
    .looseObject({
      /** Cosine at and above which two same-scope, same-type memories are near-duplicates. */
      cosineThreshold: z
        .number()
        .min(
          MIN_NEAR_DUPLICATE_COSINE,
          `nearDuplicate.cosineThreshold must be at least ${MIN_NEAR_DUPLICATE_COSINE} — below that a ` +
            'near-duplicate merge starts collapsing distinct facts (default 0.97, the retrieval-dedupe threshold)',
        )
        .max(1)
        .optional(),
      /** KNN fan-out per memory when probing the vector channel. */
      neighbors: z.number().int().min(1).max(64).optional(),
    })
    .optional(),
  derivation: z
    .looseObject({
      /** Episodes needed before a semantic memory may be derived (memory-model.md §9: ≥ 3). */
      minClusterSize: z
        .number()
        .int()
        .min(
          MIN_DERIVATION_CLUSTER_SIZE,
          `derivation.minClusterSize must be at least ${MIN_DERIVATION_CLUSTER_SIZE} — one semantic memory ` +
            'is derived from at least 3 corroborating episodes, never from a pair (memory-model.md §9)',
        )
        .max(32)
        .optional(),
      /** Relatedness within a cluster (below the near-duplicate threshold, above noise). */
      minClusterCosine: z.number().min(0).max(1).optional(),
      /** Cluster size cap — one derivation is bounded work. */
      maxClusterSize: z.number().int().min(2).max(64).optional(),
    })
    .optional(),
  decay: z
    .looseObject({
      /** Prominence below which an active memory is archived (archive, never delete). */
      archiveThreshold: z.number().min(0).max(1).optional(),
      /** Importance floor for decay-resistant types (decisions, verified procedures). */
      resistantImportanceFloor: z.number().min(0).max(1).optional(),
    })
    .optional(),
  conflict: z
    .looseObject({
      /**
       * Semantic-proximity floor at which two claim memories become cross-phrasing CANDIDATES
       * for the LLM conflict tier. Candidacy only — the model still decides (fail-closed).
       */
      crossPhrasingCosine: z.number().min(0).max(1).optional(),
      /** KNN fan-out per memory when probing the vector channel for cross-phrasing candidates. */
      neighbors: z.number().int().min(1).max(64).optional(),
    })
    .optional(),
  /** Per-type half-life overrides (days), merged over the shared default table. */
  halfLifeDays: z.record(z.string(), z.number().positive()).optional(),
  /** Active memories considered per run (queryCurrent is capped at 1000 by the Store port). */
  poolLimit: z.number().int().min(1).max(1000).optional(),
});
export type ConsolidationConfigInput = z.input<typeof ConsolidationConfigSchema>;

export interface ConsolidationConfig {
  nearDuplicate: { cosineThreshold: number; neighbors: number };
  derivation: { minClusterSize: number; minClusterCosine: number; maxClusterSize: number };
  decay: { archiveThreshold: number; resistantImportanceFloor: number };
  conflict: { crossPhrasingCosine: number; neighbors: number };
  halfLifeDays: Record<string, number>;
  poolLimit: number;
}

export const DEFAULT_CONSOLIDATION_CONFIG: ConsolidationConfig = {
  nearDuplicate: { cosineThreshold: 0.97, neighbors: 10 },
  derivation: { minClusterSize: 3, minClusterCosine: 0.75, maxClusterSize: 12 },
  decay: { archiveThreshold: 0.05, resistantImportanceFloor: 0.6 },
  conflict: { crossPhrasingCosine: 0.75, neighbors: 10 },
  halfLifeDays: { ...CONSOLIDATION_HALF_LIFE_DAYS },
  poolLimit: 200,
};

/** Merge a config input over the defaults (key-by-key, half-lives merged per type). */
export function resolveConsolidationConfig(input?: ConsolidationConfigInput): ConsolidationConfig {
  const parsed = input === undefined ? {} : ConsolidationConfigSchema.parse(input);
  return {
    nearDuplicate: { ...DEFAULT_CONSOLIDATION_CONFIG.nearDuplicate, ...parsed.nearDuplicate },
    derivation: { ...DEFAULT_CONSOLIDATION_CONFIG.derivation, ...parsed.derivation },
    decay: { ...DEFAULT_CONSOLIDATION_CONFIG.decay, ...parsed.decay },
    conflict: { ...DEFAULT_CONSOLIDATION_CONFIG.conflict, ...parsed.conflict },
    halfLifeDays: { ...CONSOLIDATION_HALF_LIFE_DAYS, ...parsed.halfLifeDays },
    poolLimit: parsed.poolLimit ?? DEFAULT_CONSOLIDATION_CONFIG.poolLimit,
  };
}

// ---------------------------------------------------------------------------
// Run report (an output document — plain interfaces)
// ---------------------------------------------------------------------------

export interface ConsolidationScope {
  project_id: string | null;
}

/** One near-duplicate cluster merged into its highest-authority survivor. */
export interface MergeRecord {
  keeper_id: string;
  keeper_status_from: MemoryStatus;
  /** Sources absorbed into the keeper (now `superseded`, `superseded_by` → keeper). */
  merged_sources: Array<{ id: string; from_status: MemoryStatus; cosine: number }>;
  /** Sources left untouched, with the reason (e.g. a validity-window inversion). */
  skipped_sources: Array<{ id: string; reason: string }>;
}

export type AuthorityRule = 'explicit' | 'decision' | 'newer' | 'confidence' | 'tie';

/** One detected contradiction and how authority resolved it. */
export interface ContradictionRecord {
  a_id: string;
  b_id: string;
  /** The shared attribute template both statements instantiate ("version: node <#>"). */
  template: string;
  /** Which tier decided the pair: the deterministic template heuristic, or the router's `conflict` op. */
  tier: ContradictionTier;
  outcome: 'superseded' | 'disputed';
  /** Set when `outcome` is `superseded`: the memory the loser now points at. */
  winner_id?: string;
  /** Which authority rule decided the pair ('tie' → both disputed). */
  rule: AuthorityRule;
}

export interface ContradictionSkip {
  a_id: string;
  b_id: string;
  reason: string;
}

/** One episodic cluster derived into a semantic memory. */
export interface DerivationRecord {
  memory_id: string;
  /** Every cluster member — the `derived_from` edge targets. */
  source_ids: string[];
  entity: { id: string; name: string } | null;
  method: 'llm' | 'heuristic';
  /** True when the semantic row already existed (a crashed pass finished) and only edges were completed. */
  reused_existing: boolean;
}

export interface DerivationSkip {
  source_ids: string[];
  reason: string;
}

/** One memory archived by decay (prominence below threshold). */
export interface ArchiveRecord {
  id: string;
  from_status: MemoryStatus;
  prominence: number;
  threshold: number;
}

export interface ConsolidationReport {
  ran_at: string;
  actor: string;
  scope: ConsolidationScope;
  /** The pool facts: everything queryCurrent returned, and the active subset the passes ran on. */
  pool: { considered: number; active: number; truncated: boolean };
  merge: { clusters: number; sources_closed: number; records: MergeRecord[] };
  contradictions: {
    pairs: number;
    resolved: number;
    disputed_pairs: number;
    records: ContradictionRecord[];
    skipped: ContradictionSkip[];
  };
  derivations: { derived: number; records: DerivationRecord[]; skipped: DerivationSkip[] };
  decay: { archived: number; kept: number; records: ArchiveRecord[] };
  /** Degradations and per-item failures — never silent (memory-model.md §1.6). */
  warnings: string[];
}
