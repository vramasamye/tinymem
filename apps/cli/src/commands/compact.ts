/**
 * `onemem compact` — run the M14.6 events-compaction pass by hand (or from a scheduler):
 * summarize raw `events` rows older than the summary window into `memory_events_digest`, purge
 * raw rows older than the retention window (only after their digest summary exists — the SQL
 * itself refuses a summary-less purge). The `memory_events` audit trail stays append-only and
 * `sources` rows never move; every memory keeps its full provenance lineage through the digest.
 *
 * Backend resolution follows the consolidate pattern: a LIVE daemon owns the embedded data dir
 * (ADR-0002) and the REST API exposes no compaction endpoint yet — so the command refuses
 * instead of opening a second owner. Direct mode opens the composition root without the job
 * worker and runs `runEventsCompaction` over the runtime's compactor port.
 *
 * `--dry-run` prints the typed plan and mutates nothing. `--retention-window 0` means keep
 * forever (database-schema.md §6) — only the summarize tier runs.
 */

import { loadConfig } from '@onememory-ai/config';
import { BackendError, openRuntime } from '@onememory-ai/api/runtime';
import { EventsCompactionConfigSchema, type EventsCompactionReport } from '@onememory-ai/core';
import { runEventsCompaction } from '@onememory-ai/consolidation';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import type { Io } from '../io';

export interface CompactOptions extends ResolveOptions {
  dryRun?: boolean;
  retentionWindowDays?: number;
  summaryWindowDays?: number;
}

/**
 * Parse a `--retention-window` / `--summary-window` duration: integer days, optional `d`
 * suffix (`90`, `90d`). Retention `0` = keep forever; the summary window must be ≥ 1 (to
 * disable compaction entirely, keep raw events forever with `--retention-window 0`).
 */
export function parseWindowDays(value: string, option: string): number {
  const match = /^(\d+)(d)?$/i.exec(value.trim());
  if (match === null) {
    throw new Error(`${option} must be a whole number of days (e.g. 90 or 90d; 0 = keep forever)`);
  }
  return Number(match[1]);
}

/** Assemble the compaction config from CLI flags (Zod-validated at the boundary, like the library entry). */
export function compactConfigOf(options: CompactOptions) {
  const parsed = EventsCompactionConfigSchema.safeParse({
    ...(options.summaryWindowDays === undefined ? {} : { summaryWindowDays: options.summaryWindowDays }),
    ...(options.retentionWindowDays === undefined ? {} : { retentionWindowDays: options.retentionWindowDays }),
  });
  if (!parsed.success) {
    throw new BackendError(
      `invalid compaction windows: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
      'invalid_request',
    );
  }
  return parsed.data;
}

export async function runCompact(options: CompactOptions, io: Io): Promise<number> {
  // 1. The same resolution steps every command walks; like `consolidate`, compact refuses (not
  //    routes) when a daemon owns the data dir — the REST API exposes no compaction endpoint yet.
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  if (daemonUrl !== null) {
    throw new BackendError(
      `a daemon owns this data dir (${daemonUrl}) and the REST API exposes no compaction ` +
        'endpoint yet — daemon-side scheduling is a planned follow-up. Stop the daemon ' +
        "('onemem serve') and run 'onemem compact' again, or wait for the scheduler",
      'conflict',
    );
  }
  const projectId = resolveProjectId(loaded, options.projectId);

  // 2. Direct mode: the composition root without the job worker (a short-lived CLI process is
  //    not a job host).
  const config = compactConfigOf(options);
  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: false,
  });
  try {
    const report = await runEventsCompaction({
      compactor: runtime.storage.compactor,
      scope: { project_id: projectId },
      dryRun: options.dryRun === true,
      config,
    });
    io.emit(report);
    printCompaction(io, report);
    return 0;
  } finally {
    await runtime.close();
  }
}

export function printCompaction(io: Io, report: EventsCompactionReport): void {
  const scope = report.scope.project_id === null ? 'every scope' : `project ${report.scope.project_id}`;
  const mode = report.dry_run ? 'planned (dry run — nothing was changed)' : 'compacted';
  io.out(`events compaction ${mode} for ${scope} at ${report.ran_at.slice(0, 19).replace('T', ' ')}`);
  io.out(
    `windows:    summarize older than ${report.windows.summary_window_days}d, ` +
      (report.windows.retention_window_days === 0
        ? 'keep raw events forever'
        : `purge older than ${report.windows.retention_window_days}d`),
  );
  io.out(
    `plan:       ${report.plan.to_summarize} to summarize, ${report.plan.to_purge} to purge, ` +
      `${report.plan.kept} kept`,
  );
  io.out(
    `applied:    ${report.summarized} summarized, ${report.purged} purged ` +
      `(${report.batches} transaction${report.batches === 1 ? '' : 's'})`,
  );
  io.out(
    `raw events: ${report.raw_events_remaining} remain in scope` +
      (report.truncated ? ' (scan hit the per-run cap — older events await the next pass)' : ''),
  );
  for (const entry of report.plan.blocked) {
    io.err(`kept raw event ${entry.event_id} (${entry.kind}): ${entry.reason}`);
  }
  for (const warning of report.warnings) io.err(`warning: ${warning}`);
}
