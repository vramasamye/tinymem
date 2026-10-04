/**
 * `onemem init` runtime wiring, end to end through `main()` and the real PGlite pipeline:
 * consent (flags / interactive multi-select / nothing without consent), the daemon-backed MCP
 * entries both adapters emit, idempotent re-runs on an initialized project, merge preservation of
 * user files, refusal to clobber malformed files, and the doctor's runtimes group reading it back.
 *
 * The environment is injected without HOME, so the developer's real ~/.claude and ~/.codex are
 * never seen; interactive detection of a home directory uses an injected `pathExists`.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { parse as parseToml } from 'smol-toml';

import { main } from './bin';
import { runInit } from './commands/init';
import { detectRuntimes, runScaffoldPhase } from './commands/wire-runtimes';
import { createIo } from './io';
import type { Prompt, SelectOption } from './prompt';

const BOOT_TIMEOUT = 60_000;
const URL_7331 = 'http://127.0.0.1:7331/mcp';

interface Captured {
  out: string;
  err: string;
  exitCode: number;
}

async function cli(argv: string[]): Promise<Captured> {
  let out = '';
  let err = '';
  const exitCode = await main(argv, {
    interactive: false,
    env: {},
    write: (text) => {
      out += text;
    },
    writeErr: (text) => {
      err += text;
    },
  });
  return { out, err, exitCode };
}

function json(captured: Captured): any {
  return JSON.parse(captured.out);
}

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

let base: string;
let counter = 0;
function projectDir(): string {
  counter += 1;
  const dir = join(base, `p${counter}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

beforeAll(() => {
  base = join(process.env.TMPDIR ?? '/tmp', `onemem-init-wiring-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(base, { recursive: true });
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('consent', () => {
  test(
    'non-interactive, no flags, nothing detected: no runtime file is written and init says so',
    async () => {
      const dir = projectDir();
      const result = await cli(['init', '--preset', 'local', '--name', 'none', '--cwd', dir, '--json']);
      expect(result.exitCode).toBe(0);
      const document = json(result);
      expect(document.runtimes.wired).toEqual([]);
      expect(document.runtimes.detected).toEqual([]);
      expect(document.runtimes.notes.join(' ')).toContain('nothing was wired');
      expect(document.required_review).toEqual([]);
      for (const path of ['.mcp.json', '.claude', 'CLAUDE.md', '.codex', 'AGENTS.md']) {
        expect(existsSync(join(dir, path))).toBeFalse();
      }
    },
    BOOT_TIMEOUT,
  );

  test(
    'non-interactive with a detected runtime but no flag: still nothing written, with the flag to pass',
    async () => {
      const dir = projectDir();
      mkdirSync(join(dir, '.claude'));
      const result = await cli(['init', '--preset', 'local', '--name', 'detected', '--cwd', dir]);
      expect(result.exitCode).toBe(0);
      expect(result.out).toContain('Claude Code was detected but not wired');
      expect(result.out).toContain('--with-claude');
      expect(existsSync(join(dir, '.mcp.json'))).toBeFalse();
      expect(existsSync(join(dir, '.claude', 'settings.json'))).toBeFalse();
    },
    BOOT_TIMEOUT,
  );

  test(
    'interactive: the multi-select preselects detected runtimes and only the chosen ones are wired',
    async () => {
      const dir = projectDir();
      const home = join(base, 'fake-home');
      let offered: Array<SelectOption<string>> = [];
      let preselected: string[] = [];
      const prompt: Prompt = {
        intro: () => {},
        outro: () => {},
        note: () => {},
        select: async <T extends string>(_message: string, _options: SelectOption<T>[], initial: T) => initial,
        text: async (_message, options) => options.defaultValue ?? 'x',
        multiselect: async <T extends string>(_message: string, options: SelectOption<T>[], initial: T[]) => {
          offered = options;
          preselected = initial;
          return initial;
        },
      };
      let out = '';
      const io = createIo({ write: (text) => (out += text), writeErr: () => {}, interactive: true, json: true });
      const code = await runInit(
        {
          cwd: dir,
          env: { HOME: home },
          name: 'interactive',
          preset: 'local',
          pathExists: (path) => path === join(home, '.claude'),
        },
        io,
        prompt,
      );
      expect(code).toBe(0);
      expect(offered.map((option) => option.value)).toEqual(['claude-code', 'codex']);
      expect(offered[0]!.hint).toContain(join(home, '.claude'));
      expect(preselected).toEqual(['claude-code']);
      const document = JSON.parse(out);
      expect(document.runtimes.wired.map((wired: { runtime: string }) => wired.runtime)).toEqual(['claude-code']);
      expect(existsSync(join(dir, '.mcp.json'))).toBeTrue();
      expect(existsSync(join(dir, '.codex'))).toBeFalse();
    },
    BOOT_TIMEOUT,
  );
});

describe('--with-claude --with-codex', () => {
  let dir: string;
  let first: any;
  const userSettings = {
    permissions: { allow: ['Bash(bun test:*)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/local/bin/guard' }] }] },
  };

  beforeAll(async () => {
    dir = projectDir();
    // Pre-existing user files the merges must preserve.
    writeFileSync(join(dir, '.mcp.json'), `${JSON.stringify({ mcpServers: { context7: { command: 'npx' } } }, null, 2)}\n`);
    mkdirSync(join(dir, '.claude'));
    writeFileSync(join(dir, '.claude', 'settings.json'), `${JSON.stringify(userSettings, null, 2)}\n`);
    writeFileSync(join(dir, 'CLAUDE.md'), '# House rules\n\nUse tabs.\n');
    const result = await cli([
      'init', '--preset', 'local', '--name', 'wired', '--cwd', dir, '--with-claude', '--with-codex', '--json',
    ]);
    expect(result.exitCode).toBe(0);
    first = json(result);
  }, BOOT_TIMEOUT);

  test('Claude Code: .mcp.json gets the daemon http entry beside the user server', () => {
    const mcp = JSON.parse(read(join(dir, '.mcp.json')));
    expect(mcp.mcpServers.context7).toEqual({ command: 'npx' });
    expect(mcp.mcpServers.onememory).toEqual({ type: 'http', url: URL_7331 });
  });

  test('Claude Code: settings.json keeps user keys + hooks and gains the onememory hooks', () => {
    const settings = JSON.parse(read(join(dir, '.claude', 'settings.json')));
    expect(settings.permissions).toEqual(userSettings.permissions);
    expect(settings.hooks.PreToolUse).toEqual(userSettings.hooks.PreToolUse);
    for (const event of ['SessionStart', 'SessionEnd', 'Stop', 'PostToolUse', 'PostToolUseFailure']) {
      expect(settings.hooks[event]).toHaveLength(1);
    }
  });

  test('Claude Code: CLAUDE.md keeps its content and gains one pointer block', () => {
    const md = read(join(dir, 'CLAUDE.md'));
    expect(md.startsWith('# House rules\n\nUse tabs.\n')).toBeTrue();
    expect(md.match(/<!-- onemem:begin/g)).toHaveLength(1);
  });

  test('Codex: config.toml carries url = <daemon MCP url>; hooks.json and AGENTS.md are written', () => {
    const toml = parseToml(read(join(dir, '.codex', 'config.toml'))) as Record<string, any>;
    expect(toml['mcp_servers']['onememory']).toEqual({ url: URL_7331 });
    expect(JSON.parse(read(join(dir, '.codex', 'hooks.json'))).hooks.SessionStart).toBeDefined();
    expect(read(join(dir, 'AGENTS.md'))).toContain(first.project.id);
  });

  test('the result reports files, required review steps and the daemon-first next step', () => {
    expect(first.runtimes.mcp_url).toBe(URL_7331);
    const [claude, codex] = first.runtimes.wired;
    expect(claude.runtime).toBe('claude-code');
    expect(claude.files.map((file: { action: string }) => file.action)).toEqual(['patched', 'patched', 'patched']);
    expect(codex.files.map((file: { action: string }) => file.action)).toEqual(['created', 'created', 'created']);
    const review = first.required_review.join('\n');
    expect(review).toContain('Claude Code: Claude Code asks you to approve');
    expect(review).toContain('Codex: project-scoped .codex/config.toml only loads for trusted projects');
    expect(review).toContain('/hooks');
    expect(first.next_steps.some((step: string) => step.startsWith('onemem serve — start the daemon BEFORE launching Claude Code / Codex'))).toBeTrue();
  });

  test(
    'doctor reports both runtimes as pass against the configured daemon URL',
    async () => {
      const doctor = await cli(['doctor', '--cwd', dir, '--no-probe', '--json']);
      expect(doctor.exitCode).toBe(0);
      const report = json(doctor);
      expect(report.runtimes.map((check: { id: string; status: string }) => [check.id, check.status])).toEqual([
        ['runtime-claude-code', 'pass'],
        ['runtime-codex', 'pass'],
      ]);
      const human = await cli(['doctor', '--cwd', dir, '--no-probe']);
      expect(human.out).toContain('agent runtimes');
      expect(human.out).toContain('[ok] Claude Code');
    },
    BOOT_TIMEOUT,
  );

  test(
    're-running on the initialized project with the flags is an idempotent no-op',
    async () => {
      const before = ['.mcp.json', '.claude/settings.json', 'CLAUDE.md', '.codex/config.toml', '.codex/hooks.json', 'AGENTS.md'].map(
        (path) => read(join(dir, path)),
      );
      const again = await cli(['init', '--cwd', dir, '--with-claude', '--with-codex', '--json']);
      expect(again.exitCode).toBe(0);
      const document = json(again);
      expect(document.status).toBe('already-initialized');
      for (const wired of document.runtimes.wired) {
        expect(wired.files.map((file: { action: string }) => file.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
      }
      const after = ['.mcp.json', '.claude/settings.json', 'CLAUDE.md', '.codex/config.toml', '.codex/hooks.json', 'AGENTS.md'].map(
        (path) => read(join(dir, path)),
      );
      expect(after).toEqual(before);
    },
    BOOT_TIMEOUT,
  );

  test(
    'a changed daemon port: doctor warns on the mismatch, re-wiring follows the config',
    async () => {
      const configPath = join(dir, '.onememory', 'onememory.yaml');
      writeFileSync(configPath, read(configPath).replace(/^  port: 7331$/m, '  port: 7400'));
      const stale = json(await cli(['doctor', '--cwd', dir, '--no-probe', '--json']));
      expect(stale.runtimes.map((check: { status: string }) => check.status)).toEqual(['warn', 'warn']);
      expect(stale.runtimes[0].detail).toContain('http://127.0.0.1:7400/mcp');

      const rewired = json(await cli(['init', '--cwd', dir, '--with-claude', '--with-codex', '--json']));
      expect(rewired.runtimes.mcp_url).toBe('http://127.0.0.1:7400/mcp');
      expect(JSON.parse(read(join(dir, '.mcp.json'))).mcpServers.onememory.url).toBe('http://127.0.0.1:7400/mcp');
      const toml = parseToml(read(join(dir, '.codex', 'config.toml'))) as Record<string, any>;
      expect(toml['mcp_servers']['onememory']['url']).toBe('http://127.0.0.1:7400/mcp');

      const fresh = json(await cli(['doctor', '--cwd', dir, '--no-probe', '--json']));
      expect(fresh.runtimes.map((check: { status: string }) => check.status)).toEqual(['pass', 'pass']);
    },
    BOOT_TIMEOUT,
  );
});

describe('already initialized', () => {
  test(
    'without flags: the old message plus a one-line wiring hint, nothing written',
    async () => {
      const dir = projectDir();
      expect((await cli(['init', '--preset', 'local', '--name', 'again', '--cwd', dir])).exitCode).toBe(0);
      const again = await cli(['init', '--cwd', dir]);
      expect(again.exitCode).toBe(0);
      expect(again.out).toContain('already initialized');
      expect(again.out).toContain('onemem doctor');
      expect(again.out).toContain('re-run with --with-claude and/or --with-codex');
      expect(existsSync(join(dir, '.mcp.json'))).toBeFalse();
    },
    BOOT_TIMEOUT,
  );

  test(
    'a malformed settings.json is reported, left byte-identical, and the rest still wires',
    async () => {
      const dir = projectDir();
      expect((await cli(['init', '--preset', 'local', '--name', 'broken', '--cwd', dir])).exitCode).toBe(0);
      mkdirSync(join(dir, '.claude'));
      const broken = '{ "hooks": { "Stop": [ ';
      writeFileSync(join(dir, '.claude', 'settings.json'), broken);

      const result = await cli(['init', '--cwd', dir, '--with-claude']);
      expect(result.exitCode).toBe(0);
      expect(read(join(dir, '.claude', 'settings.json'))).toBe(broken);
      expect(result.out).toContain('skipped');
      expect(result.out).toContain('settings.json is not valid JSON and was left untouched');
      expect(result.err).toContain('left untouched');
      expect(JSON.parse(read(join(dir, '.mcp.json'))).mcpServers.onememory.url).toBe(URL_7331);

      const doctor = json(await cli(['doctor', '--cwd', dir, '--no-probe', '--json']));
      const claude = doctor.runtimes.find((check: { id: string }) => check.id === 'runtime-claude-code');
      expect(claude.status).toBe('warn');
      expect(claude.remediation).toContain('fix');
    },
    BOOT_TIMEOUT,
  );
});

describe('scaffold phase units', () => {
  test('detection reads HOME / CODEX_HOME from the injected env only', () => {
    const seen: string[] = [];
    const detection = detectRuntimes('/repo', { HOME: '/h', CODEX_HOME: '/ch' }, (path) => {
      seen.push(path);
      return path === '/ch' || path === '/repo/.claude';
    });
    expect(seen).toEqual(['/h/.claude', '/repo/.claude', '/ch', '/h/.codex', '/repo/.codex']);
    expect(detection).toEqual([
      { runtime: 'claude-code', detected: true, evidence: ['/repo/.claude'] },
      { runtime: 'codex', detected: true, evidence: ['/ch'] },
    ]);
    expect(detectRuntimes('/repo', {}, () => false).every((entry) => !entry.detected)).toBeTrue();
  });

  test('a non-loopback daemon host wires nothing and explains why', () => {
    const phase = runScaffoldPhase({
      root: join(base, 'never-written'),
      projectId: '01900000-0000-7000-8000-0000000000e1',
      projectName: 'remote',
      mcpUrl: 'http://10.0.0.5:7331/mcp',
      runtimes: ['claude-code', 'codex'],
      detected: [],
    });
    expect(phase.wired).toEqual([]);
    expect(phase.notes.join(' ')).toContain('not a loopback address');
    expect(existsSync(join(base, 'never-written'))).toBeFalse();
  });
});
