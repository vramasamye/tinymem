/**
 * OpenCode plugin signal → OnememoryEvent translation (ADR-0010 §6; pure, no I/O).
 *
 * THE CONTRACT: adapters are translators — runtime-native payloads become validated OnememoryEvent
 * envelopes (runtime: 'opencode') delivered through public surfaces. Every event returned here has
 * passed `validateOnememoryEvent`; a payload that cannot be mapped honestly is dropped with a
 * COUNTED reason, never coerced. The extractor recognizes exactly these families — command
 * execution (`terminal.output`), edited files (`file.changed`), error/resolution pairs
 * (`error.raised` + exit-code-carrying `terminal.output`), explicit user intent
 * (`explicit.remember`), conversation prose (`conversation.message`), and session boundaries
 * (`session.start`/`session.end`) — so each mapping below targets one of them.
 *
 * Mapping table (OpenCode signal → event, with the verified trigger for each):
 * - `session.created` event            → session.start (cwd from `info.directory`)
 * - `session.idle` event               → session.end (the runtime's session-quiescence signal —
 *   OpenCode's own docs use it for "Session completed!" notifications; sessions are resumable so
 *   this fires per turn-end, and the daemon treats session.end like Pi's reload/new-driven ends:
 *   the working-memory sweep runs, and a resumed session gets a fresh boundary)
 * - `chat.message` hook                → conversation.message (user), or ONE explicit.remember
 *   when the utterance is a leading imperative remember request (never both)
 * - `message.part.updated` text part, `time.end` set, not synthetic → conversation.message
 *   (assistant) — OpenCode's Message union is `UserMessage | AssistantMessage` (SDK
 *   `types.gen.d.ts`), user parts are claimed by the `chat.message` hook first, so a completed
 *   non-user text part is assistant output by the type system, not by guessing
 * - `message.part.updated` text part without `time.end` → counted drop (streaming delta; only a
 *   completed part is stable text — capturing deltas would fragment every answer)
 * - `message.part.updated` text part, `synthetic: true` → counted drop (runtime-injected prose —
 *   OpenCode marks injected parts synthetic; they are not conversation)
 * - `message.part.updated` tool part, `state.status: "error"` → error.raised (origin 'tool'; the
 *   failure channel for tools that throw instead of returning — the shell tool never uses it, it
 *   reports exit codes)
 * - `tool.execute.after` tool `bash`, `metadata.exit === 0`   → terminal.output (exit_code 0)
 * - `tool.execute.after` tool `bash`, `metadata.exit > 0`    → terminal.output (exit_code N) +
 *   error.raised (origin 'terminal', first meaningful output line — same message semantics as the
 *   Pi/Claude/Cursor adapters)
 * - `tool.execute.after` tool `bash`, `metadata.exit == null`→ terminal.output (exit_code null)
 *   + error.raised (abort/timeout — shell.ts returns null exactly there)
 * - `tool.execute.after` tool `edit`   → file.changed (modified; line counts from
 *   `oldString`/`newString` — the same math as the Claude/Cursor adapters, byte-identical deltas)
 * - `tool.execute.after` tool `write`   → file.changed (`metadata.exists === false` → 'created'
 *   with lines_added from the content, else 'modified' — the create/overwrite signal write.ts
 *   reports and Pi cannot)
 * - `tool.execute.after` any other tool → counted drop (read/grep/glob must not cost events;
 *   failures of those ride the tool-part error state above)
 * - `tool.execute.after` a tool named *onememory* → counted drop `own_memory_tool` (never ingest
 *   our own memory-tool traffic — the claude-mem/codex-rollout lesson, whatever name the runtime
 *   gives our MCP tools)
 * - any other event type → counted drop `unsubscribed_event:<type>` (counted, not captured — the
 *   same policy as the Pi adapter's unsubscribed events)
 *
 * Documented GAPS (OpenCode does not expose the fact):
 * - No session-END signal in the event vocabulary (sessions are long-lived and resumable; the SDK
 *   Event union has no quit/close). `session.idle` is the closest lifecycle boundary and carries
 *   no content; it is mapped to session.end above, honestly, rather than leaving the sweep
 *   trigger unrideable.
 * - `session.error` carries provider failures (auth, abort, output-length) — LLM-provider flaps
 *   are not tool/command failures and minting `error.raised` from them would pollute the
 *   failure-memory family, so the type is not subscribed (counted drop, reason named).
 */

