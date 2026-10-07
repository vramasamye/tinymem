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

// ---------------------------------------------------------------------------
// The write-target resolver (shared by the CLI and the REST API so they agree)
// ---------------------------------------------------------------------------

/** How a write directory was chosen. */
export type SkillsTargetSource = 'dir-flag' | 'runtime-flag' | 'config' | 'project-default';

export interface SkillsTarget {
  dir: string;
  source: SkillsTargetSource;
  /** Set when a runtime's canonical root was chosen. */
  runtime?: AgentRuntimeId;
}

/** A discriminated result: callers map `ok: false` onto their own error type (core never throws). */
export type SkillsTargetResolution = { ok: true; target: SkillsTarget } | { ok: false; message: string };

/** `~` / `~/x` → HOME-relative; anything else is unchanged. `~` with no HOME is a failure. */
export function expandSkillsHome(path: string, home: string | null): { ok: true; path: string } | { ok: false; message: string } {
  if (path === '~') {
    return home === null
      ? { ok: false, message: "cannot resolve '~': HOME is not set in this environment — pass an absolute --dir" }
      : { ok: true, path: home };
  }
  if (path.startsWith('~/')) {
    return home === null
      ? { ok: false, message: `cannot resolve '${path}': HOME is not set in this environment — pass an absolute --dir` }
      : { ok: true, path: joinPath(home, path.slice(2)) };
  }
  return { ok: true, path };
}

/** Absolute = POSIX-rooted or a Windows drive/UNC path (the project's paths are POSIX-style). */
function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

export interface ResolveSkillsTargetInput {
  /** `--dir <path>` (highest precedence). */
  dirFlag?: string | undefined;
  /** `--runtime <id>`. */
  runtime?: string | undefined;
  /** The config's `skills.dir`. */
  configDir?: string | undefined;
  /** The project root (required for project-relative targets). */
  projectRoot: string | null;
  /** `$HOME`, for `~/` expansion. */
  home: string | null;
}

/**
 * Resolve the skill write directory. Precedence, first wins:
 * `--dir` → `--runtime` → `skills.dir` → `<project root>/skills`.
 *
 * Pure (no filesystem): the caller creates the directory and writes the artifact. Every failure
 * is a message, not a throw, so the CLI and the API can map it onto their own error envelope
 * with the same wording.
 */
export function resolveSkillsTarget(input: ResolveSkillsTargetInput): SkillsTargetResolution {
  if (input.dirFlag !== undefined && input.dirFlag !== '') {
    const expanded = expandSkillsHome(input.dirFlag, input.home);
    return expanded.ok ? { ok: true, target: { dir: expanded.path, source: 'dir-flag' } } : expanded;
  }

  if (input.runtime !== undefined && input.runtime !== '') {
    if (!isAgentRuntimeId(input.runtime)) {
      return { ok: false, message: `unknown runtime '${input.runtime}' — known runtimes: ${AGENT_RUNTIME_IDS.join(', ')}` };
    }
    if (input.projectRoot === null) {
      return {
        ok: false,
        message: `the project has no root path, so runtime ${input.runtime} has nothing to resolve against — pass dir instead`,
      };
    }
    const dir = primarySkillRoot(input.runtime, { root: input.projectRoot, home: input.home });
    if (dir === null) {
      return { ok: false, message: `cannot resolve the ${input.runtime} skills root without HOME — pass dir instead` };
    }
    return { ok: true, target: { dir, source: 'runtime-flag', runtime: input.runtime } };
  }

  const configured = input.configDir;
  if (configured !== undefined && configured !== '') {
    const expanded = expandSkillsHome(configured, input.home);
    if (!expanded.ok) return expanded;
    // A relative configured dir is project-relative (the default shape); an absolute one is used
    // as-is (a `~/global` path expands to an absolute one above).
    if (isAbsolutePath(expanded.path)) return { ok: true, target: { dir: expanded.path, source: 'config' } };
    if (input.projectRoot === null) {
      return {
        ok: false,
        message: `skills.dir is '${configured}' (project-relative) but the project has no root path — pass dir instead`,
      };
    }
    return { ok: true, target: { dir: joinPath(input.projectRoot, expanded.path), source: 'config' } };
  }

  if (input.projectRoot === null) {
    return {
      ok: false,
      message:
        'the project has no root path and no skills directory was given — pass dir (e.g. .claude/skills ' +
        'for Claude Code, .opencode/skills for OpenCode), or set skills.dir in the config',
    };
  }
  return { ok: true, target: { dir: joinPath(input.projectRoot, 'skills'), source: 'project-default' } };
}
