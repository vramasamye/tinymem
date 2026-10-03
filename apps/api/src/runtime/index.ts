/**
 * The runtime public surface: what `apps/cli` (and later `packages/mcp`) imports.
 *
 * `apps/api` owns this because the API server *is* the composition root's host process; the CLI
 * imports it as `@onememory/api/runtime` rather than duplicating wiring. See the M13 report for the
 * alternative (a dedicated `packages/sdk`) and why it was not created in this mission.
 */

export {
  openRuntime,
  openStorage,
  createRuntimeHandlers,
  type OnememoryRuntime,
  type OpenRuntimeOptions,
  type RuntimeDegradation,
  type RuntimeHandlerDeps,
  type RuntimeHandlers,
} from './composition';

export { createEmbedder, type EmbedderFactoryOptions } from './embedder';

export {
  inspectRuntime,
  failedDoctorReport,
  type DoctorCheck,
  type DoctorCheckStatus,
  type DoctorOptions,
  type DoctorReport,
} from './doctor';

export { computeStats, type StatsOptions } from './stats';

export {
  forgetMemory,
  ingestEvents,
  inspectMemory,
  listProjectMemories,
  localUser,
  rememberMemory,
  requireProject,
  restoreMemory,
  searchMemories,
  sessionContext,
  typedMemoryList,
  type ForgetOptions,
  type RememberOptions,
} from './memory-service';

export { createLocalBackend, requireProjectId, type LocalBackendOptions } from './local-backend';

export { createHttpBackend, type HttpBackendOptions } from './http-backend';

export {
  DAEMON_LOCK_FILE_NAME,
  DaemonLockSchema,
  clearDaemonLock,
  daemonLockPath,
  isLoopbackHost,
  isProcessAlive,
  probeDaemon,
  readDaemonLock,
  writeDaemonLock,
  type DaemonLock,
  type DaemonProbe,
} from './lock';

export { startDaemon, type DaemonHandle, type ServeInfo, type ServeOptions } from './daemon';

export {
  BackendError,
  type BackendErrorCode,
  type ContextOptions,
  type CreateProjectInput,
  type ForgetInput,
  type ForgetOutcome,
  type HealthReport,
  type IngestOutcome,
  type IngestOutcomeStatus,
  type IngestResult,
  type InspectResult,
  type ListOptions,
  type OnememoryBackend,
  type ProjectListResult,
  type PurgeInput,
  type PurgeOutcome,
  type RememberInput,
  type RememberOutcome,
  type StatsResult,
} from './types';

export { ONEMEMORY_VERSION } from './version';
