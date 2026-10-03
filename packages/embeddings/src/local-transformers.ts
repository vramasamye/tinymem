/**
 * Local transformers.js embedder (ADR-0006 §3, second choice after Ollama).
 *
 * `@huggingface/transformers` v4 with a **pinned** small model — `Xenova/bge-small-en-v1.5`
 * (384-d, MIT weights) at a pinned revision, so stored vectors are reproducible across machines
 * (dependency-verification §5: pin the model revision, pooling, and normalization).
 *
 * Deliberate constraints:
 * - the package is an **optional peer dependency** and is imported dynamically, so the default
 *   install stays light and nothing ONNX-shaped is loaded unless this provider is selected;
 * - first run downloads model weights from Hugging Face (documented, not zero-network): prewarm
 *   with `createLocalTransformersEmbedder(...).probe()` at init/doctor time;
 * - in-process ONNX under Bun is gated on the ADR-0006 smoke matrix; if it fails, inference runs
 *   in a Node worker process or the deployment degrades to lexical+graph retrieval with a warning.
 *   This module implements the in-process path; the worker-process fallback is a follow-up;
 * - embeddings use the model's documented feature-extraction settings: mean pooling + L2
 *   normalization. Stored passages are **prefix-free** (`embed`); queries go through the port's
 *   `embedQuery`, which applies BGE's query instruction to the query vector only — the prefix
 *   never reaches storage or provenance, so no `re_embed` is triggered (ADR-0006 §5 + the
 *   post-M3 port amendment).
 */

import {
  EmbedderError,
  assertVectorDim,
  batchTexts,
  type EmbedderCommonOptions,
  type EmbedderHandle,
  type EmbedderMeta,
} from './types';

export const DEFAULT_LOCAL_EMBEDDING_MODEL = 'Xenova/bge-small-en-v1.5';
/** `main` at 2025-07-22 — pinned so vectors are reproducible (never track a moving branch). */
export const DEFAULT_LOCAL_EMBEDDING_REVISION = 'ea104dacec62c0de699686887e3f920caeb4f3e3';
export const DEFAULT_LOCAL_EMBEDDING_DIM = 384;
export const LOCAL_EMBEDDINGS_TEST_ENV = 'ONEMEMORY_TESTS_LOCAL_EMBEDDINGS';
/** Alias kept for the switch name used in the M3 task brief. */
export const LOCAL_EMBEDDINGS_TEST_ENV_ALIAS = 'ONEMEMEM_TESTS_LOCAL_EMBEDDINGS';

/** True when the env-gated local-embedding test may run (never true by default — CI stays offline). */
export function isLocalEmbeddingsTestEnabled(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return (
    env[LOCAL_EMBEDDINGS_TEST_ENV] === '1' || env[LOCAL_EMBEDDINGS_TEST_ENV_ALIAS] === '1'
  );
}

/** The subset of the transformers.js API this embedder uses (avoids a hard type dependency). */
interface FeatureExtractionOutput {
  tolist(): number[][];
}

type FeatureExtractor = (
  texts: string[],
  options?: { pooling?: 'none' | 'mean' | 'cls'; normalize?: boolean },
) => Promise<FeatureExtractionOutput>;

interface TransformersModuleLike {
  pipeline: (
    task: 'feature-extraction',
    model: string,
    options?: Record<string, unknown>,
  ) => Promise<FeatureExtractor>;
  env?: { cacheDir?: string; allowRemoteModels?: boolean; localModelPath?: string };
}

export type LocalEmbeddingDtype = 'fp32' | 'fp16' | 'q8' | 'int8' | 'q4';

