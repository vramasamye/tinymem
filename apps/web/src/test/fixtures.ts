/**
 * API fixtures + a fetch stub for the explorer's tests.
 *
 * Every fixture mirrors a real `/v1` response shape (the same wire contract
 * `src/api/schemas.ts` validates). Marker values are deliberately distinctive
 * ("fixture") so the controller tests can assert the exact string a page will
 * render came from the API response — and nothing else.
 */

export const PROJECT_ID = '0195a7f0-9f5e-7a1d-bc2d-000000000001';
export const MEMORY_ID_ALPHA = '0195a7f0-9f5e-7a1d-bc2d-000000000002';
export const MEMORY_ID_BETA = '0195a7f0-9f5e-7a1d-bc2d-000000000003';
export const MEMORY_ID_PURGED = '0195a7f0-9f5e-7a1d-bc2d-0000000000ff';
export const SOURCE_ID = '0195a7f0-9f5e-7a1d-bc2d-000000000010';
export const ENTITY_ID_PGLITE = '0195a7f0-9f5e-7a1d-bc2d-000000000020';
export const ENTITY_ID_PGVECTOR = '0195a7f0-9f5e-7a1d-bc2d-000000000021';

const ISO = '2026-10-01T12:00:00.000Z';
const ISO_LATER = '2026-10-02T12:00:00.000Z';

export function fixtureProjectList(): object {
  return {
    projects: [
      {
        id: PROJECT_ID,
        name: 'fixture-project',
        root_path: '/tmp/fixture-project',
        git_remote: 'https://example.com/fixture-project.git',
        description: 'the fixture project the explorer tests point at',
        digest: {},
        settings: {},
        created_at: ISO,
        updated_at: ISO,
      },
    ],
    warnings: ['project listing is incomplete: storage exposes no list-projects query (fixture)'],
  };
}

export function fixtureProject(): object {
  const list = fixtureProjectList() as { projects: object[] };
  return list.projects[0] ?? {};
}

export function fixtureHealth(): object {
  return {
    status: 'ok',
    version: '0.1.0-fixture',
    uptime_ms: 5_000,
    pid: 42,
    config_path: '/tmp/fixture-project/.onememory/onememory.yaml',
    storage: { profile: 'embedded', vector_backend: 'pgvector', vector_model: 'fixture-model', vector_dim: 384 },
    llm: {
      profile: 'local',
      providers: [{ id: 'heuristic', kind: 'local', loopback: true, api_key_env: null }],
      routed_operations: ['extract'],
      unconfigured_operations: [],
    },
    embedder: { provider: null, model: null, dim: null },
    network_guard: { enforced: true, attempts: 0, reason: 'fixture guard installed' },
    warnings: [],
  };
}

export function fixtureSearchResponse(): object {
  return {
    query_understanding: {
      intent: 'decision',
      entities: [{ name: 'PGlite', matched_id: ENTITY_ID_PGLITE }],
      keywords: ['pglite', 'embedded'],
    },
    memories: [
      {
        id: MEMORY_ID_ALPHA,
        type: 'decision',
        title: 'Use PGlite for embedded mode',
        summary: 'fixture decision: embedded mode stores memories in PGlite',
        content: 'fixture decision: embedded mode stores memories in PGlite under .onememory/',
        relevance: 0.83,
        explain: [
          { factor: 'lexical_relevance', weight: 0.25, detail: 'matched terms: pglite, embedded' },
          { factor: 'importance', weight: 0.2, detail: 'importance 0.8 ≥ threshold' },
          { factor: 'graph_proximity', weight: 0.1, detail: '1 hop from entity PGlite' },
        ],
        temporal: { valid_from: ISO, status: 'active' },
        provenance: {
          source_kind: 'conversation',
          source_uri: 'session://fixture-session/183',
          verified_at: ISO,
        },
        conflicts: [{ memory_id: MEMORY_ID_BETA, note: 'fixture conflict: proposed PostgresRDS instead' }],
        codeRefs: [
          {
            repoId: PROJECT_ID,
            commitSha: 'abc1234',
            path: 'packages/storage/src/embedded.ts',
            symbol: 'openEmbeddedStorage',
            evidence: 'blob-sha-fixture',
          },
        ],
      },
      {
        id: MEMORY_ID_BETA,
        type: 'failure',
        title: 'pgvector extension missing',
        summary: 'fixture failure: pgvector extension missing in server mode',
        relevance: 0.41,
        explain: [{ factor: 'lexical_relevance', weight: 0.25, detail: 'matched term: pglite' }],
        temporal: { valid_from: ISO, valid_until: ISO_LATER, status: 'superseded' },
        provenance: { source_kind: 'terminal' },
        codeRefs: [],
      },
    ],
    tokens: { budget: 800, used: 137, packing: 'summary' },
    warnings: ['embedding index degraded: lexical only (fixture)'],
  };
}

