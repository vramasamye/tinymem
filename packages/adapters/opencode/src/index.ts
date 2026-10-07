/**
 * `@onememory-ai/adapter-opencode` — the OpenCode adapter (ADR-0010 §6/§7).
 *
 * A translator, nothing more: OpenCode-native plugin signals (events, `tool.execute.after`,
 * `chat.message`) become validated `OnememoryEvent` envelopes (runtime: 'opencode') delivered
 * through the daemon's public REST surface. It never imports engine internals (`core` schemas,
 * `security` redaction, `config` discovery only — the documented adapter contract), never blocks
 * the agent (fail-soft everywhere; every delivery is bounded), and never lets a secret reach the
 * wire (path exclusion + `redactEvent` before delivery; the daemon redacts again).
 *
 * Consumers:
 * - `onemem init` calls `scaffoldOpenCode` (the init-wiring seam).
 * - The generated `.opencode/plugins/onememory.ts` shim exports `createOpenCodePlugin()`'s
 *   function at OpenCode load time (in-process — local plugin files auto-load; no hook process).
 * - `onemem doctor` reads `inspectOpenCodeScaffold` through the CLI's runtime-scaffolds group.
 */

// Wire contract (verified mirrors of OpenCode's published plugin/event/tool surfaces)
export {
  BashToolArgsSchema,
  BashToolMetadataSchema,
  ChatMessageInputSchema,
  ChatMessageOutputSchema,
  EditToolArgsSchema,
  EventHookInputSchema,
  EventTypeSchema,
  isLoopbackHostname,
  LoopbackHttpUrlSchema,
  MCP_SERVER_NAME,
  MessagePartUpdatedEventSchema,
  OpenCodeConfigDocumentSchema,
  OpenCodeEventSchema,
  OpenCodeMcpEntrySchema,
  OpenCodeMcpLocalEntrySchema,
  OpenCodeMcpRemoteEntrySchema,
  OpenCodeSessionSchema,
  SessionCreatedEventSchema,
  SessionIdleEventSchema,
  TextPartSchema,
  ToolAfterInputSchema,
  ToolAfterOutputSchema,
  ToolPartSchema,
  ToolStateSchema,
  UserMessageSchema,
  WriteToolArgsSchema,
  WriteToolMetadataSchema,
  type BashToolArgs,
  type BashToolMetadata,
  type ChatMessageInput,
  type ChatMessageOutput,
  type EditToolArgs,
  type EventHookInput,
  type OpenCodeEvent,
  type OpenCodeMcpEntry,
  type OpenCodeMcpLocalEntry,
  type OpenCodeMcpRemoteEntry,
  type OpenCodeSession,
  type SessionCreatedEvent,
  type SessionIdleEvent,
  type TextPart,
  type ToolAfterInput,
  type ToolAfterOutput,
  type ToolPart,
  type ToolPartState,
  type UserMessage,
  type WriteToolArgs,
  type WriteToolMetadata,
} from './wire';

// Translation
export {
  createOpenCodeTranslator,
  OpenCodeTranslator,
  type OpenCodeTranslateContext,
  type OpenCodeTranslationResult,
  type TranslateCall,
} from './translate';
export { extractRememberUtterance } from './remember';
export {
  buildEvent,
  clampDigest,
  EventValidationError,
  OPENCODE_RUNTIME,
  OPENCODE_AGENT_ID,
  type DroppedRecord,
  type EventContext,
} from './event-builder';

// Capture pipeline (translate → path-exclude → redact → deliver) + session injection
export {
  buildSessionInjection,
  captureOpenCodeChatMessage,
  captureOpenCodeEvent,
  captureOpenCodeToolAfter,
  deliveryDiagnostic,
  deliverySummary,
  OPENCODE_CONTEXT_INJECTION_PREFIX,
  type CaptureOptions,
  type CaptureOutcome,
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

// The in-process plugin (what the scaffolded shim exports)
export {
  createOpenCodePlugin,
  DEFAULT_CONTEXT_BUDGET,
  MAX_CONTEXT_BUDGET,
  type OpenCodePluginContext,
  type OpenCodePluginHooks,
  type OpenCodePluginOptions,
} from './plugin';

// Scaffolds (pure renderers + idempotent merges)
export {
  buildOpenCodeMcpServerEntry,
  buildOpenCodePluginFile,
  buildOpenCodePointerBlock,
  defaultOpenCodeStdioArgs,
  mergeOpenCodeConfigJson,
  mergeOpenCodePointerBlock,
  hasOpenCodePointerBlock,
  OPENCODE_ADAPTER_PACKAGE,
  OPENCODE_INSTRUCTIONS_ENTRY,
  OPENCODE_PLUGIN_MARKER,
  OPENCODE_PLUGIN_RELPATH,
  OPENCODE_POINTER_BEGIN,
  OPENCODE_POINTER_END,
  type OpenCodeMcpOptions,
  type OpenCodePointerOptions,
  type ScaffoldMergeAction,
  type ScaffoldMergeResult,
} from './scaffolds';

// The init-wiring seam
export {
  scaffoldOpenCode,
  renderOpenCodeScaffold,
  openCodeScaffoldPaths,
  type ScaffoldOpenCodeOptions,
  type ScaffoldOpenCodeResult,
  type ScaffoldedFile,
} from './scaffold';

// Read-only inspection for onemem doctor
export {
  inspectOpenCodeScaffold,
  inspectOpenCodeConfigContent,
  inspectOpenCodePluginContent,
  hasOpenCodePointerBlockContent,
  openCodeInspectPaths,
  type OpenCodeScaffoldState,
} from './scaffold-inspect';

export { OPENCODE_ADAPTER_VERSION } from './version';
