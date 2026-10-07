/**
 * Fail-soft delivery to the onememory daemon (mission-13's public REST surface) — the same
 * contract as `@onememory-ai/adapter-codex/src/delivery.ts` (mission 7), which this mirrors: the agent
 * is NEVER blocked and NEVER failed. No daemon, a dead daemon, a timeout, or a malformed response
 * all produce `{ok: false}` + a diagnostic; the extension logs one line and moves on.
 *
 * Discovery order (mirrors the CLI's `resolveBackend` seam):
 *   1. `ONEMEMORY_DAEMON_URL` + `ONEMEMORY_PROJECT_ID` env overrides,
 *   2. `@onememory-ai/config` discovery (nearest `.onememory/onememory.yaml` walking up) →
 *      `.onememory/project.json` (project id) + `.onememory/daemon.json` (daemon url; the
 *      documented v1 lock format written by `onemem serve`).
 *
 * The adapter reads the lock FILE format (a documented, stable pointer) rather than importing
 * `@onememory-ai/api/runtime` — that package is the composition root (storage, extraction, llm,
 * embeddings) and an adapter must not depend on engine internals (repository-structure.md rule 2).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { z } from 'zod';

import { ConfigError, ConfigNotFoundError, loadConfig } from '@onememory-ai/config';
import type { OnememoryEvent } from '@onememory-ai/core';

/** `IngestRequest.events` caps a batch at 500 (apps/api server schema). */
export const MAX_EVENTS_PER_REQUEST = 500;

/** Bounded by design: extension handlers must never stall the session (Pi awaits handlers). */
export const DEFAULT_DELIVERY_TIMEOUT_MS = 2_500;
export const DEFAULT_CONTEXT_TIMEOUT_MS = 2_000;

/** The documented v1 daemon lock (mirror of `apps/api` `DaemonLockSchema` — same file contract). */
export const DaemonLockSchema = z.looseObject({
  version: z.literal(1).default(1),
  pid: z.number().int().min(1),
  host: z.string(),
  port: z.number().int().min(1).max(65_535),
  url: z.string().min(1),
  started_at: z.string(),
  version_string: z.string(),
});
export type DaemonLock = z.infer<typeof DaemonLockSchema>;

const IngestResponseSchema = z.looseObject({
  outcomes: z
    .array(
      z.looseObject({
        index: z.number().int(),
        status: z.enum(['stored', 'duplicate', 'excluded', 'dead-letter']),
        event_id: z.string().optional(),
        duplicate_of: z.string().optional(),
        reason: z.string().optional(),
      }),
    )
    .default([]),
  stored: z.number().int(),
  duplicates: z.number().int(),
  excluded: z.number().int(),
  dead_lettered: z.number().int(),
  normalize_job_id: z.string().nullable(),
  warnings: z.array(z.string()).default([]),
});
export type IngestResponse = z.infer<typeof IngestResponseSchema>;

const SessionContextResponseSchema = z.looseObject({
  project_id: z.string(),
  budget: z.number().int(),
  used: z.number().int(),
  text: z.string(),
  warnings: z.array(z.string()).default([]),
});
export type SessionContextResponse = z.infer<typeof SessionContextResponseSchema>;

export type DeliveryFailureCode =
  | 'no-config'
  | 'no-project'
  | 'no-daemon'
  | 'stale-lock'
  | 'timeout'
  | 'unreachable'
  | 'http-error'
  | 'bad-response';

export type DeliveryResult =
  | { ok: true; response: IngestResponse }
  | { ok: false; code: DeliveryFailureCode; message: string };

export type ContextResult =
  | { ok: true; context: SessionContextResponse }
  | { ok: false; code: DeliveryFailureCode; message: string };

export interface CaptureTarget {
  daemonUrl: string;
  projectId: string;
  configDir: string | null;
  /** How the target was found — the diagnostic names it. */
  origin: 'env' | 'lock';
}

