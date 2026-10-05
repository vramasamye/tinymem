/**
 * Minimal re-index (M4f) over REAL embedded storage with the extraction pipeline and the
 * filesystem read stubbed. These tests pin the Phase 2 DoD directly:
 *
 * - only drifted paths are re-read/re-extracted — unchanged files cost zero extraction work;
 * - a stale memory whose re-read content reproduces its knowledge goes `stale → active` (audited
 *   `restored`) with its refs re-recorded against the current blobs;
 * - a stale memory the drifted file now states differently is superseded (audited) by the freshly
 *   extracted candidate, which is tracked against the current blob;
 * - knowledge that cannot be reproduced stays `stale` (`deferred`) — never a silent un-stale;
 * - a degraded extractor is an honest warning, not an error;
 * - the architecture digest is persisted with provenance and refreshed only when it changed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installNetworkGuard } from '@onememory/security';
import { createEmbeddedDb } from '@onememory/storage';
import type { OnememoryStorage } from '@onememory/storage';
import {
  uuidv7,
  type CodeMemoryStore,
  type ExtractedMemory,
  type ExtractionInput,
  type Extractor,
} from '@onememory/core';

import {
  createReindexer,
  type ReindexResult,
  type ReindexStore,
} from './index';
import type { SkippedSymbolFile, SymbolTable } from './index';
import { candidate, classifyAs, emptySymbolTable, scriptedExtractor } from './testing';

let guard: ReturnType<typeof installNetworkGuard>;

const BLOB_A = 'a'.repeat(40);
const BLOB_B_OLD = 'b'.repeat(40);
const BLOB_B_NEW = 'c'.repeat(40);

function snapshot(files: Record<string, string>, capturedAt: string): Parameters<OnememoryStorage['codeMemory']['saveSnapshot']>[1] {
  return {
    root_path: '',
    head_commit: null,
    hash_algorithm: 'git-sha1',
    mode: 'git',
    exclusion_globs: [],
    captured_at: capturedAt,
    files: Object.entries(files).map(([path, blob_sha]) => ({
      path,
      tier: 'worktree' as const,
      blob_sha,
      mode: '100644' as const,
    })),
    skipped: [],
  };
}

const classify = classifyAs('semantic');

interface Harness {
  storage: OnememoryStorage;
  projectId: string;
  repositoryId: string;
  root: string;
  sourceId: string;
  memoryB: string;
  memoryA: string;
  readCalls: string[];
  symbolCalls: string[][];
  insertMemory(content: string, paths: string[], stale: boolean): Promise<string>;
  run(script: (input: ExtractionInput) => ExtractedMemory[], options?: { enqueueReEmbed?: boolean; extractor?: Extractor; extractSymbols?: (root: string, options: { files: string[] }) => Promise<SymbolTable>; readText?: (root: string, path: string, maxBytes: number) => Promise<{ source: string } | SkippedSymbolFile>; store?: ReindexStore; codeMemory?: CodeMemoryStore }): Promise<ReindexResult>;
}

let cleanups: Array<() => Promise<void>> = [];
beforeEach(() => {
  cleanups = [];
  guard = installNetworkGuard();
});
afterEach(async () => {
  guard.restore();
  for (const step of cleanups.reverse()) await step();
  cleanups = [];
});

async function harness(): Promise<Harness> {
  const dataDir = await mkdtemp(join(tmpdir(), 'onemem-reindex-db-'));
  const root = await mkdtemp(join(tmpdir(), 'onemem reindex '));
  const storage = await createEmbeddedDb(dataDir);
  cleanups.push(async () => {
    await storage.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  });

  const project = await storage.store.createProject({ name: `reindex-${uuidv7().slice(0, 8)}`, root_path: root });
  const repository = await storage.codeMemory.ensureRepository({ project_id: project.id, root_path: root });
  const source = await storage.store.createSource({
    kind: 'explicit',
    uri: `conversation/${uuidv7()}`,
    title: 'fixture',
    project_id: project.id,
  });

  const readCalls: string[] = [];
  const symbolCalls: string[][] = [];

  const insertMemory = async (content: string, paths: string[], stale: boolean): Promise<string> => {
    const inserted = await storage.store.insertMemory({
      type: 'semantic',
      importance: 0.7,
      confidence: 0.8,
      content,
      observed_at: '2026-10-01T00:00:00.000Z',
      source_id: source.id,
      evidence: [{ source_id: source.id, kind: 'message', locator: 'session.jsonl:1', excerpt: content }],
      extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
      project_id: project.id,
    });
    if (inserted.outcome !== 'inserted') throw new Error('fixture memory was not inserted');
    if (stale) {
      await storage.store.updateMemoryStatus(inserted.memory.id, 'stale', {
        actor: 'job:drift_scan',
        reason: 'code_drift',
      });
    }
    await storage.codeMemory.recordCodeRefs({
      memory_id: inserted.memory.id,
      repository_id: repository.id,
      refs: paths.map((path) => ({ path, blob_sha: path === 'b.ts' ? BLOB_B_OLD : BLOB_A })),
    });
    return inserted.memory.id;
  };

  // Baseline: a.ts unchanged, b.ts will drift.
  const baseline = snapshot({ 'a.ts': BLOB_A, 'b.ts': BLOB_B_OLD }, '2026-10-01T00:00:00.000Z');
  await storage.codeMemory.saveSnapshot(repository.id, { ...baseline, root_path: root });

  const memoryB = await insertMemory('We chose PGlite over SQLite for embedded storage.', ['b.ts'], true);
  const memoryA = await insertMemory('The retrieval engine fuses lexical and vector channels.', ['a.ts'], false);

  // The drifting capture: b.ts content changed, a.ts untouched.
  await storage.codeMemory.saveSnapshot(repository.id, {
    ...snapshot({ 'a.ts': BLOB_A, 'b.ts': BLOB_B_NEW }, '2026-10-02T00:00:00.000Z'),
    root_path: root,
  });

  return {
    storage,
    projectId: project.id,
    repositoryId: repository.id,
    root,
    sourceId: source.id,
    memoryB,
    memoryA,
    readCalls,
    symbolCalls,
    insertMemory,
    async run(script, options = {}) {
      const reindexer = createReindexer({
        store: options.store ?? storage.store,
        codeMemory: options.codeMemory ?? storage.codeMemory,
        jobs: storage.jobs,
        extractor: options.extractor ?? scriptedExtractor(script),
        classify,
        ...(options.enqueueReEmbed === undefined ? {} : { enqueueReEmbed: options.enqueueReEmbed }),
        now: () => new Date('2026-10-09T00:00:00.000Z'),
        readText:
          options.readText ??
          (async (_root, path) => {
            readCalls.push(path);
            return { source: `${path} current content: we chose PGlite over SQLite for embedded storage` };
          }),
        extractSymbols:
          options.extractSymbols ??
          (async (symbolRoot, opts) => {
            symbolCalls.push(opts.files);
            return emptySymbolTable(symbolRoot, opts.files);
          }),
      });
      return reindexer.reindex({ project_id: project.id });
    },
  };
}

describe('re-index: only drifted paths cost work', () => {
  test('re-reads and re-extracts exactly the drifted path; the unchanged file is untouched', async () => {
    const h = await harness();
    const result = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')]);

    expect(h.readCalls).toEqual(['b.ts']);
    expect(h.symbolCalls).toEqual([['b.ts']]);
    expect(result.drifted_paths).toEqual(['b.ts']);
    expect(result.extraction_inputs).toBe(1);

    // The memory over the unchanged file keeps its status and audit trail.
    const untouched = await h.storage.store.getMemory(h.memoryA);
    expect(untouched?.status).toBe('active');
    expect(await h.storage.store.listMemoryEvents(h.memoryA)).toHaveLength(1);
  });

  test('reproduces the memory content → audited stale → active refresh with refs re-recorded', async () => {
    const h = await harness();
    const result = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')]);

    expect(result.refreshed).toBe(1);
    expect(result.superseded).toBe(0);
    const memory = await h.storage.store.getMemory(h.memoryB);
    expect(memory?.status).toBe('active');

    const refs = await h.storage.codeMemory.listCodeRefs(h.repositoryId, { paths: ['b.ts'] });
    expect(refs.find((ref) => ref.memory_id === h.memoryB)?.blob_sha).toBe(BLOB_B_NEW);

    const events = await h.storage.store.listMemoryEvents(h.memoryB);
    const restored = events.find((event) => event.action === 'restored');
    expect(restored?.actor).toBe('job:reindex');
    expect(restored?.from_status).toBe('stale');
    expect(restored?.to_status).toBe('active');

    // A second pass is a no-op: the ref now matches the current blob, so drift reports nothing.
    const second = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')]);
    expect(second.memories).toHaveLength(0);
    expect(second.digest?.outcome).toBe('unchanged');
  });

  test('different knowledge of the same type → audited supersede, winner tracked on the new blob', async () => {
    const h = await harness();
    const result = await h.run((input) => [candidate(input, 'Embedded storage moved to DuckDB this quarter.')]);

    expect(result.superseded).toBe(1);
    const loser = await h.storage.store.getMemory(h.memoryB);
    expect(loser?.status).toBe('superseded');

    const winnerId = result.memories[0]?.winner_id;
    expect(winnerId).toBeString();
    const winner = await h.storage.store.getMemory(winnerId!);
    expect(winner?.status).toBe('active');
    expect(winner?.content).toBe('Embedded storage moved to DuckDB this quarter.');
    expect(winner?.tags).toContain('code_reindex');
    expect(winner?.provenance.evidence[0]?.locator).toBe('file:b.ts');

    const refs = await h.storage.codeMemory.listCodeRefs(h.repositoryId, { paths: ['b.ts'] });
    expect(refs.find((ref) => ref.memory_id === winnerId)?.blob_sha).toBe(BLOB_B_NEW);
  });

  test('nothing reproducible → the memory stays stale and is reported deferred', async () => {
    const h = await harness();
    const result = await h.run(() => []);

    expect(result.deferred).toBe(1);
    expect(result.refreshed).toBe(0);
    expect((await h.storage.store.getMemory(h.memoryB))?.status).toBe('stale');
  });

  test('a failing extractor degrades to a warning, never an error', async () => {
    const h = await harness();
    const failing: Extractor = {
      async extract() {
        throw new Error('extractor unavailable (offline)');
      },
    };
    const result = await h.run(() => [], { extractor: failing });

    expect(result.warnings.some((warning) => warning.includes('extraction degraded'))).toBe(true);
    expect((await h.storage.store.getMemory(h.memoryB))?.status).toBe('stale');
  });

  test('a failing symbol extraction degrades to a warning and still re-indexes text', async () => {
    const h = await harness();
    const result = await h.run(
      (input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')],
      {
        extractSymbols: async () => {
          throw new Error('tree-sitter runtime unavailable');
        },
      },
    );

    expect(result.warnings.some((warning) => warning.includes('symbol re-extraction degraded'))).toBe(true);
    expect(result.refreshed).toBe(1);
  });

  test('an unreadable drifted path is skipped honestly and defers the memory', async () => {
    const h = await harness();
    const result = await h.run(() => [], {
      readText: async () => ({ path: 'b.ts', reason: 'binary' }),
    });

    expect(result.warnings.some((warning) => warning.includes('is binary'))).toBe(true);
    expect(result.deferred).toBe(1);
    expect((await h.storage.store.getMemory(h.memoryB))?.status).toBe('stale');
  });
});

describe('re-index: re-embedding changed content', () => {
  test('enqueues re_embed for refreshed content only when an embedder is registered', async () => {
    const h = await harness();
    const result = await h.run(
      (input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')],
      { enqueueReEmbed: true },
    );

    expect(result.re_embed_jobs).toBeGreaterThan(0);
    const claimed = await h.storage.jobs.claim({ claimant: 'test', limit: 10 });
    const embedJob = claimed.find((job) => job.kind === 're_embed');
    expect(embedJob).toBeDefined();
    expect(embedJob?.payload.reason).toBe('backfill');
  });

  test('does not enqueue re_embed when no embedder is registered', async () => {
    const h = await harness();
    const result = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')]);
    expect(result.re_embed_jobs).toBe(0);
  });
});

describe('re-index: refresh failure safety', () => {
  test('a failed status write leaves the refs un-re-recorded — the drift oracle still sees the memory', async () => {
    const h = await harness();
    const result = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')], {
      store: {
        ...h.storage.store,
        updateMemoryStatus: async () => {
          throw new Error('status write failed');
        },
      },
    });

    expect(result.memories[0]?.outcome).toBe('failed');
    expect(result.memories[0]?.error).toContain('status write failed');
    // The memory stays stale AND its refs still name the OLD blob, so the next drift scan
    // reports it again — a failed refresh degrades into a retry, never a permanently stale
    // memory whose refs quietly match current state.
    expect((await h.storage.store.getMemory(h.memoryB))?.status).toBe('stale');
    const refs = await h.storage.codeMemory.listCodeRefs(h.repositoryId, { paths: ['b.ts'] });
    expect(refs.find((ref) => ref.memory_id === h.memoryB)?.blob_sha).toBe(BLOB_B_OLD);
  });

  test('a failed ref re-record after a successful status change degrades safely', async () => {
    const h = await harness();
    const result = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')], {
      codeMemory: {
        ...h.storage.codeMemory,
        recordCodeRefs: async () => {
          throw new Error('ref write failed');
        },
      },
    });

    expect(result.memories[0]?.outcome).toBe('failed');
    expect(result.memories[0]?.error).toContain('ref write failed');
    // The audited stale → active change happened FIRST, so the memory is current knowledge…
    expect((await h.storage.store.getMemory(h.memoryB))?.status).toBe('active');
    // …but its refs still name the old blob, so the next drift scan re-marks it stale and the
    // next re-index retries the refresh. Self-healing, never silent.
    const refs = await h.storage.codeMemory.listCodeRefs(h.repositoryId, { paths: ['b.ts'] });
    expect(refs.find((ref) => ref.memory_id === h.memoryB)?.blob_sha).toBe(BLOB_B_OLD);
  });
});

describe('re-index: architecture digest', () => {
  test('persists a project digest memory with provenance, and leaves it unchanged when identical', async () => {
    const h = await harness();
    const result = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')]);

    expect(result.digest?.outcome).toBe('created');
    expect(result.digest?.tokens).toBeLessThan(300);

    const current = await h.storage.store.queryCurrent({
      project_id: h.projectId,
      types: ['semantic'],
      limit: 50,
    });
    const digest = current.find((memory) => memory.subtype === 'project_digest');
    expect(digest).toBeDefined();
    expect(digest?.tags).toContain('architecture_digest');
    expect(digest?.provenance.source.kind).toBe('file');
    expect(digest?.provenance.evidence.length).toBeGreaterThan(0);
    expect(digest?.content).toBe(result.digest?.text);

    const second = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')]);
    expect(second.digest?.outcome).toBe('unchanged');
    expect(second.digest?.memory_id).toBe(digest?.id);
  });

  test('supersedes the digest when the code shape changes', async () => {
    const h = await harness();
    const first = await h.run(() => []);
    expect(first.digest?.outcome).toBe('created');

    // A new file lands: the digest text changes and must be superseded, not duplicated.
    await h.storage.codeMemory.saveSnapshot(h.repositoryId, {
      ...snapshot({ 'a.ts': BLOB_A, 'b.ts': BLOB_B_NEW, 'c.ts': 'e'.repeat(40) }, '2026-10-03T00:00:00.000Z'),
      root_path: h.root,
    });
    const second = await h.run(() => []);
    expect(second.digest?.outcome).toBe('refreshed');

    const current = await h.storage.store.queryCurrent({ project_id: h.projectId, types: ['semantic'], limit: 50 });
    expect(current.filter((memory) => memory.subtype === 'project_digest')).toHaveLength(1);
  });

  test('locates the unchanged digest deterministically — no recency window', async () => {
    const h = await harness();
    const first = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')]);
    expect(first.digest?.outcome).toBe('created');
    const digestId = first.digest?.memory_id;
    expect(digestId).toBeString();

    // Bury the digest: 1 100 newer semantic memories push it past ANY queryCurrent window
    // (the Store port's limit maximum is 1 000, ordered observed_at DESC) — the exact "long
    // unchanged digest in a busy project" case that must not degrade the outcome.
    for (let index = 0; index < 1_100; index += 1) {
      const inserted = await h.storage.store.insertMemory({
        type: 'semantic',
        importance: 0.5,
        confidence: 0.5,
        content: `filler observation ${index}`,
        observed_at: `2026-11-01T00:00:00.000Z`,
        source_id: h.sourceId,
        evidence: [{ source_id: h.sourceId, kind: 'message', locator: 'session.jsonl:1', excerpt: 'filler' }],
        extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
        project_id: h.projectId,
      });
      if (inserted.outcome !== 'inserted') throw new Error(`filler ${index} was not inserted`);
    }

    const second = await h.run((input) => [candidate(input, 'We chose PGlite over SQLite for embedded storage.')]);
    // The Store's own exact-dedupe probe (findDuplicate) finds the digest regardless of age —
    // never the insert path, never a mislabeled duplicate as a fresh creation.
    expect(second.digest?.outcome).toBe('unchanged');
    expect(second.digest?.memory_id).toBe(digestId);

    // And the digest row itself is still the one current digest (read by id — windowless).
    const digestRow = await h.storage.store.getMemory(digestId!);
    expect(digestRow?.subtype).toBe('project_digest');
    expect(digestRow?.status).toBe('active');
    expect(digestRow?.valid_until ?? null).toBeNull();
  }, 60_000);
});
