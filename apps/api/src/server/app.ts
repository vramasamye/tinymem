/**
 * The REST surface (`/v1/*`) — Hono + `@hono/zod-openapi`.
 *
 * Boundary rules:
 * - **requests** are validated by the router before a handler runs (`defaultHook` turns a Zod
 *   failure into a 400 with path+message issues, never an echo of the input);
 * - **responses** are validated by `respond()` before they are written, so a service change that
 *   breaks the contract fails loudly in the process that produced it instead of corrupting a
 *   consumer;
 * - **errors** are typed (`BackendError.code` → status) and secret-free; unhandled errors become a
 *   500 with the message only, never a stack or an input echo;
 * - the OpenAPI document is generated from the same schemas (`GET /openapi.json`).
 */

import { DURABLE_MEMORY_TYPES, type MemorySearchRequest } from '@onememory/core';
import { OpenAPIHono, createRoute, z, type Hook, type RouteConfig, type RouteHandler } from '@hono/zod-openapi';
import type { Context, Env } from 'hono';

import type { DurableMemoryType } from '@onememory/core';

import { BackendError, type MemoryPageInclude, type OnememoryBackend } from '../runtime/types';
import {
  ConsolidateRequestSchema,
  ConsolidateResponseSchema,
  ContextQuerySchema,
  CreateProjectRequestSchema,
  DoctorReportSchema,
  ErrorResponseSchema,
  ForgetRequestSchema,
  ForgetResponseSchema,
  HealthResponseSchema,
  IdParamSchema,
  IngestRequestSchema,
  IngestResponseSchema,
  InspectResponseSchema,
  ListQuerySchema,
  MemoryPageQuerySchema,
  MemoryPageResponseSchema,
  MemoryIdParamSchema,
  ProjectListResponseSchema,
  ProjectSchema,
  PurgeRequestSchema,
  PurgeResponseSchema,
  RememberRequestSchema,
  RememberResponseSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SessionContextSchema,
  StatsQuerySchema,
  StatsResponseSchema,
} from './schemas';

export interface ApiDeps {
  backend: OnememoryBackend;
  version: string;
  /** Extra process metadata for `/v1/health` (daemon) — optional. */
  meta?: { started_at?: number; pid?: number; lock_path?: string };
  /**
   * Stateless MCP handler mounted verbatim at `/mcp` (the daemon's MCP surface — ADR-0010
   * amendment 2026-10-04). Absent → `/mcp` 404s. Structural on purpose: the app layer needs no
   * SDK types, just a fetch-shaped handler.
   */
  mcpHandler?: { fetch(request: Request): Response | Promise<Response> };
  /**
   * M5b — the OAuth well-known document handler (`--mcp-auth`): answers ONLY
   * `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`,
   * `undefined` on any other path. Structural for the same reason as `mcpHandler`.
   */
  mcpAuthDocuments?: { fetch(request: Request): Response | undefined };
}

type ErrorCode = 'not_found' | 'invalid_request' | 'conflict' | 'unavailable' | 'internal';

const STATUS_BY_CODE: Record<ErrorCode, 400 | 404 | 409 | 500 | 503> = {
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
  internal: 500,
};

function errorBody(code: ErrorCode, message: string, details?: unknown) {
  return { error: { code, message, ...(details === undefined ? {} : { details }) } };
}

/** Every route declares the same error responses, so the OpenAPI document describes them. */
const errorResponses = {
  400: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'invalid request' },
  404: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'not found' },
  409: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'conflict' },
  500: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'internal error' },
  503: { content: { 'application/json': { schema: ErrorResponseSchema } }, description: 'unavailable' },
} as const;

const validationHook: Hook<any, Env, any, any> = (result, c) => {
  if (!result.success) {
    const message = result.error.issues
      .map(
        (issue) =>
          `${issue.path.length === 0 ? '(body)' : issue.path.map(String).join('.')}: ${issue.message}`,
      )
      .join('; ');
    return jsonBody(c, errorBody('invalid_request', message), 400);
  }
  return undefined;
};

const JSON_HEADERS = { 'content-type': 'application/json; charset=UTF-8' } as const;

