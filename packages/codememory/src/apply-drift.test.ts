import { describe, expect, test } from 'bun:test';

import { InvalidTransitionError, uuidv7 } from '@onememory-ai/core';
import type {
  AdvanceCheckpoint,
  CheckpointAdvanceResult,
  CodeMemoryStore,
  CodeRefRetargetOutcome,
  CodeRefRetargetResult,
  CodeRepositoryRecord,
  DriftReport,
  MemoryRecord,
  MemoryStatus,
  RetargetCodeRef,
  StatusChangeOptions,
} from '@onememory-ai/core';

import { createDriftApplier } from './index';
import type { DriftApplyStore } from './index';

// ---------------------------------------------------------------------------
// Programmable doubles: the applier may only read memories, transition them, retarget refs, and
// advance checkpoints — every other port method throws.
// ---------------------------------------------------------------------------

interface StatusCall {
  id: string;
  to: MemoryStatus;
  options: StatusChangeOptions;
}

function fakeStore(statuses: Map<string, MemoryStatus>, overrides: Partial<DriftApplyStore> = {}): {
  store: DriftApplyStore;
  calls: StatusCall[];
} {
  const calls: StatusCall[] = [];
  const record = (id: string): MemoryRecord | null => {
    const status = statuses.get(id);
    return status === undefined ? null : ({ id, status } as MemoryRecord);
  };
  return {
    calls,
    store: {
      getMemory: (id) => Promise.resolve(record(id)),
      updateMemoryStatus: (id, to, options) => {
        calls.push({ id, to, options });
        const from = statuses.get(id);
        if (from === undefined) return Promise.reject(new Error(`storage: memory ${id} not found`));
        if (from === to) return Promise.reject(new InvalidTransitionError(from, to));
        statuses.set(id, to);
        return Promise.resolve(record(id)!);
      },
      ...overrides,
    },
  };
}

interface CodeMemoryCalls {
  retargets: RetargetCodeRef[];
  advances: AdvanceCheckpoint[];
}

function fakeCodeMemory(options: {
  retarget?: (input: RetargetCodeRef) => CodeRefRetargetOutcome | Error;
  advance?: (input: AdvanceCheckpoint) => CheckpointAdvanceResult['outcome'];
} = {}): { codeMemory: CodeMemoryStore; calls: CodeMemoryCalls } {
  const calls: CodeMemoryCalls = { retargets: [], advances: [] };
  const unexpected = (method: string): never => {
    throw new Error(`applyReport must not call ${method}`);
  };
  const repository = (id: string, last: string | null): CodeRepositoryRecord => ({
    id,
    project_id: uuidv7(),
    root_path: '/tmp/fixture',
    remote_url: null,
    head_commit: null,
    last_ingested_commit: last,
    last_indexed_at: null,
    created_at: '2026-10-07T00:00:00.000Z',
    updated_at: '2026-10-07T00:00:00.000Z',
  });
  return {
    calls,
    codeMemory: {
      ensureRepository: () => unexpected('ensureRepository'),
      getRepository: () => unexpected('getRepository'),
      listRepositories: () => unexpected('listRepositories'),
      saveSnapshot: () => unexpected('saveSnapshot'),
      loadFingerprints: () => unexpected('loadFingerprints'),
      loadSnapshotMetadata: () => unexpected('loadSnapshotMetadata'),
      recordCodeRefs: () => unexpected('recordCodeRefs'),
      listCodeRefs: () => unexpected('listCodeRefs'),
      saveSymbolTable: () => unexpected('saveSymbolTable'),
      loadSymbols: () => unexpected('loadSymbols'),
      retargetCodeRef: (input): Promise<CodeRefRetargetResult> => {
        calls.retargets.push(input);
        const outcome = options.retarget?.(input) ?? 'retargeted';
        if (outcome instanceof Error) return Promise.reject(outcome);
        const moved = outcome === 'retargeted' || outcome === 'already_retargeted';
        return Promise.resolve({
          outcome,
          ref: {
            memory_id: input.memory_id,
            repository_id: input.repository_id,
            path: moved ? input.to_path : input.from_path,
            blob_sha: 'a'.repeat(40),
            created_at: '2026-10-07T00:00:00.000Z',
          },
        });
      },
      advanceCheckpoint: (input): Promise<CheckpointAdvanceResult> => {
        calls.advances.push(input);
        const outcome = options.advance?.(input) ?? 'advanced';
        const previous = input.expected_last_ingested_commit;
        const current = outcome === 'advanced' || outcome === 'unchanged' ? input.to_commit : previous;
        return Promise.resolve({
          outcome,
          previous_commit: outcome === 'unchanged' ? input.to_commit : previous,
          current_commit: current,
          repository: repository(input.repository_id, current),
        });
      },
    },
  };
}

