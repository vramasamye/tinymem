#!/usr/bin/env bun
/**
 * `onemem-mcp` — the server entry runtimes launch (`claude mcp add`, `[mcp_servers]` in
 * Codex config.toml, `.cursor/mcp.json`, `opencode.json`, `.pi/mcp.json`).
 *
 * Configuration is env-only (launch configs cannot pass flags): ONEMEMORY_MCP_PROFILE,
 * ONEMEMORY_DATA_DIR (embedded, default `.onememory` under the launch dir), ONEMEMORY_PG_URL
 * (switches to server Postgres), ONEMEMORY_PROJECT_ID, ONEMEMORY_MCP_AGENT_ID. The per-runtime
 * install files are M6/M13's job (`onemem init`); this bin is the process they point at.
 *
 * Transports (backlog M5.1/M5.2):
 * - `ONEMEMORY_MCP_TRANSPORT=stdio` (default): the wire stdio transports all five runtimes
 *   launch. NOTHING here writes to stdout; diagnostics go to stderr. stdin EOF is the shutdown
 *   signal (the SDK transport closes itself; a server holding no other keep-alive handles
 *   exits naturally). SIGINT/SIGTERM close the context cleanly.
 * - `ONEMEMORY_MCP_TRANSPORT=http` (server mode): the sessionful Streamable HTTP transport
 *   (`./streamable-http/`) on ONEMEMORY_MCP_HTTP_HOST:ONEMEMORY_MCP_HTTP_PORT (default
 *   127.0.0.1:7333) — `Mcp-Session-Id` handling, SSE framing, Last-Event-ID resumability.
 *   Binding a non-loopback host requires ONEMEMORY_MCP_HTTP_ALLOW_PUBLIC=true (loud, not
 *   silent — Phase 1 has no authentication by default). Optional OAuth 2.1 resource-server
 *   gating for server mode: ONEMEMORY_MCP_AUTH_ISSUER (+ ONEMEMORY_MCP_AUTH_SCOPES, default
 *   `onememory:read onememory:write`), verified against the issuer's JWKS.
 *
 * The embedded-storage single-owner guard (ADR-0002 + ADR-0010 amendment, M13c) runs BEFORE
 * any storage is opened for BOTH transports — a standalone HTTP server opening a data dir a
 * daemon owns is exactly the second-PGlite-owner hazard the guard exists to refuse.
 */

import { isLoopbackHost } from '@onememory/config';

import { mcpConfigFromEnv } from './config';
import { createOnememoryStreamableHttpServer } from './streamable-http';
import { createBearerGate, type BearerGate } from './streamable-http/auth';
import {
  buildOnememoryProtectedResourceMetadata,
  createJwtTokenVerifier,
  loadAuthorizationServerMetadata,
  DEFAULT_OAUTH_SCOPE,
  type OnememoryProtectedResourceOptions,
} from './oauth';
import { assertNoEmbeddedOwner } from './owner-guard';
import { serveOnememoryStdio } from './stdio';

/** The default port for `ONEMEMORY_MCP_TRANSPORT=http` (server mode). */
export const DEFAULT_MCP_HTTP_PORT = 7333;

export interface HttpServeEnv {
  /** `stdio` (default) | `http`. */
  ONEMEMORY_MCP_TRANSPORT?: string;
  /** Bind host for the HTTP transport (default `127.0.0.1`). */
  ONEMEMORY_MCP_HTTP_HOST?: string;
  /** Bind port for the HTTP transport (default 7333; `0` = ephemeral). */
  ONEMEMORY_MCP_HTTP_PORT?: string;
  /** Required to bind a non-loopback host (there is no default authentication). */
  ONEMEMORY_MCP_HTTP_ALLOW_PUBLIC?: string;
  /** Authorization-server issuer URL — turns on OAuth 2.1 bearer verification. */
  ONEMEMORY_MCP_AUTH_ISSUER?: string;
  /** Space-separated required scopes (default `onememory:read onememory:write`). */
  ONEMEMORY_MCP_AUTH_SCOPES?: string;
}

