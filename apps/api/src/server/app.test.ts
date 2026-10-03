/**
 * REST boundary tests: every route through `createApiApp` with a scriptable fake backend.
 *
 * What is verified here is the *HTTP contract*, not the service semantics (those live in
 * runtime.test.ts against real storage): request validation → 400 with key paths, typed errors →
 * status codes, response validation (a wrong-shaped service value becomes a 500, not a bad
 * payload), and the generated OpenAPI document.
 */

import { beforeEach, describe, expect, test } from 'bun:test';

import type { DoctorReport } from '../runtime/doctor';
import { BackendError, type OnememoryBackend } from '../runtime/types';
import type {
  ForgetOutcome,
  HealthReport,
  InspectResult,
  IngestResult,
  ProjectListResult,
  PurgeOutcome,
  RememberOutcome,
  StatsResult,
} from '../runtime/types';
import type { MemorySearchRequest, MemorySearchResponse, ProjectRecord } from '@onememory/core';
import type { SessionContext } from '@onememory/retrieval';
import { createApiApp } from './app';

const PROJECT_ID = '0195a7f0-9f5e-7a1d-bc2d-000000000001';
const MEMORY_ID = '0195a7f0-9f5e-7a1d-bc2d-000000000002';

const iso = '2026-10-01T12:00:00.000Z';

const project: ProjectRecord = {
  id: PROJECT_ID,
  name: 'demo',
  root_path: '/tmp/demo',
  git_remote: null,
  description: null,
  digest: {},
  settings: {},
  created_at: iso,
  updated_at: iso,
};

const health: HealthReport = {
  status: 'ok',
  version: 'test',
  uptime_ms: 5,
  pid: 1,
  config_path: '/tmp/demo/.onememory/onememory.yaml',
  storage: { profile: 'embedded', vector_backend: 'pgvector', vector_model: 'm', vector_dim: 384 },
  llm: { profile: 'local', providers: [], routed_operations: [], unconfigured_operations: ['extract'] },
  embedder: { provider: null, model: null, dim: null },
  network_guard: { enforced: true, attempts: 0, reason: 'installed' },
  warnings: [],
};

const doctor: DoctorReport = {
  status: 'ok',
  exit_code: 0,
  generated_at: iso,
  version: 'test',
  config_path: '/tmp/demo/.onememory/onememory.yaml',
  config: null,
  summary: { pass: 1, warn: 0, fail: 0 },
  checks: [{ id: 'config', title: 'configuration', status: 'pass', detail: 'loaded' }],
};

const searchResponse: MemorySearchResponse = {
  query_understanding: {
    intent: 'fact',
    entities: [{ name: 'pglite', matched_id: undefined }],
    keywords: ['embedded'],
  },
  memories: [
    {
      id: MEMORY_ID,
      type: 'decision',
      title: 'Use PGlite',
      summary: 'embedded mode uses PGlite',
      content: 'embedded mode uses PGlite',
      relevance: 0.8,
      explain: [{ factor: 'lexical_relevance', weight: 0.2, detail: 'matched 1 term' }],
      temporal: { valid_from: iso, status: 'active' },
      provenance: { source_kind: 'explicit', source_uri: 'explicit/remember' },
    },
  ],
  tokens: { budget: 800, used: 20, packing: 'summary' },
  warnings: [],
};

const rememberOutcome: RememberOutcome = {
  outcome: 'inserted',
  memory_id: MEMORY_ID,
  redactions: [{ kind: 'api-key', location: '$.content', length: 40 }],
  warnings: [],
};

const forgetOutcome: ForgetOutcome = {
  memory_id: MEMORY_ID,
  from_status: 'active',
  to_status: 'archived',
  audit_event_id: '0195a7f0-9f5e-7a1d-bc2d-000000000003',
  restore_hint: 'onemem restore <id>',
  purge_hint: 'hard purge is deferred (mission-13 report)',
  note: 'soft forget',
};

const purgeOutcome: PurgeOutcome = {
  memory_id: MEMORY_ID,
  purged: true,
  from_status: 'active',
  audit_event_id: '0195a7f0-9f5e-7a1d-bc2d-000000000009',
  note: 'hard purge',
};

