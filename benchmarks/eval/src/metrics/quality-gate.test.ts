/**
 * The M11b-quality CI gate over the real engine: per-type precision/recall with confidence
 * intervals over a fixed N runs (N = 3), token efficiency with the oracle gap, and the
 * pollution audit over the settled post-run corpus.
 *
 * The offline engine is deterministic — every run over the same dataset is byte-identical — so
 * the three runs first PIN that determinism (identical per-type records) and then pool: the
 * pooled point estimates are what the fixed-N interval is computed over, exactly as a
 * non-deterministic deployment (embedder, LLM router) would be measured.
 *
 * The pollution fixtures are positive controls: `pollution-quality` deliberately contains an
 * archived-but-cited memory and a case-variant near-duplicate pair (with a dissimilar negative
 * control), and the aggregate audit must find exactly the cross-phrasing contradiction the
 * template detector misses. Counts below the ceilings are improvements, not failures.
 */

import { describe, expect, test } from 'bun:test';

import { GOLDEN_DATASETS_DIR, loadDatasets } from '../dataset';
import { DEFAULT_GATE_THRESHOLDS, evaluateGates, type AggregateMetrics } from '../gates';
import { runDataset } from '../harness';
import {
  computePrecisionRecallByType,
  QUALITY_QUERY_TYPES,
  type QualityQueryType,
  type TypedRetrievalOutcome,
} from './precision-recall';
import { computeTokenEfficiency, type TokenEfficiencyQueryView } from './token-efficiency';

const TIMEOUT_MS = 240_000;

/** The fixed number of runs the per-type estimates pool over (M11b-quality AC 1). */
const FIXED_RUNS = 3;

const TYPE_DATASET_IDS = ['procedural-queries', 'decision-queries', 'failure-queries'] as const;

async function datasetOf(id: string) {
  const datasets = await loadDatasets(GOLDEN_DATASETS_DIR);
  const dataset = datasets.find((entry) => entry.id === id);
  if (dataset === undefined) throw new Error(`dataset '${id}' is missing`);
  return dataset;
}

