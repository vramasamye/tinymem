/**
 * The HTTP boundary test: URL building (base-URL env), the API's error envelope
 * mapping, and boundary validation — the wrapper may not pass a response that
 * fails its schema, and it may not invent an error shape the API did not send.
 */

import { describe, expect, test } from 'bun:test';

import {
  ApiError,
  apiUrl,
  createApiClient,
  resolveBaseUrl,
  type ApiClient,
  type FetchLike,
} from './client';
import {
  PROJECT_ID,
  anchorUrl,
  apiErrorBody,
  defaultStubRoutes,
  fixtureHealth,
  fixtureSearchResponse,
  jsonResponse,
  stubApi,
} from '../test/fixtures';

/** One captured client call: the exact URL, method, headers and parsed body sent. */
export interface RecordedCall {
  url: string;
  method: string;
  contentType: string | null;
  body?: unknown;
}

interface RecordingStub {
  (input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  calls: RecordedCall[];
}

function recordingStub(routes: Parameters<typeof stubApi>[0]): RecordingStub {
  const calls: RecordedCall[] = [];
  const inner = stubApi(routes);
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(anchorUrl(input), init);
    calls.push({
      url: typeof input === 'string' ? input : request.url,
      method: request.method,
      contentType: request.headers.get('content-type'),
      body:
        init?.body === undefined
          ? undefined
          : (JSON.parse(String(init.body)) as unknown),
    });
    return inner(input, init);
  }) as RecordingStub;
  fn.calls = calls;
  return fn;
}

/** A client wired to the stub; `stub.calls` records what the client sent. */
function stubbedClient(routes: Parameters<typeof stubApi>[0]): {
  api: ApiClient;
  stub: RecordingStub;
} {
  const stub = recordingStub(routes);
  return { api: createApiClient({ fetchImpl: stub }), stub };
}

function clientWithBaseUrl(routes: Parameters<typeof stubApi>[0], baseUrl: string): {
  api: ApiClient;
  stub: RecordingStub;
} {
  const stub = recordingStub(routes);
  return { api: createApiClient({ baseUrl, fetchImpl: stub }), stub };
}

describe('base URL resolution', () => {
  test('defaults to same-origin relative (the daemon serves /v1 without CORS)', () => {
    expect(resolveBaseUrl({})).toBe('');
    expect(resolveBaseUrl({ VITE_ONEMEMORY_API: '' })).toBe('');
  });

  test('honors VITE_ONEMEMORY_API and strips trailing slashes', () => {
    expect(resolveBaseUrl({ VITE_ONEMEMORY_API: 'http://127.0.0.1:7331' })).toBe(
      'http://127.0.0.1:7331',
    );
    expect(resolveBaseUrl({ VITE_ONEMEMORY_API: 'http://127.0.0.1:7331///' })).toBe(
      'http://127.0.0.1:7331',
    );
  });

  test('relative base keeps the path untouched; absolute base prefixes it', () => {
    expect(apiUrl('/v1/health', '')).toBe('/v1/health');
    expect(apiUrl('/v1/health', 'http://127.0.0.1:7331')).toBe('http://127.0.0.1:7331/v1/health');
  });
});

