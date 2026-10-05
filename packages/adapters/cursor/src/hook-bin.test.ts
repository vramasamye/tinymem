import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runHook } from './hook-bin';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-cursor-hook-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const PROJECT_ID = '019a7c0e-5b1f-7000-8000-00000000e001';
const NOW = new Date('2026-10-05T12:00:00.000Z');

interface RecordedRequest {
  url: string;
  method: string;
  body: unknown;
}

/** A written onememory project: `.onememory/project.json` + a live daemon lock. */
function writeProject(root: string, daemonUrl = 'http://127.0.0.1:7331'): void {
  mkdirSync(join(root, '.onememory'), { recursive: true });
  writeFileSync(
    join(root, '.onememory', 'project.json'),
    `${JSON.stringify(
      {
        version: 1,
        project_id: PROJECT_ID,
        name: 'demo',
        root_path: root,
        created_at: '2026-10-05T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(root, '.onememory', 'daemon.json'),
    `${JSON.stringify(
      {
        version: 1,
        pid: process.pid,
        host: '127.0.0.1',
        port: 7331,
        url: daemonUrl,
        started_at: '2026-10-05T00:00:00.000Z',
        version_string: '0.1.0',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

function fakeFetch(
  requests: RecordedRequest[],
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
    const response = handler(url, init);
    return new Response(JSON.stringify(response.body), {
      status: response.status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function sink(): { write(text: string): void; text: () => string } {
  let buffer = '';
  return { write: (text) => (buffer += text), text: () => buffer };
}

describe('runHook — delivery', () => {
  test('delivers translated events to the daemon ingest endpoint and exits 0', async () => {
    const root = tempDir();
    writeProject(root);
    const requests: RecordedRequest[] = [];
    const stderr = sink();
    const result = await runHook(
      {
        hook_event_name: 'postToolUse',
        workspace_roots: [root],
        conversation_id: 'conv-1',
        tool_name: 'Shell',
        tool_input: { command: 'bun test' },
        tool_output: JSON.stringify({ exitCode: 0, stdout: '1 pass' }),
      },
      {
        env: { HOME: root },
        now: NOW,
        stderr,
        stdout: sink(),
        fetch: fakeFetch(requests, () => ({ status: 200, body: { stored: 1, duplicates: 0, excluded: 0, dead_lettered: 0, warnings: [] } })),
      },
    );

    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe('delivered');
    expect(result.stored).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe(`http://127.0.0.1:7331/v1/projects/${PROJECT_ID}/events`);
    const body = requests[0]!.body as { events: Array<{ kind: string; source: { runtime: string } }> };
    expect(body.events).toHaveLength(1);
    expect(body.events[0]).toMatchObject({ kind: 'terminal.output', source: { runtime: 'cursor' } });
    // Diagnostics are one machine-readable line and never carry payload contents.
    expect(stderr.text().trim().split('\n')).toHaveLength(1);
    expect(stderr.text()).toContain('"outcome":"delivered"');
    expect(stderr.text()).not.toContain('bun test');
  });

  test('sessionStart injects the daemon context as additional_context and delivers session.start', async () => {
    const root = tempDir();
    writeProject(root);
    const requests: RecordedRequest[] = [];
    const stdout = sink();
    const result = await runHook(
      { hook_event_name: 'sessionStart', workspace_roots: [root], session_id: 'sess-1' },
      {
        env: { HOME: root },
        now: NOW,
        stderr: sink(),
        stdout,
        fetch: fakeFetch(requests, (url) =>
          url.includes('/context')
            ? { status: 200, body: { project_id: PROJECT_ID, budget: 750, used: 120, text: 'Auth: signed cookies', sections: [], warnings: [] } }
            : { status: 200, body: { stored: 1, duplicates: 0, excluded: 0, dead_lettered: 0, warnings: [] } },
        ),
      },
    );

    expect(result.contextInjected).toBe(true);
    expect(JSON.parse(stdout.text())).toEqual({ additional_context: 'Auth: signed cookies' });
    expect(requests.map((request) => request.url.split('/').slice(-1)[0])).toEqual(['context?budget=750', 'events']);
    expect(result.outcome).toBe('delivered');
  });

  test('an empty context response injects nothing (no empty additional_context object)', async () => {
    const root = tempDir();
    writeProject(root);
    const stdout = sink();
    const result = await runHook(
      { hook_event_name: 'sessionStart', workspace_roots: [root], session_id: 'sess-1' },
      {
        env: { HOME: root },
        now: NOW,
        stderr: sink(),
        stdout,
        fetch: fakeFetch([], (url) =>
          url.includes('/context')
            ? { status: 200, body: { project_id: PROJECT_ID, budget: 750, used: 0, text: '   ', sections: [], warnings: [] } }
            : { status: 200, body: { stored: 1, duplicates: 0, excluded: 0, dead_lettered: 0, warnings: [] } },
        ),
      },
    );
    expect(result.contextInjected).toBe(false);
    expect(stdout.text()).toBe('');
  });

  test('a dead daemon is fail-soft: one stderr line, exit 0, no throw', async () => {
    const root = tempDir();
    writeProject(root);
    const stderr = sink();
    const result = await runHook(
      {
        hook_event_name: 'afterFileEdit',
        workspace_roots: [root],
        conversation_id: 'conv-1',
        file_path: join(root, 'a.ts'),
        edits: [],
      },
      {
        env: { HOME: root },
        now: NOW,
        stderr,
        stdout: sink(),
        fetch: (async () => {
          throw new Error('ECONNREFUSED');
        }) as unknown as typeof fetch,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe('failed');
    expect(stderr.text()).toContain('cannot reach the onememory daemon');
  });

  test('an unresolved project skips delivery with a stable reason', async () => {
    const root = tempDir(); // no .onememory anywhere
    const stderr = sink();
    const result = await runHook(
      { hook_event_name: 'beforeSubmitPrompt', workspace_roots: [root], prompt: 'hello' },
      { env: { HOME: root }, now: NOW, stderr, stdout: sink(), fetch: fakeFetch([], () => ({ status: 200, body: {} })) },
    );
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('unresolved_project');
    expect(stderr.text()).toContain('unresolved_project');
  });

  test('a project without a live daemon lock skips delivery with no_daemon', async () => {
    const root = tempDir();
    writeProject(root);
    rmSync(join(root, '.onememory', 'daemon.json'));
    const result = await runHook(
      { hook_event_name: 'beforeSubmitPrompt', workspace_roots: [root], prompt: 'hello' },
      { env: { HOME: root }, now: NOW, stderr: sink(), stdout: sink(), fetch: fakeFetch([], () => ({ status: 200, body: {} })) },
    );
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('no_daemon');
  });

  test('an unparseable payload is skipped, and the bin never blocks (exit 0)', async () => {
    const stderr = sink();
    const result = await runHook('not-an-object', { env: {}, now: NOW, stderr, stdout: sink() });
    expect(result.exitCode).toBe(0);
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('invalid_input:not_an_object');
  });

  test('an event that maps to nothing reports no_events without calling the daemon', async () => {
    const root = tempDir();
    writeProject(root);
    const requests: RecordedRequest[] = [];
    const result = await runHook(
      { hook_event_name: 'stop', workspace_roots: [root], conversation_id: 'conv-1', status: 'completed', loop_count: 0 },
      { env: { HOME: root }, now: NOW, stderr: sink(), stdout: sink(), fetch: fakeFetch(requests, () => ({ status: 200, body: {} })) },
    );
    expect(result.outcome).toBe('no_events');
    expect(requests).toHaveLength(0);
  });
});
