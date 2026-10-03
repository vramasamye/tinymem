/**
 * The hook script's orchestration: stdin payload → target discovery → (enrichment) → translation
 * → daemon REST delivery → stderr diagnostics → exit 0.
 *
 * THE FAIL-SOFT CONTRACT (mission-6; AGENTS.md "hooks must NEVER block or fail the agent"):
 * every failure path — unparseable stdin, unresolved project, dead daemon, timeout, git missing,
 * unreadable transcript — resolves to a skipped outcome with ONE machine-readable stderr line, and
 * the process exits 0. Exit 2 is Claude Code's BLOCKING signal; onememory never emits it.
 *
 * I/O seams (`fetch`, `git runner`, transcript/state readers, output sinks) are all injectable so
 * the full pipeline is testable without a terminal; `bin.ts` is the thin process wiring.
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

import {
  additionalContextOutput,
  capAdditionalContext,
  contextBudgetFromEnv,
  fetchSessionContext,
} from './context';
import { commitShaFromStdout, looksLikeGitCommit, readGitCommitFacts, type GitRunner } from './git';
import { emitDiag, type DiagSink } from './diag';
import { resolveHookTarget, readHookState, writeHookState, type HookState } from './discovery';
import { deliverEvents, DEFAULT_DELIVERY_TIMEOUT_MS, type DaemonTarget } from './deliver';
import { BashToolInputSchema, BashToolResponseSchema, parseHookInput } from './hook-input';
import { parseTranscript, selectTranscriptDelta } from './transcript';
import { translateHookInput, type TranslateContext } from './translate';

export interface RunHookOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
  /** Delivery timeout (default 1000ms). */
  deliveryTimeoutMs?: number;
  fetch?: typeof fetch;
  gitRunner?: GitRunner;
  /** Read the transcript file (default: node:fs readFileSync). */
  readTranscript?: (path: string) => string | null;
  /** Output sinks (default: process.stderr / process.stdout). */
  stderr?: DiagSink;
  stdout?: DiagSink;
}

export interface HookRunResult {
  /** Always 0 — a hook never blocks or fails the agent. */
  exitCode: 0;
  outcome: 'delivered' | 'skipped' | 'failed' | 'no_events';
  reason?: string;
  stored: number;
  duplicates: number;
  excluded: number;
  deadLettered: number;
  deliveredEvents: number;
}

const stderrSink: DiagSink = { write: (text) => process.stderr.write(text) };
const stdoutSink: DiagSink = { write: (text) => process.stdout.write(text) };

