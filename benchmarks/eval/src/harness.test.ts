/**
 * The CI gate: run the real harness over the committed golden datasets and fail below threshold.
 *
 * `.github/workflows/ci.yaml` runs `bun test` on every push to `main` and every pull request, so
 * this file *is* the regression gate in CI. It also asserts the dataset-conformance contract —
 * every declared fact must still resolve to exactly one extracted memory — so a fixture that
 * silently stops being produced fails here instead of quietly shrinking the benchmark.
 *
 * The M14 metrics (contradiction accuracy, consolidation quality) are gated since the post-M14
 * baseline flip: the tests below pin what that gate honestly guarantees — every authority level
 * resolves, the full-tie sides are excluded from current answers, decay archives nothing the
 * fixtures do not intend, and the offline degradation of the vector-gated passes is visible in
 * the report instead of silently skipped.
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

      // Gated metrics (all eight originals + the thirteen M11b-quality gates: per-type
      // precision/recall, per-type budget compliance, the token-oracle gap, and the three
      // pollution counts).
      expect(report.gates.passed).toBe(true);
      expect(report.gates.checks).toHaveLength(21);
      expect(report.gates.checks.every((check) => check.passed)).toBe(true);
      expect(report.metrics.temporal.accuracy).toBe(1);
      expect(report.metrics.tokens.budget_compliance).toBe(1);
      expect(report.metrics.pollution.cross_project_top1_rate).toBe(0);
      expect(report.metrics.retrieval.recall_at_k).toBe(1);

      // Contradiction coverage (M11a follow-up: n=1 → several groups): every authority level
      // (explicit > decision > newer > confidence) plus one full tie.
      expect(report.metrics.contradiction.groups).toBeGreaterThanOrEqual(6);
      expect(report.metrics.contradiction.accuracy).toBeGreaterThanOrEqual(
        DEFAULT_GATE_THRESHOLDS.contradiction_accuracy,
      );
      // The measured miss: the cross-phrasing pair the attribute-template heuristic cannot
      // detect stays a silent conflict — the documented detector gap (M14 follow-up: LLM
      // conflict detector). If this drops to 0, raise the gate threshold consciously.
      expect(report.metrics.contradiction.silent_conflicts).toBe(1);

      // Consolidation quality is gated at the honest offline ceiling (no embedder → the
      // vector-gated passes skip with warnings; exact ingest dedupe is the only collapse).
      expect(report.metrics.consolidation.quality).toBeGreaterThanOrEqual(
        DEFAULT_GATE_THRESHOLDS.consolidation_quality,
      );

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

      // The automatic pass ran on the opted-in datasets: pairs detected, resolved and disputed,
      // and the full-tie sides are excluded from current answers (never a silent pick).
      const contradictionsRun = report.datasets.find((dataset) => dataset.id === 'contradictions');
      expect(contradictionsRun?.consolidation?.pairs).toBe(5);
      expect(contradictionsRun?.consolidation?.resolved).toBe(4);
      expect(contradictionsRun?.consolidation?.disputed_pairs).toBe(1);
      const tieProbe = contradictionsRun?.queries.find((query) => query.id === 'contradiction-full-tie-disputed');
      expect(tieProbe?.expectedIds).toEqual([]);
      expect(tieProbe?.forbiddenIds.length).toBe(2);
      expect(tieProbe?.returnedIds.some((id) => tieProbe.forbiddenIds.includes(id))).toBe(false);

      // The decay pass archived nothing UNLESS the dataset intends archival: fixtures are
      // minutes old, so prominence sits far above the archive threshold (fixed-clock safety
      // check). The one deliberate exception is the M11b-quality pollution fixture, whose
      // 60-day-old low-prominence version fact is archived by design (archived-but-cited is
      // the stale state the pollution audit detects).
      for (const dataset of report.datasets) {
        if (dataset.consolidation !== null) {
          expect(dataset.consolidation.archived).toBe(dataset.id === 'pollution-quality' ? 1 : 0);
          // Offline honesty: the vector-gated passes (derivation, merge) skipped with a recorded
          // warning, never silently (memory-model.md §1.6).
          expect(
            dataset.consolidation.warnings.some((warning) => warning.includes('no embedding provider')),
          ).toBe(true);
        }
      }

      // The gate is not decorative: the same measured report fails once a threshold is breached
      // (the pre-M14 pattern, now proven for all three threshold families).
      const breached = evaluateGates(report.metrics, {
        ...DEFAULT_GATE_THRESHOLDS,
        retrieval_precision_at_k: 0.99,
      });
      expect(breached.passed).toBe(false);
      expect(breached.checks.find((check) => check.metric === 'retrieval_precision_at_k')?.passed).toBe(
        false,
      );

      const breachedContradiction = evaluateGates(report.metrics, {
        ...DEFAULT_GATE_THRESHOLDS,
        contradiction_accuracy: 0.99,
      });
      expect(breachedContradiction.passed).toBe(false);
      expect(
        breachedContradiction.checks.find((check) => check.metric === 'contradiction_accuracy')?.passed,
      ).toBe(false);

      const breachedConsolidation = evaluateGates(report.metrics, {
        ...DEFAULT_GATE_THRESHOLDS,
        consolidation_quality: 0.99,
      });
      expect(breachedConsolidation.passed).toBe(false);
      expect(
        breachedConsolidation.checks.find((check) => check.metric === 'consolidation_quality')?.passed,
      ).toBe(false);
    },
    TIMEOUT_MS,
  );

  test(
    'single dataset runs are deterministic across runs (declared supersessions and the automatic pass)',
    async () => {
      const datasets = await loadDatasets(GOLDEN_DATASETS_DIR);
      const temporal = datasets.find((dataset) => dataset.id === 'temporal-node-versions');
      if (temporal === undefined) throw new Error('temporal-node-versions dataset is missing');
      const contradictions = datasets.find((dataset) => dataset.id === 'contradictions');
      if (contradictions === undefined) throw new Error('contradictions dataset is missing');

      const firstTemporal = await runDataset(temporal);
      const secondTemporal = await runDataset(temporal);
      expect(JSON.stringify(firstTemporal.report.metrics)).toBe(JSON.stringify(secondTemporal.report.metrics));
      expect(JSON.stringify(firstTemporal.report.extraction)).toBe(JSON.stringify(secondTemporal.report.extraction));

      const firstContradictions = await runDataset(contradictions);
      const secondContradictions = await runDataset(contradictions);
      expect(JSON.stringify(firstContradictions.report.metrics)).toBe(
        JSON.stringify(secondContradictions.report.metrics),
      );
      expect(JSON.stringify(firstContradictions.report.consolidation)).toBe(
        JSON.stringify(secondContradictions.report.consolidation),
      );
      expect(JSON.stringify(firstContradictions.report.extraction)).toBe(
        JSON.stringify(secondContradictions.report.extraction),
      );
    },
    TIMEOUT_MS,
  );
});
