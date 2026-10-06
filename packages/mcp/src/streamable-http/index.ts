/**
 * The sessionful Streamable HTTP surface (server mode — backlog M5 issue 2, M5b AC 1):
 * sessions over the shared context, `Mcp-Session-Id` handling, SSE framing, and
 * `Last-Event-ID` resumability — the transport mechanics from `@modelcontextprotocol/server`
 * 2.3.0 (`WebStandardStreamableHTTPServerTransport`), with onememory's session registry on
 * top. The stateless shared-server handler (ADR-0010 §1, the daemon's `/mcp` mount) stays in
 * `../http.ts`; both are real surfaces with different contracts:
 *
 * - stateless (`../http.ts`): one fresh McpServer per POST, no sessions — horizontally
 *   scalable, the 2026-07-28 direction, the daemon's embedded-profile mount.
 * - sessionful (this directory): one long-lived session per agent client — server-initiated
 *   streams (GET SSE), resumability, and per-session transport state; the 2025-06-18 spec
 *   form runtimes launch against a server-mode endpoint.
 */

export {
  InMemoryResumabilityStore,
  DEFAULT_MAX_EVENTS_PER_STREAM,
  type InMemoryResumabilityStoreOptions,
} from './event-store';

export {
  createStreamableHttpSessionManager,
  DEFAULT_MAX_SESSIONS,
  DEFAULT_KEEP_ALIVE_MS,
  type OnememorySessionManager,
  type CreateSessionManagerOptions,
  type SessionInfo,
} from './session-manager';

export { createBearerGate, type McpAuthGateOptions, type BearerGate } from './auth';

export {
  createOnememoryStreamableHttpServer,
  type ServeStreamableHttpOptions,
  type StreamableHttpAuthOptions,
  type OnememoryStreamableHttpHandle,
} from './serve';
