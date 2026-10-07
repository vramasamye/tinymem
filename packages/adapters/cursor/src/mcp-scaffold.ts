/**
 * `.cursor/mcp.json` — the MCP server scaffold (pure renderers + an idempotent patcher; the CLI
 * owns the actual writes).
 *
 * Wire format (verified: https://cursor.com/docs/mcp, fetched 2026-10-05):
 * - Project config lives at `<project>/.cursor/mcp.json`; global config at `~/.cursor/mcp.json`.
 * - Shape: `{"mcpServers": {"<name>": <entry>}}`.
 * - Stdio entry: `{type: "stdio", command, args?, env?, envFile?}` — the reference field table
 *   marks `type` REQUIRED for stdio servers, although the page's own Node/Python examples omit it.
 *   We emit `type: "stdio"` (the stricter reading of the same page).
 * - Remote entry: `{url, headers?}` (HTTP/Streamable HTTP; Cursor also supports SSE). The docs'
 *   remote example carries no `type`, so none is emitted for the daemon URL form.
 * - Interpolation: `${env:NAME}`, `${workspaceFolder}` (the folder containing `.cursor/mcp.json`),
 *   `${userHome}`, `${workspaceFolderBasename}`, `${pathSeparator}`. Values that must come from the
 *   user's environment are emitted as `${env:NAME}` so no secret ever enters the file.
 *
 * Every emitted document is validated against its Zod schema before it leaves (a scaffold bug is a
 * test failure, never a broken runtime config).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export interface CursorMcpOptions {
  /**
   * `stdio` spawns the standalone `onemem-mcp` bin; `http` points Cursor at the daemon's
   * Streamable HTTP `/mcp` surface (what `onemem init` emits — ADR-0010 amendment 2026-10-04: the
   * daemon is the single owner of embedded storage).
   */
  transport?: 'stdio' | 'http';
  /** Daemon MCP URL (`http://<host>:<port>/mcp`). Required for `transport: 'http'`; loopback only. */
  url?: string;
  /** Executable that launches the MCP server (stdio; default `bun`). */
  command?: string;
  /** Args for the server invocation (stdio; default: the workspace-relative bin path). */
  args?: string[];
  /** Extra env entries merged under `env` (win over the defaults on key collision). */
  env?: Record<string, string>;
  /** `ONEMEMORY_MCP_PROFILE` — `default8` (default) or `full11` (ADR-0010 §2). */
  profile?: 'default8' | 'full11';
  /** Storage mode; `embedded` points `ONEMEMORY_DATA_DIR` at `${workspaceFolder}/.onememory`. */
  storage?: { mode: 'embedded'; dataDir?: string } | { mode: 'server' };
  /** `ONEMEMORY_PROJECT_ID` — the registered project id (not a secret). */
  projectId?: string;
  /** `ONEMEMORY_MCP_AGENT_ID` (default `cursor`). */
  agentId?: string;
}

/** `true` for `localhost`, `::1` and `127.0.0.0/8` (brackets tolerated, as URLs carry them). */
export function isLoopbackHostname(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}

/** A loopback `http:` URL — the only daemon endpoint Phase 1 scaffolds (no auth, no headers). */
export const LoopbackHttpUrlSchema = z
  .url({ protocol: /^http$/ })
  .refine((value) => isLoopbackHostname(new URL(value).hostname), {
    message: 'the daemon MCP URL must be a loopback address (Phase 1 has no authentication)',
  });

/**
 * Cursor's remote-server entry. No `type`: the docs' "Remote Server" example is `{url, headers}`,
 * and the field table does not list `type` for remote servers.
 */
export const CursorHttpServerEntrySchema = z.strictObject({
  url: LoopbackHttpUrlSchema,
});
export type CursorHttpServerEntry = z.infer<typeof CursorHttpServerEntrySchema>;

