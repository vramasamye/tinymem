/**
 * The shared clustering primitives: the stable pair key, the scope-grouping key, and connected
 * components over the vector channel — including the exact property the pairwise merge gating
 * relies on (an uncertified pair has NO pairCosine entry, so transitive closure cannot smuggle
 * a below-threshold member past the keeper gate).
 */

import { describe, expect, test } from 'bun:test';

import { cosineComponents, pairKey, scopeKeyOf } from './cluster';
import { MemoryEmbeddingIndex, memoryFixture } from './testing';

const PROJECT = '00000000-0000-7000-8002-000000000009';
const OTHER_PROJECT = '00000000-0000-7000-8002-000000000010';

describe('pairKey', () => {
  test('is stable for an unordered pair', () => {
    expect(pairKey('a', 'b')).toBe('a|b');
    expect(pairKey('b', 'a')).toBe('a|b');
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
  });
});

describe('scopeKeyOf', () => {
  test('keys a memory by its scope (project then user)', () => {
    const user = '00000000-0000-7000-8002-000000000011';
    expect(scopeKeyOf(memoryFixture({ project_id: PROJECT, user_id: user }))).toBe(`${PROJECT}|${user}`);
  });

  test('absent scopes collapse to the same key; different projects never do', () => {
    expect(scopeKeyOf(memoryFixture({ project_id: null }))).toBe(scopeKeyOf(memoryFixture({ project_id: null })));
    expect(scopeKeyOf(memoryFixture({ project_id: null }))).not.toBe(scopeKeyOf(memoryFixture({ project_id: PROJECT })));
    expect(scopeKeyOf(memoryFixture({ project_id: PROJECT }))).not.toBe(
      scopeKeyOf(memoryFixture({ project_id: OTHER_PROJECT })),
    );
  });
});

describe('cosineComponents', () => {
  test('clusters transitively but certifies only the pairs the channel returned at the threshold', async () => {
    // a–b and b–c at ≈ 0.98 (≥ 0.97), a–c at ≈ 0.92 (below) — the pairwise-gating shape.
    const a = memoryFixture({ project_id: PROJECT, content: 'cluster member a' });
    const b = memoryFixture({ project_id: PROJECT, content: 'cluster member b' });
    const c = memoryFixture({ project_id: PROJECT, content: 'cluster member c' });
    const index = new MemoryEmbeddingIndex('test/model', 2);
    const embeddings = new Map<string, readonly number[]>([
      [a.id, [1, 0.2]],
      [b.id, [1, 0]],
      [c.id, [1, -0.2]],
    ]);
    for (const [id, vector] of embeddings) await index.upsert(id, [...vector]);

    const result = await cosineComponents([a, b, c], index, embeddings, { minCosine: 0.97, neighbors: 10 });

    // One transitive component of three.
    expect(result.components.length).toBe(1);
    expect(result.components[0]!.map((memory) => memory.id).sort()).toEqual([a.id, b.id, c.id].sort());

    // The certified pairs — and NOT the uncertified a–c pair (the merge gate reads exactly this).
    expect(result.pairCosine.get(pairKey(a.id, b.id))).toBeCloseTo(0.9806, 3);
    expect(result.pairCosine.get(pairKey(b.id, c.id))).toBeCloseTo(0.9806, 3);
    expect(result.pairCosine.has(pairKey(a.id, c.id))).toBeFalse();

    // Centrality: b touched both certified pairs, a only one.
    expect(result.cosineSum.get(b.id)!).toBeGreaterThan(result.cosineSum.get(a.id)!);
  });

  test('orthogonal members and members without embeddings form their own components', async () => {
    const grouped = memoryFixture({ project_id: PROJECT, content: 'in the group, embedded' });
    const orthogonal = memoryFixture({ project_id: PROJECT, content: 'in the group, orthogonal' });
    const unembedded = memoryFixture({ project_id: PROJECT, content: 'in the group, no vector' });
    const index = new MemoryEmbeddingIndex('test/model', 2);
    await index.upsert(grouped.id, [1, 0]);
    await index.upsert(orthogonal.id, [-1, 0]); // cosine -1 to the first — never a match
    const embeddings = new Map<string, readonly number[]>([
      [grouped.id, [1, 0]],
      [orthogonal.id, [-1, 0]],
      // unembedded: present in the group, absent from the embeddings map
    ]);

    const result = await cosineComponents([grouped, orthogonal, unembedded], index, embeddings, {
      minCosine: 0.75,
      neighbors: 10,
    });

    expect(result.components.length).toBe(3);
    for (const component of result.components) expect(component.length).toBe(1);
    expect(result.pairCosine.size).toBe(0);
  });
});