export interface DiscoveryOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  /** Injectable for tests. */
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Resolve where captured events go. Never throws — a missing project is a `{ok:false}` outcome
 * with a remediation message, not a crash (fail-soft).
 */
export async function discoverCaptureTarget(
  options: DiscoveryOptions = {},
): Promise<
  | { ok: true; target: CaptureTarget }
  | { ok: false; code: 'no-config' | 'no-project' | 'no-daemon' | 'stale-lock'; message: string }
> {
  const env = options.env ?? process.env;
  const daemonUrlEnv = env['ONEMEMORY_DAEMON_URL'];
  const projectIdEnv = env['ONEMEMORY_PROJECT_ID'];

  if (daemonUrlEnv !== undefined && daemonUrlEnv !== '' && projectIdEnv !== undefined && projectIdEnv !== '') {
    return {
      ok: true,
      target: {
        daemonUrl: daemonUrlEnv.replace(/\/+$/, ''),
        projectId: projectIdEnv,
        configDir: null,
        origin: 'env',
      },
    };
  }

  let configDir: string;
  let projectId: string | null;
  try {
    const loaded = loadConfig({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
    });
    configDir = loaded.paths.config_dir;
    projectId = loaded.project_state === null ? null : loaded.project_state.project_id;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof ConfigNotFoundError) {
      return {
        ok: false,
        code: 'no-config',
        message: `no onememory config found for this directory — run 'onemem init' (or set ONEMEMORY_DAEMON_URL and ONEMEMORY_PROJECT_ID): ${error.message}`,
      };
    }
    return {
      ok: false,
      code: 'no-config',
      message: `onememory config could not be loaded: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (projectId === null) {
    return {
      ok: false,
      code: 'no-project',
      message: `no project registered in ${join(configDir, 'project.json')} — run 'onemem init'`,
    };
  }

  const lock = readDaemonLock(configDir);
  if (lock === null) {
    return {
      ok: false,
      code: 'no-daemon',
      message: `no daemon is running (${join(configDir, 'daemon.json')} absent) — start one with 'onemem serve'; capture is a no-op until then`,
    };
  }

  const alive = (options.isProcessAlive ?? isProcessAlive)(lock.pid);
  if (!alive) {
    return {
      ok: false,
      code: 'stale-lock',
      message: `daemon lock ${join(configDir, 'daemon.json')} references pid ${lock.pid}, which is not running — start the daemon with 'onemem serve'`,
    };
  }

  return {
    ok: true,
    target: { daemonUrl: lock.url.replace(/\/+$/, ''), projectId, configDir, origin: 'lock' },
  };
}

/** Read `.onememory/daemon.json`; `null` when absent or unreadable (never throws). */
export function readDaemonLock(configDir: string): DaemonLock | null {
  const path = join(configDir, 'daemon.json');
  if (!existsSync(path)) return null;
  try {
    const parsed = DaemonLockSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Signal-0 liveness probe (same technique as the CLI's lock check). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === 'EPERM';
  }
}

export interface DeliverOptions {
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  fetch?: typeof fetch;
  isProcessAlive?: (pid: number) => boolean;
}

/**
 * Deliver events to `POST /v1/projects/{id}/events` in batches of ≤ 500.
 *
 * Fail-soft by contract: every failure mode (discovery, network, timeout, bad status, bad body)
 * is a `{ok:false}` result. Batches already delivered stay delivered; a mid-run failure is
 * reported with the partial progress in the message.
 */
export async function deliverEvents(
  events: OnememoryEvent[],
  options: DeliverOptions = {},
): Promise<DeliveryResult> {
  if (events.length === 0) return { ok: true, response: emptyIngestResponse() };

  const discovered = await discoverCaptureTarget(options);
  if (!discovered.ok) return { ok: false, code: discovered.code, message: discovered.message };
  const { daemonUrl, projectId } = discovered.target;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_DELIVERY_TIMEOUT_MS;

  let stored = 0;
  let duplicates = 0;
  let excluded = 0;
  let deadLettered = 0;
  const outcomes: IngestResponse['outcomes'] = [];
  const warnings: string[] = [];
  let normalizeJobId: string | null = null;

  for (let index = 0; index < events.length; index += MAX_EVENTS_PER_REQUEST) {
    const batch = events.slice(index, index + MAX_EVENTS_PER_REQUEST);
    const result = await postIngest(fetchImpl, daemonUrl, projectId, batch, timeoutMs);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        message:
          outcomes.length === 0
            ? result.message
            : `${result.message} (after ${outcomes.length} event(s) were already accepted)`,
      };
    }
    stored += result.response.stored;
    duplicates += result.response.duplicates;
    excluded += result.response.excluded;
    deadLettered += result.response.dead_lettered;
    outcomes.push(...result.response.outcomes);
    warnings.push(...result.response.warnings);
    if (result.response.normalize_job_id !== null) normalizeJobId = result.response.normalize_job_id;
  }

  return {
    ok: true,
    response: {
      outcomes,
      stored,
      duplicates,
      excluded,
      dead_lettered: deadLettered,
      normalize_job_id: normalizeJobId,
      warnings,
    },
  };
}

/**
 * Fetch the session-start context block from `GET /v1/projects/{id}/context` — the same
 * token-budgeted assembly the `memory_project_context` tool serves.
 */
export async function fetchSessionContext(
  options: DeliverOptions = {},
  query: { budget?: number; sessionId?: string } = {},
): Promise<ContextResult> {
  const discovered = await discoverCaptureTarget(options);
  if (!discovered.ok) return { ok: false, code: discovered.code, message: discovered.message };
  const { daemonUrl, projectId } = discovered.target;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CONTEXT_TIMEOUT_MS;
  const params = new URLSearchParams();
  if (query.budget !== undefined) params.set('budget', String(query.budget));
  if (query.sessionId !== undefined) params.set('session_id', query.sessionId);
  const suffix = params.size > 0 ? `?${params.toString()}` : '';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${daemonUrl}/v1/projects/${encodeURIComponent(projectId)}/context${suffix}`, {
      signal: controller.signal,
    });
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      message: `cannot reach the onememory daemon at ${daemonUrl}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    return {
      ok: false,
      code: 'http-error',
      message: `session context request failed with status ${response.status}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, code: 'bad-response', message: 'session context response was not JSON' };
  }
  const parsed = SessionContextResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'bad-response',
      message: 'session context response did not match the published schema',
    };
  }
  return { ok: true, context: parsed.data };
}

