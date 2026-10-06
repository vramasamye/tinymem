/**
 * The browse surface: every memory of the project, newest observation first, one keyset
 * page at a time (`GET /v1/projects/{id}/memories`). Unlike the search surface there is
 * no ranking and no token budget, so the list can be walked to the end.
 *
 * The cursor is the API's opaque `next_cursor`, carried in the URL so a page is
 * deep-linkable; "next" pushes history, so the browser's back button returns to the
 * previous page without the client inventing a reverse cursor.
 */

import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router';

import type { ApiClient, BrowseIncludeStatus } from '../../api/client';
import type { DurableMemoryType, MemoryPageResponse } from '../../api/schemas';

export const BROWSE_PAGE_SIZES = [25, 50, 100] as const;
export const DEFAULT_BROWSE_PAGE_SIZE = 50;

export interface BrowseFilters {
  readonly types: readonly DurableMemoryType[];
  readonly include: readonly BrowseIncludeStatus[];
  readonly pageSize: number;
  /** '' = the first page. */
  readonly cursor: string;
}

export const DEFAULT_BROWSE_FILTERS: BrowseFilters = {
  types: [],
  include: [],
  pageSize: DEFAULT_BROWSE_PAGE_SIZE,
  cursor: '',
};

const DURABLE = ['episodic', 'semantic', 'procedural', 'decision', 'failure', 'preference'];
const INCLUDE = ['stale', 'superseded', 'disputed', 'archived'];

const list = (raw: string | null): string[] =>
  (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');

export function parseBrowseFilters(params: URLSearchParams): BrowseFilters {
  const size = Number(params.get('size'));
  return {
    types: list(params.get('types')).filter((type): type is DurableMemoryType => DURABLE.includes(type)),
    include: list(params.get('include')).filter((status): status is BrowseIncludeStatus =>
      INCLUDE.includes(status),
    ),
    pageSize: (BROWSE_PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_BROWSE_PAGE_SIZE,
    cursor: params.get('cursor') ?? '',
  };
}

export function serializeBrowseFilters(filters: BrowseFilters): string {
  const params = new URLSearchParams();
  if (filters.types.length > 0) params.set('types', filters.types.join(','));
  if (filters.include.length > 0) params.set('include', filters.include.join(','));
  if (filters.pageSize !== DEFAULT_BROWSE_PAGE_SIZE) params.set('size', String(filters.pageSize));
  if (filters.cursor !== '') params.set('cursor', filters.cursor);
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

export interface BrowseViewModel {
  readonly memories: MemoryPageResponse['memories'];
  readonly nextCursor: string | null;
  readonly isFirstPage: boolean;
}

export async function loadBrowsePage(
  api: ApiClient,
  projectId: string,
  filters: BrowseFilters,
): Promise<BrowseViewModel> {
  const page = await api.listMemories(projectId, {
    page_size: filters.pageSize,
    ...(filters.cursor === '' ? {} : { cursor: filters.cursor }),
    ...(filters.types.length === 0 ? {} : { types: filters.types }),
    ...(filters.include.length === 0 ? {} : { include: filters.include }),
  });
  return { memories: page.memories, nextCursor: page.next_cursor, isFirstPage: filters.cursor === '' };
}

/** Filters live in the URL. A filter change restarts at the first page (cursors are filter-bound). */
export function useBrowseFilters(): {
  filters: BrowseFilters;
  setFilters(next: Omit<BrowseFilters, 'cursor'>): void;
  goToCursor(cursor: string): void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseBrowseFilters(searchParams), [searchParams]);
  const write = useCallback(
    (next: BrowseFilters) =>
      setSearchParams(new URLSearchParams(serializeBrowseFilters(next).replace(/^\?/, ''))),
    [setSearchParams],
  );
  return {
    filters,
    setFilters: (next) => write({ ...next, cursor: '' }),
    goToCursor: (cursor) => write({ ...filters, cursor }),
  };
}
