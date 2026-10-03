/**
 * Stage-5 golden tests — RRF fusion + additive weighted scoring with the DEFAULT weights
 * (retrieval.md §5). Hand-computed expectations: known candidates → known ranking.
 */

import { describe, expect, test } from 'bun:test';

import { candidateFromMemory } from './candidates';
import type { RetrievalCandidate } from './candidates';
import { DEFAULT_RETRIEVAL_CONFIG, mergeConfig } from './config';
import { scoreCandidates } from './fusion';
import type { FusionContext } from './fusion';

const NOW = new Date('2027-01-15T00:00:00.000Z');

/** Minimal in-memory candidate builder (the unified shape; no database). */
function candidate(seed: Partial<RetrievalCandidate> & Pick<RetrievalCandidate, 'id' | 'type' | 'content'>): RetrievalCandidate {
  return {
    kind: 'durable',
    status: 'active',
    importance: 0.5,
    confidence: 0.5,
    accessCount: 0,
    observedAt: '2027-01-01T00:00:00.000Z',
    validFrom: '2027-01-01T00:00:00.000Z',
    contentHash: `hash-${seed.id}`,
    sourceKind: 'conversation',
    entityIds: [],
    entityNames: [],
    channels: {},
    graphBoost: 0,
    ...seed,
  };
}

const baseContext: FusionContext = {
  intent: 'fact',
  requestProjectId: '11111111-1111-1111-1111-111111111111',
  now: NOW,
  queryEntityIds: ['00000000-0000-0000-0000-0000000000e1'],
  activeChannels: { vector: true, lexical: true },
  temporalNote: 'currently valid (temporal filter passed)',
};

describe('golden ranking with default weights (fact intent)', () => {
  const a = candidate({
    id: '00000000-0000-0000-0000-0000000000a1',
    type: 'semantic',
    content: 'Node version 22 is required.',
    importance: 0.8,
    confidence: 0.9,
    accessCount: 3,
    observedAt: '2026-12-15T00:00:00.000Z', // exactly 31 days before NOW
    projectId: '11111111-1111-1111-1111-111111111111',
    entityIds: ['00000000-0000-0000-0000-0000000000e1'],
    entityNames: ['Node.js'],
    channels: { vector: 1, lexical: 2 },
  });
  const b = candidate({
    id: '00000000-0000-0000-0000-0000000000b2',
    type: 'episodic',
    content: 'Something unrelated happened.',
    importance: 0.3,
    confidence: 0.5,
    accessCount: 0,
    observedAt: '2026-11-15T00:00:00.000Z', // exactly 61 days before NOW
    projectId: '22222222-2222-2222-2222-222222222222',
  });
  const c = candidate({
    id: '00000000-0000-0000-0000-0000000000c3',
    type: 'semantic',
    content: 'A graph-only neighbor.',
    importance: 0.5,
    confidence: 0.5,
    observedAt: '2026-06-15T00:00:00.000Z',
    projectId: '11111111-1111-1111-1111-111111111111',
    channels: { graph: 1 },
    graphBoost: Math.pow(0.8, 2), // 2-hop neighbor
    graphSource: '2-hop graph neighbor (edge valid at query time)',
  });

  test('hand-computed score and relevance for the multi-channel candidate', () => {
    const scored = scoreCandidates([a, b, c], baseContext, DEFAULT_RETRIEVAL_CONFIG);
    expect(scored[0]?.candidate.id).toBe(a.id);

    const expectedScore =
      0.2 * 1.0 + // w_sem × rrf(vector rank 1) = (60+1)/(60+1)
      0.16 * (61 / 62) + // w_lex × rrf(lexical rank 2)
      0.12 * 0.8 + // w_imp × importance
      0.08 * 0.9 + // w_conf × confidence
      0.1 * Math.pow(0.5, 31 / 400) + // w_rec × decay (semantic half-life 400d, age 31d)
      0.05 * (Math.log(4) / Math.log(11)) + // w_acc × log-normalized access_count 3
      0.1 * 1.0 + // w_proj × same project
      0.1 * 1.0 + // w_ent × full query-entity overlap
      0.1; // type_affinity fact×semantic (matrix cell IS the weight)
    const mass =
      0.2 + 0.16 + 0.08 + 0.12 + 0.08 + 0.1 + 0.05 + 0.1 + 0.1 + 0.1; // + max fact-affinity (0.10)
    expect(scored[0]?.score).toBeCloseTo(expectedScore, 9);
    expect(scored[0]?.relevance).toBeCloseTo(expectedScore / mass, 6);
    expect(scored[0]?.relevance).toBeLessThanOrEqual(1);
  });

  test('the no-channel episodic candidate scores from stored fields only', () => {
    const scored = scoreCandidates([a, b, c], baseContext, DEFAULT_RETRIEVAL_CONFIG);
    const scoredB = scored.find((entry) => entry.candidate.id === b.id)!;
    const expectedScore =
      0.12 * 0.3 + // importance
      0.08 * 0.5 + // confidence
      0.1 * Math.pow(0.5, 61 / 30) + // recency (episodic half-life 30d, age 61d)
      0.1 * 0.7 + // project match: cross-project
      0.03; // type_affinity fact×episodic
    expect(scoredB.score).toBeCloseTo(expectedScore, 9);
    expect(scoredB.relevance).toBeCloseTo(expectedScore / mass1_09(), 6);
    // Explain carries ONLY the fired factors + the temporal note.
    const factors = scoredB.explain.map((entry) => entry.factor);
    expect(factors).toEqual([
      'confidence',
      'importance',
      'project_match',
      'recency',
      'type_affinity',
      'temporal_validity',
    ]);
  });

  test('graph boost enters as w_graph × decay(hops), and explain reports the hop source', () => {
    const scored = scoreCandidates([a, b, c], baseContext, DEFAULT_RETRIEVAL_CONFIG);
    const scoredC = scored.find((entry) => entry.candidate.id === c.id)!;
    const graphEntry = scoredC.explain.find((entry) => entry.factor === 'graph_proximity');
    expect(graphEntry?.weight).toBeCloseTo(0.08, 6);
    expect(graphEntry?.detail).toContain('2-hop graph neighbor');
    expect(scoredC.score).toBeCloseTo(
      0.08 * Math.pow(0.8, 2) + 0.12 * 0.5 + 0.08 * 0.5 + 0.1 * Math.pow(0.5, 214 / 400) +
        0.1 * 1.0 + 0.1, // graph + imp + conf + rec(2026-06-15 → 214d, semantic 400d) + proj + affinity
      9,
    );
  });

  test('ordering: multi-channel project-matched semantic > graph neighbor > bare episodic', () => {
    const scored = scoreCandidates([b, c, a], baseContext, DEFAULT_RETRIEVAL_CONFIG);
    expect(scored.map((entry) => entry.candidate.id)).toEqual([
      a.id, c.id, b.id,
    ]);
  });
});