/** Cursor's stdio entry; `type: "stdio"` per the reference field table ("type | Yes"). */
export const CursorStdioServerEntrySchema = z.strictObject({
  type: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type CursorStdioServerEntry = z.infer<typeof CursorStdioServerEntrySchema>;

export const CursorServerEntrySchema = z.union([CursorHttpServerEntrySchema, CursorStdioServerEntrySchema]);
export type CursorServerEntry = z.infer<typeof CursorServerEntrySchema>;

/** The name of the onememory server inside `mcpServers`. */
export const MCP_SERVER_NAME = 'onememory';

export const CursorMcpDocumentSchema = z.strictObject({
  mcpServers: z.strictObject({ [MCP_SERVER_NAME]: CursorServerEntrySchema }),
});
export type CursorMcpDocument = z.infer<typeof CursorMcpDocumentSchema>;

/** The default server entry path (the workspace package bin; Bun runs the TS directly). */
export function defaultMcpServerArgs(): string[] {
  return ['${workspaceFolder}/node_modules/@onememory-ai/mcp/src/bin.ts'];
}

type StdioOptions = CursorMcpOptions & { transport?: 'stdio' };
type HttpOptions = CursorMcpOptions & { transport: 'http'; url: string };

/** The `onememory` server entry alone (what `patchCursorMcpJson` splices into a user's file). */
export function buildMcpServerEntry(options?: StdioOptions): CursorStdioServerEntry;
export function buildMcpServerEntry(options: HttpOptions): CursorHttpServerEntry;
export function buildMcpServerEntry(options?: CursorMcpOptions): CursorServerEntry;
export function buildMcpServerEntry(options: CursorMcpOptions = {}): CursorServerEntry {
  if (options.transport === 'http') {
    if (options.url === undefined) {
      throw new Error('buildMcpServerEntry: transport "http" requires the daemon MCP url');
    }
    return CursorHttpServerEntrySchema.parse({ url: options.url });
  }
  const storage = options.storage ?? { mode: 'embedded' as const };
  const env: Record<string, string> = {
    ONEMEMORY_MCP_AGENT_ID: options.agentId ?? 'cursor',
    ...(options.profile === undefined ? {} : { ONEMEMORY_MCP_PROFILE: options.profile }),
    ...(options.projectId === undefined ? {} : { ONEMEMORY_PROJECT_ID: options.projectId }),
    ...(storage.mode === 'server'
      ? // The URL never enters the file: the user's environment holds it (Cursor's `${env:…}`).
        { ONEMEMORY_PG_URL: '${env:ONEMEMORY_PG_URL}' }
      : { ONEMEMORY_DATA_DIR: storage.dataDir ?? '${workspaceFolder}/.onememory' }),
    ...options.env,
  };
  return CursorStdioServerEntrySchema.parse({
    type: 'stdio',
    command: options.command ?? 'bun',
    args: options.args ?? defaultMcpServerArgs(),
    env,
  });
}

/** The full `mcp.json` document for a fresh project. */
export function buildCursorMcpJson(options: CursorMcpOptions = {}): CursorMcpDocument {
  return CursorMcpDocumentSchema.parse({ mcpServers: { [MCP_SERVER_NAME]: buildMcpServerEntry(options) } });
}

export function renderCursorMcpJson(options: CursorMcpOptions = {}): string {
  return `${JSON.stringify(buildCursorMcpJson(options), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Idempotent patch
// ---------------------------------------------------------------------------

export type ScaffoldMergeAction = 'created' | 'patched' | 'unchanged';

export type ScaffoldMergeResult =
  | { ok: true; content: string; action: ScaffoldMergeAction }
  | { ok: false; error: string };

const JsonObjectSchema = z.record(z.string(), z.unknown());
const McpJsonShapeSchema = z.looseObject({ mcpServers: JsonObjectSchema.optional() });

function render(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Insert or replace `mcpServers.onememory` in an existing `.cursor/mcp.json` (`null` / blank → a
 * new document). Other servers and other top-level keys keep their position and content; an
 * unparseable or wrongly shaped file is reported, never overwritten.
 */
export function patchCursorMcpJson(existing: string | null, options: CursorMcpOptions = {}): ScaffoldMergeResult {
  const entry = buildMcpServerEntry(options);
  if (existing === null || existing.trim().length === 0) {
    return { ok: true, content: render({ mcpServers: { [MCP_SERVER_NAME]: entry } }), action: 'created' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    return {
      ok: false,
      error: `.cursor/mcp.json is not valid JSON and was left untouched (${
        error instanceof Error ? error.message : String(error)
      }) — fix it and re-run onemem init`,
    };
  }
  if (!isPlainObject(parsed) || !McpJsonShapeSchema.safeParse(parsed).success) {
    return {
      ok: false,
      error: '.cursor/mcp.json is not a JSON object with an object-valued "mcpServers" and was left untouched — fix it and re-run onemem init',
    };
  }
  const servers = isPlainObject(parsed['mcpServers']) ? parsed['mcpServers'] : {};
  // Spreading keeps an existing `onememory` key in its original position.
  const content = render({ ...parsed, mcpServers: { ...servers, [MCP_SERVER_NAME]: entry } });
  return { ok: true, content, action: content === existing ? 'unchanged' : 'patched' };
}
