/**
 * `onemem skills generate` — run the M15 skill-generation pass by hand (the `skillify` job's
 * body): scan the failure recurrence pool, group by signature (scope + entity), gate on
 * "solved ≥ 2 times with equivalent solutions and verification evidence", and write SKILL.md
 * CANDIDATES — never promotions. Candidates queue for `onemem skills review` / `promote`
 * (ADR-0009 rule 2: the human in the loop).
 *
 * Backend resolution follows the digest/compact pattern: a LIVE daemon owns the embedded data
 * dir (ADR-0002) and the REST API exposes no skills endpoint yet — the command refuses instead
 * of opening a second owner. Direct mode opens the composition root without the job worker.
 */

import { loadConfig } from '@onememory-ai/config';
import { BackendError, openRuntime } from '@onememory-ai/api/runtime';
import { runSkillGeneration } from '@onememory-ai/consolidation';
import type { SkillGenerationReport } from '@onememory-ai/core';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import type { Io } from '../io';

export interface SkillsGenerateOptions extends ResolveOptions {}

export async function runSkillsGenerate(options: SkillsGenerateOptions, io: Io): Promise<number> {
  // 1. The same resolution steps every scheduled-pass command walks: refuse (not route) while a
  //    daemon owns the data dir — the digest/compact precedent, honest about the missing endpoint.
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  if (daemonUrl !== null) {
    throw new BackendError(
      `a daemon owns this data dir (${daemonUrl}) and the REST API exposes no skills endpoint ` +
        "yet — daemon-side scheduling is a planned follow-up. Stop the daemon ('onemem serve') and run " +
        "'onemem skills generate' again, or wait for the scheduler",
      'conflict',
    );
  }
  const projectId = resolveProjectId(loaded, options.projectId);

  // 2. Direct mode: the composition root without the job worker (a short-lived CLI process is
  //    not a job host).
  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: false,
  });
  try {
    const report = await runSkillGeneration({
      skills: runtime.storage.skills,
      scope: { project_id: projectId },
      // By-hand run of the skillify job's body — the job vocabulary is the honest actor.
      actor: 'job:skillify',
    });
    io.emit(report);
    printSkillGeneration(io, report);
    return 0;
  } finally {
    await runtime.close();
  }
}

export function printSkillGeneration(io: Io, report: SkillGenerationReport): void {
  const scope = report.scope.project_id === null ? 'every scope' : `project ${report.scope.project_id}`;
  io.out(`skill generation for ${scope} at ${report.ran_at.slice(0, 19).replace('T', ' ')}`);
  io.out(
    `pool:       ${report.pool.failures} failures scanned` +
      (report.pool.truncated ? ' (pool cap reached — a second pass continues)' : ''),
  );
  io.out(
    `groups:     ${report.groups.considered} signature groups — ` +
      `${report.groups.qualified} qualified, ${report.groups.blocked} blocked`,
  );
  io.out(
    `candidates: ${report.candidates.created} created, ${report.candidates.refreshed} refreshed, ` +
      `${report.candidates.unchanged} unchanged`,
  );
  for (const record of report.candidates.records) {
    io.out(
      `  ${record.outcome.padEnd(9)} ${record.name} (${record.failure_ids.length} failures, ` +
        `signature ${record.signature_hash.slice(0, 12)}…) → ${record.path}`,
    );
  }
  for (const blocked of report.blocked) {
    io.err(`blocked:    signature ${blocked.signature_hash.slice(0, 12)}… (${blocked.failures} failures): ${blocked.detail}`);
  }
  for (const warning of report.warnings) io.err(`warning: ${warning}`);
}
