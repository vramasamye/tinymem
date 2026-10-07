import { afterEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdtemp, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { installNetworkGuard } from '@onememory-ai/security';
import { createEmbeddedDb } from '@onememory-ai/storage';
import { uuidv7 } from '@onememory-ai/core';
import type {
  CodeMemoryStore,
  CodeRepositoryRecord,
  MemoryCodeRef,
  SnapshotMetadata,
  StoredFingerprint,
} from '@onememory-ai/core';

import { captureSnapshot, createDriftWatcher } from './index';
import type { RepositorySnapshot } from './index';

const execute = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(git = true): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'onemem code drift '));
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
  await command(root, 'commit', '-qm', 'test: record drift fixture');
}

// ---------------------------------------------------------------------------
// Programmable read-side double: every WRITE method throws, so any detectDrift call that tried
// to persist would fail loudly — drift must be a pure read over persisted state.
// ---------------------------------------------------------------------------

interface FakeCodeMemoryState {
  repositories: CodeRepositoryRecord[];
  fingerprints: StoredFingerprint[];
  refs: MemoryCodeRef[];
  metadata: Map<string, SnapshotMetadata>;
}

function repositoryRow(
  projectId: string,
  overrides: Partial<CodeRepositoryRecord> = {},
): CodeRepositoryRecord {
  return {
    id: uuidv7(),
    project_id: projectId,
    root_path: '/tmp/fixture',
    remote_url: null,
    head_commit: null,
    last_ingested_commit: null,
    last_indexed_at: null,
    created_at: '2026-10-05T00:00:00.000Z',
    updated_at: '2026-10-05T00:00:00.000Z',
    ...overrides,
  };
}

function refRow(repositoryId: string, memoryId: string, path: string, blobSha: string): MemoryCodeRef {
  return {
    memory_id: memoryId,
    repository_id: repositoryId,
    path,
    blob_sha: blobSha,
    created_at: '2026-10-05T00:00:00.000Z',
  };
}

function fingerprintRow(repositoryId: string, path: string, blobSha: string): StoredFingerprint {
  return {
    repository_id: repositoryId,
    path,
    tier: 'worktree',
    blob_sha: blobSha,
    file_mode: '100644',
    last_seen_commit: null,
    symbols_hash: null,
    updated_at: '2026-10-05T00:00:00.000Z',
  };
}

function fakeStore(state: FakeCodeMemoryState): CodeMemoryStore {
  const unexpected = (method: string): never => {
    throw new Error(`detectDrift must not call ${method}`);
  };
  return {
    ensureRepository: () => unexpected('ensureRepository'),
    getRepository: (id) =>
      Promise.resolve(state.repositories.find((row) => row.id === id) ?? null),
    listRepositories: (projectId) =>
      Promise.resolve(state.repositories.filter((row) => row.project_id === projectId)),
    saveSnapshot: () => unexpected('saveSnapshot'),
    loadFingerprints: (repositoryId, filter = {}) =>
      Promise.resolve(
        state.fingerprints.filter(
          (row) =>
            row.repository_id === repositoryId &&
            (filter.tier === undefined || row.tier === filter.tier) &&
            (filter.paths === undefined || filter.paths.includes(row.path)),
        ),
      ),
    loadSnapshotMetadata: (repositoryId) => {
      if (!state.repositories.some((row) => row.id === repositoryId)) {
        return Promise.reject(new Error('repository not found'));
      }
      return Promise.resolve(state.metadata.get(repositoryId) ?? null);
    },
    recordCodeRefs: () => unexpected('recordCodeRefs'),
    listCodeRefs: (repositoryId, filter = {}) =>
      Promise.resolve(
        state.refs.filter(
          (row) =>
            row.repository_id === repositoryId &&
            (filter.paths === undefined || filter.paths.includes(row.path)),
        ),
      ),
    // Symbol persistence is not drift's read side; the watcher must never touch it either way.
    saveSymbolTable: () => unexpected('saveSymbolTable'),
    loadSymbols: () => unexpected('loadSymbols'),
    retargetCodeRef: () => unexpected('retargetCodeRef'),
    advanceCheckpoint: () => unexpected('advanceCheckpoint'),
  };
}

