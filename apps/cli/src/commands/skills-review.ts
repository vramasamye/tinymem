/**
 * `onemem skills review <id>` — the read-only inspector of the review flow (M15 AC3): prints the
 * candidate's full record, its SKILL.md exactly as promotion would write it (rebuilt from the
 * CURRENT failure evidence through the same builder + renderer — byte-identical to the promote
 * write), and the audit trail read back through the same `memory_events` path every memory uses.
 *
 * Mutates nothing. `onemem skills promote <id>` is the acting half of the flow.
 */

import { loadConfig } from '@onememory/config';
import { BackendError, openRuntime } from '@onememory/api/runtime';
import { loadSkillForReview, type SkillReviewBundle } from '@onememory/consolidation';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import { shortDate } from '../io';
import type { Io } from '../io';

export interface SkillsReviewOptions extends ResolveOptions {
  skillId: string;
}

export async function runSkillsReview(options: SkillsReviewOptions, io: Io): Promise<number> {
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  if (daemonUrl !== null) {
    throw new BackendError(
      `a daemon owns this data dir (${daemonUrl}) and the REST API exposes no skills endpoint ` +
        "yet — stop the daemon ('onemem serve') and run 'onemem skills review' again",
      'conflict',
    );
  }
  resolveProjectId(loaded, options.projectId); // fail fast on an unregistered project

  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: false,
  });
  try {
    const bundle = await loadSkillForReview({
      skills: runtime.storage.skills,
      store: runtime.storage.store,
      skillId: options.skillId,
    });
    if (bundle === null) {
      throw new BackendError(`skill ${options.skillId} not found — 'onemem skills list' shows the ids`, 'not_found');
    }
    io.emit({
      skill: bundle.skill,
      markdown: bundle.markdown,
      audit: bundle.audit,
      unresolved_failure_ids: bundle.unresolved_failure_ids,
    });
    printReview(io, bundle);
    return 0;
  } finally {
    await runtime.close();
  }
}

export function printReview(io: Io, bundle: SkillReviewBundle): void {
  const { skill } = bundle;
  io.out(`skill ${skill.id}`);
  io.out(`  name:        ${skill.name} (v${skill.version})`);
  io.out(`  status:      ${skill.status}`);
  io.out(`  description: ${skill.description}`);
  io.out(`  path:        ${skill.path}`);
  io.out(`  sources:     ${skill.source.failure_ids.length} solved failure(s)`);
  io.out(`  verified:    ${shortDate(skill.verification.verified_at)} (${skill.verification.evidence.length} evidence span(s))`);
  io.out(`  usage:       ${skill.usage_count} recorded use(s)` +
    (skill.success_rate === undefined || skill.success_rate === null ? '' : `, success rate ${skill.success_rate}`));
  io.out('');
  io.out('--- SKILL.md (exactly what promotion writes) ---');
  io.out('');
  for (const line of bundle.markdown.split('\n')) io.out(line);
  io.out('');
  io.out('--- audit trail (memory_events)');
  if (bundle.audit.length === 0) io.out('  (no audit rows)');
  for (const entry of bundle.audit) {
    const detail = Object.entries(entry.details)
      .filter(([key]) => key !== 'kind')
      .map(([key, value]) => `${key}=${typeof value === 'object' ? JSON.stringify(value) : String(value)}`)
      .join(' ');
    io.out(`  ${shortDate(entry.at)} ${entry.action} by ${entry.actor}${detail === '' ? '' : ` — ${detail}`}`);
  }
  if (bundle.unresolved_failure_ids.length > 0) {
    io.err(
      `warning: ${bundle.unresolved_failure_ids.length} source failure(s) could not be re-read ` +
        '(missing or superseded) — the document notes the gap',
    );
  }
  if (skill.status === 'candidate') {
    io.out('');
    io.out(`promote with: onemem skills promote ${skill.id}`);
  }
}
