/**
 * The sessionful Streamable HTTP transport (backlog M5 issue 2: "Streamable HTTP transport
 * (server mode) with session management"; ADR-0010 §1's optional HTTP surface, session form).
 *
 * Transport mechanics are the official SDK's, not ours (AGENTS.md rule 2):
 * `WebStandardStreamableHTTPServerTransport` from `@modelcontextprotocol/server` 2.3.0 owns the
 * wire — POST/GET/DELETE handling, `Mcp-Session-Id` generation + validation (initialize gets a
 * fresh id; later requests without one → 400; a wrong one → 404 "Session not found"),
 * SSE framing (`event: message` frames + `id:` lines + keep-alive comment frames), batch
 * limits, the 4-MiB body bound, the `Accept`/`Content-Type` gates (406/415), and
 * `Last-Event-ID` resumability via the `EventStore` port.
 *
 * What this module adds is the per-process SESSION REGISTRY the SDK deliberately leaves to
 * the host (one transport instance holds exactly ONE session): a request router that maps
 * `Mcp-Session-Id` → {transport, McpServer} so ONE shared `OnememoryMcpContext` serves MANY
 * concurrent agent sessions. Every session gets a FRESH `McpServer` from
 * `buildOnememoryServer` — the same factory stdio pins per connection — against the SAME
 * context (one storage, one engine, one result-cache domain).
 *
 * Scope honesty: sessions are in-process (a restart drops them; clients reconnect, which the
 * transport's `Last-Event-ID` resumability makes safe). A multi-node session registry is a
 * documented follow-up; the single-process shape is the standard first-tier deployment.
 */

import { randomUUID } from 'node:crypto';

import {
  WebStandardStreamableHTTPServerTransport,
  type AuthInfo,
  type EventStore,
  type McpServer,
} from '@modelcontextprotocol/server';

import type { OnememoryMcpContext } from '../context';
import { buildOnememoryServer, type BuildServerOptions } from '../server';
import type { BearerGate } from './auth';
import { InMemoryResumabilityStore } from './event-store';

/** The session header (lowercase on the wire — HTTP headers are case-insensitive). */
const SESSION_HEADER = 'mcp-session-id';

/** Default cap on live sessions per process (each holds an McpServer + stream buffers). */
export const DEFAULT_MAX_SESSIONS = 256;

/** Default SSE keep-alive interval (matches the SDK's 15000ms default; 0 disables). */
export const DEFAULT_KEEP_ALIVE_MS = 15_000;

export interface CreateSessionManagerOptions extends BuildServerOptions {
  /** The shared context every session's McpServer is built against. */
  context: OnememoryMcpContext;
  /** Resumability store (default: the in-memory bounded store). */
  eventStore?: EventStore;
  /** Live-session cap; a new initialize above the cap is answered 503 (default 256). */
  maxSessions?: number;
  /** SSE keep-alive interval in ms (default 15000; 0 disables). */
  keepAliveMs?: number;
  /** The bearer gate (server mode); absent → no auth, the local-first default. */
  gate?: BearerGate;
  /** Out-of-band error reporting (default: console.error — the transport's convention). */
  onError?: (error: Error) => void;
  /**
   * Session id generator (tests). Production default: `crypto.randomUUID()` — session ids are
   * bearer credentials the spec requires to be "globally unique and cryptographically secure",
   * so the UUIDv7 entity-id convention intentionally does NOT apply here (v7 embeds a timestamp
   * and a predictable node; v4 is unstructured random).
   */
  sessionIdGenerator?: () => string;
}

export interface SessionInfo {
  readonly sessionId: string;
  readonly connectedAt: string;
}

interface ManagedSession {
  transport: WebStandardStreamableHTTPServerTransport;
  server: McpServer;
  connectedAt: string;
}

export interface OnememorySessionManager {
  /** Route one HTTP request (POST initialize creates a session; the rest route by header). */
  handle(request: Request, options?: { authInfo?: AuthInfo }): Promise<Response>;
  /** Live sessions (introspection). */
  sessions(): readonly SessionInfo[];
  /** Explicitly terminate one session (DELETE does the same through `handle`). */
  terminate(sessionId: string): Promise<void>;
  /** Terminate every session (graceful shutdown; closing storage/context is the caller's job). */
  close(): Promise<void>;
}

/**
 * The sessionful request router. ONE manager per serving process; concurrent sessions are
 * independent transports, so concurrent requests never serialize against each other (the
 * shared context's storage serializes WRITES internally, as every profile does).
 */
