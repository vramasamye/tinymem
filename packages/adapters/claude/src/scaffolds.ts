/**
 * Runtime-native config scaffolds for `onemem init` (pure functions + tests; the coordinator owns
 * the actual writes — see the init-wiring seam in mission-6.md §6).
 *
 * Every emitted document is validated against its Zod schema before it leaves (a scaffold bug is
 * a test failure, never a broken runtime config). Shapes follow the Claude Code references:
 * - `.mcp.json`: `{"mcpServers": {"onememory": {command, args, env}}}` — stdio needs no `type`
 *   (https://code.claude.com/docs/en/mcp). `${VAR}` expansion is used for values that must come
 *   from the user's environment (never committed); project-scoped entries referencing
 *   `CLAUDE_PROJECT_DIR` in command/args require the `${VAR:-default}` form, which Claude Code
 *   itself sets for stdio servers.
 * - `.claude/settings.json` hooks: `{Event: [{matcher?, hooks: [{type: "command", …}]}]}`
 *   (https://code.claude.com/docs/en/hooks). Exec form (`command` + `args`) is used because every
 *   invocation references the `${CLAUDE_PROJECT_DIR}` path placeholder, and exec form passes it
 *   without shell quoting.
 * - AGENTS.md / MEMORY.md pointer block: ADR-0010 §7 — interop, not competition. A compact,
 *   generated pointer that states onememory owns project memory; never a duplicate knowledge base.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// .mcp.json — the MCP server entry (mission-5's `onemem-mcp` bin)
// ---------------------------------------------------------------------------

export interface McpJsonOptions {
  /**
   * Executable that launches the MCP server (stdio). Default `"bun"` — the onememory install
   * requires Bun; pass e.g. `"node"` with a compiled entry when the coordinator publishes JS.
   */
  command?: string;
  /** Args for the server invocation. Default: the workspace-relative bin path (mission-5 bin). */
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

export const McpServerEntrySchema = z.looseObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type McpServerEntry = z.infer<typeof McpServerEntrySchema>;

export const McpJsonDocumentSchema = z.strictObject({
  mcpServers: z.strictObject({ onememory: McpServerEntrySchema }),
});
export type McpJsonDocument = z.infer<typeof McpJsonDocumentSchema>;

/** The default server entry path (the workspace package bin; Bun runs the TS directly). */
export function defaultMcpServerArgs(): string[] {
  return ['${CLAUDE_PROJECT_DIR:-.}/node_modules/@onememory/mcp/src/bin.ts'];
}

export function buildMcpJson(options: McpJsonOptions = {}): McpJsonDocument {
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
  const document: McpJsonDocument = {
    mcpServers: {
      onememory: {
        command: options.command ?? 'bun',
        args: options.args ?? defaultMcpServerArgs(),
        env,
      },
    },
  };
  return McpJsonDocumentSchema.parse(document);
}

export function renderMcpJson(options: McpJsonOptions = {}): string {
  return `${JSON.stringify(buildMcpJson(options), null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// .claude/settings.json — the hooks configuration
// ---------------------------------------------------------------------------

export interface HookInvocation {
  /** Executable (exec form: spawned directly, `args` as the argv — no shell quoting). */
  command: string;
  /** Argument vector; pass the hook script path here. */
  args?: string[];
}

export interface HooksConfigOptions {
  /** How to invoke the hook script; default `{command: "bun", args: [<adapter bin path>]}`. */
  hook?: HookInvocation;
}

/** The adapter's hook bin (one bin handles every event — the event name arrives on stdin). */
export function defaultHookArgs(): string[] {
  return ['${CLAUDE_PROJECT_DIR}/node_modules/@onememory/adapter-claude/src/bin.ts'];
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
  const invocation = options.hook ?? { command: 'bun', args: defaultHookArgs() };
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
