/**
 * Cursor hook payload → OnememoryEvent translation (pure, no I/O; ADR-0010 §6).
 *
 * THE CONTRACT: adapters are translators — runtime-native hook payloads become validated
 * OnememoryEvent envelopes (runtime: 'cursor') delivered through public surfaces. Every event
 * returned by `translateHookInput` has passed `validateOnememoryEvent`; a payload that cannot be
 * mapped honestly is dropped with a COUNTED reason, never coerced. The extractor (mission 3)
 * recognizes exactly these families — command execution (`terminal.output`), edited files
 * (`file.changed`), error/resolution pairs (`error.raised` + exit-code-carrying `terminal.output`),
 * conversation prose (`conversation.message`), and explicit user intent (`explicit.remember`) — so
 * each mapping below targets one of them.
 *
 * Mapping table (Cursor hook → event, verified against https://cursor.com/docs/hooks on
 * 2026-10-05; the per-field shapes live in hook-input.ts):
 *
 * | Cursor hook          | Onememory kinds                                              |
 * | -------------------- | ------------------------------------------------------------ |
 * | `sessionStart`       | `session.start`                                              |
 * | `sessionEnd`         | `session.end` (the daemon's working-memory sweep trigger)     |
 * | `beforeSubmitPrompt` | `conversation.message` (user), or `explicit.remember` when    |
 * |                      | the prompt is a leading "remember/note/don't forget …"        |
 * |                      | directive (one utterance, one capture)                        |
 * | `afterAgentResponse` | `conversation.message` (assistant, the final text)            |
 * | `postToolUse` Shell  | `terminal.output` (exit code read from the documented         |
 * |                      | JSON-stringified `tool_output`)                               |
 * | `afterFileEdit`      | `file.changed` (one per edited file)                          |
 * | `postToolUseFailure` Shell | `error.raised` (origin 'terminal')                      |
 * | `postToolUseFailure` other | `error.raised` (origin 'tool')                          |
 *
 * Documented GAPS (Cursor does not expose the fact; see the README "Hook coverage" table):
 * - A FAILED shell command has NO exit code anywhere in Cursor's contract: `postToolUseFailure`
 *   carries `error_message` + `failure_type` and `afterShellExecution` carries `command`/`output`
 *   only. The failure's `terminal.output` therefore carries `exit_code: null`; failure detection
 *   rides the `error.raised` event, which is what `failureIncidentOf` reads first. A SUCCESSFUL
 *   shell command does carry `exitCode` inside the documented `tool_output` JSON example.
 * - `stop` is a per-turn loop end (`{status, loop_count}`) with no transcript and no sweep
 *   semantics, so it maps to nothing and is dropped with a counted reason. The working-memory
 *   sweep is triggered by `sessionEnd` → `session.end` (the daemon's session-end lifecycle pass).
 * - Conversation deltas beyond the user prompt (`beforeSubmitPrompt`) and the final assistant
 *   text (`afterAgentResponse`) are not available: Cursor exposes `transcript_path`, but the
 *   transcript FILE FORMAT is not documented, and parsing an undocumented format would be
 *   fabricated provenance. Recorded as a gap, not guessed.
 * - `postToolUse` for file-edit tools is dropped (counted) because `afterFileEdit` is the
 *   dedicated channel for the same edit; emitting both would duplicate the `file.changed` event.
 */

import {
  eventContentHash,
  uuidv7,
  validateOnememoryEvent,
  type OnememoryEvent,
} from '@onememory-ai/core';

import {
  FILE_EDIT_TOOL_NAMES,
  SHELL_TOOL_NAMES,
  ShellToolInputSchema,
  ShellToolOutputSchema,
  parseHookInput,
  type HookInput,
} from './hook-input';
import { extractRememberUtterance } from './remember';
import { ADAPTER_VERSION } from './version';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Facts the hook script gathers around the payload (clock, scope — all injectable). */
export interface TranslateContext {
  /** Event/ingest clock (single instant for the whole batch; default `new Date()`). */
  now?: Date;
  /** Registered project id (uuid) — omitted from the scope when unknown. */
  projectId?: string | null;
  /** `scope.agent_id` (default `cursor`). */
  agentId?: string;
  /** The workspace root, used for `session.start`/`session.end` cwd when the payload omits it. */
  projectRoot?: string | null;
  /** `source.adapter_version` override (tests). */
  adapterVersion?: string;
}

/** One payload that could not be mapped, with a stable reason code. */
export interface TranslationDrop {
  reason: string;
  count: number;
  detail?: string;
}

export interface TranslationResult {
  events: OnememoryEvent[];
  drops: TranslationDrop[];
}

