/**
 * The retrieval engine — core's `Searcher` port implementation over the 8-stage pipeline
 * (docs/architecture/retrieval.md; ADR-0004):
 *
 *   1 query understanding (rules-first) → 2 candidate channels (lexical/vector/graph + session
 *   working memory) → 3 HARD temporal/status filter → 4 dedupe → 5 RRF fusion + weighted scoring
 *   → 6 optional rerank → 7 token-budget packing → 8 explain assembly.
 *
 * Degradation is explicit and never silent: a missing Embedder, embedding index, or reranker is
 * reported through `warnings` while the remaining channels carry the search.
 *
 * Caches (retrieval.md §5), small and honest: query→embedding (hash-keyed, TTL), result cache
 * keyed by the canonical request (invalidated by project writes through `invalidateCache()`),
 * per-scope in-memory entity indexes (TTL).
 */

import {
  canonicalJson,
  DURABLE_MEMORY_TYPES,
  MemorySearchRequestSchema,
  MemorySearchResponseSchema,
  sha256Hex,
} from '@onememory/core';
import type {
  DurableMemoryType,
  Embedder,
  EmbeddingIndex,
  MemorySearchRequest,
  MemorySearchResponse,
  MemoryType,
  Reranker,
  SearchIntent,
  Store,
} from '@onememory/core';
import { cosineSimilarity, searchRepo } from '@onememory/storage';
import type { Database } from '@onememory/storage';

import { candidateFromMemory, candidateFromWorking, mergeCandidates } from './candidates';
import type { RetrievalCandidate } from './candidates';
import { mergeConfig } from './config';
import type { RetrievalConfig, RetrievalConfigInput } from './config';
import { dedupeCandidates } from './dedupe';
import type { SimilarityFn } from './dedupe';
import { EntityIndex } from './entity-index';
import { scoreCandidates } from './fusion';
import type { ScoredCandidate } from './fusion';
import { packResults } from './packing';
import type { PackableItem } from './packing';
import { applyRerank } from './rerank';
import { resolveTemporalPolicy, passesTemporalFilter, policyAt } from './temporal';
import type { TemporalPolicy } from './temporal';
import { deriveLabel, deriveSummary } from './tokens';
import { understandQuery } from './understand';

// ---------------------------------------------------------------------------
// Public construction surface
// ---------------------------------------------------------------------------

/** What the engine needs from storage: the Store port, the SQL client (candidate channels), and
 * optionally the embedding index. `OnememoryStorage` satisfies this structurally. */
export interface RetrievalStorage {
  readonly store: Store;
  readonly client: Database;
  readonly vectors?: EmbeddingIndex;
}

export interface RetrievalEngineOptions {
  /** M3's Embedder implementation; absent → lexical + graph only (warned). */
  embedder?: Embedder;
  /** Optional rerank tier — runs only when `config.rerank.enabled` is also set (ADR-0004: opt-in). */
  reranker?: Reranker;
  config?: RetrievalConfigInput;
  /** Injectable clock (tests / deterministic runs). */
  now?: () => Date;
}

export interface CacheStats {
  embeddings: number;
  results: number;
  entityScopes: number;
}

