import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { translateCodexHook } from './translate-hooks';
import {
  deliverEvents,
  discoverCaptureTarget,
  fetchSessionContext,
  MAX_EVENTS_PER_REQUEST,
  readDaemonLock,
} from './delivery';
import {
  FIXTURE_PROJECT_ID,
  postToolUseHookInput,
  sessionStartHookInput,
  startFakeDaemon,
  writeOnememoryProject,
  writeProjectWithoutDaemon,
  writeConfigWithoutProject,
  bashToolResponse,
} from './testing';

const CONTEXT = { projectId: FIXTURE_PROJECT_ID, now: new Date('2026-10-03T10:00:00.000Z') };
const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-codex-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('discoverCaptureTarget', () => {
  test('env overrides win without touching the filesystem', async () => {
    const discovered = await discoverCaptureTarget({
      env: { ONEMEMORY_DAEMON_URL: 'http://127.0.0.1:4771/', ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      cwd: '/definitely/not/a/project',
    });
    expect(discovered.ok).toBe(true);
    if (discovered.ok) {
      expect(discovered.target.origin).toBe('env');
      expect(discovered.target.daemonUrl).toBe('http://127.0.0.1:4771');
      expect(discovered.target.projectId).toBe(FIXTURE_PROJECT_ID);
    }
  });

  test('discovers the project and daemon lock from the nearest .onememory', async () => {
    const root = tempDir();
    const daemon = await startFakeDaemon();
    try {
      const written = writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const discovered = await discoverCaptureTarget({ cwd: join(root, 'packages', 'deep', 'sub') });
      expect(discovered.ok).toBe(true);
      if (discovered.ok) {
        expect(discovered.target.origin).toBe('lock');
        expect(discovered.target.projectId).toBe(FIXTURE_PROJECT_ID);
        expect(discovered.target.daemonUrl).toBe(daemon.url);
        expect(discovered.target.configDir).toBe(written.configDir);
      }
    } finally {
      await daemon.close();
    }
  });

  test('no onememory config → no-config (fail-soft, with remediation)', async () => {
    const discovered = await discoverCaptureTarget({ cwd: tempDir(), env: {} });
    expect(discovered.ok).toBe(false);
    if (!discovered.ok) {
      expect(discovered.code).toBe('no-config');
      expect(discovered.message).toContain('onemem init');
    }
  });

  test('config without a registered project → no-project', async () => {
    const root = tempDir();
    writeConfigWithoutProject(root);
    const discovered = await discoverCaptureTarget({ cwd: root, env: {} });
    expect(discovered.ok).toBe(false);
    if (!discovered.ok) {
      expect(discovered.code).toBe('no-project');
      expect(discovered.message).toContain('onemem init');
    }
  });

  test('project with no daemon lock → no-daemon', async () => {
    const root = tempDir();
    writeProjectWithoutDaemon(root);
    const discovered = await discoverCaptureTarget({ cwd: join(root, 'packages', 'sub'), env: {} });
    expect(discovered.ok).toBe(false);
    if (!discovered.ok) {
      expect(discovered.code).toBe('no-daemon');
      expect(discovered.message).toContain('onemem serve');
    }
  });

  test('a lock whose pid is dead → stale-lock, and no request is attempted', async () => {
    const daemon = await startFakeDaemon();
    try {
      const root = tempDir();
      writeOnememoryProject(root, { url: daemon.url, pid: 0x7ffffff0 });
      const discovered = await discoverCaptureTarget({ cwd: root, env: {} });
      expect(discovered.ok).toBe(false);
      if (!discovered.ok) {
        expect(discovered.code).toBe('stale-lock');
      }
      expect(daemon.requests).toHaveLength(0);
    } finally {
      await daemon.close();
    }
  });

  test('readDaemonLock tolerates garbage', () => {
    const root = tempDir();
    mkdirSync(join(root, '.onememory'), { recursive: true });
    writeFileSync(join(root, '.onememory', 'daemon.json'), '{broken');
    expect(readDaemonLock(join(root, '.onememory'))).toBeNull();
  });
});

describe('deliverEvents — against a real loopback HTTP daemon', () => {
  test('delivers translated events and reports the ingest outcome', async () => {
    const daemon = await startFakeDaemon();
    try {
      const events = translateCodexHook(
        postToolUseHookInput({ name: 'Bash', input: { command: 'bun test' }, response: bashToolResponse('ok', 0) }),
        CONTEXT,
      ).events;
      const result = await deliverEvents(events, {
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.response.stored).toBe(events.length);
        expect(result.response.normalize_job_id).toBeNull();
      }
      expect(daemon.requests).toHaveLength(1);
      expect(daemon.requests[0]!.path).toBe(`/v1/projects/${FIXTURE_PROJECT_ID}/events`);
      expect((daemon.requests[0]!.body as { events: unknown[] }).events).toHaveLength(events.length);
    } finally {
      await daemon.close();
    }
  });

  test('batches at the server cap of 500 events per request', async () => {
    const daemon = await startFakeDaemon();
    try {
      const one = translateCodexHook(sessionStartHookInput(), CONTEXT).events;
      const many = Array.from({ length: MAX_EVENTS_PER_REQUEST + 7 }, () => ({
        ...one[0]!,
        id: `00000000-0000-7000-8000-${String(Math.floor(Math.random() * 1e12)).padStart(12, '0')}`,
      }));
      const result = await deliverEvents(many, {
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      expect(result.ok).toBe(true);
      const ingests = daemon.requests.filter((request) => request.path.endsWith('/events'));
      expect(ingests).toHaveLength(2);
      expect((ingests[0]!.body as { events: unknown[] }).events).toHaveLength(MAX_EVENTS_PER_REQUEST);
      expect((ingests[1]!.body as { events: unknown[] }).events).toHaveLength(7);
    } finally {
      await daemon.close();
    }
  });

  test('a timeout is a fail-soft outcome, never a throw', async () => {
    const daemon = await startFakeDaemon({ delayMs: 400 });
    try {
      const result = await deliverEvents(translateCodexHook(sessionStartHookInput(), CONTEXT).events, {
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
        timeoutMs: 100,
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(['timeout', 'unreachable']).toContain(result.code);
      }
    } finally {
      await daemon.close();
    }
  });

  test('an HTTP 500 from the daemon is a fail-soft http-error with the daemon message', async () => {
    const daemon = await startFakeDaemon({ failIngest: true });
    try {
      const result = await deliverEvents(translateCodexHook(sessionStartHookInput(), CONTEXT).events, {
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.code).toBe('http-error');
        expect(result.message).toContain('500');
        expect(result.message).toContain('boom');
      }
    } finally {
      await daemon.close();
    }
  });

  test('an unparseable success body is a fail-soft bad-response', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('not json');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      const result = await deliverEvents(translateCodexHook(sessionStartHookInput(), CONTEXT).events, {
        env: { ONEMEMORY_DAEMON_URL: `http://127.0.0.1:${address.port}`, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('bad-response');
    } finally {
      server.close();
    }
  });

  test('a schema-violating success body is a fail-soft bad-response', async () => {
    const { createServer } = await import('node:http');
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ nonsense: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address() as { port: number };
    try {
      const result = await deliverEvents(translateCodexHook(sessionStartHookInput(), CONTEXT).events, {
        env: { ONEMEMORY_DAEMON_URL: `http://127.0.0.1:${address.port}`, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('bad-response');
    } finally {
      server.close();
    }
  });

  test('no events is an immediate ok (nothing to send, nothing to say)', async () => {
    const result = await deliverEvents([], { env: {} });
    expect(result.ok).toBe(true);
  });
});

describe('fetchSessionContext', () => {
  test('fetches the packed context (GET /v1/projects/:id/context)', async () => {
    const daemon = await startFakeDaemon({ contextText: '## Decisions\n- Use PGlite for the embedded profile.' });
    try {
      const result = await fetchSessionContext({
        env: { ONEMEMORY_DAEMON_URL: daemon.url, ONEMEMORY_PROJECT_ID: FIXTURE_PROJECT_ID },
      });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.context.text).toContain('PGlite');
      }
      expect(daemon.requests[0]!.path).toBe(`/v1/projects/${FIXTURE_PROJECT_ID}/context`);
      expect(daemon.requests[0]!.method).toBe('GET');
    } finally {
      await daemon.close();
    }
  });

  test('a missing daemon is fail-soft', async () => {
    const result = await fetchSessionContext({ cwd: tempDir(), env: {}, timeoutMs: 100 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('no-config');
  });
});
