/**
 * Per-page controller test (M10 acceptance 3): the memories page renders only what
 * the search API returned — request mapping is exact, and an empty response yields
 * an empty view-model, never a fallback row or hard-coded value.
 */

import { describe, expect, test } from 'bun:test';

import { createApiClient } from '../../api/client';
import type { MemorySearchResponse } from '../../api/schemas';
import {
  PROJECT_ID,
  defaultStubRoutes,
  fixtureEmptySearchResponse,
  fixtureSearchResponse,
  stubApi,
} from '../../test/fixtures';
import {
  DEFAULT_MEMORIES_FILTERS,
  buildSearchRequest,
  loadMemories,
  parseFilters,
  serializeFilters,
} from './controller';

const FALLBACK = 'fixture-project';

describe('buildSearchRequest maps the filters onto the API request 1:1', () => {
  test('empty filters send only the fallback query', () => {
    expect(buildSearchRequest(DEFAULT_MEMORIES_FILTERS, FALLBACK)).toEqual({
      query: FALLBACK,
      explain: true,
      max_tokens: 800,
    });
  });

  test('every structured filter rides the request', () => {
    const request = buildSearchRequest(
      {
        query: '  pglite  ',
        types: ['decision', 'failure'],
        include: ['stale', 'disputed'],
        entities: ['PGlite', 'pgvector'],
        temporalMode: 'historical',
        asOf: '2026-10-01T00:00:00.000Z',
        explain: false,
        maxTokens: 300,
      },
      FALLBACK,
    );
    expect(request).toEqual({
      query: 'pglite',
      types: ['decision', 'failure'],
      include: ['stale', 'disputed'],
      entities: ['PGlite', 'pgvector'],
      temporal_mode: 'historical',
      as_of: '2026-10-01T00:00:00.000Z',
      explain: false,
      max_tokens: 300,
    });
  });
});

describe('URL round-trip', () => {
  test('defaults serialize to an empty string and parse back', () => {
    expect(serializeFilters(DEFAULT_MEMORIES_FILTERS)).toBe('');
    expect(parseFilters(new URLSearchParams(''))).toEqual(DEFAULT_MEMORIES_FILTERS);
  });

  test('non-defaults survive a serialize → parse round trip', () => {
    const filters = {
      query: 'pglite',
      types: ['decision', 'failure'] as const,
      include: ['stale'] as const,
      entities: ['PGlite'] as const,
      temporalMode: 'historical' as const,
      asOf: '2026-10-01T00:00:00.000Z',
      explain: false,
      maxTokens: 300,
    };
    const serialized = serializeFilters(filters);
    expect(parseFilters(new URLSearchParams(serialized.slice(1)))).toEqual(filters);
  });

  test('unknown type/status values are dropped, not guessed', () => {
    const parsed = parseFilters(
      new URLSearchParams('types=decision,bogus&include=stale,nope&mode=weird'),
    );
    expect(parsed.types).toEqual(['decision']);
    expect(parsed.include).toEqual(['stale']);
    expect(parsed.temporalMode).toBe('current');
  });
});

describe('loadMemories: the view-model is the API response, nothing else', () => {
  test('rows, tokens, warnings and understanding pass through untouched', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadMemories(api, PROJECT_ID, DEFAULT_MEMORIES_FILTERS, FALLBACK);
    const fixture = fixtureSearchResponse() as unknown as MemorySearchResponse;

    expect(vm.querySent).toBe(FALLBACK);
    expect(vm.memories.length).toBe(2);
    // Row-for-row equality with the API payload — the page cannot show anything else.
    expect(vm.memories).toEqual(fixture.memories);
    expect(vm.tokens).toEqual(fixture.tokens);
    expect(vm.warnings).toEqual([
      'embedding index degraded: lexical only (fixture)',
    ]);
    expect(vm.understanding.intent).toBe('decision');
    expect(vm.understanding.entities[0]?.name).toBe('PGlite');
    // Score components ride the explain array verbatim.
    expect(vm.memories[0]?.explain[0]?.factor).toBe('lexical_relevance');
    expect(vm.memories[0]?.explain[0]?.detail).toBe('matched terms: pglite, embedded');
    // Code refs ride verbatim too.
    expect(vm.memories[0]?.codeRefs[0]?.path).toBe('packages/storage/src/embedded.ts');
    expect(vm.memories[0]?.provenance.source_kind).toBe('conversation');
  });

  test('an empty API response yields an empty view-model — no fallback rows', async () => {
    const api = createApiClient({
      fetchImpl: stubApi({
        [`POST /v1/projects/${PROJECT_ID}/search`]: fixtureEmptySearchResponse(),
      }),
    });
    const vm = await loadMemories(api, PROJECT_ID, DEFAULT_MEMORIES_FILTERS, FALLBACK);
    expect(vm.memories).toEqual([]);
    expect(vm.tokens.used).toBe(0);
    expect(vm.warnings).toEqual(['no memories matched (fixture)']);
  });

  test('a query in the filters replaces the project-name fallback', async () => {
    const seen: unknown[] = [];
    const api = createApiClient({
      fetchImpl: stubApi({
        [`POST /v1/projects/${PROJECT_ID}/search`]: (request: Request) => {
          seen.push(request.json());
          return new Response(JSON.stringify(fixtureEmptySearchResponse()), {
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    });
    const vm = await loadMemories(
      api,
      PROJECT_ID,
      { ...DEFAULT_MEMORIES_FILTERS, query: 'explicit query' },
      FALLBACK,
    );
    expect(vm.querySent).toBe('explicit query');
    expect(await (seen[0] as Promise<{ query: string }>)).toMatchObject({
      query: 'explicit query',
    });
  });
});
