/**
 * Pi extension-event → OnememoryEvent translation (pure, no I/O).
 *
 * THE CONTRACT (mission 9 + ADR-0010 §6): adapters are translators — runtime-native payloads become
 * validated OnememoryEvent envelopes (runtime: 'pi') delivered through public surfaces. Every event
 * returned here has passed `validateOnememoryEvent`; a payload that cannot be mapped honestly is
 * dropped with a COUNTED reason, never coerced. The extractor recognizes exactly these families —
 * command execution (`terminal.output`), edited files (`file.changed`), error/resolution pairs
 * (`error.raised` + exit-code-carrying `terminal.output`), commit messages (`git.commit`), explicit
 * user intent (`explicit.remember`), conversation prose (`conversation.message`), and session
 * boundaries (`session.start`/`session.end`) — so each mapping below targets one of them.
 *
 * Mapping table (Pi signal → event, with the verified trigger for each):
 * - session_start (reason startup|reload|new|resume|fork)  → session.start (cwd from the
 *   extension context; every reason is a real session boundary for the runtime being loaded)
 * - session_shutdown (reason quit|reload|new|resume|fork)  → session.end (the extension runtime is
 *   torn down for this session on every one of those reasons)
 * - message_end (role user)                → conversation.message, or ONE explicit.remember when
 *   the utterance is a leading imperative remember request (never both)
 * - message_end (role assistant, text)     → conversation.message
 * - message_end (role system|toolResult|custom) → counted drop (not conversation prose)
 * - message_end (role user, our injection) → counted drop `own_injection` (the memory context the
 *   extension injected via sendUserMessage is engine OUTPUT, not user prose — ingesting it would
 *   mint memories about the memory index)
 * - tool_result bash/powershell, ok        → terminal.output (exit_code 0: `bash.ts` returns
 *   isError only when exit_code ≠ 0, so a non-error result PROVES a zero exit; the
 *   structuredContent.exit_code confirms when present)
 * - tool_result bash/powershell, isError   → terminal.output (parsed exit code) + error.raised
 *   (origin 'terminal')
 * - tool_result bash `git commit`          → git.commit (enrichment-gated, see git.ts)
 * - tool_result edit                       → file.changed (exact line deltas from edits[])
 * - tool_result write                      → file.changed 'modified' (write.ts returns no
 *   create/overwrite signal, so lines_added stays unset — never guessed)
 * - tool_result any other tool, isError    → error.raised (origin 'tool')
 * - tool_result any other tool, ok        → counted drop (read/grep/find/ls must not cost events)
 * - tool_result mcp__onememory__*         → counted drop `own_memory_tool` (never ingest our own
 *   memory-tool traffic — the claude-mem/codex-rollout lesson)
 * - before_agent_start                    → counted drop (the injection-only channel; the user
 *   prompt itself arrives via message_end — capturing both would double every turn)
 *
 * Nested tool calls (parentToolCallId set — a codemode script calling bash) ARE captured: they are
 * real tool executions with real inputs and outputs; their results never reach the transcript, so
 * this is the only place they can be observed. Documented, not guessed.
 */

import type { OnememoryEvent } from '@onememory-ai/core';

import {
  buildEvent,
  clampDigest,
  DropCounter,
  EventValidationError,
  type DroppedRecord,
  type EventContext,
} from './event-builder';
import {
  commitShaFromStdout,
  commitStatsFromStdout,
  looksLikeGitCommit,
  type GitCommitFacts,
} from './git';
import {
  PiBashToolInputSchema,
  PiBashToolOutputSchema,
  PiCaptureEventSchema,
  PiEditToolInputSchema,
  PiMessageContentSchema,
  PiWriteToolInputSchema,
  PI_CAPTURE_EVENT_NAMES,
  type PiMessage,
  type PiToolResultEvent,
} from './pi-wire';
import { extractRememberUtterance } from './remember';

/** Schema maxes (packages/core event schemas) the adapter clamps into. */
const OUTPUT_DIGEST_MAX = 2000;
const ERROR_MESSAGE_MAX = 2000;
const CONTEXT_MAX = 500;
const MESSAGE_CONTENT_MAX = 20_000;
const REMEMBER_CONTENT_MAX = 2000;

/**
 * The sentinel the generated extension prefixes to its injected memory context. A user message
 * starting with this marker is engine output, not user prose — the translator drops it.
 */
