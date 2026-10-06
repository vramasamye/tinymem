/**
 * The one HTTP boundary of the memory explorer.
 *
 * Rules (M10 acceptance: every UI claim backed by API data, no client-side truth):
 * - every response is validated against the wire mirror in `./schemas` before a page
 *   sees it — a shape drift is a thrown `ApiError`, never silently rendered junk;
 * - errors keep the API's own envelope (`{error: {code, message}}`) — the message on
 *   screen is the API's message, never a client-side invention;
 * - the base URL honors `VITE_ONEMEMORY_API`; the default is same-origin relative
 *   (`''`) because the daemon serves `/v1` without CORS — the Vite dev server proxies
 *   `/v1` to it (see `vite.config.ts`), and a same-origin reverse proxy covers deployed
 *   builds.
 */

import {
  HealthResponseSchema,
  InspectResponseSchema,
  MemoryPageResponseSchema,
  MemorySearchResponseSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  SessionContextResponseSchema,
  StatsResponseSchema,
  type HealthResponse,
  type DurableMemoryType,
  type InspectResponse,
  type MemoryPageResponse,
  type MemorySearchRequest,
  type MemorySearchResponse,
  type Project,
  type ProjectListResponse,
  type SessionContextResponse,
  type StatsResponse,
} from './schemas';
import { z } from 'zod';

