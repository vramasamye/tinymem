/**
 * Hook payload → OnememoryEvent translation (pure, no I/O).
 *
 * THE CONTRACT (mission-6 + ADR-0010 §6): adapters are translators — runtime-native hook payloads
 * become validated OnememoryEvent envelopes (runtime: 'claude-code') delivered through public
 * surfaces. Every event returned by `translateHookInput` has passed
 * `validateOnememoryEvent`; a payload that cannot be mapped honestly is dropped with a COUNTED
 * reason, never coerced. The extractor (mission 3) recognizes exactly these families — command
 * execution (`terminal.output`), edited files (`file.changed`), error/resolution pairs
 * (`error.raised` + exit-code-carrying `terminal.output`), commit messages (`git.commit`), and
 * explicit user intent (`explicit.remember`) — so each mapping below targets one of them.
 *
 * Mapping table (hook → event, with the documented trigger for each):
 * - SessionStart (source startup|resume|clear|fork) → session.start
 *   source compact is context compaction, not a session start — dropped with a counted reason
 *   (context injection still happens; the hook script handles that separately).
 * - SessionEnd (any reason)                          → session.end
 * - PostToolUse Bash/PowerShell                       → terminal.output (exit_code 0: this hook only
 *   fires after a tool COMPLETES SUCCESSFULLY — non-zero exits fire PostToolUseFailure)
 * - PostToolUse Bash git commit                       → git.commit (enrichment-gated, see git.ts)
 * - PostToolUse Edit/Write/NotebookEdit               → file.changed
 * - PostToolUseFailure Bash/PowerShell                → terminal.output (parsed "Exit code N")
 *                                                       + error.raised (origin 'terminal')
 * - PostToolUseFailure any other tool                 → error.raised (origin 'tool')
 * - Stop                                              → conversation.message (user + assistant
 *   transcript deltas; the final assistant text arrives via the documented
 *   `last_assistant_message` field) + explicit.remember for imperative remember utterances
 */

import {
  eventContentHash,
  uuidv7,
  validateOnememoryEvent,
  type OnememoryEvent,
} from '@onememory/core';

import {
  BashToolInputSchema,
  BashToolResponseSchema,
  COMMAND_TOOLS,
  EditToolInputSchema,
  FILE_EDIT_TOOLS,
  NotebookEditToolInputSchema,
  parseHookInput,
  WriteToolInputSchema,
  WriteToolResponseSchema,
  type HookInput,
} from './hook-input';
import { commitShaFromStdout, commitStatsFromStdout, looksLikeGitCommit, type GitCommitFacts } from './git';
import { extractRememberUtterance } from './remember';
import type { TranscriptTextEntry } from './transcript';
import { ADAPTER_VERSION } from './version';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Facts the hook script gathers around the payload (clock, scope, enrichment — all injectable). */
export interface TranslateContext {
  /** Event/ingest clock (single instant for the whole batch; default `new Date()`). */
  now?: Date;
  /** Project scope; `null` (the default) leaves the event unscoped. */
  projectId?: string | null;
  /** `scope.agent_id` (default 'claude-code'). */
  agentId?: string;
  /** `source.adapter_version` (default ADAPTER_VERSION). */
  adapterVersion?: string;
  /** Project root for relativizing file paths (`/root/sub/file` → `sub/file`); null keeps paths as-is. */
  projectRoot?: string | null;
  /** git commit facts for the current HEAD (PostToolUse Bash enrichment); see git.ts. */
  gitCommitFacts?: GitCommitFacts | { error: string } | null;
  /** Pre-parsed transcript text entries (Stop); see transcript.ts. */
  transcriptEntries?: readonly TranscriptTextEntry[] | null;
}

/** A counted drop: stable reason code, how many payloads hit it, optional bounded detail. */
export interface TranslationDrop {
  reason: string;
  count: number;
  /** First occurrence's diagnostic (schema issue text or failure detail — never payload contents). */
  detail?: string;
}

export interface TranslationResult {
  /** Validated envelopes, ready to POST to `/v1/projects/{id}/events`. */
  events: OnememoryEvent[];
  /** Counted drops in encounter order. */
  drops: TranslationDrop[];
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

class DropTally {
  private readonly reasons = new Map<string, TranslationDrop>();

