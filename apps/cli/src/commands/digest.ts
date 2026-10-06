/**
 * `onemem digest` — run the project digest rollup by hand (backlog M14.5): ONE token-bounded
 * `project_context` digest memory per project, summarizing the top accepted decisions, known
 * failures, and current procedures, and feeding the `memory_project_context` tool surface through
 * `projects.digest`. Pure text over durable rows — zero model calls, zero network.
 *
 * Backend resolution follows `onemem consolidate`'s pattern, with the same deliberate
 * difference: a LIVE daemon owns the embedded data dir and the REST API exposes no digest
 * endpoint yet (daemon-side scheduling is a planned follow-up), so the command refuses instead
 * of opening a second owner. Direct mode opens the composition root without the job worker.
 */

import { loadConfig } from '@onememory/config';
import { BackendError, openRuntime } from '@onememory/api/runtime';
import { runDigest as runDigestPass, type ProjectDigestPassResult } from '@onememory/consolidation';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import type { Io } from '../io';

export interface DigestOptions extends ResolveOptions {
  /** Digest token budget (default 750 — the `memory_project_context` tool budget). */
  budget?: number;
}

export async function runDigest(options: DigestOptions, io: Io): Promise<number> {
  // 1. The same resolution steps `resolveBackend` walks, inlined because the digest pass must
  //    refuse (not route) while a daemon owns the data dir — the consolidate precedent.
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  if (daemonUrl !== null) {
    throw new BackendError(
      `a daemon owns this data dir (${daemonUrl}) and the REST API exposes no digest endpoint ` +
        "yet — daemon-side scheduling is a planned follow-up. Stop the daemon ('onemem serve') and run " +
        "'onemem digest' again, or wait for the scheduler",
      'conflict',
    );
  }
  const projectId = resolveProjectId(loaded, options.projectId);

  // 2. Direct mode: the composition root without the job worker (like every direct-mode command).
  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: false,
  });
  try {
    const report = await runDigestPass({
      store: runtime.storage.store,
      client: runtime.storage.client,
      project_id: projectId,
      ...(options.budget === undefined ? {} : { budget: options.budget }),
    });
    io.emit(report);
    printDigest(io, report);
    return report.outcome === 'failed' ? 1 : 0;
  } finally {
    await runtime.close();
  }
}

export function printDigest(io: Io, report: ProjectDigestPassResult): void {
  const outcome = report.outcome;
  io.out(`project digest ${outcome} for project ${report.project_id} at ${report.ran_at.slice(0, 19).replace('T', ' ')}`);
  if (report.memory_id !== null) io.out(`memory:     ${report.memory_id}`);
  if (report.digest !== null) {
    io.out(
      `budget:     ${report.digest.used}/${report.digest.budget} tokens` +
        `${report.digest.truncated ? ' (entries dropped to fit — the lowest-priority lines went first)' : ''}`,
    );
    io.out(
      `sources:    ${report.digest.sources.decisions} decisions, ` +
        `${report.digest.sources.failures} failures, ${report.digest.sources.procedures} procedures`,
    );
    io.blank();
    // The digest itself, verbatim — this is the artifact agents and humans inspect.
    for (const line of report.digest.text.split('\n')) io.out(line);
  }
  for (const warning of report.warnings) io.err(`warning: ${warning}`);
}
