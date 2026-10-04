import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { renderCodexMcpServerToml } from './config-scaffold';
import { renderCodexHooksJson } from './hooks-scaffold';
import { scaffoldCodex } from './scaffold';
import {
  hasCodexAgentsBlock,
  inspectCodexConfigContent,
  inspectCodexHooksContent,
  inspectCodexScaffold,
} from './scaffold-inspect';
import { FIXTURE_PROJECT_ID } from './testing';

const URL_7331 = 'http://127.0.0.1:7331/mcp';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('inspectCodexConfigContent', () => {
  test('absent / invalid / no entry', () => {
    expect(inspectCodexConfigContent(null)).toEqual({ state: 'absent' });
    expect(inspectCodexConfigContent('model = ').state).toBe('invalid');
    expect(inspectCodexConfigContent('mcp_servers = 3\n').state).toBe('invalid');
    expect(inspectCodexConfigContent('model = "m"\n')).toEqual({ state: 'no_entry' });
  });

  test('the generated http block reads back with its url, marked as managed', () => {
    const text = renderCodexMcpServerToml({ projectId: FIXTURE_PROJECT_ID, transport: 'http', url: URL_7331 });
    expect(inspectCodexConfigContent(text)).toEqual({ state: 'http', url: URL_7331, managed: true });
  });

  test('stdio and hand-written entries', () => {
    expect(inspectCodexConfigContent(renderCodexMcpServerToml({ projectId: FIXTURE_PROJECT_ID }))).toEqual({
      state: 'stdio',
      managed: true,
    });
    expect(inspectCodexConfigContent('[mcp_servers.onememory]\nurl = "http://127.0.0.1:1/mcp"\n')).toEqual({
      state: 'http',
      url: 'http://127.0.0.1:1/mcp',
      managed: false,
    });
    expect(inspectCodexConfigContent('[mcp_servers.onememory]\nenabled = true\n').state).toBe('unrecognized');
  });
});

describe('inspectCodexHooksContent', () => {
  test('classifies hook states', () => {
    expect(inspectCodexHooksContent(null)).toEqual({ state: 'absent' });
    expect(inspectCodexHooksContent('{').state).toBe('invalid');
    expect(inspectCodexHooksContent('{"hooks": []}').state).toBe('invalid');
    expect(inspectCodexHooksContent('{"hooks": {}}')).toEqual({ state: 'no_entry' });
    expect(inspectCodexHooksContent(renderCodexHooksJson())).toEqual({ state: 'complete' });
    const partial = JSON.parse(renderCodexHooksJson());
    delete partial.hooks.Stop;
    expect(inspectCodexHooksContent(JSON.stringify(partial))).toEqual({ state: 'partial', missing_events: ['Stop'] });
  });
});

describe('inspectCodexScaffold (on disk)', () => {
  test('a fresh directory has nothing; scaffoldCodex(http) reads back complete', () => {
    const root = mkdtempSync(join(tmpdir(), 'onemem-codex-inspect-'));
    tempDirs.push(root);
    const empty = inspectCodexScaffold(root);
    expect(empty.config_toml.state).toBe('absent');
    expect(empty.hooks_json.state).toBe('absent');
    expect(empty.agents_md.present).toBe(false);

    scaffoldCodex({ scope: 'project', root, projectId: FIXTURE_PROJECT_ID, transport: 'http', url: URL_7331 });
    const wired = inspectCodexScaffold(root, { projectId: FIXTURE_PROJECT_ID });
    expect(wired.config_toml).toEqual({
      path: join(root, '.codex', 'config.toml'),
      state: 'http',
      url: URL_7331,
      managed: true,
    });
    expect(wired.hooks_json.state).toBe('complete');
    expect(wired.agents_md).toEqual({ path: join(root, 'AGENTS.md'), present: true });
  });

  test('AGENTS.md block detection is project-aware when an id is given', () => {
    const root = mkdtempSync(join(tmpdir(), 'onemem-codex-inspect-'));
    tempDirs.push(root);
    scaffoldCodex({ scope: 'project', root, projectId: FIXTURE_PROJECT_ID, transport: 'http', url: URL_7331 });
    const other = '01900000-0000-7000-8000-0000000000ff';
    expect(inspectCodexScaffold(root, { projectId: other }).agents_md.present).toBe(false);
    expect(hasCodexAgentsBlock('# nothing\n')).toBe(false);
  });
});
