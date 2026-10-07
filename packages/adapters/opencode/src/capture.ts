/**
 * The capture pipeline: translate → path-exclude → redact → deliver (the security package's
 * documented adapter contract — `@onememory-ai/security` index: "adapters … call `isEventPathExcluded`
 * … and `redactEvent` before ingest"), and the daemon redacts again on arrival — defense in depth,
 * two boundaries. Redaction failure is a DROP (counted), never a crash and never an unredacted
 * send: if the redactor cannot make an event safe, the event does not leave this process.
 *
 * Session-start context injection (ADR-0010 §6: injection beats polling): the plugin fetches the
 * daemon's compact project context once per session and pushes it into the system prompt through
 * OpenCode's `experimental.chat.system.transform` hook, prefixed with the
 * `OPENCODE_CONTEXT_INJECTION_PREFIX` sentinel. The block is engine OUTPUT pushed into the
 * SYSTEM prompt — it never becomes a message part, so it can never loop back as memory input; the
 * part channel still drops `synthetic` parts defensively.
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
} from './event-builder';
import {
  createOpenCodeTranslator,
  type OpenCodeTranslateContext,
  type OpenCodeTranslationResult,
  type TranslateCall,
} from './translate';

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

export interface CaptureOptions extends DeliverOptions, OpenCodeTranslateContext {
  /** The translator instance (one per plugin); a fresh one is created when omitted. */
  translator?: ReturnType<typeof createOpenCodeTranslator>;
}

/** Translate one `event`-hook signal and deliver it. Never throws. */
export async function captureOpenCodeEvent(
  rawEvent: unknown,
  options: CaptureOptions = {},
): Promise<CaptureOutcome> {
  const translated = translatorFor(options).translateEvent(rawEvent, callFor(options));
  return deliverTranslation(translated, options);
}

/** Translate one `tool.execute.after` signal and deliver it. Never throws. */
export async function captureOpenCodeToolAfter(
  rawInput: unknown,
  rawOutput: unknown,
  options: CaptureOptions = {},
): Promise<CaptureOutcome> {
  const translated = translatorFor(options).translateToolAfter(rawInput, rawOutput, callFor(options));
  return deliverTranslation(translated, options);
}

/** Translate one `chat.message` signal and deliver it. Never throws. */
export async function captureOpenCodeChatMessage(
  rawInput: unknown,
  rawOutput: unknown,
  options: CaptureOptions = {},
): Promise<CaptureOutcome> {
  const translated = translatorFor(options).translateChatMessage(rawInput, rawOutput, callFor(options));
  return deliverTranslation(translated, options);
}

/** Shared tail: exclude → redact → deliver. */
async function deliverTranslation(
  translated: OpenCodeTranslationResult,
  options: DeliverOptions,
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
 * Fetch the session-start context and wrap it in the injection envelope. Returns `null` when the
 * daemon is unreachable or the context is empty — a missing memory layer must never block or
 * degrade the session (fail-soft), and an empty context must not cost a system-prompt block.
 */
export async function buildSessionInjection(
  options: CaptureOptions,
  query: { budget?: number; sessionId?: string } = {},
): Promise<{ text: string; delivered: boolean } | { text: null; delivered: false; reason: string }> {
  const context = await fetchSessionContext(options, query);
  if (!context.ok) return { text: null, delivered: false, reason: context.message };
  const text = context.context.text.trim();
  if (text.length === 0) return { text: null, delivered: false, reason: 'empty project context' };
  return { text: `${OPENCODE_CONTEXT_INJECTION_PREFIX}\n\n${text}`, delivered: true };
}

/**
 * The sentinel prefixing the injected memory context (mirrors the Pi adapter's convention — the
 * engine's own marker, so a human reading the system prompt can tell engine output from
 * hand-written instructions).
 */
export const OPENCODE_CONTEXT_INJECTION_PREFIX = '[onememory:project-memory-context]';

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

function translatorFor(options: CaptureOptions): ReturnType<typeof createOpenCodeTranslator> {
  return options.translator ?? createOpenCodeTranslator(options);
}

function callFor(_options: CaptureOptions): TranslateCall {
  // The capture path uses the wall clock; the conformance suite calls the translator directly
  // with per-fact clocks, so this stays the production default only.
  return {};
}