/** Resolve the HTTP transport options from env; throws loudly on invalid values. */
export function httpServeOptionsFromEnv(env: HttpServeEnv): {
  host: string;
  port: number;
  allowPublic: boolean;
  authIssuer: string | undefined;
  authScopes: string[];
} {
  const host = env.ONEMEMORY_MCP_HTTP_HOST === undefined || env.ONEMEMORY_MCP_HTTP_HOST === ''
    ? '127.0.0.1'
    : env.ONEMEMORY_MCP_HTTP_HOST;
  const portRaw = env.ONEMEMORY_MCP_HTTP_PORT;
  let port = DEFAULT_MCP_HTTP_PORT;
  if (portRaw !== undefined && portRaw !== '') {
    const parsed = Number(portRaw);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
      throw new Error(`ONEMEMORY_MCP_HTTP_PORT must be an integer 0-65535 (got ${JSON.stringify(portRaw)})`);
    }
    port = parsed;
  }
  const allowPublic = /^(1|true|yes)$/i.test(env.ONEMEMORY_MCP_HTTP_ALLOW_PUBLIC ?? '');
  const authIssuer =
    env.ONEMEMORY_MCP_AUTH_ISSUER === undefined || env.ONEMEMORY_MCP_AUTH_ISSUER === ''
      ? undefined
      : env.ONEMEMORY_MCP_AUTH_ISSUER;
  const authScopes =
    env.ONEMEMORY_MCP_AUTH_SCOPES === undefined || env.ONEMEMORY_MCP_AUTH_SCOPES === ''
      ? DEFAULT_OAUTH_SCOPE.split(' ')
      : env.ONEMEMORY_MCP_AUTH_SCOPES.split(/\s+/).filter(Boolean);
  return { host, port, allowPublic, authIssuer, authScopes };
}

