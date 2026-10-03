/**
 * OpenAI-compatible embedder — `POST {baseURL}/embeddings` for LM Studio, llama.cpp server, vLLM,
 * and (only when a deployment opts in) hosted OpenAI-compatible endpoints
 * (ADR-0006 §2, dependency-verification §6).
 *
 * `baseUrl` must be the API root including the version segment, e.g.
 * `http://127.0.0.1:1234/v1` (LM Studio default) or `http://127.0.0.1:8080/v1` (llama.cpp).
 */

import { z } from 'zod';

import { postJson } from './http';
import {
  EmbedderError,
  assertVectorDim,
  batchTexts,
  normalizeBaseUrl,
  type EmbedderCommonOptions,
  type EmbedderHandle,
  type EmbedderMeta,
} from './types';

/** LM Studio's default OpenAI-compatible port. */
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1234/v1';

const EmbeddingDataSchema = z.looseObject({
  embedding: z.array(z.number()),
  index: z.number().int().optional(),
});

const EmbeddingsResponseSchema = z.looseObject({
  model: z.string().optional(),
  data: z.array(EmbeddingDataSchema),
});

export interface OpenAiCompatibleEmbedderOptions extends EmbedderCommonOptions {
  /** API root including the version segment. Default `http://127.0.0.1:1234/v1`. */
  baseUrl?: string;
  /** Sent as `Authorization: Bearer …` when present; local servers usually ignore it. */
  apiKey?: string;
  headers?: Record<string, string>;
}

export function createOpenAiCompatibleEmbedder(
  options: OpenAiCompatibleEmbedderOptions,
): EmbedderHandle {
  const provider = 'openai-compatible' as const;
  const model = options.model;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
  const url = `${baseUrl}/embeddings`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const batchSize = options.batchSize ?? 32;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const revision = options.revision ?? null;
  const headers: Record<string, string> = { ...options.headers };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  let dim: number | null = options.dim ?? null;

  function meta(): EmbedderMeta {
    return { provider, model, revision, dim };
  }

  function acceptDim(vector: readonly number[]): void {
    if (dim === null) {
      dim = vector.length;
      return;
    }
    assertVectorDim(vector, dim, provider, model);
  }

  async function embedBatch(texts: readonly string[]): Promise<number[][]> {
    const body = await postJson({
      provider,
      url,
      body: { model, input: texts, encoding_format: 'float' },
      headers,
      timeoutMs,
      fetchImpl,
    });
    const parsed = EmbeddingsResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new EmbedderError(
        `openai-compatible endpoint ${url} returned an unexpected response for model '${model}': ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
        provider,
        'protocol',
        { cause: parsed.error },
      );
    }
    const rows = [...parsed.data.data];
    if (rows.length !== texts.length) {
      throw new EmbedderError(
        `openai-compatible endpoint returned ${rows.length} embeddings for ${texts.length} inputs (model '${model}')`,
        provider,
        'protocol',
      );
    }
    // The API contract allows the rows to arrive in any order; `index` restores input order.
    rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = rows.map((row) => row.embedding);
    for (const vector of vectors) acceptDim(vector);
    return vectors;
  }

  async function embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    const vectors: number[][] = [];
    for (const batch of batchTexts(texts, batchSize)) {
      vectors.push(...(await embedBatch(batch)));
    }
    return vectors;
  }

  return {
    provider,
    get model(): string {
      return model;
    },
    get dim(): number {
      if (dim === null) {
        throw new EmbedderError(
          `dimension of openai-compatible model '${model}' is not known yet: configure 'dim' or call probe() first`,
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
      if (dim === null) await embedBatch(['onememory embedding dimension probe']);
      return meta();
    },
    embed,
  };
}
