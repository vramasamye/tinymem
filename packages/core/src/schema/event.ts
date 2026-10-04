/**
 * The common event envelope and all event kind payloads — a 1:1 Zod mirror of
 * `docs/architecture/event-memory-schemas.md` §1–§2 (the normative TypeScript there is the
 * enforcement target; this file IS the enforcement point).
 *
 * Envelope rules (§1):
 * - Adapters MUST NOT drop events because a field is unknown: unknown `kind`s are normalized to
 *   `raw.unknown` (the original kind is preserved inside the payload) and ignored by extractors
 *   until a handler exists.
 * - Envelope validation is strict on shape, tolerant on unknown fields (loose objects): a
 *   malformed event becomes a dead-letter record with the validation error — it never crashes the
 *   pipeline and never blocks the agent runtime.
 *
 * Deviation (documented in mission-1.md): each payload variant carries its `kind` literal as the
 * discriminator, making the payload self-describing; `validateOnememoryEvent` injects it when an
 * adapter sends the doc-shaped payload (fields only), so both forms validate.
 */

import { z } from 'zod';

import {
  FILE_CHANGE_KINDS,
  REDACTION_KINDS,
} from '../model/types';
import { SCHEMA_VERSION } from './version';

// ---------------------------------------------------------------------------
// §1 The common event envelope
// ---------------------------------------------------------------------------

export const EVENT_RUNTIMES = [
  'claude-code',
  'codex',
  'cursor',
  'pi',
  'opencode',
  'mcp-client',
  'cli',
  'file-watcher',
  'git-watcher',
  'api',
  'webhook',
] as const;
export type EventRuntime = (typeof EVENT_RUNTIMES)[number];

export const EventSourceSchema = z.looseObject({
  runtime: z.enum(EVENT_RUNTIMES),
  adapter_version: z.string().min(1),
  instance_id: z.string().optional(),
});
export type EventSource = z.infer<typeof EventSourceSchema>;

export const EventScopeSchema = z.looseObject({
  project_id: z.uuid().optional(),
  session_id: z.string().optional(),
  agent_id: z.string().optional(),
  user_id: z.uuid().optional(),
});
export type EventScope = z.infer<typeof EventScopeSchema>;

export const RedactionSchema = z.looseObject({
  kind: z.enum(REDACTION_KINDS),
  /** JSON path of the redacted field, e.g. "payload.content". */
  location: z.string().min(1),
  /** Length of the removed secret (audit only — the secret value is NEVER stored). */
  length: z.number().int().min(1),
});
export type Redaction = z.infer<typeof RedactionSchema>;

// ---------------------------------------------------------------------------
// §2 Event kinds
// ---------------------------------------------------------------------------