function defaultReadTranscript(path: string): string | null {
  try {
    // Bounded read: transcripts are append-only JSONL; a run-away file must not OOM the hook.
    if (statSync(path).size > 32 * 1024 * 1024) return null;
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** One hook invocation. `rawInput` is the decoded stdin JSON; never throws. */
export async function runHook(rawInput: unknown, options: RunHookOptions = {}): Promise<HookRunResult> {
  const stderr = options.stderr ?? stderrSink;
  const stdout = options.stdout ?? stdoutSink;
  const env = options.env ?? process.env;
  const now = options.now ?? new Date();

  try {
    return await runHookInner(rawInput, options, { env, now, stderr, stdout });
  } catch (error) {
    // Truly unexpected: still exit 0, with the one-line diagnostic (no payload contents).
    emitDiag({ outcome: 'failed', reason: 'internal_error', detail: error instanceof Error ? error.message : String(error) }, stderr);
    return { exitCode: 0, outcome: 'failed', reason: 'internal_error', stored: 0, duplicates: 0, excluded: 0, deadLettered: 0, deliveredEvents: 0 };
  }
}

interface RunContext {
  env: Record<string, string | undefined>;
  now: Date;
  stderr: DiagSink;
  stdout: DiagSink;
}

async function runHookInner(rawInput: unknown, options: RunHookOptions, run: RunContext): Promise<HookRunResult> {
  const { env, now, stderr, stdout } = run;

  const parsed = parseHookInput(rawInput);
  if (!parsed.ok) {
    emitDiag({ outcome: 'skipped', reason: parsed.reason }, stderr);
    return skipped(parsed.reason);
  }
  const input = parsed.value;

  // --- target discovery -------------------------------------------------------------
  const target = resolveHookTarget({ inputCwd: input.cwd, env });
  if (target.projectId === null || target.daemonUrl === null) {
    const reason =
      target.projectId === null
        ? 'no_project: run onemem init (or set ONEMEMORY_PROJECT_ID)'
        : 'no_daemon: start one with onemem serve (or set ONEMEMORY_DAEMON_URL)';
    emitDiag({ event: input.hook_event_name, outcome: 'skipped', reason }, stderr);
    return skipped(reason);
  }
  const daemon: DaemonTarget = { url: target.daemonUrl, projectId: target.projectId };

  // --- SessionStart: inject context FIRST (the user-visible part), events second -------
  if (input.hook_event_name === 'SessionStart') {
    const budget = contextBudgetFromEnv(env);
    const fetched = await fetchSessionContext(daemon, budget, { fetch: options.fetch, timeoutMs: 1500 });
    if (fetched.ok && fetched.context !== undefined && fetched.context.text.trim().length > 0) {
      const { text, capped } = capAdditionalContext(fetched.context.text);
      stdout.write(`${additionalContextOutput(text)}\n`);
      if (capped) {
        emitDiag({ event: input.hook_event_name, outcome: 'delivered', reason: 'context_capped_at_10000' }, stderr);
      }
    } else if (!fetched.ok) {
      emitDiag({ event: input.hook_event_name, outcome: 'skipped', reason: `context_unavailable: ${fetched.error}` }, stderr);
    }
  }

  // --- event-specific enrichment ------------------------------------------------------
  const translateContext: TranslateContext = {
    now,
    projectId: target.projectId,
    projectRoot: target.configDir === null ? null : dirname(target.configDir),
  };

  if (input.hook_event_name === 'PostToolUse' && (input.tool_name === 'Bash' || input.tool_name === 'PowerShell')) {
    const toolInput = BashToolInputSchema.safeParse(input.tool_input);
    const toolResponse = BashToolResponseSchema.safeParse(input.tool_response);
    if (toolInput.success && looksLikeGitCommit(toolInput.data.command)) {
      const stdoutText = toolResponse.success ? (toolResponse.data.stdout ?? '') : '';
      const shortSha = commitShaFromStdout(stdoutText);
      if (shortSha !== null) {
        const gitCwd = input.cwd ?? env.CLAUDE_PROJECT_DIR ?? process.cwd();
        const facts = await readGitCommitFacts(gitCwd, { runner: options.gitRunner, shortSha });
        translateContext.gitCommitFacts = facts;
      }
    }
  }

  let deltaCursor: { sessionId: string; nextCursor: string | null } | null = null;
  if (input.hook_event_name === 'Stop' && input.transcript_path !== undefined && target.configDir !== null) {
    const readTranscript = options.readTranscript ?? defaultReadTranscript;
    const text = readTranscript(input.transcript_path);
    if (text === null) {
      emitDiag({ event: input.hook_event_name, outcome: 'skipped', reason: 'transcript_unreadable' }, stderr);
      translateContext.transcriptEntries = [];
    } else {
      const parsedTranscript = parseTranscript(text);
      const state: HookState = readHookState(target.configDir);
      const sessionId = input.session_id ?? '(no-session)';
      const cursor = state.sessions[sessionId]?.last_transcript_uuid ?? null;
      const delta = selectTranscriptDelta(parsedTranscript.entries, cursor);
      translateContext.transcriptEntries = delta.deliver;
      if (delta.rescanned) {
        emitDiag({ event: input.hook_event_name, outcome: 'skipped', reason: 'transcript_cursor_lost: rescanning (duplicates are deduped by the daemon)' }, stderr);
      }
      deltaCursor = { sessionId, nextCursor: delta.nextCursor };
      for (const drop of parsedTranscript.drops) {
        emitDiag({ event: input.hook_event_name, outcome: 'skipped', reason: drop.reason, count: drop.count }, stderr);
      }
    }
  }

  // --- translate + deliver --------------------------------------------------------------
  const { events, drops } = translateHookInput(input, translateContext);
  for (const drop of drops) {
    emitDiag({ event: input.hook_event_name, outcome: 'skipped', reason: drop.reason, count: drop.count }, stderr);
  }

  if (events.length === 0) {
    emitDiag({ event: input.hook_event_name, outcome: 'no_events' }, stderr);
    return { exitCode: 0, outcome: 'no_events', stored: 0, duplicates: 0, excluded: 0, deadLettered: 0, deliveredEvents: 0 };
  }

  const delivery = await deliverEvents(daemon, events, {
    fetch: options.fetch,
    timeoutMs: options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
  });

  if (!delivery.delivered) {
    emitDiag({ event: input.hook_event_name, outcome: 'failed', reason: delivery.error ?? 'delivery failed' }, stderr);
    return { exitCode: 0, outcome: 'failed', reason: delivery.error, stored: 0, duplicates: 0, excluded: 0, deadLettered: 0, deliveredEvents: events.length };
  }

  // Advance the transcript cursor ONLY after a successful delivery (a failed one retries next Stop).
  if (deltaCursor !== null && target.configDir !== null) {
    const state = readHookState(target.configDir);
    state.sessions[deltaCursor.sessionId] = { last_transcript_uuid: deltaCursor.nextCursor };
    writeHookState(target.configDir, state);
  }

  emitDiag(
    {
      event: input.hook_event_name,
      outcome: 'delivered',
      events: events.length,
      stored: delivery.stored,
      duplicates: delivery.duplicates,
      excluded: delivery.excluded,
      dead_lettered: delivery.deadLettered,
    },
    stderr,
  );
  return {
    exitCode: 0,
    outcome: 'delivered',
    stored: delivery.stored,
    duplicates: delivery.duplicates,
    excluded: delivery.excluded,
    deadLettered: delivery.deadLettered,
    deliveredEvents: events.length,
  };
}

function skipped(reason: string): HookRunResult {
  return { exitCode: 0, outcome: 'skipped', reason, stored: 0, duplicates: 0, excluded: 0, deadLettered: 0, deliveredEvents: 0 };
}
