/**
 * Agent-runtime wiring: the daemon MCP URL rule and the doctor's runtimes check group.
 *
 * One URL rule serves `onemem init` (what it scaffolds) and `onemem doctor` (what it expects):
 * `http://<daemon.host>:<daemon.port>/mcp`, read from the loaded config — the daemon mounts its
 * Streamable HTTP MCP handler at `/mcp` on that address (ADR-0010 amendment 2026-10-04).
 *
 * Wiring a runtime is opt-in, so an unwired runtime is `info`, never a warning or failure. A wired
 * runtime passes only when every artifact `onemem init` writes is present and its MCP URL is
 * exactly the configured daemon URL; anything else warns with the fix.
 */

import { inspectClaudeScaffold } from '@onememory/adapter-claude';
import { inspectCodexScaffold } from '@onememory/adapter-codex';

import type { DoctorCheck } from './doctor';

/** The path the daemon mounts its MCP handler at. */
export const DAEMON_MCP_PATH = '/mcp';

/** The daemon MCP URL for a config's `daemon` section — the single source of truth. */
export function daemonMcpUrl(daemon: { host: string; port: number }): string {
  return `http://${daemon.host}:${daemon.port}${DAEMON_MCP_PATH}`;
}

export type WiredRuntime = 'claude-code' | 'codex';

/** The scaffolded state of one runtime, normalized across adapters. */
export interface RuntimeScaffoldState {
  mcp: { path: string; state: 'absent' | 'invalid' | 'no_entry' | 'http' | 'stdio' | 'unrecognized'; url?: string; detail?: string };
  hooks: { path: string; state: 'absent' | 'invalid' | 'no_entry' | 'partial' | 'complete'; missing_events?: string[]; detail?: string };
  pointer: { path: string; present: boolean };
}

export interface RuntimeCheckContext {
  /** The configured daemon MCP URL ({@link daemonMcpUrl}). */
  expectedUrl: string;
  /** `embedded` storage has one owner (the daemon), so a stdio MCP entry is a hazard there. */
  storageProfile: 'embedded' | 'server';
}

const RUNTIME_LABELS: Record<WiredRuntime, { title: string; flag: string }> = {
  'claude-code': { title: 'Claude Code', flag: '--with-claude' },
  codex: { title: 'Codex', flag: '--with-codex' },
};

function isConfigured(state: RuntimeScaffoldState): boolean {
  return (
    !(state.mcp.state === 'absent' || state.mcp.state === 'no_entry') ||
    !(state.hooks.state === 'absent' || state.hooks.state === 'no_entry') ||
    state.pointer.present
  );
}

/** Judge one runtime's scaffolds against the configured daemon URL. */
export function evaluateRuntimeScaffold(
  runtime: WiredRuntime,
  state: RuntimeScaffoldState,
  context: RuntimeCheckContext,
): DoctorCheck {
  const { title, flag } = RUNTIME_LABELS[runtime];
  const id = `runtime-${runtime}`;
  const rerun = `onemem init ${flag}`;

  if (!isConfigured(state)) {
    return {
      id,
      title,
      status: 'info',
      detail: `not wired (opt-in): no onememory entries in ${state.mcp.path}, ${state.hooks.path} or ${state.pointer.path}`,
      remediation: `to wire it: ${rerun}`,
    };
  }

  const problems: string[] = [];
  const notes: string[] = [];
  let fixFileFirst: string | null = null;

  switch (state.mcp.state) {
    case 'absent':
    case 'no_entry':
      problems.push(`${state.mcp.path} has no onememory MCP server`);
      break;
    case 'invalid':
      problems.push(`${state.mcp.path} is unreadable: ${state.mcp.detail ?? 'invalid'}`);
      fixFileFirst = state.mcp.path;
      break;
    case 'unrecognized':
      problems.push(`${state.mcp.path}: ${state.mcp.detail ?? 'unrecognized onememory entry'}`);
      break;
    case 'stdio':
      if (context.storageProfile === 'embedded') {
        problems.push(
          `${state.mcp.path} has a stdio onememory server — with embedded storage it would open the data directory beside the daemon (one owner only); init scaffolds the daemon URL ${context.expectedUrl}`,
        );
      } else {
        notes.push(`MCP: stdio server in ${state.mcp.path} (safe with server-profile storage)`);
      }
      break;
    case 'http':
      if (state.mcp.url === context.expectedUrl) {
        notes.push(`MCP → ${context.expectedUrl} (matches daemon.host/daemon.port)`);
      } else {
        problems.push(
          `${state.mcp.path} points MCP at ${state.mcp.url ?? '(none)'} but the configured daemon serves ${context.expectedUrl}`,
        );
      }
      break;
  }

  switch (state.hooks.state) {
    case 'complete':
      notes.push(`hooks in ${state.hooks.path}`);
      break;
    case 'partial':
      problems.push(`${state.hooks.path} is missing onememory hooks for ${(state.hooks.missing_events ?? []).join(', ')}`);
      break;
    case 'invalid':
      problems.push(`${state.hooks.path} is unreadable: ${state.hooks.detail ?? 'invalid'}`);
      fixFileFirst ??= state.hooks.path;
      break;
    case 'absent':
    case 'no_entry':
      problems.push(`${state.hooks.path} has no onememory hooks`);
      break;
  }

  if (state.pointer.present) notes.push(`pointer in ${state.pointer.path}`);
  else problems.push(`${state.pointer.path} has no onememory pointer block`);

  if (problems.length === 0) {
    return { id, title, status: 'pass', detail: notes.join('; ') };
  }
  return {
    id,
    title,
    status: 'warn',
    detail: `partially or inconsistently wired: ${problems.join('; ')}`,
    remediation:
      fixFileFirst === null
        ? `re-run ${rerun} (the merges are idempotent and keep your own entries)`
        : `fix ${fixFileFirst} (init never overwrites a file it cannot parse), then re-run ${rerun}`,
  };
}

/** Read the project-scope Claude Code and Codex scaffolds under `root` and judge both. */
export function runtimeScaffoldChecks(
  root: string,
  context: RuntimeCheckContext & { projectId?: string },
): DoctorCheck[] {
  const claude = inspectClaudeScaffold(root);
  const codex = inspectCodexScaffold(root, context.projectId === undefined ? {} : { projectId: context.projectId });
  return [
    evaluateRuntimeScaffold(
      'claude-code',
      { mcp: claude.mcp_json, hooks: claude.settings_hooks, pointer: claude.pointer },
      context,
    ),
    evaluateRuntimeScaffold(
      'codex',
      { mcp: codex.config_toml, hooks: codex.hooks_json, pointer: { path: codex.agents_md.path, present: codex.agents_md.present } },
      context,
    ),
  ];
}
