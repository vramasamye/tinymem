/**
 * Read-only inspection of the project-scope Cursor scaffolds, for `onemem doctor`.
 *
 * Reports what is on disk — never judges it: the doctor compares the MCP URL against the
 * configured daemon URL and decides the status. Content-level functions are pure so each state is
 * unit-tested without a filesystem.
 */

import { existsSync, readFileSync } from 'node:fs';

import { z } from 'zod';

import { buildCursorHooksFile, CURSOR_HOOK_BIN_TOKENS } from './hooks-scaffold';
import { MCP_SERVER_NAME } from './mcp-scaffold';
import { hasOnememoryRuleBlock } from './rules';
import { cursorScaffoldPaths } from './scaffold';

export type CursorMcpInspection =
  | { state: 'absent' }
  | { state: 'invalid'; detail: string }
  | { state: 'no_entry' }
  | { state: 'http'; url: string }
  | { state: 'stdio' }
  | { state: 'unrecognized'; detail: string };

export type CursorHooksInspection =
  | { state: 'absent' }
  | { state: 'invalid'; detail: string }
  | { state: 'no_entry' }
  | { state: 'partial'; missing_events: string[] }
  | { state: 'complete' };

export interface CursorScaffoldInspection {
  mcp_json: { path: string } & CursorMcpInspection;
  hooks: { path: string } & CursorHooksInspection;
  rule: { path: string; present: boolean };
}

const ServersSchema = z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() });
const HttpEntrySchema = z.looseObject({ url: z.string() });
const StdioEntrySchema = z.looseObject({ type: z.literal('stdio'), command: z.string().min(1) });
const HooksSchema = z.looseObject({ hooks: z.record(z.string(), z.unknown()).optional() });
const HookEntrySchema = z.looseObject({ command: z.string().min(1) });

function parseJson(text: string): { ok: true; value: unknown } | { ok: false; detail: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    return { ok: false, detail: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Classify the `onememory` entry of a `.cursor/mcp.json` document (`null` = file absent). */
export function inspectCursorMcpContent(text: string | null): CursorMcpInspection {
  if (text === null) return { state: 'absent' };
  const parsed = parseJson(text);
  if (!parsed.ok) return { state: 'invalid', detail: parsed.detail };
  if (!isPlainObject(parsed.value) || !ServersSchema.safeParse(parsed.value).success) {
    return { state: 'invalid', detail: 'not a JSON object with an object-valued "mcpServers"' };
  }
  const servers = (parsed.value as { mcpServers?: Record<string, unknown> }).mcpServers ?? {};
  const entry = servers[MCP_SERVER_NAME];
  if (entry === undefined) return { state: 'no_entry' };
  if (StdioEntrySchema.safeParse(entry).success) return { state: 'stdio' };
  const http = HttpEntrySchema.safeParse(entry);
  if (http.success) return { state: 'http', url: http.data.url };
  return { state: 'unrecognized', detail: 'the onememory entry is neither a remote (url) nor a stdio server' };
}

function isOurs(entry: unknown): boolean {
  const shape = HookEntrySchema.safeParse(entry);
  if (!shape.success) return false;
  return CURSOR_HOOK_BIN_TOKENS.some((token) => shape.data.command.includes(token));
}

/** Which of onememory's subscribed hook events carry an onememory entry. */
export function inspectCursorHooksContent(text: string | null): CursorHooksInspection {
  if (text === null) return { state: 'absent' };
  const parsed = parseJson(text);
  if (!parsed.ok) return { state: 'invalid', detail: parsed.detail };
  if (!isPlainObject(parsed.value) || !HooksSchema.safeParse(parsed.value).success) {
    return { state: 'invalid', detail: 'not a JSON object with an object-valued "hooks"' };
  }
  const events = Object.keys(buildCursorHooksFile().hooks);
  const hooks = (parsed.value as { hooks?: Record<string, unknown> }).hooks ?? {};
  const missing = events.filter((event) => {
    const entries = hooks[event];
    if (!Array.isArray(entries)) return true;
    return !entries.some(isOurs);
  });
  if (missing.length === events.length) return { state: 'no_entry' };
  if (missing.length > 0) return { state: 'partial', missing_events: missing };
  return { state: 'complete' };
}

/** Inspect the project-scope Cursor scaffolds under `root`. */
export function inspectCursorScaffold(root: string): CursorScaffoldInspection {
  const paths = cursorScaffoldPaths(root);
  return {
    mcp_json: { path: paths.mcpJson, ...inspectCursorMcpContent(readIfExists(paths.mcpJson)) },
    hooks: { path: paths.hooksJson, ...inspectCursorHooksContent(readIfExists(paths.hooksJson)) },
    rule: { path: paths.rule, present: hasOnememoryRuleBlock(readIfExists(paths.rule)) },
  };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
