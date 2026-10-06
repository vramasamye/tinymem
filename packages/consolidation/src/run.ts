/**
 * `runConsolidation` — the CONSOLIDATE / DECAY lifecycle stages (memory-model.md §8 stages
 * 12–14) as one callable library entry over the existing `Store` port. The daemon-side
 * scheduler (a coordinator follow-up) and the `onemem consolidate` CLI command both call this.
 *
 * Pass order (each is idempotent and re-derives from the live pool):
 *   1. contradiction resolution — authority order, ties `disputed`, winners supersede losers
 *   2. episodic → semantic     — corroborated, non-contradicting clusters become semantic rows
 *   3. near-duplicate merge    — collapses same-fact rows into their highest-authority survivor
 *   4. decay / archive         — prominence below threshold → audited `archived`
 *
 * WHY this order (review findings P1-2 and P2-4): contradictions resolve BEFORE the merge —
 * a merge must never absorb a conflicting claim (the pair reaches dispute or authority
 * resolution instead, and the merge pass itself refuses a cluster that still contains a
 * flagged pair, defense in depth for a skipped resolution). Contradictions also resolve
 * before derivation (a derived cluster must be contradiction-free). Derivation runs BEFORE
 * the merge: near-identical episodes are corroborating observations — they feed the semantic
 * memory first (`derived_from` edges to every source), then the merge collapses the
 * duplicates, so three near-identical rows become ONE semantic memory instead of one keeper
 * and no corroboration. The cluster members stay: the keeper active, the absorbed rows in
 * history with their evidence.
 *
 * Degradation is explicit, never silent (memory-model.md §1.6): without an embedder or a
 * matching embedding index the vector-dependent passes (derivation, merge) are skipped with a
 * warning; contradiction resolution and decay always run — they need no model and no vectors.
 */

import type { Embedder, EmbeddingIndex, MemoryRecord, Store } from '@onememory/core';
import type { ModelRouter } from '@onememory/llm';

import { runContradictionPass, type ContradictionDetector } from './contradiction';
import { createConflictDetector, CROSS_PHRASING_TYPES } from './conflict';
import { runDecayPass } from './decay';
import { runDerivationPass } from './derive';
import { runMergePass } from './merge';
import { errorMessage } from './util';
import {
  DEFAULT_CONSOLIDATION_ACTOR,
  resolveConsolidationConfig,
  type ConsolidationConfigInput,
  type ConsolidationReport,
} from './types';

/**
 * The four lifecycle passes, in run order. A caller may restrict the run to a subset — the
 * `decay` job kind (memory-model.md §8 stage 13) drives only the terminal decay/archive pass,
 * while the `consolidate` kind runs all four.
 */
export const CONSOLIDATION_STAGES = ['contradiction', 'derivation', 'merge', 'decay'] as const;
export type ConsolidationStage = (typeof CONSOLIDATION_STAGES)[number];

/** What `runConsolidation` needs. Everything except the Store is optional (local-first). */
export interface ConsolidationInput {
  store: Store;
  /**
   * Restrict the run to a subset of passes (default: all four, in order). A skipped pass reports
   * its zeroed section; the ordering invariant between the remaining passes is preserved.
   */
  stages?: readonly ConsolidationStage[];
  /** Near-duplicate and derivation candidate lookup run through the existing vector channel. */
  vectors?: EmbeddingIndex;
  /** Embeds the pool's contents to drive the vector channel. Absent → vector passes skip. */
  embedder?: Embedder;
  /** Optional LLM merge tier for semantic derivation (router operation `consolidate`). */
  router?: ModelRouter;
  /**
   * Contradiction detector override (default: the template heuristic; the router-backed
   * cross-phrasing tier when the router has a `conflict` route). ONE detector is shared by the
   * contradiction pass, the merge pass's refusal guard, and the derivation cluster check —
   * they must agree on what a conflict is, or a merge could absorb what a pass never saw.
   */
  detector?: ContradictionDetector;
  /**
   * Project scope: a project id runs one project's pass; `undefined` runs every scope. (A
   * user-level-ONLY pass needs a `MemoryQuery` null-scope probe the Store port does not expose —
   * see the mission report follow-ups.)
   */
  scope?: { project_id?: string };
  /** Audit actor for every mutation (default `job:consolidate`). */
  actor?: string;
  /** Injectable clock (tests / deterministic runs). */
  now?: () => Date;
  config?: ConsolidationConfigInput;
}