export const PI_CONTEXT_INJECTION_PREFIX = '[onememory:project-memory-context]';

/** `scope.agent_id` default: the runtime name, matching the Claude/Codex adapters. */
export interface PiTranslateContext extends EventContext {
  /** Working directory (ExtensionContext.cwd) — required for session.start/session.end. */
  cwd?: string;
  /** Root for relativizing edit/write paths; defaults to `cwd` (Pi resolves tool paths against it). */
  projectRoot?: string;
  /** git commit facts for the current HEAD (tool_result enrichment); see git.ts. */
  gitCommitFacts?: GitCommitFacts | { error: string } | null;
}

export interface PiTranslationResult {
  events: OnememoryEvent[];
  dropped: DroppedRecord[];
}

const clampText = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  // The Claude baseline's formula (the conformance reference runtime): a trailing newline still
  // counts as a split boundary, so `old\n` is 2. Codex/Cursor count the git-true 1 by trimming —
  // a pre-existing, pipeline-tolerated divergence in line-count fields (pipeline.ts); Pi matches
  // the Claude baseline so the canonical edit is byte-identical to it.
  return text.split('\n').length;
}

/**
 * Normalize a path for `file.changed`: forward slashes, project-relative when it sits under the
 * project root (matching the exclusion-policy and fixture path shapes — e.g. `config/.env`),
 * untouched when outside the root (the policy still judges it; the daemon re-checks too).
 */
function relativizePath(path: string, projectRoot: string | undefined): string {
  const normalized = path.replace(/\\/g, '/');
  if (projectRoot === undefined) return normalized;
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized === root) return '.';
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
}

/** Extract the prose text of one Pi message (text blocks concatenated; plain string as-is). */
function messageText(message: PiMessage): string {
  const parsed = PiMessageContentSchema.parse(message.content);
  if (typeof parsed === 'string') return parsed;
  return parsed
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && 'text' in block)
    .map((block) => block.text)
    .join('\n');
}

/** Pi message `timestamp` → ISO occurred_at, when present and usable; `undefined` keeps `now`. */
function messageOccurredAt(message: PiMessage): string | undefined {
  const value = message.timestamp;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value).toISOString();
  }
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(value)) {
    return value;
  }
  return undefined;
}