/** The worktree-tier blob a real capture produced for one path. */
function worktreeBlob(snapshot: RepositorySnapshot, path: string): string {
  const file = snapshot.files.find((entry) => entry.tier === 'worktree' && entry.path === path);
  if (!file) throw new Error(`fixture missing worktree blob for ${path}`);
  return file.blob_sha;
}

/**
 * What a real saveSnapshot leaves behind for a capture, including the port's retention
 * invariant: (path, tier) entries the capture could not read keep their last-known rows, and the
 * metadata records the unreadable set (the honest source of drift's suspicion).
 */
function persistedFrom(
  snapshot: RepositorySnapshot,
  repositoryId: string,
  previous?: { fingerprints: StoredFingerprint[] },
): { fingerprints: StoredFingerprint[]; metadata: SnapshotMetadata } {
  const retained =
    previous?.fingerprints.filter((row) =>
      snapshot.skipped.some((entry) => entry.path === row.path && entry.tier === row.tier),
    ) ?? [];
  return {
    fingerprints: [
      ...snapshot.files.map((file) => ({
        repository_id: repositoryId,
        path: file.path,
        tier: file.tier,
        blob_sha: file.blob_sha,
        file_mode: file.mode,
        last_seen_commit: snapshot.head_commit,
        symbols_hash: null,
        updated_at: snapshot.captured_at,
      })),
      ...retained,
    ],
    metadata: {
      root_path: snapshot.root_path,
      head_commit: snapshot.head_commit,
      hash_algorithm: snapshot.hash_algorithm,
      mode: snapshot.mode,
      exclusion_globs: snapshot.exclusion_globs,
      captured_at: snapshot.captured_at,
      file_count: snapshot.files.length,
      skipped_count: snapshot.skipped.length,
      skipped: snapshot.skipped.map((entry) => ({ path: entry.path, tier: entry.tier })),
    },
  };
}

