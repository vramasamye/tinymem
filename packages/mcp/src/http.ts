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
 * serves them from `@onememory/mcp`'s `onememoryOauthMetadataResponse`), public by design.
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
 * Build the stateless Streamable HTTP handler. `context` must be created ONCE by the caller
 * (`createOnememoryMcpContext`) and shared; the per-request McpServer instances reference it.
 */
export function createOnememoryStreamableHttpHandler(
  context: OnememoryMcpContext,
  options: CreateStreamableHttpOptions = {},
): McpHttpHandler {
  const handler = createMcpHandler(() => buildOnememoryServer(context, options), options.handlerOptions);
  if (options.gate === undefined) return handler;
  const gate = options.gate;
  // Wrap WITHOUT spreading: `fetch` detaches safely, but `notify`/`bus` delegate as references
  // so their internal bindings survive.
  const gated: McpHttpHandler = {
    async fetch(request: Request, requestOptions?: McpHandlerRequestOptions): Promise<Response> {
      const authInfo: AuthInfo | Response = await gate(request);
      if (authInfo instanceof Response) return authInfo;
      return handler.fetch(request, { ...(requestOptions ?? {}), authInfo });
    },
    close: () => handler.close(),
    notify: handler.notify,
    bus: handler.bus,
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
