/**
 * The doctor's runtimes group: the URL rule, the opt-in `info` state, `pass` only for complete
 * scaffolds whose MCP URL is exactly the configured daemon URL, `warn` for everything in between.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildMemoryPointerBlock,
  mergeClaudeSettingsHooks,
  mergeMcpJson,
  mergeMemoryPointerBlock,
} from '@onememory/adapter-claude';
import { scaffoldCodex } from '@onememory/adapter-codex';
import { scaffoldCursor } from '@onememory/adapter-cursor';

import { daemonMcpUrl, evaluateRuntimeScaffold, runtimeScaffoldChecks, type RuntimeScaffoldState } from './runtime-scaffolds';

const URL_7331 = 'http://127.0.0.1:7331/mcp';
const PROJECT_ID = '01900000-0000-7000-8000-0000000000d1';
const CONTEXT = { expectedUrl: URL_7331, storageProfile: 'embedded' as const };

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-runtime-scaffolds-'));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function writeClaude(root: string, url: string): void {
  const mcp = mergeMcpJson(null, { transport: 'http', url });
  const hooks = mergeClaudeSettingsHooks(null);
  if (!mcp.ok || !hooks.ok) throw new Error('scaffold merge failed');
  writeFileSync(join(root, '.mcp.json'), mcp.content);
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', 'settings.json'), hooks.content);
  writeFileSync(join(root, 'CLAUDE.md'), mergeMemoryPointerBlock('', buildMemoryPointerBlock()));
}

const complete: RuntimeScaffoldState = {
  mcp: { path: '/p/.mcp.json', state: 'http', url: URL_7331 },
  hooks: { path: '/p/.claude/settings.json', state: 'complete' },
  pointer: { path: '/p/CLAUDE.md', present: true },
};

describe('daemonMcpUrl', () => {
  test('is http://<daemon.host>:<daemon.port>/mcp', () => {
    expect(daemonMcpUrl({ host: '127.0.0.1', port: 7331 })).toBe(URL_7331);
    expect(daemonMcpUrl({ host: 'localhost', port: 9000 })).toBe('http://localhost:9000/mcp');
  });
});

describe('evaluateRuntimeScaffold', () => {
  test('complete + matching URL → pass', () => {
    const check = evaluateRuntimeScaffold('claude-code', complete, CONTEXT);
    expect(check.status).toBe('pass');
    expect(check.id).toBe('runtime-claude-code');
    expect(check.detail).toContain(URL_7331);
  });

  test('nothing scaffolded → info (opt-in), with the flag to wire it', () => {
    const check = evaluateRuntimeScaffold(
      'codex',
      {
        mcp: { path: '/p/.codex/config.toml', state: 'absent' },
        hooks: { path: '/p/.codex/hooks.json', state: 'no_entry' },
        pointer: { path: '/p/AGENTS.md', present: false },
      },
      CONTEXT,
    );
    expect(check.status).toBe('info');
    expect(check.remediation).toContain('onemem init --with-codex');
  });

  test('URL mismatch → warn naming both URLs', () => {
    const check = evaluateRuntimeScaffold(
      'claude-code',
      { ...complete, mcp: { ...complete.mcp, url: 'http://127.0.0.1:9999/mcp' } },
      CONTEXT,
    );
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('http://127.0.0.1:9999/mcp');
    expect(check.detail).toContain(URL_7331);
    expect(check.remediation).toContain('onemem init --with-claude');
  });

  test('partial scaffolds → warn listing what is missing', () => {
    const check = evaluateRuntimeScaffold(
      'claude-code',
      { ...complete, hooks: { path: '/p/.claude/settings.json', state: 'partial', missing_events: ['Stop'] }, pointer: { path: '/p/CLAUDE.md', present: false } },
      CONTEXT,
    );
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('Stop');
    expect(check.detail).toContain('CLAUDE.md');
  });

  test('an unreadable file → warn telling the user to fix it first', () => {
    const check = evaluateRuntimeScaffold(
      'claude-code',
      { ...complete, hooks: { path: '/p/.claude/settings.json', state: 'invalid', detail: 'not valid JSON' } },
      CONTEXT,
    );
    expect(check.status).toBe('warn');
    expect(check.remediation).toContain('fix /p/.claude/settings.json');
  });

  test('a stdio entry warns with embedded storage but is accepted with server storage', () => {
    const stdio: RuntimeScaffoldState = { ...complete, mcp: { path: '/p/.mcp.json', state: 'stdio' } };
    expect(evaluateRuntimeScaffold('claude-code', stdio, CONTEXT).status).toBe('warn');
    expect(evaluateRuntimeScaffold('claude-code', stdio, { ...CONTEXT, storageProfile: 'server' }).status).toBe('pass');
  });

  test('never fails', () => {
    const broken: RuntimeScaffoldState = {
      mcp: { path: 'a', state: 'invalid', detail: 'x' },
      hooks: { path: 'b', state: 'invalid', detail: 'y' },
      pointer: { path: 'c', present: false },
    };
    expect(evaluateRuntimeScaffold('codex', broken, CONTEXT).status).toBe('warn');
  });
});

describe('runtimeScaffoldChecks (real files)', () => {
  test('an empty project reports all three runtimes as info', () => {
    const checks = runtimeScaffoldChecks(tempDir(), CONTEXT);
    expect(checks.map((check) => [check.id, check.status])).toEqual([
      ['runtime-claude-code', 'info'],
      ['runtime-codex', 'info'],
      ['runtime-cursor', 'info'],
    ]);
  });

  test('scaffolds written by the adapters pass; a moved daemon port warns', () => {
    const root = tempDir();
    writeClaude(root, URL_7331);
    scaffoldCodex({ scope: 'project', root, projectId: PROJECT_ID, transport: 'http', url: URL_7331 });
    scaffoldCursor({ root, projectName: 'demo', transport: 'http', url: URL_7331 });
    const ok = runtimeScaffoldChecks(root, { ...CONTEXT, projectId: PROJECT_ID });
    expect(ok.map((check) => check.status)).toEqual(['pass', 'pass', 'pass']);

    const moved = runtimeScaffoldChecks(root, { ...CONTEXT, expectedUrl: 'http://127.0.0.1:7400/mcp', projectId: PROJECT_ID });
    expect(moved.map((check) => check.status)).toEqual(['warn', 'warn', 'warn']);
  });
});
