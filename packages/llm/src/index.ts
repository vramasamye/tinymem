/**
 * `@onememory/llm` — the model router (ADR-0006).
 *
 * One internal `ModelProvider` seam, an AI SDK v6 implementation behind it, and a config-driven
 * per-operation routing table (embedding / classify / extract / consolidate / conflict /
 * summarize). Unresolved operations fail closed with `RouterUnavailableError`; there is **no**
 * silent cloud fallback and **no** network traffic unless a provider is explicitly configured.
 *
 * ADR-0006 rules encoded here:
 * - providers are loaded modularly (dynamic import — only the selected provider is ever imported);
 * - structured output goes through `generateText({ output: Output.object({ schema }) })` with Zod
 *   validation and a bounded explicit retry on invalid JSON;
 * - profile `local` (the default) rejects hosted provider kinds and non-loopback base URLs.
 */

export {
  MODEL_OPERATIONS,
  PROVIDER_KINDS,
  ROUTER_PROFILES,
  isHostedProviderKind,
  isLoopbackBaseUrl,
  type ModelOperation,
  type ModelProviderKind,
  type ProviderKind,
  type RouterProfile,
  type ProviderConfig,
  type RouteConfig,
  type RouterDefaults,
  type RouterConfig,
  type ResolvedRoute,
} from './types';
export {
  ProviderConfigSchema,
  RouteConfigSchema,
  RouterDefaultsSchema,
  RouterConfigSchema,
  parseRouterConfig,
} from './config';
export {
  RouterUnavailableError,
  ModelProviderError,
  StructuredOutputError,
  type ModelProviderErrorKind,
  type StructuredOutputFailure,
} from './errors';
export {
  type ModelProvider,
  type ModelProviderAttempt,
  type ModelProviderRequest,
  type ModelProviderFactory,
} from './provider';
export {
  createModelRouter,
  generateStructuredWithRetry,
  type ModelRouter,
  type GenerateStructuredRequest,
  type StructuredGenerationResult,
  type ModelRouterOptions,
} from './router';
export { createAiSdkProviderFactory, DEFAULT_OLLAMA_BASE_URL } from './providers/ai-sdk';
