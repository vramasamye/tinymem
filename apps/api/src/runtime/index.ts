/**
 * The runtime public surface: what `apps/cli` (and later `packages/mcp`) imports.
 *
 * `apps/api` owns this because the API server *is* the composition root's host process; the CLI
 * imports it as `@onememory-ai/api/runtime` rather than duplicating wiring. See the M13 report for the
 * alternative (a dedicated `packages/sdk`) and why it was not created in this mission.
 */

export {
  openRuntime,
  openStorage,
  createRuntimeHandlers,
  DEFAULT_DRIFT_SCAN_INTERVAL_MS,
  type CodeMemoryRuntimeInfo,
  type ConsolidationRuntimeInfo,
  type OnememoryRuntime,
  type OpenRuntimeOptions,
  type RuntimeDegradation,
  type RuntimeHandlerDeps,
  type RuntimeHandlers,
} from './composition';

export { createEmbedder, type EmbedderFactoryOptions } from './embedder';

export {
  createConsolidationOrchestration,
  createConsolidationScheduler,
  DECAY_STAGES,
  DEFAULT_CONSOLIDATE_INTERVAL_MS,
  type ConsolidationOrchestration,
  type ConsolidationOrchestrationOptions,
  type ConsolidationRunInput,
  type ConsolidationStatus,
} from './consolidation';

export {
  codeMemoryCheck,
  finalizeDoctorReport,
  inspectRuntime,
  failedDoctorReport,
  type DoctorCheck,
  type DoctorCheckStatus,
  type DoctorDraft,
  type DoctorOptions,
  type DoctorReport,
} from './doctor';

export {
  daemonMcpUrl,
  DAEMON_MCP_PATH,
  RUNTIME_AGENT_IDS,
  evaluateRuntimeScaffold,
  runtimeScaffoldChecks,
  type RuntimeCheckContext,
  type RuntimeScaffoldState,
  type WiredRuntime,
} from './runtime-scaffolds';

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

export {
  deprecateSkill,
  listProjectSkills,
  promoteSkill,
  reviewSkill,
  summarizeSkill,
} from './skills-service';

export {
  exportProject,
  type ExportProjectInput,
  type ExportProjectReport,
} from './export-service';

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
  type ConsolidateInput,
  type ConsolidateKind,
  type ConsolidateOutcome,
  type ContextOptions,
  type CreateProjectInput,
  type DeprecateSkillInput,
  type DeprecateSkillResult,
  type ForgetInput,
  type ForgetOutcome,
  type HealthReport,
  type IngestOutcome,
  type IngestOutcomeStatus,
  type IngestResult,
  type InspectResult,
  type ListOptions,
  type PromoteSkillInput,
  type PromoteSkillResult,
  type SkillListResult,
  type SkillReviewResult,
  type SkillSummary,
  DEFAULT_MEMORY_PAGE_SIZE,
  MAX_MEMORY_PAGE_SIZE,
  MEMORY_PAGE_INCLUDE,
  type MemoryPageInclude,
  type MemoryPageOptions,
  type MemoryPageResult,
  type OnememoryBackend,
  type ProjectListResult,
  type PurgeInput,
  type PurgeOutcome,
  type RememberInput,
  type RememberOutcome,
  type StatsResult,
} from './types';

export { ONEMEMORY_VERSION } from './version';
