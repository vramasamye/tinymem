/**
 * The server context — every tool handler's dependency bundle, built once per server lifetime
 * (stdio: one per connection; the stateless HTTP handler: one shared context, fresh McpServer
 * per request — ADR-0010 §1: "stateless rewrite" direction).
 *
 * What lives here (and ONLY here):
 * - storage: opened from the config profile (embedded PGlite | server Postgres) via the storage
 *   drivers — SQL stays inside packages/storage;
 * - engine: `createRetrievalEngine` (the Searcher port) — memory_search and
 *   memory_project_context MUST ride it, never a reimplementation;
 * - the security redactor for every write path (redact BEFORE persisting);
 * - project-scope resolution (input → config → env) and the audited-actor identity.
 */

import type { Embedder, Store } from '@onememory/core';
import { createRetrievalEngine } from '@onememory/retrieval';
import type { RetrievalEngine } from '@onememory/retrieval';
import { createEmbeddedDb, createServerDb } from '@onememory/storage';
import { sourcesRepo, type OnememoryStorage } from '@onememory/storage';
import type { Database } from '@onememory/storage';
import { redactValue } from '@onememory/security';
import type { Redaction } from '@onememory/core';

import { resolveMcpConfig, type McpEnv, type OnememoryMcpConfig, type OnememoryMcpConfigInput, type StorageConfig } from './config';
import { SERVER_NAME, SERVER_VERSION } from './version';

export interface OnememoryMcpContext {
  readonly storage: OnememoryStorage;
  /** The Searcher port implementation — the ONLY retrieval path for tools. */
  readonly engine: RetrievalEngine;
  readonly config: OnememoryMcpConfig;
  /** The injected Embedder port instance, when configured (absent → lexical + graph only). */
  readonly embedder: Embedder | undefined;
  /** Injectable clock (tests pass a fixed one; production reads the wall clock). */
  readonly now: () => Date;
  readonly serverInfo: { name: string; version: string };
  /** The workspace path hint (CLAUDE_PROJECT_DIR) when present — provenance metadata only. */
  readonly workspaceHint: string | null;

  // -- resolved helpers used by every write path ------------------------------------------

  /** Project id for unscoped operations, resolved per call: input → config. */
  resolveProjectId(inputProjectId?: string): string | undefined;
  /** Redact any JSON value (deep) — the write-path ingest duty. Returns the clean value. */
  redact<T>(value: T): { value: T; redactions: Redaction[] };
  /** Audited-actor string for status transitions (database-schema.md §2 vocabulary). */
  readonly actor: string;
  /** The local implicit user id (single-user local mode), lazily created. */
  localUserId(): Promise<string>;
  /** Invalidate retrieval's result cache after a write in this scope. */
  invalidateSearchCache(projectId?: string): void;
}

export interface OnememoryMcpContextOptions extends Omit<OnememoryMcpConfigInput, 'storage'> {
  /**
   * The embedder injection point (ADR-0010 / AGENTS.md rule 2): pass an `Embedder` port instance
   * to light up the vector channel. Absent → fully-local lexical + graph retrieval (warned,
   * never silent). This package NEVER constructs a provider itself — M3 owns implementations.
   */
  embedder?: Embedder;
  /** Injectable clock for deterministic tests. */
  now?: () => Date;
  /** Pre-built storage (tests / the daemon); overrides the storage config profile. */
  storage?: OnememoryStorage;
  /**
   * Pre-built retrieval engine riding the injected `storage` — the daemon passes its runtime
   * engine so REST /v1 and MCP /mcp share one result-cache domain (retrieval.md §5; ADR-0010
   * amendment 2026-10-04). Requires `storage`: a shared engine reading one database while the
   * context writes another is never coherent, so the misconfiguration fails at construction.
   */
  engine?: RetrievalEngine;
  /** Storage profile config (embedded data dir | server Postgres URL) — used only when `storage` is NOT injected. */
  storageConfig?: StorageConfig;
  /** Environment for CLAUDE_PROJECT_DIR (defaults to process.env at bin time). */
  env?: McpEnv;
}

/** Open storage per the config profile (or take the injected instance). */
async function openStorage(
  config: OnememoryMcpConfig,
  injected: OnememoryStorage | undefined,
  embedder: Embedder | undefined,
): Promise<OnememoryStorage> {
  if (injected !== undefined) return injected;
  if (config.storage.mode === 'server') {
    return createServerDb(config.storage.url);
  }
  // The vector index dimension must match the injected embedder, or the KNN channel fails loudly
  // (mission-2: dim mismatch is a warned degraded mode, but there is no reason to cause it).
  const vector = embedder !== undefined ? { dim: embedder.dim, model: embedder.model } : undefined;
  return createEmbeddedDb(config.storage.dataDir, { vector });
}

/**
 * Build the server context. Storage is opened here (embedded: PGlite + migrations + vector index;
 * server: Postgres pool) unless injected. An injected engine+storage pair (the daemon) is adopted
 * as-is so every surface shares one cache domain; otherwise the retrieval engine is wired to the
 * same storage object, with the vector index dimension matched to the injected embedder when
 * present.
 */
export async function createOnememoryMcpContext(
  options: OnememoryMcpContextOptions = {},
): Promise<OnememoryMcpContext> {
  const { storage: injectedStorage, engine: injectedEngine, storageConfig, embedder, now: nowOption, env: envOption, ...configInput } = options;
  if (injectedEngine !== undefined && injectedStorage === undefined) {
    throw new Error(
      'engine injection requires storage injection: the shared engine must read the storage the context writes through (pass both from one runtime — see the daemon)',
    );
  }
  const config = resolveMcpConfig({
    ...configInput,
    ...(storageConfig !== undefined ? { storage: storageConfig } : {}),
  });
  const now = nowOption ?? (() => new Date());
  const storage = await openStorage(config, injectedStorage, embedder);
  const env = envOption ?? {};
  const workspaceHint = env.CLAUDE_PROJECT_DIR && env.CLAUDE_PROJECT_DIR !== '' ? env.CLAUDE_PROJECT_DIR : null;

  // Injected engine (daemon mode) wins: one cache domain across the REST and MCP surfaces.
  // Otherwise the engine rides the storage opened above, vector channel matched to the embedder.
  const engine = injectedEngine ?? createRetrievalEngine(storage, { embedder, now });

  const actor = `agent:${config.agentId}`;
  let cachedLocalUserId: string | null = null;

  return {
    storage,
    engine,
    config,
    embedder,
    now,
    workspaceHint,
    serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    actor,
    resolveProjectId(inputProjectId?: string): string | undefined {
      return inputProjectId ?? config.projectId;
    },
    redact<T>(value: T): { value: T; redactions: Redaction[] } {
      const result = redactValue(value, config.redactor);
      return { value: result.value as T, redactions: result.redactions };
    },
    async localUserId(): Promise<string> {
      if (cachedLocalUserId === null) {
        const user = await sourcesRepo.ensureLocalUser(storage.client);
        cachedLocalUserId = user.id;
      }
      return cachedLocalUserId;
    },
    invalidateSearchCache(projectId?: string): void {
      engine.invalidateCache(projectId);
    },
  };
}

export type { Store, Database };
