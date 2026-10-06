/**
 * The browse surface: the API's keyset cursor is passed back verbatim, filters map onto
 * the query string 1:1, and the view renders only what the page carried (rows, a
 * "next page" control exactly when the API returned a cursor).
 */

import { describe, expect, test } from 'bun:test';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router';

import { createApiClient } from '../../api/client';
import {
  MEMORY_ID_ALPHA,
  PROJECT_ID,
  fixtureMemoryRecord,
  jsonResponse,
  stubApi,
} from '../../test/fixtures';
import { BrowseView } from './BrowsePage';
import {
  DEFAULT_BROWSE_FILTERS,
  loadBrowsePage,
  parseBrowseFilters,
  serializeBrowseFilters,
} from './controller';

const MEMORY_ID_SECOND = '0195a7f0-9f5e-7a1d-bc2d-0000000000b2';

function pagedApi(calls: string[]) {
  return createApiClient({
    fetchImpl: stubApi({
      [`GET /v1/projects/${PROJECT_ID}/memories`]: (request: Request) => {
        const url = new URL(request.url);
        calls.push(url.search);
        const cursor = url.searchParams.get('cursor');
        return jsonResponse({
          project_id: PROJECT_ID,
          page_size: Number(url.searchParams.get('page_size')),
          memories: [fixtureMemoryRecord(cursor === null ? MEMORY_ID_ALPHA : MEMORY_ID_SECOND)],
          next_cursor: cursor === null ? 'opaque-cursor-1' : null,
        });
      },
    }),
  });
}

const noop = (): void => {};

describe('browse controller', () => {
  test('first page → next page passes the API cursor back unchanged, with the filters', async () => {
    const calls: string[] = [];
    const api = pagedApi(calls);
    const filters = { ...DEFAULT_BROWSE_FILTERS, types: ['decision' as const], include: ['archived' as const], pageSize: 25 };

    const first = await loadBrowsePage(api, PROJECT_ID, filters);
    expect(first.isFirstPage).toBeTrue();
    expect(first.nextCursor).toBe('opaque-cursor-1');
    expect(first.memories.map((memory) => memory.id)).toEqual([MEMORY_ID_ALPHA]);

    const second = await loadBrowsePage(api, PROJECT_ID, { ...filters, cursor: first.nextCursor! });
    expect(second.isFirstPage).toBeFalse();
    expect(second.nextCursor).toBeNull();
    expect(second.memories.map((memory) => memory.id)).toEqual([MEMORY_ID_SECOND]);

    expect(calls).toEqual([
      '?page_size=25&types=decision&include=archived',
      '?cursor=opaque-cursor-1&page_size=25&types=decision&include=archived',
    ]);
  });

  test('URL round trip keeps the cursor and drops unknown values', () => {
    const filters = { types: ['failure' as const], include: ['stale' as const], pageSize: 100, cursor: 'abc' };
    expect(parseBrowseFilters(new URLSearchParams(serializeBrowseFilters(filters).slice(1)))).toEqual(filters);
    expect(parseBrowseFilters(new URLSearchParams('types=bogus&include=active&size=7'))).toEqual(
      DEFAULT_BROWSE_FILTERS,
    );
    expect(serializeBrowseFilters(DEFAULT_BROWSE_FILTERS)).toBe('');
  });

  test('the view shows "next page" only when the API returned a cursor', async () => {
    const api = pagedApi([]);
    const render = (vm: Awaited<ReturnType<typeof loadBrowsePage>>, cursor: string) =>
      renderToString(
        <MemoryRouter>
          <BrowseView
            vm={vm}
            filters={{ ...DEFAULT_BROWSE_FILTERS, cursor }}
            onFiltersChange={noop}
            onNext={noop}
            onFirst={noop}
          />
        </MemoryRouter>,
      ).replaceAll('<!-- -->', '');

    const first = await loadBrowsePage(api, PROJECT_ID, DEFAULT_BROWSE_FILTERS);
    const firstHtml = render(first, '');
    expect(firstHtml).toContain('Use PGlite for embedded mode');
    expect(firstHtml).toContain('next page');
    expect(firstHtml).not.toContain('first page');

    const last = await loadBrowsePage(api, PROJECT_ID, { ...DEFAULT_BROWSE_FILTERS, cursor: 'opaque-cursor-1' });
    const lastHtml = render(last, 'opaque-cursor-1');
    expect(lastHtml).toContain('end of list');
    expect(lastHtml).toContain('first page');
    expect(lastHtml).not.toContain('next page');
  });
});
