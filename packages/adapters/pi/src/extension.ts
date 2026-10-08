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
 * - `before_agent_start` carries the mutable, normalized `systemPromptOptions` — "Mutable prompt
 *   sections. Later handlers observe mutations made by earlier handlers" — which is the
 *   sanctioned injection channel: the context is written into one section and rides the same
 *   agent run as the user's prompt. (Verified live against pi 1.0.4, mission 23: the
 *   extension-facing `sendUserMessage` "always triggers a turn" and only queues via `deliverAs`
 *   *while streaming* — at `before_agent_start` the agent is *processing*, so that call throws
 *   `Agent is already processing a prompt` and kills the turn; the adapter must not call it.)
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
}

/**
 * The system-prompt section the project context is injected into at `before_agent_start`. Pi
 * wraps every non-preamble section in a tag of the same name, diffs sections against the
 * transcript, and sends a patch only when they change — so re-applying the same section on every
 * agent start costs no tokens.
 */
export const PI_CONTEXT_SECTION = 'onememory-project-context';

/**
 * Write the injection into the event's mutable, normalized `systemPromptOptions.sections` —
 * Pi's documented `before_agent_start` mutation channel. Returns `false` when the surface is
 * absent (an older Pi): the caller reports and moves on, because a missing injection channel
 * must never break a session.
 */
function applyPiContextSection(event: unknown, text: string): boolean {
  if (typeof event !== 'object' || event === null) return false;
  const options = (event as { systemPromptOptions?: unknown }).systemPromptOptions;
  if (typeof options !== 'object' || options === null) return false;
  const sections = (options as { sections?: unknown }).sections;
  if (typeof sections !== 'object' || sections === null) return false;
  (sections as Record<string, string>)[PI_CONTEXT_SECTION] = text;
  return true;
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
  /** Sessions whose project context has been fetched (in-memory: a process restart re-fetches
   * once — the same freshness contract as Claude Code's SessionStart hook). The fetched context
   * is re-applied on EVERY agent start: pi re-normalizes `systemPromptOptions` per agent run, so
   * a section written once would be gone by the next prompt. */
  const injected = new Map<string, string>();

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
    pi.on('before_agent_start', async (event, ctx) => {
      const sessionId = safeSessionId(ctx);
      const cached = sessionId === undefined ? undefined : injected.get(sessionId);
      if (sessionId !== undefined && cached !== undefined) {
        // Fetched earlier this session: re-apply the section only (pi re-normalizes the options
        // for every agent run, so the section must be re-set or it is gone by the next prompt).
        applyPiContextSection(event, cached);
        return;
      }
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
      if (sessionId !== undefined) injected.set(sessionId, injection.text);
      if (!applyPiContextSection(event, injection.text)) {
        // An older Pi without the mutation surface: degrade loudly, never break the session.
        report(ctx, '[onememory] context injection unavailable: no systemPromptOptions at before_agent_start');
      }
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
