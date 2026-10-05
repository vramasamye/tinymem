/**
 * Synthetic code-document events: the bridge between a re-read source file and the existing
 * extraction pipeline (`@onememory/extraction` is composed, never edited — M4f).
 *
 * A re-index re-reads exactly the drifted paths and hands their current text to the SAME
 * `Extractor` the `extract` job uses, in the shape that pipeline already understands: a
 * `document.added` envelope whose `content_digest` carries the bounded file text. The event is
 * built in memory (never ingested), so no synthetic row pollutes the `events` table and the normal
 * pipeline never re-processes it; the durable provenance of anything extracted from it is the real
 * `sources` row the re-index creates for the file plus `file:<path>` evidence locators
 * ({@link fileEvidence}).
 *
 * The `content_digest` cap (8 000 chars, the payload schema's own max) means very large files are
 * truncated for extraction — an honest bound, reported by the caller, never a silent partial read.
 */

import {
  eventContentHash,
  MAX_DOCUMENT_CHARS,
  uuidv7,
  validateOnememoryEvent,
  type EvidenceSpan,
  type OnememoryEvent,
} from '@onememory/core';

export { MAX_DOCUMENT_CHARS };

export interface CodeDocumentEventInput {
  project_id: string;
  /** Repository-relative path (already validated by the caller's repository-relative rules). */
  path: string;
  /** Current file text; truncated to {@link MAX_DOCUMENT_CHARS}. */
  text: string;
  occurred_at: string;
}

/** Build the synthetic `document.added` event for one re-read file. */
export function buildCodeDocumentEvent(input: CodeDocumentEventInput): OnememoryEvent {
  const payload = {
    kind: 'document.added' as const,
    path: input.path,
    mime: 'text/plain',
    title: input.path,
    content_digest: input.text.slice(0, MAX_DOCUMENT_CHARS),
  };
  const result = validateOnememoryEvent({
    id: uuidv7(),
    kind: 'document.added',
    occurred_at: input.occurred_at,
    ingested_at: input.occurred_at,
    source: { runtime: 'file-watcher', adapter_version: 'codememory-1' },
    scope: { project_id: input.project_id },
    payload,
    content_hash: eventContentHash(payload),
    redactions: [],
  });
  if (!result.ok) {
    throw new Error(
      `codememory: synthetic document event failed validation: ${result.dead_letter.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; ')}`,
    );
  }
  return result.value;
}

/** Evidence for re-indexed knowledge: the FILE is the source of truth, not the synthetic event. */
export function fileEvidence(sourceId: string, path: string, excerpt: string): EvidenceSpan {
  const collapsed = excerpt.replace(/\s+/g, ' ').trim();
  return {
    source_id: sourceId,
    kind: 'line',
    locator: `file:${path}`,
    excerpt: collapsed.length > 200 ? `${collapsed.slice(0, 199)}…` : collapsed,
  };
}

/** The file path a synthetic event's evidence locator names (`file:<path>`), or null. */
export function pathFromLocator(locator: string): string | null {
  return locator.startsWith('file:') ? locator.slice('file:'.length) : null;
}
