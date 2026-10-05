/**
 * `@onememory/adapter-pi` — the Pi adapter (ADR-0010 §6/§7).
 *
 * A translator, nothing more: Pi-native extension events (`pi.on()` lifecycle) → validated
 * `OnememoryEvent` envelopes (runtime: 'pi') → the daemon's public REST surface. It never imports
 * engine internals (`core` schemas, `security` redaction, `config` discovery only — the documented
 * adapter contract), never blocks the agent (fail-soft everywhere; every delivery is bounded), and
 * never lets a secret reach the wire (path exclusion + `redactEvent` before delivery; the daemon
 * redacts again).
 *
 * Consumers:
 * - `onemem init` calls `scaffoldPi` (the init-wiring seam).
 * - The generated `.pi/extensions/onememory.ts` shim calls `createPiExtension` at Pi load time
 *   (in-process — no bin, no hook process; Pi loads TypeScript extensions via jiti).
 * - `onemem doctor` reads `inspectPiScaffold` through the CLI's integration module.
 */

// Wire contract (verified mirrors of Pi's documented extension event payloads)
export {
  PI_CAPTURE_EVENT_NAMES,
  PiBashToolInputSchema,
  PiBashToolOutputSchema,
  PiCaptureEventSchema,
  PiEditToolInputSchema,
  PiMessageSchema,
  PiMessageContentSchema,
  PiSessionStartEventSchema,
  PiSessionShutdownEventSchema,
  PiBeforeAgentStartEventSchema,
  PiMessageEndEventSchema,
  PiToolResultEventSchema,
  PiTextContentSchema,
  PiWriteToolInputSchema,
  type PiBashToolInput,
  type PiBashToolOutput,
  type PiBeforeAgentStartEvent,
  type PiCaptureEvent,
  type PiCaptureEventName,
  type PiEditToolInput,
  type PiMessage,
  type PiMessageContent,
  type PiMessageEndEvent,
  type PiSessionShutdownEvent,
  type PiSessionStartEvent,
  type PiTextContent,
  type PiToolResultEvent,
  type PiWriteToolInput,
} from './pi-wire';

// Translation
export {
  translatePiEvent,
  PI_CONTEXT_INJECTION_PREFIX,
  type PiTranslateContext,
  type PiTranslationResult,
} from './translate';
export { extractRememberUtterance } from './remember';
export {
  buildEvent,
  clampDigest,
  EventValidationError,
  PI_RUNTIME,
  PI_AGENT_ID,
  type DroppedRecord,
  type EventContext,
} from './event-builder';
export {
  commitShaFromStdout,
  commitStatsFromStdout,
  looksLikeGitCommit,
  readGitCommitFacts,
  type GitCommitFacts,
  type GitRunner,
} from './git';

// Capture pipeline (translate → path-exclude → redact → deliver) + session injection
export {
  buildSessionInjection,
  capturePiEvent,
  deliveryDiagnostic,
  deliverySummary,
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

// The in-process extension (what the scaffolded shim calls)
export {
  createPiExtension,
  DEFAULT_CONTEXT_BUDGET,
  MAX_CONTEXT_BUDGET,
  type PiExtensionApi,
  type PiExtensionContext,
  type PiExtensionOptions,
} from './extension';

// Scaffolds (pure renderers + idempotent merges)
export {
  buildPiMcpServerEntry,
  buildPiExtensionFile,
  buildPiPointerBlock,
  mergePiMcpJson,
  mergePiPointerBlock,
  defaultPiStdioArgs,
  isLoopbackHostname,
  LoopbackHttpUrlSchema,
  ONEMEMORY_SERVER_DESCRIPTION,
  DEFAULT_EXPOSURE,
  MCP_SERVER_NAME,
  PI_ADAPTER_PACKAGE,
  PI_EXTENSION_MARKER,
  PI_EXTENSION_RELPATH,
  PI_POINTER_BEGIN,
  PI_POINTER_END,
  PiMcpHttpEntrySchema,
  PiMcpJsonDocumentSchema,
  PiMcpServerEntrySchema,
  PiMcpStdioEntrySchema,
  PiToolExposureSchema,
  type PiMcpHttpEntry,
  type PiMcpJsonDocument,
  type PiMcpOptions,
  type PiMcpMergeResult,
  type PiMcpServerEntry,
  type PiMcpStdioEntry,
  type PiPointerOptions,
  type PiToolExposure,
} from './scaffolds';

// The init-wiring seam
export {
  scaffoldPi,
  type ScaffoldPiOptions,
  type ScaffoldPiResult,
  type ScaffoldedFile,
  type PiScaffoldScope,
} from './scaffold';

// Read-only inspection for onemem doctor
export {
  inspectPiScaffold,
  inspectPiMcpContent,
  inspectPiExtensionContent,
  hasPiPointerBlock,
  piScaffoldPaths,
  type PiScaffoldState,
} from './scaffold-inspect';

export { PI_ADAPTER_VERSION } from './version';
