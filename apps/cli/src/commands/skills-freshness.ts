/**
 * `onemem skills freshness` — the M15 decay pass surfaced at the CLI: for every SERVED skill
 * (`verified` / `promoted`), does the failure signature it was distilled from still recur in
 * the current failure pool?
 *
 * READ-ONLY by design (ADR-0009 rule 4: deprecation is explicit, never silent — and
 * `verified → candidate` is not a legal edge, so a served artifact never silently reverts to
 * the review queue). A skill whose signature stopped recurring is reported as `stale` with the
 * evidence; retiring it is the operator's call, through the audited `onemem skills deprecate`.
 *
 * Backend resolution follows the skills-list pattern (the REST API exposes no skills endpoint
 * yet — refuse, not route, while a daemon owns the data dir).
 */

import { loadConfig } from '@onememory-ai/config';
import { BackendError, openRuntime } from '@onememory-ai/api/runtime';
import { runSkillFreshness } from '@onememory-ai/consolidation';
import type { SkillFreshnessReport } from '@onememory-ai/core';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import { shortDate } from '../io';
import type { Io } from '../io';

export interface SkillsFreshnessOptions extends ResolveOptions {
  /** Skill-assessment cap (default 200; the pool cap follows the generation default). */
  skillLimit?: number;
}

export async function runSkillsFreshness(options: SkillsFreshnessOptions, io: Io): Promise<number> {
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  if (daemonUrl !== null) {
    throw new BackendError(
      `a daemon owns this data dir (${daemonUrl}) and the REST API exposes no skills endpoint ` +
        "yet — stop the daemon ('onemem serve') and run 'onemem skills freshness' again",
      'conflict',
    );
  }
  const projectId = resolveProjectId(loaded, options.projectId);

  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: false,
  });
  try {
    const report = await runSkillFreshness({
      skills: runtime.storage.skills,
      store: runtime.storage.store,
      ...(projectId === undefined ? {} : { scope: { project_id: projectId } }),
      ...(options.skillLimit === undefined ? {} : { config: { skillLimit: options.skillLimit } }),
    });
    io.emit(report);
    printFreshness(io, report);
    return 0;
  } finally {
    await runtime.close();
  }
}

export function printFreshness(io: Io, report: SkillFreshnessReport): void {
  io.out(
    `skill freshness: ${report.skills.assessed} served ` +
      `(${report.skills.fresh} fresh, ${report.skills.stale} stale) — pool ${report.pool.failures} failures` +
      (report.pool.truncated ? ' (capped)' : ''),
  );
  if (report.skills.assessed === 0) {
    io.out('');
    io.out('no served skills yet — promote a candidate first (onemem skills review → promote)');
    return;
  }
  io.out('');
  for (const record of report.skills.records) {
    if (record.stale) {
      io.out(`  stale  ${record.name} (${record.status})`);
      io.out(`         signature ${record.signatures.join(', ')} no longer recurs in the pool`);
      io.out(`         retire with: onemem skills deprecate ${record.skill_id} --note <why>`);
    } else {
      const last = record.last_recurred_at === null ? '' : `, last ${shortDate(record.last_recurred_at)}`;
      io.out(`  fresh  ${record.name} (${record.status})`);
      io.out(
        `         ${record.recurring_signatures.length} of ${record.signatures.length} cited signature` +
          `${record.signatures.length === 1 ? '' : 's'} still recurring${last}`,
      );
    }
  }
  if (report.warnings.length > 0) {
    io.out('');
    for (const warning of report.warnings) io.out(`  warning: ${warning}`);
  }
}
