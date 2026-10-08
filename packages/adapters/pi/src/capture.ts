/**
 * The capture pipeline: translate → path-exclude → redact → deliver (the security package's
 * documented adapter contract — `@onememory-ai/security` index: "adapters … call `isEventPathExcluded`
 * … and `redactEvent` before ingest"), and the daemon redacts again on arrival — defense in depth,
 * two boundaries. Redaction failure is a DROP (counted), never a crash and never an unredacted
 * send: if the redactor cannot make an event safe, the event does not leave this process.
 *
 * Session-start context injection (ADR-0010 §6: injection beats polling): the extension fetches the
 * daemon's compact project context once per session and delivers it as a system-prompt section at
 * `before_agent_start` (pi's mutable `systemPromptOptions`; mission 23 — the steer-user-message
 * channel throws there on real pi), prefixed with the `PI_CONTEXT_INJECTION_PREFIX` sentinel — the
 * translator drops any sentinel-prefixed user message on the way back in, so the injection is engine
 * OUTPUT and never becomes memory INPUT.
 */

import { isEventPathExcluded, redactEvent } from '@onememory-ai/security';
import type { OnememoryEvent } from '@onememory-ai/core';

import {
  deliverEvents,
  fetchSessionContext,
  type DeliverOptions,
  type DeliveryResult,
} from './delivery';
import {
  DropCounter,
  type DroppedRecord,
  type EventContext,
} from './event-builder';
import { PI_CONTEXT_INJECTION_PREFIX, translatePiEvent, type PiTranslateContext } from './translate';

export interface CaptureOutcome {
  delivery: DeliveryResult;
  /** Redacted, validated events that left the process (post-exclusion, post-redaction). */
  delivered: OnememoryEvent[];
  /** Every counted drop: translation + exclusion + redaction ledgers. */
  dropped: DroppedRecord[];
  /** Events rejected locally by path exclusion (`.env`, key files, …) — never sent. */
  excluded: number;
  /** Events the daemon stored (0 unless delivery succeeded). */
  stored: number;
  /** Duplicates the daemon reported (content-hash dedup is the daemon's call, not ours). */
  duplicates: number;
}

export interface CaptureOptions extends DeliverOptions, PiTranslateContext {}

/** Translate one Pi extension event and deliver it. Never throws. */
export async function capturePiEvent(event: unknown, options: CaptureOptions = {}): Promise<CaptureOutcome> {
  const translated = translatePiEvent(event, options);
  return deliverTranslation(translated.events, translated.dropped, options);
}

/** Shared tail: exclude → redact → deliver. */
async function deliverTranslation(
  events: OnememoryEvent[],
  translationDrops: DroppedRecord[],
  options: DeliverOptions,
): Promise<CaptureOutcome> {
  const dropped = new DropCounter();
  for (const record of translationDrops) {
    for (let i = 0; i < record.count; i += 1) dropped.drop(record.reason);
  }

  const safe: OnememoryEvent[] = [];
  let excluded = 0;
  for (const event of events) {
    if (isEventPathExcluded(event)) {
      // An excluded path (.env, key files, …) is never ingested, never hashed, never sent.
      excluded += 1;
      dropped.drop(`excluded-path:${event.kind}`);
      continue;
    }
    try {
      const redacted = redactEvent(event);
      safe.push(redacted.event);
    } catch {
      dropped.drop('redaction-failed');
    }
  }

  const delivery = await deliverEvents(safe, options);
  return {
    delivery,
    delivered: safe,
    dropped: dropped.records,
    excluded,
    stored: delivery.ok ? delivery.response.stored : 0,
    duplicates: delivery.ok ? delivery.response.duplicates : 0,
  };
}

/**
 * Fetch the session-start context and wrap it in the injection envelope. Returns `null` when the
 * daemon is unreachable or the context is empty — a missing memory layer must never block or
 * degrade the session (fail-soft), and an empty context must not cost a message.
 */
export async function buildSessionInjection(
  options: CaptureOptions,
  query: { budget?: number; sessionId?: string } = {},
): Promise<{ text: string; delivered: boolean } | { text: null; delivered: false; reason: string }> {
  const context = await fetchSessionContext(options, query);
  if (!context.ok) return { text: null, delivered: false, reason: context.message };
  const text = context.context.text.trim();
  if (text.length === 0) return { text: null, delivered: false, reason: 'empty project context' };
  return { text: `${PI_CONTEXT_INJECTION_PREFIX}\n\n${text}`, delivered: true };
}

/** Render the one-line stderr diagnostic for a failed delivery (value-free: no event content). */
export function deliveryDiagnostic(result: { ok: false; code: string; message: string }): string {
  return `[onememory] capture skipped (${result.code}): ${result.message}`;
}

/** Human-readable summary of a successful delivery (stderr, advisory only). */
export function deliverySummary(result: {
  response: { stored: number; duplicates: number; excluded: number; dead_lettered: number };
}): string {
  const { stored, duplicates, excluded, dead_lettered } = result.response;
  return `[onememory] captured ${stored} event(s)${duplicates > 0 ? `, ${duplicates} duplicate(s)` : ''}${
    excluded > 0 ? `, ${excluded} excluded` : ''
  }${dead_lettered > 0 ? `, ${dead_lettered} dead-lettered` : ''}`;
}

export type { EventContext };
