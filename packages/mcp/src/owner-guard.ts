/**
 * The embedded-storage owner guard for the standalone stdio bin (ADR-0002 + the ADR-0010
 * amendment of 2026-10-04, backlog cross-follow-up #5).
 *
 * ADR-0002 gives embedded (PGlite) storage exactly ONE owner process. `onemem serve` is that
 * owner; `onemem init` therefore scaffolds the daemon's HTTP `/mcp` endpoint for the embedded
 * profile and never scaffolds the standalone bin against the same data dir. But the bin itself
 * still accepts `ONEMEMORY_DATA_DIR`, so a hand-written or stale launch config could open a
 * SECOND PGlite owner on the same data directory — the exact hazard ADR-0002 forbids. This guard
 * runs before any storage is opened and refuses loudly, pointing at the running daemon's MCP
 * endpoint.
 *
 * Semantics (the shared `probeDaemon` from `@onememory-ai/config`):
 * - no lock → proceed;
 * - stale lock (pid gone) → the lock is cleaned up, proceed;
 * - lock pid alive + health OK → refuse with the daemon's MCP endpoint;
 * - lock pid alive + health failing → STILL refuse (a wedged daemon still owns the data dir);
 *   the message says so instead of pretending the daemon is usable.
 *
 * Lock location: the daemon writes `daemon.json` into its config dir, and the bin's data dir is
 * either that config dir itself (the common `<project>/.onememory` default) or its `data/`
 * child (the daemon's `storage.data_dir` default) — `daemonLockCandidateDirs` covers both. A
 * live lock in either place means a daemon was started from this tree, so refusing is the safe
 * direction; there is no escape hatch because a guard you can silence is a data-corruption
 * footgun. Server-profile storage (`ONEMEMORY_PG_URL`) is the supported multi-process path and
 * is not guarded at all (multi-process Postgres is safe).
 */

import { isAbsolute, resolve } from 'node:path';

import { daemonLockCandidateDirs, daemonLockPath, probeDaemon } from '@onememory-ai/config';

export interface EmbeddedOwnerGuardOptions {
  /** Working directory for relative data dirs (default: `process.cwd()` — the launch dir). */
  cwd?: string;
  /** Health-probe timeout per candidate config dir (default: `probeDaemon`'s 2000ms). */
  timeoutMs?: number;
  /** Injectable fetch (tests); default: `globalThis.fetch`. */
  fetch?: typeof fetch;
}

/** Why the guard refused, machine-readable (the message carries the same facts for the operator). */
export interface EmbeddedOwnerRefusal {
  /** The resolved absolute embedded data dir the bin was about to open. */
  dataDir: string;
  /** The `daemon.json` whose live pid pinned the owner. */
  lockPath: string;
  /** The daemon's pid from the lock. */
  daemonPid: number;
  /** The daemon's REST root (`http://host:port`). */
  daemonUrl: string;
  /** The daemon's MCP endpoint (`<daemonUrl>/mcp`) — what the refusal points the user at. */
  daemonMcpUrl: string;
  /** `true` when the pid is alive but the health probe failed (wedged or still starting). */
  wedged: boolean;
  /** The probe failure reason when `wedged`. */
  problem?: string;
}

export class EmbeddedStorageOwnerError extends Error {
  readonly refusal: EmbeddedOwnerRefusal;

  constructor(refusal: EmbeddedOwnerRefusal) {
    super(refusalMessage(refusal));
    this.name = 'EmbeddedStorageOwnerError';
    this.refusal = refusal;
  }
}

function refusalMessage(refusal: EmbeddedOwnerRefusal): string {
  const why =
    refusal.wedged
      ? `the onememory daemon process (pid ${refusal.daemonPid}) is alive but its health probe failed${
          refusal.problem === undefined ? '' : `: ${refusal.problem}`
        }; it may be wedged or still starting up, but it still owns this data directory`
      : `the onememory daemon (pid ${refusal.daemonPid}) is already running and owns this data directory`;
  return [
    `refusing to open embedded storage at ${refusal.dataDir}: ${why} (ADR-0002: exactly one owner process per data dir).`,
    `Connect your agent to the daemon's MCP endpoint at ${refusal.daemonMcpUrl} instead (re-run 'onemem init' to scaffold that),`,
    `or stop the daemon (${refusal.daemonUrl}) before starting a standalone stdio server.`,
    `Server-profile storage (ONEMEMORY_PG_URL) is the supported multi-process path.`,
  ].join(' ');
}

/**
 * Refuse loudly when a daemon owns the embedded data dir the stdio bin is about to open.
 *
 * @throws EmbeddedStorageOwnerError when a live-pid `daemon.json` is found in either candidate
 *   config dir (healthy OR wedged daemon). Stale locks are cleaned up by the probe; the guard
 *   then proceeds.
 */
export async function assertNoEmbeddedOwner(
  dataDir: string,
  options: EmbeddedOwnerGuardOptions = {},
): Promise<void> {
  const resolved = isAbsolute(dataDir) ? dataDir : resolve(options.cwd ?? process.cwd(), dataDir);
  for (const configDir of daemonLockCandidateDirs(resolved)) {
    const probe = await probeDaemon(configDir, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    if (probe === null) continue;
    throw new EmbeddedStorageOwnerError({
      dataDir: resolved,
      lockPath: daemonLockPath(configDir),
      daemonPid: probe.lock.pid,
      daemonUrl: probe.lock.url,
      daemonMcpUrl: `${probe.lock.url}/mcp`,
      wedged: probe.health === null,
      ...(probe.problem === undefined ? {} : { problem: probe.problem }),
    });
  }
}
