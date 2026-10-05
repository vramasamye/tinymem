/**
 * Delivery tests: discovery order (env → config/lock), fail-soft codes, batching, context fetch —
 * all against the loopback fake daemon from `testing.ts` and real `.onememory/` project files.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import {
  deliverEvents,
  discoverCaptureTarget,
  fetchSessionContext,
  isProcessAlive,
  MAX_EVENTS_PER_REQUEST,
  readDaemonLock,
} from './delivery';
import { buildEvent } from './event-builder';
import {
  startFakeDaemon,
  writeOnememoryProject,
  writeProjectWithoutDaemon,
  FIXTURE_PROJECT_ID,
} from './testing';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'onemem-pi-delivery-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('discoverCaptureTarget', () => {
  test('env overrides win (no filesystem reads)', async () => {
    const found = await discoverCaptureTarget({
      cwd: root,
      env: { ONEMEMORY_DAEMON_URL: 'http://127.0.0.1:9999/', ONEMEMORY_PROJECT_ID: 'pid' },
    });
    expect(found.ok).toBeTrue();
    if (!found.ok) return;
    expect(found.target).toMatchObject({
      daemonUrl: 'http://127.0.0.1:9999',
      projectId: 'pid',
      origin: 'env',
    });
  });

  test('config discovery: project.json id + daemon.json lock, liveness-checked', async () => {
    const world = writeOnememoryProject(root, { url: 'http://127.0.0.1:7331', pid: process.pid });
    const found = await discoverCaptureTarget({ cwd: world.root, env: {} });
    expect(found.ok).toBeTrue();
    if (!found.ok) return;
    expect(found.target).toMatchObject({
      daemonUrl: 'http://127.0.0.1:7331',
      projectId: FIXTURE_PROJECT_ID,
      origin: 'lock',
    });
  });

  test('a dead pid in the lock is a stale-lock outcome, not a crash', async () => {
    const world = writeOnememoryProject(root, { url: 'http://127.0.0.1:7331', pid: 2_147_000_000 });
    const found = await discoverCaptureTarget({ cwd: world.root, env: {} });
    expect(found).toMatchObject({ ok: false, code: 'stale-lock' });
    if (found.ok) return;
    expect(found.message).toContain('onemem serve');
  });

  test('no daemon lock → no-daemon with the remediation in the message', async () => {
    const world = writeProjectWithoutDaemon(root);
    const found = await discoverCaptureTarget({ cwd: world.root, env: {} });
    expect(found).toMatchObject({ ok: false, code: 'no-daemon' });
  });

  test('no config at all → no-config (fail-soft, never a throw)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'onemem-pi-empty-'));
    try {
      const found = await discoverCaptureTarget({ cwd: empty, env: {} });
      expect(found).toMatchObject({ ok: false, code: 'no-config' });
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test('readDaemonLock tolerates a malformed lock file (returns null)', () => {
    expect(readDaemonLock('/nonexistent-dir')).toBeNull();
    expect(isProcessAlive(process.pid)).toBeTrue();
  });
});

describe('deliverEvents', () => {
  test('delivers to the fake daemon in one request and reports the stored counts', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const events = [
        buildEvent('session.start', { kind: 'session.start', cwd: '/workspace/demo' }, { projectId: FIXTURE_PROJECT_ID }),
      ];
      const result = await deliverEvents(events, { cwd: root, env: {} });
      expect(result).toMatchObject({ ok: true });
      if (!result.ok) return;
      expect(result.response.stored).toBe(1);
      expect(daemon.receivedEvents).toHaveLength(1);
      expect(daemon.requests[0]).toMatchObject({ method: 'POST', path: `/v1/projects/${FIXTURE_PROJECT_ID}/events` });
    } finally {
      await daemon.close();
    }
  });

  test('re-delivering the same content hash is reported as a duplicate (the daemon decides)', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const events = [
        buildEvent('session.start', { kind: 'session.start', cwd: '/workspace/demo' }, { projectId: FIXTURE_PROJECT_ID }),
      ];
      await deliverEvents(events, { cwd: root, env: {} });
      const again = await deliverEvents(events, { cwd: root, env: {} });
      expect(again).toMatchObject({ ok: true });
      if (!again.ok) return;
      expect(again.response.duplicates).toBe(1);
    } finally {
      await daemon.close();
    }
  });

  test('batches at the server cap (500 per request)', async () => {
    const daemon = await startFakeDaemon();
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const events = Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, (_, index) =>
        buildEvent('conversation.message', { kind: 'conversation.message', role: 'user', content: `m${index}` }, {}),
      );
      const result = await deliverEvents(events, { cwd: root, env: {} });
      expect(result.ok).toBeTrue();
      expect(daemon.requests.filter((request) => request.path.endsWith('/events'))).toHaveLength(2);
    } finally {
      await daemon.close();
    }
  });

  test('an unreachable daemon is {ok:false}, never a throw', async () => {
    writeProjectWithoutDaemon(root);
    const events = [
      buildEvent('session.start', { kind: 'session.start', cwd: '/workspace/demo' }, {}),
    ];
    const result = await deliverEvents(events, { cwd: root, env: {}, timeoutMs: 300 });
    expect(result).toMatchObject({ ok: false });
    if (result.ok) return;
    expect(['no-daemon', 'unreachable', 'timeout']).toContain(result.code);
  });

  test('a 500 from the daemon is http-error with the server message', async () => {
    const daemon = await startFakeDaemon({ failIngest: true });
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const events = [
        buildEvent('session.start', { kind: 'session.start', cwd: '/workspace/demo' }, {}),
      ];
      const result = await deliverEvents(events, { cwd: root, env: {} });
      expect(result).toMatchObject({ ok: false, code: 'http-error' });
    } finally {
      await daemon.close();
    }
  });
});

describe('fetchSessionContext', () => {
  test('fetches the packed context from the daemon', async () => {
    const daemon = await startFakeDaemon({ contextText: '## Decisions\n- PGlite embedded.' });
    try {
      writeOnememoryProject(root, { url: daemon.url, pid: process.pid });
      const result = await fetchSessionContext({ cwd: root, env: {} }, { budget: 500 });
      expect(result.ok).toBeTrue();
      if (!result.ok) return;
      expect(result.context.text).toBe('## Decisions\n- PGlite embedded.');
    } finally {
      await daemon.close();
    }
  });

  test('no daemon → {ok:false} (a missing memory layer must never block the session)', async () => {
    writeProjectWithoutDaemon(root);
    const result = await fetchSessionContext({ cwd: root, env: {} });
    expect(result.ok).toBeFalse();
  });
});
