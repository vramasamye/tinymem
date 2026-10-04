/**
 * Runtime integration tests against real embedded storage (PGlite in a temp dir).
 *
 * This is the Phase-1 "done" round trip: config → storage → redaction → durable write → search →
 * soft forget/restore → stats/doctor, plus the daemon lifecycle (lock, loopback bind, single-owner
 * refusal, graceful stop) through a real `Bun.serve` socket.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { eventContentHash } from '@onememory/core';
import { renderDefaultConfigYaml, saveProjectState, ProjectStateSchema } from '@onememory/config';

import {
  BackendError,
  createHttpBackend,
  createLocalBackend,
  openRuntime,
  probeDaemon,
  startDaemon,
  writeDaemonLock,
  daemonLockPath,
  isLoopbackHost,
  type OnememoryRuntime,
} from './index';

/**
 * The pre-guard fetch. In production the daemon and the client are separate processes: the client
 * probes the lock BEFORE any runtime (and thus any guard) exists in its process, so the guard never
 * sees its own daemon. This test file opens several runtimes in one process, so the raw fetch is
 * captured at import time — before the first guard installs — and used for daemon round trips.
 * (The guard has no loopback allowance today; recorded as an M13 follow-up.)
 */
const rawFetch = globalThis.fetch.bind(globalThis);

