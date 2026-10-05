/**
 * Scaffold output validation: every emitted document parses and schema-checks (a scaffold bug is
 * a test failure, never a broken runtime config). Shapes pinned to the Claude Code references —
 * see the citations in scaffolds.ts.
 */

import { describe, expect, test } from 'bun:test';

import { z } from 'zod';

import {
  ADDITIONAL_CONTEXT_MAX,
  additionalContextOutput,
  capAdditionalContext,
} from './context';
import {
  buildClaudeHooksConfig,
  buildMcpJson,
  buildMemoryPointerBlock,
  defaultHookCommand,
  defaultMcpServerCommand,
  mergeMemoryPointerBlock,
  MEMORY_POINTER_BEGIN,
  MEMORY_POINTER_END,
  renderClaudeSettingsHooks,
  renderMcpJson,
  HooksConfigSchema,
} from './scaffolds';

const PROJECT_ID = '0195a7f0-9f5e-7a1d-bc2d-0000000000aa';

describe('.mcp.json scaffold', () => {
  test('default entry: the published bin link, embedded data dir via the ${VAR:-default} form', () => {
    const document = buildMcpJson({ projectId: PROJECT_ID });
    expect(() => z.strictObject({ mcpServers: z.record(z.string(), z.unknown()) }).parse(document)).not.toThrow();
    // The published contract: Claude Code expands ${VAR} in `command` of a project-scoped
    // .mcp.json stdio entry (the ${CLAUDE_PROJECT_DIR:-.} form); the command IS the `bin`
    // entry npm links into node_modules/.bin — directly executable via its bun shebang, so no
    // interpreter wrapper and no src/*.ts source-path assumption survives in the entry.
    expect(document.mcpServers.onememory!.command).toBe(defaultMcpServerCommand());
    expect(document.mcpServers.onememory!.command).toBe('${CLAUDE_PROJECT_DIR:-.}/node_modules/.bin/onemem-mcp');
    expect(document.mcpServers.onememory!.args).toBeUndefined();
    expect(document.mcpServers.onememory!.env).toEqual({
      CLAUDE_PROJECT_DIR: '${CLAUDE_PROJECT_DIR}',
      ONEMEMORY_MCP_AGENT_ID: 'claude-code',
      ONEMEMORY_PROJECT_ID: PROJECT_ID,
      ONEMEMORY_DATA_DIR: '${CLAUDE_PROJECT_DIR:-.}/.onememory',
    });
  });

  test('an explicit command/args invocation is honored (source-checkout installs)', () => {
    const entry = buildMcpJson({ command: 'bun', args: ['src/bin.ts'] }).mcpServers.onememory!;
    expect(entry.command).toBe('bun');
    expect(entry.args).toEqual(['src/bin.ts']);
  });

  test('server storage passes the URL through by NAME (never committed)', () => {
    const document = buildMcpJson({ projectId: PROJECT_ID, storage: { mode: 'server' } });
    const env = document.mcpServers.onememory!.env!;
    expect(env.ONEMEMORY_PG_URL).toBe('${ONEMEMORY_PG_URL}');
    expect(env.ONEMEMORY_DATA_DIR).toBeUndefined();
  });

  test('profile and agent overrides land in env; explicit data dir respected', () => {
    const document = buildMcpJson({
      storage: { mode: 'embedded', dataDir: '/custom/data' },
      profile: 'full11',
      agentId: 'claude-code-subagent',
    });
    expect(document.mcpServers.onememory!.env).toMatchObject({
      ONEMEMORY_MCP_PROFILE: 'full11',
      ONEMEMORY_MCP_AGENT_ID: 'claude-code-subagent',
      ONEMEMORY_DATA_DIR: '/custom/data',
    });
  });

  test('rendered output is parseable JSON ending in a newline', () => {
    const text = renderMcpJson({ projectId: PROJECT_ID });
    expect(text.endsWith('\n')).toBeTrue();
    expect(() => JSON.parse(text)).not.toThrow();
  });
});

