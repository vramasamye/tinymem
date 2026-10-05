/**
 * The doctor's code-memory / drift section (M4f): statuses follow the doctor's honesty contract
 * (warn = degraded-but-usable, fail = unusable), the section is counted by `finalizeDoctorReport`
 * like every other check, it never claims `info` (the informational count stays owned by the
 * runtime-wiring group), a store failure fails the SECTION instead of killing the report, and
 * digest presence is probed deterministically instead of scavenged from a recency window.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { ProjectStateSchema, renderDefaultConfigYaml, saveProjectState } from '@onememory/config';
import { uuidv7 } from '@onememory/core';

import {
  codeMemoryCheck,
  inspectRuntime,
  openRuntime,
  type DoctorReport,
  type OnememoryRuntime,
} from './index';

const PROJECT_ID = uuidv7();
const DIGEST_MEMORY_ID = uuidv7();

function fakeRuntime(options: {
  projectId?: string | null;
  repositories?: Array<{ id: string; last_indexed_at: string | null }>;
  refs?: number;
  stale?: number;
  /** The Store's exact-dedupe probe returns the current digest row (deterministic presence). */
  digestCurrent?: boolean;
  findDuplicateThrows?: boolean;
  queryCurrentThrows?: boolean;
  schedulerRunning?: boolean;
  listRepositoriesThrows?: boolean;
}): OnememoryRuntime {
  const repositories = options.repositories ?? [];
  const repositoryId = repositories[0]?.id ?? uuidv7();
  const fingerprint = (path: string) => ({
    repository_id: repositoryId,
    path,
    tier: 'worktree',
    blob_sha: 'f'.repeat(40),
    file_mode: '100644',
    last_seen_commit: null,
    symbols_hash: 'd'.repeat(64),
    updated_at: '2026-10-01T00:00:00.000Z',
  });
  const symbol = (path: string, name: string) => ({
    repository_id: repositoryId,
    path,
    name,
    kind: 'function',
    signature: `${name}()`,
    line_start: 1,
    line_end: 2,
    span_hash: 'a'.repeat(64),
    updated_at: '2026-10-01T00:00:00.000Z',
  });
  const digestRow = {
    id: DIGEST_MEMORY_ID,
    type: 'semantic',
    subtype: 'project_digest',
    status: 'active',
    tags: ['architecture_digest', 'project_digest', 'code_memory'],
    valid_until: null,
  };
  return {
    code_memory: {
      scheduler_running: options.schedulerRunning ?? false,
      scheduler_interval_ms: 300_000,
      project_id: options.projectId === undefined ? PROJECT_ID : options.projectId,
      status: () => ({ project_id: PROJECT_ID, last_drift_scan_at: null, last_reindex_at: null }),
      runDriftScan: async () => {
        throw new Error('unused in this test');
      },
      runReindex: async () => {
        throw new Error('unused in this test');
      },
    },
    storage: {
      codeMemory: {
        listRepositories: async () => {
          if (options.listRepositoriesThrows === true) throw new Error('storage gone');
          return repositories;
        },
        listCodeRefs: async () => new Array(options.refs ?? 0).fill({}),
        loadFingerprints: async () => [fingerprint('src/engine.ts'), fingerprint('src/cli.ts')],
        loadSymbols: async () => [symbol('src/engine.ts', 'createEngine'), symbol('src/cli.ts', 'main')],
      },
      store: {
        findDuplicate: async () => {
          if (options.findDuplicateThrows === true) throw new Error('dedupe probe failed');
          return options.digestCurrent === true ? digestRow : null;
        },
        queryCurrent: async () => {
          if (options.queryCurrentThrows === true) throw new Error('store gone');
          return new Array(options.stale ?? 0).fill({ status: 'stale', subtype: undefined });
        },
      },
    },
  } as unknown as OnememoryRuntime;
}

