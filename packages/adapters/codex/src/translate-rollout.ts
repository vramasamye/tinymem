/**
 * Codex rollout (session-log) translator — the documented backfill ingest path.
 *
 * Rollout files are `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-<ts>-<thread-id>.jsonl` (archived
 * sessions under `archived_sessions/`); each line is `{timestamp, ordinal?, type, payload}`
 * (verified: `codex-rs/rollout/src/recorder.rs` `RolloutLineRef` + `codex-rs/history/src/
 * rollout_payload.rs` `RolloutItemWire`). This translator handles the record types that carry
 * memory-relevant activity and skips the rest — the same selection Codex's own native-memory
 * pipeline makes (`codex-rs/memories/write/src/rollout_input.rs` extracts from `response_item`
 * records and ignores `event_msg`/`turn_context`/`session_meta` evidence):
 *
 * | Rollout record                        | Onememory events                                  |
 * | ------------------------------------ | ------------------------------------------------- |
 * | `session_meta`                        | `session.start` (cwd, started_at = meta timestamp) |
 * | `response_item` `message` (user)      | `conversation.message` / `explicit.remember`       |
 * | `response_item` `message` (assistant)  | `conversation.message`                             |
 * | `response_item` `function_call`       | `conversation.tool_call` (non-shell tools), or held |
 * |                                        | for shell/apply_patch handling below                |
 * | `response_item` `function_call_output`| `terminal.output` (+`error.raised`) for shell calls, |
 * |                                        | `conversation.tool_result` for other tools — named |
 * |                                        | from the correlated `function_call` (M7b)          |
 * | `event_msg`, `turn_context`, `compacted`, `token_usage_record`, … | skipped (counted) |
 *
 * Generic results retain the correlated call's name when it fits core's 80-character bound.
 * `function_call_output` does not serialize runtime failure status; the legacy `ok: true`
 * mapping is retained, not proof of success. See the emission site and the M7b mission report.
 *
 * The adapter never reads rollouts automatically — the format is explicitly NOT a stable hook
 * interface (Hooks docs); this path is invoked by `onemem-codex-capture --rollout <file>` (manual
 * or wrapper-driven) so a version-format change can never break live capture.
 */

import { z } from 'zod';

import type { EventPayload, OnememoryEvent } from '@onememory-ai/core';

import {
  buildEvent,
  clampDigest,
  DropCounter,
  EventValidationError,
  type DroppedRecord,
  type EventContext,
} from './event-builder';
import { EXIT_CODE_LINE } from './codex-wire';
import { parseApplyPatch } from './apply-patch';

/** Hard bounds: a runaway file can never wedge the capture process (fail-soft includes "bounded"). */
export const MAX_ROLLOUT_LINES = 20_000;
export const MAX_ROLLOUT_BYTES = 25 * 1024 * 1024;

/** Harness-injected context wrappers that arrive as user-role messages (verified markers). */
const HARNESS_CONTEXT_PREFIXES = [
  '<ENVIRONMENT_CONTEXT>',
  '<SKILLS_INSTRUCTIONS>',
  '<PERMISSIONS_INSTRUCTIONS>',
] as const;

const SHELL_TOOL_NAMES = new Set(['shell', 'exec_command', 'container.exec']);

/**
 * Mirrors `ConversationToolResultPayloadSchema.tool`'s `.max(80)` in `@onememory-ai/core` (M3c).
 * The bound is not exported by core, so a longer name is omitted (counted, never silent) rather
 * than letting core's validation dead-letter the whole result event.
 */
const MAX_TOOL_RESULT_TOOL_NAME = 80;

const isoTimestamp = z.string();

const rolloutLineSchema = z.looseObject({
  timestamp: isoTimestamp,
  type: z.string(),
  payload: z.unknown(),
});

const contentItemSchema = z.looseObject({
  type: z.string(),
  text: z.string().optional(),
});

const messageItemSchema = z.looseObject({
  type: z.literal('message'),
  role: z.string(),
  content: z.array(contentItemSchema).optional(),
});

const functionCallItemSchema = z.looseObject({
  type: z.literal('function_call'),
  name: z.string(),
  call_id: z.string(),
  arguments: z.string().optional(),
});

const functionCallOutputItemSchema = z.looseObject({
  type: z.literal('function_call_output'),
  call_id: z.string().optional(),
  output: z.unknown(),
});

