/**
 * Redactor port (INGEST, stage 2; ADR-0003 + event-memory-schemas.md §7 redaction invariant):
 * strip secrets from an event payload BEFORE storage. Redaction records carry kind + location +
 * length only — the secret value never reaches the database, logs, or an LLM prompt.
 * Implemented by `packages/security` (M12).
 */

import type { Redaction } from '../schema/event';

export interface RedactionResult {
  /** Deep copy of the input with secret values replaced. */
  value: unknown;
  /** kind + location + length only, never the secret itself. */
  redactions: Redaction[];
}

export interface Redactor {
  redact(value: unknown): Promise<RedactionResult>;
}

/**
 * Alias for the name used in repository-structure.md ("SecretRedactor"); the ADR text and
 * event-memory-schemas.md call the same port `Redactor`.
 */
export type SecretRedactor = Redactor;
