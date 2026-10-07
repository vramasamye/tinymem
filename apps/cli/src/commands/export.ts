/**
 * `onemem export` — write the Markdown export tree by hand (ADR-0013, mission M18): the
 * deterministic, git-diffable projection of this project's durable memories — MEMORY.md plus a
 * per-type index and one file per memory, every file stamped with the ownership marker. The
 * database stays the sole source of truth: the export is one-way and nothing reads it back.
 *
 * Backend resolution follows `onemem digest`'s pattern, with the same deliberate difference: a
 * LIVE daemon owns the embedded data dir and the REST API exposes no export endpoint yet
 * (daemon-side export is a planned follow-up), so the command refuses instead of opening a
 * second owner. Direct mode opens the composition root without the job worker.
 */

import { join } from 'node:path';

import { loadConfig } from '@onememory/config';
import { BackendError, exportProject, openRuntime, type ExportProjectReport } from '@onememory/api/runtime';

import { findLiveDaemonUrl, resolveProjectIdForCwd, type ResolveOptions } from '../resolve';
import type { Io } from '../io';

export interface ExportOptions extends ResolveOptions {
  /** Export root override (default: the config `export.dir`, else `<project root>/memory`). */
  dir?: string;
}

export async function runExport(options: ExportOptions, io: Io): Promise<number> {
  // 1. The same resolution steps `resolveBackend` walks, inlined because the export must refuse
  //    (not route) while a daemon owns the data dir — the digest precedent.
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  if (daemonUrl !== null) {
    throw new BackendError(
      `a daemon owns this data dir (${daemonUrl}) and the REST API exposes no export endpoint ` +
        "yet — daemon-side export is a planned follow-up. Stop the daemon ('onemem serve') and run " +
        "'onemem export' again",
      'conflict',
    );
  }
  // 2. Direct mode: the composition root without the job worker (like every direct-mode command).
  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: false,
  });
  // Opened first so the cwd→project lookup (M17) can read the store.
  const projectId = await resolveProjectIdForCwd(loaded, options.projectId, runtime.storage.store, options.cwd);
  try {
    const report = await exportProject(runtime, {
      project_id: projectId,
      ...(options.dir === undefined ? {} : { dir: options.dir }),
    });
    io.emit(report);
    printExport(io, report);
    return 0;
  } finally {
    await runtime.close();
  }
}

export function printExport(io: Io, report: ExportProjectReport): void {
  io.out(`exported project ${report.project_id} to ${report.root} (${report.root_source} root)`);
  const parts = Object.entries(report.by_type).map(([type, count]) => `${count} ${type}`);
  io.out(`memories:    ${report.memories}${parts.length === 0 ? '' : ` (${parts.join(', ')})`}`);
  io.out(`files:       ${report.files_written} written, ${report.files_pruned} pruned (owned stale files only)`);
  io.out(`index:       ${join(report.root, 'MEMORY.md')}`);
  io.blank();
  io.out('one-way projection: the database stays canonical — change memories there, re-run export');
}
