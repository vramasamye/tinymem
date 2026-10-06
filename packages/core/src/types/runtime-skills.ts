/**
 * Runtime skill discovery (M15 follow-up 3): where each agent runtime loads `SKILL.md` from, so
 * the skill write surface can target a runtime instead of a hand-typed directory.
 *
 * Grounded in the runtimes' own docs (checked 2026-10-06; the source URL is recorded per entry):
 * **every** runtime discovers skills by scanning a skills root for `<name>/SKILL.md`. **None**
 * consumes a `manifest.json` or any machine-readable index for local-disk discovery — the one
 * index file in the ecosystem (OpenCode v2's `index.json`) is only for REMOTE HTTP catalogs. So
 * the only per-runtime knobs are the skills root(s); the frontmatter the engine already renders
 * (`name`, `description`, `version`, with `name` matching the directory) satisfies every runtime.
 *
 * This table is data + pure resolution, no filesystem access: the CLI resolves a root and writes
 * the artifact, keeping core runtime-free (repository-structure.md).
 */

/** The five runtimes onememory wires (kept in sync with the adapters and `onemem init`). */
export const AGENT_RUNTIME_IDS = ['claude-code', 'codex', 'cursor', 'pi', 'opencode'] as const;
export type AgentRuntimeId = (typeof AGENT_RUNTIME_IDS)[number];

export interface RuntimeSkillRoot {
  /** Project-scoped roots live under the project root; global roots live under `$HOME`. */
  scope: 'project' | 'global';
  /** Project-relative (e.g. `.claude/skills`) or HOME-relative with a `~/` prefix. */
  path: string;
}

export interface RuntimeSkillTarget {
  runtime: AgentRuntimeId;
  /** Where the runtime loads `<name>/SKILL.md` from, most canonical first (first = primary). */
  roots: readonly RuntimeSkillRoot[];
  /** The doc these paths come from — provenance for this table. */
  source: string;
}

/**
 * The discovery table. Each entry's first root is the runtime's OWN canonical location (what a
 * `--runtime <id>` write targets); the remaining roots are compatibility locations the runtime
 * also reads, listed so the docs and `--dir` guidance stay honest.
 */
export const RUNTIME_SKILL_TARGETS: Record<AgentRuntimeId, RuntimeSkillTarget> = {
  'claude-code': {
    runtime: 'claude-code',
    roots: [
      { scope: 'project', path: '.claude/skills' },
      { scope: 'global', path: '~/.claude/skills' },
    ],
    source: 'https://code.claude.com/docs/en/skills',
  },
  codex: {
    runtime: 'codex',
    roots: [
      { scope: 'project', path: '.agents/skills' },
      { scope: 'global', path: '~/.agents/skills' },
    ],
    source: 'https://developers.openai.com/codex/skills',
  },
  cursor: {
    runtime: 'cursor',
    roots: [
      { scope: 'project', path: '.cursor/skills' },
      { scope: 'project', path: '.agents/skills' },
      { scope: 'global', path: '~/.cursor/skills' },
      { scope: 'global', path: '~/.agents/skills' },
    ],
    source: 'https://cursor.com/docs/skills',
  },
  pi: {
    runtime: 'pi',
    roots: [
      { scope: 'project', path: '.pi/skills' },
      { scope: 'project', path: '.agents/skills' },
      { scope: 'global', path: '~/.pi/agent/skills' },
      { scope: 'global', path: '~/.agents/skills' },
    ],
    source: 'https://pi.dev/docs/latest/skills',
  },
  opencode: {
    runtime: 'opencode',
    roots: [
      { scope: 'project', path: '.opencode/skills' },
      { scope: 'global', path: '~/.config/opencode/skills' },
    ],
    source: 'https://opencode.ai/docs/skills/',
  },
};

/** Is `value` one of the known runtime ids? (Boundary check for CLI/config input.) */
export function isAgentRuntimeId(value: string): value is AgentRuntimeId {
  return (AGENT_RUNTIME_IDS as readonly string[]).includes(value);
}

export interface SkillRootContext {
  /** The project root a project-scoped root resolves against. */
  root: string;
  /** `$HOME` for global roots; `null` when the environment provides none. */
  home: string | null;
}

/** POSIX-style join (the repo's project-relative paths use `/` throughout). */
function joinPath(base: string, relative: string): string {
  return `${base.replace(/\/+$/, '')}/${relative.replace(/^\/+/, '')}`;
}

/** Resolve one root to an absolute path, or `null` when it is global and no HOME is known. */
export function resolveSkillRoot(entry: RuntimeSkillRoot, context: SkillRootContext): string | null {
  if (entry.scope === 'project') return joinPath(context.root, entry.path);
  if (context.home === null) return null;
  return joinPath(context.home, entry.path.replace(/^~\//, ''));
}

/** Every resolved root for a runtime, in preference order (global roots drop out without a HOME). */
export function resolveSkillRoots(runtime: AgentRuntimeId, context: SkillRootContext): string[] {
  return RUNTIME_SKILL_TARGETS[runtime].roots
    .map((entry) => resolveSkillRoot(entry, context))
    .filter((path): path is string => path !== null);
}

/**
 * The single directory a `--runtime <id>` write targets: the runtime's most canonical root.
 * Prefers a project-scoped root (self-contained, diffable, portable across machines); falls back
 * to the first global root. `null` when the runtime's only roots are global and no HOME is known.
 */
export function primarySkillRoot(runtime: AgentRuntimeId, context: SkillRootContext): string | null {
  const roots = RUNTIME_SKILL_TARGETS[runtime].roots;
  const project = roots.find((entry) => entry.scope === 'project');
  const chosen = project ?? roots[0];
  return chosen === undefined ? null : resolveSkillRoot(chosen, context);
}

/** The runtime whose canonical root resolves to `dir` (for explaining a `--dir`), if any. */
export function runtimeForSkillDir(dir: string, context: SkillRootContext): AgentRuntimeId | null {
  const normalized = dir.replace(/\/+$/, '');
  for (const runtime of AGENT_RUNTIME_IDS) {
    const primary = primarySkillRoot(runtime, context);
    if (primary !== null && primary.replace(/\/+$/, '') === normalized) return runtime;
  }
  return null;
}