export function fixtureEmptySearchResponse(): object {
  return {
    query_understanding: {
      intent: 'fact',
      entities: [],
      keywords: ['nothing'],
    },
    memories: [],
    tokens: { budget: 800, used: 0, packing: 'title-only' },
    warnings: ['no memories matched (fixture)'],
  };
}

export function fixtureMemoryRecord(id: string): object {
  return {
    id,
    type: 'decision',
    subtype: 'architecture',
    title: 'Use PGlite for embedded mode',
    content: 'fixture decision: embedded mode stores memories in PGlite under .onememory/',
    content_summary: 'fixture decision: embedded mode stores memories in PGlite',
    status: 'active',
    importance: 0.8,
    confidence: 0.72,
    access_count: 3,
    last_accessed_at: ISO_LATER,
    observed_at: ISO,
    valid_from: ISO,
    created_at: ISO,
    updated_at: ISO,
    project_id: PROJECT_ID,
    provenance: {
      source: {
        id: SOURCE_ID,
        kind: 'conversation',
        uri: 'session://fixture-session/183',
        title: 'fixture session 2026-10-01',
      },
      evidence: [
        {
          source_id: SOURCE_ID,
          kind: 'message',
          locator: 'session.jsonl:183',
          excerpt: 'we will store memories in PGlite for the embedded profile',
        },
        {
          source_id: SOURCE_ID,
          kind: 'message',
          locator: 'session.jsonl:190',
          excerpt: 'PGlite keeps everything local-first, no server needed',
        },
      ],
      extraction: { method: 'heuristic', prompt_version: 'extract-v3' },
      verified_at: ISO,
    },
    entities: [
      { id: ENTITY_ID_PGLITE, name: 'PGlite', kind: 'library' },
      { id: ENTITY_ID_PGVECTOR, name: 'pgvector', kind: 'library' },
    ],
    tags: ['storage', 'fixture'],
    token_estimate: 42,
    payload: {
      title: 'Use PGlite for embedded mode',
      decision: 'embedded mode stores memories in PGlite under .onememory/',
      alternatives: [
        { option: 'Docker Postgres + pgvector', why_rejected: 'fixture: heavier default install' },
      ],
      rationale: 'fixture rationale: keeps the default install fully offline',
      participants: ['alice', 'bob'],
      decided_at: ISO,
      status: 'accepted',
      evidence: [],
    },
  };
}

