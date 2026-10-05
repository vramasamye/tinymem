/**
 * Pure-renderer tests: the opencode.json merge contract (idempotent, never destructive, JSONC
 * left untouched), the generated plugin shim, and the pointer block merge. The filesystem layer
 * is `scaffold.test.ts`; these tests pin the exact bytes.
 */

import { describe, expect, test } from 'bun:test';

import { OpenCodeConfigDocumentSchema } from './wire';
import {
  buildOpenCodeMcpServerEntry,
  buildOpenCodePluginFile,
  buildOpenCodePointerBlock,
  defaultOpenCodeStdioArgs,
  hasOpenCodePointerBlock,
  mergeOpenCodeConfigJson,
  mergeOpenCodePointerBlock,
  OPENCODE_ADAPTER_PACKAGE,
  OPENCODE_INSTRUCTIONS_ENTRY,
  OPENCODE_PLUGIN_MARKER,
  OPENCODE_POINTER_BEGIN,
  OPENCODE_POINTER_END,
} from './scaffolds';

const MCP_URL = 'http://127.0.0.1:7331/mcp';

describe('buildOpenCodeMcpServerEntry', () => {
  test('the stdio entry carries the agent id, defaults, and the embedded data dir', () => {
    const entry = buildOpenCodeMcpServerEntry({ transport: 'stdio' });
    expect(entry).toMatchObject({
      type: 'local',
      command: ['bun', ...defaultOpenCodeStdioArgs()],
      enabled: true,
    });
    if (entry.type !== 'local') return;
    expect(entry.environment).toMatchObject({
      ONEMEMORY_MCP_AGENT_ID: 'opencode',
      ONEMEMORY_DATA_DIR: '.onememory',
    });
    expect(entry.environment).not.toHaveProperty('ONEMEMORY_PG_URL');
  });

  test('the stdio entry passes through the profile, project id, and custom env', () => {
    const entry = buildOpenCodeMcpServerEntry({
      transport: 'stdio',
      profile: 'full11',
      projectId: '01900000-0000-7000-8000-00000000000d',
      env: { ONEMEMORY_EXTRA: '1' },
    });
    if (entry.type !== 'local') return;
    expect(entry.environment).toMatchObject({
      ONEMEMORY_MCP_PROFILE: 'full11',
      ONEMEMORY_PROJECT_ID: '01900000-0000-7000-8000-00000000000d',
      ONEMEMORY_EXTRA: '1',
    });
  });

  test('server-mode storage emits NO PG URL placeholder (OpenCode inherits the parent env)', () => {
    // Verified: opencode mcp/index.ts connectLocal spawns with
    // env: { ...process.env, ...entry.environment } — a literal "${env:…}" would OVERRIDE the
    // user's real ONEMEMORY_PG_URL. The inherited environment carries it; the file must not.
    const entry = buildOpenCodeMcpServerEntry({ transport: 'stdio', storage: { mode: 'server' } });
    if (entry.type !== 'local') return;
    expect(entry.environment).not.toHaveProperty('ONEMEMORY_PG_URL');
    expect(entry.environment).not.toHaveProperty('ONEMEMORY_DATA_DIR');
  });

  test('the http entry is the remote shape with the loopback url', () => {
    const entry = buildOpenCodeMcpServerEntry({ transport: 'http', url: MCP_URL });
    expect(entry).toEqual({ type: 'remote', url: MCP_URL, enabled: true });
  });

  test('http requires a url and a LOOPBACK one (Phase 1 has no authentication)', () => {
    expect(() => buildOpenCodeMcpServerEntry({ transport: 'http' })).toThrow('requires the daemon MCP url');
    expect(() => buildOpenCodeMcpServerEntry({ transport: 'http', url: 'https://memory.example.com/mcp' })).toThrow(
      'loopback',
    );
  });
});

