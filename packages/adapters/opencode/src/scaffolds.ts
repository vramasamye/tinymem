/**
 * The pure renderers + idempotent patchers for OpenCode's three surfaces (all content decisions
 * live here; `scaffold.ts` is filesystem-thin, so `dryRun` returns exact bytes):
 *
 * - `opencode.json` — the `mcp.onememory` entry (daemon Streamable HTTP, or stdio) plus the
 *   `instructions` entry that registers the pointer file. Wire format verified against the
 *   `@opencode-ai/sdk` `Config` type (McpRemoteConfig REQUIRES `type: "remote"`, McpLocalConfig
 *   `type: "local"` + `command: string[]`; `instructions: string[]` —
 *   https://opencode.ai/docs/rules/ "Custom Instructions"). The merge parses the file as STRICT
 *   JSON (the same contract as the Claude/Cursor merges): a file that does not parse — including
 *   JSONC with comments — is reported and left untouched, never overwritten. The user's other
 *   keys, servers and instruction entries keep their position and content; re-running is
 *   byte-identical (`unchanged`).
 * - `.opencode/plugins/onememory.ts` — the capture + injection plugin shim. Local plugin files in
 *   `.opencode/plugins/` are auto-loaded at startup (https://opencode.ai/docs/plugins/ "Files in
 *   these directories are automatically loaded at startup"), so NO config entry is needed.
 * - `.opencode/onememory.md` — the marker-fenced pointer block, registered via the config's
 *   `instructions` array (OpenCode's native always-applied rule surface — the Cursor
 *   `.cursor/rules/onememory.mdc` analog; the Codex adapter owns the `AGENTS.md` pointer, so this
 *   adapter does not write a second pointer into that file).
 *
 * Every emitted document is validated against its Zod schema before it leaves (a scaffold bug is
 * a test failure, never a broken runtime config).
 */

import { z } from 'zod';

import {
  LoopbackHttpUrlSchema,
  MCP_SERVER_NAME,
  OpenCodeMcpEntrySchema,
  type OpenCodeMcpEntry,
} from './wire';

// ---------------------------------------------------------------------------
// opencode.json — the MCP server entry
// ---------------------------------------------------------------------------

export interface OpenCodeMcpOptions {
  /**
   * `stdio` spawns the standalone `onemem-mcp` bin; `http` points OpenCode at the daemon's
   * Streamable HTTP `/mcp` surface (what `onemem init` emits — ADR-0010 amendment 2026-10-04: the
   * daemon is the single owner of embedded storage).
   */
  transport?: 'stdio' | 'http';
  /** Daemon MCP URL (`http://<host>:<port>/mcp`). Required for `transport: 'http'`; loopback only. */
  url?: string;
  /** Executable that launches the MCP server (stdio; default `bun`). */
  command?: string;
  /** Args for the server invocation (stdio; default: the project-relative bin path). */
  args?: string[];
  /** Extra env entries merged under `environment` (win on key collision). */
  env?: Record<string, string>;
  /** `ONEMEMORY_MCP_PROFILE` — `default8` (default) or `full11` (ADR-0010 §2). */
  profile?: 'default8' | 'full11';
  /** Storage mode; `embedded` points `ONEMEMORY_DATA_DIR` at the project's `.onememory`. */
  storage?: { mode: 'embedded'; dataDir?: string } | { mode: 'server' };
  /** `ONEMEMORY_PROJECT_ID` — the registered project id (not a secret). */
  projectId?: string;
  /** `ONEMEMORY_MCP_AGENT_ID` (default `opencode`). */
  agentId?: string;
}

/** The default server entry path (the workspace package bin; Bun runs the TS directly). */
export function defaultOpenCodeStdioArgs(): string[] {
  return ['node_modules/@onememory-ai/mcp/src/bin.ts'];
}

type StdioOptions = OpenCodeMcpOptions & { transport?: 'stdio' };
type HttpOptions = OpenCodeMcpOptions & { transport: 'http'; url: string };

