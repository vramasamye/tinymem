/**
 * Read-only inspection of the project-scope Codex scaffolds, for `onemem doctor`.
 *
 * Reports what is on disk; the doctor compares the MCP URL with the configured daemon URL and
 * decides the status. `config.toml` is read with a real TOML parser (smol-toml) — the scaffold
 * writes TOML as text to preserve user comments, but reading it back must honour the full grammar
 * (a user may have reformatted or hand-edited the table).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import { AGENTS_BLOCK_BEGIN_PREFIX, AGENTS_BLOCK_END_MARKER, hasOnememoryAgentsBlock } from './agents-md';
import { CODEX_TOML_BEGIN_MARKER, ONEMEMORY_MCP_SERVER_NAME } from './config-scaffold';
import { CAPTURE_BIN_TOKEN, buildCodexHooksFile } from './hooks-scaffold';

export type CodexConfigInspection =
  | { state: 'absent' }
  | { state: 'invalid'; detail: string }
  | { state: 'no_entry' }
  | { state: 'http'; url: string; managed: boolean }
  | { state: 'stdio'; managed: boolean }
  | { state: 'unrecognized'; detail: string };

export type CodexHooksInspection =
  | { state: 'absent' }
  | { state: 'invalid'; detail: string }
  | { state: 'no_entry' }
  | { state: 'partial'; missing_events: string[] }
  | { state: 'complete' };

export interface CodexScaffoldInspection {
  config_toml: { path: string } & CodexConfigInspection;
  hooks_json: { path: string } & CodexHooksInspection;
  agents_md: { path: string; present: boolean };
}

const ConfigSchema = z.looseObject({ mcp_servers: z.record(z.string(), z.unknown()).optional() });
const HttpServerSchema = z.looseObject({ url: z.string() });
const StdioServerSchema = z.looseObject({ command: z.string() });
const HooksFileSchema = z.looseObject({ hooks: z.record(z.string(), z.unknown()) });
const GroupSchema = z.looseObject({ hooks: z.array(z.unknown()) });
const HandlerSchema = z.looseObject({ command: z.string() });

/** Classify the `[mcp_servers.onememory]` table of a `config.toml` (`null` = file absent). */
export function inspectCodexConfigContent(text: string | null): CodexConfigInspection {
  if (text === null) return { state: 'absent' };
  let parsed: unknown;
  try {
    parsed = parseToml(text);
  } catch (error) {
    return { state: 'invalid', detail: `not valid TOML (${error instanceof Error ? error.message : String(error)})` };
  }
  const config = ConfigSchema.safeParse(parsed);
  if (!config.success) return { state: 'invalid', detail: '"mcp_servers" is not a table' };
  const server = config.data.mcp_servers?.[ONEMEMORY_MCP_SERVER_NAME];
  if (server === undefined) return { state: 'no_entry' };
  const managed = text.includes(CODEX_TOML_BEGIN_MARKER);
  const http = HttpServerSchema.safeParse(server);
  if (http.success) return { state: 'http', url: http.data.url, managed };
  if (StdioServerSchema.safeParse(server).success) return { state: 'stdio', managed };
  return { state: 'unrecognized', detail: 'the onememory server has neither a url nor a command' };
}

/**
 * Which of the generated hook events carry an onememory capture handler.
 *
 * The default needle is the bin NAME (`CAPTURE_BIN_TOKEN`), a substring of every invocation form
 * this package ever scaffolded — the previous bare-name PATH default included — so the doctor
 * keeps reporting pre-existing installs as wired while `onemem init` migrates them.
 */
export function inspectCodexHooksContent(text: string | null, captureCommand: string = CAPTURE_BIN_TOKEN): CodexHooksInspection {
  if (text === null) return { state: 'absent' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { state: 'invalid', detail: `not valid JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const file = HooksFileSchema.safeParse(parsed);
  if (!file.success) return { state: 'invalid', detail: 'no object-valued "hooks"' };
  const events = Object.keys(buildCodexHooksFile({ captureCommand }).hooks);
  const missing = events.filter((event) => {
    const groups = file.data.hooks[event];
    if (!Array.isArray(groups)) return true;
    return !groups.some((group) => {
      const shape = GroupSchema.safeParse(group);
      return (
        shape.success &&
        shape.data.hooks.some((handler) => {
          const parsedHandler = HandlerSchema.safeParse(handler);
          return parsedHandler.success && parsedHandler.data.command.includes(captureCommand);
        })
      );
    });
  });
  if (missing.length === events.length) return { state: 'no_entry' };
  if (missing.length > 0) return { state: 'partial', missing_events: missing };
  return { state: 'complete' };
}

/** `true` when AGENTS.md holds a complete onememory block (for `projectId` when given). */
export function hasCodexAgentsBlock(text: string | null, projectId?: string): boolean {
  if (text === null) return false;
  if (projectId !== undefined) return hasOnememoryAgentsBlock(text, projectId);
  const begin = text.indexOf(AGENTS_BLOCK_BEGIN_PREFIX);
  return begin !== -1 && text.indexOf(AGENTS_BLOCK_END_MARKER, begin) !== -1;
}

/** The project-scope artifact paths `scaffoldCodex({ scope: 'project' })` writes. */
export function codexScaffoldPaths(root: string): { configToml: string; hooksJson: string; agentsMd: string } {
  return {
    configToml: join(root, '.codex', 'config.toml'),
    hooksJson: join(root, '.codex', 'hooks.json'),
    agentsMd: join(root, 'AGENTS.md'),
  };
}

/** Inspect the project-scope Codex scaffolds under `root`. */
export function inspectCodexScaffold(root: string, options: { projectId?: string } = {}): CodexScaffoldInspection {
  const paths = codexScaffoldPaths(root);
  return {
    config_toml: { path: paths.configToml, ...inspectCodexConfigContent(readIfExists(paths.configToml)) },
    hooks_json: { path: paths.hooksJson, ...inspectCodexHooksContent(readIfExists(paths.hooksJson)) },
    agents_md: { path: paths.agentsMd, present: hasCodexAgentsBlock(readIfExists(paths.agentsMd), options.projectId) },
  };
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}
