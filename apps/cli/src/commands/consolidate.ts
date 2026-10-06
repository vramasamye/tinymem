/**
 * `onemem consolidate` — run the consolidation pass by hand (the phased plan's stage-12/13
 * command): near-duplicate merges, contradiction detection with authority resolution,
 * episodic → semantic derivation, and decay/archive, all over the audited Store paths.
 *
 * Two modes (ADR-0002), because the pass is asynchronous by design (memory-model.md §8):
 * - **daemon mode** — a daemon owns the data dir and runs the job worker, so the command queues a
 *   `consolidate` job over `POST /v1/projects/{id}/consolidate` and prints its id. The worker runs
 *   the pass; the store is the record, not the HTTP response.
 * - **direct mode** — no daemon, so there is no worker to drain a queued job: the command opens
 *   the composition root itself (no worker) and runs the pass inline for the full report.
 *
 * Both paths drive the same idempotent `runConsolidation` entry, so the outcome is identical.
 */

import { loadConfig } from '@onememory/config';
import { createHttpBackend, openRuntime } from '@onememory/api/runtime';
import type { ConsolidateOutcome } from '@onememory/api/runtime';
import type { ConsolidationReport } from '@onememory/consolidation';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import type { Io } from '../io';

export interface ConsolidateOptions extends ResolveOptions {}

export async function runConsolidate(options: ConsolidateOptions, io: Io): Promise<number> {
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  const projectId = resolveProjectId(loaded, options.projectId);

  // Daemon mode: the daemon owns the worker, so queue the pass and report the job id.
  if (daemonUrl !== null) {
    const backend = createHttpBackend({ baseUrl: daemonUrl });
    const outcome = await backend.consolidate({ project_id: projectId });
    io.emit(outcome);
    printConsolidateOutcome(io, outcome);
    return 0;
  }

  // Direct mode: no worker exists to drain a queued job, so run the pass inline for the report.
  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: false,
  });
  try {
    const report = await runtime.consolidation.run({ project_id: projectId });
    io.emit(report);
    printConsolidation(io, report);
    return 0;
  } finally {
    await runtime.close();
  }
}

function printConsolidateOutcome(io: Io, outcome: ConsolidateOutcome): void {
  const verb = outcome.outcome === 'existing' ? 'already queued' : 'queued';
  io.out(
    `${verb} a ${outcome.kind} pass for project ${outcome.project_id} (job ${outcome.job_id}, ${outcome.status})`,
  );
  io.out('the daemon worker runs it; the pass is asynchronous, so nothing waits here');
}

export function printConsolidation(io: Io, report: ConsolidationReport): void {
  const scope = report.scope.project_id === null ? 'every scope' : `project ${report.scope.project_id}`;
  io.out(`consolidated ${scope} at ${report.ran_at.slice(0, 19).replace('T', ' ')}`);
  io.out(
    `pool:       ${report.pool.considered} current memories (${report.pool.active} active` +
      `${report.pool.truncated ? ', read cap hit — older memories await a later pass' : ''})`,
  );
  io.out(
    `merges:     ${report.merge.clusters} near-duplicate cluster${report.merge.clusters === 1 ? '' : 's'} ` +
      `(${report.merge.sources_closed} rows absorbed into their highest-authority survivor)`,
  );
  io.out(
    `conflicts:  ${report.contradictions.resolved} resolved by authority, ` +
      `${report.contradictions.disputed_pairs} disputed pair${report.contradictions.disputed_pairs === 1 ? '' : 's'} (tie — never picked silently)`,
  );
  io.out(
    `derived:    ${report.derivations.derived} semantic memor${report.derivations.derived === 1 ? 'y' : 'ies'} ` +
      `from corroborated episodic clusters`,
  );
  io.out(
    `decay:      ${report.decay.archived} archived (prominence below threshold), ${report.decay.kept} kept`,
  );
  for (const skip of report.contradictions.skipped) {
    io.err(`skipped conflict ${skip.a_id} × ${skip.b_id}: ${skip.reason}`);
  }
  for (const skip of report.derivations.skipped) {
    io.err(`skipped derivation cluster (${skip.source_ids.length} members): ${skip.reason}`);
  }
  for (const warning of report.warnings) io.err(`warning: ${warning}`);
}