import type { OnememoryEvent } from '@onememory/core';

import {
  buildEvent,
  clampDigest,
  DropCounter,
  EventValidationError,
  type EventContext,
} from './event-builder';
import { extractRememberUtterance } from './remember';
import {
  BashToolArgsSchema,
  BashToolMetadataSchema,
  ChatMessageInputSchema,
  ChatMessageOutputSchema,
  EditToolArgsSchema,
  EventHookInputSchema,
  EventTypeSchema,
  MessagePartUpdatedEventSchema,
  OpenCodeEventSchema,
  TextPartSchema,
  ToolAfterInputSchema,
  ToolAfterOutputSchema,
  ToolPartSchema,
  WriteToolArgsSchema,
  WriteToolMetadataSchema,
  type MessagePartUpdatedEvent,
  type SessionCreatedEvent,
  type SessionIdleEvent,
  type ToolAfterOutput,
} from './wire';

/** Schema maxes (packages/core event schemas) the adapter clamps into. */
const OUTPUT_DIGEST_MAX = 2000;
const ERROR_MESSAGE_MAX = 2000;
const CONTEXT_MAX = 500;
const MESSAGE_CONTENT_MAX = 20_000;
const REMEMBER_CONTENT_MAX = 2000;

/** The translator's fixed context (per plugin instance). */
export interface OpenCodeTranslateContext {
  /** Resolved project id (`scope.project_id`). */
  projectId?: string;
  /** `scope.agent_id`; defaults to `opencode`. */
  agentId?: string;
  /** The directory OpenCode runs in — `session.idle` carries no directory, parts carry no paths. */
  projectRoot?: string;
}

/** Per-call options (the clock above all — tests and the conformance suite inject it). */
export interface TranslateCall {
  /** Injectable clock for this signal (default `new Date()`). */
  now?: Date;
  /** Session id when the caller knows it better than the payload does. */
  sessionId?: string;
}

export interface OpenCodeTranslationResult {
  events: OnememoryEvent[];
  dropped: Array<{ reason: string; count: number }>;
}

const clampText = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

/**
 * Line counts with the Claude/Cursor semantics: one trailing newline does not open a phantom
 * line (a normal file's content ends with one). This is the exact math the sibling adapters use,
 * so `file.changed` deltas are byte-identical across runtimes.
 */
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized.length === 0 ? 0 : normalized.split('\n').length;
}

/** Normalize a path for `file.changed`: forward slashes, project-relative when under the root. */
function relativizePath(path: string, projectRoot: string | undefined): string {
  const normalized = path.replace(/\\/g, '/');
  if (projectRoot === undefined) return normalized;
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized === root) return '.';
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/** The first non-empty line of a tool output — the honest error headline (Pi's rule). */
function firstMeaningfulLine(text: string): string {
  return text.split('\n').find((line) => line.trim().length > 0)?.trim() ?? 'command failed';
}

/** Our own memory-tool traffic, whatever name the runtime gives the tool. */
function isOwnMemoryTool(tool: string): boolean {
  return tool.toLowerCase().includes('onememory');
}

/**
 * The stateful translator. One instance per plugin (per OpenCode process): the `chat.message`
 * hook claims user message ids so their streaming parts are never double-captured, and that
 * claim set is the only state — everything else is a pure function of the payload.
 */
export class OpenCodeTranslator {
  private readonly userMessageIds = new Set<string>();
  private readonly base: OpenCodeTranslateContext;

  constructor(context: OpenCodeTranslateContext = {}) {
    this.base = context;
  }

  /** The `event` hook channel: `{ event: Event }` → events. */
  translateEvent(rawInput: unknown, call: TranslateCall = {}): OpenCodeTranslationResult {
    const dropped = new DropCounter();
    const events: OnememoryEvent[] = [];
    const wrapper = EventHookInputSchema.safeParse(rawInput);
    if (!wrapper.success) {
      dropped.drop('malformed_event_wrapper');
      return { events, dropped: dropped.records };
    }
    const raw = wrapper.data.event;
    const typed = EventTypeSchema.safeParse(raw);
    if (!typed.success) {
      dropped.drop('malformed_event');
      return { events, dropped: dropped.records };
    }
    const parsed = OpenCodeEventSchema.safeParse(raw);
    if (!parsed.success) {
      dropped.drop(`unsubscribed_event:${typed.data.type}`);
      return { events, dropped: dropped.records };
    }
    const event = parsed.data;
    if (event.type === 'session.created') {
      events.push(...this.translateSessionCreated(event, call, dropped));
    } else if (event.type === 'session.idle') {
      events.push(...this.translateSessionIdle(event, call, dropped));
    } else {
      events.push(...this.translatePartUpdated(event, call, dropped));
    }
    return { events, dropped: dropped.records };
  }

