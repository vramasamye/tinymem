/**
 * The decay rules (memory-model.md §7): the prominence formula
 * `importance^0.5 × confidence × recency(age, per-type half-life) × (1 + log(1 + access_count))`,
 * the decay-resistance floor for decisions and verified procedures, and the archive threshold.
 * Archive, never delete.
 */

import { describe, expect, test } from 'bun:test';

import { effectiveImportance, isDecayResistant, prominence, shouldArchive } from './decay';
import { memoryFixture } from './testing';

const NOW = new Date('2026-10-01T00:00:00.000Z');
const FLOOR = 0.6;
const EPISODIC_HALF_LIFE = 30; // days (retrieval.md §5 table, reused via DEFAULT_HALF_LIFE_DAYS)
const DAY_MS = 86_400_000;

function ageDays(observedAt: string): string {
  return new Date(NOW.getTime() - Date.parse(observedAt)).toISOString();
}

describe('isDecayResistant / effectiveImportance', () => {
  test('decisions are decay-resistant and get the importance floor', () => {
    const decision = memoryFixture({ type: 'decision', importance: 0.2 });
    expect(isDecayResistant(decision)).toBeTrue();
    expect(effectiveImportance(decision, FLOOR)).toBe(FLOOR);
  });

  test('procedural memories with verification evidence are decay-resistant', () => {
    const verified = memoryFixture({ type: 'procedural', importance: 0.2, verified_at: '2026-09-01T00:00:00.000Z' });
    expect(isDecayResistant(verified)).toBeTrue();
    expect(effectiveImportance(verified, FLOOR)).toBe(FLOOR);
  });

  test('unverified procedural memories and every other type get no floor', () => {
    const unverified = memoryFixture({ type: 'procedural', importance: 0.2 });
    expect(isDecayResistant(unverified)).toBeFalse();
    expect(effectiveImportance(unverified, FLOOR)).toBe(0.2);
    for (const type of ['episodic', 'semantic', 'failure', 'preference'] as const) {
      const memory = memoryFixture({ type, importance: 0.2 });
      expect(isDecayResistant(memory)).toBeFalse();
      expect(effectiveImportance(memory, FLOOR)).toBe(0.2);
    }
  });

  test('a decay-resistant memory above the floor keeps its own importance', () => {
    const decision = memoryFixture({ type: 'decision', importance: 0.8 });
    expect(effectiveImportance(decision, FLOOR)).toBe(0.8);
  });
});

describe('prominence — the formula', () => {
  test('a fresh, never-accessed memory: sqrt(importance) × confidence', () => {
    const fresh = memoryFixture({
      type: 'episodic',
      importance: 0.64,
      confidence: 0.5,
      observed_at: NOW.toISOString(),
    });
    // recency = 1 (age 0), access factor = 1 + log(1) = 1
    expect(prominence(fresh, NOW, EPISODIC_HALF_LIFE, FLOOR)).toBeCloseTo(Math.sqrt(0.64) * 0.5, 12);
  });

  test('recency halves per half-life', () => {
    const observedAt = new Date(NOW.getTime() - EPISODIC_HALF_LIFE * DAY_MS).toISOString();
    const one = memoryFixture({ type: 'episodic', importance: 1, confidence: 1, observed_at: observedAt });
    const two = memoryFixture({
      type: 'episodic',
      importance: 1,
      confidence: 1,
      observed_at: new Date(NOW.getTime() - 2 * EPISODIC_HALF_LIFE * DAY_MS).toISOString(),
    });
    expect(prominence(one, NOW, EPISODIC_HALF_LIFE, FLOOR)).toBeCloseTo(0.5, 12);
    expect(prominence(two, NOW, EPISODIC_HALF_LIFE, FLOOR)).toBeCloseTo(0.25, 12);
  });

  test('the access factor is (1 + log(1 + access_count)) — access only ever raises prominence', () => {
    const zero = memoryFixture({ access_count: 0, importance: 1, confidence: 1, observed_at: NOW.toISOString() });
    const ten = memoryFixture({ access_count: 10, importance: 1, confidence: 1, observed_at: NOW.toISOString() });
    expect(prominence(zero, NOW, EPISODIC_HALF_LIFE, FLOOR)).toBeCloseTo(1, 12);
    expect(prominence(ten, NOW, EPISODIC_HALF_LIFE, FLOOR)).toBeCloseTo(1 + Math.log(1 + 10), 12);
  });

  test('episodic decays faster than decision (per-type half-lives)', () => {
    const halfAYearAgo = new Date(NOW.getTime() - 180 * DAY_MS).toISOString();
    const episodic = memoryFixture({ type: 'episodic', importance: 1, confidence: 1, observed_at: halfAYearAgo });
    const decision = memoryFixture({ type: 'decision', importance: 1, confidence: 1, observed_at: halfAYearAgo });
    // episodic: 0.5^(180/30) = 0.5^6; decision (half-life 400): 0.5^(180/400)
    expect(prominence(episodic, NOW, 30, FLOOR)).toBeCloseTo(Math.pow(0.5, 6), 12);
    expect(prominence(decision, NOW, 400, FLOOR)).toBeCloseTo(Math.pow(0.5, 180 / 400), 12);
  });

  test('the resistance floor feeds the formula (an old low-importance decision survives longer)', () => {
    const observedAt = new Date(NOW.getTime() - 60 * DAY_MS).toISOString();
    const lowDecision = memoryFixture({ type: 'decision', importance: 0.1, confidence: 0.7, observed_at: observedAt });
    // without the floor: sqrt(0.1)*0.7*0.25 = ~0.055; with the floor: sqrt(0.6)*0.7*0.25 = ~0.136
    expect(prominence(lowDecision, NOW, 400, FLOOR)).toBeCloseTo(Math.sqrt(0.6) * 0.7 * Math.pow(0.5, 60 / 400), 12);
  });
});

