/**
 * The internal `ModelProvider` seam (ADR-0006 §2): "Vercel AI SDK v6 behind our internal
 * ModelProvider interface". One attempt, one schema, one parsed value — retries and routing live
 * in the router, so a fake provider is trivially testable and no provider is imported unless a
 * route selects it.
 */

import type { z } from 'zod';

import type { ProviderKind } from './types';

export interface ModelProviderRequest<T> {
  schema: z.ZodType<T>;
  /** JSON-schema name/description hints passed to the provider (AI SDK `Output.object`). */
  schemaName?: string;
  schemaDescription?: string;
  system?: string;
  prompt: string;
  temperature?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
}

/** A single successful provider attempt. */
export interface ModelProviderAttempt<T> {
  value: T;
  /** Raw model text (kept for diagnostics; never persisted as memory). */
  raw: string;
}

/**
 * A provider performs exactly one structured-generation attempt and either returns a parsed value
 * or throws `ModelProviderError`.
 */
export interface ModelProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly model: string;
  generate<T>(request: ModelProviderRequest<T>): Promise<ModelProviderAttempt<T>>;
}

/** Lazily creates (and caches) providers per resolved route. */
export type ModelProviderFactory = (route: {
  providerId: string;
  kind: ProviderKind;
  model: string;
  baseUrl?: string;
  apiKey?: string;
  headers?: Record<string, string>;
}) => ModelProvider;
