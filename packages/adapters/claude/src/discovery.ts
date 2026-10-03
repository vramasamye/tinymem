/**
 * Hook-side discovery: where is this project's onememory state, which project is it, and is a
 * daemon answering?
 *
 * Wire formats (deliberate re-declaration — see mission-6.md §4): the readers are tiny strict
 * schemas pinned to the formats owned by `@onememory/config` (`project.json`,
 * packages/config/src/project-state.ts) and `@onememory/api` (`daemon.json`,
 * apps/api/src/runtime/lock.ts). The hook binary must spawn in milliseconds on EVERY tool call,
 * so it depends on `@onememory/core` only (importing the config/api packages would pull the router,
 * yaml, and composition graphs into each spawn). Both formats are stable cross-process wire
 * records; if either evolves, the field names below are the contract to update.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

/** `.onememory/project.json` — the pointer `onemem init` writes (packages/config project-state). */
export const ProjectStateSchema = z.strictObject({
  version: z.literal(1).default(1),
  project_id: z.uuid(),
  name: z.string().min(1),
  root_path: z.string().min(1),
  git_remote: z.string().min(1).optional(),
  created_at: z.iso.datetime(),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;

/** `.onememory/daemon.json` — the daemon lock (apps/api runtime/lock.ts owns the format). */
export const DaemonLockSchema = z.strictObject({
  version: z.literal(1).default(1),
  pid: z.number().int().min(1),
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  url: z.string().min(1),
  started_at: z.iso.datetime(),
  version_string: z.string().min(1),
});
export type DaemonLock = z.infer<typeof DaemonLockSchema>;

export const ONEMEMORY_DIR_NAME = '.onememory';
export const PROJECT_STATE_FILE = 'project.json';
export const DAEMON_LOCK_FILE = 'daemon.json';

/** Walk up from `startDir` looking for the nearest `.onememory/project.json` (git-style discovery). */
export function findOnememoryDir(startDirs: readonly (string | undefined)[]): string | null {
  for (const start of startDirs) {
    if (start === undefined || start.length === 0) continue;
    let dir = resolve(start);
    for (;;) {
      if (existsSync(join(dir, ONEMEMORY_DIR_NAME, PROJECT_STATE_FILE))) return join(dir, ONEMEMORY_DIR_NAME);
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return null;
}

/** Read `project.json`; `null` when absent or malformed (fail-soft — never throw in a hook). */
export function readProjectState(configDir: string): ProjectState | null {
  try {
    const parsed = ProjectStateSchema.safeParse(JSON.parse(readFileSync(join(configDir, PROJECT_STATE_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Read `daemon.json`; `null` when absent or malformed. */
export function readDaemonLock(configDir: string): DaemonLock | null {
  try {
    const parsed = DaemonLockSchema.safeParse(JSON.parse(readFileSync(join(configDir, DAEMON_LOCK_FILE), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** True when a process with this pid exists (signal 0 does not actually signal it). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to another user.
    return (error as { code?: string }).code === 'EPERM';
  }
}

export interface ResolveTargetResult {
  /** The `.onememory` directory when found. */
  configDir: string | null;
  /** Project id from `ONEMEMORY_PROJECT_ID` or the pointer file; null when unresolvable. */
  projectId: string | null;
  /** Where the daemon answers; null when no lock, stale pid, or the `ONEMEMORY_DAEMON_URL` override is unset/invalid. */
  daemonUrl: string | null;
  /** How each fact was found (for the stderr diagnostics one-liner). */
  origin: {
    projectId: 'env' | 'project-state' | 'unresolved';
    daemonUrl: 'env' | 'daemon-lock' | 'none';
  };
}

export interface ResolveTargetOptions {
  /** Hook input `cwd` (first preference — the session's current working directory). */
  inputCwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the delivery target for one hook invocation. Environment overrides win; then the
 * nearest `.onememory/project.json` walking up from the input cwd (the same git-style discovery
 * `onemem` commands use); the daemon URL comes from the lock file and its pid is liveness-checked
 * so we never spend the timeout budget on a dead process.
 */
export function resolveHookTarget(options: ResolveTargetOptions = {}): ResolveTargetResult {
  const env = options.env ?? {};
  const configDir = findOnememoryDir([options.inputCwd, env.CLAUDE_PROJECT_DIR, process.cwd()]);

  let projectId: string | null = null;
  let projectOrigin: ResolveTargetResult['origin']['projectId'] = 'unresolved';
  const envProject = env.ONEMEMORY_PROJECT_ID;
  if (envProject !== undefined && envProject !== '' && z.uuid().safeParse(envProject).success) {
    projectId = envProject;
    projectOrigin = 'env';
  } else if (configDir !== null) {
    const state = readProjectState(configDir);
    if (state !== null) {
      projectId = state.project_id;
      projectOrigin = 'project-state';
    }
  }

  let daemonUrl: string | null = null;
  let daemonOrigin: ResolveTargetResult['origin']['daemonUrl'] = 'none';
  const envDaemon = env.ONEMEMORY_DAEMON_URL;
  if (envDaemon !== undefined && /^https?:\/\//.test(envDaemon)) {
    daemonUrl = envDaemon.replace(/\/+$/, '');
    daemonOrigin = 'env';
  } else if (configDir !== null) {
    const lock = readDaemonLock(configDir);
    if (lock !== null && isProcessAlive(lock.pid)) {
      daemonUrl = lock.url.replace(/\/+$/, '');
      daemonOrigin = 'daemon-lock';
    }
  }

  return {
    configDir,
    projectId,
    daemonUrl,
    origin: { projectId: projectOrigin, daemonUrl: daemonOrigin },
  };
}

// ---------------------------------------------------------------------------
// Transcript delta state (the ONLY thing the adapter persists — uuids, never content)
// ---------------------------------------------------------------------------

/** `&lt;configDir&gt;/adapters/claude.json` — per-session transcript cursors. */
export const ADAPTER_STATE_RELPATH = 'adapters/claude.json';

export const HookStateSchema = z.strictObject({
  version: z.literal(1).default(1),
  sessions: z.record(z.string(), z.strictObject({ last_transcript_uuid: z.string().min(1).nullable() })),
});
export type HookState = z.infer<typeof HookStateSchema>;

export function readHookState(configDir: string): HookState {
  try {
    const parsed = HookStateSchema.safeParse(
      JSON.parse(readFileSync(join(configDir, ADAPTER_STATE_RELPATH), 'utf8')),
    );
    return parsed.success ? parsed.data : { version: 1, sessions: {} };
  } catch {
    return { version: 1, sessions: {} };
  }
}

/** Write the state file (best-effort — a failed write only costs re-delivery, deduped upstream). */
export function writeHookState(configDir: string, state: HookState): boolean {
  try {
    const path = join(configDir, ADAPTER_STATE_RELPATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify({ ...state, version: 1 }, null, 2)}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}
