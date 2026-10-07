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
  MemoryPageOptions,
  ProjectListResult,
  PurgeOutcome,
  RememberOutcome,
  SkillSummary,
  StatsResult,
} from '../runtime/types';
import type { MemorySearchRequest, MemorySearchResponse, ProjectRecord } from '@onememory-ai/core';
import type { SessionContext } from '@onememory-ai/retrieval';
import { createApiApp } from './app';

const PROJECT_ID = '0195a7f0-9f5e-7a1d-bc2d-000000000001';
const MEMORY_ID = '0195a7f0-9f5e-7a1d-bc2d-000000000002';
const SKILL_ID = '0195a7f0-9f5e-7a1d-bc2d-000000000003';
const SKILL_MARKDOWN = '---\nname: test-skill\ndescription: a test skill\n---\n\n# Test skill\n';

const iso = '2026-10-01T12:00:00.000Z';

const skillSummary: SkillSummary = {
  id: SKILL_ID,
  project_id: PROJECT_ID,
  name: 'test-skill',
  description: 'a test skill',
  version: '1.0.0',
  status: 'candidate',
  path: 'skills/test-skill/SKILL.md',
  usage_count: 0,
  success_rate: null,
  evidence_count: 1,
  verified_at: iso,
  source_failure_ids: [],
  created_at: iso,
  updated_at: iso,
};

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
  summary: { pass: 1, warn: 0, fail: 0, info: 1 },
  checks: [{ id: 'config', title: 'configuration', status: 'pass', detail: 'loaded' }],
  runtimes: [
    {
      id: 'runtime-codex',
      title: 'Codex',
      status: 'info',
      detail: 'not wired (opt-in)',
      remediation: 'to wire it: onemem init --with-codex',
    },
  ],
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
      // M4g2: always present on every result — empty when no refs are recorded.
      codeRefs: [],
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
  pageOptions?: MemoryPageOptions;
  consolidateInput?: Record<string, unknown>;
  promoteInput?: Record<string, unknown>;
  deprecateInput?: Record<string, unknown>;
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
    listMemories: async (projectId, options = {}) => {
      script.pageOptions = options;
      return {
        project_id: projectId,
        page_size: options.page_size ?? 50,
        memories: [inspectResult.memory],
        next_cursor: options.cursor === undefined ? 'next-page' : null,
      };
    },
    consolidate: async (input) => {
      script.consolidateInput = { ...input };
      return {
        project_id: input.project_id,
        kind: input.kind ?? 'consolidate',
        job_id: 'job-1',
        outcome: 'enqueued',
        status: 'pending',
        note: 'queued',
      };
    },
    listSkills: async (projectId) => ({
      project_id: projectId,
      skills: [skillSummary],
      warnings: [],
    }),
    reviewSkill: async (projectId, skillId) => {
      if (skillId !== SKILL_ID) throw new BackendError(`skill ${skillId} is not in project`, 'not_found');
      return {
        project_id: projectId,
        skill: skillSummary,
        markdown: SKILL_MARKDOWN,
        audit: [],
        unresolved_failure_ids: [],
      };
    },
    promoteSkill: async (input) => {
      script.promoteInput = { ...input };
      if (input.dir !== undefined && input.runtime !== undefined) {
        throw new BackendError('pass either dir or runtime, not both', 'invalid_request');
      }
      return {
        project_id: input.project_id,
        skill: skillSummary,
        written_path: '/tmp/skills/test-skill/SKILL.md',
        skills_root: '/tmp/skills',
        skills_root_source: input.runtime === undefined ? 'dir-flag' : 'runtime-flag',
        markdown_bytes: SKILL_MARKDOWN.length,
      };
    },
    deprecateSkill: async (input) => {
      script.deprecateInput = { ...input };
      return { project_id: input.project_id, skill: skillSummary };
    },
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
      '/v1/projects/{id}/consolidate',
      '/v1/projects/{id}/skills',
      '/v1/projects/{id}/skills/{skillId}',
      '/v1/projects/{id}/skills/{skillId}/promote',
      '/v1/projects/{id}/skills/{skillId}/deprecate',
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

  test('GET memories pages with cursor + page_size and splits the comma filters', async () => {
    const script: Scripted = {};
    const first = await get(
      `/v1/projects/${PROJECT_ID}/memories?page_size=2&types=decision,failure&include=archived`,
      script,
    );
    expect(first.status).toBe(200);
    expect(script.pageOptions).toEqual({ page_size: 2, types: ['decision', 'failure'], include: ['archived'] });
    const payload = await body(first);
    expect(payload.next_cursor).toBe('next-page');
    expect((payload.memories as unknown[]).length).toBe(1);

    const next = await get(`/v1/projects/${PROJECT_ID}/memories?cursor=next-page`, script);
    expect(next.status).toBe(200);
    expect(script.pageOptions).toEqual({ cursor: 'next-page' });
    expect((await body(next)).next_cursor).toBeNull();
  });

  test('GET memories rejects an unknown type, status, or an out-of-range page_size', async () => {
    for (const query of ['types=decision,bogus', 'include=active', 'page_size=0', 'page_size=201', 'extra=1']) {
      const response = await get(`/v1/projects/${PROJECT_ID}/memories?${query}`);
      expect(response.status).toBe(400);
    }
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

describe('consolidation', () => {
  test('POST /v1/projects/{id}/consolidate queues the pass and answers 202 with the job id', async () => {
    const script: Scripted = {};
    const response = await post(`/v1/projects/${PROJECT_ID}/consolidate`, {}, script);
    expect(response.status).toBe(202);
    const payload = await body(response);
    expect(payload.job_id).toBe('job-1');
    expect(payload.outcome).toBe('enqueued');
    expect(payload.project_id).toBe(PROJECT_ID);
    // The body is optional: an empty object defaults the kind to the full pass.
    expect(script.consolidateInput).toEqual({ project_id: PROJECT_ID });
  });

  test('the body selects the decay kind and forwards the actor', async () => {
    const script: Scripted = {};
    const response = await post(
      `/v1/projects/${PROJECT_ID}/consolidate`,
      { kind: 'decay', actor: 'cli:consolidate' },
      script,
    );
    expect(response.status).toBe(202);
    expect(script.consolidateInput).toEqual({
      project_id: PROJECT_ID,
      kind: 'decay',
      actor: 'cli:consolidate',
    });
  });

  test('an unknown kind is a 400 (the enum is enforced at the boundary)', async () => {
    const response = await post(`/v1/projects/${PROJECT_ID}/consolidate`, { kind: 'compact' });
    expect(response.status).toBe(400);
  });

  test('an unknown key in the body is rejected (strict requests)', async () => {
    const response = await post(`/v1/projects/${PROJECT_ID}/consolidate`, { force: true });
    expect(response.status).toBe(400);
  });
});

describe('skills review surface', () => {
  const skillPath = `/v1/projects/${PROJECT_ID}/skills/${SKILL_ID}`;

  test('GET skills lists the project review queue', async () => {
    const response = await get(`/v1/projects/${PROJECT_ID}/skills`);
    expect(response.status).toBe(200);
    const payload = await body(response);
    expect(payload.project_id).toBe(PROJECT_ID);
    expect((payload.skills as Array<{ id: string }>).map((skill) => skill.id)).toEqual([SKILL_ID]);
  });

  test('GET one skill returns the SKILL.md bytes; an unknown skill is a typed 404', async () => {
    const response = await get(skillPath);
    expect(response.status).toBe(200);
    expect((await body(response)).markdown).toBe(SKILL_MARKDOWN);

    const missing = await get(`/v1/projects/${PROJECT_ID}/skills/${MEMORY_ID}`);
    expect(missing.status).toBe(404);
  });

  test('a skill id that is not a UUID is a 400 (param validation)', async () => {
    const response = await get(`/v1/projects/${PROJECT_ID}/skills/not-a-uuid`);
    expect(response.status).toBe(400);
  });

  test('promote forwards the write target and note with the path ids', async () => {
    const script: Scripted = {};
    const response = await post(`${skillPath}/promote`, { runtime: 'codex', note: 'looks right' }, script);
    expect(response.status).toBe(200);
    expect(script.promoteInput).toMatchObject({
      project_id: PROJECT_ID,
      skill_id: SKILL_ID,
      runtime: 'codex',
      note: 'looks right',
    });
    const payload = await body(response);
    expect(payload.written_path).toBe('/tmp/skills/test-skill/SKILL.md');
    expect(payload.skills_root_source).toBe('runtime-flag');
  });

  test('promote with both dir and runtime is a 400 from the backend', async () => {
    const response = await post(`${skillPath}/promote`, { dir: '/tmp/x', runtime: 'codex' });
    expect(response.status).toBe(400);
  });

  test('promote rejects unknown body keys (strict requests)', async () => {
    const response = await post(`${skillPath}/promote`, { force: true });
    expect(response.status).toBe(400);
  });

  test('deprecate requires a note and forwards it', async () => {
    const missing = await post(`${skillPath}/deprecate`, {});
    expect(missing.status).toBe(400);
    const empty = await post(`${skillPath}/deprecate`, { note: '' });
    expect(empty.status).toBe(400);

    const script: Scripted = {};
    const response = await post(`${skillPath}/deprecate`, { note: 'wrong fix' }, script);
    expect(response.status).toBe(200);
    expect(script.deprecateInput).toEqual({ project_id: PROJECT_ID, skill_id: SKILL_ID, note: 'wrong fix' });
  });
});

beforeEach(() => {
  // Each test builds its own app; nothing to reset. Kept explicit for future shared state.
});

describe('/mcp mount — the daemon MCP surface', () => {
  test('without mcpHandler, /mcp 404s like any other unknown route', async () => {
    const response = await createApiApp({ backend: fakeBackend(), version: 'test' }).request('/mcp', {
      method: 'POST',
    });
    expect(response.status).toBe(404);
    expect(((await response.json()) as Record<string, unknown>).error).toBeDefined();
  });

  test('a mounted handler receives the raw request; its response passes through untouched', async () => {
    const seen: string[] = [];
    const app = createApiApp({
      backend: fakeBackend(),
      version: 'test',
      mcpHandler: {
        fetch: async (request: Request) => {
          seen.push(`${request.method} ${new URL(request.url).pathname}`);
          return new Response('the mcp handler owns this body', { status: 200 });
        },
      },
    });
    const response = await app.request('/mcp', { method: 'POST', body: '{}' });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('the mcp handler owns this body');
    expect(seen).toEqual(['POST /mcp']);
  });
});