/** The `mcp.onememory` entry alone (what `mergeOpenCodeConfigJson` splices into the user's file). */
export function buildOpenCodeMcpServerEntry(options?: StdioOptions): Extract<OpenCodeMcpEntry, { type: 'local' }>;
export function buildOpenCodeMcpServerEntry(options: HttpOptions): Extract<OpenCodeMcpEntry, { type: 'remote' }>;
export function buildOpenCodeMcpServerEntry(options?: OpenCodeMcpOptions): OpenCodeMcpEntry;
export function buildOpenCodeMcpServerEntry(options: OpenCodeMcpOptions = {}): OpenCodeMcpEntry {
  if (options.transport === 'http') {
    if (options.url === undefined) {
      throw new Error('buildOpenCodeMcpServerEntry: transport "http" requires the daemon MCP url');
    }
    // `type: "remote"` is REQUIRED by the SDK's McpRemoteConfig (verified) — the stricter reading
    // of the config schema, and OpenCode's own docs examples emit it.
    return { type: 'remote', url: LoopbackHttpUrlSchema.parse(options.url), enabled: true };
  }
  const storage = options.storage ?? { mode: 'embedded' as const };
  // OpenCode spawns local MCP servers with `{ ...process.env, ...entry.environment }`
  // (verified: opencode `mcp/index.ts` `connectLocal` — the parent environment is inherited and
  // the entry wins on collision). So server mode emits NO ONEMEMORY_PG_URL: the user's shell
  // carries it, and OpenCode has no `${env:…}` interpolation for MCP environment values — a
  // placeholder string would override the real inherited URL with a literal.
  const environment: Record<string, string> = {
    ONEMEMORY_MCP_AGENT_ID: options.agentId ?? 'opencode',
    ...(options.profile === undefined ? {} : { ONEMEMORY_MCP_PROFILE: options.profile }),
    ...(options.projectId === undefined ? {} : { ONEMEMORY_PROJECT_ID: options.projectId }),
    ...(storage.mode === 'server'
      ? {}
      : // Relative to the spawned server's cwd, which is the OpenCode project directory.
        { ONEMEMORY_DATA_DIR: storage.dataDir ?? '.onememory' }),
    ...options.env,
  };
  return OpenCodeMcpEntrySchema.parse({
    type: 'local',
    command: [options.command ?? 'bun', ...(options.args ?? defaultOpenCodeStdioArgs())],
    environment,
    enabled: true,
  }) as Extract<OpenCodeMcpEntry, { type: 'local' }>;
}

// ---------------------------------------------------------------------------
// opencode.json — the idempotent merge
// ---------------------------------------------------------------------------

export type ScaffoldMergeAction = 'created' | 'patched' | 'unchanged';

export type ScaffoldMergeResult =
  | { ok: true; content: string; action: ScaffoldMergeAction }
  | { ok: false; error: string };

/** The instructions-file entry this adapter registers (relative to the project root). */
export const OPENCODE_INSTRUCTIONS_ENTRY = '.opencode/onememory.md';

