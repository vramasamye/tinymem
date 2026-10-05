/**
 * The near-duplicate merge pass (memory-model.md §12 stage CONSOLIDATE; M14 mission scope):
 * same scope, same type, cosine ≥ 0.97 (the retrieval-dedupe threshold, retrieval.md §4) → one
 * surviving memory. Candidates come from the existing vector search channel
 * (`EmbeddingIndex.search`) driven with the pool's embeddings — no new SQL.
 *
 * HOW a merge is expressed over the Store port — a deliberate design decision:
 * the exact-dedupe invariant ((scope, type, content_hash) unique) means a merge product that
 * restates the keeper's content IS the keeper's row — the port has no "insert the same fact
 * again" (correctly) and no evidence-append primitive. So the SURVIVOR is the highest-authority
 * source row itself; every other member is closed into it through the audited supersession
 * fields (`superseded` + `valid_until` at merge time + `superseded_by` → the keeper), and the
 * full evidence union is recorded on the keeper's `merged` audit event. Nothing is deleted:
 * every absorbed row remains queryable with its own evidence, and `historyOf` walks the chain.
 */

import type { EmbeddingIndex, MemoryRecord, Store } from '@onememory/core';

import { authorityViewOf, mergeKeeperOrder } from './authority';
import { contradictsHeuristically, type ContradictionDetector } from './contradiction';
import type { MergeRecord } from './types';

export interface MergePassResult {
  records: MergeRecord[];
  /** Rows absorbed into keepers. */
  sourcesClosed: number;
  warnings: string[];
}

/**
 * Merge the near-duplicate clusters of the ACTIVE pool. Idempotent: absorbed rows leave the
 * active pool; a crash between mutations is healed by the next pass (each pair is re-derived
 * from the live pool). Per-item failures (an illegal transition after a concurrent write)
 * are skipped with a reason; a real store failure fails the pass.
 *
 * A cluster that still contains a CONTRADICTORY pair (per the same detector the contradiction
 * pass uses) is refused outright — normally unreachable (the contradiction pass runs first
 * and resolves every detected pair), but a skipped resolution must not turn into a silent
 * absorption: the pair stays in the pool for dispute/resolution instead (review finding P1-2).
 */
export async function runMergePass(
  store: Store,
  pool: readonly MemoryRecord[],
  vectors: EmbeddingIndex,
  embeddings: ReadonlyMap<string, readonly number[]>,
  options: {
    actor: string;
    now: Date;
    cosineThreshold: number;
    neighbors: number;
    /** Same detector the contradiction pass used — one definition of "conflict". */
    detector?: ContradictionDetector;
  },
): Promise<MergePassResult> {
  const detector = options.detector ?? contradictsHeuristically;
  const records: MergeRecord[] = [];
  const warnings: string[] = [];
  const nowIso = options.now.toISOString();

  // 1. Group by scope + type (a merge never crosses scopes or types).
  const groups = new Map<string, MemoryRecord[]>();
  for (const memory of pool) {
    const key = `${memory.project_id ?? '∅'}|${memory.user_id ?? '∅'}|${memory.type}`;
    const group = groups.get(key);
    if (group) group.push(memory);
    else groups.set(key, [memory]);
  }

  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const index = new Map(group.map((memory) => [memory.id, memory]));

    // 2. Union-find over near-duplicate pairs from the vector channel.
    const parent = new Map<string, string>(group.map((memory) => [memory.id, memory.id]));
    const pairCosine = new Map<string, number>();
    const find = (id: string): string => {
      let root = id;
      while (parent.get(root) !== root) root = parent.get(root)!;
      return root;
    };
    const union = (aId: string, bId: string): void => {
      const ra = find(aId);
      const rb = find(bId);
      if (ra !== rb) parent.set(ra, rb);
    };
    for (const memory of group) {
      const vector = embeddings.get(memory.id);
      if (vector === undefined) continue;
      const matches = await vectors.search([...vector], options.neighbors, {
        minCosine: options.cosineThreshold,
      });
      for (const match of matches) {
        const other = index.get(match.memory_id);
        if (other === undefined || other.id === memory.id) continue;
        union(memory.id, other.id);
        const key = match.memory_id < memory.id ? `${match.memory_id}|${memory.id}` : `${memory.id}|${match.memory_id}`;
        pairCosine.set(key, Math.max(pairCosine.get(key) ?? 0, match.cosine));
      }
    }

    const components = new Map<string, MemoryRecord[]>();
    for (const memory of group) {
      const root = find(memory.id);
      const component = components.get(root);
      if (component) component.push(memory);
      else components.set(root, [memory]);
    }

    for (const component of components.values()) {
      if (component.length < 2) continue;
      // The arbitration guard: a merge must never absorb a conflicting claim. Any flagged
      // pair disqualifies the WHOLE cluster — pruning only the flagged members would resolve
      // the conflict implicitly (the model's rule: never resolve by dropping members).
      const flagged = firstContradiction(component, detector);
      if (flagged !== null) {
        warnings.push(
          `skipped near-duplicate cluster of ${component.length}: contradiction between ` +
            `${flagged.aId} and ${flagged.bId} is unresolved — left for dispute/resolution`,
        );
        continue;
      }
      await mergeCluster(store, component, pairCosine, { actor: options.actor, nowIso, records, warnings });
    }
  }

  return {
    records,
    sourcesClosed: records.reduce((total, record) => total + record.merged_sources.length, 0),
    warnings,
  };
}

