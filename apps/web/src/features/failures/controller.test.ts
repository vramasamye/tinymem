/**
 * Per-page controller test (M10 acceptance 3): the failures page passes the API's
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
import { loadFailures } from './controller';

describe('loadFailures', () => {
  test('rows, tokens and warnings pass through untouched', async () => {
    const api = createApiClient({ fetchImpl: stubApi(defaultStubRoutes()) });
    const vm = await loadFailures(api, PROJECT_ID);
    const fixture = fixtureSearchResponse() as unknown as MemorySearchResponse;

    expect(vm.memories).toEqual(fixture.memories);
    expect(vm.tokens).toEqual(fixture.tokens);
    expect(vm.warnings).toEqual(['embedding index degraded: lexical only (fixture)']);
  });

  test('options ride the failures query string (q, budgets)', async () => {
    const calls: string[] = [];
    const api = createApiClient({
      fetchImpl: stubApi({
        [`GET /v1/projects/${PROJECT_ID}/failures`]: (request: Request) => {
          calls.push(new URL(request.url).search);
          return new Response(JSON.stringify(fixtureEmptySearchResponse()), {
            headers: { 'content-type': 'application/json' },
          });
        },
      }),
    });
    await loadFailures(api, PROJECT_ID, { q: 'pgvector', maxTokens: 250 });
    expect(calls).toEqual(['?q=pgvector&max_tokens=250']);
  });

  test('an empty failures response yields no rows — no fallback failures', async () => {
    const api = createApiClient({
      fetchImpl: stubApi({
        [`GET /v1/projects/${PROJECT_ID}/failures`]: fixtureEmptySearchResponse(),
      }),
    });
    const vm = await loadFailures(api, PROJECT_ID);
    expect(vm.memories).toEqual([]);
  });
});
