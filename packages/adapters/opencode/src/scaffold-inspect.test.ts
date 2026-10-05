/**
 * Inspection tests: every classification `onemem doctor` consumes — content-level (pure) plus the
 * filesystem walk. The doctor judges; these functions only report.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { openCodeScaffoldPaths, scaffoldOpenCode } from './scaffold';
import { OPENCODE_POINTER_BEGIN, OPENCODE_POINTER_END } from './scaffolds';
import {
  hasOpenCodePointerBlockContent,
  inspectOpenCodeConfigContent,
  inspectOpenCodePluginContent,
  inspectOpenCodeScaffold,
  openCodeInspectPaths,
} from './scaffold-inspect';

const MCP_URL = 'http://127.0.0.1:7331/mcp';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'onemem-opencode-inspect-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('inspectOpenCodeConfigContent', () => {
  test('a missing file is absent', () => {
    expect(inspectOpenCodeConfigContent(null)).toEqual({ state: 'absent' });
  });

  test('an unparseable file is invalid with the parse detail', () => {
    const result = inspectOpenCodeConfigContent('{ broken');
    expect(result.state).toBe('invalid');
    expect(result.detail).toContain('not valid JSON');
  });

  test('a non-object document is invalid', () => {
    expect(inspectOpenCodeConfigContent('[]')).toMatchObject({ state: 'invalid' });
  });

  test('a config without our entry is no_entry (the file is fine, we are not in it)', () => {
    expect(inspectOpenCodeConfigContent('{"theme":"opencode"}')).toEqual({ state: 'no_entry' });
    expect(inspectOpenCodeConfigContent('{"mcp":{"filesystem":{"type":"local","command":["npx"]}}}')).toEqual({
      state: 'no_entry',
    });
  });

  test('our remote entry reports http with the URL the doctor compares', () => {
    const result = inspectOpenCodeConfigContent(
      JSON.stringify({ mcp: { onememory: { type: 'remote', url: MCP_URL, enabled: true } } }),
    );
    expect(result).toEqual({ state: 'http', url: MCP_URL });
  });

  test('our local entry reports stdio', () => {
    const result = inspectOpenCodeConfigContent(
      JSON.stringify({ mcp: { onememory: { type: 'local', command: ['bun', 'x'] } } }),
    );
    expect(result).toMatchObject({ state: 'stdio' });
  });

  test('an entry we do not recognize is unrecognized, with a detail', () => {
    const result = inspectOpenCodeConfigContent(JSON.stringify({ mcp: { onememory: { url: MCP_URL } } }));
    expect(result.state).toBe('unrecognized');
    expect(result.detail).toContain('neither');
  });
});

describe('inspectOpenCodePluginContent', () => {
  test('a missing plugin file is absent', () => {
    expect(inspectOpenCodePluginContent(null)).toEqual({ state: 'absent' });
  });

  test('the generated plugin is complete', () => {
    const result = inspectOpenCodePluginContent(
      `/** onememory:generated (onemem init) — safe to re-run */\nexport const onememory = 1;\n`,
    );
    expect(result).toEqual({ state: 'complete' });
  });

  test('a foreign plugin file is no_entry (present, but not ours)', () => {
    const result = inspectOpenCodePluginContent('export const mine = () => ({});');
    expect(result.state).toBe('no_entry');
    expect(result.detail).toContain('not generated');
  });
});

describe('hasOpenCodePointerBlockContent', () => {
  test('both markers, in order, or false (the body may differ; the markers are the contract)', () => {
    expect(hasOpenCodePointerBlockContent(null)).toBeFalse();
    expect(hasOpenCodePointerBlockContent('')).toBeFalse();
    expect(hasOpenCodePointerBlockContent(`${OPENCODE_POINTER_BEGIN}\n`)).toBeFalse();
    expect(hasOpenCodePointerBlockContent(`${OPENCODE_POINTER_BEGIN}\nbody from an older scaffold\n${OPENCODE_POINTER_END}`)).toBeTrue();
  });
});

describe('inspectOpenCodeScaffold — the filesystem walk', () => {
  test('an empty project reports absent everywhere', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'onemem-opencode-none-'));
    try {
      const state = inspectOpenCodeScaffold(fresh);
      expect(state.mcp.state).toBe('absent');
      expect(state.hooks.state).toBe('absent');
      expect(state.pointer.present).toBeFalse();
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  test('a scaffolded project reports http + complete + pointer', () => {
    scaffoldOpenCode({ root, transport: 'http', url: MCP_URL });
    const state = inspectOpenCodeScaffold(root);
    expect(state.mcp).toMatchObject({ state: 'http', url: MCP_URL });
    expect(state.hooks.state).toBe('complete');
    expect(state.pointer.present).toBeTrue();
    const paths = openCodeInspectPaths(root);
    expect(paths).toEqual(openCodeScaffoldPaths(root));
    expect(state.mcp.path).toBe(join(root, 'opencode.json'));
    expect(state.hooks.path).toBe(join(root, '.opencode', 'plugins', 'onememory.ts'));
    expect(state.pointer.path).toBe(join(root, '.opencode', 'onememory.md'));
  });
});
