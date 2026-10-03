/**
 * Retrieval request/response — a 1:1 Zod mirror of `event-memory-schemas.md` §6.
 * The token budget is the primary limit; memory count is secondary.
 */

import { z } from 'zod';

import { MEMORY_TYPES, MEMORY_STATUSES } from '../model/types';

const isoTimestamp = z.iso.datetime();

/** Explainability factors (spec §33): the `explain` array reconstructs the ranking. */
export const SCORE_FACTORS = [
  'project_match',
  'entity_match',
  'semantic_similarity',
  'lexical_relevance',
  'importance',
  'confidence',
  'recency',
  'access_frequency',
  'temporal_validity',
  'graph_proximity',
  'type_affinity',
] as const;
export type ScoreFactor = (typeof SCORE_FACTORS)[number];
export const ScoreFactorSchema = z.enum(SCORE_FACTORS);

export const SEARCH_INTENTS = [
  'fact',
  'how_to',
  'decision',
  'failure',
  'preference',
  'history',
  'context',
] as const;
export type SearchIntent = (typeof SEARCH_INTENTS)[number];

export const MemorySearchRequestSchema = z.looseObject({
  query: z.string().min(1),
  project_id: z.uuid().optional(),
  /** Hard ceiling for packed context (default 800). */
  max_tokens: z.number().int().min(1).optional(),
  /** Soft memory-count limit (default 10). */
  max_memories: z.number().int().min(1).optional(),
  types: z.array(z.enum(MEMORY_TYPES)).optional(),
  entities: z.array(z.string()).optional(),
  /** Point-in-time query (temporal mode). */
  as_of: isoTimestamp.optional(),
  temporal_mode: z.enum(['current', 'historical']).optional(),
  include: z
    .array(z.enum(['stale', 'superseded', 'archived', 'disputed'] as const))
    .optional(),
  /** Includes working memory of that session only. */
  session_id: z.string().optional(),
  /** Default false in prod, true in dev/CLI verbose. */
  explain: z.boolean().optional(),
});
export type MemorySearchRequest = z.infer<typeof MemorySearchRequestSchema>;

export const MemorySearchResponseSchema = z.looseObject({
  query_understanding: z.looseObject({
    intent: z.enum(SEARCH_INTENTS),
    entities: z.array(
      z.looseObject({
        name: z.string(),
        matched_id: z.uuid().optional(),
      }),
    ),
    time_scope: z
      .looseObject({
        from: isoTimestamp.optional(),
        until: isoTimestamp.optional(),
        mode: z.enum(['current', 'historical']),
      })
      .optional(),
    keywords: z.array(z.string()),
  }),
  memories: z.array(
    z.looseObject({
      id: z.uuid(),
      type: z.enum(MEMORY_TYPES),
      title: z.string().optional(),
      /** Packed representation (content_summary). */
      summary: z.string(),
      /** Included only if budget allows and detail > summary. */
      content: z.string().optional(),
      /** 0–1 final relevance (computed per query, never stored). */
      relevance: z.number().min(0).max(1),
      explain: z.array(
        z.looseObject({
          factor: ScoreFactorSchema,
          weight: z.number(),
          detail: z.string(),
        }),
      ),
      temporal: z.looseObject({
        valid_from: isoTimestamp,
        valid_until: isoTimestamp.optional(),
        status: z.enum(MEMORY_STATUSES),
      }),
      provenance: z.looseObject({
        source_kind: z.string(),
        source_uri: z.string().optional(),
        verified_at: isoTimestamp.optional(),
      }),
      conflicts: z
        .array(
          z.looseObject({
            memory_id: z.uuid(),
            note: z.string(),
          }),
        )
        .optional(),
    }),
  ),
  tokens: z.looseObject({
    budget: z.number().int().min(0),
    used: z.number().int().min(0),
    packing: z.enum(['summary', 'content', 'title-only']),
  }),
  /** e.g. "embedding index degraded: lexical only". */
  warnings: z.array(z.string()),
});
export type MemorySearchResponse = z.infer<typeof MemorySearchResponseSchema>;
