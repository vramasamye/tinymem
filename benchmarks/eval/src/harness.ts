/**
 * The harness: run golden datasets through the real runtime and aggregate the M11.2 metrics.
 *
 * `runBenchmark` is the single entry point behind both `bench:run` (writes
 * `benchmarks/results/`) and the `bun test` gate. It is deterministic: the engine clock, the
 * fixtures, the heuristic extractor and the embedding-free retrieval path all yield identical
 * numbers across runs (only `generated_at` differs, and it is injectable).
 */

import type { MemorySearchRequest } from '@onememory-ai/core';
import type { ExtractHandlerResult } from '@onememory-ai/extraction';
import { deriveLabel, estimateTokens } from '@onememory-ai/retrieval';

import { GLOBAL_PROJECT_KEY, loadDatasets, type GoldenDataset } from './dataset';
import { evaluateGates, type AggregateMetrics, type GateEvaluation } from './gates';
import {
  computeConsolidationMetrics,
  computeContradictionMetrics,
  computePollutionMetrics,
  computeRetrievalMetrics,
  computeTemporalMetrics,
  computeTokenMetrics,
  temporalBucketFor,
  type QueryOutcome,
} from './metrics';
import {
  computePrecisionRecallByType,
  QUALITY_QUERY_TYPES,
  type PrecisionRecallByType,
  type QualityQueryType,
  type TypedRetrievalOutcome,
} from './metrics/precision-recall';
import {
  computeTokenEfficiency,
  type TokenEfficiencyQueryView,
  type TokenEfficiencyRecord,
} from './metrics/token-efficiency';
import {
  computePollutionAudit,
  type DeclaredContradictionView,
  type PollutionAuditRecord,
} from './metrics/pollution';
import {
  openBenchRuntime,
  type BenchRuntime,
  type ConsolidationPassSummary,
  type CorpusMemory,
  type FinalMemoryView,
} from './runtime';

/** The M11b-quality records for one dataset run (per-dataset view of the three new metrics). */
export interface DatasetQualityMetrics {
  precision_recall: PrecisionRecallByType;
  token_efficiency: TokenEfficiencyRecord;
  pollution: PollutionAuditRecord;
}

export interface DatasetRunReport {
  id: string;
  title: string;
  description: string;
  extraction: ExtractHandlerResult;
  memories: number;
  superseded: number;
  /** The automatic consolidation pass summary (null when the dataset did not opt in). */
  consolidation: ConsolidationPassSummary | null;
  facts: Array<{ key: string; scenario: string; description: string; memory_id: string; content: string }>;
  queries: QueryOutcome[];
  metrics: AggregateMetrics;
  /** M11b-quality: this dataset's typed retrieval, token-efficiency and pollution records. */
  quality: DatasetQualityMetrics;
  warnings: string[];
}

export interface BenchmarkReport {
  schema_version: '1';
  generated_at: string;
  engine: {
    profile: 'embedded';
    embedder: 'none (lexical + graph default)';
    extraction: 'heuristic (no-LLM baseline)';
    default_max_tokens: number;
    clocks: string[];
  };
  datasets: DatasetRunReport[];
  metrics: AggregateMetrics;
  gates: GateEvaluation;
  /** Attempted outbound calls; 0 proves the local-first invariant for the run (null = not enforced). */
  network_attempts: number | null;
}

export interface RunBenchmarkOptions {
  datasetsDir: string;
  enforceNetworkGuard?: boolean;
  generatedAt?: string;
}

const RETRIEVAL_K = 5;

function factId(dataset: GoldenDataset, runtime: { facts: ReadonlyMap<string, { memory: CorpusMemory }> }, key: string): string {
  const fact = runtime.facts.get(key);
  if (fact === undefined) {
    throw new Error(`dataset '${dataset.id}': fact '${key}' was never resolved`);
  }
  return fact.memory.id;
}

function searchRequest(
  dataset: GoldenDataset,
  runtime: { project_ids: ReadonlyMap<string, string | null> },
  input: {
    query: string;
    project?: string | undefined;
    max_tokens: number;
    as_of?: string | undefined;
    temporal_mode?: 'current' | 'historical' | undefined;
  },
): MemorySearchRequest {
  let projectId: string | undefined;
  if (input.project !== undefined && input.project !== GLOBAL_PROJECT_KEY) {
    const resolved = runtime.project_ids.get(input.project);
    if (resolved === undefined) {
      throw new Error(`dataset '${dataset.id}': query references unknown project '${input.project}'`);
    }
    projectId = resolved ?? undefined;
  }
  return {
    query: input.query,
    max_tokens: input.max_tokens,
    ...(projectId === undefined ? {} : { project_id: projectId }),
    ...(input.as_of === undefined ? {} : { as_of: input.as_of }),
    ...(input.temporal_mode === undefined ? {} : { temporal_mode: input.temporal_mode }),
  };
}

