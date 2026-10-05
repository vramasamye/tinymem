/**
 * Daemon discovery: `.onememory/daemon.json` plus a health probe — the ONE owner check for
 * embedded storage (ADR-0002: concurrent PGlite processes in one data dir are unsafe).
 *
 * This module is the shared home of the lock (moved from `apps/api/src/runtime/lock.ts`, which
 * is now a signature-preserving re-export shim): the daemon writes the lock, the CLI probes it
 * before opening storage, and the standalone `onemem-mcp` stdio bin probes it before opening
 * embedded storage — a package must never import an app, so the wire record lives with the other
 * cross-process formats (`project.json`) in `@onememory/config`.
 *
 * Why a file: the embedded database is single-owner (ADR-0002), so any process must know whether
 * a daemon already owns the data dir *before* it opens storage. The pid is a hint, not the truth:
 * liveness is re-checked (`kill(pid, 0)`) and then confirmed over HTTP (`GET /v1/health`). A stale
 * file is removed; a live process that does not answer is reported as such, never ignored.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import type { LlmProfileSummary } from './derive';

export const DAEMON_LOCK_FILE_NAME = 'daemon.json';

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

/**
 * The `GET /v1/health` payload, as the probe sees it. Structural twin of the runtime's
 * `HealthReport` (`apps/api/src/runtime/types.ts`) — same fields, same names — because the
 * daemon's HTTP surface, not this package, owns the document.
 */
export interface DaemonHealthReport {
  status: 'ok' | 'degraded' | 'failed';
  version: string;
  uptime_ms: number;
  pid: number;
  config_path: string | null;
  storage: { profile: 'embedded' | 'server'; vector_backend: string; vector_model: string; vector_dim: number };
  llm: LlmProfileSummary;
  embedder: { provider: string | null; model: string | null; dim: number | null };
  network_guard: { enforced: boolean; attempts: number; reason: string };
  warnings: string[];
}

export function daemonLockPath(configDir: string): string {
  return join(configDir, DAEMON_LOCK_FILE_NAME);
}

export function readDaemonLock(configDir: string): DaemonLock | null {
  const path = daemonLockPath(configDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = DaemonLockSchema.safeParse(JSON.parse(readFileSync(path, 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function writeDaemonLock(configDir: string, lock: DaemonLock): string {
  mkdirSync(dirname(daemonLockPath(configDir)), { recursive: true });
  const path = daemonLockPath(configDir);
  writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return path;
}

export function clearDaemonLock(configDir: string): void {
  const path = daemonLockPath(configDir);
  if (existsSync(path)) rmSync(path);
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

export interface DaemonProbe {
  lock: DaemonLock;
  /** `null` when the pid is alive but the HTTP probe failed. */
  health: DaemonHealthReport | null;
  pid_alive: boolean;
  /** Set when the probe failed (no HTTP answer, timeout, or a wrong process on the port). */
  problem?: string;
}

async function probeHealth(
  url: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<DaemonHealthReport> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${url}/v1/health`, { signal: controller.signal });
    if (!response.ok) throw new Error(`health returned ${response.status}`);
    return (await response.json()) as DaemonHealthReport;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Detect a running daemon for this project.
 *
 * - no lock file → `null` (the caller may own embedded storage);
 * - lock file whose pid is gone → stale: the file is removed and `null` is returned;
 * - lock file whose pid is alive but unresponsive → the probe is returned with `problem` set. The
 *   caller MUST NOT open embedded storage in that case (the process may be starting up or wedged).
 */
export async function probeDaemon(
  configDir: string,
  options: { timeoutMs?: number; fetch?: typeof fetch } = {},
): Promise<DaemonProbe | null> {
  const lock = readDaemonLock(configDir);
  if (lock === null) return null;

  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (!isProcessAlive(lock.pid)) {
    clearDaemonLock(configDir);
    return null;
  }

  try {
    const health = await probeHealth(lock.url, options.timeoutMs ?? 2000, fetchImpl);
    return { lock, health, pid_alive: true };
  } catch (error) {
    return {
      lock,
      health: null,
      pid_alive: true,
      problem: `pid ${lock.pid} is alive but ${lock.url}/v1/health did not answer: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

/**
 * The config dirs whose `daemon.json` may be the owner lock for an embedded `dataDir`.
 *
 * The daemon writes the lock into its config dir (`.onememory/`), and embedded data dirs appear
 * in exactly two real layouts: the standalone stdio bin's default (the data dir IS the `.onememory`
 * config dir, e.g. `ONEMEMORY_DATA_DIR=<project>/.onememory`) and the daemon's default
 * (`storage.data_dir: .onememory/data`, a child of the config dir that holds the lock). Probing
 * both — the data dir itself, then its parent — covers every supported configuration; a lock found
 * in either place belongs to a daemon started from that tree, so treating it as the owner is the
 * safe direction (refusing points at the running daemon; opening beside it risks a second PGlite
 * owner, exactly what ADR-0002 forbids).
 */
export function daemonLockCandidateDirs(dataDir: string): string[] {
  const parent = dirname(dataDir);
  return parent === dataDir ? [dataDir] : [dataDir, parent];
}

/** Loopback check for bind hosts (both the config default and `--host`). */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === 'localhost' || normalized === '::1') return true;
  if (normalized === '0.0.0.0' || normalized === '::' || normalized === '') return false;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalized);
}
