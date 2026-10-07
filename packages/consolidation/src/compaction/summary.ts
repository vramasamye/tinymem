/**
 * The digest summary builder (M14.6). One bounded line per raw event — reusing extraction's
 * per-kind text shapes (`eventTextForMatching` over `storedEventToEnvelope`) so a digest reads
 * exactly like the event line the pipeline already knows, never a new vocabulary.
 *
 * Reuse before build: the per-kind formats, the envelope rebuild, and the whitespace collapse
 * all come from `@onememory-ai/extraction`; only the bound lives here (extraction's `excerpt` is
 * module-private and this pass wants a documented, wider cap for terminal/tool output).
 */

import type { NewEventDigest, StoredEvent } from '@onememory-ai/core';
import { eventTextForMatching, storedEventToEnvelope } from '@onememory-ai/extraction';

/** The digest summary bound — the payload's one-line stand-in must itself stay one line. */
export const DIGEST_SUMMARY_MAX_CHARS = 400;

/** Collapse whitespace and cap with an ellipsis (mirrors extraction's private `excerpt`). */
function bound(text: string, max: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

/** The UTF-8 byte size of the raw payload — recorded on the digest as the audit of what was purged. */
export function payloadByteSize(payload: Record<string, unknown>): number {
  return new TextEncoder().encode(JSON.stringify(payload ?? {})).length;
}

/**
 * The one-line summary of a raw event. Total, never throwing: a row ingested by an older
 * schema version can fail envelope re-validation, and a maintenance pass must not lose the
 * event's lineage over it — the fallback is the bounded JSON of the payload itself.
 */
export function digestSummaryLine(event: StoredEvent): string {
  let line: string;
  try {
    line = eventTextForMatching(storedEventToEnvelope(event));
  } catch {
    line = JSON.stringify(event.payload);
  }
  const summary = bound(line, DIGEST_SUMMARY_MAX_CHARS);
  return summary.length > 0 ? summary : `${event.kind} (empty payload)`;
}

/**
 * Build the digest row for one raw event: every identity/scope column preserved verbatim
 * (`kind`, `content_hash`, timestamps — the chain), the bounded summary, the purged payload's
 * byte size, the redaction count, and the distinct source ids whose evidence spans anchor it.
 */
export function buildEventDigest(
  event: StoredEvent,
  sourceIds: readonly string[],
): NewEventDigest {
  return {
    event_id: event.id,
    kind: event.kind,
    runtime: event.runtime,
    adapter_version: event.adapter_version,
    ...(event.project_id === undefined ? {} : { project_id: event.project_id }),
    ...(event.session_id === undefined ? {} : { session_id: event.session_id }),
    ...(event.agent_id === undefined ? {} : { agent_id: event.agent_id }),
    ...(event.user_id === undefined ? {} : { user_id: event.user_id }),
    content_hash: event.content_hash,
    occurred_at: event.occurred_at,
    ingested_at: event.ingested_at,
    summary: digestSummaryLine(event),
    payload_bytes: payloadByteSize(event.payload),
    redactions_count: event.redactions.length,
    source_ids: [...sourceIds],
  };
}
