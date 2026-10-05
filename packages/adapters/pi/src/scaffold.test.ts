/**
 * `scaffoldPi` orchestrator tests: real tmp directories, the three artifacts, dryRun, the
 * idempotence contract (re-run → `unchanged` × 3), and the never-clobber guarantees.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { scaffoldPi } from './scaffold';
import {
  hasPiPointerBlock,
  inspectPiMcpContent,
  inspectPiExtensionContent,
  piScaffoldPaths,
} from './scaffold-inspect';

const MCP_URL = 'http://127.0.0.1:7331/mcp';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'onemem-pi-scaffold-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scaffoldPi — project scope', () => {
  test('writes the three artifacts with created actions', () => {
    const result = scaffoldPi({ scope: 'project', root, transport: 'http', url: MCP_URL, projectName: 'demo' });
    expect(result.files.map((file) => file.action)).toEqual(['created', 'created', 'created']);
    const paths = piScaffoldPaths(root);
    for (const file of result.files) expect(existsSync(file.path)).toBeTrue();

    const mcp = JSON.parse(readFileSync(paths.mcpJson, 'utf8')) as { mcpServers: Record<string, { url?: string }> };
    expect(mcp.mcpServers.onememory!.url).toBe(MCP_URL);
    expect(readFileSync(paths.extension, 'utf8')).toContain('createPiExtension');
    expect(hasPiPointerBlock(readFileSync(paths.pointer, 'utf8'))).toBeTrue();
  });

  test('re-running is a no-op (unchanged × 3, byte-identical)', () => {
    const before = scaffoldPi({ scope: 'project', root, transport: 'http', url: MCP_URL, projectName: 'demo' });
    const first = scaffoldPi({ scope: 'project', root, transport: 'http', url: MCP_URL, projectName: 'demo' });
    expect(first.files.map((file) => file.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    const after = scaffoldPi({ scope: 'project', root, transport: 'http', url: MCP_URL, projectName: 'demo' });
    expect(after.files.map((file) => file.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    // The dry-run of a satisfied scaffold reports the exact on-disk bytes.
    expect(before.files.map((f) => f.content)).toEqual(first.files.map((f) => f.content));
  });

  test('dryRun computes the bytes without touching disk', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-pi-dry-'));
    try {
      const result = scaffoldPi({ scope: 'project', root: fresh, transport: 'http', url: MCP_URL, dryRun: true });
      expect(result.files).toHaveLength(3);
      expect(result.files.every((file) => file.content.length > 0)).toBeTrue();
      expect(existsSync(join(fresh, '.pi'))).toBeFalse();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('operator warnings cover project trust and reload', () => {
    const result = scaffoldPi({ scope: 'project', root, transport: 'http', url: MCP_URL });
    expect(result.warnings.join('\n')).toContain('project trust');
    expect(result.warnings.join('\n')).toContain('/reload');
  });

  test('a foreign extension file is skipped, never clobbered', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-pi-foreign-'));
    try {
      const paths = piScaffoldPaths(fresh);
      mkdirSync(join(fresh, '.pi', 'extensions'), { recursive: true });
      writeFileSync(paths.extension, 'export default () => {};', 'utf8');
      const result = scaffoldPi({ scope: 'project', root: fresh, transport: 'http', url: MCP_URL });
      const extension = result.files.find((file) => file.path === paths.extension)!;
      expect(extension.action).toBe('skipped');
      expect(readFileSync(paths.extension, 'utf8')).toBe('export default () => {};');
      expect(result.warnings.join('\n')).toContain('left untouched');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('an unparseable mcp.json is skipped with a warning; the rest still lands', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-pi-broken-'));
    try {
      mkdirSync(join(fresh, '.pi'), { recursive: true });
      writeFileSync(join(fresh, '.pi', 'mcp.json'), '{ broken', 'utf8');
      const result = scaffoldPi({ scope: 'project', root: fresh, transport: 'http', url: MCP_URL });
      const mcp = result.files.find((file) => file.path === join(fresh, '.pi', 'mcp.json'))!;
      expect(mcp.action).toBe('skipped');
      expect(result.warnings.some((warning) => warning.includes('not valid JSON'))).toBeTrue();
      // The extension and pointer still landed.
      expect(result.files.find((file) => file.path === piScaffoldPaths(fresh).extension)!.action).toBe('created');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('an orphaned pointer begin marker leaves the file untouched with a warning', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-pi-orphan-'));
    try {
      const paths = piScaffoldPaths(fresh);
      mkdirSync(join(fresh, '.pi'), { recursive: true });
      writeFileSync(paths.pointer, 'notes\n<!-- onemem:begin (generated by `onemem init` — do not edit inside this block) -->\n', 'utf8');
      const before = readFileSync(paths.pointer, 'utf8');
      const result = scaffoldPi({ scope: 'project', root: fresh, transport: 'http', url: MCP_URL });
      const pointer = result.files.find((file) => file.path === paths.pointer)!;
      expect(pointer.action).toBe('skipped');
      expect(readFileSync(paths.pointer, 'utf8')).toBe(before);
      expect(result.warnings.some((warning) => warning.includes('orphaned'))).toBeTrue();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('scaffoldPi — user scope', () => {
  test('writes the same three artifacts directly under the agent dir', () => {
    const agentDir = mkdtempSync(join(tmpdir(), 'onemem-pi-agent-'));
    try {
      const result = scaffoldPi({ scope: 'user', root: agentDir, transport: 'http', url: MCP_URL });
      expect(result.files.map((file) => file.action)).toEqual(['created', 'created', 'created']);
      expect(existsSync(join(agentDir, 'mcp.json'))).toBeTrue();
      expect(existsSync(join(agentDir, 'extensions', 'onememory.ts'))).toBeTrue();
      expect(existsSync(join(agentDir, 'APPEND_SYSTEM.md'))).toBeTrue();
      // No project-trust warning in user scope.
      expect(result.warnings.some((warning) => warning.includes('project trust'))).toBeFalse();
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});

describe('scaffold → inspect round trip', () => {
  test('a fresh scaffold is detected as configured by every inspector', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-pi-rt-'));
    try {
      scaffoldPi({ scope: 'project', root: fresh, transport: 'http', url: MCP_URL });
      const paths = piScaffoldPaths(fresh);
      expect(inspectPiMcpContent(readFileSync(paths.mcpJson, 'utf8'))).toMatchObject({ state: 'http', url: MCP_URL });
      expect(inspectPiExtensionContent(readFileSync(paths.extension, 'utf8'))).toMatchObject({ state: 'complete' });
      expect(hasPiPointerBlock(readFileSync(paths.pointer, 'utf8'))).toBeTrue();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