export const EVENT_KINDS = [
  'conversation.message',
  'conversation.tool_call',
  'conversation.tool_result',
  'terminal.output',
  'error.raised',
  'test.results',
  'file.changed',
  'git.commit',
  'pull_request',
  'document.added',
  'explicit.remember',
  'explicit.forget',
  'session.start',
  'session.end',
  'raw.unknown',
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

/** `true` for the known kind vocabulary (anything else normalizes to `raw.unknown`). */
export function isKnownEventKind(kind: string): kind is EventKind {
  return (EVENT_KINDS as readonly string[]).includes(kind);
}

const isoTimestamp = z.iso.datetime();

// --- conversations & agent work --------------------------------------------

export const ConversationMessagePayloadSchema = z.looseObject({
  kind: z.literal('conversation.message'),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  mentions: z.array(z.string()).optional(),
  summary: z.string().optional(),
});

export const ConversationToolCallPayloadSchema = z.looseObject({
  kind: z.literal('conversation.tool_call'),
  tool: z.string().min(1),
  call_id: z.string().min(1),
  arguments_digest: z.string().max(400),
});

export const ConversationToolResultPayloadSchema = z.looseObject({
  kind: z.literal('conversation.tool_result'),
  call_id: z.string().min(1),
  ok: z.boolean(),
  output_digest: z.string().max(2000),
  /**
   * The tool that produced the result, when the adapter's own shape names it (M3c). Optional and
   * never inferred: several runtimes report a result keyed only by `call_id`, and a name derived
   * from the digest would be fabricated provenance.
   */
  tool: z.string().min(1).max(80).optional(),
  error: z
    .looseObject({
      code: z.string().optional(),
      message: z.string(),
    })
    .optional(),
});

// --- developer activity ------------------------------------------------------

export const TerminalOutputPayloadSchema = z.looseObject({
  kind: z.literal('terminal.output'),
  command: z.string().min(1),
  exit_code: z.number().int().nullable(),
  output_digest: z.string().max(2000),
  shell: z.string().optional(),
});

export const ErrorRaisedPayloadSchema = z.looseObject({
  kind: z.literal('error.raised'),
  origin: z.enum(['terminal', 'test', 'build', 'runtime', 'tool']),
  message: z.string().min(1),
  context: z.string().max(500).optional(),
  stack_digest: z.string().optional(),
});

export const TestResultsPayloadSchema = z.looseObject({
  kind: z.literal('test.results'),
  framework: z.string().optional(),
  passed: z.number().int().min(0),
  failed: z.number().int().min(0),
  skipped: z.number().int().min(0).optional(),
  failures: z
    .array(z.looseObject({ name: z.string(), digest: z.string().max(300) }))
    .max(10)
    .optional(),
});

export const FileChangedPayloadSchema = z.looseObject({
  kind: z.literal('file.changed'),
  path: z.string().min(1),
  change: z.enum(FILE_CHANGE_KINDS),
  old_path: z.string().optional(),
  blob_sha_before: z.string().optional(),
  blob_sha_after: z.string().optional(),
  lines_added: z.number().int().optional(),
  lines_removed: z.number().int().optional(),
});

// --- git & review -------------------------------------------------------------

export const GitCommitPayloadSchema = z.looseObject({
  kind: z.literal('git.commit'),
  sha: z.string().min(1),
  message: z.string(),
  author_name: z.string(), // author EMAIL is NOT captured (privacy)
  files: z.array(z.string()).max(500),
  stats: z
    .looseObject({
      files_changed: z.number().int().min(0),
      insertions: z.number().int().min(0),
      deletions: z.number().int().min(0),
    })
    .optional(),
  repo_fingerprint: z.string().optional(),
});

export const PullRequestPayloadSchema = z.looseObject({
  kind: z.literal('pull_request'),
  number: z.number().int(),
  title: z.string(),
  state: z.enum(['opened', 'merged', 'closed']),
  repo: z.string().optional(),
  review_digest: z.string().max(1000).optional(),
});

// --- documents & explicit intent ------------------------------------------------

export const DocumentAddedPayloadSchema = z
  .looseObject({
    kind: z.literal('document.added'),
    path: z.string().optional(),
    uri: z.string().optional(),
    mime: z.string(),
    title: z.string().optional(),
    content_digest: z.string().max(8000),
    full_text_ref: z.string().optional(),
  })
  .check((ctx) => {
    const hasPath = ctx.value.path !== undefined;
    const hasUri = ctx.value.uri !== undefined;
    if (hasPath === hasUri) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'document.added requires exactly one of path or uri',
        path: ['path'],
      });
    }
  });

export const ExplicitRememberPayloadSchema = z.looseObject({
  kind: z.literal('explicit.remember'),
  content: z.string().min(1),
  type: z.enum(['semantic', 'procedural', 'decision', 'preference', 'failure']).optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
  scope: z.enum(['project', 'user', 'global']).optional(),
});

export const ExplicitForgetPayloadSchema = z.looseObject({
  kind: z.literal('explicit.forget'),
  memory_id: z.uuid(),
  purge: z.boolean().optional(),
  reason: z.string().optional(),
});

