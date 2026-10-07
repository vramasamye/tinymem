/**
 * Build the configured `Embedder`, or `null` for the offline default.
 *
 * `null` is a first-class state, not a failure: without an embedder retrieval runs lexical + graph
 * (the engine reports the degradation in `warnings[]`), and the extractor does not enqueue
 * `re_embed` jobs (nothing exists to embed). That is the configuration `onemem doctor` must pass in.
 */

import type { EmbedderSelection } from '@onememory-ai/config';
import {
  createLocalTransformersEmbedder,
  createOllamaEmbedder,
  createOpenAiCompatibleEmbedder,
  type EmbedderHandle,
  type LocalTransformersEmbedderOptions,
} from '@onememory-ai/embeddings';

/** Injectable seams for tests (no network, no model download). */
export interface EmbedderFactoryOptions {
  fetch?: typeof fetch;
  loadTransformersModule?: LocalTransformersEmbedderOptions['loadModule'];
}

export function createEmbedder(
  selection: EmbedderSelection | null,
  options: EmbedderFactoryOptions = {},
): EmbedderHandle | null {
  if (selection === null) return null;
  const shared = {
    model: selection.model,
    ...(selection.dim === null ? {} : { dim: selection.dim }),
    ...(selection.batch_size === undefined ? {} : { batchSize: selection.batch_size }),
    ...(selection.timeout_ms === undefined ? {} : { timeoutMs: selection.timeout_ms }),
  };

  switch (selection.provider) {
    case 'ollama':
      return createOllamaEmbedder({
        ...shared,
        baseUrl: selection.base_url,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    case 'openai-compatible':
      return createOpenAiCompatibleEmbedder({
        ...shared,
        baseUrl: selection.base_url,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
    case 'local-transformers':
      return createLocalTransformersEmbedder({
        ...shared,
        ...(selection.revision === undefined ? {} : { revision: selection.revision }),
        ...(options.loadTransformersModule === undefined ? {} : { loadModule: options.loadTransformersModule }),
      });
  }
}
