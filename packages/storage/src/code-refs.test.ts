/**
 * `listCodeRefsForMemories` (M4g2 — the retrieval read side of code refs): the ONE batched
 * query that turns `memory_code_refs` rows into hydrated search-response evidence.
 *
 * Runs on BOTH deployment profiles (ADR-0002 matrix): embedded PGlite always; the real
 * Postgres server when `ONEMEMORY_PG_URL` is set (the same skip discipline as `integration/
 * server.test.ts`, so `bun test` stays fully offline by default).
 *
 * What is pinned here:
 * - ONE round trip for any number of memories (an N+1 hydration would silently regress search
 *   latency — the counting client below fails the test if a second query runs);
 * - the commit anchor is the cited blob's own `last_seen_commit` — and only that: a drifted or
 *   fingerprint-less ref hydrates with the honest empty string, never a borrowed commit;
 * - the cited file's symbol names aggregate in DOCUMENT order (line_start, then name);
 * - rows come back ordered (memory_id, repository_id, path) so callers group deterministically.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type {
  MemoryRecord,
  SnapshotInput,
  SymbolFileInput,
  SymbolRecordInput,
} from '@onememory/core';
import { uuidv7 } from '@onememory/core';

import { createServerDb } from './drivers/server';
import type { Database } from './drivers/client';
import type { OnememoryStorage } from './drivers/types';
import {
  openEmbeddedStorage,
  seedProjectAndSource,
  makeMemory,
  type StorageHandle,
} from './integration/harness';
import { listCodeRefsForMemories, type HydratedCodeRef } from './repositories/code-memory';

const blob = (char: string): string => char.repeat(40);
const span = (char: string): string => char.repeat(64);

/** A capture fixture: worktree-tier files (the tier refs are defined against), one HEAD. */
function snapshotOf(head: string, files: Array<{ path: string; sha: string }>): SnapshotInput {
  return {
    root_path: '/tmp/fixture-repo',
    head_commit: head,
    hash_algorithm: 'git-sha1',
    mode: 'git',
    exclusion_globs: [],
    captured_at: '2026-10-01T00:00:00.000Z',
    files: files.map((file) => ({
      path: file.path,
      tier: 'worktree' as const,
      blob_sha: file.sha,
      mode: '100644' as const,
    })),
    skipped: [],
  };
}

function symbol(name: string, lineStart: number, lineEnd: number, hashChar: string): SymbolRecordInput {
  return {
    name,
    kind: 'function',
    signature: `function ${name}()`,
    line_start: lineStart,
    line_end: lineEnd,
    span_hash: span(hashChar),
  };
}

/** A query-counting Database double — the N+1 guard (exactly one round trip must happen). */
function countingClient(db: Database): { client: Database; queries: string[] } {
  const queries: string[] = [];
  const client: Database = {
    profile: db.profile,
    query: (text, params) => {
      queries.push(text);
      return db.query(text, params);
    },
    transaction: (work) => db.transaction(work),
    close: () => db.close(),
  };
  return { client, queries };
}

interface CodeRefFixture {
  memoryWithRefs: MemoryRecord;
  memoryWithoutRefs: MemoryRecord;
  repositoryId: string;
  headCommit: string;
}

/**
 * Seed a project, a repository with one capture, symbol tables, and refs on one memory (four
 * refs: two fresh, one fingerprint-less, one drifted — one exercise of every commit-anchor
 * branch) plus one memory with no refs at all.
 */
