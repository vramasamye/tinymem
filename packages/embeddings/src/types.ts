/**
 * `@onememory-ai/embeddings` — `Embedder` implementations (ADR-0006 §3, dependency-verification §5–6).
 *
 * Providers, in the ADR's preference order:
 * 1. `ollamaEmbedder` — native `POST /api/embed` (NOT the deprecated `/api/embeddings`), loopback
 *    by default. Out-of-process inference sidesteps the Bun × ONNX risk entirely.
 * 2. `openaiCompatibleEmbedder` — `POST {baseURL}/embeddings` for LM Studio / llama.cpp / vLLM,
 *    and hosted endpoints only when the deployment opts in.
 * 3. `localTransformersEmbedder` — `@huggingface/transformers` v4 with a pinned small model,
 *    behind a Bun × OS × backend smoke gate (an optional peer dependency).
 *
 * Vector provenance (ADR-0006 §5): every implementation reports model id, dimension, and — where
 * the provider exposes one — a pinned model revision, so a model/prefix/normalization change is
 * detectable and routed through the `re_embed` job instead of silently mixing vectors.
 */

import type { Embedder } from '@onememory-ai/core';

export type EmbedderProviderId = 'ollama' | 'openai-compatible' | 'local-transformers';

/** Vector provenance recorded alongside every stored vector (ADR-0006 §5). */
export interface EmbedderMeta {
  provider: EmbedderProviderId;
  /** e.g. `nomic-embed-text`, `text-embedding-nomic-embed-text-v1.5`, `Xenova/bge-small-en-v1.5`. */
  model: string;
  /** Pinned model revision/commit when the provider exposes one; `null` when it does not. */
  revision: string | null;
  /** Fixed per deployment; `null` until configured or discovered by the first embedding. */
  dim: number | null;
}

export type EmbedderErrorKind =
  | 'transport'
  | 'protocol'
  | 'dimension'
  | 'not-ready'
  | 'missing-dependency';

export class EmbedderError extends Error {
  constructor(
    message: string,
    public readonly provider: EmbedderProviderId,
    public readonly kind: EmbedderErrorKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmbedderError';
  }
}

/**
 * What the factories return: the core `Embedder` port plus provenance and dimension discovery.
 *
 * `dim` is fixed per deployment (ADR-0002), but a local provider's dimension is a property of the
 * model, so it may be supplied in config or discovered from the first response. Accessing `dim`
 * before it is known throws `EmbedderError('not-ready')` rather than returning a lie; `probe()`
 * forces discovery (the doctor check / `onemem init` path).
 */
export interface EmbedderHandle extends Embedder {
  readonly provider: EmbedderProviderId;
  readonly meta: EmbedderMeta;
  /** Force dimension discovery by embedding one probe string. Idempotent. */
  probe(): Promise<EmbedderMeta>;
}

export interface EmbedderCommonOptions {
  model: string;
  /** Known dimension (from config); when omitted it is discovered on the first embedding. */
  dim?: number;
  revision?: string;
  /** Injectable fetch for tests; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Texts per request (default 32). */
  batchSize?: number;
  /** Per-request timeout (default 60000 ms). */
  timeoutMs?: number;
}

/** Split `texts` into request-sized batches. */
export function batchTexts(texts: readonly string[], batchSize: number): string[][] {
  const size = Math.max(1, Math.floor(batchSize));
  const batches: string[][] = [];
  for (let index = 0; index < texts.length; index += size) {
    batches.push(texts.slice(index, index + size));
  }
  return batches;
}

/** Normalize a base URL: trim whitespace, drop trailing slashes. */
export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, '');
}

/** Assert one vector's dimension against the configured/expected dimension. */
export function assertVectorDim(
  vector: readonly number[],
  expected: number,
  provider: EmbedderProviderId,
  model: string,
): void {
  if (vector.length !== expected) {
    throw new EmbedderError(
      `embedding model '${model}' returned ${vector.length} dimensions but ${expected} were expected: a model or revision change requires re-embedding (ADR-0006)`,
      provider,
      'dimension',
    );
  }
}
