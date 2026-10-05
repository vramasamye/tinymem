import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { inspectCursorMcpContent, inspectCursorHooksContent, inspectCursorScaffold } from './scaffold-inspect';
import { scaffoldCursor } from './scaffold';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-cursor-inspect-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const URL_7331 = 'http://127.0.0.1:7331/mcp';
const OPTIONS = { root: '', transport: 'http' as const, url: URL_7331, projectName: 'demo' };

describe('inspectCursorScaffold (content)', () => {
  test('absent / invalid / no_entry / http / stdio / unrecognized', () => {
    expect(inspectCursorMcpContent(null)).toEqual({ state: 'absent' });
    expect(inspectCursorMcpContent('nope')).toMatchObject({ state: 'invalid' });
    expect(inspectCursorMcpContent('{"mcpServers":{}}')).toEqual({ state: 'no_entry' });
    expect(inspectCursorMcpContent(`{"mcpServers":{"onememory":{"url":"${URL_7331}"}}}`)).toEqual({
      state: 'http',
      url: URL_7331,
    });
    expect(inspectCursorMcpContent('{"mcpServers":{"onememory":{"type":"stdio","command":"bun"}}}')).toEqual({
      state: 'stdio',
    });
    expect(inspectCursorMcpContent('{"mcpServers":{"onememory":42}}')).toMatchObject({ state: 'unrecognized' });
  });

  test('hooks: absent / no_entry / partial / complete', () => {
    expect(inspectCursorHooksContent(null)).toEqual({ state: 'absent' });
    expect(inspectCursorHooksContent('{"hooks":{}}')).toEqual({ state: 'no_entry' });
    const partial = inspectCursorHooksContent(
      '{"version":1,"hooks":{"sessionStart":[{"command":"bun node_modules/@onememory/adapter-cursor/src/bin.ts"}]}}',
    );
    expect(partial.state).toBe('partial');
    if (partial.state === 'partial') {
      expect(partial.missing_events).toContain('afterFileEdit');
      expect(partial.missing_events).not.toContain('sessionStart');
    }
    const complete = inspectCursorHooksContent(
      `${JSON.stringify(
        {
          version: 1,
          hooks: Object.fromEntries(
            [
              'sessionStart',
              'sessionEnd',
              'beforeSubmitPrompt',
              'afterAgentResponse',
              'postToolUse',
              'postToolUseFailure',
              'afterFileEdit',
            ].map((event) => [event, [{ command: 'onemem-cursor-hook' }]]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    expect(complete).toEqual({ state: 'complete' });
  });
});

describe('inspectCursorScaffold (on disk)', () => {
  test('a fresh project reads back as absent', () => {
    const root = tempDir();
    const inspection = inspectCursorScaffold(root);
    expect(inspection.mcp_json.state).toBe('absent');
    expect(inspection.hooks.state).toBe('absent');
    expect(inspection.rule.present).toBe(false);
  });

  test('after scaffoldCursor the doctor sees a complete wiring', () => {
    const root = tempDir();
    scaffoldCursor({ ...OPTIONS, root });
    const inspection = inspectCursorScaffold(root);
    expect(inspection.mcp_json).toMatchObject({ state: 'http', url: URL_7331 });
    expect(inspection.hooks.state).toBe('complete');
    expect(inspection.rule.present).toBe(true);
  });

  test('a stdio entry is reported as stdio (the doctor decides whether that is a hazard)', () => {
    const root = tempDir();
    mkdirSync(join(root, '.cursor'), { recursive: true });
    writeFileSync(join(root, '.cursor', 'mcp.json'), '{"mcpServers":{"onememory":{"type":"stdio","command":"bun"}}}\n', 'utf8');
    expect(inspectCursorScaffold(root).mcp_json.state).toBe('stdio');
  });
});
