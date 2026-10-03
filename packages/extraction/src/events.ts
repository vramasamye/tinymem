/**
 * Stage 3 NORMALIZE: raw `OnememoryEvent`s → clean text/structured forms (`NormalizedEvent`).
 *
 * This module is the pure transformation; the `normalize` job handler (`handlers/normalize.ts`)
 * is the pipeline stage that runs it over pending events, flags unparseable ones `needs_review`,
 * and hands the batch to EXTRACT. Keeping the transform pure is what makes the heuristic
 * extractor testable against fixture transcripts with no database at all.
 *
 * Payload parsing goes through core's canonical `PayloadSchemaByKind` schemas — one definition of
 * "what a terminal.output payload is", shared with the ingest boundary.
 */

import {
  PayloadSchemaByKind,
  validateOnememoryEvent,
  type EvidenceSpan,
  type EventKind,
  type ExtractionInput,
  type OnememoryEvent,
  type SourceKind,
  type StoredEvent,
} from '@onememory/core';
import { z } from 'zod';

import { NormalizationError } from './types';

/** Event kind → the `sources.kind` a provenance anchor for it carries. */
const SOURCE_KIND_BY_EVENT: Record<EventKind, SourceKind> = {
  'conversation.message': 'conversation',
  'conversation.tool_call': 'conversation',
  'conversation.tool_result': 'conversation',
  'terminal.output': 'terminal',
  'error.raised': 'terminal',
  'test.results': 'terminal',
  'file.changed': 'file',
  'git.commit': 'git',
  pull_request: 'git',
  'document.added': 'document',
  'explicit.remember': 'explicit',
  'explicit.forget': 'explicit',
  'session.start': 'api',
  'session.end': 'api',
  'raw.unknown': 'api',
};

export function sourceKindForEvent(kind: string): SourceKind {
  return SOURCE_KIND_BY_EVENT[kind as EventKind] ?? 'api';
}

/** Rebuild a validated envelope from an `events` row (the async pipeline reads rows, not events). */
export function storedEventToEnvelope(stored: StoredEvent): OnememoryEvent {
  const result = validateOnememoryEvent({
    id: stored.id,
    kind: stored.kind,
    occurred_at: stored.occurred_at,
    ingested_at: stored.ingested_at,
    source: { runtime: stored.runtime, adapter_version: stored.adapter_version },
    scope: {
      project_id: stored.project_id,
      session_id: stored.session_id,
      agent_id: stored.agent_id,
      user_id: stored.user_id,
    },
    payload: stored.payload,
    content_hash: stored.content_hash,
    redactions: stored.redactions,
  });
  if (!result.ok) {
    throw new NormalizationError(
      `stored event ${stored.id} could not be re-validated: ${result.dead_letter.issues
        .map((issue) => `${issue.path} ${issue.message}`)
        .join('; ')}`,
      stored.id,
    );
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// NormalizedEvent
// ---------------------------------------------------------------------------

const NormalizedCommandSchema = z.object({
  text: z.string(),
  normalized: z.string(),
  exit_code: z.number().int().nullable(),
});

const NormalizedErrorSchema = z.object({
  origin: z.string(),
  message: z.string(),
  context: z.string().optional(),
});

const NormalizedFileSchema = z.object({
  path: z.string(),
  change: z.string(),
  old_path: z.string().optional(),
});

const NormalizedTestsSchema = z.object({
  framework: z.string().optional(),
  passed: z.number().int(),
  failed: z.number().int(),
  skipped: z.number().int().optional(),
  failure_names: z.array(z.string()),
});

const NormalizedCommitSchema = z.object({
  sha: z.string(),
  message: z.string(),
  files: z.array(z.string()),
});

const NormalizedPullRequestSchema = z.object({
  number: z.number().int(),
  title: z.string(),
  state: z.string(),
});

const NormalizedDocumentSchema = z.object({
  path: z.string().optional(),
  uri: z.string().optional(),
  title: z.string().optional(),
  text: z.string(),
});

const NormalizedExplicitSchema = z.object({
  content: z.string(),
  type: z.string().optional(),
  importance: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).optional(),
});

/**
 * The NORMALIZE output. Also the shape carried in the `extract` job payload: M1's `events` table
 * has no normalized column, so the normalized batch travels in `jobs.payload` (documented
 * deviation — see the mission report).
 */
export const NormalizedEventSchema = z.object({
  event_id: z.uuid(),
  kind: z.string(),
  occurred_at: z.string(),
  ingested_at: z.string(),
  source_id: z.uuid(),
  session_id: z.string().optional(),
  project_id: z.uuid().optional(),
  agent_id: z.string().optional(),
  text: z.string(),
  command: NormalizedCommandSchema.optional(),
  error: NormalizedErrorSchema.optional(),
  file: NormalizedFileSchema.optional(),
  tests: NormalizedTestsSchema.optional(),
  commit: NormalizedCommitSchema.optional(),
  pull_request: NormalizedPullRequestSchema.optional(),
  document: NormalizedDocumentSchema.optional(),
  explicit: NormalizedExplicitSchema.optional(),
});
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

export const NormalizedBatchSchema = z.array(NormalizedEventSchema);

function excerpt(text: string, max = 200): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return collapsed.length > max ? `${collapsed.slice(0, max - 1)}…` : collapsed;
}

