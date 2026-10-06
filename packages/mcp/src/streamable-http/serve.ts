/**
 * The server-mode serving entry for the sessionful Streamable HTTP transport: opens the MCP
 * context, builds the session manager, optionally wires the OAuth bearer gate + the RFC 9728
 * discovery documents, and (in the Bun runtime) owns a `Bun.serve` socket.
 *
 * The standalone `onemem-mcp` bin uses this for `ONEMEMORY_MCP_TRANSPORT=http` (server-mode
 * deployments where agents reach onememory over HTTP); tests drive `handle` directly with
 * real `Request`s — no socket needed. The embedded-storage single-owner guard stays in the
 * bin (transport-independent, exactly where the stdio path runs it).
 */

import {
  createOnememoryMcpContext,
  type OnememoryMcpContext,
  type OnememoryMcpContextOptions,
} from '../context';
import { createBearerGate, type BearerGate } from './auth';
import { createStreamableHttpSessionManager, type OnememorySessionManager, type CreateSessionManagerOptions } from './session-manager';
import { onememoryOauthMetadataResponse, type OnememoryProtectedResourceOptions } from '../oauth/metadata';

export interface StreamableHttpAuthOptions {
  /** The bearer gate (built by the caller — `createBearerGate` + a verifier). */
  gate: BearerGate;
  /** The RFC 9728 discovery documents served on the well-known routes (public by design). */
  protectedResource: OnememoryProtectedResourceOptions;
}

export interface ServeStreamableHttpOptions extends OnememoryMcpContextOptions {
  /** Session-manager tuning (session cap, keep-alive, resumability store). */
  sessions?: Omit<CreateSessionManagerOptions, 'context' | 'gate'>;
  /** OAuth gate + discovery documents for server mode; absent → no auth (the local default). */
  auth?: StreamableHttpAuthOptions;
  /** Out-of-band error reporting (default: console.error — stderr, never stdout). */
  onError?: (error: Error) => void;
}

export interface OnememoryStreamableHttpHandle {
  /** Route one request: well-known OAuth documents when authed, then sessionful /mcp. */
  handle(request: Request): Promise<Response>;
  /** The shared context (storage/engine access for the host). */
  context: OnememoryMcpContext;
  /** The session manager (introspection + explicit terminate). */
  manager: OnememorySessionManager;
  /** Close all sessions + storage (graceful shutdown). */
  close(): Promise<void>;
}

/**
 * Open the context, build the session manager, and return the fetch-shaped handle. The host
 * owns the socket: `Bun.serve({ fetch: handle.handle, ... })` in the bin, direct calls in
 * tests. The RFC 9728/8414 discovery documents are served AROUND the gate (clients must be
 * able to discover the authorization server BEFORE they hold a token — that is the point of
 * the document).
 */
export async function createOnememoryStreamableHttpServer(
  options: ServeStreamableHttpOptions = {},
): Promise<OnememoryStreamableHttpHandle> {
  const context = await createOnememoryMcpContext(options);
  const manager = createStreamableHttpSessionManager({
    ...(options.sessions ?? {}),
    context,
    ...(options.auth === undefined ? {} : { gate: options.auth.gate }),
    ...(options.onError === undefined ? {} : { onError: options.onError }),
  });

  const authOptions = options.auth?.protectedResource;

  const handle: OnememoryStreamableHttpHandle = {
    async handle(request: Request): Promise<Response> {
      if (authOptions !== undefined) {
        const metadata = onememoryOauthMetadataResponse(request, authOptions);
        if (metadata !== undefined) return metadata;
      }
      return manager.handle(request);
    },
    context,
    manager,
    async close(): Promise<void> {
      await manager.close();
      await context.storage.close();
    },
  };

  return handle;
}
