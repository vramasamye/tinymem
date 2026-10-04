import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';

import { AGENTS_BLOCK_BEGIN_PREFIX } from './agents-md';
import { scaffoldCodex } from './scaffold';
import { FIXTURE_PROJECT_ID } from './testing';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-codex-scaffold-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const OPTIONS = { scope: 'project' as const, root: '', projectId: FIXTURE_PROJECT_ID };

describe('scaffoldCodex — dryRun', () => {
  test('returns the exact bytes without touching disk', () => {
    const root = tempDir();
    const result = scaffoldCodex({ ...OPTIONS, root, dryRun: true });
    expect(result.files.map((file) => file.action)).toEqual(['created', 'created', 'created']);
    expect(result.files.map((file) => file.path)).toEqual([
      join(root, '.codex', 'config.toml'),
      join(root, '.codex', 'hooks.json'),
      join(root, 'AGENTS.md'),
    ]);
    // Every artifact parses.
    expect((parseToml(result.files[0]!.content) as Record<string, unknown>)['mcp_servers']).toBeDefined();
    expect(JSON.parse(result.files[1]!.content).hooks.SessionStart).toBeDefined();
    expect(result.files[2]!.content).toContain(FIXTURE_PROJECT_ID);
    expect(existsSync(join(root, '.codex'))).toBe(false);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(false);
  });

  test('user scope writes config.toml, hooks.json, AGENTS.md directly under CODEX_HOME', () => {
    const root = tempDir();
    const result = scaffoldCodex({ ...OPTIONS, scope: 'user', root, dryRun: true });
    expect(result.files.map((file) => file.path)).toEqual([
      join(root, 'config.toml'),
      join(root, 'hooks.json'),
      join(root, 'AGENTS.md'),
    ]);
  });
});

describe('scaffoldCodex — writes', () => {
  test('creates all three artifacts on a fresh project', () => {
    const root = tempDir();
    const result = scaffoldCodex({ ...OPTIONS, root });
    expect(existsSync(join(root, '.codex', 'config.toml'))).toBe(true);
    expect(existsSync(join(root, '.codex', 'hooks.json'))).toBe(true);
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
    expect(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')).toBe(
      result.files.find((file) => file.path.endsWith('config.toml'))!.content,
    );
    // A new project-scoped config triggers the trust-review warning.
    expect(result.warnings.some((warning) => warning.includes('trusted projects'))).toBe(true);
  });

  test('re-running is a no-op: unchanged actions, identical bytes, no rewrite', () => {
    const root = tempDir();
    scaffoldCodex({ ...OPTIONS, root });
    const second = scaffoldCodex({ ...OPTIONS, root });
    expect(second.files.map((file) => file.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  test('preserves user config/comments and foreign hooks across scaffolding', () => {
    const root = tempDir();
    writeFileSync(join(root, 'AGENTS.md'), '# My notes\n\n- keep my line\n', 'utf8');
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(
      join(root, '.codex', 'config.toml'),
      '# user comment\nmodel = "gpt-6.1-sol"\n\n[mcp_servers.context7]\ncommand = "npx"\n',
      'utf8',
    );
    writeFileSync(
      join(root, '.codex', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: 'lint.sh' }] }] } }),
      'utf8',
    );
    scaffoldCodex({ ...OPTIONS, root });
    const toml = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('# user comment');
    expect(toml).toContain('[mcp_servers.context7]');
    const hooks = JSON.parse(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8'));
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe('lint.sh');
    expect(hooks.hooks.SessionStart).toBeDefined();
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    expect(agents).toContain('# My notes');
    expect(agents).toContain('- keep my line');
    expect(agents).toContain(FIXTURE_PROJECT_ID);
  });

  test('an unparseable hooks.json is skipped with a warning, other artifacts still land', () => {
    const root = tempDir();
    mkdirSync(join(root, '.codex'), { recursive: true });
    writeFileSync(join(root, '.codex', 'hooks.json'), '{broken', 'utf8');
    const result = scaffoldCodex({ ...OPTIONS, root });
    const hooksFile = result.files.find((file) => file.path.endsWith('hooks.json'))!;
    expect(hooksFile.action).toBe('skipped');
    expect(result.warnings.some((warning) => warning.includes('left untouched'))).toBe(true);
    expect(readFileSync(join(root, '.codex', 'hooks.json'), 'utf8')).toBe('{broken');
    expect(existsSync(join(root, 'AGENTS.md'))).toBe(true);
  });

  test('an orphaned onememory marker in AGENTS.md warns and leaves the file untouched', () => {
    const root = tempDir();
    const corrupt = `# Notes\n${AGENTS_BLOCK_BEGIN_PREFIX}${FIXTURE_PROJECT_ID} x)\norphan line\n`;
    writeFileSync(join(root, 'AGENTS.md'), corrupt, 'utf8');
    const result = scaffoldCodex({ ...OPTIONS, root });
    const agentsFile = result.files.find((file) => file.path.endsWith('AGENTS.md'))!;
    expect(agentsFile.action).toBe('unchanged');
    expect(result.warnings.some((warning) => warning.includes('orphaned onememory marker'))).toBe(true);
    expect(readFileSync(join(root, 'AGENTS.md'), 'utf8')).toBe(corrupt);
  });

  test('AGENTS.override.md presence is called out', () => {
    const root = tempDir();
    writeFileSync(join(root, 'AGENTS.override.md'), '# override\n', 'utf8');
    const result = scaffoldCodex({ ...OPTIONS, root });
    expect(result.warnings.some((warning) => warning.includes('AGENTS.override.md'))).toBe(true);
  });
});

describe('scaffoldCodex — daemon-backed http transport', () => {
  const URL_7331 = 'http://127.0.0.1:7331/mcp';

  test('writes the url form and is an idempotent no-op on re-run', () => {
    const root = tempDir();
    const options = { ...OPTIONS, root, transport: 'http' as const, url: URL_7331 };
    const first = scaffoldCodex(options);
    expect(first.files.map((file) => file.action)).toEqual(['created', 'created', 'created']);
    const toml = parseToml(readFileSync(join(root, '.codex', 'config.toml'), 'utf8')) as Record<string, unknown>;
    expect((toml['mcp_servers'] as Record<string, unknown>)['onememory']).toEqual({ url: URL_7331 });

    const second = scaffoldCodex(options);
    expect(second.files.map((file) => file.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
  });

  test('a stdio scaffold upgrades in place to http (patched), hooks + AGENTS.md unchanged', () => {
    const root = tempDir();
    scaffoldCodex({ ...OPTIONS, root });
    const upgraded = scaffoldCodex({ ...OPTIONS, root, transport: 'http', url: URL_7331 });
    expect(upgraded.files.map((file) => file.action)).toEqual(['patched', 'unchanged', 'unchanged']);
    const text = readFileSync(join(root, '.codex', 'config.toml'), 'utf8');
    expect(text).not.toContain('command =');
    expect(text.match(/^\[mcp_servers\.onememory\]$/gm)).toHaveLength(1);
  });
});