describe('settings.json hooks scaffold', () => {
  test('subscribes exactly to the translated events with the right matchers', () => {
    const config = buildClaudeHooksConfig();
    expect(() => HooksConfigSchema.parse(config)).not.toThrow();

    expect(Object.keys(config.hooks).sort()).toEqual(
      ['PostToolUse', 'PostToolUseFailure', 'SessionEnd', 'SessionStart', 'Stop'].sort(),
    );
    expect(config.hooks.PostToolUse[0]!.matcher).toBe('Bash|PowerShell|Edit|Write|NotebookEdit');
    expect(config.hooks.PostToolUseFailure[0]!.matcher).toBe('*');
    // SessionStart/Stop have no matcher (source and per-turn logic live in the script).
    expect(config.hooks.SessionStart[0]!.matcher).toBeUndefined();
    expect(config.hooks.Stop[0]!.matcher).toBeUndefined();
  });

  test('every handler is exec form (args set) invoking the published bin link', () => {
    const config = buildClaudeHooksConfig();
    for (const group of Object.values(config.hooks)) {
      const handler = group[0]!.hooks[0]!;
      expect(handler.type).toBe('command');
      // Exec form (args present) with the ${CLAUDE_PROJECT_DIR} placeholder inside `command` —
      // Claude Code substitutes path placeholders into command and args as plain strings.
      expect(handler.command).toBe(defaultHookCommand());
      expect(handler.args).toEqual([]);
      expect(handler.command).toContain('${CLAUDE_PROJECT_DIR}/node_modules/.bin/onemem-claude-hook');
      // The published contract: no repository-relative source path in any invocation.
      expect(handler.command).not.toContain('src/');
      expect(handler.command).not.toContain('@onememory/');
    }
  });

  test('SessionEnd raises the shared 1.5s budget (timeout is in SECONDS)', () => {
    const config = buildClaudeHooksConfig();
    expect(config.hooks.SessionEnd[0]!.hooks[0]!.timeout).toBe(5);
    expect(config.hooks.PostToolUse[0]!.hooks[0]!.timeout).toBeUndefined();
  });

  test('a custom invocation (coordinator-provided bin path) is honored', () => {
    const config = buildClaudeHooksConfig({ hook: { command: 'node', args: ['dist/hook.mjs'] } });
    expect(config.hooks.SessionStart[0]!.hooks[0]!.command).toBe('node');
    expect(config.hooks.SessionStart[0]!.hooks[0]!.args).toEqual(['dist/hook.mjs']);
  });

  test('rendered output is parseable JSON', () => {
    expect(() => JSON.parse(renderClaudeSettingsHooks())).not.toThrow();
  });
});

describe('memory pointer block (ADR-0010 §7)', () => {
  test('states onememory owns project memory and never duplicates knowledge', () => {
    const block = buildMemoryPointerBlock({ projectName: 'tinymem' });
    expect(block).toContain(MEMORY_POINTER_BEGIN);
    expect(block).toContain(MEMORY_POINTER_END);
    expect(block).toContain('lives in onememory');
    expect(block).toContain('Do not hand-maintain a duplicate knowledge base');
    expect(block).toContain('mcp__onememory__*');
    expect(block).toContain('MEMORY.md');
  });

  test('merge into an empty document', () => {
    const merged = mergeMemoryPointerBlock('', buildMemoryPointerBlock());
    expect(merged.trim()).toBe(buildMemoryPointerBlock().trim());
  });

  test('merge appends to an existing document exactly once (idempotent re-init)', () => {
    const existing = '# My project\n\nSome conventions here.\n';
    const once = mergeMemoryPointerBlock(existing, buildMemoryPointerBlock());
    const twice = mergeMemoryPointerBlock(once, buildMemoryPointerBlock());
    expect(twice).toBe(once);
    expect(once.startsWith('# My project')).toBeTrue();
    // Exactly one marker pair: a re-init replaces, never appends (split yields 2 parts at 1 hit).
    expect(once.split(MEMORY_POINTER_BEGIN)).toHaveLength(2);
    expect(once.split(MEMORY_POINTER_END)).toHaveLength(2);
  });

  test('a stale block between the markers is replaced, keeping surrounding text', () => {
    const stale = `Intro\n\n${MEMORY_POINTER_BEGIN}\nold\n${MEMORY_POINTER_END}\n\nTail\n`;
    const merged = mergeMemoryPointerBlock(stale, buildMemoryPointerBlock({ projectName: 'new' }));
    expect(merged).toContain('Intro');
    expect(merged).toContain('Tail');
    expect(merged).not.toContain('old');
    expect(merged).toContain('Project memory for new');
  });
});

describe('additionalContext output contract', () => {
  test('exactly the documented hookSpecificOutput shape on one JSON line', () => {
    const line = additionalContextOutput('use bun test');
    expect(JSON.parse(line)).toEqual({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'use bun test' },
    });
  });

  test('the 10,000-char cap reports the cut honestly', () => {
    const short = capAdditionalContext('abc');
    expect(short).toEqual({ text: 'abc', capped: false });
    const long = capAdditionalContext('a'.repeat(ADDITIONAL_CONTEXT_MAX + 5));
    expect(long.capped).toBeTrue();
    expect(long.text).toHaveLength(ADDITIONAL_CONTEXT_MAX);
  });
});