const EMBED_BATCH = 32;

export async function runConsolidation(input: ConsolidationInput): Promise<ConsolidationReport> {
  const config = resolveConsolidationConfig(input.config);
  const now = input.now ?? (() => new Date());
  const actor = input.actor ?? DEFAULT_CONSOLIDATION_ACTOR;
  const warnings: string[] = [];
  const stages = new Set<ConsolidationStage>(input.stages ?? CONSOLIDATION_STAGES);

  // --- pool -----------------------------------------------------------------
  const considered = await input.store.queryCurrent({
    ...(input.scope?.project_id === undefined ? {} : { project_id: input.scope.project_id }),
    limit: config.poolLimit,
  });
  // `truncated`: the read cap was reached — older active memories exist beyond this pass.
  const truncated = considered.length >= config.poolLimit;
  const activeAtLoad = considered.filter((memory) => memory.status === 'active').length;
  let pool = considered.filter((memory) => memory.status === 'active');

  // --- vector channel guard (explicit degradation, never silent) --------------
  let vectors: EmbeddingIndex | undefined;
  let embeddings: ReadonlyMap<string, readonly number[]> | undefined;
  const channel = vectorChannel(input.embedder, input.vectors);
  if (channel === null && (input.embedder !== undefined || input.vectors !== undefined)) {
    warnings.push(...channelWarnings(input.embedder, input.vectors));
  }
  if (channel !== null) {
    const { embedder, index } = channel;
    const vectorMap = await embedPool(pool, embedder);
    const searchable = await probeIndex(index, vectorMap, warnings);
    if (searchable) {
      vectors = index;
      embeddings = vectorMap;
    }
  } else if (input.embedder === undefined && input.vectors === undefined) {
    warnings.push(
      'no embedding provider and no vector index: near-duplicate merge and semantic derivation skipped (contradiction resolution and decay still run)',
    );
  }

  // --- pass 1: contradiction resolution (no vectors, no model needed) ----------
  // FIRST: a merge must never absorb a conflicting claim, and a derived cluster must be
  // contradiction-free. Every detected pair is arbitrated (supersede by rule, or both disputed
  // on a tie) — never skipped for a temporal shape.
  //
  // The conflict tier (opt-in, fail-closed): when the router has a `conflict` route, the detector
  // becomes template-heuristic + LLM adjudication for cross-phrasing pairs, and semantic
  // proximity supplies the candidates the template groups can never form. With no such route the
  // detector is the bare template heuristic — the offline default, unchanged (AGENTS.md rule 4).
  const detectorWarnings: string[] = [];
  const conflictRouteConfigured = input.router !== undefined && input.router.isConfigured('conflict');
  const crossPhrasingEnabled = input.detector === undefined && conflictRouteConfigured;
  // Explicit degradation, never silent (memory-model.md §1.6): a router set up for other
  // operations but with no `conflict` route leaves cross-phrasing pairs undetected. Pure offline
  // (no router) stays byte-identical — the local-first default is a complete mode, not a
  // degradation, so it warns nothing here.
  if (
    input.detector === undefined &&
    input.router !== undefined &&
    !conflictRouteConfigured &&
    input.router.configuredOperations().length > 0
  ) {
    warnings.push(
      'no `conflict` route configured: cross-phrasing contradictions are not detected (attribute-template heuristic only) — route the `conflict` operation to enable LLM adjudication',
    );
  }
  const detector: ContradictionDetector | undefined =
    input.detector ??
    (crossPhrasingEnabled && input.router !== undefined
      ? createConflictDetector(input.router, { warnings: detectorWarnings })
      : undefined);
  const crossPhrasing =
    crossPhrasingEnabled && vectors !== undefined && embeddings !== undefined
      ? {
          vectors,
          embeddings,
          cosine: config.conflict.crossPhrasingCosine,
          neighbors: config.conflict.neighbors,
          types: CROSS_PHRASING_TYPES,
        }
      : undefined;

  let contradictions: ConsolidationReport['contradictions'] = {
    pairs: 0,
    resolved: 0,
    disputed_pairs: 0,
    records: [],
    skipped: [],
  };
  if (stages.has('contradiction')) {
    try {
      const resolved = await runContradictionPass(input.store, pool, {
        actor,
        ...(detector === undefined ? {} : { detector }),
        ...(crossPhrasing === undefined ? {} : { crossPhrasing }),
      });
      const supersededRecords = resolved.records.filter((record) => record.outcome === 'superseded');
      const disputedRecords = resolved.records.filter((record) => record.outcome === 'disputed');
      contradictions = {
        pairs: resolved.records.length,
        resolved: supersededRecords.length,
        disputed_pairs: disputedRecords.length,
        records: resolved.records,
        skipped: resolved.skipped,
      };
      warnings.push(...resolved.warnings);
      const outOfPool = [
        ...supersededRecords.flatMap((record) =>
          record.winner_id === undefined ? [] : [record.a_id === record.winner_id ? record.b_id : record.a_id],
        ),
        ...disputedRecords.flatMap((record) => [record.a_id, record.b_id]),
      ];
      pool = exclude(pool, outOfPool);
    } catch (error) {
      warnings.push(`contradiction pass failed: ${errorMessage(error)}`);
    }
  }

  // --- pass 2: episodic → semantic derivation ----------------------------------
  // BEFORE the merge: near-identical episodes are corroborating observations — they feed the
  // semantic memory first (`derived_from` edges to every source), then the merge collapses
  // the duplicates (the keeper stays active; the absorbed rows stay in history).
  let derivations: ConsolidationReport['derivations'] = { derived: 0, records: [], skipped: [] };
  if (stages.has('derivation') && vectors !== undefined && embeddings !== undefined) {
    try {
      const derived = await runDerivationPass(
        input.store,
        pool.filter((memory) => memory.type === 'episodic'),
        vectors,
        embeddings,
        {
          actor,
          ...(input.router === undefined ? {} : { router: input.router }),
          ...(detector === undefined ? {} : { detector }),
          minClusterSize: config.derivation.minClusterSize,
          minClusterCosine: config.derivation.minClusterCosine,
          maxClusterSize: config.derivation.maxClusterSize,
        },
      );
      derivations = { derived: derived.records.length, records: derived.records, skipped: derived.skipped };
      warnings.push(...derived.warnings);
    } catch (error) {
      warnings.push(`derivation pass failed: ${errorMessage(error)}`);
    }
  }

  // --- pass 3: near-duplicate merge ---------------------------------------------
  // LAST of the mutating passes over the episodic rows: duplicates collapse only after the
  // conflicts are arbitrated and the corroboration is recorded. The pass itself also refuses
  // a cluster that still contains a flagged pair (defense in depth for a skipped resolution).
  let mergeReport: ConsolidationReport['merge'] = { clusters: 0, sources_closed: 0, records: [] };
  if (stages.has('merge') && vectors !== undefined && embeddings !== undefined) {
    try {
      const merged = await runMergePass(input.store, pool, vectors, embeddings, {
        actor,
        now: now(),
        cosineThreshold: config.nearDuplicate.cosineThreshold,
        neighbors: config.nearDuplicate.neighbors,
        ...(detector === undefined ? {} : { detector }),
      });
      mergeReport = {
        clusters: merged.records.length,
        sources_closed: merged.sourcesClosed,
        records: merged.records,
      };
      warnings.push(...merged.warnings);
      pool = exclude(pool, merged.records.flatMap((record) => record.merged_sources.map((source) => source.id)));
    } catch (error) {
      warnings.push(`near-duplicate merge pass failed: ${errorMessage(error)}`);
    }
  }

  // --- pass 4: decay / archive ---------------------------------------------------
  let decay: ConsolidationReport['decay'] = { archived: 0, kept: 0, records: [] };
  if (stages.has('decay')) {
    try {
      const decayed = await runDecayPass(input.store, pool, {
        actor,
        now: now(),
        archiveThreshold: config.decay.archiveThreshold,
        resistantImportanceFloor: config.decay.resistantImportanceFloor,
        halfLifeDays: config.halfLifeDays,
      });
      decay = { archived: decayed.records.length, kept: decayed.kept, records: decayed.records };
      warnings.push(...decayed.warnings);
    } catch (error) {
      warnings.push(`decay pass failed: ${errorMessage(error)}`);
    }
  }

  return {
    ran_at: now().toISOString(),
    actor,
    scope: { project_id: input.scope?.project_id ?? null },
    pool: { considered: considered.length, active: activeAtLoad, truncated },
    merge: mergeReport,
    contradictions,
    derivations,
    decay,
    warnings: [...warnings, ...detectorWarnings],
  };
}

