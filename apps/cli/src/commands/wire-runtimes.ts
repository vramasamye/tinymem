/**
 * The scaffold phase of `onemem init`: detect agent runtimes, obtain consent, and wire the chosen
 * ones to the daemon's MCP surface (ADR-0010 amendment 2026-10-04).
 *
 * - Detection is filesystem-only (no spawning): Claude Code when `~/.claude` or `<root>/.claude`
 *   exists, Codex when `$CODEX_HOME`, `~/.codex` or `<root>/.codex` exists, Cursor when `~/.cursor`
 *   or `<root>/.cursor` exists. HOME comes from the injected environment, never from the OS, so
 *   tests cannot see the developer's real home.
 * - Consent: explicit `--with-claude` / `--with-codex` / `--with-cursor` flags, or the interactive
 *   multi-select (detected runtimes preselected). Without either, nothing is written — init never
 *   creates runtime files the user did not ask for.
 * - Writes: Claude Code files are merged here through the adapter's pure builders; Codex and Cursor
 *   files are written by the adapters' own scaffolds. Every step is idempotent, so the phase is
 *   safe to re-run, and files that cannot be parsed are reported and left untouched.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';

import {
  buildMemoryPointerBlock,
  claudeScaffoldPaths,
  isLoopbackHostname,
  mergeClaudeSettingsHooks,
  mergeMcpJson,
  mergeMemoryPointerBlock,
  type ScaffoldMergeResult,
} from '@onememory/adapter-claude';
import { scaffoldCodex } from '@onememory/adapter-codex';
import { scaffoldCursor } from '@onememory/adapter-cursor';

import type { Io } from '../io';
import type { Prompt } from '../prompt';

export type AgentRuntime = 'claude-code' | 'codex' | 'cursor';

export const AGENT_RUNTIMES: readonly AgentRuntime[] = ['claude-code', 'codex', 'cursor'];

export const RUNTIME_TITLES: Record<AgentRuntime, string> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
};

export const RUNTIME_FLAGS: Record<AgentRuntime, string> = {
  'claude-code': '--with-claude',
  codex: '--with-codex',
  cursor: '--with-cursor',
};

export type PathExists = (path: string) => boolean;

export interface RuntimeDetection {
  runtime: AgentRuntime;
  detected: boolean;
  /** The directories that matched (empty when not detected). */
  evidence: string[];
}

/** Filesystem-only runtime detection (see the module header for the rules). */
export function detectRuntimes(
  root: string,
  env: Record<string, string | undefined>,
  pathExists: PathExists = existsSync,
): RuntimeDetection[] {
  const home = env['HOME'] !== undefined && env['HOME'] !== '' ? env['HOME'] : null;
  const codexHome = env['CODEX_HOME'] !== undefined && env['CODEX_HOME'] !== '' ? env['CODEX_HOME'] : null;
  const candidates: Record<AgentRuntime, string[]> = {
    'claude-code': [...(home === null ? [] : [join(home, '.claude')]), join(root, '.claude')],
    codex: [
      ...(codexHome === null ? [] : [codexHome]),
      ...(home === null ? [] : [join(home, '.codex')]),
      join(root, '.codex'),
    ],
    cursor: [...(home === null ? [] : [join(home, '.cursor')]), join(root, '.cursor')],
  };
  return AGENT_RUNTIMES.map((runtime) => {
    const evidence = [...new Set(candidates[runtime])].filter((path) => pathExists(path));
    return { runtime, detected: evidence.length > 0, evidence };
  });
}

export type WiredFileAction = 'created' | 'patched' | 'unchanged' | 'skipped';

export interface WiredFile {
  path: string;
  action: WiredFileAction;
}

export interface WiredRuntime {
  runtime: AgentRuntime;
  files: WiredFile[];
  /** Required review steps and merge-skip outcomes, in the order they arose. */
  warnings: string[];
}

