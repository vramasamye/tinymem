/**
 * Tolerant Claude Code transcript (JSONL) reader + delta selection for the Stop hook.
 *
 * The official sessions reference (https://code.claude.com/docs/en/sessions, "Where transcripts
 * are stored") hands hook authors the transcript path but EXPLICITLY WARNS: "The entry format is
 * internal to Claude Code and changes between versions, so scripts that parse these files
 * directly can break on any release." onememory therefore:
 *
 * - recognizes only the long-stable entry subset (`type: "user" | "assistant"` with an API-shaped
 *   `message.content` that is a plain string or content blocks), reading the FINAL assistant text
 *   from the documented `last_assistant_message` Stop field rather than the file;
 * - counts every unrecognized line, machine-generated wrapper, or tool-result carrier as a
 *   *counted drop* (never silently ignored, never coerced into an event);
 * - never persists transcript content to disk (AGENTS.md rule 6): the only state kept is the
 *   `uuid` of the last line already delivered, so re-delivery after state loss is idempotent
 *   through the daemon's content-hash duplicate detection.
 */

import { extractRememberUtterance } from './remember';

/** A real conversation utterance we can honestly turn into an event. */
export interface TranscriptTextEntry {
  kind: 'text';
  role: 'user' | 'assistant';
  text: string;
  /** Line `uuid` (present in every known entry shape; used as the delta cursor). */
  uuid?: string;
  /** Line `timestamp` (ISO) when present — becomes the event's `occurred_at`. */
  timestamp?: string;
}

/** A parsed line with no honest event mapping (tool results, summaries, machine wrappers, …). */
export interface TranscriptSkippedEntry {
  kind: 'skipped';
  reason: string;
  uuid?: string;
  timestamp?: string;
}

export type TranscriptEntry = TranscriptTextEntry | TranscriptSkippedEntry;

export interface ParsedTranscript {
  /** Parsed entries in file order (both deliverable text and policy-skipped lines). */
  entries: TranscriptEntry[];
  /** Counted parse failures (unparseable JSON, unknown shapes). */
  drops: Array<{ reason: string; count: number }>;
}

/**
 * Machine-generated wrappers that appear inside user-role entries: injected reminders, slash
 * command telemetry, local-command stdout. These are NOT user speech — emitting them as
 * conversation.message would fabricate utterances (and the reminder text is context noise).
 */
const MACHINE_GENERATED_PREFIXES: readonly string[] = [
  '<system-reminder>',
  '<local-command-stdout>',
  '<command-name>',
  '<command-message>',
  '<command-args>',
  'Caveat: The messages below',
  '[Request interrupted',
];

function isMachineGenerated(text: string): boolean {
  const trimmed = text.trimStart();
  return MACHINE_GENERATED_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Join the `text` fields of text blocks; returns null when the blocks carry no text at all. */
function textOfBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return null;
  const parts: string[] = [];
  for (const block of blocks) {
    if (typeof block !== 'object' || block === null) continue;
    const record = block as { type?: unknown; text?: unknown };
    if (record.type !== 'text') continue;
    const text = asString(record.text);
    if (text !== null) parts.push(text);
  }
  return parts.length === 0 ? null : parts.join('\n');
}

function hasToolResultBlock(blocks: unknown): boolean {
  return (
    Array.isArray(blocks) &&
    blocks.some(
      (block) => typeof block === 'object' && block !== null && (block as { type?: unknown }).type === 'tool_result',
    )
  );
}

/**
 * Parse the transcript JSONL text. Pure: no filesystem access. Every line resolves to an entry or
 * a counted drop; a malformed line never throws.
 */
