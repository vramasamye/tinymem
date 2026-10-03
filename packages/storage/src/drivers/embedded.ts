/**
 * Embedded driver: PGlite (WASM Postgres) + the `@electric-sql/pglite-pgvector` extension.
 *
 * **Experimental, behind the ADR-0002 acceptance gate.** Single-owner-process: exactly one
 * process owns a data dir (risk D1) — `onemem serve` as a local daemon owns PGlite; CLI and MCP
 * stdio speak HTTP to it. Concurrent multi-agent use routes to the server profile.
 */

import { PGlite } from '@electric-sql/pglite';
import { vector as pgvectorExtension } from '@electric-sql/pglite-pgvector';
import type { Extensions, PGliteOptions } from '@electric-sql/pglite';

import { createJobQueue, createStore } from '../store';
import { createEmbeddingIndex } from '../vectors/embedding-index';

import type { Database, QueryResult } from './client';
import { migrateEmbedded } from './migrate';
import {
  DEFAULT_VECTOR_CONFIG,
  type OnememoryStorage,
  type VectorConfig,
} from './types';

/** Options for the embedded driver. */
export interface EmbeddedDbOptions {
  /**
   * Load the pgvector extension package (default true). Setting false models a PGlite build
   * without vector support — used by the GATE-1 acceptance suite to exercise the fallback.
   */
  vectorExtension?: boolean;
  /** Apply committed migrations on open (default true; idempotent). */
  migrate?: boolean;
  /** Vector index configuration (default 384 dims, 'local/minilm-l6-v2', auto backend). */
  vector?: VectorConfig;
  /** Extra PGlite constructor options (debug, filesystem, …). */
  pglite?: Omit<PGliteOptions, 'extensions'>;
}

export class EmbeddedDatabase implements Database {
  readonly profile = 'embedded' as const;
  /** The raw PGlite instance (used by the migration runner). */
  readonly pglite: PGlite;
  private depth = 0;

  constructor(pglite: PGlite) {
    this.pglite = pglite;
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    const result = await this.pglite.query<Row>(text, [...(params ?? [])]);
    return {
      rows: result.rows as Row[],
      rowCount: result.rowCount ?? result.affectedRows ?? null,
    };
  }

  async transaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    const savepoint = `onemem_sp_${this.depth}`;
    await this.query(this.depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
    this.depth += 1;
    try {
      const result = await work(this);
      this.depth -= 1;
      await this.query(this.depth === 0 ? 'COMMIT' : `RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      this.depth -= 1;
      try {
        await this.query(this.depth === 0 ? 'ROLLBACK' : `ROLLBACK TO SAVEPOINT ${savepoint}`);
      } catch (rollbackError) {
        // surface the original failure; the rollback error is secondary but must not be silent
        console.error('onememory: transaction rollback failed', rollbackError);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.pglite.close();
  }
}

/**
 * Open (or create) an embedded PGlite database at `dataDir` and load the pgvector extension.
 * `CREATE EXTENSION IF NOT EXISTS vector` follows the constructor: PGlite extension packages
 * register the extension in the catalog, and the CREATE call makes the `vector` type available.
 */
export async function createEmbeddedClient(
  dataDir: string,
  options: EmbeddedDbOptions = {},
): Promise<EmbeddedDatabase> {
  const loadExtension = options.vectorExtension !== false;
  const extensions: Extensions | undefined = loadExtension
    ? { vector: pgvectorExtension as unknown as Extensions['vector'] }
    : undefined;
  const pglite = await PGlite.create(dataDir, { ...options.pglite, extensions });
  if (loadExtension) {
    await pglite.exec('CREATE EXTENSION IF NOT EXISTS vector;');
  }
  return new EmbeddedDatabase(pglite);
}

/**
 * Open the embedded-profile storage: PGlite + pgvector behind the same repository API as the
 * server profile. **Experimental** (ADR-0002 acceptance gate); one owner process per data dir.
 */
export async function createEmbeddedDb(
  dataDir: string,
  options: EmbeddedDbOptions = {},
): Promise<OnememoryStorage> {
  const client = await createEmbeddedClient(dataDir, options);
  if (options.migrate !== false) {
    await migrateEmbedded(client.pglite);
  }
  const vectorConfig = { ...DEFAULT_VECTOR_CONFIG, ...options.vector };
  const vectors = await createEmbeddingIndex(client, vectorConfig);
  return {
    profile: 'embedded',
    client,
    store: createStore(client),
    jobs: createJobQueue(client),
    vectors,
    migrate: () => migrateEmbedded(client.pglite),
    close: () => client.close(),
  };
}
