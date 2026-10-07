/**
 * Daemon discovery: `.onememory/daemon.json` plus a health probe — the ONE owner check for
 * embedded storage (ADR-0002 — concurrent PGlite processes in one data dir are unsafe).
 *
 * The implementation moved to `@onememory-ai/config` (`daemon-lock.ts`) so the standalone
 * `onemem-mcp` stdio bin can share the exact lock schema + probe semantics without importing an
 * app (packages never depend on apps — the shared wire-format home owns `project.json` and now
 * `daemon.json`). This module is a signature-preserving re-export shim: every export below keeps
 * its exact name and shape, so `daemon.ts`, `composition.ts`, the CLI and every existing test
 * keep working untouched. `DaemonProbe` is re-declared (not re-exported) so its `health` field
 * stays the runtime's own `HealthReport` type — structurally identical to the shared
 * `DaemonHealthReport`, which is what makes the delegation type-safe without a cast.
 */

import { probeDaemon as probeDaemonShared, type DaemonLock as SharedDaemonLock } from '@onememory-ai/config';

import type { HealthReport } from './types';

export {
  DAEMON_LOCK_FILE_NAME,
  DaemonLockSchema,
  clearDaemonLock,
  daemonLockPath,
  isLoopbackHost,
  isProcessAlive,
  readDaemonLock,
  writeDaemonLock,
} from '@onememory-ai/config';

export type { DaemonLock, DaemonHealthReport } from '@onememory-ai/config';

export interface DaemonProbe {
  lock: SharedDaemonLock;
  /** `null` when the pid is alive but the HTTP probe failed. */
  health: HealthReport | null;
  pid_alive: boolean;
  /** Set when the probe failed (no HTTP answer, timeout, or a wrong process on the port). */
  problem?: string;
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
  return probeDaemonShared(configDir, options);
}