// ---------------------------------------------------------------------------
// Vector-channel helpers
// ---------------------------------------------------------------------------

interface VectorChannel {
  embedder: Embedder;
  index: EmbeddingIndex;
}

/** The pair is usable when both halves exist and agree on model and dimension. */
function vectorChannel(embedder: Embedder | undefined, index: EmbeddingIndex | undefined): VectorChannel | null {
  if (embedder === undefined || index === undefined) return null;
  let dim: number;
  try {
    dim = embedder.dim;
  } catch {
    return null; // dimension not discovered yet (EmbedderError('not-ready'))
  }
  if (embedder.model !== index.model || dim !== index.dim) return null;
  return { embedder, index };
}

function channelWarnings(embedder: Embedder | undefined, index: EmbeddingIndex | undefined): string[] {
  if (embedder === undefined) {
    return ['no embedding provider: near-duplicate merge and semantic derivation skipped'];
  }
  if (index === undefined) {
    return ['no embedding index: near-duplicate merge and semantic derivation skipped'];
  }
  let dim: number;
  try {
    dim = embedder.dim;
  } catch {
    return [
      `embedder dimension not discovered yet (${embedder.model}): near-duplicate merge and semantic derivation skipped — run 'onemem doctor'`,
    ];
  }
  if (embedder.model !== index.model) {
    return [
      `embedding model mismatch (index '${index.model}', embedder '${embedder.model}'): near-duplicate merge and semantic derivation skipped`,
    ];
  }
  return [
    `embedding dimension mismatch (index ${index.dim}, embedder ${dim}): near-duplicate merge and semantic derivation skipped`,
  ];
}