export interface ScaffoldPhaseResult {
  /** The daemon MCP URL every scaffolded entry points at. */
  mcp_url: string;
  detected: AgentRuntime[];
  wired: WiredRuntime[];
  /** Why nothing (or not everything) was wired, in plain language. */
  notes: string[];
}

export interface ScaffoldPhaseOptions {
  root: string;
  projectId: string;
  projectName: string;
  mcpUrl: string;
  runtimes: AgentRuntime[];
  detected: AgentRuntime[];
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function writeMerged(path: string, result: ScaffoldMergeResult, warnings: string[]): WiredFile {
  if (!result.ok) {
    warnings.push(result.error);
    return { path, action: 'skipped' };
  }
  if (result.action !== 'unchanged') {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, result.content, 'utf8');
  }
  return { path, action: result.action };
}

/** Merge-write `.mcp.json`, `.claude/settings.json` hooks and the `CLAUDE.md` pointer. */
export function wireClaude(root: string, mcpUrl: string, projectName: string): WiredRuntime {
  const paths = claudeScaffoldPaths(root);
  const warnings: string[] = [];
  const files: WiredFile[] = [];

  const mcp = writeMerged(paths.mcpJson, mergeMcpJson(readIfExists(paths.mcpJson), { transport: 'http', url: mcpUrl }), warnings);
  files.push(mcp);
  files.push(writeMerged(paths.settingsJson, mergeClaudeSettingsHooks(readIfExists(paths.settingsJson)), warnings));

  const block = buildMemoryPointerBlock({ projectName });
  const existingMd = readIfExists(paths.claudeMd);
  const mergedMd = mergeMemoryPointerBlock(existingMd ?? '', block);
  if (!mergedMd.includes(block)) {
    // mergeMemoryPointerBlock leaves a document with a begin marker but no end marker as-is.
    warnings.push(
      'CLAUDE.md has an orphaned onememory begin marker (no end marker) and was left untouched — remove the stray marker and re-run onemem init --with-claude',
    );
    files.push({ path: paths.claudeMd, action: 'skipped' });
  } else {
    files.push(
      writeMerged(
        paths.claudeMd,
        {
          ok: true,
          content: mergedMd,
          action: existingMd === null ? 'created' : mergedMd === existingMd ? 'unchanged' : 'patched',
        },
        warnings,
      ),
    );
  }

  if (mcp.action === 'created' || mcp.action === 'patched') {
    warnings.push(
      'Claude Code asks you to approve project-scoped .mcp.json servers — run `claude` in this project and approve the onememory server (it shows as pending approval until then)',
    );
  }
  return { runtime: 'claude-code', files, warnings };
}

/** Delegate to the Codex adapter's own scaffold (it owns its three files and their warnings). */
export function wireCodex(root: string, mcpUrl: string, projectId: string): WiredRuntime {
  const result = scaffoldCodex({ scope: 'project', root, projectId, transport: 'http', url: mcpUrl });
  return {
    runtime: 'codex',
    files: result.files.map((file) => ({ path: file.path, action: file.action })),
    warnings: [...result.warnings],
  };
}

/** Delegate to the Cursor adapter's own scaffold (`.cursor/mcp.json`, hooks, the rules pointer). */
export function wireCursor(root: string, mcpUrl: string, projectName: string): WiredRuntime {
  const result = scaffoldCursor({ root, projectName, transport: 'http', url: mcpUrl });
  return {
    runtime: 'cursor',
    files: result.files.map((file) => ({ path: file.path, action: file.action })),
    warnings: [...result.warnings],
  };
}