/** Build one event, converting validation failure into a counted drop (never a crash). */
function mint(
  kind: OnememoryEvent['kind'],
  payload: Record<string, unknown>,
  context: PiTranslateContext,
  occurredAt: string | undefined,
  dropped: DropCounter,
): OnememoryEvent | null {
  try {
    return buildEvent(
      kind,
      // The kind discriminator is required by the payload union; callers pass it in the object.
      { kind, ...payload } as Parameters<typeof buildEvent>[1],
      { ...context, ...(occurredAt === undefined ? {} : { occurredAt }) },
    );
  } catch (error) {
    if (error instanceof EventValidationError) {
      dropped.drop(`envelope_invalid:${kind}`);
      return null;
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Per-event translation
// ---------------------------------------------------------------------------

function translateSessionStart(
  reason: string,
  context: PiTranslateContext,
  dropped: DropCounter,
): OnememoryEvent[] {
  if (context.cwd === undefined) {
    dropped.drop('session_start_missing_cwd');
    return [];
  }
  const event = mint(
    'session.start',
    { cwd: context.cwd, summary: `pi session start (reason: ${reason})` },
    context,
    undefined,
    dropped,
  );
  return event === null ? [] : [event];
}

function translateSessionShutdown(
  reason: string,
  context: PiTranslateContext,
  dropped: DropCounter,
): OnememoryEvent[] {
  if (context.cwd === undefined) {
    dropped.drop('session_shutdown_missing_cwd');
    return [];
  }
  const event = mint(
    'session.end',
    { cwd: context.cwd, summary: `pi session end (reason: ${reason})` },
    context,
    undefined,
    dropped,
  );
  return event === null ? [] : [event];
}

function translateMessageEnd(
  message: PiMessage,
  context: PiTranslateContext,
  dropped: DropCounter,
): OnememoryEvent[] {
  const text = messageText(message).trim();
  const occurredAt = messageOccurredAt(message);

  if (message.role === 'user') {
    if (text.startsWith(PI_CONTEXT_INJECTION_PREFIX)) {
      dropped.drop('own_injection');
      return [];
    }
    if (text.length === 0) {
      dropped.drop('empty_user_message');
      return [];
    }
    const remembered = extractRememberUtterance(text);
    if (remembered !== null) {
      const event = mint(
        'explicit.remember',
        { content: clampText(remembered, REMEMBER_CONTENT_MAX) },
        context,
        occurredAt,
        dropped,
      );
      return event === null ? [] : [event];
    }
    const event = mint(
      'conversation.message',
      { role: 'user', content: clampText(text, MESSAGE_CONTENT_MAX) },
      context,
      occurredAt,
      dropped,
    );
    return event === null ? [] : [event];
  }

  if (message.role === 'assistant') {
    if (text.length === 0) {
      dropped.drop('empty_assistant_message');
      return [];
    }
    const event = mint(
      'conversation.message',
      { role: 'assistant', content: clampText(text, MESSAGE_CONTENT_MAX) },
      context,
      occurredAt,
      dropped,
    );
    return event === null ? [] : [event];
  }

  // system, toolResult, and app custom messages are not conversation prose.
  dropped.drop(`message_role_not_captured:${message.role}`);
  return [];
}

/** The text of a tool result's model-facing content (text blocks only, images are not prose). */
function toolResultText(event: PiToolResultEvent): string {
  return event.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text' && 'text' in block)
    .map((block) => block.text)
    .join('\n');
}

function translateToolResult(
  input: PiToolResultEvent,
  context: PiTranslateContext,
  dropped: DropCounter,
): OnememoryEvent[] {
  const events: OnememoryEvent[] = [];

  // Our own memory tools must never be captured as agent activity.
  if (input.toolName.startsWith('mcp__onememory__')) {
    dropped.drop('own_memory_tool');
    return events;
  }

  if (input.toolName === 'bash' || input.toolName === 'powershell') {
    const toolInput = PiBashToolInputSchema.safeParse(input.input);
    if (!toolInput.success) {
      dropped.drop(`missing_command:${input.toolName}`);
      return events;
    }
    const command = toolInput.data.command;
    const structured = PiBashToolOutputSchema.safeParse(input.structuredContent ?? {});
    const text = toolResultText(input);
    // bash.ts returns isError only when exit_code ≠ 0, so !isError proves exit 0; on error the
    // exit code is honest only when the structured output carried it.
    const exitCode = input.isError
      ? structured.success && structured.data.exit_code !== undefined
        ? structured.data.exit_code
        : null
      : structured.success && structured.data.exit_code !== undefined
        ? structured.data.exit_code
        : 0;
    const digest = clampDigest(
      structured.success && structured.data.output !== undefined ? structured.data.output : text,
      OUTPUT_DIGEST_MAX,
    );

    const terminal = mint(
      'terminal.output',
      {
        command,
        exit_code: exitCode,
        output_digest: digest,
        shell: input.toolName === 'bash' ? 'bash' : 'powershell',
      },
      context,
      undefined,
      dropped,
    );
    if (terminal !== null) events.push(terminal);

    if (input.isError) {
      const firstMeaningful =
        text.split('\n').find((line) => line.trim().length > 0) ?? 'command failed';
      const error = mint(
        'error.raised',
        {
          origin: 'terminal',
          message: clampText(firstMeaningful.trim(), ERROR_MESSAGE_MAX),
          context: clampText(command, CONTEXT_MAX),
        },
        context,
        undefined,
        dropped,
      );
      if (error !== null) events.push(error);
      return events;
    }

    // Commit-message capture: gated on the commit summary line + matching enrichment (git.ts).
    if (looksLikeGitCommit(command)) {
      const stdout = structured.success && structured.data.output !== undefined ? structured.data.output : text;
      const shortSha = commitShaFromStdout(stdout);
      if (shortSha === null) {
        // No [branch sha] summary line (e.g. `git commit -q`): the commit cannot be attributed.
        dropped.drop('git_commit_without_summary_output');
      } else if (
        context.gitCommitFacts === undefined ||
        context.gitCommitFacts === null ||
        'error' in context.gitCommitFacts
      ) {
        dropped.drop('git_commit_facts_unavailable');
      } else {
        const facts = context.gitCommitFacts;
        const commit = mint(
          'git.commit',
          {
            sha: facts.sha,
            message: clampText(facts.message, MESSAGE_CONTENT_MAX),
            author_name: facts.authorName,
            files: facts.files,
            ...(commitStatsFromStdout(stdout) === undefined
              ? {}
              : { stats: commitStatsFromStdout(stdout) }),
          },
          context,
          undefined,
          dropped,
        );
        if (commit !== null) events.push(commit);
      }
    }
    return events;
  }

  if (input.toolName === 'edit') {
    const toolInput = PiEditToolInputSchema.safeParse(input.input);
    if (!toolInput.success) {
      dropped.drop('edit_missing_path');
      return events;
    }
    // edits[].oldText/newText are literal replaced content — their line counts are exact deltas.
    const linesRemoved = toolInput.data.edits.reduce(
      (total, edit) => total + (edit.oldText === undefined ? 0 : lineCount(edit.oldText)),
      0,
    );
    const linesAdded = toolInput.data.edits.reduce(
      (total, edit) => total + (edit.newText === undefined ? 0 : lineCount(edit.newText)),
      0,
    );
    const event = mint(
      'file.changed',
      {
        path: relativizePath(toolInput.data.path, context.projectRoot ?? context.cwd),
        change: 'modified',
        lines_removed: linesRemoved,
        lines_added: linesAdded,
      },
      context,
      undefined,
      dropped,
    );
    if (event !== null) events.push(event);
    if (input.isError) {
      events.push(...translateToolFailureText(input, context, dropped));
    }
    return events;
  }

  if (input.toolName === 'write') {
    const toolInput = PiWriteToolInputSchema.safeParse(input.input);
    if (!toolInput.success) {
      dropped.drop('write_missing_path');
      return events;
    }
    // write.ts reports no create/overwrite distinction ("Successfully wrote to X", details:
    // undefined) — 'modified' is the honest claim and line deltas stay unset, never guessed.
    const event = mint(
      'file.changed',
      { path: relativizePath(toolInput.data.path, context.projectRoot ?? context.cwd), change: 'modified' },
      context,
      undefined,
      dropped,
    );
    if (event !== null) events.push(event);
    if (input.isError) {
      events.push(...translateToolFailureText(input, context, dropped));
    }
    return events;
  }

  if (input.isError) {
    events.push(...translateToolFailureText(input, context, dropped));
    return events;
  }

  dropped.drop(`unmapped_tool:${input.toolName}`);
  return events;
}

function translateToolFailureText(
  input: PiToolResultEvent,
  context: PiTranslateContext,
  dropped: DropCounter,
): OnememoryEvent[] {
  const text = toolResultText(input);
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? 'tool failed';
  const error = mint(
    'error.raised',
    {
      origin: 'tool',
      message: clampText(firstLine.trim(), ERROR_MESSAGE_MAX),
      context: clampText(input.toolName, CONTEXT_MAX),
    },
    context,
    undefined,
    dropped,
  );
  return error === null ? [] : [error];
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Translate one Pi extension event into validated events + counted drops. Pure: no clock reads, no
 * filesystem, no network — `context` carries every fact from outside (cwd, git enrichment, ids).
 */
export function translatePiEvent(rawEvent: unknown, context: PiTranslateContext = {}): PiTranslationResult {
  const dropped = new DropCounter();
  const parsed = PiCaptureEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    // An event outside the subscribed union (turn_*, tool_execution_*, context, …) is an honest
    // non-capture, not an error; a malformed payload of a subscribed event is counted distinctly.
    const type = typeof (rawEvent as { type?: unknown })?.type === 'string' ? (rawEvent as { type: string }).type : 'unknown';
    dropped.drop(
      PI_CAPTURE_EVENT_NAMES.includes(type as never) ? `wire_invalid:${type}` : `event_not_captured:${type}`,
    );
    return { events: [], dropped: dropped.records };
  }

  const event = parsed.data;
  switch (event.type) {
    case 'session_start':
      return { events: translateSessionStart(event.reason, context, dropped), dropped: dropped.records };
    case 'session_shutdown':
      return { events: translateSessionShutdown(event.reason, context, dropped), dropped: dropped.records };
    case 'before_agent_start':
      // The injection-only channel: the user prompt itself arrives via message_end.
      dropped.drop('before_agent_start_not_captured');
      return { events: [], dropped: dropped.records };
    case 'message_end':
      return { events: translateMessageEnd(event.message, context, dropped), dropped: dropped.records };
    case 'tool_result':
      return { events: translateToolResult(event, context, dropped), dropped: dropped.records };
  }
}
