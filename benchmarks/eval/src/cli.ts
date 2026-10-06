#!/usr/bin/env bun
/**
 * `bench:run` — execute the harness and write `benchmarks/results/baseline.{json,md}`.
 *
 * Run from anywhere: `bun run --cwd benchmarks/eval bench:run` (or the package script). The
 * network guard is installed for the run so the published baseline can state the outbound-call
 * count (0) instead of asserting it.
 *
 * Exits non-zero when a gate fails, so the same command is usable as a CI step.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { runBenchmark, type BenchmarkReport } from './harness';
import { renderMarkdown } from './report';

/** The `<metric>.<iso-date>.json` per-metric result files (M11b-quality AC: published results). */
function metricResultFiles(report: BenchmarkReport): Array<{ name: string; payload: object }> {
  const date = report.generated_at.slice(0, 10);
  const { metrics } = report;
  return [
    {
      name: `retrieval-quality.${date}.json`,
      payload: {
        schema_version: '1',
        metric: 'retrieval_quality',
        generated_at: report.generated_at,
        engine: {
          profile: report.engine.profile,
          embedder: report.engine.embedder,
          extraction: report.engine.extraction,
        },
        runs: metrics.precision_recall_by_type.runs,
        k: metrics.precision_recall_by_type.k,
        by_type: metrics.precision_recall_by_type.by_type,
        gates: report.gates.checks.filter((check) => check.metric.startsWith('retrieval_')),
      },
    },
    {
      name: `token-efficiency.${date}.json`,
      payload: {
        schema_version: '1',
        metric: 'token_efficiency',
        generated_at: report.generated_at,
        engine: {
          profile: report.engine.profile,
          embedder: report.engine.embedder,
          extraction: report.engine.extraction,
        },
        budget_compliance: metrics.token_efficiency.budget_compliance,
        by_type: metrics.token_efficiency.by_type,
        oracle_gap_mean: metrics.token_efficiency.oracle_gap_mean,
        oracle_gap_max: metrics.token_efficiency.oracle_gap_max,
        oracle_gap_mean_when_satisfied: metrics.token_efficiency.oracle_gap_mean_when_satisfied,
        gates: report.gates.checks.filter(
          (check) =>
            check.metric.startsWith('token_budget_compliance') || check.metric === 'token_oracle_gap_mean',
        ),
      },
    },
    {
      name: `memory-pollution.${date}.json`,
      payload: {
        schema_version: '1',
        metric: 'memory_pollution',
        generated_at: report.generated_at,
        engine: {
          profile: report.engine.profile,
          embedder: report.engine.embedder,
          extraction: report.engine.extraction,
        },
        stale_cited: metrics.pollution_audit.stale_cited,
        duplicates: metrics.pollution_audit.duplicates,
        unresolved_contradictions: metrics.pollution_audit.unresolved_contradictions,
        gates: report.gates.checks.filter(
          (check) =>
            check.metric === 'stale_cited_memories' ||
            check.metric === 'duplicate_surfaced_pairs' ||
            check.metric === 'unresolved_contradicted_memories',
        ),
      },
    },
  ];
}

const PACKAGE_DIR = resolve(import.meta.dir, '..');
const DEFAULT_DATASETS = resolve(PACKAGE_DIR, '..', 'datasets', 'golden');
const DEFAULT_RESULTS = resolve(PACKAGE_DIR, '..', 'results');

interface CliOptions {
  datasetsDir: string;
  resultsDir: string;
  enforceNetworkGuard: boolean;
  jsonOnly: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    datasetsDir: DEFAULT_DATASETS,
    resultsDir: DEFAULT_RESULTS,
    enforceNetworkGuard: true,
    jsonOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case '--datasets':
        options.datasetsDir = resolve(argv[++index] ?? '');
        break;
      case '--results':
        options.resultsDir = resolve(argv[++index] ?? '');
        break;
      case '--no-network-guard':
        options.enforceNetworkGuard = false;
        break;
      case '--json-only':
        options.jsonOnly = true;
        break;
      case '--help':
      case '-h':
        console.log(
          'usage: bench:run [--datasets <dir>] [--results <dir>] [--no-network-guard] [--json-only]',
        );
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function summarize(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push(
    `onememory benchmarks: ${report.datasets.length} dataset(s), ${report.metrics.retrieval.queries} retrieval queries, ${report.metrics.temporal.probes} temporal probes`,
  );
  for (const check of report.gates.checks) {
    lines.push(
      `  ${check.passed ? 'pass' : 'FAIL'}  ${check.metric}=${check.actual} (${check.comparison} ${check.threshold})`,
    );
  }
  if (report.network_attempts !== null) {
    lines.push(`  network attempts: ${report.network_attempts}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runBenchmark({
    datasetsDir: options.datasetsDir,
    enforceNetworkGuard: options.enforceNetworkGuard,
  });

  const json = `${JSON.stringify(report, null, 2)}\n`;
  const markdown = renderMarkdown(report);

  await mkdir(options.resultsDir, { recursive: true });
  const jsonPath = join(options.resultsDir, 'baseline.json');
  await writeFile(jsonPath, json, 'utf8');
  if (!options.jsonOnly) {
    await writeFile(join(options.resultsDir, 'baseline.md'), markdown, 'utf8');
  }
  for (const result of metricResultFiles(report)) {
    await writeFile(join(options.resultsDir, result.name), `${JSON.stringify(result.payload, null, 2)}\n`, 'utf8');
  }

  console.log(summarize(report));
  console.log(`wrote ${jsonPath}${options.jsonOnly ? '' : ` and ${dirname(jsonPath)}/baseline.md`}`);
  for (const result of metricResultFiles(report)) {
    console.log(`wrote ${join(options.resultsDir, result.name)}`);
  }

  if (!report.gates.passed) {
    console.error('benchmark gates failed');
    process.exit(1);
  }
}

await main();