export { excerpt };

/** The minimal event shape an evidence span needs (a full envelope satisfies it structurally). */
export interface EvidenceEventRef {
  id: string;
  kind: string;
  /** Only consulted for the `git.commit` locator (`commit:<sha>`). */
  payload?: unknown;
}

/** Evidence span bound to the event's source. */
export function buildEvidence(
  event: EvidenceEventRef,
  sourceId: string,
  excerptText: string,
): EvidenceSpan {
  if (event.kind === 'git.commit') {
    const payload = event.payload as { sha?: string } | undefined;
    return {
      source_id: sourceId,
      kind: 'commit',
      locator: `commit:${payload?.sha ?? event.id}`,
      excerpt: excerpt(excerptText),
    };
  }
  return {
    source_id: sourceId,
    kind: event.kind === 'conversation.message' ? 'message' : 'event',
    locator: `event:${event.id}`,
    excerpt: excerpt(excerptText),
  };
}

/** A compact one-line digest used in LLM prompts and in candidate evidence excerpts. */
export function eventDigestLine(event: OnememoryEvent, index: number): string {
  const text = eventTextForMatching(event);
  return `[${index}] (${event.kind}, ${event.occurred_at}) ${text}`;
}

/** Digest line for a normalized event (the prompt input). */
export function normalizedDigestLine(event: NormalizedEvent, index: number): string {
  const session = event.session_id ? `, session ${event.session_id}` : '';
  const text = event.text.length > 1200 ? `${event.text.slice(0, 1199)}…` : event.text;
  return `[${index}] (${event.kind}, ${event.occurred_at}${session}) ${text}`;
}

/** Text used for pattern matching and prompts: payload-derived, whitespace-collapsed. */
export function eventTextForMatching(event: OnememoryEvent): string {
  const payload = event.payload as Record<string, unknown>;
  switch (event.kind) {
    case 'conversation.message': {
      const role = String(payload.role ?? 'unknown');
      return `[${role}] ${String(payload.content ?? '')}`;
    }
    case 'conversation.tool_call':
      return `tool call ${String(payload.tool ?? '')} ${String(payload.arguments_digest ?? '')}`;
    case 'conversation.tool_result':
      return `tool result ok=${String(payload.ok)} ${String(payload.output_digest ?? '')}`;
    case 'terminal.output':
      return `$ ${String(payload.command ?? '')} → exit ${String(payload.exit_code)} ${String(payload.output_digest ?? '')}`;
    case 'error.raised':
      return `error(${String(payload.origin ?? '')}): ${String(payload.message ?? '')} ${String(payload.context ?? '')}`;
    case 'test.results':
      return `tests ${String(payload.passed ?? 0)} passed / ${String(payload.failed ?? 0)} failed`;
    case 'file.changed':
      return `file ${String(payload.change ?? '')} ${String(payload.path ?? '')}`;
    case 'git.commit':
      return `commit ${String(payload.sha ?? '').slice(0, 8)}: ${String(payload.message ?? '')}`;
    case 'pull_request':
      return `PR #${String(payload.number ?? '')} (${String(payload.state ?? '')}): ${String(payload.title ?? '')}`;
    case 'document.added':
      return `document ${String(payload.title ?? payload.path ?? payload.uri ?? '')}: ${String(payload.content_digest ?? '')}`;
    case 'explicit.remember':
      return `explicit remember: ${String(payload.content ?? '')}`;
    case 'session.start':
    case 'session.end':
      return `${event.kind} cwd=${String(payload.cwd ?? '')} ${String(payload.summary ?? '')}`;
    default:
      return JSON.stringify(payload).slice(0, 400);
  }
}

