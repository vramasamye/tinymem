/**
 * The M4f orchestration loop over a REAL fixture Git repository and REAL embedded storage:
 * the scheduler enqueues `drift_scan`, the scan captures + applies drift (audited stale +
 * checkpoint advance) and chains `reindex`, and the re-index refreshes the stale memory and
 * persists the architecture digest — re-reading ONLY the drifted path. This is the Phase 2 DoD
 * loop the M4 primitives were waiting for, run under the network guard (zero model calls).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { installNetworkGuard } from '@onememory/security';
import { createEmbeddedDb } from '@onememory/storage';
import type { OnememoryStorage } from '@onememory/storage';
import { uuidv7 } from '@onememory/core';

import {
  captureSnapshot,
  createCodeMemoryOrchestration,
  createReindexer,
} from './index';
import type { SkippedSymbolFile } from './index';
import { candidate, classifyAs, emptySymbolTable, scriptedExtractor } from './testing';

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

const DECISION_CONTENT = 'We decided to use PGlite over SQLite for embedded storage.';

let guard: ReturnType<typeof installNetworkGuard>;
let cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  guard = installNetworkGuard();
  cleanups = [];
});

afterEach(async () => {
  guard.restore();
  for (const step of cleanups.reverse()) await step();
  cleanups = [];
});

describe('code-memory orchestration over a real repository', () => {
  test('scheduler → drift_scan → stale + checkpoint → reindex refreshes only the drifted path', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'onemem-orch-db-'));
    const root = await mkdtemp(join(tmpdir(), 'onemem orch '));
    const storage = await createEmbeddedDb(dataDir);
    cleanups.push(async () => {
      await storage.close();
      await rm(dataDir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    });

    await git(root, 'init', '-q');
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'src', 'decision.ts'), 'export const choice = "PGlite";\n');
    await writeFile(join(root, 'src', 'other.ts'), 'export const untouched = true;\n');
    await commitAll(root, 'test: baseline');

    const project = await storage.store.createProject({ name: `orch-${uuidv7().slice(0, 8)}`, root_path: root });
    const source = await storage.store.createSource({
      kind: 'explicit',
      uri: `conversation/${uuidv7()}`,
      title: 'fixture',
      project_id: project.id,
    });
    const baseline = await captureSnapshot(root);
    const repository = await storage.codeMemory.ensureRepository({ project_id: project.id, root_path: baseline.root_path });
    await storage.codeMemory.saveSnapshot(repository.id, baseline);

    const inserted = await storage.store.insertMemory({
      type: 'decision',
      importance: 0.8,
      confidence: 0.8,
      content: 'We decided to use PGlite over SQLite for embedded storage.',
      observed_at: '2026-10-01T00:00:00.000Z',
      source_id: source.id,
      evidence: [{ source_id: source.id, kind: 'message', locator: 'session.jsonl:1', excerpt: 'decision' }],
      extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
      project_id: project.id,
    });
    if (inserted.outcome !== 'inserted') throw new Error('fixture memory was not inserted');
    const memoryId = inserted.memory.id;
    const baselineBlob = baseline.files.find(
      (file) => file.tier === 'worktree' && file.path === 'src/decision.ts',
    )!.blob_sha;
    await storage.codeMemory.recordCodeRefs({
      memory_id: memoryId,
      repository_id: repository.id,
      refs: [{ path: 'src/decision.ts', blob_sha: baselineBlob }],
    });

    const readCalls: string[] = [];
    const symbolCalls: string[][] = [];
    const orchestration = createCodeMemoryOrchestration({
      store: storage.store,
      codeMemory: storage.codeMemory,
      jobs: storage.jobs,
      extractor: scriptedExtractor((input) => [
        candidate(input, DECISION_CONTENT, { type: 'decision', importance: 0.9, confidence: 0.9 }),
      ]),
      classify: classifyAs('decision'),
      projectId: project.id,
      rootPath: root,
      now: () => new Date('2026-10-09T00:00:00.000Z'),
      readText: async (_root, path) => {
        readCalls.push(path);
        return { source: 'current content' } as { source: string } | SkippedSymbolFile;
      },
      extractSymbols: async (symbolRoot, options) => {
        symbolCalls.push(options.files);
        return emptySymbolTable(symbolRoot, options.files);
      },
    });

    // The scheduler pass registers the repository and enqueues exactly one drift_scan.
    const pass = await orchestration.tick();
    expect(pass.repositories).toBe(1);
    expect(pass.enqueued).toBe(1);
    const secondPass = await orchestration.tick();
    expect(secondPass.enqueued).toBe(0);
    expect(secondPass.existing).toBe(1);

    // Edit one file and commit it.
    await writeFile(join(root, 'src', 'decision.ts'), 'export const choice = "DuckDB";\n');
    const newHead = await commitAll(root, 'test: switch embedded storage');

    const scan = await orchestration.runDriftScan({ project_id: project.id, repository_id: repository.id });
    expect(scan.repositories[0]?.captured).toBe(true);
    expect(scan.repositories[0]?.head_commit).toBe(newHead);
    expect(scan.applied?.memories.some((memory) => memory.memory_id === memoryId && memory.outcome === 'marked_stale')).toBe(true);
    expect(scan.applied?.fully_processed).toBe(true);
    expect(scan.reindex_enqueued).toBe(true);

    const stale = await storage.store.getMemory(memoryId);
    expect(stale?.status).toBe('stale');
    const repositoryRow = await storage.codeMemory.getRepository(repository.id);
    expect(repositoryRow?.last_ingested_commit).toBe(newHead);

    // The re-index re-reads only the drifted path and refreshes the memory.
    const reindex = await orchestration.runReindex({ project_id: project.id });
    expect(reindex.drifted_paths).toEqual(['src/decision.ts']);
    expect(readCalls).toEqual(['src/decision.ts']);
    expect(symbolCalls).toEqual([['src/decision.ts']]);
    expect(reindex.refreshed).toBe(1);
    expect((await storage.store.getMemory(memoryId))?.status).toBe('active');
    expect(reindex.digest?.outcome).toBe('created');

    const digestMemory = (
      await storage.store.queryCurrent({ project_id: project.id, types: ['semantic'], limit: 50 })
    ).find((memory) => memory.subtype === 'project_digest');
    expect(digestMemory).toBeDefined();
    expect(digestMemory?.provenance.evidence.length).toBeGreaterThan(0);
  }, 60_000);

  test('reindex with a real extractor failure degrades to a warning, never throws', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'onemem-orch-db-'));
    const storage = await createEmbeddedDb(dataDir);
    cleanups.push(async () => {
      await storage.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const project = await storage.store.createProject({ name: 'orch-degraded' });
    const reindexer = createReindexer({
      store: storage.store,
      codeMemory: storage.codeMemory,
      jobs: storage.jobs,
      extractor: {
        async extract() {
          throw new Error('no extractor available');
        },
      },
      classify: classifyAs('decision'),
    });
    const result = await reindexer.reindex({ project_id: project.id });
    expect(result.repositories).toBe(0);
    expect(result.warnings.some((warning) => warning.includes('no repository data'))).toBe(true);
  }, 30_000);
});