async function postIngest(
  fetchImpl: typeof fetch,
  daemonUrl: string,
  projectId: string,
  events: OnememoryEvent[],
  timeoutMs: number,
): Promise<DeliveryResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetchImpl(`${daemonUrl}/v1/projects/${encodeURIComponent(projectId)}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ events }),
      signal: controller.signal,
    });
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      code: aborted ? 'timeout' : 'unreachable',
      message: aborted
        ? `the onememory daemon at ${daemonUrl} did not accept the events within ${timeoutMs}ms`
        : `cannot reach the onememory daemon at ${daemonUrl}: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = '';
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? '';
    } catch {
      detail = '';
    }
    return {
      ok: false,
      code: 'http-error',
      message: `event ingest failed with status ${response.status}${detail === '' ? '' : `: ${detail}`}`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return { ok: false, code: 'bad-response', message: 'event ingest response was not JSON' };
  }
  const parsed = IngestResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'bad-response',
      message: 'event ingest response did not match the published schema',
    };
  }
  return { ok: true, response: parsed.data };
}

function emptyIngestResponse(): IngestResponse {
  return {
    outcomes: [],
    stored: 0,
    duplicates: 0,
    excluded: 0,
    dead_lettered: 0,
    normalize_job_id: null,
    warnings: [],
  };
}