function mass1_09(): number {
  return (
    0.2 + 0.16 + 0.08 + 0.12 + 0.08 + 0.1 + 0.05 + 0.1 + 0.1 + 0.1
  );
}

describe('degraded normalization + affinity matrix behavior', () => {
  test('vector channel unavailable → w_sem drops from the mass (weight redistributed)', () => {
    const x = candidate({
      id: '00000000-0000-0000-0000-0000000000d4',
      type: 'semantic',
      content: 'Lexical only hit.',
      importance: 0.5,
      confidence: 0.5,
      projectId: '11111111-1111-1111-1111-111111111111',
      channels: { lexical: 1 },
    });
    const active = scoreCandidates([x], baseContext, DEFAULT_RETRIEVAL_CONFIG);
    const degraded = scoreCandidates([x], { ...baseContext, activeChannels: { vector: false, lexical: true } }, DEFAULT_RETRIEVAL_CONFIG);
    // Same raw contributions, smaller mass → HIGHER normalized relevance (redistribution).
    expect(degraded[0]?.score).toBeCloseTo(active[0]?.score ?? 0, 9);
    expect(degraded[0]?.relevance).toBeGreaterThan(active[0]?.relevance ?? 0);
  });

  test('failure intent boosts failure/procedural types through the affinity matrix', () => {
    const failureMemory = candidate({ id: '00000000-0000-0000-0000-0000000000f1', type: 'failure', content: 'It broke.' });
    const semanticMemory = candidate({ id: '00000000-0000-0000-0000-0000000000f2', type: 'semantic', content: 'It is a fact.' });
    const failureCtx: FusionContext = { ...baseContext, intent: 'failure', queryEntityIds: [] };
    const scored = scoreCandidates([semanticMemory, failureMemory], failureCtx, DEFAULT_RETRIEVAL_CONFIG);
    expect(scored[0]?.candidate.type).toBe('failure');
    const affinity = scored[0]?.explain.find((entry) => entry.factor === 'type_affinity');
    expect(affinity?.weight).toBeCloseTo(0.15, 6); // matrix cell, not a scalar w_type
  });

  test('weights are config-overridable and the explain reflects the override', () => {
    const config = mergeConfig({ weights: { w_imp: 0.4 } });
    const x = candidate({
      id: '00000000-0000-0000-0000-0000000000g1',
      type: 'semantic',
      content: 'Importance heavy.',
      importance: 1.0,
      confidence: 0,
      observedAt: '2027-01-15T00:00:00.000Z', // age 0 → recency signal 1
    });
    const scored = scoreCandidates([x], { ...baseContext, queryEntityIds: [] }, config);
    const imp = scored[0]?.explain.find((entry) => entry.factor === 'importance');
    expect(imp?.weight).toBeCloseTo(0.4, 6);
    expect(scored[0]?.score).toBeCloseTo(
      0.4 * 1.0 + // w_imp(overridden) × importance
        0.1 * 1.0 + // w_rec × recency (age 0)
        0.1 * 0.4 + // w_proj × user-global memory (no project on the candidate)
        0.1, // type_affinity fact×semantic
      9,
    );
  });
});
