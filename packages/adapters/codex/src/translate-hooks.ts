/**
 * Codex hook payload → OnememoryEvent translation (ADR-0010 §6: adapters are translators).
 *
 * What each verified hook becomes:
 *
 * | Hook event                     | Onememory kinds emitted                                      |
 * | ------------------------------ | ------------------------------------------------------------ |
 * | `UserPromptSubmit`            | `conversation.message` (user) or `explicit.remember` when the |
 * |                                |  prompt is a leading "remember/note/don't forget …" directive |
 * | `PostToolUse` (Bash)           | `terminal.output` (+ `error.raised` when the verified          |
 * |                                |  `Process exited with code N` header reports a non-zero exit)  |
 * | `PostToolUse` (apply_patch)    | `file.changed` × the patch's file directives                    |
 * | `Stop`                         | `conversation.message` (assistant, `last_assistant_message`)   |
 * | `SessionStart`                 | `session.start`                                                 |
 * | `SessionEnd`                   | `session.end`                                                  |
 *
 * Anything else (other tool names, non-patch payloads, missing fields) is DROPPED with a counted
 * reason — never coerced into an event kind it does not honestly fit.
 */

import {
  PostToolUseHookInputSchema,
  SessionEndHookInputSchema,
  SessionStartHookInputSchema,
  StopHookInputSchema,
  UserPromptSubmitHookInputSchema,
  EXIT_CODE_LINE,
  type PostToolUseHookInput,
} from './codex-wire';
import {
  buildEvent,
  clampDigest,
  DropCounter,
  EventValidationError,
  type EventContext,
  type TranslationResult,
} from './event-builder';
import { parseApplyPatch } from './apply-patch';

import type { OnememoryEvent } from '@onememory-ai/core';

export type { TranslationResult } from './event-builder';

