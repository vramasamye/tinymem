/**
 * `@onememory/config` — discovery + strict Zod validation for `.onememory/onememory.yaml`
 * (AGENTS.md rule 4: the default install is 100% local).
 *
 * The package is deliberately I/O-light and component-free: it parses, validates, and *decides*
 * (which embedder, which vector binding, whether the network guard applies). Turning those
 * decisions into live objects is the composition root's job (`apps/api/src/runtime`), so doctor
 * and the daemon read the same decision from the same place.
 */

// Schema + vocabulary
export {
  CONFIG_VERSION,
  STORAGE_MODES,
  VECTOR_BACKENDS,
  EMBEDDING_PROVIDERS,
  NETWORK_GUARD_MODES,
  DEFAULT_OLLAMA_EMBED_BASE_URL,
  DEFAULT_OPENAI_COMPATIBLE_EMBED_BASE_URL,
  DEFAULT_DAEMON_PORT,
  DEFAULT_RETENTION_DAYS,
  DEFAULT_CONSOLIDATE_INTERVAL_MS,
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_SEARCH_MAX_TOKENS,
  ProjectSectionSchema,
  StorageSectionSchema,
  EmbeddingsSectionSchema,
  LlmProviderSectionSchema,
  LlmRouteSectionSchema,
  LlmDefaultsSectionSchema,
  LlmSectionSchema,
  DaemonSectionSchema,
  RedactionSectionSchema,
  SecuritySectionSchema,
  OnememoryConfigSchema,
  parseConfig,
  safeParseConfig,
  routerConfigFrom,
  type ConfigIssue,
  type OnememoryConfig,
  type OnememoryConfigInput,
  type ProjectSection,
  type StorageSection,
  type StorageMode,
  type VectorBackendSetting,
  type EmbeddingsSection,
  type EmbeddingProviderSetting,
  type LlmSection,
  type LlmProviderSection,
  type LlmRouteSection,
  type DaemonSection,
  type SecuritySection,
  type NetworkGuardMode,
} from './schema';

// Defaults + template
export {
  CONFIG_DIR_NAME,
  CONFIG_FILE_NAME,
  CONFIG_FILE_NAME_ALT,
  CONFIG_PATH_ENV,
  defaultConfigObject,
  renderDefaultConfigYaml,
  renderConfigForProject,
} from './defaults';

// Loading and discovery
export {
  findConfigFile,
  loadConfig,
  resolvePgUrl,
  configBaseDir,
  type LoadConfigOptions,
  type LoadedConfig,
  type ResolvedPaths,
  type EnvResolution,
} from './load';

// Project state (machine-managed pointer to the registered project row)
export {
  PROJECT_STATE_FILE_NAME,
  PROJECT_STATE_VERSION,
  ProjectStateSchema,
  projectStatePath,
  loadProjectState,
  saveProjectState,
  type ProjectState,
} from './project-state';

// Daemon lock + probe (`.onememory/daemon.json` — the embedded-storage single-owner check)
export {
  DAEMON_LOCK_FILE_NAME,
  DaemonLockSchema,
  daemonLockPath,
  readDaemonLock,
  writeDaemonLock,
  clearDaemonLock,
  isProcessAlive,
  daemonLockCandidateDirs,
  probeDaemon,
  isLoopbackHost,
  type DaemonLock,
  type DaemonHealthReport,
  type DaemonProbe,
} from './daemon-lock';

// Derived decisions
export {
  embedderSelection,
  vectorIndexBinding,
  networkGuardPlan,
  redactionOptions,
  exclusionGlobs,
  llmProfileSummary,
  configSummary,
  type EmbedderSelection,
  type VectorIndexBinding,
  type NetworkGuardPlan,
  type RedactionOptions,
  type LlmProfileSummary,
  type ConfigSummary,
} from './derive';

// Errors
export { ConfigError, ConfigNotFoundError } from './errors';
