/**
 * Router errors. The split is deliberate (ADR-0006 §4, fail closed):
 *
 * - `RouterUnavailableError` — no route configured, provider missing, or a `local`-profile
 *   violation. Callers degrade (heuristic extraction, lexical retrieval); they must never treat
 *   this as "retry against a different provider".
 * - `StructuredOutputError` — a provider was reached but never produced schema-valid output within
 *   the retry budget. The raw text of the last attempt rides along for diagnostics.
 */

export type ModelProviderErrorKind = 'invalid-output' | 'provider-error' | 'unsupported';

export class RouterUnavailableError extends Error {
  constructor(
    message: string,
    public readonly operation?: string,
    public readonly providerId?: string,
  ) {
    super(message);
    this.name = 'RouterUnavailableError';
  }
}

export class ModelProviderError extends Error {
  constructor(
    message: string,
    public readonly kind: ModelProviderErrorKind,
    public readonly providerId: string,
    public readonly raw?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelProviderError';
  }
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    public readonly operation: string,
    public readonly attempts: number,
    public readonly providerId: string,
    public readonly lastRaw?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'StructuredOutputError';
  }
}

/** Typed failure returned by `ModelRouter.generateStructured` (never thrown). */
export interface StructuredOutputFailure {
  kind: ModelProviderErrorKind;
  message: string;
  attempts: number;
  provider_id: string;
  operation: string;
  last_raw?: string;
}
