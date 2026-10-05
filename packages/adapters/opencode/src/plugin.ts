/**
 * The OpenCode plugin entry point: `createOpenCodePlugin()` returns the plugin function the
 * scaffolded `.opencode/plugins/onememory.ts` shim exports (OpenCode's documented shape: a module
 * "that exports one or more plugin functions", each receiving a context object and returning a
 * hooks object — https://opencode.ai/docs/plugins/). Local plugin files auto-load at startup, so
 * the shim needs no config entry.
 *
 * The hook signatures below are STRUCTURAL mirrors of the exact subset of `@opencode-ai/plugin`'s
 * published `Hooks` interface this adapter uses (verified against `@opencode-ai/plugin@1.18.34`
 * `dist/index.d.ts`):
 * - `event?: (input: { event: Event }) => Promise<void>` — the event stream (session lifecycle,
 *   message parts).
 * - `"tool.execute.after"?: (input: { tool, sessionID, callID, args }, output: { title, output,
 *   metadata }) => Promise<void>` — every completed tool execution (bash carries its exit code on
 *   `metadata.exit`; edit/write carry file facts).
 * - `"chat.message"?: (input: { sessionID, agent?, model?, messageID?, variant? }, output:
 *   { message: UserMessage, parts: Part[] }) => Promise<void>` — "Called when a new message is
 *   received": the one-shot user-message channel.
 * - `"experimental.chat.system.transform"?: (input: { sessionID?, model }, output:
 *   { system: string[] }) => Promise<void>` — the system-prompt transform this adapter uses for
 *   session context injection. EXPERIMENTAL upstream (the name says so): the static
 *   `.opencode/onememory.md` instructions pointer is the durable channel; this hook is the live
 *   one, and a future rename surfaces as a counted no-op, never a broken session.
 *
 * No dependency on `@opencode-ai/plugin` is declared: the adapter must work without OpenCode
 * installed (scaffold tests, conformance runs) and version against the DOCUMENTED surface only.
 *
 * Fail-soft is the contract: every handler is bounded (2.5s ingest, 2s context) and converts
 * every failure into a one-line diagnostic — never a thrown error into an OpenCode hook.
 */

import {
  buildSessionInjection,
  captureOpenCodeChatMessage,
  captureOpenCodeEvent,
  captureOpenCodeToolAfter,
  deliveryDiagnostic,
  OPENCODE_CONTEXT_INJECTION_PREFIX,
} from './capture';
import { createOpenCodeTranslator, type OpenCodeTranslateContext } from './translate';

/** The subset of OpenCode's `PluginInput` the handlers rely on (structural, per the header). */
export interface OpenCodePluginContext {
  /** The current working directory (the project root for project-scoped plugins). */
  directory: string;
  /** The git worktree path (informational; capture uses `directory`). */
  worktree?: string;
  /** An OpenCode SDK client — used only for the optional structured logger. */
  client?: {
    app?: {
      log?(input: {
        body: {
          service?: string;
          level?: 'debug' | 'info' | 'warn' | 'error';
          message: string;
          extra?: Record<string, unknown>;
        };
      }): Promise<unknown>;
    };
  };
}

/** The hook map the plugin function returns (structural mirrors; see the module header). */
export interface OpenCodePluginHooks {
  event?: (input: { event: unknown }) => Promise<void> | void;
  'tool.execute.after'?: (
    input: { tool: string; sessionID: string; callID: string; args?: unknown },
    output: { title: string; output: string; metadata?: unknown },
  ) => Promise<void> | void;
  'chat.message'?: (
    input: { sessionID: string; agent?: string; model?: unknown; messageID?: string; variant?: string },
    output: { message: unknown; parts?: unknown[] },
  ) => Promise<void> | void;
  'experimental.chat.system.transform'?: (
    input: { sessionID?: string; model?: unknown },
    output: { system: string[] },
  ) => Promise<void> | void;
  dispose?: () => Promise<void>;
}

