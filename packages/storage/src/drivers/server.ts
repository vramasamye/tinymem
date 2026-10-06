/**
 * Server driver: node-postgres (`pg`) against Docker Compose Postgres 17 + pgvector, managed
 * cloud Postgres, or hosted SaaS Postgres (ADR-0002 server/cloud profiles — the canonical,
 * fully-supported deployment). Same repository API as the embedded driver.
 */

import pg from 'pg';

import { createCodeMemoryStore, createJobQueue, createStore } from '../store';
import { createEventsCompactor } from '../retention/events-compaction';
import { createEmbeddingIndex } from '../vectors/embedding-index';

import type { Database, QueryResult } from './client';
import { migrateServer } from './migrate';
import {
  DEFAULT_VECTOR_CONFIG,
  type OnememoryStorage,
  type VectorConfig,
} from './types';

/** Options for the server driver. */
export interface ServerDbOptions {
  /** Apply committed migrations on open (default true; idempotent, advisory-locked). */
  migrate?: boolean;
  /** Vector index configuration (default 384 dims, 'local/minilm-l6-v2', auto backend). */
  vector?: VectorConfig;
  /** Max pool size (default 10). */
  poolSize?: number;
}

/** A single pooled connection bound to a transaction. */
class ServerClientDatabase implements Database {
  readonly profile = 'server' as const;
  private depth = 0;

  constructor(private readonly client: pg.PoolClient) {}

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    const result = await this.client.query<Row>(text, [...(params ?? [])]);
    return { rows: result.rows, rowCount: result.rowCount ?? null };
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
        console.error('onememory: transaction rollback failed', rollbackError);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    this.client.release();
  }
}

export class ServerDatabase implements Database {
  readonly profile = 'server' as const;
  /** The underlying node-postgres pool (used by the migration runner). */
  readonly pool: pg.Pool;

  constructor(connectionUrl: string, poolSize?: number) {
    this.pool = new pg.Pool({ connectionString: connectionUrl, max: poolSize ?? 10 });
  }

  async query<Row extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<QueryResult<Row>> {
    const result = await this.pool.query<Row>(text, [...(params ?? [])]);
    return { rows: result.rows, rowCount: result.rowCount ?? null };
  }

  async transaction<T>(work: (tx: Database) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    const txDatabase = new ServerClientDatabase(client);
    try {
      // Delegate to the connection-bound wrapper: it issues BEGIN/COMMIT/ROLLBACK (or nested
      // SAVEPOINTs) so a multi-statement repository write is atomic. Running `work` directly on
      // the wrapper would execute every statement in autocommit — partial writes on failure.
      return await txDatabase.transaction(work);
    } finally {
      await txDatabase.close();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Open a server-profile database: a connection URL to Postgres 17 + pgvector (Docker Compose,
 * managed, or hosted). The vector extension is created when missing (needs appropriate grants;
 * the docker init script does this out of the box — M13).
 */
export async function createServerClient(connectionUrl: string): Promise<ServerDatabase> {
  const database = new ServerDatabase(connectionUrl);
  await database.query('CREATE EXTENSION IF NOT EXISTS vector');
  return database;
}

/**
 * Open the server-profile storage (Docker Compose Postgres 17 + pgvector, managed cloud Postgres,
 * or hosted SaaS Postgres): the same repository API as the embedded profile, canonical target.
 */
export async function createServerDb(
  connectionUrl: string,
  options: ServerDbOptions = {},
): Promise<OnememoryStorage> {
  const client = new ServerDatabase(connectionUrl, options.poolSize);
  await client.query('CREATE EXTENSION IF NOT EXISTS vector');
  if (options.migrate !== false) {
    await migrateServer(client.pool);
  }
  const vectorConfig = { ...DEFAULT_VECTOR_CONFIG, ...options.vector };
  const vectors = await createEmbeddingIndex(client, vectorConfig);
  return {
    profile: 'server',
    client,
    store: createStore(client),
    jobs: createJobQueue(client),
    codeMemory: createCodeMemoryStore(client),
    vectors,
    compactor: createEventsCompactor(client),
    migrate: () => migrateServer(client.pool),
    close: () => client.close(),
  };
}
