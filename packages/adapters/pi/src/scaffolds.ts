/**
 * Runtime-native config scaffolds for `onemem init` (pure functions; the writes live in
 * `scaffold.ts`, doctor inspection in `scaffold-inspect.ts`).
 *
 * Every emitted document is validated against its Zod schema before it leaves (a scaffold bug is a
 * test failure, never a broken runtime config). Shapes follow Pi's own references (verified
 * 2026-10-06, mission 9):
 * - `.pi/mcp.json` / `~/.pi/agent/mcp.json` (https://pi.dev/docs/latest/mcp):
 *   `{"mcpServers": {"<name>": {"url": …} | {"command", "args", "env", "cwd"}}}` — a `url` selects
 *   streamable HTTP (SSE is REJECTED by Pi), a `command` selects stdio; `type` is optional. Both
 *   forms take `timeout` (seconds, default 60), `enabled`, `exposure`/`toolExposure`, and
 *   `description` (one sentence — listed in the system prompt, ranked by tool search, returned by
 *   codemode's describeNamespace). Server names: letters, digits, `_`, `-` only. `${VAR}` expands
 *   in `env`/`headers` values. Project `.pi/mcp.json` is read only after project trust is granted,
 *   and a project entry replaces a user-level entry with the same name.
 * - `.pi/extensions/` / `~/.pi/agent/extensions/` (https://pi.dev/docs/latest/extensions and
 *   https://pi.dev/docs/latest/configuration): TypeScript modules loaded via jiti — the generated
 *   shim imports this package and registers the capture handlers.
 * - `.pi/APPEND_SYSTEM.md` (https://pi.dev/docs/latest/configuration): "Adds project-specific
 *   instructions to Pi's system prompt" — the pointer-block channel (the trusted project file takes
 *   precedence over the agent-directory file).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// .pi/mcp.json — the MCP server entry
// ---------------------------------------------------------------------------

export const MCP_SERVER_NAME = 'onememory';

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

/** Pi's exposure vocabulary (https://pi.dev/docs/latest/mcp#control-tool-exposure). */
export const PiToolExposureSchema = z.enum(['direct', 'deferred', 'codemode', 'model-only', 'hidden']);
export type PiToolExposure = z.infer<typeof PiToolExposureSchema>;

/** Pi's streamable-HTTP entry: `url` selects the transport (SSE is rejected by Pi). */
export const PiMcpHttpEntrySchema = z.looseObject({
  url: LoopbackHttpUrlSchema,
  description: z.string().min(1).optional(),
  exposure: PiToolExposureSchema.optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().optional(),
});
export type PiMcpHttpEntry = z.infer<typeof PiMcpHttpEntrySchema>;

/** Pi's stdio entry: `command` + `args` (one executable, not a shell string), `env`, `cwd`. */
export const PiMcpStdioEntrySchema = z.looseObject({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  description: z.string().min(1).optional(),
  exposure: PiToolExposureSchema.optional(),
  enabled: z.boolean().optional(),
  timeout: z.number().optional(),
});
export type PiMcpStdioEntry = z.infer<typeof PiMcpStdioEntrySchema>;

export const PiMcpServerEntrySchema = z.union([PiMcpHttpEntrySchema, PiMcpStdioEntrySchema]);
export type PiMcpServerEntry = z.infer<typeof PiMcpServerEntrySchema>;

export const PiMcpJsonDocumentSchema = z.looseObject({
  mcpServers: z.record(z.string(), PiMcpServerEntrySchema),
});
export type PiMcpJsonDocument = z.infer<typeof PiMcpJsonDocumentSchema>;

export interface PiMcpOptions {
  /** `http` (default) points Pi at the daemon's Streamable HTTP `/mcp` surface — what init emits. */
  transport?: 'http' | 'stdio';
  /** The daemon MCP URL (`http://<daemon.host>:<daemon.port>/mcp`); required for `http`. */
  url?: string;
  /** Executable for the standalone stdio MCP bin (default `"bun"`). */
  command?: string;
  /** Stdio args; default the workspace-relative bin (resolved against the session directory). */
  args?: string[];
  /** Extra env merged under `env` (stdio). */
  env?: Record<string, string>;
  /** Working directory for the stdio server (relative resolves against the session directory). */
  cwd?: string;
  /** `ONEMEMORY_PROJECT_ID` in the stdio server env (the daemon profile needs no env). */
  projectId?: string;
  /** `scope.agent_id` for the MCP server (default `pi`). */
  agentId?: string;
  /** Server `exposure` (default `direct` — see `DEFAULT_EXPOSURE`). */
  exposure?: PiToolExposure;
}

