/**
 * ⚠️ TEST-ONLY helpers — never shipped as production behavior. Exported via the package's
 * `./testing` subpath so M3+ test suites can reuse them; nothing in `src/index.ts` re-exports
 * this file.
 *
 * - `createTestEmbedder`: a deterministic keyword-axis embedder double (the `Embedder` port with
 *   a fixed lexicon → axes mapping). Real embedding providers are M3's scope (AGENTS.md rule 3:
 *   no placeholder implementations in production paths — this is clearly a test double).
 * - `createQueryAwareTestEmbedder`: the same double plus an `embedQuery` (separate call counter)
 *   to assert an engine prefers the port's optional query side (ADR-0006 post-M3 amendment).
 * - `mulberry32` + `randomWorld`: deterministic seeded randomness for property tests.
 */

import type { Embedder } from '@onememory-ai/core';

/**
 * Deterministic hash-axis embedder: each known word lights up one axis (synonym groups share an
 * axis, so related texts get non-trivial cosine similarity), vectors are L2-normalized, unknown
 * words contribute nothing. `calls` counts embed() invocations for cache assertions.
 *
 * Default dim is 384 to match the committed `memory_vectors.embedding vector(384)` column — the
 * pgvector backend compares against the column type, so a mismatched dim would fail loudly.
 */
export interface TestEmbedder extends Embedder {
  readonly lexicon: ReadonlyMap<string, number>;
  calls: number;
}

/** The 24-axis lexicon: synonym groups share an axis. */
export const TEST_LEXICON: ReadonlyArray<readonly [string, number]> = [
  ['postgres', 0], ['postgresql', 0], ['pg', 0], ['database', 0], ['db', 0],
  ['node', 1], ['nodejs', 1],
  ['deploy', 2], ['deploys', 2], ['deployment', 2], ['gcloud', 2],
  ['cloud', 3], ['run', 3], ['cloudrun', 3],
  ['oom', 4], ['memory', 4], ['exhausted', 4], ['limits', 4],
  ['docker', 5], ['container', 5], ['containers', 5],
  ['redis', 6], ['cache', 6],
  ['sqlite', 7],
  ['invoice', 8], ['invoices', 8],
  ['api', 9], ['rest', 9],
  ['tabs', 10], ['spaces', 10], ['formatting', 10],
  ['version', 11], ['versions', 11],
  ['22', 12],
  ['20', 13],
  ['connection', 14], ['refused', 14],
  ['migration', 15], ['migrations', 15],
  ['typescript', 16],
  ['test', 17], ['tests', 17],
  ['error', 18], ['errors', 18],
  ['fix', 19], ['fixed', 19],
  ['service', 20], ['services', 20],
  ['primary', 21], ['main', 21],
  ['git', 22], ['commits', 22],
];

function buildLexicon(dim: number, extraLexicon: ReadonlyArray<readonly [string, number]>): Map<string, number> {
  const lexicon = new Map<string, number>(TEST_LEXICON);
  for (const [word, axis] of extraLexicon) {
    if (axis < dim) lexicon.set(word, axis);
  }
  return lexicon;
}

function axisEmbed(text: string, dim: number, lexicon: ReadonlyMap<string, number>): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const token of text.toLowerCase().split(/[^a-z0-9]+/)) {
    const axis = lexicon.get(token);
    if (axis !== undefined) vector[axis] = vector[axis]! + 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) vector[i] = vector[i]! / norm;
  }
  return vector;
}

export function createTestEmbedder(dim = 384, extraLexicon: ReadonlyArray<readonly [string, number]> = []): TestEmbedder {
  const lexicon = buildLexicon(dim, extraLexicon);
  const embedder: TestEmbedder = {
    model: 'test/hash-axes',
    dim,
    lexicon,
    calls: 0,
    embed: async (texts: string[]): Promise<number[][]> => {
      embedder.calls += 1;
      return texts.map((text) => axisEmbed(text, dim, lexicon));
    },
  };
  return embedder;
}

export interface QueryAwareTestEmbedder extends TestEmbedder {
  /** embedQuery() invocations — assert the query path went through the port's query side. */
  queryCalls: number;
}

/**
 * createTestEmbedder + an `embedQuery` routed through the same axis logic (identical vectors,
 * separate call counter). Use it to assert an engine prefers the port's query side; the default
 * `createTestEmbedder` stays query-free so existing suites keep covering the fallback path.
 */
export function createQueryAwareTestEmbedder(
  dim = 384,
  extraLexicon: ReadonlyArray<readonly [string, number]> = [],
): QueryAwareTestEmbedder {
  const lexicon = buildLexicon(dim, extraLexicon);
  const embedder: QueryAwareTestEmbedder = {
    model: 'test/hash-axes',
    dim,
    lexicon,
    calls: 0,
    queryCalls: 0,
    embed: async (texts: string[]): Promise<number[][]> => {
      embedder.calls += 1;
      return texts.map((text) => axisEmbed(text, dim, lexicon));
    },
    embedQuery: async (texts: string[]): Promise<number[][]> => {
      embedder.queryCalls += 1;
      return texts.map((text) => axisEmbed(text, dim, lexicon));
    },
  };
  return embedder;
}

/** Deterministic PRNG (mulberry32) — fixed seeds make property tests reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
