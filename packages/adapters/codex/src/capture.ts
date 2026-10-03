/**
 * The capture pipeline: translate → path-exclude → redact → deliver.
 *
 * Redaction and path exclusion are the security package's documented adapter contract
 * (`@onememory/security` index doc: "adapters … call `isEventPathExcluded` … and `redactEvent`
 * before ingest"), and the daemon redacts again on arrival — defense in depth, two boundaries.
 * Redaction failure is a DROP (counted), never a crash and never an unredacted send: if the
 * redactor cannot make an event safe, the event does not leave this process.
 */

import { isEventPathExcluded, redactEvent } from '@onememory/security';
import type { OnememoryEvent } from '@onememory/core';

import { deliverEvents, fetchSessionContext, type DeliverOptions, type DeliveryResult } from './delivery';
import { clampDigest, DropCounter, type DroppedRecord, type EventContext, type TranslationResult } from './event-builder';
import { translateCodexHook } from './translate-hooks';
import { translateRolloutSession } from './translate-rollout';
import { SessionStartHookInputSchema, type SessionStartHookOutput } from './codex-wire';

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

export interface CaptureOptions extends DeliverOptions, EventContext {}

/** Translate a hook payload and deliver it. Never throws. */
export async function captureHook(input: unknown, options: CaptureOptions = {}): Promise<CaptureOutcome> {
  const translated = translateCodexHook(input, options);
  return deliverTranslation(translated, options);
}

/** Translate a rollout JSONL document and deliver it. Never throws. */
export async function captureRollout(text: string, options: CaptureOptions = {}): Promise<CaptureOutcome> {
  const translated = translateRolloutSession(text, options);
  const merged: TranslationResult = {
    events: translated.events,
    dropped: translated.dropped,
  };
  return deliverTranslation(merged, options);
}

/** Shared tail of both capture paths: exclude → redact → deliver. */
async function deliverTranslation(
  translated: TranslationResult,
  options: CaptureOptions,
): Promise<CaptureOutcome> {
  const dropped = new DropCounter();
  for (const record of translated.dropped) {
    for (let i = 0; i < record.count; i += 1) dropped.drop(record.reason);
  }

  const safe: OnememoryEvent[] = [];
  let excluded = 0;
  for (const event of translated.events) {
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
 * Build the SessionStart hook output (context injection, ADR-0010 §6: injection beats polling).
 * No daemon → `{output: null}` and the bin prints NOTHING on stdout (exit-0-with-no-output is
 * success for Codex) — a missing memory layer must never block or degrade the session.
 */
export async function buildSessionStartOutput(
  input: unknown,
  options: CaptureOptions = {},
  query: { budget?: number } = {},
): Promise<{
  output: SessionStartHookOutput | null;
  capture: CaptureOutcome;
  contextText: string | null;
}> {
  const hook = SessionStartHookInputSchema.safeParse(input);
  if (!hook.success) {
    // A payload failing the wire schema is captured through the normal path (which counts the
    // drop); there is simply no session context to attach to an unknown session.
    const capture = await captureHook(input, options);
    return { output: null, capture, contextText: null };
  }

  const sessionId = hook.data.session_id;
  const capture = await captureHook(input, { ...options, sessionId });

  const context = await fetchSessionContext(options, {
    ...(query.budget === undefined ? {} : { budget: query.budget }),
    sessionId,
  });
  if (!context.ok) {
    return { output: null, capture, contextText: null };
  }
  const text = context.context.text.trim();
  if (text.length === 0) {
    return { output: null, capture, contextText: '' };
  }
  return {
    output: {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: clampDigest(text, 6000),
      },
    },
    capture,
    contextText: text,
  };
}

/** Render the one-line stderr diagnostic for a failed delivery (value-free: no event content). */
export function deliveryDiagnostic(result: { ok: false; code: string; message: string }): string {
  return `[onememory] capture skipped (${result.code}): ${result.message}`;
}

/** Human-readable summary of a successful delivery (stderr, advisory only). */
export function deliverySummary(result: { response: { stored: number; duplicates: number; excluded: number; dead_lettered: number } }): string {
  const { stored, duplicates, excluded, dead_lettered } = result.response;
  return `[onememory] captured ${stored} event(s)${duplicates > 0 ? `, ${duplicates} duplicate(s)` : ''}${
    excluded > 0 ? `, ${excluded} excluded` : ''
  }${dead_lettered > 0 ? `, ${dead_lettered} dead-lettered` : ''}`;
}
