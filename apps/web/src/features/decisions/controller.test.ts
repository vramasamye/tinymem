/**
 * Per-page controller test (M10 acceptance 3): the decisions page passes the API's
 * kind-filtered response through untouched — empty stays empty, options ride the
 * query string, nothing is invented.
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
import { loadDecisions } from './controller';

describe('loadDecisions', () => {
  test('rows, tokens and warnings pass through untouched', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadDecisions(api, PROJECT_ID);
    const fixture = fixtureSearchResponse() as unknown as MemorySearchResponse;

    expect(vm.memories).toEqual(fixture.memories);
    expect(vm.tokens).toEqual(fixture.tokens);
    expect(vm.warnings).toEqual(['embedding index degraded: lexical only (fixture)']);
  });

  test('options ride the decisions query string (q, budgets)', async () => {
    const calls: string[] = [];
    const api = createApiClient({
      fetchImpl: stubApi({
        [`GET /v1/projects/${PROJECT_ID}/decisions`]: (request: Request) => {
          calls.push(new URL(request.url).search);
          return new Response(JSON.stringify(fixtureEmptySearchResponse()), {
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    });
    await loadDecisions(api, PROJECT_ID, { q: 'storage', maxTokens: 300, maxMemories: 5 });
    expect(calls).toEqual(['?q=storage&max_tokens=300&max_memories=5']);
  });

  test('an empty decisions response yields no rows — no fallback decisions', async () => {
    const api = createApiClient({
      fetchImpl: stubApi({
        [`GET /v1/projects/${PROJECT_ID}/decisions`]: fixtureEmptySearchResponse(),
      }),
    });
    const vm = await loadDecisions(api, PROJECT_ID);
    expect(vm.memories).toEqual([]);
    expect(vm.warnings).toEqual(['no memories matched (fixture)']);
  });
});