/**
 * `direct` by default: the 8 onememory tools are a small, frequently-used set, and memory recall
 * only happens when the model sees `memory_search` in its tool declarations. Pi's `codemode`
 * default hides them behind scripts (the agent will not spontaneously search its memory), and
 * `deferred` costs a tool_search round-trip for a call the agent should be able to make directly.
 * Override with `exposure` for codemode-native setups.
 */
export const DEFAULT_EXPOSURE: PiToolExposure = 'direct';

/** The one-sentence server description Pi surfaces in the system prompt / tool search ranking. */
export const ONEMEMORY_SERVER_DESCRIPTION =
  'Search, store, and recall durable project memories (decisions, failures, procedures, preferences) for this project.';

/**
 * The `onememory` server entry alone (what the merge splices into a user's mcp.json). Throws when
 * `http` (the default transport) has no url, before anything is written.
 */
export function buildPiMcpServerEntry(options: PiMcpOptions = {}): PiMcpServerEntry {
  if (options.transport === 'http' || options.transport === undefined) {
    if (options.url === undefined) {
      throw new Error('buildPiMcpServerEntry: transport "http" requires the daemon MCP url');
    }
    return PiMcpHttpEntrySchema.parse({
      url: options.url,
      description: ONEMEMORY_SERVER_DESCRIPTION,
      exposure: options.exposure ?? DEFAULT_EXPOSURE,
      enabled: true,
    });
  }
  const entry: PiMcpStdioEntry = {
    command: options.command ?? 'bun',
    args: options.args ?? ['node_modules/@onememory/mcp/src/bin.ts'],
    cwd: options.cwd ?? '.',
    env: {
      ONEMEMORY_MCP_AGENT_ID: options.agentId ?? 'pi',
      ...(options.projectId === undefined ? {} : { ONEMEMORY_PROJECT_ID: options.projectId }),
      ...options.env,
    },
    description: ONEMEMORY_SERVER_DESCRIPTION,
    exposure: options.exposure ?? DEFAULT_EXPOSURE,
    enabled: true,
  };
  return PiMcpStdioEntrySchema.parse(entry);
}

/** The default stdio args: workspace-relative, resolved against the session (project) directory. */
export function defaultPiStdioArgs(): string[] {
  return ['node_modules/@onememory/mcp/src/bin.ts'];
}

export type PiMcpMergeResult =
  | { ok: true; content: string; action: 'created' | 'patched' | 'unchanged' }
  | { ok: false; error: string };

/**
 * Insert or replace `mcpServers.onememory` in an existing mcp.json (`null` / blank → a new
 * document). Other servers and other top-level keys keep their position and content; re-running
 * is byte-identical (`unchanged`). A file that is not valid JSON is an error and is never
 * overwritten — the user's file is theirs to fix. A server entry named `onememory` that is not
 * ours is replaced (a project entry replaces a same-name user entry by Pi's own rule).
 */