// --- session lifecycle -----------------------------------------------------------

export const SessionStartPayloadSchema = z.looseObject({
  kind: z.literal('session.start'),
  started_at: isoTimestamp.optional(),
  ended_at: isoTimestamp.optional(),
  cwd: z.string().min(1),
  project_hint: z.string().optional(),
  summary: z.string().optional(),
});

export const SessionEndPayloadSchema = z.looseObject({
  kind: z.literal('session.end'),
  started_at: isoTimestamp.optional(),
  ended_at: isoTimestamp.optional(),
  cwd: z.string().min(1),
  project_hint: z.string().optional(),
  summary: z.string().optional(),
});

// --- escape hatch -----------------------------------------------------------------

export const RawUnknownPayloadSchema = z.looseObject({
  kind: z.literal('raw.unknown'),
  /** The kind the emitter used before normalization (kept so extractors can be added later). */
  original_kind: z.string().optional(),
});

/**
 * The §2 discriminated union over all event kinds (discriminator: the `kind` literal each payload
 * carries). Unknown kinds are represented by `raw.unknown`.
 */
export const EventPayloadSchema = z.discriminatedUnion('kind', [
  ConversationMessagePayloadSchema,
  ConversationToolCallPayloadSchema,
  ConversationToolResultPayloadSchema,
  TerminalOutputPayloadSchema,
  ErrorRaisedPayloadSchema,
  TestResultsPayloadSchema,
  FileChangedPayloadSchema,
  GitCommitPayloadSchema,
  PullRequestPayloadSchema,
  DocumentAddedPayloadSchema,
  ExplicitRememberPayloadSchema,
  ExplicitForgetPayloadSchema,
  SessionStartPayloadSchema,
  SessionEndPayloadSchema,
  RawUnknownPayloadSchema,
]);
export type EventPayload = z.infer<typeof EventPayloadSchema>;

/** Per-kind payload schemas without the injected discriminator (doc-shaped payloads). */
export const PayloadSchemaByKind = {
  'conversation.message': ConversationMessagePayloadSchema,
  'conversation.tool_call': ConversationToolCallPayloadSchema,
  'conversation.tool_result': ConversationToolResultPayloadSchema,
  'terminal.output': TerminalOutputPayloadSchema,
  'error.raised': ErrorRaisedPayloadSchema,
  'test.results': TestResultsPayloadSchema,
  'file.changed': FileChangedPayloadSchema,
  'git.commit': GitCommitPayloadSchema,
  pull_request: PullRequestPayloadSchema,
  'document.added': DocumentAddedPayloadSchema,
  'explicit.remember': ExplicitRememberPayloadSchema,
  'explicit.forget': ExplicitForgetPayloadSchema,
  'session.start': SessionStartPayloadSchema,
  'session.end': SessionEndPayloadSchema,
  'raw.unknown': RawUnknownPayloadSchema,
} as const;

// ---------------------------------------------------------------------------
// Envelope: tolerant shape first (kind: string, payload: unknown), then the
// strict canonical schema (kind: EventKind, payload: discriminated union).
// ---------------------------------------------------------------------------

const sha256Hex = /^[0-9a-f]{64}$/;

export const OnememoryEventEnvelopeSchema = z.looseObject({
  id: z.uuid(),
  kind: z.string(),
  occurred_at: isoTimestamp,
  ingested_at: isoTimestamp,
  source: EventSourceSchema,
  scope: EventScopeSchema,
  payload: z.unknown(),
  content_hash: z.string().regex(sha256Hex),
  redactions: z.array(RedactionSchema),
  /** Carried for forward compatibility (§8); optional so doc-shaped events validate. */
  schema_version: z.number().int().optional(),
});
export type OnememoryEventEnvelope = z.infer<typeof OnememoryEventEnvelopeSchema>;

