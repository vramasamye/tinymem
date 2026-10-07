/**
 * Scaffold-builder tests: the emitted documents validate against their Zod schemas, the merges are
 * idempotent (byte-identical on re-run), foreign entries are preserved, and a broken user file is
 * never overwritten.
 */

import { describe, expect, test } from 'bun:test';

import {
  buildPiExtensionFile,
  buildPiMcpServerEntry,
  buildPiPointerBlock,
  isLoopbackHostname,
  mergePiMcpJson,
  mergePiPointerBlock,
  ONEMEMORY_SERVER_DESCRIPTION,
  PI_EXTENSION_MARKER,
  PiMcpJsonDocumentSchema,
  PI_POINTER_BEGIN,
  DEFAULT_EXPOSURE,
} from './scaffolds';

describe('buildPiMcpServerEntry', () => {
  test('http entry: url + description + direct exposure + enabled (Pi mcp.json shape)', () => {
    const entry = buildPiMcpServerEntry({ transport: 'http', url: 'http://127.0.0.1:7331/mcp' });
    expect(entry).toMatchObject({
      url: 'http://127.0.0.1:7331/mcp',
      description: ONEMEMORY_SERVER_DESCRIPTION,
      exposure: 'direct',
      enabled: true,
    });
    // A bare `url` document must parse as Pi's mcp.json (url selects streamable HTTP).
    expect(
      PiMcpJsonDocumentSchema.safeParse({ mcpServers: { onememory: entry } }).success,
    ).toBeTrue();
  });

  test('http requires the url (throws before anything is touched)', () => {
    expect(() => buildPiMcpServerEntry({ transport: 'http' })).toThrow('requires the daemon MCP url');
  });

  test('a non-loopback daemon url is refused (Phase 1 has no authentication)', () => {
    expect(() => buildPiMcpServerEntry({ transport: 'http', url: 'http://0.0.0.0:7331/mcp' })).toThrow();
    expect(() => buildPiMcpServerEntry({ transport: 'http', url: 'https://127.0.0.1:7331/mcp' })).toThrow();
  });

  test('stdio entry: command + args + cwd resolved against the session directory', () => {
    const entry = buildPiMcpServerEntry({ transport: 'stdio', projectId: 'pid', agentId: 'pi' });
    expect(entry).toMatchObject({
      command: 'bun',
      args: ['node_modules/@onememory-ai/mcp/src/bin.ts'],
      cwd: '.',
      exposure: DEFAULT_EXPOSURE,
      enabled: true,
    });
    expect((entry as { env?: Record<string, string> }).env).toMatchObject({
      ONEMEMORY_MCP_AGENT_ID: 'pi',
      ONEMEMORY_PROJECT_ID: 'pid',
    });
  });

  test('isLoopbackHostname accepts loopback forms only', () => {
    expect(isLoopbackHostname('127.0.0.1')).toBeTrue();
    expect(isLoopbackHostname('localhost')).toBeTrue();
    expect(isLoopbackHostname('::1')).toBeTrue();
    expect(isLoopbackHostname('[::1]')).toBeTrue();
    expect(isLoopbackHostname('10.0.0.1')).toBeFalse();
    expect(isLoopbackHostname('example.com')).toBeFalse();
  });
});