describe('M11b-quality gate', () => {
  test(
    'per-type precision/recall over 3 fixed runs: deterministic, pooled, and above every threshold',
    async () => {
      const perRunTyped: TypedRetrievalOutcome[][] = [];
      const perRunRecords: string[] = [];
      for (let run = 0; run < FIXED_RUNS; run += 1) {
        const typed: TypedRetrievalOutcome[] = [];
        for (const id of TYPE_DATASET_IDS) {
          const result = await runDataset(await datasetOf(id));
          typed.push(...result.qualityViews.typedOutcomes);
        }
        perRunTyped.push(typed);
        perRunRecords.push(JSON.stringify(computePrecisionRecallByType([typed])));
      }

      // Determinism pin: the offline engine produces byte-identical per-type records per run.
      const firstRecord = perRunRecords[0]!;
      for (const record of perRunRecords.slice(1)) {
        expect(record).toBe(firstRecord);
      }

      // The pooled fixed-N estimate — the same math a varying deployment would feed.
      const pooled = computePrecisionRecallByType(perRunTyped);
      expect(pooled.runs).toBe(FIXED_RUNS);
      for (const record of pooled.by_type) {
        const type = record.query_type;
        expect(record.queries_per_run).toBeGreaterThan(0);
        expect(record.precision_at_k.samples).toBe(record.queries_per_run * FIXED_RUNS);
        expect(record.recall_at_k.samples).toBe(record.queries_per_run * FIXED_RUNS);
        expect(record.precision_at_k.ci95_low).toBeLessThanOrEqual(record.precision_at_k.mean);
        expect(record.precision_at_k.ci95_high).toBeGreaterThanOrEqual(record.precision_at_k.mean);
        expect(record.precision_at_k.mean).toBeGreaterThanOrEqual(
          DEFAULT_GATE_THRESHOLDS[`retrieval_precision_${type}`],
        );
        expect(record.recall_at_k.mean).toBeGreaterThanOrEqual(
          DEFAULT_GATE_THRESHOLDS[`retrieval_recall_${type}`],
        );
      }

      // The gate is not decorative: one per-type breach fails the whole evaluation.
      const breached = evaluateGates(
        { ...minimalAggregate(), precision_recall_by_type: pooled },
        { ...DEFAULT_GATE_THRESHOLDS, retrieval_precision_failure: 0.99 },
      );
      expect(breached.passed).toBe(false);
      expect(breached.checks.find((check) => check.metric === 'retrieval_precision_failure')?.passed).toBe(
        false,
      );
    },
    TIMEOUT_MS,
  );

  test(
    'token efficiency: every typed query stays within budget and the oracle gap is gated',
    async () => {
      const views: TokenEfficiencyQueryView[] = [];
      for (const id of TYPE_DATASET_IDS) {
        const result = await runDataset(await datasetOf(id));
        views.push(...result.qualityViews.tokenViews);
      }
      expect(views.length).toBe(13);
      // The fixtures' recall is measured at 1.0, so every typed query is recall-satisfied and
      // the gated gap covers the whole typed set.
      expect(views.every((view) => view.allExpectedReturned)).toBe(true);
      for (const view of views) {
        expect(view.usedTokens).toBeLessThanOrEqual(view.budget);
        expect(view.oracleMinTokens).toBeGreaterThan(0);
        // Returning the expected facts costs at least their titles-only representation.
        expect(view.usedTokens).toBeGreaterThanOrEqual(view.oracleMinTokens);
      }
      const record = computeTokenEfficiency(views, QUALITY_QUERY_TYPES);
      expect(record.budget_compliance).toBe(1);
      for (const byType of record.by_type) {
        expect(byType.budget_compliance).toBe(1);
      }
      expect(record.oracle_gap_mean_when_satisfied).toBeGreaterThanOrEqual(1);
      expect(record.oracle_gap_mean_when_satisfied).toBeLessThanOrEqual(
        DEFAULT_GATE_THRESHOLDS.token_oracle_gap_mean,
      );

      // The gate is not decorative here either: a widened gap fails the evaluation.
      const breached = evaluateGates(
        {
          ...minimalAggregate(),
          token_efficiency: { ...record, oracle_gap_mean_when_satisfied: 99 },
        },
        DEFAULT_GATE_THRESHOLDS,
      );
      expect(breached.passed).toBe(false);
      expect(breached.checks.find((check) => check.metric === 'token_oracle_gap_mean')?.passed).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    'pollution audit: the stale, duplicate and unresolved-contradiction fixtures are detected exactly',
    async () => {
      // The dedicated fixture: archived-but-cited (stale), the case-variant duplicate pair, and
      // the dissimilar negative control that must NOT flag.
      const pollutionRun = await runDataset(await datasetOf('pollution-quality'));
      const audit = pollutionRun.report.quality.pollution;
      expect(audit.stale_cited.count).toBe(1);
      expect(audit.stale_cited.memories[0]!.label).toContain('Node 18');
      // The point-in-time probe is what cited the archived memory: REINFORCE stamped
      // last_accessed_at at the engine clock, inside the 30-day window (the dataset's now is
      // 2026-10-03; the citation is the same instant — cited today, by the fixture's clock).
      expect(audit.stale_cited.memories[0]!.last_accessed_at).toBe('2026-10-03T10:00:00.000Z');
      expect(audit.stale_cited.memories[0]!.access_count).toBeGreaterThan(0);
      expect(audit.duplicates.count).toBe(1);
      expect(audit.duplicates.pairs[0]).toMatchObject({ type: 'procedural', cosine: 1 });
      // The pair is the two capitalization variants of the same statement (the fixture wording
      // differs only in case and the trailing period).
      expect(audit.duplicates.pairs[0]!.a.toLowerCase().replace(/\.$/, '')).toBe(
        audit.duplicates.pairs[0]!.b.toLowerCase().replace(/\.$/, ''),
      );
      expect(audit.unresolved_contradictions.count).toBe(0);

      // The known detector gap: the cross-phrasing pair in the contradictions dataset stays
      // unresolved (the contradicted side was never superseded or disputed) — the honest
      // offline ceiling the aggregate gate encodes.
      const contradictionsRun = await runDataset(await datasetOf('contradictions'));
      expect(contradictionsRun.report.quality.pollution.unresolved_contradictions.count).toBe(1);
      expect(
        contradictionsRun.report.quality.pollution.unresolved_contradictions.memories[0]!.label,
      ).toContain('PostgreSQL');
      expect(
        contradictionsRun.report.quality.pollution.unresolved_contradictions.memories[0]!.status,
      ).toBe('active');
    },
    TIMEOUT_MS,
  );
});

/** The minimal aggregate shape `evaluateGates` needs around one metric family in isolation. */
function minimalAggregate(): AggregateMetrics {
  const byType = (queries: number, gap: number) =>
    QUALITY_QUERY_TYPES.map((query_type: QualityQueryType) => ({
      query_type,
      queries,
      budget_compliance: 1,
      oracle_gap: gap,
      oracle_gap_when_satisfied: gap,
    }));
  return {
    retrieval: { queries: 0, k: 5, precision_at_k: 1, recall_at_k: 1, precision_full: 1, recall_full: 1, mrr: 1 },
    tokens: { queries: 0, budget_compliance: 1, mean_used: 0, max_used: 0, p95_used: 0, mean_tokens_per_expected: 0 },
    pollution: {
      cross_project_top1_rate: 0,
      cross_project_leakage_rate: 0,
      irrelevant_leakage_rate: 0,
      returned: 0,
      leaked: 0,
    },
    temporal: {
      probes: 0,
      correct: 0,
      accuracy: 1,
      current: { probes: 0, correct: 0 },
      point_in_time: { probes: 0, correct: 0 },
      history: { probes: 0, correct: 0 },
    },
    contradiction: { groups: 0, resolved: 0, accuracy: 1, authority_top1: 0, silent_conflicts: 0 },
    consolidation: { groups: 0, quality: 1, fully_consolidated: 0, details: [] },
    precision_recall_by_type: {
      runs: 1,
      k: 5,
      by_type: QUALITY_QUERY_TYPES.map((query_type: QualityQueryType) => ({
        query_type,
        queries_per_run: 0,
        precision_at_k: { mean: 1, ci95_low: 1, ci95_high: 1, samples: 0 },
        recall_at_k: { mean: 1, ci95_low: 1, ci95_high: 1, samples: 0 },
      })),
    },
    token_efficiency: {
      queries: 0,
      budget_compliance: 1,
      by_type: byType(0, 0),
      oracle_gap_mean: 0,
      oracle_gap_max: 0,
      oracle_gap_mean_when_satisfied: 0,
    },
    pollution_audit: {
      stale_cited: { window_days: 30, count: 0, memories: [] },
      duplicates: { cosine_threshold: 0.97, count: 0, pairs: [] },
      unresolved_contradictions: { count: 0, memories: [] },
    },
  };
}