export interface OpenCodePluginOptions extends OpenCodeTranslateContext {
  /** Environment override source (tests); default `process.env`. */
  env?: Record<string, string | undefined>;
  /** Delivery timeout override (ms); default 2500. */
  deliveryTimeoutMs?: number;
  /** Context-fetch timeout override (ms); default 2000. */
  contextTimeoutMs?: number;
}

/** `ONEMEMORY_CONTEXT_BUDGET` override (tokens) for the injected context; default 750. */
export const DEFAULT_CONTEXT_BUDGET = 750;
export const MAX_CONTEXT_BUDGET = 4000;

const LOG_SERVICE = 'onememory';

function contextBudgetFromEnv(env: Record<string, string | undefined>): number {
  const raw = env['ONEMEMORY_CONTEXT_BUDGET'];
  if (raw === undefined || raw === '') return DEFAULT_CONTEXT_BUDGET;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONTEXT_BUDGET) return DEFAULT_CONTEXT_BUDGET;
  return parsed;
}

/** The plugin function the scaffolded shim exports. */
export function createOpenCodePlugin(options: OpenCodePluginOptions = {}): (ctx: OpenCodePluginContext) => Promise<OpenCodePluginHooks> {
  return async (ctx: OpenCodePluginContext) => {
    const env = options.env ?? process.env;
    const cwd = ctx.directory;
    const translator = createOpenCodeTranslator({
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.agentId === undefined ? {} : { agentId: options.agentId }),
      projectRoot: cwd,
    });
    /** Sessions that already received the context injection (in-memory: a process restart
     * re-injects once — the same freshness contract as the Claude/Pi session-start injections). */
    const injected = new Set<string>();

    const log = async (level: 'warn' | 'error', message: string): Promise<void> => {
      try {
        await ctx.client?.app?.log?.({ body: { service: LOG_SERVICE, level, message } });
      } catch {
        // The logger is advisory; a logger failure must never break a hook.
      }
    };

    const captureOptions = {
      cwd,
      env,
      translator,
      ...(options.projectId === undefined ? {} : { projectId: options.projectId }),
      ...(options.deliveryTimeoutMs === undefined ? {} : { timeoutMs: options.deliveryTimeoutMs }),
    };

    const report = async (outcome: { delivery: { ok: boolean; code?: string; message?: string } }): Promise<void> => {
      if (outcome.delivery.ok) return;
      const failure = outcome.delivery as { ok: false; code: string; message: string };
      await log('warn', deliveryDiagnostic(failure));
    };

    return {
      // The hook input IS the { event } wrapper capture expects — pass it through whole.
      event: async (input) => {
        try {
          await report(await captureOpenCodeEvent(input, captureOptions));
        } catch (error) {
          await log('warn', `[onememory] event capture failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      'tool.execute.after': async (input, output) => {
        try {
          await report(await captureOpenCodeToolAfter(input, output, captureOptions));
        } catch (error) {
          await log('warn', `[onememory] tool capture failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      'chat.message': async (input, output) => {
        try {
          await report(await captureOpenCodeChatMessage(input, output, captureOptions));
        } catch (error) {
          await log('warn', `[onememory] message capture failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
      'experimental.chat.system.transform': async (input, output) => {
        try {
          const sessionKey = input.sessionID ?? '';
          if (injected.has(sessionKey)) return;
          const injection = await buildSessionInjection(
            { ...captureOptions, ...(options.contextTimeoutMs === undefined ? {} : { timeoutMs: options.contextTimeoutMs }) },
            {
              budget: contextBudgetFromEnv(env),
              ...(input.sessionID === undefined ? {} : { sessionId: input.sessionID }),
            },
          );
          if (injection.text === null) {
            // Unreachable daemon / empty context: never block or degrade the session (fail-soft).
            return;
          }
          output.system.push(`${injection.text}`);
          injected.add(sessionKey);
        } catch (error) {
          await log('warn', `[onememory] context injection skipped: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    };
  };
}

export { OPENCODE_CONTEXT_INJECTION_PREFIX };
