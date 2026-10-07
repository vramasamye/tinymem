/**
 * The `EmbeddingIndex` port implementation — the GATE-1 seam (database-schema.md §5).
 *
 * Two backends behind one interface:
 * - **pgvector**: `memory_vectors.embedding vector(384)` + HNSW + `<=>` cosine KNN, when the
 *   pgvector extension is usable (PGlite ships it via @electric-sql/pglite-pgvector; server via
 *   the docker init script / CREATE EXTENSION).
 * - **float8 fallback**: `memory_vectors_alt.embedding float8[]` + in-process cosine KNN —
 *   exact/linear scan, fine at ≤10⁵ rows (brute force over the embedded corpus is milliseconds).
 *
 * The switch is isolated to this module: a late change touches one module, not the model.
 */

import { toSql } from 'pgvector';

import type { EmbeddingBackend, EmbeddingIndex, EmbeddingIndexOptions, VectorMatch } from '@onememory-ai/core';

import type { Database } from '../drivers/client';

export class EmbeddingIndexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmbeddingIndexError';
  }
}

function validateVector(embedding: readonly number[], dim: number, model: string): void {
  if (embedding.length !== dim) {
    throw new EmbeddingIndexError(
      `embedding dimension mismatch: index '${model}' expects ${dim}, got ${embedding.length}`,
    );
  }
  for (const value of embedding) {
    if (!Number.isFinite(value)) {
      throw new EmbeddingIndexError('embedding values must be finite numbers');
    }
  }
}

/** In-process cosine similarity for the fallback path. */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / Math.sqrt(normA * normB);
}

/** Is the pgvector extension loaded AND the memory_vectors table present? */
async function pgvectorUsable(db: Database): Promise<boolean> {
  const extension = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_type WHERE typname = 'vector'",
  );
  if ((extension.rows[0]?.n ?? 0) === 0) return false;
  const table = await db.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM pg_tables WHERE tablename = 'memory_vectors'",
  );
  return (table.rows[0]?.n ?? 0) > 0;
}

interface PgvectorIndex extends EmbeddingIndex {
  readonly backend: 'pgvector';
}

interface Float8Index extends EmbeddingIndex {
  readonly backend: 'float8';
}

function createPgvectorIndex(db: Database, options: EmbeddingIndexOptions): PgvectorIndex {
  return {
    backend: 'pgvector',
    dim: options.dim,
    model: options.model,
    async upsert(memoryId: string, embedding: number[]): Promise<void> {
      validateVector(embedding, options.dim, options.model);
      await db.query(
        `INSERT INTO memory_vectors (memory_id, model, dim, embedding)
           VALUES ($1::uuid, $2, $3, $4::vector)
           ON CONFLICT (memory_id)
           DO UPDATE SET model = EXCLUDED.model, dim = EXCLUDED.dim, embedding = EXCLUDED.embedding`,
        [memoryId, options.model, options.dim, toSql(embedding)],
      );
    },
    async remove(memoryId: string): Promise<void> {
      await db.query('DELETE FROM memory_vectors WHERE memory_id = $1::uuid', [memoryId]);
    },
    async search(query: number[], k: number, searchOptions): Promise<VectorMatch[]> {
      validateVector(query, options.dim, options.model);
      const minCosine = searchOptions?.minCosine ?? 0;
      const result = await db.query<{ memory_id: string; cosine: number }>(
        `SELECT memory_id, 1 - (embedding <=> $1::vector) AS cosine
           FROM memory_vectors
          WHERE model = $2 AND 1 - (embedding <=> $1::vector) >= $3
          ORDER BY embedding <=> $1::vector
          LIMIT $4`,
        [toSql(query), options.model, minCosine, k],
      );
      return result.rows.map((row) => ({ memory_id: row.memory_id, cosine: row.cosine }));
    },
  };
}

function createFloat8Index(db: Database, options: EmbeddingIndexOptions): Float8Index {
  return {
    backend: 'float8',
    dim: options.dim,
    model: options.model,
    async upsert(memoryId: string, embedding: number[]): Promise<void> {
      validateVector(embedding, options.dim, options.model);
      await db.query(
        `CREATE TABLE IF NOT EXISTS memory_vectors_alt (
            memory_id uuid PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
            model text NOT NULL,
            dim integer NOT NULL,
            embedding double precision[] NOT NULL
          )`,
      );
      await db.query(
        `INSERT INTO memory_vectors_alt (memory_id, model, dim, embedding)
           VALUES ($1::uuid, $2, $3, $4::float8[])
           ON CONFLICT (memory_id)
           DO UPDATE SET model = EXCLUDED.model, dim = EXCLUDED.dim, embedding = EXCLUDED.embedding`,
        [memoryId, options.model, options.dim, pgDoubleArray(embedding)],
      );
    },
    async remove(memoryId: string): Promise<void> {
      await db.query('DELETE FROM memory_vectors_alt WHERE memory_id = $1::uuid', [memoryId]);
    },
    async search(query: number[], k: number, searchOptions): Promise<VectorMatch[]> {
      validateVector(query, options.dim, options.model);
      const minCosine = searchOptions?.minCosine ?? 0;
      const result = await db.query<{ memory_id: string; embedding: number[] }>(
        `SELECT memory_id, embedding FROM memory_vectors_alt WHERE model = $1 AND dim = $2`,
        [options.model, options.dim],
      );
      const matches: VectorMatch[] = [];
      for (const row of result.rows) {
        const cosine = cosineSimilarity(query, row.embedding);
        if (cosine >= minCosine) matches.push({ memory_id: row.memory_id, cosine });
      }
      matches.sort((a, b) => b.cosine - a.cosine);
      return matches.slice(0, k);
    },
  };
}

/** Postgres array literal (`{v1,v2,...}`) for a float8[] parameter. */
function pgDoubleArray(values: readonly number[]): string {
  return `{${values.join(',')}}`;
}

/**
 * Create the vector index. `backend: 'auto'` (default) picks pgvector when the extension and the
 * migrated table are usable, else the float8 fallback; 'pgvector' fails loudly when unavailable
 * (deployment misconfiguration must not degrade silently); 'float8' forces the fallback (used by
 * the GATE-1 suite to exercise it end-to-end).
 */
export async function createEmbeddingIndex(
  db: Database,
  options: EmbeddingIndexOptions,
): Promise<EmbeddingIndex> {
  const requested: EmbeddingBackend | 'auto' = options.backend ?? 'auto';
  const usable = await pgvectorUsable(db);
  if (requested === 'pgvector' && !usable) {
    throw new EmbeddingIndexError(
      "pgvector backend requested but the vector extension or memory_vectors table is unavailable",
    );
  }
  const backend: EmbeddingBackend =
    requested === 'auto' ? (usable ? 'pgvector' : 'float8') : requested;
  return backend === 'pgvector'
    ? createPgvectorIndex(db, options)
    : createFloat8Index(db, options);
}