describe('happy paths hit the real route shapes', () => {
  test('GET /v1/health validates and types the response', async () => {
    const { api, stub } = stubbedClient(defaultStubRoutes());
    const health = await api.health();
    expect(health.version).toBe('0.1.0-fixture');
    expect(health.storage.profile).toBe('embedded');
    expect(stub.calls.length).toBe(1);
    expect(stub.calls[0]?.url).toBe('/v1/health');
  });

  test('POST search sends the filters as the request body, project pinned by path id', async () => {
    const { api, stub } = stubbedClient(defaultStubRoutes());
    await api.search(PROJECT_ID, {
      query: 'pglite',
      types: ['decision'],
      include: ['stale'],
      explain: true,
      max_tokens: 500,
    });
    expect(stub.calls[0]?.method).toBe('POST');
    expect(stub.calls[0]?.url).toBe(`/v1/projects/${PROJECT_ID}/search`);
    expect(stub.calls[0]?.contentType).toBe('application/json');
    expect(stub.calls[0]?.body).toEqual({
      query: 'pglite',
      types: ['decision'],
      include: ['stale'],
      explain: true,
      max_tokens: 500,
      project_id: PROJECT_ID,
    });
    // A body project_id may never widen the scope: the path project is authoritative.
    await api.search(PROJECT_ID, {
      query: 'q',
      project_id: '00000000-0000-7000-8000-000000000000',
    } as Parameters<typeof api.search>[1]);
    expect(stub.calls[1]?.body).toMatchObject({ project_id: PROJECT_ID });
  });

  test('decisions/failures list the typed endpoints with query params', async () => {
    const { api, stub } = stubbedClient(defaultStubRoutes());
    await api.decisions(PROJECT_ID, { max_memories: 5 });
    expect(stub.calls[0]?.url).toBe(`/v1/projects/${PROJECT_ID}/decisions?max_memories=5`);
    await api.failures(PROJECT_ID, { q: 'migration', max_tokens: 300 });
    expect(stub.calls[1]?.url).toBe(
      `/v1/projects/${PROJECT_ID}/failures?q=migration&max_tokens=300`,
    );
  });

  test('inspect hits the memory route', async () => {
    const { api, stub } = stubbedClient(defaultStubRoutes());
    const inspect = await api.inspect(PROJECT_ID, '0195a7f0-9f5e-7a1d-bc2d-000000000002');
    expect(inspect.memory.status).toBe('active');
    expect(stub.calls[0]?.url).toBe(
      `/v1/projects/${PROJECT_ID}/memories/0195a7f0-9f5e-7a1d-bc2d-000000000002`,
    );
  });

  test('context passes budget and session', async () => {
    const { api, stub } = stubbedClient(defaultStubRoutes());
    await api.context(PROJECT_ID, { budget: 400 });
    expect(stub.calls[0]?.url).toBe(`/v1/projects/${PROJECT_ID}/context?budget=400`);
  });

  test('an absolute base URL prefixes every route', async () => {
    const { api, stub } = clientWithBaseUrl(defaultStubRoutes(), 'http://127.0.0.1:7331');
    await api.health();
    expect(stub.calls[0]?.url).toBe('http://127.0.0.1:7331/v1/health');
  });
});

describe('the API error envelope is preserved verbatim', () => {
  test('a typed error maps code + message + status onto ApiError', async () => {
    const { api } = stubbedClient({
      'GET /v1/health': jsonResponse(apiErrorBody('unavailable', 'storage is locked'), 503),
    });
    try {
      await api.health();
      throw new Error('expected health() to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      const apiError = error as ApiError;
      expect(apiError.code).toBe('unavailable');
      expect(apiError.message).toBe('storage is locked');
      expect(apiError.status).toBe(503);
    }
  });

  test('a 404 from the router keeps the not_found envelope', async () => {
    const { api } = stubbedClient({}); // no routes → the stub's notFound shape
    try {
      await api.listProjects();
      throw new Error('expected listProjects() to throw');
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.code).toBe('not_found');
      expect(apiError.status).toBe(404);
      expect(apiError.message).toContain('no route for');
    }
  });

  test('an unparseable error body is an invalid_response, never a fake API message', async () => {
    const { api } = stubbedClient({
      'GET /v1/health': new Response('gateway html', { status: 502 }),
    });
    try {
      await api.health();
      throw new Error('expected health() to throw');
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.code).toBe('invalid_response');
      expect(apiError.status).toBe(502);
    }
  });
});

describe('boundary validation', () => {
  test('a response that fails its schema is an invalid_response error, not junk data', async () => {
    const brokenHealth = { ...fixtureHealth(), status: 'not-a-status' };
    const { api } = stubbedClient({ 'GET /v1/health': brokenHealth });
    try {
      await api.health();
      throw new Error('expected health() to throw');
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.code).toBe('invalid_response');
      expect(apiError.message).toContain('failed schema validation');
      expect(apiError.message).toContain('status');
    }
  });

  test('a search response missing the tokens block is rejected at the boundary', async () => {
    const broken = fixtureSearchResponse() as Record<string, unknown>;
    delete broken.tokens;
    const { api } = stubbedClient({
      [`POST /v1/projects/${PROJECT_ID}/search`]: broken,
    });
    try {
      await api.search(PROJECT_ID, { query: 'pglite' });
      throw new Error('expected search() to throw');
    } catch (error) {
      expect((error as ApiError).code).toBe('invalid_response');
    }
  });
});

describe('transport failures', () => {
  test('a refused connection becomes a network ApiError naming the route', async () => {
    const failing: FetchLike = () => {
      throw new TypeError('fetch failed');
    };
    const api = createApiClient({ baseUrl: 'http://127.0.0.1:9', fetchImpl: failing });
    try {
      await api.health();
      throw new Error('expected health() to throw');
    } catch (error) {
      const apiError = error as ApiError;
      expect(apiError.code).toBe('network');
      expect(apiError.status).toBe(0);
      expect(apiError.message).toContain('GET /v1/health');
      expect(apiError.message).toContain('http://127.0.0.1:9');
      expect(apiError.message).toContain('fetch failed');
    }
  });
});
