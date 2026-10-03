/**
 * `@onememory/embeddings` — `Embedder` implementations (ADR-0006 §3).
 *
 * Provider preference order: Ollama native `/api/embed` → OpenAI-compatible `/v1/embeddings`
 * (LM Studio / llama.cpp / vLLM, hosted only when opted in) → optional local transformers.js
 * with a pinned model. Every implementation reports model + dim + revision for vector provenance.
 */

export {
  EmbedderError,
  batchTexts,
  normalizeBaseUrl,
  assertVectorDim,
  type EmbedderCommonOptions,
  type EmbedderErrorKind,
  type EmbedderHandle,
  type EmbedderMeta,
  type EmbedderProviderId,
} from './types';

export {
  createOllamaEmbedder,
  DEFAULT_OLLAMA_BASE_URL,
  type OllamaEmbedderOptions,
} from './ollama';

export {
  createOpenAiCompatibleEmbedder,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
  type OpenAiCompatibleEmbedderOptions,
} from './openai-compatible';

export {
  createLocalTransformersEmbedder,
  isLocalEmbeddingsTestEnabled,
  DEFAULT_LOCAL_EMBEDDING_DIM,
  DEFAULT_LOCAL_EMBEDDING_MODEL,
  DEFAULT_LOCAL_EMBEDDING_REVISION,
  LOCAL_EMBEDDINGS_TEST_ENV,
  LOCAL_EMBEDDINGS_TEST_ENV_ALIAS,
  type LocalEmbeddingDtype,
  type LocalTransformersEmbedderOptions,
} from './local-transformers';

export {
  createReEmbedJobHandler,
  ReEmbedError,
  ReEmbedJobPayloadSchema,
  RE_EMBED_JOB_KIND,
  type ReEmbedErrorKind,
  type ReEmbedJobHandlerOptions,
  type ReEmbedJobLike,
  type ReEmbedJobPayload,
  type ReEmbedJobResult,
} from './re-embed-job';
