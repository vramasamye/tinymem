/**
 * Runtime-native config scaffolds for `onemem init` (pure functions + tests; the CLI owns the
 * actual writes — merge helpers live in `scaffold-merge.ts`, doctor inspection in
 * `scaffold-inspect.ts`).
 *
 * Every emitted document is validated against its Zod schema before it leaves (a scaffold bug is
 * a test failure, never a broken runtime config). Shapes follow the Claude Code references:
 * - `.mcp.json`: `{"mcpServers": {"onememory": {"type": "http", "url": …}}}` for the daemon's
 *   Streamable HTTP `/mcp` surface (what `onemem init` emits — ADR-0010 amendment 2026-10-04), or
 *   the stdio `{command, args?, env}` form, which needs no `type`
 *   (https://code.claude.com/docs/en/mcp). `${VAR}` expansion works in `command` and `args` of
 *   project-scoped entries; values referencing `CLAUDE_PROJECT_DIR` require the `${VAR:-default}`
 *   form, which Claude Code itself sets for stdio servers. The stdio `command` is the `onemem-mcp`
 *   `bin` entry as a clean install links it (`node_modules/.bin/`), directly executable via its
 *   bun shebang — the invocation survives a clean external install (backlog cross-follow-up #9:
 *   never a monorepo-relative `src/*.ts` path).
 * - `.claude/settings.json` hooks: `{Event: [{matcher?, hooks: [{type: "command", …}]}]}`
 *   (https://code.claude.com/docs/en/hooks). Exec form (`args` set) with the
 *   `${CLAUDE_PROJECT_DIR}` path placeholder inside `command` — Claude Code substitutes path
 *   placeholders into `command` and each `args` element as plain strings, and its own docs use
 *   exactly this shape (`"command": "${CLAUDE_PROJECT_DIR}/…", "args": []`). The handler invokes
 *   the `onemem-claude-hook` bin link from the published install's `node_modules/.bin`.
 * - AGENTS.md / MEMORY.md pointer block: ADR-0010 §7 — interop, not competition. A compact,
 *   generated pointer that states onememory owns project memory; never a duplicate knowledge base.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// .mcp.json — the MCP server entry (mission-5's `onemem-mcp` bin)
// ---------------------------------------------------------------------------

export interface McpJsonOptions {
  /**
   * `stdio` (default — backward compatible) spawns the standalone `onemem-mcp` bin; `http`
   * points Claude Code at the daemon's Streamable HTTP `/mcp` surface (ADR-0010 amendment
   * 2026-10-04: the daemon is the single owner of embedded storage, so `onemem init` scaffolds
   * this form). With `http`, only `url` is used; every stdio option below is ignored.
   */
  transport?: 'stdio' | 'http';
  /**
   * The daemon MCP URL (`http://<daemon.host>:<daemon.port>/mcp`). Required when `transport` is
   * `http`; must be an `http:` loopback URL — Phase 1 has no authentication, so no headers are
   * emitted and a non-loopback endpoint is refused.
   */
  url?: string;
  /**
   * Executable that launches the MCP server (stdio). Default: the `onemem-mcp` bin link in the
   * PUBLISHED install (`${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/onemem-mcp`) — every `bin`
   * declared in package.json is linked into `node_modules/.bin` by npm/bun, and the entrypoint
   * carries a `bun` shebang so it is directly executable. Pass e.g. `{command: 'bun', args:
   * ['src/bin.ts']}` only for a source checkout.
   */
  command?: string;
  /** Args for the server invocation. Default: none (the bin is env-configured, no wrapper). */
  args?: string[];
  /** Extra env entries merged under `env` (win over the defaults on key collision). */
  env?: Record<string, string>;
  /** `ONEMEMORY_MCP_PROFILE` — `default8` (default) or `full11`. */
  profile?: 'default8' | 'full11';
  /**
   * Storage mode for the MCP server. `embedded` points `ONEMEMORY_DATA_DIR` at the project's
   * `.onememory` (single-owner with `onemem serve` — see README "One owner per data dir");
   * `server` passes `ONEMEMORY_PG_URL` through from the user's environment by NAME so no URL
   * is ever committed.
   */
  storage?: { mode: 'embedded'; dataDir?: string } | { mode: 'server' };
  /** `ONEMEMORY_PROJECT_ID` — the registered project id (not a secret; it lives in project.json). */
  projectId?: string;
  /** `ONEMEMORY_MCP_AGENT_ID` (default `claude-code`). */
  agentId?: string;
}

