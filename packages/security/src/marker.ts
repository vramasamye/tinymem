/**
 * The stable redaction marker (ADR-0007 / event-memory-schemas.md §7).
 *
 * A redacted secret is replaced in the payload by `[REDACTED:<kind>]` and described in the
 * redaction record by kind + JSON-path location + length ONLY — the secret value never appears
 * in the marker, the record, a log line, or an error message.
 */

import type { RedactionKind } from '@onememory-ai/core';

export const REDACTION_MARKER_PREFIX = '[REDACTED:';
export const REDACTION_MARKER_SUFFIX = ']';

/** The replacement text for a removed secret, e.g. `[REDACTED:api-key]`. */
export function redactionMarker(kind: RedactionKind): string {
  return `${REDACTION_MARKER_PREFIX}${kind}${REDACTION_MARKER_SUFFIX}`;
}

const MARKER_PATTERN = /^\[REDACTED:(api-key|password|token|private-key|connection-string|other)\]$/;

/**
 * `true` when `text` is exactly a redaction marker. The scanner skips marker-valued spans so
 * re-running redaction over already-redacted content is a no-op (idempotency), and a second
 * pass never records the marker's own length as if it were a secret.
 */
export function isRedactionMarker(text: string): boolean {
  return MARKER_PATTERN.test(text);
}
