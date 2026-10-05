/**
 * Hook-side runtime support: where is this project's onememory state, which project is it, is a
 * daemon answering, and how do we talk to it — plus the session-start context fetch.
 *
 * Wire formats (deliberate re-declaration — the same call as `@onememory/adapter-claude`): the
 * readers are tiny strict schemas pinned to the formats owned by `@onememory/config`
 * (`.onememory/project.json`) and `@onememory/api` (`.onememory/daemon.json`). The hook binary
 * must spawn in milliseconds on EVERY tool call, so it depends on `@onememory/core` only
 * (importing the config/api packages would pull the router, yaml, and composition graphs into each
 * spawn). Both formats are stable cross-process wire records.
 *
 * Delivery is fail-soft everywhere: a timeout, a dead daemon, or a non-2xx response resolves to a
 * failure result — the caller prints one stderr line and exits 0 (a hook must never block or fail
 * the agent).
 *
 * Duplication note (mission-8): this file mirrors claude/src/{discovery,deliver,context}.ts. A
 * shared adapter runtime kit is a coordinator-level refactor (adapters may not import each other);
 * recorded as a follow-up in the mission report.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

/** `.onememory/project.json` — the pointer `onemem init` writes. */
export const ProjectStateSchema = z.strictObject({
  version: z.literal(1).default(1),
  project_id: z.uuid(),
  name: z.string().min(1),
  root_path: z.string().min(1),
  git_remote: z.string().min(1).optional(),
  created_at: z.iso.datetime(),
});
export type ProjectState = z.infer<typeof ProjectStateSchema>;

/** `.onememory/daemon.json` — the daemon lock. */
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

/** Walk up from `startDirs` looking for the nearest `.onememory/project.json` (git-style discovery). */
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
  configDir: string | null;
  projectId: string | null;
  daemonUrl: string | null;
  origin: {
    projectId: 'env' | 'project-state' | 'unresolved';
    daemonUrl: 'env' | 'daemon-lock' | 'none';
  };
}

export interface ResolveTargetOptions {
  /** Hook input `workspace_roots[0]` (first preference — the session's workspace root). */
  inputCwd?: string;
  env?: Record<string, string | undefined>;
}

/**
 * Resolve the delivery target for one hook invocation. Environment overrides win; then the nearest
 * `.onememory/project.json` walking up from the workspace root (the same git-style discovery
 * `onemem` commands use); the daemon URL comes from the lock file and its pid is liveness-checked
 * so we never spend the timeout budget on a dead process.
 */
export function resolveHookTarget(options: ResolveTargetOptions = {}): ResolveTargetResult {
  const env = options.env ?? {};
  const configDir = findOnememoryDir([options.inputCwd, env.CURSOR_PROJECT_DIR, env.CLAUDE_PROJECT_DIR, process.cwd()]);

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

  return { configDir, projectId, daemonUrl, origin: { projectId: projectOrigin, daemonUrl: daemonOrigin } };
}

// ---------------------------------------------------------------------------
// Delivery (fail-soft daemon REST client)
// ---------------------------------------------------------------------------

export interface DaemonTarget {
  /** Daemon base URL (no trailing slash), e.g. `http://127.0.0.1:7331`. */
  url: string;
  /** Project id (the ingest endpoint's path project is authoritative server-side too). */
  projectId: string;
}

export interface DeliverSummary {
  stored: number;
  duplicates: number;
  excluded: number;
  deadLettered: number;
  warnings: string[];
}

export interface DeliverResult extends DeliverSummary {
  delivered: boolean;
  error?: string;
}

export interface DeliverOptions {
  /** Hard per-request cap (default 1000ms — hooks must never block the agent). */
  timeoutMs?: number;
  /** Injectable fetch (tests drive a fake daemon). */
  fetch?: typeof fetch;
}

/** The hook budget: one second per request, bounded, no retries (fail-soft wins over blocking). */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 1000;

