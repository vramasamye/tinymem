/**
 * Session-start context injection (ADR-0010 §6: injection beats polling).
 *
 * The SessionStart hook fetches the daemon's compact project context —
 * `GET /v1/projects/{id}/context?budget=N`, the same token-budgeted assembly the
 * `memory_project_context` tool serves — and emits it as the documented hook output:
 *
 *   {"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": "..."}}
 *
 * Claude Code wraps `additionalContext` in a system reminder at the START of the conversation.
 * The field is capped at 10,000 characters by Claude Code itself (hooks reference, "Add context
 * for Claude"); the daemon's budget (default 750 tokens) already bounds the text far below that,
 * and the cap here is belt-and-suspenders with an honest stderr note when it triggers.
 */

import type { DaemonTarget } from './deliver';

/** Matches the daemon's session-context default (retrieval `sessionContext.budget` default 750). */
export const DEFAULT_CONTEXT_BUDGET = 750;
/** Claude Code's hard cap on a hook `additionalContext` string. */
export const ADDITIONAL_CONTEXT_MAX = 10_000;
/** Hard per-request cap for the context fetch. */
export const CONTEXT_FETCH_TIMEOUT_MS = 1500;
/** Server-side cap (ContextQuerySchema: budget min 1 max 100_000). */
export const MAX_CONTEXT_BUDGET = 4000;

/** The tolerant read of the daemon's SessionContext (retrieval/src/session-context.ts). */
export interface SessionContextResponse {
  project_id: string;
  budget: number;
  used: number;
  text: string;
  sections: Array<{ kind: string; tokens: number; text: string }>;
  warnings: string[];
}

export interface FetchContextResult {
  ok: boolean;
  context?: SessionContextResponse;
  error?: string;
}

export function contextBudgetFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.ONEMEMORY_CONTEXT_BUDGET;
  if (raw === undefined || raw === '') return DEFAULT_CONTEXT_BUDGET;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONTEXT_BUDGET) return DEFAULT_CONTEXT_BUDGET;
  return parsed;
}

export async function fetchSessionContext(
  target: DaemonTarget,
  budget: number,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<FetchContextResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CONTEXT_FETCH_TIMEOUT_MS);
  const url = `${target.url}/v1/projects/${encodeURIComponent(target.projectId)}/context?budget=${budget}`;
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `context endpoint returned status ${response.status}` };
    }
    const payload = (await response.json()) as Partial<SessionContextResponse>;
    if (typeof payload.text !== 'string') {
      return { ok: false, error: 'context response carried no text' };
    }
    return {
      ok: true,
      context: {
        project_id: typeof payload.project_id === 'string' ? payload.project_id : target.projectId,
        budget: typeof payload.budget === 'number' ? payload.budget : budget,
        used: typeof payload.used === 'number' ? payload.used : 0,
        text: payload.text,
        sections: Array.isArray(payload.sections)
          ? payload.sections.map((section) => ({
              kind: String(section?.kind ?? ''),
              tokens: Number(section?.tokens ?? 0),
              text: String(section?.text ?? ''),
            }))
          : [],
        warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
      },
    };
  } catch (error) {
    return { ok: false, error: `cannot reach the onememory daemon: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the SessionStart hook's stdout JSON: the documented `additionalContext` output contract.
 * Exactly one JSON object, no surrounding text (Claude Code parses `{…}` stdout as hook output).
 */
export function additionalContextOutput(text: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: text,
    },
  });
}

/** Cap to Claude Code's documented 10,000-char limit, reporting the cut honestly. */
export function capAdditionalContext(text: string): { text: string; capped: boolean } {
  if (text.length <= ADDITIONAL_CONTEXT_MAX) return { text, capped: false };
  return { text: text.slice(0, ADDITIONAL_CONTEXT_MAX), capped: true };
}
