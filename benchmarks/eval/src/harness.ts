/**
 * The harness: run golden datasets through the real runtime and aggregate the M11.2 metrics.
 *
 * `runBenchmark` is the single entry point behind both `bench:run` (writes
 * `benchmarks/results/`) and the `bun test` gate. It is deterministic: the engine clock, the
 * fixtures, the heuristic extractor and the embedding-free retrieval path all yield identical
 * numbers across runs (only `generated_at` differs, and it is injectable).
 */

import type { MemorySearchRequest } from '@onememory/core';
import type { ExtractHandlerResult } from '@onememory/extraction';

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
import { openBenchRuntime, type BenchRuntime, type CorpusMemory } from './runtime';

export interface DatasetRunReport {
  id: string;
  title: string;
  description: string;
  extraction: ExtractHandlerResult;
  memories: number;
  superseded: number;
  facts: Array<{ key: string; scenario: string; description: string; memory_id: string; content: string }>;
  queries: QueryOutcome[];
  metrics: AggregateMetrics;
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
): Promise<{ report: DatasetRunReport; outcomes: QueryOutcome[]; corpusById: Map<string, CorpusMemory>; consolidation: Array<{ id: string; observations: number; distinct: number }>; networkAttempts: number | null }> {
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
      outcomes.push(
        await runProbe(dataset, runtime, {
          id: `contradiction-${group.id}`,
          kind: 'contradiction',
          project: group.project,
          query: group.query,
          max_tokens: 800,
          expected: [group.authority],
          forbidden: group.contradicted,
        }),
      );
    }

    const consolidation = dataset.consolidation.map((group) => {
      const distinct = new Set(group.facts.map((key) => factId(dataset, runtime, key))).size;
      return { id: `${dataset.id}:${group.id}`, observations: group.observations, distinct };
    });

    const corpusById = new Map(runtime.corpus.map((memory) => [memory.id, memory]));
    const metrics = aggregateMetrics(outcomes, corpusById, consolidation);

    const report: DatasetRunReport = {
      id: dataset.id,
      title: dataset.title,
      description: dataset.description,
      extraction: runtime.extraction,
      memories: runtime.corpus.length,
      superseded: runtime.superseded.size,
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
      warnings: [...runtime.warnings],
    };

    return { report, outcomes, corpusById, consolidation, networkAttempts: runtime.network_attempts };
  } finally {
    await runtime.close();
  }
}

function aggregateMetrics(
  outcomes: readonly QueryOutcome[],
  corpusById: ReadonlyMap<string, CorpusMemory>,
  consolidation: ReadonlyArray<{ id: string; observations: number; distinct: number }>,
): AggregateMetrics {
  return {
    retrieval: computeRetrievalMetrics(outcomes, RETRIEVAL_K),
    tokens: computeTokenMetrics(outcomes),
    pollution: computePollutionMetrics(outcomes, corpusById),
    temporal: computeTemporalMetrics(outcomes),
    contradiction: computeContradictionMetrics(outcomes),
    consolidation: computeConsolidationMetrics(consolidation),
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
    clocks.push(dataset.now);
    if (run.networkAttempts !== null) {
      networkAttempts = (networkAttempts ?? 0) + run.networkAttempts;
    }
  }

  const metrics = aggregateMetrics(allOutcomes, corpusById, consolidation);

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