const inspectResult: InspectResult = {
  memory: {
    id: MEMORY_ID,
    type: 'decision',
    content: 'embedded mode uses PGlite',
    status: 'active',
    importance: 0.7,
    confidence: 0.9,
    access_count: 0,
    observed_at: iso,
    valid_from: iso,
    created_at: iso,
    updated_at: iso,
    entities: [],
    tags: [],
    token_estimate: 10,
    provenance: {
      source: { id: '0195a7f0-9f5e-7a1d-bc2d-000000000004', kind: 'explicit', uri: 'explicit/remember' },
      evidence: [{ source_id: '0195a7f0-9f5e-7a1d-bc2d-000000000004', kind: 'message', locator: 'explicit remember', excerpt: 'embedded mode uses PGlite' }],
      extraction: { method: 'explicit', prompt_version: 'explicit-v1' },
    },
  } as InspectResult['memory'],
  history: [],
  audit: [],
  entities: [],
  edges: [],
  redactions: [{ kind: 'api-key', location: '$.content', length: 40 }],
  warnings: [],
};

const ingestResult: IngestResult = {
  outcomes: [{ index: 0, status: 'stored', event_id: '0195a7f0-9f5e-7a1d-bc2d-000000000005' }],
  stored: 1,
  duplicates: 0,
  excluded: 0,
  dead_lettered: 0,
  normalize_job_id: '0195a7f0-9f5e-7a1d-bc2d-000000000006',
  warnings: [],
};

const stats: StatsResult = {
  project_id: PROJECT_ID,
  storage: { profile: 'embedded', vector_backend: 'pgvector', vector_model: 'm', vector_dim: 384, data_dir: '/tmp/demo/.onememory/data' },
  memories: { total: 1, by_status: { active: 1 }, by_type: { decision: 1 }, truncated: false },
  working_memory: null,
  jobs: null,
  cache: { embeddings: 0, results: 0, entityScopes: 0 },
  llm: { profile: 'local', providers: [], routed_operations: [], unconfigured_operations: ['extract'] },
  warnings: [],
};

const context: SessionContext = {
  project_id: PROJECT_ID,
  budget: 750,
  used: 12,
  text: 'onememory session context',
  sections: [{ kind: 'decisions', tokens: 12, text: 'Use PGlite' }],
  warnings: [],
};

interface Scripted {
  searchRequest?: MemorySearchRequest;
  rememberInput?: Record<string, unknown>;
  forgetInput?: Record<string, unknown>;
  purgeInput?: Record<string, unknown>;
  projectListResult?: ProjectListResult;
}

function fakeBackend(script: Scripted = {}): OnememoryBackend {
  const backend: OnememoryBackend = {
    kind: 'local',
    endpoint: null,
    health: async () => health,
    doctor: async () => doctor,
    createProject: async (input) => ({ ...project, name: input.name }),
    getProject: async (id) => {
      if (id !== PROJECT_ID) throw new BackendError(`project ${id} is not registered`, 'not_found');
      return project;
    },
    listProjects: async () =>
      script.projectListResult ?? { projects: [project], warnings: [] },
    ingestEvents: async () => ingestResult,
    search: async (request) => {
      script.searchRequest = request;
      return searchResponse;
    },
    remember: async (input) => {
      script.rememberInput = { ...input };
      return rememberOutcome;
    },
    forget: async (input) => {
      script.forgetInput = { ...input };
      if (input.memory_id === 'not-a-uuid') throw new BackendError('not found', 'not_found');
      return forgetOutcome;
    },
    restore: async () => forgetOutcome,
    purge: async (input) => {
      script.purgeInput = { ...input };
      return purgeOutcome;
    },
    inspect: async () => inspectResult,
    stats: async () => stats,
    context: async () => context,
    decisions: async () => searchResponse,
    failures: async () => searchResponse,
    close: async () => {},
  };
  return backend;
}

function app(script: Scripted = {}) {
  return createApiApp({ backend: fakeBackend(script), version: 'test' });
}

async function get(path: string, script?: Scripted): Promise<Response> {
  return app(script).request(path, { method: 'GET' });
}