/** The API's typed error codes (`apps/api/src/server/app.ts` STATUS_BY_CODE). */
export const API_ERROR_CODES = [
  'not_found',
  'invalid_request',
  'conflict',
  'unavailable',
  'internal',
  'invalid_response',
  'network',
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** The API error envelope, 1:1 with `apps/api` `errorBody()`. */
const ErrorResponseEnvelopeSchema = z.strictObject({
  error: z.strictObject({
    code: z.enum(['not_found', 'invalid_request', 'conflict', 'unavailable', 'internal']),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export class ApiError extends Error {
  constructor(
    public readonly code: ApiErrorCode,
    message: string,
    public readonly status: number,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * The base URL for API calls.
 *
 * `''` (default): same-origin — the dev server proxies `/v1` to the daemon; a deployed
 * build sits behind the same origin as the API. `VITE_ONEMEMORY_API`: absolute base
 * (e.g. `http://127.0.0.1:7331`), which requires CORS on the API — documented in the
 * mission report as a follow-up if remote deployments need it.
 */
export function resolveBaseUrl(env: Record<string, string | undefined> = {}): string {
  const raw = env.VITE_ONEMEMORY_API;
  if (raw === undefined || raw === '') return '';
  return raw.replace(/\/+$/, '');
}

export function apiUrl(path: string, baseUrl: string): string {
  if (baseUrl === '') return path;
  return `${baseUrl}${path}`;
}

/** Read-only surface the pages consume (the explorer is a viewer — no write routes). */
export interface ApiClient {
  health(): Promise<HealthResponse>;
  listProjects(): Promise<ProjectListResponse>;
  getProject(projectId: string): Promise<Project>;
  search(projectId: string, request: MemorySearchRequest): Promise<MemorySearchResponse>;
  decisions(projectId: string, options?: ListOptions): Promise<MemorySearchResponse>;
  failures(projectId: string, options?: ListOptions): Promise<MemorySearchResponse>;
  inspect(projectId: string, memoryId: string): Promise<InspectResponse>;
  /** Keyset-paginated browse (newest observation first) — no ranking, no token budget. */
  listMemories(projectId: string, options?: MemoryPageOptions): Promise<MemoryPageResponse>;
  stats(projectId: string): Promise<StatsResponse>;
  context(projectId: string, options?: ContextOptions): Promise<SessionContextResponse>;
}

export interface ListOptions {
  /** Free-text override; the endpoints synthesize `q` per kind when absent. */
  q?: string;
  max_tokens?: number;
  max_memories?: number;
}

export type BrowseIncludeStatus = 'stale' | 'superseded' | 'disputed' | 'archived';

export interface MemoryPageOptions {
  /** The previous page's `next_cursor`, passed back unchanged. */
  cursor?: string;
  page_size?: number;
  types?: readonly DurableMemoryType[];
  include?: readonly BrowseIncludeStatus[];
}

export interface ContextOptions {
  budget?: number;
  session_id?: string;
}

/** The transport the client needs — just the callable shape of fetch (injectable for tests). */
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ApiClientOptions {
  /** Absolute or same-origin-relative base; defaults to `resolveBaseUrl(import.meta.env)`. */
  baseUrl?: string;
  /** Injectable for tests (`bun test`) — defaults to the global fetch. */
  fetchImpl?: FetchLike;
}

/** Default env for the browser build: Vite's `import.meta.env`. */
const env: Record<string, string | undefined> =
  typeof import.meta !== 'undefined' &&
  typeof import.meta.env === 'object' &&
  import.meta.env !== null
    ? (import.meta.env as Record<string, string | undefined>)
    : {};

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const baseUrl = options.baseUrl ?? resolveBaseUrl(env);
  const doFetch: FetchLike = options.fetchImpl ?? globalThis.fetch;

  /** GET + validate. */
  async function get<S extends z.ZodType>(path: string, schema: S): Promise<z.output<S>> {
    return request('GET', path, schema, undefined);
  }

  /** POST + validate. */
  async function post<S extends z.ZodType>(
    path: string,
    schema: S,
    body: unknown,
  ): Promise<z.output<S>> {
    return request('POST', path, schema, body);
  }

  async function request<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    schema: S,
    body: unknown,
  ): Promise<z.output<S>> {
    let response: Response;
    try {
      response = await doFetch(apiUrl(path, baseUrl), {
        method,
        headers:
          body === undefined
            ? { accept: 'application/json' }
            : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (cause) {
      throw new ApiError(
        'network',
        `cannot reach the onememory API (${method} ${path}${baseUrl === '' ? '' : ` at ${baseUrl}`}): ${cause instanceof Error ? cause.message : String(cause)}`,
        0,
        { cause: String(cause) },
      );
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      throw new ApiError(
        'invalid_response',
        `the API returned non-JSON for ${method} ${path} (status ${response.status})`,
        response.status,
      );
    }
    if (!response.ok) {
      const envelope = ErrorResponseEnvelopeSchema.safeParse(parsed);
      if (envelope.success) {
        throw new ApiError(
          envelope.data.error.code,
          envelope.data.error.message,
          response.status,
          envelope.data.error.details,
        );
      }
      throw new ApiError(
        'invalid_response',
        `the API returned an unparseable error for ${method} ${path} (status ${response.status})`,
        response.status,
      );
    }
    const validated = schema.safeParse(parsed);
    if (!validated.success) {
      const detail = validated.error.issues
        .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new ApiError(
        'invalid_response',
        `the API response for ${method} ${path} failed schema validation: ${detail}`,
        response.status,
      );
    }
    return validated.data as z.output<S>;
  }

  const queryString = (params: Record<string, string | number | undefined>): string => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) search.set(key, String(value));
    }
    const encoded = search.toString();
    return encoded === '' ? '' : `?${encoded}`;
  };

  return {
    async health() {
      return get('/v1/health', HealthResponseSchema);
    },
    async listProjects() {
      return get('/v1/projects', ProjectListResponseSchema);
    },
    async getProject(projectId: string) {
      return get(`/v1/projects/${encodeURIComponent(projectId)}`, ProjectSchema);
    },
    async search(projectId: string, request: MemorySearchRequest) {
      return post(
        `/v1/projects/${encodeURIComponent(projectId)}/search`,
        MemorySearchResponseSchema,
        { ...request, project_id: projectId },
      );
    },
    async decisions(projectId: string, options: ListOptions = {}) {
      return get(
        `/v1/projects/${encodeURIComponent(projectId)}/decisions${queryString({
          q: options.q,
          max_tokens: options.max_tokens,
          max_memories: options.max_memories,
        })}`,
        MemorySearchResponseSchema,
      );
    },
    async failures(projectId: string, options: ListOptions = {}) {
      return get(
        `/v1/projects/${encodeURIComponent(projectId)}/failures${queryString({
          q: options.q,
          max_tokens: options.max_tokens,
          max_memories: options.max_memories,
        })}`,
        MemorySearchResponseSchema,
      );
    },
    async inspect(projectId: string, memoryId: string) {
      return get(
        `/v1/projects/${encodeURIComponent(projectId)}/memories/${encodeURIComponent(memoryId)}`,
        InspectResponseSchema,
      );
    },
    async listMemories(projectId: string, options: MemoryPageOptions = {}) {
      return get(
        `/v1/projects/${encodeURIComponent(projectId)}/memories${queryString({
          cursor: options.cursor,
          page_size: options.page_size,
          types: options.types === undefined || options.types.length === 0 ? undefined : options.types.join(','),
          include:
            options.include === undefined || options.include.length === 0 ? undefined : options.include.join(','),
        })}`,
        MemoryPageResponseSchema,
      );
    },
    async stats(projectId: string) {
      return get(`/v1/projects/${encodeURIComponent(projectId)}/stats`, StatsResponseSchema);
    },
    async context(projectId: string, options: ContextOptions = {}) {
      return get(
        `/v1/projects/${encodeURIComponent(projectId)}/context${queryString({
          budget: options.budget,
          session_id: options.session_id,
        })}`,
        SessionContextResponseSchema,
      );
    },
  };
}