describe('mergeOpenCodeConfigJson', () => {
  test('a fresh document carries $schema, the server, and the instructions registration', () => {
    const result = mergeOpenCodeConfigJson(null, { transport: 'http', url: MCP_URL });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.action).toBe('created');
    const document = JSON.parse(result.content) as Record<string, unknown>;
    expect(document['$schema']).toBe('https://opencode.ai/config.json');
    expect(OpenCodeConfigDocumentSchema.safeParse(document).success).toBeTrue();
    expect(document['instructions']).toEqual([OPENCODE_INSTRUCTIONS_ENTRY]);
    expect(result.content.endsWith('}\n')).toBeTrue();
  });

  test('an existing config keeps every other key, server, and instruction in place', () => {
    const existing = JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        theme: 'opencode',
        mcp: { filesystem: { type: 'local', command: ['npx', 'fs-serve'] } },
        instructions: ['.opencode/rules/my-team.md'],
      },
      null,
      2,
    );
    const result = mergeOpenCodeConfigJson(existing, { transport: 'http', url: MCP_URL });
    expect(result.ok).toBeTrue();
    if (!result.ok) return;
    expect(result.action).toBe('patched');
    const document = JSON.parse(result.content) as {
      theme: string;
      mcp: Record<string, { type: string; command?: string[]; url?: string; enabled?: boolean }>;
      instructions: string[];
    };
    expect(document.theme).toBe('opencode');
    expect(document.mcp['filesystem']).toEqual({ type: 'local', command: ['npx', 'fs-serve'] });
    expect(document.mcp['onememory']).toEqual({ type: 'remote', url: MCP_URL, enabled: true });
    expect(document.instructions).toEqual(['.opencode/rules/my-team.md', OPENCODE_INSTRUCTIONS_ENTRY]);
  });

  test('re-running the satisfied merge is byte-identical (unchanged)', () => {
    const first = mergeOpenCodeConfigJson(null, { transport: 'http', url: MCP_URL });
    if (!first.ok) return;
    const second = mergeOpenCodeConfigJson(first.content, { transport: 'http', url: MCP_URL });
    expect(second).toMatchObject({ ok: true, action: 'unchanged' });
    if (!second.ok) return;
    expect(second.content).toBe(first.content);
  });

  test('a changed URL re-patches only our entry (the other keys stay put)', () => {
    const first = mergeOpenCodeConfigJson(null, { transport: 'http', url: MCP_URL });
    if (!first.ok) return;
    const moved = mergeOpenCodeConfigJson(first.content, { transport: 'http', url: 'http://127.0.0.1:9999/mcp' });
    expect(moved).toMatchObject({ ok: true, action: 'patched' });
    if (!moved.ok) return;
    expect(moved.content).not.toBe(first.content);
    expect(moved.content).toContain('http://127.0.0.1:9999/mcp');
  });

  test('a JSONC (comment) file is reported and left untouched — never rewritten', () => {
    const existing = '{\n  // team defaults\n  "theme": "opencode"\n}\n';
    const result = mergeOpenCodeConfigJson(existing, { transport: 'http', url: MCP_URL });
    expect(result.ok).toBeFalse();
    if (result.ok) return;
    expect(result.error).toContain('not valid JSON');
    expect(result.error).toContain('JSONC');
    expect(result.error).toContain('left untouched');
  });

  test('a non-object JSON document is rejected, never coerced', () => {
    const result = mergeOpenCodeConfigJson('["not", "a", "config"]', { transport: 'http', url: MCP_URL });
    expect(result.ok).toBeFalse();
  });
});

describe('buildOpenCodePluginFile', () => {
  test('the shim exports one plugin function from the adapter package, marked as generated', () => {
    const file = buildOpenCodePluginFile();
    expect(file).toContain(OPENCODE_PLUGIN_MARKER);
    expect(file).toContain(`from '${OPENCODE_ADAPTER_PACKAGE}'`);
    expect(file).toContain('export const onememory = createOpenCodePlugin();');
    expect(file.endsWith('\n')).toBeTrue();
  });

  test('the generated file is deterministic (a re-run replaces, never diverges)', () => {
    expect(buildOpenCodePluginFile()).toBe(buildOpenCodePluginFile());
  });
});

describe('buildOpenCodePointerBlock + mergeOpenCodePointerBlock', () => {
  test('the block is marker-fenced, headed, and stays compact', () => {
    const block = buildOpenCodePointerBlock({ projectName: 'demo' });
    expect(block.startsWith(OPENCODE_POINTER_BEGIN)).toBeTrue();
    expect(block.endsWith(OPENCODE_POINTER_END)).toBeTrue();
    expect(block).toContain('## Project memory for demo (onememory)');
    expect(block).toContain('memory_search');
    expect(block).toContain('AGENTS.md');
    expect(block.split('\n').length).toBeLessThan(20);
  });

  test('the heading adapts to the project name (or goes generic)', () => {
    expect(buildOpenCodePointerBlock({ projectName: 'x' })).toContain('Project memory for x');
    expect(buildOpenCodePointerBlock()).toContain('## Project memory (onememory)');
  });

  test('an absent file gets the block alone', () => {
    const block = buildOpenCodePointerBlock();
    expect(mergeOpenCodePointerBlock('', block)).toBe(`${block}\n`);
  });

  test('foreign content is preserved and the block is appended after a blank line', () => {
    const block = buildOpenCodePointerBlock();
    const merged = mergeOpenCodePointerBlock('team notes\n', block);
    expect(merged).toContain('team notes');
    expect(merged.indexOf('team notes')).toBeLessThan(merged.indexOf(OPENCODE_POINTER_BEGIN));
    expect(merged).toContain('\n\n<!-- onemem:begin');
  });

  test('a stale block is replaced in place (idempotent, never duplicated)', () => {
    const stale = `notes\n\n${buildOpenCodePointerBlock({ projectName: 'old' })}\n`;
    const fresh = buildOpenCodePointerBlock({ projectName: 'new' });
    const merged = mergeOpenCodePointerBlock(stale, fresh);
    expect(merged).toContain('Project memory for new');
    expect(merged).not.toContain('Project memory for old');
    expect(merged.match(new RegExp(OPENCODE_POINTER_BEGIN.slice(0, 14), 'g'))).toHaveLength(1);
    expect(merged).toContain('notes');
  });

  test('hasOpenCodePointerBlock requires BOTH markers', () => {
    expect(hasOpenCodePointerBlock(null)).toBeFalse();
    expect(hasOpenCodePointerBlock('nothing here')).toBeFalse();
    expect(hasOpenCodePointerBlock(`${OPENCODE_POINTER_BEGIN}\n`)).toBeFalse();
    expect(hasOpenCodePointerBlock(buildOpenCodePointerBlock())).toBeTrue();
  });
});
