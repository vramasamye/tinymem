/**
 * `onemem serve` — the daemon.
 *
 * One process owns embedded storage and runs both halves of the system: the REST server (loopback
 * by default) and the job worker (`normalize` → `extract` → `re_embed`, plus the M4f code-memory
 * jobs `drift_scan` → `reindex`). That is the only safe pairing for the embedded profile (ADR-0002),
 * and it is also what makes the write paths self-consistent: the ingest endpoint enqueues
 * `normalize`, and the same process has a worker that picks it up.
 *
 * The code-memory interval scheduler starts with the worker (see the composition root): it
 * periodically enqueues one `drift_scan` per registered repository, and each `drift_scan` chains a
 * `reindex` pass. Both are stopped before the worker drains so no new code-memory job is enqueued
 * while storage closes.
 *
 * Startup order is deliberate: config → daemon-lock check → storage/worker → HTTP bind → lock file
 * → self-check. Shutdown is the reverse, and the lock file is removed last so a crash never leaves
 * a *live* lock behind (a crashed process leaves a stale file, which `probeDaemon` detects by pid).
 */

import { loadConfig, type LoadedConfig } from '@onememory/config';
import { createOnememoryMcpContext, createOnememoryStreamableHttpHandler } from '@onememory/mcp';

import { createApiApp } from '../server/app';
import { openRuntime, type OnememoryRuntime, type OpenRuntimeOptions } from './composition';
import { createLocalBackend } from './local-backend';
import {
  clearDaemonLock,
  isLoopbackHost,
  probeDaemon,
  writeDaemonLock,
  type DaemonLock,
} from './lock';
import { BackendError, type OnememoryBackend } from './types';
import { ONEMEMORY_VERSION } from './version';

export interface ServeOptions extends Pick<OpenRuntimeOptions, 'cwd' | 'configPath' | 'env' | 'embedderFactory' | 'onWarning' | 'codeMemoryScheduler' | 'driftScanIntervalMs'> {
  /** Bind host; defaults to `daemon.host` (127.0.0.1). */
  host?: string;
  /** Bind port; defaults to `daemon.port`. `0` asks the OS for a free port (tests). */
  port?: number;
  /** Required to bind a non-loopback host (Phase 1 is local-only). */
  listenPublic?: boolean;
  /**
   * Fetch used for the startup daemon probe and the post-bind self-check. In a production serve
   * process no guard exists yet at probe time; an embedding host that already installed the
   * process-wide privacy guard must pass the pre-guard fetch so the probe can reach the daemon
   * it is checking on (the guard has no loopback allowance in Phase 1).
   */
  fetch?: typeof fetch;
  onReady?: (info: ServeInfo) => void;
  onLog?: (message: string) => void;
  /** Install SIGTERM/SIGINT handlers (default true; tests disable them). */
  installSignalHandlers?: boolean;
}

export interface ServeInfo {
  url: string;
  host: string;
  port: number;
  pid: number;
  config_path: string | null;
  data_dir: string;
  lock_path: string;
  registered_handlers: string[];
  warnings: string[];
}

export interface DaemonHandle {
  info: ServeInfo;
  runtime: OnememoryRuntime;
  backend: OnememoryBackend;
  /** Stop the server, drain the worker, close storage and remove the lock file. */
  stop(): Promise<void>;
}

function log(options: ServeOptions, message: string): void {
  if (options.onLog) options.onLog(message);
  else console.error(`onemem serve: ${message}`);
}

