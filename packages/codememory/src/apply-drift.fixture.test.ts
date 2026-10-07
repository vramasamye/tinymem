/**
 * ADR-0008's CI-testable consequence, end to end over a REAL fixture Git repository and REAL
 * embedded storage: change one file → only memories referencing it go stale; an exact rename
 * moves refs without staling; a mixed memory is stale AND retargeted; re-applying is a no-op.
 * The whole loop runs under the network guard — drift is a hash comparison, never a model call.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { installNetworkGuard } from '@onememory-ai/security';
import { createEmbeddedDb } from '@onememory-ai/storage';
import type { OnememoryStorage } from '@onememory-ai/storage';
import { uuidv7 } from '@onememory-ai/core';

import { captureSnapshot, createDriftApplier, createDriftWatcher, readCheckpointBasis } from './index';
import type { RepositorySnapshot } from './index';

const execute = promisify(execFile);

async function git(root: string, ...args: string[]): Promise<string> {
  const result = await execute('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 30_000 });
  return result.stdout.trim();
}

async function commitAll(root: string, message: string): Promise<string> {
  await git(root, 'add', '--all');
  await git(root, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', message);
  return git(root, 'rev-parse', 'HEAD');
}

function worktreeBlob(snapshot: RepositorySnapshot, path: string): string {
  const file = snapshot.files.find((entry) => entry.tier === 'worktree' && entry.path === path);
  if (!file) throw new Error(`fixture missing worktree blob for ${path}`);
  return file.blob_sha;
}

interface Harness {
  storage: OnememoryStorage;
  root: string;
  projectId: string;
  repositoryId: string;
  first: RepositorySnapshot;
  memory(content: string, paths: string[]): Promise<string>;
}

let cleanup: Array<() => Promise<void>> = [];
let guard: ReturnType<typeof installNetworkGuard>;

beforeEach(() => {
  guard = installNetworkGuard();
});

afterEach(async () => {
  guard.restore();
  for (const step of cleanup.reverse()) await step();
  cleanup = [];
});

/** A committed fixture repo, a persisted first capture, and a checkpoint at its HEAD. */
async function harness(files: Record<string, string>): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-drift-apply-db-'));
  const root = await mkdtemp(join(tmpdir(), 'onemem drift apply '));
  const storage = await createEmbeddedDb(dataDir);
  cleanup.push(async () => {
    await storage.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });
  await git(root, 'init', '-q');
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), content);
  }
  await commitAll(root, 'test: fixture baseline');

  const project = await storage.store.createProject({ name: `drift-apply-${uuidv7().slice(0, 8)}`, root_path: root });
  const source = await storage.store.createSource({
    kind: 'explicit',
    uri: `conversation/session/${uuidv7()}`,
    title: 'fixture source',
    project_id: project.id,
  });
  const first = await captureSnapshot(root);
  const repository = await storage.codeMemory.ensureRepository({ project_id: project.id, root_path: first.root_path });
  await storage.codeMemory.saveSnapshot(repository.id, first);

  return {
    storage,
    root,
    projectId: project.id,
    repositoryId: repository.id,
    first,
    memory: async (content, paths) => {
      const inserted = await storage.store.insertMemory({
        type: 'semantic',
        importance: 0.7,
        confidence: 0.8,
        content,
        observed_at: '2026-10-07T00:00:00.000Z',
        source_id: source.id,
        evidence: [{ source_id: source.id, kind: 'message', locator: 'session.jsonl:1', excerpt: content }],
        extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
        project_id: project.id,
      });
      if (inserted.outcome !== 'inserted') throw new Error('fixture memory was not inserted');
      await storage.codeMemory.recordCodeRefs({
        memory_id: inserted.memory.id,
        repository_id: repository.id,
        refs: paths.map((path) => ({ path, blob_sha: worktreeBlob(first, path) })),
      });
      return inserted.memory.id;
    },
  };
}

async function statusOf(h: Harness, id: string): Promise<string | undefined> {
  return (await h.storage.store.getMemory(id))?.status;
}

