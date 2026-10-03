/**
 * `onemem serve` — start the daemon (ADR-0002): the single process that owns embedded storage,
 * answers the REST API on loopback, and drains the `normalize → extract → re_embed` job queue.
 *
 * Everything hard (lock file, single-owner check, self-check before the lock is written, graceful
 * shutdown that drains the worker) lives in the runtime so the API and the CLI cannot disagree.
 */

import { startDaemon, type DaemonHandle } from '@onememory/api/runtime';
import type { Io } from '../io';

export interface ServeOptions {
  cwd?: string;
  configPath?: string | null;
  env?: Record<string, string | undefined>;
  host?: string;
  port?: number;
  /** Required to bind a non-loopback host. */
  listenPublic?: boolean;
}

export async function runServe(options: ServeOptions, io: Io): Promise<number> {
  const handle: DaemonHandle = await startDaemon({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.host === undefined ? {} : { host: options.host }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.listenPublic === undefined ? {} : { listenPublic: options.listenPublic }),
    onWarning: (message) => io.err(`warning: ${message}`),
  });
  const info = handle.info;
  io.emit(info);
  io.out(`onememory serving ${info.url} (pid ${info.pid})`);
  io.out(`  config: ${info.config_path ?? '(built-in defaults)'}`);
  io.out(`  data:   ${info.data_dir}`);
  io.out(`  worker: ${info.registered_handlers.join(', ')}`);
  io.out('  api:    GET /v1/health, /openapi.json (loopback; no authentication in Phase 1)');
  for (const warning of info.warnings) io.out(`  note:   ${warning}`);
  io.out('stop with Ctrl-C (SIGINT) — in-flight jobs finish, then the lock file is removed.');
  // Bun.serve keeps the process alive; stop() runs on SIGTERM/SIGINT (installed by startDaemon).
  void handle;
  return 0;
}
