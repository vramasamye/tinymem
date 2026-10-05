/**
 * The clustering primitives shared by the consolidation passes (near-duplicate merge, episodic
 * → semantic derivation, and the contradiction pass's grouping): the stable unordered pair
 * key, the scope-grouping key, and connected components over the existing vector search
 * channel — `EmbeddingIndex.search` driven with the pool's own embeddings. No new SQL, no
 * vector-table scans.
 */

import type { EmbeddingIndex, MemoryRecord } from '@onememory/core';

/** Stable unordered pair key. */
export function pairKey(aId: string, bId: string): string {
  return aId < bId ? `${aId}|${bId}` : `${bId}|${aId}`;
}

/** The scope part of a grouping key — no pass groups rows across scopes. */
export function scopeKeyOf(memory: MemoryRecord): string {
  return `${memory.project_id ?? '∅'}|${memory.user_id ?? '∅'}`;
}

export interface CosineComponents {
  /** Connected components of the group, in encounter order. */
  components: MemoryRecord[][];
  /** Best certified cosine per unordered pair — present only for pairs the channel returned. */
  pairCosine: Map<string, number>;
  /** Total pairwise cosine per member (centrality — the derivation representative signal). */
  cosineSum: Map<string, number>;
}

/**
 * Connected components by cosine over ONE group (the caller groups by scope plus type,
 * template, or entity): union-find over the matches the vector channel certifies at
 * `minCosine`, with `neighbors` fan-out per member.
 *
 * `pairCosine` records only the pairs the channel actually returned — an absent key means
 * "not certified at this threshold", which is exactly what the merge pass's pairwise keeper
 * gating reads: a transitive A–B–C chain never certifies the A–C pair, so C cannot smuggle
 * itself past the keeper gate. `cosineSum` accumulates both sides of every certified pair
 * (centrality). Members without an embedding form their own singleton components.
 */
export async function cosineComponents(
  group: readonly MemoryRecord[],
  vectors: EmbeddingIndex,
  embeddings: ReadonlyMap<string, readonly number[]>,
  options: { minCosine: number; neighbors: number },
): Promise<CosineComponents> {
  const index = new Map(group.map((memory) => [memory.id, memory]));
  const parent = new Map<string, string>(group.map((memory) => [memory.id, memory.id]));
  const pairCosine = new Map<string, number>();
  const cosineSum = new Map<string, number>();
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
    const matches = await vectors.search([...vector], options.neighbors, { minCosine: options.minCosine });
    for (const match of matches) {
      const other = index.get(match.memory_id);
      if (other === undefined || other.id === memory.id) continue;
      union(memory.id, other.id);
      const key = pairKey(memory.id, other.id);
      pairCosine.set(key, Math.max(pairCosine.get(key) ?? 0, match.cosine));
      cosineSum.set(memory.id, (cosineSum.get(memory.id) ?? 0) + match.cosine);
      cosineSum.set(other.id, (cosineSum.get(other.id) ?? 0) + match.cosine);
    }
  }
  const components = new Map<string, MemoryRecord[]>();
  for (const memory of group) {
    const root = find(memory.id);
    const component = components.get(root);
    if (component) component.push(memory);
    else components.set(root, [memory]);
  }
  return { components: [...components.values()], pairCosine, cosineSum };
}