const sessionMetaSchema = z.looseObject({
  id: z.string().optional(),
  session_id: z.string().optional(),
  timestamp: isoTimestamp.optional(),
  cwd: z.string().optional(),
  originator: z.string().optional(),
  cli_version: z.string().optional(),
});

type MessageItem = z.infer<typeof messageItemSchema>;
type FunctionCallItem = z.infer<typeof functionCallItemSchema>;
type FunctionCallOutputItem = z.infer<typeof functionCallOutputItemSchema>;

interface PendingCall {
  tool: string;
  argumentsDigest: string;
}

export interface RolloutTranslationResult {
  events: OnememoryEvent[];
  dropped: DroppedRecord[];
  /** Session id read from `session_meta`, when present (the caller may reuse it for scope). */
  sessionId: string | null;
  lines: { read: number; skipped: number };
}

/**
 * Translate a rollout JSONL document. Line timestamps become `occurred_at` (they are the real
 * activity times; `ingested_at` is capture time).
 */
export function translateRolloutSession(text: string, context: EventContext = {}): RolloutTranslationResult {
  const dropped = new DropCounter();
  const events: OnememoryEvent[] = [];
  const pending = new Map<string, PendingCall>();
  let sessionId: string | null = null;
  let skipped = 0;

  const bounded = text.length > MAX_ROLLOUT_BYTES ? text.slice(0, MAX_ROLLOUT_BYTES) : text;
  if (bounded.length < text.length) dropped.drop('rollout-byte-overflow');

  const lines = bounded.split('\n');
  const lineCount = Math.min(lines.length, MAX_ROLLOUT_LINES);
  if (lines.length > MAX_ROLLOUT_LINES) dropped.drop('rollout-line-overflow');

  const push = (kind: OnememoryEvent['kind'], payload: EventPayload, occurredAt?: string) => {
    try {
      const event = buildEvent(kind, payload, context);
      events.push(occurredAt === undefined ? event : { ...event, occurred_at: occurredAt });
    } catch (error) {
      dropped.drop(error instanceof EventValidationError ? `invalid-envelope:${error.message}` : 'unexpected-build-failure');
    }
  };

  for (let index = 0; index < lineCount; index += 1) {
    const raw = lines[index]!.trim();
    if (raw.length === 0) continue;

    let parsedLine: z.infer<typeof rolloutLineSchema> | null;
    try {
      parsedLine = rolloutLineSchema.parse(JSON.parse(raw));
    } catch {
      dropped.drop('invalid-jsonl-line');
      continue;
    }

    const occurredAt = normalizeTimestamp(parsedLine.timestamp);

    switch (parsedLine.type) {
      case 'session_meta': {
        const meta = sessionMetaSchema.safeParse(parsedLine.payload);
        if (!meta.success) {
          dropped.drop('unmappable-session-meta');
          skipped += 1;
          break;
        }
        if (meta.data.session_id !== undefined) sessionId = meta.data.session_id;
        if (meta.data.cwd === undefined) {
          dropped.drop('session-meta-without-cwd');
          skipped += 1;
          break;
        }
        push(
          'session.start',
          {
            kind: 'session.start',
            cwd: meta.data.cwd,
            ...(meta.data.timestamp === undefined ? {} : { started_at: normalizeTimestamp(meta.data.timestamp) }),
            summary: `codex rollout ${meta.data.originator ?? 'codex_cli_rs'} ${meta.data.cli_version ?? ''}`.trim(),
          },
          occurredAt,
        );
        break;
      }

      case 'response_item': {
        const payload = parsedLine.payload as { type?: unknown } | null;
        const itemType = typeof payload?.type === 'string' ? payload.type : undefined;
        if (itemType === 'message') {
          translateMessage(payload as unknown, push, dropped, occurredAt, context);
        } else if (itemType === 'function_call') {
          translateFunctionCall(payload as unknown, push, dropped, pending, occurredAt, context);
        } else if (itemType === 'function_call_output') {
          translateFunctionCallOutput(payload as unknown, push, dropped, pending, occurredAt, context);
        } else {
          // reasoning, web_search_call, image_generation_call, … — not memory-relevant.
          dropped.drop(`skipped:response_item:${itemType ?? 'unknown'}`);
          skipped += 1;
        }
        break;
      }

      default: {
        // event_msg, turn_context, compacted, token_usage_record, world_state, … — the same
        // records Codex's own memory pipeline ignores.
        dropped.drop(`skipped:${parsedLine.type}`);
        skipped += 1;
        break;
      }
    }
  }

  for (const [callId, call] of pending) {
    void callId;
    void call;
    dropped.drop('call-without-output');
  }

  return { events, dropped: dropped.records, sessionId, lines: { read: lineCount, skipped } };
}

