/**
 * Idempotent merges of the onememory scaffolds into a user's existing Claude Code files.
 *
 * Both helpers are pure (text in, text out); `onemem init` performs the reads and writes. The
 * rules, shared by both:
 * - only onememory's own entries are inserted or replaced — every other server, hook, and
 *   top-level key is preserved in place;
 * - re-running produces byte-identical output (`unchanged`), so init is safe to repeat;
 * - an existing file that is not valid JSON, or whose structure is not what Claude Code reads,
 *   is reported as an error and never overwritten — the user's file is theirs to fix.
 */

import { z } from 'zod';

import {
  buildClaudeHooksConfig,
  buildMcpServerEntry,
  type HooksConfigOptions,
  type McpJsonOptions,
} from './scaffolds';

export type ScaffoldMergeAction = 'created' | 'patched' | 'unchanged';

export type ScaffoldMergeResult =
  | { ok: true; content: string; action: ScaffoldMergeAction }
  | { ok: false; error: string };

/** The name of the onememory server inside `mcpServers`. */
export const MCP_SERVER_NAME = 'onememory';

/** Substrings that identify a hook handler as the onememory hook bin (default or published). */
export const CLAUDE_HOOK_BIN_TOKENS: readonly string[] = ['@onememory/adapter-claude', 'onemem-claude-hook'];

const JsonObjectSchema = z.record(z.string(), z.unknown());

const McpJsonShapeSchema = z.looseObject({
  mcpServers: JsonObjectSchema.optional(),
});

const SettingsShapeSchema = z.looseObject({
  hooks: JsonObjectSchema.optional(),
});

const HookGroupShapeSchema = z.looseObject({
  hooks: z.array(z.unknown()),
});

const HookHandlerShapeSchema = z.looseObject({
  command: z.string(),
  args: z.array(z.string()).optional(),
});

function render(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function parseJsonDocument(existing: string, label: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(existing) };
  } catch (error) {
    return {
      ok: false,
      error: `${label} is not valid JSON and was left untouched (${error instanceof Error ? error.message : String(error)}) — fix it and re-run onemem init`,
    };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Insert or replace `mcpServers.onememory` in an existing `.mcp.json` (`null` / blank → a new
 * document). Other servers and other top-level keys keep their position and content.
 */
export function mergeMcpJson(existing: string | null, options: McpJsonOptions = {}): ScaffoldMergeResult {
  const entry = buildMcpServerEntry(options);
  if (existing === null || existing.trim().length === 0) {
    return { ok: true, content: render({ mcpServers: { [MCP_SERVER_NAME]: entry } }), action: 'created' };
  }
  const parsed = parseJsonDocument(existing, '.mcp.json');
  if (!parsed.ok) return parsed;
  if (!isPlainObject(parsed.value) || !McpJsonShapeSchema.safeParse(parsed.value).success) {
    return {
      ok: false,
      error: '.mcp.json is not a JSON object with an object-valued "mcpServers" and was left untouched — fix it and re-run onemem init',
    };
  }
  const document = parsed.value;
  const servers = isPlainObject(document['mcpServers']) ? document['mcpServers'] : {};
  // Spreading keeps an existing `onememory` key in its original position.
  const merged = { ...document, mcpServers: { ...servers, [MCP_SERVER_NAME]: entry } };
  const content = render(merged);
  return { ok: true, content, action: content === existing ? 'unchanged' : 'patched' };
}

/**
 * Merge onememory's hooks into an existing `.claude/settings.json` (`null` / blank → a new
 * document holding only the hooks).
 *
 * Per subscribed event: onememory's own handlers (identified by the hook-bin tokens or the exact
 * configured invocation) are removed from every matcher group — a group left empty by that
 * removal is dropped, a group that still holds user handlers is kept — and the generated groups
 * are appended. Claude Code runs every matching handler, so this is what keeps re-runs from
 * registering duplicates. Events onememory does not subscribe to, and all non-hook settings, are
 * untouched.
 */
export function mergeClaudeSettingsHooks(
  existing: string | null,
  options: HooksConfigOptions = {},
): ScaffoldMergeResult {
  const generated = buildClaudeHooksConfig(options);
  if (existing === null || existing.trim().length === 0) {
    return { ok: true, content: render(generated), action: 'created' };
  }
  const parsed = parseJsonDocument(existing, '.claude/settings.json');
  if (!parsed.ok) return parsed;
  if (!isPlainObject(parsed.value) || !SettingsShapeSchema.safeParse(parsed.value).success) {
    return {
      ok: false,
      error: '.claude/settings.json is not a JSON object with an object-valued "hooks" and was left untouched — fix it and re-run onemem init',
    };
  }
  const document = parsed.value;
  const existingHooks = isPlainObject(document['hooks']) ? document['hooks'] : {};
  const isOurs = onememoryHandlerPredicate(options);

  const mergedHooks: Record<string, unknown> = { ...existingHooks };
  for (const [event, generatedGroups] of Object.entries(generated.hooks)) {
    const current = existingHooks[event];
    if (current !== undefined && !Array.isArray(current)) {
      return {
        ok: false,
        error: `.claude/settings.json hooks.${event} is not an array and was left untouched — fix it and re-run onemem init`,
      };
    }
    const preserved: unknown[] = [];
    for (const group of current ?? []) {
      const shape = HookGroupShapeSchema.safeParse(group);
      if (!shape.success || !isPlainObject(group)) {
        preserved.push(group);
        continue;
      }
      const handlers = group['hooks'] as unknown[];
      const remaining = handlers.filter((handler) => !isOurs(handler));
      if (remaining.length === handlers.length) preserved.push(group);
      else if (remaining.length > 0) preserved.push({ ...group, hooks: remaining });
    }
    mergedHooks[event] = [...preserved, ...generatedGroups];
  }

  const content = render({ ...document, hooks: mergedHooks });
  return { ok: true, content, action: content === existing ? 'unchanged' : 'patched' };
}

/** Builds the "is this handler onememory's?" predicate for a given invocation. */
export function onememoryHandlerPredicate(options: HooksConfigOptions = {}): (handler: unknown) => boolean {
  const generated = buildClaudeHooksConfig(options);
  const invocation = generated.hooks.SessionStart[0]!.hooks[0]!;
  const invocationArgs = JSON.stringify(invocation.args ?? []);
  return (handler: unknown): boolean => {
    const shape = HookHandlerShapeSchema.safeParse(handler);
    if (!shape.success) return false;
    const { command, args } = shape.data;
    if (command === invocation.command && JSON.stringify(args ?? []) === invocationArgs) return true;
    const texts = [command, ...(args ?? [])];
    return texts.some((text) => CLAUDE_HOOK_BIN_TOKENS.some((token) => text.includes(token)));
  };
}