/** Write a JSON body without going through Hono's typed `c.json` overloads (statuses vary). */
function jsonBody(
  c: Context,
  payload: unknown,
  status: 200 | 201 | 202 | 400 | 404 | 409 | 500 | 503,
): Response {
  return c.body(JSON.stringify(payload), status, JSON_HEADERS);
}

/**
 * Validate a response against its schema, then serialize it.
 *
 * The schema check is the real contract enforcement (the compiler cannot prove that a service
 * return type matches the route's declared response schema — they are different schema instances);
 * a mismatch is a 500 produced by the process that would have sent the wrong shape.
 */
function respond<S extends z.ZodType>(c: Context, schema: S, value: unknown, status: 200 | 201 | 202): Response {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    console.error(`onememory api: response failed its own schema: ${detail}`);
    return jsonBody(c, errorBody('internal', `response failed schema validation: ${detail}`), 500);
  }
  return jsonBody(c, parsed.data, status);
}

function errorResponse(c: Context, error: unknown): Response {
  if (error instanceof BackendError) {
    return jsonBody(c, errorBody(error.code, error.message, error.details), STATUS_BY_CODE[error.code]);
  }
  const message = error instanceof Error ? error.message : String(error);
  console.error('onememory api: unhandled error', error);
  return jsonBody(c, errorBody('internal', message), 500);
}