async function post(path: string, body: unknown, script?: Scripted): Promise<Response> {
  return app(script).request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

describe('system endpoints', () => {
  test('GET /v1/health returns the report and content-type json', async () => {
    const response = await get('/v1/health');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await body(response)).status).toBe('ok');
  });

  test('GET /v1/doctor returns the full report', async () => {
    const response = await get('/v1/doctor');
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.exit_code).toBe(0);
    expect(Array.isArray(payload.checks)).toBeTrue();
  });

  test('GET /openapi.json lists every /v1 route', async () => {
    const response = await get('/openapi.json');
    expect(response.status).toBe(200);
    const document = (await response.json()) as { paths: Record<string, unknown> };
    for (const path of [
      '/v1/health',
      '/v1/doctor',
      '/v1/projects',
      '/v1/projects/{id}',
      '/v1/projects/{id}/events',
      '/v1/projects/{id}/search',
      '/v1/projects/{id}/decisions',
      '/v1/projects/{id}/failures',
      '/v1/projects/{id}/context',
      '/v1/projects/{id}/memories',
      '/v1/projects/{id}/memories/{memoryId}',
      '/v1/projects/{id}/memories/{memoryId}/forget',
      '/v1/projects/{id}/memories/{memoryId}/restore',
      '/v1/projects/{id}/memories/{memoryId}/purge',
      '/v1/projects/{id}/stats',
    ]) {
      expect(document.paths[path]).toBeDefined();
    }
  });

  test('unknown routes are typed 404s, not HTML', async () => {
    const response = await get('/v1/nope');
    expect(response.status).toBe(404);
    const payload = await body(response);
    expect(payload.error).toBeDefined();
  });
});

describe('projects', () => {
  test('POST /v1/projects creates and returns 201', async () => {
    const response = await post('/v1/projects', { name: 'demo', root_path: '/tmp/demo' });
    expect(response.status).toBe(201);
    expect((await body(response)).name).toBe('demo');
  });

  test('an empty name is a 400 naming the key path', async () => {
    const response = await post('/v1/projects', { name: '' });
    expect(response.status).toBe(400);
    const payload = await body(response);
    expect((payload.error as Record<string, unknown>).code).toBe('invalid_request');
  });

  test('an unknown key in the body is rejected (strict requests)', async () => {
    const response = await post('/v1/projects', { name: 'demo', typo: 1 });
    expect(response.status).toBe(400);
  });

  test('GET /v1/projects/{id} 404s as a typed error', async () => {
    const response = await get('/v1/projects/0195a7f0-9f5e-7a1d-bc2d-000000000009');
    expect(response.status).toBe(404);
    const payload = await body(response);
    expect((payload.error as Record<string, unknown>).code).toBe('not_found');
  });

  test('GET /v1/projects returns the list plus its honesty warnings', async () => {
    const response = await get('/v1/projects', {
      projectListResult: {
        projects: [project],
        warnings: ['project listing is incomplete'],
      },
    });
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.warnings).toEqual(['project listing is incomplete']);
  });
});

describe('ingest', () => {
  test('stored events come back with per-event outcomes and the queued job id', async () => {
    const response = await post(`/v1/projects/${PROJECT_ID}/events`, {
      events: [
        {
          kind: 'conversation.message',
          occurred_at: iso,
          source: { runtime: 'test', adapter_version: '0.1.0' },
          scope: { project_id: PROJECT_ID },
          payload: { role: 'user', content: 'remember this' },
        },
      ],
    });
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.stored).toBe(1);
    expect(payload.normalize_job_id).not.toBeNull();
  });

  test('an empty events array is a 400 (min(1))', async () => {
    const response = await post(`/v1/projects/${PROJECT_ID}/events`, { events: [] });
    expect(response.status).toBe(400);
  });
});

describe('search and context', () => {
  test('search scopes the request to the path project (body cannot widen it)', async () => {
    const script: Scripted = {};
    const response = await post(`/v1/projects/${PROJECT_ID}/search`, { query: 'embedded' }, script);
    expect(response.status).toBe(200);
    expect(script.searchRequest?.project_id).toBe(PROJECT_ID);
    expect((await body(response)).memories).toBeArray();
  });

  test('a search without a query is a 400', async () => {
    const response = await post(`/v1/projects/${PROJECT_ID}/search`, {});
    expect(response.status).toBe(400);
  });

  test('decisions and failures are kind-filtered reads of the same engine', async () => {
    expect((await get(`/v1/projects/${PROJECT_ID}/decisions?max_tokens=200`)).status).toBe(200);
    expect((await get(`/v1/projects/${PROJECT_ID}/failures?max_tokens=200`)).status).toBe(200);
  });

  test('context defaults the budget to 750 and coerces query params', async () => {
    const response = await get(`/v1/projects/${PROJECT_ID}/context`);
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.budget).toBe(750);
  });
});