  count(reason: string, detail?: string): void {
    const existing = this.reasons.get(reason);
    if (existing === undefined) {
      this.reasons.set(reason, { reason, count: 1, ...(detail === undefined ? {} : { detail: detail.slice(0, 300) }) });
      return;
    }
    existing.count += 1;
  }

  get isEmpty(): boolean {
    return this.reasons.size === 0;
  }

  toArray(): TranslationDrop[] {
    return [...this.reasons.values()];
  }
}

/** Schema maxes (packages/core event schemas) the adapter clamps into. */
const OUTPUT_DIGEST_MAX = 2000;
const ERROR_MESSAGE_MAX = 2000;
const CONTEXT_MAX = 500;
const MESSAGE_CONTENT_MAX = 20_000;
const REMEMBER_CONTENT_MAX = 2000;

const clampText = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.split('\n').length;
}

/**
 * Normalize a path for `file.changed`: forward slashes, project-relative when it sits under the
 * project root (matching the exclusion-policy and fixture path shapes — e.g. `config/.env`), and
 * untouched when it is outside the root (the policy still judges it; the daemon re-checks too).
 */
function relativizePath(path: string, projectRoot: string | null): string {
  const normalized = path.replace(/\\/g, '/');
  if (projectRoot === null) return normalized;
  const root = projectRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  if (normalized === root) return '.';
  if (normalized.startsWith(`${root}/`)) return normalized.slice(root.length + 1);
  return normalized;
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
  options: {
    mint: MintOptions;
    sessionId: string | undefined;
    occurredAt?: string;
    tally: DropTally;
  },
): OnememoryEvent | null {
  const { mint, sessionId, tally } = options;
  const occurredAt = options.occurredAt !== undefined && isValidIso(options.occurredAt) ? options.occurredAt : mint.nowIso;
  const candidate = {
    id: uuidv7(mint.now.getTime()),
    kind: payload.kind as string,
    occurred_at: occurredAt,
    ingested_at: mint.nowIso,
    source: { runtime: 'claude-code' as const, adapter_version: mint.adapterVersion },
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

/**
 * Bash/PowerShell failure text: the documented first line `Exit code N` (when the command ran and
 * exited) plus the interleaved output block. `Exit code N` IS the documented, stable part.
 */
function parseCommandFailure(error: string): { exitCode: number | null; message: string; output: string } {
  const lines = error.split('\n');
  const first = (lines[0] ?? '').trim();
  const exitMatch = /^Exit code (\d+)$/.exec(first);
  const exitCode = exitMatch === null ? null : Number(exitMatch[1]);
  const rest = exitMatch === null ? lines : lines.slice(1);
  const firstMeaningful = rest.find((line) => line.trim().length > 0);
  const message = (firstMeaningful === undefined || firstMeaningful.trim().length === 0 ? first : firstMeaningful.trim()) || 'command failed';
  return {
    exitCode,
    message: clampText(message, ERROR_MESSAGE_MAX),
    output: clampText(rest.join('\n'), OUTPUT_DIGEST_MAX),
  };
}

function outputDigest(response: { stdout?: string; stderr?: string }): string {
  const stdout = response.stdout ?? '';
  const stderr = response.stderr ?? '';
  const text = stdout.length > 0 ? stdout : stderr;
  return clampText(text, OUTPUT_DIGEST_MAX);
}

// ---------------------------------------------------------------------------
// Per-event translation
// ---------------------------------------------------------------------------

function translateSessionStart(input: Extract<HookInput, { hook_event_name: 'SessionStart' }>, ctx: TranslateContext, tally: DropTally, mint: MintOptions): OnememoryEvent[] {
  if (input.cwd === undefined) {
    tally.count('session_start_missing_cwd');
    return [];
  }
  if (input.source === 'compact') {
    // Compaction replaces in-window history mid-session; it is not a session lifecycle boundary.
    tally.count('session_start_compact');
    return [];
  }
  const payload = {
    kind: 'session.start' as const,
    started_at: mint.nowIso,
    cwd: input.cwd,
    summary: `claude-code session start (source: ${input.source})`,
  };
  const event = mintEvent(payload, { mint, sessionId: input.session_id, tally });
  return event === null ? [] : [event];
}

function translateSessionEnd(input: Extract<HookInput, { hook_event_name: 'SessionEnd' }>, ctx: TranslateContext, tally: DropTally, mint: MintOptions): OnememoryEvent[] {
  if (input.cwd === undefined) {
    tally.count('session_end_missing_cwd');
    return [];
  }
  const payload = {
    kind: 'session.end' as const,
    ended_at: mint.nowIso,
    cwd: input.cwd,
    summary: `claude-code session end (reason: ${input.reason})`,
  };
  const event = mintEvent(payload, { mint, sessionId: input.session_id, tally });
  return event === null ? [] : [event];
}

/**
 * PostToolUse: command executions, commit messages, and file edits. `tool_input`/`tool_response`
 * are re-validated per tool — an unusable shape is a counted drop, and the OTHER mappings that
 * don't depend on it still proceed.
 */
function translatePostToolUse(
  input: Extract<HookInput, { hook_event_name: 'PostToolUse' }>,
  ctx: TranslateContext,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  const events: OnememoryEvent[] = [];
  const projectRoot = ctx.projectRoot ?? null;

  if ((COMMAND_TOOLS as readonly string[]).includes(input.tool_name)) {
    const toolInput = BashToolInputSchema.safeParse(input.tool_input);
    if (!toolInput.success) {
      tally.count(`missing_command:${input.tool_name}`);
      return events;
    }
    // Background commands: the immediate response reports task start, not command output — the
    // output is not in the payload, so a terminal.output event would misattribute it.
    if (toolInput.data.run_in_background === true) {
      tally.count('background_command');
      return events;
    }
    const toolResponse = BashToolResponseSchema.safeParse(input.tool_response);
    if (!toolResponse.success || toolResponse.data.interrupted === true) {
      tally.count('interrupted_command');
      return events;
    }

    // Command execution (exit_code 0 — PostToolUse fires only after a successful completion).
    const terminal = mintEvent(
      {
        kind: 'terminal.output',
        command: toolInput.data.command,
        exit_code: 0,
        output_digest: outputDigest(toolResponse.data),
        shell: input.tool_name === 'Bash' ? 'bash' : 'powershell',
      },
      { mint, sessionId: input.session_id, tally },
    );
    if (terminal !== null) events.push(terminal);

    // Commit-message capture: gated on the commit summary line + matching enrichment (git.ts).
    if (looksLikeGitCommit(toolInput.data.command)) {
      const stdout = toolResponse.data.stdout ?? '';
      const shortSha = commitShaFromStdout(stdout);
      if (shortSha === null) {
        tally.count('git_commit_without_summary_output', 'git commit produced no [branch sha] summary line (e.g. -q)');
      } else if (ctx.gitCommitFacts === undefined || ctx.gitCommitFacts === null || 'error' in ctx.gitCommitFacts) {
        const detail = ctx.gitCommitFacts !== undefined && ctx.gitCommitFacts !== null && 'error' in ctx.gitCommitFacts ? ctx.gitCommitFacts.error : 'no enrichment provided';
        tally.count('git_commit_facts_unavailable', detail);
      } else {
        const facts = ctx.gitCommitFacts;
        const commit = mintEvent(
          {
            kind: 'git.commit',
            sha: facts.sha,
            message: clampText(facts.message, MESSAGE_CONTENT_MAX),
            author_name: facts.authorName,
            files: facts.files,
            ...(commitStatsFromStdout(stdout) === undefined ? {} : { stats: commitStatsFromStdout(stdout) }),
          },
          { mint, sessionId: input.session_id, tally },
        );
        if (commit !== null) events.push(commit);
      }
    }
    return events;
  }

  if ((FILE_EDIT_TOOLS as readonly string[]).includes(input.tool_name)) {
    return translateFileEdit(input, projectRoot, tally, mint);
  }

  tally.count(`unmapped_tool:${input.tool_name}`);
  return events;
}

function translateFileEdit(
  input: Extract<HookInput, { hook_event_name: 'PostToolUse' }>,
  projectRoot: string | null,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  if (input.tool_name === 'Edit') {
    const toolInput = EditToolInputSchema.safeParse(input.tool_input);
    if (!toolInput.success) {
      tally.count('edit_missing_file_path');
      return [];
    }
    // old_string/new_string are the literally replaced content — their line counts are exact deltas.
    const oldLines = toolInput.data.old_string === undefined ? undefined : lineCount(toolInput.data.old_string);
    const newLines = toolInput.data.new_string === undefined ? undefined : lineCount(toolInput.data.new_string);
    const event = mintEvent(
      {
        kind: 'file.changed',
        path: relativizePath(toolInput.data.file_path, projectRoot),
        change: 'modified',
        ...(oldLines === undefined ? {} : { lines_removed: oldLines }),
        ...(newLines === undefined ? {} : { lines_added: newLines }),
      },
      { mint, sessionId: input.session_id, tally },
    );
    return event === null ? [] : [event];
  }

  if (input.tool_name === 'Write') {
    const toolInput = WriteToolInputSchema.safeParse(input.tool_input);
    if (!toolInput.success) {
      tally.count('write_missing_file_path');
      return [];
    }
    const toolResponse = WriteToolResponseSchema.safeParse(input.tool_response);
    // Documented: Write of a new file responds `{filePath, type: "create"}`. Only a create can
    // honestly claim lines_added (the content IS the whole new file); an overwrite's delta is
    // unknown and stays unset.
    const created = toolResponse.success && toolResponse.data.type === 'create';
    const event = mintEvent(
      {
        kind: 'file.changed',
        path: relativizePath(toolInput.data.file_path, projectRoot),
        change: created ? 'created' : 'modified',
        ...(created && toolInput.data.content !== undefined ? { lines_added: lineCount(toolInput.data.content) } : {}),
      },
      { mint, sessionId: input.session_id, tally },
    );
    return event === null ? [] : [event];
  }

  // NotebookEdit (cell-level). The path field is not named in the hooks reference — both
  // well-known spellings are accepted; neither exists → counted drop (never guessed).
  const toolInput = NotebookEditToolInputSchema.safeParse(input.tool_input);
  if (!toolInput.success) {
    tally.count('notebook_edit_missing_path');
    return [];
  }
  const path = toolInput.data.notebook_path ?? toolInput.data.file_path ?? '';
  const event = mintEvent(
    {
      kind: 'file.changed',
      path: relativizePath(path, projectRoot),
      change: 'modified',
    },
    { mint, sessionId: input.session_id, tally },
  );
  return event === null ? [] : [event];
}

function translatePostToolUseFailure(
  input: Extract<HookInput, { hook_event_name: 'PostToolUseFailure' }>,
  ctx: TranslateContext,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  if (input.is_interrupt === true) {
    // An abort is not an error the project should remember.
    tally.count('interrupted_failure');
    return [];
  }
  const events: OnememoryEvent[] = [];

  if ((COMMAND_TOOLS as readonly string[]).includes(input.tool_name)) {
    const toolInput = BashToolInputSchema.safeParse(input.tool_input);
    const command = toolInput.success ? toolInput.data.command : null;
    if (command === null) tally.count(`missing_command:${input.tool_name}`);
    const failure = parseCommandFailure(input.error);

    if (command !== null) {
      // The failed command itself, with the parsed exit code — the extractor pairs this with the
      // later successful re-run to mint a resolved-failure memory.
      const terminal = mintEvent(
        {
          kind: 'terminal.output',
          command,
          exit_code: failure.exitCode,
          output_digest: failure.output,
          shell: input.tool_name === 'Bash' ? 'bash' : 'powershell',
        },
        { mint, sessionId: input.session_id, tally },
      );
      if (terminal !== null) events.push(terminal);
    }

    const error = mintEvent(
      {
        kind: 'error.raised',
        origin: 'terminal',
        message: failure.message,
        ...(command === null ? {} : { context: clampText(command, CONTEXT_MAX) }),
      },
      { mint, sessionId: input.session_id, tally },
    );
    if (error !== null) events.push(error);
    return events;
  }

  // Any other tool failure (Read, WebFetch, mcp__*, …) — a real error with a real message.
  const firstLine = input.error.split('\n').find((line) => line.trim().length > 0) ?? 'tool failed';
  const error = mintEvent(
    {
      kind: 'error.raised',
      origin: 'tool',
      message: clampText(firstLine.trim(), ERROR_MESSAGE_MAX),
      context: clampText(input.tool_name, CONTEXT_MAX),
    },
    { mint, sessionId: input.session_id, tally },
  );
  if (error !== null) events.push(error);
  return events;
}

/**
 * Stop: transcript deltas. The final assistant text comes from the DOCUMENTED
 * `last_assistant_message` field (the sessions reference warns the file is written asynchronously
 * and may lag the current turn); user/assistant deltas come from the pre-parsed entries the hook
 * script read. An imperative remember utterance becomes an explicit.remember event instead of a
 * conversation.message (one utterance, one authoritative capture — see remember.ts).
 */
function translateStop(
  input: Extract<HookInput, { hook_event_name: 'Stop' }>,
  ctx: TranslateContext,
  tally: DropTally,
  mint: MintOptions,
): OnememoryEvent[] {
  const events: OnememoryEvent[] = [];
  const lastAssistant = input.last_assistant_message !== undefined ? input.last_assistant_message.trim() : '';
  const entries = ctx.transcriptEntries ?? [];

  for (const entry of entries) {
    if (entry.role === 'user') {
      const remembered = extractRememberUtterance(entry.text);
      const event =
        remembered === null
          ? mintEvent(
              { kind: 'conversation.message', role: 'user', content: clampText(entry.text, MESSAGE_CONTENT_MAX) },
              { mint, sessionId: input.session_id, occurredAt: entry.timestamp, tally },
            )
          : mintEvent(
              { kind: 'explicit.remember', content: clampText(remembered, REMEMBER_CONTENT_MAX) },
              { mint, sessionId: input.session_id, occurredAt: entry.timestamp, tally },
            );
      if (event !== null) events.push(event);
      continue;
    }
    const isLast = entry.text.trim() === lastAssistant;
    if (isLast && lastAssistant.length > 0) {
      // Delivered via the last_assistant_message mapping below — count, don't duplicate.
      tally.count('stop_deduped_last_message');
      continue;
    }
    const event = mintEvent(
      { kind: 'conversation.message', role: 'assistant', content: clampText(entry.text, MESSAGE_CONTENT_MAX) },
      { mint, sessionId: input.session_id, occurredAt: entry.timestamp, tally },
    );
    if (event !== null) events.push(event);
  }

  if (lastAssistant.length > 0) {
    const event = mintEvent(
      { kind: 'conversation.message', role: 'assistant', content: clampText(lastAssistant, MESSAGE_CONTENT_MAX) },
      { mint, sessionId: input.session_id, tally },
    );
    if (event !== null) events.push(event);
  }
  return events;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Translate one hook payload into validated events + counted drops. Pure: no clock reads, no
 * filesystem, no network — `context` carries every fact from outside.
 */
export function translateHookInput(rawInput: unknown, context: TranslateContext = {}): TranslationResult {
  const tally = new DropTally();
  const now = context.now ?? new Date();
  const mint: MintOptions = {
    now,
    nowIso: now.toISOString(),
    projectId: context.projectId ?? null,
    agentId: context.agentId ?? 'claude-code',
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
    case 'SessionStart':
      events = translateSessionStart(input, context, tally, mint);
      break;
    case 'SessionEnd':
      events = translateSessionEnd(input, context, tally, mint);
      break;
    case 'PostToolUse':
      events = translatePostToolUse(input, context, tally, mint);
      break;
    case 'PostToolUseFailure':
      events = translatePostToolUseFailure(input, context, tally, mint);
      break;
    case 'Stop':
      events = translateStop(input, context, tally, mint);
      break;
  }
  return { events, drops: tally.toArray() };
}