  /** The `tool.execute.after` hook channel: (input, output) → events. */
  translateToolAfter(rawInput: unknown, rawOutput: unknown, call: TranslateCall = {}): OpenCodeTranslationResult {
    const dropped = new DropCounter();
    const events: OnememoryEvent[] = [];
    const input = ToolAfterInputSchema.safeParse(rawInput);
    const output = ToolAfterOutputSchema.safeParse(rawOutput);
    if (!input.success) {
      dropped.drop('malformed_tool_after_input');
      return { events, dropped: dropped.records };
    }
    if (!output.success) {
      dropped.drop('malformed_tool_after_output');
      return { events, dropped: dropped.records };
    }
    const { tool, sessionID, args } = input.data;
    if (isOwnMemoryTool(tool)) {
      dropped.drop('own_memory_tool');
      return { events, dropped: dropped.records };
    }
    if (tool === 'bash') {
      events.push(...this.translateBash(sessionID, args, output.data, call, dropped));
      return { events, dropped: dropped.records };
    }
    if (tool === 'edit') {
      events.push(...this.translateEdit(sessionID, args, call, dropped));
      return { events, dropped: dropped.records };
    }
    if (tool === 'write') {
      events.push(...this.translateWrite(sessionID, args, output.data, call, dropped));
      return { events, dropped: dropped.records };
    }
    dropped.drop(`unsubscribed_tool:${tool}`);
    return { events, dropped: dropped.records };
  }

  /** The `chat.message` hook channel: (input, output) → one user conversation event. */
  translateChatMessage(rawInput: unknown, rawOutput: unknown, call: TranslateCall = {}): OpenCodeTranslationResult {
    const dropped = new DropCounter();
    const events: OnememoryEvent[] = [];
    const input = ChatMessageInputSchema.safeParse(rawInput);
    const output = ChatMessageOutputSchema.safeParse(rawOutput);
    if (!input.success || !output.success) {
      dropped.drop(input.success ? 'malformed_chat_output' : 'malformed_chat_input');
      return { events, dropped: dropped.records };
    }
    const message = output.data.message;
    // Claim the user message id BEFORE any part streams: the part channel drops these ids, so the
    // utterance is captured exactly once (here, with the hook's own full text).
    this.userMessageIds.add(message.id);
    if (input.data.messageID !== undefined) this.userMessageIds.add(input.data.messageID);

    const text = chatPartsText(output.data.parts);
    const context: EventContext = {
      ...(this.base.projectId === undefined ? {} : { projectId: this.base.projectId }),
      sessionId: message.sessionID,
      ...(this.base.agentId === undefined ? {} : { agentId: this.base.agentId }),
      ...(call.now === undefined ? {} : { now: call.now }),
    };
    const remembered = extractRememberUtterance(text);
    const event = remembered === null
      ? this.mint(
          'conversation.message',
          { role: 'user', content: clampText(text, MESSAGE_CONTENT_MAX) },
          context,
          dropped,
        )
      : this.mint('explicit.remember', { content: clampText(remembered, REMEMBER_CONTENT_MAX) }, context, dropped);
    if (event !== null) events.push(event);
    return { events, dropped: dropped.records };
  }

  // -------------------------------------------------------------------------
  // Per-signal translation (private)
  // -------------------------------------------------------------------------

  private translateSessionCreated(
    event: SessionCreatedEvent,
    call: TranslateCall,
    dropped: DropCounter,
  ): OnememoryEvent[] {
    const info = event.properties.info;
    const cwd = info.directory.length > 0 ? info.directory : this.base.projectRoot;
    if (cwd === undefined || cwd.length === 0) {
      dropped.drop('session_start_missing_cwd');
      return [];
    }
    const event1 = this.mint(
      'session.start',
      {
        started_at: this.nowIso(call),
        cwd,
        summary: `opencode session start (title: ${clampText(info.title, 200)})`,
      },
      { sessionId: info.id, ...this.callContext(call, info.id) },
      dropped,
    );
    return event1 === null ? [] : [event1];
  }

