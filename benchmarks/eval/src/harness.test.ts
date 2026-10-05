/**
 * The CI gate: run the real harness over the committed golden datasets and fail below threshold.
 *
 * `.github/workflows/ci.yaml` runs `bun test` on every push to `main` and every pull request, so
 * this file *is* the regression gate in CI. It also asserts the dataset-conformance contract —
 * every declared fact must still resolve to exactly one extracted memory — so a fixture that
 * silently stops being produced fails here instead of quietly shrinking the benchmark.
 *
 * Each test is self-contained (no shared mutable state), so the file stays correct under any
 * runner ordering or isolation behaviour. The live-report assertions and the breach proof share
 * one harness run because they need the same measured report.
 */

import { describe, expect, test } from 'bun:test';

import { GOLDEN_DATASETS_DIR, loadDatasets } from './dataset';
import { DEFAULT_GATE_THRESHOLDS, evaluateGates } from './gates';
import { runBenchmark, runDataset } from './harness';

const TIMEOUT_MS = 240_000;

describe('benchmark harness gate', () => {
  test(
    'the golden datasets run through the real engine and every gate passes',
    async () => {
      const report = await runBenchmark({ datasetsDir: GOLDEN_DATASETS_DIR });

      // Gated metrics.
      expect(report.gates.passed).toBe(true);
      expect(report.gates.checks.every((check) => check.passed)).toBe(true);
      expect(report.metrics.temporal.accuracy).toBe(1);
      expect(report.metrics.tokens.budget_compliance).toBe(1);
      expect(report.metrics.pollution.cross_project_top1_rate).toBe(0);
      expect(report.metrics.retrieval.recall_at_k).toBe(1);

      // Reported-only metrics are present in the baseline (pre-M14).
      expect(report.gates.reported_only.contradiction_accuracy).toBe(0);
      expect(report.gates.reported_only.consolidation_quality).toBeGreaterThan(0);
      expect(report.metrics.contradiction.silent_conflicts).toBeGreaterThan(0);

      // Every declared fact resolved to exactly one memory (dataset conformance).
      const expectedFacts = report.datasets.reduce((sum, dataset) => sum + dataset.facts.length, 0);
      const declaredFacts = (await loadDatasets(GOLDEN_DATASETS_DIR)).reduce(
        (sum, dataset) => sum + dataset.facts.length,
        0,
      );
      expect(expectedFacts).toBe(declaredFacts);
      expect(report.datasets.length).toBeGreaterThanOrEqual(5);

      // Temporal probes cover all three resolutions.
      expect(report.metrics.temporal.current.probes).toBeGreaterThan(0);
      expect(report.metrics.temporal.point_in_time.probes).toBeGreaterThan(0);
      expect(report.metrics.temporal.history.probes).toBeGreaterThan(0);

      // The gate is not decorative: the same measured report fails once a threshold is breached.
      const breached = evaluateGates(report.metrics, {
        ...DEFAULT_GATE_THRESHOLDS,
        retrieval_precision_at_k: 0.99,
      });
      expect(breached.passed).toBe(false);
      expect(breached.checks.find((check) => check.metric === 'retrieval_precision_at_k')?.passed).toBe(
        false,
      );
    },
    TIMEOUT_MS,
  );

  test(
    'a single dataset run is deterministic across runs',
    async () => {
      const datasets = await loadDatasets(GOLDEN_DATASETS_DIR);
      const temporal = datasets.find((dataset) => dataset.id === 'temporal-node-versions');
      if (temporal === undefined) throw new Error('temporal-node-versions dataset is missing');

      const first = await runDataset(temporal);
      const second = await runDataset(temporal);
      expect(JSON.stringify(first.report.metrics)).toBe(JSON.stringify(second.report.metrics));
      expect(JSON.stringify(first.report.extraction)).toBe(JSON.stringify(second.report.extraction));
    },
    TIMEOUT_MS,
  );
});
