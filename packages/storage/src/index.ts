/**
 * `@onememory/storage` — the Postgres-dialect port implementation (ADR-0002): PGlite (embedded,
 * experimental behind the GATE-1 acceptance gate) and Postgres+pgvector (server/cloud/SaaS), one
 * committed drizzle-kit migration set, and the only package with SQL.
 */

// Drivers (the two deployment profiles, same repository API)
export {
  EmbeddedDatabase,
  createEmbeddedClient,
  createEmbeddedDb,
  type EmbeddedDbOptions,
} from './drivers/embedded';
export {
  ServerDatabase,
  createServerClient,
  createServerDb,
  type ServerDbOptions,
} from './drivers/server';
export {
  migrateEmbedded,
  migrateServer,
  migrationsFolder,
  MIGRATION_ADVISORY_LOCK,
} from './drivers/migrate';
export {
  type Database,
  type QueryResult,
  PG_UNIQUE_VIOLATION,
  isUniqueViolation,
  toIso,
  toIsoOrNull,
  toStringArray,
  pgTextArray,
  pgUuidArray,
} from './drivers/client';
export type { OnememoryStorage, VectorConfig } from './drivers/types';
export { DEFAULT_VECTOR_CONFIG } from './drivers/types';

// Ports implemented here (core declares them; storage binds them)
export { createCodeMemoryStore, createJobQueue, createStore } from './store';

// Vector index (GATE-1 seam: pgvector | float8 fallback)
export {
  createEmbeddingIndex,
  EmbeddingIndexError,
  cosineSimilarity,
} from './vectors/embedding-index';

// Jobs worker
export {
  createJobWorker,
  createHandlerRegistry,
  JobKindNotImplemented,
  type JobWorker,
  type JobWorkerOptions,
  type JobHandler,
  type JobContext,
  type HandlerRegistry,
} from './jobs/worker';

// Drizzle schema (source of the committed migrations)
export * from './schema/tables';

// Repository layer (typed functions over the Database client)
export * as memoriesRepo from './repositories/memories';
export * as entitiesRepo from './repositories/entities';
export * as edgesRepo from './repositories/edges';
export * as searchRepo from './repositories/search';
export * as eventsRepo from './repositories/events';
export * as sourcesRepo from './repositories/projects';
export * as digestRepo from './repositories/digest';
export * as workingMemoryRepo from './repositories/working-memory';
export * as memoryEventsRepo from './repositories/memory-events';
export * as codeMemoryRepo from './repositories/code-memory';
export * as jobsRepo from './repositories/jobs';
export { ValidationError, NotFoundError } from './repositories/util';
// The code-ref hydration read model (M4g2) — consumed type-only by the retrieval engine.
export type { HydratedCodeRef } from './repositories/code-memory';

// Retention / events compaction (M14.6): the EventsCompactor port implementation + digest table
export { createEventsCompactor } from './retention/events-compaction';
export * as retentionRepo from './retention/events-compaction';
export { memoryEventsDigest } from './retention/tables';
