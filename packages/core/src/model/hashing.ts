/**
 * Canonicalization & hashing (event-memory-schemas.md §7).
 *
 * - **Canonical JSON**: UTF-8, sorted keys, no insignificant whitespace, numbers as-is, no NaN.
 * - **Event `content_hash`**: sha256 of the canonical payload JSON.
 * - **Memory `content_hash`**: sha256 of the normalized content (NFC, trimmed, whitespace
 *   collapsed, lowercased) — the exact-dedupe key.
 * - **Dedupe scope**: `(project_id, user_id, type, content_hash)` with NULL scope coalesced to the
 *   nil uuid — the in-DB unique index is the same expression (database-schema.md §2).
 */

import { createHash } from 'node:crypto';

import { NIL_UUID } from './uuidv7';
import type { DurableMemoryType } from './types';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function serializeCanonical(value: unknown): string {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'string') return JSON.stringify(value);
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite numbers are not representable');
    return JSON.stringify(value);
  }
  if (t === 'undefined') return 'null';
  if (t === 'bigint' || t === 'function' || t === 'symbol') {
    throw new TypeError(`canonicalJson: ${t} values are not representable`);
  }
  if (Array.isArray(value)) return `[${value.map((v) => serializeCanonical(v)).join(',')}]`;
  const v = value as { toJSON?: () => unknown };
  if (typeof v.toJSON === 'function') return serializeCanonical(v.toJSON());
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, val]) => val !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, val]) => `${JSON.stringify(k)}:${serializeCanonical(val)}`).join(',')}}`;
}

/** Canonical JSON per §7: sorted keys, no insignificant whitespace, UTF-8 safe. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value);
}

/** Normalize memory content: NFC → trim → collapse whitespace → lowercase. Deterministic. */
export function normalizeContent(content: string): string {
  return content.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** Memory `content_hash`: sha256 of normalized content — the exact-dedupe key. */
export function memoryContentHash(content: string): string {
  return sha256Hex(normalizeContent(content));
}

/** Event `content_hash`: sha256 of the canonical payload JSON. */
export function eventContentHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/** Normalized entity name: same normalization as memory content. */
export function normalizeEntityName(name: string): string {
  return normalizeContent(name);
}

export interface DedupeScope {
  project_id?: string | null;
  user_id?: string | null;
}

/**
 * The dedupe key, scope-coalesced + type + hash — mirrors the DB expression:
 * `(coalesce(project_id, nil), coalesce(user_id, nil), type, content_hash)`.
 * Two memories collide in the same scope iff their keys are equal.
 */
export function dedupeKey(
  scope: DedupeScope,
  type: DurableMemoryType,
  contentHash: string,
): string {
  const project = scope.project_id ?? NIL_UUID;
  const user = scope.user_id ?? NIL_UUID;
  return `${project}:${user}:${type}:${contentHash}`;
}
