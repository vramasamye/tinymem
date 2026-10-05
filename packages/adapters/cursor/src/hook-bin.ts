/**
 * The hook script's orchestration: stdin payload → target discovery → translation → daemon REST
 * delivery → (sessionStart) context injection → stderr diagnostics → exit 0.
 *
 * THE FAIL-SOFT CONTRACT: every failure path — unparseable stdin, unresolved project, dead daemon,
 * timeout, unreadable config — resolves to a skipped outcome with ONE machine-readable stderr
 * line, and the process exits 0. onememory never emits exit code 2 (Cursor's BLOCKING signal) and
 * never returns a permission decision: it observes, it does not gate.
 *
 * The `sessionStart` hook additionally emits the documented context-injection JSON on stdout
 * (`{"additional_context": "…"}`). Cursor runs `sessionStart` fire-and-forget — "the agent loop
 * does not wait for or enforce a blocking response" — so injection is best-effort by Cursor's own
 * design; the hook still bounds its own work (1500ms fetch + 1000ms delivery).
 *
 * I/O seams (`fetch`, output sinks, clock) are injectable so the full pipeline is testable without
 * a terminal; `bin.ts` is the thin process wiring.
 */

import { parseHookInput } from './hook-input';
import { translateHookInput, type TranslateContext } from './translate';
import {
  additionalContextOutput,
  capAdditionalContext,
  contextBudgetFromEnv,
  deliverEvents,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  emitDiag,
  fetchSessionContext,
  CONTEXT_FETCH_TIMEOUT_MS,
  resolveHookTarget,
  type DaemonTarget,
  type DiagSink,
} from './runtime';

export interface RunHookOptions {
  env?: Record<string, string | undefined>;
  now?: Date;
  /** Delivery timeout (default 1000ms). */
  deliveryTimeoutMs?: number;
  /** Context-fetch timeout (default 1500ms). */
  contextTimeoutMs?: number;
  fetch?: typeof fetch;
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
  /** True when a sessionStart context string was written to stdout. */
  contextInjected: boolean;
}

const stderrSink: DiagSink = { write: (text) => process.stderr.write(text) };
const stdoutSink: DiagSink = { write: (text) => process.stdout.write(text) };

/** One hook invocation. `rawInput` is the decoded stdin JSON; never throws. */
export async function runHook(rawInput: unknown, options: RunHookOptions = {}): Promise<HookRunResult> {
  const env = options.env ?? (process.env as Record<string, string | undefined>);
  const stderr = options.stderr ?? stderrSink;
  const stdout = options.stdout ?? stdoutSink;
  const now = options.now ?? new Date();

  const parsed = parseHookInput(rawInput);
  if (!parsed.ok) {
    emitDiag({ outcome: 'skipped', reason: parsed.reason }, stderr);
    return skipped(parsed.reason);
  }
  const input = parsed.value;
  const event = input.hook_event_name;
  const workspaceRoot = input.workspace_roots?.find((value) => value.length > 0);

  const target = resolveHookTarget({
    ...(workspaceRoot === undefined ? {} : { inputCwd: workspaceRoot }),
    env,
  });

  const context: TranslateContext = {
    now,
    projectId: target.projectId,
    projectRoot: workspaceRoot ?? target.configDir ?? null,
  };
  const translation = translateHookInput(rawInput, context);
  const dropSummary = translation.drops.map((drop) => `${drop.reason}×${drop.count}`);

  // --- sessionStart: best-effort context injection (Cursor's documented output contract) ----
  let contextInjected = false;
  let contextUsed: number | null = null;
  let contextNote: string | undefined;
  if (event === 'sessionStart') {
    const deliveryTarget = daemonTarget(target);
    if (deliveryTarget === null) {
      contextNote = target.projectId === null ? 'unresolved_project' : 'no_daemon';
    } else {
      const fetched = await fetchSessionContext(deliveryTarget, contextBudgetFromEnv(env), {
        timeoutMs: options.contextTimeoutMs ?? CONTEXT_FETCH_TIMEOUT_MS,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });
      if (!fetched.ok || fetched.context === undefined) {
        contextNote = `context_fetch_failed:${fetched.error ?? 'unknown'}`;
      } else if (fetched.context.text.trim().length === 0) {
        contextNote = 'context_empty';
      } else {
        const capped = capAdditionalContext(fetched.context.text);
        stdout.write(`${additionalContextOutput(capped.text)}\n`);
        contextInjected = true;
        contextUsed = fetched.context.used;
        if (capped.capped) contextNote = 'context_capped';
      }
    }
  }

  // --- delivery -------------------------------------------------------------------------------
  if (translation.events.length === 0) {
    emitDiag(
      {
        event,
        outcome: 'no_events',
        ...(dropSummary.length === 0 ? {} : { drops: dropSummary }),
        ...(contextNote === undefined ? {} : { context: contextNote }),
      },
      stderr,
    );
    return { ...skipped('no_events'), outcome: 'no_events', contextInjected };
  }

  const deliveryTarget = daemonTarget(target);
  if (deliveryTarget === null) {
    const reason = target.projectId === null ? 'unresolved_project' : 'no_daemon';
    emitDiag(
      {
        event,
        outcome: 'skipped',
        reason,
        events: translation.events.length,
        ...(dropSummary.length === 0 ? {} : { drops: dropSummary }),
        ...(contextNote === undefined ? {} : { context: contextNote }),
      },
      stderr,
    );
    return { ...skipped(reason), deliveredEvents: translation.events.length, contextInjected };
  }

  const delivered = await deliverEvents(deliveryTarget, translation.events, {
    timeoutMs: options.deliveryTimeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  emitDiag(
    {
      event,
      outcome: delivered.delivered ? 'delivered' : 'failed',
      ...(delivered.error === undefined ? {} : { reason: delivered.error }),
      events: translation.events.length,
      stored: delivered.stored,
      duplicates: delivered.duplicates,
      excluded: delivered.excluded,
      dead_lettered: delivered.deadLettered,
      ...(dropSummary.length === 0 ? {} : { drops: dropSummary }),
      ...(contextNote === undefined ? {} : { context: contextNote }),
      ...(contextUsed === null ? {} : { context_tokens: contextUsed }),
    },
    stderr,
  );

  return {
    exitCode: 0,
    outcome: delivered.delivered ? 'delivered' : 'failed',
    ...(delivered.error === undefined ? {} : { reason: delivered.error }),
    stored: delivered.stored,
    duplicates: delivered.duplicates,
    excluded: delivered.excluded,
    deadLettered: delivered.deadLettered,
    deliveredEvents: translation.events.length,
    contextInjected,
  };
}

function daemonTarget(target: ReturnType<typeof resolveHookTarget>): DaemonTarget | null {
  if (target.daemonUrl === null || target.projectId === null) return null;
  return { url: target.daemonUrl, projectId: target.projectId };
}

function skipped(reason: string): HookRunResult {
  return {
    exitCode: 0,
    outcome: 'skipped',
    reason,
    stored: 0,
    duplicates: 0,
    excluded: 0,
    deadLettered: 0,
    deliveredEvents: 0,
    contextInjected: false,
  };
}