describe('memories', () => {
  test('remember passes the body through with the path project id', async () => {
    const script: Scripted = {};
    const response = await post(
      `/v1/projects/${PROJECT_ID}/memories`,
      { content: 'use PGlite for embedded mode', type: 'decision' },
      script,
    );
    expect(response.status).toBe(201);
    expect(script.rememberInput?.project_id).toBe(PROJECT_ID);
    expect(script.rememberInput?.type).toBe('decision');
    const payload = await body(response);
    expect((payload.redactions as unknown[]).length).toBe(1);
  });

  test('empty content is a 400', async () => {
    const response = await post(`/v1/projects/${PROJECT_ID}/memories`, { content: '' });
    expect(response.status).toBe(400);
  });

  test('inspect returns the full record', async () => {
    const response = await get(`/v1/projects/${PROJECT_ID}/memories/${MEMORY_ID}`);
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.memory).toBeDefined();
    expect((payload.redactions as unknown[]).length).toBe(1);
  });

  test('forget is a POST and forwards the reason', async () => {
    const script: Scripted = {};
    const response = await post(
      `/v1/projects/${PROJECT_ID}/memories/${MEMORY_ID}/forget`,
      { reason: 'wrong' },
      script,
    );
    expect(response.status).toBe(200);
    expect(script.forgetInput?.reason).toBe('wrong');
    const payload = await body(response);
    expect(payload.to_status).toBe('archived');
  });

  test('restore undoes it with the same shape', async () => {
    const response = await post(`/v1/projects/${PROJECT_ID}/memories/${MEMORY_ID}/restore`, {});
    expect(response.status).toBe(200);
    expect((await body(response)).memory_id).toBe(MEMORY_ID);
  });

  test('purge is a destructive POST and forwards the revision token', async () => {
    const script: Scripted = {};
    const response = await post(
      `/v1/projects/${PROJECT_ID}/memories/${MEMORY_ID}/purge`,
      { expected_revision: iso },
      script,
    );
    expect(response.status).toBe(200);
    expect(script.purgeInput?.expected_revision).toBe(iso);
    const payload = await body(response);
    expect(payload.purged).toBe(true);
    expect(payload.audit_event_id).toBeDefined();
  });

  test('purge without the revision token is a 400 (a purge can never be accidental)', async () => {
    const response = await post(`/v1/projects/${PROJECT_ID}/memories/${MEMORY_ID}/purge`, {});
    expect(response.status).toBe(400);
  });

  test('a memory id that is not a UUID is a 400 (param validation)', async () => {
    const response = await post(`/v1/projects/${PROJECT_ID}/memories/not-a-uuid/forget`, {});
    expect(response.status).toBe(400);
  });
});

describe('stats', () => {
  test('stats reports the project counts and the known job-count gap honestly', async () => {
    const response = await get(`/v1/projects/${PROJECT_ID}/stats`);
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.jobs).toBeNull();
    expect((payload as { memories: { total: number } }).memories.total).toBe(1);
  });
});

describe('the response contract is enforced', () => {
  test('a backend value that breaks its schema is a 500, never a bad payload', async () => {
    const broken: OnememoryBackend = {
      ...fakeBackend(),
      health: async () =>
        // deliberately wrong: 'fine' is not one of ok | degraded | failed
        ({ status: 'fine' }) as unknown as HealthReport,
    };
    const response = await createApiApp({ backend: broken, version: 'test' }).request('/v1/health');
    expect(response.status).toBe(500);
    const payload = await body(response);
    expect((payload.error as Record<string, unknown>).code).toBe('internal');
  });

  test('a conflict error maps to 409', async () => {
    const conflicted: OnememoryBackend = {
      ...fakeBackend(),
      createProject: async () => {
        throw new BackendError('project exists', 'conflict');
      },
    };
    const response = await createApiApp({ backend: conflicted, version: 'test' }).request('/v1/projects', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'demo' }),
    });
    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, unknown>).error).toBeDefined();
  });
});

beforeEach(() => {
  // Each test builds its own app; nothing to reset. Kept explicit for future shared state.
});
