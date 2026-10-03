/**
 * `re_embed` job handler factory (ADR-0006 §5, ADR-0002 vector-dimension changes).
 *
 * Exported for M13's daemon wiring — this package does **not** register the job kind itself:
 * M13 builds the handler registry and decides when a re-embed is required (model swap, prefix or
 * normalization change, backfill). Until the daemon registers it, the worker fails `re_embed` jobs
 * loudly with `JobKindNotImplemented` rather than faking success.
 *
 * Invariants enforced here (fail closed, never silently mix vectors):
 * - `embedderMeta.model` must equal the embedder's model — provenance cannot drift from behaviour;
 * - the embedder's dimension must equal the vector index's dimension;
 * - a payload naming a different model/revision is a stale job and is rejected;
 * - every produced vector is dimension-checked before it reaches the index.
 *
 * The payload carries the text to embed. Re-embedding is an offline repopulation driven by the
 * enqueuer (which already has the memory rows), and `jobs.payload` is the pipeline's only
 * work-in-progress channel — `memory_vectors` stores vectors, not text.
 */

import type { EmbeddingIndex, Embedder } from '@onememory/core';
import { z } from 'zod';

import { EmbedderError, assertVectorDim, type EmbedderMeta } from './types';

export const RE_EMBED_JOB_KIND = 're_embed' as const;

export const ReEmbedJobPayloadSchema = z.object({
  /** Target model id; when present it must match the embedder (guards against stale jobs). */
  model: z.string().min(1).optional(),
  /** Target model revision; when present it must match the embedder's pinned revision. */
  revision: z.string().min(1).optional(),
  reason: z
    .enum(['model_change', 'prefix_change', 'normalization_change', 'dimension_change', 'backfill', 'manual'])
    .optional(),
  batch_index: z.number().int().min(0).optional(),
  batch_total: z.number().int().min(1).optional(),
  items: z
    .array(
      z.object({
        memory_id: z.uuid(),
        /** Text to embed (memory `title` + `content`); never persisted by this handler. */
        text: z.string().min(1),
      }),
    )
    .min(1)
    .max(1000),
});
export type ReEmbedJobPayload = z.infer<typeof ReEmbedJobPayloadSchema>;

/** Structural subset of core's `JobRecord` — what the handler needs. */
export interface ReEmbedJobLike {
  id: string;
  kind: string;
  payload: Record<string, unknown>;
}

export type ReEmbedErrorKind =
  | 'invalid-payload'
  | 'model-mismatch'
  | 'dimension-mismatch'
  | 'stale-job';

export class ReEmbedError extends Error {
  constructor(
    message: string,
    public readonly kind: ReEmbedErrorKind,
  ) {
    super(message);
    this.name = 'ReEmbedError';
  }
}

export interface ReEmbedJobResult {
  upserted: number;
  model: string;
  dim: number;
  revision: string | null;
}

export interface ReEmbedJobHandlerOptions {
  /** Items per `embedder.embed` call (default 32); bounds peak memory, not correctness. */
  batchSize?: number;
}

export function createReEmbedJobHandler(
  vectorsIndex: EmbeddingIndex,
  embedder: Embedder,
  embedderMeta: EmbedderMeta,
  options: ReEmbedJobHandlerOptions = {},
): (job: ReEmbedJobLike) => Promise<ReEmbedJobResult> {
  if (embedderMeta.model !== embedder.model) {
    throw new ReEmbedError(
      `embedder metadata model '${embedderMeta.model}' does not match the embedder's model '${embedder.model}'`,
      'model-mismatch',
    );
  }
  if (vectorsIndex.model !== embedder.model) {
    throw new ReEmbedError(
      `vector index is bound to model '${vectorsIndex.model}' but the embedder produces '${embedder.model}': vectors from different models never mix (ADR-0006 §5)`,
      'model-mismatch',
    );
  }
  if (embedderMeta.dim !== null && embedderMeta.dim !== vectorsIndex.dim) {
    throw new ReEmbedError(
      `embedder metadata dimension ${embedderMeta.dim} does not match the vector index dimension ${vectorsIndex.dim}`,
      'dimension-mismatch',
    );
  }
  // A local provider's dimension may be unknown until its first call; per-vector checks below
  // still enforce it. When it is known, reject the mismatch up front.
  let embedderDim: number | null = null;
  try {
    embedderDim = embedder.dim;
  } catch {
    embedderDim = null;
  }
  if (embedderDim !== null && embedderDim !== vectorsIndex.dim) {
    throw new ReEmbedError(
      `embedder dimension ${embedderDim} does not match the vector index dimension ${vectorsIndex.dim}`,
      'dimension-mismatch',
    );
  }

  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 32));

  return async function handleReEmbed(job: ReEmbedJobLike): Promise<ReEmbedJobResult> {
    if (job.kind !== RE_EMBED_JOB_KIND) {
      throw new ReEmbedError(
        `handler for '${RE_EMBED_JOB_KIND}' received a '${job.kind}' job`,
        'invalid-payload',
      );
    }
    const parsed = ReEmbedJobPayloadSchema.safeParse(job.payload);
    if (!parsed.success) {
      throw new ReEmbedError(
        `re_embed job ${job.id} has an invalid payload: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')} ${issue.message}`)
          .join('; ')}`,
        'invalid-payload',
      );
    }
    const payload = parsed.data;
    if (payload.model !== undefined && payload.model !== embedder.model) {
      throw new ReEmbedError(
        `re_embed job ${job.id} targets model '${payload.model}' but the configured embedder is '${embedder.model}': refusing to write vectors from a different model`,
        'stale-job',
      );
    }
    if (payload.revision !== undefined && payload.revision !== embedderMeta.revision) {
      throw new ReEmbedError(
        `re_embed job ${job.id} targets revision '${payload.revision}' but the configured embedder pins '${embedderMeta.revision ?? 'none'}'`,
        'stale-job',
      );
    }

    let upserted = 0;
    for (let index = 0; index < payload.items.length; index += batchSize) {
      const batch = payload.items.slice(index, index + batchSize);
      const vectors = await embedder.embed(batch.map((item) => item.text));
      if (vectors.length !== batch.length) {
        throw new EmbedderError(
          `embedder returned ${vectors.length} vectors for ${batch.length} texts`,
          embedderMeta.provider,
          'protocol',
        );
      }
      for (let offset = 0; offset < batch.length; offset += 1) {
        const item = batch[offset]!;
        const vector = vectors[offset]!;
        assertVectorDim(vector, vectorsIndex.dim, embedderMeta.provider, embedder.model);
        await vectorsIndex.upsert(item.memory_id, vector);
        upserted += 1;
      }
    }

    return {
      upserted,
      model: embedder.model,
      dim: vectorsIndex.dim,
      revision: embedderMeta.revision,
    };
  };
}
