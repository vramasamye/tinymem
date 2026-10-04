/**
 * The daemon-backed `.mcp.json` entry, the idempotent file merges `onemem init` performs, and the
 * read-only inspection `onemem doctor` relies on.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildMcpJson,
  buildMcpServerEntry,
  buildClaudeHooksConfig,
  isLoopbackHostname,
  McpJsonDocumentSchema,
  McpServerEntrySchema,
  renderMcpJson,
  buildMemoryPointerBlock,
  mergeMemoryPointerBlock,
} from './scaffolds';
import { mergeClaudeSettingsHooks, mergeMcpJson } from './scaffold-merge';
import {
  hasMemoryPointerBlock,
  inspectClaudeScaffold,
  inspectMcpJsonContent,
  inspectSettingsHooksContent,
} from './scaffold-inspect';

const URL_7331 = 'http://127.0.0.1:7331/mcp';

function expectOk(result: ReturnType<typeof mergeMcpJson>): { content: string; action: string } {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error}`);
  return result;
}

describe('.mcp.json http entry (daemon-backed)', () => {
  test('emits exactly {type: "http", url} — no headers, no stdio fields', () => {
    const document = buildMcpJson({ transport: 'http', url: URL_7331 });
    expect(document).toEqual({ mcpServers: { onememory: { type: 'http', url: URL_7331 } } });
    expect(McpJsonDocumentSchema.safeParse(document).success).toBeTrue();
    const rendered = JSON.parse(renderMcpJson({ transport: 'http', url: URL_7331 }));
    expect(rendered).toEqual(document);
  });

  test('ignores stdio options when transport is http', () => {
    const entry = buildMcpServerEntry({ transport: 'http', url: URL_7331, command: 'node', projectId: 'x' });
    expect(entry).toEqual({ type: 'http', url: URL_7331 });
  });

  test('absent transport keeps the stdio entry (backward compatible)', () => {
    const entry = buildMcpServerEntry({});
    expect(entry.command).toBe('bun');
    expect('type' in entry).toBeFalse();
  });

  test('http requires a url and refuses non-loopback / non-http endpoints', () => {
    expect(() => buildMcpServerEntry({ transport: 'http' })).toThrow(/requires the daemon MCP url/);
    expect(() => buildMcpServerEntry({ transport: 'http', url: 'http://10.0.0.5:7331/mcp' })).toThrow(/loopback/);
    expect(() => buildMcpServerEntry({ transport: 'http', url: 'https://127.0.0.1:7331/mcp' })).toThrow();
    expect(() => buildMcpServerEntry({ transport: 'http', url: 'not a url' })).toThrow();
    expect(buildMcpServerEntry({ transport: 'http', url: 'http://localhost:9000/mcp' }).url).toBe(
      'http://localhost:9000/mcp',
    );
    expect(buildMcpServerEntry({ transport: 'http', url: 'http://[::1]:9000/mcp' }).url).toBe('http://[::1]:9000/mcp');
  });

  test('the entry schema is a union of the http and stdio shapes', () => {
    expect(McpServerEntrySchema.safeParse({ type: 'http', url: URL_7331 }).success).toBeTrue();
    expect(McpServerEntrySchema.safeParse({ command: 'bun', args: ['x'] }).success).toBeTrue();
    expect(McpServerEntrySchema.safeParse({ url: URL_7331 }).success).toBeFalse();
    expect(McpServerEntrySchema.safeParse({ type: 'http' }).success).toBeFalse();
  });

  test('isLoopbackHostname', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) expect(isLoopbackHostname(host)).toBeTrue();
    for (const host of ['0.0.0.0', '10.0.0.1', 'example.com', '::', '']) expect(isLoopbackHostname(host)).toBeFalse();
  });
});

describe('mergeMcpJson', () => {
  const options = { transport: 'http' as const, url: URL_7331 };

  test('creates a new document when the file is absent or blank', () => {
    for (const existing of [null, '', '  \n']) {
      const result = expectOk(mergeMcpJson(existing, options));
      expect(result.action).toBe('created');
      expect(JSON.parse(result.content)).toEqual({ mcpServers: { onememory: { type: 'http', url: URL_7331 } } });
    }
  });

  test('preserves other servers and top-level keys, in order', () => {
    const existing = `${JSON.stringify(
      {
        $schema: 'https://example.invalid/schema.json',
        mcpServers: { context7: { command: 'npx', args: ['-y', '@upstash/context7-mcp'] } },
        other: { keep: true },
      },
      null,
      2,
    )}\n`;
    const result = expectOk(mergeMcpJson(existing, options));
    expect(result.action).toBe('patched');
    const merged = JSON.parse(result.content);
    expect(Object.keys(merged)).toEqual(['$schema', 'mcpServers', 'other']);
    expect(Object.keys(merged.mcpServers)).toEqual(['context7', 'onememory']);
    expect(merged.mcpServers.context7).toEqual({ command: 'npx', args: ['-y', '@upstash/context7-mcp'] });
    expect(merged.other).toEqual({ keep: true });
  });

  test('replaces a previous onememory entry in place (stdio → http)', () => {
    const existing = JSON.stringify({
      mcpServers: { a: { command: 'a' }, onememory: { command: 'bun', args: ['old'] }, z: { command: 'z' } },
    });
    const merged = JSON.parse(expectOk(mergeMcpJson(existing, options)).content);
    expect(Object.keys(merged.mcpServers)).toEqual(['a', 'onememory', 'z']);
    expect(merged.mcpServers.onememory).toEqual({ type: 'http', url: URL_7331 });
  });

  test('is byte-idempotent on re-run', () => {
    const first = expectOk(mergeMcpJson(JSON.stringify({ mcpServers: { a: { command: 'a' } } }), options));
    const second = expectOk(mergeMcpJson(first.content, options));
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
  });

  test('a top-level object without mcpServers gains it', () => {
    const merged = JSON.parse(expectOk(mergeMcpJson('{"foo": 1}', options)).content);
    expect(merged).toEqual({ foo: 1, mcpServers: { onememory: { type: 'http', url: URL_7331 } } });
  });

  test('malformed or mis-shaped documents fail loudly and are never clobbered', () => {
    for (const existing of ['{ not json', '[1, 2]', '"text"', '{"mcpServers": []}', '{"mcpServers": "x"}']) {
      const result = mergeMcpJson(existing, options);
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.error).toContain('left untouched');
    }
  });
});

describe('mergeClaudeSettingsHooks', () => {
  const generated = buildClaudeHooksConfig();
  const events = Object.keys(generated.hooks);
  const userHook = { type: 'command', command: '/usr/local/bin/lint-on-save', args: ['--fast'] };

  test('creates the hooks document when settings.json is absent', () => {
    const result = expectOk(mergeClaudeSettingsHooks(null));
    expect(result.action).toBe('created');
    expect(JSON.parse(result.content)).toEqual(generated);
  });

  test('preserves user settings keys, user hook events and user handlers', () => {
    const existing = `${JSON.stringify(
      {
        permissions: { allow: ['Bash(bun test:*)'] },
        hooks: {
          PreToolUse: [{ matcher: 'Bash', hooks: [userHook] }],
          PostToolUse: [{ matcher: 'Edit', hooks: [userHook] }],
        },
        model: 'opus',
      },
      null,
      2,
    )}\n`;
    const merged = JSON.parse(expectOk(mergeClaudeSettingsHooks(existing)).content);
    expect(Object.keys(merged)).toEqual(['permissions', 'hooks', 'model']);
    expect(merged.permissions).toEqual({ allow: ['Bash(bun test:*)'] });
    expect(merged.hooks.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [userHook] }]);
    expect(merged.hooks.PostToolUse[0]).toEqual({ matcher: 'Edit', hooks: [userHook] });
    expect(merged.hooks.PostToolUse.slice(1)).toEqual(generated.hooks.PostToolUse);
    for (const event of events) expect(merged.hooks[event]).toBeDefined();
  });

  test('re-running never duplicates onememory handlers (byte-idempotent)', () => {
    const first = expectOk(mergeClaudeSettingsHooks(JSON.stringify({ hooks: { Stop: [{ hooks: [userHook] }] } })));
    const second = expectOk(mergeClaudeSettingsHooks(first.content));
    expect(second.action).toBe('unchanged');
    expect(second.content).toBe(first.content);
    const merged = JSON.parse(second.content);
    expect(merged.hooks.Stop).toHaveLength(2);
    expect(merged.hooks.SessionStart).toHaveLength(1);
  });

  test('replaces stale onememory handlers (old bin path) and keeps user handlers sharing their group', () => {
    const stale = { type: 'command', command: 'bun', args: ['/old/node_modules/@onememory/adapter-claude/src/bin.ts'] };
    const existing = JSON.stringify({
      hooks: {
        SessionStart: [{ hooks: [stale] }],
        Stop: [{ hooks: [stale, userHook] }],
      },
    });
    const merged = JSON.parse(expectOk(mergeClaudeSettingsHooks(existing)).content);
    expect(merged.hooks.SessionStart).toEqual(generated.hooks.SessionStart);
    expect(merged.hooks.Stop).toEqual([{ hooks: [userHook] }, ...generated.hooks.Stop]);
  });

  test('a custom invocation is recognized as onememory on re-run', () => {
    const hook = { command: '/opt/onememory/hook', args: ['--claude'] };
    const first = expectOk(mergeClaudeSettingsHooks(null, { hook }));
    const second = expectOk(mergeClaudeSettingsHooks(first.content, { hook }));
    expect(second.action).toBe('unchanged');
  });

  test('malformed settings fail loudly and are never clobbered', () => {
    for (const existing of [
      '{ "hooks": ',
      '[]',
      '{"hooks": []}',
      '{"hooks": "x"}',
      '{"hooks": {"Stop": {"hooks": []}}}',
    ]) {
      const result = mergeClaudeSettingsHooks(existing);
      expect(result.ok).toBeFalse();
      if (!result.ok) expect(result.error).toContain('left untouched');
    }
  });

  test('unrecognized group shapes are preserved verbatim', () => {
    const odd = { matcher: 'X', note: 'no hooks array' };
    const merged = JSON.parse(expectOk(mergeClaudeSettingsHooks(JSON.stringify({ hooks: { Stop: [odd] } }))).content);
    expect(merged.hooks.Stop[0]).toEqual(odd);
  });
});

describe('scaffold inspection (doctor)', () => {
  test('classifies .mcp.json states', () => {
    expect(inspectMcpJsonContent(null)).toEqual({ state: 'absent' });
    expect(inspectMcpJsonContent('{').state).toBe('invalid');
    expect(inspectMcpJsonContent('[]').state).toBe('invalid');
    expect(inspectMcpJsonContent('{"mcpServers": {}}')).toEqual({ state: 'no_entry' });
    expect(inspectMcpJsonContent(renderMcpJson({ transport: 'http', url: URL_7331 }))).toEqual({
      state: 'http',
      url: URL_7331,
    });
    expect(inspectMcpJsonContent(JSON.stringify({ mcpServers: { onememory: { type: 'streamable-http', url: 'u' } } })))
      .toEqual({ state: 'http', url: 'u' });
    expect(inspectMcpJsonContent(renderMcpJson())).toEqual({ state: 'stdio' });
    expect(inspectMcpJsonContent('{"mcpServers": {"onememory": {"url": "x"}}}').state).toBe('unrecognized');
  });

  test('classifies settings.json hook states', () => {
    const full = expectOk(mergeClaudeSettingsHooks(null)).content;
    expect(inspectSettingsHooksContent(null)).toEqual({ state: 'absent' });
    expect(inspectSettingsHooksContent('nope').state).toBe('invalid');
    expect(inspectSettingsHooksContent('{"model": "opus"}')).toEqual({ state: 'no_entry' });
    expect(inspectSettingsHooksContent(full)).toEqual({ state: 'complete' });
    const partial = JSON.parse(full);
    delete partial.hooks.Stop;
    expect(inspectSettingsHooksContent(JSON.stringify(partial))).toEqual({ state: 'partial', missing_events: ['Stop'] });
  });

  test('pointer block presence', () => {
    expect(hasMemoryPointerBlock(null)).toBeFalse();
    expect(hasMemoryPointerBlock('# Notes\n')).toBeFalse();
    expect(hasMemoryPointerBlock(mergeMemoryPointerBlock('# Notes\n', buildMemoryPointerBlock()))).toBeTrue();
  });

  describe('on disk', () => {
    let root: string;
    beforeAll(() => {
      root = join(process.env.TMPDIR ?? '/tmp', `onemem-claude-inspect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
      mkdirSync(join(root, '.claude'), { recursive: true });
    });
    afterAll(() => rmSync(root, { recursive: true, force: true }));

    test('reads the three project-scope artifacts', () => {
      const empty = inspectClaudeScaffold(root);
      expect(empty.mcp_json.state).toBe('absent');
      expect(empty.settings_hooks.state).toBe('absent');
      expect(empty.pointer.present).toBeFalse();

      writeFileSync(join(root, '.mcp.json'), renderMcpJson({ transport: 'http', url: URL_7331 }));
      writeFileSync(join(root, '.claude', 'settings.json'), expectOk(mergeClaudeSettingsHooks(null)).content);
      writeFileSync(join(root, 'CLAUDE.md'), mergeMemoryPointerBlock('', buildMemoryPointerBlock()));
      const wired = inspectClaudeScaffold(root);
      expect(wired.mcp_json).toEqual({ path: join(root, '.mcp.json'), state: 'http', url: URL_7331 });
      expect(wired.settings_hooks.state).toBe('complete');
      expect(wired.pointer).toEqual({ path: join(root, 'CLAUDE.md'), present: true });
    });
  });
});