export const OnememoryEventSchema = z
  .looseObject({
    id: z.uuid(),
    kind: z.enum(EVENT_KINDS),
    occurred_at: isoTimestamp,
    ingested_at: isoTimestamp,
    source: EventSourceSchema,
    scope: EventScopeSchema,
    payload: EventPayloadSchema,
    content_hash: z.string().regex(sha256Hex),
    redactions: z.array(RedactionSchema),
    schema_version: z.number().int().optional(),
  })
  .check((ctx) => {
    if (ctx.value.payload.kind !== ctx.value.kind) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value.payload,
        message: `payload.kind (${String(ctx.value.payload.kind)}) must match the envelope kind (${ctx.value.kind})`,
        path: ['payload', 'kind'],
      });
    }
  });
export type OnememoryEvent = z.infer<typeof OnememoryEventSchema>;

// ---------------------------------------------------------------------------
// Validation entry point: unknown-kind tolerance + dead-letter on malformed input
// ---------------------------------------------------------------------------

export interface DeadLetterIssue {
  path: string;
  message: string;
}

/** The dead-letter record for a malformed event (§1): reason + issues, never a crash. */
export interface EventDeadLetter {
  stage: 'ingest.validate';
  reason: string;
  issues: DeadLetterIssue[];
  received_at: string;
}

export type EventValidationResult =
  | { ok: true; value: OnememoryEvent }
  | { ok: false; dead_letter: EventDeadLetter };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issuesOf(error: z.ZodError): DeadLetterIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.') || '(root)',
    message: issue.message,
  }));
}

/**
 * Normalize an unknown kind to `raw.unknown` (§1): the payload is stored raw and the original
 * kind is preserved inside it, so a future extractor can pick these events up.
 */
export function normalizeUnknownKind(
  kind: string,
  payload: unknown,
): { kind: 'raw.unknown'; payload: Record<string, unknown> } {
  const base = isPlainObject(payload) ? payload : { data: payload };
  return { kind: 'raw.unknown', payload: { ...base, original_kind: kind } };
}

/**
 * Validate a raw event at the ingest boundary (stage OBSERVE/INGEST):
 * 1. envelope shape (strict on fields, tolerant on extras),
 * 2. unknown kinds → `raw.unknown` (never dropped),
 * 3. payload validated against the kind's variant (the `kind` discriminator is injected into
 *    doc-shaped payloads),
 * 4. failure at any step → a dead-letter record, not an exception.
 */
export function validateOnememoryEvent(input: unknown): EventValidationResult {
  const received_at = new Date().toISOString();
  const envelope = OnememoryEventEnvelopeSchema.safeParse(input);
  if (!envelope.success) {
    const issues = issuesOf(envelope.error);
    return {
      ok: false,
      dead_letter: {
        stage: 'ingest.validate',
        reason: 'event envelope failed validation',
        issues,
        received_at,
      },
    };
  }

  let kind: string = envelope.data.kind;
  let payload: unknown = envelope.data.payload;
  if (!isKnownEventKind(kind)) {
    const normalized = normalizeUnknownKind(kind, payload);
    kind = normalized.kind;
    payload = normalized.payload;
  }
  // Doc-shaped payloads carry no `kind`; inject the envelope's kind so the union can
  // discriminate. If the payload already carries a (conflicting) kind it wins here — the
  // envelope-vs-payload consistency check below dead-letters mismatches.
  const payloadWithKind = isPlainObject(payload) ? { kind, ...payload } : payload;

  const candidate = { ...envelope.data, kind, payload: payloadWithKind };
  const strict = OnememoryEventSchema.safeParse(candidate);
  if (!strict.success) {
    const issues = issuesOf(strict.error);
    return {
      ok: false,
      dead_letter: {
        stage: 'ingest.validate',
        reason: `event payload failed validation for kind '${kind}'`,
        issues,
        received_at,
      },
    };
  }
  return { ok: true, value: strict.data };
}

export { SCHEMA_VERSION };
