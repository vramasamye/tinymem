import { describe, expect, test } from 'bun:test';

import { isUuid, NIL_UUID, uuidv7 } from './uuidv7';

describe('uuidv7 (RFC 9562)', () => {
  test('generates valid uuids (version 7, correct variant)', () => {
    for (let i = 0; i < 50; i++) {
      const id = uuidv7();
      expect(isUuid(id)).toBe(true);
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  test('strictly monotonic: lexicographic order == generation order', () => {
    const ids = Array.from({ length: 200 }, () => uuidv7());
    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  test('embeds the unix millisecond timestamp (48 bits, big-endian)', () => {
    const now = Date.now();
    const id = uuidv7(now);
    const hex = id.replace(/-/g, '');
    const ts = Number.parseInt(hex.slice(0, 12), 16);
    expect(ts).toBe(now);
  });

  test('explicit clock input is honored, and a backwards clock never breaks monotonicity', () => {
    const a = uuidv7(1_000_000_000_000);
    const b = uuidv7(999_999_999_999); // earlier wall clock — monotonicity wins
    expect(b > a).toBe(true);
  });

  test('same-millisecond generation survives counter overflow without duplication', () => {
    // Larger than any clock value used by earlier tests in this file: the monotonicity guard
    // (a backwards clock never wins) would otherwise keep the last timestamp from a prior test.
    const fixedMs = 4_000_000_000_000;
    const ids = new Set<string>();
    for (let i = 0; i < 4200; i++) {
      const id = uuidv7(fixedMs);
      if (ids.has(id)) throw new Error(`duplicate id within the same millisecond: ${id}`);
      ids.add(id);
    }
    // overflow advanced the timestamp by at most a handful of ms
    const last = [...ids].at(-1)!;
    const ts = Number.parseInt(last.replace(/-/g, '').slice(0, 12), 16);
    expect(ts - fixedMs).toBeLessThanOrEqual(2);
  });

  test('NIL_UUID is the coalesce sentinel used by dedupe indexes', () => {
    expect(NIL_UUID).toBe('00000000-0000-0000-0000-000000000000');
    expect(isUuid(NIL_UUID)).toBe(true);
  });
});