function translateMessage(
  payload: unknown,
  push: (kind: OnememoryEvent['kind'], payload: EventPayload, occurredAt?: string) => void,
  dropped: DropCounter,
  occurredAt: string | undefined,
  context: EventContext,
): void {
  const parsed = messageItemSchema.safeParse(payload);
  if (!parsed.success) {
    dropped.drop('unmappable-message');
    return;
  }
  const message: MessageItem = parsed.data;
  const items = message.content ?? [];
  const text = items
    .filter((item) => item.type === 'input_text' || item.type === 'output_text')
    .map((item) => item.text ?? '')
    .join('\n')
    .trim();

  if (message.role !== 'user' && message.role !== 'assistant') {
    // developer/system roles are harness machinery, not conversation.
    dropped.drop(`unsupported-role:${message.role}`);
    return;
  }
  if (text.length === 0) {
    dropped.drop('message-without-text');
    return;
  }
  if (message.role === 'user') {
    for (const prefix of HARNESS_CONTEXT_PREFIXES) {
      if (text.startsWith(prefix)) {
        dropped.drop('harness-injected-context');
        return;
      }
    }
    const remember = /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+|kindly\s+)?(?:remember(?:\s+that|\s+this)?|note(?:\s+that)?|don'?t\s+forget(?:\s+that)?|do\s+not\s+forget(?:\s+that)?)[:\s]\s*(.+)$/is.exec(
      text,
    );
    if (remember !== null && remember[1]!.trim().length > 0) {
      push('explicit.remember', { kind: 'explicit.remember', content: remember[1]!.trim().slice(0, 2000) }, occurredAt);
      return;
    }
  }
  push(
    'conversation.message',
    { kind: 'conversation.message', role: message.role, content: text },
    occurredAt,
  );
  void context;
}

function translateFunctionCall(
  payload: unknown,
  push: (kind: OnememoryEvent['kind'], payload: EventPayload, occurredAt?: string) => void,
  dropped: DropCounter,
  pending: Map<string, PendingCall>,
  occurredAt: string | undefined,
  context: EventContext,
): void {
  const parsed = functionCallItemSchema.safeParse(payload);
  if (!parsed.success) {
    dropped.drop('unmappable-function-call');
    return;
  }
  const call: FunctionCallItem = parsed.data;
  const argumentsText = call.arguments ?? '';

  if (call.name.includes('onememory')) {
    // Our own MCP tools already wrote through the store handler; re-capturing would double-count.
    dropped.drop('own-memory-tool');
    return;
  }

  if (call.name === 'apply_patch') {
    const patch = patchFromArguments(argumentsText);
    const changes = patch === null ? null : parseApplyPatch(patch);
    if (changes === null) {
      dropped.drop('apply-patch-unparseable');
      return;
    }
    if (changes.length === 0) {
      dropped.drop('apply-patch-empty');
      return;
    }
    for (const change of changes) {
      push(
        'file.changed',
        {
          kind: 'file.changed',
          path: change.path,
          change: change.change,
          ...(change.old_path === undefined ? {} : { old_path: change.old_path }),
        },
        occurredAt,
      );
    }
    return;
  }

  if (SHELL_TOOL_NAMES.has(call.name)) {
    const command = commandFromArguments(argumentsText);
    if (command === null) {
      dropped.drop('shell-command-unmappable');
      return;
    }
    pending.set(call.call_id, { tool: '__shell__', argumentsDigest: command });
    return;
  }

  // Any other tool (MCP, local function tools): a generic, honest tool-call record.
  pending.set(call.call_id, { tool: call.name, argumentsDigest: clampDigest(argumentsText, 400) });
  push(
    'conversation.tool_call',
    {
      kind: 'conversation.tool_call',
      tool: call.name,
      call_id: call.call_id,
      arguments_digest: clampDigest(argumentsText, 400),
    },
    occurredAt,
  );
  void context;
}

