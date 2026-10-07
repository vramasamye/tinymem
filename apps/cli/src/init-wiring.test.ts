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
/** The per-runtime identity URL the wire step writes (M17: `?agent=` rides every runtime's MCP URL). */
const urlOf = (agent: string): string => `${URL_7331}?agent=${agent}`;

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
      expect(offered.map((option) => option.value)).toEqual(['claude-code', 'codex', 'cursor', 'pi', 'opencode']);
      expect(offered[0]!.hint).toContain(join(home, '.claude'));
      expect(preselected).toEqual(['claude-code']);
      const document = JSON.parse(out);
      expect(document.runtimes.wired.map((wired: { runtime: string }) => wired.runtime)).toEqual(['claude-code']);
      expect(existsSync(join(dir, '.mcp.json'))).toBeTrue();
      expect(existsSync(join(dir, '.codex'))).toBeFalse();
      expect(existsSync(join(dir, '.cursor'))).toBeFalse();
      expect(existsSync(join(dir, '.pi'))).toBeFalse();
      expect(existsSync(join(dir, '.opencode'))).toBeFalse();
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
    expect(mcp.mcpServers.onememory).toEqual({ type: 'http', url: urlOf('onemem-claude-code') });
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
    expect(toml['mcp_servers']['onememory']).toEqual({ url: urlOf('onemem-codex') });
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
    'doctor reports the wired runtimes as pass (Cursor stays opt-in info) against the configured daemon URL',
    async () => {
      const doctor = await cli(['doctor', '--cwd', dir, '--no-probe', '--json']);
      expect(doctor.exitCode).toBe(0);
      const report = json(doctor);
      expect(report.runtimes.map((check: { id: string; status: string }) => [check.id, check.status])).toEqual([
        ['runtime-claude-code', 'pass'],
        ['runtime-codex', 'pass'],
        ['runtime-cursor', 'info'],
        ['runtime-pi', 'info'],
        ['runtime-opencode', 'info'],
      ]);
      const human = await cli(['doctor', '--cwd', dir, '--no-probe']);
      expect(human.out).toContain('agent runtimes');
      expect(human.out).toContain('[ok] Claude Code');
      expect(human.out).toContain('[info] Cursor');
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
      expect(stale.runtimes.map((check: { status: string }) => check.status)).toEqual([
        'warn',
        'warn',
        'info',
        'info',
        'info',
      ]);
      expect(stale.runtimes[0].detail).toContain('http://127.0.0.1:7400/mcp');

      const rewired = json(await cli(['init', '--cwd', dir, '--with-claude', '--with-codex', '--json']));
      expect(rewired.runtimes.mcp_url).toBe('http://127.0.0.1:7400/mcp');
      expect(JSON.parse(read(join(dir, '.mcp.json'))).mcpServers.onememory.url).toBe('http://127.0.0.1:7400/mcp?agent=onemem-claude-code');
      const toml = parseToml(read(join(dir, '.codex', 'config.toml'))) as Record<string, any>;
      expect(toml['mcp_servers']['onememory']['url']).toBe('http://127.0.0.1:7400/mcp?agent=onemem-codex');

      const fresh = json(await cli(['doctor', '--cwd', dir, '--no-probe', '--json']));
      expect(fresh.runtimes.map((check: { status: string }) => check.status)).toEqual([
        'pass',
        'pass',
        'info',
        'info',
        'info',
      ]);
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
      expect(again.out).toContain('re-run with --with-claude, --with-codex, --with-cursor, --with-pi and/or --with-opencode');
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
      expect(JSON.parse(read(join(dir, '.mcp.json'))).mcpServers.onememory.url).toBe(urlOf('onemem-claude-code'));

      const doctor = json(await cli(['doctor', '--cwd', dir, '--no-probe', '--json']));
      const claude = doctor.runtimes.find((check: { id: string }) => check.id === 'runtime-claude-code');
      expect(claude.status).toBe('warn');
      expect(claude.remediation).toContain('fix');
    },
    BOOT_TIMEOUT,
  );
});

