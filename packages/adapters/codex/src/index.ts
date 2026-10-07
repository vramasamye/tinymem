/**
 * `@onememory-ai/adapter-codex` — the OpenAI Codex CLI adapter (ADR-0010 §6–§7).
 *
 * A translator, nothing more: Codex-native activity (hook payloads, rollout session logs) →
 * validated `OnememoryEvent` envelopes → the daemon's public REST surface. It never imports engine
 * internals (`core` schemas, `security` redaction, `config` discovery only — the documented
 * adapter contract), never blocks the agent (fail-soft everywhere), and never lets a secret reach
 * the wire (path exclusion + `redactEvent` before delivery; the daemon redacts again).
 *
 * Consumers:
 * - `onemem init` calls `scaffoldCodex` (the init-wiring seam, mission-13/coordinator).
 * - Codex hooks invoke the `onemem-codex-capture` bin (scaffolded `.codex/hooks.json`).
 * - Tests/fixtures live in `@onememory-ai/adapter-codex/testing`.
 */

// Wire contract (verified mirrors of the published Codex hook schemas)
export {
  SessionStartHookInputSchema,
  SessionEndHookInputSchema,
  UserPromptSubmitHookInputSchema,
  PostToolUseHookInputSchema,
  StopHookInputSchema,
  EXIT_CODE_LINE,
  RUNNING_SESSION_LINE,
  type SessionStartHookInput,
  type SessionEndHookInput,
  type UserPromptSubmitHookInput,
  type PostToolUseHookInput,
  type StopHookInput,
  type CodexHookInput,
  type SessionStartHookOutput,
} from './codex-wire';

// Translation
export {
  translateCodexHook,
  type TranslationResult,
} from './translate-hooks';
export {
  translateRolloutSession,
  MAX_ROLLOUT_LINES,
  MAX_ROLLOUT_BYTES,
  type RolloutTranslationResult,
} from './translate-rollout';
export { parseApplyPatch, type ParsedFileChange } from './apply-patch';
export {
  buildEvent,
  clampDigest,
  EventValidationError,
  CODEX_RUNTIME,
  CODEX_AGENT_ID,
  type EventContext,
  type DroppedRecord,
} from './event-builder';

// Capture pipeline (translate → path-exclude → redact → deliver)
export {
  captureHook,
  captureRollout,
  buildSessionStartOutput,
  deliveryDiagnostic,
  deliverySummary,
  type CaptureOutcome,
  type CaptureOptions,
} from './capture';

// Delivery (fail-soft daemon REST client)
export {
  discoverCaptureTarget,
  deliverEvents,
  fetchSessionContext,
  readDaemonLock,
  DaemonLockSchema,
  isProcessAlive,
  MAX_EVENTS_PER_REQUEST,
  DEFAULT_DELIVERY_TIMEOUT_MS,
  DEFAULT_CONTEXT_TIMEOUT_MS,
  type DaemonLock,
  type IngestResponse,
  type SessionContextResponse,
  type DeliveryResult,
  type DeliveryFailureCode,
  type ContextResult,
  type CaptureTarget,
  type DiscoveryOptions,
  type DeliverOptions,
} from './delivery';

// Scaffolds (pure renderers + idempotent patchers)
export {
  renderCodexMcpServerToml,
  patchCodexConfigToml,
  tomlString,
  CODEX_TOML_BEGIN_MARKER,
  CODEX_TOML_END_MARKER,
  ONEMEMORY_MCP_SERVER_NAME,
  PROJECT_MCP_COMMAND,
  isLoopbackHostname,
  assertLoopbackHttpUrl,
  type CodexMcpScaffoldOptions,
} from './config-scaffold';
export {
  buildCodexHooksFile,
  renderCodexHooksJson,
  patchCodexHooksJson,
  PROJECT_CAPTURE_COMMAND,
  CAPTURE_BIN_TOKEN,
  type CodexHooksScaffoldOptions,
  type CodexHooksFile,
  type HooksPatchResult,
} from './hooks-scaffold';
export {
  renderOnememoryAgentsBlock,
  patchAgentsMd,
  hasOnememoryAgentsBlock,
  AGENTS_BLOCK_BEGIN_PREFIX,
  AGENTS_BLOCK_END_MARKER,
  type AgentsBlockOptions,
} from './agents-md';

// The init-wiring seam
export {
  scaffoldCodex,
  type ScaffoldCodexOptions,
  type ScaffoldCodexResult,
  type ScaffoldedFile,
  type CodexScaffoldScope,
} from './scaffold';

// Read-only inspection for onemem doctor
export {
  inspectCodexScaffold,
  inspectCodexConfigContent,
  inspectCodexHooksContent,
  hasCodexAgentsBlock,
  codexScaffoldPaths,
  type CodexScaffoldInspection,
  type CodexConfigInspection,
  type CodexHooksInspection,
} from './scaffold-inspect';

// The hook bin's testable entry points
export { main as runCaptureBin, parseBinArgs, type BinArgs } from './bin';

export { CODEX_ADAPTER_VERSION } from './version';
