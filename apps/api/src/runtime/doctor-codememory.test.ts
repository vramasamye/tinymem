/**
 * The doctor's code-memory / drift section (M4f): statuses follow the doctor's honesty contract
 * (warn = degraded-but-usable, fail = unusable), the section is counted by `finalizeDoctorReport`
 * like every other check, and it never claims `info` (the informational count stays owned by the
 * runtime-wiring group).
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

function fakeRuntime(options: {
  projectId?: string | null;
  repositories?: Array<{ id: string; last_indexed_at: string | null }>;
  refs?: number;
  stale?: number;
  digest?: boolean;
  schedulerRunning?: boolean;
  listRepositoriesThrows?: boolean;
}): OnememoryRuntime {
  const repositories = options.repositories ?? [];
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
      },
      store: {
        queryCurrent: async () => [
          ...new Array(options.stale ?? 0).fill({ status: 'stale', subtype: undefined }),
          ...(options.digest === true ? [{ status: 'active', subtype: 'project_digest' }] : []),
        ],
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

  test('an armed scheduler over a registered repository → pass with the drift summary', async () => {
    const result = await codeMemoryCheck(
      fakeRuntime({
        repositories: [{ id: uuidv7(), last_indexed_at: '2026-10-05T00:00:00.000Z' }],
        refs: 4,
        stale: 1,
        digest: true,
        schedulerRunning: true,
      }),
    );
    expect(result.status).toBe('pass');
    expect(result.detail).toContain('1 repository(ies)');
    expect(result.detail).toContain('4 tracked code ref(s)');
    expect(result.detail).toContain('1 stale memor(ies)');
    expect(result.detail).toContain('architecture digest present');
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
    // The section never inflates the informational count (the runtime-wiring group owns it).
    expect(report.summary.info).toBe(2);
    expect(report.exit_code).toBe(0);
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
