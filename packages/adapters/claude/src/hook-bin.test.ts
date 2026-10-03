/**
 * Hook-binary integration tests: the REAL `src/bin.ts` process spawned as Claude Code would
 * spawn it, against a fake daemon (Bun.serve) and a real temp project (`.onememory/project.json`
 * + `daemon.json` + transcript). Covers the mission's fail-soft contract end to end:
 * exit 0 ALWAYS, stderr diagnostics as machine-readable one-liners, no payload contents on
 * stdout, SessionStart context injection under its budget, and Stop transcript deltas with
 * cursor state.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { readHookState, ADAPTER_STATE_RELPATH } from './discovery';
import { runHook } from './hook-bin';

const BIN_PATH = join(import.meta.dir, 'bin.ts');
const PROJECT_ID = '0195a7f0-9f5e-7a1d-bc2d-0000000000aa';
const CONTEXT_TEXT =
  'Project memory (onememory):\n- Decision: use PGlite for embedded mode\n- Failure: ECONNREFUSED on ollama - resolved by starting the server';

interface Received {
  method: string;
  path: string;
  body: unknown;
  budget: number | null;
}

let requests: Received[] = [];

const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const body = request.method === 'POST' ? await request.json() : null;
    requests.push({
      method: request.method,
      path: url.pathname,
      body,
      budget: url.searchParams.has('budget') ? Number(url.searchParams.get('budget')) : null,
    });
    const eventsMatch = /^\/v1\/projects\/([^/]+)\/events$/.exec(url.pathname);
    if (eventsMatch !== null && request.method === 'POST') {
      const events = (body as { events: unknown[] }).events;
      return Response.json({
        outcomes: events.map((_, index) => ({ index, status: 'stored' })),
        stored: events.length,
        duplicates: 0,
        excluded: 0,
        dead_lettered: 0,
        normalize_job_id: '0195a7f0-9f5e-7a1d-bc2d-0000000000c1',
        warnings: [],
      });
    }
    const contextMatch = /^\/v1\/projects\/([^/]+)\/context$/.exec(url.pathname);
    if (contextMatch !== null) {
      return Response.json({
        project_id: contextMatch[1],
        budget: Number(url.searchParams.get('budget') ?? 750),
        used: 42,
        text: CONTEXT_TEXT,
        sections: [{ kind: 'digest', tokens: 42, text: CONTEXT_TEXT }],
        warnings: [],
      });
    }
    return new Response('not found', { status: 404 });
  },
});

beforeAll(() => {
  requests = [];
});
afterAll(() => server.stop(true));

interface SpawnedRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Spawn the real bin exactly the way a Claude Code hook would. */
async function runHookProcess(payload: unknown, options: { cwd: string; env?: Record<string, string> }): Promise<SpawnedRun> {
  const proc = Bun.spawn({
    cmd: [process.execPath, BIN_PATH],
    cwd: options.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, ...options.env, CLAUDE_PROJECT_DIR: options.cwd },
  });
  proc.stdin.write(typeof payload === 'string' ? payload : JSON.stringify(payload));
  await proc.stdin.end();
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** A temp project with `.onememory/project.json` + a live `daemon.json` pointing at the fake daemon. */
interface TempProject {
  dir: string;
  configDir: string;
  transcriptPath: string;
  cleanup: () => void;
}

