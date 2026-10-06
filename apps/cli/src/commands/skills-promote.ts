/**
 * `onemem skills promote <id>` — the acting half of the review flow (M15 AC3; ADR-0009 rule 2:
 * "promotion requires verification evidence AND user confirmation" — the operator running this
 * command IS the confirmation):
 *
 *   1. write the canonical SKILL.md to the filesystem (the file FIRST: a failed flip leaves a
 *      harmless orphan file a retry overwrites, while a flipped row without its artifact would
 *      claim a serving skill the runtimes cannot load);
 *   2. flip `candidate → verified` through the SkillStore port's guarded, audited
 *      `updateSkillStatus` — the same `memory_events` audit path every memory transition uses
 *      (provenance rule), with the written path recorded in the audit details.
 *
 * Where the file lands: `<project root>/skills/<name>/SKILL.md` by default (the documented
 * layout — ADR-0009 rule 5, the `skills.path` column), or `--dir <dir>` to point at a
 * runtime-native skills directory (Claude Code reads `.claude/skills`, OpenCode reads
 * `.opencode/skills`) so the runtime's own skill loader finds it directly.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { loadConfig } from '@onememory/config';
import { BackendError, localUser, openRuntime } from '@onememory/api/runtime';
import { loadSkillForReview } from '@onememory/consolidation';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import { shortDate } from '../io';
import type { Io } from '../io';

export interface SkillsPromoteOptions extends ResolveOptions {
  skillId: string;
  /** Write target directory (default: `<project root>/skills`). */
  dir?: string;
  /** Why — recorded in the audit trail. */
  note?: string;
}

export async function runSkillsPromote(options: SkillsPromoteOptions, io: Io): Promise<number> {
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  const daemonUrl = await findLiveDaemonUrl(loaded);
  if (daemonUrl !== null) {
    throw new BackendError(
      `a daemon owns this data dir (${daemonUrl}) and the REST API exposes no skills endpoint ` +
        "yet — stop the daemon ('onemem serve') and run 'onemem skills promote' again",
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
    const bundle = await loadSkillForReview({
      skills: runtime.storage.skills,
      store: runtime.storage.store,
      skillId: options.skillId,
    });
    if (bundle === null) {
      throw new BackendError(`skill ${options.skillId} not found — 'onemem skills list' shows the ids`, 'not_found');
    }
    const { skill } = bundle;
    if (skill.status !== 'candidate') {
      throw new BackendError(
        `skill ${skill.id} is ${skill.status}, not candidate — promotion flips candidate → verified ` +
          '(verified → promoted is the usage-proven stage, driven by a future session hook)',
        'invalid_request',
      );
    }
    if (skill.verification.evidence.length === 0) {
      // Defense in depth: the generation gate already required verification evidence
      // (ADR-0009 rule 2) — a row that lost its evidence cannot be promoted.
      throw new BackendError(
        `skill ${skill.id} carries no verification evidence — promotion requires proof the fix worked`,
        'invalid_request',
      );
    }

    // 1. The artifact FIRST (see the header: an orphan file is harmless, a serving row without
    //    its artifact is not).
    const project = await runtime.storage.store.getProject(projectId);
    const rootPath = project === null ? null : project.root_path;
    const baseDir = options.dir ?? rootPath;
    if (baseDir === null) {
      throw new BackendError(
        'the project has no root path and no --dir was given — pass --dir <skills-directory> ' +
          '(e.g. --dir .claude/skills for Claude Code, --dir .opencode/skills for OpenCode)',
        'invalid_request',
      );
    }
    const targetDir = join(baseDir, 'skills', skill.name);
    const targetPath = join(targetDir, 'SKILL.md');
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetPath, bundle.markdown, 'utf-8');

    // 2. The audited flip, with the written path recorded in the audit details.
    const user = await localUser(runtime);
    const promoted = await runtime.storage.skills.updateSkillStatus(skill.id, 'verified', {
      actor: `user:${user.id}`,
      ...(options.note === undefined ? {} : { note: options.note }),
      details: { written_path: targetPath, markdown_bytes: bundle.markdown.length },
    });

    io.emit({ skill: promoted, written_path: targetPath, markdown: bundle.markdown });
    printPromotion(io, promoted.name, targetPath, promoted.status, bundle.markdown.length);
    return 0;
  } finally {
    await runtime.close();
  }
}

export function printPromotion(io: Io, name: string, path: string, status: string, bytes: number): void {
  io.out(`promoted ${name} → ${status} at ${shortDate(new Date().toISOString())}`);
  io.out(`  SKILL.md:  ${path} (${bytes} bytes)`);
  io.out('  serving:   onemem skills list shows it; the MCP memory_skills tool serves verified');
  io.out('             skills (500-token budget); runtime-native loaders read SKILL.md files');
  io.out('             directly (Claude Code: .claude/skills, OpenCode: .opencode/skills —');
  io.out('             promote with --dir <path> to write into those directories)');
}