/**
 * Normalize one event. Throws `NormalizationError` when the payload does not match its canonical
 * schema — the caller flags the event `needs_review` instead of dropping it.
 */
export function normalizeEvent(input: ExtractionInput): NormalizedEvent {
  const { event, source } = input;
  const payload = event.payload as Record<string, unknown>;
  const schema = PayloadSchemaByKind[event.kind as keyof typeof PayloadSchemaByKind];
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new NormalizationError(
      `event ${event.id} (${event.kind}) payload failed validation: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`,
      event.id,
    );
  }
  const value = parsed.data as Record<string, unknown>;

  const normalized: NormalizedEvent = {
    event_id: event.id,
    kind: event.kind,
    occurred_at: event.occurred_at,
    ingested_at: event.ingested_at,
    source_id: source.id,
    session_id: event.scope.session_id,
    project_id: event.scope.project_id,
    agent_id: event.scope.agent_id,
    text: eventTextForMatching(event),
  };

  switch (event.kind) {
    case 'terminal.output': {
      const command = String(value.command ?? '');
      normalized.command = {
        text: command,
        normalized: normalizeCommand(command),
        exit_code: (value.exit_code as number | null) ?? null,
      };
      break;
    }
    case 'error.raised': {
      normalized.error = {
        origin: String(value.origin ?? 'runtime'),
        message: String(value.message ?? ''),
        ...(value.context === undefined ? {} : { context: String(value.context) }),
      };
      break;
    }
    case 'file.changed': {
      normalized.file = {
        path: String(value.path ?? ''),
        change: String(value.change ?? 'modified'),
        ...(value.old_path === undefined ? {} : { old_path: String(value.old_path) }),
      };
      break;
    }
    case 'test.results': {
      const failures = (value.failures as Array<{ name?: string }> | undefined) ?? [];
      normalized.tests = {
        ...(value.framework === undefined ? {} : { framework: String(value.framework) }),
        passed: Number(value.passed ?? 0),
        failed: Number(value.failed ?? 0),
        ...(value.skipped === undefined ? {} : { skipped: Number(value.skipped) }),
        failure_names: failures.map((failure) => String(failure.name ?? '')),
      };
      break;
    }
    case 'git.commit': {
      normalized.commit = {
        sha: String(value.sha ?? ''),
        message: String(value.message ?? ''),
        files: ((value.files as string[] | undefined) ?? []).map(String),
      };
      break;
    }
    case 'pull_request': {
      normalized.pull_request = {
        number: Number(value.number ?? 0),
        title: String(value.title ?? ''),
        state: String(value.state ?? 'opened'),
      };
      break;
    }
    case 'document.added': {
      normalized.document = {
        ...(value.path === undefined ? {} : { path: String(value.path) }),
        ...(value.uri === undefined ? {} : { uri: String(value.uri) }),
        ...(value.title === undefined ? {} : { title: String(value.title) }),
        text: String(value.content_digest ?? ''),
      };
      break;
    }
    case 'explicit.remember': {
      normalized.explicit = {
        content: String(value.content ?? ''),
        ...(value.type === undefined ? {} : { type: String(value.type) }),
        ...(value.importance === undefined ? {} : { importance: Number(value.importance) }),
        ...(value.tags === undefined ? {} : { tags: (value.tags as string[]).map(String) }),
      };
      break;
    }
    default:
      break;
  }

  return normalized;
}

/**
 * Normalize a shell command to a stable shape for repetition detection: keep the executable and
 * subcommand tokens, drop flags, paths, assignments, and quoted arguments.
 */
export function normalizeCommand(command: string): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const kept: string[] = [];
  for (const token of tokens) {
    if (kept.length >= 3) break;
    if (token.startsWith('-') || token.includes('=')) break;
    if (token.startsWith('/') || token.startsWith('./') || token.startsWith('~')) break;
    if (token.startsWith('"') || token.startsWith("'")) break;
    if (/[<>|&;]/.test(token)) break;
    kept.push(token);
  }
  return kept.join(' ');
}
