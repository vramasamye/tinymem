/**
 * `.cursor/hooks.json` — the capture-hook scaffold (pure renderers + an idempotent patcher).
 *
 * Wire format (verified: https://cursor.com/docs/hooks, fetched 2026-10-05):
 * - Project config: `<project-root>/.cursor/hooks.json`; user config: `~/.cursor/hooks.json`.
 * - Shape: `{"version": 1, "hooks": {"<event>": [ {command, matcher?, timeout?, …} ]}}`.
 *   `version` is required ("Must be a positive integer (use 1)").
 * - PROJECT hooks run from the PROJECT ROOT, so a relative `node_modules/...` path is correct and
 *   no environment-variable placeholder is needed (the docs: "For project hooks, use paths like
 *   `.cursor/hooks/script.sh` (relative to project root)"). `CURSOR_PROJECT_DIR` is exported to
 *   every hook as a belt-and-suspenders fallback.
 * - `matcher` filters by tool name for the generic tool hooks (example: `"Shell|Read|Write"`).
 * - Cursor runs every matching hook from every source and merges responses; `deny` > `ask` > `allow`.
 *
 * Only the events onememory actually maps are registered (see `hook-input.ts` for the
 * subscribed/not-subscribed rationale). `stop` is deliberately absent: it is a per-turn loop end
 * with no transcript and no lifecycle semantics — the working-memory sweep is driven by
 * `sessionEnd` → `session.end` on the daemon.
 */

import { z } from 'zod';

import type { ScaffoldMergeResult } from './mcp-scaffold';

export interface CursorHooksScaffoldOptions {
  /** The capture command (default: the workspace-relative adapter bin, run with Bun). */
  captureCommand?: string;
  /** Hook timeout in SECONDS for the sessionStart context fetch (default 10). */
  sessionStartTimeoutSec?: number;
  /** Hook timeout in SECONDS for the capture handlers (default 5). */
  captureTimeoutSec?: number;
}

/** Substrings that identify a hook entry as onememory's (default or published bin). */
export const CURSOR_HOOK_BIN_TOKENS: readonly string[] = ['@onememory/adapter-cursor', 'onemem-cursor-hook'];

export const CursorHookEntrySchema = z.looseObject({
  command: z.string().min(1),
  matcher: z.string().min(1).optional(),
  timeout: z.number().int().min(1).optional(),
});

export const CursorHooksFileSchema = z.looseObject({
  version: z.literal(1),
  hooks: z.record(z.string(), z.array(CursorHookEntrySchema)),
});
export type CursorHooksFile = z.infer<typeof CursorHooksFileSchema>;

/** The default capture command: Bun runs the adapter bin from the project root. */
export function defaultCaptureCommand(): string {
  return 'bun node_modules/@onememory/adapter-cursor/src/bin.ts';
}

/** Build the generated hooks.json object (validated before it leaves). */
export function buildCursorHooksFile(options: CursorHooksScaffoldOptions = {}): CursorHooksFile {
  const command = options.captureCommand ?? defaultCaptureCommand();
  const captureTimeout = options.captureTimeoutSec ?? 5;
  const sessionStartTimeout = options.sessionStartTimeoutSec ?? 10;

  const capture = { command, timeout: captureTimeout };
  return CursorHooksFileSchema.parse({
    version: 1,
    hooks: {
      // Fire-and-forget in Cursor, but the bin still bounds its own work; the timeout is a ceiling.
      sessionStart: [{ command, timeout: sessionStartTimeout }],
      sessionEnd: [{ ...capture }],
      beforeSubmitPrompt: [{ ...capture }],
      afterAgentResponse: [{ ...capture }],
      // Only Shell executions produce a terminal.output event; a matcher avoids a spawn per tool.
      postToolUse: [{ ...capture, matcher: 'Shell' }],
      // Any tool failure is an honest error event — no matcher ("*" is implicit for absent).
      postToolUseFailure: [{ ...capture }],
      afterFileEdit: [{ ...capture }],
    },
  });
}

/** Serialize the hooks.json document (2-space indent, trailing newline). */
export function renderCursorHooksJson(options: CursorHooksScaffoldOptions = {}): string {
  return `${JSON.stringify(buildCursorHooksFile(options), null, 2)}\n`;
}

function isOurs(entry: unknown, token: string): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const command = (entry as { command?: unknown }).command;
  return typeof command === 'string' && command.includes(token);
}

/**
 * Idempotently merge the generated hooks into an existing hooks.json.
 *
 * Entries whose command references the onememory adapter bin are REPLACED (Cursor runs every
 * matching hook, so re-running init must not register duplicates); everything else in the file
 * (other tools' hooks, other events, user metadata) is preserved. An unparseable or wrongly shaped
 * file is reported, never clobbered.
 */
export function patchCursorHooksJson(
  existing: string,
  options: CursorHooksScaffoldOptions = {},
): ScaffoldMergeResult {
  const generated = buildCursorHooksFile(options);
  const token = options.captureCommand ?? defaultCaptureCommand();

  if (existing.trim().length === 0) {
    return { ok: true, content: renderCursorHooksJson(options), action: 'created' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    return {
      ok: false,
      error: `.cursor/hooks.json is not valid JSON and was left untouched (${
        error instanceof Error ? error.message : String(error)
      }) — fix it and re-run onemem init`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: '.cursor/hooks.json is not a JSON object and was left untouched — fix it and re-run onemem init' };
  }
  const document = parsed as Record<string, unknown>;
  const hooks = document['hooks'];
  if (hooks !== undefined && (typeof hooks !== 'object' || hooks === null || Array.isArray(hooks))) {
    return { ok: false, error: '.cursor/hooks.json has a non-object "hooks" and was left untouched — fix it and re-run onemem init' };
  }
  const existingHooks = (hooks ?? {}) as Record<string, unknown>;

  const mergedHooks: Record<string, unknown> = { ...existingHooks };
  for (const [event, generatedEntries] of Object.entries(generated.hooks)) {
    const current = existingHooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      return {
        ok: false,
        error: `.cursor/hooks.json hooks.${event} is not an array and was left untouched — fix it and re-run onemem init`,
      };
    }
    const preserved = (current ?? []).filter((entry) => !isOurs(entry, token));
    mergedHooks[event] = [...preserved, ...generatedEntries];
  }

  const content = `${JSON.stringify({ ...document, version: 1, hooks: mergedHooks }, null, 2)}\n`;
  return { ok: true, content, action: content === existing ? 'unchanged' : 'patched' };
}