/** Everything one probe needs: the request plus the fact keys it must and must not return. */
interface ProbeSpec {
  /** Outcome id, unique within a dataset run. */
  id: string;
  kind: QueryOutcome['kind'];
  /** Dataset project key (undefined = unscoped). */
  project?: string | undefined;
  query: string;
  max_tokens: number;
  as_of?: string | undefined;
  temporal_mode?: 'current' | 'historical' | undefined;
  /** Fact keys that must appear in the results. */
  expected: readonly string[];
  /** Fact keys that must not appear in the results. */
  forbidden: readonly string[];
}

/**
 * Run one probe against the real engine: resolve the expected/forbidden fact keys to memory ids,
 * search, and record the raw outcome the metrics consume. Both declared queries and contradiction
 * probes go through here — they differ only in what they declare, not in how they are measured.
 */
async function runProbe(
  dataset: GoldenDataset,
  runtime: BenchRuntime,
  spec: ProbeSpec,
): Promise<QueryOutcome> {
  const expectedIds = spec.expected.map((key) => factId(dataset, runtime, key));
  const forbiddenIds = spec.forbidden.map((key) => factId(dataset, runtime, key));
  const response = await runtime.engine.search(
    searchRequest(dataset, runtime, {
      query: spec.query,
      project: spec.project,
      max_tokens: spec.max_tokens,
      as_of: spec.as_of,
      temporal_mode: spec.temporal_mode,
    }),
  );
  const projectId =
    spec.project === undefined || spec.project === GLOBAL_PROJECT_KEY
      ? null
      : (runtime.project_ids.get(spec.project) ?? null);
  return {
    id: spec.id,
    kind: spec.kind,
    projectKey: spec.project ?? null,
    projectId,
    returnedIds: response.memories.map((memory) => memory.id),
    expectedIds,
    forbiddenIds,
    usedTokens: response.tokens.used,
    budget: response.tokens.budget,
    packing: response.tokens.packing,
    warnings: response.warnings,
    ...(spec.kind === 'temporal' ? { temporal_bucket: temporalBucketFor(spec) } : {}),
  };
}

/** One dataset run: open the runtime, drive every query, compute this dataset's metrics. */
export async function runDataset(
  dataset: GoldenDataset,
  options: { enforceNetworkGuard?: boolean } = {},
): Promise<{
  report: DatasetRunReport;
  outcomes: QueryOutcome[];
  corpusById: Map<string, CorpusMemory>;
  consolidation: Array<{ id: string; observations: number; distinct: number }>;
  /** M11b-quality: raw per-query views (pooled by `runBenchmark`). */
  qualityViews: QualityViews;
  networkAttempts: number | null;
}> {
  const runtime = await openBenchRuntime(dataset, {
    ...(options.enforceNetworkGuard === undefined
      ? {}
      : { enforceNetworkGuard: options.enforceNetworkGuard }),
  });
  const outcomes: QueryOutcome[] = [];
  try {
    for (const query of dataset.queries) {
      outcomes.push(
        await runProbe(dataset, runtime, {
          id: query.id,
          kind: query.kind,
          project: query.project,
          query: query.query,
          max_tokens: query.max_tokens,
          as_of: query.as_of,
          temporal_mode: query.temporal_mode,
          expected: query.expected,
          forbidden: query.forbidden,
        }),
      );
    }

    for (const group of dataset.contradictions) {
      // A resolved group expects the authority fact to be returned with no contradicted side; a
      // disputed group (full authority tie) expects BOTH sides excluded from current answers.
      const expected = group.outcome === 'resolved' && group.authority !== undefined ? [group.authority] : [];
      outcomes.push(
        await runProbe(dataset, runtime, {
          id: `contradiction-${group.id}`,
          kind: 'contradiction',
          project: group.project,
          query: group.query,
          max_tokens: 800,
          expected,
          forbidden: group.contradicted,
        }),
      );
    }

    const consolidation = dataset.consolidation.map((group) => {
      const distinct = new Set(group.facts.map((key) => factId(dataset, runtime, key))).size;
      return { id: `${dataset.id}:${group.id}`, observations: group.observations, distinct };
    });

    const corpusById = new Map(runtime.corpus.map((memory) => [memory.id, memory]));
    const qualityViews = await collectQualityViews(dataset, runtime, outcomes);
    const quality = qualityMetricsOf(qualityViews);
    const metrics: AggregateMetrics = {
      ...aggregateMetrics(outcomes, corpusById, consolidation),
      precision_recall_by_type: quality.precision_recall,
      token_efficiency: quality.token_efficiency,
      pollution_audit: quality.pollution,
    };

    const report: DatasetRunReport = {
      id: dataset.id,
      title: dataset.title,
      description: dataset.description,
      extraction: runtime.extraction,
      memories: runtime.corpus.length,
      superseded: runtime.superseded.size,
      consolidation: runtime.consolidation,
      facts: dataset.facts.map((fact) => {
        const resolved = runtime.facts.get(fact.key)!;
        return {
          key: fact.key,
          scenario: fact.scenario,
          description: fact.description,
          memory_id: resolved.memory.id,
          content: resolved.memory.content,
        };
      }),
      queries: outcomes,
      metrics,
      quality,
      warnings: [...runtime.warnings],
    };

    return {
      report,
      outcomes,
      corpusById,
      consolidation,
      qualityViews,
      networkAttempts: runtime.network_attempts,
    };
  } finally {
    await runtime.close();
  }
}

