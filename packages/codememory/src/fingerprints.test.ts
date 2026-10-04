import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rename, rm, stat, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { installNetworkGuard } from '@onememory/security';

import { captureSnapshot, compareSnapshots, detectChanges } from './index';
import type { RepositorySnapshot } from './index';

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(git = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'onemem code memory '));
  roots.push(root);
  if (git) await command(root, 'init', '-q');
  return root;
}

async function command(root: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000 });
  return result.stdout.trim();
}

async function commit(root: string): Promise<void> {
  await command(root, 'add', '--all');
  await command(root, 'commit', '-qm', 'test: record fingerprint fixture');
}

function paths(snapshot: RepositorySnapshot, tier: 'committed' | 'worktree'): string[] {
  return snapshot.files.filter((file) => file.tier === tier).map((file) => file.path);
}

describe('local fingerprint capture', () => {
  test('unchanged Git files match across tiers; dirty and staged changes remain separate', async () => {
    const root = await fixture();
    await writeFile(join(root, 'space name.ts'), 'export const version = 1;\n');
    await writeFile(join(root, 'odd\tname\n.ts'), 'export const odd = true;\n');
    await commit(root);
    const guard = installNetworkGuard();
    try {
      const first = await captureSnapshot(root);
      expect(first.mode).toBe('git');
      expect(first.head_commit).not.toBeNull();
      expect(paths(first, 'committed')).toEqual(['odd\tname\n.ts', 'space name.ts']);
      for (const file of first.files.filter((entry) => entry.tier === 'committed')) {
        expect(first.files.find((entry) => entry.tier === 'worktree' && entry.path === file.path)?.blob_sha).toBe(file.blob_sha);
      }
      expect((await detectChanges(first)).changes).toEqual([]);

      await writeFile(join(root, 'space name.ts'), 'export const version = 2;\n');
      const dirty = await detectChanges(first);
      expect(dirty.changes.map((change) => [change.tier, change.kind, change.path])).toEqual([
        ['worktree', 'modified', 'space name.ts'],
      ]);
      await command(root, 'add', '--', 'space name.ts');
      const staged = await detectChanges(first);
      expect(staged.changes.map((change) => change.tier)).toEqual(['committed', 'worktree']);
      expect(staged.snapshot.head_commit).toBe(first.head_commit);
      guard.assertZeroCalls();
    } finally {
      guard.restore();
    }
  });

  test('rename evidence preserves modified renames and exact worktree moves', async () => {
    const root = await fixture();
    await writeFile(join(root, 'original.ts'), Array.from({ length: 40 }, (_, n) => `export const value${n} = ${n};`).join('\n'));
    await commit(root);
    const before = await captureSnapshot(root);
    await rename(join(root, 'original.ts'), join(root, 'renamed.ts'));
    expect((await detectChanges(before)).changes.filter((change) => change.tier === 'worktree')[0]?.kind).toBe('renamed');
    await writeFile(join(root, 'renamed.ts'), `${Array.from({ length: 40 }, (_, n) => `export const value${n} = ${n};`).join('\n')}\n// changed\n`);
    await commit(root);
    const report = await detectChanges(before);
    expect(report.changes).toHaveLength(2);
    expect(report.changes.every((change) => change.kind === 'renamed' && change.content_changed)).toBe(true);
    expect(report.changes[0]?.previous_path).toBe('original.ts');
  });

  test('partial clones stay offline: inexact rename detection degrades to add/delete', async () => {
    const root = await fixture();
    await writeFile(join(root, 'original.ts'), Array.from({ length: 40 }, (_, n) => `export const value${n} = ${n};`).join('\n'));
    await commit(root);
    const before = await captureSnapshot(root);
    await rename(join(root, 'original.ts'), join(root, 'renamed.ts'));
    await writeFile(join(root, 'renamed.ts'), `${Array.from({ length: 40 }, (_, n) => `export const value${n} = ${n};`).join('\n')}\n// changed\n`);
    await commit(root);
    await command(root, 'config', 'remote.origin.promisor', 'true');
    const guard = installNetworkGuard();
    try {
      const report = await detectChanges(before);
      expect(report.changes.some((change) => change.kind === 'renamed')).toBe(false);
      expect(new Set(report.changes.map((change) => change.kind))).toEqual(new Set(['added', 'deleted']));
      expect(report.warnings.some((warning) => warning.includes('exact-only'))).toBe(true);
      guard.assertZeroCalls();
    } finally {
      guard.restore();
    }
  });

  test('content hashes remain useful when a checkpoint is missing', async () => {
    const root = await fixture();
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    await commit(root);
    const baseline = await captureSnapshot(root);
    const missing = { ...baseline, head_commit: 'f'.repeat(40) };
    await writeFile(join(root, 'a.ts'), 'export const a = 2;\n');
    const result = await detectChanges(missing);
    expect(result.changes.map((change) => change.tier)).toEqual(['worktree']);
    expect(result.warnings.some((warning) => warning.includes('baseline checkpoint object is missing'))).toBe(true);
  });

  test('unborn HEAD and detached HEAD do not depend on a named branch', async () => {
    const root = await fixture();
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    await command(root, 'add', '--', 'a.ts');
    const unborn = await captureSnapshot(root);
    expect(unborn.head_commit).toBeNull();
    expect(unborn.files).toHaveLength(2);
    await commit(root);
    await command(root, 'checkout', '--detach', '-q');
    expect((await captureSnapshot(root)).head_commit).not.toBeNull();
  });

  test('built-in exclusions, symlinks, and generated directories are never fingerprinted', async () => {
    const root = await fixture();
    await mkdir(join(root, 'node_modules'));
    await mkdir(join(root, 'nested'));
    await writeFile(join(root, '.env'), 'fixture-only private configuration');
    await writeFile(join(root, 'nested', 'server.pem'), 'fixture-only key file');
    await writeFile(join(root, 'node_modules', 'library.ts'), 'generated fixture dependency');
    await writeFile(join(root, 'safe.ts'), 'export const safe = true;');
    await symlink(join(root, '.env'), join(root, 'linked.ts'));
    await command(root, 'add', '--all');
    const snapshot = await captureSnapshot(root);
    expect(paths(snapshot, 'committed')).toEqual(['safe.ts']);
    expect(paths(snapshot, 'worktree')).toEqual(['safe.ts']);
    expect(snapshot.skipped.filter((entry) => entry.path === 'linked.ts').map((entry) => entry.reason)).toEqual(['symlink', 'symlink']);
  });

  test('filesystem fallback is deterministic and detects additions, deletions, and mode changes', async () => {
    const root = await fixture(false);
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;');
    const baseline = await captureSnapshot(root);
    expect(baseline.mode).toBe('content');
    expect(baseline.hash_algorithm).toBe('sha256');
    expect((await detectChanges(baseline)).changes).toEqual([]);
    await chmod(join(root, 'src', 'a.ts'), 0o755);
    expect((await detectChanges(baseline)).changes[0]?.mode_changed).toBe(true);
    await unlink(join(root, 'src', 'a.ts'));
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2;');
    expect((await detectChanges(baseline)).changes.map((change) => change.kind)).toEqual(['deleted', 'added']);
  });

  test('ambiguous equal blobs are not guessed as renames', async () => {
    const root = await fixture(false);
    await writeFile(join(root, 'a.ts'), 'same');
    await writeFile(join(root, 'b.ts'), 'same');
    const before = await captureSnapshot(root);
    await rename(join(root, 'a.ts'), join(root, 'c.ts'));
    await rename(join(root, 'b.ts'), join(root, 'd.ts'));
    const after = await captureSnapshot(root);
    expect(compareSnapshots(before, after).filter((change) => change.kind === 'renamed')).toEqual([]);
  });

  test('unavailable bytes are not silently reported as unchanged or deleted', async () => {
    const root = await fixture(false);
    await writeFile(join(root, 'a.ts'), 'small');
    const baseline = await captureSnapshot(root);
    await writeFile(join(root, 'a.ts'), 'too big'.repeat(100));
    const result = await detectChanges(baseline, { max_file_bytes: 20 });
    expect(result.changes[0]?.kind).toBe('unavailable');
    expect(result.snapshot.skipped[0]?.reason).toBe('too_large');
    await expect(captureSnapshot(root, { max_files: 1, unknown: true } as never)).rejects.toThrow();
  });

  test('file budgets fail instead of truncating the repository; subdirectories cannot masquerade as roots', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'a.ts'), 'a');
    await writeFile(join(root, 'b.ts'), 'b');
    await expect(captureSnapshot(root, { max_files: 1 })).rejects.toThrow();
    await expect(captureSnapshot(join(root, 'src'))).rejects.toThrow(/worktree root/);
  });

  test('Git SHA-256 repositories use matching blob framing, not plain content hashes', async () => {
    const root = await fixture(false);
    await command(root, 'init', '-q', '--object-format=sha256');
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    await commit(root);
    const snapshot = await captureSnapshot(root);
    expect(snapshot.hash_algorithm).toBe('git-sha256');
    expect(snapshot.head_commit).toHaveLength(64);
    expect(snapshot.files[0]?.blob_sha).toHaveLength(64);
    expect(snapshot.files[0]?.blob_sha).toBe(snapshot.files[1]?.blob_sha);
  });

  test('conflict stages are unavailable, never a fresh stage-zero baseline', async () => {
    const root = await fixture();
    await writeFile(join(root, 'a.ts'), 'base\n');
    await commit(root);
    const main = await command(root, 'rev-parse', '--abbrev-ref', 'HEAD');
    await command(root, 'checkout', '-qb', 'onemem-fixture-side');
    await writeFile(join(root, 'a.ts'), 'side\n');
    await commit(root);
    await command(root, 'checkout', '-q', main);
    await writeFile(join(root, 'a.ts'), 'main\n');
    await commit(root);
    const baseline = await captureSnapshot(root);
    await expect(command(root, 'merge', '--no-edit', 'onemem-fixture-side')).rejects.toThrow();
    const result = await detectChanges(baseline);
    expect(result.snapshot.files).toEqual([]);
    expect(result.snapshot.skipped.map((entry) => entry.reason)).toEqual(['conflict', 'conflict']);
    expect(result.changes.every((change) => change.kind === 'unavailable')).toBe(true);
  });

  test('capture does not run configured clean filters or fsmonitor helpers', async () => {
    const root = await fixture();
    await writeFile(join(root, 'a.ts'), 'export const a = 1;\n');
    await writeFile(join(root, '.gitattributes'), '*.ts filter=fixture-trap\n');
    await commit(root);
    const marker = join(root, 'helper-executed');
    const helper = join(root, 'fixture-helper.sh');
    await writeFile(helper, `#!/bin/sh\nprintf executed > "${marker}"\ncat\n`);
    await chmod(helper, 0o755);
    await command(root, 'config', 'filter.fixture-trap.clean', helper);
    await command(root, 'config', 'core.fsmonitor', helper);
    const snapshot = await captureSnapshot(root);
    expect(snapshot.files.some((file) => file.path === 'a.ts')).toBe(true);
    await expect(stat(marker)).rejects.toThrow();
  });

  test('repeated unavailable paths cannot become an empty fresh report', async () => {
    const root = await fixture(false);
    await writeFile(join(root, 'large.ts'), 'unavailable'.repeat(100));
    const baseline = await captureSnapshot(root, { max_file_bytes: 10 });
    const result = await detectChanges(baseline, { max_file_bytes: 10 });
    expect(result.changes[0]?.kind).toBe('unavailable');
  });

  test('broken Git metadata is an error, not a misleading non-Git fallback', async () => {
    const root = await fixture(false);
    await writeFile(join(root, '.git'), 'not a valid Git directory marker');
    await expect(captureSnapshot(root)).rejects.toThrow(/Git could not inspect/);
  });

  test('tracked parent directories replaced by symlinks are not followed', async () => {
    const root = await fixture();
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1;');
    await commit(root);
    const baseline = await captureSnapshot(root);
    await rename(join(root, 'src'), join(root, '.env-private'));
    await symlink(join(root, '.env-private'), join(root, 'src'));
    const result = await detectChanges(baseline);
    expect(result.snapshot.files.filter((file) => file.tier === 'worktree')).toEqual([]);
    expect(result.changes.find((change) => change.path === 'src/a.ts')?.kind).toBe('unavailable');
  });

  test.skipIf(process.platform !== 'linux')('non-UTF-8 names fail closed in Git and filesystem scans', async () => {
    for (const git of [true, false]) {
      const root = await fixture(git);
      await writeFile(Buffer.concat([Buffer.from(`${root}/`), Buffer.from([0xff])]), 'fixture');
      await expect(captureSnapshot(root)).rejects.toThrow(/UTF-8/);
    }
  });
});
