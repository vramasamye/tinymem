/**
 * The memories surface: full-text + structured search over the project's memories.
 *
 * The controller maps the page's filters onto the search request 1:1 (the API is
 * the only validator — an impossible filter produces the API's 400, not a
 * client-side guess) and passes the response through untouched: rows, tokens,
 * warnings and query understanding are exactly what the API returned.
 */

import type { ApiClient } from '../../api/client';
import type {
  DurableMemoryType,
  MemorySearchRequest,
  MemorySearchResponse,
} from '../../api/schemas';

export type IncludeStatus = 'stale' | 'superseded' | 'archived' | 'disputed';

export interface MemoriesFilters {
  readonly query: string;
  /** Empty = all durable types (working memory never lists here — it is session-scoped). */
  readonly types: readonly DurableMemoryType[];
  readonly include: readonly IncludeStatus[];
  readonly entities: readonly string[];
  readonly temporalMode: 'current' | 'historical';
  /** ISO date string or '' (no point-in-time filter). */
  readonly asOf: string;
  readonly explain: boolean;
  readonly maxTokens: number;
}

export const DEFAULT_MEMORIES_FILTERS: MemoriesFilters = {
  query: '',
  types: [],
  include: [],
  entities: [],
  temporalMode: 'current',
  asOf: '',
  explain: true,
  maxTokens: 800,
};

/**
 * Build the search request from the filters. The `fallbackQuery` (the active
 * project's name, from the API) fills an empty query — the same synthesis the
 * API's own typed-list endpoints use (`query: options.query ?? kind`).
 */
export function buildSearchRequest(
  filters: MemoriesFilters,
  fallbackQuery: string,
): MemorySearchRequest {
  const query = filters.query.trim() || fallbackQuery;
  return {
    query,
    ...(filters.types.length === 0 ? {} : { types: [...filters.types] }),
    ...(filters.include.length === 0 ? {} : { include: [...filters.include] }),
    ...(filters.entities.length === 0 ? {} : { entities: [...filters.entities] }),
    ...(filters.temporalMode === 'historical' ? { temporal_mode: 'historical' } : {}),
    ...(filters.asOf === '' ? {} : { as_of: filters.asOf }),
    explain: filters.explain,
    max_tokens: filters.maxTokens,
  };
}

export interface MemoriesViewModel {
  /** The query actually sent (filters.query or the project-name fallback). */
  readonly querySent: string;
  readonly understanding: MemorySearchResponse['query_understanding'];
  readonly memories: MemorySearchResponse['memories'];
  readonly tokens: MemorySearchResponse['tokens'];
  readonly warnings: MemorySearchResponse['warnings'];
}

export async function loadMemories(
  api: ApiClient,
  projectId: string,
  filters: MemoriesFilters,
  fallbackQuery: string,
): Promise<MemoriesViewModel> {
  const request = buildSearchRequest(filters, fallbackQuery);
  const response = await api.search(projectId, request);
  return {
    querySent: request.query,
    understanding: response.query_understanding,
    memories: response.memories,
    tokens: response.tokens,
    warnings: response.warnings,
  };
}

// ---------------------------------------------------------------------------
// URL synchronization (deep-linkable filters)
// ---------------------------------------------------------------------------

import { useSearchParams } from 'react-router';
import { useCallback, useMemo } from 'react';

const TYPE_SEPARATOR = ',';

/** Filters ← query string. Unknown/empty params fall back to the typed defaults. */
export function parseFilters(params: URLSearchParams): MemoriesFilters {
  const types = (params.get('types') ?? '')
    .split(TYPE_SEPARATOR)
    .map((type) => type.trim())
    .filter((type): type is DurableMemoryType =>
      ['episodic', 'semantic', 'procedural', 'decision', 'failure', 'preference'].includes(type),
    );
  const include = (params.get('include') ?? '')
    .split(TYPE_SEPARATOR)
    .map((status) => status.trim())
    .filter((status): status is IncludeStatus =>
      ['stale', 'superseded', 'archived', 'disputed'].includes(status),
    );
  const temporalMode = params.get('mode') === 'historical' ? 'historical' : 'current';
  return {
    query: params.get('q') ?? '',
    types,
    include,
    entities: (params.get('entities') ?? '')
      .split(TYPE_SEPARATOR)
      .map((entity) => entity.trim())
      .filter((entity) => entity !== ''),
    temporalMode,
    asOf: params.get('asOf') ?? '',
    explain: params.get('explain') !== 'false',
    maxTokens: (() => {
      const raw = Number(params.get('maxTokens'));
      return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MEMORIES_FILTERS.maxTokens;
    })(),
  };
}

/** Filters → query string (only non-defaults, so URLs stay readable). */
export function serializeFilters(filters: MemoriesFilters): string {
  const params = new URLSearchParams();
  if (filters.query !== '') params.set('q', filters.query);
  if (filters.types.length > 0) params.set('types', filters.types.join(TYPE_SEPARATOR));
  if (filters.include.length > 0) params.set('include', filters.include.join(TYPE_SEPARATOR));
  if (filters.entities.length > 0) params.set('entities', filters.entities.join(TYPE_SEPARATOR));
  if (filters.temporalMode !== 'current') params.set('mode', filters.temporalMode);
  if (filters.asOf !== '') params.set('asOf', filters.asOf);
  if (!filters.explain) params.set('explain', 'false');
  if (filters.maxTokens !== DEFAULT_MEMORIES_FILTERS.maxTokens) {
    params.set('maxTokens', String(filters.maxTokens));
  }
  const encoded = params.toString();
  return encoded === '' ? '' : `?${encoded}`;
}

/** The page hook: filters live in the URL; changes replace history (search-like UX). */
export function useMemoriesFilters(): {
  filters: MemoriesFilters;
  setFilters(next: MemoriesFilters): void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const filters = useMemo(() => parseFilters(searchParams), [searchParams]);
  const setFilters = useCallback(
    (next: MemoriesFilters) => {
      setSearchParams(new URLSearchParams(serializeFilters(next).replace(/^\?/, '')), {
        replace: false,
      });
    },
    [setSearchParams],
  );
  return { filters, setFilters };
}
