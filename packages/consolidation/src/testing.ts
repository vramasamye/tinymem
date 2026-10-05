/**
 * Test seams for the consolidation package (and, later, the M11 benchmarks and cross-package
 * acceptance): in-memory `Embedder` / `EmbeddingIndex` doubles with caller-controlled vectors, a
 * `ModelRouter` double over a plain result table, and a `MemoryRecord` fixture builder.
 *
 * Nothing here is production code; it exists so the unit and integration tests never download a
 * model or open the network (AGENTS.md rule 4 cuts both ways).
 */

import {
  estimateTokens,
  type Embedder,
  type EmbeddingIndex,
  type EvidenceSpan,
  type MemoryRecord,
  type MemoryStatus,
  type MemoryType,
} from '@onememory/core';
import type { ModelRouter, ResolvedRoute, ModelOperation, StructuredGenerationResult } from '@onememory/llm';
import type { GenerateStructuredRequest } from '@onememory/llm';
import type { z } from 'zod';

// ---------------------------------------------------------------------------
// Embedder / EmbeddingIndex doubles
// ---------------------------------------------------------------------------

/** Content-addressed embeddings: the test hands in the exact vector for each content string. */
export class TableEmbedder implements Embedder {
  readonly model: string;
  readonly dim: number;
  private readonly table: ReadonlyMap<string, readonly number[]>;

  constructor(table: Record<string, readonly number[]>, model = 'test/embedder', dim?: number) {
    this.model = model;
    this.table = new Map(Object.entries(table));
    this.dim = dim ?? Object.values(table)[0]?.length ?? 0;
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const vector = this.table.get(text);
      if (vector === undefined) {
        throw new Error(`TableEmbedder: no fixture vector for content: ${text}`);
      }
      return [...vector];
    });
  }
}

/** In-process KNN index over the upserted vectors — the same contract `packages/storage` serves. */
export class MemoryEmbeddingIndex implements EmbeddingIndex {
  readonly backend = 'float8' as const;
  readonly model: string;
  readonly dim: number;
  private readonly vectors = new Map<string, readonly number[]>();
  /** Set to throw on the next search — failure-path tests. */
  failSearch = false;

  constructor(model: string, dim: number) {
    this.model = model;
    this.dim = dim;
  }

  async upsert(memoryId: string, embedding: number[]): Promise<void> {
    this.vectors.set(memoryId, embedding);
  }

  async remove(memoryId: string): Promise<void> {
    this.vectors.delete(memoryId);
  }

  async search(query: number[], k: number, options?: { minCosine?: number }): Promise<Array<{ memory_id: string; cosine: number }>> {
    if (this.failSearch) throw new Error('MemoryEmbeddingIndex: search failed (fixture)');
    const minCosine = options?.minCosine ?? 0;
    const matches: Array<{ memory_id: string; cosine: number }> = [];
    for (const [memoryId, vector] of this.vectors) {
      const cosine = cosineOf(query, vector);
      if (cosine >= minCosine) matches.push({ memory_id: memoryId, cosine });
    }
    matches.sort((a, b) => b.cosine - a.cosine);
    return matches.slice(0, k);
  }

  size(): number {
    return this.vectors.size;
  }
}

export function cosineOf(a: readonly number[], b: readonly number[]): number {
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

// ---------------------------------------------------------------------------
// ModelRouter double
// ---------------------------------------------------------------------------

export interface FakeRouterOptions {
  /** Contents of `isConfigured` — absent operation routes fail closed like the real router. */
  configured?: readonly ModelOperation[];
  /** Result returned for a successful `consolidate` generation. */
  outputs?: Partial<Record<ModelOperation, unknown>>;
  /** When true, every generation fails (the offline fallback path). */
  failAll?: boolean;
}

/** A router that never touches the network: configured routes answer from a table. */
export class FakeRouter implements ModelRouter {
  readonly profile = 'local' as const;
  private readonly options: FakeRouterOptions;
  /** Every structured request the router saw, for prompt assertions. */
  readonly requests: Array<GenerateStructuredRequest<never>> = [];

  constructor(options: FakeRouterOptions = {}) {
    this.options = options;
  }

  isConfigured(operation: ModelOperation): boolean {
    return this.options.configured?.includes(operation) ?? false;
  }

  configuredOperations(): ModelOperation[] {
    return [...(this.options.configured ?? [])];
  }

  resolve(operation: ModelOperation): ResolvedRoute {
    if (!this.isConfigured(operation)) {
      throw new Error(`FakeRouter: operation '${operation}' is not configured`);
    }
    return {
      operation,
      provider: { id: 'fake', kind: 'ollama' },
      model: 'fake-model',
      hosted: false,
    };
  }

  async generateStructured<T>(request: GenerateStructuredRequest<T>): Promise<StructuredGenerationResult<T>> {
    this.requests.push(request as GenerateStructuredRequest<never>);
    if (this.options.failAll === true) {
      return {
        ok: false,
        error: {
          kind: 'provider-error',
          message: 'FakeRouter: generation failed (fixture)',
          attempts: 1,
          provider_id: 'fake',
          operation: request.operation,
        },
      };
    }
    const output = this.options.outputs?.[request.operation];
    if (output === undefined) {
      return {
        ok: false,
        error: {
          kind: 'invalid-output',
          message: 'FakeRouter: no fixture output for the operation',
          attempts: 1,
          provider_id: 'fake',
          operation: request.operation,
        },
      };
    }
    const parsed = (request.schema as z.ZodType<T>).safeParse(output);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: 'invalid-output',
          message: `FakeRouter: fixture output failed the caller schema: ${JSON.stringify(parsed.error.issues)}`,
          attempts: 1,
          provider_id: 'fake',
          operation: request.operation,
          last_raw: JSON.stringify(output),
        },
      };
    }
    return {
      ok: true,
      value: parsed.data,
      attempts: 1,
      raw: JSON.stringify(output),
      route: { operation: request.operation, provider_id: 'fake', model: 'fake-model', hosted: false },
    };
  }
}