export function fixtureInspectResponse(): object {
  return {
    memory: fixtureMemoryRecord(MEMORY_ID_ALPHA),
    history: [fixtureMemoryRecord(MEMORY_ID_ALPHA)],
    audit: [
      {
        id: '0195a7f0-9f5e-7a1d-bc2d-000000000030',
        memory_id: MEMORY_ID_ALPHA,
        action: 'created',
        from_status: null,
        to_status: 'active',
        actor: 'extraction',
        details: { method: 'heuristic' },
        at: ISO,
      },
      {
        id: '0195a7f0-9f5e-7a1d-bc2d-000000000031',
        memory_id: MEMORY_ID_ALPHA,
        action: 'status_changed',
        from_status: 'active',
        to_status: 'stale',
        actor: 'drift-scan',
        details: { reason: 'fixture drift: cited file changed' },
        at: ISO_LATER,
      },
    ],
    entities: [
      {
        id: ENTITY_ID_PGLITE,
        project_id: PROJECT_ID,
        kind: 'library',
        name: 'PGlite',
        normalized_name: 'pglite',
        aliases: ['pg-lite'],
        description: 'embedded Postgres in WASM',
        confidence: 0.9,
        merged_into: null,
        created_at: ISO,
        updated_at: ISO,
      },
    ],
    edges: [
      {
        id: '0195a7f0-9f5e-7a1d-bc2d-000000000040',
        from_memory_id: MEMORY_ID_ALPHA,
        to_memory_id: MEMORY_ID_BETA,
        relation: 'supersedes',
        project_id: PROJECT_ID,
        confidence: 0.66,
        valid_from: ISO,
        valid_until: null,
        evidence: [],
        created_at: ISO,
      },
    ],
    redactions: [
      { kind: 'api-key', location: 'payload.content', length: 40 },
    ],
    warnings: ['fixture inspect warning: none'],
  };
}

export function fixtureStatsResponse(): object {
  return {
    project_id: PROJECT_ID,
    storage: {
      profile: 'embedded',
      vector_backend: 'pgvector',
      vector_model: 'fixture-model',
      vector_dim: 384,
      data_dir: '/tmp/fixture-project/.onememory/data',
    },
    memories: {
      total: 12,
      by_status: { active: 8, stale: 2, superseded: 1, disputed: 1, archived: 0 },
      by_type: { decision: 4, failure: 3, episodic: 2, semantic: 1, procedural: 1, preference: 1 },
      truncated: false,
    },
    working_memory: { session_id: 'fixture-session', depth: 2 },
    jobs: { pending: 1, running: 0, dead: 0 },
    cache: { embeddings: 10, results: 4, entityScopes: 2 },
    llm: {
      profile: 'local',
      providers: [{ id: 'heuristic', kind: 'local', loopback: true, api_key_env: null }],
      routed_operations: ['extract'],
      unconfigured_operations: [],
    },
    warnings: [],
  };
}

export function fixtureSessionContext(): object {
  return {
    project_id: PROJECT_ID,
    budget: 750,
    used: 210,
    text: 'fixture session context block',
    sections: [
      { kind: 'digest', tokens: 80, text: 'fixture digest: local-first memory engine' },
      { kind: 'decisions', tokens: 130, text: 'fixture decisions: PGlite embedded mode' },
    ],
    warnings: [],
  };
}

/** A procedural memory row (the type skills ride on, per the MCP kind mapping). */
export const MEMORY_ID_PROCEDURAL = '0195a7f0-9f5e-7a1d-bc2d-000000000004';

export function fixtureProceduralSearchResponse(): object {
  return {
    query_understanding: {
      intent: 'how_to',
      entities: [],
      keywords: ['skill'],
    },
    memories: [
      {
        id: MEMORY_ID_PROCEDURAL,
        type: 'procedural',
        title: 'Restore the pgvector extension',
        summary: 'fixture procedure: restore the pgvector extension in server mode',
        relevance: 0.62,
        explain: [{ factor: 'type_affinity', weight: 0.3, detail: 'requested procedural' }],
        temporal: { valid_from: ISO, status: 'active' },
        provenance: { source_kind: 'terminal', source_uri: 'terminal://fixture/99' },
        codeRefs: [],
      },
    ],
    tokens: { budget: 800, used: 64, packing: 'summary' },
    warnings: [],
  };
}

