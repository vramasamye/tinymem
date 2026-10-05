/**
 * The Pi extension entry point: `createPiExtension(pi)` registers the lifecycle handlers that
 * capture agent activity and inject session context, and is everything the scaffolded
 * `.pi/extensions/onememory.ts` shim needs (the shim imports this package — Pi loads local
 * TypeScript extensions via jiti, so no build step is involved).
 *
 * The types below are STRUCTURAL mirrors of the exact subset of Pi's documented `ExtensionAPI` /
 * `ExtensionContext` this adapter uses (https://pi.dev/docs/latest/extensions):
 * - `pi.on(event, handler)` — "returns a function that unsubscribes that registration"; handlers
 *   run in registration order and are awaited, so all capture work is hard-bounded by the
 *   delivery timeouts (2.5s ingest / 2s context) and never blocks a session beyond that.
 * - `pi.sendUserMessage(content, { deliverAs: "steer" })` — steering messages are "added to the
 *   context before the next LLM call", which is where the session context belongs: injected at
 *   `before_agent_start` (once per session), it rides the same agent run as the user's prompt.
 * - `ctx.sessionManager.getSessionId()` — the session id Pi itself exposes to tools via the
 *   `PI_SESSION_ID` environment variable (verified in `tools/bash.ts`).
 * - `ctx.cwd` — the working directory (session events need it; `session_start` carries no cwd).
 *
 * No dependency on `@earendil-works/pi-coding-agent` is declared: the adapter must work without
 * Pi installed (scaffold tests, conformance runs) and version against the DOCUMENTED surface only.
 */

import { capturePiEvent, buildSessionInjection, deliveryDiagnostic } from './capture';
import { looksLikeGitCommit, readGitCommitFacts } from './git';
import { commitShaFromStdout } from './git';
import type { PiCaptureEvent, PiCaptureEventName } from './pi-wire';

/** The subset of Pi's `ExtensionContext` the handlers rely on (structural, per the module header). */
export interface PiExtensionContext {
  cwd: string;
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined | null;
  };
  mode?: string;
  ui?: {
    notify?(message: string, type?: 'info' | 'warning' | 'error'): void;
  };
}

/** The subset of Pi's `ExtensionAPI` the adapter registers through (structural, per the header). */
export interface PiExtensionApi {
  on(
    event: PiCaptureEventName,
    handler: (event: PiCaptureEvent, ctx: PiExtensionContext) => void | Promise<void>,
  ): () => void;
  sendUserMessage(content: string, options?: { deliverAs?: 'steer' | 'followUp' }): void;
}

export interface PiExtensionOptions {
  /** Environment override source (tests); default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Working directory when a handler context is missing one (tests); default from ctx. */
  cwd?: string;
  /** Extra capture context (project id etc.) — normally discovered from the environment. */
  projectId?: string;
}

/** `ONEMEMORY_CONTEXT_BUDGET` override (tokens) for the injected context; default 750. */
export const DEFAULT_CONTEXT_BUDGET = 750;
export const MAX_CONTEXT_BUDGET = 4000;

function contextBudgetFromEnv(env: Record<string, string | undefined>): number {
  const raw = env['ONEMEMORY_CONTEXT_BUDGET'];
  if (raw === undefined || raw === '') return DEFAULT_CONTEXT_BUDGET;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONTEXT_BUDGET) return DEFAULT_CONTEXT_BUDGET;
  return parsed;
}

function report(ctx: PiExtensionContext, message: string): void {
  if (ctx.mode === undefined || ctx.mode === 'tui' || ctx.mode === 'rpc') {
    ctx.ui?.notify?.(message, 'warning');
  }
}

/**
 * Register the capture + injection handlers. Idempotent per `pi` instance; returns the unsubscribe
 * functions Pi handed back (composable for tests).
 */
export function createPiExtension(
  pi: PiExtensionApi,
  options: PiExtensionOptions = {},
): Array<() => void> {
  const env = options.env ?? process.env;
  /** Sessions that already received the context injection (in-memory: a process restart re-injects
   * once — the same freshness contract as Claude Code's SessionStart hook). */
  const injected = new Set<string>();

  const captureContext = (ctx: PiExtensionContext): { cwd: string; sessionId?: string } => ({
    cwd: options.cwd ?? ctx.cwd,
    sessionId: safeSessionId(ctx),
  });

  const deliver = async (event: unknown, ctx: PiExtensionContext): Promise<void> => {
    const base = captureContext(ctx);
    // git commit enrichment: only spent when the command is a commit (git.ts gates the trust on
    // the [branch sha] summary line + sha match; the cost is one bounded read-only git call).
    const gitCommitFacts = await gitFactsFor(event, base.cwd);
    const outcome = await capturePiEvent(event, {
      cwd: base.cwd,
      sessionId: base.sessionId,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      env,
      ...(gitCommitFacts === null ? {} : { gitCommitFacts }),
    });
    if (!outcome.delivery.ok) {
      report(ctx, deliveryDiagnostic(outcome.delivery));
    }
  };

  const unsubs = [
    pi.on('session_start', async (event, ctx) => {
      await deliver(event, ctx);
    }),
    pi.on('session_shutdown', async (event, ctx) => {
      await deliver(event, ctx);
    }),
    pi.on('message_end', async (event, ctx) => {
      await deliver(event, ctx);
    }),
    pi.on('tool_result', async (event, ctx) => {
      await deliver(event, ctx);
    }),
    pi.on('before_agent_start', async (_event, ctx) => {
      const sessionId = safeSessionId(ctx);
      if (sessionId !== undefined && injected.has(sessionId)) return;
      const injection = await buildSessionInjection(
        {
          cwd: options.cwd ?? ctx.cwd,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
          env,
        },
        { budget: contextBudgetFromEnv(env), ...(sessionId === undefined ? {} : { sessionId }) },
      );
      if (injection.text === null) {
        // Unreachable daemon / empty context: never block or degrade the session (fail-soft).
        return;
      }
      pi.sendUserMessage(injection.text, { deliverAs: 'steer' });
      if (sessionId !== undefined) injected.add(sessionId);
    }),
  ];
  return unsubs;
}

/** Session id via Pi's own accessor; `undefined` when the structural surface is absent. */
function safeSessionId(ctx: PiExtensionContext): string | undefined {
  try {
    const id = ctx.sessionManager.getSessionId();
    return typeof id === 'string' && id.length > 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enrich a bash/powershell `git commit` tool result with HEAD facts (one bounded, read-only
 * `git log -1`). `null` for anything else — the translator counts the missing enrichment when a
 * commit summary line was present.
 */
async function gitFactsFor(
  event: unknown,
  cwd: string,
): Promise<ReturnType<typeof readGitCommitFacts> | null> {
  if (typeof event !== 'object' || event === null) return null;
  const candidate = event as { type?: unknown; toolName?: unknown; input?: unknown; structuredContent?: unknown; isError?: unknown };
  if (candidate.type !== 'tool_result' || candidate.isError === true) return null;
  if (candidate.toolName !== 'bash' && candidate.toolName !== 'powershell') return null;
  const input = candidate.input as { command?: unknown } | undefined;
  if (typeof input?.command !== 'string' || !looksLikeGitCommit(input.command)) return null;
  const structured = candidate.structuredContent as { output?: unknown } | undefined;
  const output = typeof structured?.output === 'string' ? structured.output : '';
  const shortSha = commitShaFromStdout(output);
  if (shortSha === null) return null;
  return readGitCommitFacts(cwd, { shortSha });
}
