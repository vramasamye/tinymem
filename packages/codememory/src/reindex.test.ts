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
  type ExtractedMemory,
  type ExtractionInput,
  type ExtractionResult,
  type Extractor,
} from '@onememory/core';

import { createReindexer, type ReindexClassification, type ReindexResult } from './index';
import type { SkippedSymbolFile, SymbolTable } from './index';

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

function candidate(input: ExtractionInput, content: string, type: ExtractedMemory['type'] = 'semantic_candidate'): ExtractedMemory {
  return {
    type,
    content,
    importance: 0.8,
    confidence: 0.9,
    entities: [],
    evidence: [
      { source_id: input.source.id, kind: 'event', locator: `event:${input.event.id}`, excerpt: content },
    ],
    future_value_rationale: 're-extracted from the drifted file',
  };
}

/** An extractor that derives candidates from the synthetic document text. */
function scriptedExtractor(script: (input: ExtractionInput) => ExtractedMemory[]): Extractor {
  return {
    async extract(inputs: ExtractionInput[]): Promise<ExtractionResult> {
      const memories = inputs.flatMap((input) => script(input));
      return {
        memories,
        working: [],
        extraction_meta: { method: 'heuristic', prompt_version: 'test-v1' },
      };
    },
  };
}

const classify = (): ReindexClassification => ({
  durable_type: 'semantic',
  awaiting_consolidation: false,
});

const symbolTable = (paths: string[], root: string): SymbolTable => ({
  version: 1,
  root_path: root,
  extracted_at: '2026-10-08T00:00:00.000Z',
  files: paths.map((path) => ({
    path,
    language: 'typescript',
    symbols: [],
    symbols_hash: 'd'.repeat(64),
    parse_errors: 0,
  })),
  skipped: [],
  warnings: [],
});

interface Harness {
  storage: OnememoryStorage;
  projectId: string;
  repositoryId: string;
  root: string;
  memoryB: string;
  memoryA: string;
  readCalls: string[];
  symbolCalls: string[][];
  insertMemory(content: string, paths: string[], stale: boolean): Promise<string>;
  run(script: (input: ExtractionInput) => ExtractedMemory[], options?: { enqueueReEmbed?: boolean; extractor?: Extractor; extractSymbols?: (root: string, options: { files: string[] }) => Promise<SymbolTable>; readText?: (root: string, path: string, maxBytes: number) => Promise<{ source: string } | SkippedSymbolFile> }): Promise<ReindexResult>;
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
    memoryB,
    memoryA,
    readCalls,
    symbolCalls,
    insertMemory,
    async run(script, options = {}) {
      const reindexer = createReindexer({
        store: storage.store,
        codeMemory: storage.codeMemory,
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
            return symbolTable(opts.files, symbolRoot);
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
});
