/**
 * `onemem skills deprecate <id> --note <why>` — the ACTING half of the decay flow (M15 follow-up
 * 2; ADR-0009 rule 4: "deprecation mirrors Memp's explicit deprecation rather than silent
 * removal"). `onemem skills freshness` REPORTS served skills whose failure signature stopped
 * recurring; THIS command is the operator's explicit, audited retire over the legal
 * `candidate|verified|promoted → deprecated` edge.
 *
 * `deprecated` is terminal (`SKILL_TRANSITIONS` maps it to no edges), and the WHY is required:
 * a terminal transition with no recorded reason is unauditable. The flip rides the same
 * `memory_events` audit path every memory transition uses (provenance rule).
 *
 * The SKILL.md file on disk is deliberately NOT deleted: `promote` may have written it into a
 * runtime-native directory (`--dir .claude/skills`) the row does not record, and an operator may
 * have hand-edited it. The command prints where the default artifact would live; removing a
 * file the operator owns is their call, never a silent CLI side effect.
 */

import { loadConfig } from '@onememory-ai/config';
import { BackendError, localUser, openRuntime } from '@onememory-ai/api/runtime';
import { canTransitionSkill } from '@onememory-ai/core';

import { findLiveDaemonUrl, type ResolveOptions } from '../resolve';
import { shortDate } from '../io';
import type { Io } from '../io';

export interface SkillsDeprecateOptions extends ResolveOptions {
  skillId: string;
  /** Why the skill is being retired — REQUIRED (terminal transition, audited). */
  note?: string;
}

export async function runSkillsDeprecate(options: SkillsDeprecateOptions, io: Io): Promise<number> {
  if (options.note === undefined || options.note.trim().length === 0) {
    // Refused here rather than commander's requiredOption: that path calls process.exit before
    // the JSON error surface can answer (verified against commander 15's _exit), and the refusal
    // deserves the same --json error document every other refusal prints.
    throw new BackendError(
      'deprecating requires --note <why> — deprecated is terminal and the reason is audited',
      'invalid_request',
    );
  }
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  if (daemonUrl !== null) {
    throw new BackendError(
      `a daemon owns this data dir (${daemonUrl}) and the REST API exposes no skills endpoint ` +
        "yet — stop the daemon ('onemem serve') and run 'onemem skills deprecate' again",
      'conflict',
    );
  }

  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: false,
  });
  try {
    const skill = await runtime.storage.skills.getSkill(options.skillId);
    if (skill === null) {
      throw new BackendError(
        `skill ${options.skillId} not found — 'onemem skills list' shows the ids`,
        'not_found',
      );
    }
    if (!canTransitionSkill(skill.status, 'deprecated')) {
      throw new BackendError(
        `skill ${skill.id} is already ${skill.status} — deprecated is terminal ` +
          '(SKILL_TRANSITIONS has no edges out of it); re-distill the failures with ' +
          "'onemem skills generate' if the problem recurs",
        'invalid_request',
      );
    }

    // The audited, guarded flip — the same memory_events path every transition uses.
    const user = await localUser(runtime);
    const deprecated = await runtime.storage.skills.updateSkillStatus(skill.id, 'deprecated', {
      actor: `user:${user.id}`,
      note: options.note,
    });

    io.emit({ skill: deprecated });
    printDeprecation(io, deprecated.name, deprecated.status, deprecated.path, options.note);
    return 0;
  } finally {
    await runtime.close();
  }
}

export function printDeprecation(
  io: Io,
  name: string,
  status: string,
  path: string,
  note: string,
): void {
  io.out(`deprecated ${name} → ${status} at ${shortDate(new Date().toISOString())}`);
  io.out(`  reason:    ${note}`);
  io.out(`  serving:   the memory_skills tool no longer serves it; skills list still shows it`);
  io.out(`  artifact:  ${path} on disk is NOT deleted (it may be hand-edited or runtime-placed) —`);
  io.out(`             remove it yourself if the runtime-native loader should stop loading it`);
}