export function createApiApp(deps: ApiDeps): OpenAPIHono {
  const { backend } = deps;
  const app = new OpenAPIHono({ defaultHook: validationHook });

  /**
   * Register a route with uniform error handling. Handlers stay fully typed (`c.req.valid`
   * included); the `as never` at registration is the single place where the compiler cannot follow
   * the "service value → declared response schema" correspondence — `respond` enforces that at
   * runtime instead.
   */
  const add = <R extends RouteConfig>(
    route: R,
    handler: (c: Parameters<RouteHandler<R>>[0]) => Promise<Response>,
  ): void => {
    const wrapped = async (c: Parameters<RouteHandler<R>>[0]): Promise<Response> => {
      try {
        return await handler(c);
      } catch (error) {
        return errorResponse(c, error);
      }
    };
    app.openapi(route, wrapped as never);
  };

  // ---------------------------------------------------------------- health
  add(
    createRoute({
      method: 'get',
      path: '/v1/health',
      tags: ['system'],
      summary: 'Machine-readable health summary (storage, vector backend, router, guard)',
      responses: {
        200: { content: { 'application/json': { schema: HealthResponseSchema } }, description: 'health' },
        ...errorResponses,
      },
    }),
    async (c) => respond(c, HealthResponseSchema, await backend.health(), 200),
  );

  add(
    createRoute({
      method: 'get',
      path: '/v1/doctor',
      tags: ['system'],
      summary: 'The full doctor report (the CLI prints this; adapters may gate on it)',
      responses: {
        200: { content: { 'application/json': { schema: DoctorReportSchema } }, description: 'doctor report' },
        ...errorResponses,
      },
    }),
    async (c) => respond(c, DoctorReportSchema, await backend.doctor(), 200),
  );

  // ---------------------------------------------------------------- projects
  add(
    createRoute({
      method: 'post',
      path: '/v1/projects',
      tags: ['projects'],
      summary: 'Register a project',
      request: { body: { content: { 'application/json': { schema: CreateProjectRequestSchema } } } },
      responses: {
        201: { content: { 'application/json': { schema: ProjectSchema } }, description: 'created' },
        ...errorResponses,
      },
    }),
    async (c) => respond(c, ProjectSchema, await backend.createProject(c.req.valid('json')), 201),
  );

  add(
    createRoute({
      method: 'get',
      path: '/v1/projects',
      tags: ['projects'],
      summary: 'List registered projects',
      description:
        'Phase 1 caveat: storage exposes no project-listing API, so only the project this process is configured for can be returned. `warnings` says so explicitly (mission-13 report follow-up).',
      responses: {
        200: { content: { 'application/json': { schema: ProjectListResponseSchema } }, description: 'projects' },
        ...errorResponses,
      },
    }),
    async (c) => respond(c, ProjectListResponseSchema, await backend.listProjects(), 200),
  );

  add(
    createRoute({
      method: 'get',
      path: '/v1/projects/{id}',
      tags: ['projects'],
      summary: 'Get a project',
      request: { params: IdParamSchema },
      responses: {
        200: { content: { 'application/json': { schema: ProjectSchema } }, description: 'project' },
        ...errorResponses,
      },
    }),
    async (c) => respond(c, ProjectSchema, await backend.getProject(c.req.valid('param').id), 200),
  );

  // ---------------------------------------------------------------- ingest
  add(
    createRoute({
      method: 'post',
      path: '/v1/projects/{id}/events',
      tags: ['events'],
      summary: 'Ingest events (redacted before persist; per-event outcome)',
      description:
        'Path exclusion runs first, then redaction (ADR-0007), then storage. Envelopes may omit id/ingested_at/content_hash/redactions: they are completed from the payload before validation. A stored event queues one normalize job.',
      request: {
        params: IdParamSchema,
        body: { content: { 'application/json': { schema: IngestRequestSchema } } },
      },
      responses: {
        200: { content: { 'application/json': { schema: IngestResponseSchema } }, description: 'outcomes' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      return respond(c, IngestResponseSchema, await backend.ingestEvents(id, body.events), 200);
    },
  );

  // ---------------------------------------------------------------- search
  add(
    createRoute({
      method: 'post',
      path: '/v1/projects/{id}/search',
      tags: ['search'],
      summary: 'Search memories (token-budgeted; explain on request)',
      request: {
        params: IdParamSchema,
        body: { content: { 'application/json': { schema: SearchRequestSchema } } },
      },
      responses: {
        200: { content: { 'application/json': { schema: SearchResponseSchema } }, description: 'search response' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const request = c.req.valid('json') as MemorySearchRequest;
      // The path project is authoritative (a body project_id may not widen the scope).
      return respond(c, SearchResponseSchema, await backend.search({ ...request, project_id: id }), 200);
    },
  );

  add(
    createRoute({
      method: 'get',
      path: '/v1/projects/{id}/decisions',
      tags: ['search'],
      summary: 'Decisions, kind-filtered and token-budgeted (ADR-0010)',
      request: { params: IdParamSchema, query: ListQuerySchema },
      responses: {
        200: { content: { 'application/json': { schema: SearchResponseSchema } }, description: 'decision list' },
        ...errorResponses,
      },
    }),
    async (c) =>
      respond(
        c,
        SearchResponseSchema,
        await backend.decisions(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  );

  add(
    createRoute({
      method: 'get',
      path: '/v1/projects/{id}/failures',
      tags: ['search'],
      summary: 'Failures, kind-filtered and token-budgeted (ADR-0010)',
      request: { params: IdParamSchema, query: ListQuerySchema },
      responses: {
        200: { content: { 'application/json': { schema: SearchResponseSchema } }, description: 'failure list' },
        ...errorResponses,
      },
    }),
    async (c) =>
      respond(
        c,
        SearchResponseSchema,
        await backend.failures(c.req.valid('param').id, c.req.valid('query')),
        200,
      ),
  );

  add(
    createRoute({
      method: 'get',
      path: '/v1/projects/{id}/context',
      tags: ['search'],
      summary: 'Session context block (default budget 750)',
      request: { params: IdParamSchema, query: ContextQuerySchema },
      responses: {
        200: { content: { 'application/json': { schema: SessionContextSchema } }, description: 'session context' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const query = c.req.valid('query');
      return respond(
        c,
        SessionContextSchema,
        await backend.context(c.req.valid('param').id, {
          budget: query.budget,
          ...(query.session_id === undefined ? {} : { session_id: query.session_id }),
        }),
        200,
      );
    },
  );

  // ---------------------------------------------------------------- memories
  add(
    createRoute({
      method: 'post',
      path: '/v1/projects/{id}/memories',
      tags: ['memories'],
      summary: 'Explicit durable write (provenance + redaction + audit)',
      request: {
        params: IdParamSchema,
        body: { content: { 'application/json': { schema: RememberRequestSchema } } },
      },
      responses: {
        201: { content: { 'application/json': { schema: RememberResponseSchema } }, description: 'stored' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const body = c.req.valid('json');
      return respond(
        c,
        RememberResponseSchema,
        await backend.remember({ ...body, project_id: c.req.valid('param').id }),
        201,
      );
    },
  );

  add(
    createRoute({
      method: 'get',
      path: '/v1/projects/{id}/memories',
      tags: ['memories'],
      summary: 'Browse memories, keyset-paginated (newest observation first; cursor + page_size)',
      request: { params: IdParamSchema, query: MemoryPageQuerySchema },
      responses: {
        200: { content: { 'application/json': { schema: MemoryPageResponseSchema } }, description: 'one page' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const query = c.req.valid('query');
      return respond(
        c,
        MemoryPageResponseSchema,
        await backend.listMemories(c.req.valid('param').id, {
          ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
          ...(query.page_size === undefined ? {} : { page_size: query.page_size }),
          ...(query.types === undefined
            ? {}
            : { types: query.types.split(',') as DurableMemoryType[] }),
          ...(query.include === undefined
            ? {}
            : { include: query.include.split(',') as MemoryPageInclude[] }),
        }),
        200,
      );
    },
  );

  add(
    createRoute({
      method: 'get',
      path: '/v1/projects/{id}/memories/{memoryId}',
      tags: ['memories'],
      summary: 'Full memory record: provenance, audit history, entities, edges, redaction kinds',
      request: { params: MemoryIdParamSchema },
      responses: {
        200: { content: { 'application/json': { schema: InspectResponseSchema } }, description: 'full record' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id, memoryId } = c.req.valid('param');
      return respond(c, InspectResponseSchema, await backend.inspect(id, memoryId), 200);
    },
  );

  add(
    createRoute({
      method: 'post',
      path: '/v1/projects/{id}/memories/{memoryId}/forget',
      tags: ['memories'],
      summary: 'Soft forget: audited status transition to archived (never a deletion)',
      request: {
        params: MemoryIdParamSchema,
        body: { content: { 'application/json': { schema: ForgetRequestSchema } } },
      },
      responses: {
        200: { content: { 'application/json': { schema: ForgetResponseSchema } }, description: 'forgotten' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id, memoryId } = c.req.valid('param');
      const body = c.req.valid('json');
      return respond(
        c,
        ForgetResponseSchema,
        await backend.forget({
          project_id: id,
          memory_id: memoryId,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        }),
        200,
      );
    },
  );

  add(
    createRoute({
      method: 'post',
      path: '/v1/projects/{id}/memories/{memoryId}/restore',
      tags: ['memories'],
      summary: 'Undo a soft forget (archived → active, audited)',
      request: {
        params: MemoryIdParamSchema,
        body: { content: { 'application/json': { schema: ForgetRequestSchema } } },
      },
      responses: {
        200: { content: { 'application/json': { schema: ForgetResponseSchema } }, description: 'restored' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id, memoryId } = c.req.valid('param');
      const body = c.req.valid('json');
      return respond(
        c,
        ForgetResponseSchema,
        await backend.restore({
          project_id: id,
          memory_id: memoryId,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        }),
        200,
      );
    },
  );

  add(
    createRoute({
      method: 'post',
      path: '/v1/projects/{id}/memories/{memoryId}/purge',
      tags: ['memories'],
      summary: 'Hard purge (destructive): the row and its vectors are deleted; a purged audit row survives',
      request: {
        params: MemoryIdParamSchema,
        body: { content: { 'application/json': { schema: PurgeRequestSchema } } },
      },
      responses: {
        200: { content: { 'application/json': { schema: PurgeResponseSchema } }, description: 'purged' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id, memoryId } = c.req.valid('param');
      const body = c.req.valid('json');
      return respond(
        c,
        PurgeResponseSchema,
        await backend.purge({
          project_id: id,
          memory_id: memoryId,
          expected_revision: body.expected_revision,
          ...(body.reason === undefined ? {} : { reason: body.reason }),
        }),
        200,
      );
    },
  );

  // ---------------------------------------------------------------- stats
  add(
    createRoute({
      method: 'get',
      path: '/v1/projects/{id}/stats',
      tags: ['system'],
      summary: 'Project counts, cache statistics, storage and router state',
      request: { params: IdParamSchema, query: StatsQuerySchema },
      responses: {
        200: { content: { 'application/json': { schema: StatsResponseSchema } }, description: 'stats' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const query = c.req.valid('query');
      return respond(
        c,
        StatsResponseSchema,
        await backend.stats(c.req.valid('param').id, {
          ...(query.session === undefined ? {} : { session_id: query.session }),
        }),
        200,
      );
    },
  );

  // ---------------------------------------------------------------- consolidation
  // The daemon-side consolidation trigger (M14 follow-up 1). Asynchronous by design
  // (memory-model.md §8): the route enqueues a `consolidate`/`decay` job and returns its id with
  // 202; the daemon worker runs the pass, so a request never blocks on a full pool sweep. The
  // periodic scheduler enqueues the same job on its own cadence.
  add(
    createRoute({
      method: 'post',
      path: '/v1/projects/{id}/consolidate',
      tags: ['system'],
      summary: 'Queue a consolidation pass (contradictions, derivation, merges, decay)',
      request: {
        params: IdParamSchema,
        body: { content: { 'application/json': { schema: ConsolidateRequestSchema } } },
      },
      responses: {
        202: { content: { 'application/json': { schema: ConsolidateResponseSchema } }, description: 'queued' },
        ...errorResponses,
      },
    }),
    async (c) => {
      const { id } = c.req.valid('param');
      const body = c.req.valid('json');
      return respond(
        c,
        ConsolidateResponseSchema,
        await backend.consolidate({
          project_id: id,
          ...(body.kind === undefined ? {} : { kind: body.kind }),
          ...(body.actor === undefined ? {} : { actor: body.actor }),
        }),
        202,
      );
    },
  );

  // ---------------------------------------------------------------- openapi
  add(
    createRoute({
      method: 'get',
      path: '/openapi.json',
      tags: ['system'],
      summary: 'OpenAPI document',
      responses: { 200: { description: 'OpenAPI 3.0 document' }, ...errorResponses },
    }),
    async (c) =>
      jsonBody(
        c,
        app.getOpenAPIDocument({
          openapi: '3.0.0',
          info: {
            title: 'onememory API',
            version: deps.version,
            description:
              'Local-first persistent memory for AI coding agents. Loopback-only by default; no authentication in Phase 1.',
          },
        }),
        200,
      ),
  );

  // ---------------------------------------------------------------- mcp (daemon)
  // The daemon's MCP surface rides the SAME app as /v1 (ADR-0010 amendment 2026-10-04): the
  // stateless handler gets the raw request — MCP is its own protocol with its own JSON-RPC
  // contract, deliberately NOT part of the OpenAPI document.
  if (deps.mcpHandler !== undefined) {
    const mcpHandler = deps.mcpHandler;
    app.all('/mcp', (c) => mcpHandler.fetch(c.req.raw));
  }

  // -------------------------------------------------- oauth well-known (daemon)
  // M5b: with `--mcp-auth`, the RFC 9728 Protected Resource Metadata document (and the RFC 8414
  // AS metadata, passed through verbatim) is served UNAUTHENTICATED — that is how a client
  // without a token discovers where to authorize. The handler is structural on purpose (the app
  // layer stays SDK-type-free); it answers only the two well-known routes, `undefined` on any
  // other path (fall through to normal routing).
  if (deps.mcpAuthDocuments !== undefined) {
    const mcpAuthDocuments = deps.mcpAuthDocuments;
    app.all('/.well-known/oauth-protected-resource', (c) => {
      const response = mcpAuthDocuments.fetch(c.req.raw);
      return response ?? c.notFound();
    });
    app.all('/.well-known/oauth-authorization-server', (c) => {
      const response = mcpAuthDocuments.fetch(c.req.raw);
      return response ?? c.notFound();
    });
  }

  app.get('/v1', (c) => jsonBody(c, { name: 'onememory', version: deps.version, docs: '/openapi.json' }, 200));

  app.notFound((c) =>
    jsonBody(c, errorBody('not_found', `no route for ${new URL(c.req.url).pathname}`), 404),
  );

  return app;
}

/** The durable memory types accepted as a `type` filter (exported for the CLI's --help text). */
export const MEMORY_TYPES_FOR_CLI = DURABLE_MEMORY_TYPES;