async function seedCodeRefFixture(storage: OnememoryStorage): Promise<CodeRefFixture> {
  const ctx = await seedProjectAndSource(storage, 'code-refs');
  const memoryWithRefs = (
    await storage.store.insertMemory(
      makeMemory(ctx, {
        type: 'procedural',
        content: 'Authentication procedure: verifyCredentials checks the bcrypt hash; createSession signs the JWT.',
      }),
    )
  ).memory;
  const memoryWithoutRefs = (
    await storage.store.insertMemory(makeMemory(ctx, { content: 'This project uses Bun for tests.' }))
  ).memory;

  const headCommit = blob('a');
  const repository = await storage.codeMemory.ensureRepository({
    project_id: ctx.projectId,
    root_path: '/tmp/fixture-repo',
  });
  await storage.codeMemory.saveSnapshot(
    repository.id,
    snapshotOf(headCommit, [
      { path: 'src/auth/login.ts', sha: blob('b') },
      { path: 'src/auth/session.ts', sha: blob('c') },
      { path: 'src/other.ts', sha: blob('d') },
    ]),
  );

  // Symbol tables for the cited paths — inserted OUT of document order to pin the aggregation's
  // ordering (line_start, then name). saveSymbolTable requires live worktree fingerprints, so
  // the snapshot comes first, exactly like the pipeline's order.
  const loginSymbols: SymbolFileInput = {
    path: 'src/auth/login.ts',
    language: 'typescript',
    symbols: [symbol('verifyCredentials', 20, 28, 'a'), symbol('Credentials', 8, 11, 'b')],
    symbols_hash: span('1'),
  };
  const sessionSymbols: SymbolFileInput = {
    path: 'src/auth/session.ts',
    language: 'typescript',
    symbols: [symbol('createSession', 12, 18, 'c')],
    symbols_hash: span('2'),
  };
  await storage.codeMemory.saveSymbolTable(repository.id, { files: [loginSymbols, sessionSymbols] });

  await storage.codeMemory.recordCodeRefs({
    memory_id: memoryWithRefs.id,
    repository_id: repository.id,
    refs: [
      { path: 'src/auth/login.ts', blob_sha: blob('b') }, // fresh: matches the capture
      { path: 'src/auth/session.ts', blob_sha: blob('c') }, // fresh: matches the capture
      { path: 'src/gone.ts', blob_sha: blob('e') }, // no fingerprint row at all
      { path: 'src/other.ts', blob_sha: blob('f') }, // drifted: the fingerprint says blob('d')
    ],
  });

  return {
    memoryWithRefs,
    memoryWithoutRefs,
    repositoryId: repository.id,
    headCommit,
  };
}

// ---------------------------------------------------------------------------
// Scenarios (shared verbatim by both profile suites)
// ---------------------------------------------------------------------------

/** One batched query returns the refs of many memories — never one query per memory. */
async function batchedReadScenario(storage: OnememoryStorage): Promise<void> {
  const fixture = await seedCodeRefFixture(storage);
  const { client, queries } = countingClient(storage.client);
  const rows = await listCodeRefsForMemories(client, [
    fixture.memoryWithRefs.id,
    fixture.memoryWithoutRefs.id,
  ]);
  expect(queries).toHaveLength(1);
  expect(queries[0]).toContain('memory_code_refs');
  // The memory WITH refs yields its four rows; the one without yields none — same query.
  expect(rows).toHaveLength(4);
  expect(rows.every((row) => row.memory_id === fixture.memoryWithRefs.id)).toBe(true);
}

async function emptyAndUnknownIdsScenario(storage: OnememoryStorage): Promise<void> {
  const fixture = await seedCodeRefFixture(storage);
  expect(await listCodeRefsForMemories(storage.client, [])).toEqual([]);
  const unknown = await listCodeRefsForMemories(storage.client, [uuidv7()]);
  expect(unknown).toEqual([]);
  // Sanity: the fixture's own memory still reads (the empty reads returned no rows, not errors).
  expect(
    (await listCodeRefsForMemories(storage.client, [fixture.memoryWithRefs.id])).length,
  ).toBe(4);
}

async function deterministicOrderScenario(storage: OnememoryStorage): Promise<void> {
  const fixture = await seedCodeRefFixture(storage);
  const rows = await listCodeRefsForMemories(storage.client, [fixture.memoryWithRefs.id]);
  expect(rows.map((row) => row.path)).toEqual([
    'src/auth/login.ts',
    'src/auth/session.ts',
    'src/gone.ts',
    'src/other.ts',
  ]);
}

