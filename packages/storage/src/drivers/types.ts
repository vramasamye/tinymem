/**
 * The storage object both drivers return — one repository API over both deployment profiles.
 */

import type { CodeMemoryStore, EmbeddingIndex, EventsCompactor, JobQueue, SkillStore, Store } from '@onememory/core';

import type { Database } from './client';

export interface OnememoryStorage {
  readonly profile: 'embedded' | 'server';
  /** The raw client abstraction repositories use (also the transaction boundary). */
  readonly client: Database;
  /** The core `Store` port implementation. */
  readonly store: Store;
  /** The core `JobQueue` port implementation. */
  readonly jobs: JobQueue;
  /** The core `CodeMemoryStore` port implementation (M4 persistence — ADR-0008). */
  readonly codeMemory: CodeMemoryStore;
  /** The core `EmbeddingIndex` port implementation (pgvector or the GATE-1 float8 fallback). */
  readonly vectors: EmbeddingIndex;
  /** The core `EventsCompactor` port implementation (M14.6 events compaction). */
  readonly compactor: EventsCompactor;
  /** The core `SkillStore` port implementation (M15 skill generation — the `skills` table). */
  readonly skills: SkillStore;
  /** Apply committed migrations (idempotent; advisory-locked on the server profile). */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

/** Vector index configuration — dimension is fixed per deployment (ADR-0002). */
export interface VectorConfig {
  dim: number;
  model: string;
  /** 'auto' (default) | 'pgvector' | 'float8'. */
  backend?: 'auto' | 'pgvector' | 'float8';
}

export const DEFAULT_VECTOR_CONFIG: VectorConfig = {
  dim: 384,
  model: 'local/minilm-l6-v2',
  backend: 'auto',
};
