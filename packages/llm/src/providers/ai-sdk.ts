/**
 * AI SDK v6 implementation of the internal `ModelProvider` seam (ADR-0006 §2).
 *
 * - provider packages are imported dynamically per resolved route: a deployment that configures
 *   only Ollama never imports (or bundles) `@ai-sdk/openai`/`anthropic`/`google`;
 * - the `ai` core module itself is imported lazily on the first generation, so loading
 *   `@onememory-ai/llm` performs no I/O of any kind;
 * - structured output uses the current v6 API — `generateText({ output: Output.object({ schema }) })`
 *   (`generateObject` is deprecated) — then re-validates the result with Zod. A JSON-shaped
 *   response is not assumed to be a valid memory (ADR-0006 §2);
 * - one attempt per call: `maxRetries: 0` on the AI SDK side, because the router owns the bounded
 *   retry loop and must be able to report attempts honestly.
 */

import type { LanguageModel } from 'ai';

import { ModelProviderError } from '../errors';
import type { ModelProvider, ModelProviderAttempt, ModelProviderRequest } from '../provider';
import type { ProviderKind } from '../types';

/** Ollama's OpenAI-compatible surface (chat/completions). Embeddings use native `/api/embed`. */
export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434/v1';

/** LM Studio's default OpenAI-compatible port; llama.cpp/vLLM users set `base_url` explicitly. */
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://127.0.0.1:1234/v1';

export interface AiSdkProviderOptions {
  providerId: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function loadLanguageModel(options: AiSdkProviderOptions): Promise<LanguageModel> {
  switch (options.kind) {
    case 'openai': {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return createOpenAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        headers: options.headers,
      })(options.model);
    }
    case 'anthropic': {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return createAnthropic({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        headers: options.headers,
      })(options.model);
    }
    case 'google': {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return createGoogleGenerativeAI({
        apiKey: options.apiKey,
        baseURL: options.baseUrl,
        headers: options.headers,
      })(options.model);
    }
    case 'openai-compatible':
    case 'ollama': {
      const { createOpenAICompatible } = await import('@ai-sdk/openai-compatible');
      const baseURL =
        options.baseUrl ??
        (options.kind === 'ollama'
          ? DEFAULT_OLLAMA_BASE_URL
          : DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
      const provider = createOpenAICompatible({
        name: options.kind === 'ollama' ? 'ollama' : options.providerId,
        baseURL,
        // Local OpenAI-compatible servers usually ignore the key; the SDK needs a non-empty value.
        apiKey: options.apiKey ?? 'onememory-local',
        headers: options.headers,
      });
      return provider(options.model);
    }
  }
}

class AiSdkModelProvider implements ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly model: string;
  readonly #options: AiSdkProviderOptions;
  #languageModel: Promise<LanguageModel> | null = null;

  constructor(options: AiSdkProviderOptions) {
    this.#options = options;
    this.id = options.providerId;
    this.kind = options.kind;
    this.model = options.model;
  }

  #load(): Promise<LanguageModel> {
    this.#languageModel ??= loadLanguageModel(this.#options);
    return this.#languageModel;
  }

  async generate<T>(request: ModelProviderRequest<T>): Promise<ModelProviderAttempt<T>> {
    const model = await this.#load();
    const { generateText, Output } = await import('ai');

    let text: string | undefined;
    let rawOutput: unknown;
    try {
      const result = await generateText({
        model,
        system: request.system,
        prompt: request.prompt,
        output: Output.object({
          schema: request.schema,
          name: request.schemaName,
          description: request.schemaDescription,
        }),
        temperature: request.temperature,
        maxOutputTokens: request.maxOutputTokens,
        // The router owns retries; one HTTP attempt per provider call.
        maxRetries: 0,
        abortSignal: request.abortSignal,
      });
      text = result.text;
      rawOutput = result.output;
    } catch (error) {
      throw new ModelProviderError(
        `provider '${this.id}' (${this.kind}/${this.model}) call failed: ${errorMessage(error)}`,
        'provider-error',
        this.id,
        text,
        { cause: error },
      );
    }

    try {
      return { value: request.schema.parse(rawOutput), raw: text ?? '' };
    } catch (error) {
      throw new ModelProviderError(
        `provider '${this.id}' (${this.kind}/${this.model}) returned output that failed schema validation: ${errorMessage(error)}`,
        'invalid-output',
        this.id,
        text,
        { cause: error },
      );
    }
  }
}

/** Factory handed to `createModelRouter` (defaults to this AI SDK implementation). */
export function createAiSdkProviderFactory(): (
  route: AiSdkProviderOptions,
) => ModelProvider {
  return (route) => new AiSdkModelProvider(route);
}
