/**
 * `scaffoldCursor` — the one function `onemem init` calls to wire Cursor (the init-wiring seam).
 *
 * What it writes (project scope, from the project root — all three paths are Cursor's own,
 * verified against https://cursor.com/docs/mcp and https://cursor.com/docs/hooks /docs/rules on
 * 2026-10-05):
 *   `.cursor/mcp.json`              — the `mcpServers.onememory` block (merged, idempotent)
 *   `.cursor/hooks.json`            — the capture handlers (merged, idempotent)
 *   `.cursor/rules/onememory.mdc`   — the always-applied memory pointer rule (marker-fenced)
 *
 * The MCP block is the daemon-backed Streamable HTTP form when `transport: 'http'` + `url` are
 * passed (what `onemem init` does), else the stdio form. An invalid http `url` throws before any
 * file is touched; every other problem is reported through `warnings` / `skipped`.
 *
 * The function is deliberately filesystem-thin: all content decisions live in the pure renderers,
 * so `dryRun` returns the exact bytes without touching disk, and every artifact is unit-tested on
 * its own.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { patchCursorHooksJson, renderCursorHooksJson, type CursorHooksScaffoldOptions } from './hooks-scaffold';
import { patchCursorMcpJson, renderCursorMcpJson, type CursorMcpOptions } from './mcp-scaffold';
import { hasFrontmatter, patchCursorRule, renderCursorRule, type CursorRuleOptions } from './rules';

export interface ScaffoldCursorOptions extends CursorMcpOptions, CursorHooksScaffoldOptions, CursorRuleOptions {
  /** Project root — the directory that contains (or will contain) `.cursor/`. */
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

export interface ScaffoldCursorResult {
  files: ScaffoldedFile[];
  /** Operator-facing notes (file left untouched, rule not always-applied, …). */
  warnings: string[];
}

/** The project-scope artifact paths `onemem init --with-cursor` writes. */
export function cursorScaffoldPaths(root: string): { mcpJson: string; hooksJson: string; rule: string } {
  return {
    mcpJson: join(root, '.cursor', 'mcp.json'),
    hooksJson: join(root, '.cursor', 'hooks.json'),
    rule: join(root, '.cursor', 'rules', 'onememory.mdc'),
  };
}

export function scaffoldCursor(options: ScaffoldCursorOptions): ScaffoldCursorResult {
  const warnings: string[] = [];
  const files: ScaffoldedFile[] = [];
  const paths = cursorScaffoldPaths(options.root);

  // --- .cursor/mcp.json (the MCP server) ----------------------------------------------
  const existingMcp = readIfExists(paths.mcpJson);
  const mcp = patchCursorMcpJson(existingMcp, options);
  if (!mcp.ok) {
    warnings.push(mcp.error);
    files.push({ path: paths.mcpJson, action: 'skipped', content: existingMcp ?? '' });
  } else {
    files.push({ path: paths.mcpJson, action: existingMcp === null ? 'created' : mcp.action, content: mcp.content });
  }

  // --- .cursor/hooks.json (the capture handlers) ---------------------------------------
  const existingHooks = readIfExists(paths.hooksJson);
  const hooks = existingHooks === null
    ? { ok: true as const, content: renderCursorHooksJson(options), action: 'created' as const }
    : patchCursorHooksJson(existingHooks, options);
  if (!hooks.ok) {
    warnings.push(hooks.error);
    files.push({ path: paths.hooksJson, action: 'skipped', content: existingHooks ?? '' });
  } else {
    files.push({
      path: paths.hooksJson,
      action: existingHooks === null ? 'created' : hooks.action,
      content: hooks.content,
    });
  }

  // --- .cursor/rules/onememory.mdc (the pointer rule) ----------------------------------
  const existingRule = readIfExists(paths.rule);
  if (existingRule !== null && !hasFrontmatter(existingRule)) {
    warnings.push(
      `.cursor/rules/onememory.mdc exists without frontmatter — Cursor only applies an .mdc rule automatically when it declares alwaysApply/globs/description, so the onememory pointer may stay @-mention-only until you add frontmatter`,
    );
  }
  const rule = patchCursorRule(existingRule, options);
  if (!rule.ok) {
    warnings.push(rule.error);
    files.push({ path: paths.rule, action: 'skipped', content: existingRule ?? '' });
  } else {
    files.push({ path: paths.rule, action: existingRule === null ? 'created' : rule.action, content: rule.content });
  }

  warnings.push(
    'Cursor asks for tool approval before an MCP tool runs by default — approve the onememory tools once (or add them to your Run Mode allowlist) so the agent can read and write memory',
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

/** Dry-run helper: the exact bytes `scaffoldCursor` would write (no filesystem access at all). */
export function renderCursorScaffold(options: Omit<ScaffoldCursorOptions, 'root' | 'dryRun'> = {}): ScaffoldCursorResult {
  return {
    files: [
      { path: '.cursor/mcp.json', action: 'created', content: renderCursorMcpJson(options) },
      { path: '.cursor/hooks.json', action: 'created', content: renderCursorHooksJson(options) },
      { path: '.cursor/rules/onememory.mdc', action: 'created', content: renderCursorRule(options) },
    ],
    warnings: [],
  };
}

function readIfExists(path: string): string | null {
  if (!existsSync(path)) return null;
  return readFileSync(path, 'utf8');
}