const JsonObjectSchema = z.record(z.string(), z.unknown());
const ConfigShapeSchema = z.looseObject({
  mcp: JsonObjectSchema.optional(),
  instructions: z.array(z.string()).optional(),
});

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function render(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

/**
 * Insert or replace `mcp.onememory` and the `instructions` entry in an existing `opencode.json`
 * (`null` / blank → a new document). Other servers, other instruction entries and every other
 * top-level key keep their position and content; re-running is byte-identical (`unchanged`).
 *
 * A file that is not valid STRICT JSON is an error and is never overwritten — OpenCode accepts
 * JSONC comments, but a comment-preserving JSONC rewrite is not something this merge fakes: the
 * user's file is theirs to fix (add the block manually, or drop the comments and re-run).
 */
export function mergeOpenCodeConfigJson(existing: string | null, options: OpenCodeMcpOptions = {}): ScaffoldMergeResult {
  const entry = buildOpenCodeMcpServerEntry(options);
  if (existing === null || existing.trim().length === 0) {
    return {
      ok: true,
      content: render({ $schema: 'https://opencode.ai/config.json', mcp: { [MCP_SERVER_NAME]: entry }, instructions: [OPENCODE_INSTRUCTIONS_ENTRY] }),
      action: 'created',
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    return {
      ok: false,
      error: `opencode.json is not valid JSON and was left untouched (${
        error instanceof Error ? error.message : String(error)
      }) — OpenCode accepts JSONC comments, but this idempotent merge does not rewrite them; add the mcp.onememory block and the ".opencode/onememory.md" instructions entry manually, or remove the comments and re-run onemem init`,
    };
  }
  if (!isPlainObject(parsed) || !ConfigShapeSchema.safeParse(parsed).success) {
    return {
      ok: false,
      error: 'opencode.json is not a JSON object with an object-valued "mcp" and an array-valued "instructions" and was left untouched — fix it and re-run onemem init',
    };
  }
  const servers = isPlainObject(parsed['mcp']) ? parsed['mcp'] : {};
  const instructions = Array.isArray(parsed['instructions']) ? parsed['instructions'] : [];
  const withInstruction = instructions.includes(OPENCODE_INSTRUCTIONS_ENTRY)
    ? instructions
    : [...instructions, OPENCODE_INSTRUCTIONS_ENTRY];
  // Spreading keeps existing keys in their original position.
  const content = render({
    ...parsed,
    mcp: { ...servers, [MCP_SERVER_NAME]: entry },
    instructions: withInstruction,
  });
  return { ok: true, content, action: content === existing ? 'unchanged' : 'patched' };
}

// ---------------------------------------------------------------------------
// .opencode/plugins/onememory.ts — the generated plugin shim
// ---------------------------------------------------------------------------

/** Header comment that marks the file as generated by onemem init. */
export const OPENCODE_PLUGIN_MARKER = 'onememory:generated (onemem init)';

/** The relative location of the plugin inside the project's `.opencode/` tree. */
export const OPENCODE_PLUGIN_RELPATH = 'plugins/onememory.ts';

/** The plugin import specifier — the package the project already has installed. */
export const OPENCODE_ADAPTER_PACKAGE = '@onememory-ai/adapter-opencode';

/**
 * The generated plugin file. One named export (OpenCode's documented plugin shape: "a
 * JavaScript/TypeScript module that exports one or more plugin functions" —
 * https://opencode.ai/docs/plugins/); everything the function does lives in the adapter package,
 * so regenerating never diverges from the shipped behavior. Local plugin files auto-load at
 * startup, so the config needs no `plugin` entry.
 */
export function buildOpenCodePluginFile(): string {
  return [
    `/**`,
    ` * ${OPENCODE_PLUGIN_MARKER} — safe to re-run onemem init; hand edits will be replaced.`,
    ` * Registers onememory capture (events, tool results, user messages) and session context`,
    ` * injection through the system-prompt transform. Remove this file to uninstall; see`,
    ` * https://opencode.ai/docs/plugins/.`,
    ` */`,
    `import { createOpenCodePlugin } from '${OPENCODE_ADAPTER_PACKAGE}';`,
    ``,
    `export const onememory = createOpenCodePlugin();`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// .opencode/onememory.md — the instructions pointer block
// ---------------------------------------------------------------------------

export const OPENCODE_POINTER_BEGIN = '<!-- onemem:begin (generated by `onemem init` — do not edit inside this block) -->';
export const OPENCODE_POINTER_END = '<!-- onemem:end -->';

export interface OpenCodePointerOptions {
  /** Project name used in the heading (optional — omit for a generic block). */
  projectName?: string;
}

/**
 * The compact generated pointer block, registered in the config's `instructions` array so it
 * rides every session (OpenCode's always-applied instruction surface). It states that onememory
 * owns project memory, how to read and write it, and that AGENTS.md conventions stay valid —
 * never a duplicate knowledge base (ADR-0010 §7). Keep it short: the block rides every request.
 */
export function buildOpenCodePointerBlock(options: OpenCodePointerOptions = {}): string {
  const heading =
    options.projectName === undefined
      ? 'Project memory (onememory)'
      : `Project memory for ${options.projectName} (onememory)`;
  return [
    OPENCODE_POINTER_BEGIN,
    `## ${heading}`,
    '',
    'Durable project memory — decisions, failures, procedures, preferences — lives in onememory,',
    'not in this file. Do not hand-maintain a duplicate knowledge base here.',
    '',
    '- Use the onememory MCP tools (`memory_search`, `memory_get`, `memory_store`, …) to read and',
    '  write memories on demand. `memory_search` returns a compact index first — fetch full records',
    '  with `memory_get` only for the IDs you need.',
    '- A system-prompt block adds a compact, token-budgeted memory index to each session (through',
    '  the `experimental.chat.system.transform` plugin hook, best-effort); treat it as context,',
    '  not as a script to follow.',
    '- `onemem remember "<content>"` stores an explicit memory; "remember that …" in your prompts is',
    '  captured automatically.',
    '- AGENTS.md conventions stay readable; onememory treats them as ingest sources and pointers,',
    '  never as the system of record.',
    OPENCODE_POINTER_END,
  ].join('\n');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `true` when the document holds a complete onememory pointer block (both markers, in order). */
export function hasOpenCodePointerBlock(text: string | null): boolean {
  if (text === null) return false;
  const begin = text.indexOf(OPENCODE_POINTER_BEGIN);
  return begin !== -1 && text.indexOf(OPENCODE_POINTER_END, begin) !== -1;
}

/**
 * Merge the pointer block into the instructions file: absent/blank → the block alone; our markers
 * present → only the fenced block is replaced; foreign content → the block is appended. Never
 * destructive: the function only ever inserts or replaces its own fenced block.
 */
export function mergeOpenCodePointerBlock(existing: string, block: string): string {
  if (hasOpenCodePointerBlock(existing)) {
    const pattern = new RegExp(`${escapeRegExp(OPENCODE_POINTER_BEGIN)}[\\s\\S]*?${escapeRegExp(OPENCODE_POINTER_END)}`);
    return existing.replace(pattern, block);
  }
  const trimmed = existing.replace(/\s+$/, '');
  if (trimmed.length === 0) return `${block}\n`;
  return `${trimmed}\n\n${block}\n`;
}