/** The same procedural memory carrying a skill payload (what the skillify stage will produce). */
export function fixtureSkillInspectResponse(): object {
  const base = fixtureMemoryRecord(MEMORY_ID_PROCEDURAL) as Record<string, unknown>;
  const memory = {
    ...base,
    type: 'procedural',
    title: 'Restore the pgvector extension',
    content: 'fixture procedure: restore the pgvector extension in server mode',
    content_summary: 'fixture procedure: restore the pgvector extension in server mode',
    payload: {
      name: 'restore-pgvector-extension',
      description: 'fixture skill: how to restore the pgvector extension in server mode',
      version: '1.2.0',
      status: 'verified',
      source: { failure_ids: [MEMORY_ID_BETA] },
      verification: {
        evidence: [
          {
            source_id: SOURCE_ID,
            kind: 'event',
            locator: 'terminal://fixture/99',
            excerpt: 'CREATE EXTENSION IF NOT EXISTS vector;',
          },
        ],
        verified_at: ISO,
      },
      path: 'skills/restore-pgvector-extension/SKILL.md',
      usage_count: 2,
      success_rate: 1,
    },
  };
  return {
    memory,
    history: [memory],
    audit: [
      {
        id: '0195a7f0-9f5e-7a1d-bc2d-000000000050',
        memory_id: MEMORY_ID_PROCEDURAL,
        action: 'created',
        from_status: null,
        to_status: 'active',
        actor: 'extraction',
        details: {},
        at: ISO,
      },
    ],
    entities: [],
    edges: [],
    redactions: [],
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// The fetch stub
// ---------------------------------------------------------------------------

import type { FetchLike } from '../api/client';

/**
 * A fetch stub keyed by `'<METHOD> <path>'` (the exact URLs `ApiClient` builds).
 * Values: a JSON body (→ 200), or a `(request) => Response` handler for dynamic
 * behavior. Unmatched routes 404 with the real API's error envelope shape.
 *
 * The client sends same-origin relative URLs (`/v1/...`) — legal for the browser's
 * fetch but not for `new Request()` outside one, so the stub anchors them to a
 * synthetic origin before reading method/body off them.
 */
export type StubRoutes = Record<string, unknown | ((request: Request) => Response)>;

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export function apiErrorBody(code: string, message: string): object {
  return { error: { code, message } };
}

const SYNTHETIC_ORIGIN = 'http://onememory.test';

/** `'/v1/health'` → `'http://onememory.test/v1/health'`; absolute URLs pass through. */
export function anchorUrl(input: RequestInfo | URL): string {
  const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return raw.startsWith('/') ? `${SYNTHETIC_ORIGIN}${raw}` : raw;
}

export function stubApi(routes: StubRoutes): FetchLike {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(anchorUrl(input), init);
    // Route on method + path (query strings belong to the recorded call, not the route).
    const key = `${request.method} ${new URL(request.url).pathname}`;
    const entry = routes[key];
    if (entry === undefined) {
      return jsonResponse(
        apiErrorBody('not_found', `no route for ${key.slice(request.method.length + 1)}`),
        404,
      );
    }
    if (entry instanceof Response) return entry;
    if (typeof entry === 'function') return entry(request);
    return jsonResponse(entry);
  }) as FetchLike;
}

/** The full default fixture set: every route a page hits while exploring a project. */
export function defaultStubRoutes(): StubRoutes {
  const routes: StubRoutes = {
    'GET /v1/health': fixtureHealth(),
    'GET /v1/projects': fixtureProjectList(),
    [`GET /v1/projects/${PROJECT_ID}`]: fixtureProject(),
    [`POST /v1/projects/${PROJECT_ID}/search`]: (request: Request) => {
      // Body-aware: the skills page searches procedural kinds; tests that need
      // per-include dispatch install their own handler over this route.
      void request;
      return jsonResponse(fixtureSearchResponse());
    },
    [`GET /v1/projects/${PROJECT_ID}/decisions`]: fixtureSearchResponse(),
    [`GET /v1/projects/${PROJECT_ID}/failures`]: fixtureSearchResponse(),
    [`GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_ALPHA}`]: fixtureInspectResponse(),
    [`GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_PROCEDURAL}`]: fixtureSkillInspectResponse(),
    [`GET /v1/projects/${PROJECT_ID}/memories/${MEMORY_ID_PURGED}`]: () =>
      jsonResponse(apiErrorBody('not_found', 'memory not found (fixture purge)'), 404),
    [`GET /v1/projects/${PROJECT_ID}/stats`]: fixtureStatsResponse(),
    [`GET /v1/projects/${PROJECT_ID}/context`]: fixtureSessionContext(),
  };
  return routes;
}
