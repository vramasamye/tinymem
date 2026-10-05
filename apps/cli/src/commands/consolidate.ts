/**
 * `onemem consolidate` — run the consolidation pass by hand (the phased plan's stage-12/13
 * command): near-duplicate merges, contradiction detection with authority resolution,
 * episodic → semantic derivation, and decay/archive, all over the audited Store paths.
 *
 * Backend resolution follows the same pattern as every other command (ADR-0002): load the
 * config, probe the daemon lock, resolve the project. One difference, deliberate: a LIVE
 * daemon owns the embedded data dir, and the REST API exposes no consolidation endpoint yet
 * (daemon-side scheduling is a planned follow-up) — so the command refuses instead of opening
 * a second owner. Direct mode opens the composition root without the job worker, like every
 * other direct-mode command.
 */

import { loadConfig } from '@onememory/config';
import { BackendError, openRuntime } from '@onememory/api/runtime';
import { runConsolidation, type ConsolidationReport } from '@onememory/consolidation';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import type { Io } from '../io';

export interface ConsolidateOptions extends ResolveOptions {}

export async function runConsolidate(options: ConsolidateOptions, io: Io): Promise<number> {
  // 1. The same resolution steps `resolveBackend` walks, inlined because consolidation must
  //    refuse (not route) when a daemon owns the data dir.
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  if (daemonUrl !== null) {
    throw new BackendError(
      `a daemon owns this data dir (${daemonUrl}) and the REST API exposes no consolidation ` +
        'endpoint yet — daemon-side scheduling is a planned follow-up. Stop the daemon ' +
        "('onemem serve') and run 'onemem consolidate' again, or wait for the scheduler",
      'conflict',
    );
  }
  const projectId = resolveProjectId(loaded, options.projectId);

  // 2. Direct mode: the composition root without the job worker (a short-lived CLI process is
  //    not a job host; queued normalize/extract jobs drain when 'onemem serve' runs).
  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: false,
  });
  try {
    const report = await runConsolidation({
      store: runtime.storage.store,
      vectors: runtime.storage.vectors,
      // `null` is the honest local default (no embeddings configured): the vector-dependent
      // passes degrade with a warning; contradictions and decay always run.
      ...(runtime.embedder === null ? {} : { embedder: runtime.embedder }),
      router: runtime.router,
      scope: { project_id: projectId },
    });
    io.emit(report);
    printConsolidation(io, report);
    return 0;
  } finally {
    await runtime.close();
  }
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
