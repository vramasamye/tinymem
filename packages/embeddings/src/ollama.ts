/**
 * Ollama embedder — the ADR-0006 default when Ollama is present.
 *
 * Uses the **native** `POST /api/embed` endpoint (`input` accepts a string array and the response
 * carries `embeddings: number[][]`). `/api/embeddings` is deprecated and deliberately not
 * implemented (ADR-0006 §2, dependency-verification §6).
 *
 * Loopback by default; pointing `baseUrl` elsewhere is a deployment decision, and the router's
 * `local` profile is what refuses non-loopback endpoints for LLM traffic. For embeddings the
 * embedding provider is configured directly, so the default here is the guarantee.
 */

import { z } from 'zod';

import { postJson } from './http';
import {
  EmbedderError,
  assertVectorDim,
  batchTexts,
  normalizeBaseUrl,
  type EmbedderHandle,
  type EmbedderMeta,
  type EmbedderCommonOptions,
} from './types';

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';

/** `/api/embed` response (fields beyond `embeddings` are tolerated and ignored). */
const OllamaEmbedResponseSchema = z.looseObject({
  model: z.string().optional(),
  embeddings: z.array(z.array(z.number())),
});

export interface OllamaEmbedderOptions extends EmbedderCommonOptions {
  /** Ollama server root, without `/api`. Default `http://127.0.0.1:11434`. */
  baseUrl?: string;
}

export function createOllamaEmbedder(options: OllamaEmbedderOptions): EmbedderHandle {
  const provider = 'ollama' as const;
  const model = options.model;
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_OLLAMA_BASE_URL);
  const url = `${baseUrl}/api/embed`;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const batchSize = options.batchSize ?? 32;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const revision = options.revision ?? null;
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
      body: { model, input: texts },
      timeoutMs,
      fetchImpl,
    });
    const parsed = OllamaEmbedResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new EmbedderError(
        `ollama returned an unexpected /api/embed response for model '${model}': ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
        provider,
        'protocol',
        { cause: parsed.error },
      );
    }
    const embeddings = parsed.data.embeddings;
    if (embeddings.length !== texts.length) {
      throw new EmbedderError(
        `ollama returned ${embeddings.length} embeddings for ${texts.length} inputs (model '${model}')`,
        provider,
        'protocol',
      );
    }
    for (const vector of embeddings) acceptDim(vector);
    return embeddings;
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
          `dimension of ollama model '${model}' is not known yet: configure 'dim' or call probe() first`,
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
