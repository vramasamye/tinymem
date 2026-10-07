/**
 * Canonical event construction shared by the hook translator and the rollout translator.
 *
 * Every event produced here passes `validateOnememoryEvent` before it leaves the adapter (the
 * task contract: never coerce, never emit an envelope the engine would dead-letter). `content_hash`
 * is computed over the pre-redaction payload; `redactEvent` recomputes it after redaction — the
 * two hashes never disagree because redaction is the only mutation and it owns the recompute.
 */

import {
  eventContentHash,
  uuidv7,
  validateOnememoryEvent,
  type EventPayload,
  type EventRuntime,
  type OnememoryEvent,
} from '@onememory-ai/core';

import { CODEX_ADAPTER_VERSION } from './version';

export const CODEX_RUNTIME: EventRuntime = 'codex';
export const CODEX_AGENT_ID = 'codex';

export interface EventContext {
  /** Resolved project id (`scope.project_id`); omitted when unknown. */
  projectId?: string;
  /** Codex session id (`scope.session_id`); omitted when unknown. */
  sessionId?: string;
  /** `scope.agent_id`; defaults to `codex`. */
  agentId?: string;
  /** Injectable clock (tests); default `new Date()`. */
  now?: Date;
}

/** A counted drop reason — the adapter's audit trail for everything it chose not to translate. */
export interface DroppedRecord {
  reason: string;
  count: number;
}

export interface TranslationResult {
  events: OnememoryEvent[];
  dropped: DroppedRecord[];
}

/**
 * Build one canonical event. Throws `EventValidationError` when the envelope does not pass core
 * validation — callers convert that into a counted drop, never a crash (fail-soft invariant).
 */
export class EventValidationError extends Error {
  readonly issues: Array<{ path: string; message: string }>;
  constructor(kind: string, issues: Array<{ path: string; message: string }>) {
    super(`event for kind '${kind}' failed canonical validation`);
    this.name = 'EventValidationError';
    this.issues = issues;
  }
}

export function buildEvent(
  kind: OnememoryEvent['kind'],
  payload: EventPayload,
  context: EventContext,
): OnememoryEvent {
  const now = (context.now ?? new Date()).toISOString();
  const candidate = {
    id: uuidv7(),
    kind,
    occurred_at: now,
    ingested_at: now,
    source: { runtime: CODEX_RUNTIME, adapter_version: CODEX_ADAPTER_VERSION },
    scope: {
      ...(context.projectId === undefined ? {} : { project_id: context.projectId }),
      ...(context.sessionId === undefined ? {} : { session_id: context.sessionId }),
      agent_id: context.agentId ?? CODEX_AGENT_ID,
    },
    payload,
    content_hash: eventContentHash(payload),
    redactions: [],
  } satisfies Omit<OnememoryEvent, 'schema_version'>;

  const result = validateOnememoryEvent(candidate);
  if (!result.ok) {
    throw new EventValidationError(kind, result.dead_letter.issues);
  }
  return result.value;
}

/** Accumulator for counted drops — every unmappable payload lands here, never in an event. */
export class DropCounter {
  private readonly reasons = new Map<string, number>();

  drop(reason: string): void {
    this.reasons.set(reason, (this.reasons.get(reason) ?? 0) + 1);
  }

  get records(): DroppedRecord[] {
    return [...this.reasons.entries()].map(([reason, count]) => ({ reason, count }));
  }
}

/**
 * Bound a text digest: keep the head and a short tail so both the leading error line and the
 * final outcome survive truncation. The event schemas cap digests (2000 chars) — this guarantees
 * we fit under them, marker included (the truncation notice is budgeted, not appended).
 */
export function clampDigest(text: string, max = 2000): string {
  if (text.length <= max) return text;
  const omitted = text.length - max;
  const marker = `\n…[onememory: truncated ~${omitted} chars]…\n`;
  const budget = Math.max(0, max - marker.length);
  const head = Math.floor(budget * 0.75);
  const tail = budget - head;
  return `${text.slice(0, head)}${marker}${text.slice(text.length - tail)}`;
}
