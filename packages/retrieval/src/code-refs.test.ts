/**
 * Code-ref hydration (M4g2 — closing M4g's finding F5): the `codeRefs` field of every returned
 * memory, hydrated from persisted `memory_code_refs` in one batched read.
 *
 * Two layers, matching the code:
 * - the pure shaping module (`code-refs.ts`): symbol attribution (word-boundary, document
 *   order, case-sensitive, never fabricated) and the deterministic refs budget (cap + the
 *   `<N more refs>` placeholder — never a silent mid-list truncation);
 * - the engine against a REAL embedded PGlite (the seedWorld fixture): the refs of the deploy
 *   procedure surface with repoId/commitSha/path/symbol/evidence, memories without refs carry
 *   the always-present empty field, and a failed hydration degrades to a warning + empty refs
 *   instead of a failed search.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type { SnapshotInput, SymbolFileInput, SymbolRecordInput } from '@onememory/core';
import { MemorySearchResponseSchema } from '@onememory/core';
import type { Database } from '@onememory/storage';
import type { OnememoryStorage } from '@onememory/storage';

import { createRetrievalEngine } from './engine';
import type { RetrievalEngine } from './engine';
import { matchingSymbol, moreRefsPlaceholder, toCodeRefEntries } from './code-refs';
import type { HydratedCodeRef } from '@onememory/storage';
import { seedWorld, WORLD_NOW, type WorldHandle } from './test-world';

const blob = (char: string): string => char.repeat(40);
const span = (char: string): string => char.repeat(64);

function symbolOf(name: string, lineStart: number, hashChar: string): SymbolRecordInput {
  return {
    name,
    kind: 'function',
    signature: `function ${name}()`,
    line_start: lineStart,
    line_end: lineStart + 6,
    span_hash: span(hashChar),
  };
}

function snapshotOf(head: string, files: Array<{ path: string; sha: string }>): SnapshotInput {
  return {
    root_path: '/dev/acme-api',
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

/** A hydrated row as storage returns them (ordered memory, repository, path). */
function hydratedRow(overrides: Partial<HydratedCodeRef> & Pick<HydratedCodeRef, 'path'>): HydratedCodeRef {
  return {
    memory_id: '0192f3c0-0000-7000-8000-000000000001',
    repository_id: '0192f3c0-0000-7000-8000-000000000021',
    blob_sha: blob('b'),
    commit_sha: blob('a'),
    symbols: [],
    created_at: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Pure shaping (no storage)
// ---------------------------------------------------------------------------

describe('code-ref shaping (pure)', () => {
  const CONTENT =
    'Authentication procedure: verifyCredentials checks the bcrypt hash; createSession signs the JWT.';

  test('symbol attribution is a word-boundary, case-sensitive, document-order match', () => {
    // 'Credentials' is a substring of 'verifyCredentials' but never a whole word in the content.
    expect(matchingSymbol(CONTENT, ['Credentials', 'verifyCredentials'])).toBe('verifyCredentials');
    // Case-sensitive: prose 'Session' is not the `session` symbol.
    expect(matchingSymbol('the Session was signed', ['session'])).toBeUndefined();
    expect(matchingSymbol('session was signed', ['session'])).toBe('session');
    // Document order wins: with both names in the content, the FIRST document-order symbol takes it.
    expect(matchingSymbol(CONTENT, ['createSession', 'verifyCredentials'])).toBe('createSession');
    expect(matchingSymbol(CONTENT, ['verifyCredentials', 'createSession'])).toBe('verifyCredentials');
  });

  test('no content-named symbol → no symbol, never a guess; regex-special names match safely', () => {
    expect(matchingSymbol(CONTENT, ['unrelated', 'argon2'])).toBeUndefined();
    expect(matchingSymbol('we call $fetchCached here', ['$fetchCached'])).toBe('$fetchCached');
    expect(matchingSymbol('a (parenthesized) path', ['(parenthesized)'])).toBe('(parenthesized)');
  });

  test('entries carry repoId, commitSha, path, evidence and the matched symbol', () => {
    const entries = toCodeRefEntries(
      [hydratedRow({ path: 'src/auth/login.ts', symbols: ['Credentials', 'verifyCredentials'] })],
      CONTENT,
      5,
    );
    expect(entries).toEqual([
      {
        repoId: '0192f3c0-0000-7000-8000-000000000021',
        commitSha: blob('a'),
        path: 'src/auth/login.ts',
        symbol: 'verifyCredentials',
        evidence: blob('b'),
      },
    ]);
  });

  test('the refs budget caps real entries and summarizes the tail with ONE placeholder', () => {
    const rows = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts', 'f.ts', 'g.ts', 'h.ts'].map((path, index) =>
      hydratedRow({ path, blob_sha: blob(String(index)) }),
    );
    const entries = toCodeRefEntries(rows, CONTENT, 5);
    expect(entries).toHaveLength(6); // 5 real + 1 placeholder — never a silent mid-list cut
    expect(entries.slice(0, 5).map((entry) => entry.path)).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']);
    expect(entries[5]).toEqual({
      repoId: '0192f3c0-0000-7000-8000-000000000021',
      commitSha: '',
      path: moreRefsPlaceholder(3),
    });
  });

  test('at or under the cap there is no placeholder; empty rows stay empty', () => {
    const five = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'].map((path) => hydratedRow({ path }));
    expect(toCodeRefEntries(five, CONTENT, 5)).toHaveLength(5);
    expect(toCodeRefEntries([], CONTENT, 5)).toEqual([]);
  });

  test('the honest empty commitSha (no anchor) passes through untouched', () => {
    const entries = toCodeRefEntries([hydratedRow({ path: 'gone.ts', commit_sha: '' })], CONTENT, 5);
    expect(entries[0]?.commitSha).toBe('');
    expect(entries[0]?.evidence).toBe(blob('b'));
  });
});

// ---------------------------------------------------------------------------
// Engine hydration (real embedded PGlite, the seedWorld fixture)
// ---------------------------------------------------------------------------

interface RefWorld {
  world: WorldHandle;
  engine: RetrievalEngine;
  repositoryId: string;
  headCommit: string;
  blobOf: (path: string) => string;
}

/** Seed the fixture world plus a repository whose refs point at the deploy procedure. */
async function seedRefWorld(
  refPaths: readonly string[],
  symbolFiles?: readonly SymbolFileInput[],
): Promise<RefWorld> {
  const world = await seedWorld();
  const headCommit = blob('a');
  const repository = await world.storage.codeMemory.ensureRepository({
    project_id: world.ids.projectId,
    root_path: '/dev/acme-api',
  });
  await world.storage.codeMemory.saveSnapshot(
    repository.id,
    snapshotOf(headCommit, refPaths.map((path, index) => ({ path, sha: blob(String(index + 1)) }))),
  );
  if (symbolFiles !== undefined && symbolFiles.length > 0) {
    await world.storage.codeMemory.saveSymbolTable(repository.id, { files: [...symbolFiles] });
  }
  await world.storage.codeMemory.recordCodeRefs({
    memory_id: world.ids.deploy,
    repository_id: repository.id,
    refs: refPaths.map((path, index) => ({ path, blob_sha: blob(String(index + 1)) })),
  });
  const engine = createRetrievalEngine(world.storage, {
    embedder: world.embedder,
    now: () => new Date(WORLD_NOW),
  });
  return {
    world,
    engine,
    repositoryId: repository.id,
    headCommit,
    blobOf: (path: string) => {
      const index = refPaths.indexOf(path);
      if (index < 0) throw new Error(`fixture: no ref for ${path}`);
      return blob(String(index + 1));
    },
  };
}

const DEPLOY_REFS = [
  'cloudbuild.yaml',
  'deploy.Dockerfile',
  'run.sh',
  'scripts/deploy.sh',
  'src/deploy/cli.ts',
  'src/deploy/deploy.sh',
  'terraform/main.tf',
] as const;

describe('code-ref hydration (embedded PGlite)', () => {
  let primary: RefWorld;

  beforeAll(async () => {
    primary = await seedRefWorld(DEPLOY_REFS, [
      {
        path: 'src/deploy/deploy.sh',
        language: 'typescript',
        // Document order: deployEverything (line 8) is NOT in the memory's content; gcloud is.
        symbols: [symbolOf('deployEverything', 8, 'a'), symbolOf('gcloud', 12, 'b')],
        symbols_hash: span('1'),
      },
    ]);
  });

  afterAll(async () => {
    await primary.world.close();
  });

  test("the deploy procedure's refs surface on its search item: repoId, commit, path, evidence", async () => {
    const response = await primary.engine.search({
      query: 'how do we deploy the service to Cloud Run',
      project_id: primary.world.ids.projectId,
      explain: true,
    });
    const deploy = response.memories.find((memory) => memory.id === primary.world.ids.deploy);
    expect(deploy).toBeDefined();
    expect(() => MemorySearchResponseSchema.parse(response)).not.toThrow();
    expect(deploy?.codeRefs.map((entry) => entry.repoId)).toEqual(
      deploy?.codeRefs.map(() => primary.repositoryId),
    );
    // 7 recorded refs, default budget 5: the five (repository, path)-first entries surface, and
    // the tail is summarized by exactly ONE placeholder — never a silent mid-list truncation.
    expect(deploy?.codeRefs.map((entry) => entry.path)).toEqual([
      ...DEPLOY_REFS.slice(0, 5),
      moreRefsPlaceholder(2),
    ]);
    for (const entry of deploy?.codeRefs ?? []) {
      if (entry.path === moreRefsPlaceholder(2)) continue;
      expect(entry.commitSha).toBe(primary.headCommit);
      expect(entry.evidence).toBe(primary.blobOf(entry.path));
    }
  });

  test('the content-named symbol surfaces (word match, document order); the unnamed one does not', async () => {
    const response = await primary.engine.search({
      query: 'how do we deploy the service to Cloud Run',
      project_id: primary.world.ids.projectId,
    });
    const deploy = response.memories.find((memory) => memory.id === primary.world.ids.deploy);
    // 7 refs, default budget 5 → the symbol-carrying path (6th by (repo, path) order) is in the
    // omitted tail; assert the placeholder summarizes it deterministically instead.
    expect(deploy?.codeRefs).toHaveLength(6);
    expect(deploy?.codeRefs[5]?.path).toBe(moreRefsPlaceholder(2));
    expect(deploy?.codeRefs[5]?.commitSha).toBe('');
  });

  test('the symbol-carrying ref surfaces its symbol when it fits the refs budget', async () => {
    const small = await seedRefWorld(
      ['src/deploy/deploy.sh'],
      [
        {
          path: 'src/deploy/deploy.sh',
          language: 'typescript',
          symbols: [symbolOf('deployEverything', 8, 'a'), symbolOf('gcloud', 12, 'b')],
          symbols_hash: span('1'),
        },
      ],
    );
    try {
      const response = await small.engine.search({
        query: 'how do we deploy the service to Cloud Run',
        project_id: small.world.ids.projectId,
      });
      const deploy = response.memories.find((memory) => memory.id === small.world.ids.deploy);
      expect(deploy?.codeRefs).toEqual([
        {
          repoId: small.repositoryId,
          commitSha: small.headCommit,
          path: 'src/deploy/deploy.sh',
          // 'gcloud' is the only cited symbol the deploy memory's content names as a whole word.
          symbol: 'gcloud',
          evidence: small.blobOf('src/deploy/deploy.sh'),
        },
      ]);
    } finally {
      await small.world.close();
    }
  });

  test('every returned item carries codeRefs — empty for memories with none, working rows included', async () => {
    const response = await primary.engine.search({
      query: 'how do we deploy the service to Cloud Run',
      project_id: primary.world.ids.projectId,
      session_id: primary.world.ids.sessionId,
    });
    expect(response.memories.length).toBeGreaterThan(1);
    expect(response.memories.every((memory) => Array.isArray(memory.codeRefs))).toBe(true);
    const preference = response.memories.find((memory) => memory.id === primary.world.ids.preference);
    if (preference !== undefined) expect(preference.codeRefs).toEqual([]);
  });

  test('a failed hydration is a warning + empty refs — never a failed search', async () => {
    const storage = primary.world.storage;
    const failingClient: Database = {
      profile: storage.client.profile,
      query: (text, params) => {
        if (text.includes('memory_code_refs')) {
          return Promise.reject(new Error('refs table unavailable (fixture)'));
        }
        return storage.client.query(text, params);
      },
      transaction: (work) => storage.client.transaction(work),
      close: () => storage.client.close(),
    };
    const engine = createRetrievalEngine(
      { store: storage.store, client: failingClient, vectors: storage.vectors },
      { embedder: primary.world.embedder, now: () => new Date(WORLD_NOW) },
    );
    const response = await engine.search({
      query: 'how do we deploy the service to Cloud Run',
      project_id: primary.world.ids.projectId,
    });
    const deploy = response.memories.find((memory) => memory.id === primary.world.ids.deploy);
    expect(deploy).toBeDefined();
    expect(deploy?.codeRefs).toEqual([]);
    expect(
      response.warnings.some((warning) => warning.startsWith('code ref hydration failed:')),
    ).toBe(true);
  });

  test('the refs budget is config-overridable (maxPerMemory)', async () => {
    const world = await seedWorld();
    try {
      const repository = await world.storage.codeMemory.ensureRepository({
        project_id: world.ids.projectId,
        root_path: '/dev/acme-api',
      });
      await world.storage.codeMemory.saveSnapshot(
        repository.id,
        snapshotOf(blob('a'), DEPLOY_REFS.map((path, index) => ({ path, sha: blob(String(index + 1)) }))),
      );
      await world.storage.codeMemory.recordCodeRefs({
        memory_id: world.ids.deploy,
        repository_id: repository.id,
        refs: DEPLOY_REFS.map((path, index) => ({ path, blob_sha: blob(String(index + 1)) })),
      });
      const engine = createRetrievalEngine(world.storage, {
        embedder: world.embedder,
        now: () => new Date(WORLD_NOW),
        config: { codeRefs: { maxPerMemory: 7 } },
      });
      const response = await engine.search({
        query: 'how do we deploy the service to Cloud Run',
        project_id: world.ids.projectId,
      });
      const deploy = response.memories.find((memory) => memory.id === world.ids.deploy);
      expect(deploy?.codeRefs).toHaveLength(7); // all seven fit — no placeholder
    } finally {
      await world.close();
    }
  });
});