/** Run the scaffold phase for the consented runtimes. */
export function runScaffoldPhase(options: ScaffoldPhaseOptions): ScaffoldPhaseResult {
  const notes: string[] = [];
  const result: ScaffoldPhaseResult = { mcp_url: options.mcpUrl, detected: options.detected, wired: [], notes };

  for (const runtime of options.detected) {
    if (!options.runtimes.includes(runtime)) {
      notes.push(
        `${RUNTIME_TITLES[runtime]} was detected but not wired (no consent) — re-run onemem init ${RUNTIME_FLAGS[runtime]} to wire it`,
      );
    }
  }
  if (options.runtimes.length === 0) {
    if (options.detected.length === 0) {
      notes.push(
        'no agent runtime was detected (~/.claude, ~/.codex, ~/.cursor, .claude/, .codex/, .cursor/) and none was requested — nothing was wired; pass --with-claude, --with-codex and/or --with-cursor to wire one',
      );
    }
    return result;
  }

  const host = new URL(options.mcpUrl).hostname;
  if (!isLoopbackHostname(host)) {
    notes.push(
      `daemon.host (${host}) is not a loopback address — Phase 1 has no authentication, so no runtime was wired; set daemon.host to 127.0.0.1 and re-run`,
    );
    return result;
  }

  for (const runtime of options.runtimes) {
    result.wired.push(
      runtime === 'claude-code'
        ? wireClaude(options.root, options.mcpUrl, options.projectName)
        : runtime === 'codex'
          ? wireCodex(options.root, options.mcpUrl, options.projectId)
          : wireCursor(options.root, options.mcpUrl, options.projectName),
    );
  }
  return result;
}

/**
 * Which runtimes the user consented to: explicit flags win; otherwise the interactive
 * multi-select (detected runtimes preselected); otherwise none.
 */
export async function chooseRuntimes(
  flags: { withClaude?: boolean; withCodex?: boolean; withCursor?: boolean },
  detection: RuntimeDetection[],
  io: Io,
  prompt: Prompt,
): Promise<AgentRuntime[]> {
  const flagged: AgentRuntime[] = [
    ...(flags.withClaude === true ? (['claude-code'] as const) : []),
    ...(flags.withCodex === true ? (['codex'] as const) : []),
    ...(flags.withCursor === true ? (['cursor'] as const) : []),
  ];
  if (flagged.length > 0 || !io.interactive) return flagged;
  const chosen = await prompt.multiselect<AgentRuntime>(
    'Wire agent runtimes to onememory? (MCP via the daemon + capture hooks + a memory pointer)',
    detection.map((entry) => ({
      value: entry.runtime,
      label: RUNTIME_TITLES[entry.runtime],
      hint: entry.detected ? `detected: ${entry.evidence.join(', ')}` : 'not detected',
    })),
    detection.filter((entry) => entry.detected).map((entry) => entry.runtime),
  );
  return AGENT_RUNTIMES.filter((runtime) => chosen.includes(runtime));
}

/** Every warning of every wired runtime, prefixed with the runtime it belongs to. */
export function requiredReview(phase: ScaffoldPhaseResult): string[] {
  return phase.wired.flatMap((wired) => wired.warnings.map((warning) => `${RUNTIME_TITLES[wired.runtime]}: ${warning}`));
}

/** Human output for the scaffold phase (skipped files are also written to stderr). */
export function printScaffoldPhase(io: Io, phase: ScaffoldPhaseResult, root: string): void {
  if (phase.wired.length > 0) {
    io.out(`agent runtimes (MCP → ${phase.mcp_url}):`);
    for (const wired of phase.wired) {
      io.out(`  ${RUNTIME_TITLES[wired.runtime]}:`);
      for (const file of wired.files) io.out(`    ${file.action.padEnd(9)} ${relative(root, file.path) || file.path}`);
      for (const file of wired.files) {
        if (file.action === 'skipped') io.err(`onemem: warning: ${relative(root, file.path)} was left untouched (see required review)`);
      }
    }
  }
  const review = requiredReview(phase);
  if (review.length > 0) {
    io.out('required review (enforced by the runtimes; onememory does not bypass these):');
    for (const line of review) io.out(`  - ${line}`);
  }
  for (const note of phase.notes) io.out(note);
}