function projectRoot(name: string): string {
  const root = join(process.env.TMPDIR ?? '/tmp', `onemem-runtime-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(join(root, '.onememory'), { recursive: true });
  return root;
}

let runtime: OnememoryRuntime;
let projectId: string;
let root: string;

beforeAll(async () => {
  root = projectRoot('main');
  const { writeFileSync } = await import('node:fs');
  writeFileSync(join(root, '.onememory', 'onememory.yaml'), renderDefaultConfigYaml(), 'utf8');

  runtime = await openRuntime({ cwd: root, env: {}, startWorker: false });
  const project = await runtime.storage.store.createProject({ name: 'runtime-test', root_path: root });
  projectId = project.id;
  const state = ProjectStateSchema.parse({
    project_id: project.id,
    name: project.name,
    root_path: root,
    created_at: new Date().toISOString(),
  });
  saveProjectState(join(root, '.onememory'), state);
});

afterAll(async () => {
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
});

describe('the durable write path (real storage)', () => {
  const secret = 'sk-ant-api03-' + 'A'.repeat(40);

  test('remember redacts before persisting and records provenance + audit', async () => {
    const backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    const outcome = await backend.remember({
      project_id: projectId,
      content: `Use PGlite for embedded mode. Key was ${secret}.`,
      type: 'decision',
    });
    expect(outcome.outcome).toBe('inserted');
    expect(outcome.redactions.length).toBeGreaterThan(0);
    expect(JSON.stringify(outcome)).not.toContain(secret);

    const inspected = await backend.inspect(projectId, outcome.memory_id);
    expect(inspected.memory.status).toBe('active');
    expect(inspected.memory.content).toContain('[REDACTED');
    expect(inspected.memory.content).not.toContain(secret);
    expect(inspected.memory.provenance.source.kind).toBe('explicit');
    expect(inspected.audit.some((event) => event.action === 'created')).toBeTrue();
  });

  test('an exact duplicate write reports the existing memory instead of storing twice', async () => {
    const backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    const first = await backend.remember({ project_id: projectId, content: 'Duplicate probe: same words every time.' });
    const second = await backend.remember({ project_id: projectId, content: 'Duplicate probe: same words every time.' });
    expect(second.outcome).toBe('duplicate');
    expect(second.duplicate_of).toBe(first.memory_id);
  });

  test('search finds the stored memory and stays inside the token budget', async () => {
    const backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    const response = await backend.search({ query: 'PGlite embedded mode', project_id: projectId, explain: true });
    expect(response.memories.length).toBeGreaterThan(0);
    expect(response.tokens.used).toBeLessThanOrEqual(response.tokens.budget);
    expect(response.warnings.some((warning) => warning.includes('no embedding provider'))).toBeTrue();
  });

  test('ingest stores events, excludes .env paths, and queues exactly one normalize job', async () => {
    const backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    // A complete envelope, exactly as an adapter mints one: ids, timestamps, content hash, and an
    // (empty) redactions list are the adapter's job — ingest validates, excludes, then persists.
    const message = (n: number) => ({
      id: `0192f3c0-0000-7000-8000-${String(n).padStart(12, '0')}`,
      kind: 'conversation.message',
      occurred_at: '2026-10-01T12:00:00.000Z',
      ingested_at: '2026-10-01T12:00:01.000Z',
      source: { runtime: 'cli' as const, adapter_version: '0.1.0' },
      scope: { project_id: projectId },
      payload: { kind: 'conversation.message' as const, role: 'user' as const, content: 'we chose pgvector over float8' },
      content_hash: '',
      redactions: [],
    });
    const conversation = message(1);
    conversation.content_hash = eventContentHash(conversation.payload);
    const conversation2 = message(2);
    conversation2.content_hash = eventContentHash(conversation2.payload);

    const document = {
      ...message(3),
      kind: 'document.added',
      payload: {
        kind: 'document.added' as const,
        path: 'config/.env',
        mime: 'text/plain',
        content_digest: 'DB_PASSWORD=x',
      },
    };
    document.content_hash = eventContentHash(document.payload);

    const result = await backend.ingestEvents(projectId, [conversation, document, conversation2]);
    expect(result.stored).toBe(1);
    expect(result.excluded).toBe(1);
    expect(result.duplicates).toBe(1);
    expect(result.dead_lettered).toBe(0);
    expect(result.normalize_job_id).not.toBeNull();
  });

  test('ingest completes draft envelopes (the published REST contract)', async () => {
    const backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    const draft = {
      kind: 'conversation.message',
      occurred_at: '2026-10-01T12:00:00.000Z',
      payload: {
        kind: 'conversation.message',
        role: 'user',
        content: 'A draft without the canonical fields.',
      },
      source: { runtime: 'claude-code', adapter_version: '0.0.0' },
      scope: { project_id: projectId },
    };
    const stored = await backend.ingestEvents(projectId, [draft]);
    expect(stored.stored).toBe(1);
    expect(stored.dead_lettered).toBe(0);
    expect(stored.outcomes[0]?.event_id).toBeDefined();

    // The same draft again → duplicate by the completed content_hash (idempotent ingest).
    const again = await backend.ingestEvents(projectId, [draft]);
    expect(again.stored).toBe(0);
    expect(again.duplicates).toBe(1);

    // A draft without a payload is dead-lettered with the real reason, not a fake hash.
    const gutless = await backend.ingestEvents(projectId, [
      {
        kind: 'conversation.message',
        occurred_at: '2026-10-01T12:00:00.000Z',
        source: { runtime: 'claude-code', adapter_version: '0.0.0' },
        scope: { project_id: projectId },
      },
    ]);
    expect(gutless.dead_lettered).toBe(1);
    expect(gutless.outcomes[0]?.reason).toContain('payload');
  });

  test('forget is an audited status change, restore undoes it, and nothing is deleted', async () => {
    const backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    const created = await backend.remember({ project_id: projectId, content: 'Forgettable statement for the audit trail.' });
    const forgotten = await backend.forget({ project_id: projectId, memory_id: created.memory_id, reason: 'test' });
    expect(forgotten.to_status).toBe('archived');
    expect(forgotten.restore_hint).toContain('restore');

    const after = await backend.inspect(projectId, created.memory_id);
    expect(after.memory.status).toBe('archived');
    expect(after.audit.some((event) => event.to_status === 'archived')).toBeTrue();

    const restored = await backend.restore({ project_id: projectId, memory_id: created.memory_id });
    expect(restored.to_status).toBe('active');
    expect((await backend.inspect(projectId, created.memory_id)).memory.status).toBe('active');
  });

  test('purge is the destructive path: row gone, one purged audit row survives, revision gates it', async () => {
    const backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    const created = await backend.remember({
      project_id: projectId,
      content: 'Purgeable statement with a revision token.',
    });

    // A stale revision never purges (a purge can never be accidental).
    const stale = (await backend
      .purge({ project_id: projectId, memory_id: created.memory_id, expected_revision: '1999-01-01T00:00:00.000Z' })
      .catch((error: unknown) => error)) as BackendError;
    expect(stale).toBeInstanceOf(BackendError);
    expect(stale.code).toBe('conflict');

    // The current revision purges for real.
    const current = await backend.inspect(projectId, created.memory_id);
    const purged = await backend.purge({
      project_id: projectId,
      memory_id: created.memory_id,
      expected_revision: current.memory.updated_at,
      reason: 'right to be forgotten',
    });
    expect(purged.purged).toBe(true);
    expect(purged.from_status).toBe('active');

    // The row is GONE (this is the destructive path) — the audit trail is all that remains.
    const missing = (await backend
      .inspect(projectId, created.memory_id)
      .catch((error: unknown) => error)) as BackendError;
    expect(missing).toBeInstanceOf(BackendError);
    expect(missing.code).toBe('not_found');

    const events = await runtime.storage.store.listMemoryEvents(created.memory_id);
    expect(events.some((event) => event.action === 'purged')).toBeTrue();

    // …and the soft path still advertises the real destructive command.
    const forgotten = await backend.remember({ project_id: projectId, content: 'Soft path still works after a purge.' });
    const soft = await backend.forget({ project_id: projectId, memory_id: forgotten.memory_id });
    expect(soft.purge_hint).toContain('--purge');
  });

  test('stats and doctor describe the real state (degraded, honestly)', async () => {
    const backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    const stats = await backend.stats(projectId);
    expect(stats.project_id).toBe(projectId);
    expect(stats.memories.total).toBeGreaterThan(0);
    expect(stats.jobs).toBeNull(); // known storage gap, reported not hidden
    expect(stats.llm.profile).toBe('local');

    const report = await backend.doctor({ probeEmbedder: false });
    expect(report.exit_code).toBe(0);
    expect(report.status).toBe('degraded');
    expect(report.checks.some((check) => check.id === 'embedder' && check.status === 'warn')).toBeTrue();
    // No runtime was wired in this project: both are informational, never warnings.
    expect(report.runtimes.map((check) => [check.id, check.status])).toEqual([
      ['runtime-claude-code', 'info'],
      ['runtime-codex', 'info'],
    ]);
    expect(report.summary.info).toBe(2);
  });

  test('the HTTP backend over the real REST app returns the same answers', async () => {
    const { createApiApp } = await import('../server/app');
    const local = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    const app = createApiApp({ backend: local, version: 'test' });
    const http = createHttpBackend({
      baseUrl: 'http://onememory.test',
      fetch: ((input: string | URL | Request, init?: RequestInit) =>
        app.request(String(input), init)) as unknown as typeof fetch,
    });

    const overHttp = await http.search({ query: 'PGlite embedded mode', project_id: projectId });
    const inProcess = await local.search({ query: 'PGlite embedded mode', project_id: projectId });
    expect(overHttp.memories.map((memory) => memory.id)).toEqual(inProcess.memories.map((memory) => memory.id));

    const stats = await http.stats(projectId);
    expect(stats.project_id).toBe(projectId);
    await expect(http.getProject('0195a7f0-9f5e-7a1d-bc2d-000000000009')).rejects.toBeInstanceOf(BackendError);
  });
});

describe('the daemon lock', () => {
  test('loopback detection accepts 127.x and localhost only', () => {
    expect(isLoopbackHost('127.0.0.1')).toBeTrue();
    expect(isLoopbackHost('localhost')).toBeTrue();
    expect(isLoopbackHost('::1')).toBeTrue();
    expect(isLoopbackHost('0.0.0.0')).toBeFalse();
    expect(isLoopbackHost('192.168.1.5')).toBeFalse();
  });

  test('a stale lock (dead pid) is removed by the probe', () => {
    const dir = projectRoot('stale');
    try {
      writeDaemonLock(dir, {
        version: 1,
        pid: 999999999,
        host: '127.0.0.1',
        port: 7331,
        url: 'http://127.0.0.1:7331',
        started_at: new Date().toISOString(),
        version_string: 'test',
      });
      expect(probeDaemon(dir)).resolves.toBeNull();
      expect(existsSync(daemonLockPath(dir))).toBeFalse();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the default local profile stays offline', () => {
  test('remember and search run under the enforced network guard with zero outbound calls', async () => {
    const guard = runtime.networkGuard;
    expect(guard).not.toBeNull();
    if (guard === null) throw new Error('default local profile did not install the network guard');

    const backend = createLocalBackend(runtime, { adapter: 'test', closeRuntime: false });
    const stored = await backend.remember({
      project_id: projectId,
      content: 'The default profile keeps memory operations on this machine.',
      type: 'decision',
    });
    const result = await backend.search({
      query: 'default profile local machine',
      project_id: projectId,
      explain: true,
      max_tokens: 120,
    });

    expect(stored.outcome).toBe('inserted');
    expect(result.memories.some((memory) => memory.id === stored.memory_id)).toBe(true);
    expect(result.tokens.used).toBeLessThanOrEqual(result.tokens.budget);
    guard.assertZeroCalls();
    expect(guard.count).toBe(0);
  });
});

describe('the daemon', () => {
  test('serves on loopback, refuses a second owner, and stops cleanly', async () => {
    const handle = await startDaemon({
      cwd: root,
      env: {},
      port: 0,
      installSignalHandlers: false,
    });
    try {
      expect(isLoopbackHost(handle.info.host)).toBeTrue();
      expect(handle.info.registered_handlers).toContain('normalize');
      expect(handle.runtime.worker_running).toBeTrue();

      const health = (await (await rawFetch(`${handle.info.url}/v1/health`)).json()) as {
        status: string;
      };
      expect(health.status).toBe('degraded');

      // The daemon probe finds it (this is exactly what the CLI relies on).
      const probe = await probeDaemon(join(root, '.onememory'), { timeoutMs: 5000, fetch: rawFetch });
      expect(probe?.health?.pid).toBe(process.pid);

      // A second owner must be refused (ADR-0002 single-owner rule). The raw fetch is passed
      // because the probe must see the first daemon through the guard this process installed.
      await expect(
        startDaemon({ cwd: root, env: {}, port: 0, installSignalHandlers: false, fetch: rawFetch }),
      ).rejects.toThrow(/already serving this project/);

      // Refusing to bind a non-loopback host without the explicit flag.
      await expect(
        startDaemon({ cwd: root, env: {}, host: '0.0.0.0', port: 0, installSignalHandlers: false, fetch: rawFetch }),
      ).rejects.toThrow(/local-only/);
    } finally {
      await handle.stop();
    }

    // Graceful stop removed the lock and closed storage.
    expect(probeDaemon(join(root, '.onememory'))).resolves.toBeNull();
    await expect(handle.runtime.storage.store.listPendingEvents(1)).rejects.toBeDefined();
  }, 60_000);
});
