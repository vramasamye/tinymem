/**
 * M11b-quality: per-query-type retrieval precision/recall with confidence intervals
 * (phased-plan Phase 5 row M11b; ADR-0004, `docs/architecture/retrieval.md` §1).
 *
 * Pure math over the harness output — no storage, no engine (the M11a `metrics.ts` pattern).
 * The per-query formulas are the SAME ones `computeRetrievalMetrics` uses, so the two views
 * (all-queries aggregate vs. per-type) can never disagree about what a hit is:
 *
 *   precision@k = |expected ∩ top-k| / |top-k|
 *   recall@k    = |expected ∩ top-k| / |expected|
 *
 * The estimate pools one observation per (run, query). Over a fixed N runs the point estimate is
 * the mean of N×Q per-query values and the 95% interval is the normal approximation
 * mean ± z·σ/√(N×Q), clamped to [0, 1]. Offline the engine is deterministic — N runs produce
 * byte-identical per-query values (pinned by the quality-gate test) — so the interval width is
 * driven by the query sample Q, and the same math captures real run variance the moment a
 * non-deterministic tier (embedder, LLM) is wired behind the router.
 */

/** The three M11b query types (phased-plan M11b: "procedural, decision, failure query sets"). */
export type QualityQueryType = 'procedural' | 'decision' | 'failure';

export const QUALITY_QUERY_TYPES: readonly QualityQueryType[] = ['procedural', 'decision', 'failure'];

/** One typed query's raw outcome — the harness projection of a `query_type`-annotated query. */
export interface TypedRetrievalOutcome {
  /** The dataset query id (diagnostics only). */
  id: string;
  query_type: QualityQueryType;
  returnedIds: readonly string[];
  expectedIds: readonly string[];
}

export interface MeanWithCi {
  mean: number;
  ci95_low: number;
  ci95_high: number;
  /** Observations behind the estimate (runs × queries). */
  samples: number;
}

export interface TypePrecisionRecall {
  query_type: QualityQueryType;
  /** Typed queries per run. */
  queries_per_run: number;
  precision_at_k: MeanWithCi;
  recall_at_k: MeanWithCi;
}

export interface PrecisionRecallByType {
  /** The fixed number of runs the estimates pool over. */
  runs: number;
  k: number;
  by_type: TypePrecisionRecall[];
}

export interface PrecisionRecallOptions {
  /** Rank cutoff for precision (default 5, the harness's `RETRIEVAL_K`). */
  k?: number;
  /** Normal-approximation z value (default 1.96 ≈ 95%). */
  z?: number;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1));
}

function round(value: number, digits = 4): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function meanWithCi(values: readonly number[], z: number): MeanWithCi {
  if (values.length === 0) {
    return { mean: 0, ci95_low: 0, ci95_high: 0, samples: 0 };
  }
  const m = mean(values);
  // Deterministic offline runs make σ = 0 across runs; the query-sample spread still flows in.
  const halfWidth = (z * stdDev(values)) / Math.sqrt(values.length);
  return {
    mean: round(m),
    ci95_low: round(Math.max(0, m - halfWidth)),
    ci95_high: round(Math.min(1, m + halfWidth)),
    samples: values.length,
  };
}

function perQueryValues(
  outcomes: readonly TypedRetrievalOutcome[],
  k: number,
  kind: 'precision' | 'recall',
): number[] {
  const values: number[] = [];
  for (const outcome of outcomes) {
    const expected = new Set(outcome.expectedIds);
    const topK = outcome.returnedIds.slice(0, k);
    const hits = topK.filter((id) => expected.has(id)).length;
    if (kind === 'precision') {
      values.push(topK.length === 0 ? 0 : hits / topK.length);
    } else {
      values.push(expected.size === 0 ? 1 : hits / expected.size);
    }
  }
  return values;
}

/**
 * Per-type precision/recall over a fixed N runs. `runs[r]` is the typed outcome set of run r —
 * identical query sets across runs, or the pooled sample is meaningless.
 */
export function computePrecisionRecallByType(
  runs: ReadonlyArray<readonly TypedRetrievalOutcome[]>,
  options: PrecisionRecallOptions = {},
): PrecisionRecallByType {
  const k = options.k ?? 5;
  const z = options.z ?? 1.96;
  const pooled = runs.flat();
  const byType: TypePrecisionRecall[] = QUALITY_QUERY_TYPES.map((queryType) => {
    const typed = pooled.filter((outcome) => outcome.query_type === queryType);
    const perRun = runs.map((run) => run.filter((outcome) => outcome.query_type === queryType).length);
    const queriesPerRun = perRun[0] ?? 0;
    if (perRun.some((count) => count !== queriesPerRun)) {
      throw new Error(
        `precision-recall: every run must probe the same '${queryType}' queries (got ${perRun.join(', ')})`,
      );
    }
    return {
      query_type: queryType,
      queries_per_run: queriesPerRun,
      precision_at_k: meanWithCi(perQueryValues(typed, k, 'precision'), z),
      recall_at_k: meanWithCi(perQueryValues(typed, k, 'recall'), z),
    };
  });
  return { runs: runs.length, k, by_type: byType };
}