const HEAD = 'b'.repeat(40);
const PRIOR = 'c'.repeat(40);

function basis(repositoryId: string, head: string | null = HEAD) {
  return [{ repository_id: repositoryId, head_commit: head, last_ingested_commit: PRIOR }];
}

describe('drift apply (unit, port doubles)', () => {
  test('a content change marks only that memory stale (audited) and advances the checkpoint', async () => {
    const repo = uuidv7();
    const changed = uuidv7();
    const untouched = uuidv7();
    const statuses = new Map<string, MemoryStatus>([
      [changed, 'active'],
      [untouched, 'active'],
    ]);
    const { store, calls } = fakeStore(statuses);
    const code = fakeCodeMemory();
    const report: DriftReport = {
      drifted: [
        {
          memory_id: changed,
          changed_paths: ['auth.ts'],
          refs: [{ repository_id: repo, path: 'auth.ts', reason: 'content_changed' }],
        },
      ],
    };

    const result = await createDriftApplier({ store, codeMemory: code.codeMemory }).applyReport({
      report,
      checkpoints: basis(repo),
    });

    expect(result.memories).toEqual([
      {
        memory_id: changed,
        outcome: 'marked_stale',
        status_before: 'active',
        status_after: 'stale',
        retargets: [],
        drifted_refs: [{ repository_id: repo, path: 'auth.ts', reason: 'content_changed' }],
      },
    ]);
    expect(calls).toEqual([
      {
        id: changed,
        to: 'stale',
        options: {
          actor: 'job:drift_scan',
          reason: 'code_drift',
          details: {
            drifted_refs: [{ repository_id: repo, path: 'auth.ts', reason: 'content_changed' }],
          },
        },
      },
    ]);
    expect(statuses.get(untouched)).toBe('active');
    expect(code.calls.retargets).toEqual([]);
    expect(code.calls.advances).toEqual([
      { repository_id: repo, expected_last_ingested_commit: PRIOR, to_commit: HEAD },
    ]);
    expect(result.checkpoints).toEqual([
      { repository_id: repo, outcome: 'advanced', previous_commit: PRIOR, current_commit: HEAD },
    ]);
    expect(result.fully_processed).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  test('an exact move retargets the ref and leaves the memory untouched', async () => {
    const repo = uuidv7();
    const memory = uuidv7();
    const statuses = new Map<string, MemoryStatus>([[memory, 'active']]);
    const { store, calls } = fakeStore(statuses);
    const code = fakeCodeMemory();
    const result = await createDriftApplier({ store, codeMemory: code.codeMemory }).applyReport({
      report: {
        drifted: [
          {
            memory_id: memory,
            changed_paths: ['lib/old.ts', 'lib/new.ts'],
            refs: [
              { repository_id: repo, path: 'lib/old.ts', reason: 'path_missing', successor_path: 'lib/new.ts' },
            ],
          },
        ],
      },
      checkpoints: basis(repo),
      actor: 'agent:test',
    });

    expect(result.memories[0]).toMatchObject({
      outcome: 'evidence_intact',
      status_before: 'active',
      status_after: 'active',
      drifted_refs: [],
      retargets: [{ repository_id: repo, from_path: 'lib/old.ts', to_path: 'lib/new.ts', outcome: 'retargeted' }],
    });
    expect(code.calls.retargets).toEqual([
      { memory_id: memory, repository_id: repo, from_path: 'lib/old.ts', to_path: 'lib/new.ts' },
    ]);
    expect(calls).toEqual([]);
    expect(result.checkpoints[0]?.outcome).toBe('advanced');
  });

  test('mixed: successor refs are retargeted AND a non-successor ref stales the memory', async () => {
    const repo = uuidv7();
    const memory = uuidv7();
    const { store, calls } = fakeStore(new Map([[memory, 'active']]));
    const code = fakeCodeMemory();
    const result = await createDriftApplier({ store, codeMemory: code.codeMemory }).applyReport({
      report: {
        drifted: [
          {
            memory_id: memory,
            changed_paths: ['a.ts', 'moved.ts', 'old.ts'],
            refs: [
              { repository_id: repo, path: 'a.ts', reason: 'content_changed' },
              { repository_id: repo, path: 'old.ts', reason: 'path_missing', successor_path: 'moved.ts' },
            ],
          },
        ],
      },
      checkpoints: basis(repo),
    });
    expect(result.memories[0]).toMatchObject({
      outcome: 'marked_stale',
      status_after: 'stale',
      retargets: [{ from_path: 'old.ts', to_path: 'moved.ts', outcome: 'retargeted' }],
      drifted_refs: [{ repository_id: repo, path: 'a.ts', reason: 'content_changed' }],
    });
    expect(calls.map((call) => call.to)).toEqual(['stale']);
  });

  test('a retarget persistence refuses leaves the ref drifted, so the memory goes stale', async () => {
    const repo = uuidv7();
    const memory = uuidv7();
    const { store } = fakeStore(new Map([[memory, 'active']]));
    const code = fakeCodeMemory({ retarget: () => 'successor_mismatch' });
    const result = await createDriftApplier({ store, codeMemory: code.codeMemory }).applyReport({
      report: {
        drifted: [
          {
            memory_id: memory,
            changed_paths: ['new.ts', 'old.ts'],
            refs: [{ repository_id: repo, path: 'old.ts', reason: 'path_missing', successor_path: 'new.ts' }],
          },
        ],
      },
      checkpoints: basis(repo),
    });
    expect(result.memories[0]?.outcome).toBe('marked_stale');
    expect(result.memories[0]?.retargets[0]?.outcome).toBe('successor_mismatch');
    expect(result.memories[0]?.drifted_refs).toHaveLength(1);
    expect(result.warnings.join('\n')).toContain('successor_mismatch');
    expect(result.checkpoints[0]?.outcome).toBe('advanced');
  });

  test('already-stale, superseded, and archived memories count as processed without a transition', async () => {
    const repo = uuidv7();
    const stale = uuidv7();
    const superseded = uuidv7();
    const archived = uuidv7();
    const disputed = uuidv7();
    const { store, calls } = fakeStore(
      new Map<string, MemoryStatus>([
        [stale, 'stale'],
        [superseded, 'superseded'],
        [archived, 'archived'],
        [disputed, 'disputed'],
      ]),
    );
    const code = fakeCodeMemory();
    const drifted = [stale, superseded, archived, disputed].map((memory_id) => ({
      memory_id,
      changed_paths: ['x.ts'],
      refs: [{ repository_id: repo, path: 'x.ts', reason: 'content_changed' as const }],
    }));
    const result = await createDriftApplier({ store, codeMemory: code.codeMemory }).applyReport({
      report: { drifted },
      checkpoints: basis(repo),
    });
    expect(result.memories.map((memory) => memory.outcome)).toEqual([
      'already_stale',
      'not_current',
      'not_current',
      'marked_stale',
    ]);
    expect(calls.map((call) => call.id)).toEqual([disputed]);
    expect(result.fully_processed).toBe(true);
    expect(result.checkpoints[0]?.outcome).toBe('advanced');
  });

  test('a concurrent stale transition (InvalidTransitionError) settles as already_stale', async () => {
    const repo = uuidv7();
    const memory = uuidv7();
    const statuses = new Map<string, MemoryStatus>([[memory, 'active']]);
    let reads = 0;
    const { store } = fakeStore(statuses, {
      getMemory: (id) => {
        reads += 1;
        // First read sees active; by the time the write lands another worker staled it.
        if (reads === 1) return Promise.resolve({ id, status: 'active' } as MemoryRecord);
        return Promise.resolve({ id, status: 'stale' } as MemoryRecord);
      },
      updateMemoryStatus: () => Promise.reject(new InvalidTransitionError('stale', 'stale')),
    });
    const code = fakeCodeMemory();
    const result = await createDriftApplier({ store, codeMemory: code.codeMemory }).applyReport({
      report: {
        drifted: [
          {
            memory_id: memory,
            changed_paths: ['x.ts'],
            refs: [{ repository_id: repo, path: 'x.ts', reason: 'content_changed' }],
          },
        ],
      },
      checkpoints: basis(repo),
    });
    expect(result.memories[0]?.outcome).toBe('already_stale');
    expect(result.memories[0]?.status_after).toBe('stale');
    expect(result.checkpoints[0]?.outcome).toBe('advanced');
  });

  test('memories deleted since detection are skipped with a warning and do not block the checkpoint', async () => {
    const repo = uuidv7();
    const gone = uuidv7();
    const racedAway = uuidv7();
    const statuses = new Map<string, MemoryStatus>([[racedAway, 'active']]);
    const { store } = fakeStore(statuses);
    const code = fakeCodeMemory({
      retarget: (input) => {
        // The memory is purged mid-apply: the retarget write finds no memory row.
        statuses.delete(input.memory_id);
        return new Error(`storage: memory ${input.memory_id} not found`);
      },
    });
    const result = await createDriftApplier({ store, codeMemory: code.codeMemory }).applyReport({
      report: {
        drifted: [
          {
            memory_id: gone,
            changed_paths: ['x.ts'],
            refs: [{ repository_id: repo, path: 'x.ts', reason: 'content_changed' }],
          },
          {
            memory_id: racedAway,
            changed_paths: ['n.ts', 'o.ts'],
            refs: [{ repository_id: repo, path: 'o.ts', reason: 'path_missing', successor_path: 'n.ts' }],
          },
        ],
      },
      checkpoints: basis(repo),
    });
    expect(result.memories.map((memory) => [memory.outcome, memory.status_after])).toEqual([
      ['gone', null],
      ['gone', null],
    ]);
    expect(result.warnings.filter((warning) => warning.includes('no longer exists'))).toHaveLength(2);
    expect(result.fully_processed).toBe(true);
    expect(result.checkpoints[0]?.outcome).toBe('advanced');
  });

  test('an unexpected failure is reported and holds every checkpoint back', async () => {
    const repoA = uuidv7();
    const repoB = uuidv7();
    const broken = uuidv7();
    const fine = uuidv7();
    const { store } = fakeStore(
      new Map<string, MemoryStatus>([
        [broken, 'active'],
        [fine, 'active'],
      ]),
      {
        updateMemoryStatus: (id, to) =>
          id === broken
            ? Promise.reject(new Error('connection reset'))
            : Promise.resolve({ id, status: to } as MemoryRecord),
      },
    );
    const code = fakeCodeMemory();
    const result = await createDriftApplier({ store, codeMemory: code.codeMemory }).applyReport({
      report: {
        drifted: [broken, fine].map((memory_id) => ({
          memory_id,
          changed_paths: ['x.ts'],
          refs: [{ repository_id: repoA, path: 'x.ts', reason: 'content_changed' as const }],
        })),
      },
      checkpoints: [...basis(repoA), ...basis(repoB)],
    });
    expect(result.memories.map((memory) => memory.outcome)).toEqual(['failed', 'marked_stale']);
    expect(result.memories[0]?.error).toContain('connection reset');
    expect(result.fully_processed).toBe(false);
    expect(code.calls.advances).toEqual([]);
    expect(result.checkpoints).toEqual([
      { repository_id: repoA, outcome: 'blocked', previous_commit: PRIOR, current_commit: PRIOR },
      { repository_id: repoB, outcome: 'blocked', previous_commit: PRIOR, current_commit: PRIOR },
    ]);
  });

  test('checkpoint steps: no head is never advanced; refused compare-and-set is warned', async () => {
    const unborn = uuidv7();
    const moved = uuidv7();
    const { store } = fakeStore(new Map());
    const code = fakeCodeMemory({
      advance: (input) => (input.repository_id === moved ? 'head_mismatch' : 'advanced'),
    });
    const result = await createDriftApplier({ store, codeMemory: code.codeMemory }).applyReport({
      report: { drifted: [] },
      checkpoints: [...basis(unborn, null), ...basis(moved)],
    });
    expect(result.checkpoints.map((step) => step.outcome)).toEqual(['no_head', 'head_mismatch']);
    expect(code.calls.advances.map((call) => call.repository_id)).toEqual([moved]);
    expect(result.warnings.join('\n')).toContain('head_mismatch');
  });

  test('inputs are validated at the boundary', async () => {
    const { store } = fakeStore(new Map());
    const applier = createDriftApplier({ store, codeMemory: fakeCodeMemory().codeMemory });
    await expect(applier.applyReport({ report: { drifted: [] }, checkpoints: [], actor: '' })).rejects.toThrow();
    await expect(
      applier.applyReport({
        report: {
          drifted: [
            {
              memory_id: uuidv7(),
              changed_paths: ['x.ts'],
              refs: [{ repository_id: uuidv7(), path: '../escape.ts', reason: 'content_changed' }],
            },
          ],
        },
        checkpoints: [],
      }),
    ).rejects.toThrow();
    await expect(
      applier.applyReport({
        report: { drifted: [] },
        checkpoints: [{ repository_id: uuidv7(), head_commit: 'HEAD', last_ingested_commit: null }],
      }),
    ).rejects.toThrow();
    await expect(applier.apply({ project_id: 'not-a-uuid' })).rejects.toThrow();
  });
});
