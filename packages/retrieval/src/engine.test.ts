/**
 * Engine integration suite against a REAL embedded PGlite (the fixture world in test-world.ts):
 * per-channel behavior, the Node 20/22 temporal guarantee, degraded modes, session working
 * memory, the explain snapshot, caches, entity filtering, and disputed labeling.
 *
 * NOTE: the snapshot test runs FIRST in this file — its expected values assume a pristine
 * fixture (access_count 0 everywhere; reinforce bumps counts as searches run).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';

import type {
  MemorySearchRequest,
  MemorySearchResponse,
  NewMemory,
  Reranker,
} from '@onememory-ai/core';
import { MemorySearchResponseSchema } from '@onememory-ai/core';
import { sourcesRepo } from '@onememory-ai/storage';

import { createRetrievalEngine } from './engine';
import type { RetrievalEngine, RetrievalStorage } from './engine';
import { seedWorld, WORLD_NOW, type WorldHandle } from './test-world';
import { createQueryAwareTestEmbedder } from './testing';

let world: WorldHandle;
let engine: RetrievalEngine;

const fixedNow = () => new Date(WORLD_NOW);

beforeAll(async () => {
  world = await seedWorld();
  engine = createRetrievalEngine(world.storage, { embedder: world.embedder, now: fixedNow });
});

afterAll(async () => {
  await world.close();
});

function ids(response: MemorySearchResponse): string[] {
  return response.memories.map((memory) => memory.id);
}

describe('retrieval engine (embedded PGlite)', () => {
  // Runs first: pristine fixture → deterministic explain snapshot.
  test('explain snapshot for a fixed query', async () => {
    const response = await engine.search({
      query: 'why did we choose postgresql for the database',
      project_id: world.ids.projectId,
      explain: true,
    });
    expect(response.query_understanding.intent).toBe('decision');
    const projection = {
      intent: response.query_understanding.intent,
      keywords: response.query_understanding.keywords,
      entities: response.query_understanding.entities.map((entity) => entity.name),
      memories: response.memories.map((memory) => ({
        type: memory.type,
        title: memory.title ?? null,
        relevance: Number(memory.relevance.toFixed(4)),
        explain: memory.explain.map((entry) => ({
          factor: entry.factor,
          weight: entry.weight,
          detail: entry.detail,
        })),
        temporal: {
          status: memory.temporal.status,
          valid_from: memory.temporal.valid_from.slice(0, 10),
          valid_until: memory.temporal.valid_until?.slice(0, 10) ?? null,
        },
      })),
    };
    expect(projection).toMatchSnapshot();
  });

  test('responses are schema-valid (the wire contract, event-memory-schemas.md §6)', async () => {
    const response = await engine.search({
      query: 'how do we deploy the service to Cloud Run',
      project_id: world.ids.projectId,
      explain: true,
    });
    expect(() => MemorySearchResponseSchema.parse(response)).not.toThrow();
    // A healthy full-capability search warns about nothing; channel SQL errors surface here.
    expect(response.warnings).toEqual([]);
    expect(response.tokens.used).toBeLessThanOrEqual(response.tokens.budget);
    // Lexical + vector + entity-bound graph all find the procedure; explain shows each channel.
    expect(response.memories.some((memory) => memory.id === world.ids.deploy)).toBe(true);
    const deploy = response.memories.find((memory) => memory.id === world.ids.deploy);
    expect(deploy?.explain.map((entry) => entry.factor)).toContain('lexical_relevance');
    expect(deploy?.explain.map((entry) => entry.factor)).toContain('semantic_similarity');
    expect(deploy?.explain.map((entry) => entry.factor)).toContain('graph_proximity');
    expect(deploy?.explain.map((entry) => entry.factor)).toContain('entity_match');
    // explain defaults to the empty array when not requested (token efficiency).
    const quiet = await engine.search({ query: 'how do we deploy to cloud run docker', project_id: world.ids.projectId });
    expect(quiet.memories.every((memory) => memory.explain.length === 0)).toBe(true);
  });

  test('invalid requests are rejected at the boundary (Zod)', async () => {
    await expect(engine.search({ query: '' } as MemorySearchRequest)).rejects.toThrow();
    await expect(
      engine.search({ query: 'x', max_tokens: 0 } as MemorySearchRequest),
    ).rejects.toThrow();
  });

  test('temporal correctness: current query returns Node 22 only (superseded is invisible)', async () => {
    const response = await engine.search({
      query: 'which node version does the project run on',
      project_id: world.ids.projectId,
    });
    expect(ids(response)).toContain(world.ids.node22);
    expect(ids(response)).not.toContain(world.ids.node20);
  });

  test('temporal correctness: as_of before the supersession returns Node 20 only', async () => {
    const response = await engine.search({
      query: 'which node version does the project run on',
      project_id: world.ids.projectId,
      as_of: '2025-01-01T00:00:00.000Z',
    });
    expect(ids(response)).toContain(world.ids.node20);
    expect(ids(response)).not.toContain(world.ids.node22);
  });

  test('historical mode returns the full supersession chain (both versions)', async () => {
    const response = await engine.search({
      query: 'which node version does the project run on',
      project_id: world.ids.projectId,
      temporal_mode: 'historical',
    });
    expect(new Set(ids(response))).toContain(world.ids.node20);
    expect(new Set(ids(response))).toContain(world.ids.node22);
  });

  test('graph channel: 1-2 hop expansion surfaces connected memories, honors edge validity', async () => {
    // 'cloud run' matches the project entity → failure is entity-bound; the decision and the
    // deploy procedure are reached through edges. The deploy → overview edge is NOT yet valid
    // (valid_from 2030) so the overview must not surface through the graph.
    const response = await engine.search({
      query: 'cloud run oom failures',
      project_id: world.ids.projectId,
      max_tokens: 800,
    });
    const found = new Set(ids(response));
    expect(found.has(world.ids.failure)).toBe(true);
    expect(found.has(world.ids.decision)).toBe(true); // 1 hop: failure —related_to→ decision
    expect(found.has(world.ids.deploy)).toBe(true); // 2 hops: decision —related_to→ deploy
    expect(found.has(world.ids.overview)).toBe(false); // edge not yet valid → no traversal
  });

  test('decision intent pulls the accepted-decision shortcut; project match ranks same-project higher', async () => {
    const response = await engine.search({
      query: 'why did we choose postgresql for the database',
      project_id: world.ids.projectId,
    });
    expect(response.memories[0]?.id).toBe(world.ids.decision);
  });

  test('entity filter: only memories bound to ALL named entities', async () => {
    const response = await engine.search({
      query: 'database failures',
      project_id: world.ids.projectId,
      entities: ['PostgreSQL'],
    });
    expect(new Set(ids(response))).toEqual(new Set([world.ids.decision, world.ids.failureSolved]));
    expect(ids(response)).not.toContain(world.ids.failure); // bound to Cloud Run, not PostgreSQL
  });

  test('entity filter: an unresolvable name → warning + honest empty result', async () => {
    const response = await engine.search({
      query: 'database',
      entities: ['Totally Unknown Entity'],
    });
    expect(response.memories).toEqual([]);
    expect(response.warnings.some((warning) => warning.includes('Totally Unknown Entity'))).toBe(true);
  });

  test('disputed memories: excluded by default, labeled with their conflict when included', async () => {
    const plain = await engine.search({ query: 'sqlite database', project_id: world.ids.projectId });
    expect(ids(plain)).not.toContain(world.ids.disputed);

    const included = await engine.search({
      query: 'sqlite database',
      project_id: world.ids.projectId,
      include: ['disputed'],
    });
    expect(ids(included)).toContain(world.ids.disputed);
    const disputed = included.memories.find((memory) => memory.id === world.ids.disputed);
    expect(disputed?.conflicts).toBeDefined();
    expect(disputed?.conflicts?.[0]?.memory_id).toBe(world.ids.decision); // the contradicts edge
  });

  test('token budget: used ≤ budget with a small budget, honest drop warnings', async () => {
    const small = createRetrievalEngine(world.storage, { embedder: world.embedder, now: fixedNow });
    const response = await small.search({
      query: 'why did we choose postgresql for the database',
      project_id: world.ids.projectId,
      max_tokens: 30,
    });
    expect(response.tokens.budget).toBe(30);
    expect(response.tokens.used).toBeLessThanOrEqual(30);
    expect(response.warnings.some((warning) => warning.includes('did not fit the token budget'))).toBe(true);
  });

  test("session_id includes THIS session's working memory; expired rows never surface", async () => {
    // Real clock: working rows' created_at is "now"; a fixed WORLD_NOW would drift relative to
    // the run date, so this engine uses the actual clock.
    const realtime = createRetrievalEngine(world.storage, { embedder: world.embedder });
    const withSession = await realtime.search({
      query: 'refactor the invoice export endpoint',
      project_id: world.ids.projectId,
      session_id: world.ids.sessionId,
    });
    const summaries = withSession.memories.map((memory) => memory.summary);
    expect(summaries.some((summary) => summary.includes('invoice export endpoint'))).toBe(true);
    expect(summaries.some((summary) => summary.includes('redis cache tests'))).toBe(true);
    expect(summaries.every((summary) => !summary.includes('Expired scratch note'))).toBe(true);
    expect(withSession.memories.some((memory) => memory.type === 'working')).toBe(true);

    const withoutSession = await realtime.search({
      query: 'refactor the invoice export endpoint',
      project_id: world.ids.projectId,
    });
    expect(withoutSession.memories.every((memory) => memory.type !== 'working')).toBe(true);
  });

  test('degraded: no Embedder → lexical + graph only, warned — never silent', async () => {
    const degraded = createRetrievalEngine(world.storage, { now: fixedNow });
    const response = await degraded.search({
      query: 'postgres connection problems',
      project_id: world.ids.projectId,
    });
    expect(response.warnings.some((warning) => warning.includes('vector channel unavailable'))).toBe(true);
    expect(ids(response)).toContain(world.ids.failureSolved); // lexical still works
  });

  test('degraded: embedding index missing → warned, vector channel disabled', async () => {
    const noVectors: RetrievalStorage = {
      store: world.storage.store,
      client: world.storage.client,
    };
    const degraded = createRetrievalEngine(noVectors, { embedder: world.embedder, now: fixedNow });
    const response = await degraded.search({ query: 'postgres connection problems', project_id: world.ids.projectId });
    expect(response.warnings.some((warning) => warning.includes('embedding index unavailable'))).toBe(true);
    expect(ids(response)).toContain(world.ids.failureSolved);
  });

  test('degraded: a failing embedding index errors into a warning, search still answers', async () => {
    const failingVectors = {
      ...world.storage,
      vectors: {
        backend: 'float8' as const,
        dim: 384,
        model: 'test/hash-axes',
        upsert: async () => {},
        remove: async () => {},
        search: async () => {
          throw new Error('index down');
        },
      },
    };
    const degraded = createRetrievalEngine(failingVectors, { embedder: world.embedder, now: fixedNow });
    const response = await degraded.search({ query: 'postgres connection problems', project_id: world.ids.projectId });
    expect(response.warnings.some((warning) => warning.includes('vector channel failed'))).toBe(true);
    expect(ids(response)).toContain(world.ids.failureSolved);
  });

  test('query-side embedding prefers the port embedQuery when the embedder defines it', async () => {
    const queryAware = createQueryAwareTestEmbedder();
    const queryEngine = createRetrievalEngine(world.storage, { embedder: queryAware, now: fixedNow });
    const response = await queryEngine.search({
      query: 'why did we choose postgresql for the database',
      project_id: world.ids.projectId,
    });
    expect(queryAware.queryCalls).toBeGreaterThan(0);
    expect(ids(response).length).toBeGreaterThan(0);
  });

  test('rerank tier: opt-in by config + injection; requested-but-missing is warned', async () => {
    const baseline = createRetrievalEngine(world.storage, { embedder: world.embedder, now: fixedNow });
    const baselineResponse = await baseline.search({
      query: 'why did we choose postgresql for the database',
      project_id: world.ids.projectId,
    });
    expect(baselineResponse.memories[0]?.id).toBe(world.ids.decision);

    const reversed: Reranker = {
      rerank: async (_query, candidates) =>
        [...candidates].reverse().map((candidate) => ({ memory_id: candidate.memory_id, score: 0.5 })),
    };
    const rerankEngine = createRetrievalEngine(world.storage, {
      embedder: world.embedder,
      now: fixedNow,
      reranker: reversed,
      config: { rerank: { enabled: true } },
    });
    const reranked = await rerankEngine.search({
      query: 'why did we choose postgresql for the database',
      project_id: world.ids.projectId,
    });
    expect(reranked.memories[0]?.id).not.toBe(world.ids.decision);
    expect(reranked.memories[0]?.id).toBe(baselineResponse.memories.at(-1)?.id);

    const missing = createRetrievalEngine(world.storage, {
      embedder: world.embedder,
      now: fixedNow,
      config: { rerank: { enabled: true } },
    });
    const missingResponse = await missing.search({
      query: 'why did we choose postgresql for the database',
      project_id: world.ids.projectId,
    });
    expect(missingResponse.warnings.some((warning) => warning.includes('rerank requested but no reranker'))).toBe(true);
  });

  test('context intent attaches the project digest (additive field), warns when not built', async () => {
    const response = await engine.search({
      query: 'project context overview of this codebase',
      project_id: world.ids.projectId,
    });
    expect(response.query_understanding.intent).toBe('context');
    const digest = (response as MemorySearchResponse & { project_digest?: { name?: string } }).project_digest;
    expect(digest?.name).toBe('acme-api');

    const other = createRetrievalEngine(world.storage, { embedder: world.embedder, now: fixedNow });
    const otherResponse = await other.search({
      query: 'project context overview of this codebase',
      project_id: world.ids.otherProjectId,
    });
    expect(otherResponse.warnings.some((warning) => warning.includes('project digest not yet built'))).toBe(true);
  });

  test('caches: result cache serves repeats; embedding cache avoids re-embedding; project writes invalidate', async () => {
    const fresh = createRetrievalEngine(world.storage, { embedder: world.embedder, now: fixedNow });
    const query = 'quantum flux capacitor calibration status';
    const request: MemorySearchRequest = { query, project_id: world.ids.projectId };

    const first = await fresh.search(request);
    expect(first.memories).toEqual([]); // nothing matches yet
    const callsAfterFirst = world.embedder.calls;
    expect(fresh.cacheStats().results).toBe(1);

    const second = await fresh.search(request);
    expect(second.memories).toEqual([]); // served from the result cache
    expect(world.embedder.calls).toBe(callsAfterFirst); // no re-embedding

    // A write to the project makes the cached "no results" stale until invalidated.
    const source = await world.storage.store.createSource({
      kind: 'explicit',
      uri: 'cli/test-insert',
      project_id: world.ids.projectId,
    });
    const newMemory: NewMemory = {
      type: 'semantic',
      content: 'The quantum flux capacitor needs calibration.',
      importance: 0.5,
      confidence: 0.6,
      observed_at: '2026-06-01T00:00:00.000Z',
      project_id: world.ids.projectId,
      source_id: source.id,
      evidence: [{ source_id: source.id, kind: 'message', locator: 'cli', excerpt: 'fixture' }],
      extraction: { method: 'heuristic', prompt_version: 'test-v1' },
    };
    const inserted = await world.storage.store.insertMemory(newMemory);
    expect(inserted.outcome).toBe('inserted');

    const stillCached = await fresh.search(request);
    expect(stillCached.memories).toEqual([]); // cache honest to its TTL
    expect(world.embedder.calls).toBe(callsAfterFirst);

    fresh.invalidateCache(world.ids.projectId);
    const refreshed = await fresh.search(request);
    expect(refreshed.memories.map((memory) => memory.id)).toContain(inserted.memory.id);
    expect(world.embedder.calls).toBe(callsAfterFirst); // query embedding still cache-hit
  });

  test('stage 11 REINFORCE: returned durable hits get access_count bumps', async () => {
    const before = await world.storage.store.getMemory(world.ids.preference);
    const reinforceEngine = createRetrievalEngine(world.storage, { embedder: world.embedder, now: fixedNow });
    await reinforceEngine.search({ query: 'formatting preference tabs or spaces', project_id: world.ids.projectId });
    await new Promise((resolve) => setTimeout(resolve, 100)); // fire-and-forget settle
    const after = await world.storage.store.getMemory(world.ids.preference);
    expect((after?.access_count ?? 0)).toBeGreaterThan(before?.access_count ?? 0);
  });
});

describe('scope admission (M17: user-level answers, no cross-project leaks)', () => {
  /** The packed wire items are the progressive-disclosure ID-index — read the rows back through
   * the store for content assertions. */
  const readBack = async (memories: Array<{ id: string }>): Promise<string> => {
    const rows = await Promise.all(memories.map((memory) => world.storage.store.getMemory(memory.id)));
    return rows.map((row) => `${row?.title ?? ''} ${row?.content ?? ''}`).join('\n');
  };

  test('a project search answers with the project PLUS the caller\'s user level, never another project', async () => {
    const user = await sourcesRepo.ensureLocalUser(world.storage.client);
    // Topically distinct from every fixture row: the near-duplicate collapse (cosine ≥ 0.97)
    // must not be what "answers" this — only the scope union can.
    const userLevel = await world.storage.store.insertMemory({
      type: 'preference',
      title: 'User-level editor preference',
      content: 'The user runs every editor in dark mode with a 13pt font.',
      importance: 0.7,
      confidence: 0.8,
      observed_at: '2025-09-01T00:00:00.000Z',
      user_id: user.id,
      source_id: world.ids.explicitSourceId,
      evidence: [
        { source_id: world.ids.explicitSourceId, kind: 'message', locator: 'cli', excerpt: 'user-level preference' },
      ],
      extraction: { method: 'heuristic', prompt_version: 'scope-v1' },
    });
    expect(userLevel.outcome).toBe('inserted');

    const scoped = createRetrievalEngine(world.storage, {
      embedder: world.embedder,
      now: fixedNow,
      resolveUserId: async () => user.id,
    });

    // The caller's user-level row answers from INSIDE the project search (the union's second arm).
    const darkMode = await scoped.search({ query: 'dark mode editor', project_id: world.ids.projectId });
    expect(await readBack(darkMode.memories)).toContain('dark mode with a 13pt font');

    // The lexical probe for 'database': the project's decision answers, the OTHER project's
    // SQLite row — which the old unscoped filter ranked (see the explain factor
    // 'cross-project memory' this mission removed) — never does.
    const database = await scoped.search({ query: 'which database does the project use', project_id: world.ids.projectId });
    const databaseContents = await readBack(database.memories);
    expect(databaseContents).toContain('PostgreSQL');
    expect(databaseContents).not.toContain('other-app uses SQLite');

    // Without a user resolver the scope is still HARD project scope: the leak stays closed and
    // user-level rows simply do not ride along.
    const noResolver = createRetrievalEngine(world.storage, { embedder: world.embedder, now: fixedNow });
    const plainDark = await noResolver.search({ query: 'dark mode editor', project_id: world.ids.projectId });
    expect(await readBack(plainDark.memories)).not.toContain('dark mode');
    const plainDatabase = await noResolver.search({ query: 'which database does the project use', project_id: world.ids.projectId });
    const plainContents = await readBack(plainDatabase.memories);
    expect(plainContents).toContain('PostgreSQL');
    expect(plainContents).not.toContain('other-app uses SQLite');

    // The user-level row really has no project (the union's second arm is what surfaced it).
    const userLevelRow = await world.storage.store.getMemory(userLevel.memory.id);
    expect(userLevelRow?.project_id).toBeUndefined();
  });
});
