import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, parseBinArgs } from './bin';
import {
  FIXTURE_PROJECT_ID,
  sessionStartHookInput,
  startFakeDaemon,
  userPromptSubmitHookInput,
} from './testing';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-codex-bin-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseBinArgs', () => {
  test('parses every documented flag', () => {
    expect(parseBinArgs(['--rollout', '/tmp/s.jsonl', '--project', 'p1', '--cwd', '/w', '--context-budget', '500', '--timeout', '1000'])).toEqual({
      rollout: '/tmp/s.jsonl',
      project: 'p1',
      cwd: '/w',
      contextBudget: 500,
      timeoutMs: 1000,
    });
  });

  test('--help/-h and bare invocation parse clean', () => {
    expect(parseBinArgs(['--help'])).toEqual({ help: true });
    expect(parseBinArgs([])).toEqual({});
  });

  test('usage errors are precise', () => {
    expect(parseBinArgs(['--rollout'])).toEqual({ error: '--rollout requires a file path' });
    expect(parseBinArgs(['--project'])).toEqual({ error: '--project requires a project id' });
    expect(parseBinArgs(['--timeout', 'fast'])).toEqual({
      error: '--timeout requires a positive integer (ms)',
    });
    expect(parseBinArgs(['--nonsense'])).toEqual({ error: 'unknown argument: --nonsense' });
  });
});

describe('main — the fail-soft exit-code contract', () => {
  const readStdin = async () => '';

  test('usage errors exit 2 with the usage text on stderr', async () => {
    const stderr: string[] = [];
    const code = await main(['--bogus'], { stderr: (text) => stderr.push(text) }, readStdin);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('unknown argument');
    expect(stderr.join('')).toContain('Usage:');
  });

  test('--help exits 0', async () => {
    const code = await main(['--help'], {}, readStdin);
    expect(code).toBe(0);
  });

  test('a good payload with no daemon exits 0 with a diagnostic (capture never fails the agent)', async () => {
    const stderr: string[] = [];
    const code = await main(
      [],
      { stdin: JSON.stringify(userPromptSubmitHookInput('hello')), stderr: (t) => stderr.push(t), env: {}, cwd: tempDir() },
      readStdin,
    );
    expect(code).toBe(0);
    expect(stderr.join('')).toContain('[onememory]');
  });

  test('empty stdin and bad JSON are quiet exit-0 no-ops', async () => {
    const stderrEmpty: string[] = [];
    expect(
      await main([], { stdin: '   ', stderr: (t) => stderrEmpty.push(t), env: {} }, readStdin),
    ).toBe(0);
    expect(stderrEmpty.join('')).toContain('empty-input');

    const stderrBad: string[] = [];
    expect(
      await main([], { stdin: '{oops', stderr: (t) => stderrBad.push(t), env: {} }, readStdin),
    ).toBe(0);
    expect(stderrBad.join('')).toContain('bad-json');
  });

  test('a successful capture prints its summary on stderr, nothing on stdout', async () => {
    const daemon = await startFakeDaemon();
    try {
      const stdout: string[] = [];
      const stderr: string[] = [];
      const code = await main(
        [],
        {
          stdin: JSON.stringify(userPromptSubmitHookInput('hello')),
          stdout: (t) => stdout.push(t),
          stderr: (t) => stderr.push(t),
          env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
        },
        readStdin,
      );
      expect(code).toBe(0);
      expect(stdout).toEqual([]);
      expect(stderr.join('')).toContain('captured 1 event');
      expect(daemon.receivedEvents).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  test('SessionStart prints ONLY the hook output JSON on stdout', async () => {
    const daemon = await startFakeDaemon({ contextText: '## Decisions\n- pgvector only.' });
    try {
      const stdout: string[] = [];
      const code = await main(
        [],
        {
          stdin: JSON.stringify(sessionStartHookInput()),
          stdout: (t) => stdout.push(t),
          env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
        },
        readStdin,
      );
      expect(code).toBe(0);
      const printed = JSON.parse(stdout.join(''));
      expect(printed.hookSpecificOutput.hookEventName).toBe('SessionStart');
      expect(printed.hookSpecificOutput.additionalContext).toContain('pgvector only');
    } finally {
      await daemon.close();
    }
  });

  test('SessionStart with no daemon prints NOTHING on stdout and still exits 0', async () => {
    const stdout: string[] = [];
    const code = await main(
      [],
      {
        stdin: JSON.stringify(sessionStartHookInput()),
        stdout: (t) => stdout.push(t),
        env: {},
        cwd: tempDir(),
      },
      readStdin,
    );
    expect(code).toBe(0);
    expect(stdout).toEqual([]);
  });

  test('an unreadable rollout file exits 2 (operator error, not capture failure)', async () => {
    const stderr: string[] = [];
    const code = await main(['--rollout', join(tempDir(), 'missing.jsonl')], { stderr: (t) => stderr.push(t), env: {} }, readStdin);
    expect(code).toBe(2);
    expect(stderr.join('')).toContain('cannot read rollout file');
  });

  test('--rollout ingests a file through the normal pipeline', async () => {
    const daemon = await startFakeDaemon();
    try {
      const root = tempDir();
      const file = join(root, 'rollout.jsonl');
      writeFileSync(
        file,
        JSON.stringify({
          timestamp: '2026-10-03T09:00:00.000Z',
          type: 'session_meta',
          payload: {
            id: '019a7c0e-5b1f-7000-8000-00000000e001',
            session_id: '019a7c0e-5b1f-7000-8000-00000000e001',
            timestamp: '2026-10-03T09:00:00.000Z',
            cwd: '/workspace/demo',
            originator: 'codex_cli_rs',
            cli_version: '0.134.0',
          },
        }) + '\n',
        'utf8',
      );
      const stderr: string[] = [];
      const code = await main(['--rollout', file], {
        stderr: (t) => stderr.push(t),
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      }, readStdin);
      expect(code).toBe(0);
      expect(stderr.join('')).toContain('captured 1 event');
      expect(daemon.receivedEvents).toHaveLength(1);
    } finally {
      await daemon.close();
    }
  });

  test('--project and --timeout flags flow through to delivery', async () => {
    const daemon = await startFakeDaemon();
    try {
      const stderr: string[] = [];
      const code = await main(
        ['--project', FIXTURE_PROJECT_ID, '--timeout', '2000'],
        {
          stdin: JSON.stringify(userPromptSubmitHookInput('hello')),
          stderr: (t) => stderr.push(t),
          env: { ONEMEMORY_DAEMON_URL: daemon.url },
        },
        readStdin,
      );
      expect(code).toBe(0);
      expect(daemon.receivedEvents).toHaveLength(1);
      expect(daemon.requests[0]!.path).toContain(FIXTURE_PROJECT_ID);
    } finally {
      await daemon.close();
    }
  });
});