describe('codeMemoryCheck', () => {
  test('no registered project → warn (code memory is inactive)', async () => {
    const result = await codeMemoryCheck(fakeRuntime({ projectId: null }));
    expect(result.id).toBe('code-memory');
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('no project is registered');
  });

  test('project without a repository → warn, never info', async () => {
    const result = await codeMemoryCheck(fakeRuntime({ repositories: [] }));
    expect(result.status).toBe('warn');
    expect(result.status).not.toBe('info');
    expect(result.detail).toContain('no code repository is registered');
  });

  test('a storage failure is a fail with a remediation', async () => {
    const result = await codeMemoryCheck(fakeRuntime({ listRepositoriesThrows: true }));
    expect(result.status).toBe('fail');
    expect(result.remediation).toBeDefined();
  });

  test('a failing current-memory or digest lookup fails the check — never the report', async () => {
    const repositories = [{ id: uuidv7(), last_indexed_at: '2026-10-05T00:00:00.000Z' }];
    const queryFailure = await codeMemoryCheck(fakeRuntime({ repositories, queryCurrentThrows: true }));
    expect(queryFailure.id).toBe('code-memory');
    expect(queryFailure.status).toBe('fail');
    expect(queryFailure.detail).toContain('store gone');
    expect(queryFailure.remediation).toBeDefined();

    const probeFailure = await codeMemoryCheck(fakeRuntime({ repositories, findDuplicateThrows: true }));
    expect(probeFailure.status).toBe('fail');
    expect(probeFailure.detail).toContain('dedupe probe failed');
  });

  test('digest presence is probed deterministically — a window that misses it cannot lie', async () => {
    // queryCurrent sees NOTHING (the digest is older than any recency window in a busy project);
    // the exact-dedupe probe still finds it, so the section reports it present and current.
    const result = await codeMemoryCheck(
      fakeRuntime({
        repositories: [{ id: uuidv7(), last_indexed_at: '2026-10-05T00:00:00.000Z' }],
        digestCurrent: true,
        schedulerRunning: true,
      }),
    );
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('architecture digest present and current');
    expect(result.detail).toContain('tokens');
    expect(result.detail).not.toContain('not built');
  });

  test('a digest that does not match the current code shape is reported honestly', async () => {
    const result = await codeMemoryCheck(
      fakeRuntime({
        repositories: [{ id: uuidv7(), last_indexed_at: '2026-10-05T00:00:00.000Z' }],
        digestCurrent: false,
        schedulerRunning: true,
      }),
    );
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('architecture digest not found for the current code shape');
  });

  test('an armed scheduler over a registered repository → pass with the drift summary', async () => {
    const result = await codeMemoryCheck(
      fakeRuntime({
        repositories: [{ id: uuidv7(), last_indexed_at: '2026-10-05T00:00:00.000Z' }],
        refs: 4,
        stale: 1,
        digestCurrent: true,
        schedulerRunning: true,
      }),
    );
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('1 repository(ies)');
    expect(result.detail).toContain('4 tracked code ref(s)');
    expect(result.detail).toContain('1 stale memor(ies)');
    expect(result.detail).toContain('architecture digest present and current');
    expect(result.detail).toContain('scheduler running every 300s');
  });

  test('a registered repository with no scheduler is degraded (direct mode)', async () => {
    const result = await codeMemoryCheck(
      fakeRuntime({ repositories: [{ id: uuidv7(), last_indexed_at: null }] }),
    );
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('scheduler not running');
    expect(result.remediation).toContain('onemem serve');
  });
});

