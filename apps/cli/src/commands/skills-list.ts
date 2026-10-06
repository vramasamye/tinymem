/**
 * `onemem skills list` — the review queue: every skill in scope with its lifecycle status
 * (`candidate` → `verified` → `promoted`, `deprecated`), newest update first. `--status`
 * filters one stage; `--usage` folds the read-only usage hook (M15 AC5) — the captured-session
 * mentions a future session-end hook will record as `usage_count` / `success_rate`.
 *
 * Backend resolution follows the digest/compact pattern (the REST API exposes no skills
 * endpoint yet — refuse, not route, while a daemon owns the data dir).
 */

import { loadConfig } from '@onememory/config';
import { BackendError, openRuntime } from '@onememory/api/runtime';
import { collectSkillUsage } from '@onememory/consolidation';
import type { SkillStatus, SkillUsageSnapshot } from '@onememory/core';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import { shortDate } from '../io';
import type { Io } from '../io';

export interface SkillsListOptions extends ResolveOptions {
  /** One lifecycle stage (`candidate`, `verified`, `promoted`, `deprecated`). */
  status?: SkillStatus;
  /** Fold the read-only usage snapshots (captured-session mentions). */
  usage?: boolean;
}

export async function runSkillsList(options: SkillsListOptions, io: Io): Promise<number> {
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
        "'onemem skills list' again, or wait for the REST surface",
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
    const skills = await runtime.storage.skills.listSkills({
      scope: { project_id: projectId },
      ...(options.status === undefined ? {} : { statuses: [options.status] }),
    });
    const usage = options.usage === true
      ? await collectSkillUsage({ skills: runtime.storage.skills, scope: { project_id: projectId } })
      : null;
    const document = {
      project_id: projectId,
      skills: skills.map((skill) => ({
        ...skill,
        ...(usage === null
          ? {}
          : { usage_snapshot: usage.find((snapshot) => snapshot.skill_id === skill.id) ?? null }),
      })),
    };
    io.emit(document);
    printSkills(io, skills, usage, options.status);
    return 0;
  } finally {
    await runtime.close();
  }
}

export function printSkills(
  io: Io,
  skills: ReadonlyArray<{
    id: string;
    name: string;
    status: string;
    version: string;
    usage_count: number;
    updated_at: string;
    path: string;
  }>,
  usage: ReadonlyArray<SkillUsageSnapshot> | null,
  statusFilter?: SkillStatus,
): void {
  const title = statusFilter === undefined ? 'skills (every status)' : `skills (${statusFilter})`;
  if (skills.length === 0) {
    io.out(`${title}: none yet — recurring solved failures generate candidates ('onemem skills generate')`);
    return;
  }
  io.out(`${title}: ${skills.length}`);
  io.out('');
  for (const skill of skills) {
    const snapshot = usage?.find((entry) => entry.skill_id === skill.id) ?? null;
    const usageNote = snapshot === null
      ? `uses ${skill.usage_count}`
      : `uses ${skill.usage_count}, ${snapshot.mentions} captured mention${snapshot.mentions === 1 ? '' : 's'} ` +
        `in ${snapshot.sessions} session${snapshot.sessions === 1 ? '' : 's'}` +
        (snapshot.last_used_at === null ? '' : `, last ${shortDate(snapshot.last_used_at)}`);
    io.out(`  ${skill.status.padEnd(9)} ${skill.name} v${skill.version} — ${usageNote}`);
    io.out(`           ${skill.path} (updated ${shortDate(skill.updated_at)})`);
  }
  io.out('');
  io.out(
    skills.some((skill) => skill.status === 'candidate')
      ? 'review with: onemem skills review <id> — then onemem skills promote <id> writes the SKILL.md'
      : 'no candidates waiting for review',
  );
}
