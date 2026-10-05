/**
 * The configuration boundary: the floors the spec makes mandatory are enforced at the Zod
 * boundary with clear messages (review finding P2-5) — a config must not be able to weaken
 * the near-duplicate semantics or derive semantic memories from pairs.
 */

import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_CONSOLIDATION_CONFIG,
  MIN_DERIVATION_CLUSTER_SIZE,
  MIN_NEAR_DUPLICATE_COSINE,
  resolveConsolidationConfig,
} from './types';

describe('ConsolidationConfigSchema (mandatory floors)', () => {
  test('rejects a derivation cluster floor below 3 (one semantic memory needs ≥ 3 episodes)', () => {
    expect(() => resolveConsolidationConfig({ derivation: { minClusterSize: 2 } })).toThrow(
      /at least 3 .*memory-model/,
    );
  });

  test('rejects a near-duplicate threshold below the 0.9 floor', () => {
    expect(() => resolveConsolidationConfig({ nearDuplicate: { cosineThreshold: 0.5 } })).toThrow(/0\.9/);
    expect(() => resolveConsolidationConfig({ nearDuplicate: { cosineThreshold: 0 } })).toThrow(/0\.9/);
  });

  test('rejects a threshold above 1 as before (the range still holds)', () => {
    expect(() => resolveConsolidationConfig({ nearDuplicate: { cosineThreshold: 1.5 } })).toThrow();
  });

  test('accepts the floor boundaries themselves', () => {
    const atFloor = resolveConsolidationConfig({
      nearDuplicate: { cosineThreshold: MIN_NEAR_DUPLICATE_COSINE },
      derivation: { minClusterSize: MIN_DERIVATION_CLUSTER_SIZE },
    });
    expect(atFloor.nearDuplicate.cosineThreshold).toBe(0.9);
    expect(atFloor.derivation.minClusterSize).toBe(3);
  });

  test('the defaults stay at the documented values (0.97 near-duplicate, ≥ 3 episodes)', () => {
    expect(DEFAULT_CONSOLIDATION_CONFIG.nearDuplicate.cosineThreshold).toBe(0.97);
    expect(DEFAULT_CONSOLIDATION_CONFIG.derivation.minClusterSize).toBe(3);
    const resolved = resolveConsolidationConfig();
    expect(resolved.nearDuplicate.cosineThreshold).toBe(0.97);
    expect(resolved.derivation.minClusterSize).toBe(3);
  });
});
