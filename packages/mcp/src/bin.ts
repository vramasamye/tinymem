#!/usr/bin/env bun
/**
 * `onemem-mcp` — the stdio server entry runtimes launch (`claude mcp add`, `[mcp_servers]` in
 * Codex config.toml, `.cursor/mcp.json`, `opencode.json`, `.pi/mcp.json`).
 *
 * Configuration is env-only (launch configs cannot pass flags): ONEMEMORY_MCP_PROFILE,
 * ONEMEMORY_DATA_DIR (embedded, default `.onememory` under the launch dir), ONEMEMORY_PG_URL
 * (switches to server Postgres), ONEMEMORY_PROJECT_ID, ONEMEMORY_MCP_AGENT_ID. The per-runtime
 * install files are M6/M13's job (`onemem init`); this bin is the process they point at.
 *
 * Notes:
 * - stdio is the wire: NOTHING here writes to stdout; diagnostics go to stderr.
 * - stdin EOF is the shutdown signal (the SDK transport closes itself; a server holding no other
 *   keep-alive handles exits naturally). SIGINT/SIGTERM close the context cleanly.
 * - embedded storage is single-owner (ADR-0002): before opening it, the daemon lock is probed
 *   and a live daemon makes this bin refuse loudly (see owner-guard.ts).
 */

import { mcpConfigFromEnv } from './config';
import { assertNoEmbeddedOwner } from './owner-guard';
import { serveOnememoryStdio } from './stdio';

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
}

if (import.meta.main) {
  main().catch((error) => {
    // Boot failures (bad env, unwritable data dir, unreachable Postgres) must be loud — a
    // runtime that spawns this server needs to see WHY the connection died.
    console.error('onememory-mcp: failed to start:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
