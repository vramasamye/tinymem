/**
 * `@onememory-ai/adapter-cursor` — the Cursor adapter (ADR-0010 §6–§7).
 *
 * A translator, nothing more: Cursor-native hook activity → validated `OnememoryEvent` envelopes
 * (runtime: 'cursor') → the daemon's public REST surface. It never imports engine internals
 * (`core` schemas only — the documented adapter contract), never blocks the agent (fail-soft
 * everywhere), and never lets a secret reach the wire (the daemon redacts; the adapter does not
 * read files).
 *
 * Consumers:
 * - `onemem init` calls `scaffoldCursor` (the init-wiring seam).
 * - Cursor hooks invoke the `onemem-cursor-hook` bin (scaffolded `.cursor/hooks.json`).
 * - `onemem doctor` calls `inspectCursorScaffold`.
 * - The conformance suite (`benchmarks/eval/src/adapter-conformance/`) drives `translateHookInput`.
 */

// Hook payload schemas + the subscription list
export {
  HOOK_EVENT_NAMES,
  SESSION_END_REASONS,
  STOP_STATUSES,
  FAILURE_TYPES,
  SHELL_TOOL_NAMES,
  FILE_EDIT_TOOL_NAMES,
  AttachmentSchema,
  ShellToolInputSchema,
  ShellToolOutputSchema,
  FileEditSchema,
  HookInputSchema,
  parseHookInput,
  type HookEventName,
  type HookInput,
  type ParseHookInputResult,
} from './hook-input';

// Translation
export {
  translateHookInput,
  type TranslateContext,
  type TranslationResult,
  type TranslationDrop,
} from './translate';

export { extractRememberUtterance } from './remember';

// The hook binary's testable entry point
export { runHook, type RunHookOptions, type HookRunResult } from './hook-bin';

// Hook-side runtime support (discovery, delivery, context, diagnostics)
export {
  resolveHookTarget,
  findOnememoryDir,
  readProjectState,
  readDaemonLock,
  isProcessAlive,
  ProjectStateSchema,
  DaemonLockSchema,
  ONEMEMORY_DIR_NAME,
  deliverEvents,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  fetchSessionContext,
  additionalContextOutput,
  capAdditionalContext,
  contextBudgetFromEnv,
  DEFAULT_CONTEXT_BUDGET,
  ADDITIONAL_CONTEXT_MAX,
  CONTEXT_FETCH_TIMEOUT_MS,
  MAX_CONTEXT_BUDGET,
  emitDiag,
  type ProjectState,
  type DaemonLock,
  type ResolveTargetOptions,
  type ResolveTargetResult,
  type DaemonTarget,
  type DeliverOptions,
  type DeliverResult,
  type SessionContextResponse,
  type FetchContextResult,
  type DiagRecord,
  type DiagSink,
} from './runtime';

// Scaffolds (pure renderers + idempotent patchers)
export {
  buildCursorMcpJson,
  buildMcpServerEntry,
  renderCursorMcpJson,
  patchCursorMcpJson,
  defaultMcpServerArgs,
  isLoopbackHostname,
  LoopbackHttpUrlSchema,
  CursorHttpServerEntrySchema,
  CursorStdioServerEntrySchema,
  CursorServerEntrySchema,
  CursorMcpDocumentSchema,
  MCP_SERVER_NAME,
  type CursorMcpOptions,
  type CursorHttpServerEntry,
  type CursorStdioServerEntry,
  type CursorServerEntry,
  type CursorMcpDocument,
  type ScaffoldMergeAction,
  type ScaffoldMergeResult,
} from './mcp-scaffold';
export {
  buildCursorHooksFile,
  renderCursorHooksJson,
  patchCursorHooksJson,
  defaultCaptureCommand,
  CURSOR_HOOK_BIN_TOKENS,
  CursorHookEntrySchema,
  CursorHooksFileSchema,
  type CursorHooksScaffoldOptions,
  type CursorHooksFile,
} from './hooks-scaffold';
export {
  buildOnememoryRuleBlock,
  buildCursorRuleFrontmatter,
  renderCursorRuleFrontmatter,
  renderCursorRule,
  patchCursorRule,
  hasOnememoryRuleBlock,
  hasFrontmatter,
  CursorRuleFrontmatterSchema,
  RULES_BEGIN,
  RULES_END,
  type CursorRuleOptions,
  type CursorRuleFrontmatter,
} from './rules';

// The init-wiring seam
export {
  scaffoldCursor,
  cursorScaffoldPaths,
  renderCursorScaffold,
  type ScaffoldCursorOptions,
  type ScaffoldCursorResult,
  type ScaffoldedFile,
} from './scaffold';

// Read-only inspection for onemem doctor
export {
  inspectCursorScaffold,
  inspectCursorMcpContent,
  inspectCursorHooksContent,
  type CursorScaffoldInspection,
  type CursorMcpInspection,
  type CursorHooksInspection,
} from './scaffold-inspect';

export { ADAPTER_VERSION } from './version';
