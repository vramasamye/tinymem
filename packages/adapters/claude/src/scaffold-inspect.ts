/**
 * Read-only inspection of the project-scope Claude Code scaffolds, for `onemem doctor`.
 *
 * Reports what is on disk — never judges it: the doctor compares the MCP URL against the
 * configured daemon URL and decides the status. Content-level functions are pure so each state is
 * unit-tested without a filesystem.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { MCP_SERVER_NAME, onememoryHandlerPredicate } from './scaffold-merge';
import { buildClaudeHooksConfig, MEMORY_POINTER_BEGIN, MEMORY_POINTER_END } from './scaffolds';

export type ClaudeMcpInspection =
  | { state: 'absent' }
  | { state: 'invalid'; detail: string }
  | { state: 'no_entry' }
  | { state: 'http'; url: string }
  | { state: 'stdio' }
  | { state: 'unrecognized'; detail: string };

export type ClaudeHooksInspection =
  | { state: 'absent' }
  | { state: 'invalid'; detail: string }
  | { state: 'no_entry' }
  | { state: 'partial'; missing_events: string[] }
  | { state: 'complete' };

export interface ClaudeScaffoldInspection {
  mcp_json: { path: string } & ClaudeMcpInspection;
  settings_hooks: { path: string } & ClaudeHooksInspection;
  pointer: { path: string; present: boolean };
}

const ServersSchema = z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() });
const HttpEntrySchema = z.looseObject({ type: z.enum(['http', 'streamable-http']), url: z.string() });
const StdioEntrySchema = z.looseObject({ command: z.string() });
const SettingsSchema = z.looseObject({ hooks: z.record(z.string(), z.unknown()).optional() });
const GroupSchema = z.looseObject({ hooks: z.array(z.unknown()) });

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, detail: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

/** Classify the `onememory` entry of a `.mcp.json` document (`null` = file absent). */
export function inspectMcpJsonContent(text: string | null): ClaudeMcpInspection {
  if (text === null) return { state: 'absent' };
  const parsed = parseJson(text);
  if (!parsed.ok) return { state: 'invalid', detail: parsed.detail };
  const document = ServersSchema.safeParse(parsed.value);
  if (!document.success || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { state: 'invalid', detail: 'not a JSON object with an object-valued "mcpServers"' };
  }
  const entry = document.data.mcpServers?.[MCP_SERVER_NAME];
  if (entry === undefined) return { state: 'no_entry' };
  const http = HttpEntrySchema.safeParse(entry);
  if (http.success) return { state: 'http', url: http.data.url };
  if (StdioEntrySchema.safeParse(entry).success) return { state: 'stdio' };
  return { state: 'unrecognized', detail: 'the onememory entry is neither an http nor a stdio server' };
}

/** Which of onememory's subscribed hook events carry an onememory handler. */
export function inspectSettingsHooksContent(text: string | null): ClaudeHooksInspection {
  if (text === null) return { state: 'absent' };
  const parsed = parseJson(text);
  if (!parsed.ok) return { state: 'invalid', detail: parsed.detail };
  const document = SettingsSchema.safeParse(parsed.value);
  if (!document.success || typeof parsed.value !== 'object' || parsed.value === null || Array.isArray(parsed.value)) {
    return { state: 'invalid', detail: 'not a JSON object with an object-valued "hooks"' };
  }
  const isOurs = onememoryHandlerPredicate();
  const events = Object.keys(buildClaudeHooksConfig().hooks);
  const hooks = document.data.hooks ?? {};
  const missing = events.filter((event) => {
    const groups = hooks[event];
    if (!Array.isArray(groups)) return true;
    return !groups.some((group) => {
      const shape = GroupSchema.safeParse(group);
      return shape.success && shape.data.hooks.some((handler) => isOurs(handler));
    });
  });
  if (missing.length === events.length) return { state: 'no_entry' };
  if (missing.length > 0) return { state: 'partial', missing_events: missing };
  return { state: 'complete' };
}

/** `true` when the document holds a complete onememory pointer block. */
export function hasMemoryPointerBlock(text: string | null): boolean {
  if (text === null) return false;
  const begin = text.indexOf(MEMORY_POINTER_BEGIN);
  return begin !== -1 && text.indexOf(MEMORY_POINTER_END, begin) !== -1;
}

/** The project-scope artifact paths `onemem init --with-claude` writes. */
export function claudeScaffoldPaths(root: string): { mcpJson: string; settingsJson: string; claudeMd: string } {
  return {
    mcpJson: join(root, '.mcp.json'),
    settingsJson: join(root, '.claude', 'settings.json'),
    claudeMd: join(root, 'CLAUDE.md'),
  };
}

/** Inspect the project-scope Claude Code scaffolds under `root`. */
export function inspectClaudeScaffold(root: string): ClaudeScaffoldInspection {
  const paths = claudeScaffoldPaths(root);
  return {
    mcp_json: { path: paths.mcpJson, ...inspectMcpJsonContent(readIfExists(paths.mcpJson)) },
    settings_hooks: { path: paths.settingsJson, ...inspectSettingsHooksContent(readIfExists(paths.settingsJson)) },
    pointer: { path: paths.claudeMd, present: hasMemoryPointerBlock(readIfExists(paths.claudeMd)) },
  };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