export interface LocalTransformersEmbedderOptions extends Partial<EmbedderCommonOptions> {
  /** Defaults to the pinned `Xenova/bge-small-en-v1.5`. */
  model?: string;
  /** Defaults to the pinned revision constant. */
  revision?: string;
  /** Defaults to 384 (the pinned model's dimension). */
  dim?: number;
  dtype?: LocalEmbeddingDtype;
  device?: 'cpu' | 'gpu' | 'wasm';
  /** Where the downloaded weights are cached (transformers.js `env.cacheDir`). */
  cacheDir?: string;
  /** When false, the loader never touches the network — only cached weights are used. */
  allowRemoteModels?: boolean;
  /** Injection point for tests (bypasses the dynamic import). */
  loadModule?: () => Promise<TransformersModuleLike>;
}

async function defaultLoadModule(): Promise<TransformersModuleLike> {
  const specifier = '@huggingface/transformers';
  try {
    return (await import(specifier)) as unknown as TransformersModuleLike;
  } catch (error) {
    throw new EmbedderError(
      `local transformers embeddings require the optional peer dependency '@huggingface/transformers' (v4): install it with 'bun add @huggingface/transformers', or use the ollama/openai-compatible embedder instead`,
      'local-transformers',
      'missing-dependency',
      { cause: error },
    );
  }
}

export function createLocalTransformersEmbedder(
  options: LocalTransformersEmbedderOptions = {},
): EmbedderHandle {
  const provider = 'local-transformers' as const;
  const model = options.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
  const revision = options.revision ?? DEFAULT_LOCAL_EMBEDDING_REVISION;
  const dtype = options.dtype ?? 'fp32';
  const device = options.device ?? 'cpu';
  const batchSize = options.batchSize ?? 16;
  const loadModule = options.loadModule ?? defaultLoadModule;
  let dim: number | null = options.dim ?? DEFAULT_LOCAL_EMBEDDING_DIM;
  let extractorPromise: Promise<FeatureExtractor> | null = null;

  function meta(): EmbedderMeta {
    return { provider, model, revision, dim };
  }

  function loadExtractor(): Promise<FeatureExtractor> {
    extractorPromise ??= (async () => {
      const module = await loadModule();
      if (options.cacheDir !== undefined && module.env) module.env.cacheDir = options.cacheDir;
      if (options.allowRemoteModels !== undefined && module.env) {
        module.env.allowRemoteModels = options.allowRemoteModels;
      }
      return module.pipeline('feature-extraction', model, { revision, dtype, device });
    })();
    return extractorPromise;
  }

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const extractor = await loadExtractor();
    const vectors: number[][] = [];
    for (const batch of batchTexts(texts, batchSize)) {
      let output: FeatureExtractionOutput;
      try {
        output = await extractor(batch, { pooling: 'mean', normalize: true });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new EmbedderError(
          `local transformers model '${model}' failed to embed: ${message}`,
          provider,
          'transport',
          { cause: error },
        );
      }
      const rows = output.tolist();
      if (rows.length !== batch.length) {
        throw new EmbedderError(
          `local transformers model '${model}' returned ${rows.length} embeddings for ${batch.length} inputs`,
          provider,
          'protocol',
        );
      }
      for (const vector of rows) {
        if (dim === null) dim = vector.length;
        else assertVectorDim(vector, dim, provider, model);
      }
      vectors.push(...rows);
    }
    return vectors;
  }

  /** bge-small-en-v1.5 prescribes this instruction for QUERIES only (model card FAQ);
   *  passages stay prefix-free, so the prefix never reaches stored vectors or provenance. */
  const BGE_QUERY_PREFIX = 'Represent this sentence for searching relevant passages: ';

  async function embedQuery(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return embed(texts.map((text) => BGE_QUERY_PREFIX + text));
  }

  return {
    provider,
    get model(): string {
      return model;
    },
    get dim(): number {
      if (dim === null) {
        throw new EmbedderError(
          `dimension of local model '${model}' is not known yet: call probe() first`,
          provider,
          'not-ready',
        );
      }
      return dim;
    },
    get meta(): EmbedderMeta {
      return meta();
    },
    async probe(): Promise<EmbedderMeta> {
      await embed(['onememory embedding dimension probe']);
      return meta();
    },
    embed,
    embedQuery,
  };
}
