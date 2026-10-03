/**
 * The router (ADR-0006 §1/§4): config-driven per-operation provider+model resolution, fail-closed
 * degradation, and bounded retry on invalid structured output.
 *
 * Failure semantics, deliberately asymmetric:
 * - **Unresolvable route → `RouterUnavailableError` (thrown).** No provider configured, unknown
 *   provider id, or a `local`-profile violation. Callers degrade (heuristic extraction, lexical
 *   retrieval); they must not silently pick another provider.
 * - **Provider reached but no schema-valid output → typed failure (returned).** The caller decides
 *   whether to retry later, degrade, or surface the error.
 */

import type { z } from 'zod';

import { ModelProviderError, RouterUnavailableError, type StructuredOutputFailure } from './errors';
import { createAiSdkProviderFactory, DEFAULT_OLLAMA_BASE_URL, DEFAULT_OPENAI_COMPATIBLE_BASE_URL } from './providers/ai-sdk';
import type { ModelProvider, ModelProviderFactory } from './provider';
import type {
  ModelOperation,
  ProviderConfig,
  ProviderKind,
  ResolvedRoute,
  RouterConfig,
  RouterProfile,
} from './types';
import { isHostedProviderKind, isLoopbackBaseUrl } from './types';

/** Hard cap on retries; the retry loop must stay bounded even if config is wrong. */
export const MAX_STRUCTURED_RETRIES = 5;

const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RAW_DIAGNOSTIC_CHARS = 2_000;

/** Conventional env vars per hosted kind, consulted only after `api_key`/`api_key_env`. */
const HOSTED_API_KEY_ENV: Partial<Record<ProviderKind, string>> = {
  openai: 'OPENAI_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GOOGLE_GENERATIVE_AI_API_KEY',
};

export interface GenerateStructuredRequest<T> {
  operation: ModelOperation;
  schema: z.ZodType<T>;
  prompt: string;
  system?: string;
  schemaName?: string;
  schemaDescription?: string;
  temperature?: number;
  maxOutputTokens?: number;
  /** Overrides the router default (bounded to MAX_STRUCTURED_RETRIES). */
  maxRetries?: number;
  abortSignal?: AbortSignal;
}

export type StructuredGenerationResult<T> =
  | {
      ok: true;
      value: T;
      attempts: number;
      raw: string;
      route: { operation: ModelOperation; provider_id: string; model: string; hosted: boolean };
    }
  | { ok: false; error: StructuredOutputFailure };

export interface ModelRouter {
  readonly profile: RouterProfile;
  /** True when the operation resolves under the current profile (no throw). */
  isConfigured(operation: ModelOperation): boolean;
  configuredOperations(): ModelOperation[];
  /** Resolve the routing table; throws `RouterUnavailableError` when unavailable. */
  resolve(operation: ModelOperation): ResolvedRoute;
  generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<StructuredGenerationResult<T>>;
}

export interface ModelRouterOptions {
  /** Injectable provider layer (tests inject fakes; production uses the AI SDK factory). */
  providerFactory?: ModelProviderFactory;
  /** Environment used for `api_key_env` lookups (defaults to `process.env`). */
  env?: Record<string, string | undefined>;
}

function clampRetries(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RETRIES;
  return Math.max(0, Math.min(MAX_STRUCTURED_RETRIES, Math.trunc(value)));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function truncate(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return value.length > MAX_RAW_DIAGNOSTIC_CHARS ? `${value.slice(0, MAX_RAW_DIAGNOSTIC_CHARS)}…` : value;
}

function defaultBaseUrl(kind: ProviderKind): string | undefined {
  if (kind === 'ollama') return DEFAULT_OLLAMA_BASE_URL;
  if (kind === 'openai-compatible') return DEFAULT_OPENAI_COMPATIBLE_BASE_URL;
  return undefined;
}

/**
 * The bounded retry loop. One provider call per attempt; on failure the corrective instruction is
 * appended to the prompt so a model that emitted prose or truncated JSON gets a concrete repair
 * hint. Aborts stop immediately (no retry after cancellation).
 */
export async function generateStructuredWithRetry<T>(
  provider: ModelProvider,
  request: GenerateStructuredRequest<T>,
  maxRetries: number,
  defaults?: { timeoutMs?: number },
): Promise<StructuredGenerationResult<T>> {
  const attemptsAllowed = clampRetries(maxRetries) + 1;
  let prompt = request.prompt;
  let lastKind: StructuredOutputFailure['kind'] = 'invalid-output';
  let lastMessage = 'no attempt was made';
  let lastRaw: string | undefined;

  for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
    if (request.abortSignal?.aborted) {
      return {
        ok: false,
        error: {
          kind: 'provider-error',
          message: `structured generation for operation '${request.operation}' was aborted`,
          attempts: attempt - 1,
          provider_id: provider.id,
          operation: request.operation,
          last_raw: truncate(lastRaw),
        },
      };
    }
    try {
      const result = await provider.generate({
        schema: request.schema,
        schemaName: request.schemaName,
        schemaDescription: request.schemaDescription,
        system: request.system,
        prompt,
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        timeoutMs: defaults?.timeoutMs,
        abortSignal: request.abortSignal,
      });
      return {
        ok: true,
        value: result.value,
        attempts: attempt,
        raw: result.raw,
        route: {
          operation: request.operation,
          provider_id: provider.id,
          model: provider.model,
          hosted: isHostedProviderKind(provider.kind),
        },
      };
    } catch (error) {
      if (error instanceof RouterUnavailableError) throw error;
      if (error instanceof ModelProviderError) {
        lastKind = error.kind;
        lastMessage = error.message;
        lastRaw = error.raw;
      } else {
        lastKind = 'provider-error';
        lastMessage = messageOf(error);
      }
      prompt = `${request.prompt}\n\n---\nYour previous response could not be used: ${lastMessage}\nRespond with ONLY valid JSON that matches the required schema. Do not add prose, markdown fences, or commentary.`;
    }
  }

  return {
    ok: false,
    error: {
      kind: lastKind,
      message: `structured generation for operation '${request.operation}' failed after ${attemptsAllowed} attempt(s): ${lastMessage}`,
      attempts: attemptsAllowed,
      provider_id: provider.id,
      operation: request.operation,
      last_raw: truncate(lastRaw),
    },
  };
}

