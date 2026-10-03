/**
 * `@onememory/adapter-claude` — the Claude Code adapter (ADR-0010 §6/§7).
 *
 * Public surface, grouped by consumer:
 * - Translation (pure): `translateHookInput` + the hook-input schemas — runtime-native hook
 *   payloads → validated OnememoryEvent envelopes (runtime: 'claude-code').
 * - The hook binary: `runHook` (the testable orchestration) and the `onemem-claude-hook` bin
 *   (`src/bin.ts`) that settings.json invokes.
 * - Delivery (public surfaces only): `deliverEvents` against the daemon REST ingest endpoint,
 *   `fetchSessionContext` for the SessionStart context injection.
 * - Scaffolds (for `onemem init` wiring): `buildMcpJson`/`renderMcpJson`,
 *   `buildClaudeHooksConfig`/`renderClaudeSettingsHooks`, `buildMemoryPointerBlock`/
 *   `mergeMemoryPointerBlock`.
 */

export {
  HOOK_EVENT_NAMES,
  SESSION_START_SOURCES,
  SESSION_END_REASONS,
  FILE_EDIT_TOOLS,
  COMMAND_TOOLS,
  parseHookInput,
  type HookEventName,
  type HookInput,
  type ParseHookInputResult,
  type SessionStartSource,
  type SessionEndReason,
} from './hook-input';

export { translateHookInput, type TranslateContext, type TranslationResult, type TranslationDrop } from './translate';

export {
  parseTranscript,
  selectTranscriptDelta,
  isRememberUtterance,
  MAX_EVENTS_PER_DELIVERY,
  type ParsedTranscript,
  type TranscriptDelta,
  type TranscriptEntry,
  type TranscriptSkippedEntry,
  type TranscriptTextEntry,
} from './transcript';

export { extractRememberUtterance } from './remember';

export {
  looksLikeGitCommit,
  commitShaFromStdout,
  commitStatsFromStdout,
  readGitCommitFacts,
  type GitCommitFacts,
  type GitRunner,
} from './git';

export {
  resolveHookTarget,
  findOnememoryDir,
  readProjectState,
  readDaemonLock,
  isProcessAlive,
  readHookState,
  writeHookState,
  ONEMEMORY_DIR_NAME,
  ADAPTER_STATE_RELPATH,
  ProjectStateSchema,
  DaemonLockSchema,
  HookStateSchema,
  type ProjectState,
  type DaemonLock,
  type HookState,
  type ResolveTargetOptions,
  type ResolveTargetResult,
} from './discovery';

export {
  deliverEvents,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  type DaemonTarget,
  type DeliverOptions,
  type DeliverResult,
} from './deliver';

export {
  fetchSessionContext,
  additionalContextOutput,
  capAdditionalContext,
  contextBudgetFromEnv,
  DEFAULT_CONTEXT_BUDGET,
  ADDITIONAL_CONTEXT_MAX,
  CONTEXT_FETCH_TIMEOUT_MS,
  MAX_CONTEXT_BUDGET,
  type SessionContextResponse,
  type FetchContextResult,
} from './context';

export {
  emitDiag,
  type DiagRecord,
  type DiagSink,
} from './diag';

export { runHook, type RunHookOptions, type HookRunResult } from './hook-bin';

export {
  buildMcpJson,
  renderMcpJson,
  defaultMcpServerArgs,
  buildClaudeHooksConfig,
  renderClaudeSettingsHooks,
  defaultHookArgs,
  buildMemoryPointerBlock,
  mergeMemoryPointerBlock,
  MEMORY_POINTER_BEGIN,
  MEMORY_POINTER_END,
  McpServerEntrySchema,
  McpJsonDocumentSchema,
  HooksConfigSchema,
  type McpJsonOptions,
  type McpServerEntry,
  type McpJsonDocument,
  type HookInvocation,
  type HooksConfigOptions,
  type HooksConfig,
  type PointerBlockOptions,
} from './scaffolds';

export { ADAPTER_VERSION } from './version';