/** Matches a prompt that is (from the first word) an explicit remember directive. */
const EXPLICIT_REMEMBER =
  /^\s*(?:please\s+|can\s+you\s+|could\s+you\s+|kindly\s+)?(?:remember(?:\s+that|\s+this)?|note(?:\s+that)?|don'?t\s+forget(?:\s+that)?|do\s+not\s+forget(?:\s+that)?)[:\s]\s*(.+)$/is;

/** Header lines of the Bash tool response that are transport, not output. */
const RESPONSE_HEADER_LINE =
  /^(?:Chunk ID: .+|Wall time: \d+(?:\.\d+)? seconds|Process exited with code -?\d+|Process running with session ID \d+|Original token count: \d+|Warning: truncated output \(original token count: \d+\)|Output:)$/;

const MAX_EXPLICIT_REMEMBER_CONTENT = 2000;

/** Tool names the hooks scaffold subscribes to (`Edit`/`Write` are documented apply_patch aliases). */
const BASH_TOOL_NAMES = new Set(['Bash']);
const APPLY_PATCH_TOOL_NAMES = new Set(['apply_patch', 'Edit', 'Write']);

/**
 * Translate one hook stdin payload.
 *
 * @param input the raw JSON Codex wrote to the hook's stdin
 * @param context scope resolution (project/session ids, clock injection)
 * @returns the validated events plus a counted drop ledger; never throws on unmappable input
 */
export function translateCodexHook(input: unknown, context: EventContext = {}): TranslationResult {
  const dropped = new DropCounter();
  const events: OnememoryEvent[] = [];

  // Every command hook carries `session_id`; it becomes `scope.session_id` for the events it
  // produces. Held in a mutable binding so the shared `push` always builds with the right scope.
  let buildContext: EventContext = context;

  const push = (kind: OnememoryEvent['kind'], payload: Parameters<typeof buildEvent>[1]) => {
    try {
      events.push(buildEvent(kind, payload, buildContext));
    } catch (error) {
      if (error instanceof EventValidationError) {
        dropped.drop(`invalid-envelope:${error.message}`);
      } else {
        dropped.drop('unexpected-build-failure');
      }
    }
  };

  const event = input as { hook_event_name?: unknown } | null;
  const name = typeof event?.hook_event_name === 'string' ? event.hook_event_name : undefined;

  if (name === 'SessionStart') {
    const parsed = SessionStartHookInputSchema.safeParse(input);
    if (!parsed.success) {
      dropped.drop('unmappable-session-start');
      return { events, dropped: dropped.records };
    }
    const hook = parsed.data;
    buildContext = { ...context, sessionId: hook.session_id };
    push('session.start', {
      kind: 'session.start',
      cwd: hook.cwd,
      started_at: (context.now ?? new Date()).toISOString(),
      summary: `codex session started (${hook.source})`,
    });
    return { events, dropped: dropped.records };
  }

  if (name === 'SessionEnd') {
    const parsed = SessionEndHookInputSchema.safeParse(input);
    if (!parsed.success) {
      dropped.drop('unmappable-session-end');
      return { events, dropped: dropped.records };
    }
    const hook = parsed.data;
    buildContext = { ...context, sessionId: hook.session_id };
    push('session.end', {
      kind: 'session.end',
      cwd: hook.cwd,
      ended_at: (context.now ?? new Date()).toISOString(),
      summary: `codex session ended (${hook.reason})`,
    });
    return { events, dropped: dropped.records };
  }

  if (name === 'UserPromptSubmit') {
    const parsed = UserPromptSubmitHookInputSchema.safeParse(input);
    if (!parsed.success) {
      dropped.drop('unmappable-user-prompt');
      return { events, dropped: dropped.records };
    }
    const hook = parsed.data;
    buildContext = { ...context, sessionId: hook.session_id };
    translateUserPrompt(hook.prompt, push, dropped);
    return { events, dropped: dropped.records };
  }

  if (name === 'Stop') {
    const parsed = StopHookInputSchema.safeParse(input);
    if (!parsed.success) {
      dropped.drop('unmappable-stop');
      return { events, dropped: dropped.records };
    }
    const hook = parsed.data;
    buildContext = { ...context, sessionId: hook.session_id };
    const message = hook.last_assistant_message;
    if (message === null || message.trim().length === 0) {
      dropped.drop('no-assistant-message');
      return { events, dropped: dropped.records };
    }
    push('conversation.message', { kind: 'conversation.message', role: 'assistant', content: message });
    return { events, dropped: dropped.records };
  }

  if (name === 'PostToolUse') {
    const parsed = PostToolUseHookInputSchema.safeParse(input);
    if (!parsed.success) {
      dropped.drop('unmappable-post-tool-use');
      return { events, dropped: dropped.records };
    }
    const hook = parsed.data;
    buildContext = { ...context, sessionId: hook.session_id };
    translatePostToolUse(hook, push, dropped);
    return { events, dropped: dropped.records };
  }

  dropped.drop(name === undefined ? 'missing-hook-event-name' : `unsupported-hook-event:${name}`);
  return { events, dropped: dropped.records };
}

function translateUserPrompt(
  prompt: string,
  push: (kind: OnememoryEvent['kind'], payload: Parameters<typeof buildEvent>[1]) => void,
  dropped: DropCounter,
): void {
  const remember = EXPLICIT_REMEMBER.exec(prompt);
  if (remember !== null) {
    const content = remember[1]!.trim().slice(0, MAX_EXPLICIT_REMEMBER_CONTENT);
    if (content.length > 0) {
      // One prompt, one event: the directive is the memory; the raw prompt is not ALSO sent as a
      // message, which would let the extractor mint a second, near-duplicate candidate.
      push('explicit.remember', { kind: 'explicit.remember', content });
      return;
    }
  }
  push('conversation.message', { kind: 'conversation.message', role: 'user', content: prompt });
}

function translatePostToolUse(
  hook: PostToolUseHookInput,
  push: (kind: OnememoryEvent['kind'], payload: Parameters<typeof buildEvent>[1]) => void,
  dropped: DropCounter,
): void {
  if (BASH_TOOL_NAMES.has(hook.tool_name)) {
    const command = commandOf(hook.tool_input);
    if (command === null) {
      dropped.drop('bash-command-unmappable');
      return;
    }
    const responseText = responseTextOf(hook.tool_response);
    const exitMatch = EXIT_CODE_LINE.exec(responseText ?? '');
    const exitCode = exitMatch !== null ? Number.parseInt(exitMatch[1]!, 10) : null;
    const digest = clampDigest(responseText ?? '');

    push('terminal.output', {
      kind: 'terminal.output',
      command,
      exit_code: exitCode,
      output_digest: digest,
    });

    if (exitCode !== null && exitCode !== 0) {
      push('error.raised', {
        kind: 'error.raised',
        origin: 'terminal',
        message: errorMessageFrom(command, responseText ?? '', exitCode),
        context: clampDigest(`codex: ${command}`, 500),
      });
    }
    return;
  }

  if (APPLY_PATCH_TOOL_NAMES.has(hook.tool_name)) {
    const patch = patchTextOf(hook.tool_input);
    if (patch === null) {
      dropped.drop('apply-patch-body-missing');
      return;
    }
    const changes = parseApplyPatch(patch);
    if (changes === null) {
      dropped.drop('apply-patch-unparseable');
      return;
    }
    if (changes.length === 0) {
      dropped.drop('apply-patch-empty');
      return;
    }
    for (const change of changes) {
      push('file.changed', {
        kind: 'file.changed',
        path: change.path,
        change: change.change,
        ...(change.old_path === undefined ? {} : { old_path: change.old_path }),
      });
    }
    return;
  }

  dropped.drop(`unmapped-tool:${hook.tool_name}`);
}

/** `tool_input.command` is a string, or an argv array joined with spaces. Anything else: unmappable. */
function commandOf(toolInput: unknown): string | null {
  if (typeof toolInput !== 'object' || toolInput === null) {
    if (typeof toolInput === 'string' && toolInput.trim().length > 0) return toolInput.trim();
    return null;
  }
  const command = (toolInput as Record<string, unknown>).command;
  if (typeof command === 'string' && command.trim().length > 0) return command.trim();
  if (Array.isArray(command) && command.every((part) => typeof part === 'string') && command.length > 0) {
    return (command as string[]).join(' ').trim();
  }
  return null;
}

/**
 * `tool_response` on the wire is a free JSON value; for the Bash tool it is the model-facing text
 * (string). Structured variants are handled defensively — a single string field is used, never a
 * guessed deep shape.
 */
function responseTextOf(toolResponse: unknown): string | null {
  if (typeof toolResponse === 'string') return toolResponse;
  if (typeof toolResponse === 'object' && toolResponse !== null) {
    for (const key of ['output', 'text', 'content']) {
      const value = (toolResponse as Record<string, unknown>)[key];
      if (typeof value === 'string') return value;
    }
    try {
      return clampDigest(JSON.stringify(toolResponse));
    } catch {
      return null;
    }
  }
  return null;
}

function patchTextOf(toolInput: unknown): string | null {
  if (typeof toolInput === 'string') return toolInput;
  if (typeof toolInput === 'object' && toolInput !== null) {
    const command = (toolInput as Record<string, unknown>).command;
    if (typeof command === 'string') return command;
  }
  return null;
}

function errorMessageFrom(command: string, responseText: string, exitCode: number): string {
  const bodyLines = responseText
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !RESPONSE_HEADER_LINE.test(line));
  const first = bodyLines.slice(0, 3).join(' | ').slice(0, 300);
  return first.length > 0 ? first : `command '${command}' exited with code ${exitCode}`;
}
