/**
 * Local transformers.js embedder tests.
 *
 * The default path is a dynamic import of an **optional** peer dependency, so CI never downloads
 * model weights: the real-model test is env-gated (`ONEMEMORY_TESTS_LOCAL_EMBEDDINGS=1`) and
 * skipped otherwise. Everything else runs against an injected module double, which exercises the
 * pooling/normalization contract, batching, and provenance without ONNX.
 */

import { describe, expect, test } from 'bun:test';

import {
  createLocalTransformersEmbedder,
  DEFAULT_LOCAL_EMBEDDING_DIM,
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  DEFAULT_LOCAL_EMBEDDING_REVISION,
  isLocalEmbeddingsTestEnabled,
} from './local-transformers';
import { EmbedderError } from './types';

/** Optional peer dependency: present only when a developer installed it deliberately. */
const TRANSFORMERS_INSTALLED = await (async () => {
  const specifier = '@huggingface/transformers';
  try {
    await import(specifier);
    return true;
  } catch {
    return false;
  }
})();

interface ExtractorCall {
  texts: string[];
  options?: { pooling?: string; normalize?: boolean };
}

function doubleModule(dim: number, calls: ExtractorCall[], pipelineOptions: Record<string, unknown>[]) {
  return {
    env: {} as { cacheDir?: string; allowRemoteModels?: boolean },
    async pipeline(_task: string, _model: string, options?: Record<string, unknown>) {
      pipelineOptions.push(options ?? {});
      return async (texts: string[], options?: ExtractorCall['options']) => {
        calls.push({ texts, options });
        return {
          tolist: () => texts.map((_, index) => Array.from({ length: dim }, (_, j) => index + j / 10)),
        };
      };
    },
  };
}

describe('localTransformersEmbedder', () => {
  test('pins the model, revision, and dimension', () => {
    const embedder = createLocalTransformersEmbedder();
    expect(embedder.provider).toBe('local-transformers');
    expect(embedder.meta).toEqual({
      provider: 'local-transformers',
      model: DEFAULT_LOCAL_EMBEDDING_MODEL,
      revision: DEFAULT_LOCAL_EMBEDDING_REVISION,
      dim: DEFAULT_LOCAL_EMBEDDING_DIM,
    });
    expect(embedder.dim).toBe(384);
  });

  test('uses mean pooling with L2 normalization and forwards the pinned revision', async () => {
    const calls: ExtractorCall[] = [];
    const pipelineOptions: Record<string, unknown>[] = [];
    const embedder = createLocalTransformersEmbedder({
      model: 'test/model',
      revision: 'rev-1',
      dim: 3,
      dtype: 'q8',
      device: 'wasm',
      cacheDir: '/tmp/onemem-cache',
      allowRemoteModels: false,
      loadModule: async () => doubleModule(3, calls, pipelineOptions),
    });
    const vectors = await embedder.embed(['a', 'b']);
    expect(vectors).toEqual([
      [0, 0.1, 0.2],
      [1, 1.1, 1.2],
    ]);
    expect(calls[0]!.options).toEqual({ pooling: 'mean', normalize: true });
    expect(pipelineOptions[0]).toEqual({ revision: 'rev-1', dtype: 'q8', device: 'wasm' });
    expect(embedder.meta.revision).toBe('rev-1');
  });

  test('batches through the extractor and keeps order', async () => {
    const calls: ExtractorCall[] = [];
    const embedder = createLocalTransformersEmbedder({
      dim: 2,
      batchSize: 2,
      loadModule: async () => doubleModule(2, calls, []),
    });
    const vectors = await embedder.embed(['t1', 't2', 't3']);
    expect(calls.map((call) => call.texts)).toEqual([['t1', 't2'], ['t3']]);
    expect(vectors).toHaveLength(3);
  });

  test('rejects a vector whose dimension differs from the pinned model dimension', async () => {
    const embedder = createLocalTransformersEmbedder({
      dim: 4,
      loadModule: async () => doubleModule(3, [], []),
    });
    try {
      await embedder.embed(['x']);
      throw new Error('expected the embedder to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbedderError);
      expect((error as EmbedderError).kind).toBe('dimension');
    }
  });

  test('wraps an extractor failure as a transport error', async () => {
    const embedder = createLocalTransformersEmbedder({
      dim: 2,
      loadModule: async () => ({
        env: {},
        async pipeline() {
          return async () => {
            throw new Error('onnxruntime blew up');
          };
        },
      }),
    });
    await expect(embedder.embed(['x'])).rejects.toThrow(/failed to embed: onnxruntime blew up/);
  });

  test('embedQuery applies the BGE query instruction; embed stays prefix-free', async () => {
    const calls: ExtractorCall[] = [];
    const embedder = createLocalTransformersEmbedder({
      dim: 2,
      loadModule: async () => doubleModule(2, calls, []),
    });
    const { embedQuery } = embedder;
    if (embedQuery === undefined) throw new Error('local transformers embedder must implement embedQuery');
    await embedder.embed(['passage']);
    await embedQuery(['query']);
    expect(calls[0]!.texts).toEqual(['passage']);
    expect(calls[1]!.texts).toEqual(['Represent this sentence for searching relevant passages: query']);
    expect(await embedQuery([])).toEqual([]);
  });
});

describe('local embeddings env gate', () => {
  test('is off unless explicitly enabled', () => {
    expect(isLocalEmbeddingsTestEnabled({})).toBe(false);
    expect(isLocalEmbeddingsTestEnabled({ ONEMEMORY_TESTS_LOCAL_EMBEDDINGS: '0' })).toBe(false);
    expect(isLocalEmbeddingsTestEnabled({ ONEMEMORY_TESTS_LOCAL_EMBEDDINGS: '1' })).toBe(true);
    // Alias spelling from the M3 brief.
    expect(isLocalEmbeddingsTestEnabled({ ONEMEMEM_TESTS_LOCAL_EMBEDDINGS: '1' })).toBe(true);
  });

  test.skipIf(TRANSFORMERS_INSTALLED)(
    'reports the optional dependency clearly when it is not installed',
    async () => {
      const embedder = createLocalTransformersEmbedder({ dim: 384 });
      try {
        await embedder.embed(['x']);
        throw new Error('expected the embedder to fail');
      } catch (error) {
        expect(error).toBeInstanceOf(EmbedderError);
        expect((error as EmbedderError).kind).toBe('missing-dependency');
        expect((error as EmbedderError).message).toContain('@huggingface/transformers');
      }
    },
  );

  test.skipIf(!isLocalEmbeddingsTestEnabled())(
    'embeds with the real pinned model (downloads weights on first run)',
    async () => {
      const embedder = createLocalTransformersEmbedder({});
      const [vector] = await embedder.embed(['onememory stores decisions and failures']);
      expect(vector).toBeDefined();
      expect(vector!.length).toBe(DEFAULT_LOCAL_EMBEDDING_DIM);
      // L2-normalized: unit length within float tolerance.
      const norm = Math.sqrt(vector!.reduce((sum, value) => sum + value * value, 0));
      expect(Math.abs(norm - 1)).toBeLessThan(1e-3);
    },
    120_000,
  );
});