// ---------------------------------------------------------------------------
// Constants (clamps mirror the payload field limits the event schema enforces)
// ---------------------------------------------------------------------------

const MESSAGE_CONTENT_MAX = 8000;
const OUTPUT_DIGEST_MAX = 2000;
const ERROR_MESSAGE_MAX = 300;
const CONTEXT_MAX = 500;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class DropTally {
  private readonly counts = new Map<string, { count: number; detail?: string }>();

  count(reason: string, detail?: string): void {
    const existing = this.counts.get(reason);
    if (existing === undefined) {
      this.counts.set(reason, detail === undefined ? { count: 1 } : { count: 1, detail });
      return;
    }
    existing.count += 1;
    existing.detail ??= detail;
  }

  toArray(): TranslationDrop[] {
    return [...this.counts.entries()].map(([reason, value]) =>
      value.detail === undefined ? { reason, count: value.count } : { reason, count: value.count, detail: value.detail },
    );
  }
}

const clampText = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
  return normalized.length === 0 ? 0 : normalized.split('\n').length;
}

function relativizePath(path: string, projectRoot: string | null): string {
  if (projectRoot === null || projectRoot.length === 0) return path;
  const root = projectRoot.replace(/\/+$/, '');
  if (path === root) return '.';
  if (path.startsWith(`${root}/`)) return path.slice(root.length + 1);
  return path;
}

function isValidIso(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value);
}

interface MintOptions {
  now: Date;
  nowIso: string;
  projectId: string | null;
  agentId: string;
  adapterVersion: string;
}

/**
 * Mint one candidate envelope and validate it against the canonical schema. Validation failure
 * means a mapping bug on our side — the event is dropped with the schema issues (belt and
 * suspenders over the per-payload clamps; the caller NEVER sees an invalid envelope).
 */
function mintEvent(
  payload: Record<string, unknown>,
  options: { mint: MintOptions; sessionId: string | undefined; occurredAt?: string; tally: DropTally },
): OnememoryEvent | null {
  const { mint, sessionId, tally } = options;
  const occurredAt = options.occurredAt !== undefined && isValidIso(options.occurredAt) ? options.occurredAt : mint.nowIso;
  const candidate = {
    id: uuidv7(mint.now.getTime()),
    kind: payload.kind as string,
    occurred_at: occurredAt,
    ingested_at: mint.nowIso,
    source: { runtime: 'cursor' as const, adapter_version: mint.adapterVersion },
    scope: {
      ...(mint.projectId === null ? {} : { project_id: mint.projectId }),
      ...(sessionId === undefined ? {} : { session_id: sessionId }),
      agent_id: mint.agentId,
    },
    payload,
    content_hash: eventContentHash(payload),
    redactions: [],
  };
  const result = validateOnememoryEvent(candidate);
  if (!result.ok) {
    tally.count(
      `envelope_invalid:${String(payload.kind)}`,
      result.dead_letter.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '),
    );
    return null;
  }
  return result.value;
}

/** The session id Cursor keys this payload under (`session_id`, else `conversation_id`). */
function sessionIdOf(input: HookInput): string | undefined {
  if ('session_id' in input && typeof input.session_id === 'string' && input.session_id.length > 0) {
    return input.session_id;
  }
  return input.conversation_id !== undefined && input.conversation_id.length > 0 ? input.conversation_id : undefined;
}

/**
 * The workspace root for the session lifecycle events. `sessionStart`/`sessionEnd` carry no `cwd`
 * field (verified: hooks reference), so the documented `workspace_roots` common field is the only
 * in-payload source; `ctx.projectRoot` (the hook script's `CURSOR_PROJECT_DIR`/discovery) is the
 * fallback. Neither present → counted drop, never a guessed path.
 */