/** The first detector-flagged pair in a cluster, or null when the cluster is conflict-free. */
function firstContradiction(
  component: readonly MemoryRecord[],
  detector: ContradictionDetector,
): { aId: string; bId: string } | null {
  for (let i = 0; i < component.length; i += 1) {
    for (let j = i + 1; j < component.length; j += 1) {
      if (detector(component[i]!, component[j]!)) return { aId: component[i]!.id, bId: component[j]!.id };
    }
  }
  return null;
}

/** Merge ONE cluster into its keeper (the authority-ordered survivor). */
async function mergeCluster(
  store: Store,
  component: readonly MemoryRecord[],
  pairCosine: ReadonlyMap<string, number>,
  sink: {
    actor: string;
    nowIso: string;
    records: MergeRecord[];
    warnings: string[];
  },
): Promise<void> {
  // Keeper: the authority order (explicit > decision > newer > confidence), id on a full tie —
  // a merge is not a truth ruling, so a deterministic pick is honest here (see authority.ts).
  const ordered = [...component].sort((a, b) => mergeKeeperOrder(authorityViewOf(a), authorityViewOf(b)));
  const keeper = ordered[0]!;
  const sources = ordered.slice(1);

  const mergedSources: MergeRecord['merged_sources'] = [];
  const skippedSources: MergeRecord['skipped_sources'] = [];

  for (const source of sources) {
    // A merge absorbs a row; it does not rewrite history — so the loser's window closes at the
    // merge time, unlike a contradiction, where the fact changed at the winner's observation.
    // A window that would invert (a future-dated valid_from) is skipped instead.
    if (Date.parse(source.valid_from) > Date.parse(sink.nowIso)) {
      skippedSources.push({ id: source.id, reason: 'valid_from is after the merge time (inverted window)' });
      continue;
    }
    const cosineKey = source.id < keeper.id ? `${source.id}|${keeper.id}` : `${keeper.id}|${source.id}`;
    try {
      await store.updateMemoryStatus(source.id, 'superseded', {
        actor: sink.actor,
        reason: 'near-duplicate merge: absorbed into the highest-authority copy',
        valid_until: sink.nowIso,
        superseded_by_id: keeper.id,
        details: {
          merged_into: keeper.id,
          cosine: pairCosine.get(cosineKey) ?? null,
        },
      });
      mergedSources.push({ id: source.id, from_status: source.status, cosine: pairCosine.get(cosineKey) ?? 0 });
    } catch (error) {
      if (error instanceof Error && error.name === 'InvalidTransitionError') {
        skippedSources.push({ id: source.id, reason: `illegal transition ${source.status} → superseded` });
        continue;
      }
      throw error;
    }
  }

  if (mergedSources.length === 0) return;

  // The merged audit event on the keeper: the evidence union of the whole cluster, recorded
  // verbatim (the Store port has no evidence-append primitive; the audit trail is where the
  // union lives — every absorbed row keeps its own evidence in history).
  const evidenceUnion = [keeper, ...mergedSourcesIdentities(component, keeper)].flatMap(
    (memory) => memory.provenance.evidence,
  );
  await store.appendMemoryEvent({
    memory_id: keeper.id,
    action: 'merged',
    from_status: keeper.status,
    to_status: keeper.status,
    actor: sink.actor,
    details: {
      merged_from: mergedSources.map((source) => source.id),
      skipped_sources: skippedSources,
      evidence_union: evidenceUnion,
      evidence_union_count: evidenceUnion.length,
      cosines: Object.fromEntries(mergedSources.map((source) => [source.id, source.cosine])),
    },
    at: sink.nowIso,
  });

  sink.records.push({
    keeper_id: keeper.id,
    keeper_status_from: keeper.status,
    merged_sources: mergedSources,
    skipped_sources: skippedSources,
  });
}

/** Every cluster member except the keeper (for the evidence union). */
function mergedSourcesIdentities(
  component: readonly MemoryRecord[],
  keeper: MemoryRecord,
): MemoryRecord[] {
  return component.filter((memory) => memory.id !== keeper.id);
}
