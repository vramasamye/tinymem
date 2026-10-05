/**
 * `scaffoldCodex` — the one function `onemem init` calls to wire Codex (the init-wiring seam).
 *
 * What it writes (project scope, from the project root):
 *   `.codex/config.toml`  — the `[mcp_servers.onememory]` block (marker-fenced, idempotent)
 *   `.codex/hooks.json`    — the capture handlers (merged, idempotent)
 *   `AGENTS.md`            — the compact generated pointer block (marker-fenced, idempotent)
 *
 * User scope writes the same three artifacts under `$CODEX_HOME` (config.toml, hooks.json,
 * AGENTS.md — Codex reads the global layer from exactly those paths; verified:
 * https://learn.chatgpt.com/docs/agent-configuration/agents-md).
 *
 * The MCP block is the daemon-backed Streamable HTTP form when `transport: 'http'` + `url` are
 * passed (what `onemem init` does), else the stdio form. An invalid http `url` throws before any
 * file is touched; every other problem is reported through `warnings` / `skipped`.
 *
 * The function is deliberately filesystem-thin: all content decisions live in the pure
 * renderers, so `dryRun` returns the exact bytes without touching disk, and every artifact is
 * unit-tested on its own.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  patchAgentsMd,
  renderOnememoryAgentsBlock,
  hasOnememoryAgentsBlock,
  AGENTS_BLOCK_BEGIN_PREFIX,
} from './agents-md';
import {
  type CodexMcpScaffoldOptions,
  patchCodexConfigToml,
  renderCodexMcpServerToml,
} from './config-scaffold';
import {
  CAPTURE_BIN_TOKEN,
  PROJECT_CAPTURE_COMMAND,
  type CodexHooksScaffoldOptions,
  patchCodexHooksJson,
  renderCodexHooksJson,
} from './hooks-scaffold';

export type CodexScaffoldScope = 'project' | 'user';

export interface ScaffoldCodexOptions extends CodexMcpScaffoldOptions, CodexHooksScaffoldOptions {
  /** `project` writes into `<projectRoot>/.codex/` + `<projectRoot>/AGENTS.md`; `user` writes `$CODEX_HOME`. */
  scope: CodexScaffoldScope;
  /** Project root (project scope) or CODEX_HOME (user scope). */
  root: string;
  /** Compute the artifacts and return them without writing (default false). */
  dryRun?: boolean;
}

export interface ScaffoldedFile {
  /** Absolute path (or the would-be path in dry-run). */
  path: string;
  action: 'created' | 'patched' | 'unchanged' | 'skipped';
  /** The exact bytes written (or that would be written). */
  content: string;
}

export interface ScaffoldCodexResult {
  files: ScaffoldedFile[];
  /** Operator-facing notes (trust review, AGENTS.override.md, unparseable files, …). */
  warnings: string[];
}

export function scaffoldCodex(options: ScaffoldCodexOptions): ScaffoldCodexResult {
  const warnings: string[] = [];
  const files: ScaffoldedFile[] = [];

  const paths =
    options.scope === 'project'
      ? {
          configToml: join(options.root, '.codex', 'config.toml'),
          hooksJson: join(options.root, '.codex', 'hooks.json'),
          agentsMd: join(options.root, 'AGENTS.md'),
        }
      : {
          configToml: join(options.root, 'config.toml'),
          hooksJson: join(options.root, 'hooks.json'),
          agentsMd: join(options.root, 'AGENTS.md'),
        };

  // --- .codex/config.toml (the MCP server) -------------------------------------------
  const block = renderCodexMcpServerToml(options);
  const existingToml = readIfExists(paths.configToml);
  const patchedToml = patchCodexConfigToml(existingToml ?? '', block);
  files.push({
    path: paths.configToml,
    action: existingToml === null ? 'created' : patchedToml === existingToml ? 'unchanged' : 'patched',
    content: patchedToml,
  });
  if (existingToml === null && options.scope === 'project') {
    warnings.push(
      'project-scoped .codex/config.toml only loads for trusted projects — accept the trust prompt the first time you open the project in Codex',
    );
  }

  // --- .codex/hooks.json (the capture handlers) ----------------------------------------
  // The hooks renderers apply the published-layout default themselves; pick exactly the
  // hooks-relevant fields out of the combined options so MCP-only fields never leak in.
  const hookOptions: CodexHooksScaffoldOptions = {
    captureCommand: options.captureCommand ?? PROJECT_CAPTURE_COMMAND,
    ...(options.includeSessionStart === undefined ? {} : { includeSessionStart: options.includeSessionStart }),
    ...(options.includeCapture === undefined ? {} : { includeCapture: options.includeCapture }),
    ...(options.captureTimeoutSec === undefined ? {} : { captureTimeoutSec: options.captureTimeoutSec }),
  };
  const existingHooks = readIfExists(paths.hooksJson);
  let hooksContent: string;
  let hooksAction: ScaffoldedFile['action'];
  if (existingHooks === null) {
    hooksContent = renderCodexHooksJson(hookOptions);
    hooksAction = 'created';
  } else {
    const patched = patchCodexHooksJson(existingHooks, hookOptions);
    if ('error' in patched) {
      hooksContent = existingHooks;
      hooksAction = 'skipped';
      warnings.push(patched.error);
    } else {
      hooksContent = patched.content;
      hooksAction = patched.action;
    }
  }
  files.push({ path: paths.hooksJson, action: hooksAction, content: hooksContent });

  // --- AGENTS.md (the pointer block) ------------------------------------------------------
  const agentsBlock = renderOnememoryAgentsBlock({ projectId: options.projectId });
  const existingAgents = readIfExists(paths.agentsMd);
  const patchedAgents = patchAgentsMd(existingAgents ?? '', agentsBlock);
  const agentsAction: ScaffoldedFile['action'] =
    existingAgents === null ? 'created' : patchedAgents === existingAgents ? 'unchanged' : 'patched';
  if (
    existingAgents !== null &&
    existingAgents.includes(AGENTS_BLOCK_BEGIN_PREFIX) &&
    !hasOnememoryAgentsBlock(existingAgents, options.projectId)
  ) {
    warnings.push(
      `AGENTS.md has an orphaned onememory marker (a begin without an end) — it was left untouched; remove the stray marker and re-run onemem init`,
    );
  }
  files.push({ path: paths.agentsMd, action: agentsAction, content: patchedAgents });
  if (options.scope === 'project' && existsSync(join(options.root, 'AGENTS.override.md'))) {
    warnings.push(
      'AGENTS.override.md exists — Codex ignores AGENTS.md in that directory, so move the onememory pointer into the override file if you keep it',
    );
  }

  warnings.push(
    "run Codex and review the hooks once via /hooks — Codex skips untrusted hooks until you approve them, and capture silently waits until then",
  );

  if (options.dryRun !== true) {
    for (const file of files) {
      if (file.action === 'skipped' || file.action === 'unchanged') continue;
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, 'utf8');
    }
  }
  return { files, warnings };
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}