function aggregateMetrics(
  outcomes: readonly QueryOutcome[],
  corpusById: ReadonlyMap<string, CorpusMemory>,
  consolidation: ReadonlyArray<{ id: string; observations: number; distinct: number }>,
): Omit<AggregateMetrics, 'precision_recall_by_type' | 'token_efficiency' | 'pollution_audit'> {
  return {
    retrieval: computeRetrievalMetrics(outcomes, RETRIEVAL_K),
    tokens: computeTokenMetrics(outcomes),
    pollution: computePollutionMetrics(outcomes, corpusById),
    temporal: computeTemporalMetrics(outcomes),
    contradiction: computeContradictionMetrics(outcomes),
    consolidation: computeConsolidationMetrics(consolidation),
  };
}

// ---------------------------------------------------------------------------
// M11b-quality: the three Phase 5 metrics (per-type precision/recall, token efficiency,
// pollution audit). The views are raw per-query records so the benchmark level can pool across
// datasets without re-deriving anything from averaged numbers.
// ---------------------------------------------------------------------------

/** Raw, per-dataset inputs the benchmark level pools across dataset runs. */
interface QualityViews {
  typedOutcomes: TypedRetrievalOutcome[];
  tokenViews: TokenEfficiencyQueryView[];
  pollutionAudit: PollutionAuditRecord;
}

/**
 * Collect one dataset's quality views after every probe fired: typed outcomes by query id,
 * token-efficiency views with the oracle recomputed from the golden facts (the committed
 * `oracle_min_tokens` annotation must match or the fixture has drifted), and the pollution audit
 * over the settled post-run corpus.
 */
async function collectQualityViews(
  dataset: GoldenDataset,
  runtime: BenchRuntime,
  outcomes: readonly QueryOutcome[],
): Promise<QualityViews> {
  const outcomesById = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  const typedOutcomes: TypedRetrievalOutcome[] = [];
  const tokenViews: TokenEfficiencyQueryView[] = [];

  for (const query of dataset.queries) {
    if (query.query_type === undefined) continue;
    const outcome = outcomesById.get(query.id);
    if (outcome === undefined) {
      throw new Error(`dataset '${dataset.id}': typed query '${query.id}' produced no outcome`);
    }
    typedOutcomes.push({
      id: query.id,
      query_type: query.query_type,
      returnedIds: outcome.returnedIds,
      expectedIds: outcome.expectedIds,
    });

    // The oracle: the packer's titles-only representation of exactly the golden answer set,
    // recomputed with the engine's own estimator + label derivation (never trusted from the
    // annotation — the annotation is the committed record, this is the check).
    const oracle = query.expected.reduce((sum, key) => {
      const fact = runtime.facts.get(key);
      if (fact === undefined) {
        throw new Error(`dataset '${dataset.id}': oracle fact '${key}' was never resolved`);
      }
      return sum + estimateTokens(deriveLabel(fact.memory.title ?? undefined, fact.memory.content));
    }, 0);
    if (oracle <= 0) {
      throw new Error(`dataset '${dataset.id}': query '${query.id}' has a non-positive token oracle`);
    }
    if (query.oracle_min_tokens !== undefined && query.oracle_min_tokens !== oracle) {
      throw new Error(
        `dataset '${dataset.id}': query '${query.id}' oracle annotation ${query.oracle_min_tokens} ` +
          `drifted from the computed ${oracle} — refresh the annotation`,
      );
    }
    tokenViews.push({
      id: query.id,
      query_type: query.query_type,
      usedTokens: outcome.usedTokens,
      budget: outcome.budget,
      oracleMinTokens: oracle,
      allExpectedReturned: outcome.expectedIds.every((id) => outcome.returnedIds.includes(id)),
    });
  }

  const finalMemories: readonly FinalMemoryView[] = await runtime.finalMemories();
  const surfacedIds = new Set(outcomes.flatMap((outcome) => [...outcome.returnedIds]));
  const contradictionGroups: DeclaredContradictionView[] = dataset.contradictions.map((group) => ({
    authority_id: group.authority === undefined ? null : factId(dataset, runtime, group.authority),
    contradicted_ids: group.contradicted.map((key) => factId(dataset, runtime, key)),
    outcome: group.outcome,
  }));
  const pollutionAudit = computePollutionAudit({
    now: dataset.now,
    memories: finalMemories,
    surfacedIds,
    contradictionGroups,
  });

  return { typedOutcomes, tokenViews, pollutionAudit };
}