export function createStreamableHttpSessionManager(
  options: CreateSessionManagerOptions,
): OnememorySessionManager {
  const {
    context,
    eventStore,
    maxSessions = DEFAULT_MAX_SESSIONS,
    keepAliveMs = DEFAULT_KEEP_ALIVE_MS,
    gate,
    onError = (error) => console.error('onememory-mcp: streamable-http error:', error),
    sessionIdGenerator = () => randomUUID(),
  } = options;

  const sessions = new Map<string, ManagedSession>();
  const store: EventStore = eventStore ?? new InMemoryResumabilityStore();
  const ownedStore: InMemoryResumabilityStore | null =
    eventStore === undefined ? (store as InMemoryResumabilityStore) : null;

  function jsonRpcError(status: number, code: number, message: string, headers?: Record<string, string>): Response {
    return new Response(JSON.stringify({ jsonrpc: '2.0', error: { code, message }, id: null }), {
      status,
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    });
  }

  function dropStreamBuffers(sessionId: string): void {
    ownedStore?.dropStream(sessionId);
  }

  /**
   * Serve a session-creating POST: build the transport + a fresh McpServer on the shared
   * context, connect them, and delegate. Registration rides the SDK's `onsessioninitialized`
   * callback — the id is minted INSIDE `handleRequest`, so registering earlier is impossible.
   */
  async function openSession(request: Request, authInfo: AuthInfo | undefined, body: unknown): Promise<Response> {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator,
      eventStore: store,
      keepAliveMs,
      onsessioninitialized: (sessionId) => {
        sessions.set(sessionId, { transport, server, connectedAt: new Date().toISOString() });
      },
    });
    const server = buildOnememoryServer(context, options);
    // Deregister on ANY transport close (DELETE, client stream death, shutdown): a closed
    // transport must never be routed to again.
    transport.onclose = () => {
      const held = transport.sessionId;
      if (held !== undefined && sessions.get(held)?.transport === transport) {
        sessions.delete(held);
        dropStreamBuffers(held);
      }
      void server.close().catch(onError);
    };
    await server.connect(transport);
    const response = await transport.handleRequest(request, {
      parsedBody: body,
      ...(authInfo === undefined ? {} : { authInfo }),
    });
    // Refusals carry no `mcp-session-id` header, so any session the attempt minted is
    // unreachable — and a transport that never minted one is an orphan. Drop both; the
    // onclose hook handles the registry and the McpServer.
    if (transport.sessionId === undefined) {
      await transport.close().catch(onError);
    } else if (response.status >= 400) {
      sessions.delete(transport.sessionId);
      dropStreamBuffers(transport.sessionId);
      await transport.close().catch(onError);
    }
    return response;
  }

  const manager: OnememorySessionManager = {
    async handle(request, handleOptions): Promise<Response> {
      // The gate runs BEFORE any session routing (the MCP authorization spec: EVERY protected
      // request carries the bearer token, initialize included; only the RFC 9728 discovery
      // documents stay public, and those are served before the manager by the host entry).
      let authInfo: AuthInfo | undefined = handleOptions?.authInfo;
      if (gate !== undefined && authInfo === undefined) {
        const gated = await gate(request);
        if (gated instanceof Response) return gated;
        authInfo = gated;
      }

      const sessionId = request.headers.get(SESSION_HEADER);

      if (sessionId === null || sessionId === '') {
        switch (request.method) {
          case 'POST': {
            let body: unknown;
            try {
              body = await request.json();
            } catch {
              return jsonRpcError(400, -32_700, 'Parse error: Invalid JSON');
            }
            const messages = Array.isArray(body) ? body : [body];
            const isInitialize = messages.some(
              (message) =>
                typeof message === 'object' &&
                message !== null &&
                (message as { method?: unknown }).method === 'initialize',
            );
            if (!isInitialize) {
              return jsonRpcError(400, -32_600, 'Bad Request: Mcp-Session-Id header is required');
            }
            if (sessions.size >= maxSessions) {
              return jsonRpcError(
                503,
                -32_000,
                'Server busy: too many concurrent sessions; terminate one and retry',
                { 'retry-after': '1' },
              );
            }
            return openSession(request, authInfo, body);
          }
          case 'GET':
          case 'DELETE':
            // The client MUST address a session for these (spec 2025-06-18 §2.2); an
            // unidentified GET/DELETE can never be served by a sessionful server.
            return jsonRpcError(400, -32_600, 'Bad Request: Mcp-Session-Id header is required');
          default:
            return jsonRpcError(405, -32_600, 'Method not allowed.', { allow: 'GET, POST, DELETE' });
        }
      }

      const session = sessions.get(sessionId);
      if (session === undefined) {
        return jsonRpcError(404, -32_001, 'Session not found');
      }
      return session.transport.handleRequest(request, {
        ...(authInfo === undefined ? {} : { authInfo }),
      });
    },

    sessions(): readonly SessionInfo[] {
      return [...sessions.entries()].map(([sessionId, session]) => ({
        sessionId,
        connectedAt: session.connectedAt,
      }));
    },

    async terminate(sessionId): Promise<void> {
      const session = sessions.get(sessionId);
      if (session === undefined) return;
      // close() fires onclose → deregister + server.close() (the same path DELETE takes).
      await session.transport.close().catch(onError);
    },

    async close(): Promise<void> {
      const live = [...sessions.values()];
      for (const session of live) {
        await session.transport.close().catch(onError);
      }
    },
  };

  return manager;
}