  private translateSessionIdle(
    event: SessionIdleEvent,
    call: TranslateCall,
    dropped: DropCounter,
  ): OnememoryEvent[] {
    const cwd = this.base.projectRoot;
    if (cwd === undefined || cwd.length === 0) {
      dropped.drop('session_end_missing_cwd');
      return [];
    }
    const sessionEnd = this.mint(
      'session.end',
      {
        ended_at: this.nowIso(call),
        cwd,
        summary: 'opencode session idle (the agent turn loop is complete)',
      },
      { sessionId: event.properties.sessionID, ...this.callContext(call, event.properties.sessionID) },
      dropped,
    );
    return sessionEnd === null ? [] : [sessionEnd];
  }

  private translatePartUpdated(
    event: MessagePartUpdatedEvent,
    call: TranslateCall,
    dropped: DropCounter,
  ): OnememoryEvent[] {
    const part = event.properties.part;
    // The text arm: completed, non-synthetic, non-user parts are assistant prose.
    const text = TextPartSchema.safeParse(part);
    if (text.success) {
      if (text.data.time?.end === undefined) {
        dropped.drop('text_part_streaming');
        return [];
      }
      if (text.data.synthetic === true) {
        dropped.drop('synthetic_part');
        return [];
      }
      if (text.data.ignored === true) {
        dropped.drop('ignored_part');
        return [];
      }
      if (this.userMessageIds.has(text.data.messageID)) {
        dropped.drop('user_message_via_chat_hook');
        return [];
      }
      const message = this.mint(
        'conversation.message',
        { role: 'assistant', content: clampText(text.data.text, MESSAGE_CONTENT_MAX) },
        { sessionId: text.data.sessionID, ...this.callContext(call, text.data.sessionID) },
        dropped,
      );
      return message === null ? [] : [message];
    }
    // The tool arm: the error state is the failure channel for tools that throw.
    const tool = ToolPartSchema.safeParse(part);
    if (tool.success) {
      if (tool.data.state.status === 'error') {
        const raised = this.mint(
          'error.raised',
          {
            origin: 'tool',
            message: clampText(tool.data.state.error?.trim() || `tool ${tool.data.tool} failed`, ERROR_MESSAGE_MAX),
            context: clampText(tool.data.tool, CONTEXT_MAX),
          },
          { sessionId: tool.data.sessionID, ...this.callContext(call, tool.data.sessionID) },
          dropped,
        );
        return raised === null ? [] : [raised];
      }
      dropped.drop(`tool_part_state:${tool.data.state.status}`);
      return [];
    }
    // Everything else (step-start, reasoning, file, patch, snapshot, agent, retry, compaction,
    // subtask, step-finish, …) is progress metadata, not conversation or tool execution.
    const partType = typeof part === 'object' && part !== null && 'type' in part ? String((part as { type: unknown }).type) : 'unknown';
    dropped.drop(`part_not_prose:${partType}`);
    return [];
  }

  private translateBash(
    sessionID: string,
    args: unknown,
    output: ToolAfterOutput,
    call: TranslateCall,
    dropped: DropCounter,
  ): OnememoryEvent[] {
    const events: OnememoryEvent[] = [];
    const parsedArgs = BashToolArgsSchema.safeParse(args);
    if (!parsedArgs.success) {
      dropped.drop('bash_missing_command');
      return events;
    }
    const metadata = BashToolMetadataSchema.safeParse(output.metadata);
    // shell.ts returns `exit` on the metadata; null means abort/timeout — never a success.
    const exitCode = metadata.success && metadata.data.exit !== undefined ? metadata.data.exit : null;
    const digest = clampDigest(output.output, OUTPUT_DIGEST_MAX);
    const terminal = this.mint(
      'terminal.output',
      { command: parsedArgs.data.command, exit_code: exitCode, output_digest: digest, shell: 'bash' },
      { sessionId: sessionID, ...this.callContext(call, sessionID) },
      dropped,
    );
    if (terminal !== null) events.push(terminal);
    if (exitCode !== 0) {
      const message = exitCode === null
        ? 'command failed (aborted or timed out)'
        : firstMeaningfulLine(output.output);
      const error = this.mint(
        'error.raised',
        { origin: 'terminal', message: clampText(message, ERROR_MESSAGE_MAX), context: clampText(parsedArgs.data.command, CONTEXT_MAX) },
        { sessionId: sessionID, ...this.callContext(call, sessionID) },
        dropped,
      );
      if (error !== null) events.push(error);
    }
    return events;
  }

