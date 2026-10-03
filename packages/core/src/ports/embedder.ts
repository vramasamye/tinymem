/**
 * Embedding ports. Two distinct seams:
 *
 * - `Embedder` (stage: EXTRACT/vector channel) turns text into vectors — implemented by
 *   `packages/embeddings` (local transformers.js, Ollama, OpenAI-compatible; M3).
 * - `EmbeddingIndex` is the vector STORE: upsert/remove/KNN for memory vectors — implemented by
 *   `packages/storage` (pgvector when the extension loads; the GATE-1 `float8[]` fallback with
 *   in-process cosine when it does not — database-schema.md §5).
 *
 * `EmbeddingIndex` lives in core (not storage) because retrieval (M2) must reach it without
 * depending on the storage package; the *fallback switch* is what database-schema.md isolates
 * inside packages/storage — one module changes, not the model.
 */

export interface Embedder {
  /** e.g. 'local/minilm-l6-v2' — recorded with every stored vector. */
  readonly model: string;
  /** Fixed per deployment (config at init); a model swap goes through the re_embed job (ADR-0006). */
  readonly dim: number;
  embed(texts: string[]): Promise<number[][]>;
}

export type EmbeddingBackend = 'pgvector' | 'float8';

export interface EmbeddingIndexOptions {
  dim: number;
  model: string;
  /** 'auto': pgvector if the extension + vector column are usable, else the float8 fallback. */
  backend?: EmbeddingBackend | 'auto';
}

export interface VectorSearchOptions {
  /** Drop matches below this cosine similarity (default 0). */
  minCosine?: number;
}

export interface EmbeddingIndex {
  readonly backend: EmbeddingBackend;
  readonly dim: number;
  readonly model: string;
  /** Insert or replace the vector for a memory. */
  upsert(memoryId: string, embedding: number[]): Promise<void>;
  remove(memoryId: string): Promise<void>;
  /** K nearest neighbors by cosine similarity, best first. */
  search(query: number[], k: number, options?: VectorSearchOptions): Promise<VectorMatch[]>;
}

export interface VectorMatch {
  memory_id: string;
  cosine: number;
}