/** One dataset's M11b-quality records from its raw views (single run). */
function qualityMetricsOf(views: QualityViews): DatasetQualityMetrics {
  return {
    precision_recall: computePrecisionRecallByType([views.typedOutcomes]),
    token_efficiency: computeTokenEfficiency(views.tokenViews, QUALITY_QUERY_TYPES),
    pollution: views.pollutionAudit,
  };
}

/** Sum the per-dataset pollution audits into the benchmark-level record (counts add, findings concatenate). */
function mergePollutionAudits(audits: readonly PollutionAuditRecord[]): PollutionAuditRecord {
  return {
    stale_cited: {
      window_days: audits[0]?.stale_cited.window_days ?? 30,
      count: audits.reduce((sum, audit) => sum + audit.stale_cited.count, 0),
      memories: audits.flatMap((audit) => audit.stale_cited.memories),
    },
    duplicates: {
      cosine_threshold: audits[0]?.duplicates.cosine_threshold ?? 0.97,
      count: audits.reduce((sum, audit) => sum + audit.duplicates.count, 0),
      pairs: audits.flatMap((audit) => audit.duplicates.pairs),
    },
    unresolved_contradictions: {
      count: audits.reduce((sum, audit) => sum + audit.unresolved_contradictions.count, 0),
      memories: audits.flatMap((audit) => audit.unresolved_contradictions.memories),
    },
  };
}

/** Run every dataset in a directory and produce the full report (with gates evaluated). */
export async function runBenchmark(options: RunBenchmarkOptions): Promise<BenchmarkReport> {
  const datasets = await loadDatasets(options.datasetsDir);
  if (datasets.length === 0) {
    throw new Error(`no golden datasets found in ${options.datasetsDir}`);
  }

  const reports: DatasetRunReport[] = [];
  const allOutcomes: QueryOutcome[] = [];
  const corpusById = new Map<string, CorpusMemory>();
  const consolidation: Array<{ id: string; observations: number; distinct: number }> = [];
  const typedOutcomes: TypedRetrievalOutcome[] = [];
  const tokenViews: TokenEfficiencyQueryView[] = [];
  const pollutionAudits: PollutionAuditRecord[] = [];
  let networkAttempts: number | null = null;
  const clocks: string[] = [];

  for (const dataset of datasets) {
    const run = await runDataset(dataset, {
      ...(options.enforceNetworkGuard === undefined
        ? {}
        : { enforceNetworkGuard: options.enforceNetworkGuard }),
    });
    reports.push(run.report);
    allOutcomes.push(...run.outcomes);
    for (const [id, memory] of run.corpusById) corpusById.set(id, memory);
    consolidation.push(...run.consolidation);
    typedOutcomes.push(...run.qualityViews.typedOutcomes);
    tokenViews.push(...run.qualityViews.tokenViews);
    pollutionAudits.push(run.qualityViews.pollutionAudit);
    clocks.push(dataset.now);
    if (run.networkAttempts !== null) {
      networkAttempts = (networkAttempts ?? 0) + run.networkAttempts;
    }
  }

  // The M11b-quality records pool the RAW per-query views across every dataset, so the
  // benchmark-level estimates are computed from individual observations, not averages of averages.
  const metrics: AggregateMetrics = {
    ...aggregateMetrics(allOutcomes, corpusById, consolidation),
    precision_recall_by_type: computePrecisionRecallByType([typedOutcomes]),
    token_efficiency: computeTokenEfficiency(tokenViews, QUALITY_QUERY_TYPES),
    pollution_audit: mergePollutionAudits(pollutionAudits),
  };

  return {
    schema_version: '1',
    generated_at: options.generatedAt ?? new Date().toISOString(),
    engine: {
      profile: 'embedded',
      embedder: 'none (lexical + graph default)',
      extraction: 'heuristic (no-LLM baseline)',
      default_max_tokens: 800,
      clocks,
    },
    datasets: reports,
    metrics,
    gates: evaluateGates(metrics),
    network_attempts: networkAttempts,
  };
}