export function createModelRouter(
  config: RouterConfig,
  options: ModelRouterOptions = {},
): ModelRouter {
  const profile: RouterProfile = config.profile ?? 'local';
  const defaults = {
    temperature: config.defaults?.temperature,
    maxRetries: clampRetries(config.defaults?.max_retries ?? DEFAULT_MAX_RETRIES),
    maxOutputTokens: config.defaults?.max_output_tokens,
    timeoutMs: config.defaults?.timeout_ms ?? DEFAULT_TIMEOUT_MS,
  };
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const providerFactory = options.providerFactory ?? createAiSdkProviderFactory();

  const providersById = new Map<string, ProviderConfig>();
  for (const provider of config.providers) {
    if (providersById.has(provider.id)) {
      throw new RouterUnavailableError(`duplicate provider id '${provider.id}' in router config`);
    }
    providersById.set(provider.id, provider);
  }

  const providerCache = new Map<string, ModelProvider>();

  function apiKeyFor(provider: ProviderConfig): string | undefined {
    if (provider.api_key) return provider.api_key;
    if (provider.api_key_env) {
      const value = env[provider.api_key_env];
      if (value) return value;
    }
    const conventional = HOSTED_API_KEY_ENV[provider.kind];
    if (conventional) {
      const value = env[conventional];
      if (value) return value;
    }
    return undefined;
  }

  function resolve(operation: ModelOperation): ResolvedRoute {
    const route = config.routes?.[operation];
    if (!route) {
      throw new RouterUnavailableError(
        `no provider route configured for operation '${operation}'`,
        operation,
      );
    }
    const provider = providersById.get(route.provider);
    if (!provider) {
      throw new RouterUnavailableError(
        `route for operation '${operation}' references unknown provider '${route.provider}'`,
        operation,
        route.provider,
      );
    }
    const hosted = isHostedProviderKind(provider.kind);
    const baseUrl = provider.base_url ?? defaultBaseUrl(provider.kind);

    if (profile === 'local') {
      if (hosted) {
        throw new RouterUnavailableError(
          `profile 'local' refuses hosted provider '${provider.id}' (${provider.kind}) for operation '${operation}': local mode makes no external AI calls; opt in with profile 'hybrid' or 'server'`,
          operation,
          provider.id,
        );
      }
      if (baseUrl !== undefined && !isLoopbackBaseUrl(baseUrl)) {
        throw new RouterUnavailableError(
          `profile 'local' refuses non-loopback base URL '${baseUrl}' for provider '${provider.id}' (operation '${operation}')`,
          operation,
          provider.id,
        );
      }
    }

    if (hosted && !apiKeyFor(provider)) {
      throw new RouterUnavailableError(
        `hosted provider '${provider.id}' has no API key: set api_key_env (preferred) or api_key`,
        operation,
        provider.id,
      );
    }

    return { operation, provider, model: route.model, hosted };
  }

  function providerFor(route: ResolvedRoute): ModelProvider {
    const cached = providerCache.get(route.provider.id);
    if (cached) return cached;
    const provider = providerFactory({
      providerId: route.provider.id,
      kind: route.provider.kind,
      model: route.model,
      baseUrl: route.provider.base_url ?? defaultBaseUrl(route.provider.kind),
      apiKey: apiKeyFor(route.provider),
      headers: route.provider.headers,
    });
    providerCache.set(route.provider.id, provider);
    return provider;
  }

  return {
    profile,

    isConfigured(operation: ModelOperation): boolean {
      try {
        resolve(operation);
        return true;
      } catch {
        return false;
      }
    },

    configuredOperations(): ModelOperation[] {
      const operations: ModelOperation[] = [];
      for (const operation of Object.keys(config.routes ?? {}) as ModelOperation[]) {
        if (this.isConfigured(operation)) operations.push(operation);
      }
      return operations;
    },

    resolve,

    async generateStructured<T>(
      request: GenerateStructuredRequest<T>,
    ): Promise<StructuredGenerationResult<T>> {
      const route = resolve(request.operation);
      const provider = providerFor(route);
      return generateStructuredWithRetry(
        provider,
        {
          ...request,
          temperature: request.temperature ?? defaults.temperature,
          maxOutputTokens: request.maxOutputTokens ?? defaults.maxOutputTokens,
        },
        clampRetries(request.maxRetries ?? defaults.maxRetries),
        { timeoutMs: defaults.timeoutMs },
      );
    },
  };
}