/** The commit anchor is the cited blob's own last_seen_commit — never a guess or a loan. */
async function commitAnchorScenario(storage: OnememoryStorage): Promise<void> {
  const fixture = await seedCodeRefFixture(storage);
  const rows = await listCodeRefsForMemories(storage.client, [fixture.memoryWithRefs.id]);
  const byPath = new Map(rows.map((row) => [row.path, row]));
  // Fresh refs (blob matches the worktree fingerprint) carry the capture's HEAD.
  expect(byPath.get('src/auth/login.ts')?.commit_sha).toBe(fixture.headCommit);
  expect(byPath.get('src/auth/session.ts')?.commit_sha).toBe(fixture.headCommit);
  // A fingerprint-less path and a drifted path hydrate with the honest empty string.
  expect(byPath.get('src/gone.ts')?.commit_sha).toBe('');
  expect(byPath.get('src/other.ts')?.commit_sha).toBe('');
}

/** Symbol names aggregate per cited path in document order. */
async function symbolAggregationScenario(storage: OnememoryStorage): Promise<void> {
  const fixture = await seedCodeRefFixture(storage);
  const rows: HydratedCodeRef[] = await listCodeRefsForMemories(storage.client, [
    fixture.memoryWithRefs.id,
  ]);
  const byPath = new Map(rows.map((row) => [row.path, row]));
  expect(byPath.get('src/auth/login.ts')?.symbols).toEqual(['Credentials', 'verifyCredentials']);
  expect(byPath.get('src/auth/session.ts')?.symbols).toEqual(['createSession']);
  // Paths without a persisted symbol table aggregate nothing.
  expect(byPath.get('src/gone.ts')?.symbols).toEqual([]);
}

async function rowShapeScenario(storage: OnememoryStorage): Promise<void> {
  const fixture = await seedCodeRefFixture(storage);
  const rows = await listCodeRefsForMemories(storage.client, [fixture.memoryWithRefs.id]);
  const login = rows.find((row) => row.path === 'src/auth/login.ts');
  expect(login?.repository_id).toBe(fixture.repositoryId);
  expect(login?.blob_sha).toBe(blob('b'));
  expect(typeof login?.created_at).toBe('string');
}

const CODE_REF_SCENARIOS: ReadonlyArray<readonly [string, (storage: OnememoryStorage) => Promise<void>]> = [
  ['one batched query returns the refs of many memories (no N+1)', batchedReadScenario],
  ['empty and unknown ids return no rows', emptyAndUnknownIdsScenario],
  ['rows are ordered (memory_id, repository_id, path) for deterministic grouping', deterministicOrderScenario],
  ['the commit anchor is the cited blob\'s own last_seen_commit, never a guess', commitAnchorScenario],
  ['symbol names aggregate per cited path in document order', symbolAggregationScenario],
  ['evidence and provenance fields round-trip the persisted row', rowShapeScenario],
];

/**
 * Register the code-ref scenarios against one deployment profile. `open` yields a fresh handle
 * per scenario (embedded: isolated temp dir; server: the shared pool, unique fixtures) — the
 * same discipline as `runStorageIntegrationSuite`.
 */
function runCodeRefScenarios(
  suiteName: string,
  open: () => Promise<StorageHandle>,
  options?: { enabled?: boolean },
): void {
  const describeFn = options?.enabled === false ? describe.skip : describe;
  describeFn(suiteName, () => {
    for (const [title, scenario] of CODE_REF_SCENARIOS) {
      test(title, async () => {
        const handle = await open();
        try {
          await scenario(handle.storage);
        } finally {
          await handle.close();
        }
      });
    }
  });
}

// ---------------------------------------------------------------------------
// Profile suites
// ---------------------------------------------------------------------------

runCodeRefScenarios('code-ref hydration (embedded / PGlite)', () => openEmbeddedStorage());

const connectionUrl = process.env.ONEMEMORY_PG_URL;

describe.skipIf(!connectionUrl)('code-ref hydration (postgres server)', () => {
  let storage: OnememoryStorage | null = null;

  beforeAll(async () => {
    storage = await createServerDb(connectionUrl!);
  });

  afterAll(async () => {
    await storage?.close();
  });

  runCodeRefScenarios(
    'scenarios',
    async (): Promise<StorageHandle> => {
      if (!storage) throw new Error('server suite opened before beforeAll completed');
      return { storage, dataDir: null, close: () => Promise.resolve() };
    },
  );
});