  private translateEdit(
    sessionID: string,
    args: unknown,
    call: TranslateCall,
    dropped: DropCounter,
  ): OnememoryEvent[] {
    const parsedArgs = EditToolArgsSchema.safeParse(args);
    if (!parsedArgs.success) {
      dropped.drop('edit_missing_file_path');
      return [];
    }
    // oldString/newString are the literally replaced content — their line counts are exact deltas
    // with the sibling adapters' math (Claude/Cursor/Pi); edit.ts's metadata.filediff reports the
    // same numbers but arg-derived counts keep cross-runtime identity provable.
    const changed = this.mint(
      'file.changed',
      {
        path: relativizePath(parsedArgs.data.filePath, this.base.projectRoot),
        change: 'modified',
        lines_removed: lineCount(parsedArgs.data.oldString),
        lines_added: lineCount(parsedArgs.data.newString),
      },
      { sessionId: sessionID, ...this.callContext(call, sessionID) },
      dropped,
    );
    return changed === null ? [] : [changed];
  }

  private translateWrite(
    sessionID: string,
    args: unknown,
    output: ToolAfterOutput,
    call: TranslateCall,
    dropped: DropCounter,
  ): OnememoryEvent[] {
    const parsedArgs = WriteToolArgsSchema.safeParse(args);
    if (!parsedArgs.success) {
      dropped.drop('write_missing_file_path');
      return [];
    }
    // write.ts reports `metadata.exists` — whether the file existed before the write: the honest
    // create/overwrite signal (a new file's content IS the whole delta; an overwrite's is not
    // derivable without the previous content, so it stays unset — never guessed).
    const metadata = WriteToolMetadataSchema.safeParse(output.metadata);
    const created = metadata.success && metadata.data.exists === false;
    const changed = this.mint(
      'file.changed',
      {
        path: relativizePath(parsedArgs.data.filePath, this.base.projectRoot),
        change: created ? 'created' : 'modified',
        ...(created ? { lines_added: lineCount(parsedArgs.data.content) } : {}),
      },
      { sessionId: sessionID, ...this.callContext(call, sessionID) },
      dropped,
    );
    return changed === null ? [] : [changed];
  }

  // -------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------

  private callContext(call: TranslateCall, sessionId: string): EventContext {
    return {
      ...(this.base.projectId === undefined ? {} : { projectId: this.base.projectId }),
      sessionId,
      ...(this.base.agentId === undefined ? {} : { agentId: this.base.agentId }),
      ...(call.now === undefined ? {} : { now: call.now }),
    };
  }

  private nowIso(call: TranslateCall): string {
    return (call.now ?? new Date()).toISOString();
  }

  /** Mint one candidate envelope; a validation failure is a counted drop, never a crash. */
  private mint(
    kind: OnememoryEvent['kind'],
    payload: Record<string, unknown>,
    context: EventContext,
    dropped: DropCounter,
  ): OnememoryEvent | null {
    try {
      return buildEvent(kind, { kind, ...payload } as Parameters<typeof buildEvent>[1], context);
    } catch (error) {
      if (error instanceof EventValidationError) {
        dropped.drop(`envelope_invalid:${kind}`);
        return null;
      }
      throw error;
    }
  }
}

/** The user text of a `chat.message` output: its text parts, concatenated (the message is prose-free). */
function chatPartsText(parts: unknown[] | undefined): string {
  if (parts === undefined) return '';
  const texts: string[] = [];
  for (const entry of parts) {
    const parsed = TextPartSchema.safeParse(entry);
    if (parsed.success && parsed.data.synthetic !== true && parsed.data.ignored !== true) {
      texts.push(parsed.data.text);
    }
  }
  return texts.join('\n');
}

/** Create one translator per plugin instance (state: the claimed user-message ids). */
export function createOpenCodeTranslator(context: OpenCodeTranslateContext = {}): OpenCodeTranslator {
  return new OpenCodeTranslator(context);
}
