/**
 * Optional stateless Streamable HTTP (ADR-0010 §1): a shared-server mode for one onememory
 * instance behind many agents (and the hosted mode's transport). The SDK's `createMcpHandler`
 * builds a FRESH McpServer per request against the SAME shared context — stateless and
 * horizontally scalable by design, matching the 2026-07-28 protocol direction.
 *
 * GATED behind explicit opt-in: local-first default is stdio. NO SSE — removed from the spec,
 * rejected by Pi; this module never registers an SSE route. No session state is kept: auth
 * (OAuth bearer verification for hosted mode) is the deployer's edge concern and is NOT
 * implemented here (localhost-only binding is the operator's responsibility at this stage).
 */

import { createMcpHandler, type CreateMcpHandlerOptions, type McpHttpHandler } from '@modelcontextprotocol/server';

import { createOnememoryMcpContext, type OnememoryMcpContext, type OnememoryMcpContextOptions } from './context';
import { buildOnememoryServer, type BuildServerOptions } from './server';

export interface CreateStreamableHttpOptions extends BuildServerOptions {
  /** Passed through to the SDK handler (event bus for subscriptions, auth wiring, …). */
  handlerOptions?: CreateMcpHandlerOptions;
}

/**
 * Build the stateless Streamable HTTP handler. `context` must be created ONCE by the caller
 * (`createOnememoryMcpContext`) and shared; the per-request McpServer instances reference it.
 */
export function createOnememoryStreamableHttpHandler(
  context: OnememoryMcpContext,
  options: CreateStreamableHttpOptions = {},
): McpHttpHandler {
  return createMcpHandler(() => buildOnememoryServer(context, options), options.handlerOptions);
}

/**
 * Convenience wrapper: open the context from config, build the handler, and return both so the
 * host (Bun.serve, Node fetch adapter, Hono route, …) owns the socket lifecycle. `close()`
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