/** Embed the pool once (content-hash-cached, batched) — both vector passes share the vectors. */
async function embedPool(
  pool: readonly MemoryRecord[],
  embedder: Embedder,
): Promise<Map<string, readonly number[]>> {
  const byContent = new Map<string, number[]>();
  const pending: Array<{ memoryId: string; content: string }> = [];
  for (const memory of pool) {
    if (byContent.has(memory.content)) continue;
    pending.push({ memoryId: memory.id, content: memory.content });
  }
  for (let start = 0; start < pending.length; start += EMBED_BATCH) {
    const batch = pending.slice(start, start + EMBED_BATCH);
    const vectors = await embedder.embed(batch.map((item) => item.content));
    if (vectors.length !== batch.length) {
      throw new Error(`embedder returned ${vectors.length} vectors for ${batch.length} texts`);
    }
    for (let index = 0; index < batch.length; index += 1) {
      byContent.set(batch[index]!.content, vectors[index]!);
    }
  }
  const byMemory = new Map<string, readonly number[]>();
  for (const memory of pool) {
    const vector = byContent.get(memory.content);
    if (vector !== undefined) byMemory.set(memory.id, vector);
  }
  return byMemory;
}

/** Probe the index with the first pool vector so a broken channel degrades, not crashes. */
async function probeIndex(
  index: EmbeddingIndex,
  embeddings: ReadonlyMap<string, readonly number[]>,
  warnings: string[],
): Promise<boolean> {
  if (embeddings.size === 0) return true;
  const first = embeddings.values().next().value!;
  try {
    await index.search([...first], 1, { minCosine: 0 });
    return true;
  } catch (error) {
    warnings.push(`vector index unavailable: ${errorMessage(error)} — near-duplicate merge and semantic derivation skipped`);
    return false;
  }
}

function exclude(pool: readonly MemoryRecord[], ids: readonly string[]): MemoryRecord[] {
  const out = new Set(ids);
  return pool.filter((memory) => !out.has(memory.id));
}