describe('code drift detection', () => {
  test('refs recorded against a persisted snapshot report no drift while the blob is unchanged', async () => {
    const root = await fixture();
    await writeFile(join(root, 'auth.ts'), 'export function validate() { return true; }\n');
    await commit(root);
    const snapshot = await captureSnapshot(root);
    const repository = repositoryRow(uuidv7(), { root_path: root });
    const memory = uuidv7();
    const persisted = persistedFrom(snapshot, repository.id);
    const state: FakeCodeMemoryState = {
      repositories: [repository],
      fingerprints: persisted.fingerprints,
      refs: [refRow(repository.id, memory, 'auth.ts', worktreeBlob(snapshot, 'auth.ts'))],
      metadata: new Map([[repository.id, persisted.metadata]]),
    };
    const report = await createDriftWatcher(fakeStore(state)).detectDrift({
      project_id: repository.project_id,
    });
    expect(report).toEqual({ drifted: [] });
  });

  test('changed worktree blobs drift; committed-only differences never do (refs pin the worktree tier)', async () => {
    const root = await fixture();
    await writeFile(join(root, 'auth.ts'), 'export const version = 1;\n');
    await commit(root);
    const before = await captureSnapshot(root);
    const repository = repositoryRow(uuidv7(), { root_path: root });
    const memory = uuidv7();
    const persistedBefore = persistedFrom(before, repository.id);
    const state: FakeCodeMemoryState = {
      repositories: [repository],
      fingerprints: persistedBefore.fingerprints,
      refs: [refRow(repository.id, memory, 'auth.ts', worktreeBlob(before, 'auth.ts'))],
      metadata: new Map([[repository.id, persistedBefore.metadata]]),
    };
    const watcher = createDriftWatcher(fakeStore(state));
    const project = repository.project_id;

    // The ref pins the WORKTREE tier: a committed-tier-only difference is not drift.
    state.fingerprints = persistedBefore.fingerprints.map((row) =>
      row.tier === 'committed' ? { ...row, blob_sha: 'f'.repeat(40) } : row,
    );
    expect((await watcher.detectDrift({ project_id: project })).drifted).toEqual([]);

    // A real dirty worktree change drifts.
    await writeFile(join(root, 'auth.ts'), 'export const version = 2;\n');
    const persistedAfter = persistedFrom(await captureSnapshot(root), repository.id);
    state.fingerprints = persistedAfter.fingerprints;
    state.metadata = new Map([[repository.id, persistedAfter.metadata]]);
    expect(await watcher.detectDrift({ project_id: project })).toEqual({
      drifted: [
        {
          memory_id: memory,
          changed_paths: ['auth.ts'],
          refs: [{ repository_id: repository.id, path: 'auth.ts', reason: 'content_changed' }],
        },
      ],
    });
  });

  test('renamed paths report the successor alongside the stale ref; modified moves stay unresolved', async () => {
    const root = await fixture();
    const lines = Array.from({ length: 40 }, (_, n) => `export const value${n} = ${n};`).join('\n');
    await writeFile(join(root, 'original.ts'), lines);
    await commit(root);
    const before = await captureSnapshot(root);
    const repository = repositoryRow(uuidv7(), { root_path: root });
    const memory = uuidv7();
    const persistedBefore = persistedFrom(before, repository.id);
    const state: FakeCodeMemoryState = {
      repositories: [repository],
      fingerprints: persistedBefore.fingerprints,
      refs: [refRow(repository.id, memory, 'original.ts', worktreeBlob(before, 'original.ts'))],
      metadata: new Map([[repository.id, persistedBefore.metadata]]),
    };
    const watcher = createDriftWatcher(fakeStore(state));
    const project = repository.project_id;

    // Unmodified move: the ref's exact blob appears at exactly one new path — resolvable.
    await rename(join(root, 'original.ts'), join(root, 'renamed.ts'));
    await commit(root);
    const persistedAfter = persistedFrom(await captureSnapshot(root), repository.id);
    state.fingerprints = persistedAfter.fingerprints;
    state.metadata = new Map([[repository.id, persistedAfter.metadata]]);
    expect(await watcher.detectDrift({ project_id: project })).toEqual({
      drifted: [
        {
          memory_id: memory,
          changed_paths: ['original.ts', 'renamed.ts'],
          refs: [
            {
              repository_id: repository.id,
              path: 'original.ts',
              reason: 'path_missing',
              successor_path: 'renamed.ts',
            },
          ],
        },
      ],
    });

    // A move that also changed content cannot be paired by blob equality: the stale path is
    // reported alone (full successor resolution needs the checkpoint diff — a later slice).
    await rename(join(root, 'renamed.ts'), join(root, 'moved.ts'));
    await writeFile(join(root, 'moved.ts'), `${lines}\n// changed\n`);
    await commit(root);
    const persistedModified = persistedFrom(await captureSnapshot(root), repository.id);
    state.fingerprints = persistedModified.fingerprints;
    state.metadata = new Map([[repository.id, persistedModified.metadata]]);
    const unresolved = await watcher.detectDrift({ project_id: project });
    expect(unresolved.drifted[0]?.changed_paths).toEqual(['original.ts']);
    expect(unresolved.drifted[0]?.refs[0]?.successor_path).toBeUndefined();
  });

  test('ambiguous identical blobs and the memory’s own sibling refs never claim a successor', async () => {
    const root = await fixture(false);
    await writeFile(join(root, 'a.ts'), 'identical payload\n');
    await writeFile(join(root, 'b.ts'), 'identical payload\n');
    const before = await captureSnapshot(root);
    const repository = repositoryRow(uuidv7(), { root_path: root });
    const memory = uuidv7();
    const blob = worktreeBlob(before, 'a.ts');
    expect(worktreeBlob(before, 'b.ts')).toBe(blob);
    const persistedBefore = persistedFrom(before, repository.id);
    const state: FakeCodeMemoryState = {
      repositories: [repository],
      fingerprints: persistedBefore.fingerprints,
      refs: [
        refRow(repository.id, memory, 'a.ts', blob),
        refRow(repository.id, memory, 'b.ts', blob),
      ],
      metadata: new Map([[repository.id, persistedBefore.metadata]]),
    };
    const watcher = createDriftWatcher(fakeStore(state));
    const project = repository.project_id;

    // b.ts survives with the ref's exact bytes, but it is this memory's OWN other evidence —
    // never a rename successor of a.ts.
    await unlink(join(root, 'a.ts'));
    let persistedAfter = persistedFrom(await captureSnapshot(root), repository.id);
    state.fingerprints = persistedAfter.fingerprints;
    state.metadata = new Map([[repository.id, persistedAfter.metadata]]);
    let report = await watcher.detectDrift({ project_id: project });
    expect(report.drifted).toEqual([
      {
        memory_id: memory,
        changed_paths: ['a.ts'],
        refs: [{ repository_id: repository.id, path: 'a.ts', reason: 'path_missing' }],
      },
    ]);

    // Two indistinguishable copies of the bytes exist elsewhere: still no guessing.
    await writeFile(join(root, 'c.ts'), 'identical payload\n');
    await writeFile(join(root, 'd.ts'), 'identical payload\n');
    persistedAfter = persistedFrom(await captureSnapshot(root), repository.id);
    state.fingerprints = persistedAfter.fingerprints;
    state.metadata = new Map([[repository.id, persistedAfter.metadata]]);
    report = await watcher.detectDrift({ project_id: project });
    expect(report.drifted[0]?.changed_paths).toEqual(['a.ts']);
    expect(report.drifted[0]?.refs[0]?.successor_path).toBeUndefined();
  });

  test('unreadable captures stay suspects even when a retained last-known blob matches the ref', async () => {
    const root = await fixture(false);
    await writeFile(join(root, 'big.ts'), 'small fixture payload');
    await writeFile(join(root, 'side.ts'), 'unrelated bytes');
    const before = await captureSnapshot(root);
    const repository = repositoryRow(uuidv7(), { root_path: root });
    const memory = uuidv7();
    const blob = worktreeBlob(before, 'big.ts');
    const persistedBefore = persistedFrom(before, repository.id);
    const state: FakeCodeMemoryState = {
      repositories: [repository],
      fingerprints: persistedBefore.fingerprints,
      refs: [refRow(repository.id, memory, 'big.ts', blob)],
      metadata: new Map([[repository.id, persistedBefore.metadata]]),
    };
    const watcher = createDriftWatcher(fakeStore(state));
    const project = repository.project_id;

    // The next capture cannot read big.ts: the port's retention keeps its last-known row —
    // which still matches the ref blob EXACTLY — and the metadata records the unreadable path.
    // The matching retained blob must never read as fresh.
    await writeFile(join(root, 'big.ts'), 'x'.repeat(64));
    const after = await captureSnapshot(root, { max_file_bytes: 32 });
    expect(after.skipped.map((entry) => `${entry.tier}:${entry.path}`)).toEqual([
      'worktree:big.ts',
    ]);
    const persistedAfter = persistedFrom(after, repository.id, persistedBefore);
    expect(
      persistedAfter.fingerprints.find((row) => row.path === 'big.ts' && row.tier === 'worktree')
        ?.blob_sha,
    ).toBe(blob);
    state.fingerprints = persistedAfter.fingerprints;
    state.metadata = new Map([[repository.id, persistedAfter.metadata]]);
    let report = await watcher.detectDrift({ project_id: project });
    expect(report.drifted).toEqual([
      {
        memory_id: memory,
        changed_paths: ['big.ts'],
        refs: [{ repository_id: repository.id, path: 'big.ts', reason: 'capture_unavailable' }],
      },
    ]);

    // A path that merely could not be read is not proven to have MOVED: even an exact-blob twin
    // elsewhere must not be claimed as its successor.
    await writeFile(join(root, 'side.ts'), 'small fixture payload');
    const afterTwo = await captureSnapshot(root, { max_file_bytes: 32 });
    const persistedTwo = persistedFrom(afterTwo, repository.id, persistedAfter);
    expect(
      persistedTwo.fingerprints.find((row) => row.path === 'side.ts' && row.tier === 'worktree')
        ?.blob_sha,
    ).toBe(blob);
    state.fingerprints = persistedTwo.fingerprints;
    state.metadata = new Map([[repository.id, persistedTwo.metadata]]);
    report = await watcher.detectDrift({ project_id: project });
    expect(report.drifted[0]?.refs[0]).toEqual({
      repository_id: repository.id,
      path: 'big.ts',
      reason: 'capture_unavailable',
    });

    // A path that was never captured at all is unavailable the same way: suspect, never fresh.
    await writeFile(join(root, 'huge.ts'), 'y'.repeat(100));
    state.refs.push(refRow(repository.id, memory, 'huge.ts', 'c'.repeat(64)));
    const afterThree = await captureSnapshot(root, { max_file_bytes: 32 });
    expect(afterThree.skipped.map((entry) => entry.path).sort()).toEqual(['big.ts', 'huge.ts']);
    const persistedThree = persistedFrom(afterThree, repository.id, persistedTwo);
    state.fingerprints = persistedThree.fingerprints;
    state.metadata = new Map([[repository.id, persistedThree.metadata]]);
    expect(await watcher.detectDrift({ project_id: project })).toEqual({
      drifted: [
        {
          memory_id: memory,
          changed_paths: ['big.ts', 'huge.ts'],
          refs: [
            { repository_id: repository.id, path: 'big.ts', reason: 'capture_unavailable' },
            { repository_id: repository.id, path: 'huge.ts', reason: 'capture_unavailable' },
          ],
        },
      ],
    });
  });

  test('a repository without any persisted snapshot flags every ref as path_missing', async () => {
    const repository = repositoryRow(uuidv7());
    const memory = uuidv7();
    const state: FakeCodeMemoryState = {
      repositories: [repository],
      fingerprints: [],
      refs: [refRow(repository.id, memory, 'gone.ts', 'a'.repeat(40))],
      metadata: new Map(), // nothing was ever saved for this repository
    };
    expect(
      await createDriftWatcher(fakeStore(state)).detectDrift({ project_id: repository.project_id }),
    ).toEqual({
      drifted: [
        {
          memory_id: memory,
          changed_paths: ['gone.ts'],
          refs: [{ repository_id: repository.id, path: 'gone.ts', reason: 'path_missing' }],
        },
      ],
    });
  });

  test('drift scans only the requested project’s repositories', async () => {
    const projectA = uuidv7();
    const projectB = uuidv7();
    const repoA = repositoryRow(projectA);
    const repoB = repositoryRow(projectB);
    const repoEmpty = repositoryRow(projectA); // drift-ready, but nothing rests on it
    const memoryA = uuidv7();
    const memoryB = uuidv7();
    const state: FakeCodeMemoryState = {
      repositories: [repoA, repoB, repoEmpty],
      fingerprints: [
        fingerprintRow(repoA.id, 'shared.ts', 'b'.repeat(40)),
        fingerprintRow(repoB.id, 'shared.ts', 'c'.repeat(40)),
        fingerprintRow(repoEmpty.id, 'orphan.ts', 'd'.repeat(40)),
      ],
      refs: [
        refRow(repoA.id, memoryA, 'shared.ts', 'a'.repeat(40)),
        refRow(repoB.id, memoryB, 'shared.ts', 'a'.repeat(40)),
      ],
      metadata: new Map(),
    };
    const watcher = createDriftWatcher(fakeStore(state));
    expect(await watcher.detectDrift({ project_id: projectA })).toEqual({
      drifted: [
        {
          memory_id: memoryA,
          changed_paths: ['shared.ts'],
          refs: [{ repository_id: repoA.id, path: 'shared.ts', reason: 'content_changed' }],
        },
      ],
    });
    expect(await watcher.detectDrift({ project_id: projectB })).toEqual({
      drifted: [
        {
          memory_id: memoryB,
          changed_paths: ['shared.ts'],
          refs: [{ repository_id: repoB.id, path: 'shared.ts', reason: 'content_changed' }],
        },
      ],
    });
  });

  test('one memory drifting across two repositories reports once with merged refs', async () => {
    const project = uuidv7();
    const repoA = repositoryRow(project, { id: '11111111-1111-7111-8111-111111111111' });
    const repoB = repositoryRow(project, { id: '22222222-2222-7222-8222-222222222222' });
    const memory = uuidv7();
    const state: FakeCodeMemoryState = {
      repositories: [repoA, repoB],
      fingerprints: [fingerprintRow(repoA.id, 'x.ts', 'b'.repeat(40))],
      refs: [
        refRow(repoA.id, memory, 'x.ts', 'a'.repeat(40)),
        refRow(repoB.id, memory, 'y.ts', 'd'.repeat(40)),
      ],
      metadata: new Map(),
    };
    expect(
      await createDriftWatcher(fakeStore(state)).detectDrift({ project_id: project }),
    ).toEqual({
      drifted: [
        {
          memory_id: memory,
          changed_paths: ['x.ts', 'y.ts'],
          refs: [
            { repository_id: repoA.id, path: 'x.ts', reason: 'content_changed' },
            { repository_id: repoB.id, path: 'y.ts', reason: 'path_missing' },
          ],
        },
      ],
    });
  });

  test('pre-skipped metadata compares retained blobs until the next saveSnapshot records the set', async () => {
    const root = await fixture(false);
    await writeFile(join(root, 'a.ts'), 'fixture bytes');
    const before = await captureSnapshot(root);
    const repository = repositoryRow(uuidv7(), { root_path: root });
    const memory = uuidv7();
    const persisted = persistedFrom(before, repository.id);
    // A row persisted before the metadata's `skipped` set existed: the count survived, the path
    // set did not. Drift cannot invent the missing knowledge; the retained row compares by blob
    // until the repository's next saveSnapshot closes the gap.
    const legacy: SnapshotMetadata = {
      root_path: persisted.metadata.root_path,
      head_commit: persisted.metadata.head_commit,
      hash_algorithm: persisted.metadata.hash_algorithm,
      mode: persisted.metadata.mode,
      exclusion_globs: persisted.metadata.exclusion_globs,
      captured_at: persisted.metadata.captured_at,
      file_count: persisted.metadata.file_count,
      skipped_count: 1,
    };
    const state: FakeCodeMemoryState = {
      repositories: [repository],
      fingerprints: persisted.fingerprints,
      refs: [refRow(repository.id, memory, 'a.ts', worktreeBlob(before, 'a.ts'))],
      metadata: new Map([[repository.id, legacy]]),
    };
    expect(
      await createDriftWatcher(fakeStore(state)).detectDrift({ project_id: repository.project_id }),
    ).toEqual({ drifted: [] });
  });

  test('drift input is validated at the boundary', async () => {
    const watcher = createDriftWatcher(
      fakeStore({ repositories: [], fingerprints: [], refs: [], metadata: new Map() }),
    );
    expect((await watcher.detectDrift({ project_id: uuidv7() })).drifted).toEqual([]);
    await expect(watcher.detectDrift({ project_id: 'not-a-uuid' })).rejects.toThrow();
    await expect(
      watcher.detectDrift({ project_id: uuidv7(), extra: true } as never),
    ).rejects.toThrow();
  });

  test('detectDrift runs end to end over real embedded storage and never writes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'onemem-drift-e2e-'));
    const storage = await createEmbeddedDb(dataDir);
    const guard = installNetworkGuard();
    try {
      const root = await fixture();
      await writeFile(join(root, 'auth.ts'), 'export const version = 1;\n');
      await writeFile(join(root, 'session.ts'), 'export const session = 1;\n');
      await commit(root);

      const project = await storage.store.createProject({
        name: `drift-e2e-${uuidv7().slice(0, 8)}`,
        root_path: root,
      });
      const source = await storage.store.createSource({
        kind: 'explicit',
        uri: `conversation/session/${uuidv7()}`,
        title: 'fixture source',
        project_id: project.id,
      });
      const inserted = await storage.store.insertMemory({
        type: 'semantic',
        importance: 0.7,
        confidence: 0.8,
        content: 'auth validates every fixture request',
        observed_at: '2026-10-05T00:00:00.000Z',
        source_id: source.id,
        evidence: [
          {
            source_id: source.id,
            kind: 'message',
            locator: 'session.jsonl:1',
            excerpt: 'auth validates every fixture request',
          },
        ],
        extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
        project_id: project.id,
      });
      expect(inserted.outcome).toBe('inserted');

      // Register with the capture's canonical root (realpath), which is the row's root_path.
      const first = await captureSnapshot(root);
      const repository = await storage.codeMemory.ensureRepository({
        project_id: project.id,
        root_path: first.root_path,
      });
      await storage.codeMemory.saveSnapshot(repository.id, first);
      await storage.codeMemory.recordCodeRefs({
        memory_id: inserted.memory.id,
        repository_id: repository.id,
        refs: [{ path: 'auth.ts', blob_sha: worktreeBlob(first, 'auth.ts') }],
      });
      const watcher = createDriftWatcher(storage.codeMemory);
      expect((await watcher.detectDrift({ project_id: project.id })).drifted).toEqual([]);

      // Dirty worktree change: the pipeline saves the fresh capture, then drifts.
      await writeFile(join(root, 'auth.ts'), 'export const version = 2;\n');
      await storage.codeMemory.saveSnapshot(repository.id, await captureSnapshot(root));
      expect(await watcher.detectDrift({ project_id: project.id })).toEqual({
        drifted: [
          {
            memory_id: inserted.memory.id,
            changed_paths: ['auth.ts'],
            refs: [{ repository_id: repository.id, path: 'auth.ts', reason: 'content_changed' }],
          },
        ],
      });

      // Unreadable capture, with real saveSnapshot retention: session.ts's retained last-known
      // row still matches its ref blob EXACTLY, yet the ref must surface as a suspect.
      await storage.codeMemory.recordCodeRefs({
        memory_id: inserted.memory.id,
        repository_id: repository.id,
        refs: [{ path: 'session.ts', blob_sha: worktreeBlob(first, 'session.ts') }],
      });
      await writeFile(join(root, 'session.ts'), 'export const session = 2;\n'.repeat(64));
      await storage.codeMemory.saveSnapshot(
        repository.id,
        await captureSnapshot(root, { max_file_bytes: 1024 }),
      );
      const retained = await storage.codeMemory.loadFingerprints(repository.id, {
        tier: 'worktree',
        paths: ['session.ts'],
      });
      expect(retained[0]?.blob_sha).toBe(worktreeBlob(first, 'session.ts'));
      // A real capture's skipped entries carry their reason through the loose boundary schema.
      expect((await storage.codeMemory.loadSnapshotMetadata(repository.id))?.skipped).toEqual([
        { path: 'session.ts', tier: 'worktree', reason: 'too_large' },
      ]);
      expect(await watcher.detectDrift({ project_id: project.id })).toEqual({
        drifted: [
          {
            memory_id: inserted.memory.id,
            changed_paths: ['auth.ts', 'session.ts'],
            refs: [
              { repository_id: repository.id, path: 'auth.ts', reason: 'content_changed' },
              {
                repository_id: repository.id,
                path: 'session.ts',
                reason: 'capture_unavailable',
              },
            ],
          },
        ],
      });

      // detectDrift wrote nothing: the ingestion checkpoint never moved and the memory stayed
      // active (applying `stale` is the pipeline's later step, not the oracle's).
      expect((await storage.codeMemory.getRepository(repository.id))?.last_ingested_commit).toBeNull();
      expect((await storage.store.getMemory(inserted.memory.id))?.status).toBe('active');
      guard.assertZeroCalls();
    } finally {
      guard.restore();
      await storage.close();
      await rm(dataDir, { recursive: true, force: true });
    }
  });
});