function makeProject(transcriptText?: string, options: { daemonPid?: number; daemonUrl?: string } = {}): TempProject {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-claude-'));
  const configDir = join(dir, '.onememory');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(
    join(configDir, 'project.json'),
    `${JSON.stringify(
      {
        version: 1,
        project_id: PROJECT_ID,
        name: 'fixture',
        root_path: dir,
        created_at: '2026-10-03T09:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  writeFileSync(
    join(configDir, 'daemon.json'),
    `${JSON.stringify(
      {
        version: 1,
        pid: options.daemonPid ?? process.pid,
        host: '127.0.0.1',
        port: server.port,
        url: options.daemonUrl ?? `http://127.0.0.1:${server.port}`,
        started_at: '2026-10-03T09:00:00.000Z',
        version_string: 'test',
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  const transcriptPath = join(dir, 'session.jsonl');
  if (transcriptText !== undefined) writeFileSync(transcriptPath, transcriptText, 'utf8');
  return { dir, configDir, transcriptPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** One machine-readable stderr line per diagnostic — parse them all. */
function diagLines(stderr: string): Array<Record<string, unknown>> {
  return stderr
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** A three-line conversation used by the Stop-delta tests (and the direct runHook test below). */
const transcriptLines = [
  JSON.stringify({ uuid: 'u1', type: 'user', message: { role: 'user', content: 'We decided to use PGlite for embedded mode.' }, timestamp: '2026-10-03T09:00:00.000Z' }),
  JSON.stringify({ uuid: 'u2', type: 'user', message: { role: 'user', content: 'Remember that we use bun test over jest' }, timestamp: '2026-10-03T09:00:05.000Z' }),
  JSON.stringify({ uuid: 'u3', type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'Running the suite now.' }] }, timestamp: '2026-10-03T09:00:10.000Z' }),
].join('\n');

const postToolUseBash = {
  session_id: 'sess-1',
  cwd: '/will-be-overridden',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'bun test', description: 'Run tests', run_in_background: false },
  tool_response: { stdout: '87 pass', stderr: '', interrupted: false, isImage: false },
  tool_use_id: 'toolu_1',
} as Record<string, unknown>;

describe('hook binary: delivery end to end', () => {
  test('PostToolUse Bash against a live daemon: exit 0, event delivered, stdout silent', async () => {
    const project = makeProject();
    requests = [];
    try {
      const run = await runHookProcess(postToolUseBash, { cwd: project.dir });
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe('');
      expect(requests).toHaveLength(1);
      expect(requests[0]!.path).toBe(`/v1/projects/${PROJECT_ID}/events`);
      const body = requests[0]!.body as { events: Array<Record<string, unknown>> };
      expect(body.events).toHaveLength(1);
      const event = body.events[0]!;
      expect(event.kind).toBe('terminal.output');
      expect((event.payload as { command: string }).command).toBe('bun test');
      expect(event.scope).toMatchObject({ project_id: PROJECT_ID, session_id: 'sess-1', agent_id: 'claude-code' });

      const diags = diagLines(run.stderr);
      expect(diags.at(-1)).toMatchObject({ outcome: 'delivered', event: 'PostToolUse', stored: 1 });
    } finally {
      project.cleanup();
    }
  });

  test('cwd in the payload resolves the project (discovery walks up from the input cwd)', async () => {
    const project = makeProject();
    requests = [];
    try {
      const sub = join(project.dir, 'packages', 'deep');
      mkdirSync(sub, { recursive: true });
      const run = await runHookProcess(postToolUseBash, { cwd: sub });
      expect(run.exitCode).toBe(0);
      expect(requests.map((request) => request.path)).toEqual([`/v1/projects/${PROJECT_ID}/events`]);
    } finally {
      project.cleanup();
    }
  });

  test('no daemon (dead pid in the lock) → exit 0, a no_daemon stderr note, nothing delivered', async () => {
    const dead = Bun.spawn(['sleep', '0']);
    await dead.exited;
    const project = makeProject(undefined, { daemonPid: dead.pid });
    requests = [];
    try {
      const run = await runHookProcess(postToolUseBash, { cwd: project.dir });
      expect(run.exitCode).toBe(0);
      expect(requests).toHaveLength(0);
      const diags = diagLines(run.stderr);
      expect(diags[0]).toMatchObject({ outcome: 'skipped', reason: 'no_daemon: start one with onemem serve (or set ONEMEMORY_DAEMON_URL)' });
    } finally {
      project.cleanup();
    }
  });

  test('ONEMEMORY_DAEMON_URL override wins over discovery', async () => {
    const project = makeProject(undefined, { daemonUrl: 'http://127.0.0.1:1' });
    requests = [];
    try {
      const run = await runHookProcess(postToolUseBash, {
        cwd: project.dir,
        env: { ONEMEMORY_DAEMON_URL: `http://127.0.0.1:${server.port}` },
      });
      expect(run.exitCode).toBe(0);
      expect(requests).toHaveLength(1);
    } finally {
      project.cleanup();
    }
  });

  test('no project pointer and no env override → exit 0, a no_project note', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'onemem-claude-noproject-'));
    requests = [];
    try {
      const run = await runHookProcess(postToolUseBash, { cwd: dir });
      expect(run.exitCode).toBe(0);
      expect(requests).toHaveLength(0);
      expect(diagLines(run.stderr)[0]).toMatchObject({ outcome: 'skipped', reason: 'no_project: run onemem init (or set ONEMEMORY_PROJECT_ID)' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('an unreachable daemon (delivery timeout) → exit 0, failed diagnostic', async () => {
    const project = makeProject(undefined, { daemonUrl: 'http://127.0.0.1:1' });
    requests = [];
    try {
      const run = await runHookProcess(postToolUseBash, { cwd: project.dir });
      expect(run.exitCode).toBe(0);
      expect(diagLines(run.stderr).at(-1)).toMatchObject({ outcome: 'failed' });
    } finally {
      project.cleanup();
    }
  });
});

describe('hook binary: secrets never leak to stdout or stderr', () => {
  test('a secret-bearing payload is delivered to the daemon but echoed nowhere', async () => {
    const secret = 'sk-live-DO-NOT-LEAK-0123456789abcdef';
    const project = makeProject();
    requests = [];
    try {
      const run = await runHookProcess(
        {
          ...postToolUseBash,
          tool_input: { command: 'deploy --token', run_in_background: false },
          tool_response: { stdout: `deployed with token ${secret}`, stderr: '', interrupted: false },
        },
        { cwd: project.dir },
      );
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).not.toContain(secret);
      // The event DOES carry the output to the daemon — the ingest boundary redacts it there.
      const body = requests[0]!.body as { events: Array<{ payload: { output_digest: string } }> };
      expect(body.events[0]!.payload.output_digest).toContain(secret);
    } finally {
      project.cleanup();
    }
  });

  test('a secret-bearing transcript is never logged either (Stop)', async () => {
    const secret = 'postgres://admin:supersecret@db.internal:5432/prod';
    const project = makeProject(
      [JSON.stringify({ uuid: 'u1', type: 'user', message: { role: 'user', content: `connect with ${secret}` }, timestamp: '2026-10-03T09:00:00.000Z' })].join('\n'),
    );
    requests = [];
    try {
      const run = await runHookProcess(
        { hook_event_name: 'Stop', session_id: 'sess-1', cwd: project.dir, transcript_path: project.transcriptPath, last_assistant_message: 'Done.' },
        { cwd: project.dir },
      );
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe('');
      expect(run.stderr).not.toContain(secret);
      const body = requests[0]!.body as { events: Array<{ payload: { content: string } }> };
      expect(body.events.some((event) => event.payload.content.includes(secret))).toBeTrue();
    } finally {
      project.cleanup();
    }
  });
});

describe('hook binary: SessionStart context injection', () => {
  test('emits exactly the documented additionalContext JSON on stdout and the budget query', async () => {
    const project = makeProject();
    requests = [];
    try {
      const run = await runHookProcess(
        { hook_event_name: 'SessionStart', source: 'startup', session_id: 'sess-2', cwd: project.dir },
        { cwd: project.dir },
      );
      expect(run.exitCode).toBe(0);
      // Exactly one JSON object on stdout — nothing else (payload contents never reach stdout).
      expect(run.stdout.trim()).toBe(
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: CONTEXT_TEXT } }),
      );
      const contextRequest = requests.find((request) => request.path.endsWith('/context'));
      expect(contextRequest).toBeDefined();
      expect(contextRequest!.budget).toBe(750);
      // The session.start event was ALSO delivered.
      const eventsRequest = requests.find((request) => request.path.endsWith('/events'));
      expect(eventsRequest).toBeDefined();
      const body = eventsRequest!.body as { events: Array<{ kind: string }> };
      expect(body.events.map((event) => event.kind)).toEqual(['session.start']);
    } finally {
      project.cleanup();
    }
  });

  test('ONEMEMORY_CONTEXT_BUDGET is honored (default 750, override 900)', async () => {
    const project = makeProject();
    requests = [];
    try {
      await runHookProcess(
        { hook_event_name: 'SessionStart', source: 'startup', session_id: 'sess-3', cwd: project.dir },
        { cwd: project.dir, env: { ONEMEMORY_CONTEXT_BUDGET: '900' } },
      );
      expect(requests.find((request) => request.path.endsWith('/context'))!.budget).toBe(900);
    } finally {
      project.cleanup();
    }
  });

  test('a context failure still delivers the session.start event and prints nothing to stdout', async () => {
    const project = makeProject(undefined, { daemonUrl: 'http://127.0.0.1:1' });
    try {
      const run = await runHookProcess(
        { hook_event_name: 'SessionStart', source: 'startup', session_id: 'sess-4', cwd: project.dir },
        { cwd: project.dir },
      );
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe('');
      const diags = diagLines(run.stderr);
      expect(diags.some((diag) => String(diag.reason).startsWith('context_unavailable'))).toBeTrue();
    } finally {
      project.cleanup();
    }
  });

  test('source compact injects context but mints no session.start event', async () => {
    const project = makeProject();
    requests = [];
    try {
      const run = await runHookProcess(
        { hook_event_name: 'SessionStart', source: 'compact', session_id: 'sess-5', cwd: project.dir },
        { cwd: project.dir },
      );
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toContain('additionalContext');
      const eventsRequest = requests.find((request) => request.path.endsWith('/events'));
      expect(eventsRequest).toBeUndefined();
      // Compaction is not a lifecycle boundary: one counted drop + one no_events note.
      const diags = diagLines(run.stderr);
      expect(diags.map((diag) => diag.reason ?? diag.outcome)).toEqual(['session_start_compact', 'no_events']);
    } finally {
      project.cleanup();
    }
  });
});

describe('hook binary: Stop transcript deltas', () => {
  test('delivers the delta (explicit.remember + conversation.messages) and advances the cursor', async () => {
    const project = makeProject(transcriptLines);
    requests = [];
    try {
      const run = await runHookProcess(
        { hook_event_name: 'Stop', session_id: 'sess-6', cwd: project.dir, transcript_path: project.transcriptPath, last_assistant_message: 'All done.' },
        { cwd: project.dir },
      );
      expect(run.exitCode).toBe(0);
      expect(run.stdout).toBe('');
      const body = requests[0]!.body as { events: Array<{ kind: string; payload: Record<string, unknown>; occurred_at: string }> };
      // 2 user utterances (one remembered explicitly) + 1 assistant + last_assistant_message.
      expect(body.events.map((event) => event.kind)).toEqual([
        'conversation.message',
        'explicit.remember',
        'conversation.message',
        'conversation.message',
      ]);
      expect((body.events[1]!.payload as { content: string }).content).toBe('we use bun test over jest');
      expect(body.events[0]!.occurred_at).toBe('2026-10-03T09:00:00.000Z'); // transcript timestamps, not delivery time

      const state = readHookState(project.configDir);
      expect(state.sessions['sess-6']!.last_transcript_uuid).toBe('u3');
    } finally {
      project.cleanup();
    }
  });

  test('the second Stop delivers only the appended delta', async () => {
    const project = makeProject(transcriptLines);
    requests = [];
    try {
      await runHookProcess(
        { hook_event_name: 'Stop', session_id: 'sess-7', cwd: project.dir, transcript_path: project.transcriptPath, last_assistant_message: 'All done.' },
        { cwd: project.dir },
      );
      const firstCount = (requests.at(-1)!.body as { events: unknown[] }).events.length;

      writeFileSync(
        project.transcriptPath,
        `${transcriptLines}\n${JSON.stringify({ uuid: 'u4', type: 'user', message: { role: 'user', content: 'Also: we prefer tabs.' }, timestamp: '2026-10-03T09:01:00.000Z' })}\n`,
        'utf8',
      );
      requests = [];
      const run = await runHookProcess(
        { hook_event_name: 'Stop', session_id: 'sess-7', cwd: project.dir, transcript_path: project.transcriptPath, last_assistant_message: 'All done, again.' },
        { cwd: project.dir },
      );
      expect(run.exitCode).toBe(0);
      const body = requests[0]!.body as { events: Array<{ kind: string; payload: { content: string } }> };
      // Only the new user utterance + the (changed) final assistant message.
      expect(body.events.map((event) => event.kind)).toEqual(['conversation.message', 'conversation.message']);
      expect(body.events[0]!.payload.content).toBe('Also: we prefer tabs.');
      expect(firstCount).toBe(4);
      expect(body.events[1]!.payload.content).toBe('All done, again.');
    } finally {
      project.cleanup();
    }
  });

  test('a failed delivery does not advance the cursor (the delta retries next Stop)', async () => {
    const project = makeProject(transcriptLines, { daemonUrl: 'http://127.0.0.1:1' });
    try {
      const run = await runHookProcess(
        { hook_event_name: 'Stop', session_id: 'sess-8', cwd: project.dir, transcript_path: project.transcriptPath, last_assistant_message: 'Done.' },
        { cwd: project.dir },
      );
      expect(run.exitCode).toBe(0);
      expect(readHookState(project.configDir).sessions).toEqual({});
    } finally {
      project.cleanup();
    }
  });
});

describe('hook binary: tolerance', () => {
  test('unparseable stdin → exit 0, one skipped diagnostic', async () => {
    const project = makeProject();
    try {
      const run = await runHookProcess('this is not json{{{', { cwd: project.dir });
      expect(run.exitCode).toBe(0);
      expect(diagLines(run.stderr)[0]).toMatchObject({ outcome: 'skipped', reason: 'invalid_input:not_an_object' });
    } finally {
      project.cleanup();
    }
  });

  test('empty stdin → exit 0, no daemon interaction', async () => {
    const project = makeProject();
    requests = [];
    try {
      const run = await runHookProcess('', { cwd: project.dir });
      expect(run.exitCode).toBe(0);
      expect(requests).toHaveLength(0);
    } finally {
      project.cleanup();
    }
  });

  test('an unhandled hook event (PreToolUse) → exit 0, counted drop', async () => {
    const project = makeProject();
    try {
      const run = await runHookProcess({ ...postToolUseBash, hook_event_name: 'PreToolUse' }, { cwd: project.dir });
      expect(run.exitCode).toBe(0);
      expect(diagLines(run.stderr)[0]).toMatchObject({ reason: 'unhandled_hook_event:PreToolUse' });
    } finally {
      project.cleanup();
    }
  });
});

describe('runHook (direct, injected seams)', () => {
  test('the transcript cursor state file lives under .onememory and holds uuids only', async () => {
    const project = makeProject(transcriptLines);
    try {
      const fetched = await runHook(
        { hook_event_name: 'Stop', session_id: 'sess-9', cwd: project.dir, transcript_path: project.transcriptPath, last_assistant_message: '' },
        {
          env: { CLAUDE_PROJECT_DIR: project.dir, ONEMEMORY_DAEMON_URL: `http://127.0.0.1:${server.port}`, ONEMEMORY_PROJECT_ID: PROJECT_ID },
          stdout: { write: () => {} },
          stderr: { write: () => {} },
        },
      );
      expect(fetched.outcome).toBe('delivered');
      const state = readHookState(project.configDir);
      expect(state.sessions['sess-9']!.last_transcript_uuid).toBe('u3');
      const raw = JSON.parse((await Bun.file(join(project.configDir, ADAPTER_STATE_RELPATH)).text()));
      expect(JSON.stringify(raw)).not.toContain('bun test'); // content never persisted — cursors only
    } finally {
      project.cleanup();
    }
  });
});
