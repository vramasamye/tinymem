/**
 * `scaffoldOpenCode` orchestrator tests: real tmp directories, the three artifacts, dryRun, the
 * idempotence contract (re-run → `unchanged` × 3), and the never-clobber guarantees.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { openCodeScaffoldPaths, renderOpenCodeScaffold, scaffoldOpenCode } from './scaffold';
import { hasOpenCodePointerBlock } from './scaffolds';
import {
  hasOpenCodePointerBlockContent,
  inspectOpenCodeConfigContent,
  inspectOpenCodePluginContent,
} from './scaffold-inspect';

const MCP_URL = 'http://127.0.0.1:7331/mcp';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'onemem-opencode-scaffold-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('scaffoldOpenCode — the three artifacts', () => {
  test('writes opencode.json, the plugin shim, and the pointer with created actions', () => {
    const result = scaffoldOpenCode({ root, transport: 'http', url: MCP_URL, projectName: 'demo' });
    expect(result.files.map((file) => file.action)).toEqual(['created', 'created', 'created']);
    const paths = openCodeScaffoldPaths(root);
    for (const file of result.files) expect(existsSync(file.path)).toBeTrue();

    const config = JSON.parse(readFileSync(paths.configJson, 'utf8')) as {
      mcp: Record<string, { type: string; url?: string }>;
      instructions: string[];
    };
    expect(config.mcp['onememory']).toMatchObject({ type: 'remote', url: MCP_URL });
    expect(config.instructions).toEqual(['.opencode/onememory.md']);
    expect(readFileSync(paths.plugin, 'utf8')).toContain('createOpenCodePlugin');
    expect(hasOpenCodePointerBlock(readFileSync(paths.pointer, 'utf8'))).toBeTrue();
  });

  test('re-running is a no-op (unchanged × 3, byte-identical)', () => {
    const first = scaffoldOpenCode({ root, transport: 'http', url: MCP_URL, projectName: 'demo' });
    expect(first.files.map((file) => file.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    const second = scaffoldOpenCode({ root, transport: 'http', url: MCP_URL, projectName: 'demo' });
    expect(second.files.map((file) => file.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
    expect(first.files.map((f) => f.content)).toEqual(second.files.map((f) => f.content));
  });

  test('dryRun computes the bytes without touching disk', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-opencode-dry-'));
    try {
      const result = scaffoldOpenCode({ root: fresh, transport: 'http', url: MCP_URL, dryRun: true });
      expect(result.files).toHaveLength(3);
      expect(result.files.every((file) => file.content.length > 0)).toBeTrue();
      expect(existsSync(join(fresh, '.opencode'))).toBeFalse();
      expect(existsSync(join(fresh, 'opencode.json'))).toBeFalse();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('renderOpenCodeScaffold matches a real first-run scaffold byte for byte', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-opencode-render-'));
    try {
      const rendered = renderOpenCodeScaffold({ transport: 'http', url: MCP_URL, projectName: 'demo' });
      const written = scaffoldOpenCode({ root: fresh, transport: 'http', url: MCP_URL, projectName: 'demo' });
      expect(rendered.files.map((file) => file.content)).toEqual(written.files.map((file) => file.content));
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('the stdio transport needs no url and emits the local entry', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-opencode-stdio-'));
    try {
      const result = scaffoldOpenCode({ root: fresh, transport: 'stdio' });
      const paths = openCodeScaffoldPaths(fresh);
      const config = JSON.parse(readFileSync(paths.configJson, 'utf8')) as {
        mcp: Record<string, { type: string; command: string[] }>;
      };
      expect(config.mcp['onememory']).toMatchObject({ type: 'local' });
      expect(result.files.every((file) => file.action !== 'skipped')).toBeTrue();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('a non-loopback daemon URL throws BEFORE any file is touched', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-opencode-badurl-'));
    try {
      expect(() => scaffoldOpenCode({ root: fresh, transport: 'http', url: 'https://mem.example.com/mcp' })).toThrow(
        'loopback',
      );
      expect(existsSync(join(fresh, 'opencode.json'))).toBeFalse();
      expect(existsSync(join(fresh, '.opencode'))).toBeFalse();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('operator warnings cover the restart and the permission gate', () => {
    const result = scaffoldOpenCode({ root, transport: 'http', url: MCP_URL });
    const text = result.warnings.join('\n');
    expect(text).toContain('restart opencode');
    expect(text).toContain('permission');
  });
});

describe('scaffoldOpenCode — never-clobber guarantees', () => {
  test('a foreign plugin file is skipped, never clobbered', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-opencode-foreign-'));
    try {
      const paths = openCodeScaffoldPaths(fresh);
      mkdirSync(join(fresh, '.opencode', 'plugins'), { recursive: true });
      writeFileSync(paths.plugin, 'export const mine = () => ({});', 'utf8');
      const result = scaffoldOpenCode({ root: fresh, transport: 'http', url: MCP_URL });
      const plugin = result.files.find((file) => file.path === paths.plugin)!;
      expect(plugin.action).toBe('skipped');
      expect(readFileSync(paths.plugin, 'utf8')).toBe('export const mine = () => ({});');
      expect(result.warnings.join('\n')).toContain('left untouched');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('an unparseable opencode.json (JSONC) is skipped with a warning; the rest still lands', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-opencode-broken-'));
    try {
      writeFileSync(join(fresh, 'opencode.json'), '{\n  // my comments\n  "theme": "opencode"\n', 'utf8');
      const result = scaffoldOpenCode({ root: fresh, transport: 'http', url: MCP_URL });
      const config = result.files.find((file) => file.path === join(fresh, 'opencode.json'))!;
      expect(config.action).toBe('skipped');
      expect(result.warnings.some((warning) => warning.includes('not valid JSON'))).toBeTrue();
      expect(result.files.find((file) => file.path === openCodeScaffoldPaths(fresh).plugin)!.action).toBe('created');
      expect(result.files.find((file) => file.path === openCodeScaffoldPaths(fresh).pointer)!.action).toBe('created');
      // The user's file is exactly what it was.
      expect(readFileSync(join(fresh, 'opencode.json'), 'utf8')).toBe('{\n  // my comments\n  "theme": "opencode"\n');
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('an orphaned pointer begin marker leaves the file untouched with a warning', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-opencode-orphan-'));
    try {
      const paths = openCodeScaffoldPaths(fresh);
      mkdirSync(join(fresh, '.opencode'), { recursive: true });
      writeFileSync(
        paths.pointer,
        'notes\n<!-- onemem:begin (generated by `onemem init` — do not edit inside this block) -->\n',
        'utf8',
      );
      const before = readFileSync(paths.pointer, 'utf8');
      const result = scaffoldOpenCode({ root: fresh, transport: 'http', url: MCP_URL });
      const pointer = result.files.find((file) => file.path === paths.pointer)!;
      expect(pointer.action).toBe('skipped');
      expect(readFileSync(paths.pointer, 'utf8')).toBe(before);
      expect(result.warnings.some((warning) => warning.includes('orphaned'))).toBeTrue();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});

describe('scaffold → inspect round trip', () => {
  test('a fresh scaffold is detected as configured by every inspector', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-opencode-rt-'));
    try {
      scaffoldOpenCode({ root: fresh, transport: 'http', url: MCP_URL });
      const paths = openCodeScaffoldPaths(fresh);
      expect(inspectOpenCodeConfigContent(readFileSync(paths.configJson, 'utf8'))).toMatchObject({
        state: 'http',
        url: MCP_URL,
      });
      expect(inspectOpenCodePluginContent(readFileSync(paths.plugin, 'utf8'))).toMatchObject({ state: 'complete' });
      expect(hasOpenCodePointerBlockContent(readFileSync(paths.pointer, 'utf8'))).toBeTrue();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });
});
