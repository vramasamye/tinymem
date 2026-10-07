/**
 * Optional stateless Streamable HTTP (ADR-0010 §1): a shared-server mode for one onememory
 * instance behind many agents (and the hosted mode's transport). The SDK's `createMcpHandler`
 * builds a FRESH McpServer per request against the SAME shared context — stateless and
 * horizontally scalable by design, matching the 2026-07-28 protocol direction.
 *
 * GATED behind explicit opt-in: local-first default is stdio. This module never registers an
 * SSE *transport* route (the stateless POST exchanges are the SDK's own framing); SESSIONS are
 * the sessionful sibling in `./streamable-http/`. No session state is kept.
 *
 * OAuth (backlog M5.5): an optional bearer gate turns this into an OAuth 2.0 Resource Server
 * (`requireBearerAuth` from the SDK — 401/403 + `WWW-Authenticate` challenges). The gate is
 * still the DEPLOYER's explicit opt-in (`onemem serve --mcp-auth <issuer>`); absent → no auth,
 * the local-first default. The RFC 9728 discovery documents are the host's routes (the daemon
 * serves them from `@onememory-ai/mcp`'s `onememoryOauthMetadataResponse`), public by design.
 */

import {
  createMcpHandler,
  type AuthInfo,
  type CreateMcpHandlerOptions,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
} from '@modelcontextprotocol/server';

import { createOnememoryMcpContext, type OnememoryMcpContext, type OnememoryMcpContextOptions } from './context';
import type { BearerGate } from './streamable-http/auth';
import { buildOnememoryServer, type BuildServerOptions } from './server';

export interface CreateStreamableHttpOptions extends BuildServerOptions {
  /** Passed through to the SDK handler (event bus for subscriptions, …). */
  handlerOptions?: CreateMcpHandlerOptions;
  /**
   * The bearer gate for server mode (`createBearerGate` + a verifier from `./oauth`). When
   * set, every request must present a valid token; the verified `AuthInfo` flows into the
   * SDK's per-request context (`ctx.http.authInfo`). Absent → no auth (the local default).
   */
  gate?: BearerGate;
}

/**
 * The per-request agent id pattern (M17 per-runtime identity): the wire step appends
 * `?agent=onemem-<runtime>` to each runtime's MCP URL so every client identifies itself on
 * every request. Same charset discipline as `config.agentId` examples — a URL-safe slug.
 */
const AGENT_PARAM_PATTERN = /^[A-Za-z0-9._@-]{1,120}$/;

/** The validated `?agent=` value, or null when the request carries none. */
export function agentFromRequest(request: Request | undefined): string | null {
  if (request === undefined) return null;
  const agent = new URL(request.url).searchParams.get('agent');
  if (agent === null || agent === '') return null;
  return AGENT_PARAM_PATTERN.test(agent) ? agent : null;
}

/** The invalid `?agent=` value when the request carries one the pattern rejects, else null. */
function invalidAgentOf(request: Request): string | null {
  const agent = new URL(request.url).searchParams.get('agent');
  if (agent === null || agent === '') return null;
  return AGENT_PARAM_PATTERN.test(agent) ? null : agent;
}

function invalidAgentResponse(agent: string): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'invalid_request',
        message:
          `invalid ?agent= value ${JSON.stringify(agent)}: expected 1..120 characters of A-Z a-z 0-9 . _ @ - ` +
          '— the daemon URL is machine-written by onemem init; edit it there, never by hand',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  );
}

/** A per-request context view: the shared storage/engine/cache with this request's identity. */
function contextWithAgent(context: OnememoryMcpContext, agent: string): OnememoryMcpContext {
  if (agent === context.config.agentId) return context;
  // Shallow clone by design: storage, engine and the redactor stay the shared singletons; only
  // the identity (agent_id on writes, the audited-actor string) is per-request.
  return { ...context, config: { ...context.config, agentId: agent }, actor: `agent:${agent}` };
}

/**
 * Build the stateless Streamable HTTP handler. `context` must be created ONCE by the caller
 * (`createOnememoryMcpContext`) and shared; the per-request McpServer instances reference it.
 */
export function createOnememoryStreamableHttpHandler(
  context: OnememoryMcpContext,
  options: CreateStreamableHttpOptions = {},
): McpHttpHandler {
  // Per-request identity (M17): a FRESH server per request means the factory sees this
  // request's URL, so `?agent=` overrides the configured identity for exactly that request.
  const handler = createMcpHandler(
    (requestContext) => {
      const agent = agentFromRequest(requestContext.requestInfo);
      return buildOnememoryServer(agent === null ? context : contextWithAgent(context, agent), options);
    },
    options.handlerOptions,
  );

  // Validate BEFORE the SDK sees the request: an invalid identity is refused loudly (a
  // misattributed audit trail is worse than a refused request), for gated and plain hosts alike.
  const guarded: McpHttpHandler = {
    async fetch(request: Request, requestOptions?: McpHandlerRequestOptions): Promise<Response> {
      const invalid = invalidAgentOf(request);
      if (invalid !== null) return invalidAgentResponse(invalid);
      return handler.fetch(request, requestOptions);
    },
    close: () => handler.close(),
    notify: handler.notify,
    bus: handler.bus,
  };
  if (options.gate === undefined) return guarded;

  const gate = options.gate;
  // Wrap WITHOUT spreading: `fetch` detaches safely, but `notify`/`bus` delegate as references
  // so their internal bindings survive.
  const gated: McpHttpHandler = {
    async fetch(request: Request, requestOptions?: McpHandlerRequestOptions): Promise<Response> {
      const invalid = invalidAgentOf(request);
      if (invalid !== null) return invalidAgentResponse(invalid);
      const authInfo: AuthInfo | Response = await gate(request);
      if (authInfo instanceof Response) return authInfo;
      return handler.fetch(request, { ...(requestOptions ?? {}), authInfo });
    },
    close: guarded.close,
    notify: guarded.notify,
    bus: guarded.bus,
  };
  return gated;
}

/**
 * Convenience wrapper: open the context from config, build the handler, and return both so
 * the host (Bun.serve, Node fetch adapter, Hono route, …) owns the socket lifecycle. `close()`
 * aborts in-flight modern exchanges and closes storage.
 */
export async function createOnememoryHttpServer(
  contextOptions: OnememoryMcpContextOptions = {},
  options: CreateStreamableHttpOptions = {},
): Promise<{ handler: McpHttpHandler; context: OnememoryMcpContext; close(): Promise<void> }> {
  const context = await createOnememoryMcpContext(contextOptions);
  const handler = createOnememoryStreamableHttpHandler(context, options);
  return {
    handler,
    context,
    close: async () => {
      await handler.close();
      await context.storage.close();
    },
  };
}