function cwdOf(input: HookInput, ctx: TranslateContext): string | null {
  const root = input.workspace_roots?.find((value) => value.length > 0);
  if (root !== undefined) return root;
  if (ctx.projectRoot !== undefined && ctx.projectRoot !== null && ctx.projectRoot.length > 0) {
    return ctx.projectRoot;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Per-event translation
// ---------------------------------------------------------------------------

function translateSessionStart(
  input: Extract<HookInput, { hook_event_name: 'sessionStart' }>,
  ctx: TranslateContext,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  const cwd = cwdOf(input, ctx);
  if (cwd === null) {
    tally.count('session_start_missing_cwd');
    return [];
  }
  const mode = input.composer_mode === undefined ? '' : `, composer_mode: ${input.composer_mode}`;
  const event = mintEvent(
    {
      kind: 'session.start',
      started_at: mint.nowIso,
      cwd,
      summary: `cursor session start (background: ${String(input.is_background_agent === true)}${mode})`,
    },
    { mint, sessionId: sessionIdOf(input), tally },
  );
  return event === null ? [] : [event];
}

function translateSessionEnd(
  input: Extract<HookInput, { hook_event_name: 'sessionEnd' }>,
  ctx: TranslateContext,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  const cwd = cwdOf(input, ctx);
  if (cwd === null) {
    tally.count('session_end_missing_cwd');
    return [];
  }
  const event = mintEvent(
    {
      kind: 'session.end',
      ended_at: mint.nowIso,
      cwd,
      summary: `cursor session end (reason: ${input.reason ?? 'unknown'})`,
    },
    { mint, sessionId: sessionIdOf(input), tally },
  );
  return event === null ? [] : [event];
}

/**
 * The user's submitted prompt: an imperative remember directive becomes `explicit.remember`
 * (one utterance, one authoritative capture); every other prompt is a `conversation.message`.
 */
function translateBeforeSubmitPrompt(
  input: Extract<HookInput, { hook_event_name: 'beforeSubmitPrompt' }>,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  const prompt = input.prompt.trim();
  if (prompt.length === 0) {
    tally.count('empty_prompt');
    return [];
  }
  const remembered = extractRememberUtterance(prompt);
  const payload =
    remembered === null
      ? { kind: 'conversation.message' as const, role: 'user' as const, content: clampText(prompt, MESSAGE_CONTENT_MAX) }
      : { kind: 'explicit.remember' as const, content: clampText(remembered, MESSAGE_CONTENT_MAX) };
  const event = mintEvent(payload, { mint, sessionId: sessionIdOf(input), tally });
  return event === null ? [] : [event];
}

function translateAfterAgentResponse(
  input: Extract<HookInput, { hook_event_name: 'afterAgentResponse' }>,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  const text = input.text.trim();
  if (text.length === 0) {
    tally.count('empty_agent_response');
    return [];
  }
  const event = mintEvent(
    { kind: 'conversation.message', role: 'assistant', content: clampText(text, MESSAGE_CONTENT_MAX) },
    { mint, sessionId: sessionIdOf(input), tally },
  );
  return event === null ? [] : [event];
}

/** Parse the documented JSON-stringified `tool_output`; `null` when it is absent or not JSON. */
function shellOutputOf(toolOutput: string | undefined): { exitCode: number | null; digest: string } | null {
  if (toolOutput === undefined || toolOutput.trim().length === 0) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(toolOutput);
  } catch {
    return null;
  }
  const parsed = ShellToolOutputSchema.safeParse(decoded);
  if (!parsed.success) return null;
  const exitCode = parsed.data.exitCode ?? parsed.data.exit_code ?? null;
  const text = parsed.data.stdout ?? parsed.data.stderr ?? '';
  return { exitCode, digest: clampText(text, OUTPUT_DIGEST_MAX) };
}

function translatePostToolUse(
  input: Extract<HookInput, { hook_event_name: 'postToolUse' }>,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  if ((SHELL_TOOL_NAMES as readonly string[]).includes(input.tool_name)) {
    const toolInput = ShellToolInputSchema.safeParse(input.tool_input);
    if (!toolInput.success) {
      tally.count(`missing_command:${input.tool_name}`);
      return [];
    }
    // postToolUse fires after a SUCCESSFUL execution, so the documented `tool_output` example
    // carries `exitCode`; a missing/unparseable payload leaves it null rather than assuming 0.
    const shell = shellOutputOf(input.tool_output);
    if (shell === null) tally.count('shell_output_unparseable');
    const event = mintEvent(
      {
        kind: 'terminal.output',
        command: toolInput.data.command,
        exit_code: shell?.exitCode ?? null,
        output_digest: shell?.digest ?? '',
      },
      { mint, sessionId: sessionIdOf(input), tally },
    );
    return event === null ? [] : [event];
  }

  if ((FILE_EDIT_TOOL_NAMES as readonly string[]).includes(input.tool_name)) {
    // afterFileEdit is the dedicated channel for the same edit (counted, not silent).
    tally.count(`file_edit_via_afterFileEdit:${input.tool_name}`);
    return [];
  }

  tally.count(`unmapped_tool:${input.tool_name}`);
  return [];
}

function translatePostToolUseFailure(
  input: Extract<HookInput, { hook_event_name: 'postToolUseFailure' }>,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  if (input.is_interrupt === true) {
    // An abort is not an error the project should remember.
    tally.count('interrupted_failure');
    return [];
  }
  const events: OnememoryEvent[] = [];
  const message = clampText(input.error_message.trim(), ERROR_MESSAGE_MAX);

  if ((SHELL_TOOL_NAMES as readonly string[]).includes(input.tool_name)) {
    const toolInput = ShellToolInputSchema.safeParse(input.tool_input);
    const command = toolInput.success ? toolInput.data.command : null;
    if (command === null) tally.count(`missing_command:${input.tool_name}`);
    if (command !== null) {
      // Cursor exposes NO exit code for a failed shell command (documented gap, README): the
      // failed command is still recorded, with `exit_code: null`, and failure detection rides the
      // error.raised event below.
      const terminal = mintEvent(
        { kind: 'terminal.output', command, exit_code: null, output_digest: '' },
        { mint, sessionId: sessionIdOf(input), tally },
      );
      if (terminal !== null) events.push(terminal);
    }
    const error = mintEvent(
      {
        kind: 'error.raised',
        origin: 'terminal',
        message,
        ...(command === null ? {} : { context: clampText(command, CONTEXT_MAX) }),
      },
      { mint, sessionId: sessionIdOf(input), tally },
    );
    if (error !== null) events.push(error);
    return events;
  }

  // Any other tool failure (Read, Grep, MCP tools, …) — a real error with a real message.
  const error = mintEvent(
    {
      kind: 'error.raised',
      origin: 'tool',
      message,
      context: clampText(input.tool_name, CONTEXT_MAX),
    },
    { mint, sessionId: sessionIdOf(input), tally },
  );
  return error === null ? [] : [error];
}

function translateAfterFileEdit(
  input: Extract<HookInput, { hook_event_name: 'afterFileEdit' }>,
  ctx: TranslateContext,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  const edits = input.edits ?? [];
  // old_string/new_string are the literally replaced content — their line counts are exact deltas.
  const removed = edits.reduce((total, edit) => total + (edit.old_string === undefined ? 0 : lineCount(edit.old_string)), 0);
  const added = edits.reduce((total, edit) => total + (edit.new_string === undefined ? 0 : lineCount(edit.new_string)), 0);
  const event = mintEvent(
    {
      kind: 'file.changed',
      path: relativizePath(input.file_path, ctx.projectRoot ?? null),
      change: 'modified',
      ...(edits.length === 0 ? {} : { lines_added: added, lines_removed: removed }),
    },
    { mint, sessionId: sessionIdOf(input), tally },
  );
  return event === null ? [] : [event];
}

/**
 * `stop` ends one agent loop (`{status, loop_count}`). It carries no transcript and no lifecycle
 * semantics onememory can act on — the working-memory sweep is driven by `sessionEnd` →
 * `session.end` — so it is dropped with a counted reason (documented gap, README).
 */
function translateStop(tally: DropTally): OnememoryEvent[] {
  tally.count('turn_end_no_event');
  return [];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Translate one Cursor hook payload into validated events + counted drops. Pure: no clock reads,
 * no filesystem, no network — `context` carries every fact from outside.
 */
export function translateHookInput(rawInput: unknown, context: TranslateContext = {}): TranslationResult {
  const tally = new DropTally();
  const now = context.now ?? new Date();
  const mint: MintOptions = {
    now,
    nowIso: now.toISOString(),
    projectId: context.projectId ?? null,
    agentId: context.agentId ?? 'cursor',
    adapterVersion: context.adapterVersion ?? ADAPTER_VERSION,
  };

  const parsed = parseHookInput(rawInput);
  if (!parsed.ok) {
    tally.count(parsed.reason);
    return { events: [], drops: tally.toArray() };
  }
  const input = parsed.value;

  let events: OnememoryEvent[];
  switch (input.hook_event_name) {
    case 'sessionStart':
      events = translateSessionStart(input, context, tally, mint);
      break;
    case 'sessionEnd':
      events = translateSessionEnd(input, context, tally, mint);
      break;
    case 'beforeSubmitPrompt':
      events = translateBeforeSubmitPrompt(input, tally, mint);
      break;
    case 'afterAgentResponse':
      events = translateAfterAgentResponse(input, tally, mint);
      break;
    case 'postToolUse':
      events = translatePostToolUse(input, tally, mint);
      break;
    case 'postToolUseFailure':
      events = translatePostToolUseFailure(input, tally, mint);
      break;
    case 'afterFileEdit':
      events = translateAfterFileEdit(input, context, tally, mint);
      break;
    case 'stop':
      events = translateStop(tally);
      break;
  }
  return { events, drops: tally.toArray() };
}
