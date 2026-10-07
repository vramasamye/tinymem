/**
 * `re_embed` job handler tests: the M13 wiring seam. Uses an in-test fake `EmbeddingIndex` and a
 * fake `Embedder` — no database, no model, no network.
 */

import { describe, expect, test } from 'bun:test';
import { uuidv7, type Embedder, type EmbeddingIndex, type VectorMatch } from '@onememory-ai/core';

import { createReEmbedJobHandler, ReEmbedError, RE_EMBED_JOB_KIND } from './re-embed-job';
import type { EmbedderMeta } from './types';

interface FakeIndex extends EmbeddingIndex {
  upserts: Array<{ memory_id: string; vector: number[] }>;
}

function fakeIndex(model = 'test-model', dim = 4): FakeIndex {
  const upserts: Array<{ memory_id: string; vector: number[] }> = [];
  return {
    backend: 'float8',
    dim,
    model,
    upserts,
    async upsert(memoryId: string, vector: number[]): Promise<void> {
      upserts.push({ memory_id: memoryId, vector });
    },
    async remove(): Promise<void> {},
    async search(): Promise<VectorMatch[]> {
      return [];
    },
  };
}

function fakeEmbedder(model = 'test-model', dim = 4): Embedder {
  return {
    model,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((_, index) => Array.from({ length: dim }, (_, j) => index + j / 10));
    },
  };
}

function meta(overrides: Partial<EmbedderMeta> = {}): EmbedderMeta {
  return { provider: 'ollama', model: 'test-model', revision: 'rev-1', dim: 4, ...overrides };
}

function job(payload: Record<string, unknown>, kind: string = RE_EMBED_JOB_KIND) {
  return { id: uuidv7(), kind, payload };
}

describe('createReEmbedJobHandler', () => {
  test('embeds and upserts every item, reporting provenance', async () => {
    const index = fakeIndex();
    const embedder = fakeEmbedder();
    const handler = createReEmbedJobHandler(index, embedder, meta());
    const ids = [uuidv7(), uuidv7()];
    const result = await handler(
      job({ items: [{ memory_id: ids[0]!, text: 'a' }, { memory_id: ids[1]!, text: 'b' }] }),
    );
    expect(result).toEqual({ upserted: 2, model: 'test-model', dim: 4, revision: 'rev-1' });
    expect(index.upserts.map((entry) => entry.memory_id)).toEqual(ids);
    expect(index.upserts[0]!.vector).toHaveLength(4);
  });

  test('accepts a matching model/revision in the payload', async () => {
    const index = fakeIndex();
    const handler = createReEmbedJobHandler(index, fakeEmbedder(), meta());
    await handler(
      job({
        model: 'test-model',
        revision: 'rev-1',
        reason: 'model_change',
        items: [{ memory_id: uuidv7(), text: 'a' }],
      }),
    );
    expect(index.upserts).toHaveLength(1);
  });

  test('refuses a stale job targeting another model or revision', async () => {
    const handler = createReEmbedJobHandler(fakeIndex(), fakeEmbedder(), meta());
    await expect(
      handler(job({ model: 'other-model', items: [{ memory_id: uuidv7(), text: 'a' }] })),
    ).rejects.toThrow(/targets model 'other-model'/);
    await expect(
      handler(job({ revision: 'rev-0', items: [{ memory_id: uuidv7(), text: 'a' }] })),
    ).rejects.toThrow(/targets revision 'rev-0'/);
  });

  test('rejects an invalid payload', async () => {
    const handler = createReEmbedJobHandler(fakeIndex(), fakeEmbedder(), meta());
    try {
      await handler(job({ items: [] }));
      throw new Error('expected the handler to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(ReEmbedError);
      expect((error as ReEmbedError).kind).toBe('invalid-payload');
    }
    await expect(handler(job({ items: [{ memory_id: 'not-a-uuid', text: 'a' }] }))).rejects.toThrow(
      /invalid payload/,
    );
  });

  test('rejects a job of the wrong kind', async () => {
    const handler = createReEmbedJobHandler(fakeIndex(), fakeEmbedder(), meta());
    await expect(
      handler(job({ items: [{ memory_id: uuidv7(), text: 'a' }] }, 'extract')),
    ).rejects.toThrow(/received a 'extract' job/);
  });

  test('refuses to construct when the index and embedder models differ', () => {
    expect(() => createReEmbedJobHandler(fakeIndex('model-a'), fakeEmbedder('model-b'), meta({ model: 'model-b' }))).toThrow(
      /vector index is bound to model 'model-a'/,
    );
  });

  test('refuses to construct when the metadata model drifts from the embedder', () => {
    expect(() =>
      createReEmbedJobHandler(fakeIndex(), fakeEmbedder(), meta({ model: 'ghost' })),
    ).toThrow(/metadata model 'ghost' does not match/);
  });

  test('refuses to construct on a dimension mismatch', () => {
    expect(() => createReEmbedJobHandler(fakeIndex('m', 8), fakeEmbedder('m', 4), meta({ model: 'm', dim: 4 }))).toThrow(
      /dimension/,
    );
    expect(() =>
      createReEmbedJobHandler(fakeIndex('m', 4), fakeEmbedder('m', 4), meta({ model: 'm', dim: 8 })),
    ).toThrow(/metadata dimension 8/);
  });

  test('fails when the embedder produces the wrong dimension', async () => {
    const index = fakeIndex('m', 4);
    const badEmbedder: Embedder = { model: 'm', dim: 4, async embed(texts) { return texts.map(() => [1, 2, 3]); } };
    const handler = createReEmbedJobHandler(index, badEmbedder, meta({ model: 'm' }));
    await expect(handler(job({ items: [{ memory_id: uuidv7(), text: 'a' }] }))).rejects.toThrow(
      /returned 3 dimensions but 4 were expected/,
    );
    expect(index.upserts).toHaveLength(0);
  });

  test('batches large payloads without changing the result', async () => {
    const index = fakeIndex('m', 2);
    const embedder = fakeEmbedder('m', 2);
    const handler = createReEmbedJobHandler(index, embedder, meta({ model: 'm', dim: 2 }), {
      batchSize: 2,
    });
    const items = Array.from({ length: 5 }, () => ({ memory_id: uuidv7(), text: 'x' }));
    const result = await handler(job({ items }));
    expect(result.upserted).toBe(5);
    expect(index.upserts).toHaveLength(5);
  });
});
