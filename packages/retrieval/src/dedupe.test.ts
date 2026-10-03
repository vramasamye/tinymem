/**
 * Stage-4 unit tests — exact content-hash collapse and the authority-ordered near-duplicate
 * collapse. Pure (the similarity callback is injected).
 */

import { describe, expect, test } from 'bun:test';

import type { RetrievalCandidate } from './candidates';
import { authorityRank, dedupeCandidates } from './dedupe';

function candidate(seed: Partial<RetrievalCandidate> & Pick<RetrievalCandidate, 'id' | 'content' | 'type'>): RetrievalCandidate {
  return {
    kind: 'durable',
    status: 'active',
    importance: 0.5,
    confidence: 0.5,
    accessCount: 0,
    observedAt: '2025-06-01T00:00:00.000Z',
    validFrom: '2025-06-01T00:00:00.000Z',
    contentHash: `hash-${seed.id}`,
    sourceKind: 'conversation',
    entityIds: [],
    entityNames: [],
    channels: {},
    graphBoost: 0,
    ...seed,
  };
}

describe('authorityRank (memory-model.md §9 order)', () => {
  test('explicit > decision > semantic/procedural/failure/preference > episodic', () => {
    expect(authorityRank(candidate({ id: 'a', type: 'semantic', content: 'x', sourceKind: 'explicit' }))).toBe(4);
    expect(authorityRank(candidate({ id: 'a', type: 'decision', content: 'x' }))).toBe(3);
    expect(authorityRank(candidate({ id: 'a', type: 'semantic', content: 'x' }))).toBe(2);
    expect(authorityRank(candidate({ id: 'a', type: 'episodic', content: 'x' }))).toBe(1);
  });
});

describe('dedupeCandidates', () => {
  test('same content_hash collapses to one survivor (channels merged, best kept)', async () => {
    const a = candidate({
      id: 'a', type: 'semantic', content: 'Node 22 is required.', confidence: 0.8,
      channels: { lexical: 1 }, graphBoost: 0.5, graphSource: 'entity-bound',
    });
    const b = candidate({
      id: 'b', type: 'semantic', content: 'Node 22 is required.', confidence: 0.9,
      contentHash: 'hash-a', channels: { vector: 1 }, graphBoost: 0.2,
    });
    const result = await dedupeCandidates([a, b], { cosineThreshold: 0.97 });
    expect(result.kept.length).toBe(1);
    expect(result.exactCollapsed).toBe(1);
    expect(result.kept[0]?.id).toBe('b'); // higher confidence wins the authority tie-break
    expect(result.kept[0]?.channels).toEqual({ lexical: 1, vector: 1 }); // channels merged
    expect(result.kept[0]?.graphBoost).toBe(0.5); // best boost + its explain source kept
    expect(result.kept[0]?.graphSource).toBe('entity-bound');
  });

  test('near-duplicates in the same (entity, type) group collapse by authority via similarity', async () => {
    // Same primary entity, same type, 0.99 cosine — but different exact hashes.
    const explicitStatement = candidate({
      id: 'explicit', type: 'semantic', content: 'The primary database is PostgreSQL.',
      sourceKind: 'explicit', confidence: 0.7, entityIds: ['e1'],
    });
    const observation = candidate({
      id: 'observation', type: 'semantic', content: 'The primary database is PostgreSQL here.',
      confidence: 0.95, entityIds: ['e1'],
    });
    const unrelated = candidate({
      id: 'unrelated', type: 'semantic', content: 'Completely different content.',
      confidence: 0.5, entityIds: ['e1'],
    });
    const result = await dedupeCandidates([observation, explicitStatement, unrelated], {
      cosineThreshold: 0.97,
      similarity: async (x, y) => (x.id === 'unrelated' || y.id === 'unrelated' ? 0.1 : 0.99),
    });
    expect(result.kept.map((entry) => entry.id).sort()).toEqual(['explicit', 'unrelated']);
    expect(result.nearCollapsed).toBe(1); // the observation lost to the explicit statement
  });

  test('high-confidence wins within the same authority class; recency breaks remaining ties', async () => {
    const older = candidate({ id: 'older', type: 'semantic', content: 'A.', confidence: 0.9, observedAt: '2025-01-01T00:00:00.000Z' });
    const newer = candidate({ id: 'newer', type: 'semantic', content: 'B.', confidence: 0.9, observedAt: '2025-06-01T00:00:00.000Z' });
    const result = await dedupeCandidates([older, newer], {
      cosineThreshold: 0.97,
      similarity: async () => 0.99,
    });
    expect(result.kept.map((entry) => entry.id)).toEqual(['newer']);
  });

  test('without a similarity callback the near-duplicate tier is skipped (exact hash only)', async () => {
    const a = candidate({ id: 'a', type: 'semantic', content: 'Alpha.', entityIds: ['e1'] });
    const b = candidate({ id: 'b', type: 'semantic', content: 'Alpha, slightly different.', entityIds: ['e1'] });
    const result = await dedupeCandidates([a, b], { cosineThreshold: 0.97 });
    expect(result.kept.length).toBe(2);
    expect(result.nearCollapsed).toBe(0);
  });

  test('different primary entities never near-collapse even at cosine 1.0', async () => {
    const a = candidate({ id: 'a', type: 'semantic', content: 'Same.', entityIds: ['e1'] });
    const b = candidate({ id: 'b', type: 'semantic', content: 'Same.', entityIds: ['e2'] });
    const result = await dedupeCandidates([a, b], {
      cosineThreshold: 0.97,
      similarity: async () => 1.0,
    });
    expect(result.kept.length).toBe(2);
  });
});