export async function main(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  // Env is the only configuration surface a runtime launch config can set. Invalid values fail
  // loudly at boot (mcpConfigFromEnv throws) — the operator sees why the server died.
  const config = mcpConfigFromEnv(env);
  if (config.storage.mode === 'embedded') {
    // ADR-0002: exactly one owner process per embedded data dir — refuse BEFORE opening PGlite
    // when the daemon already owns it, pointing the operator at the daemon's MCP endpoint.
    // Server-profile storage (ONEMEMORY_PG_URL) is multi-process-safe and needs no guard.
    await assertNoEmbeddedOwner(config.storage.dataDir);
  }

  const transport = env.ONEMEMORY_MCP_TRANSPORT === undefined || env.ONEMEMORY_MCP_TRANSPORT === ''
    ? 'stdio'
    : env.ONEMEMORY_MCP_TRANSPORT;

  if (transport === 'stdio') {
    const handle = await serveOnememoryStdio({
      env,
      storageConfig: config.storage,
      profile: config.profile,
      ...(config.projectId !== undefined ? { projectId: config.projectId } : {}),
      agentId: config.agentId,
    });
    const shutdown = (signal: string) => {
      console.error(`onememory-mcp: ${signal} received, closing`);
      void handle.close().finally(() => process.exit(0));
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    return;
  }

  if (transport === 'http') {
    await serveHttp(config, env);
    return;
  }

  throw new Error(`ONEMEMORY_MCP_TRANSPORT must be "stdio" or "http" (got ${JSON.stringify(transport)})`);
}

/** The server-mode leg: sessionful Streamable HTTP, optional OAuth gating, Bun.serve socket. */
async function serveHttp(
  config: ReturnType<typeof mcpConfigFromEnv>,
  env: NodeJS.ProcessEnv & HttpServeEnv,
): Promise<void> {
  if (typeof Bun === 'undefined') {
    throw new Error('ONEMEMORY_MCP_TRANSPORT=http requires the Bun runtime (Bun.serve) — use stdio under Node');
  }
  const { host, port, allowPublic, authIssuer, authScopes } = httpServeOptionsFromEnv(env);
  if (!isLoopbackHost(host) && !allowPublic) {
    throw new Error(
      `refusing to bind ${host}: a non-loopback MCP HTTP server is reachable by other machines and has no authentication by default — set ONEMEMORY_MCP_HTTP_ALLOW_PUBLIC=true deliberately (or configure ONEMEMORY_MCP_AUTH_ISSUER for OAuth 2.1)`,
    );
  }

  // OAuth 2.1 resource-server gating is an explicit opt-in: the issuer's metadata + JWKS load
  // at boot (one fetch against the operator-configured issuer), so a misconfigured issuer
  // fails loudly before any request is served. Local-first default: no issuer → no auth, no
  // network calls at all.
  if (authIssuer !== undefined && port === 0) {
    throw new Error(
      'ONEMEMORY_MCP_AUTH_ISSUER requires an explicit ONEMEMORY_MCP_HTTP_PORT: an ephemeral port cannot be an OAuth resource identifier (the tokens\' audience would never match the bound port)',
    );
  }
  const resourceServerUrl = new URL(`http://${host}:${port}`);

  const handle = await createOnememoryStreamableHttpServer({
    env,
    storageConfig: config.storage,
    profile: config.profile,
    ...(config.projectId !== undefined ? { projectId: config.projectId } : {}),
    agentId: config.agentId,
    ...(authIssuer === undefined
      ? {}
      : {
          auth: await buildAuth({ issuer: authIssuer, scopes: authScopes, serverUrl: resourceServerUrl }),
        }),
  });

  const server = Bun.serve({
    hostname: host,
    port,
    fetch: (request) => handle.handle(request),
  });
  const boundPort = server.port ?? port;
  console.error(`onememory-mcp: streamable-http serving on http://${host}:${boundPort}`);
  if (authIssuer !== undefined) {
    console.error(`  auth: OAuth 2.1 (issuer ${authIssuer}, scopes ${authScopes.join(' ')})`);
  } else if (!isLoopbackHost(host)) {
    console.error('  WARNING: no authentication configured on a non-loopback bind.');
  }

  const shutdown = (signal: string) => {
    console.error(`onememory-mcp: ${signal} received, closing`);
    void (async () => {
      await server.stop(true);
      await handle.close();
      process.exit(0);
    })();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

/** Boot-time auth wiring: issuer metadata → JWKS verifier → the gate + discovery documents. */
async function buildAuth(options: {
  issuer: string;
  scopes: string[];
  serverUrl: URL;
}): Promise<{ gate: BearerGate; protectedResource: OnememoryProtectedResourceOptions }> {
  const authorizationServerMetadata = await loadAuthorizationServerMetadata(options.issuer);
  const verifier = await createJwtTokenVerifier({ issuer: options.issuer });
  // Build once at boot: the SDK validates the issuer against its metadata HERE, so a
  // misconfigured issuer dies before the socket opens.
  buildOnememoryProtectedResourceMetadata({
    resourceServerUrl: options.serverUrl,
    authorizationServerMetadata,
    scopesSupported: options.scopes,
  });
  const gate = createBearerGate({
    authorizationServerMetadata,
    verifier,
    requiredScopes: options.scopes,
    expectedResource: options.serverUrl,
    resourceServerUrl: options.serverUrl,
  });
  return {
    gate,
    protectedResource: {
      resourceServerUrl: options.serverUrl,
      authorizationServerMetadata,
      scopesSupported: options.scopes,
    },
  };
}

if (import.meta.main) {
  main().catch((error) => {
    // Boot failures (bad env, unwritable data dir, unreachable Postgres) must be loud — a
    // runtime that spawns this server needs to see WHY the connection died.
    console.error('onememory-mcp: failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
