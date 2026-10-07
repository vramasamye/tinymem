/**
 * The Markdown export service against real embedded storage (ADR-0013 §5): the one surface the
 * CLI (and later the REST routes) share — page the project's durable memories through the
 * canonical read path, render the deterministic tree with the core renderer, write it under the
 * resolved root, and prune exactly the files the export owns (marker-bearing), never the
 * operator's own files. The DB stays canonical: this service only writes, nothing reads the
 * export back.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { projectDigestEntriesOf, type MemoryRecord, type NewMemory } from '@onememory/core';
import { renderDefaultConfigYaml } from '@onememory/config';
import { digestRepo } from '@onememory/storage';

import { BackendError, openRuntime, type OnememoryRuntime } from './index';
import { exportProject, type ExportProjectReport } from './export-service';

const BASE_TIME = '2026-10-06T14:03:11.000Z';

let runtime: OnememoryRuntime;
let root: string;
let projectId: string;
let otherProjectId: string;
let sourceId: string;
let seedCount = 0;

beforeAll(async () => {
  root = join(
    process.env.TMPDIR ?? '/tmp',
    `onemem-export-service-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(join(root, '.onememory'), { recursive: true });
  writeFileSync(join(root, '.onememory', 'onememory.yaml'), renderDefaultConfigYaml(), 'utf8');
  runtime = await openRuntime({ cwd: root, env: {}, startWorker: false });
  projectId = (await runtime.storage.store.createProject({ name: 'export-fixture', root_path: root })).id;
  otherProjectId = (
    await runtime.storage.store.createProject({ name: 'elsewhere', root_path: join(root, 'elsewhere') })
  ).id;
  sourceId = (
    await runtime.storage.store.createSource({
      kind: 'explicit',
      uri: 'conversation/session/export-fixture',
      title: 'export service fixture',
      project_id: projectId,
    })
  ).id;
  await digestRepo.updateProjectDigest(runtime.storage.client, projectId, {
    ...projectDigestEntriesOf({
      decisions: ['Adopt pgvector for similarity search.'],
      failures: ['OOM on deploy → raise the memory limit'],
      procedures: [],
    }),
  });
});

afterAll(async () => {
  await runtime.close();
  rmSync(root, { recursive: true, force: true });
});

interface SeedInput {
  project?: string;
  type: 'decision' | 'failure' | 'episodic';
  title?: string;
  content: string;
  payload?: NewMemory['payload'];
}

async function seedDurable(input: SeedInput): Promise<MemoryRecord> {
  seedCount += 1;
  const { memory } = await runtime.storage.store.insertMemory({
    project_id: input.project ?? projectId,
    type: input.type,
    ...(input.title === undefined ? {} : { title: input.title }),
    content: input.content,
    importance: 0.7,
    confidence: 0.8,
    observed_at: `2026-10-06T14:03:${String(10 + seedCount).padStart(2, '0')}.000Z`,
    source_id: sourceId,
    evidence: [
      {
        source_id: sourceId,
        kind: 'message',
        locator: `session.jsonl:${100 + seedCount}`,
        excerpt: 'we decided to adopt pgvector',
      },
    ],
    extraction: { method: 'heuristic', prompt_version: 'v1' },
    ...(input.payload === undefined ? {} : { payload: input.payload }),
  });
  return memory;
}

async function rejection(promise: Promise<unknown>): Promise<BackendError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(BackendError);
    return error as BackendError;
  }
  throw new Error('expected a rejection');
}

function walkFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? walkFiles(full) : [full];
  });
}

describe('exportProject', () => {
  test('writes the ADR-0013 tree under --dir with a faithful, project-scoped report', async () => {
    const decision = await seedDurable({
      type: 'decision',
      title: 'Adopt pgvector for similarity search',
      content: 'Use pgvector for the vector channel on the server profile.',
      payload: {
        title: 'Adopt pgvector for similarity search',
        decision: 'Use pgvector for the vector channel on the server profile.',
        alternatives: [{ option: 'pgvector' }, { option: 'Qdrant', why_rejected: 'a second system to run' }],
        rationale: 'One store, one dialect (ADR-0002).',
        participants: [],
        decided_at: BASE_TIME,
        status: 'accepted',
      },
    });
    const failure = await seedDurable({
      type: 'failure',
      title: 'OOM on deploy',
      content: 'Deploys OOMed in the 2GB container until the limit was raised.',
      payload: {
        problem: 'Deploys OOMed in the 2GB container.',
        context: 'Docker deploy with a 2GB memory limit.',
        root_cause: 'The indexer peak sat above the limit.',
        solution: 'Raise the limit to 4GB.',
        verification: 'Deploy succeeded after the raise.',
        status: 'verified',
        signature_hash: 'sha256:oom-deploy',
        first_seen_at: BASE_TIME,
        last_seen_at: BASE_TIME,
        occurrence_count: 3,
      },
    });
    await seedDurable({ type: 'episodic', content: 'Shipped the invoice export surface.' });
    await seedDurable({ project: otherProjectId, type: 'episodic', content: 'other-project memory must not leak' });

    const out = join(root, 'out');
    const report: ExportProjectReport = await exportProject(runtime, { project_id: projectId, dir: out });

    expect(report).toMatchObject({
      project_id: projectId,
      root: out,
      root_source: 'flag',
      memories: 3,
      by_type: { decision: 1, episodic: 1, failure: 1 },
      files_written: 7,
      files_pruned: 0,
    });

    const index = readFileSync(join(out, 'MEMORY.md'), 'utf8');
    expect(index).toContain('# export-fixture memory');
    expect(index).toContain('## Settled decisions');
    expect(index).toContain('- Adopt pgvector for similarity search.');
    expect(index).toContain('- [decisions (1)](decisions.md)');
    expect(index).not.toContain('other-project memory must not leak');

    const decisionFile = readFileSync(join(out, 'memories', 'decision', `${decision.id}.md`), 'utf8');
    expect(decisionFile).toContain(`id: ${decision.id}`);
    expect(decisionFile).toContain('source: conversation/session/export-fixture');
    expect(decisionFile).toContain('- Qdrant (rejected: a second system to run)');
    expect(decisionFile).toContain('"we decided to adopt pgvector" (message, session.jsonl:101)');

    const failureFile = readFileSync(join(out, 'memories', 'failure', `${failure.id}.md`), 'utf8');
    expect(failureFile).toContain('## Occurrences');
    expect(failureFile).toContain('3');
  });

  test('is idempotent and prunes only owned files (operator files are untouchable)', async () => {
    const out = join(root, 'out');
    const operatorNotes = join(out, 'NOTES.md');
    writeFileSync(operatorNotes, 'operator notes — the export must never touch this file', 'utf8');
    const staleFile = join(out, 'memories', 'episodic', '0eadbeef-0ead-4ead-8ead-0eadbeef0ead.md');
    writeFileSync(staleFile, '---\nonememory-export: true\n---\nstale owned file', 'utf8');

    const stableBefore = new Map<string, string>();
    for (const abs of walkFiles(out)) {
      if (abs === staleFile || abs === operatorNotes) continue;
      stableBefore.set(abs.slice(out.length + 1), readFileSync(abs, 'utf8'));
    }

    const second = await exportProject(runtime, { project_id: projectId, dir: out });
    expect(second.files_written).toBe(7);
    expect(second.files_pruned).toBe(1);
    expect(existsSync(staleFile)).toBeFalse();
    expect(readFileSync(operatorNotes, 'utf8')).toBe('operator notes — the export must never touch this file');
    for (const [relative, content] of stableBefore) {
      expect(readFileSync(join(out, relative), 'utf8')).toBe(content);
    }
  });

  test('defaults to <project root>/memory and fails closed on an unknown project', async () => {
    const defaulted = await exportProject(runtime, { project_id: projectId });
    expect(defaulted.root).toBe(join(root, 'memory'));
    expect(defaulted.root_source).toBe('project');
    expect(existsSync(join(root, 'memory', 'MEMORY.md'))).toBeTrue();

    const error = await rejection(exportProject(runtime, { project_id: '0eadbeef-0ead-4ead-8ead-0eadbeef0ead' }));
    expect(error.code).toBe('not_found');
  });

  test('resolves the configured export dir; ~/ roots against the injected HOME; the flag wins', async () => {
    const home = join(root, 'home');
    const dir = join(root, 'cfg-project');
    mkdirSync(join(dir, '.onememory'), { recursive: true });
    writeFileSync(
      join(dir, '.onememory', 'onememory.yaml'),
      renderDefaultConfigYaml().replace('export: {}', 'export:\n  dir: ~/onemem-exports'),
      'utf8',
    );
    const cfgRuntime = await openRuntime({ cwd: dir, env: {}, startWorker: false });
    const cfgProject = await cfgRuntime.storage.store.createProject({ name: 'configured', root_path: dir });
    const cfgSource = await cfgRuntime.storage.store.createSource({
      kind: 'explicit',
      uri: 'conversation/session/configured',
      title: 'configured export fixture',
      project_id: cfgProject.id,
    });
    await cfgRuntime.storage.store.insertMemory({
      project_id: cfgProject.id,
      type: 'episodic',
      content: 'Configured-dir fixture memory.',
      importance: 0.5,
      confidence: 0.6,
      observed_at: BASE_TIME,
      source_id: cfgSource.id,
      evidence: [{ source_id: cfgSource.id, kind: 'message', locator: 'session.jsonl:1', excerpt: 'fixture' }],
      extraction: { method: 'heuristic', prompt_version: 'v1' },
    });

    const flagged = await exportProject(cfgRuntime, {
      project_id: cfgProject.id,
      dir: join(dir, 'flagged'),
      home,
    });
    expect(flagged.root).toBe(join(dir, 'flagged'));
    expect(flagged.root_source).toBe('flag');

    const configured = await exportProject(cfgRuntime, { project_id: cfgProject.id, home });
    expect(configured.root).toBe(join(home, 'onemem-exports'));
    expect(configured.root_source).toBe('config');
    expect(existsSync(join(home, 'onemem-exports', 'episodic.md'))).toBeTrue();

    await cfgRuntime.close();
  });
});
