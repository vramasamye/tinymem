/**
 * Ingest integration helper (ADR-0007 §1: redact "before anything else touches the payload").
 *
 * `redactEvent(envelope)` validates the envelope through core's canonical ingest validator
 * (unknown kinds normalize to `raw.unknown`, malformed input dead-letters), redacts the WHOLE
 * envelope (payload + source + scope — adapters are never trusted to send clean transcripts),
 * recomputes `content_hash` over the REDACTED payload, and returns an event ready for the
 * events repository (redactions passthrough).
 *
 * Callers: adapters after translation, the ingest stage before `store.ingestEvent`. Path
 * exclusion must run FIRST (see `exclusions.ts`) — an excluded path means the caller drops
 * the whole event before redaction.
 */

import { OnememoryEventSchema, eventContentHash, validateOnememoryEvent } from '@onememory-ai/core';
import type { DeadLetterIssue, OnememoryEvent, Redaction } from '@onememory-ai/core';

import { detectorFor, walkValue } from './redactor';
import type { RedactorConfig } from './patterns';

/** Error issues carry path + message only — never the rejected input (taint-safe by shape). */
export class RedactEventError extends Error {
  readonly issues: readonly DeadLetterIssue[];
  constructor(message: string, issues: readonly DeadLetterIssue[] = []) {
    super(message);
    this.name = 'RedactEventError';
    this.issues = issues;
  }
}

export interface RedactedEvent {
  /** Canonical event with a redacted payload, recomputed content_hash, and redactions attached. */
  event: OnememoryEvent;
  /** The same array as `event.redactions` (kind + location + length only). */
  redactions: Redaction[];
}

/**
 * Redact an event envelope at the ingest boundary.
 *
 * - input: anything an adapter produced (Zod-validated first; malformed input throws
 *   `RedactEventError` with dead-letter issues so the caller dead-letters it).
 * - output: `{event, redactions}` where `event` re-passes `OnememoryEventSchema` (re-validated
 *   after redaction so a marker can never corrupt the canonical shape).
 *
 * Idempotent: pre-existing redaction records are preserved, and marker-valued spans are not
 * re-recorded, so running an already-redacted event through again changes nothing.
 */
export function redactEvent(envelope: unknown, config?: RedactorConfig): RedactedEvent {
  const validated = validateOnememoryEvent(envelope);
  if (!validated.ok) {
    throw new RedactEventError(
      'event failed envelope validation before redaction',
      validated.dead_letter.issues,
    );
  }

  const detector = detectorFor(config);
  const records: Redaction[] = [];
  const walked = walkValue(validated.value, '$', detector, records) as Record<string, unknown>;
  const payload = walked['payload'];

  const event = {
    ...walked,
    content_hash: eventContentHash(payload),
    redactions: [...(validated.value.redactions ?? []), ...records],
  };

  const recheck = OnememoryEventSchema.safeParse(event);
  if (!recheck.success) {
    throw new RedactEventError(
      'redacted event failed canonical re-validation (redaction markers must not break the envelope)',
      recheck.error.issues.map((issue) => ({
        path: issue.path.map(String).join('.') || '(root)',
        message: issue.message,
      })),
    );
  }

  // Re-attach the original records array (safeParse deep-copies) so `event.redactions` and the
  // returned `redactions` are the same object the repository stores passthrough.
  const finalEvent = { ...recheck.data, redactions: event.redactions } as OnememoryEvent;
  return { event: finalEvent, redactions: event.redactions };
}