export function parseTranscript(text: string): ParsedTranscript {
  const entries: TranscriptEntry[] = [];
  const tally = new Map<string, number>();
  const count = (reason: string): void => {
    tally.set(reason, (tally.get(reason) ?? 0) + 1);
  };

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      count('transcript_unparseable_line');
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) {
      count('transcript_non_object_line');
      continue;
    }
    const record = parsed as {
      type?: unknown;
      uuid?: unknown;
      timestamp?: unknown;
      message?: unknown;
    };
    const uuid = asString(record.uuid) ?? undefined;
    const timestamp = asString(record.timestamp) ?? undefined;
    const type = asString(record.type);

    if (type !== 'user' && type !== 'assistant') {
      entries.push({ kind: 'skipped', reason: `transcript_entry_type:${type ?? 'unknown'}`, uuid, timestamp });
      continue;
    }

    const message =
      typeof record.message === 'object' && record.message !== null
        ? (record.message as { content?: unknown })
        : {};
    const content = message.content;

    if (typeof content === 'string') {
      if (content.trim().length === 0) {
        entries.push({ kind: 'skipped', reason: 'transcript_empty_message', uuid, timestamp });
        continue;
      }
      if (type === 'user' && isMachineGenerated(content)) {
        entries.push({ kind: 'skipped', reason: 'transcript_machine_generated', uuid, timestamp });
        continue;
      }
      entries.push({ kind: 'text', role: type, text: content, uuid, timestamp });
      continue;
    }

    if (Array.isArray(content)) {
      // A user-role entry carrying tool_result blocks is a tool result, not an utterance.
      if (type === 'user' && hasToolResultBlock(content)) {
        entries.push({ kind: 'skipped', reason: 'transcript_tool_result_entry', uuid, timestamp });
        continue;
      }
      const text = textOfBlocks(content);
      if (text === null || text.trim().length === 0) {
        entries.push({ kind: 'skipped', reason: 'transcript_no_text_blocks', uuid, timestamp });
        continue;
      }
      if (type === 'user' && isMachineGenerated(text)) {
        entries.push({ kind: 'skipped', reason: 'transcript_machine_generated', uuid, timestamp });
        continue;
      }
      entries.push({ kind: 'text', role: type, text, uuid, timestamp });
      continue;
    }

    entries.push({ kind: 'skipped', reason: 'transcript_unknown_content_shape', uuid, timestamp });
  }

  return { entries, drops: [...tally].map(([reason, countValue]) => ({ reason, count: countValue })) };
}

/** Maximum events per delivery (the daemon's ingest cap: `events: min(1).max(500)`). */
export const MAX_EVENTS_PER_DELIVERY = 500;

export interface TranscriptDelta {
  /** Text entries after the cursor, most recent last, capped at MAX_EVENTS_PER_DELIVERY. */
  deliver: TranscriptTextEntry[];
  /** The next cursor (uuid of the last DELIVERED entry; null keeps the previous one). */
  nextCursor: string | null;
  /** True when the cursor was not found (compaction/state loss) and the whole file was rescanned. */
  rescanned: boolean;
  /** Counted reasons for text entries after the cursor that will never be delivered. */
  drops: Array<{ reason: string; count: number }>;
}

/**
 * Select the delta: text entries after `cursorUuid`. When the cursor is missing from the file
 * (first run, compaction rewrite, lost state) everything is selected — the daemon dedupes exact
 * payload duplicates, so over-delivery is safe where under-delivery loses memories. When the
 * cap cuts the selection, the OLDEST events go first and the cursor advances only past what was
 * actually delivered; the remainder arrives on the next Stop (nothing is orphaned).
 */
export function selectTranscriptDelta(
  entries: readonly TranscriptEntry[],
  cursorUuid: string | null,
): TranscriptDelta {
  const drops = new Map<string, number>();
  const count = (reason: string): void => {
    drops.set(reason, (drops.get(reason) ?? 0) + 1);
  };

  let startIndex = 0;
  let rescanned = cursorUuid !== null;
  if (cursorUuid !== null) {
    const cursorIndex = entries.findIndex((entry) => entry.uuid === cursorUuid);
    if (cursorIndex !== -1) {
      startIndex = cursorIndex + 1;
      rescanned = false;
    }
  }

  const pending: TranscriptTextEntry[] = [];
  for (const entry of entries.slice(startIndex)) {
    if (entry.kind === 'text') pending.push(entry);
    else count(entry.reason);
  }

  // Oldest-first: over the cap, deliver the head of the backlog — under-delivery loses memories
  // (the module's own rule), while the tail is picked up by the next Stop without loss.
  const deliver = pending.length > MAX_EVENTS_PER_DELIVERY ? pending.slice(0, MAX_EVENTS_PER_DELIVERY) : pending;
  const lastDelivered = deliver[deliver.length - 1];
  const lastEntry = entries[entries.length - 1];

  let nextCursor = cursorUuid;
  if (lastDelivered !== undefined) {
    // Advance only past what was actually delivered — capped selections deliver the rest next Stop.
    nextCursor = lastDelivered.uuid ?? cursorUuid;
  } else if (lastEntry !== undefined && lastEntry.uuid !== undefined) {
    // Nothing deliverable after the cursor: advance past policy-skipped lines so they are never rescanned.
    nextCursor = lastEntry.uuid;
  }

  return {
    deliver,
    nextCursor,
    rescanned,
    drops: [...drops].map(([reason, countValue]) => ({ reason, count: countValue })),
  };
}

/** True when the utterance is an imperative remember request (see remember.ts). */
export function isRememberUtterance(text: string): boolean {
  return extractRememberUtterance(text) !== null;
}