export async function startDaemon(options: ServeOptions = {}): Promise<DaemonHandle> {
  const loaded: LoadedConfig = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const host = options.host ?? loaded.config.daemon.host;
  const port = options.port ?? loaded.config.daemon.port;

  if (!isLoopbackHost(host) && options.listenPublic !== true) {
    throw new BackendError(
      `refusing to bind ${host}: Phase 1 is local-only and the REST API has no authentication — pass --listen-public to override deliberately`,
      'invalid_request',
    );
  }
  if (!isLoopbackHost(host)) {
    log(
      options,
      `WARNING: binding ${host} exposes onememory (and the memory contents it holds) beyond this machine. There is no authentication in Phase 1 — do not expose this to a untrusted network.`,
    );
  }

  const existing = await probeDaemon(loaded.paths.config_dir, {
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  if (existing !== null) {
    throw new BackendError(
      existing.problem ??
        `a daemon is already serving this project at ${existing.lock.url} (pid ${existing.lock.pid}); stop it or use the HTTP API instead of starting a second owner for the embedded data directory`,
      'conflict',
    );
  }

  const runtime = await openRuntime({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
    startWorker: true,
    ...(options.codeMemoryScheduler === undefined ? {} : { codeMemoryScheduler: options.codeMemoryScheduler }),
    ...(options.driftScanIntervalMs === undefined ? {} : { driftScanIntervalMs: options.driftScanIntervalMs }),
    ...(options.embedderFactory === undefined ? {} : { embedderFactory: options.embedderFactory }),
    onWarning: options.onWarning ?? ((message: string) => log(options, message)),
  });

  const backend = createLocalBackend(runtime, { adapter: 'api', closeRuntime: false });

  // The daemon's MCP surface (ADR-0010 amendment 2026-10-04): ONE context built from the same
  // runtime pieces — storage, retrieval engine (one result-cache domain with /v1), redaction
  // config, embedder. The stateless handler is created once at boot; every request gets a fresh
  // McpServer against this shared context (embedded profile: the daemon is the single owner).
  const mcpHandler = createOnememoryStreamableHttpHandler(
    await createOnememoryMcpContext({
      storage: runtime.storage,
      engine: runtime.engine,
      embedder: runtime.embedder === null ? undefined : runtime.embedder,
      redactor: runtime.redaction,
      // The registered project is the default scope over HTTP: agents reach /mcp with a URL only
      // (no env, no headers in Phase 1), so without this every project-scoped tool call would
      // demand an explicit project_id. An input project_id still wins per call.
      projectId: runtime.loaded.project_state?.project_id,
    }),
  );

  const app = createApiApp({
    backend,
    version: ONEMEMORY_VERSION,
    meta: { started_at: runtime.started_at, pid: process.pid },
    mcpHandler,
  });

  if (typeof Bun === 'undefined') {
    await runtime.close();
    throw new BackendError(
      'onemem serve requires the Bun runtime (Bun.serve); a Node adapter (@hono/node-server) is a follow-up — see the mission-13 report',
      'unavailable',
    );
  }

  const server = Bun.serve({ fetch: app.fetch, hostname: host, port });
  const boundPort = server.port ?? port;
  const url = `http://${host}:${boundPort}`;

  // Self-check through the app itself (no socket, so the privacy guard cannot interfere): a lock
  // file is only written once the process can actually answer a request.
  const selfCheck = await app.request('/v1/health');
  if (!selfCheck.ok) {
    await server.stop(true);
    await runtime.close();
    throw new BackendError(
      `the API failed its own health check (status ${selfCheck.status}); the daemon was not started`,
      'internal',
    );
  }

  const lock: DaemonLock = {
    version: 1,
    pid: process.pid,
    host,
    port: boundPort,
    url,
    started_at: new Date().toISOString(),
    version_string: ONEMEMORY_VERSION,
  };
  const lockPath = writeDaemonLock(loaded.paths.config_dir, lock);

  const info: ServeInfo = {
    url,
    host,
    port: boundPort,
    pid: process.pid,
    config_path: loaded.paths.config_path,
    data_dir: loaded.paths.data_dir,
    lock_path: lockPath,
    registered_handlers: runtime.registered_kinds,
    warnings: runtime.warnings,
  };

  let stopping = false;
  const signalHandlers: Array<[NodeJS.Signals, () => void]> = [];
  const removeSignalHandlers = (): void => {
    for (const [signal, handler] of signalHandlers) process.off(signal, handler);
    signalHandlers.length = 0;
  };

  async function stop(): Promise<void> {
    if (stopping) return;
    stopping = true;
    log(options, 'shutting down: stopping the worker, closing storage, removing the lock file');
    removeSignalHandlers();
    await runtime.stopWorker();
    try {
      await server.stop(true);
    } catch (error) {
      log(options, `server stop failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    try {
      await mcpHandler.close();
    } catch (error) {
      log(options, `mcp handler close failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    await runtime.close();
    clearDaemonLock(loaded.paths.config_dir);
  }

  if (options.installSignalHandlers !== false) {
    for (const signal of ['SIGTERM', 'SIGINT'] as const) {
      const handler = (): void => {
        void stop().then(
          () => process.exit(0),
          (error: unknown) => {
            log(options, `shutdown failed: ${error instanceof Error ? error.message : String(error)}`);
            process.exit(1);
          },
        );
      };
      process.on(signal, handler);
      signalHandlers.push([signal, handler]);
    }
  }

  options.onReady?.(info);
  return { info, runtime, backend, stop };
}
