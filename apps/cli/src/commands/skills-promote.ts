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
 * Where the file lands (M15 follow-up 3 — configurable write surface). Precedence, first wins:
 *   1. `--dir <path>`              — an explicit directory;
 *   2. `--runtime <id>`            — that runtime's canonical skills root (`@onememory/core`'s
 *                                    runtime table; e.g. `.claude/skills` for Claude Code);
 *   3. `skills.dir` in the config  — e.g. `.claude/skills`, or `~/.claude/skills` for a global root;
 *   4. `<project root>/skills`     — the documented default (ADR-0009 rule 5).
 *
 * Every runtime discovers skills by scanning its skills root for `<name>/SKILL.md` — none
 * consumes a manifest (verified against each runtime's docs; see the core table). The engine
 * already renders the `name`/`description` frontmatter every runtime requires, and names the
 * directory after the skill, so the same bytes serve all of them.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';

import { loadConfig, type OnememoryConfig } from '@onememory/config';
import { BackendError, localUser, openRuntime } from '@onememory/api/runtime';
import { loadSkillForReview } from '@onememory/consolidation';
import { AGENT_RUNTIME_IDS, isAgentRuntimeId, primarySkillRoot } from '@onememory/core';

import { findLiveDaemonUrl, resolveProjectId, type ResolveOptions } from '../resolve';
import { shortDate } from '../io';
import type { Io } from '../io';

export interface SkillsPromoteOptions extends ResolveOptions {
  skillId: string;
  /** Explicit write directory (highest precedence). */
  dir?: string;
  /** Write into this runtime's canonical skills root (mutually exclusive with `--dir`). */
  runtime?: string;
  /** Why — recorded in the audit trail. */
  note?: string;
}

/** How the write directory was chosen (recorded in the audit details). */
export type SkillsTargetSource = 'dir-flag' | 'runtime-flag' | 'config' | 'project-default';

export interface SkillsTarget {
  dir: string;
  source: SkillsTargetSource;
  /** Set when `--runtime` chose the directory. */
  runtime?: string;
}

/** `~` / `~/x` → HOME-relative; anything else is returned unchanged. */
export function expandHome(path: string, home: string | null): string {
  if (path === '~') return home ?? path;
  if (path.startsWith('~/')) {
    if (home === null) {
      throw new BackendError(
        `cannot resolve '${path}': HOME is not set in this environment — pass an absolute --dir`,
        'invalid_request',
      );
    }
    return join(home, path.slice(2));
  }
  return path;
}

/**
 * Resolve the write directory from the flag/config precedence. Pure (no filesystem) so the
 * precedence is unit-testable; the caller has already validated `--runtime`.
 */
export function resolveSkillsTarget(input: {
  dirFlag?: string | undefined;
  runtime?: string | undefined;
  config: OnememoryConfig;
  projectRoot: string | null;
  home: string | null;
}): SkillsTarget {
  if (input.dirFlag !== undefined && input.dirFlag !== '') {
    return { dir: expandHome(input.dirFlag, input.home), source: 'dir-flag' };
  }

  if (input.runtime !== undefined && input.runtime !== '') {
    if (!isAgentRuntimeId(input.runtime)) {
      throw new BackendError(
        `unknown runtime '${input.runtime}' — known runtimes: ${AGENT_RUNTIME_IDS.join(', ')}`,
        'invalid_request',
      );
    }
    if (input.projectRoot === null) {
      // Every runtime's canonical root is project-scoped, so this needs a project root.
      throw new BackendError(
        `the project has no root path, so --runtime ${input.runtime} has nothing to resolve against — pass --dir <absolute-path> instead`,
        'invalid_request',
      );
    }
    const dir = primarySkillRoot(input.runtime, { root: input.projectRoot, home: input.home });
    if (dir === null) {
      throw new BackendError(
        `cannot resolve the ${input.runtime} skills root without HOME — pass --dir <path>`,
        'invalid_request',
      );
    }
    return { dir, source: 'runtime-flag', runtime: input.runtime };
  }

  const configured = input.config.skills.dir;
  if (configured !== undefined) {
    const expanded = expandHome(configured, input.home);
    // A relative configured dir resolves against the project root (it is project-relative by
    // default); an absolute one is used as-is.
    if (isAbsolute(expanded)) return { dir: expanded, source: 'config' };
    if (input.projectRoot === null) {
      throw new BackendError(
        `skills.dir is '${configured}' (project-relative) but the project has no root path — pass --dir <path>`,
        'invalid_request',
      );
    }
    return { dir: resolve(input.projectRoot, expanded), source: 'config' };
  }

  if (input.projectRoot === null) {
    throw new BackendError(
      'the project has no root path and no skills directory was given — pass --dir <skills-directory> ' +
        '(e.g. --dir .claude/skills for Claude Code, --dir .opencode/skills for OpenCode), or set ' +
        'skills.dir in the config',
      'invalid_request',
    );
  }
  return { dir: join(input.projectRoot, 'skills'), source: 'project-default' };
}

export async function runSkillsPromote(options: SkillsPromoteOptions, io: Io): Promise<number> {
  if (options.dir !== undefined && options.runtime !== undefined) {
    throw new BackendError(
      'pass either --dir <path> or --runtime <id>, not both — --dir is the explicit override',
      'invalid_request',
    );
  }
  // Validate the runtime id before opening storage: a typo should not cost a PGlite boot.
  if (options.runtime !== undefined && !isAgentRuntimeId(options.runtime)) {
    throw new BackendError(
      `unknown runtime '${options.runtime}' — known runtimes: ${AGENT_RUNTIME_IDS.join(', ')}`,
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
        "yet — stop the daemon ('onemem serve') and run 'onemem skills promote' again",
      'conflict',
    );
  }
  const projectId = resolveProjectId(loaded, options.projectId);
  const home = options.env?.['HOME'] ?? process.env['HOME'] ?? null;

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
    const projectRoot = project === null ? null : project.root_path;
    const target = resolveSkillsTarget({
      dirFlag: options.dir,
      runtime: options.runtime,
      config: loaded.config,
      projectRoot,
      home,
    });
    const targetDir = join(target.dir, skill.name);
    const targetPath = join(targetDir, 'SKILL.md');
    await mkdir(targetDir, { recursive: true });
    await writeFile(targetPath, bundle.markdown, 'utf-8');

    // 2. The audited flip, with the written path recorded in the audit details.
    const user = await localUser(runtime);
    const promoted = await runtime.storage.skills.updateSkillStatus(skill.id, 'verified', {
      actor: `user:${user.id}`,
      ...(options.note === undefined ? {} : { note: options.note }),
      details: {
        written_path: targetPath,
        markdown_bytes: bundle.markdown.length,
        skills_root: target.dir,
        skills_root_source: target.source,
      },
    });

    io.emit({
      skill: promoted,
      written_path: targetPath,
      skills_root: target.dir,
      skills_root_source: target.source,
      markdown: bundle.markdown,
    });
    printPromotion(io, promoted.name, targetPath, promoted.status, bundle.markdown.length, target);
    return 0;
  } finally {
    await runtime.close();
  }
}

export function printPromotion(
  io: Io,
  name: string,
  path: string,
  status: string,
  bytes: number,
  target?: SkillsTarget,
): void {
  io.out(`promoted ${name} → ${status} at ${shortDate(new Date().toISOString())}`);
  io.out(`  SKILL.md:  ${path} (${bytes} bytes)`);
  if (target !== undefined && target.runtime !== undefined) {
    io.out(`  runtime:   ${target.runtime} reads ${target.dir}`);
  } else if (target !== undefined && target.source === 'config') {
    io.out(`  root:      ${target.dir} (from skills.dir in the config)`);
  }
  io.out('  serving:   onemem skills list shows it; the MCP memory_skills tool serves verified');
  io.out('             skills (500-token budget); runtime-native loaders read SKILL.md files');
  io.out('             directly (Claude Code: .claude/skills, OpenCode: .opencode/skills,');
  io.out('             Cursor: .cursor/skills, Pi: .pi/skills, Codex: .agents/skills — use');
  io.out('             --runtime <id> or --dir <path> to write into one)');
}