export const McpStdioServerEntrySchema = z.looseObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpStdioServerEntry = z.infer<typeof McpStdioServerEntrySchema>;

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
 * Claude Code's remote-server entry: `{"type": "http", "url": …}` — a `url` without `type` is
 * read as a (broken) stdio server, so `type` is mandatory (https://code.claude.com/docs/en/mcp).
 */
export const McpHttpServerEntrySchema = z.looseObject({
  type: z.literal('http'),
  url: LoopbackHttpUrlSchema,
});
export type McpHttpServerEntry = z.infer<typeof McpHttpServerEntrySchema>;

export const McpServerEntrySchema = z.union([McpHttpServerEntrySchema, McpStdioServerEntrySchema]);
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

export const McpJsonDocumentSchema = z.strictObject({
  mcpServers: z.strictObject({ onememory: McpServerEntrySchema }),
});
export type McpJsonDocument = z.infer<typeof McpJsonDocumentSchema>;

/**
 * The default stdio server command: the `onemem-mcp` bin entry as a clean install links it.
 *
 * npm/bun link every `bin` declared in a published package's package.json into
 * `node_modules/.bin/`, so this path exists in ANY external project that installed onememory
 * (hoisted layout) — the invocation never assumes the onememory monorepo or a `src/*.ts` source
 * path. The `${CLAUDE_PROJECT_DIR:-.}` form is required: project-scoped `.mcp.json` entries
 * expand `${VAR}` in `command`/`args`, and `CLAUDE_PROJECT_DIR` is set for stdio servers by
 * Claude Code itself (its own docs mandate the `:-default` for exactly this reference). The bin
 * entrypoint is directly executable through its `#!/usr/bin/env bun` shebang.
 */
export function defaultMcpServerCommand(): string {
  return '${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/onemem-mcp';
}

type StdioMcpJsonOptions = McpJsonOptions & { transport?: 'stdio' };
type HttpMcpJsonOptions = McpJsonOptions & { transport: 'http'; url: string };

export function buildMcpJson(options?: StdioMcpJsonOptions): { mcpServers: { onememory: McpStdioServerEntry } };
export function buildMcpJson(options: HttpMcpJsonOptions): { mcpServers: { onememory: McpHttpServerEntry } };
export function buildMcpJson(options?: McpJsonOptions): McpJsonDocument;
export function buildMcpJson(options: McpJsonOptions = {}): McpJsonDocument {
  return McpJsonDocumentSchema.parse({ mcpServers: { onememory: buildMcpServerEntry(options) } });
}

/** The `onememory` server entry alone (what `mergeMcpJson` splices into a user's file). */
export function buildMcpServerEntry(options?: StdioMcpJsonOptions): McpStdioServerEntry;
export function buildMcpServerEntry(options: HttpMcpJsonOptions): McpHttpServerEntry;
export function buildMcpServerEntry(options?: McpJsonOptions): McpServerEntry;
export function buildMcpServerEntry(options: McpJsonOptions = {}): McpServerEntry {
  if (options.transport === 'http') {
    if (options.url === undefined) {
      throw new Error('buildMcpServerEntry: transport "http" requires the daemon MCP url');
    }
    return McpHttpServerEntrySchema.parse({ type: 'http', url: options.url });
  }
  const storage = options.storage ?? { mode: 'embedded' as const };
  const env: Record<string, string> = {
    // Claude Code sets CLAUDE_PROJECT_DIR for stdio servers natively; making it explicit keeps the
    // entry self-describing and lets other hosts that read .mcp.json provide it the same way.
    CLAUDE_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}',
    ONEMEMORY_MCP_AGENT_ID: options.agentId ?? 'claude-code',
    ...(options.profile === undefined ? {} : { ONEMEMORY_MCP_PROFILE: options.profile }),
    ...(options.projectId === undefined ? {} : { ONEMEMORY_PROJECT_ID: options.projectId }),
    ...(storage.mode === 'server'
      ? // The URL never enters the file: the user's environment holds it, Claude Code expands it.
        { ONEMEMORY_PG_URL: '${ONEMEMORY_PG_URL}' }
      : { ONEMEMORY_DATA_DIR: storage.dataDir ?? '${CLAUDE_PROJECT_DIR:-.}/.onememory' }),
    ...options.env,
  };
  return McpStdioServerEntrySchema.parse({
    command: options.command ?? defaultMcpServerCommand(),
    ...(options.args === undefined ? {} : { args: options.args }),
    env,
  });
}