function translateFunctionCallOutput(
  payload: unknown,
  push: (kind: OnememoryEvent['kind'], payload: EventPayload, occurredAt?: string) => void,
  dropped: DropCounter,
  pending: Map<string, PendingCall>,
  occurredAt: string | undefined,
  context: EventContext,
): void {
  const parsed = functionCallOutputItemSchema.safeParse(payload);
  if (!parsed.success) {
    dropped.drop('unmappable-function-call-output');
    return;
  }
  const output: FunctionCallOutputItem = parsed.data;
  const callId = output.call_id;
  const pendingCall = callId === undefined ? undefined : pending.get(callId);
  if (pendingCall === undefined) {
    dropped.drop('orphan-output');
    return;
  }
  if (callId !== undefined) pending.delete(callId);

  const outputText = outputTextOf(output.output);
  if (pendingCall.tool === '__shell__') {
    const exitMatch = EXIT_CODE_LINE.exec(outputText ?? '');
    const exitCode = exitMatch !== null ? Number.parseInt(exitMatch[1]!, 10) : null;
    push(
      'terminal.output',
      {
        kind: 'terminal.output',
        command: pendingCall.argumentsDigest,
        exit_code: exitCode,
        output_digest: clampDigest(outputText ?? ''),
      },
      occurredAt,
    );
    if (exitCode !== null && exitCode !== 0) {
      push(
        'error.raised',
        {
          kind: 'error.raised',
          origin: 'terminal',
          message: clampDigest(outputText ?? '', 300) || `command '${pendingCall.argumentsDigest}' exited with code ${exitCode}`,
          context: clampDigest(`codex: ${pendingCall.argumentsDigest}`, 500),
        },
        occurredAt,
      );
    }
    return;
  }

  // Preserve legacy ok:true, not a verified success: Codex's models.rs serializer writes only
  // FunctionCallOutputPayload.body and drops success (derived from MCP isError). Verified at
  // rust-v0.134.0 and afb436df8b70bb5bc57b86d9a3e829968988cd21; citations in the M7b report.
  // Never interpret output JSON/prose as a status envelope. The separate mcp_tool_call_end
  // event_msg retains status, but consuming that producer seam is outside this bounded cut.
  const tool = pendingCall.tool;
  if (tool.length > MAX_TOOL_RESULT_TOOL_NAME) {
    dropped.drop('tool-result-name-overlength');
  }
  push(
    'conversation.tool_result',
    {
      kind: 'conversation.tool_result',
      call_id: callId ?? '',
      ok: true,
      ...(tool.length >= 1 && tool.length <= MAX_TOOL_RESULT_TOOL_NAME ? { tool } : {}),
      output_digest: clampDigest(outputText ?? ''),
    },
    occurredAt,
  );
  void context;
}

/** `arguments` is a JSON-encoded string on the wire; the command may be a string or an argv array. */
function commandFromArguments(argumentsText: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsText);
  } catch {
    return argumentsText.trim().length > 0 ? argumentsText.trim() : null;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return typeof parsed === 'string' && parsed.trim().length > 0 ? parsed.trim() : null;
  }
  const command = (parsed as Record<string, unknown>).command;
  if (typeof command === 'string' && command.trim().length > 0) return command.trim();
  if (Array.isArray(command) && command.every((part) => typeof part === 'string') && command.length > 0) {
    return (command as string[]).join(' ').trim();
  }
  return null;
}

/** The apply_patch body can ride several argument keys across versions — find the patch markers. */
function patchFromArguments(argumentsText: string): string | null {
  try {
    const parsed: unknown = JSON.parse(argumentsText);
    if (typeof parsed === 'string') return parsed.includes('*** Begin Patch') ? parsed : null;
    if (typeof parsed === 'object' && parsed !== null) {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (typeof value === 'string' && value.includes('*** Begin Patch')) return value;
      }
    }
    return null;
  } catch {
    // Not JSON: some wrappers pass the patch body bare.
    return argumentsText.includes('*** Begin Patch') ? argumentsText : null;
  }
}

/** `output` is a plain string or a structured content-item array on the wire. */
function outputTextOf(output: unknown): string | null {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    const text = output
      .map((item) =>
        typeof item === 'object' && item !== null && typeof (item as { text?: unknown }).text === 'string'
          ? (item as { text: string }).text
          : '',
      )
      .join('\n');
    return text.length > 0 ? text : null;
  }
  if (typeof output === 'object' && output !== null) {
    const asRecord = output as Record<string, unknown>;
    if (typeof asRecord.content === 'string') return asRecord.content;
    if (typeof asRecord.output === 'string') return asRecord.output;
  }
  return null;
}

function normalizeTimestamp(timestamp: string | undefined): string | undefined {
  if (timestamp === undefined) return undefined;
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}