describe('--with-cursor', () => {
  let dir: string;
  let first: any;

  beforeAll(async () => {
    dir = projectDir();
    // A pre-existing Cursor config the merges must preserve.
    mkdirSync(join(dir, '.cursor'), { recursive: true });
    writeFileSync(
      join(dir, '.cursor', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } }, null, 2)}\n`,
    );
    writeFileSync(
      join(dir, '.cursor', 'hooks.json'),
      `${JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: './format.sh' }] } }, null, 2)}\n`,
    );
    const result = await cli(['init', '--preset', 'local', '--name', 'cursor-demo', '--cwd', dir, '--with-cursor', '--json']);
    expect(result.exitCode).toBe(0);
    first = json(result);
  }, BOOT_TIMEOUT);

  test('writes .cursor/mcp.json with the daemon http entry beside the user server', () => {
    const document = JSON.parse(read(join(dir, '.cursor', 'mcp.json'))) as { mcpServers: Record<string, unknown> };
    expect(document.mcpServers['onememory']).toEqual({ url: urlOf('onemem-cursor') });
    expect(document.mcpServers['linear']).toEqual({ url: 'https://mcp.linear.app/sse' });
  });

  test('writes .cursor/hooks.json with the capture hooks beside the user hooks', () => {
    const document = JSON.parse(read(join(dir, '.cursor', 'hooks.json'))) as {
      version: number;
      hooks: Record<string, Array<{ command: string }>>;
    };
    expect(document.version).toBe(1);
    expect(document.hooks['afterFileEdit']?.map((entry) => entry.command)).toEqual([
      './format.sh',
      'bun node_modules/@onememory/adapter-cursor/src/bin.ts',
    ]);
    expect(document.hooks['sessionStart']).toBeDefined();
    expect(document.hooks['sessionEnd']).toBeDefined();
    // stop is deliberately not subscribed.
    expect(document.hooks['stop']).toBeUndefined();
  });

  test('writes the always-applied .cursor/rules/onememory.mdc pointer', () => {
    const rule = read(join(dir, '.cursor', 'rules', 'onememory.mdc'));
    expect(rule.startsWith('---\ndescription: "')).toBe(true);
    expect(rule).toContain('alwaysApply: true');
    expect(rule).toContain('onemem:begin');
  });

  test('the result reports the three files, the review step and the daemon-first next step', () => {
    const wired = first.runtimes.wired.find((entry: { runtime: string }) => entry.runtime === 'cursor');
    expect(wired.files.map((file: { action: string }) => file.action)).toEqual(['patched', 'patched', 'created']);
    expect(first.required_review.join('\n')).toContain('Cursor: Cursor asks for tool approval');
    expect(
      first.next_steps.some((step: string) => step.startsWith('onemem serve — start the daemon BEFORE launching Cursor')),
    ).toBeTrue();
  });

  test(
    'doctor detects the Cursor wiring as pass against the configured daemon URL',
    async () => {
      const report = json(await cli(['doctor', '--cwd', dir, '--no-probe', '--json']));
      const cursor = report.runtimes.find((check: { id: string }) => check.id === 'runtime-cursor');
      expect(cursor.status).toBe('pass');
      expect(cursor.detail).toContain('http://127.0.0.1:7331/mcp');
      const human = await cli(['doctor', '--cwd', dir, '--no-probe']);
      expect(human.out).toContain('[ok] Cursor');
    },
    BOOT_TIMEOUT,
  );

  test(
    're-running is an idempotent no-op and a changed port is re-wired',
    async () => {
      const before = ['.cursor/mcp.json', '.cursor/hooks.json', '.cursor/rules/onememory.mdc'].map((path) =>
        read(join(dir, path)),
      );
      const again = json(await cli(['init', '--cwd', dir, '--with-cursor', '--json']));
      const wired = again.runtimes.wired.find((entry: { runtime: string }) => entry.runtime === 'cursor');
      expect(wired.files.map((file: { action: string }) => file.action)).toEqual(['unchanged', 'unchanged', 'unchanged']);
      expect(['.cursor/mcp.json', '.cursor/hooks.json', '.cursor/rules/onememory.mdc'].map((path) => read(join(dir, path)))).toEqual(
        before,
      );

      const configPath = join(dir, '.onememory', 'onememory.yaml');
      writeFileSync(configPath, read(configPath).replace(/^  port: 7331$/m, '  port: 7400'));
      const stale = json(await cli(['doctor', '--cwd', dir, '--no-probe', '--json']));
      const staleCursor = stale.runtimes.find((check: { id: string }) => check.id === 'runtime-cursor');
      expect(staleCursor.status).toBe('warn');
      expect(staleCursor.detail).toContain('http://127.0.0.1:7400/mcp');

      json(await cli(['init', '--cwd', dir, '--with-cursor', '--json']));
      expect(JSON.parse(read(join(dir, '.cursor', 'mcp.json'))).mcpServers.onememory.url).toBe('http://127.0.0.1:7400/mcp?agent=onemem-cursor');
    },
    BOOT_TIMEOUT,
  );
});

describe('--with-pi', () => {
  let dir: string;
  let first: any;

  beforeAll(async () => {
    dir = projectDir();
    // A pre-existing Pi config the merges must preserve.
    mkdirSync(join(dir, '.pi'), { recursive: true });
    writeFileSync(
      join(dir, '.pi', 'mcp.json'),
      `${JSON.stringify({ mcpServers: { linear: { url: 'https://mcp.linear.app/sse' } } }, null, 2)}\n`,
    );
    writeFileSync(join(dir, '.pi', 'APPEND_SYSTEM.md'), 'team conventions\n');
    const result = await cli(['init', '--preset', 'local', '--name', 'pi-demo', '--cwd', dir, '--with-pi', '--json']);
    expect(result.exitCode).toBe(0);
    first = json(result);
  }, BOOT_TIMEOUT);

  test('writes .pi/mcp.json with the daemon http entry beside the user server', () => {
    const document = JSON.parse(read(join(dir, '.pi', 'mcp.json'))) as { mcpServers: Record<string, unknown> };
    expect((document.mcpServers['onememory'] as { url: string }).url).toBe(urlOf('onemem-pi'));
    expect((document.mcpServers['linear'] as { url: string }).url).toBe('https://mcp.linear.app/sse');
  });

  test('writes the generated extension and keeps the user APPEND_SYSTEM.md prose', () => {
    const extension = read(join(dir, '.pi', 'extensions', 'onememory.ts'));
    expect(extension).toContain('createPiExtension');
    const pointer = read(join(dir, '.pi', 'APPEND_SYSTEM.md'));
    expect(pointer.startsWith('team conventions')).toBe(true);
    expect(pointer).toContain('onemem:begin');
  });

  test('the result reports the three files and the review steps', () => {
    const wired = first.runtimes.wired.find((entry: { runtime: string }) => entry.runtime === 'pi');
    expect(wired.files.map((file: { action: string }) => file.action)).toEqual(['patched', 'created', 'patched']);
    const review = first.required_review.join('\n');
    expect(review).toContain('only after project trust is granted');
    expect(review).toContain('/reload');
  });

  test(
    'doctor detects the Pi wiring as pass, and a re-run is an idempotent no-op',
    async () => {
      const report = json(await cli(['doctor', '--cwd', dir, '--no-probe', '--json']));
      const pi = report.runtimes.find((check: { id: string }) => check.id === 'runtime-pi');
      expect(pi.status).toBe('pass');
      expect(pi.detail).toContain(urlOf('onemem-pi'));
      const human = await cli(['doctor', '--cwd', dir, '--no-probe']);
      expect(human.out).toContain('[ok] Pi');

      const again = json(await cli(['init', '--cwd', dir, '--with-pi', '--json']));
      const wired = again.runtimes.wired.find((entry: { runtime: string }) => entry.runtime === 'pi');
      expect(wired.files.map((file: { action: string }) => file.action)).toEqual([
        'unchanged',
        'unchanged',
        'unchanged',
      ]);
    },
    BOOT_TIMEOUT,
  );
});

describe('--with-opencode', () => {
  let dir: string;
  let first: any;

  beforeAll(async () => {
    dir = projectDir();
    // A pre-existing OpenCode config with a user server + instruction the merges must preserve.
    writeFileSync(
      join(dir, 'opencode.json'),
      `${JSON.stringify(
        { theme: 'opencode', mcp: { filesystem: { type: 'local', command: ['npx', 'fs-serve'] } }, instructions: ['.opencode/rules/team.md'] },
        null,
        2,
      )}\n`,
    );
    const result = await cli(['init', '--preset', 'local', '--name', 'opencode-demo', '--cwd', dir, '--with-opencode', '--json']);
    expect(result.exitCode).toBe(0);
    first = json(result);
  }, BOOT_TIMEOUT);

  test('writes opencode.json with the daemon http entry, keeping the user keys', () => {
    const document = JSON.parse(read(join(dir, 'opencode.json'))) as {
      theme: string;
      mcp: Record<string, unknown>;
      instructions: string[];
    };
    expect(document.theme).toBe('opencode');
    expect(document.mcp['onememory']).toEqual({ type: 'remote', url: urlOf('onemem-opencode'), enabled: true });
    expect(document.mcp['filesystem']).toEqual({ type: 'local', command: ['npx', 'fs-serve'] });
    expect(document.instructions).toEqual(['.opencode/rules/team.md', '.opencode/onememory.md']);
  });

  test('writes the auto-loaded plugin shim and the instructions pointer', () => {
    const plugin = read(join(dir, '.opencode', 'plugins', 'onememory.ts'));
    expect(plugin).toContain('createOpenCodePlugin');
    const pointer = read(join(dir, '.opencode', 'onememory.md'));
    expect(pointer).toContain('onemem:begin');
    expect(pointer).toContain('memory_search');
  });

  test('the result reports the three files and the review steps', () => {
    const wired = first.runtimes.wired.find((entry: { runtime: string }) => entry.runtime === 'opencode');
    expect(wired.files.map((file: { action: string }) => file.action)).toEqual(['patched', 'created', 'created']);
    const review = first.required_review.join('\n');
    expect(review).toContain('restart opencode after scaffolding');
    expect(review).toContain('permission');
  });

  test(
    'doctor detects the OpenCode wiring as pass, and a re-run is an idempotent no-op',
    async () => {
      const report = json(await cli(['doctor', '--cwd', dir, '--no-probe', '--json']));
      const opencode = report.runtimes.find((check: { id: string }) => check.id === 'runtime-opencode');
      expect(opencode.status).toBe('pass');
      expect(opencode.detail).toContain(urlOf('onemem-opencode'));
      const human = await cli(['doctor', '--cwd', dir, '--no-probe']);
      expect(human.out).toContain('[ok] OpenCode');

      const again = json(await cli(['init', '--cwd', dir, '--with-opencode', '--json']));
      const wired = again.runtimes.wired.find((entry: { runtime: string }) => entry.runtime === 'opencode');
      expect(wired.files.map((file: { action: string }) => file.action)).toEqual([
        'unchanged',
        'unchanged',
        'unchanged',
      ]);
    },
    BOOT_TIMEOUT,
  );
});

describe('scaffold phase units', () => {
  test('detection reads HOME / CODEX_HOME from the injected env only', () => {
    const seen: string[] = [];
    const detection = detectRuntimes('/repo', { HOME: '/h', CODEX_HOME: '/ch' }, (path) => {
      seen.push(path);
      return path === '/ch' || path === '/repo/.claude' || path === '/h/.cursor' || path === '/repo/.pi' || path === '/h/.config/opencode';
    });
    expect(seen).toEqual([
      '/h/.claude',
      '/repo/.claude',
      '/ch',
      '/h/.codex',
      '/repo/.codex',
      '/h/.cursor',
      '/repo/.cursor',
      '/h/.pi',
      '/repo/.pi',
      '/h/.config/opencode',
      '/repo/.opencode',
      '/repo/opencode.json',
    ]);
    expect(detection).toEqual([
      { runtime: 'claude-code', detected: true, evidence: ['/repo/.claude'] },
      { runtime: 'codex', detected: true, evidence: ['/ch'] },
      { runtime: 'cursor', detected: true, evidence: ['/h/.cursor'] },
      { runtime: 'pi', detected: true, evidence: ['/repo/.pi'] },
      { runtime: 'opencode', detected: true, evidence: ['/h/.config/opencode'] },
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
