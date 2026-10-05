/**
 * Markdown rendering of a benchmark report — the human-readable companion to the committed
 * `baseline.json` (`benchmarks/results/baseline.md`).
 */

import type { BenchmarkReport } from './harness';

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

export function renderMarkdown(report: BenchmarkReport): string {
  const lines: string[] = [];
  lines.push('# onememory benchmark baseline');
  lines.push('');
  lines.push(`Generated: ${report.generated_at}`);
  lines.push('');
  lines.push(
    'Runtime: embedded PGlite · no embedder (lexical + graph default) · heuristic extraction (no-LLM) · ' +
      `default max_tokens ${report.engine.default_max_tokens}`,
  );
  lines.push('');
  lines.push(
    `Outbound network attempts during the run: ${report.network_attempts === null ? 'not enforced (guard off)' : report.network_attempts} — local-first invariant (AGENTS.md rule 4).`,
  );
  lines.push('');

  lines.push('## Gated metrics');
  lines.push('');
  lines.push('| Metric | Value | Gate | Direction | Result |');
  lines.push('| --- | ---: | ---: | :---: | :---: |');
  for (const check of report.gates.checks) {
    lines.push(
      `| ${check.metric} | ${check.actual} | ${check.threshold} | ${check.comparison} | ${check.passed ? 'pass' : 'FAIL'} |`,
    );
  }
  lines.push('');
  lines.push(`Overall: **${report.gates.passed ? 'PASS' : 'FAIL'}**`);
  lines.push('');

  lines.push('## Full metrics');
  lines.push('');
  const { metrics } = report;
  lines.push(
    `- retrieval: precision@${metrics.retrieval.k} ${metrics.retrieval.precision_at_k}, ` +
      `recall@${metrics.retrieval.k} ${metrics.retrieval.recall_at_k}, ` +
      `precision(full) ${metrics.retrieval.precision_full}, recall(full) ${metrics.retrieval.recall_full}, ` +
      `MRR ${metrics.retrieval.mrr} over ${metrics.retrieval.queries} queries`,
  );
  lines.push(
    `- tokens: budget compliance ${pct(metrics.tokens.budget_compliance)}, mean ${metrics.tokens.mean_used}, ` +
      `p95 ${metrics.tokens.p95_used}, max ${metrics.tokens.max_used}, ` +
      `mean tokens/expected-fact ${metrics.tokens.mean_tokens_per_expected}`,
  );
  lines.push(
    `- pollution: cross-project top-1 ${pct(metrics.pollution.cross_project_top1_rate)}, ` +
      `cross-project leakage ${pct(metrics.pollution.cross_project_leakage_rate)} ` +
      `(${metrics.pollution.leaked}/${metrics.pollution.returned} returned), ` +
      `declared-distractor leakage ${pct(metrics.pollution.irrelevant_leakage_rate)}`,
  );
  lines.push(
    `- temporal: accuracy ${pct(metrics.temporal.accuracy)} ` +
      `(${metrics.temporal.correct}/${metrics.temporal.probes}) — current ${metrics.temporal.current.correct}/${metrics.temporal.current.probes}, ` +
      `point-in-time ${metrics.temporal.point_in_time.correct}/${metrics.temporal.point_in_time.probes}, ` +
      `history ${metrics.temporal.history.correct}/${metrics.temporal.history.probes}`,
  );
  lines.push(
    `- contradiction: accuracy ${pct(metrics.contradiction.accuracy)} (${metrics.contradiction.resolved}/${metrics.contradiction.groups}), ` +
      `authority top-1 ${metrics.contradiction.authority_top1}, silent conflicts ${metrics.contradiction.silent_conflicts}`,
  );
  lines.push(
    `- consolidation: quality ${pct(metrics.consolidation.quality)}, ` +
      `fully consolidated ${metrics.consolidation.fully_consolidated}/${metrics.consolidation.groups}`,
  );
  lines.push('');

  lines.push('## Datasets');
  lines.push('');
  lines.push('| Dataset | Memories | Superseded | Extraction inserted | Queries |');
  lines.push('| --- | ---: | ---: | ---: | ---: |');
  for (const dataset of report.datasets) {
    lines.push(
      `| ${dataset.id} | ${dataset.memories} | ${dataset.superseded} | ${dataset.extraction.memories_inserted} | ${dataset.queries.length} |`,
    );
  }
  lines.push('');

  const optedIn = report.datasets.filter((dataset) => dataset.consolidation !== null);
  if (optedIn.length > 0) {
    lines.push('## Automatic consolidation pass (M14, dataset opt-in)');
    lines.push('');
    lines.push('| Dataset | Pairs | Resolved | Disputed | Merged | Derived | Archived |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const dataset of optedIn) {
      const pass = dataset.consolidation!;
      lines.push(
        `| ${dataset.id} | ${pass.pairs} | ${pass.resolved} | ${pass.disputed_pairs} | ${pass.merged_sources} | ${pass.derived} | ${pass.archived} |`,
      );
    }
    lines.push('');
    lines.push(
      'Offline default: no embedder is wired, so the vector-gated passes (episodic→semantic ' +
        'derivation, near-duplicate merge) skip with recorded warnings — contradiction resolution ' +
        'and decay are the passes with an effect in this baseline.',
    );
    lines.push('');
  }

  lines.push('## Scenario coverage (backlog M11.1)');
  lines.push('');
  const byScenario = new Map<string, string[]>();
  for (const dataset of report.datasets) {
    for (const fact of dataset.facts) {
      const list = byScenario.get(fact.scenario) ?? [];
      list.push(`${dataset.id}/${fact.key}`);
      byScenario.set(fact.scenario, list);
    }
  }
  for (const [scenario, facts] of [...byScenario.entries()].sort()) {
    lines.push(`- **${scenario}** (${facts.length}): ${facts.join(', ')}`);
  }
  lines.push('');

  return lines.join('\n');
}
