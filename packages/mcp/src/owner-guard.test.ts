/**
 * The stdio bin's embedded-owner guard (ADR-0002 single-owner rule; ADR-0010 amendment
 * 2026-10-04 backlog cross-follow-up #5): `onemem-mcp` must refuse to open embedded storage while
 * a daemon owns the same data dir — a second PGlite owner is exactly what ADR-0002 forbids.
 *
 * All three probe outcomes are covered with fake locks + injectable fetch; the bin-level test
 * runs the real `main()` against a real loopback HTTP fake so the refusal happens exactly where
 * users hit it: before any storage is opened, loud, pointing at the daemon's MCP endpoint.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { daemonLockPath, writeDaemonLock } from '@onememory-ai/config';

import { main } from './bin';
import { assertNoEmbeddedOwner, EmbeddedStorageOwnerError } from './owner-guard';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-mcp-owner-guard-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A fake fetch answering /v1/health like a healthy daemon (or failing, on demand). */
function healthyFetch(): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ status: 'ok', pid: process.pid, version: 'test' }), {
      status: 200,
    })) as unknown as typeof fetch;
}

function failingFetch(message = 'ECONNREFUSED'): typeof fetch {
  return (async () => {
    throw new Error(message);
  }) as unknown as typeof fetch;
}

describe('assertNoEmbeddedOwner', () => {
  test('no lock at all → resolves (the bin may own the data dir)', async () => {
    const dir = tempDir();
    await expect(assertNoEmbeddedOwner(join(dir, '.onememory'))).resolves.toBeUndefined();
  });

  test('a stale lock (dead pid) is cleaned up and the guard proceeds', async () => {
    const dir = tempDir();
    writeDaemonLock(dir, {
      version: 1,
      pid: 999_999_999,
      host: '127.0.0.1',
      port: 7331,
      url: 'http://127.0.0.1:7331',
      started_at: new Date().toISOString(),
      version_string: 'test',
    });
    await expect(assertNoEmbeddedOwner(dir, { fetch: healthyFetch() })).resolves.toBeUndefined();
    expect(existsSync(daemonLockPath(dir))).toBeFalse();
  });

  test('live pid + healthy daemon → refuses with the daemon MCP endpoint', async () => {
    const dir = tempDir();
    writeDaemonLock(dir, {
      version: 1,
      pid: process.pid,
      host: '127.0.0.1',
      port: 7331,
      url: 'http://127.0.0.1:7331',
      started_at: new Date().toISOString(),
      version_string: 'test',
    });

    const refusal = assertNoEmbeddedOwner(dir, { fetch: healthyFetch() });
    await expect(refusal).rejects.toBeInstanceOf(EmbeddedStorageOwnerError);
    try {
      await assertNoEmbeddedOwner(dir, { fetch: healthyFetch() });
      throw new Error('expected the guard to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddedStorageOwnerError);
      const owner = error as EmbeddedStorageOwnerError;
      expect(owner.refusal.daemonMcpUrl).toBe('http://127.0.0.1:7331/mcp');
      expect(owner.refusal.daemonPid).toBe(process.pid);
      expect(owner.refusal.dataDir).toBe(dir);
      expect(owner.refusal.lockPath).toBe(daemonLockPath(dir));
      expect(owner.refusal.wedged).toBeFalse();
      expect(owner.message).toContain('http://127.0.0.1:7331/mcp');
      expect(owner.message).toContain('owns this data directory');
    }
  });

  test('live pid + failing health probe → still refuses (a wedged daemon still owns the data dir)', async () => {
    const dir = tempDir();
    writeDaemonLock(dir, {
      version: 1,
      pid: process.pid,
      host: '127.0.0.1',
      port: 7332,
      url: 'http://127.0.0.1:7332',
      started_at: new Date().toISOString(),
      version_string: 'test',
    });

    try {
      await assertNoEmbeddedOwner(dir, { fetch: failingFetch('ECONNREFUSED') });
      throw new Error('expected the guard to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddedStorageOwnerError);
      const owner = error as EmbeddedStorageOwnerError;
      expect(owner.refusal.wedged).toBeTrue();
      expect(owner.refusal.problem).toContain('ECONNREFUSED');
      expect(owner.message).toContain('still owns this data directory');
      expect(owner.message).toContain('http://127.0.0.1:7332/mcp');
    }
  });

  test('the daemon-default layout is covered: the lock sits in the data dir’s parent', async () => {
    const root = tempDir();
    const configDir = join(root, '.onememory');
    writeDaemonLock(configDir, {
      version: 1,
      pid: process.pid,
      host: '127.0.0.1',
      port: 7333,
      url: 'http://127.0.0.1:7333',
      started_at: new Date().toISOString(),
      version_string: 'test',
    });

    // The daemon's default storage.data_dir is `<config dir>/data` — the lock lives one level up.
    try {
      await assertNoEmbeddedOwner(join(configDir, 'data'), { fetch: healthyFetch() });
      throw new Error('expected the guard to refuse');
    } catch (error) {
      expect(error).toBeInstanceOf(EmbeddedStorageOwnerError);
      expect((error as EmbeddedStorageOwnerError).refusal.lockPath).toBe(daemonLockPath(configDir));
    }
  });

  test('a relative data dir resolves against the injected cwd', async () => {
    const root = tempDir();
    const configDir = join(root, '.onememory');
    writeDaemonLock(configDir, {
      version: 1,
      pid: process.pid,
      host: '127.0.0.1',
      port: 7334,
      url: 'http://127.0.0.1:7334',
      started_at: new Date().toISOString(),
      version_string: 'test',
    });
    try {
      await assertNoEmbeddedOwner('.onememory', { cwd: root, fetch: healthyFetch() });
      throw new Error('expected the guard to refuse');
    } catch (error) {
      expect((error as EmbeddedStorageOwnerError).refusal.dataDir).toBe(configDir);
    }
  });
});

describe('the stdio bin refuses before opening storage', () => {
  test('main() rejects with the daemon MCP endpoint and never opens PGlite', async () => {
    const root = tempDir();
    const dataDir = join(root, '.onememory');
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch: () => new Response(JSON.stringify({ status: 'ok', pid: process.pid }), { status: 200 }),
    });
    try {
      writeDaemonLock(dataDir, {
        version: 1,
        pid: process.pid,
        host: '127.0.0.1',
        port: server.port!,
        url: `http://127.0.0.1:${server.port}`,
        started_at: new Date().toISOString(),
        version_string: 'test',
      });

      await expect(
        main({
          ONEMEMORY_DATA_DIR: dataDir,
          ONEMEMORY_MCP_PROFILE: 'default8',
        }),
      ).rejects.toThrow(EmbeddedStorageOwnerError);

      // The refusal happened BEFORE storage opened: the data dir still holds only the lock.
      expect(readdirSync(dataDir)).toEqual(['daemon.json']);
    } finally {
      server.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);
});