export function renderMcpJson(options: McpJsonOptions = {}): string {
  return `${JSON.stringify(buildMcpJson(options), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// .claude/settings.json — the hooks configuration
// ---------------------------------------------------------------------------

export interface HookInvocation {
  /**
   * Executable (exec form: `args` present → spawned directly with `args` as the argv, no shell;
   * path placeholders are substituted as plain strings). Default: the `onemem-claude-hook` bin
   * link from the published install (`${CLAUDE_PROJECT_DIR}/node_modules/.bin/…`).
   */
  command: string;
  /**
   * Argument vector; omit for a shell-form command string, pass `[]` to run a path-only command
   * in exec form (the Claude Code docs' own pattern). Default: `[]`.
   */
  args?: string[];
}

export interface HooksConfigOptions {
  /** How to invoke the hook bin; default: exec form on the published bin link. */
  hook?: HookInvocation;
}

/**
 * The default hook invocation's command: the `onemem-claude-hook` bin entry as a clean install
 * links it (`node_modules/.bin/`), expanded by Claude Code — the same published-layout rule as
 * `defaultMcpServerCommand`, so the generated hooks survive a clean external install.
 */
export function defaultHookCommand(): string {
  return '${CLAUDE_PROJECT_DIR}/node_modules/.bin/onemem-claude-hook';
}

const HookHandlerSchema = z.looseObject({
  type: z.literal('command'),
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  /** Common hook field, in SECONDS (hooks reference: "Common fields"). */
  timeout: z.number().int().min(1).max(60).optional(),
});

export const HooksConfigSchema = z.strictObject({
  hooks: z.strictObject({
    SessionStart: z.array(z.looseObject({ hooks: z.array(HookHandlerSchema) })).min(1),
    SessionEnd: z.array(z.looseObject({ hooks: z.array(HookHandlerSchema) })).min(1),
    Stop: z.array(z.looseObject({ hooks: z.array(HookHandlerSchema) })).min(1),
    /** Command + file-edit tools (translate to terminal.output / file.changed). */
    PostToolUse: z.array(z.looseObject({ matcher: z.string().min(1), hooks: z.array(HookHandlerSchema) })).min(1),
    /** Every tool failure (translate to error.raised). */
    PostToolUseFailure: z.array(z.looseObject({ matcher: z.string().min(1), hooks: z.array(HookHandlerSchema) })).min(1),
  }),
});
export type HooksConfig = z.infer<typeof HooksConfigSchema>;

export function buildClaudeHooksConfig(options: HooksConfigOptions = {}): HooksConfig {
  // Exec form (`args` set) per the hooks reference: placeholders are substituted into `command`
  // and each `args` element as plain strings, with no shell to misquote the project path.
  const invocation = options.hook ?? { command: defaultHookCommand(), args: [] as string[] };
  const handler = {
    type: 'command' as const,
    command: invocation.command,
    ...(invocation.args === undefined ? {} : { args: invocation.args }),
  };
  const document: HooksConfig = {
    hooks: {
      // No matcher: every SessionStart injects context; the translator decides by `source`.
      SessionStart: [{ hooks: [{ ...handler }] }],
      // SessionEnd hooks share a 1.5s budget by default; raise it so the last event is not cut off.
      SessionEnd: [{ hooks: [{ ...handler, timeout: 5 }] }],
      // Stop has no matcher support (fires per turn).
      Stop: [{ hooks: [{ ...handler }] }],
      // Only the tools with an honest mapping spawn a process (Read/Grep must not cost a spawn).
      PostToolUse: [{ matcher: 'Bash|PowerShell|Edit|Write|NotebookEdit', hooks: [{ ...handler }] }],
      // Any tool failure is an honest error event ("*" matches all).
      PostToolUseFailure: [{ matcher: '*', hooks: [{ ...handler }] }],
    },
  };
  return HooksConfigSchema.parse(document);
}

export function renderClaudeSettingsHooks(options: HooksConfigOptions = {}): string {
  return `${JSON.stringify(buildClaudeHooksConfig(options), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// AGENTS.md / MEMORY.md pointer block (ADR-0010 §7 — interop, not competition)
// ---------------------------------------------------------------------------

export const MEMORY_POINTER_BEGIN = '<!-- onemem:begin (generated by `onemem init` — do not edit inside this block) -->';
export const MEMORY_POINTER_END = '<!-- onemem:end -->';

export interface PointerBlockOptions {
  /** Project name used in the heading (optional — omit for a generic block). */
  projectName?: string;
}

/**
 * The compact generated pointer: states that onememory owns project memory, how to read/write it,
 * and that Claude Code's own memory surfaces stay valid ingest sources — never a duplicate
 * knowledge base (ADR-0010 §7). Keep it short: AGENTS.md text is injected into every session.
 */
export function buildMemoryPointerBlock(options: PointerBlockOptions = {}): string {
  const heading = options.projectName === undefined ? 'Project memory (onememory)' : `Project memory for ${options.projectName} (onememory)`;
  return [
    MEMORY_POINTER_BEGIN,
    `## ${heading}`,
    '',
    'Durable project memory — decisions, failures, procedures, preferences — lives in onememory,',
    'not in this file. Do not hand-maintain a duplicate knowledge base here.',
    '',
    '- A SessionStart hook injects a compact, token-budgeted memory index into every session.',
    '- Use the `mcp__onememory__*` MCP tools (`memory_search`, `memory_get`, `memory_store`, …) to',
    '  read and write memories on demand.',
    '- `onemem remember "<content>"` stores an explicit memory; `onemem search "<query>"` searches.',
    "- Claude Code auto-memory (MEMORY.md) and this file's conventions stay readable; onememory",
    '  treats them as ingest sources and pointers, never as the system of record.',
    MEMORY_POINTER_END,
  ].join('\n');
}

/**
 * Merge the pointer block into an existing document idempotently: any previous block between the
 * markers is replaced; absent markers append at the end (separated by a blank line). Pure — the
 * coordinator performs the write.
 */
export function mergeMemoryPointerBlock(existing: string, block: string): string {
  if (existing.includes(MEMORY_POINTER_BEGIN)) {
    const pattern = new RegExp(
      `${escapeRegExp(MEMORY_POINTER_BEGIN)}[\\s\\S]*?${escapeRegExp(MEMORY_POINTER_END)}`,
    );
    return existing.replace(pattern, block);
  }
  const trimmed = existing.replace(/\s+$/, '');
  if (trimmed.length === 0) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