export interface RetrievalEngine {
  /** The core `Searcher` port. */
  search(request: MemorySearchRequest): Promise<MemorySearchResponse>;
  readonly config: RetrievalConfig;
  /** Invalidate cached results — all, or one project's (plus unscoped queries). Call on writes. */
  invalidateCache(projectId?: string): void;
  invalidateEntityIndex(): void;
  cacheStats(): CacheStats;
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

interface ChannelRun {
  candidates: RetrievalCandidate[];
  ids: string[];
  active: boolean;
  failed: boolean;
}

export function createRetrievalEngine(
  storage: RetrievalStorage,
  options: RetrievalEngineOptions = {},
): RetrievalEngine {
  const config = mergeConfig(options.config);
  const nowFn = options.now ?? (() => new Date());
  const embedder = options.embedder;
  const reranker = options.reranker;

  const embeddings = new Map<string, { vector: number[]; expires: number }>();
  const results = new Map<string, { response: MemorySearchResponse; projectId: string | null; expires: number }>();
  const entityIndexes = new Map<string, EntityIndex>();

  function indexForScope(projectId: string | null): EntityIndex {
    const key = projectId ?? '__global__';
    const existing = entityIndexes.get(key);
    if (existing) return existing;
    if (entityIndexes.size >= 32) {
      const oldest = entityIndexes.keys().next().value;
      if (oldest !== undefined) entityIndexes.delete(oldest);
    }
    const index = new EntityIndex(
      (loadOptions) =>
        searchRepo.listScopeEntities(storage.client, { projectId, limit: loadOptions.limit }),
      { ttlMs: config.caches.entityTtlMs, maxEntities: config.caches.entityMaxEntries },
    );
    entityIndexes.set(key, index);
    return index;
  }

  async function queryEmbedding(query: string): Promise<number[]> {
    if (embedder === undefined) throw new Error('queryEmbedding: no embedder configured');
    const key = sha256Hex(`${embedder.model}:${embedder.dim}:${query}`);
    const cached = embeddings.get(key);
    if (cached && cached.expires > Date.now()) return cached.vector;
    // Query side prefers the port's optional embedQuery (bge-style query forms); embedders
    // without one fall back to embed (ADR-0006 post-M3 amendment).
    const queryEmbed = embedder.embedQuery
      ? (texts: string[]) => embedder.embedQuery!(texts)
      : (texts: string[]) => embedder.embed(texts);
    const [vector] = await queryEmbed([query]);
    if (vector === undefined) throw new Error('embedder returned no vector for the query');
    if (embeddings.size >= config.caches.embeddingMaxEntries) {
      const oldest = embeddings.keys().next().value;
      if (oldest !== undefined) embeddings.delete(oldest);
    }
    embeddings.set(key, { vector, expires: Date.now() + config.caches.embeddingTtlMs });
    return vector;
  }

  function makeDedupeSimilarity(): SimilarityFn | undefined {
    if (embedder === undefined) return undefined;
    const vectorsByHash = new Map<string, number[]>();
    const embedContent = async (candidate: RetrievalCandidate): Promise<number[]> => {
      const cached = vectorsByHash.get(candidate.contentHash);
      if (cached) return cached;
      const [vector] = await embedder.embed([candidate.content]);
      if (vector === undefined) throw new Error('embedder returned no vector');
      vectorsByHash.set(candidate.contentHash, vector);
      return vector;
    };
    return async (a, b): Promise<number | null> => {
      try {
        const [va, vb] = await Promise.all([embedContent(a), embedContent(b)]);
        return cosineSimilarity(va, vb);
      } catch {
        return null; // dedupe is an optimization tier; a failure here never breaks retrieval
      }
    };
  }

  // --- channels ------------------------------------------------------------

  async function runLexical(
    terms: readonly string[],
    filter: searchRepo.CandidateFilter,
    warnings: string[],
  ): Promise<ChannelRun> {
    try {
      const records = await searchRepo.searchLexical(
        storage.client,
        { terms, limit: config.lexical.limit },
        filter,
      );
      return {
        candidates: records.map((record, index) =>
          candidateFromMemory(record, { channels: { lexical: index + 1 } }),
        ),
        ids: records.map((record) => record.id),
        active: true,
        failed: false,
      };
    } catch (error) {
      warnings.push(`lexical channel failed: ${errorMessage(error)}`);
      return { candidates: [], ids: [], active: false, failed: true };
    }
  }

  async function runVector(queryText: string, filter: searchRepo.CandidateFilter, warnings: string[]): Promise<ChannelRun> {
    const vectors = storage.vectors;
    if (embedder === undefined) {
      warnings.push('vector channel unavailable (no embedding provider configured): lexical + graph only');
      return { candidates: [], ids: [], active: false, failed: false };
    }
    if (vectors === undefined) {
      warnings.push('embedding index unavailable: vector channel disabled');
      return { candidates: [], ids: [], active: false, failed: false };
    }
    if (embedder.model !== vectors.model) {
      warnings.push(
        `embedding model mismatch (index '${vectors.model}', embedder '${embedder.model}'): vector channel disabled`,
      );
      return { candidates: [], ids: [], active: false, failed: false };
    }
    if (embedder.dim !== vectors.dim) {
      warnings.push(
        `embedding dimension mismatch (index dim ${vectors.dim}, embedder dim ${embedder.dim}): vector channel disabled`,
      );
      return { candidates: [], ids: [], active: false, failed: false };
    }
    let embedding: number[];
    try {
      embedding = await queryEmbedding(queryText);
    } catch (error) {
      warnings.push(`vector channel failed: embedding error: ${errorMessage(error)}`);
      return { candidates: [], ids: [], active: false, failed: true };
    }
    // A zero-norm query has no direction to rank by; pgvector's cosine distance against it is
    // NaN, and NaN compares greater than every number in Postgres, so minCosine would admit
    // every row.
    if (!embedding.some((value) => value !== 0)) {
      return { candidates: [], ids: [], active: true, failed: false };
    }
    try {
      const matches = await vectors.search(embedding, config.vector.limit, {
        minCosine: config.vector.minCosine,
      });
      if (matches.length === 0) return { candidates: [], ids: [], active: true, failed: false };
      const records = await searchRepo.fetchMemoriesByIds(
        storage.client,
        matches.map((match) => match.memory_id),
        filter,
      );
      return {
        candidates: records.map((record, index) =>
          candidateFromMemory(record, { channels: { vector: index + 1 } }),
        ),
        ids: records.map((record) => record.id),
        active: true,
        failed: false,
      };
    } catch (error) {
      warnings.push(`vector channel failed: ${errorMessage(error)} (lexical + graph only)`);
      return { candidates: [], ids: [], active: false, failed: true };
    }
  }

  async function runGraph(input: {
    queryText: string;
    filter: searchRepo.CandidateFilter;
    policy: TemporalPolicy;
    nowIso: string;
    intent: SearchIntent;
    matchedEntityIds: readonly string[];
    requiredEntityIds: readonly string[];
    lexicalIds: readonly string[];
    vectorIds: readonly string[];
    warnings: string[];
  }): Promise<ChannelRun> {
    const { filter, policy, nowIso, intent, warnings } = input;
    const collected: RetrievalCandidate[] = [];
    const byId = new Map<string, RetrievalCandidate>();
    let graphRank = 0;
    const add = (record: Parameters<typeof candidateFromMemory>[0], boost: number, source: string): void => {
      const existing = byId.get(record.id);
      if (existing) {
        if (boost > existing.graphBoost) {
          existing.graphBoost = boost;
          existing.graphSource = source;
        }
        return;
      }
      graphRank += 1;
      const candidate = candidateFromMemory(record, {
        channels: { graph: graphRank },
        graphBoost: boost,
        graphSource: source,
      });
      byId.set(record.id, candidate);
      collected.push(candidate);
    };

    const failures: string[] = [];

    // (a) entity-bound memories (top N per entity, cap across entities)
    const entityIds = unique([...input.matchedEntityIds, ...input.requiredEntityIds]);
    if (entityIds.length > 0) {
      try {
        const bound = await searchRepo.memoriesForEntities(
          storage.client,
          { entityIds, perEntityLimit: config.graph.perEntityLimit, cap: config.graph.entityCap },
          filter,
        );
        for (const record of bound) add(record, 1.0, 'entity-bound (0-hop: query entity match)');
      } catch (error) {
        failures.push(`entity-bound: ${errorMessage(error)}`);
      }
    }

    // (b) 1–2 hop edge expansion from entity-bound + top lexical/vector seeds
    const seedIds = unique([
      ...collected.map((candidate) => candidate.id),
      ...input.lexicalIds.slice(0, config.graph.seedTopK),
      ...input.vectorIds.slice(0, config.graph.seedTopK),
    ]);
    if (seedIds.length > 0 && config.graph.hops > 0) {
      try {
        const neighbors = await searchRepo.expandGraphNeighbors(
          storage.client,
          { seedIds, hops: config.graph.hops, cap: config.graph.expansionCap, at: policyAt(policy, nowIso) },
          filter,
        );
        for (const neighbor of neighbors) {
          add(
            neighbor.memory,
            Math.pow(config.graph.decay, neighbor.hops),
            `${neighbor.hops}-hop graph neighbor (edge valid at query time)`,
          );
        }
      } catch (error) {
        failures.push(`edge expansion: ${errorMessage(error)}`);
      }
    }

    // (c) typed shortcuts (intent routing; MIRIX-style typed injection)
    if (intent === 'decision') {
      try {
        const decisions = await searchRepo.latestAcceptedDecisions(
          storage.client,
          { limit: config.graph.shortcutDecisions },
          filter,
        );
        for (const decision of decisions) {
          add(decision.memory, 0.9, 'typed shortcut: latest accepted decisions');
        }
      } catch (error) {
        failures.push(`decision shortcut: ${errorMessage(error)}`);
      }
    }
    if (intent === 'failure') {
      try {
        const failuresFound = await searchRepo.recentFailures(
          storage.client,
          { limit: config.graph.shortcutFailures },
          filter,
        );
        for (const failure of failuresFound) {
          add(failure.memory, 0.9, 'typed shortcut: known failures (recurrence-ordered)');
        }
      } catch (error) {
        failures.push(`failure shortcut: ${errorMessage(error)}`);
      }
    }

    if (failures.length > 0) {
      warnings.push(
        `graph channel ${collected.length > 0 ? 'partially ' : ''}failed: ${failures.join('; ')}`,
      );
    }
    return {
      candidates: collected,
      ids: collected.map((candidate) => candidate.id),
      active: true,
      failed: failures.length > 0 && collected.length === 0,
    };
  }

  async function runWorking(input: {
    sessionId?: string;
    nowIso: string;
    workingWanted: boolean;
    requiredEntityIds: readonly string[];
    warnings: string[];
  }): Promise<RetrievalCandidate[]> {
    if (input.sessionId === undefined || !input.workingWanted) return [];
    if (input.requiredEntityIds.length > 0) return []; // working rows carry no entity bindings
    try {
      const entries = await storage.store.listWorking(input.sessionId);
      return entries
        .filter((entry) => entry.promoted_memory_id === null && Date.parse(entry.expires_at) > Date.parse(input.nowIso))
        .map((entry) => candidateFromWorking(entry));
    } catch (error) {
      input.warnings.push(`working memory channel failed: ${errorMessage(error)}`);
      return [];
    }
  }

  /** Conflict labels for disputed results: contradicts-edge neighbors, or an honest self-note. */
  async function conflictsFor(client: Database, memoryId: string): Promise<Array<{ memory_id: string; note: string }>> {
    try {
      const neighbors = await searchRepo.contradictionNeighbors(client, memoryId);
      if (neighbors.length > 0) {
        return neighbors.map((neighbor) => ({
          memory_id: neighbor.memory_id,
          note: 'contradicts this memory (disputed — never silently picked as truth)',
        }));
      }
    } catch {
      // fall through to the honest note
    }
    return [
      { memory_id: memoryId, note: 'disputed: unresolved contradiction, no contradicting memory linked' },
    ];
  }

  // --- search -----------------------------------------------------------------

  async function search(rawRequest: MemorySearchRequest): Promise<MemorySearchResponse> {
    const request = MemorySearchRequestSchema.parse(rawRequest);
    const nowDate = nowFn();
    const nowIso = nowDate.toISOString();
    const warnings: string[] = [];

    const cacheKey = sha256Hex(canonicalJson(request));
    const cached = results.get(cacheKey);
    if (cached && cached.expires > Date.now()) {
      return structuredClone(cached.response);
    }

    // Stage 1 — query understanding (rules-first).
    const entityIndex = indexForScope(request.project_id ?? null);
    let matchedEntities: Awaited<ReturnType<EntityIndex['matchText']>> = [];
    try {
      matchedEntities = await entityIndex.matchText(request.query);
    } catch (error) {
      warnings.push(`entity lookup failed: ${errorMessage(error)}`);
    }
    const understanding = understandQuery(request.query, {
      matchedEntities: matchedEntities.map((entity) => ({ id: entity.id, name: entity.name })),
      now: nowDate,
    });

    // Resolve the request's entity filter (names → ids); unresolved → honest empty result.
    let requiredEntityIds: string[] = [];
    let entityFilterImpossible = false;
    if (request.entities !== undefined && request.entities.length > 0) {
      try {
        const resolution = await entityIndex.resolveNames(request.entities);
        for (const name of request.entities) {
          const entity = resolution.get(name) ?? null;
          if (entity === null) {
            warnings.push(`entity filter: '${name}' not found — no memory can match`);
            entityFilterImpossible = true;
          } else {
            requiredEntityIds.push(entity.id);
          }
        }
      } catch (error) {
        warnings.push(`entity filter resolution failed: ${errorMessage(error)}`);
        entityFilterImpossible = true;
      }
    }

    const policy = resolveTemporalPolicy(request, understanding, nowIso);
    const budget = request.max_tokens ?? config.packing.defaultMaxTokens;
    const understandingBlock: MemorySearchResponse['query_understanding'] = {
      intent: understanding.intent,
      entities: understanding.entities,
      keywords: understanding.keywords,
    };
    if (understanding.time_scope !== undefined) {
      understandingBlock.time_scope = {
        ...(understanding.time_scope.from !== undefined ? { from: understanding.time_scope.from } : {}),
        ...(understanding.time_scope.until !== undefined ? { until: understanding.time_scope.until } : {}),
        mode: understanding.time_scope.mode,
      };
    }

    const emptyResponse = (): MemorySearchResponse =>
      MemorySearchResponseSchema.parse({
        query_understanding: understandingBlock,
        memories: [],
        tokens: { budget, used: 0, packing: 'title-only' },
        warnings,
      }) as MemorySearchResponse;

    if (entityFilterImpossible) return emptyResponse();

    // Stage 2 — candidate channels (lexical + vector parallel; graph seeds on their heads).
    const durableTypes: DurableMemoryType[] | undefined =
      request.types === undefined
        ? undefined
        : (request.types.filter((type) =>
            (DURABLE_MEMORY_TYPES as readonly string[]).includes(type),
          ) as DurableMemoryType[]);
    const skipDurable = request.types !== undefined && durableTypes !== undefined && durableTypes.length === 0;
    const workingWanted = request.types === undefined || request.types.includes('working' as MemoryType);

    const filter: searchRepo.CandidateFilter = {
      statuses: [...policy.statuses],
      window:
        policy.resolution.kind === 'overlap'
          ? { kind: 'overlap', from: policy.resolution.from, until: policy.resolution.until }
          : { kind: 'point', at: policy.resolution.at },
      ...(durableTypes !== undefined && durableTypes.length > 0 ? { types: durableTypes } : {}),
      ...(requiredEntityIds.length > 0 ? { requiredEntityIds } : {}),
    };

    const [lexical, vector] = skipDurable
      ? [
          { candidates: [], ids: [], active: false, failed: false } as ChannelRun,
          { candidates: [], ids: [], active: false, failed: false } as ChannelRun,
        ]
      : await Promise.all([
          runLexical(
            understanding.keywords.length > 0 ? understanding.keywords : [request.query],
            filter,
            warnings,
          ),
          runVector(request.query, filter, warnings),
        ]);

    const graph = skipDurable
      ? { candidates: [], ids: [], active: false, failed: false } as ChannelRun
      : await runGraph({
          queryText: request.query,
          filter,
          policy,
          nowIso,
          intent: understanding.intent,
          matchedEntityIds: matchedEntities.map((entity) => entity.id),
          requiredEntityIds,
          lexicalIds: lexical.ids,
          vectorIds: vector.ids,
          warnings,
        });

    const working = await runWorking({
      sessionId: request.session_id,
      nowIso,
      workingWanted,
      requiredEntityIds,
      warnings,
    });

    // Merge channels by id (best rank per channel, max graph boost).
    const merged = [...mergeCandidates([lexical.candidates, vector.candidates, graph.candidates, working]).values()];

    // Stage 3 — HARD temporal/status filter (the in-process predicate is authoritative).
    const surviving: RetrievalCandidate[] = [];
    let disputedDropped = 0;
    for (const candidate of merged) {
      if (passesTemporalFilter(candidate, policy)) surviving.push(candidate);
      else if (candidate.status === 'disputed' && !policy.labelDisputed) disputedDropped += 1;
    }
    if (disputedDropped > 0) {
      warnings.push(`${disputedDropped} disputed memories excluded by default`);
    }

    // Stage 4 — dedupe (exact content_hash; near-duplicate authority collapse via the Embedder).
    const deduped = await dedupeCandidates(surviving, {
      similarity: makeDedupeSimilarity(),
      cosineThreshold: config.nearDuplicate.cosineThreshold,
    });

    // Stage 5 — RRF fusion + additive weighted scoring (+ explain decomposition).
    const temporalNote =
      policy.resolution.kind === 'current'
        ? 'currently valid (temporal filter passed)'
        : policy.resolution.kind === 'point'
          ? `valid at as_of ${policy.resolution.at}`
          : `valid within the historical window ${policy.resolution.from ?? '(open)'} → ${policy.resolution.until ?? '(open)'}`;
    let scored = scoreCandidates(deduped.kept, {
      intent: understanding.intent,
      ...(request.project_id !== undefined ? { requestProjectId: request.project_id } : {}),
      now: nowDate,
      queryEntityIds: matchedEntities.map((entity) => entity.id),
      activeChannels: { vector: vector.active, lexical: lexical.active },
      temporalNote,
    }, config);

    // Stage 6 — optional rerank tier.
    if (config.rerank.enabled) {
      if (reranker === undefined) {
        warnings.push('rerank requested but no reranker configured: RRF + weights final');
      } else {
        const reranked = await applyRerank(scored, request.query, reranker, config.rerank.limit);
        scored = reranked.ranked;
        if (reranked.error !== undefined) {
          warnings.push(`rerank failed: ${reranked.error} — fused order kept`);
        }
      }
    }

    // Stage 7 — token budget packing.
    const scoredById = new Map(scored.map((entry) => [entry.candidate.id, entry]));
    const packable: PackableItem[] = scored.map((entry) => ({
      id: entry.candidate.id,
      title: deriveLabel(entry.candidate.title, entry.candidate.content),
      summaryText:
        entry.candidate.contentSummary ?? deriveSummary(entry.candidate.content, config.summaryMaxChars),
      contentText: entry.candidate.content,
      score: entry.score,
    }));
    const packed = packResults(packable, {
      budget,
      maxMemories: request.max_memories ?? 10,
      overflowLimit: config.packing.overflowLimit,
    });
    if (packed.omitted > 0) warnings.push(`${packed.omitted} further matches omitted (overflow limit)`);
    if (packed.droppedForBudget > 0) {
      warnings.push(`${packed.droppedForBudget} matches did not fit the token budget`);
    }

    // Stage 11 (REINFORCE, fire-and-forget) — bump access_count for returned durable hits.
    const returnedDurableIds = packed.items
      .map((item) => scoredById.get(item.id))
      .filter((entry): entry is ScoredCandidate => entry !== undefined)
      .filter((entry) => entry.candidate.kind === 'durable')
      .map((entry) => entry.candidate.id);
    if (returnedDurableIds.length > 0) {
      void storage.store.reinforce(returnedDurableIds, nowIso).catch(() => {
        // Stage 11 policy: loss acceptable (memory-model.md §8) — never fail the search.
      });
    }

    // Stage 8 — explain assembly + response build.
    const memoryItems: MemorySearchResponse['memories'] = [];
    for (const item of packed.items) {
      const entry = scoredById.get(item.id);
      if (entry === undefined) continue;
      const candidate = entry.candidate;
      const memory: MemorySearchResponse['memories'][number] = {
        id: candidate.id,
        type: candidate.type,
        summary: item.summary,
        relevance: entry.relevance,
        explain:
          request.explain === true
            ? (entry.explain as MemorySearchResponse['memories'][number]['explain'])
            : [],
        temporal: {
          valid_from: candidate.validFrom,
          status: candidate.status,
          ...(candidate.validUntil !== undefined ? { valid_until: candidate.validUntil } : {}),
        },
        provenance: {
          source_kind: candidate.sourceKind,
          ...(candidate.sourceUri !== undefined ? { source_uri: candidate.sourceUri } : {}),
          ...(candidate.verifiedAt !== undefined ? { verified_at: candidate.verifiedAt } : {}),
        },
      };
      if (candidate.title !== undefined) memory.title = candidate.title;
      if (item.content !== undefined) memory.content = item.content;
      if (candidate.status === 'disputed') {
        memory.conflicts = await conflictsFor(storage.client, candidate.id);
      }
      memoryItems.push(memory);
    }

    // Context intent pulls the project digest (retrieval.md §2; additive response field — the
    // wire schema is a loose object and doc §8 requires unknown-field tolerance at boundaries).
    let projectDigest: Record<string, unknown> | undefined;
    if (understanding.intent === 'context' && request.project_id !== undefined) {
      try {
        const project = await storage.store.getProject(request.project_id);
        if (project !== null) {
          projectDigest = {
            name: project.name,
            description: project.description,
            digest: project.digest,
          };
          if (Object.keys(project.digest).length === 0) {
            warnings.push('project digest not yet built (consolidation pending)');
          }
        }
      } catch (error) {
        warnings.push(`project digest lookup failed: ${errorMessage(error)}`);
      }
    }

    const response: MemorySearchResponse = MemorySearchResponseSchema.parse({
      query_understanding: understandingBlock,
      memories: memoryItems,
      tokens: { budget: packed.budget, used: packed.used, packing: packed.packing },
      warnings,
      ...(projectDigest !== undefined ? { project_digest: projectDigest } : {}),
    }) as MemorySearchResponse;

    // Cache and return (bounded, TTL'd; project writes invalidate explicitly).
    if (results.size >= config.caches.resultMaxEntries) {
      const oldest = results.keys().next().value;
      if (oldest !== undefined) results.delete(oldest);
    }
    results.set(cacheKey, {
      response,
      projectId: request.project_id ?? null,
      expires: Date.now() + config.caches.resultTtlMs,
    });
    return structuredClone(response);
  }

  return {
    search,
    config,
    invalidateCache(projectId?: string): void {
      if (projectId === undefined) {
        results.clear();
        return;
      }
      for (const [key, entry] of results) {
        // Unscoped queries see every project — any project write invalidates them too.
        if (entry.projectId === projectId || entry.projectId === null) results.delete(key);
      }
    },
    invalidateEntityIndex(): void {
      entityIndexes.clear();
    },
    cacheStats(): CacheStats {
      return { embeddings: embeddings.size, results: results.size, entityScopes: entityIndexes.size };
    },
  };
}