export async function deliverEvents(
  target: DaemonTarget,
  events: readonly unknown[],
  options: DeliverOptions = {},
): Promise<DeliverResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = `${target.url}/v1/projects/${encodeURIComponent(target.projectId)}/events`;
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        delivered: false,
        stored: 0,
        duplicates: 0,
        excluded: 0,
        deadLettered: 0,
        warnings: [],
        error: `POST ${target.url} returned status ${response.status}`,
      };
    }
    const payload = (await response.json()) as Partial<DeliverSummary> & { dead_lettered?: number };
    return {
      delivered: true,
      stored: numberOrZero(payload.stored),
      duplicates: numberOrZero(payload.duplicates),
      excluded: numberOrZero(payload.excluded),
      deadLettered: numberOrZero(payload.dead_lettered ?? payload.deadLettered),
      warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
    };
  } catch (error) {
    return {
      delivered: false,
      stored: 0,
      duplicates: 0,
      excluded: 0,
      deadLettered: 0,
      warnings: [],
      error: `cannot reach the onememory daemon at ${target.url}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function numberOrZero(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

// ---------------------------------------------------------------------------
// Session-start context (ADR-0010 §6: injection beats polling)
// ---------------------------------------------------------------------------

/** Matches the daemon's session-context default (retrieval `sessionContext.budget` default 750). */
export const DEFAULT_CONTEXT_BUDGET = 750;
/**
 * onememory's own bound on the injected string. Cursor's hooks reference does NOT document a
 * `additional_context` size limit (unlike Claude Code's 10,000-char cap), so this is OUR ceiling,
 * chosen to match the Claude adapter's: the daemon budget already bounds the text far below it.
 */
export const ADDITIONAL_CONTEXT_MAX = 10_000;
/** Hard per-request cap for the context fetch. */
export const CONTEXT_FETCH_TIMEOUT_MS = 1500;
/** Server-side cap (ContextQuerySchema: budget min 1 max 100_000). */
export const MAX_CONTEXT_BUDGET = 4000;

export interface SessionContextResponse {
  project_id: string;
  budget: number;
  used: number;
  text: string;
  sections: Array<{ kind: string; tokens: number; text: string }>;
  warnings: string[];
}

export interface FetchContextResult {
  ok: boolean;
  context?: SessionContextResponse;
  error?: string;
}

export function contextBudgetFromEnv(env: Record<string, string | undefined>): number {
  const raw = env.ONEMEMORY_CONTEXT_BUDGET;
  if (raw === undefined || raw === '') return DEFAULT_CONTEXT_BUDGET;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONTEXT_BUDGET) return DEFAULT_CONTEXT_BUDGET;
  return parsed;
}

export async function fetchSessionContext(
  target: DaemonTarget,
  budget: number,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<FetchContextResult> {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? CONTEXT_FETCH_TIMEOUT_MS);
  const url = `${target.url}/v1/projects/${encodeURIComponent(target.projectId)}/context?budget=${budget}`;
  try {
    const response = await fetchImpl(url, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, error: `context endpoint returned status ${response.status}` };
    }
    const payload = (await response.json()) as Partial<SessionContextResponse>;
    if (typeof payload.text !== 'string') {
      return { ok: false, error: 'context response carried no text' };
    }
    return {
      ok: true,
      context: {
        project_id: typeof payload.project_id === 'string' ? payload.project_id : target.projectId,
        budget: typeof payload.budget === 'number' ? payload.budget : budget,
        used: typeof payload.used === 'number' ? payload.used : 0,
        text: payload.text,
        sections: Array.isArray(payload.sections)
          ? payload.sections.map((section) => ({
              kind: String(section?.kind ?? ''),
              tokens: Number(section?.tokens ?? 0),
              text: String(section?.text ?? ''),
            }))
          : [],
        warnings: Array.isArray(payload.warnings) ? payload.warnings.map(String) : [],
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `cannot reach the onememory daemon: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the `sessionStart` hook's stdout JSON — the documented Cursor output contract
 * (`{"additional_context": "…"}`; Cursor's hooks reference: "additional_context | string
 * (optional) | Additional context to add to the conversation's initial system context").
 * Exactly one JSON object, no surrounding text.
 */
export function additionalContextOutput(text: string): string {
  return JSON.stringify({ additional_context: text });
}

/** Cap to onememory's own ceiling, reporting the cut honestly. */
export function capAdditionalContext(text: string): { text: string; capped: boolean } {
  if (text.length <= ADDITIONAL_CONTEXT_MAX) return { text, capped: false };
  return { text: text.slice(0, ADDITIONAL_CONTEXT_MAX), capped: true };
}

// ---------------------------------------------------------------------------
// Diagnostics
// ---------------------------------------------------------------------------

export interface DiagRecord {
  /** Hook event name (when the payload parsed). */
  event?: string;
  /** What the hook did: delivered | skipped | failed | no_events. */
  outcome: 'delivered' | 'skipped' | 'failed' | 'no_events';
  /** Stable reason code for skipped/failed. */
  reason?: string;
  [key: string]: unknown;
}

export interface DiagSink {
  write(text: string): void;
}

const stderrSink: DiagSink = { write: (text) => process.stderr.write(text) };

/**
 * Emit ONE machine-readable stderr line. Cursor logs hook stderr and shows it in the Hooks output
 * channel, so stderr is exactly where bounded diagnostics belong; it never carries payload
 * contents (command text, prompts, error strings) — those stay inside the delivered events.
 */
export function emitDiag(record: DiagRecord, sink: DiagSink = stderrSink): void {
  const line = JSON.stringify({
    v: 1,
    ts: new Date().toISOString(),
    component: 'onemem-cursor-hook',
    ...record,
  });
  try {
    sink.write(`${line}\n`);
  } catch {
    // Swallow: diagnostics are best-effort by definition.
  }
}