export function mergePiMcpJson(existing: string | null, options: PiMcpOptions = {}): PiMcpMergeResult {
  const entry = buildPiMcpServerEntry(options);
  if (existing === null || existing.trim().length === 0) {
    return { ok: true, content: render({ mcpServers: { [MCP_SERVER_NAME]: entry } }), action: 'created' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(existing);
  } catch (error) {
    return {
      ok: false,
      error: `mcp.json is not valid JSON and was left untouched (${error instanceof Error ? error.message : String(error)}) — fix it and re-run onemem init`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'mcp.json is not a JSON object and was left untouched — fix it and re-run onemem init' };
  }
  const document = parsed as { mcpServers?: unknown };
  const servers =
    typeof document.mcpServers === 'object' && document.mcpServers !== null && !Array.isArray(document.mcpServers)
      ? (document.mcpServers as Record<string, unknown>)
      : {};
  const merged = { ...document, mcpServers: { ...servers, [MCP_SERVER_NAME]: entry } };
  const content = render(merged);
  return { ok: true, content, action: content === existing ? 'unchanged' : 'patched' };
}

function render(document: unknown): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// .pi/extensions/onememory.ts — the generated extension shim
// ---------------------------------------------------------------------------

/** Header comment that marks the file as generated by onemem init. */
export const PI_EXTENSION_MARKER = 'onememory:generated (onemem init)';

/** The relative location of the extension inside the config tree (project or agent dir). */
export const PI_EXTENSION_RELPATH = 'extensions/onememory.ts';

/** The extension import specifier — the package the project already has installed. */
export const PI_ADAPTER_PACKAGE = '@onememory/adapter-pi';

/**
 * The generated extension file. A single default-export factory (Pi's documented extension shape:
 * "An extension exports a default factory that receives ExtensionAPI"); everything the factory
 * does lives in the adapter package, so regenerating never diverges from the shipped behavior.
 */
export function buildPiExtensionFile(): string {
  return [
    `/**`,
    ` * ${PI_EXTENSION_MARKER} — safe to re-run onemem init; hand edits will be replaced.`,
    ` * Registers onememory capture (session/tool/message events) and session-start context`,
    ` * injection. Remove this file to uninstall; see https://pi.dev/docs/latest/extensions.`,
    ` */`,
    `import { createPiExtension } from '${PI_ADAPTER_PACKAGE}';`,
    ``,
    `export default function onememory(pi: Parameters<typeof createPiExtension>[0]) {`,
    `  createPiExtension(pi);`,
    `}`,
    ``,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// APPEND_SYSTEM.md — the pointer block
// ---------------------------------------------------------------------------

export const PI_POINTER_BEGIN = '<!-- onemem:begin (generated by `onemem init` — do not edit inside this block) -->';
export const PI_POINTER_END = '<!-- onemem:end -->';

export interface PiPointerOptions {
  /** Project name used in the heading (optional — omit for a generic block). */
  projectName?: string;
}

/**
 * The compact generated pointer Pi appends to the system prompt: states that onememory owns
 * project memory, how to read and write it, and that Pi's own instruction surfaces stay valid —
 * never a duplicate knowledge base (ADR-0010 §7). Keep it short: APPEND_SYSTEM.md rides every
 * request in this project.
 */
export function buildPiPointerBlock(options: PiPointerOptions = {}): string {
  const heading = options.projectName === undefined ? 'Project memory (onememory)' : `Project memory for ${options.projectName} (onememory)`;
  return [
    PI_POINTER_BEGIN,
    `## ${heading}`,
    '',
    'Durable project memory — decisions, failures, procedures, preferences — lives in onememory,',
    'not in this file. Do not hand-maintain a duplicate knowledge base here.',
    '',
    '- The `mcp__onememory__*` tools (`memory_search`, `memory_get`, `memory_store`, …) read and',
    '  write memories on demand; `memory_search` returns a compact index first — fetch full records',
    '  with `memory_get` only for the IDs you need.',
    '- A session-start injection adds a compact, token-budgeted memory index to every session; treat',
    '  it as context, not as a script to follow.',
    "- `onemem remember \"<content>\"` stores an explicit memory; \"remember that …\" in your prompts is",
    '  captured automatically.',
    '- AGENTS.md / CLAUDE.md conventions stay readable; onememory treats them as ingest sources and',
    '  pointers, never as the system of record.',
    PI_POINTER_END,
  ].join('\n');
}

/**
 * Merge the pointer block into an existing APPEND_SYSTEM.md idempotently: any previous block
 * between the markers is replaced; absent markers append at the end (separated by a blank line);
 * a begin marker without an end marker is left untouched (orphaned — the caller warns). Pure —
 * the caller performs the write.
 */
export function mergePiPointerBlock(existing: string, block: string): string {
  if (existing.includes(PI_POINTER_BEGIN)) {
    const pattern = new RegExp(
      `${escapeRegExp(PI_POINTER_BEGIN)}[\\s\\S]*?${escapeRegExp(PI_POINTER_END)}`,
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
