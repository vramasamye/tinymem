/**
 * Canonical event construction shared by the OpenCode translator (mirrors
 * `@onememory/adapter-pi/src/event-builder.ts`, which mirrors the codex adapter — the established
 * adapter pattern).
 *
 * Every event produced here passes `validateOnememoryEvent` before it leaves the adapter (the
 * task contract: never coerce, never emit an envelope the engine would dead-letter). The mint
 * converts a validation failure into a counted drop, never a crash (fail-soft invariant).
 */

import {
  eventContentHash,
  uuidv7,
  validateOnememoryEvent,
  type EventPayload,
  type EventRuntime,
  type OnememoryEvent,
} from '@onememory/core';

import { OPENCODE_ADAPTER_VERSION } from './version';

export const OPENCODE_RUNTIME: EventRuntime = 'opencode';
export const OPENCODE_AGENT_ID = 'opencode';

export interface EventContext {
  /** Resolved project id (`scope.project_id`); omitted when unknown. */
  projectId?: string;
  /** OpenCode session id (`scope.session_id`); omitted when unknown. */
  sessionId?: string;
  /** `scope.agent_id`; defaults to `opencode`. */
  agentId?: string;
  /** Injectable clock (tests); default `new Date()`. */
  now?: Date;
  /**
   * When the runtime reported when the thing happened, it becomes `occurred_at`; `ingested_at`
   * stays the clock's now — the two must never collapse into one.
   */
  occurredAt?: string;
}

/** A counted drop reason — the adapter's audit trail for everything it chose not to translate. */
export interface DroppedRecord {
  reason: string;
  count: number;
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
  const nowDate = context.now ?? new Date();
  const now = nowDate.toISOString();
  const candidate = {
    id: uuidv7(nowDate.getTime()),
    kind,
    occurred_at: context.occurredAt ?? now,
    ingested_at: now,
    source: { runtime: OPENCODE_RUNTIME, adapter_version: OPENCODE_ADAPTER_VERSION },
    scope: {
      ...(context.projectId === undefined ? {} : { project_id: context.projectId }),
      ...(context.sessionId === undefined ? {} : { session_id: context.sessionId }),
      agent_id: context.agentId ?? OPENCODE_AGENT_ID,
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
 * Bound a text digest: keep the head and a short tail so both the leading error line and the final
 * outcome survive truncation. The event schemas cap digests (2000 chars) — this guarantees we fit
 * under them, marker included (the truncation notice is budgeted, not appended).
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
