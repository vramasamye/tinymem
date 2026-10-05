/**
 * The shared daemon lock + probe (moved verbatim from `apps/api/src/runtime/lock.ts` so the
 * standalone stdio bin can share it without importing an app — dependency direction:
 * packages never depend on apps). Behavior is pinned here; `apps/api` keeps a
 * signature-preserving re-export shim, and its own runtime tests run against the shim.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  clearDaemonLock,
  DAEMON_LOCK_FILE_NAME,
  daemonLockCandidateDirs,
  DaemonLockSchema,
  daemonLockPath,
  isLoopbackHost,
  isProcessAlive,
  probeDaemon,
  readDaemonLock,
  writeDaemonLock,
  type DaemonLock,
} from './daemon-lock';

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'onemem-config-lock-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function lock(partial: Partial<DaemonLock> = {}): DaemonLock {
  return DaemonLockSchema.parse({
    pid: process.pid,
    host: '127.0.0.1',
    port: 7331,
    url: 'http://127.0.0.1:7331',
    started_at: '2026-10-05T12:00:00.000Z',
    version_string: '0.1.0-test',
    ...partial,
  });
}

describe('DaemonLockSchema', () => {
  test('parses the full v1 record and defaults the version', () => {
    const parsed = DaemonLockSchema.parse({
      pid: 42,
      host: '127.0.0.1',
      port: 7331,
      url: 'http://127.0.0.1:7331',
      started_at: '2026-10-05T12:00:00.000Z',
      version_string: '0.1.0',
    });
    expect(parsed.version).toBe(1);
    expect(parsed.pid).toBe(42);
  });

  test('is strict: unknown fields and bad values fail loud', () => {
    expect(DaemonLockSchema.safeParse({ ...lock(), extra: true }).success).toBeFalse();
    expect(DaemonLockSchema.safeParse({ ...lock(), pid: 0 }).success).toBeFalse();
    expect(DaemonLockSchema.safeParse({ ...lock(), port: 70_000 }).success).toBeFalse();
    expect(DaemonLockSchema.safeParse({ ...lock(), started_at: 'not-a-date' }).success).toBeFalse();
  });
});

describe('lock file read/write/clear', () => {
  test('daemonLockPath names daemon.json inside the config dir', () => {
    expect(daemonLockPath('/x/.onememory')).toBe(join('/x/.onememory', DAEMON_LOCK_FILE_NAME));
    expect(DAEMON_LOCK_FILE_NAME).toBe('daemon.json');
  });

  test('write → read round-trips; the write creates parents and a trailing newline', () => {
    const dir = join(tempDir(), '.onememory');
    expect(writeDaemonLock(dir, lock())).toBe(daemonLockPath(dir));
    expect(existsSync(daemonLockPath(dir))).toBeTrue();
    expect(readFileSync(daemonLockPath(dir), 'utf8').endsWith('\n')).toBeTrue();
    expect(readDaemonLock(dir)).toEqual(lock());
  });

  test('readDaemonLock returns null for absent, garbage, and mis-shaped locks (never throws)', () => {
    const dir = tempDir();
    expect(readDaemonLock(dir)).toBeNull();
    writeFileSync(daemonLockPath(dir), '{ not json', 'utf8');
    expect(readDaemonLock(dir)).toBeNull();
    writeFileSync(daemonLockPath(dir), '{"pid": "nope"}', 'utf8');
    expect(readDaemonLock(dir)).toBeNull();
  });

  test('clearDaemonLock removes the file and is a no-op when absent', () => {
    const dir = tempDir();
    clearDaemonLock(dir);
    writeDaemonLock(dir, lock());
    clearDaemonLock(dir);
    expect(existsSync(daemonLockPath(dir))).toBeFalse();
  });
});

describe('isProcessAlive', () => {
  test('the current process is alive; an impossible pid is not', () => {
    expect(isProcessAlive(process.pid)).toBeTrue();
    expect(isProcessAlive(999_999_999)).toBeFalse();
  });
});

describe('probeDaemon', () => {
  test('no lock file → null (the caller may own embedded storage)', async () => {
    expect(await probeDaemon(tempDir())).toBeNull();
  });

  test('a stale lock (dead pid) is removed and the probe returns null', async () => {
    const dir = tempDir();
    writeDaemonLock(dir, lock({ pid: 999_999_999 }));
    expect(await probeDaemon(dir)).toBeNull();
    expect(existsSync(daemonLockPath(dir))).toBeFalse();
  });

  test('live pid + healthy probe → the probe with health set and no problem', async () => {
    const dir = tempDir();
    writeDaemonLock(dir, lock());
    const calls: string[] = [];
    const fetchImpl = (async (input: Parameters<typeof fetch>[0]) => {
      calls.push(String(input));
      return new Response(JSON.stringify({ status: 'ok', pid: process.pid }), { status: 200 });
    }) as unknown as typeof fetch;

    const probe = await probeDaemon(dir, { fetch: fetchImpl });
    expect(probe).not.toBeNull();
    expect(calls).toEqual(['http://127.0.0.1:7331/v1/health']);
    expect(probe!.pid_alive).toBeTrue();
    expect(probe!.health).not.toBeNull();
    expect((probe!.health as { status?: string }).status).toBe('ok');
    expect(probe!.problem).toBeUndefined();
  });

  test('live pid + health endpoint erroring → health null, problem names the failure', async () => {
    const dir = tempDir();
    writeDaemonLock(dir, lock());
    const fetchImpl = (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const probe = await probeDaemon(dir, { fetch: fetchImpl });
    expect(probe).not.toBeNull();
    expect(probe!.health).toBeNull();
    expect(probe!.pid_alive).toBeTrue();
    expect(probe!.problem).toContain('did not answer');
    expect(probe!.problem).toContain('health returned 500');
  });

  test('live pid + unreachable endpoint → health null, problem set (never ignored)', async () => {
    const dir = tempDir();
    writeDaemonLock(dir, lock());
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const probe = await probeDaemon(dir, { fetch: fetchImpl });
    expect(probe!.health).toBeNull();
    expect(probe!.problem).toContain(String(process.pid));
    expect(probe!.problem).toContain('ECONNREFUSED');
  });
});

describe('isLoopbackHost', () => {
  test('accepts 127.x, localhost and ::1 (bracketed too); rejects everything else', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) {
      expect(isLoopbackHost(host)).toBeTrue();
    }
    for (const host of ['0.0.0.0', '::', '10.0.0.1', '192.168.1.5', 'example.com', '']) {
      expect(isLoopbackHost(host)).toBeFalse();
    }
  });
});

describe('daemonLockCandidateDirs', () => {
  test('the data dir itself and its parent — both real daemon layouts', () => {
    // The standalone stdio bin's default: the data dir IS the .onememory config dir.
    expect(daemonLockCandidateDirs('/p/.onememory')).toEqual(['/p/.onememory', '/p']);
    // The daemon's default data_dir: a `data` child of the .onememory config dir.
    expect(daemonLockCandidateDirs('/p/.onememory/data')).toEqual(['/p/.onememory/data', '/p/.onememory']);
  });

  test('degrades to a single candidate at the filesystem root', () => {
    expect(daemonLockCandidateDirs('/')).toEqual(['/']);
  });
});