describe('shouldArchive', () => {
  test('an old, rarely accessed, low-importance episodic memory archives', () => {
    const old = memoryFixture({
      type: 'episodic',
      importance: 0.3,
      confidence: 0.5,
      access_count: 0,
      observed_at: new Date(NOW.getTime() - 365 * DAY_MS).toISOString(),
    });
    // sqrt(0.3)*0.5*0.5^(365/30) ≈ 0.274*0.5*0.0000227 ≈ 3.1e-6 — far below any sane threshold
    expect(shouldArchive(old, NOW, 0.05, EPISODIC_HALF_LIFE, FLOOR)).toBeTrue();
  });

  test('a fresh memory never archives at a sane threshold', () => {
    const fresh = memoryFixture({ type: 'episodic', importance: 0.5, confidence: 0.5, observed_at: NOW.toISOString() });
    expect(shouldArchive(fresh, NOW, 0.05, EPISODIC_HALF_LIFE, FLOOR)).toBeFalse();
  });

  test('an old decision stays above the threshold via the floor', () => {
    const oldDecision = memoryFixture({
      type: 'decision',
      importance: 0.1,
      confidence: 0.8,
      observed_at: new Date(NOW.getTime() - 365 * DAY_MS).toISOString(),
    });
    // sqrt(0.6)*0.8*0.5^(365/400) ≈ 0.775*0.8*0.532 ≈ 0.33 > 0.05
    expect(shouldArchive(oldDecision, NOW, 0.05, 400, FLOOR)).toBeFalse();
  });

  test('a heavily accessed memory survives where a never-accessed copy would archive', () => {
    // 30 days old, half-life 30d: recency 0.5; access 50 → factor ≈ 1 + ln(51) ≈ 4.93
    const used = memoryFixture({
      type: 'episodic',
      importance: 0.3,
      confidence: 0.5,
      access_count: 50,
      observed_at: new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
    });
    const unused = memoryFixture({
      type: 'episodic',
      importance: 0.3,
      confidence: 0.5,
      access_count: 0,
      observed_at: new Date(NOW.getTime() - 30 * DAY_MS).toISOString(),
    });
    expect(prominence(unused, NOW, EPISODIC_HALF_LIFE, FLOOR)).toBeCloseTo(
      Math.sqrt(0.3) * 0.5 * 0.5 * 1,
      12,
    );
    expect(shouldArchive(used, NOW, 0.05, EPISODIC_HALF_LIFE, FLOOR)).toBeFalse();
    expect(prominence(used, NOW, EPISODIC_HALF_LIFE, FLOOR)).toBeGreaterThan(0.05);
  });

  test('a verified procedure resists decay where an unverified one archives', () => {
    // 450 days old, half-life 180d: unverified 0.447×0.5×0.177 ≈ 0.040 (archives);
    // floored (0.6) verified 0.775×0.5×0.177 ≈ 0.069 (survives).
    const observedAt = new Date(NOW.getTime() - 450 * DAY_MS).toISOString();
    const unverified = memoryFixture({ type: 'procedural', importance: 0.2, confidence: 0.5, observed_at: observedAt });
    const verified = memoryFixture({
      type: 'procedural',
      importance: 0.2,
      confidence: 0.5,
      observed_at: observedAt,
      verified_at: '2026-09-01T00:00:00.000Z',
    });
    expect(shouldArchive(unverified, NOW, 0.05, 180, FLOOR)).toBeTrue();
    expect(shouldArchive(verified, NOW, 0.05, 180, FLOOR)).toBeFalse();
  });
});