async function auditCount(h: Harness, id: string): Promise<number> {
  return (await h.storage.store.listMemoryEvents(id)).length;
}

async function refPaths(h: Harness, id: string): Promise<string[]> {
  return (await h.storage.codeMemory.listCodeRefs(h.repositoryId))
    .filter((ref) => ref.memory_id === id)
    .map((ref) => ref.path);
}

describe('drift apply over a real fixture repository (ADR-0008 DoD)', () => {
  test('change ONE file → only memories referencing it go stale; nothing else is touched', async () => {
    const h = await harness({
      'src/auth.ts': 'export const auth = 1;\n',
      'src/session.ts': 'export const session = 1;\n',
      'src/billing.ts': 'export const billing = 1;\n',
    });
    const authMemory = await h.memory('auth validates requests', ['src/auth.ts']);
    const bothMemory = await h.memory('auth uses sessions', ['src/auth.ts', 'src/session.ts']);
    const sessionMemory = await h.memory('sessions expire', ['src/session.ts']);
    const billingMemory = await h.memory('billing is monthly', ['src/billing.ts']);
    const others = [sessionMemory, billingMemory];
    const applier = createDriftApplier({ store: h.storage.store, codeMemory: h.storage.codeMemory });

    // Nothing drifted yet: the first apply only moves the checkpoint onto the baseline head.
    const baseline = await applier.apply({ project_id: h.projectId });
    expect(baseline.memories).toEqual([]);
    expect(baseline.checkpoints).toEqual([
      { repository_id: h.repositoryId, outcome: 'advanced', previous_commit: null, current_commit: h.first.head_commit },
    ]);
    const auditsBefore = new Map(
      await Promise.all(others.map(async (id) => [id, await auditCount(h, id)] as const)),
    );
    const refsBefore = await h.storage.codeMemory.listCodeRefs(h.repositoryId);

    await writeFile(join(h.root, 'src/auth.ts'), 'export const auth = 2;\n');
    const head = await commitAll(h.root, 'test: change auth');
    const saved = await h.storage.codeMemory.saveSnapshot(h.repositoryId, await captureSnapshot(h.root));
    // Unchanged files keep identical blobs, so the oracle has nothing to report for them.
    expect(saved.deleted).toBe(0);
    for (const row of await h.storage.codeMemory.loadFingerprints(h.repositoryId, {
      paths: ['src/session.ts', 'src/billing.ts'],
    })) {
      const original = h.first.files.find((file) => file.path === row.path && file.tier === row.tier);
      expect(row.blob_sha).toBe(original!.blob_sha);
    }

    const result = await applier.apply({ project_id: h.projectId });
    expect(result.memories.map((memory) => [memory.memory_id, memory.outcome]).sort()).toEqual(
      [
        [authMemory, 'marked_stale'],
        [bothMemory, 'marked_stale'],
      ].sort(),
    );
    expect(result.fully_processed).toBe(true);
    expect(result.checkpoints).toEqual([
      { repository_id: h.repositoryId, outcome: 'advanced', previous_commit: h.first.head_commit, current_commit: head },
    ]);

    expect(await statusOf(h, authMemory)).toBe('stale');
    expect(await statusOf(h, bothMemory)).toBe('stale');
    for (const id of others) {
      expect(await statusOf(h, id)).toBe('active');
      expect(await auditCount(h, id)).toBe(auditsBefore.get(id)!);
    }
    // The stale transition is audited with the drifted evidence; refs are never rewritten.
    const audit = (await h.storage.store.listMemoryEvents(authMemory)).find(
      (event) => event.action !== 'created',
    );
    expect(audit).toMatchObject({
      action: 'status_changed',
      from_status: 'active',
      to_status: 'stale',
      actor: 'job:drift_scan',
      details: {
        reason: 'code_drift',
        drifted_refs: [{ repository_id: h.repositoryId, path: 'src/auth.ts', reason: 'content_changed' }],
      },
    });
    expect(await h.storage.codeMemory.listCodeRefs(h.repositoryId)).toEqual(refsBefore);
    // Stale memories stay retrievable as current knowledge (nothing is deleted).
    const current = await h.storage.store.queryCurrent({ project_id: h.projectId, limit: 20 });
    expect(current.map((memory) => memory.id).sort()).toEqual(
      [authMemory, bothMemory, sessionMemory, billingMemory].sort(),
    );
    guard.assertZeroCalls();
  });

  test('exact rename of a referenced file retargets the ref; the memory stays active', async () => {
    const h = await harness({
      'lib/parser.ts': 'export function parse() { return 42; }\n',
      'lib/other.ts': 'export const other = true;\n',
    });
    const memory = await h.memory('the parser returns 42', ['lib/parser.ts']);
    const applier = createDriftApplier({ store: h.storage.store, codeMemory: h.storage.codeMemory });
    await applier.apply({ project_id: h.projectId });
    const audits = await auditCount(h, memory);

    await mkdir(join(h.root, 'src'), { recursive: true });
    await git(h.root, 'mv', 'lib/parser.ts', 'src/parser.ts');
    const head = await commitAll(h.root, 'test: move parser');
    await h.storage.codeMemory.saveSnapshot(h.repositoryId, await captureSnapshot(h.root));

    const result = await applier.apply({ project_id: h.projectId });
    expect(result.memories).toEqual([
      {
        memory_id: memory,
        outcome: 'evidence_intact',
        status_before: 'active',
        status_after: 'active',
        retargets: [
          { repository_id: h.repositoryId, from_path: 'lib/parser.ts', to_path: 'src/parser.ts', outcome: 'retargeted' },
        ],
        drifted_refs: [],
      },
    ]);
    expect(result.checkpoints[0]).toMatchObject({ outcome: 'advanced', current_commit: head });
    expect(await statusOf(h, memory)).toBe('active');
    expect(await auditCount(h, memory)).toBe(audits);
    const refs = await h.storage.codeMemory.listCodeRefs(h.repositoryId);
    expect(refs.map((ref) => [ref.path, ref.blob_sha])).toEqual([
      ['src/parser.ts', worktreeBlob(h.first, 'lib/parser.ts')],
    ]);
    // The retargeted ref is fresh evidence again: the oracle reports nothing.
    expect((await createDriftWatcher(h.storage.codeMemory).detectDrift({ project_id: h.projectId })).drifted).toEqual([]);
    guard.assertZeroCalls();
  });

  test('mixed memory is stale AND retargeted; re-applying the same report is idempotent', async () => {
    const h = await harness({
      'core/a.ts': 'export const a = 1;\n',
      'core/b.ts': 'export const b = 1;\n',
      'core/c.ts': 'export const c = 1;\n',
    });
    const mixed = await h.memory('a and b cooperate', ['core/a.ts', 'core/b.ts']);
    const bystander = await h.memory('c is constant', ['core/c.ts']);
    const applier = createDriftApplier({ store: h.storage.store, codeMemory: h.storage.codeMemory });
    await applier.apply({ project_id: h.projectId });

    await writeFile(join(h.root, 'core/a.ts'), 'export const a = 2;\n');
    await git(h.root, 'mv', 'core/b.ts', 'core/b-renamed.ts');
    const head = await commitAll(h.root, 'test: edit a, move b');
    await h.storage.codeMemory.saveSnapshot(h.repositoryId, await captureSnapshot(h.root));

    // Basis BEFORE detection, then detect, then apply the same report twice.
    const checkpoints = await readCheckpointBasis(h.storage.codeMemory, h.projectId);
    const report = await createDriftWatcher(h.storage.codeMemory).detectDrift({ project_id: h.projectId });
    const first = await applier.applyReport({ report, checkpoints });
    expect(first.memories).toEqual([
      {
        memory_id: mixed,
        outcome: 'marked_stale',
        status_before: 'active',
        status_after: 'stale',
        retargets: [
          { repository_id: h.repositoryId, from_path: 'core/b.ts', to_path: 'core/b-renamed.ts', outcome: 'retargeted' },
        ],
        drifted_refs: [{ repository_id: h.repositoryId, path: 'core/a.ts', reason: 'content_changed' }],
      },
    ]);
    expect(first.checkpoints[0]).toMatchObject({ outcome: 'advanced', current_commit: head });
    expect(await refPaths(h, mixed)).toEqual(['core/a.ts', 'core/b-renamed.ts']);
    const audits = await auditCount(h, mixed);

    const second = await applier.applyReport({ report, checkpoints });
    expect(second.memories).toEqual([
      {
        memory_id: mixed,
        outcome: 'already_stale',
        status_before: 'stale',
        status_after: 'stale',
        retargets: [
          {
            repository_id: h.repositoryId,
            from_path: 'core/b.ts',
            to_path: 'core/b-renamed.ts',
            outcome: 'already_retargeted',
          },
        ],
        drifted_refs: [{ repository_id: h.repositoryId, path: 'core/a.ts', reason: 'content_changed' }],
      },
    ]);
    expect(second.checkpoints).toEqual([
      { repository_id: h.repositoryId, outcome: 'unchanged', previous_commit: head, current_commit: head },
    ]);
    expect(second.fully_processed).toBe(true);
    expect(await auditCount(h, mixed)).toBe(audits);
    expect(await refPaths(h, mixed)).toEqual(['core/a.ts', 'core/b-renamed.ts']);

    // A fresh detect-and-apply still sees the content change (stale memories keep drifting
    // until re-indexed) and stays a no-op for status, refs, and checkpoint.
    const third = await applier.apply({ project_id: h.projectId });
    expect(third.memories.map((memory) => memory.outcome)).toEqual(['already_stale']);
    expect(third.checkpoints[0]?.outcome).toBe('unchanged');
    expect(await statusOf(h, bystander)).toBe('active');
    guard.assertZeroCalls();
  });

  test('a capture saved after detection holds the checkpoint back (never advanced past unprocessed state)', async () => {
    const h = await harness({ 'x.ts': 'export const x = 1;\n' });
    const memory = await h.memory('x is one', ['x.ts']);
    const applier = createDriftApplier({ store: h.storage.store, codeMemory: h.storage.codeMemory });
    await applier.apply({ project_id: h.projectId });

    await writeFile(join(h.root, 'x.ts'), 'export const x = 2;\n');
    const middle = await commitAll(h.root, 'test: x two');
    await h.storage.codeMemory.saveSnapshot(h.repositoryId, await captureSnapshot(h.root));
    const checkpoints = await readCheckpointBasis(h.storage.codeMemory, h.projectId);
    const report = await createDriftWatcher(h.storage.codeMemory).detectDrift({ project_id: h.projectId });

    // A newer capture lands between detection and apply.
    await writeFile(join(h.root, 'x.ts'), 'export const x = 3;\n');
    const newest = await commitAll(h.root, 'test: x three');
    await h.storage.codeMemory.saveSnapshot(h.repositoryId, await captureSnapshot(h.root));

    const result = await applier.applyReport({ report, checkpoints });
    expect(checkpoints[0]?.head_commit).toBe(middle);
    expect(result.memories[0]?.outcome).toBe('marked_stale');
    expect(result.checkpoints[0]).toEqual({
      repository_id: h.repositoryId,
      outcome: 'head_mismatch',
      previous_commit: h.first.head_commit,
      current_commit: h.first.head_commit,
    });
    expect((await h.storage.codeMemory.getRepository(h.repositoryId))?.last_ingested_commit).toBe(h.first.head_commit);

    // The next full pass processes the newest capture and advances straight to it.
    const next = await applier.apply({ project_id: h.projectId });
    expect(next.checkpoints[0]).toMatchObject({ outcome: 'advanced', current_commit: newest });
    expect(await statusOf(h, memory)).toBe('stale');
  });
});