// ---------------------------------------------------------------------------
// MemoryRecord fixture
// ---------------------------------------------------------------------------

let fixtureCounter = 0;

export interface MemoryFixtureOverrides {
  id?: string;
  type?: MemoryType;
  subtype?: string;
  status?: MemoryStatus;
  content?: string;
  importance?: number;
  confidence?: number;
  access_count?: number;
  observed_at?: string;
  valid_from?: string;
  valid_until?: string;
  project_id?: string | null;
  user_id?: string | null;
  source_kind?: string;
  source_id?: string;
  evidence?: EvidenceSpan[];
  entities?: Array<{ id: string; name: string; kind: string }>;
  tags?: string[];
  verified_at?: string;
  agent_id?: string;
}

function fixtureId(): string {
  fixtureCounter += 1;
  return `00000000-0000-7000-8000-${String(fixtureCounter).padStart(12, '0')}`;
}

/** A complete, schema-valid `MemoryRecord` with fixture defaults and per-test overrides. */
export function memoryFixture(overrides: MemoryFixtureOverrides = {}): MemoryRecord {
  const id = overrides.id ?? fixtureId();
  const content = overrides.content ?? 'fixture content';
  const sourceId = overrides.source_id ?? '00000000-0000-7000-8001-000000000001';
  return {
    id,
    type: overrides.type ?? 'episodic',
    ...(overrides.subtype === undefined ? {} : { subtype: overrides.subtype }),
    content,
    status: overrides.status ?? 'active',
    importance: overrides.importance ?? 0.6,
    confidence: overrides.confidence ?? 0.7,
    access_count: overrides.access_count ?? 0,
    observed_at: overrides.observed_at ?? '2026-06-01T00:00:00.000Z',
    valid_from: overrides.valid_from ?? overrides.observed_at ?? '2026-06-01T00:00:00.000Z',
    ...(overrides.valid_until === undefined ? {} : { valid_until: overrides.valid_until }),
    created_at: '2026-06-01T00:00:00.000Z',
    updated_at: '2026-06-01T00:00:00.000Z',
    // `null` project/user means "no scope" on the wire records — stored as absent, not null.
    ...(overrides.project_id == null ? {} : { project_id: overrides.project_id }),
    ...(overrides.user_id == null ? {} : { user_id: overrides.user_id }),
    ...(overrides.agent_id === undefined || overrides.agent_id === null ? {} : { agent_id: overrides.agent_id }),
    provenance: {
      source: {
        id: sourceId,
        kind: overrides.source_kind ?? 'conversation',
        ...(overrides.source_id === undefined ? {} : { uri: `session/${sourceId}` }),
        title: 'fixture source',
      },
      evidence: overrides.evidence ?? [
        {
          source_id: sourceId,
          kind: 'message',
          locator: `session.jsonl:${fixtureCounter}`,
          excerpt: content.slice(0, 80),
        },
      ],
      extraction: { method: 'heuristic', prompt_version: 'fixture-v1' },
      ...(overrides.verified_at === undefined ? {} : { verified_at: overrides.verified_at }),
    },
    entities: overrides.entities ?? [],
    tags: overrides.tags ?? ['extracted'],
    token_estimate: estimateTokens(content),
  };
}

/** Call `await flushMicrotasks()` when a fire-and-forget path must settle before an assertion. */
export async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}