describe('mergePiMcpJson', () => {
  test('absent file → created with only our entry', () => {
    const result = mergePiMcpJson(null, { transport: 'http', url: 'http://127.0.0.1:7331/mcp' });
    expect(result).toMatchObject({ ok: true, action: 'created' });
    if (!result.ok) throw new Error('unreachable');
    const parsed = JSON.parse(result.content) as { mcpServers: Record<string, unknown> };
    expect(Object.keys(parsed.mcpServers)).toEqual(['onememory']);
    expect(result.content.endsWith('\n')).toBeTrue();
  });

  test('foreign servers and top-level keys keep their position and content', () => {
    const existing = JSON.stringify(
      {
        $schema: 'keep-me',
        mcpServers: {
          filesystem: { command: 'npx', args: ['-y', 'server-filesystem'] },
        },
      },
      null,
      2,
    );
    const result = mergePiMcpJson(existing, { transport: 'http', url: 'http://127.0.0.1:7331/mcp' });
    expect(result).toMatchObject({ ok: true, action: 'patched' });
    if (!result.ok) throw new Error('unreachable');
    const parsed = JSON.parse(result.content) as { $schema: string; mcpServers: Record<string, unknown> };
    expect(parsed.$schema).toBe('keep-me');
    expect(Object.keys(parsed.mcpServers)).toEqual(['filesystem', 'onememory']);
  });

  test('re-running is byte-identical (unchanged)', () => {
    const options = { transport: 'http' as const, url: 'http://127.0.0.1:7331/mcp' };
    const first = mergePiMcpJson(null, options);
    if (!first.ok) throw new Error('unreachable');
    const second = mergePiMcpJson(first.content, options);
    expect(second).toMatchObject({ ok: true, action: 'unchanged' });
    if (!second.ok) throw new Error('unreachable');
    expect(second.content).toBe(first.content);
  });

  test('an existing onememory entry is replaced (project entries override same-name entries)', () => {
    const stale = JSON.stringify({ mcpServers: { onememory: { url: 'http://127.0.0.1:1/mcp' } } });
    const result = mergePiMcpJson(stale, { transport: 'http', url: 'http://127.0.0.1:7331/mcp' });
    expect(result).toMatchObject({ ok: true, action: 'patched' });
  });

  test('a non-JSON file is an error and is never overwritten', () => {
    const result = mergePiMcpJson('{ broken', { transport: 'http', url: 'http://127.0.0.1:7331/mcp' });
    expect(result.ok).toBeFalse();
    if (result.ok) throw new Error('unreachable');
    expect(result.error).toContain('left untouched');
  });
});

describe('the extension shim', () => {
  test('is the documented default-export factory and carries the generated marker', () => {
    const file = buildPiExtensionFile();
    expect(file).toContain(PI_EXTENSION_MARKER);
    expect(file).toContain("import { createPiExtension } from '@onememory-ai/adapter-pi'");
    expect(file).toContain('export default function onememory(');
  });
});

describe('the APPEND_SYSTEM.md pointer block', () => {
  test('renders with project name and the interop wording (ADR-0010 §7)', () => {
    const block = buildPiPointerBlock({ projectName: 'demo' });
    expect(block).toContain('## Project memory for demo (onememory)');
    expect(block).toContain('mcp__onememory__*');
    expect(block).toContain('Do not hand-maintain a duplicate knowledge base');
    expect(block.startsWith(PI_POINTER_BEGIN)).toBeTrue();
    expect(block.trimEnd().endsWith('<!-- onemem:end -->')).toBeTrue();
  });

  test('merges idempotently into an empty and a populated document', () => {
    const block = buildPiPointerBlock({ projectName: 'demo' });
    const mergedOnce = mergePiPointerBlock('', block);
    expect(mergedOnce).toBe(`${block}\n`);
    const mergedTwice = mergePiPointerBlock(mergedOnce, block);
    expect(mergedTwice).toBe(mergedOnce);

    const populated = `# Project notes\n\nUse bun.\n\n${block}\n`;
    expect(mergePiPointerBlock(populated, buildPiPointerBlock({ projectName: 'demo' }))).toBe(populated);
  });

  test('an updated block replaces the old one in place (fresh content wins)', () => {
    const block = buildPiPointerBlock({ projectName: 'demo' });
    const existing = `intro\n\n${block}\n`;
    const fresh = buildPiPointerBlock({ projectName: 'renamed' });
    const merged = mergePiPointerBlock(existing, fresh);
    expect(merged).toContain('Project memory for renamed');
    expect(merged).not.toContain('Project memory for demo');
    expect(merged).toContain('intro');
  });
});
