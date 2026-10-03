import { describe, expect, test } from 'bun:test';

import {
  canonicalJson,
  dedupeKey,
  eventContentHash,
  memoryContentHash,
  normalizeContent,
  sha256Hex,
} from './hashing';
import { NIL_UUID } from './uuidv7';

describe('content normalization (event-memory-schemas.md §7)', () => {
  test('NFC, trim, whitespace collapse, lowercase — in that spirit, deterministic', () => {
    expect(normalizeContent('  The   QUICK\tbrown\nfox  ')).toBe('the quick brown fox');
    // deterministic
    expect(normalizeContent('Hello   World')).toBe(normalizeContent('hello world'));
  });

  test('NFC composition: decomposed and composed forms hash identically', () => {
    const decomposed = 'cafe\u0301'; // e + combining acute
    const composed = 'caf\u00e9'; // precomposed é
    expect(normalizeContent(decomposed)).toBe(normalizeContent(composed));
    expect(memoryContentHash(decomposed)).toBe(memoryContentHash(composed));
  });

  test('whitespace variants dedupe to the same hash', () => {
    const a = memoryContentHash('Use Node 20 for this project');
    const b = memoryContentHash('use   node 20\nFOR this\tproject ');
    expect(a).toBe(b);
  });

  test('different content hashes differ', () => {
    expect(memoryContentHash('node 20')).not.toBe(memoryContentHash('node 22'));
  });

  test('sha256Hex produces 64 lowercase hex chars', () => {
    expect(sha256Hex('abc')).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex('')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('canonical JSON (sorted keys, no insignificant whitespace, no NaN)', () => {
  test('keys are sorted recursively', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  test('arrays keep order (order is significant), numbers as-is', () => {
    expect(canonicalJson({ list: [3, 1, 2] })).toBe('{"list":[3,1,2]}');
    expect(canonicalJson({ n: 1.5, m: -0 })).toBe('{"m":0,"n":1.5}');
  });

  test('NaN / Infinity are rejected; undefined object keys are omitted (JSON.stringify parity)', () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow(TypeError);
    expect(() => canonicalJson({ x: Number.POSITIVE_INFINITY })).toThrow(TypeError);
    expect(canonicalJson({ x: undefined, y: 2 })).toBe('{"y":2}');
    expect(canonicalJson({ list: [undefined, 1] })).toBe('{"list":[null,1]}');
  });

  test('eventContentHash is stable across key order and matches sha256 of canonical form', () => {
    const p1 = { content: 'x', role: 'user' };
    const p2 = { role: 'user', content: 'x' };
    expect(eventContentHash(p1)).toBe(eventContentHash(p2));
    expect(eventContentHash(p1)).toBe(sha256Hex(canonicalJson(p1)));
  });
});

describe('dedupe key: scope-coalesced + type + hash', () => {
  const hash = memoryContentHash('this project uses node 22');

  test('same scope + type + hash collide', () => {
    expect(dedupeKey({ project_id: 'p1' }, 'semantic', hash)).toBe(
      dedupeKey({ project_id: 'p1' }, 'semantic', hash),
    );
  });

  test('different projects do not collide (cross-scope duplicates are allowed)', () => {
    expect(dedupeKey({ project_id: 'p1' }, 'semantic', hash)).not.toBe(
      dedupeKey({ project_id: 'p2' }, 'semantic', hash),
    );
  });

  test('NULL scope coalesces to the nil uuid (mirrors the SQL expression index)', () => {
    expect(dedupeKey({}, 'semantic', hash)).toBe(
      dedupeKey({ project_id: NIL_UUID }, 'semantic', hash),
    );
  });

  test('user-scope replaces project-scope (memory-model.md §7: user memories use user_id)', () => {
    expect(dedupeKey({ user_id: 'u1' }, 'preference', hash)).not.toBe(
      dedupeKey({ user_id: 'u2' }, 'preference', hash),
    );
    expect(dedupeKey({ user_id: 'u1' }, 'preference', hash)).not.toBe(
      dedupeKey({ project_id: 'p1' }, 'preference', hash),
    );
  });

  test('type participates in the key', () => {
    expect(dedupeKey({ project_id: 'p1' }, 'decision', hash)).not.toBe(
      dedupeKey({ project_id: 'p1' }, 'semantic', hash),
    );
  });
});
