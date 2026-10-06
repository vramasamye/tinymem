/**
 * `onemem serve` — start the daemon (ADR-0002): the single process that owns embedded storage,
 * answers the REST API on loopback, and drains the `normalize → extract → re_embed` job queue.
 *
 * Everything hard (lock file, single-owner check, self-check before the lock is written, graceful
 * shutdown that drains the worker) lives in the runtime so the API and the CLI cannot disagree.
 *
 * M5b — OAuth 2.1 for server mode: `--mcp-auth <issuer>` loads the issuer's metadata + JWKS at
 * STARTUP (the daemon refuses to boot on a misconfigured issuer — fail loudly, not on request
 * one) and gates the daemon's `/mcp` endpoint with bearer verification. The stored client
 * credential (`onemem auth`) is reported when present, so a single-box operator sees the whole
 * auth state. Absent → no auth, the local-first default (zero network calls).
 */

import { startDaemon, type DaemonHandle } from '@onememory/api/runtime';
import type { Io } from '../io';

export interface ServeOptions {
  cwd?: string;
  configPath?: string | null;
  env?: Record<string, string | undefined>;
  host?: string;
  port?: number;
  /** Required to bind a non-loopback host. */
  listenPublic?: boolean;
  /**
   * M5b: authorization-server issuer for OAuth 2.1 on the daemon's `/mcp` endpoint.
   * Loaded and verified at startup; gates every MCP request.
   */
  mcpAuthIssuer?: string;
  /** M5b: required scopes (default `onememory:read onememory:write`). */
  mcpAuthScopes?: string[];
}

export async function runServe(options: ServeOptions, io: Io): Promise<number> {
  const handle: DaemonHandle = await startDaemon({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.listenPublic === undefined ? {} : { listenPublic: options.listenPublic }),
    ...(options.mcpAuthIssuer === undefined
      ? {}
      : {
          mcpAuth: {
            issuer: options.mcpAuthIssuer,
            ...(options.mcpAuthScopes === undefined ? {} : { requiredScopes: options.mcpAuthScopes }),
          },
        }),
    onWarning: (message) => io.err(`warning: ${message}`),
  });
  const info = handle.info;
  io.emit(info);
  io.out(`onememory serving ${info.url} (pid ${info.pid})`);
  io.out(`  config: ${info.config_path ?? '(built-in defaults)'}`);
  io.out(`  data:   ${info.data_dir}`);
  io.out(`  worker: ${info.registered_handlers.join(', ')}`);
  io.out('  api:    GET /v1/health, /openapi.json (loopback; no authentication in Phase 1)');
  io.out(
    options.mcpAuthIssuer === undefined
      ? '  mcp:    POST /mcp (streamable HTTP, stateless; no authentication — the local default)'
      : `  mcp:    POST /mcp (streamable HTTP; OAuth 2.1, issuer ${options.mcpAuthIssuer}, scopes ${(options.mcpAuthScopes ?? ['onememory:read', 'onememory:write']).join(' ')})`,
  );
  if (info.mcp_auth?.credential_present === true) {
    io.out(`  note:   a local client credential for issuer ${info.mcp_auth.issuer} is stored (${info.mcp_auth.credential_path})`);
  } else if (options.mcpAuthIssuer !== undefined) {
    io.out('  note:   no local client credential stored — agents authorize with: onemem auth --server-url <daemon-url>');
  }
  for (const warning of info.warnings) io.out(`  note:   ${warning}`);
  io.out('stop with Ctrl-C (SIGINT) — in-flight jobs finish, then the lock file is removed.');
  // Bun.serve keeps the process alive; stop() runs on SIGTERM/SIGINT (installed by startDaemon).
  void handle;
  return 0;
}
