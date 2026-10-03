/**
 * Backend resolution: the single decision every CLI command makes first.
 *
 * ADR-0002 — embedded storage has exactly one owner process. If a daemon answers on this
 * project's config dir (probed via the lock file, never guessed), commands run over its REST API
 * and never touch the data directory. If not, the CLI opens the composition root itself, without
 * the job worker: a short-lived CLI process is not a job host, and `onemem doctor` says so
 * (queued `normalize`/`extract` jobs drain once `onemem serve` runs).
 */

import { ConfigError, ConfigNotFoundError, loadConfig, type LoadedConfig } from '@onememory/config';
import {
  BackendError,
  createHttpBackend,
  createLocalBackend,
  openRuntime,
  probeDaemon,
  type OnememoryBackend,
} from '@onememory/api/runtime';

export interface ResolveOptions {
  cwd?: string;
  /** `--config`; `null` means "explicitly no file" (built-in defaults). */
  configPath?: string | null;
  env?: Record<string, string | undefined>;
  /** `--project <id>` override. */
  projectId?: string;
}

export interface Resolved {
  backend: OnememoryBackend;
  /** How the commands are running. */
  mode: 'daemon' | 'local';
  /** The daemon's URL in daemon mode, `null` in local mode. */
  daemonUrl: string | null;
  /** This process's view of the config (paths + project pointer), even in daemon mode. */
  loaded: LoadedConfig;
  /** The project id the command operates on. */
  projectId: string;
}

export function describeResolution(resolved: Resolved): string {
  return resolved.mode === 'daemon'
    ? `daemon at ${resolved.daemonUrl} (jobs run there)`
    : 'direct mode (no daemon; the job worker is not running)';
}

/**
 * Resolve the backend and the project id for a command.
 *
 * @throws ConfigNotFoundError when no config file exists (the command layer turns this into the
 *   "run onemem init" message).
 * @throws BackendError when a project id cannot be resolved.
 */
export async function resolveBackend(options: ResolveOptions): Promise<Resolved> {
  const loaded = loadConfig({
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const daemonUrl = await findLiveDaemonUrl(loaded);

  let backend: OnememoryBackend;
  let mode: Resolved['mode'];
  if (daemonUrl !== null) {
    backend = createHttpBackend({ baseUrl: daemonUrl });
    mode = 'daemon';
  } else {
    const runtime = await openRuntime({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
      ...(options.env === undefined ? {} : { env: options.env }),
      startWorker: false,
    });
    backend = createLocalBackend(runtime, { adapter: 'cli', closeRuntime: true });
    mode = 'local';
  }

  const projectId = resolveProjectId(loaded, options.projectId);
  return { backend, mode, daemonUrl, loaded, projectId };
}

/** The daemon's URL when its lock file exists AND it answers a health probe. */
export async function findLiveDaemonUrl(loaded: LoadedConfig): Promise<string | null> {
  const probe = await probeDaemon(loaded.paths.config_dir);
  if (probe === null) return null;
  // `health === null` is the exact "not answering" criterion: `problem` is an optional field and
  // is absent (undefined) on a healthy probe — comparing it to null would flag every healthy
  // daemon as wedged.
  if (probe.health === null) {
    // The lock says a daemon owns this data dir but it is not answering. A local open would fight
    // a process that may be starting up or wedged — refuse, with the lock's last known state.
    throw new BackendError(
      `a daemon lock exists (${probe.lock.url}, pid ${probe.lock.pid}) but the daemon is not answering: ${
        probe.problem ?? 'no reason recorded'
      }. Remove ${loaded.paths.config_dir}/daemon.json if the process is gone, or start the daemon with 'onemem serve'`,
      'conflict',
    );
  }
  return probe.lock.url;
}

/** `--project` wins; then the registered pointer written by `onemem init`. */
export function resolveProjectId(loaded: LoadedConfig, override: string | undefined): string {
  if (override !== undefined && override !== '') return override;
  const state = loaded.project_state;
  if (state !== null) return state.project_id;
  throw new BackendError(
    `no project registered in ${loaded.paths.project_state_path} — run 'onemem init' or pass --project <id>`,
    'invalid_request',
  );
}

/** Render config errors as-is: already file-scoped, key-pathed and value-free (ConfigError.format). */
export function printConfigError(error: ConfigError, err: (text: string) => void): void {
  for (const line of error.message.split('\n')) err(line);
}

export { ConfigNotFoundError };