describe('the code-memory section in a real runtime report', () => {
  let root: string;
  let runtime: OnememoryRuntime;

  /** Create the project + repository and persist project.json, then close (state is read at open). */
  async function prepareProject(dir: string): Promise<string> {
    mkdirSync(join(dir, '.onememory'), { recursive: true });
    writeFileSync(join(dir, '.onememory', 'onememory.yaml'), renderDefaultConfigYaml(), 'utf8');
    const setup = await openRuntime({ cwd: dir, env: {}, startWorker: false });
    try {
      const project = await setup.storage.store.createProject({ name: 'doctor-code', root_path: dir });
      await setup.storage.codeMemory.ensureRepository({ project_id: project.id, root_path: dir });
      saveProjectState(
        join(dir, '.onememory'),
        ProjectStateSchema.parse({
          project_id: project.id,
          name: project.name,
          root_path: dir,
          created_at: new Date().toISOString(),
        }),
      );
      return project.id;
    } finally {
      await setup.close();
    }
  }

  beforeAll(async () => {
    root = join(process.env.TMPDIR ?? '/tmp', `onemem-doctor-codememory-${Date.now()}`);
    await prepareProject(root);
    runtime = await openRuntime({ cwd: root, env: {}, startWorker: false });
  }, 30_000);

  afterAll(async () => {
    await runtime.close();
    rmSync(root, { recursive: true, force: true });
  });

  test('the report carries the code-memory check and its summary counts every check', async () => {
    const report: DoctorReport = await inspectRuntime(runtime, { probeEmbedder: false });
    const section = report.checks.find((entry) => entry.id === 'code-memory');
    expect(section).toBeDefined();
    expect(section?.status).toBe('warn'); // a registered repository, but no scheduler in direct mode
    expect(section?.detail).toContain('scheduler not running');

    const recount = {
      pass: report.checks.filter((entry) => entry.status === 'pass').length,
      warn: report.checks.filter((entry) => entry.status === 'warn').length,
      fail: report.checks.filter((entry) => entry.status === 'fail').length,
      info: [...report.checks, ...report.runtimes].filter((entry) => entry.status === 'info').length,
    };
    expect(report.summary).toEqual(recount);
    // The section never inflates the informational count (the runtime-wiring group owns it):
    // every info entry belongs to the runtimes group, however many runtimes are wired.
    expect(report.checks.filter((entry) => entry.status === 'info')).toEqual([]);
    expect(report.summary.info).toBe(report.runtimes.filter((entry) => entry.status === 'info').length);
    expect(report.runtimes.map((entry) => entry.status)).toEqual(['info', 'info', 'info']);
    expect(report.exit_code).toBe(0);
  }, 30_000);

  test('a store whose current-memory lookup fails still gets a full report with a failed section', async () => {
    // Break the two lookups only the code-memory section uses (inspectRuntime's other checks
    // read other port methods). The report must SURVIVE: a failed section, counted summary,
    // non-zero exit code — never a thrown error that leaves the user without a doctor report.
    const store = runtime.storage.store as unknown as Record<string, unknown>;
    const originalQueryCurrent = store.queryCurrent;
    const originalFindDuplicate = store.findDuplicate;
    store.queryCurrent = async () => {
      throw new Error('current memories unreadable');
    };
    store.findDuplicate = async () => {
      throw new Error('dedupe probe failed');
    };
    try {
      const report: DoctorReport = await inspectRuntime(runtime, { probeEmbedder: false });
      const section = report.checks.find((entry) => entry.id === 'code-memory');
      expect(section?.status).toBe('fail');
      expect(section?.detail).toContain('current-memory or digest lookup failed');

      const recount = {
        pass: report.checks.filter((entry) => entry.status === 'pass').length,
        warn: report.checks.filter((entry) => entry.status === 'warn').length,
        fail: report.checks.filter((entry) => entry.status === 'fail').length,
        info: [...report.checks, ...report.runtimes].filter((entry) => entry.status === 'info').length,
      };
      expect(report.summary).toEqual(recount);
      expect(report.exit_code).toBe(1);
      expect(report.status).toBe('failed');
    } finally {
      store.queryCurrent = originalQueryCurrent;
      store.findDuplicate = originalFindDuplicate;
    }
  }, 30_000);

  test('a runtime opened with the worker arms the scheduler and the section passes', async () => {
    const root2 = join(process.env.TMPDIR ?? '/tmp', `onemem-doctor-scheduler-${Date.now()}`);
    await prepareProject(root2);
    const runtime2 = await openRuntime({
      cwd: root2,
      env: {},
      startWorker: true,
      driftScanIntervalMs: 60_000,
    });
    try {
      expect(runtime2.code_memory.scheduler_running).toBe(true);
      const report = await inspectRuntime(runtime2, { probeEmbedder: false });
      const section = report.checks.find((entry) => entry.id === 'code-memory');
      expect(section?.status).toBe('pass');
      expect(section?.detail).toContain('scheduler running every 60s');
    } finally {
      await runtime2.close();
      rmSync(root2, { recursive: true, force: true });
    }
  }, 30_000);
});
